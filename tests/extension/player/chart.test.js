import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChart, columnOf, unplayableReason, noteSpan } from "../../../extension/player/chart.js";
import { makeChart } from "../../fixtures/makeChart.js";
import { randomChart } from "../../fixtures/randomChart.js";

const osu = (objects, { keys = 4, mode = 3, od = 7.5, preview = 1234, extra = "" } = {}) => [
    "﻿osu file format v14", "",
    "[General]", "AudioFilename: Sub\\Song.MP3", "AudioLeadIn: 0", `PreviewTime: ${preview}`, `Mode: ${mode}`, extra, "",
    "[Metadata]", "Title:T", "TitleUnicode:Т", "Artist:A", "Creator:C", "Version:Hard", "BeatmapID:4961226", "BeatmapSetID:2316993", "",
    "[Difficulty]", "HPDrainRate:8", `CircleSize:${keys}`, `OverallDifficulty:${od}`, "",
    "[TimingPoints]", "0,333.33,4,1,0,100,1,0", "500,-100,4,1,0,100,0,1", "",
    "[HitObjects]", ...objects, "",
].join("\r\n");

test("columns come from x as osu!stable counts them, clamped", () => {
    assert.equal(columnOf(64, 4), 0);
    assert.equal(columnOf(192, 4), 1);
    assert.equal(columnOf(320, 4), 2);
    assert.equal(columnOf(448, 4), 3);
    assert.equal(columnOf(127, 4), 0);
    assert.equal(columnOf(128, 4), 1);
    assert.equal(columnOf(512, 4), 3); // x = 512 would be lane 4
    assert.equal(columnOf(-5, 4), 0);
    assert.equal(columnOf(256, 7), 3);
});

test("parses metadata, OD, PreviewTime, notes and LN ends", () => {
    const c = parseChart(osu([
        "448,192,2000,1,0,0:0:0:0:",
        "64,192,1000,128,0,1600:0:0:0:0:",
        "192,192,1000,1,0,0:0:0:0:",
        "320,192,1500,128,2,1400:0:0:0:0:", // end before head: a plain note
        "192,192,1000,1,0,0:0:0:0:", // exact duplicate
    ]));
    assert.equal(c.mode, 3);
    assert.equal(c.keys, 4);
    assert.equal(c.od, 7.5);
    assert.equal(c.hp, 8);
    assert.equal(c.previewTime, 1234);
    assert.equal(c.audioFilename, "Sub\\Song.MP3");
    assert.equal(c.title, "Т");
    assert.equal(c.artist, "A");
    assert.equal(c.version, "Hard");
    assert.equal(c.beatmapId, 4961226);
    assert.equal(c.beatmapSetId, 2316993);
    assert.deepEqual(c.notes, [
        { col: 0, t: 1000, end: 1600 },
        { col: 1, t: 1000, end: null },
        { col: 2, t: 1500, end: null },
        { col: 3, t: 2000, end: null },
    ]);
    assert.equal(c.timingPoints.length, 2);
    assert.equal(c.timingPoints[1].uninherited, false);
    assert.equal(c.timingPoints[1].kiai, true);
    assert.equal(unplayableReason(c), null);
    assert.deepEqual(noteSpan(c.notes), { first: 1000, last: 2000 });
});

test("no PreviewTime reads −1; refuses non-mania, non-4K and empty charts", () => {
    const noPreview = parseChart(osu(["64,192,100,1,0,0:0:0:0:"]).replace(/PreviewTime: \d+\r\n/, ""));
    assert.equal(noPreview.previewTime, -1);
    assert.equal(unplayableReason(parseChart(osu(["64,192,100,1,0,0:0:0:0:"], { mode: 0 }))), "mode");
    assert.equal(unplayableReason(parseChart(osu(["64,192,100,1,0,0:0:0:0:"], { keys: 7 }))), "keys");
    assert.equal(unplayableReason(parseChart(osu([]))), "empty");
    assert.equal(unplayableReason(parseChart("")), "mode");
    assert.equal(unplayableReason(null), "mode");
});

test("fixture charts: every note in 0..3, sorted, LN share as made", () => {
    const stream = parseChart(makeChart({ kind: "stream", seconds: 20 }));
    assert.equal(stream.keys, 4);
    assert.ok(stream.notes.length > 100);
    assert.ok(stream.notes.every((n) => n.col >= 0 && n.col < 4 && n.end === null));
    const ln = parseChart(makeChart({ kind: "ln", seconds: 20 }));
    const lns = ln.notes.filter((n) => n.end !== null);
    assert.ok(lns.length > 0 && lns.every((n) => n.end > n.t));
    for (const seed of [1, 2, 3]) {
        const r = parseChart(randomChart(seed, { seconds: 30 }));
        for (let i = 1; i < r.notes.length; i += 1) assert.ok(r.notes[i].t >= r.notes[i - 1].t);
    }
    const seven = parseChart(makeChart({ keys: 7, seconds: 5 }));
    assert.equal(seven.keys, 7);
    assert.ok(seven.notes.every((n) => n.col >= 0 && n.col < 7));
    assert.equal(unplayableReason(seven), "keys");
});
