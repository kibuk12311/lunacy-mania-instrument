import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BUILTIN_ZIPS, MIRROR_BASE, HF_BASE, parseZipName, zipEntry, parseListText, isAllowedHost, zipNameOfUrl, guardedFetch,
    downloadWithFallback, loadSeenFrom, parseArgs, selectZips, run, encodeName,
} from "../../tools/fetch-zip-packs.mjs";
import { convertSimfile } from "../../tools/lib/sm2osu.mjs";
import { makeZip } from "./fixtures/makeZip.js";

async function tempDir(t) {
    const dir = await mkdtemp(path.join(tmpdir(), "zippacks-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
const files = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).replace(/\\/g, "/")).sort();
const noSleep = async () => {};
const quiet = () => {};
const tinySm = (title, music, rows) => `#TITLE:${title};#ARTIST:X;#MUSIC:${music};#OFFSET:0;#BPMS:0=100;\n#NOTES:dance-single::Hard:3::\n${rows.join("\n")}\n;`;
const oggOf = (n) => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(3000 + n, n)]);
const mirrorUrl = (name) => `${MIRROR_BASE}${encodeName(name)}`;
const hfUrl = (name) => `${HF_BASE}${encodeName(name)}`;

// A fake web: url → Buffer (served with Range), or a function (url, init) → Response. Every call is logged.
function fakeWeb(routes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, range: init.headers?.range ?? null, redirect: init.redirect });
        const r = routes[url];
        if (r === undefined) return new Response("nope", { status: 404 });
        if (typeof r === "function") return r(url, init);
        const m = /^bytes=(\d+)-$/.exec(init.headers?.range ?? "");
        if (m) {
            const from = Number(m[1]);
            if (from >= r.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${r.length}` } });
            const body = r.subarray(from);
            return new Response(body, { status: 206, headers: { "content-length": String(body.length), "content-range": `bytes ${from}-${r.length - 1}/${r.length}` } });
        }
        return new Response(r, { status: 200, headers: { "content-length": String(r.length) } });
    };
    return { fetchImpl, calls };
}

// ---- names, lists, hosts ------------------------------------------------------------------------------------

test("zip names: the 4K bins below MSD 38 only, with stable ids", () => {
    assert.deepEqual(parseZipName("Malody 4k Converts (14-15 3).zip"), { name: "Malody 4k Converts (14-15 3).zip", id: "mal-14-15-3", lo: 14, hi: 15, part: 3 });
    assert.equal(parseZipName("Malody 4k Converts (21-22).zip").id, "mal-21-22");
    assert.equal(parseZipName("Malody 4k Converts (38-104).zip"), null);
    assert.equal(parseZipName("Malody 7k Converts.zip"), null);
    assert.equal(parseZipName("Malody 4k Converts (0-6 1).zip.exe"), null);
    assert.equal(parseZipName("../Malody 4k Converts (0-6 1).zip"), null);
    assert.equal(BUILTIN_ZIPS.length, 40);
    assert.ok(BUILTIN_ZIPS.every(([n]) => parseZipName(n)));
    assert.ok(!BUILTIN_ZIPS.some(([n]) => n.includes("38-104")));
    assert.equal(new Set(BUILTIN_ZIPS.map(([n]) => parseZipName(n).id)).size, 40);
    const total = BUILTIN_ZIPS.reduce((s, [, b]) => s + b, 0);
    assert.ok(total > 37e9 && total < 38e9, String(total));
    // the encoding the mirror's own listing uses
    assert.equal(zipEntry("Malody 4k Converts (0-6 1).zip").urls[0], "https://mirror.reenigne.net/simfiles/Malody%204k%20Converts%20%280-6%201%29.zip");
    assert.equal(zipEntry("Malody 4k Converts (0-6 1).zip").urls[1], "https://huggingface.co/datasets/ayousanz/malody-data/resolve/main/Malody%204k%20Converts%20%280-6%201%29.zip");
});

test("hosts: https on the mirror and huggingface.co; the HF CDN only as a redirect", () => {
    assert.ok(isAllowedHost("https://mirror.reenigne.net/simfiles/x.zip"));
    assert.ok(isAllowedHost("https://huggingface.co/datasets/ayousanz/malody-data/resolve/main/x.zip"));
    assert.ok(!isAllowedHost("http://mirror.reenigne.net/simfiles/x.zip"));
    assert.ok(!isAllowedHost("https://mirror.reenigne.net.evil.com/x.zip"));
    assert.ok(!isAllowedHost("https://user:pw@mirror.reenigne.net/x.zip"));
    assert.ok(!isAllowedHost("https://cas-bridge.xethub.hf.co/x"));
    assert.ok(isAllowedHost("https://cas-bridge.xethub.hf.co/x", { cdn: true }));
    assert.ok(!isAllowedHost("https://evil.com/x", { cdn: true }));
    assert.equal(zipNameOfUrl("https://mirror.reenigne.net/simfiles/Malody%204k%20Converts%20%286-7%201%29.zip"), "Malody 4k Converts (6-7 1).zip");
    assert.equal(zipNameOfUrl("https://mirror.reenigne.net/other/Malody%204k%20Converts%20%286-7%201%29.zip"), null);
    assert.equal(zipNameOfUrl("https://mirror.reenigne.net/simfiles/sub/a.zip"), null);
    assert.equal(zipNameOfUrl("https://huggingface.co/datasets/someone/else/resolve/main/a.zip"), null);
});

test("lists: TSV, plain names/URLs and a saved directory listing; foreign hosts and the 38+ bin are dropped", () => {
    const tsv = [
        "3\tMalody 4k Converts (0-6 1)\thttps://mirror.reenigne.net/simfiles/Malody%204k%20Converts%20%280-6%201%29.zip\t739273517",
        "3\tMalody 4k Converts (6-7 1)\thttps://huggingface.co/datasets/ayousanz/malody-data/resolve/main/Malody%204k%20Converts%20%286-7%201%29.zip\t631136132",
        "4\tJS Megapack\thttps://downloads.etternaonline.com/ranked/JS.zip\t123456789",
        "3\tevil\thttps://evil.example/simfiles/Malody%204k%20Converts%20%287-8%201%29.zip\t1000",
        "3\tjoke\thttps://mirror.reenigne.net/simfiles/Malody%204k%20Converts%20%2838-104%29.zip\t324868527",
        "# comment",
        "Malody 4k Converts (21-22)",
        "Malody 4k Converts (0-6 1).zip",
    ].join("\n");
    const { zips, dropped } = parseListText(tsv);
    assert.deepEqual(zips.map((z) => z.id), ["mal-0-6-1", "mal-6-7-1", "mal-21-22"]);
    assert.equal(zips[0].bytes, 739273517);
    assert.equal(zips[2].bytes, null);
    assert.match(zips[1].urls[0], /^https:\/\/huggingface\.co\//); // the list's own host first, the other as fallback
    assert.match(zips[1].urls[1], /^https:\/\/mirror\.reenigne\.net\//);
    assert.equal(dropped.length, 3);

    const listing = [
        '<a href="Malody%2010k%20Converts.zip">Malody 10k Converts.zip</a>                            07-Aug-2025 20:47            11768003',
        '<a href="Malody%204k%20Converts%20%280-6%201%29.zip">Malody 4k Converts (0-6 1).zip</a>                     07-Aug-2025 20:25           739273517',
        '<a href="Malody%204k%20Converts%20%2838-104%29.zip">Malody 4k Converts (38-104).zip</a>                    07-Aug-2025 20:45           324868527',
        '<a href="Malody%204k%20Converts%20%2828-38%29.zip">Malody 4k Converts (28-38).zip</a>                     07-Aug-2025 20:45           789638986',
        '<a href="https://evil.example/Malody%204k%20Converts%20%2822-23%29.zip">x</a> 1 2',
    ].join("\n");
    const fromHtml = parseListText(listing).zips;
    assert.deepEqual(fromHtml.map((z) => [z.id, z.bytes]), [["mal-0-6-1", 739273517], ["mal-28-38", 789638986]]);
});

test("args and selection", () => {
    const o = parseArgs(["A:/x/malody", "--list", "file.tsv", "--limit", "1", "--lanes", "9", "--only", "6-7 1,21-22"]);
    assert.equal(o.outRoot, "A:/x/malody");
    assert.equal(o.list, "file.tsv");
    assert.equal(o.limit, 1);
    assert.equal(o.lanes, 3);
    assert.deepEqual(o.only, ["6-7 1", "21-22"]);
    assert.equal(parseArgs([]).list, "builtin");
    assert.equal(parseArgs([]).lanes, 2);
    assert.throws(() => parseArgs(["--bogus"]));
    assert.throws(() => parseArgs(["--list"]));
    const all = BUILTIN_ZIPS.map(([n, b]) => zipEntry(n, { bytes: b }));
    assert.deepEqual(selectZips(all, { only: ["6-7 1", "21-22"] }).map((z) => z.id), ["mal-6-7-1", "mal-21-22"]);
    assert.deepEqual(selectZips(all, { only: ["6-7"] }).map((z) => z.id), ["mal-6-7-1", "mal-6-7-2"]);
    assert.equal(selectZips(all, { smallestFirst: true })[0].id, "mal-6-7-1");
});

// ---- downloads ----------------------------------------------------------------------------------------------

test("guarded fetch: each redirect hop is checked; the HF CDN is fine only after huggingface.co", async () => {
    const cdn = "https://cas-bridge.xethub.hf.co/xet/abc?sig=1";
    const web = fakeWeb({
        "https://huggingface.co/a.zip": () => new Response(null, { status: 302, headers: { location: cdn } }),
        [cdn]: Buffer.from("PK-data"),
        "https://mirror.reenigne.net/simfiles/a.zip": () => new Response(null, { status: 302, headers: { location: cdn } }),
        "https://mirror.reenigne.net/simfiles/b.zip": () => new Response(null, { status: 301, headers: { location: "https://evil.example/b.zip" } }),
        "https://mirror.reenigne.net/simfiles/c.zip": () => new Response(null, { status: 302, headers: { location: "/simfiles/d.zip" } }),
        "https://mirror.reenigne.net/simfiles/d.zip": Buffer.from("D"),
    });
    const f = guardedFetch(web.fetchImpl);
    const res = await f("https://huggingface.co/a.zip", { headers: { range: "bytes=2-" } });
    assert.equal(res.status, 206);
    assert.equal(res.url, "");
    assert.equal(Buffer.from(await new Response(res.body).arrayBuffer()).toString(), "-data");
    assert.equal(web.calls[1].range, "bytes=2-"); // the Range goes along every hop
    assert.ok(web.calls.every((c) => c.redirect === "manual"));
    await assert.rejects(f("https://mirror.reenigne.net/simfiles/a.zip"), (e) => e.final && /refusing/.test(e.message));
    await assert.rejects(f("https://mirror.reenigne.net/simfiles/b.zip"), (e) => e.final && /evil\.example/.test(e.message));
    await assert.rejects(f("https://evil.example/x.zip"), (e) => e.final);
    assert.equal((await f("https://mirror.reenigne.net/simfiles/c.zip")).status, 200);
});

test("download: resumes the mirror's .part with Range, falls back to Hugging Face, never mixes mirrors", async (t) => {
    const dir = await tempDir(t);
    const name = "Malody 4k Converts (6-7 1).zip";
    const data = makeZip([{ name: "a.txt", data: "x".repeat(5000), method: 0 }]);
    // resume: half of it is already there from the mirror
    const zip = zipEntry(name, { bytes: data.length });
    const dest = path.join(dir, "mal-6-7-1.zip");
    await writeFile(`${dest}.part`, data.subarray(0, 2000));
    await writeFile(path.join(dir, "mal-6-7-1.src"), zip.urls[0]);
    const web = fakeWeb({ [mirrorUrl(name)]: data });
    const got = await downloadWithFallback(zip, dest, { fetchImpl: web.fetchImpl, sleepImpl: noSleep, logImpl: quiet });
    assert.equal(got.resumedFrom, 2000);
    assert.equal(got.url, zip.urls[0]);
    assert.deepEqual(await readFile(dest), data);
    assert.equal(web.calls[0].range, "bytes=2000-");

    // the mirror is gone: Hugging Face (through its CDN) instead, and the mirror's .part is not resumed there
    const dest2 = path.join(dir, "mal-6-7-1b.zip");
    await writeFile(`${dest2}.part`, Buffer.from("garbage from the mirror"));
    await writeFile(path.join(dir, "mal-6-7-1b.src"), zip.urls[0]);
    const cdn = "https://cdn-lfs.hf.co/repos/x?sig=1";
    const web2 = fakeWeb({
        [mirrorUrl(name)]: () => new Response("gone", { status: 404 }),
        [hfUrl(name)]: () => new Response(null, { status: 302, headers: { location: cdn } }),
        [cdn]: data,
    });
    const logs = [];
    const got2 = await downloadWithFallback(zip, dest2, { fetchImpl: web2.fetchImpl, sleepImpl: noSleep, logImpl: (...a) => logs.push(a.join(" ")) });
    assert.equal(got2.url, zip.urls[1]);
    assert.equal(got2.resumedFrom, 0);
    assert.deepEqual(await readFile(dest2), data);
    assert.ok(logs.some((l) => /mirror\.reenigne\.net failed .*trying huggingface\.co/.test(l)));
    assert.equal(web2.calls.find((c) => c.url === hfUrl(name)).range, null);

    // 429 is waited out (Retry-After), then the download goes on
    const dest3 = path.join(dir, "mal-6-7-1c.zip");
    let asked = 0;
    const waits = [];
    const web3 = fakeWeb({
        [mirrorUrl(name)]: () => (asked++ === 0
            ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
            : new Response(data, { status: 200, headers: { "content-length": String(data.length) } })),
    });
    await downloadWithFallback(zip, dest3, { fetchImpl: web3.fetchImpl, sleepImpl: async (ms) => { waits.push(ms); }, logImpl: quiet });
    assert.equal(waits[0], 7000);
    assert.deepEqual(await readFile(dest3), data);

    // a file far bigger than the list says is refused, and so is a body that is no zip
    const dest4 = path.join(dir, "mal-x.zip");
    const tiny = zipEntry(name, { bytes: 10 });
    const web4 = fakeWeb({ [mirrorUrl(name)]: Buffer.alloc(3_000_000, 1), [hfUrl(name)]: Buffer.from("<html>error</html>") });
    await assert.rejects(downloadWithFallback(tiny, dest4, { fetchImpl: web4.fetchImpl, sleepImpl: noSleep, logImpl: quiet }), /not a zip/);
    await assert.rejects(stat(dest4));
});

test("download: the error is final only when every source failed for good", async (t) => {
    const dir = await tempDir(t);
    const name = "Malody 4k Converts (28-38).zip"; // no Hugging Face copy of this one
    const zip = zipEntry(name, { bytes: 1000 });
    // the mirror times out / 5xx past its retries, then HF says 404: transient, the mirror's error is kept
    const web = fakeWeb({ [mirrorUrl(name)]: () => new Response("busy", { status: 503 }) });
    await assert.rejects(downloadWithFallback(zip, path.join(dir, "a.zip"), { fetchImpl: web.fetchImpl, sleepImpl: noSleep, logImpl: quiet }),
        (e) => !e.final && /503/.test(e.message));
    const web2 = fakeWeb({ [mirrorUrl(name)]: () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(downloadWithFallback(zip, path.join(dir, "b.zip"), { fetchImpl: web2.fetchImpl, sleepImpl: noSleep, logImpl: quiet }),
        (e) => !e.final);
    // both gone for good (404 and 404): final, so later runs skip it
    const web3 = fakeWeb({});
    await assert.rejects(downloadWithFallback(zip, path.join(dir, "c.zip"), { fetchImpl: web3.fetchImpl, sleepImpl: noSleep, logImpl: quiet }),
        (e) => e.final === true && /404/.test(e.message));
});

// ---- the run ------------------------------------------------------------------------------------------------

const rowsA = ["1000", "0100", "0010", "0001", "1000", "0100"];
const rowsB = ["0001", "0010", "0100", "1000", "0001", "0010"];
const rowsC = ["1100", "0011", "1100", "0011", "1001", "0110"];

test("run: zips → song folders with .osu, manifests, state; Etterna and earlier Malody charts are skipped", async (t) => {
    const root = await tempDir(t);
    const outRoot = path.join(root, "malody");
    // an Etterna manifest that already has song B's notes
    const etternaPacks = path.join(root, "etterna", "packs");
    await mkdir(etternaPacks, { recursive: true });
    const hashB = convertSimfile(tinySm("Bee", "b.ogg", rowsB), { ext: ".sm", audioFilename: "b.ogg" }).charts[0].hash;
    await writeFile(path.join(etternaPacks, "3281.json"), JSON.stringify({ id: 3281, songs: [{ folder: "3281 Bee", charts: [{ hash: hashB, version: "Hard 3" }] }] }));

    const zip1 = makeZip([
        { name: "Malody 4k Converts (6-7 1)/Aye/aye.sm", data: tinySm("Aye", "aye.ogg", rowsA) },
        { name: "Malody 4k Converts (6-7 1)/Aye/aye.ogg", data: oggOf(1) },
        { name: "Malody 4k Converts (6-7 1)/Aye/aye.mc", data: '{"meta":{}}' },
        { name: "Malody 4k Converts (6-7 1)/Aye/bg.jpg", data: Buffer.alloc(100, 9) },
        { name: "Malody 4k Converts (6-7 1)/Aye/run.exe", data: "MZ" },
        { name: "Malody 4k Converts (6-7 1)/Bee/b.sm", data: tinySm("Bee", "b.ogg", rowsB) },
        { name: "Malody 4k Converts (6-7 1)/Bee/b.ogg", data: oggOf(2) },
        { name: "../escape/evil.sm", data: tinySm("Evil", "evil.ogg", rowsC) },
        { name: "../escape/evil.ogg", data: oggOf(3) },
    ]);
    // the second zip repeats Aye (another Malody zip) and brings one new song
    const zip2 = makeZip([
        { name: "Malody 4k Converts (21-22)/Aye again/aye.sm", data: tinySm("Aye", "aye.ogg", rowsA) },
        { name: "Malody 4k Converts (21-22)/Aye again/aye.ogg", data: oggOf(1) },
        { name: "Malody 4k Converts (21-22)/Cee/c.sm", data: tinySm("Cee", "c.ogg", rowsC) },
        { name: "Malody 4k Converts (21-22)/Cee/c.ogg", data: oggOf(4) },
    ]);
    const n1 = "Malody 4k Converts (6-7 1).zip";
    const n2 = "Malody 4k Converts (21-22).zip";
    const list = path.join(root, "list.tsv");
    await writeFile(list, `3\t${n1}\t${mirrorUrl(n1)}\t${zip1.length}\n3\t${n2}\t${mirrorUrl(n2)}\t${zip2.length}\n`);
    const web = fakeWeb({ [mirrorUrl(n1)]: zip1, [mirrorUrl(n2)]: zip2 });
    const deps = { fetchImpl: web.fetchImpl, sleepImpl: noSleep, logImpl: quiet, freeBytes: async () => 1e13, pauseMs: 0 };
    const opts = { ...parseArgs([outRoot, "--list", list, "--lanes", "1", "--etterna-packs", etternaPacks]) };

    const totals = await run(opts, deps);
    assert.deepEqual({ zips: totals.zips, failed: totals.failed, charts: totals.charts }, { zips: 2, failed: 0, charts: 2 });
    const out = await files(outRoot);
    const songs = out.filter((f) => f.startsWith("songs/"));
    assert.deepEqual(songs.filter((f) => !f.endsWith(".osu")), ["songs/mal-21-22 Cee/c.ogg", "songs/mal-21-22 Cee/c.sm", "songs/mal-6-7-1 Aye/aye.ogg", "songs/mal-6-7-1 Aye/aye.sm"]);
    assert.equal(songs.filter((f) => f.endsWith(".osu")).length, 2);
    assert.ok(!out.some((f) => /\.(mc|exe|jpg)$/.test(f) || /evil|escape/.test(f)));
    assert.ok(!(await files(root)).some((f) => /escape/.test(f)));
    assert.ok(!out.some((f) => f.startsWith("_zips/") && /\.(zip|part|src)$/.test(f)), "downloaded zips are deleted");
    const osuFile = songs.find((f) => f.startsWith("songs/mal-6-7-1 Aye/") && f.endsWith(".osu"));
    const osu = await readFile(path.join(outRoot, osuFile), "utf8");
    assert.match(osu, /^AudioFilename: aye\.ogg\r?$/m);
    assert.match(osu, /^Mode: ?3\r?$/m);
    assert.match(osu, /^CircleSize: ?4\r?$/m);

    const m1 = JSON.parse(await readFile(path.join(outRoot, "packs", "mal-6-7-1.json"), "utf8"));
    assert.equal(m1.source, "malody-4k-converts");
    assert.deepEqual(m1.msdRange, { lo: 6, hi: 7 });
    assert.equal(m1.part, 1);
    assert.equal(m1.totals.reasons.duplicate, 1);
    assert.ok(m1.songs[0].charts[0].hash);
    assert.ok(m1.skippedSongs.some((s) => /unsafe/.test(s.reason)));
    const m2 = JSON.parse(await readFile(path.join(outRoot, "packs", "mal-21-22.json"), "utf8"));
    assert.equal(m2.totals.reasons.duplicate, 1);
    assert.equal(m2.totals.chartsConverted, 1);

    const state = (await readFile(path.join(outRoot, "state.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(state.map((s) => [s.id, s.ok, s.from]), [["mal-6-7-1", true, "mirror.reenigne.net"], ["mal-21-22", true, "mirror.reenigne.net"]]);

    // again: nothing is fetched
    const before = web.calls.length;
    const again = await run(opts, deps);
    assert.equal(again.zips, 0);
    assert.equal(web.calls.length, before);
    await assert.rejects(stat(path.join(outRoot, "fetch-zip.lock")));

    // a later run with its own seen-set still knows Aye from the manifests on disk
    const seen = await loadSeenFrom([etternaPacks, path.join(outRoot, "packs")]);
    assert.equal(seen.get(hashB).pack, 3281);
    assert.equal(seen.size, 3);
});

test("run: a failed zip is written to the state and retried later; --limit and --show; never the Songs folder", async (t) => {
    const root = await tempDir(t);
    const outRoot = path.join(root, "malody");
    const name = "Malody 4k Converts (6-7 1).zip";
    const good = makeZip([
        { name: "S/s.sm", data: tinySm("Ess", "s.ogg", rowsA) },
        { name: "S/s.ogg", data: oggOf(1) },
    ]);
    let up = false;
    const web = fakeWeb({
        [mirrorUrl(name)]: () => (up ? new Response(good, { status: 200, headers: { "content-length": String(good.length) } }) : new Response("x", { status: 500 })),
        [hfUrl(name)]: () => new Response("x", { status: 403 }),
    });
    const deps = { fetchImpl: web.fetchImpl, sleepImpl: noSleep, logImpl: quiet, freeBytes: async () => 1e13, pauseMs: 0 };
    const opts = parseArgs([outRoot, "--only", "6-7 1", "--etterna-packs", "-"]);
    const first = await run(opts, deps);
    assert.equal(first.failed, 1);
    const s1 = JSON.parse((await readFile(path.join(outRoot, "state.jsonl"), "utf8")).trim());
    assert.equal(s1.ok, false);
    // the mirror's 500 was only a bad moment: HF's 403 after it does not make the failure final, and the next
    // run retries it without the state being edited by hand
    assert.equal(s1.final, false);
    assert.match(s1.error, /500/);
    up = true;
    const second = await run(opts, deps);
    assert.equal(second.zips, 1);
    assert.equal(second.charts, 1);

    const shown = await run(parseArgs([path.join(root, "x"), "--show", "--limit", "1"]), deps);
    assert.equal(shown.selected, 40);
    await assert.rejects(stat(path.join(root, "x")));
    await assert.rejects(run(parseArgs(["C:/Games/osu!/Songs/malody", "--show"]), deps), /refusing/);
    // too little room: nothing is downloaded
    const calls = web.calls.length;
    const full = await run(parseArgs([path.join(root, "full"), "--only", "6-7 2", "--etterna-packs", "-"]), { ...deps, freeBytes: async () => 1e9 });
    assert.equal(full.zips, 0);
    assert.equal(web.calls.length, calls);
});

test("run: lanes reserve room for each other's zips before the free-space check", async (t) => {
    const root = await tempDir(t);
    const outRoot = path.join(root, "malody");
    const one = "Malody 4k Converts (6-7 1).zip";
    const two = "Malody 4k Converts (6-7 2).zip";
    const good = makeZip([{ name: "S/s.sm", data: tinySm("Ess", "s.ogg", rowsA) }, { name: "S/s.ogg", data: oggOf(1) }]);
    const serve = () => new Response(good, { status: 200, headers: { "content-length": String(good.length) } });
    const web = fakeWeb({ [mirrorUrl(one)]: serve, [mirrorUrl(two)]: serve });
    // room for 6-7 1 (631 MB × 2.2 + 5 GB) plus 1 GB, not for both: the second lane must stop
    const free = 631136132 * 2.2 + 5e9 + 1e9;
    const deps = { fetchImpl: web.fetchImpl, sleepImpl: noSleep, logImpl: quiet, freeBytes: async () => free, pauseMs: 0 };
    const got = await run(parseArgs([outRoot, "--only", "6-7 1,6-7 2", "--lanes", "2", "--etterna-packs", "-"]), deps);
    assert.equal(got.zips, 1);
    assert.ok(!web.calls.some((c) => c.url === mirrorUrl(two)));
});
