// Our flavour detector (src/gen/flavourMetrics.js): each flavour's hand-written example is found as that flavour
// (and ranks first or second among all 22), a long gap breaks a motif, the planned-flavour score, the finder-named
// flavours agree with the LeoBlack finder on the same rows, and the analysis's own list leaves the newer ones out.
import test from "node:test";
import assert from "node:assert/strict";
import { flavourMarks, flavourShares, flavourCoverage, plannedFlavourScore, detectedFlavours } from "../../src/gen/flavourMetrics.js";
import { FLAVOUR_IDS, FINDER_NAME, FLAVOUR_FAMILY, ANALYSIS_FLAVOUR_IDS } from "../../src/gen/flavours.js";
import { analyzePatternFromText } from "../../src/core/leoblack.js";
import { patternShares } from "../../src/core/patterns.js";
import { toOsu } from "../../src/gen/writer.js";

// "1 2 [34]" → masks (columns 1–4 as players count them)
const masks = (s) => s.trim().split(/\s+/).map((tok) => tok.replace(/[[\]]/g, "").split("").reduce((x, c) => x | (1 << (Number(c) - 1)), 0));
const rowsOf = (s, { reps = 8, stepMs = 88, from = 1000 } = {}) => {
    const seq = Array.from({ length: reps }, () => masks(s)).flat();
    return seq.map((mask, k) => ({ t: from + k * stepMs, mask, cols: [0, 1, 2, 3].filter((c) => mask & (1 << c)) }));
};

export const EXAMPLES = {
    Rolls: "1 2 3 4 2 1 4 3 2 1 3 4",
    Trills: "1 2 1 2 3 2 3 2 4 1 4 1 3 1 3 1 2 4 2 4 3 4 3 4",
    Minitrills: "1 2 1 3 4 3 2 4 2 1 3 1 4 2 4 3",
    RunningMan: "1 2 1 3 1 4 1 3 1 2 1 4",
    Jumptrill: "[12] [34]",
    SplitTrill: "[13] [24] [13] [24] [13] [24] 1 [23] [14] [23] [14] [23] [14] 3",
    Anchor: "[12] 3 [14] 2 [13] 4 [12] 3 1 [24] [13] 2",
    Dumpstream: "[12] 3 4 [23] 1 [34] 2 1",
    ChordTrills: "[123] 4 [123] 4 [123] 4 [12] 3 [124] 3 [124] 3 [124] 3 [34] 1 [234] 1 [234] 1 [234] 1",
    DenseHandstream: "[123] 4 1 [234] 1 4 [123] 4 2 [134] 2 1",
    JumpyHandstream: "[123] 4 [12] 3 [124] 3 [34] 1 [234] 1 [23] 4",
    Handjack: "[123] [234] [134] [124]",
    Jumpjack: "[23] [23] [14] [14] [12] [12] [34] [34]",
    Quadhand: "[1234] [123] [234] [134] [1234] [124] [123] [234]",
    JumpQuad: "[12] [1234] [34] [1234] [23] [1234] [14] [1234] [13] [13] [1234] [1234] [24] [24] [1234] [1234]",
    Quadstream: "[23] [1234] 1 3 [24] [1234] 2 4",
    Minijacks: "[12] [12] 3 4 [23] [23] 1 4 [34] [34] 1 2",
    Longjacks: "[12] [12] [12] [13] [12] [14] [12] [12] 3 [34] [34] [24] [34] [14] [34] [34] 2",
    Gluts: "[12] [12] [23] [34] [34] [14] [12] [12]",
    Speedjacks: "1 1 1 2 2 3 3 3 4 4",
    Coordination: "1 3 2 4 1 3 2 3 1 4 2 4 1 3 2 3",
    JackyStream: "1 2 2 3 4 1 3 2 4 4 1 2 3 1 1 4",
};

test("every flavour has an example, and the example is found as that flavour (first or second of all 22)", () => {
    assert.deepEqual(Object.keys(EXAMPLES).sort(), [...FLAVOUR_IDS].sort());
    for (const [id, seq] of Object.entries(EXAMPLES)) {
        const shares = flavourShares(rowsOf(seq));
        const rank = shares.findIndex((x) => x.id === id);
        assert.ok(rank >= 0 && rank < 2, `${id}: ${shares.slice(0, 3).map((x) => `${x.id} ${x.share.toFixed(2)}`).join(", ")}`);
        assert.ok(shares[rank].share >= 0.5, `${id} covers ${shares[rank].share}`);
    }
});

test("a plain random stream is none of the motif-heavy flavours", () => {
    let s = 5;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const rows = [];
    let prev = 0;
    for (let k = 0; k < 400; k += 1) {
        let mask;
        do mask = 1 << Math.floor(rand() * 4); while (mask === prev);
        prev = mask;
        rows.push({ t: 1000 + k * 90, mask });
    }
    const shares = Object.fromEntries(flavourShares(rows).map((x) => [x.id, x.share]));
    for (const id of ["Jumptrill", "SplitTrill", "Quadhand", "JumpQuad", "Handjack", "Longjacks", "Speedjacks", "JackyStream", "Gluts"]) assert.equal(shares[id], 0, id);
});

test("2/4 chordjacks: jumps and quads in turn with a jack on every row; the other chordjacks are not", () => {
    const share = (seq) => flavourShares(rowsOf(seq)).find((x) => x.id === "JumpQuad").share;
    assert.equal(share("[12] [1234] [34] [1234]"), 1);
    assert.equal(share("[12] [12] [1234] [1234] [34] [34] [1234] [1234]"), 1, "doubled rows");
    assert.equal(share("[13] [1234] [13] [1234]"), 1, "the same jump each time is still one");
    // a jump that does not keep two columns of the one before, a quadjack, hands, a jumpjack, a quadstream: none
    for (const seq of ["[12] [34] [12] [1234]", "[1234] [1234] [1234] [12]", "[123] [1234] [234] [1234]", EXAMPLES.Jumpjack,
        EXAMPLES.Quadhand, EXAMPLES.Handjack, EXAMPLES.Quadstream, EXAMPLES.Gluts, EXAMPLES.Jumptrill]) {
        assert.equal(share(seq), 0, seq);
    }
});

test("a long rest breaks a motif: two halves of a sweep are no roll", () => {
    const whole = [{ t: 0, mask: 1 }, { t: 90, mask: 2 }, { t: 180, mask: 4 }, { t: 270, mask: 8 }];
    assert.equal(flavourMarks(whole).marks.Rolls.reduce((a, b) => a + b, 0), 4);
    const broken = whole.map((r, k) => ({ ...r, t: r.t + (k >= 2 ? 2000 : 0) }));
    assert.equal(flavourMarks(broken).marks.Rolls.reduce((a, b) => a + b, 0), 0);
});

test("the planned-flavour score: the share of rows planned as a flavour that sit in its motif", () => {
    assert.equal(plannedFlavourScore(rowsOf("1 2 3 4", { reps: 2 })), null, "no planned row: no score");
    const good = rowsOf(EXAMPLES.Jumptrill).map((r) => ({ ...r, flavour: "Jumptrill" }));
    assert.equal(plannedFlavourScore(good).score, 1);
    const half = [...good.slice(0, 8), ...rowsOf("1 3 2 4", { reps: 2, from: 1000 + 8 * 88 }).map((r) => ({ ...r, flavour: "Jumptrill" }))];
    const scored = plannedFlavourScore(half);
    assert.ok(scored.score > 0.4 && scored.score < 0.6, String(scored.score));
    assert.deepEqual(Object.keys(scored.byFlavour), ["Jumptrill"]);
    assert.equal(scored.rows, 16);
});

test("detectedFlavours: the largest few, none at 0, shares to three decimals", () => {
    const found = detectedFlavours(rowsOf(EXAMPLES.SplitTrill));
    assert.ok(found.length >= 1 && found.length <= 5);
    assert.equal(found[0].id, "SplitTrill");
    assert.ok(found.every((f) => f.share > 0 && Math.round(f.share * 1000) === f.share * 1000));
});

test("detectedFlavours over the analysis's list: the flavours of 0.10.3 only, the rest exactly as over all", () => {
    const mixed = rowsOf(`${EXAMPLES.JumpQuad} ${EXAMPLES.Gluts} ${EXAMPLES.Quadhand}`, { reps: 3 });
    assert.equal(detectedFlavours(mixed)[0].id, "JumpQuad");
    const analysed = detectedFlavours(mixed, 5, ANALYSIS_FLAVOUR_IDS);
    assert.ok(analysed.every((f) => ANALYSIS_FLAVOUR_IDS.includes(f.id)));
    assert.deepEqual(analysed, detectedFlavours(mixed, 99).filter((f) => f.id !== "JumpQuad").slice(0, 5));
    const marks = flavourMarks(mixed, ANALYSIS_FLAVOUR_IDS).marks;
    assert.deepEqual(Object.keys(marks), [...ANALYSIS_FLAVOUR_IDS]);
    for (const id of ANALYSIS_FLAVOUR_IDS) assert.deepEqual(marks[id], flavourMarks(mixed).marks[id], id);
});

test("the finder-named flavours: the LeoBlack finder names each example by that flavour too", () => {
    for (const [id, name] of Object.entries(FINDER_NAME)) {
        const rows = rowsOf(EXAMPLES[id], { reps: 16 });
        const osu = toOsu({ rows, timingPoints: [{ time: 1000, beatLength: 352, meter: 4 }], title: "t", artist: "a", version: "v", audioFilename: "a.mp3" });
        const top = patternShares(analyzePatternFromText(osu, 1).report).slice(0, 2).map((p) => p.name);
        assert.ok(top.includes(name), `${id} (${FLAVOUR_FAMILY[id]}): the finder says ${top.join(", ")}`);
    }
});

test("flavourCoverage: the shares as a lookup over every flavour (or the ones asked for)", () => {
    const cover = flavourCoverage(rowsOf(EXAMPLES.Gluts));
    assert.deepEqual(Object.keys(cover).sort(), [...FLAVOUR_IDS].sort());
    assert.equal(cover.Gluts, flavourShares(rowsOf(EXAMPLES.Gluts)).find((x) => x.id === "Gluts").share);
    assert.deepEqual(Object.keys(flavourCoverage(rowsOf(EXAMPLES.Gluts), ["Gluts", "Rolls"])), ["Gluts", "Rolls"]);
    assert.deepEqual(flavourCoverage([]), {});
});
