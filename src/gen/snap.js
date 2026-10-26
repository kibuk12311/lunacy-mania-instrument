// Which grid each beat uses: 1/4, 1/3, 1/6 or 1/8 (1/12 and 1/16 stay off-grid).
// With a model that has a divisor head (grid "snap-v2") the head decides; otherwise rules on the onsets do.
import { treeRaw } from "./learnedModel.js";
import { slotEnergy } from "./intensity.js";
import { SNAP_ORDER } from "./mapRows.js";
import { OFFSET_BIAS_MS } from "../audio/fineOnset.js";

// Per beat: the onset at the twelve 1/12 positions (over the beat's strongest), that maximum, the loudness, the BPM.
export const BEAT_FEATURES = [...Array.from({ length: 12 }, (_, k) => `s${k}`), "beat_max", "energy", "bpm"];

// Positions only that grid has (fractions of a beat): the evidence for it.
const UNIQUE = { 4: [1 / 4, 3 / 4], 3: [1 / 3, 2 / 3], 6: [1 / 6, 5 / 6], 8: [1 / 8, 3 / 8, 5 / 8, 7 / 8] };
const WIN_OVER_QUARTER = 1.5; // another grid needs this many times the 1/4 evidence
const NOISE_FLOOR_MIN = 0.02;
const NOISE_FLOOR_MEDIANS = 1.5; // … and must beat the song's typical onset level this much
const MIN_TRIPLET_RUN = 2; // beats

const isTriplet = (d) => d === 3 || d === 6;

// (tMs, halfMs) → the strongest envelope frame within ±halfMs.
function sampler(envelope) {
    const { values, frameTimeSec } = envelope;
    const t0 = frameTimeSec(0);
    const frameMs = (frameTimeSec(1) - t0) * 1000;
    return (tMs, halfMs) => {
        const center = (tMs - t0 * 1000) / frameMs;
        const h = halfMs / frameMs;
        let best = 0;
        for (let f = Math.max(0, Math.floor(center - h)); f <= Math.min(values.length - 1, Math.ceil(center + h)); f += 1) {
            if (values[f] > best) best = values[f];
        }
        return best;
    };
}

// Half-width of a sampling window: no overlap between neighbouring 1/12 positions.
const halfWindow = (beatMs) => Math.min(12, beatMs / 24);

export function beatFeatures(envelope, beats) {
    const at = sampler(envelope);
    const energy = slotEnergy(envelope, beats);
    const F = BEAT_FEATURES.length;
    const rows = new Float32Array(beats.length * F);
    const s = new Float64Array(12);
    beats.forEach((b, i) => {
        const half = halfWindow(b.beatMs);
        let max = 0;
        for (let k = 0; k < 12; k += 1) {
            s[k] = at(b.t + (k * b.beatMs) / 12, half);
            if (s[k] > max) max = s[k];
        }
        for (let k = 0; k < 12; k += 1) rows[i * F + k] = max > 0 ? s[k] / max : 0;
        rows[i * F + 12] = max;
        rows[i * F + 13] = energy[i];
        rows[i * F + 14] = b.bpm;
    });
    return { names: BEAT_FEATURES, rows };
}

function median(values) {
    const sorted = Float32Array.from(values).sort();
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

// The rules: a beat leaves 1/4 only when another allowed grid's own positions clearly carry onsets
// (over 1.5× the 1/4 positions and over the noise floor); then a 3-beat majority filter, and triplet runs
// shorter than 2 beats go back to 1/4.
export function detectBeatSnaps(envelope, beats, allowed = SNAP_ORDER) {
    const sample = sampler(envelope);
    // detect-timing puts red lines OFFSET_BIAS_MS before the attacks, as people do; one set on the attacks has no
    // such gap. The onsets are looked for where the beats' own attacks are.
    const onBeats = (lag) => beats.reduce((sum, b) => sum + sample(b.t + lag, halfWindow(b.beatMs)), 0);
    const lag = onBeats(-OFFSET_BIAS_MS) > onBeats(0) ? -OFFSET_BIAS_MS : 0;
    const at = (tMs, halfMs) => sample(tMs + lag, halfMs);
    const floor = Math.max(NOISE_FLOOR_MIN, NOISE_FLOOR_MEDIANS * median(envelope.values));
    const n = beats.length;
    const raw = new Uint8Array(n).fill(4);
    beats.forEach((b, i) => {
        const half = halfWindow(b.beatMs);
        const score = (g) => UNIQUE[g].reduce((sum, f) => sum + at(b.t + f * b.beatMs, half), 0) / UNIQUE[g].length;
        const quarter = score(4);
        const scores = {};
        const pass = (g) => {
            if (!allowed.includes(g)) return false;
            scores[g] = score(g);
            return scores[g] > WIN_OVER_QUARTER * quarter && scores[g] > floor;
        };
        // 1/6 holds the 1/3 positions too, so it wins when its own positions also carry onsets
        const ternary = pass(6) ? 6 : pass(3) ? 3 : 0;
        const eighth = pass(8) ? 8 : 0;
        if (ternary && eighth) raw[i] = scores[ternary] >= scores[8] ? ternary : 8;
        else raw[i] = ternary || eighth || 4;
    });
    const out = Uint8Array.from(raw);
    for (let i = 1; i + 1 < n; i += 1) if (raw[i - 1] === raw[i + 1]) out[i] = raw[i - 1];
    for (let i = 0; i < n;) {
        if (!isTriplet(out[i])) {
            i += 1;
            continue;
        }
        let j = i;
        while (j < n && isTriplet(out[j])) j += 1;
        if (j - i < MIN_TRIPLET_RUN) out.fill(4, i, j);
        i = j;
    }
    return out;
}

function softmax(raw) {
    const max = Math.max(...raw);
    const exp = raw.map((r) => Math.exp(r - max));
    const total = exp.reduce((a, b) => a + b, 0);
    return exp.map((e) => e / total);
}

// snapTransitions as a 4×4 array in the head's class order, or { from: { to: p } }.
function transitionOf(table, classes) {
    if (!table) return () => 1;
    if (Array.isArray(table)) return (from, to) => table[classes.indexOf(from)]?.[classes.indexOf(to)] ?? 0;
    return (from, to) => table[from]?.[to] ?? 0;
}

// One divisor per beat (Uint8Array). allowed ⊆ [4, 3, 6, 8]; `dan` is a number or one per beat, `families` a family
// name or one per beat (null = none). With `model.divisor` the head's class probabilities are walked along
// `model.snapTransitions` with `rng`; without it the rules decide.
export function chooseBeatDivs({ envelope, beats, allowed = [4], model = null, dan = null, families = null, rng = Math.random }) {
    const ok = SNAP_ORDER.filter((d) => allowed.includes(d));
    if (!ok.some((d) => d !== 4)) return new Uint8Array(beats.length).fill(4);
    if (!model?.divisor) return detectBeatSnaps(envelope, beats, ok);

    const head = model.divisor;
    const classes = head.classes ?? SNAP_ORDER;
    const names = head.features ?? [...BEAT_FEATURES, ...(model.conditioning ?? [])];
    const { rows } = beatFeatures(envelope, beats);
    const F = BEAT_FEATURES.length;
    const danAt = (i) => (typeof dan === "number" ? dan : dan?.[i] ?? NaN);
    const familyAt = (i) => (typeof families === "string" ? families : families?.[i] ?? null);
    const column = names.map((name) => {
        const k = BEAT_FEATURES.indexOf(name);
        if (k >= 0) return (i) => rows[i * F + k];
        if (name === "dan") return danAt;
        if (name.startsWith("fam_")) return (i) => (familyAt(i) === name.slice(4) ? 1 : 0);
        return () => NaN;
    });
    const trans = transitionOf(model.snapTransitions, classes);
    const out = new Uint8Array(beats.length);
    const x = new Array(names.length);
    let prev = null;
    for (let i = 0; i < beats.length; i += 1) {
        for (let j = 0; j < names.length; j += 1) x[j] = column[j](i);
        const p = softmax(treeRaw(head, x));
        const weights = classes.map((d, k) => (ok.includes(d) ? p[k] * (prev === null ? 1 : trans(prev, d)) : 0));
        const total = weights.reduce((a, b) => a + b, 0);
        let pick = 4;
        if (total > 0) {
            let r = rng() * total;
            pick = classes.find((d, k) => (r -= weights[k]) < 0) ?? classes[weights.findLastIndex((w) => w > 0)];
        }
        out[i] = pick;
        prev = pick;
    }
    return out;
}

// The finest grid a slot's position needs: a triplet beat's downbeat is still 1/4, a 1/6 half too.
function finestGrid(pos, div) {
    return SNAP_ORDER.find((g) => (pos * g) % div === 0) ?? div;
}

// Share of the rows on each grid { 4, 3, 6, 8 }; rows are matched to their slot by time.
export function gridShares(rows, slots) {
    const shares = { 4: 0, 3: 0, 6: 0, 8: 0 };
    if (!rows.length || !slots.length) return { 4: 1, 3: 0, 6: 0, 8: 0 };
    let j = 0;
    for (const row of [...rows].sort((a, b) => a.t - b.t)) {
        while (j + 1 < slots.length && Math.abs(slots[j + 1].t - row.t) <= Math.abs(slots[j].t - row.t)) j += 1;
        const s = slots[j];
        shares[finestGrid(s.pos ?? s.sub ?? 0, s.div ?? 4)] += 1;
    }
    for (const g of SNAP_ORDER) shares[g] /= rows.length;
    return shares;
}
