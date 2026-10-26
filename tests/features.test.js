import test from "node:test";
import assert from "node:assert/strict";
import { makeChart } from "./fixtures/makeChart.js";
import { computeFeatures, FEATURE_NAMES } from "../src/core/features.js";
import { isRice } from "../src/core/rice.js";

test("rice stream yields all estimators", async () => {
    const f = await computeFeatures(makeChart({ kind: "stream", bpm: 180, seconds: 90 }), 1);
    assert.equal(f.rice, true);
    assert.ok(f.est.sunny > 0);
    assert.ok(f.msd.overall > 0);
    assert.ok(FEATURE_NAMES.every((k) => k in f.vector));
    assert.equal(f.keys, 4);
    assert.ok(Math.abs(f.bpm - 180) < 1);
});

test("LN chart is not rice", async () => {
    const f = await computeFeatures(makeChart({ kind: "ln", lnShare: 0.6, seconds: 60 }), 1);
    assert.equal(f.rice, false);
});

test("7K chart is not rice", async () => {
    const f = await computeFeatures(makeChart({ kind: "stream", keys: 7, seconds: 60 }), 1);
    assert.equal(f.rice, false);
    assert.equal(f.keys, 7);
});

test("DT raises sunny star", async () => {
    const text = makeChart({ kind: "stream", bpm: 160, seconds: 90 });
    const nm = await computeFeatures(text, 1);
    const dt = await computeFeatures(text, 1.5);
    assert.ok(dt.est.sunny > nm.est.sunny);
    assert.ok(Math.abs(dt.bpm - 240) < 1);
});

test("tiny chart does not throw", async () => {
    const f = await computeFeatures(makeChart({ kind: "stream", bpm: 180, seconds: 2 }), 1);
    for (const value of Object.values(f.vector)) {
        assert.ok(value === null || Number.isFinite(value), `got ${value}`);
    }
});

test("isRice thresholds", () => {
    assert.equal(isRice({ keys: 4, lnRatio: 0.15 }), true);
    assert.equal(isRice({ keys: 4, lnRatio: 0.16 }), false);
    assert.equal(isRice({ keys: 7, lnRatio: 0 }), false);
});

test("variant-A spread uses only Daniel and Companella", async () => {
    const f = await computeFeatures(makeChart({ kind: "jack", bpm: 170, seconds: 120 }), 1);
    const dan = [f.est.daniel, f.est.companella].filter((x) => x !== null);
    assert.ok(FEATURE_NAMES.includes("esta_range"));
    assert.equal(f.vector.esta_min, Math.min(...dan));
    assert.equal(f.vector.esta_range, Math.max(...dan) - Math.min(...dan));
});
