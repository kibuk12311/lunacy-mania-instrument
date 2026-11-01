// Made-up numbers for the style previews in the settings window and for placing widgets outside a play:
// a snapshot shaped like createOverlaySession().snapshot(), moving with the clock so the previews look alive.
// options: the widgets' settings as a session takes them (src/overlay/settings.js sessionOptions()), so a preview
// shows the KPS graph's length and smoothing, the NPS graph's window and the key lines' speed as they are set.
// The made-up presses behind the KPS follow a rate going up and down, each a little off its beat.
// The map panel's map is made up too, its picture a gradient (the CSS's .m-fake).
import { formatRatio, maniaAccuracy } from "./format.js";
import { HALF_MS, smoothRate } from "./kps.js";
import { LANE_SPAN_MS } from "./session.js";
import { WINDOW_BACK, WINDOW_POINTS } from "./nps.js";

const STEP_MS = 95; // one fake note every this many ms, its lane from a fixed pattern
const PATTERN = [0, 2, 1, 3, 0, 3, 1, 2, 2, 0, 3, 1];
const FAKE_MAP_MS = 90_000; // the made-up map the NPS preview plays through, again and again
const KPS_AHEAD_MS = 60_000; // the made-up presses' clock runs this far ahead of the snapshot's
const JITTER_MS = 22; // the made-up presses are this much off the beat, either way
const kpsAt = (ms) => 9 + 3 * Math.sin(ms / 1700) + 1.2 * Math.sin(ms / 430);
// the made-up map's density: a quiet intro, two denser stretches, a short outro
const PROFILE = Array.from({ length: 160 }, (_, i) => {
    const edge = Math.min(1, i / 12, (159 - i) / 8);
    return Math.max(0, edge * (9 + 4 * Math.sin(i / 11) + 2 * Math.sin(i / 3.1)));
});
const PEAK = Math.max(...PROFILE) + 1.5;
// the Dan widget's made-up map: Gamma mid at 13.0, a profile 0.8 under it
const FAKE_DAN = 13;

// a number in [0, 1) fixed for an integer
function hash(n) {
    let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// the made-up presses from ms `from` to `to`: the k-th where the rate's integral reaches k, a little off it (the same
// press at any moment it is asked for)
const pressesBy = (ms) => (9 * ms - 3 * 1700 * Math.cos(ms / 1700) - 1.2 * 430 * Math.cos(ms / 430)) / 1000;
function fakePresses(from, to) {
    const out = [];
    let x = Math.max(0, from);
    for (let k = Math.ceil(pressesBy(x)); k <= pressesBy(to); k += 1) {
        for (let i = 0; i < 4; i += 1) x -= ((pressesBy(x) - k) * 1000) / kpsAt(x);
        out.push(x + (hash(k) - 0.5) * 2 * JITTER_MS);
    }
    return out.sort((p, q) => p - q);
}

// the made-up play's max at a smoothing: its highest rate over a fixed stretch, worked out once (a max that moved
// with the clock would move the preview graph's scale)
const maxes = new Map();
function fakeMax(half) {
    if (!maxes.has(half)) {
        const times = fakePresses(0, 120_000);
        let max = 0;
        for (let x = 0; x <= 120_000; x += 100) max = Math.max(max, smoothRate(times, x, { half }));
        maxes.set(half, Math.max(14, Math.ceil(max)));
    }
    return maxes.get(half);
}

// the made-up map's density at ms of the clock (it loops), between its profile's samples
function npsAt(ms) {
    const x = ((((ms % FAKE_MAP_MS) + FAKE_MAP_MS) % FAKE_MAP_MS) / FAKE_MAP_MS) * (PROFILE.length - 1);
    const i = Math.floor(x);
    return PROFILE[i] + (PROFILE[Math.min(PROFILE.length - 1, i + 1)] - PROFILE[i]) * (x - i);
}

// The Dan widget's payload as main sends it (src/overlay/dan.js), for the made-up map; preview: the play's own dan
// is shown too (outside a results screen), so every line turned on can be seen.
export function fakeDan() {
    return {
        key: "fake|1.00",
        checksum: "fake",
        rate: 1,
        state: "ok",
        numeric: FAKE_DAN,
        primary: "Jumpstream",
        tech: false,
        confidenceLevel: "high",
        fit: { delta: 0.8, playerDan: 12.2, band: "challenge", source: "tile", tile: "stamina" },
        recording: true,
        preview: true,
    };
}

// the map panel's state (src/overlay/mapInfo.js mapState()) for the made-up map, at the point of the clock
function fakeMap(t) {
    const lengthMs = FAKE_MAP_MS * 2;
    const elapsedMs = Math.floor((t % lengthMs) / 1000) * 1000;
    return {
        map: {
            title: "Moonlit Sprint", artist: "Nova Tide", difficulty: "4K Another", mapper: "Moonrunner", mods: ["HD"],
            rate: 1.25, bpm: { common: 222, min: 222, max: 222 }, stars: 5.25, lengthMs,
            dan: { state: "ok", numeric: FAKE_DAN }, preview: true,
        },
        progress: Math.round((elapsedMs / lengthMs) * 1000) / 1000,
        elapsedMs,
    };
}

export function fakeSnapshot(clockMs = 0, options = {}) {
    const t = Math.max(0, clockMs);
    const span = options.laneSpanMs > 0 ? options.laneSpanMs : LANE_SPAN_MS;
    const historyMs = options.kpsHistoryMs > 0 ? options.kpsHistoryMs : 10_000;
    const half = options.kpsHalfMs > 0 ? options.kpsHalfMs : HALF_MS;
    const bars = [];
    const first = Math.max(0, Math.floor((t - span) / STEP_MS));
    for (let i = first; i * STEP_MS <= t; i += 1) {
        const start = i * STEP_MS;
        const hold = i % 11 === 5 ? 380 : 45;
        bars.push({ col: PATTERN[i % PATTERN.length], start, end: start + hold });
    }
    const pressed = [0, 1, 2, 3].map((col) => bars.some((b) => b.col === col && b.start <= t && b.end >= t));
    const notes = Math.floor(t / STEP_MS);
    const hits = { max: 1532 + notes, n300: 364 + Math.floor(notes / 5), n200: 41, n100: 9, n50: 2, miss: 3 };
    // the same shape as the KPS meter's history: the graph's length on a grid of 100 steps, then the point at the
    // clock (the made-up presses began long before it, so even a long graph is full from the start)
    const kt = t + KPS_AHEAD_MS;
    const step = Math.max(1, Math.ceil(historyMs / 100 / 100)) * 100;
    const n = Math.round(historyMs / step);
    const last = Math.floor(kt / step) * step;
    const times = fakePresses(last - historyMs - 2 * half, kt);
    const rate = (x) => smoothRate(times, x, { half });
    const values = Array.from({ length: n + 1 }, (_, i) => rate(last - (n - i) * step));
    values.push(rate(kt));
    const kpsNow = rate(kt);
    // the NPS graph: the whole made-up map with the playhead going along, or a window of it around the playhead
    const progress = (t % FAKE_MAP_MS) / FAKE_MAP_MS;
    const npsNow = npsAt(t);
    let profile = PROFILE;
    if (options.npsWindowMs > 0) {
        const w = options.npsWindowMs;
        const wStep = w / WINDOW_POINTS;
        const from = t - w * WINDOW_BACK;
        const start = Math.floor(from / wStep) * wStep;
        const list = Array.from({ length: WINDOW_POINTS + 1 }, (_, i) => npsAt(start + i * wStep));
        list.push(npsAt(from + w));
        profile = { values: list, shift: (from - start) / wStep };
    }
    return {
        phase: "playing",
        running: true,
        rate: 1,
        checksum: "fake",
        mode: 3,
        mods: [],
        odSet: null,
        clock: t,
        dan: fakeDan(),
        ...fakeMap(t),
        hits,
        ratio: formatRatio(hits.max, hits.n300),
        accuracy: maniaAccuracy(hits),
        ur: 98.42,
        judgeNames: null,
        kps: { now: kpsNow, max: fakeMax(half), history: { values, shift: (kt - last) / step } },
        nps: {
            ready: true, now: npsNow, peak: PEAK, profile,
            progress: options.npsWindowMs > 0 ? WINDOW_BACK : progress,
            top: options.npsWindowMs > 0 ? PEAK : Math.max(...PROFILE),
        },
        lanes: {
            keys: 4,
            source: "map",
            counts: [0, 1, 2, 3].map((c) => 512 + c * 37 + Math.floor(notes / 4)),
            pressed,
            spanMs: span,
            bars,
        },
    };
}
