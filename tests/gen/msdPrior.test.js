import test from "node:test";
import assert from "node:assert/strict";
import { msdPriorOf, msdFit, msdVector, MSD8 } from "../../src/gen/msdPrior.js";

// A prior shaped like tools/train_mapper.py msd_prior(): bins 0..20 (floor of the dan), FAMILIES + "unknown",
// table[bin][family] = the median MSD8 vector or null.
const FAMS = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech", "unknown"];
const vec = (base, fam) => MSD8.map((_, k) => base + k + fam * 0.1);
const prior = {
    bins: Array.from({ length: 21 }, (_, b) => b),
    families: FAMS,
    msd: MSD8,
    table: Array.from({ length: 21 }, (_, b) => (b === 3 || b === 20 ? FAMS.map(() => null) : FAMS.map((_, f) => (b === 5 && f === 1 ? null : vec(b * 2, f))))),
};
const model = { kind: "xgb-v3", msdPrior: prior };

test("a model without msdPrior gives no target, and msdFit is then null", () => {
    assert.equal(msdPriorOf({ kind: "xgb-v1" }, 7, ["Stream"]), null);
    assert.equal(msdPriorOf(null, 7, ["Stream"]), null);
    assert.equal(msdFit(Float32Array.from(vec(1, 0)), null), null);
    assert.equal(msdFit(null, Float32Array.from(vec(1, 0))), null);
});

test("the dan picks its floor bin (clamped to the bins) and the family its column", () => {
    const close = (a, b) => a.forEach((x, k) => assert.ok(Math.abs(x - b[k]) < 1e-5, `${k}: ${x} vs ${b[k]}`));
    close(msdPriorOf(model, 7.5, ["Stream"]), vec(14, 0));
    close(msdPriorOf(model, 7.99, [{ name: "Chordjack", share: 1 }]), vec(14, 3));
    close(msdPriorOf(model, -2, ["Jack"]), vec(0, 4));
    close(msdPriorOf(model, 25, ["Stream"]), vec(38, 0)); // bin 20 is empty: the nearest bin with data (19)
    assert.ok(msdPriorOf(model, 7, ["Stream"]) instanceof Float32Array);
    assert.equal(msdPriorOf(model, 7, ["Stream"]).length, 8);
});

test("several families mix by their shares; an unknown or empty family falls back to the unknown column", () => {
    const got = msdPriorOf(model, 7.2, [{ name: "Stream", share: 0.75 }, { name: "Jack", share: 0.25 }]);
    const want = MSD8.map((_, k) => 0.75 * vec(14, 0)[k] + 0.25 * vec(14, 4)[k]);
    got.forEach((x, k) => assert.ok(Math.abs(x - want[k]) < 1e-4));
    const odd = msdPriorOf(model, 7.2, ["Nonsense"]);
    odd.forEach((x, k) => assert.ok(Math.abs(x - vec(14, 6)[k]) < 1e-4));
    // bin 5's Jumpstream cell is empty: the other family carries the mix alone
    const thin = msdPriorOf(model, 5.5, [{ name: "Jumpstream", share: 0.5 }, { name: "Stream", share: 0.5 }]);
    thin.forEach((x, k) => assert.ok(Math.abs(x - vec(10, 0)[k]) < 1e-4));
    // a bin with no data at all takes the nearest one, lower first on a tie
    const empty = msdPriorOf(model, 3.4, ["Stream"]);
    empty.forEach((x, k) => assert.ok(Math.abs(x - vec(4, 0)[k]) < 1e-4));
});

test("msdFit = −‖msd − target‖₂ / 3 over the skillsets both have", () => {
    const target = Float32Array.from([10, 10, 10, 10, 10, 10, 10, 10]);
    assert.equal(msdFit(Float32Array.from(target), target), 0);
    const off = Float32Array.from([13, 14, 10, 10, 10, 10, 10, 10]);
    assert.ok(Math.abs(msdFit(off, target) - -5 / 3) < 1e-9);
    const missing = Float32Array.from([13, NaN, 10, 10, 10, 10, 10, 10]);
    assert.ok(Math.abs(msdFit(missing, target) - -1) < 1e-9);
    assert.equal(msdFit(Float32Array.from(new Array(8).fill(NaN)), target), null);
});

test("msdVector reads analyzeChart's msd object in MSD8 order", () => {
    const msd = { overall: 20, stream: 21, jumpstream: 22, handstream: 23, stamina: 24, jackspeed: 25, chordjack: 26, technical: 27 };
    assert.deepEqual(Array.from(msdVector(msd)), [20, 21, 22, 23, 24, 25, 26, 27]);
    assert.deepEqual(Array.from(msdVector({ ...msd, stream: null })).map((x) => (Number.isNaN(x) ? "NaN" : x)), [20, "NaN", 22, 23, 24, 25, 26, 27]);
    assert.equal(msdVector(null), null);
    assert.deepEqual(Array.from(msdVector([1, 2, 3, 4, 5, 6, 7, 8])), [1, 2, 3, 4, 5, 6, 7, 8]);
});
