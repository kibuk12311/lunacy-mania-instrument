// The page lane's start (extension/DESIGN.md §5.4, §5.7): on an osu! beatmapset page, find the set's osu!mania 4K
// difficulties, ask the background for each one's dan (the selected one first), draw the panel, follow the selected
// difficulty, ask for the dan on rates while that block is open, and open the demo player.
//
// start({ client, doc, win, storage, runtime, timers, fetch }) → the controller; every dependency can be injected
// (the tests pass a fake client and DOM). Defaults: shared/client.js, the page's document/window, chrome.storage.local.
import { PRIORITY, ERR } from "../shared/protocol.js";
import { RATES, rateKey } from "../shared/rates.js";
import { siteLang } from "../shared/lang.js";
import * as site from "./site.js";
import { createNav } from "./nav.js";
import { createPanel, stateOf } from "./panel.js";
import { makeStrings } from "./strings.js";
import { createPlayerFrame } from "./playerFrame.js";

export const PAGE_KEY = "lm.page.v1";
export const MAX_IN_FLIGHT = 3;
const ORDER = { [PRIORITY.HIGH]: 0, [PRIORITY.NORMAL]: 1, [PRIORITY.LOW]: 2 };

// chrome.storage.local as get(key) / set(key, value); failures read as "nothing saved" and are not fatal.
export function chromeStorage(api = globalThis.chrome ?? globalThis.browser) {
    const area = api?.storage?.local;
    return {
        async get(key) {
            try {
                const found = await area.get(key);
                return found?.[key];
            } catch {
                return undefined;
            }
        },
        async set(key, value) {
            try {
                await area.set({ [key]: value });
            } catch {
                // not remembered this time
            }
        },
    };
}

// Jobs by priority (high → normal → low, first come first served inside one), at most `limit` running. A key already
// waiting is not added twice (a higher priority lifts it); a running key is not added again.
export function createQueue({ limit = MAX_IN_FLIGHT } = {}) {
    const waiting = [];
    const running = new Set();
    let seq = 0;
    let idleWaiters = [];

    const known = (p) => (p in ORDER ? p : PRIORITY.NORMAL);
    const settleIdle = () => {
        if (waiting.length || running.size) return;
        const list = idleWaiters;
        idleWaiters = [];
        for (const resolve of list) resolve();
    };

    function pump() {
        while (running.size < limit && waiting.length) {
            waiting.sort((a, b) => ORDER[a.priority] - ORDER[b.priority] || a.seq - b.seq);
            const job = waiting.shift();
            running.add(job.key);
            Promise.resolve()
                .then(() => job.task(job.priority))
                .catch(() => {})
                .finally(() => {
                    running.delete(job.key);
                    pump();
                    settleIdle();
                });
        }
    }

    return {
        add(key, priority, task) {
            if (running.has(key)) return false;
            const p = known(priority);
            const existing = waiting.find((j) => j.key === key);
            if (existing) {
                if (ORDER[p] < ORDER[existing.priority]) existing.priority = p;
                return false;
            }
            waiting.push({ key, priority: p, seq: seq++, task });
            pump();
            return true;
        },
        bump(key, priority) {
            const job = waiting.find((j) => j.key === key);
            if (job && ORDER[known(priority)] < ORDER[job.priority]) job.priority = known(priority);
        },
        remove(predicate) {
            for (let i = waiting.length - 1; i >= 0; i--) if (predicate(waiting[i].key)) waiting.splice(i, 1);
            settleIdle();
        },
        clear() {
            waiting.length = 0;
            settleIdle();
        },
        has: (key) => running.has(key) || waiting.some((j) => j.key === key),
        get size() { return waiting.length; },
        get running() { return running.size; },
        idle() {
            if (!waiting.length && !running.size) return Promise.resolve();
            return new Promise((resolve) => idleWaiters.push(resolve));
        },
    };
}

// The answers' .osu meta → does the set's preview fit every 4K diff? (dan packs: each diff has its own audio)
export function previewMismatch(responses) {
    const audio = new Set();
    const times = new Set();
    for (const r of responses) {
        if (!r?.ok || !r.meta) continue;
        audio.add(String(r.meta.audioFilename ?? "").trim().toLowerCase());
        times.add(Number(r.meta.previewTime));
    }
    return audio.size > 1 || times.size > 1;
}

// A client call that still answers when the call itself throws (no extension context, etc.).
async function call(fn, args) {
    try {
        const answer = await fn(args);
        if (answer && typeof answer === "object") return answer;
        return { ok: false, error: { code: ERR.CONTEXT, message: "empty answer" } };
    } catch (error) {
        const message = String(error?.message ?? error);
        return { ok: false, error: { code: /context invalidated|Extension context|runtime/i.test(message) ? ERR.CONTEXT : ERR.NETWORK, message } };
    }
}

export function createController({ client, doc, win, storage, runtime, timers = win, fetch = null }) {
    const lang = siteLang(doc, win.navigator);
    const t = makeStrings(lang);
    const queue = createQueue({ limit: MAX_IN_FLIGHT });
    const player = createPlayerFrame({ doc, win, runtime });
    let gen = 0;
    let page = null;
    let appVersion = null;
    let loading = Promise.resolve();

    const nav = createNav({ doc, win, timers, onLoad: () => { loading = load(); return loading; }, onBeforeCache: teardown, onCheck: check });

    const selected = () => page?.diffs.find((d) => d.id === page.selectedId) ?? null;
    const rateId = (id, rate) => `${id}|${rateKey(rate).toFixed(2)}`;

    function viewModel() {
        const d = selected();
        const results = page.results;
        const answers = page.diffs.map((x) => results.get(x.id));
        const meta = d ? results.get(d.id)?.meta : null;
        const rates = new Map();
        if (d) for (const rate of RATES) {
            const answer = page.rates.get(rateId(d.id, rate));
            if (answer) rates.set(rateKey(rate), answer);
        }
        return {
            setId: page.setId,
            diffs: page.diffs,
            selectedId: page.selectedId,
            foreign: page.foreign !== null,
            results,
            ratesOpen: page.ratesOpen,
            rates,
            demoRate: page.demoRate,
            preview: { disabled: Number.isFinite(meta?.previewTime) && meta.previewTime < 0, warn: previewMismatch(answers) },
            full: { disabled: page.download.disabled, login: page.login },
            appVersion,
        };
    }

    function render() {
        if (!page) return;
        page.panel.render(viewModel());
    }

    function requestDiff(d, priority) {
        const myGen = page.gen;
        queue.add(`${myGen}|d|${d.id}`, priority, async (p) => {
            const answer = await call(client.analyze, { beatmapId: d.id, checksum: d.checksum, rate: 1, lang, priority: p });
            if (!page || page.gen !== myGen) return;
            page.results.set(d.id, answer);
            if (!appVersion && answer.ok && answer.analyzer?.appVersion) appVersion = answer.analyzer.appVersion;
            if (d.id === page.selectedId && page.ratesOpen) requestRates();
            render();
        });
    }

    // The selected diff's rates that have no answer yet, at low priority. retryFailed: the failed ones are asked again
    // too (the block opened again, the difficulty selected again).
    function requestRates({ retryFailed = false } = {}) {
        const d = selected();
        if (!d || !page.ratesOpen) return;
        const main = page.results.get(d.id);
        if (!main?.ok || main.result?.kind !== "ok") return;
        for (const rate of RATES) {
            if (rateKey(rate) === 1) continue;
            const id = rateId(d.id, rate);
            if (retryFailed && stateOf(page.rates.get(id)) === "error") page.rates.delete(id);
            if (page.rates.has(id)) continue;
            requestRate(d, rate, PRIORITY.LOW);
        }
    }

    function requestRate(d, rate, priority) {
        const myGen = page.gen;
        const id = rateId(d.id, rate);
        queue.add(`${myGen}|r|${id}`, priority, async (p) => {
            if (!page || page.gen !== myGen || !page.ratesOpen || page.selectedId !== d.id) return;
            const answer = await call(client.analyze, { beatmapId: d.id, checksum: d.checksum, rate: rateKey(rate), lang, priority: p });
            if (!page || page.gen !== myGen) return;
            page.rates.set(id, answer);
            render();
        });
    }

    const dropQueuedRates = () => queue.remove((key) => key.includes("|r|"));

    function select(id) {
        if (!page || !page.diffs.some((d) => d.id === id)) return;
        page.foreign = null;
        if (id === page.selectedId) {
            // the same difficulty selected again: its failed rates are asked again
            if (page.ratesOpen) requestRates({ retryFailed: true });
            render();
            return;
        }
        page.selectedId = id;
        queue.bump(`${page.gen}|d|${id}`, PRIORITY.HIGH);
        if (page.ratesOpen) {
            dropQueuedRates();
            requestRates({ retryFailed: true });
        }
        render();
    }

    // osu-web's picker (or the hash) is on a difficulty that is not one of ours (7K, osu!, a convert): no chip selected,
    // the panel says so until a 4K one is picked
    function selectForeign(id) {
        if (!page || page.foreign === id) return;
        page.foreign = id;
        render();
    }

    function onAction(action) {
        if (!page) return;
        switch (action.type) {
            case "select": {
                const anchor = site.pickerAnchorFor(doc, action.id);
                if (anchor) {
                    anchor.click();
                } else {
                    // no picker anchor (another mode's tab is open, or the markup changed): mark the URL ourselves
                    try {
                        win.history.replaceState(win.history.state, "", `#mania/${action.id}`);
                        page.seenHash = action.id;
                    } catch {
                        // the panel still follows the click
                    }
                }
                select(action.id);
                break;
            }
            case "toggle-rates":
                page.ratesOpen = !page.ratesOpen;
                storage.set(PAGE_KEY, { ratesOpen: page.ratesOpen });
                if (page.ratesOpen) requestRates({ retryFailed: true });
                else dropQueuedRates();
                render();
                break;
            case "rate":
                if (RATES.some((r) => rateKey(r) === rateKey(action.rate))) page.demoRate = rateKey(action.rate);
                render();
                break;
            case "retry-rate": {
                const d = selected();
                const rate = RATES.find((r) => rateKey(r) === rateKey(action.rate));
                if (!d || rate === undefined || rateKey(rate) === 1 || !page.ratesOpen) break;
                const id = rateId(d.id, rate);
                if (stateOf(page.rates.get(id)) !== "error") break;
                page.rates.delete(id);
                requestRate(d, rate, PRIORITY.HIGH);
                render();
                break;
            }
            case "retry": {
                const d = page.diffs.find((x) => x.id === action.id);
                if (!d) break;
                page.results.delete(d.id);
                requestDiff(d, PRIORITY.HIGH);
                render();
                break;
            }
            case "play-preview":
                openPlayer("preview");
                break;
            case "play-full":
                openPlayer("full");
                break;
            case "play-file":
                openPlayer("file");
                break;
            default:
                break;
        }
    }

    function openPlayer(src) {
        const d = selected();
        if (!d) return null;
        const vm = viewModel();
        if (src === "preview" && vm.preview.disabled) return null;
        if (src === "full" && vm.full.disabled) return null;
        return player.open({
            setId: page.setId, beatmapId: d.id, src, rate: page.demoRate, lang, checksum: d.checksum,
            login: page.login, previewWarn: vm.preview.warn,
        });
    }

    async function load() {
        try {
            const setId = site.setIdFromPath(win.location?.pathname);
            if (page && setId === page.setId) {
                // the same page again (Turbo's first turbo:load after we started): keep what we have
                nav.watch();
                check("load");
                return;
            }
            teardown();
            if (!setId) return;
            const myGen = gen;
            const set = await site.loadBeatmapset(doc, { setId, pathname: win.location.pathname, fetch });
            if (myGen !== gen || !set) return;
            const diffs = site.fourKDiffs(set);
            if (!diffs.length) return;
            const saved = await storage.get(PAGE_KEY);
            if (myGen !== gen) return;
            const panel = createPanel({ doc, t, lang, onAction });
            const seenHash = site.hashBeatmapId(win.location.hash);
            const seenActive = site.activePickerId(doc);
            const ids = new Set(diffs.map((d) => d.id));
            const shown = seenHash ?? seenActive;
            page = {
                gen: myGen, setId, diffs, panel,
                selectedId: site.selectedBeatmapId(doc, win.location.hash, diffs),
                seenHash, seenActive,
                foreign: shown !== null && !ids.has(shown) ? shown : null,
                results: new Map(), rates: new Map(),
                ratesOpen: saved?.ratesOpen === true,
                demoRate: 1,
                login: site.loginHint(doc),
                download: site.downloadAvailability(set),
            };
            site.placeHost(doc, panel.host);
            render();
            const first = selected();
            if (first) requestDiff(first, PRIORITY.HIGH);
            for (const d of diffs) if (d !== first) requestDiff(d, PRIORITY.NORMAL);
            nav.watch();
            if (!appVersion) {
                call(client.info).then((info) => {
                    if (!appVersion && info?.ok && info.analyzer?.appVersion) {
                        appVersion = info.analyzer.appVersion;
                        render();
                    }
                });
            }
        } catch (error) {
            globalThis.console?.warn?.("[Lunacy mania] page:", error);
        }
    }

    // a hash poll / click / mutation: put the host back if React dropped it, follow the selected difficulty
    function check() {
        if (!page) return;
        if (site.setIdFromPath(win.location?.pathname) !== page.setId) {
            loading = load();
            return;
        }
        site.placeHost(doc, page.panel.host);
        const ids = new Set(page.diffs.map((d) => d.id));
        const hashId = site.hashBeatmapId(win.location.hash);
        const activeId = site.activePickerId(doc);
        let next = null;
        if (activeId !== page.seenActive) {
            page.seenActive = activeId;
            if (activeId !== null) next = activeId;
        }
        if (hashId !== page.seenHash) {
            page.seenHash = hashId;
            if (hashId !== null) next = hashId;
        }
        if (next === null) return;
        if (ids.has(next)) select(next);
        else selectForeign(next);
    }

    function teardown() {
        gen++;
        queue.clear();
        player.close();
        nav.unwatch();
        if (page) {
            page.panel.destroy();
            page = null;
        }
    }

    return {
        start() {
            nav.start();
            return this;
        },
        stop() {
            teardown();
            nav.stop();
        },
        // for tests: resolves once the page's data is read and the panel drawn (requests may still run)
        loaded: () => loading,
        openPlayer,
        get page() { return page; },
        get player() { return player; },
        get queue() { return queue; },
        lang,
    };
}

export async function start({ client = null, doc = globalThis.document, win = globalThis.window, storage = null, runtime = null, timers = null, fetch = null } = {}) {
    const api = globalThis.chrome ?? globalThis.browser;
    const controller = createController({
        client: client ?? (await import("../shared/client.js")),
        doc,
        win,
        storage: storage ?? chromeStorage(api),
        runtime: runtime ?? api?.runtime,
        timers: timers ?? win,
        fetch: fetch ?? (typeof win?.fetch === "function" ? win.fetch.bind(win) : null),
    });
    return controller.start();
}
