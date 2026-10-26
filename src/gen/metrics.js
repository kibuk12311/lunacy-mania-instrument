// How close generated maps are to human ones, for the evaluation tools (tools/eval-generator.mjs and the model
// comparison): note timing, density over the song, jack loops, awkward spots and pattern accuracy.
import { findIssues } from "./playability.js";
import { patternScore } from "./search.js";

const maskOf = (row) => row.mask ?? (row.cols ?? []).reduce((m, c) => m | (1 << c), 0);
const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));

// F1 of row times: a generated row matches a human row within ±tol ms (each human row at most once).
export function onsetF1(gen, human, tol = 20) {
    const a = [...gen].sort((x, y) => x - y);
    const b = [...human].sort((x, y) => x - y);
    if (!a.length && !b.length) return 1;
    let j = 0;
    let hit = 0;
    for (const t of a) {
        while (j < b.length && b[j] < t - tol) j += 1;
        if (j < b.length && Math.abs(b[j] - t) <= tol) {
            hit += 1;
            j += 1;
        }
    }
    return (2 * hit) / (a.length + b.length);
}

// Correlation of the row counts per stretch of secMs (e.g. 8 beats) between two maps of one song.
export function densityCorr(gen, human, endMs, secMs) {
    const n = Math.max(1, Math.ceil(endMs / secMs));
    const ca = new Float64Array(n);
    const cb = new Float64Array(n);
    for (const t of gen) ca[Math.min(n - 1, Math.max(0, Math.floor(t / secMs)))] += 1;
    for (const t of human) cb[Math.min(n - 1, Math.max(0, Math.floor(t / secMs)))] += 1;
    const mean = (v) => v.reduce((s, x) => s + x, 0) / n;
    const ma = mean(ca);
    const mb = mean(cb);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i += 1) {
        num += (ca[i] - ma) * (cb[i] - mb);
        da += (ca[i] - ma) ** 2;
        db += (cb[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
}

// Share of rows that repeat both rows before them exactly (the generator stuck in a loop of one shape).
export function jackLoopRate(rows) {
    if (rows.length < 3) return 0;
    let loops = 0;
    for (let k = 2; k < rows.length; k += 1) {
        const m = maskOf(rows[k]);
        if (m === maskOf(rows[k - 1]) && m === maskOf(rows[k - 2])) loops += 1;
    }
    return loops / rows.length;
}

// Awkward spots (findIssues, without the map-wide column one) per 1000 notes.
export function violationsPer1000(rows, slots) {
    const notes = rows.reduce((s, r) => s + popcount(maskOf(r)), 0);
    if (!notes) return 0;
    return (findIssues(rows, slots).filter((x) => x.kind !== "columns").length * 1000) / notes;
}

// How much of a map reads as the wanted families, from its analysis' top3.
export function patternAccuracy(top3, families) {
    return patternScore(top3, families);
}
