import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { danBound, searchParams, purity, purityLabel, scoreDiff, rankSets } from "../../src/recommend/rank.js";
import { targetFor } from "../../src/recommend/skill.js";
import { setLang } from "../../src/i18n/i18n.js";

const search = JSON.parse(await readFile(new URL("../fixtures/mt/search.json", import.meta.url), "utf8"));
const manual = (dan, goalId = "growth", patternId = "jumpstream") => targetFor({ skill: null, manualDan: dan, patternId, goalId });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("dan bounds map onto the tracker's 0.2 steps", () => {
    assert.deepEqual(danBound(13.11), { dan: 13, step: 1 });
    assert.deepEqual(danBound(13.89), { dan: 14, step: -1 });
    assert.deepEqual(danBound(13), { dan: 13, step: 0 });
    assert.deepEqual(danBound(12.71), { dan: 13, step: -1 });
    assert.deepEqual(danBound(13.51), { dan: 14, step: -2 });
    assert.deepEqual(danBound(13.49), { dan: 13, step: 2 });
    assert.deepEqual(danBound(13.26), { dan: 13, step: 1 });
    assert.deepEqual(danBound(13.76), { dan: 14, step: -1 });
    // a value on a step boundary belongs to the lower step, as on the server: 13.5 gamma++, 13.7 delta--, 13.9 delta-
    assert.deepEqual(danBound(13.5), { dan: 13, step: 2 });
    assert.deepEqual(danBound(13.7), { dan: 14, step: -2 });
    assert.deepEqual(danBound(13.9), { dan: 14, step: -1 });
    assert.deepEqual(danBound(13.1), { dan: 13, step: 0 });
    assert.deepEqual(danBound(12.9), { dan: 13, step: -1 });
    assert.deepEqual(danBound(12.7), { dan: 13, step: -2 });
});

test("the step a dan falls in always contains it", () => {
    // server steps: (D−0.5, D−0.3] … (D+0.3, D+0.5]
    for (let i = 100; i <= 2100; i++) {
        const x = i / 100;
        const { dan, step } = danBound(x);
        const lower = dan + step * 0.2 - 0.1;
        assert.ok(step >= -2 && step <= 2, `${x}`);
        assert.ok(lower < x - 1e-9 && x <= lower + 0.2 + 1e-9, `${x} → ${dan} ${step}`);
    }
});

test("a window that starts on a step boundary asks for the step holding it", () => {
    // manual challenge from 13 mid: lo 13.5 is gamma++, not delta--
    const p = searchParams({ patternId: "jumpstream", lo: 13.5, hi: 14.2, lengthId: "any", rankedOnly: false });
    assert.deepEqual([p.danMin, p.danMinStep, p.danMax, p.danMaxStep], [13, 2, 14, 1]);
});

test("search params for a growth jumpstream window", () => {
    assert.deepEqual(searchParams({ patternId: "jumpstream", lo: 13.26, hi: 13.76, lengthId: "medium", rankedOnly: true, page: 2 }), {
        sort: "playcount", dir: "desc", page: 2, pageSize: 48, keys: "4k", patterns: "jumpstream", vibro: "hide", lnMax: 15,
        danMin: 13, danMinStep: 1, danMax: 14, danMaxStep: -1, lenMin: 120, lenMax: 240, statuses: "ranked,loved",
    });
    const open = searchParams({ patternId: "stream", lo: 12, hi: 12.5, lengthId: "any", rankedOnly: false });
    assert.equal(open.page, 0);
    assert.ok(!("lenMin" in open) && !("lenMax" in open) && !("statuses" in open));
    const short = searchParams({ patternId: "tech", lo: 12, hi: 12.5, lengthId: "short", rankedOnly: false, page: 0 });
    assert.equal(short.lenMax, 150);
    assert.ok(!("lenMin" in short));
});

test("purity compares the pattern with the other rice patterns", () => {
    const fixture = search.items[0].diffs[0].patterns;
    // jumpstream 1 vs mean(stream, handstream, chordjack, jack)
    const mean = (fixture.stream + fixture.handstream + fixture.chordjack + fixture.jack) / 4;
    close(purity(fixture, "jumpstream"), (1 - mean) / 0.5);
    assert.equal(purityLabel(purity(fixture, "jumpstream")), "в основном");
    assert.equal(purity({ stream: 1, jumpstream: 0.2, handstream: 0.1, chordjack: 0.1, jack: 0 }, "stream"), 1);
    // missing patterns count as zero
    close(purity({ stream: 0.5, jumpstream: 0.9 }, "stream"), 0.55);
    assert.equal(purity({ stream: 0.9, jumpstream: 1, handstream: 1, chordjack: 1, jack: 1 }, "stream"), 0);
    // tech is not among the compared patterns, so all five count
    close(purity({ tech: 1, stream: 0.5, jumpstream: 0.5, handstream: 0.5, chordjack: 0.5, jack: 0.5 }, "tech"), 1);
    close(purity({ tech: 1, stream: 0.8, jumpstream: 0.8, handstream: 0.8, chordjack: 0.8, jack: 0.8 }, "tech"), 0.4);
    assert.equal(purity(undefined, "stream"), 0);
    assert.deepEqual([0.7, 0.69, 0.4, 0.39, 0].map(purityLabel), ["чистый", "в основном", "в основном", "смешанный", "смешанный"]);
});

test("score follows the formula", () => {
    const target = { ...manual(13), msdRating: 30, msdTarget: 30.75 };
    const diff = {
        dan: { rawDan: 13.35 }, msd: { Jumpstream: 31.5 }, playCount: 9999,
        patterns: { jumpstream: 1, stream: 0.5, handstream: 0.5, chordjack: 0.5, jack: 0.5 },
    };
    const danFit = 1 - 0.1 / 0.4;
    const msdFit = 1 - 0.75 / 1.5;
    const popularity = (Math.log10(10000) - 2) / 3; // log10 plays: 100 → 0, 100k → 1
    const expected = 0.25 * danFit + 0.25 * msdFit + 0.2 * 1 + 0.3 * popularity;
    close(scoreDiff(diff, target), expected, 1e-6);
    close(scoreDiff(diff, target, { setPlayed: true }), expected - 0.1, 1e-6);
    close(scoreDiff(diff, target, { played: true }), expected - 0.3, 1e-6);
    // no MSD target (manual): the MSD fit copies the dan fit
    close(scoreDiff(diff, manual(13)), 0.25 * danFit + 0.25 * danFit + 0.2 + 0.3 * popularity, 1e-6);
    close(scoreDiff({ ...diff, playCount: 50 }, manual(13)), 0.5 * danFit + 0.2, 1e-6);
    close(scoreDiff({ ...diff, playCount: 5e6 }, manual(13)), 0.5 * danFit + 0.2 + 0.3, 1e-6);
    // far away and unknown: fits bottom out at zero
    const far = { dan: { rawDan: 20 }, msd: {}, playCount: 0, patterns: {} };
    close(scoreDiff(far, target), 0);
});

test("rankSets keeps the best in-window diff per set", () => {
    const target = manual(12.5); // [12.5, 13.0]
    const cards = rankSets(search.items, target);
    // 1302447: 12.98 in (12.28 out); 2323787: ln share 0.48; 827679: 12.26/13.22 both out; 516255: 12.73; 1287761: 11.94 out
    assert.deepEqual(cards.map((c) => c.beatmapId), [1097111, 2701197]);
    const c = cards.find((x) => x.beatmapId === 2701197);
    assert.equal(c.beatmapsetId, 1302447);
    assert.equal(c.title, "Time to Say Goodbye");
    assert.equal(c.artist, "Jeff Williams feat. Casey Lee Williams");
    assert.equal(c.version, "[4K] Farewell 1.05x (263bpm)");
    assert.equal(c.creator, "Halogen-");
    assert.equal(c.status, "loved");
    assert.equal(c.stars, 5.93302);
    assert.equal(c.bpm, 262.5);
    assert.equal(c.lengthSec, 188);
    assert.equal(c.playCount, 18901);
    assert.equal(c.cover, "https://assets.ppy.sh/beatmaps/1302447/covers/list.jpg?1646175094");
    assert.equal(c.dan, 12.98);
    assert.equal(c.danLabel, "Gamma mid");
    assert.equal(c.delta, 0.48);
    close(c.msd, 29.35, 0.01);
    assert.equal(c.msdTarget, null);
    assert.equal(c.purityLabel, "в основном");
    assert.equal(c.played, null);
    assert.equal(c.setPlayed, false);
    // the seed "more like this" starts from, rounded to 0.01
    assert.equal(c.seed.primaryPattern, "jumpstream");
    assert.equal(c.seed.dan, 12.98);
    assert.equal(c.seed.bpm, 262.5);
    assert.equal(c.seed.lengthSec, 188);
    assert.equal(c.seed.msdAll.Jumpstream, 29.35);
    assert.equal(Object.keys(c.seed.msdAll).length, 7);
    assert.equal(Object.keys(c.seed.patternsAll).length, 8);
    assert.ok(cards[0].score > cards[1].score);
    assert.ok(cards.every((x) => x.dan >= target.lo && x.dan <= target.hi));
});

test("played maps are marked, penalised or hidden", () => {
    const target = manual(12.5);
    const played = new Map([
        [1097111, { beatmapsetId: 516255, accuracy: 0.97, rate: 1.1 }],
        [2701201, { beatmapsetId: 1302447, accuracy: 0.95, rate: 1 }], // the out-of-window diff of the set
    ]);
    const fresh = rankSets(search.items, target);
    const cards = rankSets(search.items, target, { played });
    const own = cards.find((c) => c.beatmapId === 1097111);
    assert.deepEqual(own.played, { accuracy: 0.97, rate: 1.1 });
    assert.equal(own.setPlayed, false);
    close(own.score, fresh.find((c) => c.beatmapId === 1097111).score - 0.3, 1e-3);
    const sibling = cards.find((c) => c.beatmapId === 2701197);
    assert.equal(sibling.played, null);
    assert.equal(sibling.setPlayed, true);
    close(sibling.score, fresh.find((c) => c.beatmapId === 2701197).score - 0.1, 1e-3);
    assert.deepEqual(cards.map((c) => c.beatmapId), [1097111, 2701197]);

    const hidden = rankSets(search.items, target, { played, hidePlayed: true });
    assert.deepEqual(hidden.map((c) => c.beatmapId), [2701197]);

    // every played diff is reported, hidden or out of the window, so its re-uploads can be recognised
    const seen = [];
    rankSets(search.items, target, { played, hidePlayed: true, onPlayed: (chart, play) => seen.push([chart, play.accuracy]) });
    assert.equal(seen.length, 2);
    const [chart] = seen.find(([, accuracy]) => accuracy === 0.97);
    const card = fresh.find((c) => c.beatmapId === 1097111);
    assert.deepEqual(chart, { title: card.title, dan: card.dan, msd: card.msd, lengthSec: card.lengthSec });
});

test("a set without diffs is its own diff; diffs without a dan or with LNs are dropped", () => {
    const [top] = search.items;
    const { diffs, ...bare } = top;
    const noDan = { ...top, beatmapsetId: 9, diffs: [{ ...top.diffs[1], beatmapsetId: 9, dan: { label: null, rawDan: null } }] };
    const lnHeavy = { ...bare, beatmapsetId: 10, beatmapId: 10, lnShare: 0.3 };
    const cards = rankSets([bare, noDan, lnHeavy], manual(12));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].beatmapId, 2701201);
    assert.equal(cards[0].dan, 12.28);
    assert.equal(cards[0].cover, top.covers.list);
    assert.equal(rankSets([{ ...bare, covers: null }], manual(12))[0].cover, null);
});

test("LN share is capped where our analyzer still counts a map as rice", () => {
    const [top] = search.items;
    const { diffs, ...bare } = top;
    const at = (lnShare, id) => ({ ...bare, beatmapsetId: id, beatmapId: id, lnShare });
    // 0.16 and 0.19 would come back as «не 4K рис» from «Наш анализ»
    assert.deepEqual(rankSets([at(0.15, 1), at(0.16, 2), at(0.19, 3)], manual(12)).map((c) => c.beatmapId), [1]);
});

test("vibro charts the tracker doesn't flag are dropped by their names", () => {
    const [top] = search.items;
    const { diffs, ...bare } = top;
    const named = (id, fields) => ({ ...bare, beatmapsetId: id, beatmapId: id, vibro: false, ...fields });
    const items = [
        named(1, { title: "4k Vibro Pack 6" }),
        named(2, { version: "[4K] VIBRO" }),
        named(3, { artist: "Cirno The VIBRORER" }),
        named(4, {}),
    ];
    assert.deepEqual(rankSets(items, manual(12)).map((c) => c.beatmapId), [4]);
    // a set with diffs: the diff's own names count, the set's are the fallback
    const set = { ...top, title: "Some Vibros", diffs: top.diffs.map((d) => ({ ...d, title: undefined })) };
    assert.deepEqual(rankSets([set], manual(12)), []);
});

test("in English purity reads pure / mostly / mixed", () => {
    setLang("en");
    try {
        assert.deepEqual([0.7, 0.69, 0.4, 0.39, 0].map(purityLabel), ["pure", "mostly", "mostly", "mixed", "mixed"]);
    } finally {
        setLang("ru");
    }
    assert.equal(purityLabel(1), "чистый");
});
