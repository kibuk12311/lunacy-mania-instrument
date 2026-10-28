// Millisecond-precise onsets for placing red lines. The onset envelope (onset.js) has 11.6 ms frames and a fixed time
// mapping the mapper model was trained with; this one compares the energy just after each moment (1.5 ms) with the
// energy just before it (23 ms), on the sample-to-sample difference of the audio so bass waves (whose energy swells
// and fades every few ms) do not look like attacks. values[f] is the strongest attack that starts inside
// [f·hop, (f+1)·hop): its time is the middle of that span.

export const FINE_HOP = 32;
const BLOCK = 4; // samples per energy block
const RISE_BLOCKS = 8; // energy over the 32 samples after a moment …
const BASE_BLOCKS = 128; // … against the 512 samples before it
const QUIET = 0.01; // energy below 1% of the song's mean does not make an attack

// Red lines as people place them sit this far from our attacks (decoder delay plus mapping habit): on the app's own
// decode path (Chromium, 22050 Hz) human red lines are about 23 ms before the attacks we find. Fitted by
// tools/eval-timing.mjs --decoder chromium on 157 held-out maps (the shift that puts the most within ±5 ms).
export const OFFSET_BIAS_MS = -23;

export function fineOnset(samples, sampleRate, hop = FINE_HOP) {
    const perHop = Math.max(1, Math.round(hop / BLOCK));
    const blocks = Math.floor(samples.length / BLOCK);
    const prefix = new Float64Array(blocks + 1);
    let last = 0;
    for (let b = 0; b < blocks; b += 1) {
        let e = 0;
        for (let i = b * BLOCK; i < (b + 1) * BLOCK; i += 1) {
            const d = samples[i] - last;
            last = samples[i];
            e += d * d;
        }
        prefix[b + 1] = prefix[b] + e;
    }
    const eps = QUIET * (prefix[blocks] / Math.max(1, blocks * BLOCK)) + 1e-12;
    const frames = Math.floor(blocks / perHop);
    const values = new Float32Array(frames);
    let max = 0;
    for (let f = 0; f < frames; f += 1) {
        let best = 0;
        for (let b = Math.max(BASE_BLOCKS, f * perHop); b < Math.min(blocks - RISE_BLOCKS + 1, (f + 1) * perHop); b += 1) {
            const rise = (prefix[b + RISE_BLOCKS] - prefix[b]) / (RISE_BLOCKS * BLOCK);
            const base = (prefix[b] - prefix[b - BASE_BLOCKS]) / (BASE_BLOCKS * BLOCK);
            const r = Math.log((rise + eps) / (base + eps));
            if (r > best) best = r;
        }
        values[f] = best;
        if (best > max) max = best;
    }
    if (max > 0) for (let f = 0; f < frames; f += 1) values[f] /= max;
    return { values, hopSec: (perHop * BLOCK) / sampleRate };
}

const frameMsOf = (fine) => fine.hopSec * 1000;

// The fine curve at any time (ms), linearly between frame middles.
function curve(fine) {
    const { values } = fine;
    const frameMs = frameMsOf(fine);
    return (tMs) => {
        const x = tMs / frameMs - 0.5;
        const i = Math.floor(x);
        const a = x - i;
        const v0 = i >= 0 && i < values.length ? values[i] : 0;
        const v1 = i + 1 >= 0 && i + 1 < values.length ? values[i + 1] : 0;
        return v0 * (1 - a) + v1 * a;
    };
}

// Beat times of a section inside [fromMs, toMs): its grid, also before its red line when fromMs is earlier.
function sectionBeats(section, fromMs, toMs) {
    const beatMs = 60000 / section.bpm;
    const out = [];
    for (let k = Math.ceil((fromMs - section.timeMs) / beatMs - 1e-9); ; k += 1) {
        const t = section.timeMs + k * beatMs;
        if (t >= toMs) break;
        out.push({ k, t });
    }
    return out;
}

const durationMs = (fine) => fine.values.length * frameMsOf(fine);

// The attack nearest a time: the weighted middle of the strongest frame within ±halfMs and its two neighbours.
function peakNear(fine, tMs, halfMs) {
    const { values } = fine;
    const frameMs = frameMsOf(fine);
    const lo = Math.max(0, Math.floor((tMs - halfMs) / frameMs));
    const hi = Math.min(values.length - 1, Math.ceil((tMs + halfMs) / frameMs));
    let best = -1;
    for (let f = lo; f <= hi; f += 1) if (best < 0 || values[f] > values[best]) best = f;
    if (best < 0 || values[best] <= 0) return null;
    let sum = 0;
    let at = 0;
    for (let f = Math.max(0, best - 1); f <= Math.min(values.length - 1, best + 1); f += 1) {
        sum += values[f];
        at += values[f] * (f + 0.5) * frameMs;
    }
    return { t: at / sum, value: values[best] };
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// How far the attacks of the strong beats sit from the grid: the median distance (ms), or null with too few.
function spreadMs(fine, beats, rangeMs) {
    const peaks = beats.map(({ t }) => ({ t, p: peakNear(fine, t, rangeMs) })).filter((x) => x.p);
    if (peaks.length < 8) return null;
    const strong = median(peaks.map((x) => x.p.value));
    const devs = peaks.filter((x) => x.p.value >= strong).map((x) => Math.abs(x.p.t - x.t));
    return Math.round(median(devs) * 10) / 10;
}

// The onsets of [fromMs, toMs) folded onto one beat around anchorMs (1 ms bins, smoothed over ±2 ms): per bin its
// shift from the anchor (−beat/2 … beat/2) and its value.
function phaseFold(fine, { bpm, anchorMs, fromMs, toMs }) {
    const beatMs = 60000 / bpm;
    const bins = Math.max(1, Math.round(beatMs));
    const hist = new Float64Array(bins);
    const frameMs = frameMsOf(fine);
    const { values } = fine;
    for (let f = Math.max(0, Math.floor(fromMs / frameMs)); f < Math.min(values.length, Math.ceil(toMs / frameMs)); f += 1) {
        if (values[f] <= 0) continue;
        const d = ((((f + 0.5) * frameMs - anchorMs) % beatMs) + beatMs) % beatMs;
        hist[Math.floor((d / beatMs) * bins) % bins] += values[f];
    }
    const shifts = new Float64Array(bins);
    const sums = new Float64Array(bins);
    for (let i = 0; i < bins; i += 1) {
        let v = 0;
        for (let k = -2; k <= 2; k += 1) v += hist[(i + k + bins) % bins] * (3 - Math.abs(k));
        sums[i] = v;
        shifts[i] = (((i + 0.5) / bins) * beatMs + beatMs / 2) % beatMs - beatMs / 2;
    }
    return { shifts, sums };
}

// Where in the beat the attacks gather: the onsets of [fromMs, toMs) folded onto one beat (1 ms bins, smoothed over
// ±2 ms), and the beat time at the strongest bin nearest `anchorMs`. With `withinMs` only bins that close to the
// anchor's own place in the beat count. That is the phase of the beat in most music (kick and snare); off-beat
// hi-hats are weaker.
export function beatPhase(fine, { bpm, anchorMs, fromMs = 0, toMs = durationMs(fine), withinMs = null }) {
    const { shifts, sums } = phaseFold(fine, { bpm, anchorMs, fromMs, toMs });
    let best = 0;
    let bestValue = -1;
    for (let i = 0; i < sums.length; i += 1) {
        if (withinMs !== null && Math.abs(shifts[i]) > withinMs) continue;
        if (sums[i] > bestValue) {
            bestValue = sums[i];
            best = shifts[i];
        }
    }
    return anchorMs + best;
}

// A red line the user placed («Подогнать по волне»): onto the strongest folded attacks within ±nearMs of it. Only
// when the user's line is clearly off, that is the strongest attacks there fold under offRatio of the strongest
// anywhere in the beat, onto those. A loud song often folds about as strongly half a beat away (an off-beat bass, a
// pumping swell), so that alone never moves a line. → { timeMs, near } (near: it stayed within ±nearMs).
export function hintPhase(fine, { bpm, anchorMs, fromMs = 0, toMs = durationMs(fine), nearMs, offRatio }) {
    const { shifts, sums } = phaseFold(fine, { bpm, anchorMs, fromMs, toMs });
    let local = { value: -1, shift: 0 };
    let all = { value: -1, shift: 0 };
    for (let i = 0; i < sums.length; i += 1) {
        if (Math.abs(shifts[i]) <= nearMs && sums[i] > local.value) local = { value: sums[i], shift: shifts[i] };
        if (sums[i] > all.value) all = { value: sums[i], shift: shifts[i] };
    }
    if (!(all.value > 0)) return { timeMs: anchorMs, near: true };
    const near = local.value >= offRatio * all.value;
    return { timeMs: anchorMs + (near ? local.shift : all.shift), near };
}

// Shift a section's red line by up to ±rangeMs so its beats sit on the attacks: the shift with the most onset on the
// beats, to stepMs, then a parabola through the best step and its neighbours.
// section { timeMs, bpm, fromMs?, toMs? } (the stretch it covers; by default from its red line to the end).
export function refineOffset(fine, section, { rangeMs = 15, stepMs = 0.1 } = {}) {
    const at = curve(fine);
    const beats = sectionBeats(section, section.fromMs ?? section.timeMs, section.toMs ?? durationMs(fine));
    const steps = Math.round(rangeMs / stepMs);
    const score = new Float64Array(2 * steps + 1);
    for (let s = -steps; s <= steps; s += 1) {
        let sum = 0;
        for (const { t } of beats) sum += at(t + s * stepMs);
        score[s + steps] = sum;
    }
    let best = 0;
    for (let i = 1; i < score.length; i += 1) if (score[i] > score[best]) best = i;
    let shift = (best - steps) * stepMs;
    if (best > 0 && best + 1 < score.length) {
        const [a, b, c] = [score[best - 1], score[best], score[best + 1]];
        const d = a - 2 * b + c;
        if (d < 0) shift += (0.5 * (a - c) / d) * stepMs;
    }
    const refined = { ...section, timeMs: section.timeMs + shift };
    return { timeMs: refined.timeMs, shiftMs: shift, errMs: spreadMs(fine, sectionBeats(refined, section.fromMs ?? refined.timeMs, section.toMs ?? durationMs(fine)), rangeMs) };
}

const EXCERPT_MS = 60000;

// The attacks of [fromMs, toMs) worth counting: times (ms) and strengths of the frames above `min`.
function attacks(fine, fromMs, toMs, min = 0.1) {
    const frameMs = frameMsOf(fine);
    const t = [];
    const v = [];
    for (let f = Math.max(0, Math.floor(fromMs / frameMs)); f < Math.min(fine.values.length, Math.ceil(toMs / frameMs)); f += 1) {
        if (fine.values[f] > min) {
            t.push((f + 0.5) * frameMs);
            v.push(fine.values[f]);
        }
    }
    return { t: Float64Array.from(t), v: Float32Array.from(v) };
}

// How tightly the attacks gather at one place in the beat: the attacks folded onto a beat of beatMs (1 ms bins,
// smoothed 1-2-1), strongest bin over the mean bin. The right BPM folds every beat onto the same place.
function concentration(list, beatMs) {
    const bins = Math.max(3, Math.round(beatMs));
    const hist = new Float64Array(bins);
    const scale = bins / beatMs;
    for (let i = 0; i < list.t.length; i += 1) hist[Math.floor((list.t[i] % beatMs) * scale) % bins] += list.v[i];
    let total = 0;
    let best = 0;
    for (let i = 0; i < bins; i += 1) {
        total += hist[i];
        const s = hist[(i - 1 + bins) % bins] + 2 * hist[i] + hist[(i + 1) % bins];
        if (s > best) best = s;
    }
    return total > 0 ? best / 4 / (total / bins) : 0;
}

// How tightly one BPM folds the attacks of [fromMs, toMs) (see concentration).
export function foldsAt(fine, { bpm, fromMs = 0, toMs = durationMs(fine) }) {
    const list = attacks(fine, fromMs, toMs);
    return list.t.length < 16 ? 0 : concentration(list, 60000 / bpm);
}

// The BPM near `bpm` (±spanBpm) whose beat folds the section's attacks most tightly. Steps move the last beat by
// about 3 ms: first over a minute from the middle of the section, then over all of it near that, then a tenth of
// the step around the best.
export function fineTempo(fine, { bpm, fromMs = 0, toMs = durationMs(fine), spanBpm = 2.5 }) {
    const all = attacks(fine, fromMs, toMs);
    if (all.t.length < 16) return { bpm, concentration: 0 };
    const spanMs = Math.max(1000, toMs - fromMs);
    const stepFor = (ms) => Math.min(spanBpm / 20, Math.max(0.0005, (3 * bpm) / ms));
    const scan = (list, around, half, by) => {
        let best = { bpm: around, concentration: concentration(list, 60000 / around) };
        for (let b = around - half; b <= around + half + 1e-9; b += by) {
            const c = concentration(list, 60000 / b);
            if (c > best.concentration) best = { bpm: b, concentration: c };
        }
        return best;
    };
    let best = { bpm };
    let step = stepFor(spanMs);
    if (spanMs > EXCERPT_MS * 1.5) {
        const mid = (fromMs + toMs) / 2;
        const excerpt = attacks(fine, mid - EXCERPT_MS / 2, mid + EXCERPT_MS / 2);
        const coarse = stepFor(EXCERPT_MS);
        if (excerpt.t.length >= 16) best = scan(excerpt, bpm, spanBpm, coarse);
        best = scan(all, best.bpm, 2 * coarse, step);
    } else {
        best = scan(all, bpm, spanBpm, step);
    }
    best = scan(all, best.bpm, step, step / 10);
    return best;
}

// BPM and red line of one section from the attacks: the BPM that folds them tightest (fineTempo), then the red line
// shifted onto them (refineOffset, ±rangeMs). The beats of [fromMs, toMs) count; the red line stays near the old one.
export function refineSection(fine, section, { rangeMs = 15, tempo = true } = {}) {
    const fromMs = section.fromMs ?? section.timeMs;
    const toMs = section.toMs ?? durationMs(fine);
    const bpm = tempo ? fineTempo(fine, { bpm: section.bpm, fromMs, toMs }).bpm : section.bpm;
    const r = refineOffset(fine, { timeMs: section.timeMs, bpm, fromMs, toMs }, { rangeMs });
    return { timeMs: r.timeMs, bpm, errMs: r.errMs };
}
