import test from "node:test";
import assert from "node:assert/strict";
import { makeChart } from "./fixtures/makeChart.js";
import { analyzeChart } from "../src/core/analyze.js";
import { numericToLabel } from "../src/core/labels.js";
import { setLang } from "../src/i18n/i18n.js";

test("rice chart gives a full result", async () => {
    const r = await analyzeChart(makeChart({ kind: "jack", bpm: 170, seconds: 120 }), 1);
    assert.equal(r.kind, "ok");
    assert.equal(r.label, numericToLabel(r.numeric).text);
    assert.ok(r.top3.length >= 1);
    assert.ok(["высокая", "средняя", "низкая"].includes(r.confidence));
    assert.ok(Math.abs(r.bpm - 170) < 1);
    assert.ok(Math.abs(r.durationSec - 120) < 1);
    assert.equal(r.rate, 1);
    assert.equal(typeof r.tech, "boolean");
});

test("LN chart is reported as not rice", async () => {
    const r = await analyzeChart(makeChart({ kind: "ln", lnShare: 0.6 }), 1);
    assert.deepEqual(r, { kind: "not-rice", reason: "ln", keys: 4 });
});

test("7K chart is reported as wrong key count", async () => {
    const r = await analyzeChart(makeChart({ kind: "stream", keys: 7 }), 1);
    assert.deepEqual(r, { kind: "not-rice", reason: "keys", keys: 7 });
});

test("short chart is too short", async () => {
    const r = await analyzeChart(makeChart({ kind: "stream", seconds: 2 }), 1);
    assert.deepEqual(r, { kind: "too-short" });
});

test("garbage input is an error, not a throw", async () => {
    const r = await analyzeChart("not an osu file", 1);
    assert.equal(r.kind, "not-rice");
});

test("3000-note chart analyses in under 2 seconds", async () => {
    const text = makeChart({ kind: "jumpstream", bpm: 200, seconds: 200 });
    const t0 = performance.now();
    const r = await analyzeChart(text, 1);
    const ms = performance.now() - t0;
    console.log(`analyzeChart: ${ms.toFixed(0)} ms`);
    assert.equal(r.kind, "ok");
    assert.ok(ms < 2000);
});

test("osu!standard map with CS 4 is not treated as 4K mania", async () => {
    const text = makeChart({ kind: "stream", seconds: 60 }).replace("Mode: 3", "Mode: 0");
    assert.deepEqual(await analyzeChart(text, 1), { kind: "not-rice", reason: "mode", keys: 4 });
});

test("result carries every dan calculator, Sunny star and MSD", async () => {
    const r = await analyzeChart(makeChart({ kind: "jumpstream", bpm: 200, seconds: 120 }), 1);
    assert.deepEqual(Object.keys(r.calcs).sort(), ["azusa", "companella", "daniel", "mixed", "roxy"]);
    for (const v of Object.values(r.calcs)) assert.ok(v === null || (Number.isFinite(v) && Math.round(v * 10) / 10 === v));
    assert.ok(Number.isFinite(r.calcs.mixed));
    assert.ok(Number.isFinite(r.sunny) && r.sunny > 0);
    assert.equal(Math.round(r.sunny * 100) / 100, r.sunny);
    assert.deepEqual(Object.keys(r.msd), ["overall", "stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"]);
    assert.ok(Number.isFinite(r.msd.overall) && r.msd.overall > 0);
    assert.equal(Math.round(r.msd.overall * 100) / 100, r.msd.overall);
});

test("faster rate raises the calculators, the star and the MSD", async () => {
    const text = makeChart({ kind: "stream", bpm: 180, seconds: 120 });
    const [a, b] = [await analyzeChart(text, 1), await analyzeChart(text, 1.3)];
    assert.ok(b.calcs.mixed > a.calcs.mixed);
    assert.ok(b.sunny > a.sunny);
    assert.ok(b.msd.overall > a.msd.overall);
});

test("shown number and label agree (one decimal)", async () => {
    const r = await analyzeChart(makeChart({ kind: "jumpstream", bpm: 210, seconds: 120 }), 1);
    assert.equal(Math.round(r.numeric * 10) / 10, r.numeric);
    assert.equal(r.label, numericToLabel(r.numeric).text);
});

test("in English the result's confidence word is English, its level the same", async () => {
    const text = makeChart({ kind: "jack", bpm: 170, seconds: 120 });
    const ru = await analyzeChart(text, 1);
    setLang("en");
    try {
        const en = await analyzeChart(text, 1);
        assert.equal(en.kind, "ok");
        assert.equal(en.confidenceLevel, ru.confidenceLevel);
        assert.ok(["high", "medium", "low"].includes(en.confidence));
        assert.equal(en.confidence, en.confidenceLevel);
        assert.equal(en.label, numericToLabel(en.numeric).text);
    } finally {
        setLang("ru");
    }
});
