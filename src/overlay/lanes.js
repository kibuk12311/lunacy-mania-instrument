// Presses per lane for the key-lines widget, from one of two sources (times are map milliseconds):
// "keys" — tosu's key overlay counters, when they move (osu! stable has no key overlay in mania, so there they don't;
//          osu! lazer reports its play's key counters, in 4K the four lanes), or Interlude's own presses (press(),
//          release(), keysDown(): its per-note events and the columns it holds down);
// "map"  — rebuilt from the judgements: each new judgement takes the next note of the map near the live time
//          (osu!stable judges a hold note twice, on press and on release), and a hit note becomes a press in its lane.
// Misses are given to the oldest notes taken; a note left far behind (a missed frame, a count that drifted) is dropped.

export const TAP_MS = 45; // how long a tap is drawn
const EARLY_MS = 250; // a note can be judged this long before its time
const STALE_MS = 1000; // a note not judged this long after its time is skipped
const KEEP_MS = 6000; // bars kept behind the clock

export function createLaneTracker({ keys = 4 } = {}) {
    let lanes = keys;
    let events = []; // map mode: { t, col, head, note }
    let next = 0;
    let bars = []; // { col, start, end } (end null: still held)
    let counts = new Array(lanes).fill(0);
    let source = "none"; // "map" once a map is set, "keys" once the counters move
    let base = null; // key counters at the start of the play
    let open = [];

    function setMap({ keys: k, notes }) {
        const before = lanes;
        lanes = Math.max(1, k || lanes);
        // real presses already counted are kept when the map's notes come in late
        if (source !== "keys" || lanes !== before) counts = new Array(lanes).fill(0);
        events = [];
        for (const note of notes ?? []) {
            events.push({ t: note.t, col: note.col, head: true, note });
            if (note.end !== null && note.end !== undefined) events.push({ t: note.end, col: note.col, head: false, note });
        }
        events.sort((a, b) => a.t - b.t);
        next = 0;
        if (source !== "keys") source = events.length ? "map" : "none";
    }

    const prune = (now) => {
        if (bars.length > 400) bars = bars.filter((b) => b.end === null || b.end > now - KEEP_MS);
    };

    // hit / miss = how many judgements of each were added since the last frame, at map time liveMs → presses [{ t, col }]
    function judge({ hit = 0, miss = 0 }, liveMs) {
        if (source !== "map" || !Number.isFinite(liveMs)) return [];
        while (next < events.length && events[next].t < liveMs - STALE_MS) next += 1;
        const taken = [];
        let k = hit + miss;
        while (k > 0 && next < events.length && events[next].t <= liveMs + EARLY_MS) {
            taken.push(events[next]);
            next += 1;
            k -= 1;
        }
        let misses = miss;
        const presses = [];
        for (const e of taken) {
            if (misses > 0) {
                misses -= 1;
                continue;
            }
            if (!e.head || e.col >= lanes) continue;
            counts[e.col] += 1;
            bars.push({ col: e.col, start: e.t, end: e.note.end ?? e.t + TAP_MS });
            presses.push({ t: e.t, col: e.col });
        }
        prune(liveMs);
        return presses;
    }

    // tosu's key counters [{ pressed, count }] at map time timeMs → presses [{ t, col }]
    function keysFrame(list, timeMs) {
        if (!Array.isArray(list) || !Number.isFinite(timeMs)) return [];
        if (!base) {
            base = list.map((k) => k.count);
            return [];
        }
        const presses = [];
        list.forEach((key, i) => {
            const d = key.count - (base[i] ?? 0);
            if (d < 0) {
                base[i] = key.count; // osu! reset its counters
                return;
            }
            if (d > 0) {
                if (source !== "keys") {
                    // the first real counter move: the keys take over, the map's guesses go
                    source = "keys";
                    lanes = Math.max(list.length, 1);
                    counts = new Array(lanes).fill(0);
                    bars = [];
                }
                for (let j = 0; j < d; j += 1) {
                    counts[i] += 1;
                    presses.push({ t: timeMs, col: i });
                    const held = j === d - 1 && key.pressed;
                    const bar = { col: i, start: timeMs, end: held ? null : timeMs + TAP_MS };
                    bars.push(bar);
                    if (held) open[i] = bar;
                }
            }
            if (!key.pressed && open[i]) {
                open[i].end = Math.max(open[i].start + TAP_MS, timeMs);
                open[i] = null;
            }
            base[i] = key.count;
        });
        prune(timeMs);
        return source === "keys" ? presses : [];
    }

    // the real presses take over from the map's guesses (once)
    function takeKeys() {
        if (source === "keys") return;
        source = "keys";
        counts = new Array(lanes).fill(0);
        bars = [];
        open = [];
    }

    // A real press in lane col at map time t (Interlude's events): a bar until release(col) when held, else a tap.
    // → { t, col }, or null for a lane past the last
    function press(col, t, { hold = false } = {}) {
        if (!Number.isFinite(t) || !Number.isInteger(col) || col < 0) return null;
        takeKeys();
        if (col >= lanes) return null;
        if (open[col]) release(col, t);
        counts[col] += 1;
        const bar = { col, start: t, end: hold ? null : t + TAP_MS };
        bars.push(bar);
        if (hold) open[col] = bar;
        prune(t);
        return { t, col };
    }

    function release(col, t) {
        const bar = open[col];
        if (!bar) return;
        bar.end = Math.max(bar.start + TAP_MS, Number.isFinite(t) ? t : bar.start);
        open[col] = null;
    }

    // the columns held down at map time t: a held bar whose key is up ends there
    function keysDown(cols, t) {
        const down = new Set(cols);
        for (let col = 0; col < open.length; col += 1) if (open[col] && !down.has(col) && t >= open[col].start) release(col, t);
    }

    return {
        setMap,
        judge,
        keysFrame,
        press,
        release,
        keysDown,
        source: () => source,
        lanes: () => lanes,
        counts: () => [...counts],
        // bars that are still on screen at map time now (ending after now - spanMs)
        bars: (now, spanMs) => bars.filter((b) => b.end === null || b.end > now - spanMs).map((b) => ({ ...b })),
        // lanes lit at map time now
        pressed: (now) => Array.from({ length: lanes }, (_, col) =>
            bars.some((b) => b.col === col && b.start <= now && (b.end === null || b.end >= now))),
        reset() {
            next = 0;
            bars = [];
            counts = new Array(lanes).fill(0);
            base = null;
            open = [];
        },
    };
}
