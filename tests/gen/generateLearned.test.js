import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { chartInfo } from "../../src/core/features.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const ONSET = AUDIO_FEATURES.indexOf("onset");
// Tiny stand-in for a trained model: notes where the audio has onsets, rows of two notes.
const model = {
    features: AUDIO_FEATURES,
    families: ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"],
    note: { baseline: [0], classes: [0, 1], iterations: [[{
        feature: [ONSET, 0, 0], threshold: [0.3, 0, 0], missingLeft: [1, 0, 0],
        left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -3, 3],
    }]] },
    size: { baseline: [0, 2, 0, -1], classes: [1, 2, 3, 4], iterations: [] },
    pattern: { Jumpstream: { "0,0,2": { 5: 1, 10: 1 }, "5,0,2": { 10: 1 }, "10,0,2": { 5: 1 }, "10,5,2": { 5: 1 }, "5,10,2": { 10: 1 } } },
};

const song = clickTrack({ bpm: 150, offsetMs: 400, seconds: 60 });
const base = (target) => ({
    timing: { bpm: 150, offsetMs: 400 },
    envelope: onsetEnvelope(song.samples, song.sampleRate),
    durationMs: 60000,
    request: { target, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 2 },
    meta: { title: "t", audioFilename: "a.mp3" },
});
const objectLines = (text) => text.split(/\r?\n/).filter((l) => /^\d+,192,\d+,/.test(l));

test("learned generator puts notes where the model says (on the clicks) and follows the size model", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 60 });
    const r = await generateLearnedMap(base(3), fake, model);
    const times = [...new Set(objectLines(r.osuText).map((l) => Number(l.split(",")[2])))];
    const beatMs = 60000 / 150;
    const onBeat = times.filter((t) => Math.abs(((t - 400) % beatMs + beatMs) % beatMs) < 15 || Math.abs((((t - 400) % beatMs) + beatMs) % beatMs - beatMs) < 15).length;
    assert.ok(onBeat / times.length > 0.8, `on beat ${onBeat}/${times.length}`);
    const perRow = objectLines(r.osuText).length / times.length;
    assert.ok(perRow > 1.6 && perRow < 2.4, `notes per row ${perRow}`);
});

test("learned generator lands the requested dan with a monotone analyzer", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / 60) * 10) / 10 });
    const r = await generateLearnedMap(base(3), fake, model);
    assert.equal(r.reachable, true);
    assert.ok(Math.abs(r.result.numeric - 3) <= 0.3);
});

test("learned generator keeps light parts lighter even when the model wants to fill everything", async () => {
    const { dropSong } = await import("../fixtures/dropSong.js");
    // a model that wants a note on every slot, whatever the music does
    const greedy = { ...model, note: { baseline: [3], classes: [0, 1], iterations: [] } };
    const env = onsetEnvelope(dropSong({}), 22050);
    const notesIn = (text, a, b) => objectLines(text).map((l) => Number(l.split(",")[2])).filter((t) => t >= a && t < b).length;
    const fake = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 250 });
    const r = await generateLearnedMap({
        timing: { bpm: 180, offsetMs: 300 }, envelope: env, durationMs: 90000,
        request: { target: 12, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 3 },
        meta: { title: "t", audioFilename: "a.mp3" },
    }, fake, greedy);
    const loud = (notesIn(r.osuText, 5000, 28000) + notesIn(r.osuText, 62000, 85000)) / 2;
    const quiet = notesIn(r.osuText, 32000, 58000) * (23 / 26);
    assert.ok(quiet < loud * 0.7, `quiet ${quiet.toFixed(0)} vs loud ${loud.toFixed(0)}`);
});

test("the chosen pattern wins over a size model that wants chords", async () => {
    const { parseRows } = await import("../../src/gen/mapRows.js");
    // Stream statistics: rolling singles; a rare jumpjack (5 after 5) only after a chord.
    const stream = {};
    const singles = [1, 2, 4, 8];
    for (const a of [0, ...singles]) for (const b of [0, ...singles]) {
        stream[`${a},${b},1`] = Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10]));
    }
    stream["1,0,2"] = { 3: 1 };
    stream["5,0,2"] = { 5: 5 };
    stream["2,1,2"] = { 5: 1 };
    const chordHungry = {
        ...model,
        note: { baseline: [2], classes: [0, 1], iterations: [] },
        size: { baseline: [0, 3, 1, -2], classes: [1, 2, 3, 4], iterations: [] }, // the size model says "doubles!"
        pattern: { Stream: stream },
    };
    const fake = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 60 });
    const r = await generateLearnedMap({ ...base(30), request: { ...base(30).request, patterns: [{ name: "Stream", share: 1 }] } }, fake, chordHungry);
    const rows = parseRows(r.osuText, 4);
    const singlesShare = rows.filter((x) => [1, 2, 4, 8].includes(x.mask)).length / rows.length;
    const jackShare = rows.filter((x, i) => i && (x.mask & rows[i - 1].mask)).length / rows.length;
    assert.ok(singlesShare > 0.75, `singles ${singlesShare.toFixed(2)}`);
    assert.ok(jackShare < 0.1, `jacks ${jackShare.toFixed(2)}`);
});

test("a dan range is accepted anywhere inside it", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / 60) * 10) / 10, top3: [{ name: "Jumpstream", share: 1 }] });
    const r = await generateLearnedMap({ ...base(3), request: { ...base(3).request, range: { lo: 2.5, hi: 4.5 } } }, fake, model);
    assert.equal(r.reachable, true);
    assert.ok(r.result.numeric >= 2.5 && r.result.numeric < 4.5, `got ${r.result.numeric}`);
    assert.equal(r.patternScore, 1);
});

test("the trained model runs the v3 pipeline end to end (fake analyser)", async () => {
    const { readFile } = await import("node:fs/promises");
    const trained = await readFile(new URL("../../models/mapper.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);
    if (!trained) return;
    const fake = async (text) => ({ kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / 60) * 10) / 10, top3: [{ name: "Jumpstream", share: 1 }] });
    const r = await generateLearnedMap({ ...base(5), request: { ...base(5).request, range: { lo: 4, hi: 6 }, snaps: [4, 3] } }, fake, trained, { patternsOf: () => [{ name: "Jumpstream", share: 1 }] });
    assert.equal(r.engine, "learned");
    assert.ok(r.noteCount > 0 && r.parts.length >= 1);
    assert.ok(r.stats.maxJack.streamy <= 2, JSON.stringify(r.stats.maxJack));
    assert.ok(Math.abs(r.grid[4] + r.grid[3] + r.grid[6] + r.grid[8] - 1) < 1e-9);
});
