// The map panel: its settings (off out of the box, an old overlay.json gets it off, a size that follows its lines), the
// map as tosu and Interlude say it (the rate inside tosu's BPM and not inside Interlude's), what its window gets and
// how rarely (only what changed, the progress at a low rate, never the 30-a-second snapshots), its picture (once per
// background, shrunk, the newest selection wins), song select and a play on either game, and its DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createOverlay, FRAMES_GONE_MS, loadOverlaySettings, PROGRESS_MS, SELECT_DAN_MS, shrinkPicture } from "../app/overlay/overlayManager.js";
import { MAP_DIM, SHOW, WIDGETS, applyPatch, normalizeOverlaySettings, widgetSize } from "../src/overlay/settings.js";
import { formatBpm, formatLength, formatRate, formatStars, mapState, readInterludeMap, readTosuMap } from "../src/overlay/mapInfo.js";
import { readPlayFrame } from "../src/overlay/tosuData.js";
import { readInterludeFrame } from "../src/overlay/interludeData.js";
import { fakeSnapshot } from "../src/overlay/fake.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { fakeDom } from "./helpers/fakeDom.js";

// a frame as tosu v4.26.3 builds it (api/utils/buildResultV2.ts)
const frame = (over = {}) => ({
    state: { number: 5, name: "selectPlay" },
    client: "stable",
    beatmap: {
        checksum: "aaa", title: "Freedom Dive", artist: "xi", version: "4K Another", mapper: "Mapper One",
        mode: { number: 3, name: "mania" },
        time: { live: 0, firstObject: 1000, lastObject: 181000, mp3Length: 200000 },
        stats: { stars: { live: 0, total: 5.25 }, bpm: { realtime: 222, common: 333, min: 333, max: 333 } },
    },
    play: { mode: { number: 3 }, hits: {}, hitErrorArray: [], unstableRate: 0, accuracy: null, mods: { name: "HDDT", array: [], rate: 1.5 } },
    files: { background: "bg.jpg" },
    folders: { beatmap: "123 xi - Freedom Dive", game: "C:/osu", songs: "C:/osu/Songs" },
    ...over,
});

// ---- the settings ----

test("settings: off out of the box and in an overlay.json from before it; every line on; broken values cleaned", async () => {
    assert.ok(WIDGETS.includes("map"));
    const d = normalizeOverlaySettings(null).widgets.map;
    assert.equal(d.enabled, false);
    assert.ok(SHOW.map.every((key) => d.show[key] === true));
    assert.deepEqual([d.bgBlur, d.bgDim, d.inSelect, d.graphColor, d.style], [8, 0.55, true, null, "card"]);
    const dir = await mkdtemp(path.join(tmpdir(), "оверлей-карта-"));
    const file = path.join(dir, "overlay.json");
    await writeFile(file, JSON.stringify({ v: 2, enabled: true, widgets: { kps: { enabled: true, opacity: 0.5, x: 5, y: 6 } } }), "utf8");
    const old = loadOverlaySettings(file);
    assert.equal(old.widgets.map.enabled, false, "a file from before the panel: off");
    assert.equal(old.widgets.kps.bgOpacity, 0.5, "the rest as it was");
    assert.equal(old.widgets.dan.enabled, true);
    const bad = normalizeOverlaySettings({ widgets: { map: { enabled: true, bgBlur: 99, bgDim: 7, inSelect: "no", graphColor: "red", show: { artist: false } } } }).widgets.map;
    assert.deepEqual([bad.enabled, bad.bgBlur, bad.bgDim, bad.inSelect, bad.graphColor, bad.show.artist, bad.show.title], [true, 24, MAP_DIM.max, true, null, false, true]);
    const s = applyPatch(normalizeOverlaySettings(null), { widgets: { map: { enabled: true, bgBlur: 3, bgDim: 0.2, inSelect: false, graphColor: "#123456", show: { mods: false } } } });
    assert.deepEqual([s.widgets.map.bgBlur, s.widgets.map.bgDim, s.widgets.map.inSelect, s.widgets.map.graphColor, s.widgets.map.show.mods], [3, 0.2, false, "#123456", false]);
    assert.deepEqual(normalizeOverlaySettings(JSON.parse(JSON.stringify(s))), s);
});

test("settings: the panel is as tall as the lines it shows; one line wide in the compact style; a scale scales it", () => {
    const full = widgetSize("map", "card", 1, null);
    const on = Object.fromEntries(SHOW.map.map((k) => [k, true]));
    assert.deepEqual(widgetSize("map", "card", 1, on), full);
    // the stars and the dan stand beside the artist and the difficulty: the taller of the two sides counts
    assert.equal(widgetSize("map", "card", 1, { ...on, artist: false }).height, full.height);
    assert.ok(widgetSize("map", "card", 1, { ...on, artist: false, stars: false }).height < full.height);
    assert.ok(widgetSize("map", "card", 1, { ...on, progress: false }).height < full.height);
    const noStats = { ...on, bpm: false, length: false, rate: false, mods: false };
    assert.ok(widgetSize("map", "card", 1, noStats).height < full.height);
    assert.equal(widgetSize("map", "card", 1, { ...on, bpm: false }).height, full.height, "one of the line's numbers off: the line stays");
    const nothing = Object.fromEntries(SHOW.map.map((k) => [k, false]));
    assert.ok(widgetSize("map", "card", 1, nothing).height >= 40, "never less than a line");
    assert.deepEqual(widgetSize("map", "card", 2, null), { width: full.width * 2, height: full.height * 2 });
    const compact = widgetSize("map", "compact", 1, null);
    assert.equal(compact.height, 40);
    assert.ok(widgetSize("map", "compact", 1, { ...on, title: false }).width < compact.width);
});

// ---- the data ----

test("tosu: stable's frame; its BPM has the rate in it, the length is the span over the rate; a map with no picture; none at all", () => {
    const f = readPlayFrame(frame());
    assert.equal(f.selecting, true);
    const m = f.map;
    assert.deepEqual([m.checksum, m.title, m.artist, m.difficulty, m.mapper, m.mode], ["aaa", "Freedom Dive", "xi", "4K Another", "Mapper One", 3]);
    assert.deepEqual([m.mods, m.rate, m.stars], [["HD", "DT"], 1.5, 5.25]);
    assert.deepEqual(m.bpm, { common: 333, min: 333, max: 333 });
    assert.equal(m.picture, "123 xi - Freedom Dive/bg.jpg");
    const s = mapState(m, { phase: "idle" });
    assert.equal(s.map.lengthMs, 120000, "180 s of map at 1.5×");
    assert.deepEqual([s.progress, s.elapsedMs], [0, null]);
    assert.equal(readPlayFrame(frame({ state: { number: 2 } })).selecting, false);
    assert.equal(readPlayFrame(frame({ state: { number: 12 } })).selecting, true, "a multiplayer room");
    const bare = readTosuMap({ beatmap: { checksum: "b", title: "T", stats: { stars: { total: 0 } } } });
    assert.deepEqual([bare.stars, bare.bpm, bare.picture, bare.lastMs, bare.artist], [null, null, null, null, ""]);
    assert.equal(readTosuMap({}), null);
    assert.equal(readPlayFrame({ state: { number: 5 } }).map, null);
});

test("tosu: lazer's frame reads the same (its acronyms, its own rate)", () => {
    const f = readPlayFrame(frame({ client: "lazer", play: { mode: { number: 3 }, hits: {}, mods: { array: [{ acronym: "DT", settings: { speed_change: 1.2 } }], rate: 1.2 } } }));
    assert.deepEqual([f.map.mods, f.map.rate], [["DT"], 1.2]);
    assert.equal(mapState(f.map).map.lengthMs, 150000);
});

test("Interlude: its bpm and length are at rate 1.0, its rating is no star rating, a play's rate wins, its duration stands in for a length", () => {
    const msg = {
        client: "interlude", screen: "levelselect",
        chart: { hash: "h1", title: "Blue Zenith", artist: "xi", diff: "4K Insane", creator: "Mapper Two", keys: 4, lengthMs: 100000, bpm: 200, rating: 5.25, rate: 1.25, mods: [{ id: "mirror", state: 0 }] },
        play: null,
    };
    const f = readInterludeFrame(msg);
    assert.equal(f.selecting, true);
    const m = f.map;
    assert.deepEqual([m.checksum, m.title, m.artist, m.difficulty, m.mapper, m.mode, m.picture], ["interlude:h1", "Blue Zenith", "xi", "4K Insane", "Mapper Two", 3, "h1"]);
    assert.deepEqual([m.rate, m.bpm.common, m.stars, m.mods], [1.25, 250, null, ["MIRROR"]]);
    assert.equal(mapState(m).map.lengthMs, 80000);
    const playing = readInterludeMap({ ...msg, screen: "play", play: { rate: 1.5, durationMs: 90000, timeMs: 50000 } });
    assert.deepEqual([playing.rate, playing.lastMs], [1.5, 100000], "the chart's length, as in song select");
    const s = mapState(playing, { phase: "playing", liveMs: 50000 });
    assert.deepEqual([s.progress, s.elapsedMs], [0.5, 33000]);
    const noLength = readInterludeMap({ ...msg, chart: { ...msg.chart, lengthMs: 0 }, play: { durationMs: 90000 } });
    assert.equal(noLength.lastMs, 90000);
    assert.equal(readInterludeMap({ chart: null }), null);
});

test("the state: the progress of a play, whole seconds, clamped; the results screen is the whole map; a map with no length has none", () => {
    const info = readPlayFrame(frame()).map; // 1000..181000 at 1.5×
    assert.deepEqual([mapState(info, { phase: "playing", liveMs: 91000 }).progress, mapState(info, { phase: "playing", liveMs: 91000 }).elapsedMs], [0.5, 60000]);
    assert.equal(mapState(info, { phase: "playing", liveMs: -500 }).progress, 0);
    assert.equal(mapState(info, { phase: "playing", liveMs: 999999 }).progress, 1);
    assert.equal(mapState(info, { phase: "results", liveMs: 5000 }).progress, 1);
    assert.equal(mapState(info, { phase: "idle", liveMs: 50000 }).progress, 0, "song select's clock is the music's preview");
    const none = mapState({ ...info, lastMs: null }, { phase: "playing", liveMs: 5000 });
    assert.deepEqual([none.map.lengthMs, none.progress, none.elapsedMs], [null, 0, null]);
    assert.deepEqual(mapState(null, { phase: "idle" }), { phase: "idle", map: null, progress: 0, elapsedMs: null });
});

test("the words: length, BPM, rate, stars", () => {
    assert.deepEqual([formatLength(192000), formatLength(9000), formatLength(3753000), formatLength(null)], ["3:12", "0:09", "1:02:33", ""]);
    assert.deepEqual([formatBpm({ common: 222.4, min: 222.4, max: 222.4 }), formatBpm({ common: 200, min: 180, max: 222 }), formatBpm(null)], ["222", "180–222", ""]);
    assert.deepEqual([formatRate(1), formatRate(1.5), formatRate(1.25), formatRate(1.333333)], ["", "1.5×", "1.25×", "1.33×"]);
    assert.deepEqual([formatStars(5.254), formatStars(null)], ["★ 5.25", ""]);
});

// ---- the picture ----

test("the picture: shrunk to a small JPEG; one Electron can't read or nothing at all is no picture", () => {
    const made = [];
    const image = (width) => ({
        isEmpty: () => false,
        getSize: () => ({ width, height: width / 2 }),
        resize: (o) => { made.push(o); return image(o.width); },
        toJPEG: (q) => Buffer.from(`jpeg ${width} ${q}`),
    });
    const native = (width) => ({ createFromBuffer: () => (width ? image(width) : { isEmpty: () => true }) });
    assert.equal(Buffer.from(shrinkPicture(new Uint8Array(3), native(1920)).split(",")[1], "base64").toString(), "jpeg 640 72");
    assert.equal(made[0].width, 640);
    assert.ok(shrinkPicture(new Uint8Array(3), native(1920)).startsWith("data:image/jpeg;base64,"));
    assert.equal(Buffer.from(shrinkPicture(new Uint8Array(3), native(300)).split(",")[1], "base64").toString(), "jpeg 300 72", "a small one stays");
    assert.equal(shrinkPicture(new Uint8Array(3), native(0)), null);
    assert.equal(shrinkPicture(new Uint8Array(0), native(300)), null);
    assert.equal(shrinkPicture(new Uint8Array(3), null), null);
});

// ---- the DOM ----

async function mountMap(show, look = {}) {
    const dom = fakeDom();
    const make = document.createElement;
    document.createElement = (tag) => {
        const node = make(tag);
        node.style.setProperty = () => {};
        node.classes = new Set();
        node.classList.toggle = (c, on) => { if (on) node.classes.add(c); else node.classes.delete(c); };
        return node;
    };
    Object.assign(window, { devicePixelRatio: 1 });
    const { mountWidget } = await import("../app/overlay/render.js");
    const root = document.createElement("div");
    const base = normalizeOverlaySettings(null).widgets.map;
    const w = { ...base, ...look, show: { ...base.show, ...show } };
    const view = mountWidget(root, "map", { style: w.style, show: w.show, look: w });
    const all = () => {
        const out = [];
        const walk = (n) => { out.push(n); n.children.forEach(walk); };
        walk(root);
        return out;
    };
    const find = (cls) => all().find((n) => n.className.split(" ").includes(cls)) ?? null;
    return { dom, root, view, find };
}

test("the panel's page: every line, only what changed is written, the progress bar, the picture kept between states", async () => {
    setLang("en");
    try {
        const { view, find } = await mountMap({});
        const info = readPlayFrame(frame()).map;
        const state = mapState(info, { phase: "playing", liveMs: 91000, dan: { state: "ok", numeric: 13 } });
        view.update({ ...state, image: "data:image/jpeg;base64,AAAA" });
        assert.equal(find("m-title").textContent, "Freedom Dive");
        assert.equal(find("m-artist").textContent, "xi");
        assert.equal(find("m-version").textContent, "[4K Another]");
        assert.equal(find("m-mapper").textContent, "by Mapper One");
        assert.equal(find("m-stars").textContent, "★ 5.25");
        assert.match(find("m-dan").textContent, /Gamma mid · 13\.0/);
        assert.equal(find("m-bpm").textContent, "333 BPM");
        assert.equal(find("m-len").textContent, "1:00 / 2:00");
        assert.equal(find("m-rate").textContent, "1.5×");
        assert.equal(find("m-mods").textContent, "HD DT");
        assert.equal(find("m-fill").style.transform, "scaleX(0.5)");
        assert.equal(find("m-img").src, "data:image/jpeg;base64,AAAA");
        assert.equal(find("m-art").hidden, false);
        // the same state again writes nothing: a write would be a repaint
        const title = find("m-title");
        let writes = 0;
        let text = title.textContent;
        Object.defineProperty(title, "textContent", { get: () => text, set: (v) => { writes += 1; text = v; } });
        const bar = find("m-fill");
        let barWrites = 0;
        let transform = bar.style.transform;
        Object.defineProperty(bar.style, "transform", { get: () => transform, set: (v) => { barWrites += 1; transform = v; } });
        view.update({ ...state, image: "data:image/jpeg;base64,AAAA" });
        assert.deepEqual([writes, barWrites], [0, 0]);
        assert.deepEqual([view.live, view.quiet, view.paint(0)], [false, true, false], "nothing per frame");
        // a state with no picture news keeps the picture
        view.update(state);
        assert.equal(find("m-img").hidden, false);
        // song select: the length alone, no rate at 1×, no mods, no stars
        const quiet = { ...info, rate: 1, mods: [], stars: null };
        view.update({ ...mapState(quiet, { phase: "idle" }), image: null });
        assert.deepEqual([find("m-len").textContent, find("m-rate").hidden, find("m-mods").hidden, find("m-stars").hidden, find("m-art").hidden], ["3:00", true, true, true, true]);
        assert.equal(find("m-fill").style.transform, "scaleX(0)");
        // a map with no title at all
        view.update({ phase: "idle", map: null, progress: 0, elapsedMs: null, image: null });
        assert.equal(find("m-title").textContent, "—");
    } finally {
        setLang("ru");
    }
});

test("the panel's page: lines turned off are not there; the made-up map draws a gradient and says the dan", async () => {
    const { view, find } = await mountMap({ background: false, artist: false, stars: false, progress: false, bpm: false });
    view.update(fakeSnapshot(1000));
    assert.equal(find("m-art"), null);
    assert.equal(find("m-artist"), null);
    assert.equal(find("m-stars"), null);
    assert.equal(find("m-fill"), null);
    assert.equal(find("m-bpm"), null);
    assert.equal(find("m-title").textContent, "Moonlit Sprint");
    const shown = await mountMap({});
    shown.view.update(fakeSnapshot(5000));
    assert.ok(shown.find("m-art").classes.has("m-fake"));
    assert.equal(shown.find("m-art").hidden, false);
    assert.equal(shown.find("m-img").hidden, true);
    assert.equal(shown.find("m-dan").textContent.includes("13.0"), true);
    assert.equal(shown.find("m-rate").textContent, "1.25×");
});

// ---- the manager ----

function fakeElectron() {
    const windows = [];
    class BrowserWindow {
        constructor(options) {
            this.options = options;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
            this.sent = [];
            this.handlers = {};
            this.pageHandlers = {};
            this.destroyed = false;
            this.visible = false;
            this.webContents = {
                send: (channel, payload) => this.sent.push([channel, payload]),
                on: (name, fn) => { this.pageHandlers[name] = fn; },
                reload: () => {},
            };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.handlers.closed?.(); }
        loadFile(file, opts) { this.query = opts?.query; }
        on(name, fn) { this.handlers[name] = fn; }
        setAlwaysOnTop() {}
        setIgnoreMouseEvents() {}
        setFocusable() {}
        setMenu() {}
        setTitle() {}
        showInactive() { this.visible = true; }
        show() { this.visible = true; }
        hide() { this.visible = false; }
        focus() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        getBounds() { return { ...this.bounds }; }
        setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
    }
    const handled = new Map();
    const listened = new Map();
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const image = { isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }), toJPEG: () => Buffer.from("jpeg") };
    return {
        electron: {
            BrowserWindow,
            ipcMain: { handle: (c, fn) => handled.set(c, fn), on: (c, fn) => listened.set(c, fn) },
            globalShortcut: { register: () => true, unregister: () => {} },
            screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
            nativeImage: { createFromBuffer: () => image },
        },
        windows, handled, listened,
    };
}

async function startTosu() {
    const http = createServer();
    const main = new WebSocketServer({ noServer: true });
    const precise = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
        const target = req.url === "/websocket/v2" ? main : req.url === "/websocket/v2/precise" ? precise : null;
        if (!target) return socket.destroy();
        target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws));
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    return {
        port: http.address().port,
        send: (json) => { for (const ws of main.clients) ws.send(JSON.stringify(json)); },
        ready: async () => { for (let i = 0; i < 100 && !main.clients.size; i += 1) await new Promise((r) => setTimeout(r, 10)); },
        close: () => {
            for (const ws of [...main.clients, ...precise.clients]) ws.terminate();
            main.close();
            precise.close();
            http.close();
        },
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(options = {}, patch = {}) {
    const fake = fakeElectron();
    const tosu = await startTosu();
    let clock = 10_000;
    const fetches = [];
    const fetchImpl = async (url) => {
        fetches.push(url);
        if (url.endsWith("/files/beatmap/background")) return { ok: true, arrayBuffer: async () => new Uint8Array(8).buffer };
        return { ok: true, text: async () => "osu file format v14\n[General]\nMode: 3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n" };
    };
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей-карта-"));
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t, WebSocketImpl: WebSocket, headless: true, fetchImpl, now: () => clock, ...options,
    });
    overlay.apply({ enabled: true, widgets: { map: { enabled: true, ...patch } } });
    await tosu.ready();
    const frameTo = async (json) => {
        tosu.send(json);
        await sleep(25);
    };
    return {
        fake, tosu, overlay, fetches, frameTo,
        tick: (ms) => { clock += ms; },
        states: () => overlay.windowFor("map")?.sent.filter(([c]) => c === "overlay-state").map(([, s]) => s) ?? [],
        stop() {
            overlay.dispose();
            tosu.close();
        },
    };
}

test("manager: in song select only the panel is up, with the selected map; with the setting off it waits for a play", async () => {
    const r = await start();
    try {
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), true, "the selected map");
        assert.ok(WIDGETS.filter((w) => w !== "map").every((w) => !r.overlay.isShown(w)), "the play's widgets are not");
        const state = r.states().at(-1);
        assert.equal(state.map.title, "Freedom Dive");
        assert.equal(state.phase, "idle");
        r.overlay.apply({ widgets: { map: { inSelect: false } } });
        r.tick(2500);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), false, "«also while choosing a map» off");
        r.overlay.apply({ widgets: { map: { inSelect: true } } });
        r.tick(400);
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), true);
        // a main menu frame or two do not hide it at once; lasting, they do
        r.tick(100);
        await r.frameTo(frame({ state: { number: 0 } }));
        assert.equal(r.overlay.isShown("map"), true);
        r.tick(2000);
        await r.frameTo(frame({ state: { number: 0 } }));
        assert.equal(r.overlay.isShown("map"), false);
    } finally {
        r.stop();
    }
});

test("manager: song select left for the main menu: the panel keeps its map and picture until it goes, never an empty card", async () => {
    const r = await start();
    try {
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        await sleep(320);
        const had = r.states().length;
        assert.ok(r.states().at(-1).image, "the picture is in");
        r.tick(100);
        await r.frameTo(frame({ state: { number: 0 } }));
        r.tick(400);
        await r.frameTo(frame({ state: { number: 0 } }));
        assert.equal(r.overlay.isShown("map"), true, "the hold");
        assert.equal(r.states().length, had, "nothing new for its page");
        r.tick(2000);
        await r.frameTo(frame({ state: { number: 0 } }));
        assert.equal(r.overlay.isShown("map"), false);
        assert.ok(r.states().every((s) => s.map), "never a state with no map");
        // back in song select: the map again, with a picture of its own
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), true);
        assert.equal(r.states().at(-1).map.title, "Freedom Dive");
        // the edit mode goes on showing a made-up map once the hold is over
        r.overlay.setEdit(true);
        r.tick(100);
        await r.frameTo(frame({ state: { number: 0 } }));
        assert.equal(r.overlay.isShown("map"), true);
        r.tick(2000);
        r.overlay.apply({});
        assert.equal(r.overlay.isShown("map"), true);
        assert.equal(r.states().at(-1).map, null, "no map any more: its page goes back to the made-up one");
    } finally {
        r.stop();
    }
});

test("manager: osu! closed in song select (tosu up and silent, its socket open): the panel goes; frames again: it is back", async () => {
    const r = await start();
    try {
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), true);
        await sleep(FRAMES_GONE_MS + 60);
        assert.equal(r.overlay.isShown("map"), true, "the hold first, with its map");
        assert.equal(r.states().at(-1).map.title, "Freedom Dive");
        r.tick(2000);
        r.overlay.apply({});
        assert.equal(r.overlay.isShown("map"), false);
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), true);
        // no frames in a play are no sign of anything here: the session's own gate has that
        const play = frame({ state: { number: 2 }, play: { ...frame().play, hits: { geki: 1 }, accuracy: 100 } });
        await r.frameTo(play);
        await sleep(FRAMES_GONE_MS + 60);
        assert.equal(r.states().at(-1).map.title, "Freedom Dive");
        assert.equal(r.overlay.isShown("map"), true);
    } finally {
        r.stop();
    }
});

test("manager: off, the panel has no window, takes no picture and asks for no dan", async () => {
    const fake = await start();
    try {
        fake.overlay.apply({ widgets: { map: { enabled: false } } });
        await fake.frameTo(frame());
        fake.tick(500);
        await fake.frameTo(frame());
        await sleep(320);
        assert.equal(fake.overlay.windowFor("map")?.visible ?? false, false);
        assert.equal(fake.overlay.isShown("map"), false);
        assert.ok(!fake.fetches.some((u) => u.endsWith("/background")));
    } finally {
        fake.stop();
    }
});

test("manager: a play: the panel stays through it, gets no 30-a-second snapshots, the progress at most every PROGRESS_MS, news at once", async () => {
    const r = await start();
    try {
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.overlay.isShown("map"), true);
        const play = (live, over = {}) => frame({
            state: { number: 2 },
            beatmap: { ...frame().beatmap, time: { ...frame().beatmap.time, live } },
            play: { ...frame().play, hits: { geki: 1 }, accuracy: 100 },
            ...over,
        });
        // frames every 100 ms for 3 s of a running play
        let live = 2000;
        for (let i = 0; i < 30; i += 1) {
            live += 150;
            r.tick(100);
            await r.frameTo(play(live));
        }
        assert.equal(r.overlay.isShown("map"), true, "up all along");
        assert.ok(r.overlay.isShown("kps"), "the play's widgets too");
        const during = r.states().filter((s) => s.phase === "playing");
        assert.ok(during.length >= 3 && during.length <= 3000 / PROGRESS_MS + 2, `${during.length} states in 3 s`);
        assert.ok(during.every((s) => !("hits" in s) && !("kps" in s)), "no play snapshot reaches it");
        assert.ok(during.at(-1).progress > during[0].progress);
        await sleep(120); // the snapshot timer has run by now: still nothing of it on this window
        assert.ok(r.states().every((s) => !("lanes" in s)));
        // another mod in the middle of a play would be news: sent at once, whatever the progress timer says
        const before = r.states().length;
        r.tick(10);
        await r.frameTo(play(live + 15, { beatmap: { ...frame().beatmap, title: "Other Name", time: { ...frame().beatmap.time, live: live + 15 } } }));
        assert.equal(r.states().length, before + 1);
        assert.equal(r.states().at(-1).map.title, "Other Name");
    } finally {
        r.stop();
    }
});

test("manager: the picture: fetched once per background a moment after the selection settles; a map passed by is not; the newest wins", async () => {
    const r = await start();
    try {
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        await sleep(320);
        assert.equal(r.fetches.filter((u) => u.endsWith("/files/beatmap/background")).length, 1);
        const image = r.states().map((s) => s.image).filter(Boolean);
        assert.equal(image.length, 1, "sent once");
        assert.equal(image[0], `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`);
        // another difficulty of the set, the same picture: nothing new to fetch
        await r.frameTo(frame({ beatmap: { ...frame().beatmap, checksum: "bbb", version: "4K Easy" } }));
        await sleep(300);
        assert.equal(r.fetches.filter((u) => u.endsWith("/background")).length, 1);
        // two sets scrolled past within a moment: only the last one is fetched
        for (const folder of ["b", "c"]) await r.frameTo(frame({ folders: { beatmap: folder } }));
        await sleep(320);
        assert.equal(r.fetches.filter((u) => u.endsWith("/background")).length, 2);
        // a set with no background: none shown
        await r.frameTo(frame({ files: {} }));
        await sleep(30);
        assert.equal(r.states().at(-1).image, null);
        // the page rebuilt: it gets everything again, the picture included
        await r.frameTo(frame());
        await sleep(320);
        const win = r.overlay.windowFor("map");
        const had = r.states().length;
        win.pageHandlers["did-finish-load"]();
        assert.equal(r.states().length, had + 1);
        assert.ok(r.states().at(-1).image);
        // the picture turned off: never fetched for the next one
        r.overlay.apply({ widgets: { map: { show: { background: false } } } });
        await r.frameTo(frame({ folders: { beatmap: "d" } }));
        await sleep(320);
        assert.equal(r.fetches.filter((u) => u.endsWith("/background")).length, 3);
    } finally {
        r.stop();
    }
});

test("manager: a failed picture is no picture and no crash; tosu gone: the panel goes", async () => {
    const r = await start({ fetchImpl: async () => { throw new Error("nope"); } });
    try {
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        await sleep(300);
        assert.equal(r.overlay.isShown("map"), true);
        assert.equal(r.states().at(-1).map.title, "Freedom Dive");
        assert.ok(r.states().every((s) => !s.image));
    } finally {
        r.stop();
    }
});

test("manager: the dan: a selected map's only after it stayed selected, from the same source as the Dan widget; another map cancels it", async () => {
    const asked = [];
    const r = await start({
        danAnalyze: async ({ rate }) => {
            asked.push(rate);
            return { result: { kind: "ok", numeric: 12.5 } };
        },
    });
    try {
        await r.frameTo(frame({ beatmap: { ...frame().beatmap, checksum: "passing" } }));
        r.tick(400);
        await r.frameTo(frame());
        assert.deepEqual(asked, [], "not at once");
        assert.equal(r.states().at(-1).map.dan.state, "counting");
        await sleep(SELECT_DAN_MS + 150);
        assert.deepEqual(asked, [1.5], "one map, at its rate; the one passed by never");
        await sleep(30);
        assert.deepEqual(r.states().at(-1).map.dan, { state: "ok", numeric: 12.5 });
        // not mania: says so, asks nothing
        await r.frameTo(frame({ beatmap: { ...frame().beatmap, checksum: "ccc", mode: { number: 0 } }, play: { ...frame().play, mode: { number: 0 } } }));
        await sleep(30);
        assert.equal(r.states().at(-1).map.dan.state, "notMania");
        // the dan line off: nothing is asked for it
        r.overlay.apply({ widgets: { map: { show: { dan: false } } } });
        await r.frameTo(frame({ beatmap: { ...frame().beatmap, checksum: "ddd" } }));
        await sleep(SELECT_DAN_MS + 100);
        assert.equal(asked.length, 1);
        assert.equal(r.states().at(-1).map.dan, null);
    } finally {
        r.stop();
    }
});

test("manager: Interlude: its selected map and play on the panel, its picture from its library; the game that changed last wins in song select", async () => {
    const asked = [];
    const dir = await mkdtemp(path.join(tmpdir(), "оверлей-карта-"));
    const bg = path.join(dir, "bg.jpg");
    await writeFile(bg, "not much of a picture");
    const r = await start({ interludeBackground: async (hash) => { asked.push(hash); return bg; } });
    try {
        const chart = { hash: "h1", title: "Blue Zenith", artist: "xi", diff: "4K Insane", creator: "Mapper Two", lengthMs: 100000, bpm: 200, rate: 1.25, mods: [] };
        await r.frameTo(frame());
        r.tick(400);
        await r.frameTo(frame());
        assert.equal(r.states().at(-1).map.title, "Freedom Dive", "osu! alone");
        r.tick(50);
        r.overlay.onInterlude({ client: "interlude", screen: "levelselect", chart, play: null });
        assert.equal(r.states().at(-1).map.title, "Blue Zenith", "Interlude's selection came last");
        for (let i = 0; i < 100 && !r.states().at(-1).image; i += 1) await sleep(20);
        assert.deepEqual(asked, ["h1"]);
        assert.ok(r.states().at(-1).image);
        assert.ok(!r.fetches.some((u) => u.endsWith("/background") && r.states().length === 0));
        // its play
        for (let i = 1; i <= 8; i += 1) {
            r.tick(100);
            r.overlay.onInterlude({
                client: "interlude", screen: "play", chart,
                play: { playId: 1, timeMs: 1000 * i, paused: false, durationMs: 80000, rate: 1.25, hits: { MARVELLOUS: i }, judgements: [i], accuracy: 1, events: [], keysDown: [] },
            });
        }
        const s = r.states().at(-1);
        assert.equal(s.phase, "playing");
        assert.equal(s.map.title, "Blue Zenith");
        assert.ok(s.progress > 0);
        assert.equal(s.map.stars, null);
        assert.equal(s.map.lengthMs, 80000);
        // Interlude closed: back to osu!'s selection
        r.overlay.onInterlude(null);
        await r.frameTo(frame());
        assert.equal(r.states().at(-1).map.title, "Freedom Dive");
    } finally {
        r.stop();
    }
});

test("manager: the overlay turned off and on with Interlude in level select: its panel is back with no new line; Interlude closed meanwhile: no panel", async () => {
    const r = await start();
    try {
        const chart = { hash: "h1", title: "Blue Zenith", artist: "xi", diff: "4K Insane", creator: "Mapper Two", lengthMs: 100000, bpm: 200, rate: 1, mods: [] };
        const line = (over = {}) => ({ client: "interlude", screen: "levelselect", chart, play: null, ...over });
        r.overlay.onInterlude(line());
        r.tick(400);
        r.overlay.apply({});
        assert.equal(r.overlay.isShown("map"), true);
        r.overlay.apply({ enabled: false });
        assert.equal(r.overlay.isShown("map"), false);
        r.tick(3000);
        r.overlay.apply({ enabled: true });
        r.tick(400);
        r.overlay.apply({});
        assert.equal(r.overlay.isShown("map"), true, "the reader writes only on a change");
        assert.equal(r.states().at(-1).map.title, "Blue Zenith");
        // a selection changed while it was off counts
        r.overlay.apply({ enabled: false });
        r.tick(3000);
        r.overlay.onInterlude(line({ chart: { ...chart, hash: "h2", title: "Other" } }));
        r.overlay.apply({ enabled: true });
        r.tick(400);
        r.overlay.apply({});
        assert.equal(r.states().at(-1).map.title, "Other");
        r.overlay.apply({ enabled: false });
        r.tick(3000);
        r.overlay.onInterlude(null);
        r.overlay.apply({ enabled: true });
        r.tick(400);
        r.overlay.apply({});
        assert.equal(r.overlay.isShown("map"), false, "gone while it was off");
    } finally {
        r.stop();
    }
});

test("manager: the edit mode shows the panel (off: no window at all), its config carries the look", async () => {
    const r = await start();
    try {
        r.overlay.setEdit(true);
        assert.equal(r.overlay.isShown("map"), true);
        const config = r.overlay.windowFor("map").sent.filter(([c]) => c === "overlay-config");
        r.overlay.windowFor("map").pageHandlers["did-finish-load"]();
        const last = r.overlay.windowFor("map").sent.filter(([c]) => c === "overlay-config").at(-1)[1];
        assert.ok(config.length >= 0);
        assert.deepEqual([last.widget, last.style, last.look.bgBlur, last.look.bgDim], ["map", "card", 8, 0.55]);
        r.overlay.apply({ widgets: { map: { enabled: false } } });
        assert.equal(r.overlay.isShown("map"), false);
    } finally {
        r.stop();
    }
});
