// The create tab's snap palette and beat grid: colour by beat fraction, grid lines over sections, the section in force.
import test from "node:test";
import assert from "node:assert/strict";
import { SNAP_COLORS, sectionsOf, sectionIndexAt, snapOf, gridLines, beatMsAt } from "../../app/renderer/snapColors.js";

const ONE = { sections: [{ timeMs: 100, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 100 }; // beat 500 ms
const TWO = { sections: [{ timeMs: 100, bpm: 120, meter: 4 }, { timeMs: 4100, bpm: 150, meter: 3 }] }; // 500 ms, then 400 ms

test("one colour per fraction: 1/1 red, 1/2 blue, 1/3 purple, 1/4 yellow, 1/6 pink, 1/8 orange", () => {
    assert.equal(new Set([1, 2, 3, 4, 6, 8].map((d) => SNAP_COLORS[d])).size, 6);
    assert.ok(SNAP_COLORS[0], "off-grid has a colour too");
});

test("sections: Timing or the old { bpm, offsetMs }, sorted", () => {
    assert.deepEqual(sectionsOf({ bpm: 174, offsetMs: 312 }), [{ timeMs: 312, bpm: 174, meter: 4 }]);
    assert.deepEqual(sectionsOf({ sections: [{ timeMs: 900, bpm: 100 }, { timeMs: 10, bpm: 200, meter: 3 }] }),
        [{ timeMs: 10, bpm: 200, meter: 3 }, { timeMs: 900, bpm: 100, meter: 4 }]);
    assert.equal(sectionIndexAt(sectionsOf(TWO), 0), 0, "before the first red line: the first section");
    assert.equal(sectionIndexAt(sectionsOf(TWO), 4099), 0);
    assert.equal(sectionIndexAt(sectionsOf(TWO), 4100), 1);
    assert.equal(beatMsAt(TWO, 5000), 400);
});

test("snapOf: the right fraction for 1/1, 1/2, 1/3, 1/4, 1/6 and 1/8, rounding to whole ms allowed", () => {
    const at = (beats) => Math.round(100 + beats * 500);
    assert.equal(snapOf(at(3), ONE).div, 1);
    assert.equal(snapOf(at(3.5), ONE).div, 2);
    assert.equal(snapOf(at(3 + 1 / 3), ONE).div, 3);
    assert.equal(snapOf(at(3 + 2 / 3), ONE).div, 3);
    assert.equal(snapOf(at(3.25), ONE).div, 4);
    assert.equal(snapOf(at(3.75), ONE).div, 4);
    assert.equal(snapOf(at(3 + 1 / 6), ONE).div, 6);
    assert.equal(snapOf(at(3 + 5 / 6), ONE).div, 6);
    assert.equal(snapOf(at(3.125), ONE).div, 8);
    assert.equal(snapOf(at(3.375), ONE).div, 8);
    assert.equal(snapOf(at(3 + 1 / 16), ONE).div, 0, "1/16 is off these grids");
    assert.equal(snapOf(at(3.25), ONE).color, SNAP_COLORS[4]);
    assert.equal(snapOf(at(3 + 1 / 3), ONE).color, SNAP_COLORS[3]);
    // before the first red line the grid runs backwards
    assert.equal(snapOf(100 - 250, ONE).div, 2);
    // the second section's own grid: 4100 + 400 · 1.25
    assert.equal(snapOf(4600, TWO).div, 4);
    assert.equal(snapOf(4100 + 200, TWO).div, 2);
});

test("grid lines: every fraction of every beat, restarting at each section, bars by meter", () => {
    const lines = gridLines(ONE, 100, 1100, 4); // two beats
    assert.deepEqual(lines.map((l) => l.t), [100, 225, 350, 475, 600, 725, 850, 975]);
    assert.deepEqual(lines.map((l) => l.div), [1, 4, 2, 4, 1, 4, 2, 4]);
    assert.equal(lines[0].bar, true);
    assert.equal(lines[4].bar, false);

    const across = gridLines(TWO, 3000, 5000, 1);
    assert.deepEqual(across.map((l) => l.t), [3100, 3600, 4100, 4500, 4900]);
    assert.deepEqual(across.map((l) => l.bar), [false, false, true, false, false], "a section starts a bar");
    const triplets = gridLines(ONE, 100, 600, 3);
    assert.deepEqual(triplets.map((l) => Math.round(l.t)), [100, 267, 433]);
    assert.deepEqual(triplets.map((l) => l.div), [1, 3, 3]);
    // before the first red line
    assert.deepEqual(gridLines(ONE, -1000, 100, 1).map((l) => l.t), [-900, -400]);
});

test("grid lines stop at a sane count", () => {
    assert.ok(gridLines(ONE, 0, 1e9, 8).length <= 20000);
});
