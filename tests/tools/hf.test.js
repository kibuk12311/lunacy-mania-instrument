import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    parseLooseJson, rice4k, prepareOsu, splitKey, audioExt, listShards, processShard, run, readState, refuseSongs, parseArgs,
} from "../../tools/fetch-hf-osu.mjs";

// ---- fixtures: a WebDataset tar shaped like project-riz/osu-beatmaps (Python tarfile: a pax header per entry) ----
function header(name, size, flag = "0") {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, "latin1");
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    h.write("00000000000\0", 136, "latin1");
    h.write(flag, 156, "latin1");
    h.write("ustar\0", 257, "latin1");
    h.write("00", 263, "latin1");
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return h;
}
const padTo = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function entry(name, data) {
    const body = Buffer.from(data);
    const pax = Buffer.from("27 mtime=1768316444.955412\n");
    return Buffer.concat([header("././@PaxHeader", pax.length, "x"), padTo(pax), header(name, body.length), padTo(body)]);
}

function chart({ mode = 3, keys = 4, notes = 120, ln = 0, audio = "song.mp3", ids = true }) {
    const objs = [];
    for (let i = 0; i < notes; i++) {
        const x = [64, 192, 320, 448][i % 4];
        objs.push(i < ln ? `${x},192,${1000 + i * 100},128,0,${1050 + i * 100}:0:0:0:0:` : `${x},192,${1000 + i * 100},1,0,0:0:0:0:`);
    }
    return [
        "osu file format v14", "", "[General]", `AudioFilename: ${audio}`, `Mode: ${mode}`, "",
        "[Metadata]", "Title:t", "Version:v", ...(ids ? ["BeatmapID:111", "BeatmapSetID:222"] : []), "",
        "[Difficulty]", `CircleSize:${keys}`, "", "[TimingPoints]", "1000,500,4,1,0,100,1,0", "", "[HitObjects]", ...objs, "",
    ].join("\r\n");
}
const bm = (over, chartOpts = {}) => ({ beatmapset_id: 222, beatmap_id: 111, mode: 3, diff_size: 4, diff_aim: "NaN!", content: chart(chartOpts), ...over });
const json = (beatmaps) => JSON.stringify({ audio_hash: "h", audio_length: 100, beatmaps }).replace(/"NaN!"/g, "NaN");

function shardTar() {
    return Buffer.concat([
        // 1: one 4K rice diff kept, one LN-heavy 4K and one 7K dropped
        entry("000010.json", json([
            bm({ beatmap_id: 1001 }),
            bm({ beatmap_id: 1002 }, { ln: 60 }),
            bm({ beatmap_id: 1003, diff_size: 7 }, { keys: 7 }),
        ])),
        entry("000010.opus", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(3000, 1)])),
        // 2: osu!standard only, audio must not be written
        entry("000011.json", json([bm({ beatmapset_id: 333, beatmap_id: 2001, mode: 0 }, { mode: 0 })])),
        entry("000011.opus", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(5000, 2)])),
        // 3: audio before json, two kept diffs of another set; the chart lacks ids
        entry("000012.opus", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(4000, 3)])),
        entry("000012.json", json([
            bm({ beatmapset_id: 444, beatmap_id: 3001 }, { ids: false }),
            bm({ beatmapset_id: 444, beatmap_id: 3002 }, { notes: 300 }),
        ])),
        // 4: too short
        entry("000013.json", json([bm({ beatmapset_id: 555, beatmap_id: 4001 }, { notes: 50 })])),
        entry("000013.opus", Buffer.from("OggS....")),
        Buffer.alloc(1024),
    ]);
}

// Serves the listing and the shard; `cutOnce` drops the first download after that many bytes.
function fakeHub(tar, { cutOnce = 0, ignoreRange = false, status429Once = false } = {}) {
    const calls = [];
    let cut = cutOnce;
    let limited = status429Once;
    const fetchImpl = async (url, opts = {}) => {
        const range = opts.headers?.range ?? null;
        calls.push({ url, range });
        const u = String(url);
        if (u.endsWith("/api/datasets/project-riz/osu-beatmaps/tree/main")) {
            return Response.json([{ type: "directory", path: "compressed" }, { type: "directory", path: "original" }, { type: "file", path: "README.md", size: 1 }]);
        }
        if (u.endsWith("/tree/main/compressed")) {
            return Response.json([{ type: "file", path: "compressed/data-000000.tar", size: tar.length, lfs: { size: tar.length } }],
                { headers: { link: '<https://huggingface.co/api/datasets/project-riz/osu-beatmaps/tree/main/compressed?cursor=2>; rel="next"' } });
        }
        if (u.endsWith("/tree/main/compressed?cursor=2")) return Response.json([{ type: "file", path: "compressed/data-000001.tar", size: 10 * tar.length }]);
        if (u.endsWith("/tree/main/original")) return Response.json([{ type: "file", path: "original/data-000000.tar", size: 30 * tar.length }]);
        if (u.includes("/resolve/main/compressed/data-000000.tar")) {
            if (limited) { limited = false; return new Response("slow down", { status: 429, headers: { "retry-after": "0" } }); }
            const from = range && !ignoreRange ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
            const body = tar.subarray(from);
            const stopAt = cut;
            cut = 0;
            let i = 0;
            const stream = new ReadableStream({ // one chunk per pull, so an error comes after the data before it
                pull(c) {
                    if (stopAt && i >= stopAt) { c.error(new Error("socket hang up")); return; }
                    if (i >= body.length) { c.close(); return; }
                    c.enqueue(new Uint8Array(body.subarray(i, i + 777)));
                    i += 777;
                },
            });
            const headers = range && !ignoreRange
                ? { "content-range": `bytes ${from}-${tar.length - 1}/${tar.length}`, "content-length": String(body.length) }
                : { "content-length": String(tar.length) };
            return new Response(stream, { status: range && !ignoreRange ? 206 : 200, headers });
        }
        return new Response("not found", { status: 404 });
    };
    return { fetchImpl, calls };
}

const quiet = () => {};
async function tree(dir) {
    const out = {};
    for (const d of await readdir(dir, { withFileTypes: true })) {
        if (d.isDirectory()) out[d.name] = (await readdir(path.join(dir, d.name))).sort();
    }
    return out;
}

test("parseLooseJson turns NaN/Infinity into null but leaves strings alone", () => {
    const v = parseLooseJson('{"a": NaN, "b": [Infinity, -Infinity], "s": "NaN \\" Infinity", "n": 1.5}');
    assert.deepEqual(v, { a: null, b: [null, null], s: 'NaN " Infinity', n: 1.5 });
});

test("rice4k: mode, key count, object count and LN share", () => {
    assert.equal(rice4k(bm({})).ok, true);
    assert.equal(rice4k(bm({}, { ln: 18 })).ok, true); // 15%
    assert.equal(rice4k(bm({}, { ln: 19 })).reason, "ln");
    assert.equal(rice4k(bm({}, { keys: 7 })).reason, "keys");
    assert.equal(rice4k(bm({}, { mode: 0 })).reason, "mode");
    assert.equal(rice4k(bm({}, { notes: 99 })).reason, "short");
    assert.equal(rice4k({ mode: 3, content: null }).ok, false);
});

test("prepareOsu points AudioFilename at the saved audio and fills missing ids", () => {
    const out = prepareOsu(chart({ ids: false }), { audioName: "000012.opus", beatmapId: 3001, beatmapsetId: 444 });
    assert.match(out, /^AudioFilename: 000012\.opus\r$/m);
    assert.match(out, /^BeatmapID:3001\r$/m);
    assert.match(out, /^BeatmapSetID:444\r$/m);
    const kept = prepareOsu(chart({}), { audioName: "a.opus", beatmapId: 9, beatmapsetId: 8 });
    assert.match(kept, /^BeatmapID:111\r$/m); // the file's own id wins
    assert.equal(kept.split("\r\n").length, chart({}).split("\r\n").length);
    const noAudio = prepareOsu("osu file format v6\n\n[General]\nMode: 3\n", { audioName: "x.mp3" });
    assert.match(noAudio, /\[General\]\nAudioFilename: x\.mp3\nMode: 3/);
});

test("splitKey and audioExt", () => {
    assert.deepEqual(splitKey("a/000001.json"), { key: "a/000001", ext: "json" });
    assert.deepEqual(splitKey("000001.tar.opus"), { key: "000001", ext: "tar.opus" });
    assert.equal(splitKey(".hidden"), null);
    assert.equal(audioExt(Buffer.from("OggS"), "mp3"), "ogg");
    assert.equal(audioExt(Buffer.from("RIFF"), "mp3"), "wav");
    assert.equal(audioExt(Buffer.from("ID3\u0003"), "mp3"), "mp3");
    assert.equal(audioExt(Buffer.from("OggS"), "opus"), "opus");
});

test("listShards reads both variants (with pagination) and prefers compressed", async () => {
    const { fetchImpl } = fakeHub(Buffer.alloc(1024));
    const r = await listShards({ fetchImpl });
    assert.equal(r.variant, "compressed");
    assert.deepEqual(r.shards.map((s) => s.path), ["compressed/data-000000.tar", "compressed/data-000001.tar"]);
    assert.equal(r.variants.original.count, 1);
    await assert.rejects(listShards({ fetchImpl, variant: "nope" }), /not found/);
});

test("processShard keeps only 4K rice samples, in Songs-like folders", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "hf-"));
    try {
        const tar = shardTar();
        const { fetchImpl } = fakeHub(tar);
        const c = await processShard({ shard: { path: "compressed/data-000000.tar", size: tar.length }, outRoot: out, fetchImpl, log: quiet });
        assert.equal(c.samples, 4);
        assert.equal(c.kept, 2);
        assert.equal(c.diffs, 3);
        assert.equal(c.rejectedLn, 1);
        assert.equal(c.rejectedShort, 1);
        assert.deepEqual(await tree(out), { 222: ["000010.opus", "1001.osu"], 444: ["000012.opus", "3001.osu", "3002.osu"] });
        const osu = await readFile(path.join(out, "444", "3001.osu"), "utf8");
        assert.match(osu, /^AudioFilename: 000012\.opus\r$/m);
        assert.match(osu, /^BeatmapID:3001\r$/m);
        assert.equal((await readFile(path.join(out, "222", "000010.opus"))).length, 3004);
    } finally {
        await rm(out, { recursive: true, force: true });
    }
});

test("a dropped connection resumes with Range from the sample in progress; nothing counted twice", async () => {
    for (const ignoreRange of [false, true]) {
        const out = await mkdtemp(path.join(tmpdir(), "hf-"));
        try {
            const tar = shardTar();
            const { fetchImpl, calls } = fakeHub(tar, { cutOnce: Math.floor(tar.length * 0.6), ignoreRange, status429Once: true });
            const c = await processShard({ shard: { path: "compressed/data-000000.tar", size: tar.length }, outRoot: out, fetchImpl, log: quiet, retryDelayMs: 1 });
            assert.equal(c.samples, 4);
            assert.equal(c.diffs, 3);
            const downloads = calls.filter((x) => x.url.includes("/resolve/"));
            assert.equal(downloads.length, 3); // 429, cut, resumed
            assert.match(downloads[2].range, /^bytes=\d+-$/);
            assert.ok(Number(/\d+/.exec(downloads[2].range)[0]) > 0);
            assert.deepEqual(Object.keys(await tree(out)).sort(), ["222", "444"]);
        } finally {
            await rm(out, { recursive: true, force: true });
        }
    }
});

test("run writes per-shard state, skips done shards and honours --limit", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "hf-"));
    try {
        const tar = shardTar();
        const hub = fakeHub(tar);
        const r1 = await run({ outRoot: out, limit: 1, fetchImpl: hub.fetchImpl, log: quiet });
        assert.equal(r1.results.length, 1);
        assert.equal(r1.results[0].ok, true);
        assert.equal(r1.results[0].diffs, 3);
        const state = await readState(path.join(out, "state.jsonl"));
        assert.deepEqual([...state.keys()], ["compressed/data-000000.tar"]);
        // second run: shard 0 is skipped, shard 1 is fetched (and fails here with 404, recorded as not ok)
        const before = hub.calls.filter((x) => x.url.includes("/resolve/")).length;
        const r2 = await run({ outRoot: out, limit: 5, fetchImpl: hub.fetchImpl, log: quiet });
        const fetched = hub.calls.filter((x) => x.url.includes("/resolve/")).slice(before).map((x) => x.url);
        assert.ok(fetched.every((u) => u.includes("data-000001")));
        assert.equal(r2.results.length, 1);
        assert.equal(r2.results[0].ok, false);
        assert.match(r2.results[0].error, /404/);
    } finally {
        await rm(out, { recursive: true, force: true });
    }
});

test("refuses a Songs folder; argument parsing", () => {
    assert.throws(() => refuseSongs("A:/Games/osu!/Songs"), /Songs/);
    assert.throws(() => refuseSongs("A:/Games/osu!/songs/x"), /Songs/);
    refuseSongs("A:/SneezeyTrain/hf");
    assert.deepEqual(parseArgs(["X:/out", "--limit", "1", "--variant", "original", "--shard", "data-000073"]),
        { outRoot: "X:/out", variant: "original", limit: 1, lanes: 2, only: ["data-000073"] });
    assert.equal(parseArgs([]).outRoot, "A:/SneezeyTrain/hf");
    assert.throws(() => parseArgs(["--limit", "0"]), /limit/);
    assert.throws(() => parseArgs(["--bogus"]), /unknown/);
});
