import test from "node:test";
import assert from "node:assert/strict";
import { excerptOsu, excerptCopies } from "../../src/gen/excerpt.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { parseRedTimingPoints } from "../../src/gen/grid.js";
import { chartInfo } from "../../src/core/features.js";

const timing = { sections: [{ timeMs: 100, bpm: 150 }, { timeMs: 40100, bpm: 200 }] };
const rowsEvery = (from, to, ms, mask = 1) => {
    const out = [];
    for (let t = from; t < to; t += ms) out.push({ t, mask, family: "Stream" });
    return out;
};

test("a short part is repeated until it lasts 30 s and has 80 notes", () => {
    const rows = rowsEvery(100, 60000, 400);
    const part = { startMs: 10100, endMs: 18100 }; // 8 s, 20 rows
    const text = excerptOsu(rows, part, timing);
    const got = parseRows(text);
    const info = chartInfo(text, 1);
    assert.ok(info.durationSec >= 30 - 0.5, `${info.durationSec}`);
    assert.ok(info.noteCount >= 80, `${info.noteCount}`);
    assert.equal(got[0].t, 0);
    assert.equal(got.length % 20, 0);
    assert.equal(info.bpm, 150);
});

test("a sparse part stops at 120 s", () => {
    const rows = rowsEvery(0, 60000, 4000);
    const part = { startMs: 0, endMs: 20000 }; // 5 notes in 20 s
    assert.equal(excerptCopies(20000, 5), 6);
    const info = chartInfo(excerptOsu(rows, part, timing), 1);
    assert.ok(info.durationSec <= 120, `${info.durationSec}`);
    assert.equal(info.noteCount, 30);
});

test("a long part is played once; a part across a BPM change keeps both red lines per copy", () => {
    assert.equal(excerptCopies(45000, 300), 1);
    const rows = [...rowsEvery(30100, 40100, 400), ...rowsEvery(40100, 50100, 300)];
    const text = excerptOsu(rows, { startMs: 30100, endMs: 50100 }, timing);
    const points = parseRedTimingPoints(text);
    assert.deepEqual(points.map((p) => [Math.round(p.time), Math.round(60000 / p.beatLength)]), [[0, 150], [10000, 200], [20000, 150], [30000, 200]]);
});
