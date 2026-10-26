// Echo rows (ML addendum §2.3, stream G2): with request.repeats and a song structure (src/gen/structure.js), a bar
// that repeats an earlier bar (structure.echoOf) copies that bar's rows of the same build onto the same beat and
// position, so repeated sections get consistent patterns. Then a variation pass re-samples whole bars through the
// source: always the last bar of each 8-bar phrase (the fill bar), each other echoed bar with probability pVar; and
// per phrase, with probability pMirror, the copies are mirrored (column c → 3 − c) for the whole phrase so the hands
// stay consistent. The variation RNG of bar b is deriveSeed(seed, 0xEC40, b), seed = the build's note seed.
// - A beat on a grid its source beat does not have, a slot whose family differs from its source's, and a source that
//   this build has not decided (another part not drawn, an empty part) are re-sampled as usual.
// - Copied rows go through the guard (echoCopy): a vetoed copy is re-sampled, never kept.
// - With an infill source (caps.infill) the copies are passed per build as step(i, …, fixed), never as `known`, at a
//   strength of 0.6: 40% of the echo slots are dropped back to free (deriveSeed(seed, 0xEC41, b)), so the model makes
//   the small variations itself.
//
//   createEcho({ structure, slots, assign, options? }) → { echoSlot, barOf, forBuild(seed, { infill }) → run }
//   run.copyAt(i, decided) → the copy for slot i (0 = no row, 1..15 a row), or null to sample; decided: per slot the
//     build's mask so far (UNDECIDED = not decided in this build). run.plan = echoPlan(structure, seed); run.stats.
import { mulberry32, deriveSeed } from "./rng.js";
import { barsOf } from "./songParts.js";

export const ECHO_DEFAULTS = Object.freeze({ pVar: 0.25, pMirror: 0.15, strength: 0.6, fillPhraseBars: 8 });
export const SEED_VARY = 0xec40;
export const SEED_DROP = 0xec41;
export const UNDECIDED = 255;
const MIRROR = Uint8Array.from({ length: 16 }, (_, m) => ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3));

// The structure's bars as slot ranges: barsOf(slots, meter) (the bars songStructure cut from the same slots); when the
// count differs from structure.bars, each structure bar starts at the first slot at or after its startMs.
export function structureBars(structure, slots) {
    const cut = barsOf(slots, structure.meter ?? 4);
    const given = structure.bars ?? [];
    let bars = cut;
    if (given.length && given.length !== cut.length) {
        let i = 0;
        bars = given.map((bar) => {
            while (i < slots.length && slots[i].t < bar.startMs - 0.5) i += 1;
            return { i0: i };
        });
        bars.forEach((b, k) => { b.i1 = k + 1 < bars.length ? bars[k + 1].i0 : slots.length; });
    }
    const barOf = new Int32Array(slots.length).fill(-1);
    bars.forEach((b, k) => barOf.fill(k, b.i0, b.i1));
    return { bars, barOf };
}

// Per bar: its beats as [{ div, slots: [slot index by position] }] in order.
function beatsOfBar(slots, bar) {
    const out = [];
    for (let i = bar.i0; i < bar.i1; i += 1) {
        const s = slots[i];
        const p = slots[i - 1];
        if (i === bar.i0 || s.beat !== p.beat || (s.pos ?? s.sub) <= (p.pos ?? p.sub)) out.push({ div: s.div ?? 4, slots: [] });
        out.at(-1).slots[s.pos ?? s.sub] = i;
    }
    return out;
}

// Per slot: the slot of its echo source bar at the same beat of the bar and the same position, when that beat has the
// same grid; −1 otherwise (no echo, another grid, or a beat the source bar does not have).
export function echoSlots(structure, slots) {
    const out = new Int32Array(slots.length).fill(-1);
    const echoOf = structure?.echoOf;
    if (!echoOf?.length || !slots.length) return out;
    const { bars } = structureBars(structure, slots);
    const beats = bars.map((b) => beatsOfBar(slots, b));
    for (let b = 0; b < bars.length && b < echoOf.length; b += 1) {
        const e = echoOf[b];
        if (!(e >= 0) || e >= b) continue;
        beats[b].forEach((beat, k) => {
            const src = beats[e][k];
            if (!src || src.div !== beat.div) return;
            beat.slots.forEach((i, pos) => {
                if (i !== undefined && src.slots[pos] !== undefined) out[i] = src.slots[pos];
            });
        });
    }
    return out;
}

// 1 at the first slot of every phrase of the structure.
export function phraseStarts(structure, slots) {
    const out = new Uint8Array(slots.length);
    if (!structure?.phrases?.length || !slots.length) return out;
    const { bars } = structureBars(structure, slots);
    for (const p of structure.phrases) {
        const bar = bars[p.bar];
        if (bar && bar.i0 < slots.length) out[bar.i0] = 1;
    }
    return out;
}

// Which echoed bars of one build are varied (re-sampled) and mirrored. → { varied, mirrored, fill: Uint8Array(bars) }
export function echoPlan(structure, seed, options = {}) {
    const { pVar, pMirror, fillPhraseBars } = { ...ECHO_DEFAULTS, ...options };
    const n = structure?.echoOf?.length ?? 0;
    const varied = new Uint8Array(n);
    const mirrored = new Uint8Array(n);
    const fill = new Uint8Array(n);
    const phrases = structure?.phrases ?? [];
    const phraseOf = structure?.phraseOf;
    const draws = (b) => mulberry32(deriveSeed(seed, SEED_VARY, b));
    for (let b = 0; b < n; b += 1) {
        if (!(structure.echoOf[b] >= 0)) continue;
        const p = phraseOf ? phrases[phraseOf[b]] : null;
        fill[b] = p && p.bars === fillPhraseBars && b === p.bar + p.bars - 1 ? 1 : 0;
        const u = draws(b)();
        varied[b] = fill[b] || u < pVar ? 1 : 0;
    }
    for (const p of phrases) {
        const rng = draws(p.bar);
        rng(); // the phrase's first bar's variation draw
        if (rng() < pMirror) mirrored.fill(1, p.bar, Math.min(n, p.bar + p.bars));
    }
    return { varied, mirrored, fill };
}

// A copy against the guard: null = no copy (sample); 0 = no row (needs no guard); a vetoed row is re-sampled.
// → { mask, echoed, vetoed }
export function echoCopy(copy, weightOf, sample) {
    if (copy === null || copy === undefined) return { mask: sample(), echoed: false, vetoed: false };
    if (copy === 0 || !weightOf || weightOf(copy) > 0) return { mask: copy, echoed: true, vetoed: false };
    return { mask: sample(), echoed: false, vetoed: true };
}

export function createEcho({ structure, slots, assign = null, options = {} }) {
    const opts = { ...ECHO_DEFAULTS, ...options };
    const echoSlot = echoSlots(structure, slots);
    const { barOf } = structureBars(structure, slots);
    return {
        echoSlot,
        barOf,
        forBuild(seed, { infill = false } = {}) {
            const plan = echoPlan(structure, seed, opts);
            const drops = new Map(); // bar → its drop RNG (infill)
            const stats = { copied: 0, vetoed: 0, dropped: 0 };
            return {
                plan,
                stats,
                copyAt(i, decided) {
                    const j = echoSlot[i];
                    if (j < 0) return null;
                    const b = barOf[i];
                    if (b < 0 || plan.varied[b]) return null;
                    if (decided[j] === UNDECIDED) return null;
                    if (assign && assign[i] !== assign[j]) return null;
                    const m = plan.mirrored[b] ? MIRROR[decided[j] & 15] : decided[j] & 15;
                    if (infill) {
                        if (!drops.has(b)) drops.set(b, mulberry32(deriveSeed(seed, SEED_DROP, b)));
                        if (drops.get(b)() >= opts.strength) {
                            stats.dropped += 1;
                            return null;
                        }
                    }
                    return m;
                },
            };
        },
    };
}
