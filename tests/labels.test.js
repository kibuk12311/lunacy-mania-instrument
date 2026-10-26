import test from "node:test";
import assert from "node:assert/strict";
import { numericToLabel, labelKey, confidenceWord, confidenceLevelFor } from "../src/core/labels.js";
import { setLang } from "../src/i18n/i18n.js";

test("confidence level from the half width: ≤0.35 high, ≤0.7 medium, else low", () => {
    assert.deepEqual([0.2, 0.35, 0.36, 0.7, 0.71, 2].map(confidenceLevelFor), ["high", "high", "medium", "medium", "low", "low"]);
});

const CASES = [
    [12.8, "Gamma low/mid"],
    [13, "Gamma mid"],
    [13.1, "Gamma mid"],
    [13.2, "Gamma mid/high"],
    [13.31, "Gamma high"],
    [12.7, "Gamma low"],
    [7.8, "8 low/mid"],
    [10.4, "10 high"],
    [10.6, "Alpha low"],
    [20.2, "Kappa mid/high"],
    [20.6, "выше Kappa"],
    [0.4, "ниже 1 дана"],
    [0.6, "1 low"],
];

for (const [value, text] of CASES) {
    test(`numericToLabel(${value}) is "${text}"`, () => {
        assert.equal(numericToLabel(value).text, text);
    });
}

test("numericToLabel exposes level and step", () => {
    assert.deepEqual(numericToLabel(12.8), { text: "Gamma low/mid", level: 13, step: "low/mid" });
});

test("numericToLabel(NaN) is a dash", () => {
    assert.deepEqual(numericToLabel(NaN), { text: "—", level: null, step: null });
});

test("in English the ends of the scale are worded in English; the rest stays the same", () => {
    setLang("en");
    try {
        assert.equal(numericToLabel(0.4).text, "below dan 1");
        assert.equal(numericToLabel(20.6).text, "above Kappa");
        assert.equal(numericToLabel(12.8).text, "Gamma low/mid");
        assert.deepEqual(numericToLabel(0.4), { text: "below dan 1", level: null, step: null });
        assert.deepEqual(["high", "medium", "low", undefined].map(confidenceWord), ["high", "medium", "low", "low"]);
    } finally {
        setLang("ru");
    }
    assert.deepEqual(["high", "medium", "low"].map(confidenceWord), ["высокая", "средняя", "низкая"]);
});

test("labelKey is the same in both languages, so labels compare across a language switch", () => {
    const keys = () => [0.4, 20.6, 12.8, NaN].map(labelKey);
    const ru = keys();
    setLang("en");
    try {
        assert.deepEqual(keys(), ru);
    } finally {
        setLang("ru");
    }
    assert.deepEqual(ru, ["below", "above", "Gamma low/mid", "none"]);
    assert.equal(labelKey(13.1), labelKey(12.95));
});
