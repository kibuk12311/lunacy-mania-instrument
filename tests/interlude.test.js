// Interlude: the chart format and its id (src/interlude/chart.js), collections.json (src/interlude/collections.js),
// the library read from copies of charts.db / scores.db (app/interludeLibrary.js), the folder, selection, sending and
// playlists (app/interludeClient.js, app/interludeIpc.js), the card showing an Interlude chart (selectionController)
// and Interlude's plays in the picks (recommend.js). Every Interlude folder here is a temp fixture
// (tests/fixtures/interludeFolder.js) with synthetic charts; nothing is ever written into it but collections.json.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    NOTE, roundEven, decodeChart, encodeChart, chartHash, osuToChart, osuChartHash, chartToOsu, readOsu, osuMd5,
} from "../src/interlude/chart.js";
import { addCollection, parseCollections, playlistRate, uniqueName, emptyCollections, cleanName } from "../src/interlude/collections.js";
import { createInterludeLibrary, interludeFolderOf, assetPath, osuOrigins, audioExt, folderCandidates, detectFolder } from "../app/interludeLibrary.js";
import { createInterludeClient, sendPipe } from "../app/interludeClient.js";
import { createInterludeHandlers, sendable, exportItem } from "../app/interludeIpc.js";
import { createSelectionController } from "../app/selectionController.js";
import { createRecommender } from "../src/recommend/recommend.js";
import { makeChart } from "./fixtures/makeChart.js";
import { makeInterludeFolder } from "./fixtures/interludeFolder.js";
import { readOsz } from "./fixtures/readOsz.js";
import { setLang } from "../src/i18n/i18n.js";

const temp = (name) => mkdtemp(path.join(tmpdir(), `${name}-`));

// A 4K chart with holds Interlude takes (makeChart's "ln" starts notes inside holds, which Interlude refuses):
// a note per 1/4 beat round the columns, every other one a hold over the next step.
function holdsChart({ seconds = 30, bpm = 160 } = {}) {
    const step = 60000 / bpm / 4;
    const lines = [];
    for (let i = 0; i * step < seconds * 1000; i += 1) {
        const time = Math.round(1000 + i * step);
        const x = Math.floor(((i % 4 + 0.5) * 512) / 4);
        lines.push(i % 2 ? `${x},192,${time},128,0,${Math.round(time + step * 2)}:0:0:0:0:` : `${x},192,${time},1,0,0:0:0:0:`);
    }
    return makeChart({ kind: "stream", seconds: 1, bpm }).replace(/\[HitObjects\][\s\S]*$/, `[HitObjects]\n${lines.join("\n")}\n`)
        .replace(/^Title:.*$/m, "Title:Synthetic holds");
}
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG"), Buffer.alloc(32, 1)]);

// every file under dir with its size and time, to show a folder was not written to
async function snapshotDir(dir) {
    const out = {};
    const walk = async (d) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else {
                const s = await stat(p);
                out[path.relative(dir, p)] = `${s.size}|${s.mtimeMs}`;
            }
        }
    };
    await walk(dir);
    return out;
}

// ---- the chart format ----

test("roundEven rounds halves to even like .NET", () => {
    assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundEven), [0, 2, 2, -0, -2, 2, 3]);
});

test("a chart's id is SHA-256 over keys, note types, scroll changes and length, as Chart.Hash lays them out", () => {
    const notes = [
        { time: 1000, data: [NOTE.NORMAL, 0, 0, 0] },
        { time: 1250, data: [0, NOTE.HOLDHEAD, 0, 0] },
        { time: 1500, data: [0, NOTE.HOLDTAIL, NOTE.NORMAL, 0] },
    ];
    const sv = [{ time: 1000, data: 1 }, { time: 1100, data: Math.fround(0.5) }, { time: 1200, data: Math.fround(0.5) }];
    // the bytes written by hand: int32 keys, a byte per column per row, one (int32 time×0.2, double speed) per change
    const b = [];
    const i32 = (v) => { const x = Buffer.alloc(4); x.writeInt32LE(v); b.push(x); };
    i32(4);
    b.push(Buffer.from([1, 0, 0, 0, 0, 2, 0, 0, 0, 4, 1, 0]));
    i32(20); // (1100 - 1000) × 0.2
    const d = Buffer.alloc(8);
    d.writeDoubleLE(0.5);
    b.push(d);
    i32(5); // (1500 - 1000) × 0.01
    const expected = createHash("sha256").update(Buffer.concat(b)).digest("hex").toUpperCase();
    assert.equal(chartHash({ keys: 4, notes, sv }), expected);
});

test("charts.db's chart blob decodes to rows, BPMs and scroll speeds, and encodes back to the same bytes", () => {
    const chart = osuToChart(holdsChart({ seconds: 20 }));
    assert.ok(chart.notes.some((r) => r.data.includes(NOTE.HOLDBODY)), "hold bodies are rows of their own");
    const blob = encodeChart(chart);
    const back = decodeChart(blob, 4);
    assert.deepEqual(back.notes, chart.notes);
    assert.deepEqual(back.bpm, chart.bpm);
    assert.equal(chartHash(back), chartHash(chart));
    assert.ok(encodeChart(back).equals(blob));
    // broken data is refused, not half read
    assert.throws(() => decodeChart(blob.subarray(0, blob.length - 3), 4));
    assert.throws(() => decodeChart(blob, 2));
});

test("osu! → Interlude: columns, hold bodies and tails, a tail at the time of another note, stacked notes merged", () => {
    const keys = 4;
    const x = (k) => Math.floor(((k + 0.5) * 512) / keys);
    const lines = [];
    for (let i = 0; i < 20; i += 1) lines.push(`${x(i % 4)},192,${1000 + i * 100},1,0,0:0:0:0:`);
    lines.push(`${x(0)},192,3500,128,0,3800:0:0:0:0:`, `${x(1)},192,3800,1,0,0:0:0:0:`, `${x(1)},192,3800,1,0,0:0:0:0:`);
    const text = `osu file format v14\n[General]\nMode: 3\n[Difficulty]\nCircleSize:4\n[TimingPoints]\n0,500,4,2,0,30,1,0\n[HitObjects]\n${lines.join("\n")}\n`;
    const chart = osuToChart(text);
    assert.equal(chart.notes.length, 22);
    const head = chart.notes.find((r) => r.time === 3500);
    const tail = chart.notes.find((r) => r.time === 3800);
    assert.deepEqual(head.data, [NOTE.HOLDHEAD, 0, 0, 0]);
    assert.deepEqual(tail.data, [NOTE.HOLDTAIL, NOTE.NORMAL, 0, 0]);
    // a single BPM: no scroll change at all
    assert.deepEqual(chart.sv, []);
    // fewer than 20 notes, not mania, a green line first: Interlude skips those
    assert.equal(osuChartHash(text.replace(/\n\d+,192,1\d00,1,0,0:0:0:0:/g, "")), null);
    assert.equal(osuChartHash(text.replace("Mode: 3", "Mode: 0")), null);
    assert.equal(osuChartHash(text.replace("0,500,4,2,0,30,1,0", "0,-100,4,2,0,30,0,0")), null);
});

test("BPM changes become scroll speeds against the most common BPM, and green lines multiply them", () => {
    const base = makeChart({ kind: "stream", seconds: 30, bpm: 200 });
    const text = base.replace(/\[TimingPoints\][^[]*/, "[TimingPoints]\n1000,300,4,2,0,30,1,0\n5000,600,4,2,0,30,1,0\n6000,-50,4,2,0,30,0,0\n\n\n");
    const chart = osuToChart(text);
    assert.deepEqual(chart.bpm.map((b) => [b.time, b.data.msPerBeat]), [[1000, 300], [5000, 600]]);
    // 600 ms is held longest (5 s to the end): speed 2 at 300 ms, 1 at 600 ms, then ×2 by the green line
    assert.deepEqual(chart.sv.map((s) => [s.time, s.data]), [[1000, 2], [5000, 1], [6000, 2]]);
});

test("a chart made into an .osu converts back to the same chart (same id), holds and speeds included", () => {
    for (const kind of ["stream", "holds", "jack"]) {
        const base = kind === "holds" ? holdsChart({ seconds: 25, bpm: 170 }) : makeChart({ kind, seconds: 25, bpm: 170 });
        const text = base.replace(/\[TimingPoints\][^[]*/, "[TimingPoints]\n1000,352.941176470588,4,2,0,30,1,0\n4000,-80,4,2,0,30,0,0\n9000,250,4,2,0,30,1,0\n\n\n");
        const chart = osuToChart(text);
        const osu = chartToOsu(chart, { title: "T", artist: "A", creator: "C", version: "V", audio: "audio.ogg", background: "bg.png", od: 7.5 });
        assert.equal(osuChartHash(osu), chartHash(chart), kind);
        assert.match(osu, /^AudioFilename: audio\.ogg$/m);
        assert.match(osu, /^0,0,"bg\.png",0,0$/m);
        assert.match(osu, /^OverallDifficulty:7\.5$/m);
        assert.match(osu, /^BeatmapSetID:-1$/m);
        assert.equal(readOsu(osu).keys, 4);
    }
});

test("an .osu's MD5 is lower-case hex of its bytes (Interlude's osu! origin)", () => {
    assert.equal(osuMd5(Buffer.from("abc")), "900150983cd24fb0d6963f7d28e17f72");
});

// ---- collections.json ----

test("collections.json: a playlist and a folder added under names of their own, nothing there changed", () => {
    const before = { Folders: { Mine: { Charts: [{ Hash: "A".repeat(64) }], Icon: "x" } }, Playlists: { Dan: { Charts: [], Icon: "" } }, Likes: ["B".repeat(64)], Extra: 1 };
    const data = parseCollections(JSON.stringify(before));
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    const p = addCollection(data, { kind: "playlist", name: "Dan", entries: [{ hash: h1, rate: 1.234 }, { hash: h2, rate: 9 }, { hash: h1, rate: 0.1 }, { hash: "bad" }] });
    assert.equal(p.name, "Dan (2)");
    assert.equal(p.count, 3);
    assert.deepEqual(data.Playlists["Dan (2)"].Charts, [
        [{ Hash: h1 }, { Mods: {}, Rate: 1.23 }], [{ Hash: h2 }, { Mods: {}, Rate: 3 }], [{ Hash: h1 }, { Mods: {}, Rate: 0.5 }],
    ]);
    const f = addCollection(data, { kind: "folder", name: "Mine", entries: [{ hash: h1 }, { hash: h1 }, { hash: h2 }] });
    assert.equal(f.name, "Mine (2)");
    assert.deepEqual(data.Folders["Mine (2)"], { Charts: [{ Hash: h1 }, { Hash: h2 }], Icon: "" });
    // what was there stays as it was
    assert.deepEqual(data.Folders.Mine, before.Folders.Mine);
    assert.deepEqual(data.Playlists.Dan, before.Playlists.Dan);
    assert.deepEqual(data.Likes, before.Likes);
    assert.equal(data.Extra, 1);
    assert.throws(() => addCollection(data, { kind: "playlist", name: "x", entries: [] }));
});

test("collections.json that Interlude could not read either is refused; names and rates are cleaned", () => {
    assert.throws(() => parseCollections("{"));
    assert.throws(() => parseCollections("[]"));
    assert.throws(() => parseCollections(JSON.stringify({ Folders: [] })));
    assert.deepEqual(parseCollections("\uFEFF{}"), emptyCollections());
    assert.equal(uniqueName({ Folders: { a: 1 }, Playlists: { "a (2)": 1 } }, "a"), "a (3)");
    assert.equal(cleanName("  \u0001  "), "Lunacy mania");
    assert.equal(cleanName("x".repeat(80)).length, 64);
    assert.equal(playlistRate("nope"), 1);
});

// ---- the library ----

async function library2() {
    const a = makeChart({ kind: "stream", seconds: 30 });
    const b = holdsChart({ seconds: 30, bpm: 150 });
    const seven = makeChart({ kind: "stream", seconds: 30, keys: 7 });
    const fx = await makeInterludeFolder({
        charts: [
            { osuText: a, title: "Freedom Dive", artist: "xi", version: "4K Another", beatmapId: 111, beatmapsetId: 11, audio: MP3, background: PNG },
            { osuText: b, title: "Blue Zenith", artist: "xi", version: "Hyper", beatmapId: 222, beatmapsetId: 22, audio: MP3, keepOriginal: true },
            { osuText: seven, title: "Seven", artist: "Other", version: "7K", beatmapId: 333, beatmapsetId: 33 },
        ],
        plays: [{ index: 0, at: 1_700_000_100_000, rate: 1.1 }, { index: 0, at: 1_700_000_200_000 }],
    });
    return { fx, texts: [a, b, seven] };
}

test("the folder: picked as the folder, Interlude.exe, or its Songs / Data folder; nothing else counts", async () => {
    const { fx } = await library2();
    assert.equal(await interludeFolderOf(fx.root), fx.root);
    assert.equal(await interludeFolderOf(path.join(fx.root, "Interlude.exe")), fx.root);
    assert.equal(await interludeFolderOf(path.join(fx.root, "Songs")), fx.root);
    assert.equal(await interludeFolderOf(path.join(fx.root, "Data")), fx.root);
    assert.equal(await interludeFolderOf(tmpdir()), null);
    assert.equal(await interludeFolderOf("relative\\path"), null);
    assert.equal(await detectFolder([path.join(tmpdir(), "nope-interlude"), fx.root]), fx.root);
    const list = folderCandidates({ home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
    assert.ok(list.includes(path.join("C:\\Users\\me", "Desktop", "Interlude")));
    assert.ok(list.includes(path.join("C:\\Users\\me\\AppData\\Local", "Interlude")));
});

test("library: search by artist / title / difficulty (4K only), read from a copy; Interlude's folder is not written", async () => {
    const { fx } = await library2();
    const before = await snapshotDir(fx.root);
    const cache = await temp("il-cache");
    const lib = createInterludeLibrary({ folder: () => fx.root, cacheDir: cache });
    const all = await lib.search("");
    assert.equal(all.total, 2, "the 7K chart is left out");
    assert.equal(all.size, 3);
    const xi = await lib.search("XI zenith");
    assert.deepEqual(xi.items.map((c) => c.title), ["Blue Zenith"]);
    assert.equal(xi.items[0].beatmapId, 222);
    assert.deepEqual((await lib.search("another")).items.map((c) => c.version), ["4K Another"]);
    assert.equal((await lib.search("nothing like it")).total, 0);
    // the copies are in the cache folder; Interlude's folder is exactly as it was (no -shm, no -wal, no change)
    assert.ok((await readdir(cache)).includes("charts.db"));
    assert.deepEqual(await snapshotDir(fx.root), before);
});

test("library: a chart as an .osu — the kept original when its id still matches, else one made from the chart", async () => {
    const { fx, texts } = await library2();
    const lib = createInterludeLibrary({ folder: () => fx.root, cacheDir: await temp("il-cache") });
    const original = await lib.osuFor(fx.charts[1].hash);
    assert.equal(original.original, true);
    assert.equal(original.text, fx.charts[1].osuText);
    assert.equal(original.audioName, "audio.mp3");
    assert.ok(original.audio.includes(path.join("Songs", ".assets")));
    const made = await lib.osuFor(fx.charts[0].hash);
    assert.equal(made.original, false);
    assert.equal(osuChartHash(made.text), fx.charts[0].hash, "the .osu made from the chart is the same chart");
    assert.equal(made.audioName, "audio.mp3", "the asset's format from its bytes");
    assert.equal(made.backgroundName, "bg.png");
    assert.match(made.text, /^Title:Freedom Dive$/m);
    assert.equal(await lib.osuFor("F".repeat(64)), null);
});

test("library: maps found by md5, by the id their .osu would get, or by beatmap id; plays from scores.db", async () => {
    const { fx, texts } = await library2();
    const lib = createInterludeLibrary({ folder: () => fx.root, cacheDir: await temp("il-cache") });
    assert.equal(await lib.find({ md5: fx.charts[0].md5.toUpperCase() }), fx.charts[0].hash);
    assert.equal(await lib.find({ osuText: fx.charts[1].osuText.replace("Title:Blue Zenith", "Title:Renamed") }), fx.charts[1].hash, "same notes, another file");
    assert.equal(await lib.find({ beatmapId: 222 }), fx.charts[1].hash);
    assert.equal(await lib.find({ md5: "0".repeat(32), beatmapId: 999 }), null);
    const played = await lib.played();
    assert.deepEqual([...played.keys()], [fx.charts[0].hash]);
    assert.equal(played.get(fx.charts[0].hash).plays, 2);
    assert.equal(played.get(fx.charts[0].hash).at, 1_700_000_200_000);
    const beatmaps = await lib.playedBeatmaps();
    assert.deepEqual([...beatmaps.entries()], [[111, { beatmapsetId: 11, accuracy: null, rate: null, playedAt: 1_700_000_200_000, interlude: true }]]);
});

test("library: rows still in charts.db-wal (Interlude running) are read too, and a change is picked up", async () => {
    const { fx } = await library2();
    const lib = createInterludeLibrary({ folder: () => fx.root, cacheDir: await temp("il-cache") });
    assert.equal((await lib.search("")).total, 2);
    // a writer keeps the database open in WAL mode, as Interlude does: the new row is only in the -wal file
    const live = new DatabaseSync(path.join(fx.root, "Songs", "charts.db"));
    try {
        live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
        const row = live.prepare("SELECT * FROM charts WHERE Title = 'Blue Zenith'").get();
        live.prepare("INSERT INTO charts SELECT ?, 'Live Import', TitleNative, Artist, ArtistNative, DifficultyName, Subtitle, Source, Creator, Tags, Background, Audio, PreviewTime, Packs, Origin, Keys, Length, BPM, DateAdded, CalcVersion, Rating, Patterns, Chart FROM charts WHERE Id = ?")
            .run("E".repeat(64), row.Id);
        assert.ok((await stat(path.join(fx.root, "Songs", "charts.db-wal"))).size > 0);
        assert.deepEqual((await lib.search("live import")).items.map((c) => c.title), ["Live Import"]);
    } finally {
        live.close();
    }
});

test("asset locations, osu! origins and audio formats as charts.db keeps them", () => {
    const h = "AB".padEnd(64, "C");
    assert.equal(assetPath("D:\\IL", JSON.stringify({ Hash: h })), path.join("D:\\IL", "Songs", ".assets", "AB", h));
    assert.equal(assetPath("D:\\IL", JSON.stringify({ Absolute: "E:\\osu\\Songs\\a\\audio.mp3" })), "E:\\osu\\Songs\\a\\audio.mp3");
    assert.equal(assetPath("D:\\IL", '"Missing"'), null);
    assert.deepEqual(osuOrigins(JSON.stringify([{ Etterna: "pack" }, { Osu: { Md5: "ABC", BeatmapId: 5, BeatmapSetId: 6, SourceRate: 1.1, SourceOD: 8 } }])),
        [{ md5: "abc", beatmapId: 5, beatmapsetId: 6, rate: 1.1, od: 8 }]);
    assert.deepEqual(osuOrigins("not json"), []);
    assert.equal(audioExt(Buffer.from("OggS....")), ".ogg");
    assert.equal(audioExt(Buffer.from([0xff, 0xfb, 0x90])), ".mp3");
    assert.equal(audioExt(Buffer.from("RIFF....")), ".wav");
});

// ---- the client: folder, selection, sending, playlists ----

function memoryStore(value = { folder: null }) {
    let v = value;
    return { get: async () => v, set: async (next) => { v = next; return v; }, now: () => v };
}

async function client(extra = {}) {
    const lib = await library2();
    const docs = await temp("il-docs");
    const store = memoryStore();
    const calls = { reveal: [], pipe: [], launch: [] };
    const c = createInterludeClient({
        store, docsDir: docs, mapsDir: path.join(docs, "карты"), cacheDir: await temp("il-cache"),
        running: async () => false, pipe: async (m) => { calls.pipe.push(m); return true; },
        launch: (exe, cwd) => calls.launch.push([exe, cwd]), reveal: (f) => calls.reveal.push(f),
        now: () => new Date(2026, 9, 26, 15, 30, 12), ...extra,
    });
    return { ...lib, c, docs, store, calls };
}

test("client: link, unlink and status; a wrong folder is refused", async () => {
    setLang("en");
    const { fx, c, store } = await client();
    assert.deepEqual(await c.status(), { linked: false, folder: null, selected: null });
    const bad = await c.link(tmpdir());
    assert.equal(bad.ok, false);
    assert.match(bad.message, /Songs\\charts\.db/);
    const ok = await c.link(path.join(fx.root, "Songs"));
    assert.equal(ok.ok, true);
    assert.equal(ok.folder, fx.root);
    assert.equal(ok.size, 3);
    assert.equal(store.now().folder, fx.root);
    await c.unlink();
    assert.equal((await c.status()).linked, false);
    setLang("ru");
});

test("client: a chart selected is copied out with its audio and becomes the tabs' map; Interlude's folder untouched", async () => {
    const { fx, c, docs } = await client();
    await c.link(fx.root);
    const before = await snapshotDir(fx.root);
    const sel = await c.select(fx.charts[0].hash);
    assert.ok(sel.path.startsWith(path.join(docs, "interlude")));
    assert.equal(await readFile(sel.path, "utf8"), sel.text);
    assert.deepEqual(await readFile(sel.audioPath), MP3);
    assert.ok(sel.backgroundPath.endsWith("bg.png"));
    assert.deepEqual(c.beatmap(), { client: "interlude", path: sel.path, audioPath: sel.audioPath, backgroundPath: sel.backgroundPath, hash: fx.charts[0].hash });
    assert.equal((await c.status()).selected, "xi - Freedom Dive [4K Another]");
    c.clearSelection();
    assert.equal(c.beatmap(), null);
    await assert.rejects(c.select("F".repeat(64)));
    assert.deepEqual(await snapshotDir(fx.root), before);
});

test("client: sending packs .osu files into one .osz, brings Interlude forward (or starts it) and shows the file", async () => {
    const { fx, c, calls, docs } = await client();
    await c.link(fx.root);
    const sel = await c.select(fx.charts[0].hash);
    const r = await c.send([sel.path]);
    assert.equal(r.ok, true);
    assert.equal(r.woke, "started", "not running: Interlude.exe is started from its folder");
    assert.deepEqual(calls.launch, [[path.join(fx.root, "Interlude.exe"), fx.root]]);
    assert.deepEqual(calls.reveal, [r.osz]);
    assert.ok(r.osz.startsWith(path.join(docs, "карты")));
    const files = readOsz(await readFile(r.osz));
    assert.deepEqual([...files.keys()].sort(), [path.basename(sel.path), "audio.mp3", "bg.png"].sort());
    // an .osz the app made goes as it is; a running Interlude gets "focus" on its pipe
    const { c: c2, calls: calls2, fx: fx2 } = await client({ running: async () => true });
    await c2.link(fx2.root);
    const again = await c2.send([r.osz]);
    assert.equal(again.woke, "focused");
    assert.deepEqual(calls2.pipe, ["focus"]);
    assert.equal(again.osz, r.osz);
    // what is not a map, or files of two folders, is refused
    assert.equal((await c.send([path.join(docs, "x.txt")])).ok, false);
});

test("client: a playlist goes into collections.json only while Interlude is closed, after a dated backup", async () => {
    setLang("en");
    const existing = JSON.stringify({ Folders: { Old: { Charts: [], Icon: "" } }, Playlists: {}, Likes: ["X"] });
    let isRunning = true;
    const { fx, c } = await client({ running: async () => isRunning });
    await writeFile(path.join(fx.root, "Data", "collections.json"), existing, "utf8");
    await c.link(fx.root);
    const refused = await c.writeCollection({ name: "Course", entries: [{ hash: fx.charts[0].hash, rate: 1.1 }] });
    assert.equal(refused.ok, false);
    assert.equal(refused.running, true);
    assert.match(refused.message, /Close Interlude/);
    assert.equal(await readFile(path.join(fx.root, "Data", "collections.json"), "utf8"), existing);
    isRunning = false;
    const r = await c.writeCollection({ name: "Old", entries: [{ hash: fx.charts[0].hash, rate: 1.1 }, { hash: fx.charts[1].hash, rate: 1.25 }] });
    assert.equal(r.ok, true);
    assert.equal(r.name, "Old (2)");
    assert.equal(r.backup, path.join(fx.root, "Data", "collections.json.bak-20261026-153012"));
    assert.equal(await readFile(r.backup, "utf8"), existing);
    const now = JSON.parse(await readFile(path.join(fx.root, "Data", "collections.json"), "utf8"));
    assert.deepEqual(now.Folders, { Old: { Charts: [], Icon: "" } });
    assert.deepEqual(now.Likes, ["X"]);
    assert.deepEqual(now.Playlists["Old (2)"].Charts.map(([e, info]) => [e.Hash, info.Rate]), [[fx.charts[0].hash, 1.1], [fx.charts[1].hash, 1.25]]);
    // a collections.json Interlude itself could not read is left alone
    await writeFile(path.join(fx.root, "Data", "collections.json"), "{ broken", "utf8");
    const broken = await c.writeCollection({ name: "x", entries: [{ hash: fx.charts[0].hash }] });
    assert.equal(broken.ok, false);
    assert.equal(await readFile(path.join(fx.root, "Data", "collections.json"), "utf8"), "{ broken");
    setLang("ru");
});

test("sendPipe writes the command to Interlude's pipe and says whether it answered", async () => {
    const { EventEmitter } = await import("node:events");
    const written = [];
    const fake = (name) => {
        const s = new EventEmitter();
        s.write = (m) => { written.push([name, m]); setImmediate(() => s.emit("data", Buffer.from("ok"))); };
        s.destroy = () => {};
        setImmediate(() => s.emit("connect"));
        return s;
    };
    assert.equal(await sendPipe("focus", { connect: fake }), true);
    assert.deepEqual(written, [["\\\\.\\pipe\\Interlude", "focus\n"]]);
    const dead = () => {
        const s = new EventEmitter();
        s.destroy = () => {};
        setImmediate(() => s.emit("error", new Error("ENOENT")));
        return s;
    };
    assert.equal(await sendPipe("focus", { connect: dead }), false);
});

// ---- IPC handlers ----

test("ipc: what may be sent, what an export item keeps", () => {
    const docs = "C:\\Users\\me\\Documents\\Lunacy mania";
    assert.equal(sendable(path.join(docs, "карты", "a.osz"), docs), true);
    assert.equal(sendable("C:\\elsewhere\\a.osz", docs), false);
    assert.equal(sendable("D:\\osu\\Songs\\x\\a.osu", docs), true);
    assert.equal(sendable("a.osu", docs), false);
    assert.equal(sendable("C:\\x\\evil.exe", docs), false);
    assert.deepEqual(exportItem({ beatmapId: "12", md5: "AB".repeat(16), rate: 1.2, label: "L" }), { hash: null, md5: "ab".repeat(16), beatmapId: 12, path: null, rate: 1.2, label: "L" });
    assert.equal(exportItem({ beatmapId: -1 }), null);
    assert.equal(exportItem({ path: "x.osu" }), null);
});

test("ipc: a marathon list becomes a playlist with its rates; maps not in the library are named", async () => {
    setLang("en");
    const { fx, c, docs } = await client();
    await c.link(fx.root);
    const fileA = path.join(docs, "a.osu");
    await writeFile(fileA, fx.charts[0].osuText, "utf8");
    const h = createInterludeHandlers({ interlude: c, card: null, paths: { docsDir: docs } });
    const r = await h.exportList({
        name: "My course",
        items: [{ path: fileA, rate: 1.15, label: "A" }, { beatmapId: 222, rate: 1.3, label: "B" }, { beatmapId: 999, label: "Missing one" }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
    assert.deepEqual(r.missing, ["Missing one"]);
    const data = JSON.parse(await readFile(path.join(fx.root, "Data", "collections.json"), "utf8"));
    assert.deepEqual(data.Playlists["My course"].Charts.map(([e, i]) => [e.Hash, i.Rate]), [[fx.charts[0].hash, 1.15], [fx.charts[1].hash, 1.3]]);
    assert.equal(r.backup, null, "no file before: nothing to back up");
    const none = await h.exportList({ name: "x", items: [{ beatmapId: 999, label: "Nope" }] });
    assert.equal(none.ok, false);
    assert.deepEqual(none.missing, ["Nope"]);
    assert.match(none.message, /in your Interlude library yet/);
    setLang("ru");
});

test("ipc: selecting a chart puts it on the card; a bad hash is refused", async () => {
    const { fx, c } = await client();
    await c.link(fx.root);
    const shown = [];
    const h = createInterludeHandlers({ interlude: c, card: { showExternal: (x) => shown.push(x) }, paths: { docsDir: "" } });
    const r = await h.select({ hash: fx.charts[1].hash });
    assert.equal(r.ok, true);
    assert.equal(r.original, true);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, fx.charts[1].hash);
    assert.equal(shown[0].text, c.selection().text);
    shown[0].onEnd();
    assert.equal(c.selection(), null, "osu!'s selection taking the card back ends the Interlude one");
    assert.equal((await h.select({ hash: "../x" })).ok, false);
    assert.equal((await h.search({ query: "zenith" })).items.length, 1);
});

// ---- the card ----

test("card: an Interlude chart stays on it until osu!'s own selection changes", async () => {
    const views = [];
    let ended = 0;
    const analyzed = [];
    const ctrl = createSelectionController({
        fetchOsu: async () => "osu text",
        analyze: async (text, rate) => { analyzed.push([text, rate]); return { kind: "ok", label: text }; },
        cache: { get: async () => undefined, set: async () => {} },
        onView: (v) => views.push(v),
    });
    const frame = (checksum, rate = 1, state = "songselect") => ({ state, checksum, rate });
    ctrl.onFrame(frame("osu-a"));
    await new Promise((r) => setImmediate(r));
    ctrl.showExternal({ id: "H", text: "interlude text", rate: 1, onEnd: () => { ended += 1; } });
    await new Promise((r) => setImmediate(r));
    assert.equal(views.at(-1).result.label, "interlude text");
    // osu! still on the same map, playing, or no map: the Interlude chart stays
    ctrl.onFrame(frame("osu-a"));
    ctrl.onFrame(frame("osu-a", 1, "playing"));
    ctrl.onFrame(frame(null, 1, "menu"));
    ctrl.onTosuFailed("tosu died");
    await new Promise((r) => setImmediate(r));
    assert.equal(views.at(-1).result.label, "interlude text");
    assert.equal(ended, 0);
    // another map in osu!: osu! takes the card back
    ctrl.onFrame(frame("osu-b"));
    await new Promise((r) => setImmediate(r));
    assert.equal(ended, 1);
    assert.equal(ctrl.external(), null);
    assert.deepEqual(analyzed.map((a) => a[0]), ["osu text", "interlude text", "osu text"]);
});

// ---- the picks ----

test("picks: plays from Interlude join the player's own (which win), and alone when no profile is loaded", async () => {
    const api = { playedMaps: async () => new Map([[1, { beatmapsetId: 10, accuracy: 0.97, rate: 1 }]]) };
    const extra = new Map([[1, { beatmapsetId: 10, accuracy: null, rate: null, interlude: true }], [2, { beatmapsetId: 20, accuracy: null, rate: null, interlude: true }]]);
    const rec = createRecommender({ api, extraPlayed: async () => extra });
    const alone = await rec.playedMaps();
    assert.deepEqual([...alone.played.keys()], [1, 2]);
    const failing = createRecommender({ api, extraPlayed: async () => { throw new Error("no db"); } });
    assert.equal((await failing.playedMaps()).played.size, 0);
});

// ---- the rate tab on an Interlude chart ----

test("rate tab: copies of an Interlude chart are made next to its copy and sent to Interlude as one .osz", async () => {
    const { createRateHandlers } = await import("../app/rateIpc.js");
    const { rateForDan } = await import("../src/rate/rateForDan.js");
    const sent = [];
    const handlers = createRateHandlers({
        beatmapPath: async () => "C:/docs/interlude/x/A.osu",
        beatmap: async () => ({ client: "interlude", path: "C:/docs/interlude/x/A.osu", audioPath: "C:/docs/interlude/x/audio.mp3", backgroundPath: null }),
        readText: async () => makeChart({ seconds: 10 }),
        stat: async () => ({ mtimeMs: 1 }),
        analysis: { analyze: async () => ({ kind: "ok" }), analyzeQueued: async () => ({ kind: "ok" }) },
        createRateMap: async (req) => ({ osuPath: `C:/docs/interlude/x/${req.rate}.osu`, version: `v ${req.rate}` }),
        ffmpegPath: async () => "ffmpeg.exe",
        presets: { get: async () => [], set: async (v) => v },
        progress: () => {},
        log: () => {},
        rateForDan,
        sendInterlude: async (files) => { sent.push(files); return { ok: true, osz: "C:/docs/карты/x (Interlude).osz", message: "drag it" }; },
    });
    const info = await handlers.info();
    assert.equal(info.client, "interlude");
    const one = await handlers.create({ rate: 1.1 });
    assert.deepEqual(one, { ok: true, version: "v 1.1", file: "C:/docs/карты/x (Interlude).osz", client: "interlude", sent: true, sendMessage: "drag it" });
    const many = await handlers.batchCreate({ rates: [1.2, 1.3] });
    assert.equal(many.client, "interlude");
    assert.deepEqual(sent, [["C:/docs/interlude/x/1.1.osu"], ["C:/docs/interlude/x/1.2.osu", "C:/docs/interlude/x/1.3.osu"]]);
});

// ---- the window's words ----

test("window: a playlist answer in words, with the maps Interlude doesn't have yet", async () => {
    const { exportText } = await import("../app/renderer/interlude.js");
    setLang("en");
    assert.equal(exportText({ ok: true, name: "Course", count: 3, missing: [] }), "Playlist \"Course\" added to Interlude, charts: 3.");
    assert.equal(exportText({ ok: true, name: "C", count: 1, missing: ["A - B [C]"] }),
        "Playlist \"C\" added to Interlude, charts: 1. Not in your Interlude library yet (1) — import them first: A - B [C]");
    assert.equal(exportText({ ok: false, running: true, message: "Close Interlude first." }), "Close Interlude first.");
    setLang("ru");
    assert.match(exportText({ ok: false, message: "x" }), /^Не вышло: x/);
});
