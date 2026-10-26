// Per-beat audio features v3 (BEAT_FEATURES_V3, ML addendum §3.3): one row per beat, used by the dataset builder
// (tools/build-mapper-dataset.mjs --features v3, the .b32 files of mapper3) and by the generator at inference (the
// nn-v2 source's prepare builds `audio.beat` with this same function), so a model sees the same numbers in both.
//
//   BEAT_FEATURES (15, src/gen/snap.js: s0..s11, beat_max, energy, bpm; the same values to the bit)
//   chroma0..chroma11  mean stems chroma over the beat's frames [t, t + beatMs)
//   timbre0..timbre11  mean stems timbre over the same frames
//   phrase_pos, is_phrase_start, has_echo, rep_sim, novelty   structureColumns at the beat's start (its pos-0 slot)
//   meter              the beats per bar the structure's bars are cut with (structure.meter; 4 by default)
// = 45 columns. tools/nn/infill_model.py BEAT_FEATURES_V3 lists the same names in the same order.
import { BEAT_FEATURES, beatFeatures } from "./snap.js";
import { structureColumns } from "./structure.js";

export const CHROMA_FEATURES = Array.from({ length: 12 }, (_, k) => `chroma${k}`);
export const TIMBRE_FEATURES = Array.from({ length: 12 }, (_, k) => `timbre${k}`);
export const BEAT_STRUCTURE_FEATURES = ["phrase_pos", "is_phrase_start", "has_echo", "rep_sim", "novelty", "meter"];
export const BEAT_FEATURES_V3 = [...BEAT_FEATURES, ...CHROMA_FEATURES, ...TIMBRE_FEATURES, ...BEAT_STRUCTURE_FEATURES];

const DEFAULT_METER = 4;

// The frame range [f0, f1) of the stems whose times fall in [startMs, endMs); an empty range (a beat shorter than a
// frame, or past the end of the audio) falls back to the nearest frame.
function frameRange(stems, startMs, endMs) {
    const frames = stems.frames ?? stems.kick.length;
    if (!frames) return [0, 0];
    const frameTimeSec = stems.frameTimeSec ?? ((f) => f * stems.hopSec + stems.frameOffsetSec);
    const t0 = frameTimeSec(0);
    const hop = stems.hopSec ?? frameTimeSec(1) - t0;
    const at = (ms) => Math.ceil((ms / 1000 - t0) / hop - 1e-9);
    let f0 = Math.min(frames, Math.max(0, at(startMs)));
    let f1 = Math.min(frames, Math.max(0, at(endMs)));
    if (f1 <= f0) {
        f0 = Math.min(frames - 1, Math.max(0, Math.round((startMs / 1000 - t0) / hop)));
        f1 = f0 + 1;
    }
    return [f0, f1];
}

// beats: [{ t, beatMs, bpm }] (grid.js beatsFromTiming, or the dataset's beats). `stems`: Stems (computeStemsSync or
// stemsFromTransfer); `structure`: songStructure's output for the same song. Both are required ("missing stems" /
// "missing structure"), like slotFeatures with v3 names.
export function beatFeaturesV3(envelope, beats, { stems = null, structure = null } = {}) {
    if (!stems) throw new Error("missing stems");
    if (!structure) throw new Error("missing structure");
    const base = beatFeatures(envelope, beats).rows;
    const B0 = BEAT_FEATURES.length;
    const B = BEAT_FEATURES_V3.length;
    const n = beats.length;
    const rows = new Float32Array(n * B);
    // structure at each beat's start: slots are rounded to whole ms, and so are the bars' start lines
    const starts = beats.map((b) => ({ t: Math.round(b.t) }));
    const cols = structureColumns(structure, starts);
    const meter = structure.meter ?? DEFAULT_METER;
    const sums = new Float64Array(24);
    for (let i = 0; i < n; i += 1) {
        const b = beats[i];
        for (let k = 0; k < B0; k += 1) rows[i * B + k] = base[i * B0 + k];
        const [f0, f1] = frameRange(stems, b.t, b.t + b.beatMs);
        sums.fill(0);
        for (let f = f0; f < f1; f += 1) {
            for (let q = 0; q < 12; q += 1) {
                sums[q] += stems.chroma[f * 12 + q];
                sums[12 + q] += stems.timbre[f * 12 + q];
            }
        }
        const count = Math.max(1, f1 - f0);
        for (let q = 0; q < 24; q += 1) rows[i * B + B0 + q] = f1 > f0 ? sums[q] / count : 0;
        const s = B0 + 24;
        rows[i * B + s] = cols.phrase_pos[i];
        rows[i * B + s + 1] = cols.is_phrase_start[i];
        rows[i * B + s + 2] = cols.has_echo[i];
        rows[i * B + s + 3] = cols.rep_sim[i];
        rows[i * B + s + 4] = cols.novelty[i];
        rows[i * B + s + 5] = meter;
    }
    return { names: BEAT_FEATURES_V3, rows };
}
