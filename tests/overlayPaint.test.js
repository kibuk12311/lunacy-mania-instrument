// When the overlay's pages draw (src/overlay/paintLoop.js, app/overlay/widget.js, app/overlay/settings.js): a hidden
// widget draws nothing and draws once on being shown; outside a play a widget draws only for a new snapshot and while
// a number eases, then rests; a running play's key lines and the edit mode's made-up numbers move every frame; a
// window resized or a screen of another pixel ratio is drawn again; the settings window's previews stop while it is
// not on screen.
import test from "node:test";
import assert from "node:assert/strict";
import { createPaintLoop, EASE_MS } from "../src/overlay/paintLoop.js";
import { normalizeOverlaySettings } from "../src/overlay/settings.js";
import { fakeSnapshot } from "../src/overlay/fake.js";
import { fakeDom } from "./helpers/fakeDom.js";

// animation frames and timers by hand: step() runs the frames asked for so far, tick() the timers that are due
function fakeFrames() {
    let frames = [];
    let timers = [];
    let id = 0;
    let now = 0;
    return {
        requestFrame: (fn) => { frames.push({ id: ++id, fn }); return id; },
        cancelFrame: (n) => { frames = frames.filter((f) => f.id !== n); },
        setTimer: (fn, ms) => { timers.push({ id: ++id, fn, at: now + ms }); return id; },
        clearTimer: (n) => { timers = timers.filter((x) => x.id !== n); },
        step(ms = 2) {
            now += ms;
            const due = frames;
            frames = [];
            for (const f of due) f.fn(now);
            return due.length;
        },
        tick(ms) {
            now += ms;
            const due = timers.filter((x) => x.at <= now);
            timers = timers.filter((x) => x.at > now);
            for (const x of due) x.fn();
            return due.length;
        },
        pending: () => frames.length,
        timers: () => timers.length,
    };
}

test("paint loop: hidden it draws nothing; shown it draws once at once; hidden again it stops, shown again it draws", () => {
    const f = fakeFrames();
    let painted = 0;
    const loop = createPaintLoop({ paint: () => { painted += 1; return false; }, ...f });
    loop.wake();
    assert.equal(f.pending(), 0, "a hidden page asks for no frame");
    loop.setVisible(true);
    assert.equal(f.pending(), 1, "shown: one frame at once");
    f.step();
    assert.equal(painted, 1);
    assert.equal(f.pending(), 0, "nothing moving: no next frame");
    assert.equal(loop.busy(), false);

    loop.wake();
    loop.wake();
    assert.equal(f.pending(), 1, "two wakes before the frame: one frame");
    loop.setVisible(false);
    assert.equal(f.pending(), 0, "hidden: the frame asked for is cancelled");
    f.step();
    assert.equal(painted, 1);
    loop.wake();
    assert.equal(f.pending(), 0);
    loop.setVisible(true);
    f.step();
    assert.equal(painted, 2, "drawn once on being shown again");
});

test("paint loop: live draws every frame until it is not; easing draws about every EASE_MS, then rests", () => {
    const f = fakeFrames();
    let live = true;
    let moving = 0; // frames still easing
    let painted = 0;
    const loop = createPaintLoop({ paint: () => { painted += 1; return moving-- > 0; }, live: () => live, ...f });
    loop.setVisible(true);
    for (let i = 0; i < 50; i += 1) assert.equal(f.step(), 1, "live: a frame every frame");
    assert.equal(painted, 50);
    live = false;
    f.step();
    assert.equal(f.pending(), 0, "the play stopped: no frame after");

    // a snapshot outside a play: one frame, then the easing frames on a timer, not every screen refresh
    moving = 3;
    loop.wake();
    f.step();
    assert.equal(f.pending(), 0);
    assert.equal(f.timers(), 1, "still easing: the next frame waits EASE_MS");
    assert.equal(f.tick(EASE_MS - 1), 0);
    assert.equal(f.tick(1), 1);
    assert.equal(f.pending(), 1);
    f.step();
    f.tick(EASE_MS);
    f.step();
    f.tick(EASE_MS);
    f.step();
    assert.equal(f.timers() + f.pending(), 0, "eased: at rest");
    assert.equal(loop.busy(), false);

    // a new snapshot while an easing frame waits: drawn at the next refresh, the wait dropped
    moving = 5;
    loop.wake();
    f.step();
    assert.equal(f.timers(), 1);
    loop.wake();
    assert.equal(f.timers(), 0);
    assert.equal(f.pending(), 1);
    loop.setVisible(false);
    assert.equal(loop.busy(), false, "hidden: no frame and no timer left");
});

// ---- the widget window and the settings window, on a fake DOM ----

let pageNo = 0;
function fakePage(search) {
    const dom = fakeDom();
    const frames = fakeFrames();
    globalThis.requestAnimationFrame = frames.requestFrame;
    globalThis.cancelAnimationFrame = frames.cancelFrame;
    globalThis.location = { search };
    const make = document.createElement;
    document.createElement = (tag) => {
        const node = make(tag);
        node.style.setProperty = () => {};
        return node;
    };
    const listeners = {};
    Object.assign(document, {
        body: { classList: { toggle() {} } },
        documentElement: { style: {} },
        visibilityState: "visible",
        addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    });
    // the screen's pixel ratio and the media queries asked about it: ratio(r) changes it as another monitor would,
    // and every query asked so far hears it once
    const media = [];
    Object.assign(window, {
        devicePixelRatio: 1,
        matchMedia: (query) => {
            const list = { query, listeners: [], addEventListener: (type, fn) => { if (type === "change") list.listeners.push(fn); } };
            media.push(list);
            return list;
        },
    });
    const ratio = (r) => {
        window.devicePixelRatio = r;
        for (const list of [...media]) for (const fn of list.listeners.splice(0)) fn();
    };
    const on = {};
    window.overlayApi = {
        lang: "en",
        onConfig: (cb) => { on.config = cb; },
        onState: (cb) => { on.state = cb; },
        onVisible: (cb) => { on.visible = cb; },
        onSettings: (cb) => { on.settings = cb; },
        setScale() {},
        get: async () => ({ settings: normalizeOverlaySettings({ enabled: true }), edit: false }),
        set: async () => ({ settings: normalizeOverlaySettings({ enabled: true }), edit: false }),
        setEdit() {},
    };
    pageNo += 1;
    return { dom, frames, on, ratio, fire: (type) => { for (const fn of listeners[type] ?? []) fn(); } };
}

async function openWidget(widget) {
    const page = fakePage(`?w=${widget}`);
    await import(`../app/overlay/widget.js?page=${pageNo}`);
    const w = normalizeOverlaySettings(null).widgets[widget];
    page.config = (edit = false) => page.on.config({ widget, style: w.style, opacity: 1, scale: 1, show: w.show, edit, hotkey: "Ctrl+Shift+O" });
    return page;
}

const snap = (phase, running, clock = 1000) => ({ ...fakeSnapshot(clock), phase, running, dan: undefined });

test("widget: hidden it never asks for a frame; shown it draws once; a running play's key lines move every frame", async () => {
    const { frames, on, config } = await openWidget("keys");
    config();
    on.state(snap("idle", false));
    assert.equal(frames.pending(), 0, "hidden: no frame, whatever comes");
    on.visible(true);
    assert.equal(frames.pending(), 1, "shown: drawn once at once");
    frames.step();
    assert.equal(frames.pending(), 0, "song select: nothing moves, so nothing more is drawn");
    on.state(snap("idle", false));
    assert.equal(frames.step(), 1, "a snapshot: one frame");
    assert.equal(frames.pending(), 0);

    on.state(snap("playing", true));
    for (let i = 0; i < 20; i += 1) assert.equal(frames.step(), 1, "a running play: the key lines every frame");
    on.visible(false);
    assert.equal(frames.pending(), 0, "hidden in the middle of a play: stopped at once");
    on.state(snap("playing", true, 1100));
    assert.equal(frames.pending(), 0);
    on.visible(true);
    for (let i = 0; i < 5; i += 1) assert.equal(frames.step(), 1, "shown again: moving again");

    on.state(snap("results", false));
    frames.step();
    assert.equal(frames.pending(), 0, "the results screen: at rest");
});

// the canvas a widget draws on: its backing store is what the screen shows
const canvasIn = (node) => (node.tagName === "CANVAS" ? node : node.children.map(canvasIn).find(Boolean) ?? null);

test("widget: a window resized or a screen of another pixel ratio is drawn again at its new size, idle too", async () => {
    const page = await openWidget("keys");
    const { frames, on, config } = page;
    config();
    const canvas = canvasIn(page.dom.$("widget"));
    Object.assign(canvas, { clientWidth: 196, clientHeight: 180 });
    on.visible(true);
    on.state(snap("results", false));
    frames.step();
    assert.deepEqual([canvas.width, canvas.height], [196, 180]);
    assert.equal(frames.pending(), 0, "the results screen: at rest");

    // main's setBounds lands after the config (a scale or a style from the settings window): the window resizes later
    Object.assign(canvas, { clientWidth: 294, clientHeight: 270 });
    page.dom.window.dispatchEvent({ type: "resize" });
    assert.equal(frames.step(), 1, "resized: drawn again with no new snapshot");
    assert.deepEqual([canvas.width, canvas.height], [294, 270], "the backing store follows, nothing stretched");
    assert.equal(frames.pending(), 0, "then at rest again");

    // Windows' display scaling or a monitor of another pixel ratio: the same size in CSS pixels, more device pixels
    page.ratio(1.5);
    assert.equal(frames.step(), 1, "another pixel ratio: drawn again");
    assert.deepEqual([canvas.width, canvas.height], [441, 405], "sharp at the new ratio");
    page.ratio(2);
    assert.equal(frames.step(), 1, "the next change is heard too");
    assert.deepEqual([canvas.width, canvas.height], [588, 540]);
    assert.equal(frames.pending(), 0);

    on.visible(false);
    Object.assign(canvas, { clientWidth: 196, clientHeight: 180 });
    page.dom.window.dispatchEvent({ type: "resize" });
    assert.equal(frames.pending(), 0, "hidden: a resize draws nothing");
    on.visible(true);
    frames.step();
    assert.deepEqual([canvas.width, canvas.height], [392, 360], "shown again: drawn at the size of then");
});

test("widget: the edit mode's made-up numbers go on moving outside a play; the judgements and the Dan widget never loop in a play", async () => {
    const keys = await openWidget("keys");
    keys.config(true);
    keys.on.visible(true);
    keys.on.state(snap("idle", false));
    for (let i = 0; i < 20; i += 1) assert.equal(keys.frames.step(), 1, "edit mode: the key lines every frame");
    keys.config(false);
    keys.frames.step();
    assert.equal(keys.frames.pending(), 0, "the edit mode over: at rest");

    const page = await openWidget("judgements");
    page.config(true);
    page.on.visible(true);
    page.on.state(snap("idle", false));
    for (let i = 0; i < 5; i += 1) {
        assert.equal(page.frames.step(), 1, "edit mode: the judgements' made-up numbers go on");
        assert.equal(page.frames.pending(), 0, "not every screen refresh: they change every 100 ms");
        await new Promise((r) => setTimeout(r, EASE_MS + 4));
    }
    page.config(false);
    page.frames.step();
    await new Promise((r) => setTimeout(r, EASE_MS + 4));
    page.frames.step();
    await new Promise((r) => setTimeout(r, EASE_MS + 4));
    assert.equal(page.frames.pending(), 0, "the edit mode over: at rest");
    page.on.state(snap("playing", true));
    page.frames.step();
    assert.equal(page.frames.pending(), 0, "the judgements change with the snapshots only");

    const dan = await openWidget("dan");
    dan.config();
    dan.on.visible(true);
    dan.on.state(snap("playing", true));
    dan.frames.step();
    assert.equal(dan.frames.pending(), 0);
    dan.config(true);
    dan.on.state(snap("playing", true));
    dan.frames.step();
    assert.equal(dan.frames.pending(), 0, "in a play the edit mode shows the play itself");
});

test("widget: outside a play the KPS number eases after a snapshot, then the widget rests", async (t) => {
    let clock = 10_000;
    t.mock.method(performance, "now", () => clock);
    const { frames, on, config } = await openWidget("kps");
    config();
    on.visible(true);
    on.state({ ...snap("results", false), kps: { now: 0, max: 12, history: [0] } });
    frames.step();
    on.state({ ...snap("results", false), kps: { now: 12, max: 12, history: [0] } });
    let drawn = 0;
    for (let i = 0; i < 200 && (frames.pending() || drawn === 0 || i < 3); i += 1) {
        clock += 100;
        drawn += frames.step();
        await new Promise((r) => setTimeout(r, EASE_MS + 4));
    }
    assert.ok(drawn >= 2, `the number eased over several frames (${drawn})`);
    await new Promise((r) => setTimeout(r, 4 * EASE_MS));
    assert.equal(frames.pending(), 0, "eased: at rest, no frame and no timer");
});

test("settings window: the previews move every frame on screen and stop while it is minimized or hidden", async () => {
    const page = fakePage("");
    await import(`../app/overlay/settings.js?page=${pageNo}`);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 10; i += 1) assert.equal(page.frames.step(), 1, "on screen: every frame");
    document.visibilityState = "hidden";
    page.fire("visibilitychange");
    assert.equal(page.frames.pending(), 0, "minimized: no frame");
    assert.equal(page.frames.step(), 0);
    document.visibilityState = "visible";
    page.fire("visibilitychange");
    for (let i = 0; i < 3; i += 1) assert.equal(page.frames.step(), 1, "back: moving again");
});
