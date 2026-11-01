// Presses per lane for the key-lines widget, from one of three sources (times are map milliseconds):
// "kbd"  — the keyboard itself (osu! stable: native/key-reader hears the lanes' keys, keyDown() / keyUp() with the
//          real press and release times); once a real key comes in it has the lanes for the rest of the play;
// "keys" — tosu's key overlay counters, when they move (osu! stable has no key overlay in mania, so there they don't;
//          osu! lazer reports its play's key counters, in 4K the four lanes), or Interlude's own presses (press(),
//          release(), keysDown(): its per-note events and the columns it holds down);
// "map"  — rebuilt from the judgements: each new judgement takes the next note of the map near the live time
//          (osu!stable judges a hold note twice, on press and on release), and a hit note becomes a press in its lane.
// Misses are given to the oldest notes taken; a note left far behind (a missed frame, a count that drifted) is dropped.
// Priority: kbd over keys over map. A new play (reset()) gives the lanes back to the map until a key comes again.

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
    let source = "none"; // "map" once a map is set, "keys" once the counters move, "kbd" once a real key comes
    let base = null; // key counters at the start of the play
    let open = [];
    let mapLanes = keys; // the map's own key count (the keyboard's may differ: osu!'s key mods)
    const real = () => source === "keys" || source === "kbd";

    function setMap({ keys: k, notes }) {
        const before = lanes;
        mapLanes = Math.max(1, k || mapLanes);
        if (source !== "kbd") lanes = mapLanes;
        // real presses already counted are kept when the map's notes come in late
        if (!real() || lanes !== before) counts = new Array(lanes).fill(0);
        events = [];
        for (const note of notes ?? []) {
            events.push({ t: note.t, col: note.col, head: true, note });
            if (note.end !== null && note.end !== undefined) events.push({ t: note.end, col: note.col, head: false, note });
        }
        events.sort((a, b) => a.t - b.t);
        next = 0;
        if (!real()) source = events.length ? "map" : "none";
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
        if (!Array.isArray(list) || !Number.isFinite(timeMs) || source === "kbd") return [];
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

    // the real presses take over from the map's guesses (once); the keyboard's are never given up for them
    function takeKeys() {
        if (source === "keys" || source === "kbd") return;
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

    // The keyboard (osu! stable, src/overlay/session.js onKey): lane col went down at map time t, out of `keys` lanes
    // (the play's key count). The first one takes the lanes over from any other source. A bar is open until keyUp().
    // → { t, col, took } (took: this press took the lanes over), or null for a lane past the last
    function keyDown(col, t, keys = lanes) {
        if (!Number.isFinite(t) || !Number.isInteger(col) || col < 0) return null;
        let took = false;
        if (source !== "kbd") {
            source = "kbd";
            lanes = Math.max(1, keys || lanes);
            counts = new Array(lanes).fill(0);
            bars = [];
            open = [];
            took = true;
        }
        if (col >= lanes) return null;
        if (open[col]) keyUp(col, t);
        counts[col] += 1;
        const bar = { col, start: t, end: null };
        bars.push(bar);
        open[col] = bar;
        prune(t);
        return { t, col, took };
    }

    // lane col came up at map time t: its bar ends there (its real length, however short)
    function keyUp(col, t) {
        if (source !== "kbd") return;
        const bar = open[col];
        if (!bar) return;
        bar.end = Math.max(bar.start, Number.isFinite(t) ? t : bar.start);
        open[col] = null;
    }

    // every lane held down lets go at map time t (the keyboard stopped being heard)
    function releaseAll(t) {
        for (let col = 0; col < open.length; col += 1) {
            if (!open[col]) continue;
            open[col].end = Math.max(open[col].start, Number.isFinite(t) ? t : open[col].start);
            open[col] = null;
        }
    }

    // The keyboard's presses after map time t were none (keys taken in what turned out to be a pause, the clock
    // resuming from t): their bars and counts go; a bar let go after t ends at t; a key still held from before stays
    // held. → how many presses went
    function dropKeysAfter(t) {
        if (source !== "kbd" || !Number.isFinite(t)) return 0;
        let dropped = 0;
        bars = bars.filter((b) => {
            if (b.start <= t) {
                if (b.end !== null && b.end > t) b.end = Math.max(b.start, t);
                return true;
            }
            if (b.col < counts.length) counts[b.col] = Math.max(0, counts[b.col] - 1);
            if (open[b.col] === b) open[b.col] = null;
            dropped += 1;
            return false;
        });
        return dropped;
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
        keyDown,
        keyUp,
        releaseAll,
        dropKeysAfter,
        source: () => source,
        lanes: () => lanes,
        counts: () => [...counts],
        // bars that are still on screen at map time now (ending after now - spanMs)
        bars: (now, spanMs) => bars.filter((b) => b.end === null || b.end > now - spanMs).map((b) => ({ ...b })),
        // lanes lit at map time now
        pressed: (now) => Array.from({ length: lanes }, (_, col) =>
            bars.some((b) => b.col === col && b.start <= now && (b.end === null || b.end >= now))),
        reset() {
            // a new play: the keyboard has to take the lanes again (its reader may not be there this time)
            if (source === "kbd") {
                source = events.length ? "map" : "none";
                lanes = mapLanes;
            }
            next = 0;
            bars = [];
            counts = new Array(lanes).fill(0);
            base = null;
            open = [];
        },
    };
}
