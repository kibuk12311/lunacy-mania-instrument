// Saving generated maps and remapping existing ones (mapgen v3, stream C): export-set resolves store ids and writes
// one .osz (a single map keeps today's name), song-tags reads the song's own tags, remap-load / remap-create work on
// .osu files the window picked this session. Fakes stand in for the worker, the analysis and ffmpeg's audio.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { registerExportIpc } from "../app/exportIpc.js";
import { createGeneratedStore } from "../app/generatedStore.js";
import { readMeta } from "../src/gen/osuMeta.js";
import { toOsu } from "../src/gen/writer.js";
import { makeChart } from "./fixtures/makeChart.js";
import { readOsz, osuTexts } from "./fixtures/readOsz.js";
import { t } from "../src/i18n/i18n.js";

const generated = (version) => toOsu({
    rows: Array.from({ length: 20 }, (_, i) => ({ t: 1000 + i * 250, cols: [i % 4] })),
    bpm: 120, offsetMs: 1000, title: "Song", version, audioFilename: "audio.mp3", previewMs: 4000,
});

async function setup(extra = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), "export-ipc-"));
    const audioPath = path.join(dir, "song.mp3");
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    const mapsDir = path.join(dir, "maps");
    const generatedStore = createGeneratedStore();
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } };
    const logs = [];
    const calls = { analyze: [], audio: [], remap: [] };
    const deps = {
        ipcMain, generatedStore, paths: { mapsDir }, log: (line) => logs.push(line),
        analysis: { analyze: async (text, rate) => { calls.analyze.push({ text, rate }); return { kind: "ok", label: "Delta low", numeric: 13.6 }; } },
        ffmpegPath: async () => ffmpegStatic,
        renderPng: async () => Buffer.from("PNG"),
        renderAudio: async ({ output, rate }) => { calls.audio.push(rate); await writeFile(output, `audio ${rate}`); return output; },
        tosu: { beatmapPath: async () => { throw new Error("osu! is closed"); } },
        generatorClient: { remap: async (payload) => { calls.remap.push(payload); return { kind: "error", message: "no remap here" }; } },
        ...extra,
    };
    registerExportIpc(deps);
    const id = generatedStore.put({
        osuText: generated("Gamma mid Jumpstream"), version: "Gamma mid Jumpstream", title: "Song", audioPath,
        result: { kind: "ok", label: "Gamma mid", numeric: 13.04 },
    });
    const call = (channel, payload) => handlers[channel]({}, payload);
    return { dir, mapsDir, audioPath, generatedStore, handlers, call, id, logs, calls, deps };
}

const exportReq = (ids, more = {}) => ({ ids, meta: { title: "Song", artist: "", source: "", tags: "", creator: "" }, previewMs: null, background: { mode: "none" }, rates: [], pitch: false, ...more });

test("registers the export, tags and remap channels", async () => {
    const { handlers } = await setup();
    assert.deepEqual(Object.keys(handlers).sort(), ["export-set", "remap-create", "remap-load", "song-tags"]);
});

// ---- export-set ----

test("one id with no rates is saved under today's name, with the map, its audio and the metadata", async () => {
    const { call, id, mapsDir, calls } = await setup();
    const answer = await call("export-set", exportReq([id], { meta: { title: "Song", artist: "Band", source: "src", tags: "t", creator: "me" }, previewMs: 61000 }));
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.file, path.join(mapsDir, "Song [Gamma mid Jumpstream].osz"));
    assert.deepEqual(answer.entries, [{ version: "Gamma mid Jumpstream", label: "Gamma mid", numeric: 13.04, rate: 1 }]);
    const files = readOsz(await readFile(answer.file));
    assert.deepEqual(files.get("audio.mp3"), Buffer.from([1, 2, 3]));
    const [[name, text]] = [...osuTexts(files)];
    assert.equal(name, "Band - Song (me) [Gamma mid Jumpstream].osu");
    const meta = readMeta(text);
    assert.deepEqual([meta.artist, meta.source, meta.tags, meta.previewMs], ["Band", "src", "lunacy-mania generated t", 61000]);
    assert.equal(calls.analyze.length, 0, "the stored dan is used");
});

test("saving twice keeps both files", async () => {
    const { call, id, mapsDir } = await setup();
    const a = await call("export-set", exportReq([id]));
    const b = await call("export-set", { ids: [id] });
    assert.notEqual(a.file, b.file);
    assert.equal((await readdir(mapsDir)).length, 2);
});

test("a mapset with a rate version: one file named after the song, the rated dans analysed at 1.0", async () => {
    const { call, id, generatedStore, audioPath, calls } = await setup();
    const other = generatedStore.put({ osuText: generated("Delta mid Jumpstream"), version: "Delta mid Jumpstream", title: "Song", audioPath, result: { kind: "ok", label: "Delta mid", numeric: 14 } });
    const answer = await call("export-set", exportReq([id, other], { meta: { title: "Song", artist: "Band", source: "", tags: "", creator: "" }, rates: [1.2], background: { mode: "danCourse" } }));
    assert.equal(answer.ok, true, answer.message);
    assert.equal(path.basename(answer.file), "Band - Song (mapset).osz");
    assert.deepEqual(answer.entries.map((e) => [e.version, e.rate]), [
        ["Gamma mid Jumpstream", 1], ["Delta low · Gamma mid Jumpstream 1.2x", 1.2],
        ["Delta mid Jumpstream", 1], ["Delta low · Delta mid Jumpstream 1.2x", 1.2],
    ]);
    assert.deepEqual(calls.analyze.map((c) => c.rate), [1, 1]);
    assert.deepEqual(calls.audio, [1.2]);
    const files = readOsz(await readFile(answer.file));
    assert.ok(files.has("bg.png") && files.has("audio 1.2x.mp3") && files.has("audio.mp3"));
});

test("an id the store does not know is refused", async () => {
    const { call, id } = await setup();
    assert.deepEqual(await call("export-set", exportReq(["no-such-id"])), { ok: false, message: t("app.gen.unknownId") });
    assert.deepEqual(await call("export-set", exportReq([id, "no-such-id"])), { ok: false, message: t("app.gen.unknownId") });
});

test("difficulties of different songs cannot share a mapset", async () => {
    const { call, id, generatedStore, dir } = await setup();
    const other = generatedStore.put({ ...generatedStore.get(id), audioPath: path.join(dir, "other.mp3") });
    assert.deepEqual(await call("export-set", exportReq([id, other])), { ok: false, message: t("app.export.mixedSongs") });
});

test("a background picture must be a .jpg or .png of at most 15 MB", async () => {
    const { call, id, dir, mapsDir } = await setup();
    const gif = path.join(dir, "a.gif");
    const huge = path.join(dir, "huge.png");
    await writeFile(gif, "GIF89a");
    await writeFile(huge, Buffer.alloc(15 * 1024 * 1024 + 1));
    for (const background of [{ mode: "image" }, { mode: "image", imagePath: gif }, { mode: "image", imagePath: huge },
        { mode: "image", imagePath: path.join(dir, "missing.png") }, { mode: "danCourse", imagePath: gif }]) {
        assert.deepEqual(await call("export-set", exportReq([id], { background })), { ok: false, message: t("app.export.badImage") }, JSON.stringify(background));
    }
    const answer = await call("export-set", exportReq([id], { background: { mode: "sparkles" } }));
    assert.equal(answer.message, t("app.gen.badRequest", { what: "background" }));
    await assert.rejects(readdir(mapsDir), "nothing was written");
});

test("a rate must be 0.5–2 and not 1; at most 3", async () => {
    const { call, id } = await setup();
    for (const rates of [[1], [1.004], [2.5], [0.4], ["1.2"], [Number.NaN]]) {
        assert.deepEqual(await call("export-set", exportReq([id], { rates })), { ok: false, message: t("app.export.badRate") }, JSON.stringify(rates));
    }
    assert.equal((await call("export-set", exportReq([id], { rates: [1.1, 1.2, 1.3, 1.4] }))).message, t("app.gen.badRequest", { what: "rates" }));
});

test("ids must be 1 to 8 strings", async () => {
    const { call } = await setup();
    for (const req of [null, {}, { ids: "x" }, { ids: [] }, { ids: [7] }, { ids: [""] }, { ids: Array.from({ length: 9 }, (_, i) => `id${i}`) }]) {
        const answer = await call("export-set", req);
        assert.equal(answer.ok, false);
        assert.equal(answer.message, t("app.gen.badRequest", { what: req === null ? "request" : "ids" }), JSON.stringify(req));
    }
});

test("rates must be a list, metadata strings, the preview point a time", async () => {
    const { call, id } = await setup();
    assert.equal((await call("export-set", { ids: [id], rates: 1.2 })).message, t("app.gen.badRequest", { what: "rates" }));
    assert.equal((await call("export-set", { ids: [id], meta: { title: 5 } })).message, t("app.gen.badRequest", { what: "meta.title" }));
    assert.equal((await call("export-set", { ids: [id], meta: { tags: "x".repeat(5000) } })).message, t("app.gen.badRequest", { what: "meta.tags" }));
    assert.equal((await call("export-set", { ids: [id], previewMs: -5 })).message, t("app.gen.badRequest", { what: "previewMs" }));
    assert.equal((await call("export-set", { ids: [id], pitch: "yes" })).message, t("app.gen.badRequest", { what: "pitch" }));
});

test("a save that fails is an answer, not a throw", async () => {
    const { call, generatedStore, dir } = await setup();
    const id = generatedStore.put({ osuText: "o", version: "v", title: "S", audioPath: path.join(dir, "missing.mp3"), result: null });
    const answer = await call("export-set", { ids: [id] });
    assert.equal(answer.ok, false);
    assert.match(answer.message, /missing\.mp3|ENOENT/);
});

// ---- song-tags ----

test("song tags come from the file, or from its name", async () => {
    const { call, dir } = await setup();
    const song = path.join(dir, "Some Band - Some Song.mp3");
    await writeFile(song, "not really audio");
    assert.deepEqual(await call("song-tags", song), { ok: true, artist: "Some Band", title: "Some Song" });
    for (const bad of [null, 5, "", "relative.mp3", path.join(dir, "notes.txt")]) {
        assert.equal((await call("song-tags", bad)).ok, false, String(bad));
    }
});

// ---- remap ----

async function songFolder(dir, chart = makeChart({ kind: "jumpstream", bpm: 160, seconds: 30 })) {
    const folder = path.join(dir, "123 Test - Song");
    await (await import("node:fs/promises")).mkdir(folder, { recursive: true });
    const file = path.join(folder, "Test - Song (Test) [Hard].osu");
    await writeFile(file, chart.replace("Version:jumpstream 160", "Version:Hard"), "utf8");
    return { folder, file };
}

test("remap-load describes a 4K rice map with its dan and remembers it", async () => {
    const { call, dir, calls } = await setup();
    const { file } = await songFolder(dir);
    const answer = await call("remap-load", { file });
    assert.deepEqual(answer, { ok: true, path: file, name: "Test - Synthetic jumpstream [Hard]", ok4k: true, rice: true, numeric: 13.6, label: "Delta low" });
    assert.equal(calls.analyze[0].rate, 1);
});

test("remap-load: 7K and LN maps are described but not rice; only .osu files; osu!'s map when asked", async () => {
    const { call, dir, calls } = await setup({ tosu: { beatmapPath: async () => file7k } });
    const { file: file7k } = await songFolder(dir, makeChart({ kind: "stream", keys: 7, seconds: 10 }));
    const sevenK = await call("remap-load", { current: true });
    assert.deepEqual([sevenK.ok, sevenK.ok4k, sevenK.rice, sevenK.numeric, sevenK.label], [true, false, false, null, null]);
    const lnDir = path.join(dir, "ln");
    await (await import("node:fs/promises")).mkdir(lnDir);
    const { file: lnFile } = await songFolder(lnDir, makeChart({ kind: "ln", seconds: 10 }));
    const ln = await call("remap-load", { file: lnFile });
    assert.deepEqual([ln.ok4k, ln.rice], [true, false]);
    assert.equal(calls.analyze.length, 0, "no dan for maps that cannot be remapped");
    assert.deepEqual(await call("remap-load", { file: path.join(dir, "a.mp3") }), { ok: false, message: t("app.remap.needOsu") });
    for (const bad of [null, {}, { file: 5 }, { file: "relative/map.osu" }]) assert.equal((await call("remap-load", bad)).ok, false, JSON.stringify(bad));
    assert.equal((await call("remap-load", { file: path.join(dir, "missing.osu") })).ok, false);
});

test("remap-create only takes a map remap-load returned, and checks the range and seed", async () => {
    const { call, dir, calls } = await setup();
    const { file } = await songFolder(dir);
    assert.deepEqual(await call("remap-create", { path: file, range: { lo: 11.5, hi: 12.5 }, seed: 1 }), { ok: false, message: t("app.remap.unknownMap") });
    await call("remap-load", { file });
    for (const [req, what] of [[{ path: file, range: { lo: 3, hi: 2 }, seed: 1 }, "range"], [{ path: file, range: null, seed: 1 }, "range"],
        [{ path: file, range: { lo: 1, hi: 2 }, seed: 1.5 }, "seed"], [null, "request"]]) {
        assert.equal((await call("remap-create", req)).message, t("app.gen.badRequest", { what }), JSON.stringify(req));
    }
    assert.equal(calls.remap.length, 0);
    assert.deepEqual(await call("remap-create", { path: file, range: { lo: 11.5, hi: 12.5 }, seed: 1 }), { ok: false, message: "no remap here" });
    assert.equal(calls.remap[0].osuText, await readFile(file, "utf8"));
});

test("remap-create writes the new difficulty next to the original and never overwrites", async () => {
    const remapped = (osuText) => ({
        kind: "remapped", osuText: osuText.replace("Version:Hard", "Version:Hard (Beta mid remap)"), version: "Hard (Beta mid remap)",
        result: { kind: "ok", label: "Beta mid", numeric: 12.04 }, reachable: true, removed: 120, added: 0,
    });
    const seen = [];
    const { call, dir } = await setup({ generatorClient: { remap: async (payload, onProgress) => { seen.push(payload); onProgress?.({ phase: "search", i: 1, n: 2 }); return remapped(payload.osuText); } } });
    const { folder, file } = await songFolder(dir);
    const original = await readFile(file, "utf8");
    await call("remap-load", { file });
    const a = await call("remap-create", { path: file, range: { lo: 11.5, hi: 12.5 }, seed: 3 });
    assert.deepEqual(a, {
        ok: true, file: path.join(folder, "Test - Synthetic jumpstream (Test) [Hard (Beta mid remap)].osu"), version: "Hard (Beta mid remap)",
        numeric: 12.04, label: "Beta mid", reachable: true, removed: 120, added: 0,
    });
    assert.deepEqual(seen[0].range, { lo: 11.5, hi: 12.5 });
    assert.equal(seen[0].seed, 3);
    const b = await call("remap-create", { path: file, range: { lo: 11.5, hi: 12.5 }, seed: 3 });
    assert.equal(b.version, "Hard (Beta mid remap) 2");
    assert.equal(readMeta(await readFile(b.file, "utf8")).version, "Hard (Beta mid remap) 2");
    assert.equal(await readFile(file, "utf8"), original, "the original is untouched");
    assert.equal((await readdir(folder)).length, 3);
});

test("remap-create refuses a map that is not rice, even if it was loaded", async () => {
    const { call, dir, calls } = await setup();
    const { file } = await songFolder(dir, makeChart({ kind: "ln", seconds: 10 }));
    await call("remap-load", { file });
    assert.deepEqual(await call("remap-create", { path: file, range: { lo: 1, hi: 2 }, seed: 1 }), { ok: false, message: t("app.remap.notRice") });
    assert.equal(calls.remap.length, 0);
});

test("registering calls nothing", () => {
    let touched = 0;
    const trap = new Proxy({}, { get: () => { touched += 1; return () => {}; } });
    registerExportIpc({ ipcMain: { handle() {}, on() {} }, generatedStore: trap, paths: trap, analysis: trap, ffmpegPath: trap, renderPng: trap, tosu: trap, generatorClient: trap, log: () => { touched += 1; } });
    assert.equal(touched, 0);
});
