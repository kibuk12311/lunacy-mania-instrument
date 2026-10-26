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

// ---- G2: phrases and repeats (ML addendum §2.3) ----
import { barsOf } from "../../src/gen/songParts.js";
import { planBlocks } from "../../src/gen/partReport.js";
import { phraseStarts } from "../../src/gen/echo.js";

const qSlots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 32 * 2000 - 1);
const qBars = barsOf(qSlots);
// 32 bars: A (0–7) B (8–15) A (16–23) C (24–31); 8-bar phrases, but the second phrase is split 4 + 4
function abacStructure() {
    const n = qBars.length;
    const phrases = [{ bar: 0, bars: 8 }, { bar: 8, bars: 4 }, { bar: 12, bars: 4 }, { bar: 16, bars: 8 }, { bar: 24, bars: 8 }];
    const phraseOf = new Int32Array(n);
    phrases.forEach((p, k) => phraseOf.fill(k, p.bar, p.bar + p.bars));
    return {
        v: 1, meter: 4, bars: qBars.map((b) => ({ startMs: b.startMs, endMs: b.endMs })),
        echoOf: Int32Array.from({ length: n }, (_, b) => (b >= 16 && b < 24 ? b - 16 : -1)),
        echoSim: new Float32Array(n), phrases, phraseOf, repeats: [{ a: 0, b: 16, len: 8, sim: 0.9 }],
    };
}
const wholeSong = [{ startMs: 0, endMs: 64000, kind: "part" }];
const mix3 = [{ name: "Stream", share: 0.4 }, { name: "Jumpstream", share: 0.3 }, { name: "Handstream", share: 0.3 }];

test("mixed mode with phrases: families change only at phrase starts", () => {
    const s = abacStructure();
    const starts = phraseStarts(s, qSlots);
    for (let seed = 1; seed <= 20; seed += 1) {
        const a = assignByParts(qSlots, wholeSong, mix3, "mixed", mulberry32(seed), { structure: s });
        for (let i = 1; i < qSlots.length; i += 1) {
            if (a[i] !== a[i - 1]) assert.equal(starts[i], 1, `seed ${seed}: switch at slot ${i} (bar ${qBars.findIndex((b) => i >= b.i0 && i < b.i1)})`);
        }
        // without the structure mixed mode still picks per beat (v3), so it switches inside phrases
        const old = assignByParts(qSlots, wholeSong, mix3, "mixed", mulberry32(seed));
        assert.deepEqual(old, assignByParts(qSlots, wholeSong, mix3, "mixed", mulberry32(seed), { structure: null }));
    }
});

test("a repeated section takes the family plan of its first occurrence", () => {
    const s = abacStructure();
    for (const mode of ["mixed", "sections"]) {
        for (let seed = 1; seed <= 10; seed += 1) {
            const a = assignByParts(qSlots, wholeSong, mix3, mode, mulberry32(seed), { structure: s });
            for (let i = qBars[16].i0; i < qBars[24].i0; i += 1) assert.equal(a[i], a[i - qBars[16].i0], `${mode} seed ${seed} slot ${i}`);
        }
    }
    // a part with its own patterns does not take families it may not use
    const parts2 = [{ startMs: 0, endMs: 32000, kind: "part" }, { startMs: 32000, endMs: 64000, kind: "drop", patterns: [{ name: "Chordjack", share: 1 }] }];
    const a = assignByParts(qSlots, parts2, [{ name: "Stream", share: 1 }], "sections", mulberry32(3), { structure: s });
    for (let i = qBars[16].i0; i < qSlots.length; i += 1) assert.equal(a[i], "Chordjack");
});

test("blocks are cut at phrase starts (the 32-slot minimum and the merge rule stay)", () => {
    const s = abacStructure();
    const assign = qSlots.map(() => "Stream");
    const partOf = new Int32Array(qSlots.length);
    const starts = phraseStarts(s, qSlots);
    const plain = planBlocks(assign, qSlots, partOf, "sections");
    assert.equal(plain.length, 1);
    const cut = planBlocks(assign, qSlots, partOf, "sections", { phraseStart: starts });
    assert.deepEqual(cut.map((b) => b.i0), [0, 8, 12, 16, 24].map((bar) => qBars[bar].i0));
    assert.ok(cut.every((b) => b.i1 - b.i0 >= 32));
    // mixed: 32-slot chunks, and a chunk never crosses a phrase start
    const mixed = planBlocks(assign, qSlots, partOf, "mixed", { phraseStart: starts });
    for (const b of mixed) for (let i = b.i0 + 1; i < b.i1; i += 1) assert.equal(starts[i], 0);
    assert.deepEqual(planBlocks(assign, qSlots, partOf, "mixed"), planBlocks(assign, qSlots, partOf, "mixed", { phraseStart: null }));
});
