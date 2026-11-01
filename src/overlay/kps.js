// Keys per second, smoothed, its maximum for the play, and a history for the graph.
// Times are play-clock milliseconds in real time (map time / rate), so 1.5× counts what the hands actually press.
// Presses may arrive a little out of order (judgements come late, in bursts of a tosu frame); they are kept sorted.
//
// Steady by construction: the rate at t is a triangular window over (t - 2·HALF, t] peaking at t - HALF, so a press
// enters and leaves the window with no weight. The graph samples that rate on a fixed grid (multiples of stepMs).
// Presses made from osu! stable's judgements reach the meter only with the next tosu frame, 100-300 ms after their
// own time (tosu reads osu! every 150 ms or so, and a note is judged when it is hit): a curve drawn up to the clock
// would droop at its newest end until they come and then jump back up, a few times a second. So the meter tells the
// rate at the clock less a settle delay: how late its presses come (most of them, press(t, n, lateMs)), followed
// slowly (SETTLE_FOLLOW), so the drawn curve and the number see only presses that are already in and the graph still
// scrolls at the clock's pace. Presses that come at once (the keyboard, the key counters) have no delay.

export const HALF_MS = 400; // half the window: the curve lags this much, a step in the rate is half through by then
export const SETTLE_MAX_MS = 500; // the settle delay never goes past this (a stalled tosu is not waited for)
export const SETTLE_SAMPLES = 64; // the presses whose lateness sets the delay
export const SETTLE_QUANTILE = 0.9; // the delay covers this share of them
export const SETTLE_FOLLOW = 0.1; // ms the delay moves per ms of the clock: the graph scrolls at 90-110 % of its pace

// sorted times → events per second at t: a triangular window of half-width `half` centred at t - lag.
// Times after t are not counted (a note judged a little early has not been pressed yet).
export function smoothRate(times, t, { half = HALF_MS, lag = half } = {}) {
    const centre = t - lag;
    const end = Math.min(t, centre + half);
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= centre - half) lo = mid + 1;
        else hi = mid;
    }
    let sum = 0;
    for (let i = lo; i < times.length && times[i] <= end; i += 1) sum += Math.max(0, 1 - Math.abs(times[i] - centre) / half);
    return (sum * 1000) / half;
}

// The graph's length (historyMs) and the smoothing (half) can change while a play goes on (configure()): a history
// longer than HISTORY_POINTS steps is drawn on a coarser grid; the max so far is kept.
export const HISTORY_POINTS = 100;

export function createKpsMeter({ historyMs: history0 = 10_000, stepMs = 100, half: half0 = HALF_MS, settleMaxMs = SETTLE_MAX_MS } = {}) {
    let historyMs = history0;
    let half = half0;
    let times = []; // sorted
    let max = 0;
    let peaks = new Map(); // grid ms -> the rate there, for the grid samples whose window holds a press still kept
    let maxOld = 0; // the highest of the samples gone from peaks
    let lates = []; // the lateness of the last SETTLE_SAMPLES presses, ms
    let target = 0; // the settle delay they ask for
    let delay = 0; // the settle delay in use, ms
    let lastT = null; // the clock of the last reading
    const rate = (t) => smoothRate(times, t, { half });

    // the clock t → the time the rate is told at; the delay follows its target as the clock goes on
    function settled(t) {
        if (lastT !== null && t > lastT) {
            const step = SETTLE_FOLLOW * (t - lastT);
            delay = target > delay ? Math.min(target, delay + step) : Math.max(target, delay - step);
        }
        lastT = t;
        return t - delay;
    }

    // a press (n of them) at time t that reached the meter lateMs after it (0: at once)
    function press(t, n = 1, lateMs = 0) {
        if (!Number.isFinite(t)) return;
        const first = times.length === 0;
        for (let k = 0; k < n; k += 1) {
            let i = times.length;
            while (i > 0 && times[i - 1] > t) i -= 1;
            times.splice(i, 0, t);
        }
        lates.push(Math.min(settleMaxMs, Math.max(0, Number.isFinite(lateMs) ? lateMs : 0)));
        if (lates.length > SETTLE_SAMPLES) lates.shift();
        const sorted = [...lates].sort((a, b) => a - b);
        target = sorted[Math.min(sorted.length - 1, Math.floor(SETTLE_QUANTILE * sorted.length))];
        if (first && max === 0) delay = target; // nothing drawn yet: no scroll to keep steady
        // the grid samples whose window holds this press can only have grown
        for (let g = Math.ceil(t / stepMs) * stepMs; g < t + 2 * half; g += stepMs) {
            const v = rate(g);
            peaks.set(g, v);
            max = Math.max(max, v);
        }
        const oldest = times[times.length - 1] - historyMs - 2 * half - stepMs - settleMaxMs;
        if (times[0] < oldest) {
            times = times.filter((x) => x >= oldest);
            for (const [g, v] of peaks) {
                if (g >= oldest + 2 * half) continue;
                maxOld = Math.max(maxOld, v);
                peaks.delete(g);
            }
        }
    }

    // the presses after t were none after all (keys taken in a pause, src/overlay/session.js): they go, and so does
    // what they added to the max
    function dropAfter(t) {
        if (!Number.isFinite(t) || !times.length || times[times.length - 1] <= t) return;
        times = times.filter((x) => x <= t);
        const newest = times.length ? times[times.length - 1] : -Infinity;
        for (const g of [...peaks.keys()]) {
            if (g <= t) continue;
            if (g < newest + 2 * half) peaks.set(g, rate(g));
            else peaks.delete(g);
        }
        max = Math.max(maxOld, ...peaks.values());
    }

    // a new graph length and smoothing: the presses kept stay, and the max so far; the grid samples count anew
    function configure({ historyMs: h = historyMs, half: hf = half } = {}) {
        if (Number.isFinite(h) && h > 0) historyMs = h;
        if (Number.isFinite(hf) && hf > 0 && hf !== half) {
            half = hf;
            maxOld = max;
            peaks = new Map();
        }
    }

    return {
        press,
        dropAfter,
        configure,
        options: () => ({ historyMs, half }),
        now: (t) => rate(settled(t)),
        max: () => max,
        // the settle delay in use, ms
        delay: () => delay,
        // the rate on the grid over the last historyMs, oldest first, then one more point at the settled time itself;
        // shift = how far that is past the last grid point, in steps (0..1), so the graph scrolls smoothly; at = that time.
        // The grid is stepMs, or a multiple of it for a history longer than HISTORY_POINTS of them
        history(t) {
            const s = settled(t);
            const step = Math.max(1, Math.ceil(historyMs / stepMs / HISTORY_POINTS)) * stepMs;
            const n = Math.round(historyMs / step);
            const last = Math.floor(s / step) * step;
            const values = Array.from({ length: n + 1 }, (_, i) => rate(last - (n - i) * step));
            values.push(rate(s));
            return { values, shift: (s - last) / step, at: s };
        },
        reset() {
            times = [];
            max = 0;
            peaks = new Map();
            maxOld = 0;
            lates = [];
            target = 0;
            delay = 0;
            lastT = null;
        },
    };
}
