// The fake osu! content of the smoke test (no copyrighted maps): two beatmapsets of synthetic charts with the shapes
// osu-web's json-beatmapset has (extension/DESIGN.md §2). Set 900001: two rice 4K diffs, one LN-heavy 4K, one 7K, one
// osu!standard diff and a mania convert of it; set 900002 (the Turbo visit): one 4K diff. Every .osu names its
// BeatmapID/BeatmapSetID, PreviewTime 5000 and audio.wav; checksums are the MD5 of the bytes served.
import { createHash } from "node:crypto";
import { makeChart } from "../../../fixtures/makeChart.js";
import { randomChart } from "../../../fixtures/randomChart.js";
import { clickTrack } from "../../../fixtures/clickTrack.js";
import { encodeWav } from "./wav.js";

export const PREVIEW_TIME = 5000;
export const AUDIO_NAME = "audio.wav";

// The chart text with its ids, version, preview point and audio file set (lines replaced or added in place).
export function withHeader(text, { beatmapId, setId, version, previewTime = PREVIEW_TIME, audio = AUDIO_NAME }) {
    const lines = text.split("\r\n").filter((l) => !/^(BeatmapID|BeatmapSetID|PreviewTime|AudioFilename|Version)\s*:/.test(l));
    const at = (header) => lines.indexOf(header) + 1;
    lines.splice(at("[General]"), 0, `AudioFilename: ${audio}`, `PreviewTime: ${previewTime}`);
    lines.splice(at("[Metadata]"), 0, `Version:${version}`, `BeatmapID:${beatmapId}`, `BeatmapSetID:${setId}`);
    return lines.join("\r\n");
}

function standardChart() {
    const objects = Array.from({ length: 120 }, (_, i) => `${64 + (i % 6) * 64},${96 + (i % 4) * 48},${1000 + i * 250},1,0,0:0:0:0:`);
    return ["osu file format v14", "", "[General]", "Mode: 0", "", "[Metadata]", "Title:Synthetic circles", "Artist:Test", "Creator:Test", "",
        "[Difficulty]", "HPDrainRate:5", "CircleSize:4", "OverallDifficulty:6", "ApproachRate:8", "SliderMultiplier:1.4", "SliderTickRate:1", "",
        "[TimingPoints]", "0,250,4,1,0,100,1,0", "", "[HitObjects]", ...objects, ""].join("\r\n");
}

const md5 = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
const lengthOf = (text) => {
    const times = text.split("\r\n").slice(text.split("\r\n").indexOf("[HitObjects]") + 1).map((l) => Number(l.split(",")[2])).filter(Number.isFinite);
    return Math.ceil((Math.max(...times) - Math.min(...times)) / 1000);
};

function diff(setId, id, { text, mode, keys, version, stars, convert = false }) {
    const osu = withHeader(text, { beatmapId: id, setId, version });
    const modeInt = { osu: 0, mania: 3 }[mode];
    return {
        osu,
        json: {
            id, beatmapset_id: setId, mode, mode_int: modeInt, cs: keys, accuracy: 8, ar: 5, drain: 8, version,
            difficulty_rating: stars, total_length: lengthOf(osu) + 1, hit_length: lengthOf(osu), convert,
            count_circles: 100, count_sliders: 10, count_spinners: 0, checksum: md5(osu), status: "ranked",
            url: `https://osu.ppy.sh/beatmaps/${id}`, max_combo: 300, passcount: 0, playcount: 0, user_id: 1,
        },
    };
}

function makeSet(setId, title, diffs, converts = []) {
    const beatmaps = diffs.map((d) => d.json);
    return {
        id: setId,
        title,
        diffs,
        json: {
            id: setId, artist: "Test", artist_unicode: "Test", title, title_unicode: title, creator: "Test",
            preview_url: `https://b.ppy.sh/preview/${setId}.mp3`, status: "ranked", video: false, nsfw: false,
            availability: { download_disabled: false, more_information: null }, bpm: 170,
            beatmaps, converts: converts.map((c) => c.json),
        },
    };
}

export function buildSets() {
    const a = diff(900001, 9000011, { text: makeChart({ kind: "jumpstream", bpm: 170, seconds: 40 }), mode: "mania", keys: 4, version: "Rice JS", stars: 2.1 });
    const b = diff(900001, 9000012, { text: randomChart(11, { seconds: 40 }), mode: "mania", keys: 4, version: "Rice Random", stars: 3.4 });
    const ln = diff(900001, 9000013, { text: makeChart({ kind: "ln", seconds: 30 }), mode: "mania", keys: 4, version: "LN Heavy", stars: 3.9 });
    const seven = diff(900001, 9000014, { text: makeChart({ kind: "stream", keys: 7, seconds: 30 }), mode: "mania", keys: 7, version: "7K Stream", stars: 4.5 });
    const std = diff(900001, 9000015, { text: standardChart(), mode: "osu", keys: 4, version: "Circles", stars: 2.8 });
    const convert = { json: { ...std.json, mode: "mania", mode_int: 3, convert: true, cs: 4 } };
    const second = diff(900002, 9000021, { text: makeChart({ kind: "stream", bpm: 200, seconds: 30 }), mode: "mania", keys: 4, version: "Second Stream", stars: 3.0 });
    return [
        makeSet(900001, "Smoke Pack", [a, b, ln, seven, std], [convert]),
        makeSet(900002, "Second Set", [second]),
    ];
}

// The audio of a set: a click track long enough for its longest diff, and the 10 s preview from PREVIEW_TIME.
export function setAudio(set) {
    const seconds = Math.max(...set.diffs.map((d) => d.json.total_length)) + 3;
    const { samples, sampleRate } = clickTrack({ bpm: 170, offsetMs: 1000, seconds, sampleRate: 22050 });
    const from = Math.round((PREVIEW_TIME / 1000) * sampleRate);
    return {
        full: encodeWav(samples, sampleRate),
        preview: encodeWav(samples.subarray(from, from + 10 * sampleRate), sampleRate),
    };
}
