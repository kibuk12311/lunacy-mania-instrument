import test from "node:test";
import assert from "node:assert/strict";
import { fft } from "../../src/audio/fft.js";
import { BINS, makeRealFft, slidingMedian, spectrogram, hpss, timeMedianFilter, medianRow, harmonicMask } from "../../src/audio/hpss.js";
import { sineWithClicks } from "../fixtures/stemTracks.js";

function lcg(seed) {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const naiveMedian = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
};

test("the real FFT gives the same magnitudes as fft.js", () => {
    const rand = lcg(1);
    for (const n of [4, 8, 16, 32, 64, 1024, 2048, 4096]) {
        const x = Float64Array.from({ length: n }, () => rand() * 2 - 1);
        const re = Float64Array.from(x);
        const im = new Float64Array(n);
        fft(re, im);
        const out = new Float64Array(n / 2);
        makeRealFft(n)(x, out);
        for (let k = 0; k < n / 2; k += 1) assert.ok(Math.abs(out[k] - Math.hypot(re[k], im[k])) < 1e-9 * n, `n ${n} bin ${k}`);
    }
});

test("the sliding median equals a naive median on random data", () => {
    const rand = lcg(2);
    for (const [len, kernel] of [[1, 17], [5, 17], [16, 17], [17, 17], [300, 17], [300, 5], [64, 1], [200, 9]]) {
        // ties on purpose: values on a coarse grid
        const values = Float32Array.from({ length: len }, () => Math.round(rand() * 20) / 4);
        const got = slidingMedian(values, kernel);
        const h = kernel >> 1;
        for (let i = 0; i < len; i += 1) {
            const want = naiveMedian(values.slice(Math.max(0, i - h), Math.min(len, i + h + 1)));
            assert.equal(got[i], want, `len ${len} kernel ${kernel} at ${i}`);
        }
    }
});

test("time and frequency medians over a spectrogram equal naive ones, also when run in chunks", () => {
    const rand = lcg(3);
    const frames = 50;
    const bins = 40;
    const S = Float32Array.from({ length: frames * bins }, () => rand());
    const kernel = 7;
    const h = kernel >> 1;
    const { H, P } = hpss(S, frames, bins, { kernelTime: kernel, kernelFreq: kernel });
    const chunked = new Float32Array(frames * bins);
    const filter = timeMedianFilter(S, frames, bins, kernel);
    for (const upTo of [3, 4, 20, 49, 50]) filter.advance(upTo, chunked);
    const row = new Float32Array(bins);
    for (let f = 0; f < frames; f += 1) {
        medianRow(S, f * bins, bins, kernel, row);
        for (let b = 0; b < bins; b += 1) {
            const column = [];
            for (let g = Math.max(0, f - h); g < Math.min(frames, f + h + 1); g += 1) column.push(S[g * bins + b]);
            const across = Array.from(S.subarray(f * bins + Math.max(0, b - h), f * bins + Math.min(bins, b + h + 1)));
            assert.equal(H[f * bins + b], naiveMedian(column), `H ${f},${b}`);
            assert.equal(chunked[f * bins + b], naiveMedian(column), `chunked H ${f},${b}`);
            assert.equal(P[f * bins + b], naiveMedian(across), `P ${f},${b}`);
            assert.equal(row[b], naiveMedian(across), `row ${f},${b}`);
        }
    }
});

test("a sine lands in H and clicks land in P", () => {
    const track = sineWithClicks({ seconds: 6 });
    const mix = spectrogram(track.samples);
    assert.equal(mix.bins, BINS);
    const { H, P } = hpss(mix.S, mix.frames, mix.bins);
    const Mh = harmonicMask(H, P);
    const sine = spectrogram(track.sine).S;
    let kept = 0;
    let total = 0;
    for (let i = 0; i < sine.length; i += 1) {
        kept += (Mh[i] * sine[i]) ** 2;
        total += sine[i] ** 2;
    }
    assert.ok(kept / total >= 0.9, `sine energy in H ${(kept / total).toFixed(3)}`);
    const clicks = spectrogram(track.clicks).S;
    for (const t of track.clickTimesMs) {
        const s0 = Math.round((t / 1000) * track.sampleRate);
        let inP = 0;
        let all = 0;
        for (let f = Math.max(0, Math.ceil((s0 - 1023) / 256)); f <= Math.min(mix.frames - 1, Math.floor((s0 + 400) / 256)); f += 1) {
            for (let b = 0; b < mix.bins; b += 1) {
                const i = f * mix.bins + b;
                inP += ((1 - Mh[i]) * clicks[i]) ** 2;
                all += clicks[i] ** 2;
            }
        }
        assert.ok(inP / all >= 0.8, `click at ${t} ms: energy in P ${(inP / all).toFixed(3)}`);
    }
});
