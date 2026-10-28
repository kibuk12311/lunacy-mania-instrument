// The wave strip's drawing on loud, limited, bass-heavy masters: a 300 Hz high-pass of the samples scaled to the song's
// 99.9th percentile of 256-sample block peaks, and the onset envelope as bars from the bottom scaled to its 20th–99.5th
// percentile. A clipped bass + kicks song is a wall in the raw min/max and shows its beats after; scales are song-wide.
import test from "node:test";
import assert from "node:assert/strict";
import { peaks, highPass, blockScale, envelopeRange, envelopeHeights, prepareWave, drawWave, createWaveStrip, ENVELOPE_COLOR } from "../../app/renderer/waveStrip.js";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { fakeDom } from "../helpers/fakeDom.js";

const SR = 22050;
const sine = (hz, sec, amp = 1) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const peakOf = (x, from = 0) => { let m = 0; for (let i = from; i < x.length; i += 1) m = Math.max(m, Math.abs(x[i])); return m; };

// 8 s at 150 BPM: a 75 Hz bass driven into the limiter (clipped at ±0.9) all through, and on every beat a 25 ms
// burst of noise-like 3–6 kHz kick/snare click on top, then clipped again like a loud master
function loudSong() {
    const n = 8 * SR;
    const x = new Float32Array(n);
    const beat = Math.round(0.4 * SR);
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    for (let i = 0; i < n; i += 1) {
        let v = Math.max(-0.9, Math.min(0.9, 1.6 * Math.sin((2 * Math.PI * 75 * i) / SR)));
        const k = i % beat;
        if (k < 0.025 * SR) v += 0.5 * rnd() * (1 - k / (0.025 * SR));
        x[i] = Math.max(-1, Math.min(1, v));
    }
    return { samples: x, beatMs: 400 };
}

test("highPass: a 2nd-order 300 Hz high-pass takes the bass down and lets the treble through", () => {
    const skip = SR / 10; // past the filter's start
    assert.ok(peakOf(highPass(sine(60, 1), SR), skip) < 0.06, "60 Hz: −25 dB or more");
    assert.ok(Math.abs(peakOf(highPass(sine(300, 1), SR), skip) - Math.SQRT1_2) < 0.02, "−3 dB at the cutoff");
    assert.ok(peakOf(highPass(sine(4000, 1), SR), skip) > 0.98, "4 kHz passes");
    assert.equal(highPass(new Float32Array(0), SR).length, 0);
});

test("blockScale: the 99.9th percentile of 256-sample block peaks; a few clicks do not set it; silence has a floor", () => {
    const x = new Float32Array(256 * 10000).fill(0);
    for (let b = 0; b < 10000; b += 1) x[b * 256 + 7] = 0.25;
    for (let b = 0; b < 5; b += 1) x[b * 256 + 9] = 1; // 0.05 % of the blocks
    assert.equal(blockScale(x), 0.25);
    assert.equal(blockScale(new Float32Array(SR)), 1e-3);
    assert.equal(blockScale(new Float32Array(10)), 1e-3);
});

test("envelopeRange / envelopeHeights: song-wide 20th–99.5th percentile, per-pixel max, clamped 0..1", () => {
    const values = Float32Array.from({ length: 1000 }, (_, i) => (i + 1) / 1000);
    const range = envelopeRange(values);
    assert.ok(Math.abs(range.lo - 0.2) < 0.002 && Math.abs(range.lo + range.span - 0.995) < 0.002, JSON.stringify(range));
    assert.deepEqual(envelopeRange([]), { lo: 0, span: 1 });
    assert.deepEqual(envelopeRange(undefined), { lo: 0, span: 1 });
    // one frame per 10 ms, a spike at frame 50 (≈ 0.5 s)
    const env = { values: new Float32Array(200).fill(0.1), hopSec: 0.01, frameTimeSec: (f) => f * 0.01 + 0.005 };
    env.values[50] = 1;
    const r = envelopeRange(env.values);
    const h = envelopeHeights(env, r, { startMs: 0, spanMs: 2000 }, 200);
    assert.equal(h.length, 200);
    const top = Math.max(...h);
    assert.ok(top > 0.85, `spike drawn ${top}`);
    const at = h.indexOf(top);
    assert.ok(at >= 48 && at <= 51, `spike at px ${at}`);
    assert.ok(h.every((v) => v >= 0 && v <= 1));
    assert.equal(h[150], 0, "the 20th percentile is the floor");
    // the transfer form ({ frameOffsetSec }) and no envelope
    const viaTransfer = envelopeHeights({ values: env.values, hopSec: 0.01, frameOffsetSec: 0.005 }, r, { startMs: 0, spanMs: 2000 }, 200);
    assert.deepEqual([...viaTransfer], [...h]);
    assert.deepEqual([...envelopeHeights(null, r, { startMs: 0, spanMs: 2000 }, 4)], [0, 0, 0, 0]);
});

test("a loud clipped bass master: a wall in the raw min/max, beats stand out after; heights do not depend on the view", () => {
    const { samples, beatMs } = loudSong();
    const envelope = onsetEnvelope(samples, SR);
    const wave = prepareWave({ samples, sampleRate: SR, envelope });
    const view = { startMs: 2000, spanMs: 6000 };
    const width = 432;
    const raw = peaks(samples, SR, view, width);
    let rawWall = 0;
    for (let x = 0; x < width; x += 1) if ((raw[2 * x + 1] - raw[2 * x]) / 2 >= 0.85) rawWall += 1;
    assert.ok(rawWall / width > 0.95, `raw wall ${rawWall / width}`);

    const calls = [];
    const ctx = { set fillStyle(v) { calls.push(["style", v]); }, set globalAlpha(v) { calls.push(["alpha", v]); }, fillRect: (...a) => calls.push(["rect", ...a]) };
    const { bars, wave: drawn } = drawWave(ctx, wave, view, width, 96);
    const pxOf = (ms) => Math.floor(((ms - view.startMs) / view.spanMs) * width);
    const onBeat = (h) => { const out = []; for (let t = view.startMs; t < view.startMs + view.spanMs; t += beatMs) out.push(Math.max(...h.slice(pxOf(t), pxOf(t + 30) + 1))); return out; };
    const between = (h) => { const out = []; for (let t = view.startMs; t < view.startMs + view.spanMs; t += beatMs) out.push(Math.max(...h.slice(pxOf(t + 150), pxOf(t + 250) + 1))); return out; };
    for (const [name, h] of [["high-pass", drawn], ["envelope", bars]]) {
        const on = Math.min(...onBeat(h));
        const off = Math.max(...between(h));
        assert.ok(on > off + 0.25, `${name}: on-beat ${on.toFixed(2)} vs between ${off.toFixed(2)}`);
        assert.ok(h.filter((v) => v >= 0.9).length / width < 0.1, `${name}: no wall`);
    }
    // what drawWave paints: bars in the envelope colour from the bottom, then the waveform; alpha back to 1
    assert.ok(calls.some((c) => c[0] === "style" && c[1] === ENVELOPE_COLOR));
    assert.deepEqual(calls.at(-1)?.slice(0, 1), ["alpha"]);
    assert.equal(calls.at(-1)[1], 1);
    const barRects = calls.filter((c) => c[0] === "rect" && Math.abs(c[2] + c[4] - 96) < 1e-9 && c[4] > 10);
    assert.ok(barRects.length > 0, "bars stand on the bottom edge");

    // song-wide scales: the same moment draws the same height whatever the view's start
    const a = drawWave({ fillRect() {} }, wave, { startMs: 2000, spanMs: 6000 }, width, 96);
    const b = drawWave({ fillRect() {} }, wave, { startMs: 2000 + (6000 / width) * 100, spanMs: 6000 }, width, 96);
    for (let x = 100; x < width; x += 1) {
        assert.ok(Math.abs(a.wave[x] - b.wave[x - 100]) < 1e-6 && Math.abs(a.bars[x] - b.bars[x - 100]) < 1e-6, `px ${x}`);
    }
});

test("a quiet song fills the strip as well (the scale is the song's own), and silence stays flat", () => {
    const { samples } = loudSong();
    const quiet = samples.map((v) => v * 0.02); // about −34 dB
    const loud = prepareWave({ samples, sampleRate: SR });
    const soft = prepareWave({ samples: quiet, sampleRate: SR });
    const view = { startMs: 2000, spanMs: 6000 };
    const a = drawWave({ fillRect() {} }, loud, view, 432, 96).wave;
    const b = drawWave({ fillRect() {} }, soft, view, 432, 96).wave;
    for (let x = 0; x < 432; x += 1) assert.ok(Math.abs(a[x] - b[x]) < 1e-3, `px ${x}: ${a[x]} vs ${b[x]}`);
    const silent = prepareWave({ samples: Float32Array.from({ length: 4 * SR }, (_, i) => (i % 2 ? 1e-6 : -1e-6)), sampleRate: SR });
    assert.ok(drawWave({ fillRect() {} }, silent, view, 432, 96).wave.every((v) => v < 0.01), "dither is not blown up");
    assert.ok(drawWave({ fillRect() {} }, silent, view, 432, 96).bars.every((v) => v === 0), "no envelope, no bars");
});

test("the strip draws both layers once a song with an envelope is set, and only the waveform without one", () => {
    const { $ } = fakeDom({});
    const canvas = $("wave-strip");
    const strip = createWaveStrip({ canvas, getTiming: () => ({ sections: [{ timeMs: 0, bpm: 150, meter: 4 }] }), getSelected: () => 0, getCursor: () => 0 });
    const { samples } = loudSong();
    const ctx = canvas.getContext("2d");
    strip.setSong({ samples, sampleRate: SR, durationMs: 8000 });
    const rects = () => ctx.calls.filter((c) => c[0] === "fillRect").length;
    const plain = rects();
    ctx.calls.length = 0;
    strip.setSong({ samples, sampleRate: SR, durationMs: 8000, envelope: onsetEnvelope(samples, SR) });
    assert.ok(rects() > plain + 50, `${rects()} rects with the envelope vs ${plain} without`);
    assert.equal(ctx.globalAlpha, 1);
    strip.setSong(null);
    assert.equal(canvas.hidden, true);
});
