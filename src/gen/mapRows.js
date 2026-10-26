// Reading the notes of real maps for training: rows, their slot labels, each beat's grid and the pattern family of
// each section.

export const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];

const ROW_MERGE_MS = 2;
const SNAP_MS = 12;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));

// Hit objects → rows [{ t, mask }] (LN heads count as notes; columns from x like osu! does).
export function parseRows(osuText, keys = 4) {
    const lines = osuText.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "[HitObjects]");
    if (start < 0) return [];
    const notes = [];
    for (let i = start + 1; i < lines.length; i += 1) {
        const p = lines[i].split(",");
        if (p.length < 3) continue;
        const col = Math.min(keys - 1, Math.max(0, Math.floor((Number(p[0]) * keys) / 512)));
        const t = Number(p[2]);
        if (Number.isFinite(t)) notes.push({ t, col });
    }
    notes.sort((a, b) => a.t - b.t);
    const rows = [];
    for (const { t, col } of notes) {
        const last = rows.at(-1);
        if (last && t - last.t <= ROW_MERGE_MS) last.mask |= 1 << col;
        else rows.push({ t, mask: 1 << col });
    }
    return rows;
}

// How far a row may sit from a grid line and still be on it: a third of the line spacing, at most 12 ms
// (the same 12 ms as always on 1/4 grids up to 416 BPM).
const snapTolerance = (stepMs) => Math.min(SNAP_MS, stepMs / 3);

function slotStep(slots, j) {
    const s = slots[j];
    if (s.beatMs && s.div) return s.beatMs / s.div;
    if (s.bpm) return 60000 / s.bpm / 4;
    const gaps = [j > 0 ? s.t - slots[j - 1].t : Infinity, j + 1 < slots.length ? slots[j + 1].t - s.t : Infinity];
    return Math.min(...gaps);
}

// Per slot: was there a row (note), which columns (mask). Rows farther than the snap tolerance from every slot are off-grid.
export function labelSlots(rows, slots) {
    const note = new Uint8Array(slots.length);
    const mask = new Uint8Array(slots.length);
    let offgrid = 0;
    let j = 0;
    for (const row of rows) {
        while (j + 1 < slots.length && Math.abs(slots[j + 1].t - row.t) <= Math.abs(slots[j].t - row.t)) j += 1;
        if (slots.length && Math.abs(slots[j].t - row.t) <= snapTolerance(slotStep(slots, j))) {
            note[j] = 1;
            mask[j] |= row.mask;
        } else {
            offgrid += 1;
        }
    }
    return { note, mask, offgrid };
}

export const SNAP_ORDER = [4, 3, 6, 8];

// Per beat (beatsFromTiming): the first grid of 4, 3, 6, 8 (in that order, among `allowed`) that holds every row of
// the beat within the snap tolerance; 0 = no allowed grid does (1/12, 1/16, unsnapped). A beat without rows is 4.
// A row up to the 1/8 tolerance before a beat belongs to that beat (a slightly early downbeat).
export function labelBeatSnaps(rows, beats, allowed = SNAP_ORDER) {
    const order = SNAP_ORDER.filter((d) => allowed.includes(d));
    const out = new Uint8Array(beats.length);
    let r = 0;
    for (let b = 0; b < beats.length; b += 1) {
        const { t: start, beatMs } = beats[b];
        const early = snapTolerance(beatMs / 8);
        const end = b + 1 < beats.length ? Math.min(beats[b + 1].t, start + beatMs) : start + beatMs;
        while (r < rows.length && rows[r].t < start - early) r += 1;
        const mine = [];
        for (let k = r; k < rows.length && rows[k].t < end - early; k += 1) mine.push(rows[k].t - start);
        const fits = (div) => {
            const step = beatMs / div;
            const tol = snapTolerance(step);
            return mine.every((x) => Math.abs(x - Math.round(x / step) * step) <= tol);
        };
        out[b] = order.find(fits) ?? 0;
    }
    return out;
}

// Pattern family of a stretch of rows, from their shapes (same names the generator offers).
export function sectionFamily(rows, offgridShare) {
    if (!rows.length) return null;
    if (offgridShare > 0.25) return "Tech";
    let jacks = 0;
    let size = 0;
    let two = 0;
    let three = 0;
    rows.forEach((r, i) => {
        const n = popcount(r.mask);
        size += n;
        if (n >= 2) two += 1;
        if (n >= 3) three += 1;
        if (i > 0 && (r.mask & rows[i - 1].mask) !== 0) jacks += 1;
    });
    const count = rows.length;
    const jackRatio = jacks / Math.max(1, count - 1);
    if (jackRatio >= 0.35) return size / count >= 1.8 ? "Chordjack" : "Jack";
    if (three / count >= 0.25) return "Handstream";
    if (two / count >= 0.3) return "Jumpstream";
    return "Stream";
}
