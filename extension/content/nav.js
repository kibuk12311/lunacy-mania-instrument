// osu-web navigation → callbacks (extension/DESIGN.md §5.4). osu-web is a Turbo site: a visit fires turbo:load, and
// before Turbo snapshots the old page it fires turbo:before-cache. Switching a difficulty is a history.replaceState
// (no event at all), so while we sit on a set page we also poll the hash, listen to picker clicks, watch the picker's
// class and the page's children (React may re-render and drop our host) and hear popstate/hashchange.
//
// createNav({ doc, win, timers, onLoad, onBeforeCache, onCheck }):
//   start()  → onLoad() now and on every turbo:load; onBeforeCache() on turbo:before-cache (watching stops first);
//              a before-cache with no turbo:before-render / turbo:load within reviveMs (osu-web's hash-only
//              navigation) runs onLoad() again
//   watch()  → while watching, onCheck(reason) after a hash change, a picker click, a mutation, popstate/hashchange,
//              and every pollMs (reason "poll"); repeated triggers inside debounceMs run one check
//   unwatch(), stop()
import { PICKER_ANCHOR_CLASS } from "./site.js";

export function createNav({
    doc = globalThis.document,
    win = globalThis.window,
    timers = win,
    pollMs = 300,
    debounceMs = 30,
    reviveMs = 1500,
    onLoad = () => {},
    onBeforeCache = () => {},
    onCheck = () => {},
} = {}) {
    let started = false;
    let watching = false;
    let pollId = null;
    let pendingId = null;
    let observer = null;
    let lastHash = null;
    // live osu-web fires turbo:before-cache on a hash-only navigation (a #mania/<id> link, the address bar, back) with
    // no render and no turbo:load after it: if no render follows soon, the page is still ours, so load it again
    let reviveId = null;
    const clearRevive = () => {
        if (reviveId !== null) timers.clearTimeout(reviveId);
        reviveId = null;
    };

    const safe = (fn, ...args) => {
        try {
            return fn(...args);
        } catch (error) {
            globalThis.console?.warn?.("[Lunacy mania]", error);
            return undefined;
        }
    };

    const check = (reason) => {
        if (!watching) return;
        lastHash = win.location?.hash ?? "";
        safe(onCheck, reason);
    };

    // one check soon for a burst of triggers
    const soon = (reason) => {
        if (!watching || pendingId !== null) return;
        pendingId = timers.setTimeout(() => {
            pendingId = null;
            check(reason);
        }, debounceMs);
    };

    const onPoll = () => {
        if (!watching) return;
        const hash = win.location?.hash ?? "";
        check(hash !== lastHash ? "hash" : "poll");
    };

    const onClick = (event) => {
        const target = event?.target;
        const anchor = target?.closest?.(`.${PICKER_ANCHOR_CLASS}`);
        if (anchor) soon("click");
    };
    const onHistory = () => soon("history");
    const onMutations = () => soon("mutation");

    const handleLoad = () => {
        clearRevive();
        unwatch();
        safe(onLoad);
    };
    const handleBeforeCache = () => {
        unwatch();
        safe(onBeforeCache);
        clearRevive();
        reviveId = timers.setTimeout(() => {
            reviveId = null;
            handleLoad();
        }, reviveMs);
    };

    function watch() {
        if (watching) return;
        watching = true;
        lastHash = win.location?.hash ?? "";
        pollId = timers.setInterval(onPoll, pollMs);
        doc.addEventListener("click", onClick, true);
        win.addEventListener("popstate", onHistory);
        win.addEventListener("hashchange", onHistory);
        const Observer = win.MutationObserver ?? globalThis.MutationObserver;
        if (typeof Observer === "function") {
            observer = new Observer(onMutations);
            const root = doc.body ?? doc.documentElement;
            // the picker's --active class, and React re-rendering the page around our host
            observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
        }
    }

    function unwatch() {
        if (!watching) return;
        watching = false;
        if (pollId !== null) timers.clearInterval(pollId);
        if (pendingId !== null) timers.clearTimeout(pendingId);
        pollId = pendingId = null;
        doc.removeEventListener("click", onClick, true);
        win.removeEventListener("popstate", onHistory);
        win.removeEventListener("hashchange", onHistory);
        observer?.disconnect();
        observer = null;
    }

    function start() {
        if (started) return;
        started = true;
        doc.addEventListener("turbo:load", handleLoad);
        doc.addEventListener("turbo:before-cache", handleBeforeCache);
        doc.addEventListener("turbo:before-render", clearRevive);
        handleLoad();
    }

    function stop() {
        unwatch();
        if (!started) return;
        started = false;
        doc.removeEventListener("turbo:load", handleLoad);
        doc.removeEventListener("turbo:before-cache", handleBeforeCache);
        doc.removeEventListener("turbo:before-render", clearRevive);
        clearRevive();
    }

    return { start, stop, watch, unwatch, get watching() { return watching; } };
}
