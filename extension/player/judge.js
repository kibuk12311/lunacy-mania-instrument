// osu!mania judgements for the demo player (extension/DESIGN.md §5.6): osu!stable hit windows by OD in real ms
// (hit error = Δchart / rate), long notes (head + tail), combo, accuracy and unstable rate. Pure: no DOM, no clock.

export const JUDGEMENTS = Object.freeze(["max", "n300", "n200", "n100", "n50", "miss"]);
export const TAIL_FACTOR = 1.5;

// osu!stable mania windows (± ms of real time) for an OD. "miss" is how early a press still counts (as a miss).
export function hitWindows(od) {
    const o = Math.min(10, Math.max(0, Number(od) || 0));
    return Object.freeze({ max: 16, n300: 64 - 3 * o, n200: 97 - 3 * o, n100: 127 - 3 * o, n50: 151 - 3 * o, miss: 188 - 3 * o });
}

export function scaleWindows(w, factor) {
    return Object.freeze(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v * factor])));
}

// Judgement for an absolute error (ms) inside the 50 window, else null.
export function judgementFor(absError, w) {
    const e = Math.abs(absError);
    if (e <= w.max) return "max";
    if (e <= w.n300) return "n300";
    if (e <= w.n200) return "n200";
    if (e <= w.n100) return "n100";
    if (e <= w.n50) return "n50";
    return null;
}

// --- copied from src/overlay/format.js (tests/extension/player/judge.test.js checks they agree) ---
// osu!stable mania accuracy in percent: MAX and 300 both count as 300, then 200, 100, 50, miss 0. null before any judgement.
export function maniaAccuracy({ max = 0, n300 = 0, n200 = 0, n100 = 0, n50 = 0, miss = 0 } = {}) {
    const total = max + n300 + n200 + n100 + n50 + miss;
    if (!(total > 0)) return null;
    return (100 * (300 * (max + n300) + 200 * n200 + 100 * n100 + 50 * n50)) / (300 * total);
}

const finite = (x) => typeof x === "number" && Number.isFinite(x);
// Unstable rate from hit errors in ms: ten times their standard deviation (as osu! counts it). null with fewer than two.
export function unstableRate(errors) {
    const list = Array.isArray(errors) ? errors.filter(finite) : [];
    if (list.length < 2) return null;
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    const variance = list.reduce((s, x) => s + (x - mean) ** 2, 0) / list.length;
    return Math.sqrt(variance) * 10;
}
// --- end of the copy ---

// notes: [{ col, t, end|null }] sorted by t (chart ms); keys 4; od; rate (0.5–2).
// Each judgement is reported through the returned events and counted in stats().
export function createJudge({ notes, keys = 4, od = 5, rate = 1 }) {
    const w = hitWindows(od);
    const wt = scaleWindows(w, TAIL_FACTOR);
    const r = Number(rate) > 0 ? Number(rate) : 1;
    const list = notes.map((n) => ({ col: n.col, t: n.t, end: n.end ?? null }));
    const head = new Array(list.length).fill(null); // judgement of the head (or the note)
    const tail = new Array(list.length).fill(null); // judgement of an LN's tail
    const broken = new Array(list.length).fill(false); // LN released early or head missed: the body greys
    const byCol = Array.from({ length: keys }, () => []);
    list.forEach((n, i) => byCol[n.col]?.push(i));
    const next = new Array(keys).fill(0); // per column: index into byCol of the first head not judged yet
    const holding = new Array(keys).fill(-1); // per column: the LN being held, or -1
    const counts = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 };
    const errors = []; // real ms, heads only (late > 0)
    const total = list.reduce((s, n) => s + (n.end === null ? 1 : 2), 0);
    let judged = 0;
    let combo = 0;
    let maxCombo = 0;

    const realError = (pressChart, noteChart) => (pressChart - noteChart) / r;

    function record(events, kind, i, judgement, error = null) {
        counts[judgement] += 1;
        judged += 1;
        if (judgement === "miss") combo = 0;
        else maxCombo = Math.max(maxCombo, ++combo);
        events.push({ kind, index: i, col: list[i].col, judgement, error });
    }

    function judgeHead(events, i, judgement, error) {
        head[i] = judgement;
        if (error !== null && judgement !== "miss") errors.push(error);
        record(events, "head", i, judgement, error);
        if (list[i].end !== null && judgement === "miss") {
            broken[i] = true;
            tail[i] = "miss";
            record(events, "tail", i, "miss");
        }
    }

    function judgeTail(events, i, judgement, error = null) {
        tail[i] = judgement;
        if (judgement === "miss") broken[i] = true;
        record(events, "tail", i, judgement, error);
    }

    // Misses for heads that passed their 50 window, 50s for LNs still held past their tail's 50 window.
    function update(chartMs, events = []) {
        for (let c = 0; c < keys; c += 1) {
            const col = byCol[c];
            while (next[c] < col.length) {
                const i = col[next[c]];
                if (realError(chartMs, list[i].t) <= w.n50) break;
                next[c] += 1;
                judgeHead(events, i, "miss", null);
            }
            const h = holding[c];
            if (h >= 0 && realError(chartMs, list[h].end) > wt.n50) {
                holding[c] = -1;
                judgeTail(events, h, "n50");
            }
        }
        return events;
    }

    function press(col, chartMs) {
        const events = update(chartMs);
        if (col < 0 || col >= keys || holding[col] >= 0) return events;
        const column = byCol[col];
        if (next[col] >= column.length) return events;
        const i = column[next[col]];
        const error = realError(chartMs, list[i].t);
        if (error < -w.miss) return events; // too early: ignored
        next[col] += 1;
        const judgement = judgementFor(error, w) ?? "miss";
        judgeHead(events, i, judgement, error);
        if (list[i].end !== null && judgement !== "miss") holding[col] = i;
        return events;
    }

    function release(col, chartMs) {
        const events = update(chartMs);
        if (col < 0 || col >= keys) return events;
        const i = holding[col];
        if (i < 0) return events;
        holding[col] = -1;
        const error = realError(chartMs, list[i].end);
        judgeTail(events, i, judgementFor(error, wt) ?? "miss", error);
        return events;
    }

    // End of play: every head left is a miss, every LN still held is judged as released now.
    function finish(chartMs) {
        const events = [];
        for (let c = 0; c < keys; c += 1) {
            if (holding[c] >= 0) events.push(...release(c, chartMs));
            while (next[c] < byCol[c].length) {
                const i = byCol[c][next[c]];
                next[c] += 1;
                judgeHead(events, i, "miss", null);
            }
        }
        return events;
    }

    function stats() {
        const acc = maniaAccuracy(counts);
        return { ...counts, combo, maxCombo, acc: acc === null ? null : Math.round(acc * 100) / 100, notes: total };
    }

    return {
        windows: w,
        tailWindows: wt,
        notes: list,
        head,
        tail,
        broken,
        holding,
        update,
        press,
        release,
        finish,
        stats,
        get judged() { return judged; },
        get total() { return total; },
        get done() { return judged >= total; },
        get combo() { return combo; },
        errors: () => errors.slice(),
        ur: () => unstableRate(errors),
        meanError: () => (errors.length ? errors.reduce((s, x) => s + x, 0) / errors.length : null),
        accuracy: () => maniaAccuracy(counts),
    };
}
