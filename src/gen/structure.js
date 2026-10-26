// Song structure from the stems: which bars repeat earlier bars (so repeated sections can get consistent patterns)
// and where phrases start (so families and blocks change on phrase lines). Pure and deterministic; runs in the
// worker during prepare and in the dataset tools. docs/2026-10-25-mapgen-v3-ml-addendum.md §2.3.
//
// 1. Bars from the grid (barsOf). 2. A vector per bar: mean chroma (12), mean timbre (12), and kick/snare/hat at the
//    4 quarters of a beat averaged over the bar (12); each column z-scored over the song, blocks weighted 1/0.7/0.7.
// 3. A self-similarity matrix (cosine). 4. Repeats: runs along each lag's diagonal (4-bar box) above τ, at least 4
//    bars long, picked longest first without overlapping targets. 5. Phrases: Foote novelty (checkerboard kernel),
//    the 4-bar grid phase that best fits novelty and part starts, 4-bar phrases merged into 8 where the middle line
//    is quiet, and a phrase at every part start.
//
// Structure = { v, meter, phase, params, bars: [{ startMs, endMs }], partBars: number[],
//               novelty: Float32Array(bars) 0..1 (at each bar's start line), repeats: [{ a, b, len, sim }] (bars),
//               echoOf: Int32Array(bars) (the earlier bar this one repeats, or −1), echoSim: Float32Array(bars),
//               phrases: [{ bar, bars }] covering every bar, phraseOf: Int32Array(bars) }
// Plain data only, so it can be cloned to and from a worker.
import { barsOf, detectParts } from "./songParts.js";
import { strengthsAt } from "./intensity.js";

export const STRUCTURE_VERSION = 1;
export const STRUCTURE_FEATURES = ["phrase_pos", "is_phrase_start", "bar_in_phrase", "has_echo", "rep_sim", "novelty"];
export const STRUCTURE_DEFAULTS = Object.freeze({
    meter: 4,
    tau: 0.7, // a lag's smoothed diagonal must stay above this for a repeat (tools/eval-structure.mjs: the lowest τ whose
    // repeats keep the human row Jaccard ≥ 0.3, about 5× random bar pairs; 100 train songs, 2026-10-26)
    kernelBars: 12, // the novelty kernel's width (best phrase-start F on the same songs; 8 was within 0.01)
    minLagBars: 4,
    minRepeatBars: 4,
    smoothBars: 4,
    partWeight: 1, // a part start on a grid line counts like a novelty peak when choosing the grid phase
    merge: "median-all", // two 4-bar phrases merge when their middle line's novelty is below this (see MERGE_RULES)
});

// What "quiet" means for the line between two 4-bar phrases: below the median over all bar lines, the median or
// the mean or the upper quartile over the grid lines, or never (4-bar phrases only).
const MERGE_RULES = {
    "median-all": (novelty) => medianOf(Array.from(novelty).slice(1)),
    median: (_, gridValues) => medianOf(gridValues),
    mean: (_, gridValues) => (gridValues.length ? gridValues.reduce((a, b) => a + b, 0) / gridValues.length : 0),
    q75: (_, gridValues) => quantileOf(gridValues, 0.75),
    none: () => -Infinity,
};
export const MAX_LISTED = 64;

const BLOCK_WEIGHTS = [1, 0.7, 0.7]; // chroma, timbre, percussion
const STD_FLOOR = 0.05; // columns that barely change over the song stay near 0 instead of being blown up to unit spread
const NORM_FLOOR = 1; // bars near the song's average are not "similar" to everything
const PERC_CURVES = ["kick", "snare", "hat"];

// ---- bar vectors ---------------------------------------------------------------------------------------------------

function frameTiming(stems) {
    const frameTimeSec = stems.frameTimeSec ?? ((f) => f * stems.hopSec + stems.frameOffsetSec);
    return { frameTimeSec, t0: frameTimeSec(0), hop: stems.hopSec ?? frameTimeSec(1) - frameTimeSec(0) };
}

// Beats of the slots: [{ t, beatMs, bar }] for every beat that has its downbeat slot.
function beatsOfBars(slots, bars) {
    const beats = [];
    bars.forEach((bar, k) => {
        for (let i = bar.i0; i < bar.i1; i += 1) {
            const s = slots[i];
            if ((s.pos ?? s.sub) === 0) beats.push({ t: s.t, beatMs: s.beatMs ?? 60000 / s.bpm, bar: k });
        }
    });
    return beats;
}

export function barVectors(stems, slots, bars) {
    const n = bars.length;
    const D = 36;
    const out = new Float64Array(n * D);
    const { t0, hop } = frameTiming(stems);
    const frames = stems.frames ?? stems.kick.length;
    const frameAt = (ms) => Math.min(frames, Math.max(0, Math.ceil((ms / 1000 - t0) / hop)));
    bars.forEach((bar, k) => {
        const f0 = frameAt(bar.startMs);
        const f1 = Math.max(f0, frameAt(bar.endMs));
        if (f1 > f0) {
            for (let f = f0; f < f1; f += 1) {
                for (let q = 0; q < 12; q += 1) {
                    out[k * D + q] += stems.chroma[f * 12 + q];
                    out[k * D + 12 + q] += stems.timbre[f * 12 + q];
                }
            }
            for (let q = 0; q < 24; q += 1) out[k * D + q] /= f1 - f0;
        }
    });
    const beats = beatsOfBars(slots, bars);
    const quarters = beats.flatMap((b) => [0, 1, 2, 3].map((q) => ({ t: b.t + (q * b.beatMs) / 4 })));
    const ft = frameTiming(stems).frameTimeSec;
    const count = new Float64Array(n);
    PERC_CURVES.forEach((name, c) => {
        const v = strengthsAt(stems[name], ft, quarters);
        beats.forEach((b, j) => {
            for (let q = 0; q < 4; q += 1) out[b.bar * D + 24 + c * 4 + q] += v[j * 4 + q];
            if (c === 0) count[b.bar] += 1;
        });
    });
    for (let k = 0; k < n; k += 1) if (count[k] > 0) for (let q = 24; q < 36; q += 1) out[k * D + q] /= count[k];
    // z-score each column over the song, then weight the blocks
    for (let d = 0; d < D; d += 1) {
        let sum = 0;
        let sq = 0;
        for (let k = 0; k < n; k += 1) sum += out[k * D + d];
        const mean = n ? sum / n : 0;
        for (let k = 0; k < n; k += 1) sq += (out[k * D + d] - mean) ** 2;
        const sd = Math.max(STD_FLOOR, Math.sqrt(n ? sq / n : 0));
        const w = BLOCK_WEIGHTS[Math.floor(d / 12)];
        for (let k = 0; k < n; k += 1) out[k * D + d] = (w * (out[k * D + d] - mean)) / sd;
    }
    return { vectors: out, dim: D };
}

// Cosine similarity between bars (n × n, symmetric), with a floor on the norms.
export function selfSimilarity(vectors, n, dim) {
    const norm = new Float64Array(n);
    for (let k = 0; k < n; k += 1) {
        let s = 0;
        for (let d = 0; d < dim; d += 1) s += vectors[k * dim + d] ** 2;
        norm[k] = Math.max(NORM_FLOOR, Math.sqrt(s));
    }
    const ssm = new Float32Array(n * n);
    for (let i = 0; i < n; i += 1) {
        for (let j = i; j < n; j += 1) {
            let s = 0;
            for (let d = 0; d < dim; d += 1) s += vectors[i * dim + d] * vectors[j * dim + d];
            const v = s / (norm[i] * norm[j]);
            ssm[i * n + j] = v;
            ssm[j * n + i] = v;
        }
    }
    return ssm;
}

// ---- repeats -------------------------------------------------------------------------------------------------------

const byPriority = (x, y) => y.len - x.len || y.sim - x.sim || x.b - x.a - (y.b - y.a) || x.b - y.b;

// Repeats along the lag diagonals: { repeats: [{ a, b, len, sim }] sorted by b, echoOf, echoSim }.
export function findRepeats(ssm, n, { tau = STRUCTURE_DEFAULTS.tau, minLagBars = STRUCTURE_DEFAULTS.minLagBars, minRepeatBars = STRUCTURE_DEFAULTS.minRepeatBars, smoothBars = STRUCTURE_DEFAULTS.smoothBars } = {}) {
    const sim = (i, j) => ssm[i * n + j];
    const meanDiag = (a, b, len) => {
        let s = 0;
        for (let k = 0; k < len; k += 1) s += sim(a + k, b + k);
        return s / len;
    };
    const back = (smoothBars - 1) >> 1;
    const ahead = smoothBars - 1 - back;
    const candidates = [];
    const d = new Float64Array(n);
    for (let lag = Math.max(1, minLagBars); lag + minRepeatBars <= n; lag += 1) {
        const m = n - lag;
        for (let i = 0; i < m; i += 1) d[i] = sim(i, i + lag);
        let runStart = -1;
        for (let i = 0; i <= m; i += 1) {
            let above = false;
            if (i < m) {
                const lo = Math.max(0, i - back);
                const hi = Math.min(m - 1, i + ahead);
                let s = 0;
                for (let k = lo; k <= hi; k += 1) s += d[k];
                above = s / (hi - lo + 1) >= tau;
            }
            if (above && runStart < 0) runStart = i;
            if (!above && runStart >= 0) {
                let a = runStart;
                let len = i - runStart;
                // snap to a multiple of 4 bars when one bar away: drop the weaker end, or grow at the end (else the start)
                if (len % 4 === 1 && len > 4) {
                    if (d[a] < d[a + len - 1]) a += 1;
                    len -= 1;
                } else if (len % 4 === 3) {
                    if (a + len < m) len += 1;
                    else if (a > 0) {
                        a -= 1;
                        len += 1;
                    }
                }
                if (len >= minRepeatBars) candidates.push({ a, b: a + lag, len, sim: meanDiag(a, a + lag, len) });
                runStart = -1;
            }
        }
    }
    candidates.sort(byPriority);
    const echoOf = new Int32Array(n).fill(-1);
    const echoSim = new Float32Array(n);
    const repeats = [];
    while (candidates.length) {
        const c = candidates.shift();
        let free = true;
        for (let k = 0; k < c.len; k += 1) if (echoOf[c.b + k] >= 0) free = false;
        if (free) {
            for (let k = 0; k < c.len; k += 1) {
                echoOf[c.b + k] = c.a + k;
                echoSim[c.b + k] = Math.min(1, Math.max(0, sim(c.a + k, c.b + k)));
            }
            repeats.push({ ...c, sim: Math.min(1, Math.max(0, c.sim)) });
            continue;
        }
        // keep the longest free stretch of the target, if it is still long enough
        let best = { at: 0, len: 0 };
        for (let k = 0, run = 0; k <= c.len; k += 1) {
            if (k < c.len && echoOf[c.b + k] < 0) run += 1;
            else {
                if (run > best.len) best = { at: k - run, len: run };
                run = 0;
            }
        }
        if (best.len >= minRepeatBars) {
            const len = best.len - (best.len % 4 === 1 && best.len > 4 ? 1 : 0);
            const trimmed = { a: c.a + best.at, b: c.b + best.at, len, sim: meanDiag(c.a + best.at, c.b + best.at, len) };
            let at = candidates.findIndex((x) => byPriority(trimmed, x) < 0);
            if (at < 0) at = candidates.length;
            candidates.splice(at, 0, trimmed);
        }
    }
    repeats.sort((x, y) => x.b - y.b);
    return { repeats, echoOf, echoSim };
}

// ---- phrases -------------------------------------------------------------------------------------------------------

// Foote novelty at each bar's start line (bar 0: 0), from a Gaussian-tapered checkerboard over ±kernelBars/2 bars,
// cut at the song's ends (the kernel weight is renormalised). With cosine similarities this is (mean similarity on
// the same side − mean across the line) / 2: 0 inside a steady stretch, up to 1 between opposite ones. Clipped to
// 0..1 and not rescaled, so a song without sections has no novelty peaks to chase.
export function noveltyCurve(ssm, n, kernelBars = STRUCTURE_DEFAULTS.kernelBars) {
    const w = Math.max(1, kernelBars >> 1);
    const sigma = Math.max(0.5, w / 2);
    const out = new Float32Array(n);
    for (let i = 1; i < n; i += 1) {
        let num = 0;
        let wsum = 0;
        for (let u = -w; u < w; u += 1) {
            const x = i + u;
            if (x < 0 || x >= n) continue;
            for (let v = -w; v < w; v += 1) {
                const y = i + v;
                if (y < 0 || y >= n) continue;
                const g = Math.exp(-((u + 0.5) ** 2 + (v + 0.5) ** 2) / (2 * sigma * sigma));
                num += (u < 0 === v < 0 ? g : -g) * ssm[x * n + y];
                wsum += g;
            }
        }
        out[i] = wsum > 0 ? Math.min(1, Math.max(0, num / wsum)) : 0;
    }
    return out;
}

function quantileOf(xs, q) {
    if (!xs.length) return 0;
    const s = Float64Array.from(xs).sort();
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const medianOf = (xs) => quantileOf(xs, 0.5);

// Phrases over n bars: { phase, phrases: [{ bar, bars }] }. The grid phase scores novelty at its lines plus
// partWeight for every forced line on it (part starts and the song's first bar, which settles a song with no clear
// novelty on phase 0). Two 4-bar phrases merge when the novelty at their middle line is quiet by the `merge` rule.
export function phrasesOf(novelty, n, partBars = [], { partWeight = STRUCTURE_DEFAULTS.partWeight, merge = STRUCTURE_DEFAULTS.merge } = {}) {
    if (n <= 0) return { phase: 0, phrases: [] };
    const forced = [...new Set([0, ...partBars.filter((p) => p > 0 && p < n)])].sort((a, b) => a - b);
    let phase = 0;
    let bestScore = -Infinity;
    for (let phi = 0; phi < 4; phi += 1) {
        let score = 0;
        for (let g = phi; g < n; g += 4) if (g > 0) score += novelty[g];
        for (const p of forced) if (p % 4 === phi) score += partWeight;
        if (score > bestScore) {
            bestScore = score;
            phase = phi;
        }
    }
    const grid = [];
    for (let g = phase; g < n; g += 4) if (g > 0) grid.push(g);
    const forcedSet = new Set(forced);
    // a grid line one bar from a forced line would leave a 1-bar phrase: that line goes
    const lines = [...new Set([...forced, ...grid.filter((g) => forced.every((p) => Math.abs(g - p) !== 1))])].sort((a, b) => a - b);
    const raw = lines.map((bar, k) => ({ bar, bars: (lines[k + 1] ?? n) - bar }));
    const rule = MERGE_RULES[merge];
    if (!rule) throw new Error(`unknown phrase merge rule: ${merge}`);
    const quiet = rule(novelty, grid.map((g) => novelty[g]));
    const phrases = [];
    for (let k = 0; k < raw.length; k += 1) {
        const p = raw[k];
        const next = raw[k + 1];
        if (next && p.bars === 4 && next.bars === 4 && !forcedSet.has(next.bar) && novelty[next.bar] < quiet) {
            phrases.push({ bar: p.bar, bars: 8 });
            k += 1;
        } else phrases.push({ ...p });
    }
    return { phase, phrases };
}

// ---- the whole structure -------------------------------------------------------------------------------------------

const nearestBar = (bars, ms) => {
    let best = 0;
    for (let k = 1; k < bars.length; k += 1) if (Math.abs(bars[k].startMs - ms) < Math.abs(bars[best].startMs - ms)) best = k;
    return best;
};

// { stems, slots, parts?, envelope? } → Structure, or null without stems or slots. `parts` ([{ startMs }]) wins;
// without them and with an envelope, detectParts finds them.
export function songStructure({ stems, slots, parts = null, envelope = null }, options = {}) {
    if (!stems || !slots?.length) return null;
    const params = { ...STRUCTURE_DEFAULTS, ...options };
    const rawBars = barsOf(slots, params.meter);
    const n = rawBars.length;
    const partList = parts ?? (envelope ? detectParts(envelope, slots) : []);
    const partBars = [...new Set(partList.map((p) => nearestBar(rawBars, p.startMs)).filter((k) => k > 0))].sort((a, b) => a - b);
    const { vectors, dim } = barVectors(stems, slots, rawBars);
    const ssm = selfSimilarity(vectors, n, dim);
    const { repeats, echoOf, echoSim } = findRepeats(ssm, n, params);
    const novelty = noveltyCurve(ssm, n, params.kernelBars);
    const { phase, phrases } = phrasesOf(novelty, n, partBars, params);
    const phraseOf = new Int32Array(n);
    phrases.forEach((p, k) => phraseOf.fill(k, p.bar, p.bar + p.bars));
    return {
        v: STRUCTURE_VERSION,
        meter: params.meter,
        phase,
        params,
        bars: rawBars.map((b) => ({ startMs: b.startMs, endMs: b.endMs })),
        partBars,
        novelty,
        repeats,
        echoOf,
        echoSim,
        phrases,
        phraseOf,
    };
}

// The bar a time falls in (the last bar starting at or before it; clamped to the song's bars).
function barIndexAt(bars, t) {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bars[mid].startMs <= t + 0.5) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// Per-slot columns, by time (so a cut of the slots gets the same values): { phrase_pos, is_phrase_start,
// bar_in_phrase, has_echo, rep_sim, novelty } as Float32Array.
export function structureColumns(structure, slots) {
    const n = slots.length;
    const cols = Object.fromEntries(STRUCTURE_FEATURES.map((name) => [name, new Float32Array(n)]));
    const { bars, phrases, phraseOf, echoOf, echoSim, novelty } = structure;
    if (!bars.length) return cols;
    for (let i = 0; i < n; i += 1) {
        const t = slots[i].t;
        const k = barIndexAt(bars, t);
        const bar = bars[k];
        const p = phrases[phraseOf[k]];
        const span = bar.endMs - bar.startMs;
        const frac = span > 0 ? Math.min(1 - 1e-6, Math.max(0, (t - bar.startMs) / span)) : 0;
        const inPhrase = k - p.bar;
        cols.phrase_pos[i] = Math.min(1 - 1e-6, (inPhrase + frac) / p.bars);
        cols.is_phrase_start[i] = inPhrase === 0 && Math.abs(t - bar.startMs) < 0.5 ? 1 : 0;
        cols.bar_in_phrase[i] = inPhrase;
        cols.has_echo[i] = echoOf[k] >= 0 ? 1 : 0;
        cols.rep_sim[i] = echoOf[k] >= 0 ? echoSim[k] : 0;
        cols.novelty[i] = novelty[k];
    }
    return cols;
}

// The generate-map response's view (§2.3): { phrases: [{ startMs, bars }], repeats: [{ aMs, bMs, lenMs, sim }] },
// at most 64 of each (the longest repeats).
export function structureToResponse(structure) {
    const { bars } = structure;
    const phrases = structure.phrases.slice(0, MAX_LISTED).map((p) => ({ startMs: bars[p.bar]?.startMs ?? 0, bars: p.bars }));
    const repeats = [...structure.repeats]
        .sort(byPriority)
        .slice(0, MAX_LISTED)
        .sort((x, y) => x.b - y.b)
        .map((r) => ({ aMs: bars[r.a].startMs, bMs: bars[r.b].startMs, lenMs: bars[r.b + r.len - 1].endMs - bars[r.b].startMs, sim: r.sim }));
    return { phrases, repeats };
}
