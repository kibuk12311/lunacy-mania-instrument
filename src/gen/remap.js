// Remapping an existing 4K rice map to another dan (mapgen v3, stream C). Only [HitObjects] changes (plus the new
// difficulty's name, BeatmapID:0 and a tag): the timing, events and every kept note line stay byte for byte.
// Easier: notes come out weakest first (off-beat and chord notes before on-beat ones), never a hold, never the last
// note of a row on the beat. Harder: chord notes go onto strong beats and new rows halfway between rows where that
// lands on the 1/2 or 1/4 grid, columns weighted by the mapper model's real continuations. Neither direction makes a
// minijack or an anchor the original did not have (freshPatterns: two rows in a row sharing a column, a column on
// every other row five times, 12 rows the analyzer reads as an Anchor; and remapChart checks each map whole for rows
// the analyzer marks Anchor or Minijacks where it marked none), easier by bringing rows together or moving notes no
// more than harder by adding them; with allowJacks (the remap panel's «Можно миниджеки и анкоры») they may come, but
// only where every change that makes none misses the range: then after all of those, harder's keeping the original's
// share of rows in a jack first, the shortest run of them that reaches the range, and never a jack longer (or faster)
// than the original's longest. The original's own jacks and anchors stay (thinned, maybe). So harder on a map without
// trills no longer gives 0.10.3's map byte for byte.
// How far to go is searched like the generator's density knob:
// the knob is the share of the planned removals or additions applied, and the analysed dan decides.
// Trills of every kind (flavours.js Trills, Minitrills, Jumptrill, SplitTrill, ChordTrills, Rolls) change only as
// whole alternations: easier halves their rhythm (1/4 → 1/2 → 1/1, the rows on the beat staying) and then takes chords
// down to single notes, at the rate the rest of the map thins, moving a kept note to the column the alternation needs
// where halving would repeat one;
// harder doubles a single-note trill into a jumptrill or split trill, four rows at a time (more where stopping there
// would read as an anchor: a jumptrill going on as a trill of single notes), and puts no new row
// inside one; neither repeats a column within a beat inside a trill. Of the layouts in range, the one that kept the
// most trill rows wins (a trill of chords that became one of single notes counting half); a range out of reach that
// way is searched once more with trills treated like any other notes, taken if it gets into the range or at least half
// a dan closer, or, nearer than that either way, if it kept the original's pattern mix better.
import { searchRange, patternScore } from "./search.js";
import { FAMILIES, sectionFamily, parseRows } from "./mapRows.js";
import { flavourMarks } from "./flavourMetrics.js";
import { mulberry32 } from "./rng.js";
import { readMeta, setVersion, setField, addTag } from "./osuMeta.js";
import { numericToLabel } from "../core/labels.js";
import { t } from "../i18n/i18n.js";

export const REMAP_TAG = "lunacy-mania-remap";
export const TRILL_KINDS = ["Trills", "Minitrills", "Jumptrill", "SplitTrill", "ChordTrills", "Rolls"];
const HEADER = /^\s*\[[^\]]+\]\s*$/;
const ROW_MERGE_MS = 2;
const SNAP_TOLERANCE_MS = 3;
const DIVS = [1, 2, 4, 3, 6, 8]; // first match wins, so a 1/2 position is never read as 2/4
const JACK_RESET_BEATS = 0.5; // a column's run ends after a gap longer than half a beat (as the generator's guard)
// …and a few ms: osu! times are whole ms and mappers' drift (two rows each up to SNAP_TOLERANCE_MS off the grid), so a
// 1/2 gap often comes out 1-2 ms over half a beat (Amen Iraq: 149 ms, half a beat 147.8)
const JACK_SLACK_MS = 2 * SNAP_TOLERANCE_MS;
const SECTION_BEATS = 8; // pattern family per 8 beats, as the training data
const MAX_ADD_SHARE = 0.5; // thickening adds at most half the original's notes
const HOLD_AFTER_BEATS = 0.25; // no new note in a hold's column until a quarter beat after it ends
const MIN_EVIDENCE = 20;
const PROGRESS_EVALUATIONS = 30; // what the progress bar expects; the search's usual number of analyses
const RETRY_SEED = 104729; // a search that missed the range tries once more from this far along the seeds
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
// trills: one is thinned per stretch of one rhythm (row spacing within 15% of the stretch's first), and a step that
// fails stops only its phrase of 16 rows; easier thins the trills and the rest of the map at the same rate (the share
// of their notes taken out), so the map's mix of patterns stays; a trill step that thickens one scores this much below
// a plain note at the same place, and a single-note change inside a trill comes only after everything else
const RHYTHM_SPREAD = 0.15;
const PHRASE_ROWS = 16;
const MAX_HALVINGS = 3;
const UPGRADE_ROWS = 4; // a trill made a jumptrill or split trill four rows at a time
const BEAT_SLACK = 1.05; // a thinned trill's rows may end up this much over a beat apart (a rhythm that drifts a little)
const TRILL_PROTECT = 1.5;
const TRILL_REPEAT_BEATS = 1; // inside a trill no column comes twice within a beat that did not in the original
const LAST_RESORT = -10;
const NO_TRILLS = (n) => ({ runOf: new Int32Array(n).fill(-1), runs: [], segments: [] });
const TRILL_SCORE_W = 0.5; // of the layouts in range: + this × the share of the original's trill rows still trills
const CHORD_TRILLS = ["Jumptrill", "SplitTrill", "ChordTrills"];
const OTHER_SHAPE = 0.5; // of the layouts in range: a trill of chords that is one of single notes now keeps this much
const DAN_STEP = 0.1; // the analyzer's dan is rounded to this
// a range missed while the trills stay trills: the plan that breaks them if this much closer, or nearer than that if it
// kept the original's pattern mix better
const PLAIN_MARGIN = 0.5;
// of the layouts in range past the clean changes: − this × the notes that made a jack or anchor, per note of the original
const JACK_SCORE_W = 2;
const SHORTEST_STEPS = 10; // the shortest prefix of the jack-making changes that reaches the range: bisected this often
const SHORTEST_MIX = 0.5; // …of the layouts whose pattern mix is at most this much below the best one in range
const MAX_SKIPS = 8; // the clean stage leaves out at most this many changes of a plan that the whole-map check turns down
const ANALYZER_MARKS = ["Anchor", "Minijacks"]; // the analyzer's own (flavourMetrics.js) that the clean changes never add
// minijacks and anchors the original did not have (allowJacks false: none; true: only after everything else). A jack:
// two rows in a row sharing a column within half a beat (the remap's own), or the same jump twice with no gap between
// that breaks the analyzer's motifs (flavourMetrics.js Minijacks), or the original's own such jump twice whose next row
// no longer shares a column with it (its [01] [01] [02] made [01] [01] [2]: a Minijacks it did not have). An anchor:
// one column on every other row, at least five times (players do not call a x a y a one), whatever the rows between
// have, unless it is a trill (two rows of as many notes taking turns), longer than every such run of that column the
// original had there (its own anchors and trills) and than any one chain of that column's hits on rows at most two
// apart that holds the whole run (its own jack or chordjack, thinned to every other row; not where a new row went in
// between, as harder splitting its jumpjack). Two short runs joined, or one carried past the chain it was in, are new.
// And the analyzer's own Anchor (flavourMetrics.js: 12 rows, three jumps, one column on 45% of them) on a row where
// the original's had none: never without allowJacks, near a change or, its motif break moving with the whole map's
// rhythm, anywhere (remapChart checks every map it builds).
// The analyzer's motif break, as flavourMetrics.js chains: 2.6 × the map's median row step, at least 250 ms.
const ANCHOR_MIN = 5;
const ANCHOR_ROWS = 12; // flavourMetrics.js Anchor's window
const EASIER_STRETCH = 2; // easier's rows up to twice as far apart (1/4 → 1/2): the analyzer's motif break with them
const CHAIN_GAP_MS = 250;
const CHAIN_GAP_STEPS = 2.6;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1) + ((m >> 5) & 1) + ((m >> 6) & 1) + ((m >> 7) & 1));
const lowCol = (m) => 31 - Math.clz32(m & -m);
const columnX = (c, keys) => Math.floor(((c + 0.5) * 512) / keys);
const colsOf = (m, keys) => {
    const out = [];
    for (let c = 0; c < keys; c += 1) if (m & (1 << c)) out.push(c);
    return out;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// the lowest `n` columns of mask m
const lowestCols = (m, n) => {
    let out = 0;
    for (let c = 0; c < 8 && popcount(out) < n; c += 1) if (m & (1 << c)) out |= 1 << c;
    return out;
};

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

const closeTogether = (a, b) => b.t - a.t <= JACK_RESET_BEATS * b.beatMs + JACK_SLACK_MS;

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

// Which rows (sorted by time, with t, mask, beatMs) are in a trill: those a trill kind marks, and every row of a plain
// two-column trill (a b a b …, rows at most a beat apart), which the detector names only where its fifth note differs.
function trillMarks(rows) {
    const out = new Uint8Array(rows.length);
    const { marks } = flavourMarks(rows, TRILL_KINDS);
    rows.forEach((_, i) => {
        if (TRILL_KINDS.some((k) => marks[k][i])) out[i] = 1;
    });
    for (let i = 0; i + 3 < rows.length; i += 1) {
        const [a, b] = [rows[i].mask, rows[i + 1].mask];
        if (popcount(a) !== 1 || popcount(b) !== 1 || a === b || rows[i + 2].mask !== a || rows[i + 3].mask !== b) continue;
        let close = true;
        for (let k = i + 1; k <= i + 3; k += 1) if (rows[k].t - rows[k - 1].t > rows[k].beatMs + 1) close = false;
        if (close) out.fill(1, i, i + 4);
    }
    return out;
}

// The original's trill runs: maximal stretches of rows (indexes into chart.rows) in a trill (trillMarks), each cut into
// stretches of one rhythm. → { runOf: run index per row or −1, runs: [{ from, to }], segments: [{ from, to, run }] }
export function trillRuns(chart) {
    const n = chart.rows.length;
    const runOf = new Int32Array(n).fill(-1);
    const runs = [];
    const segments = [];
    if (chart.keys !== 4 || !n) return { runOf, runs, segments };
    const inTrill = trillMarks(chart.rows);
    const marked = (i) => inTrill[i] === 1;
    const gap = (i) => chart.rows[i].t - chart.rows[i - 1].t;
    for (let i = 0; i < n;) {
        if (!marked(i)) {
            i += 1;
            continue;
        }
        let j = i;
        while (j < n && marked(j)) j += 1;
        const run = runs.length;
        runs.push({ from: i, to: j });
        runOf.fill(run, i, j);
        let from = i;
        for (let x = i + 2; x < j; x += 1) {
            const ref = gap(from + 1);
            if (Math.abs(gap(x) - ref) > RHYTHM_SPREAD * ref + ROW_MERGE_MS) {
                segments.push({ from, to: x, run });
                from = x;
                x += 1; // the next stretch's spacing is its own first gap
            }
        }
        segments.push({ from, to: j, run });
        i = j;
    }
    return { runOf, runs, segments };
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

// Is there a jack between two rows in a row around slots a…b (at most `beats` apart) that the original did not have
// (the same two rows, next to each other, sharing those columns)? origMask: each slot's original mask (0: no row).
function newJackAround(slots, a, b, origMask, beats = JACK_RESET_BEATS) {
    const p0 = prevPresent(slots, a);
    const n0 = nextPresent(slots, b);
    let p = -1;
    for (let i = p0 < 0 ? a : p0; i <= (n0 < 0 ? b : n0); i += 1) {
        if (!slots[i].mask) continue;
        const shared = p >= 0 ? slots[p].mask & slots[i].mask : 0;
        if (shared && slots[i].t - slots[p].t <= beats * slots[i].beatMs + JACK_SLACK_MS) {
            let adjacent = true;
            for (let j = p + 1; j < i && adjacent; j += 1) if (origMask[j]) adjacent = false;
            if (!adjacent || (shared & ~(origMask[p] & origMask[i]))) return true;
        }
        p = i;
    }
    return false;
}

// ---- minijacks and anchors the original did not have ----

// the analyzer's motif break (flavourMetrics.js chains) for rows sorted by time
function chainMsOf(rows) {
    const gaps = rows.slice(1).map((r, i) => r.t - rows[i].t).sort((a, b) => a - b);
    return Math.max(CHAIN_GAP_MS, CHAIN_GAP_STEPS * (gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0));
}

// rows a (earlier) and b, next to each other, with masks ma and mb: a jack?
const jackOf = (ma, mb, a, b, chainMs) => (ma & mb) !== 0
    && (b.t - a.t <= JACK_RESET_BEATS * b.beatMs + JACK_SLACK_MS || (ma === mb && popcount(ma) === 2 && b.t - a.t <= chainMs));

// What the jack and anchor rules need of the original: per column its chains of hits (rows at most two apart, no
// motif break between) and its runs on every other row (the row between without it, no motif break), each as
// { t0, t1, hits } sorted by time, and the times of its rows flavourMetrics.js marks Anchor.
// motifMs: the motif break the built map's rules use, `stretch` × the original's (easier spreads the rows out, and the
// analyzer's break grows with them) unless given. The original's chains and runs are measured with that break too, so
// a stretch the remap did not touch reads the same in both.
function patternRules(rows, keys, { stretch = 1, motifMs = null } = {}) {
    const chainMs = chainMsOf(rows);
    const breakMs = motifMs ?? stretch * chainMs;
    const chains = [];
    for (let c = 0; c < keys; c += 1) {
        const bit = 1 << c;
        const list = [];
        let last = -1;
        rows.forEach((r, i) => {
            if (!(r.mask & bit)) return;
            let joined = last >= 0 && i - last <= 2;
            for (let k = last + 1; joined && k <= i; k += 1) if (rows[k].t - rows[k - 1].t > breakMs) joined = false;
            if (joined) {
                list.at(-1).t1 = r.t;
                list.at(-1).hits += 1;
            } else {
                list.push({ t0: r.t, t1: r.t, hits: 1 });
            }
            last = i;
        });
        chains.push(list);
    }
    const present = rows.filter((r) => r.mask);
    const runs = [];
    for (let c = 0; c < keys; c += 1) {
        const bit = 1 << c;
        const list = [];
        const runAt = new Map();
        present.forEach((r, i) => {
            if (!(r.mask & bit)) return;
            const [one, two] = [present[i - 1], present[i - 2]];
            const goesOn = two && (two.mask & bit) && !(one.mask & bit) && r.t - one.t <= breakMs && one.t - two.t <= breakMs;
            const run = goesOn ? runAt.get(i - 2) : { t0: r.t, t1: r.t, hits: 0 };
            if (!goesOn) list.push(run);
            run.t1 = r.t;
            run.hits += 1;
            runAt.set(i, run);
        });
        runs.push(list);
    }
    const { marks } = flavourMarks(rows, ["Anchor"]);
    const anchored = new Set(rows.filter((_, i) => marks.Anchor[i]).map((r) => r.t));
    return { chainMs, motifMs: breakMs, chains, runs, keys, anchored };
}

// the most hits of one of `list` (sorted, apart in time) over [t0, t1]: any that overlaps it, or (whole) one that
// holds all of it
function hitsThere(list = [], t0, t1, whole = false) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (list[m].t1 < t0 - ROW_MERGE_MS) lo = m + 1;
        else hi = m;
    }
    let most = 0;
    for (let k = lo; k < list.length && list[k].t0 <= t1 + ROW_MERGE_MS; k += 1) {
        if (!whole || (list[k].t0 <= t0 + ROW_MERGE_MS && list[k].t1 >= t1 - ROW_MERGE_MS)) most = Math.max(most, list[k].hits);
    }
    return most;
}

// Present slots p < i with no present slot between: a jack the original did not have? Its own jack (thinned, maybe)
// is one whose columns every original row from p to i has, each two of those rows in a row a jack.
function freshJack(slots, p, i, origMask, { chainMs, motifMs }) {
    if (!jackOf(slots[p].mask, slots[i].mask, slots[p], slots[i], motifMs)) return false;
    const shared = slots[p].mask & slots[i].mask;
    if (!origMask[p] || !origMask[i]) return true;
    let prev = -1;
    for (let k = p; k <= i; k += 1) {
        if (!origMask[k]) continue;
        if ((origMask[k] & shared) !== shared) return true;
        if (prev >= 0 && !jackOf(origMask[prev], origMask[k], slots[prev], slots[k], chainMs)) return true;
        prev = k;
    }
    return false;
}

// Present slots p < i < n, none between: the same jump twice, then a row without a jack that the row after does not
// repeat (flavourMetrics.js Minijacks), where the original did not have its jump twice (thinned, maybe) and then such a
// row?
function freshMinijack(slots, p, i, n, origMask, { motifMs }) {
    const jump = slots[p].mask;
    if (popcount(jump) !== 2 || slots[i].mask !== jump || (slots[n].mask & jump)) return false;
    if (slots[i].t - slots[p].t > motifMs || slots[n].t - slots[i].t > motifMs) return false;
    const n2 = nextPresent(slots, n);
    if (n2 >= 0 && slots[n2].mask === slots[n].mask && slots[n2].t - slots[n].t <= motifMs) return false;
    if (origMask[p] !== jump || origMask[i] !== jump) return true;
    for (let k = p + 1; k < i; k += 1) if (origMask[k] && origMask[k] !== jump) return true;
    let q = i + 1;
    while (q < slots.length && !origMask[q]) q += 1;
    if (q >= slots.length || (origMask[q] & jump)) return true;
    let q2 = q + 1;
    while (q2 < slots.length && !origMask[q2]) q2 += 1;
    return q2 < slots.length && origMask[q2] === origMask[q];
}

// a jack the original did not have between two rows in a row (or a jump twice and the rows after) around slots a…b
function freshJackAround(slots, a, b, origMask, rules) {
    let from = a;
    for (let k = 0, j = a; k < 3 && (j = prevPresent(slots, j)) >= 0; k += 1) from = j;
    let to = b;
    for (let k = 0, j = b; k < 2 && (j = nextPresent(slots, j)) >= 0; k += 1) to = j;
    let [pp, p] = [-1, -1];
    for (let i = from; i <= to; i += 1) {
        if (!slots[i].mask) continue;
        if (p >= 0 && freshJack(slots, p, i, origMask, rules)) return true;
        if (pp >= 0 && freshMinijack(slots, pp, p, i, origMask, rules)) return true;
        [pp, p] = [p, i];
    }
    return false;
}

// The run of `bit` on every other row through present slot j (which has it): its hits two rows apart, each row between
// without it, whatever else the rows between have (flavourMetrics.js Anchor looks at no more than that: jumps between
// that share a column, [01] 2 [01] [23] [01] [23] [01], are its jumpstream anchor). None in a trill, where every
// column comes as often: two rows of as many notes taking turns (a x a x, [01] [23] [01] [23]), also one thickened part
// of the way ([01] [23] [01] [23] 0 3 0 3). A x a y a is one (RunningMan), [01] 2 [01] 2 [01] too (the analyzer's
// Anchor: its column comes 1.5× as often as the others). Rows further apart than the built map's motif break (motifMs:
// easier spreads them out) end it. → { hits, from, to, trill }
function everyOtherRun(slots, j, bit, { motifMs }) {
    const side = (step) => {
        let hits = 0;
        let end = j;
        for (let k = j; ;) {
            const one = step(slots, k);
            if (one < 0 || (slots[one].mask & bit) || Math.abs(slots[k].t - slots[one].t) > motifMs) break;
            const two = step(slots, one);
            if (two < 0 || !(slots[two].mask & bit) || Math.abs(slots[one].t - slots[two].t) > motifMs) break;
            hits += 1;
            end = two;
            k = two;
        }
        return { hits, end };
    };
    const [back, ahead] = [side(prevPresent), side(nextPresent)];
    const run = { hits: back.hits + ahead.hits + 1, from: back.end, to: ahead.end, trill: false };
    if (run.hits < 2) return run;
    // a trill: rows in a row share no column, each row is the one two back or that with a note more or less, and two
    // rows in a row have as many notes but where a trill thickened part of the way goes on thin (at most one such
    // place in UPGRADE_ROWS rows)
    const seq = [];
    for (let k = run.from; k <= run.to; k += 1) if (slots[k].mask) seq.push(slots[k].mask);
    const nested = (x, y) => (x & y) === x || (x & y) === y;
    let edge = -UPGRADE_ROWS;
    for (let k = 0; k + 1 < seq.length; k += 1) {
        const [x, y] = [seq[k], seq[k + 1]];
        if (x & y || (k >= 1 && !nested(seq[k - 1], y))) return run;
        if (popcount(x) === popcount(y)) continue;
        const thickened = (k >= 1 && seq[k - 1] !== y) || (k + 2 < seq.length && seq[k + 2] !== x);
        if (!thickened || k - edge < UPGRADE_ROWS) return run;
        edge = k;
    }
    run.trill = true;
    return run;
}

// a run of column c on every other row (everyOtherRun) the original did not have: longer than its runs there and, but
// where a row the original did not have went in (harder splitting its jumpjack with new rows), than any one of its
// chains that holds it (its own jack thinned). origMask: each slot's original mask (0: no row).
function freshAnchor(slots, run, c, rules, origMask) {
    if (run.hits < ANCHOR_MIN) return false;
    const [t0, t1] = [slots[run.from].t, slots[run.to].t];
    if (run.hits <= hitsThere(rules.runs[c], t0, t1)) return false;
    for (let k = run.from; k <= run.to; k += 1) if (slots[k].mask && !origMask[k]) return true;
    return run.hits > hitsThere(rules.chains[c], t0, t1, true);
}

// flavourMetrics.js Anchor on 12 rows in a row (their masks): no jack, at most two notes a row, at least three jumps,
// one column on 45% of the rows or more and 1.5× as often as the others on average
function analyzerAnchor(m, keys) {
    const cols = new Array(keys).fill(0);
    let jumps = 0;
    for (let k = 0; k < m.length; k += 1) {
        if (k && m[k] & m[k - 1]) return false;
        const n = popcount(m[k]);
        if (n > 2) return false;
        if (n === 2) jumps += 1;
        for (let c = 0; c < keys; c += 1) if (m[k] & (1 << c)) cols[c] += 1;
    }
    if (jumps < 3) return false;
    const top = Math.max(...cols);
    const rest = (cols.reduce((x, y) => x + y, 0) - top) / Math.max(1, keys - 1);
    return top >= 0.45 * m.length && top >= 1.5 * rest;
}

// 12 rows in a row through slots a…b (or the rows on either side of them) that the analyzer reads as an Anchor, with a
// row the original's Anchor did not have (a new row, or one of its rows outside its anchors)
function freshAnalyzerAnchor(slots, a, b, rules) {
    const near = [];
    for (let j = a, k = 0; k < ANCHOR_ROWS && (j = prevPresent(slots, j)) >= 0; k += 1) near.unshift(j);
    const touchFrom = near.length;
    for (let j = a; j <= b; j += 1) if (slots[j].mask) near.push(j);
    const touchTo = near.length;
    for (let j = b, k = 0; k < ANCHOR_ROWS && (j = nextPresent(slots, j)) >= 0; k += 1) near.push(j);
    // windows that hold a row from touchFrom − 1 to touchTo (the rows next to a row taken out count)
    for (let w = Math.max(0, touchFrom - ANCHOR_ROWS); w + ANCHOR_ROWS <= near.length && w <= touchTo; w += 1) {
        const idx = near.slice(w, w + ANCHOR_ROWS);
        let gap = false;
        for (let k = 1; k < idx.length && !gap; k += 1) if (slots[idx[k]].t - slots[idx[k - 1]].t > rules.motifMs) gap = true;
        if (gap || !analyzerAnchor(idx.map((i) => slots[i].mask), rules.keys)) continue;
        if (idx.some((i) => !rules.anchored.has(slots[i].t))) return true;
    }
    return false;
}

// an anchor the original did not have through a row within two rows of slots a…b (a row put in or taken out there
// moves which rows are every other one only there), or one the analyzer reads there
function freshAnchorAround(slots, a, b, rules, origMask) {
    if (freshAnalyzerAnchor(slots, a, b, rules)) return true;
    let from = a;
    for (let k = 0, j = a; k < 2 && (j = prevPresent(slots, j)) >= 0; k += 1) from = j;
    let to = b;
    for (let k = 0, j = b; k < 2 && (j = nextPresent(slots, j)) >= 0; k += 1) to = j;
    // each run once: a hit of a column between the ends of a run of it walked already is that run's
    const walked = [];
    for (let j = from; j <= to; j += 1) {
        for (const c of colsOf(slots[j].mask, 8)) {
            if (walked.some((w) => w.c === c && w.from <= j && j <= w.to)) continue;
            const run = everyOtherRun(slots, j, 1 << c, rules);
            walked.push({ c, from: run.from, to: run.to });
            if (!run.trill && freshAnchor(slots, run, c, rules, origMask)) return true;
        }
    }
    return false;
}

// How many jacks (two rows in a row) and anchors (runs of a column on every other row) of a built map the original
// did not have, by the rules the remap keeps (allowJacks false: none). → { jacks, anchors }
export function freshPatterns(chart, osuText) {
    const built = parseChart(osuText).rows;
    const rules = patternRules(chart.rows, chart.keys, { motifMs: Math.max(chainMsOf(chart.rows), chainMsOf(built.filter((r) => r.mask))) });
    // the original's rows and the built map's on one time line: a slot per time either has
    const byTime = new Map();
    for (const r of chart.rows) byTime.set(r.t, { t: r.t, beatMs: r.beatMs, mask: 0, orig: r.mask });
    for (const r of built) {
        const near = [0, -1, 1, -2, 2].map((d) => byTime.get(r.t + d)).find(Boolean);
        if (near) near.mask |= r.mask;
        else byTime.set(r.t, { t: r.t, beatMs: r.beatMs, mask: r.mask, orig: 0 });
    }
    const slots = [...byTime.values()].sort((a, b) => a.t - b.t);
    const origMask = slots.map((s) => s.orig);
    let jacks = 0;
    let [pp, p] = [-1, -1];
    slots.forEach((s, i) => {
        if (!s.mask) return;
        if (p >= 0 && freshJack(slots, p, i, origMask, rules)) jacks += 1;
        else if (pp >= 0 && freshMinijack(slots, pp, p, i, origMask, rules)) jacks += 1;
        [pp, p] = [p, i];
    });
    // every run once (a trill's too): a hit inside a run has no other
    let anchors = 0;
    const counted = new Set();
    const inside = new Set();
    slots.forEach((s, j) => {
        for (const c of colsOf(s.mask, chart.keys)) {
            if (inside.has(`${c}:${j}`)) continue;
            const run = everyOtherRun(slots, j, 1 << c, rules);
            const key = `${c}:${run.from}:${run.to}`;
            if (counted.has(key)) continue;
            counted.add(key);
            for (let k = run.from + 1; k < run.to; k += 1) inside.add(`${c}:${k}`);
            if (!run.trill && freshAnchor(slots, run, c, rules, origMask)) anchors += 1;
        }
    });
    return { jacks, anchors };
}

// Per ANALYZER_MARKS flavour, the times (sorted) of the rows flavourMetrics.js marks in `rows` (with t, mask).
export function analyzerMarks(rows) {
    const { rows: sorted, marks } = flavourMarks(rows.filter((r) => r.mask), ANALYZER_MARKS);
    return ANALYZER_MARKS.map((id) => sorted.filter((_, i) => marks[id][i]).map((r) => r.t));
}
// Does the analyzer mark a row of `rows` Anchor or Minijacks where it marked no row of the original's within 2 ms
// (`was`: analyzerMarks of the original)?
export function newAnalyzerMarks(was, rows) {
    return analyzerMarks(rows).some((times, k) => times.some((t) => {
        const list = was[k];
        let [lo, hi] = [0, list.length];
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (list[m] < t - ROW_MERGE_MS) lo = m + 1;
            else hi = m;
        }
        return lo >= list.length || list[lo] > t + ROW_MERGE_MS;
    }));
}

// the residue (index mod stride) of rows to keep: the one the rows on the beat have, else the strongest rows'
function strongest(live, stride) {
    const beats = new Set();
    live.forEach((x, k) => {
        if (x.div === 1) beats.add(k % stride);
    });
    if (beats.size) return beats.size === 1 ? [...beats][0] : null;
    let keep = 0;
    let best = Infinity;
    for (let r = 0; r < stride; r += 1) {
        const own = live.filter((_, k) => k % stride === r);
        const w = own.length ? mean(own.map((x) => REMOVE_WEIGHT[x.div])) : Infinity;
        if (w < best - 1e-9) [best, keep] = [w, r];
    }
    return keep;
}

// How to thin rows of one rhythm and keep every row on the beat, as long as the rows left are at most a beat apart:
// every 2nd row stays (for triplets every 3rd), the ones on the beat; in an odd rhythm (1/5, 1/7) whose beats fall on
// both halves, each group of rows keeps the half its beat is on. → { stride, keep: residue, or null (per group) } | null
function strideOf(live) {
    const step = (live.at(-1).t - live[0].t) / (live.length - 1);
    for (const stride of [2, 3]) {
        if (stride * step > BEAT_SLACK * live[0].beatMs + 1) break;
        const keep = strongest(live, stride);
        if (keep !== null) return { stride, keep };
    }
    return 2 * step > BEAT_SLACK * live[0].beatMs + 1 ? null : { stride: 2, keep: null };
}

// The steps that thin one stretch of a trill run (rows of one rhythm) and keep it alternating, in the order they go.
// First, while the rows are closer than a beat, the weaker half (for triplets two of three) of the rows comes out,
// four (six) rows per step, and a kept row that would now repeat a column of the one before moves to the columns the
// alternation needs (its note keeps its line but for the column): a 1/4 trill or jumptrill becomes a 1/2 one, a roll
// a trill. Then every row goes down to one note, two rows per step, the kept column continuing the alternation
// (jumptrill, split trill, chord trill → trill). A step: { remove: [note], add: [{ t, col, from: note | null }],
// drop: [{ t, col }] (moved notes taken out again), phrase, hold (it would take out a hold), weights (its rows') }.
function thinSteps(chart, seg) {
    const { rows, notes, keys } = chart;
    let live = [];
    for (let i = seg.from; i < seg.to; i += 1) {
        const r = rows[i];
        const at = [];
        for (const n of r.notes) (at[notes[n].col] ??= { orig: [] }).orig.push(n);
        live.push({ t: r.t, div: r.div, beatMs: r.beatMs, mask: r.mask, at, phrase: Math.floor((i - seg.from) / PHRASE_ROWS) });
    }
    const steps = [];
    const newStep = (phrase) => ({ remove: [], add: [], drop: [], phrase, hold: false, weights: [] });
    const take = (x, col, s, free) => {
        const cell = x.at[col];
        if (cell.orig) {
            s.remove.push(...cell.orig);
            if (cell.orig.some((n) => notes[n].hold)) s.hold = true;
            free.push(cell.orig[0]);
        } else {
            s.drop.push({ t: x.t, col });
            if (cell.from !== null) free.push(cell.from);
        }
        x.at[col] = undefined;
        x.mask &= ~(1 << col);
    };
    const moveTo = (x, mask, s) => {
        const free = [];
        const into = mask & ~x.mask;
        for (const c of colsOf(x.mask & ~mask, keys)) take(x, c, s, free);
        for (const c of colsOf(into, keys)) {
            const from = free.length ? free.shift() : null;
            s.add.push({ t: x.t, col: c, from });
            x.at[c] = { from };
            x.mask |= 1 << c;
        }
    };
    // [from, to) groups of up to `size` rows in a row, never across a phrase
    const groups = (size) => {
        const out = [];
        for (let g = 0; g < live.length;) {
            let e = g + 1;
            while (e < live.length && e - g < size && live[e].phrase === live[g].phrase) e += 1;
            out.push([g, e]);
            g = e;
        }
        return out;
    };
    // the rows just before and after the stretch, where they are at most a beat away
    const before = rows[seg.from - 1];
    const after = rows[seg.to];
    const outside = before && rows[seg.from].t - before.t <= before.beatMs + 1 ? before.mask : null;
    const beyond = after && after.t - rows[seg.to - 1].t <= after.beatMs + 1 ? after.mask : 0;

    for (let pass = 0; pass < MAX_HALVINGS && live.length >= 4; pass += 1) {
        const thin = strideOf(live);
        if (!thin) break;
        const { stride } = thin;
        const kept = [];
        let last = outside;
        let last2 = null;
        // the kept rows of a phrase take its rows' columns in order, at the slower rhythm (a b a b c d c d at 1/4 →
        // a b a b c d c d at 1/2): what they alternated between stays, where the rows kept would have had a b c b
        const was = live.map((x) => x.mask);
        const firstOf = new Map();
        live.forEach((x, k) => {
            if (!firstOf.has(x.phrase)) firstOf.set(x.phrase, k);
        });
        const nth = new Map();
        // per group: the half its beat is on, a group without one going on as the one before, one with beats on both
        // halves staying whole
        let half = live.findIndex((x) => x.div === 1) % stride;
        let keep = thin.keep;
        for (const [g, e] of groups(2 * stride)) {
            const s = newStep(live[g].phrase);
            if (thin.keep === null) {
                const here = strongest(live.slice(g, e), stride);
                if (here !== null && live.slice(g, e).some((x) => x.div === 1)) half = (here + g) % stride;
                keep = here === null ? -1 : half;
            }
            // the stretch's last row stays where taking it out would put the row kept before it next to the row after
            // the stretch with a column of it
            const stay = [];
            let prevKept = last ?? 0;
            for (let k = g; k < e; k += 1) {
                const on = keep < 0 || k % stride === keep;
                stay.push(on || (k === live.length - 1 && (prevKept & beyond) !== 0));
                if (on) prevKept = live[k].mask;
            }
            const goneMasks = [];
            for (let k = g; k < e; k += 1) {
                const x = live[k];
                if (stay[k - g]) continue;
                goneMasks.push(x.mask);
                s.weights.push(REMOVE_WEIGHT[x.div]);
                const free = [];
                for (const c of colsOf(x.mask, keys)) take(x, c, s, free);
            }
            for (let k = g; k < e; k += 1) {
                const x = live[k];
                if (!stay[k - g]) continue;
                const j = nth.get(x.phrase) ?? 0;
                nth.set(x.phrase, j + 1);
                const target = lowestCols(was[firstOf.get(x.phrase) + j], popcount(x.mask));
                const holding = colsOf(x.mask, keys).some((c) => x.at[c].orig?.some((n) => notes[n].hold));
                if (!holding && target !== x.mask && !(last !== null && (target & last))) moveTo(x, target, s);
                if (last !== null && (x.mask & last)) {
                    // the row two kept rows back, else one taken out here; never more notes than the row has
                    const size = popcount(x.mask);
                    const options = [last2, ...goneMasks].filter((m) => m && !(m & last)).map((m) => lowestCols(m, size));
                    const want = options.find((m) => popcount(m) === size) ?? options[0];
                    if (want !== undefined) moveTo(x, want, s);
                }
                last2 = last;
                last = x.mask;
                kept.push(x);
            }
            if (s.remove.length || s.add.length || s.drop.length) steps.push(s);
        }
        live = kept;
    }

    // every row down to one note: the column that goes on with the alternation (a b a b), else one the rows around lack
    const keptCol = [];
    live.forEach((x, k) => {
        const cols = colsOf(x.mask, keys);
        const prev = k > 0 ? 1 << keptCol[k - 1] : (outside ?? 0);
        const prev2 = k > 1 ? 1 << keptCol[k - 2] : 0;
        const next = live[k + 1]?.mask ?? 0;
        const hold = cols.find((c) => x.at[c].orig?.some((n) => notes[n].hold));
        keptCol.push(hold ?? cols.find((c) => (prev2 & (1 << c)) && !(prev & (1 << c)))
            ?? cols.find((c) => !((prev | next) & (1 << c))) ?? cols.find((c) => !(prev & (1 << c))) ?? cols[0]);
    });
    for (const [g, e] of groups(2)) {
        const s = newStep(live[g].phrase);
        for (let k = g; k < e; k += 1) {
            const x = live[k];
            const out = x.mask & ~(1 << keptCol[k]);
            if (!out) continue;
            s.weights.push(REMOVE_WEIGHT[x.div]);
            const free = [];
            for (const c of colsOf(out, keys)) take(x, c, s, free);
        }
        if (s.remove.length || s.drop.length) steps.push(s);
    }
    return steps;
}

// The removals in order (each a note index, or a trill step { remove, add, drop }): each prefix of the list is a valid
// easier map. Outside trills single notes go, weakest first; a trill thins step by step (thinSteps), each step whole
// and in its phrase's order, and only while it makes no jack the original did not have and empties no row on the beat;
// the two take turns so that each has lost the same share of its notes. trills: false treats trill notes like any other.
// A removal that would make a minijack or an anchor the original did not have (two rows of one column brought next to
// each other, the rows every other one shifted) waits until all the others are done: then, jacks false, it goes only if
// that is no longer so; jacks true, it goes anyway (never a jack longer than the original's longest).
// → { order, clean, jackNotes }: the removals in order; the first `clean` make no jack or anchor the original did not
// have (allowJacks false: all of them); jackNotes[k], the notes the first k take out that may (the rest).
function removalPlan(chart, { seed = 1, trills = true, jacks = false } = {}) {
    const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const { notes, rows, keys } = chart;
    const slots = rows.map((r) => ({ ...r }));
    const origMask = rows.map((r) => r.mask);
    const longest = maxJackOf(rows);
    const rules = patternRules(rows, keys, { stretch: EASIER_STRETCH });
    const { runOf, segments } = trills ? trillRuns(chart) : NO_TRILLS(rows.length);
    const candidates = [];
    slots.forEach((s, i) => {
        // within a row, a random note goes first; the one left last loses its chord bonus
        const own = s.notes.filter((n) => !notes[n].hold).map((n) => ({ n, r: rng() })).sort((a, b) => a.r - b.r);
        own.forEach(({ n }, j) => {
            const left = popcount(s.mask) - 1 - j;
            const score = REMOVE_WEIGHT[s.div] + (CHORD_BONUS[s.family] ?? 0.5) * Math.max(0, left) + REMOVE_JITTER * rng();
            candidates.push({ n, slot: i, score: runOf[i] >= 0 ? LAST_RESORT + score : score });
        });
    });
    segments.forEach((seg, si) => {
        const ceiling = new Map();
        const jitter = new Map();
        for (const step of thinSteps(chart, seg)) {
            const key = `${si}:${step.phrase}`;
            if (!jitter.has(key)) jitter.set(key, REMOVE_JITTER * rng());
            // strictly falling within a phrase, so its steps go in their order
            const score = Math.min(mean(step.weights) + jitter.get(key), (ceiling.get(key) ?? Infinity) - 1e-3);
            ceiling.set(key, score);
            candidates.push({ step, key, score });
        }
    });
    candidates.forEach((c, k) => {
        c.id = k;
    });
    candidates.sort((a, b) => b.score - a.score || a.id - b.id);
    // three queues: the notes outside trills and the trill steps, taken so that both have lost the same share of their
    // notes (a step counts the notes it takes out net of the ones it moves), then the single notes inside trills
    const queues = [
        candidates.filter((c) => !c.step && runOf[c.slot] < 0),
        candidates.filter((c) => c.step),
        candidates.filter((c) => !c.step && runOf[c.slot] >= 0),
    ];
    const total = [0, 0];
    rows.forEach((r, i) => {
        total[runOf[i] >= 0 ? 1 : 0] += r.notes.filter((n) => !notes[n].hold).length;
    });
    const taken = [0, 0];
    const at = [0, 0, 0];
    const next = () => {
        const open = [0, 1].filter((q) => at[q] < queues[q].length);
        if (!open.length) return at[2] < queues[2].length ? queues[2][at[2]++] : null;
        const q = open.length === 1 ? open[0] : (taken[0] / Math.max(1, total[0]) <= taken[1] / Math.max(1, total[1]) ? 0 : 1);
        const c = queues[q][at[q]++];
        c.queue = q;
        return c;
    };

    const slotOf = new Int32Array(notes.length);
    rows.forEach((r, i) => r.notes.forEach((n) => {
        slotOf[n] = i;
    }));
    const slotAt = new Map(rows.map((r, i) => [r.t, i]));
    const holds = notes.filter((n) => n.hold);
    const insideHold = (col, s) => holds.some((h) => h.col === col && s.t >= h.t - ROW_MERGE_MS && s.t <= h.end + HOLD_AFTER_BEATS * s.beatMs);
    // a change to slots a…b that makes no jack or anchor the original did not have
    const clean = (a, b) => !freshJackAround(slots, a, b, origMask, rules) && !freshAnchorAround(slots, a, b, rules, origMask);
    // → "ok" (done), "fail" (undone: never) or "fresh" (undone: it makes a new jack or anchor; `lax` lets it)
    const tryStep = (step, lax) => {
        const before = new Map();
        const set = (i, mask) => {
            if (!before.has(i)) before.set(i, slots[i].mask);
            slots[i].mask = mask;
        };
        for (const n of step.remove) set(slotOf[n], slots[slotOf[n]].mask & ~(1 << notes[n].col));
        for (const d of step.drop) set(slotAt.get(d.t), slots[slotAt.get(d.t)].mask & ~(1 << d.col));
        for (const a of step.add) set(slotAt.get(a.t), slots[slotAt.get(a.t)].mask | (1 << a.col));
        const touched = [...before.keys()];
        const [lo, hi] = [Math.min(...touched), Math.max(...touched)];
        const ok = touched.every((i) => slots[i].mask || slots[i].div !== 1)
            && step.add.every((a) => !insideHold(a.col, slots[slotAt.get(a.t)]))
            && !newJackAround(slots, lo, hi, origMask, TRILL_REPEAT_BEATS)
            && touched.every((i) => colsOf(slots[i].mask, keys).every((c) => runThrough(slots, i, 1 << c) <= longest));
        const status = !ok ? "fail" : lax || clean(lo, hi) ? "ok" : "fresh";
        if (status !== "ok") for (const [i, mask] of before) slots[i].mask = mask;
        return status;
    };
    const gone = new Set();
    const trySingle = (c, lax) => {
        const s = slots[c.slot];
        const bit = 1 << notes[c.n].col;
        const sameColumn = s.notes.filter((n) => notes[n].col === notes[c.n].col && !gone.has(n)).length;
        const after = sameColumn > 1 ? s.mask : s.mask & ~bit;
        const before = s.mask;
        if (!after) {
            if (s.div === 1) return "fail"; // a row on the beat keeps its last note
            s.mask = 0;
            const p = prevPresent(slots, c.slot);
            const shared = p >= 0 ? slots[p].mask & (slots[nextPresent(slots, c.slot)]?.mask ?? 0) : 0;
            let ok = true;
            for (let b = 0; b < keys && ok; b += 1) if (shared & (1 << b)) ok = runThrough(slots, p, 1 << b) <= longest;
            // inside a trill an emptied row may not leave two rows of one column next to each other
            if (ok && runOf[c.slot] >= 0) ok = !newJackAround(slots, c.slot, c.slot, origMask, TRILL_REPEAT_BEATS);
            if (!ok) {
                s.mask = before;
                return "fail";
            }
        }
        s.mask = after;
        if (lax || clean(c.slot, c.slot)) return "ok";
        s.mask = before;
        return "fresh";
    };
    const stopped = new Set();
    const waiting = new Set(); // phrases whose next step waits for the late pass
    const late = [];
    const order = [];
    const take = (c) => {
        if (c.step) {
            for (const n of c.step.remove) gone.add(n);
            taken[1] += c.step.remove.length + c.step.drop.length - c.step.add.length;
            order.push({ remove: c.step.remove, add: c.step.add, drop: c.step.drop });
        } else {
            gone.add(c.n);
            if (c.queue === 0) taken[0] += 1;
            order.push(c.n);
        }
    };
    for (let c = next(); c; c = next()) {
        if (c.step) {
            if (stopped.has(c.key)) continue;
            if (waiting.has(c.key)) {
                late.push(c);
                continue;
            }
            const status = c.step.hold ? "fail" : tryStep(c.step, false);
            if (status === "fail") stopped.add(c.key);
            if (status === "fresh") {
                waiting.add(c.key);
                late.push(c);
            }
            if (status === "ok") take(c);
            continue;
        }
        if (gone.has(c.n)) continue;
        const status = trySingle(c, false);
        if (status === "fresh") late.push(c);
        if (status === "ok") take(c);
    }
    // what would make a jack or an anchor the original did not have: tried once more (what was in the way may be gone),
    // then, if the map may get them, allowed
    const late0 = new Set();
    const retry = (lax) => {
        const blocked = new Set(); // phrases whose step did not go: their next steps wait too
        for (const c of late) {
            if (late0.has(c) || (c.step ? stopped.has(c.key) || blocked.has(c.key) : gone.has(c.n))) continue;
            const status = c.step ? tryStep(c.step, lax) : trySingle(c, lax);
            if (status === "ok") {
                take(c);
                late0.add(c);
            } else if (c.step) {
                (status === "fail" || lax ? stopped : blocked).add(c.key);
            }
        }
    };
    retry(false);
    const cleanLen = order.length;
    if (jacks) retry(true);
    const jackNotes = [0];
    order.forEach((e, k) => jackNotes.push(jackNotes[k] + (k < cleanLen ? 0 : typeof e === "number" ? 1 : e.remove.length)));
    return { order, clean: cleanLen, jackNotes };
}
export const removalOrder = (chart, options) => removalPlan(chart, options).order;

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

// The additions in order (each { t, col }, or a trill upgrade { adds: [{ t, col }] }): each prefix of the list is a
// valid harder map. No new row goes inside a trill run and a chord onto a trill row only after everything else; a
// single-note trill gets each row's partner column four rows at a time from its start (across the hands the other
// column of the same hand: a jumptrill; on one hand the mirror column: a split trill), never a new jack or anchor
// (where its end would read as one, the next four rows with it, and so on).
// A note goes on a column that makes no minijack or anchor the original did not have; jacks false, a note with no such
// column is not added; jacks true, it comes after all the others, those that keep the map's share of rows in a jack
// first (never a jack longer or quicker than the original's own).
// → { order, clean, jackNotes }: the additions in order; the first `clean` come before any note that waited for a pass
// that lets a jack or anchor the original did not have (allowJacks false: all of them); jackNotes[k], the notes of the
// first k that made one.
function additionPlan(chart, { seed = 1, model = null, trills = true, jacks = false } = {}) {
    const rng = mulberry32((seed ^ 0x27d4eb2f) >>> 0);
    const pick = mulberry32((seed ^ 0x165667b1) >>> 0);
    const { rows, keys, reds } = chart;
    const longest = maxJackOf(rows);
    const rules = patternRules(rows, keys);
    const fastest = fastestJackMs(rows);
    const { runOf, segments } = trills ? trillRuns(chart) : NO_TRILLS(rows.length);
    const gaps = rows.slice(1).map((r, i) => r.t - rows[i].t).filter((g) => g > ROW_MERGE_MS);
    const minGap = percentile(gaps, 0.1);
    // the original rows, and an empty slot halfway between two rows where that lands on the 1/1, 1/2 or 1/4 grid
    // inside a passage (rows at most a beat apart), never quicker than the map's own quick rhythm, never in a trill
    const slots = [];
    const slotOfRow = [];
    rows.forEach((r, i) => {
        slotOfRow.push(slots.length);
        slots.push({ ...r, orig: true, trill: runOf[i] >= 0 });
        const n = rows[i + 1];
        if (!n || (runOf[i] >= 0 && runOf[i] === runOf[i + 1])) return;
        const gap = n.t - r.t;
        if (gap > r.beatMs + 1 || gap / 2 < minGap - 1) return;
        const grid = gridOf(r.t + gap / 2, reds);
        if (!NEW_ROW_WEIGHT[grid.div] || grid.red !== r.red) return;
        const t = Math.round(grid.exact);
        if (t - r.t <= ROW_MERGE_MS || n.t - t <= ROW_MERGE_MS) return;
        slots.push({ ...grid, t, mask: 0, holdMask: 0, notes: [], family: r.family, orig: false, trill: false });
    });
    const origMask = slots.map((s) => s.mask);
    const holds = chart.notes.filter((n) => n.hold);
    const insideHold = (col, s) => holds.some((h) => h.col === col && s.t >= h.t - ROW_MERGE_MS && s.t <= h.end + HOLD_AFTER_BEATS * s.beatMs);

    // on or next to a trill row (and for an upgrade) no jack the original did not have; elsewhere none longer or
    // quicker than the original's own
    function canAdd(i, col, upgrade = false) {
        const s = slots[i];
        const bit = 1 << col;
        if (s.mask & bit || insideHold(col, s)) return false;
        const before = s.mask;
        s.mask |= bit;
        let ok = runThrough(slots, i, bit) <= longest;
        const around = [prevPresent(slots, i), nextPresent(slots, i)];
        for (const q of around) {
            if (!ok || q < 0 || !(slots[q].mask & bit)) continue;
            const [a, b] = q < i ? [slots[q], s] : [s, slots[q]];
            if (closeTogether(a, b) && b.t - a.t < fastest - 1) ok = false;
        }
        if (ok && (upgrade || s.trill || around.some((q) => q >= 0 && slots[q].trill))) ok = !newJackAround(slots, i, i, origMask, s.trill && !upgrade ? TRILL_REPEAT_BEATS : JACK_RESET_BEATS);
        s.mask = before;
        return ok;
    }
    // slots a…b as they are now have no jack or anchor the original did not have around them
    const clean = (a, b = a) => !freshJackAround(slots, a, b, origMask, rules) && !freshAnchorAround(slots, a, b, rules, origMask);

    const candidates = [];
    slots.forEach((s, i) => {
        if (s.orig) {
            const base = s.trill ? LAST_RESORT : 0;
            for (let k = 0; k < s.sizeCap - popcount(s.mask); k += 1) candidates.push({ slot: i, score: base + CHORD_WEIGHT[s.div] - 0.5 * k + ADD_JITTER * rng() });
        } else {
            candidates.push({ slot: i, score: NEW_ROW_WEIGHT[s.div] + ADD_JITTER * rng() });
        }
    });
    segments.forEach((seg, si) => {
        const cols = rows.slice(seg.from, seg.to).map((r) => (popcount(r.mask) === 1 ? lowCol(r.mask) : -1));
        if (keys !== 4 || cols.length < UPGRADE_ROWS || cols.includes(-1)) return;
        // a trill (rows two apart mostly on one column, not a roll); every row gets the other column of its hand
        // (across the hands: a jumptrill) or else its mirror column (on one hand: a split trill), whichever leaves no
        // two rows in a row sharing a column
        let repeats = 0;
        for (let k = 2; k < cols.length; k += 1) if (cols[k] === cols[k - 2]) repeats += 1;
        if (2 * repeats < cols.length - 2) return;
        const jump = (c, f) => (1 << c) | (1 << f(c));
        const partner = [(c) => c ^ 1, (c) => c ^ 2].find((f) => cols.every((c, k) => k === 0 || !(jump(c, f) & jump(cols[k - 1], f))));
        if (!partner) return;
        // four rows at a time (the last step takes the rest), so a part done reads as a jumptrill or split trill
        const jitter = ADD_JITTER * rng();
        let ceiling = Infinity;
        for (let k = 0; k < cols.length;) {
            const e = cols.length - k < 2 * UPGRADE_ROWS ? cols.length : k + UPGRADE_ROWS;
            const adds = [];
            for (let j = k; j < e; j += 1) adds.push({ slot: slotOfRow[seg.from + j], col: partner(cols[j]) });
            const score = Math.min(mean(adds.map((a) => CHORD_WEIGHT[slots[a.slot].div])) - TRILL_PROTECT + jitter, ceiling - 1e-3);
            ceiling = score;
            candidates.push({ upgrade: adds, key: si, score });
            k = e;
        }
    });
    candidates.forEach((c, k) => {
        c.id = k;
    });
    candidates.sort((a, b) => b.score - a.score || a.id - b.id);

    // jacks over the whole map: rows in a row sharing a column within half a beat, per row the original has
    const jackPair = (a, b) => (a >= 0 && b >= 0 && (slots[a].mask & slots[b].mask) && closeTogether(slots[a], slots[b]) ? 1 : 0);
    const jackPairsAround = (i) => {
        const [p, q] = [prevPresent(slots, i), nextPresent(slots, i)];
        return slots[i].mask ? jackPair(p, i) + jackPair(i, q) : jackPair(p, q);
    };
    let jackPairs = 0;
    let present = 0;
    for (let i = 0, p = -1; i < slots.length; i += 1) {
        if (!slots[i].mask) continue;
        jackPairs += jackPair(p, i);
        present += 1;
        p = i;
    }
    const jackShare = jackPairs / Math.max(1, present);

    const limit = Math.floor(MAX_ADD_SHARE * chart.notes.length);
    const order = [];
    const stopped = new Set();
    const merged = new Set();
    let count = 0;
    // which columns a note may take, pass by pass: one that makes no jack or anchor the original did not have; then
    // (jacks true) one that keeps the map's share of rows in a jack, then any. A note with none in its pass goes again
    // after all the others, in the next.
    const passes = jacks ? ["clean", "share", "any"] : ["clean"];
    const queue = [...candidates];
    const jackAt = new Set();
    let cleanLen = -1;
    for (let qi = 0; qi < queue.length; qi += 1) {
        const c = queue[qi];
        if (count >= limit) break;
        if (c.pass && cleanLen < 0) cleanLen = order.length;
        if (c.upgrade) {
            if (merged.has(c.id)) continue;
            if (count + c.upgrade.length > limit) break;
            if (stopped.has(c.key)) continue;
            // the step whole: halfway, the rows not yet thickened could read as an anchor; where its end does (a
            // jumptrill going on as the trill of single notes it was, flavourMetrics.js Anchor), the next steps of the
            // trill with it, until it does not
            const later = queue.slice(qi + 1).filter((d) => d.upgrade && d.key === c.key);
            const steps = [c];
            const done = [];
            let ok = false;
            for (let k = 0; ; k += 1) {
                const step = steps[k];
                let all = true;
                for (const a of step.upgrade) {
                    if (!canAdd(a.slot, a.col, true)) {
                        all = false;
                        break;
                    }
                    slots[a.slot].mask |= 1 << a.col;
                    done.push(a);
                }
                if (!all) break;
                if (clean(done[0].slot, done.at(-1).slot)) {
                    ok = true;
                    break;
                }
                if (k >= later.length) break;
                steps.push(later[k]);
            }
            ok &&= count + done.length <= limit;
            if (!ok) {
                for (const a of done) slots[a.slot].mask &= ~(1 << a.col);
                stopped.add(c.key);
                continue;
            }
            for (const step of steps) merged.add(step.id);
            order.push({ adds: done.map((a) => ({ t: slots[a.slot].t, col: a.col })) });
            count += done.length;
            continue;
        }
        const s = slots[c.slot];
        if (popcount(s.mask) >= (s.orig ? s.sizeCap : 1)) continue;
        const pass = c.pass ?? 0;
        const was = s.mask;
        const grows = !was;
        const pairsBefore = jackPairsAround(c.slot);
        const valid = [];
        const delta = [];
        const dirty = [];
        let held = false;
        for (let col = 0; col < keys; col += 1) {
            if (!canAdd(c.slot, col)) continue;
            s.mask = was | (1 << col);
            const d = jackPairsAround(c.slot) - pairsBefore;
            const fresh = !clean(c.slot);
            s.mask = was;
            const share = d <= 0 || jackPairs + d <= jackShare * (present + grows) + 1e-9;
            if (!fresh || passes[pass] === "any" || (passes[pass] === "share" && share)) {
                valid.push(col);
                delta.push(d);
                dirty.push(fresh);
            } else {
                held = true;
            }
        }
        if (!valid.length) {
            if (held && pass + 1 < passes.length) queue.push({ ...c, pass: pass + 1 });
            continue;
        }
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
        jackPairs += delta[valid.indexOf(col)];
        present += grows;
        if (dirty[valid.indexOf(col)]) jackAt.add(order.length);
        order.push({ t: s.t, col });
        count += 1;
    }
    const jackNotes = [0];
    order.forEach((e, k) => jackNotes.push(jackNotes[k] + (jackAt.has(k) ? 1 : 0)));
    return { order, clean: cleanLen < 0 ? order.length : cleanLen, jackNotes };
}
export const additionOrder = (chart, options) => additionPlan(chart, options).order;

// a note moved to another column of its row: only the line's x changes, its hitsound stays
const withX = (line, x) => line.replace(/^[^,]*/, String(x));

// The chart with the first share of a plan applied: knob −1 … 0 takes out that share of the removals,
// 0 … 1 adds that share of the additions. → { osuText, removed, added, moved } (moved: notes a trill's halving put
// onto another column of their own row; each counts as one removed from its place and one added at the new one)
export function applyKnob(chart, { removals = [], additions = [] }, knob) {
    const k = Math.max(-1, Math.min(1, Number(knob) || 0));
    const steps = k < 0 ? Math.round(-k * removals.length) : 0;
    const more = k > 0 ? Math.round(k * additions.length) : 0;
    const gone = new Set();
    const fresh = new Map();
    const key = (a) => `${a.t},${a.col}`;
    for (const e of removals.slice(0, steps)) {
        if (typeof e === "number") {
            gone.add(e);
            continue;
        }
        for (const n of e.remove) gone.add(n);
        for (const d of e.drop) fresh.delete(key(d));
        for (const a of e.add) fresh.set(key(a), a);
    }
    for (const e of additions.slice(0, more)) for (const a of e.adds ?? [e]) fresh.set(key(a), a);
    // a note one halving moved and the next put back on its own column is its original line
    for (const [k, a] of fresh) {
        if (a.from != null && a.col === chart.notes[a.from].col && a.t === chart.notes[a.from].t) {
            gone.delete(a.from);
            fresh.delete(k);
        }
    }
    const objects = chart.notes.map((n, i) => ({ t: n.t, order: i, line: n.line })).filter((o) => !gone.has(o.order));
    let moved = 0;
    let added = 0;
    for (const a of fresh.values()) {
        const x = columnX(a.col, chart.keys);
        if (a.from != null) {
            moved += 1;
            objects.push({ t: a.t, order: a.from, line: withX(chart.notes[a.from].line, x) });
        } else {
            objects.push({ t: a.t, order: chart.notes.length + added, line: `${x},192,${a.t},1,0,0:0:0:0:` });
            added += 1;
        }
    }
    objects.sort((a, b) => a.t - b.t || a.order - b.order);
    const lines = [...chart.lines.slice(0, chart.hitStart + 1), ...objects.map((o) => o.line), ...chart.other, ...chart.lines.slice(chart.hitEnd)];
    return { osuText: lines.join(chart.eol), removed: gone.size, added: added + moved, moved };
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

// The share of a built map's rows inside the original's trill runs (by time) that are still in a trill; in a run that
// was mostly a trill of chords (jumptrill, split trill, chord trill), a row that is a trill of single notes now counts
// half.
export function trillKept(chart, runs, osuText) {
    if (!runs.length) return 0;
    const { marks: was } = flavourMarks(chart.rows, CHORD_TRILLS);
    const ofChords = (marks, i) => CHORD_TRILLS.some((k) => marks[k][i]);
    const chordy = runs.map((r) => {
        let n = 0;
        for (let i = r.from; i < r.to; i += 1) n += ofChords(was, i) ? 1 : 0;
        return 2 * n > r.to - r.from;
    });
    const rows = parseChart(osuText).rows;
    const inTrill = trillMarks(rows);
    const { marks } = flavourMarks(rows, CHORD_TRILLS);
    const spans = runs.map((r) => [chart.rows[r.from].t - ROW_MERGE_MS, chart.rows[r.to - 1].t + ROW_MERGE_MS]);
    let inside = 0;
    let marked = 0;
    let s = 0;
    rows.forEach((r, i) => {
        while (s < spans.length && spans[s][1] < r.t) s += 1;
        if (s >= spans.length || r.t < spans[s][0]) return;
        inside += 1;
        if (inTrill[i]) marked += !chordy[s] || ofChords(marks, i) ? 1 : OTHER_SHAPE;
    });
    return inside ? marked / inside : 0;
}

// How far an analysed dan is from the range [lo, hi): 0 inside, else the distance to the nearest dan in it (the dan
// comes in steps of 0.1, so one at hi is a step away); Infinity for a map the analyzer does not read.
export function missBy(numeric, { lo, hi }) {
    if (!Number.isFinite(numeric)) return Infinity;
    if (numeric < lo) return lo - numeric;
    return numeric >= hi ? numeric - hi + DAN_STEP : 0;
}

// remapChart({ osuText, range: {lo, hi}, seed, allowJacks }, analyze(text, rate) → result, model | null, { onProgress })
// → { osuText, result, reachable, removed, added, moved, version, jacksWouldHelp }. First the changes that make no
// minijack or anchor the original did not have (and no row the analyzer marks Anchor or Minijacks where it marked none
// in the original); allowJacks (only true counts) lets the rest come after them when those alone miss the range, and
// takes that only if it gets into the range or at least PLAIN_MARGIN closer: in range, the shortest prefix of them that
// reaches it. Without it a range out of reach comes back as the closest it got (reachable false); jacksWouldHelp: with
// allowJacks it would have got into the range or at least PLAIN_MARGIN closer (a map it changed or one it did not).
export async function remapChart({ osuText, range, seed = 1, allowJacks = false }, analyze, model, { onProgress } = {}) {
    const jacks = allowJacks === true;
    const chart = parseChart(osuText);
    if (!chart.rows.length) throw new Error(t("gen.remap.noRows"));
    const original = await analyze(osuText, 1);
    if (original?.kind !== "ok") throw new Error(t("gen.remap.noDan", { message: original?.message ?? original?.kind ?? "?" }));
    const { version: oldVersion } = readMeta(osuText);
    const finish = (text, result, extra) => {
        const version = `${oldVersion} (${numericToLabel(result.numeric).text} remap)`;
        return { osuText: addTag(setField(setVersion(text, version), "Metadata", "BeatmapID", "0"), REMAP_TAG), result, version, jacksWouldHelp: false, ...extra };
    };
    const { lo, hi } = range;
    if (original.numeric >= lo && original.numeric < hi) return finish(osuText, original, { reachable: true, removed: 0, added: 0, moved: 0 });

    // the closer the new map's pattern mix is to the original's, the better (shares by family, overlap 0…1), and the
    // more of the original's trills are still trills; past the clean changes, the fewer notes that make a jack or
    // anchor the better
    const wanted = familyShares(original.top3);
    const { runs } = trillRuns(chart);
    const mixOf = (a) => {
        const got = familyShares(a?.result?.top3);
        return Object.entries(wanted).reduce((s, [f, share]) => s + Math.min(share, got[f] ?? 0), 0);
    };
    const score = (a) => mixOf(a) + (runs.length ? TRILL_SCORE_W * trillKept(chart, runs, a.built.osuText) : 0)
        - JACK_SCORE_W * (a.jackNotes ?? 0) / chart.notes.length;
    const thinner = original.numeric >= hi;
    const plans = new Map();
    // the plan for a seed: the jacks one starts with exactly the clean one's changes
    const planFor = (s, trills, loose) => {
        const key = `${s}:${trills}:${loose}`;
        if (!plans.has(key)) {
            const p = thinner ? removalPlan(chart, { seed: s, trills, jacks: loose }) : additionPlan(chart, { seed: s, model, trills, jacks: loose });
            plans.set(key, { ...p, [thinner ? "removals" : "additions"]: p.order });
        }
        return plans.get(key);
    };
    // The clean stage never gives back a map with a jack or anchor the original did not have (freshPatterns) or a row
    // the analyzer marks Anchor or Minijacks where it marked none in the original. The plans' rules look near each
    // change, but the analyzer's motif break moves with the whole map's rhythm (easier spreads it out: a jump twice
    // 300 ms apart that was two motifs becomes one) and its Minijacks looks a row further (hkmori - lost: a single taken
    // out after the original's [03] [03] [03] marks the row after it), so every map that stage builds is checked whole.
    // That check is not monotone in the plan's length (that row is marked until a later change takes the jump apart), so
    // the clean stage works on a view of the plan: the change that first makes a prefix fail is left out and the plan
    // goes on past it (a plain note, at most MAX_SKIPS of them), else the longest prefix before it that passes.
    const viewOf = (plan) => (plan.view ??= { plan, skip: new Set(), tidy: new Map([[0, true]]), analysed: new Map() });
    const skipsBelow = (p, steps) => p.skip !== undefined && [...p.skip].some((i) => i < steps);
    // the first `steps` changes of a plan (of a view: but those it leaves out)
    const build = (p, steps) => {
        if (skipsBelow(p, steps)) {
            const list = p.plan.order.slice(0, steps).filter((_, i) => !p.skip.has(i));
            return applyKnob(chart, thinner ? { removals: list } : { additions: list }, thinner ? -1 : 1);
        }
        const plan = p.plan ?? p;
        return applyKnob(chart, plan, plan.order.length ? (thinner ? -steps : steps) / plan.order.length : 0);
    };
    const marked = analyzerMarks(chart.rows);
    const tidy = (view, steps) => {
        if (!view.tidy.has(steps)) {
            const text = build(view, steps).osuText;
            const fresh = freshPatterns(chart, text);
            view.tidy.set(steps, !fresh.jacks && !fresh.anchors && !newAnalyzerMarks(marked, parseRows(text, chart.keys)));
        }
        return view.tidy.get(steps);
    };
    const plainChange = (e) => (thinner ? typeof e === "number" : e != null && !e.adds);
    const tidyUpTo = (view, steps) => {
        for (;;) {
            if (tidy(view, steps)) return steps;
            // from the longest prefix below known to have none to the shortest after it known to have some
            let [a, b] = [0, steps]; // a has none, b has
            for (const [k, ok] of view.tidy) if (ok && k > a && k < steps) a = k;
            for (const [k, ok] of view.tidy) if (!ok && k > a && k < b) b = k;
            while (b - a > 1) {
                const m = (a + b) >> 1;
                if (tidy(view, m)) a = m;
                else b = m;
            }
            // change a makes it fail: left out, what was known past it is not
            if (view.skip.size >= MAX_SKIPS || !plainChange(view.plan.order[a])) return a;
            view.skip.add(a);
            for (const cache of [view.tidy, view.analysed]) for (const k of [...cache.keys()]) if (k > a) cache.delete(k);
            view.tidy.set(a + 1, true);
        }
    };
    let count = 0;
    let below = false;
    let above = false;
    const tried = [];
    const inside = (a) => a.numeric >= lo && a.numeric < hi;
    // a prefix analysed once (the clean stage's knobs past where a plan has to stop all give that prefix)
    // (a view's prefix with nothing left out is its plan's)
    const evaluateSteps = async (p, steps, how) => {
        const view = skipsBelow(p, steps);
        const plan = p.plan ?? p;
        const cache = view ? p.analysed : (plan.analysed ??= new Map());
        let a = cache.get(steps);
        if (!a) {
            const built = build(p, steps);
            const result = await analyze(built.osuText, 1);
            count += 1;
            onProgress?.({ phase: "search", i: count, n: Math.max(count, PROGRESS_EVALUATIONS) });
            // a map the analyzer no longer reads (an easier one that is mostly holds now) went past the range
            const numeric = result?.kind === "ok" ? result.numeric : (thinner ? -Infinity : Infinity);
            a = { built, result, numeric, jackNotes: view ? 0 : plan.jackNotes[steps], steps, ...how };
            cache.set(steps, a);
            tried.push(a);
        }
        below ||= a.numeric < lo;
        above ||= a.numeric >= hi;
        return a;
    };
    // knob 0 … ±1: the share of the clean changes, as far as the whole-map check lets them (stage "clean"), or the share
    // of the whole plan, the clean changes first and the ones that make a jack or anchor after them ("jacks": the clean
    // ones that check stopped come back there too)
    const evaluate = (knob, s, trills, stage, loose) => {
        const plan = planFor(s, trills, loose);
        const share = Math.min(1, Math.abs(knob));
        if (stage !== "clean") return evaluateSteps(plan, Math.round(share * plan.order.length), { s, trills, stage });
        const view = viewOf(plan);
        return evaluateSteps(view, tidyUpTo(view, Math.round(share * plan.clean)), { s, trills, stage });
    };
    // Of the jacks stage's layouts in range that keep the pattern mix (within SHORTEST_MIX of the best of them), the one
    // with the fewest notes that make a jack or anchor, and its plan bisected for the shortest prefix that still reaches
    // the range and keeps the mix: as few changes past the clean ones as it needs, whatever else the mix says.
    const reaches = (a) => (thinner ? a.numeric < hi : a.numeric >= lo);
    const shortest = async () => {
        const fits = tried.filter((a) => a.stage === "jacks" && inside(a));
        const most = Math.max(...fits.map(mixOf));
        const keeps = (a) => inside(a) && mixOf(a) >= most - SHORTEST_MIX - 1e-9;
        const fewest = fits.filter(keeps).sort((a, b) => a.jackNotes - b.jackNotes || a.steps - b.steps)[0];
        if (!fewest) return null;
        const plan = planFor(fewest.s, fewest.trills, true);
        // from the longest prefix of that plan known to fall short
        const short = [...plan.analysed.values()].filter((x) => x.steps < fewest.steps && !reaches(x)).map((x) => x.steps + 1);
        let [a, b] = [Math.max(0, ...short), fewest.steps]; // b reaches it
        for (let k = 0; k < SHORTEST_STEPS && a < b; k += 1) {
            const m = (a + b) >> 1;
            const got = await evaluateSteps(plan, m, { s: fewest.s, trills: fewest.trills, stage: "jacks" });
            if (reaches(got)) b = m;
            else a = m + 1;
        }
        return [...plan.analysed.values()].filter(keeps).sort((x, y) => x.steps - y.steps)[0] ?? fewest;
    };
    const outside = (a) => missBy(a?.numeric, range);
    const reach = async (stage, loose) => {
        let trills = runs.length > 0;
        [below, above] = [false, false];
        const search = (s) => searchRange({ evaluate: (knob, s2) => evaluate(knob, s2, trills, stage, loose), lo, hi, min: thinner ? -1 : 0, max: thinner ? 0 : 1, seed: s, score });
        let { best, inRange } = await search(seed);
        if (!inRange && below && above) {
            // the dan a whole trill step at a time takes can step over a narrow range: once more with other layouts
            const again = await search(seed + RETRY_SEED);
            if (again.inRange || outside(again.best) < outside(best)) ({ best, inRange } = again);
        }
        if (!inRange && trills) {
            // out of reach while the trills stay trills: the plan that treats their notes like any other, if it gets
            // into the range or really closer; missing it either way by about as much (less than half a dan apart),
            // the one that kept the original's pattern mix better (a tie keeps the trills)
            trills = false;
            const plain = await search(seed);
            const [p, k] = [outside(plain.best), outside(best)];
            if (plain.inRange || p <= k - PLAIN_MARGIN + 1e-9 || (p < k + PLAIN_MARGIN - 1e-9 && mixOf(plain.best) > mixOf(best) + 1e-9)) ({ best, inRange } = plain);
        }
        return { best, inRange };
    };
    let { best, inRange } = await reach("clean", jacks);
    if (best?.result?.kind !== "ok") throw new Error(t("gen.remap.noDan", { message: best?.result?.message ?? best?.result?.kind ?? "?" }));
    const unchanged = (a) => !a.built.removed && !a.built.added && !a.built.moved;
    let jacksWouldHelp = false;
    const first = planFor(seed, runs.length > 0, true);
    const stopped = (view) => view.skip.size > 0 || !tidy(view, view.plan.clean);
    if (!inRange && (first.clean < first.order.length || stopped(viewOf(first)))) {
        // out of reach without them: the changes that make them too, the clean ones the whole-map check stopped
        // included (without allowJacks only to say whether it would have helped: the app says so with what it got)
        const loose = await reach("jacks", true);
        const better = loose.best?.result?.kind === "ok" && (loose.inRange || outside(loose.best) <= outside(best) - PLAIN_MARGIN + 1e-9);
        if (better && jacks) ({ best, inRange } = loose.inRange ? { best: (await shortest()) ?? loose.best, inRange: true } : loose);
        jacksWouldHelp = better && !jacks && !unchanged(loose.best);
    }
    return finish(best.built.osuText, best.result, { reachable: inRange, removed: best.built.removed, added: best.built.added, moved: best.built.moved, jacksWouldHelp });
}
