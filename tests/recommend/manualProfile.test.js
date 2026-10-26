// The hand-set profile (no mania-tracker): the model, its overall dan, the pattern → axis mapping, and the
// main-process consumers that take it like a tracker profile (picks, plan, auto-marathon).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    MANUAL_AXES, snapDan, pickerDan, normalizeManualProfile, uniformProfile, manualOverall, manualSkill, profileFromSkill, manualProfileOf,
} from "../../src/recommend/manualProfile.js";
import { readSkill, playerDanFor, targetFor, targetForRange } from "../../src/recommend/skill.js";
import { REC_PATTERNS, REC_KINDS } from "../../src/recommend/catalog.js";
import { createRecommender } from "../../src/recommend/recommend.js";
import { createPlanner } from "../../src/recommend/plan.js";
import { createRecommendHandlers } from "../../app/recommendIpc.js";
import { createMarathonAutoHandlers } from "../../app/marathonAutoIpc.js";
import { fitForSkill } from "../../src/analysis/mapFit.js";
import { setLang } from "../../src/i18n/i18n.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/mt/${name}.json`, import.meta.url), "utf8"));
const TRACKER = readSkill(await fixture("skills"));
const search = await fixture("search");
// "Speed Delta mid/high · Stamina Gamma mid/high · Tech Delta low/mid · Jack Gamma high"
const MINE = { name: "TestPlayer", speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 };

test("the profile keeps four dans of the picker and an optional name", () => {
    assert.deepEqual(MANUAL_AXES, ["speed", "jack", "stamina", "tech"]);
    assert.deepEqual(normalizeManualProfile(MINE), MINE);
    assert.deepEqual(normalizeManualProfile({ ...MINE, name: "  x  ", junk: 1 }), { ...MINE, name: "x" });
    assert.equal(normalizeManualProfile({ ...MINE, name: "n".repeat(50) }).name.length, 32);
    assert.equal(normalizeManualProfile({ ...MINE, name: 7 }).name, "");
    // every axis is needed, each a dan the picker shows (1 дан low … Kappa high, steps of 0.2)
    for (const bad of [{ ...MINE, tech: undefined }, { ...MINE, jack: 13.3 }, { ...MINE, speed: 0.4 }, { ...MINE, stamina: 20.6 }, { ...MINE, speed: "14" }, { ...MINE, speed: NaN }]) {
        assert.equal(normalizeManualProfile(bad), null, JSON.stringify(bad));
    }
    for (const bad of [null, undefined, "x", [], 5]) assert.equal(normalizeManualProfile(bad), null);
    assert.deepEqual([pickerDan(0.6), pickerDan(20.4), pickerDan(13.000000001), pickerDan(13.1), pickerDan(21)], [0.6, 20.4, 13, null, null]);
    assert.deepEqual([snapDan(13.36), snapDan(13.5), snapDan(0), snapDan(30), snapDan(null)], [13.4, 13.6, 0.6, 20.4, null]);
    assert.deepEqual(uniformProfile(13.8), { name: "", speed: 13.8, jack: 13.8, stamina: 13.8, tech: 13.8 });
    assert.deepEqual(uniformProfile("x"), { name: "", speed: 13, jack: 13, stamina: 13, tech: 13 });
});

test("the overall dan is the mean of the four axes, as mania-tracker's own", () => {
    // the tracker fixture: its overall 13.66 is exactly the mean of its four skillsets
    assert.equal(manualOverall(TRACKER.tiles), TRACKER.overall);
    assert.equal(manualOverall(MINE), 13.65);
    assert.equal(manualOverall(uniformProfile(12.6)), 12.6);
    assert.equal(manualOverall({ ...MINE, jack: null }), null);
});

test("as a skill it has readSkill's shape: tiles, overall and its label, no plays, no MSD, marked manual", () => {
    assert.deepEqual(manualSkill(MINE), {
        ready: true, status: "manual", tracked: false, manual: true, analyzedPlays: 0,
        overall: 13.65, overallLabel: "Delta low",
        tiles: { speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 },
        msd: {},
    });
    assert.equal(manualSkill({ ...MINE, jack: 13.3 }), null);
});

test("copy from the tracker: each tile on the picker's nearest step; a missing one takes the overall", () => {
    assert.deepEqual(profileFromSkill(TRACKER, "TestPlayer"), { name: "TestPlayer", speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 });
    assert.deepEqual(profileFromSkill({ overall: 12.4, tiles: { speed: 12.9, stamina: null } }), { name: "", speed: 13, jack: 12.4, stamina: 12.4, tech: 12.4 });
    assert.deepEqual(profileFromSkill(null), uniformProfile(13));
});

test("saved settings: the profile, else the 0.9.1 single manual dan on every axis", () => {
    assert.deepEqual(manualProfileOf({ manualProfile: MINE, level: 5, step: "low" }), MINE);
    assert.deepEqual(manualProfileOf({ level: 14, step: "low/mid" }), uniformProfile(13.8));
    assert.deepEqual(manualProfileOf({ manualProfile: { speed: 1 }, level: 14, step: "low/mid" }), uniformProfile(13.8));
    assert.deepEqual(manualProfileOf(null), uniformProfile(13));
});

test("every pattern maps to its axis as with a tracker profile", () => {
    const skill = manualSkill(MINE);
    const axisOf = Object.fromEntries([...REC_PATTERNS, ...REC_KINDS].map((p) => [p.id, playerDanFor(skill, p.id)]));
    assert.deepEqual(Object.fromEntries(Object.entries(axisOf).map(([id, own]) => [id, [own.tile, own.dan, own.source]])), {
        stream: ["speed", 14.2, "tile"],
        jumpstream: ["stamina", 13.2, "tile"],
        handstream: ["stamina", 13.2, "tile"],
        stamina: ["stamina", 13.2, "tile"],
        chordjack: ["jack", 13.4, "tile"],
        jack: ["jack", 13.4, "tile"],
        tech: ["tech", 13.8, "tile"],
        quadstream: ["jack", 13.4, "tile"],
        handjack: ["jack", 13.4, "tile"],
        speedjack: ["jack", 13.4, "tile"],
    });
});

test("goal windows around the axis dan, marked hand-set, without an MSD target", () => {
    const skill = manualSkill(MINE);
    const growth = targetFor({ skill, manualDan: null, patternId: "stream", goalId: "growth" });
    assert.deepEqual([growth.source, growth.tile, growth.playerDan, growth.lo, growth.hi, growth.msdTarget, growth.handSet], ["tile", "speed", 14.2, 14.2, 14.7, null, true]);
    const comfort = targetFor({ skill, manualDan: null, patternId: "tech", goalId: "comfort" });
    assert.deepEqual([comfort.lo, comfort.hi], [13.2, 13.7]);
    // a tracker profile is not marked
    assert.equal("handSet" in targetFor({ skill: TRACKER, manualDan: null, patternId: "stream", goalId: "growth" }), false);
    // a custom range keeps the hand-set dan as its reference
    const range = targetForRange({ skill, patternId: "chordjack", from: 12.6, to: 13 });
    assert.deepEqual([range.source, range.playerDan, range.lo, range.hi, range.handSet], ["tile", 13.4, 12.5, 13.1, true]);
});

test("the analysis card's fit takes the axis dan of the map's pattern", () => {
    const fit = fitForSkill({ kind: "ok", numeric: 13.7, primary: "Jumpstream", msd: { jumpstream: 30 } }, manualSkill(MINE));
    assert.deepEqual([fit.tile, fit.source, fit.playerDan, fit.delta, fit.band, fit.msd], ["stamina", "tile", 13.2, 0.5, "growth", null]);
    const tech = fitForSkill({ kind: "ok", numeric: 13.0, primary: "Stream", tech: true }, manualSkill(MINE));
    assert.deepEqual([tech.tile, tech.playerDan, tech.band], ["tech", 13.8, "easy"]);
});

// A tracker search that answers from the fixture (no network); played maps are never asked without a player.
function fakeTracker() {
    const calls = { searchMaps: [], playedMaps: 0, skills: 0 };
    const api = {
        async findUser() { return null; },
        async skills() { calls.skills += 1; return {}; },
        async playedMaps() { calls.playedMaps += 1; return new Map(); },
        async searchMaps(params) {
            calls.searchMaps.push(params);
            return { items: params.page === 0 ? search.items : [], total: search.items.length, page: params.page, pageSize: params.pageSize };
        },
    };
    return { api, calls };
}

test("picks: a hand-set profile searches the pattern's axis window, with no mania-tracker account", async () => {
    const { api, calls } = fakeTracker();
    const rec = createRecommender({ api });
    const out = await rec.start({ manual: true, manualDan: null, manualSkill: manualSkill(MINE), patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: false, hidePlayed: true });
    assert.deepEqual([out.target.playerDan, out.target.lo, out.target.hi, out.target.handSet], [13.2, 13.2, 13.7, true]);
    assert.equal(calls.playedMaps, 0, "no plays without a tracker player");
    assert.ok(calls.searchMaps.length > 0);
    assert.ok(out.cards.every((c) => c.dan >= 13.2 - 0.11 && c.dan <= 13.7 + 0.11), out.cards.map((c) => c.dan).join());
    // the old single manual dan still works
    const old = await rec.start({ manual: true, manualDan: 13, patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: false, hidePlayed: false });
    assert.deepEqual([old.target.source, old.target.lo], ["manual", 13]);
});

test("plan: slots around the hand-set axis dans, the header names the tile and says hand-set", async () => {
    const { api } = fakeTracker();
    const recommender = { currentPlayer: () => null, playedMaps: async () => { throw new Error("no player"); } };
    const planner = createPlanner({ api, recommender, pages: 1 });
    const plan = await planner.build({ size: 5, patternIds: ["jumpstream", "stream"], lengthId: "any", rankedOnly: false, manual: true, manualDan: null, manualSkill: manualSkill(MINE) });
    assert.deepEqual(plan.header, { playerDan: 13.2, label: "Gamma mid/high", tile: "Stamina", source: "tile", handSet: true, patternId: "jumpstream" });
    // jumpstream slots around Stamina 13.2, stream slots around Speed 14.2
    assert.deepEqual(plan.slots.map((s) => [s.patternId, s.lo]), [["jumpstream", 12.5], ["stream", 13.85], ["jumpstream", 13.2], ["stream", 14.45], ["jumpstream", 13.7]]);
});

test("a hand-set profile with a linked Interlude: its played maps are hidden in picks and left out of the plan, with no tracker", async () => {
    const REQ = { manual: true, manualDan: null, manualSkill: manualSkill(MINE), patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: false };
    const plain = await createRecommender({ api: fakeTracker().api }).start({ ...REQ, hidePlayed: true });
    const playedId = plain.cards[0].beatmapId;
    // Interlude's played osu! maps (app/interludeLibrary.js playedBeatmaps): beatmap id → play
    const extra = new Map([[playedId, { beatmapsetId: plain.cards[0].beatmapsetId, accuracy: null, rate: null, interlude: true }]]);
    const { api, calls } = fakeTracker();
    const rec = createRecommender({ api, extraPlayed: async () => extra });
    const hidden = await rec.start({ ...REQ, hidePlayed: true });
    assert.equal(calls.playedMaps, 0, "mania-tracker is not asked: there is no tracker player");
    // the fixture's window has this one chart: hidden, nothing is left
    assert.deepEqual(plain.cards.map((c) => c.beatmapId), [playedId]);
    assert.deepEqual(hidden.cards.map((c) => c.beatmapId), [], "the map played in Interlude is hidden");
    // not hidden when not asked: the card is there, marked played
    const shown = await rec.start({ ...REQ, hidePlayed: false });
    assert.ok(shown.cards.find((c) => c.beatmapId === playedId)?.played, "the map played in Interlude is marked");
    // the plan asks the recommender's played maps (tracker plays + Interlude's) for a hand-set profile without a player
    const PLAN = { size: 5, patternIds: ["jumpstream"], lengthId: "any", rankedOnly: false, manual: true, manualDan: null, manualSkill: manualSkill(MINE) };
    const planWith = (played) => {
        const r = createRecommender({ api: fakeTracker().api, extraPlayed: async () => played });
        const recommender = { currentPlayer: () => null, playedMaps: () => r.playedMaps() };
        return createPlanner({ api: fakeTracker().api, recommender, pages: 1 }).build(PLAN);
    };
    const before = await planWith(new Map());
    const inPlan = before.slots.find((s) => s.card)?.card;
    assert.ok(inPlan, "the plan has a card to leave out");
    const after = await planWith(new Map([[inPlan.beatmapId, { beatmapsetId: inPlan.beatmapsetId, accuracy: null, rate: null, interlude: true }]]));
    assert.ok(!after.slots.some((s) => s.card?.beatmapId === inPlan.beatmapId), "the plan leaves out the map played in Interlude");
});

function ipcSetup() {
    const starts = [];
    const builds = [];
    const handlers = createRecommendHandlers({
        recommender: { start: async (req) => { starts.push(req); return { target: { lo: 1, hi: 2 }, cards: [], more: false, total: 0 }; } },
        planner: { build: async (req) => { builds.push(req); return { header: {}, slots: [], totalSec: 0 }; } },
        analyze: async () => ({}), fetchText: async () => "", openExternal: async () => {}, fetchProfile: async () => null,
    });
    return { handlers, starts, builds };
}
const START = { manual: true, manualDan: null, patternId: "tech", goalId: "growth", lengthId: "any", rankedOnly: false, hidePlayed: false };

test("main: the hand-set profile in a picks or plan request becomes its skill; a broken one is refused", async () => {
    setLang("ru");
    const { handlers, starts, builds } = ipcSetup();
    assert.equal((await handlers.start({ ...START, manualProfile: MINE })).ok, true);
    assert.deepEqual(starts[0].manualSkill, manualSkill(MINE));
    assert.equal(starts[0].manualDan, null);
    // the custom range takes it too
    await handlers.start({ ...START, goalId: "custom", range: { from: 13, to: 14 }, manualProfile: MINE });
    assert.deepEqual(starts[1].manualSkill.tiles, manualSkill(MINE).tiles);
    // not in tracker mode
    await handlers.start({ ...START, manual: false, manualProfile: MINE });
    assert.equal("manualSkill" in starts[2], false);
    const bad = await handlers.start({ ...START, manualProfile: { ...MINE, jack: 99 } });
    assert.deepEqual(bad, { ok: false, message: "ручной профиль не заполнен — выбери дан для Speed, Jack, Stamina и Tech во вкладке «Подбор»" });
    assert.equal(starts.length, 3);

    const plan = await handlers.plan({ size: 5, patternIds: ["tech"], lengthId: "any", rankedOnly: false, manual: true, manualDan: null, manualProfile: MINE });
    assert.equal(plan.ok, true);
    assert.deepEqual(builds[0].manualSkill, manualSkill(MINE));
    assert.equal((await handlers.plan({ size: 5, patternIds: ["tech"], lengthId: "any", manual: true, manualProfile: "x" })).ok, false);
    assert.equal(builds.length, 1);
});

test("main: auto-marathon by profile takes the hand-set one without a loaded tracker profile", async () => {
    setLang("ru");
    const runs = [];
    let asked = 0;
    const handlers = createMarathonAutoHandlers({
        auto: { run: async (request) => { runs.push(request); return { entries: [], warnings: [] }; } },
        profile: { current: () => { asked += 1; return { ok: false }; } },
    });
    const req = { templateId: "dan", source: "profile", manualDan: null, patternIds: ["stream", "jumpstream"], skipPlayed: false, rankedOnly: false };
    const r = await handlers.start({ ...req, manualProfile: MINE });
    assert.equal(r.ok, true);
    assert.equal(r.finalDan, 14.2, "the first pattern's axis: Speed");
    assert.equal(asked, 0);
    assert.equal(runs[0].targets.at(-1), 14.2);
    assert.deepEqual(await handlers.start({ ...req, manualProfile: { speed: 14 } }), { ok: false, message: "ручной профиль не заполнен — выбери дан для Speed, Jack, Stamina и Tech во вкладке «Подбор»" });
    // without it, still main's tracker profile
    assert.equal((await handlers.start(req)).ok, false);
    assert.equal(asked, 1);
});

test("the main-process refusal in English", async () => {
    setLang("en");
    try {
        const { handlers } = ipcSetup();
        assert.equal((await handlers.start({ ...START, manualProfile: {} })).message, "the hand-set profile is incomplete — pick a dan for Speed, Jack, Stamina and Tech on the Picks tab");
    } finally {
        setLang("ru");
    }
});
