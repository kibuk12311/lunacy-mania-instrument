// osu! lazer through tosu v4.26.3: what its v2 payloads look like (tests/fixtures/tosu-v2-lazer.json, shaped after
// tosu's buildResultV2.ts / buildResultV2Precise.ts / memory/lazer.ts), the map read from lazer's hashed file store
// and never written there, rate copies and remaps handed back as an .osz without online ids, and the collection note.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFrame, beatmapOf, fetchSongsFolder, clientOf } from "../app/tosuClient.js";
import { readPlayFrame, readPreciseFrame } from "../src/overlay/tosuData.js";
import { createOverlaySession } from "../src/overlay/session.js";
import { backgroundName, copyLazerMap, createLazerRates, lazerSafe, packLazerOsz } from "../app/lazerMaps.js";
import { createRateMap } from "../app/rateCreate.js";
import { createRateHandlers } from "../app/rateIpc.js";
import { registerExportIpc } from "../app/exportIpc.js";
import { registerMarathonIpc } from "../app/marathonIpc.js";
import { createFavHandlers, mapList } from "../app/recFavIpc.js";
import { createRecStore } from "../app/recStore.js";
import { rateForDan } from "../src/rate/rateForDan.js";
import { makeChart } from "./fixtures/makeChart.js";
import { readOsz } from "./fixtures/readOsz.js";
import { setLang, t } from "../src/i18n/i18n.js";

const frames = JSON.parse(await readFile(new URL("./fixtures/tosu-v2-lazer.json", import.meta.url), "utf8"));
const temp = (name) => mkdtemp(path.join(tmpdir(), `${name}-`));
const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;

// ---- tosu payloads ----

test("lazer frames: the client is named, its own speeds (Rate Adjust, DT at 1.2) are the rate", () => {
    const select = parseFrame(frames.songSelectRateAdjust);
    assert.equal(select.client, "lazer");
    assert.equal(select.state, "songselect");
    assert.equal(select.rate, 1.35);
    assert.deepEqual(select.mods, ["RA"]);
    const play = parseFrame(frames.playingDT12);
    assert.equal(play.state, "playing");
    assert.equal(play.rate, 1.2, "not DT's stable 1.5");
    // a float speed read from memory is kept to 0.01
    assert.equal(parseFrame({ play: { mods: { array: [{ acronym: "RA" }], rate: 1.3500000238 } } }).rate, 1.35);
    assert.equal(clientOf({ client: "stable" }), "stable");
    assert.equal(clientOf({ error: "not_ready" }), null);
});

test("lazer overlay frames: judgements, accuracy and UR as on stable; results fall back to the score shown", () => {
    const f = readPlayFrame(frames.playingDT12);
    assert.equal(f.client, "lazer");
    assert.equal(f.mode, 3);
    assert.equal(f.rate, 1.2);
    assert.equal(f.liveMs, 12345);
    assert.deepEqual(f.hits, { max: 300, n300: 40, n200: 10, n100: 3, n50: 1, miss: 2 });
    assert.equal(f.accuracy, 97.81);
    assert.equal(f.ur, 88.4);
    const r = readPlayFrame(frames.resultsAfterPlay);
    assert.equal(r.state, "results");
    assert.deepEqual(r.hits, { max: 512, n300: 41, n200: 11, n100: 3, n50: 1, miss: 2 });
    assert.equal(r.accuracy, 98.12, "the results screen's accuracy, not the emptied play's 100");
    assert.equal(r.rate, 1.2);
});

test("lazer precise frames: tosu sends the play's key counters (no clock); in 4K they are the four lanes", () => {
    const p = readPreciseFrame(frames.precise);
    assert.equal(p.timeMs, null, "tosu v4.26.3 sends keys, hitErrors and tourney only");
    assert.deepEqual(p.keys.map((k) => k.count), [101, 99, 120, 87]);
    // the session puts those presses at the play's own clock
    const s = createOverlaySession();
    s.onFrame(readPlayFrame({ ...frames.playingDT12, play: { ...frames.playingDT12.play, hits: {} } }), 0);
    s.onPrecise(p, 10);
    const keys = (counts, pressed = [false, false, false, false]) => ({ timeMs: null, keys: counts.map((count, i) => ({ count, pressed: pressed[i] })) });
    s.onPrecise(keys([102, 99, 121, 87]), 40);
    s.onPrecise(keys([102, 100, 121, 88], [false, true, false, false]), 70);
    const snap = s.snapshot(70);
    assert.equal(snap.lanes.source, "keys");
    assert.deepEqual(snap.lanes.counts, [1, 1, 1, 1]);
    assert.ok(snap.kps.max > 0);
    assert.equal(snap.lanes.pressed[1], true, "the held key is lit");
});

test("the selected map on lazer: hashed files in lazer's file store; stable keeps its Songs paths", () => {
    const lazer = beatmapOf(frames.jsonV2);
    assert.equal(lazer.client, "lazer");
    assert.equal(lazer.path, String.raw`C:\Users\me\AppData\Roaming\osu\files\1\1a\1a2b3c4d5e6f`);
    assert.equal(lazer.audioPath, String.raw`C:\Users\me\AppData\Roaming\osu\files\f\f0\f0e1d2c3b4a5`);
    assert.equal(lazer.backgroundPath, String.raw`C:\Users\me\AppData\Roaming\osu\files\b\b9\b9c8d7e6f5a4`);
    const stable = beatmapOf(frames.jsonV2Stable);
    assert.equal(stable.client, "stable");
    assert.equal(stable.path, String.raw`C:\osu!\Songs\123 A - T\A - T (M) [Hard].osu`);
    assert.equal(stable.audioPath, String.raw`C:\osu!\Songs\123 A - T\audio.mp3`);
    // an older tosu without `client` is stable, as before
    assert.equal(beatmapOf({ ...frames.jsonV2Stable, client: undefined }).client, "stable");
    setLang("ru");
    assert.throws(() => beatmapOf({ ...frames.jsonV2, files: { beatmap: "" }, directPath: { beatmapFile: "" } }), /не выбрана карта/);
});

test("lazer has no Songs folder to look for local sets in", async () => {
    const answer = (json) => async () => ({ ok: true, json: async () => json });
    assert.equal(await fetchSongsFolder(1, { fetchImpl: answer(frames.jsonV2) }), null);
    assert.equal(await fetchSongsFolder(1, { fetchImpl: answer(frames.jsonV2Stable) }), String.raw`C:\osu!\Songs`);
});

// ---- the map copied out of lazer, and what goes back ----

const CHART = makeChart({ kind: "jumpstream", bpm: 180, seconds: 8 })
    .replace(/\[Metadata\]\r?\n/, "[Metadata]\nBeatmapID:777\nBeatmapSetID:555\n")
    .replace("[TimingPoints]", "[Events]\n0,0,\"bg.jpg\",0,0\n\n[TimingPoints]");

// a fake lazer data folder: files/<a>/<ab>/<hash>, as tosu reports them
async function fakeStore() {
    const root = await temp("lazer-store");
    const put = async (hash, data) => {
        const dir = path.join(root, "files", hash[0], hash.slice(0, 2));
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, hash), data);
        return path.join(dir, hash);
    };
    const source = {
        client: "lazer",
        path: await put("1a2b3c", CHART),
        audioPath: await put("f0e1d2", Buffer.from("ID3 fake mp3")),
        backgroundPath: await put("b9c8d7", Buffer.from("fake jpg")),
    };
    return { root, source };
}

async function listing(dir) {
    const out = [];
    for (const name of await readdir(dir, { recursive: true })) {
        const s = await stat(path.join(dir, name));
        if (s.isFile()) out.push(`${name} ${s.size} ${s.mtimeMs}`);
    }
    return out.sort();
}

test("background names and lazer-safe charts: no online ids left to collide with the original set", () => {
    assert.equal(backgroundName('0,0,"my bg.jpg",0,0'), "my bg.jpg");
    assert.equal(backgroundName("0,0,bg.png,0,0"), "bg.png");
    assert.equal(backgroundName("[Events]\n//nothing"), null);
    const safe = lazerSafe(CHART);
    assert.equal(field(safe, "BeatmapSetID"), "-1");
    assert.equal(field(safe, "BeatmapID"), "0");
    const added = lazerSafe(makeChart({ seconds: 2 }));
    assert.equal(field(added, "BeatmapSetID"), "-1", "added when the chart had none");
});

test("a lazer map is copied out under its own names; the store is only read", async () => {
    const { root, source } = await fakeStore();
    const before = await listing(root);
    const docs = await temp("docs");
    const local = await copyLazerMap({ source, osuText: CHART, root: path.join(docs, "lazer") });
    assert.equal(path.basename(local.dir), "555 Test - Synthetic jumpstream");
    assert.equal(path.basename(local.path), "Test - Synthetic jumpstream (Test) [jumpstream 180].osu");
    assert.deepEqual((await readdir(local.dir)).sort(), ["Test - Synthetic jumpstream (Test) [jumpstream 180].osu", "audio.mp3", "bg.jpg"].sort());
    assert.equal(await readFile(path.join(local.dir, "audio.mp3"), "utf8"), "ID3 fake mp3");
    // a second copy keeps what is there
    await copyLazerMap({ source, osuText: CHART, root: path.join(docs, "lazer") });
    assert.deepEqual(await listing(root), before, "nothing in lazer's store changed");
    // a map whose audio lazer does not have is refused, not copied half
    setLang("en");
    await assert.rejects(copyLazerMap({ source: { ...source, audioPath: null }, osuText: CHART, root: path.join(docs, "lazer2") }), new RegExp(t("app.lazer.noAudio")));
    setLang("ru");
});

test("rate copies for lazer: made from the copy, one .osz with each chart (no online ids), its audio and background", async () => {
    const { root, source } = await fakeStore();
    const before = await listing(root);
    const docs = await temp("docs");
    const outDir = path.join(docs, "карты");
    const seen = [];
    // ×1.0 is real (createRateMap uses the map's own audio, no ffmpeg); ×1.2 is a fake copy with its own audio file
    const makeCopy = async (req) => {
        if (req.rate === 1) return createRateMap(req);
        const dir = path.dirname(req.beatmapPath);
        const osuPath = path.join(dir, `copy ${req.rate}.osu`);
        const osuText = CHART.replace("AudioFilename: audio.mp3", "AudioFilename: audio 1.2x.mp3").replace("Version:jumpstream 180", "Version:jumpstream 180 1.2x");
        await writeFile(osuPath, osuText);
        await writeFile(path.join(dir, "audio 1.2x.mp3"), "fast audio");
        return { osuPath, osuText, version: "jumpstream 180 1.2x", reusedAudio: false };
    };
    const out = await createLazerRates({
        ffmpeg: "ffmpeg.exe", source, osuText: CHART, rates: [1, 1.2], options: { pitch: false, od: null, hp: null, mirror: false, noLn: false },
        lazerDir: path.join(docs, "lazer"), outDir, makeCopy, onRate: (p) => seen.push(p.rate),
    });
    assert.deepEqual(seen, [1, 1.2]);
    assert.deepEqual(out.made.map((m) => m.rate), [1, 1.2]);
    assert.deepEqual(out.failed, []);
    assert.equal(path.dirname(out.file), outDir);
    assert.match(path.basename(out.file), /^Test - Synthetic jumpstream \[jumpstream 180\] 1x 1\.2x\.osz$/);
    const files = readOsz(await readFile(out.file));
    const names = [...files.keys()].sort();
    assert.deepEqual(names, ["Test - Synthetic jumpstream (Test) [jumpstream 180 1x (180bpm)].osu", "audio 1.2x.mp3", "audio.mp3", "bg.jpg", "copy 1.2.osu"].sort());
    for (const name of names.filter((n) => n.endsWith(".osu"))) {
        const text = files.get(name).toString("utf8");
        assert.equal(field(text, "BeatmapSetID"), "-1", name);
        assert.equal(field(text, "BeatmapID"), "0", name);
    }
    assert.equal(files.get("audio 1.2x.mp3").toString(), "fast audio");
    assert.deepEqual(await listing(root), before, "nothing written into lazer's store");
    // a second run never overwrites the first .osz
    const again = await createLazerRates({
        ffmpeg: "ffmpeg.exe", source, osuText: CHART, rates: [1], options: {}, lazerDir: path.join(docs, "lazer"), outDir, makeCopy,
    });
    assert.notEqual(again.file, out.file);
    // every rate failing: no .osz at all
    const none = await createLazerRates({
        ffmpeg: "x", source, osuText: CHART, rates: [1.3], options: {}, lazerDir: path.join(docs, "lazer"), outDir,
        makeCopy: async () => { throw new Error("ffmpeg broke"); },
    });
    assert.equal(none.file, null);
    assert.deepEqual(none.failed, [{ rate: 1.3, message: "ffmpeg broke" }]);
});

test("packLazerOsz takes only the files the charts name, from their folder", async () => {
    const dir = await temp("set");
    await writeFile(path.join(dir, "audio.mp3"), "a");
    await writeFile(path.join(dir, "bg.jpg"), "b");
    await writeFile(path.join(dir, "secret.txt"), "c");
    const chart = CHART.replace("bg.jpg", "../bg.jpg");
    const file = await packLazerOsz({ charts: [{ name: "x.osu", osuText: chart }], dir, outDir: dir, baseName: "pack" });
    assert.deepEqual([...readOsz(await readFile(file)).keys()].sort(), ["audio.mp3", "x.osu"], "no path tricks, nothing unnamed");
});

// ---- the rate tab on lazer ----

function rateHandlers({ client }) {
    const seen = { stableCopies: 0, lazer: [], opened: [], progress: [] };
    const handlers = createRateHandlers({
        beatmapPath: async () => "unused",
        beatmap: async () => ({ client, path: client === "lazer" ? "C:/lazer/files/1/1a/1a2b" : "C:/Songs/1 A/A.osu", audioPath: "a", backgroundPath: null }),
        readText: async () => CHART,
        stat: async () => ({ mtimeMs: 1 }),
        analysis: { analyze: async () => ({ kind: "ok" }), analyzeQueued: async () => ({ kind: "ok" }) },
        createRateMap: async (req) => { seen.stableCopies += 1; return { osuPath: `${req.rate}.osu`, version: `v ${req.rate}`, reusedAudio: true }; },
        ffmpegPath: async () => "ffmpeg.exe",
        presets: { get: async () => [], set: async (v) => v },
        progress: (p) => seen.progress.push(p),
        log: () => {},
        rateForDan,
        lazerRates: async (args) => {
            seen.lazer.push(args);
            args.rates.forEach((rate, i) => args.onRate({ index: i + 1, total: args.rates.length, rate }));
            return { file: "C:/docs/карты/x.osz", made: args.rates.map((rate) => ({ rate, version: `v ${rate}` })), failed: [], cancelled: false };
        },
        openPath: async (file) => { seen.opened.push(file); return ""; },
    });
    return { handlers, seen };
}

test("rate tab on lazer: info names the client; a copy becomes an .osz that is opened, nothing goes next to the map", async () => {
    const { handlers, seen } = rateHandlers({ client: "lazer" });
    assert.equal((await handlers.info()).client, "lazer");
    const one = await handlers.create({ rate: 1.25, pitch: true, od: "", hp: 7 });
    assert.deepEqual(one, { ok: true, version: "v 1.25", file: "C:/docs/карты/x.osz", client: "lazer", opened: true });
    assert.equal(seen.stableCopies, 0);
    assert.deepEqual(seen.lazer[0].rates, [1.25]);
    assert.deepEqual(seen.lazer[0].options, { pitch: true, od: null, hp: 7, mirror: false, noLn: false });
    const batch = await handlers.batchCreate({ rates: [1.1, 1.2] });
    assert.equal(batch.client, "lazer");
    assert.equal(batch.osz, "C:/docs/карты/x.osz");
    assert.equal(batch.opened, true);
    assert.deepEqual(batch.made.map((m) => m.rate), [1.1, 1.2]);
    assert.deepEqual(seen.progress.map((p) => [p.job, p.index, p.rate]), [["create", 1, 1.1], ["create", 2, 1.2]]);
    assert.deepEqual(seen.opened, ["C:/docs/карты/x.osz", "C:/docs/карты/x.osz"]);
    assert.equal(seen.stableCopies, 0);
});

test("rate tab on stable is unchanged: copies next to the map, no .osz", async () => {
    const { handlers, seen } = rateHandlers({ client: "stable" });
    assert.equal((await handlers.info()).client, "stable");
    const r = await handlers.create({ rate: 1.25 });
    assert.equal(r.ok, true);
    assert.equal(r.client, undefined);
    assert.equal(seen.stableCopies, 1);
    assert.deepEqual(seen.lazer, []);
    assert.deepEqual(seen.opened, []);
});

// ---- favourites: collection.db and lazer ----

test("collection export with lazer connected: collection.db for stable, a list of the maps for lazer, and the answer says so", async () => {
    const docs = await temp("docs");
    const store = createRecStore({ dir: await temp("user") });
    const osu = (id) => Buffer.from(`osu file format v14\n[Metadata]\nBeatmapID:${id}\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n`, "utf8");
    let client = "lazer";
    const handlers = createFavHandlers({ store, docsDir: () => docs, fetchBytes: async (url) => osu(Number(url.split("/").pop())), client: () => client });
    await handlers.add({ card: { beatmapId: 11, beatmapsetId: 22, artist: "A", title: "T", version: "4K Hard", creator: "C", dan: 12 } });
    const r = await handlers.exportDb({ name: "Мои карты" });
    assert.equal(r.ok, true);
    assert.equal(r.client, "lazer");
    assert.equal(path.basename(r.file), "collection.db");
    assert.equal(path.basename(r.list), "Мои карты.txt");
    const list = await readFile(r.list, "utf8");
    assert.match(list, /^Мои карты\r\n\r\nA - T \[4K Hard\] — https:\/\/osu\.ppy\.sh\/beatmapsets\/22#mania\/11\r\n$/);
    assert.equal(mapList("x", []), "x\r\n\r\n");
    client = "stable";
    const s = await handlers.exportDb({ name: "Other" });
    assert.equal(s.client, undefined);
    assert.equal(s.list, undefined);
    // the window's note for lazer exists in both languages
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        assert.ok(t("recommend.fav.lazerNote", { list: "L" }).includes("collection.db"));
        assert.ok(t("recommend.fav.lazerNote", { list: "L" }).includes("L"));
    }
    setLang("ru");
});

// ---- remap on lazer ----

test("remap on lazer: the map selected in lazer is copied out, the new difficulty goes back as an .osz that is opened", async () => {
    const { root, source } = await fakeStore();
    const before = await listing(root);
    const docs = await temp("docs");
    const mapsDir = path.join(docs, "карты");
    const handlers = {};
    const opened = [];
    registerExportIpc({
        ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { handlers[c] = fn; } },
        generatedStore: {}, paths: { docsDir: docs, mapsDir }, log: () => {},
        analysis: { analyze: async () => ({ kind: "ok", label: "Delta low", numeric: 13.6 }) },
        tosu: { beatmapPath: async () => source.path, beatmap: async () => source },
        shell: { openPath: async (file) => { opened.push(file); return ""; } },
        generatorClient: { remap: async ({ osuText }) => ({
            kind: "remapped", osuText: osuText.replace("Version:jumpstream 180", "Version:remap"), version: "remap",
            result: { kind: "ok", label: "Beta mid", numeric: 12.04 }, reachable: true, removed: 10, added: 0,
        }) },
    });
    const loaded = await handlers["remap-load"]({}, { current: true });
    assert.equal(loaded.ok, true, loaded.message);
    assert.ok(loaded.path.startsWith(path.join(docs, "lazer")), loaded.path);
    const made = await handlers["remap-create"]({}, { path: loaded.path, range: { lo: 11.5, hi: 12.5 }, seed: 1 });
    assert.equal(made.ok, true, made.message);
    assert.equal(made.client, "lazer");
    assert.equal(made.opened, true);
    assert.deepEqual(opened, [made.osz]);
    assert.equal(path.dirname(made.osz), mapsDir);
    const files = readOsz(await readFile(made.osz));
    assert.deepEqual([...files.keys()].sort(), ["Test - Synthetic jumpstream (Test) [remap].osu", "audio.mp3", "bg.jpg"].sort());
    assert.equal(field(files.get("Test - Synthetic jumpstream (Test) [remap].osu").toString(), "BeatmapSetID"), "-1");
    assert.deepEqual(await listing(root), before, "nothing written into lazer's store");
});

test("marathon on lazer: «+ selected in osu!» adds the copy of the map, so its audio is found by name", async () => {
    const { root, source } = await fakeStore();
    const docs = await temp("docs");
    const handlers = {};
    registerMarathonIpc({
        ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { handlers[c] = fn; } },
        tosu: { port: 1, beatmapPath: async () => source.path, beatmap: async () => source },
        analysis: {}, ffmpegPath: async () => "", renderPng: async () => Buffer.alloc(0),
        paths: { docsDir: docs, mapsDir: path.join(docs, "карты"), downloadsDir: path.join(docs, "скачанные") },
        log: () => {}, send: () => {}, trackerApi: {}, recommender: {}, downloader: {}, profile: {},
    });
    const added = await handlers["marathon-add-current"]({});
    assert.equal(added.ok, true, added.message);
    assert.equal(added.ok4k, true);
    assert.ok(added.path.startsWith(path.join(docs, "lazer")), added.path);
    assert.ok((await readdir(path.dirname(added.path))).includes("audio.mp3"));
    assert.ok(!added.path.startsWith(root));
});
