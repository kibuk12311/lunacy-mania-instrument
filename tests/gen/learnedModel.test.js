import test from "node:test";
import assert from "node:assert/strict";
import { treeRaw, noteProbability, sizeProbabilities, sampleMask } from "../../src/gen/learnedModel.js";
import { mulberry32 } from "../../src/gen/rng.js";

const stump = (feature, threshold, lo, hi) => ({
    feature: [feature, 0, 0], threshold: [threshold, 0, 0], missingLeft: [1, 0, 0],
    left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, lo, hi],
});

test("tree raw score sums baseline and leaves per class", () => {
    const spec = { baseline: [0.5], iterations: [[stump(0, 1, -1, 2)], [stump(1, 0, 0.25, -0.25)]] };
    assert.deepEqual(treeRaw(spec, [0, 5]), [0.5 - 1 - 0.25]);
    assert.deepEqual(treeRaw(spec, [3, -1]), [0.5 + 2 + 0.25]);
    assert.deepEqual(treeRaw(spec, [NaN, NaN]), [0.5 - 1 + 0.25]);
});

test("note probability is a sigmoid with a density offset", () => {
    const spec = { baseline: [0], iterations: [] };
    assert.equal(noteProbability(spec, [], 0), 0.5);
    assert.ok(noteProbability(spec, [], 2) > 0.88);
});

test("size probabilities are a softmax over classes 1..4", () => {
    const spec = { baseline: [0, 0, Math.log(2), 0], iterations: [], classes: [1, 2, 3, 4] };
    const p = sizeProbabilities(spec, []);
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(Math.abs(p[2] - 0.4) < 1e-9);
});

test("pattern sampling follows counts and keeps the row size", () => {
    const pattern = { Jumpstream: { "1,0,2": { 10: 90, 6: 10 }, "0,0,2": { 5: 1 } } };
    const rng = mulberry32(1);
    const picks = Array.from({ length: 200 }, () => sampleMask(pattern, "Jumpstream", 1, 0, 2, rng));
    assert.ok(picks.filter((m) => m === 10).length > 150);
    // unseen context: falls back to a valid mask of the requested size that avoids the previous columns
    const m = sampleMask(pattern, "Jumpstream", 9, 3, 2, rng);
    assert.equal([0, 1, 2, 3].filter((c) => m & (1 << c)).length, 2);
    assert.equal(m & 9, 0);
});

test("sampleRow takes the guard's weights and its fallback", async () => {
    const { sampleRow } = await import("../../src/gen/learnedModel.js");
    const pattern = { Jumpstream: { "0,0,2": { 5: 50, 10: 50 } } };
    const no5 = Object.assign((m) => (m === 5 ? 0 : 1), { fallback: () => 3 });
    for (let s = 0; s < 30; s += 1) assert.equal(sampleRow(pattern, "Jumpstream", 0, 0, [1, 1, 1, 1], mulberry32(s), no5), 10);
    const none = Object.assign(() => 0, { fallback: () => 3 });
    assert.equal(sampleRow(pattern, "Jumpstream", 0, 0, [1, 1, 1, 1], mulberry32(1), none), 3);
});
