// The rule-based fallback (no model file): song timing + envelope + request → .osu whose analysed dan is as close to
// the target as the song allows. Same answer shape as the learned generator (engine "rules"), on a 1/4 grid per
// timing section, part by part; no lock and no retries.
import { timingSections, sectionsToPoints, beatsFromTiming, slotsForBeats } from "./grid.js";
import { slotStrengths, slotIntensity, slotEnergy, shapeEnergy } from "./intensity.js";
import { assignByParts, assignFlavours } from "./assign.js";
import { buildChart } from "./build.js";
import { toOsu } from "./writer.js";
import { mulberry32, deriveSeed } from "./rng.js";
import { numericToLabel } from "../core/labels.js";
import { searchKnob, patternScore, flavourAwareScore, planShares } from "./search.js";
import { detectedFlavours } from "./flavourMetrics.js";
import { normalizeRequest, normalizeParts } from "./request.js";
import { detectParts, partIndexOfSlots } from "./songParts.js";
import { gridShares } from "./snap.js";
import { rowStats, findIssues } from "./playability.js";
import { planBlocks, describeParts } from "./partReport.js";

const TAIL_MS = 500;
const MAX_LAMBDA = 2;
const MAX_ISSUES = 50;
const SEED_ASSIGN = 0xa551;
const SEED_FLAVOUR = 0xf1a7;

export async function generateMap(input, analyze, opts = {}) {
    const { envelope, durationMs, meta = {} } = input;
    const onProgress = opts.onProgress ?? (() => {});
    // the rule-based fallback aims at the middle of a dan range
    const request = normalizeRequest(input.request, durationMs);
    const { range } = request;
    const sections = timingSections(input.timing);
    const points = sectionsToPoints(sections);
    const slots = slotsForBeats(beatsFromTiming(points, durationMs - TAIL_MS));
    const barMs = ((sections[0].meter ?? 4) * 60000) / sections[0].bpm;
    const parts = normalizeParts(request.parts?.length ? request.parts : detectParts(envelope, slots), durationMs, { barMs });
    const partOf = partIndexOfSlots(slots, parts);
    const intensity = slotIntensity(slotStrengths(envelope, slots), request);
    slots.forEach((_, i) => { if (parts[partOf[i]].empty) intensity[i] = 0; });
    const energy = shapeEnergy(slotEnergy(envelope, slots), request);
    const assign = assignByParts(slots, parts, request.patterns, request.mix, mulberry32(deriveSeed(request.planSeed, SEED_ASSIGN)));
    const flavourPlan = assignFlavours(slots, parts, assign, request.patterns, request.mix, mulberry32(deriveSeed(request.planSeed, SEED_FLAVOUR)), { meter: sections[0].meter ?? 4 });
    const flavour = flavourPlan.some(Boolean) ? flavourPlan : null;
    const blocks = planBlocks(assign, slots, partOf, request.mix);
    const patternNames = request.patterns.map((p) => p.name).join(" + ");
    const breaks = parts.filter((p) => p.empty).map((p) => [p.startMs, p.endMs]);
    onProgress({ phase: "prepare", i: 0, n: 1 });

    const render = (rows, label) => toOsu({
        rows, timingPoints: points, normalizeSv: request.normalizeSv, breaks,
        title: meta.title,
        artist: meta.artist,
        version: `${label} ${patternNames}`,
        audioFilename: meta.audioFilename,
        previewMs: Math.round(durationMs * 0.4),
    });

    let evaluations = 0;
    async function evaluate(lambda, seed) {
        onProgress({ phase: "search", i: evaluations++, n: 0 });
        const rows = buildChart({ slots, intensity, assign, lambda, seed, bpm: sections[0].bpm, energy, flavour });
        const result = await analyze(render(rows, ""), 1);
        return { rows, result, numeric: result?.kind === "ok" ? result.numeric : -Infinity };
    }

    const { best, reachable } = await searchKnob({ evaluate, target: request.target, min: 0, max: MAX_LAMBDA, seed: request.noteSeed });
    const label = best.result?.kind === "ok" ? numericToLabel(best.result.numeric).text : "";
    const nearest = (t) => {
        let lo = 0;
        let hi = slots.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (slots[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        return lo > 0 && Math.abs(slots[lo - 1].t - t) <= Math.abs(slots[lo].t - t) ? lo - 1 : lo;
    };
    const rows = best.rows.map((r) => ({ ...r, family: assign[nearest(r.t)] }));
    const issues = findIssues(rows, slots);
    const reports = await describeParts(rows, parts, blocks, {
        analyze, timing: { sections }, issues, ...(flavour ? { assign } : {}),
        onProgress: ({ i, n }) => onProgress({ phase: "describe", i, n }),
    });
    const numeric = best.result?.kind === "ok" ? best.result.numeric : null;
    const wanted = [...new Set(assign.filter(Boolean))];
    const familyScore = patternScore(best.result?.top3, wanted);
    const scores = flavour ? flavourAwareScore({
        rows, top3: best.result?.top3, families: wanted, shares: planShares(assign), familyScoreOf: (fams) => patternScore(best.result?.top3, fams),
    }) : null;
    return {
        osuText: render(best.rows, label),
        result: best.result,
        lambda: best.knob,
        knob: best.knob,
        reachable: range ? numeric !== null && numeric >= range.lo && numeric < range.hi : reachable,
        range,
        noteCount: best.rows.reduce((s, r) => s + r.cols.length, 0),
        version: `${label} ${patternNames}`.trim(),
        engine: "rules",
        patternScore: scores ? scores.patternScore : familyScore,
        ...(scores ? { familyScore, flavourScore: scores.flavourScore } : {}),
        flavours: detectedFlavours(rows),
        planSeed: request.planSeed,
        noteSeed: request.noteSeed,
        stats: rowStats(rows, slots),
        issues: issues.slice(0, MAX_ISSUES),
        parts: reports,
        retries: { blocks: 0, dan: null },
        grid: gridShares(rows, slots),
    };
}
