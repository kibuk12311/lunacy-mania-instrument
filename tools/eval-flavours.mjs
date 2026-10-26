// Flavour (sub-pattern) eval: for each flavour, maps of its family with that one flavour chosen, against the same
// family without flavours (the baseline), checked by the LeoBlack pattern finder and by our detector.
// Usage: node tools/eval-flavours.mjs [--songs "A:/Games/osu!/Songs" --data data/mapper] [--count 5] [--seeds 1]
//        [--engine learned|rules|both] [--model models/mapper.json] [--only Rolls,Trills] [--json out.json]
//        node tools/eval-flavours.mjs --merge a.json b.json …   (one table from several runs)
// Songs: with --songs and --data, `count` held-out songs (heldout.json of index.jsonl v1: { set, osu, dan, primary }):
// one red line, 150–210 BPM, 80–200 s, spread over the BPM range; their audio and timing are read, nothing is
// written there. Without them, the synthetic fixture songs (tests/fixtures). Runs per flavour and engine: songs × 2
// dans × seeds (held-out: 5 × 2 × 1 = 10).
// Per flavour and engine: the finder's top-3 names (how often each shows), how often the flavour is its top-1 and
// top-1/2 (the finder's name for finder-named flavours, else our detector's rank among all 21), our coverage (the
// share of the map's rows in its motif) against the baseline, dan in range (and the baseline's), and the guard's
// awkward spots (jack / fast jack / anchor / hand) per 1000 rows. Target: top-1/2 in ≥70% of runs and coverage ≥1.5×
// the baseline.
// What the table does not show (printed under it as notes): Speedjacks (dans 4–5), Coordination and JackyStream
// (2–3) run below their families' dans (FLAVOUR_DANS), so their "in range" and coverage say nothing about the family's
// usual dans; the spots are counted on single-family, single-flavour maps only (the flavour's limits on every row),
// so a flavour next to another family is not measured; and a flavour the finder reads as another family (Speedjacks
// as Stream) leaves its family's score near zero.
import { readFile, writeFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { onsetEnvelope } from "../src/audio/onset.js";
import { generateLearnedMap } from "../src/gen/generateLearned.js";
import { generateMap } from "../src/gen/generate.js";
import { analyzeChart } from "../src/core/analyze.js";
import { parseRows } from "../src/gen/mapRows.js";
import { parseRedTimingPoints, timingFromPoints, slotsForTiming } from "../src/gen/grid.js";
import { findIssues } from "../src/gen/playability.js";
import { FLAVOUR_FAMILY, FINDER_NAME, FLAVOUR_IDS } from "../src/gen/flavours.js";
import { flavourShares } from "../src/gen/flavourMetrics.js";
import { patternScore, FAMILY_TIEBREAK } from "../src/gen/search.js";
import { clickTrack } from "../tests/fixtures/clickTrack.js";
import { dropSong } from "../tests/fixtures/dropSong.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const pct = (x) => (x === null || x === undefined ? "  — " : `${Math.round(x * 100)}%`.padStart(4));
const TARGET_HIT = 0.7;
const TARGET_RATIO = 1.5;
// dans each family reaches without flavours (the analyser tops a 1/4 stream out near dan 5 at these tempos)
const DANS = { Stream: [3, 4], Jumpstream: [4, 5], Handstream: [6, 8], Chordjack: [8, 11], Jack: [5, 8], Tech: [5, 7] };
// flavours of single notes only top out lower than their family (a single-note jack or tech line is a stream's density)
const FLAVOUR_DANS = { Speedjacks: [4, 5], Coordination: [2, 3], JackyStream: [2, 3] };
// a family score under this is "near zero" in the notes
const LOW_FAMILY_SCORE = 0.1;

// ---- the table (also for --merge) ----
function summarize(runs) {
    const groups = new Map();
    for (const r of runs) {
        const key = `${r.flavour}|${r.engine}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const rows = [];
    for (const [key, list] of groups) {
        const [id, engine] = key.split("|");
        const n = list.length;
        const name = FINDER_NAME[id] ?? null;
        const mean = (f) => list.reduce((a, r) => a + f(r), 0) / n;
        const names = new Map();
        for (const r of list) for (const p of r.top3) names.set(p.name, (names.get(p.name) ?? 0) + 1);
        const finderTop1 = name ? mean((r) => (r.top3[0]?.name === name ? 1 : 0)) : null;
        const finderTop2 = name ? mean((r) => (r.top3.slice(0, 2).some((p) => p.name === name) ? 1 : 0)) : null;
        const oursTop1 = mean((r) => (r.oursRank === 0 ? 1 : 0));
        const oursTop2 = mean((r) => (r.oursRank >= 0 && r.oursRank < 2 ? 1 : 0));
        const coverage = mean((r) => r.cover);
        const baseline = mean((r) => r.baseCover);
        const rowsN = list.reduce((a, r) => a + r.rows, 0);
        const baseRowsN = list.reduce((a, r) => a + r.baseRows, 0);
        const hit = name ? finderTop2 : oursTop2;
        const ratio = baseline > 0 ? coverage / baseline : coverage > 0 ? Infinity : 0;
        rows.push({
            id, engine, family: FLAVOUR_FAMILY[id], finder: name, runs: n,
            finderTop1, finderTop2, oursTop1, oursTop2, hit, coverage, baseline, ratio,
            inRange: mean((r) => (r.inRange ? 1 : 0)), baseInRange: mean((r) => (r.baseInRange ? 1 : 0)),
            // the finder's share of the flavour's family: what the family score of a family+flavour request gets
            familyScore: mean((r) => patternScore(r.top3, [FLAVOUR_FAMILY[id]])),
            spots: (1000 * list.reduce((a, r) => a + r.issues, 0)) / Math.max(1, rowsN),
            baseSpots: (1000 * list.reduce((a, r) => a + r.baseIssues, 0)) / Math.max(1, baseRowsN),
            top3: [...names].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(", "),
            pass: hit >= TARGET_HIT && ratio >= TARGET_RATIO,
        });
    }
    rows.sort((a, b) => FLAVOUR_IDS.indexOf(a.id) - FLAVOUR_IDS.indexOf(b.id) || a.engine.localeCompare(b.engine));
    return rows;
}

function printTable(rows) {
    console.log("flavour          family      engine   runs  finder t1/t2  ours t1/t2  hit   coverage (base, ×)      in range (base)  spots/1000 (base)  pass  finder top-3 names");
    for (const r of rows) {
        const ratio = Number.isFinite(r.ratio) ? `${r.ratio.toFixed(1)}×` : "∞";
        console.log(`${r.id.padEnd(16)} ${r.family.padEnd(11)} ${r.engine.padEnd(8)} ${String(r.runs).padStart(4)}  ${pct(r.finderTop1)} ${pct(r.finderTop2)}   ${pct(r.oursTop1)} ${pct(r.oursTop2)}   ${pct(r.hit)}  ${pct(r.coverage)} (${pct(r.baseline)}, ${ratio.padStart(5)})   ${pct(r.inRange)} (${pct(r.baseInRange)})      ${r.spots.toFixed(1).padStart(5)} (${r.baseSpots.toFixed(1).padStart(5)})      ${r.pass ? "yes " : "NO  "}  ${r.top3}`);
    }
    const passed = rows.filter((r) => r.pass).length;
    console.log(`passed ${passed}/${rows.length}`);
    printNotes(rows);
}

// What the table can't show, said with it.
function printNotes(rows) {
    const range = ([lo, hi]) => `${lo}–${hi}`;
    const lowDans = Object.entries(FLAVOUR_DANS).filter(([id]) => rows.some((r) => r.id === id));
    console.log("notes:");
    if (lowDans.length) {
        console.log(`- dans: ${lowDans.map(([id, d]) => `${id} ${range(d)} (${FLAVOUR_FAMILY[id]} ${range(DANS[FLAVOUR_FAMILY[id]])})`).join(", ")} `
            + "run below their family's dans (unless --dans): their in range and coverage say nothing about the family's usual dans");
    }
    console.log("- spots/1000: single-family, single-flavour maps only, the flavour's limits stamped on every row; a flavour next to "
        + "another family (Longjacks beside a stream) is not measured here");
    for (const r of rows) {
        // the finder has no Tech cluster (the searches count the analyser's Tech flag for it instead)
        if (r.family === "Tech" || !(r.familyScore < LOW_FAMILY_SCORE)) continue;
        console.log(`- ${r.id} ${r.engine}: the finder gives the ${r.family} family ${pct(r.familyScore).trim()} of these maps (top-3 names: ${r.top3}), `
            + `so a ${r.family}+${r.id} request's family score is near zero (it only weighs ${FAMILY_TIEBREAK}× in the ranking, as the tie-break)`);
    }
}

if (args.includes("--merge")) {
    const files = args.filter((a) => a !== "--merge" && !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--json");
    const runs = [];
    for (const f of files) runs.push(...JSON.parse(await readFile(f, "utf8")).runs);
    const rows = summarize(runs);
    printTable(rows);
    const out = option("json", null);
    if (out) await writeFile(out, JSON.stringify({ table: rows }, null, 1));
    process.exit(0);
}

const engineArg = option("engine", "both");
const engines = engineArg === "both" ? ["learned", "rules"] : [engineArg];
const only = option("only", null)?.split(",") ?? FLAVOUR_IDS;
const model = engines.includes("learned") ? JSON.parse(await readFile(option("model", "models/mapper.json"), "utf8")) : null;
const songsRoot = option("songs", null);
const dataDir = option("data", null);
const heldOut = Boolean(songsRoot && dataDir);
const seeds = Number(option("seeds", heldOut ? "1" : "3"));

// ---- the songs ----
let ffmpeg = "ffmpeg";
try {
    ffmpeg = (await import("ffmpeg-static")).default ?? ffmpeg;
} catch {
    // the one on PATH
}

async function heldOutSongs(count) {
    const index = (await readFile(path.join(dataDir, "index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const held = new Set(JSON.parse(await readFile(path.join(dataDir, "heldout.json"), "utf8")));
    const found = [];
    const seen = new Set();
    for (const m of index.filter((x) => held.has(x.set))) {
        if (seen.has(m.set) || !(m.bpm >= 150 && m.bpm <= 210)) continue;
        const osuPath = path.join(songsRoot, m.set, m.osu);
        const text = await readFile(osuPath, "utf8").catch(() => null);
        if (!text) continue;
        const red = parseRedTimingPoints(text);
        if (red.length !== 1) continue;
        const audioName = /^AudioFilename:\s*(.+)$/m.exec(text)?.[1]?.trim();
        const audioPath = audioName ? path.join(songsRoot, m.set, audioName) : null;
        if (!audioPath || !(await stat(audioPath).then(() => true, () => false))) continue;
        const lastMs = parseRows(text, 4).at(-1)?.t ?? 0;
        if (lastMs < 80000 || lastMs > 200000) continue;
        seen.add(m.set);
        found.push({ set: m.set, bpm: m.bpm, text, audioPath, lastMs });
    }
    found.sort((a, b) => a.bpm - b.bpm);
    const step = found.length / count;
    const picks = Array.from({ length: Math.min(count, found.length) }, (_, k) => found[Math.floor(k * step + step / 2)]);
    const out = [];
    for (const m of picks) {
        const dec = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", m.audioPath, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
        if (dec.status !== 0) continue;
        const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
        const p = parseRedTimingPoints(m.text)[0];
        const time = p.time < 0 ? p.time + Math.ceil(-p.time / p.beatLength) * p.beatLength : p.time;
        out.push({
            name: m.set.replace(/^\d+\s+/, "").slice(0, 28), timing: timingFromPoints([{ ...p, time }]),
            durationMs: Math.min(samples.length / 22.05, m.lastMs + 1500), envelope: onsetEnvelope(samples, 22050),
        });
    }
    return out;
}

const SONGS = heldOut ? await heldOutSongs(Number(option("count", "5"))) : [
    // synthetic songs (the fixtures' generators): 190 BPM clicks on every 1/4, and 180 BPM with a quiet middle part
    { name: "click190", timing: { bpm: 190, offsetMs: 500 }, durationMs: 100000, envelope: onsetEnvelope(clickTrack({ bpm: 190, offsetMs: 500, seconds: 100, div: 4 }).samples, 22050) },
    { name: "drop180", timing: { bpm: 180, offsetMs: 300 }, durationMs: 90000, envelope: onsetEnvelope(dropSong({}), 22050) },
];
console.log(`songs: ${SONGS.map((s) => `${s.name} (${Math.round(s.timing.bpm)} BPM, ${Math.round(s.durationMs / 1000)} s)`).join(" · ")}`);

const dansOf = (id) => (option("dans", null) ? option("dans").split(",").map(Number) : FLAVOUR_DANS[id] ?? DANS[FLAVOUR_FAMILY[id]]);

const BAD = new Set(["jack", "fastJack", "anchor", "hand"]);
async function one(engine, song, patterns, dan, seed) {
    const input = {
        timing: song.timing, envelope: song.envelope, durationMs: song.durationMs,
        request: { range: { lo: dan - 0.5, hi: dan + 0.5 }, target: dan, patterns, mix: "sections", stamina: 0.5, burst: 0.3, seed },
        meta: { title: "eval", audioFilename: "a.mp3" },
    };
    const out = engine === "rules" ? await generateMap(input, analyzeChart) : await generateLearnedMap(input, analyzeChart, model);
    const rows = parseRows(out.osuText, 4);
    const slots = slotsForTiming(song.timing, song.durationMs);
    const family = patterns[0].name;
    const flavour = patterns[0].flavours?.[0];
    const issues = findIssues(rows.map((r) => ({ ...r, family, ...(flavour ? { flavour } : {}) })), slots).filter((x) => BAD.has(x.kind));
    const numeric = out.result?.numeric;
    const inRange = Number.isFinite(numeric) && numeric >= dan - 0.5 && numeric < dan + 0.5;
    return { top3: out.result?.top3 ?? [], ours: flavourShares(rows), inRange, numeric, issues: issues.length, rows: rows.length };
}

const runs = [];
const baselines = new Map();
const t0 = Date.now();
for (const engine of engines) {
    for (const id of only) {
        const family = FLAVOUR_FAMILY[id];
        const t1 = Date.now();
        for (const song of SONGS) {
            for (const dan of dansOf(id)) {
                for (let s = 1; s <= seeds; s += 1) {
                    const seed = 1000 * s + dan;
                    const key = `${engine}|${family}|${song.name}|${dan}|${seed}`;
                    if (!baselines.has(key)) baselines.set(key, await one(engine, song, [{ name: family, share: 1 }], dan, seed));
                    const base = baselines.get(key);
                    const r = await one(engine, song, [{ name: family, share: 1, flavours: [id] }], dan, seed);
                    runs.push({
                        flavour: id, engine, song: song.name, dan, seed, numeric: r.numeric, baseNumeric: base.numeric,
                        top3: r.top3.map((p) => ({ name: p.name, share: Math.round(p.share * 1000) / 1000 })),
                        oursRank: r.ours.findIndex((x) => x.id === id && x.share > 0), cover: r.ours.find((x) => x.id === id)?.share ?? 0,
                        baseCover: base.ours.find((x) => x.id === id)?.share ?? 0, inRange: r.inRange, baseInRange: base.inRange,
                        issues: r.issues, rows: r.rows, baseIssues: base.issues, baseRows: base.rows,
                    });
                }
            }
        }
        const [row] = summarize(runs.filter((r) => r.flavour === id && r.engine === engine));
        console.log(`${id.padEnd(16)} ${engine.padEnd(8)} hit ${pct(row.hit)} · coverage ${pct(row.coverage)} (base ${pct(row.baseline)}) · in range ${pct(row.inRange)} (base ${pct(row.baseInRange)}) · ${Math.round((Date.now() - t1) / 1000)} s`);
    }
}
const table = summarize(runs);
printTable(table);
console.log(`${Math.round((Date.now() - t0) / 1000)} s`);
const out = option("json", null);
if (out) await writeFile(out, JSON.stringify({ songs: SONGS.map((s) => s.name), engines, seeds, runs, table }, null, 1));
