import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planSlots, slotTargets, fillPlan, clashes, planTotalSec, createPlanner } from "../../src/recommend/plan.js";
import { readSkill } from "../../src/recommend/skill.js";
import { SEARCH_PAGE_SIZE } from "../../src/recommend/rank.js";

const search = JSON.parse(await readFile(new URL("../fixtures/mt/search.json", import.meta.url), "utf8"));
const SKILL = readSkill(JSON.parse(await readFile(new URL("../fixtures/mt/skills.json", import.meta.url), "utf8")));
// stamina tile 13.26 (jumpstream), speed tile 14.28 (stream)
const template = search.items[3].diffs[0];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("slot windows: 5 maps (two warm-ups, two growth, a challenge) and 6 (growth in three)", () => {
    assert.deepEqual(planSlots(5), [
        { role: "warmup", dan: [-0.7, -0.35] },
        { role: "warmup", dan: [-0.35, -0.05] },
        { role: "growth", dan: [0, 0.25] },
        { role: "growth", dan: [0.25, 0.5] },
        { role: "challenge", dan: [0.5, 0.9] },
    ]);
    assert.deepEqual(planSlots(6).map((s) => [s.role, ...s.dan]), [
        ["warmup", -0.7, -0.35], ["warmup", -0.35, -0.05],
        ["growth", 0, 0.2], ["growth", 0.15, 0.35], ["growth", 0.3, 0.5],
        ["challenge", 0.5, 0.9],
    ]);
    for (const size of [4, 7, "5", null]) assert.equal(planSlots(size), null);
});

test("slot targets: around the tile dan, MSD offsets of the goals, patterns in turn", () => {
    const slots = slotTargets({ skill: SKILL, manualDan: null, patternIds: ["jumpstream", "stream"], slots: planSlots(5) });
    assert.deepEqual(slots.map((s) => s.patternId), ["jumpstream", "stream", "jumpstream", "stream", "jumpstream"]);
    const [warm, warm2, growth, , challenge] = slots;
    assert.deepEqual([warm.target.lo, warm.target.hi], [12.56, 12.91]);
    assert.deepEqual([warm2.target.lo, warm2.target.hi], [13.93, 14.23]);
    assert.deepEqual([growth.target.lo, growth.target.hi, growth.target.center], [13.26, 13.51, 13.39]);
    assert.deepEqual([challenge.target.lo, challenge.target.hi], [13.76, 14.16]);
    // MSD target = the player's Jumpstream rating (30.61) + comfort −1 / growth +0.75 / challenge +2
    assert.equal(warm.target.msdTarget, 29.61);
    assert.equal(growth.target.msdTarget, 31.36);
    assert.equal(challenge.target.msdTarget, 32.61);
    // a manual dan: same windows around it, no MSD target
    const manual = slotTargets({ skill: null, manualDan: 13, patternIds: ["tech"], slots: planSlots(6) });
    assert.deepEqual(manual.map((s) => s.target.lo), [12.3, 12.65, 13, 13.15, 13.3, 13.5]);
    assert.ok(manual.every((s) => s.target.msdTarget === null && s.target.source === "manual"));
});

// Cards as rankSets makes them: id, set, title, dan, msd, length.
const card = (beatmapId, beatmapsetId, title, dan, lengthSec = 120, msd = 30) => ({ beatmapId, beatmapsetId, title, dan, msd, lengthSec });

test("fillPlan takes no set and no chart twice", () => {
    const a = card(1, 10, "Song X", 13);
    const sameSet = card(2, 10, "Song X", 13.3);
    const reupload = card(3, 11, "Song X (Cut Ver.)", 13.02, 121);
    const other = card(4, 12, "Song Y", 13.2);
    const slots = [{ role: "warmup" }, { role: "growth" }, { role: "challenge" }];
    assert.deepEqual(fillPlan(slots, [[a], [sameSet, reupload, other], [other]]), [a, other, null]);
    // already taken cards count too
    assert.deepEqual(fillPlan(slots.slice(0, 1), [[a, other]], { taken: [a] }), [other]);
    assert.equal(clashes(reupload, [a]), true);
    assert.equal(clashes(card(5, 13, "Song X", 14.5), [a]), false, "the same song at another dan is another chart");
    assert.equal(planTotalSec([a, null, other]), 240);
});

// Tracker sets spread over dans; the fake search answers the window it was asked for, most played first.
function fakeTracker({ pool }) {
    const calls = [];
    const lower = (dan, step) => dan + step * 0.2 - 0.1;
    const api = {
        async searchMaps(params) {
            calls.push(params);
            const lo = lower(params.danMin, params.danMinStep);
            const hi = lower(params.danMax, params.danMaxStep) + 0.2;
            const hits = pool.filter((s) => s.pattern === params.patterns && s.diffs[0].dan.rawDan > lo && s.diffs[0].dan.rawDan <= hi + 1e-9)
                .sort((x, y) => y.playCount - x.playCount);
            const from = params.page * params.pageSize;
            return { items: hits.slice(from, from + params.pageSize), total: hits.length, page: params.page };
        },
    };
    return { api, calls };
}

function makeSet(i, dan, patternId = "jumpstream", playCount = 100000 - i) {
    const diff = {
        ...template, beatmapId: 9000000 + i, beatmapsetId: 800000 + i, title: `Song ${i}`, version: `[4K] #${i}`,
        dan: { rawDan: dan }, playCount, primaryPattern: patternId, length: 100 + (i % 50), covers: null,
    };
    return { ...diff, diffs: [diff], pattern: patternId };
}

function fakeRecommender({ player = { id: 7, username: "TestPlayer", skill: SKILL }, played = new Map(), partial = false } = {}) {
    const calls = { playedMaps: 0 };
    return {
        calls,
        currentPlayer: () => player,
        async playedMaps() {
            calls.playedMaps += 1;
            return { played: player ? played : new Map(), partial };
        },
    };
}

const REQ = { size: 5, patternIds: ["jumpstream"], lengthId: "any", rankedOnly: false, manual: false, manualDan: null };
const round2 = (x) => Math.round(x * 100) / 100;

test("build: one wide search per pattern (3 pages), a card per slot with rising dans, played maps left out", async () => {
    // 300 jumpstream sets from 12.4 to 14.5
    const pool = Array.from({ length: 300 }, (_, i) => makeSet(i, round2(12.4 + (i % 106) * 0.02)));
    const { api, calls } = fakeTracker({ pool });
    const played = new Map([[9000010, { beatmapsetId: 800010, accuracy: 0.97, rate: 1 }]]); // dan 12.6, a top warm-up
    const planner = createPlanner({ api, recommender: fakeRecommender({ played }) });
    const plan = await planner.build(REQ);

    assert.deepEqual(calls.map((p) => p.page), [0, 1, 2]);
    assert.ok(calls.every((p) => p.patterns === "jumpstream" && p.pageSize === SEARCH_PAGE_SIZE));
    // 12.56 … 14.16 in tracker steps
    assert.deepEqual([calls[0].danMin, calls[0].danMinStep, calls[0].danMax, calls[0].danMaxStep], [13, -2, 14, 1]);

    assert.deepEqual(plan.header, { playerDan: 13.26, label: "Gamma mid/high", tile: "Stamina", source: "tile", patternId: "jumpstream" });
    assert.deepEqual(plan.slots.map((s) => s.role), ["warmup", "warmup", "growth", "growth", "challenge"]);
    const dans = plan.slots.map((s) => s.card.dan);
    plan.slots.forEach((s) => assert.ok(s.card.dan >= s.lo - 1e-9 && s.card.dan <= s.hi + 1e-9, `${s.card.dan} in ${s.lo}..${s.hi}`));
    assert.deepEqual([...dans].sort((a, b) => a - b), dans, "dans rise slot by slot");
    assert.equal(new Set(plan.slots.map((s) => s.card.beatmapsetId)).size, 5);
    assert.ok(plan.slots.every((s) => s.card.beatmapId !== 9000010), "the played map is not in the plan");
    close(plan.slots[2].center, 13.39);
    assert.equal(plan.totalSec, plan.slots.reduce((sum, s) => sum + s.card.lengthSec, 0));
    assert.equal(plan.playedPartial, false);
});

test("an empty slot gets one search of its own (page 0)", async () => {
    // well-played sets cover the warm-up and growth windows; the challenge window only has three little-played ones
    const pool = [
        ...Array.from({ length: 200 }, (_, i) => makeSet(i, round2(12.56 + (i % 120) * 0.01))),
        ...[0, 1, 2].map((k) => makeSet(500 + k, 13.9 + k * 0.05, "jumpstream", 50)),
    ];
    const { api, calls } = fakeTracker({ pool });
    const plan = await createPlanner({ api, recommender: fakeRecommender() }).build(REQ);
    assert.equal(calls.length, 4);
    const own = calls[3];
    assert.equal(own.page, 0);
    assert.deepEqual([own.danMin, own.danMinStep, own.danMax, own.danMaxStep], [14, -1, 14, 1]);
    assert.ok([9000500, 9000501, 9000502].includes(plan.slots[4].card.beatmapId));
});

test("patterns take the slots in turn, each with its own wide search", async () => {
    const pool = [
        ...Array.from({ length: 120 }, (_, i) => makeSet(i, round2(12.4 + (i % 100) * 0.02), "jumpstream")),
        ...Array.from({ length: 120 }, (_, i) => makeSet(1000 + i, round2(13.5 + (i % 100) * 0.02), "stream")),
    ];
    const { api, calls } = fakeTracker({ pool });
    const plan = await createPlanner({ api, recommender: fakeRecommender() }).build({ ...REQ, patternIds: ["jumpstream", "stream"] });
    assert.deepEqual(plan.slots.map((s) => s.patternId), ["jumpstream", "stream", "jumpstream", "stream", "jumpstream"]);
    assert.deepEqual([...new Set(calls.map((p) => p.patterns))], ["jumpstream", "stream"]);
    // stream slots sit around the speed tile (14.28): 13.93–14.23 and 14.53–14.78
    assert.deepEqual([plan.slots[1].lo, plan.slots[3].lo], [13.93, 14.53]);
});

test("swap hands out the slot's next candidate without asking the tracker; at the end it says none", async () => {
    const pool = Array.from({ length: 300 }, (_, i) => makeSet(i, round2(12.4 + (i % 106) * 0.02)));
    const { api, calls } = fakeTracker({ pool });
    const planner = createPlanner({ api, recommender: fakeRecommender() });
    const plan = await planner.build(REQ);
    const before = calls.length;
    const first = plan.slots[2].card;
    const next = planner.swap(2);
    assert.ok(next && next.beatmapId !== first.beatmapId);
    assert.ok(next.dan >= plan.slots[2].lo - 1e-9 && next.dan <= plan.slots[2].hi + 1e-9);
    const others = plan.slots.filter((_, i) => i !== 2).map((s) => s.card.beatmapsetId);
    assert.ok(!others.includes(next.beatmapsetId));
    assert.equal(calls.length, before);
    assert.throws(() => planner.swap(9));

    // a slot with a single candidate has nothing to swap to
    const lonely = [
        ...Array.from({ length: 200 }, (_, i) => makeSet(i, round2(12.56 + (i % 120) * 0.01))),
        makeSet(600, 13.95, "jumpstream", 50),
    ];
    const small = createPlanner({ api: fakeTracker({ pool: lonely }).api, recommender: fakeRecommender() });
    await small.build(REQ);
    assert.equal(small.swap(4), null);
});

test("a plan needs a profile unless the dan is manual; manual plans work without one", async () => {
    const pool = Array.from({ length: 100 }, (_, i) => makeSet(i, round2(12.3 + i * 0.012)));
    const noPlayer = fakeRecommender({ player: null });
    const planner = createPlanner({ api: fakeTracker({ pool }).api, recommender: noPlayer });
    await assert.rejects(planner.build(REQ), { message: "сначала загрузи профиль с mania-tracker" });
    assert.throws(() => planner.swap(0));
    const plan = await planner.build({ ...REQ, manual: true, manualDan: 13, size: 6 });
    assert.equal(plan.slots.length, 6);
    assert.deepEqual(plan.header, { playerDan: 13, label: "Gamma mid", tile: null, source: "manual", patternId: "jumpstream" });
    assert.ok(plan.slots.filter((s) => s.card).length >= 5);
    await assert.rejects(planner.build({ ...REQ, manual: true, manualDan: null }), /дан/);
});
