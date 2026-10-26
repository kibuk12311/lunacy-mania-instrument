// The create-tab jobs of the worker client (mapgen v3): progress on the way, a timer that progress re-arms,
// one settle per request, and the timing and remap kinds.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkerClient } from "../app/workerClient.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A worker that answers through `script(msg, emit)`; emit(body) posts { id, ...body } back.
function scriptedWorker(script) {
    const w = new EventEmitter();
    w.posted = [];
    w.killed = false;
    w.postMessage = (msg) => {
        w.posted.push(msg);
        script(msg, (body) => w.emit("message", { id: msg.id, ...body }));
    };
    w.kill = () => { w.killed = true; setImmediate(() => w.emit("exit", 1)); };
    return w;
}

test("generate: progress reaches the callback before the result", async () => {
    const w = scriptedWorker((msg, emit) => {
        setTimeout(() => emit({ progress: { phase: "search", i: 1, n: 3 } }), 5);
        setTimeout(() => emit({ progress: { phase: "search", i: 2, n: 3 } }), 10);
        setTimeout(() => emit({ result: { kind: "generated", echo: msg.payload.x } }), 15);
    });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 1000 });
    const seen = [];
    const r = await client.generate({ x: 7 }, (p) => seen.push(p));
    assert.equal(r.echo, 7);
    assert.deepEqual(seen, [{ phase: "search", i: 1, n: 3 }, { phase: "search", i: 2, n: 3 }]);
    assert.equal(w.posted[0].kind, "generate");
    client.dispose();
});

test("generate: each progress message re-arms the timeout", async () => {
    // 6 progress messages 30 ms apart, then the result at 200 ms: longer than the 60 ms limit, but never silent for it
    const w = scriptedWorker((_msg, emit) => {
        for (let k = 1; k <= 6; k += 1) setTimeout(() => emit({ progress: { phase: "search", i: k, n: 6 } }), k * 30);
        setTimeout(() => emit({ result: { kind: "generated" } }), 200);
    });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 60 });
    const r = await client.generate({}, () => {});
    assert.equal(r.kind, "generated");
    assert.equal(w.killed, false);
    client.dispose();
});

test("generate: a silent worker still times out and is killed", async () => {
    const w = scriptedWorker((_msg, emit) => setTimeout(() => emit({ progress: { phase: "prepare", i: 1, n: 1 } }), 10));
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 40 });
    const r = await client.generate({}, () => {});
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
    assert.equal(w.killed, true);
    client.dispose();
});

test("a request settles exactly once: nothing after the timeout reaches the caller", async () => {
    const seen = [];
    let resolved = 0;
    const w = scriptedWorker((_msg, emit) => {
        setTimeout(() => emit({ progress: { phase: "late", i: 1, n: 1 } }), 80);
        setTimeout(() => emit({ result: { kind: "generated" } }), 90);
    });
    w.kill = () => { w.killed = true; }; // the worker keeps talking after the kill
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 30 });
    const r = await client.generate({}, (p) => seen.push(p)).then((x) => { resolved += 1; return x; });
    await sleep(120);
    assert.equal(r.kind, "error");
    assert.equal(resolved, 1);
    assert.deepEqual(seen, []);
    client.dispose();
});

test("a throwing progress callback does not break the request", async () => {
    const w = scriptedWorker((_msg, emit) => {
        setTimeout(() => emit({ progress: { phase: "search", i: 1, n: 1 } }), 5);
        setTimeout(() => emit({ result: { kind: "generated" } }), 10);
    });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 1000 });
    const r = await client.generate({}, () => { throw new Error("window gone"); });
    assert.equal(r.kind, "generated");
    client.dispose();
});

test("detectTiming is the timing kind with its own short limit", async () => {
    const w = scriptedWorker((msg, emit) => {
        if (msg.kind === "timing") emit({ result: { kind: "timing", timing: { bpm: msg.payload.hint.bpm } } });
    });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 1000, timingTimeoutMs: 40 });
    const r = await client.detectTiming({ envelope: {}, hint: { bpm: 174 } });
    assert.deepEqual(r, { kind: "timing", timing: { bpm: 174 } });
    assert.equal(w.posted[0].kind, "timing");

    const silent = scriptedWorker(() => {});
    const slow = createWorkerClient({ spawn: () => silent, timeoutMs: 1000, generateTimeoutMs: 1000, timingTimeoutMs: 30 });
    assert.equal((await slow.detectTiming({ envelope: {} })).kind, "error");
    assert.equal(silent.killed, true);
    client.dispose();
    slow.dispose();
});

test("the default timing limit is 20 s", async () => {
    const w = scriptedWorker(() => {});
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, 0 * ms, ...rest); };
    try {
        const client = createWorkerClient({ spawn: () => w });
        const r = await client.detectTiming({ envelope: {} });
        assert.equal(r.kind, "error");
        client.dispose();
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
    assert.deepEqual(timers, [20_000]);
});

test("remap is the remap kind and passes progress on", async () => {
    const w = scriptedWorker((msg, emit) => {
        emit({ progress: { phase: "search", i: 1, n: 2 } });
        setTimeout(() => emit({ result: { kind: "remapped", path: msg.payload.path } }), 5);
    });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 1000 });
    const seen = [];
    const r = await client.remap({ path: "a.osu" }, (p) => seen.push(p.phase));
    assert.deepEqual(r, { kind: "remapped", path: "a.osu" });
    assert.deepEqual(seen, ["search"]);
    assert.equal(w.posted[0].kind, "remap");
    client.dispose();
});

test("analyze ignores stray progress and still answers", async () => {
    const w = scriptedWorker((msg, emit) => {
        emit({ progress: { phase: "x", i: 1, n: 1 } });
        setTimeout(() => emit({ result: { kind: "ok", rate: msg.rate } }), 5);
    });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000 });
    assert.deepEqual(await client.analyze("x", 1.2), { kind: "ok", rate: 1.2 });
    client.dispose();
});
