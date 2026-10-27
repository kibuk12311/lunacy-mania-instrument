// A chart with more objects than one call can take as arguments (a 2-hour marathon): the analysis, its details and a
// marathon of it no longer stop on "Maximum call stack size exceeded" (Math.min(...times) and the like), and the
// helpers that replaced those spreads give exactly what the spreads gave.
import test from "node:test";
import assert from "node:assert/strict";
import { makeChart } from "./fixtures/makeChart.js";
import { analyzeChart } from "../src/core/analyze.js";
import { detailsJob } from "../src/analysis/timeline.js";
import { minOf, maxOf } from "../vendor/leoblack/js/lunacyExtremes.js";

test("minOf / maxOf: the same as Math.min(...x) / Math.max(...x), NaN, -0 and empty included", () => {
    const cases = [[], [3], [1, -2, 5], [0, -0], [-0, 0], [NaN, 1], [1, NaN], [Infinity, -Infinity], ["4", 2], [-0]];
    for (const x of cases) {
        assert.ok(Object.is(minOf(x), Math.min(...x)), `min ${String(x)}`);
        assert.ok(Object.is(maxOf(x), Math.max(...x)), `max ${String(x)}`);
    }
    const big = Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 100_003);
    assert.equal(minOf(big), 0);
    assert.equal(maxOf(big), 100_002);
});

test("a 150 000-object 4K chart is analysed, and its details worked out", { timeout: 120_000 }, () => {
    const text = makeChart({ kind: "jumpstream", bpm: 200, seconds: 7500 });
    assert.ok(text.split("[HitObjects]")[1].trim().split("\n").length >= 150_000);
    return analyzeChart(text, 1).then((r) => {
        assert.equal(r.kind, "ok", r.message);
        assert.equal(detailsJob(text, 1).kind, "details");
    });
});
