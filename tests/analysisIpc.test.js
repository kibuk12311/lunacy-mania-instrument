// registerAnalysisIpc hangs the analysis-rate channel and the result / window-load hooks, and does nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { registerAnalysisIpc } from "../app/analysisIpc.js";
import { createHooks } from "../app/hooks.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeDeps() {
    const handlers = new Map();
    const sent = [];
    const calls = [];
    const hooks = createHooks();
    const deps = {
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: (channel) => { throw new Error(`unexpected on(${channel})`); } },
        hooks,
        send: (channel, payload) => sent.push([channel, payload]),
        log: () => {},
        t: (key) => key,
        worker: { details: async () => { calls.push("details"); return { kind: "details", details: { v: 2, strain: [1], families: ["stream"], hardest: [], durationSec: 1, flavours: [], flavourBins: ["-"] } }; } },
        analysis: {
            enqueue: async (fn) => fn(),
            analyzeQueued: async (_text, rate) => { calls.push(`queued ${rate}`); return { kind: "ok", label: "Delta mid", numeric: 14, primary: "Stream" }; },
        },
        resultCache: { get: async () => undefined, set: async () => {} },
    };
    return { deps, handlers, sent, calls, hooks };
}

test("registers analysis-rate and both hooks, without calling anything", () => {
    const { deps, handlers, calls } = fakeDeps();
    const on = [];
    const hooks = deps.hooks;
    deps.hooks = { on: (name, fn) => { on.push(name); return hooks.on(name, fn); }, emit: hooks.emit };
    registerAnalysisIpc(deps);
    assert.deepEqual([...handlers.keys()], ["analysis-rate"]);
    assert.deepEqual(on.sort(), ["result", "window-load"]);
    assert.deepEqual(calls, []);
});

test("a result sends its details on analysis-details, and the page gets them again after a reload", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { deps, sent, hooks, handlers } = fakeDeps();
    registerAnalysisIpc(deps);
    hooks.emit("result", { key: "k@1.000", text: "chart", rate: 1, result: { kind: "ok" } });
    t.mock.timers.tick(300);
    await flush();
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "analysis-details");
    assert.equal(sent[0][1].key, "k@1.000");
    hooks.emit("window-load");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);

    const answer = await handlers.get("analysis-rate")({}, { key: "k@1.000", rate: 1.2 });
    assert.deepEqual(answer, { ok: true, rate: 1.2, kind: "ok", label: "Delta mid", numeric: 14, primary: "Stream" });
    assert.deepEqual(await handlers.get("analysis-rate")({}, { key: "other", rate: 1.2 }), { ok: false, stale: true });
});

test("a page reload before any details sends nothing", () => {
    const { deps, sent, hooks } = fakeDeps();
    registerAnalysisIpc(deps);
    hooks.emit("window-load");
    assert.deepEqual(sent, []);
});
