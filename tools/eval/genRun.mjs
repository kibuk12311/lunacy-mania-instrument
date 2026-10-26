// One song through the current v3 generator, the way the evaluation tools need it (compare-mappers, blind-pack,
// bench-gen): decode the audio with ffmpeg (22,050 Hz mono, as the dataset tools do), the onset envelope, the human
// map's own red lines as the timing, the request in the strict (target) or the range form, and the §7 metrics of
// the answer against the human map. Wave-3 inputs (candidates, critic, repeats, style, stems) are passed where the
// addendum puts them (§1.1); whether the generator used them is read from its answer (compare.mjs optionStatus).
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { parseRedTimingPoints, timingFromPoints, slotsForTiming, sectionsToPoints, timingSections, beatsFromTiming } from "../../src/gen/grid.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { generateMap } from "../../src/gen/generate.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { onsetF1, densityCorr, jackLoopRate, violationsPer1000, patternAccuracy } from "../../src/gen/metrics.js";
import { findIssues } from "../../src/gen/playability.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { familyOf, TRILL_NAMES, beatGridStats, divisorF1, repeatGap, requestExtras, phaseTimer, SNAP_VARIANTS } from "./compare.mjs";
import { isOsuSource } from "./heldout.mjs";

export const SAMPLE_RATE = 22050;
const ALL_SNAPS = [4, 3, 6, 8];
const OFF_QUARTER_SONG = 0.1; // plan D5: a "triplet song" has ≥ 10% of its beats off the 1/4 grid
const INFILL_PARTS = 8;
const SEAM_BEATS = 2;

export async function decodeAudio(audioPath, { ffmpeg = "ffmpeg" } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", audioPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"]);
        const chunks = [];
        let err = "";
        p.stdout.on("data", (c) => chunks.push(c));
        p.stderr.on("data", (c) => { err += c; });
        p.on("error", reject);
        p.on("close", (code) => {
            if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`));
            const buf = Buffer.concat(chunks);
            const out = new Float32Array(Math.floor(buf.length / 4));
            Buffer.from(out.buffer).set(buf.subarray(0, out.length * 4));
            resolve(out);
        });
    });
}

const metaLine = (text, key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";

// The human map's red lines (40–400 BPM) as Timing; a red line before 0 moves forward by whole beats.
export function timingOfChart(text) {
    const points = parseRedTimingPoints(text).filter((p) => 60000 / p.beatLength >= 40 && 60000 / p.beatLength <= 400);
    if (!points.length) throw new Error("no usable red line");
    return timingFromPoints(points.map((p) => ({ ...p, time: p.time < 0 ? p.time + Math.ceil(-p.time / p.beatLength) * p.beatLength : p.time })));
}

// Optional stems (stream S): src/audio/stems.js exporting a compute function. Null when the module or the function
// is not there yet; the tools then report repeats/stems as not available.
let stemsModule;
export async function stemsComputer() {
    if (stemsModule === undefined) {
        stemsModule = await import("../../src/audio/stems.js").catch(() => null);
    }
    const fn = stemsModule && (stemsModule.computeStems ?? stemsModule.stemsOf ?? stemsModule.lightStems);
    return typeof fn === "function" ? fn : null;
}

// Stems are decoded only when a run can use them: repeats asked for, or a model that needs them (§2.8 needs).
export async function wantsStems(engines, cfgOf) {
    for (const e of engines) {
        if (cfgOf(e.label).repeats) return true;
        if (e.kind === "model" && (await loadModelFile(e.path)).needs?.includes("stems")) return true;
    }
    return false;
}

// pick: { osuPath, audioPath?|audio?, dan, primary?, family?, source? } → everything a run needs.
export async function loadSong(pick, { ffmpeg = "ffmpeg", wantStems = false } = {}) {
    const text = await readFile(pick.osuPath, "utf8");
    const audioPath = pick.audioPath ?? pick.audio ?? path.join(path.dirname(pick.osuPath), metaLine(text, "AudioFilename"));
    const samples = await decodeAudio(audioPath, { ffmpeg });
    const envelope = onsetEnvelope(samples, SAMPLE_RATE);
    let stems = null;
    if (wantStems) {
        const compute = await stemsComputer();
        if (compute) stems = await compute(samples, SAMPLE_RATE);
    }
    return songFromText(pick, text, { envelope, stems, audioPath, audioMs: samples.length / (SAMPLE_RATE / 1000) });
}

// The same from the chart text alone (the envelope and stems come from the audio; tests pass their own).
export function songFromText(pick, text, { envelope = null, stems = null, audioPath = null, audioMs = Infinity } = {}) {
    const timing = timingOfChart(text);
    const humanRows = parseRows(text, 4);
    if (humanRows.length < 2) throw new Error("the human map has no rows");
    const durationMs = Math.min(audioMs, humanRows.at(-1).t + 1500);
    const beats = beatsFromTiming(sectionsToPoints(timingSections(timing)), durationMs);
    const human = beatGridStats(humanRows, beats);
    const family = pick.family ?? familyOf(pick.primary);
    const source = pick.source ?? "songs";
    return {
        pick, text, audioPath, audioName: audioPath ? path.basename(audioPath) : metaLine(text, "AudioFilename"), envelope, stems, timing,
        durationMs, beats, human, family, source, dan: pick.dan, bpm: timing.bpm, red: timing.sections.length,
        title: metaLine(text, "Title") || "song", artist: metaLine(text, "Artist") || "Unknown",
        humanRows, humanTimes: humanRows.map((r) => r.t), humanJackLoop: jackLoopRate(humanRows),
        slotsQ4: slotsForTiming(timing, durationMs),
        tags: {
            osu: isOsuSource(source), trills: TRILL_NAMES.has(pick.primary), variable: new Set(timing.sections.map((s) => Math.round(s.bpm * 100))).size > 1,
            humanOffQuarter: human.offQuarter,
        },
    };
}

// Snap variant → request.snaps: q4 = [4], all = [4, 3, 6, 8], auto = all on songs whose human map has ≥ 10% of
// its beats off the 1/4 grid, q4 elsewhere (plan D5).
export function snapsOf(variant, song) {
    if (variant === "auto") return song.human.offQuarter >= OFF_QUARTER_SONG ? ALL_SNAPS : [4];
    const s = SNAP_VARIANTS[variant];
    if (!s) throw new Error(`unknown snaps variant ${variant}`);
    return s;
}

// Infill mode (§7 nn-v2 row): the song in 8 equal parts, the even ones locked to the human map's rows.
export function infillPlan(song) {
    const n = INFILL_PARTS;
    const len = song.durationMs / n;
    const parts = Array.from({ length: n }, (_, k) => ({ startMs: Math.round(k * len), endMs: k === n - 1 ? song.durationMs : Math.round((k + 1) * len), kind: "part" }));
    const lockedParts = parts.filter((_, k) => k % 2 === 0);
    const inLocked = (t) => lockedParts.some((p) => t >= p.startMs && t < p.endMs);
    const seams = [...new Set(parts.slice(1).map((p) => p.startMs))];
    return {
        parts,
        locked: { rows: song.humanRows.filter((r) => inLocked(r.t)), ranges: lockedParts.map((p) => [p.startMs, p.endMs]), knob: NaN, planSeed: 1 },
        inLocked, seams,
    };
}

// The generator input for one run (the eval-generator request: one family at share 1, sections mix, stamina 0.5,
// burst 0.3), plus the wave-3 fields the config asks for.
export function buildInput(song, { form, seed, snaps, cfg, meta = { title: "eval", audioFilename: "a.mp3" }, infill = null }) {
    const dan = song.dan;
    const request = {
        ...(form === "target" ? { target: dan } : { range: { lo: dan - 0.5, hi: dan + 0.5 } }),
        patterns: [{ name: song.family, share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed, snaps,
        ...requestExtras(cfg),
        ...(infill ? { parts: infill.parts } : {}),
    };
    return {
        timing: song.timing, envelope: song.envelope, durationMs: song.durationMs, request, meta,
        ...(song.stems ? { stems: song.stems } : {}),
        ...(infill ? { locked: { ...infill.locked, planSeed: seed } } : {}),
        deadlineMs: cfg.deadlineMs, personal: null,
    };
}

const modelCache = new Map();
export async function loadModelFile(file) {
    if (!modelCache.has(file)) modelCache.set(file, readFile(file, "utf8").then(JSON.parse));
    return modelCache.get(file);
}

// One generation; engine = { label, kind: "model" | "rules", path? }. Returns { response, ms, phases }.
export async function runEngine(engine, input, { cfg, analyze = analyzeChart } = {}) {
    const critic = cfg?.critic ? await loadModelFile(cfg.critic) : null;
    const model = engine.kind === "rules" ? null : await loadModelFile(engine.path);
    const timer = phaseTimer();
    const opts = { onProgress: (p) => timer.on(p), ...(critic ? { critic } : {}) };
    const t0 = performance.now();
    let response;
    if (engine.kind === "rules") response = await generateMap(input, analyze, opts);
    else response = await generateLearnedMap(input, analyze, model, opts);
    const ms = performance.now() - t0;
    return { response, ms, phases: timer.done() };
}

// §7 metrics of one answer against the song's human map.
export function scoreRun(song, response, { infill = null } = {}) {
    const family = song.family;
    const genRows = parseRows(response.osuText, 4).map((x) => ({ ...x, family }));
    const genTimes = genRows.map((r) => r.t);
    const numeric = response.result?.kind === "ok" ? response.result.numeric : null;
    const gen = beatGridStats(genRows, song.beats);
    const out = {
        numeric, reachable: !!response.reachable, knob: Number.isFinite(response.knob) ? response.knob : null,
        f1: onsetF1(genTimes, song.humanTimes),
        corr: densityCorr(genTimes, song.humanTimes, song.durationMs, (60000 / song.bpm) * 8),
        pattern: patternAccuracy(response.result?.top3, [family]),
        viol: violationsPer1000(genRows, song.slotsQ4),
        jackLoop: jackLoopRate(genRows),
        humanJackLoop: song.humanJackLoop,
        maxStreamyJack: response.stats?.maxJack?.streamy ?? null,
        notes: response.noteCount ?? null, humanRows: song.humanRows.length, rows: genRows.length,
        offQuarterRows: response.grid ? 1 - (response.grid[4] ?? 1) : gen.offQuarter,
        genOffQuarterBeats: gen.offQuarter,
        divF1: divisorF1(song.human.labels, gen.labels),
        repeatGap: response.structure?.repeats ? repeatGap(genRows, song.humanRows, response.structure.repeats) : null,
        retries: response.retries ?? null,
        critic: response.critic ? { kind: response.critic.kind, score: response.critic.score ?? null, picked: response.critic.picked ?? null, of: response.critic.of ?? null } : null,
        structure: !!response.structure,
        f1Free: null, seamIssues: null,
    };
    if (infill) {
        const free = (t) => !infill.inLocked(t);
        out.f1Free = onsetF1(genTimes.filter(free), song.humanTimes.filter(free));
        const beatMs = 60000 / song.bpm;
        out.seamIssues = findIssues(genRows, song.slotsQ4)
            .filter((x) => x.kind !== "columns" && infill.seams.some((s) => Math.abs(x.t - s) <= SEAM_BEATS * beatMs)).length;
    }
    return out;
}
