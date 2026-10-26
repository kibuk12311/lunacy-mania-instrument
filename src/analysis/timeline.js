// The analysis tab's line under the card: how hard the map is along its length (Sunny strain in bins) and which
// pattern family plays in each bin. Pure functions; computeDetails runs in the worker as the "details" job.
import { runSunnyEstimatorFromText, parseOsuManiaFromText, findPatterns } from "../core/leoblack.js";
import { chartInfo } from "../core/features.js";
import { FAMILIES, BREAK, familyShares } from "./families.js";
import { parseRows } from "../gen/mapRows.js";
import { flavourMarks, detectedFlavours } from "../gen/flavourMetrics.js";
import { FLAVOUR_IDS } from "../gen/flavours.js";
import { NAME_FAMILY } from "../gen/search.js";

export { FAMILIES, BREAK, familyShares };
export const BINS = 120;

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

// Highest strain per bin of [startMs, endMs] (empty bins and NaN read 0), scaled to the map's own peak.
export function binStrain(times, values, { startMs, endMs, bins = BINS }) {
    const out = new Array(bins).fill(0);
    const span = endMs - startMs;
    if (!(span > 0)) return out;
    const n = Math.min(times?.length ?? 0, values?.length ?? 0);
    for (let i = 0; i < n; i += 1) {
        const time = Number(times[i]);
        if (!Number.isFinite(time) || time < startMs || time > endMs) continue;
        const value = Number(values[i]);
        const bin = Math.min(bins - 1, Math.floor(((time - startMs) / span) * bins));
        if (Number.isFinite(value) && value > out[bin]) out[bin] = value;
    }
    const peak = Math.max(...out);
    return peak > 0 ? out.map((v) => round(v / peak, 3)) : out;
}

// Up to `max` stretches where the strain stays at share·peak or above, strongest first: [{ fromSec, toSec, peak }].
// A stretch narrower than minBins bins is noise and dropped, except the one holding the peak: it widens towards
// its stronger neighbour until it is minBins wide.
export function hardestRanges(strain, { durationSec, share = 0.85, minBins = 2, max = 3 } = {}) {
    const n = strain?.length ?? 0;
    const peak = n ? Math.max(...strain) : 0;
    if (!(peak > 0) || !(durationSec > 0)) return [];
    const level = share * peak;
    const runs = [];
    let from = null;
    for (let i = 0; i <= n; i += 1) {
        if (i < n && strain[i] >= level) {
            from ??= i;
        } else if (from !== null) {
            runs.push([from, i - 1]);
            from = null;
        }
    }
    const top = strain.indexOf(peak);
    const kept = runs.filter(([a, b]) => b - a + 1 >= minBins || (a <= top && top <= b)).map(([a, b]) => {
        while (b - a + 1 < minBins && (a > 0 || b < n - 1)) {
            if (b >= n - 1 || (a > 0 && strain[a - 1] >= strain[b + 1])) a -= 1;
            else b += 1;
        }
        return [a, b];
    });
    const binSec = durationSec / n;
    return kept
        .map(([a, b]) => ({
            fromSec: round(a * binSec, 1),
            toSec: Math.min(durationSec, round((b + 1) * binSec, 1)),
            peak: Math.max(...strain.slice(a, b + 1)),
        }))
        .sort((x, y) => y.peak - x.peak || x.fromSec - y.fromSec)
        .slice(0, max);
}

// The strip's family of one pattern instance from find(), by the generator's own table (search.js NAME_FAMILY: its
// sub-type, else its core pattern); null for what the strip leaves out (as the RC report does: coordination, density
// and wildcards) and for anything slower than 25 BPM.
const CORES = new Set(["Stream", "Chordstream", "Jacks"]);
export function familyOf(inst) {
    const msPerBeat = Number(inst?.MsPerBeat);
    const bpm = msPerBeat > 0 ? 60000 / msPerBeat : 0;
    if (!(bpm >= 25) || !CORES.has(inst.Pattern)) return null;
    return (NAME_FAMILY[inst.SpecificType] ?? NAME_FAMILY[inst.Pattern]).toLowerCase();
}

// Length of the union of [from, to] intervals.
function unionLength(intervals) {
    if (!intervals.length) return 0;
    const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
    let total = 0;
    let [lo, hi] = sorted[0];
    for (const [a, b] of sorted.slice(1)) {
        if (a > hi) {
            total += hi - lo;
            [lo, hi] = [a, b];
        } else if (b > hi) {
            hi = b;
        }
    }
    return total + hi - lo;
}

// The family that covers most of each bin of the played map (instances' times are ms at 1.0x from the first note,
// so they are divided by the rate): "tech" when uneven-rhythm instances cover techCover of the bin,
// BREAK when less than minCover of it holds any pattern. Overlapping instances count once.
export function binFamilies(instances, { durationMs, rate = 1, bins = BINS, minCover = 0.3, techCover = 0.6 }) {
    const out = new Array(bins).fill(BREAK);
    if (!(durationMs > 0)) return out;
    const binMs = durationMs / bins;
    const cells = Array.from({ length: bins }, () => ({ all: [], mixed: [], byFamily: new Map() }));
    for (const inst of instances ?? []) {
        const family = familyOf(inst);
        if (!family) continue;
        const start = Number(inst.Start) / rate;
        const end = Number(inst.End) / rate;
        if (!(end > start)) continue;
        const first = Math.max(0, Math.floor(start / binMs));
        const last = Math.min(bins - 1, Math.ceil(end / binMs) - 1);
        for (let i = first; i <= last; i += 1) {
            const lo = Math.max(start, i * binMs);
            const hi = Math.min(end, (i + 1) * binMs);
            if (hi <= lo) continue;
            const cell = cells[i];
            cell.all.push([lo, hi]);
            if (inst.Mixed) cell.mixed.push([lo, hi]);
            if (!cell.byFamily.has(family)) cell.byFamily.set(family, []);
            cell.byFamily.get(family).push([lo, hi]);
        }
    }
    cells.forEach((cell, i) => {
        if (unionLength(cell.all) / binMs < minCover) return;
        if (unionLength(cell.mixed) / binMs >= techCover) {
            out[i] = "tech";
            return;
        }
        let best = null;
        let bestCover = -1;
        for (const family of FAMILIES) {
            const cover = unionLength(cell.byFamily.get(family) ?? []);
            if (cover > bestCover) {
                best = family;
                bestCover = cover;
            }
        }
        out[i] = best;
    });
    return out;
}

// The flavour (sub-pattern, src/gen/flavours.js) that holds most rows of each bin, by our detector
// (flavourMetrics.js): BREAK when a bin has no rows or under minCover of them are in any flavour's motif.
// rows: [{ t, mask }] in ms of the file; times count from firstMs and are divided by the rate, like binFamilies.
export function binFlavours(rows, { firstMs = rows[0]?.t ?? 0, durationMs, rate = 1, bins = BINS, minCover = 0.3 }) {
    const out = new Array(bins).fill(BREAK);
    if (!(durationMs > 0) || !rows.length) return out;
    const { rows: sorted, marks } = flavourMarks(rows);
    const binMs = durationMs / bins;
    const binOf = (r) => Math.min(bins - 1, Math.max(0, Math.floor((r.t - firstMs) / rate / binMs)));
    const total = new Array(bins).fill(0);
    const counts = Array.from({ length: bins }, () => new Map());
    sorted.forEach((r, k) => {
        const b = binOf(r);
        total[b] += 1;
        for (const id of FLAVOUR_IDS) if (marks[id][k]) counts[b].set(id, (counts[b].get(id) ?? 0) + 1);
    });
    for (let b = 0; b < bins; b += 1) {
        let best = null;
        let most = 0;
        for (const id of FLAVOUR_IDS) {
            const n = counts[b].get(id) ?? 0;
            if (n > most) {
                best = id;
                most = n;
            }
        }
        if (best && most >= minCover * total[b]) out[b] = best;
    }
    return out;
}

// The worker's "details" job: one pattern parse, Sunny with its strain graph and the pattern instances
// → { v: 2, durationSec, strain: number[BINS], hardest, families: string[BINS], flavours: [{ id, share }] (the map's
// largest flavours by our detector), flavourBins: string[BINS] (flavour id or BREAK) } (about 3 KB).
// The time axis runs from the first note, in seconds of play at this rate, like the card's length.
export function computeDetails(osuText, rate = 1) {
    const { durationSec } = chartInfo(osuText, rate);
    const chart = parseOsuManiaFromText(osuText);
    const startMs = chart.FirstNote / rate;
    const graph = runSunnyEstimatorFromText(osuText, { speedRate: rate, withGraph: true })?.graph;
    const strain = binStrain(graph?.times ?? [], graph?.values ?? [], { startMs, endMs: startMs + durationSec * 1000, bins: BINS });
    const rows = parseRows(osuText, 4);
    return {
        v: 2,
        durationSec,
        strain,
        hardest: hardestRanges(strain, { durationSec }),
        families: binFamilies(findPatterns(chart), { durationMs: durationSec * 1000, rate, bins: BINS }),
        flavours: detectedFlavours(rows),
        flavourBins: binFlavours(rows, { firstMs: chart.FirstNote, durationMs: durationSec * 1000, rate, bins: BINS }),
    };
}

// The worker's answer to a "details" request: { kind: "details", details } | { kind: "error", message }.
export function detailsJob(osuText, rate) {
    try {
        return { kind: "details", details: computeDetails(osuText, rate) };
    } catch (error) {
        return { kind: "error", message: String(error?.message ?? error) };
    }
}
