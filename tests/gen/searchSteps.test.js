// src/gen/searchSteps.js is search.js's searchKnob and searchRange with the prefetch hook (stream W, D3/D4); search.js
// keeps its own copies (it is part of the analyzer's fingerprint). Both must ask for the same evaluations in the same
// order and come to the same result, with or without prefetch, whatever the analysed dan does; and what a step names
// ahead must be what it then asks for, arithmetic included. (search.js itself is held as it was by
// tests/analyzerVersion.test.js.)
import test from "node:test";
import assert from "node:assert/strict";
import * as plain from "../../src/gen/search.js";
import * as steps from "../../src/gen/searchSteps.js";
import { mulberry32 } from "../../src/gen/rng.js";

const NN2_BUDGET = { coarse: 3, refine: 2, reseeds: 1, keep: 1 };
const PART_BUDGET = { coarse: 6, refine: 4, reseeds: 2, keep: 2 };
const BUDGETS = [plain.DEFAULT_BUDGET, NN2_BUDGET, PART_BUDGET, { coarse: 2, refine: 5, reseeds: 3, keep: 3 }];

// an analysed dan by knob and seed: monotone with noise, or folding back (very chordy rows read easier), or flat
function danOf(kind, rng) {
    const a = 2 + rng() * 10;
    const b = 1 + rng() * 6;
    const noise = rng() * 0.6;
    const jitter = (knob, seed) => (mulberry32(Math.round(knob * 1e6) ^ seed)() - 0.5) * noise;
    if (kind === 0) return (knob, seed) => a + b * knob + jitter(knob, seed);
    if (kind === 1) return (knob, seed) => a + b * knob - 0.8 * b * Math.max(0, knob - 0.3) ** 2 + jitter(knob, seed);
    return (knob, seed) => (mulberry32(Math.round(knob * 1e6) ^ seed ^ 0x5eed)() < 0.05 ? NaN : a + jitter(knob, seed));
}

async function runBoth(name, args, dan) {
    const asked = { plain: [], steps: [], prefetched: [] };
    const named = new Set();
    const evaluate = (list) => async (knob, seed) => {
        list.push([knob, seed]);
        return { numeric: dan(knob, seed), rows: [knob] };
    };
    const prefetch = async (pairs) => {
        for (const p of pairs) named.add(`${p[0]}|${p[1]}`);
        asked.prefetched.push(pairs.length);
    };
    const a = await plain[name]({ ...args, evaluate: evaluate(asked.plain) });
    const b = await steps[name]({ ...args, evaluate: evaluate(asked.steps) });
    const stepsWith = [];
    const c = await steps[name]({ ...args, evaluate: evaluate(stepsWith), prefetch });
    return { a, b, c, asked, stepsWith, named };
}

test("searchRange: the same evaluations, order and result as search.js, with or without prefetch", async () => {
    const rng = mulberry32(7);
    let speculated = 0;
    let total = 0;
    for (let n = 0; n < 240; n += 1) {
        const lo = 1 + rng() * 14;
        const args = { lo, hi: lo + 0.2 + rng() * 2, min: -6 + rng() * 4, max: 1 + rng() * 6, seed: Math.floor(rng() * 1e6), score: (x) => x.knob % 1, budget: BUDGETS[n % BUDGETS.length] };
        const { a, b, c, asked, stepsWith, named } = await runBoth("searchRange", args, danOf(n % 3, rng));
        assert.deepEqual(asked.steps, asked.plain, `case ${n}`);
        assert.deepEqual(stepsWith, asked.plain, `case ${n} with prefetch`);
        assert.deepEqual(b, a);
        assert.deepEqual(c, a);
        total += stepsWith.length;
        speculated += stepsWith.filter(([k, s]) => named.has(`${k}|${s}`)).length;
    }
    // what the steps name ahead covers what they ask for, but for reseeds beyond PREFETCH_SPECULATE
    assert.ok(speculated / total > 0.9, `${speculated} of ${total} named ahead`);
});

test("searchKnob: the same evaluations, order and result as search.js, with or without prefetch", async () => {
    const rng = mulberry32(11);
    for (let n = 0; n < 240; n += 1) {
        const args = { target: 1 + rng() * 16, min: -6 + rng() * 4, max: 1 + rng() * 6, seed: Math.floor(rng() * 1e6), budget: BUDGETS[n % BUDGETS.length] };
        const { a, b, c, asked, stepsWith } = await runBoth("searchKnob", args, danOf(n % 3, rng));
        assert.deepEqual(asked.steps, asked.plain, `case ${n}`);
        assert.deepEqual(stepsWith, asked.plain, `case ${n} with prefetch`);
        assert.deepEqual(b, a);
        assert.deepEqual(c, a);
    }
});

test("the bisection's speculative knobs are the searches' own arithmetic", () => {
    assert.deepEqual(steps.bisectionKnobs(0, 1, 2), [0.5, 0.25, 0.75]);
    assert.deepEqual(steps.bisectionKnobs(-2, 1, 1), [-0.5]);
    assert.deepEqual(steps.bisectionKnobs(-1, 1, 0), []);
});
