import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope, envelopeToTransfer, envelopeFromTransfer } from "../../src/audio/onset.js";
import { STEMS_VERSION, STEM_CURVES, computeStems, computeStemsSync, stemsToTransfer, stemsFromTransfer, checkStemsTransfer, PITCH_CLASSES } from "../../src/audio/stems.js";
import { kickTrack, hatTrack, snareTrack, drumLoop, chordTrack, sineWithClicks, NOTE_HZ } from "../fixtures/stemTracks.js";

// The strongest value of a curve from 30 ms before to 60 ms after an event.
const peakAt = (stems, curve, tMs) => {
    let best = 0;
    for (let f = 0; f < stems.frames; f += 1) {
        const t = stems.frameTimeSec(f) * 1000;
        if (t >= tMs - 30 && t <= tMs + 60) best = Math.max(best, curve[f]);
    }
    return best;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const max = (xs) => xs.reduce((a, b) => Math.max(a, b), 0);

// Mean chroma over the frames that have sound, and the pitch classes by strength.
function chromaOrder(stems) {
    const sum = new Float64Array(12);
    for (let f = 0; f < stems.frames; f += 1) for (let k = 0; k < 12; k += 1) sum[k] += stems.chroma[f * 12 + k];
    return [...sum.keys()].sort((a, b) => sum[b] - sum[a]).map((k) => PITCH_CLASSES[k]);
}

test("the frame grid is onsetEnvelope's, also after a transfer", () => {
    const { samples, sampleRate } = sineWithClicks({ seconds: 5 });
    const env = onsetEnvelope(samples, sampleRate);
    const stems = computeStemsSync(samples, sampleRate);
    assert.equal(stems.v, STEMS_VERSION);
    assert.equal(stems.frames, env.values.length);
    assert.equal(stems.hopSec, env.hopSec);
    for (let f = 0; f < stems.frames; f += 1) assert.equal(stems.frameTimeSec(f), env.frameTimeSec(f));
    const back = stemsFromTransfer(stemsToTransfer(stems));
    const envBack = envelopeFromTransfer(envelopeToTransfer(env));
    for (let f = 0; f < stems.frames; f += 1) assert.equal(back.frameTimeSec(f), envBack.frameTimeSec(f));
    for (const name of STEM_CURVES) {
        assert.equal(stems[name].length, stems.frames, name);
        assert.ok(stems[name].every((x) => Number.isFinite(x) && x >= 0 && x <= 1), name);
    }
    assert.equal(stems.chroma.length, stems.frames * 12);
    assert.equal(stems.timbre.length, stems.frames * 12);
});

test("a 60 Hz decaying burst peaks kick and not hat or snare", () => {
    const track = kickTrack();
    const stems = computeStemsSync(track.samples, track.sampleRate);
    const kicks = track.times.map((t) => peakAt(stems, stems.kick, t));
    assert.ok(mean(kicks) >= 0.7 && Math.min(...kicks) >= 0.4, `kick peaks ${kicks.map((x) => x.toFixed(2))}`);
    assert.ok(max(stems.hat) <= 0.25, `hat max ${max(stems.hat).toFixed(2)}`);
    // the burst's sharp start reaches the snare's upper band a little; a real snare there reads about 0.85
    assert.ok(max(stems.snare) <= 0.4, `snare max ${max(stems.snare).toFixed(2)}`);
});

test("high-passed noise bursts peak hat and not kick", () => {
    const track = hatTrack();
    const stems = computeStemsSync(track.samples, track.sampleRate);
    const hats = track.times.map((t) => peakAt(stems, stems.hat, t));
    assert.ok(mean(hats) >= 0.7 && Math.min(...hats) >= 0.4, `hat peaks ${hats.map((x) => x.toFixed(2))}`);
    assert.ok(max(stems.kick) <= 0.25, `kick max ${max(stems.kick).toFixed(2)}`);
    assert.ok(max(stems.snare) <= 0.3, `snare max ${max(stems.snare).toFixed(2)}`);
});

test("noise plus 200 Hz bursts peak snare and not kick", () => {
    const track = snareTrack();
    const stems = computeStemsSync(track.samples, track.sampleRate);
    const snares = track.times.map((t) => peakAt(stems, stems.snare, t));
    assert.ok(mean(snares) >= 0.7 && Math.min(...snares) >= 0.4, `snare peaks ${snares.map((x) => x.toFixed(2))}`);
    assert.ok(max(stems.kick) <= 0.3, `kick max ${max(stems.kick).toFixed(2)}`);
});

test("in a drum loop each detector is strongest at its own drum", () => {
    const loop = drumLoop();
    const stems = computeStemsSync(loop.samples, loop.sampleRate);
    const at = (curve, times) => mean(times.map((t) => peakAt(stems, curve, t)));
    assert.ok(at(stems.kick, loop.kicks) > 2 * at(stems.kick, loop.hats), "kick: kicks over hats");
    assert.ok(at(stems.kick, loop.kicks) > 1.5 * at(stems.kick, loop.snares), "kick: kicks over snares");
    assert.ok(at(stems.hat, loop.hats) > 2 * at(stems.hat, loop.kicks), "hat: hats over kicks");
    assert.ok(at(stems.snare, loop.snares) > 1.5 * at(stems.snare, loop.kicks), "snare: snares over kicks");
    assert.ok(at(stems.snare, loop.snares) > 1.5 * at(stems.snare, loop.hats), "snare: snares over hats");
});

// percShare is a share of power, so a loud held sine keeps it modest even at the clicks; between them it is 0.
test("percShare rises at clicks over a held sine", () => {
    const track = sineWithClicks({ seconds: 6 });
    const stems = computeStemsSync(track.samples, track.sampleRate);
    const atClicks = mean(track.clickTimesMs.map((t) => peakAt(stems, stems.percShare, t)));
    let between = 0;
    let n = 0;
    for (let f = 0; f < stems.frames; f += 1) {
        const t = stems.frameTimeSec(f) * 1000;
        if (track.clickTimesMs.every((c) => Math.abs(t - c) > 120)) {
            between += stems.percShare[f];
            n += 1;
        }
    }
    assert.ok(atClicks > 0.15, `percShare at clicks ${atClicks.toFixed(2)}`);
    assert.ok(between / n < 0.02, `percShare between clicks ${(between / n).toFixed(3)}`);
});

test("a C-major triad gives C, E and G as the top chroma bins, low and high", () => {
    for (const notes of [["C3", "E3", "G3"], ["C5", "E5", "G5"]]) {
        const track = chordTrack(notes.map((n) => NOTE_HZ[n]));
        const order = chromaOrder(computeStemsSync(track.samples, track.sampleRate));
        assert.deepEqual(order.slice(0, 3).sort(), ["C", "E", "G"], `${notes}: ${order.join(" ")}`);
    }
});

test("a semitone pair at 131 and 139 Hz lands in two pitch classes", () => {
    assert.equal(chromaOrder(computeStemsSync(chordTrack([131]).samples, 22050))[0], "C");
    assert.equal(chromaOrder(computeStemsSync(chordTrack([139]).samples, 22050))[0], "C#");
    const both = chromaOrder(computeStemsSync(chordTrack([131, 139]).samples, 22050));
    assert.deepEqual(both.slice(0, 2).sort(), ["C", "C#"], both.join(" "));
});

test("chroma rows are unit length and held over the 8 frames of their window", () => {
    const track = chordTrack([NOTE_HZ.C3, NOTE_HZ.E3, NOTE_HZ.G3], { seconds: 3 });
    const stems = computeStemsSync(track.samples, track.sampleRate);
    const row = (f) => Array.from(stems.chroma.subarray(f * 12, f * 12 + 12));
    for (let f = 20; f < stems.frames - 20; f += 1) {
        const norm = Math.hypot(...row(f));
        assert.ok(Math.abs(norm - 1) < 0.02, `norm ${norm} at ${f}`);
    }
    const changes = [];
    for (let f = 1; f < stems.frames; f += 1) if (row(f).some((x, k) => x !== row(f - 1)[k])) changes.push(f);
    assert.ok(changes.every((f) => (f - 2) % 8 === 0), `chroma changes at ${changes.slice(0, 12)}`);
});

test("a transfer round trip is within 1/255 and checks its shape", () => {
    const { samples, sampleRate } = drumLoop({ seconds: 6 });
    const env = onsetEnvelope(samples, sampleRate);
    const stems = computeStemsSync(samples, sampleRate);
    const t = stemsToTransfer(stems);
    assert.equal(t.v, 1);
    assert.ok(t.chroma instanceof Uint8Array && t.timbre instanceof Uint8Array);
    for (const name of STEM_CURVES) assert.ok(t[name] instanceof Float32Array, name);
    const clone = structuredClone(t);
    assert.equal(checkStemsTransfer(clone, { frames: env.values.length }), null);
    const back = stemsFromTransfer(clone);
    for (const name of [...STEM_CURVES, "chroma", "timbre"]) {
        assert.equal(back[name].length, stems[name].length, name);
        for (let i = 0; i < back[name].length; i += 1) assert.ok(Math.abs(back[name][i] - stems[name][i]) <= 1 / 255, `${name} ${i}`);
    }
    // the in-memory chroma and timbre are already on the 1/255 grid, so the dataset and the app see the same numbers
    assert.deepEqual(Array.from(back.chroma), Array.from(stems.chroma));
    assert.deepEqual(Array.from(back.timbre), Array.from(stems.timbre));

    assert.equal(checkStemsTransfer({ ...t }, { frames: t.frames + 2 }), null);
    assert.match(checkStemsTransfer({ ...t }, { frames: t.frames + 3 }), /frames/);
    assert.match(checkStemsTransfer({ ...t, v: 2 }), /v/);
    assert.match(checkStemsTransfer({ ...t, kick: t.kick.subarray(1) }), /kick/);
    assert.match(checkStemsTransfer({ ...t, chroma: new Uint8Array(3) }), /chroma/);
    assert.match(checkStemsTransfer({ ...t, hopSec: -1 }), /hopSec/);
    assert.match(checkStemsTransfer(null), /stems/);
    assert.throws(() => stemsFromTransfer({ ...t, snare: null }), /snare/);
});

test("computeStems yields between chunks and gives the sync result", async () => {
    const { samples, sampleRate } = drumLoop({ seconds: 12 });
    const sync = computeStemsSync(samples, sampleRate);
    let pauses = 0;
    const progress = [];
    const stems = await computeStems(samples, sampleRate, {
        chunk: 256,
        pause: async () => {
            pauses += 1;
        },
        onProgress: (p) => progress.push(p),
    });
    assert.ok(pauses >= Math.floor(sync.frames / 256), `${pauses} pauses for ${sync.frames} frames`);
    assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])));
    for (const name of [...STEM_CURVES, "chroma", "timbre"]) assert.deepEqual(Array.from(stems[name]), Array.from(sync[name]), name);
});

test("silence and very short audio give empty curves, not NaN", () => {
    for (const n of [0, 500, 3000, 30000]) {
        const stems = computeStemsSync(new Float32Array(n), 22050);
        assert.equal(stems.frames, Math.max(0, Math.floor((n - 1024) / 256) + 1));
        for (const name of [...STEM_CURVES, "chroma", "timbre"]) assert.ok(stems[name].every((x) => Number.isFinite(x)), `${name} at ${n}`);
        assert.ok(stems.kick.every((x) => x === 0));
    }
    const noisy = Float32Array.from({ length: 30000 }, (_, i) => (i === 7000 ? NaN : i === 9000 ? Infinity : 0));
    const stems = computeStemsSync(noisy, 22050);
    for (const name of [...STEM_CURVES, "chroma", "timbre"]) assert.ok(stems[name].every(Number.isFinite), name);
});

test("samples beyond full scale count as clipped, as Chromium's decoder gives them", () => {
    const { samples, sampleRate } = drumLoop({ seconds: 6 });
    const hot = Float32Array.from(samples, (x) => 2.5 * x);
    const clipped = Float32Array.from(hot, (x) => Math.max(-1, Math.min(1, x)));
    assert.ok(hot.some((x) => Math.abs(x) > 1));
    const a = computeStemsSync(hot, sampleRate);
    const b = computeStemsSync(clipped, sampleRate);
    for (const name of [...STEM_CURVES, "chroma", "timbre"]) assert.deepEqual(Array.from(a[name]), Array.from(b[name]), name);
});
