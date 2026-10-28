// background/analysisHost.js: one job at a time, high → normal → low then first come first served, shared jobs by
// key with a priority bump, the 60 s timeout that restarts the worker; the Worker runner (messages, errors, reset)
// and the offscreen runner (one document, R1 targets).
import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisHost, createOffscreenRunner, createWorkerRunner } from "../../../extension/background/analysisHost.js";
import { ERR, OFFSCREEN_TARGET } from "../../../extension/shared/protocol.js";

// A runner whose jobs the test finishes by hand.
function manualRunner() {
    const started = [];
    let resets = 0;
    return {
        started,
        get resets() {
            return resets;
        },
        run(job) {
            return new Promise((resolve) => started.push({ ...job, resolve }));
        },
        reset() {
            resets += 1;
        },
    };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("one job at a time, by priority, then in order", async () => {
    const runner = manualRunner();
    const host = createAnalysisHost({ runner });
    const order = [];
    const ask = (name, priority) => host.analyze(name, 1, priority).then((a) => order.push([name, a.result]));
    ask("first", "low");
    ask("n1", "normal");
    ask("l1", "low");
    ask("h1", "high");
    ask("n2", "normal");
    ask("h2", "high");
    assert.equal(runner.started.length, 1, "only one runs");
    assert.equal(host.pending, 6);
    for (let i = 0; i < 6; i += 1) {
        await flush();
        const job = runner.started[i];
        job.resolve({ ok: true, result: job.text.toUpperCase() });
        await flush();
    }
    assert.deepEqual(runner.started.map((j) => j.text), ["first", "h1", "h2", "n1", "n2", "l1"]);
    assert.deepEqual(order.map((o) => o[0]), ["first", "h1", "h2", "n1", "n2", "l1"]);
    assert.equal(order[1][1], "H1");
    assert.equal(host.pending, 0);
});

test("jobs with one key share an answer; a more urgent ask moves the queued job up", async () => {
    const runner = manualRunner();
    const host = createAnalysisHost({ runner });
    const busy = host.analyze("busy", 1, "high");
    const a = host.analyze("map", 1.2, "low", "fp|m|1.20");
    const other = host.analyze("other", 1, "normal");
    const b = host.analyze("map", 1.2, "high", "fp|m|1.20");
    assert.equal(a, b, "the same promise");
    assert.equal(host.pending, 3);
    assert.equal(host.bump("fp|m|1.20", "high"), true);
    assert.equal(host.bump("nope", "high"), false);
    runner.started[0].resolve({ ok: true, result: 1 });
    await busy;
    await flush();
    assert.equal(runner.started[1].text, "map", "moved ahead of the normal job");
    runner.started[1].resolve({ ok: true, result: { kind: "ok" } });
    assert.deepEqual(await a, { ok: true, result: { kind: "ok" } });
    await flush();
    runner.started[2].resolve({ ok: false, code: "analysis", message: "boom" });
    assert.deepEqual(await other, { ok: false, code: ERR.ANALYSIS, message: "boom" });
});

test("a job past the timeout answers timeout, resets the worker, and the queue goes on", async () => {
    const runner = manualRunner();
    const timers = [];
    const host = createAnalysisHost({
        runner, timeoutMs: 60_000,
        setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
        clearTimer: (id) => {
            if (timers[id]) timers[id].cleared = true;
        },
    });
    const stuck = host.analyze("stuck", 1);
    const next = host.analyze("next", 1);
    assert.equal(timers[0].ms, 60_000);
    timers[0].fn();
    assert.deepEqual(await stuck, { ok: false, code: ERR.TIMEOUT, message: "no answer in 60 s" });
    assert.equal(runner.resets, 1);
    await flush();
    assert.equal(runner.started[1].text, "next");
    runner.started[0].resolve({ ok: true, result: "late" }); // ignored
    runner.started[1].resolve({ ok: true, result: "fine" });
    assert.deepEqual(await next, { ok: true, result: "fine" });
    assert.ok(timers[1].cleared);
    // a runner that throws or rejects is an analysis error
    const throwing = createAnalysisHost({ runner: { run: () => { throw new Error("no worker"); }, reset() {} } });
    assert.deepEqual(await throwing.analyze("x", 1), { ok: false, code: ERR.ANALYSIS, message: "no worker" });
});

// A fake Worker: answers each job with handler(data) or stays silent, can fail.
class FakeWorker extends EventTarget {
    static made = [];
    constructor(handler) {
        super();
        this.handler = handler;
        this.terminated = false;
        this.posted = [];
        FakeWorker.made.push(this);
    }
    postMessage(data) {
        this.posted.push(data);
        const answer = this.handler(data, this);
        if (answer) setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: answer })), 0);
    }
    terminate() {
        this.terminated = true;
    }
}

test("the Worker runner: answers by id, a crashed worker is made again, reset terminates it", async () => {
    FakeWorker.made = [];
    let mode = "ok";
    const runner = createWorkerRunner(() => new FakeWorker((data, w) => {
        if (mode === "ok") return { id: data.id, ok: true, result: { kind: "ok", text: data.text, rate: data.rate } };
        if (mode === "fail") return { id: data.id, ok: false, code: "analysis", message: "bad chart" };
        if (mode === "crash") setTimeout(() => w.dispatchEvent(Object.assign(new Event("error"), { message: "wasm trap" })), 0);
        return null;
    }));
    assert.deepEqual(await runner.run({ text: "a", rate: 1.2 }), { ok: true, result: { kind: "ok", text: "a", rate: 1.2 } });
    mode = "fail";
    assert.deepEqual(await runner.run({ text: "b", rate: 1 }), { ok: false, code: "analysis", message: "bad chart" });
    assert.equal(FakeWorker.made.length, 1, "one worker for many jobs");
    mode = "crash";
    assert.deepEqual(await runner.run({ text: "c", rate: 1 }), { ok: false, code: "analysis", message: "wasm trap" });
    assert.ok(FakeWorker.made[0].terminated);
    mode = "silent";
    const hanging = runner.run({ text: "d", rate: 1 });
    assert.equal(FakeWorker.made.length, 2, "a new worker after the crash");
    runner.reset();
    assert.deepEqual(await hanging, { ok: false, code: ERR.TIMEOUT, message: "the analysis worker was restarted" });
    assert.ok(FakeWorker.made[1].terminated);
    assert.equal(runner.alive, false);
    mode = "ok";
    assert.equal((await runner.run({ text: "e", rate: 1 })).ok, true);
    assert.equal(FakeWorker.made.length, 3);
    // a stale answer of a terminated worker is ignored
    FakeWorker.made[1].dispatchEvent(new MessageEvent("message", { data: { id: 99, ok: true } }));
});

test("with the Worker runner, the job after a timed-out one runs on a fresh Worker", async () => {
    FakeWorker.made = [];
    const runner = createWorkerRunner(() => new FakeWorker((data) => (data.text === "hang" ? null : { id: data.id, ok: true, result: data.text })));
    const host = createAnalysisHost({ runner, timeoutMs: 30 });
    const hang = host.analyze("hang", 1);
    const next = host.analyze("next", 1);
    assert.deepEqual(await hang, { ok: false, code: ERR.TIMEOUT, message: "no answer in 0 s" });
    assert.deepEqual(await next, { ok: true, result: "next" });
    assert.equal(FakeWorker.made.length, 2, "a new worker for the next job");
    assert.ok(FakeWorker.made[0].terminated);
    assert.equal(FakeWorker.made[1].terminated, false);
});

test("the offscreen runner makes one document (WORKERS) and sends targeted jobs", async () => {
    const created = [];
    let contexts = [];
    const sent = [];
    const chrome = {
        runtime: {
            getURL: (p) => `chrome-extension://x/${p}`,
            getContexts: async (filter) => {
                assert.deepEqual(filter, { contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: ["chrome-extension://x/offscreen/offscreen.html"] });
                return contexts;
            },
            sendMessage: async (message) => {
                sent.push(message);
                return message.type === "lm:job" ? { ok: true, result: { rate: message.rate } } : { ok: true };
            },
        },
        offscreen: {
            createDocument: async (options) => {
                created.push(options);
                await new Promise((r) => setTimeout(r, 5));
                contexts = [{ contextType: "OFFSCREEN_DOCUMENT" }];
            },
        },
    };
    const runner = createOffscreenRunner(chrome);
    const answers = await Promise.all([runner.run({ text: "a", rate: 1 }), runner.run({ text: "b", rate: 1.5 })]);
    assert.deepEqual(answers, [{ ok: true, result: { rate: 1 } }, { ok: true, result: { rate: 1.5 } }]);
    assert.equal(created.length, 1, "one createDocument for concurrent jobs");
    assert.deepEqual(created[0], { url: "offscreen/offscreen.html", reasons: ["WORKERS"], justification: "Runs the dan analyzer (WebAssembly) in a worker" });
    assert.ok(sent.every((m) => m.target === OFFSCREEN_TARGET && m.type === "lm:job" && typeof m.jobId === "number"));
    runner.reset();
    await flush();
    assert.deepEqual(sent.at(-1), { target: OFFSCREEN_TARGET, type: "lm:reset" });
});
