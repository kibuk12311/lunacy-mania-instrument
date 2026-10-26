import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkerClient } from "../app/workerClient.js";
import { setLang } from "../src/i18n/i18n.js";

function fakeWorker({ answer = true } = {}) {
    const w = new EventEmitter();
    w.killed = false;
    w.postMessage = ({ id, rate }) => {
        if (answer) setImmediate(() => w.emit("message", { id, result: { kind: "ok", rate } }));
    };
    w.kill = () => { w.killed = true; setImmediate(() => w.emit("exit", 1)); };
    return w;
}

test("answers are matched to requests", async () => {
    const client = createWorkerClient({ spawn: () => fakeWorker(), timeoutMs: 1000 });
    const [a, b] = await Promise.all([client.analyze("x", 1), client.analyze("y", 1.5)]);
    assert.equal(a.rate, 1);
    assert.equal(b.rate, 1.5);
    client.dispose();
});

test("a hung analysis times out, kills the worker and the next request uses a fresh one", async () => {
    const workers = [];
    const client = createWorkerClient({
        spawn: () => { const w = fakeWorker({ answer: workers.length > 0 }); workers.push(w); return w; },
        timeoutMs: 50,
    });
    const r = await client.analyze("x", 1);
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
    assert.equal(workers[0].killed, true);
    const next = await client.analyze("y", 1);
    assert.equal(next.kind, "ok");
    assert.equal(workers.length, 2);
    client.dispose();
});

test("worker crash resolves pending requests as transient errors", async () => {
    let w;
    const client = createWorkerClient({ spawn: () => { w = fakeWorker({ answer: false }); return w; }, timeoutMs: 5000 });
    const pending = client.analyze("x", 1);
    w.emit("exit", 1);
    const r = await pending;
    assert.equal(r.kind, "error");
    assert.equal(r.transient, true);
    client.dispose();
});

test("generate requests carry their payload and use their own timeout", async () => {
    const seen = [];
    const w = new EventEmitter();
    w.postMessage = (msg) => { seen.push(msg); setTimeout(() => w.emit("message", { id: msg.id, result: { kind: "generated", echo: msg.payload.x } }), 80); };
    w.kill = () => {};
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 20, generateTimeoutMs: 1000 });
    const r = await client.generate({ x: 42 });
    assert.equal(r.echo, 42);
    assert.equal(seen[0].kind, "generate");
    client.dispose();
});

test("requests carry the current language and errors come back in it", async () => {
    const posted = [];
    const w = fakeWorker({ answer: false });
    const original = w.postMessage;
    w.postMessage = (message) => { posted.push(message.lang); original(message); };
    setLang("en");
    try {
        const client = createWorkerClient({ spawn: () => w, timeoutMs: 30 });
        const r = await client.analyze("x", 1);
        assert.deepEqual(r, { kind: "error", message: "the calculation took too long", transient: true });
        assert.deepEqual(posted, ["en"]);
        client.dispose();
        assert.equal((await client.analyze("y", 1)).message, "the app is closing");
    } finally {
        setLang("ru");
    }
});

test("details requests are the details kind with the chart and rate, on the analysis timeout", async () => {
    const seen = [];
    const w = new EventEmitter();
    w.postMessage = (msg) => { seen.push(msg); setImmediate(() => w.emit("message", { id: msg.id, result: { kind: "details", details: { v: 1, rate: msg.rate } } })); };
    w.kill = () => {};
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000 });
    const r = await client.details("chart", 1.2);
    assert.deepEqual(r, { kind: "details", details: { v: 1, rate: 1.2 } });
    assert.equal(seen[0].kind, "details");
    assert.equal(seen[0].osuText, "chart");
    client.dispose();

    const hung = createWorkerClient({ spawn: () => fakeWorker({ answer: false }), timeoutMs: 30 });
    const late = await hung.details("chart", 1);
    assert.equal(late.kind, "error");
    assert.equal(late.transient, true);
    hung.dispose();
});
