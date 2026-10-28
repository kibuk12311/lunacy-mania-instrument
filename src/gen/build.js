// Grid + intensity + pattern plan + density knob → rows of notes.
import { mulberry32 } from "./rng.js";
import { nextRow } from "./patterns.js";
import { motifWeights } from "./flavours.js";
import { createGuard } from "./playability.js";

const RECENT_ROWS = 8;
const maskOf = (cols) => cols.reduce((m, c) => m | (1 << c), 0);
const colsOf = (m) => [0, 1, 2, 3].filter((c) => m & (1 << c));

// A flavoured row (flavours.js): a mask drawn by the motif's weights times the playability guard of its family with the
// flavour's limits (the rule path has no guard of its own, so this one sees every row once flavours are in play).
function flavourRow({ id, phrase }, family, recent, guard, at, rng) {
    const w = motifWeights(id, recent, phrase);
    let total = 0;
    const weights = new Float64Array(16);
    for (let m = 1; m < 16; m += 1) {
        weights[m] = w[m] * guard.weight(m, at, family, null, id);
        total += weights[m];
    }
    if (total <= 0) return guard.fallback(at, family, null, id);
    let r = rng() * total;
    for (let m = 1; m < 16; m += 1) {
        r -= weights[m];
        if (r < 0) return m;
    }
    return 15;
}

const TECH_TRIPLET_CHANCE = 0.35;

// How likely an off-beat slot is used at density λ: downbeats always, 1/8 soon, 1/16 last.
function subWeight(sub, lambda) {
    if (sub === 0) return 1;
    if (sub === 2) return 0.55 + 0.45 * lambda;
    return 0.25 + 0.75 * lambda;
}

// `energy` (0..1 per slot) is how loud the surrounding song part is: everything scales with it, so drops stay
// the densest and light parts stay lighter at every density, including the grid-filling half of λ.
// `flavour` (per slot { id, phrase } or null, assign.js assignFlavours) turns those slots' rows into the flavour's
// motif; without it the rows are exactly as before. `trills` (0.10.4, patterns.js stream): streams may continue a trill.
export function buildChart({ slots, intensity, assign, lambda, seed, bpm, energy = null, flavour = null, trills = false }) {
    const rowOpts = { trills };
    // Separate streams: the fill draws do not depend on λ, so a larger λ only ever adds rows.
    const fillRng = mulberry32(seed);
    const patternRng = mulberry32(seed ^ 0x9e3779b9);
    const techRng = mulberry32(seed ^ 0x85ebca6b);
    const beatMs = 60000 / bpm;
    const rows = [];
    const history = [];
    let runPattern = null;
    let runIndex = 0;
    const flavoured = Boolean(flavour?.some(Boolean));
    // the guard reads each row's time from its own list (triplet rows sit between the slots)
    const guardSlots = [];
    const guard = flavoured ? createGuard({ slots: guardSlots }) : null;
    const recent = [];

    const emit = (t, pattern, e, i) => {
        if (pattern !== runPattern) {
            runPattern = pattern;
            runIndex = 0;
        }
        const fl = flavoured ? flavour[i] : null;
        let cols;
        if (guard) {
            guardSlots.push({ t: Math.round(t), beatMs, bpm });
            const at = guardSlots.length - 1;
            cols = fl ? colsOf(flavourRow(fl, pattern, recent, guard, at, patternRng)) : nextRow(pattern, history, patternRng, lambda * (0.4 + 0.6 * e), runIndex, rowOpts);
            if (!cols.length) return;
            guard.push(maskOf(cols), at);
            recent.unshift(maskOf(cols));
            if (recent.length > RECENT_ROWS) recent.pop();
        } else {
            cols = nextRow(pattern, history, patternRng, lambda * (0.4 + 0.6 * e), runIndex, rowOpts);
        }
        runIndex += 1;
        history.push(cols);
        if (history.length > 4) history.shift();
        rows.push({ t: Math.round(t), cols, ...(fl ? { flavour: fl.id } : {}) });
    };

    for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        const pattern = assign[i];
        const u = fillRng();
        if (intensity[i] <= 0) continue;
        const e = energy ? energy[i] : 1;
        // λ in [0, 1] follows the music; λ in (1, 2] also fills the grid inside non-silent phrases.
        const follow = Math.min(1, intensity[i] * e * (0.2 + 2 * Math.min(1, lambda))) * subWeight(slot.sub, Math.min(1, lambda) * e);
        const p = follow + (1 - follow) * Math.max(0, lambda - 1) * e ** 2;

        // Tech beats sometimes switch to triplets: 3 evenly spaced notes instead of the 1/4 slots.
        if (pattern === "Tech" && slot.sub === 0 && techRng() < TECH_TRIPLET_CHANCE) {
            for (let k = 0; k < 3; k += 1) {
                if (k === 0 ? u < p : fillRng() < p * subWeight(1, lambda)) emit(slot.t + (k * beatMs) / 3, pattern, e, i);
            }
            i += 3;
            continue;
        }
        if (u < p) emit(slot.t, pattern, e, i);
    }
    return rows;
}
