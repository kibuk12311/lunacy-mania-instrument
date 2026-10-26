// Family-only generation, fixed seeds: the hashes of what both generators write. Recorded before sub-patterns
// existed (tests/fixtures/familyGolden.json), so picking only families keeps giving exactly the old maps.
// The analyzer is a stand-in (dan from the note count, a fixed pattern list), so only the generators are compared.
// That holds for the finder names this stand-in reports (Jumpstream, Chordjacks), whose family did not change. The
// fuller finder-name table that came with sub-patterns (search.js NAME_FAMILY: Chordstream, Jumptrill, Light
// Chordstream → Jumpstream; Brackets, Chord Rolls → Handstream; Jacks → Jack) changes the learned search's pattern
// score when the finder reports those names, and so which attempt it keeps: with the real finder some family-only
// maps differ from before sub-patterns. goldenNamedCases() pins that on purpose (tests/fixtures/familyGoldenNames.json,
// recorded with the new table, not before it).
import { createHash } from "node:crypto";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateMap } from "../../src/gen/generate.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { nextRow } from "../../src/gen/patterns.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { chartInfo } from "../../src/core/features.js";
import { partsSong, PARTS_SONG, PARTS_SONG_BPM, PARTS_SONG_OFFSET } from "./partsSong.js";

const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
const ONSET = AUDIO_FEATURES.indexOf("onset");
const ENERGY = AUDIO_FEATURES.indexOf("energy");

// Pattern tables counted from the rule generator's rows (order 2), so every family has real-looking continuations.
function patternTables() {
    const out = {};
    FAMILIES.forEach((family, f) => {
        const rng = mulberry32(100 + f);
        const table = {};
        const history = [];
        let prev = 0;
        let prev2 = 0;
        for (let i = 0; i < 4000; i += 1) {
            const cols = nextRow(family, history, rng, 0.9, i);
            history.push(cols);
            if (history.length > 4) history.shift();
            const mask = cols.reduce((m, c) => m | (1 << c), 0);
            const key = `${prev},${prev2},${cols.length}`;
            const counts = (table[key] ??= {});
            counts[mask] = (counts[mask] ?? 0) + 1;
            prev2 = prev;
            prev = mask;
        }
        out[family] = table;
    });
    return out;
}

// A tiny stand-in for a trained model: notes on onsets (more when loud), sizes 1–3.
export const goldenModel = {
    features: AUDIO_FEATURES,
    families: FAMILIES,
    note: { baseline: [0], classes: [0, 1], iterations: [[{
        feature: [ONSET, ENERGY, 0], threshold: [0.25, 0.5, 0], missingLeft: [1, 0, 0],
        left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -2.5, 2.5],
    }]] },
    size: { baseline: [0.6, 0.2, -0.6, -2], classes: [1, 2, 3, 4], iterations: [] },
    pattern: patternTables(),
};

// The Creator and Tags lines carry the app's name (renamed since the recording), not the generator's work.
const generatorPart = (text) => text.split(/\r?\n/).filter((line) => !/^(Creator|Tags):/.test(line)).join("\n");
const hash = (text) => createHash("sha1").update(generatorPart(text)).digest("hex").slice(0, 16);
const stand = (scale) => async (text) => ({
    kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / scale) * 100) / 100,
    top3: [{ name: "Jumpstream", share: 0.6 }, { name: "Chordjacks", share: 0.4 }],
});

// Names whose family the fuller table changed, next to names it did not; the stand-in below picks two of them by the
// map's own text, so the pattern score differs between attempts the way the real finder's does.
const NAMED = ["Chordstream", "Jacks", "Jumptrill", "Brackets", "Chord Rolls", "Light Chordstream", "Stream", "Jumpstream", "Gluts"];
const namesOf = (text) => {
    const h = createHash("sha1").update(generatorPart(text)).digest();
    const a = h[0] % NAMED.length;
    const b = (a + 1 + (h[1] % (NAMED.length - 1))) % NAMED.length;
    const share = Math.round((0.4 + (h[2] / 255) * 0.4) * 1000) / 1000;
    return [{ name: NAMED[a], share }, { name: NAMED[b], share: Math.round((1 - share) * 1000) / 1000 }];
};
const standNamed = (scale) => async (text) => ({
    kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / scale) * 100) / 100, top3: namesOf(text),
});

const REQUESTS = [
    ...FAMILIES.map((name) => ({ name, patterns: [{ name, share: 1 }], mix: "sections" })),
    { name: "Stream+Chordjack sections", patterns: [{ name: "Stream", share: 0.5 }, { name: "Chordjack", share: 0.5 }], mix: "sections" },
    { name: "Jumpstream+Jack+Tech mixed", patterns: [{ name: "Jumpstream", share: 0.4 }, { name: "Jack", share: 0.3 }, { name: "Tech", share: 0.3 }], mix: "mixed" },
];

let envelope = null;
const inputFor = (r, extra) => ({
    timing: { bpm: PARTS_SONG_BPM, offsetMs: PARTS_SONG_OFFSET }, envelope: (envelope ??= onsetEnvelope(partsSong(), 22050)), durationMs: PARTS_SONG.at(-1).endMs,
    request: { patterns: r.patterns, mix: r.mix, stamina: 0.5, burst: 0.3, seed: 7, ...extra },
    meta: { title: "golden", audioFilename: "a.mp3" },
});

// → [{ name, hash }] for the rule and the learned generator.
export async function goldenCases() {
    const out = [];
    for (const r of REQUESTS) {
        const input = (extra) => inputFor(r, extra);
        const rule = await generateMap(input({ target: 6 }), stand(150));
        out.push({ name: `rule ${r.name}`, hash: hash(rule.osuText) });
        const learned = await generateLearnedMap(input({ range: { lo: 5.5, hi: 6.5 } }), stand(150), goldenModel, {
            patternsOf: () => [{ name: "Jumpstream", share: 1 }],
        });
        out.push({ name: `learned ${r.name}`, hash: hash(learned.osuText) });
    }
    return out;
}

// → [{ name, hash }] for the learned generator with the finder stand-in that reports names of both kinds (the rule
// generator never ranks its attempts by the pattern score, so its maps don't depend on the table). Seeds 7 and 11.
export async function goldenNamedCases() {
    const out = [];
    for (const r of REQUESTS) {
        for (const seed of [7, 11]) {
            const learned = await generateLearnedMap(inputFor(r, { range: { lo: 5.5, hi: 6.5 }, seed }), standNamed(150), goldenModel, {
                patternsOf: namesOf,
            });
            out.push({ name: `learned ${r.name} seed ${seed}`, hash: hash(learned.osuText) });
        }
    }
    return out;
}
