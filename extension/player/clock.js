// Audio clock ↔ chart time for the demo player (extension/DESIGN.md §5.6).
// chartMs = startChartMs + ((ctxTime − startAt) · 1000 + offsetMs) · rate, where ctxTime is the AudioContext time that
// is being heard at an instant: from ctx.getOutputTimestamp() when the browser has it, else currentTime − latency.
// The offset is in real ms (audio latency is real time), so it is added before the rate and one offset fits every
// rate (DESIGN §5.6 gives the same formula).
// While the AudioContext is suspended its time stands still, so a pause stops the chart too.

export const LEAD_IN_MS = 1500; // real time before the first note (or the preview start)
const SCHEDULE_AHEAD_S = 0.08; // room between "start" and the first audible sample

// ctx time heard at a performance.now()-based instant (event.timeStamp, rAF time). `nowMs` = performance.now().
export function ctxTimeAt(ctx, instantMs, nowMs = instantMs) {
    const current = Number(ctx?.currentTime) || 0;
    const ts = typeof ctx?.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0 && Number.isFinite(instantMs)) {
        const t = ts.contextTime + (instantMs - ts.performanceTime) / 1000;
        // a stale stamp (just after resume, or an odd driver) is not trusted: it has to stay near currentTime
        if (t <= current + 0.05 && t >= current - 0.5) return t;
    }
    const latency = Number(ctx?.outputLatency) || Number(ctx?.baseLatency) || 0;
    const late = Number.isFinite(instantMs) && Number.isFinite(nowMs) ? (instantMs - nowMs) / 1000 : 0;
    return current - latency + Math.min(0, late);
}

// How to start: chart time `startChartMs` is heard at ctx time `startAt`. The audio buffer's 0 is chart time
// `audioZeroChartMs` (0 for a full map, PreviewTime for the preview). Returns where the buffer starts and when.
export function planStart({ ctxNow, startChartMs, audioZeroChartMs = 0, rate = 1, ahead = SCHEDULE_AHEAD_S }) {
    const startAt = ctxNow + ahead;
    const into = (startChartMs - audioZeroChartMs) / 1000; // seconds of the buffer already behind at startAt
    if (into >= 0) return { startAt, when: startAt, bufferOffset: into };
    return { startAt, when: startAt + -into / rate, bufferOffset: 0 };
}

// Chart time where play starts: LEAD_IN_MS of real time before the first note (or before the preview's start).
export function startChartFor({ firstNoteMs, previewStartMs = null, rate = 1, leadInMs = LEAD_IN_MS }) {
    const anchor = previewStartMs ?? firstNoteMs ?? 0;
    return anchor - leadInMs * rate;
}

export function createClock({ startAt, startChartMs, rate = 1, offsetMs = 0 }) {
    const clock = {
        startAt,
        startChartMs,
        rate,
        offsetMs,
        // chart ms at a ctx time
        chartAt(ctxTime) {
            return clock.startChartMs + ((ctxTime - clock.startAt) * 1000 + clock.offsetMs) * clock.rate;
        },
        // chart ms of an event (event.timeStamp) or a frame (rAF time), both performance.now()-based
        chartAtInstant(ctx, instantMs, nowMs) {
            return clock.chartAt(ctxTimeAt(ctx, instantMs, nowMs));
        },
    };
    return clock;
}
