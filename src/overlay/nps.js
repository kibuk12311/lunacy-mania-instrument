// Notes per second of the map being played (not of the presses): the NPS at the play position, the map's peak, and
// the density of the whole map for the NPS widget's graph. A hold note counts once, by its head.
// Everything is in real time (map time / rate), so DT, HT and rate copies read what the hands have to do.
// The map is known ahead, so the window is centred on the play position itself: no lag, the same triangle as KPS.
import { HALF_MS, smoothRate } from "./kps.js";

export const PROFILE_POINTS = 160; // samples of the whole-map graph
const PEAK_STEP_MS = 50;

export function createNpsTrack({ half = HALF_MS, points = PROFILE_POINTS } = {}) {
    let heads = []; // map ms, sorted
    let rate = 1;
    let cache = null; // { rate, times, first, last, peak, profile }

    function build() {
        if (cache && cache.rate === rate) return cache;
        const times = heads.map((t) => t / rate);
        if (!times.length) return (cache = { rate, times, first: 0, last: 0, peak: 0, profile: [] });
        const first = times[0];
        const last = times[times.length - 1];
        const at = (t, h) => smoothRate(times, t + h, { half: h, lag: h });
        let peak = 0;
        for (let t = first; t <= last; t += PEAK_STEP_MS) peak = Math.max(peak, at(t, half));
        // the whole map in `points` samples: the window widens with the spacing, so nothing between samples is lost
        const span = Math.max(1, last - first);
        const wide = Math.max(half, span / points);
        const profile = Array.from({ length: points }, (_, i) => at(first + (span * i) / (points - 1), wide));
        return (cache = { rate, times, first, last, peak, profile });
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
        ready: () => heads.length > 0,
        // the widget's numbers at map time clockMs
        at(clockMs) {
            const c = build();
            if (!c.times.length) return { ready: false, now: 0, peak: 0, profile: [], progress: 0 };
            const t = clockMs / rate;
            return {
                ready: true,
                now: smoothRate(c.times, t + half, { half, lag: half }),
                peak: c.peak,
                profile: c.profile,
                progress: Math.min(1, Math.max(0, (t - c.first) / Math.max(1, c.last - c.first))),
            };
        },
        reset() {
            heads = [];
            cache = null;
        },
    };
}
