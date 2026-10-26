import test from "node:test";
import assert from "node:assert/strict";
import { planBlocks, scoreBlock, describeParts } from "../../src/gen/partReport.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { partIndexOfSlots } from "../../src/gen/songParts.js";
import { toOsu } from "../../src/gen/writer.js";
import { chartInfo } from "../../src/core/features.js";

const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 60000); // 125 ms slots, 8 per second
const parts = [
    { startMs: 0, endMs: 20000, kind: "intro" },
    { startMs: 20000, endMs: 30000, kind: "break", empty: true },
    { startMs: 30000, endMs: 60000, kind: "drop", range: { lo: 5, hi: 7 } },
];
const partOf = partIndexOfSlots(slots, parts);
const assign = slots.map((s) => (s.t < 20000 ? (s.t < 8000 ? "Stream" : s.t < 9000 ? "Jack" : "Jumpstream") : s.t < 30000 ? null : "Chordjack"));

test("blocks: one family per run inside a part, short runs join the block before, empty parts have none", () => {
    const blocks = planBlocks(assign, slots, partOf, "sections");
    // the 1 s of Jack is too short for a block of its own: it joins the Stream block before it
    assert.deepEqual(blocks.map((b) => [b.part, b.inPart, b.families.join("+")]), [[0, 0, "Stream+Jack"], [0, 1, "Jumpstream"], [2, 0, "Chordjack"]]);
    assert.equal(blocks[0].startMs, 0);
    assert.equal(blocks[1].startMs, 9000);
    assert.equal(blocks[2].startMs, 30000);
    assert.ok(blocks.every((b, i) => b.index === i && b.i1 - b.i0 >= 32));
    const mixed = planBlocks(assign, slots, partOf, "mixed");
    assert.ok(mixed.filter((b) => b.part === 2).every((b) => b.i1 - b.i0 === 32 || b === mixed.at(-1)));
});

test("a block is scored by the pattern finder from 24 rows on", () => {
    const block = { startMs: 0, endMs: 8000, families: ["Stream"] };
    const rows = slots.filter((s) => s.t < 8000 && s.sub % 2 === 0).map((s) => ({ t: s.t, mask: 1 << (s.beat % 4), family: "Stream" }));
    const render = (r) => toOsu({ rows: r, bpm: 120, offsetMs: 0, title: "b", version: "b", audioFilename: "a.mp3" });
    let seen = null;
    const patternsOf = (text) => { seen = chartInfo(text, 1).noteCount; return [{ name: "Rolls", share: 0.75 }, { name: "Minijacks", share: 0.25 }]; };
    assert.equal(scoreBlock(rows, block, { patternsOf, render }), 0.75);
    assert.equal(seen, rows.length);
    assert.equal(scoreBlock(rows.slice(0, 20), block, { patternsOf, render }), null);
    assert.equal(scoreBlock(rows, { ...block, families: ["Stream", "Jack"] }, { patternsOf, render }), 1);
    assert.equal(scoreBlock(rows, { ...block, families: ["Tech"] }, { patternsOf, render }), null, "Tech is not a cluster");
});

test("part reports: an excerpt's dan for parts with notes, nothing for the empty one", async () => {
    const blocks = planBlocks(assign, slots, partOf, "sections");
    const rows = slots.filter((s) => (s.t < 20000 || s.t >= 30000) && s.sub === 0).map((s) => ({ t: s.t, mask: 3, family: s.t < 20000 ? "Stream" : "Chordjack" }));
    const analyze = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 50, top3: [{ name: "Chordjacks", share: 1 }] });
    const progress = [];
    const reports = await describeParts(rows, parts, blocks, {
        analyze, timing: { bpm: 120, offsetMs: 0 }, issues: [{ t: 35000, kind: "jack" }], retried: new Map([[2, 1]]), locked: new Set([0]),
        onProgress: (p) => progress.push(p.i),
    });
    assert.deepEqual(progress, [0, 1, 2]);
    assert.equal(reports.length, 3);
    assert.equal(reports[1].empty, true);
    assert.equal(reports[1].dan, null);
    assert.equal(reports[1].patternScore, null);
    assert.equal(reports[1].inRange, null);
    assert.equal(reports[0].locked, true);
    assert.equal(reports[0].inRange, null, "no wanted range, no verdict");
    assert.deepEqual(reports[2].wanted, { lo: 5, hi: 7 });
    assert.equal(reports[2].patternScore, 1);
    assert.equal(reports[2].issues, 1);
    assert.equal(reports[2].retried, 1);
    assert.equal(reports[2].noteCount, 60 * 2);
    assert.ok(reports[2].dan.numeric > 0 && typeof reports[2].dan.label === "string");
    assert.equal(reports[2].inRange, reports[2].dan.numeric >= 5 && reports[2].dan.numeric < 7);
    assert.deepEqual(reports[2].families, ["Chordjack"]);
});

// ---- flavours (sub-patterns): the searches' own score, in the weak-block redo and in the part reports ----

// sweeps up and down (1234 3212 34 …): every row in the Rolls motif
const rollRows = (from, to, flavour) => slots.filter((s) => s.t >= from && s.t < to && s.sub % 2 === 0)
    .map((s, k) => ({ t: s.t, mask: 1 << [0, 1, 2, 3, 2, 1][k % 6], family: "Stream", ...(flavour ? { flavour } : {}) }));
const renderRows = (r) => toOsu({ rows: r, bpm: 120, offsetMs: 0, title: "b", version: "b", audioFilename: "a.mp3" });

test("a block with planned kinds gets the search's score: coverage first, the family second", () => {
    const block = { startMs: 0, endMs: 8000, families: ["Stream"], i0: 0, i1: 64 };
    const shown = rollRows(0, 8000, "Rolls");
    const named = () => [{ name: "Rolls", share: 1 }];
    const plainNames = () => [{ name: "Stream", share: 1 }];
    // (nearly) every planned row in the motif and the finder names it: about 1 + 0.1 × the family score (1)
    const full = scoreBlock(shown, block, { patternsOf: named, render: renderRows, assign });
    assert.ok(full > 1.05 && full <= 1.1 + 1e-9, String(full));
    // the same rows planned as trills: our detector finds none of them; the finder names no trills either
    const missed = shown.map((r) => ({ ...r, flavour: "Trills" }));
    assert.ok(Math.abs(scoreBlock(missed, block, { patternsOf: plainNames, render: renderRows, assign }) - 0.1) < 1e-9);
    // without planned kinds: the family score exactly as before
    assert.equal(scoreBlock(rollRows(0, 8000), block, { patternsOf: named, render: renderRows }), 1);
    // a block with a family the finder can't judge (Tech) is not scored, with a kind or without, alone or mixed:
    // it would sit below the redo bar by construction
    const tech = rollRows(0, 8000, "JackyStream").map((r) => ({ ...r, family: "Tech" }));
    assert.equal(scoreBlock(tech, { ...block, families: ["Tech"] }, { patternsOf: plainNames, render: renderRows }), null);
    const mixed = shown.map((r, k) => (k % 2 ? { ...r, family: "Tech", flavour: undefined } : r));
    assert.equal(scoreBlock(mixed, { ...block, families: ["Stream", "Tech"] }, { patternsOf: named, render: renderRows, assign }), null);
});

test("part reports: the kinds planned in a part and how they came out, the kinds found there", async () => {
    const blocks = planBlocks(assign, slots, partOf, "sections");
    const rows = [...rollRows(0, 20000, "Rolls"), ...rollRows(30000, 60000).map((r) => ({ ...r, family: "Chordjack" }))];
    const analyze = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 50, top3: [{ name: "Rolls", share: 1 }] });
    const reports = await describeParts(rows, parts, blocks, { analyze, timing: { bpm: 120, offsetMs: 0 }, assign });
    assert.deepEqual(reports[0].flavours, ["Rolls"]);
    assert.ok(reports[0].flavourScore > 0.9, String(reports[0].flavourScore));
    assert.equal(reports[0].detected[0].id, "Rolls");
    assert.deepEqual(reports[2].flavours, []);
    assert.equal(reports[2].flavourScore, null);
    assert.equal(reports[2].detected[0].id, "Rolls", "found even where none was asked for");
});
