// The overlay's window manager with a fake Electron and a fake tosu (a real WebSocket server): the widget windows
// appear while osu! plays and go away after, are click-through except in the edit mode, keep their settings in
// overlay.json, and every channel the overlay preload uses has its handler.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createOverlay, OVERLAY_CHANNELS, loadOverlaySettings } from "../app/overlay/overlayManager.js";
import { t } from "../src/i18n/i18n.js";
import { stripComments } from "./helpers/source.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
            this.webContents = {
                send: (channel, payload) => {
                    this.sent.push([channel, payload]);
                    this.calls.push(["send", channel]);
                },
                on: (name, fn) => { this.pageHandlers[name] = fn; },
                reload: () => this.calls.push(["reload"]),
            };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
        loadFile(file, opts) { this.file = file; this.query = opts?.query; }
        on(name, fn) { this.handlers[name] = fn; }
        setAlwaysOnTop(...a) { this.calls.push(["setAlwaysOnTop", ...a]); }
        setIgnoreMouseEvents(...a) { this.calls.push(["setIgnoreMouseEvents", ...a]); }
        setFocusable(...a) { this.calls.push(["setFocusable", ...a]); }
        setMenu() {}
        setTitle() {}
        showInactive() { this.visible = true; this.calls.push(["showInactive"]); }
        show() { this.visible = true; }
        hide() { this.visible = false; this.calls.push(["hide"]); }
        focus() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
    }
    const handled = new Map();
    const listened = new Map();
    const ipcMain = { handle: (c, fn) => handled.set(c, fn), on: (c, fn) => listened.set(c, fn) };
    const shortcuts = new Map();
    const globalShortcut = { register: (k, fn) => { shortcuts.set(k, fn); return true; }, unregister: (k) => shortcuts.delete(k) };
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const screen = { getPrimaryDisplay: () => display, getAllDisplays: () => [display] };
    return { electron: { BrowserWindow, ipcMain, globalShortcut, screen }, windows, handled, listened, shortcuts };
}

const OSU = "[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n448,192,1100,1,0,0:0:0:0:\n";

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

// a play as tosu sends it: frames with a moving clock, until cond() holds (the gate wants ~400 ms of a live play)
async function playUntil(tosu, cond, from = 300, geki = 0) {
    for (let live = from; !cond(); live += 50) {
        if (live > from + 3000) throw new Error("timed out");
        tosu.send(tosuFrame(2, live, geki));
        await sleep(50);
    }
}

const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 15));
    }
};

const tosuFrame = (stateNumber, live, geki = 0) => ({
    state: { number: stateNumber },
    beatmap: { checksum: "abc", time: { live }, mode: { number: 3 } },
    play: { mode: { number: 3 }, hits: { geki, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 }, mods: { rate: 1 } },
});

test("the widgets show while playing, are click-through, follow the edit mode and save their settings", async () => {
    const tosu = await startTosu();
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей "));
    let trayChanges = 0;
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t,
        WebSocketImpl: WebSocket, fetchImpl: async () => ({ ok: true, text: async () => OSU }),
        onChange: () => { trayChanges += 1; },
    });
    try {
        assert.equal(overlay.settings().enabled, false);
        assert.equal(fake.windows.length, 0, "nothing is made while the overlay is off");
        assert.equal(fake.shortcuts.size, 0);

        const set = fake.handled.get("overlay-set");
        await set(null, { enabled: true });
        assert.ok(fake.shortcuts.has("CommandOrControl+Shift+O"));
        assert.ok(trayChanges >= 1);
        await until(() => tosu.connected());

        tosu.send(tosuFrame(5, 0));
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(fake.windows.length, 0, "song select: no widgets");

        await playUntil(tosu, () => overlay.isShown("judgements") && overlay.isShown("kps") && overlay.isShown("nps") && overlay.isShown("keys"));
        const kps = overlay.windowFor("kps");
        assert.equal(kps.options.transparent, true);
        assert.equal(kps.options.frame, false);
        assert.equal(kps.options.focusable, false);
        assert.deepEqual(kps.calls.find((c) => c[0] === "setAlwaysOnTop"), ["setAlwaysOnTop", true, "screen-saver"]);
        assert.deepEqual(kps.calls.find((c) => c[0] === "setIgnoreMouseEvents"), ["setIgnoreMouseEvents", true, { forward: true }]);
        assert.ok(kps.calls.some((c) => c[0] === "showInactive"), "shown without taking the focus from osu!");
        assert.deepEqual(kps.query, { w: "kps" });

        // judgements come in: the snapshots the windows get carry them
        tosu.send(tosuFrame(2, 990));
        tosu.send(tosuFrame(2, 1010, 1));
        tosu.send(tosuFrame(2, 1110, 2));
        await until(() => kps.sent.some(([c, s]) => c === "overlay-state" && s.hits.max === 2 && s.lanes.counts[3] === 1));

        // the edit mode: clickable and focusable, and back
        fake.shortcuts.get("CommandOrControl+Shift+O")();
        assert.deepEqual(kps.calls.filter((c) => c[0] === "setIgnoreMouseEvents").at(-1), ["setIgnoreMouseEvents", false, { forward: true }]);
        assert.ok(kps.sent.some(([c, cfg]) => c === "overlay-config" && cfg.edit === true));
        fake.listened.get("overlay-edit")(null, false);
        assert.deepEqual(kps.calls.filter((c) => c[0] === "setIgnoreMouseEvents").at(-1), ["setIgnoreMouseEvents", true, { forward: true }]);

        // the corner: a new scale resizes the window from the same corner
        fake.listened.get("overlay-scale")(null, { widget: "kps", scale: 2 });
        assert.deepEqual(kps.bounds, { x: kps.bounds.x, y: kps.bounds.y, width: 420, height: 256 });
        kps.bounds.x = 640;
        kps.bounds.y = 360;
        kps.handlers.moved();

        // results: shown (the default), then hidden when that is turned off; song select hides
        tosu.send(tosuFrame(7, 1110, 2));
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(overlay.isShown("kps"), true);
        await set(null, { showOnResults: false });
        await until(() => !overlay.isShown("kps"));
        tosu.send(tosuFrame(5, 0));
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(kps.visible, false);

        // a widget turned off stays hidden in a play, the others show
        await set(null, { widgets: { keys: { enabled: false } } });
        await playUntil(tosu, () => overlay.isShown("kps"));
        assert.equal(overlay.isShown("keys"), false);

        // tray
        const [menu] = overlay.trayItems();
        assert.equal(menu.submenu[0].checked, true);
        assert.match(menu.submenu[1].label, /Ctrl\+Shift\+O/);
        // a checkbox per widget, the NPS one among them; it turns its widget off and on
        const npsItem = menu.submenu.find((i) => i.label === t("overlay.widget.nps"));
        assert.equal(npsItem.checked, true);
        assert.equal(menu.submenu.find((i) => i.label === t("overlay.widget.keys")).checked, false);
        npsItem.click();
        assert.equal(overlay.settings().widgets.nps.enabled, false);
        await until(() => !overlay.isShown("nps"));
        overlay.trayItems()[0].submenu.find((i) => i.label === t("overlay.widget.nps")).click();
        assert.equal(overlay.settings().widgets.nps.enabled, true);

        overlay.dispose();
        assert.equal(fake.shortcuts.size, 0);
        assert.ok(fake.windows.every((w) => w.destroyed));
        const saved = loadOverlaySettings(path.join(userData, "overlay.json"));
        assert.equal(saved.enabled, true);
        assert.equal(saved.widgets.kps.scale, 2);
        assert.equal(saved.widgets.kps.x, 640);
        assert.equal(saved.widgets.keys.enabled, false);
        assert.ok(JSON.parse(await readFile(path.join(userData, "overlay.json"), "utf8")).widgets);
    } finally {
        overlay.dispose();
        await tosu.close();
    }
});

test("every channel the overlay preload uses has its handler, and nothing clashes with main.js", () => {
    const fake = fakeElectron();
    createOverlay({ electron: fake.electron, userData: tmpdir(), port: 1, t, WebSocketImpl: WebSocket }).dispose();
    assert.deepEqual([...fake.handled.keys()].sort(), [...OVERLAY_CHANNELS.handle].sort());
    assert.deepEqual([...fake.listened.keys()].sort(), [...OVERLAY_CHANNELS.on].sort());
    const preload = stripComments(readFileSync(path.join(root, "app/overlay/preload.cjs"), "utf8"));
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("([\w-]+)"/g)].map((m) => m[1]);
    const sent = [...preload.matchAll(/ipcRenderer\.send\("([\w-]+)"/g)].map((m) => m[1]);
    const events = [...preload.matchAll(/ipcRenderer\.on\("([\w-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(invoked.filter((c) => !fake.handled.has(c)), []);
    assert.deepEqual(sent.filter((c) => !fake.listened.has(c)), []);
    // the one synchronous call is main.js's own language answer
    assert.match(preload, /sendSync\("get-lang"\)/);
    const manager = stripComments(readFileSync(path.join(root, "app/overlay/overlayManager.js"), "utf8"));
    assert.deepEqual(events.filter((c) => !manager.includes(`"${c}"`)), []);
    const mainSource = stripComments(readFileSync(path.join(root, "app/main.js"), "utf8"));
    for (const c of [...OVERLAY_CHANNELS.handle, ...OVERLAY_CHANNELS.on]) assert.ok(!mainSource.includes(`"${c}"`), c);
    assert.equal(mainSource.split("createOverlay(").length - 1, 1, "main.js makes the overlay once");
});

test("song select with stray frames of play and results never shows a window; the main window hears every change", async () => {
    const tosu = await startTosu();
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей "));
    const main = new fake.electron.BrowserWindow({ width: 400, height: 300 });
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t, mainWindow: () => main,
        WebSocketImpl: WebSocket, fetchImpl: async () => ({ ok: true, text: async () => OSU }),
    });
    try {
        await fake.handled.get("overlay-set")(null, { enabled: true });
        assert.ok(main.sent.some(([c, p]) => c === "overlay-settings" && p.settings.enabled === true));
        await until(() => tosu.connected());
        // what used to flash the windows: one play frame between song select frames (into a map and straight out),
        // a score opened from the leaderboard for a moment, a play state whose clock never moves
        const frames = [5, 5, 2, 5, 5, 7, 5, 5, 2, 2, 5, 5, 5];
        for (const [i, state] of frames.entries()) {
            tosu.send(tosuFrame(state, state === 2 ? 4000 : 0));
            await sleep(state === 2 && frames[i + 1] === 2 ? 150 : 60);
        }
        await sleep(500);
        const shows = fake.windows.flatMap((w) => w.calls.filter((c) => c[0] === "showInactive"));
        assert.deepEqual(shows, []);
        assert.ok(WIDGETS_SHOWN(overlay).every((x) => !x));
        // the edit mode shows them at once (no waiting), and the main window is told
        fake.listened.get("overlay-edit")(null, true);
        assert.ok(WIDGETS_SHOWN(overlay).every(Boolean));
        assert.ok(main.sent.some(([c, p]) => c === "overlay-settings" && p.edit === true));
    } finally {
        overlay.dispose();
        await tosu.close();
    }
});

const WIDGETS_SHOWN = (overlay) => ["judgements", "kps", "nps", "keys"].map((w) => overlay.isShown(w));

test("each widget page hears whether it is shown, headless too; snapshots go only when they are new", async () => {
    for (const headless of [false, true]) {
        const tosu = await startTosu();
        const fake = fakeElectron();
        const userData = await mkdtemp(path.join(tmpdir(), "оверлей "));
        const overlay = createOverlay({
            electron: fake.electron, userData, port: tosu.port, t, headless,
            WebSocketImpl: WebSocket, fetchImpl: async () => ({ ok: true, text: async () => OSU }),
        });
        try {
            await fake.handled.get("overlay-set")(null, { enabled: true });
            await until(() => tosu.connected());
            await playUntil(tosu, () => overlay.isShown("kps"));
            const kps = overlay.windowFor("kps");
            const visible = () => kps.sent.filter(([c]) => c === "overlay-visible").map(([, on]) => on);
            assert.deepEqual(visible(), [true], `${headless}: told it is shown`);
            if (!headless) {
                // the play of now, then shown: the page draws it before the window is on screen
                const order = kps.calls.map((c) => (c[0] === "send" ? c[1] : c[0])).filter((c) => ["overlay-state", "overlay-visible", "showInactive"].includes(c));
                assert.deepEqual(order.slice(0, 3), ["overlay-state", "overlay-visible", "showInactive"]);
            }
            // the page loaded (or reloaded for a new language): its config, the play, and that it is shown
            kps.sent.length = 0;
            kps.pageHandlers["did-finish-load"]();
            assert.deepEqual(kps.sent.map(([c]) => c), ["overlay-config", "overlay-state", "overlay-visible"]);
            assert.equal(kps.sent[2][1], true);

            // a playing clock: a snapshot about every 33 ms; the results screen (the clock stands): one, then none
            const states = () => kps.sent.filter(([c]) => c === "overlay-state").length;
            kps.sent.length = 0;
            await playUntil(tosu, () => states() >= 5, 4000);
            tosu.send(tosuFrame(7, 4500));
            await sleep(150);
            const atResults = states();
            await sleep(300);
            assert.equal(states(), atResults, `${headless}: the results screen's snapshot is not sent again and again`);
            assert.ok(overlay.isShown("kps"));

            // song select: hidden, and told so
            tosu.send(tosuFrame(5, 0));
            await until(() => !overlay.isShown("kps"));
            assert.deepEqual(visible(), [false]);
            if (!headless) assert.ok(kps.calls.some((c) => c[0] === "hide"));
            kps.sent.length = 0;
            kps.pageHandlers["did-finish-load"]();
            assert.deepEqual(kps.sent.at(-1), ["overlay-visible", false], "a hidden page that loads is told it is hidden");
        } finally {
            overlay.dispose();
            await tosu.close();
        }
    }
});

test("a running play whose frames stop for a while: its snapshots go on, the key lines run on no further than 0.10.2's; a pause sends one", async () => {
    const { clockAt } = await import("../app/overlay/render.js");
    const tosu = await startTosu();
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "оверлей "));
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t, headless: true,
        WebSocketImpl: WebSocket, fetchImpl: async () => ({ ok: true, text: async () => OSU }),
    });
    try {
        await fake.handled.get("overlay-set")(null, { enabled: true });
        await until(() => tosu.connected());
        await playUntil(tosu, () => overlay.isShown("keys"));
        const keys = overlay.windowFor("keys");
        // the snapshots as the page gets them, and when
        const states = [];
        const send = keys.webContents.send;
        keys.webContents.send = (channel, payload) => {
            if (channel === "overlay-state") states.push({ at: performance.now(), snap: payload });
            send(channel, payload);
        };
        // the map time the page draws at (widget.js: clockAt from the last snapshot), at its highest until `end`
        const furthest = (list, end) => Math.max(...list.map((s, i) => clockAt(s.snap, s.at, list[i + 1]?.at ?? end)));

        const last = 5000;
        for (let live = 4000; live <= last; live += 50) {
            tosu.send(tosuFrame(2, live));
            await sleep(50);
        }
        // then tosu's frames stop with the play still running (a hitch of the game or of tosu)
        await sleep(900);
        const ahead = furthest(states, performance.now()) - last;
        assert.ok(states.every((s) => s.snap.running));
        assert.ok(states.at(-1).snap.clock >= last + 299, "the session's clock ran on its 300 ms");
        assert.ok(ahead <= 300 + 150, `the key lines ran on ${Math.round(ahead)} ms past the last frame (0.10.2: ~333)`);

        // a pause: the frames come with the clock standing; one snapshot, then nothing
        states.length = 0;
        for (let i = 0; i < 8; i += 1) {
            tosu.send(tosuFrame(2, last));
            await sleep(50);
        }
        assert.ok(overlay.isShown("keys"));
        const paused = states.findIndex((s) => !s.snap.running);
        assert.ok(paused >= 0, "the pause is sent");
        assert.equal(states.length - paused, 1, "paused: one snapshot, then nothing");
        assert.equal(states[paused].snap.clock, last, "standing at the last frame's time");
    } finally {
        overlay.dispose();
        await tosu.close();
    }
});
