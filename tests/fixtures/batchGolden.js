// Generator runs on the CPU that the GPU batches (stream W, D3/D4: builds stepped together on the GPU decoder) must not
// change: fixed seeds, a stand-in analyzer and finder, and a hash of what each response says about the map. Recorded
// with 0.10.2 (7a519e4), before the generator could run builds concurrently: tests/fixtures/batchGolden.json.
// Record again (only on purpose): node tests/fixtures/batchGolden.js --write
// Every case is run(opts) → the generator's response, so the same request can also go through the batch path
// (tests/gen/generateBatch.test.js); the nn-v2 cases use random tiny weights, "nn2 S" the shipped S model.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync, stemsFromTransfer, stemsToTransfer } from "../../src/audio/stems.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { randomInfillModel } from "../../src/gen/nn/infillModel.js";
import { BOOST_LADDER } from "../../src/gen/targeting.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { chartInfo } from "../../src/core/features.js";
import { dropSong } from "./dropSong.js";
import { sectionSong } from "./stemTracks.js";
import { goldenModel } from "./familyGolden.js";

const TINY = { d: 8, enc_layers: 1, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 2, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 4, dec_win: 4, cross_win: 3, n_glob: 1 };
export const tinyModel = { ...randomInfillModel(TINY, { seed: 5, std: 1.5 }), features: ["onset", "low", "mid", "high", "energy", "phase"] };

// the analyzer: dan from the notes per second; the finder: shares picked by the map's own text, so attempts and
// blocks score differently (some blocks are redone)
const textHash = (text) => createHash("sha1").update(text).digest();
const analyze = (scale) => async (text) => {
    const info = chartInfo(text, 1);
    const h = textHash(text);
    return {
        kind: "ok", numeric: Math.round((info.noteCount / Math.max(1, info.durationSec) / scale) * 100) / 100,
        top3: [{ name: "Rolls", share: 0.5 + (h[0] / 255) * 0.5 }, { name: "Jumptrill", share: (h[1] / 255) * 0.5 }],
        msd: Array.from({ length: 8 }, (_, k) => 10 + (h[2 + k] % 7)),
    };
};
const patternsOf = (text) => {
    const h = textHash(text);
    return [{ name: "Rolls", share: 0.35 + (h[0] / 255) * 0.65 }];
};

const drop = onsetEnvelope(dropSong({ seconds: 60 }), 22050);
const threeParts = [
    { startMs: 0, endMs: 20000, kind: "drop" },
    { startMs: 20000, endMs: 40000, kind: "break" },
    { startMs: 40000, endMs: 60000, kind: "drop" },
];
const dropInput = (request, over = {}) => ({
    timing: { sections: [{ timeMs: 300, bpm: 180, meter: 4 }], bpm: 180, offsetMs: 300 },
    envelope: drop, durationMs: 60000,
    request: { range: { lo: 4, hi: 5 }, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, ...request },
    meta: { title: "batch golden", audioFilename: "a.mp3" },
    deadlineMs: 1e9, // the candidate phase builds every candidate (the deadline is wall-clock)
    ...over,
});
let aba = null;
const abaInput = (request) => {
    if (!aba) {
        const song = sectionSong(["A", "B", "A"], { bpm: 160 });
        aba = {
            stems: stemsFromTransfer(stemsToTransfer(computeStemsSync(song.samples, song.sampleRate))),
            envelope: onsetEnvelope(song.samples, song.sampleRate),
            durationMs: Math.round((song.samples.length / song.sampleRate) * 1000),
        };
    }
    return {
        timing: { bpm: 160, offsetMs: 0 }, envelope: aba.envelope, durationMs: aba.durationMs, stems: aba.stems,
        request: { range: { lo: 3, hi: 4.5 }, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 2, ...request },
        meta: { title: "batch golden aba", audioFilename: "a.mp3" },
        deadlineMs: 1e9,
    };
};
const flavoured = [{ name: "Stream", share: 0.5 }, { name: "Jumpstream", share: 0.5, flavours: ["Jumptrill"] }];
let sModel = null;
const shippedS = () => (sModel ??= JSON.parse(readFileSync(new URL("../../models/mapper-nn2-s.json", import.meta.url), "utf8")));

// a map to lock part of (the first part), made once per model
const baseCache = new Map();
async function lockedFrom(model, opts) {
    if (!baseCache.has(model)) baseCache.set(model, await generateLearnedMap(dropInput({ parts: threeParts }), analyze(1), model, { patternsOf, ...opts }));
    const base = await baseCache.get(model);
    const rows = parseRows(base.osuText).filter((r) => r.t < 20000);
    return { rows: rows.map((r) => ({ t: r.t, mask: r.mask })), ranges: [[0, 20000]], knob: base.knob, planSeed: base.planSeed };
}

// name → run(opts): opts go to generateLearnedMap (the batch tests add a source or a backend)
export const BATCH_CASES = {
    "nn2 range": (o) => generateLearnedMap(dropInput({}), analyze(1), tinyModel, { patternsOf, ...o }),
    "nn2 candidates 6 + flavours": (o) => generateLearnedMap(dropInput({ candidates: 6, patterns: flavoured, range: { lo: 3, hi: 6 } }), analyze(1), tinyModel, { patternsOf, ...o }),
    "nn2 own-range part + retry": (o) => generateLearnedMap(dropInput({
        parts: threeParts.map((p, k) => (k === 2 ? { ...p, range: { lo: 2, hi: 4 } } : p)), stamina: 1, range: { lo: 3, hi: 6 }, candidates: 3,
    }), analyze(1), tinyModel, { patternsOf, ...o }),
    "nn2 narrow (refine)": (o) => generateLearnedMap(dropInput({ range: { lo: 5.62, hi: 5.7 } }), analyze(3), tinyModel, { patternsOf, ...o }),
    "nn2 target": (o) => generateLearnedMap(dropInput({ range: undefined, target: 4.5, candidates: 4 }), analyze(1), tinyModel, { patternsOf, ...o }),
    "nn2 far low (dan retry)": (o) => generateLearnedMap(dropInput({ range: { lo: 4, hi: 5 } }), analyze(6), tinyModel, { patternsOf, ...o }),
    "nn2 boost rung 2": (o) => generateLearnedMap(dropInput({ range: { lo: 9, hi: 11 }, candidates: 4 }), analyze(1), tinyModel, { patternsOf, boost: BOOST_LADDER[1], ...o }),
    "nn2 locked part": async (o) => generateLearnedMap(dropInput({ parts: threeParts, candidates: 4 }, { locked: await lockedFrom(tinyModel, o) }), analyze(1), tinyModel, { patternsOf, ...o }),
    "nn2 repeats + stems": (o) => generateLearnedMap(abaInput({ repeats: true, candidates: 4 }), analyze(1), tinyModel, { patternsOf, ...o }),
    "xgb candidates 4 + parts": (o) => generateLearnedMap(dropInput({ parts: threeParts.map((p, k) => (k === 0 ? { ...p, range: { lo: 5, hi: 7 } } : p)), candidates: 4 }), analyze(1), goldenModel, { patternsOf, ...o }),
    "nn2 S repeats + candidates 3": (o) => generateLearnedMap(abaInput({ repeats: true, candidates: 3, range: { lo: 2, hi: 3.5 } }), analyze(1), shippedS(), { patternsOf, ...o }),
};

// What a response says about the map (no timings: the critic's ms and the like)
export function fingerprint(r) {
    const critic = r.critic ? { ...r.critic, ms: undefined } : null;
    const body = JSON.stringify({
        osuText: r.osuText, result: r.result, knob: r.knob, reachable: r.reachable, noteCount: r.noteCount, version: r.version,
        patternScore: r.patternScore, flavourScore: r.flavourScore ?? null, noteSeed: r.noteSeed, stats: r.stats, issues: r.issues,
        parts: r.parts, retries: r.retries, grid: r.grid, critic, structure: r.structure ?? null, flavours: r.flavours,
    });
    return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

// → [{ name, hash }] on the CPU path
export async function batchGoldenCases(names = Object.keys(BATCH_CASES), opts = {}) {
    const out = [];
    for (const name of names) out.push({ name, hash: fingerprint(await BATCH_CASES[name](opts)) });
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
    const t0 = performance.now();
    const cases = await batchGoldenCases();
    writeFileSync(new URL("./batchGolden.json", import.meta.url), `${JSON.stringify(cases, null, 1)}\n`);
    console.log(cases, `${Math.round(performance.now() - t0)} ms`);
}
