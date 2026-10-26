import test from "node:test";
import assert from "node:assert/strict";
import { curveRows, curveWarnings, curveSvg, formatTime } from "../src/rate/marathonCurve.js";
import { buildMarathon, cutRange } from "../src/rate/marathon.js";
import { makeChart } from "./fixtures/makeChart.js";

test("rows: each map as wide as its cut at its rate, the pauses between them", () => {
    const { rows, totalMs } = curveRows([
        { cutMs: 60000, rate: 1, numeric: 12.6, label: "Gamma low" },
        { cutMs: 60000, rate: 1.5, numeric: 12.8, label: "Gamma low/mid" },
        { cutMs: 30000, rate: 1, numeric: null, label: "" },
    ], 10000);
    assert.deepEqual(rows, [
        { i: 1, x0: 0, x1: 60000, numeric: 12.6, label: "Gamma low" },
        { i: 2, x0: 70000, x1: 110000, numeric: 12.8, label: "Gamma low/mid" },
        { i: 3, x0: 120000, x1: 150000, numeric: null, label: "" },
    ]);
    assert.equal(totalMs, 150000);
});

test("rows end where buildMarathon's chart ends, for any rates and pause", () => {
    const charts = [makeChart({ kind: "stream", bpm: 150, seconds: 20 }), makeChart({ kind: "jumpstream", bpm: 170, seconds: 31 }),
        makeChart({ kind: "jack", bpm: 140, seconds: 13 })];
    const rates = [1, 1.15, 0.85];
    const built = buildMarathon(charts.map((osuText, i) => ({ osuText, rate: rates[i] })), { gapMs: 7000 });
    const { rows, totalMs } = curveRows(charts.map((text, i) => ({ cutMs: cutRange(text).cutMs, rate: rates[i] })), 7000);
    assert.equal(totalMs, built.totalMs);
    assert.deepEqual(rows.map((r) => [r.x0, r.x1]), built.segments.map((s) => [s.outStartMs, s.outEndMs]));
});

test("a map whose cut is not known yet has no width; nothing at all is an empty curve", () => {
    const { rows, totalMs } = curveRows([{ rate: 1, numeric: 13 }, { cutMs: 1000, rate: 2, numeric: "x" }], 500);
    assert.deepEqual(rows.map((r) => [r.x0, r.x1, r.numeric]), [[0, 0, 13], [500, 1000, null]]);
    assert.equal(totalMs, 1000);
    assert.deepEqual(curveRows([], 10000), { rows: [], totalMs: 0 });
    assert.equal(curveSvg([], { totalMs: 0 }), "");
});

test("warnings: a map easier than the one before, and a jump of more than 0.5", () => {
    const rows = (dans) => curveRows(dans.map((numeric) => ({ cutMs: 1000, rate: 1, numeric })), 0).rows;
    assert.deepEqual(curveWarnings(rows([12.5, 12.7, 12.9, 13])), []);
    assert.deepEqual(curveWarnings(rows([12.5, 12.3, 12.9])), [{ kind: "drop", i: 2, delta: -0.2 }, { kind: "jump", a: 2, b: 3, delta: 0.6 }]);
    // noise under 0.05 is no drop; exactly 0.5 is no jump
    assert.deepEqual(curveWarnings(rows([13, 12.97, 13.47])), []);
    assert.deepEqual(curveWarnings(rows([13, 12.95])), [{ kind: "drop", i: 2, delta: -0.05 }]);
    // a map with no dan yet is not compared
    assert.deepEqual(curveWarnings(rows([13, null, 11])), []);
});

test("the svg: one point per known map, the plan dashed, labels escaped", () => {
    const { rows, totalMs } = curveRows([
        { cutMs: 60000, rate: 1, numeric: 12.6, label: "Gamma <b>low</b> & co" },
        { cutMs: 60000, rate: 1, numeric: 13.0, label: "Gamma mid" },
        { cutMs: 60000, rate: 1, numeric: null, label: "" },
    ], 10000);
    const svg = curveSvg(rows, { totalMs, width: 300, height: 100 });
    assert.match(svg, /^<svg [^>]*viewBox="0 0 300 100"/);
    assert.equal(svg.match(/<circle /g).length, 2);
    assert.ok(!svg.includes("<b>"));
    assert.ok(svg.includes("Gamma &lt;b&gt;low&lt;/b&gt; &amp; co"));
    assert.ok(svg.includes(">12.6<") && svg.includes(">13.0<"));
    assert.ok(svg.includes(">0:00<") && svg.includes(`>${formatTime(totalMs)}<`));
    assert.ok(!svg.includes("stroke-dasharray"));

    const planned = curveSvg(rows, { totalMs, plan: [12.55, 12.7, 12.85, 13], planLabel: "plan <x>" });
    assert.ok(planned.includes("stroke-dasharray"));
    assert.ok(planned.includes("plan &lt;x&gt;"));
    // with labels on (the background) the points carry the dan names
    assert.ok(curveSvg(rows, { totalMs, showLabels: true }).includes(">Gamma mid<"));
});

test("time reads m:ss", () => {
    assert.deepEqual([0, 59400, 59600, 61000, 3600000].map(formatTime), ["0:00", "0:59", "1:00", "1:01", "60:00"]);
});
