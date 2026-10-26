import test from "node:test";
import assert from "node:assert/strict";
import { createGuard, rowStats, findIssues, LIMITS } from "../../src/gen/playability.js";
import { slotsForTiming } from "../../src/gen/grid.js";

// 150 BPM, 1/4: 100 ms between slots
const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 60000);

test("limits per family", () => {
    assert.equal(LIMITS.Stream.jack, 2);
    assert.equal(LIMITS.Handstream.anchor, 0.65);
    assert.equal(LIMITS.Chordjack.anchor, null);
    assert.equal(LIMITS.Jack.minJackMs, 50);
});

test("a third same-column row in a stream is vetoed; 16 are fine in a chordjack", () => {
    const g = createGuard({ slots });
    g.push(1, 0, "Stream");
    g.push(1, 1, "Stream");
    assert.equal(g.weight(1, 2, "Stream"), 0);
    assert.ok(g.weight(2, 2, "Stream") > 0);
    const cj = createGuard({ slots });
    for (let i = 0; i < 15; i += 1) {
        assert.ok(cj.weight(0b0011, i * 2, "Chordjack") > 0, `row ${i}`);
        cj.push(0b0011, i * 2, "Chordjack");
    }
    assert.ok(cj.weight(0b0011, 30, "Chordjack") > 0, "the 16th");
    cj.push(0b0011, 30, "Chordjack");
    assert.equal(cj.weight(0b0011, 32, "Chordjack"), 0, "the 17th");
});

test("a gap of more than half a beat ends a jack", () => {
    const g = createGuard({ slots });
    g.push(1, 0, "Stream");
    g.push(1, 1, "Stream");
    assert.ok(g.weight(1, 4, "Stream") > 0); // 300 ms later, over the 200 ms half beat
});

test("after a left-heavy stretch a right single outweighs a left single", () => {
    const g = createGuard({ slots });
    const left = [1, 2, 1, 2, 4, 1, 2, 8, 1, 2, 4, 2, 1, 8, 2, 1, 2, 4, 1, 2];
    left.forEach((m, i) => g.push(m, i * 2, "Jumpstream"));
    const i = left.length * 2;
    assert.ok(g.weight(4, i, "Jumpstream") > 1.5 * g.weight(1, i, "Jumpstream"), `${g.weight(4, i, "Jumpstream")} vs ${g.weight(1, i, "Jumpstream")}`);
});

test("one column in too many rows is an anchor and is vetoed", () => {
    const g = createGuard({ slots });
    [1, 2, 1, 4, 1, 8, 1, 2].forEach((m, i) => g.push(m, i * 2, "Stream"));
    assert.equal(g.weight(1, 16, "Stream"), 0);
    assert.ok(g.weight(4, 16, "Stream") > 0);
});

test("ahead stops a free row from turning a kept 2-note jack into a 3-note jack", () => {
    const g = createGuard({ slots });
    g.push(4, 0, "Stream");
    const ahead = { run: [0, 2, 0, 0] };
    assert.equal(g.weight(2, 1, "Stream", ahead), 0);
    assert.ok(g.weight(1, 1, "Stream", ahead) > 0);
    assert.equal(g.weight(8, 1, "Stream", { nextT: [Infinity, Infinity, Infinity, 160] }), 0, "too fast before the next kept note");
});

test("the fallback is an allowed single, and it is counted", () => {
    const g = createGuard({ slots });
    g.push(0b0111, 0, "Stream");
    g.push(0b0111, 1, "Stream");
    const m = g.fallback(2, "Stream");
    assert.equal(m, 8);
    assert.equal(g.forced, 1);
});

const at = (ms, cols, family = "Stream") => ({ t: ms, cols, family });

test("fastJack is flagged at 60 ms in a stream but not at 55 ms in a jack pattern", () => {
    const fast = slotsForTiming({ bpm: 250, offsetMs: 0 }, 10000); // 60 ms slots
    const stream = findIssues([at(0, [0]), at(60, [0]), at(120, [1])], fast);
    assert.ok(stream.some((x) => x.kind === "fastJack" && x.col === 0 && x.ms === 60), JSON.stringify(stream));
    const jacky = slotsForTiming({ bpm: 272.7, offsetMs: 0 }, 10000);
    const jack = findIssues([at(0, [0], "Jack"), at(55, [0], "Jack"), at(110, [1], "Jack")], jacky);
    assert.ok(!jack.some((x) => x.kind === "fastJack"), JSON.stringify(jack));
});

test("long jacks, a spike and uneven columns are flagged", () => {
    const rows = [];
    for (let k = 0; k < 64; k += 1) rows.push(at(k * 100, [k % 4]));
    rows.push(at(6400, [2]), at(6500, [2]), at(6600, [2]));
    const issues = findIssues(rows, slots);
    assert.ok(issues.some((x) => x.kind === "jack" && x.col === 2 && x.n >= 3), JSON.stringify(issues));
    // a beat with 12 notes in a section of single notes
    const spiky = [];
    for (let k = 0; k < 32; k += 1) spiky.push(at(k * 400, [k % 4]));
    spiky.push(at(4000 + 100, [0, 1, 2, 3]), at(4000 + 200, [0, 1, 2, 3]), at(4000 + 300, [0, 1, 2, 3]));
    assert.ok(findIssues(spiky, slots).some((x) => x.kind === "spike" && x.n >= 12));
    const uneven = Array.from({ length: 40 }, (_, k) => at(k * 200, [k % 3 === 0 ? 3 : k % 2]));
    const col = findIssues(uneven, slots).find((x) => x.kind === "columns");
    assert.ok(col && col.n > 0, JSON.stringify(col));
});

test("row stats: sizes, balance, columns, jacks and peak density", () => {
    const rows = [at(0, [0]), at(100, [0, 1]), at(200, [0]), at(300, [2, 3], "Jack"), at(400, [2], "Jack"), at(500, [2], "Jack")];
    rows[2].forced = true;
    const s = rowStats(rows, slots);
    assert.equal(s.notes, 8);
    assert.equal(s.rows, 6);
    assert.deepEqual(s.sizeShares, [4 / 6, 2 / 6, 0, 0]);
    assert.equal(s.leftShare, 4 / 8);
    assert.deepEqual(s.colShares, [3 / 8, 1 / 8, 3 / 8, 1 / 8]);
    assert.deepEqual(s.maxJack, { all: 3, streamy: 3 });
    assert.equal(s.peakNps, 8);
    assert.equal(s.forced, 1);
    const jackOnly = rowStats([at(0, [0]), at(100, [1]), at(300, [2], "Jack"), at(400, [2], "Jack"), at(500, [2], "Jack"), at(600, [2], "Jack")], slots);
    assert.deepEqual(jackOnly.maxJack, { all: 4, streamy: 1 });
});

test("a longjack phrase next to a stream is not judged by the stream's limits; the stream still is", () => {
    // a 1234 stream, then col 0 held for 12 rows inside a jack phrase, then the stream again
    const roll = (from, n) => Array.from({ length: n }, (_, k) => ({ t: (from + k) * 100, cols: [[1, 2, 3, 0][k % 4]], family: "Stream" }));
    const held = (from, n, flavour) => Array.from({ length: n }, (_, k) => ({
        t: (from + k) * 100, cols: k % 2 ? [0, 2] : [0], family: "Jack", ...(flavour ? { flavour } : {}),
    }));
    const map = (flavour) => [...roll(0, 32), ...held(32, 12, flavour), ...roll(44, 40)];
    const bad = (rows) => findIssues(rows, slots).filter((x) => x.kind === "jack" || x.kind === "anchor" || x.kind === "hand");
    // the stream's last row (col 0) starts a run into the phrase, and windows over it see col 0 in most rows
    assert.ok(bad(map(null)).length > 0, "family only: as before");
    assert.deepEqual(bad(map("Longjacks")), []);
    // a stream anchor well away from the phrase is still found
    const anchored = [...map("Longjacks"), ...Array.from({ length: 24 }, (_, k) => ({ t: (84 + k) * 100, cols: [k % 3 ? 1 : (k % 2 ? 2 : 3)], family: "Stream" }))];
    assert.ok(findIssues(anchored, slots).some((x) => x.kind === "anchor" && x.col === 1 && x.t >= 4400), JSON.stringify(bad(anchored)));
});
