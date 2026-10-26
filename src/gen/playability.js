// Playability: what a row may do given the rows before it (the guard used while generating), and the stats and
// awkward spots of a finished map. Limits are per pattern family: streams never jack a column three times,
// jack patterns may; nothing hits one column faster than a human can. A flavour (src/gen/flavours.js) may loosen a
// few of its family's limits (FLAVOUR_LIMITS: the anchor cap, the hand range, the pull towards even columns).
import { FLAVOUR_LIMITS } from "./flavours.js";

export const LIMITS = {
    Stream: { jack: 2, anchor: 0.5, minJackMs: 65 },
    Jumpstream: { jack: 2, anchor: 0.58, minJackMs: 65 },
    Handstream: { jack: 3, anchor: 0.65, minJackMs: 65 },
    Tech: { jack: 3, anchor: 0.6, minJackMs: 65 },
    Chordjack: { jack: 16, anchor: null, minJackMs: 50 },
    Jack: { jack: 24, anchor: null, minJackMs: 50 },
};
const HAND_RANGE = [0.35, 0.65];
const COLUMN_PULL = 4;
const DEFAULT_LIMITS = { hand: HAND_RANGE, columnPull: COLUMN_PULL };
const limitCache = new Map();
// the limits of a family, with its flavour's exceptions on top
export function limitsOf(family, flavour = null) {
    const key = `${family}|${flavour ?? ""}`;
    let lim = limitCache.get(key);
    if (!lim) {
        lim = { ...DEFAULT_LIMITS, ...(LIMITS[family] ?? LIMITS.Tech), ...(flavour ? FLAVOUR_LIMITS[flavour] : null) };
        limitCache.set(key, lim);
    }
    return lim;
}
const JACK_FAMILIES = new Set(["Chordjack", "Jack"]);
export const STREAMY = new Set(["Stream", "Jumpstream", "Handstream", "Tech"]);

const ANCHOR_ROWS = 16;
const ANCHOR_MIN_ROWS = 8; // the anchor rule starts once the window has this many rows
const HAND_ROWS = 32;
const HAND_MIN_NOTES = 16;
const HAND_PULL = 8;
const COLUMN_ROWS = 64;
const COLUMN_MIN_NOTES = 16;
const SPIKE_MIN = 8;
const SPIKE_RATIO = 2.2;
const SPIKE_SECTION_BEATS = 8;
const COLUMNS_RATIO = 1.3;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const COLS = [0, 1, 2, 3];
const maskOf = (row) => row.mask ?? (row.cols ?? []).reduce((m, c) => m | (1 << c), 0);
const leftOf = (m) => (m & 1) + ((m >> 1) & 1);
const halfBeatOf = (slot) => (slot?.beatMs ?? (slot?.bpm ? 60000 / slot.bpm : 500)) / 2;

// The guard. weight(mask, i, family, ahead, flavour) → 0 (not allowed) or a weight around 1; fallback(i, family, ahead,
// flavour) → a mask that is allowed (a single in the column rested longest), or 0 for no row; push(mask, i, family)
// records a row.
// `ahead` describes fixed rows right after slot i (a kept or locked stretch): { run: [n per column] } counts the
// rows in a row that hold each column, { nextT: [ms per column] } the time of each column's next fixed note.
export function createGuard({ slots }) {
    const rows = []; // every pushed row's mask, oldest first
    const run = [0, 0, 0, 0];
    const lastT = [-Infinity, -Infinity, -Infinity, -Infinity];
    let lastRow = null;
    // running counts over the last ANCHOR_ROWS − 1, HAND_ROWS and COLUMN_ROWS rows
    const anchorCount = [0, 0, 0, 0];
    const columnCount = [0, 0, 0, 0];
    let columnNotes = 0;
    let handLeft = 0;
    let handNotes = 0;
    const guard = { forced: 0 };

    const anchorRows = () => Math.min(rows.length, ANCHOR_ROWS - 1);

    guard.weight = (mask, i, family, ahead = null, flavour = null) => {
        if (!mask) return 0;
        const lim = limitsOf(family, flavour);
        const slot = slots[i];
        const t = slot.t;
        const continues = lastRow && t - lastRow.t <= halfBeatOf(slot);
        for (const c of COLS) {
            if (!(mask & (1 << c))) continue;
            const length = (continues && lastRow.mask & (1 << c) ? run[c] + 1 : 1) + (ahead?.run?.[c] ?? 0);
            if (length > lim.jack) return 0;
            if (t - lastT[c] < lim.minJackMs) return 0;
            if ((ahead?.nextT?.[c] ?? Infinity) - t < lim.minJackMs) return 0;
        }
        const recent = anchorRows();
        if (lim.anchor !== null && recent + 1 >= ANCHOR_MIN_ROWS) {
            for (const c of COLS) if (mask & (1 << c) && (anchorCount[c] + 1) / (recent + 1) > lim.anchor) return 0;
        }
        let w = 1;
        if (!JACK_FAMILIES.has(family) && handNotes >= HAND_MIN_NOTES) {
            const ml = leftOf(mask);
            const mn = popcount(mask);
            const before = handLeft / handNotes;
            const after = (handLeft + ml) / (handNotes + mn);
            const out = after < lim.hand[0] || after > lim.hand[1];
            if (out && Math.abs(after - 0.5) > Math.abs(before - 0.5)) return 0;
            w *= Math.exp(-HAND_PULL * (before - 0.5) * ((ml - (mn - ml)) / mn));
        }
        if (columnNotes >= COLUMN_MIN_NOTES) {
            let over = 0;
            for (const c of COLS) if (mask & (1 << c)) over += columnCount[c] / columnNotes - 0.25;
            w *= Math.exp(-lim.columnPull * over);
        }
        return w;
    };

    guard.fallback = (i, family, ahead = null, flavour = null) => {
        guard.forced += 1;
        const order = [...COLS].sort((a, b) => lastT[a] - lastT[b]);
        for (const c of order) if (guard.weight(1 << c, i, family, ahead, flavour) > 0) return 1 << c;
        return 0;
    };

    const count = (m, sign) => {
        for (const c of COLS) if (m & (1 << c)) columnCount[c] += sign;
        columnNotes += sign * popcount(m);
    };
    guard.push = (mask, i) => {
        if (!mask) return;
        const slot = slots[i];
        const t = slot.t;
        const continues = lastRow && t - lastRow.t <= halfBeatOf(slot);
        for (const c of COLS) {
            if (mask & (1 << c)) {
                run[c] = continues && lastRow.mask & (1 << c) ? run[c] + 1 : 1;
                lastT[c] = t;
            } else {
                run[c] = 0;
            }
        }
        lastRow = { mask, t };
        rows.push(mask);
        const n = rows.length;
        for (const c of COLS) if (mask & (1 << c)) anchorCount[c] += 1;
        if (n > ANCHOR_ROWS - 1) for (const c of COLS) if (rows[n - ANCHOR_ROWS] & (1 << c)) anchorCount[c] -= 1;
        handLeft += leftOf(mask);
        handNotes += popcount(mask);
        if (n > HAND_ROWS) {
            handLeft -= leftOf(rows[n - HAND_ROWS - 1]);
            handNotes -= popcount(rows[n - HAND_ROWS - 1]);
        }
        count(mask, 1);
        if (n > COLUMN_ROWS) count(rows[n - COLUMN_ROWS - 1], -1);
    };
    return guard;
}

// The slot nearest each row (rows and slots sorted by time).
function slotIndexOfRows(rows, slots) {
    const out = new Int32Array(rows.length);
    let j = 0;
    rows.forEach((r, k) => {
        while (j + 1 < slots.length && Math.abs(slots[j + 1].t - r.t) <= Math.abs(slots[j].t - r.t)) j += 1;
        out[k] = j;
    });
    return out;
}

// Runs of one column over consecutive rows (a gap over half a beat ends a run): [{ col, from, to }] row indices.
function columnRuns(rows, slots, at) {
    const runs = [];
    const open = [null, null, null, null];
    rows.forEach((r, k) => {
        const m = maskOf(r);
        const continues = k > 0 && r.t - rows[k - 1].t <= halfBeatOf(slots[at[k]]);
        for (const c of COLS) {
            const has = m & (1 << c);
            if (has && open[c] && continues) open[c].to = k;
            else if (has) {
                if (open[c]) runs.push(open[c]);
                open[c] = { col: c, from: k, to: k };
            } else if (open[c]) {
                runs.push(open[c]);
                open[c] = null;
            }
        }
    });
    for (const o of open) if (o) runs.push(o);
    return runs;
}

const sortRows = (rows) => [...rows].sort((a, b) => a.t - b.t);

// RowStats { notes, rows, sizeShares [1..4 notes], leftShare, colShares, maxJack { all, streamy }, peakNps, forced }.
// `streamy` counts only runs inside Stream, Jumpstream, Handstream and Tech rows (rows carry their `family`).
export function rowStats(rowsIn, slots) {
    const rows = sortRows(rowsIn);
    const sizes = [0, 0, 0, 0];
    const cols = [0, 0, 0, 0];
    let notes = 0;
    for (const r of rows) {
        const m = maskOf(r);
        const n = popcount(m);
        if (!n) continue;
        sizes[n - 1] += 1;
        notes += n;
        for (const c of COLS) if (m & (1 << c)) cols[c] += 1;
    }
    const at = slotIndexOfRows(rows, slots);
    let all = 0;
    let streamy = 0;
    for (const { from, to } of columnRuns(rows, slots, at)) {
        const length = to - from + 1;
        all = Math.max(all, length);
        let inStream = true;
        for (let k = from; k <= to; k += 1) if (!STREAMY.has(rows[k].family)) inStream = false;
        if (inStream) streamy = Math.max(streamy, length);
    }
    let peak = 0;
    let lo = 0;
    let inWindow = 0;
    for (let k = 0; k < rows.length; k += 1) {
        inWindow += popcount(maskOf(rows[k]));
        while (rows[k].t - rows[lo].t >= 1000) inWindow -= popcount(maskOf(rows[lo++]));
        peak = Math.max(peak, inWindow);
    }
    const count = rows.length || 1;
    return {
        notes,
        rows: rows.length,
        sizeShares: sizes.map((s) => s / count),
        leftShare: notes ? (cols[0] + cols[1]) / notes : 0.5,
        colShares: cols.map((c) => (notes ? c / notes : 0.25)),
        maxJack: { all, streamy },
        peakNps: peak,
        forced: rows.filter((r) => r.forced).length,
    };
}

// A row of a planned jack-family flavour (Longjacks, Gluts …: row.flavour on a Chordjack or Jack row) holds its
// columns on purpose, so the streamy rows' limits stop at it: a column run, an anchor window or a hand window of
// streamy rows does not reach into such rows. Without flavours no row is one, and the issues are the old ones.
const ownMotif = (r) => Boolean(r.flavour) && JACK_FAMILIES.has(r.family);

// Awkward spots of a map, sorted by time: jacks longer than the family allows (in streamy patterns), notes in one
// column faster than a human hits them, anchors (one column in too many rows), one hand overloaded, density spikes,
// and columns used unevenly (one issue for the map, t = 0).
export function findIssues(rowsIn, slots) {
    const rows = sortRows(rowsIn);
    if (!rows.length) return [];
    const at = slotIndexOfRows(rows, slots);
    const issues = [];
    for (const { col, from, to: runTo } of columnRuns(rows, slots, at)) {
        const family = rows[from].family;
        if (!STREAMY.has(family) && family !== undefined) continue;
        let to = from;
        while (to < runTo && !ownMotif(rows[to + 1])) to += 1;
        if (to - from + 1 > limitsOf(family, rows[from].flavour).jack) issues.push({ t: rows[from].t, kind: "jack", col, n: to - from + 1 });
    }
    const lastAt = [null, null, null, null];
    const reportedFast = [-Infinity, -Infinity, -Infinity, -Infinity];
    rows.forEach((r) => {
        const m = maskOf(r);
        for (const c of COLS) {
            if (!(m & (1 << c))) continue;
            const prev = lastAt[c];
            if (prev) {
                const ms = r.t - prev.t;
                if (ms < limitsOf(r.family, r.flavour).minJackMs && r.t - reportedFast[c] > 1000) {
                    issues.push({ t: prev.t, kind: "fastJack", col: c, ms: Math.round(ms) });
                    reportedFast[c] = r.t;
                }
            }
            lastAt[c] = r;
        }
    });
    // anchors over 16 rows and hand balance over 32 rows, one issue per stretch; a window holding a jack-family
    // flavour's row (ownMotif) is not judged by the streamy limits
    let anchorUntil = -1;
    let handUntil = -1;
    let lastMotif = -Infinity;
    for (let k = 0; k < rows.length; k += 1) {
        const family = rows[k].family;
        const lim = limitsOf(family, rows[k].flavour);
        if (ownMotif(rows[k])) lastMotif = k;
        if (lim.anchor !== null && k >= ANCHOR_ROWS - 1 && k > anchorUntil && k - lastMotif >= ANCHOR_ROWS) {
            const window = rows.slice(k - ANCHOR_ROWS + 1, k + 1);
            for (const c of COLS) {
                const share = window.filter((r) => maskOf(r) & (1 << c)).length / window.length;
                if (share > lim.anchor) {
                    issues.push({ t: window[0].t, kind: "anchor", col: c, pct: Math.round(share * 100) });
                    anchorUntil = k + ANCHOR_ROWS - 1;
                    break;
                }
            }
        }
        if (!JACK_FAMILIES.has(family) && k >= HAND_ROWS - 1 && k > handUntil && k - lastMotif >= HAND_ROWS) {
            let left = 0;
            let notes = 0;
            for (let j = k - HAND_ROWS + 1; j <= k; j += 1) {
                left += leftOf(maskOf(rows[j]));
                notes += popcount(maskOf(rows[j]));
            }
            const share = notes ? left / notes : 0.5;
            if (share < lim.hand[0] || share > lim.hand[1]) {
                issues.push({ t: rows[k - HAND_ROWS + 1].t, kind: "hand", pct: Math.round(share * 100) });
                handUntil = k + HAND_ROWS - 1;
            }
        }
    }
    // density spikes: a beat with far more notes than its 8-beat section has on average
    const perBeat = new Map();
    rows.forEach((r, k) => {
        const beat = slots[at[k]].beat;
        perBeat.set(beat, (perBeat.get(beat) ?? 0) + popcount(maskOf(r)));
    });
    const sectionSum = new Map();
    for (const [beat, n] of perBeat) {
        const s = Math.floor(beat / SPIKE_SECTION_BEATS);
        sectionSum.set(s, (sectionSum.get(s) ?? 0) + n);
    }
    const beatStart = new Map();
    slots.forEach((s) => { if (!beatStart.has(s.beat)) beatStart.set(s.beat, s.t); });
    for (const [beat, n] of perBeat) {
        const mean = sectionSum.get(Math.floor(beat / SPIKE_SECTION_BEATS)) / SPIKE_SECTION_BEATS;
        if (n > Math.max(SPIKE_MIN, SPIKE_RATIO * mean)) issues.push({ t: beatStart.get(beat), kind: "spike", n });
    }
    const cols = [0, 0, 0, 0];
    for (const r of rows) for (const c of COLS) if (maskOf(r) & (1 << c)) cols[c] += 1;
    const most = Math.max(...cols);
    const least = Math.min(...cols);
    if (most > COLUMNS_RATIO * least) {
        issues.push({ t: 0, kind: "columns", col: cols.indexOf(most), n: most, ...(least > 0 ? { ratio: Math.round((most / least) * 10) / 10 } : {}) });
    }
    return issues.sort((a, b) => a.t - b.t);
}
