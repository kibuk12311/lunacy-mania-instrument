// Run with: npx electron tests/smoke/electron-generate.mjs <outDir> — song → timing (in a renderer) → the create tab's
// main-process channels (mapgen v3) over the real worker: detect-timing, generate-map (a store id, no file), then
// export-set saves it; prints the id, the saved file and its zip entries.
import { app, BrowserWindow, utilityProcess } from "electron";
import path from "node:path";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clickTrack } from "../fixtures/clickTrack.js";
import { createWorkerClient } from "../../app/workerClient.js";
import { createGeneratedStore } from "../../app/generatedStore.js";
import { registerCreateIpc } from "../../app/createIpc.js";
import { registerExportIpc } from "../../app/exportIpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const outDir = process.argv.at(-1);
mkdirSync(outDir, { recursive: true });

function wav({ samples, sampleRate }) {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => data.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32767, i * 2));
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

// Names and sizes in a zip, from its central directory.
function zipEntries(file) {
    const zip = readFileSync(file);
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    const names = [];
    for (let i = 0; i < count; i += 1) {
        const nameLength = zip.readUInt16LE(at + 28);
        const size = zip.readUInt32LE(at + 24);
        names.push(`${zip.toString("utf8", at + 46, at + 46 + nameLength)} (${size} B)`);
        at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    }
    return names;
}

app.whenReady().then(async () => {
    const song = path.join(outDir, "Тестовая песня.wav");
    writeFileSync(song, wav(clickTrack({ bpm: 174, offsetMs: 312, seconds: 90, sampleRate: 44100 })));
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false } });
    await win.loadFile(path.join(root, "app", "renderer", "index.html"));
    const onsetUrl = pathToFileURL(path.join(root, "src", "audio", "onset.js")).href;
    const tempoUrl = pathToFileURL(path.join(root, "src", "audio", "tempo.js")).href;
    const songUrl = pathToFileURL(song).href;
    const analysed = await win.webContents.executeJavaScript(`(async () => {
        const { onsetEnvelope, envelopeToTransfer } = await import(${JSON.stringify(onsetUrl)});
        const { detectTiming } = await import(${JSON.stringify(tempoUrl)});
        const bytes = await (await fetch(${JSON.stringify(songUrl)})).arrayBuffer();
        const ctx = new AudioContext();
        const buffer = await ctx.decodeAudioData(bytes);
        const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * 22050), 22050);
        const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
        const mono = await off.startRendering();
        const env = onsetEnvelope(mono.getChannelData(0), 22050);
        return { timing: detectTiming(env), envelope: envelopeToTransfer(env), durationMs: Math.round(buffer.duration * 1000) };
    })()`);
    console.log("SMOKE timing (renderer)", JSON.stringify(analysed.timing), "duration", analysed.durationMs);

    // the create tab's channels as main registers them, on a stand-in ipcMain
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } };
    const generatorClient = createWorkerClient({ spawn: () => utilityProcess.fork(path.join(root, "app", "analysisWorker.js")) });
    const generatedStore = createGeneratedStore({ max: 24 });
    const log = (line) => console.log("SMOKE log", line);
    registerCreateIpc({ ipcMain, generatorClient, generatedStore, log });
    registerExportIpc({ ipcMain, generatedStore, paths: { mapsDir: outDir }, log });
    const progress = [];
    const event = { sender: { send: (channel, payload) => progress.push({ channel, ...payload }), isDestroyed: () => false } };

    let ok = true;
    const detected = await handlers["detect-timing"](event, { envelope: analysed.envelope });
    console.log("SMOKE detect-timing", JSON.stringify(detected));
    ok &&= detected.ok === true && detected.timing.bpm === analysed.timing.bpm && detected.timing.offsetMs === analysed.timing.offsetMs;

    const { bpm, offsetMs } = analysed.timing;
    const t0 = Date.now();
    const out = await handlers["generate-map"](event, {
        jobId: "smoke-1", audioPath: song, title: "Тестовая песня", durationMs: analysed.durationMs, envelope: analysed.envelope,
        timing: { sections: [{ timeMs: offsetMs, bpm, meter: 4 }], bpm, offsetMs },
        request: {
            range: { lo: 12.7, hi: 13.7 }, patterns: [{ name: "Chordjack", share: 0.7 }, { name: "Jumpstream", share: 0.3 }],
            mix: "sections", stamina: 0.6, burst: 0.3, seed: 1,
        },
    });
    console.log("SMOKE generate", out.ok, out.code ?? "", Date.now() - t0, "ms", "id", out.id, "engine", out.engine, JSON.stringify(out.modelInfo),
        out.result?.label, out.result?.numeric, "reachable", out.reachable, "file", out.file,
        (out.result?.top3 ?? []).map((p) => `${p.name} ${Math.round(p.share * 100)}%`).join(", "));
    console.log("SMOKE progress events", progress.length, progress.slice(0, 3).map((p) => `${p.jobId}:${p.phase} ${p.i}/${p.n}`).join(" "));
    console.log("SMOKE .osz files after generate", readdirSync(outDir).filter((f) => f.endsWith(".osz")).length);
    ok &&= out.ok === true && typeof out.id === "string" && out.file === undefined;

    if (out.ok) {
        const saved = await handlers["export-set"](event, {
            ids: [out.id], meta: { title: "Тестовая песня", artist: "", source: "", tags: "", creator: "" },
            previewMs: null, background: { mode: "none" }, rates: [], pitch: false,
        });
        console.log("SMOKE export-set", saved.ok, saved.file ?? saved.message, JSON.stringify(saved.entries));
        if (saved.ok) console.log("SMOKE zip", zipEntries(saved.file).join(" | "));
        ok &&= saved.ok === true;
    }
    generatorClient.dispose();
    console.log("SMOKE", ok ? "OK" : "FAILED");
    app.exit(ok ? 0 : 1);
});
