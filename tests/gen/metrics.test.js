import test from "node:test";
import assert from "node:assert/strict";
import { onsetF1, densityCorr, jackLoopRate, violationsPer1000, patternAccuracy } from "../../src/gen/metrics.js";
import { slotsForTiming } from "../../src/gen/grid.js";

test("onset F1 matches rows within the tolerance, each human row once", () => {
    assert.equal(onsetF1([100, 200, 300], [100, 200, 300]), 1);
    assert.equal(onsetF1([100, 200], [115, 250]), 0.5);
    assert.equal(onsetF1([100, 101], [100]), 2 / 3);
    assert.equal(onsetF1([], []), 1);
    assert.equal(onsetF1([100], [130], 20), 0);
    assert.equal(onsetF1([100], [130], 30), 1);
});

test("density correlation follows where the notes are", () => {
    const dense = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) }, (_, k) => from + k * step);
    const human = [...dense(0, 10000, 100), ...dense(10000, 20000, 400)];
    const same = [...dense(0, 10000, 125), ...dense(10000, 20000, 500)];
    const flipped = [...dense(0, 10000, 400), ...dense(10000, 20000, 100)];
    assert.ok(densityCorr(same, human, 20000, 2000) > 0.95);
    assert.ok(densityCorr(flipped, human, 20000, 2000) < -0.9);
});

test("jack loops: rows that repeat both rows before them", () => {
    const rows = [1, 1, 1, 1, 2, 4, 2, 2, 2].map((mask, k) => ({ t: k * 100, mask }));
    assert.equal(jackLoopRate(rows), 3 / 9);
    assert.equal(jackLoopRate([{ cols: [0] }, { cols: [1] }]), 0);
});

test("violations per 1000 notes and pattern accuracy", () => {
    const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 10000);
    const rows = [0, 100, 200, 300].map((t) => ({ t, cols: [0], family: "Stream" }));
    assert.equal(violationsPer1000(rows, slots), 1000 / 4);
    assert.equal(violationsPer1000([], slots), 0);
    assert.equal(patternAccuracy([{ name: "Jumpstream", share: 0.7 }, { name: "Rolls", share: 0.3 }], ["Jumpstream"]), 0.7);
});
