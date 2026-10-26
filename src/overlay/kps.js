// Keys per second over a sliding window, its maximum for the play, and a short history for the graph.
// Times are play-clock milliseconds in real time (map time / rate), so 1.5× counts what the hands actually press.
// Presses may arrive a little out of order (judgements come late); they are kept sorted.

export function createKpsMeter({ windowMs = 1000, historyMs = 10_000, stepMs = 250 } = {}) {
    let times = []; // sorted
    let max = 0;

    // presses in (t - windowMs, t]
    const countAt = (t) => {
        let n = 0;
        for (let i = times.length - 1; i >= 0 && times[i] > t - windowMs; i -= 1) if (times[i] <= t) n += 1;
        return n;
    };

    function press(t, n = 1) {
        if (!Number.isFinite(t)) return;
        for (let k = 0; k < n; k += 1) {
            let i = times.length;
            while (i > 0 && times[i - 1] > t) i -= 1;
            times.splice(i, 0, t);
        }
        // the windows ending at this press and at the presses just after it can only have grown
        for (const p of times) if (p >= t && p < t + windowMs) max = Math.max(max, countAt(p));
        const oldest = times[times.length - 1] - historyMs - windowMs;
        if (times[0] < oldest) times = times.filter((x) => x >= oldest);
    }

    return {
        press,
        now: (t) => countAt(t),
        max: () => max,
        // KPS every stepMs over the last historyMs, oldest first, ending at t
        history(t) {
            const n = Math.round(historyMs / stepMs);
            return Array.from({ length: n }, (_, i) => countAt(t - (n - 1 - i) * stepMs));
        },
        reset() {
            times = [];
            max = 0;
        },
    };
}
