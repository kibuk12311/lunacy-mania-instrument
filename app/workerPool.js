// A few more analysis workers for the background line (app/analysisService.js: the Session library, the Picks' rate
// fits, ladders, details...), apart from the card's worker: up to `size` jobs at once, one per worker, the rest in
// turn, first come first. A worker starts with the first job it gets and stops after `idleMs` without one, so an app
// with nothing to analyse keeps only the card's worker. Each worker is an app/workerClient.js client of its own (its
// timeout, a fresh process after a crash) over app/analysisPoolWorker.js.
import os from "node:os";
import { createWorkerClient } from "./workerClient.js";
import { t } from "../src/i18n/i18n.js";

const MAX_WORKERS = 4;
const IDLE_MS = 30_000;
const GB = 2 ** 30;
// left to Windows, the game and the app's other processes; then a worker for every 2 GB beyond (a worker takes up to
// about 0.3 GB: 207 MB over 30 long charts, 210–290 MB over a library, tools/bench-library.mjs)
const RESERVE_BYTES = 4 * GB;
const BYTES_PER_WORKER = 2 * GB;
// a worker more is not started while less than this is free (the first one always is)
const MIN_FREE_BYTES = 1 * GB;

// utilityProcess.fork's options for a pool worker: its name in the Task Manager, and a smaller young generation (about
// 255 MB a worker instead of 305 at the most over a library, at the same speed: tools/bench-library.mjs); V8 flags
// reach a utility process only through --js-flags
export const POOL_WORKER_OPTIONS = Object.freeze({
    serviceName: "Lunacy mania background analysis",
    execArgv: ["--js-flags=--max-semi-space-size=8"],
});

// The cores less two (main and the card's worker keep theirs), and no more than the memory takes: 4 GB left to the
// rest, a worker for every 2 GB beyond (8 GB: two, 6 GB: one); at most four. None with two cores or fewer or 5 GB or
// less, where the background line stays on the card's worker.
export function poolSize(cores = os.availableParallelism(), totalMem = os.totalmem()) {
    const byCores = Math.floor(Number(cores) || 0) - 2;
    const byMemory = Math.floor(((Number(totalMem) || 0) - RESERVE_BYTES) / BYTES_PER_WORKER);
    return Math.max(0, Math.min(MAX_WORKERS, byCores, byMemory));
}

// A bulk worker gives way to the card's worker, the window and the game when the CPU is short (child: a utility
// process, whose pid comes with its "spawn").
export function belowNormal(child, setPriority = os.setPriority) {
    const lower = () => {
        try {
            setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
            // the OS said no: it runs at normal priority, still on a core of its own
        }
    };
    if (child.pid) lower();
    else child.once("spawn", lower);
    return child;
}

// spawn() → a utility process of app/analysisPoolWorker.js; client: makes a worker's client (createWorkerClient's shape);
// room() → whether there is memory for one more worker.
export function createWorkerPool({
    spawn, size = poolSize(), idleMs = IDLE_MS, client = createWorkerClient, room = () => os.freemem() > MIN_FREE_BYTES,
}) {
    const workers = new Set(); // { client, timer }
    const free = []; // the workers with no job, the one used last on top
    const waiting = []; // jobs with no worker yet: { run, resolve }
    let busy = 0;
    let disposed = false;

    const closing = () => ({ kind: "error", message: t("app.worker.closing"), transient: true });
    const failure = (error) => ({ kind: "error", message: String(error?.message ?? error), transient: true });

    function stop(w) {
        clearTimeout(w.timer);
        workers.delete(w);
        const i = free.indexOf(w);
        if (i >= 0) free.splice(i, 1);
        w.client.dispose();
    }

    // the worker is free again before its job answers, so whoever asks next on that answer gets it
    function go(w, job) {
        clearTimeout(w.timer);
        busy += 1;
        Promise.resolve().then(() => job.run(w.client)).catch(failure).then((result) => {
            busy -= 1;
            release(w);
            job.resolve(result);
        });
    }

    function release(w) {
        if (disposed) return;
        const next = waiting.shift();
        if (next) return go(w, next);
        idle(w);
    }

    function idle(w) {
        free.push(w);
        w.timer = setTimeout(() => stop(w), idleMs);
        w.timer.unref?.();
    }

    function run(fn) {
        if (disposed || size < 1) return Promise.resolve(closing());
        return new Promise((resolve) => {
            const job = { run: fn, resolve };
            let w = free.pop();
            if (!w && workers.size < size && (workers.size === 0 || room())) {
                w = { client: client({ spawn }), timer: null };
                workers.add(w);
            }
            if (w) go(w, job);
            else waiting.push(job);
        });
    }

    return {
        size,
        analyze: (osuText, rate) => run((c) => c.analyze(osuText, rate)),
        details: (osuText, rate) => run((c) => c.details(osuText, rate)),
        sections: (osuText, rate) => run((c) => c.sections(osuText, rate)),
        // one worker started ahead of the work when none is alive (a worker takes about 200 ms to start): the card's
        // analysis calls it, so the details and dan by part after it find one; it stops when idle like the others
        warm() {
            if (disposed || size < 1 || workers.size) return;
            const w = { client: client({ spawn }), timer: null };
            workers.add(w);
            w.client.warm?.();
            idle(w);
        },
        stats: () => ({ size, workers: workers.size, busy, queued: waiting.length }),
        // the app closing: the waiting jobs answered, every worker stopped (their running jobs answer as they go)
        dispose() {
            disposed = true;
            for (const job of waiting.splice(0)) job.resolve(closing());
            for (const w of [...workers]) stop(w);
        },
    };
}
