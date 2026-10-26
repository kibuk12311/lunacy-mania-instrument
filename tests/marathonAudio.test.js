import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { marathonFilter, renderMarathonAudio } from "../app/marathonAudio.js";
import { probeAudio } from "../app/rateAudio.js";

function wav(seconds, sampleRate) {
    const n = Math.round(seconds * sampleRate);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / sampleRate) * 6000), i * 2);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

test("filter cuts, rates, pads to exact length and joins with silence", () => {
    const f = marathonFilter([
        { srcStartMs: 1000, srcEndMs: 7000, rate: 1, sampleRate: 44100 },
        { srcStartMs: 8000, srcEndMs: 13000, rate: 2, sampleRate: 48000 },
    ], { gapMs: 10000, pitch: false });
    assert.ok(f.includes("[0:a]atrim=start=1:end=7,asetpts=PTS-STARTPTS,atempo=1,aresample=44100"));
    assert.ok(f.includes("atrim=end_sample=264600[s0]"));
    assert.ok(f.includes("[1:a]atrim=start=8:end=13,asetpts=PTS-STARTPTS,atempo=2,aresample=44100"));
    assert.ok(f.includes("atrim=end_sample=110250[s1]"));
    assert.ok(f.includes("anullsrc=r=44100:cl=stereo:d=10[g0]"));
    assert.ok(f.endsWith("[s0][g0][s1]concat=n=3:v=0:a=1[out]"));
});

test("rendered marathon audio is exactly as long as the chart expects", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "марафон "));
    const a = path.join(dir, "первая.wav");
    const b = path.join(dir, "вторая.wav");
    await writeFile(a, wav(8, 44100));
    await writeFile(b, wav(14, 48000));
    const output = path.join(dir, "audio.mp3");
    await renderMarathonAudio({
        ffmpeg: ffmpegPath, output, gapMs: 3000, pitch: false,
        segments: [{ path: a, srcStartMs: 1000, srcEndMs: 7000, rate: 1 }, { path: b, srcStartMs: 8000, srcEndMs: 13000, rate: 1.25 }],
    });
    const { durationSec } = await probeAudio(ffmpegPath, output);
    // 6 s + 3 s gap + 5 s / 1.25 = 13 s (mp3 adds at most a frame of padding)
    assert.ok(Math.abs(durationSec - 13) < 0.06, `duration ${durationSec}`);
});
