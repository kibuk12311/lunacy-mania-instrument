// The real key-reader.exe (native/key-reader, built by its build.ps1; skipped when it isn't built), without a single
// real keystroke: its self-test (made-up Raw Input records), its protocol in the synthetic mode (records fed on
// stdin, no Raw Input at all), and the real Raw Input mode listening only to F13–F24, keys nobody presses: it starts,
// its clock is the system's high-resolution one (ours), it takes a listen and a stop, and it exits when its stdin
// closes or when its parent dies. Nothing here sends a key to the system.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyReader, keyReaderPath } from "../app/keyReader.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = keyReaderPath({ packaged: false, appDir: path.join(root, "app") });
const skip = existsSync(EXE) ? false : `not built: ${EXE} (native/key-reader/build.ps1)`;
const F13_F24 = Array.from({ length: 12 }, (_, i) => 124 + i);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timed out");
        await sleep(10);
    }
};
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

// a RAWINPUT keyboard record (x64): RAWINPUTHEADER (type, size, hDevice, wParam) + RAWKEYBOARD
function record({ device = 1, make = 0, flags = 0, vk, type = 1 }) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(40, 4);
    b.writeBigInt64LE(BigInt(device), 8);
    b.writeUInt16LE(make, 24);
    b.writeUInt16LE(flags, 26);
    b.writeUInt16LE(vk, 30);
    b.writeUInt32LE(flags & 1 ? 0x101 : 0x100, 32);
    return b.toString("hex");
}

function run(args) {
    const proc = spawn(EXE, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines = [];
    let buf = "";
    proc.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            lines.push(buf.slice(0, i).trim());
            buf = buf.slice(i + 1);
        }
    });
    const exited = new Promise((r) => proc.on("exit", (code) => r(code)));
    return { proc, lines, exited, send: (l) => proc.stdin.write(`${l}\n`) };
}

test("self-test: the record parsing, the folding and the protocol on made-up data", { skip }, async () => {
    const r = run(["--self-test"]);
    assert.equal(await r.exited, 0, r.lines.filter((l) => l.startsWith("FAIL")).join("\n"));
    assert.match(r.lines.at(-1), /^self-test ok \d+$/);
});

test("synthetic mode: only the keys asked for, a held key once, left / right shift, numpad; quit", { skip }, async () => {
    const r = run(["--synthetic"]);
    await until(() => r.lines.length > 0);
    assert.match(r.lines[0], /^ready 1 \d+\.\d{3} synthetic$/);
    r.send("listen 65,160,103");
    await until(() => r.lines.includes("listening 3"));
    r.send(`feed ${record({ vk: 66 })} 1.0`); // B: never asked for
    r.send(`feed ${record({ vk: 65 })} 10.5`);
    r.send(`feed ${record({ vk: 65 })} 40`); // auto-repeat
    r.send(`feed ${record({ vk: 65, flags: 1 })} 95.25`);
    r.send(`feed ${record({ vk: 16, make: 0x36 })} 100`); // right shift: not asked for
    r.send(`feed ${record({ vk: 16, make: 0x2a, flags: 2 })} 101`); // the fake shift
    r.send(`feed ${record({ vk: 16, make: 0x2a })} 102`);
    r.send(`feed ${record({ vk: 36 })} 103`); // numpad 7, NumLock off
    r.send(`feed ${record({ vk: 36, flags: 2 })} 104`); // the Home key itself
    r.send(`feed ${record({ vk: 65, type: 0 })} 105`); // a mouse record
    r.send("feed zz 1");
    r.send("sync 3");
    await until(() => r.lines.some((l) => l.startsWith("t 3 ")));
    r.send("quit");
    assert.equal(await r.exited, 0);
    const out = r.lines.slice(2).filter((l) => !l.startsWith("t "));
    assert.deepEqual(out.slice(0, 5), ["d 65 10.500", "u 65 95.250", "d 160 102.000", "d 103 103.000", "error bad_command"], out.join(" | "));
    // quit lets the keys still held go, at its own clock
    assert.equal(out.length, 7, out.join(" | "));
    assert.match(out[5], /^u 103 \d+\.\d{3}$/);
    assert.match(out[6], /^u 160 \d+\.\d{3}$/);
});

test("Raw Input, listening only to F13–F24: up, on our clock, takes listen and stop, exits when stdin closes", { skip }, async () => {
    const states = [];
    const keys = [];
    const reader = createKeyReader({ exe: () => EXE, onKey: (k) => keys.push(k), onState: (s) => states.push(s) });
    try {
        reader.listen(F13_F24);
        await until(() => states.some((s) => s.state === "listening"));
        assert.equal(states.find((s) => s.state === "listening").n, 12);
        // the helper's clock is QueryPerformanceCounter, so is Node's hrtime: our performance.now() ≈ its ms − offset
        const expected = Number(process.hrtime.bigint()) / 1e6 - performance.now();
        assert.ok(Math.abs(reader.offset() - expected) < 3, `offset ${reader.offset()} vs hrtime − now ${expected}`);
        reader.idle();
        await until(() => states.some((s) => s.state === "idle"));
        assert.equal(keys.length, 0, "nobody pressed F13–F24");
    } finally {
        await reader.stop();
    }
    assert.ok(states.some((s) => s.state === "stopped"), "it quit when asked, no kill needed");
    assert.ok(!states.some((s) => s.state === "crashed"));
});

test("Raw Input: the helper goes when its parent dies, even with its stdin still open", { skip }, async () => {
    // a parent of its own (a node process) starts the helper with --parent <its pid> and our stdin pipe, so only the
    // parent watch can end it; the parent prints the helper's pid and exits
    const script = `
        const { spawn } = require("node:child_process");
        const child = spawn(${JSON.stringify(EXE)}, ["--parent", String(process.pid)], { stdio: ["inherit", "ignore", "ignore"], windowsHide: true, detached: false });
        console.log(child.pid);
        setTimeout(() => process.exit(0), 600);`;
    const parent = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let out = "";
    parent.stdout.on("data", (d) => { out += d; });
    await new Promise((r) => parent.on("exit", r));
    const pid = Number(out.trim());
    assert.ok(pid > 0, `the helper's pid (${out})`);
    try {
        await until(() => !alive(pid), 5000);
    } finally {
        if (alive(pid)) process.kill(pid);
        parent.stdin.end();
    }
});
