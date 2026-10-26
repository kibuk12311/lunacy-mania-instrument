// How well detectParts finds song parts: its boundaries against the bars where a human map's density jumps
// (F-measure, a hit within ±2 bars), on held-out maps, for several part costs (λ).
// Usage: node tools/eval-parts.mjs "A:/Games/osu!/Songs" data/mapper [count=50] [--lambda 0.3,0.6,1.2]
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { onsetEnvelope } from "../src/audio/onset.js";
import { parseRedTimingPoints, timingFromPoints, slotsForTiming } from "../src/gen/grid.js";
import { parseRows } from "../src/gen/mapRows.js";
import { barsOf, detectParts } from "../src/gen/songParts.js";

const TOLERANCE_BARS = 2;
const JUMP_RATIO = 1.6; // density over the 4 bars after a line against the 4 before it
const JUMP_BARS = 4;

const args = process.argv.slice(2);
const lambdaArg = args.includes("--lambda") ? args[args.indexOf("--lambda") + 1] : "0.3,0.6,1.2";
const lambdas = lambdaArg.split(",").map(Number);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--lambda");
const [songsRoot, dataDir = "data/mapper", countArg = "50"] = positional;
const index = (await readFile(path.join(dataDir, "index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const held = new Set(JSON.parse(await readFile(path.join(dataDir, "heldout.json"), "utf8")));
const v2 = index.some((m) => m.osuPath);

// Bars where the human density jumps: notes over the next 4 bars vs the 4 before, either way, the biggest jump
// within 4 bars kept.
function humanJumps(rows, bars) {
    const perBar = bars.map((b) => rows.filter((r) => r.t >= b.startMs && r.t < b.endMs).length);
    const score = perBar.map((_, k) => {
        if (k < JUMP_BARS || k + JUMP_BARS > perBar.length) return 0;
        const before = perBar.slice(k - JUMP_BARS, k).reduce((a, b) => a + b, 0) + 1;
        const after = perBar.slice(k, k + JUMP_BARS).reduce((a, b) => a + b, 0) + 1;
        const ratio = Math.max(before / after, after / before);
        return ratio >= JUMP_RATIO ? ratio : 0;
    });
    return score.map((s, k) => (s > 0 && score.slice(Math.max(0, k - JUMP_BARS), k + JUMP_BARS + 1).every((x) => x <= s) ? k : -1)).filter((k) => k >= 0);
}

function fMeasure(found, truth) {
    if (!found.length && !truth.length) return 1;
    const used = new Set();
    let hit = 0;
    for (const f of found) {
        const t = truth.find((x) => !used.has(x) && Math.abs(x - f) <= TOLERANCE_BARS);
        if (t !== undefined) {
            used.add(t);
            hit += 1;
        }
    }
    return (2 * hit) / (found.length + truth.length);
}

const seen = new Set();
const picks = [];
for (const m of index.filter((x) => held.has(v2 ? x.songKey : x.set))) {
    if (picks.length >= Number(countArg)) break;
    const osuPath = v2 ? m.osuPath : path.join(songsRoot, m.set, m.osu);
    const text = await readFile(osuPath, "utf8").catch(() => null);
    if (!text) continue;
    const audio = /^AudioFilename:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const audioPath = v2 && m.audioPath ? m.audioPath : path.join(path.dirname(osuPath), audio ?? "");
    if (!audio || seen.has(audioPath)) continue;
    seen.add(audioPath);
    picks.push({ text, audioPath, name: path.basename(path.dirname(osuPath)) });
}

const totals = new Map(lambdas.map((l) => [l, 0]));
const counts = new Map(lambdas.map((l) => [l, 0]));
for (const p of picks) {
    const dec = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", p.audioPath, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
    if (dec.status !== 0) continue;
    const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
    const envelope = onsetEnvelope(samples, 22050);
    const rows = parseRows(p.text, 4);
    if (!rows.length) continue;
    const timing = timingFromPoints(parseRedTimingPoints(p.text).filter((x) => 60000 / x.beatLength >= 40 && 60000 / x.beatLength <= 400).map((x) => ({ ...x, time: x.time < 0 ? x.time + Math.ceil(-x.time / x.beatLength) * x.beatLength : x.time })));
    if (!timing.sections.length) continue;
    const slots = slotsForTiming(timing, rows.at(-1).t + 1000);
    const bars = barsOf(slots);
    const truth = humanJumps(rows, bars);
    const barAt = (ms) => bars.findIndex((b) => ms >= b.startMs && ms < b.endMs);
    const line = [`${p.name.slice(0, 44).padEnd(44)} jumps ${String(truth.length).padStart(2)}`];
    for (const lambda of lambdas) {
        const parts = detectParts(envelope, slots, { lambda });
        const found = parts.slice(1).map((x) => barAt(x.startMs)).filter((k) => k >= 0);
        const f = fMeasure(found, truth);
        totals.set(lambda, totals.get(lambda) + f);
        counts.set(lambda, counts.get(lambda) + 1);
        line.push(`λ${lambda}: ${parts.length} parts F ${f.toFixed(2)} (${parts.map((x) => x.kind[0]).join("")})`);
    }
    console.log(line.join(" | "));
}
for (const lambda of lambdas) console.log(`λ = ${lambda}: mean F ${(totals.get(lambda) / Math.max(1, counts.get(lambda))).toFixed(3)} over ${counts.get(lambda)} songs`);
