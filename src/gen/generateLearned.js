// Generator v3: notes, row sizes and column patterns from a model learned on real maps, on any grid
// (1/4, 1/3, 1/6, 1/8 per beat), part by part; the density offset is searched so the analysed dan lands on the request.
// Steps (each reports progress): prepare (request, parts, grids, features, patterns, blocks) → parts with their own
// dan range are searched on their own → one shared density for the rest → a second search when the dan is far off →
// weak blocks are redone → the report (stats, awkward spots, parts).
// One knob k shifts note log-odds (more/fewer notes), capped at KNOB_MAX so a hard request does not flatten the light
// parts into the drops. Pattern accuracy matters more than the dan: row shapes always come from the chosen pattern's
// real maps, and the playability guard only vetoes rows no human should get.
//
// Wave 3 (docs/2026-10-25-mapgen-v3-ml-addendum.md; every addition is off by default, and then this is v3 bit for bit):
// - input.stems (src/audio/stems.js, beside the envelope) → the song structure (src/gen/structure.js) during prepare,
//   the stem and structure feature columns for models that ask for them, and response.structure;
// - request.candidates (G1): N candidates after the dan retry, the critic picks one (src/gen/candidates.js, critic.js;
//   opts.critic or the heuristic critic); response.critic and the picked candidate's noteSeed;
// - request.repeats (G2): with a structure, families change at phrase starts (mixed), repeated sections copy their
//   first occurrence's families and rows (src/gen/echo.js), and blocks are cut at phrase starts;
// - an infill source (G3, nn-v2, caps.infill): the locked rows go in as `known` (the encoder sees both sides of a gap),
//   rows decided outside the source in a build (kept blocks, echo rows) go through step(i, …, fixed), prep.begin() per
//   build, snapshot/restore for own-range part searches and block retry, a shorter search, cond { msd, style, rate,
//   source };
// - request.style (G4): the XGB source blends the mapper's pattern tables; the critic scores the style.
// opts: { onProgress, patternsOf, critic, personal, deadlineMs, now, source, snapshots, debug, boost } (personal and
// deadlineMs may also come in `input`, as the evaluation tools send them; source: a row source for tests and tools;
// snapshots: false re-decodes everything (tests); debug: an object filled with internals for tests).
// boost (0.9.8, src/gen/targeting.js): one rung of the closed-loop dan targeting, for when the plain search fell short
// of a hard request: { knobMax, knobMin, contrast, chord, danLift, snaps, denser }. The knob may go up to knobMax (in
// parts with their own range too) and down to knobMin (the soften rung, for a map that came out too hard; a negative
// chord and danLift then make it lighter), the light parts' contrast is multiplied by `contrast`, a row weighs
// exp(chord × its notes over one) more (up to the family's CHORD_ROOM), the model is conditioned on the dan + danLift,
// `snaps` are allowed beside the request's and `denser` leans the grid choice towards the finer grids. Absent or
// null: exactly as before.
import { timingSections, sectionsToPoints, beatsFromTiming, slotsForBeats } from "./grid.js";
import { slotFeatures, AUDIO_FEATURES } from "./slotFeatures.js";
import { slotEnergy, slotStrengths } from "./intensity.js";
import { assignByParts, assignFlavours } from "./assign.js";
import { toOsu, beatDivisorFor } from "./writer.js";
import { mulberry32, deriveSeed } from "./rng.js";
import { searchKnob, searchRange, patternScore, flavourAwareScore, planShares } from "./search.js";
import { detectedFlavours } from "./flavourMetrics.js";
import { normalizeRequest, normalizeParts } from "./request.js";
import { detectParts, partIndexOfSlots } from "./songParts.js";
import { chooseBeatDivs, gridShares, denserGridsFor } from "./snap.js";
import { createGuard, rowStats, findIssues } from "./playability.js";
import { planBlocks, scoreBlock, describeParts } from "./partReport.js";
import { excerptOsu } from "./excerpt.js";
import { sourceFor } from "./rowSources.js";
import { songStructure, structureToResponse } from "./structure.js";
import { createEcho, phraseStarts, echoPlan, echoCopy, UNDECIDED } from "./echo.js";
import { pickCandidate, candidateSeed, resolveCritic, DEFAULT_DEADLINE_MS, RETRY_CRITIC_WEIGHT } from "./candidates.js";
import { criticFeatures } from "./criticFeatures.js";
import { msdPriorOf, msdFit, msdVector } from "./msdPrior.js";
import { numericToLabel, labelKey } from "../core/labels.js";
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
// nn-v2 (G3, addendum §5.3): the model is conditioned on the dan already, so its search is short and near knob 0
const NN2_BUDGET = { coarse: 3, refine: 2, reseeds: 1, keep: 1 };
const NN2_SPAN = { min: -2, max: 1 };
const FREE = 255;
const NO_RNGS = { fill: () => 0, size: () => 0, pattern: () => 0 };
const WARM_OFFSET = -1e9; // a step this far down gives no row: it only runs the decoder up to that slot's beat
// boost.chord: how many notes over one a family's rows gain weight for (a stream becomes at most a jumpstream)
export const CHORD_ROOM = Object.freeze({ Stream: 1, Jumpstream: 1, Handstream: 2, Tech: 1, Chordjack: 3, Jack: 2 });
const STREAM_CHORD = 0.5; // streams take half the chord boost: single notes are what makes them streams

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
    const stems = input.stems ?? null;
    const onProgress = opts.onProgress ?? (() => {});
    const patternsOf = opts.patternsOf ?? defaultPatternsOf;
    const debug = opts.debug ?? null;
    const boost = opts.boost ?? null;

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
    const danLift = boost?.danLift ?? 0;
    const danOf = (p) => (parts[p].range ? (parts[p].range.lo + parts[p].range.hi) / 2 : request.target) + danLift;
    const beatPart = beats.map((b) => partAt(b.t));
    // the boost's grids only where their rows stay humanly fast at the song's tempo (snap.js denserGridsFor)
    const allowedSnaps = boost?.snaps ? [...new Set([...request.snaps, ...denserGridsFor(sections[0].bpm, boost.snaps)])] : request.snaps;
    const divs = chooseBeatDivs({
        envelope, beats, allowed: allowedSnaps, model, ...(boost?.denser ? { denser: true } : {}),
        dan: beatPart.map(danOf),
        families: beatPart.map((p) => (parts[p].empty ? null : (parts[p].patterns ?? request.patterns)[0].name)),
        rng: mulberry32(deriveSeed(request.planSeed, SEED_DIVS)),
    });
    const slots = slotsForBeats(beats, (i) => divs[i]);
    const partOf = partIndexOfSlots(slots, parts);
    // the song structure, from the stems (none without them: then repeats are off and nothing below changes)
    const structure = stems ? structureOf({ stems, slots, parts, envelope }) : null;
    const repeats = Boolean(request.repeats && structure);
    const names = model.features ?? AUDIO_FEATURES;
    const features = slotFeatures(envelope, slots, sections[0].bpm, names, { stems, structure });
    const assign = assignByParts(slots, parts, request.patterns, request.mix, mulberry32(deriveSeed(locked?.planSeed ?? request.planSeed, SEED_ASSIGN)),
        repeats ? { structure } : {});
    // the flavour (sub-pattern) per slot, from a seed of its own: without flavours everything below is as before
    const flavour = assignFlavours(slots, parts, assign, request.patterns, request.mix,
        mulberry32(deriveSeed(locked?.planSeed ?? request.planSeed, SEED_FLAVOUR)), { meter: sections[0].meter ?? 4 });
    const anyFlavour = flavour.some(Boolean);
    const flavourAt = (i) => (anyFlavour ? flavour[i]?.id ?? null : null);
    const blocks = planBlocks(assign, slots, partOf, request.mix, repeats ? { phraseStart: phraseStarts(structure, slots) } : {});
    const dan = Float64Array.from(slots, (_, i) => danOf(partOf[i]));
    const source = opts.source ?? await sourceFor(model, { nnBackend: opts.nnBackend ?? null });
    const infill = Boolean(source.caps?.infill);
    const nn2 = model?.kind === "nn-v2";
    const style = request.style;

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

    // an infill source sees the locked rows (both sides of a gap) as `known`: 255 = free, else the locked mask there
    // (0 = a locked empty slot); never echo rows, which change from build to build (§2.7)
    let known = null;
    if (infill) {
        known = new Uint8Array(slots.length).fill(FREE);
        for (let i = 0; i < slots.length; i += 1) if (lockedParts.has(partOf[i])) known[i] = 0;
        for (const r of lockedRows) known[r.i] = (known[r.i] === FREE ? 0 : known[r.i]) | (r.mask & 15);
    }
    const audio = { envelope, ...features, ...(stems ? { stems } : {}) };
    // awaited: the GPU source (stream W, opts.nnBackend) prepares asynchronously; a plain prepare is unchanged
    const prep = await source.prepare({
        model, audio, slots, dan, family: assign, ...(anyFlavour ? { flavour } : {}),
        ...(infill ? { known, cond: { msd: msdPriorOf(model, request.target + danLift, request.patterns), style, rate: 1, source: "osu" }, structure } : {}),
        ...(!infill && style !== null ? { style } : {}),
    });
    const echo = repeats ? createEcho({ structure, slots, assign }) : null;
    const looseAt = infill && looseLocked.length ? new Set(looseLocked.map((r) => r.i)) : null;
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
    const contrast = CONTRAST_MAX * (1 - request.stamina) * (boost?.contrast ?? 1);
    const burst = request.burst - 0.3;
    const adjustOf = (i, scale) => -contrast * scale * (1 - energy[i]) ** 1.3 + 3 * burst * (energy[i] - 0.5);

    const breaks = parts.filter((p, k) => p.empty && !lockedParts.has(k)).map((p) => [p.startMs, p.endMs]);
    const patternNames = request.patterns.map((p) => p.name).join(" + ");
    const render = (rows, label) => toOsu({
        rows, timingPoints: points, normalizeSv: request.normalizeSv, breaks,
        beatDivisor: beatDivisorFor(new Set(rows.map((r) => slots[r.i ?? nearestSlot(slots, r.t)].div))),
        title: meta.title, artist: meta.artist, version: `${label} ${patternNames}`.trim(),
        audioFilename: meta.audioFilename, previewMs: Math.round(durationMs * 0.4),
    });
    const partSeed = (p) => parts[p].seed ?? p;
    // boost.chord: per family, a row's weight by its note count (null: no boost, the guard's weight alone)
    const chordCache = new Map();
    const chordWeights = (family) => {
        if (!boost?.chord) return null;
        if (!chordCache.has(family)) {
            const c = boost.chord * (family === "Stream" ? STREAM_CHORD : 1);
            const room = CHORD_ROOM[family] ?? 1;
            chordCache.set(family, Float64Array.from({ length: 5 }, (_, n) => Math.exp(c * Math.min(Math.max(0, n - 1), room))));
        }
        return chordCache.get(family);
    };

    // ---- one map from a plan: fixed blocks stay, the others are drawn with their own streams ----
    // knobOf(part) → knob; fixed: Map(block → rows); seedOf(block) → uint32; only: Set of parts to draw (others empty).
    // A part starts with a fresh guard and context, so parts do not depend on each other; when the part before is
    // fixed in this plan its rows are known and the guard sees them.
    // echoSeed: the build's note seed for the echo plan (repeats; null = no echo rows). resume: { k0, snap, fedTo }
    // from snapshotAt (infill sources): the source restarts from the snapshot at block k0 instead of decoding again.
    // An infill source starts each build with prep.begin() and gets the kept rows that come before a drawn block as
    // step(i, …, fixed), so its decoder reads every row of the map; slots it is not asked about count as their known
    // mask, else as empty.
    function build({ knobOf, fixed = new Map(), seedOf, scale = 1, only = null, echoSeed = null, resume = null }) {
        const out = [];
        let guard = null;
        let ctx = null;
        let lastT = null;
        let part = -1;
        const decided = echo ? new Uint8Array(slots.length).fill(UNDECIDED) : null;
        const echoRun = echo && echoSeed !== null ? echo.forBuild(echoSeed, { infill }) : null;
        let lastDrawn = -1;
        let fedTo = -1;
        if (infill) {
            for (let k = blocks.length - 1; k >= 0 && lastDrawn < 0; k -= 1) if (!fixed.has(blocks[k].index) && (!only || only.has(blocks[k].part))) lastDrawn = k;
            if (resume) {
                prep.restore(resume.snap);
                fedTo = resume.fedTo;
            } else prep.begin?.();
        }
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
                if (decided) decided.fill(0, block.i0, block.i1);
                const feed = infill && k < lastDrawn && (!resume || k >= resume.k0);
                for (const r of kept) {
                    pushRow(r);
                    out.push(r);
                    if (decided && Number.isInteger(r.i)) decided[r.i] = r.mask & 15;
                    if (feed && r.i > fedTo) {
                        prep.step(r.i, 0, ctx, NO_RNGS, null, r.mask & 15);
                        fedTo = r.i;
                    }
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
                const chordW = chordWeights(family);
                const weightOf = Object.assign(
                    chordW ? (m) => guard.weight(m, i, family, ahead, fl) * chordW[popcount(m)] : (m) => guard.weight(m, i, family, ahead, fl),
                    { fallback: () => guard.fallback(i, family, ahead, fl) },
                );
                const offset = knob + adjustOf(i, scale);
                let mask;
                if (echoRun) {
                    // a repeated bar: the source bar's row of this build, through the guard (a veto is re-sampled)
                    const copy = echoCopy(echoRun.copyAt(i, decided), weightOf, () => prep.step(i, offset, ctx, rngs, weightOf));
                    if (copy.echoed) echoRun.stats.copied += 1;
                    if (copy.vetoed) echoRun.stats.vetoed += 1;
                    mask = copy.echoed && infill ? prep.step(i, offset, ctx, rngs, weightOf, copy.mask) : copy.mask;
                    decided[i] = mask & 15;
                } else {
                    mask = prep.step(i, offset, ctx, rngs, weightOf);
                }
                if (infill) fedTo = i;
                if (!mask || looseAt?.has(i)) continue; // a loose locked row is added at the end (an infill source returns it here)
                const row = { t: slot.t, mask, cols: maskToCols(mask), i, family, ...(fl ? { flavour: fl } : {}), ...(guard.forced > before ? { forced: true } : {}) };
                pushRow(row);
                out.push(row);
            }
        }
        if (debug && echoRun) {
            debug.echoStats ??= { copied: 0, vetoed: 0, dropped: 0, builds: 0 };
            for (const key of ["copied", "vetoed", "dropped"]) debug.echoStats[key] += echoRun.stats[key];
            debug.echoStats.builds += 1;
        }
        if (looseLocked.length) return [...out, ...looseLocked].sort((a, b) => a.t - b.t);
        return out;
    }

    // An infill source's state just before block k of a build whose rows before it are `before` (sorted by slot), with
    // the decoder already run up to there: builds that resume from it decode only from block k on (§5.2). The decoder
    // runs one beat at a time when a row is drawn, so a draw far below the knob (WARM_OFFSET: no row) at the last empty,
    // free slot before the block runs it up to that beat; rows on either side are passed as `fixed`, as a build does.
    const snapshots = infill && opts.snapshots !== false && typeof prep.snapshot === "function" && typeof prep.restore === "function";
    function snapshotAt(k, before = []) {
        const i0 = blocks[k].i0;
        prep.begin?.();
        const taken = new Set(before.map((r) => r.i));
        let j = i0 - 1;
        while (j >= 0 && (taken.has(j) || known[j] !== FREE)) j -= 1;
        let fed = -1;
        const feed = (r) => {
            if (r.i > fed && r.i < i0) {
                prep.step(r.i, 0, null, NO_RNGS, null, r.mask & 15);
                fed = r.i;
            }
        };
        for (const r of before) if (r.i < j) feed(r);
        if (j >= 0) {
            prep.step(j, WARM_OFFSET, null, NO_RNGS, null);
            fed = j;
        }
        for (const r of before) if (r.i > j) feed(r);
        return { k0: k, snap: prep.snapshot(), fedTo: fed };
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
        // an infill source decodes the song up to the part once; every attempt restarts from there
        const k0 = blocks.findIndex((b) => b.part === p);
        const resume = snapshots ? snapshotAt(k0) : null;
        const evaluate = async (knob, seed) => {
            const rows = build({ knobOf: () => knob, only: new Set([p]), seedOf: (b) => deriveSeed(seed, partSeed(b.part), b.inPart), echoSeed: seed, resume })
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
        const { best } = await searchRange({ evaluate, lo: part.range.lo, hi: part.range.hi, min: KNOB_MIN, max: Math.max(KNOB_MAX, boost?.knobMax ?? KNOB_MAX), seed: request.noteSeed, score, budget: nn2 ? NN2_BUDGET : PART_BUDGET });
        frozen.set(p, { knob: best.knob, rows: best.rows });
    }
    const baseFixed = new Map(lockedFixed);
    for (const [p, { rows }] of frozen) for (const b of blocks) if (b.part === p) baseFixed.set(b.index, blockRowsOf(rows, b));
    const knobOfWith = (knob) => (p) => frozen.get(p)?.knob ?? knob;

    // ---- one shared density for every other part ----
    const globalSearch = async ({ min, max, scale }) => {
        const evaluate = async (knob, seed) => {
            tick("search");
            const rows = build({ knobOf: knobOfWith(knob), fixed: baseFixed, seedOf: (b) => deriveSeed(seed, partSeed(b.part), b.inPart), scale, echoSeed: seed });
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
            const r = await searchRange({ evaluate, lo: range.lo, hi: range.hi, min, max, seed: request.noteSeed, score: mapScore, ...(nn2 ? { budget: NN2_BUDGET } : {}) });
            return { best: r.best, reachable: r.inRange };
        }
        return searchKnob({ evaluate, target: request.target, min, max, seed: request.noteSeed, ...(nn2 ? { budget: NN2_BUDGET } : {}) });
    };
    const span = locked && Number.isFinite(locked.knob)
        ? { min: Math.max(KNOB_MIN, locked.knob - LOCK_KNOB_SPAN), max: Math.min(KNOB_MAX, locked.knob + LOCK_KNOB_SPAN) }
        : nn2 ? { ...NN2_SPAN } : { min: KNOB_MIN, max: KNOB_MAX };
    if (!(locked && Number.isFinite(locked.knob))) {
        if (boost?.knobMax) span.max = Math.max(span.max, boost.knobMax);
        if (boost?.knobMin) span.min = Math.min(span.min, boost.knobMin);
    }
    let { best, reachable } = await globalSearch({ ...span, scale: 1 });

    // ---- far off: once more with room for denser light parts (and half the contrast) or for sparser notes ----
    let danRetry = null;
    if (range && !reachable && Number.isFinite(best.numeric)) {
        let again = null;
        if (best.numeric < range.lo - DAN_FAR) {
            danRetry = "low";
            again = await globalSearch({ min: span.min, max: Math.max(LOW_KNOB_MAX, span.max + LOW_KNOB_MAX - KNOB_MAX), scale: 0.5 });
        } else if (best.numeric > range.hi + DAN_FAR) {
            danRetry = "high";
            again = await globalSearch({ min: HIGH_KNOB_MIN, max: span.max, scale: 1 });
        }
        const gap = (a) => (a.numeric < range.lo ? range.lo - a.numeric : a.numeric >= range.hi ? a.numeric - range.hi : 0);
        if (again && (again.reachable || gap(again.best) < gap(best))) ({ best, reachable } = again);
    }
    let searched = { rows: best.rows, result: best.result, reachable };
    const chosenScale = best.scale ?? 1;
    const knobOf = knobOfWith(best.knob);

    // ---- N candidates at the chosen knob; the critic picks one (G1, §2.1). candidates: 1 skips all of it ----
    const free = blocks.some((b) => !baseFixed.has(b.index));
    let picked = { k: 0, seed: request.noteSeed, echoSeed: best.seed ?? request.noteSeed, rows: best.rows, result: best.result };
    let critic = null;
    let criticRun = null;
    let scoreRows = null;
    if (request.candidates > 1) {
        critic = resolveCritic(opts.critic);
        const personal = opts.personal ?? input.personal ?? null;
        const criticAudio = names.includes("onset")
            ? { names: features.names, rows: features.rows }
            : { onset: slotStrengths(envelope, slots), energy: slotEnergy(envelope, slots) };
        scoreRows = (rows) => {
            const x = criticFeatures(rows, slots, criticAudio, stems, structure, { dan: request.target });
            return { ...critic.score(x, { style, personal }), features: x };
        };
        const msdTarget = msdPriorOf(model, request.target, request.patterns);
        const wanted = labelKey(request.target);
        const insideOf = (n) => (range ? Number.isFinite(n) && n >= range.lo && n < range.hi : Number.isFinite(n) && labelKey(n) === wanted);
        criticRun = await pickCandidate({
            n: free ? request.candidates : 1,
            first: picked,
            build: (k) => {
                const seed = candidateSeed(request.noteSeed, k);
                const rowsK = build({ knobOf, fixed: baseFixed, seedOf: (b) => deriveSeed(seed, partSeed(b.part), b.inPart), scale: chosenScale, echoSeed: seed });
                return { seed, echoSeed: seed, rows: rowsK };
            },
            stage1: scoreRows,
            analyze: (rowsK) => analyze(render(rowsK, ""), 1),
            judge: (c) => ({
                inside: insideOf(numericOf(c.result)),
                patternScore: mapScore(c),
                msdFit: msdFit(msdVector(c.result?.msd), msdTarget),
                issues: findIssues(c.rows, slots).length,
            }),
            deadlineMs: opts.deadlineMs ?? input.deadlineMs ?? DEFAULT_DEADLINE_MS,
            now: opts.now ?? (() => performance.now()),
            onProgress,
        });
        picked = criticRun.winner;
        searched = { rows: picked.rows, result: picked.result, reachable: picked.k === 0 ? reachable : insideOf(numericOf(picked.result)) };
        if (debug) debug.candidates = criticRun.list.map((c) => ({ k: c.k, seed: c.seed, rows: c.rows, s1: c.s1.score, result: c.result ?? null }));
    }

    // ---- weak blocks are redone: low pattern score or an awkward spot; candidates judged by the pattern finder ----
    // (with candidates, also by the critic's stage 1 at RETRY_CRITIC_WEIGHT; the seeds follow the picked candidate's)
    let rows = picked.rows;
    const replaced = new Set();
    const retryable = (b) => !baseFixed.has(b.index);
    const blockValue = (all, b) => {
        const score = scoreBlock(all, b, { patternsOf, render: (r) => render(r, ""), ...(anyFlavour ? { assign } : {}) });
        const near = all.filter((r) => r.t >= b.startMs - 2000 && r.t < b.endMs + 2000);
        const issues = findIssues(near, slots).filter((x) => x.kind !== "columns" && x.t >= b.startMs && x.t < b.endMs);
        return { score, issues, value: (score ?? 1) - ISSUE_PENALTY * issues.length };
    };
    const criticTerm = (all) => (scoreRows ? RETRY_CRITIC_WEIGHT * scoreRows(all).score : 0);
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
            let bestValue = blockValue(rows, b).value + criticTerm(rows);
            let bestRows = null;
            // an infill source decodes up to the block once; each candidate re-decodes only the block
            const resume = snapshots ? snapshotAt(blocks.indexOf(b), rows.filter((r) => r.i < b.i0).sort((x, y) => x.i - y.i)) : null;
            for (let k = 0; k < RETRY_CANDIDATES; k += 1) {
                const seed = deriveSeed(picked.seed, partSeed(b.part), b.inPart, round + 1, k);
                const candidate = build({ knobOf, fixed, seedOf: () => seed, scale: chosenScale, echoSeed: picked.echoSeed, resume });
                const value = blockValue(candidate, b).value + criticTerm(candidate);
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
    // the critic's view of the map as it is now (after the block retry), with its feature vector for the store (§2.6)
    let criticOut = null;
    if (criticRun) {
        const s1 = rows === picked.rows ? picked.s1 : scoreRows(rows);
        const { features: x, ...heads } = s1;
        criticOut = { ...heads, picked: picked.k, of: criticRun.of, analysed: criticRun.analysed, ms: Math.round(criticRun.ms), features: Array.from(x) };
    }
    const styleUsed = style !== null && (model.stylePattern?.[style] !== undefined || model.styleBias?.[style] !== undefined
        || (Array.isArray(model.styles) && model.styles.some((x) => x?.key === style)) || Boolean(critic?.styles?.some((x) => x.key === style)));
    if (debug) {
        debug.structure = structure;
        debug.blocks = blocks;
        debug.assign = assign;
        debug.slots = slots;
        debug.known = known;
        debug.echo = echo ? { plan: echoPlan(structure, picked.echoSeed), echoSlot: echo.echoSlot, barOf: echo.barOf, seed: picked.echoSeed } : null;
        debug.retried = [...replaced];
    }
    return {
        osuText: render(rows, label),
        result,
        offset: best.knob,
        knob: best.knob,
        reachable: inRange,
        range,
        noteCount: rows.reduce((s, r) => s + popcount(r.mask), 0),
        version: `${label} ${patternNames}`.trim(),
        engine: String(model?.kind ?? "").startsWith("nn-") ? "neural" : "learned",
        ...(anyFlavour ? (({ patternScore: ps, familyScore, flavourScore }) => ({ patternScore: ps, familyScore, flavourScore }))(scoresOf(final))
            : { patternScore: mapScore(final) }),
        // the flavours our detector finds in the whole map (for the detailed view), whether asked for or not
        flavours: detectedFlavours(rows),
        planSeed: request.planSeed,
        noteSeed: picked.seed,
        stats: rowStats(rows, slots),
        issues: issues.slice(0, MAX_ISSUES),
        parts: reports,
        retries: { blocks: replaced.size, dan: danRetry, ...(reverted ? { reverted: true } : {}) },
        grid: gridShares(rows, slots),
        ...(criticOut ? { critic: criticOut } : {}),
        ...(structure ? { structure: structureToResponse(structure) } : {}),
        ...(styleUsed ? { style } : {}),
        ...(boost ? { boost } : {}),
    };
}

// The song structure, or null when it cannot be made (the stems are an optional extra: a failure here never stops
// the map; a model whose features need the structure then says so in slotFeatures).
function structureOf(args) {
    try {
        return songStructure(args);
    } catch {
        return null;
    }
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
