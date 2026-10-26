// How well the create tab finds the timing: detectTimingFull against the human red lines of held-out maps,
// single- and multi-BPM. Fits OFFSET_BIAS_MS (src/audio/fineOnset.js): the median gap between the human red lines
// and ours, on maps whose BPM we got right.
// Usage:
//   node tools/eval-timing.mjs "A:/Games/osu!/Songs" data/mapper [--limit N] [--all]
//   npx electron tools/eval-timing.mjs "A:/Games/osu!/Songs" data/mapper --decoder chromium [--limit N] [--user-data DIR]
// --decoder ffmpeg (default) decodes like the dataset tools; chromium decodes like the app (Web Audio, then 22050 Hz
// mono through an OfflineAudioContext) inside a hidden Electron window, with user data in DIR (default: a temp folder).
// Index formats: v1 (data/mapper: { set, osu } + heldout.json of set names) and v2 ({ osuPath, songKey } + heldout.json
// of song keys).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 22050;
const BPM_OK = 0.05;
const OFFSET_OK_MS = 5;
const MIN_HUMAN_SECTION_BEATS = 8;
const SAME_BPM = 0.0005;

// options with a value, flags without one, and the two folders
const VALUED = new Set(["--decoder", "--limit", "--user-data"]);
const options = {};
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (VALUED.has(a)) options[a.slice(2)] = process.argv[++i];
    else if (a.startsWith("--")) options[a.slice(2)] = true;
    else positional.push(a);
}
const flag = (name, fallback = null) => options[name] ?? fallback;
const has = (name) => options[name] === true;
const [songsRoot, dataDir = "data/mapper"] = positional;
const decoder = flag("decoder", "ffmpeg");
const limit = Number(flag("limit", "0"));

const { parseRedTimingPoints } = await import(pathToFileURL(path.join(root, "src/gen/grid.js")).href);
const { OFFSET_BIAS_MS } = await import(pathToFileURL(path.join(root, "src/audio/fineOnset.js")).href);

// The human timing as sections: red lines in 40–400 BPM, repeats of the same BPM merged, sections under 8 beats
// (gimmicks, stops) folded into the one before.
function humanSections(osuText, endMs) {
    const points = parseRedTimingPoints(osuText).map((p) => ({ timeMs: p.time, bpm: 60000 / p.beatLength }))
        .filter((p) => p.bpm >= 40 && p.bpm <= 400 && p.timeMs < endMs);
    const out = [];
    points.forEach((p, i) => {
        const next = points[i + 1]?.timeMs ?? endMs;
        const beats = (next - p.timeMs) / (60000 / p.bpm);
        const last = out.at(-1);
        if (last && (Math.abs(p.bpm / last.bpm - 1) < SAME_BPM || beats < MIN_HUMAN_SECTION_BEATS)) return;
        out.push({ ...p });
    });
    return out;
}

const noteTimes = (osuText) => {
    const at = osuText.indexOf("[HitObjects]");
    return osuText.slice(at).split(/\r?\n/).slice(1).map((l) => Number(l.split(",")[2])).filter(Number.isFinite).sort((a, b) => a - b);
};
const sectionAt = (sections, t) => sections.reduce((cur, s) => (s.timeMs <= t ? s : cur), sections[0]);
// a detected grid against a human red line: the gap (ms, −beat/2 … beat/2), human minus ours
function phaseGap(det, humanTimeMs) {
    const beat = 60000 / det.bpm;
    const d = ((humanTimeMs - det.timeMs) % beat + beat) % beat;
    return d > beat / 2 ? d - beat : d;
}

async function loadJobs() {
    const index = (await readFile(path.join(dataDir, "index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const held = new Set(JSON.parse(await readFile(path.join(dataDir, "heldout.json"), "utf8")));
    const v2 = index.some((m) => m.osuPath);
    const picked = has("all") ? index : index.filter((m) => held.has(v2 ? m.songKey : m.set));
    const byAudio = new Map();
    for (const m of picked) {
        const osuPath = v2 ? m.osuPath : path.join(songsRoot, m.set, m.osu);
        const text = await readFile(osuPath, "utf8").catch(() => null);
        if (!text) continue;
        const audio = /^AudioFilename:\s*(.+)$/m.exec(text)?.[1]?.trim();
        if (!audio) continue;
        const audioPath = v2 && m.audioPath ? m.audioPath : path.join(path.dirname(osuPath), audio);
        if (!byAudio.has(audioPath)) byAudio.set(audioPath, { audioPath, osuPath, text, name: path.basename(path.dirname(osuPath)) });
    }
    const jobs = [...byAudio.values()].sort((a, b) => a.name.localeCompare(b.name));
    return limit > 0 ? jobs.slice(0, limit) : jobs;
}

// One song through the app's own steps: envelope, fine onsets, detectTimingFull (timed), and the old detectTiming.
// The same function runs in the Electron window (chromium) and here (ffmpeg); `modules` are the source file URLs.
const PIPELINE = async (samples, sampleRate, modules) => {
    const { onsetEnvelope, envelopeToTransfer, envelopeFromTransfer } = await import(modules.onset);
    const { fineOnset } = await import(modules.fine);
    const { detectTimingFull } = await import(modules.job);
    const { detectTiming } = await import(modules.tempo);
    const t0 = performance.now();
    const envelope = onsetEnvelope(samples, sampleRate);
    const fine = fineOnset(samples, sampleRate);
    const t1 = performance.now();
    // the worker gets the envelope through a transfer, as in the app
    const timing = detectTimingFull({ envelope: envelopeFromTransfer(envelopeToTransfer(envelope)), fine });
    const t2 = performance.now();
    return { timing, old: detectTiming(envelope), featuresMs: t1 - t0, detectMs: t2 - t1, durationMs: (samples.length / sampleRate) * 1000 };
};
const MODULES = {
    onset: pathToFileURL(path.join(root, "src/audio/onset.js")).href,
    fine: pathToFileURL(path.join(root, "src/audio/fineOnset.js")).href,
    job: pathToFileURL(path.join(root, "src/audio/timingJob.js")).href,
    tempo: pathToFileURL(path.join(root, "src/audio/tempo.js")).href,
};

function ffmpegPath() {
    const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return "ffmpeg";
    return createRequire(import.meta.url)("ffmpeg-static");
}

async function ffmpegRunner() {
    const bin = ffmpegPath();
    return async (audioPath) => {
        const dec = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-i", audioPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
        if (dec.status !== 0 || !dec.stdout?.length) throw new Error(`ffmpeg: ${String(dec.stderr).slice(0, 200)}`);
        const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
        return PIPELINE(samples, SAMPLE_RATE, MODULES);
    };
}

// The page decodes with Web Audio exactly like app/renderer/createTab.js and runs the same pipeline.
// (Electron is ready by now: main() runs from app.whenReady, never from a top-level await, which would hold
// the ready event back.)
async function chromiumRunner() {
    const { app, BrowserWindow } = await import("electron");
    const userData = app.getPath("userData");
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    const page = path.join(userData, "eval-timing.html");
    await writeFile(page, "<!doctype html><meta charset=\"utf-8\"><title>eval-timing</title>");
    await win.loadFile(page);
    const decodeAndRun = `async ({ audioPath, sampleRate, modules }) => {
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
            return await (${PIPELINE.toString()})(mono.getChannelData(0), sampleRate, modules);
        } finally {
            ctx.close();
        }
    }`;
    return {
        run: (audioPath) => win.webContents.executeJavaScript(`(${decodeAndRun})(${JSON.stringify({ audioPath, sampleRate: SAMPLE_RATE, modules: MODULES })})`),
        close: () => win.destroy(),
    };
}

const pct = (a, b) => (b ? `${a}/${b} (${((100 * a) / b).toFixed(0)}%)` : "0/0");
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

async function main() {
    if (!songsRoot) {
        console.log("usage: node tools/eval-timing.mjs <Songs folder> <dataset dir> [--limit N] [--all] [--decoder ffmpeg|chromium]");
        return 2;
    }
    if (decoder === "chromium" && !process.versions.electron) {
        console.log("the chromium decoder runs under Electron: npx electron tools/eval-timing.mjs ...");
        return 2;
    }
    const runner = decoder === "chromium" ? await chromiumRunner() : { run: await ffmpegRunner(), close: () => {} };
    const { run } = runner;
    const jobs = await loadJobs();
    console.log(`decoder ${decoder}, ${jobs.length} songs, OFFSET_BIAS_MS ${OFFSET_BIAS_MS}`);
    const tally = { bpmOld: 0, bpm: 0, maps: 0, offset: 0, offsetOld: 0, withBpm: 0, multi: 0, multiRight: 0, single: 0, falseSplit: 0, failed: 0 };
    const gaps = [];
    const per5min = [];
    for (const job of jobs) {
        let r;
        try {
            r = await run(job.audioPath);
        } catch (error) {
            tally.failed += 1;
            console.log(`FAIL ${job.name}: ${String(error?.message ?? error).slice(0, 120)}`);
            continue;
        }
        const human = humanSections(job.text, r.durationMs);
        if (!human.length) continue;
        tally.maps += 1;
        per5min.push((r.detectMs * 300000) / r.durationMs);
        // the human section that lasts longest decides the BPM and offset scores
        const spans = human.map((s, i) => (human[i + 1]?.timeMs ?? r.durationMs) - s.timeMs);
        const main = human[spans.indexOf(Math.max(...spans))];
        const det = sectionAt(r.timing.sections, main.timeMs + Math.max(...spans) / 2);
        const bpmRight = Math.abs(det.bpm - main.bpm) <= BPM_OK;
        if (Math.abs(r.old.bpm - main.bpm) <= BPM_OK) tally.bpmOld += 1;
        let line = `${job.name.slice(0, 50).padEnd(50)} human ${human.length}×${main.bpm.toFixed(2)} ours ${r.timing.sections.length}×${det.bpm}`;
        if (bpmRight) {
            tally.bpm += 1;
            tally.withBpm += 1;
            const gap = phaseGap(sectionAt(r.timing.sections, main.timeMs), main.timeMs);
            gaps.push(gap);
            if (Math.abs(gap) <= OFFSET_OK_MS) tally.offset += 1;
            const old = { timeMs: r.old.offsetMs, bpm: r.old.bpm };
            if (Math.abs(r.old.bpm - main.bpm) <= BPM_OK && Math.abs(phaseGap(old, main.timeMs)) <= OFFSET_OK_MS) tally.offsetOld += 1;
            line += ` gap ${gap.toFixed(1)} ms (old ${Math.abs(r.old.bpm - main.bpm) <= BPM_OK ? phaseGap(old, main.timeMs).toFixed(1) : "-"})`;
        }
        // only what happens where the map has notes counts: an unmapped outro may change tempo
        const rows = noteTimes(job.text);
        const mapped = r.timing.sections.filter((s, i) => i === 0 || (s.timeMs > rows[0] && s.timeMs < rows.at(-1) - (8 * 60000) / s.bpm));
        if (human.length > 1) {
            tally.multi += 1;
            if (mapped.length === human.length) tally.multiRight += 1;
        } else {
            tally.single += 1;
            if (mapped.length > 1) tally.falseSplit += 1;
        }
        console.log(`${line} · ${r.detectMs.toFixed(0)} ms`);
        if (has("verbose")) console.log(`    human ${JSON.stringify(human.map((h) => [Math.round(h.timeMs), +h.bpm.toFixed(3)]))}
    ours  ${JSON.stringify(r.timing.sections.map((h) => [h.timeMs, h.bpm]))} err ${r.timing.refinedErrMs}`);
    }
    console.log("");
    console.log(`BPM within ${BPM_OK}: ${pct(tally.bpm, tally.maps)} (target 85%); old detectTiming ${pct(tally.bpmOld, tally.maps)}`);
    console.log(`offset within ${OFFSET_OK_MS} ms where the BPM is right: ${pct(tally.offset, tally.withBpm)} (target 70%); old detectTiming ${pct(tally.offsetOld, tally.withBpm)}`);
    console.log(`multi-BPM songs with the right section count: ${pct(tally.multiRight, tally.multi)} (target 80%)`);
    console.log(`false splits on single-BPM songs: ${pct(tally.falseSplit, tally.single)} (target ≤ 2%)`);
    console.log(`detection time per 5-minute song: median ${median(per5min).toFixed(0)} ms, max ${Math.max(...per5min).toFixed(0)} ms (target ≤ 300)`);
    if (tally.failed) console.log(`${tally.failed} songs could not be decoded`);
    const close = gaps.filter((g) => Math.abs(g) <= 40);
    if (close.length) {
        const m = median(close);
        const within = (d) => gaps.filter((g) => Math.abs(g - m) <= d).length;
        console.log(`median gap human − ours (|gap| ≤ 40 ms, n=${close.length}): ${m.toFixed(2)} ms → OFFSET_BIAS_MS ≈ ${(OFFSET_BIAS_MS + m).toFixed(1)}`);
        console.log(`with that bias: within 5 ms ${pct(within(5), gaps.length)}, within 10 ms ${pct(within(10), gaps.length)}, within 20 ms ${pct(within(20), gaps.length)}`);
        // the shift that puts the most red lines within ±5 ms (the gaps cluster tightly, with a long tail)
        let best = { shift: 0, n: -1 };
        for (let shift = -40; shift <= 40; shift += 0.5) {
            const n = gaps.filter((g) => Math.abs(g - shift) <= OFFSET_OK_MS).length;
            if (n > best.n) best = { shift, n };
        }
        console.log(`best shift ${best.shift} ms puts ${pct(best.n, gaps.length)} within ${OFFSET_OK_MS} ms → OFFSET_BIAS_MS ≈ ${OFFSET_BIAS_MS + best.shift}`);
    }
    runner.close?.();
    return 0;
}

if (decoder === "chromium" && process.versions.electron) {
    const { app } = await import("electron");
    const userData = flag("user-data", path.join(os.tmpdir(), "dan-eval-timing"));
    await mkdir(userData, { recursive: true });
    app.setPath("userData", userData);
    app.whenReady().then(main).then((code) => app.exit(code), (error) => {
        console.log(String(error?.stack ?? error));
        app.exit(1);
    });
} else {
    process.exitCode = await main();
}
