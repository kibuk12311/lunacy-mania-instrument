// Generator v3: notes, row sizes and column patterns from a model learned on real maps, on any grid
// (1/4, 1/3, 1/6, 1/8 per beat), part by part; the density offset is searched so the analysed dan lands on the request.
// Steps (each reports progress): prepare (request, parts, grids, features, patterns, blocks) → parts with their own
// dan range are searched on their own → one shared density for the rest → a second search when the dan is far off →
// weak blocks are redone → the report (stats, awkward spots, parts).
// One knob k shifts note log-odds (more/fewer notes), capped at KNOB_MAX so a hard request does not flatten the light
// parts into the drops. Pattern accuracy matters more than the dan: row shapes always come from the chosen pattern's
// real maps, and the playability guard only vetoes rows no human should get.
import { timingSections, sectionsToPoints, beatsFromTiming, slotsForBeats } from "./grid.js";
import { slotFeatures, AUDIO_FEATURES } from "./slotFeatures.js";
import { slotEnergy } from "./intensity.js";
import { assignByParts, assignFlavours } from "./assign.js";
import { toOsu, beatDivisorFor } from "./writer.js";
import { mulberry32, deriveSeed } from "./rng.js";
import { searchKnob, searchRange, patternScore, flavourAwareScore, planShares } from "./search.js";
import { detectedFlavours } from "./flavourMetrics.js";
import { normalizeRequest, normalizeParts } from "./request.js";
import { detectParts, partIndexOfSlots } from "./songParts.js";
import { chooseBeatDivs, gridShares } from "./snap.js";
import { createGuard, rowStats, findIssues } from "./playability.js";
import { planBlocks, scoreBlock, describeParts } from "./partReport.js";
import { excerptOsu } from "./excerpt.js";
import { sourceFor } from "./rowSources.js";
import { numericToLabel } from "../core/labels.js";
import { analyzePatternFromText } from "../core/leoblack.js";
import { patternShares } from "../core/patterns.js";

const TAIL_MS = 500;
const KNOB_MIN = -6;
const KNOB_MAX = 1;
const LOW_KNOB_MAX = 2.5; // second search when the dan fell far short: denser light parts allowed …
const HIGH_KNOB_MIN = -9; // … or sparser notes when it came out far too hard
const DAN_FAR = 0.5;
const LOCK_KNOB_SPAN = 0.75;
const CONTRAST_MAX = 8; // log-odds taken from the quietest parts at "Выносливость" = 0
const CONTEXT_RESET_BEATS = 2;
const RECENT_ROWS = 8;
const PART_BUDGET = { coarse: 6, refine: 4, reseeds: 2, keep: 2 };
const RETRY_ROUNDS = 2;
const RETRY_CANDIDATES = 4;
const BAD_BLOCK_SCORE = 0.6;
const BAD_KINDS = new Set(["jack", "fastJack", "hand", "spike"]);
const ISSUE_PENALTY = 0.1;
const LOCK_EDGE_MS = 1;
const MAX_ISSUES = 50;
const SEED_DIVS = 0xd1f5;
const SEED_ASSIGN = 0xa551;
const SEED_SIZE = 0x9e3779b9;
const SEED_PATTERN = 0x85ebca6b;
const SEED_FLAVOUR = 0xf1a7;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const maskToCols = (m) => [0, 1, 2, 3].filter((c) => m & (1 << c));
const defaultPatternsOf = (osuText) => patternShares(analyzePatternFromText(osuText, 1)?.report);
const numericOf = (result) => (result?.kind === "ok" ? result.numeric : -Infinity);

function percentile(values, q) {
    const sorted = Float64Array.from(values).sort();
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

export async function generateLearnedMap(input, analyze, model, opts = {}) {
    const { envelope, durationMs, meta = {}, locked = null } = input;
    const onProgress = opts.onProgress ?? (() => {});
    const patternsOf = opts.patternsOf ?? defaultPatternsOf;

    // ---- prepare ----
    const request = normalizeRequest(input.request, durationMs);
    const { range } = request;
    const sections = timingSections(input.timing);
    const timing = { sections };
    const points = sectionsToPoints(sections);
    const beats = beatsFromTiming(points, durationMs - TAIL_MS);
    const barMs = ((sections[0].meter ?? 4) * 60000) / sections[0].bpm;
    const parts = normalizeParts(request.parts?.length ? request.parts : detectParts(envelope, slotsForBeats(beats)), durationMs, { barMs });
    const partAt = (t) => {
        let p = 0;
        while (p + 1 < parts.length && t >= parts[p + 1].startMs) p += 1;
        return p;
    };
    const danOf = (p) => (parts[p].range ? (parts[p].range.lo + parts[p].range.hi) / 2 : request.target);
    const beatPart = beats.map((b) => partAt(b.t));
    const divs = chooseBeatDivs({
        envelope, beats, allowed: request.snaps, model,
        dan: beatPart.map(danOf),
        families: beatPart.map((p) => (parts[p].empty ? null : (parts[p].patterns ?? request.patterns)[0].name)),
        rng: mulberry32(deriveSeed(request.planSeed, SEED_DIVS)),
    });
    const slots = slotsForBeats(beats, (i) => divs[i]);
    const partOf = partIndexOfSlots(slots, parts);
    const names = model.features ?? AUDIO_FEATURES;
    const features = slotFeatures(envelope, slots, sections[0].bpm, names);
    const assign = assignByParts(slots, parts, request.patterns, request.mix, mulberry32(deriveSeed(locked?.planSeed ?? request.planSeed, SEED_ASSIGN)));
    // the flavour (sub-pattern) per slot, from a seed of its own: without flavours everything below is as before
    const flavour = assignFlavours(slots, parts, assign, request.patterns, request.mix,
        mulberry32(deriveSeed(locked?.planSeed ?? request.planSeed, SEED_FLAVOUR)), { meter: sections[0].meter ?? 4 });
    const anyFlavour = flavour.some(Boolean);
    const flavourAt = (i) => (anyFlavour ? flavour[i]?.id ?? null : null);
    const blocks = planBlocks(assign, slots, partOf, request.mix);
    const dan = Float64Array.from(slots, (_, i) => danOf(partOf[i]));
    const source = await sourceFor(model);
    const prep = source.prepare({ model, audio: { envelope, ...features }, slots, dan, family: assign, ...(anyFlavour ? { flavour } : {}) });
    onProgress({ phase: "prepare", i: 0, n: 1 });

    // ---- the contrast term: light parts are pushed down (own-range parts against their own loudest bars) ----
    const energyCol = names.indexOf("energy");
    const rawEnergy = energyCol >= 0 ? Float64Array.from(slots, (_, i) => features.rows[i * names.length + energyCol]) : slotEnergy(envelope, slots);
    const energy = Float64Array.from(rawEnergy);
    parts.forEach((part, p) => {
        if (!part.range) return;
        const own = [];
        for (let i = 0; i < slots.length; i += 1) if (partOf[i] === p) own.push(rawEnergy[i]);
        const top = Math.max(0.05, percentile(own, 0.9));
        for (let i = 0; i < slots.length; i += 1) if (partOf[i] === p) energy[i] = Math.min(1, rawEnergy[i] / top);
    });
    const contrast = CONTRAST_MAX * (1 - request.stamina);
    const burst = request.burst - 0.3;
    const adjustOf = (i, scale) => -contrast * scale * (1 - energy[i]) ** 1.3 + 3 * burst * (energy[i] - 0.5);

    // ---- locked parts: the base map's rows stay exactly as they were ----
    const lockedParts = new Set();
    for (const [from, to] of locked?.ranges ?? []) {
        parts.forEach((p, k) => { if (Math.abs(p.startMs - from) <= LOCK_EDGE_MS && Math.abs(p.endMs - to) <= LOCK_EDGE_MS) lockedParts.add(k); });
    }
    const lockedRows = (locked?.rows ?? []).map((r) => {
        const mask = r.mask ?? r.cols.reduce((m, c) => m | (1 << c), 0);
        const i = nearestSlot(slots, r.t);
        const fl = flavourAt(i);
        return { t: r.t, mask, cols: maskToCols(mask), i, family: assign[i] ?? parts[partAt(r.t)].patterns?.[0]?.name ?? request.patterns[0].name, ...(fl ? { flavour: fl } : {}), locked: true };
    });
    const blockRowsOf = (rows, b) => rows.filter((r) => r.t >= b.startMs && r.t < b.endMs);
    const lockedFixed = new Map(blocks.filter((b) => lockedParts.has(b.part)).map((b) => [b.index, blockRowsOf(lockedRows, b)]));
    const looseLocked = lockedRows.filter((r) => !blocks.some((b) => lockedParts.has(b.part) && r.t >= b.startMs && r.t < b.endMs));

    const breaks = parts.filter((p, k) => p.empty && !lockedParts.has(k)).map((p) => [p.startMs, p.endMs]);
    const patternNames = request.patterns.map((p) => p.name).join(" + ");
    const render = (rows, label) => toOsu({
        rows, timingPoints: points, normalizeSv: request.normalizeSv, breaks,
        beatDivisor: beatDivisorFor(new Set(rows.map((r) => slots[r.i ?? nearestSlot(slots, r.t)].div))),
        title: meta.title, artist: meta.artist, version: `${label} ${patternNames}`.trim(),
        audioFilename: meta.audioFilename, previewMs: Math.round(durationMs * 0.4),
    });
    const partSeed = (p) => parts[p].seed ?? p;

    // ---- one map from a plan: fixed blocks stay, the others are drawn with their own streams ----
    // knobOf(part) → knob; fixed: Map(block → rows); seedOf(block) → uint32; only: Set of parts to draw (others empty).
    // A part starts with a fresh guard and context, so parts do not depend on each other; when the part before is
    // fixed in this plan its rows are known and the guard sees them.
    function build({ knobOf, fixed = new Map(), seedOf, scale = 1, only = null }) {
        const out = [];
        let guard = null;
        let ctx = null;
        let lastT = null;
        let part = -1;
        const isFixedPart = (p) => blocks.every((b) => b.part !== p || fixed.has(b.index));
        const pushRow = (row) => {
            guard.push(row.mask, row.i, row.family);
            const gapMs = lastT === null ? Infinity : row.t - lastT;
            ctx.recent.unshift({ mask: row.mask, gapMs });
            if (ctx.recent.length > RECENT_ROWS) ctx.recent.pop();
            ctx.prev2 = ctx.prev;
            ctx.prev = row.mask;
            lastT = row.t;
        };
        const freshContext = () => {
            ctx = { prev: 0, prev2: 0, recent: [] };
            lastT = null;
        };
        for (let k = 0; k < blocks.length; k += 1) {
            const block = blocks[k];
            if (block.part !== part) {
                const before = part;
                part = block.part;
                guard = createGuard({ slots });
                freshContext();
                if (before >= 0 && before === part - 1 && isFixedPart(before)) {
                    for (const r of out.filter((x) => partOf[x.i] === before).slice(-64)) pushRow(r);
                }
            }
            const kept = fixed.get(block.index);
            if (kept) {
                for (const r of kept) {
                    pushRow(r);
                    out.push(r);
                }
                continue;
            }
            if (only && !only.has(block.part)) continue;
            const s = seedOf(block);
            const rngs = { fill: mulberry32(s), size: mulberry32(s ^ SEED_SIZE), pattern: mulberry32(s ^ SEED_PATTERN) };
            const knob = knobOf(block.part);
            const next = blocks[k + 1] && fixed.get(blocks[k + 1].index);
            for (let i = block.i0; i < block.i1; i += 1) {
                const slot = slots[i];
                if (lastT !== null && slot.t - lastT > CONTEXT_RESET_BEATS * slot.beatMs) freshContext();
                const family = assign[i];
                const fl = flavourAt(i);
                const ahead = next?.length ? aheadOf(next, slot) : null;
                const before = guard.forced;
                const weightOf = Object.assign((m) => guard.weight(m, i, family, ahead, fl), { fallback: () => guard.fallback(i, family, ahead, fl) });
                const mask = prep.step(i, knob + adjustOf(i, scale), ctx, rngs, weightOf);
                if (!mask) continue;
                const row = { t: slot.t, mask, cols: maskToCols(mask), i, family, ...(fl ? { flavour: fl } : {}), ...(guard.forced > before ? { forced: true } : {}) };
                pushRow(row);
                out.push(row);
            }
        }
        if (looseLocked.length) return [...out, ...looseLocked].sort((a, b) => a.t - b.t);
        return out;
    }

    const familiesOfPart = (p) => [...new Set(blocks.filter((b) => b.part === p).flatMap((b) => b.families))];
    const wantedFamilies = [...new Set(assign.filter(Boolean))];
    const techShare = request.patterns.filter((p) => p.name === "Tech").reduce((a, p) => a + p.share, 0);
    // pattern accuracy first: how much of the map reads as the requested patterns (Tech = the uneven-rhythm flag);
    // with flavours, how much of each planned flavour came out comes first and the families second
    const familyScoreOf = (a) => patternScore(a.result?.top3, wantedFamilies) + (a.result?.tech ? techShare : 0);
    const mapShares = anyFlavour ? planShares(assign) : null;
    const scoresOf = (a) => flavourAwareScore({
        rows: a.rows ?? [], top3: a.result?.top3, families: wantedFamilies, shares: mapShares,
        familyScoreOf: (fams) => patternScore(a.result?.top3, fams) + (a.result?.tech && fams.includes("Tech") ? techShare : 0),
    });
    const mapScore = (a) => (anyFlavour ? scoresOf(a).score : familyScoreOf(a));
    let evaluations = 0;
    const tick = (phase) => onProgress({ phase, i: evaluations++, n: 0 });

    // ---- parts with their own dan range: searched on their own excerpt, then frozen ----
    const frozen = new Map(); // part → { knob, rows }
    const ownParts = parts.map((p, k) => k).filter((k) => parts[k].range && !parts[k].empty && !lockedParts.has(k) && blocks.some((b) => b.part === k));
    for (let n = 0; n < ownParts.length; n += 1) {
        const p = ownParts[n];
        const part = parts[p];
        onProgress({ phase: "partSearch", i: n, n: ownParts.length, kind: part.kind });
        const families = familiesOfPart(p);
        const evaluate = async (knob, seed) => {
            const rows = build({ knobOf: () => knob, only: new Set([p]), seedOf: (b) => deriveSeed(seed, partSeed(b.part), b.inPart) })
                .filter((r) => partOf[r.i] === p);
            const result = rows.length ? await analyze(excerptOsu(rows, part, timing), 1) : null;
            return { rows, result, numeric: numericOf(result) };
        };
        const partFamilyScore = (a, fams = families) => patternScore(a.result?.top3, fams) + (a.result?.tech && fams.includes("Tech") ? 0.25 : 0);
        const first = partOf.indexOf(p);
        const shares = anyFlavour ? planShares(assign, first, partOf.lastIndexOf(p) + 1) : null;
        const score = (a) => (anyFlavour
            ? flavourAwareScore({ rows: a.rows, top3: a.result?.top3, families, shares, familyScoreOf: (fams) => partFamilyScore(a, fams) }).score
            : partFamilyScore(a));
        const { best } = await searchRange({ evaluate, lo: part.range.lo, hi: part.range.hi, min: KNOB_MIN, max: KNOB_MAX, seed: request.noteSeed, score, budget: PART_BUDGET });
        frozen.set(p, { knob: best.knob, rows: best.rows });
    }
    const baseFixed = new Map(lockedFixed);
    for (const [p, { rows }] of frozen) for (const b of blocks) if (b.part === p) baseFixed.set(b.index, blockRowsOf(rows, b));
    const knobOfWith = (knob) => (p) => frozen.get(p)?.knob ?? knob;

    // ---- one shared density for every other part ----
    const globalSearch = async ({ min, max, scale }) => {
        const evaluate = async (knob, seed) => {
            tick("search");
            const rows = build({ knobOf: knobOfWith(knob), fixed: baseFixed, seedOf: (b) => deriveSeed(seed, partSeed(b.part), b.inPart), scale });
            const result = await analyze(render(rows, ""), 1);
            return { rows, result, numeric: numericOf(result), scale };
        };
        const free = blocks.some((b) => !baseFixed.has(b.index));
        if (!free) {
            const one = { knob: frozen.size ? [...frozen.values()][0].knob : locked?.knob ?? 0, seed: request.noteSeed, ...(await evaluate(0, request.noteSeed)) };
            const inside = range ? one.numeric >= range.lo && one.numeric < range.hi : true;
            return { best: one, reachable: inside };
        }
        if (range) {
            const r = await searchRange({ evaluate, lo: range.lo, hi: range.hi, min, max, seed: request.noteSeed, score: mapScore });
            return { best: r.best, reachable: r.inRange };
        }
        return searchKnob({ evaluate, target: request.target, min, max, seed: request.noteSeed });
    };
    const span = locked && Number.isFinite(locked.knob)
        ? { min: Math.max(KNOB_MIN, locked.knob - LOCK_KNOB_SPAN), max: Math.min(KNOB_MAX, locked.knob + LOCK_KNOB_SPAN) }
        : { min: KNOB_MIN, max: KNOB_MAX };
    let { best, reachable } = await globalSearch({ ...span, scale: 1 });

    // ---- far off: once more with room for denser light parts (and half the contrast) or for sparser notes ----
    let danRetry = null;
    if (range && !reachable && Number.isFinite(best.numeric)) {
        let again = null;
        if (best.numeric < range.lo - DAN_FAR) {
            danRetry = "low";
            again = await globalSearch({ min: span.min, max: LOW_KNOB_MAX, scale: 0.5 });
        } else if (best.numeric > range.hi + DAN_FAR) {
            danRetry = "high";
            again = await globalSearch({ min: HIGH_KNOB_MIN, max: span.max, scale: 1 });
        }
        const gap = (a) => (a.numeric < range.lo ? range.lo - a.numeric : a.numeric >= range.hi ? a.numeric - range.hi : 0);
        if (again && (again.reachable || gap(again.best) < gap(best))) ({ best, reachable } = again);
    }
    const searched = { rows: best.rows, result: best.result, reachable };
    const chosenScale = best.scale ?? 1;
    const knobOf = knobOfWith(best.knob);

    // ---- weak blocks are redone: low pattern score or an awkward spot; candidates judged by the pattern finder ----
    let rows = best.rows;
    const replaced = new Set();
    const retryable = (b) => !baseFixed.has(b.index);
    const blockValue = (all, b) => {
        const score = scoreBlock(all, b, { patternsOf, render: (r) => render(r, ""), ...(anyFlavour ? { assign } : {}) });
        const near = all.filter((r) => r.t >= b.startMs - 2000 && r.t < b.endMs + 2000);
        const issues = findIssues(near, slots).filter((x) => x.kind !== "columns" && x.t >= b.startMs && x.t < b.endMs);
        return { score, issues, value: (score ?? 1) - ISSUE_PENALTY * issues.length };
    };
    for (let round = 0; round < RETRY_ROUNDS; round += 1) {
        onProgress({ phase: "retry", i: round, n: RETRY_ROUNDS });
        const bad = blocks.filter((b) => {
            if (!retryable(b)) return false;
            const { score, issues } = blockValue(rows, b);
            return (score !== null && score < BAD_BLOCK_SCORE) || issues.some((x) => BAD_KINDS.has(x.kind));
        });
        if (!bad.length) break;
        let changed = false;
        for (const b of bad) {
            const fixed = new Map(blocks.filter((x) => x.index !== b.index).map((x) => [x.index, blockRowsOf(rows, x)]));
            let bestValue = blockValue(rows, b).value;
            let bestRows = null;
            for (let k = 0; k < RETRY_CANDIDATES; k += 1) {
                const seed = deriveSeed(request.noteSeed, partSeed(b.part), b.inPart, round + 1, k);
                const candidate = build({ knobOf, fixed, seedOf: () => seed, scale: chosenScale });
                const { value } = blockValue(candidate, b);
                if (value > bestValue) {
                    bestValue = value;
                    bestRows = candidate;
                }
            }
            if (bestRows) {
                rows = bestRows;
                replaced.add(b.index);
                changed = true;
            }
        }
        if (!changed) break;
    }
    let result = searched.result;
    let reverted = false;
    if (replaced.size) {
        result = await analyze(render(rows, ""), 1);
        const inside = (n) => range && n >= range.lo && n < range.hi;
        if (range && searched.reachable && !inside(numericOf(result))) {
            rows = searched.rows;
            result = searched.result;
            replaced.clear();
            reverted = true;
        }
    }
    const final = { rows, result };
    const numeric = numericOf(result);
    const inRange = range ? numeric >= range.lo && numeric < range.hi : searched.reachable;

    // ---- the report ----
    const issues = findIssues(rows, slots);
    const retriedPerPart = new Map();
    for (const b of blocks) if (replaced.has(b.index)) retriedPerPart.set(b.part, (retriedPerPart.get(b.part) ?? 0) + 1);
    const reports = await describeParts(rows, parts, blocks, {
        analyze, timing, issues, retried: retriedPerPart, locked: lockedParts, assign,
        onProgress: ({ i, n }) => onProgress({ phase: "describe", i, n }),
    });
    const label = result?.kind === "ok" ? numericToLabel(result.numeric).text : "";
    return {
        osuText: render(rows, label),
        result,
        offset: best.knob,
        knob: best.knob,
        reachable: inRange,
        range,
        noteCount: rows.reduce((s, r) => s + popcount(r.mask), 0),
        version: `${label} ${patternNames}`.trim(),
        engine: "learned",
        ...(anyFlavour ? (({ patternScore: ps, familyScore, flavourScore }) => ({ patternScore: ps, familyScore, flavourScore }))(scoresOf(final))
            : { patternScore: mapScore(final) }),
        // the flavours our detector finds in the whole map (for the detailed view), whether asked for or not
        flavours: detectedFlavours(rows),
        planSeed: request.planSeed,
        noteSeed: request.noteSeed,
        stats: rowStats(rows, slots),
        issues: issues.slice(0, MAX_ISSUES),
        parts: reports,
        retries: { blocks: replaced.size, dan: danRetry, ...(reverted ? { reverted: true } : {}) },
        grid: gridShares(rows, slots),
    };
}

function nearestSlot(slots, t) {
    let lo = 0;
    let hi = slots.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid].t < t) lo = mid + 1;
        else hi = mid;
    }
    return lo > 0 && Math.abs(slots[lo - 1].t - t) <= Math.abs(slots[lo].t - t) ? lo - 1 : lo;
}

// The fixed rows right after a slot, as the guard reads them: per column, how many rows in a row (the first within
// half a beat of the slot, each next within half a beat of the one before) hold it, and when its next note comes.
function aheadOf(fixedRows, slot) {
    const half = slot.beatMs / 2;
    const first = fixedRows.findIndex((r) => r.t > slot.t);
    if (first < 0 || fixedRows[first].t - slot.t > Math.max(half, 100)) return null;
    const run = [0, 0, 0, 0];
    const nextT = [Infinity, Infinity, Infinity, Infinity];
    for (let c = 0; c < 4; c += 1) {
        const bit = 1 << c;
        nextT[c] = fixedRows.find((r, k) => k >= first && r.mask & bit)?.t ?? Infinity;
        let prevT = slot.t;
        for (let k = first; k < fixedRows.length; k += 1) {
            const r = fixedRows[k];
            if (!(r.mask & bit) || r.t - prevT > half) break;
            run[c] += 1;
            prevT = r.t;
        }
    }
    return { run, nextT };
}
