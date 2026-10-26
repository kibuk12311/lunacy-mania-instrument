import test from "node:test";
import assert from "node:assert/strict";
import { fineOnset, refineOffset, refineSection, OFFSET_BIAS_MS, FINE_HOP } from "../../src/audio/fineOnset.js";
import { clickTrack } from "../fixtures/clickTrack.js";

test("fine onsets: 1.45 ms frames that peak where a click starts", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 120, offsetMs: 500.3, seconds: 4 });
    const fine = fineOnset(samples, sampleRate);
    assert.equal(fine.hopSec, FINE_HOP / sampleRate);
    assert.equal(fine.values.length, Math.floor(samples.length / FINE_HOP));
    assert.ok(fine.values.every((v) => v >= 0 && v <= 1));
    const frameMs = fine.hopSec * 1000;
    for (const click of [500.3, 1000.3, 1500.3]) {
        const lo = Math.floor((click - 30) / frameMs);
        const near = Array.from(fine.values.slice(lo, lo + Math.ceil(60 / frameMs)));
        const peak = (lo + near.indexOf(Math.max(...near)) + 0.5) * frameMs;
        assert.ok(Math.abs(peak - click) <= frameMs, `peak ${peak.toFixed(2)} for ${click}`);
        const quiet = fine.values[Math.round((click + 120) / frameMs)];
        assert.ok(quiet < 0.2 * Math.max(...near), "nothing between the clicks");
    }
});

test("clicks at 312.4 ms are refined to within 1 ms", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312.4, seconds: 30 });
    const fine = fineOnset(samples, sampleRate);
    for (const start of [300, 312, 325]) {
        const r = refineOffset(fine, { timeMs: start, bpm: 174 });
        assert.ok(Math.abs(r.timeMs - 312.4) < 1, `from ${start}: ${r.timeMs.toFixed(2)}`);
        assert.ok(r.errMs !== null && r.errMs < 1, `spread ${r.errMs}`);
    }
});

test("a section's BPM and red line from the attacks", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 174.3, offsetMs: 801.7, seconds: 60 });
    const fine = fineOnset(samples, sampleRate);
    const r = refineSection(fine, { timeMs: 805, bpm: 174.25, fromMs: 0, toMs: 60000 });
    assert.ok(Math.abs(r.bpm - 174.3) < 0.003, `bpm ${r.bpm}`);
    assert.ok(Math.abs(r.timeMs - 801.7) < 1, `red line ${r.timeMs}`);
});

test("the offset bias is a few tens of ms at most (fitted by tools/eval-timing.mjs)", () => {
    assert.ok(Number.isFinite(OFFSET_BIAS_MS) && Math.abs(OFFSET_BIAS_MS) <= 40);
});
