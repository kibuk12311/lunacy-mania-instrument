import test from "node:test";
import assert from "node:assert/strict";
import { slotsForTiming } from "../../src/gen/grid.js";
import { barsOf } from "../../src/gen/songParts.js";
import { echoSlots, echoPlan, createEcho, phraseStarts, echoCopy, ECHO_DEFAULTS, UNDECIDED } from "../../src/gen/echo.js";

// A hand-made structure on a 1/4 grid: 24 bars, bars 16–23 repeat bars 0–7, phrases of 8 bars.
const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 24 * 2000 - 1);
const bars = barsOf(slots);
const structureOf = ({ echo = (b) => (b >= 16 ? b - 16 : -1), phrases = [0, 8, 16].map((bar) => ({ bar, bars: 8 })) } = {}) => {
    const n = bars.length;
    const phraseOf = new Int32Array(n);
    phrases.forEach((p, k) => phraseOf.fill(k, p.bar, p.bar + p.bars));
    return {
        v: 1, meter: 4, bars: bars.map((b) => ({ startMs: b.startMs, endMs: b.endMs })),
        echoOf: Int32Array.from({ length: n }, (_, b) => echo(b)), echoSim: new Float32Array(n).fill(0.9),
        phrases, phraseOf, repeats: [{ a: 0, b: 16, len: 8, sim: 0.9 }],
    };
};

test("echo slots point to the same beat and position of the source bar", () => {
    assert.equal(bars.length, 24);
    const s = structureOf();
    const map = echoSlots(s, slots);
    for (let i = 0; i < slots.length; i += 1) {
        const b = bars.findIndex((x) => i >= x.i0 && i < x.i1);
        if (b < 16) {
            assert.equal(map[i], -1);
            continue;
        }
        const j = map[i];
        assert.ok(j >= 0 && j < i);
        assert.equal(slots[i].t - slots[j].t, 16 * 2000);
        assert.equal(slots[i].pos ?? slots[i].sub, slots[j].pos ?? slots[j].sub);
    }
});

test("a beat on a grid its source beat does not have is left to the source (re-sampled)", () => {
    // bar 16's second beat in triplets, its source (bar 0) in quarters
    const divOf = (beat) => (beat === 65 ? 3 : 4);
    const mixed = slotsForTiming({ bpm: 120, offsetMs: 0 }, 24 * 2000 - 1, { divOf });
    const s = structureOf();
    s.bars = barsOf(mixed).map((b) => ({ startMs: b.startMs, endMs: b.endMs }));
    const map = echoSlots(s, mixed);
    const triplet = mixed.map((x, i) => [x, i]).filter(([x]) => x.beat === 65).map(([, i]) => i);
    assert.equal(triplet.length, 3);
    for (const i of triplet) assert.equal(map[i], -1);
    const quarter = mixed.map((x, i) => [x, i]).filter(([x]) => x.beat === 66).map(([, i]) => i);
    for (const i of quarter) assert.ok(map[i] >= 0);
});

test("the plan varies the fill bar of every 8-bar phrase and about a quarter of the other echoed bars", () => {
    const s = structureOf();
    let varied = 0;
    let echoed = 0;
    let mirroredPhrases = 0;
    const seeds = 400;
    for (let seed = 1; seed <= seeds; seed += 1) {
        const plan = echoPlan(s, seed);
        assert.equal(plan.varied[23], 1, "the fill bar (last of the 8-bar phrase) is always varied");
        for (let b = 0; b < 16; b += 1) assert.equal(plan.varied[b], 0, "bars without an echo are never 'varied'");
        for (let b = 16; b < 23; b += 1) {
            echoed += 1;
            varied += plan.varied[b];
        }
        // a mirror is per phrase: all its bars or none
        const m = Array.from(plan.mirrored.slice(16, 24));
        assert.ok(m.every((x) => x === m[0]));
        mirroredPhrases += m[0];
        assert.deepEqual(echoPlan(s, seed), plan, "same seed, same plan");
    }
    assert.ok(Math.abs(varied / echoed - ECHO_DEFAULTS.pVar) < 0.04, `varied share ${(varied / echoed).toFixed(3)}`);
    assert.ok(Math.abs(mirroredPhrases / seeds - ECHO_DEFAULTS.pMirror) < 0.05, `mirror share ${mirroredPhrases / seeds}`);
});

test("copies come from rows already decided in the build, in the source's family, mirrored with the phrase", () => {
    const s = structureOf();
    const assign = slots.map(() => "Stream");
    const echo = createEcho({ structure: s, slots, assign });
    // a seed whose plan copies bar 16 unmirrored, and one whose plan mirrors it
    const seedWith = (want) => {
        for (let seed = 1; seed < 500; seed += 1) {
            const p = echoPlan(s, seed);
            if (!p.varied[16] && p.mirrored[16] === want) return seed;
        }
        throw new Error("no seed");
    };
    const decided = new Uint8Array(slots.length).fill(UNDECIDED);
    const i = bars[16].i0;
    const j = echo.echoSlot[i];
    assert.equal(echo.forBuild(seedWith(0)).copyAt(i, decided), null, "an undecided source is no copy");
    decided[j] = 3;
    assert.equal(echo.forBuild(seedWith(0)).copyAt(i, decided), 3);
    assert.equal(echo.forBuild(seedWith(1)).copyAt(i, decided), 12);
    decided[j] = 0;
    assert.equal(echo.forBuild(seedWith(0)).copyAt(i, decided), 0, "an empty source slot copies as no row");
    const other = createEcho({ structure: s, slots, assign: slots.map((_, k) => (k >= bars[16].i0 ? "Jack" : "Stream")) });
    decided[j] = 3;
    assert.equal(other.forBuild(seedWith(0)).copyAt(i, decided), null, "another family is no copy");
    assert.equal(echo.forBuild(seedWith(0)).copyAt(bars[3].i0, decided), null, "a bar without an echo");
});

test("with an infill source 40% of the echo slots are dropped back to free (strength 0.6), per bar from its own seed", () => {
    const s = structureOf();
    const assign = slots.map(() => "Stream");
    const echo = createEcho({ structure: s, slots, assign });
    const decided = new Uint8Array(slots.length).fill(0);
    let kept = 0;
    let total = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
        const run = echo.forBuild(seed, { infill: true });
        for (let i = bars[16].i0; i < bars[23].i0; i += 1) {
            if (run.plan.varied[bars.findIndex((x) => i >= x.i0 && i < x.i1)]) continue;
            total += 1;
            if (run.copyAt(i, decided) !== null) kept += 1;
        }
    }
    assert.ok(Math.abs(kept / total - ECHO_DEFAULTS.strength) < 0.05, `kept ${(kept / total).toFixed(3)}`);
});

test("a copied row the guard vetoes is re-sampled, never kept; an empty copy needs no guard", () => {
    const veto5 = Object.assign((m) => (m === 5 ? 0 : 1), { fallback: () => 1 });
    let sampled = 0;
    const sample = () => {
        sampled += 1;
        return 2;
    };
    assert.deepEqual(echoCopy(5, veto5, sample), { mask: 2, echoed: false, vetoed: true });
    assert.equal(sampled, 1);
    assert.deepEqual(echoCopy(10, veto5, sample), { mask: 10, echoed: true, vetoed: false });
    assert.deepEqual(echoCopy(0, () => 0, sample), { mask: 0, echoed: true, vetoed: false });
    assert.deepEqual(echoCopy(null, veto5, sample), { mask: 2, echoed: false, vetoed: false });
    assert.equal(sampled, 2);
});

test("phrase starts mark the first slot of every phrase", () => {
    const s = structureOf();
    const starts = phraseStarts(s, slots);
    const marked = [...starts].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(marked, [bars[0].i0, bars[8].i0, bars[16].i0]);
});
