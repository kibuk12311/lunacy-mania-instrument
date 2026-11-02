// What stands out in a play, in plain words: the hints at the top of the Replay tab's folds and the block above the first
// one. Rule based: each rule reads numbers the tab already shows and says something only when they stand out, so a play with
// nothing to say gets no hint, and there is no filler. A replay shows what happened, not why: the texts
// (src/i18n/messages/replay.js, "replay.hint.*") word a guessed cause as a guess. Every limit lives in HINTS below, set on a
// player's own replays so that a rule fires on the plays out of that player's ordinary, not on most. What a play cannot carry
// is not said: a number with too little behind it (every rule has a minimum), a count chance gives by itself (chanceOf), what
// falls together counted as if it fell apart (momentsOf), a play cut short for what needs the whole map, ScoreV2 for what it
// counts differently, per-note counts on a hold-heavy map whose recount is not exact (src/replay/judge.js), manip that is plain
// scatter or stands on too few pairs (isLoose, isThin). An Interlude play (src/replay/analyzeInterlude.js) is judged by its
// own ruleset, exactly: its points stand for osu!'s, its judgements are named by the ruleset, and what only osu! has
// (HitPosition, OD) is not said of it.
// Pure.
import { labelKey } from "../core/labels.js";
import { KINDS, accuracyPercent } from "./judge.js";
import { chancePercent, isLoose, isThin } from "./manip.js";
import { familyLine } from "./report.js";
import { PACE, shapeAt } from "./flow.js";

const frozen = (limits) => Object.freeze(Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, typeof v === "object" ? Object.freeze(v) : v])));

// weight: how much a rule counts against the others when the strongest of a play are picked; strongest: how far over its
// limit a number can pull a hint up, so that one extreme number does not bury the rest.
export const HINTS = frozen({
    perSection: 2, // hints at the top of a fold
    top: 3, // hints in the block above the folds
    strongest: 3,
    momentSec: 1, // what falls this many seconds of play apart or closer is one moment
    judgements: { weight: 1, minNotes: 100, minMisses: 5, minLost: 1, minShare: 0.16, mostShare: 0.5 },
    fingers: { weight: 1, minHits: 100, minGap: 45, minRatio: 1.18, minBreaks: 2 },
    hands: { weight: 0.9, minHits: 200, minMs: 6, minChords: 20 },
    // maxChance, here and below: how likely as many on one hand, family, density, column, shape or part are if they fell anywhere.
    // A hand or a family takes minRuns runs of glued pairs. runSec: pairs this far apart or closer are one run, neighbours and no
    // more: at momentSec a play's glue is a run or two and next to nothing can stand out. A family's runs sit in the stretches of
    // that family, so they make a smaller chance than a hand's (maxHandChance) to stand as much.
    manip: { weight: 0.9, minFamilies: 2, minPercent: 15, forgivenShare: 0.8, minHandPercent: 10, minHandGap: 5, minPartPercent: 15, minPartGap: 10, minRuns: 3, runSec: 0.25, maxChance: 0.001, maxHandChance: 0.02 },
    errors: { weight: 1, minHits: 50, minColumns: 3, minMs: 8 },
    // up to `plays` newest plays (app/replayIpc.js), each with minHits: at least minPlays on minMaps different maps, minMs off on
    // average, and minShare of them leaning that way by minEachMs. hitLow, hitHigh: where HitPosition ends.
    position: { weight: 1.4, plays: 10, minHits: 200, minPlays: 6, minMaps: 5, minMs: 4, minEachMs: 2, minShare: 0.7, hitLow: 240, hitHigh: 480 },
    // minFatigueHits, minSlideHits: hits in each of the two thirds compared. Chance moves their means sooner than their UR.
    drift: { weight: 1, minRise: 65, minRatio: 1.3, denser: 1.2, minSlide: 4.5, minFatigueHits: 60, minSlideHits: 240 },
    // ceiling: at least minSec seconds on each side of it, minLost notes left unpressed at it and above, in at least minMoments
    // moments, minAbove of those notes against at most maxUnder of those under it
    pace: { weight: 1.1, minSec: 10, minLost: 5, minMoments: 3, minAbove: 0.008, maxUnder: 0.003, maxChance: 0.05, minBehindSec: 4 },
    holds: { weight: 1, minHolds: 15, minCount: 4, minLate: 0.13, minEarly: 0.2 },
    ghosts: { weight: 0.8, minTotal: 12, minColumnShare: 0.55, minFlowShare: 0.6, maxChance: 0.01 },
    // minOnShape: breaks on the shape, in at least minMoments moments; minLift: how many times more of the breaks are on it than of
    // the notes; shapeNotes: the notes looked at to tell that, a longer map is sampled. partMomentSec, minPartMoments: a part is a
    // stretch of the map, so a stumble stays in it to its last break where a shape changes under it, and a part is the top of
    // several: it takes a longer gap between moments and more of them.
    breaks: { weight: 1.2, minBreaks: 5, minOnShape: 4, minMoments: 3, minShare: 0.5, minLift: 1.2, minCause: 0.6, maxChance: 0.02, shapeNotes: 20_000, minParts: 3, minInPart: 4, partShare: 0.6, partMomentSec: 2, minPartMoments: 6 },
    hardest: { weight: 1.2, minNotes: 50, minDelta: 3.5 },
    parts: { weight: 1, minParts: 3, minNotes: 50, minDrop: 4.5 },
    families: { weight: 1, minNotes: 100, minGap: 90, minRatio: 1.55 },
    earlier: { weight: 1, minPlays: 2, plays: 3, sameAccuracy: 0.5, minUr: 10 },
});

const round1 = (x) => Math.round(x * 10) / 10;
const sumOf = (list) => list.reduce((a, b) => a + b, 0);
const meanOf = (list) => sumOf(list) / list.length;
const most = (list, value) => list.reduce((best, item) => (value(item) > value(best) ? item : best));
const least = (list, value) => most(list, (item) => -value(item));
const hitsOf = (group) => group.notes - group.misses;
// the mean of a group's numbers over its members, each counted by its own size
const weighted = (list, value, size) => sumOf(list.map((item) => value(item) * size(item))) / sumOf(list.map(size));
// how many of a list have each value of a field: [[value, count]]
const counted = (list, key) => {
    const out = new Map();
    for (const item of list) out.set(item[key], (out.get(item[key]) ?? 0) + 1);
    return [...out];
};

// { id, section, key, params, weight, seek? }: seek, ms of the map, for a hint with a place on it.
function hint(id, section, key, params, weight, seek) {
    return { id, section, key, params, weight: Math.round(weight * 100) / 100, ...(seek === undefined ? {} : { seek }) };
}
// How far over its limit a number stands: 1 at the limit, at most `strongest`.
const over = (value, limit, limits) => (limit > 0 ? Math.min(limits.strongest, value / limit) : limits.strongest);
// What falls together, notes lost in one stumble, breaks, glued pairs: `at` gives a thing's second of play. → [moment: its
// things in order], with gapSec or less between neighbours. A count that repeats goes by these: the things of one moment
// fall together, so held against chance one by one they would be as many chances as there are things, and there is one.
function momentsOf(list, at, gapSec) {
    const out = [];
    let last = null;
    for (const item of [...list].sort((a, b) => at(a) - at(b))) {
        if (last === null || at(item) - last > gapSec) out.push([]);
        out.at(-1).push(item);
        last = at(item);
    }
    return out;
}
// A thing's second of play, from its ms of the map.
const secondOf = ({ rate }) => ({ t }) => t / rate / 1000;
// How many moments have most of what is in them on a side, each thing counted by its size. The moments are grouped once, over
// everything: grouped apart, a side could part a moment and count more of them than there are, which chanceOf takes for none.
const momentsOn = (moments, on, size = () => 1) => moments.filter((moment) => sumOf(moment.filter(on).map(size)) * 2 > sumOf(moment.map(size))).length;

// How likely at least k of n land by chance on what takes the share q of all (the sum of the binomial's tail, in logs for
// the n of a long play).
function chanceOf(k, n, q) {
    if (q >= 1) return 1;
    let log = n * Math.log1p(-q);
    let sum = 0;
    for (let i = 0; i <= n; i += 1) {
        if (i >= k) sum += Math.exp(log);
        log += Math.log((n - i) / (i + 1)) + Math.log(q / (1 - q));
    }
    return Math.min(1, sum);
}

// What an Interlude play lost, by its ruleset's points (src/replay/analyzeInterlude.js): each judgement is worth at most 1,
// so a note lost its weight less its points; a miss can lose more than its own share (SC takes points away for one).
// What was lost in all is the play's own: 100 % less its accuracy, out of every judgement it got, those of presses that
// met no note too (a ruleset with a GhostTapJudgement scores them). → { total, misses, lost, onMisses } (judgements,
// misses, and the two in % of the accuracy).
function lostByPoints(analysis) {
    const total = sumOf(analysis.judgementCounts ?? []);
    if (!total || analysis.accuracy === null || analysis.accuracy === undefined) return null;
    let onMisses = 0;
    let misses = 0;
    for (const r of analysis.results) {
        if (r.kind === "miss") {
            misses += 1;
            onMisses += r.weight - r.points;
        }
    }
    return { total, misses, lost: 100 - analysis.accuracy, onMisses: (onMisses / total) * 100 };
}

// osu!'s from the header's counts, its own, so it needs no map; Interlude's from the recount, which is its own too, in
// words of its own: what is lost can pass 100 % there, so it says how far the accuracy is from 100 %.
function lostToMisses({ replay, analysis, facts }, limits) {
    const own = limits.judgements;
    if (facts.scoreV2 || !facts.whole) return null;
    const il = analysis?.source === "interlude";
    let total;
    let missCount;
    let lost;
    let misses;
    if (il) {
        const byPoints = lostByPoints(analysis);
        if (!byPoints) return null;
        ({ total, misses: missCount, lost, onMisses: misses } = byPoints);
    } else {
        const counts = replay?.counts;
        if (!counts) return null;
        total = sumOf(KINDS.map((k) => counts[k]));
        missCount = counts.miss;
        lost = 100 - accuracyPercent(counts);
        misses = (counts.miss / total) * 100;
    }
    if (total < own.minNotes || missCount < own.minMisses) return null;
    const share = misses / lost;
    if (lost < own.minLost || share < own.minShare) return null;
    const mostly = share >= own.mostShare;
    const key = il ? (mostly ? "replay.hint.judge.mostlyMissesIl" : "replay.hint.judge.missesIl") : mostly ? "replay.hint.judge.mostlyMisses" : "replay.hint.judge.misses";
    return hint("judgements.misses", "judgements", key, { lost: round1(lost), misses: round1(misses) }, own.weight * over(share, own.minShare, limits));
}

function unevenFinger({ report, facts }, limits) {
    const own = limits.fingers;
    const steady = report.fingers.filter((f) => f.ur !== null && hitsOf(f) >= own.minHits);
    if (steady.length < 2) return null;
    const worst = most(steady, (f) => f.ur);
    const others = meanOf(steady.filter((f) => f !== worst).map((f) => f.ur));
    const gap = worst.ur - others;
    if (gap < own.minGap || worst.ur / others < own.minRatio) return null;
    const weight = own.weight * over(gap, own.minGap, limits);
    const params = { finger: worst.finger, gap: Math.round(gap) };
    if (facts.exact && worst.breaks >= own.minBreaks) {
        return hint("fingers.uneven", "fingers", "replay.hint.finger.unevenBreaks", { ...params, breaks: worst.breaks, of: report.breaks.length }, weight);
    }
    return hint("fingers.uneven", "fingers", "replay.hint.finger.uneven", params, weight);
}

// Rows with notes of both hands.
function chordRows(results, { left, right }) {
    const rows = new Map();
    for (const r of results) {
        const side = left.columns.includes(r.col) ? 1 : right.columns.includes(r.col) ? 2 : 0;
        rows.set(r.t, (rows.get(r.t) ?? 0) | side);
    }
    return [...rows.values()].filter((sides) => sides === 3).length;
}

function handAhead({ report, analysis }, limits) {
    const own = limits.hands;
    const { balance, hands } = report;
    const ahead = balance?.leftAhead ?? null;
    if (ahead === null || hitsOf(hands.left) < own.minHits || hitsOf(hands.right) < own.minHits || Math.abs(ahead) < own.minMs) return null;
    const chords = chordRows(analysis.results, hands) >= own.minChords;
    const key = ahead > 0 ? (chords ? "replay.hint.hand.leftChords" : "replay.hint.hand.left") : (chords ? "replay.hint.hand.rightChords" : "replay.hint.hand.right");
    return hint("hands.ahead", "hands", key, { ms: round1(Math.abs(ahead)) }, own.weight * over(Math.abs(ahead), own.minMs, limits));
}

// A group of pairs whose percent can stand: not thin, not plain scatter at this play's spread.
const standsUp = (tally, pairs, sd) => tally.pairs > 0 && !isThin(tally.pairs) && !isLoose(tally.percent, chancePercent(pairs, sd));
// Whether a group of pairs is glued more than the play's own percent gives by itself: a pair or two more is no more than that.
// Glued pairs come in runs, so it takes separate runs, and no more of them than its share of the pairs would catch anyway.
function standsOut(group, maxChance, { report, analysis }, { manip: own }) {
    const runs = momentsOf(report.pairs.filter((p) => p.glued), secondOf(analysis), own.runSec);
    const inGroup = new Set(group);
    const on = momentsOn(runs, (p) => inGroup.has(p));
    return on >= own.minRuns && chanceOf(on, runs.length, group.length / report.pairs.length) <= maxChance;
}

// How much of the glued notes were judged 300 or better (an Interlude play: its ruleset's judgements in those two slots):
// the window let them through.
function forgiven(pairs, results) {
    const kinds = new Map(results.map((r) => [`${r.t}:${r.col}`, r.kind]));
    const notes = pairs.filter((p) => p.glued).flatMap((p) => [kinds.get(`${p.t}:${p.col}`), kinds.get(`${p.tb}:${p.colb}`)]);
    return notes.length ? notes.filter((kind) => kind === "max" || kind === "n300").length / notes.length : 0;
}

// The worst of an Interlude ruleset's judgements that forgiven counts, by its name: what such notes still got.
const forgivenName = (ruleset) => (ruleset?.judgements ?? []).filter((j) => j.slot === "max" || j.slot === "n300").at(-1)?.name ?? null;

function gluedFamily({ report, analysis, later }, limits) {
    const own = limits.manip;
    if (!later) return null;
    const familyAt = familyLine(later, analysis.fromMs);
    const pairsOf = (family) => report.pairs.filter((p) => familyAt(p.t) === family);
    const counts = report.families.filter((f) => f.pairs > 0 && !isThin(f.pairs));
    if (counts.length < own.minFamilies) return null;
    const solid = counts.filter((f) => standsUp(f, pairsOf(f.family), analysis.sd));
    if (!solid.length) return null;
    const top = most(solid, (f) => f.percent);
    if (top.percent < own.minPercent || !standsOut(pairsOf(top.family), own.maxChance, { report, analysis }, limits)) return null;
    const weight = own.weight * over(top.percent, own.minPercent, limits);
    const params = { families: top.family, percent: Math.round(top.percent) };
    if (forgiven(pairsOf(top.family), analysis.results) < own.forgivenShare) return hint("manip.family", "manip", "replay.hint.manip.family", params, weight);
    // osu!'s text speaks of a stricter OD and 100s; an Interlude ruleset has no OD, so it has a text of its own, given the
    // ruleset's judgement those notes still got
    if (analysis.source === "interlude") return hint("manip.family", "manip", "replay.hint.manip.familyForgivenIl", { ...params, judgement: forgivenName(analysis.ruleset) }, weight);
    return hint("manip.family", "manip", "replay.hint.manip.familyForgiven", params, weight);
}

function gluedHand({ report, analysis }, limits) {
    const own = limits.manip;
    const { left, right } = report.manip.hands;
    if (!left.pairs || !right.pairs || isThin(left.pairs) || isThin(right.pairs)) return null;
    const [id, top, low] = left.percent >= right.percent ? ["left", left, right] : ["right", right, left];
    const gap = top.percent - low.percent;
    const pairs = report.pairs.filter((p) => p.hand === id);
    if (top.percent < own.minHandPercent || gap < own.minHandGap || !standsOut(pairs, own.maxHandChance, { report, analysis }, limits) || !standsUp(top, pairs, analysis.sd)) return null;
    return hint("manip.hand", "manip", id === "left" ? "replay.hint.manip.leftHand" : "replay.hint.manip.rightHand", { percent: Math.round(top.percent), other: Math.round(low.percent) }, own.weight * over(gap, own.minHandGap, limits));
}

function gluedPart({ report, analysis }, limits) {
    const own = limits.manip;
    const solid = report.parts.filter((p) => standsUp(p, report.pairs.filter((pair) => pair.t >= p.fromMs && pair.t < p.toMs), analysis.sd));
    if (solid.length < 2) return null;
    const top = most(solid, (p) => p.percent);
    const gap = top.percent - report.manip.percent;
    if (top.percent < own.minPartPercent || gap < own.minPartGap) return null;
    return hint("manip.part", "manip", "replay.hint.manip.part", { from: top.fromMs, to: top.toMs, percent: Math.round(top.percent) }, own.weight * over(gap, own.minPartGap, limits), top.fromMs);
}

// Where the headline number is plain scatter or stands on too few pairs, no hint says otherwise.
const whenManip = (rule) => (data, limits) => (data.report.manip.pairs && !data.report.manip.thin && !data.report.manip.loose ? rule(data, limits) : null);

function columnBias({ analysis }, limits) {
    const own = limits.errors;
    const columns = analysis.byColumn.filter((c) => c.mean !== null && c.hits >= own.minHits);
    if (columns.length < own.minColumns) return null;
    const gapOf = (c) => c.mean - meanOf(columns.filter((other) => other !== c).map((other) => other.mean));
    const top = most(columns, (c) => Math.abs(gapOf(c)));
    const gap = gapOf(top);
    if (Math.abs(gap) < own.minMs) return null;
    return hint("errors.column", "errors", gap > 0 ? "replay.hint.err.columnLate" : "replay.hint.err.columnEarly", { col: top.col + 1, ms: round1(Math.abs(gap)) }, own.weight * over(Math.abs(gap), own.minMs, limits));
}

// A lean of the last plays, never of one. HitPosition's step is not told, only its way: the scroll speed behind a step is a
// community measurement, not verified for stable. At the end of HitPosition's range only the offset is left to try.
// HitPosition is osu!'s skin: an Interlude play gets none of this.
function hitPosition({ bias, analysis = null }, limits) {
    const own = limits.position;
    if (analysis?.source === "interlude") return null;
    const plays = bias?.plays ?? [];
    if (plays.length < own.minPlays || new Set(plays.map((p) => p.md5)).size < own.minMaps) return null;
    const mean = meanOf(plays.map((p) => p.mean));
    const late = mean > 0;
    const leaning = plays.filter((p) => (late ? p.mean : -p.mean) >= own.minEachMs).length / plays.length;
    if (Math.abs(mean) < own.minMs || leaning < own.minShare) return null;
    const hit = bias.position?.hitPosition ?? null;
    const atEnd = hit !== null && (late ? hit >= own.hitHigh : hit <= own.hitLow);
    const key = atEnd ? (late ? "replay.hint.position.lateEnd" : "replay.hint.position.earlyEnd")
        : hit === null ? (late ? "replay.hint.position.lateUnknown" : "replay.hint.position.earlyUnknown")
            : late ? "replay.hint.position.late" : "replay.hint.position.early";
    return hint("errors.position", "errors", key, { ms: Math.round(Math.abs(mean)), ...(hit === null ? {} : { hit }) }, own.weight * over(Math.abs(mean), own.minMs, limits));
}

// Whether the lean of the latest plays tells anything: it feeds this one rule, so an answer that does not needs no redraw.
export const biasTells = (bias, limits = HINTS) => hitPosition({ bias }, limits) !== null;

// UR rising towards the end: the map's own doing when its end is denser.
function fatigue({ report, analysis, facts }, limits) {
    const own = limits.drift;
    const { drift } = report;
    if (!facts.whole || !drift?.first || !drift.last) return null;
    const { first, last, urChange } = drift;
    if (Math.min(first.hits, last.hits) < own.minFatigueHits || urChange < own.minRise || last.ur / first.ur < own.minRatio) return null;
    const third = (analysis.reachedMs - analysis.fromMs) / 3;
    const start = analysis.results.filter((r) => r.t < analysis.fromMs + third).length;
    const end = analysis.results.filter((r) => r.t >= analysis.reachedMs - third).length;
    const key = end >= start * own.denser ? "replay.hint.drift.denser" : "replay.hint.drift.tired";
    return hint("drift.fatigue", "drift", key, { start: Math.round(first.ur), end: Math.round(last.ur) }, own.weight * over(urChange, own.minRise, limits));
}

function slide({ report, facts }, limits) {
    const own = limits.drift;
    const { first, last, meanChange: change } = report.drift ?? {};
    if (!facts.whole || !first || !last || Math.min(first.hits, last.hits) < own.minSlideHits || Math.abs(change) < own.minSlide) return null;
    return hint("drift.slide", "drift", change > 0 ? "replay.hint.drift.later" : "replay.hint.drift.earlier", { ms: Math.round(Math.abs(change)) }, own.weight * over(Math.abs(change), own.minSlide, limits));
}

// The seconds of the play: notes, those left unpressed (an early miss was pressed, only too soon), and the density around them,
// as paceLine smooths it.
function secondsOf({ written }, { results, rate, fromMs }) {
    const reach = (PACE.smoothSec - 1) / 2;
    const out = written.map((_, i) => ({ at: i, notes: 0, lost: 0, density: meanOf(written.slice(Math.max(0, i - reach), i + reach + 1)) }));
    for (const r of results) {
        const second = out[Math.floor((r.t - fromMs) / rate / 1000)];
        if (!second) continue;
        second.notes += 1;
        if (r.press === null && !r.early) second.lost += 1;
    }
    return out;
}

// Where notes stop being pressed: the density, in whole notes a second, that best parts the seconds where next to nothing is
// left unpressed from those where notes are. It says the thing repeats, so it takes separate moments over it, and no more of
// them than the notes there would catch anyway: a map with few notes under a low density leaves them all over it. A collapse
// that ends a failed play is no ceiling.
function paceCeiling({ report, analysis, facts }, limits) {
    const own = limits.pace;
    const { pace } = report;
    if (!pace || !facts.exact || !facts.whole) return null;
    const seconds = secondsOf(pace, analysis);
    const lostIn = (list) => sumOf(list.map((s) => s.lost));
    const notesIn = (list) => sumOf(list.map((s) => s.notes));
    const shareIn = (list) => lostIn(list) / Math.max(1, notesIn(list));
    const moments = momentsOf(seconds.filter((s) => s.lost), (s) => s.at, limits.momentSec);
    let best = null;
    for (let keep = 1; keep <= pace.peakWritten; keep += 1) {
        const dense = seconds.filter((s) => s.density >= keep);
        const calm = seconds.filter((s) => s.density < keep);
        if (dense.length < own.minSec || calm.length < own.minSec || lostIn(dense) < own.minLost) continue;
        const above = shareIn(dense);
        const under = shareIn(calm);
        if (above < own.minAbove || under > own.maxUnder || (best && above - under <= best.above - best.under)) continue;
        const high = momentsOn(moments, (s) => s.density >= keep, (s) => s.lost);
        if (high >= own.minMoments && chanceOf(high, moments.length, notesIn(dense) / notesIn(seconds)) <= own.maxChance) best = { keep, above, under, dense };
    }
    if (!best) return null;
    const first = best.dense.find((s) => s.lost);
    return hint("pace.ceiling", "pace", "replay.hint.pace.ceiling", { keep: best.keep }, own.weight * over(best.above, own.minAbove, limits), first.at * 1000 * analysis.rate + analysis.fromMs - 500);
}

// A stretch of falling behind worth saying: a pass rarely has one, and then it is a place to look at.
function paceBehind({ report, analysis }, limits) {
    const own = limits.pace;
    const behind = report.pace ? report.pace.stretches.filter((s) => s.kind === "behind") : [];
    if (!behind.length) return null;
    const longest = most(behind, (s) => s.toSec - s.fromSec);
    const seconds = longest.toSec - longest.fromSec;
    if (seconds < own.minBehindSec) return null;
    const msOf = (sec) => sec * 1000 * analysis.rate + analysis.fromMs;
    return hint("pace.behind", "pace", "replay.hint.pace.behind", { from: msOf(longest.fromSec), to: msOf(longest.toSec), played: longest.played, written: longest.written }, own.weight * over(seconds, own.minBehindSec, limits), msOf(longest.fromSec) - 500);
}

const holdHint = (id, key, side, sideMean, minShare) => ({ report, facts }, limits) => {
    const own = limits.holds;
    const list = report.fingers.filter((f) => f.holds).map((f) => f.holds);
    const count = sumOf(list.map((h) => h.count));
    const n = sumOf(list.map((h) => h[side]));
    if (!facts.exact || count < own.minHolds || n < own.minCount || n / count < own[minShare]) return null;
    const mean = weighted(list.filter((h) => h[side]), (h) => h[sideMean], (h) => h[side]);
    return hint(id, "holds", key, { n, of: count, ms: Math.round(Math.abs(mean)) }, own.weight * over(n / count, own[minShare], limits));
};

function ghostColumn({ report }, limits) {
    const own = limits.ghosts;
    const { ghosts } = report;
    if (!ghosts || ghosts.total < own.minTotal) return null;
    const n = Math.max(...ghosts.byColumn);
    if (n / ghosts.total < own.minColumnShare || ghosts.inFlow / ghosts.total < own.minFlowShare || chanceOf(n, ghosts.total, 1 / ghosts.byColumn.length) > own.maxChance) return null;
    return hint("ghosts.column", "ghosts", "replay.hint.ghost.column", { n, of: ghosts.total, col: ghosts.byColumn.indexOf(n) + 1 }, own.weight * over(n / ghosts.total, own.minColumnShare, limits));
}

// The causes with a text of their own ("off" only an Interlude ruleset gives, flow.js); any other is told by its shape alone.
const CAUSE_KEY = { none: "replay.hint.break.none", early: "replay.hint.break.early", released: "replay.hint.break.released", off: "replay.hint.break.off" };

// How much of the notes are of a shape, by every few notes on a long map: that tells it as well, in a fraction of the time.
function shareOfShape({ results, rate }, shape, notes) {
    const step = Math.ceil(results.length / notes);
    let seen = 0;
    let on = 0;
    for (let i = 0; i < results.length; i += step) {
        seen += 1;
        if (shapeAt(results, i, rate) === shape) on += 1;
    }
    return on / seen;
}

// The shape most breaks are on, when that is the shape's doing and not simply what the map is made of. The text tells the breaks,
// but whether it stands goes by separate moments on the shape, so that one stumble is not told as the shape's doing. A cause
// worded counts only the breaks that had it, and takes as many of them as the shape does.
function breakShape({ report, analysis, facts }, limits) {
    const own = limits.breaks;
    const { breaks } = report;
    if (!facts.exact || breaks.length < own.minBreaks) return null;
    const shaped = breaks.filter((b) => b.shape);
    if (!shaped.length) return null;
    const [shape, n] = most(counted(shaped, "shape"), ([, count]) => count);
    const share = n / breaks.length;
    if (n < own.minOnShape || share < own.minShare) return null;
    const written = shareOfShape(analysis, shape, own.shapeNotes);
    const moments = momentsOf(breaks, secondOf(analysis), limits.momentSec);
    const on = momentsOn(moments, (b) => b.shape === shape);
    if (share / written < own.minLift || on < own.minMoments || chanceOf(on, moments.length, written) > own.maxChance) return null;
    const [cause, sure] = most(counted(shaped.filter((b) => b.shape === shape), "cause"), ([, count]) => count);
    const worded = CAUSE_KEY[cause] !== undefined && sure >= own.minOnShape && sure / n >= own.minCause;
    return hint("breaks.shape", "breaks", worded ? CAUSE_KEY[cause] : "replay.hint.break.shape", { n: worded ? sure : n, of: breaks.length, shape }, own.weight * over(share / written, own.minLift, limits));
}

// The part most breaks are in, as breakShape goes by separate moments: one stumble is a place the tab shows as it is, not a part
// that takes the breaks of the play.
function breakPart({ report, analysis, facts }, limits) {
    const own = limits.breaks;
    const { breaks, parts } = report;
    if (!facts.exact || breaks.length < own.minBreaks || parts.length < own.minParts) return null;
    const top = most(parts.map((part) => ({ part, own: breaks.filter((b) => b.part === part.index) })), (p) => p.own.length);
    const n = top.own.length;
    if (n < own.minInPart || n / breaks.length < own.partShare) return null;
    const moments = momentsOf(breaks, secondOf(analysis), own.partMomentSec);
    const on = momentsOn(moments, (b) => b.part === top.part.index);
    if (on < own.minPartMoments || chanceOf(on, moments.length, top.part.notes / sumOf(parts.map((p) => p.notes))) > own.maxChance) return null;
    return hint("breaks.part", "breaks", "replay.hint.break.part", { n, of: breaks.length, from: top.part.fromMs, to: top.part.toMs }, own.weight * over(n / breaks.length, own.partShare, limits), top.own[0].t - 1000);
}

function hardestPart({ report, facts }, limits) {
    const own = limits.hardest;
    if (!facts.whole || !facts.exact || !report.hardest) return null;
    const list = report.hardest.parts.filter((p) => p.versusRest !== null && p.notes >= own.minNotes);
    if (!list.length) return null;
    const worst = least(list, (p) => p.versusRest);
    if (-worst.versusRest < own.minDelta) return null;
    return hint("hardest.part", "hardest", "replay.hint.hard.part", { from: worst.fromMs, to: worst.toMs, delta: round1(-worst.versusRest) }, own.weight * over(-worst.versusRest, own.minDelta, limits), worst.fromMs);
}

// The dan where the accuracy falls: the split of the parts, in order of dan, with the largest drop between its two sides. The
// two sides are told by name, so only dans with one, and a split between two different ones.
function danStep({ report, later, facts }, limits) {
    const own = limits.parts;
    if (!later || !facts.whole || !facts.exact) return null;
    const named = (dan) => dan !== null && !["below", "above"].includes(labelKey(dan));
    const rated = report.parts.filter((p) => named(p.dan) && p.accuracy !== null && p.notes >= own.minNotes).sort((a, b) => a.dan - b.dan);
    if (rated.length < own.minParts) return null;
    const accuracyOf = (list) => weighted(list, (p) => p.accuracy, (p) => p.notes);
    let best = null;
    for (let i = 1; i < rated.length; i += 1) {
        if (labelKey(rated[i].dan) === labelKey(rated[i - 1].dan)) continue;
        const easy = rated.slice(0, i);
        const hard = rated.slice(i);
        const drop = accuracyOf(easy) - accuracyOf(hard);
        if (!best || drop > best.drop) best = { easy, hard, drop };
    }
    if (!best || best.drop < own.minDrop) return null;
    const { easy, hard, drop } = best;
    const params = { easy: easy.at(-1).dan, hold: round1(accuracyOf(easy)), hard: hard[0].dan, fall: round1(accuracyOf(hard)) };
    return hint("parts.dan", "parts", "replay.hint.part.dan", params, own.weight * over(drop, own.minDrop, limits), least(hard, (p) => p.accuracy).fromMs);
}

function weakFamily({ report, later }, limits) {
    const own = limits.families;
    if (!later) return null;
    const solid = report.families.filter((f) => f.ur !== null && f.notes >= own.minNotes);
    if (solid.length < 2) return null;
    const worst = most(solid, (f) => f.ur);
    const best = least(solid, (f) => f.ur);
    const gap = worst.ur - best.ur;
    if (gap < own.minGap || worst.ur / best.ur < own.minRatio) return null;
    return hint("families.weak", "families", "replay.hint.family.weak", { family: worst.family, ur: Math.round(worst.ur), on: best.family, otherUr: Math.round(best.ur) }, own.weight * over(gap, own.minGap, limits));
}

const sameMods = (a, b) => [...(a ?? [])].sort().join() === [...(b ?? [])].sort().join();

// Against the last plays of the map at the same rate and mods, each played to the end, each recount told as it is. The
// earlier plays' rates are as the play's own is shown (replay.rate: an Interlude play's analysis judges by the float32
// its scores keep, 1.100000023841858, the tab and its earlier plays say 1.1; an osu! play's are the same number).
function quietProgress({ analysis, replay, earlier, facts }, limits) {
    const own = limits.earlier;
    if (!facts.whole || !facts.exact || facts.scoreV2 || analysis.ur === null || analysis.accuracy === null) return null;
    const rate = replay?.rate ?? analysis.rate;
    const same = (earlier?.plays ?? []).filter((p) => p.whole !== false && p.exact !== false && p.ur !== null && p.accuracy !== null && p.rate === rate && sameMods(p.modNames, replay?.modNames));
    if (same.length < own.minPlays) return null;
    const last = same.slice(0, own.plays);
    const better = meanOf(last.map((p) => p.ur)) - analysis.ur;
    if (Math.abs(analysis.accuracy - meanOf(last.map((p) => p.accuracy))) > own.sameAccuracy || better < own.minUr) return null;
    return hint("earlier.progress", "earlier", "replay.hint.earlier.progress", { ur: Math.round(better) }, own.weight * over(better, own.minUr, limits));
}

const HEADER_RULES = [lostToMisses];
const RULES = [
    ...HEADER_RULES, unevenFinger, handAhead, whenManip(gluedFamily), whenManip(gluedHand), whenManip(gluedPart), columnBias, hitPosition, fatigue, slide, paceCeiling, paceBehind,
    holdHint("holds.late", "replay.hint.hold.late", "late", "lateMean", "minLate"), holdHint("holds.early", "replay.hint.hold.early", "early", "earlyMean", "minEarly"),
    ghostColumn, breakShape, breakPart, hardestPart, danStep, weakFamily, quietProgress,
];

// What is known of the play's numbers. exact: the recount's per-note counts can be told as they are (an Interlude play's
// always: they are Interlude's own judging, src/replay/analyzeInterlude.js).
function factsOf({ analysis, replay }) {
    const scoreV2 = analysis ? Boolean(analysis.scoreV2) : Boolean(replay?.modNames?.includes("V2"));
    const recounted = () => (scoreV2 ? !analysis.holds : !analysis.holdHeavy || Boolean(analysis.comparison?.same));
    return {
        scoreV2, whole: !analysis || analysis.played >= analysis.notes,
        exact: Boolean(analysis) && (typeof analysis.exact === "boolean" ? analysis.exact : recounted()),
    };
}

// report: src/replay/report.js's, null with no analysis; replay: the header as the tab has it; later: replay-details' answer;
// earlier: replay-earlier's; bias: replay-bias' { plays: [{ md5, mean }], position: { hitPosition } }; each null until it comes.
// → { top: the strongest of the play, one per section, strongest first; bySection: { section: its hints, strongest first } }.
export function buildHints({ report = null, analysis = null, replay = null, later = null, earlier = null, bias = null }, limits = HINTS) {
    const data = { report, analysis, replay, later, earlier, bias, facts: factsOf({ analysis, replay }) };
    const found = (analysis && report ? RULES : HEADER_RULES).map((rule) => rule(data, limits)).filter(Boolean).sort((a, b) => b.weight - a.weight);
    const bySection = {};
    for (const h of found) {
        bySection[h.section] ??= [];
        if (bySection[h.section].length < limits.perSection) bySection[h.section].push(h);
    }
    const top = Object.values(bySection).map((list) => list[0]).sort((a, b) => b.weight - a.weight).slice(0, limits.top);
    return { top, bySection };
}
