import test from "node:test";
import assert from "node:assert/strict";
import { aucOf, spearman, kindAucs } from "../../tools/eval-critic.mjs";

test("AUC: perfect, reversed, chance and ties", () => {
    assert.equal(aucOf([3, 4], [1, 2]), 1);
    assert.equal(aucOf([1, 2], [3, 4]), 0);
    assert.equal(aucOf([1, 2], [1, 2]), 0.5);
    assert.equal(aucOf([2], [2, 2]), 0.5);
    assert.equal(aucOf([3, 1], [2]), 0.5);
    assert.equal(aucOf([], [1]), null);
});

test("Spearman and per-kind AUCs", () => {
    assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 30, 20, 40]) - 0.8) < 1e-12);
    const rows = [
        { kind: "human", s: 0.9 }, { kind: "human", s: 0.8 },
        { kind: "gen", s: 0.1 }, { kind: "gen", s: 0.85 },
        { kind: "perturb", sub: "shiftRows", s: 0.2 }, { kind: "perturb", sub: "remapColumns", s: 0.95 },
    ];
    const a = kindAucs(rows, (r) => r.s);
    assert.equal(a.humans, 2);
    assert.equal(a.gen, 0.75);
    assert.equal(a["perturb:shiftRows"], 1);
    assert.equal(a["perturb:remapColumns"], 0);
    assert.equal(a.perturb, 0.5);
});
