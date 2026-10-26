import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { PART_KINDS, barsOf, barFeatures, detectParts, energyCurve, partIndexOfSlots } from "../../src/gen/songParts.js";
import { dropSong } from "../fixtures/dropSong.js";
import { partsSong, PARTS_SONG, PARTS_SONG_BPM, PARTS_SONG_OFFSET } from "../fixtures/partsSong.js";
import { clickTrack } from "../fixtures/clickTrack.js";

test("bars are meter-many beats, counted from each red line", () => {
    const slots = slotsForTiming({ sections: [{ timeMs: 0, bpm: 120 }, { timeMs: 5000, bpm: 240 }] }, 9000, { divOf: (i) => (i === 3 ? 3 : 4) });
    const bars = barsOf(slots);
    assert.deepEqual(bars.slice(0, 3).map((b) => b.startMs), [0, 2000, 4000]);
    // the 120 BPM part ends after two and a half bars; the 240 BPM part restarts the count at its red line
    assert.equal(bars[3].startMs, 5000);
    assert.equal(bars[4].startMs, 6000);
    for (let i = 1; i < bars.length; i += 1) assert.equal(bars[i].i0, bars[i - 1].i1);
    assert.equal(bars.at(-1).i1, slots.length);
});

test("dropSong gives drop, break, drop with boundaries within a bar of 30 s and 60 s", () => {
    const env = onsetEnvelope(dropSong({}), 22050);
    const slots = slotsForTiming({ bpm: 180, offsetMs: 300 }, 90000);
    const parts = detectParts(env, slots);
    assert.deepEqual(parts.map((p) => p.kind), ["drop", "break", "drop"], JSON.stringify(parts));
    const bar = (4 * 60000) / 180;
    assert.ok(Math.abs(parts[1].startMs - 30000) <= bar, `${parts[1].startMs}`);
    assert.ok(Math.abs(parts[2].startMs - 60000) <= bar, `${parts[2].startMs}`);
    assert.equal(parts[0].startMs, 0);
    parts.forEach((p, i) => i && assert.equal(p.startMs, parts[i - 1].endMs));
});

test("a six-part song gives its kinds in order", () => {
    const env = onsetEnvelope(partsSong(), 22050);
    const slots = slotsForTiming({ bpm: PARTS_SONG_BPM, offsetMs: PARTS_SONG_OFFSET }, PARTS_SONG.at(-1).endMs);
    const parts = detectParts(env, slots);
    assert.deepEqual(parts.map((p) => p.kind), PARTS_SONG.map((p) => p.kind), JSON.stringify(parts.map((p) => [p.kind, p.startMs])));
    const bar = (4 * 60000) / PARTS_SONG_BPM;
    parts.forEach((p, i) => assert.ok(Math.abs(p.startMs - PARTS_SONG[i].startMs) <= 2 * bar, `${p.kind} at ${p.startMs}`));
    assert.ok(parts.every((p) => PART_KINDS.includes(p.kind)));
});

test("a flat click track gives exactly one part", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 150, offsetMs: 400, seconds: 60, div: 2 });
    const env = onsetEnvelope(samples, sampleRate);
    const parts = detectParts(env, slotsForTiming({ bpm: 150, offsetMs: 400 }, 60000));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].kind, "part");
});

test("energyCurve stays within 0–1 and has the requested length; bar features are finite", () => {
    const env = onsetEnvelope(dropSong({}), 22050);
    const curve = energyCurve(env, 90000, 432);
    assert.equal(curve.length, 432);
    assert.ok(Array.from(curve).every((v) => v >= 0 && v <= 1));
    assert.ok(curve[50] > curve[200] + 0.3, "the drop is louder than the break");
    const slots = slotsForTiming({ bpm: 180, offsetMs: 300 }, 90000);
    const feats = barFeatures(env, slots, barsOf(slots));
    assert.ok(feats.length > 60 && feats.every((f) => f.every(Number.isFinite)));
});

test("every slot gets the index of the part it falls in", () => {
    const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 10000);
    const idx = partIndexOfSlots(slots, [{ startMs: 0, endMs: 4000 }, { startMs: 4000, endMs: 10000 }]);
    assert.equal(idx.length, slots.length);
    assert.equal(idx[slots.findIndex((s) => s.t === 3875)], 0);
    assert.equal(idx[slots.findIndex((s) => s.t === 4000)], 1);
    assert.equal(idx.at(-1), 1);
});
