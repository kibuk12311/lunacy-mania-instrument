// An Interlude play against its chart: the same analysis as analyze.js gives an osu! replay, but the judgements are
// Interlude's own, made by its ruleset (src/interlude/judge.js, exact), so there is no header to compare with and
// nothing approximate to warn of. The ruleset's judgements are put in the tab's six slots (rulesetSlots) so everything
// after the analysis works as it does for osu!, and its own names, colours and counts come along for what is shown.
// Times: `t`, `at`, `press`, `up` ms of the chart (the notes' clock, at rate 1.0); delta and seconds of play are real
// time. Pure.
import { judgeIlReplay, COMBO } from "../interlude/judge.js";
import { ilNoteRows, ilNotes, ilPresses } from "../interlude/replay.js";
import { rulesetSlots } from "../interlude/ruleset.js";
import { KINDS } from "./judge.js";
import { spread, unstableRate, errorHistogram, keysPerSecond, TIMELINE_BINS } from "./analyze.js";
import { manipPairs, manipSummary, manipByPart, MANIP, HANDS } from "./manip.js";

const round1 = (x) => Math.round(x * 10) / 10;
const widest = (windows) => (windows ? Math.max(-windows[0], windows[1]) : null);
const breaking = (combo) => combo === COMBO.BREAK || combo === COMBO.BREAK_INSTEAD;

// The six slots' windows in ms of the chart, as hitWindows gives osu!'s: each the widest side of its judgements'
// windows (a slot with none keeps the one before it), miss the widest note window.
function slotWindows(ruleset, slots, rate) {
    const out = {};
    let last = 0;
    for (const kind of KINDS) {
        const own = ruleset.judgements.map((j, i) => (slots[i] === kind ? widest(j.windows) : null)).filter((w) => w !== null);
        if (own.length) last = Math.max(...own);
        out[kind] = last * rate;
    }
    out.miss = widest(ruleset.noteWindows) * rate;
    return out;
}

// What the analysis tells of the ruleset: { name, judgements: [{ name, color, breaksCombo, slot, early, late }] },
// windows ms of real time (null for a judgement with none).
const rulesetInfo = (ruleset, slots) => ({
    name: ruleset.name,
    judgements: ruleset.judgements.map((j, i) => ({
        name: j.name, color: j.color, breaksCombo: j.breaksCombo, slot: slots[i], early: j.windows ? j.windows[0] : null, late: j.windows ? j.windows[1] : null,
    })),
});

// ruleset: parseRuleset's; chart: the chart as played (applyIlMods'); notes: ilNotes(chart), made here when not given;
// frames: readIlReplay's; rate: the play's; failed: a failed play, judged as far as its last frame (Interlude itself judges
// one over the whole chart, every note after the fail a miss: that accuracy is wholeAccuracyText, null on a whole play);
// parts: [{ fromMs, toMs }] (ms of the chart), or none; hands: which columns are one hand.
// → { reason } when it cannot be worked out: "keys" (not 4K), "empty" (no notes, no frames); else the fields of
// analyzeReplay plus source, exact, failed, ruleset, judgementCounts, accuracyText, wholeAccuracyText, lamp, grade.
// combo.breaks: [{ t, col, combo }] at the note that broke it (a hold broken after its head adds at: when it was let go, or
// its end's time with end: true), or with ghost: true and j (its judgement) at a press that met no note, for a ruleset whose
// GhostTapJudgement breaks the combo. results: one per note
// the play finished (a hold once its end is judged; on a failed play also a hold let go before the last frame, though its
// end never came: its `at` is when it was let go), sorted by the note's time, with j (the note's ruleset judgement, the
// worse of two, null with none), points (its points), weight (how many judgements it got: 0, 1 or 2), breaks (it broke
// the combo), dropped (a hold let go before its end, though grabbed again after; null for a tap); kind its j's slot, null
// with none. dropped is not Prelude's own Dropped flag: that one is set for a hold whose head was missed too, held to its
// end or not. steps: what the playback shows from moment to moment, one per event of the engine that changed the combo or
// gave a judgement, in its order: [{ t, combo (after it), j (the judgement it gave, null with none), points (null with
// none) }], t ms of the chart; the running counts and accuracy are these judgements summed in this order, so they end on
// judgementCounts and on the accuracy to the last bit. unfinished: on a failed play, the holds whose head was judged but
// whose end never came, still held at the last frame (or never grabbed), as results are; none on a whole play.
export function analyzeIlReplay({ ruleset, chart, notes = null, frames, rate, failed = false, parts = [], hands = HANDS }) {
    const keys = chart.keys;
    if (keys !== 4) return { reason: "keys", headerCounts: null };
    const rows = ilNoteRows(chart);
    const shown = notes ?? ilNotes(chart);
    if (!rows.length || !frames.times.length) return { reason: "empty", headerCounts: null };
    const judged = judgeIlReplay({ ruleset, chart, frames, rate, untilLastFrame: failed });
    const slots = rulesetSlots(ruleset);
    const first = Math.fround(chart.notes[0].time);
    const presses = ilPresses(frames, keys, first);
    const windows = slotWindows(ruleset, slots, rate);

    // each note's events: a tap's HIT; a hold's HOLD, DROP_HOLD and REGRAB_HOLD (on its head's row) and its tail's RELEASE
    const byPlace = new Map();
    const place = (row, col) => `${row}:${col}`;
    const state = rows.map((n) => {
        const s = { note: n, j: null, points: 0, weight: 0, breaks: false, done: false, at: null, press: null, delta: null, down: null, dropped: n.end === null ? null : false, head: false };
        byPlace.set(place(n.row, n.col), s);
        if (n.tailRow !== null) byPlace.set(place(n.tailRow, n.col), s);
        return s;
    });
    const releases = presses.map((list) => new Map(list.map((p) => [p.t, p.up])));
    const ghosts = [];
    const breaks = [];
    const steps = [];
    let combo = 0;
    for (const e of judged.events) {
        const at = first + e.time;
        const s = e.kind === "GHOST_TAP" ? null : byPlace.get(place(e.index, e.column));
        if (breaking(e.combo)) {
            if (s) {
                // t is the note's (its head's for a hold); a hold broken after its head says when: let go at the drop, else
                // at its end
                const after = e.kind === "DROP_HOLD" ? { at } : e.kind === "RELEASE" ? { at: s.note.end, end: true } : {};
                breaks.push({ t: s.note.t, col: s.note.col, combo, ...after });
                s.breaks = true;
            } else if (e.kind === "GHOST_TAP") {
                // a press that met no note, judged by the ruleset's GhostTapJudgement, which breaks the combo: j that one
                breaks.push({ t: at, col: e.column, combo, ghost: true, j: e.judgement ?? null });
            }
            combo = 0;
        } else if (e.combo === COMBO.INCREASE) {
            combo += 1;
        }
        // what the playback shows of this event: the combo after it and the judgement it gave. Events come in the engine's
        // order, which is the order of their times; should a float32 rounding put a note's miss a hair after the press
        // handled just after it (none of the real plays checked has one), that press is put at the miss's time.
        const scored = e.judgement !== null && e.judgement !== undefined;
        if (e.combo !== COMBO.NO_CHANGE || scored) {
            steps.push({ t: Math.max(at, steps.at(-1)?.t ?? at), combo, j: scored ? e.judgement : null, points: scored ? e.points : null });
        }
        if (e.kind === "GHOST_TAP") {
            ghosts.push({ t: at, col: e.column });
            continue;
        }
        if (!s) continue;
        if (scored) {
            s.weight += 1;
            s.points += e.points;
            s.j = s.j === null ? e.judgement : Math.max(s.j, e.judgement);
        }
        if (e.kind === "HIT" || e.kind === "HOLD") {
            if (e.kind === "HOLD") s.head = true; // its head judged, hit or missed (a ruleset judging holds at their end gives no j)
            if (!e.missed) {
                s.press = Math.fround(first + e.time);
                s.delta = e.delta;
                s.down = s.press;
            }
            if (e.kind === "HIT") {
                s.done = true;
                s.at = at;
            }
        } else if (e.kind === "REGRAB_HOLD") {
            s.down = Math.fround(first + e.time);
            if (s.press === null) s.press = s.down; // a hold whose head was missed, grabbed during its body
        } else if (e.kind === "DROP_HOLD") {
            // the key went up before the hold's release window. A hold the next note in its column cuts off (its RELEASE
            // with dropped) had its key go up before that, so it got a DROP_HOLD then, if it was ever held at all.
            s.dropped = true;
            s.at = at;
        } else if (e.kind === "RELEASE") {
            s.done = true;
            s.at = at;
        }
    }

    // a whole play judges every note; a failed one stops at its last frame, and a hold let go before it was played
    // (its head and its drop are known, and its break needs it) though its end never came
    const resultOf = (s) => {
        const { t, col, end } = s.note;
        const up = end === null || s.down === null ? null : releases[col].get(s.down) ?? null;
        return {
            t, col, end, kind: s.j === null ? null : slots[s.j], at: s.at, press: s.press, up, early: false, delta: s.delta,
            j: s.j, points: s.points, weight: s.weight, breaks: s.breaks, dropped: s.dropped,
        };
    };
    const byTime = (a, b) => a.t - b.t || a.col - b.col;
    const results = state.filter((s) => s.done || s.dropped).map(resultOf).sort(byTime);
    // on a failed play, the holds whose head was judged (hit or missed, grabbed or not) but whose end never came and that
    // were not let go: no result, but the playback shows their head's judgement or its break, so its stage draws them too
    const unfinished = state.filter((s) => !s.done && !s.dropped && s.note.end !== null && s.head)
        .map(resultOf).sort(byTime);

    const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
    judged.counts.forEach((count, j) => {
        counts[slots[j]] += count;
    });
    const hits = results.filter((r) => r.delta !== null);
    const deltas = hits.map((r) => r.delta);
    const { mean, sd } = spread(deltas);
    const fromMs = shown[0].t;
    const toMs = Math.max(shown.at(-1).t, shown.at(-1).end ?? 0);
    const reached = results.length ? Math.max(...results.slice(-8).map((r) => r.t)) : fromMs;
    const holds = shown.some((n) => n.end !== null);
    const pairs = manipPairs(results, rate, MANIP, hands);
    const byColumn = Array.from({ length: keys }, (_, c) => {
        const own = results.filter((r) => r.col === c);
        const list = own.filter((r) => r.delta !== null).map((r) => r.delta);
        const s = spread(list);
        return {
            col: c, notes: own.length, hits: list.length, misses: own.filter((r) => r.kind === "miss").length,
            mean: s.mean === null ? null : round1(s.mean), sd: s.sd === null ? null : round1(s.sd),
            early: list.filter((d) => d < 0).length, late: list.filter((d) => d > 0).length,
        };
    });
    const nameOf = (list, i) => (failed || i < 0 ? null : list[i]?.name ?? null);
    // what Interlude itself shows for a failed play: the replay judged over the whole chart, every note after the fail a miss
    const whole = failed ? judgeIlReplay({ ruleset, chart, frames, rate, untilLastFrame: false }) : null;
    return {
        source: "interlude", exact: true, failed,
        rate, od: null, windows, scoreV2: false, holds, holdHeavy: false,
        ruleset: rulesetInfo(ruleset, slots), judgementCounts: [...judged.counts], counts,
        accuracy: judged.maxPossiblePoints > 0 ? judged.accuracy * 100 : null, accuracyText: judged.formattedAccuracy,
        wholeAccuracyText: whole ? whole.formattedAccuracy : null,
        lamp: nameOf(ruleset.lamps, judged.lamp), grade: nameOf(ruleset.grades, judged.grade),
        comparison: null, headerCounts: null, headerAccuracy: null,
        combo: { max: judged.maxCombo, breaks }, steps,
        headerCombo: null, maxComboComparable: false,
        ur: unstableRate(deltas), meanError: mean === null ? null : round1(mean), sd: sd === null ? null : round1(sd),
        histogram: errorHistogram(deltas, windows.n50 / rate),
        byColumn,
        keys: keysPerSecond(presses, { fromMs, toMs, rate }),
        misses: results.filter((r) => r.kind === "miss").map((r) => ({ t: r.t, col: r.col, early: false })),
        // presses that met no note, up to the last note reached (not the keys tapped after the chart)
        ghosts: ghosts.filter((g) => g.t <= reached + windows.miss),
        results: results.map((r) => ({ ...r, delta: r.delta === null ? null : round1(r.delta) })),
        unfinished: unfinished.map((r) => ({ ...r, delta: r.delta === null ? null : round1(r.delta) })),
        fromMs, toMs, reachedMs: reached, played: results.length, notes: shown.length, parts,
        manip: { ...manipSummary(pairs, { fromMs, toMs, bins: TIMELINE_BINS, sdMs: sd }), parts: manipByPart(pairs, parts) },
    };
}
