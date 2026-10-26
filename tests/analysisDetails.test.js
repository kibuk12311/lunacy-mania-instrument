// The analysis tab's main-process service: details (strain line, pattern strip) for the map selected in osu!,
// sent only while that map is still the selection, and the ladder's dans at other rates of the same chart.
import test from "node:test";
import assert from "node:assert/strict";
import { createDetailsService } from "../app/analysisDetails.js";
import { setLang } from "../src/i18n/i18n.js";

const OK = { kind: "ok", label: "Gamma mid", numeric: 13, primary: "Jumpstream" };
const DETAILS = { v: 2, durationSec: 90, strain: [0, 1], hardest: [], families: ["-", "stream"], flavours: [], flavourBins: ["-", "Rolls"] };
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Timers run by hand: tick(ms) fires every timer due by then.
function fakeTimers() {
    let now = 0;
    let next = 1;
    const timers = new Map();
    return {
        setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimer: (id) => { timers.delete(id); },
        async tick(ms) {
            now += ms;
            for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at > now) continue;
                timers.delete(id);
                timer.fn();
            }
            await flush();
            await flush();
        },
        pending: () => timers.size,
    };
}

function setup({ cached = {}, answer = { kind: "details", details: DETAILS } } = {}) {
    const timers = fakeTimers();
    const sent = [];
    const logs = [];
    const workerCalls = [];
    const queued = [];
    const store = new Map(Object.entries(cached));
    const cache = { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, value); } };
    const worker = { details: async (text, rate) => { workerCalls.push({ text, rate }); return typeof answer === "function" ? answer(text, rate) : answer; } };
    // the background line: one job at a time, a cancelled job is answered without running
    const analysis = {
        enqueue: async (fn, { isCancelled = () => false } = {}) => {
            await flush();
            if (isCancelled()) return { kind: "error", transient: true, cancelled: true, message: "cancelled" };
            return fn();
        },
        analyzeQueued: async (text, rate, { isCancelled = () => false } = {}) => {
            queued.push({ text, rate });
            await flush();
            if (isCancelled()) return { kind: "error", transient: true, cancelled: true, message: "cancelled" };
            return rate === 1.4 ? { kind: "error", message: "boom" } : { ...OK, numeric: 13 + (rate - 1) * 3, rate };
        },
    };
    const service = createDetailsService({
        analysis, worker, cache, send: (payload) => sent.push(payload), log: (line) => logs.push(line),
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    return { service, timers, sent, logs, workerCalls, queued, store };
}

test("details are worked out 300 ms after an ok result, cached and sent with their key", async () => {
    const { service, timers, sent, logs, workerCalls, store } = setup();
    service.onResult({ key: "k1@1.000", text: "chart", rate: 1, result: OK });
    await timers.tick(299);
    assert.equal(workerCalls.length, 0);
    await timers.tick(1);
    assert.deepEqual(workerCalls, [{ text: "chart", rate: 1 }]);
    assert.deepEqual(sent, [{ key: "k1@1.000", details: DETAILS }]);
    assert.deepEqual(store.get("k1@1.000#details2"), DETAILS);
    assert.ok(logs.some((l) => l.startsWith("details k1@1.000 ok")), logs.join("\n"));
});

test("a cached answer skips the worker", async () => {
    const { service, timers, sent, workerCalls } = setup({ cached: { "k1@1.000#details2": DETAILS } });
    service.onResult({ key: "k1@1.000", text: "chart", rate: 1, result: OK });
    await timers.tick(300);
    assert.equal(workerCalls.length, 0);
    assert.deepEqual(sent, [{ key: "k1@1.000", details: DETAILS }]);
});

test("another map within 300 ms cancels the job; only the current key is ever sent", async () => {
    const { service, timers, sent, workerCalls } = setup();
    service.onResult({ key: "a", text: "chart a", rate: 1, result: OK });
    await timers.tick(100);
    service.onResult({ key: "b", text: "chart b", rate: 1.5, result: OK });
    await timers.tick(300);
    assert.deepEqual(workerCalls, [{ text: "chart b", rate: 1.5 }]);
    assert.deepEqual(sent.map((p) => p.key), ["b"]);
});

test("a map changed while its details are worked out: the answer is cached but not sent", async () => {
    let release;
    const { service, timers, sent, store } = setup({ answer: () => new Promise((resolve) => { release = () => resolve({ kind: "details", details: DETAILS }); }) });
    service.onResult({ key: "a", text: "chart a", rate: 1, result: OK });
    await timers.tick(300);
    service.onResult({ key: "b", text: "chart b", rate: 1, result: { kind: "not-rice", reason: "keys", keys: 7 } });
    release();
    await flush();
    await flush();
    assert.deepEqual(sent, []);
    assert.deepEqual(store.get("a#details2"), DETAILS);
});

test("no details for results that are not ok or have no key; a failure sends null and logs it", async () => {
    const { service, timers, sent, workerCalls } = setup();
    service.onResult({ key: "a", text: "chart", rate: 1, result: { kind: "too-short" } });
    service.onResult({ key: null, text: null, rate: 1, result: { kind: "error", message: "no file" } });
    await timers.tick(1000);
    assert.equal(workerCalls.length, 0);
    assert.deepEqual(sent, []);

    const failing = setup({ answer: { kind: "error", message: "bad chart" } });
    failing.service.onResult({ key: "a", text: "chart", rate: 1, result: OK });
    await failing.timers.tick(300);
    assert.deepEqual(failing.sent, [{ key: "a", details: null }]);
    assert.ok(failing.logs.some((l) => l.startsWith("details a fail")), failing.logs.join("\n"));
    assert.equal(failing.store.size, 0);
});

test("last() is the payload sent for the current map, to send again after the page reloads", async () => {
    const { service, timers } = setup();
    assert.equal(service.last(), null);
    service.onResult({ key: "a", text: "chart", rate: 1, result: OK });
    assert.equal(service.last(), null);
    await timers.tick(300);
    assert.deepEqual(service.last(), { key: "a", details: DETAILS });
    service.onResult({ key: "b", text: "chart b", rate: 1, result: { kind: "too-short" } });
    assert.equal(service.last(), null);
});

test("rate(): the dan of the current chart at another rate through the background line", async () => {
    const { service, queued, logs } = setup();
    service.onResult({ key: "a", text: "chart", rate: 1, result: OK });
    assert.deepEqual(await service.rate({ key: "a", rate: 1.2 }), { ok: true, rate: 1.2, kind: "ok", label: "Gamma mid", numeric: 13 + 0.2 * 3, primary: "Jumpstream" });
    assert.deepEqual(queued, [{ text: "chart", rate: 1.2 }]);
    assert.ok(logs.some((l) => l.startsWith("ladder 1.2 Gamma mid")), logs.join("\n"));
    assert.deepEqual(await service.rate({ key: "a", rate: 1.4 }), { ok: true, rate: 1.4, kind: "error", message: "boom" });
});

test("rate(): an old key is stale, a rate outside 0.5–2 or a bad request is refused, a change mid-way is stale", async () => {
    const { service, queued } = setup();
    service.onResult({ key: "a", text: "chart", rate: 1, result: OK });
    assert.deepEqual(await service.rate({ key: "old", rate: 1.2 }), { ok: false, stale: true });
    setLang("en");
    try {
        for (const rate of [0.3, 2.5, "1.2", NaN, null]) {
            const r = await service.rate({ key: "a", rate });
            assert.equal(r.ok, false, String(rate));
            assert.equal(r.message, "The rate must be between 0.5 and 2", String(rate));
        }
        for (const request of [null, "a", { key: 5, rate: 1 }, { key: "x".repeat(81), rate: 1 }]) {
            assert.deepEqual(await service.rate(request), { ok: false, message: "Bad request" }, JSON.stringify(request));
        }
    } finally {
        setLang("ru");
    }
    assert.equal(queued.length, 0);

    const pending = service.rate({ key: "a", rate: 1.3 });
    service.onResult({ key: "b", text: "chart b", rate: 1, result: OK });
    assert.deepEqual(await pending, { ok: false, stale: true });
});
