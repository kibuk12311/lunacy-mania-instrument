// Run with: npx electron tests/smoke/electron-export.mjs <outDir> — the create tab's saving and remap channels
// (mapgen v3, stream C) over the real worker, real ffmpeg-static and the real offscreen background renderer:
// a 2-difficulty mapset with a 1.2x rate version and a dan-course background, a single map under today's name,
// the song's tags, then remap-load / remap-create −1 dan on a map in a fake Songs folder. Prints what it made.
// Everything is written under <outDir> (also Electron's user data), nothing anywhere else.
import { app, BrowserWindow, utilityProcess } from "electron";
import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { clickTrack } from "../fixtures/clickTrack.js";
import { readOsz } from "../fixtures/readOsz.js";
import { createWorkerClient } from "../../app/workerClient.js";
import { createGeneratedStore } from "../../app/generatedStore.js";
import { registerExportIpc } from "../../app/exportIpc.js";
import { createPngRenderer } from "../../app/renderPng.js";
import { toOsu } from "../../src/gen/writer.js";
import { readMeta } from "../../src/gen/osuMeta.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const outDir = path.resolve(process.argv.at(-1));
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
// the background renderer's window is the only one: closing it must not end the run
app.on("window-all-closed", () => {});

function wav({ samples, sampleRate }) {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => data.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32767, i * 2));
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

// a stream on the click track's 1/4 grid: every `every`-th quarter, jumps on each `jumpEvery`-th row
function chart({ bpm, offsetMs, seconds, every, jumpEvery, version }) {
    const step = 60000 / bpm / 4;
    const order = [0, 2, 1, 3];
    const rows = [];
    for (let i = 0, k = 0; offsetMs + i * step < seconds * 1000 - 500; i += every, k += 1) {
        const c = order[k % 4];
        rows.push({ t: Math.round(offsetMs + i * step), cols: k % jumpEvery === 0 ? [c, (c + 1) % 4 === order[(k + 1) % 4] ? (c + 2) % 4 : (c + 1) % 4] : [c] });
    }
    return toOsu({ rows, bpm, offsetMs, title: "Тестовая песня", version, audioFilename: "audio.wav", previewMs: Math.round(seconds * 400) });
}

app.whenReady().then(async () => {
    let ok = true;
    const check = (cond, what) => {
        if (!cond) console.log("SMOKE CHECK FAILED", what);
        ok &&= Boolean(cond);
    };
    const worker = createWorkerClient({ spawn: () => utilityProcess.fork(path.join(root, "app", "analysisWorker.js")) });
    try {
        const bpm = 174;
        const offsetMs = 312;
        const seconds = 60;
        const song = path.join(outDir, "Smoke Band - Тестовая песня.wav");
        writeFileSync(song, wav(clickTrack({ bpm, offsetMs, seconds, sampleRate: 44100, div: 4 })));

        const store = createGeneratedStore({ max: 24 });
        const ids = [];
        for (const [every, jumpEvery] of [[2, 4], [1, 3]]) {
            const draft = chart({ bpm, offsetMs, seconds, every, jumpEvery, version: "draft" });
            const result = await worker.analyze(draft, 1);
            const version = `${result.label} Jumpstream`;
            const osuText = chart({ bpm, offsetMs, seconds, every, jumpEvery, version });
            ids.push(store.put({ osuText, version, title: "Тестовая песня", audioPath: song, result }));
            console.log("SMOKE diff", version, result.numeric);
        }

        const handlers = {};
        const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } };
        const mapsDir = path.join(outDir, "maps");
        registerExportIpc({
            ipcMain, generatedStore: store, paths: { mapsDir }, log: (line) => console.log("SMOKE log", line),
            worker, analysis: null, ffmpegPath: async () => ffmpegStatic, renderPng: createPngRenderer(BrowserWindow),
            tosu: null, generatorClient: worker,
        });

        const tags = await handlers["song-tags"]({}, song);
        console.log("SMOKE song-tags", JSON.stringify(tags));
        check(tags.ok && tags.artist === "Smoke Band" && tags.title === "Тестовая песня", "tags from the file name");

        let t0 = Date.now();
        const set = await handlers["export-set"]({}, {
            ids, meta: { title: "Тестовая песня", artist: "Smoke Band", creator: "smoke", source: "", tags: "smoke test" },
            previewMs: 20000, background: { mode: "danCourse" }, rates: [1.2], pitch: false,
        });
        console.log("SMOKE export-set mapset", set.ok, set.file ?? set.message, `${Date.now() - t0} ms`);
        check(set.ok, "mapset saved");
        if (set.ok) {
            for (const e of set.entries) console.log("SMOKE entry", `${e.rate}x`, e.version, e.label, e.numeric);
            const files = readOsz(readFileSync(set.file));
            console.log("SMOKE zip", [...files].map(([name, data]) => `${name} (${data.length} B)`).join(" | "));
            for (const [name, data] of files) {
                if (!name.endsWith(".osu")) continue;
                const m = readMeta(data.toString("utf8"));
                console.log("SMOKE osu", m.version, "| audio", m.audioFilename, "| preview", m.previewMs, "| bg", m.background, "| set", m.beatmapSetId);
                check(files.has(m.audioFilename) && files.has(m.background), `${name}: its audio and background are in the set`);
            }
            const png = files.get("bg.png");
            check(png && png.subarray(1, 4).toString() === "PNG", "bg.png is a PNG");
            if (png) writeFileSync(path.join(outDir, "mapset-bg.png"), png);
            check(set.entries.length === 4 && [...files.keys()].filter((n) => n.endsWith(".osu")).length === 4, "2 difficulties + 2 rated");
            check(files.has("audio.mp3") && files.has("audio 1.2x.mp3"), "the wav became audio.mp3, the rate has its own audio");
            const probe = (name) => {
                const p = path.join(outDir, `probe-${name}`);
                writeFileSync(p, files.get(name));
                try {
                    execFileSync(ffmpegStatic, ["-hide_banner", "-i", p], { stdio: "pipe" });
                } catch (error) {
                    return Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(String(error.stderr))?.slice(1).reduce((s, x, i) => s + Number(x) * [3600, 60, 1][i], 0));
                }
                return null;
            };
            const base = probe("audio.mp3");
            const rated = probe("audio 1.2x.mp3");
            console.log("SMOKE audio seconds", base, rated);
            check(Math.abs(base / rated - 1.2) < 0.02, "the 1.2x audio is 1.2 times shorter");
        }

        const single = await handlers["export-set"]({}, { ids: [ids[0]], meta: { title: "Тестовая песня" }, previewMs: null, background: { mode: "none" }, rates: [], pitch: false });
        console.log("SMOKE export-set single", single.ok, single.file ?? single.message);
        check(single.ok && path.basename(single.file).startsWith("Тестовая песня ["), "a single map keeps today's name");

        // remap: a map in a Songs-like folder, made one dan easier through the real worker and the mapper model
        const folder = path.join(outDir, "Songs", "1 Smoke Band - Test");
        mkdirSync(folder, { recursive: true });
        const original = path.join(folder, "Smoke Band - Test (smoke) [Hard].osu");
        writeFileSync(original, store.get(ids[1]).osuText.replace(/^Version:.*$/m, "Version:Hard"), "utf8");
        const loaded = await handlers["remap-load"]({}, { file: original });
        console.log("SMOKE remap-load", JSON.stringify(loaded));
        check(loaded.ok && loaded.rice && Number.isFinite(loaded.numeric), "remap-load");
        if (loaded.ok && loaded.rice) {
            const level = Math.round(loaded.numeric) - 1;
            t0 = Date.now();
            const made = await handlers["remap-create"]({}, { path: original, range: { lo: level - 0.5, hi: level + 0.5 }, seed: 1 });
            console.log("SMOKE remap-create", JSON.stringify(made), `${Date.now() - t0} ms`);
            check(made.ok && made.removed > 0, "remap −1");
            console.log("SMOKE Songs folder", readdirSync(folder).join(" | "));
        }
    } catch (error) {
        console.log("SMOKE error", error?.stack ?? error);
        ok = false;
    } finally {
        worker.dispose();
    }
    console.log("SMOKE", ok ? "OK" : "FAILED");
    app.exit(ok ? 0 : 1);
});
