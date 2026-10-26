import test from "node:test";
import assert from "node:assert/strict";
import { assignByParts } from "../../src/gen/assign.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { mulberry32 } from "../../src/gen/rng.js";

const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 120000, { divOf: (i) => (i % 7 === 3 ? 3 : 4) });
const parts = [
    { startMs: 0, endMs: 30000, kind: "intro", patterns: [{ name: "Stream", share: 1 }] },
    { startMs: 30000, endMs: 50000, kind: "break", empty: true },
    { startMs: 50000, endMs: 120000, kind: "drop" },
];
const defaults = [{ name: "Jumpstream", share: 0.5 }, { name: "Chordjack", share: 0.5 }];

test("families stay inside their part and empty parts get none", () => {
    const a = assignByParts(slots, parts, defaults, "sections", mulberry32(4));
    assert.equal(a.length, slots.length);
    slots.forEach((s, i) => {
        if (s.t < 30000) assert.equal(a[i], "Stream");
        else if (s.t < 50000) assert.equal(a[i], null);
        else assert.ok(["Jumpstream", "Chordjack"].includes(a[i]));
    });
});

test("pattern sections start at part starts and last 8 beats", () => {
    const a = assignByParts(slots, parts, defaults, "sections", mulberry32(9));
    const first = slots.findIndex((s) => s.t >= 50000);
    // every switch inside the drop falls on an 8-beat line counted from the part's first beat
    for (let i = first + 1; i < slots.length; i += 1) {
        if (a[i] !== a[i - 1]) assert.equal((slots[i].beat - slots[first].beat) % 8, 0, `switch at beat ${slots[i].beat}`);
    }
    // mixed mode: one family per beat, whatever its grid
    const m = assignByParts(slots, parts, defaults, "mixed", mulberry32(9));
    for (let i = first + 1; i < slots.length; i += 1) if (slots[i].beat === slots[i - 1].beat) assert.equal(m[i], m[i - 1]);
});
