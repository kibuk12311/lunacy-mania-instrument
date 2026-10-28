// Vibro plays in the local profile: the model leaves a pass on a vibro map out of every dan (the same dans with and
// without it, the play still counted and listed), the store keeps the answer beside the map (maps.json, backups), the
// service works it out for a new map from its .osu, and a profile saved before vibro was looked at is looked at again
// from the Songs folder (the plays all stay, the dans come out as if the vibro plays were not there). Fake player only:
// TestPlayer, id 1234567.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL, performanceDan, vibroExcluded, isVibroMap, skillFromPlays, createSkillModel } from "../../src/localProfile/model.js";
import { createLocalProfileStore, mapSummary, mapKeyOf } from "../../app/localProfileStore.js";
import { createLocalProfileService, withVibro } from "../../app/localProfileService.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { VIBRO } from "../../src/vibro/detect.js";
import { chartOf, stream, jack, after } from "../fixtures/makeVibroChart.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12);
const md5 = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
const tempDir = () => mkdtemp(path.join(tmpdir(), "local-profile-vibro-"));
const hits = (n200 = 50, total = 1000) => ({ max: total - n200, n300: 0, n200, n100: 0, n50: 0, miss: 0 }); // 96.67%
const VIBRO_ANSWER = { v: VIBRO.VERSION, vibro: true, share: 0.6, longestRows: 200, peakGapMs: 80, confidence: "high" };
const NOT_VIBRO = { v: VIBRO.VERSION, vibro: false, share: 0, longestRows: 0, peakGapMs: null, confidence: "high" };
const summary = (numeric, name = "Jumpstream", extra = {}) => ({ kind: "ok", numeric, label: "x", top3: [{ name, share: 1 }], tech: false, durationSec: 100, calcs: {}, msd: {}, ...extra });

// twelve normal maps (jumpstream and chordjack, dans 12–14.2) and one vibro map at dan 20, all passed by TestPlayer
function history() {
    const maps = new Map();
    const plays = [];
    for (let i = 0; i < 12; i += 1) {
        const key = `${String(i).padStart(32, "a")}@1.00`;
        maps.set(key, summary(12 + i * 0.2, i % 2 ? "Chordjacks" : "Jumpstream", { vibro: NOT_VIBRO }));
        plays.push({ id: `p${i}`, mapKey: key, at: NOW - (20 - i) * DAY, outcome: "pass", hits: hits(), mods: [] });
    }
    const vibroKey = `${"f".repeat(32)}@1.30`;
    maps.set(vibroKey, summary(20, "Chordjacks", { vibro: VIBRO_ANSWER }));
    const vibroPlay = { id: "vibro", mapKey: vibroKey, at: NOW - DAY, outcome: "pass", hits: hits(), mods: [] };
    return { maps, plays, vibroKey, vibroPlay };
}
const dansOf = (k) => ({ overall: k.overall, tiles: k.tiles, axes: k.axes, patterns: k.patterns });

test("model: a pass on a vibro map is in no dan — the same dans with and without it, but counted and kept apart", () => {
    const { maps, plays, vibroKey, vibroPlay } = history();
    const without = skillFromPlays(plays, (k) => maps.get(k), NOW);
    const withIt = skillFromPlays([...plays, vibroPlay], (k) => maps.get(k), NOW);
    assert.notEqual(without.overall, null);
    assert.deepEqual(dansOf(withIt), dansOf(without));
    assert.equal(withIt.totalPlays, without.totalPlays + 1);
    assert.equal(withIt.analyzedPlays, without.analyzedPlays);
    assert.equal(withIt.vibroPlays, 1);
    assert.equal(without.vibroPlays, 0);
    // the same play counted (the old model): it would have pulled the jack dans up
    const counted = skillFromPlays([...plays, vibroPlay], (k) => maps.get(k), NOW, { ...MODEL, VIBRO_EXCLUDE: false });
    assert.ok(counted.axes.jack.dan > without.axes.jack.dan, `${counted.axes.jack.dan} > ${without.axes.jack.dan}`);
    assert.equal(counted.vibroPlays, 0);
    // the one play: no performance, said why
    assert.equal(performanceDan(vibroPlay, maps.get(vibroKey)), null);
    assert.equal(vibroExcluded(vibroPlay, maps.get(vibroKey)), true);
    assert.equal(isVibroMap(maps.get(vibroKey)), true);
    // a fail there is no evidence anyway (not counted as left out); a map without an answer counts as it always did
    assert.equal(vibroExcluded({ ...vibroPlay, outcome: "fail" }, maps.get(vibroKey)), false);
    assert.equal(vibroExcluded({ ...vibroPlay, mods: ["AT"] }, maps.get(vibroKey)), false);
    const unknown = { ...maps.get(vibroKey) };
    delete unknown.vibro;
    assert.equal(performanceDan(vibroPlay, unknown).mapDan, 20);
    assert.equal(performanceDan(vibroPlay, { ...unknown, vibro: NOT_VIBRO }).mapDan, 20);
    // one at a time: the same
    const m = createSkillModel();
    for (const p of [vibroPlay, ...plays]) m.add(p, maps.get(p.mapKey));
    assert.deepEqual(dansOf(m.skill(NOW)), dansOf(without));
    assert.equal(m.vibro(), 1);
});

test("store: the vibro answer is kept beside the map, survives maps.json and a backup, never invents one", async () => {
    const dir = await tempDir();
    const result = { kind: "ok", numeric: 15, label: "Delta", calcs: { mixed: 15 }, msd: {}, top3: [], tech: false, durationSec: 90 };
    assert.equal(mapSummary(result).vibro, undefined, "an analysis result has no vibro in it");
    assert.deepEqual(mapSummary({ ...result, vibro: VIBRO_ANSWER }).vibro, VIBRO_ANSWER);
    assert.equal(mapSummary({ ...result, vibro: { vibro: "yes" } }).vibro, undefined);
    const store = createLocalProfileStore({ dir });
    const key = mapKeyOf("b".repeat(32), 1.3);
    await store.setMap(key, mapSummary({ ...result, vibro: VIBRO_ANSWER }));
    const again = createLocalProfileStore({ dir });
    assert.deepEqual((await again.map(key)).vibro, VIBRO_ANSWER);
    const bundle = await again.exportBundle();
    assert.deepEqual(bundle.maps[key].vibro, VIBRO_ANSWER);
    // a profile that has the map without an answer takes the backup's; one that has an answer keeps its own
    const other = createLocalProfileStore({ dir: await tempDir() });
    await other.setMap(key, mapSummary(result));
    const keyB = mapKeyOf("c".repeat(32), 1);
    await other.setMap(keyB, mapSummary({ ...result, vibro: NOT_VIBRO }));
    await other.importBundle({ ...bundle, maps: { ...bundle.maps, [keyB]: mapSummary({ ...result, vibro: VIBRO_ANSWER }) } });
    assert.deepEqual((await other.map(key)).vibro, VIBRO_ANSWER);
    assert.deepEqual((await other.map(keyB)).vibro, NOT_VIBRO);
    // the service's helper: only a map with a dan gets an answer, from its .osu at the rate
    const vibroText = chartOf([...stream(1000, 200, 120), ...jack(25_000, 150, 85, [1, 2])]);
    assert.equal(withVibro(mapSummary(result), vibroText, 1).vibro.vibro, true);
    assert.equal(withVibro(mapSummary(result), vibroText, 0.8).vibro.vibro, false, "106 ms at 0.8x");
    assert.deepEqual(withVibro({ kind: "too-short" }, vibroText, 1), { kind: "too-short" });
    assert.equal(withVibro(mapSummary(result), null, 1).vibro, undefined);
});

// ---- the service ----

// .osu texts: normal maps (a stream at bpm, a 1/4 jumpjack line at 150 BPM in it) and a vibro map
const normalText = (i) => chartOf([...stream(1000, 300, 60000 / (150 + i * 5) / 4), ...jack(80_000, 40, 100, [i % 4])], { title: `Normal ${i}` });
const vibroText = () => chartOf([...stream(1000, 200, 110), ...jack(25_000, 300, 80, [0, 1])], { title: "Vibro dump" });
// the analysis: a dan from the title (the vibro map gets a big one, as calculators give it), chordjack-ish
function fakeAnalyze() {
    const calls = [];
    const analyze = async (text, rate) => {
        calls.push([md5(text), rate]);
        const title = /^Title:(.*)$/m.exec(text)?.[1]?.trim() ?? "";
        const numeric = title === "Vibro dump" ? 21 : 12 + Number(/Normal (\d+)/.exec(title)?.[1] ?? 0) * 0.25;
        return { kind: "ok", numeric: Math.round(numeric * rate * 100) / 100, label: "x", top3: [{ name: "Chordjacks", share: 0.7 }, { name: "Jumpstream", share: 0.3 }], tech: false, durationSec: 90, calcs: {} };
    };
    return { analyze, calls };
}

function liveService(dir, { texts = new Map() } = {}) {
    const store = createLocalProfileStore({ dir: path.join(dir, "profile") });
    const a = fakeAnalyze();
    let serving = null;
    const s = createLocalProfileService({
        store, analyze: a.analyze, fetchMapText: async () => serving, readFile: (f) => readFile(f),
        exists: async (f) => Boolean((await stat(f).catch(() => null))?.isFile()),
        songsIndex: createSongsMd5Index({ indexFile: path.join(dir, "profile", "songs-md5.json") }),
        now: () => NOW,
    });
    const play = (text, i, extra = {}) => {
        serving = text;
        return s.recordLive({
            client: "stable", md5: md5(text), beatmapId: 1_000_000 + i, beatmapsetId: 900_000 + i, artist: "Test", title: /^Title:(.*)$/m.exec(text)[1],
            version: "x", rate: 1, mods: [], hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", startedAt: NOW - (30 - i) * DAY, at: NOW - (30 - i) * DAY + 1000, ...extra,
        });
    };
    return { s, store, a, play, texts };
}

test("service, live: a new map's vibro answer comes with its analysis; the vibro play is listed, its dan left out", async () => {
    const dir = await tempDir();
    const { s, store, a, play } = liveService(dir);
    for (let i = 0; i < 8; i += 1) await play(normalText(i), i);
    const before = (await s.status()).skill;
    assert.ok(before.ready);
    await play(vibroText(), 20);
    const st = await s.status();
    assert.equal(a.calls.length, 9, "one analysis per map");
    assert.equal(st.counts.plays, 9);
    assert.equal(st.counts.rated, 8);
    assert.equal(st.counts.vibro, 1);
    assert.deepEqual(dansOf(st.skill), dansOf(before));
    const [latest] = st.recent;
    assert.equal(latest.title, "Vibro dump");
    assert.equal(latest.mapDan, 21, "the map keeps its own dan");
    assert.equal(latest.perf, null);
    assert.equal(latest.unrated, false);
    assert.ok(latest.vibro && latest.vibro.share > 0.5, JSON.stringify(latest.vibro));
    assert.equal(st.recent.filter((p) => p.vibro).length, 1, "the normal maps (1/4 jumpjacks at 150 BPM) are not vibro");
    const kept = await store.map(mapKeyOf(md5(vibroText()), 1));
    assert.equal(kept.vibro.vibro, true);
    assert.equal(kept.vibro.v, VIBRO.VERSION);
    // the best plays of the period leave it out too
    const h = await s.history(90);
    assert.ok(h.best.every((p) => p.title !== "Vibro dump"));
    assert.equal(h.plays.length, 9);
});

// A profile saved before vibro was looked at: plays.jsonl and maps.json as an older app wrote them (no vibro), the maps
// in a Songs folder the profile knows.
async function savedProfile(root) {
    const songs = path.join(root, "osu!", "Songs");
    const texts = [...Array.from({ length: 8 }, (_, i) => normalText(i)), vibroText()];
    const lines = [];
    const maps = {};
    const a = fakeAnalyze();
    for (const [i, text] of texts.entries()) {
        const dirOf = path.join(songs, `${500 + i} Test - Map ${i}`);
        await mkdir(dirOf, { recursive: true });
        await writeFile(path.join(dirOf, "map.osu"), text, "utf8");
        const key = mapKeyOf(md5(text), 1);
        maps[key] = mapSummary(await a.analyze(text, 1));
        for (let j = 0; j < (i === 8 ? 3 : 1); j += 1) {
            lines.push(JSON.stringify({
                id: `stable:${md5(`${i}:${j}`)}`, source: "stable-db", client: "stable", md5: md5(text), rate: 1, mapKey: key,
                beatmapId: 2_000_000 + i, beatmapsetId: 500 + i, artist: "Test", title: /^Title:(.*)$/m.exec(text)[1], version: "x", mods: [],
                hits: hits(40 + j), accuracy: null, maxCombo: 900, outcome: "pass", at: NOW - (40 - i) * DAY + j,
            }));
        }
    }
    const dir = path.join(root, "profile");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plays.jsonl"), `${lines.join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify(maps), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: path.join(root, "osu!"), imports: {} }), "utf8");
    return { dir, plays: lines.length };
}

test("service, a saved profile: its maps are looked at from Songs once, the vibro plays leave the dans, every play stays", async () => {
    const root = await tempDir();
    const { dir, plays } = await savedProfile(root);
    const store = createLocalProfileStore({ dir });
    const events = [];
    const logs = [];
    const s = createLocalProfileService({
        store, analyze: async () => assert.fail("nothing is analysed again"), readFile: (f) => readFile(f),
        exists: async (f) => Boolean((await stat(f).catch(() => null))?.isFile()),
        songsIndex: createSongsMd5Index({ indexFile: path.join(dir, "songs-md5.json") }),
        emit: (c, p) => events.push([c, p]), log: (x) => logs.push(x), now: () => NOW,
    });
    const before = await s.status();
    assert.equal(before.counts.vibro, 0, "not looked at yet: counted as before");
    assert.equal(before.counts.rated, plays);
    const r = await s.checkVibro();
    assert.deepEqual(r, { checked: 9, vibro: 1, missing: 0 });
    assert.ok(events.some(([c]) => c === "local-profile-changed"), "the window hears the new skill");
    const after = await s.status();
    assert.equal(after.counts.plays, plays, "no play is lost");
    assert.equal(after.counts.vibro, 3, "the vibro map's three passes");
    assert.equal(after.counts.rated, plays - 3);
    assert.ok(after.skill.axes.jack.dan < before.skill.axes.jack.dan, `${after.skill.axes.jack.dan} < ${before.skill.axes.jack.dan}`);
    // the same dans as a profile that never had the vibro plays
    const all = await store.plays();
    const maps = store.mapsNow();
    const normalOnly = skillFromPlays(all.filter((p) => p.title !== "Vibro dump"), (k) => maps.get(k), NOW);
    assert.deepEqual(dansOf(after.skill), dansOf(normalOnly));
    // maps.json has the answers now; plays.jsonl is as it was
    const onDisk = JSON.parse(await readFile(path.join(dir, "maps.json"), "utf8"));
    assert.ok(Object.values(onDisk).every((m) => m.vibro?.v === VIBRO.VERSION));
    assert.equal((await readFile(path.join(dir, "plays.jsonl"), "utf8")).trim().split("\n").length, plays);
    // once a session
    assert.equal((await s.checkVibro()).already, true);
    assert.ok(logs.some((x) => /vibro looked at on 9 kept maps \(1 vibro\), 0 without/.test(x)), logs.join("\n"));
});

test("service, a saved profile whose .osu files are gone: nothing is guessed, the plays count as they did", async () => {
    const root = await tempDir();
    const { dir, plays } = await savedProfile(root);
    const settings = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ ...settings, osuFolder: path.join(root, "elsewhere") }), "utf8");
    const store = createLocalProfileStore({ dir });
    const s = createLocalProfileService({
        store, analyze: async () => null, readFile: (f) => readFile(f), exists: async () => false,
        songsIndex: createSongsMd5Index({ indexFile: path.join(dir, "songs-md5.json") }), now: () => NOW,
    });
    const before = await s.status();
    assert.deepEqual(await s.checkVibro(), { checked: 0, vibro: 0, missing: 9 });
    const after = await s.status();
    assert.equal(after.counts.vibro, 0);
    assert.equal(after.counts.rated, plays);
    assert.deepEqual(dansOf(after.skill), dansOf(before.skill));
});

test("service: an import asked for while the pass reads waits for it, and the pass waits for an import under way", async () => {
    const root = await tempDir();
    const { dir } = await savedProfile(root);
    const gated = () => {
        let open;
        const opened = new Promise((r) => { open = r; });
        let reached;
        const reachedP = new Promise((r) => { reached = r; });
        return { open, opened, reached, reachedP };
    };
    const ticks = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
    const make = (d, { read = null, scoresCheck = null } = {}) => createLocalProfileService({
        store: createLocalProfileStore({ dir: d }), analyze: async () => null,
        readFile: async (f) => { if (read && f.endsWith("map.osu")) await read(); return readFile(f); },
        exists: async () => { if (scoresCheck) await scoresCheck(); return false; },
        songsIndex: createSongsMd5Index({ indexFile: path.join(d, "songs-md5.json") }), now: () => NOW,
    });
    // the pass reads first: the import waits for it
    const order = [];
    const r1 = gated();
    const s = make(dir, { read: async () => { order.push("read"); r1.reached(); await r1.opened; } });
    const pass = s.checkVibro();
    await r1.reachedP;
    const imported = s.importStable().then((x) => { order.push("import"); return x; });
    await ticks();
    assert.deepEqual(order, ["read"], "the import has not started its work");
    r1.open();
    assert.equal((await pass).checked, 9);
    assert.equal((await imported).reason, "no-scores");
    assert.equal(order.at(-1), "import");
    // an import under way first: the pass waits for it to end before it reads
    const { dir: dir2 } = await savedProfile(await tempDir());
    const order2 = [];
    const r2 = gated();
    const s2 = make(dir2, { read: async () => { order2.push("read"); }, scoresCheck: async () => { order2.push("import"); r2.reached(); await r2.opened; } });
    const running = s2.importStable();
    await r2.reachedP;
    const pass2 = s2.checkVibro();
    await ticks();
    assert.deepEqual(order2, ["import"], "the pass has not read anything yet");
    r2.open();
    await running;
    assert.equal((await pass2).checked, 9);
    assert.equal(order2[1], "read");
});

test("service: a kept map met again live is looked at on the spot; its earlier passes leave the dans too", async () => {
    const root = await tempDir();
    const { dir, plays } = await savedProfile(root);
    const store = createLocalProfileStore({ dir });
    const text = vibroText();
    const s = createLocalProfileService({
        store, analyze: async () => assert.fail("a kept map is not analysed again"), fetchMapText: async () => text,
        readFile: (f) => readFile(f), exists: async () => false, now: () => NOW,
    });
    assert.equal((await s.status()).counts.vibro, 0);
    await s.recordLive({
        client: "stable", md5: md5(text), beatmapId: 2_000_008, beatmapsetId: 508, artist: "Test", title: "Vibro dump", version: "x",
        rate: 1, mods: [], hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", startedAt: NOW - 1000, at: NOW,
    });
    const st = await s.status();
    assert.equal(st.counts.plays, plays + 1);
    assert.equal(st.counts.vibro, 4, "the three kept passes and the new one");
    assert.equal(st.counts.rated, plays - 3, "the other maps (no answer yet) count as they did");
    assert.equal((await store.map(mapKeyOf(md5(text), 1))).vibro.vibro, true);
});

test("service: a backup made before vibro was looked at is looked at after it is imported", async () => {
    const old = await savedProfile(await tempDir());
    const bundle = await createLocalProfileStore({ dir: old.dir }).exportBundle();
    assert.ok(Object.values(bundle.maps).every((m) => !m.vibro), "an old backup has no answers");
    const root = await tempDir();
    const songsOf = path.join(path.dirname(old.dir), "osu!"); // the backup's maps are still in that Songs folder
    const dir = path.join(root, "profile");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: songsOf, imports: {} }), "utf8");
    const s = createLocalProfileService({
        store: createLocalProfileStore({ dir }), analyze: async () => null, readFile: (f) => readFile(f), exists: async () => false,
        songsIndex: createSongsMd5Index({ indexFile: path.join(dir, "songs-md5.json") }), now: () => NOW,
    });
    assert.deepEqual(await s.checkVibro(), { checked: 0, vibro: 0, missing: 0 }, "nothing to look at yet");
    assert.equal((await s.importBundle(bundle)).ok, true);
    let st = await s.status();
    for (let i = 0; i < 50 && st.counts.vibro === 0; i += 1) {
        await s.checkVibro();
        st = await s.status();
    }
    assert.equal(st.counts.plays, old.plays);
    assert.equal(st.counts.vibro, 3);
    assert.equal((await s.checkVibro()).already, true);
});
