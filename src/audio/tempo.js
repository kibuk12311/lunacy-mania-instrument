// Timing from an onset envelope. detectTiming: one BPM for the whole song. Score = Fourier magnitude at the beat
// frequency (rejects f/2) × autocorrelation at the beat period (rejects 2f) × a log-tempo prior centred on 150 BPM.
// detectTimingSections: the same score over 10 s windows, a Viterbi path through it that changes BPM only on strong
// evidence, then each section's exact BPM, phase and start (and, with fine onsets, its red line to the millisecond).
import { refineSection, beatPhase, fineTempo, foldsAt } from "./fineOnset.js";

const MIN_BPM = 60;
const MAX_BPM = 260;

function detrend(values, hopSec) {
    const half = Math.max(1, Math.round(0.25 / hopSec));
    const out = new Float64Array(values.length);
    let sum = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < values.length; i += 1) {
        while (hi < Math.min(values.length - 1, i + half)) sum += values[++hi];
        while (lo < i - half) sum -= values[lo++];
        out[i] = Math.max(0, values[i] - sum / (hi - lo + 1));
    }
    return out;
}

function autocorrelation(x, maxLag) {
    const ac = new Float64Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag + 1; lag += 1) {
        let s = 0;
        for (let i = lag; i < x.length; i += 1) s += x[i] * x[i - lag];
        ac[lag] = s;
    }
    const zero = ac[0] || 1;
    for (let lag = 0; lag < ac.length; lag += 1) ac[lag] /= zero;
    return ac;
}

const interp = (arr, x) => {
    const i = Math.floor(x);
    const t = x - i;
    return i + 1 < arr.length ? arr[i] * (1 - t) + arr[i + 1] * t : 0;
};

function fourier(x, periodFrames) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI) / periodFrames;
    for (let n = 0; n < x.length; n += 1) {
        if (x[n] === 0) continue;
        re += x[n] * Math.cos(w * n);
        im -= x[n] * Math.sin(w * n);
    }
    return { mag: Math.hypot(re, im), phase: Math.atan2(-im, re) };
}

const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 150) / 0.9) ** 2);

export function detectTiming(envelope) {
    const { values, hopSec, frameTimeSec } = envelope;
    const x = detrend(values, hopSec);
    const periodOf = (bpm) => 60 / (bpm * hopSec);
    const ac = autocorrelation(x, Math.ceil(periodOf(MIN_BPM)));

    let best = { score: -1, bpm: 120 };
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) {
        const p = periodOf(bpm);
        const score = fourier(x, p).mag * Math.max(0, interp(ac, p)) * prior(bpm);
        if (score > best.score) best = { score, bpm };
    }
    // The octave is settled; the Fourier peak alone is far sharper for the exact value.
    let fine = { mag: -1, bpm: best.bpm };
    for (let bpm = best.bpm - 0.6; bpm <= best.bpm + 0.6; bpm += 0.01) {
        const { mag } = fourier(x, periodOf(bpm));
        if (mag > fine.mag) fine = { mag, bpm };
    }

    let bpm = Math.round(fine.bpm * 100) / 100;
    if (Math.abs(bpm - Math.round(bpm)) <= 0.15) bpm = Math.round(bpm);
    const period = periodOf(bpm);
    const { phase } = fourier(x, period);
    const firstFrame = (((phase / (2 * Math.PI)) * period) % period + period) % period;
    const beatMs = 60000 / bpm;
    const offsetMs = ((frameTimeSec(firstFrame) * 1000) % beatMs + beatMs) % beatMs;
    return { bpm, offsetMs: Math.round(offsetMs) };
}

// ---- sectioned timing (mapgen v3) ----

const WINDOW_SEC = 10;
const STEP_SEC = 2.5;
const STATE_STEP_BPM = 1;
const CHANGE_COST = 4; // ≈ 10 s of clearly better evidence before a BPM change is believed
const OCTAVE_COST = 3; // more for ×2 and ×½: the usual octave mistakes, not real changes
const OCTAVE_RATIOS = [2, 0.5];
const OCTAVE_TOLERANCE = 0.03;
const VITERBI_TOP = 64;
const REFINE_SPAN_BPM = 2.5;
const REFINE_COARSE_BPM = 0.05;
const REFINE_FINE_BPM = 0.005;
const MERGE_RELATIVE = 0.0005; // neighbours closer than 0.05% are one section
const MIN_SECTION_BEATS = 8;
const SHORT_SECTION_MARGIN = 2; // a shorter section stays only when its own BPM fits it this much better
const BOUNDARY_SEARCH_SEC = 7.5;
const BOUNDARY_TRIM_SEC = 1.5; // left out of a section's own estimate, near its edges
const MAX_DRIFT_MS = 3; // a rounder BPM is used when the beats would drift less than this over the section
const LIMITS_BPM = [40, 400];
const SPLIT_KEEP = 0.8; // with fine onsets a section stays only when the BPM before it folds its attacks clearly worse

// Magnitude and phase (relative to frame 0) of x[from, to) at one period, by a rotating phasor.
function fourierSpan(x, from, to, periodFrames) {
    const w = (2 * Math.PI) / periodFrames;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = Math.cos(w * from);
    let s = Math.sin(w * from);
    let re = 0;
    let im = 0;
    for (let n = from; n < to; n += 1) {
        const v = x[n];
        if (v !== 0) {
            re += v * c;
            im -= v * s;
        }
        const c2 = c * cw - s * sw;
        s = s * cw + c * sw;
        c = c2;
    }
    return { mag: Math.hypot(re, im), phase: Math.atan2(-im, re) };
}

function spanAutocorrelation(x, from, to, maxLag) {
    const ac = new Float64Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag + 1; lag += 1) {
        let sum = 0;
        for (let i = from + lag; i < to; i += 1) sum += x[i] * x[i - lag];
        ac[lag] = sum;
    }
    const zero = ac[0] || 1;
    for (let lag = 0; lag < ac.length; lag += 1) ac[lag] /= zero;
    return ac;
}

const isOctave = (a, b) => OCTAVE_RATIOS.some((r) => Math.abs(a / b / r - 1) <= OCTAVE_TOLERANCE);

// Score of every BPM state in 10 s windows every 2.5 s, on the envelope at half its frame rate (peaks kept).
function tempogram(x, hopSec) {
    const half = new Float64Array(Math.ceil(x.length / 2));
    for (let i = 0; i < half.length; i += 1) half[i] = Math.max(x[2 * i], x[2 * i + 1] ?? 0);
    const hop = hopSec * 2;
    const win = Math.max(1, Math.round(WINDOW_SEC / hop));
    const step = Math.max(1, Math.round(STEP_SEC / hop));
    const states = [];
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += STATE_STEP_BPM) states.push(bpm);
    const periodOf = (bpm) => 60 / (bpm * hop);
    const maxLag = Math.ceil(periodOf(MIN_BPM));
    const starts = [];
    if (half.length <= win) starts.push(0);
    else for (let a = 0; a + win <= half.length; a += step) starts.push(a);
    if (half.length > win && starts.at(-1) + win < half.length - step / 2) starts.push(half.length - win);
    const windows = starts.map((a) => {
        const b = Math.min(half.length, a + win);
        const ac = spanAutocorrelation(half, a, b, maxLag);
        const scores = Float64Array.from(states, (bpm) => {
            const p = periodOf(bpm);
            return fourierSpan(half, a, b, p).mag * Math.max(0, interp(ac, p)) * prior(bpm);
        });
        return { centerSec: ((a + b) / 2) * hop, scores };
    });
    return { states, windows };
}

// The best state per window: Σ (score / the window's best) minus CHANGE_COST per change (plus OCTAVE_COST for an
// octave jump). Also how clearly the path's state beat the best clearly different one (display only).
function viterbi(states, windows) {
    const S = states.length;
    const octave = states.map((a) => states.map((b) => isOctave(a, b)));
    const emit = windows.map(({ scores }) => {
        const max = Math.max(...scores);
        return Float64Array.from(scores, (v) => (max > 0 ? v / max : 0));
    });
    let value = Float64Array.from(emit[0]);
    const back = [];
    const order = Array.from({ length: S }, (_, i) => i);
    for (let w = 1; w < windows.length; w += 1) {
        order.sort((a, b) => value[b] - value[a]);
        const top = order.slice(0, VITERBI_TOP);
        const next = new Float64Array(S);
        const from = new Int16Array(S);
        for (let s = 0; s < S; s += 1) {
            let best = value[s];
            let arg = s;
            for (const o of top) {
                if (o === s) continue;
                const v = value[o] - CHANGE_COST - (octave[o][s] ? OCTAVE_COST : 0);
                if (v > best) {
                    best = v;
                    arg = o;
                }
            }
            next[s] = best + emit[w][s];
            from[s] = arg;
        }
        back.push(from);
        value = next;
    }
    let s = 0;
    for (let i = 1; i < S; i += 1) if (value[i] > value[s]) s = i;
    const path = [s];
    for (let w = back.length - 1; w >= 0; w -= 1) path.unshift((s = back[w][s]));
    const margins = path.map((state, w) => {
        let other = 0;
        for (let i = 0; i < S; i += 1) {
            if (Math.abs(states[i] / states[state] - 1) > OCTAVE_TOLERANCE && !octave[i][state]) other = Math.max(other, emit[w][i]);
        }
        return emit[w][state] - other;
    });
    return { path, confidence: Math.max(0, Math.min(1, margins.reduce((a, b) => a + b, 0) / margins.length)) };
}

// The strongest value of a curve within ±halfMs of a time.
function sampler(values, frameTimeSec) {
    const t0 = frameTimeSec(0) * 1000;
    const frameMs = (frameTimeSec(1) - frameTimeSec(0)) * 1000;
    return (tMs, halfMs) => {
        const c = (tMs - t0) / frameMs;
        const h = halfMs / frameMs;
        let best = 0;
        for (let f = Math.max(0, Math.floor(c - h)); f <= Math.min(values.length - 1, Math.ceil(c + h)); f += 1) if (values[f] > best) best = values[f];
        return best;
    };
}

// Exact BPM of x[from, to) near `bpm` (±2.5 by 0.05, then ±0.05 by 0.005), and its beat phase from `phaseX`.
function refineSpan(x, phaseX, from, to, bpm, hopSec) {
    const periodOf = (b) => 60 / (b * hopSec);
    let best = { mag: -1, bpm };
    for (let b = bpm - REFINE_SPAN_BPM; b <= bpm + REFINE_SPAN_BPM + 1e-9; b += REFINE_COARSE_BPM) {
        const { mag } = fourierSpan(x, from, to, periodOf(b));
        if (mag > best.mag) best = { mag, bpm: b };
    }
    const around = best.bpm;
    for (let b = around - REFINE_COARSE_BPM; b <= around + REFINE_COARSE_BPM + 1e-9; b += REFINE_FINE_BPM) {
        const { mag } = fourierSpan(x, from, to, periodOf(b));
        if (mag > best.mag) best = { mag, bpm: b };
    }
    const period = periodOf(best.bpm);
    const { phase } = fourierSpan(phaseX, from, to, period);
    const firstFrame = (((phase / (2 * Math.PI)) * period) % period + period) % period;
    return { bpm: best.bpm, firstFrame };
}

// The kick drum marks the beat; hi-hats on the off-beats would pull the phase half a beat. The low band gives the
// phase when it has a beat of its own, else the full envelope does.
function phaseCurve(envelope, x) {
    const low = envelope.bands?.low;
    if (!low?.length) return x;
    const lowX = detrend(low, envelope.hopSec);
    let a = 0;
    let b = 0;
    for (let i = 0; i < x.length; i += 1) {
        a += x[i];
        b += lowX[i];
    }
    return b > 0.05 * a ? lowX : x;
}

// A rounder BPM (whole, then .1, then .01) when its grid drifts less than MAX_DRIFT_MS over the section.
export function roundSectionBpm(bpm, spanMs) {
    const beats = Math.max(1, spanMs / (60000 / bpm));
    for (const scale of [1, 10, 100]) {
        const r = Math.round(bpm * scale) / scale;
        if (beats * Math.abs(60000 / r - 60000 / bpm) < MAX_DRIFT_MS) return r;
    }
    return Math.round(bpm * 1000) / 1000;
}

// Where B takes over from A: the B beat near the rough boundary that leaves the most onset on A's beats before it and
// on B's beats after it (each beat counted against the typical level, so a missed beat costs).
function boundaryBetween(A, B, at, typical) {
    const lo = Math.max(A.startMs + A.beatMs, B.roughMs - BOUNDARY_SEARCH_SEC * 1000);
    const hi = Math.min(B.endMs - B.beatMs, B.roughMs + BOUNDARY_SEARCH_SEC * 1000);
    if (!(hi > lo)) return B.gridMs + Math.round((B.roughMs - B.gridMs) / B.beatMs) * B.beatMs;
    const beatsOf = (sec) => {
        const out = [];
        for (let k = Math.ceil((lo - sec.gridMs) / sec.beatMs); ; k += 1) {
            const t = sec.gridMs + k * sec.beatMs;
            if (t >= hi) break;
            out.push({ t, v: at(t, Math.min(12, sec.beatMs / 24)) - typical });
        }
        return out;
    };
    const a = beatsOf(A);
    const b = beatsOf(B);
    if (!b.length) return B.gridMs + Math.round((B.roughMs - B.gridMs) / B.beatMs) * B.beatMs;
    let sumA = 0;
    let sumB = b.reduce((s, x) => s + x.v, 0);
    let ia = 0;
    let best = { score: -Infinity, t: b[0].t };
    for (const cand of b) {
        while (ia < a.length && a[ia].t < cand.t) sumA += a[ia++].v;
        if (sumA + sumB > best.score) best = { score: sumA + sumB, t: cand.t };
        sumB -= cand.v;
    }
    return best.t;
}

// How much better a section's own BPM fits its stretch than a neighbour's.
function fitsBetter(sec, neighbour, x, hopSec, frameOf) {
    const from = frameOf(sec.startMs);
    const to = frameOf(sec.endMs);
    if (to - from < 4) return 0;
    const own = fourierSpan(x, from, to, 60 / (sec.bpm * hopSec)).mag;
    const other = fourierSpan(x, from, to, 60 / (neighbour.bpm * hopSec)).mag;
    return other > 0 ? own / other : Infinity;
}

// Merge neighbours closer than 0.05%, drop sections under 8 beats whose own BPM does not fit them 2× better
// than a neighbour's, and keep at most maxSections (the shortest go first).
function prune(sections, { x, hopSec, frameOf, maxSections }) {
    const list = sections.map((s) => ({ ...s }));
    const mergeInto = (i, j) => {
        const [lo, hi] = i < j ? [i, j] : [j, i];
        const merged = { ...list[j], startMs: list[lo].startMs, endMs: list[hi].endMs, roughMs: list[lo].roughMs };
        list.splice(lo, 2, merged);
    };
    for (let changed = true; changed;) {
        changed = false;
        for (let i = 1; i < list.length && !changed; i += 1) {
            if (Math.abs(list[i].bpm / list[i - 1].bpm - 1) < MERGE_RELATIVE) {
                mergeInto(i, i - 1);
                changed = true;
            }
        }
        for (let i = 0; i < list.length && list.length > 1 && !changed; i += 1) {
            const s = list[i];
            if ((s.endMs - s.startMs) / s.beatMs >= MIN_SECTION_BEATS) continue;
            const neighbours = [i - 1, i + 1].filter((j) => j >= 0 && j < list.length);
            const fit = neighbours.map((j) => fitsBetter(s, list[j], x, hopSec, frameOf));
            if (Math.min(...fit) > SHORT_SECTION_MARGIN) continue;
            mergeInto(i, neighbours[fit.indexOf(Math.min(...fit))]);
            changed = true;
        }
    }
    while (list.length > maxSections) {
        let i = 0;
        for (let k = 1; k < list.length; k += 1) if (list[k].endMs - list[k].startMs < list[i].endMs - list[i].startMs) i = k;
        mergeInto(i, i === 0 ? 1 : i - 1);
    }
    return list;
}

const clampBpm = (bpm) => Math.min(LIMITS_BPM[1], Math.max(LIMITS_BPM[0], bpm));

// Timing sections of the whole song: { sections: [{ timeMs, bpm, meter }], confidence (0..1 or null),
// variable, refinedErrMs (with fine onsets: how far the attacks sit from the grid) }.
// With `hint` (a Timing) its sections are kept and each one's BPM and red line are refined instead.
// When one section survives on its own (and there are no fine onsets) the answer is exactly detectTiming's.
export function detectTimingSections(envelope, { fine = null, maxSections = 32, hint = null } = {}) {
    const { values, hopSec, frameTimeSec } = envelope;
    const songMs = frameTimeSec(Math.max(0, values.length - 1)) * 1000;
    const single = () => {
        const one = detectTiming(envelope);
        return finish([{ timeMs: one.offsetMs, bpm: one.bpm, meter: 4, endMs: songMs }], { fine, songMs, confidence, single: true });
    };
    const x = detrend(values, hopSec);
    const frameOf = (ms) => Math.max(0, Math.min(values.length, Math.round((ms / 1000 - frameTimeSec(0)) / hopSec)));
    const phaseX = phaseCurve(envelope, x);
    let confidence = null;
    let sections;
    if (hint) {
        sections = hint.sections.map((s, i, all) => ({ roughMs: s.timeMs, bpm: s.bpm, meter: s.meter ?? 4, endMs: all[i + 1]?.timeMs ?? songMs }));
    } else {
        const { states, windows } = tempogram(x, hopSec);
        const v = viterbi(states, windows);
        confidence = v.confidence;
        sections = [];
        v.path.forEach((state, w) => {
            if (sections.length && sections.at(-1).state === state) return;
            const edge = w === 0 ? 0 : ((windows[w - 1].centerSec + windows[w].centerSec) / 2) * 1000;
            sections.push({ state, bpm: states[state], roughMs: edge, meter: 4 });
        });
        sections.forEach((s, i) => { s.endMs = sections[i + 1]?.roughMs ?? songMs; });
        if (sections.length === 1) return single();
    }

    // each section's exact BPM and grid, its start on its own grid, then out with the ones that do not hold
    const at = sampler(values, frameTimeSec);
    let typical = 0;
    let count = 0;
    for (let t = 0; t < songMs; t += 25, count += 1) typical += at(t, 12);
    typical /= Math.max(1, count);
    for (let pass = 0; pass < 3; pass += 1) {
        sections = sections.map((sec, i) => {
            const startMs = sec.startMs ?? (i === 0 && !hint ? 0 : sec.roughMs);
            const trim = BOUNDARY_TRIM_SEC * 1000;
            let a = frameOf(startMs + (i === 0 ? 0 : trim));
            let b = frameOf(sec.endMs - (i + 1 < sections.length ? trim : 0));
            if (b - a < 8) [a, b] = [frameOf(startMs), frameOf(sec.endMs)];
            const { bpm, firstFrame } = refineSpan(x, phaseX, a, b, sec.bpm, hopSec);
            const out = { ...sec, bpm, beatMs: 60000 / bpm, gridMs: frameTimeSec(firstFrame) * 1000, startMs };
            // a hint's red lines stay where they were, moved onto the nearest beat of the refined grid
            if (hint) out.startMs = out.gridMs += Math.round((sec.roughMs - out.gridMs) / out.beatMs) * out.beatMs;
            return out;
        });
        if (hint) break;
        for (let i = 1; i < sections.length; i += 1) {
            sections[i].startMs = boundaryBetween(sections[i - 1], sections[i], at, typical);
            sections[i - 1].endMs = sections[i].startMs;
        }
        const before = sections.length;
        sections = prune(sections, { x, hopSec, frameOf, maxSections });
        if (sections.length === 1) return single();
        if (sections.length === before) break;
    }
    const out = sections.map((s, i) => {
        // without a hint the first red line is the song's first beat, as detectTiming gives it
        const timeMs = i === 0 && !hint ? ((s.gridMs % s.beatMs) + s.beatMs) % s.beatMs : s.startMs;
        return { timeMs, bpm: s.bpm, meter: s.meter ?? 4, endMs: sections[i + 1]?.startMs ?? songMs };
    });
    return finish(out, { fine, songMs, confidence, single: false, hinted: !!hint });
}

// A later section keeps its own BPM only when it folds its attacks clearly tighter than the BPM before it does:
// a part with another feel (swing, a polyrhythm, an outro) at the same tempo joins the section before.
function confirmSplits(sections, fine, songMs) {
    const list = sections.map((s, i) => ({ ...s, endMs: sections[i + 1]?.timeMs ?? s.endMs ?? songMs }));
    for (let i = 1; i < list.length;) {
        const before = list[i - 1];
        const s = list[i];
        const beforeBpm = fineTempo(fine, { bpm: before.bpm, fromMs: i === 1 ? 0 : before.timeMs, toMs: before.endMs }).bpm;
        const own = fineTempo(fine, { bpm: s.bpm, fromMs: s.timeMs, toMs: s.endMs }).concentration;
        if (own > 0 && foldsAt(fine, { bpm: beforeBpm, fromMs: s.timeMs, toMs: s.endMs }) >= SPLIT_KEEP * own) {
            before.endMs = s.endMs;
            list.splice(i, 1);
        } else {
            i += 1;
        }
    }
    return list;
}

// With fine onsets each section's BPM and red line come from the attacks; BPMs are rounded where the grid allows.
function finish(sections, { fine, songMs, confidence, single, hinted = false }) {
    if (single && !fine) {
        return { sections: sections.map(({ timeMs, bpm, meter }) => ({ timeMs, bpm, meter })), confidence, variable: false, refinedErrMs: null };
    }
    if (fine && !hinted) sections = confirmSplits(sections, fine, songMs);
    const errs = [];
    const out = sections.map((s, i) => {
        const endMs = sections[i + 1]?.timeMs ?? s.endMs ?? songMs;
        const fromMs = i === 0 && !hinted ? 0 : s.timeMs;
        let { timeMs, bpm } = s;
        // with fine onsets: the BPM that folds the attacks tightest, then where in the beat they gather
        if (fine) bpm = fineTempo(fine, { bpm, fromMs, toMs: endMs }).bpm;
        const round = clampBpm(roundSectionBpm(bpm, endMs - fromMs));
        if (fine) {
            // a later section's red line stays within half a beat of where it was found, a hint's within a quarter
            // beat of where the user put it
            const withinMs = hinted ? Math.min(60000 / round / 4, 60) : null;
            timeMs = beatPhase(fine, { bpm: round, anchorMs: timeMs, fromMs, toMs: endMs, withinMs });
            const r = refineSection(fine, { timeMs, bpm: round, fromMs, toMs: endMs }, { tempo: false });
            timeMs = r.timeMs;
            if (r.errMs !== null) errs.push(r.errMs);
        }
        return { timeMs, bpm: round, meter: s.meter ?? 4 };
    });
    if (out.length && !hinted) {
        const beatMs = 60000 / out[0].bpm;
        out[0].timeMs = ((out[0].timeMs % beatMs) + beatMs) % beatMs;
    }
    const kept = [];
    for (const s of out) {
        const last = kept.at(-1);
        if (last && (s.timeMs <= last.timeMs || (!hinted && Math.abs(s.bpm / last.bpm - 1) < MERGE_RELATIVE))) continue;
        kept.push(s);
    }
    return {
        sections: kept,
        confidence,
        variable: kept.length > 1,
        refinedErrMs: errs.length ? Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 10) / 10 : null,
    };
}
