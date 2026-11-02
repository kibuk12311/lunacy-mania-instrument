// How Interlude judges a replay, re-implemented in our own JS from reading Prelude (github.com/YAVSRG/YAVSRG,
// prelude/src/Gameplay/Scoring: GameplayEventProcessor.fs, HitMechanics.fs, ScoreProcessor.fs, OsuHolds.fs, Lamps.fs,
// Grades.fs; Gameplay/Rulesets/WifeCurve.fs; MIT). Interlude keeps no judgements: its score screen judges the stored
// replay again with the ruleset picked, and so does this, event by event as Prelude does (checked against Interlude's
// own compiled Prelude on a real player's plays: every event of every play the same but for 90 of some 257 000 under
// Wife3 J7, whose points are a few ulps off, see exactExp; no play's accuracy, counts or combo differs).
//   The replay's frames are read in order, columns left to right in a frame; before each key goes down or up every note
//   whose late window has passed is a miss, and once the frames are read all the notes left are. A key going down looks
//   for a note by the ruleset's note priority (osu!mania: the earliest; Etterna: the nearest; Interlude: the earliest
//   unless it is further than the cbrush threshold, and a press that would land behind a note already hit too early is
//   eaten) and starts a hold; going up it ends one, in the release window or dropped before it.
//   Windows are ms of real time: in ms of the chart (the replay's and the notes' clock) they are × rate, and a press's
//   offset ÷ rate. Times, windows and offsets are float32 (System.Single) as in Prelude, every step Math.fround-ed; points
//   and accuracy are doubles summed in the order Prelude sums them, so the accuracy comes out to the last bit. Pure.
import { NOTE } from "./chart.js";
import { formatAccuracy } from "./ruleset.js";

const f32 = Math.fround;

// HitFlags: what a note of a row still needs.
const FLAG = Object.freeze({ NOTHING: 0, HIT_REQUIRED: 1, HIT_HOLD_REQUIRED: 2, HIT_ACCEPTED: 3, RELEASE_REQUIRED: 4, RELEASE_ACCEPTED: 5 });
// HoldStateInternal: where a column's hold is.
const HOLD = Object.freeze({ NOTHING: 0, HOLDING: 1, DROPPED: 2, REGRABBED: 3, MISSED_HEAD_DROPPED: 4, MISSED_HEAD_REGRABBED: 5 });
const isDropped = (state) => state >= HOLD.DROPPED;
const isMissedHead = (state) => state >= HOLD.MISSED_HEAD_DROPPED;
const BLOCKED = -2;
const NOT_FOUND = -1;

export const COMBO = Object.freeze({ INCREASE: "INCREASE", BREAK: "BREAK", BREAK_INSTEAD: "BREAK_INSTEAD_OF_INCREASE", NO_CHANGE: "NO_CHANGE" });

// e^a rounded once to the nearest double. Prelude's Wife curve calls .NET's Math.Exp, the C runtime's exp, whose own
// algorithm could not be had: it is an ulp off the correctly rounded value now and then (on 2 426 of 452 289 arguments
// tried), and V8's Math.exp, off it in other places, differs from .NET's on 34 916 of them. An exp an ulp off moves a
// Wife3 point by at most 2^-53, which is a few of the point's own ulps where most hits land (4 at J7 for a delta of 35.7 ms)
// and many more for a point near 0 at the edge of the curve (the erf there is 1 minus nearly 1), and enough of them
// change the accuracy's last bits. So it is worked out here in double-double (pairs of doubles, about 106 bits:
// a = k·ln 2 + r, e^(r/512) by its series, squared 9 times, × 2^k) and rounded at the end, which comes nearest to
// Interlude: against its plays only 90 Wife3 J7 points are off (59 by 1 ulp, 15 by 2, 16 by 4) and no accuracy, with
// V8's Math.exp 1 788 points and one accuracy. Interlude's own last bits
// change with the CPU too (the C runtime takes another path without FMA3). Over 20 000 arguments of the range Wife3 uses
// this gave the correctly rounded value every time.
const LN2_HI = 0.6931471805599453; // ln 2 as a double
const LN2_LO = 2.3190468138462996e-17; // ln 2 − LN2_HI
const SPLITTER = 134217729; // 2^27 + 1
const twoSum = (a, b) => {
    const s = a + b;
    const v = s - a;
    return [s, (a - (s - v)) + (b - v)];
};
const quickTwoSum = (a, b) => {
    const s = a + b;
    return [s, b - (s - a)];
};
const split = (a) => {
    const c = SPLITTER * a;
    const hi = c - (c - a);
    return [hi, a - hi];
};
const twoProduct = (a, b) => {
    const p = a * b;
    const [ah, al] = split(a);
    const [bh, bl] = split(b);
    return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
};
const ddAdd = ([ah, al], [bh, bl]) => {
    const [s, e] = twoSum(ah, bh);
    return quickTwoSum(s, e + al + bl);
};
const ddMul = ([ah, al], [bh, bl]) => {
    const [p, e] = twoProduct(ah, bh);
    return quickTwoSum(p, e + ah * bl + al * bh);
};
const ddDiv = ([ah, al], n) => {
    const q = ah / n;
    const [p, e] = twoProduct(q, n);
    return quickTwoSum(q, (ah - p - e + al) / n);
};
export function exactExp(a) {
    if (!(Math.abs(a) < 700)) return Math.exp(a);
    const k = Math.round(a / LN2_HI);
    const [ph, pl] = twoProduct(k, LN2_HI);
    const [s, e] = twoSum(a, -ph);
    const r = quickTwoSum(s, e - pl - k * LN2_LO);
    const x = [r[0] / 512, r[1] / 512];
    let term = x;
    let sum = ddAdd([1, 0], x);
    for (let n = 2; n <= 10; n += 1) {
        term = ddDiv(ddMul(term, x), n);
        sum = ddAdd(sum, term);
    }
    for (let i = 0; i < 9; i += 1) sum = ddMul(sum, sum);
    return (sum[0] + sum[1]) * 2 ** k;
}

// Wife3Curve.calculate: Etterna's points of an offset (real ms), 1 at best, −2.75 at worst. Doubles.
function erf(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const v = Math.abs(x);
    const t = 1 / (1 + p * v);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * exactExp(-v * v);
    return sign * y;
}
export function wife3Points(judge, offset) {
    const delta = Math.abs(offset);
    const scale = (10 - judge) / 6;
    const missWeight = -2.75;
    const ridic = 5 * scale;
    const booWindow = 180 * scale;
    const tsPow = 0.75;
    const zero = 65 * scale ** tsPow;
    const dev = 22.7 * scale ** tsPow;
    if (delta <= ridic) return 1;
    if (delta <= zero) return erf((zero - delta) / dev);
    if (delta <= booWindow) return ((delta - zero) * missWeight) / (booWindow - zero);
    return missWeight;
}

// OsuHolds.ln_judgement: an osu!mania hold's one judgement from its head and its release (real ms, float32).
function osuHoldJudgement(w, headDelta, releaseDelta, overheld, dropped) {
    const releaseAbs = Math.abs(releaseDelta);
    const headAbs = Math.abs(headDelta);
    if (overheld) return headAbs < w.WindowOverhold200 ? 2 : headAbs < w.WindowOverhold100 ? 3 : 4;
    if (dropped) return releaseDelta < -w.Window50 ? 5 : 4;
    const mean = f32(f32(releaseAbs + headAbs) * 0.5);
    if (releaseDelta < -w.Window50) return 5;
    if (headAbs < w.Window320 && mean < w.Window320) return 0;
    if (headAbs < w.Window300 && mean < w.Window300) return 1;
    if (headAbs < w.Window200 && mean < w.Window200) return 2;
    if (headAbs < w.Window100 && mean < w.Window100) return 3;
    return 4;
}

// Lamp.calculate: the best lamp whose requirements the counts meet, −1 for none (lamps go from the least strict).
export function lampOf(lamps, counts, comboBreaks) {
    let worst = -1;
    counts.forEach((count, j) => {
        if (count > 0) worst = j;
    });
    let achieved = -1;
    while (achieved + 1 < lamps.length) {
        const r = lamps[achieved + 1].requirement;
        if (r.kind === "comboBreaks" ? comboBreaks > r.count : worst > r.judgement || counts[r.judgement] > r.count) break;
        achieved += 1;
    }
    return achieved;
}

// Grade.calculate: the best grade the accuracy (0..1) reaches, −1 for none (Interlude's F).
export function gradeOf(grades, accuracy) {
    let achieved = -1;
    while (achieved + 1 < grades.length && !(grades[achieved + 1].accuracy - accuracy > 0)) achieved += 1;
    return achieved;
}

// GameplayEventProcessor: the frames against the notes → raw events (HIT, HOLD, RELEASE, DROP_HOLD, REGRAB_HOLD,
// GHOST_TAP), each handed to onEvent as it happens.
class EventProcessor {
    constructor(ruleset, chart, frames, rate, onEvent) {
        this.keys = chart.keys;
        this.frames = frames;
        this.rate = f32(rate);
        this.onEvent = onEvent;
        this.first = f32(chart.notes[0].time);
        const [earlyNote, lateNote] = ruleset.noteWindows;
        const [earlyRelease, lateRelease] = ruleset.releaseWindows;
        this.lateNoteRaw = lateNote;
        this.lateReleaseRaw = lateRelease;
        this.earlyNote = f32(earlyNote * this.rate);
        this.lateNote = f32(lateNote * this.rate);
        this.earlyRelease = f32(earlyRelease * this.rate);
        this.lateRelease = f32(lateRelease * this.rate);
        this.earlyWindow = Math.min(this.earlyRelease, this.earlyNote);
        this.lateWindow = Math.max(this.lateRelease, this.lateNote);
        // HitFlagData.create_gameplay: per row each column's offset (the raw late window until it is hit) and need
        this.rows = chart.notes.map(({ time, data }) => {
            const deltas = new Float32Array(this.keys).fill(lateNote);
            const status = new Uint8Array(this.keys);
            for (let k = 0; k < this.keys; k += 1) {
                if (data[k] === NOTE.NORMAL) status[k] = FLAG.HIT_REQUIRED;
                else if (data[k] === NOTE.HOLDHEAD) status[k] = FLAG.HIT_HOLD_REQUIRED;
                else if (data[k] === NOTE.HOLDTAIL) {
                    status[k] = FLAG.RELEASE_REQUIRED;
                    deltas[k] = lateRelease;
                }
            }
            return { time: f32(time), deltas, status };
        });
        this.holdState = new Array(this.keys).fill(HOLD.NOTHING);
        this.holdIndex = new Array(this.keys).fill(-1);
        this.expired = 0;
        this.nextFrame = 0;
        this.pressed = 0; // the keys held as of the last frame read (KeyState)
        const priority = ruleset.notePriority;
        this.find = priority.kind === "interlude" ? (k, start, now) => this.interlude(priority.cbrush, k, start, now)
            : priority.kind === "osuMania" ? (k, start, now) => this.osuMania(k, start, now)
                : (k, start, now) => this.etterna(k, start, now);
        this.found = 0; // the offset of the note a search found (chart ms)
    }

    emit(index, time, column, inner) {
        this.onEvent({ index, time, column, ...inner });
    }

    // HitMechanics.interlude → the row index, BLOCKED or NOT_FOUND; the offset in this.found.
    interlude(cbrushRaw, k, start, now) {
        const { rows } = this;
        let closestBad = this.lateNote;
        let index = -1;
        let closest = this.lateNote;
        const end = f32(now - this.earlyNote);
        const cbrush = f32(cbrushRaw * this.rate);
        for (let i = start; i < rows.length && rows[i].time <= end; i += 1) {
            const delta = f32(now - rows[i].time);
            const status = rows[i].status[k];
            if (status === FLAG.HIT_REQUIRED || status === FLAG.HIT_HOLD_REQUIRED) {
                if (index < 0 || Math.abs(closest) > Math.abs(delta)) {
                    index = i;
                    closest = delta;
                }
                if (Math.abs(closest) < cbrush) break;
            } else if (status === FLAG.HIT_ACCEPTED && rows[i].deltas[k] <= -cbrushRaw) {
                if (Math.abs(closestBad) > Math.abs(delta)) closestBad = delta;
            }
        }
        if (index < 0) return NOT_FOUND;
        if (Math.abs(closestBad) < Math.abs(closest)) return BLOCKED;
        this.found = closest;
        return index;
    }

    // HitMechanics.etterna: the nearest note.
    etterna(k, start, now) {
        const { rows } = this;
        let index = -1;
        let closest = 0;
        const end = f32(now - this.earlyNote);
        for (let i = start; i < rows.length && rows[i].time <= end; i += 1) {
            const delta = f32(now - rows[i].time);
            const status = rows[i].status[k];
            if ((status === FLAG.HIT_REQUIRED || status === FLAG.HIT_HOLD_REQUIRED) && (index < 0 || Math.abs(closest) > Math.abs(delta))) {
                index = i;
                closest = delta;
            }
        }
        if (index < 0) return NOT_FOUND;
        this.found = closest;
        return index;
    }

    // HitMechanics.osu_mania: the earliest note, and none while a note already hit is still ahead (column lock).
    osuMania(k, start, now) {
        const { rows } = this;
        const end = f32(now - this.earlyNote);
        for (let i = start; i < rows.length && rows[i].time <= end; i += 1) {
            const delta = f32(now - rows[i].time);
            const status = rows[i].status[k];
            if (status === FLAG.HIT_ACCEPTED && delta < 0) return BLOCKED;
            if (status === FLAG.HIT_REQUIRED || status === FLAG.HIT_HOLD_REQUIRED) {
                this.found = delta;
                return i;
            }
        }
        return NOT_FOUND;
    }

    // MissUnhitExpiredNotes: every row whose late window has passed by chartTime gets what it still lacks as a miss.
    missExpired(chartTime) {
        const now = f32(this.first + chartTime);
        const end = f32(now - this.lateWindow);
        const { rows } = this;
        while (this.expired < rows.length && rows[this.expired].time < end) {
            const i = this.expired;
            const { time, deltas, status } = rows[i];
            const at = f32(f32(time - this.first) + this.lateWindow);
            for (let k = 0; k < this.keys; k += 1) {
                if (status[k] === FLAG.HIT_REQUIRED) {
                    this.emit(i, at, k, { kind: "HIT", delta: deltas[k], missed: true });
                    status[k] = FLAG.HIT_ACCEPTED;
                } else if (status[k] === FLAG.HIT_HOLD_REQUIRED) {
                    this.holdState[k] = HOLD.MISSED_HEAD_DROPPED;
                    this.holdIndex[k] = i;
                    this.emit(i, at, k, { kind: "HOLD", delta: deltas[k], missed: true });
                    status[k] = FLAG.HIT_ACCEPTED;
                } else if (status[k] === FLAG.RELEASE_REQUIRED) {
                    const state = this.holdState[k];
                    const held = state === HOLD.REGRABBED || state === HOLD.HOLDING || state === HOLD.MISSED_HEAD_REGRABBED;
                    const head = this.holdIndex[k];
                    this.emit(i, at, k, {
                        kind: "RELEASE", delta: deltas[k], missed: true, overhold: held && ((this.pressed >> k) & 1) === 1, dropped: isDropped(state),
                        headDelta: head >= 0 ? rows[head].deltas[k] : this.lateNoteRaw, missedHead: isMissedHead(state),
                    });
                    status[k] = FLAG.RELEASE_ACCEPTED;
                    if (head < i) {
                        this.holdState[k] = HOLD.NOTHING;
                        this.holdIndex[k] = i;
                    }
                }
            }
            this.expired += 1;
        }
    }

    // KillExistingHold: a new note hit in a column whose hold is still going drops that hold.
    killExistingHold(chartTime, k) {
        const state = this.holdState[k];
        if (state === HOLD.NOTHING) return;
        const head = this.holdIndex[k];
        const { rows } = this;
        for (let i = head; i < rows.length; i += 1) {
            if (rows[i].status[k] === FLAG.RELEASE_ACCEPTED) return;
            if (rows[i].status[k] === FLAG.RELEASE_REQUIRED) {
                rows[i].status[k] = FLAG.RELEASE_ACCEPTED;
                this.holdState[k] = HOLD.NOTHING;
                this.emit(i, chartTime, k, {
                    kind: "RELEASE", delta: this.lateReleaseRaw, missed: true, overhold: false, dropped: true,
                    headDelta: rows[head].deltas[k], missedHead: isMissedHead(state),
                });
                return;
            }
        }
    }

    keyDown(chartTime, k) {
        this.missExpired(chartTime);
        const now = f32(this.first + chartTime);
        const { rows } = this;
        let start = this.expired;
        const late = f32(now - this.lateNote);
        while (start < rows.length && rows[start].time < late) start += 1;
        const index = this.find(k, start, now);
        if (index === BLOCKED) return;
        if (index >= 0) {
            this.killExistingHold(chartTime, k);
            const row = rows[index];
            const head = row.status[k] !== FLAG.HIT_REQUIRED;
            row.status[k] = FLAG.HIT_ACCEPTED;
            row.deltas[k] = f32(this.found / this.rate);
            this.emit(index, chartTime, k, { kind: head ? "HOLD" : "HIT", delta: row.deltas[k], missed: false });
            if (head) {
                this.holdState[k] = HOLD.HOLDING;
                this.holdIndex[k] = index;
            }
            return;
        }
        const state = this.holdState[k];
        if (state === HOLD.MISSED_HEAD_DROPPED || state === HOLD.DROPPED) {
            this.holdState[k] = state === HOLD.DROPPED ? HOLD.REGRABBED : HOLD.MISSED_HEAD_REGRABBED;
            this.emit(this.holdIndex[k], chartTime, k, { kind: "REGRAB_HOLD" });
        } else if (state === HOLD.NOTHING && chartTime > 0) {
            this.emit(this.expired, chartTime, k, { kind: "GHOST_TAP" });
        }
    }

    keyUp(chartTime, k) {
        this.missExpired(chartTime);
        const now = f32(this.first + chartTime);
        const state = this.holdState[k];
        if (state !== HOLD.HOLDING && state !== HOLD.REGRABBED && state !== HOLD.MISSED_HEAD_REGRABBED) return;
        const head = this.holdIndex[k];
        const { rows } = this;
        let found = -1;
        let delta = 0;
        const end = f32(now - this.earlyWindow);
        for (let i = head; i < rows.length && rows[i].time <= end; i += 1) {
            if (rows[i].status[k] === FLAG.RELEASE_ACCEPTED) break;
            if (rows[i].status[k] === FLAG.RELEASE_REQUIRED) {
                found = i;
                delta = f32(now - rows[i].time);
                break;
            }
        }
        if (found >= 0 && delta >= this.earlyRelease) {
            const row = rows[found];
            row.status[k] = FLAG.RELEASE_ACCEPTED;
            const overhold = delta > this.lateRelease;
            if (!overhold) row.deltas[k] = f32(delta / this.rate);
            this.emit(found, chartTime, k, {
                kind: "RELEASE", delta: row.deltas[k], missed: overhold, overhold, dropped: isDropped(state),
                headDelta: rows[head].deltas[k], missedHead: isMissedHead(state),
            });
            this.holdState[k] = HOLD.NOTHING;
        } else {
            // let go too early: the hold is dropped
            this.holdState[k] = state === HOLD.MISSED_HEAD_REGRABBED ? HOLD.MISSED_HEAD_DROPPED : HOLD.DROPPED;
            this.emit(head, chartTime, k, { kind: "DROP_HOLD" });
        }
    }

    // Update: the frames up to chartTime (KeyPressReader.PollReplay), then the notes expired by then.
    update(chartTime) {
        const { times, masks } = this.frames;
        while (this.nextFrame < times.length && times[this.nextFrame] <= chartTime) {
            const time = times[this.nextFrame];
            const mask = masks[this.nextFrame];
            this.nextFrame += 1;
            for (let k = 0; k < this.keys; k += 1) {
                const was = (this.pressed >> k) & 1;
                const is = (mask >> k) & 1;
                if (was && !is) this.keyUp(time, k);
                else if (is && !was) this.keyDown(time, k);
            }
            this.pressed = mask;
        }
        this.missExpired(chartTime);
    }
}

// ruleset: parseRuleset's; chart: the chart as played (applyIlMods'), { keys, notes: [{ time, data }] }; frames:
// readIlReplay's; rate: the play's rate (read as float32); untilLastFrame: judge only as far as the last frame (a failed
// play: what was played), else everything as Prelude's ProcessEntireReplay does (a note no frame reached is a miss).
// → { events, counts (per judgement), accuracy (0..1, 1 with nothing judged, can be negative), pointsScored,
// maxPossiblePoints, maxCombo, maxPossibleCombo, comboBreaks, lamp, grade (indices, −1 for none), formattedAccuracy }.
// events, in the order they happen: { kind, index (note row), time, noteTime (ms of the chart from its first note),
// column, delta (real ms, + late), judgement, points, missed, overhold, dropped, combo }, as ScoreProcessor makes them;
// a field only where Prelude has it, judgement and points null when the ruleset gives the event none.
export function judgeIlReplay({ ruleset, chart, frames, rate, untilLastFrame = false }) {
    if (!chart.notes.length) throw new Error("judge: the chart has no notes");
    const judgements = ruleset.judgements;
    const miss = judgements.length - 1; // DefaultJudgement
    const hold = ruleset.holdMechanics;
    const accuracyKind = ruleset.accuracy;
    const counts = new Array(judgements.length).fill(0);
    let pointsScored = 0;
    let maxPossiblePoints = 0;
    let combo = 0;
    let maxCombo = 0;
    let comboBreaks = 0;
    let maxPossibleCombo = 0;
    const events = [];

    const msToJudgement = (delta) => {
        let j = 0;
        while (j + 1 < judgements.length && (judgements[j].windows === null || delta < judgements[j].windows[0] || delta > judgements[j].windows[1])) j += 1;
        return j;
    };
    const pointsOf = (delta, j) => (accuracyKind.kind === "wifeCurve" ? wife3Points(accuracyKind.judge, delta) : accuracyKind.points[j]);
    const score = (points, j) => {
        maxPossiblePoints += 1;
        pointsScored += points;
        counts[j] += 1;
    };
    const breaksOn = (j) => (judgements[j].breaksCombo ? COMBO.BREAK_INSTEAD : COMBO.INCREASE);
    // a judgement by an offset (ms_to_judgement), its points and its combo
    const judged = (delta, j) => {
        const points = pointsOf(delta, j);
        score(points, j);
        return { judgement: j, points, combo: breaksOn(j) };
    };
    const unjudged = (missed) => ({ judgement: null, points: null, combo: missed ? COMBO.BREAK_INSTEAD : COMBO.INCREASE });

    const release = (e) => {
        const { delta, missed, overhold, dropped, headDelta, missedHead } = e;
        if (hold.kind === "osuMania") {
            const j = missed && missedHead && !overhold ? miss : osuHoldJudgement(hold.windows, headDelta, delta, overhold, dropped);
            const points = accuracyKind.points[j];
            score(points, j);
            return { judgement: j, points, combo: breaksOn(j) };
        }
        if (hold.kind === "headJudgementOr") {
            const head = msToJudgement(headDelta);
            const j = missedHead && missed ? miss : overhold && !dropped ? Math.max(head, hold.ifOverheld) : dropped ? Math.max(head, hold.ifDropped) : head;
            const points = accuracyKind.points[j];
            score(points, j);
            return { judgement: j, points, combo: breaksOn(j) };
        }
        if (hold.kind === "onlyRequireHold") {
            return { judgement: null, points: null, combo: !overhold && (missed || dropped) ? COMBO.BREAK_INSTEAD : COMBO.INCREASE };
        }
        if (hold.kind === "judgeReleasesSeparately") {
            let j = 0;
            if (dropped) j = miss;
            else if (overhold) j = hold.ifOverheld;
            else if (missed) j = miss;
            else while (j + 1 < judgements.length && (hold.windows[j] === null || delta < hold.windows[j][0] || delta > hold.windows[j][1])) j += 1;
            return judged(delta, j);
        }
        // onlyJudgeReleases
        const j = missed ? miss : dropped || overhold ? Math.max(msToJudgement(delta), hold.ifDropped) : msToJudgement(delta);
        return judged(delta, j);
    };

    // ScoreProcessor.HandleEvent
    const onEvent = (e) => {
        let out;
        if (e.kind === "HIT") {
            out = hold.kind === "onlyJudgeReleases" ? unjudged(e.missed) : judged(e.delta, e.missed ? miss : msToJudgement(e.delta));
        } else if (e.kind === "HOLD") {
            out = hold.kind === "onlyRequireHold" || hold.kind === "judgeReleasesSeparately" ? judged(e.delta, e.missed ? miss : msToJudgement(e.delta)) : unjudged(e.missed);
        } else if (e.kind === "RELEASE") {
            out = release(e);
        } else if (e.kind === "DROP_HOLD") {
            out = { combo: COMBO.BREAK };
        } else if (e.kind === "REGRAB_HOLD") {
            out = { combo: COMBO.NO_CHANGE };
        } else {
            const j = ruleset.ghostTapJudgement;
            if (j === null) out = { judgement: null, points: null, combo: COMBO.NO_CHANGE };
            else {
                const points = accuracyKind.points[j];
                score(points, j);
                out = { judgement: j, points, combo: judgements[j].breaksCombo ? COMBO.BREAK_INSTEAD : COMBO.NO_CHANGE };
            }
        }
        if (out.combo === COMBO.INCREASE) {
            maxPossibleCombo += 1;
            combo += 1;
            maxCombo = Math.max(maxCombo, combo);
        } else if (out.combo !== COMBO.NO_CHANGE) {
            if (out.combo === COMBO.BREAK_INSTEAD) maxPossibleCombo += 1;
            comboBreaks += 1;
            combo = 0;
        }
        const event = {
            kind: e.kind, index: e.index, time: e.time,
            noteTime: e.index < processor.rows.length ? f32(processor.rows[e.index].time - processor.first) : null,
            column: e.column,
        };
        if (e.kind === "HIT" || e.kind === "HOLD" || e.kind === "RELEASE") {
            event.delta = e.delta;
            event.judgement = out.judgement;
            event.points = out.points;
            event.missed = e.missed;
            if (e.kind === "RELEASE") {
                event.overhold = e.overhold;
                event.dropped = e.dropped;
            }
        } else if (e.kind === "GHOST_TAP") {
            event.judgement = out.judgement;
            event.points = out.points;
        }
        event.combo = out.combo;
        events.push(event);
    };

    const processor = new EventProcessor(ruleset, chart, frames, rate, onEvent);
    if (untilLastFrame) processor.update(frames.times.length ? frames.times[frames.times.length - 1] : -Infinity);
    else processor.update(Infinity);

    const accuracy = maxPossiblePoints === 0 ? 1 : pointsScored / maxPossiblePoints;
    return {
        events, counts, accuracy, pointsScored, maxPossiblePoints, maxCombo, maxPossibleCombo, comboBreaks,
        lamp: lampOf(ruleset.lamps, counts, comboBreaks), grade: gradeOf(ruleset.grades, accuracy),
        formattedAccuracy: formatAccuracy(ruleset, accuracy),
    };
}
