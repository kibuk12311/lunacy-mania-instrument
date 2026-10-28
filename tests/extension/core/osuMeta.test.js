// shared/osuMeta.js on synthetic charts and hand-written edge cases.
import test from "node:test";
import assert from "node:assert/strict";
import { readOsuMeta } from "../../../extension/shared/osuMeta.js";
import { makeChart } from "../../fixtures/makeChart.js";

const osu = (lines) => ["osu file format v14", "", ...lines].join("\r\n");

test("a 4K chart: mode, keys, od, hp, names, counts, first and last note", () => {
    const meta = readOsuMeta(makeChart({ kind: "ln", bpm: 120, seconds: 10 }));
    assert.equal(meta.mode, 3);
    assert.equal(meta.keys, 4);
    assert.equal(meta.od, 8);
    assert.equal(meta.hp, 8);
    assert.equal(meta.previewTime, -1);
    assert.equal(meta.audioFilename, "audio.mp3");
    assert.equal(meta.title, "Synthetic ln");
    assert.equal(meta.version, "ln 120");
    assert.equal(meta.artist, "Test");
    assert.equal(meta.creator, "Test");
    assert.equal(meta.beatmapId, null);
    assert.ok(meta.noteCount > 0 && meta.lnCount > 0 && meta.lnCount < meta.noteCount);
    assert.equal(meta.firstNoteMs, 1000);
    assert.ok(meta.lastNoteMs > 10000 - 500, `${meta.lastNoteMs}`);
});

test("PreviewTime, AudioLeadIn, ids, BOM, LN tails past the last head, 7K and other modes", () => {
    const text = `﻿${osu([
        "[General]", "AudioFilename: Tb.mp3", "AudioLeadIn: 500", "PreviewTime: 13805", "Mode: 3", "",
        "[Metadata]", "Title:Dan", "TitleUnicode:段", "Version:Gamma", "BeatmapID:4961226", "BeatmapSetID:2316993", "",
        "[Difficulty]", "HPDrainRate:7.5", "CircleSize:7", "OverallDifficulty:8.2", "",
        "[HitObjects]", "36,192,1000,1,0,0:0:0:0:", "109,192,1200,128,0,5000:0:0:0:0:", "182,192,1300,1,0,0:0:0:0:", "",
    ])}`;
    const meta = readOsuMeta(text);
    assert.equal(meta.mode, 3);
    assert.equal(meta.keys, 7);
    assert.equal(meta.od, 8.2);
    assert.equal(meta.hp, 7.5);
    assert.equal(meta.previewTime, 13805);
    assert.equal(meta.audioLeadIn, 500);
    assert.equal(meta.audioFilename, "Tb.mp3");
    assert.equal(meta.beatmapId, 4961226);
    assert.equal(meta.beatmapSetId, 2316993);
    assert.equal(meta.title, "Dan");
    assert.equal(meta.noteCount, 3);
    assert.equal(meta.lnCount, 1);
    assert.equal(meta.firstNoteMs, 1000);
    assert.equal(meta.lastNoteMs, 5000);

    const std = readOsuMeta(osu(["[General]", "AudioFilename: a.mp3", "", "[Difficulty]", "CircleSize:4", ""]));
    assert.equal(std.mode, 0, "no Mode line is osu!standard");
    assert.equal(std.keys, null, "keys only for osu!mania");
    assert.equal(std.noteCount, 0);
    assert.equal(std.firstNoteMs, null);
    assert.equal(readOsuMeta(osu(["[General]", "PreviewTime: -1", ""])).previewTime, -1);
    const empty = readOsuMeta("");
    assert.equal(empty.mode, 0);
    assert.equal(empty.title, null);
    assert.equal(readOsuMeta(osu(["[Difficulty]", "CircleSize:3.6", "", "[General]", "Mode: 3", ""])).keys, 4);
});
