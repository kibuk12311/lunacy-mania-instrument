import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync, stemsFromTransfer, stemsToTransfer } from "../../src/audio/stems.js";
import { beatsFromTiming, sectionsToPoints, timingSections, slotsForBeats } from "../../src/gen/grid.js";
import { songStructure } from "../../src/gen/structure.js";
import { BEAT_FEATURES, beatFeatures } from "../../src/gen/snap.js";
import { BEAT_FEATURES_V3, beatFeaturesV3 } from "../../src/gen/beatFeatures.js";
import { sectionSong, chordTrack } from "../fixtures/stemTracks.js";

const song = sectionSong(["A", "B", "A", "B'"], { bpm: 160 });
const envelope = onsetEnvelope(song.samples, song.sampleRate);
const stems = stemsFromTransfer(stemsToTransfer(computeStemsSync(song.samples, song.sampleRate)));
const endMs = (song.samples.length / song.sampleRate) * 1000 - 600;
const beats = beatsFromTiming(sectionsToPoints(timingSections({ bpm: song.bpm, offsetMs: 0 })), endMs);
const slots = slotsForBeats(beats);
const structure = songStructure({ stems, slots, envelope });
const B = BEAT_FEATURES_V3.length;
const col = (name) => BEAT_FEATURES_V3.indexOf(name);

test("45 names: the 15 beat features, 12 chroma, 12 timbre and the 6 structure columns", () => {
    assert.equal(B, 45);
    assert.deepEqual(BEAT_FEATURES_V3.slice(0, 15), BEAT_FEATURES);
    assert.deepEqual(BEAT_FEATURES_V3.slice(39), ["phrase_pos", "is_phrase_start", "has_echo", "rep_sim", "novelty", "meter"]);
    assert.equal(new Set(BEAT_FEATURES_V3).size, 45);
});

test("the nn-v2 trainer reads the same names in the same order", () => {
    const py = new URL("../../tools/nn/infill_model.py", import.meta.url);
    if (!existsSync(py)) return; // stream N not merged
    const text = readFileSync(py, "utf8");
    assert.match(text, /BEAT_FEATURES_V3 = \(BEAT_FEATURES \+ \[f"chroma\{k\}" for k in range\(12\)\] \+ \[f"timbre\{k\}" for k in range\(12\)\]\s*\+ \["phrase_pos", "is_phrase_start", "has_echo", "rep_sim", "novelty", "meter"\]\)/);
});

test("the first 15 columns are beatFeatures to the bit, every value is finite", () => {
    const { names, rows } = beatFeaturesV3(envelope, beats, { stems, structure });
    assert.equal(names, BEAT_FEATURES_V3);
    assert.equal(rows.length, beats.length * B);
    assert.ok(rows.every(Number.isFinite));
    const base = beatFeatures(envelope, beats).rows;
    for (let i = 0; i < beats.length; i += 1) {
        for (let k = 0; k < 15; k += 1) assert.equal(rows[i * B + k], base[i * 15 + k]);
    }
});

test("structure columns follow the structure: phrase starts, echoes, meter", () => {
    const { rows } = beatFeaturesV3(envelope, beats, { stems, structure });
    const barOfBeat = (i) => Math.floor(i / 4); // one section of 4/4 from 0 ms
    const phraseStartBars = new Set(structure.phrases.map((p) => p.bar));
    for (let i = 0; i < beats.length; i += 1) {
        const bar = barOfBeat(i);
        if (bar >= structure.bars.length) continue;
        const start = phraseStartBars.has(bar) && i % 4 === 0 ? 1 : 0;
        assert.equal(rows[i * B + col("is_phrase_start")], start, `beat ${i}`);
        assert.equal(rows[i * B + col("has_echo")], structure.echoOf[bar] >= 0 ? 1 : 0, `beat ${i}`);
        assert.equal(rows[i * B + col("meter")], 4);
        const pos = rows[i * B + col("phrase_pos")];
        assert.ok(pos >= 0 && pos < 1);
    }
    // the second A (bars 16..23) echoes the first
    const echoed = beats.filter((_, i) => barOfBeat(i) >= 16 && barOfBeat(i) < 24 && rows[i * B + col("has_echo")] === 1).length;
    assert.ok(echoed >= 28, `${echoed} of 32 beats of the second A echo`);
});

test("chroma of a held C major chord peaks at C, E and G on every beat", () => {
    const chord = chordTrack([130.81, 164.81, 196.0], { seconds: 6 });
    const env = onsetEnvelope(chord.samples, chord.sampleRate);
    const st = computeStemsSync(chord.samples, chord.sampleRate);
    const bs = beatsFromTiming(sectionsToPoints(timingSections({ bpm: 120, offsetMs: 0 })), 5000);
    const structureOf = songStructure({ stems: st, slots: slotsForBeats(bs), envelope: env });
    const { rows } = beatFeaturesV3(env, bs, { stems: st, structure: structureOf });
    for (let i = 1; i < bs.length - 1; i += 1) {
        const chroma = Array.from(rows.subarray(i * B + 15, i * B + 27));
        const top = chroma.map((v, q) => [v, q]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, q]) => q).sort((a, b) => a - b);
        assert.deepEqual(top, [0, 4, 7], `beat ${i}: ${chroma.map((v) => v.toFixed(2))}`);
    }
});

test("stems and structure are required", () => {
    assert.throws(() => beatFeaturesV3(envelope, beats, { structure }), /missing stems/);
    assert.throws(() => beatFeaturesV3(envelope, beats, { stems }), /missing structure/);
});

test("a beat past the end of the audio takes the last frame, not NaN", () => {
    const late = [...beats, { ...beats.at(-1), t: beats.at(-1).t + 60000, index: beats.length }];
    const { rows } = beatFeaturesV3(envelope, late, { stems, structure });
    assert.ok(rows.every(Number.isFinite));
});
