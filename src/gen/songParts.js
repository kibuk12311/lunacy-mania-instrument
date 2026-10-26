// Song parts (intro, build-up, drop, break, outro): bars described by loudness, onset density and bass, cut where
// they change by dynamic programming, then named by how loud each part is.
import { slotStrengths, strengthsAt, slotEnergy } from "./intensity.js";

export const PART_KINDS = ["intro", "build", "drop", "break", "outro", "part"];

const LAMBDA = 0.6; // cost of one more part, against the squared change of bar features it explains
const MIN_PART_BARS = 4;
const DROP_ENERGY = 0.65;
const BREAK_ENERGY = 0.4;
const BUILD_RISE = 0.15; // energy gain from the first to the last third of a part before a drop
const FEATURE_WEIGHTS = [1, 1, 0.5]; // energy, onset density, bass

// Bars of `meter` beats (by slot.beat), counted again from every red line (a change of beat length):
// [{ i0, i1, startMs, endMs }] with i1 exclusive, covering all slots.
export function barsOf(slots, meter = 4) {
    const bars = [];
    let sectionBeat = null;
    let barKey = null;
    slots.forEach((s, i) => {
        const prev = slots[i - 1];
        const newSection = !prev || (s.beatMs ?? 60000 / s.bpm) !== (prev.beatMs ?? 60000 / prev.bpm);
        if (newSection) sectionBeat = s.beat;
        const key = `${sectionBeat}:${Math.floor((s.beat - sectionBeat) / meter)}`;
        if (key !== barKey) {
            if (bars.length) bars.at(-1).i1 = i;
            bars.push({ i0: i, i1: slots.length, startMs: s.t, endMs: null });
            barKey = key;
        }
    });
    bars.forEach((b, k) => {
        const last = slots[b.i1 - 1];
        b.endMs = k + 1 < bars.length ? bars[k + 1].startMs : last.t + (last.beatMs ?? 60000 / last.bpm) / (last.div ?? 4);
    });
    return bars;
}

function percentile(values, q) {
    const sorted = Float64Array.from(values).sort();
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

// Per bar [energy, onset density, bass], each 0..1 for the song: loudness (slotEnergy), the mean onset at the slots
// and the mean low-band onset, both over their 95th percentile.
export function barFeatures(envelope, slots, bars) {
    const energy = slotEnergy(envelope, slots);
    const onset = slotStrengths(envelope, slots);
    const low = envelope.bands?.low ? strengthsAt(envelope.bands.low, envelope.frameTimeSec, slots) : onset;
    const onsetTop = percentile(onset, 0.95) || 1;
    const lowTop = percentile(low, 0.95) || 1;
    return bars.map(({ i0, i1 }) => {
        let e = 0;
        let o = 0;
        let l = 0;
        for (let i = i0; i < i1; i += 1) {
            e += energy[i];
            o += Math.min(1, onset[i] / onsetTop);
            l += Math.min(1, low[i] / lowTop);
        }
        const n = Math.max(1, i1 - i0);
        return [e / n, o / n, l / n];
    });
}

// Cut the bars into segments of at least MIN_PART_BARS minimising the weighted squared spread of their features
// plus lambda per segment. → segment start bar indices (the first is 0).
function segment(features, lambda = LAMBDA) {
    const n = features.length;
    const D = FEATURE_WEIGHTS.length;
    const sum = Array.from({ length: D }, () => new Float64Array(n + 1));
    const sq = Array.from({ length: D }, () => new Float64Array(n + 1));
    for (let k = 0; k < n; k += 1) {
        for (let d = 0; d < D; d += 1) {
            sum[d][k + 1] = sum[d][k] + features[k][d];
            sq[d][k + 1] = sq[d][k] + features[k][d] ** 2;
        }
    }
    const cost = (a, b) => {
        let c = 0;
        for (let d = 0; d < D; d += 1) {
            const s = sum[d][b] - sum[d][a];
            c += FEATURE_WEIGHTS[d] * (sq[d][b] - sq[d][a] - (s * s) / (b - a));
        }
        return c;
    };
    const minLen = n >= 2 * MIN_PART_BARS ? MIN_PART_BARS : n;
    const best = new Float64Array(n + 1).fill(Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let b = minLen; b <= n; b += 1) {
        for (let a = 0; a <= b - minLen; a += 1) {
            if (!Number.isFinite(best[a])) continue;
            const v = best[a] + cost(a, b) + lambda;
            if (v < best[b]) {
                best[b] = v;
                from[b] = a;
            }
        }
    }
    const starts = [];
    for (let b = n; b > 0; b = from[b]) starts.unshift(from[b]);
    return starts;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

// Kinds from loudness: loud parts are drops; quiet ones in the middle are breaks; the first and last quiet ones are
// the intro and outro; a part that gets louder into a drop is a build-up. One part alone is just "part".
function labelParts(segments) {
    if (segments.length === 1) return ["part"];
    return segments.map((seg, k) => {
        const energy = mean(seg.map((f) => f[0]));
        if (energy >= DROP_ENERGY) return "drop";
        if (k === 0) return "intro";
        if (k === segments.length - 1) return "outro";
        const third = Math.max(1, Math.floor(seg.length / 3));
        const rise = mean(seg.slice(-third).map((f) => f[0])) - mean(seg.slice(0, third).map((f) => f[0]));
        const next = segments[k + 1];
        const nextIsDrop = mean(next.map((f) => f[0])) >= DROP_ENERGY;
        if (nextIsDrop && rise >= BUILD_RISE) return "build";
        if (energy <= BREAK_ENERGY) return "break";
        return nextIsDrop ? "build" : "part";
    });
}

const envelopeEndMs = (envelope) => envelope.frameTimeSec(Math.max(0, envelope.values.length - 1)) * 1000;

// Song parts from the audio: [{ startMs, endMs, kind }] covering the song from 0 to the end of the envelope,
// boundaries on bar lines. `lambda` (the cost of a part) is there for tools/eval-parts.mjs.
export function detectParts(envelope, slots, { lambda = LAMBDA } = {}) {
    const endMs = envelopeEndMs(envelope);
    if (!slots.length) return [{ startMs: 0, endMs, kind: "part" }];
    const bars = barsOf(slots);
    const features = barFeatures(envelope, slots, bars);
    const starts = segment(features, lambda);
    const segments = starts.map((a, k) => features.slice(a, starts[k + 1] ?? features.length));
    const kinds = labelParts(segments);
    return starts.map((a, k) => ({
        startMs: k === 0 ? 0 : bars[a].startMs,
        endMs: k + 1 < starts.length ? bars[starts[k + 1]].startMs : Math.max(endMs, bars.at(-1).endMs),
        kind: kinds[k],
    }));
}

// Loudness of the song at `points` evenly spaced times, 0 (quietest parts) … 1 (the drops), for the timeline.
export function energyCurve(envelope, durationMs, points) {
    const at = Array.from({ length: points }, (_, k) => ({ t: ((k + 0.5) * durationMs) / points }));
    return slotEnergy(envelope, at);
}

// Index of the part each slot falls in (parts sorted and end to end); slots past the end belong to the last part.
export function partIndexOfSlots(slots, parts) {
    const out = new Int16Array(slots.length);
    let p = 0;
    slots.forEach((s, i) => {
        while (p + 1 < parts.length && s.t >= parts[p + 1].startMs) p += 1;
        out[i] = p;
    });
    return out;
}
