import test from "node:test";
import assert from "node:assert/strict";
import { rankVariants } from "../../src/gen/variants.js";

const v = (id, numeric, patternScore, issues = 0) => ({ id, result: { kind: "ok", numeric }, patternScore, issues: Array(issues).fill({}) });

test("in range first, then pattern score to 0.05, then fewer issues, then nearer the middle", () => {
    const range = { lo: 12.5, hi: 13.5 };
    const ranked = rankVariants([
        v("out", 14, 1),
        v("worse pattern", 13, 0.6),
        v("more issues", 13.4, 0.81, 3),
        v("best", 13.3, 0.82, 1),
        v("nearer", 13.05, 0.8, 1),
    ], range);
    assert.deepEqual(ranked.map((a) => a.id), ["nearer", "best", "more issues", "worse pattern", "out"]);
});

test("without a range the answers' own ranges count; the list is not changed", () => {
    const list = [{ ...v("a", 9, 0.9), range: { lo: 3, hi: 4 } }, { ...v("b", 3.5, 0.2), range: { lo: 3, hi: 4 } }];
    assert.deepEqual(rankVariants(list).map((a) => a.id), ["b", "a"]);
    assert.deepEqual(list.map((a) => a.id), ["a", "b"]);
});

test("within one pattern-score bucket the higher critic score (to 0.25) comes first, before fewer issues", () => {
    const range = { lo: 12.5, hi: 13.5 };
    const c = (score) => ({ critic: { kind: "heuristic", score } });
    const ranked = rankVariants([
        { ...v("low critic, no issues", 13, 0.8, 0), ...c(-1.2) },
        { ...v("high critic, issues", 13, 0.81, 4), ...c(0.4) },
        { ...v("better pattern", 13, 0.9, 6), ...c(-5) },
        { ...v("near tie", 13.2, 0.8, 1), ...c(0.45) },
    ], range);
    assert.deepEqual(ranked.map((a) => a.id), ["better pattern", "near tie", "high critic, issues", "low critic, no issues"]);
    // the critic counts only when both cards have one: a card without it keeps the v3 order (issues)
    const mixed = rankVariants([{ ...v("no critic, 2 issues", 13, 0.8, 2) }, { ...v("critic, 3 issues", 13, 0.8, 3), ...c(3) }], range);
    assert.deepEqual(mixed.map((a) => a.id), ["no critic, 2 issues", "critic, 3 issues"]);
    // in range still beats any critic score
    const out = rankVariants([{ ...v("out", 14, 0.8), ...c(9) }, { ...v("in", 13, 0.8), ...c(-9) }], range);
    assert.deepEqual(out.map((a) => a.id), ["in", "out"]);
});
