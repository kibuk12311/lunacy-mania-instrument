import test from "node:test";
import assert from "node:assert/strict";
import { validRate, validDiff, positiveId, danOf, MIN_DAN, MAX_DAN } from "../app/validate.js";

test("validRate: 0.5 to 2, ends included", () => {
    for (const r of [0.5, 1, 1.45, 2]) assert.equal(validRate(r), true, String(r));
    for (const r of [0.49, 2.01, NaN, Infinity, "1.2", null, undefined]) assert.equal(validRate(r), false, String(r));
});

test("validDiff: null (keep the map's own) or 0 to 10", () => {
    for (const v of [null, 0, 8.5, 10]) assert.equal(validDiff(v), true, String(v));
    for (const v of [10.1, -0.1, NaN, undefined, "8"]) assert.equal(validDiff(v), false, String(v));
});

test("positiveId: positive safe integers, as a number or a string of digits", () => {
    assert.equal(positiveId("12"), 12);
    assert.equal(positiveId(12), 12);
    assert.equal(positiveId("1e3"), null);
    assert.equal(positiveId(-1), null);
    assert.equal(positiveId(0), null);
    assert.equal(positiveId(2 ** 60), null);
    assert.equal(positiveId(1.5), null);
    assert.equal(positiveId(" 12"), null);
    assert.equal(positiveId("1234567890123"), null);
    assert.equal(positiveId(null), null);
});

test("danOf: a finite dan above 0 and below 25", () => {
    assert.equal(danOf(13.26), 13.26);
    for (const v of [0, -1, 25, NaN, "13", null]) assert.equal(danOf(v), null, String(v));
});

test("the manual dan range is 1 dan low … Kappa high", () => {
    assert.equal(MIN_DAN, 0.6);
    assert.equal(MAX_DAN, 20.4);
});
