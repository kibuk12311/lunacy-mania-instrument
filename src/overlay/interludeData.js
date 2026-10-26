// interlude-reader's state lines (native/interlude-reader/README.md, protocol v1) → what the overlay session takes,
// the same shape as tosuData.js's readPlayFrame() plus what only Interlude gives: its own per-note events (column,
// hit delta, judgement), the columns held down, a play id that goes up on every new play or retry, and the active
// ruleset's judgement names and accuracy.
// Times: timeMs is chart time (0 at the first note, in song ms, so it runs `rate` times faster than the wall clock);
// an event's `t` is the note's chart time on the same clock and `d` its hit delta in real ms (Interlude divides by rate).
// Judgements: a ruleset with six (SC, Wife3, osu!mania: MARVELLOUS/MAX … MISS) fills the six slots of the widget in
// order, under the ruleset's own (short) names; any other count is shown as the ruleset's own rows, and the six
// slots get the first ones in order with the last as the miss.

const PLAY_SCREENS = new Set(["play", "practice", "replay"]);
const SLOTS = ["max", "n300", "n200", "n100", "n50", "miss"];
const SHORT = { MARVELLOUS: "MARV", MARVELOUS: "MARV", PERFECT: "PERF", EXCELLENT: "EXC", FANTASTIC: "FANT" };
export const PRESS_KINDS = new Set(["hit", "hold", "regrabhold", "ghosttap"]); // a key went down
export const RELEASE_KINDS = new Set(["release", "drophold"]); // a held key came up

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const count = (x) => Math.max(0, Math.trunc(num(x) ?? 0));

// A judgement's name as a short label for a widget row: MARVELLOUS → MARV, anything up to 6 letters as it is.
export function shortJudgement(name) {
    const s = String(name ?? "").trim();
    const up = s.toUpperCase();
    if (SHORT[up]) return SHORT[up];
    return s.length <= 6 ? s : `${s.slice(0, 5)}.`;
}

// The ruleset's judgement names and counts (play.hits: { name: count } in ruleset order, or play.judgements) →
// { names, counts, mapped, labels (6, when mapped), hits (the six slots) }.
export function mapJudgements(play) {
    const hitsObj = play?.hits && typeof play.hits === "object" ? play.hits : null;
    let names = hitsObj ? Object.keys(hitsObj) : [];
    let counts = hitsObj ? names.map((n) => count(hitsObj[n])) : [];
    if (!names.length && Array.isArray(play?.judgements)) {
        counts = play.judgements.map(count);
        names = counts.map((_, i) => `J${i + 1}`);
    }
    const hits = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 };
    const mapped = counts.length === SLOTS.length;
    if (mapped) {
        SLOTS.forEach((slot, i) => { hits[slot] = counts[i]; });
    } else if (counts.length) {
        // the last judgement is the miss; the others fill the slots in order, any past the fifth go in with the 50s
        const last = counts.length - 1;
        counts.forEach((c, i) => {
            if (i === last && last > 0) hits.miss += c;
            else hits[SLOTS[Math.min(i, 4)]] += c;
        });
    }
    return { names, counts, mapped, labels: mapped ? names.map(shortJudgement) : null, hits };
}

// One event as the reader prints it → { t, col, kind, delta, judgement, missed }, or null.
export function readEvent(e) {
    const t = num(e?.t);
    const col = num(e?.c);
    if (t === null || col === null || col < 0) return null;
    return {
        t, col: Math.trunc(col), kind: typeof e.k === "string" ? e.k : "hit", delta: num(e.d),
        judgement: num(e.j), missed: e.m === true, index: num(e.i),
    };
}

// When the play has its presses at map (chart) time: a press is the note's time plus its delta in chart ms.
export const pressTime = (event, rate = 1) => event.t + (event.delta !== null && !event.missed ? event.delta * (rate > 0 ? rate : 1) : 0);

// A state line ({ client: "interlude", screen, chart, play }) → a session frame.
export function readInterludeFrame(msg) {
    const screen = typeof msg?.screen === "string" ? msg.screen : "unknown";
    const play = msg?.play && typeof msg.play === "object" ? msg.play : null;
    const chart = msg?.chart && typeof msg.chart === "object" ? msg.chart : null;
    const state = play && PLAY_SCREENS.has(screen) ? "playing"
        : screen === "score" ? "results"
            : screen === "levelselect" ? "songselect"
                : screen === "mainmenu" ? "menu" : "other";
    const rate = num(play?.rate) ?? num(chart?.rate) ?? 1;
    const judged = play ? mapJudgements(play) : null;
    const accuracy = num(play?.accuracy);
    return {
        state,
        client: "interlude",
        mode: 3,
        checksum: typeof chart?.hash === "string" && chart.hash ? `interlude:${chart.hash}` : null,
        hash: typeof chart?.hash === "string" && chart.hash ? chart.hash : null,
        keys: num(chart?.keys),
        rate: rate > 0 ? rate : 1,
        liveMs: num(play?.timeMs),
        paused: play?.paused === true,
        playId: num(play?.playId),
        // no play on the score screen: the session keeps the numbers of the play that led there (null = none here)
        hits: judged ? judged.hits : null,
        accuracy: accuracy === null ? null : accuracy * 100,
        ur: null,
        hitErrors: [],
        events: play ? (Array.isArray(play.events) ? play.events.map(readEvent).filter(Boolean) : []) : null,
        keysDown: Array.isArray(play?.keysDown) ? play.keysDown.filter((c) => Number.isInteger(c) && c >= 0) : null,
        judgeNames: judged && judged.names.length
            ? { ruleset: typeof play.ruleset === "string" ? play.ruleset : "", names: judged.names, counts: judged.counts, mapped: judged.mapped, labels: judged.labels }
            : null,
    };
}

// A chart's notes (parseManiaNotes() of its .osu) on the reader's clock: 0 at the first note, as timeMs and the
// events' `t` are (Interlude counts chart time from the first note).
export function chartTimeNotes(parsed) {
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
    if (!notes.length) return { keys: parsed?.keys ?? 4, notes: [] };
    const first = notes[0].t;
    return {
        keys: parsed.keys,
        notes: notes.map((n) => ({ t: n.t - first, col: n.col, end: n.end === null || n.end === undefined ? null : n.end - first })),
    };
}
