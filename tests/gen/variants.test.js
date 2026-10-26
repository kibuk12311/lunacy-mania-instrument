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
