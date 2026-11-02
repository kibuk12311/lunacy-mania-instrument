// src/interlude/judge.js against the golden cases of Prelude's own tests (prelude/tests: GameplayEventProcessorTests,
// ScoreProcessorTests, RulesetOsuParityTests, RulesetQuaverParityTests, LampTests, GradeTests; MIT), on charts and
// replays built in the test the way those tests build theirs. Times there are ms of the chart from the first note.
import test from "node:test";
import assert from "node:assert/strict";
import { judgeIlReplay, lampOf, gradeOf, wife3Points, exactExp } from "../../src/interlude/judge.js";
import { parseRuleset, SC_J4 } from "../../src/interlude/ruleset.js";
import { chartBuilder, replayBuilder, framesOf } from "../fixtures/makeIlReplay.js";
import { osuRuleset, wife3Json, quaverJson, simpleJson, rulesetJson } from "./rulesets.js";

const f = Math.fround;
const SC4 = SC_J4;
const OD8 = osuRuleset(8);
const OD10 = osuRuleset(10);
const W3 = parseRuleset(wife3Json(4));
const QV = parseRuleset(quaverJson());
const SIMPLE = (hold) => parseRuleset(simpleJson(hold));
// the same ruleset with another note priority, as the tests' `{ ... with NotePriority = ... }`
const withPriority = (ruleset, kind) => ({ ...ruleset, notePriority: { kind } });

const notes = () => chartBuilder(4);
const replay = () => replayBuilder();
const judge = (ruleset, chart, frames, rate = 1) => judgeIlReplay({ ruleset, chart: chart.build(), frames: frames.build(), rate });
const n = (x) => (Number.isInteger(x) ? String(x) : String(+x.toFixed(4)));
const fmt = (e) => {
    if (e.kind === "HIT" || e.kind === "HOLD") return `${e.kind}(${n(e.delta)},${e.missed})`;
    if (e.kind === "RELEASE") return `RELEASE(${n(e.delta)},${e.missed},${e.overhold},${e.dropped})`;
    return e.kind;
};
const events = (ruleset, chart, frames, rate = 1) => judge(ruleset, chart, frames, rate).events.map(fmt);
const REL = (...a) => `RELEASE(${a.join(",")})`;
const hold1 = () => notes().hold(0, 1000);

test("tap notes: offsets pass through, early and late", () => {
    assert.deepEqual(events(SC4, notes().note(0).note(1000).note(2000).note(3000), replay().downFor(0, 250).downFor(1010, 250).downFor(2020, 250).downFor(3030, 250)), ["HIT(0,false)", "HIT(10,false)", "HIT(20,false)", "HIT(30,false)"]);
    assert.deepEqual(events(SC4, notes().note(0).note(1000).note(2000).note(3000), replay().downFor(0, 250).downFor(990, 250).downFor(1980, 250).downFor(2970, 250)), ["HIT(0,false)", "HIT(-10,false)", "HIT(-20,false)", "HIT(-30,false)"]);
});

test("Interlude's cbrush window eats an input; osu!mania's priority takes the earliest note", () => {
    const chart = () => notes().note(0).note(180);
    assert.deepEqual(events(SC4, chart(), replay().downFor(-180, 30).downFor(0, 30)), ["HIT(-180,false)", "HIT(180,true)"]);
    assert.deepEqual(events(SC4, chart(), replay().downFor(180, 30).downFor(360, 30)), ["HIT(0,false)", "HIT(180,true)", "GHOST_TAP"]);
    const osu = withPriority(SC4, "osuMania");
    assert.deepEqual(events(osu, chart(), replay().downFor(-180, 30).downFor(0, 30)), ["HIT(-180,false)", "HIT(-180,false)"]);
    assert.deepEqual(events(osu, chart(), replay().downFor(180, 30).downFor(360, 30)), ["HIT(180,false)", "HIT(180,false)"]);
});

test("split chords: each column its own note, columns in order within a frame", () => {
    const chart = notes();
    for (const t of [0, 1000]) for (let k = 0; k < 4; k += 1) chart.note(t, k);
    const frames = replay().down(-20, 0).down(-5, 1).down(5, 2).down(20, 3).up(50, 0).up(50, 1).up(50, 2).up(50, 3)
        .down(980, 3).down(995, 2).down(1005, 1).down(1020, 0).up(1050, 0).up(1050, 1).up(1050, 2).up(1050, 3);
    const out = judge(SC4, chart, frames).events;
    assert.deepEqual(out.map(fmt), ["HIT(-20,false)", "HIT(-5,false)", "HIT(5,false)", "HIT(20,false)", "HIT(-20,false)", "HIT(-5,false)", "HIT(5,false)", "HIT(20,false)"]);
    assert.deepEqual(out.map((e) => e.column), [0, 1, 2, 3, 3, 2, 1, 0]);
});

test("column lock: osu!mania's, Interlude's, Interlude's at half and double rate, the threshold", () => {
    const six = () => notes().note(0).note(100).note(200).note(300).note(400).note(500);
    const after = (first, len, step = 100, from = 10) => {
        const r = replay().downFor(first, len);
        for (let i = 0; i < 6; i += 1) r.downFor(from + i * step, 30);
        return r;
    };
    assert.deepEqual(events(withPriority(SC4, "osuMania"), six(), after(-90, 10)), [...Array(6).fill("HIT(-90,false)"), "GHOST_TAP"]);
    assert.deepEqual(events(SC4, six(), after(-90, 30)), ["HIT(-90,false)", ...Array(5).fill("HIT(10,false)")]);
    const half = notes().note(0).note(50).note(100).note(150).note(200).note(250);
    const halfReplay = replay().downFor(-45, 15);
    for (let i = 0; i < 6; i += 1) halfReplay.downFor(5 + i * 50, 15);
    assert.deepEqual(events(SC4, half, halfReplay, 0.5), ["HIT(-90,false)", ...Array(5).fill("HIT(10,false)")]);
    const double = notes().note(0).note(200).note(400).note(600).note(800).note(1000);
    const doubleReplay = replay().downFor(-180, 60);
    for (let i = 0; i < 6; i += 1) doubleReplay.downFor(20 + i * 200, 60);
    assert.deepEqual(events(SC4, double, doubleReplay, 2), ["HIT(-90,false)", ...Array(5).fill("HIT(10,false)")]);
    assert.deepEqual(events(SC4, six(), after(-89, 10, 100, 11)), [...Array(6).fill("HIT(-89,false)"), "GHOST_TAP"]);
});

test("ghost taps: between notes and after them, never before the first note", () => {
    assert.deepEqual(events(SC4, notes().note(0).note(1000), replay().downFor(0, 30).downFor(500, 30).downFor(1000, 30)), ["HIT(0,false)", "GHOST_TAP", "HIT(0,false)"]);
    assert.deepEqual(events(SC4, notes().note(0).note(1000), replay().downFor(-1000, 30).downFor(0, 30).downFor(1000, 30)), ["HIT(0,false)", "HIT(0,false)"]);
    assert.deepEqual(events(SC4, notes().note(0).note(1000), replay().downFor(0, 30).downFor(1000, 30).downFor(2000, 30)), ["HIT(0,false)", "HIT(0,false)", "GHOST_TAP"]);
});

test("missed notes carry the raw late window", () => {
    assert.deepEqual(events(SC4, notes().note(0).note(200).note(400), replay()), Array(3).fill("HIT(180,true)"));
    assert.deepEqual(events(SC4, notes().note(0).note(200).note(400), replay().down(0)), ["HIT(0,false)", "HIT(180,true)", "HIT(180,true)"]);
    assert.deepEqual(events(SC4, notes().note(0).note(200).note(400), replay().downFor(0, 30).downFor(400, 30)), ["HIT(0,false)", "HIT(180,true)", "HIT(0,false)"]);
});

test("holds: offsets, boundaries, and the windows at half and double rate", () => {
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 1000)), ["HOLD(0,false)", REL(0, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(10, 990)), ["HOLD(10,false)", REL(-10, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(180, 820)), ["HOLD(180,false)", REL(-180, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(-180, 1180)), ["HOLD(-180,false)", REL(180, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(90, 910), 0.5), ["HOLD(180,false)", REL(-180, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(-90, 1090), 0.5), ["HOLD(-180,false)", REL(180, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(360, 640), 2), ["HOLD(180,false)", REL(-180, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downUntil(-360, 1360), 2), ["HOLD(-180,false)", REL(180, false, false, false)]);
});

test("holds: missed, overheld, dropped, regrabbed, the head missed, into the next note", () => {
    assert.deepEqual(events(SC4, hold1(), replay()), ["HOLD(180,true)", REL(180, true, false, true)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 2000)), ["HOLD(0,false)", REL(180, true, true, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 500)), ["HOLD(0,false)", "DROP_HOLD", REL(180, true, false, true)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 400).downFor(500, 500)), ["HOLD(0,false)", "DROP_HOLD", "REGRAB_HOLD", REL(0, false, false, true)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 300).downFor(350, 100).downFor(500, 100).downFor(650, 350)),
        ["HOLD(0,false)", "DROP_HOLD", "REGRAB_HOLD", "DROP_HOLD", "REGRAB_HOLD", "DROP_HOLD", "REGRAB_HOLD", REL(0, false, false, true)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 400).downFor(500, 1000)), ["HOLD(0,false)", "DROP_HOLD", "REGRAB_HOLD", REL(180, true, true, true)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(500, 500)), ["HOLD(180,true)", "REGRAB_HOLD", REL(0, false, false, true)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(-500, 1500)), ["HOLD(180,true)", REL(180, true, false, true)]);
    assert.deepEqual(events(SC4, notes().hold(0, 999).note(1000), replay().downFor(0, 500).downFor(990, 10)), ["HOLD(0,false)", "DROP_HOLD", REL(180, true, false, true), "HIT(-10,false)"]);
    assert.deepEqual(events(SC4, notes().hold(0, 999).hold(1000, 1010), replay().downFor(0, 500).downFor(990, 30)), ["HOLD(0,false)", "DROP_HOLD", REL(180, true, false, true), "HOLD(-10,false)", REL(10, false, false, false)]);
    assert.deepEqual(events(SC4, hold1(), replay().downFor(0, 500).downFor(1179, 1)), ["HOLD(0,false)", "DROP_HOLD", "REGRAB_HOLD", REL(180, false, false, true)]);
});

test("backwards notes, touching windows, a note expired before the press that comes after it", () => {
    assert.deepEqual(events(SC4, notes().note(0).note(100), replay().downFor(100, 1).downFor(102, 30)), ["HIT(0,false)", "HIT(102,false)"]);
    assert.deepEqual(events(OD8, notes().note(0).note(100), replay().downFor(100, 1).downFor(102, 30)), ["HIT(100,false)", "HIT(2,false)"]);
    assert.deepEqual(events(W3, notes().note(0).note(100), replay().downFor(51, 1).downFor(53, 30)), ["HIT(-49,false)", "HIT(53,false)"]);
    assert.deepEqual(events(W3, notes().note(0).note(360), replay().downFor(180, 30)), ["HIT(180,false)", "HIT(180,true)"]);
    const at = (ruleset, chart, frames) => judge(ruleset, chart, frames).events.map((e) => `${e.index}:${fmt(e)}`);
    assert.deepEqual(at(W3, notes().note(0).note(360.5), replay().downFor(180.5, 30)), ["0:HIT(180,true)", "1:HIT(-180,false)"]);
    assert.deepEqual(at(SIMPLE(90), notes().note(0).note(90.5), replay().downFor(90.5, 30)), ["0:HIT(90,true)", "1:HIT(0,false)"]);
    assert.deepEqual(at(SIMPLE(180), notes().note(0).note(90.5), replay().downFor(90.5, 30)), ["1:HIT(0,false)", "0:HIT(90,true)"]);
});

test("the replay is counted from the first note: the same events wherever the chart starts", () => {
    const frames = () => replay().downFor(22.5, 30).downFor(90, 30).downFor(200, 30);
    assert.deepEqual(events(SC4, notes().note(0).note(100).note(200), frames()), events(SC4, notes().note(1000).note(1100).note(1200), frames()));
    const late = judge(SC4, notes().note(1000).note(1100).note(1200), frames()).events;
    assert.deepEqual(late.map((e) => e.noteTime), [0, 100, 200]);
});

test("events have Prelude's fields: time, note time, combo; a missed note's time is its late window on", () => {
    const { events: out } = judge(SC4, notes().note(1000).hold(1500, 2000, 1), replay().downFor(10, 30).downFor(500, 100, 1));
    assert.deepEqual(out.map((e) => [e.kind, e.time, e.noteTime, e.combo]), [
        ["HIT", 10, 0, "INCREASE"], ["HOLD", 500, 500, "INCREASE"], ["DROP_HOLD", 600, 500, "BREAK"], ["RELEASE", 1180, 1000, "BREAK_INSTEAD_OF_INCREASE"],
    ]);
    assert.deepEqual(Object.keys(out[0]), ["kind", "index", "time", "noteTime", "column", "delta", "judgement", "points", "missed", "combo"]);
    assert.deepEqual(Object.keys(out[3]), ["kind", "index", "time", "noteTime", "column", "delta", "judgement", "points", "missed", "overhold", "dropped", "combo"]);
    assert.deepEqual(Object.keys(out[2]), ["kind", "index", "time", "noteTime", "column", "combo"]);
    assert.deepEqual([out[1].judgement, out[1].points], [null, null], "SC judges a hold once, at its end");
    assert.deepEqual([out[3].judgement, out[3].points], [3, -0.5], "dropped: at best a Good");
});

// ---- ScoreProcessorTests ----
test("score: basic end to end", () => {
    const s = judge(SC4, notes().note(0).note(1000), replay().downFor(0, 30).downFor(500, 30).downFor(1045, 30));
    assert.deepEqual(s.counts, [1, 1, 0, 0, 0, 0]);
    assert.equal(s.accuracy, 0.95);
    assert.deepEqual([s.maxCombo, s.maxPossibleCombo, s.comboBreaks], [2, 2, 0]);
    assert.equal(s.formattedAccuracy, "95.00%");
});

test("score: the time-stepped example's end", () => {
    const s = judge(SC4, notes().note(0).hold(1000, 2000).hold(3000, 4000), replay().downFor(-45, 30).downFor(1000, 1000).downFor(3000, 30).downFor(3100, 900));
    assert.equal(s.counts[3], 1);
    assert.equal(s.accuracy, 1.4 / 3.0);
    assert.equal(s.maxCombo, 4);
    assert.equal(s.maxPossibleCombo, 5);
});

const TAP = [[0, 0], [22.5, 0], [-22.5, 0], [22.6, 1], [-22.6, 1], [45, 1], [-45, 1], [45.1, 2], [-45.1, 2], [90, 2], [-90, 2], [90.1, 3], [-90.1, 3], [135, 3], [-135, 3], [135.1, 4], [-135.1, 4], [180, 4], [-180, 4], [180.1, 5], [-180.1, 5]];
const only = (counts) => counts.indexOf(1);

test("SC J4: a note's judgement at every window edge", () => {
    for (const [offset, j] of TAP) assert.equal(only(judge(SC4, notes().note(0), replay().downFor(offset, 1)).counts), j, `offset ${offset}`);
});

test("SC J4 holds: exact, latest and earliest release, dropped, regrabbed, overheld, missed", () => {
    const hold = (offset, ...frames) => {
        const r = replay();
        for (const [a, b] of frames) r.downUntil(a, b);
        return only(judge(SC4, hold1(), r).counts);
    };
    for (const [offset, j] of TAP) {
        const head = offset === 180.1 ? 4 : j; // a head 180.1 late is still pressed as the hold's, so it is a Bad, not a miss
        assert.equal(hold(offset, [offset, 1000]), head, `exact ${offset}`);
        assert.equal(hold(offset, [offset, 1180]), head, `latest ${offset}`);
        assert.equal(hold(offset, [offset, 820]), head, `earliest ${offset}`);
        assert.equal(hold(offset, [offset, 500]), j <= 3 ? 3 : j, `dropped ${offset}`);
        assert.equal(hold(offset, [offset, 500], [501, 1000]), j <= 3 ? 3 : 4, `regrabbed ${offset}`);
        assert.equal(hold(offset, [offset, 1500]), j <= 3 ? 3 : j, `overheld ${offset}`);
    }
    assert.deepEqual(judge(SC4, hold1(), replay()).counts, [0, 0, 0, 0, 0, 1]);
});

test("ghost tap judgement: scored and breaking the combo by the ruleset", () => {
    const withGhost = (j) => ({ ...SC4, ghostTapJudgement: j });
    const run = (ruleset) => judge(ruleset, notes().note(0).note(1000), replay().downFor(0, 10).downFor(500, 10).downFor(1000, 10));
    const miss = run(withGhost(5));
    assert.deepEqual(miss.counts, [2, 0, 0, 0, 0, 1]);
    assert.deepEqual([miss.comboBreaks, miss.maxCombo], [1, 1]);
    const great = run(withGhost(2));
    assert.deepEqual(great.counts, [2, 0, 1, 0, 0, 0]);
    assert.deepEqual([great.comboBreaks, great.maxCombo], [0, 2]);
    assert.equal(great.events.find((e) => e.kind === "GHOST_TAP").points, 0.5);
});

test("the Wife curve: 1 at its best, falling with the offset, the same either side", () => {
    assert.equal(wife3Points(4, 0), 1);
    let last = 1;
    for (let d = 1; d <= 200; d += 1) {
        const p = wife3Points(4, d);
        assert.ok(p <= last, `${d}`);
        assert.equal(wife3Points(4, -d), p);
        last = p;
    }
    assert.equal(wife3Points(4, 500), -2.75);
});

test("exp worked out to the nearest double", () => {
    // values whose nearest doubles V8's own Math.exp misses by an ulp (worked out to 60 digits)
    assert.equal(exactExp(-0.3080239862315042), 0.7348976903715262);
    assert.equal(exactExp(0), 1);
    assert.equal(exactExp(-Infinity), 0);
    for (let x = -9; x <= 0; x += 0.37) assert.ok(Math.abs(exactExp(x) - Math.exp(x)) <= Math.exp(x) * 2.3e-16, `${x}`);
});

test("an exp an ulp off moves a Wife3 point by at most 2^-53: a few of its ulps, many more near 0", () => {
    const bits = (x) => {
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, x);
        return view.getBigInt64(0);
    };
    const nextUp = (x) => {
        const view = new DataView(new ArrayBuffer(8));
        view.setBigInt64(0, bits(x) + 1n);
        return view.getFloat64(0);
    };
    // wife3Points(7, delta) worked out again around its exp: the erf of (zero − delta) / dev
    const scale = 3 / 6;
    const around = (delta) => {
        const x = (65 * scale ** 0.75 - delta) / (22.7 * scale ** 0.75);
        const t = 1 / (1 + 0.3275911 * x);
        const erfWith = (e) => 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * e;
        const e = exactExp(-x * x);
        assert.equal(wife3Points(7, delta), erfWith(e));
        return { point: erfWith(e), ulps: bits(erfWith(e)) - bits(erfWith(nextUp(e))), moved: erfWith(e) - erfWith(nextUp(e)) };
    };
    // the deltas of some of the 90 points the oracle had off: 1, 2 and 4 ulps
    assert.equal(around(f(30)).ulps, 1n);
    assert.equal(around(f(35)).ulps, 2n);
    assert.equal(around(f(35.68125)).ulps, 4n);
    // near the edge of the curve the point is near 0 and its ulps small: the same exp moves it by 64 of them
    const near = around(f(38.5));
    assert.ok(near.point < 0.02);
    assert.equal(near.ulps, 64n);
    for (let d = 3; d < 38.6; d += 0.25) assert.ok(Math.abs(around(f(d)).moved) <= 2 ** -53, `${d}`);
});

test("autoplay gets every point: SC J4, osu! OD10, Wife3 J4", () => {
    const chart = () => notes().note(0).hold(100, 600, 1).note(250, 2).note(250, 3).note(700).hold(800, 1200, 3).note(900, 2);
    const auto = () => replay().downFor(0, 30).down(100, 1).down(250, 2).down(250, 3).up(280, 2).up(280, 3).up(600, 1).downFor(700, 30).down(800, 3).downFor(900, 30, 2).up(1200, 3);
    for (const ruleset of [SC4, OD10, W3]) {
        const s = judge(ruleset, chart(), auto());
        assert.equal(s.accuracy, 1, ruleset.name);
        assert.equal(s.comboBreaks, 0, ruleset.name);
    }
});

// ---- RulesetOsuParityTests (synthetic ones) ----
test("osu!: column lock as osu! has it, OD 8 and 10", () => {
    assert.deepEqual(events(OD8, notes().note(0).note(108).note(222), replay().downFor(-71, 30).downFor(108 - 121, 30).downFor(222 - 125, 30).downFor(222, 30)), ["HIT(-71,false)", "HIT(-11,false)", "HIT(0,false)"]);
    const four = () => notes().note(0).note(125).note(250).note(375);
    assert.deepEqual(events(OD10, four(), replay().downFor(78, 30).downFor(222, 30).downFor(366, 30)), ["HIT(78,false)", `HIT(${OD10.noteWindows[1]},true)`, "HIT(-28,false)", "HIT(-9,false)"]);
    assert.deepEqual(events(OD8, four(), replay().downFor(78, 30).downFor(228, 30).downFor(366, 30)), ["HIT(78,false)", `HIT(${OD8.noteWindows[1]},true)`, "HIT(-22,false)", "HIT(-9,false)"]);
    assert.deepEqual(events(OD8, four(), replay().downFor(78, 30).downFor(227, 30).downFor(366, 30)), ["HIT(78,false)", "HIT(102,false)", `HIT(${OD8.noteWindows[1]},true)`, "HIT(-9,false)"]);
});

test("osu!: the early miss window and the late 100 window, OD 8", () => {
    const chart = () => notes().note(0).note(1000).note(2000).note(3000);
    assert.deepEqual(events(OD8, chart(), replay().downFor(-166, 30).downFor(0, 30).downFor(835, 30).downFor(1000, 30).downFor(1836, 30).downFor(2000, 30).downFor(2837, 30).downFor(3000, 30)),
        ["HIT(0,false)", "GHOST_TAP", "HIT(0,false)", "HIT(-164,false)", "GHOST_TAP", "HIT(-163,false)", "GHOST_TAP"]);
    const late = events(OD8, chart(), replay().downFor(105, 30).downFor(1104, 30).downFor(2103, 30).downFor(3102, 30)).filter((e) => e !== "GHOST_TAP");
    assert.deepEqual(late, [...Array(3).fill(`HIT(${OD8.noteWindows[1]},true)`), "HIT(102,false)"]);
});

test("osu!: holds pressed early by each window and let go on time, OD 0 to 10", () => {
    const fl = Math.floor;
    for (let step = 0; step <= 20; step += 1) {
        const od = f(step * 0.5);
        const perfect = fl(f(fl(16) * f(1.2)));
        const great = fl(f(fl(f(64 - f(3 * od))) * f(1.1)));
        const good = fl(f(97 - f(3 * od)));
        const ok = fl(f(127 - f(3 * od)));
        const meh = fl(f(151 - f(3 * od)));
        const chart = notes();
        const holds = [[0, 100], [200, 300], [400, 500], [600, 700], [800, 900], [1000, 1100], [1300, 1400], [1600, 1700], [1900, 2000]];
        for (const [h, t] of holds) chart.hold(h, t);
        const heads = [perfect, perfect + 1, great, great + 1, good, good + 1, ok, ok + 1, meh];
        const r = replay();
        holds.forEach(([h, t], i) => r.downUntil(h - heads[i], t));
        const got = judge(osuRuleset(od), chart, r).events.filter((e) => e.kind === "RELEASE").map((e) => e.judgement);
        assert.deepEqual(got, [0, 1, 1, 2, 2, 3, 3, 4, 4], `OD ${od}`);
    }
});

test("osu!: a hold's one judgement from its head and its tail, OD 8 (tables 1-9, 11, 12)", () => {
    const TAILS = [-164, -127, -103, -73, -44, -19, 19, 44, 73, 103, 127, 164];
    const LN = {
        "-164": [5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], "-127": [5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], "-103": [5, 4, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4],
        "-73": [5, 3, 3, 2, 2, 2, 2, 2, 2, 3, 3, 3], "-44": [5, 3, 3, 2, 1, 1, 1, 1, 2, 3, 3, 3], "-19": [5, 2, 2, 2, 1, 0, 0, 1, 2, 2, 2, 2],
        19: [5, 2, 2, 2, 1, 0, 0, 1, 2, 2, 2, 2], 44: [5, 3, 3, 2, 1, 1, 1, 1, 2, 3, 3, 3], 73: [5, 3, 3, 2, 2, 2, 2, 2, 2, 3, 3, 3],
        127: [5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 164: [5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    };
    for (const [head, row] of Object.entries(LN)) {
        TAILS.forEach((tail, i) => {
            const s = judge(OD8, notes().hold(0, 800), replay().downUntil(Number(head), 800 + tail));
            assert.deepEqual(s.events.filter((e) => e.kind === "RELEASE").map((e) => e.judgement), [row[i]], `head ${head} tail ${tail}`);
        });
    }
});

// ---- RulesetQuaverParityTests ----
test("Quaver: releases judged apart from heads", () => {
    const releaseOf = (frames) => judge(QV, hold1(), frames).events.filter((e) => e.kind === "RELEASE")[0];
    const dropped = judge(QV, hold1(), replay().downUntil(0, 30)).events;
    assert.deepEqual(dropped.map((e) => `${fmt(e)}|${e.judgement}`), ["HOLD(0,false)|0", "DROP_HOLD|undefined", `${REL(QV.releaseWindows[1], true, false, true)}|5`]);
    assert.equal(dropped[2].points, -0.5);
    assert.equal(releaseOf(replay().downUntil(0, 30).downUntil(60, 1000)).judgement, 5);
    const overheld = releaseOf(replay().downUntil(0, 2000));
    assert.deepEqual([overheld.judgement, overheld.points, overheld.overhold], [4, -1, true]);
    const okay = releaseOf(replay().downUntil(0, 1190));
    assert.deepEqual([okay.judgement, okay.delta, okay.points], [3, 190, 0.25]);
    assert.equal(releaseOf(replay().downUntil(0, 1158)).judgement, 3);
    assert.deepEqual([releaseOf(replay().downUntil(0, 1113)).judgement, releaseOf(replay().downUntil(0, 1113)).points], [2, 0.65]);
});

test("only judging releases: taps get none, a release by its window, at best the dropped judgement when let go", () => {
    const ruleset = parseRuleset(rulesetJson({
        judgements: [[[-50, 50], false], [[-100, 100], false], [[-150, 150], true], [null, true]],
        hold: { OnlyJudgeReleases: 2 }, accuracy: { PointsPerJudgement: [1, 0.5, 0, -1] },
    }));
    const s = judge(ruleset, notes().note(0).hold(500, 1000, 1), replay().downFor(10, 30).down(500, 1).up(1070, 1));
    assert.deepEqual(s.events.map((e) => [e.kind, e.judgement]), [["HIT", null], ["HOLD", null], ["RELEASE", 1]]);
    const dropped = judge(ruleset, notes().hold(0, 1000), replay().downUntil(0, 500).downUntil(600, 1000));
    assert.equal(dropped.events.at(-1).judgement, 2);
    assert.deepEqual(dropped.counts, [0, 0, 1, 0]);
});

// ---- a failed play ----
test("judged until the last frame: notes no frame reached are not judged", () => {
    const chart = () => notes().note(0).note(500).note(1000).note(5000);
    const frames = replay().downFor(0, 30).downFor(500, 30).downFor(1200, 30);
    const until = judgeIlReplay({ ruleset: SC4, chart: chart().build(), frames: frames.build(), rate: 1, untilLastFrame: true });
    assert.deepEqual(until.events.map(fmt), ["HIT(0,false)", "HIT(0,false)", "HIT(180,true)", "GHOST_TAP"]);
    assert.deepEqual(until.counts, [2, 0, 0, 0, 0, 1]);
    const whole = judgeIlReplay({ ruleset: SC4, chart: chart().build(), frames: frames.build(), rate: 1 });
    assert.deepEqual(whole.counts, [2, 0, 0, 0, 0, 2]);
    const none = judgeIlReplay({ ruleset: SC4, chart: chart().build(), frames: framesOf([]), rate: 1, untilLastFrame: true });
    assert.deepEqual([none.events.length, none.accuracy, none.formattedAccuracy], [0, 1, "100.00%"]);
});

// ---- LampTests, GradeTests ----
test("lamps: the best whose requirements are met, none without lamps", () => {
    const lamps = [["c", 9], ["c", 1], ["c", 0], ["j", 2, 9], ["j", 2, 1], ["j", 2, 0], ["j", 1, 0]].map((x) => ({
        requirement: x[0] === "c" ? { kind: "comboBreaks", count: x[1] } : { kind: "judgement", judgement: x[1], count: x[2] },
    }));
    assert.equal(lampOf(lamps, [100, 50, 20, 5, 0, 0], 10), -1);
    assert.equal(lampOf(lamps, [100, 50, 20, 5, 0, 0], 9), 0);
    assert.equal(lampOf(lamps, [100, 50, 20, 5, 0, 0], 1), 1);
    assert.equal(lampOf(lamps, [100, 50, 20, 5, 0, 0], 0), 2);
    assert.equal(lampOf(lamps, [100, 50, 9, 0, 0, 0], 0), 3);
    assert.equal(lampOf(lamps, [100, 50, 0, 0, 0, 0], 0), 5);
    assert.equal(lampOf(lamps, [100, 0, 0, 0, 0, 0], 0), 6);
    assert.equal(lampOf([], [1, 1, 1, 1, 1, 1], 1), -1);
    assert.equal(lampOf(SC4.lamps, [10, 0, 0, 0, 0, 0], 0), 8);
});

test("grades: the best the accuracy reaches, F (−1) under the first", () => {
    const grades = [0.93995, 0.94995, 0.95995, 0.96995, 0.97995, 0.98995].map((accuracy) => ({ accuracy }));
    assert.equal(gradeOf(grades, 0.5), -1);
    assert.equal(gradeOf(grades, 0.93995), 0);
    assert.equal(gradeOf(grades, 0.955), 1);
    assert.equal(gradeOf(grades, 1), 5);
    assert.equal(gradeOf([], 1), -1);
    assert.equal(SC4.grades[gradeOf(SC4.grades, 0.95)].name, "A");
});
