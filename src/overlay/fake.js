// Made-up numbers for the style previews in the settings window and for placing widgets outside a play:
// a snapshot shaped like createOverlaySession().snapshot(), moving with the clock so the previews look alive.
import { formatRatio, maniaAccuracy } from "./format.js";
import { LANE_SPAN_MS } from "./session.js";

const STEP_MS = 95; // one fake note every this many ms, its lane from a fixed pattern
const PATTERN = [0, 2, 1, 3, 0, 3, 1, 2, 2, 0, 3, 1];

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
    const history = Array.from({ length: 40 }, (_, i) => Math.round(9 + 3 * Math.sin((t / 1000 + i / 4) / 1.7) + (i % 9 === 4 ? 2 : 0)));
    return {
        phase: "playing",
        running: true,
        rate: 1,
        clock: t,
        hits,
        ratio: formatRatio(hits.max, hits.n300),
        accuracy: maniaAccuracy(hits),
        ur: 98.42,
        kps: { now: history[history.length - 1], max: 14, history },
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
