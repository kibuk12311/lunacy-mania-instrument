// Every analysis the tabs ask for, over one shared result cache. The foreground (the selected map's card, the rate
// preview) goes straight to the worker; background work (searches, ladders, details) waits in one FIFO line with at
// most one job in flight, so the foreground never waits for more than one background analysis.
import { cacheKey } from "../src/core/cache.js";
import { getLang as currentLang, t } from "../src/i18n/i18n.js";

const ERROR_MEMO_SIZE = 1000;

export function createAnalysisService({ worker, cache, log = () => {}, getLang = currentLang }) {
    // deterministic errors: not cached on disk, but not worked out again this session (per language: they hold text)
    const errorMemo = new Map();
    const running = new Map(); // "lang key" → Promise of the worker's answer
    const line = []; // background jobs waiting their turn: { fn, isCancelled, resolve, promise }
    let busy = false;
    let hits = 0;
    let misses = 0;

    const failure = (error) => ({ kind: "error", message: String(error?.message ?? error), transient: true });
    const cancelled = () => ({ kind: "error", transient: true, cancelled: true, message: t("app.shared.cancelled") });

    async function known(key, lang) {
        const memo = errorMemo.get(`${lang} ${key}`);
        if (memo) return memo;
        try {
            return await cache.get(key);
        } catch {
            return undefined;
        }
    }

    async function store(key, lang, result) {
        if (result?.kind === "error") {
            if (result.transient) return;
            errorMemo.set(`${lang} ${key}`, result);
            if (errorMemo.size > ERROR_MEMO_SIZE) errorMemo.delete(errorMemo.keys().next().value);
            return;
        }
        try {
            await cache.set(key, result);
        } catch (error) {
            log(`analysis cache write failed: ${error?.message}`); // the result is still good to show
        }
    }

    // one worker call per (language, chart, rate) at a time, whoever asked first
    function viaWorker(text, rate, key, lang) {
        const id = `${lang} ${key}`;
        if (!running.has(id)) {
            misses += 1;
            const job = (async () => {
                let result;
                try {
                    result = await worker.analyze(text, rate);
                } catch (error) {
                    result = failure(error);
                }
                await store(key, lang, result);
                return result;
            })().finally(() => running.delete(id));
            running.set(id, job);
        }
        return running.get(id);
    }

    // cache → the same request already on its way → `ask` (the worker now, or after the line)
    async function lookup(text, rate, ask) {
        const key = cacheKey(text, rate);
        const lang = getLang();
        const id = `${lang} ${key}`;
        if (running.has(id)) return running.get(id);
        const hit = await known(key, lang);
        if (hit !== undefined) {
            hits += 1;
            return hit;
        }
        return ask(key);
    }

    function pump() {
        if (busy || !line.length) return;
        const entry = line.shift();
        if (entry.isCancelled()) {
            entry.resolve(cancelled());
            pump();
            return;
        }
        busy = true;
        Promise.resolve().then(entry.fn).then(entry.resolve, (error) => entry.resolve(failure(error))).finally(() => {
            busy = false;
            pump();
        });
    }

    // a place in the line, taken at the moment of the call
    function place(fn, isCancelled = () => false) {
        const entry = { fn, isCancelled };
        entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
        line.push(entry);
        pump();
        return entry;
    }

    // leaves the line before its turn; false once the job has started
    function leave(entry) {
        const i = line.indexOf(entry);
        if (i >= 0) line.splice(i, 1);
        return i >= 0;
    }

    return {
        async analyze(text, rate) {
            try {
                return await lookup(text, rate, (key) => viaWorker(text, rate, key, getLang()));
            } catch (error) {
                return failure(error);
            }
        },
        async analyzeQueued(text, rate, { isCancelled = () => false } = {}) {
            try {
                const key = cacheKey(text, rate);
                const lang = getLang();
                if (running.has(`${lang} ${key}`)) return await running.get(`${lang} ${key}`);
                // its turn is looked at again when it comes: the cache may have filled meanwhile
                const entry = place(() => lookup(text, rate, (k) => viaWorker(text, rate, k, getLang())), isCancelled);
                // a cached answer does not wait for its turn
                const hit = await known(key, lang);
                if (hit !== undefined && leave(entry)) {
                    hits += 1;
                    return hit;
                }
                return await entry.promise;
            } catch (error) {
                return failure(error);
            }
        },
        enqueue: (fn, { isCancelled } = {}) => place(fn, isCancelled).promise,
        stats: () => ({ hits, misses, queued: line.length, inFlight: busy ? 1 : 0 }),
    };
}
