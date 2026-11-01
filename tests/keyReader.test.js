// The keyboard reader's manager (app/keyReader.js) against a stand-in helper process that speaks its protocol:
// the lines read, the clocks matched (the quickest round trip), only the keys asked for passed on and at our time,
// nothing asked of the helper before its clock is known, idle between plays, a crash started again with a pause,
// a missing exe, the stop (quit, then kill), and no key ever in the log.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { bestOffset, createKeyReader, keyReaderPath, KEY_READER_EXE, parseKeyLine, SYNC_ROUNDS } from "../app/keyReader.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timed out");
        await sleep(5);
    }
};

test("protocol lines: presses, sync answers, ready, acks, errors; anything else is nothing", () => {
    assert.deepEqual(parseKeyLine("d 65 123.250"), { type: "d", vk: 65, ms: 123.25 });
    assert.deepEqual(parseKeyLine("u 222 99"), { type: "u", vk: 222, ms: 99 });
    assert.deepEqual(parseKeyLine("t 7 5.5"), { type: "t", id: 7, ms: 5.5 });
    assert.deepEqual(parseKeyLine("ready 1 1000.000 raw"), { type: "ready", version: 1, ms: 1000, mode: "raw" });
    assert.deepEqual(parseKeyLine("listening 4"), { type: "listening", n: 4 });
    assert.deepEqual(parseKeyLine("stopped"), { type: "stopped" });
    assert.deepEqual(parseKeyLine("error register_failed 5"), { type: "error", code: "register_failed", detail: 5 });
    assert.deepEqual(parseKeyLine("error bad_command"), { type: "error", code: "bad_command", detail: null });
    for (const bad of ["", "d", "d 0 1", "d 255 1", "d 65", "d 65 x", "d 65 1 2", "x 65 1", "{\"v\":1}", null, "t x 1", "ready x 1"]) {
        assert.equal(parseKeyLine(bad), null, String(bad));
    }
    assert.equal(bestOffset([{ rtt: 3, offset: 10 }, { rtt: 0.4, offset: 12 }, { rtt: 1, offset: 11 }]), 12);
    assert.equal(bestOffset([]), null);
    assert.equal(path.basename(keyReaderPath({ packaged: true, resourcesPath: "R:\\res", appDir: "x" })), KEY_READER_EXE);
    assert.equal(keyReaderPath({ packaged: true, resourcesPath: "R:\\res", appDir: "x" }), path.join("R:\\res", "key-reader", KEY_READER_EXE));
    assert.equal(path.resolve(keyReaderPath({ packaged: false, appDir: path.join("C:\\repo", "app") })), path.resolve("C:\\repo\\native\\key-reader\\out\\key-reader.exe"));
});

// A stand-in helper: its clock is ours + SHIFT; it answers like key-reader.exe and lets the test send presses.
const SHIFT = 123456.75;
function fakeHelpers({ answer = true } = {}) {
    const spawned = [];
    const spawn = (file, args, opts) => {
        const proc = new EventEmitter();
        proc.pid = 4000 + spawned.length;
        proc.file = file;
        proc.args = args;
        proc.opts = opts;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.lines = [];
        proc.killed = false;
        proc.kill = () => { proc.killed = true; proc.exit(1); };
        proc.exit = (code = 0) => {
            if (proc.gone) return;
            proc.gone = true;
            setImmediate(() => proc.emit("exit", code));
        };
        const say = (line) => proc.stdout.write(`${line}\n`);
        proc.say = say;
        proc.clock = () => performance.now() + SHIFT;
        let buf = "";
        proc.stdin = new EventEmitter();
        proc.stdin.write = (text) => {
            buf += text;
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                proc.lines.push(line);
                if (!answer) continue;
                const [w, a] = line.split(" ");
                if (w === "sync") say(`t ${a} ${proc.clock().toFixed(3)}`);
                else if (w === "listen") say(`listening ${a.split(",").length}`);
                else if (w === "stop") say("stopped");
                else if (w === "quit" && !proc.ignoreQuit) proc.exit(0);
            }
            return true;
        };
        proc.stdin.end = () => { proc.stdinEnded = true; };
        spawned.push(proc);
        setImmediate(() => say(`ready 1 ${proc.clock().toFixed(3)} raw`));
        return proc;
    };
    return { spawn, spawned };
}

test("the clocks are matched first; then only the keys asked for come through, at our time", async () => {
    const { spawn, spawned } = fakeHelpers();
    const keys = [];
    const states = [];
    const logs = [];
    const reader = createKeyReader({
        exe: () => "C:\\app\\key-reader.exe", spawn, exists: () => true,
        onKey: (k) => keys.push(k), onState: (s) => states.push(s.state), log: (l) => logs.push(l),
    });
    assert.equal(spawned.length, 0, "nothing starts until a play wants keys");
    reader.listen([222, 65, 83, 186, 65]);
    assert.equal(spawned.length, 1);
    const proc = spawned[0];
    assert.deepEqual(proc.args, ["--parent", String(process.pid)], "it watches our pid");
    assert.equal(proc.opts.windowsHide, true);
    assert.deepEqual(proc.opts.stdio, ["pipe", "pipe", "pipe"]);
    assert.ok(!proc.lines.some((l) => l.startsWith("listen")), "no listen before the helper is up");
    await until(() => states.includes("listening"));
    const syncs = proc.lines.filter((l) => l.startsWith("sync "));
    assert.equal(syncs.length, SYNC_ROUNDS, "one round trip after another");
    assert.deepEqual(proc.lines.filter((l) => l.startsWith("listen")), ["listen 65,83,186,222"], "sorted, once each, after the sync");
    assert.ok(Math.abs(reader.offset() - SHIFT) < 2, `offset ${reader.offset()} ≈ ${SHIFT}`);
    assert.ok(reader.ready());

    const t0 = performance.now();
    proc.say(`d 65 ${(t0 + SHIFT).toFixed(3)}`);
    proc.say(`d 70 ${(t0 + SHIFT).toFixed(3)}`); // never asked for: dropped even if the helper said it
    proc.say(`u 65 ${(t0 + 30 + SHIFT).toFixed(3)}`);
    await until(() => keys.length >= 2);
    await sleep(20);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].vk, 65);
    assert.equal(keys[0].down, true);
    assert.ok(Math.abs(keys[0].at - t0) < 2, "at our time");
    assert.equal(keys[1].down, false);
    assert.ok(Math.abs(keys[1].at - keys[0].at - 30) < 1e-6, "the gap between press and release exactly as the helper timed it");

    // between plays: nothing, and nothing comes through
    reader.idle();
    assert.equal(proc.lines.at(-1), "stop");
    proc.say(`d 65 ${(performance.now() + SHIFT).toFixed(3)}`);
    await until(() => states.includes("idle"));
    await sleep(20);
    assert.equal(keys.length, 2, "idle: no key passed on");
    assert.equal(spawned.length, 1, "the process stays, idle");
    reader.listen([186, 222]);
    assert.equal(proc.lines.at(-1), "listen 186,222");
    reader.listen([186, 222]);
    assert.equal(proc.lines.filter((l) => l === "listen 186,222").length, 1, "the same set is not sent again");

    await reader.stop();
    assert.ok(proc.lines.includes("quit"));
    assert.equal(proc.stdinEnded, true);
    assert.equal(proc.killed, false, "it quit by itself");
    assert.ok(states.includes("stopped"));
    // the log says what the process does, never which keys
    assert.ok(logs.length > 0);
    for (const l of logs) assert.doesNotMatch(l, /\b(65|83|186|222)\b|listen|(^|: )[du] \d/, l);
});

test("a crash starts it again after a pause; the keys asked for are asked again once its clock is known", async () => {
    const { spawn, spawned } = fakeHelpers();
    const timers = [];
    const states = [];
    const reader = createKeyReader({
        exe: () => "C:\\app\\key-reader.exe", spawn, exists: () => true, onState: (s) => states.push(s),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    });
    reader.listen([65]);
    await until(() => states.some((s) => s.state === "listening"));
    spawned[0].exit(3);
    await until(() => states.some((s) => s.state === "crashed"));
    const crash = states.find((s) => s.state === "crashed");
    assert.equal(crash.code, 3);
    assert.equal(crash.retryMs, 1000);
    assert.equal(reader.running(), false);
    const restart = timers.at(-1);
    assert.equal(restart.ms, 1000);
    restart.fn();
    assert.equal(spawned.length, 2);
    await until(() => spawned[1].lines.includes("listen 65"));
    spawned[1].exit(3);
    await until(() => states.filter((s) => s.state === "crashed").length === 2);
    assert.equal(states.filter((s) => s.state === "crashed")[1].retryMs, 2000, "a longer pause each time");
    await reader.stop();
});

test("no exe: told once, nothing started; a stop that is not answered is a kill", async () => {
    const { spawn, spawned } = fakeHelpers();
    const states = [];
    const missing = createKeyReader({ exe: () => "C:\\nope\\key-reader.exe", spawn, exists: () => false, onState: (s) => states.push(s.state) });
    missing.listen([65]);
    missing.listen([66]);
    assert.equal(spawned.length, 0);
    assert.deepEqual(states, ["missing"]);
    assert.equal(missing.missing(), true);

    const stuck = fakeHelpers();
    const timers = [];
    const reader = createKeyReader({
        exe: () => "C:\\app\\key-reader.exe", spawn: stuck.spawn, exists: () => true,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return setTimeout(() => {}, 0); }, clearTimer: () => {},
    });
    reader.listen([65]);
    stuck.spawned[0].ignoreQuit = true;
    const stopping = reader.stop();
    await sleep(10);
    assert.equal(stuck.spawned[0].killed, false);
    timers.at(-1).fn(); // the grace is over
    await stopping;
    assert.equal(stuck.spawned[0].killed, true);
});

test("Raw Input refused: told, nothing listened to; a helper that never answers the sync still gets its keys", async () => {
    const { spawn, spawned } = fakeHelpers();
    const states = [];
    const reader = createKeyReader({ exe: () => "x.exe", spawn, exists: () => true, onState: (s) => states.push(s) });
    reader.listen([65]);
    await until(() => spawned[0].lines.includes("listen 65"));
    spawned[0].say("error register_failed 5");
    await until(() => states.some((s) => s.state === "error"));
    assert.deepEqual(reader.listening(), []);
    await reader.stop();

    const silent = fakeHelpers({ answer: false });
    const r2 = createKeyReader({ exe: () => "x.exe", spawn: silent.spawn, exists: () => true });
    r2.listen([65]);
    await until(() => silent.spawned[0].lines.includes("listen 65"), 3000);
    assert.ok(Math.abs(r2.offset() - SHIFT) < 50, "the ready line's guess");
    silent.spawned[0].ignoreQuit = false;
    silent.spawned[0].exit(0);
    await r2.stop();
});
