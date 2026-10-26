// Which pattern each grid slot uses: whole 8-beat sections ("sections") or a weighted pick per beat ("mixed").
import { pick } from "./rng.js";

const SLOTS_PER_SECTION = 32;
const SLOTS_PER_BEAT = 4;

function largestRemainder(total, patterns) {
    const sum = patterns.reduce((s, p) => s + p.share, 0) || 1;
    const exact = patterns.map((p) => (p.share / sum) * total);
    const counts = exact.map(Math.floor);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < total - counts.reduce((a, b) => a + b, 0); k += 1) counts[order[k % order.length][1]] += 1;
    return counts;
}

export function assignPatterns(slotCount, patterns, mode, rng) {
    const out = new Array(slotCount);
    if (mode === "mixed") {
        const names = patterns.map((p) => p.name);
        const weights = patterns.map((p) => p.share);
        for (let b = 0; b * SLOTS_PER_BEAT < slotCount; b += 1) {
            const name = pick(rng, names, weights);
            for (let i = b * SLOTS_PER_BEAT; i < Math.min(slotCount, (b + 1) * SLOTS_PER_BEAT); i += 1) out[i] = name;
        }
        return out;
    }

    const sections = Math.max(1, Math.ceil(slotCount / SLOTS_PER_SECTION));
    const counts = largestRemainder(sections, patterns);
    // Runs of 2–4 sections per pattern, shuffled, so the map changes character every few phrases.
    const runs = [];
    patterns.forEach((p, i) => {
        let left = counts[i];
        while (left > 0) {
            const len = Math.min(left, 2 + Math.floor(rng() * 3));
            runs.push({ name: p.name, len });
            left -= len;
        }
    });
    for (let i = runs.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [runs[i], runs[j]] = [runs[j], runs[i]];
    }
    let slot = 0;
    for (const run of runs) {
        for (let k = 0; k < run.len * SLOTS_PER_SECTION && slot < slotCount; k += 1) out[slot++] = run.name;
    }
    while (slot < slotCount) out[slot++] = runs.at(-1)?.name ?? patterns[0].name;
    return out;
}

// Patterns per slot, part by part (mapgen v3): every part runs assignPatterns on its own beats with its own patterns
// (or `defaults`), so pattern sections start at part starts; an empty part gets null. Sections are counted in beats,
// so a triplet beat (3 slots) still counts as one beat of its 8-beat section.
export function assignByParts(slots, parts, defaults, mode, rng) {
    const out = new Array(slots.length).fill(null);
    let i = 0;
    parts.forEach((part, p) => {
        const from = i;
        while (i < slots.length && (p + 1 >= parts.length || slots[i].t < parts[p + 1].startMs)) i += 1;
        if (part.empty || i === from) return;
        const firstBeat = slots[from].beat;
        const beats = slots[i - 1].beat - firstBeat + 1;
        const plan = assignPatterns(beats * SLOTS_PER_BEAT, part.patterns ?? defaults, mode, rng);
        for (let k = from; k < i; k += 1) out[k] = plan[(slots[k].beat - firstBeat) * SLOTS_PER_BEAT + slots[k].sub];
    });
    return out;
}

const PHRASE_BARS = 8;
const LONG_PART_BARS = 16;
const MIXED_PHRASE_BARS = [4, 8];

// The flavour (sub-pattern) of every slot, or null: a pattern's `flavours` (a part's own patterns, or `defaults`)
// say which flavours its family uses; a slot whose family has none gets null. Phrases are counted in bars of `meter`
// beats from the part's first beat.
// - "sections": a family's flavours take turns from part to part (parts next to each other differ), and a part
//   longer than 16 bars moves on to the next one every 8 bars;
// - "mixed": every 4–8 bars (a random length per phrase) each family moves on to another of its flavours, never the
//   same one twice in a row.
// → array of { id, phrase } | null, one object per phrase; `phrase` counts the family's phrases (flavours.js uses it
// to rotate an anchor column, a trill pair, a slide direction). `rng` is a stream of its own, so the families'
// plan (assignByParts) never changes because of flavours.
export function assignFlavours(slots, parts, assign, defaults, mode, rng, { meter = 4 } = {}) {
    const out = new Array(slots.length).fill(null);
    const turn = new Map(); // family → index of its next flavour (sections: carried from part to part)
    const count = new Map(); // family → phrases so far
    const last = new Map(); // family → its flavour of the phrase before (mixed)
    let i = 0;
    parts.forEach((part, p) => {
        const from = i;
        while (i < slots.length && (p + 1 >= parts.length || slots[i].t < parts[p + 1].startMs)) i += 1;
        if (part.empty || i === from) return;
        const lists = new Map((part.patterns ?? defaults).filter((x) => x.flavours?.length).map((x) => [x.name, x.flavours]));
        if (!lists.size) return;
        const firstBeat = slots[from].beat;
        const bars = Math.floor((slots[i - 1].beat - firstBeat) / meter) + 1;
        // phrase starts in bars from the part's start
        const starts = [0];
        if (mode === "mixed") {
            for (let b = 0; b < bars;) {
                b += MIXED_PHRASE_BARS[0] + Math.floor(rng() * (MIXED_PHRASE_BARS[1] - MIXED_PHRASE_BARS[0] + 1));
                if (b < bars) starts.push(b);
            }
        } else if (bars > LONG_PART_BARS) {
            for (let b = PHRASE_BARS; b < bars; b += PHRASE_BARS) starts.push(b);
        }
        const phraseOf = (k) => {
            const bar = Math.floor((slots[k].beat - firstBeat) / meter);
            let j = 0;
            while (j + 1 < starts.length && starts[j + 1] <= bar) j += 1;
            return j;
        };
        const plan = new Map(); // `${family}:${phrase}` → { id, phrase }
        const flavourFor = (family, j) => {
            const key = `${family}:${j}`;
            if (plan.has(key)) return plan.get(key);
            const list = lists.get(family);
            let id;
            if (mode === "mixed") {
                const others = list.length > 1 ? list.filter((x) => x !== last.get(family)) : list;
                id = others[Math.floor(rng() * others.length)];
                last.set(family, id);
            } else {
                if (!turn.has(family)) turn.set(family, Math.floor(rng() * list.length));
                id = list[turn.get(family) % list.length];
                turn.set(family, turn.get(family) + 1);
            }
            const n = count.get(family) ?? 0;
            count.set(family, n + 1);
            const entry = { id, phrase: n };
            plan.set(key, entry);
            return entry;
        };
        for (let k = from; k < i; k += 1) {
            const family = assign[k];
            if (family && lists.has(family)) out[k] = flavourFor(family, phraseOf(k));
        }
    });
    return out;
}
