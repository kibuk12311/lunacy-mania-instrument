// The session builder (src/recommend/session.js): warm-up → main → push → cool-down about as long as asked, from the
// player's own analysed maps, for their skill and goal; rates when allowed, no map twice, songs varied, recent plays
// left out, ↻ for one item, and the refusals (no maps, nothing near the target).
import test from "node:test";
import assert from "node:assert/strict";
import {
    buildSession, rerollItem, cleanSessionRequest, patternFit, mapPatterns, rateFor, seeded, sessionSeconds, sessionName, RATE, PARTS,
} from "../src/recommend/session.js";
import { manualSkill } from "../src/recommend/manualProfile.js";
import { setLang } from "../src/i18n/i18n.js";

const FAMILY_NAME = { stream: "Stream", jumpstream: "Jumpstream", handstream: "Handstream", chordjack: "Chordjacks", jack: "Jacks" };
let nextId = 0;
// one analysed map of the library
function map(pattern, numeric, durationSec = 150, extra = {}) {
    nextId += 1;
    const tech = pattern === "tech";
    const name = tech ? "Jumptrill" : FAMILY_NAME[pattern];
    return {
        id: `osu:${String(nextId).padStart(32, "0")}`, artist: `Artist ${nextId}`, title: `Song ${nextId}`, version: `${pattern} ${numeric}`,
        creator: "M", numeric, label: "x", primary: name, top3: [{ name, share: 0.7 }, { name: "Stream", share: 0.2 }], tech, durationSec, bpm: 180,
        beatmapId: 5000 + nextId, sources: { stable: { path: `C:\\fake\\${nextId}.osu`, md5: String(nextId).padStart(32, "a") } }, ...extra,
    };
}
// a library around Gamma: every pattern, dans 10…17 in steps of 0.1, lengths 1:40 … 3:40
function library() {
    const out = [];
    for (const pattern of ["stream", "jumpstream", "handstream", "chordjack", "jack", "tech"]) {
        for (let d = 100; d <= 170; d += 1) out.push(map(pattern, d / 10, 100 + ((d * 37) % 120)));
    }
    return out;
}
const MAPS = library();
// Stamina Gamma mid (13.2): jumpstream's tile
const SKILL = manualSkill({ name: "TestPlayer", speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 });
const request = (patch = {}) => cleanSessionRequest({ minutes: 30, patternIds: ["jumpstream"], goalId: "growth", allowRates: false, avoidRecent: false, ...patch });
const byId = new Map(MAPS.map((m) => [m.id, m]));

test("cleanSessionRequest: length, at least one pattern (no upper limit), a goal", () => {
    setLang("en");
    assert.deepEqual(cleanSessionRequest({ minutes: 45, patternIds: ["stream", "stream", "jack"], goalId: "comfort", allowRates: 1 }),
        { minutes: 45, patternIds: ["stream", "jack"], goalId: "comfort", allowRates: true, avoidRecent: false });
    assert.match(cleanSessionRequest({ minutes: 5, patternIds: ["stream"], goalId: "growth" }), /10 to 180 minutes/);
    assert.match(cleanSessionRequest({ minutes: 30.5, patternIds: ["stream"], goalId: "growth" }), /minutes/);
    assert.match(cleanSessionRequest({ minutes: 30, patternIds: [], goalId: "growth" }), /at least one pattern/);
    assert.match(cleanSessionRequest({ minutes: 30, patternIds: ["a", "b"], goalId: "growth" }), /at least one pattern/);
    const all = ["stream", "jumpstream", "handstream", "stamina", "chordjack", "jack", "tech", "quadstream", "handjack", "speedjack"];
    assert.deepEqual(cleanSessionRequest({ minutes: 30, patternIds: all, goalId: "growth" }).patternIds, all);
    assert.equal(typeof cleanSessionRequest({ minutes: 30, patternIds: ["stream"], goalId: "custom" }), "string");
    setLang("ru");
});

test("a 30-minute growth session: warm-up → main → push → cool-down, about 30 minutes, no map twice", () => {
    const s = buildSession({ maps: MAPS, request: request(), skill: SKILL, seed: 7 });
    assert.equal(s.ok, true, s.message);
    const parts = s.items.map((x) => x.part);
    // in order, each part at least once
    assert.deepEqual([...new Set(parts)], PARTS);
    assert.deepEqual(parts, [...parts].sort((a, b) => PARTS.indexOf(a) - PARTS.indexOf(b)));
    assert.equal(parts.filter((p) => p === "push").length, 1);
    assert.equal(parts.filter((p) => p === "cooldown").length, 1);
    assert.ok(s.totalSec >= 30 * 60 * 0.85 && s.totalSec <= 30 * 60 * 1.15, `total ${s.totalSec}`);
    assert.equal(s.totalSec, sessionSeconds(s.items));
    assert.equal(new Set(s.items.map((x) => x.mapId)).size, s.items.length, "no map twice");
    // the window: Stamina 13.2 + growth [0, 0.5]
    const [tg] = s.targets;
    assert.deepEqual([tg.playerDan, tg.lo, tg.hi, tg.handSet], [13.2, 13.2, 13.7, true]);
    for (const x of s.items.filter((i) => i.part === "main")) {
        assert.ok(x.dan >= tg.lo - 0.35 && x.dan <= tg.hi + 0.35, `main ${x.dan}`);
        const m = byId.get(x.mapId);
        assert.ok(patternFit(m, "jumpstream") > 0 || x.slot.variety, `main pattern ${m.version}`);
    }
    for (const x of s.items.filter((i) => i.part === "warmup")) assert.ok(x.dan < tg.lo, `warm-up ${x.dan}`);
    const push = s.items.find((x) => x.part === "push");
    assert.ok(push.dan > tg.hi, `push ${push.dan}`);
    assert.ok(s.items.at(-1).dan < tg.playerDan, "cool-down below the player's dan");
    // every item carries what the page shows and the exports need
    const first = s.items[0];
    for (const key of ["artist", "title", "version", "danLabel", "durationSec", "rate", "patternId", "sources", "slot"]) assert.ok(key in first, key);
    assert.equal(s.items.every((x) => x.rate === 1), true, "no rates unless allowed");
    assert.deepEqual(s.notes, []);
});

test("the length asked for: 20 and 60 minutes; 60 has two pushes; the warm-up grows with it", () => {
    const short = buildSession({ maps: MAPS, request: request({ minutes: 20 }), skill: SKILL, seed: 3 });
    const long = buildSession({ maps: MAPS, request: request({ minutes: 60 }), skill: SKILL, seed: 3 });
    assert.ok(Math.abs(short.totalSec - 1200) < 200, `20 min → ${short.totalSec}`);
    assert.ok(Math.abs(long.totalSec - 3600) < 200, `60 min → ${long.totalSec}`);
    assert.equal(long.items.filter((x) => x.part === "push").length, 2);
    assert.ok(long.items.filter((x) => x.part === "warmup").length > short.items.filter((x) => x.part === "warmup").length);
});

test("the skill decides the dans: the pattern's tile, the goal's window", () => {
    const strong = manualSkill({ speed: 16, jack: 12, stamina: 15, tech: 14 });
    const js = buildSession({ maps: MAPS, request: request({ goalId: "challenge" }), skill: strong, seed: 1 });
    assert.deepEqual([js.targets[0].lo, js.targets[0].hi], [15.5, 16.2], "stamina 15 + challenge [0.5, 1.2]");
    const jack = buildSession({ maps: MAPS, request: request({ patternIds: ["jack"], goalId: "comfort" }), skill: strong, seed: 1 });
    assert.deepEqual([jack.targets[0].lo, jack.targets[0].hi], [11.4, 11.9], "jack 12 + comfort");
    for (const x of jack.items.filter((i) => i.part === "main")) assert.ok(x.dan < 12.3);
    // two focus patterns take turns in the main block, each at its own tile
    const two = buildSession({ maps: MAPS, request: request({ patternIds: ["stream", "chordjack"] }), skill: SKILL, seed: 5 });
    assert.deepEqual(two.targets.map((x) => x.patternId), ["stream", "chordjack"]);
    const main = two.items.filter((x) => x.part === "main");
    assert.ok(main.some((x) => x.slot.patternIds[0] === "stream") && main.some((x) => x.slot.patternIds[0] === "chordjack"));
    for (const x of main) {
        const tg = two.targets.find((g) => g.patternId === x.slot.patternIds[0]);
        assert.ok(x.dan >= tg.lo - 0.35 && x.dan <= tg.hi + 0.35);
    }
    // a mania-tracker skill reads the same way; no skill at all is refused
    const tracker = { tiles: { speed: 14, stamina: 13.5, tech: 13, jack: 13 }, overall: 13.4, msd: {} };
    assert.equal(buildSession({ maps: MAPS, request: request(), skill: tracker, seed: 1 }).targets[0].playerDan, 13.5);
    assert.throws(() => buildSession({ maps: MAPS, request: request(), skill: null, seed: 1 }));
    assert.equal(buildSession({ maps: MAPS, request: request(), manualDan: 12, seed: 1 }).targets[0].playerDan, 12);
});

test("rates: maps below the target are taken at a rate that reaches it (estimated), shorter for it", () => {
    // only maps around 12.0: nothing in a 13.2–13.7 window at 1.0
    const low = Array.from({ length: 40 }, (_, i) => map("jumpstream", 11.8 + (i % 5) / 10, 150));
    const without = buildSession({ maps: low, request: request(), skill: SKILL, seed: 2 });
    assert.equal(without.ok, false);
    assert.equal(without.reason, "nothingNear");
    assert.match(without.message, /13\.20/);
    const rated = buildSession({ maps: low, request: request({ allowRates: true }), skill: SKILL, seed: 2 });
    assert.equal(rated.ok, true, rated.message);
    const main = rated.items.filter((x) => x.part === "main");
    assert.ok(main.length >= 5);
    for (const x of main) {
        assert.ok(x.rate > 1 && x.rate <= RATE.max, `rate ${x.rate}`);
        assert.equal(x.estimated, true);
        assert.ok(Math.abs(x.durationSec - 150 / x.rate) < 0.01);
        assert.ok(Math.abs(x.dan - x.baseDan - (x.rate - 1) * 10) < 1e-6);
    }
    // the rate grid: 0.05 steps inside the range, 1.0 when already close
    assert.deepEqual(rateFor(12, 13.2, true), { rate: 1.1, dan: 13, estimated: true });
    assert.deepEqual(rateFor(13.1, 13.2, true), { rate: 1, dan: 13.1, estimated: false });
    assert.deepEqual(rateFor(5, 13.2, true).rate, RATE.max);
    assert.deepEqual(rateFor(12, 13.2, false), { rate: 1, dan: 12, estimated: false });
});

test("recently played maps are left out when asked", () => {
    const near = MAPS.filter((m) => m.numeric >= 13 && m.numeric <= 14 && patternFit(m, "jumpstream") >= 1).map((m) => m.id);
    const recent = new Set(near.slice(0, Math.ceil(near.length / 2)));
    const s = buildSession({ maps: MAPS, request: request({ avoidRecent: true }), skill: SKILL, recent, seed: 4 });
    assert.ok(s.items.every((x) => !recent.has(x.mapId)));
    const all = buildSession({ maps: MAPS, request: request({ avoidRecent: false }), skill: SKILL, recent, seed: 4 });
    assert.ok(all.items.some((x) => recent.has(x.mapId)), "not asked: they may come back");
});

test("songs are varied: another difficulty of a song already in the session comes last", () => {
    // ten songs, each with eight difficulties around the window
    const maps = [];
    for (let song = 0; song < 10; song++) {
        for (let d = 0; d < 8; d++) maps.push(map("jumpstream", 12 + d * 0.25, 150, { artist: `Band ${song}`, title: `Tune ${song}` }));
    }
    const s = buildSession({ maps, request: request({ minutes: 20 }), skill: SKILL, seed: 9 });
    const songs = s.items.map((x) => `${x.artist}|${x.title}`);
    assert.ok(new Set(songs).size >= Math.min(10, songs.length) - 1, `songs ${songs.join(", ")}`);
});

test("one seed builds the same session; ↻ on one item takes another map for the same place", () => {
    const a = buildSession({ maps: MAPS, request: request(), skill: SKILL, seed: 11 });
    const b = buildSession({ maps: MAPS, request: request(), skill: SKILL, seed: 11 });
    assert.deepEqual(a.items.map((x) => x.mapId), b.items.map((x) => x.mapId));
    const i = a.items.findIndex((x) => x.part === "main");
    const shown = [];
    for (let k = 0; k < 3; k++) {
        const item = rerollItem({ maps: MAPS, session: a, index: i, request: request(), shown, seed: 20 + k });
        assert.ok(item);
        assert.equal(item.part, "main");
        assert.deepEqual(item.slot, a.items[i].slot);
        assert.ok(!a.items.some((x) => x.mapId === item.mapId), "not a map of the session");
        assert.ok(!shown.includes(item.mapId), "not one shown there before");
        shown.push(item.mapId);
    }
    assert.equal(rerollItem({ maps: MAPS, session: a, index: 999, request: request() }), null);
    // nothing else fits: null
    const only = a.items.map((x) => byId.get(x.mapId));
    assert.equal(rerollItem({ maps: only, session: a, index: i, request: request(), seed: 1 }), null);
});

test("edge cases: no maps, too few for the length", () => {
    setLang("en");
    const none = buildSession({ maps: [], request: request(), skill: SKILL });
    assert.deepEqual([none.ok, none.reason], [false, "empty"]);
    // unanalysed entries (no dan) do not count
    assert.equal(buildSession({ maps: [{ id: "osu:x", numeric: null }], request: request(), skill: SKILL }).reason, "empty");
    const few = [map("jumpstream", 13.4, 150), map("jumpstream", 13.5, 150), map("stream", 12.4, 150)];
    const s = buildSession({ maps: few, request: request({ minutes: 60 }), skill: SKILL, seed: 1 });
    assert.equal(s.ok, true);
    assert.ok(s.notes.includes("short"));
    assert.ok(s.totalSec < 3600 * 0.75);
    assert.equal(new Set(s.items.map((x) => x.mapId)).size, s.items.length);
    setLang("ru");
});

test("patterns of a map: main family, tech, stamina by length, a kind the finder names", () => {
    const js = map("jumpstream", 13);
    assert.equal(mapPatterns(js).main, "jumpstream");
    assert.equal(patternFit(js, "jumpstream"), 1);
    assert.equal(patternFit(js, "stream"), 0, "a side of 0.2 is not enough");
    assert.equal(patternFit({ ...js, top3: [{ name: "Jumpstream", share: 0.6 }, { name: "Handstream", share: 0.3 }] }, "handstream"), 0.6);
    assert.equal(patternFit(map("tech", 13), "tech"), 1);
    assert.equal(patternFit(js, "stamina"), 0, "2:30 is no stamina map");
    assert.equal(patternFit(map("jumpstream", 13, 300), "stamina"), 1);
    const quad = { ...map("chordjack", 13), top3: [{ name: "Quadstream", share: 0.5 }, { name: "Chordjacks", share: 0.4 }] };
    assert.equal(patternFit(quad, "quadstream"), 1);
    assert.equal(patternFit(map("chordjack", 13), "quadstream"), 0);
    assert.equal(patternFit(map("chordjack", 13), "handjack"), 1, "a kind the finder has no name for goes by its parent");
    assert.equal(seeded(5)(), seeded(5)());
});

test("the default name says the date, the patterns and the length", () => {
    setLang("en");
    assert.equal(sessionName({ patternIds: ["jumpstream", "stream"], minutes: 45 }, new Date(2026, 9, 26)), "Session 26.10 · Jumpstream + Stream 45 min");
    setLang("ru");
    assert.equal(sessionName({ patternIds: ["jack"], minutes: 30 }, new Date(2026, 0, 5)), "Сессия 05.01 · Джек 30 мин");
});
