// The analysis panel in the window: the ladder runner (one rate at a time, stops when the map changes, takes the
// current rate from the card), clicks on the blocks under the card, the details and the profile it draws.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire } from "./helpers/fakeDom.js";
import { createLadderRunner, createAnalysisPanel } from "../app/renderer/analysisPanel.js";
import { LADDER_RATES } from "../app/renderer/analysisExtras.js";
// the runner tests use a fixed list of their own, whatever the ladder shows
const OLD_STEP_RATES = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

const flush = () => new Promise((resolve) => setImmediate(resolve));
const RESULT = { kind: "ok", label: "Gamma mid", numeric: 13, primary: "Jumpstream", tech: false, rate: 1, durationSec: 120, msd: {} };
const view = (key, result = RESULT) => ({ screen: "result", result, key });
const DETAILS = { v: 1, durationSec: 120, strain: [0.2, 1, 0.5], hardest: [{ fromSec: 40, toSec: 80, peak: 1 }], families: ["stream", "stream", "-"] };
const SKILL = { overall: 12.5, tiles: { speed: 13.1, stamina: 12.6, tech: 11.9, jack: null }, msd: {} };

// rates answered by hand: calls[i].answer(row)
function manualRate() {
    const calls = [];
    const analysisRate = (key, rate) => new Promise((resolve) => { calls.push({ key, rate, answer: resolve }); });
    return { calls, analysisRate };
}

test("the ladder runner asks one rate at a time, 1.0x first, never the current rate", async () => {
    const { calls, analysisRate } = manualRate();
    const rows = [];
    const runner = createLadderRunner({ analysisRate, rates: OLD_STEP_RATES, onRow: (key, rate, row) => rows.push([key, rate, row.state]) });
    runner.start({ key: "a", currentRate: 1.5 });
    await flush();
    assert.deepEqual(calls.map((c) => c.rate), [1]);
    calls[0].answer({ ok: true, rate: 1, kind: "ok", label: "Gamma mid", numeric: 13 });
    await flush();
    assert.deepEqual(calls.map((c) => c.rate), [1, 0.9]);
    for (let i = 1; i < 6; i += 1) {
        calls[i].answer(i === 2 ? { ok: true, rate: calls[i].rate, kind: "not-rice", message: "" } : { ok: true, rate: calls[i].rate, kind: "ok", numeric: 13 });
        await flush();
    }
    assert.deepEqual(calls.map((c) => c.rate), [1, 0.9, 1.1, 1.2, 1.3, 1.4]);
    assert.deepEqual(rows.map((r) => r[2]), ["ok", "ok", "fail", "ok", "ok", "ok"]);
    assert.ok(calls.every((c) => c.key === "a"));
    assert.equal(runner.key, null);
});

test("the ladder runner: 1.0x is not asked when it is the current rate; a known rate is skipped", async () => {
    const { calls, analysisRate } = manualRate();
    const runner = createLadderRunner({ analysisRate, rates: OLD_STEP_RATES, onRow: () => {} });
    runner.start({ key: "a", currentRate: 1, have: [1.1] });
    for (let i = 0; i < 5; i += 1) {
        await flush();
        calls[i].answer({ ok: true, kind: "ok", numeric: 13 });
    }
    await flush();
    assert.deepEqual(calls.map((c) => c.rate), [0.9, 1.2, 1.3, 1.4, 1.5]);
});

test("the ladder runner for a rate map asks its current rate too, right after 1.0x, also off the list", async () => {
    for (const [currentRate, expected] of [[1.2, [1, 1.2, 0.9, 1.1, 1.3, 1.4, 1.5]], [1.8, [1, 1.8, 0.9, 1.1, 1.2, 1.3, 1.4, 1.5]]]) {
        const { calls, analysisRate } = manualRate();
        const runner = createLadderRunner({ analysisRate, rates: OLD_STEP_RATES, onRow: () => {} });
        runner.start({ key: "a", currentRate, askCurrent: true });
        for (let i = 0; i < expected.length; i += 1) {
            await flush();
            calls[i].answer({ ok: true, kind: "ok", numeric: 13 });
        }
        await flush();
        assert.deepEqual(calls.map((c) => c.rate), expected, String(currentRate));
    }
});

test("a rate map on the card: its ladder asks the now row as well and draws the original's dan there", async () => {
    const asked = [];
    const answers = { 1: 12, 1.2: 13.4 };
    const dom = fakeDom({ analysisRate: async (key, rate) => { asked.push(rate); return { ok: true, rate, kind: "ok", numeric: answers[rate] ?? 13, label: "x" }; } },
        { storage: { "analysis-extras": JSON.stringify({ ladderOpen: true }) } });
    const timers = [];
    const panel = createAnalysisPanel({
        card: dom.$("card"), profile: { getProfile: () => ({ state: "idle" }), onProfile: () => () => {}, ensureProfile: async () => {} },
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
    });
    const card = { screen: "result", result: { ...RESULT, numeric: 13.1, rate: 1.2 }, key: "rm", rateMap: { rate: 1.2, virtual: false } };
    panel.html(card);
    timers.shift()();
    for (let i = 0; i < 40 && panel.state.ladder.size < LADDER_RATES.length; i += 1) await flush();
    assert.deepEqual(asked.slice(0, 2), [1, 1.2]);
    assert.equal(panel.state.ladder.size, LADDER_RATES.length);
    const html = panel.html(card);
    assert.match(html, /data-rate="1\.2"[^>]*>.*?<span class="an-lnum">13\.4<\/span><span class="an-ldelta">\+1\.4</);
    assert.ok(!html.includes(">13.1<"), "not the card's own dan");
    // the same file without its rate map (DT took it past the ladder): its own ladder, now from the card again
    asked.length = 0;
    panel.html({ ...card, result: { ...card.result, rate: 1 }, rateMap: undefined });
    assert.equal(panel.state.ladder.size, 0, "another ladder");
});

test("a rate map past the ladder's range: every rate of the original is asked, the card's rate as well, none is now", async () => {
    const asked = [];
    const dom = fakeDom({ analysisRate: async (key, rate) => { asked.push(rate); return { ok: true, rate, kind: "ok", numeric: 9, label: "x" }; } },
        { storage: { "analysis-extras": JSON.stringify({ ladderOpen: true }) } });
    const timers = [];
    const panel = createAnalysisPanel({
        card: dom.$("card"), profile: { getProfile: () => ({ state: "idle" }), onProfile: () => () => {}, ensureProfile: async () => {} },
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
    });
    const card = { screen: "result", result: { ...RESULT, numeric: 13.1, rate: 1.5 }, key: "rm", rateMap: { rate: 1.5, virtual: false, beyond: true } };
    panel.html(card);
    assert.equal(panel.state.rate, null);
    timers.shift()();
    for (let i = 0; i < 40 && panel.state.ladder.size < LADDER_RATES.length; i += 1) await flush();
    assert.deepEqual([...asked].sort((a, b) => a - b), [...LADDER_RATES].sort((a, b) => a - b), "1.5 too: it is the original's, not the card's");
    const html = panel.html(card);
    assert.ok(!html.includes("an-lnow"));
    assert.ok(!html.includes(">13.1<"), "not the card's own dan");
    assert.equal(timers.length, 0, "a ladder with every row is done");
});

test("the ladder runner stops on another map, and on a stale answer", async () => {
    const { calls, analysisRate } = manualRate();
    const rows = [];
    const runner = createLadderRunner({ analysisRate, rates: OLD_STEP_RATES, onRow: (key, rate) => rows.push([key, rate]) });
    runner.start({ key: "a", currentRate: 1 });
    await flush();
    runner.start({ key: "b", currentRate: 1 });
    await flush();
    calls[0].answer({ ok: true, kind: "ok", numeric: 13 }); // a's answer comes late: dropped
    await flush();
    assert.deepEqual(rows, []);
    assert.deepEqual(calls.map((c) => c.key), ["a", "b"]);
    calls[1].answer({ ok: false, stale: true });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(runner.key, null);

    runner.start({ key: "c", currentRate: 1 });
    await flush();
    runner.stop();
    calls[2].answer({ ok: true, kind: "ok", numeric: 13 });
    await flush();
    assert.equal(calls.length, 3);
});

function panelSetup({ api = {}, storage = {}, profileState = { state: "idle" } } = {}) {
    const dom = fakeDom(api, { storage });
    const card = dom.$("card");
    let draws = 0;
    const subscribers = [];
    let ensured = 0;
    const profile = {
        current: profileState,
        getProfile: () => profile.current,
        onProfile: (cb) => { subscribers.push(cb); return () => {}; },
        ensureProfile: () => { ensured += 1; return Promise.resolve(profile.current); },
        set(next) { profile.current = next; for (const cb of subscribers) cb(next); },
    };
    const timers = [];
    const panel = createAnalysisPanel({
        card, redraw: () => { draws += 1; }, profile,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    });
    return { dom, card, panel, profile, timers, draws: () => draws, ensured: () => ensured };
}

test("a click on a ladder row opens the rate tab at that rate; the picks link opens the picks tab", async () => {
    const { dom, card } = panelSetup();
    const row = { dataset: { rate: "1.2" }, parentElement: card };
    await fire(card, "click", { target: { dataset: {}, parentElement: row } });
    const [event] = dom.events;
    assert.equal(event.type, "open-rate");
    assert.deepEqual(event.detail, { rate: 1.2 });
    await fire(card, "click", { target: { dataset: { go: "recommend" }, parentElement: card } });
    assert.equal(dom.events[1].type, "open-tab");
    assert.deepEqual(dom.events[1].detail, { tab: "recommend" });
    // anything else, or a rate out of range, does nothing
    await fire(card, "click", { target: { dataset: { rate: "7" }, parentElement: card } });
    await fire(card, "click", { target: { dataset: {}, parentElement: null } });
    assert.equal(dom.events.length, 2);
});

test("the profile state becomes the for-you line, and a first ok card asks for the profile once", async () => {
    const { panel, profile, draws, ensured } = panelSetup();
    assert.ok(!panel.html(view("a"), {}).includes("Для тебя"));
    await flush();
    assert.equal(ensured(), 1);
    profile.set({ state: "ready", player: { id: 7, username: "Мира" }, skill: SKILL });
    await flush();
    assert.ok(draws() >= 1);
    const html = panel.html(view("a"), {}).replace(/<[^>]*>/g, "");
    assert.ok(html.includes("Для тебя (Мира)"));
    assert.ok(html.includes("Stamina-дан: Gamma low (12.6) · карта +0.4"));
    panel.html(view("a"), {});
    await flush();
    assert.equal(ensured(), 1);
});

test("details are drawn for their own key only, also when they come before the card", async () => {
    let onDetails;
    const { panel, draws } = panelSetup({ api: { onAnalysisDetails: (cb) => { onDetails = cb; return () => {}; } } });
    assert.equal(typeof onDetails, "function");
    panel.html(view("a"), {});
    onDetails({ key: "b", details: DETAILS });
    await flush();
    assert.ok(!panel.html(view("a"), {}).includes("<svg"));
    onDetails({ key: "a", details: DETAILS });
    await flush();
    assert.ok(draws() >= 1);
    assert.ok(panel.html(view("a"), {}).includes("пик 0:40–1:20"));
    // another map: its details came first
    onDetails({ key: "c", details: DETAILS });
    assert.ok(panel.html(view("c"), {}).includes("<svg"));
    assert.ok(!panel.html({ screen: "loading" }, {}).includes("<svg"));
});

test("the ladder opens on a click, remembers that, and fills row by row from analysisRate", async () => {
    const asked = [];
    const api = { analysisRate: async (key, rate) => { asked.push([key, rate]); return { ok: true, rate, kind: "ok", label: "x", numeric: 12 + rate }; } };
    const { dom, card, panel, timers } = panelSetup({ api });
    assert.ok(panel.html(view("a"), {}).includes("Дан на рейтах ▸"));
    await fire(card, "click", { target: { dataset: { toggle: "ladder" }, parentElement: card } });
    assert.equal(dom.storage.get("analysis-extras"), JSON.stringify({ ladderOpen: true, partsOpen: false }));
    for (let i = 0; i < 20; i += 1) await flush();
    assert.deepEqual(asked.map(([, rate]) => rate), LADDER_RATES.filter((r) => r !== 1));
    const html = panel.html(view("a"), {});
    assert.ok(html.includes("Дан на рейтах ▾"));
    assert.ok(html.includes("13.5"));
    assert.ok(!html.includes("считаем…"));

    // a new map with the ladder open waits 600 ms before it starts
    panel.html(view("b"), {});
    const waiting = timers.filter((t) => t.ms === 600);
    assert.equal(waiting.length, 1);
    assert.ok(panel.html(view("b"), {}).includes("считаем…"));
    waiting[0].fn();
    for (let i = 0; i < 20; i += 1) await flush();
    assert.equal(asked.filter(([key]) => key === "b").length, LADDER_RATES.length - 1);

    // folded again: remembered, no rows
    await fire(card, "click", { target: { dataset: { toggle: "ladder" }, parentElement: card } });
    assert.equal(dom.storage.get("analysis-extras"), JSON.stringify({ ladderOpen: false, partsOpen: false }));
    assert.ok(!panel.html(view("b"), {}).includes("data-rate="));
});

test("an open ladder is read back from localStorage, and a broken or missing storage is fine", () => {
    const open = panelSetup({ storage: { "analysis-extras": JSON.stringify({ ladderOpen: true }) } });
    assert.ok(open.panel.html(view("a"), {}).includes("Дан на рейтах ▾"));
    const broken = panelSetup({ storage: { "analysis-extras": "{" } });
    assert.ok(broken.panel.html(view("a"), {}).includes("Дан на рейтах ▸"));
    const none = panelSetup({ storage: null });
    assert.ok(none.panel.html(view("a"), {}).includes("Дан на рейтах ▸"));
});

test("a stale ladder answer stops asking for that map until the map changes", async () => {
    const asked = [];
    let stale = true;
    const api = { analysisRate: async (key, rate) => { asked.push([key, rate]); return stale ? { ok: false, stale: true } : { ok: true, rate, kind: "ok", numeric: 12 }; } };
    const { panel, timers } = panelSetup({ api, storage: { "analysis-extras": JSON.stringify({ ladderOpen: true }) } });
    panel.html(view("a"), {});
    timers.at(-1).fn();
    await flush();
    assert.equal(asked.length, 1);
    panel.html(view("a"), {});
    assert.equal(timers.length, 1); // not scheduled again
    stale = false;
    panel.html(view("b"), {});
    timers.at(-1).fn();
    for (let i = 0; i < 20; i += 1) await flush();
    assert.equal(asked.filter(([key]) => key === "b").length, LADDER_RATES.length - 1);
    // another map: its ladder is scheduled once, however often the card is drawn
    const before = timers.length;
    panel.html(view("c"), {});
    assert.equal(timers.length, before + 1);
    panel.html(view("c"), {});
    assert.equal(timers.length, before + 1);
});
