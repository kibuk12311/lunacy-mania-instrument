import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecommendHandlers, registerRecommendIpc } from "../app/recommendIpc.js";
import { decodeCollectionDb } from "../src/recommend/collectionDb.js";
import { setLang, getLang } from "../src/i18n/i18n.js";

const SKILL = { ready: true, status: "ready", analyzedPlays: 120, overall: 13.4, overallLabel: "Gamma mid/high", tiles: {}, msd: {} };
const TARGET = { patternId: "jumpstream", goalId: "growth", source: "tile", tile: "stamina", playerDan: 13.26, playerDanLabel: "Gamma mid/high", lo: 13.26, hi: 13.76, center: 13.51, halfWidth: 0.25, msdAxis: "Jumpstream", msdRating: 24.1, msdTarget: 24.85 };
const REQUEST = { manual: false, manualDan: null, patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: true, hidePlayed: true };
const OSU = "osu file format v14\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n";

// Fakes for every dependency; each records how it was called.
function setup(overrides = {}) {
    const calls = { loadPlayer: [], known: [], start: [], more: 0, fetchText: [], open: [], rate: [], analyze: [], log: [] };
    const recommender = {
        async loadPlayer(query, known = null) {
            calls.loadPlayer.push(query);
            calls.known.push(known);
            return { id: 7, username: "Мира", avatarUrl: "https://a.ppy.sh/7", skill: SKILL, extra: "x" };
        },
        async start(request) {
            calls.start.push(request);
            return { target: TARGET, cards: [{ beatmapId: 1 }, { beatmapId: 2 }], more: true, total: 312 };
        },
        async more() {
            calls.more += 1;
            return { cards: [{ beatmapId: 3 }], more: false };
        },
        ...overrides.recommender,
    };
    const analyze = async (osuText, rate) => {
        calls.analyze.push([osuText, rate]);
        return { kind: "ok", numeric: 13.4, label: "Gamma mid/high", primary: "jumpstream" };
    };
    const deps = {
        recommender,
        analyze,
        fetchText: async (url) => { calls.fetchText.push(url); return OSU; },
        openExternal: async (url) => { calls.open.push(url); },
        fetchProfile: async () => ({ id: 1234567, name: "TestPlayer" }),
        log: (line) => calls.log.push(line),
        suggestRateImpl: async (args) => {
            calls.rate.push(args);
            return { ok: true, ours: { label: "Gamma mid", numeric: 13, primary: "jumpstream" }, rate: 1.05, rateLabel: "Gamma high", reason: "in-target" };
        },
        ...overrides.deps,
    };
    return { handlers: createRecommendHandlers(deps), calls };
}

test("player returns the trimmed profile and its skill", async () => {
    const { handlers, calls } = setup();
    const r = await handlers.player("  Мира ");
    assert.deepEqual(calls.loadPlayer, ["Мира"]);
    assert.deepEqual(r, { ok: true, player: { id: 7, username: "Мира", avatarUrl: "https://a.ppy.sh/7" }, skill: SKILL });
});

test("player with an empty query asks for a nick without calling the tracker", async () => {
    const { handlers, calls } = setup();
    for (const q of ["", "   ", null, undefined]) {
        const r = await handlers.player(q);
        assert.equal(r.ok, false);
        assert.match(r.message, /ник/);
    }
    assert.equal(calls.loadPlayer.length, 0);
});

test("player turns a tracker error into a message", async () => {
    const { handlers, calls } = setup({ recommender: { loadPlayer: async () => { throw new Error("игрок не найден на mania-tracker"); } } });
    assert.deepEqual(await handlers.player("nobody"), { ok: false, message: "игрок не найден на mania-tracker" });
    assert.ok(calls.log.some((l) => l.includes("игрок не найден")));
});

test("me gives the osu! name from tosu, or the id when the name is empty", async () => {
    assert.deepEqual(await setup().handlers.me(), { ok: true, query: "TestPlayer" });
    const noName = setup({ deps: { fetchProfile: async () => ({ id: 42, name: "" }) } });
    assert.deepEqual(await noName.handlers.me(), { ok: true, query: "42" });
});

test("after «из osu!» the logged-in name loads by its exact osu! id", async () => {
    const { handlers, calls } = setup();
    await handlers.player("TestPlayer");
    assert.deepEqual(calls.known, [null], "before me() the name is searched");
    await handlers.me();
    await handlers.player("testplayer");
    await handlers.player("1234567");
    await handlers.player("TestPlaye");
    assert.deepEqual(calls.known.slice(1), [{ id: 1234567, name: "TestPlayer" }, { id: 1234567, name: "TestPlayer" }, null]);
});

test("me without a logged-in osu! explains what to do", async () => {
    const message = "открой osu! и войди в аккаунт — или впиши ник вручную";
    assert.deepEqual(await setup({ deps: { fetchProfile: async () => null } }).handlers.me(), { ok: false, message });
    assert.deepEqual(await setup({ deps: { fetchProfile: async () => { throw new Error("boom"); } } }).handlers.me(), { ok: false, message });
});

test("start passes a clean request and returns the first cards", async () => {
    const { handlers, calls } = setup();
    const r = await handlers.start({ ...REQUEST, rankedOnly: 1, hidePlayed: 0, junk: "x" });
    assert.deepEqual(calls.start, [{ ...REQUEST, rankedOnly: true, hidePlayed: false }]);
    assert.deepEqual(r, { ok: true, target: TARGET, cards: [{ beatmapId: 1 }, { beatmapId: 2 }], more: true, total: 312, playedPartial: false });
    assert.ok(calls.log.some((l) => l.includes("jumpstream growth 13.26..13.76") && l.includes("2 cards")), calls.log.join("\n"));
});

test("start says when only part of the played maps arrived", async () => {
    const { handlers } = setup({ recommender: { start: async () => ({ target: TARGET, cards: [], more: false, total: 0, playedPartial: true }) } });
    assert.equal((await handlers.start(REQUEST)).playedPartial, true);
});

test("start with a manual dan keeps it; without manual mode it is dropped", async () => {
    const { handlers, calls } = setup();
    await handlers.start({ ...REQUEST, manual: true, manualDan: 13.2 });
    await handlers.start({ ...REQUEST, manual: false, manualDan: 13.2 });
    assert.equal(calls.start[0].manual, true);
    assert.equal(calls.start[0].manualDan, 13.2);
    assert.equal(calls.start[1].manual, false);
    assert.equal(calls.start[1].manualDan, null);
});

test("start accepts every dan the manual picker can produce", async () => {
    const { handlers } = setup();
    for (const manualDan of [0.6, 1, 20, 20.4]) {
        assert.equal((await handlers.start({ ...REQUEST, manual: true, manualDan })).ok, true, String(manualDan));
    }
});

test("start refuses unknown ids and out-of-range dans without calling the recommender", async () => {
    const { handlers, calls } = setup();
    const bad = [
        { ...REQUEST, patternId: "ln" },
        { ...REQUEST, goalId: "toString" },
        { ...REQUEST, lengthId: "huge" },
        { ...REQUEST, manual: true, manualDan: 0 },
        { ...REQUEST, manual: true, manualDan: 25 },
        { ...REQUEST, manual: true, manualDan: null },
        { ...REQUEST, manual: true, manualDan: "13" },
        null,
    ];
    for (const req of bad) {
        const r = await handlers.start(req);
        assert.equal(r.ok, false, JSON.stringify(req));
        assert.equal(typeof r.message, "string");
    }
    assert.equal(calls.start.length, 0);
});

test("start and more run one at a time, in the order they were asked", async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const { handlers } = setup({
        recommender: {
            start: async () => { order.push("start"); await gate; order.push("start done"); return { target: TARGET, cards: [], more: true, total: 0 }; },
            more: async () => { order.push("more"); return { cards: [], more: false }; },
        },
    });
    const a = handlers.start(REQUEST);
    const b = handlers.more();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["start"]);
    release();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["start", "start done", "more"]);
});

test("a failed start does not block the next request", async () => {
    let first = true;
    const { handlers } = setup({ recommender: { start: async () => { if (first) { first = false; throw new Error("нет сети"); } return { target: TARGET, cards: [], more: false, total: 0 }; } } });
    assert.equal((await handlers.start(REQUEST)).ok, false);
    assert.equal((await handlers.start(REQUEST)).ok, true);
    assert.equal((await handlers.more()).ok, true);
});

test("start turns a recommender error into a message", async () => {
    const { handlers } = setup({ recommender: { start: async () => { throw new Error("сначала загрузи профиль с mania-tracker"); } } });
    assert.deepEqual(await handlers.start(REQUEST), { ok: false, message: "сначала загрузи профиль с mania-tracker" });
});

test("more returns the next cards or a message", async () => {
    assert.deepEqual(await setup().handlers.more(), { ok: true, cards: [{ beatmapId: 3 }], more: false });
    const failing = setup({ recommender: { more: async () => { throw new Error("сначала нажми «Подобрать»"); } } });
    assert.deepEqual(await failing.handlers.more(), { ok: false, message: "сначала нажми «Подобрать»" });
});

test("ours downloads the .osu from osu.ppy.sh and fits a rate", async () => {
    const { handlers, calls } = setup();
    const r = await handlers.ours({ beatmapId: 4721001, trackerDan: 13.2, center: 13.51 });
    assert.equal(r.ok, true);
    assert.equal(r.rate, 1.05);
    assert.deepEqual(calls.fetchText, ["https://osu.ppy.sh/osu/4721001"]);
    assert.equal(calls.rate.length, 1);
    assert.equal((await calls.rate[0].analyze(OSU, 1.1)).kind, "ok");
    assert.deepEqual(calls.analyze, [[OSU, 1.1]]);
    assert.equal(calls.rate[0].osuText, OSU);
    assert.equal(calls.rate[0].trackerDan, 13.2);
    assert.equal(calls.rate[0].center, 13.51);
});

test("ours is cached per beatmap and target center", async () => {
    const { handlers, calls } = setup();
    const a = await handlers.ours({ beatmapId: 5, trackerDan: 13.2, center: 13.51 });
    const b = await handlers.ours({ beatmapId: 5, trackerDan: 13.2, center: 13.51 });
    assert.deepEqual(a, b);
    assert.equal(calls.fetchText.length, 1);
    await handlers.ours({ beatmapId: 5, trackerDan: 13.2, center: 12.9 });
    await handlers.ours({ beatmapId: 6, trackerDan: 13.2, center: 13.51 });
    assert.equal(calls.fetchText.length, 3);
});

test("two clicks at once share one download", async () => {
    const { handlers, calls } = setup();
    const [a, b] = await Promise.all([
        handlers.ours({ beatmapId: 9, trackerDan: 13, center: 13.5 }),
        handlers.ours({ beatmapId: 9, trackerDan: 13, center: 13.5 }),
    ]);
    assert.deepEqual(a, b);
    assert.equal(calls.fetchText.length, 1);
});

test("a failed download is reported and retried on the next click", async () => {
    let fail = true;
    const urls = [];
    const { handlers } = setup({ deps: { fetchText: async (url) => { urls.push(url); if (fail) throw new Error("не удалось скачать .osu карты"); return OSU; } } });
    assert.deepEqual(await handlers.ours({ beatmapId: 11, trackerDan: 13, center: 13.5 }), { ok: false, message: "не удалось скачать .osu карты" });
    fail = false;
    assert.equal((await handlers.ours({ beatmapId: 11, trackerDan: 13, center: 13.5 })).ok, true);
    assert.equal(urls.length, 2);
});

test("a result after a transient analyzer error is not cached", async () => {
    let transient = true;
    const analyze = async () => (transient ? { kind: "error", message: "расчёт занял слишком долго", transient: true } : { kind: "ok", numeric: 13 });
    const { handlers, calls } = setup({
        deps: {
            analyze,
            suggestRateImpl: async (args) => {
                const r = await args.analyze(args.osuText, 1);
                return r.kind === "ok" ? { ok: true, ours: { numeric: r.numeric }, rate: null, rateLabel: null, reason: null } : { ok: false, message: r.message };
            },
        },
    });
    assert.deepEqual(await handlers.ours({ beatmapId: 12, trackerDan: 13, center: 13.5 }), { ok: false, message: "расчёт занял слишком долго" });
    transient = false;
    assert.equal((await handlers.ours({ beatmapId: 12, trackerDan: 13, center: 13.5 })).ok, true);
    assert.equal(calls.fetchText.length, 2);
});

test("our dan without a rate is not cached, so «попробуй ещё раз» really tries again", async () => {
    const { handlers, calls } = setup({ deps: { suggestRateImpl: async () => ({ ok: true, ours: { numeric: 13 }, rate: null, rateLabel: null, reason: null }) } });
    await handlers.ours({ beatmapId: 14, trackerDan: 13, center: 13.5 });
    await handlers.ours({ beatmapId: 14, trackerDan: 13, center: 13.5 });
    assert.equal(calls.fetchText.length, 2);
});

test("a deterministic refusal (not rice) is cached", async () => {
    const { handlers, calls } = setup({ deps: { suggestRateImpl: async () => ({ ok: false, message: "это не рис-карта" }) } });
    await handlers.ours({ beatmapId: 13, trackerDan: 13, center: 13.5 });
    assert.deepEqual(await handlers.ours({ beatmapId: 13, trackerDan: 13, center: 13.5 }), { ok: false, message: "это не рис-карта" });
    assert.equal(calls.fetchText.length, 1);
});

test("an empty download (deleted map) is an error and is not cached", async () => {
    const urls = [];
    const { handlers } = setup({ deps: { fetchText: async (url) => { urls.push(url); return ""; } } });
    assert.deepEqual(await handlers.ours({ beatmapId: 15, trackerDan: 13, center: 13.5 }), { ok: false, message: "не удалось скачать .osu карты" });
    await handlers.ours({ beatmapId: 15, trackerDan: 13, center: 13.5 });
    assert.equal(urls.length, 2);
});

test("ours refuses bad input without downloading anything", async () => {
    const { handlers, calls } = setup();
    const bad = [
        { beatmapId: 0, trackerDan: 13, center: 13.5 },
        { beatmapId: -5, trackerDan: 13, center: 13.5 },
        { beatmapId: 1.5, trackerDan: 13, center: 13.5 },
        { beatmapId: "../../evil", trackerDan: 13, center: 13.5 },
        { beatmapId: 5, trackerDan: NaN, center: 13.5 },
        { beatmapId: 5, trackerDan: 13, center: "x" },
        null,
    ];
    for (const req of bad) assert.equal((await handlers.ours(req)).ok, false, JSON.stringify(req));
    assert.equal(calls.fetchText.length, 0);
});

test("ours never throws, even when the rate fit does", async () => {
    const { handlers } = setup({ deps: { suggestRateImpl: async () => { throw new Error("сломалось"); } } });
    assert.deepEqual(await handlers.ours({ beatmapId: 14, trackerDan: 13, center: 13.5 }), { ok: false, message: "сломалось" });
});

test("open builds the beatmap page or osu!direct link itself", async () => {
    const { handlers, calls } = setup();
    assert.deepEqual(await handlers.open({ kind: "site", beatmapId: 4721001 }), { ok: true });
    assert.deepEqual(await handlers.open({ kind: "direct", beatmapId: "4721001" }), { ok: true });
    assert.deepEqual(calls.open, ["https://osu.ppy.sh/beatmaps/4721001", "osu://b/4721001"]);
});

test("open refuses other kinds and ids that are not positive integers", async () => {
    const { handlers, calls } = setup();
    const bad = [
        { kind: "file", beatmapId: 1 },
        { kind: "https://evil.example", beatmapId: 1 },
        { kind: "site", beatmapId: 0 },
        { kind: "site", beatmapId: -1 },
        { kind: "site", beatmapId: 2.5 },
        { kind: "site", beatmapId: "1/../../evil" },
        { kind: "direct", beatmapId: "javascript:alert(1)" },
        { kind: "site", beatmapId: true },
        null,
    ];
    for (const req of bad) assert.equal((await handlers.open(req)).ok, false, JSON.stringify(req));
    assert.deepEqual(calls.open, []);
});

test("open reports when the link cannot be opened", async () => {
    const { handlers } = setup({ deps: { openExternal: async () => { throw new Error("no handler"); } } });
    const r = await handlers.open({ kind: "direct", beatmapId: 1 });
    assert.equal(r.ok, false);
    assert.match(r.message, /osu!/);
});

// download: the downloader, osu!'s file association and progress pushes are all fakes.
function downloadSetup({ download, openPath } = {}) {
    const seen = { download: [], opened: [], shown: [], progress: [] };
    const { handlers } = setup({ deps: {
        downloader: {
            download: download ?? (async (req) => {
                seen.download.push(req);
                req.onProgress?.({ received: 50, total: 100, mirror: "osu.direct" });
                return { file: `C:/dl/${req.beatmapsetId} a - b.osz`, mirror: "osu.direct", bytes: 100, reused: false };
            }),
        },
        openPath: openPath ?? (async (file) => { seen.opened.push(file); return ""; }),
        showFile: (file) => seen.shown.push(file),
        progress: (event) => seen.progress.push(event),
    } });
    return { handlers, seen };
}

test("download fetches the set, pushes progress and hands the .osz to osu!", async () => {
    const { handlers, seen } = downloadSetup();
    const r = await handlers.download({ beatmapsetId: 358342, artist: "UNDEAD CORPORATION", title: "The Empress", extra: "x" });
    assert.deepEqual(r, { ok: true, file: "C:/dl/358342 a - b.osz", opened: true, reused: false });
    assert.equal(seen.download[0].beatmapsetId, 358342);
    assert.equal(seen.download[0].artist, "UNDEAD CORPORATION");
    assert.deepEqual(seen.progress, [{ beatmapsetId: 358342, received: 50, total: 100 }]);
    assert.deepEqual(seen.opened, ["C:/dl/358342 a - b.osz"]);
});

test("download says when osu! could not open the file but keeps it", async () => {
    const { handlers } = downloadSetup({ openPath: async () => "No application is associated" });
    const r = await handlers.download({ beatmapsetId: 1, artist: "a", title: "b" });
    assert.equal(r.ok, true);
    assert.equal(r.opened, false);
    assert.match(r.message, /osu! не открыл файл/);
});

test("download refuses bad ids and turns failures into messages", async () => {
    const { handlers, seen } = downloadSetup();
    for (const id of [0, -3, "x", 1.5, null]) {
        const r = await handlers.download({ beatmapsetId: id, artist: "a", title: "b" });
        assert.equal(r.ok, false);
    }
    assert.equal(seen.download.length, 0);
    const failing = downloadSetup({ download: async () => { throw new Error("не удалось скачать карту ни с одного зеркала"); } });
    assert.deepEqual(await failing.handlers.download({ beatmapsetId: 2, artist: "a", title: "b" }), { ok: false, message: "не удалось скачать карту ни с одного зеркала" });
});

test("show opens only files this session downloaded", async () => {
    const { handlers, seen } = downloadSetup();
    const r = await handlers.download({ beatmapsetId: 5, artist: "a", title: "b" });
    assert.deepEqual(handlers.show(r.file), { ok: true });
    assert.equal(handlers.show("C:/Windows/system32/calc.exe").ok, false);
    assert.equal(handlers.show(42).ok, false);
    assert.deepEqual(seen.shown, [r.file]);
});

test("in English the handlers answer in English", async () => {
    setLang("en");
    try {
        const { handlers } = setup({ deps: { fetchProfile: async () => null } });
        assert.deepEqual(await handlers.me(), { ok: false, message: "open osu! and log in — or type a username yourself" });
        assert.deepEqual(await handlers.player("  "), { ok: false, message: "type an osu! username or player id" });
        assert.deepEqual(await handlers.start({ ...REQUEST, patternId: "nope" }), { ok: false, message: "pick a pattern" });
        assert.deepEqual(await handlers.start({ ...REQUEST, goalId: "nope" }), { ok: false, message: "pick a goal" });
        assert.deepEqual(await handlers.start({ ...REQUEST, lengthId: "nope" }), { ok: false, message: "pick a map length" });
        assert.deepEqual(await handlers.start({ ...REQUEST, manual: true, manualDan: 99 }), { ok: false, message: "pick a dan — from Dan 1 to Kappa" });
        assert.deepEqual(await handlers.ours({ beatmapId: 0, trackerDan: 13, center: 13.5 }), { ok: false, message: "no data about this map" });
        assert.deepEqual(await handlers.open({ kind: "other", beatmapId: 1 }), { ok: false, message: "couldn't open this map" });
        assert.deepEqual(handlers.show("C:/nope.osz"), { ok: false, message: "no such file" });
        const deleted = setup({ deps: { fetchText: async () => "" } });
        assert.deepEqual(await deleted.handlers.ours({ beatmapId: 21, trackerDan: 13, center: 13.5 }), { ok: false, message: "couldn't download the map's .osu" });
        const noOsu = setup({ deps: { openExternal: async () => { throw new Error("no handler"); } } });
        assert.deepEqual(await noOsu.handlers.open({ kind: "direct", beatmapId: 1 }), { ok: false, message: "couldn't open the map in osu! — is it installed?" });
        assert.deepEqual(await noOsu.handlers.open({ kind: "site", beatmapId: 1 }), { ok: false, message: "couldn't open the map's page" });
        const { handlers: dl } = downloadSetup({ openPath: async () => "No application is associated" });
        assert.equal((await dl.download({ beatmapsetId: 1, artist: "a", title: "b" })).message, "downloaded, but osu! didn't open the file — open it yourself (“Show file”)");
    } finally {
        setLang("ru");
    }
});

test("a refusal cached in one language is worked out again after a language switch", async () => {
    let fits = 0;
    const { handlers } = setup({ deps: { suggestRateImpl: async () => {
        fits += 1;
        return { ok: false, message: getLang() === "en" ? "not a rice map" : "это не рис-карта" };
    } } });
    try {
        const req = { beatmapId: 31, trackerDan: 13, center: 13.5 };
        assert.equal((await handlers.ours(req)).message, "это не рис-карта");
        assert.equal((await handlers.ours(req)).message, "это не рис-карта");
        setLang("en");
        assert.equal((await handlers.ours(req)).message, "not a rice map");
        assert.equal(fits, 2);
    } finally {
        setLang("ru");
    }
});

test("onPlayer hears only a successful load, with the query and the loaded player", async () => {
    const heard = [];
    const { handlers } = setup({ deps: { onPlayer: (query, loaded) => heard.push([query, loaded.id, loaded.username]) } });
    await handlers.player("  Мира ");
    await handlers.player("");
    assert.deepEqual(heard, [["Мира", 7, "Мира"]]);

    const failing = setup({
        recommender: { loadPlayer: async () => { throw new Error("игрок не найден на mania-tracker"); } },
        deps: { onPlayer: () => heard.push("never") },
    });
    await failing.handlers.player("nobody");
    assert.equal(heard.length, 1);

    // a throwing onPlayer does not spoil the answer
    const loud = setup({ deps: { onPlayer: () => { throw new Error("boom"); } } });
    assert.equal((await loud.handlers.player("Мира")).ok, true);
});

// ---- tabs v2: plan, similar, the picks journal ----

const SEED = { primaryPattern: "jumpstream", msdAll: { Jumpstream: 29 }, patternsAll: { jumpstream: 1 }, bpm: 200, lengthSec: 150, dan: 12.5 };
const planCard = (id) => ({
    beatmapId: id, beatmapsetId: id + 100, artist: "A", title: `T${id}`, version: "[4K] V", creator: "C", dan: 13, danLabel: "Gamma mid",
    bpm: 200, lengthSec: 120, playCount: 5, seed: SEED,
});
const PLAN_REQ = { size: 5, patternIds: ["jumpstream"], lengthId: "any", rankedOnly: false, manual: false, manualDan: null };

// A journal store, a planner and a tracker search that record what they get.
function v2Setup(overrides = {}) {
    const seen = { picks: [], build: [], swap: [], search: [] };
    const store = {
        picks: { add: async (entry) => { seen.picks.push(entry); return [entry]; } },
        ...overrides.store,
    };
    const planner = {
        async build(req) {
            seen.build.push(req);
            return {
                header: { playerDan: 13.26, label: "Gamma mid/high", tile: "Stamina", source: "tile", patternId: "jumpstream" },
                slots: [
                    { role: "warmup", patternId: "jumpstream", lo: 12.56, hi: 12.91, center: 12.74, card: planCard(1) },
                    { role: "growth", patternId: "jumpstream", lo: 13.26, hi: 13.51, center: 13.39, card: null },
                ],
                totalSec: 120,
                playedPartial: false,
            };
        },
        swap(slot) { seen.swap.push(slot); return planCard(50 + slot); },
        ...overrides.planner,
    };
    const searchMaps = overrides.searchMaps ?? (async (params) => { seen.search.push(params); return { items: [], total: 0, page: params.page }; });
    const { handlers, calls } = setup({
        recommender: { playedMaps: async () => ({ played: new Map(), partial: false }), ...overrides.recommender },
        deps: {
            store, planner, searchMaps, now: () => 5000, openPath: async () => "",
            downloader: { download: async (req) => ({ file: `C:/dl/${req.beatmapsetId}.osz`, mirror: "m", bytes: 1, reused: false }) },
            ...overrides.deps,
        },
    });
    return { handlers, calls, seen };
}

test("plan checks the request before building: size, 1–3 known patterns, length and a manual dan", async () => {
    const { handlers, seen } = v2Setup();
    const bad = [
        { ...PLAN_REQ, size: 4 }, { ...PLAN_REQ, size: "5" },
        { ...PLAN_REQ, patternIds: [] }, { ...PLAN_REQ, patternIds: ["stream", "tech", "jack", "jumpstream"] },
        { ...PLAN_REQ, patternIds: ["ln"] }, { ...PLAN_REQ, patternIds: "stream" },
        { ...PLAN_REQ, lengthId: "huge" },
        { ...PLAN_REQ, manual: true, manualDan: 30 },
        null,
    ];
    for (const req of bad) {
        const r = await handlers.plan(req);
        assert.equal(r.ok, false, JSON.stringify(req));
        assert.equal(typeof r.message, "string");
    }
    assert.equal(seen.build.length, 0);
    const r = await handlers.plan({ ...PLAN_REQ, patternIds: ["stream", "stream", "tech"], rankedOnly: 1, manualDan: 13, junk: 1 });
    assert.deepEqual(seen.build, [{ size: 5, patternIds: ["stream", "tech"], lengthId: "any", rankedOnly: true, manual: false, manualDan: null }]);
    assert.equal(r.ok, true);
    assert.equal(r.slots.length, 2);
    assert.equal(r.slots[0].card.beatmapId, 1);
    assert.equal(r.totalSec, 120);
    assert.equal(r.header.tile, "Stamina");
});

test("plan and swap turn errors into messages; swap needs a whole slot number", async () => {
    const failing = v2Setup({ planner: { build: async () => { throw new Error("сначала загрузи профиль с mania-tracker"); }, swap: () => { throw new Error("сначала составь план"); } } });
    assert.deepEqual(await failing.handlers.plan(PLAN_REQ), { ok: false, message: "сначала загрузи профиль с mania-tracker" });
    assert.deepEqual(await failing.handlers.planSwap({ slot: 1 }), { ok: false, message: "сначала составь план" });
    const { handlers, seen } = v2Setup();
    for (const slot of [-1, 1.5, "1", null, 99]) assert.equal((await handlers.planSwap({ slot })).ok, false, String(slot));
    assert.equal((await handlers.planSwap(null)).ok, false);
    assert.deepEqual(seen.swap, []);
    assert.deepEqual(await handlers.planSwap({ slot: 2 }), { ok: true, card: planCard(52) });
    const none = v2Setup({ planner: { swap: () => null } });
    assert.deepEqual(await none.handlers.planSwap({ slot: 0 }), { ok: true, card: null });
});

test("the picks journal: a download and an osu!direct open, with the card the tab was shown", async () => {
    const { handlers, seen } = v2Setup();
    await handlers.plan(PLAN_REQ); // the plan's cards are now known by id
    await handlers.download({ beatmapsetId: 101, beatmapId: 1, artist: "A", title: "T1" });
    await handlers.open({ kind: "direct", beatmapId: 1 });
    await handlers.open({ kind: "site", beatmapId: 1 });
    // a card nobody was shown, or a set that doesn't match the card, is not journalled
    await handlers.download({ beatmapsetId: 7, beatmapId: 999, artist: "A", title: "B" });
    await handlers.download({ beatmapsetId: 7, beatmapId: 1, artist: "A", title: "B" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.picks.map((p) => [p.beatmapId, p.beatmapsetId, p.title, p.how, p.at]), [[1, 101, "T1", "download", 5000], [1, 101, "T1", "direct", 5000]]);
    // start and more fill the index too
    const r = v2Setup({ recommender: { start: async () => ({ target: TARGET, cards: [planCard(7)], more: false, total: 1 }) } });
    await r.handlers.start(REQUEST);
    await r.handlers.open({ kind: "direct", beatmapId: 7 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(r.seen.picks.map((p) => p.beatmapId), [7]);
    assert.equal(r.handlers.cardFor(7).title, "T7");
    assert.equal(r.handlers.cardFor(8), null);
});

test("a journal that fails to write does not spoil the download", async () => {
    const { handlers, calls } = v2Setup({ store: { picks: { add: async () => { throw new Error("disk full"); } } } });
    await handlers.plan(PLAN_REQ);
    const r = await handlers.download({ beatmapsetId: 101, beatmapId: 1, artist: "A", title: "T1" });
    assert.equal(r.ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.log.some((l) => l.includes("journal") && l.includes("disk full")), calls.log.join("\n"));
});

// A tracker set with one diff, around the seed's dan.
const simSet = (id, dan) => {
    const d = {
        beatmapId: id, beatmapsetId: id + 100, title: `Other ${id}`, artist: "B", version: "[4K] V", creator: "C", dan: { rawDan: dan },
        msd: { Jumpstream: 29 }, patterns: { jumpstream: 1 }, bpm: 200, length: 150, playCount: 1000, lnShare: 0, primaryPattern: "jumpstream",
    };
    return { ...d, diffs: [d] };
};

test("similar: id and seed checked, two tracker pages read once, the map's own set left out", async () => {
    // page 0 is full (48 sets: the map itself, one near it, the rest far away), page 1 has one more
    const pages = [[simSet(1, 12.5), simSet(2, 12.6), ...Array.from({ length: 46 }, (_, i) => simSet(1000 + i, 16))], [simSet(3, 12.4)]];
    const seen = [];
    const { handlers } = v2Setup({ searchMaps: async (params) => { seen.push(params); return { items: pages[params.page] ?? [], total: 49, page: params.page }; } });
    for (const req of [{ beatmapId: 0, seed: SEED }, { beatmapId: "x", seed: SEED }, { beatmapId: 5, seed: { ...SEED, dan: NaN } }, { beatmapId: 5 }, null]) {
        assert.equal((await handlers.similar(req)).ok, false, JSON.stringify(req));
    }
    assert.equal(seen.length, 0);
    const req = { beatmapId: 1, beatmapsetId: 101, title: "Other 1", seed: SEED, rankedOnly: false, hidePlayed: true };
    const r = await handlers.similar(req);
    assert.equal(r.ok, true);
    assert.deepEqual(r.cards.map((c) => c.beatmapId).sort(), [2, 3]);
    assert.ok(r.cards.every((c) => typeof c.sim === "number" && typeof c.simLabel === "string"));
    assert.deepEqual(seen.map((p) => [p.patterns, p.page]), [["jumpstream", 0], ["jumpstream", 1]]);
    // the same seed again is answered from memory
    await handlers.similar(req);
    assert.equal(seen.length, 2);
    // the similar cards are known by id afterwards
    assert.equal(handlers.cardFor(2).title, "Other 2");
});

test("similar turns a tracker failure into a message", async () => {
    const { handlers } = v2Setup({ searchMaps: async () => { throw new Error("mania-tracker ответил 502"); } });
    assert.deepEqual(await handlers.similar({ beatmapId: 1, seed: SEED }), { ok: false, message: "mania-tracker ответил 502" });
});

test("show also opens a file the tab exported", async () => {
    const { handlers } = v2Setup();
    assert.equal(handlers.show("C:/docs/коллекции/collection.db").ok, false);
    handlers.allowShow("C:/docs/коллекции/collection.db");
    assert.equal(handlers.show("C:/docs/коллекции/collection.db").ok, true);
});

test("registered channels: a favourite is journalled as «fav», the export lands in коллекции and rec-show reveals it", async (t) => {
    const userData = await mkdtemp(path.join(tmpdir(), "userData-"));
    const docsDir = await mkdtemp(path.join(tmpdir(), "Документы-"));
    const handlers = new Map();
    const sent = [];
    const shown = [];
    const fetched = [];
    // the .osu download goes through fetch; only osu.ppy.sh is asked
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        fetched.push(String(url));
        return new Response(`osu file format v14\n[HitObjects]\n${url}\n`, { status: 200 });
    };
    t.after(() => { globalThis.fetch = realFetch; });
    registerRecommendIpc({
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} },
        shell: { showItemInFolder: (file) => shown.push(file), openExternal: async () => {}, openPath: async () => "" },
        send: (channel, payload) => sent.push([channel, payload]),
        log: () => {},
        tosu: { profile: async () => null },
        analysis: { analyzeQueued: async () => ({ kind: "error", message: "x" }) },
        recommender: { currentPlayer: () => null, playedMaps: async () => ({ played: new Map(), partial: false }) },
        downloader: null,
        profile: { remember: () => {} },
        trackerApi: { searchMaps: async () => ({ items: [], total: 0 }) },
        paths: { userData, docsDir },
    });
    const call = (channel, req) => handlers.get(channel)(null, req);
    for (const channel of ["rec-plan", "rec-plan-swap", "rec-similar", "rec-fav-list", "rec-fav-add", "rec-fav-remove", "rec-fav-export", "rec-progress"]) {
        assert.ok(handlers.has(channel), channel);
    }

    const card = { beatmapId: 4721001, beatmapsetId: 2000, artist: "A", title: "T", version: "[4K] V", creator: "C", dan: 13.2, bpm: 200, lengthSec: 100 };
    assert.equal((await call("rec-fav-add", { card })).items.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const journal = JSON.parse(await readFile(path.join(userData, "picks.json"), "utf8"));
    assert.deepEqual(journal.items.map((p) => [p.beatmapId, p.how]), [[4721001, "fav"]]);

    const r = await call("rec-fav-export", { name: "Подбор" });
    const file = path.join(docsDir, "коллекции", "collection.db");
    assert.deepEqual(r, { ok: true, file, count: 1, skipped: 0 });
    assert.deepEqual(fetched, ["https://osu.ppy.sh/osu/4721001"]);
    assert.equal(decodeCollectionDb(await readFile(file)).collections[0].name, "Подбор");
    assert.deepEqual(await readdir(docsDir), ["коллекции"]);
    assert.ok(sent.some(([channel, p]) => channel === "rec-fav-export-progress" && p.done === 1 && p.total === 1));
    assert.deepEqual(await call("rec-show", file), { ok: true });
    assert.deepEqual(shown, [file]);
    assert.equal((await call("rec-progress", { days: 7 })).ok, false, "no profile loaded");
});

test("start with a custom range: the range is checked against the picker's ends, swapped, and needs no manual dan", async () => {
    const { handlers, calls } = setup();
    const custom = { ...REQUEST, goalId: "custom", range: { from: 14, to: 12.6 } };
    assert.equal((await handlers.start(custom)).ok, true);
    assert.deepEqual(calls.start.at(-1), { ...REQUEST, goalId: "custom", range: { from: 12.6, to: 14 } });
    // manual mode: the manual dan is not needed, and not passed on
    assert.equal((await handlers.start({ ...custom, manual: true, manualDan: null })).ok, true);
    assert.deepEqual(calls.start.at(-1), { ...REQUEST, manual: true, manualDan: null, goalId: "custom", range: { from: 12.6, to: 14 } });
    assert.equal((await handlers.start({ ...custom, manual: true, manualDan: 99 })).ok, true);
    assert.equal(calls.start.at(-1).manualDan, null);
    // any dan to any dan the picker shows
    assert.equal((await handlers.start({ ...custom, range: { from: 0.6, to: 20.4 } })).ok, true);
    assert.deepEqual(calls.start.at(-1).range, { from: 0.6, to: 20.4 });
    // junk in the range is dropped
    await handlers.start({ ...custom, range: { from: 13, to: 13, extra: "x" } });
    assert.deepEqual(calls.start.at(-1).range, { from: 13, to: 13 });
    // the other goals carry no range, even when one is sent
    await handlers.start({ ...REQUEST, range: { from: 1, to: 2 } });
    assert.equal("range" in calls.start.at(-1), false);
    const count = calls.start.length;
    for (const range of [undefined, null, "12-13", {}, { from: 12 }, { from: 0.5, to: 13 }, { from: 12, to: 20.5 }, { from: "12", to: 13 }, { from: NaN, to: 13 }, { from: 12, to: Infinity }]) {
        const r = await handlers.start({ ...custom, range });
        assert.equal(r.ok, false, JSON.stringify(range));
        assert.equal(r.message, "выбери диапазон данов — от 1 дана до Kappa");
    }
    assert.equal(calls.start.length, count);
    setLang("en");
    try {
        assert.deepEqual(await handlers.start({ ...custom, range: null }), { ok: false, message: "pick a dan range — from Dan 1 to Kappa" });
    } finally {
        setLang("ru");
    }
});
