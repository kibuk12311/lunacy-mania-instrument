// The dan by part in main (app/analysisSections.js): worked out once per map and rate in the background line after the
// card, cached under its own key, sent for the current map only, again after a page reload; registered next to the
// details (app/analysisIpc.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createSectionsService, looksLikeSections, sectionsKey } from "../app/analysisSections.js";
import { registerAnalysisIpc } from "../app/analysisIpc.js";
import { createHooks } from "../app/hooks.js";
import { SECTIONS_VERSION } from "../src/analysis/sections.js";

const flush = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const SECTIONS = { v: SECTIONS_VERSION, rate: 1, durationSec: 90, top: 1, parts: [{ fromSec: 0, toSec: 40, dan: 12 }, { fromSec: 40, toSec: 90, dan: 13.4 }] };
const OK = { kind: "ok", numeric: 13 };

function setup({ answer = async () => ({ kind: "sections", sections: SECTIONS }), store = new Map() } = {}) {
    const sent = [];
    const jobs = [];
    const timers = [];
    const service = createSectionsService({
        analysis: { enqueue: async (fn, { isCancelled } = {}) => (isCancelled?.() ? { kind: "error", cancelled: true, transient: true } : fn()) },
        worker: { sections: async (text, rate) => { jobs.push([text, rate]); return answer(text, rate); } },
        cache: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } },
        send: (p) => sent.push(p),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: () => {},
    });
    const fire = () => {
        const list = timers.splice(0);
        for (const { fn } of list) fn();
    };
    return { service, sent, jobs, timers, fire, store };
}

test("the parts of an ok card come after a delay, from the worker once, cached and sent with their key", async () => {
    const { service, sent, jobs, timers, fire, store } = setup();
    service.onResult({ key: "k@1.000", text: "chart", rate: 1.2, result: OK });
    assert.equal(timers[0].ms, 500, "after the details' 300 ms");
    fire();
    await flush();
    assert.deepEqual(jobs, [["chart", 1.2]]);
    assert.deepEqual(sent, [{ key: "k@1.000", sections: SECTIONS }]);
    assert.deepEqual(store.get(sectionsKey("k@1.000")), SECTIONS);
    assert.deepEqual(service.last(), sent[0]);
    // the same map again: from the cache, no worker
    service.onResult({ key: "k@1.000", text: "chart", rate: 1.2, result: OK });
    fire();
    await flush();
    assert.equal(jobs.length, 1);
    assert.equal(sent.length, 2);
    assert.ok(sectionsKey("k").includes(`#sections${SECTIONS_VERSION}.`), "a key of its own, with the parts' version");
});

test("another map before the delay or while it is worked out: only the current one is ever sent", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { service, sent, jobs, fire } = setup({ answer: async () => { await gate; return { kind: "sections", sections: SECTIONS }; } });
    service.onResult({ key: "a", text: "A", rate: 1, result: OK });
    fire();
    await flush(); // a's job is on its way
    service.onResult({ key: "b", text: "B", rate: 1, result: OK });
    release();
    await flush();
    assert.deepEqual(sent, [], "a came back after b was selected");
    fire();
    await flush();
    assert.deepEqual(jobs.map((j) => j[0]), ["A", "B"]);
    assert.deepEqual(sent.map((p) => p.key), ["b"]);
    assert.equal(service.last().key, "b");
    // a map left before its delay is not worked out at all
    service.onResult({ key: "c", text: "C", rate: 1, result: OK });
    service.onResult({ key: "d", text: "D", rate: 1, result: { kind: "too-short" } });
    fire();
    await flush();
    assert.equal(jobs.length, 2);
});

test("nothing for a card without a dan or a key; a failure is sent as null and not cached", async () => {
    const { service, sent, timers, fire, store } = setup({ answer: async () => ({ kind: "error", message: "boom" }) });
    service.onResult({ key: "a", text: "A", rate: 1, result: { kind: "not-rice" } });
    service.onResult({ key: null, text: "A", rate: 1, result: OK });
    service.onResult({ key: "a", text: "A", rate: 9, result: OK });
    assert.equal(timers.length, 0);
    service.onResult({ key: "a", text: "A", rate: 1, result: OK });
    fire();
    await flush();
    assert.deepEqual(sent, [{ key: "a", sections: null }]);
    assert.equal(store.size, 0);
    // a cached answer of another shape is not served
    store.set(sectionsKey("c"), { v: 0, parts: [] });
    assert.equal(looksLikeSections(store.get(sectionsKey("c"))), false);
    assert.equal(looksLikeSections(SECTIONS), true);
});

test("registered with the details: a result sends its parts on analysis-sections, again after a reload", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sent = [];
    const hooks = createHooks();
    registerAnalysisIpc({
        ipcMain: { handle: () => {} },
        hooks,
        send: (channel, payload) => sent.push([channel, payload]),
        log: () => {},
        worker: {
            details: async () => ({ kind: "details", details: { v: 2, strain: [1], families: ["stream"], hardest: [], durationSec: 1, flavours: [], flavourBins: ["-"] } }),
            sections: async () => ({ kind: "sections", sections: SECTIONS }),
        },
        analysis: { enqueue: async (fn) => fn(), analyzeQueued: async () => OK },
        resultCache: { get: async () => undefined, set: async () => {} },
    });
    hooks.emit("result", { key: "k@1.000", text: "chart", rate: 1, result: OK });
    t.mock.timers.tick(300);
    await flush();
    t.mock.timers.tick(200);
    await flush();
    assert.deepEqual(sent.map(([c]) => c), ["analysis-details", "analysis-sections"]);
    assert.deepEqual(sent[1][1], { key: "k@1.000", sections: SECTIONS });
    hooks.emit("window-load");
    assert.deepEqual(sent.slice(2).map(([c]) => c), ["analysis-details", "analysis-sections"]);
});

test("the parts run on the worker the background line gives (its pool), not on the card's", async () => {
    const sent = [];
    const timers = [];
    const pool = { calls: [], sections: async (text, rate) => { pool.calls.push([text, rate]); return { kind: "sections", sections: SECTIONS }; } };
    const service = createSectionsService({
        analysis: { enqueue: async (fn) => fn(pool) },
        worker: { sections: async () => assert.fail("the card's worker is not the line's") },
        cache: { get: async () => undefined, set: async () => {} },
        send: (p) => sent.push(p),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: () => {},
    });
    service.onResult({ key: "k@1.000", text: "chart", rate: 1.2, result: OK });
    for (const { fn } of timers.splice(0)) fn();
    await flush();
    assert.deepEqual(pool.calls, [["chart", 1.2]]);
    assert.equal(sent.at(-1)?.sections?.parts?.length, 2);
});
