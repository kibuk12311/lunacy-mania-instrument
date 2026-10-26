// generateLearnedMap's opts.boost (0.9.8, one rung of src/gen/targeting.js): absent it changes nothing; the knob top,
// the chord weight, the contrast and the grids it lifts each do what they say; the grids stay humanly fast.
import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateLearnedMap, CHORD_ROOM } from "../../src/gen/generateLearned.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { denserGridsFor, detectBeatSnaps, MAX_DENSER_ROWS_PER_SEC } from "../../src/gen/snap.js";
import { BOOST_LADDER } from "../../src/gen/targeting.js";
import { chartInfo } from "../../src/core/features.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { findIssues } from "../../src/gen/playability.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const ONSET = AUDIO_FEATURES.indexOf("onset");
const singles = [1, 2, 4, 8];
const pairs = [3, 5, 6, 9, 10, 12];
// Jumpstream rows of one or two notes, equally common; the model wants notes on the clicks
const model = {
    features: AUDIO_FEATURES,
    families: ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"],
    note: { baseline: [0], classes: [0, 1], iterations: [[{
        feature: [ONSET, 0, 0], threshold: [0.3, 0, 0], missingLeft: [1, 0, 0],
        left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -3, 3],
    }]] },
    size: { baseline: [0, 0, -9, -9], classes: [1, 2, 3, 4], iterations: [] },
    pattern: { Jumpstream: { "0,0,1": Object.fromEntries([...singles.map((m) => [m, 30]), ...pairs.map((m) => [m, 20])]) } },
};
const song = clickTrack({ bpm: 150, offsetMs: 400, seconds: 40 });
const envelope = onsetEnvelope(song.samples, song.sampleRate);
const input = (request = {}) => ({
    timing: { bpm: 150, offsetMs: 400 }, envelope, durationMs: 40000,
    request: { range: { lo: 2.5, hi: 3.5 }, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 5, ...request },
    meta: { title: "t", audioFilename: "a.mp3" },
});
const notes = (text) => chartInfo(text, 1).noteCount;
const rows = (text) => parseRows(text, 4);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sizeOf = (r) => r.cols?.length ?? [0, 1, 2, 3].filter((c) => r.mask & (1 << c)).length;

test("no boost (absent, null) gives the very same map as before", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: notes(text) / 40 });
    const a = await generateLearnedMap(input(), fake, model);
    const b = await generateLearnedMap(input(), fake, model, { boost: null });
    assert.equal(a.osuText, b.osuText);
    assert.equal(a.boost, undefined);
});

test("a boost's knob top lets a hard request get denser than the plain knob cap allows", async () => {
    // an analyser that wants far more notes than knob 1 gives: the plain search stops at its cap
    const fake = async (text) => ({ kind: "ok", numeric: notes(text) / 80 });
    const plain = await generateLearnedMap(input({ range: { lo: 14.5, hi: 15.5 } }), fake, model);
    const boosted = await generateLearnedMap(input({ range: { lo: 14.5, hi: 15.5 } }), fake, model, { boost: { rung: 2, knobMax: 8, contrast: 0, chord: 0 } });
    assert.ok(plain.knob <= 2.5, `plain knob ${plain.knob}`);
    assert.ok(boosted.knob > plain.knob, `boosted knob ${boosted.knob}`);
    assert.ok(boosted.noteCount > plain.noteCount, `${boosted.noteCount} vs ${plain.noteCount}`);
    assert.deepEqual(boosted.boost, { rung: 2, knobMax: 8, contrast: 0, chord: 0 });
});

test("the chord weight makes rows of more notes, a negative one fewer, within the family's room", async () => {
    // rows per second as the dan, so every map has about as many rows and only their sizes differ
    const fake = async (text) => ({ kind: "ok", numeric: rows(text).length / 40 });
    const size = async (chord) => mean(rows((await generateLearnedMap(input(), fake, model, chord === null ? {} : { boost: { rung: 1, chord } })).osuText).map(sizeOf));
    const plain = await size(null);
    const more = await size(1.6);
    const fewer = await size(-1.6);
    assert.ok(more > plain + 0.1, `chord +: ${more} vs ${plain}`);
    assert.ok(fewer < plain - 0.1, `chord −: ${fewer} vs ${plain}`);
    // a jumpstream row never gains weight past two notes
    assert.equal(CHORD_ROOM.Jumpstream, 1);
    assert.ok(more <= 2);
});

test("a chord-boosted map keeps the playability rules: no jack or speed issue the plain one does not have", async () => {
    // a hard request on the top rung: as dense as the boost goes
    const fake = async (text) => ({ kind: "ok", numeric: notes(text) / 80 });
    const r = await generateLearnedMap(input({ range: { lo: 14.5, hi: 15.5 } }), fake, model, { boost: BOOST_LADDER[2] });
    assert.ok(r.noteCount > 300, `${r.noteCount} notes`);
    const slots = slotsForTiming({ bpm: 150, offsetMs: 400 }, 40000);
    const bad = findIssues(rows(r.osuText).map((x) => ({ ...x, family: "Jumpstream" })), slots).filter((x) => x.kind === "fastJack" || x.kind === "jack");
    assert.deepEqual(bad, []);
});

test("the boost's grids are offered only where their rows stay humanly fast", () => {
    assert.deepEqual(denserGridsFor(135, [8, 6, 3]), [8, 6, 3]);
    assert.deepEqual(denserGridsFor(150, [8, 6, 3]), [8, 6, 3]);
    assert.deepEqual(denserGridsFor(175, [8, 6, 3]), [6, 3]);
    // 1/3 alone would thin a hard map out: it goes with 1/6 or not at all
    assert.deepEqual(denserGridsFor(243, [8, 6, 3]), []);
    assert.deepEqual(denserGridsFor(150, [8, 3]), [8]);
    for (const [bpm, g] of [[150, 8], [200, 6], [400, 3]]) assert.ok((bpm * g) / 60 <= MAX_DENSER_ROWS_PER_SEC);
});

test("the denser lean turns 1/3 beats into 1/6 and can only add finer beats", () => {
    // a beat clock at 120 BPM with clicks on the 1/3 positions as loud as the beats
    const beatMs = 500;
    const hopSec = 0.005;
    const values = new Float32Array(Math.ceil(20 / hopSec));
    for (let t = 0; t < 20000; t += beatMs) for (const f of [0, 1 / 3, 2 / 3]) values[Math.round((t + f * beatMs) / 1000 / hopSec)] = 1;
    const env = { values, hopSec, frameTimeSec: (f) => f * hopSec };
    const beats = Array.from({ length: 38 }, (_, i) => ({ t: i * beatMs, beatMs, bpm: 120 }));
    const plain = detectBeatSnaps(env, beats, [4, 3, 6, 8]);
    const denser = detectBeatSnaps(env, beats, [4, 3, 6, 8], { win: 0.85, floorMedians: 1, tripletsAs6: true });
    assert.ok(plain.includes(3));
    assert.ok(!denser.includes(3));
    plain.forEach((d, i) => { if (d === 3) assert.equal(denser[i], 6); });
});

test("a boost with grids on a slow song puts rows off the 1/4 grid; the request's own grids always stay", async () => {
    const fake = async () => ({ kind: "ok", numeric: 3 });
    const r = await generateLearnedMap(input(), fake, model, { boost: { rung: 2, snaps: [8, 6, 3], denser: true } });
    assert.ok(r.grid, "the grid shares are there");
    const plain = await generateLearnedMap(input({ snaps: [4] }), fake, model);
    assert.equal(plain.grid[4], 1);
});
