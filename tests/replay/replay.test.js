// src/replay: the .osr file, LZMA, the judgement rules read off osu! stable, the stats, and the manip percent on synthetic
// replays (a made-up player): honest play ≈ 0 %, a roll played as jumps ≈ 100 %.
import test from "node:test";
import assert from "node:assert/strict";
import { lzmaDecode } from "../../src/replay/lzma.js";
import { readOsr, parseFrames, unpackFrames, keyPresses, unwrapped, fullCounts } from "../../src/replay/osr.js";
import { hitWindows, judgeReplay, countKinds, comboOf, holdKind, playedColumn, accuracyPercent } from "../../src/replay/judge.js";
import { MANIP, isGlued, isLoose, isThin, manipPairs, manipSummary, manipByPart, manipByFamily, chancePercent } from "../../src/replay/manip.js";
import { analyzeReplay, unstableRate, errorHistogram, keysPerSecond, compareCounts } from "../../src/replay/analyze.js";
import { parseManiaNotes } from "../../src/overlay/maniaNotes.js";
import { MOD_BITS } from "../../src/localProfile/scoresDb.js";
import { makeOsr, framesText, honestPresses, gluedPresses, rollNotes, chartText } from "../fixtures/makeOsr.js";
import { LZMA_SAMPLE, lzmaSampleText } from "../fixtures/lzmaSample.js";
import { stageIsUp } from "../../app/renderer/replayView.js";
import { dateText } from "../../app/renderer/replayReport.js";
import { getLang, setLang } from "../../src/i18n/i18n.js";

const MD5 = "0123456789abcdef0123456789abcdef";
const note = (t, col, end = null) => ({ t, col, end });
const press = (t, up = t + 20) => ({ t, up });
const columnsOf = (presses) => {
    const out = [[], [], [], []];
    for (const p of [...presses].sort((a, b) => a.t - b.t)) out[p.col].push({ t: p.t, up: p.up });
    return out;
};
const judge = (notes, columns, options = {}) => judgeReplay(notes, columns, { od: 8, ...options });
const analyze = (notes, presses, header = {}, od = 8) => {
    const head = { modNames: [], rate: 1, total: 0, counts: { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, maxCombo: 0, ...header };
    const frames = parseFrames(framesText(presses));
    return analyzeReplay({ header: head, notes, keys: 4, od, frames, columns: keyPresses(frames) });
};

test("the LZMA decoder reads the reference encoder's stream, matches and end marker included", () => {
    const text = new TextDecoder().decode(lzmaDecode(Buffer.from(LZMA_SAMPLE, "base64")));
    assert.equal(text, lzmaSampleText());
});

test("LZMA: a broken stream throws instead of hanging", () => {
    const good = Buffer.from(LZMA_SAMPLE, "base64");
    assert.throws(() => lzmaDecode(good.subarray(0, 10)));
    const bad = Buffer.from(good);
    bad[0] = 250;
    assert.throws(() => lzmaDecode(bad));
    const cut = Buffer.from(good.subarray(0, Math.floor(good.length / 2)));
    assert.throws(() => lzmaDecode(cut));
});

test("an .osr is read: header, frames, key presses (as osu! writes them)", () => {
    const presses = [{ t: 1000, col: 0, up: 1040 }, { t: 1000, col: 2, up: 1020 }, { t: 1100, col: 3, up: 1150 }];
    const bytes = makeOsr({ md5: MD5, counts: { max: 2, n300: 1, n200: 4, n100: 5, n50: 6, miss: 7 }, score: 1234, maxCombo: 56, mods: MOD_BITS.NC | MOD_BITS.DT | MOD_BITS.MR, presses });
    const h = readOsr(bytes);
    assert.equal(h.mode, 3);
    assert.equal(h.md5, MD5);
    assert.equal(h.player, "TestPlayer");
    assert.deepEqual(h.counts, { max: 2, n300: 1, n200: 4, n100: 5, n50: 6, miss: 7 });
    assert.equal(h.total, 25);
    assert.equal(h.score, 1234);
    assert.equal(h.maxCombo, 56);
    assert.deepEqual(h.modNames.sort(), ["MR", "NC"]);
    assert.equal(h.rate, 1.5);
    const frames = unpackFrames(h.packed);
    assert.equal(frames.seed, 4242);
    assert.deepEqual(keyPresses(frames), [
        [{ t: 1000, up: 1040 }], [], [{ t: 1000, up: 1020 }], [{ t: 1100, up: 1150 }],
    ]);
});

test("osr: a damaged file throws, nothing in it can overrun", () => {
    assert.throws(() => readOsr(Buffer.from([3, 1, 2])));
    const bytes = makeOsr({ md5: MD5 });
    assert.throws(() => readOsr(bytes.subarray(0, 40)));
    const wrongLength = Buffer.from(bytes);
    wrongLength[0] = 9;
    assert.throws(() => readOsr(wrongLength));
});

test("frames: the blank start, negative steps and the seed are read as osu! lazer reads them", () => {
    const f = parseFrames("0|256|-500|0,-1|256|-500|0,-897|0|9.9|0,17|0|9.9|0,1|4|9.9|0,-3|0|9.9|0,4|12|9.9|0,-12345|0|0|77,");
    assert.deepEqual([...f.times], [-881, -880, -879]);
    assert.deepEqual([...f.masks], [0, 4, 12]);
    assert.equal(f.seed, 77);
});

test("windows: OD, floors, EZ / HR, and they stay the same real time at a rate", () => {
    assert.deepEqual(hitWindows(8), { max: 16, n300: 40, n200: 73, n100: 103, n50: 127, miss: 164 });
    assert.deepEqual(hitWindows(8.5), { max: 16, n300: 38, n200: 71, n100: 101, n50: 125, miss: 162 });
    assert.equal(hitWindows(8, ["DT"], 1.5).n300, 60);
    assert.equal(hitWindows(8, ["HR"]).n300, 28);
    assert.equal(hitWindows(8, ["EZ"]).n300, 56);
});

test("judgement: each window, ≤ the window, early miss, too early does nothing", () => {
    const w = hitWindows(8);
    const kinds = (d) => judge([note(1000, 0)], [[press(1000 + d)]]).results[0]?.kind;
    assert.equal(kinds(0), "max");
    assert.equal(kinds(-16), "max");
    assert.equal(kinds(17), "n300");
    assert.equal(kinds(-w.n300), "n300");
    assert.equal(kinds(w.n200), "n200");
    assert.equal(kinds(-w.n100), "n100");
    assert.equal(kinds(-w.n50), "n50");
    assert.equal(kinds(-w.n50 - 1), "miss");
    assert.equal(kinds(-w.miss), "miss");
    const tooEarly = judge([note(1000, 0)], [[press(1000 - w.miss - 1)]]);
    assert.equal(tooEarly.results[0].kind, "miss"); // the note, later, by nobody
    assert.equal(tooEarly.results[0].press, null);
    assert.equal(tooEarly.strays.length, 1);
});

test("judgement: late the note is gone at its 100 window, so a late press is at worst a 100", () => {
    const w = hitWindows(9);
    const one = (d) => judgeReplay([note(1000, 0)], [[press(1000 + d)]], { od: 9 });
    assert.equal(one(w.n100 - 1).results[0].kind, "n100");
    const gone = one(w.n100);
    assert.equal(gone.results[0].kind, "miss");
    assert.equal(gone.results[0].at, 1000 + w.n100);
    assert.equal(gone.strays.length, 1);
});

test("judgement: a press while the note before is still ahead of the song does nothing", () => {
    // OD 8: 200 ms jack. The first press is 115 early (a 50 on the first note), the second comes before the first note's
    // time, so it goes nowhere and the second note waits for the third press.
    const { results, strays } = judge([note(1000, 0), note(1200, 0)], [[press(885), press(995), press(1205)]]);
    assert.deepEqual(results.map((r) => r.kind), ["n50", "max"]);
    assert.equal(strays.length, 1);
});

test("judgement: a replay's Mirror turns the map over; DT deltas are real time", () => {
    assert.equal(playedColumn(0, ["MR"]), 3);
    assert.equal(playedColumn(2, []), 2);
    const mirrored = judgeReplay([note(1000, 0)], [[], [], [], [press(1000)]], { od: 8, modNames: ["MR"] });
    assert.equal(mirrored.results[0].col, 3);
    assert.equal(mirrored.results[0].kind, "max");
    const fast = judgeReplay([note(1000, 0)], [[press(1015)]], { od: 8, modNames: ["DT"], rate: 1.5 });
    assert.equal(fast.results[0].delta, 10);
    assert.equal(fast.results[0].kind, "max"); // MAX is 16 real ms, 24 ms of the map
});

test("holds: one judgement from head + tail, let go early a miss, a late release counts as the 50 window", () => {
    const w = hitWindows(7);
    assert.equal(holdKind(0, 0, w), "max");
    assert.equal(holdKind(-30, 48, w), "n300");
    assert.equal(holdKind(-54, 2, w), "n200");
    assert.equal(holdKind(-62, w.n50, w), "n100");
    assert.equal(holdKind(86, w.n50, w), "n50");
    const hold = (p) => judgeReplay([note(1000, 0, 1500)], [[p]], { od: 7 }).results[0];
    assert.equal(hold({ t: 1000, up: 1500 }).kind, "max");
    assert.equal(hold({ t: 1000, up: 1500 }).at, 1500);
    assert.equal(hold({ t: 1000, up: 1200 }).kind, "miss");
    assert.equal(hold({ t: 1043, up: 1500 + 107 }).kind, "n100"); // past the 100 window: the tail counts as 130
    assert.equal(hold({ t: 1043, up: 1500 + 107 }).at, 1500 + w.n50);
    assert.equal(hold({ t: 1200, up: 1500 }).kind, "n50"); // head missed, pressed during the body, let go at the end
    assert.equal(hold({ t: 1200, up: 1300 }).kind, "miss");
});

test("judgement: a failed play stops where the header's count stops, unreached notes are no misses", () => {
    const notes = [note(1000, 0), note(1200, 0), note(9000, 0)];
    const { results } = judge(notes, [[press(1000), press(1200)]], { lastMs: 1300 });
    assert.equal(results.length, 2);
    const limited = judge([note(1000, 0), note(1200, 1), note(1400, 2)], [[press(1000)], [press(1200)], [press(1400)]], { limit: 2 });
    assert.deepEqual(limited.results.map((r) => r.t), [1000, 1200]);
});

test("combo and accuracy", () => {
    const results = [
        { t: 1, col: 0, kind: "max", at: 1 }, { t: 2, col: 0, kind: "n300", at: 2 }, { t: 3, col: 1, kind: "miss", at: 3 }, { t: 4, col: 0, kind: "n200", at: 4 },
    ];
    assert.deepEqual(comboOf(results), { maxCombo: 2, breaks: [{ t: 3, col: 1, combo: 2 }] });
    assert.deepEqual(countKinds(results), { max: 1, n300: 1, n200: 1, n100: 0, n50: 0, miss: 1 });
    assert.ok(Math.abs(accuracyPercent(countKinds(results)) - (100 * 800) / 1200) < 1e-9);
});

test("stats: UR, histogram, keys per second, comparison with the header", () => {
    assert.equal(unstableRate([10, -10, 10, -10]), 100);
    assert.equal(unstableRate([]), null);
    const hist = errorHistogram([-7, 0, 3, 200], 20, 5);
    assert.equal(hist.from, -20);
    assert.equal(hist.counts.length, 8);
    assert.equal(hist.counts[2], 1); // −10…−5
    assert.equal(hist.counts[4], 2); // 0…5
    assert.equal(hist.counts[7], 1); // past the end
    const kps = keysPerSecond([[{ t: 0 }, { t: 100 }], [{ t: 1500 }]], { fromMs: 0, toMs: 2000 });
    assert.deepEqual(kps.perSec, [2, 1]);
    assert.equal(kps.peak, 2);
    assert.equal(kps.mean, 1.5);
    const same = { max: 1, n300: 2, n200: 3, n100: 0, n50: 0, miss: 0 };
    assert.equal(compareCounts(same, same).same, true);
    const off = compareCounts(same, { ...same, max: 2, n300: 1 });
    assert.equal(off.same, false);
    assert.equal(off.wrong, 1);
    assert.equal(off.diff.max, -1);
});

test("the thresholds: what is glued and what is not", () => {
    assert.ok(isGlued(100, 0));
    assert.ok(isGlued(100, 40));
    assert.ok(isGlued(100, -30), "the order does not matter");
    assert.ok(!isGlued(100, 41));
    assert.ok(!isGlued(45, 18), "under the margin: 27 ms closer is not clear enough");
    assert.ok(isGlued(50, 20));
    assert.deepEqual(Object.keys(MANIP).sort(), ["looseMargin", "marginMs", "maxGapMs", "maxShare", "minGapMs", "minPairs"]);
});

test("pairs: one hand, single notes, different columns, a real gap, both pressed", () => {
    const row = (t, col, p = t) => ({ t, col, end: null, kind: "max", at: p, press: p, delta: p - t });
    const pairsOf = (results, rate = 1) => manipPairs(results, rate);
    const twoHands = [row(1000, 0), row(1050, 2), row(1100, 1), row(1150, 3)];
    assert.deepEqual(pairsOf(twoHands).map((p) => [p.hand, p.col, p.colb, p.written]), [["left", 0, 1, 100], ["right", 2, 3, 100]]);
    assert.equal(pairsOf([row(1000, 0), row(1060, 0)]).length, 0, "a jack is no pair");
    assert.equal(pairsOf([row(1000, 0), row(1000, 1), row(1060, 0)]).length, 0, "a chord is no pair");
    assert.equal(pairsOf([row(1000, 0), row(1030, 1)]).length, 0, "closer than minGapMs");
    assert.equal(pairsOf([row(1000, 0), row(1300, 1)]).length, 0, "further than maxGapMs");
    assert.equal(pairsOf([{ ...row(1000, 0), press: null, delta: null, kind: "miss" }, row(1060, 1)]).length, 0, "a note not pressed");
    assert.equal(pairsOf([row(1000, 0), row(1060, 1)], 1.5)[0].written, 40, "gaps are real time");
    assert.equal(pairsOf([row(1000, 0), row(1045, 1)], 1.5).length, 0, "at 1.5× it is under minGapMs");
});

test("full column: an honest play is about 0 %, a roll played as jumps about 100 %", () => {
    const notes = rollNotes({ count: 800, stepMs: 45 }); // a hand's notes 90 ms apart
    const honest = analyze(notes, honestPresses(notes, { sdMs: 10 }));
    assert.ok(honest.manip.pairs > 600, `pairs ${honest.manip.pairs}`);
    assert.ok(honest.manip.percent <= 1, `honest ${honest.manip.percent} %`);
    const glued = analyze(notes, gluedPresses(notes));
    assert.ok(glued.manip.pairs > 300, `pairs ${glued.manip.pairs}`);
    assert.ok(glued.manip.percent >= 95, `${glued.manip.percent} %`);
    const inside = glued.manip.bins.filter((b) => b.pairs);
    assert.ok(inside.every((b) => b.glued > 0), "the timeline shows it all along");
});

test("full column: a trill of one hand played as jumps", () => {
    // one hand alternating 1 2 1 2 … every 60 ms; the glued play presses the notes two by two: every pair inside a jump is
    // glued, the gap between two jumps is no pair of its own
    const notes = Array.from({ length: 400 }, (_, i) => note(1000 + i * 60, i % 2));
    const honest = analyze(notes, honestPresses(notes, { sdMs: 8 }));
    assert.equal(honest.manip.glued, 0);
    const jumps = analyze(notes, gluedPresses(notes));
    assert.ok(jumps.manip.glued >= 195, `glued pairs ${jumps.manip.glued}`);
    assert.ok(jumps.manip.percent >= 95, `${jumps.manip.percent} %`);
});

test("full column: glued with both hands on every pair of a jump stream of rolls is near 100 %", () => {
    // written as rolls one way only: 1→2 then a rest for the hand, so every pair of the hand is a pair played together
    const notes = [];
    for (let i = 0; i < 200; i += 1) {
        const t = 1000 + i * 300;
        notes.push(note(t, 0), note(t + 60, 1), note(t + 150, 2), note(t + 210, 3));
    }
    const honest = analyze(notes, honestPresses(notes, { sdMs: 10 }));
    const presses = [];
    for (let i = 0; i < 200; i += 1) {
        const t = 1000 + i * 300;
        presses.push({ t: t + 30, col: 0, up: t + 60 }, { t: t + 30, col: 1, up: t + 60 }, { t: t + 180, col: 2, up: t + 210 }, { t: t + 180, col: 3, up: t + 210 });
    }
    const jumps = analyze(notes, presses);
    assert.ok(honest.manip.percent <= 1, `honest ${honest.manip.percent} %`);
    assert.equal(jumps.manip.pairs, 400);
    assert.equal(jumps.manip.percent, 100);
    assert.equal(jumps.manip.hands.left.percent, 100);
    assert.equal(jumps.manip.hands.right.percent, 100);
});

test("a note is glued once: the pair after a glued one is not counted", () => {
    const row = (t, col, p) => ({ t, col, end: null, kind: "max", at: p, press: p, delta: p - t });
    const pairs = manipPairs([row(1000, 0, 1030), row(1060, 1, 1030), row(1120, 0, 1150), row(1180, 1, 1210)]);
    assert.deepEqual(pairs.map((p) => [p.t, p.tb, p.glued]), [[1000, 1060, true], [1120, 1180, false]]);
});

test("manip per part and per family, and what chance alone would make", () => {
    const pairs = [
        { t: 100, tb: 200, glued: true, hand: "left", written: 100 }, { t: 300, tb: 400, glued: false, hand: "left", written: 100 },
        { t: 1500, tb: 1600, glued: true, hand: "right", written: 100 },
    ];
    const parts = manipByPart(pairs, [{ fromMs: 0, toMs: 1000 }, { fromMs: 1000, toMs: 2000 }, { fromMs: 2000, toMs: 3000 }]);
    assert.deepEqual(parts.map((p) => [p.pairs, p.percent]), [[2, 50], [1, 100], [0, null]]);
    const families = manipByFamily(pairs, (t) => (t < 1000 ? "stream" : t < 1550 ? null : "jack"));
    assert.deepEqual(families.map((f) => [f.family, f.pairs, f.glued]), [["stream", 2, 1]]);
    const summary = manipSummary(pairs, { fromMs: 0, toMs: 2000, bins: 2, sdMs: 10 });
    assert.equal(summary.percent, 66.7);
    assert.deepEqual(summary.bins, [{ pairs: 2, glued: 1 }, { pairs: 1, glued: 1 }]);
    assert.equal(summary.hands.right.percent, 100);
    assert.equal(summary.marks.length, 2);
    assert.ok(chancePercent(pairs, 10) < 0.1);
    assert.ok(chancePercent(pairs, 40) > 3);
    assert.equal(chancePercent([], 10), null);
});

test("chance matches what scattered honest play really gives", () => {
    const notes = rollNotes({ count: 2000, stepMs: 45 });
    const a = analyze(notes, honestPresses(notes, { sdMs: 30, seed: 5 }));
    assert.ok(a.manip.percent > 5, `${a.manip.percent}`);
    assert.ok(Math.abs(a.manip.percent - a.manip.chance) < 6, `${a.manip.percent} vs ${a.manip.chance}`);
});

test("analysis of a whole replay, end to end through the file format", () => {
    const notes = rollNotes({ count: 120, stepMs: 60 });
    const text = chartText(notes, { od: 8 });
    const parsed = parseManiaNotes(text);
    assert.equal(parsed.notes.length, 120);
    const presses = honestPresses(notes, { sdMs: 6, seed: 3 });
    presses.splice(50, 1); // one note never pressed
    const frames0 = parseFrames(framesText(presses));
    const first = judgeReplay(parsed.notes, keyPresses(frames0), { od: 8, lastMs: frames0.times.at(-1) });
    const counts = countKinds(first.results);
    const bytes = makeOsr({ md5: MD5, counts, maxCombo: comboOf(first.results).maxCombo, presses });
    const header = readOsr(bytes);
    const frames = unpackFrames(header.packed);
    const a = analyzeReplay({ header, notes: parsed.notes, keys: 4, od: 8, frames, columns: keyPresses(frames), parts: [{ fromMs: 0, toMs: 4000 }, { fromMs: 4000, toMs: 99999 }] });
    assert.equal(a.comparison.same, true);
    assert.equal(a.counts.miss, 1);
    assert.equal(a.misses.length, 1);
    assert.equal(a.combo.max, header.maxCombo);
    assert.equal(a.maxComboComparable, true);
    assert.equal(a.byColumn.reduce((s, c) => s + c.notes, 0), 120);
    assert.ok(a.ur > 30 && a.ur < 90, `UR ${a.ur}`);
    assert.equal(a.manip.parts.length, 2);
    assert.ok(a.results.every((r) => typeof r.kind === "string"));
    assert.deepEqual(a.histogram.counts.reduce((x, y) => x + y, 0), 119);
});

test("what cannot be analysed says why", () => {
    const notes = rollNotes({ count: 10 });
    const frames = parseFrames(framesText(honestPresses(notes)));
    const base = { header: { modNames: [], rate: 1, total: 0, counts: {} }, notes, od: 8, frames, columns: keyPresses(frames) };
    assert.equal(analyzeReplay({ ...base, keys: 7 }).reason, "keys");
    assert.equal(analyzeReplay({ ...base, header: { ...base.header, modNames: ["RD"] } }).reason, "random");
    assert.equal(analyzeReplay({ ...base, notes: [] }).reason, "empty");
    assert.equal(analyzeReplay({ ...base, header: { ...base.header, modNames: ["V2"] } }).comparison, null);
});

test("a hold written to end before it starts takes no key: osu!'s 300, in no column's way", () => {
    const text = "[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,58,128,0,44:0:0:0:0:\n64,192,58,128,0,44:0:0:0:0:\n64,192,500,1,0,0:0:0:0:\n64,192,700,128,0,900:0:0:0:0:";
    const { notes } = parseManiaNotes(text);
    assert.deepEqual(notes.map((n) => n.reversed ?? false), [true, true, false, false]);
    assert.deepEqual(notes.map((n) => n.end), [null, null, null, 900]);
    const presses = [{ t: 502, col: 0, up: 530 }, { t: 701, col: 0, up: 900 }];
    const { results, given } = judge(notes, columnsOf(presses));
    assert.equal(given, 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.kind), ["max", "max"]);
    const a = analyze(notes, presses, { counts: { max: 2, n300: 2, n200: 0, n100: 0, n50: 0, miss: 0 }, total: 4 });
    assert.deepEqual(a.counts, { max: 2, n300: 2, n200: 0, n100: 0, n50: 0, miss: 0 });
    assert.equal(a.comparison.same, true);
    assert.deepEqual([a.played, a.notes, a.fromMs], [4, 4, 500], "the timeline starts at the first note that takes a key");
    assert.equal(analyze(notes.slice(0, 2), presses).reason, "empty");
});

test("ordinary notes stacked on one time are judged one by one, as the real replays of such maps come out", () => {
    const notes = [note(1000, 3), note(1000, 3), note(1200, 3)];
    assert.deepEqual(judge(notes, columnsOf([{ t: 1000, col: 3, up: 1020 }, { t: 1200, col: 3, up: 1220 }])).results.map((r) => r.kind), ["max", "miss", "max"]);
    assert.deepEqual(judge(notes, columnsOf([{ t: 1000, col: 3, up: 1010 }, { t: 1050, col: 3, up: 1060 }, { t: 1200, col: 3, up: 1220 }])).results.map((r) => r.kind), ["max", "n200", "max"]);
});

test("a failed play's misses past the last frame: as many as the header counts, the oldest first", () => {
    const notes = [note(1000, 0), note(1200, 1), note(1400, 2), note(1600, 3), note(1800, 0)];
    const columns = columnsOf([{ t: 1000, col: 0, up: 1050 }, { t: 1200, col: 1, up: 1250 }]);
    const none = judge(notes, columns, { lastMs: 1250, limit: null });
    assert.equal(none.results.length, 2, "without a limit nothing past the frames is judged");
    const two = judge(notes, columns, { lastMs: 1250, limit: 4 });
    assert.deepEqual(two.results.map((r) => [r.t, r.kind]), [[1000, "max"], [1200, "max"], [1400, "miss"], [1600, "miss"]]);
    assert.equal(judge(notes, columns, { lastMs: 1250, limit: 2 }).results.length, 2);
    assert.equal(judge(notes, columns, { lastMs: 1250, limit: 99 }).results.length, 5, "never more than there are");
});

test("16-bit counts: what wrapped is put back, what did not stays", () => {
    assert.equal(unwrapped(91228, 156764), 156764);
    assert.equal(unwrapped(91228, 91200), 91228);
    assert.equal(unwrapped(4464, 69990), 70000, "a recount a little short of the header's still finds the wrap");
    assert.equal(unwrapped(30000, 30010), 30000);
    assert.equal(unwrapped(5000, 0), 5000);
    const counts = { max: 100, n300: 91128, n200: 0, n100: 0, n50: 0, miss: 0 };
    assert.deepEqual(fullCounts(counts, 156764), { ...counts, max: 65636 });
    assert.equal(fullCounts(counts, 91228), counts);
});

test("a marathon: the header's wrapped counts are no failed play, nothing is cut", () => {
    const notes = Array.from({ length: 70000 }, (_, i) => note(1000 + i * 120, i % 4));
    const presses = notes.map((n) => ({ t: n.t, col: n.col, up: n.t + 30 }));
    const a = analyze(notes, presses, { counts: { max: 4464, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, total: 4464, maxCombo: 4464 });
    assert.equal(a.played, 70000);
    assert.equal(a.headerCounts.max, 70000);
    assert.equal(a.comparison.same, true);
    assert.equal(a.headerCombo, 70000);
    assert.equal(a.headerAccuracy, 100);
    assert.equal(a.maxComboComparable, true);

    const failed = analyze(notes, presses.slice(0, 40000), { counts: { max: 40000, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, total: 40000, maxCombo: 40000 });
    assert.equal(failed.played, 40000, "a failed play of a marathon still stops where it stopped");
    assert.equal(failed.headerCounts.max, 40000);
});

test("what could not be analysed still gets its counts put right", () => {
    const notes = Array.from({ length: 70000 }, (_, i) => note(1000 + i, i % 4));
    const a = analyze(notes, [{ t: 1000, col: 0, up: 72000 }], { modNames: ["RD"], counts: { max: 4464, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(a.reason, "random");
    assert.equal(a.headerCounts.max, 70000);
});

test("a percent no higher than loose timing makes by itself is told apart, a real one is not", () => {
    assert.equal(isLoose(10.3, 10.6), true);
    assert.equal(isLoose(12.3, 12.7), true);
    assert.equal(isLoose(10.6 + MANIP.looseMargin - 0.1, 10.6), true);
    assert.equal(isLoose(20.5, 8.5), false);
    assert.equal(isLoose(10.6 + MANIP.looseMargin, 10.6), false);
    assert.equal(isLoose(3, 0.4), false, "under 1 % of chance there is no scatter to speak of");
    assert.equal(isLoose(null, 5), false);
    assert.equal(isLoose(5, null), false);
    const pairs = Array.from({ length: 100 }, (_, i) => ({ t: i * 500, tb: i * 500 + 100, written: 100, played: i < 10 ? 10 : 100, glued: i < 10, hand: "left" }));
    assert.equal(manipSummary(pairs, { fromMs: 0, toMs: 50000, sdMs: 30 }).loose, true);
    assert.equal(manipSummary(pairs, { fromMs: 0, toMs: 50000, sdMs: 5 }).loose, false);
});

test("a percent from a handful of pairs is marked thin, none and enough are not", () => {
    assert.equal(isThin(0), false, "no pairs: there is no number to mute");
    assert.equal(isThin(1), true);
    assert.equal(isThin(MANIP.minPairs - 1), true);
    assert.equal(isThin(MANIP.minPairs), false);
    const pairs = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 500, tb: i * 500 + 100, written: 100, played: 10, glued: true, hand: "left" }));
    const one = manipSummary(pairs(1), { fromMs: 0, toMs: 1000, sdMs: 5 });
    assert.deepEqual([one.percent, one.thin, one.loose], [100, true, false], "100 % from one pair, the number the tab must not shout");
    assert.equal(manipSummary(pairs(MANIP.minPairs), { fromMs: 0, toMs: 50000, sdMs: 5 }).thin, false);
    assert.equal(manipSummary([], { fromMs: 0, toMs: 1000 }).thin, false);
});

test("the stage goes the way the skin says until the button is used, and then the way the button says", () => {
    assert.equal(stageIsUp(null, { upsideDown: true }), true);
    assert.equal(stageIsUp(null, { upsideDown: false }), false);
    assert.equal(stageIsUp(null, null), false);
    assert.equal(stageIsUp("0", { upsideDown: true }), false, "down on a skin that says up");
    assert.equal(stageIsUp("1", { upsideDown: false }), true);
});

test("dates follow the app's language, not the machine's", () => {
    const at = Date.UTC(2026, 10, 15, 12);
    const was = getLang();
    setLang("en");
    assert.match(dateText(at), /Nov/);
    setLang("ru");
    assert.match(dateText(at), /нояб/);
    setLang(was);
});
