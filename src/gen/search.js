// Find the density knob value whose map the analyzer labels exactly like the requested dan.
import { labelKey } from "../core/labels.js";
import { FINDER_NAME, FLAVOUR_FAMILY } from "./flavours.js";
import { plannedFlavourScore } from "./flavourMetrics.js";

// How many analyses a search may spend: coarse scan steps, bisection steps, reseeds per kept density, and how
// many in-range densities get reseeded.
export const DEFAULT_BUDGET = { coarse: 8, refine: 6, reseeds: 3, keep: 4 };
const NUDGES = [0.015, -0.015, 0.03, -0.03, 0.05, -0.05]; // × knob range

// evaluate(knob, seed) → { numeric, ... }; larger knob = denser map.
export async function searchKnob({ evaluate, target, min, max, seed, budget = DEFAULT_BUDGET }) {
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
    for (let k = 1; k <= COARSE_STEPS && !(best && hits(best)); k += 1) coarse.push(await run(min + (k / COARSE_STEPS) * range));
    const crossing = coarse.findIndex((a) => a.numeric >= target);
    if (crossing >= 0 && !hits(best)) {
        let lo = crossing === 0 ? min : coarse[crossing - 1].knob;
        let hi = coarse[crossing].knob;
        for (let i = 0; i < REFINE_STEPS && !hits(best); i += 1) {
            const mid = (lo + hi) / 2;
            const a = await run(mid);
            if (a.numeric < target) lo = mid;
            else hi = mid;
        }
    }
    for (const d of NUDGES) {
        if (hits(best)) break;
        const knob = best.knob + d * range;
        if (knob > min && knob <= max) await run(knob);
    }
    // Same density, different note layout: the analysed dan scatters by a few tenths, which often lands it.
    for (let k = 1; k <= RESEEDS && !hits(best); k += 1) {
        const around = best.knob;
        for (const d of [0, 0.02, -0.02]) {
            if (hits(best)) break;
            const knob = around + d * range;
            if (knob > min && knob <= max) await run(knob, seed + k * 7919);
        }
    }
    return { best, reachable: hits(best) };
}

// Step bands of the dan label scale (offset from the whole level): low, low/mid, mid, mid/high, high.
const STEP_BANDS = { "low": [-0.5, -0.3], "low/mid": [-0.3, -0.1], "mid": [-0.1, 0.1], "mid/high": [0.1, 0.3], "high": [0.3, 0.5] };

// "from Gamma low to Delta high" → numeric [lo, hi): the whole of both end steps is allowed.
export function danRange(a, b) {
    const [first, last] = a.level + STEP_BANDS[a.step][0] <= b.level + STEP_BANDS[b.step][0] ? [a, b] : [b, a];
    return { lo: first.level + STEP_BANDS[first.step][0], hi: last.level + STEP_BANDS[last.step][1] };
}

// Pattern-finder names → the generator's pattern families: the finder's 4K sub-types and its core names (a cluster
// without a sub-type is named after its core pattern: Stream, Chordstream, Jacks), and the other keymodes' names.
// Chordstream, Jumptrill, Light Chordstream, Brackets, Chord Rolls and Jacks were added with sub-patterns: where the
// finder reports them the family score is not the old one, so the learned search may keep another attempt and a
// family-only map can differ from before sub-patterns (tests/fixtures/familyGoldenNames.json pins that).
export const NAME_FAMILY = {
    Stream: "Stream", Rolls: "Stream", Trills: "Stream", Minitrills: "Stream",
    Jumpstream: "Jumpstream", Chordstream: "Jumpstream", Jumptrill: "Jumpstream", "Split Trill": "Jumpstream",
    "Double Stream": "Jumpstream", "Light Chordstream": "Jumpstream",
    Handstream: "Handstream", Brackets: "Handstream", "Chord Rolls": "Handstream",
    Chordjacks: "Chordjack", Quadstream: "Chordjack", "Dense Chordstream": "Chordjack",
    Jacks: "Jack", Minijacks: "Jack", Longjacks: "Jack", Gluts: "Jack",
};

// Share of the map that reads as one of the requested pattern families.
export function patternScore(top3, families) {
    const wanted = new Set(families);
    return (top3 ?? []).reduce((s, p) => s + (wanted.has(NAME_FAMILY[p.name]) ? p.share : 0), 0);
}

// How much a finder-named flavour's coverage leans on the finder (the rest is our detector).
export const FINDER_WEIGHT = 0.5;
// How much the family score of all families adds to the ranking once flavours are in play.
export const FAMILY_TIEBREAK = 0.1;

// How well each flavour planned in the rows (row.flavour) came out: { [id]: { rows, ours, finder, coverage } }, or
// null when no row has one. ours: the share of its planned rows that our detector finds in its motif
// (flavourMetrics.js); finder (finder-named flavours, when there is a finder result top3): how much of the map the
// finder calls by its name against the share of rows planned as it, at most 1; coverage: ours, or for a named one
// FINDER_WEIGHT of it the finder's.
export function flavourCoverageOf(rows, top3) {
    const planned = plannedFlavourScore(rows ?? []);
    if (!planned) return null;
    const total = rows.length || 1;
    const out = {};
    for (const [id, { rows: n, hit }] of Object.entries(planned.byFlavour)) {
        const ours = hit / n;
        const name = FINDER_NAME[id];
        const finder = name && top3 ? Math.min(1, top3.filter((p) => p.name === name).reduce((a, p) => a + p.share, 0) / (n / total)) : null;
        out[id] = { rows: n, ours, finder, coverage: finder === null ? ours : (1 - FINDER_WEIGHT) * ours + FINDER_WEIGHT * finder };
    }
    return out;
}

// Each family's share of the planned slots from..to (assign: the family per slot, null for none) → { [family]: share }.
export function planShares(assign, from = 0, to = assign.length) {
    const counts = {};
    let n = 0;
    for (let i = from; i < to; i += 1) {
        const f = assign[i];
        if (!f) continue;
        counts[f] = (counts[f] ?? 0) + 1;
        n += 1;
    }
    for (const f of Object.keys(counts)) counts[f] /= n || 1;
    return counts;
}

// Pattern accuracy once flavours are planned (the same in the map search, the per-part search, the weak-block redo and
// the part reports):
//   target = the family score of the families without planned flavours + Σ share × coverage of the families with them
//   score  = target + FAMILY_TIEBREAK × the family score of all families (the ranking: flavours first, families second)
// families: the families judged; familyScoreOf(families) → the family score exactly as it has always been counted (the
// finder's share of those families, plus the Tech flag where it counts); shares: { family: share } of the judged
// stretch (planShares), else the rows' own split. → { score, target, patternScore (target, at most 1), flavourScore
// (0..1, how much of the chosen flavours came out), familyScore, coverage }. With no flavour planned in the rows,
// score = target = patternScore = familyScore: the family score unchanged (which, through NAME_FAMILY above, is the
// old one only for the finder names whose family did not change).
export function flavourAwareScore({ rows, top3, families, familyScoreOf, shares = null }) {
    const familyScore = familyScoreOf(families);
    const coverage = flavourCoverageOf(rows, top3);
    if (!coverage) return { score: familyScore, target: familyScore, patternScore: familyScore, flavourScore: null, familyScore, coverage: null };
    // per flavoured family: its coverage, weighted by planned rows of each of its flavours
    const byFamily = {};
    for (const [id, c] of Object.entries(coverage)) {
        const f = (byFamily[FLAVOUR_FAMILY[id]] ??= { rows: 0, sum: 0 });
        f.rows += c.rows;
        f.sum += c.rows * c.coverage;
    }
    let split = shares;
    if (!split) {
        split = {};
        for (const r of rows) {
            const f = r.family ?? FLAVOUR_FAMILY[r.flavour];
            if (f) split[f] = (split[f] ?? 0) + 1 / rows.length;
        }
    }
    const plain = families.filter((f) => !byFamily[f]);
    let flavoured = 0;
    let weight = 0;
    for (const [f, { rows: n, sum }] of Object.entries(byFamily)) {
        const share = split[f] ?? 0;
        flavoured += share * (sum / n);
        weight += share;
    }
    const target = (plain.length ? familyScoreOf(plain) : 0) + flavoured;
    // without a share for them (a stretch the shares do not cover) the flavours count by their planned rows
    const all = Object.values(byFamily);
    const flavourScore = weight > 0 ? flavoured / weight : all.reduce((a, f) => a + f.sum, 0) / all.reduce((a, f) => a + f.rows, 0);
    return {
        score: target + FAMILY_TIEBREAK * familyScore,
        target,
        patternScore: Math.min(1, target),
        flavourScore,
        familyScore,
        coverage,
    };
}

// Any dan inside [lo, hi) is fine; among those the most pattern-accurate attempt wins.
// evaluate(knob, seed) → { numeric, ... }; larger knob = denser. score(attempt) → pattern accuracy 0..1.
export async function searchRange({ evaluate, lo, hi, min, max, seed, score, budget = DEFAULT_BUDGET }) {
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
    for (let k = 0; k <= COARSE_STEPS; k += 1) await run(min + (k / COARSE_STEPS) * (max - min));

    if (!attempts.some(inside)) {
        // bisect towards the middle of the range inside the bracket that crosses it
        const sorted = [...attempts].sort((a, b) => a.knob - b.knob);
        const j = sorted.findIndex((a) => a.numeric >= mid);
        if (j > 0) {
            let a = sorted[j - 1].knob;
            let b = sorted[j].knob;
            for (let i = 0; i < REFINE_STEPS && !attempts.some(inside); i += 1) {
                const m = (a + b) / 2;
                const r = await run(m);
                if (r.numeric < mid) a = m;
                else b = m;
            }
        }
    }
    // more layouts at the in-range densities: pattern accuracy varies with the layout too
    for (const a of attempts.filter(inside).slice(0, KEEP)) {
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
