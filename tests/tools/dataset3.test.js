import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import {
    gridLabels, timingReject, allFinite, splitOf, groupHash, heldoutList, mirrorMask, beatSlotOffsets,
    msdOursVector, msdTrackerVector, msdEtternaVector, MSD8, mapBase,
} from "../../tools/lib/dataset3.mjs";

const BEAT = 400; // 150 BPM
const pts = (extra = []) => [{ time: 1000, beatLength: BEAT }, ...extra];

// rows on 1/4 for 64 beats, then 8 beats of triplets (1/3), then 1/4 again
function chart({ tripletFrom = 64, tripletBeats = 8, beats = 120, div16 = false } = {}) {
    const rows = [];
    let c = 0;
    for (let b = 0; b < beats; b++) {
        const t0 = 1000 + b * BEAT;
        const div = div16 ? 16 : b >= tripletFrom && b < tripletFrom + tripletBeats ? 3 : 4;
        const take = div16 ? [0, 1, 3, 5, 7, 9, 13] : [...Array(div).keys()];
        for (const k of take) rows.push({ t: Math.round(t0 + (k * BEAT) / div), mask: 1 << (c++ % 4) });
    }
    return rows;
}

test("timing filter: absurd BPM inside the played part drops the chart, outside it does not", () => {
    assert.equal(timingReject([], 0, 1000), "no timing");
    assert.equal(timingReject(pts(), 0, 50_000), null);
    // a 6,000,000 BPM gimmick line at 20 s
    assert.equal(timingReject(pts([{ time: 20_000, beatLength: 0.01 }, { time: 20_050, beatLength: BEAT }]), 0, 50_000), "absurd BPM");
    // a 1e300 ms beat (BPM ~0) → inf slot_ms in v1.5
    assert.equal(timingReject(pts([{ time: 20_000, beatLength: 1e300 }]), 0, 50_000), "absurd BPM");
    // a gimmick line after the last row is not played
    assert.equal(timingReject(pts([{ time: 60_000, beatLength: 0.01 }]), 0, 50_000), null);
    const rows = chart();
    assert.equal(gridLabels(rows, pts([{ time: 20_000, beatLength: 0.01 }, { time: 20_050, beatLength: BEAT }]), 50_000).reject, "absurd BPM");
});

test("grid labels: 1/4 and triplet beats, CSR beat → slot offsets, slot divisors, families, all rows matched", () => {
    const rows = chart();
    const endMs = rows.at(-1).t + 1000;
    const g = gridLabels(rows, pts(), endMs);
    assert.equal(g.reject, undefined);
    // beats start 2 s before the first row, but not before the first red line (here: the first row)
    assert.equal(g.beats[0].t, 1000);
    assert.equal(g.divs[0], 4);
    for (let b = 64; b < 72; b++) assert.equal(g.divs[b], 3, `beat ${b}`);
    assert.equal(g.divs[72], 4);
    assert.equal(g.beatSlot0.length, g.beats.length + 1);
    for (let b = 0; b < g.beats.length; b++) {
        const [a, e] = [g.beatSlot0[b], g.beatSlot0[b + 1]];
        assert.ok(e > a, `beat ${b} has slots`);
        for (let i = a; i < e; i++) assert.equal(g.slots[i].beat, b);
        if (b < 120) assert.equal(e - a, g.divs[b] || 4);
    }
    assert.equal(g.slotDiv[g.beatSlot0[65]], 3);
    assert.equal(g.residualOffgrid, 0);
    assert.equal(g.offBeatShare, 0);
    let notes = 0;
    for (const n of g.note) notes += n;
    assert.equal(notes, rows.length);
    // single-column stream → Stream family everywhere there are rows
    assert.equal(g.family[0], 0);
    assert.ok(Math.abs(g.divShare[3] - 8 / g.beats.length) < 1e-3);
});

test("1/16 dumps and short charts are dropped", () => {
    const rows = chart({ div16: true });
    assert.equal(gridLabels(rows, pts(), rows.at(-1).t + 1000).reject, "1/12-1/16 dump");
    assert.equal(gridLabels(chart({ beats: 20 }), pts(), 20_000).reject, "under 100 rows");
});

test("beat → slot offsets handle a beat cut short at a red line", () => {
    const slots = [{ beat: 0 }, { beat: 0 }, { beat: 1 }, { beat: 2 }, { beat: 2 }, { beat: 2 }];
    assert.deepEqual([...beatSlotOffsets(slots, 3)], [0, 2, 3, 6]);
});

test("splits: held-out → test, quarantine → none, val by crc32 of the song group (the same number Python's zlib gives)", () => {
    assert.equal(groupHash("abc|def"), crc32(Buffer.from("abc|def")));
    // python -c "import zlib; print(zlib.crc32('abc|def'.encode()), zlib.crc32('камелия|曲'.encode()))"
    assert.equal(groupHash("abc|def"), 4184808628);
    assert.equal(groupHash("камелия|曲"), 1075183797);
    assert.equal(splitOf({ split: "heldout", group: "x" }), "test");
    assert.equal(splitOf({ split: "quarantine", group: "x" }), null);
    const groups = Array.from({ length: 2000 }, (_, i) => `artist${i}|song${i}`);
    const val = groups.filter((g) => splitOf({ split: "train", group: g }) === "val");
    assert.ok(val.length > 150 && val.length < 250, `val ${val.length}`);
    // stable: a group's split never depends on what else is in the corpus
    assert.equal(splitOf({ split: "train", group: val[0] }), "val");
    assert.ok(val.every((g) => groupHash(g) % 10 === 1));
});

test("held-out list: test, val and quarantine groups with every member song key", () => {
    const lines = [
        { split: "heldout", group: "a|x", songKey: "a|x", duplicates: [{ songKey: "a|x tv" }, { songKey: "a|x" }] },
        { split: "heldout", group: "a|x", songKey: "a|x2", duplicates: [] },
        { split: "quarantine", group: "q|q", songKey: "q|q", duplicates: [] },
        { split: "train", group: "t|t", songKey: "t|t", duplicates: [] },
    ];
    const h = heldoutList(lines, "now");
    assert.deepEqual(h.test, [{ group: "a|x", songKeys: ["a|x", "a|x tv", "a|x2"] }]);
    assert.deepEqual(h.quarantine, [{ group: "q|q", songKeys: ["q|q"] }]);
    assert.equal(h.made, "now");
});

test("MSD vectors in one order; Etterna gives the overall only; mirror is an involution; finite check", () => {
    assert.deepEqual(MSD8, ["overall", "stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"]);
    const ours = Object.fromEntries(MSD8.map((k, i) => [k, i + 0.123]));
    assert.deepEqual(msdOursVector(ours), [0.12, 1.12, 2.12, 3.12, 4.12, 5.12, 6.12, 7.12]);
    assert.deepEqual(msdTrackerVector({ Overall: 20, Stream: 18, JackSpeed: 12, LN: 0 }), [20, 18, null, null, null, 12, null, null]);
    assert.deepEqual(msdEtternaVector(17.134), [17.13, null, null, null, null, null, null, null]);
    assert.equal(msdEtternaVector(null), null);
    assert.equal(msdOursVector(null), null);
    for (let m = 0; m < 16; m++) assert.equal(mirrorMask(mirrorMask(m)), m);
    assert.equal(mirrorMask(0b0001), 0b1000);
    assert.equal(mirrorMask(0b0110), 0b0110);
    assert.equal(allFinite(new Float32Array([1, 2, 3])), true);
    assert.equal(allFinite(new Float32Array([1, Infinity])), false);
    assert.equal(allFinite(new Float32Array([NaN])), false);
    assert.equal(mapBase("abcdef0123"), "maps/ab/abcdef0123");
});

test("1/4 and 1/3 rows mixed in one beat: not a dump, the beat is cut on the grid holding most of its rows", () => {
    const rows = [];
    let c = 0;
    for (let b = 0; b < 130; b++) {
        const t0 = 1000 + b * BEAT;
        const pos = b >= 60 && b < 70 ? [0, 1 / 3, 2 / 3, 3 / 4] : [0, 1 / 4, 2 / 4, 3 / 4];
        for (const p of pos) rows.push({ t: Math.round(t0 + p * BEAT), mask: 1 << (c++ % 4) });
    }
    const g = gridLabels(rows, pts(), rows.at(-1).t + 1000);
    assert.equal(g.reject, undefined);
    assert.equal(g.divs[60], 0, "no single grid holds the beat");
    assert.equal(g.slotDiv[g.beatSlot0[60]], 3, "cut in thirds: 3 of its 4 rows");
    assert.equal(g.offBeatShare, 0, "every row is on some 4/3/6/8 grid");
    assert.ok(Math.abs(g.residualOffgrid - 10 / rows.length) < 1e-9, `${g.residualOffgrid}`);
});
