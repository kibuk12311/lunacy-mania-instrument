// Notes per second of the map being played (not of the presses): the NPS at the play position, the map's peak, and
// the density of the whole map for the NPS widget's graph. A hold note counts once, by its head.
// Everything is in real time (map time / rate), so DT, HT and rate copies read what the hands have to do.
// The map is known ahead, so the window is centred on the play position itself: no lag, the same triangle as KPS.
// The graph is the whole map with the playhead moving along it, or (a window of windowMs, the widget's setting) the
// stretch around the play position scrolling under a fixed playhead: WINDOW_BACK of it played, the rest to come.
// Either way its top is fixed for the play (the profile's highest point, or the map's peak), so it never rescales.
import { HALF_MS, smoothRate } from "./kps.js";

export const PROFILE_POINTS = 160; // samples of the whole-map graph
export const WINDOW_POINTS = 100; // grid steps of a windowed graph
export const WINDOW_BACK = 1 / 3; // where the playhead stands in a windowed graph
const PEAK_STEP_MS = 50;

export function createNpsTrack({ half: half0 = HALF_MS, points = PROFILE_POINTS } = {}) {
    let heads = []; // map ms, sorted
    let rate = 1;
    let half = half0;
    let cache = null; // { rate, half, times, first, last, peak, profile, top }

    function build() {
        if (cache && cache.rate === rate && cache.half === half) return cache;
        const times = heads.map((t) => t / rate);
        if (!times.length) return (cache = { rate, half, times, first: 0, last: 0, peak: 0, profile: [], top: 0 });
        const first = times[0];
        const last = times[times.length - 1];
        const at = (t, h) => smoothRate(times, t + h, { half: h, lag: h });
        let peak = 0;
        for (let t = first; t <= last; t += PEAK_STEP_MS) peak = Math.max(peak, at(t, half));
        // the whole map in `points` samples: the window widens with the spacing, so nothing between samples is lost
        const span = Math.max(1, last - first);
        const wide = Math.max(half, span / points);
        const profile = Array.from({ length: points }, (_, i) => at(first + (span * i) / (points - 1), wide));
        return (cache = { rate, half, times, first, last, peak, profile, top: Math.max(0, ...profile) });
    }

    // the stretch around real time t on a grid (src/overlay/draw.js graphPoints' { values, shift }): from
    // t - WINDOW_BACK · windowMs to windowMs further, the grid fixed to the map's time so it scrolls without moving
    function windowed(c, t, windowMs) {
        const step = windowMs / WINDOW_POINTS;
        const from = t - windowMs * WINDOW_BACK;
        const first = Math.floor(from / step) * step;
        const at = (x) => smoothRate(c.times, x + half, { half, lag: half });
        const values = Array.from({ length: WINDOW_POINTS + 1 }, (_, i) => at(first + i * step));
        values.push(at(from + windowMs));
        return { values, shift: (from - first) / step };
    }

    return {
        // notes: parseManiaNotes().notes ([{ t }]), sorted
        setMap(notes) {
            heads = (notes ?? []).map((n) => n.t).filter(Number.isFinite).sort((a, b) => a - b);
            cache = null;
        },
        setRate(r) {
            rate = r > 0 ? r : 1;
        },
        // the smoothing: half the triangle's width, real ms
        setHalf(h) {
            if (Number.isFinite(h) && h > 0) half = h;
        },
        ready: () => heads.length > 0,
        // the widget's numbers at map time clockMs; windowMs > 0: the graph is that much of the map around the play
        // position (progress is then where the playhead stands in it); top: the graph's top, fixed for the play
        at(clockMs, { windowMs = 0 } = {}) {
            const c = build();
            if (!c.times.length) return { ready: false, now: 0, peak: 0, profile: [], progress: 0, top: 0 };
            const t = clockMs / rate;
            const now = smoothRate(c.times, t + half, { half, lag: half });
            if (windowMs > 0) return { ready: true, now, peak: c.peak, profile: windowed(c, t, windowMs), progress: WINDOW_BACK, top: c.peak };
            return {
                ready: true,
                now,
                peak: c.peak,
                profile: c.profile,
                progress: Math.min(1, Math.max(0, (t - c.first) / Math.max(1, c.last - c.first))),
                top: c.top,
            };
        },
        reset() {
            heads = [];
            cache = null;
        },
    };
}
