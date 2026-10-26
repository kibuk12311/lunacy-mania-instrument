// Asked vs achieved dan: real held-out songs (their audio and their human map's red lines) through each mapper at
// several targets, the way the create tab asks (a range of one whole level, the song's detected parts, candidates
// off). Prints one line per run (asked, achieved, notes per second, chord share, the knob, the dan retry, ms) and a
// table per model; --json writes every run.
// Usage: node tools/eval-dan-range.mjs [--songs A:/SneezeyTrain/eval-v3/heldout-179.json] [--pick 5]
//        [--targets 5,8,11,13,15,17] [--models auto,xgb3,s,m] [--max-sec 100] [--family Jumpstream] [--json out.json]
// Read-only: the songs and their audio are only read.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSong } from "./eval/genRun.mjs";
import { generateLearnedMap } from "../src/gen/generateLearned.js";
import { generateToTarget } from "../src/gen/targeting.js";
import { parseRows } from "../src/gen/mapRows.js";
import { analyzeChart } from "../src/core/analyze.js";
import { numericToLabel } from "../src/core/labels.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const FILES = { auto: "mapper.json", xgb3: "mapper-xgb3.json", s: "mapper-nn2-s.json", m: "mapper-nn2-m.json" };
const songsFile = option("songs", "A:/SneezeyTrain/eval-v3/heldout-179.json");
const targets = option("targets", "5,8,11,13,15,17").split(",").map(Number);
const models = option("models", "auto,xgb3,s,m").split(",");
const maxMs = Number(option("max-sec", "100")) * 1000;
const pickN = Number(option("pick", "5"));
const family = option("family", null);
const only = option("only", null); // comma-separated chart ids
const jsonOut = option("json", null);
const modelDir = option("model-dir", "models");
// --targeting: the 0.9.8 closed loop (src/gen/targeting.js) around the generator, as the app runs it; without it the
// generator alone (the 0.9.7 behaviour, for the before table)
const targeting = args.includes("--targeting");
const budgetMs = Number(option("budget-sec", "30")) * 1000;

// songs that a high dan suits (human dan ≥ 11, one red line, osu! sources), spread over the BPM range
const pool = JSON.parse(await readFile(songsFile, "utf8"))
    .filter((x) => (only ? only.split(",").includes(x.id) : x.dan >= 11 && !x.variable && ["sets", "songs", "hf", "packs"].includes(x.source)))
    .sort((a, b) => a.bpm - b.bpm);
const picks = only ? pool : Array.from({ length: pickN }, (_, k) => pool[Math.min(pool.length - 1, Math.round(((k + 0.5) / pickN) * pool.length * 0.8))]);

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const runs = [];
for (const pick of picks) {
    const song = await loadSong(pick, { wantStems: true });
    const durationMs = Math.min(song.durationMs, maxMs);
    const fam = family ?? song.family;
    console.log(`\n# ${song.title.slice(0, 40)} · ${Math.round(song.bpm)} BPM · human ${pick.dan} ${pick.primary} → ${fam} · ${(durationMs / 1000).toFixed(0)} s`);
    for (const size of models) {
        const model = JSON.parse(await readFile(path.join(modelDir, FILES[size]), "utf8"));
        for (const target of targets) {
            const input = {
                timing: song.timing, envelope: song.envelope, durationMs, ...(song.stems ? { stems: song.stems } : {}),
                request: { range: { lo: target - 0.5, hi: target + 0.5 }, patterns: [{ name: fam, share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 1, snaps: [4] },
                meta: { title: "eval", audioFilename: "a.mp3" },
            };
            const t0 = performance.now();
            const r = targeting
                ? await generateToTarget({ generate: (boost) => generateLearnedMap(input, analyzeChart, model, boost ? { boost } : {}), range: input.request.range, analyze: analyzeChart, budgetMs })
                : await generateLearnedMap(input, analyzeChart, model, {});
            const ms = performance.now() - t0;
            const rows = parseRows(r.osuText, 4);
            const notes = rows.reduce((s, x) => s + popcount(x.mask ?? x.cols.reduce((m, c) => m | (1 << c), 0)), 0);
            const spanS = rows.length > 1 ? (rows.at(-1).t - rows[0].t) / 1000 : 1;
            const chord = rows.filter((x) => (x.cols?.length ?? popcount(x.mask)) >= 2).length / (rows.length || 1);
            const got = r.result?.kind === "ok" ? r.result.numeric : null;
            const run = {
                song: pick.id, bpm: Math.round(song.bpm), model: size, target, got, label: got === null ? "—" : numericToLabel(got).text,
                nps: notes / spanS, chord, knob: r.knob, retry: r.retries?.dan ?? null, ms: Math.round(ms), reachable: r.reachable,
                rung: r.targeting?.rung ?? 0, tries: r.targeting?.attempts?.length ?? 1, grid8: r.grid ? 1 - (r.grid[4] ?? 1) : 0, peakNps: r.stats?.peakNps ?? null,
                maxJack: r.stats?.maxJack?.streamy ?? null, issues: r.issues?.length ?? 0, ...(r.ceiling ? { ceiling: r.ceiling } : {}),
            };
            runs.push(run);
            console.log(`${size.padEnd(5)} ask ${String(target).padStart(4)} got ${got === null ? "  —  " : got.toFixed(1).padStart(5)} ${run.label.padEnd(16)} nps ${run.nps.toFixed(1).padStart(5)} chord ${(chord * 100).toFixed(0).padStart(3)}% knob ${Number(r.knob).toFixed(2)} ${run.retry ?? ""}${targeting ? ` rung ${run.rung}/${run.tries} off¼ ${(run.grid8 * 100).toFixed(0)}%` : ""}${r.ceiling ? ` ceiling ${r.ceiling.numeric} rate ${r.ceiling.rate ?? "—"}` : ""} ${(ms / 1000).toFixed(1)}s`);
        }
    }
}

// per model: mean achieved per target, how many in range
console.log("\nmodel  " + targets.map((t) => `ask ${t}`.padStart(9)).join(""));
for (const size of models) {
    const cells = targets.map((t) => {
        const xs = runs.filter((r) => r.model === size && r.target === t && r.got !== null);
        const mean = xs.reduce((s, r) => s + r.got, 0) / (xs.length || 1);
        const hit = xs.filter((r) => r.got >= t - 0.5 && r.got < t + 0.5).length;
        return `${mean.toFixed(1)} ${hit}/${xs.length}`.padStart(9);
    });
    console.log(size.padEnd(7) + cells.join(""));
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(runs, null, 1));
