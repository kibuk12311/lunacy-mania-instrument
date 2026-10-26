// Row sources: the one seam between the generator and a mapper model. A source is
//   prepare({ model, audio, slots, dan, family, flavour }) → { step(i, offset, ctx, rngs, weightOf) → mask, noteRaw }
// with audio = { envelope, names, rows } (the model's own feature columns per slot, slotFeatures order),
// dan[i] the requested dan, family[i] the pattern family per slot and flavour[i] its sub-pattern ({ id, phrase } or
// null; flavours.js): the row's columns lean towards the flavour's motif, the note decisions stay the model's.
// step decides slot i: 0 = no row, else the columns. offset shifts the note log-odds (the density knob plus the contrast term); ctx = { prev, prev2, recent }
// (recent: the last rows, newest first, { mask, gapMs }); rngs = { fill, size, pattern } (the block's streams);
// weightOf(mask) is the playability guard (0 = not allowed) and weightOf.fallback() its pick when it allows none.
// Today: XGBoost note/size models plus the pattern Markov tables (xgbMarkovSource); "nn-v1" models bring their own
// (src/gen/nnModel.js).
import { treeRaw, sizeProbabilities, sampleRow, familySizeRates } from "./learnedModel.js";
import { motifWeights } from "./flavours.js";
import { slotFeatures, AUDIO_FEATURES } from "./slotFeatures.js";

const SIZE_HINT = 0.5; // how much the size model's "a chord fits here" bends the family's own row sizes …
const HINT_LIMIT = 1.5; // … at most ×1.5 or ÷1.5, so the chosen pattern always decides
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export async function sourceFor(model) {
    if (model?.kind === "nn-v1") return (await import("./nnModel.js")).neuralSource;
    return xgbMarkovSource;
}

// The model's inputs for a slot: its feature columns, then the conditioning (dan, one-hot family).
function inputs(model, names, rows, dan, family) {
    const F = names.length;
    const families = model.families ?? [];
    const x = new Array(F + 1 + families.length);
    return (i, featureRows = rows, slotDan = dan[i], slotFamily = family[i]) => {
        for (let j = 0; j < F; j += 1) x[j] = featureRows[i * F + j];
        x[F] = slotDan;
        for (let k = 0; k < families.length; k += 1) x[F + 1 + k] = families[k] === slotFamily ? 1 : 0;
        return x;
    };
}

// A 1/4 grid over the same beats (for models trained on 1/4 only): the 4 quarter slots of every beat.
function quarterSlots(slots) {
    const out = [];
    const firstOf = new Map(); // beat → index of its first quarter slot in out
    let beat = null;
    for (const s of slots) {
        if (s.beat === beat) continue;
        beat = s.beat;
        const beatMs = s.beatMs ?? 60000 / s.bpm;
        const start = s.t - ((s.pos ?? s.sub) * beatMs) / (s.div ?? 4);
        firstOf.set(beat, out.length);
        for (let k = 0; k < 4; k += 1) out.push({ t: Math.round(start + (k * beatMs) / 4), beat, sub: k, div: 4, pos: k, bpm: s.bpm, beatMs });
    }
    return { quarters: out, firstOf };
}

// For a model that only knows 1/4: on a beat with another grid, shift its slots' log-odds so the expected number
// of rows in the beat is what the model expects of the beat's four 1/4 slots.
function rescaleToQuarters({ model, audio, slots, dan, family, noteRaw }) {
    if (slots.every((s) => (s.div ?? 4) === 4)) return;
    const names = audio.names;
    const { quarters, firstOf } = quarterSlots(slots);
    const { rows } = slotFeatures(audio.envelope, quarters, slots[0]?.bpm, names);
    const x = inputs(model, names, rows, dan, family);
    for (let i = 0; i < slots.length;) {
        let j = i;
        while (j < slots.length && slots[j].beat === slots[i].beat) j += 1;
        if ((slots[i].div ?? 4) !== 4) {
            const q = firstOf.get(slots[i].beat);
            let want = 0;
            for (let k = 0; k < 4; k += 1) want += sigmoid(treeRaw(model.note, x(q + k, rows, dan[i], family[i]))[0]);
            let lo = -20;
            let hi = 20;
            for (let it = 0; it < 40; it += 1) {
                const c = (lo + hi) / 2;
                let got = 0;
                for (let k = i; k < j; k += 1) got += sigmoid(noteRaw[k] + c);
                if (got < want) lo = c;
                else hi = c;
            }
            const c = (lo + hi) / 2;
            for (let k = i; k < j; k += 1) noteRaw[k] += c;
        }
        i = j;
    }
}

export const xgbMarkovSource = {
    kind: "xgb",
    prepare({ model, audio, slots, dan, family, flavour = null }) {
        const names = model.features ?? AUDIO_FEATURES;
        const own = audio.names && audio.names.length === names.length && audio.names.every((n, k) => n === names[k]);
        const rows = own ? audio.rows : slotFeatures(audio.envelope, slots, slots[0]?.bpm, names).rows;
        const x = inputs(model, names, rows, dan, family);
        const noteRaw = new Float64Array(slots.length);
        const sizeP = new Array(slots.length);
        for (let i = 0; i < slots.length; i += 1) {
            if (family[i] === null || family[i] === undefined) continue;
            const xi = x(i);
            noteRaw[i] = treeRaw(model.note, xi)[0];
            sizeP[i] = sizeProbabilities(model.size, xi);
        }
        if (model.grid !== "snap-v2") rescaleToQuarters({ model, audio: { ...audio, names }, slots, dan, family, noteRaw });
        const rateCache = {};
        const order3 = model.patternOrder === 3;
        return {
            noteRaw,
            step(i, offset, ctx, rngs, weightOf = null) {
                // one fill and one size draw per slot, as always, so the streams stay in step
                const u = rngs.fill();
                rngs.size();
                if (u >= sigmoid(noteRaw[i] + offset)) return 0;
                const fam = family[i];
                const rates = (rateCache[fam] ??= familySizeRates(model.pattern, fam));
                const sizeWeights = sizeP[i].map((q, k) => Math.min(HINT_LIMIT, Math.max(1 / HINT_LIMIT, (q / rates[k]) ** SIZE_HINT)));
                const prev3 = order3 ? ctx.recent?.[2]?.mask ?? 0 : null;
                const fl = flavour?.[i];
                const bias = fl ? motifWeights(fl.id, ctx.recent?.map((r) => r.mask) ?? [ctx.prev, ctx.prev2], fl.phrase) : null;
                return sampleRow(model.pattern, fam, ctx.prev, ctx.prev2, sizeWeights, rngs.pattern, weightOf, prev3, bias);
            },
        };
    },
};
