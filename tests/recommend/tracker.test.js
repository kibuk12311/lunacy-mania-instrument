import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTrackerApi } from "../../src/recommend/tracker.js";
import { setLang } from "../../src/i18n/i18n.js";

const plays = JSON.parse(await readFile(new URL("../fixtures/mt/plays.json", import.meta.url), "utf8"));
const search = JSON.parse(await readFile(new URL("../fixtures/mt/search.json", import.meta.url), "utf8"));

// Fake fetch: route(url) → body (or a Response), every call is recorded.
function fakeFetch(route) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: new URL(url), init });
        const out = await route(new URL(url));
        return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
    };
    return { calls, fetchImpl };
}

const USERS = {
    users: [
        { id: 1, username: "TestPlayerFan", avatarUrl: "https://a.ppy.sh/1" },
        { id: 2, username: "testplayer", avatarUrl: "https://a.ppy.sh/2" },
    ],
};

test("findUser prefers an exact case-insensitive name and sends json + timeout", async () => {
    const { calls, fetchImpl } = fakeFetch(() => USERS);
    const api = createTrackerApi({ fetchImpl, base: "https://mt.test" });
    assert.deepEqual(await api.findUser("  TESTPLAYER "), { id: 2, username: "testplayer", avatarUrl: "https://a.ppy.sh/2" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://mt.test/api/users/search");
    assert.equal(calls[0].url.searchParams.get("q"), "TESTPLAYER");
    assert.equal(calls[0].init.headers.accept, "application/json");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("findUser falls back to the first result, an id for digits, null for nothing", async () => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.searchParams.get("q") === "lun" ? USERS : { users: [] }));
    const api = createTrackerApi({ fetchImpl });
    assert.equal((await api.findUser("lun")).id, 1);
    assert.equal(calls[0].url.origin, "https://api.mania-tracker.com");
    assert.deepEqual(await api.findUser("11765280"), { id: 11765280, username: "11765280", avatarUrl: null });
    assert.equal(await api.findUser("никого"), null);
    const before = calls.length;
    assert.equal(await api.findUser("   "), null);
    assert.equal(calls.length, before, "an empty query is not sent");
});

test("skills reads the profile skills", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: "ready", modes: [] }));
    const api = createTrackerApi({ fetchImpl });
    assert.equal((await api.skills(777)).status, "ready");
    assert.equal(calls[0].url.pathname, "/api/profiles/777/skills");
});

test("playedMaps merges every axis with rejected plays and keeps the best accuracy", async () => {
    const overall = {
        items: [{ beatmapId: 5813951, beatmapsetId: 2600727, accuracy: 0.99, rate: 1.1 }],
        rejected: [
            { beatmapId: 4840398, beatmapsetId: 2262542, accuracy: 0.5, rate: 1 },
            { beatmapId: 111, beatmapsetId: 222, accuracy: 0.9, rate: 1.2 },
        ],
    };
    const { calls, fetchImpl } = fakeFetch((url) => (url.searchParams.get("axis") === "Overall" ? overall : plays));
    const api = createTrackerApi({ fetchImpl });
    const played = await api.playedMaps(777, ["Jumpstream", "Overall"]);
    assert.ok(played instanceof Map);
    assert.equal(played.size, plays.items.length + 1);
    // the Overall page's best play has no date; the axis page's played-at day is kept
    assert.deepEqual(played.get(5813951), { beatmapsetId: 2600727, accuracy: 0.99, rate: 1.1, playedAt: null });
    assert.equal(played.get(4840398).playedAt, Date.parse(plays.items.find((p) => p.beatmapId === 4840398).playedAt));
    assert.equal(played.get(4840398).accuracy, plays.items.find((p) => p.beatmapId === 4840398).accuracy);
    assert.deepEqual(played.get(111), { beatmapsetId: 222, accuracy: 0.9, rate: 1.2, playedAt: null });
    assert.equal(played.get(4242937).rate, 1.5);
    assert.equal(calls.length, 2);
    for (const { url } of calls) {
        assert.equal(url.pathname, "/api/profiles/777/skill-plays");
        assert.deepEqual([...url.searchParams.keys()], ["keys", "axis", "limit", "offset", "rejected"]);
        assert.equal(url.searchParams.get("keys"), "4");
        assert.equal(url.searchParams.get("limit"), "200");
        assert.equal(url.searchParams.get("offset"), "0");
        assert.equal(url.searchParams.get("rejected"), "1");
    }
    assert.deepEqual(calls.map((c) => c.url.searchParams.get("axis")).sort(), ["Jumpstream", "Overall"]);
});

test("searchMaps sends the params in order and returns the page", async () => {
    const { calls, fetchImpl } = fakeFetch(() => search);
    const api = createTrackerApi({ fetchImpl });
    const res = await api.searchMaps({ sort: "playcount", page: 1, pageSize: 48, keys: "4k", lenMin: undefined, statuses: null, danMin: 13 });
    assert.equal(calls[0].url.pathname, "/api/snapshots/maps-search");
    assert.equal(calls[0].url.search, "?sort=playcount&page=1&pageSize=48&keys=4k&danMin=13");
    assert.equal(res.items.length, search.items.length);
    assert.equal(res.total, 2940);
    assert.equal(res.page, 1);
    assert.equal(res.pageSize, 5);
});

test("searchMaps survives a body without items", async () => {
    const { fetchImpl } = fakeFetch(() => ({}));
    const res = await createTrackerApi({ fetchImpl }).searchMaps({ page: 0 });
    assert.deepEqual(res.items, []);
    assert.equal(res.total, 0);
});

test("network failures, timeouts and HTTP errors are reported in Russian", async () => {
    const down = createTrackerApi({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(down.skills(1), { message: "mania-tracker не отвечает — проверь интернет" });

    const hanging = createTrackerApi({
        timeoutMs: 30,
        fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    await assert.rejects(hanging.findUser("x"), { message: "mania-tracker не отвечает — проверь интернет" });

    const { fetchImpl } = fakeFetch(() => new Response("nope", { status: 503 }));
    await assert.rejects(createTrackerApi({ fetchImpl }).searchMaps({}), { message: "mania-tracker ответил 503" });
});

const limited = (headers, body = "") => async () => new Response(body, { status: 429, headers });

test("a 429 waits as long as the server asks and tries once more", async () => {
    let n = 0;
    const waits = [];
    const fetchImpl = async (url) => (++n === 1
        ? limited({ "retry-after": "5" }, JSON.stringify({ error: "rate_limited", retryAfterMs: 4264 }))(url)
        : new Response(JSON.stringify({ status: "ready", modes: [] }), { status: 200 }));
    const api = createTrackerApi({ fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    assert.equal((await api.skills(1)).status, "ready");
    assert.deepEqual(waits, [5000]);
    assert.equal(n, 2);
});

test("a 429 that stays, or asks for a long wait, tells the player to wait", async () => {
    const waits = [];
    const again = createTrackerApi({ fetchImpl: limited({ "retry-after": "5" }), sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(again.searchMaps({}), { message: "mania-tracker просит подождать 5 с — слишком много запросов подряд" });
    assert.deepEqual(waits, [5000]);

    let n = 0;
    const long = createTrackerApi({
        fetchImpl: async (url) => { n++; return limited({ "retry-after": "20" })(url); },
        sleep: async () => { throw new Error("should not wait"); },
    });
    await assert.rejects(long.skills(1), { message: "mania-tracker просит подождать 20 с — слишком много запросов подряд" });
    assert.equal(n, 1);

    // no Retry-After: the body's retryAfterMs, else 5 s
    const fromBody = [];
    const body = createTrackerApi({ fetchImpl: limited({}, JSON.stringify({ retryAfterMs: 4264 })), sleep: async (ms) => { fromBody.push(ms); } });
    await assert.rejects(body.skills(1), { message: "mania-tracker просит подождать 5 с — слишком много запросов подряд" });
    assert.deepEqual(fromBody, [4264]);
    const none = [];
    await assert.rejects(createTrackerApi({ fetchImpl: limited({}), sleep: async (ms) => { none.push(ms); } }).skills(1), /подождать 5 с/);
    assert.deepEqual(none, [5000]);
});

test("the same search within a minute is answered from memory", async () => {
    let now = 1000;
    const { calls, fetchImpl } = fakeFetch(() => search);
    const api = createTrackerApi({ fetchImpl, now: () => now });
    await api.searchMaps({ page: 0, danMin: 13 });
    const again = await api.searchMaps({ page: 0, danMin: 13 });
    assert.equal(calls.length, 1);
    assert.equal(again.items.length, search.items.length);
    await api.searchMaps({ page: 1, danMin: 13 });
    assert.equal(calls.length, 2);
    now += 61000;
    await api.searchMaps({ page: 0, danMin: 13 });
    assert.equal(calls.length, 3);
});

test("a failed search is not remembered", async () => {
    let fail = true;
    const { calls, fetchImpl } = fakeFetch(() => (fail ? new Response("x", { status: 502 }) : search));
    const api = createTrackerApi({ fetchImpl });
    await assert.rejects(api.searchMaps({ page: 0 }), { message: "mania-tracker ответил 502" });
    fail = false;
    assert.equal((await api.searchMaps({ page: 0 })).total, 2940);
    assert.equal(calls.length, 2);
});

test("in English the tracker's errors are English, and the language is read when the error happens", async () => {
    const down = createTrackerApi({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    const { fetchImpl } = fakeFetch(() => new Response("nope", { status: 503 }));
    const garbled = fakeFetch(() => new Response("{not json", { status: 200 }));
    setLang("en");
    try {
        await assert.rejects(down.skills(1), { message: "mania-tracker isn't answering — check your internet connection" });
        await assert.rejects(createTrackerApi({ fetchImpl }).searchMaps({}), { message: "mania-tracker answered with 503" });
        await assert.rejects(createTrackerApi({ fetchImpl: garbled.fetchImpl }).skills(1), { message: "mania-tracker sent a reply we couldn't read" });
        const long = createTrackerApi({ fetchImpl: limited({ "retry-after": "20" }), sleep: async () => {} });
        await assert.rejects(long.skills(1), { message: "mania-tracker asks you to wait 20 s — too many requests in a row" });
    } finally {
        setLang("ru");
    }
    // the same client switches back with the app
    await assert.rejects(down.skills(1), { message: "mania-tracker не отвечает — проверь интернет" });
});

test("recent plays: the profile's /recent, remembered for a minute", async () => {
    let now = 1000;
    const { calls, fetchImpl } = fakeFetch(() => ({ userId: 777, payload: [{ beatmap_id: 1 }] }));
    const api = createTrackerApi({ fetchImpl, now: () => now });
    const first = await api.recent(777);
    assert.equal(first.payload.length, 1);
    assert.equal(calls[0].url.pathname, "/api/profiles/777/recent");
    assert.equal(calls[0].url.search, "");
    await api.recent(777);
    assert.equal(calls.length, 1);
    await api.recent(778);
    assert.equal(calls.length, 2);
    now += 61000;
    await api.recent(777);
    assert.equal(calls.length, 3);
});

test("skill history: 4K, and the cursor of the page before when there is one", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ items: [], nextBefore: 5 }));
    const api = createTrackerApi({ fetchImpl });
    assert.deepEqual(await api.skillHistory(777), { items: [], nextBefore: 5 });
    await api.skillHistory(777, { before: 507986 });
    await api.skillHistory(777, { before: "../x" });
    assert.deepEqual(calls.map((c) => c.url.pathname), Array(3).fill("/api/profiles/777/skill-history"));
    assert.deepEqual(calls.map((c) => c.url.search), ["?keys=4", "?keys=4&before=507986", "?keys=4"]);
});
