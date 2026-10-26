// Speed of the light stems (src/audio/stems.js), and how close the curves are between the app's decoder (Chromium)
// and the dataset tools' (ffmpeg).
// Usage:
//   node tools/bench-stems.mjs [--seconds 240] [--runs 5] [--audio FILE]
//   npx electron tools/bench-stems.mjs --decoder-check [--corpus A:/SneezeyTrain/corpus/corpus.jsonl] [--limit 10]
//       [--user-data DIR]
// The bench decodes FILE with ffmpeg, or synthesises a song (drums, bass, chords, noise), and runs computeStemsSync
// `runs` times after a warm-up: wall and CPU time per stage, and how busy the whole machine was meanwhile (other
// jobs inflate the numbers). Target (addendum §2.2): 240 s in ≤ 1.2 s here.
// The decoder check decodes each song both ways (ffmpeg here; Web Audio + OfflineAudioContext at 22,050 Hz like
// app/renderer/createTab.js in a hidden window), computes the stems on both, and correlates each curve after the
// best frame lag within ±8 (decoders differ by a few ms of encoder delay). Gate (§7): correlation ≥ 0.97.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 22050;
const MAX_LAG = 8;
const GATE = 0.97;
const STEMS_URL = pathToFileURL(path.join(root, "src/audio/stems.js")).href;

const VALUED = new Set(["--seconds", "--runs", "--audio", "--corpus", "--limit", "--user-data"]);
const options = {};
for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (VALUED.has(a)) options[a.slice(2)] = process.argv[++i];
    else if (a.startsWith("--")) options[a.slice(2)] = true;
}
const flag = (name, fallback) => options[name] ?? fallback;

function ffmpegPath() {
    const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return "ffmpeg";
    return createRequire(import.meta.url)("ffmpeg-static");
}

function decodeFfmpeg(file) {
    const dec = spawnSync(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
    if (dec.status !== 0 || !dec.stdout?.length) throw new Error(`ffmpeg: ${String(dec.stderr).slice(0, 200)}`);
    return new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
}

// A deterministic stand-in song: kick on 1 and 3, snare on 2 and 4, eighth hats, a bass line and chords, some noise.
function syntheticSong(seconds, bpm = 150) {
    const n = Math.round(seconds * SAMPLE_RATE);
    const out = new Float32Array(n);
    let s = 12345;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const beat = (60 / bpm) * SAMPLE_RATE;
    for (let b = 0; b * beat < n; b += 1) {
        const at = Math.round(b * beat);
        for (let k = 0; k < 4000 && at + k < n; k += 1) {
            if (b % 2 === 0) out[at + k] += 0.8 * Math.sin((2 * Math.PI * 55 * k) / SAMPLE_RATE) * Math.exp(-k / 1500);
            else out[at + k] += (0.4 * rand() * Math.exp(-k / 400) + 0.3 * Math.sin((2 * Math.PI * 200 * k) / SAMPLE_RATE) * Math.exp(-k / 500));
        }
        const half = Math.round(at + beat / 2);
        for (let k = 0; k < 600 && half + k < n; k += 1) out[half + k] += 0.15 * (k % 2 ? 1 : -1) * rand() * Math.exp(-k / 100);
    }
    const roots = [110, 87.31, 130.81, 98];
    for (let i = 0; i < n; i += 1) {
        const bar = Math.floor(i / (4 * beat)) % 4;
        const f = roots[bar];
        out[i] += 0.12 * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) + 0.05 * (Math.sin((4 * Math.PI * f * i) / SAMPLE_RATE) + Math.sin((6 * Math.PI * f * i) / SAMPLE_RATE) + Math.sin((5 * Math.PI * f * i) / SAMPLE_RATE)) + 0.01 * rand();
    }
    return out;
}

const cpuMs = () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
};
// share of all cores' time that was busy (any process) between two os.cpus() samples
const machineBusy = (a, b) => {
    let busy = 0;
    let total = 0;
    b.forEach((c, i) => {
        const t0 = a[i].times;
        const t1 = c.times;
        const idle = t1.idle - t0.idle;
        const all = Object.keys(t1).reduce((sum, k) => sum + (t1[k] - t0[k]), 0);
        busy += all - idle;
        total += all;
    });
    return total ? busy / total : 0;
};
const median = (xs) => {
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};

async function bench() {
    const { stemsSteps, computeStems } = await import(STEMS_URL);
    const samples = options.audio ? decodeFfmpeg(options.audio) : syntheticSong(Number(flag("seconds", "240")));
    const seconds = samples.length / SAMPLE_RATE;
    const runs = Math.max(1, Number(flag("runs", "5")));
    const stageNames = ["stft", "time median", "frame pass", "chroma", "finish"];
    const rows = [];
    const before = os.cpus();
    for (let r = 0; r <= runs; r += 1) {
        const steps = stemsSteps(samples, SAMPLE_RATE, { chunk: 1e9 });
        const wall = [];
        const cpu = [];
        let w = performance.now();
        let c = cpuMs();
        for (;;) {
            const x = steps.next();
            const w1 = performance.now();
            const c1 = cpuMs();
            wall.push(w1 - w);
            cpu.push(c1 - c);
            w = w1;
            c = c1;
            if (x.done) break;
        }
        if (r > 0) rows.push({ wall, cpu, total: wall.reduce((a, b) => a + b, 0), cpuTotal: cpu.reduce((a, b) => a + b, 0) });
    }
    const busy = machineBusy(before, os.cpus());
    const w0 = performance.now();
    await computeStems(samples, SAMPLE_RATE);
    const asyncMs = performance.now() - w0;
    console.log(`${options.audio ? path.basename(options.audio) : "synthetic song"}: ${seconds.toFixed(1)} s, ${runs} runs after a warm-up`);
    stageNames.forEach((name, k) => console.log(`  ${name.padEnd(12)} wall ${median(rows.map((x) => x.wall[k] ?? 0)).toFixed(0).padStart(5)} ms   cpu ${median(rows.map((x) => x.cpu[k] ?? 0)).toFixed(0).padStart(5)} ms`));
    const totals = rows.map((x) => x.total);
    const per240 = (ms) => ((ms * 240) / seconds).toFixed(0);
    console.log(`  total        wall median ${median(totals).toFixed(0)} ms (min ${Math.min(...totals).toFixed(0)}), cpu median ${median(rows.map((x) => x.cpuTotal)).toFixed(0)} ms`);
    console.log(`  per 240 s    wall median ${per240(median(totals))} ms, min ${per240(Math.min(...totals))} ms (target ≤ 1200)`);
    console.log(`  computeStems (async, yields every 2048 frames): ${asyncMs.toFixed(0)} ms`);
    console.log(`  machine busy during the runs: ${(100 * busy).toFixed(0)}% of ${os.cpus().length} threads${busy > 0.3 ? " — other jobs were running, so these times are high" : ""}`);
    return 0;
}

// ---- decoder check -------------------------------------------------------------------------------------------------

// Songs spread over the osu! sources: round robin over hf, sets, songs and packs, evenly through each source's
// list, one chart per song group.
async function pickSongs(corpus, limit) {
    const lines = (await readFile(corpus, "utf8")).split(/\r?\n/).filter(Boolean);
    const bySource = new Map();
    for (const line of lines) {
        const m = JSON.parse(line);
        if (m.source === "etterna" || !m.audio || !/\.(mp3|ogg|opus)$/i.test(m.audio)) continue;
        if (!bySource.has(m.source)) bySource.set(m.source, []);
        bySource.get(m.source).push(m);
    }
    const lists = [...bySource.values()];
    const perSource = Math.ceil(limit / Math.max(1, lists.length));
    const seen = new Set();
    const picks = [];
    for (let k = 0; k < 4 * perSource && picks.length < limit; k += 1) {
        for (const list of lists) {
            if (picks.length >= limit) break;
            const m = list[Math.floor(((k + 0.5) * list.length) / (4 * perSource))];
            if (!m || seen.has(m.group)) continue;
            seen.add(m.group);
            picks.push({ audio: m.audio, name: `${m.artist} - ${m.title}`, source: m.source });
        }
    }
    return picks;
}

const CURVES = ["kick", "snare", "hat", "harm", "percShare"];

function correlation(a, b, lag, width = 1) {
    // corr(a[f], b[f + lag]) over the frames both have
    const n = Math.min(a.length / width, b.length / width);
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    let count = 0;
    for (let f = Math.max(0, -lag); f < n && f + lag < n; f += 1) {
        for (let k = 0; k < width; k += 1) {
            const x = a[f * width + k];
            const y = b[(f + lag) * width + k];
            sa += x;
            sb += y;
            saa += x * x;
            sbb += y * y;
            sab += x * y;
            count += 1;
        }
    }
    if (!count) return NaN;
    const cov = sab / count - (sa / count) * (sb / count);
    const va = saa / count - (sa / count) ** 2;
    const vb = sbb / count - (sb / count) ** 2;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

async function chromiumStems() {
    const { app, BrowserWindow } = await import("electron");
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    const page = path.join(app.getPath("userData"), "bench-stems.html");
    await writeFile(page, "<!doctype html><meta charset=\"utf-8\"><title>bench-stems</title>");
    await win.loadFile(page);
    const run = `async ({ audioPath, sampleRate, stemsUrl }) => {
        const { computeStems, stemsToTransfer } = await import(stemsUrl);
        const bytes = require("fs").readFileSync(audioPath);
        const ctx = new AudioContext();
        try {
            const buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * sampleRate), sampleRate);
            const source = offline.createBufferSource();
            source.buffer = buffer;
            source.connect(offline.destination);
            source.start();
            const mono = await offline.startRendering();
            const t0 = performance.now();
            const t = stemsToTransfer(await computeStems(mono.getChannelData(0), sampleRate));
            const ms = performance.now() - t0;
            const out = { ms, frames: t.frames };
            for (const k of ["kick", "snare", "hat", "harm", "percShare", "chroma", "timbre"]) out[k] = Array.from(t[k]);
            return out;
        } finally {
            ctx.close();
        }
    }`;
    return {
        stems: (audioPath) => win.webContents.executeJavaScript(`(${run})(${JSON.stringify({ audioPath, sampleRate: SAMPLE_RATE, stemsUrl: STEMS_URL })})`),
        close: () => win.destroy(),
    };
}

async function decoderCheck() {
    if (!process.versions.electron) {
        console.log("the decoder check runs under Electron: npx electron tools/bench-stems.mjs --decoder-check ...");
        return 2;
    }
    const { computeStemsSync, stemsToTransfer } = await import(STEMS_URL);
    const songs = await pickSongs(flag("corpus", "A:/SneezeyTrain/corpus/corpus.jsonl"), Number(flag("limit", "10")));
    const chromium = await chromiumStems();
    const all = Object.fromEntries([...CURVES, "chroma", "timbre"].map((k) => [k, []]));
    let failed = 0;
    for (const song of songs) {
        let a;
        let b;
        try {
            a = stemsToTransfer(computeStemsSync(decodeFfmpeg(song.audio), SAMPLE_RATE));
            b = await chromium.stems(song.audio);
        } catch (error) {
            failed += 1;
            console.log(`FAIL ${song.name.slice(0, 50)}: ${String(error?.message ?? error).slice(0, 120)}`);
            continue;
        }
        // the lag that lines the onset curves up best
        let best = { lag: 0, r: -Infinity };
        for (let lag = -MAX_LAG; lag <= MAX_LAG; lag += 1) {
            const r = ["kick", "snare", "hat", "harm"].map((k) => correlation(a[k], b[k], lag)).filter(Number.isFinite);
            const mean = r.reduce((x, y) => x + y, 0) / Math.max(1, r.length);
            if (mean > best.r) best = { lag, r: mean };
        }
        const line = [`${song.source.padEnd(5)} ${song.name.slice(0, 38).padEnd(38)} frames ${a.frames}/${b.frames} lag ${String(best.lag).padStart(2)}`];
        for (const k of [...CURVES, "chroma", "timbre"]) {
            const r = correlation(k === "chroma" || k === "timbre" ? Float32Array.from(a[k]) : a[k], Float32Array.from(b[k]), best.lag, k === "chroma" || k === "timbre" ? 12 : 1);
            all[k].push(r);
            line.push(`${k} ${Number.isFinite(r) ? r.toFixed(3) : "  -  "}`);
        }
        console.log(`${line.join(" | ")} · chromium ${b.ms.toFixed(0)} ms`);
    }
    chromium.close();
    console.log("");
    let pass = true;
    for (const [k, rs] of Object.entries(all)) {
        const ok = rs.filter(Number.isFinite);
        if (!ok.length) continue;
        const mean = ok.reduce((x, y) => x + y, 0) / ok.length;
        const min = Math.min(...ok);
        if (CURVES.includes(k) && mean < GATE) pass = false;
        console.log(`${k.padEnd(9)} correlation mean ${mean.toFixed(3)} min ${min.toFixed(3)} over ${ok.length} songs${CURVES.includes(k) ? (mean >= GATE ? "  ✓" : `  ✗ (gate ${GATE})`) : ""}`);
    }
    if (failed) console.log(`${failed} songs could not be decoded`);
    console.log(pass ? `decoder check passed (every curve's mean ≥ ${GATE})` : `decoder check FAILED (gate ${GATE})`);
    return pass ? 0 : 1;
}

if (options["decoder-check"] && process.versions.electron) {
    const { app } = await import("electron");
    const userData = flag("user-data", path.join(os.tmpdir(), "dan-bench-stems"));
    await mkdir(userData, { recursive: true });
    app.setPath("userData", userData);
    app.whenReady().then(decoderCheck).then((code) => app.exit(code), (error) => {
        console.log(String(error?.stack ?? error));
        app.exit(1);
    });
} else {
    process.exitCode = options["decoder-check"] ? await decoderCheck() : await bench();
}
