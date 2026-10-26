import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { rateFilter, renderRateAudio, probeAudio } from "../app/rateAudio.js";

test("time-stretch keeps pitch, nightcore resamples", () => {
    assert.equal(rateFilter({ rate: 1.25, pitch: false, sampleRate: 44100 }), "atempo=1.25");
    assert.equal(rateFilter({ rate: 0.4, pitch: false, sampleRate: 44100 }), "atempo=0.5,atempo=0.8");
    assert.equal(rateFilter({ rate: 1.5, pitch: true, sampleRate: 48000 }), "asetrate=72000,aresample=48000");
});

function wav(seconds, sampleRate = 44100) {
    const n = seconds * sampleRate;
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

for (const pitch of [false, true]) {
    test(`renders a ${pitch ? "nightcore" : "time-stretched"} mp3 that is rate times shorter`, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "рейт "));
        const input = path.join(dir, "песня.wav");
        await writeFile(input, wav(6));
        const output = path.join(dir, "песня 1.5x.mp3");
        await renderRateAudio({ ffmpeg: ffmpegPath, input, output, rate: 1.5, pitch });
        assert.ok((await stat(output)).size > 1000);
        const info = await probeAudio(ffmpegPath, output);
        assert.ok(Math.abs(info.durationSec - 4) < 0.15, `duration ${info.durationSec}`);
    });
}
