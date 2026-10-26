import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cleanSeed, similarParams, similarity, pickSimilar, simLabel, seedDistance } from "../../src/recommend/similar.js";
import { seedOf } from "../../src/recommend/rank.js";
import { setLang } from "../../src/i18n/i18n.js";

const search = JSON.parse(await readFile(new URL("../fixtures/mt/search.json", import.meta.url), "utf8"));
const diffById = (id) => search.items.flatMap((it) => it.diffs ?? [it]).find((d) => d.beatmapId === id);
const FAREWELL = diffById(2701201); // set 1302447, dan 12.28, jumpstream
const HITSUGI = diffById(1097111); // set 516255, dan 12.73

test("seeds keep the primary pattern, seven MSD axes, eight patterns, BPM, length and dan, rounded", () => {
    const seed = seedOf(FAREWELL);
    assert.equal(seed.primaryPattern, "jumpstream");
    assert.deepEqual(Object.keys(seed.msdAll), ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"]);
    assert.equal(seed.msdAll.Jumpstream, 27.88);
    assert.deepEqual(Object.keys(seed.patternsAll).sort(), ["chordjack", "handstream", "jack", "jumpstream", "ln", "stamina", "stream", "tech"]);
    assert.equal(seed.patternsAll.stream, 0.92);
    assert.equal(seed.bpm, 250);
    assert.equal(seed.lengthSec, 197);
    assert.equal(seed.dan, 12.28);
    // a primary pattern the picks don't offer falls back to the one the card was found for; no dan, no seed
    assert.equal(seedOf({ ...FAREWELL, primaryPattern: "ln" }, null, "stream").primaryPattern, "stream");
    assert.equal(seedOf({ ...FAREWELL, primaryPattern: "ln" }), null);
    assert.equal(seedOf({ ...FAREWELL, dan: { rawDan: null } }), null);
    // a few hundred bytes a card
    assert.ok(JSON.stringify(seed).length < 400, `${JSON.stringify(seed).length} bytes`);
});

test("cleanSeed keeps a good seed and refuses NaN dans and unknown patterns", () => {
    const seed = seedOf(FAREWELL);
    assert.deepEqual(cleanSeed(seed), seed);
    assert.deepEqual(cleanSeed(JSON.parse(JSON.stringify(seed))), seed);
    assert.equal(cleanSeed({ ...seed, dan: NaN }), null);
    assert.equal(cleanSeed({ ...seed, dan: "12" }), null);
    assert.equal(cleanSeed({ ...seed, primaryPattern: "ln" }), null);
    assert.equal(cleanSeed({ ...seed, primaryPattern: "toString" }), null);
    assert.equal(cleanSeed(null), null);
    assert.equal(cleanSeed("seed"), null);
    // bad parts are dropped, the rest is kept
    const messy = cleanSeed({ ...seed, msdAll: { ...seed.msdAll, Stream: NaN, Evil: 3, __proto__: { x: 1 } }, patternsAll: { stream: Infinity, jack: 0.5, bad: 1 }, bpm: -5, lengthSec: "x" });
    assert.ok(!("Stream" in messy.msdAll) && !("Evil" in messy.msdAll));
    assert.equal(messy.msdAll.Jumpstream, 27.88);
    assert.deepEqual(messy.patternsAll, { jack: 0.5 });
    assert.equal(messy.bpm, null);
    assert.equal(messy.lengthSec, null);
});

test("similar search: the seed's primary pattern, its dan ± 0.35, the usual vibro and LN rules", () => {
    const seed = seedOf(FAREWELL);
    const p = similarParams(seed, true, 1);
    assert.equal(p.patterns, "jumpstream");
    assert.equal(p.page, 1);
    assert.equal(p.vibro, "hide");
    assert.equal(p.lnMax, 15);
    assert.equal(p.statuses, "ranked,loved");
    // 11.93 … 12.63 in tracker steps
    assert.deepEqual([p.danMin, p.danMinStep, p.danMax, p.danMaxStep], [12, 0, 13, -2]);
    assert.ok(!("statuses" in similarParams(seed, false)));
    assert.equal(similarParams(seed, false).page, 0);
});

test("the same map is fully similar", () => {
    assert.equal(similarity(seedOf(HITSUGI), HITSUGI), 1);
    assert.equal(seedDistance(seedOf(HITSUGI), seedOf(HITSUGI)), 0);
});

test("dan weighs more than MSD, and MSD more than BPM", () => {
    const seed = seedOf(HITSUGI);
    const danOff = { ...HITSUGI, dan: { ...HITSUGI.dan, rawDan: HITSUGI.dan.rawDan + 0.3 } };
    const msdOff = { ...HITSUGI, msd: Object.fromEntries(Object.entries(HITSUGI.msd).map(([k, v]) => [k, v + 1.7])) };
    const bpmOff = { ...HITSUGI, bpm: HITSUGI.bpm + 50 };
    const [dan, msd, bpm] = [danOff, msdOff, bpmOff].map((d) => similarity(seed, d));
    assert.ok(dan < msd && msd < bpm && bpm < 1, `${dan} ${msd} ${bpm}`);
    // each term is capped: a far dan costs at most 0.35
    const far = { ...HITSUGI, dan: { ...HITSUGI.dan, rawDan: 20 } };
    assert.ok(similarity(seed, far) >= 0.65 - 1e-9);
});

test("labels: very similar from 0.8, similar from 0.6, loosely below", () => {
    assert.deepEqual([0.95, 0.8, 0.79, 0.6, 0.59, 0].map(simLabel), ["очень похожа", "очень похожа", "похожа", "похожа", "отдалённо", "отдалённо"]);
    setLang("en");
    try {
        assert.deepEqual([0.8, 0.6, 0.1].map(simLabel), ["very similar", "similar", "loosely"]);
    } finally {
        setLang("ru");
    }
});

test("picks leave out the map's own set, re-uploads of it, LN-heavy and out-of-window charts", () => {
    const seed = seedOf(FAREWELL);
    // a re-upload of Farewell in another set: same song, dan and length
    const reupload = { ...FAREWELL, beatmapId: 998, beatmapsetId: 999, title: "Time to Say Goodbye (Cut Ver.)", version: "[4K] copy" };
    const items = [...search.items, { ...reupload, diffs: [reupload] }];
    const cards = pickSimilar(items, seed, { self: { beatmapId: 2701201, beatmapsetId: 1302447, title: "Time to Say Goodbye" } });
    // 2323787 is LN-heavy, 516255 (12.73) and 1938169 (13.22) are out of 11.93–12.63
    assert.deepEqual(cards.map((c) => c.beatmapId).sort(), [1938168, 2673655]);
    for (const c of cards) {
        assert.ok(c.sim > 0 && c.sim <= 1);
        assert.equal(typeof c.simLabel, "string");
        assert.ok(c.seed && c.title && c.beatmapsetId);
    }
    assert.ok(cards[0].sim >= cards[1].sim);
    // without the set id the map's own set is still found among the results
    assert.deepEqual(pickSimilar(items, seed, { self: { beatmapId: 2701201, title: "Time to Say Goodbye" } }).map((c) => c.beatmapId).sort(), [1938168, 2673655]);
});

test("played charts are marked, or left out when asked; at most `limit` cards", () => {
    const seed = seedOf(FAREWELL);
    const self = { beatmapId: 2701201, beatmapsetId: 1302447, title: "Time to Say Goodbye" };
    const played = new Map([[1938168, { beatmapsetId: 827679, accuracy: 0.97, rate: 1 }]]);
    const marked = pickSimilar(search.items, seed, { played, self });
    assert.deepEqual(marked.find((c) => c.beatmapId === 1938168).played, { accuracy: 0.97, rate: 1 });
    assert.deepEqual(pickSimilar(search.items, seed, { played, hidePlayed: true, self }).map((c) => c.beatmapId), [2673655]);

    const copies = Array.from({ length: 9 }, (_, i) => {
        const d = { ...HITSUGI, beatmapId: 100 + i, beatmapsetId: 200 + i, title: `Other song ${i}`, dan: { rawDan: 12.4 } };
        return { ...d, diffs: [d] };
    });
    assert.equal(pickSimilar(copies, seed, { self }).length, 5);
    assert.equal(pickSimilar(copies, seed, { self, limit: 3 }).length, 3);
});

test("two re-uploads of the same other chart count once", () => {
    const seed = seedOf(FAREWELL);
    const base = { ...HITSUGI, beatmapId: 300, beatmapsetId: 400, title: "Other", dan: { rawDan: 12.4 } };
    const copy = { ...base, beatmapId: 301, beatmapsetId: 401, title: "Other [Extended]", playCount: 10 };
    const cards = pickSimilar([{ ...base, diffs: [base] }, { ...copy, diffs: [copy] }], seed, { self: { beatmapId: 1 } });
    assert.deepEqual(cards.map((c) => c.beatmapId), [300]);
});
