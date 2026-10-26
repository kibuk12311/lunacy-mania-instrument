import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProfileService, registerProfileIpc, normalizeProfileRecord } from "../app/profileService.js";
import { createJsonStore } from "../app/jsonStore.js";

const SKILL = { ready: true, overall: 13.4, overallLabel: "Gamma mid/high", tiles: { speed: 14, stamina: 13.26, tech: null, jack: 13 }, msd: {} };
const flush = () => new Promise((r) => setImmediate(r));

// Recommender fake: loadPlayer resolves by hand when `gate` is set, fails for names in `bad`.
function fakeRecommender({ bad = [] } = {}) {
    const r = {
        player: null,
        loads: [],
        gate: null,
        currentPlayer: () => r.player,
        async loadPlayer(query, known = null) {
            r.loads.push([query, known]);
            if (r.gate) await r.gate;
            if (bad.includes(query)) throw new Error("игрок не найден");
            const p = { id: known?.id ?? 777, username: known?.name ?? query, avatarUrl: null, skill: SKILL };
            r.player = p;
            return p;
        },
    };
    return r;
}

function memoryStore(value = null) {
    const s = { value, sets: 0, get: async () => s.value, set: async (v) => { s.sets += 1; s.value = normalizeProfileRecord(v); return s.value; } };
    return s;
}

function setup({ saved = null, bad } = {}) {
    const recommender = fakeRecommender({ bad });
    const store = memoryStore(saved);
    const sent = [];
    const clock = { now: 0 };
    const profile = createProfileService({ recommender, store, send: (channel, payload) => sent.push([channel, payload]), now: () => clock.now });
    return { recommender, store, sent, clock, profile };
}

test("current: nothing before a player is loaded, the player after", async () => {
    const { recommender, profile } = setup();
    assert.deepEqual(profile.current(), { ok: false });
    recommender.player = { id: 5, username: "Мира", avatarUrl: "https://a.ppy.sh/5", skill: SKILL };
    assert.deepEqual(profile.current(), { ok: true, player: { id: 5, username: "Мира", avatarUrl: "https://a.ppy.sh/5" }, skill: SKILL });
});

test("remember saves the query and the player and tells the window", async () => {
    const { store, sent, profile } = setup();
    await profile.remember("  Luna ", { id: 777, username: "Luna", avatarUrl: "https://a.ppy.sh/777", skill: SKILL, extra: 1 });
    assert.deepEqual(store.value, { query: "Luna", id: 777, username: "Luna" });
    assert.deepEqual(sent, [["profile-changed", { player: { id: 777, username: "Luna", avatarUrl: "https://a.ppy.sh/777" }, skill: SKILL }]]);
});

test("ensure with a player already loaded loads nothing", async () => {
    const { recommender, profile } = setup({ saved: { query: "x", id: 1, username: "x" } });
    recommender.player = { id: 5, username: "Мира", avatarUrl: null, skill: SKILL };
    const r = await profile.ensure({ query: "other" });
    assert.equal(r.ok, true);
    assert.equal(r.player.username, "Мира");
    assert.deepEqual(recommender.loads, []);
});

test("ensure loads the saved player by its exact id first", async () => {
    const { recommender, store, sent, profile } = setup({ saved: { query: "testplayer", id: 1234567, username: "TestPlayer" } });
    const r = await profile.ensure({ query: "someone else" });
    assert.deepEqual(recommender.loads, [["TestPlayer", { id: 1234567, name: "TestPlayer" }]]);
    assert.deepEqual(r, { ok: true, player: { id: 1234567, username: "TestPlayer", avatarUrl: null }, skill: SKILL });
    assert.deepEqual(store.value, { query: "testplayer", id: 1234567, username: "TestPlayer" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "profile-changed");
});

test("ensure with only a hint searches it; with nothing it answers none", async () => {
    const hinted = setup();
    const r = await hinted.profile.ensure({ query: " Luna " });
    assert.deepEqual(hinted.recommender.loads, [["Luna", null]]);
    assert.equal(r.ok, true);
    assert.deepEqual(hinted.store.value, { query: "Luna", id: 777, username: "Luna" });

    const none = setup();
    assert.deepEqual(await none.profile.ensure(), { ok: false, reason: "none" });
    assert.deepEqual(await none.profile.ensure({ query: "   " }), { ok: false, reason: "none" });
    assert.deepEqual(none.recommender.loads, []);
});

test("a failed load is answered again for 60 s without a request, then tried anew", async () => {
    const { recommender, clock, sent, profile } = setup({ bad: ["ghost"] });
    const first = await profile.ensure({ query: "ghost" });
    assert.deepEqual(first, { ok: false, reason: "failed", message: "игрок не найден" });
    clock.now = 59_999;
    assert.deepEqual(await profile.ensure({ query: "ghost" }), first);
    assert.equal(recommender.loads.length, 1);
    clock.now = 60_000;
    await profile.ensure({ query: "ghost" });
    assert.equal(recommender.loads.length, 2);
    assert.equal(sent.length, 0);
});

test("a successful load elsewhere clears a remembered failure", async () => {
    const { recommender, profile } = setup({ bad: ["ghost"] });
    await profile.ensure({ query: "ghost" });
    await profile.remember("Luna", { id: 777, username: "Luna", avatarUrl: null, skill: SKILL });
    recommender.player = null; // say the recommender lost it: the saved record loads again at once
    assert.equal((await profile.ensure({ query: "ghost" })).ok, true);
    assert.deepEqual(recommender.loads.at(-1), ["Luna", { id: 777, name: "Luna" }]);
});

test("two ensures at once share one load", async () => {
    const { recommender, profile } = setup();
    let open;
    recommender.gate = new Promise((r) => { open = r; });
    const a = profile.ensure({ query: "Luna" });
    const b = profile.ensure({ query: "Luna" });
    await flush();
    open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(recommender.loads.length, 1);
    assert.deepEqual(ra, rb);
});

test("a query that is not a string is ignored, a long one is cut to 64", async () => {
    const odd = setup();
    for (const query of [42, { a: 1 }, ["x"], null]) assert.deepEqual(await odd.profile.ensure({ query }), { ok: false, reason: "none" });
    assert.deepEqual(odd.recommender.loads, []);
    const long = setup();
    await long.profile.ensure({ query: "x".repeat(100) });
    assert.equal(long.recommender.loads[0][0], "x".repeat(64));
});

test("the saved record survives a restart in userData/profile.json", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "профиль-"));
    const file = path.join(dir, "profile.json");
    const make = () => createJsonStore({ file, normalize: normalizeProfileRecord, fallback: null });
    const first = createProfileService({ recommender: fakeRecommender(), store: make(), send: () => {} });
    await first.remember("Мира", { id: 9, username: "Мира", avatarUrl: null, skill: SKILL });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { query: "Мира", id: 9, username: "Мира" });
    const recommender = fakeRecommender();
    const second = createProfileService({ recommender, store: make(), send: () => {} });
    assert.equal((await second.ensure()).ok, true);
    assert.deepEqual(recommender.loads, [["Мира", { id: 9, name: "Мира" }]]);
});

test("normalizeProfileRecord keeps only a record with a real id", () => {
    assert.equal(normalizeProfileRecord(null), null);
    assert.equal(normalizeProfileRecord({ id: -1, username: "x" }), null);
    assert.equal(normalizeProfileRecord({ id: "12", username: "x" }), null);
    assert.deepEqual(normalizeProfileRecord({ id: 12, username: "", query: 5 }), { query: "", id: 12, username: "12" });
    assert.deepEqual(normalizeProfileRecord({ id: 12, username: "y".repeat(80), query: " q " }), { query: "q", id: 12, username: "y".repeat(64) });
});

test("registerProfileIpc answers profile-get and profile-ensure and never throws", async () => {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on() {} };
    const calls = [];
    const profile = {
        current: () => ({ ok: false }),
        ensure: async (req) => { calls.push(req); throw new Error("boom"); },
    };
    registerProfileIpc({ ipcMain, profile, log: () => {} });
    assert.deepEqual([...handlers.keys()], ["profile-get", "profile-ensure"]);
    assert.deepEqual(await handlers.get("profile-get")({}), { ok: false });
    const r = await handlers.get("profile-ensure")({}, { query: "Luna", junk: 1 });
    assert.deepEqual(calls, [{ query: "Luna" }]);
    assert.deepEqual(r, { ok: false, reason: "failed", message: "boom" });
    assert.deepEqual(await handlers.get("profile-ensure")({}, undefined).then(() => calls.at(-1)), { query: undefined });
});
