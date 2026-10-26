// The closed-loop dan targeting (0.9.8, src/gen/targeting.js) with a fake generator and a fake analyser.
import test from "node:test";
import assert from "node:assert/strict";
import { generateToTarget, BOOST_LADDER, SOFTEN, firstRung, rangeGap, suggestRate, blendBoost } from "../../src/gen/targeting.js";

const ok = (numeric) => ({ kind: "ok", numeric });
// a generator whose dan rises with the rung: plain → base, rung k → base + step × k (a half rung in between)
function fakeGenerator({ base, step = 3, cap = Infinity }) {
    const seen = [];
    const generate = async (boost) => {
        seen.push(boost);
        const rung = boost?.rung ?? 0;
        const numeric = Math.min(cap, base + step * rung);
        return { osuText: `map ${numeric}`, result: ok(numeric), reachable: false, ...(boost ? { boost } : {}) };
    };
    return { generate, seen };
}
// a fake clock: every generate takes `ms`
function clock(ms) {
    let t = 0;
    return { now: () => t, tick: () => { t += ms; } };
}

test("a map already in range is the plain one: one try, no ceiling", async () => {
    const g = fakeGenerator({ base: 13 });
    const r = await generateToTarget({ generate: g.generate, range: { lo: 12.5, hi: 13.5 } });
    assert.equal(g.seen.length, 1);
    assert.equal(g.seen[0], null);
    assert.equal(r.result.numeric, 13);
    assert.deepEqual(r.targeting, { attempts: [{ rung: 0, numeric: 13, ms: r.targeting.attempts[0].ms }], rung: 0 });
    assert.equal(r.ceiling, undefined);
});

test("a single target (no range) is never boosted", async () => {
    const g = fakeGenerator({ base: 4 });
    const r = await generateToTarget({ generate: g.generate, range: null });
    assert.equal(g.seen.length, 1);
    assert.equal(r.targeting.rung, 0);
});

test("short of the range: the rungs go up until the dan is in range, and that map wins", async () => {
    // 11 (1.5 short) → rung 1 at 12 (still short) → rung 2 at 13: in range, so rung 3 is never tried
    const g = fakeGenerator({ base: 11, step: 1 });
    const r = await generateToTarget({ generate: g.generate, range: { lo: 12.5, hi: 13.5 } });
    assert.deepEqual(g.seen.map((b) => b?.rung ?? 0), [0, 1, 2]);
    assert.equal(r.result.numeric, 13);
    assert.equal(r.targeting.rung, 2);
    assert.equal(r.ceiling, undefined);
    // 2.5 short: the gentle rung is skipped
    const far = fakeGenerator({ base: 10, step: 1.5 });
    const r2 = await generateToTarget({ generate: far.generate, range: { lo: 12.5, hi: 13.5 } });
    assert.deepEqual(far.seen.map((b) => b?.rung ?? 0), [0, 2]);
    assert.equal(r2.result.numeric, 13);
});

test("the first rung tried depends on how far short the plain map is", () => {
    assert.equal(firstRung(0.5), 0);
    assert.equal(firstRung(1.5), 0);
    assert.equal(firstRung(3), 1);
    assert.equal(firstRung(6), 2);
    assert.equal(rangeGap(12, { lo: 12.5, hi: 13.5 }), 0.5);
    assert.equal(rangeGap(14, { lo: 12.5, hi: 13.5 }), 0.5);
    assert.equal(rangeGap(13, { lo: 12.5, hi: 13.5 }), 0);
    assert.equal(rangeGap(null, { lo: 12.5, hi: 13.5 }), Infinity);
});

test("a rung that goes over the range is followed by one try halfway, and the closest map wins", async () => {
    // plain 12 (0.5 short) → rung 1 at 15 (over) → halfway (rung 0.5) at 13.5
    const g = fakeGenerator({ base: 12, step: 3 });
    const r = await generateToTarget({ generate: g.generate, range: { lo: 12.5, hi: 13.4 } });
    assert.deepEqual(g.seen.map((b) => b?.rung ?? 0), [0, 1, 0.5]);
    const half = g.seen[2];
    assert.ok(half.knobMax > 1 && half.knobMax < BOOST_LADDER[0].knobMax);
    assert.ok(half.chord > 0 && half.chord < BOOST_LADDER[0].chord);
    // 12 is 0.5 short, 15 is 1.6 over, 13.5 is 0.1 over: the half rung is the closest
    assert.equal(r.result.numeric, 13.5);
});

test("blendBoost mixes every number of two rungs; from the plain map the plain values count", () => {
    const b = blendBoost(null, BOOST_LADDER[0]);
    assert.equal(b.knobMax, (1 + BOOST_LADDER[0].knobMax) / 2);
    assert.equal(b.chord, BOOST_LADDER[0].chord / 2);
    assert.equal(b.contrast, (1 + BOOST_LADDER[0].contrast) / 2);
    assert.deepEqual(b.snaps, BOOST_LADDER[0].snaps);
    assert.equal(b.denser, false);
    const top = blendBoost(BOOST_LADDER[1], BOOST_LADDER[2]);
    assert.equal(top.denser, true);
    assert.equal(top.rung, 2.5);
});

test("still short after the top rung: the ceiling, with the lowest rate that reaches the range", async () => {
    const g = fakeGenerator({ base: 5, step: 1, cap: 9 });
    // the analyser at a rate: the map's dan grows with the rate
    const analyze = async (text, rate) => ok(Number(text.split(" ")[1]) * rate * rate);
    const r = await generateToTarget({ generate: g.generate, range: { lo: 12.5, hi: 13.5 }, analyze });
    assert.equal(r.result.numeric, 8);
    assert.equal(r.ceiling.numeric, 8);
    // 8 × 1.3² = 13.5 ≥ 12.8 (the middle − 0.2); 8 × 1.2² = 11.5 is not
    assert.equal(r.ceiling.rate, 1.3);
    assert.ok(r.ceiling.rateNumeric >= 12.8);
});

test("the ceiling says no rate when none up to 2.0x reaches the range, or there is no analyser", async () => {
    const g = fakeGenerator({ base: 2, step: 0.5 });
    const analyze = async () => ok(3);
    const r = await generateToTarget({ generate: g.generate, range: { lo: 14.5, hi: 15.5 }, analyze });
    assert.equal(r.ceiling.rate, null);
    assert.equal(await suggestRate("x", { lo: 1, hi: 2 }, null), null);
});

test("the time budget stops the climb: each next try must fit what is left", async () => {
    const c = clock(10000);
    const g = fakeGenerator({ base: 5, step: 1 });
    const generate = async (b) => { c.tick(); return g.generate(b); };
    const r = await generateToTarget({ generate, range: { lo: 14.5, hi: 15.5 }, budgetMs: 25000, now: c.now });
    // plain (10 s) + one rung (20 s); a third would end at 30 s > 25 s
    assert.equal(g.seen.length, 2);
    assert.equal(r.targeting.attempts.length, 2);
    assert.ok(r.ceiling);
});

test("far over the range: one softened try, kept when it is closer", async () => {
    const seen = [];
    const generate = async (boost) => {
        seen.push(boost);
        return { osuText: "m", result: ok(boost === SOFTEN ? 8.2 : 12), ...(boost ? { boost } : {}) };
    };
    const r = await generateToTarget({ generate, range: { lo: 7.5, hi: 8.5 } });
    assert.deepEqual(seen, [null, SOFTEN]);
    assert.equal(r.result.numeric, 8.2);
    assert.equal(r.targeting.rung, -1);
    assert.equal(r.ceiling, undefined);
});

test("just over the range is left as it is; a softened map that is no closer is dropped", async () => {
    const seen = [];
    const generate = async (boost) => { seen.push(boost); return { osuText: "m", result: ok(boost ? 4 : 8.7) }; };
    const just = await generateToTarget({ generate, range: { lo: 7.5, hi: 8.5 } });
    assert.equal(seen.length, 1);
    assert.equal(just.result.numeric, 8.7);
    seen.length = 0;
    const generate2 = async (boost) => { seen.push(boost); return { osuText: "m", result: ok(boost ? 4 : 10) }; };
    const far = await generateToTarget({ generate: generate2, range: { lo: 7.5, hi: 8.5 } });
    assert.equal(seen.length, 2);
    assert.equal(far.result.numeric, 10);
});

test("onRung hears every boosted try; a map the analyser cannot rate is not boosted", async () => {
    const heard = [];
    const g = fakeGenerator({ base: 7 });
    await generateToTarget({ generate: g.generate, range: { lo: 12.5, hi: 13.5 }, onRung: (b) => heard.push(b.rung) });
    assert.deepEqual(heard, g.seen.slice(1).map((b) => b.rung));
    const none = await generateToTarget({ generate: async () => ({ result: { kind: "too-short" } }), range: { lo: 1, hi: 2 } });
    assert.equal(none.targeting.attempts.length, 1);
});

test("no ceiling is claimed when the top rung was never tried (the budget ran out) or a try went over the range", async () => {
    const c = clock(10000);
    const g = fakeGenerator({ base: 10, step: 0.5 });
    const generate = async (b) => { c.tick(); return g.generate(b); };
    // 3 short: rung 2 first; the budget has room for it but not for rung 3
    const r = await generateToTarget({ generate, range: { lo: 13, hi: 14 }, budgetMs: 25000, now: c.now, analyze: async () => ok(20) });
    assert.deepEqual(g.seen.map((b) => b?.rung ?? 0), [0, 2]);
    assert.equal(r.ceiling, undefined);
    // rung 1 goes over, the half falls short and is kept as the closest: the song can reach the range, so no ceiling
    const seen = [];
    const values = { 0: 12, 1: 15.5, 0.5: 12.4 };
    const r2 = await generateToTarget({
        generate: async (b) => { seen.push(b?.rung ?? 0); return { osuText: "m", result: ok(values[b?.rung ?? 0]), ...(b ? { boost: b } : {}) }; },
        range: { lo: 12.5, hi: 13.5 }, analyze: async () => ok(20),
    });
    assert.deepEqual(seen, [0, 1, 0.5]);
    assert.equal(r2.result.numeric, 12.4);
    assert.equal(r2.ceiling, undefined);
});
