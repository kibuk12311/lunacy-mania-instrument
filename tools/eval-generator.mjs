// Compare generated maps with the human maps of held-out songs (same dan, the human timing, all its red lines).
// Usage: node tools/eval-generator.mjs "A:/Games/osu!/Songs" data/mapper [count] [--model models/mapper.json] [--rules]
//        [--single] (only single-BPM maps, as before v3) [--target] (ask for the exact label, not a range)
// Index formats: v1 (data/mapper: { set, osu, dan, primary } + heldout.json of set names) and v2 ({ osuPath,
// audioPath, songKey, danOurs } + heldout.json of song keys).
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { onsetEnvelope } from "../src/audio/onset.js";
import { parseRedTimingPoints, timingFromPoints, slotsForTiming } from "../src/gen/grid.js";
import { parseRows } from "../src/gen/mapRows.js";
import { generateMap } from "../src/gen/generate.js";
import { generateLearnedMap } from "../src/gen/generateLearned.js";
import { onsetF1, densityCorr, jackLoopRate, violationsPer1000, patternAccuracy } from "../src/gen/metrics.js";
import { analyzeChart } from "../src/core/analyze.js";
import { numericToLabel } from "../src/core/labels.js";
import { NAME_FAMILY } from "../src/gen/search.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--model"));
const [songsRoot, dataDir = "data/mapper", countArg = "12"] = positional;
const withRules = args.includes("--rules");
const singleOnly = args.includes("--single");
const strictTarget = args.includes("--target");
const index = (await readFile(path.join(dataDir, "index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const held = new Set(JSON.parse(await readFile(path.join(dataDir, "heldout.json"), "utf8")));
const model = JSON.parse(await readFile(option("model", "models/mapper.json"), "utf8"));
const v2 = index.some((m) => m.osuPath);

// the human map's main pattern → the family asked for (the generator's own table)
const FAMILY = NAME_FAMILY;

// held-out maps spread over the dan range, any number of red lines
const candidates = [];
for (const m of index.filter((x) => held.has(v2 ? x.songKey : x.set))) {
    const dan = v2 ? m.danOurs : m.dan;
    if (!(dan >= 3 && dan <= 17)) continue;
    const osuPath = v2 ? m.osuPath : path.join(songsRoot, m.set, m.osu);
    const text = await readFile(osuPath, "utf8").catch(() => null);
    const red = text ? parseRedTimingPoints(text).length : 0;
    if (red && (!singleOnly || red === 1)) candidates.push({ ...m, dan, osuPath, text });
}
candidates.sort((a, b) => a.dan - b.dan);
const step = Math.max(1, Math.floor(candidates.length / Number(countArg)));
const picks = candidates.filter((_, i) => i % step === 0).slice(0, Number(countArg));

const rowTimes = (osuText) => parseRows(osuText, 4).map((r) => r.t);
const engines = [["learned", (i, opts) => generateLearnedMap(i, analyzeChart, model, opts)]];
if (withRules) engines.unshift(["rule", (i, opts) => generateMap(i, analyzeChart, opts)]);
const totals = Object.fromEntries(engines.map(([name]) => [name, { f1: 0, corr: 0, hit: 0, pattern: 0, viol: 0, loops: 0, jack: 0, ms: [] }]));
let humanLoops = 0;
for (const m of picks) {
    const audioName = /^AudioFilename:\s*(.+)$/m.exec(m.text)[1].trim();
    const audioPath = v2 && m.audioPath ? m.audioPath : path.join(path.dirname(m.osuPath), audioName);
    const dec = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", audioPath, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
    if (dec.status !== 0) continue;
    const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
    const envelope = onsetEnvelope(samples, 22050);
    const points = parseRedTimingPoints(m.text).filter((p) => 60000 / p.beatLength >= 40 && 60000 / p.beatLength <= 400);
    // a red line before 0 moves forward by whole beats, so the grid keeps its phase
    const timing = timingFromPoints(points.map((p) => ({ ...p, time: p.time < 0 ? p.time + Math.ceil(-p.time / p.beatLength) * p.beatLength : p.time })));
    const human = rowTimes(m.text);
    humanLoops += jackLoopRate(parseRows(m.text, 4));
    const durationMs = Math.min(samples.length / 22.05, human.at(-1) + 1500);
    const family = FAMILY[m.primary] ?? "Jumpstream";
    // the human map's own dan, as a range of one step either side
    const range = { lo: m.dan - 0.5, hi: m.dan + 0.5 };
    const input = { timing, envelope, durationMs,
        request: { ...(strictTarget ? { target: m.dan } : { range }), patterns: [{ name: family, share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 1 },
        meta: { title: "eval", audioFilename: "a.mp3" } };
    const bpm = timing.bpm;
    const line = [`${numericToLabel(m.dan).text.padEnd(16)} ${String(m.primary ?? "").padEnd(11)} ${Math.round(bpm)}bpm ×${points.length}`];
    for (const [name, gen] of engines) {
        const t0 = Date.now();
        const r = await gen(input, {});
        const ms = Date.now() - t0;
        const g = rowTimes(r.osuText);
        const rows = parseRows(r.osuText, 4).map((x) => ({ ...x, family }));
        const slots = slotsForTiming(timing, durationMs);
        const t = totals[name];
        const f1 = onsetF1(g, human);
        const corr = densityCorr(g, human, durationMs, (60000 / bpm) * 8);
        t.f1 += f1;
        t.corr += corr;
        t.hit += r.reachable ? 1 : 0;
        t.pattern += patternAccuracy(r.result?.top3, [family]);
        t.viol += violationsPer1000(rows, slots);
        t.loops += jackLoopRate(rows);
        t.jack = Math.max(t.jack, r.stats?.maxJack?.streamy ?? 0);
        t.ms.push(ms);
        line.push(`${name}: F1 ${f1.toFixed(2)} corr ${corr.toFixed(2)} ${r.reachable ? "✓" : "✗"} ${r.result?.numeric}${r.retries?.dan ? ` (${r.retries.dan}, knob ${r.knob?.toFixed?.(2)})` : ""} ${(ms / 1000).toFixed(1)}s`);
    }
    console.log(line.join(" | "));
}
const n = picks.length || 1;
for (const [name, t] of Object.entries(totals)) {
    const sorted = [...t.ms].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0;
    console.log(`${name.padEnd(8)} F1 ${(t.f1 / n).toFixed(3)} · density corr ${(t.corr / n).toFixed(3)} · in range ${t.hit}/${picks.length} · pattern ${(t.pattern / n).toFixed(3)} · violations/1000 ${(t.viol / n).toFixed(1)} · jack loops ${(t.loops / n).toFixed(3)} (human ${(humanLoops / n).toFixed(3)}) · max streamy jack ${t.jack} · p95 ${(p95 / 1000).toFixed(1)} s`);
}
