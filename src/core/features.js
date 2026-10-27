import {
    runSunnyEstimatorFromText,
    runDanielEstimatorFromText,
    runAzusaEstimatorFromText,
    runRoxyEstimatorFromText,
    runMixedEstimatorFromText,
    applyCompanellaToMixedResult,
    classifyCompanellaDifficulty,
    analyzeEtternaFromText,
    calculateInterludeStar,
    analyzePatternFromText,
    OsuFileParser,
} from "./leoblack.js";
import { isRice } from "./rice.js";
import { patternShares } from "./patterns.js";
import { minOf, maxOf } from "../../vendor/leoblack/js/lunacyExtremes.js";

const EST_KEYS = ["sunny", "daniel", "azusa", "roxy", "companella", "mixed"];
// Estimators on the dan scale; Sunny is a star rating and stays out of the spread stats.
const DAN_EST_KEYS = ["daniel", "azusa", "roxy", "companella", "mixed"];
// Variant A of the model leaves out the benchmark-tuned estimators (Azusa, Roxy, Mixed).
const UNTUNED_EST_KEYS = ["daniel", "companella"];
const MSD_KEYS = {
    overall: "Overall",
    stream: "Stream",
    jumpstream: "Jumpstream",
    handstream: "Handstream",
    stamina: "Stamina",
    jackspeed: "JackSpeed",
    chordjack: "Chordjack",
    technical: "Technical",
};

export const FEATURE_NAMES = [
    ...EST_KEYS.map((k) => `est_${k}`),
    ...EST_KEYS.map((k) => `has_${k}`),
    "est_min", "est_max", "est_mean", "est_range",
    "esta_min", "esta_max", "esta_mean", "esta_range",
    ...Object.keys(MSD_KEYS).map((k) => `msd_${k}`),
    "interlude", "note_count", "duration_sec", "bpm", "ln_ratio",
    "pat_share1", "pat_share2", "pat_share3", "pat_mixed_share", "top_cluster_mixed",
];

function finiteOrNull(value) {
    const n = Number(value);
    return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

function trySync(fn) {
    try {
        return fn();
    } catch {
        return null;
    }
}

async function tryAsync(fn) {
    try {
        return await fn();
    } catch {
        return null;
    }
}

function sectionLines(osuText, name) {
    const lines = osuText.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === `[${name}]`);
    if (start < 0) return [];
    const out = [];
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line.startsWith("[")) break;
        if (line && !line.startsWith("//")) out.push(line);
    }
    return out;
}

// Keys, LN share, length and dominant BPM read straight from the .osu text.
export function chartInfo(osuText, rate) {
    const modeLine = sectionLines(osuText, "General").find((l) => l.startsWith("Mode"));
    const mode = modeLine ? Number(modeLine.split(":")[1]) : 0; // osu! defaults to standard when Mode is absent
    const cs = sectionLines(osuText, "Difficulty").find((l) => l.startsWith("CircleSize"));
    const keys = cs ? Math.round(Number(cs.split(":")[1])) : null;

    const objects = sectionLines(osuText, "HitObjects").map((l) => l.split(","));
    const times = objects.map((p) => Number(p[2])).filter(Number.isFinite);
    const lnCount = objects.filter((p) => (Number(p[3]) & 128) !== 0).length;
    const first = times.length ? minOf(times) : 0;
    const last = times.length ? maxOf(times) : 0;

    const points = sectionLines(osuText, "TimingPoints")
        .map((l) => l.split(","))
        .map((p) => ({ time: Number(p[0]), beat: Number(p[1]), uninherited: p[6] === undefined || p[6] === "1" }))
        .filter((p) => p.uninherited && p.beat > 0)
        .sort((a, b) => a.time - b.time);
    const weightByBeat = new Map();
    points.forEach((p, i) => {
        const from = Math.max(p.time, first);
        const to = i + 1 < points.length ? Math.min(points[i + 1].time, last) : last;
        const span = Math.max(0, to - from) + (i === 0 ? 1e-6 : 0);
        weightByBeat.set(p.beat, (weightByBeat.get(p.beat) ?? 0) + span);
    });
    let dominantBeat = null;
    for (const [beat, weight] of weightByBeat) {
        if (dominantBeat === null || weight > weightByBeat.get(dominantBeat)) dominantBeat = beat;
    }

    return {
        mode,
        keys,
        lnRatio: objects.length ? lnCount / objects.length : 0,
        noteCount: objects.length,
        durationSec: (last - first) / 1000 / rate,
        bpm: dominantBeat ? (60000 / dominantBeat) * rate : null,
    };
}

function spreadStats(prefix, values) {
    const xs = values.filter((x) => x !== null);
    if (!xs.length) {
        return { [`${prefix}_min`]: null, [`${prefix}_max`]: null, [`${prefix}_mean`]: null, [`${prefix}_range`]: null };
    }
    const min = minOf(xs);
    const max = maxOf(xs);
    return {
        [`${prefix}_min`]: min,
        [`${prefix}_max`]: max,
        [`${prefix}_mean`]: xs.reduce((a, b) => a + b, 0) / xs.length,
        [`${prefix}_range`]: max - min,
    };
}

function buildVector({ est, msd, interlude, info, report }) {
    const v = {};
    for (const k of EST_KEYS) {
        v[`est_${k}`] = est[k];
        v[`has_${k}`] = est[k] === null ? 0 : 1;
    }
    Object.assign(v, spreadStats("est", DAN_EST_KEYS.map((k) => est[k])));
    Object.assign(v, spreadStats("esta", UNTUNED_EST_KEYS.map((k) => est[k])));
    for (const k of Object.keys(MSD_KEYS)) v[`msd_${k}`] = msd ? msd[k] : null;
    v.interlude = interlude;
    v.note_count = info.noteCount;
    v.duration_sec = info.durationSec;
    v.bpm = finiteOrNull(info.bpm);
    v.ln_ratio = info.lnRatio;

    const shares = patternShares(report);
    const clusters = report?.Clusters ?? [];
    const totalAmount = clusters.reduce((s, c) => s + (Number(c.Amount) || 0), 0);
    v.pat_share1 = shares[0]?.share ?? null;
    v.pat_share2 = shares[1]?.share ?? null;
    v.pat_share3 = shares[2]?.share ?? null;
    v.pat_mixed_share = totalAmount
        ? clusters.filter((c) => c.Mixed).reduce((s, c) => s + (Number(c.Amount) || 0), 0) / totalAmount
        : null;
    v.top_cluster_mixed = clusters.length ? (clusters[0].Mixed ? 1 : 0) : null;
    return v;
}

// info: chartInfo(osuText, rate) when the caller already has it.
export async function computeFeatures(osuText, rate, info = chartInfo(osuText, rate)) {
    const rice = info.mode === 3 && info.keys !== null && isRice(info);
    const base = { keys: info.keys, lnRatio: info.lnRatio, rice, noteCount: info.noteCount, durationSec: info.durationSec, bpm: info.bpm };
    if (!rice) {
        return { ...base, est: null, msd: null, interlude: null, patternReport: null, vector: null };
    }

    // One parse shared by the estimators that would each parse this same text again (they only read it). Not
    // Roxy's: it analyses its own rewritten copy of the text. If the parse throws, each estimator parses for itself.
    const parsed = trySync(() => {
        const parser = new OsuFileParser(osuText);
        parser.process();
        return parser;
    });
    const options = { speedRate: rate };
    const sunnyResult = trySync(() => runSunnyEstimatorFromText(osuText, options, parsed));
    const withSunny = { ...options, precomputedSunnyResult: sunnyResult ?? undefined };
    const danielResult = trySync(() => runDanielEstimatorFromText(osuText, options, parsed));
    // Azusa would run Daniel on this same chart and rate again; it gets the result instead.
    const azusaResult = trySync(() => runAzusaEstimatorFromText(osuText, { ...withSunny, precomputedDanielResult: danielResult ?? undefined }, parsed));
    const roxyResult = trySync(() => runRoxyEstimatorFromText(osuText, withSunny));
    // Mixed's routing runs Roxy, Azusa and Daniel again with these same inputs; it takes these results instead
    // (with no Sunny result Mixed fails on its own Sunny before any of them, as it did).
    const mixedOptions = sunnyResult ? { ...withSunny, reuse: { roxy: roxyResult, azusa: azusaResult, daniel: danielResult } } : withSunny;
    const mixedResult = trySync(() => runMixedEstimatorFromText(osuText, mixedOptions));

    const ett = await tryAsync(() => analyzeEtternaFromText(osuText, { musicRate: rate }));
    const msd = ett?.values
        ? Object.fromEntries(Object.entries(MSD_KEYS).map(([k, src]) => [k, finiteOrNull(ett.values[src])]))
        : null;
    const interlude = finiteOrNull(await tryAsync(() => calculateInterludeStar(parsed ?? osuText, rate)));
    const sunnyStar = finiteOrNull(sunnyResult?.star);

    const companellaResult = ett?.values && interlude !== null && sunnyStar !== null
        ? await tryAsync(() => classifyCompanellaDifficulty({ msdValues: ett.values, interludeStar: interlude, sunnyStar }))
        : null;
    const mixedFinal = mixedResult?.mixedCompanellaPlan && companellaResult
        ? trySync(() => applyCompanellaToMixedResult(mixedResult, companellaResult))
        : mixedResult;

    const danielText = String(danielResult?.estDiff ?? "").trim();
    const est = {
        sunny: sunnyStar,
        daniel: danielText.startsWith("<") ? null : finiteOrNull(danielResult?.numericDifficulty),
        azusa: finiteOrNull(azusaResult?.numericDifficulty),
        roxy: finiteOrNull(roxyResult?.numericDifficulty),
        companella: finiteOrNull(companellaResult?.numericDifficulty),
        mixed: finiteOrNull(mixedFinal?.numericDifficulty),
    };

    const patternReport = trySync(() => analyzePatternFromText(osuText, rate)?.report);
    const vector = buildVector({ est, msd, interlude, info, report: patternReport });
    return { ...base, est, msd, interlude, patternReport, vector };
}
