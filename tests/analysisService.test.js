import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisService } from "../app/analysisService.js";
import { cacheKey } from "../src/core/cache.js";
import { setLang } from "../src/i18n/i18n.js";

const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

// Worker whose answers are given by hand: calls[i].resolve(result); `peak` is the most calls open at once.
function fakeWorker() {
    const w = { calls: [], open: 0, peak: 0 };
    w.analyze = (text, rate) => {
        w.open += 1;
        w.peak = Math.max(w.peak, w.open);
        return new Promise((resolve) => {
            w.calls.push({ text, rate, resolve: (r) => { w.open -= 1; resolve(r); } });
        });
    };
    return w;
}

function memoryCache(start = {}) {
    const m = new Map(Object.entries(start));
    return { m, sets: [], get: async (k) => m.get(k), async set(k, v) { this.sets.push(k); m.set(k, v); } };
}

function setup(start) {
    const worker = fakeWorker();
    const cache = memoryCache(start);
    const lang = { value: "ru" };
    const analysis = createAnalysisService({ worker, cache, getLang: () => lang.value });
    return { worker, cache, lang, analysis };
}

const OK = { kind: "ok", label: "Gamma mid", numeric: 13 };

test("a cached result comes back without the worker", async () => {
    const { worker, analysis } = setup({ [cacheKey("A", 1.2)]: OK });
    assert.deepEqual(await analysis.analyze("A", 1.2), OK);
    assert.deepEqual(await analysis.analyzeQueued("A", 1.2), OK);
    assert.equal(worker.calls.length, 0);
    assert.equal(analysis.stats().hits, 2);
});

test("a result is cached under cacheKey(text, rate)", async () => {
    const { worker, cache, analysis } = setup();
    const job = analysis.analyze("A", 1.1);
    await flush();
    assert.deepEqual([worker.calls[0].text, worker.calls[0].rate], ["A", 1.1]);
    worker.calls[0].resolve(OK);
    assert.deepEqual(await job, OK);
    assert.deepEqual(cache.sets, [cacheKey("A", 1.1)]);
    assert.deepEqual(await analysis.analyze("A", 1.1), OK);
    assert.equal(worker.calls.length, 1);
    assert.equal(analysis.stats().misses, 1);
});

test("a lasting error is worked out once per language and never written to disk", async () => {
    const { worker, cache, lang, analysis } = setup();
    const notRice = { kind: "error", message: "нет" };
    const first = analysis.analyze("A", 1);
    await flush();
    worker.calls[0].resolve(notRice);
    assert.deepEqual(await first, notRice);
    assert.deepEqual(await analysis.analyze("A", 1), notRice);
    assert.equal(worker.calls.length, 1);
    lang.value = "en";
    const second = analysis.analyzeQueued("A", 1);
    await flush();
    assert.equal(worker.calls.length, 2);
    worker.calls[1].resolve({ kind: "error", message: "no" });
    assert.equal((await second).message, "no");
    assert.deepEqual(cache.sets, []);
});

test("a transient error is kept nowhere", async () => {
    const { worker, cache, analysis } = setup();
    const job = analysis.analyze("A", 1);
    await flush();
    worker.calls[0].resolve({ kind: "error", message: "timeout", transient: true });
    await job;
    const again = analysis.analyze("A", 1);
    await flush();
    assert.equal(worker.calls.length, 2);
    worker.calls[1].resolve(OK);
    assert.deepEqual(await again, OK);
    assert.deepEqual(cache.sets, [cacheKey("A", 1)]);
});

test("two requests for the same chart and rate at once share one worker call", async () => {
    const { worker, analysis } = setup();
    const a = analysis.analyze("A", 1.3);
    const b = analysis.analyze("A", 1.3);
    await flush();
    const c = analysis.analyzeQueued("A", 1.3);
    await flush();
    assert.equal(worker.calls.length, 1);
    worker.calls[0].resolve(OK);
    assert.deepEqual(await Promise.all([a, b, c]), [OK, OK, OK]);
});

test("background analyses go one at a time; a foreground one does not wait for them", async () => {
    const { worker, analysis } = setup();
    const queued = ["A", "B", "C"].map((text) => analysis.analyzeQueued(text, 1));
    await flush();
    assert.equal(worker.calls.length, 1);
    assert.deepEqual(analysis.stats(), { hits: 0, misses: 1, queued: 2, inFlight: 1 });

    const front = analysis.analyze("D", 1);
    await flush();
    assert.deepEqual(worker.calls.map((c) => c.text), ["A", "D"]);
    worker.calls[1].resolve({ ...OK, text: "D" });
    assert.equal((await front).text, "D");

    for (const text of ["A", "B", "C"]) {
        const call = worker.calls.find((c) => c.text === text);
        assert.ok(call, `${text} reached the worker`);
        call.resolve({ ...OK, text });
        await flush();
    }
    assert.deepEqual((await Promise.all(queued)).map((r) => r.text), ["A", "B", "C"]);
    assert.equal(worker.peak, 2); // one background + one foreground, never two background
    assert.deepEqual(analysis.stats(), { hits: 0, misses: 4, queued: 0, inFlight: 0 });
});

test("a background analysis cancelled while waiting never reaches the worker", async () => {
    const { worker, cache, analysis } = setup();
    let stale = false;
    const first = analysis.analyzeQueued("A", 1);
    const second = analysis.analyzeQueued("B", 1, { isCancelled: () => stale });
    await flush();
    stale = true;
    worker.calls[0].resolve(OK);
    await first;
    const r = await second;
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
    assert.equal(r.cancelled, true);
    assert.equal(r.message, "Отменено");
    assert.deepEqual(worker.calls.map((c) => c.text), ["A"]);
    assert.deepEqual(cache.sets, [cacheKey("A", 1)]);
});

test("the cancelled answer follows the language", async () => {
    const { analysis } = setup();
    setLang("en");
    try {
        assert.equal((await analysis.enqueue(async () => 1, { isCancelled: () => true })).message, "Cancelled");
    } finally {
        setLang("ru");
    }
});

test("enqueue shares the same background line", async () => {
    const { worker, analysis } = setup();
    let startedBefore = null; // the worker calls made when the job started
    const a = analysis.analyzeQueued("A", 1);
    const job = analysis.enqueue(async () => { startedBefore = worker.calls.map((c) => c.text); return "done"; });
    const c = analysis.analyzeQueued("C", 1);
    await flush();
    assert.equal(startedBefore, null, "the job waits for A");
    assert.deepEqual(worker.calls.map((x) => x.text), ["A"]);
    worker.calls[0].resolve(OK);
    assert.equal(await job, "done");
    assert.deepEqual(startedBefore, ["A"], "C waits for the job");
    await flush();
    assert.deepEqual(worker.calls.map((x) => x.text), ["A", "C"]);
    worker.calls[1].resolve(OK);
    assert.deepEqual(await Promise.all([a, c]), [OK, OK]);
    // a job that throws answers an error and does not block the line
    const bad = await analysis.enqueue(async () => { throw new Error("boom"); });
    assert.equal(bad.kind, "error");
    assert.equal(bad.message, "boom");
    assert.equal(await analysis.enqueue(async () => 7), 7);
});

test("a worker or cache that throws still gives an answer", async () => {
    const analysis = createAnalysisService({
        worker: { analyze: async () => { throw new Error("gone"); } },
        cache: { get: async () => { throw new Error("disk"); }, set: async () => { throw new Error("disk"); } },
        getLang: () => "ru",
    });
    const r = await analysis.analyze("A", 1);
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
    const okWorker = createAnalysisService({ worker: { analyze: async () => OK }, cache: { get: async () => undefined, set: async () => { throw new Error("disk full"); } }, getLang: () => "ru" });
    assert.deepEqual(await okWorker.analyzeQueued("A", 1), OK);
});

// A pool like app/workerPool.js whose answers are given by hand (the same shape as fakeWorker).
function fakePool(size) {
    return Object.assign(fakeWorker(), { size, stats: () => ({ size }) });
}

function setupPool(size, start) {
    const worker = fakeWorker();
    const pool = fakePool(size);
    const cache = memoryCache(start);
    const analysis = createAnalysisService({ worker, pool, cache, getLang: () => "ru" });
    return { worker, pool, cache, analysis };
}

test("with a pool the background line runs `size` jobs at once on it; the card's worker gets none of them", async () => {
    const { worker, pool, analysis } = setupPool(3);
    assert.equal(analysis.lanes, 3);
    const queued = ["A", "B", "C", "D", "E"].map((text) => analysis.analyzeQueued(text, 1));
    await flush();
    assert.deepEqual(pool.calls.map((c) => c.text), ["A", "B", "C"]);
    assert.deepEqual(analysis.stats(), { hits: 0, misses: 3, queued: 2, inFlight: 3, bulk: { size: 3 } });

    // the card goes straight to its own worker, however full the line is
    const front = analysis.analyze("F", 1);
    await flush();
    assert.deepEqual(worker.calls.map((c) => c.text), ["F"]);
    worker.calls[0].resolve({ ...OK, text: "F" });
    assert.equal((await front).text, "F");

    pool.calls[1].resolve({ ...OK, text: "B" });
    await flush();
    assert.deepEqual(pool.calls.map((c) => c.text), ["A", "B", "C", "D"], "D takes B's slot");
    while (pool.calls.length < 5 || pool.calls.some((c) => !c.done)) {
        for (const c of pool.calls.filter((x) => !x.done)) { c.done = true; c.resolve({ ...OK, text: c.text }); }
        await flush();
    }
    assert.deepEqual((await Promise.all(queued)).map((r) => r.text), ["A", "B", "C", "D", "E"]);
    assert.equal(pool.peak, 3);
    assert.equal(worker.calls.length, 1, "only the card's");
    assert.deepEqual(analysis.stats(), { hits: 0, misses: 6, queued: 0, inFlight: 0, bulk: { size: 3 } });
});

test("a job of the line is given the worker the line runs on: the pool, or the card's worker without one", async () => {
    const { pool, analysis } = setupPool(2);
    assert.equal(await analysis.enqueue(async (on) => on === pool), true);
    const plain = setup();
    assert.equal(await plain.analysis.enqueue(async (on) => on === plain.worker), true);
    assert.equal(plain.analysis.lanes, 1);
});

test("with a pool a cancelled job still never reaches a worker, and the others take its slot", async () => {
    const { pool, analysis } = setupPool(2);
    let stale = false;
    const a = analysis.analyzeQueued("A", 1);
    const b = analysis.analyzeQueued("B", 1);
    const c = analysis.analyzeQueued("C", 1, { isCancelled: () => stale });
    const d = analysis.analyzeQueued("D", 1);
    await flush();
    stale = true;
    pool.calls[0].resolve(OK);
    await flush();
    assert.equal((await c).cancelled, true);
    assert.deepEqual(pool.calls.map((x) => x.text), ["A", "B", "D"]);
    pool.calls[1].resolve(OK);
    pool.calls[2].resolve(OK);
    assert.deepEqual(await Promise.all([a, b, d]), [OK, OK, OK]);
});

test("the pool's answers are the shared cache's: a hit needs no worker, a result is cached, a chart already asked for is shared", async () => {
    const { worker, pool, cache, analysis } = setupPool(2, { [cacheKey("A", 1)]: OK });
    assert.deepEqual(await analysis.analyzeQueued("A", 1), OK);
    assert.equal(pool.calls.length, 0);

    const b = analysis.analyzeQueued("B", 1);
    await flush();
    pool.calls[0].resolve({ ...OK, text: "B" });
    await b;
    assert.deepEqual(cache.sets, [cacheKey("B", 1)]);
    assert.equal((await analysis.analyze("B", 1)).text, "B", "the card finds the line's answer");
    assert.equal(worker.calls.length, 0);

    // the card asked first: the line waits for that answer instead of a second analysis, and the other way round
    const card = analysis.analyze("C", 1);
    await flush();
    const lineC = analysis.analyzeQueued("C", 1);
    const lineE = analysis.analyzeQueued("E", 1);
    await flush();
    const cardE = analysis.analyze("E", 1);
    await flush();
    assert.deepEqual(worker.calls.map((c) => c.text), ["C"]);
    assert.deepEqual(pool.calls.map((c) => c.text), ["B", "E"]);
    worker.calls[0].resolve({ ...OK, text: "C" });
    pool.calls[1].resolve({ ...OK, text: "E" });
    assert.deepEqual([(await card).text, (await lineC).text, (await lineE).text, (await cardE).text], ["C", "C", "E", "E"]);
});

test("bulk (the Session library) is the line, bulk.lanes of it at once; no pool or an empty one: one", async () => {
    const { pool, analysis } = setupPool(4);
    assert.equal(analysis.bulk.lanes, 4);
    const job = analysis.bulk("A", 1);
    await flush();
    assert.deepEqual(pool.calls.map((c) => c.text), ["A"]);
    pool.calls[0].resolve(OK);
    assert.deepEqual(await job, OK);
    for (const p of [null, fakePool(0)]) {
        const worker = fakeWorker();
        const plain = createAnalysisService({ worker, pool: p, cache: memoryCache(), getLang: () => "ru" });
        assert.equal(plain.bulk.lanes, 1);
        assert.equal(plain.lanes, 1);
        const jobs = [plain.bulk("A", 1), plain.bulk("B", 1)];
        await flush();
        assert.deepEqual(worker.calls.map((c) => c.text), ["A"], "one at a time on the card's worker, as before");
        worker.calls[0].resolve(OK);
        await flush();
        worker.calls[1].resolve(OK);
        assert.deepEqual(await Promise.all(jobs), [OK, OK]);
    }
});

test("the card waiting for its chart on the line's worker tries its own when that one comes to nothing", async () => {
    const { worker, pool, analysis } = setupPool(2);
    const line = analysis.analyzeQueued("A", 1);
    await flush();
    const card = analysis.analyze("A", 1);
    await flush();
    assert.equal(worker.calls.length, 0, "the card shares the analysis under way");
    pool.calls[0].resolve({ kind: "error", message: "timeout", transient: true });
    await flush();
    assert.deepEqual(worker.calls.map((c) => c.text), ["A"], "then its own worker");
    worker.calls[0].resolve(OK);
    assert.deepEqual(await card, OK);
    assert.equal((await line).transient, true, "the line's own answer is the line's");
    // the card's own worker timing out is not tried again
    const again = analysis.analyze("B", 1);
    await flush();
    worker.calls[1].resolve({ kind: "error", message: "timeout", transient: true });
    assert.equal((await again).transient, true);
    assert.equal(worker.calls.length, 2);
});

test("the real pool under the service: never more than its size at once, begun in turn, every job answered", async () => {
    const { createWorkerPool } = await import("../app/workerPool.js");
    let open = 0;
    let peak = 0;
    const begun = [];
    const pool = createWorkerPool({
        spawn: () => null, size: 3,
        client: () => ({
            analyze: async (text) => {
                begun.push(text);
                open += 1;
                peak = Math.max(peak, open);
                await new Promise((r) => setTimeout(r, 2 + (Number(text.slice(1)) % 4) * 3));
                open -= 1;
                return { ...OK, text };
            },
            dispose() {},
        }),
    });
    const analysis = createAnalysisService({ worker: fakeWorker(), pool, cache: memoryCache(), getLang: () => "ru" });
    const texts = Array.from({ length: 12 }, (_, i) => `M${i}`);
    assert.deepEqual((await Promise.all(texts.map((x) => analysis.analyzeQueued(x, 1)))).map((r) => r.text), texts);
    assert.deepEqual(begun, texts, "first come, first begun, whatever order they end in");
    assert.equal(peak, 3);
    pool.dispose();
});

test("the card's analysis warms the pool, so the details after it find a worker started", async () => {
    const { worker, pool, analysis } = setupPool(2);
    let warmed = 0;
    pool.warm = () => { warmed += 1; };
    const card = analysis.analyze("A", 1);
    assert.equal(warmed, 1);
    await flush();
    worker.calls[0].resolve(OK);
    await card;
    const line = analysis.analyzeQueued("B", 1);
    await flush();
    assert.equal(warmed, 1, "only the foreground warms it");
    pool.calls[0].resolve(OK);
    await line;
    const plain = setup();
    const c = plain.analysis.analyze("C", 1); // no pool: nothing to warm, nothing thrown
    await flush();
    plain.worker.calls[0].resolve(OK);
    assert.deepEqual(await c, OK);
});
