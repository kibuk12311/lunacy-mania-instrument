import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { beatsFromTiming, sectionsToPoints, slotsForBeats } from "../../src/gen/grid.js";
import { BEAT_FEATURES, beatFeatures, detectBeatSnaps, chooseBeatDivs, gridShares } from "../../src/gen/snap.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const BPM = 120;
const OFFSET = 300;
const beatsOf = (seconds) => beatsFromTiming(sectionsToPoints([{ timeMs: OFFSET, bpm: BPM }]), seconds * 1000 - 500);
const envOf = (options) => {
    const { samples, sampleRate } = clickTrack({ bpm: BPM, offsetMs: OFFSET, seconds: 40, ...options });
    return onsetEnvelope(samples, sampleRate);
};
const triplets = { fromMs: 10000, toMs: 20000 };

test("beat features: the onset at the twelve 1/12 positions over the beat max, then max, energy and bpm", () => {
    assert.equal(BEAT_FEATURES.length, 15);
    assert.deepEqual(BEAT_FEATURES.slice(0, 2), ["s0", "s1"]);
    assert.deepEqual(BEAT_FEATURES.slice(-3), ["beat_max", "energy", "bpm"]);
    const beats = beatsOf(40);
    const { names, rows } = beatFeatures(envOf({ triplets }), beats);
    assert.deepEqual(names, BEAT_FEATURES);
    assert.equal(rows.length, beats.length * 15);
    assert.ok(rows.every(Number.isFinite));
    const at = (b, name) => rows[b * 15 + names.indexOf(name)];
    const triplet = beats.findIndex((b) => b.t > 12000);
    const plain = beats.findIndex((b) => b.t > 25000);
    assert.equal(at(triplet, "bpm"), BPM);
    assert.ok(at(triplet, "s4") > 0.3 && at(triplet, "s8") > 0.3, "1/3 and 2/3 carry clicks");
    assert.ok(at(plain, "s4") < 0.2 && at(plain, "s8") < 0.2, "a plain beat has nothing there");
    assert.ok(at(plain, "s0") > 0.9, "the click is the beat's strongest onset");
});

test("a triplet click section is detected", () => {
    const beats = beatsOf(40);
    const divs = detectBeatSnaps(envOf({ triplets }), beats, [4, 3, 6, 8]);
    assert.ok(divs instanceof Uint8Array && divs.length === beats.length);
    beats.forEach((b, i) => {
        if (b.t >= 10500 && b.t < 19500) assert.equal(divs[i], 3, `beat at ${b.t}`);
        if (b.t < 9500 || b.t >= 20500) assert.equal(divs[i], 4, `beat at ${b.t}`);
    });
});

test("a triplet section is found too when the red line sits OFFSET_BIAS_MS before the clicks, as detect-timing puts it", async () => {
    const { OFFSET_BIAS_MS } = await import("../../src/audio/fineOnset.js");
    const env = envOf({ triplets });
    for (const offset of [OFFSET + OFFSET_BIAS_MS, OFFSET]) {
        const beats = beatsFromTiming(sectionsToPoints([{ timeMs: offset, bpm: BPM }]), 39500);
        const divs = detectBeatSnaps(env, beats, [4, 3, 6, 8]);
        beats.forEach((b, i) => {
            if (b.t >= 10500 && b.t < 19500) assert.equal(divs[i], 3, `red line ${offset}: beat at ${b.t}`);
            if (b.t < 9500 || b.t >= 20500) assert.equal(divs[i], 4, `red line ${offset}: beat at ${b.t}`);
        });
    }
    // and 1/4 clicks still never read as triplets with that red line
    const early = beatsFromTiming(sectionsToPoints([{ timeMs: OFFSET + OFFSET_BIAS_MS, bpm: BPM }]), 39500);
    assert.ok(Array.from(detectBeatSnaps(envOf({ div: 4 }), early, [4, 3, 6, 8])).every((d) => d !== 3 && d !== 6));
});

test("1/4 clicks never give 1/3; only 1/4 allowed gives all 4", () => {
    const beats = beatsOf(40);
    const quarters = detectBeatSnaps(envOf({ div: 4 }), beats, [4, 3, 6, 8]);
    assert.ok(Array.from(quarters).every((d) => d !== 3 && d !== 6), Array.from(quarters).join(""));
    const eighths = detectBeatSnaps(envOf({ div: 2 }), beats, [4, 3, 6, 8]);
    assert.ok(Array.from(eighths).every((d) => d === 4));
    const only4 = chooseBeatDivs({ envelope: envOf({ triplets }), beats, allowed: [4], model: null, rng: mulberry32(1) });
    assert.ok(Array.from(only4).every((d) => d === 4));
});

test("a lone triplet beat is not trusted", () => {
    const beats = beatsOf(40);
    const one = beats.find((b) => b.t > 15000);
    const divs = detectBeatSnaps(envOf({ triplets: { fromMs: one.t - 1, toMs: one.t + 1 } }), beats, [4, 3, 6, 8]);
    assert.ok(Array.from(divs).every((d) => d === 4));
});

test("chooseBeatDivs follows the rules without a divisor head", () => {
    const beats = beatsOf(40);
    const env = envOf({ triplets });
    assert.deepEqual(
        Array.from(chooseBeatDivs({ envelope: env, beats, allowed: [4, 3], model: { features: [] }, rng: mulberry32(3) })),
        Array.from(detectBeatSnaps(env, beats, [4, 3])),
    );
});

test("a model's divisor head and snap transitions are used when present", () => {
    const beats = beatsOf(40);
    const s4 = BEAT_FEATURES.indexOf("s4");
    const famJack = BEAT_FEATURES.length + 2; // conditioning: dan, fam_Stream, fam_Jack
    // class scores [4, 3, 6, 8]: 1/3 where the 1/3 position has an onset, 1/8 in Jack sections
    const model = {
        conditioning: ["dan", "fam_Stream", "fam_Jack"],
        divisor: {
            classes: [4, 3, 6, 8],
            baseline: [0, 0, 0, 0],
            iterations: [[
                { feature: [s4, 0, 0], threshold: [0.3, 0, 0], missingLeft: [1, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, 6, -6] },
                { feature: [s4, 0, 0], threshold: [0.3, 0, 0], missingLeft: [1, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -6, 6] },
                { feature: [0, 0, 0], threshold: [0, 0, 0], missingLeft: [1, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -9, -9] },
                { feature: [famJack, 0, 0], threshold: [0.5, 0, 0], missingLeft: [1, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -9, 9] },
            ]],
        },
        snapTransitions: [[0.97, 0.01, 0.01, 0.01], [0.01, 0.97, 0.01, 0.01], [0.25, 0.25, 0.25, 0.25], [0.01, 0.01, 0.01, 0.97]],
    };
    const env = envOf({ triplets });
    const families = beats.map((b) => (b.t >= 30000 ? "Jack" : "Stream"));
    const divs = chooseBeatDivs({ envelope: env, beats, allowed: [4, 3, 6, 8], model, dan: 10, families, rng: mulberry32(7) });
    const share = (from, to, d) => {
        const inside = beats.map((b, i) => [b, divs[i]]).filter(([b]) => b.t >= from && b.t < to);
        return inside.filter(([, x]) => x === d).length / inside.length;
    };
    assert.ok(share(11000, 19000, 3) > 0.9, "triplets from the head");
    assert.ok(share(21000, 29000, 4) > 0.9, "plain beats stay 1/4");
    assert.ok(share(31000, 39000, 8) > 0.9, "the family conditions the head");
    // the same seed gives the same path; 1/8 not allowed never comes out
    const again = chooseBeatDivs({ envelope: env, beats, allowed: [4, 3, 6, 8], model, dan: 10, families, rng: mulberry32(7) });
    assert.deepEqual(Array.from(again), Array.from(divs));
    const no8 = chooseBeatDivs({ envelope: env, beats, allowed: [4, 3], model, dan: 10, families, rng: mulberry32(7) });
    assert.ok(Array.from(no8).every((d) => d === 4 || d === 3));
});

test("grid shares count each row by the finest grid its position needs", () => {
    const beats = beatsFromTiming(sectionsToPoints([{ timeMs: 0, bpm: 120 }]), 4000);
    const divs = [4, 3, 6, 8, 4, 4, 4, 4];
    const slots = slotsForBeats(beats, (i) => divs[i]);
    const on = (beat, pos) => slots.find((s) => s.beat === beat && s.pos === pos);
    const rows = [on(0, 1), on(1, 0), on(1, 1), on(2, 3), on(2, 1), on(2, 2), on(3, 2), on(3, 1)].map((s) => ({ t: s.t, cols: [0] }));
    const shares = gridShares(rows, slots);
    // 1/4: beat 0 pos 1, the triplet downbeat, the 1/6 half, the 1/8 even step; 1/3: two; 1/6: one; 1/8: one
    assert.deepEqual(shares, { 4: 4 / 8, 3: 2 / 8, 6: 1 / 8, 8: 1 / 8 });
    assert.deepEqual(gridShares([], slots), { 4: 1, 3: 0, 6: 0, 8: 0 });
});
