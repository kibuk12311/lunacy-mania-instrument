import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadModel, evaluateSpec } from "../src/core/model.js";
import { setLang } from "../src/i18n/i18n.js";

const parity = JSON.parse(await readFile(new URL("./fixtures/model-parity.json", import.meta.url), "utf8"));

test("JS predictions match Python for the shipped model", async () => {
    const model = await loadModel();
    for (const { vector, prediction } of parity) {
        const { numeric } = model.predict(vector);
        assert.ok(Math.abs(numeric - prediction) < 1e-3, `${numeric} vs ${prediction}`);
    }
});

test("all-null vector gives low confidence and no crash", async () => {
    const model = await loadModel();
    const empty = Object.fromEntries(model.featureNames.map((n) => [n, null]));
    const r = model.predict(empty);
    assert.equal(r.numeric, null);
    assert.equal(r.confidence, "низкая");
});

test("ridge and gbm specs evaluate like the Python reference", () => {
    const ridge = { type: "ridge", impute: [1, 2], mean: [0, 1], scale: [2, 1], coef: [0.5, -1], intercept: 3 };
    assert.equal(evaluateSpec(ridge, [4, null]), 3 + (4 / 2) * 0.5 + ((2 - 1) / 1) * -1);
    const gbm = {
        type: "gbm", baseline: 10,
        trees: [{ feature: [0, 0, 0], threshold: [5, 0, 0], missingLeft: [1, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -1, 2] }],
    };
    assert.equal(evaluateSpec(gbm, [3]), 9);
    assert.equal(evaluateSpec(gbm, [7]), 12);
    assert.equal(evaluateSpec(gbm, [null]), 9);
});

test("confidence follows half width", async () => {
    const model = await loadModel();
    assert.equal(model.confidenceFor(0.3), "высокая");
    assert.equal(model.confidenceFor(0.5), "средняя");
    assert.equal(model.confidenceFor(0.9), "низкая");
});

test("confidence carries a stable level; in English the word is English", async () => {
    const model = await loadModel();
    assert.deepEqual([0.3, 0.5, 0.9].map(model.confidenceLevelFor), ["high", "medium", "low"]);
    const empty = Object.fromEntries(model.featureNames.map((n) => [n, null]));
    setLang("en");
    try {
        assert.deepEqual([0.3, 0.5, 0.9].map(model.confidenceFor), ["high", "medium", "low"]);
        const r = model.predict(empty);
        assert.equal(r.confidence, "low");
        assert.equal(r.confidenceLevel, "low");
        const { vector } = parity[0];
        const p = model.predict(vector);
        assert.equal(p.confidence, p.confidenceLevel);
    } finally {
        setLang("ru");
    }
    const p = model.predict(parity[0].vector);
    assert.equal(p.confidence, { high: "высокая", medium: "средняя", low: "низкая" }[p.confidenceLevel]);
});
