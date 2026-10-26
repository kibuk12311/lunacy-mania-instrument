import test from "node:test";
import assert from "node:assert/strict";
import { rateOsu, rateVersionName } from "../src/rate/rateMap.js";

const SOURCE = [
    "osu file format v14", "",
    "[General]", "AudioFilename: song.mp3", "AudioLeadIn: 0", "PreviewTime: 30000", "Mode: 3", "",
    "[Editor]", "Bookmarks: 1000,2000", "",
    "[Metadata]", "Title:Song", "Artist:Art", "Creator:Map", "Version:Hard", "Tags:old tags", "BeatmapID:123", "BeatmapSetID:45", "",
    "[Difficulty]", "HPDrainRate:7", "CircleSize:4", "OverallDifficulty:8", "ApproachRate:5", "SliderMultiplier:1", "SliderTickRate:1", "",
    "[Events]", "0,0,\"bg.jpg\",0,0", "2,10000,12000", "",
    "[TimingPoints]", "300,500,4,2,0,60,1,0", "6000,-50,4,2,0,60,0,0", "9000,400,4,2,0,60,1,0", "",
    "[HitObjects]", "64,192,1200,1,0,0:0:0:0:", "192,192,2400,128,0,3600:0:0:0:0:", "",
].join("\r\n");

const lines = (text, section) => {
    const all = text.split(/\r?\n/);
    const start = all.indexOf(`[${section}]`);
    const out = [];
    for (let i = start + 1; i < all.length && all[i] && !all[i].startsWith("["); i += 1) out.push(all[i]);
    return out;
};

test("1.5x: every time shrinks, red beat lengths shrink, SV stays", () => {
    const out = rateOsu(SOURCE, { rate: 1.5, audioFilename: "song 1.5x.mp3" });
    assert.deepEqual(lines(out, "HitObjects"), ["64,192,800,1,0,0:0:0:0:", "192,192,1600,128,0,2400:0:0:0:0:"]);
    assert.deepEqual(lines(out, "TimingPoints"), ["200,333.333333333333,4,2,0,60,1,0", "4000,-50,4,2,0,60,0,0", "6000,266.666666666667,4,2,0,60,1,0"]);
    assert.ok(out.includes("PreviewTime: 20000"));
    assert.ok(out.includes("Bookmarks: 667,1333"));
    assert.ok(lines(out, "Events").includes("2,6667,8000"));
    assert.ok(lines(out, "Events").includes("0,0,\"bg.jpg\",0,0"));
    assert.ok(out.includes("AudioFilename: song 1.5x.mp3"));
});

test("metadata: new difficulty name, tag, no beatmap id clash; OD/HP overrides", () => {
    const out = rateOsu(SOURCE, { rate: 1.2, audioFilename: "a.mp3", od: 9, hp: 8.5 });
    assert.ok(out.includes("Version:Hard 1.2x (144bpm)"));
    assert.ok(out.includes("BeatmapID:0"));
    assert.ok(out.includes("Tags:old tags lunacy-mania-rate"));
    assert.ok(out.includes("OverallDifficulty:9"));
    assert.ok(out.includes("HPDrainRate:8.5"));
    assert.ok(out.includes("CircleSize:4"));
});

test("without overrides OD and HP stay as they were", () => {
    const out = rateOsu(SOURCE, { rate: 1.1, audioFilename: "a.mp3" });
    assert.ok(out.includes("OverallDifficulty:8"));
    assert.ok(out.includes("HPDrainRate:7"));
});

test("version name shows the rate and the new BPM", () => {
    assert.equal(rateVersionName("Insane", 1.25, 160), "Insane 1.25x (200bpm)");
    assert.equal(rateVersionName("Insane", 0.9, 150), "Insane 0.9x (135bpm)");
});
