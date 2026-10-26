import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProgressHandlers } from "../../app/recProgressIpc.js";
import { DAY_MS } from "../../src/recommend/progress.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/mt/${name}.json`, import.meta.url), "utf8"));
const recentJson = await fixture("recent");
const historyJson = await fixture("history");
const NOW = Date.parse("2026-10-27T18:00:00Z");
const at = (iso) => Date.parse(iso);

const pick = (beatmapId, iso, how = "download") => ({ beatmapId, beatmapsetId: beatmapId + 1, artist: "A", title: `T${beatmapId}`, version: "V", dan: 13.5, danLabel: "Gamma high", how, at: at(iso) });

// History split in two pages: the newer half, then the older half.
const half = Math.ceil(historyJson.items.length / 2);
const PAGES = [
    { items: historyJson.items.slice(0, half), nextBefore: 111 },
    { items: historyJson.items.slice(half), nextBefore: 222 },
    { items: [], nextBefore: null },
];

function setup({ player = { id: 1234567, username: "TestPlayer" }, picks, recent = async () => recentJson, history, played = new Map(), now = () => NOW } = {}) {
    const calls = { recent: 0, history: [] };
    const trackerApi = {
        recent: async (id) => { calls.recent += 1; assert.equal(id, 1234567); return recent(); },
        skillHistory: async (id, opts = {}) => {
            calls.history.push(opts.before ?? null);
            if (history) return history(opts);
            return PAGES[[null, 111, 222].indexOf(opts.before ?? null)];
        },
    };
    const store = { picks: { list: async () => picks ?? [pick(770548, "2026-10-25T12:00:00Z"), pick(4766898, "2026-10-18T00:00:00Z"), pick(42, "2026-10-24T00:00:00Z"), pick(7, "2026-09-01T00:00:00Z")] } };
    const recommender = { currentPlayer: () => player, playedMaps: async () => ({ played, partial: false }) };
    return { handlers: createProgressHandlers({ store, trackerApi, recommender, now }), calls };
}

test("progress over 30 days: picks of the period joined with their plays, the dan and MSD change, chart points", async () => {
    const { handlers, calls } = setup();
    const r = await handlers.progress({ days: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.since, NOW - 30 * DAY_MS);
    // the 09-01 pick is older than the period
    assert.deepEqual(r.picks.map((p) => p.beatmapId), [770548, 4766898, 42]);
    assert.equal(r.total, 3);
    assert.equal(r.played, 2);
    assert.equal(r.picks[0].tries, 2);
    assert.equal(r.picks[0].play.accuracy, 0.989904);
    assert.equal(r.picks[2].play, null);
    // the history pages are read until they reach past the period's start (09-27): both pages
    assert.deepEqual(calls.history, [null, 111]);
    assert.ok(r.points.length > 3);
    assert.equal(r.points[0].at, r.since);
    assert.equal(r.change.danTo.label, "delta--");
    assert.equal(r.change.danFrom.label, "gamma++");
    assert.ok(Array.isArray(r.change.axes) && r.change.axes.length === 8);
    assert.equal(r.partial, false);
});

test("a short period needs one history page; the pages are kept five minutes", async () => {
    let now = NOW;
    const { handlers, calls } = setup({ now: () => now });
    await handlers.progress({ days: 7 });
    assert.deepEqual(calls.history, [null]);
    await handlers.progress({ days: 90 });
    // 90 days reaches past everything: the second page, then the empty end
    assert.deepEqual(calls.history, [null, 111, 222]);
    await handlers.progress({ days: 30 });
    assert.equal(calls.history.length, 3);
    now += 5 * 60_000;
    await handlers.progress({ days: 7 });
    assert.equal(calls.history.length, 4);
});

test("at most 8 history pages", async () => {
    let n = 0;
    const history = async () => ({ items: [{ recordedAt: new Date(NOW - (n++) * 60_000).toISOString(), snapshot: { ratings: { Overall: 30 }, dan: { rc: { label: "gamma" } } } }], nextBefore: 1000 - n });
    const { handlers, calls } = setup({ history });
    const r = await handlers.progress({ days: 90 });
    assert.equal(r.ok, true);
    assert.equal(calls.history.length, 8);
});

test("only 7, 30 or 90 days, and only with a loaded profile", async () => {
    const { handlers, calls } = setup();
    for (const days of [0, 14, "7", null, 7.5]) assert.equal((await handlers.progress({ days })).ok, false, String(days));
    assert.equal((await handlers.progress(null)).ok, false);
    const none = setup({ player: null });
    const r = await none.handlers.progress({ days: 7 });
    assert.deepEqual(r, { ok: false, message: "сначала загрузи профиль с mania-tracker" });
    assert.equal(calls.recent, 0);
});

test("recent plays or history that don't load leave the rest standing, marked partial", async () => {
    const { handlers } = setup({ recent: async () => { throw new Error("mania-tracker ответил 502"); }, history: async () => { throw new Error("нет сети"); } });
    const r = await handlers.progress({ days: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.partial, true);
    assert.equal(r.played, 0);
    assert.deepEqual(r.points, []);
    assert.equal(r.change, null);
    // the skill plays still count, at day precision
    const withPlays = setup({ recent: async () => ({ payload: [] }), played: new Map([[42, { accuracy: 0.97, rate: 1, playedAt: at("2026-10-24T00:00:00Z") }]]) });
    const p = await withPlays.handlers.progress({ days: 30 });
    assert.equal(p.picks.find((x) => x.beatmapId === 42).play.accuracy, 0.97);
});
