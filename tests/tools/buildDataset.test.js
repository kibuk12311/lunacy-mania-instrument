import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPLITLINES_BREAKS } from "../../tools/lib/jsonl.mjs";
import { planV3, parseArgs } from "../../tools/build-mapper-dataset.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = path.join(ROOT, "tools", "build-mapper-dataset.mjs");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

// 24 s of mono 16-bit PCM at 22050 Hz with a click on every 1/4 of a 150 BPM beat (louder on the beat).
function clickWav(seconds = 24) {
    const sr = 22050;
    const n = sr * seconds;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    for (let k = 0; ; k++) {
        const t = 1 + k * 0.1;
        if (t > seconds - 0.1) break;
        const amp = k % 4 === 0 ? 24000 : 9000;
        const at = Math.round(t * sr);
        for (let i = 0; i < 400; i++) buf.writeInt16LE(Math.round(amp * Math.exp(-i / 60) * Math.sin(i * 0.9)), 44 + (at + i) * 2);
    }
    return buf;
}

function chart({ title, artist = "Artist", seed = 1, timing = ["1000,400,4,1,0,100,1,0"], notes = 190 }) {
    let s = seed;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const lines = ["osu file format v14", "", "[General]", "AudioFilename: audio.wav", "Mode: 3", "", "[Metadata]", `Title:${title}`,
        `Artist:${artist}`, "Creator:m", "Version:Hard", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "", "[TimingPoints]",
        ...timing, "", "[HitObjects]"];
    for (let i = 0; i < notes; i++) {
        const cols = rnd() < 0.2 ? [0, 3] : [Math.floor(rnd() * 4)];
        for (const c of cols) lines.push(`${c * 128 + 64},192,${1000 + i * 100},1,0,0:0:0:0:`);
    }
    return `${lines.join("\r\n")}\r\n`;
}

async function fixtureCorpus(dir) {
    const wav = clickWav();
    const make = async (name, text, line) => {
        const folder = path.join(dir, "songs", name);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "audio.wav"), wav);
        const osu = path.join(folder, `${name}.osu`).replace(/\\/g, "/");
        await writeFile(osu, text);
        return {
            source: "sets", osu, audio: path.join(folder, "audio.wav").replace(/\\/g, "/"), artist: "Artist", title: name, creator: "m",
            version: "Hard", songKey: `artist|${name}`, group: `artist|${name}`, chartKey: name, audioKey: name, beatmapId: null,
            beatmapSetId: null, lnShare: 0, rate: 1, labels: { rawDan: 4.2, etternaMsd: null, trackerMsd: { Overall: 14 }, playcount: 9 },
            pack: null, creatorKey: "n:m", weight: 1, split: "train", duplicates: [], ...line,
        };
    }
    const lines = [
        await make("plain", chart({ title: "plain", artist: "Artist\u{2028}Sep\u{0085}" }), { artist: "Artist\u{2028}Sep\u{0085}" }),
        await make("gimmick", chart({ title: "gimmick", seed: 5, timing: ["1000,400,4,1,0,100,1,0", "8000,0.01,4,1,0,100,1,0", "8001,400,4,1,0,100,1,0"] }), {}),
        await make("held", chart({ title: "held", seed: 9 }), { split: "heldout", duplicates: [{ songKey: "artist|held tv" }] }),
        await make("quar", chart({ title: "quar", seed: 13 }), { split: "quarantine" }),
    ];
    const corpus = path.join(dir, "corpus.jsonl");
    await writeFile(corpus, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return corpus;
}

const pyLines = (text) => text.split(new RegExp(`[${SPLITLINES_BREAKS.join("")}]`, "u")).filter((l) => l.trim());

test("plan v3: quarantine skipped, held-out → test, --sources and --limit, stable ids", () => {
    const lines = [
        { osu: "a.osu", audio: "x.mp3", source: "hf", split: "train", group: "g1" },
        { osu: "b.osu", audio: "x.mp3", source: "etterna", split: "heldout", group: "g2" },
        { osu: "c.osu", audio: "y.mp3", source: "hf", split: "quarantine", group: "g3" },
    ];
    const p = planV3(lines);
    assert.equal(p.charts, 2);
    assert.equal(p.skipped.quarantine, 1);
    assert.equal(p.jobs.length, 1);
    assert.deepEqual(p.jobs[0].maps.map((m) => m.split).sort(), ["test", p.jobs[0].maps.find((m) => m.line.osu === "a.osu").split].sort());
    assert.equal(planV3(lines, { sources: new Set(["hf"]) }).charts, 1);
    assert.equal(planV3(lines, { limit: 1 }).charts, 1);
    assert.equal(planV3(lines).jobs[0].maps[0].id, planV3(lines).jobs[0].maps[0].id);
    assert.match(p.jobs[0].maps[0].id, /^[0-9a-f]{16}$/);
    assert.throws(() => parseArgs(["--format", "v9", "--corpus", "c", "--out", "o"]), /v1\|v3/);
});

test("dataset v3 build on a tiny corpus: files, layout, labels, gimmick BPM dropped, held-out list, Python-safe index", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mapper3-"));
    try {
        const corpus = await fixtureCorpus(dir);
        const out = path.join(dir, "mapper3");
        const r = spawnSync(process.execPath, [TOOL, "--format", "v3", "--corpus", corpus, "--out", out, "--workers", "1", "--fun", "-"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
        assert.equal(r.status, 0, r.stderr || r.stdout);
        const raw = await readFile(path.join(out, "index.jsonl"), "utf8");
        const rows = pyLines(raw).map((l) => JSON.parse(l));
        assert.equal(rows.length, 2, raw);
        assert.equal(raw.trim().split("\n").length, 2);
        const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
        assert.equal(report.rejected["absurd BPM"], 1);
        assert.equal(report.skippedAtPlan.quarantine, 1);
        assert.equal(report.splits.test, 1);
        assert.equal(report.splits.train + report.splits.val, 1);
        assert.equal(report.built, 2);
        const names = JSON.parse(await readFile(path.join(out, "feature_names.json"), "utf8"));
        const beatNames = JSON.parse(await readFile(path.join(out, "beat_feature_names.json"), "utf8"));
        assert.equal(names.length, 23);
        assert.equal(beatNames.length, 15);
        const plain = rows.find((x) => x.songKey === "artist|plain");
        const held = rows.find((x) => x.songKey === "artist|held");
        assert.equal(held.split, "test");
        assert.ok(["train", "val"].includes(plain.split));
        assert.equal(plain.creatorName, "m");
        for (const x of rows) {
            const base = path.join(out, "maps", x.id.slice(0, 2), x.id);
            const size = async (ext) => (await stat(`${base}.${ext}`)).size;
            assert.equal(await size("f32"), x.slots * names.length * 4);
            assert.equal(await size("u8"), x.slots * 4);
            assert.equal(await size("t32"), x.slots * 4);
            assert.equal(await size("b32"), x.beats * beatNames.length * 4);
            assert.equal(await size("bd8"), x.beats);
            assert.equal(await size("bs32"), (x.beats + 1) * 4);
            const bs = new Int32Array((await readFile(`${base}.bs32`)).buffer.slice(0));
            assert.equal(bs[0], 0);
            assert.equal(bs[x.beats], x.slots);
            const u8 = await readFile(`${base}.u8`);
            let notes = 0;
            for (let i = 0; i < x.slots; i++) notes += u8[i * 4];
            assert.equal(notes, 190, "every row of the chart is on a slot");
            const st = JSON.parse(await readFile(`${base}.st.json`, "utf8"));
            assert.equal(st.kind, "parts");
            assert.ok(st.parts.length >= 1);
            assert.equal(x.msdOurs.length, 8);
            assert.ok(Number.isFinite(x.danOurs));
            assert.equal(x.danTracker, 4.2);
            assert.deepEqual(x.msdTracker, [14, null, null, null, null, null, null, null]);
            assert.ok(x.weight > 0);
            assert.equal(x.divShare[4], 1);
            assert.equal(x.residualOffgrid, 0);
        }
        const heldout = JSON.parse(await readFile(path.join(out, "heldout.json"), "utf8"));
        assert.deepEqual(heldout.test, [{ group: "artist|held", songKeys: ["artist|held", "artist|held tv"] }]);
        assert.deepEqual(heldout.quarantine.map((g) => g.group), ["artist|quar"]);

        // v1 (mapper15 format) from the same corpus: the gimmick chart is dropped there too, the index stays Python-safe
        const out1 = path.join(dir, "mapper15");
        const r1 = spawnSync(process.execPath, [TOOL, "--corpus", corpus, "--out", out1, "--workers", "1", "--no-manifest"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
        assert.equal(r1.status, 0, r1.stderr || r1.stdout);
        const rep1 = JSON.parse(await readFile(path.join(out1, "build-report.json"), "utf8"));
        assert.equal(rep1.rejected["absurd BPM"], 1);
        // a quarantined chart (looks like a held-out song) is never trained on (v1.5 took it as train)
        assert.equal(rep1.skippedAtScan.quarantine, 1);
        assert.equal(rep1.index.train + rep1.index.heldout, 2);
        const idx1 = await readFile(path.join(out1, "index.jsonl"), "utf8");
        assert.equal(pyLines(idx1).length, idx1.trim().split("\n").length);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("dataset v3 build with --features v3: stems + structure columns, 45 beat columns, st.json bars with their first beat", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mapper3v3-"));
    try {
        const corpus = await fixtureCorpus(dir);
        const out = path.join(dir, "mapper3");
        const r = spawnSync(process.execPath, [TOOL, "--format", "v3", "--features", "v3", "--corpus", corpus, "--out", out, "--workers", "1", "--fun", "-"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
        assert.equal(r.status, 0, r.stderr || r.stdout);
        const rows = pyLines(await readFile(path.join(out, "index.jsonl"), "utf8")).map((l) => JSON.parse(l));
        assert.equal(rows.length, 2);
        const names = JSON.parse(await readFile(path.join(out, "feature_names.json"), "utf8"));
        const beatNames = JSON.parse(await readFile(path.join(out, "beat_feature_names.json"), "utf8"));
        assert.equal(names.length, 37);
        assert.equal(beatNames.length, 45);
        assert.equal(JSON.parse(await readFile(path.join(out, "format.json"), "utf8")).featureSet, "v3");
        for (const x of rows) {
            const base = path.join(out, "maps", x.id.slice(0, 2), x.id);
            assert.equal(x.features, 37);
            assert.equal(x.beatFeatures, 45);
            const f32 = new Float32Array((await readFile(`${base}.f32`)).buffer.slice(0));
            const b32 = new Float32Array((await readFile(`${base}.b32`)).buffer.slice(0));
            assert.equal(f32.length, x.slots * 37);
            assert.equal(b32.length, x.beats * 45);
            assert.ok(f32.every(Number.isFinite) && b32.every(Number.isFinite));
            // the clicks (about 3 kHz) reach the stem columns: they are not all zero; meter is 4 on every beat
            const stemCols = ["kick", "snare", "hat", "harm", "perc_share"].map((n) => names.indexOf(n));
            assert.ok(stemCols.every((c) => c >= 23));
            assert.ok(Array.from({ length: x.slots }, (_, i) => stemCols.some((c) => f32[i * 37 + c] > 0)).some(Boolean));
            for (let b = 0; b < x.beats; b++) assert.equal(b32[b * 45 + beatNames.indexOf("meter")], 4);
            const st = JSON.parse(await readFile(`${base}.st.json`, "utf8"));
            assert.equal(st.kind, "structure");
            assert.equal(st.meter, 4);
            assert.ok(st.bars.length >= 4);
            assert.equal(st.bars[0].beat, 0);
            st.bars.forEach((bar, k) => {
                if (k) assert.equal(bar.beat - st.bars[k - 1].beat, 4, "one 4/4 section: a bar every 4 beats");
            });
            assert.ok(Array.isArray(st.echoOf) && st.echoOf.length === st.bars.length);
            assert.ok(st.echoOf.every((e, k) => e < k));
            assert.equal(st.phrases.reduce((n, p) => n + p.bars, 0), st.bars.length);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
