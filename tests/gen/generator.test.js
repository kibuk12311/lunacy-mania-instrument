import test from "node:test";
import assert from "node:assert/strict";
import { buildSlots } from "../../src/gen/grid.js";
import { slotIntensity } from "../../src/gen/intensity.js";
import { assignPatterns } from "../../src/gen/assign.js";
import { nextRow, PATTERN_NAMES } from "../../src/gen/patterns.js";
import { buildChart } from "../../src/gen/build.js";
import { toOsu } from "../../src/gen/writer.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { chartInfo } from "../../src/core/features.js";

const hand = (c) => (c < 2 ? 0 : 1);

test("grid has 1/4 slots from the offset", () => {
    const slots = buildSlots({ bpm: 120, offsetMs: 500, endMs: 2000 });
    assert.deepEqual(slots.slice(0, 3).map((s) => s.t), [500, 625, 750]);
    assert.deepEqual(slots.slice(0, 5).map((s) => s.sub), [0, 1, 2, 3, 0]);
    assert.equal(slots.at(-1).t, 2000);
});

test("intensity: silence is a break unless stamina is maxed, burst sharpens peaks", () => {
    const strength = (i) => (i >= 16 && i < 32 ? 0 : 0.3 + 0.7 * ((i % 8) === 0));
    const n = 64;
    const raw = Float64Array.from({ length: n }, (_, i) => strength(i));
    const calm = slotIntensity(raw, { stamina: 0, burst: 0 });
    assert.equal(calm[20], 0);
    const tireless = slotIntensity(raw, { stamina: 1, burst: 0 });
    assert.ok(tireless[20] > 0.5);
    const spread = (v) => Math.max(...v.slice(40)) - Math.min(...v.slice(40));
    assert.ok(spread(slotIntensity(raw, { stamina: 0, burst: 1 })) > spread(calm));
});

test("assign by sections keeps shares and contiguous runs", () => {
    const a = assignPatterns(32 * 8 * 4, [{ name: "Chordjack", share: 0.7 }, { name: "Jumpstream", share: 0.3 }], "sections", mulberry32(1));
    const cj = a.filter((p) => p === "Chordjack").length / a.length;
    assert.ok(Math.abs(cj - 0.7) < 0.1, `cj ${cj}`);
    let switches = 0;
    for (let i = 1; i < a.length; i += 1) if (a[i] !== a[i - 1]) switches += 1;
    assert.ok(switches <= 32);
});

test("assign mixed changes pattern often", () => {
    const a = assignPatterns(512, [{ name: "Chordjack", share: 0.5 }, { name: "Jumpstream", share: 0.5 }], "mixed", mulberry32(2));
    let switches = 0;
    for (let i = 1; i < a.length; i += 1) if (a[i] !== a[i - 1]) switches += 1;
    assert.ok(switches > 40, `switches ${switches}`);
});

function run(pattern, n = 400, level = 0.6) {
    const rng = mulberry32(3);
    const rows = [];
    for (let i = 0; i < n; i += 1) rows.push(nextRow(pattern, rows, rng, level, i));
    return rows;
}

test("stream: single notes, no jacks", () => {
    const rows = run("Stream");
    assert.ok(rows.every((r) => r.length === 1));
    assert.ok(rows.every((r, i) => i === 0 || r[0] !== rows[i - 1][0]));
});

test("jumpstream: 2-note rows mixed with singles, no jacks", () => {
    const rows = run("Jumpstream");
    assert.ok(rows.filter((r) => r.length === 2).length > rows.length * 0.3);
    assert.ok(rows.every((r) => r.length <= 2));
    assert.ok(rows.every((r, i) => i === 0 || !r.some((c) => rows[i - 1].includes(c))));
});

test("handstream has 3-note rows and no jacks", () => {
    const rows = run("Handstream");
    assert.ok(rows.some((r) => r.length === 3));
    assert.ok(rows.every((r, i) => i === 0 || !r.some((c) => rows[i - 1].includes(c))));
});

test("chordjack: chords that repeat a column of the previous row", () => {
    const rows = run("Chordjack");
    assert.ok(rows.every((r) => r.length >= 2));
    const jacked = rows.filter((r, i) => i > 0 && r.some((c) => rows[i - 1].includes(c))).length;
    assert.ok(jacked > rows.length * 0.8);
});

test("jack repeats columns, mostly as two-column jacks", () => {
    const rows = run("Jack");
    const jacked = rows.filter((r, i) => i > 0 && r.some((c) => rows[i - 1].includes(c))).length;
    assert.ok(jacked > rows.length * 0.5, `jacked ${jacked}`);
    assert.ok(rows.filter((r) => r.length === 2).length > rows.length * 0.6);
});

test("rows are sorted unique columns 0..3 for every pattern", () => {
    for (const p of PATTERN_NAMES) {
        for (const r of run(p, 200, 1)) {
            assert.ok(r.length >= 1 && r.length <= 4);
            assert.deepEqual(r, [...new Set(r)].sort((a, b) => a - b));
            assert.ok(r.every((c) => c >= 0 && c <= 3));
        }
    }
});

test("density knob adds notes monotonically", () => {
    const slots = buildSlots({ bpm: 170, offsetMs: 0, endMs: 60000 });
    const intensity = new Float64Array(slots.length).fill(0.6);
    const assign = new Array(slots.length).fill("Jumpstream");
    const notes = (lambda) => buildChart({ slots, intensity, assign, lambda, seed: 5, bpm: 170 }).reduce((s, r) => s + r.cols.length, 0);
    assert.ok(notes(0.2) < notes(0.5));
    assert.ok(notes(0.5) < notes(0.9));
});

test("writer output parses as 4K mania", () => {
    const rows = [{ t: 1000, cols: [0, 2] }, { t: 1100, cols: [1] }, { t: 1200, cols: [3] }];
    const text = toOsu({ rows, bpm: 150, offsetMs: 1000, title: "Песня", version: "Gamma mid Chordjack", audioFilename: "audio.mp3" });
    const info = chartInfo(text, 1);
    assert.equal(info.mode, 3);
    assert.equal(info.keys, 4);
    assert.equal(info.noteCount, 4);
    assert.ok(text.includes("Title:Песня"));
    assert.ok(text.includes("Version:Gamma mid Chordjack"));
    assert.ok(text.includes("64,192,1000,1,0,0:0:0:0:"));
});

test("grid follows a map's own timing points, including BPM changes", async () => {
    const { buildSlotsFromTiming, parseRedTimingPoints } = await import("../../src/gen/grid.js");
    const text = "[TimingPoints]\r\n1000,500,4,1,0,100,1,0\r\n2500,-100,4,1,0,100,0,0\r\n3000,250,4,1,0,100,1,0\r\n\r\n[HitObjects]\r\n";
    const points = parseRedTimingPoints(text);
    assert.deepEqual(points, [{ time: 1000, beatLength: 500 }, { time: 3000, beatLength: 250 }]);
    const slots = buildSlotsFromTiming(points, 3600);
    assert.deepEqual(slots.slice(0, 2).map((s) => s.t), [1000, 1125]);
    const atChange = slots.findIndex((s) => s.t === 3000);
    assert.equal(slots[atChange].sub, 0);
    assert.equal(slots[atChange - 1].t, 2875);
    assert.equal(slots[atChange + 1].t, 3063);
    assert.equal(slots[atChange].bpm, 240);
    assert.equal(slots[0].bpm, 120);
});
