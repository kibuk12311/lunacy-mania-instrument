// The reader of a running Interlude (native/interlude-reader, see its README.md): a small read-only exe that attaches
// to Interlude.exe with ClrMD and prints one JSON object per line (status lines and state lines, protocol v1). The
// main process owns it: started while Interlude is followed live, read line by line, started again after a crash
// with a growing pause, stopped by closing its stdin (it exits on stdin EOF; kill() if it doesn't in time).
// It never downloads anything unless asked: --allow-download is passed only when the user turned that setting on.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export const READER_EXE = "interlude-reader.exe";
export const BACKOFF = Object.freeze({ baseMs: 1_000, maxMs: 60_000, stableMs: 60_000 });
const STOP_GRACE_MS = 1_500;
const STDERR_KEEP = 600;

// Where the exe is: next to the app's resources in an installed or portable build (electron-builder's
// extraResources), in the reader's own build output when run from the source tree.
export function readerPath({ packaged, resourcesPath = "", appDir }) {
    return packaged
        ? path.join(resourcesPath, "interlude-reader", READER_EXE)
        : path.join(appDir, "..", "native", "interlude-reader", "out", "reader", READER_EXE);
}

// The reader's command line from the app's settings. Nothing else is ever passed.
export const readerArgs = ({ allowDownload = false } = {}) => (allowDownload === true ? ["--allow-download"] : []);

// The pause before start number `attempt` (1, 2, …) after crashes: base, 2×base, 4×base … up to maxMs.
export const restartDelay = (attempt, { baseMs, maxMs } = BACKOFF) => Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

// One line of stdout → the message, or null when it isn't protocol v1 JSON.
export function parseReaderLine(line) {
    const text = String(line ?? "").trim();
    if (!text.startsWith("{")) return null;
    try {
        const msg = JSON.parse(text);
        return msg && typeof msg === "object" && msg.v === 1 ? msg : null;
    } catch {
        return null;
    }
}

// exe(): the path; args(): the command line of the next start; onMessage(msg): every parsed line;
// onState({ state: "running" | "stopped" | "missing" | "crashed", code?, retryMs?, stderr? }): the process itself.
export function createReaderProcess({
    exe, args = () => [], onMessage = () => {}, onState = () => {}, log = () => {},
    spawn = nodeSpawn, exists = existsSync, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, backoff = BACKOFF,
}) {
    let child = null;
    let wanted = false;
    let timer = null;
    let attempts = 0; // crashes in a row
    let startedAt = 0;
    let exited = null; // a promise of the running child's exit
    const stopping = new Set(); // children being stopped: their exit is no crash

    function launch() {
        timer = null;
        if (!wanted || child) return;
        const file = exe();
        if (!file || !exists(file)) {
            log(`interlude reader: ${file} not found`);
            onState({ state: "missing", file });
            return;
        }
        const argv = args();
        let proc;
        try {
            // stdin stays a pipe: the reader exits when it closes, so it can never outlive the app
            proc = spawn(file, argv, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: path.dirname(file) });
        } catch (error) {
            log(`interlude reader: start failed: ${error?.message}`);
            crashed(null, String(error?.message ?? error));
            return;
        }
        child = proc;
        startedAt = now();
        let stderr = "";
        let done = false;
        let resolveExit;
        exited = new Promise((r) => { resolveExit = r; });
        log(`interlude reader: started ${path.basename(file)}${argv.length ? ` ${argv.join(" ")}` : ""} pid ${proc.pid ?? "?"}`);
        onState({ state: "running", pid: proc.pid ?? null });
        const lines = createInterface({ input: proc.stdout });
        lines.on("line", (line) => {
            const msg = parseReaderLine(line);
            if (!msg) return;
            try {
                onMessage(msg);
            } catch (error) {
                log(`interlude reader: a line was not handled: ${error?.message}`);
            }
        });
        proc.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
        proc.stdin?.on("error", () => {}); // the pipe closing under a write
        const finish = (code, error) => {
            if (done) return;
            done = true;
            lines.close();
            if (child === proc) child = null;
            resolveExit(code);
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
        if (now() - startedAt >= backoff.stableMs) attempts = 0; // it ran fine for a while: start over from the base
        attempts += 1;
        const retryMs = restartDelay(attempts, backoff);
        log(`interlude reader: exited (${code ?? "error"}${detail ? `: ${detail}` : ""}), again in ${retryMs} ms`);
        onState({ state: "crashed", code, retryMs, stderr: detail });
        clearTimer(timer);
        timer = setTimer(launch, retryMs);
    }

    async function stop() {
        wanted = false;
        clearTimer(timer);
        timer = null;
        const proc = child;
        if (!proc) return;
        const gone = exited;
        stopping.add(proc);
        try {
            proc.stdin?.end();
        } catch {
            // already closed
        }
        let killTimer = null;
        const late = new Promise((r) => {
            killTimer = setTimer(() => {
                try {
                    proc.kill();
                } catch {
                    // gone
                }
                r();
            }, STOP_GRACE_MS);
        });
        await Promise.race([gone, late]);
        clearTimer(killTimer);
        if (child === proc) child = null; // killed: its exit may come later, a new one may start now
    }

    return {
        start() {
            if (wanted) return;
            wanted = true;
            attempts = 0;
            launch();
        },
        stop,
        // the command line changed (the download setting): a new process with it, if one runs
        async restart() {
            if (!wanted) return;
            await stop();
            wanted = true;
            attempts = 0;
            launch();
        },
        running: () => Boolean(child),
        wanted: () => wanted,
        attempts: () => attempts,
    };
}
