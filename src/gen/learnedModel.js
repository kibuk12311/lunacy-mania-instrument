// Evaluating the mapper learned from real maps (models/mapper.json, made by tools/train_mapper.py).
import { PROPOSAL } from "./flavours.js";

const isMissing = (v) => v === null || v === undefined || Number.isNaN(v);

// Raw scores of an exported HistGradientBoostingClassifier: one per class (binary models have one).
export function treeRaw(spec, x) {
    const out = spec.baseline.slice();
    for (const trees of spec.iterations) {
        for (let k = 0; k < trees.length; k += 1) {
            const t = trees[k];
            let node = 0;
            while (!t.leaf[node]) {
                const v = x[t.feature[node]];
                const goLeft = isMissing(v) ? t.missingLeft[node] === 1 : v <= t.threshold[node];
                node = goLeft ? t.left[node] : t.right[node];
            }
            out[k] += t.value[node];
        }
    }
    return out;
}

// `offset` shifts the log-odds: the generator's density knob.
export function noteProbability(spec, x, offset = 0) {
    return 1 / (1 + Math.exp(-(treeRaw(spec, x)[0] + offset)));
}

// [P(1 note), P(2), P(3), P(4)]
export function sizeProbabilities(spec, x) {
    const raw = treeRaw(spec, x);
    const max = Math.max(...raw);
    const exp = raw.map((r) => Math.exp(r - max));
    const total = exp.reduce((a, b) => a + b, 0);
    const out = [0, 0, 0, 0];
    (spec.classes ?? [1, 2, 3, 4]).forEach((size, k) => {
        if (size >= 1 && size <= 4) out[size - 1] = exp[k] / total;
    });
    return out;
}

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const MASKS_BY_SIZE = [1, 2, 3, 4].map((size) => Array.from({ length: 15 }, (_, i) => i + 1).filter((m) => popcount(m) === size));

const backoffCache = new WeakMap();
function backoff(pattern) {
    if (backoffCache.has(pattern)) return backoffCache.get(pattern);
    const byPrev = {};
    const bySize = {};
    for (const [family, table] of Object.entries(pattern)) {
        byPrev[family] = {};
        bySize[family] = {};
        for (const [key, counts] of Object.entries(table)) {
            const [prev, , size] = key.split(",");
            for (const [mask, c] of Object.entries(counts)) {
                const a = (byPrev[family][`${prev},${size}`] ??= {});
                a[mask] = (a[mask] ?? 0) + c;
                const b = (bySize[family][size] ??= {});
                b[mask] = (b[mask] ?? 0) + c;
            }
        }
    }
    const result = { byPrev, bySize };
    backoffCache.set(pattern, result);
    return result;
}

function drawFrom(counts, rng) {
    const entries = Object.entries(counts);
    const total = entries.reduce((s, [, c]) => s + c, 0);
    let r = rng() * total;
    for (const [mask, c] of entries) {
        r -= c;
        if (r < 0) return Number(mask);
    }
    return Number(entries.at(-1)[0]);
}

// Columns of the next row: how real mappers continued from the last two rows in this pattern family.
// Backs off to (previous row, size), then to (size) alone, then to any mask of that size avoiding the last row.
// `weightOf(mask)` (the playability guard) re-weights the candidates; when it rules all of them out the answer is
// weightOf.fallback().
export function sampleMask(pattern, family, prev, prev2, size, rng, weightOf = null) {
    const draw = (counts) => drawWeighted(counts, rng, weightOf);
    const table = pattern[family] ?? {};
    const exact = table[`${prev},${prev2},${size}`];
    if (exact) return draw(exact);
    const { byPrev, bySize } = backoff(pattern);
    const near = byPrev[family]?.[`${prev},${size}`];
    if (near) return draw(near);
    const free = MASKS_BY_SIZE[size - 1].filter((m) => (m & prev) === 0);
    const any = bySize[family]?.[String(size)];
    if (any) {
        const filtered = Object.fromEntries(Object.entries(any).filter(([m]) => (Number(m) & prev) === 0));
        return draw(Object.keys(filtered).length ? filtered : any);
    }
    const pool = free.length ? free : MASKS_BY_SIZE[size - 1];
    if (!weightOf) return pool[Math.floor(rng() * pool.length)];
    return draw(Object.fromEntries(pool.map((m) => [m, 1])));
}

// drawFrom over counts × weightOf; all ruled out → weightOf.fallback() (the guard's pick), without drawing.
function drawWeighted(counts, rng, weightOf) {
    if (!weightOf) return drawFrom(counts, rng);
    const weighted = {};
    let total = 0;
    for (const [mask, c] of Object.entries(counts)) {
        const w = c * weightOf(Number(mask));
        weighted[mask] = w;
        total += w;
    }
    return total > 0 ? drawFrom(weighted, rng) : weightOf.fallback();
}

const rowIndexCache = new WeakMap();
// Per family: continuations by the last two rows, by the last row, overall, and (order-3 tables, keys
// "prev,prev2,prev3,size") by the last three rows.
function rowIndex(pattern) {
    if (rowIndexCache.has(pattern)) return rowIndexCache.get(pattern);
    const index = {};
    for (const [family, table] of Object.entries(pattern)) {
        const byCtx3 = {};
        const byCtx = {};
        const byPrev = {};
        const all = {};
        const sizeTotals = [0, 0, 0, 0];
        for (const [key, counts] of Object.entries(table)) {
            const parts = key.split(",");
            const [prev, prev2] = parts;
            for (const [mask, c] of Object.entries(counts)) {
                if (parts.length === 4) {
                    const z = (byCtx3[`${prev},${prev2},${parts[2]}`] ??= {});
                    z[mask] = (z[mask] ?? 0) + c;
                }
                const a = (byCtx[`${prev},${prev2}`] ??= {});
                a[mask] = (a[mask] ?? 0) + c;
                const b = (byPrev[prev] ??= {});
                b[mask] = (b[mask] ?? 0) + c;
                all[mask] = (all[mask] ?? 0) + c;
                sizeTotals[popcount(Number(mask)) - 1] += c;
            }
        }
        const total = sizeTotals.reduce((x, y) => x + y, 0) || 1;
        index[family] = { byCtx3, byCtx, byPrev, all, sizeRate: sizeTotals.map((c) => Math.max(c / total, 1e-4)) };
    }
    rowIndexCache.set(pattern, index);
    return index;
}

// How often each row size (1..4) occurs in a family's real maps.
export function familySizeRates(pattern, family) {
    return rowIndex(pattern)[family]?.sizeRate ?? [0.5, 0.35, 0.12, 0.03];
}

const MIN_EVIDENCE = 20;
export const STYLE_ALPHA = 4; // a mapper's own continuations count this many times over the global ones (§2.6)
const JACK_FAMILIES = new Set(["Chordjack", "Jack"]);
const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

// The whole next row (its size and its columns) from the family's real continuations of the last two rows (of the
// last three with order-3 tables, when `prev3` is given and the context is well seen);
// `sizeWeights[k]` only re-weights rows of k+1 notes, so the family's own habits (no jacks in a stream) stay in charge.
// Contexts seen fewer than MIN_EVIDENCE times are not trusted: after a row that is rare for the family the few
// recorded continuations are often jacks, and following them locks the generator into a jack loop.
// `weightOf(mask)` (the playability guard) re-weights the rows too; when it rules all of them out the row is
// weightOf.fallback(). Without it (or with weightOf ≡ 1) the draws are exactly the old ones.
// `bias` (a flavour's motif weights per mask, flavours.js motifWeights) bends the row towards the flavour: every mask
// gets motif × (its share among the family's continuations + PROPOSAL), so a motif row the human maps never had after
// this context still comes up, and among the motif's rows the family's own habits decide. Without it, nothing changes.
// `style` ({ pattern: model.stylePattern[key], alpha }, ML addendum §2.6) blends a mapper's own continuations in: at
// the context level the global table chose, counts_global + alpha·counts_creator when the creator has at least
// MIN_EVIDENCE rows there (else the global counts alone). Without it (null), nothing changes.
export function sampleRow(pattern, family, prev, prev2, sizeWeights, rng, weightOf = null, prev3 = null, bias = null, style = null) {
    const fam = rowIndex(pattern)[family];
    if (!fam && bias) {
        const weighted = {};
        for (let m = 1; m < 16; m += 1) weighted[m] = bias[m] * sizeWeights[popcount(m) - 1];
        return drawWeighted(weighted, rng, weightOf);
    }
    if (!fam) return sampleMask(pattern, family, prev, prev2, 1, rng, weightOf);
    const own = style?.pattern ? rowIndex(style.pattern)[family] ?? null : null;
    const deepKey = `${prev},${prev2},${prev3}`;
    const exactKey = `${prev},${prev2}`;
    const deep = prev3 !== null ? fam.byCtx3[deepKey] : null;
    const exact = fam.byCtx[exactKey];
    const near = fam.byPrev[String(prev)];
    // no reliable continuation: the family's general row mix, minus jacks unless jacks are the family (the global
    // table falls back to its whole mix when nothing is left; the creator's then adds nothing)
    const noJacks = (all) => (JACK_FAMILIES.has(family) ? all : Object.fromEntries(Object.entries(all).filter(([m]) => (Number(m) & prev) === 0)));
    const general = (all) => {
        const kept = noJacks(all);
        return Object.keys(kept).length ? kept : all;
    };
    let counts;
    let mine = null; // the creator's counts at the same level
    if (deep && total(deep) >= MIN_EVIDENCE) {
        counts = deep;
        mine = own?.byCtx3[deepKey];
    } else if (exact && total(exact) >= MIN_EVIDENCE) {
        counts = exact;
        mine = own?.byCtx[exactKey];
    } else if (near && total(near) >= MIN_EVIDENCE) {
        counts = near;
        mine = own?.byPrev[String(prev)];
    } else {
        counts = general(fam.all);
        mine = own ? noJacks(own.all) : null;
    }
    if (mine && total(mine) >= MIN_EVIDENCE) {
        const alpha = Number.isFinite(style.alpha) ? style.alpha : STYLE_ALPHA;
        const blended = { ...counts };
        for (const [mask, c] of Object.entries(mine)) blended[mask] = (blended[mask] ?? 0) + alpha * c;
        counts = blended;
    }
    const weighted = {};
    if (bias) {
        const sum = total(counts) || 1;
        for (let m = 1; m < 16; m += 1) weighted[m] = bias[m] * ((counts[m] ?? 0) / sum + PROPOSAL) * sizeWeights[popcount(m) - 1];
        return drawWeighted(weighted, rng, weightOf);
    }
    for (const [mask, c] of Object.entries(counts)) weighted[mask] = c * sizeWeights[popcount(Number(mask)) - 1];
    return drawWeighted(weighted, rng, weightOf);
}
