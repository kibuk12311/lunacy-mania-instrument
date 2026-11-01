// The overlay's v3 settings: a widget's look (background and text opacity, font, digit weight, corner radius,
// colours), what only one widget has (the judgements shown and their colours, the graphs' length and smoothing, the
// key lines' speed, thickness and column colours), when the widgets show (a pause, the results screen), the overlay's
// own language, snapping to the screen's edges and a drag grid; an older overlay.json loading into them. And the
// widget windows keeping their size while the settings window is open (only its previews show a new scale).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
    JUDGEMENT_KEYS, LANE_SPAN_BASE_MS, SETTINGS_VERSION, WIDGETS, applyPatch, areaOf, lookPatch, normalizeOverlaySettings,
    overlayLang, placeWidget, resizeAnchored, sessionOptions, sizeOf, snapPosition, widgetSize,
} from "../src/overlay/settings.js";
import { createKpsMeter } from "../src/overlay/kps.js";
import { createNpsTrack, WINDOW_BACK } from "../src/overlay/nps.js";
import { createOverlaySession, PAUSE_MS } from "../src/overlay/session.js";
import { fakeSnapshot } from "../src/overlay/fake.js";
import { laneColorFor, laneRects, laneColor } from "../src/overlay/draw.js";
import { createOverlay, loadOverlaySettings } from "../app/overlay/overlayManager.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { fakeDom, textOf } from "./helpers/fakeDom.js";

// ---- the settings themselves ----

test("v3 settings: every new one has a default that draws the widgets as before; broken values are cleaned", () => {
    const d = normalizeOverlaySettings(null);
    assert.equal(d.v, SETTINGS_VERSION);
    assert.equal(d.lang, "app");
    assert.equal(d.showInPlay, true);
    assert.equal(d.showInPause, true, "shown in a pause, as before");
    assert.equal(d.showOnResults, true);
    assert.equal(d.snapEdges, true);
    assert.equal(d.gridStep, 0);
    for (const w of WIDGETS) {
        const x = d.widgets[w];
        assert.deepEqual([x.bgOpacity, x.textOpacity, x.font, x.weight, x.radius], [1, 1, null, 0, null], w);
    }
    assert.deepEqual(d.widgets.judgements.rows, Object.fromEntries(JUDGEMENT_KEYS.map((k) => [k, true])));
    assert.ok(Object.values(d.widgets.judgements.colors).every((c) => c === null));
    assert.deepEqual([d.widgets.kps.graphSec, d.widgets.kps.smoothSec, d.widgets.kps.graphColor], [10, 0.8, null]);
    assert.deepEqual([d.widgets.nps.graphSec, d.widgets.nps.smoothSec], [0, 0.8], "the NPS graph is the whole map");
    assert.deepEqual([d.widgets.keys.speed, d.widgets.keys.thickness, d.widgets.keys.laneColors], [1, 1, {}]);
    // the session's options at the defaults are the meters' own
    assert.deepEqual(sessionOptions(d), { kpsHistoryMs: 10_000, kpsHalfMs: 400, npsHalfMs: 400, npsWindowMs: 0, laneSpanMs: LANE_SPAN_BASE_MS });

    const bad = normalizeOverlaySettings({
        lang: "de", gridStep: 999, showInPause: "no",
        widgets: {
            kps: { bgOpacity: -3, textOpacity: 0, font: "Comic", weight: 650, radius: 99, graphSec: 1, smoothSec: 9, graphColor: "red" },
            nps: { graphSec: 7 },
            judgements: { rows: { max: false, n300: false, n200: false, n100: false, n50: false, miss: false }, colors: { miss: "#ABCDEF", max: "#12" } },
            keys: { speed: 0, thickness: 5, laneColors: { 4: ["#ff0000", "nope"], 2: ["x", "y"], 99: ["#ffffff"] } },
        },
    });
    assert.equal(bad.lang, "app");
    assert.equal(bad.gridStep, 100);
    assert.equal(bad.showInPause, true);
    const k = bad.widgets.kps;
    assert.deepEqual([k.bgOpacity, k.textOpacity, k.font, k.weight, k.radius, k.graphSec, k.smoothSec, k.graphColor], [0, 0.2, null, 0, 24, 3, 2, null]);
    assert.equal(bad.widgets.nps.graphSec, 0, "a window under 10 s is the whole map");
    assert.equal(bad.widgets.judgements.rows.max, true, "one judgement always stays");
    assert.equal(bad.widgets.judgements.colors.miss, "#abcdef");
    assert.equal(bad.widgets.judgements.colors.max, null);
    assert.deepEqual(bad.widgets.keys.laneColors, { 4: ["#ff0000", null, null, null] }, "per key count, a colour per column");
    assert.deepEqual([bad.widgets.keys.speed, bad.widgets.keys.thickness], [0.5, 1]);
    // normalized twice: the same
    assert.deepEqual(normalizeOverlaySettings(JSON.parse(JSON.stringify(bad))), bad);
});

test("an overlay.json from before v3 loads: the one opacity goes to background and text, the rest keeps, the new comes with defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const file = path.join(dir, "overlay.json");
    // as 0.10.x wrote it (v2): an opacity per widget, the keyboard, positions
    const old = {
        v: 2, enabled: true, showOnResults: false,
        widgets: {
            judgements: { enabled: true, style: "neon", opacity: 0.55, scale: 1.4, x: 30, y: 40, show: { counts: true, ratio: false, accuracy: true, ur: true } },
            kps: { enabled: true, style: "compact", opacity: 1, scale: 2.33, x: 100, y: 200, show: { now: true, max: true, graph: true } },
            nps: { enabled: false, style: "card", opacity: 0.1, scale: 1, x: null, y: null, show: { now: true, peak: true, graph: true } },
            keys: { enabled: true, style: "classic", opacity: 0.8, scale: 1, x: 5, y: 6, show: { lines: true, counts: false } },
            dan: { enabled: true, style: "card", opacity: 1, scale: 1, x: null, y: null, show: { map: true, pattern: true, forYou: false, play: false } },
        },
        keyboard: { enabled: true, keys: { 4: ["A", "S", "OemSemicolon", "OemQuotes"] } },
    };
    await writeFile(file, JSON.stringify(old), "utf8");
    const s = loadOverlaySettings(file);
    assert.equal(s.v, SETTINGS_VERSION);
    assert.deepEqual([s.enabled, s.showOnResults, s.showInPlay, s.showInPause, s.lang], [true, false, true, true, "app"]);
    const j = s.widgets.judgements;
    assert.deepEqual([j.style, j.bgOpacity, j.textOpacity, j.scale, j.x, j.y, j.show.ratio], ["neon", 0.55, 0.55, 1.4, 30, 40, false]);
    assert.equal("opacity" in j, false);
    assert.deepEqual([s.widgets.nps.bgOpacity, s.widgets.nps.textOpacity], [0.2, 0.2], "the old range's floor");
    assert.deepEqual([s.widgets.kps.style, s.widgets.kps.scale, s.widgets.kps.graphSec], ["compact", 2.33, 10]);
    assert.equal(s.widgets.keys.show.counts, false);
    assert.equal(s.widgets.dan.show.pattern, true, "a v2 file's Dan choices stay as they were");
    assert.deepEqual(s.keyboard.keys[4], ["A", "S", "OemSemicolon", "OemQuotes"]);
    // and once saved as v3 it reads back the same
    assert.deepEqual(normalizeOverlaySettings(JSON.parse(JSON.stringify(s))), s);
    // a broken file: the defaults
    await writeFile(file, "{ not json", "utf8");
    assert.deepEqual(loadOverlaySettings(file), normalizeOverlaySettings(null));
});

test("patches: the look, the rows and colours merge; lane colours per key count; one look for every widget", () => {
    let s = normalizeOverlaySettings(null);
    s = applyPatch(s, { lang: "en", showInPause: false, snapEdges: false, gridStep: 20 });
    assert.deepEqual([s.lang, s.showInPause, s.snapEdges, s.gridStep], ["en", false, false, 20]);
    s = applyPatch(s, { widgets: { judgements: { rows: { n50: false }, colors: { miss: "#00ff00" } } } });
    s = applyPatch(s, { widgets: { judgements: { rows: { n100: false } } } });
    assert.deepEqual(Object.entries(s.widgets.judgements.rows).filter(([, on]) => !on).map(([k]) => k), ["n100", "n50"]);
    assert.equal(s.widgets.judgements.colors.miss, "#00ff00");
    s = applyPatch(s, { widgets: { keys: { laneColors: { 4: ["#111111", null, null, "#222222"] } } } });
    s = applyPatch(s, { widgets: { keys: { laneColors: { 7: ["#333333"] } } } });
    assert.deepEqual(Object.keys(s.widgets.keys.laneColors), ["4", "7"]);
    s = applyPatch(s, { widgets: { keys: { laneColors: { 4: null } } } });
    assert.deepEqual(Object.keys(s.widgets.keys.laneColors), ["7"]);
    // a key that is not this widget's is not added
    s = applyPatch(s, { widgets: { dan: { graphSec: 20, speed: 2 } } });
    assert.equal("graphSec" in s.widgets.dan, false);
    // the KPS widget's look for every widget; their own things stay
    s = applyPatch(s, { widgets: { kps: { style: "neon", bgOpacity: 0.3, textOpacity: 0.9, font: "consolas", weight: 900, radius: 4, graphSec: 20 } } });
    const all = applyPatch(s, lookPatch(s, "kps"));
    for (const w of WIDGETS) {
        const x = all.widgets[w];
        assert.deepEqual([x.style, x.bgOpacity, x.textOpacity, x.font, x.weight, x.radius], ["neon", 0.3, 0.9, "consolas", 900, 4], w);
    }
    assert.equal(all.widgets.judgements.colors.miss, "#00ff00");
    assert.equal(all.widgets.kps.graphSec, 20);
    assert.equal(overlayLang("app", "en"), "en");
    assert.equal(overlayLang("app", "ru"), "ru");
    assert.equal(overlayLang("en", "ru"), "en");
    assert.equal(overlayLang("ru", "en"), "ru");
});

test("the judgements widget gets shorter for each count hidden (one line wide: narrower)", () => {
    const rows = { max: true, n300: true, n200: true, n100: false, n50: false, miss: true };
    assert.deepEqual(widgetSize("judgements", "card", 1, null, rows), { width: 192, height: 196 - 36 });
    assert.deepEqual(widgetSize("judgements", "compact", 1, null, rows), { width: 625 - 52 - 46, height: 40 });
    assert.deepEqual(widgetSize("judgements", "card", 1, { counts: false }, rows), { width: 192, height: 196 }, "counts off: as before");
    const s = applyPatch(normalizeOverlaySettings(null), { widgets: { judgements: { rows: { n50: false } } } });
    assert.deepEqual(sizeOf("judgements", s.widgets.judgements, 2), { width: 384, height: 356 });
    const placed = placeWidget("judgements", s, [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], 1);
    assert.deepEqual([placed.width, placed.height], [192, 178], "placed at the scale it is given");
});

test("snapping: onto the grid of its own screen, then onto an edge within 14 px; a widget on an edge stays on it when it grows", () => {
    const screens = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }];
    const size = { width: 210, height: 128 };
    assert.deepEqual(snapPosition({ x: 1600, y: 800, ...size }, screens), { x: 1600, y: 800 }, "nowhere near an edge: where it was let go");
    assert.deepEqual(snapPosition({ x: 9, y: 1040 - 128 - 12, ...size }, screens), { x: 0, y: 912 }, "left and bottom edge");
    assert.deepEqual(snapPosition({ x: 1920 - 210 - 5, y: -6, ...size }, screens), { x: 1710, y: 0 }, "right and top edge");
    assert.deepEqual(snapPosition({ x: 9, y: 50, ...size }, screens, { snapEdges: false }), { x: 9, y: 50 }, "snapping off");
    assert.deepEqual(snapPosition({ x: 133, y: 247, ...size }, screens, { snapEdges: false, gridStep: 20 }), { x: 140, y: 240 });
    // the second screen: its own grid and edges
    assert.equal(areaOf({ x: 2000, y: 10, ...size }, screens).x, 1920);
    assert.deepEqual(snapPosition({ x: 1930, y: 333, ...size }, screens, { gridStep: 50 }), { x: 1920, y: 350 });
    assert.deepEqual(snapPosition({ x: 3200 - 210 - 3, y: 1024 - 128, ...size }, screens), { x: 2990, y: 896 });
    // a widget on the right edge growing: still on it; one in the middle: its top-left corner stays
    assert.deepEqual(resizeAnchored({ x: 1710, y: 912, ...size }, { width: 420, height: 256 }, screens), { x: 1500, y: 784, width: 420, height: 256 });
    assert.deepEqual(resizeAnchored({ x: 500, y: 300, ...size }, { width: 420, height: 256 }, screens), { x: 500, y: 300, width: 420, height: 256 });
    assert.deepEqual(resizeAnchored({ x: 0, y: 0, ...size }, { width: 420, height: 256 }, screens), { x: 0, y: 0, width: 420, height: 256 });
});

// ---- the graphs, the key lines and a pause in the session ----

test("KPS: a longer graph is drawn on a coarser grid (never more than 100 steps); a new smoothing keeps the max so far", () => {
    const m = createKpsMeter({ historyMs: 30_000 });
    for (let t = 0; t < 40_000; t += 100) m.press(t);
    const h = m.history(40_000);
    assert.equal(h.values.length, 102, "100 steps of 300 ms, then the point at the clock");
    assert.ok(Math.abs(h.values[50] - 10) < 0.01, "a steady 10 a second reads 10 on the coarse grid too");
    const short = createKpsMeter({ historyMs: 5000 });
    for (let t = 0; t < 8000; t += 100) short.press(t);
    assert.equal(short.history(8000).values.length, 52, "5 s on the 100 ms grid");
    // a burst raises the max; a wider smoothing afterwards keeps it, the curve itself gets calmer
    const k = createKpsMeter();
    for (let t = 0; t < 2000; t += 50) k.press(t);
    for (let t = 2000; t < 2400; t += 20) k.press(t);
    const max = k.max();
    assert.ok(max > 30);
    k.configure({ half: 1000, historyMs: 20_000 });
    assert.deepEqual(k.options(), { historyMs: 20_000, half: 1000 });
    assert.equal(k.max(), max);
    assert.ok(k.now(3000) < max, "the curve on the wide window is below the narrow one's max");
});

test("NPS: a window around the playhead scrolls under it on a grid fixed to the map, its top the map's peak", () => {
    const track = createNpsTrack();
    track.setMap(Array.from({ length: 600 }, (_, i) => ({ t: 1000 + i * (i < 300 ? 100 : 50) })));
    const whole = track.at(20_000);
    assert.ok(Array.isArray(whole.profile) && whole.profile.length === 160);
    assert.equal(whole.top, Math.max(...whole.profile));
    const a = track.at(20_000, { windowMs: 30_000 });
    const b = track.at(20_150, { windowMs: 30_000 });
    assert.equal(a.progress, WINDOW_BACK);
    assert.equal(a.top, a.peak);
    assert.equal(a.profile.values.length, 102);
    assert.ok(a.profile.shift >= 0 && a.profile.shift < 1);
    // 150 ms later the same grid points (300 ms apart): the values one step on are the same, nothing wobbles
    const step = 30_000 / 100;
    const shiftSteps = Math.round((Math.floor((20_150 - 10_000) / step) - Math.floor((20_000 - 10_000) / step)));
    for (let i = 0; i + shiftSteps < 101; i += 1) assert.equal(b.profile.values[i], a.profile.values[i + shiftSteps]);
    // a smoothing of its own
    track.setHalf(1000);
    assert.ok(Math.abs(track.at(20_000).now - whole.now) < 1, "a steady stretch reads the same, smoothed more or less");
});

test("session: the options change the graphs and the key lines at once; a clock standing PAUSE_MS after moving is a pause", () => {
    const s = createOverlaySession({ kpsHistoryMs: 20_000, laneSpanMs: 750, npsWindowMs: 30_000 });
    const frame = (liveMs) => ({ state: "playing", checksum: "c", mode: 3, rate: 1, mods: [], liveMs, hits: { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, hitErrors: [] });
    s.onFrame(frame(1000), 0);
    s.setMap("c", { keys: 4, notes: Array.from({ length: 200 }, (_, i) => ({ t: 1000 + i * 100, col: i % 4, end: null })) });
    for (let i = 1; i <= 20; i += 1) s.onFrame(frame(1000 + i * 100), i * 100);
    const snap = s.snapshot(2000);
    assert.equal(snap.lanes.spanMs, 750);
    assert.equal(snap.kps.history.values.length, 102, "20 s on a 200 ms grid");
    assert.equal(snap.nps.profile.values.length, 102);
    s.configure({ kpsHistoryMs: 10_000, laneSpanMs: 3000, npsWindowMs: 0 });
    const next = s.snapshot(2000);
    assert.equal(next.lanes.spanMs, 3000);
    assert.ok(Array.isArray(next.nps.profile));
    // the clock stands from real 2000 on: not a pause yet, then one
    for (let at = 2100; at <= 2000 + PAUSE_MS + 200; at += 100) s.onFrame(frame(3000), at);
    assert.equal(s.paused(2000 + 1000), false);
    assert.equal(s.pauseIn(2000 + 1000), PAUSE_MS - 1000);
    assert.equal(s.paused(2000 + PAUSE_MS + 10), true);
    assert.equal(s.pauseIn(2000 + PAUSE_MS + 10), null);
    s.onFrame(frame(3100), 4000);
    assert.equal(s.paused(4000), false, "moving again: playing");
});

test("the made-up numbers follow the options; the key lines' thickness and own colours", () => {
    const f = fakeSnapshot(60_000, { laneSpanMs: 3000, kpsHistoryMs: 30_000, kpsHalfMs: 100, npsWindowMs: 20_000 });
    assert.equal(f.lanes.spanMs, 3000);
    assert.ok(f.lanes.bars.every((b) => b.end > 60_000 - 3000 - 400));
    assert.equal(f.kps.history.values.length, 102);
    assert.equal(f.nps.progress, WINDOW_BACK);
    assert.equal(fakeSnapshot(60_000, { kpsHalfMs: 100 }).kps.max, fakeSnapshot(61_234, { kpsHalfMs: 100 }).kps.max, "the max stays put");
    const [full] = laneRects([{ col: 1, start: 0, end: 100 }], { clock: 100, spanMs: 1000, keys: 4, width: 200, height: 100 });
    const [thin] = laneRects([{ col: 1, start: 0, end: 100 }], { clock: 100, spanMs: 1000, keys: 4, width: 200, height: 100, fill: 0.5 });
    assert.deepEqual([full.x, full.w], [51.5, 47]);
    assert.deepEqual([thin.x, thin.w], [63.25, 23.5], "half as wide, in the middle of its lane");
    const own = { 4: ["#111111", null, null, "#444444"] };
    assert.equal(laneColorFor("card", 0, 4, own), "#111111");
    assert.equal(laneColorFor("card", 1, 4, own), laneColor("card", 1));
    assert.equal(laneColorFor("card", 0, 7, own), laneColor("card", 0), "another key count: the style's");
});

// ---- the widgets drawn with a look ----

test("render: the look as variables; judgements hidden are not drawn", async () => {
    const dom = fakeDom();
    const make = document.createElement;
    const props = new WeakMap();
    document.createElement = (tag) => {
        const node = make(tag);
        const vars = {};
        props.set(node, vars);
        node.style.setProperty = (k, v) => { vars[k] = v; };
        node.style.removeProperty = (k) => { delete vars[k]; };
        return node;
    };
    Object.assign(window, { devicePixelRatio: 1 });
    const { lookVars, mountWidget } = await import("../app/overlay/render.js");
    assert.deepEqual(Object.values(lookVars(normalizeOverlaySettings(null).widgets.kps)).filter((v) => v !== null), [], "the defaults: the style's own");
    const s = applyPatch(normalizeOverlaySettings(null), {
        widgets: { judgements: { bgOpacity: 0.4, textOpacity: 0.7, font: "bahnschrift", weight: 600, radius: 3, rows: { n50: false, n100: false }, colors: { miss: "#00ff00" } } },
    });
    const vars = lookVars(s.widgets.judgements);
    assert.equal(vars["--bg-alpha"], "0.4");
    assert.equal(vars["--text-alpha"], "0.7");
    assert.match(vars["--font-user"], /Bahnschrift/);
    assert.equal(vars["--num-weight"], "600");
    assert.equal(vars["--radius-user"], "3px");
    assert.equal(vars["--miss"], "#00ff00");
    const root = document.createElement("div");
    const view = mountWidget(root, "judgements", { style: "card", show: s.widgets.judgements.show, look: s.widgets.judgements });
    view.update(fakeSnapshot(1000));
    assert.equal(props.get(root)["--bg-alpha"], "0.4");
    const rows = root.children[0].children[0].children;
    assert.deepEqual(rows.map((r) => r.children[0].textContent), ["MAX", "300", "200", t("overlay.label.miss")]);
    // the classic style's rainbow MAX gives way to a colour set for it (app/overlay/overlay.css reads the class)
    const look = (colors) => applyPatch(normalizeOverlaySettings(null), { widgets: { judgements: { colors } } }).widgets.judgements;
    mountWidget(root, "judgements", { style: "classic", show: s.widgets.judgements.show, look: look({ miss: "#00ff00" }) });
    assert.ok(!root.className.split(" ").includes("own-max"));
    mountWidget(root, "judgements", { style: "classic", show: s.widgets.judgements.show, look: look({ max: "#00ff00" }) });
    assert.ok(root.className.split(" ").includes("own-max"));
    void dom;
});

test("the look's CSS: the rainbow MAX only without a colour of its own; the compact map panel's texts inside .m-top take the text opacity", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("../app/overlay/overlay.css", import.meta.url), "utf8");
    assert.match(css, /\.style-classic:not\(\.own-max\) \.j-max \.j-label \{/);
    assert.match(css, /\.style-compact \.m-top \{ display: contents; \}\n\.style-compact \.m-top > \* \{ opacity: var\(--text-alpha, 1\); \}/);
    assert.match(css, /\.m-art\.m-fake::before \{[^}]*filter: var\(--map-filter/, "the previews' picture is blurred as a real one");
});

// ---- the settings window in either language ----

async function openPage(settings, appLang) {
    const dom = fakeDom();
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.location = { search: "" };
    const make = document.createElement;
    document.createElement = (tag) => {
        const node = make(tag);
        node.style.setProperty = () => {};
        node.style.removeProperty = () => {};
        return node;
    };
    Object.assign(document, {
        body: { classList: { toggle() {} } },
        documentElement: { style: {} },
        visibilityState: "hidden",
        addEventListener: () => {},
    });
    Object.assign(window, { devicePixelRatio: 1, matchMedia: () => ({ addEventListener() {} }) });
    let current = settings;
    const patches = [];
    window.overlayApi = {
        lang: appLang,
        onConfig() {}, onState() {}, onVisible() {}, setScale() {}, setEdit() {},
        get: async () => ({ settings: current, edit: false }),
        set: async (patch) => {
            patches.push(patch);
            current = applyPatch(current, patch);
            return { settings: current, edit: false };
        },
        onSettings(fn) { window.overlayApi.broadcast = (patch) => { current = applyPatch(current, patch); fn({ settings: current, edit: false }); }; },
        keys: async () => ({ keys: 4, enabled: true, found: false, file: null, osu: null, manual: null, effective: null, reader: null }),
    };
    await import(`../app/overlay/settings.js?v3=${Math.random()}`);
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 5));
    return { dom, patches, text: () => [textOf(dom.$("widgets")), textOf(dom.$("lang")), textOf(dom.$("grid")), dom.$("hint").textContent].join(" | ") };
}

const CYR = /[А-Яа-яЁё]/;

test("settings window: in the overlay's own language, whatever the app's; every text found; the new controls send their patches", async () => {
    try {
        const en = await openPage(normalizeOverlaySettings({ lang: "en" }), "ru");
        const text = en.text();
        assert.ok(!CYR.test(text.replace("Русский", "")), `no Russian on the English page: ${text.match(/.{20}[А-Яа-яЁё]+.{20}/)?.[0]}`);
        assert.ok(!/overlay\.\w+\.\w+/.test(text), "no text key shown as itself");
        assert.ok(text.includes("More settings") && text.includes("Background") && text.includes("Digit weight"));
        assert.ok(text.includes("Graph of the last 10 s"));
        assert.equal(en.dom.$("lang").value, "en");

        const ru = await openPage(normalizeOverlaySettings({ lang: "app" }), "ru");
        const rtext = ru.text();
        assert.ok(rtext.includes("Ещё настройки") && rtext.includes("Толщина цифр") && rtext.includes("Как в приложении"));
        assert.ok(!/overlay\.\w+\.\w+/.test(rtext));
        // the general block's new switches
        const fireChange = async (id, target) => { for (const fn of ru.dom.$(id).listeners.change ?? []) await fn({ target }); };
        await fireChange("play", { checked: false });
        await fireChange("pause", { checked: false });
        await fireChange("lang", { value: "en" });
        await fireChange("grid", { value: "20" });
        await fireChange("snap", { checked: false });
        assert.deepEqual(ru.patches, [{ showInPlay: false }, { showInPause: false }, { lang: "en" }, { gridStep: 20 }, { snapEdges: false }]);
    } finally {
        setLang("ru");
    }
});

test("settings window: a slider follows a change from elsewhere (a widget's own corner) though it has the focus; just moved by hand, an older answer leaves it alone", async () => {
    try {
        const page = await openPage(normalizeOverlaySettings(null), "ru");
        const inputs = [];
        const walk = (n) => {
            if (n.tagName === "INPUT" && n.type === "range") inputs.push(n);
            n.children.forEach(walk);
        };
        walk(page.dom.$("widgets"));
        const size = inputs.find((i) => i.min === "50" && i.max === "250");
        document.activeElement = size;
        window.overlayApi.broadcast({ widgets: { judgements: { scale: 1.7 } } });
        assert.equal(size.value, "170", "the corner moved it, the slider last had the focus");
        size.value = "120";
        for (const fn of size.listeners.input) fn({});
        await new Promise((r) => setTimeout(r, 5));
        window.overlayApi.broadcast({ widgets: { judgements: { scale: 1.1 } } });
        assert.equal(size.value, "120", "the hand's value stands");
    } finally {
        setLang("ru");
    }
});

// ---- the manager: the size kept while the settings window is open, snapping, a pause, the language ----

function fakeElectron() {
    const windows = [];
    class BrowserWindow {
        constructor(options) {
            this.options = options;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
            this.calls = [];
            this.sent = [];
            this.handlers = {};
            this.destroyed = false;
            this.visible = false;
            this.pageHandlers = {};
            this.title = options.title;
            this.webContents = {
                send: (channel, payload) => this.sent.push([channel, payload]),
                on: (name, fn) => { this.pageHandlers[name] = fn; },
                reload: () => this.calls.push(["reload"]),
            };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.handlers.closed?.(); }
        loadFile(file, opts) { this.file = file; this.query = opts?.query; }
        on(name, fn) { this.handlers[name] = fn; }
        setAlwaysOnTop() {}
        setIgnoreMouseEvents() {}
        setFocusable() {}
        setMenu() {}
        setTitle(title) { this.title = title; }
        showInactive() { this.visible = true; }
        show() { this.visible = true; }
        hide() { this.visible = false; this.calls.push(["hide"]); }
        focus() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        getBounds() { return { ...this.bounds }; }
        setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; this.calls.push(["setPosition", x, y]); }
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; this.calls.push(["setBounds", b]); }
    }
    const handled = new Map();
    const listened = new Map();
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    return {
        electron: {
            BrowserWindow,
            ipcMain: { handle: (c, fn) => handled.set(c, fn), on: (c, fn) => listened.set(c, fn) },
            globalShortcut: { register: () => true, unregister: () => {} },
            screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
        },
        windows, handled, listened,
    };
}

async function startTosu() {
    const { createServer } = await import("node:http");
    const http = createServer();
    const main = new WebSocketServer({ noServer: true });
    const precise = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
        const target = req.url === "/websocket/v2" ? main : req.url === "/websocket/v2/precise" ? precise : null;
        if (!target) return socket.destroy();
        target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws));
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const clients = [];
    main.on("connection", (ws) => clients.push(ws));
    return {
        port: http.address().port,
        send: (json) => { for (const ws of clients) ws.send(JSON.stringify(json)); },
        connected: () => clients.length > 0,
        close: async () => {
            for (const ws of clients) ws.terminate();
            main.close();
            precise.close();
            await new Promise((r) => http.close(r));
        },
    };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timed out");
        await sleep(15);
    }
};
const OSU = "[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n448,192,1100,1,0,0:0:0:0:\n";
const tosuFrame = (stateNumber, live) => ({
    state: { number: stateNumber },
    beatmap: { checksum: "abc", time: { live }, mode: { number: 3 } },
    play: { mode: { number: 3 }, hits: { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 }, mods: { rate: 1 } },
});

test("manager: with the settings window open the widgets keep their size (the corner still resizes at once); closed, they take it", async () => {
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({ electron: fake.electron, userData, port: 1, t, WebSocketImpl: WebSocket, headless: true });
    try {
        const set = (patch) => fake.handled.get("overlay-set")(null, patch);
        await set({ enabled: true, widgets: { kps: { x: 1920 - 210, y: 500 } } });
        overlay.setEdit(true);
        const kps = overlay.windowFor("kps");
        const nps = overlay.windowFor("nps");
        assert.deepEqual([kps.bounds.width, kps.bounds.height], [210, 128]);
        const sw = overlay.openSettings();
        await set({ widgets: { kps: { scale: 2 }, nps: { scale: 1.5 } } });
        assert.deepEqual([kps.bounds.width, kps.bounds.height], [210, 128], "the settings window is open: the same size");
        assert.equal(kps.sent.filter(([c]) => c === "overlay-config").at(-1)[1].scale, 1, "and drawn at its scale");
        assert.equal(overlay.settings().widgets.kps.scale, 2, "the setting itself is saved");
        // a style of another size waits too: the widget keeps its size and the style it has
        const j = overlay.windowFor("judgements");
        await set({ widgets: { judgements: { style: "compact" } } });
        assert.deepEqual([j.bounds.width, j.bounds.height], [192, 196], "another style's size waits as well");
        assert.equal(j.sent.filter(([c]) => c === "overlay-config").at(-1)[1].style, "card");
        // one of the same size goes through at once, and so does all that takes no room
        await set({ widgets: { kps: { style: "neon", font: "consolas" } } });
        const kpsConfig = kps.sent.filter(([c]) => c === "overlay-config").at(-1)[1];
        assert.deepEqual([kpsConfig.style, kpsConfig.look.font, kpsConfig.scale], ["neon", "consolas", 1]);
        const { held } = await set({ widgets: { dan: { font: "arial" } } });
        assert.deepEqual(held, ["judgements", "kps", "nps"], "the settings window is told whose new size waits");
        // the corner of a widget: at once, settings window or not
        fake.listened.get("overlay-scale")(null, { widget: "dan", scale: 2 });
        assert.equal(overlay.windowFor("dan").bounds.height, 128);
        // closed: the new scales; the one on the right edge stays on it
        sw.destroy();
        assert.deepEqual(kps.bounds, { x: 1920 - 420, y: 500, width: 420, height: 256 });
        assert.equal(overlay.settings().widgets.kps.x, 1920 - 420, "that spot is the one saved: it stays there after a restart");
        assert.equal(overlay.settings().widgets.kps.y, 500);
        assert.deepEqual([nps.bounds.width, nps.bounds.height], [315, 192]);
        assert.equal(kps.sent.filter(([c]) => c === "overlay-config").at(-1)[1].scale, 2);
        assert.deepEqual([j.bounds.width, j.bounds.height], [625, 40], "closed: the style's size");
        assert.equal(j.sent.filter(([c]) => c === "overlay-config").at(-1)[1].style, "compact");
        assert.equal(overlay.windowFor("dan").bounds.height, 128, "the corner's scale stays");
        // no settings window: a scale set (the main window, the tray) resizes at once again
        await set({ widgets: { kps: { scale: 1 } } });
        assert.deepEqual(kps.bounds, { x: 1920 - 210, y: 500, width: 210, height: 128 });
        assert.equal(overlay.settings().widgets.kps.x, 1920 - 210, "shrinking on the edge is saved too");
        // the widget's own corner, on the bottom edge
        const keys = overlay.windowFor("keys");
        keys.bounds = { ...keys.bounds, x: 300, y: 1080 - keys.bounds.height };
        keys.handlers.moved();
        fake.listened.get("overlay-scale")(null, { widget: "keys", scale: 1.5 });
        assert.equal(keys.bounds.y, 1080 - keys.bounds.height);
        assert.equal(overlay.settings().widgets.keys.y, keys.bounds.y);
    } finally {
        overlay.dispose();
    }
});

test("a saved spot its window no longer fits in comes back on the screen; across two screens and over the taskbar it stays", () => {
    const one = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const at = (x, y, scale = 2) => applyPatch(normalizeOverlaySettings(null), { widgets: { kps: { x, y, scale } } });
    // set at scale 1 on the right edge, the scale changed with no window to move it
    assert.deepEqual(placeWidget("kps", at(1710, 500), one), { x: 1500, y: 500, width: 420, height: 256 });
    assert.deepEqual(placeWidget("kps", at(100, 1000), one), { x: 100, y: 824, width: 420, height: 256 }, "and the bottom");
    assert.deepEqual(placeWidget("kps", at(100, 800), one), { x: 100, y: 800, width: 420, height: 256 }, "over the taskbar's place: left there");
    const two = [one[0], { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];
    assert.equal(placeWidget("kps", at(1800, 500), two).x, 1800, "across two screens: left there");
    assert.equal(placeWidget("kps", at(3700, 500), two).x, 3840 - 420, "on the second screen's edge");
});

test("manager: a widget moved so that its new size stays clear of the settings window takes it; one that would touch it keeps waiting", async () => {
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({ electron: fake.electron, userData, port: 1, t, WebSocketImpl: WebSocket, headless: true });
    try {
        const set = (patch) => fake.handled.get("overlay-set")(null, patch);
        await set({ enabled: true, snapEdges: false, widgets: { kps: { x: 200, y: 100 } } });
        overlay.setEdit(true);
        const kps = overlay.windowFor("kps");
        const sw = overlay.openSettings();
        sw.bounds = { x: 420, y: 40, width: 600, height: 800 };
        await set({ widgets: { kps: { scale: 2.5 } } }); // 525×320
        assert.deepEqual([kps.bounds.width, kps.bounds.height], [210, 128], "beside the window: it keeps its size");
        // moved, but at 525 px wide it would still reach the window (x 300 + 525 > 420)
        kps.bounds = { ...kps.bounds, x: 300 };
        kps.handlers.moved();
        assert.deepEqual([kps.bounds.width, kps.bounds.height], [210, 128], "still too near: it waits");
        // moved clear: under the window's right edge
        kps.bounds = { ...kps.bounds, x: 1100 };
        kps.handlers.moved();
        assert.deepEqual([kps.bounds.width, kps.bounds.height], [525, 320], "clear of the window: it takes the new size");
        assert.equal(kps.sent.filter(([c]) => c === "overlay-config").at(-1)[1].scale, 2.5);
        // and the other way round: the settings window moved away from a widget that waits
        const nps = overlay.windowFor("nps");
        await set({ widgets: { nps: { x: 500, y: 300, scale: 2 } } });
        nps.bounds = { ...nps.bounds, x: 500, y: 300 };
        sw.handlers.moved();
        assert.deepEqual([nps.bounds.width, nps.bounds.height], [210, 128], "under the window: it waits");
        sw.bounds = { x: 1200, y: 40, width: 600, height: 800 };
        sw.handlers.moved();
        assert.deepEqual([nps.bounds.width, nps.bounds.height], [420, 256], "the window moved away: it takes it");
    } finally {
        overlay.dispose();
    }
});

test("manager: the settings window stays above the top-most widgets while it is in use, and sinks when another program is", async () => {
    const fake = fakeElectron();
    const order = [];
    const { BrowserWindow } = fake.electron;
    BrowserWindow.prototype.isVisible = function isVisible() { return this.visible; };
    BrowserWindow.prototype.isFocused = function isFocused() { return this.focused === true; };
    BrowserWindow.prototype.moveTop = function moveTop() { order.push(this.query?.w ?? "settings"); };
    BrowserWindow.prototype.setAlwaysOnTop = function setAlwaysOnTop(on, level) { this.onTop = [on, level]; };
    let focused = null;
    BrowserWindow.getFocusedWindow = () => focused;
    const timers = [];
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({
        electron: fake.electron, userData, port: 1, t, WebSocketImpl: WebSocket,
        setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: () => {},
    });
    try {
        overlay.apply({ enabled: true });
        overlay.setEdit(true);
        const sw = overlay.openSettings();
        assert.deepEqual(sw.onTop, [true, "screen-saver"], "opened: above the widgets");
        order.length = 0;
        // the watchdog raises the widgets: the settings window comes last, over them
        overlay.keepUp();
        assert.equal(order.at(-1), "settings", `${order.join()}`);
        assert.ok(order.length > 1);
        // a click on a widget in the edit mode raises that widget
        order.length = 0;
        overlay.windowFor("kps").handlers.focus();
        assert.deepEqual(order, ["settings"]);
        // the focus goes to a widget: it stays up
        focused = overlay.windowFor("kps");
        sw.handlers.blur();
        await new Promise((r) => setTimeout(r, 90));
        assert.deepEqual(sw.onTop, [true, "screen-saver"]);
        // to another program (the game): it sinks and stays down, and the widgets are not fought with
        focused = null;
        sw.handlers.blur();
        await new Promise((r) => setTimeout(r, 90));
        assert.deepEqual(sw.onTop, [false, undefined]);
        order.length = 0;
        overlay.keepUp();
        assert.ok(!order.includes("settings"));
        // clicked again: above them again
        sw.handlers.focus();
        assert.deepEqual(sw.onTop, [true, "screen-saver"]);
        assert.equal(order.at(-1), "settings");
    } finally {
        overlay.dispose();
    }
});

test("manager: a widget let go near an edge snaps to it, onto the grid when one is set; the configs carry the look, the language, the options", async () => {
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({ electron: fake.electron, userData, port: 1, t, WebSocketImpl: WebSocket, headless: true });
    try {
        const set = (patch) => fake.handled.get("overlay-set")(null, patch);
        await set({ enabled: true });
        overlay.setEdit(true);
        const kps = overlay.windowFor("kps");
        kps.bounds = { ...kps.bounds, x: 1920 - 210 - 9, y: 6 };
        kps.handlers.moved();
        assert.deepEqual([kps.bounds.x, kps.bounds.y], [1710, 0]);
        assert.deepEqual([overlay.settings().widgets.kps.x, overlay.settings().widgets.kps.y], [1710, 0]);
        await set({ gridStep: 25 });
        kps.bounds = { ...kps.bounds, x: 612, y: 389 };
        kps.handlers.moved();
        assert.deepEqual([kps.bounds.x, kps.bounds.y], [600, 400]);
        await set({ snapEdges: false, gridStep: 0 });
        kps.bounds = { ...kps.bounds, x: 3, y: 4 };
        kps.handlers.moved();
        assert.deepEqual([kps.bounds.x, kps.bounds.y], [3, 4], "snapping off: where it was let go");

        await set({ lang: "en", widgets: { kps: { graphColor: "#ff00ff", graphSec: 20 }, keys: { speed: 2 } } });
        const config = kps.sent.filter(([c]) => c === "overlay-config").at(-1)[1];
        assert.equal(config.lang, "en");
        assert.equal(config.look.graphColor, "#ff00ff");
        assert.deepEqual([config.options.kpsHistoryMs, config.options.laneSpanMs], [20_000, 750]);
        assert.equal("opacity" in config, false);
    } finally {
        overlay.dispose();
    }
});

test("manager: the overlay's language rebuilds the settings window in it; titles follow it, the tray keeps the app's", async () => {
    setLang("ru");
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({ electron: fake.electron, userData, port: 1, t, WebSocketImpl: WebSocket, headless: true });
    try {
        const set = (patch) => fake.handled.get("overlay-set")(null, patch);
        const sw = overlay.openSettings();
        assert.equal(sw.title, "Оверлей — Lunacy mania");
        await set({ lang: "en" });
        assert.equal(sw.title, "Overlay — Lunacy mania");
        assert.ok(sw.calls.some((c) => c[0] === "reload"), "the page is built again in English");
        await set({ enabled: true });
        overlay.setEdit(true);
        assert.equal(overlay.windowFor("kps").options.title, "KPS");
        assert.equal(overlay.windowFor("keys").options.title, "Key lines");
        assert.equal(overlay.trayItems()[0].label, "Оверлей", "the tray speaks the app's language");
        const reloads = sw.calls.filter((c) => c[0] === "reload").length;
        await set({ widgets: { kps: { style: "neon" } } });
        assert.equal(sw.calls.filter((c) => c[0] === "reload").length, reloads, "only the language reloads it");
    } finally {
        overlay.dispose();
    }
});

test("manager: with «in a pause» off the widgets hide while osu!'s clock stands and come back when it moves", async () => {
    const tosu = await startTosu();
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t, headless: true,
        WebSocketImpl: WebSocket, fetchImpl: async () => ({ ok: true, text: async () => OSU }),
    });
    try {
        await fake.handled.get("overlay-set")(null, { enabled: true, showInPause: false });
        await until(() => tosu.connected());
        let live = 300;
        const play = async (ms) => {
            for (const end = live + ms; live < end; live += 50) {
                tosu.send(tosuFrame(2, live));
                await sleep(50);
            }
        };
        await play(800);
        await until(() => overlay.isShown("kps"));
        // the pause: tosu goes on sending the same time
        const start = Date.now();
        while (overlay.isShown("kps") && Date.now() - start < 4000) {
            tosu.send(tosuFrame(2, live));
            await sleep(100);
        }
        const hiddenAfter = Date.now() - start;
        assert.equal(overlay.isShown("kps"), false, "hidden in the pause");
        assert.ok(hiddenAfter >= PAUSE_MS - 100, `not before it lasted (${hiddenAfter} ms)`);
        // wanted in a pause after all: back (through the gate, as any show)
        await fake.handled.get("overlay-set")(null, { showInPause: true });
        await until(() => overlay.isShown("kps"));
        await fake.handled.get("overlay-set")(null, { showInPause: false });
        await until(() => !overlay.isShown("kps"));
        // the play goes on: back
        await play(900);
        await until(() => overlay.isShown("kps"));
        // the clock stands on two frames, then none come at all: hidden by a timer all the same
        tosu.send(tosuFrame(2, live));
        await sleep(60);
        tosu.send(tosuFrame(2, live));
        await sleep(PAUSE_MS + 600);
        assert.equal(overlay.isShown("kps"), false, "a clock left standing with no frames coming is a pause too");
    } finally {
        overlay.dispose();
        await tosu.close();
    }
});

test("manager: when to show: only in a pause; only on the results screen; a play not wanted never brings them up", async () => {
    const tosu = await startTosu();
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-v3-"));
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t, headless: true,
        WebSocketImpl: WebSocket, fetchImpl: async () => ({ ok: true, text: async () => OSU }),
    });
    const set = (patch) => fake.handled.get("overlay-set")(null, patch);
    try {
        await set({ enabled: true, showInPlay: false, showInPause: false, showOnResults: true });
        await until(() => tosu.connected());
        let live = 300;
        const play = async (ms) => {
            for (const end = live + ms; live < end; live += 50) {
                tosu.send(tosuFrame(2, live));
                await sleep(50);
            }
        };
        await play(1000);
        assert.equal(overlay.isShown("kps"), false, "a play: not wanted");
        // the results screen: wanted
        tosu.send(tosuFrame(7, live));
        await until(() => overlay.isShown("kps"));
        tosu.send(tosuFrame(5, live));
        await until(() => !overlay.isShown("kps"));

        // the play hidden, the pause shown: the clock stands, they come up; it moves, they go
        await set({ showInPause: true, showOnResults: false });
        await play(800);
        assert.equal(overlay.isShown("kps"), false);
        const start = Date.now();
        while (!overlay.isShown("kps") && Date.now() - start < 5000) {
            tosu.send(tosuFrame(2, live));
            await sleep(100);
        }
        assert.equal(overlay.isShown("kps"), true, "up in the pause");
        assert.ok(Date.now() - start >= PAUSE_MS - 100, "not before it is a pause");
        await play(700);
        await until(() => !overlay.isShown("kps"));
    } finally {
        overlay.dispose();
        await tosu.close();
    }
});
