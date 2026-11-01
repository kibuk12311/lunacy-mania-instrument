// src/replay/fingers.js, flow.js, report.js: the detailed statistics on synthetic plays (a made-up player). Every number is
// checked against a play built so the answer is known, and what a play cannot tell comes out null or empty, never zero.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FINGERS, FINGERS, STATS, validFingers, handsOf, topSpeed, jackRuns, holdStats, driftOf, fingerReport } from "../../src/replay/fingers.js";
import { DRIFT, PACE, timingDrift, paceLine, shapeAt, comboBreaks, ghostReport, partReport, hardestParts, familyReport } from "../../src/replay/flow.js";
import { buildReport, familyLine } from "../../src/replay/report.js";
import { analyzeReplay } from "../../src/replay/analyze.js";
import { parseFrames, keyPresses } from "../../src/replay/osr.js";
import { manipPairs, manipByFamily, MANIP } from "../../src/replay/manip.js";
import { framesText, honestPresses, gluedPresses, rollNotes, noise } from "../fixtures/makeOsr.js";

const note = (t, col, end = null) => ({ t, col, end });
const hit = (t, col, delta = 0, more = {}) => ({ t, col, end: null, kind: "max", at: t + delta, press: t + delta, up: null, early: false, delta, ...more });
const miss = (t, col, more = {}) => hit(t, col, 0, { kind: "miss", press: null, delta: null, at: t + 100, ...more });

function analyze(notes, presses, { parts = [], rate = 1, modNames = [] } = {}) {
    const header = { modNames, rate, total: 0, counts: { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, maxCombo: 0 };
    const frames = parseFrames(framesText(presses));
    const columns = keyPresses(frames);
    return { analysis: analyzeReplay({ header, notes, keys: 4, od: 8, frames, columns, parts }), columns };
}

test("fingers: the default is middle and index of both hands; what was remembered is checked", () => {
    assert.deepEqual([...DEFAULT_FINGERS], ["L3", "L2", "R2", "R3"]);
    assert.equal(FINGERS.length, 10);
    assert.deepEqual(validFingers(["L4", "L3", "R3", "R4"]), ["L4", "L3", "R3", "R4"]);
    assert.deepEqual(validFingers(["L3", "nose", "R2", "R3"]), [...DEFAULT_FINGERS]);
    assert.deepEqual(validFingers(null), [...DEFAULT_FINGERS]);
    assert.deepEqual(handsOf(["L3", "L2", "L1", "R2"]), [{ id: "left", columns: [0, 1, 2] }, { id: "right", columns: [3] }]);
});

test("top speed: the most presses inside a second, real time", () => {
    const times = [0, 100, 200, 300, 2000, 2050];
    assert.equal(topSpeed(times), 4);
    assert.equal(topSpeed(times, 2), 5, "at ×2 two seconds of the map are one real second");
    assert.equal(topSpeed([]), null);
});

test("jacks: runs of a column, the fastest one played whole, as 1/4 BPM", () => {
    const col = (times, change = (r) => r) => times.map((t) => change(hit(t, 0)));
    const a = jackRuns(col([0, 100, 200, 300, 1000, 1150, 1300]));
    assert.deepEqual([a.runs, a.notes, a.bestMs, a.bestBpm, a.bestNotes, a.bestAt], [2, 7, 100, 150, 4, 0]);
    assert.equal(jackRuns(col([0, 100])), null, "two notes are no jack");
    assert.equal(jackRuns(col([0, 300, 600])), null, "too far apart");
    const broken = jackRuns(col([0, 100, 200], (r) => (r.t === 100 ? miss(100, 0) : r)));
    assert.equal(broken.runs, 1);
    assert.equal(broken.bestMs, null, "a run with a miss has no speed");
    assert.equal(jackRuns(col([0, 150, 300]), 1.5).bestMs, 100, "real time at a rate");
});

test("holds: released on time, early, late, dropped; a map without holds has no such section", () => {
    const windows = { n300: 40 };
    const hold = (end, up, kind = "max") => hit(0, 0, 0, { end, up, kind });
    const s = holdStats([hold(1000, 1005), hold(1000, 900), hold(1000, 1100), hold(1000, 1060), hold(1000, null, "miss"), hit(2000, 0)], windows);
    assert.deepEqual([s.count, s.clean, s.early, s.late, s.dropped], [5, 1, 1, 2, 1]);
    assert.equal(s.earlyMean, -100);
    assert.equal(s.lateMean, 80);
    assert.equal(holdStats([hit(0, 0)], windows), null);
});

test("drift of a group: thirds with enough hits, or nothing", () => {
    const hits = Array.from({ length: 90 }, (_, i) => hit(i * 100, 0, i < 30 ? -2 : i >= 60 ? 8 : 0));
    const d = driftOf(hits, 0, 9000);
    assert.equal(d.first.mean, -2);
    assert.equal(d.last.mean, 8);
    assert.equal(d.meanChange, 10);
    assert.equal(driftOf(hits.slice(0, 10), 0, 900), null);
});

test("finger report: presses, shares, judgements and who breaks the combo, per finger and per hand", () => {
    const notes = rollNotes({ count: 400, stepMs: 60 });
    const presses = honestPresses(notes, { sdMs: 5, seed: 3 }).filter((_, i) => i !== 50 && i !== 54 && i !== 58 && i !== 201);
    const { analysis, columns } = analyze(notes, presses);
    const r = fingerReport(analysis, columns, [...DEFAULT_FINGERS]);
    assert.deepEqual(r.fingers.map((f) => f.finger), ["L3", "L2", "R2", "R3"]);
    assert.equal(r.fingers.reduce((sum, f) => sum + f.presses, 0), presses.length);
    assert.ok(Math.abs(r.fingers.reduce((sum, f) => sum + f.share, 0) - 100) < 0.5);
    assert.equal(r.fingers[0].notes, 100);
    assert.equal(r.fingers.find((f) => f.finger === "R2").misses, 3, "column 3 lost three notes, column 2 one");
    assert.equal(r.breaker.finger, "R2");
    assert.equal(r.breaker.of, 4);
    assert.ok(r.fingers[0].ur > 20 && r.fingers[0].ur < 80, `${r.fingers[0].ur}`);
    assert.ok(r.fingers[0].mean !== null);
    assert.equal(r.fingers[0].jack, null, "a roll has no jacks");
    assert.equal(r.fingers[0].holds, null, "and no holds");
    assert.equal(r.hands.left.notes, 200);
    assert.equal(r.balance.notes, 50);
    assert.ok(Math.abs(r.balance.leftAhead) < 3);
    assert.equal(r.hands.right.breaks, 3);
});

test("finger report: two columns on one finger count as one; a hand with no column is null", () => {
    const notes = rollNotes({ count: 120, stepMs: 60 });
    const { analysis, columns } = analyze(notes, honestPresses(notes, { sdMs: 3 }));
    const r = fingerReport(analysis, columns, ["L2", "L2", "L3", "L4"]);
    assert.deepEqual(r.fingers.map((f) => [f.finger, f.columns]), [["L4", [3]], ["L3", [2]], ["L2", [0, 1]]]);
    assert.equal(r.fingers[2].notes, 60);
    assert.equal(r.hands.right, null);
    assert.equal(r.balance, null);
    assert.equal(r.breaker, null, "never broken: nobody to name");
});

test("a finger with too few hits shows no UR, not a zero", () => {
    const notes = rollNotes({ count: 20, stepMs: 60 });
    const { analysis, columns } = analyze(notes, honestPresses(notes, { sdMs: 3 }));
    const f = fingerReport(analysis, columns, [...DEFAULT_FINGERS]).fingers[0];
    assert.ok(f.notes < STATS.minHits);
    assert.equal(f.ur, null);
    assert.equal(f.mean, null);
    assert.equal(f.drift, null);
});

test("timing drift: the slope of a play sliding later, the thirds, and nothing for a short play", () => {
    const hits = Array.from({ length: 600 }, (_, i) => hit(i * 100, i % 4, (i / 600) * 12));
    const d = timingDrift(hits, { fromMs: 0, toMs: 60000 });
    assert.ok(Math.abs(d.slopeMsPerMin - 12) < 0.5, `${d.slopeMsPerMin}`);
    assert.equal(d.slices.length, DRIFT.slices);
    assert.ok(d.meanChange > 6);
    assert.ok(d.last.mean > d.first.mean);
    assert.equal(timingDrift(hits.slice(0, 20), { fromMs: 0, toMs: 2000 }), null);
    assert.equal(timingDrift(hits, { fromMs: 0, toMs: 10000 }), null, "under half a minute");
});

test("keys against notes: falling behind and spam are found, an even play has neither", () => {
    const heads = Array.from({ length: 300 }, (_, i) => i * 100); // 10 a second for 30 s
    const pressEvery = (from, to, step) => {
        const out = [];
        for (let t = from; t < to; t += step) out.push({ t });
        return out;
    };
    const even = paceLine({ heads, presses: [pressEvery(0, 30000, 100)], fromMs: 0, toMs: 30000 });
    assert.equal(even.stretches.length, 0);
    assert.equal(even.peakWritten, 10);
    const presses = [[...pressEvery(0, 10000, 100), ...pressEvery(10000, 16000, 200), ...pressEvery(16000, 22000, 100), ...pressEvery(22000, 27000, 50), ...pressEvery(27000, 30000, 100)]];
    const r = paceLine({ heads, presses, fromMs: 0, toMs: 30000 });
    assert.deepEqual(r.stretches.map((s) => s.kind), ["behind", "spam"]);
    assert.ok(r.stretches[0].fromSec >= 9 && r.stretches[0].toSec <= 17, JSON.stringify(r.stretches[0]));
    assert.ok(r.stretches[0].played < r.stretches[0].written);
    assert.ok(r.stretches[1].played > r.stretches[1].written);
    assert.ok(r.stretches.every((s) => s.toSec - s.fromSec >= PACE.minSec));
    assert.equal(paceLine({ heads: [0], presses: [[]], fromMs: 0, toMs: 500 }), null);
});

test("the pattern under a note", () => {
    const shape = (list, i) => shapeAt(list.map(([t, col, end = null]) => hit(t, col, 0, { end })), i);
    assert.equal(shape([[0, 0, 500]], 0), "hold");
    assert.equal(shape([[0, 0], [100, 0], [200, 0]], 1), "jack");
    assert.equal(shape([[0, 0], [0, 1], [100, 0], [100, 1]], 2), "chordjack");
    assert.equal(shape([[0, 0], [0, 1], [100, 2]], 0), "jump");
    assert.equal(shape([[0, 0], [0, 1], [0, 2], [100, 3]], 0), "hand");
    assert.equal(shape([[0, 0], [0, 1], [0, 2], [0, 3]], 0), "quad");
    assert.equal(shape([[0, 0], [100, 1], [200, 0], [300, 1], [400, 0]], 2), "trill");
    assert.equal(shape([[0, 0], [100, 1], [200, 2], [300, 3]], 1), "roll");
    assert.equal(shape([[0, 0], [100, 2], [200, 1], [300, 3], [400, 0]], 2), "stream");
    assert.equal(shape([[0, 0], [2000, 1]], 0), "single");
});

test("combo breaks: place, finger's column, why, the pattern and the part", () => {
    const results = [hit(0, 0), hit(100, 1), miss(200, 2), hit(300, 0), hit(400, 1), miss(500, 3, { early: true }), hit(600, 0), hit(700, 0, 0, { kind: "miss", end: 900, up: 750, delta: 0 })];
    const analysis = {
        results, rate: 1, parts: [{ fromMs: 0, toMs: 400 }, { fromMs: 400, toMs: 1000 }],
        combo: { breaks: [{ t: 200, col: 2, combo: 2 }, { t: 500, col: 3, combo: 2 }, { t: 700, col: 0, combo: 1 }] },
    };
    const b = comboBreaks(analysis);
    assert.deepEqual(b.map((x) => [x.t, x.col, x.combo, x.cause, x.part]), [[200, 2, 2, "none", 0], [500, 3, 2, "early", 1], [700, 0, 1, "released", 1]]);
    assert.equal(b[2].shape, "hold");
    assert.equal(comboBreaks({ ...analysis, combo: { breaks: [] } }).length, 0);
});

test("ghost presses: among the notes or in the open, by column; none is no section", () => {
    const results = [hit(1000, 0), hit(1200, 1), hit(9000, 2)];
    const r = ghostReport({ ghosts: [{ t: 1100, col: 3 }, { t: 5000, col: 3 }, { t: 8900, col: 1 }], results, fromMs: 1000, toMs: 9000, bins: 8 });
    assert.deepEqual([r.total, r.inFlow, r.idle], [3, 2, 1]);
    assert.deepEqual(r.byColumn, [0, 1, 0, 2]);
    assert.equal(r.bins.reduce((a, b) => a + b, 0), 3);
    assert.equal(ghostReport({ ghosts: [], results, fromMs: 0, toMs: 1 }), null);
});

test("parts: how each went, unreached ones left out; the hardest by dan, else by density", () => {
    const results = [
        ...Array.from({ length: 40 }, (_, i) => hit(i * 100, i % 4)),
        ...Array.from({ length: 80 }, (_, i) => (i % 8 ? hit(4000 + i * 50, i % 4, 30, { kind: "n200" }) : miss(4000 + i * 50, i % 4))),
    ];
    const analysis = { results, ghosts: [{ t: 100, col: 1 }], rate: 1, parts: [{ fromMs: 0, toMs: 4000 }, { fromMs: 4000, toMs: 8000 }, { fromMs: 8000, toMs: 12000 }] };
    const parts = partReport({ analysis, pairs: [] });
    assert.deepEqual(parts.map((p) => [p.index, p.notes, p.misses, p.ghosts, p.nps]), [[0, 40, 0, 1, 10], [1, 80, 10, 0, 20]]);
    assert.equal(parts[0].accuracy, 100);
    assert.equal(parts[0].dan, null);
    assert.equal(parts[1].pairs, 0);
    assert.equal(parts[1].percent, null, "no pairs: no percent");
    const byNps = hardestParts(parts);
    assert.equal(byNps.basis, "nps");
    assert.equal(byNps.parts[0].index, 1);
    assert.ok(byNps.parts[0].versusRest < 0);
    const byDan = hardestParts(partReport({ analysis, pairs: [], dans: [14, 12, null] }));
    assert.equal(byDan.basis, "dan");
    assert.equal(byDan.parts[0].index, 0);
    assert.equal(hardestParts(parts.slice(0, 1)), null, "one part has nothing to stand against");
});

test("families: notes and manip of each pattern along the map", () => {
    const results = [hit(0, 0), hit(100, 1), miss(200, 0), hit(1000, 2), hit(1100, 3)];
    const pairs = [{ t: 0, tb: 100, hand: "left", written: 100, played: 10, glued: true }];
    const familyAt = (t) => (t < 500 ? "stream" : t < 1050 ? null : "jack");
    const r = familyReport(results, manipByFamily(pairs, familyAt), familyAt);
    assert.deepEqual(r.map((f) => [f.family, f.notes, f.misses, f.pairs, f.percent]), [["stream", 3, 1, 1, 100], ["jack", 1, 0, 0, null]]);
    assert.equal(r[0].squeezed.mean, 90);
});

test("the report as a whole: honest play, a roll played as jumps, what depends on the fingers", () => {
    const notes = rollNotes({ count: 800, stepMs: 45, startMs: 1000 });
    const parts = [{ fromMs: 0, toMs: 20000 }, { fromMs: 20000, toMs: 99999 }];
    const honest = analyze(notes, honestPresses(notes, { sdMs: 6, seed: 9 }), { parts });
    const h = buildReport({ analysis: honest.analysis, presses: honest.columns, fingers: [...DEFAULT_FINGERS] });
    assert.ok(h.manip.percent <= 1, `${h.manip.percent}`);
    assert.equal(h.manip.squeezed, null, "nothing glued, nothing squeezed");
    assert.equal(h.ghosts, null);
    assert.equal(h.breaks.length, 0);
    assert.equal(h.families.length, 0, "no details yet: no families");
    assert.equal(h.parts.length, 2);
    assert.ok(h.drift !== null);
    const glued = analyze(notes, gluedPresses(notes), { parts });
    const later = { families: new Array(120).fill("stream"), spanMs: 36000, dans: [11.5, 12.5] };
    const g = buildReport({ analysis: glued.analysis, presses: glued.columns, fingers: [...DEFAULT_FINGERS], later });
    assert.ok(g.manip.percent >= 95, `${g.manip.percent}`);
    assert.ok(g.manip.squeezed.mean > 30, JSON.stringify(g.manip.squeezed));
    assert.ok(g.manip.hands.left.percent >= 95 && g.manip.hands.right.percent >= 95);
    assert.equal(g.families[0].family, "stream");
    assert.ok(g.families[0].percent >= 95);
    assert.equal(g.parts[1].dan, 12.5);
    assert.equal(g.hardest.basis, "dan");
    // columns 1 and 2 as the left hand: the pairs are other pairs now, and the percent follows them
    const other = buildReport({ analysis: glued.analysis, presses: glued.columns, fingers: ["L3", "R2", "L2", "R3"] });
    assert.notEqual(other.manip.pairs, g.manip.pairs);
    assert.ok(other.manip.percent < g.manip.percent);
});

test("a roll played as jumps by one hand only shows in that hand", () => {
    const notes = rollNotes({ count: 400, stepMs: 45 });
    const honest = honestPresses(notes, { sdMs: 4, seed: 4 }).filter((p) => p.col > 1);
    const glued = gluedPresses(notes).filter((p) => p.col <= 1);
    const { analysis, columns } = analyze(notes, [...honest, ...glued].sort((a, b) => a.t - b.t));
    const r = buildReport({ analysis, presses: columns, fingers: [...DEFAULT_FINGERS] });
    assert.ok(r.manip.hands.left.percent >= 95, `${r.manip.hands.left.percent}`);
    assert.ok(r.manip.hands.right.percent <= 2, `${r.manip.hands.right.percent}`);
});

test("family line: bins along the map, nothing before the details come", () => {
    const at = familyLine({ families: ["stream", null, "jack", "jack"], spanMs: 4000 }, 1000);
    assert.deepEqual([at(1000), at(2500), at(3500), at(99999), at(0)], ["stream", null, "jack", "jack", "stream"]);
    assert.equal(familyLine(null, 0)(5), null);
    assert.equal(familyLine({ families: [], spanMs: 0 }, 0)(5), null);
});

test("holds through the whole chain: a late release reaches the finger's numbers", () => {
    const notes = [];
    const presses = [];
    const gauss = noise(5);
    for (let i = 0; i < 40; i += 1) {
        const t = 1000 + i * 400;
        notes.push(note(t, 0, t + 300));
        const head = Math.round(t + gauss(3));
        presses.push({ t: head, col: 0, up: t + 300 + (i % 2 ? 90 : 2) });
    }
    const { analysis, columns } = analyze(notes, presses);
    const f = fingerReport(analysis, columns, [...DEFAULT_FINGERS]).fingers[0];
    assert.equal(f.holds.count, 40);
    assert.equal(f.holds.late, 20);
    assert.equal(f.holds.clean, 20);
    assert.equal(f.holds.lateMean, 90);
    assert.equal(fingerReport(analysis, columns, [...DEFAULT_FINGERS]).fingers[1].holds, null);
});

test("manip pairs follow the hands given", () => {
    const results = [hit(0, 0, 0), hit(100, 2, -90)];
    assert.equal(manipPairs(results, 1).length, 0, "columns 1 and 3 are two hands by default");
    assert.equal(manipPairs(results, 1, MANIP, handsOf(["L2", "R2", "L3", "R3"])).length, 1);
});
