// npm test: node --test with a temp folder of its own, removed when the run ends.
// The tests make their folders with mkdtemp(tmpdir()) and most never remove them; the fake-tosu ones copy node.exe
// (~90 MB) each time, so a few hundred runs filled the user's temp drive with ~120 GB. TEMP / TMP / TMPDIR point here,
// so every folder a test (or a process it starts) makes goes with the run.
// npm test                       → all of tests/**/*.test.js
// npm test -- tests/a.test.js    → just those files; flags such as --test-concurrency=4 pass through
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PREFIX = "lunacy-tests-";
const STALE_MS = 6 * 3600e3; // a killed run leaves its folder behind; a run still going keeps touching its own
const base = tmpdir();

for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(base, name);
    try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* still in use or already gone: the next run tries again */ }
}

const own = mkdtempSync(path.join(base, PREFIX));
const args = process.argv.slice(2);
const files = args.some((a) => !a.startsWith("-")) ? [] : ["tests/**/*.test.js"];
const child = spawn(process.execPath, ["--test", ...args, ...files], {
    stdio: "inherit",
    env: { ...process.env, TEMP: own, TMP: own, TMPDIR: own },
});

let done = false;
function finish(code) {
    if (done) return;
    done = true;
    try {
        // a process a test started may still hold a file for a moment after it is killed
        rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
        console.error(`run-tests: could not remove ${own} (${e.code ?? e.message}); the next run removes it`);
    }
    process.exit(code);
}
child.on("exit", (code, signal) => finish(signal ? 1 : code ?? 1));
child.on("error", (e) => {
    console.error(`run-tests: ${e.message}`);
    finish(1);
});
// Ctrl+C reaches node --test too: wait for it to stop, then clean up
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {});
