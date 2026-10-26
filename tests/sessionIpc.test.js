// The session page's handlers (app/sessionIpc.js) over fakes: the profile a session is built for, the rates checked by
// an analysis, ↻, saved sessions, and the exports — an osu! collection (rate copies made first, the collections already
// in collection.db kept, a backup), a marathon (Interlude charts copied out) — all in temp folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionHandlers, recentIds, normalizeSaved, cleanSessionName, withCollection } from "../app/sessionIpc.js";
import { createJsonStore } from "../app/jsonStore.js";
import { encodeCollectionDb, decodeCollectionDb } from "../src/recommend/collectionDb.js";
import { exportItem } from "../app/interludeIpc.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { manualSkill, normalizeManualProfile } from "../src/recommend/manualProfile.js";

const FAMILY_NAME = { stream: "Stream", jumpstream: "Jumpstream" };
const HASH = (n) => n.toString(16).toUpperCase().padStart(64, "0");
let n = 0;
function map(pattern, numeric, { interludeOnly = false, both = false } = {}) {
    n += 1;
    const md5 = n.toString(16).padStart(32, "0");
    const sources = interludeOnly ? { interlude: { hash: HASH(n) } }
        : { stable: { path: `C:\\songs\\${n}\\${n}.osu`, md5 }, ...(both ? { interlude: { hash: HASH(n) } } : {}) };
    return {
        id: interludeOnly ? `il:${HASH(n)}` : `osu:${md5}`, artist: `Artist ${n}`, title: `Song ${n}`, version: `${pattern} ${numeric}`, creator: "M",
        numeric, label: "x", primary: FAMILY_NAME[pattern], top3: [{ name: FAMILY_NAME[pattern], share: 0.8 }], tech: false, durationSec: 150, bpm: 180,
        beatmapId: interludeOnly ? null : 7000 + n, sources,
    };
}
const MANUAL = { name: "TestPlayer", speed: 13, jack: 13, stamina: 13, tech: 13 };

function fakeLibrary(maps, status = { phase: "done", counts: { analysed: maps.length, total: maps.length } }) {
    return {
        maps: async () => maps,
        status: async () => status,
        text: async (id) => `text of ${id}`,
        scan: async () => {}, pause() {}, resume: async () => {},
    };
}

async function setup({ maps, profile = { current: () => ({ ok: false }) }, played, findRate, ...rest } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), "sesipc-"));
    const saved = createJsonStore({ file: path.join(dir, "sessions.json"), normalize: normalizeSaved, fallback: [] });
    const events = [];
    let seed = 1;
    const h = createSessionHandlers({
        library: fakeLibrary(maps), profile, played, analyze: async () => ({ kind: "ok" }), saved, docsDir: () => dir,
        findRate: findRate ?? (async ({ target }) => ({ ok: true, rate: 1.1, numeric: target, label: "fitted" })),
        progress: (e) => events.push(e), seed: () => seed++, now: () => Date.UTC(2026, 9, 26, 12), ...rest,
    });
    return { h, dir, events };
}

const near = () => [
    ...Array.from({ length: 12 }, (_, i) => map("jumpstream", 13 + (i % 6) / 10)),
    ...Array.from({ length: 6 }, (_, i) => map("jumpstream", 12 + i / 10)),
    map("jumpstream", 14), map("jumpstream", 14.1), map("stream", 12.5), map("stream", 12.4),
];
const req = (patch = {}) => ({ minutes: 20, patternIds: ["jumpstream"], goalId: "growth", allowRates: false, avoidRecent: false, ...patch });

test("a session needs a profile: the hand-set one sent along, or the mania-tracker one main holds", async () => {
    setLang("en");
    const { h } = await setup({ maps: near() });
    const none = await h.build(req());
    assert.equal(none.ok, false);
    assert.match(none.message, /profile is needed/);
    const manual = await h.build(req({ manualProfile: MANUAL }));
    assert.equal(manual.ok, true, manual.message);
    assert.equal(manual.session.targets[0].playerDan, 13);
    assert.ok(manual.session.items.length >= 5);
    assert.match(manual.session.name, /^Session 26\.10 · Jumpstream 20 min$/);
    assert.equal((await h.build(req({ manualProfile: { speed: 99 } }))).ok, false);
    const tracker = { current: () => ({ ok: true, skill: { tiles: { speed: 14, stamina: 13.6, jack: 13, tech: 13 }, overall: 13.5, msd: {} } }) };
    const t2 = await (await setup({ maps: near(), profile: tracker })).h.build(req());
    assert.equal(t2.session.targets[0].playerDan, 13.6);
    assert.equal((await h.build(req({ minutes: 3, manualProfile: MANUAL }))).ok, false);
    setLang("ru");
});

test("an empty library says why: still being analysed, no maps at all; nothing near the target says so", async () => {
    setLang("en");
    const dir = await mkdtemp(path.join(tmpdir(), "sesipc-"));
    const saved = createJsonStore({ file: path.join(dir, "s.json"), normalize: normalizeSaved, fallback: [] });
    const busy = createSessionHandlers({ library: fakeLibrary([], { phase: "analysing", counts: { analysed: 3, total: 120 } }), saved, analyze: async () => ({}) });
    assert.match((await busy.build(req({ manualProfile: MANUAL }))).message, /still being analysed \(3 of 120\)/);
    const empty = createSessionHandlers({ library: fakeLibrary([], { phase: "done", counts: { analysed: 0, total: 0 } }), saved, analyze: async () => ({}) });
    assert.match((await empty.build(req({ manualProfile: MANUAL }))).message, /No 4K maps found/);
    const { h } = await setup({ maps: [map("jumpstream", 5), map("jumpstream", 5.1)] });
    const far = await h.build(req({ manualProfile: MANUAL }));
    assert.deepEqual([far.ok, far.reason], [false, "nothingNear"]);
    setLang("ru");
});

test("rates are checked by the analysis: every estimated item goes through the rate search, with progress", async () => {
    const low = Array.from({ length: 30 }, (_, i) => map("jumpstream", 12 + (i % 3) / 10));
    const asked = [];
    const { h, events } = await setup({
        maps: low,
        findRate: async ({ osuText, target, min, max, step }) => {
            asked.push({ osuText, target, min, max, step });
            return { ok: true, rate: 1.15, numeric: target + 0.02, label: "Gamma mid" };
        },
    });
    const r = await h.build(req({ allowRates: true, manualProfile: MANUAL }));
    assert.equal(r.ok, true, r.message);
    const rated = r.session.items.filter((x) => x.rate !== 1);
    assert.ok(rated.length >= 4);
    assert.equal(asked.length, rated.length);
    assert.deepEqual([asked[0].min, asked[0].max, asked[0].step], [0.85, 1.4, 0.05]);
    assert.match(asked[0].osuText, /^text of osu:/);
    for (const x of rated) {
        assert.equal(x.rate, 1.15);
        assert.equal(x.estimated, false);
        assert.equal(x.danLabel, "Gamma mid");
        assert.ok(Math.abs(x.durationSec - 150 / 1.15) < 0.01);
    }
    assert.ok(events.some((e) => e.phase === "rates" && e.n === rated.length));
    // a map the search cannot place keeps the estimate
    const { h: h2 } = await setup({ maps: low, findRate: async () => ({ ok: false, reason: "base-failed" }) });
    const kept = await h2.build(req({ allowRates: true, manualProfile: MANUAL }));
    assert.ok(kept.session.items.some((x) => x.estimated));
});

test("↻ one item, saved sessions: save, list, open, delete", async () => {
    const { h } = await setup({ maps: near() });
    assert.equal((await h.reroll({ index: 0 })).ok, false, "no session yet");
    const built = await h.build(req({ manualProfile: MANUAL }));
    const i = built.session.items.findIndex((x) => x.part === "main");
    const before = built.session.items[i].mapId;
    const r = await h.reroll({ index: i });
    assert.equal(r.ok, true);
    assert.notEqual(r.session.items[i].mapId, before);
    assert.equal(r.session.items[i].part, "main");
    assert.equal((await h.reroll({ index: 99 })).ok, false);

    const s1 = await h.save({ name: "  Evening\u0007 " });
    assert.equal(s1.ok, true);
    assert.equal(s1.items[0].name, "Evening");
    const listed = await h.list();
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].items.length, r.session.items.length);
    await h.build(req({ manualProfile: MANUAL }));
    const opened = await h.open({ id: s1.id });
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.session.items.map((x) => x.mapId), r.session.items.map((x) => x.mapId));
    assert.equal(opened.session.name, "Evening");
    // ↻ works on an opened session too
    assert.equal((await h.reroll({ index: i })).ok, true);
    assert.equal((await h.open({ id: "nope" })).ok, false);
    assert.deepEqual((await h.remove({ id: s1.id })).items, []);
    assert.equal(cleanSessionName("", "fallback"), "fallback");
});

test("the osu! collection: rate copies made first, Interlude-only maps skipped, other collections kept, a backup", async () => {
    const maps = [...near(), map("jumpstream", 13.3, { interludeOnly: true }), map("jumpstream", 13.4, { interludeOnly: true })];
    const copies = [];
    const { h, dir } = await setup({
        maps,
        makeRateCopy: async ({ beatmapPath, rate }) => {
            const osuPath = path.join(dir, `copy-${copies.length}.osu`);
            await writeFile(osuPath, `copy of ${beatmapPath} at ${rate}`);
            copies.push({ beatmapPath, rate, osuPath });
            return { osuPath };
        },
    });
    assert.equal((await h.exportCollection({})).ok, false, "no session yet");
    const built = await h.build(req({ manualProfile: MANUAL, allowRates: true }));
    // one item at a rate, one only in Interlude, the rest at 1.0
    const items = built.session.items;
    items[1] = { ...items[1], rate: 1.1 };
    items[2] = { ...items[2], sources: { interlude: { hash: HASH(999) } } };
    const folder = path.join(dir, "коллекции");
    await mkdir(folder, { recursive: true });
    const old = encodeCollectionDb({ collections: [{ name: "Lunacy mania picks", hashes: ["a".repeat(32)] }] });
    await writeFile(path.join(folder, "collection.db"), old);

    const r = await h.exportCollection({ name: "My session" });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.made, copies.length);
    assert.ok(copies.some((c) => c.rate === 1.1 && c.beatmapPath === items[1].sources.stable.path));
    assert.equal(r.skipped.length, items.filter((x) => !x.sources.stable).length);
    assert.ok(r.skipped.length >= 1);
    assert.equal(r.backup, path.join(folder, "collection.db.bak"));
    assert.deepEqual(await readFile(r.backup), old);
    const db = decodeCollectionDb(await readFile(r.file));
    assert.deepEqual(db.collections.map((c) => c.name), ["Lunacy mania picks", "My session"]);
    const mine = db.collections[1].hashes;
    const copyMd5 = createHash("md5").update(await readFile(copies.find((c) => c.rate === 1.1).osuPath)).digest("hex");
    assert.ok(mine.includes(copyMd5), "the rate copy's own md5");
    assert.ok(mine.includes(items[0].sources.stable.md5));
    assert.ok(!mine.includes(items[1].sources.stable.md5), "not the 1.0 map for an item at 1.1");
    // again under the same name: replaced, not doubled
    const again = await h.exportCollection({ name: "My session" });
    assert.deepEqual(decodeCollectionDb(await readFile(again.file)).collections.map((c) => c.name), ["Lunacy mania picks", "My session"]);
    assert.deepEqual(withCollection([{ name: "a", hashes: [] }, { name: "b", hashes: [] }], "a", ["x"]).map((c) => c.name), ["b", "a"]);
});

test("the marathon: every map with its rate and slot dan, Interlude charts copied out first", async () => {
    const maps = [...Array.from({ length: 10 }, (_, i) => map("jumpstream", 13 + (i % 6) / 10, { interludeOnly: i % 2 === 0 }))];
    const made = [];
    const copied = [];
    const { h } = await setup({
        maps,
        copyOut: async (hash) => { copied.push(hash); return { path: `D:\\docs\\interlude\\${hash.slice(0, 8)}\\x.osu` }; },
        makeMarathon: async (args) => { made.push(args); return { file: "D:\\docs\\карты\\s.osz", totalMs: 600000 }; },
    });
    const built = await h.build(req({ manualProfile: MANUAL, minutes: 10 }));
    assert.equal(built.ok, true, built.message);
    const r = await h.exportMarathon({ name: "Run" });
    assert.equal(r.ok, true, r.message);
    assert.equal(made.length, 1);
    assert.equal(made[0].title, "Run");
    assert.equal(made[0].entries.length, built.session.items.length);
    assert.deepEqual(made[0].entries.map((e) => e.rate), built.session.items.map((x) => x.rate));
    assert.deepEqual(made[0].plan, built.session.items.map((x) => x.slot.dan));
    assert.equal(copied.length, built.session.items.filter((x) => !x.sources.stable).length);
    assert.ok(copied.length > 0);
});

test("recent plays: mania-tracker's by beatmap id, Interlude's by chart; avoidRecent asks for them", async () => {
    const a = map("jumpstream", 13);
    const b = map("jumpstream", 13.1, { interludeOnly: true });
    const c = map("jumpstream", 13.2);
    const nowMs = Date.UTC(2026, 9, 26);
    const ids = recentIds([a, b, c], {
        beatmaps: new Map([[a.beatmapId, { playedAt: nowMs - 2 * 86_400_000 }], [c.beatmapId, { playedAt: nowMs - 30 * 86_400_000 }]]),
        hashes: new Map([[b.sources.interlude.hash, { at: nowMs - 3600_000 }]]),
    }, nowMs);
    assert.deepEqual([...ids].sort(), [a.id, b.id].sort());

    const maps = near();
    const recent = maps.filter((m) => m.numeric >= 13 && m.numeric < 13.3);
    let asked = 0;
    const { h } = await setup({
        maps,
        played: async () => { asked += 1; return { known: true, beatmaps: new Map(recent.map((m) => [m.beatmapId, { playedAt: Date.UTC(2026, 9, 25) }])), hashes: new Map() }; },
    });
    const r = await h.build(req({ manualProfile: MANUAL, avoidRecent: true }));
    assert.equal(asked, 1);
    assert.ok(r.session.items.every((x) => !recent.some((m) => m.id === x.mapId)));
    await h.build(req({ manualProfile: MANUAL, avoidRecent: false }));
    assert.equal(asked, 1, "not asked when not wanted");
    assert.equal((await h.libraryStatus()).playedKnown, true);
});

test("the Interlude playlist takes a library chart by its hash, with the rate", () => {
    const hash = HASH(5);
    assert.deepEqual(exportItem({ hash, rate: 1.15, label: "L" }), { hash, md5: null, beatmapId: null, path: null, rate: 1.15, label: "L" });
    assert.equal(exportItem({ hash: "abc" }), null);
});

test("a session for the local profile: main's own skill, an error until it has a dan", async () => {
    setLang("en");
    const skill = { ...manualSkill(normalizeManualProfile(MANUAL)), ready: true };
    const { h } = await setup({ maps: near(), localSkill: async () => skill });
    const r = await h.build(req({ local: true }));
    assert.equal(r.ok, true, r.message);
    assert.ok(r.session.items.length >= 5);
    const { h: early } = await setup({ maps: near(), localSkill: async () => ({ ready: false }) });
    const r2 = await early.build(req({ local: true }));
    assert.equal(r2.ok, false);
    assert.equal(r2.message, t("profile.local.notEnough"));
});
