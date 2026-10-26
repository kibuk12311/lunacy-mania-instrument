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
