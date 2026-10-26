// Light stems on the onset envelope's frame grid: kick, snare, hat and harmonic onset curves, the percussive share
// of each frame, a 12-bin chroma and a 12-number timbre. Plain JS, used in the renderer on song load and by the
// dataset tools on ffmpeg-decoded audio, so a model sees the same numbers in training and in the app.
//
// Algorithm (docs/2026-10-25-mapgen-v3-ml-addendum.md §2.2): an STFT (1024/256, Hann, samples clipped to ±1 like
// Chromium's decoder) pooled to 256 bins → HPSS (median over 17 frames and over 17 bins, soft masks; bins up to
// 10 kHz) → positive log-flux of the percussive spectrum, as a mean per bin, in bands:
//   kick  40–120 Hz, weighted by the share of the frame's energy rise in that band (a snare's low end is no kick);
//   snare 150–400 Hz and 1.5–5 kHz, both up within ±1 frame (the weaker of the two);
//   hat   5–10 kHz;
// and of the harmonic spectrum over 100 Hz–5 kHz (harm: melodic onsets). Each curve is lightly smoothed, then scaled
// by (P99 − median) over the song with a floor, and clipped to 0..1. percShare = ΣP² / (ΣH² + ΣP²). Chroma comes from
// its own 4096/2048 STFT (130 Hz–5 kHz) weighted by the harmonic mask; timbre = DCT 1–12 of 24 log mel bands,
// z-scored over the song.
//
// Stems = { v, sampleRate, hopSec, frameOffsetSec, frames, frameTimeSec(f),
//           kick, snare, hat, harm, percShare: Float32Array(frames) in 0..1,
//           chroma, timbre: Float32Array(frames·12) in 0..1, on the 1/255 grid (so a transfer loses nothing) }
// StemsTransfer = the same without frameTimeSec and sampleRate, chroma and timbre as Uint8Array (0..255).
import { FRAME, HOP, BINS, KERNEL, MASK_EPS, frameCount, hannWindow, makeRealFft, spectrogramRunner, timeMedianFilter, medianRow } from "./hpss.js";

export const STEMS_VERSION = 1;
export const STEM_CURVES = ["kick", "snare", "hat", "harm", "percShare"];
export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const CHROMA_FRAME = 4096;
export const CHROMA_HOP = 2048;
export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
export const FRAME_SLACK = 2; // a transfer may differ from the envelope by this many frames

const HOLD = CHROMA_HOP / HOP; // main frames per chroma frame
// main frame f ↔ chroma frame round((f − HOLD_SHIFT) / HOLD): the chroma window whose centre is nearest to the frame's
const HOLD_SHIFT = (CHROMA_FRAME - FRAME) / 2 / HOP;
const CHROMA_LOW_HZ = 261.6256 / 2 / 2 ** (0.5 / 12); // a quarter tone below C3
const CHROMA_HIGH_HZ = 5000;
const BANDS_HZ = {
    kick: [40, 120], // pooled bins at 54 and 97 Hz: kick fundamentals, clear of a snare's 180–250 Hz body
    snareLow: [150, 400],
    snareHigh: [1500, 5000],
    hat: [5000, 10000],
    harm: [100, 5000],
    rise: [40, 10000], // the energy rise the kick band's share is measured against
};
const GAMMA = 100; // log(1 + γ·magnitude), as in onsetEnvelope
// Log-flux alone cannot tell a kick from a snare's low end (any rise from quiet is a big log step), so the kick's
// flux is weighted by the share of the frame's energy rise (linear power of the whole spectrum: HPSS calls much of a
// long kick's low tone harmonic) that is in the kick band: a kick puts most of its power there, a snare, a clap or a
// hat very little. The weight ramps from 0 at KICK_SHARE[0] to 1 at [1].
const KICK_SHARE = [0.2, 0.5];
// Curves are scaled by (P99 − median) over the song, but never by less than this many log units of mean flux per
// bin: a song without hats keeps a flat hat curve instead of its noise floor stretched to 1.
const CURVE_FLOOR = { kick: 0.6, snare: 1.0, hat: 0.6, harm: 0.1 };
const TIMBRE_BANDS = 24;
const TIMBRE_COEFFS = 12;
const TIMBRE_LOW_HZ = 60;
const TIMBRE_HIGH_HZ = 10000;
const TIMBRE_SPREAD = 6; // timbre maps z-scores −3 … 3 onto 0 … 1
const DEFAULT_CHUNK = 2048; // frames per step between yields

const quantize = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255;

// Pooled bins whose centre frequency is in [lo, hi): pooled bin p is FFT bins 2p and 2p + 1, centre (2p + 0.5)·Δ.
function bandBins(sampleRate, [lo, hi]) {
    const df = sampleRate / FRAME;
    let b0 = BINS;
    let b1 = 0;
    for (let p = 0; p < BINS; p += 1) {
        const hz = (2 * p + 0.5) * df;
        if (hz >= lo && hz < hi) {
            b0 = Math.min(b0, p);
            b1 = Math.max(b1, p + 1);
        }
    }
    return b0 < b1 ? [b0, b1] : [0, 0];
}

const mel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

function timbreBands(sampleRate) {
    const df = sampleRate / FRAME;
    const top = Math.min(TIMBRE_HIGH_HZ, sampleRate / 2 - df);
    const edges = Array.from({ length: TIMBRE_BANDS + 1 }, (_, j) => melToHz(mel(TIMBRE_LOW_HZ) + ((mel(top) - mel(TIMBRE_LOW_HZ)) * j) / TIMBRE_BANDS));
    return edges.slice(0, -1).map((lo, j) => {
        const [b0, b1] = bandBins(sampleRate, [lo, edges[j + 1]]);
        if (b1 > b0) return [b0, b1];
        const p = Math.min(BINS - 1, Math.max(0, Math.round(((lo + edges[j + 1]) / 2 / df - 0.5) / 2)));
        return [p, p + 1];
    });
}

const DCT = Float64Array.from({ length: TIMBRE_COEFFS * TIMBRE_BANDS }, (_, i) => {
    const k = Math.floor(i / TIMBRE_BANDS) + 1;
    const j = i % TIMBRE_BANDS;
    return Math.cos((Math.PI * k * (j + 0.5)) / TIMBRE_BANDS) * Math.sqrt(2 / TIMBRE_BANDS);
});

function percentileOf(values, q) {
    if (!values.length) return 0;
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// A short triangular smoothing (taps [1, 2, 1] or [1, 2, 3, 2, 1]). Frame-level detail finer than this is decoder
// noise (Chromium and ffmpeg resample differently) and finer than the ±12 ms that slot features sample anyway.
function smoothCurve(raw, half) {
    const out = new Float32Array(raw.length);
    for (let f = 0; f < raw.length; f += 1) {
        let s = 0;
        let w = 0;
        for (let d = -half; d <= half; d += 1) {
            const g = f + d;
            if (g < 0 || g >= raw.length) continue;
            const k = half + 1 - Math.abs(d);
            s += k * raw[g];
            w += k;
        }
        out[f] = s / w;
    }
    return out;
}
const SMOOTH = { kick: 1, snare: 1, hat: 1, harm: 2 }; // half-widths in frames: harmonic onsets are slower

// raw flux → 0..1: above the median, over max(P99 − median, floor)
function normalizeCurve(raw, floor) {
    const med = percentileOf(raw, 0.5);
    const scale = Math.max(percentileOf(raw, 0.99) - med, floor);
    const out = new Float32Array(raw.length);
    for (let f = 0; f < raw.length; f += 1) out[f] = Math.min(1, Math.max(0, (raw[f] - med) / scale));
    return out;
}

const frameTimeFor = (sampleRate) => (f) => (f * HOP + FRAME - HOP) / sampleRate;

// The steps of computeStems: a generator that yields its progress (0..1) after every `chunk` frames of each stage
// and returns the Stems. `debug` also returns the unscaled band fluxes as `raw` (for tuning; never sent anywhere).
export function* stemsSteps(samples, sampleRate, { chunk = DEFAULT_CHUNK, debug = false } = {}) {
    const spec = spectrogramRunner(samples);
    const { frames, S } = spec;
    const NB = BINS;
    const chromaFrames = frameCount(samples.length, CHROMA_FRAME, CHROMA_HOP);
    const work = 3 * frames + HOLD * chromaFrames || 1;
    let done = 0;
    const step = Math.max(1, Math.floor(chunk) || DEFAULT_CHUNK);

    // 1. the spectrogram
    for (let f = 0; f < frames; f += step) {
        spec.advance(f + step);
        done += Math.min(step, frames - f);
        yield done / work;
    }

    // 2. the median over time (harmonic), for the bins up to 10 kHz (nothing above them is used)
    const band = Object.fromEntries(Object.entries(BANDS_HZ).map(([k, v]) => [k, bandBins(sampleRate, v)]));
    const HB = Math.max(1, band.rise[1]);
    const H = new Float32Array(frames * HB);
    const timeMedian = timeMedianFilter(S, frames, HB, KERNEL, NB);
    for (let f = 0; f < frames; f += step) {
        timeMedian.advance(f + step, H);
        done += Math.min(step, frames - f);
        yield done / work;
    }

    // 3. per frame: the median over frequency (percussive), the masks, band fluxes, percussive share, timbre
    const [pLo, pHi] = band.rise;
    const [hLo, hHi] = band.harm;
    const raw = { kick: new Float32Array(frames), kickShare: new Float32Array(frames), snareLow: new Float32Array(frames), snareHigh: new Float32Array(frames), hat: new Float32Array(frames), harm: new Float32Array(frames) };
    const percShare = new Float32Array(frames);
    const timbreRaw = new Float32Array(frames * TIMBRE_COEFFS);
    const tBands = timbreBands(sampleRate);
    const logE = new Float64Array(TIMBRE_BANDS);
    const P = new Float32Array(HB);
    const mh = new Float64Array(HB);
    let lp = new Float64Array(NB);
    let lpPrev = new Float64Array(NB);
    let lh = new Float64Array(NB);
    let lhPrev = new Float64Array(NB);
    let pw = new Float64Array(NB); // power S²
    let pwPrev = new Float64Array(NB);
    // the harmonic mask of the frames the chroma windows are centred on, kept for stage 4
    const chromaMask = new Float32Array(chromaFrames * HB);
    const meanFlux = (cur, prev, b0, b1) => {
        let s = 0;
        for (let b = b0; b < b1; b += 1) {
            const d = cur[b] - prev[b];
            if (d > 0) s += d;
        }
        return b1 > b0 ? s / (b1 - b0) : 0;
    };
    const [kick0, kick1] = band.kick;
    const [snareLow0, snareLow1] = band.snareLow;
    const [snareHigh0, snareHigh1] = band.snareHigh;
    const [hat0, hat1] = band.hat;
    for (let f0 = 0; f0 < frames; f0 += step) {
        const end = Math.min(frames, f0 + step);
        for (let f = f0; f < end; f += 1) {
            const row = f * NB;
            const hRow = f * HB;
            medianRow(S, row, HB, KERNEL, P);
            let sumH = 0;
            let sumP = 0;
            for (let b = 0; b < HB; b += 1) {
                const h2 = H[hRow + b] * H[hRow + b];
                const p2 = P[b] * P[b];
                sumH += h2;
                sumP += p2;
                mh[b] = h2 / (h2 + p2 + MASK_EPS);
            }
            percShare[f] = sumP / (sumH + sumP + MASK_EPS);
            for (let b = pLo; b < pHi; b += 1) {
                const x = S[row + b];
                lp[b] = Math.log(1 + GAMMA * (1 - mh[b]) * x);
                pw[b] = x * x;
            }
            for (let b = hLo; b < hHi; b += 1) lh[b] = Math.log(1 + GAMMA * mh[b] * S[row + b]);
            const c = (f - HOLD_SHIFT) / HOLD;
            if (Number.isInteger(c) && c >= 0 && c < chromaFrames) chromaMask.set(mh, c * HB);
            if (f > 0) {
                raw.kick[f] = meanFlux(lp, lpPrev, kick0, kick1);
                let rise = 0;
                let riseLow = 0;
                for (let b = pLo; b < pHi; b += 1) {
                    const d = pw[b] - pwPrev[b];
                    if (d > 0) {
                        rise += d;
                        if (b >= kick0 && b < kick1) riseLow += d;
                    }
                }
                raw.kickShare[f] = rise > 0 ? riseLow / rise : 0;
                raw.snareLow[f] = meanFlux(lp, lpPrev, snareLow0, snareLow1);
                raw.snareHigh[f] = meanFlux(lp, lpPrev, snareHigh0, snareHigh1);
                raw.hat[f] = meanFlux(lp, lpPrev, hat0, hat1);
                raw.harm[f] = meanFlux(lh, lhPrev, hLo, hHi);
            }
            let swap = lp;
            lp = lpPrev;
            lpPrev = swap;
            swap = lh;
            lh = lhPrev;
            lhPrev = swap;
            swap = pw;
            pw = pwPrev;
            pwPrev = swap;
            for (let j = 0; j < TIMBRE_BANDS; j += 1) {
                const [b0, b1] = tBands[j];
                let e = 0;
                for (let b = b0; b < b1; b += 1) e += S[row + b] * S[row + b];
                logE[j] = Math.log(1e-6 + e / (b1 - b0));
            }
            for (let k = 0; k < TIMBRE_COEFFS; k += 1) {
                let v = 0;
                for (let j = 0; j < TIMBRE_BANDS; j += 1) v += DCT[k * TIMBRE_BANDS + j] * logE[j];
                timbreRaw[f * TIMBRE_COEFFS + k] = v;
            }
        }
        done += end - f0;
        yield done / work;
    }

    // 4. chroma on its own longer window, weighted by the harmonic mask, held over the main frames it covers
    const chromaRows = new Float32Array(chromaFrames * 12);
    if (chromaFrames > 0) {
        const magnitudes = makeRealFft(CHROMA_FRAME);
        const window = hannWindow(CHROMA_FRAME);
        const x = new Float64Array(CHROMA_FRAME);
        const mag = new Float64Array(CHROMA_FRAME / 2);
        const df = sampleRate / CHROMA_FRAME;
        const k0 = Math.ceil(CHROMA_LOW_HZ / df);
        const k1 = Math.min(CHROMA_FRAME / 2, Math.floor(CHROMA_HIGH_HZ / df) + 1);
        const pcOf = new Uint8Array(CHROMA_FRAME / 2);
        const poolOf = new Uint16Array(CHROMA_FRAME / 2); // the main-grid bin (below HB) whose mask weights bin k
        for (let k = k0; k < k1; k += 1) {
            const semis = Math.round(12 * Math.log2((k * df) / 261.6256));
            pcOf[k] = ((semis % 12) + 12) % 12;
            poolOf[k] = Math.min(HB - 1, Math.round((k * FRAME) / CHROMA_FRAME) >> 1);
        }
        const acc = new Float64Array(12);
        const cStep = Math.max(1, Math.round(step / HOLD));
        for (let c0 = 0; c0 < chromaFrames; c0 += cStep) {
            const end = Math.min(chromaFrames, c0 + cStep);
            for (let c = c0; c < end; c += 1) {
                const start = c * CHROMA_HOP;
                for (let i = 0; i < CHROMA_FRAME; i += 1) {
                    const v = samples[start + i];
                    x[i] = v - v === 0 ? (v > 1 ? 1 : v < -1 ? -1 : v) * window[i] : 0;
                }
                magnitudes(x, mag);
                acc.fill(0);
                const maskRow = c * HB;
                for (let k = k0; k < k1; k += 1) {
                    const v = chromaMask[maskRow + poolOf[k]] * mag[k];
                    acc[pcOf[k]] += v * v;
                }
                let norm = 0;
                for (let q = 0; q < 12; q += 1) {
                    acc[q] = Math.sqrt(acc[q]);
                    norm += acc[q] * acc[q];
                }
                norm = Math.sqrt(norm);
                if (norm > 1e-9) for (let q = 0; q < 12; q += 1) chromaRows[c * 12 + q] = acc[q] / norm;
            }
            done += HOLD * (end - c0);
            yield Math.min(1, done / work);
        }
    }

    // 5. finish: scale the curves, hold chroma over the main frames, z-score the timbre per song
    // the kick: low-band flux times its share of the rise (the best share within ±1 frame); the snare: both of its
    // bands up within ±1 frame, the weaker of the two
    const kickRaw = new Float32Array(frames);
    const snareRaw = new Float32Array(frames);
    for (let f = 0; f < frames; f += 1) {
        let share = 0;
        let lo = 0;
        let hi = 0;
        for (let g = Math.max(0, f - 1); g <= Math.min(frames - 1, f + 1); g += 1) {
            share = Math.max(share, raw.kickShare[g]);
            lo = Math.max(lo, raw.snareLow[g]);
            hi = Math.max(hi, raw.snareHigh[g]);
        }
        kickRaw[f] = raw.kick[f] * Math.min(1, Math.max(0, (share - KICK_SHARE[0]) / (KICK_SHARE[1] - KICK_SHARE[0])));
        snareRaw[f] = Math.min(lo, hi);
    }
    const chroma = new Float32Array(frames * 12);
    if (chromaFrames > 0) {
        for (let f = 0; f < frames; f += 1) {
            const c = Math.min(chromaFrames - 1, Math.max(0, Math.round((f - HOLD_SHIFT) / HOLD)));
            for (let q = 0; q < 12; q += 1) chroma[f * 12 + q] = quantize(chromaRows[c * 12 + q]);
        }
    }
    const timbre = new Float32Array(frames * TIMBRE_COEFFS);
    for (let k = 0; k < TIMBRE_COEFFS; k += 1) {
        let sum = 0;
        let sq = 0;
        for (let f = 0; f < frames; f += 1) {
            const v = timbreRaw[f * TIMBRE_COEFFS + k];
            sum += v;
            sq += v * v;
        }
        const mean = frames ? sum / frames : 0;
        const sd = Math.sqrt(Math.max(0, (frames ? sq / frames : 0) - mean * mean));
        for (let f = 0; f < frames; f += 1) {
            const z = sd > 1e-6 ? (timbreRaw[f * TIMBRE_COEFFS + k] - mean) / sd : 0;
            timbre[f * TIMBRE_COEFFS + k] = quantize(0.5 + z / TIMBRE_SPREAD);
        }
    }
    return {
        v: STEMS_VERSION,
        sampleRate,
        hopSec: HOP / sampleRate,
        frameOffsetSec: (FRAME - HOP) / sampleRate,
        frames,
        frameTimeSec: frameTimeFor(sampleRate),
        kick: normalizeCurve(smoothCurve(kickRaw, SMOOTH.kick), CURVE_FLOOR.kick),
        snare: normalizeCurve(smoothCurve(snareRaw, SMOOTH.snare), CURVE_FLOOR.snare),
        hat: normalizeCurve(smoothCurve(raw.hat, SMOOTH.hat), CURVE_FLOOR.hat),
        harm: normalizeCurve(smoothCurve(raw.harm, SMOOTH.harm), CURVE_FLOOR.harm),
        percShare,
        chroma,
        timbre,
        ...(debug ? { raw: { ...raw, kickRaw, snareRaw } } : {}),
    };
}

export function computeStemsSync(samples, sampleRate, options) {
    const steps = stemsSteps(samples, sampleRate, options);
    for (;;) {
        const r = steps.next();
        if (r.done) return r.value;
    }
}

// scheduler.yield in the renderer (Chromium); elsewhere a MessageChannel round trip: no timer clamping (Windows
// timers tick every 15.6 ms, which would add most of a second over a song's 40-odd yields).
function defaultPause() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    if (typeof MessageChannel === "function") {
        return new Promise((resolve) => {
            const { port1, port2 } = new MessageChannel();
            port1.onmessage = () => {
                port1.close();
                resolve();
            };
            port2.postMessage(0);
        });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// The same as computeStemsSync, awaiting `pause` between chunks so a renderer can paint its status.
export async function computeStems(samples, sampleRate, { chunk = DEFAULT_CHUNK, pause = defaultPause, onProgress = null } = {}) {
    const steps = stemsSteps(samples, sampleRate, { chunk });
    for (;;) {
        const r = steps.next();
        if (r.done) return r.value;
        onProgress?.(r.value);
        await pause();
    }
}

export function stemsToTransfer(stems) {
    const toBytes = (xs) => Uint8Array.from(xs, (x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
    return {
        v: STEMS_VERSION,
        hopSec: stems.hopSec,
        frameOffsetSec: stems.frameOffsetSec,
        frames: stems.frames,
        kick: stems.kick,
        snare: stems.snare,
        hat: stems.hat,
        harm: stems.harm,
        percShare: stems.percShare,
        chroma: toBytes(stems.chroma),
        timbre: toBytes(stems.timbre),
    };
}

// What is wrong with a StemsTransfer, or null. `frames` is the envelope's frame count, when known.
export function checkStemsTransfer(t, { frames = null } = {}) {
    if (!t || typeof t !== "object") return "stems: not an object";
    if (t.v !== STEMS_VERSION) return `stems.v: ${t.v}, want ${STEMS_VERSION}`;
    if (!(Number.isFinite(t.hopSec) && t.hopSec > 0)) return "stems.hopSec: not a positive number";
    if (!Number.isFinite(t.frameOffsetSec)) return "stems.frameOffsetSec: not a number";
    if (!(Number.isInteger(t.frames) && t.frames >= 0)) return "stems.frames: not a whole number";
    if (frames !== null && Math.abs(t.frames - frames) > FRAME_SLACK) return `stems.frames: ${t.frames}, the envelope has ${frames}`;
    let bytes = 0;
    for (const name of STEM_CURVES) {
        const a = t[name];
        if (!(a instanceof Float32Array)) return `stems.${name}: not a Float32Array`;
        if (a.length !== t.frames) return `stems.${name}: length ${a.length}, want ${t.frames}`;
        bytes += a.byteLength;
    }
    for (const name of ["chroma", "timbre"]) {
        const a = t[name];
        if (!(a instanceof Uint8Array)) return `stems.${name}: not a Uint8Array`;
        if (a.length !== t.frames * 12) return `stems.${name}: length ${a.length}, want ${t.frames * 12}`;
        bytes += a.byteLength;
    }
    if (bytes > MAX_TRANSFER_BYTES) return `stems: ${bytes} bytes, more than ${MAX_TRANSFER_BYTES}`;
    return null;
}

// StemsTransfer → Stems (frame times rebuilt like envelopeFromTransfer). Throws on a bad transfer.
export function stemsFromTransfer(t) {
    const problem = checkStemsTransfer(t);
    if (problem) throw new Error(problem);
    const fromBytes = (a) => Float32Array.from(a, (q) => q / 255);
    const { hopSec, frameOffsetSec } = t;
    return {
        v: t.v,
        hopSec,
        frameOffsetSec,
        frames: t.frames,
        frameTimeSec: (f) => f * hopSec + frameOffsetSec,
        kick: t.kick,
        snare: t.snare,
        hat: t.hat,
        harm: t.harm,
        percShare: t.percShare,
        chroma: fromBytes(t.chroma),
        timbre: fromBytes(t.timbre),
    };
}
