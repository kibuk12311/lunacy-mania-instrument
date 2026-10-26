// Keys per second, smoothed, its maximum for the play, and a history for the graph.
// Times are play-clock milliseconds in real time (map time / rate), so 1.5× counts what the hands actually press.
// Presses may arrive a little out of order (judgements come late, in bursts of a tosu frame); they are kept sorted.
//
// Steady by construction: the rate at t is a triangular window over (t - 2·HALF, t] peaking at t - HALF, so a press
// enters and leaves the window with no weight and the newest ones (the ones still arriving late) count for little.
// The graph samples that rate on a fixed grid (multiples of stepMs): a finished sample never moves when the clock
// does, and only the newest point (at t itself) slides along between them.

export const HALF_MS = 400; // half the window: the curve lags this much, a step in the rate is half through by then

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

export function createKpsMeter({ historyMs = 10_000, stepMs = 100, half = HALF_MS } = {}) {
    let times = []; // sorted
    let max = 0;
    const rate = (t) => smoothRate(times, t, { half });

    function press(t, n = 1) {
        if (!Number.isFinite(t)) return;
        for (let k = 0; k < n; k += 1) {
            let i = times.length;
            while (i > 0 && times[i - 1] > t) i -= 1;
            times.splice(i, 0, t);
        }
        // the grid samples whose window holds this press can only have grown
        for (let g = Math.ceil(t / stepMs) * stepMs; g < t + 2 * half; g += stepMs) max = Math.max(max, rate(g));
        const oldest = times[times.length - 1] - historyMs - 2 * half - stepMs;
        if (times[0] < oldest) times = times.filter((x) => x >= oldest);
    }

    return {
        press,
        now: (t) => rate(t),
        max: () => max,
        // the rate on the grid over the last historyMs, oldest first, then one more point at t itself;
        // shift = how far t is past the last grid point, in steps (0..1), so the graph scrolls smoothly
        history(t) {
            const n = Math.round(historyMs / stepMs);
            const last = Math.floor(t / stepMs) * stepMs;
            const values = Array.from({ length: n + 1 }, (_, i) => rate(last - (n - i) * stepMs));
            values.push(rate(t));
            return { values, shift: (t - last) / stepMs };
        },
        reset() {
            times = [];
            max = 0;
        },
    };
}
