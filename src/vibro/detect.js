// Vibro: jacks so fast and kept up so long that players stop jacking them with their fingers and tense the arm to
// "vibrate" the keys instead. A map full of it gets a high dan from every calculator (they read it as extreme
// jackspeed / dense chordjack), but a pass of it says little about the player's jacks, so the local profile leaves such
// plays out of the dans (src/localProfile/model.js) and the card marks the map.
//
// What counts, at the rate played (a map at 1.3x is 1.3x faster): the chart's rows (notes within ROW_MS), a link
// between two rows that follow each other within GAP_MS and share a column, a run of linked rows. A run is vibro when
// it is at least MIN_ROWS long and at least MIN_REPEAT of its notes repeat a column of the row before (single-key and
// jumpjack vibro, a chord hammered again and again; a chordjack's chords move, so far fewer of its notes repeat). A map
// is vibro when at least MIN_SHARE of its notes are in vibro runs.
//
// The numbers were fitted on 8361 4K maps (docs/local-profile.md "Vibro"): 45 of the 49 maps of vibro packs flagged,
// 5 of 390 dan-course and jack-practice maps (all Zeta-level dense chordjack), no map of a typical dan player's
// played set at the rates played (normal chordjack at 1/4 150 BPM included). Pure, O(notes); nothing here is part of
// the analysis (src/core/analyzerVersion.js never reaches this file), so its answers are not in the result cache.

export const VIBRO = Object.freeze({
    VERSION: 1, // bumped when an answer changes: a stored answer of another version is worked out again
    ROW_MS: 2, // notes this close are one row (the analysis reads rows the same way)
    GAP_MS: 95, // a link: the next row within this many real ms (1/4 at 158 BPM and faster, over 10 hits a second)
    MIN_ROWS: 8, // a run of at least this many linked rows …
    MIN_REPEAT: 0.78, // … where at least this share of the notes after its first row repeat a column of the row before
    MIN_SHARE: 0.1, // a vibro map: at least this share of its notes in such runs
    MIN_NOTES: 150, // a shorter chart is not judged
    MAX_RUNS: 40, // the runs an answer lists (the longest ones, in time order)
});

const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
const round = (x, k = 1000) => Math.round(x * k) / k;
const columns = (mask) => [0, 1, 2, 3].filter((c) => mask & (1 << c));

// "[General] Mode: 3" and "[Difficulty] CircleSize: 4", else null; the rows of a 4K mania chart in chart ms.
export function vibroRows(osuText) {
    if (typeof osuText !== "string") return null;
    const mode = Number(/^\s*Mode\s*:\s*(\d+)/m.exec(osuText)?.[1] ?? 0);
    const keys = Number(/^\s*CircleSize\s*:\s*([\d.]+)/m.exec(osuText)?.[1]);
    if (mode !== 3 || keys !== 4) return null;
    const head = /^[ \t]*\[HitObjects\][ \t]*$/m.exec(osuText);
    if (!head) return null;
    const notes = [];
    for (const line of osuText.slice(head.index + head[0].length).split(/\r?\n/)) {
        if (/^[ \t]*\[/.test(line)) break;
        const p = line.split(",");
        if (p.length < 4) continue;
        const x = Number(p[0]);
        const t = Number(p[2]);
        if (!Number.isFinite(x) || !Number.isFinite(t)) continue;
        notes.push({ t, col: Math.min(3, Math.max(0, Math.floor((x * 4) / 512))) });
    }
    notes.sort((a, b) => a.t - b.t);
    const rows = [];
    for (const { t, col } of notes) {
        const last = rows.at(-1);
        if (last && t - last.t <= VIBRO.ROW_MS) last.mask |= 1 << col;
        else rows.push({ t, mask: 1 << col });
    }
    return rows;
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// How sure the verdict is, from how far the share is from the line: "high" | "medium" | "low".
function confidenceOf(share, vibro, m) {
    const ratio = share / m.MIN_SHARE;
    if (vibro) return ratio >= 2.5 ? "high" : ratio >= 1.5 ? "medium" : "low";
    return ratio <= 0.3 ? "high" : ratio <= 0.6 ? "medium" : "low";
}

// Rows [{ t (chart ms), mask }] at a rate → { v, judged, vibro, share, timeShare, notes, vibroNotes, longestRows,
// peakGapMs, confidence, runs: [{ startMs, endMs, cols, gapMs, rows, notes, repeat }] } (times in real ms from the
// chart's start, at the rate). judged false: too few notes, never vibro.
export function detectVibroRows(rows, rate = 1, m = VIBRO) {
    const r = Number(rate) > 0 ? Number(rate) : 1;
    const list = Array.isArray(rows) ? rows : [];
    const notes = list.reduce((s, x) => s + popcount(x.mask), 0);
    const base = { v: m.VERSION, notes };
    if (notes < m.MIN_NOTES) {
        return { ...base, judged: false, vibro: false, share: 0, timeShare: 0, vibroNotes: 0, longestRows: 0, peakGapMs: null, confidence: "high", runs: [] };
    }
    const t0 = list[0].t / r;
    const runs = [];
    let cur = null;
    const close = () => {
        if (!cur || cur.rows < m.MIN_ROWS || cur.repeated < m.MIN_REPEAT * cur.later) return;
        runs.push({
            startMs: Math.round(cur.start - t0), endMs: Math.round(cur.end - t0), cols: columns(cur.mask),
            gapMs: round(median(cur.gaps), 10), rows: cur.rows, notes: cur.notes, repeat: round(cur.repeated / cur.later),
        });
    };
    for (let i = 0; i < list.length; i += 1) {
        const t = list[i].t / r;
        const mask = list[i].mask;
        const prev = i > 0 ? list[i - 1] : null;
        if (cur && t - prev.t / r <= m.GAP_MS && (mask & prev.mask)) {
            cur.rows += 1;
            cur.notes += popcount(mask);
            cur.later += popcount(mask);
            cur.repeated += popcount(mask & prev.mask);
            cur.gaps.push(t - prev.t / r);
            cur.mask |= mask;
            cur.end = t;
        } else {
            close();
            cur = { start: t, end: t, rows: 1, notes: popcount(mask), later: 0, repeated: 0, gaps: [], mask };
        }
    }
    close();
    const vibroNotes = runs.reduce((s, x) => s + x.notes, 0);
    const span = list.at(-1).t / r - t0;
    const share = round(vibroNotes / notes);
    const vibro = share >= m.MIN_SHARE;
    const kept = [...runs].sort((a, b) => b.rows - a.rows || a.startMs - b.startMs).slice(0, m.MAX_RUNS).sort((a, b) => a.startMs - b.startMs);
    return {
        ...base,
        judged: true,
        vibro,
        share,
        timeShare: span > 0 ? round(runs.reduce((s, x) => s + (x.endMs - x.startMs), 0) / span) : 0,
        vibroNotes,
        longestRows: runs.reduce((s, x) => Math.max(s, x.rows), 0),
        peakGapMs: runs.length ? Math.min(...runs.map((x) => x.gapMs)) : null,
        confidence: confidenceOf(share, vibro, m),
        runs: kept,
    };
}

// A .osu text at a rate → detectVibroRows' answer, or null for anything but a 4K mania chart.
export function detectVibro(osuText, rate = 1, m = VIBRO) {
    const rows = vibroRows(osuText);
    return rows ? detectVibroRows(rows, rate, m) : null;
}

// What is kept of an answer beside a map (the local profile's maps.json, the overlay, the card's view):
// { v, vibro, share, longestRows, peakGapMs, confidence }, or null for anything else.
export function vibroSummary(x) {
    if (!x || typeof x !== "object" || !Number.isInteger(x.v) || typeof x.vibro !== "boolean") return null;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const share = num(x.share);
    if (share === null || share < 0 || share > 1) return null;
    return {
        v: x.v,
        vibro: x.vibro,
        share: round(share),
        longestRows: Math.max(0, Math.round(num(x.longestRows) ?? 0)),
        peakGapMs: num(x.peakGapMs) === null ? null : round(x.peakGapMs, 10),
        confidence: ["high", "medium", "low"].includes(x.confidence) ? x.confidence : "low",
    };
}

// Whether a kept summary is this version's answer (an older one is worked out again when the map's text is at hand).
export const vibroCurrent = (x, m = VIBRO) => Boolean(x && x.v === m.VERSION && typeof x.vibro === "boolean");

// A play's real speed of its fastest vibro run in hits per second per key (1000 / gap), for the words; null without.
export const vibroRate = (x) => (Number.isFinite(x?.peakGapMs) && x.peakGapMs > 0 ? Math.round(1000 / x.peakGapMs) : null);
