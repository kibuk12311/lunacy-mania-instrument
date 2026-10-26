// 4K row generators. A row is a sorted list of columns 0..3; hands are {0,1} and {2,3}.
import { pick } from "./rng.js";

export const PATTERN_NAMES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];

const COLS = [0, 1, 2, 3];
const hand = (c) => (c < 2 ? 0 : 1);
const sorted = (cols) => [...new Set(cols)].sort((a, b) => a - b);
const without = (pool, used) => pool.filter((c) => !used.includes(c));

function take(rng, pool, n, prefer = null) {
    const chosen = [];
    let left = [...pool];
    while (chosen.length < n && left.length) {
        const weights = left.map((c) => (prefer ? prefer(c, chosen) : 1));
        const c = pick(rng, left, weights);
        chosen.push(c);
        left = left.filter((x) => x !== c);
    }
    return chosen;
}

// Spread chords across hands: a second note on the other hand is twice as likely.
const otherHand = (c, chosen) => (chosen.length && chosen.every((x) => hand(x) === hand(c)) ? 0.5 : 1);

// Rolling stream: never the column of either of the last two rows (that would read as trills).
function stream(prev, prev2, rng) {
    const fresh = without(COLS, [...prev, ...prev2]);
    const pool = fresh.length ? fresh : without(COLS, prev);
    const weights = pool.map((c) => (prev.length && hand(c) !== hand(prev[0]) ? 2 : 1));
    return [pick(rng, pool, weights)];
}

// `level` is the density knob λ in [0, 2]; above 1 it adds chords instead of notes.
const extraChord = (level) => Math.min(0.7, Math.max(0, level - 0.8) * 0.6);

function jumpstream(prev, rng, level, index) {
    const pool = without(COLS, prev);
    const two = index % 2 === 0 || rng() < extraChord(level);
    return take(rng, pool, two ? 2 : 1, otherHand);
}

function handstream(prev, rng, level, index) {
    const pool = without(COLS, prev);
    const size = index % 2 === 0 ? 3 : (rng() < 0.3 + extraChord(level) ? 2 : 1);
    return take(rng, pool, Math.min(size, pool.length), otherHand);
}

function chordjack(prev, rng, level, history) {
    let size;
    if (level < 0.4) size = rng() < 0.6 ? 2 : 3;
    else if (level < 0.8) size = rng() < 0.35 ? 2 : 3;
    else size = rng() < 0.15 + extraChord(level) / 2 ? 4 : 3;
    if (!prev.length) return take(rng, COLS, size, otherHand);
    // Interlude/LeoBlack only call it a chordjack when at least two columns repeat, so usually keep two,
    // but never a column already held for 3 rows (that reads as a longjack).
    const held = (c) => history.length >= 3 && history.slice(-3).every((row) => row.includes(c));
    const keepable = prev.filter((c) => !held(c));
    const keep = take(rng, keepable, Math.min(keepable.length, rng() < 0.75 ? 2 : 1));
    const fresh = take(rng, without(COLS, prev), Math.max(0, size - keep.length), otherHand);
    const row = [...keep, ...fresh];
    return row.length >= 2 ? row : [...row, ...take(rng, without(COLS, row), 2 - row.length)];
}

// Mostly two-column jacks: single-column repeats are invisible to the Interlude pattern finder.
function jack(prev, rng) {
    const size = rng() < 0.75 ? 2 : 1;
    if (prev.length >= size && rng() < 0.7) return take(rng, prev, size);
    return take(rng, without(COLS, prev).length >= size ? without(COLS, prev) : COLS, size, otherHand);
}

function tech(prev, rng, level) {
    const size = level > 0.7 && rng() < 0.2 ? 3 : (rng() < 0.45 ? 2 : 1);
    const minijack = prev.length && rng() < 0.25 ? take(rng, prev, 1) : [];
    const pool = without(COLS, [...prev, ...minijack]);
    const rest = take(rng, pool.length ? pool : without(COLS, minijack), size - minijack.length, otherHand);
    return [...minijack, ...rest];
}

// `index` counts rows inside the current run of this pattern (used for alternating chord/single rows).
export function nextRow(pattern, prevRows, rng, level, index) {
    const prev = prevRows.at(-1) ?? [];
    const prev2 = prevRows.at(-2) ?? [];
    let row;
    switch (pattern) {
        case "Stream": row = stream(prev, prev2, rng); break;
        case "Jumpstream": row = jumpstream(prev, rng, level, index); break;
        case "Handstream": row = handstream(prev, rng, level, index); break;
        case "Chordjack": row = chordjack(prev, rng, level, prevRows); break;
        case "Jack": row = jack(prev, rng); break;
        default: row = tech(prev, rng, level); break;
    }
    return sorted(row.length ? row : [Math.floor(rng() * 4)]);
}
