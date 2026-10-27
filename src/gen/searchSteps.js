// The learned generator's density searches with prefetch (stream W, D3/D4: builds stepped together on the GPU
// decoder, src/gen/nn/webgpu/gpuBatch.js): searchKnob and searchRange exactly as src/gen/search.js has them, plus the
// one hook. search.js keeps its own copies untouched because it is part of the analyzer's fingerprint (the analysis
// imports NAME_FAMILY from it; src/core/analyzerVersion.js): any edit there would have every saved analysis redone
// after an update. tests/gen/searchSteps.test.js holds the two to the same evaluations, in the same order, the same
// results; a change to one of them belongs in the other too.
import { labelKey } from "../core/labels.js";
import { DEFAULT_BUDGET } from "./search.js";

const NUDGES = [0.015, -0.015, 0.03, -0.03, 0.05, -0.05]; // × knob range (search.js's)

// prefetch(pairs) (stream W): before each step the searches name the [knob, seed] evaluations it may ask for, whichever
// way it goes, so a caller can build them together (several builds stepped at once on the GPU decoder) and answer the
// evaluations from those builds. The decisions never depend on it: without prefetch, or whatever it does, the same
// evaluations are asked for in the same order. At most PREFETCH_SPECULATE builds are named on speculation alone.
export const PREFETCH_SPECULATE = 8;

// The midpoints the bisection of [lo, hi] reaches in its next `depth` steps, either way (2 steps → 3 knobs), with the
// very arithmetic the searches use, so the knobs are equal to the ones they will ask for.
export function bisectionKnobs(lo, hi, depth) {
    const out = [];
    let level = [[lo, hi]];
    for (let d = 0; d < depth; d += 1) {
        const next = [];
        for (const [a, b] of level) {
            const m = (a + b) / 2;
            out.push(m);
            next.push([a, m], [m, b]);
        }
        level = next;
    }
    return out;
}

// evaluate(knob, seed) → { numeric, ... }; larger knob = denser map. prefetch(pairs) → Promise: see above.
export async function searchKnob({ evaluate, target, min, max, seed, budget = DEFAULT_BUDGET, prefetch = null }) {
    const { coarse: COARSE_STEPS, refine: REFINE_STEPS, reseeds: RESEEDS } = { ...DEFAULT_BUDGET, ...budget };
    const range = max - min;
    // compared by key, so a language switch during the search can't make "the same label" differ
    const wantedLabel = labelKey(target);
    const hits = (a) => Number.isFinite(a.numeric) && labelKey(a.numeric) === wantedLabel;
    const distance = (a) => (hits(a) ? 0 : 1) + Math.abs(a.numeric - target);
    let best = null;
    const consider = (a) => {
        if (!best || distance(a) < distance(best)) best = a;
        return a;
    };
    const run = async (knob, s = seed) => consider({ knob, seed: s, ...(await evaluate(knob, s)) });

    // Not strictly monotone (very chordy rows can read easier): scan, bisect the first crossing, then nudge.
    const coarse = [];
    const inKnobRange = (knob) => knob > min && knob <= max;
    await prefetch?.(Array.from({ length: COARSE_STEPS }, (_, j) => [min + ((j + 1) / COARSE_STEPS) * range, seed]));
    for (let k = 1; k <= COARSE_STEPS && !(best && hits(best)); k += 1) coarse.push(await run(min + (k / COARSE_STEPS) * range));
    const crossing = coarse.findIndex((a) => a.numeric >= target);
    if (crossing >= 0 && !hits(best)) {
        let lo = crossing === 0 ? min : coarse[crossing - 1].knob;
        let hi = coarse[crossing].knob;
        for (let i = 0; i < REFINE_STEPS && !hits(best); i += 1) {
            if (prefetch && i % 2 === 0) await prefetch(bisectionKnobs(lo, hi, Math.min(2, REFINE_STEPS - i)).map((kn) => [kn, seed]));
            const mid = (lo + hi) / 2;
            const a = await run(mid);
            if (a.numeric < target) lo = mid;
            else hi = mid;
        }
    }
    if (prefetch && !hits(best)) await prefetch(NUDGES.map((d) => best.knob + d * range).filter(inKnobRange).map((kn) => [kn, seed]));
    for (const d of NUDGES) {
        if (hits(best)) break;
        const knob = best.knob + d * range;
        if (knob > min && knob <= max) await run(knob);
    }
    // Same density, different note layout: the analysed dan scatters by a few tenths, which often lands it.
    for (let k = 1; k <= RESEEDS && !hits(best); k += 1) {
        const around = best.knob;
        await prefetch?.([0, 0.02, -0.02].map((d) => around + d * range).filter(inKnobRange).map((kn) => [kn, seed + k * 7919]));
        for (const d of [0, 0.02, -0.02]) {
            if (hits(best)) break;
            const knob = around + d * range;
            if (knob > min && knob <= max) await run(knob, seed + k * 7919);
        }
    }
    return { best, reachable: hits(best) };
}

// Any dan inside [lo, hi) is fine; among those the most pattern-accurate attempt wins.
// evaluate(knob, seed) → { numeric, ... }; larger knob = denser. score(attempt) → pattern accuracy 0..1. prefetch: as
// searchKnob's; with the coarse scan and with the bisection it also names the reseeds of their knobs (the reseeds
// follow whichever of them lands in range), when that stays within PREFETCH_SPECULATE.
export async function searchRange({ evaluate, lo, hi, min, max, seed, score, budget = DEFAULT_BUDGET, prefetch = null }) {
    const { coarse: COARSE_STEPS, refine: REFINE_STEPS, reseeds: RESEEDS, keep: KEEP } = { ...DEFAULT_BUDGET, ...budget };
    const mid = (lo + hi) / 2;
    const inside = (a) => Number.isFinite(a.numeric) && a.numeric >= lo && a.numeric < hi;
    const attempts = [];
    const run = async (knob, s = seed) => {
        const a = { knob, seed: s, ...(await evaluate(knob, s)) };
        a.score = inside(a) ? score(a) : -1;
        attempts.push(a);
        return a;
    };
    const reseedsOf = (knobs) => (knobs.length * RESEEDS <= PREFETCH_SPECULATE
        ? knobs.flatMap((kn) => Array.from({ length: RESEEDS }, (_, j) => [kn, seed + (j + 1) * 7919]))
        : []);
    if (prefetch) {
        const knobs = Array.from({ length: COARSE_STEPS + 1 }, (_, k) => min + (k / COARSE_STEPS) * (max - min));
        await prefetch([...knobs.map((kn) => [kn, seed]), ...reseedsOf(knobs)]);
    }
    for (let k = 0; k <= COARSE_STEPS; k += 1) await run(min + (k / COARSE_STEPS) * (max - min));

    if (!attempts.some(inside)) {
        // bisect towards the middle of the range inside the bracket that crosses it
        const sorted = [...attempts].sort((a, b) => a.knob - b.knob);
        const j = sorted.findIndex((a) => a.numeric >= mid);
        if (j > 0) {
            let a = sorted[j - 1].knob;
            let b = sorted[j].knob;
            for (let i = 0; i < REFINE_STEPS && !attempts.some(inside); i += 1) {
                if (prefetch && i % 2 === 0) {
                    const knobs = bisectionKnobs(a, b, Math.min(2, REFINE_STEPS - i));
                    await prefetch([...knobs.map((kn) => [kn, seed]), ...reseedsOf(knobs)]);
                }
                const m = (a + b) / 2;
                const r = await run(m);
                if (r.numeric < mid) a = m;
                else b = m;
            }
        }
    }
    // more layouts at the in-range densities: pattern accuracy varies with the layout too
    const kept = attempts.filter(inside).slice(0, KEEP);
    await prefetch?.(kept.flatMap((a) => Array.from({ length: RESEEDS }, (_, j) => [a.knob, seed + (j + 1) * 7919])));
    for (const a of kept) {
        for (let k = 1; k <= RESEEDS; k += 1) await run(a.knob, seed + k * 7919);
    }

    const good = attempts.filter(inside);
    if (good.length) {
        good.sort((a, b) => b.score - a.score || Math.abs(a.numeric - mid) - Math.abs(b.numeric - mid));
        return { best: good[0], inRange: true };
    }
    const gap = (a) => (Number.isFinite(a.numeric) ? (a.numeric < lo ? lo - a.numeric : a.numeric - hi) : Infinity);
    attempts.sort((a, b) => gap(a) - gap(b));
    return { best: attempts[0], inRange: false };
}
