import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    parseFolderPage, parseConfirmPage, contentDispositionName, osuInfo, downloadItem, processArchive, run, parseArgs,
    refuseSongs, hostAllowed, driveDownloadUrl, readState, fitNumbered,
    caseFreeGlob, decodeListing, classifyRarMembers, pickSources, processRar, createTarRunner, padForTar, RAR_PAD_BYTES,
    SOURCES, DEFAULT_OUT_ROOT, TAR_EXE,
} from "../../tools/fetch-drive-packs.mjs";
import { makeZip } from "./fixtures/makeZip.js";

async function tempDir(t) {
    const dir = await mkdtemp(path.join(tmpdir(), "drive-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
const files = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).replace(/\\/g, "/")).sort();
const noSleep = async () => {};
const quiet = () => {};

function chart({ mode = 3, keys = 4, audio = "audio.mp3", version = "Hard", notes = 50, id = 1 } = {}) {
    const objs = [];
    for (let i = 0; i < notes; i += 1) objs.push(`${[64, 192, 320, 448][i % 4]},192,${1000 + i * 100 + id},1,0,0:0:0:0:`);
    return [
        "osu file format v14", "", "[General]", `AudioFilename: ${audio}`, `Mode: ${mode}`, "",
        "[Metadata]", "Title:Song", "Artist:Someone", "Creator:mapper", `Version:${version}`, `BeatmapID:${id}`, "BeatmapSetID:77", "",
        "[Difficulty]", `CircleSize:${keys}`, "", "[TimingPoints]", "1000,500,4,1,0,100,1,0", "", "[HitObjects]", ...objs, "",
    ].join("\r\n");
}
const mp3 = (n = 1) => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4000, n)]);

function folderPage(title, entries) {
    const rows = entries.map((e) => `<div class="flip-entry" id="entry-${e.id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${e.folder
        ? `https://drive.google.com/drive/folders/${e.id}` : `https://drive.google.com/file/d/${e.id}/view?usp=drive_web`}" target="_blank"><div class="flip-entry-visual"></div><div class="flip-entry-title">${e.name}</div></a></div><div class="flip-entry-last-modified"><div>7/26/24</div></div></div>`).join("");
    return `<!DOCTYPE html><html><head><title>${title}</title></head><body><div id="flip-contents"><div class="flip-entries">${rows}</div></div></body></html>`;
}
const confirmPage = (id) => `<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>
<p>Google Drive can't scan this file for viruses.</p>
<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="submit" id="uc-download-link" value="Download anyway"/>
<input type="hidden" name="id" value="${id}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="abc-123"></form></body></html>`;
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const fileResponse = (data, name, { status = 200, headers = {} } = {}) => new Response(data, {
    status, headers: { "content-type": "application/octet-stream", "content-length": String(data.length), ...(name ? { "content-disposition": `attachment; filename="${name}"` } : {}), ...headers },
});

// ---- pages -------------------------------------------------------------------------------------------------

test("drive: folder pages give child files and folders with decoded names", () => {
    const page = parseFolderPage(folderPage("Beajek&#39;s Pack", [
        { id: "1j4thm4B1cwR876aoltbtnm-tLXpR-TBo", name: "Various Artists - Beajek&#39;s Eta &amp; Stamina.osz" },
        { id: "1ixTmqvGI6AgAwvhqN2vWaoMhogR4U9DN", name: "Pack [Jack]", folder: true },
    ]));
    assert.equal(page.title, "Beajek's Pack");
    assert.deepEqual(page.entries, [
        { id: "1j4thm4B1cwR876aoltbtnm-tLXpR-TBo", name: "Various Artists - Beajek's Eta & Stamina.osz", kind: "file" },
        { id: "1ixTmqvGI6AgAwvhqN2vWaoMhogR4U9DN", name: "Pack [Jack]", kind: "folder" },
    ]);
    assert.equal(parseFolderPage("<html><title>Sign in</title></html>"), null);
});

test("drive: the virus-scan page gives the confirmed link; the limit page and foreign forms do not", () => {
    const res = parseConfirmPage(confirmPage("FILE1"));
    const url = new URL(res.url);
    assert.equal(url.hostname, "drive.usercontent.google.com");
    assert.equal(url.searchParams.get("id"), "FILE1");
    assert.equal(url.searchParams.get("uuid"), "abc-123");
    assert.equal(url.searchParams.get("confirm"), "t");
    assert.deepEqual(parseConfirmPage("<title>Google Drive - Quota exceeded</title><p>Too many users have viewed or downloaded this file recently.</p>"), { quota: true });
    assert.equal(parseConfirmPage(confirmPage("X").replace("https://drive.usercontent.google.com/download", "https://evil.example/download")), null);
    assert.equal(parseConfirmPage("<html>something else</html>"), null);
});

test("drive: file names from Content-Disposition, allowed hosts, Songs guard, args", () => {
    assert.equal(contentDispositionName('attachment; filename="V.A. - ndg\'s Eta Training Pack 1.osz"'), "V.A. - ndg's Eta Training Pack 1.osz");
    assert.equal(contentDispositionName("attachment; filename=\"x.osz\"; filename*=UTF-8''%E3%83%86%E3%82%B9%E3%83%88.osz"), "テスト.osz");
    assert.equal(contentDispositionName(null), null);
    assert.ok(hostAllowed(driveDownloadUrl("abc")));
    assert.ok(hostAllowed("https://doc-0s-1c-docs.googleusercontent.com/x"));
    assert.ok(hostAllowed("https://cdn.emik.dev/archive/dan/all.zip"));
    assert.ok(!hostAllowed("https://accounts.google.com/ServiceLogin"));
    assert.ok(!hostAllowed("http://cdn.emik.dev/archive/dan/all.zip"));
    assert.throws(() => refuseSongs("A:/Games/osu!/Songs"), /refusing/);
    assert.throws(() => refuseSongs("C:/x/Songs/packs"), /refusing/);
    refuseSongs("A:/SneezeyTrain/packs");
    assert.deepEqual(parseArgs(["A:/out", "--only", "ndg-eta,dani-gamma", "--limit=1", "--lanes", "9"]),
        { outRoot: "A:/out", only: ["ndg-eta", "dani-gamma"], limit: 1, lanes: 3, list: false, match: null });
    assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});

test("drive: osuInfo reads mode, keys, audio, names and note counts", () => {
    const info = osuInfo(`\uFEFF${chart({ keys: 7, version: "Insane", notes: 12, id: 5 })}`);
    assert.equal(info.mode, 3);
    assert.equal(info.keys, 7);
    assert.equal(info.audio, "audio.mp3");
    assert.equal(info.version, "Insane");
    assert.equal(info.beatmapId, 5);
    assert.equal(info.notes, 12);
    assert.equal(osuInfo("osu file format v5\n[General]\nAudioFilename: a.mp3\n").mode, 0); // no Mode line = osu!standard
});

// ---- download ----------------------------------------------------------------------------------------------

test("drive: download follows the confirm page, resumes a cut transfer with Range and honours Retry-After", async (t) => {
    const dir = await tempDir(t);
    const data = Buffer.concat([Buffer.from("PK"), Buffer.alloc(200_000, 7)]);
    const calls = [];
    const sleeps = [];
    let n = 0;
    const fetchImpl = async (url, opts) => {
        calls.push({ url, range: opts.headers.range ?? null });
        n += 1;
        if (n === 1) return html(confirmPage("FILE1"));
        if (n === 2) return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
        if (n === 3) {
            // half of the file, then the connection drops
            let pulls = 0;
            const stream = new ReadableStream({
                async pull(c) {
                    if (pulls++ === 0) return c.enqueue(data.subarray(0, 120_000));
                    await new Promise((r) => setTimeout(r, 100)); // the first chunk reaches the disk, then the line drops
                    c.error(new Error("socket hang up"));
                },
            });
            return new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(data.length), "content-disposition": 'attachment; filename="Pack.osz"' } });
        }
        const from = Number(/bytes=(\d+)-/.exec(opts.headers.range)[1]);
        return fileResponse(data.subarray(from), "Pack.osz", { status: 206, headers: { "content-range": `bytes ${from}-${data.length - 1}/${data.length}` } });
    };
    const dest = path.join(dir, "dl", "x.bin");
    const r = await downloadItem(driveDownloadUrl("FILE1"), dest, { fetchImpl, sleepImpl: async (ms) => sleeps.push(ms), logImpl: quiet });
    assert.equal(r.name, "Pack.osz");
    assert.equal(r.resumedFrom, 120_000);
    assert.deepEqual(await readFile(dest), data);
    assert.equal(new URL(calls[1].url).searchParams.get("uuid"), "abc-123");
    assert.equal(calls[3].range, "bytes=120000-");
    assert.ok(sleeps.includes(7000));
    assert.deepEqual(await files(path.join(dir, "dl")), ["x.bin"]); // no .part left
});

test("drive: a .rar is not downloaded, the daily limit is a retry-later error, sign-in redirects are final", async (t) => {
    const dir = await tempDir(t);
    const dest = path.join(dir, "x.bin");
    const opts = { sleepImpl: noSleep, logImpl: quiet };
    await assert.rejects(downloadItem(driveDownloadUrl("R"), dest, { ...opts, fetchImpl: async () => fileResponse(Buffer.alloc(10), "Big pack.rar") }),
        (e) => e.final && e.skipped && e.fileName === "Big pack.rar");
    await assert.rejects(downloadItem(driveDownloadUrl("Q"), dest, { ...opts, fetchImpl: async () => html("<title>Quota exceeded</title>", 200) }),
        (e) => e.quota && !e.final);
    await assert.rejects(downloadItem(driveDownloadUrl("P"), dest, {
        ...opts,
        fetchImpl: async () => Object.defineProperty(html("<title>Sign in</title>"), "url", { value: "https://accounts.google.com/ServiceLogin?x" }),
    }), (e) => e.final && /accounts\.google\.com/.test(e.message));
    await assert.rejects(downloadItem(driveDownloadUrl("G"), dest, { ...opts, fetchImpl: async () => new Response("no", { status: 404 }) }), (e) => e.final);
    await assert.rejects(downloadItem("https://evil.example/x.zip", dest, { ...opts, fetchImpl: async () => { throw new Error("must not be called"); } }), (e) => e.final);
    assert.deepEqual(await files(dir), []);
    // a source that reads .rar downloads it; a .7z stays refused there too
    const r = await downloadItem(driveDownloadUrl("R"), dest, { ...opts, allowRar: true, fetchImpl: async () => fileResponse(Buffer.from("Rar!\x1a\x07\x00"), "osumania 2013 Ranked.rar") });
    assert.equal(r.name, "osumania 2013 Ranked.rar");
    await rm(dest);
    await assert.rejects(downloadItem(driveDownloadUrl("S"), dest, { ...opts, allowRar: true, fetchImpl: async () => fileResponse(Buffer.alloc(10), "pack.7z") }), (e) => e.skipped);
});

// ---- archives ----------------------------------------------------------------------------------------------

test("drive: a plain .osz keeps only 4K mania charts and the audio they name", async (t) => {
    const dir = await tempDir(t);
    const osz = path.join(dir, "pack.osz");
    await writeFile(osz, makeZip([
        { name: "Pack 4K [Hard].osu", data: chart({ version: "Hard", id: 1 }) },
        { name: "Pack 4K [Other].osu", data: chart({ version: "Other", audio: "Sub\\Second.OGG", id: 2 }) },
        { name: "Pack 7K.osu", data: chart({ keys: 7, audio: "seven.mp3", id: 3 }) },
        { name: "Pack std.osu", data: chart({ mode: 0, id: 4 }) },
        { name: "Pack missing.osu", data: chart({ audio: "gone.mp3", id: 5 }) },
        { name: "Pack escape.osu", data: chart({ audio: "../outside.mp3", id: 6 }) },
        { name: "../evil.osu", data: chart({ id: 7 }) },
        { name: "audio.mp3", data: mp3(1) },
        { name: "sub/second.ogg", data: mp3(2) },
        { name: "seven.mp3", data: mp3(3) },
        { name: "normal-hitclap.wav", data: mp3(4) },
        { name: "bg.jpg", data: "jpg" },
        { name: "run.exe", data: "MZ" },
    ]));
    const sets = path.join(dir, "sets");
    const m = await processArchive(osz, { key: "drive-A", source: "ndg-eta", name: "V.A. - Pack.osz" }, { setsRoot: sets, tmpDir: path.join(dir, "tmp"), label: "V.A. - Pack.osz" });
    assert.deepEqual(await files(sets), [
        "ndg-eta - V.A. - Pack/Pack 4K [Hard].osu", "ndg-eta - V.A. - Pack/Pack 4K [Other].osu",
        "ndg-eta - V.A. - Pack/audio.mp3", "ndg-eta - V.A. - Pack/sub/second.ogg",
    ]);
    assert.equal(m.totals.sets, 1);
    assert.equal(m.totals.charts, 2);
    assert.deepEqual(m.totals.dropped, { "7K": 1, mode0: 1, noAudio: 2 });
    assert.equal(m.ignored.unsafePaths, 1);
    assert.deepEqual(await readFile(path.join(sets, "ndg-eta - V.A. - Pack", "audio.mp3")), mp3(1));
    // the chart whose AudioFilename differs from the stored name now names the written file
    const other = await readFile(path.join(sets, "ndg-eta - V.A. - Pack", "Pack 4K [Other].osu"), "utf8");
    assert.match(other, /^AudioFilename: sub\/second\.ogg$/m);
    // the untouched one is byte for byte the original
    assert.equal(await readFile(path.join(sets, "ndg-eta - V.A. - Pack", "Pack 4K [Hard].osu"), "utf8"), chart({ version: "Hard", id: 1 }));
    assert.equal(m.sets[0].charts[0].version, "Hard");
    assert.match(m.sets[0].charts[0].hash, /^[0-9a-f]{40}$/);
});

test("drive: numbered copies keep their (n) when the name is cut, so same-looking long chart names in a deep folder end", async (t) => {
    assert.equal(fitNumbered("C:/x", "abc.osu", 2), "abc (2).osu");
    const deep = `C:/${"d".repeat(220)}`;
    const a = fitNumbered(deep, "a long chart name here.osu", 2);
    assert.match(a, / \(2\)\.osu$/);
    assert.notEqual(a, fitNumbered(deep, "a long chart name here.osu", 3));
    assert.ok(`${deep}/${a}`.length <= 240);

    // the real case: an .osz whose diff names differ only past the point where the folder's length cuts them
    const dir = await tempDir(t);
    const osz = path.join(dir, "long.osz");
    const long = (v) => `Jeff Williams & Casey Lee Williams - This Will Be the Day (James Landino's Magical Girl Remix) (mapper) [${v}].osu`;
    await writeFile(osz, makeZip([
        { name: long("4K Hard one"), data: chart({ version: "one", id: 1 }) },
        { name: long("4K Hard two"), data: chart({ version: "two", id: 2 }) },
        { name: long("4K Hard three"), data: chart({ version: "three", id: 3 }) },
        { name: "audio.mp3", data: mp3(1) },
    ]));
    const sets = path.join(dir, "s".repeat(Math.max(10, 200 - dir.length)));
    const m = await processArchive(osz, { key: "drive-L", source: "ranked-loved", name: "x.osz" }, { setsRoot: sets, tmpDir: path.join(dir, "tmp"), label: "x.osz" });
    const names = m.sets[0].charts.map((c) => c.file);
    assert.equal(names.length, 3);
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3);
    assert.ok(names.some((n) => / \(2\)\.osu$/.test(n)));
    for (const n of names) assert.ok(path.join(sets, m.sets[0].folder, n).length <= 240, n);
});

test("drive: a pack zip of .osz files gives one folder per .osz, reports .rar, drops duplicates, cleans its temp files", async (t) => {
    const dir = await tempDir(t);
    const oszA = makeZip([{ name: "A [4K].osu", data: chart({ id: 11 }) }, { name: "audio.mp3", data: mp3(5) }]);
    const oszB = makeZip([
        { name: "B [4K].osu", data: chart({ id: 12, version: "B" }) },
        { name: "B copy of A.osu", data: chart({ id: 11 }) }, // same bytes as A's chart
        { name: "audio.mp3", data: mp3(6) },
    ]);
    const oszC = makeZip([{ name: "C [7K].osu", data: chart({ keys: 7, id: 13 }) }, { name: "audio.mp3", data: mp3(7) }]);
    const zip = path.join(dir, "all.zip");
    await writeFile(zip, makeZip([
        { name: "Dan/1st/Dan A.osz", data: oszA, method: 0 },
        { name: "Dan/2nd/Dan B.osz", data: oszB },
        { name: "Dan/7K/Dan C.osz", data: oszC },
        { name: "Dan/old.rar", data: "Rar!..." },
        { name: "Dan/sm/x.sm", data: "#TITLE:x;" },
        { name: "Loose/L [4K].osu", data: chart({ id: 14, audio: "l.mp3" }) },
        { name: "Loose/l.mp3", data: mp3(8) },
    ]));
    const sets = path.join(dir, "sets");
    const tmp = path.join(dir, "tmp");
    const seen = new Map();
    const m = await processArchive(zip, { key: "url-dan-reform", source: "dan-reform", name: "Dan REFORM" }, { setsRoot: sets, tmpDir: tmp, seen, label: "Dan REFORM" });
    assert.deepEqual(await files(sets), [
        "dan-reform - Dan A/A [4K].osu", "dan-reform - Dan A/audio.mp3",
        "dan-reform - Dan B/B [4K].osu", "dan-reform - Dan B/audio.mp3",
        "dan-reform - Loose/L [4K].osu", "dan-reform - Loose/l.mp3",
    ]);
    assert.equal(m.totals.charts, 3);
    assert.equal(m.totals.dropped.duplicate, 1);
    assert.equal(m.totals.dropped["7K"], 1);
    assert.deepEqual(m.unsupported.map((u) => u.name), ["Dan/old.rar"]);
    assert.equal(m.ignored.simfiles, 1);
    assert.ok(m.skippedSets.some((s) => /Dan C\.osz/.test(s.from)));
    assert.deepEqual(await files(tmp), []);
    assert.equal(seen.size, 3);
    // a second download carrying the same chart does not write it again
    const again = path.join(dir, "again.osz");
    await writeFile(again, oszA);
    const m2 = await processArchive(again, { key: "drive-Z", source: "other", name: "Again.osz" }, { setsRoot: sets, tmpDir: tmp, seen, label: "Again.osz" });
    assert.equal(m2.totals.charts, 0);
    assert.equal(m2.totals.dropped.duplicate, 1);
    assert.ok(!(await files(sets)).some((f) => f.startsWith("other - ")));
});

// ---- the whole run -----------------------------------------------------------------------------------------

test("drive: run lists folders recursively, resumes by state, deletes each archive after extraction", async (t) => {
    const dir = await tempDir(t);
    const outRoot = path.join(dir, "packs");
    const osz = (id, title) => makeZip([{ name: `${title} [4K].osu`, data: chart({ id }) }, { name: "audio.mp3", data: mp3(id % 200) }]);
    const bodies = { F1: osz(21, "First"), F2: osz(22, "Second"), SINGLE: osz(23, "Single") };
    const pages = {
        ROOT: folderPage("Root", [{ id: "SUB", name: "Sub [Jack]", folder: true }, { id: "F1", name: "First.osz" }, { id: "RAR1", name: "Huge.rar" }]),
        SUB: folderPage("Sub", [{ id: "F2", name: "Second.osz" }]),
    };
    const downloads = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        const id = u.searchParams.get("id");
        if (u.pathname === "/embeddedfolderview") return pages[id] ? html(pages[id]) : html("nope", 404);
        downloads.push(id);
        if (!bodies[id]) return new Response("missing", { status: 404 });
        return fileResponse(bodies[id], id === "SINGLE" ? "V.A. - Single Pack.osz" : `${id}.osz`);
    };
    const sources = [
        { name: "single", kind: "drive-file", id: "SINGLE", title: "Single" },
        { name: "tree", kind: "drive-folder", id: "ROOT" },
    ];
    const common = { outRoot, sources, fetchImpl, sleepImpl: noSleep, logImpl: quiet, pageGapMs: 0, pauseMs: 0, minFreeBytes: 0 };

    await assert.rejects(run({ ...common, only: ["nope"] }), /unknown source/);

    const r1 = await run({ ...common, only: ["single"], limit: 1 });
    assert.equal(r1.attempted, 1);
    assert.deepEqual(downloads, ["SINGLE"]);
    assert.deepEqual(await files(path.join(outRoot, "sets")), ["single - V.A. - Single Pack/Single [4K].osu", "single - V.A. - Single Pack/audio.mp3"]);
    assert.deepEqual(await files(path.join(outRoot, "_dl")), []); // the archive is gone

    const r2 = await run({ ...common });
    assert.equal(r2.attempted, 3); // F2 (subfolder), F1, the .rar (skipped without a download)
    assert.deepEqual(downloads.sort(), ["F1", "F2", "SINGLE"]);
    const state = await readState(path.join(outRoot, "state.jsonl"));
    assert.equal(state.size, 4);
    assert.equal(state.get("drive-RAR1").skipped, ".rar is not supported");
    const manifest = JSON.parse(await readFile(path.join(outRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.totals.downloads, 3);
    assert.equal(manifest.totals.charts, 3);
    assert.deepEqual(manifest.notFetched.map((x) => x.name), ["Huge.rar"]);
    const sub = JSON.parse(await readFile(path.join(outRoot, "manifests", "drive-F2.json"), "utf8"));
    assert.equal(sub.drivePath, "Sub [Jack]");
    assert.deepEqual(await files(path.join(outRoot, "_dl")), []);
    const list = JSON.parse(await readFile(path.join(outRoot, "drive-list.json"), "utf8"));
    assert.deepEqual(list.tree.files.map((f) => f.id).sort(), ["F1", "F2", "RAR1"]);

    const r3 = await run({ ...common });
    assert.equal(r3.attempted, 0);
    assert.equal(downloads.length, 3);
    assert.ok(!(await stat(path.join(outRoot, "fetch-drive.lock")).catch(() => null)));

    // a folder page that fails later falls back to the saved listing
    const r4 = await run({ ...common, fetchImpl: async () => html("down", 500), list: true });
    assert.equal(r4.items.length, 4);
});

test("drive: a rewritten AudioFilename keeps '$' patterns of the audio name literal", async (t) => {
    const dir = await tempDir(t);
    const osz = path.join(dir, "dollar.osz");
    const audio = "Song $1000 x$&y $1.mp3";
    // the chart names the audio in another case, so its AudioFilename line is rewritten to the stored name
    await writeFile(osz, makeZip([{ name: "Dollar [4K].osu", data: chart({ audio: audio.toUpperCase(), id: 31 }) }, { name: audio, data: mp3(9) }]));
    const sets = path.join(dir, "sets");
    const m = await processArchive(osz, { key: "drive-D", source: "src", name: "Dollar.osz" }, { setsRoot: sets, tmpDir: path.join(dir, "tmp"), label: "Dollar.osz" });
    assert.equal(m.totals.charts, 1);
    const text = await readFile(path.join(sets, "src - Dollar", "Dollar [4K].osu"), "utf8");
    assert.equal(osuInfo(text).audio, audio);
    assert.deepEqual(await files(sets), ["src - Dollar/Dollar [4K].osu", `src - Dollar/${audio}`]);
});

test("drive: a small non-zip file is final (not fetched again); --list runs while another copy holds the lock", async (t) => {
    const dir = await tempDir(t);
    const outRoot = path.join(dir, "packs");
    const pages = { ROOT: folderPage("Root", [{ id: "TXT", name: "readme.txt" }, { id: "CUT", name: "Cut.osz" }]) };
    const downloads = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        const id = u.searchParams.get("id");
        if (u.pathname === "/embeddedfolderview") return pages[id] ? html(pages[id]) : html("nope", 404);
        downloads.push(id);
        if (id === "TXT") return fileResponse(Buffer.from("just some notes about the pack\r\n"), "readme.txt");
        return fileResponse(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(500, 1)]), "Cut.osz"); // a zip head, cut short
    };
    const common = { outRoot, sources: [{ name: "tree", kind: "drive-folder", id: "ROOT" }], fetchImpl, sleepImpl: noSleep, logImpl: quiet, pageGapMs: 0, pauseMs: 0, minFreeBytes: 0 };

    await run({ ...common });
    const state = await readState(path.join(outRoot, "state.jsonl"));
    assert.equal(state.get("drive-TXT").final, true);
    assert.ok(!state.has("drive-CUT")); // not final: left for the next run
    assert.deepEqual(await files(path.join(outRoot, "_dl")), []); // both downloads deleted

    await run({ ...common });
    assert.deepEqual(downloads.sort(), ["CUT", "CUT", "TXT"]); // only the cut zip is fetched again

    // a live owner (this very process) holds the lock: a job is refused, --list still works
    await writeFile(path.join(outRoot, "fetch-drive.lock"), String(process.pid));
    await assert.rejects(run({ ...common }), /another copy/);
    const r = await run({ ...common, list: true });
    assert.equal(r.items.length, 2);
    assert.equal(await readFile(path.join(outRoot, "fetch-drive.lock"), "utf8"), String(process.pid)); // left alone
});

// ---- .rar through tar.exe ------------------------------------------------------------------------------------

// A stand-in for tar.exe: -t prints the member names, -x writes the members an --include pattern matches under -C
// (refusing "..", stripping a leading "/", as bsdtar does). Every call is kept so the arguments can be checked.
function fakeTar(members, { listCode = 0, listStderr = "", calls = [] } = {}) {
    const globRe = (p) => new RegExp(`^${p.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return async (args) => {
        calls.push(args);
        if (args[0] === "-t") return { code: listCode, stdout: Buffer.from(members.map((m) => m.name).join("\r\n") + (members.length ? "\r\n" : "")), stderr: listStderr };
        const dest = args[args.indexOf("-C") + 1];
        const pats = args.filter((a) => a.startsWith("--include=")).map((a) => globRe(a.slice("--include=".length)));
        let code = 0;
        let stderr = "";
        for (const m of members) {
            if (!pats.some((r) => r.test(m.name))) continue;
            if (m.name.split("/").includes("..")) {
                code = 1;
                stderr += `${m.name}: Path contains '..'\n`;
                continue;
            }
            const target = path.join(dest, m.name.replace(/^\/+/, ""));
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, m.data);
        }
        return { code, stdout: Buffer.alloc(0), stderr };
    };
}
const rarBody = (n) => Buffer.concat([Buffer.from("Rar!\x1a\x07\x01\x00", "latin1"), Buffer.alloc(100 + n, n)]);

test("rar: members are sorted by kind, unsafe names counted, only extension patterns go to tar", () => {
    assert.equal(caseFreeGlob(".osz"), "*.[oO][sS][zZ]");
    assert.equal(caseFreeGlob(".mp3"), "*.[mM][pP]3");
    assert.deepEqual(decodeListing(Buffer.from("2013/\r\n2013/A.osz\r\nB.osz\n\n")), ["2013/A.osz", "B.osz"]);
    assert.deepEqual(decodeListing(Buffer.from([0x41, 0xe9, 0x2e, 0x6f, 0x73, 0x7a])), ["A\u00e9.osz"]); // not UTF-8: read as latin1
    const only = classifyRarMembers(["2013/A.osz", "2013/B.OSZ", "readme.txt", "x.exe", "inner.rar", "inner.zip", "bg"]);
    assert.equal(only.osz, 2);
    assert.deepEqual(only.patterns, ["*.[oO][sS][zZ]"]); // no loose .osu: audio is not extracted at all
    assert.deepEqual(only.nested, ["inner.rar", "inner.zip"]);
    assert.deepEqual(only.other, { ".txt": 1, ".exe": 1, "(none)": 1 });
    const loose = classifyRarMembers(["../evil.osz", "/abs.osz", "C:\\win\\x.osz", "a/../../b.osu", "con.mp3", "Set/L.osu", "Set\\l.mp3"]);
    assert.deepEqual(loose.unsafe, ["../evil.osz", "/abs.osz", "C:/win/x.osz", "a/../../b.osu", "con.mp3"]);
    assert.equal(loose.osz, 0);
    assert.equal(loose.osu, 1);
    assert.equal(loose.audio, 1);
    assert.deepEqual(loose.patterns, ["*.[oO][sS][uU]", "*.[mM][pP]3", "*.[oO][gG][gG]", "*.[oO][pP][uU][sS]", "*.[wW][aA][vV]", "*.[fF][lL][aA][cC]"]);
    assert.deepEqual(classifyRarMembers(["notes.txt"]).patterns, []);
});

test("rar: opt-in sources run only when named, with their own outRoot; mixed folders need an outRoot", () => {
    const sources = [{ name: "a" }, { name: "b" }, { name: "r", rar: true, optIn: true, outRoot: "A:/x/ranked" }];
    assert.deepEqual(pickSources(sources, null, null).picked.map((s) => s.name), ["a", "b"]);
    assert.equal(pickSources(sources, null, null).outRoot, DEFAULT_OUT_ROOT);
    assert.equal(pickSources(sources, ["r"], null).outRoot, "A:/x/ranked");
    assert.equal(pickSources(sources, ["r"], "A:/y").outRoot, "A:/y");
    assert.throws(() => pickSources(sources, ["a", "r"], null), /different folders/);
    assert.throws(() => pickSources(sources, ["zzz"], null), /unknown source/);
    // the real list: the eight approved packs keep their folder, ranked-loved has its own and is opt-in
    const real = pickSources(SOURCES, null, null);
    assert.equal(real.outRoot, "A:/SneezeyTrain/packs");
    assert.equal(real.picked.length, 8);
    assert.ok(!real.picked.some((s) => s.name === "ranked-loved"));
    assert.equal(pickSources(SOURCES, ["ranked-loved"], null).outRoot, "A:/SneezeyTrain/ranked");
    assert.equal(SOURCES.find((s) => s.name === "ranked-loved").id, "1rxXzQRTpUYlS-7XS3Ub9eS1pix3YwYhT");
    assert.equal(parseArgs(["--only", "ranked-loved", "--match", "2013 Ranked"]).match, "2013 Ranked");
    assert.equal(parseArgs([]).outRoot, null);
});

test("rar: processRar extracts only .osz / loose charts into a temp folder, one set per .osz, and removes the folder", async (t) => {
    const dir = await tempDir(t);
    const rar = path.join(dir, "x.bin");
    await writeFile(rar, rarBody(1));
    const calls = [];
    const tar = fakeTar([
        { name: "2013/111 A - Song.osz", data: makeZip([{ name: "A - Song (m) [4K].osu", data: chart({ id: 41 }) }, { name: "audio.mp3", data: mp3(41) }, { name: "bg.jpg", data: "j" }]) },
        { name: "2013/222 B - Seven.OSZ", data: makeZip([{ name: "B [7K].osu", data: chart({ keys: 7, id: 42 }) }, { name: "audio.mp3", data: mp3(42) }]) },
        { name: "2013/333 C - Copy.osz", data: makeZip([{ name: "C copy.osu", data: chart({ id: 41 }) }, { name: "audio.mp3", data: mp3(43) }]) },
        { name: "Loose/L [4K].osu", data: chart({ id: 44, audio: "l.mp3" }) },
        { name: "Loose/l.mp3", data: mp3(44) },
        { name: "Loose/other.ogg", data: mp3(45) },
        { name: "../evil.osz", data: "x" },
        { name: "nested.rar", data: "Rar!" },
        { name: "run.exe", data: "MZ" },
        { name: "bg.jpg", data: "jpg" },
    ], { calls });
    const sets = path.join(dir, "sets");
    const tmp = path.join(dir, "tmp");
    const m = await processRar(rar, { key: "drive-R13", source: "ranked", name: "osumania 2013 Ranked.rar" }, {
        setsRoot: sets, tmpDir: tmp, label: "osumania 2013 Ranked.rar", tar, logImpl: quiet, diskFloorBytes: 0,
    });
    assert.deepEqual(await files(sets), [
        "ranked - 111 A - Song/A - Song (m) [4K].osu", "ranked - 111 A - Song/audio.mp3",
        "ranked - Loose/L [4K].osu", "ranked - Loose/l.mp3",
    ]);
    assert.equal(m.totals.sets, 2);
    assert.equal(m.totals.charts, 2);
    assert.deepEqual(m.totals.dropped, { "7K": 1, duplicate: 1 });
    assert.deepEqual(m.unsupported.map((u) => u.name), ["nested.rar"]);
    assert.equal(m.rar.osz, 3);
    assert.equal(m.rar.unsafe, 1);
    assert.equal(m.rar.extractedOsz, 3);
    assert.equal(m.rar.tarExit, 1); // tar refused "../evil.osz"
    assert.match(m.rar.extractWarnings, /Path contains/);
    assert.deepEqual(m.rar.other, { ".exe": 1, ".jpg": 1 });
    assert.deepEqual(await files(tmp), []); // the temp folder is gone
    assert.ok(!(await stat(path.join(tmp, "drive-R13-rar")).catch(() => null)));
    // tar was asked to list, then to extract by extension pattern only: no member name reaches its command line
    assert.deepEqual(calls[0], ["-t", "-f", rar]);
    assert.deepEqual(calls[1].slice(0, 5), ["-x", "-f", rar, "-C", path.join(tmp, "drive-R13-rar")]);
    assert.ok(calls[1].slice(5).every((a) => /^--include=\*\.[[\]a-zA-Z0-9]+$/.test(a)), calls[1].join(" "));
    assert.equal(calls.length, 2);
});

test("rar: an unreadable archive is a damaged error and leaves no temp folder; a full disk keeps the .rar", async (t) => {
    const dir = await tempDir(t);
    const rar = path.join(dir, "x.bin");
    await writeFile(rar, rarBody(2));
    const opts = { setsRoot: path.join(dir, "sets"), tmpDir: path.join(dir, "tmp"), logImpl: quiet, diskFloorBytes: 0 };
    const item = { key: "drive-BAD", source: "ranked", name: "bad.rar" };
    await assert.rejects(processRar(rar, item, { ...opts, tar: fakeTar([], { listCode: 1, listStderr: "tar.exe: Unrecognized archive format" }) }),
        (e) => e.damaged && /Unrecognized/.test(e.message));
    // listed, but tar wrote nothing
    const nothing = async (args) => (args[0] === "-t" ? { code: 0, stdout: Buffer.from("A.osz\r\n"), stderr: "" } : { code: 1, stdout: Buffer.alloc(0), stderr: "Encrypted file is unsupported" });
    await assert.rejects(processRar(rar, item, { ...opts, tar: nothing }), (e) => e.damaged && /Encrypted/.test(e.message));
    assert.deepEqual(await files(path.join(dir, "tmp")), []);
    // not enough room for the extracted copy
    const small = async () => ({ bavail: 1, bsize: 1000 });
    await assert.rejects(processRar(rar, item, { ...opts, diskFloorBytes: 1e9, statfsImpl: small, tar: fakeTar([{ name: "A.osz", data: "x" }]) }),
        (e) => e.diskFull);
    assert.ok(await stat(rar)); // processRar never deletes the archive itself
});

test("rar: run fetches an opt-in .rar source into its own folder, resumes, deletes the .rar and the temp folder", async (t) => {
    const dir = await tempDir(t);
    const packsRoot = path.join(dir, "packs");
    const rankedRoot = path.join(dir, "ranked");
    const osz = (id, title) => makeZip([{ name: `${title} [4K].osu`, data: chart({ id }) }, { name: "audio.mp3", data: mp3(id % 200) }]);
    const rars = {
        13: [{ name: "2013/501 X - First.osz", data: osz(51, "First") }, { name: "2013/502 X - Second.osz", data: osz(52, "Second") }],
        18: [{ name: "503 Y - Loved.osz", data: osz(53, "Loved") }, { name: "dup/504 Y - Again.osz", data: osz(51, "First") }],
    };
    const pages = {
        PROOT: folderPage("Packs", [{ id: "P1", name: "Pack.osz" }, { id: "PRAR", name: "Pack.rar" }]),
        RROOT: folderPage("osu!mania Ranked + Loved", [{ id: "RSUB", name: "Ranked", folder: true }, { id: "R18", name: "osumania 2018 Loved.rar" }]),
        RSUB: folderPage("Ranked", [{ id: "R13", name: "osumania 2013 Ranked.rar" }]),
    };
    const downloads = [];
    const pageHits = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        const id = u.searchParams.get("id");
        if (u.pathname === "/embeddedfolderview") {
            pageHits.push(id);
            return pages[id] ? html(pages[id]) : html("nope", 404);
        }
        downloads.push(id);
        if (id === "P1") return fileResponse(osz(55, "Pack"), "Pack.osz");
        if (id === "R13") return fileResponse(rarBody(13), "osumania 2013 Ranked.rar");
        if (id === "R18") return fileResponse(rarBody(18), "osumania 2018 Loved.rar");
        return new Response("missing", { status: 404 });
    };
    // the members the fake tar shows depend on the archive it is handed (its filler byte)
    const tar = async (args, o) => {
        const body = await readFile(args[args.indexOf("-f") + 1]);
        return fakeTar(rars[body[20]])(args, o);
    };
    const sources = [
        { name: "packs", kind: "drive-folder", id: "PROOT" },
        { name: "ranked", kind: "drive-folder", id: "RROOT", rar: true, optIn: true, outRoot: rankedRoot },
    ];
    const common = { sources, fetchImpl, sleepImpl: noSleep, logImpl: quiet, pageGapMs: 0, pauseMs: 0, minFreeBytes: 0, tarImpl: tar, rarDiskFloorBytes: 0 };

    // the ordinary run: the opt-in source is not even listed, the pack's own .rar is still skipped unread
    const r0 = await run({ ...common, outRoot: packsRoot });
    assert.equal(r0.attempted, 2);
    assert.deepEqual(pageHits, ["PROOT"]);
    assert.deepEqual(downloads, ["P1"]);
    assert.equal((await readState(path.join(packsRoot, "state.jsonl"))).get("drive-PRAR").skipped, ".rar is not supported");

    // the opt-in source by name, one file picked with --match: its own outRoot, nothing written into packs
    const r1 = await run({ ...common, only: ["ranked"], match: "2013 ranked" });
    assert.equal(r1.attempted, 1);
    assert.deepEqual(downloads, ["P1", "R13"]);
    assert.deepEqual(await files(path.join(rankedRoot, "sets")), [
        "ranked - 501 X - First/First [4K].osu", "ranked - 501 X - First/audio.mp3",
        "ranked - 502 X - Second/Second [4K].osu", "ranked - 502 X - Second/audio.mp3",
    ]);
    assert.deepEqual(await files(path.join(rankedRoot, "_dl")), []); // the .rar is gone
    assert.deepEqual(await files(path.join(rankedRoot, "_tmp")), []); // and so is its temp folder
    const m13 = JSON.parse(await readFile(path.join(rankedRoot, "manifests", "drive-R13.json"), "utf8"));
    assert.equal(m13.drivePath, "Ranked");
    assert.equal(m13.rar.osz, 2);
    assert.equal(m13.rar.paddedBytes, RAR_PAD_BYTES);
    assert.equal(m13.bytes, rarBody(13).length); // the size as downloaded, without the padding
    assert.equal(m13.totals.charts, 2);
    assert.ok(!(await files(packsRoot)).some((f) => f.includes("R13")));

    // the rest; a chart already taken from 2013 is not written again
    const r2 = await run({ ...common, only: ["ranked"] });
    assert.equal(r2.attempted, 1);
    assert.deepEqual(downloads, ["P1", "R13", "R18"]);
    const m18 = JSON.parse(await readFile(path.join(rankedRoot, "manifests", "drive-R18.json"), "utf8"));
    assert.equal(m18.totals.charts, 1);
    assert.equal(m18.totals.dropped.duplicate, 1);
    const state = await readState(path.join(rankedRoot, "state.jsonl"));
    assert.ok(state.get("drive-R13").ok && state.get("drive-R18").ok);
    const r3 = await run({ ...common, only: ["ranked"] });
    assert.equal(r3.attempted, 0);
    assert.equal(downloads.length, 3);
    // the packs state was not touched by any of it
    assert.equal((await readState(path.join(packsRoot, "state.jsonl"))).size, 2);
});

test("rar: a .rar tar cannot read is fetched once more, then given up", async (t) => {
    const dir = await tempDir(t);
    const outRoot = path.join(dir, "ranked");
    const downloads = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === "/embeddedfolderview") return html(folderPage("R", [{ id: "BAD", name: "broken.rar" }]));
        downloads.push(u.searchParams.get("id"));
        return fileResponse(rarBody(3), "broken.rar");
    };
    const tar = fakeTar([], { listCode: 1, listStderr: "tar.exe: Truncated RAR file data" });
    const common = {
        sources: [{ name: "ranked", kind: "drive-folder", id: "R", rar: true, optIn: true, outRoot }], only: ["ranked"],
        fetchImpl, sleepImpl: noSleep, logImpl: quiet, pageGapMs: 0, pauseMs: 0, minFreeBytes: 0, tarImpl: tar, rarDiskFloorBytes: 0,
    };
    await run(common);
    assert.ok(!(await readState(path.join(outRoot, "state.jsonl"))).has("drive-BAD")); // not final yet
    assert.deepEqual(await files(path.join(outRoot, "_dl")), []);
    await run(common);
    assert.equal((await readState(path.join(outRoot, "state.jsonl"))).get("drive-BAD").final, true);
    await run(common);
    assert.deepEqual(downloads, ["BAD", "BAD"]);
});

test("rar: the downloaded copy gets zeros at its end once (tar must not take a trailing .osz for the archive)", async (t) => {
    const dir = await tempDir(t);
    const file = path.join(dir, "x.bin");
    const body = Buffer.concat([rarBody(4), makeZip([{ name: "last.osu", data: "x" }])]); // ends in a zip directory
    await writeFile(file, body);
    assert.equal(await padForTar(file), true);
    assert.equal(await padForTar(file), false); // already padded: left as it is
    const after = await readFile(file);
    assert.equal(after.length, body.length + RAR_PAD_BYTES);
    assert.deepEqual(after.subarray(0, body.length), body);
    assert.ok(after.subarray(body.length).every((b) => b === 0));
    // processRar pads before listing; a copy padded on an earlier try is not padded again
    const m = await processRar(file, { key: "drive-PAD", source: "ranked", name: "p.rar" }, {
        setsRoot: path.join(dir, "sets"), tmpDir: path.join(dir, "tmp"), tar: fakeTar([]), logImpl: quiet, diskFloorBytes: 0,
    });
    assert.equal(m.rar.paddedBytes, RAR_PAD_BYTES); // the zeros are there either way, so the size is still told right
    assert.equal(m.rar.paddedNow, false);
});

test("rar: a tar that is killed or runs out of disk keeps the .rar (not damaged); other non-zero exits are partial", async (t) => {
    const dir = await tempDir(t);
    const rar = path.join(dir, "x.bin");
    await writeFile(rar, rarBody(5));
    const opts = { setsRoot: path.join(dir, "sets"), tmpDir: path.join(dir, "tmp"), logImpl: quiet, diskFloorBytes: 0 };
    const item = { key: "drive-KILL", source: "ranked", name: "kill.rar" };
    const osz = makeZip([{ name: "A [4K].osu", data: chart({ id: 61 }) }, { name: "audio.mp3", data: mp3(61) }]);
    const plain = (e) => !e.damaged && !e.diskFull && !e.final;
    // the listing is killed: no names, code null
    const listKilled = async () => ({ code: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: "" });
    await assert.rejects(processRar(rar, item, { ...opts, tar: listKilled }), (e) => plain(e) && /stopped/.test(e.message));
    // the extraction is killed (the 4 h timeout) after writing one .osz
    const good = fakeTar([{ name: "A.osz", data: osz }, { name: "B.osz", data: osz }]);
    const cut = (result) => async (args, o) => {
        if (args[0] === "-t") return good(args, o);
        const dest = args[args.indexOf("-C") + 1];
        await writeFile(path.join(dest, "A.osz"), osz);
        return result;
    };
    for (const r of [{ code: null, signal: "SIGKILL" }, { code: null, signal: null }]) {
        await assert.rejects(processRar(rar, item, { ...opts, tar: cut({ ...r, stdout: Buffer.alloc(0), stderr: "" }) }), (e) => plain(e) && /stopped/.test(e.message));
    }
    // tar fails writing on a full disk between two polls
    await assert.rejects(processRar(rar, item, { ...opts, tar: cut({ code: 1, stdout: Buffer.alloc(0), stderr: "tar.exe: B.osz: Write failed: No space left on device" }) }),
        (e) => e.diskFull && !e.damaged);
    assert.deepEqual(await files(path.join(dir, "tmp")), []);
    assert.deepEqual(await files(path.join(dir, "sets")), []); // nothing kept from a cut extraction
    assert.ok(await stat(rar));
    // any other non-zero exit: the sets written are kept, marked partial
    const m = await processRar(rar, item, { ...opts, tar: cut({ code: 1, stdout: Buffer.alloc(0), stderr: "B.osz: Path contains '..'" }) });
    assert.equal(m.totals.sets, 1);
    assert.equal(m.rar.partial, true);
    assert.equal(m.rar.tarExit, 1);
});

test("rar: run keeps a .rar whose tar was killed, reads it next run without a new download, notes partial reads", async (t) => {
    const dir = await tempDir(t);
    const outRoot = path.join(dir, "ranked");
    const osz = (id, title) => makeZip([{ name: `${title} [4K].osu`, data: chart({ id }) }, { name: "audio.mp3", data: mp3(id % 200) }]);
    const members = [{ name: "601 A - One.osz", data: osz(71, "One") }, { name: "../evil.osz", data: osz(72, "Evil") }];
    const downloads = [];
    const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === "/embeddedfolderview") return html(folderPage("R", [{ id: "K1", name: "osumania 2014 Ranked.rar" }]));
        downloads.push(u.searchParams.get("id"));
        return fileResponse(rarBody(14), "osumania 2014 Ranked.rar");
    };
    let kill = true;
    const good = fakeTar(members);
    const tar = async (args, o) => (args[0] === "-x" && kill ? { code: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: "" } : good(args, o));
    const common = {
        sources: [{ name: "ranked", kind: "drive-folder", id: "R", rar: true, optIn: true, outRoot }], only: ["ranked"],
        fetchImpl, sleepImpl: noSleep, logImpl: quiet, pageGapMs: 0, pauseMs: 0, minFreeBytes: 0, tarImpl: tar, rarDiskFloorBytes: 0,
    };
    await run(common);
    assert.ok(!(await readState(path.join(outRoot, "state.jsonl"))).has("drive-K1")); // not done, not final
    assert.equal((await files(path.join(outRoot, "_dl"))).filter((f) => !f.endsWith(".json")).length, 1); // the .rar stays
    kill = false;
    await run(common);
    assert.deepEqual(downloads, ["K1"]); // read from the kept copy
    const rec = (await readState(path.join(outRoot, "state.jsonl"))).get("drive-K1");
    assert.equal(rec.ok, true);
    assert.equal(rec.partial, true); // tar refused "../evil.osz"
    assert.equal(rec.bytes, rarBody(14).length); // padded on the first try, still the size as downloaded
    assert.deepEqual(await files(path.join(outRoot, "_dl")), []);
});

test("rar: a source's sibling folders are listed with it, files once", async (t) => {
    const dir = await tempDir(t);
    const pages = {
        MAIN: folderPage("Main", [{ id: "A", name: "osumania 2013 Ranked.rar" }]),
        S1: folderPage("S1", [{ id: "B", name: "osumania 2021 Ranked.rar" }, { id: "A", name: "osumania 2013 Ranked.rar" }]),
        S2: folderPage("S2", [{ id: "C", name: "osumania 2025 Ranked.rar" }]),
    };
    const fetchImpl = async (url) => html(pages[new URL(url).searchParams.get("id")] ?? "nope", pages[new URL(url).searchParams.get("id")] ? 200 : 404);
    const outRoot = path.join(dir, "ranked");
    const r = await run({
        sources: [{ name: "ranked", kind: "drive-folder", id: "MAIN", moreFolders: ["S1", "S2"], rar: true, optIn: true, outRoot }],
        only: ["ranked"], list: true, fetchImpl, sleepImpl: noSleep, logImpl: quiet, pageGapMs: 0,
    });
    assert.deepEqual(r.items.map((i) => i.key), ["drive-A", "drive-B", "drive-C"]);
    assert.ok(r.items.every((i) => i.rar && !i.skip));
    const real = SOURCES.find((s) => s.name === "ranked-loved");
    assert.equal(real.moreFolders.length, 3);
});

const haveTar = await stat(TAR_EXE).then(() => true, () => false);
test("rar: the real tar.exe lists and extracts through the same path (a zip stands in for the .rar)", { skip: !haveTar && "no tar.exe" }, async (t) => {
    const dir = await tempDir(t);
    const archive = path.join(dir, "x.bin");
    const osz = (id, title) => makeZip([{ name: `${title} [4K].osu`, data: chart({ id }) }, { name: "audio.mp3", data: mp3(id % 200) }]);
    await writeFile(archive, makeZip([
        { name: "2013/601 Real - One.osz", data: osz(61, "One") },
        { name: "2013/602 Real - Two.OSZ", data: osz(62, "Two") },
        { name: "2013/603 \u30c6\u30b9\u30c8 - Three.osz", data: osz(63, "Three") },
        { name: "../evil.osz", data: osz(64, "Evil") },
        { name: "readme.txt", data: "notes" },
        { name: "tool.exe", data: "MZ" },
    ]));
    const sets = path.join(dir, "sets");
    const tmp = path.join(dir, "tmp");
    const m = await processRar(archive, { key: "drive-REAL", source: "ranked", name: "real.rar" }, {
        setsRoot: sets, tmpDir: tmp, label: "real.rar", tar: createTarRunner(), logImpl: quiet, diskFloorBytes: 0,
    });
    const written = await files(sets);
    assert.ok(written.includes("ranked - 601 Real - One/One [4K].osu"), written.join("\n"));
    assert.ok(written.includes("ranked - 602 Real - Two/Two [4K].osu"));
    assert.ok(!written.some((f) => /Evil|tool\.exe|readme/.test(f)));
    assert.equal(m.rar.unsafe, 1);
    // the Japanese name is either read (a UTF-8 code page) or counted as unreadable (code page 1251)
    assert.equal(m.rar.osz + m.rar.unreadableNames, 3);
    assert.equal(m.rar.extractedOsz, m.rar.osz); // "../evil.osz" was refused by tar
    assert.deepEqual(await files(tmp), []);
});
