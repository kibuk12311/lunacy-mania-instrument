// Light harmonic/percussive separation (Fitzgerald 2010) in plain JS: a pooled magnitude spectrogram on the onset
// envelope's frame grid, a median over time (harmonic: steady in time) and a median over frequency (percussive: flat
// across frequency) per cell, and soft masks from the two. Used by stems.js in the renderer and in the dataset tools.
//
// Speed matters here (a 4-minute song is about 20,700 frames): the FFT is a real FFT through a half-size radix-4 one
// with precomputed tables, and the medians keep a sorted window that slides one value at a time.
import { FRAME, HOP } from "./onset.js";

// the onset envelope's frame and hop (1024, 256), so frame f is the same moment in both
export { FRAME, HOP };
export const BINS = FRAME / 4; // FRAME/2 FFT bins pooled in pairs: 256 bins of about 43 Hz at 22,050 Hz
export const KERNEL = 17; // about 200 ms in time, about 730 Hz in frequency

export const frameCount = (length, frame = FRAME, hop = HOP) => Math.max(0, Math.floor((length - frame) / hop) + 1);

export function hannWindow(n) {
    return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
}

// Magnitudes |X[k]|, k = 0 … n/2 − 1, of a real signal of n samples (n a power of two, at least 4).
// → magnitudes(x: Float64Array(n), out: n/2 numbers). The tables are built once per size.
export function makeRealFft(n) {
    if (!(n >= 4) || (n & (n - 1)) !== 0) throw new Error(`real FFT size must be a power of two ≥ 4, got ${n}`);
    const m = n >> 1;
    const rev = new Uint32Array(m);
    for (let i = 1, j = 0; i < m; i += 1) {
        let bit = m >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        rev[i] = j;
    }
    // e^(−2πit/m) over the whole circle: radix-4 butterflies need W^(3k)
    const twr = new Float64Array(m);
    const twi = new Float64Array(m);
    for (let t = 0; t < m; t += 1) {
        twr[t] = Math.cos((2 * Math.PI * t) / m);
        twi[t] = -Math.sin((2 * Math.PI * t) / m);
    }
    const pwr = new Float64Array(m);
    const pwi = new Float64Array(m);
    for (let k = 0; k < m; k += 1) {
        pwr[k] = Math.cos((2 * Math.PI * k) / n);
        pwi[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    const oddLevels = Math.log2(m) % 2 === 1;
    const zr = new Float64Array(m);
    const zi = new Float64Array(m);
    return function magnitudes(x, out) {
        // even samples as the real part, odd ones as the imaginary part, loaded in bit-reversed order
        for (let i = 0; i < m; i += 1) {
            const j = rev[i];
            zr[j] = x[2 * i];
            zi[j] = x[2 * i + 1];
        }
        let h = 1;
        if (oddLevels) {
            for (let a = 0; a < m; a += 2) {
                const tr = zr[a + 1];
                const ti = zi[a + 1];
                zr[a + 1] = zr[a] - tr;
                zi[a + 1] = zi[a] - ti;
                zr[a] += tr;
                zi[a] += ti;
            }
            h = 2;
        }
        // radix-4 decimation in time: four blocks of h (in bit-reversed order: the DFTs of residues 0, 2, 1, 3) make
        // one of 4h. X[k + q·h] = A + (−i)^q·B + (−1)^q·C + i^q·D with A = E0, B = W^k·E1, C = W^2k·E2, D = W^3k·E3.
        for (; h < m; h *= 4) {
            const span = 4 * h;
            const step = m / span;
            for (let s0 = 0; s0 < m; s0 += span) {
                for (let k = 0; k < h; k += 1) {
                    const i0 = s0 + k;
                    const i1 = i0 + h;
                    const i2 = i1 + h;
                    const i3 = i2 + h;
                    const t1 = k * step;
                    const t2 = 2 * t1;
                    const t3 = 3 * t1;
                    const ar = zr[i0];
                    const ai = zi[i0];
                    const xr2 = zr[i2];
                    const xi2 = zi[i2];
                    const br = xr2 * twr[t1] - xi2 * twi[t1];
                    const bi = xr2 * twi[t1] + xi2 * twr[t1];
                    const xr1 = zr[i1];
                    const xi1 = zi[i1];
                    const cr = xr1 * twr[t2] - xi1 * twi[t2];
                    const ci = xr1 * twi[t2] + xi1 * twr[t2];
                    const xr3 = zr[i3];
                    const xi3 = zi[i3];
                    const dr = xr3 * twr[t3] - xi3 * twi[t3];
                    const di = xr3 * twi[t3] + xi3 * twr[t3];
                    const s0r = ar + cr;
                    const s0i = ai + ci;
                    const s1r = ar - cr;
                    const s1i = ai - ci;
                    const s2r = br + dr;
                    const s2i = bi + di;
                    const s3r = br - dr;
                    const s3i = bi - di;
                    zr[i0] = s0r + s2r;
                    zi[i0] = s0i + s2i;
                    zr[i2] = s0r - s2r;
                    zi[i2] = s0i - s2i;
                    zr[i1] = s1r + s3i;
                    zi[i1] = s1i - s3r;
                    zr[i3] = s1r - s3i;
                    zi[i3] = s1i + s3r;
                }
            }
        }
        // split the half-size transform into the spectra of the even and odd samples, then combine them
        out[0] = Math.abs(zr[0] + zi[0]);
        for (let k = 1; k < m; k += 1) {
            const ar = zr[k];
            const ai = zi[k];
            const br = zr[m - k];
            const bi = -zi[m - k];
            const er = 0.5 * (ar + br);
            const ei = 0.5 * (ai + bi);
            const or = 0.5 * (ai - bi);
            const oi = -0.5 * (ar - br);
            const wr = pwr[k];
            const wi = pwi[k];
            const xr = er + wr * or - wi * oi;
            const xi = ei + wr * oi + wi * or;
            out[k] = Math.sqrt(xr * xr + xi * xi);
        }
    };
}

// The pooled magnitude spectrogram, filled frame by frame: S[f·bins + p] = mean of FFT bins 2p and 2p + 1 of frame f
// (samples f·hop … f·hop + frame, Hann window). Non-finite samples count as silence, and samples beyond full scale
// are clipped to ±1 as Chromium's decoder does (ffmpeg's float output of a hot file can reach 2), so the app and the
// dataset tools see the same spectrum.
export function spectrogramRunner(samples, { frame = FRAME, hop = HOP } = {}) {
    const frames = frameCount(samples.length, frame, hop);
    const bins = frame >> 2;
    const S = new Float32Array(frames * bins);
    const magnitudes = makeRealFft(frame);
    const window = hannWindow(frame);
    const x = new Float64Array(frame);
    const mag = new Float64Array(frame >> 1);
    let next = 0;
    return {
        frames,
        bins,
        S,
        get done() {
            return next >= frames;
        },
        advance(upTo) {
            for (const end = Math.min(upTo, frames); next < end; next += 1) {
                const start = next * hop;
                for (let i = 0; i < frame; i += 1) {
                    const v = samples[start + i];
                    x[i] = v - v === 0 ? (v > 1 ? 1 : v < -1 ? -1 : v) * window[i] : 0;
                }
                magnitudes(x, mag);
                const row = next * bins;
                for (let p = 0; p < bins; p += 1) S[row + p] = 0.5 * (mag[2 * p] + mag[2 * p + 1]);
            }
        },
    };
}

export function spectrogram(samples, options) {
    const run = spectrogramRunner(samples, options);
    run.advance(run.frames);
    return { S: run.S, frames: run.frames, bins: run.bins };
}

// ---- sliding sorted-window medians -------------------------------------------------------------------------------
// A window of the values i − h … i + h (cut at the ends), kept sorted; the median is the element at len >> 1 (the
// upper one of the two middle values when the cut window is even). Values must be finite. Windows are Float64Array,
// so every stored value compares equal to the value it came from, whatever the source array type.

function insertSorted(win, o, len, x) {
    let j = o + len;
    while (j > o && win[j - 1] > x) {
        win[j] = win[j - 1];
        j -= 1;
    }
    win[j] = x;
}

// The index of x in the sorted window (a binary search; x is there unless the input had NaNs).
function indexOfSorted(win, o, len, x) {
    let lo = o;
    let hi = o + len - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (win[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function removeSorted(win, o, len, x) {
    const end = o + len - 1;
    for (let i = indexOfSorted(win, o, len, x); i < end; i += 1) win[i] = win[i + 1];
}

// Swap one value for another and move the new one to its place: about a third of the work of remove + insert.
function replaceSorted(win, o, len, old, x) {
    const end = o + len - 1;
    let i = indexOfSorted(win, o, len, old);
    if (x > old) {
        while (i < end && win[i + 1] < x) {
            win[i] = win[i + 1];
            i += 1;
        }
    } else {
        while (i > o && win[i - 1] > x) {
            win[i] = win[i - 1];
            i -= 1;
        }
    }
    win[i] = x;
}

const scratchWindows = new Map();
const scratchFor = (kernel) => {
    let w = scratchWindows.get(kernel);
    if (!w) scratchWindows.set(kernel, (w = new Float64Array(kernel)));
    return w;
};

// Median over a window of `kernel` values of src[offset … offset + n), written to out[outOffset …].
export function medianRow(src, offset, n, kernel, out, outOffset = 0) {
    const h = kernel >> 1;
    const win = scratchFor(kernel);
    let len = 0;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i += 1) {
        const wantHi = Math.min(n, i + h + 1);
        const wantLo = Math.max(0, i - h);
        while (hi < wantHi && lo < wantLo) {
            replaceSorted(win, 0, len, src[offset + lo], src[offset + hi]);
            lo += 1;
            hi += 1;
        }
        while (hi < wantHi) {
            insertSorted(win, 0, len, src[offset + hi]);
            len += 1;
            hi += 1;
        }
        while (lo < wantLo) {
            removeSorted(win, 0, len, src[offset + lo]);
            len -= 1;
            lo += 1;
        }
        out[outOffset + i] = win[len >> 1];
    }
    return out;
}

export function slidingMedian(values, kernel = KERNEL) {
    return medianRow(values, 0, values.length, kernel, new Float32Array(values.length));
}

// Median over time for every bin at once (one sorted window per bin), frame by frame: advance(upTo, H) writes the
// rows of H up to frame upTo (exclusive). Rows can be asked for in any number of steps, so the caller can yield.
// Only the first `bins` of each row of S (rows `stride` apart) are filtered; H has rows of `bins`.
export function timeMedianFilter(S, frames, bins, kernel = KERNEL, stride = bins) {
    const h = kernel >> 1;
    const win = new Float64Array(bins * kernel);
    let len = 0;
    let lo = 0;
    let hi = 0;
    let next = 0;
    const insertRow = (g) => {
        const row = g * stride;
        for (let b = 0; b < bins; b += 1) insertSorted(win, b * kernel, len, S[row + b]);
        len += 1;
    };
    const removeRow = (g) => {
        const row = g * stride;
        for (let b = 0; b < bins; b += 1) removeSorted(win, b * kernel, len, S[row + b]);
        len -= 1;
    };
    const replaceRow = (gOld, gNew) => {
        const rowOld = gOld * stride;
        const rowNew = gNew * stride;
        for (let b = 0; b < bins; b += 1) replaceSorted(win, b * kernel, len, S[rowOld + b], S[rowNew + b]);
    };
    return {
        get next() {
            return next;
        },
        advance(upTo, H) {
            for (const end = Math.min(upTo, frames); next < end; next += 1) {
                const wantHi = Math.min(frames, next + h + 1);
                const wantLo = Math.max(0, next - h);
                while (hi < wantHi && lo < wantLo) replaceRow(lo++, hi++);
                while (hi < wantHi) insertRow(hi++);
                while (lo < wantLo) removeRow(lo++);
                const mid = len >> 1;
                const row = next * bins;
                for (let b = 0; b < bins; b += 1) H[row + b] = win[b * kernel + mid];
            }
        },
    };
}

// Both medians of a whole spectrogram: { H (over time), P (over frequency) }.
export function hpss(S, frames, bins, { kernelTime = KERNEL, kernelFreq = KERNEL } = {}) {
    const H = new Float32Array(frames * bins);
    const P = new Float32Array(frames * bins);
    timeMedianFilter(S, frames, bins, kernelTime).advance(frames, H);
    for (let f = 0; f < frames; f += 1) medianRow(S, f * bins, bins, kernelFreq, P, f * bins);
    return { H, P };
}

export const MASK_EPS = 1e-10;

// Soft harmonic mask Mh = H² / (H² + P² + ε); the percussive mask is 1 − Mh.
export function harmonicMask(H, P, eps = MASK_EPS) {
    const out = new Float32Array(H.length);
    for (let i = 0; i < H.length; i += 1) {
        const h2 = H[i] * H[i];
        out[i] = h2 / (h2 + P[i] * P[i] + eps);
    }
    return out;
}
