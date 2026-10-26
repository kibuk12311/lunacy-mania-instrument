import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { createMarathon } from "../app/marathonCreate.js";
import { setLang } from "../src/i18n/i18n.js";
import { makeChart } from "./fixtures/makeChart.js";

function silentWav(seconds, sampleRate = 22050) {
    const n = Math.round(seconds * sampleRate);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + n * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n * 2, 40);
    return Buffer.concat([h, Buffer.alloc(n * 2)]);
}

async function song(root, name, kind, bpm) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    const text = makeChart({ kind, bpm, seconds: 6 }).replace("AudioFilename: audio.mp3", "AudioFilename: song.wav");
    const osuPath = path.join(dir, `${name}.osu`);
    await writeFile(osuPath, text, "utf8");
    await writeFile(path.join(dir, "song.wav"), silentWav(9));
    return osuPath;
}

test("a marathon .osz holds the joined chart, one audio file and the dan background", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "марафон "));
    const a = await song(root, "Первая", "stream", 150);
    const b = await song(root, "Вторая", "jumpstream", 170);
    const htmls = [];
    const r = await createMarathon({
        ffmpeg: ffmpegPath, outDir: path.join(root, "out"),
        entries: [{ path: a, rate: 1 }, { path: b, rate: 1.2 }],
        gapMs: 4000, pitch: false, title: "Тест Дан", od: 8, hp: 8,
        danFor: async () => "Beta mid",
        renderPng: async (html) => { htmls.push(html); return Buffer.from("PNGDATA"); },
    });
    const zip = await readFile(r.file);
    for (const name of ["Тест Дан.osu", "audio.mp3", "bg.png"]) assert.ok(zip.includes(Buffer.from(name)), name);
    assert.ok(zip.includes(Buffer.from("PNGDATA")));
    assert.equal(htmls.length, 1);
    assert.ok(htmls[0].includes("Тест Дан") && htmls[0].includes("Beta mid") && htmls[0].includes("1.2x"));
    assert.ok(r.totalMs > 10000);
});

test("non-4K or non-mania maps are refused with their name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "марафон "));
    const a = await song(root, "Семь", "stream", 150);
    await writeFile(a, (await readFile(a, "utf8")).replace("CircleSize:4", "CircleSize:7"));
    await assert.rejects(createMarathon({
        ffmpeg: ffmpegPath, outDir: root, entries: [{ path: a, rate: 1 }], gapMs: 1000, pitch: false, title: "x",
        danFor: async () => "", renderPng: async () => Buffer.from(""),
    }), /не 4K/);
});

test("russian plural for the map count", async () => {
    const { mapsWord } = await import("../app/marathonCreate.js");
    assert.deepEqual([1, 2, 4, 5, 11, 12, 21, 22, 25].map(mapsWord),
        ["1 карта", "2 карты", "4 карты", "5 карт", "11 карт", "12 карт", "21 карта", "22 карты", "25 карт"]);
});

test("english map count, background subtitle and refusal", async () => {
    const { mapsWord } = await import("../app/marathonCreate.js");
    const root = await mkdtemp(path.join(tmpdir(), "marathon en "));
    const a = await song(root, "One", "stream", 150);
    const b = await song(root, "Two", "jumpstream", 170);
    const seven = await song(root, "Seven", "stream", 150);
    await writeFile(seven, (await readFile(seven, "utf8")).replace("CircleSize:4", "CircleSize:7"));
    setLang("en");
    try {
        assert.deepEqual([0, 1, 2, 5, 11, 21].map(mapsWord), ["0 maps", "1 map", "2 maps", "5 maps", "11 maps", "21 maps"]);
        const htmls = [];
        await createMarathon({
            ffmpeg: ffmpegPath, outDir: path.join(root, "out"),
            entries: [{ path: a, rate: 1 }, { path: b, rate: 1.2 }],
            gapMs: 2000, pitch: false, title: "Test Dan",
            danFor: async (_text, rate) => (rate === 1 ? "Beta mid" : "Gamma low"),
            renderPng: async (html) => { htmls.push(html); return Buffer.from("PNG"); },
        });
        assert.match(htmls[0], /4K marathon · 2 maps · \d+:\d\d · Beta mid → Gamma low/);
        await assert.rejects(createMarathon({
            ffmpeg: ffmpegPath, outDir: root, entries: [{ path: seven, rate: 1 }], gapMs: 1000, pitch: false, title: "x",
            danFor: async () => "", renderPng: async () => Buffer.from(""),
        }), { message: "“Test - Synthetic stream [stream 150]” isn't 4K osu!mania" });
        await assert.rejects(createMarathon({ entries: [] }), { message: "add at least one map" });
    } finally {
        setLang("ru");
    }
});

test("the background carries the difficulty curve from the dans, with the template plan when there is one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "марафон кривая "));
    const a = await song(root, "One", "stream", 150);
    const b = await song(root, "Two", "jumpstream", 170);
    const htmls = [];
    const base = {
        ffmpeg: ffmpegPath, outDir: path.join(root, "out"), entries: [{ path: a, rate: 1 }, { path: b, rate: 1.2 }],
        gapMs: 2000, pitch: false, title: "Curve",
        danFor: async (_text, rate) => (rate === 1 ? { label: "Beta mid", numeric: 12.0 } : { label: "Gamma low", numeric: 12.6 }),
        renderPng: async (html) => { htmls.push(html); return Buffer.from("PNG"); },
    };
    const r = await createMarathon(base);
    assert.ok(htmls[0].includes("<svg"));
    assert.ok(htmls[0].includes(">Gamma low<"));
    assert.ok(!htmls[0].includes("stroke-dasharray"));
    assert.match(htmls[0], /4K марафон · 2 карты · \d+:\d\d · Beta mid → Gamma low/);
    assert.deepEqual(r.dans, ["Beta mid", "Gamma low"]);
    await createMarathon({ ...base, plan: [12.1, 12.5] });
    assert.ok(htmls[1].includes("stroke-dasharray") && htmls[1].includes("план шаблона"));
    // no dan known: no curve
    await createMarathon({ ...base, danFor: async () => ({ label: "", numeric: null }) });
    assert.ok(!htmls[2].includes("<svg"));
});
