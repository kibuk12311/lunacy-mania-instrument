// The local profile's skill model (src/localProfile/model.js): the performance dan of one play, which patterns and
// axes a map is evidence for, the aggregate per key (top plays, 0.95^i, best play per map, fading, minimum evidence,
// ± and confidence), the incremental model against a batch, the overall dan and the daily history.
import test from "node:test";
import assert from "node:assert/strict";
import {
    MODEL, AXES, PATTERNS, DAY_MS, accuracyOf, accuracyAdjust, performanceDan, attribution, aggregate,
    createSkillModel, skillFromPlays, dailySkill,
} from "../../src/localProfile/model.js";
import { playerDanFor } from "../../src/recommend/skill.js";

const NOW = Date.UTC(2026, 9, 26, 12);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
// judgements giving an exact stable accuracy: MAX/300 count 300, n200 counts 200
const hitsFor = (accPct, total = 1000) => {
    const n200 = Math.round(((100 - accPct) / 100) * 3 * total);
    return { max: total - n200, n300: 0, n200, n100: 0, n50: 0, miss: 0 };
};
const map = (numeric, top3 = [{ name: "Jumpstream", share: 0.6 }, { name: "Handstream", share: 0.4 }], extra = {}) => ({
    kind: "ok", numeric, top3, tech: false, durationSec: 100, ...extra,
});

test("accuracy: stable mania accuracy from the judgements", () => {
    assert.equal(accuracyOf(null), null);
    assert.equal(accuracyOf({ max: 10, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }), 100);
    close(accuracyOf({ max: 1, n300: 1, n200: 1, n100: 1, n50: 0, miss: 1 }), (100 * (300 + 300 + 200 + 100)) / 1500);
});

test("accuracy adjustment: full credit at the reference, a little more near perfect, steadily less below", () => {
    assert.equal(accuracyAdjust(MODEL.REF_ACC), 0);
    close(accuracyAdjust(98), 1.5 * MODEL.ABOVE_SLOPE);
    assert.equal(accuracyAdjust(100), MODEL.ABOVE_MAX);
    close(accuracyAdjust(95.5), -MODEL.BELOW_SLOPE);
    close(accuracyAdjust(MODEL.KNEE_ACC), -(MODEL.REF_ACC - MODEL.KNEE_ACC) * MODEL.BELOW_SLOPE);
    close(accuracyAdjust(92), -0.7 - MODEL.STEEP_SLOPE);
    assert.equal(accuracyAdjust(50), MODEL.FLOOR);
    // monotone
    let prev = -Infinity;
    for (let a = 80; a <= 100; a += 0.25) {
        const v = accuracyAdjust(a);
        assert.ok(v >= prev, `not monotone at ${a}`);
        prev = v;
    }
});

test("performance dan: the map's dan moved by accuracy and misses; fails, quits, autoplay and unrated maps are no evidence", () => {
    const play = { outcome: "pass", hits: hitsFor(MODEL.REF_ACC), mods: [] };
    assert.equal(performanceDan(play, map(13.4)).dan, 13.4);
    assert.equal(performanceDan(play, map(13.4)).quality, 1);
    const sloppy = performanceDan({ ...play, hits: hitsFor(94.5) }, map(13.4));
    close(sloppy.dan, Math.round((13.4 - 2 * MODEL.BELOW_SLOPE) * 100) / 100);
    // 2% misses on top: −0.2 more
    const missy = { ...play, hits: { max: 980, n300: 0, n200: 0, n100: 0, n50: 0, miss: 20 } };
    const r = performanceDan(missy, map(13));
    close(r.adjust, Math.round((accuracyAdjust(98) - 0.02 * MODEL.MISS_SLOPE) * 100) / 100);
    assert.equal(performanceDan({ ...play, outcome: "fail" }, map(13.4)), null);
    assert.equal(performanceDan({ ...play, outcome: "quit" }, map(13.4)), null);
    assert.equal(performanceDan({ ...play, mods: ["AT"] }, map(13.4)), null);
    assert.equal(performanceDan(play, { kind: "not-rice" }), null);
    assert.equal(performanceDan(play, null), null);
    // a pass without judgements (Interlude): "passed it", weaker
    const blind = performanceDan({ outcome: "pass", hits: null, accuracy: null, mods: [] }, map(14));
    assert.deepEqual([blind.dan, blind.quality], [14 + MODEL.NO_ACC_CREDIT, MODEL.NO_ACC_QUALITY]);
    // an accuracy without judgements (a fraction) is used as is
    close(performanceDan({ outcome: "pass", hits: null, accuracy: 0.965, mods: [] }, map(12)).dan, 12);
});

test("attribution: the pattern shares, tech, length, and the axes they make", () => {
    const a = attribution(map(13));
    assert.deepEqual(a.patterns, { jumpstream: 0.6, handstream: 0.4 });
    assert.deepEqual(a.axes, { stamina: 1 });
    // LeoBlack names map through the generator's families: Rolls → stream, Chordjacks → chordjack, Jacks → jack
    const mixed = attribution(map(13, [{ name: "Rolls", share: 0.5 }, { name: "Chordjacks", share: 0.3 }, { name: "Jacks", share: 0.2 }]));
    assert.deepEqual(mixed.patterns, { stream: 0.5, chordjack: 0.3, jack: 0.2 });
    assert.deepEqual(mixed.axes, { speed: 0.5, jack: 0.5 });
    // tech: TECH_SHARE of it is Tech
    const tech = attribution(map(13, [{ name: "Stream", share: 1 }], { tech: true }));
    assert.deepEqual(tech.patterns, { stream: 1 - MODEL.TECH_SHARE, tech: MODEL.TECH_SHARE });
    assert.deepEqual(tech.axes, { speed: 0.6, tech: 0.4 });
    // a long map is partly Stamina: half way between 2:00 and 6:00 → a quarter
    const long = attribution(map(13, [{ name: "Stream", share: 1 }], { durationSec: 240 }));
    assert.deepEqual(long.patterns, { stream: 0.75, stamina: 0.25 });
    assert.deepEqual(long.axes, { speed: 0.75, stamina: 0.25 });
    // no named pattern: the strongest MinaCalc skillset
    const msd = attribution({ kind: "ok", numeric: 13, top3: [], msd: { stream: 20, chordjack: 27, jackspeed: 22 } });
    assert.deepEqual(msd.patterns, { chordjack: 1 });
    assert.deepEqual(attribution({ kind: "ok", numeric: 13 }), { patterns: {}, axes: {} });
    for (const x of [a, mixed, tech, long]) close(Object.values(x.axes).reduce((s, w) => s + w, 0), 1, 1e-6);
});

const item = (dan, i, extra = {}) => ({ dan, share: 1, quality: 1, at: NOW - i * 1000, mapKey: `m${i}`, playId: `p${i}`, ...extra });

test("aggregate: the weighted mean of the top plays, 0.95^i, one per map, at most TOP_N", () => {
    const items = [item(14, 0), item(13, 1), item(12, 2)];
    const r = aggregate(items, NOW);
    const w = [1, 0.95, 0.95 ** 2];
    close(r.dan, Math.round(((14 * w[0] + 13 * w[1] + 12 * w[2]) / (w[0] + w[1] + w[2])) * 100) / 100);
    assert.deepEqual(r.top.map((x) => x.playId), ["p0", "p1", "p2"]);
    assert.equal(r.maps, 3);
    // the same map twice: only its best play counts
    const again = aggregate([...items, item(11, 3, { mapKey: "m0" })], NOW);
    assert.equal(again.dan, r.dan);
    assert.equal(again.maps, 3);
    // 30 maps: only TOP_N, the best ones
    const many = aggregate(Array.from({ length: 30 }, (_, i) => item(20 - i * 0.1, i)), NOW);
    assert.equal(many.top.length, MODEL.TOP_N);
    assert.equal(many.top.at(-1).playId, `p${MODEL.TOP_N - 1}`);
    // warm-ups: plays more than WARMUP_BELOW under the third best are left out
    const warm = aggregate([item(14, 0), item(14, 1), item(13.8, 2), item(11.7, 3), item(9, 4)], NOW);
    assert.deepEqual(warm.top.map((x) => x.playId), ["p0", "p1", "p2"]);
    // a share under MIN_SHARE is no evidence for the key
    assert.equal(aggregate([item(14, 0, { share: 0.1 })], NOW).maps, 0);
});

test("aggregate: minimum evidence, then a ± range that narrows and a confidence that grows", () => {
    const two = aggregate([item(13, 0), item(13, 1)], NOW);
    assert.equal(two.dan, null, "two maps are not enough");
    assert.equal(two.confidence, "none");
    const weak = aggregate([0, 1, 2, 3].map((i) => item(13, i, { share: 0.3 })), NOW);
    assert.equal(weak.dan, null, "four maps at 30% are less than MIN_EVIDENCE");
    const three = aggregate([0, 1, 2].map((i) => item(13, i)), NOW);
    assert.equal(three.dan, 13);
    assert.equal(three.confidence, "low");
    close(three.halfWidth, Math.round((MODEL.SPREAD / Math.sqrt(3)) * 100) / 100);
    const twelve = aggregate(Array.from({ length: 12 }, (_, i) => item(13, i)), NOW);
    assert.equal(twelve.confidence, "high");
    assert.ok(twelve.halfWidth < three.halfWidth);
});

test("aggregate: old plays fade — a year past the grace counts FADE_PER_YEAR less, and new plays win the order", () => {
    const year = 365 * DAY_MS;
    const old = [0, 1, 2].map((i) => item(15, i, { at: NOW - year - MODEL.GRACE_DAYS * DAY_MS }));
    const r = aggregate(old, NOW);
    close(r.dan, 15 - MODEL.FADE_PER_YEAR, 0.01);
    assert.ok(r.evidence < 3 * 0.5, "evidence halves every HALF_LIFE_DAYS");
    assert.equal(r.confidence, "low");
    assert.ok(r.halfWidth > aggregate([0, 1, 2].map((i) => item(15, i)), NOW).halfWidth, "an old history is less sure");
    // plays in the future of `now` (a history point) do not count
    assert.equal(aggregate([item(13, 0, { at: NOW + 1 })], NOW).maps, 0);
    // recent 14.7s outrank 15s from three years ago
    const mixed = aggregate([...[0, 1, 2].map((i) => item(15, i, { at: NOW - 3 * year })), ...[3, 4, 5].map((i) => item(14.7, i))], NOW);
    assert.deepEqual(mixed.top.slice(0, 3).map((x) => x.playId).sort(), ["p3", "p4", "p5"]);
});

// a play of the right shape on a map that is all one pattern
let n = 0;
function playOn(pattern, mapDan, { acc = MODEL.REF_ACC, at = NOW - 1000, outcome = "pass" } = {}) {
    n += 1;
    const key = `${String(n).padStart(32, "0")}@1.00`;
    const names = { stream: "Stream", jumpstream: "Jumpstream", handstream: "Handstream", chordjack: "Chordjacks", jack: "Jacks" };
    const m = pattern === "tech" ? map(mapDan, [{ name: "Stream", share: 1 }], { tech: true }) : map(mapDan, [{ name: names[pattern], share: 1 }]);
    return { play: { id: `p${n}`, mapKey: key, at, outcome, hits: hitsFor(acc), mods: [] }, map: m };
}

test("skill: overall is the mean of the four axes; an axis without enough plays is null and playerDanFor falls back", () => {
    const plays = [
        ...[0, 1, 2].map(() => playOn("stream", 14)),
        ...[0, 1, 2].map(() => playOn("jumpstream", 13)),
        ...[0, 1, 2].map(() => playOn("chordjack", 12.5)),
    ];
    const maps = new Map(plays.map((p) => [p.play.mapKey, p.map]));
    const k = skillFromPlays(plays.map((p) => p.play), (key) => maps.get(key), NOW);
    assert.equal(k.local, true);
    assert.deepEqual(k.tiles, { speed: 14, jack: 12.5, stamina: 13, tech: null });
    assert.equal(k.overall, 13.17);
    assert.equal(k.partial, true);
    assert.equal(k.ready, true);
    assert.equal(k.analyzedPlays, 9);
    assert.equal(k.patterns.stream.dan, 14);
    assert.equal(k.patterns.tech.dan, null);
    assert.deepEqual(playerDanFor(k, "tech"), { dan: 13.17, source: "overall", tile: "tech" });
    assert.deepEqual(playerDanFor(k, "stream"), { dan: 14, source: "tile", tile: "speed" });
    const empty = skillFromPlays([], () => null, NOW);
    assert.equal(empty.ready, false);
    assert.equal(empty.overall, null);
});

test("skill: adding plays one at a time gives the same answer as all at once, and a play is counted once", () => {
    const plays = [];
    for (const p of ["stream", "jumpstream", "handstream", "chordjack", "jack", "tech"]) {
        for (const [i, acc] of [95, 97, 99, 92, 96, 98].entries()) plays.push(playOn(p, 12 + i * 0.4, { acc, at: NOW - (i + 1) * DAY_MS * 10 }));
    }
    plays.push(playOn("stream", 16, { outcome: "fail" }));
    const maps = new Map(plays.map((p) => [p.play.mapKey, p.map]));
    const batch = skillFromPlays(plays.map((p) => p.play), (k) => maps.get(k), NOW);
    const model = createSkillModel();
    for (const p of [...plays].reverse()) model.add(p.play, p.map);
    assert.equal(model.add(plays[0].play, plays[0].map), null, "the same play twice");
    assert.deepEqual(model.skill(NOW), batch);
    assert.equal(batch.totalPlays, plays.length);
    assert.equal(batch.analyzedPlays, plays.length - 1, "the fail is no evidence");
    for (const a of AXES) assert.ok(batch.axes[a].dan !== null, a);
    for (const p of PATTERNS.filter((x) => x !== "stamina")) assert.ok(batch.patterns[p].dan !== null, p);
});

test("daily history: one point per day with plays, the skill as of that day's end", () => {
    const plays = [
        playOn("stream", 13, { at: NOW - 3 * DAY_MS }), playOn("stream", 13, { at: NOW - 3 * DAY_MS + 1 }), playOn("stream", 13, { at: NOW - 3 * DAY_MS + 2 }),
        playOn("stream", 15, { at: NOW - DAY_MS }), playOn("stream", 15, { at: NOW - DAY_MS + 1 }),
    ];
    const maps = new Map(plays.map((p) => [p.play.mapKey, p.map]));
    const points = dailySkill(plays.map((p) => p.play), (k) => maps.get(k), { to: NOW });
    assert.equal(points.length, 2);
    assert.equal(points[0].ratings.speed, 13);
    assert.ok(points[1].ratings.speed > 13);
    assert.equal(points[1].ratings["p:stream"], points[1].ratings.speed);
    // a period starting between them: the earlier day opens the line at the period's start
    const from = NOW - 2 * DAY_MS;
    const cut = dailySkill(plays.map((p) => p.play), (k) => maps.get(k), { from, to: NOW });
    assert.equal(cut[0].at, from);
    assert.equal(cut.length, 2);
    // at most maxPoints, the last day kept
    const lots = Array.from({ length: 40 }, (_, i) => playOn("stream", 13, { at: NOW - i * DAY_MS }));
    const lotsMaps = new Map(lots.map((p) => [p.play.mapKey, p.map]));
    const few = dailySkill(lots.map((p) => p.play), (k) => lotsMaps.get(k), { to: NOW, maxPoints: 10 });
    // (the first day alone has too few plays for a dan, so it has no point)
    assert.ok(few.length <= 10 && few.length >= 9, String(few.length));
    assert.ok(few.at(-1).at >= NOW - 1000);
});
