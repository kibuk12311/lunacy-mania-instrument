// osu!mania judgements recomputed from a replay's key presses, the way osu! stable makes them. The rules were read off
// real replays against the per-hit log stable keeps beside them (Data\r\*.osg) and checked against the replays' own
// counts: over 2 100 replays the rice maps come out exact but for a handful of notes in a million.
//   Windows (real time, so DT / HT do not change them; in the map's ms they are × rate): MAX 16, 300: 64 − 3·OD,
//   200: 97 − 3·OD, 100: 127 − 3·OD, 50: 151 − 3·OD, early miss: 188 − 3·OD; EZ × 1.4, HR ÷ 1.4; floored last.
//   A press goes to the oldest note of its column not judged yet. Sooner than the early-miss window it does nothing, and
//   it does nothing while the note before that one is still ahead of the song. Past the 50 window but inside the
//   early-miss one it is a miss of that note. Late, a note can be hit only up to its 100 window: when the song gets
//   there it is a miss, so a late press is at worst a 100, and a 50 is always early.
//   A hold is one judgement, made at its end from head + tail (holdKind). Let go more than a 50 window before the end
//   it is a miss, or at best a 200 when it is pressed again and let go at the end. A head missed but pressed during the
//   body and let go at the end is a 50. ScoreV2 judges a hold twice: not modelled (see analyze.js).
//   Holds are the approximate part, and how far off grows with how many a map has: of 1 444 full plays of maps with any
//   holds 1 084 come out exact, but of 51 on maps with 20 % holds or more only 3 do, up to 2.7 % of the notes differ and
//   osu! has up to 30 misses more than the recount. So per-finger misses, combo breaks and hold figures are near, not exact,
//   on such a map; the tab shows the difference beside the replay's own counts.
//   A hold written to end before it starts (a trick of joke maps, one real map stacks 14 889 of them) takes no key: osu! gives
//   it a 300 at once. Those notes are `given`: counted, but no press, no place in the results. Ordinary notes stacked on
//   one time are judged one by one like any others, the real replays of such maps match.
//   Past the last frame nothing is judged, but osu! still counts what a failed play left there as misses: a limit above what
//   was judged takes that many of them, oldest first.
// Times of notes and presses are ms of the map; delta is ms of real time (map ms ÷ rate). Pure.
import { accuracyOf } from "../localProfile/model.js";

export const KINDS = ["max", "n300", "n200", "n100", "n50", "miss"];
const BASE = { max: 16, n300: 64, n200: 97, n100: 127, n50: 151, miss: 188 };
const OD_STEP = 3;
const HR_EZ = 1.4;

// Windows in ms of the map for an OD: { max, n300, n200, n100, n50, miss }.
export function hitWindows(od, modNames = [], rate = 1) {
    const k = modNames.includes("HR") ? 1 / HR_EZ : modNames.includes("EZ") ? HR_EZ : 1;
    const out = {};
    for (const [name, base] of Object.entries(BASE)) out[name] = Math.floor((name === "max" ? base : base - OD_STEP * od) * k * rate);
    return out;
}

const kindOf = (d, w) => {
    const a = Math.abs(d);
    return a <= w.max ? "max" : a <= w.n300 ? "n300" : a <= w.n200 ? "n200" : a <= w.n100 ? "n100" : "n50";
};

// A hold's judgement from how far its head and tail were from their marks.
export function holdKind(head, tail, w) {
    const a = Math.abs(head);
    const sum = a + Math.abs(tail);
    if (a <= w.max * 1.2 && sum <= w.max * 2.4) return "max";
    if (a <= w.n300 * 1.1 && sum <= w.n300 * 2.2) return "n300";
    if (a <= w.n200 && sum <= w.n200 * 2) return "n200";
    if (a <= w.n100 && sum <= w.n100 * 2) return "n100";
    return "n50";
}

// The column a note is played in: Mirror turns the map over, a replay's keys are the columns on screen.
export const playedColumn = (col, modNames, keys = 4) => (modNames.includes("MR") ? keys - 1 - col : col);

// notes: [{ t, col, end }] of the .osu (end null for a tap), sorted by t; columns: keyPresses() of the replay.
// lastMs: the last frame's time; limit: how many judgements the replay's header says were made (a failed or quit play
// stops there, or says how many misses came after the last frame), null for all. → { windows, results, strays, given }.
// results: one per note reached, sorted by the note's time: { t, col (as played), end, kind, at (when judged), press (the
// head's press or null), up (a hold's release, ms of the map, null when none was seen), delta (real ms, press − note,
// null without a press), early (an early miss) }.
// strays: presses that met no note [{ t, col }]. given: how many reversed holds were reached (each one a 300, see above).
export function judgeReplay(notes, columns, { od, modNames = [], rate = 1, keys = 4, lastMs = Infinity, limit = null } = {}) {
    const w = hitWindows(od, modNames, rate);
    const lists = Array.from({ length: keys }, () => []);
    let given = 0;
    for (const n of notes) {
        if (!n.reversed) lists[playedColumn(n.col, modNames, keys)].push(n);
        else if (n.t <= lastMs) given += 1;
    }
    const all = [];
    const strays = [];
    const beyond = []; // the misses past the last frame: { at, write }, written only when the limit asks for them
    for (let c = 0; c < keys; c += 1) {
        const list = lists[c];
        const presses = columns[c] ?? [];
        const add = (n, kind, at, press = null, delta = null, early = false, up = null) => all.push({ t: n.t, col: c, end: n.end, kind, at, press, delta, early, up: up === Infinity ? null : up });
        const lateMiss = (n) => {
            const at = n.t + w.n100;
            if (at <= lastMs) add(n, "miss", at);
            else beyond.push({ at, write: () => add(n, "miss", at) });
        };
        // a hold whose head was missed but pressed during its body: only a release at its end saves a 50
        const grab = (n, press) => {
            const up = press.up ?? Infinity;
            add(n, Math.abs(up - n.end) <= w.n50 ? "n50" : "miss", up === Infinity ? n.end : Math.max(up, n.end), press.t, null, false, up);
        };
        let i = 0;
        for (let pi = 0; pi < presses.length; pi += 1) {
            const p = presses[pi];
            let grabbed = false;
            while (i < list.length && list[i].t + w.n100 <= p.t && !grabbed) {
                const n = list[i];
                i += 1;
                if (n.end !== null && p.t < n.end) {
                    grab(n, p);
                    grabbed = true;
                } else lateMiss(n);
            }
            if (grabbed) continue;
            if (i >= list.length) {
                strays.push({ t: p.t, col: c });
                continue;
            }
            const n = list[i];
            const d = p.t - n.t;
            if (d < -w.miss || (i > 0 && p.t < list[i - 1].t)) {
                strays.push({ t: p.t, col: c });
                continue;
            }
            i += 1;
            if (d < -w.n50) {
                add(n, "miss", p.t, null, null, true);
                continue;
            }
            const delta = d / rate;
            if (n.end === null) {
                add(n, kindOf(d, w), p.t, p.t, delta);
                continue;
            }
            const up = p.up ?? Infinity;
            if (up < n.end - w.n50) {
                const again = presses[pi + 1];
                if (again && again.t < n.end + w.n100) {
                    const second = again.up ?? Infinity;
                    if (Math.abs(second - n.end) <= w.n50) {
                        const kind = holdKind(d, second - n.end, w);
                        add(n, kind === "max" || kind === "n300" ? "n200" : kind, Math.max(second, n.end), again.t, delta, false, second);
                    } else add(n, "miss", n.end + w.n100, again.t, delta, false, second);
                    pi += 1;
                } else add(n, "miss", n.end + w.n100, p.t, delta, false, up);
                continue;
            }
            const tail = up >= n.end + w.n100 ? w.n50 : up - n.end;
            add(n, holdKind(d, tail, w), n.end + tail, p.t, delta, false, up);
        }
        while (i < list.length) {
            lateMiss(list[i]);
            i += 1;
        }
    }
    const wanted = limit === null ? null : Math.max(0, limit - given);
    if (wanted !== null) for (const miss of beyond.sort((a, b) => a.at - b.at).slice(0, Math.max(0, wanted - all.length))) miss.write();
    let results = all;
    if (wanted !== null && wanted < all.length) results = [...all].sort((a, b) => a.at - b.at).slice(0, wanted);
    results.sort((a, b) => a.t - b.t || a.col - b.col);
    return { windows: w, results, strays, given };
}

// The judgements' counts: { max, n300, n200, n100, n50, miss }.
export function countKinds(results) {
    const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const r of results) counts[r.kind] += 1;
    return counts;
}

// Combo through the play, in the order notes were judged: { maxCombo, breaks: [{ t, col, combo }] } (the miss that broke
// a combo of that length). Holds count one here; osu! also counts their ticks, so a map with holds shows a higher
// combo in osu! than here.
export function comboOf(results) {
    let combo = 0;
    let maxCombo = 0;
    const breaks = [];
    for (const r of [...results].sort((a, b) => a.at - b.at)) {
        if (r.kind === "miss") {
            if (combo > 0) breaks.push({ t: r.t, col: r.col, combo });
            combo = 0;
        } else {
            combo += 1;
            maxCombo = Math.max(maxCombo, combo);
        }
    }
    return { maxCombo, breaks };
}

// Accuracy in percent as osu! shows it (MAX counts as a 300), null with no judgements.
export const accuracyPercent = (counts) => accuracyOf(counts);
