// Where the analysis runs (extension/DESIGN.md §3, §5.3): one job at a time in a module Worker (analysis/worker.js),
// jobs ordered high → normal → low and first come first served inside a priority, 60 s per job, after which the
// Worker is thrown away and made again and the job answers "timeout". Chrome/Edge: the Worker lives in an offscreen
// document (MV3 service workers cannot import() and cannot start Workers); Firefox: the background page starts it.
// A job answers { ok: true, result } or { ok: false, code: "analysis" | "timeout", message }.
import { ERR, OFFSCREEN_TARGET, PRIORITY } from "../shared/protocol.js";

export const JOB_TIMEOUT_MS = 60_000;
export const OFFSCREEN_URL = "offscreen/offscreen.html";
export const OFFSCREEN_JOB = "lm:job";
export const OFFSCREEN_RESET = "lm:reset";
const RANK = { [PRIORITY.HIGH]: 0, [PRIORITY.NORMAL]: 1, [PRIORITY.LOW]: 2 };
const rankOf = (priority) => RANK[priority] ?? RANK[PRIORITY.NORMAL];

const failed = (code, message) => ({ ok: false, code, message });
const normalize = (answer) => (answer && answer.ok === true ? { ok: true, result: answer.result }
    : failed(answer?.code === ERR.TIMEOUT ? ERR.TIMEOUT : ERR.ANALYSIS, String(answer?.message ?? "analysis failed")));

// runner: { run({ text, rate }) → Promise<answer>, reset() } — the Worker (or the offscreen document holding it).
export function createAnalysisHost({ runner, timeoutMs = JOB_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const queue = [];
    const byKey = new Map();
    let running = null;
    let seq = 0;

    function finish(job, answer) {
        if (job.done) return;
        job.done = true;
        clearTimer(job.timer);
        if (job.key !== null) byKey.delete(job.key);
        if (running === job) running = null;
        job.resolve(answer);
        pump();
    }

    function pump() {
        if (running || !queue.length) return;
        queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
        const job = queue.shift();
        running = job;
        job.timer = setTimer(() => {
            if (job.done) return;
            // reset first: finish() starts the next job, which must reach a fresh Worker, not the stuck one
            try {
                runner.reset();
            } catch {
                // a dead worker is what reset is for
            }
            finish(job, failed(ERR.TIMEOUT, `no answer in ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        let pending;
        try {
            pending = Promise.resolve(runner.run({ text: job.text, rate: job.rate }));
        } catch (error) {
            pending = Promise.reject(error);
        }
        pending.then((answer) => finish(job, normalize(answer)), (error) => finish(job, failed(ERR.ANALYSIS, String(error?.message ?? error))));
    }

    // key: jobs with the same key (fingerprint|md5|rate) share one answer; a later, more urgent ask moves it up.
    function analyze(text, rate, priority = PRIORITY.NORMAL, key = null) {
        if (key !== null && byKey.has(key)) {
            const job = byKey.get(key);
            job.rank = Math.min(job.rank, rankOf(priority));
            return job.promise;
        }
        const job = { key, text, rate, rank: rankOf(priority), seq: (seq += 1), done: false, timer: null };
        job.promise = new Promise((resolve) => {
            job.resolve = resolve;
        });
        if (key !== null) byKey.set(key, job);
        queue.push(job);
        pump();
        return job.promise;
    }

    // a more urgent ask for a queued job: it moves up; false when no such job waits
    function bump(key, priority) {
        const job = byKey.get(key);
        if (!job) return false;
        job.rank = Math.min(job.rank, rankOf(priority));
        return true;
    }

    return {
        analyze,
        bump,
        get pending() {
            return queue.length + (running ? 1 : 0);
        },
    };
}

// The Worker side, shared by the Firefox background page and the Chrome offscreen document. makeWorker() → a Worker
// running analysis/worker.js. One job at a time (the host sees to it).
export function createWorkerRunner(makeWorker) {
    let worker = null;
    let pending = null;
    let seq = 0;

    function drop() {
        const w = worker;
        worker = null;
        try {
            w?.terminate();
        } catch {
            // gone already
        }
    }

    function settle(answer) {
        const p = pending;
        pending = null;
        p?.resolve(answer);
    }

    function ensure() {
        if (worker) return worker;
        const w = makeWorker();
        w.addEventListener("message", (event) => {
            if (w !== worker) return;
            const data = event.data ?? {};
            if (!pending || data.id !== pending.id) return;
            settle(data.ok ? { ok: true, result: data.result } : failed(data.code ?? ERR.ANALYSIS, data.message ?? "analysis failed"));
        });
        const broken = (event) => {
            event?.preventDefault?.();
            if (w !== worker) return;
            drop();
            settle(failed(ERR.ANALYSIS, String(event?.message ?? "the analysis worker stopped")));
        };
        w.addEventListener("error", broken);
        w.addEventListener("messageerror", broken);
        worker = w;
        return w;
    }

    return {
        run({ text, rate }) {
            return new Promise((resolve) => {
                if (pending) settle(failed(ERR.ANALYSIS, "replaced by a newer job"));
                seq += 1;
                pending = { id: seq, resolve };
                try {
                    ensure().postMessage({ id: seq, text, rate });
                } catch (error) {
                    drop();
                    settle(failed(ERR.ANALYSIS, String(error?.message ?? error)));
                }
            });
        },
        reset() {
            drop();
            settle(failed(ERR.TIMEOUT, "the analysis worker was restarted"));
        },
        get alive() {
            return worker !== null;
        },
    };
}

// Chrome/Edge: the jobs go to the offscreen document, made once and kept open.
export function createOffscreenRunner(chrome, { url = OFFSCREEN_URL } = {}) {
    let creating = null;
    let jobs = 0;

    async function ensureDocument() {
        const documentUrl = chrome.runtime.getURL(url);
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [documentUrl] });
        if (contexts.length) return;
        creating ??= chrome.offscreen.createDocument({
            url,
            reasons: ["WORKERS"],
            justification: "Runs the dan analyzer (WebAssembly) in a worker",
        }).catch((error) => {
            // another call made it first
            if (!/single offscreen|only a single|already/i.test(String(error?.message))) throw error;
        }).finally(() => {
            creating = null;
        });
        await creating;
    }

    async function ask(message) {
        await ensureDocument();
        return chrome.runtime.sendMessage(message);
    }

    return {
        async run({ text, rate }) {
            jobs += 1;
            const message = { target: OFFSCREEN_TARGET, type: OFFSCREEN_JOB, jobId: jobs, text, rate };
            try {
                return (await ask(message)) ?? failed(ERR.ANALYSIS, "no answer from the offscreen document");
            } catch (error) {
                // the document may have been closed between the check and the message: once more
                if (/Receiving end does not exist|Could not establish connection/i.test(String(error?.message))) {
                    try {
                        return (await ask(message)) ?? failed(ERR.ANALYSIS, "no answer from the offscreen document");
                    } catch (again) {
                        return failed(ERR.ANALYSIS, String(again?.message ?? again));
                    }
                }
                return failed(ERR.ANALYSIS, String(error?.message ?? error));
            }
        },
        reset() {
            Promise.resolve()
                .then(() => chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: OFFSCREEN_RESET }))
                .catch(() => {});
        },
    };
}
