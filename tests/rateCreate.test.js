import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { createRateMap, mapInfo } from "../app/rateCreate.js";
import { makeChart } from "./fixtures/makeChart.js";

async function songFolder() {
    const dir = await mkdtemp(path.join(tmpdir(), "123 Art - Песня "));
    const chart = makeChart({ kind: "stream", bpm: 150, seconds: 8 }).replace("AudioFilename: audio.mp3", "AudioFilename: audio.wav")
        .replace("Version:stream 150", "Version:Hard");
    const osuPath = path.join(dir, "Test - Synthetic stream (Test) [Hard].osu");
    await writeFile(osuPath, chart, "utf8");
    // 9 s of silence as the song
    const n = 9 * 22050;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + n * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n * 2, 40);
    await writeFile(path.join(dir, "audio.wav"), Buffer.concat([h, Buffer.alloc(n * 2)]));
    return { dir, osuPath };
}

test("map info reads title, difficulty, BPM, OD and HP", async () => {
    const { osuPath } = await songFolder();
    const info = mapInfo(await readFile(osuPath, "utf8"));
    assert.equal(info.version, "Hard");
    assert.equal(info.bpm, 150);
    assert.equal(info.od, 8);
    assert.equal(info.hp, 8);
});

test("map info reads keys written with spaces around the colon", () => {
    const info = mapInfo("[Metadata]\nTitle : Spaced\nArtist:  A  \nVersion :Hard\nTitleUnicode:U\n[TimingPoints]\n0,500,4,1,0,100,1,0\n");
    assert.equal(info.title, "Spaced");
    assert.equal(info.artist, "A");
    assert.equal(info.version, "Hard");
});

test("creates a new difficulty and its audio next to the original", async () => {
    const { dir, osuPath } = await songFolder();
    const r = await createRateMap({ ffmpeg: ffmpegPath, beatmapPath: osuPath, rate: 1.2, pitch: false, od: 9, hp: null });
    assert.equal(path.dirname(r.osuPath), dir);
    assert.ok(path.basename(r.osuPath).includes("[Hard 1.2x (180bpm)]"));
    const text = await readFile(r.osuPath, "utf8");
    assert.ok(text.includes(`AudioFilename: ${path.basename(r.audioPath)}`));
    assert.ok(text.includes("OverallDifficulty:9"));
    const files = await readdir(dir);
    assert.ok(files.includes(path.basename(r.audioPath)));
    assert.ok(files.includes("Test - Synthetic stream (Test) [Hard].osu"), "original untouched");
});

test("at 1.0 without nightcore the map's own audio is used and ffmpeg never runs", async () => {
    const { dir, osuPath } = await songFolder();
    const before = await readdir(dir);
    // a missing ffmpeg would fail the copy if it were started
    const r = await createRateMap({ ffmpeg: path.join(dir, "no-ffmpeg.exe"), beatmapPath: osuPath, rate: 1, pitch: false, mirror: true });
    assert.equal(r.reusedAudio, true);
    assert.equal(r.audioPath, path.join(dir, "audio.wav"));
    assert.equal(r.version, "Hard 1x (150bpm) Mirror");
    const text = await readFile(r.osuPath, "utf8");
    assert.ok(text.includes("AudioFilename: audio.wav"));
    assert.ok(text.includes("Version:Hard 1x (150bpm) Mirror"));
    const after = await readdir(dir);
    assert.deepEqual(after.filter((f) => !before.includes(f)), [path.basename(r.osuPath)], "only the new .osu");
});

test("mirror and no-LN change the chart before the rate; the suffix goes in the name and the file name", async () => {
    const { dir, osuPath } = await songFolder();
    const lnChart = makeChart({ kind: "ln", bpm: 150, seconds: 8 }).replace("AudioFilename: audio.mp3", "AudioFilename: audio.wav")
        .replace("Version:ln 150", "Version:Hard");
    const lnPath = path.join(dir, "Test - Synthetic ln (Test) [Hard].osu");
    await writeFile(lnPath, lnChart, "utf8");
    const r = await createRateMap({ ffmpeg: ffmpegPath, beatmapPath: lnPath, rate: 1.2, pitch: true, mirror: true, noLn: true });
    assert.equal(r.version, "Hard 1.2x (180bpm) NC Mirror NoLN");
    assert.ok(path.basename(r.osuPath).includes("[Hard 1.2x (180bpm) NC Mirror NoLN]"));
    const objects = r.osuText.split("\r\n").slice(r.osuText.split("\r\n").indexOf("[HitObjects]") + 1).filter(Boolean);
    const source = lnChart.split(/\r?\n/).slice(lnChart.split(/\r?\n/).indexOf("[HitObjects]") + 1).filter(Boolean);
    assert.equal(objects.length, source.length);
    assert.ok(objects.every((l) => !(Number(l.split(",")[3]) & 128)), "no holds left");
    // first object: column 0 → column 3, its time ÷ 1.2
    const [x, , time] = source[0].split(",").map(Number);
    assert.equal(x, 64);
    assert.deepEqual(objects[0].split(",").slice(0, 3).map(Number), [448, 192, Math.round(time / 1.2)]);
    // a text read already is used as it is
    const again = await createRateMap({ ffmpeg: ffmpegPath, beatmapPath: osuPath, rate: 1.2, pitch: true, osuText: lnChart });
    assert.equal(again.reusedAudio, true);
    assert.ok(again.osuText.includes("Title:Synthetic ln"));
});

test("the same rate reuses its audio; nightcore gets its own file", async () => {
    const { osuPath } = await songFolder();
    const a = await createRateMap({ ffmpeg: ffmpegPath, beatmapPath: osuPath, rate: 1.3, pitch: false });
    const b = await createRateMap({ ffmpeg: ffmpegPath, beatmapPath: osuPath, rate: 1.3, pitch: false });
    const c = await createRateMap({ ffmpeg: ffmpegPath, beatmapPath: osuPath, rate: 1.3, pitch: true });
    assert.equal(a.audioPath, b.audioPath);
    assert.equal(b.reusedAudio, true);
    assert.notEqual(a.audioPath, c.audioPath);
    assert.ok(c.version.includes("NC"));
});
