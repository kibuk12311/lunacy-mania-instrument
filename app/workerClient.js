// Request/response over the analysis utility process, with a timeout that replaces a hung worker.
// A long job may post { id, progress } on the way: it goes to the request's onProgress and re-arms its timer.
import { getLang, t } from "../src/i18n/i18n.js";

// >>> create (mapgen v3, stream W): a worker that wants the GPU renderer posts { gpuPort: true }; the hook
// (app/gpuWorkerHost.js, set from registerCreateIpc) answers that worker with a port. No hook: nobody answers and the
// worker stays on the CPU after its own timeout.
let gpuPortHook = null;
export function setGpuPortHook(hook) {
    gpuPortHook = hook;
}
// <<< create

export function createWorkerClient({ spawn, timeoutMs = 20_000, generateTimeoutMs = 180_000, timingTimeoutMs = 20_000, sectionsTimeoutMs = 90_000 }) {
    let worker = null;
    let disposed = false;
    let nextId = 0;
    const pending = new Map(); // id → { resolve, timer, worker, arm, onProgress }

    function settle(id, result) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(result);
    }

    function progress(id, p) {
        const entry = pending.get(id);
        if (!entry?.onProgress) return;
        entry.arm();
        try {
            entry.onProgress(p);
        } catch {
            // a listener that went away must not break the job
        }
    }

    function failAll(message, onlyWorker = null) {
        for (const [id, entry] of [...pending]) {
            if (!onlyWorker || entry.worker === onlyWorker) settle(id, { kind: "error", message, transient: true });
        }
    }

    function ensureWorker() {
        if (worker) return worker;
        const w = spawn();
        worker = w;
        w.on("message", (msg) => {
            if (msg && "result" in msg) settle(msg.id, msg.result);
            else if (msg?.progress) progress(msg.id, msg.progress);
            else if (msg?.gpuPort === true) gpuPortHook?.(w); // create (stream W): the GPU renderer's port
        });
        w.on("exit", () => {
            if (worker === w) worker = null;
            failAll(t("app.worker.exited"), w);
        });
        return w;
    }

    function request(message, limitMs, onProgress = null) {
        if (disposed) return Promise.resolve({ kind: "error", message: t("app.worker.closing"), transient: true });
        const w = ensureWorker();
        const id = ++nextId;
        return new Promise((resolve) => {
            const entry = { resolve, timer: null, worker: w, onProgress };
            entry.arm = () => {
                clearTimeout(entry.timer);
                entry.timer = setTimeout(() => {
                    settle(id, { kind: "error", message: t("app.worker.timeout"), transient: true });
                    if (worker === w) worker = null;
                    w.kill();
                }, limitMs);
            };
            entry.arm();
            pending.set(id, entry);
            w.postMessage({ id, lang: getLang(), ...message });
        });
    }

    return {
        // the process started ahead of its first request (app/workerPool.js warm)
        warm() {
            if (!disposed) ensureWorker();
        },
        analyze: (osuText, rate) => request({ kind: "analyze", osuText, rate }, timeoutMs),
        // >>> analysis v2: details (the strain line and pattern strip under the card, src/analysis/timeline.js)
        details: (osuText, rate) => request({ kind: "details", osuText, rate }, timeoutMs),
        // <<< analysis v2
        // the dan by part (src/analysis/sections.js): one analysis per part, so a marathon takes a while
        sections: (osuText, rate) => request({ kind: "sections", osuText, rate }, sectionsTimeoutMs),
        // >>> create (mapgen v3): generation, timing detection and remap; progress re-arms the timer
        generate: (payload, onProgress) => request({ kind: "generate", payload }, generateTimeoutMs, onProgress),
        detectTiming: (payload) => request({ kind: "timing", payload }, timingTimeoutMs),
        remap: (payload, onProgress) => request({ kind: "remap", payload }, generateTimeoutMs, onProgress),
        // wave 3: the personal reranker is fitted here, never in main; it may wait behind a generation, hence its limit
        fitPersonal: (payload) => request({ kind: "fit-personal", payload }, generateTimeoutMs),
        // <<< create
        dispose() {
            disposed = true;
            failAll(t("app.worker.closing"));
            worker?.kill();
            worker = null;
        },
    };
}
