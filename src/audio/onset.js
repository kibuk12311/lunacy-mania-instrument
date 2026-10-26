// Onset strength envelope: positive spectral flux of log-magnitude spectra, normalised to [0, 1].
import { fft } from "./fft.js";

export const FRAME = 1024;
export const HOP = 256;
// Band edges in Hz: kick/bass, snare/vocal/melody, hi-hats/cymbals.
const BAND_EDGES_HZ = [200, 2000];

export function onsetEnvelope(samples, sampleRate) {
    const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
    const values = new Float32Array(frames);
    const energy = new Float32Array(frames); // RMS loudness of each frame, for drop vs light-part detection
    const bands = { low: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames) };
    const lowEnd = Math.max(2, Math.round((BAND_EDGES_HZ[0] / sampleRate) * FRAME));
    const midEnd = Math.round((BAND_EDGES_HZ[1] / sampleRate) * FRAME);
    const bandMax = { low: 0, mid: 0, high: 0 };
    const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
    const re = new Float64Array(FRAME);
    const im = new Float64Array(FRAME);
    let prev = new Float64Array(FRAME / 2);
    let max = 0;
    for (let f = 0; f < frames; f += 1) {
        const start = f * HOP;
        let power = 0;
        for (let i = 0; i < FRAME; i += 1) {
            const x = samples[start + i];
            power += x * x;
            re[i] = x * window[i];
            im[i] = 0;
        }
        energy[f] = Math.sqrt(power / FRAME);
        fft(re, im);
        const mag = new Float64Array(FRAME / 2);
        let flux = 0;
        const bandFlux = { low: 0, mid: 0, high: 0 };
        for (let k = 1; k < FRAME / 2; k += 1) {
            mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
            const d = mag[k] - prev[k];
            if (d > 0) {
                flux += d;
                bandFlux[k < lowEnd ? "low" : k < midEnd ? "mid" : "high"] += d;
            }
        }
        prev = mag;
        values[f] = f === 0 ? 0 : flux;
        if (values[f] > max) max = values[f];
        for (const b of ["low", "mid", "high"]) {
            bands[b][f] = f === 0 ? 0 : bandFlux[b];
            if (bands[b][f] > bandMax[b]) bandMax[b] = bands[b][f];
        }
    }
    if (max > 0) for (let f = 0; f < frames; f += 1) values[f] /= max;
    for (const b of ["low", "mid", "high"]) if (bandMax[b] > 0) for (let f = 0; f < frames; f += 1) bands[b][f] /= bandMax[b];
    // A frame's flux belongs to the moment its newest HOP samples arrive: the window's trailing edge.
    return { values, energy, bands, hopSec: HOP / sampleRate, frameTimeSec: (f) => (f * HOP + FRAME - HOP) / sampleRate, sampleRate };
}

// Functions do not cross process boundaries: send plain data, rebuild the time mapping on the other side.
export function envelopeToTransfer(envelope) {
    return { values: envelope.values, energy: envelope.energy, bands: envelope.bands, hopSec: envelope.hopSec, frameOffsetSec: envelope.frameTimeSec(0) };
}

export function envelopeFromTransfer({ values, energy, bands, hopSec, frameOffsetSec }) {
    return { values, energy, bands, hopSec, frameTimeSec: (f) => f * hopSec + frameOffsetSec };
}
