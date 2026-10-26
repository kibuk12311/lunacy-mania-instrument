// Remapping an existing 4K rice map to another dan (mapgen v3, stream C). Only [HitObjects] changes (plus the new
// difficulty's name, BeatmapID:0 and a tag): the timing, events and every kept note line stay byte for byte.
// Easier: notes come out weakest first (off-beat and chord notes before on-beat ones), never a hold, never the last
// note of a row on the beat. Harder: chord notes go onto strong beats and new rows halfway between rows where that
// lands on the 1/2 or 1/4 grid, columns weighted by the mapper model's real continuations; neither direction makes
// a jack longer (or faster) than the original's longest. How far to go is searched like the generator's density knob:
// the knob is the share of the planned removals or additions applied, and the analysed dan decides.
import { searchRange, patternScore } from "./search.js";
import { FAMILIES, sectionFamily } from "./mapRows.js";
import { mulberry32 } from "./rng.js";
import { readMeta, setVersion, setField, addTag } from "./osuMeta.js";
import { numericToLabel } from "../core/labels.js";
import { t } from "../i18n/i18n.js";

export const REMAP_TAG = "lunacy-mania-remap";
const HEADER = /^\s*\[[^\]]+\]\s*$/;
const ROW_MERGE_MS = 2;
const SNAP_TOLERANCE_MS = 3;
const DIVS = [1, 2, 4, 3, 6, 8]; // first match wins, so a 1/2 position is never read as 2/4
const JACK_RESET_BEATS = 0.5; // a column's run ends after a gap longer than half a beat (as the generator's guard)
const SECTION_BEATS = 8; // pattern family per 8 beats, as the training data
const MAX_ADD_SHARE = 0.5; // thickening adds at most half the original's notes
const HOLD_AFTER_BEATS = 0.25; // no new note in a hold's column until a quarter beat after it ends
const MIN_EVIDENCE = 20;
const PROGRESS_EVALUATIONS = 30; // what the progress bar expects; the search's usual number of analyses
// removal: higher goes first (off-grid notes count as off-beat)
const REMOVE_WEIGHT = { 1: 0, 2: 1, 4: 2, 3: 2, 8: 3, 6: 3, 0: 2.5 };
// per note a row has beyond the one removed last: in a stream a chord is an accent that goes early, in chord
// patterns the chords are the pattern, so whole rows go before them
const CHORD_BONUS = { Stream: 0.8, Tech: 0.5, Jack: 0.5, Jumpstream: 0.2, Handstream: 0.2, Chordjack: 0.1 };
const REMOVE_JITTER = 0.75;
const SIZE_SHARE = 0.9; // a row grows only up to the size 90% of its 8 beats' rows keep to (at least 2)
// addition: higher goes first; chords on strong beats, new rows on the half beat before the quarter
const CHORD_WEIGHT = { 1: 3, 2: 2, 4: 1, 3: 1, 6: 0.5, 8: 0.5, 0: 0 };
const NEW_ROW_WEIGHT = { 1: 2, 2: 2.5, 4: 1.5 };
const ADD_JITTER = 1;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1) + ((m >> 5) & 1) + ((m >> 6) & 1) + ((m >> 7) & 1));
const columnX = (c, keys) => Math.floor(((c + 0.5) * 512) / keys);

function redLines(lines) {
    const start = lines.findIndex((l) => l.trim() === "[TimingPoints]");
    const reds = [];
    for (let i = start + 1; start >= 0 && i < lines.length && !HEADER.test(lines[i]); i += 1) {
        const p = lines[i].split(",");
        const beatMs = Number(p[1]);
        if (p.length > 1 && beatMs > 0 && (p[6] === undefined || p[6].trim() === "1")) reds.push({ time: Number(p[0]), beatMs, meter: Number(p[2]) || 4 });
    }
    reds.sort((a, b) => a.time - b.time);
    if (!reds.length) reds.push({ time: 0, beatMs: 500, meter: 4 });
    // global beat index where each red line starts, so beats keep counting across BPM changes
    reds[0].firstBeat = 0;
    for (let k = 1; k < reds.length; k += 1) reds[k].firstBeat = reds[k - 1].firstBeat + Math.round((reds[k].time - reds[k - 1].time) / reds[k - 1].beatMs);
    return reds;
}

// Where `t` sits on its red line's grid: div 1 = on the beat, 2 = half, 4, 3, 6, 8; 0 = off the grid.
export function gridOf(t, reds) {
    let k = 0;
    while (k + 1 < reds.length && reds[k + 1].time <= t + SNAP_TOLERANCE_MS) k += 1;
    const red = reds[k];
    const b = red.beatMs;
    const x = (t - red.time) / b;
    const inBeat = Math.floor(x + SNAP_TOLERANCE_MS / b);
    const frac = x - inBeat;
    for (const div of DIVS) {
        const step = Math.round(frac * div);
        if (Math.abs(frac * div - step) * (b / div) <= SNAP_TOLERANCE_MS) {
            return { div: step % div === 0 ? 1 : div, beatMs: b, beat: red.firstBeat + inBeat, red: k, exact: red.time + (inBeat + step / div) * b };
        }
    }
    return { div: 0, beatMs: b, beat: red.firstBeat + inBeat, red: k, exact: t };
}

// Hit objects → notes (each keeps its line) and rows (notes within 2 ms), each row on its red line's grid and with
// the pattern family of its 8 beats.
export function parseChart(osuText) {
    const text = String(osuText);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const keys = Math.round(Number(/^CircleSize:\s*([\d.]+)/m.exec(text)?.[1])) || 4;
    const reds = redLines(lines);
    let hitStart = lines.findIndex((l) => l.trim() === "[HitObjects]");
    if (hitStart < 0) {
        lines.push("[HitObjects]");
        hitStart = lines.length - 1;
    }
    let hitEnd = hitStart + 1;
    while (hitEnd < lines.length && !HEADER.test(lines[hitEnd])) hitEnd += 1;
    const notes = [];
    const other = [];
    for (let i = hitStart + 1; i < hitEnd; i += 1) {
        const p = lines[i].split(",");
        const time = Number(p[2]);
        if (p.length >= 5 && Number.isFinite(time)) {
            const hold = (Number(p[3]) & 128) !== 0;
            const col = Math.min(keys - 1, Math.max(0, Math.floor((Number(p[0]) * keys) / 512)));
            notes.push({ line: lines[i], t: time, col, hold, end: hold ? Number(String(p[5]).split(":")[0]) : null });
        } else {
            other.push(lines[i]);
        }
    }
    const order = notes.map((_, i) => i).sort((a, b) => notes[a].t - notes[b].t || a - b);
    const rows = [];
    for (const i of order) {
        const n = notes[i];
        const bit = 1 << n.col;
        const last = rows.at(-1);
        if (last && n.t - last.t <= ROW_MERGE_MS) {
            last.mask |= bit;
            if (n.hold) last.holdMask |= bit;
            last.notes.push(i);
        } else {
            rows.push({ t: n.t, mask: bit, holdMask: n.hold ? bit : 0, notes: [i] });
        }
    }
    for (const r of rows) Object.assign(r, gridOf(r.t, reds));
    // pattern family per 8 beats, from the rows' own shapes
    const bySection = new Map();
    for (const r of rows) {
        const key = Math.floor(r.beat / SECTION_BEATS);
        if (!bySection.has(key)) bySection.set(key, []);
        bySection.get(key).push(r);
    }
    for (const group of bySection.values()) {
        const family = sectionFamily(group, group.filter((r) => r.div === 0).length / group.length);
        const sizeCap = Math.min(keys, Math.max(2, percentile(group.map((r) => popcount(r.mask)), SIZE_SHARE)));
        for (const r of group) Object.assign(r, { family, sizeCap });
    }
    return { eol, lines, hitStart, hitEnd, other, keys, reds, notes, rows };
}

const closeTogether = (a, b) => b.t - a.t <= JACK_RESET_BEATS * b.beatMs + 1;

// Longest run of rows in a row that share a column (gaps over half a beat end a run); rows need t, mask, beatMs.
export function maxJackOf(rows) {
    let longest = 0;
    for (let c = 0; c < 8; c += 1) {
        const bit = 1 << c;
        let run = 0;
        let prev = null;
        for (const r of rows) {
            if (!r.mask) continue;
            if (r.mask & bit) {
                run = prev && (prev.mask & bit) && closeTogether(prev, r) ? run + 1 : 1;
                longest = Math.max(longest, run);
            }
            prev = r;
        }
    }
    return longest;
}

// the shortest gap between two rows in a row that share a column (Infinity when the map has no jacks)
function fastestJackMs(rows) {
    let fastest = Infinity;
    for (let i = 1; i < rows.length; i += 1) {
        if ((rows[i].mask & rows[i - 1].mask) && closeTogether(rows[i - 1], rows[i])) fastest = Math.min(fastest, rows[i].t - rows[i - 1].t);
    }
    return fastest;
}

// ---- the simulated chart the orders are built on: slots sorted by time, an empty one (mask 0) is no row ----

const prevPresent = (slots, i) => {
    for (let j = i - 1; j >= 0; j -= 1) if (slots[j].mask) return j;
    return -1;
};
const nextPresent = (slots, i) => {
    for (let j = i + 1; j < slots.length; j += 1) if (slots[j].mask) return j;
    return -1;
};

// the run of `bit` through slot i, which has it
function runThrough(slots, i, bit) {
    let run = 1;
    for (let j = i, p = prevPresent(slots, j); p >= 0 && (slots[p].mask & bit) && closeTogether(slots[p], slots[j]); j = p, p = prevPresent(slots, j)) run += 1;
    for (let j = i, n = nextPresent(slots, j); n >= 0 && (slots[n].mask & bit) && closeTogether(slots[j], slots[n]); j = n, n = nextPresent(slots, j)) run += 1;
    return run;
}

// Notes to take out, in order (indexes into chart.notes): each prefix of the list is a valid easier map.
export function removalOrder(chart, { seed = 1 } = {}) {
    const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const slots = chart.rows.map((r) => ({ ...r }));
    const longest = maxJackOf(chart.rows);
    const candidates = [];
    slots.forEach((s, i) => {
        // within a row, a random note goes first; the one left last loses its chord bonus
        const own = s.notes.filter((n) => !chart.notes[n].hold).map((n) => ({ n, r: rng() })).sort((a, b) => a.r - b.r);
        own.forEach(({ n }, j) => {
            const left = popcount(s.mask) - 1 - j;
            candidates.push({ n, slot: i, score: REMOVE_WEIGHT[s.div] + (CHORD_BONUS[s.family] ?? 0.5) * Math.max(0, left) + REMOVE_JITTER * rng() });
        });
    });
    candidates.sort((a, b) => b.score - a.score || a.n - b.n);
    const order = [];
    for (const c of candidates) {
        const s = slots[c.slot];
        const bit = 1 << chart.notes[c.n].col;
        const sameColumn = s.notes.filter((n) => chart.notes[n].col === chart.notes[c.n].col && !s.gone?.has(n)).length;
        const after = sameColumn > 1 ? s.mask : s.mask & ~bit;
        if (!after) {
            if (s.div === 1) continue; // a row on the beat keeps its last note
            const before = s.mask;
            s.mask = 0;
            const p = prevPresent(slots, c.slot);
            const shared = p >= 0 ? slots[p].mask & (slots[nextPresent(slots, c.slot)]?.mask ?? 0) : 0;
            let ok = true;
            for (let b = 0; b < chart.keys && ok; b += 1) if (shared & (1 << b)) ok = runThrough(slots, p, 1 << b) <= longest;
            if (!ok) {
                s.mask = before;
                continue;
            }
        }
        s.mask = after;
        (s.gone ??= new Set()).add(c.n);
        order.push(c.n);
    }
    return order;
}

// how the model's real maps continued from (prev, prev2) into `next`, in the row's family; without the model, any
// row will do but one that repeats a column of the last row
function maskWeight(pattern, family, prev, prev2, next) {
    const table = pattern?.[family]?.[`${prev},${prev2},${popcount(next)}`];
    if (table) {
        let total = 0;
        for (const c of Object.values(table)) total += c;
        if (total >= MIN_EVIDENCE) return (table[next] ?? 0) + 0.5;
    }
    return next & prev ? 0.3 : 1;
}

function percentile(values, q) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Notes to add, in order ({ t, col }): each prefix of the list is a valid harder map.
export function additionOrder(chart, { seed = 1, model = null } = {}) {
    const rng = mulberry32((seed ^ 0x27d4eb2f) >>> 0);
    const pick = mulberry32((seed ^ 0x165667b1) >>> 0);
    const { rows, keys, reds } = chart;
    const longest = maxJackOf(rows);
    const fastest = fastestJackMs(rows);
    const gaps = rows.slice(1).map((r, i) => r.t - rows[i].t).filter((g) => g > ROW_MERGE_MS);
    const minGap = percentile(gaps, 0.1);
    // the original rows, and an empty slot halfway between two rows where that lands on the 1/1, 1/2 or 1/4 grid
    // inside a passage (rows at most a beat apart), never quicker than the map's own quick rhythm
    const slots = [];
    rows.forEach((r, i) => {
        slots.push({ ...r, orig: true });
        const n = rows[i + 1];
        if (!n) return;
        const gap = n.t - r.t;
        if (gap > r.beatMs + 1 || gap / 2 < minGap - 1) return;
        const grid = gridOf(r.t + gap / 2, reds);
        if (!NEW_ROW_WEIGHT[grid.div] || grid.red !== r.red) return;
        const t = Math.round(grid.exact);
        if (t - r.t <= ROW_MERGE_MS || n.t - t <= ROW_MERGE_MS) return;
        slots.push({ ...grid, t, mask: 0, holdMask: 0, notes: [], family: r.family, orig: false });
    });
    const holds = chart.notes.filter((n) => n.hold);
    const insideHold = (col, s) => holds.some((h) => h.col === col && s.t >= h.t - ROW_MERGE_MS && s.t <= h.end + HOLD_AFTER_BEATS * s.beatMs);

    function canAdd(i, col) {
        const s = slots[i];
        const bit = 1 << col;
        if (s.mask & bit || insideHold(col, s)) return false;
        const before = s.mask;
        s.mask |= bit;
        let ok = runThrough(slots, i, bit) <= longest;
        for (const q of [prevPresent(slots, i), nextPresent(slots, i)]) {
            if (!ok || q < 0 || !(slots[q].mask & bit)) continue;
            const [a, b] = q < i ? [slots[q], s] : [s, slots[q]];
            if (closeTogether(a, b) && b.t - a.t < fastest - 1) ok = false;
        }
        s.mask = before;
        return ok;
    }

    const candidates = [];
    slots.forEach((s, i) => {
        if (s.orig) {
            for (let k = 0; k < s.sizeCap - popcount(s.mask); k += 1) candidates.push({ slot: i, score: CHORD_WEIGHT[s.div] - 0.5 * k + ADD_JITTER * rng() });
        } else {
            candidates.push({ slot: i, score: NEW_ROW_WEIGHT[s.div] + ADD_JITTER * rng() });
        }
    });
    candidates.sort((a, b) => b.score - a.score || a.slot - b.slot);

    const limit = Math.floor(MAX_ADD_SHARE * chart.notes.length);
    const order = [];
    for (const c of candidates) {
        if (order.length >= limit) break;
        const s = slots[c.slot];
        if (popcount(s.mask) >= (s.orig ? s.sizeCap : 1)) continue;
        const valid = [];
        for (let col = 0; col < keys; col += 1) if (canAdd(c.slot, col)) valid.push(col);
        if (!valid.length) continue;
        const p = prevPresent(slots, c.slot);
        const prev = p >= 0 ? slots[p].mask : 0;
        const p2 = p >= 0 ? prevPresent(slots, p) : -1;
        const prev2 = p2 >= 0 ? slots[p2].mask : 0;
        const weights = valid.map((col) => maskWeight(model?.pattern, s.family, prev, prev2, s.mask | (1 << col)));
        let r = pick() * weights.reduce((a, b) => a + b, 0);
        let col = valid.at(-1);
        for (let k = 0; k < valid.length; k += 1) {
            r -= weights[k];
            if (r < 0) {
                col = valid[k];
                break;
            }
        }
        s.mask |= 1 << col;
        order.push({ t: s.t, col });
    }
    return order;
}

// The chart with the first share of a plan applied: knob −1 … 0 takes out that share of the removals,
// 0 … 1 adds that share of the additions. → { osuText, removed, added }
export function applyKnob(chart, { removals = [], additions = [] }, knob) {
    const k = Math.max(-1, Math.min(1, Number(knob) || 0));
    const removed = k < 0 ? Math.round(-k * removals.length) : 0;
    const added = k > 0 ? Math.round(k * additions.length) : 0;
    const gone = new Set(removals.slice(0, removed));
    const objects = chart.notes.map((n, i) => ({ t: n.t, order: i, line: n.line })).filter((o) => !gone.has(o.order));
    additions.slice(0, added).forEach((a, j) => objects.push({ t: a.t, order: chart.notes.length + j, line: `${columnX(a.col, chart.keys)},192,${a.t},1,0,0:0:0:0:` }));
    objects.sort((a, b) => a.t - b.t || a.order - b.order);
    const lines = [...chart.lines.slice(0, chart.hitStart + 1), ...objects.map((o) => o.line), ...chart.other, ...chart.lines.slice(chart.hitEnd)];
    return { osuText: lines.join(chart.eol), removed, added };
}

// pattern-finder names → the generator's families (search.js keeps that table)
const familyOfName = (name) => FAMILIES.find((f) => patternScore([{ name, share: 1 }], [f]) > 0) ?? null;
function familyShares(top3) {
    const shares = {};
    for (const p of top3 ?? []) {
        const f = familyOfName(p.name);
        if (f) shares[f] = (shares[f] ?? 0) + (Number(p.share) || 0);
    }
    return shares;
}

// remapChart({ osuText, range: {lo, hi}, seed }, analyze(text, rate) → result, model | null, { onProgress })
// → { osuText, result, reachable, removed, added, version }
export async function remapChart({ osuText, range, seed = 1 }, analyze, model, { onProgress } = {}) {
    const chart = parseChart(osuText);
    if (!chart.rows.length) throw new Error(t("gen.remap.noRows"));
    const original = await analyze(osuText, 1);
    if (original?.kind !== "ok") throw new Error(t("gen.remap.noDan", { message: original?.message ?? original?.kind ?? "?" }));
    const { version: oldVersion } = readMeta(osuText);
    const finish = (text, result, extra) => {
        const version = `${oldVersion} (${numericToLabel(result.numeric).text} remap)`;
        return { osuText: addTag(setField(setVersion(text, version), "Metadata", "BeatmapID", "0"), REMAP_TAG), result, version, ...extra };
    };
    const { lo, hi } = range;
    if (original.numeric >= lo && original.numeric < hi) return finish(osuText, original, { reachable: true, removed: 0, added: 0 });

    // the closer the new map's pattern mix is to the original's, the better (shares by family, overlap 0…1)
    const wanted = familyShares(original.top3);
    const score = (a) => {
        const got = familyShares(a.result?.top3);
        return Object.entries(wanted).reduce((s, [f, share]) => s + Math.min(share, got[f] ?? 0), 0);
    };
    const thinner = original.numeric >= hi;
    const plans = new Map();
    const planFor = (s) => {
        if (!plans.has(s)) plans.set(s, thinner ? { removals: removalOrder(chart, { seed: s }) } : { additions: additionOrder(chart, { seed: s, model }) });
        return plans.get(s);
    };
    let count = 0;
    const evaluate = async (knob, s) => {
        const built = applyKnob(chart, planFor(s), knob);
        const result = await analyze(built.osuText, 1);
        count += 1;
        onProgress?.({ phase: "search", i: count, n: Math.max(count, PROGRESS_EVALUATIONS) });
        return { built, result, numeric: result?.kind === "ok" ? result.numeric : (thinner ? -Infinity : Infinity) };
    };
    const { best, inRange } = await searchRange({ evaluate, lo, hi, min: thinner ? -1 : 0, max: thinner ? 0 : 1, seed, score });
    if (best?.result?.kind !== "ok") throw new Error(t("gen.remap.noDan", { message: best?.result?.message ?? best?.result?.kind ?? "?" }));
    return finish(best.built.osuText, best.result, { reachable: inRange, removed: best.built.removed, added: best.built.added });
}
