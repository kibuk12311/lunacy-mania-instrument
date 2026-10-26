import test from "node:test";
import assert from "node:assert/strict";
import { clickTrack } from "../fixtures/clickTrack.js";
import { fft } from "../../src/audio/fft.js";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { detectTiming } from "../../src/audio/tempo.js";

test("fft of a pure tone peaks at its bin", () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
    fft(re, im);
    const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    assert.equal(mag.indexOf(Math.max(...mag.slice(0, n / 2))), 64);
});

test("onset envelope spikes on clicks", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 120, offsetMs: 500, seconds: 6 });
    const env = onsetEnvelope(samples, sampleRate);
    const frameAt = (sec) => Math.round((sec * sampleRate - (1024 - 256)) / 256);
    const near = (sec) => Math.max(...env.values.slice(frameAt(sec) - 2, frameAt(sec) + 3));
    const atClick = near(0.5);
    const between = near(0.75);
    assert.ok(atClick > between * 5, `${atClick} vs ${between}`);
});

for (const [bpm, offsetMs] of [[174, 312], [128, 40], [200, 875], [96, 1200]]) {
    test(`detects ${bpm} BPM at ${offsetMs} ms`, () => {
        const { samples, sampleRate } = clickTrack({ bpm, offsetMs, seconds: 40 });
        const t = detectTiming(onsetEnvelope(samples, sampleRate));
        assert.ok(Math.abs(t.bpm - bpm) <= 0.5, `bpm ${t.bpm}`);
        const beat = 60000 / bpm;
        const phase = ((t.offsetMs - offsetMs) % beat + beat) % beat;
        assert.ok(Math.min(phase, beat - phase) <= 12, `offset ${t.offsetMs}`);
    });
}

test("band envelopes separate bass hits from hi-hat hits", async () => {
    const { onsetEnvelope } = await import("../../src/audio/onset.js");
    const sr = 22050;
    const out = new Float32Array(sr * 4);
    // bass thump at 1.0 s, hi-hat noise burst at 2.0 s
    for (let k = 0; k < 2000; k += 1) out[sr + k] += Math.sin((2 * Math.PI * 55 * k) / sr) * Math.exp(-k / 600);
    let s = 3;
    for (let k = 0; k < 600; k += 1) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const white = (s / 0x7fffffff) * 2 - 1;
        out[2 * sr + k] += (k % 2 ? white : -white) * 0.5 * Math.exp(-k / 120);
    }
    const env = onsetEnvelope(out, sr);
    const at = (sec, arr) => {
        const f = Math.round((sec * sr - (1024 - 256)) / 256);
        return Math.max(...arr.slice(f - 2, f + 4));
    };
    assert.ok(at(1, env.bands.low) > 4 * at(1, env.bands.high), "bass hit is low-band");
    // a sharp transient leaks into every band, so the hi-hat only has to dominate, not be alone
    assert.ok(at(2, env.bands.high) > 2 * at(2, env.bands.low), "hi-hat is high-band");
});

// ---- sectioned timing (mapgen v3) ----
const sectionsOf = async (track, options = {}) => {
    const { detectTimingSections } = await import("../../src/audio/tempo.js");
    return detectTimingSections(onsetEnvelope(track.samples, track.sampleRate), options);
};

test("a click track 140→180 BPM at 20 s gives 2 sections, the start within 15 ms and the BPM within 0.05", async () => {
    const { tempoMapTrack } = await import("../fixtures/clickTrack.js");
    const track = tempoMapTrack([{ timeMs: 300, bpm: 140 }, { timeMs: 20000, bpm: 180 }], { seconds: 50 });
    const found = await sectionsOf(track);
    assert.equal(found.sections.length, 2, JSON.stringify(found.sections));
    assert.equal(found.variable, true);
    const [a, b] = found.sections;
    assert.ok(Math.abs(a.bpm - 140) <= 0.05 && Math.abs(b.bpm - 180) <= 0.05, `${a.bpm} ${b.bpm}`);
    assert.ok(Math.abs(b.timeMs - 20000) <= 15, `start ${b.timeMs}`);
    const beat = 60000 / 140;
    const phase = ((a.timeMs - 300) % beat + beat) % beat;
    assert.ok(Math.min(phase, beat - phase) <= 12, `first red line ${a.timeMs}`);
    assert.ok(found.confidence > 0 && found.confidence <= 1);
});

test("with fine onsets the sections land on the clicks to the millisecond", async () => {
    const { tempoMapTrack } = await import("../fixtures/clickTrack.js");
    const { fineOnset, OFFSET_BIAS_MS } = await import("../../src/audio/fineOnset.js");
    const { detectTimingFull } = await import("../../src/audio/timingJob.js");
    const track = tempoMapTrack([{ timeMs: 300.4, bpm: 140 }, { timeMs: 20000.4, bpm: 180 }], { seconds: 50 });
    const timing = detectTimingFull({ envelope: onsetEnvelope(track.samples, track.sampleRate), fine: fineOnset(track.samples, track.sampleRate) });
    assert.deepEqual(timing.sections.map((s) => s.bpm), [140, 180]);
    assert.ok(Math.abs(timing.sections[1].timeMs - (20000.4 + OFFSET_BIAS_MS)) <= 1, `start ${timing.sections[1].timeMs}`);
    assert.ok(Math.abs(timing.sections[0].timeMs - (300.4 + OFFSET_BIAS_MS)) <= 1, `first ${timing.sections[0].timeMs}`);
    assert.ok(timing.sections.every((s) => Number.isInteger(s.timeMs)), "red lines are whole ms");
    assert.equal(timing.bpm, 140);
    assert.equal(timing.offsetMs, timing.sections[0].timeMs);
    assert.equal(timing.variable, true);
    assert.ok(timing.refinedErrMs !== null && timing.refinedErrMs < 2);
});

test("constant 174 BPM gives variable === false and the same result as detectTiming", async () => {
    const { detectTimingFull } = await import("../../src/audio/timingJob.js");
    const track = clickTrack({ bpm: 174, offsetMs: 312, seconds: 60 });
    const env = onsetEnvelope(track.samples, track.sampleRate);
    const one = detectTiming(env);
    const found = await sectionsOf(track);
    assert.equal(found.variable, false);
    assert.deepEqual(found.sections, [{ timeMs: one.offsetMs, bpm: one.bpm, meter: 4 }]);
    const timing = detectTimingFull({ envelope: env });
    assert.deepEqual(timing.sections, [{ timeMs: one.offsetMs, bpm: one.bpm, meter: 4 }]);
    assert.equal(timing.bpm, one.bpm);
    assert.equal(timing.offsetMs, one.offsetMs);
    assert.equal(timing.variable, false);
});

test("a double-time hi-hat part does not split the song", async () => {
    const track = clickTrack({ bpm: 100, offsetMs: 300, seconds: 60, hats: { fromMs: 20000, toMs: 40000, div: 2 } });
    const found = await sectionsOf(track);
    assert.equal(found.sections.length, 1, JSON.stringify(found.sections));
    assert.equal(found.sections[0].bpm, 100);
});

test("three sections, and maxSections keeps the count down", async () => {
    const { tempoMapTrack } = await import("../fixtures/clickTrack.js");
    const track = tempoMapTrack([{ timeMs: 500, bpm: 128 }, { timeMs: 30000, bpm: 170 }, { timeMs: 60000, bpm: 128 }], { seconds: 90 });
    const found = await sectionsOf(track);
    assert.deepEqual(found.sections.map((s) => Math.round(s.bpm)), [128, 170, 128]);
    assert.ok(Math.abs(found.sections[1].timeMs - 30000) <= 15 && Math.abs(found.sections[2].timeMs - 60000) <= 15);
    const two = await sectionsOf(track, { maxSections: 2 });
    assert.equal(two.sections.length, 2);
});

test("a hint is refined around its own values instead of detected again", async () => {
    const { fineOnset, OFFSET_BIAS_MS } = await import("../../src/audio/fineOnset.js");
    const { detectTimingFull } = await import("../../src/audio/timingJob.js");
    const track = clickTrack({ bpm: 174, offsetMs: 312.4, seconds: 40 });
    const envelope = onsetEnvelope(track.samples, track.sampleRate);
    const fine = fineOnset(track.samples, track.sampleRate);
    // the user put the first red line a beat late and the BPM a little off
    const hint = { sections: [{ timeMs: 312 + 60000 / 174 + 9, bpm: 173.6, meter: 4 }], bpm: 173.6, offsetMs: 0 };
    const timing = detectTimingFull({ envelope, fine, hint });
    assert.equal(timing.sections.length, 1);
    assert.equal(timing.bpm, 174);
    assert.ok(Math.abs(timing.offsetMs - (312.4 + 60000 / 174 + OFFSET_BIAS_MS)) <= 1, `red line ${timing.offsetMs}`);
});
