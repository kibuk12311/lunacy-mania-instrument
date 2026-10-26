// Made-up numbers for the style previews in the settings window and for placing widgets outside a play:
// a snapshot shaped like createOverlaySession().snapshot(), moving with the clock so the previews look alive.
import { formatRatio, maniaAccuracy } from "./format.js";
import { LANE_SPAN_MS } from "./session.js";

const STEP_MS = 95; // one fake note every this many ms, its lane from a fixed pattern
const PATTERN = [0, 2, 1, 3, 0, 3, 1, 2, 2, 0, 3, 1];
const FAKE_MAP_MS = 90_000; // the made-up map the NPS preview plays through, again and again
const kpsAt = (ms) => 9 + 3 * Math.sin(ms / 1700) + 1.2 * Math.sin(ms / 430);
// the made-up map's density: a quiet intro, two denser stretches, a short outro
const PROFILE = Array.from({ length: 160 }, (_, i) => {
    const edge = Math.min(1, i / 12, (159 - i) / 8);
    return Math.max(0, edge * (9 + 4 * Math.sin(i / 11) + 2 * Math.sin(i / 3.1)));
});
const PEAK = Math.max(...PROFILE) + 1.5;

export function fakeSnapshot(clockMs = 0) {
    const t = Math.max(0, clockMs);
    const bars = [];
    const first = Math.max(0, Math.floor((t - LANE_SPAN_MS) / STEP_MS));
    for (let i = first; i * STEP_MS <= t; i += 1) {
        const start = i * STEP_MS;
        const hold = i % 11 === 5 ? 380 : 45;
        bars.push({ col: PATTERN[i % PATTERN.length], start, end: start + hold });
    }
    const pressed = [0, 1, 2, 3].map((col) => bars.some((b) => b.col === col && b.start <= t && b.end >= t));
    const notes = Math.floor(t / STEP_MS);
    const hits = { max: 1532 + notes, n300: 364 + Math.floor(notes / 5), n200: 41, n100: 9, n50: 2, miss: 3 };
    // the same shape as the KPS meter's history: 10 s on a 100 ms grid, then the point at t
    const last = Math.floor(t / 100) * 100;
    const values = Array.from({ length: 101 }, (_, i) => kpsAt(last - (100 - i) * 100));
    values.push(kpsAt(t));
    const progress = (t % FAKE_MAP_MS) / FAKE_MAP_MS;
    const npsNow = PROFILE[Math.min(PROFILE.length - 1, Math.round(progress * (PROFILE.length - 1)))];
    return {
        phase: "playing",
        running: true,
        rate: 1,
        clock: t,
        hits,
        ratio: formatRatio(hits.max, hits.n300),
        accuracy: maniaAccuracy(hits),
        ur: 98.42,
        kps: { now: kpsAt(t), max: 14, history: { values, shift: (t - last) / 100 } },
        nps: { ready: true, now: npsNow, peak: PEAK, profile: PROFILE, progress },
        lanes: {
            keys: 4,
            source: "map",
            counts: [0, 1, 2, 3].map((c) => 512 + c * 37 + Math.floor(notes / 4)),
            pressed,
            spanMs: LANE_SPAN_MS,
            bars,
        },
    };
}
