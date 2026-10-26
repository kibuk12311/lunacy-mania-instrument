// Pure parts of the dataset v3 builder (tools/build-mapper-dataset.mjs --format v3): the grid and its labels for one
// chart, the filters of addendum §3.2, the §3.4 label vectors, the §3.5 split and the held-out list. No I/O here, so
// tests/tools/dataset3.test.js can check every rule on synthetic charts.
import { crc32 } from "node:zlib";
import { beatsFromTiming, slotsForBeats } from "../../src/gen/grid.js";
import { labelSlots, labelBeatSnaps, sectionFamily, FAMILIES, SNAP_ORDER } from "../../src/gen/mapRows.js";

// MSD vectors are stored in this order everywhere in mapper3 (analyzeChart's `msd` keys, src/core/features.js).
export const MSD8 = ["overall", "stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"];
const TRACKER_NAMES = { overall: "Overall", stream: "Stream", jumpstream: "Jumpstream", handstream: "Handstream", stamina: "Stamina", jackspeed: "JackSpeed", chordjack: "Chordjack", technical: "Technical" };

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const vec = (get) => {
    const v = MSD8.map((k) => r2(get(k)));
    return v.some((x) => x !== null) ? v : null;
};
export const msdOursVector = (msd) => (msd ? vec((k) => msd[k]) : null);
export const msdTrackerVector = (msd) => (msd ? vec((k) => msd[TRACKER_NAMES[k]]) : null);
// Etterna pack manifests carry the overall MSD only: [overall, null × 7].
export const msdEtternaVector = (overall) => (Number.isFinite(overall) ? [r2(overall), ...Array(MSD8.length - 1).fill(null)] : null);

// Red lines faster than this or slower than that inside the played part mark a gimmick chart (BPM up to 6,000,000 in
// v1.5 gave inf slot_ms and millions of slots); the whole chart is dropped.
export const BPM_RANGE = Object.freeze({ min: 20, max: 1000 });
export const FILTERS = Object.freeze({ minRows: 100, maxResidualOffgrid: 0.2, maxOffBeatShare: 0.1, leadMs: 2000, maxSlotsPerSec: 80 });

// The reject reason of a chart's red lines over [fromMs, toMs] (the lines in force there), or null.
export function timingReject(points, fromMs, toMs) {
    if (!points.length) return "no timing";
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const until = i + 1 < points.length ? points[i + 1].time : Infinity;
        if (until <= fromMs || p.time > toMs) continue;
        const bpm = 60000 / p.beatLength;
        if (!Number.isFinite(bpm) || bpm < BPM_RANGE.min || bpm > BPM_RANGE.max) return "absurd BPM";
    }
    return null;
}

export function allFinite(values) {
    for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
    return true;
}

const snapTolerance = (stepMs) => Math.min(12, stepMs / 3); // as in src/gen/mapRows.js
const fitsGrid = (x, beatMs, d) => {
    const step = beatMs / d;
    return Math.abs(x - Math.round(x / step) * step) <= snapTolerance(step);
};

// Per beat (the windows of labelBeatSnaps): the grid its slots are cut on — its label, or for a beat no single grid
// holds (label 0: 1/4 and 1/3 rows mixed in one beat, 1/12, 1/16) the grid holding most of its rows — and the number
// of rows on none of the 4, 3, 6, 8 grids at all.
function beatGrids(rows, beats, divs) {
    const slotDiv = Uint8Array.from(divs, (d) => d || 4);
    let offGrid = 0;
    let r = 0;
    for (let b = 0; b < beats.length; b++) {
        const { t: start, beatMs } = beats[b];
        const early = snapTolerance(beatMs / 8);
        const end = b + 1 < beats.length ? Math.min(beats[b + 1].t, start + beatMs) : start + beatMs;
        while (r < rows.length && rows[r].t < start - early) r++;
        const mine = [];
        for (let k = r; k < rows.length && rows[k].t < end - early; k++) mine.push(rows[k].t - start);
        for (const x of mine) if (!SNAP_ORDER.some((d) => fitsGrid(x, beatMs, d))) offGrid++;
        if (divs[b] === 0 && mine.length) {
            let best = 4;
            let bestN = -1;
            for (const d of SNAP_ORDER) {
                const n = mine.filter((x) => fitsGrid(x, beatMs, d)).length;
                if (n > bestN) { best = d; bestN = n; }
            }
            slotDiv[b] = best;
        }
    }
    return { slotDiv, offGrid };
}

// The grid of one chart and its labels (D2 / snap-v2): every beat gets the smallest grid of 4, 3, 6, 8 that holds its
// rows (labelBeatSnaps; 0 = none does, then its slots are cut on the grid holding most of its rows), slots are built on
// those grids, rows are matched to slots, and each 8-beat section gets a pattern family. Beats start 2 s before the
// first row. Dropped: under 100 rows, gimmick BPMs, more than 10% of rows on none of the 4, 3, 6, 8 grids (1/12 and
// 1/16 dumps, unsnapped charts), more than 20% of rows left off the slots (residualOffgrid).
// → { reject } or { beats, divs, slots, note, mask, family, slotDiv, beatSlot0, residualOffgrid, offBeatShare, divShare }
export function gridLabels(rows, points, endMs, { leadMs = FILTERS.leadMs } = {}) {
    if (rows.length < FILTERS.minRows) return { reject: "under 100 rows" };
    const why = timingReject(points, rows[0].t - leadMs, rows.at(-1).t);
    if (why) return { reject: why };
    const all = beatsFromTiming(points, endMs);
    const from = all.findIndex((b) => b.t + b.beatMs > rows[0].t - leadMs);
    if (from < 0) return { reject: "no beats" };
    const beats = all.slice(from).map((b, i) => ({ ...b, index: i }));
    const divs = labelBeatSnaps(rows, beats, SNAP_ORDER);
    const grids = beatGrids(rows, beats, divs);
    const offBeatShare = grids.offGrid / rows.length;
    if (offBeatShare > FILTERS.maxOffBeatShare) return { reject: "1/12-1/16 dump" };
    const slots = slotsForBeats(beats, (i) => grids.slotDiv[i]);
    const spanSec = (slots.at(-1).t - slots[0].t) / 1000;
    if (slots.length < 64) return { reject: "under 64 slots" };
    if (slots.length > FILTERS.maxSlotsPerSec * Math.max(1, spanSec)) return { reject: "absurd BPM" };
    const { note, mask, offgrid } = labelSlots(rows, slots);
    const residualOffgrid = offgrid / rows.length;
    if (residualOffgrid > FILTERS.maxResidualOffgrid) return { reject: "off the snap grid" };
    const slotDiv = Uint8Array.from(slots, (s) => s.div);
    const beatSlot0 = beatSlotOffsets(slots, beats.length);
    const family = sectionFamilies(rows, slots, note, mask, beatSlot0);
    const divShare = { 4: 0, 3: 0, 6: 0, 8: 0, 0: 0 };
    for (const d of divs) divShare[d]++;
    for (const k of Object.keys(divShare)) divShare[k] = Math.round((divShare[k] / beats.length) * 1e4) / 1e4;
    return { beats, divs, slots, note, mask, family, slotDiv, beatSlot0, residualOffgrid, offBeatShare, divShare };
}

// CSR offsets: the slots of beat b are [o[b], o[b + 1]). Every beat has its first (pos 0) slot, so no beat is empty.
export function beatSlotOffsets(slots, nBeats) {
    const o = new Int32Array(nBeats + 1);
    let b = -1;
    slots.forEach((s, i) => { while (b < s.beat) o[++b] = i; });
    while (b < nBeats) o[++b] = slots.length;
    return o;
}

export const SECTION_BEATS = 8;
// Family index (FAMILIES, 255 = none) of every slot, one per 8-beat section, from the rows that fall into it.
export function sectionFamilies(rows, slots, note, mask, beatSlot0) {
    const nBeats = beatSlot0.length - 1;
    const family = new Uint8Array(slots.length).fill(255);
    let r = 0;
    for (let b0 = 0; b0 < nBeats; b0 += SECTION_BEATS) {
        const a = beatSlot0[b0];
        const e = beatSlot0[Math.min(nBeats, b0 + SECTION_BEATS)];
        if (e <= a) continue;
        const t0 = slots[a].t - 12;
        const t1 = (e < slots.length ? slots[e].t : slots[e - 1].t + 1) - 12;
        while (r < rows.length && rows[r].t < t0) r++;
        let inside = 0;
        for (let k = r; k < rows.length && rows[k].t < t1; k++) inside++;
        const matched = [];
        for (let i = a; i < e; i++) if (note[i]) matched.push({ mask: mask[i] });
        const fam = sectionFamily(matched, inside ? 1 - matched.length / inside : 0);
        if (fam) family.fill(FAMILIES.indexOf(fam), a, e);
    }
    return family;
}

// Column mirror of a 4-key mask (column c → 3 − c): training-time augmentation (addendum §3.6), never stored.
export const mirrorMask = (m) => ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3);

// §3.5 split of a corpus line: the corpus index's sticky, leak-guarded held-out split is "test"; quarantine is left
// out (null); of the rest, crc32(songGroup) % 10 == 1 is "val" and everything else "train" (Python: zlib.crc32 of the
// UTF-8 bytes gives the same number).
export const groupHash = (group) => crc32(Buffer.from(String(group), "utf8"));
export function splitOf(line) {
    if (line.split === "quarantine") return null;
    if (line.split === "heldout") return "test";
    return groupHash(line.group ?? line.songKey) % 10 === 1 ? "val" : "train";
}

// mapper3/heldout.json: every test and val song group with all of its member song keys (duplicates included), and the
// quarantined groups, from the whole corpus (built or not), so a tool can assert that no other dataset trains on them.
export function heldoutList(corpusLines, made = new Date().toISOString()) {
    const by = { test: new Map(), val: new Map(), quarantine: new Map() };
    for (const l of corpusLines) {
        const split = splitOf(l) ?? "quarantine";
        if (split === "train") continue;
        const m = by[split];
        const g = l.group ?? l.songKey;
        if (!m.has(g)) m.set(g, new Set());
        for (const k of [l.songKey, ...(l.duplicates ?? []).map((d) => d.songKey)]) if (k) m.get(g).add(k);
    }
    const list = (m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([group, keys]) => ({ group, songKeys: [...keys].sort() }));
    return {
        v: 1, made,
        rule: "test = corpus split heldout (sticky, leak-guarded); val = crc32(group) % 10 == 1 of the corpus train split; quarantine = never used",
        test: list(by.test), val: list(by.val), quarantine: list(by.quarantine),
    };
}

// Where the files of map `id` live: <outDir>/maps/<first two hex chars>/<id>.<ext>
export const mapBase = (id) => `maps/${id.slice(0, 2)}/${id}`;
