// The analyser's speed-ups must not change a single number: each fast helper against the line it replaced, on
// random inputs with ties, zeros of both signs, infinities and NaN; and computeFeatures' shared parse and reused
// results against every estimator run on its own (tools/bench-analyze.mjs checks whole results on a bigger corpus).
import test from "node:test";
import assert from "node:assert/strict";
import {
    bisectLeft,
    bisectLeftFrom,
    queryCumsum,
    cumulativeSum,
    smoothOnCorners,
    cornerUnion,
    mergeSortedUnique,
    stableArgsort,
    sortedCornerCounts,
} from "../vendor/leoblack/js/rework/reworkMathCore.js";
import {
    runSunnyEstimatorFromText,
    runDanielEstimatorFromText,
    runAzusaEstimatorFromText,
    runRoxyEstimatorFromText,
    runMixedEstimatorFromText,
    calculateInterludeStar,
    OsuFileParser,
} from "../src/core/leoblack.js";
import { computeFeatures } from "../src/core/features.js";
import { randomChart } from "./fixtures/randomChart.js";
import { makeChart } from "./fixtures/makeChart.js";

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SPECIAL = [0, -0, 1, 2.5, Infinity, -Infinity, -3, 1e-300];

function randomValues(rand, n, { special = true, nan = false } = {}) {
    return Array.from({ length: n }, () => {
        const r = rand();
        if (nan && r < 0.01) return NaN;
        if (special && r < 0.3) return SPECIAL[Math.floor(rand() * SPECIAL.length)];
        return Math.round(rand() * 50) / 7;
    });
}

test("stableArgsort gives the index order of the comparator sort it replaced", () => {
    const rand = rng(1);
    for (const n of [0, 1, 7, 300, 4095, 4096, 9000, 20000]) {
        for (const opts of [{}, { special: false }, { nan: true }]) {
            const values = randomValues(rand, n, opts);
            const expected = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
            assert.deepEqual(stableArgsort(values), expected, `n=${n} ${JSON.stringify(opts)}`);
        }
    }
    const typed = Float64Array.from(randomValues(rand, 10000, { special: false }));
    assert.deepEqual(stableArgsort(typed), [...typed.keys()].sort((a, b) => typed[a] - typed[b]));
});

function cornersWithSets(times, offsets, T) {
    const set = new Set(times);
    for (const s of [...set]) for (const o of offsets) if (o !== 0) set.add(s + o);
    set.add(0);
    set.add(T);
    return [...set].filter((s) => s >= 0 && s <= T).sort((a, b) => a - b);
}

test("cornerUnion and mergeSortedUnique give the corner lists of the Sets they replaced", () => {
    const rand = rng(2);
    for (let round = 0; round < 200; round += 1) {
        const n = Math.floor(rand() * 400);
        const times = Array.from({ length: n }, () => Math.floor(rand() * 6000) - 600);
        const T = [Math.max(0, ...times) + 1, Math.floor(rand() * 7000), 0, -5][round % 4];
        const base = cornerUnion(times, [0, 501, -499, 1], T);
        const a = cornerUnion(times, [0, 1000, -1000], T);
        assert.deepEqual(base, cornersWithSets(times, [501, -499, 1], T));
        assert.deepEqual(a, cornersWithSets(times, [1000, -1000], T));
        assert.deepEqual(mergeSortedUnique(base, a), [...new Set([...base, ...a])].sort((x, y) => x - y));
    }
    assert.equal(cornerUnion([5, -0, 9], [0, 1], 20), null);
    assert.equal(cornerUnion([5, NaN], [0, 1], 20), null);
});

test("sortedCornerCounts keeps the counts the original sort and filter kept, in their order", () => {
    const rand = rng(3);
    for (const K of [1, 4, 7, 10]) {
        const columns = Array.from({ length: K }, () => randomValues(rand, 500, { nan: K === 7 }));
        const into = new Array(K).fill(0);
        for (const keep of [(v) => v !== 0, (v) => v > 0]) {
            for (let idx = 0; idx < 500; idx += 1) {
                const expected = new Array(K).fill(0).map((_, k) => columns[k][idx]).sort((a, b) => b - a).filter(keep);
                const n = sortedCornerCounts(columns, K, idx, into, keep);
                assert.deepEqual(into.slice(0, n), expected);
            }
        }
    }
});

test("bisectLeftFrom answers like bisectLeft for rising, falling and NaN queries", () => {
    const rand = rng(4);
    const arr = [...new Set(Array.from({ length: 3000 }, () => Math.floor(rand() * 100000)))].sort((a, b) => a - b);
    const at = bisectLeftFrom(arr);
    let q = -50;
    for (let i = 0; i < 20000; i += 1) {
        const r = rand();
        q = r < 0.05 ? NaN : r < 0.15 ? q - rand() * 5000 : (Number.isNaN(q) ? 0 : q) + Math.floor(rand() * 40);
        assert.equal(at(q), bisectLeft(arr, q));
    }
});

// smoothOnCorners as vendored, before its cursors.
function smoothWithBisect(x, f, window, scale = 1.0, mode = "sum") {
    const F = cumulativeSum(x, f);
    const g = new Float64Array(f.length);
    for (let i = 0; i < x.length; i += 1) {
        const s = x[i];
        const a = Math.max(s - window, x[0]);
        const b = Math.min(s + window, x[x.length - 1]);
        const val = queryCumsum(b, x, F, f) - queryCumsum(a, x, F, f);
        if (mode === "avg") g[i] = b - a > 0 ? val / (b - a) : 0;
        else g[i] = scale * val;
    }
    return g;
}

test("smoothOnCorners gives the numbers of its binary-search version", () => {
    const rand = rng(5);
    for (let round = 0; round < 50; round += 1) {
        const x = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 2000) }, () => Math.floor(rand() * 200000)))].sort((a, b) => a - b);
        const f = Array.from(x, () => (rand() < 0.2 ? 0 : rand() * 30));
        assert.deepEqual(smoothOnCorners(x, f, 500, 0.001, "sum"), smoothWithBisect(x, f, 500, 0.001, "sum"));
        assert.deepEqual(smoothOnCorners(x, f, 250, 1, "avg"), smoothWithBisect(x, f, 250, 1, "avg"));
    }
});

const CHARTS = [
    () => randomChart(3, { seconds: 70 }),
    () => randomChart(11, { seconds: 50, lnShare: 0.08 }),
    () => makeChart({ kind: "jack", bpm: 200, seconds: 60 }),
];

function parse(text) {
    const parser = new OsuFileParser(text);
    parser.process();
    return parser;
}

test("estimators given one shared parse return what they return parsing for themselves", async () => {
    for (const make of CHARTS) {
        const text = make();
        for (const rate of [1, 1.2]) {
            const options = { speedRate: rate };
            const parsed = parse(text);
            const sunny = runSunnyEstimatorFromText(text, options);
            assert.deepEqual(runSunnyEstimatorFromText(text, options, parsed), sunny);
            assert.deepEqual(runDanielEstimatorFromText(text, options, parsed), runDanielEstimatorFromText(text, options));
            const withSunny = { ...options, precomputedSunnyResult: sunny };
            assert.deepEqual(runAzusaEstimatorFromText(text, withSunny, parsed), runAzusaEstimatorFromText(text, withSunny));
            assert.equal(await calculateInterludeStar(parsed, rate), await calculateInterludeStar(text, rate));
            assert.deepEqual(parsed, parse(text), "the shared parse is left as it was");
        }
    }
});

test("Azusa given Daniel's result, and Mixed given Roxy's, Azusa's and Daniel's, return what they would compute", () => {
    for (const make of CHARTS) {
        const text = make();
        for (const rate of [1, 1.2]) {
            const options = { speedRate: rate };
            const withSunny = { ...options, precomputedSunnyResult: runSunnyEstimatorFromText(text, options) };
            const daniel = runDanielEstimatorFromText(text, options);
            const azusa = runAzusaEstimatorFromText(text, withSunny);
            assert.deepEqual(runAzusaEstimatorFromText(text, { ...withSunny, precomputedDanielResult: daniel }), azusa);
            const reuse = { roxy: runRoxyEstimatorFromText(text, withSunny), azusa, daniel };
            assert.deepEqual(runMixedEstimatorFromText(text, { ...withSunny, reuse }), runMixedEstimatorFromText(text, withSunny));
        }
    }
});

const finiteOrNull = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

test("computeFeatures' estimates are each estimator's own", async () => {
    for (const make of CHARTS) {
        const text = make();
        for (const rate of [1, 1.2]) {
            const options = { speedRate: rate };
            const sunny = runSunnyEstimatorFromText(text, options);
            const withSunny = { ...options, precomputedSunnyResult: sunny };
            const daniel = runDanielEstimatorFromText(text, options);
            const f = await computeFeatures(text, rate);
            assert.equal(f.est.sunny, finiteOrNull(sunny.star));
            assert.equal(f.est.daniel, String(daniel.estDiff).trim().startsWith("<") ? null : finiteOrNull(daniel.numericDifficulty));
            assert.equal(f.est.azusa, finiteOrNull(runAzusaEstimatorFromText(text, withSunny).numericDifficulty));
            assert.equal(f.est.roxy, finiteOrNull(runRoxyEstimatorFromText(text, withSunny).numericDifficulty));
            assert.equal(f.interlude, finiteOrNull(await calculateInterludeStar(text, rate)));
        }
    }
});
