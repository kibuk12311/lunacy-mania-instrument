// Who pressed what. A replay only knows columns, so the player says which finger plays each column (the Replay tab keeps
// it; the two middle and two index fingers by default) and everything here is counted per finger and per hand: presses,
// judgements, UR, mean offset, top speed, jack speed, holds, how the timing moved from the start to the end, which finger
// breaks the combo. A number with too little behind it is null and is not shown; nothing here is ever a made-up zero.
// Works on the analysis of analyze.js (`results`, `ghosts`, `combo`) and the presses per column. Pure.
import { countKinds, accuracyPercent } from "./judge.js";
import { spread, unstableRate } from "./analyze.js";

// L = left, R = right; 1 the thumb … 5 the little finger, in the order of the hands on the keyboard.
export const FINGERS = Object.freeze(["L5", "L4", "L3", "L2", "L1", "R1", "R2", "R3", "R4", "R5"]);
export const DEFAULT_FINGERS = Object.freeze(["L3", "L2", "R2", "R3"]);

// Every threshold of this file.
export const STATS = Object.freeze({
    minHits: 10, // UR and mean offset of fewer hits than this say nothing
    speedWindowMs: 1000, // top speed: the most presses inside this long a stretch of real time
    jackMaxGapMs: 200, // notes of one column this close (real ms) are a jack…
    jackMinNotes: 3, // …from this many in a row
    driftMinHits: 12, // a third of the play needs this many hits to be compared
});

export const handOf = (finger) => (finger.startsWith("L") ? "left" : "right");

// What was remembered → four fingers, one per column; anything else → the default.
export function validFingers(list) {
    return Array.isArray(list) && list.length === DEFAULT_FINGERS.length && list.every((f) => FINGERS.includes(f)) ? [...list] : [...DEFAULT_FINGERS];
}

// The columns of each hand, for src/replay/manip.js: a hand with no column stays, empty.
export const handsOf = (fingers) => ["left", "right"].map((id) => ({
    id, columns: fingers.flatMap((f, c) => (handOf(f) === id ? [c] : [])),
}));

const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

// The most presses inside windowMs of real time, as presses a second; null with none. times: sorted, ms of the map.
export function topSpeed(times, rate = 1, windowMs = STATS.speedWindowMs) {
    if (!times.length) return null;
    const span = windowMs * rate;
    let best = 0;
    let from = 0;
    for (let i = 0; i < times.length; i += 1) {
        while (times[i] - times[from] >= span) from += 1;
        best = Math.max(best, i - from + 1);
    }
    return round1(best / (windowMs / 1000));
}

// The jacks of one column: its notes (sorted, judged) in runs written at most jackMaxGapMs apart, jackMinNotes or more.
// → { runs, notes, bestMs, bestBpm, bestNotes, bestAt } or null without any. bestMs: the mean real gap between the presses
// of the fastest run played whole; bestBpm: the same as 1/4 notes, the way jacks are spoken of. null when none was whole.
export function jackRuns(own, rate = 1, limits = STATS) {
    const runs = [];
    let run = [];
    const close = () => {
        if (run.length >= limits.jackMinNotes) runs.push(run);
        run = [];
    };
    for (const r of own) {
        const last = run.at(-1);
        if (last && (r.t - last.t) / rate > limits.jackMaxGapMs) close();
        run.push(r);
    }
    close();
    if (!runs.length) return null;
    let best = null;
    for (const list of runs) {
        if (list.some((r) => r.press === null)) continue;
        const ms = (list.at(-1).press - list[0].press) / (list.length - 1) / rate;
        if (ms > 0 && (best === null || ms < best.ms)) best = { ms, notes: list.length, at: list[0].t };
    }
    return {
        runs: runs.length, notes: runs.reduce((sum, list) => sum + list.length, 0),
        bestMs: best ? round1(best.ms) : null, bestBpm: best ? Math.round(15000 / best.ms) : null, bestNotes: best?.notes ?? null, bestAt: best?.at ?? null,
    };
}

// The holds of a group: { count, clean, early, late, dropped, meanRelease, earlyMean, lateMean }, null without holds.
// A release counts as early or late when it is further from the hold's end than the 300 window; meanRelease: real ms,
// − before the end. dropped: holds judged a miss. Holds never let go have no release to count.
export function holdStats(own, windows, rate = 1) {
    const holds = own.filter((r) => r.end !== null);
    if (!holds.length) return null;
    const limit = windows.n300 / rate;
    const tails = holds.filter((r) => r.press !== null && r.up !== null && r.up !== undefined).map((r) => (r.up - r.end) / rate);
    const early = tails.filter((v) => v < -limit);
    const late = tails.filter((v) => v > limit);
    return {
        count: holds.length, clean: tails.length - early.length - late.length, early: early.length, late: late.length,
        dropped: holds.filter((r) => r.kind === "miss").length,
        meanRelease: round1(spread(tails).mean), earlyMean: round1(spread(early).mean), lateMean: round1(spread(late).mean),
    };
}

// The first against the last third of the play: { first: { mean, ur }, last: { mean, ur }, meanChange, urChange }; null
// when either third has too few hits.
export function driftOf(hits, fromMs, toMs, minHits = STATS.driftMinHits) {
    const third = (toMs - fromMs) / 3;
    const of = (list) => (list.length >= minHits ? { mean: round1(spread(list).mean), ur: unstableRate(list) } : null);
    const first = of(hits.filter((r) => r.t < fromMs + third).map((r) => r.delta));
    const last = of(hits.filter((r) => r.t >= toMs - third).map((r) => r.delta));
    if (!first || !last) return null;
    return { first, last, meanChange: round1(last.mean - first.mean), urChange: round1(last.ur - first.ur) };
}

// One group of columns (a finger or a hand).
function groupStats(analysis, presses, columns, context) {
    const { results, ghosts, rate, windows, fromMs, reachedMs } = analysis;
    const inGroup = (r) => columns.includes(r.col);
    const own = results.filter(inGroup);
    const times = columns.flatMap((c) => (presses[c] ?? []).map((p) => p.t)).filter((v) => v >= context.fromPress && v <= context.toPress).sort((a, b) => a - b);
    const hits = own.filter((r) => r.delta !== null);
    const deltas = hits.map((r) => r.delta);
    const enough = deltas.length >= STATS.minHits;
    const counts = countKinds(own);
    const jacks = columns.map((c) => jackRuns(own.filter((r) => r.col === c), rate)).filter(Boolean);
    const fastest = jacks.filter((j) => j.bestMs !== null).sort((a, b) => a.bestMs - b.bestMs)[0] ?? null;
    return {
        columns, notes: own.length, presses: times.length, share: percentOf(times.length, context.presses),
        counts, accuracy: accuracyPercent(counts), misses: counts.miss,
        ur: enough ? unstableRate(deltas) : null, mean: enough ? round1(spread(deltas).mean) : null,
        early: enough ? percentOf(deltas.filter((d) => d < 0).length, deltas.length) : null,
        late: enough ? percentOf(deltas.filter((d) => d > 0).length, deltas.length) : null,
        topSpeed: topSpeed(times, rate),
        jack: jacks.length ? {
            runs: jacks.reduce((sum, j) => sum + j.runs, 0), notes: jacks.reduce((sum, j) => sum + j.notes, 0),
            bestMs: fastest?.bestMs ?? null, bestBpm: fastest?.bestBpm ?? null, bestNotes: fastest?.bestNotes ?? null, bestAt: fastest?.bestAt ?? null,
        } : null,
        holds: holdStats(own, windows, rate),
        drift: driftOf(hits, fromMs, reachedMs),
        breaks: analysis.combo.breaks.filter(inGroup).length,
        ghosts: ghosts.filter(inGroup).length,
    };
}

// → { fingers: [{ finger, hand, ...group }] left to right, hands: { left, right } (null for a hand with no column),
// balance: { presses, notes (the left hand's share in %), leftAhead (ms the left hand is earlier than the right, null
// without both means) }, breaker: the finger that broke the combo most (null when it was never broken) }.
export function fingerReport(analysis, presses, fingers) {
    const { windows, fromMs, reachedMs } = analysis;
    const fromPress = fromMs - windows.miss;
    const toPress = reachedMs + windows.miss;
    const all = presses.flat().filter((p) => p.t >= fromPress && p.t <= toPress).length;
    const context = { fromPress, toPress, presses: all };
    const list = FINGERS.filter((f) => fingers.includes(f)).map((finger) => ({
        finger, hand: handOf(finger), ...groupStats(analysis, presses, fingers.flatMap((f, c) => (f === finger ? [c] : [])), context),
    }));
    const hands = Object.fromEntries(handsOf(fingers).map(({ id, columns }) => [id, columns.length ? groupStats(analysis, presses, columns, context) : null]));
    const { left, right } = hands;
    const breaker = list.reduce((best, f) => (f.breaks > (best?.breaks ?? 0) ? f : best), null);
    return {
        fingers: list, hands, breaker: breaker ? { finger: breaker.finger, breaks: breaker.breaks, of: analysis.combo.breaks.length } : null,
        balance: left && right ? {
            presses: percentOf(left.presses, left.presses + right.presses), notes: percentOf(left.notes, left.notes + right.notes),
            leftAhead: left.mean !== null && right.mean !== null ? round1(right.mean - left.mean) : null,
        } : null,
    };
}
