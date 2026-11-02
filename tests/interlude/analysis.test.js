// src/replay/analyzeInterlude.js end to end on a made-up Interlude play: the chart through charts.db's bytes, the replay
// through the Replay blob, judged by a ruleset; what the analysis gives, what report.js / flow.js / fingers.js make of it,
// and resultsAccuracy (src/replay/judge.js) for both kinds of play.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIlReplay } from "../../src/replay/analyzeInterlude.js";
import { resultsAccuracy, accuracyPercent, countKinds } from "../../src/replay/judge.js";
import { buildReport } from "../../src/replay/report.js";
import { encodeChart, decodeChart } from "../../src/interlude/chart.js";
import { readIlReplay, ilNotes, ilPresses } from "../../src/interlude/replay.js";
import { parseRuleset, SC_J4 } from "../../src/interlude/ruleset.js";
import { judgeIlReplay, COMBO } from "../../src/interlude/judge.js";
import { makeIlReplay, framesOfPresses, chartBuilder } from "../fixtures/makeIlReplay.js";
import { osuJson, quaverJson, rulesetJson } from "./rulesets.js";

const FINGERS = ["L3", "L2", "R2", "R3"];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

// Six notes from 1000 ms: a Marvellous, a Perfect, a Good (SC breaks the combo on it), a note never pressed, a hold let go
// half way (dropped, at best a Good) and a hold played right; a press in column 3 at 1100 meets no note.
function play() {
    const chart = decodeChart(encodeChart(chartBuilder(4).note(1000, 0).note(1250, 1).note(1500, 2).note(1750, 3).hold(2000, 2600, 0).hold(2200, 2500, 1).build()), 4);
    const presses = [
        { t: 5, col: 0, up: 35 }, { t: 100, col: 2, up: 130 }, { t: 280, col: 1, up: 310 }, { t: 400, col: 2, up: 430 },
        { t: 1000, col: 0, up: 1300 }, { t: 1210, col: 1, up: 1500 },
    ];
    return { chart, frames: readIlReplay(makeIlReplay(framesOfPresses(presses))) };
}
const analyze = (over = {}) => {
    const { chart, frames } = play();
    return analyzeIlReplay({ ruleset: SC_J4, chart, notes: ilNotes(chart), frames, rate: 1, ...over });
};

test("what cannot be analysed says why: not 4K, no frames", () => {
    const { chart, frames } = play();
    const sevenK = decodeChart(encodeChart(chartBuilder(7).note(0, 6).build()), 7);
    assert.equal(analyzeIlReplay({ ruleset: SC_J4, chart: sevenK, frames, rate: 1 }).reason, "keys");
    assert.equal(analyzeIlReplay({ ruleset: SC_J4, chart, frames: { times: new Float32Array(0), masks: new Uint16Array(0) }, rate: 1 }).reason, "empty");
});

test("an Interlude analysis: exact, no header, the ruleset's judgements and its own counts", () => {
    const a = analyze();
    assert.deepEqual([a.source, a.exact, a.failed, a.od, a.scoreV2, a.holdHeavy, a.headerCounts, a.headerCombo, a.comparison], ["interlude", true, false, null, false, false, null, null, null]);
    assert.equal(a.ruleset.name, "SC J4");
    assert.deepEqual(a.ruleset.judgements[3], { name: "Good", color: "#0000ff", breaksCombo: true, slot: "n100", early: -135, late: 135 });
    assert.deepEqual(a.ruleset.judgements[5], { name: "Miss", color: "#ff0000", breaksCombo: true, slot: "miss", early: null, late: null });
    assert.deepEqual(a.judgementCounts, [2, 1, 0, 2, 0, 1]);
    assert.deepEqual(a.counts, { max: 2, n300: 1, n200: 0, n100: 2, n50: 0, miss: 1 });
    near(a.accuracy, (0.9 / 6) * 100);
    assert.equal(a.accuracyText, "15.00%");
    assert.deepEqual([a.lamp, a.grade], ["SDCB", "D"]);
    assert.deepEqual(a.windows, { max: 22.5, n300: 45, n200: 90, n100: 135, n50: 180, miss: 180 });
    assert.deepEqual([a.played, a.notes, a.fromMs, a.toMs, a.reachedMs, a.holds], [6, 6, 1000, 2500, 2200, true]);
    assert.deepEqual(a.ghosts, [{ t: 1100, col: 2 }]);
    assert.deepEqual(a.misses, [{ t: 1750, col: 3, early: false }]);
});

test("results: one per note, the ruleset's judgement, points, weight, combo breaks, press and release", () => {
    const a = analyze();
    const row = (r) => [r.t, r.col, r.end, r.kind, r.j, r.points, r.weight, r.breaks, r.press, r.up, r.delta, r.at, r.dropped, r.early];
    assert.deepEqual(a.results.map(row), [
        [1000, 0, null, "max", 0, 1, 1, false, 1005, null, 5, 1005, null, false],
        [1250, 1, null, "n300", 1, 0.9, 1, false, 1280, null, 30, 1280, null, false],
        [1500, 2, null, "n100", 3, -0.5, 1, true, 1400, null, -100, 1400, null, false],
        [1750, 3, null, "miss", 5, -1, 1, true, null, null, null, 1930, null, false],
        [2000, 0, 2600, "n100", 3, -0.5, 1, true, 2000, 2300, 0, 2780, true, false],
        [2200, 1, 2500, "max", 0, 1, 1, false, 2210, 2500, 10, 2500, false, false],
    ]);
});

test("combo from Interlude's judging: a break on every judgement that breaks it and on a dropped hold", () => {
    const a = analyze();
    assert.equal(a.combo.max, 2);
    // the hold at 2000 breaks it twice: let go at 2300, then at its end (2600); t stays its head's, at says when
    assert.deepEqual(a.combo.breaks, [{ t: 1500, col: 2, combo: 2 }, { t: 1750, col: 3, combo: 0 }, { t: 2000, col: 0, combo: 2, at: 2300 }, { t: 2000, col: 0, combo: 1, at: 2600, end: true }]);
});

test("a hold missed at its head and at its end: two breaks, the second at the hold's end", () => {
    const chart = decodeChart(encodeChart(chartBuilder(4).note(500, 1).hold(1000, 2000, 0).note(1500, 1).build()), 4);
    const frames = readIlReplay(makeIlReplay(framesOfPresses([{ t: 0, col: 1, up: 30 }, { t: 1000, col: 1, up: 1030 }])));
    const a = analyzeIlReplay({ ruleset: SC_J4, chart, notes: ilNotes(chart), frames, rate: 1 });
    assert.deepEqual(a.combo.breaks, [{ t: 1000, col: 0, combo: 1 }, { t: 1000, col: 0, combo: 1, at: 2000, end: true }]);
    const report = buildReport({ analysis: a, presses: ilPresses(frames, 4, chart.notes[0].time), fingers: FINGERS });
    assert.deepEqual(report.breaks.map((b) => [b.t, b.at, b.end, b.cause, b.shape]), [[1000, undefined, undefined, "none", "hold"], [1000, 2000, true, "none", "hold"]]);
});

// the engine's events one by one: the combo after each and the judgement each gave, as the analysis's steps should have them
function engineSteps(ruleset, chart, frames, rate = 1, failed = false) {
    const first = Math.fround(chart.notes[0].time);
    let combo = 0;
    const out = [];
    for (const e of judgeIlReplay({ ruleset, chart, frames, rate, untilLastFrame: failed }).events) {
        if (e.combo === COMBO.BREAK || e.combo === COMBO.BREAK_INSTEAD) combo = 0;
        else if (e.combo === COMBO.INCREASE) combo += 1;
        const j = e.judgement ?? null;
        if (e.combo !== COMBO.NO_CHANGE || j !== null) out.push({ t: first + e.time, combo, j, points: j === null ? null : e.points });
    }
    return out;
}

test("steps: the combo and the judgements event by event, in the engine's order; summed they are its counts and accuracy", () => {
    const { chart, frames } = play();
    const a = analyze();
    assert.deepEqual(a.steps, engineSteps(SC_J4, chart, frames));
    assert.deepEqual(a.steps.slice(0, 3), [{ t: 1005, combo: 1, j: 0, points: 1 }, { t: 1280, combo: 2, j: 1, points: 0.9 }, { t: 1400, combo: 0, j: 3, points: -0.5 }]);
    const counts = a.ruleset.judgements.map(() => 0);
    let points = 0;
    let n = 0;
    for (const s of a.steps.filter((x) => x.j !== null)) {
        counts[s.j] += 1;
        points += s.points;
        n += 1;
    }
    assert.deepEqual(counts, a.judgementCounts);
    assert.equal((points / n) * 100, a.accuracy, "to the last bit");
    assert.equal(Math.max(...a.steps.map((s) => s.combo)), a.combo.max);
    assert.ok(a.steps.every((s, i) => i === 0 || s.t >= a.steps[i - 1].t), "in time order");
});

test("steps: a press at the very ms a missed note's window ends comes before that miss, as the engine makes them", () => {
    // SC J4: the tap at 1000 is missed, its window ends at 1180, when the tap at 1180 in another column is hit on time
    const chart = decodeChart(encodeChart(chartBuilder(4).note(900, 2).note(1000, 0).note(1180, 1).note(1500, 3).build()), 4);
    const frames = readIlReplay(makeIlReplay(framesOfPresses([{ t: 0, col: 2, up: 40 }, { t: 280, col: 1, up: 320 }, { t: 600, col: 3, up: 640 }])));
    const a = analyzeIlReplay({ ruleset: SC_J4, chart, frames, rate: 1 });
    assert.deepEqual(a.steps.map((s) => [s.t, s.combo, s.j]), [[900, 1, 0], [1180, 2, 0], [1180, 0, 5], [1500, 1, 0]]);
    assert.deepEqual(a.steps, engineSteps(SC_J4, chart, frames));
});

test("steps of a failed play: a hold's head hit before the last frame counts though its end never came", () => {
    const { chart, frames, analysis: a } = failedPlay();
    assert.deepEqual(a.steps, engineSteps(SC_J4, chart, frames, 1, true));
    assert.deepEqual(a.steps.map((s) => [s.t, s.combo, s.j]), [[500, 1, 0], [1000, 2, null], [1200, 3, null], [1500, 0, null]], "the tap, both heads, the drop");
    assert.equal(a.results.some((r) => r.t === 1200), false, "the hold still held has no result");
    assert.deepEqual(a.unfinished.map((r) => [r.t, r.col, r.end, r.press, r.dropped, r.weight]), [[1200, 2, 3000, 1200, false, 0]], "it is unfinished");
    assert.deepEqual(analyze().unfinished, [], "a whole play has none");
});

test("a failed play is judged up to its last frame: a hold let go is in, its end never judged; no lamp or grade", () => {
    const a = analyze({ failed: true });
    assert.equal(a.failed, true);
    assert.deepEqual(a.judgementCounts, [2, 1, 0, 1, 0, 1]);
    assert.deepEqual([a.played, a.notes], [6, 6]);
    const hold = a.results.find((r) => r.t === 2000);
    assert.deepEqual([hold.kind, hold.j, hold.points, hold.weight, hold.breaks, hold.press, hold.up, hold.at, hold.dropped], [null, null, 0, 0, true, 2000, 2300, 2300, true]);
    near(a.accuracy, (1.4 / 5) * 100);
    near(resultsAccuracy(a.results), (1.4 / 5) * 100);
    assert.deepEqual([a.lamp, a.grade], [null, null]);
});

test("a failed play also carries the accuracy Interlude itself shows for it: the whole chart judged, every note after the fail a miss", () => {
    const { chart, frames, analysis: a } = failedPlay();
    const whole = judgeIlReplay({ ruleset: SC_J4, chart, frames, rate: 1, untilLastFrame: false });
    assert.equal(a.wholeAccuracyText, whole.formattedAccuracy);
    assert.notEqual(a.wholeAccuracyText, a.accuracyText, "not the accuracy up to the last press");
    assert.ok(whole.accuracy < a.accuracy / 100, "the notes never played count against it");
    assert.equal(analyze().wholeAccuracyText, null, "a whole play: its accuracy is Interlude's already");
});

test("a ruleset whose GhostTapJudgement breaks the combo: each such press is a combo break, at the press, told by its judgement", () => {
    // judgements A, B and a miss M that breaks the combo; a press that meets no note is judged M
    const ruleset = parseRuleset(rulesetJson({
        name: "Ghosts", judgements: [[[-30, 30], false], [[-90, 90], false], [[-150, 150], true]], ghost: 2,
        hold: { OnlyRequireHold: 90 }, accuracy: { PointsPerJudgement: [1, 0.5, -1] },
    }));
    const chart = decodeChart(encodeChart(chartBuilder(4).note(1000, 0).note(1500, 1).note(2000, 2).note(2500, 3).build()), 4);
    // the first two notes hit, three presses far from any note, the last two notes never pressed
    const presses = [{ t: 0, col: 0, up: 30 }, { t: 500, col: 1, up: 530 }, { t: 700, col: 3, up: 720 }, { t: 750, col: 2, up: 770 }, { t: 800, col: 0, up: 820 }];
    const frames = readIlReplay(makeIlReplay(framesOfPresses(presses)));
    const a = analyzeIlReplay({ ruleset, chart, frames, rate: 1 });
    const engine = judgeIlReplay({ ruleset, chart, frames, rate: 1, untilLastFrame: false });
    assert.equal(a.combo.breaks.length, engine.comboBreaks, "as many breaks as the engine counts");
    assert.deepEqual(a.combo.breaks.filter((b) => b.ghost).map((b) => [b.t, b.col, b.j]), [[1700, 3, 2], [1750, 2, 2], [1800, 0, 2]]);
    assert.deepEqual(a.combo.breaks.filter((b) => b.ghost).map((b) => b.combo), [2, 0, 0], "the combo each broke");
    const report = buildReport({ analysis: a, presses: ilPresses(frames, 4, chart.notes[0].time), fingers: FINGERS });
    assert.equal(report.breaks.length, engine.comboBreaks);
});

// A failed play cut off at 1710: a tap, a hold pressed in time and let go at 1500, and a hold still held at the last frame.
function failedPlay() {
    const chart = decodeChart(encodeChart(chartBuilder(4).note(500, 1).hold(1000, 3000, 0).hold(1200, 3000, 2).note(4000, 3).build()), 4);
    const presses = [{ t: 0, col: 1, up: 30 }, { t: 500, col: 0, up: 1000 }, { t: 700, col: 2, up: 1500 }, { t: 1200, col: 3, up: 1210 }];
    const frames = readIlReplay(makeIlReplay(framesOfPresses(presses).filter((f) => f.time <= 1210)));
    return { chart, frames, analysis: analyzeIlReplay({ ruleset: SC_J4, chart, notes: ilNotes(chart), frames, rate: 1, failed: true }) };
}

test("a failed play: the break of a hold let go before the last frame is told as let go, on a hold", () => {
    const { chart, frames, analysis: a } = failedPlay();
    assert.deepEqual(a.results.map((r) => [r.t, r.col, r.press, r.up, r.dropped]), [[500, 1, 500, null, null], [1000, 0, 1000, 1500, true]], "the hold still held is left out");
    assert.deepEqual(a.combo.breaks, [{ t: 1000, col: 0, combo: 3, at: 1500 }], "the tap and both heads, broken where it was let go");
    const report = buildReport({ analysis: a, presses: ilPresses(frames, 4, chart.notes[0].time), fingers: FINGERS });
    assert.deepEqual(report.breaks.map((b) => [b.t, b.col, b.cause, b.shape]), [[1000, 0, "released", "hold"]]);
    assert.equal(report.fingers[0].holds.dropped, 1);
});

test("a hold pressed after its window and held to its end was not let go: its breaks are judged too far off", () => {
    const chart = decodeChart(encodeChart(chartBuilder(4).note(500, 1).hold(1000, 3000, 0).build()), 4);
    // the head 250 ms late, past SC's 180 ms: missed, then grabbed during its body and held exactly to its end
    const frames = readIlReplay(makeIlReplay(framesOfPresses([{ t: 0, col: 1, up: 30 }, { t: 750, col: 0, up: 2500 }])));
    const a = analyzeIlReplay({ ruleset: SC_J4, chart, notes: ilNotes(chart), frames, rate: 1 });
    const hold = a.results[1];
    assert.deepEqual([hold.press, hold.up, hold.end, hold.dropped], [1250, 3000, 3000, false]);
    const report = buildReport({ analysis: a, presses: ilPresses(frames, 4, chart.notes[0].time), fingers: FINGERS });
    assert.deepEqual(report.breaks.map((b) => [b.t, b.cause]), [[1000, "off"], [1000, "off"]]);
    assert.equal(report.fingers[0].holds.dropped, 0);
});

test("at a rate: windows in ms of the chart, offsets in real ms", () => {
    const chart = decodeChart(encodeChart(chartBuilder(4).note(1000, 0).note(1300, 1).build()), 4);
    const frames = readIlReplay(makeIlReplay(framesOfPresses([{ t: 30, col: 0, up: 60 }, { t: 300, col: 1, up: 330 }])));
    const a = analyzeIlReplay({ ruleset: SC_J4, chart, frames, rate: 1.5 });
    assert.deepEqual(a.results.map((r) => [r.delta, r.kind]), [[20, "max"], [0, "max"]]);
    assert.equal(a.windows.max, 22.5 * 1.5);
    assert.equal(a.windows.miss, 180 * 1.5);
    assert.equal(a.rate, 1.5);
});

test("osu! rulesets fill the slots as osu!'s judgements; a ruleset judging a hold twice weighs it twice", () => {
    const chart = decodeChart(encodeChart(chartBuilder(4).note(1000, 0).hold(1200, 2200, 1).build()), 4);
    const frames = readIlReplay(makeIlReplay(framesOfPresses([{ t: 20, col: 0, up: 50 }, { t: 200, col: 1, up: 1313 }])));
    const osu = analyzeIlReplay({ ruleset: parseRuleset(osuJson(8)), chart, frames, rate: 1 });
    assert.deepEqual(osu.results.map((r) => [r.kind, r.weight]), [["n300", 1], ["n200", 1]]);
    const quaver = analyzeIlReplay({ ruleset: parseRuleset(quaverJson()), chart, frames, rate: 1 });
    const hold = quaver.results[1];
    assert.deepEqual([hold.j, hold.kind, hold.weight], [2, "n200", 2], "a Marvellous head and a Great release: the worse is the note's");
    near(hold.points, 1.65);
    near(resultsAccuracy([hold]), 82.5);
    assert.equal(quaver.judgementCounts.reduce((a, b) => a + b, 0), 3);
});

test("resultsAccuracy: Interlude's by points and weight, osu!'s exactly as before", () => {
    near(resultsAccuracy(analyze().results), 15);
    assert.equal(resultsAccuracy([]), null);
    assert.equal(resultsAccuracy([{ points: 0, weight: 0 }]), null, "no judgement in it");
    assert.equal(resultsAccuracy([{ points: -1, weight: 1 }, { points: 0, weight: 1 }]), -50, "SC can go below 0");
    const osu = [{ kind: "max" }, { kind: "n300" }, { kind: "n200" }, { kind: "miss" }, { kind: "n50" }];
    assert.equal(resultsAccuracy(osu), accuracyPercent(countKinds(osu)));
});

test("the report on an Interlude play: fingers by points, why each break, holds let go", () => {
    const a = analyze();
    const { chart, frames } = play();
    const presses = ilPresses(frames, 4, chart.notes[0].time);
    const report = buildReport({ analysis: a, presses, fingers: FINGERS });
    const byFinger = Object.fromEntries(report.fingers.map((f) => [f.finger, f]));
    near(byFinger.L3.accuracy, 25);
    assert.equal(byFinger.R3.misses, 1);
    assert.deepEqual(byFinger.L3.holds && [byFinger.L3.holds.count, byFinger.L3.holds.dropped, byFinger.L3.holds.early], [1, 1, 1]);
    assert.deepEqual(byFinger.L2.holds && [byFinger.L2.holds.dropped, byFinger.L2.holds.clean], [0, 1]);
    assert.deepEqual(report.breaks.map((b) => [b.t, b.cause]), [[1500, "off"], [1750, "none"], [2000, "released"], [2000, "released"]]);
    assert.equal(report.ghosts.total, 1);
    assert.equal(report.breaker.finger, "L3");
});
