// The dan by part (src/analysis/sections.js): cutting a map into parts (breaks, changes of density, lengths, the
// play's rate), each part as a chart of its own, the corpus correction (src/analysis/sectionCalibration.js) and the
// worker's job on synthetic charts.
import test from "node:test";
import assert from "node:assert/strict";
import {
    BREAK_SEC, MAX_SEC, MIN_PART_NOTES, MIN_SEC, SECTIONS_VERSION, TARGET_SEC,
    applyCalibration, calibratedDan, calibrationTerms, computeSections, cutStretch, noteTimes, sectionChart, sectionsJob,
    splitSections, supportSeconds,
} from "../src/analysis/sections.js";
import { CALIBRATION } from "../src/analysis/sectionCalibration.js";
import { analyzeChart } from "../src/core/analyze.js";
import { makeChart } from "./fixtures/makeChart.js";

// note times every stepMs over [fromSec, toSec)
const run = (fromSec, toSec, stepMs) => {
    const out = [];
    for (let t = fromSec * 1000; t < toSec * 1000; t += stepMs) out.push(Math.round(t));
    return out;
};
const ZERO = { knots: [1, 20], offsets: [0, 0], lengthGain: 0, supportGain: 0 };
const covers = (parts, times) => times.every((t) => parts.filter((p) => t >= p.fromMs && t < p.toMs).length === 1);

// a chart with the given notes (one column each) and its headers
function chartOf(times) {
    const head = ["osu file format v14", "", "[General]", "Mode: 3", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "",
        "[TimingPoints]", "0,333.33,4,2,0,60,1,0", "", "[HitObjects]"];
    return [...head, ...times.map((t, i) => `${64 + 128 * (i % 4)},192,${t},1,0,0:0:0:0:`)].join("\n");
}

test("cutting: a short stretch is one part; a long even one splits into parts of about the target, all notes held once", () => {
    assert.deepEqual(cutStretch(new Array(30).fill(1)), [0, 30]);
    const even = run(0, 120, 100);
    const parts = splitSections(even);
    assert.ok(covers(parts, even), "every note in exactly one part");
    assert.ok(parts.length >= 4 && parts.length <= 6, `${parts.length} parts of 120 s`);
    for (const p of parts) {
        const sec = (p.toMs - p.fromMs) / 1000;
        assert.ok(sec >= MIN_SEC - 1.6 && sec <= MAX_SEC + 1.6, `${sec} s`);
    }
    assert.equal(parts[0].fromMs, 0);
    assert.equal(parts.at(-1).toMs, even.at(-1) + 1);
    assert.deepEqual(splitSections([]), []);
});

test("cutting: no part runs over a break; a change of density is where a cut goes", () => {
    // 30 s, a 10 s break, 30 s
    const broken = [...run(0, 30, 100), ...run(40, 70, 100)];
    const parts = splitSections(broken);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].toMs <= 40_000 && parts[1].fromMs >= 30_000, "the break between them");
    assert.ok(covers(parts, broken));
    // a gap under BREAK_SEC is no break
    assert.equal(splitSections([...run(0, 15, 100), ...run(15 + BREAK_SEC - 1, 30, 100)]).length, 1);
    // 30 s calm (2 notes/s), then 30 s dense (12 notes/s): the cut near 30 s
    const change = [...run(0, 30, 500), ...run(30, 60, 83)];
    const two = splitSections(change);
    assert.equal(two.length, 2);
    assert.ok(Math.abs(two[1].fromMs - 30_000) <= 1600, `cut at ${two[1].fromMs}`);
});

test("cutting runs on the play's clock: a faster rate makes the same notes fewer seconds", () => {
    const times = run(0, 120, 100);
    const slow = splitSections(times, { rate: 1 });
    const fast = splitSections(times, { rate: 2 }); // 60 s of play
    assert.ok(fast.length < slow.length, `${fast.length} < ${slow.length}`);
    assert.ok(covers(fast, times));
    // a 6 s gap at 2× is 3 s of play: no break any more
    const gap = [...run(0, 20, 100), ...run(26, 46, 100)];
    assert.equal(splitSections(gap, { rate: 1 }).length, 2);
    assert.equal(splitSections(gap, { rate: 2 }).length, 1);
});

test("a part as a chart: the headers as they were, only its notes", () => {
    const text = makeChart({ kind: "stream", bpm: 180, seconds: 20 });
    const times = noteTimes(text);
    const part = sectionChart(text, times[10], times[30]);
    assert.equal(noteTimes(part).length, 20);
    assert.ok(part.startsWith(text.slice(0, text.indexOf("[HitObjects]"))), "everything before the notes kept");
    assert.ok(noteTimes(part).every((t) => t >= times[10] && t < times[30]));
    assert.equal(sectionChart("no notes here", 0, 1), "no notes here");
});

test("the correction: raw + offset by dan (between knots) + length + support; one decimal, never under 0", () => {
    assert.equal(calibratedDan(13.37, { partSec: 10, supportSec: 300 }, ZERO), 13.4, "no correction: the raw dan");
    assert.equal(calibratedDan(null, { partSec: 24 }), null);
    const c = { knots: [5, 15], offsets: [1, -1], lengthGain: 0, supportGain: 0 };
    assert.equal(calibratedDan(5, { partSec: 24 }, c), 6);
    assert.equal(calibratedDan(10, { partSec: 24 }, c), 10, "halfway between the knots: no offset");
    assert.equal(calibratedDan(20, { partSec: 24 }, c), 19, "past the last knot: its offset");
    assert.equal(calibratedDan(0.2, { partSec: 24 }, { ...c, offsets: [-1, 0] }), 0, "never under 0");
    const len = { knots: [1, 20], offsets: [0, 0], lengthGain: 1, supportGain: 0 };
    assert.equal(calibratedDan(10, { partSec: TARGET_SEC }, len), 10, "a part of the target length: no length term");
    assert.equal(calibratedDan(10, { partSec: TARGET_SEC / Math.E }, len), 11);
    const sup = { knots: [1, 20], offsets: [0, 0], lengthGain: 0, supportGain: 1 };
    assert.equal(calibratedDan(10, { partSec: 24, supportSec: 60 * (Math.E - 1) }, sup), 11);
    const terms = calibrationTerms(8, { partSec: 24, supportSec: 0 }, [1, 3, 5, 7, 9]);
    assert.deepEqual(terms.hats, [0, 0, 0, 0.5, 0.5]);
    assert.equal(terms.length, 0);
    assert.equal(terms.support, 0);
});

test("support: how long the map plays within a dan of each part; the hardest by the corrected dan", () => {
    const parts = [
        { fromSec: 0, toSec: 20, raw: 10 },
        { fromSec: 20, toSec: 50, raw: 14 },
        { fromSec: 50, toSec: 60, raw: null },
        { fromSec: 60, toSec: 90, raw: 13.5 },
    ];
    assert.deepEqual(supportSeconds(parts), [80, 60, null, 60]);
    const { parts: out, top } = applyCalibration(parts, ZERO);
    assert.equal(top, 1);
    assert.deepEqual(out.map((p) => p.dan), [10, 14, null, 13.5]);
    assert.equal(out[2].supportSec, null);
    assert.equal(applyCalibration([{ fromSec: 0, toSec: 5, raw: null }], ZERO).top, -1);
});

test("the shipped correction: a knot table in order, small gains, and the hardest part of a steady map close to its raw dan", () => {
    assert.ok(Object.isFrozen(CALIBRATION));
    assert.equal(CALIBRATION.knots.length, CALIBRATION.offsets.length);
    assert.ok(CALIBRATION.knots.every((k, i) => i === 0 || k > CALIBRATION.knots[i - 1]));
    assert.ok(CALIBRATION.offsets.every((o) => Math.abs(o) < 1.5));
    assert.ok(Math.abs(CALIBRATION.lengthGain) < 1 && Math.abs(CALIBRATION.supportGain) < 1);
    for (const raw of [3, 8, 13, 17]) {
        const dan = calibratedDan(raw, { partSec: TARGET_SEC, supportSec: 60 });
        assert.ok(Math.abs(dan - raw) < 1.5, `${raw} → ${dan}`);
    }
});

test("the job with a stand-in model: a part for each cut, quiet parts without a dan, the rate and fewer notes asked for", async () => {
    // 30 s dense, a 10 s break, 8 s with a handful of notes, a 10 s break, 30 s dense
    const times = [...run(1, 31, 100), ...run(41, 49, 1000), ...run(59, 89, 100)];
    const text = chartOf(times);
    const asked = [];
    const analyze = async (part, rate, opts) => {
        asked.push({ n: noteTimes(part).length, rate, opts });
        return { kind: "ok", numeric: 10 + noteTimes(part)[0] / 30_000, primary: "Stream", tech: false };
    };
    const s = await computeSections(text, 1.5, { analyze });
    assert.equal(s.v, SECTIONS_VERSION);
    assert.equal(s.rate, 1.5);
    assert.equal(s.parts.length, 3);
    assert.equal(s.durationSec, Math.round(((times.at(-1) - times[0]) / 1500) * 100) / 100, "seconds of play at the rate");
    assert.equal(s.parts[0].fromSec, 0);
    assert.ok(Math.abs(s.parts[2].fromSec - (58 / 1.5)) < 0.1, "the third part starts at the third stretch");
    assert.equal(s.parts[1].notes, 8);
    assert.equal(s.parts[1].dan, null, "a quiet part: too few notes for a dan");
    assert.equal(s.parts[1].raw, null);
    assert.equal(asked.length, 2, "the quiet part is not analysed");
    assert.ok(asked.every((a) => a.rate === 1.5 && a.opts.minNotes === MIN_PART_NOTES));
    assert.equal(s.top, 2, "the hardest part");
    assert.equal(s.parts[2].primary, "Stream");
    assert.deepEqual(await computeSections(chartOf([]), 1, { analyze }), { v: SECTIONS_VERSION, rate: 1, durationSec: 0, top: -1, parts: [] });
    // an analysis that fails leaves the part without a dan
    const failing = await computeSections(text, 1, { analyze: async () => ({ kind: "error", message: "x" }) });
    assert.ok(failing.parts.every((p) => p.dan === null));
    assert.equal(failing.top, -1);
});

test("the job with the real model: every part of a steady chart near the whole chart's dan, within a second or so", async () => {
    const text = makeChart({ kind: "jumpstream", bpm: 190, seconds: 100 });
    const whole = await analyzeChart(text, 1);
    const started = performance.now();
    const answer = await sectionsJob(text, 1);
    const ms = performance.now() - started;
    assert.equal(answer.kind, "sections");
    const s = answer.sections;
    assert.ok(s.parts.length >= 3, `${s.parts.length} parts`);
    assert.ok(s.top >= 0);
    assert.ok(Math.abs(s.parts[s.top].dan - whole.numeric) <= 1.5, `hardest ${s.parts[s.top].dan} vs whole ${whole.numeric}`);
    assert.ok(s.parts.every((p) => p.dan !== null && p.primary));
    assert.ok(ms < 5000, `${Math.round(ms)} ms`);
    const bad = await sectionsJob(null, 1);
    assert.equal(bad.kind, "error");
});
