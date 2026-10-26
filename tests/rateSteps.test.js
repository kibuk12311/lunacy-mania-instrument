// The rate list of a batch: from … to with a step, in hundredths, without floating-point drift.
import test from "node:test";
import assert from "node:assert/strict";
import { rateSteps, MAX_BATCH } from "../src/rate/rateSteps.js";

test("1.0–1.5 by 0.05 gives 11 rates, each exactly two decimals", () => {
    const { rates } = rateSteps(1, 1.5, 0.05);
    assert.deepEqual(rates, [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5]);
    // 0.1 + 0.2-style drift would show as 1.1500000000000001
    assert.ok(rates.every((r) => String(r).length <= 4));
});

test("swapped ends are put the right way round; strings of numbers are fine", () => {
    assert.deepEqual(rateSteps(1.3, 1, 0.1).rates, [1, 1.1, 1.2, 1.3]);
    assert.deepEqual(rateSteps("1.0", "1.2", "0.1").rates, [1, 1.1, 1.2]);
});

test("a step that does not land on the far end stops before it; one rate when from = to", () => {
    assert.deepEqual(rateSteps(1, 1.5, 0.2).rates, [1, 1.2, 1.4]);
    assert.deepEqual(rateSteps(1.2, 1.2, 0.05).rates, [1.2]);
    assert.deepEqual(rateSteps(0.5, 2, 1.5).rates, [0.5, 2]);
});

test("limits: 0.5–2, a step of at least 0.01, at most MAX_BATCH rates", () => {
    assert.equal(MAX_BATCH, 31);
    assert.equal(rateSteps(0.4, 1, 0.1).error, "range");
    assert.equal(rateSteps(1, 2.1, 0.1).error, "range");
    assert.equal(rateSteps(1, 1.5, 0.005).error, "step");
    assert.equal(rateSteps(1, 1.5, 0).error, "step");
    assert.equal(rateSteps(1, 1.5, -0.1).error, "step");
    assert.equal(rateSteps(1, 2, 0.01).error, "too-many");
    assert.equal(rateSteps(1, 1.3, 0.01).rates.length, 31);
    assert.equal(rateSteps(0.5, 2, 0.05).rates.length, 31);
    for (const bad of [NaN, null, undefined, "x", Infinity]) {
        assert.ok(rateSteps(bad, 1.5, 0.05).error, String(bad));
        assert.ok(rateSteps(1, bad, 0.05).error, String(bad));
        assert.ok(rateSteps(1, 1.5, bad).error, String(bad));
    }
});
