// The session page's library (app/sessionLibrary.js) over a fake Songs folder and a fake Interlude folder in temp
// directories: only 4K mania charts are kept (no 7K, osu!standard, rate copies or marathons), each is analysed once and
// remembered, a second scan reads nothing that did not change, an Interlude chart or a lazer map (a fake lazer) that is
// a Songs map is one map.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, utimes, rm, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
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

test("an update that keeps the analyzer keeps the analyses of a version up to 0.9.9; another analyzer marks them stale", async () => {
    const FP = "0123456789abcdef";
    const releases = { "0.9.6": "fedcba9876543210", "0.9.8": FP, "0.9.9": FP };
    const store = (analyzer) => ({ v: 1, analyzer, songsDir: null, folders: {}, maps: { "osu:0123456789abcdef0123456789abcdef": { path: "x", a: { kind: "ok", numeric: 5 } } } });
    const stale = (analyzer) => Object.values(normalizeStore(store(analyzer), FP, releases).maps)[0].stale === true;
    assert.equal(stale("0.9.9"), false, "0.9.9 had this analyzer");
    assert.equal(stale(FP), false, "the fingerprint itself");
    assert.equal(stale("0.9.6"), true, "0.9.6 had another");
    assert.equal(stale("0.9.5"), true, "a version the table does not know");
    assert.equal(stale("fedcba9876543210"), true, "another fingerprint");
    assert.equal(normalizeStore(store("0.9.9"), FP, releases).analyzer, FP, "saved again under the fingerprint");
    const unknown = normalizeStore(store("fedcba9876543210"), null, releases);
    assert.equal(Object.values(unknown.maps)[0].stale, undefined, "an unknown fingerprint marks nothing stale");
    assert.equal(unknown.analyzer, "fedcba9876543210", "and keeps the store's analyzer");
    // a failed analysis is tried again by another build of the same analyzer, an ok one is not
    const failed = (analyzer) => ({ ...store(analyzer), maps: { "osu:0123456789abcdef0123456789abcdef": { path: "x", a: { kind: "error" } } } });
    const staleFailed = (analyzer) => Object.values(normalizeStore(failed(analyzer), FP, releases).maps)[0].stale === true;
    assert.equal(staleFailed("0.9.9"), true, "an error of 0.9.9 is tried again");
    assert.equal(staleFailed(FP), false, "but not by the same build again and again");

    // the whole library: written by 0.9.9, opened by a build of the same analyzer — nothing analysed again
    const songs = await makeSongsFolder();
    const file = await tempStore();
    await createSessionLibrary({ songsDir: async () => songs, analyze: fakeAnalyze().analyze, file, analyzer: "0.9.9", releases }).scan();
    const same = fakeAnalyze();
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: same.analyze, file, analyzer: FP, releases });
    await lib.scan();
    assert.equal((await lib.status()).counts.stale, 0);
    assert.deepEqual(same.asked, []);
    assert.equal(JSON.parse(await readFile(file, "utf8")).analyzer, FP);
    // a changed analyzer: stale, still usable, then analysed again
    const changed = fakeAnalyze();
    const next = createSessionLibrary({ songsDir: async () => songs, analyze: changed.analyze, file, analyzer: "fedcba9876543210", releases });
    next.pause();
    await next.scan();
    assert.equal((await next.status()).counts.stale, 5);
    assert.equal((await next.maps()).length, 4, "stale results still build sessions");
    await next.resume();
    assert.equal(changed.asked.length, 5);
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

// ---- osu! lazer as a source (a fake app/lazerRealm.js: read() and text(hash)) ----

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const md5Hex = (text) => createHash("md5").update(text, "utf8").digest("hex");
const metaOf = (text, key) => new RegExp(`^${key}:(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
// a LazerMap of an .osu text, as app/lazerRealm.js lists it
const lazerMap = (text, patch = {}) => ({
    hash: sha256(text), md5: md5Hex(text), keys: 4, artist: metaOf(text, "Artist"), title: metaOf(text, "Title"),
    version: metaOf(text, "Version"), creator: "Test", tags: "", beatmapId: null, setId: null, audio: null, background: null, ...patch,
});
function fakeLazer(maps, { texts = new Map(maps.map((m) => [m.hash, m.text])), fail = null } = {}) {
    const asked = [];
    return {
        asked,
        read: async () => {
            if (fail) throw new Error(fail);
            return { found: true, maps: maps.map(({ text: _t, ...m }) => m), scores: [] };
        },
        text: async (hash) => { asked.push(hash); return texts.get(hash) ?? null; },
    };
}
// a fake linked Interlude with one chart that is in no Songs folder; its origin is the .osu given
function fakeInterlude(osuText) {
    const hash = "C".repeat(64);
    return {
        hash,
        status: async () => ({ linked: true }),
        library: {
            list: async () => [{ hash, artist: "Eta", title: "Only Here", version: "4K Hard", creator: "Test", beatmapId: null, origins: [{ md5: md5Hex(osuText) }] }],
            osuFor: async (h) => (h === hash ? { text: osuText } : null),
        },
    };
}
const lazerOwn = () => {
    const text = withMeta(makeChart({ kind: "stream", bpm: 170, seconds: 90 }), { Title: "Lazer Song", Artist: "Theta", Version: "Lazer Hard" });
    return { ...lazerMap(text), text };
};

test("lazer: a map that is a stable or an Interlude one is that map; the rest are lazer's own, copies the app made are not", async () => {
    const songs = await makeSongsFolder();
    const hardText = await readFile(path.join(songs, "101 Alpha - First Song", "Alpha - First Song (M) [Hard].osu"), "utf8");
    const ilText = withMeta(makeChart({ kind: "jumpstream", bpm: 175, seconds: 120 }), { Title: "Only Here", Artist: "Eta", Version: "4K Hard" });
    const rateText = withMeta(makeChart({ kind: "stream", bpm: 187, seconds: 80 }), { Title: "Lazer Song", Artist: "Theta", Version: "Lazer Hard 1.1x", Tags: "lunacy-mania-rate" });
    const sevenText = withMeta(makeChart({ kind: "stream", bpm: 170, seconds: 90, keys: 7 }), { Title: "Seven", Artist: "Theta", Version: "7K" });
    const own = lazerOwn();
    const lz = [
        { ...lazerMap(hardText), text: hardText },
        { ...lazerMap(ilText), text: ilText },
        { ...own, beatmapId: 4321, setId: 765 },
        { ...lazerMap(rateText, { tags: "foo lunacy-mania-rate" }), text: rateText },
        { ...lazerMap(sevenText, { keys: 7 }), text: sevenText },
    ];
    const lazer = fakeLazer(lz);
    const interlude = fakeInterlude(ilText);
    const { analyze, asked } = fakeAnalyze();
    const file = await tempStore();
    const lib = createSessionLibrary({ songsDir: async () => songs, interlude, lazer, analyze, file });
    await lib.scan();
    const st = await lib.status();
    assert.deepEqual(st.lazer, { found: true, count: 3 }, "4K only, not the rate copy");
    assert.equal(st.counts.total, 7, "5 stable + 1 Interlude + 1 lazer-only");
    assert.equal(st.counts.lazer, 3);
    assert.equal(st.counts.stable, 5);
    assert.equal(st.counts.interlude, 1);
    const maps = await lib.maps();
    const hard = maps.find((m) => m.version === "Hard" && m.artist === "Alpha");
    assert.deepEqual(Object.keys(hard.sources).sort(), ["lazer", "stable"]);
    assert.deepEqual(hard.sources.lazer, { hash: lz[0].hash, md5: hard.sources.stable.md5 });
    const il = maps.find((m) => m.title === "Only Here");
    assert.equal(il.id, `il:${interlude.hash}`);
    assert.deepEqual(Object.keys(il.sources).sort(), ["interlude", "lazer"]);
    assert.equal(il.sources.lazer.hash, lz[1].hash);
    const mine = maps.find((m) => m.title === "Lazer Song");
    assert.equal(mine.id, `lz:${own.hash}`);
    assert.deepEqual(mine.sources, { lazer: { hash: own.hash, md5: own.md5 } });
    assert.equal(mine.beatmapId, 4321);
    assert.ok(asked.includes("Lazer Hard"), "a lazer-only map is analysed from lazer's .osu");
    assert.ok(!asked.includes("Lazer Hard 1.1x") && !asked.includes("7K"));
    assert.deepEqual(lazer.asked, [own.hash], "only the map that is nowhere else is read out of lazer");
    assert.match(await lib.text(mine.id), /Version:Lazer Hard/);
    // the store keeps the lazer map under its own id
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(normalizeStore(saved, saved.analyzer).maps[mine.id].lz, own.hash);
    // gone from lazer: the lz fields are set again on the next merge
    const gone = createSessionLibrary({ songsDir: async () => songs, interlude, lazer: fakeLazer([lz[2]]), analyze, file });
    await gone.scan();
    const after = await gone.maps();
    assert.equal(after.find((m) => m.version === "Hard" && m.artist === "Alpha").sources.lazer, undefined);
    assert.equal(after.find((m) => m.title === "Only Here").sources.lazer, undefined);
    assert.equal((await gone.status()).counts.lazer, 1);
    await rm(songs, { recursive: true, force: true });
});

test("lazer: not installed adds nothing; a database that cannot be read keeps the rest and what was known of lazer", async () => {
    const songs = await makeSongsFolder();
    const file = await tempStore();
    const notThere = { read: async () => ({ found: false, maps: [], scores: [] }), text: async () => null };
    const none = createSessionLibrary({ songsDir: async () => songs, lazer: notThere, analyze: fakeAnalyze().analyze, file });
    await none.scan();
    assert.deepEqual((await none.status()).lazer, { found: false, count: 0 });
    assert.equal((await none.status()).counts.total, 5);

    const own = lazerOwn();
    await createSessionLibrary({ songsDir: async () => songs, lazer: fakeLazer([own]), analyze: fakeAnalyze().analyze, file }).scan();
    const logs = [];
    const next = fakeAnalyze();
    const broken = createSessionLibrary({
        songsDir: async () => songs, lazer: fakeLazer([own], { fail: "database locked" }), analyze: next.analyze, file, log: (x) => logs.push(x),
    });
    await broken.scan();
    const st = await broken.status();
    assert.equal(st.phase, "done", "the scan goes on");
    assert.deepEqual(st.lazer, { found: true, count: 0, error: "database locked" });
    assert.equal(st.counts.total, 6, "the lazer map read before is kept");
    assert.ok((await broken.maps()).some((m) => m.id === `lz:${own.hash}`));
    assert.ok(logs.some((x) => /lazer not read: database locked/.test(x)));
    assert.deepEqual(next.asked, []);
    await rm(songs, { recursive: true, force: true });
});

test("lazer: a map not analysed yet while lazer cannot be read is tried again on a later scan, not marked failed", async () => {
    const file = await tempStore();
    const own = lazerOwn();
    const first = createSessionLibrary({ lazer: fakeLazer([own]), analyze: fakeAnalyze().analyze, file });
    first.pause();
    await first.scan(); // listed, not analysed
    const lib = createSessionLibrary({ lazer: fakeLazer([own], { fail: "locked", texts: new Map() }), analyze: fakeAnalyze().analyze, file });
    await lib.scan();
    const st = await lib.status();
    assert.equal(st.counts.failed, 0);
    assert.equal(st.counts.pending, 1);
    const fine = createSessionLibrary({ lazer: fakeLazer([own]), analyze: fakeAnalyze().analyze, file });
    await fine.scan();
    assert.equal((await fine.status()).counts.analysed, 1);
});

test("the store takes lazer ids (lz:<sha256>) and nothing like them", () => {
    const m = { artist: "A", a: { kind: "ok" } };
    const maps = {
        [`lz:${"ab".repeat(32)}`]: m, [`lz:${"AB".repeat(32)}`]: m, [`lz:${"ab".repeat(31)}`]: m, [`osu:${"a".repeat(32)}`]: m, [`il:${"A".repeat(64)}`]: m,
    };
    const ids = Object.keys(normalizeStore({ v: 1, analyzer: "x", maps }, "x").maps);
    assert.deepEqual(ids.sort(), [`il:${"A".repeat(64)}`, `lz:${"ab".repeat(32)}`, `osu:${"a".repeat(32)}`]);
});
