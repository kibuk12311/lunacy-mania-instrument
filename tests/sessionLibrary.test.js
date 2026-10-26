// The session page's library (app/sessionLibrary.js) over a fake Songs folder and a fake Interlude folder in temp
// directories: only 4K mania charts are kept (no 7K, osu!standard, rate copies or marathons), each is analysed once and
// remembered, a second scan reads nothing that did not change, an Interlude chart that is a Songs map is one map.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, utimes, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionLibrary, headKind, chartMeta, analysisSummary, normalizeStore } from "../app/sessionLibrary.js";
import { createInterludeLibrary } from "../app/interludeLibrary.js";
import { analyzeChart } from "../src/core/analyze.js";
import { makeSongsFolder, withMeta, standardChart } from "./fixtures/songsFolder.js";
import { makeInterludeFolder } from "./fixtures/interludeFolder.js";
import { makeChart } from "./fixtures/makeChart.js";

const tempStore = async () => path.join(await mkdtemp(path.join(tmpdir(), "seslib-")), "session-library.json");
// a fake analysis that answers at once and counts what it was asked
function fakeAnalyze() {
    const asked = [];
    const analyze = async (text, rate) => {
        asked.push(/^Version:(.*)$/m.exec(text)?.[1]?.trim());
        if (/^Version:LN/m.test(text)) return { kind: "not-rice", reason: "ln" };
        const bpm = Number(/^\[TimingPoints\]\r?\n0,([\d.]+)/m.exec(text)?.[1]);
        return { kind: "ok", numeric: Math.round(60000 / bpm) / 10, label: "x", primary: "Jumpstream", top3: [{ name: "Jumpstream", share: 0.7 }], tech: false, durationSec: 100, bpm: 180, rate };
    };
    return { analyze, asked };
}

test("headKind and chartMeta tell a 4K mania chart from the rest", () => {
    assert.equal(headKind(makeChart({ keys: 4 })), "mania4k");
    assert.equal(headKind(makeChart({ keys: 7 })), "other");
    assert.equal(headKind(standardChart()), "other");
    assert.equal(headKind("osu file format v14\r\n[General]\r\nMode: 3\r\n[Metadata]\r\nTitle:x"), "unknown", "head cut before [Difficulty]");
    const meta = chartMeta(withMeta(makeChart(), { Title: "T", Artist: "A", Version: "V", BeatmapID: 12, BeatmapSetID: 3 }));
    assert.deepEqual(meta, { artist: "A", title: "T", version: "V", creator: "Test", beatmapId: 12, setId: 3 });
    assert.equal(chartMeta(withMeta(makeChart(), { Tags: "foo lunacy-mania-rate" })), null, "a rate copy the app made");
    assert.equal(chartMeta(withMeta(makeChart(), { Tags: "lunacy-mania-marathon" })), null, "a marathon the app made");
    assert.equal(chartMeta(makeChart({ keys: 7 })), null);
});

test("analysisSummary keeps the dan, patterns and length; a chart the analysis does not rate keeps its kind", () => {
    const s = analysisSummary({ kind: "ok", numeric: 13.2, label: "Gamma mid", primary: "Jumpstream", top3: [{ name: "Jumpstream", share: 0.61234 }], tech: false, durationSec: 151.6, bpm: 180.4, calcs: {}, msd: {} });
    assert.deepEqual(s, { kind: "ok", numeric: 13.2, label: "Gamma mid", primary: "Jumpstream", top3: [{ name: "Jumpstream", share: 0.612 }], tech: false, durationSec: 152, bpm: 180 });
    assert.deepEqual(analysisSummary({ kind: "not-rice", reason: "ln", keys: 4 }), { kind: "not-rice", reason: "ln" });
});

test("a scan of a Songs folder: 4K mania only, each analysed once, with the real analyser", async () => {
    const songs = await makeSongsFolder();
    const file = await tempStore();
    const changes = [];
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: analyzeChart, file, analyzer: "t1", onChange: (s) => changes.push(s.phase) });
    const started = Date.now();
    await lib.scan();
    const ms = Date.now() - started;
    const st = await lib.status();
    // Easy, Hard, Jacks, LN, Stream; not the 7K, the osu!standard chart or the rate copy
    assert.equal(st.counts.total, 5);
    assert.equal(st.counts.stable, 5);
    assert.equal(st.counts.analysed, 4);
    assert.equal(st.counts.skipped, 1, "the LN chart is not rice");
    assert.equal(st.counts.pending, 0);
    assert.equal(st.phase, "done");
    assert.equal(st.songsDir, songs);
    assert.equal(st.lastScan.sets, 3);
    assert.ok(changes.includes("listing") && changes.includes("analysing") && changes.at(-1) === "done");
    const maps = await lib.maps();
    assert.deepEqual(maps.map((m) => m.version).sort(), ["Easy", "Hard", "Jacks", "Stream"]);
    const hard = maps.find((m) => m.version === "Hard");
    assert.equal(hard.beatmapId, 1002);
    assert.match(hard.id, /^osu:[0-9a-f]{32}$/);
    assert.equal(hard.sources.stable.md5, hard.id.slice(4));
    assert.ok(hard.sources.stable.path.startsWith(songs));
    assert.ok(Number.isFinite(hard.numeric) && hard.durationSec > 100);
    assert.equal(hard.primary, "Jumpstream");
    assert.match(await lib.text(hard.id), /Version:Hard/);
    console.log(`fixture scan: 3 sets, 9 .osu, 5 4K charts listed + analysed in ${ms} ms (real analyser)`);
    // the store is on disk, versioned
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.analyzer, "t1");
    assert.equal(Object.keys(saved.maps).length, 5);
    await rm(songs, { recursive: true, force: true });
});

test("the next scan reads only what changed and analyses only that", async () => {
    const songs = await makeSongsFolder();
    const file = await tempStore();
    const first = fakeAnalyze();
    await createSessionLibrary({ songsDir: async () => songs, analyze: first.analyze, file, analyzer: "t1" }).scan();
    assert.equal(first.asked.length, 5);

    // a new run of the app: nothing changed, nothing is read or analysed
    const again = fakeAnalyze();
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: again.analyze, file, analyzer: "t1" });
    await lib.scan();
    assert.equal((await lib.status()).lastScan.read, 0);
    assert.deepEqual(again.asked, []);

    // one chart saved over (the folder's own time stays), one set added, one set removed
    const easy = path.join(songs, "101 Alpha - First Song", "Alpha - First Song (M) [Easy].osu");
    const before = await stat(path.join(songs, "101 Alpha - First Song"));
    await writeFile(easy, withMeta(makeChart({ kind: "stream", bpm: 160, seconds: 95 }), { Title: "First Song", Artist: "Alpha", Version: "Easy v2" }), "utf8");
    await utimes(path.join(songs, "101 Alpha - First Song"), before.atime, before.mtime);
    await rm(path.join(songs, "102 Beta - Second Song"), { recursive: true });
    const added = path.join(songs, "104 Delta - Fourth");
    await (await import("node:fs/promises")).mkdir(added);
    await writeFile(path.join(added, "Delta - Fourth (M) [Hard].osu"), withMeta(makeChart({ kind: "jumpstream", bpm: 190, seconds: 130 }), { Title: "Fourth", Artist: "Delta", Version: "Hard" }), "utf8");
    await lib.scan();
    const st = await lib.status();
    assert.equal(st.lastScan.read, 2, "the chart saved over and the new one");
    assert.deepEqual(again.asked.sort(), ["Easy v2", "Hard"]);
    assert.deepEqual((await lib.maps()).map((m) => `${m.artist} ${m.version}`).sort(), ["Alpha Easy v2", "Alpha Hard", "Delta Hard", "Gamma Stream"]);
    assert.equal(st.counts.total, 5, "Jacks gone with its set; the LN chart still counted");
    await rm(songs, { recursive: true, force: true });
});

test("another app version keeps the old analysis usable while it analyses again", async () => {
    const songs = await makeSongsFolder();
    const file = await tempStore();
    await createSessionLibrary({ songsDir: async () => songs, analyze: fakeAnalyze().analyze, file, analyzer: "old" }).scan();
    const store = normalizeStore(JSON.parse(await readFile(file, "utf8")), "new");
    assert.ok(Object.values(store.maps).every((m) => m.stale));
    const next = fakeAnalyze();
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: next.analyze, file, analyzer: "new" });
    lib.pause();
    await lib.scan();
    let st = await lib.status();
    assert.equal(st.phase, "paused");
    assert.equal(st.counts.stale, 5);
    assert.equal((await lib.maps()).length, 4, "stale results still build sessions");
    assert.deepEqual(next.asked, []);
    await lib.resume();
    st = await lib.status();
    assert.equal(st.phase, "done");
    assert.equal(st.counts.stale, 0);
    assert.equal(next.asked.length, 5);
    await rm(songs, { recursive: true, force: true });
});

test("the Songs folder: tosu's, else the one seen last, else a picked one, else none", async () => {
    const songs = await makeSongsFolder();
    const file = await tempStore();
    await createSessionLibrary({ songsDir: async () => songs, analyze: fakeAnalyze().analyze, file }).scan();
    // osu! closed: the folder seen last
    const closed = createSessionLibrary({ songsDir: async () => null, analyze: fakeAnalyze().analyze, file });
    await closed.scan();
    assert.equal((await closed.status()).songsDir, songs);
    assert.equal((await closed.maps()).length, 4);
    // nothing known at all
    const none = createSessionLibrary({ songsDir: async () => { throw new Error("tosu down"); }, analyze: fakeAnalyze().analyze, file: await tempStore() });
    await none.scan();
    const st = await none.status();
    assert.equal(st.songsDir, null);
    assert.equal(st.counts.total, 0);
    // picked in the window
    await none.pickSongs(songs);
    assert.equal((await none.status()).counts.total, 5);
    await rm(songs, { recursive: true, force: true });
});

test("an Interlude chart that is a Songs map is one map with both sources; the others are Interlude's own", async () => {
    const songs = await makeSongsFolder();
    const hardText = await readFile(path.join(songs, "101 Alpha - First Song", "Alpha - First Song (M) [Hard].osu"), "utf8");
    const { root, charts } = await makeInterludeFolder({
        charts: [
            // the same .osu as the stable one (its md5 is the origin's)
            { osuText: hardText, title: "First Song", artist: "Alpha", version: "Hard", creator: "Test", beatmapId: 1002, beatmapsetId: 101, keepOriginal: true },
            { osuText: makeChart({ kind: "jumpstream", bpm: 175, seconds: 120 }), title: "Only Here", artist: "Eta", version: "4K Hard" },
            { osuText: makeChart({ kind: "stream", bpm: 175, seconds: 60, keys: 7 }), title: "Seven", artist: "Eta", version: "7K" },
        ],
    });
    const interlude = {
        status: async () => ({ linked: true }),
        library: createInterludeLibrary({ folder: () => root, cacheDir: path.join(root, "..", `cache-${path.basename(root)}`) }),
    };
    const { analyze, asked } = fakeAnalyze();
    const lib = createSessionLibrary({ songsDir: async () => songs, interlude, analyze, file: await tempStore() });
    await lib.scan();
    const st = await lib.status();
    assert.deepEqual(st.interlude, { linked: true, count: 2 }, "4K charts only");
    assert.equal(st.counts.total, 6);
    assert.equal(st.counts.both, 1);
    assert.equal(st.counts.interlude, 1);
    const maps = await lib.maps();
    const hard = maps.find((m) => m.version === "Hard" && m.artist === "Alpha");
    assert.deepEqual(Object.keys(hard.sources).sort(), ["interlude", "stable"]);
    assert.equal(hard.sources.interlude.hash, charts[0].hash);
    const own = maps.find((m) => m.title === "Only Here");
    assert.equal(own.id, `il:${charts[1].hash}`);
    assert.deepEqual(Object.keys(own.sources), ["interlude"]);
    assert.ok(asked.includes("4K Hard"), "an Interlude chart is analysed from the chart itself");
    await rm(songs, { recursive: true, force: true });
});
