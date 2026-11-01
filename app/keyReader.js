// The keyboard reader (native/key-reader, see its README.md): a small exe that hears the keyboard through Raw Input
// on a hidden window of its own (no hook, nothing injected, osu! untouched) and tells, on its stdout, when the keys
// it was given go down and up, on the system's high-resolution clock. The overlay owns it (app/overlay/overlayManager.js):
//   - started when the first osu! stable play wants its keys, kept idle (listening to nothing, Raw Input off) between
//     plays, killed when the overlay or its keyboard setting is turned off and with the app (its stdin closes; it
//     also watches our pid);
//   - listen(vks) names the only keys it may report (the lanes of the play), idle() names none;
//   - its clock is matched to ours once it is up (a few "sync" round trips, the quickest kept), so every press comes
//     out at our now() time: onKey({ vk, down, at });
//   - a crash starts it again with a growing pause, like the Interlude reader (app/interludeReader.js).
// Nothing it says is logged but its state; no key ever reaches log.txt or a file.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { BACKOFF, restartDelay } from "./interludeReader.js";

export const KEY_READER_EXE = "key-reader.exe";
export const PROTOCOL = 1;
export const SYNC_ROUNDS = 8;
const SYNC_TIMEOUT_MS = 1_000;
const STOP_GRACE_MS = 1_000;

// next to the app's resources in an installed or portable build (extraResources), in the helper's own build output
// when run from the source tree
export function keyReaderPath({ packaged, resourcesPath = "", appDir }) {
    return packaged
        ? path.join(resourcesPath, "key-reader", KEY_READER_EXE)
        : path.join(appDir, "..", "native", "key-reader", "out", KEY_READER_EXE);
}

const num = (s) => {
    const n = Number(s);
    return s !== undefined && s !== "" && Number.isFinite(n) ? n : null;
};

// One line of its stdout → { type, … } or null (anything else is ignored):
// "ready 1 <ms> <mode>", "d <vk> <ms>", "u <vk> <ms>", "t <id> <ms>", "listening <n>", "stopped", "error <code> …"
export function parseKeyLine(line) {
    const parts = String(line ?? "").trim().split(/\s+/);
    const [w, a, b, c] = parts;
    switch (w) {
        case "d":
        case "u": {
            const vk = num(a);
            const ms = num(b);
            return Number.isInteger(vk) && vk > 0 && vk < 255 && ms !== null && parts.length === 3 ? { type: w, vk, ms } : null;
        }
        case "t": {
            const id = num(a);
            const ms = num(b);
            return Number.isInteger(id) && ms !== null ? { type: "t", id, ms } : null;
        }
        case "ready": {
            const version = num(a);
            const ms = num(b);
            return version !== null && ms !== null ? { type: "ready", version, ms, mode: c ?? "" } : null;
        }
        case "listening":
            return num(a) !== null ? { type: "listening", n: num(a) } : null;
        case "stopped":
            return { type: "stopped" };
        case "error":
            return { type: "error", code: /^[a-z_]{1,40}$/.test(a ?? "") ? a : "unknown", detail: num(b) };
        default:
            return null;
    }
}

// the quickest of the round trips: the helper's clock minus ours
export function bestOffset(samples) {
    let best = null;
    for (const s of samples) if (!best || s.rtt < best.rtt) best = s;
    return best ? best.offset : null;
}

// exe(): the path; onKey({ vk, down, at }): a key of the set listened to (at: our now() ms);
// onState({ state: "running" | "ready" | "listening" | "idle" | "stopped" | "missing" | "crashed" | "error", … }): the
// process itself ("listening" / "idle": the helper took a listen / stop)
export function createKeyReader({
    exe, onKey = () => {}, onState = () => {}, log = () => {}, args = () => ["--parent", String(process.pid)],
    spawn = nodeSpawn, exists = existsSync, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    backoff = BACKOFF, env = undefined,
}) {
    let child = null;
    let wanted = false; // the process should be up
    let missing = false;
    let timer = null;
    let attempts = 0;
    let startedAt = 0;
    let ready = false;
    let synced = false; // the clocks are matched: keys may be asked for
    let offset = null; // helper ms − our ms
    let syncs = [];
    let syncId = 0;
    let syncPending = null; // { id, at }
    let syncTimer = null;
    let want = []; // the keys asked for (sorted VKs)
    let sent = null; // the set last sent to the helper (null: nothing yet)
    let heard = new Set(); // what the helper was last told it may report: nothing else is passed on
    const stopping = new Set();

    const write = (proc, line) => {
        try {
            proc.stdin?.write(`${line}\n`);
        } catch {
            // the pipe closed under us: its exit comes next
        }
    };

    // the keys asked for → the helper, once its clock is matched
    function flush() {
        if (!child || !ready || !synced || offset === null) return;
        const key = want.join(",");
        if (sent === key) return;
        sent = key;
        // from now on only these come through (a line already on its way for an old key is dropped)
        heard = new Set(want);
        write(child, want.length ? `listen ${key}` : "stop");
    }

    function sync() {
        if (!child) return;
        syncId += 1;
        syncPending = { id: syncId, at: now() };
        write(child, `sync ${syncId}`);
        clearTimer(syncTimer);
        syncTimer = setTimer(() => {
            // no answer: keep what we have (or the ready line's guess) and go on
            syncPending = null;
            syncDone();
        }, SYNC_TIMEOUT_MS);
    }

    function syncDone() {
        clearTimer(syncTimer);
        syncTimer = null;
        const best = bestOffset(syncs);
        if (best !== null) offset = best;
        synced = true;
        onState({ state: "ready" });
        flush();
    }

    function onLine(proc, line) {
        if (proc !== child || stopping.has(proc)) return; // a helper being stopped is no longer listened to
        const msg = parseKeyLine(line);
        if (!msg) return;
        const at = now();
        switch (msg.type) {
            case "ready":
                if (msg.version !== PROTOCOL) {
                    log(`key reader: protocol ${msg.version}, not ${PROTOCOL}`);
                    return;
                }
                ready = true;
                synced = false;
                offset = msg.ms - at; // a first guess (it left the helper a little before now)
                syncs = [];
                sync();
                break;
            case "t":
                if (!syncPending || msg.id !== syncPending.id) return;
                syncs.push({ rtt: at - syncPending.at, offset: msg.ms - (syncPending.at + at) / 2 });
                syncPending = null;
                if (syncs.length < SYNC_ROUNDS) sync();
                else syncDone();
                break;
            case "d":
            case "u":
                if (!heard.has(msg.vk) || offset === null) return;
                try {
                    onKey({ vk: msg.vk, down: msg.type === "d", at: msg.ms - offset });
                } catch (error) {
                    log(`key reader: a key was not handled: ${error?.message}`);
                }
                break;
            case "listening":
                onState({ state: "listening", n: msg.n });
                break;
            case "stopped":
                onState({ state: "idle" });
                break;
            case "error":
                log(`key reader: ${msg.code}${msg.detail !== null ? ` ${msg.detail}` : ""}`);
                if (msg.code === "register_failed") {
                    sent = null;
                    heard = new Set();
                    onState({ state: "error", code: msg.code });
                }
                break;
            default:
                break;
        }
    }

    function launch() {
        timer = null;
        if (!wanted || child || missing) return;
        const file = exe();
        if (!file || !exists(file)) {
            missing = true;
            log(`key reader: ${file} not found`);
            onState({ state: "missing", file });
            return;
        }
        let proc;
        try {
            proc = spawn(file, args(), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: path.dirname(file), ...(env ? { env } : {}) });
        } catch (error) {
            crashed(null, String(error?.message ?? error));
            return;
        }
        child = proc;
        startedAt = now();
        ready = false;
        synced = false;
        offset = null;
        sent = null;
        heard = new Set();
        let stderr = "";
        let done = false;
        log(`key reader: started ${path.basename(file)} pid ${proc.pid ?? "?"}`);
        onState({ state: "running", pid: proc.pid ?? null });
        const lines = createInterface({ input: proc.stdout });
        lines.on("line", (line) => onLine(proc, line));
        proc.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-300); });
        proc.stdin?.on("error", () => {});
        const finish = (code, error) => {
            if (done) return;
            done = true;
            lines.close();
            if (child === proc) {
                child = null;
                ready = false;
                synced = false;
                sent = null;
                heard = new Set();
                clearTimer(syncTimer);
                syncPending = null;
            }
            if (!wanted || stopping.has(proc)) {
                stopping.delete(proc);
                onState({ state: "stopped" });
                return;
            }
            crashed(code, error ? String(error?.message ?? error) : stderr.trim().split(/\r?\n/).at(-1) ?? "");
        };
        proc.on("error", (error) => finish(null, error));
        proc.on("exit", (code) => finish(code, null));
    }

    function crashed(code, detail) {
        if (now() - startedAt >= backoff.stableMs) attempts = 0;
        attempts += 1;
        const retryMs = restartDelay(attempts, backoff);
        log(`key reader: exited (${code ?? "error"}${detail ? `: ${detail}` : ""}), again in ${retryMs} ms`);
        onState({ state: "crashed", code, retryMs });
        clearTimer(timer);
        timer = setTimer(launch, retryMs);
    }

    function ensure() {
        if (wanted) return;
        wanted = true;
        attempts = 0;
        launch();
    }

    // report nothing (Raw Input off in the helper); the process stays, idle, for the next play
    function idle() {
        want = [];
        heard = new Set();
        flush();
    }

    return {
        // report these keys (VKs) and no others; the helper is started if it isn't up
        listen(vks) {
            want = [...new Set((vks ?? []).filter((v) => Number.isInteger(v) && v > 0 && v < 255))].sort((a, b) => a - b);
            if (!want.length) {
                idle();
                return;
            }
            ensure();
            flush();
        },
        idle,
        // the helper goes: stdin closed ("quit" first), killed if it is still there after a moment
        async stop() {
            wanted = false;
            want = [];
            heard = new Set();
            clearTimer(timer);
            timer = null;
            clearTimer(syncTimer);
            syncTimer = null;
            const proc = child;
            if (!proc) return;
            stopping.add(proc);
            const gone = new Promise((r) => proc.once?.("exit", r));
            write(proc, "quit");
            try {
                proc.stdin?.end();
            } catch {
                // closed
            }
            let killTimer = null;
            const late = new Promise((r) => {
                killTimer = setTimer(() => {
                    try { proc.kill(); } catch { /* gone */ }
                    r();
                }, STOP_GRACE_MS);
            });
            await Promise.race([gone, late]);
            clearTimer(killTimer);
            if (child === proc) child = null;
        },
        running: () => Boolean(child),
        ready: () => ready && synced,
        listening: () => [...heard],
        offset: () => offset,
        missing: () => missing,
    };
}
