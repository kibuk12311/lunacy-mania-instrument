// Our own detector of the flavours (src/gen/flavours.js): for each flavour, which rows of a map are part of its motif.
// The finder-named flavours use the finder's own rules (patternsDef.js SPECIFIC_4K: rolls, trills, minitrills,
// jumptrills, split trills, quadstream, minijacks, longjacks, gluts) on the same rows; the others have rules of their
// own. One detector serves the range search (how much of each planned flavour came out), the eval, and the analysis
// tab's detailed view. Rows: [{ t, mask }] (or { cols }) sorted by time; a gap of more than GAP_BEATS × the map's usual
// row step (at least MIN_GAP_MS) breaks every motif.
import { FLAVOUR_IDS, direction } from "./flavours.js";

const MIN_GAP_MS = 250;
const GAP_STEPS = 2.6;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const maskOf = (r) => (typeof r === "number" ? r : r.mask ?? (r.cols ?? []).reduce((m, c) => m | (1 << c), 0));
const isHand = (m) => popcount(m) === 3;
const comp = (m) => 15 & ~m;
const lowCol = (m) => 31 - Math.clz32(m & -m);
const highCol = (m) => 31 - Math.clz32(m);
const isRoll = (a, b) => lowCol(a) > highCol(b) || highCol(a) < lowCol(b);

// Chains of rows without a long gap: [from, to) index ranges.
function chains(rows) {
    if (!rows.length) return [];
    const gaps = [];
    for (let i = 1; i < rows.length; i += 1) gaps.push(rows[i].t - rows[i - 1].t);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const limit = Math.max(MIN_GAP_MS, GAP_STEPS * median);
    const out = [];
    let from = 0;
    for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].t - rows[i - 1].t > limit) {
            out.push([from, i]);
            from = i;
        }
    }
    out.push([from, rows.length]);
    return out;
}

// ---- the detectors: (masks of one chain) → Uint8Array marks ----
// the finder's stream (CORE_STREAM): five single rows without jacks, the 1st and the 5th on different columns
// (the end of a chain counts as different)
function streamCore(m, i) {
    const end = Math.min(m.length - 1, i + 4);
    if (!allSingles(m, i, end) || !jackless(m, i, end)) return false;
    return i + 4 >= m.length || m[i] !== m[i + 4];
}
const jackless = (m, from, to) => {
    for (let k = from + 1; k <= to; k += 1) if (m[k] & m[k - 1]) return false;
    return true;
};
const allSingles = (m, from, to) => {
    for (let k = from; k <= to; k += 1) if (popcount(m[k]) !== 1) return false;
    return true;
};
function markWindows(m, size, test) {
    const marks = new Uint8Array(m.length);
    for (let i = 0; i + size <= m.length; i += 1) if (test(i)) marks.fill(1, i, i + size);
    return marks;
}

const DETECTORS = {
    // the finder's roll: three single rows in a row moving the same way (in 4K a whole sweep, 4 notes)
    Rolls: (m) => markWindows(m, 4, (i) => allSingles(m, i, i + 3) && jackless(m, i, i + 3)
        && direction(m[i], m[i + 1]) !== 0 && direction(m[i], m[i + 1]) === direction(m[i + 1], m[i + 2])
        && direction(m[i + 1], m[i + 2]) === direction(m[i + 2], m[i + 3]) && streamCore(m, i)),
    // the finder's trill and minitrill, inside its stream: five singles without jacks whose 1st and 5th notes differ
    Trills: (m) => markWindows(m, 4, (i) => allSingles(m, i, i + 3) && jackless(m, i, i + 3) && m[i] === m[i + 2] && m[i + 1] === m[i + 3]
        && streamCore(m, i)),
    Minitrills: (m) => markWindows(m, 3, (i) => allSingles(m, i, i + 2) && jackless(m, i, i + 2) && m[i] === m[i + 2]
        && (i + 3 >= m.length || m[i + 3] !== m[i + 1]) && streamCore(m, i)),
    // one column on every other row of six singles, the notes between it each on another column than the one before
    // (a x a y a z; trills that keep a note have pairs there instead: a x a x)
    RunningMan: (m) => markWindows(m, 6, (i) => {
        if (!allSingles(m, i, i + 5) || !jackless(m, i, i + 5)) return false;
        for (const o of [0, 1]) {
            const a = m[i + o];
            const between = [m[i + 1 - o], m[i + 3 - o], m[i + 5 - o]].filter((x) => x !== undefined);
            if (m[i + o + 2] === a && m[i + o + 4] === a && between.every((x, k) => k === 0 || x !== between[k - 1])) return true;
        }
        return false;
    }),
    // the finder's jumptrill: four jumps, each rolling off the one before ([01] ↔ [23] in 4K)
    Jumptrill: (m) => markWindows(m, 4, (i) => {
        for (let k = i; k < i + 4; k += 1) if (popcount(m[k]) !== 2 || (k > i && !isRoll(m[k - 1], m[k]))) return false;
        return true;
    }),
    // the finder's split trill: three jumps without jacks, none rolling off the one before
    SplitTrill: (m) => markWindows(m, 3, (i) => {
        for (let k = i; k < i + 3; k += 1) if (popcount(m[k]) !== 2 || (k > i && (m[k] & m[k - 1] || isRoll(m[k - 1], m[k])))) return false;
        return true;
    }),
    // 12 rows of singles and jumps without jacks, a quarter of them jumps, one column on ≥45% of the rows and
    // ≥1.5× as often as the others on average
    Anchor: (m) => markWindows(m, 12, (i) => {
        if (!jackless(m, i, i + 11)) return false;
        const cols = [0, 0, 0, 0];
        let jumps = 0;
        for (let k = i; k < i + 12; k += 1) {
            const n = popcount(m[k]);
            if (n > 2) return false;
            if (n === 2) jumps += 1;
            for (let c = 0; c < 4; c += 1) if (m[k] & (1 << c)) cols[c] += 1;
        }
        if (jumps < 3) return false;
        const top = Math.max(...cols);
        const rest = (cols.reduce((a, b) => a + b, 0) - top) / 3;
        return top >= 0.45 * 12 && top >= 1.5 * rest;
    }),
    // three rows of at most two notes moving the same way twice, no jacks, a jump among them
    Dumpstream: (m) => markWindows(m, 3, (i) => {
        if (!jackless(m, i, i + 2)) return false;
        if ([m[i], m[i + 1], m[i + 2]].some((x) => popcount(x) > 2) || ![m[i], m[i + 1], m[i + 2]].some((x) => popcount(x) === 2)) return false;
        const d = direction(m[i], m[i + 1]);
        return d !== 0 && d === direction(m[i + 1], m[i + 2]);
    }),
    // a hand and the single left over, in turns, four rows
    ChordTrills: (m) => markWindows(m, 4, (i) => {
        for (let k = i + 1; k < i + 4; k += 1) if ((m[k] | m[k - 1]) !== 15 || m[k] & m[k - 1] || !(isHand(m[k]) || isHand(m[k - 1]))) return false;
        return true;
    }),
    // hand, single, single, hand without jacks
    DenseHandstream: (m) => markWindows(m, 4, (i) => isHand(m[i]) && popcount(m[i + 1]) === 1 && popcount(m[i + 2]) === 1 && isHand(m[i + 3])
        && jackless(m, i, i + 3)),
    // hand, single, jump, single (or jump, single, hand, single) without jacks
    JumpyHandstream: (m) => markWindows(m, 4, (i) => popcount(m[i + 1]) === 1 && popcount(m[i + 3]) === 1 && jackless(m, i, i + 3)
        && ((isHand(m[i]) && popcount(m[i + 2]) === 2) || (popcount(m[i]) === 2 && isHand(m[i + 2])))),
    // three hands in a row, each keeping two columns of the one before
    Handjack: (m) => markWindows(m, 3, (i) => isHand(m[i]) && isHand(m[i + 1]) && isHand(m[i + 2])
        && popcount(m[i] & m[i + 1]) >= 2 && popcount(m[i + 1] & m[i + 2]) >= 2),
    // two jumps each played twice, back to back
    Jumpjack: (m) => markWindows(m, 4, (i) => popcount(m[i]) === 2 && m[i + 1] === m[i] && popcount(m[i + 2]) === 2 && m[i + 3] === m[i + 2] && m[i + 2] !== m[i]),
    // four rows of three or four notes with a quad and a hand among them
    Quadhand: (m) => markWindows(m, 4, (i) => {
        const rows = [m[i], m[i + 1], m[i + 2], m[i + 3]];
        return rows.every((x) => popcount(x) >= 3) && rows.some((x) => x === 15) && rows.some(isHand);
    }),
    // the finder's quadstream: a quad that jacks a chord, then two rows without jacks
    Quadstream: (m) => {
        const marks = new Uint8Array(m.length);
        for (let i = 1; i + 3 < m.length; i += 1) {
            if (m[i] === 15 && popcount(m[i - 1]) >= 2 && !(m[i + 2] & m[i + 1]) && !(m[i + 3] & m[i + 2])) marks.fill(1, i, i + 4);
        }
        return marks;
    },
    // a jump played twice, then a row without a jack that is not played twice itself (that would be a jumpjack)
    Minijacks: (m) => markWindows(m, 3, (i) => popcount(m[i]) === 2 && m[i + 1] === m[i] && !(m[i + 2] & m[i + 1])
        && (i + 3 >= m.length || m[i + 3] !== m[i + 2])),
    // one column on six rows in a row or more, most of those rows light (a chordjack keeps columns too, but in
    // three- and four-note rows)
    Longjacks: (m) => {
        const marks = new Uint8Array(m.length);
        for (let c = 0; c < 4; c += 1) {
            let from = -1;
            for (let k = 0; k <= m.length; k += 1) {
                const has = k < m.length && m[k] & (1 << c);
                if (has && from < 0) from = k;
                if (!has && from >= 0) {
                    const light = m.slice(from, k).filter((x) => popcount(x) <= 2).length;
                    if (k - from >= 6 && light >= 0.6 * (k - from)) marks.fill(1, from, k);
                    from = -1;
                }
            }
        }
        return marks;
    },
    // the finder's gluts: three chords, each keeping exactly one column of the one before, no column in all three
    Gluts: (m) => markWindows(m, 3, (i) => popcount(m[i]) >= 2 && popcount(m[i + 1]) >= 2 && popcount(m[i + 2]) >= 2
        && popcount(m[i] & m[i + 1]) === 1 && popcount(m[i + 1] & m[i + 2]) === 1 && !(m[i] & m[i + 1] & m[i + 2])),
    // single-column jacks of 2–4 notes, the next one starting at most two rows later
    Speedjacks: (m) => {
        const runs = [];
        for (let k = 0; k < m.length;) {
            let e = k + 1;
            while (e < m.length && m[e] === m[k]) e += 1;
            if (popcount(m[k]) === 1 && e - k >= 2 && e - k <= 4) runs.push([k, e]);
            k = e;
        }
        const marks = new Uint8Array(m.length);
        for (let j = 0; j + 1 < runs.length; j += 1) {
            if (runs[j + 1][0] - runs[j][1] <= 2) {
                marks.fill(1, runs[j][0], runs[j][1]);
                marks.fill(1, runs[j + 1][0], runs[j + 1][1]);
            }
        }
        return marks;
    },
    // eight rows taking turns between the hands: one hand trills its two columns on every other row, the other hand
    // plays a line of its own in between (not a trill: it repeats a column somewhere)
    Coordination: (m) => markWindows(m, 8, (i) => {
        const rows = m.slice(i, i + 8);
        for (const [trill, line] of [[3, 12], [12, 3]]) {
            for (const o of [0, 1]) {
                const tn = [0, 2, 4, 6].map((k) => rows[k + o]);
                const ln = [1, 3, 5, 7].map((k) => rows[k - o]).filter((x) => x !== undefined);
                if (ln.length < 4 || tn.some((x) => x === undefined)) continue;
                if (!tn.every((x) => popcount(x) === 1 && x & trill) || !ln.every((x) => popcount(x) === 1 && x & line)) continue;
                if (tn[0] !== tn[2] || tn[1] !== tn[3] || tn[0] === tn[1]) continue;
                if (ln.some((x, k) => k > 0 && x === ln[k - 1])) return true;
            }
        }
        return false;
    }),
    // eight singles with one or two two-note jacks and no longer ones
    JackyStream: (m) => markWindows(m, 8, (i) => {
        if (!allSingles(m, i, i + 7)) return false;
        let jacks = 0;
        for (let k = i + 1; k < i + 8; k += 1) {
            if (m[k] === m[k - 1]) {
                jacks += 1;
                if (k >= i + 2 && m[k - 2] === m[k]) return false;
            }
        }
        return jacks >= 1 && jacks <= 2;
    }),
};

// rows → { [flavour]: Uint8Array marks (1 = the row is part of that motif) }; only = a list of flavours to check.
export function flavourMarks(rowsIn, only = FLAVOUR_IDS) {
    const rows = [...rowsIn].sort((a, b) => a.t - b.t);
    const masks = rows.map(maskOf);
    const out = {};
    for (const id of only) out[id] = new Uint8Array(rows.length);
    for (const [from, to] of chains(rows)) {
        const part = masks.slice(from, to);
        for (const id of only) {
            const marks = DETECTORS[id]?.(part);
            if (marks) out[id].set(marks, from);
        }
    }
    return { rows, marks: out };
}

// Share of the map's rows inside each flavour's motif: [{ id, share }], largest first (shares overlap).
export function flavourShares(rowsIn, only = FLAVOUR_IDS) {
    const { rows, marks } = flavourMarks(rowsIn, only);
    if (!rows.length) return [];
    return only.map((id) => ({ id, share: marks[id].reduce((a, b) => a + b, 0) / rows.length }))
        .sort((a, b) => b.share - a.share || FLAVOUR_IDS.indexOf(a.id) - FLAVOUR_IDS.indexOf(b.id));
}

// The same as a lookup: { [flavour]: share of the map's rows in its motif } for every flavour (or `only`); {} for no rows.
export const flavourCoverage = (rows, only = FLAVOUR_IDS) => Object.fromEntries(flavourShares(rows, only).map((f) => [f.id, f.share]));

// How well rows that were planned as a flavour (row.flavour) show it: { score 0..1, rows (planned), byFlavour:
// { [id]: { rows, hit } } }, or null when no row was planned with a flavour.
export function plannedFlavourScore(rowsIn) {
    const planned = new Set(rowsIn.map((r) => r.flavour).filter(Boolean));
    if (!planned.size) return null;
    const { rows, marks } = flavourMarks(rowsIn, [...planned]);
    const byFlavour = {};
    let total = 0;
    let hits = 0;
    rows.forEach((r, k) => {
        if (!r.flavour) return;
        const entry = (byFlavour[r.flavour] ??= { rows: 0, hit: 0 });
        entry.rows += 1;
        total += 1;
        if (marks[r.flavour][k]) {
            entry.hit += 1;
            hits += 1;
        }
    });
    return { score: total ? hits / total : 0, rows: total, byFlavour };
}

const SHOWN_FLAVOURS = 5;
const round3 = (x) => Math.round(x * 1000) / 1000;
// The flavours found in a map's rows, for the detailed view: [{ id, share }], the largest SHOWN_FLAVOURS, none at 0.
export const detectedFlavours = (rows, max = SHOWN_FLAVOURS) => flavourShares(rows).filter((f) => f.share > 0).slice(0, max)
    .map((f) => ({ id: f.id, share: round3(f.share) }));
