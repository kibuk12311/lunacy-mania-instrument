// The v3 generator pipeline on a tiny stand-in model and a fake analyser (numeric = notes per second).
import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { slotsForTiming, parseRedTimingPoints } from "../../src/gen/grid.js";
import { rowStats } from "../../src/gen/playability.js";
import { chartInfo } from "../../src/core/features.js";
import { dropSong } from "../fixtures/dropSong.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
const singles = [1, 2, 4, 8];
function streamTable(next) {
    const table = {};
    for (const a of [0, ...singles]) for (const b of [0, ...singles]) table[`${a},${b},1`] = next(a, b);
    return table;
}
const rolling = streamTable((a, b) => Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10])));
const jumps = { "0,0,2": { 5: 5, 10: 5, 6: 3, 9: 3 }, "5,0,2": { 10: 5, 6: 2 }, "10,0,2": { 5: 5, 9: 2 }, "10,5,2": { 5: 5 }, "5,10,2": { 10: 5 }, "6,0,2": { 9: 5 }, "9,0,2": { 6: 5 } };
const model = (over = {}) => ({
    features: AUDIO_FEATURES, families: FAMILIES,
    note: { baseline: [0], classes: [0, 1], iterations: [] },
    size: { baseline: [2, 0, -3, -5], classes: [1, 2, 3, 4], iterations: [] },
    pattern: { Stream: rolling, Jumpstream: jumps },
    ...over,
});
const perSecond = async (text) => {
    const info = chartInfo(text, 1);
    return { kind: "ok", numeric: Math.round((info.noteCount / Math.max(1, info.durationSec)) * 10) / 10, top3: [{ name: "Rolls", share: 1 }] };
};
const song = onsetEnvelope(dropSong({}), 22050); // 180 BPM from 300 ms, quiet 30–60 s
const input = (request, over = {}) => ({
    timing: { sections: [{ timeMs: 300, bpm: 180, meter: 4 }], bpm: 180, offsetMs: 300 },
    envelope: song, durationMs: 90000,
    request: { range: { lo: 4, hi: 5 }, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, ...request },
    meta: { title: "t", audioFilename: "a.mp3" },
    ...over,
});
const passAll = () => [{ name: "Rolls", share: 1 }];
const notesIn = (rows, a, b) => rows.filter((r) => r.t >= a && r.t < b);
const sameRows = (a, b) => JSON.stringify(a.map((r) => [r.t, r.mask])) === JSON.stringify(b.map((r) => [r.t, r.mask]));
const threeParts = [
    { startMs: 0, endMs: 30000, kind: "drop" },
    { startMs: 30000, endMs: 60000, kind: "break" },
    { startMs: 60000, endMs: 90000, kind: "drop" },
];

test("the same seeds give the same map, and the answer has the v3 fields", async () => {
    const a = await generateLearnedMap(input({}), perSecond, model(), { patternsOf: passAll });
    const b = await generateLearnedMap(input({}), perSecond, model(), { patternsOf: passAll });
    assert.equal(a.osuText, b.osuText);
    for (const key of ["knob", "planSeed", "noteSeed", "stats", "issues", "parts", "retries", "grid"]) assert.ok(key in a, key);
    assert.equal(a.engine, "learned");
    assert.deepEqual(a.range, { lo: 4, hi: 5 });
    assert.ok(a.parts.length >= 1 && a.parts.every((p) => typeof p.kind === "string"));
    assert.deepEqual(a.grid, { 4: 1, 3: 0, 6: 0, 8: 0 });
    const c = await generateLearnedMap(input({ noteSeed: 8 }), perSecond, model(), { patternsOf: passAll });
    assert.notEqual(c.osuText, a.osuText);
});

test("a stream table that always continues 1→1 still makes no 3-note jacks", async () => {
    const stuck = streamTable(() => ({ 1: 100 }));
    const r = await generateLearnedMap(input({ range: { lo: 6, hi: 7 } }), perSecond, model({ pattern: { Stream: stuck } }), { patternsOf: passAll });
    const rows = parseRows(r.osuText).map((x) => ({ ...x, family: "Stream" }));
    const stats = rowStats(rows, slotsForTiming({ bpm: 180, offsetMs: 300 }, 90000));
    assert.ok(stats.maxJack.streamy <= 2, JSON.stringify(stats.maxJack));
    assert.ok(r.stats.maxJack.streamy <= 2);
    assert.ok(r.stats.forced > 0, "the guard had to step in");
});

test("a drop with a high range and an intro with a low range each land in their own range", async () => {
    const parts = [
        { startMs: 0, endMs: 30000, kind: "intro", range: { lo: 1.5, hi: 2.5 } },
        { startMs: 30000, endMs: 60000, kind: "break" },
        { startMs: 60000, endMs: 90000, kind: "drop", range: { lo: 7, hi: 8.5 } },
    ];
    const progress = [];
    const r = await generateLearnedMap(input({ parts }), perSecond, model(), { patternsOf: passAll, onProgress: (p) => progress.push(p) });
    const intro = r.parts[0];
    const drop = r.parts[2];
    assert.equal(intro.inRange, true, JSON.stringify(intro.dan));
    assert.equal(drop.inRange, true, JSON.stringify(drop.dan));
    assert.deepEqual(intro.wanted, { lo: 1.5, hi: 2.5 });
    assert.equal(r.parts[1].inRange, null);
    const searches = progress.filter((p) => p.phase === "partSearch");
    assert.deepEqual(searches.map((p) => [p.i, p.n, p.kind]), [[0, 2, "intro"], [1, 2, "drop"]]);
});

test("an empty part has no notes and writes a break line", async () => {
    const parts = threeParts.map((p, i) => (i === 1 ? { ...p, empty: true } : p));
    const r = await generateLearnedMap(input({ parts }), perSecond, model(), { patternsOf: passAll });
    const rows = parseRows(r.osuText);
    assert.equal(notesIn(rows, 30000, 60000).length, 0);
    const lines = r.osuText.split("\r\n");
    const breakLine = lines[lines.indexOf("//Break Periods") + 1];
    assert.match(breakLine, /^2,\d+,\d+$/);
    const [, from, to] = breakLine.split(",").map(Number);
    assert.ok(from >= 29000 && from < 31000 && to > 59000 && to <= 60000, breakLine);
    assert.equal(r.parts[1].empty, true);
    assert.equal(r.parts[1].noteCount, 0);
});

test("changing one part's seed leaves the other parts' rows identical", async () => {
    // every density reads the same, so the search keeps its first try and only the seeds differ
    const flat = async () => ({ kind: "ok", numeric: 4.5, top3: [{ name: "Rolls", share: 1 }] });
    const dense = model({ note: { baseline: [5], classes: [0, 1], iterations: [] } });
    const run = (seed) => generateLearnedMap(input({ stamina: 1, parts: threeParts.map((p, i) => (i === 1 ? { ...p, seed } : p)) }), flat, dense, { patternsOf: passAll });
    const a = parseRows((await run(1)).osuText);
    const b = parseRows((await run(2)).osuText);
    assert.ok(sameRows(notesIn(a, 0, 30000), notesIn(b, 0, 30000)), "part 0");
    assert.ok(sameRows(notesIn(a, 60000, 90000), notesIn(b, 60000, 90000)), "part 2");
    assert.ok(!sameRows(notesIn(a, 30000, 60000), notesIn(b, 30000, 60000)), "part 1 changed");
});

test("with a lock the locked parts keep the base map's rows and the rest is new", async () => {
    const base = await generateLearnedMap(input({ parts: threeParts }), perSecond, model(), { patternsOf: passAll });
    const ranges = [[0, 30000]];
    const locked = { rows: parseRows(base.osuText).filter((r) => r.t < 30000), ranges, knob: base.knob, planSeed: base.planSeed };
    const again = await generateLearnedMap(input({ parts: threeParts, planSeed: base.planSeed, noteSeed: 99 }, { locked }), perSecond, model(), { patternsOf: passAll });
    const a = parseRows(base.osuText);
    const b = parseRows(again.osuText);
    assert.ok(sameRows(notesIn(a, 0, 30000), notesIn(b, 0, 30000)), "locked part");
    assert.ok(!sameRows(notesIn(a, 30000, 90000), notesIn(b, 30000, 90000)), "the rest is new");
    assert.equal(again.parts[0].locked, true);
    assert.equal(again.parts[1].locked, false);
});

test("a pattern finder that fails block 2 changes only block 2", async () => {
    const firstNote = (text) => parseRows(text)[0]?.t ?? -1;
    const failSecond = () => {
        let original = null;
        return (text) => {
            const t = firstNote(text);
            if (t < 30000 || t >= 60000) return passAll();
            original ??= text;
            return text === original ? [{ name: "Rolls", share: 0.2 }] : passAll();
        };
    };
    // no contrast, so the quiet middle part has enough rows for the pattern finder; a wide range, so the redone
    // block keeps the map in it
    const request = { parts: threeParts, stamina: 1, range: { lo: 3, hi: 6 } };
    const base = await generateLearnedMap(input(request), perSecond, model(), { patternsOf: passAll });
    const r = await generateLearnedMap(input(request), perSecond, model(), { patternsOf: failSecond() });
    assert.equal(base.retries.blocks, 0);
    assert.equal(r.retries.blocks, 1);
    const a = parseRows(base.osuText);
    const b = parseRows(r.osuText);
    assert.ok(sameRows(notesIn(a, 0, 30000), notesIn(b, 0, 30000)));
    assert.ok(sameRows(notesIn(a, 60000, 90000), notesIn(b, 60000, 90000)));
    assert.ok(!sameRows(notesIn(a, 30000, 60000), notesIn(b, 30000, 60000)));
    assert.equal(r.parts[1].retried, 1);
});

test("when the redone map leaves the range it goes back to the searched one", async () => {
    let after = false;
    const analyze = async (text) => (after ? { kind: "ok", numeric: 20, top3: [] } : perSecond(text));
    let original = null;
    const failing = (text) => {
        const t = parseRows(text)[0]?.t ?? -1;
        if (t < 30000 || t >= 60000) return passAll();
        original ??= text;
        return text === original ? [{ name: "Rolls", share: 0.2 }] : passAll();
    };
    const base = await generateLearnedMap(input({ parts: threeParts, stamina: 1 }), perSecond, model(), { patternsOf: passAll });
    const r = await generateLearnedMap(input({ parts: threeParts, stamina: 1 }), analyze, model(), {
        patternsOf: failing,
        // from the retries on, every map reads far too hard
        onProgress: (p) => { if (p.phase === "retry") after = true; },
    });
    assert.equal(r.retries.reverted, true);
    assert.equal(r.retries.blocks, 0);
    assert.ok(sameRows(parseRows(base.osuText), parseRows(r.osuText)));
});

test("an analyser that cannot reach the range triggers the second search", async () => {
    const capped = async (text) => {
        const r = await perSecond(text);
        return { ...r, numeric: Math.min(2, r.numeric) };
    };
    const r = await generateLearnedMap(input({ range: { lo: 6, hi: 7 } }), capped, model(), { patternsOf: passAll });
    assert.equal(r.retries.dan, "low");
    assert.equal(r.reachable, false);
    const hard = async (text) => ({ ...(await perSecond(text)), numeric: 15 });
    const h = await generateLearnedMap(input({ range: { lo: 6, hi: 7 } }), hard, model(), { patternsOf: passAll });
    assert.equal(h.retries.dan, "high");
});

test("progress goes prepare → search → retry → describe, i rising inside each phase", async () => {
    const progress = [];
    await generateLearnedMap(input({ parts: threeParts }), perSecond, model(), { patternsOf: passAll, onProgress: (p) => progress.push(p) });
    const phases = [...new Set(progress.map((p) => p.phase))];
    assert.deepEqual(phases, ["prepare", "search", "retry", "describe"]);
    for (const phase of phases) {
        const is = progress.filter((p) => p.phase === phase).map((p) => p.i);
        is.forEach((v, k) => k && assert.ok(v >= is[k - 1], `${phase}: ${is}`));
    }
    assert.deepEqual(progress.filter((p) => p.phase === "describe").map((p) => [p.i, p.n]), [[0, 3], [1, 3], [2, 3]]);
});

test("variable BPM puts every note on its own section's grid", async () => {
    const timing = { sections: [{ timeMs: 300, bpm: 180, meter: 4 }, { timeMs: 45300, bpm: 150, meter: 4 }], bpm: 180, offsetMs: 300 };
    const r = await generateLearnedMap(input({}, { timing }), perSecond, model(), { patternsOf: passAll });
    const rows = parseRows(r.osuText);
    assert.ok(notesIn(rows, 46000, 90000).length > 50);
    for (const { t } of rows) {
        const [start, bpm] = t < 45300 ? [300, 180] : [45300, 150];
        const step = 60000 / bpm / 4;
        const k = Math.round((t - start) / step);
        assert.ok(Math.abs(start + k * step - t) <= 1, `${t}`);
    }
    assert.deepEqual(parseRedTimingPoints(r.osuText).map((p) => p.time), [300, 45300]);
    assert.ok(r.osuText.includes("45300,-83.33333333333333,4,2,0,60,0,0"), "the slower half scrolls at the same speed");
});

test("snaps [4, 3] put triplet rows only on triplet beats, at about the same density", async () => {
    const track = clickTrack({ bpm: 120, offsetMs: 0, seconds: 60, div: 2, triplets: { fromMs: 20000, toMs: 40000 } });
    const envelope = onsetEnvelope(track.samples, track.sampleRate);
    const make = (snaps) => generateLearnedMap({
        timing: { sections: [{ timeMs: 0, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 0 }, envelope, durationMs: 60000,
        request: { range: { lo: 3, hi: 3.5 }, patterns: [{ name: "Stream", share: 1 }], seed: 3, snaps },
        meta: { title: "t", audioFilename: "a.mp3" },
    }, perSecond, model(), { patternsOf: passAll });
    const quarters = await make([4]);
    const mixed = await make([4, 3]);
    const rows = parseRows(mixed.osuText);
    const offQuarter = rows.filter((r) => {
        const d = ((r.t % 125) + 125) % 125;
        return d > 1 && d < 124;
    });
    assert.ok(offQuarter.length > 0, "some triplet rows");
    assert.ok(offQuarter.every((r) => r.t >= 19900 && r.t < 40100), JSON.stringify(offQuarter.slice(0, 3)));
    assert.ok(mixed.grid[3] > 0 && mixed.osuText.includes("BeatDivisor: 12"));
    const ratio = rows.length / parseRows(quarters.osuText).length;
    assert.ok(ratio > 0.85 && ratio < 1.15, `rows ${ratio.toFixed(2)}×`);
});
