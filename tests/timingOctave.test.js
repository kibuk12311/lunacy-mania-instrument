// The octave step of the automatic BPM (tempo.js chooseOctave): tempos above the old 260 ceiling, even eighth-note
// attacks with one kick and bass swell per beat (the beat, not the eighths), click tracks that keep their tempo, and
// Timing.alternatives: the other octave when it scores close, timed on its own attacks.
import test from "node:test";
import assert from "node:assert/strict";
import { clickTrack } from "./fixtures/clickTrack.js";
import { onsetEnvelope } from "../src/audio/onset.js";
import { fineOnset, OFFSET_BIAS_MS } from "../src/audio/fineOnset.js";
import { detectTiming } from "../src/audio/tempo.js";
import { detectTimingFull } from "../src/audio/timingJob.js";

const SR = 22050;

function noise(seed) {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

// The same sharp tick on every eighth note, and on every beat a kick with the bass swelling back after it: the onsets
// alone fit the eighths as well as the beat; the kick and the loudness repeat once per beat.
function eighths({ bpm, offsetMs, seconds, kick = 0.9, swell = 0.5 }) {
    const out = new Float32Array(seconds * SR);
    const rand = noise(11);
    const beat = 60000 / bpm;
    for (let t = offsetMs; t < seconds * 1000; t += beat / 2) {
        const s = Math.round((t / 1000) * SR);
        for (let k = 0; k < 160 && s + k < out.length; k += 1) out[s + k] += (k % 2 ? 1 : -1) * rand() * 0.5 * Math.exp(-k / 40);
    }
    for (let t = offsetMs; t < seconds * 1000; t += beat) {
        const s = Math.round((t / 1000) * SR);
        const end = Math.round(((t + beat) / 1000) * SR);
        for (let i = s; i < end && i < out.length; i += 1) {
            const dt = (i - s) / SR;
            const thump = kick * Math.exp(-dt / 0.06) * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-dt / 0.02)) * dt);
            out[i] += thump + swell * Math.min(1, dt / (beat / 2000)) * Math.sin((2 * Math.PI * 55 * i) / SR);
        }
    }
    for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i] + rand() * 0.005));
    return { samples: out, sampleRate: SR };
}

const detect = ({ samples, sampleRate }) => {
    const envelope = onsetEnvelope(samples, sampleRate);
    return { envelope, timing: detectTimingFull({ envelope, fine: fineOnset(samples, sampleRate) }) };
};
const wrap = (d, beatMs) => {
    const x = ((d % beatMs) + beatMs) % beatMs;
    return x > beatMs / 2 ? x - beatMs : x;
};

for (const bpm of [270, 300]) {
    test(`a ${bpm} BPM click track is found at ${bpm} (above the old 260 ceiling), on its clicks`, () => {
        const { envelope, timing } = detect(clickTrack({ bpm, offsetMs: 137, seconds: 40 }));
        assert.equal(detectTiming(envelope).bpm, bpm);
        assert.equal(timing.bpm, bpm);
        assert.ok(Math.abs(wrap(timing.offsetMs - (137 + OFFSET_BIAS_MS), 60000 / bpm)) <= 1, `red line ${timing.offsetMs}`);
    });
}

test("280 BPM clicks: 280 is the answer or the one-click alternative, timed on the clicks", () => {
    const { timing } = detect(clickTrack({ bpm: 280, offsetMs: 137, seconds: 40 }));
    const all = [{ timeMs: timing.offsetMs, bpm: timing.bpm }, ...timing.alternatives];
    const it = all.find((x) => x.bpm === 280);
    assert.ok(it, JSON.stringify(all));
    assert.ok(Math.abs(wrap(it.timeMs - (137 + OFFSET_BIAS_MS), 60000 / 280)) <= 1, `red line ${it.timeMs}`);
});

for (const bpm of [120, 130]) {
    test(`even eighths with a kick and a bass swell once per beat: ${bpm}, not ${2 * bpm}`, () => {
        assert.equal(detect(eighths({ bpm, offsetMs: 120, seconds: 45 })).timing.bpm, bpm);
        assert.equal(detect(eighths({ bpm, offsetMs: 120, seconds: 45, swell: 0 })).timing.bpm, bpm, "the kick alone");
        assert.equal(detect(eighths({ bpm, offsetMs: 120, seconds: 45, kick: 0 })).timing.bpm, bpm, "the swell alone");
    });
}

test("click tracks keep their tempo, with nothing to offer", () => {
    for (const bpm of [96, 100, 128, 174, 200]) {
        const { timing } = detect(clickTrack({ bpm, offsetMs: 137, seconds: 40 }));
        assert.equal(timing.bpm, bpm);
        assert.deepEqual(timing.alternatives, [], `${bpm}`);
    }
});

test("alternatives: the other octave, whole ms on its first beat, a share of the octave scores; none for a hint", () => {
    const track = clickTrack({ bpm: 300, offsetMs: 137, seconds: 40 });
    const { envelope, timing } = detect(track);
    assert.ok(timing.alternatives.length >= 1, "300 BPM clicks fit 150 almost as well");
    for (const a of timing.alternatives) {
        assert.ok([2, 0.5].some((r) => Math.abs(a.bpm / timing.bpm / r - 1) < 0.005), `${a.bpm} against ${timing.bpm}`);
        assert.ok(Number.isInteger(a.timeMs) && a.timeMs >= 0 && a.timeMs < 60000 / a.bpm, `${a.timeMs}`);
        assert.ok(Math.abs(wrap(a.timeMs - (137 + OFFSET_BIAS_MS), 60000 / a.bpm)) <= 1, `on the clicks: ${a.timeMs}`);
        assert.ok(a.share > 0 && a.share < 0.5, `${a.share}`);
    }
    // without fine onsets the envelope's own phase times them
    const plain = detectTimingFull({ envelope });
    assert.deepEqual(plain.alternatives.map((a) => a.bpm), timing.alternatives.map((a) => a.bpm));
    assert.ok(plain.alternatives.every((a) => Number.isFinite(a.timeMs) && a.timeMs >= 0));
    const hinted = detectTimingFull({ envelope, fine: fineOnset(track.samples, track.sampleRate), hint: { bpm: 300, offsetMs: 114 } });
    assert.deepEqual(hinted.alternatives, []);
});
