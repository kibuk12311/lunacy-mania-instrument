// src/interlude/replay.js on synthetic data: the Replay blob of scores.db (made by tests/fixtures/makeIlReplay.js), the
// Mods column, the mods followed (as Prelude's Mods/*.fs change a chart), the notes and the key presses.
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readIlReplay, parseIlMods, applyIlMods, ilNotes, ilNoteRows, ilPresses } from "../../src/interlude/replay.js";
import { NOTE, encodeChart, decodeChart } from "../../src/interlude/chart.js";
import { makeIlReplay, framesOfPresses, chartBuilder } from "../fixtures/makeIlReplay.js";

const { NOTHING: _, NORMAL: N, HOLDHEAD: H, HOLDBODY: B, HOLDTAIL: T } = NOTE;
const rows = (chart) => chart.notes.map((r) => [r.time, r.data.join("")]);

test("a replay is read: count, float32 times, masks; the round trip keeps every frame", () => {
    const frames = [{ time: -4717.93, mask: 2 }, { time: 0, mask: 3 }, { time: 12.5, mask: 1 }, { time: 12.5, mask: 0 }, { time: 30000.123, mask: 0x8008 }];
    const read = readIlReplay(makeIlReplay(frames));
    assert.ok(read.times instanceof Float32Array);
    assert.ok(read.masks instanceof Uint16Array);
    assert.deepEqual([...read.times], frames.map((f) => Math.fround(f.time)));
    assert.deepEqual([...read.masks], [2, 3, 1, 0, 0x8008]);
    const empty = readIlReplay(makeIlReplay([]));
    assert.deepEqual([empty.times.length, empty.masks.length], [0, 0]);
});

test("a damaged replay throws: not gzip, a wrong count, no time, time going back", () => {
    assert.throws(() => readIlReplay(Buffer.from([1, 2, 3])), /gzip/);
    assert.throws(() => readIlReplay(gzipSync(Buffer.from([1, 0]))), /frame count/);
    assert.throws(() => readIlReplay(makeIlReplay([{ time: 0, mask: 1 }], { count: 2 })), /do not hold/);
    assert.throws(() => readIlReplay(makeIlReplay([{ time: 0, mask: 1 }], { count: -1 })), /do not hold/);
    assert.throws(() => readIlReplay(makeIlReplay([{ time: NaN, mask: 1 }])), /no time/);
    assert.throws(() => readIlReplay(makeIlReplay([{ time: Infinity, mask: 1 }])), /no time/);
    assert.throws(() => readIlReplay(makeIlReplay([{ time: 10, mask: 1 }, { time: 9, mask: 0 }])), /back in time/);
});

test("the Mods column: states, what is followed, the names Interlude shows in its order", () => {
    assert.deepEqual(parseIlMods("{}"), { mods: {}, unsupported: [], labels: [] });
    assert.deepEqual(parseIlMods(null), { mods: {}, unsupported: [], labels: [] });
    assert.deepEqual(parseIlMods('{"mirror":0}'), { mods: { mirror: 0 }, unsupported: [], labels: ["MR"] });
    assert.deepEqual(parseIlMods('{"nosv":0,"mirror":0,"noln":2}').labels, ["LN-2", "MR", "NSV"]);
    assert.deepEqual(["0", "1", "2", "3"].map((s) => parseIlMods(`{"noln":${s}}`).labels[0]), ["NLN", "LN-3", "LN-2", "LN-1"]);
    const odd = parseIlMods('{"shuffle":-1234,"inverse":1,"random":-5,"column_swap":4660,"more_notes":1,"future":0,"noln":7}');
    assert.deepEqual(odd.unsupported, ["noln", "more_notes", "column_swap", "shuffle", "random", "inverse", "future"]);
    assert.deepEqual(odd.labels, ["NLN", "MNC", "[4321]", "SHF", "RD", "INV+1", "future"]);
    assert.throws(() => parseIlMods("{mirror"), /JSON/);
    assert.throws(() => parseIlMods("[1]"), /map/);
    assert.throws(() => parseIlMods('{"mirror":0.5}'), /state/);
});

test("mirror turns each row over", () => {
    const chart = { keys: 4, notes: [{ time: 0, data: [N, _, _, H] }, { time: 100, data: [_, N, _, T] }], bpm: [], sv: [] };
    assert.deepEqual(rows(applyIlMods(chart, { mirror: 0 })), [[0, "2001"], [100, "4010"]]);
    assert.deepEqual(rows(chart), [[0, "1002"], [100, "0104"]], "the chart given stays as it was");
});

test("noln 0: every hold a note, rows left with only bodies dropped", () => {
    const chart = { keys: 4, notes: [{ time: 0, data: [H, _, _, _] }, { time: 50, data: [B, N, _, _] }, { time: 100, data: [T, _, _, _] }, { time: 200, data: [N, _, _, _] }], bpm: [{ time: 0, data: { meter: 4, msPerBeat: 500 } }], sv: [] };
    assert.deepEqual(rows(applyIlMods(chart, { noln: 0 })), [[0, "1000"], [50, "0100"], [200, "1000"]]);
    const plain = { ...chart, notes: [{ time: 0, data: [N, _, _, _] }] };
    assert.equal(applyIlMods(plain, { noln: 0 }), plain, "no hold: the chart as it is");
});

test("noln 1-3: holds shorter than 1, 1/2, 1/4 beat (less 3 ms), by the BPM where they start", () => {
    // 500 ms a beat until 1000, then 250
    const make = () => ({
        keys: 4,
        notes: [
            { time: 0, data: [H, _, _, _] }, { time: 400, data: [T, _, _, _] },
            { time: 600, data: [_, H, _, _] }, { time: 800, data: [_, B, N, _] }, { time: 1100, data: [_, T, _, _] },
            { time: 1200, data: [H, _, _, _] }, { time: 1280, data: [B, _, N, _] }, { time: 1400, data: [T, _, _, _] },
        ],
        bpm: [{ time: 0, data: { meter: 4, msPerBeat: 500 } }, { time: 1000, data: { meter: 4, msPerBeat: 250 } }],
        sv: [],
    });
    // 1 beat (497 ms, then 247) and 1/2 beat (247, then 122): the rows inside a hold are within the threshold and then
    // comes its tail, so every hold goes
    const short = [[0, "1000"], [600, "0100"], [800, "0010"], [1200, "1000"], [1280, "0010"]];
    assert.deepEqual(rows(applyIlMods(make(), { noln: 1 })), short);
    assert.deepEqual(rows(applyIlMods(make(), { noln: 2 })), short);
    // 1/4 beat (122 ms, then 59.5): the rows at 800 and 1280 are past it and stop the search; the 400 ms hold at 0 still
    // goes, Prelude takes a tail that is the next row in its column however far it is
    assert.deepEqual(rows(applyIlMods(make(), { noln: 3 })), [[0, "1000"], [600, "0200"], [800, "0310"], [1100, "0400"], [1200, "2000"], [1280, "3010"], [1400, "4000"]]);
});

test("nosv drops the scroll changes; mods it cannot follow throw", () => {
    const chart = { keys: 4, notes: [{ time: 0, data: [N, _, _, _] }], bpm: [], sv: [{ time: 0, data: 1.5 }] };
    assert.deepEqual(applyIlMods(chart, { nosv: 0 }).sv, []);
    const flat = { ...chart, sv: [{ time: 0, data: 1.001 }] };
    assert.equal(applyIlMods(flat, { nosv: 0 }), flat);
    assert.throws(() => applyIlMods(chart, { shuffle: -3 }), /shuffle/);
    assert.throws(() => applyIlMods(chart, { noln: 4 }), /noln/);
});

test("mirror and noln together", () => {
    const chart = { keys: 4, notes: [{ time: 0, data: [H, _, N, _] }, { time: 100, data: [T, _, _, _] }], bpm: [{ time: 0, data: { meter: 4, msPerBeat: 500 } }], sv: [] };
    assert.deepEqual(rows(applyIlMods(chart, { mirror: 0, noln: 0 })), [[0, "0101"]]);
});

test("the notes: taps and holds with their ends, in row order, from a chart read back from charts.db's bytes", () => {
    const chart = chartBuilder(4).note(1000, 3).hold(1000, 1500, 0).note(1200, 1).build();
    const decoded = decodeChart(encodeChart(chart), 4);
    assert.deepEqual(ilNotes(decoded), [{ t: 1000, col: 0, end: 1500 }, { t: 1000, col: 3, end: null }, { t: 1200, col: 1, end: null }]);
    assert.deepEqual(ilNoteRows(decoded).map((n) => [n.row, n.tailRow]), [[0, 2], [0, null], [1, null]]);
});

test("key presses per column, ms of the chart, as the frames change", () => {
    const frames = readIlReplay(makeIlReplay(framesOfPresses([{ t: -10, col: 0, up: 40 }, { t: 0, col: 2, up: 20 }, { t: 100, col: 3, up: 150 }, { t: 200, col: 3, up: 260 }])));
    const presses = ilPresses({ times: frames.times, masks: Uint16Array.from([...frames.masks.slice(0, -1), 0x18]) }, 4, 1000);
    assert.deepEqual(presses, [[{ t: 990, up: 1040 }], [], [{ t: 1000, up: 1020 }], [{ t: 1100, up: 1150 }, { t: 1200, up: null }]], "a key still down at the end; a bit past the columns is not read");
    assert.equal(ilPresses({ times: Float32Array.from([0.1]), masks: Uint16Array.from([1]) }, 4, 1000.3)[0][0].t, Math.fround(1000.3 + Math.fround(0.1)));
});
