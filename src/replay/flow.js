// How a play went along the map: the timing from start to end, keys pressed against notes written, presses that met no note,
// combo breaks with their place and the pattern under them, and the parts of the map and the pattern families one by one.
// Each answer is null or empty when the play gives no data for it; nothing here is a made-up zero. Pure.
import { resultsAccuracy } from "./judge.js";
import { spread, unstableRate } from "./analyze.js";
import { manipByPart } from "./manip.js";

export const DRIFT = Object.freeze({ slices: 8, minHits: 40, minSec: 30, sliceMinHits: 5, thirdMinHits: 12 });
// Fallen behind: over smoothSec, at least minKeys a second fewer pressed than written and under behindShare of them.
// Spam: at least minKeys more and over spamShare. A stretch counts from minSec. Holds' ends need no press, so only heads count.
export const PACE = Object.freeze({ smoothSec: 3, minKeys: 2, behindShare: 0.8, spamShare: 1.25, minSec: 2 });
export const IDLE_GAP_MS = 500; // a press further than this from any note was idle tapping, not a slip inside the pattern
const SHAPE_GAP_MS = 200; // notes this close in real ms make a pattern together; further apart they stand alone
const SHAPE_ROWS = 3; // rows looked at on each side of the note
export const HARDEST = 3;

const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const accuracyIn = (list) => (list.length ? resultsAccuracy(list) : null);
const groupUr = (list, min = 2) => {
    const deltas = list.filter((r) => r.delta !== null).map((r) => r.delta);
    return deltas.length >= min ? unstableRate(deltas) : null;
};
const meanOf = (list) => round1(spread(list.filter((r) => r.delta !== null).map((r) => r.delta)).mean);

// The hit errors along the play: { slices: [{ fromMs, toMs, hits, mean, ur }], slopeMsPerMin, first, last, urChange,
// meanChange, accuracyChange } or null when the play is too short to say. slopeMsPerMin: the straight line through all
// the errors, + the presses getting later. first / last: the first and last third { mean, ur, accuracy, hits }.
export function timingDrift(results, { fromMs, toMs, rate = 1 }, limits = DRIFT) {
    const hits = results.filter((r) => r.delta !== null);
    if (hits.length < limits.minHits || (toMs - fromMs) / rate / 1000 < limits.minSec) return null;
    const span = toMs - fromMs;
    const slices = Array.from({ length: limits.slices }, (_, i) => {
        const a = fromMs + (span * i) / limits.slices;
        const b = fromMs + (span * (i + 1)) / limits.slices;
        const list = hits.filter((r) => r.t >= a && (r.t < b || i === limits.slices - 1));
        const enough = list.length >= limits.sliceMinHits;
        return { fromMs: a, toMs: b, hits: list.length, mean: enough ? meanOf(list) : null, ur: enough ? groupUr(list) : null };
    });
    const minutes = hits.map((r) => (r.t - fromMs) / rate / 60000);
    const mx = minutes.reduce((a, b) => a + b, 0) / hits.length;
    const my = hits.reduce((a, r) => a + r.delta, 0) / hits.length;
    let top = 0;
    let bottom = 0;
    hits.forEach((r, i) => {
        top += (minutes[i] - mx) * (r.delta - my);
        bottom += (minutes[i] - mx) ** 2;
    });
    const third = (list) => {
        const count = list.filter((r) => r.delta !== null).length;
        return count >= limits.thirdMinHits ? { mean: meanOf(list), ur: groupUr(list), accuracy: accuracyIn(list), hits: count } : null;
    };
    const first = third(results.filter((r) => r.t < fromMs + span / 3));
    const last = third(results.filter((r) => r.t >= toMs - span / 3));
    const both = first && last;
    return {
        slices, slopeMsPerMin: bottom > 0 ? round1(top / bottom) : null, first, last,
        meanChange: both ? round1(last.mean - first.mean) : null, urChange: both ? round1(last.ur - first.ur) : null,
        accuracyChange: both ? Math.round((last.accuracy - first.accuracy) * 100) / 100 : null,
    };
}

// Keys pressed against notes written, a value per second of play from fromMs: { written, played, peakWritten, peakPlayed,
// stretches: [{ kind: "behind" | "spam", fromSec, toSec, written, played }] }, null for a play under two seconds.
// heads: the notes' times (ms of the map), presses: per column; both only up to where the play got.
export function paceLine({ heads, presses, fromMs, toMs, rate = 1 }, limits = PACE) {
    const seconds = Math.ceil((toMs - fromMs) / rate / 1000);
    if (seconds < 2) return null;
    const count = (times) => {
        const out = new Array(seconds).fill(0);
        for (const t of times) {
            const s = Math.floor((t - fromMs) / rate / 1000);
            if (s >= 0 && s < seconds) out[s] += 1;
        }
        return out;
    };
    const written = count(heads);
    const played = count(presses.flat().map((p) => p.t));
    const reach = (limits.smoothSec - 1) / 2;
    const smooth = (list) => list.map((_, i) => {
        const part = list.slice(Math.max(0, i - reach), i + reach + 1);
        return part.reduce((a, b) => a + b, 0) / part.length;
    });
    const w = smooth(written);
    const p = smooth(played);
    const kindAt = (i) => {
        if (w[i] - p[i] >= limits.minKeys && p[i] <= w[i] * limits.behindShare) return "behind";
        if (p[i] - w[i] >= limits.minKeys && p[i] >= w[i] * limits.spamShare) return "spam";
        return null;
    };
    const stretches = [];
    for (let i = 0; i < seconds;) {
        const kind = kindAt(i);
        let end = i + 1;
        while (end < seconds && kindAt(end) === kind) end += 1;
        if (kind && end - i >= limits.minSec) {
            const mean = (list) => round1(list.slice(i, end).reduce((a, b) => a + b, 0) / (end - i));
            stretches.push({ kind, fromSec: i, toSec: end, written: mean(written), played: mean(played) });
        }
        i = end;
    }
    return { written, played, peakWritten: Math.max(...written), peakPlayed: Math.max(...played), stretches };
}

// What pattern the note `i` of results (sorted by t, played columns) sits in, seen from a few rows around it.
// → "hold", "chordjack", "jack", "quad", "hand", "jump", "trill", "roll", "stream" or "single".
export function shapeAt(results, i, rate = 1) {
    const note = results[i];
    if (note.end !== null) return "hold";
    const rows = new Map();
    for (const r of results.slice(Math.max(0, i - 16), i + 17)) {
        if (!rows.has(r.t)) rows.set(r.t, []);
        rows.get(r.t).push(r.col);
    }
    const times = [...rows.keys()].sort((a, b) => a - b);
    const at = times.indexOf(note.t);
    const near = (j) => j >= 0 && j < times.length && Math.abs(times[j] - note.t) / rate <= SHAPE_GAP_MS * Math.max(1, Math.abs(j - at));
    const size = rows.get(note.t).length;
    const sameColumn = (j) => near(j) && rows.get(times[j]).includes(note.col);
    if (sameColumn(at - 1) || sameColumn(at + 1)) return size > 1 ? "chordjack" : "jack";
    if (size >= 4) return "quad";
    if (size === 3) return "hand";
    if (size === 2) return "jump";
    const line = [];
    for (let j = at - SHAPE_ROWS; j <= at + SHAPE_ROWS; j += 1) if (near(j) && rows.get(times[j]).length === 1) line.push(rows.get(times[j])[0]);
    if (line.length < 3) return "single";
    if (new Set(line).size === 2 && line.every((c, k) => k === 0 || c !== line[k - 1])) return "trill";
    const steps = line.slice(1).map((c, k) => Math.sign(c - line[k]));
    return steps.every((s) => s === steps[0]) ? "roll" : "stream";
}

// The combo breaks with their place: [{ t, col, combo, cause, shape, part }]. cause: "early" (pressed too soon), "released"
// (a hold let go), "off" (pressed or let go in time but too far from the note: an Interlude ruleset breaks the combo on
// more than a miss; osu! never gives it, a pressed note there is not a break), "none" (no press in time). part: index
// into parts, null outside them.
export function comboBreaks(analysis) {
    const { results, rate, parts = [] } = analysis;
    const index = new Map(results.map((r, i) => [`${r.t}:${r.col}`, i]));
    return analysis.combo.breaks.map((b) => {
        const i = index.get(`${b.t}:${b.col}`);
        const r = results[i];
        // an osu! result has no `dropped`: its pressed holds that break were let go. An Interlude one's tells whether the key
        // went up before the end; a hold pressed after its window and held to the end was not let go, it is "off".
        const released = r && r.end !== null && r.press !== null && r.dropped !== false;
        const cause = r?.early ? "early" : released ? "released" : r && r.press !== null ? "off" : "none";
        const when = b.at ?? b.t; // an Interlude hold broken after its head: where that was
        const part = parts.findIndex((p) => when >= p.fromMs && when < p.toMs);
        return { ...b, cause, shape: i === undefined ? null : shapeAt(results, i, rate), part: part < 0 ? null : part };
    });
}

// The presses that met no note: { total, idle, inFlow, byColumn, bins } (idle: nowhere near a note), null with none.
// bins: how many fall in each of `bins` stretches of [fromMs, toMs].
export function ghostReport({ ghosts, results, rate = 1, fromMs, toMs, bins = 60 }, keys = 4) {
    if (!ghosts.length) return null;
    const times = results.map((r) => r.t);
    const byColumn = new Array(keys).fill(0);
    const row = new Array(bins).fill(0);
    const span = Math.max(1, toMs - fromMs);
    let idle = 0;
    let at = 0;
    for (const g of ghosts) {
        while (at + 1 < times.length && times[at + 1] <= g.t) at += 1;
        const gap = Math.min(Math.abs(g.t - (times[at] ?? Infinity)), Math.abs((times[at + 1] ?? Infinity) - g.t));
        if (gap / rate > IDLE_GAP_MS) idle += 1;
        byColumn[g.col] = (byColumn[g.col] ?? 0) + 1;
        row[Math.min(bins - 1, Math.max(0, Math.floor(((g.t - fromMs) / span) * bins)))] += 1;
    }
    return { total: ghosts.length, idle, inFlow: ghosts.length - idle, byColumn, bins: row };
}

// The parts of the map with how each went: parts reached only, in order, with their index among all the parts.
// dans: the parts' dans (null until they are worked out). → [{ index, fromMs, toMs, notes, nps, accuracy, misses, ur, mean,
// ghosts, dan, ...manip tally (pairs, glued, percent, squeezed) }].
export function partReport({ analysis, pairs, dans = null }) {
    const { results, ghosts, rate, parts = [] } = analysis;
    const manip = manipByPart(pairs, parts);
    return parts.map((part, index) => {
        const own = results.filter((r) => r.t >= part.fromMs && r.t < part.toMs);
        const seconds = (part.toMs - part.fromMs) / rate / 1000;
        return {
            ...manip[index], index, notes: own.length, nps: seconds > 0 ? round1(own.length / seconds) : null, accuracy: accuracyIn(own),
            misses: own.filter((r) => r.kind === "miss").length, ur: groupUr(own, 10), mean: own.length >= 10 ? meanOf(own) : null,
            ghosts: ghosts.filter((g) => g.t >= part.fromMs && g.t < part.toMs).length, dan: dans?.[index] ?? null,
        };
    }).filter((part) => part.notes > 0);
}

// The hardest parts and how they went against the rest: by dan when the parts have dans, else by density.
// → { basis: "dan" | "nps", parts: [part + { versusRest: accuracy against the other parts' }] }, null with under two parts.
export function hardestParts(parts, count = HARDEST) {
    if (parts.length < 2) return null;
    const rated = parts.filter((p) => p.dan !== null);
    const basis = rated.length >= 2 ? "dan" : "nps";
    const ranked = [...(basis === "dan" ? rated : parts)].sort((a, b) => (basis === "dan" ? b.dan - a.dan : b.nps - a.nps)).slice(0, Math.min(count, parts.length - 1));
    const notes = parts.reduce((sum, p) => sum + p.notes, 0);
    const weighted = parts.reduce((sum, p) => sum + (p.accuracy ?? 0) * p.notes, 0);
    return {
        basis,
        parts: ranked.map((p) => {
            const rest = notes - p.notes;
            const others = rest > 0 ? (weighted - (p.accuracy ?? 0) * p.notes) / rest : null;
            return { ...p, versusRest: others === null || p.accuracy === null ? null : Math.round((p.accuracy - others) * 100) / 100 };
        }),
    };
}

// The notes and manip of each pattern family: familyAt(ms of the map) → family id or null.
// → [{ family, notes, accuracy, misses, ur, pairs, glued, percent, squeezed }], the most notes first.
export function familyReport(results, tallyPairs, familyAt) {
    const groups = new Map();
    for (const r of results) {
        const family = familyAt(r.t);
        if (!family) continue;
        if (!groups.has(family)) groups.set(family, []);
        groups.get(family).push(r);
    }
    const manip = new Map(tallyPairs.map((f) => [f.family, f]));
    return [...groups].map(([family, list]) => ({
        pairs: 0, glued: 0, percent: null, squeezed: null, ...manip.get(family),
        family, notes: list.length, accuracy: accuracyIn(list), misses: list.filter((r) => r.kind === "miss").length, ur: groupUr(list, 10),
    })).sort((a, b) => b.notes - a.notes);
}
