import { test } from "node:test";
import assert from "node:assert/strict";
import { createNav } from "../../../extension/content/nav.js";
import { makeDocument, makeWindow, fakeTimers, FakeEvent } from "./helpers/dom.js";
import { pageHtml, SET_ID } from "./helpers/fixture.js";

function setup() {
    const doc = makeDocument(pageHtml());
    const timers = fakeTimers();
    const win = makeWindow(doc, { url: `https://osu.ppy.sh/beatmapsets/${SET_ID}#mania/1001`, timers });
    const log = [];
    const nav = createNav({
        doc, win, timers,
        onLoad: () => log.push("load"),
        onBeforeCache: () => log.push("before-cache"),
        onCheck: (reason) => log.push(`check:${reason}`),
    });
    return { doc, win, timers, nav, log };
}

test("start runs onLoad now and on every turbo:load; before-cache stops watching first", () => {
    const { doc, nav, log, timers } = setup();
    nav.start();
    nav.start(); // once
    assert.deepEqual(log, ["load"]);
    nav.watch();
    assert.equal(nav.watching, true);
    doc.dispatchEvent(new FakeEvent("turbo:before-cache"));
    assert.equal(nav.watching, false);
    assert.deepEqual(log, ["load", "before-cache"]);
    timers.tick(1000);
    assert.deepEqual(log, ["load", "before-cache"], "no polling after before-cache");
    doc.dispatchEvent(new FakeEvent("turbo:load"));
    assert.deepEqual(log, ["load", "before-cache", "load"]);
    nav.stop();
    doc.dispatchEvent(new FakeEvent("turbo:load"));
    assert.equal(log.length, 3, "stopped: turbo events are not heard");
});

test("a before-cache with no render after it (osu-web's hash-only navigation) loads the page again", () => {
    const { doc, nav, log, timers } = setup();
    nav.start();
    nav.watch();
    doc.dispatchEvent(new FakeEvent("turbo:before-cache"));
    timers.tick(1499);
    assert.deepEqual(log, ["load", "before-cache"]);
    timers.tick(1);
    assert.deepEqual(log, ["load", "before-cache", "load"], "revived");
    // a real visit: before-cache, then before-render and turbo:load → one load only
    doc.dispatchEvent(new FakeEvent("turbo:before-cache"));
    doc.dispatchEvent(new FakeEvent("turbo:before-render"));
    timers.tick(5000);
    doc.dispatchEvent(new FakeEvent("turbo:load"));
    timers.tick(5000);
    assert.deepEqual(log, ["load", "before-cache", "load", "before-cache", "load"]);
    // stop() drops a pending revive
    doc.dispatchEvent(new FakeEvent("turbo:before-cache"));
    nav.stop();
    timers.tick(5000);
    assert.equal(log.at(-1), "before-cache");
    assert.equal(timers.pending, 0, "no timers left");
});

test("hash poll every 300 ms; a replaceState shows up as reason hash", () => {
    const { win, nav, log, timers } = setup();
    nav.start();
    nav.watch();
    timers.tick(299);
    assert.deepEqual(log, ["load"]);
    timers.tick(1);
    assert.deepEqual(log, ["load", "check:poll"]);
    win.history.replaceState(null, "", "#mania/1002"); // what osu-web does: no event
    timers.tick(300);
    assert.deepEqual(log.at(-1), "check:hash");
    timers.tick(300);
    assert.deepEqual(log.at(-1), "check:poll");
    nav.unwatch();
    const n = log.length;
    timers.tick(3000);
    assert.equal(log.length, n);
    assert.equal(timers.pending, 0, "no timers left");
});

test("picker clicks, mutations and popstate/hashchange trigger one debounced check", () => {
    const { doc, win, nav, log, timers } = setup();
    nav.start();
    nav.watch();
    doc.querySelector(".beatmapset-beatmap-picker__beatmap div").click();
    win.mutate();
    win.dispatchEvent(new FakeEvent("popstate"));
    timers.tick(30);
    assert.deepEqual(log, ["load", "check:click"], "a burst is one check");
    win.dispatchEvent(new FakeEvent("hashchange"));
    timers.tick(30);
    assert.equal(log.at(-1), "check:history");
    win.mutate();
    timers.tick(30);
    assert.equal(log.at(-1), "check:mutation");
    // a click elsewhere does nothing
    const before = log.length;
    doc.querySelector(".beatmapset-info").click();
    timers.tick(30);
    assert.equal(log.length, before);
    // the observer watches the page's class changes and children
    const [observer] = win.observers;
    assert.deepEqual(observer.options, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    nav.unwatch();
    assert.equal(win.observers.size, 0, "the observer is disconnected");
});

test("a throwing callback does not break navigation", () => {
    const { doc, win, timers } = setup();
    const warn = console.warn;
    console.warn = () => {};
    try {
        let checks = 0;
        const nav = createNav({ doc, win, timers, onLoad: () => { throw new Error("x"); }, onCheck: () => { checks++; throw new Error("y"); } });
        nav.start();
        nav.watch();
        timers.tick(900);
        assert.equal(checks, 3);
    } finally {
        console.warn = warn;
    }
});
