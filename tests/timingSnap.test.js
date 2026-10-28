// «Подогнать по волне» (detectTimingFull with the user's timing as the hint): the user's red line is the anchor. It
// goes onto the attacks next to it (within hintNearMs), further only when the attacks there are clearly weaker than
// the strongest in the beat (HINT_OFF_RATIO), and the BPM is still fitted. Before, the line was moved onto the low band's
// grid first, which on a pumping master (the bass swelling back between the kicks) sits half a beat off.
import test from "node:test";
import assert from "node:assert/strict";
import { clickTrack } from "./fixtures/clickTrack.js";
import { onsetEnvelope } from "../src/audio/onset.js";
import { fineOnset, OFFSET_BIAS_MS } from "../src/audio/fineOnset.js";
import { detectTimingFull } from "../src/audio/timingJob.js";
import { hintNearMs } from "../src/audio/tempo.js";

const SR = 22050;

function noise(seed) {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

// A pumping, sidechained beat: a sharp high tick on every beat, and a 55 Hz bass that is ducked at the tick and comes
// back half a beat later (so the low band rises on the off-beat, the attacks are on the beat).
function pumping({ bpm, offsetMs, seconds }) {
    const out = new Float32Array(seconds * SR);
    const rand = noise(7);
    const beat = 60000 / bpm;
    for (let t = offsetMs; t < seconds * 1000; t += beat) {
        const s = Math.round((t / 1000) * SR);
        for (let k = 0; k < 160 && s + k < out.length; k += 1) out[s + k] += (k % 2 ? 1 : -1) * rand() * 0.6 * Math.exp(-k / 40);
        const back = Math.round(((t + beat / 2) / 1000) * SR);
        const end = Math.round(((t + beat) / 1000) * SR);
        for (let i = back; i < end && i < out.length; i += 1) out[i] += 0.8 * Math.min(1, (i - back) / (0.04 * SR)) * Math.sin((2 * Math.PI * 55 * i) / SR);
    }
    for (let i = 0; i < out.length; i += 1) out[i] += rand() * 0.005;
    return { samples: out, sampleRate: SR };
}

const featuresOf = ({ samples, sampleRate }) => ({ envelope: onsetEnvelope(samples, sampleRate), fine: fineOnset(samples, sampleRate) });
const snap = ({ envelope, fine }, timeMs, bpm) => detectTimingFull({ envelope, fine, hint: { sections: [{ timeMs, bpm, meter: 4 }], bpm, offsetMs: timeMs } });
// where a person puts the red line of an attack at attackMs
const lineOf = (attackMs) => attackMs + OFFSET_BIAS_MS;

for (const [bpm, offsetMs] of [[128, 300.4], [150, 211.2]]) {
    test(`a right red line on a pumping ${bpm} BPM song stays on its beat (not the bass half a beat later)`, () => {
        const features = featuresOf(pumping({ bpm, offsetMs, seconds: 40 }));
        const line = lineOf(offsetMs + (4 * 60000) / bpm);
        for (const hintBpm of [bpm, bpm * 1.005]) {
            const timing = snap(features, line, hintBpm);
            assert.equal(timing.sections.length, 1);
            assert.equal(timing.bpm, bpm, `BPM from ${hintBpm}`);
            assert.ok(Math.abs(timing.offsetMs - line) <= 2, `red line ${timing.offsetMs}, the user's ${line.toFixed(1)}`);
            assert.deepEqual(timing.alternatives, [], "a hint keeps its BPM: no octave offered");
        }
    });
}

test("a line a little off goes onto the attacks next to it; a clearly-off one (no attacks near) onto the beat", () => {
    const features = featuresOf(clickTrack({ bpm: 174, offsetMs: 312.4, seconds: 40 }));
    const beat = 60000 / 174;
    const line = lineOf(312.4 + 2 * beat);
    assert.equal(hintNearMs(174), 40);
    for (const off of [-35, -25, -10, 10, 25, 35, beat / 4, -beat / 4, beat / 3]) {
        const timing = snap(features, line + off, 174);
        assert.ok(Math.abs(timing.offsetMs - line) <= 1, `from ${off.toFixed(1)} ms: ${timing.offsetMs} vs ${line.toFixed(1)}`);
    }
});

test("a line on off-beat attacks about as strong as the beat stays there: the user's choice is kept", () => {
    const features = featuresOf(clickTrack({ bpm: 120, offsetMs: 300.4, seconds: 40, div: 2 }));
    const offBeat = lineOf(300.4 + 4 * 500 + 250);
    const timing = snap(features, offBeat, 120);
    assert.ok(Math.abs(timing.offsetMs - offBeat) <= 1, `${timing.offsetMs} vs the user's ${offBeat.toFixed(1)}`);
    assert.ok(Math.abs(timing.offsetMs - offBeat) <= hintNearMs(120));
});

test("without fine onsets the line moves onto the envelope's grid only when that is near", () => {
    const { envelope } = featuresOf(clickTrack({ bpm: 174, offsetMs: 312, seconds: 40 }));
    const beat = 60000 / 174;
    const at = (timeMs) => detectTimingFull({ envelope, hint: { sections: [{ timeMs, bpm: 173.6, meter: 4 }] } });
    const far = 312 + beat + 100;
    assert.equal(at(far).offsetMs, far, "100 ms from any click: the user's line stays");
    assert.equal(at(far).bpm, 174, "the BPM is still fitted");
    for (const off of [10, -20]) {
        const timing = at(312 + beat + off);
        assert.ok(Math.abs(timing.offsetMs - (312 + beat)) <= 12, `${off} ms off: ${timing.offsetMs}`);
    }
});
