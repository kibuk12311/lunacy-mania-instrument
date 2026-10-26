import test from "node:test";
import assert from "node:assert/strict";
import {
    buildSlots, buildSlotsFromTiming, parseRedTimingPoints,
    timingSections, sectionsToPoints, beatsFromTiming, slotsForBeats, slotsForTiming, clickTimes, timingFromPoints,
} from "../../src/gen/grid.js";

const pick = (slots) => slots.map(({ t, sub, bpm }) => ({ t, sub, bpm }));

test("timing sections accept the Timing shape and the old {bpm, offsetMs}", () => {
    assert.deepEqual(timingSections({ bpm: 174, offsetMs: 312 }), [{ timeMs: 312, bpm: 174, meter: 4 }]);
    const timing = { sections: [{ timeMs: 900, bpm: 200, meter: 3 }, { timeMs: 100, bpm: 150 }], bpm: 150, offsetMs: 100 };
    assert.deepEqual(timingSections(timing), [{ timeMs: 100, bpm: 150, meter: 4 }, { timeMs: 900, bpm: 200, meter: 3 }]);
    assert.deepEqual(sectionsToPoints(timingSections(timing)).map(({ time, beatLength, meter }) => ({ time, beatLength, meter })),
        [{ time: 100, beatLength: 400, meter: 4 }, { time: 900, beatLength: 300, meter: 3 }]);
});

test("an all-1/4 grid equals buildSlotsFromTiming on t, sub and bpm (one red point)", () => {
    for (const [bpm, offsetMs] of [[174, 312], [150, 400], [97.3, 1234.5], [222.22, 7]]) {
        const old = buildSlotsFromTiming([{ time: offsetMs, beatLength: 60000 / bpm }], 60000);
        const now = slotsForTiming({ bpm, offsetMs }, 60000);
        assert.deepEqual(pick(now), pick(old), `${bpm} @ ${offsetMs}`);
        // and the old one-BPM grid too
        assert.deepEqual(now.map((s) => [s.t, s.sub]), buildSlots({ bpm, offsetMs, endMs: 60000 }).slice(0, now.length).map((s) => [s.t, s.sub]));
    }
});

test("an all-1/4 grid equals buildSlotsFromTiming on t, sub and bpm (several red points)", () => {
    const text = "[TimingPoints]\r\n1000,500,4,1,0,100,1,0\r\n2500,-100,4,1,0,100,0,0\r\n3000,250,4,1,0,100,1,0\r\n"
        + "7333.3,344.8275862068966,4,1,0,100,1,0\r\n\r\n[HitObjects]\r\n";
    const points = parseRedTimingPoints(text);
    const old = buildSlotsFromTiming(points, 20000);
    const now = slotsForBeats(beatsFromTiming(points, 20000));
    assert.deepEqual(pick(now), pick(old));
    // beats count on across the red lines
    assert.deepEqual(now.slice(0, 5).map((s) => s.beat), [0, 0, 0, 0, 1]);
    assert.equal(now.at(-1).beat, beatsFromTiming(points, 20000).length - 1);
    const beats = new Set(now.map((s) => s.beat));
    assert.equal(beats.size, beatsFromTiming(points, 20000).length);
});

test("slots carry their divisor, position and beat length", () => {
    const slots = slotsForTiming({ bpm: 120, offsetMs: 1000 }, 3000);
    assert.deepEqual(slots[5], { t: 1625, beat: 1, sub: 1, div: 4, pos: 1, bpm: 120, beatMs: 500 });
});

test("a 1/6 beat has 6 evenly spaced slots and nearest-quarter subs", () => {
    const slots = slotsForTiming({ bpm: 100, offsetMs: 0 }, 2400, { divOf: (i) => (i === 1 ? 6 : 4) });
    const beat1 = slots.filter((s) => s.beat === 1);
    assert.deepEqual(beat1.map((s) => s.t), [600, 700, 800, 900, 1000, 1100]);
    assert.deepEqual(beat1.map((s) => s.sub), [0, 1, 1, 2, 3, 3]);
    assert.deepEqual(beat1.map((s) => s.pos), [0, 1, 2, 3, 4, 5]);
    assert.ok(beat1.every((s) => s.div === 6));
    const triplet = slotsForTiming({ bpm: 100, offsetMs: 0 }, 2400, { divOf: () => 3 }).filter((s) => s.beat === 2);
    assert.deepEqual(triplet.map((s) => [s.t, s.sub]), [[1200, 0], [1400, 1], [1600, 3]]);
    const eighths = slotsForTiming({ bpm: 100, offsetMs: 0 }, 2400, { divOf: () => 8 }).filter((s) => s.beat === 0);
    assert.deepEqual(eighths.map((s) => s.t), [0, 75, 150, 225, 300, 375, 450, 525]);
    assert.deepEqual(eighths.map((s) => s.sub), [0, 1, 1, 2, 2, 3, 3, 0]);
});

test("a beat cut by the next red line or by the end only keeps its slots before them", () => {
    const timing = { sections: [{ timeMs: 0, bpm: 120 }, { timeMs: 1250, bpm: 240 }] };
    const slots = slotsForTiming(timing, 2000, { divOf: () => 6 });
    assert.ok(slots.every((s, i) => i === 0 || s.t > slots[i - 1].t), "strictly increasing");
    const cut = slots.filter((s) => s.beat === 2);
    assert.deepEqual(cut.map((s) => s.t), [1000, 1083, 1167]);
    assert.equal(slots.find((s) => s.t === 1250).bpm, 240);
    assert.ok(slots.at(-1).t <= 2000);
});

test("legacy input gives the same slots as the Timing shape", () => {
    const a = slotsForTiming({ bpm: 174, offsetMs: 312 }, 30000);
    const b = slotsForTiming({ sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 }, 30000);
    assert.deepEqual(a, b);
});

test("click times follow each section's grid and extend the first red line backwards", () => {
    const points = sectionsToPoints(timingSections({ sections: [{ timeMs: 500, bpm: 120 }, { timeMs: 2000, bpm: 60 }] }));
    assert.deepEqual(clickTimes(points, 0, 4000, 1), [0, 500, 1000, 1500, 2000, 3000]);
    assert.deepEqual(clickTimes(points, 900, 1600, 2), [1000, 1250, 1500]);
    assert.deepEqual(clickTimes(points, 2000, 3600, 3).map(Math.round), [2000, 2333, 2667, 3000, 3333]);
});

test("timing from an .osu's red points", () => {
    const timing = timingFromPoints([{ time: 1000, beatLength: 500 }, { time: 3000, beatLength: 250, meter: 3 }]);
    assert.deepEqual(timing.sections, [{ timeMs: 1000, bpm: 120, meter: 4 }, { timeMs: 3000, bpm: 240, meter: 3 }]);
    assert.equal(timing.bpm, 120);
    assert.equal(timing.offsetMs, 1000);
});
