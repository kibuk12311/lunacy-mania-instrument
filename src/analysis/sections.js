// The dan of each part of a map (the analysis tab's «Дан по частям»): the map cut into parts of about half a minute,
// each part rated by the card's own dan model as a chart of its own at the play's rate, and the dans corrected for
// what a short part lacks against the whole map (stamina, length) by a fit on the training corpus
// (tools/calibrate-sections.mjs → sectionCalibration.js). Pure but for the analysis itself; computeSections runs in the
// worker as the "sections" job. The map's dan on the card is not touched: this is a block of its own.
//
// Cutting: the notes' times on the play's clock (seconds from the first note at this rate); a gap of BREAK_SEC or
// more without notes is a break, and no part runs over one. A stretch between breaks up to MAX_SEC long is one part;
// a longer one is cut by dynamic programming where its note density changes most (the parts' squared deviations from
// their own mean density, plus a cost per part and for straying from TARGET_SEC, parts MIN_SEC..MAX_SEC long), each
// cut moved to the widest gap between notes within SNAP_SEC of it. That follows the song's own build-ups, drops and
// calm stretches on any chart, Interlude's too, without its audio.
import { analyzeChart } from "../core/analyze.js";
import { CALIBRATION } from "./sectionCalibration.js";

export const SECTIONS_VERSION = 1;
export const TARGET_SEC = 24;
export const MIN_SEC = 12;
export const MAX_SEC = 40;
export const BREAK_SEC = 4;
export const SNAP_SEC = 1.5;
export const MIN_PART_NOTES = 24; // fewer notes than this: a quiet part, no dan of its own
const PART_COST = 1.5; // one more part, against the normalised squared change of density it explains
const LENGTH_COST = 3; // per (length − target)² / target² of a part

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function hitObjectLines(osuText) {
    const lines = osuText.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "[HitObjects]");
    if (start < 0) return { lines, start, objects: [] };
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].trim().startsWith("[")) {
            end = i;
            break;
        }
    }
    const objects = [];
    for (let i = start + 1; i < end; i += 1) {
        const p = lines[i].split(",");
        const t = Number(p[2]);
        if (p.length >= 3 && Number.isFinite(t)) objects.push({ t, line: lines[i] });
    }
    return { lines, start, end, objects };
}

// The notes' times in ms of the file, sorted.
export function noteTimes(osuText) {
    return hitObjectLines(osuText).objects.map((o) => o.t).sort((a, b) => a - b);
}

// The chart with only the notes that start in [fromMs, toMs) (ms of the file), everything else kept as it is.
export function sectionChart(osuText, fromMs, toMs) {
    const { lines, start, end, objects } = hitObjectLines(osuText);
    if (start < 0) return osuText;
    const kept = objects.filter((o) => o.t >= fromMs && o.t < toMs).map((o) => o.line);
    return [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join(osuText.includes("\r\n") ? "\r\n" : "\n");
}

// Notes per second of a stretch [a, b) in seconds (1 s bins), smoothed over 3 bins and divided by its own mean.
function densityOf(secs, a, b) {
    const n = Math.max(1, Math.ceil(b - a));
    const raw = new Array(n).fill(0);
    for (const s of secs) if (s >= a && s < b) raw[Math.min(n - 1, Math.floor(s - a))] += 1;
    const smooth = raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] + raw[Math.min(n - 1, i + 1)]) / 3);
    const mean = smooth.reduce((x, y) => x + y, 0) / n || 1;
    return smooth.map((v) => v / mean);
}

// Cuts of a stretch of n 1-s bins into parts minBins..maxBins long: [0, …, n] bin edges.
export function cutStretch(density, { target = TARGET_SEC, min = MIN_SEC, max = MAX_SEC, partCost = PART_COST, lengthCost = LENGTH_COST } = {}) {
    const n = density.length;
    if (n <= max) return [0, n];
    const sum = [0];
    const sq = [0];
    for (const v of density) {
        sum.push(sum.at(-1) + v);
        sq.push(sq.at(-1) + v * v);
    }
    const cost = (i, j) => {
        const len = j - i;
        const s = sum[j] - sum[i];
        return sq[j] - sq[i] - (s * s) / len + partCost + lengthCost * ((len - target) / target) ** 2;
    };
    const best = new Array(n + 1).fill(Infinity);
    const from = new Array(n + 1).fill(-1);
    best[0] = 0;
    for (let j = 1; j <= n; j += 1) {
        for (let i = Math.max(0, j - max); i <= j - min; i += 1) {
            if (best[i] === Infinity) continue;
            const c = best[i] + cost(i, j);
            if (c < best[j]) {
                best[j] = c;
                from[j] = i;
            }
        }
    }
    if (best[n] === Infinity) return [0, n]; // cannot happen while max ≥ 2·min
    const edges = [n];
    for (let j = n; j > 0; j = from[j]) edges.push(from[j]);
    return edges.reverse();
}

// The parts of a map: [{ fromMs, toMs }] in ms of the file (toMs past the part's last note, the next part's fromMs),
// together holding every note. times: noteTimes(); rate: the play's.
export function splitSections(times, { rate = 1, target = TARGET_SEC, min = MIN_SEC, max = MAX_SEC, breakSec = BREAK_SEC, snapSec = SNAP_SEC } = {}) {
    const sorted = [...(times ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return [];
    const r = Number(rate) > 0 ? Number(rate) : 1;
    const first = sorted[0];
    const secs = sorted.map((t) => (t - first) / 1000 / r);
    const toMs = (s) => first + s * 1000 * r;
    // stretches between breaks: [i0, i1] note indices
    const stretches = [];
    let i0 = 0;
    for (let i = 1; i <= secs.length; i += 1) {
        if (i === secs.length || secs[i] - secs[i - 1] >= breakSec) {
            stretches.push([i0, i - 1]);
            i0 = i;
        }
    }
    const parts = [];
    for (const [a, b] of stretches) {
        const start = secs[a];
        const end = secs[b] + 0.001;
        const local = secs.slice(a, b + 1);
        const edges = cutStretch(densityOf(local, start, end), { target, min, max });
        // each inner cut moved to the middle of the widest gap between notes within snapSec of it
        const cuts = edges.slice(1, -1).map((e) => {
            const at = start + e;
            let bestGap = -1;
            let bestAt = at;
            for (let k = 1; k < local.length; k += 1) {
                const mid = (local[k] + local[k - 1]) / 2;
                if (Math.abs(mid - at) > snapSec) continue;
                const gap = local[k] - local[k - 1];
                if (gap > bestGap + 1e-9) {
                    bestGap = gap;
                    bestAt = mid;
                }
            }
            return bestAt;
        });
        const bounds = [start, ...cuts, null];
        for (let k = 0; k + 1 < bounds.length; k += 1) {
            const lo = toMs(bounds[k]);
            const hi = bounds[k + 1] === null ? sorted[b] + 1 : toMs(bounds[k + 1]);
            if (hi > lo) parts.push({ fromMs: Math.round(lo * 100) / 100, toMs: Math.round(hi * 100) / 100 });
        }
    }
    return parts;
}

// ---- the correction ----

// The correction's terms for a raw dan (the fit's design, tools/calibrate-sections.mjs, and calibratedDan's):
// hat weights over c.knots (a piecewise-linear offset by dan), ln(TARGET_SEC / partSec) and ln(1 + supportSec / 60).
export function calibrationTerms(raw, { partSec, supportSec }, knots) {
    const r = Math.min(knots.at(-1), Math.max(knots[0], raw));
    const hats = knots.map((k, i) => {
        const lo = knots[i - 1];
        const hi = knots[i + 1];
        if (r === k) return 1;
        if (lo !== undefined && r > lo && r < k) return (r - lo) / (k - lo);
        if (hi !== undefined && r > k && r < hi) return (hi - r) / (hi - k);
        return 0;
    });
    const len = Math.max(1, finite(partSec) ?? TARGET_SEC);
    return { hats, length: Math.log(TARGET_SEC / len), support: Math.log(1 + Math.max(0, finite(supportSec) ?? 0) / 60) };
}

// A part's raw dan (the model on the part alone) → its dan as a part of this map, by the corpus fit
// (sectionCalibration.js):
//   dan = raw + offset(raw) + lengthGain · ln(TARGET_SEC / partSec) + supportGain · ln(1 + supportSec / 60)
// offset: piecewise linear between the knots' offsets (the model's own lean at each dan on parts against whole maps);
// partSec: the part's length (a short part reads easier or harder than it plays in a map); supportSec: how long the
// map plays at this part's level (its parts within SUPPORT_DANS of it, itself included) — a lone spike in a calm map
// counts for less than a hard stretch that goes on, the stamina a part alone does not have. One decimal.
export function calibratedDan(raw, { partSec, supportSec }, c = CALIBRATION) {
    const r = finite(raw);
    if (r === null) return null;
    const { hats, length, support } = calibrationTerms(r, { partSec, supportSec }, c.knots);
    const offset = hats.reduce((sum, w, i) => sum + w * c.offsets[i], 0);
    return round(Math.max(0, r + offset + c.lengthGain * length + c.supportGain * support), 1);
}

export const SUPPORT_DANS = 1;

// Per part, the seconds of the map whose parts' raw dans are at least its own − within (null for a quiet part).
export function supportSeconds(parts, within = SUPPORT_DANS) {
    return parts.map((p) => (finite(p.raw) === null
        ? null
        : round(parts.filter((q) => finite(q.raw) !== null && q.raw >= p.raw - within).reduce((sum, q) => sum + q.toSec - q.fromSec, 0), 1)));
}

// The raw parts → each with its dan (and supportSec), the hardest marked: { parts, top (index or −1) }.
export function applyCalibration(parts, c = CALIBRATION) {
    const support = supportSeconds(parts);
    const out = parts.map((p, i) => ({ ...p, supportSec: support[i], dan: calibratedDan(p.raw, { partSec: p.toSec - p.fromSec, supportSec: support[i] }, c) }));
    let top = -1;
    out.forEach((p, i) => {
        if (p.dan !== null && (top < 0 || p.dan > out[top].dan)) top = i;
    });
    return { parts: out, top };
}

// ---- the job ----

// Every part of a map rated at a rate: { v, rate, durationSec, top, parts: [{ fromSec, toSec, notes, raw, supportSec,
// dan, primary, tech }] } (seconds of play from the first note; raw and dan null for a quiet part). The dan's words
// are the renderer's, in its language.
// analyze(text, rate, { minNotes }) → the card's result shape (analyzeChart).
export async function computeSections(osuText, rate = 1, { analyze = analyzeChart } = {}) {
    const r = Number(rate) > 0 ? Number(rate) : 1;
    const times = noteTimes(osuText);
    if (!times.length) return { v: SECTIONS_VERSION, rate: r, durationSec: 0, top: -1, parts: [] };
    const first = times[0];
    const sec = (ms) => round(Math.max(0, (ms - first) / 1000 / r), 2);
    const raw = [];
    for (const { fromMs, toMs } of splitSections(times, { rate: r })) {
        const notes = times.filter((t) => t >= fromMs && t < toMs).length;
        const part = { fromSec: sec(fromMs), toSec: sec(toMs), notes, raw: null, primary: null, tech: false };
        if (notes >= MIN_PART_NOTES) {
            const result = await analyze(sectionChart(osuText, fromMs, toMs), r, { minNotes: MIN_PART_NOTES });
            if (result?.kind === "ok" && finite(result.numeric) !== null) {
                part.raw = result.numeric;
                part.primary = typeof result.primary === "string" ? result.primary : null;
                part.tech = result.tech === true;
            }
        }
        raw.push(part);
    }
    const { parts, top } = applyCalibration(raw);
    return { v: SECTIONS_VERSION, rate: r, durationSec: sec(times.at(-1)), top, parts };
}

// The worker's answer to a "sections" request: { kind: "sections", sections } | { kind: "error", message }.
export async function sectionsJob(osuText, rate) {
    try {
        return { kind: "sections", sections: await computeSections(osuText, rate) };
    } catch (error) {
        return { kind: "error", message: String(error?.message ?? error) };
    }
}
