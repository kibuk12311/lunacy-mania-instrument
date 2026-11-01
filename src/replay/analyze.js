// A replay against its map: the judgements recomputed (judge.js), how they compare with the counts in the replay's
// header, accuracy, unstable rate, hit errors (histogram, along the map, per column), keys per second, misses and combo
// breaks, and the manip percent (manip.js). Everything here is pure and works on plain data, so main hands the result
// to the window as it is. Times: `t`, `at`, `press` ms of the map; delta and seconds of play are real time.
import { judgeReplay, countKinds, comboOf, accuracyPercent, KINDS } from "./judge.js";
import { manipPairs, manipSummary, manipByPart, MANIP, HANDS } from "./manip.js";
import { fullCounts, unwrapped } from "./osr.js";

export const HIST_BIN_MS = 5;
export const TIMELINE_BINS = 60;
export const HOLD_HEAVY = 0.2; // from this share of holds the recount is only near osu!'s (judge.js), and the tab says so

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

export function spread(values) {
    if (!values.length) return { mean: null, sd: null };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
    return { mean, sd };
}

// Unstable rate as osu! shows it: 10 × the standard deviation of the hit errors in real ms, null without hits.
export const unstableRate = (deltas) => {
    const { sd } = spread(deltas);
    return sd === null ? null : round2(sd * 10);
};

// Hit errors → { binMs, from, counts }: symmetric bins from −reach to +reach, an outlier goes to the end bin.
export function errorHistogram(deltas, reachMs, binMs = HIST_BIN_MS) {
    const half = Math.max(1, Math.ceil(reachMs / binMs));
    const counts = new Array(half * 2).fill(0);
    for (const d of deltas) counts[Math.max(0, Math.min(half * 2 - 1, Math.floor(d / binMs) + half))] += 1;
    return { binMs, from: -half * binMs, counts };
}

// Key presses per second of play: { perSec: [count per second from fromMs], peak, mean }.
export function keysPerSecond(columns, { fromMs, toMs, rate = 1 }) {
    const seconds = Math.max(1, Math.ceil((toMs - fromMs) / rate / 1000));
    const perSec = new Array(seconds).fill(0);
    for (const list of columns) {
        for (const p of list) {
            const s = Math.floor((p.t - fromMs) / rate / 1000);
            if (s >= 0 && s < seconds) perSec[s] += 1;
        }
    }
    const total = perSec.reduce((a, b) => a + b, 0);
    return { perSec, peak: Math.max(0, ...perSec), mean: round1(total / seconds) };
}

// How the counts worked out here stand against the header's: { same, diff: { kind: ours − header }, wrong (notes that
// differ), total }.
export function compareCounts(ours, header) {
    const diff = Object.fromEntries(KINDS.map((k) => [k, ours[k] - header[k]]));
    const sum = KINDS.reduce((s, k) => s + Math.abs(diff[k]), 0);
    return { same: sum === 0, diff, wrong: Math.ceil(sum / 2), total: KINDS.reduce((s, k) => s + header[k], 0) };
}

// header: readOsr's; notes, keys: the map's (parseManiaNotes); od: its OverallDifficulty; frames: unpackFrames';
// columns: keyPresses'; parts: [{ fromMs, toMs }] (ms of the map), or none; hands: which columns are one hand (manip.js).
// → { reason } when it cannot be worked out: "random" (the Random mod moved the notes by a seed), "keys" (not 4K),
// "empty" (no frames, no notes); else the analysis. headerCounts: the header's counts with what 16 bits lost put back,
// there in every answer; headerCombo: the same of its max combo, with the analysis.
export function analyzeReplay({ header, notes, keys = 4, od, frames, columns, parts = [], hands = HANDS }) {
    const lastMs = frames.times.at(-1);
    const headerCounts = fullCounts(header.counts, lastMs === undefined ? 0 : notes.filter((n) => n.t <= lastMs).length);
    if (keys !== 4) return { reason: "keys", headerCounts };
    if (header.modNames.includes("RD")) return { reason: "random", headerCounts };
    const pressed = notes.filter((n) => !n.reversed);
    if (!pressed.length || !frames.times.length) return { reason: "empty", headerCounts };
    const rate = header.rate;
    const { modNames } = header;
    const scoreV2 = modNames.includes("V2");
    const headerTotal = KINDS.reduce((sum, k) => sum + headerCounts[k], 0);
    const limit = !scoreV2 && headerTotal > 0 ? headerTotal : null;
    const { windows, results, strays, given } = judgeReplay(notes, columns, { od, modNames, rate, keys, lastMs, limit });
    const judged = countKinds(results);
    const counts = { ...judged, n300: judged.n300 + given };
    const combo = comboOf(results);
    const hits = results.filter((r) => r.delta !== null);
    const deltas = hits.map((r) => r.delta);
    const { mean, sd } = spread(deltas);
    const fromMs = pressed[0].t;
    const toMs = Math.max(pressed.at(-1).t, pressed.at(-1).end ?? 0);
    const reached = results.length ? Math.max(...results.slice(-8).map((r) => r.t)) : toMs;
    const headerCombo = unwrapped(header.maxCombo, combo.maxCombo);
    const holdCount = pressed.filter((n) => n.end !== null).length;
    const holds = holdCount > 0;
    const pairs = manipPairs(results, rate, MANIP, hands);
    // presses that met no note, between the first note and the last one reached (not the keys tapped before the song)
    const ghosts = strays.filter((s) => s.t >= fromMs - windows.miss && s.t <= reached + windows.miss).sort((a, b) => a.t - b.t);
    const byColumn = Array.from({ length: keys }, (_, c) => {
        const own = results.filter((r) => r.col === c);
        const list = own.filter((r) => r.delta !== null).map((r) => r.delta);
        const s = spread(list);
        return {
            col: c, notes: own.length, hits: list.length, misses: own.filter((r) => r.kind === "miss").length,
            mean: s.mean === null ? null : round1(s.mean), sd: s.sd === null ? null : round1(s.sd),
            early: list.filter((d) => d < 0).length, late: list.filter((d) => d > 0).length,
        };
    });
    return {
        rate, od, windows, scoreV2, holds, holdHeavy: holdCount / pressed.length >= HOLD_HEAVY,
        counts, accuracy: accuracyPercent(counts), comparison: scoreV2 ? null : compareCounts(counts, headerCounts),
        headerCounts, headerAccuracy: accuracyPercent(headerCounts),
        combo: { max: combo.maxCombo, breaks: combo.breaks },
        headerCombo, maxComboComparable: !holds && combo.maxCombo === headerCombo,
        ur: unstableRate(deltas), meanError: mean === null ? null : round1(mean), sd: sd === null ? null : round1(sd),
        histogram: errorHistogram(deltas, windows.n50 / rate),
        byColumn,
        keys: keysPerSecond(columns, { fromMs, toMs, rate }),
        misses: results.filter((r) => r.kind === "miss").map((r) => ({ t: r.t, col: r.col, early: r.early })),
        ghosts,
        results: results.map((r) => ({ t: r.t, col: r.col, end: r.end, kind: r.kind, at: r.at, press: r.press, up: r.up, early: r.early, delta: r.delta === null ? null : round1(r.delta) })),
        fromMs, toMs, reachedMs: reached, played: results.length + given, notes: notes.length, parts,
        manip: { ...manipSummary(pairs, { fromMs, toMs, bins: TIMELINE_BINS, sdMs: sd }), parts: manipByPart(pairs, parts) },
    };
}

