import test from "node:test";
import assert from "node:assert/strict";
import { parseRows, labelSlots, sectionFamily, FAMILIES } from "../../src/gen/mapRows.js";

const x = (c) => Math.floor(((c + 0.5) * 512) / 4);
const osu = (rows) => "[HitObjects]\r\n" + rows.flatMap(([t, cols]) => cols.map((c) => `${x(c)},192,${t},1,0,0:0:0:0:`)).join("\r\n");

test("hit objects become rows with column masks", () => {
    const rows = parseRows(osu([[1000, [0, 2]], [1001, [3]], [1250, [1]]]), 4);
    assert.deepEqual(rows, [{ t: 1000, mask: 0b1101 }, { t: 1250, mask: 0b0010 }]);
});

test("rows are matched to the nearest slot within 12 ms; off-grid rows are counted", () => {
    const slots = [{ t: 1000 }, { t: 1125 }, { t: 1250 }];
    const { note, mask, offgrid } = labelSlots([{ t: 1003, mask: 1 }, { t: 1190, mask: 2 }, { t: 1249, mask: 4 }], slots);
    assert.deepEqual(Array.from(note), [1, 0, 1]);
    assert.deepEqual(Array.from(mask), [1, 0, 4]);
    assert.equal(offgrid, 1);
});

test("section family from row shapes", () => {
    const fam = (masks) => sectionFamily(masks.map((m) => ({ mask: m })), 0);
    assert.equal(fam([1, 4, 2, 8, 1, 8, 2, 4, 1, 4, 2, 8]), "Stream");
    assert.equal(fam([5, 2, 9, 4, 10, 1, 6, 8, 5, 2, 9, 4]), "Jumpstream");
    assert.equal(fam([7, 8, 6, 9, 7, 8, 6, 9, 7, 8, 6, 9]), "Handstream");
    assert.equal(fam([7, 7, 13, 13, 11, 11, 14, 14, 7, 7, 13, 13]), "Chordjack");
    assert.equal(fam([1, 1, 2, 2, 1, 1, 4, 4, 8, 8, 1, 1]), "Jack");
    assert.ok(FAMILIES.includes("Tech"));
});

test("the snap tolerance is a third of the slot step, at most 12 ms", async () => {
    const { slotsForTiming } = await import("../../src/gen/grid.js");
    // 1/8 at 240 BPM: 31.25 ms apart, so a row 11 ms off is off-grid (tolerance 10.4 ms)
    const slots = slotsForTiming({ bpm: 240, offsetMs: 0 }, 1000, { divOf: () => 8 });
    const { note, offgrid } = labelSlots([{ t: 0, mask: 1 }, { t: 31 + 10, mask: 2 }, { t: 125 + 11, mask: 4 }], slots);
    assert.deepEqual(Array.from(note).slice(0, 5), [1, 1, 0, 0, 0]);
    assert.equal(offgrid, 1);
    // 1/4 at 150 BPM keeps the old 12 ms
    const q = slotsForTiming({ bpm: 150, offsetMs: 0 }, 1000);
    assert.equal(labelSlots([{ t: 112, mask: 1 }, { t: 213, mask: 1 }], q).offgrid, 1);
});

test("each beat's grid is the first of 1/4, 1/3, 1/6, 1/8 that holds all its rows", async () => {
    const { beatsFromTiming, sectionsToPoints } = await import("../../src/gen/grid.js");
    const { labelBeatSnaps } = await import("../../src/gen/mapRows.js");
    const beats = beatsFromTiming(sectionsToPoints([{ timeMs: 0, bpm: 120 }]), 6000); // 500 ms beats
    const at = (beat, frac, jitter = 0) => ({ t: Math.round(beat * 500 + frac * 500 + jitter), mask: 1 });
    const rows = [
        at(0, 0), at(0, 0.25), at(0, 0.5), at(0, 0.75), // 1/4
        at(1, 0), at(1, 1 / 3), at(1, 2 / 3), // triplet
        at(2, 0), at(2, 1 / 6), at(2, 0.5), // 1/6
        at(3, 0), at(3, 0.125), at(3, 0.375), // 1/8
        at(4, 0, 4), at(4, 0.25, -5), at(4, 0.5, 3), at(4, 0.75, -4), // jittered 1/4
        at(5, 0), at(5, 1 / 16), // 1/16: off every grid
        at(7, 0, -6), // a jittered downbeat counts for its own beat
        at(8, 0.5), at(8, 1 / 3), // 1/2 + 1/3 → 1/6
    ];
    const snaps = labelBeatSnaps(rows, beats);
    assert.deepEqual(Array.from(snaps).slice(0, 9), [4, 3, 6, 8, 4, 0, 4, 4, 6]);
    assert.ok(snaps instanceof Uint8Array);
    assert.equal(snaps.length, beats.length);
    // only 1/4 allowed: the triplet beat is off-grid
    assert.deepEqual(Array.from(labelBeatSnaps(rows, beats, [4])).slice(0, 3), [4, 0, 0]);
});
