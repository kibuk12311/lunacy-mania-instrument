import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRecommender } from "../../src/recommend/recommend.js";
import { searchParams } from "../../src/recommend/rank.js";
import { setLang } from "../../src/i18n/i18n.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/mt/${name}.json`, import.meta.url), "utf8"));
const skillsJson = await fixture("skills");
const plays = await fixture("plays");
const search = await fixture("search");

const PLAYED_ID = 5813951; // in plays.json
const template = search.items[3]; // one-diff jumpstream set

// Default dans spread over the growth window of the stamina tile, [13.26, 13.76].
const spread = (i) => Math.round((13.3 + (i % 40) / 100) * 100) / 100;

// Every set is its own chart unless titleOf/lengthOf say otherwise.
function makeSet(i, dan, { titleOf = (n) => `Song ${n}`, lengthOf = () => template.diffs[0].length } = {}) {
    const diff = {
        ...template.diffs[0], beatmapId: i === 5 ? PLAYED_ID : 9000000 + i, beatmapsetId: 800000 + i, title: titleOf(i), length: lengthOf(i),
        version: `[4K] #${i}`, dan: { label: "", family: "dan", rawDan: dan }, playCount: 100000 - i, covers: null,
    };
    return { ...diff, diffs: [diff], diffCount: 1, covers: { list: `https://assets.ppy.sh/${i}.jpg`, card: "" } };
}

// failPages: search pages that fail the first time they are asked for; failAxes: played-map axes that fail first.
function fakeApi({ sets = 250, danOf = spread, skills = skillsJson, titleOf, lengthOf, failPages = [], failAxes = [] } = {}) {
    const calls = { findUser: [], skills: [], playedMaps: [], searchMaps: [] };
    const all = Array.from({ length: sets }, (_, i) => makeSet(i, danOf(i), { titleOf, lengthOf }));
    const failOnce = new Set(failPages);
    const axesFailing = new Set(failAxes);
    const played = new Map(plays.items.map((p) => [p.beatmapId, { beatmapsetId: p.beatmapsetId, accuracy: p.accuracy, rate: p.rate }]));
    const api = {
        async findUser(q) {
            calls.findUser.push(q);
            return q.toLowerCase() === "luna" ? { id: 777, username: "Luna", avatarUrl: "https://a.ppy.sh/777" } : null;
        },
        async skills(id) {
            calls.skills.push(id);
            return skills;
        },
        async playedMaps(id, axes) {
            calls.playedMaps.push([id, axes]);
            if (axes.some((axis) => axesFailing.delete(axis))) throw new Error("mania-tracker ответил 502");
            return played;
        },
        async searchMaps(params) {
            calls.searchMaps.push(params);
            if (failOnce.delete(params.page)) throw new Error("mania-tracker ответил 502");
            const from = params.page * params.pageSize;
            return { items: all.slice(from, from + params.pageSize), total: all.length, page: params.page, pageSize: params.pageSize };
        },
    };
    return { api, calls };
}

const REQ = { manual: false, manualDan: null, patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: false, hidePlayed: false };
const ALL_AXES = ["Stream", "Jumpstream", "Handstream", "Stamina", "Chordjack", "JackSpeed", "Technical", "Overall"];
const EACH_AXIS = ALL_AXES.map((axis) => [777, [axis]]);

test("loadPlayer finds the player and reads the skill", async () => {
    const { api, calls } = fakeApi();
    const rec = createRecommender({ api });
    const p = await rec.loadPlayer("Luna");
    assert.equal(p.id, 777);
    assert.equal(p.username, "Luna");
    assert.equal(p.avatarUrl, "https://a.ppy.sh/777");
    assert.equal(p.skill.ready, true);
    assert.equal(p.skill.tiles.stamina, 13.26);
    assert.deepEqual(calls.skills, [777]);
    await assert.rejects(rec.loadPlayer("nobody"), /не найден/);
});

test("the osu! account from tosu loads by its exact id, without a name search", async () => {
    const { api, calls } = fakeApi();
    const rec = createRecommender({ api });
    const p = await rec.loadPlayer("TestPlayer", { id: 1234567, name: "TestPlayer" });
    assert.equal(p.id, 1234567);
    assert.equal(p.username, "TestPlayer");
    assert.deepEqual(calls.findUser, []);
    assert.deepEqual(calls.skills, [1234567]);
});

test("a failed reload keeps the loaded player", async () => {
    const { api } = fakeApi({ sets: 30 });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    await assert.rejects(rec.loadPlayer("nobody"), /не найден/);
    const r = await rec.start(REQ);
    assert.equal(r.target.playerDan, 13.26);
    // manual mode still marks the kept player's plays
    const manual = await rec.start({ ...REQ, manual: true, manualDan: 13.5, goalId: "comfort" });
    assert.ok(manual.cards.some((c) => c.beatmapId === PLAYED_ID && c.played));
});

test("a player without a ready skill is refused and not kept", async () => {
    const { api } = fakeApi({ skills: { status: "pending", modes: [], tracked: false } });
    const rec = createRecommender({ api });
    await assert.rejects(rec.loadPlayer("luna"), /mania-tracker/);
    await assert.rejects(rec.start(REQ), { message: "сначала загрузи профиль с mania-tracker" });
});

test("start needs a player unless the dan is manual", async () => {
    const { api } = fakeApi();
    const rec = createRecommender({ api });
    await assert.rejects(rec.start(REQ), { message: "сначала загрузи профиль с mania-tracker" });
    await assert.rejects(rec.more(), /сначала подбери карты/);
    await assert.rejects(rec.start({ ...REQ, manual: true, manualDan: null }), /дан/);
});

test("pages through the pool and fetches more search pages only when it runs out", async () => {
    const { api, calls } = fakeApi({ sets: 250 });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    const first = await rec.start(REQ);
    assert.equal(first.target.playerDan, 13.26);
    assert.equal(first.target.lo, 13.26);
    assert.equal(first.target.hi, 13.76);
    assert.equal(first.cards.length, 20);
    assert.equal(first.more, true);
    assert.equal(first.total, 250);
    assert.deepEqual(calls.playedMaps, EACH_AXIS);
    assert.deepEqual(calls.searchMaps.map((p) => p.page), [0, 1, 2, 3]);
    for (const p of calls.searchMaps) {
        assert.equal(p.patterns, "jumpstream");
        assert.equal(p.pageSize, 48);
        assert.deepEqual([p.danMin, p.danMinStep, p.danMax, p.danMaxStep], [13, 1, 14, -1]);
    }
    for (let i = 1; i < first.cards.length; i++) assert.ok(first.cards[i - 1].score >= first.cards[i].score);

    const seen = new Set(first.cards.map((c) => c.beatmapsetId));
    // 192 sets in the first pool: eight more pages come from it without new requests
    for (let i = 0; i < 8; i++) {
        const r = await rec.more();
        assert.equal(r.cards.length, 20);
        assert.equal(r.more, true);
        r.cards.forEach((c) => seen.add(c.beatmapsetId));
    }
    assert.equal(calls.searchMaps.length, 4);
    assert.equal(seen.size, 180);

    // 12 left in the pool: the next page pulls the remaining server pages
    const ninth = await rec.more();
    assert.equal(ninth.cards.length, 20);
    assert.deepEqual(calls.searchMaps.map((p) => p.page), [0, 1, 2, 3, 4, 5]);
    ninth.cards.forEach((c) => seen.add(c.beatmapsetId));

    const tail = [await rec.more(), await rec.more(), await rec.more()];
    assert.deepEqual(tail.map((r) => r.cards.length), [20, 20, 10]);
    assert.deepEqual(tail.map((r) => r.more), [true, true, false]);
    tail.forEach((r) => r.cards.forEach((c) => seen.add(c.beatmapsetId)));
    assert.equal(seen.size, 250);
    assert.deepEqual(await rec.more(), { cards: [], more: false });
    assert.equal(calls.searchMaps.length, 6);
});

test("keeps fetching while the first pool has too few cards", async () => {
    const { api, calls } = fakeApi({ sets: 250, danOf: (i) => (i < 192 ? 10 : 13.5) });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    const r = await rec.start(REQ);
    assert.equal(r.cards.length, 20);
    assert.equal(calls.searchMaps.length, 6);
    assert.ok(r.cards.every((c) => c.dan === 13.5));
});

test("a failed search page during «Ещё» is fetched again, so no set is skipped", async () => {
    // 600: a full batch fails; 380: the failed batch also holds the last, partial page
    for (const sets of [600, 380]) {
        const { api } = fakeApi({ sets, failPages: [5] });
        const rec = createRecommender({ api });
        await rec.loadPlayer("luna");
        const first = await rec.start(REQ);
        const seen = new Set(first.cards.map((c) => c.beatmapsetId));
        let failures = 0;
        for (let i = 0; i < 100; i++) {
            let r;
            try {
                r = await rec.more();
            } catch (error) {
                assert.equal(error.message, "mania-tracker ответил 502");
                failures++;
                continue;
            }
            r.cards.forEach((c) => seen.add(c.beatmapsetId));
            if (!r.more) break;
        }
        assert.equal(failures, 1, `${sets}`);
        assert.equal(seen.size, sets, `${sets}`);
    }
});

test("re-uploads of the same chart in other sets show once", async () => {
    // sets 196…199 repeat the charts of sets 0…3; 199 is a longer edit of the same song, so it stays
    const { api } = fakeApi({
        sets: 200, danOf: (i) => spread(i % 196), titleOf: (i) => `Song ${i % 196}`, lengthOf: (i) => (i === 199 ? 300 : 143),
    });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    let r = await rec.start(REQ);
    const cards = [...r.cards];
    while (r.more) {
        r = await rec.more();
        cards.push(...r.cards);
    }
    assert.equal(cards.length, 197);
    assert.equal(new Set(cards.map((c) => `${c.title}@${c.lengthSec}`)).size, 197);
});

test("played maps are hidden or marked, and fetched once per player load", async () => {
    const { api, calls } = fakeApi({ sets: 30 });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");

    const hidden = await rec.start({ ...REQ, hidePlayed: true });
    assert.equal(hidden.cards.length, 20);
    const rest = await rec.more();
    assert.equal(rest.more, false);
    const all = [...hidden.cards, ...rest.cards];
    assert.equal(all.length, 29);
    assert.ok(!all.some((c) => c.beatmapId === PLAYED_ID));

    const shown = await rec.start({ ...REQ, hidePlayed: false });
    const pool = [...shown.cards, ...(await rec.more()).cards];
    const mine = pool.find((c) => c.beatmapId === PLAYED_ID);
    assert.deepEqual(mine.played, { accuracy: plays.items[0].accuracy, rate: 1 });
    assert.equal(pool.length, 30);
    // every axis: a weak play of a map near your level can miss its own axis's top 200
    assert.deepEqual(calls.playedMaps, EACH_AXIS);

    await rec.start({ ...REQ, patternId: "stream" });
    assert.equal(calls.playedMaps.length, 8);

    // a reload brings in plays made since
    await rec.loadPlayer("luna");
    await rec.start(REQ);
    assert.equal(calls.playedMaps.length, 16);
});

test("a failed fetch of played maps is not cached", async () => {
    const { api, calls } = fakeApi({ sets: 30, failAxes: ALL_AXES });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    await assert.rejects(rec.start(REQ), { message: "mania-tracker ответил 502" });
    const r = await rec.start(REQ);
    assert.equal(r.cards.length, 20);
    assert.equal(r.playedPartial, false);
    assert.equal(calls.playedMaps.length, 16);
});

test("one failed axis of played maps still recommends, and only that axis is asked again", async () => {
    const { api, calls } = fakeApi({ sets: 30, failAxes: ["Technical"] });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    const first = await rec.start({ ...REQ, hidePlayed: true });
    assert.equal(first.cards.length, 20);
    assert.equal(first.playedPartial, true);
    assert.equal(calls.playedMaps.length, 8);
    // the axes that arrived still hide their plays
    const all = [...first.cards, ...(await rec.more()).cards];
    assert.equal(all.length, 29);
    assert.ok(!all.some((c) => c.beatmapId === PLAYED_ID));

    const again = await rec.start(REQ);
    assert.equal(again.playedPartial, false);
    assert.deepEqual(calls.playedMaps.slice(8), [[777, ["Technical"]]]);
});

test("manual mode with a loaded profile: hiding played maps needs them, marking does not", async () => {
    const MANUAL = { ...REQ, manual: true, manualDan: 13.5, goalId: "comfort" };
    const { api } = fakeApi({ sets: 30, failAxes: ALL_AXES });
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    await assert.rejects(rec.start({ ...MANUAL, hidePlayed: true }), { message: "mania-tracker ответил 502" });

    const { api: api2 } = fakeApi({ sets: 30, failAxes: ALL_AXES });
    const rec2 = createRecommender({ api: api2 });
    await rec2.loadPlayer("luna");
    const r = await rec2.start({ ...MANUAL, hidePlayed: false });
    assert.ok(r.cards.length > 0);
    assert.equal(r.playedPartial, true);
});

test("a played chart re-uploaded in another set keeps its mark, or is hidden with it", async () => {
    // set 6 is a re-upload of set 5 (played), a little less popular
    const opts = { sets: 30, titleOf: (i) => `Song ${i === 6 ? 5 : i}`, danOf: (i) => spread(i === 6 ? 5 : i) };
    const { api } = fakeApi(opts);
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    const shown = await rec.start({ ...REQ, hidePlayed: false });
    const pool = [...shown.cards, ...(await rec.more()).cards];
    const song5 = pool.filter((c) => c.title === "Song 5");
    assert.equal(song5.length, 1);
    assert.deepEqual(song5[0].played, { accuracy: plays.items[0].accuracy, rate: 1 });

    const hidden = await rec.start({ ...REQ, hidePlayed: true });
    const rest = [...hidden.cards, ...(await rec.more()).cards];
    assert.ok(!rest.some((c) => c.title === "Song 5"));
    assert.equal(rest.length, 28);
});

test("a player mania-tracker does not track is told so, not that they have no 4K plays", async () => {
    const { api } = fakeApi({ skills: { status: "ready", totalPlays: 0, modes: [], tracked: false } });
    const rec = createRecommender({ api });
    await assert.rejects(rec.loadPlayer("luna"), /mania-tracker ещё не отслеживает Luna/);
    const { api: tracked } = fakeApi({ skills: { ...skillsJson, modes: [] } });
    await assert.rejects(createRecommender({ api: tracked }).loadPlayer("luna"), /у Luna нет 4K игр/);
});

test("manual mode works without a player", async () => {
    const { api, calls } = fakeApi({ sets: 30 });
    const rec = createRecommender({ api, pageSize: 5 });
    const r = await rec.start({ manual: true, manualDan: 13.5, patternId: "jumpstream", goalId: "comfort", lengthId: "short", rankedOnly: true, hidePlayed: true });
    assert.equal(r.target.source, "manual");
    assert.equal(r.target.lo, 12.9);
    assert.equal(r.target.hi, 13.4);
    assert.equal(r.target.msdTarget, null);
    assert.equal(r.cards.length, 5);
    assert.equal(r.more, true);
    assert.equal(r.total, 30);
    assert.equal(calls.playedMaps.length, 0);
    assert.equal(calls.searchMaps[0].statuses, "ranked,loved");
    assert.equal(calls.searchMaps[0].lenMax, 150);
    const more = [await rec.more(), await rec.more()];
    // dans 13.30 … 13.40 are inside [12.9, 13.4]: eleven sets
    assert.deepEqual(more.map((x) => x.cards.length), [5, 1]);
    assert.equal(more[1].more, false);
    assert.ok([...r.cards, ...more[0].cards, ...more[1].cards].every((c) => c.dan >= 12.9 && c.dan <= 13.4 && c.played === null));
});

test("search errors reach the caller", async () => {
    const { api } = fakeApi();
    api.searchMaps = async () => { throw new Error("mania-tracker ответил 502"); };
    const rec = createRecommender({ api });
    await rec.loadPlayer("luna");
    await assert.rejects(rec.start(REQ), { message: "mania-tracker ответил 502" });
});

test("in English the recommender explains itself in English", async () => {
    const { api } = fakeApi();
    const rec = createRecommender({ api });
    const { api: untracked } = fakeApi({ skills: { status: "ready", totalPlays: 0, modes: [], tracked: false } });
    const { api: no4k } = fakeApi({ skills: { ...skillsJson, modes: [] } });
    const { api: pending } = fakeApi({ skills: { status: "pending", modes: [] } });
    setLang("en");
    try {
        await assert.rejects(rec.loadPlayer("nobody"), { message: "player not found on mania-tracker" });
        await assert.rejects(rec.start(REQ), { message: "load your mania-tracker profile first" });
        await assert.rejects(rec.more(), { message: "find your picks first" });
        await assert.rejects(rec.start({ ...REQ, manual: true, manualDan: null }), { message: "set your dan manually" });
        await assert.rejects(rec.start({ ...REQ, patternId: "ln" }), { message: "unknown pattern" });
        await assert.rejects(createRecommender({ api: untracked }).loadPlayer("luna"),
            { message: "mania-tracker isn't tracking Luna yet — open their profile on mania-tracker.com and try again later" });
        await assert.rejects(createRecommender({ api: no4k }).loadPlayer("luna"), { message: "Luna has no 4K plays on mania-tracker" });
        await assert.rejects(createRecommender({ api: pending }).loadPlayer("luna"),
            { message: "mania-tracker hasn't worked out Luna's skill yet — open the profile on mania-tracker.com and try again later" });
        const { cards } = await rec.start({ ...REQ, manual: true, manualDan: 13.5 });
        assert.ok(cards.length > 0);
        assert.ok(cards.every((c) => ["pure", "mostly", "mixed"].includes(c.purityLabel)));
    } finally {
        setLang("ru");
    }
});

test("currentPlayer: null before a load, the loaded player after, kept through a failed load", async () => {
    const { api } = fakeApi({ sets: 10 });
    const rec = createRecommender({ api });
    assert.equal(rec.currentPlayer(), null);
    await rec.loadPlayer("luna");
    const p = rec.currentPlayer();
    assert.deepEqual([p.id, p.username, p.avatarUrl], [777, "Luna", "https://a.ppy.sh/777"]);
    assert.equal(p.skill.tiles.stamina, 13.26);
    assert.deepEqual(Object.keys(p).sort(), ["avatarUrl", "id", "skill", "username"]);
    await assert.rejects(rec.loadPlayer("nobody"));
    assert.equal(rec.currentPlayer().id, 777);
});

test("playedMaps: the current player's plays over every axis, none without a player", async () => {
    const { api, calls } = fakeApi({ sets: 10 });
    const rec = createRecommender({ api });
    const empty = await rec.playedMaps();
    assert.ok(empty.played instanceof Map);
    assert.equal(empty.played.size, 0);
    assert.equal(empty.partial, false);
    assert.equal(calls.playedMaps.length, 0);

    await rec.loadPlayer("luna");
    const r = await rec.playedMaps();
    assert.equal(r.partial, false);
    assert.ok(r.played.has(PLAYED_ID));
    assert.deepEqual(calls.playedMaps, EACH_AXIS);
    await rec.playedMaps();
    assert.equal(calls.playedMaps.length, EACH_AXIS.length, "kept from the first call");
});

test("titleKey and sameChart are shared: one key per song, re-uploads within the tolerances", async () => {
    const { titleKey, sameChart } = await import("../../src/recommend/recommend.js");
    assert.equal(titleKey("Time to Say Goodbye (Cut Ver.) [4K]"), "timetosaygoodbye");
    assert.equal(titleKey("Мира!"), "мира");
    assert.equal(titleKey(null), "");
    // artist and title together key a song
    assert.equal(titleKey("Jeff Williams", "Time to Say Goodbye"), "jeffwilliamstimetosaygoodbye");
    assert.equal(sameChart({ dan: 13, msd: 30, lengthSec: 120 }, { dan: 13.05, msd: 30.3, lengthSec: 122 }), true);
    assert.equal(sameChart({ dan: 13, msd: 30, lengthSec: 120 }, { dan: 13.1, msd: 30, lengthSec: 120 }), false);
    assert.equal(sameChart({ dan: 13, msd: null, lengthSec: 120 }, { dan: 13, msd: null, lengthSec: 120 }), true);
    assert.equal(sameChart({ dan: 13, msd: null, lengthSec: 120 }, { dan: 13, msd: 30, lengthSec: 120 }), false);
});

test("a custom range: with a profile its plays still count, the window is the range's band and «Ещё» pages through it", async () => {
    const { api, calls } = fakeApi({ sets: 40 });
    const rec = createRecommender({ api, pageSize: 5 });
    await rec.loadPlayer("Luna");
    // one picked step (13.4) is the band 13.3 … 13.5
    const r = await rec.start({ ...REQ, goalId: "custom", range: { from: 13.4, to: 13.4 } });
    assert.equal(r.target.goalId, "custom");
    assert.equal(r.target.source, "tile");
    assert.equal(r.target.lo, 13.3);
    assert.equal(r.target.hi, 13.5);
    assert.equal(r.target.msdTarget, null);
    assert.equal(calls.playedMaps.length, ALL_AXES.length);
    // the server is asked for the band itself
    assert.deepEqual(calls.searchMaps[0], searchParams({ patternId: "jumpstream", lo: 13.3, hi: 13.5, lengthId: "any", rankedOnly: false, page: 0 }));
    const cards = [...r.cards];
    for (let more = r.more; more;) {
        const next = await rec.more();
        cards.push(...next.cards);
        more = next.more;
    }
    // dans 13.30 … 13.50: twenty-one sets
    assert.equal(cards.length, 21);
    assert.ok(cards.every((c) => c.dan >= 13.3 && c.dan <= 13.5), cards.map((c) => c.dan).join(" "));
    assert.ok(cards.some((c) => c.played));
});

test("a custom range in manual mode needs no dan; without a range it is refused", async () => {
    const { api, calls } = fakeApi({ sets: 40 });
    const rec = createRecommender({ api, pageSize: 50 });
    const r = await rec.start({ ...REQ, manual: true, manualDan: null, goalId: "custom", range: { from: 13.6, to: 13.4 } });
    assert.equal(r.target.source, "range");
    assert.equal(r.target.lo, 13.3);
    assert.equal(r.target.hi, 13.7);
    assert.equal(r.target.center, 13.5);
    assert.equal(calls.playedMaps.length, 0);
    assert.equal(r.cards.length, 40);
    assert.ok(r.cards.every((c) => c.dan >= 13.3 && c.dan <= 13.7));
    await assert.rejects(rec.start({ ...REQ, manual: true, manualDan: null, goalId: "custom" }), /диапазон/);
    // without a profile the tracker mode still needs one
    await assert.rejects(rec.start({ ...REQ, goalId: "custom", range: { from: 13, to: 14 } }), /профиль|ник/i);
});

test("inside a custom range no dan is preferred: the cards rank by purity and popularity, not by the distance to the middle", async () => {
    const { api } = fakeApi({ sets: 40 });
    const rec = createRecommender({ api, pageSize: 5 });
    // the same sets: dans rise as play counts fall
    const range = await rec.start({ ...REQ, manual: true, goalId: "custom", range: { from: 13.4, to: 13.6 } });
    assert.deepEqual(range.cards.map((c) => c.dan), [13.3, 13.31, 13.32, 13.33, 13.34]);
    assert.equal(range.target.halfWidth, 0.2);
    // a goal keeps preferring its window's middle
    const growth = await rec.start({ ...REQ, manual: true, manualDan: 13.26, goalId: "growth" });
    assert.ok(growth.cards.every((c) => Math.abs(c.dan - growth.target.center) < 0.1), growth.cards.map((c) => c.dan).join(" "));
});
