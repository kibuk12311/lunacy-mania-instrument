// The Session library's own analysis workers (app/workerPool.js) over fake worker clients: at most `size` jobs at once,
// the rest in turn, workers started on demand and stopped when idle, and the pool's size from the cores.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkerPool, poolSize, belowNormal } from "../app/workerPool.js";

const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Clients whose answers are given by hand: calls[i].resolve(result); `open` / `peak`: jobs open now / at most.
function fakeClients() {
    const f = { made: [], calls: [], open: 0, peak: 0 };
    f.client = ({ spawn }) => {
        const c = { spawn, disposed: false, n: f.made.length };
        c.analyze = (text, rate) => {
            f.open += 1;
            f.peak = Math.max(f.peak, f.open);
            return new Promise((resolve) => {
                const call = { text, rate, client: c.n, answered: false };
                call.resolve = (r) => { call.answered = true; f.open -= 1; resolve(r); };
                f.calls.push(call);
            });
        };
        c.dispose = () => { c.disposed = true; };
        f.made.push(c);
        return c;
    };
    return f;
}

const OK = { kind: "ok", numeric: 10 };

test("at most `size` jobs at once, one per worker; the rest wait their turn, first come first", async () => {
    const f = fakeClients();
    const spawn = () => null;
    const pool = createWorkerPool({ spawn, size: 3, client: f.client });
    const jobs = ["A", "B", "C", "D", "E", "F"].map((text) => pool.analyze(text, 1));
    await flush();
    assert.deepEqual(f.calls.map((c) => c.text), ["A", "B", "C"]);
    assert.equal(f.made.length, 3);
    assert.ok(f.made.every((c) => c.spawn === spawn), "every worker is the pool's spawn");
    assert.deepEqual(new Set(f.calls.map((c) => c.client)).size, 3, "one job per worker");
    assert.deepEqual(pool.stats(), { size: 3, workers: 3, busy: 3, queued: 3 });

    f.calls[1].resolve({ ...OK, text: "B" });
    await flush();
    assert.deepEqual(f.calls.map((c) => c.text), ["A", "B", "C", "D"], "D takes B's worker");
    assert.equal(f.calls[3].client, f.calls[1].client);
    // the rest answered as they reach a worker
    while (f.calls.some((c) => !c.answered) || f.calls.length < 6) {
        for (const c of f.calls.filter((x) => !x.answered)) c.resolve({ ...OK, text: c.text });
        await flush();
    }
    assert.deepEqual(f.calls.map((c) => c.text), ["A", "B", "C", "D", "E", "F"], "in the order they were asked");
    assert.deepEqual((await Promise.all(jobs)).map((r) => r.text), ["A", "B", "C", "D", "E", "F"]);
    assert.equal(f.peak, 3, "never more than three at once");
    assert.equal(f.made.length, 3, "no fourth worker");
    assert.deepEqual(pool.stats(), { size: 3, workers: 3, busy: 0, queued: 0 });
    pool.dispose();
});

test("a worker starts with the first job it gets and stops after idleMs without one", async () => {
    const f = fakeClients();
    const pool = createWorkerPool({ spawn: () => null, size: 4, idleMs: 40, client: f.client });
    assert.equal(f.made.length, 0, "nothing starts before there is work");
    const one = pool.analyze("A", 1);
    await flush();
    assert.equal(f.made.length, 1, "one job, one worker");
    f.calls[0].resolve(OK);
    await one;
    // jobs one after another keep to the same worker
    const two = pool.analyze("B", 1);
    await flush();
    f.calls[1].resolve(OK);
    await two;
    assert.equal(f.made.length, 1);
    assert.equal(f.made[0].disposed, false);
    await wait(80);
    assert.equal(f.made[0].disposed, true, "stopped once idle");
    assert.equal(pool.stats().workers, 0);
    // more work: a fresh worker
    const three = pool.analyze("C", 1);
    await flush();
    assert.equal(f.made.length, 2);
    f.calls[2].resolve(OK);
    assert.deepEqual(await three, OK);
    pool.dispose();
});

test("a job that throws answers a transient error and its worker takes the next job", async () => {
    let n = 0;
    const pool = createWorkerPool({
        spawn: () => null, size: 1,
        client: () => ({ analyze: async (text) => { n += 1; if (text === "bad") throw new Error("gone"); return OK; }, dispose() {} }),
    });
    const [bad, good] = await Promise.all([pool.analyze("bad", 1), pool.analyze("good", 1)]);
    assert.equal(bad.kind, "error");
    assert.equal(bad.transient, true);
    assert.equal(bad.message, "gone");
    assert.deepEqual(good, OK);
    assert.equal(n, 2);
    pool.dispose();
});

test("dispose answers the waiting jobs and stops every worker", async () => {
    const f = fakeClients();
    const pool = createWorkerPool({ spawn: () => null, size: 1, client: f.client });
    const running = pool.analyze("A", 1);
    const waiting = pool.analyze("B", 1);
    await flush();
    pool.dispose();
    const r = await waiting;
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
    assert.equal(f.made[0].disposed, true);
    f.calls[0].resolve({ kind: "error", message: "closing", transient: true }); // what a disposed client answers
    assert.equal((await running).transient, true);
    assert.equal((await pool.analyze("C", 1)).transient, true, "a closed pool takes no more work");
    assert.equal(f.calls.length, 1);
});

test("an empty pool answers at once instead of keeping the job", async () => {
    const pool = createWorkerPool({ spawn: () => null, size: 0, client: () => assert.fail("no worker for an empty pool") });
    const r = await pool.analyze("A", 1);
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
});

test("poolSize: the cores less two (main and the card's worker), at most four, none with two cores or fewer", () => {
    const GB = 2 ** 30;
    assert.equal(poolSize(16, 32 * GB), 4);
    assert.equal(poolSize(6, 32 * GB), 4);
    assert.equal(poolSize(5, 32 * GB), 3);
    assert.equal(poolSize(3, 32 * GB), 1);
    assert.equal(poolSize(2, 32 * GB), 0);
    assert.equal(poolSize(1, 32 * GB), 0);
    assert.equal(poolSize(NaN, 32 * GB), 0);
    assert.ok(poolSize() >= 0 && poolSize() <= 4, "this machine's");
});

test("poolSize leaves 4 GB to the rest and takes 2 GB a worker beyond: 8 GB two, 6 GB one, 4 GB none", () => {
    const GB = 2 ** 30;
    assert.deepEqual([4, 6, 8, 10, 12, 16, 64].map((gb) => poolSize(16, gb * GB)), [0, 1, 2, 3, 4, 4, 4]);
    assert.equal(poolSize(4, 8 * GB), 2, "the smaller of the two");
    assert.equal(poolSize(3, 16 * GB), 1);
    assert.equal(poolSize(16, NaN), 0);
});

test("no second worker starts while free memory is short: the jobs wait for the one there is", async () => {
    const f = fakeClients();
    let room = false;
    const pool = createWorkerPool({ spawn: () => null, size: 3, client: f.client, room: () => room });
    const jobs = ["A", "B", "C"].map((text) => pool.analyze(text, 1));
    await flush();
    assert.equal(f.made.length, 1, "the first always starts");
    assert.deepEqual(pool.stats(), { size: 3, workers: 1, busy: 1, queued: 2 });
    room = true;
    f.calls[0].resolve({ ...OK, text: "A" });
    await flush();
    const late = pool.analyze("D", 1);
    await flush();
    assert.ok(f.made.length >= 2, "with room again, more start");
    while (f.calls.length < 4 || f.calls.some((c) => !c.answered)) {
        for (const c of f.calls.filter((x) => !x.answered)) c.resolve({ ...OK, text: c.text });
        await flush();
    }
    assert.deepEqual((await Promise.all([...jobs, late])).map((r) => r.text), ["A", "B", "C", "D"]);
    pool.dispose();
});

test("belowNormal lowers a worker's priority once it has a pid; an OS that says no leaves it as it is", () => {
    const set = [];
    const child = new EventEmitter();
    assert.equal(belowNormal(child, (pid, p) => set.push([pid, p])), child);
    assert.deepEqual(set, [], "no pid before it has started");
    child.pid = 4321;
    child.emit("spawn");
    assert.equal(set.length, 1);
    assert.equal(set[0][0], 4321);
    assert.ok(set[0][1] > 0, "a lower priority than normal (0)");
    const started = Object.assign(new EventEmitter(), { pid: 99 });
    belowNormal(started, (pid) => set.push([pid]));
    assert.deepEqual(set.at(-1), [99]);
    assert.doesNotThrow(() => belowNormal(Object.assign(new EventEmitter(), { pid: 1 }), () => { throw new Error("denied"); }));
});

test("details and dan by part go to a pool worker like an analysis, in the same turns", async () => {
    const asked = [];
    const pool = createWorkerPool({
        spawn: () => null, size: 1,
        client: () => ({
            analyze: async (text, rate) => { asked.push(["analyze", text, rate]); return OK; },
            details: async (text, rate) => { asked.push(["details", text, rate]); return { kind: "details" }; },
            sections: async (text, rate) => { asked.push(["sections", text, rate]); return { kind: "sections" }; },
            dispose() {},
        }),
    });
    const answers = await Promise.all([pool.details("A", 1.1), pool.analyze("B", 1), pool.sections("C", 1.2)]);
    assert.deepEqual(answers.map((r) => r.kind), ["details", "ok", "sections"]);
    assert.deepEqual(asked, [["details", "A", 1.1], ["analyze", "B", 1], ["sections", "C", 1.2]]);
    pool.dispose();
});

test("a worker that went idle once is not stopped while a later job runs longer than idleMs", async () => {
    const f = fakeClients();
    const pool = createWorkerPool({ spawn: () => null, size: 1, idleMs: 30, client: f.client });
    const first = pool.analyze("A", 1);
    await flush();
    f.calls[0].resolve(OK);
    await first; // idle now, its timer armed
    await wait(10);
    const long = pool.analyze("B", 1);
    await flush();
    await wait(60);
    assert.equal(f.made[0].disposed, false, "busy, not idle");
    f.calls[1].resolve(OK);
    assert.deepEqual(await long, OK);
    assert.equal(f.made.length, 1);
    pool.dispose();
});

test("warm() starts one worker ahead of the work when none is alive, and it serves the next job", async () => {
    const f = fakeClients();
    const warmed = [];
    const client = (opts) => Object.assign(f.client(opts), { warm() { warmed.push(this.n); } });
    const pool = createWorkerPool({ spawn: () => null, size: 3, idleMs: 40, client });
    pool.warm();
    assert.equal(f.made.length, 1);
    assert.deepEqual(warmed, [0], "its process started");
    pool.warm();
    assert.equal(f.made.length, 1, "one alive: nothing more");
    const job = pool.analyze("A", 1);
    await flush();
    assert.equal(f.calls[0].client, 0, "the warm one takes it");
    f.calls[0].resolve(OK);
    await job;
    await wait(80);
    assert.equal(f.made[0].disposed, true, "and it stops when idle like any other");
    assert.equal(pool.stats().workers, 0);
    pool.dispose();
    pool.warm();
    assert.equal(f.made.length, 1, "a closed pool starts nothing");
    createWorkerPool({ spawn: () => null, size: 0, client: () => assert.fail("no worker") }).warm();
});
