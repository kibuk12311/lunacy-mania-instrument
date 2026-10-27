// Every analysis the tabs ask for, over one shared result cache. The foreground (the selected map's card, the rate
// preview) goes straight to the card's worker; background work (the Session library, the Picks' rate fits, ladders,
// details, dan by part, profile imports) waits in one FIFO line. When the machine has cores to spare the line runs on a
// pool of workers of its own (app/workerPool.js), one job per worker at once, so the foreground never waits for any
// background analysis; without one it runs on the card's worker one job at a time, so the foreground waits for one at
// most.
import { cacheKey } from "../src/core/cache.js";
import { getLang as currentLang, t } from "../src/i18n/i18n.js";

const ERROR_MEMO_SIZE = 1000;

// pool: app/workerPool.js (or null): analyze / details / sections, size, stats()
export function createAnalysisService({ worker, cache, pool = null, log = () => {}, getLang = currentLang }) {
    const pooled = pool?.size > 0;
    const background = pooled ? pool : worker; // where the line's jobs run
    const lanes = pooled ? pool.size : 1; // how many of them at once
    // deterministic errors: not cached on disk, but not worked out again this session (per language: they hold text)
    const errorMemo = new Map();
    const running = new Map(); // "lang key" → Promise of the worker's answer
    const lineFailures = new WeakSet(); // transient answers of the line's own workers (the pool)
    const line = []; // background jobs waiting their turn: { fn, isCancelled, resolve, promise }
    let inFlight = 0;
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

    // one worker call per (language, chart, rate) at a time, whoever asked first; `on`: the card's worker or the line's
    function viaWorker(text, rate, key, lang, on = worker) {
        const id = `${lang} ${key}`;
        if (!running.has(id)) {
            misses += 1;
            const job = (async () => {
                let result;
                try {
                    result = await on.analyze(text, rate);
                } catch (error) {
                    result = failure(error);
                }
                if (on !== worker && result?.transient) lineFailures.add(result);
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
        while (inFlight < lanes && line.length) {
            const entry = line.shift();
            if (entry.isCancelled()) {
                entry.resolve(cancelled());
                continue;
            }
            inFlight += 1;
            Promise.resolve().then(() => entry.fn(background)).then(entry.resolve, (error) => entry.resolve(failure(error))).finally(() => {
                inFlight -= 1;
                pump();
            });
        }
    }

    // a place in the line, taken at the moment of the call; fn(on) runs with the worker the line runs on
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

    const service = {
        async analyze(text, rate) {
            if (pooled) pool.warm?.(); // the card's details and dan by part come next, on the pool
            try {
                const answer = await lookup(text, rate, (key) => viaWorker(text, rate, key, getLang()));
                // the same chart under way on the line's worker came to nothing there (a timeout, its worker gone):
                // the card's own worker tries it
                if (lineFailures.has(answer)) return await lookup(text, rate, (key) => viaWorker(text, rate, key, getLang()));
                return answer;
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
                const entry = place((on) => lookup(text, rate, (k) => viaWorker(text, rate, k, getLang(), on)), isCancelled);
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
        // fn(on) → its answer, in the line; `on` is the worker the line runs on (details, dan by part)
        enqueue: (fn, { isCancelled } = {}) => place(fn, isCancelled).promise,
        // how many background jobs run at once: who has many independent ones keeps that many asked
        lanes,
        stats: () => ({ hits, misses, queued: line.length, inFlight, ...(pool ? { bulk: pool.stats() } : {}) }),
    };
    // the Session library's analyze: the line, bulk.lanes maps at once (app/sessionLibrary.js)
    service.bulk = Object.assign((text, rate) => service.analyzeQueued(text, rate), { lanes });
    return service;
}
