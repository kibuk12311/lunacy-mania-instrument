// The overlay manager and the keyboard reader (app/overlay/overlayManager.js, a stand-in reader, a fake tosu on a real
// WebSocket, made-up osu! cfgs): an osu! stable mania play listens to its lanes' keys and only those — the keys set
// by hand, else osu!'s cfg's, else osu!'s defaults — and nothing between plays; lazer never; the setting or the
// overlay off stops the reader, so does the app. Its keys become the play's presses. The log never names a key.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createOverlay } from "../app/overlay/overlayManager.js";
import { t } from "../src/i18n/i18n.js";
import { parseManiaLayouts } from "../src/overlay/osuKeys.js";

function fakeElectron() {
    const windows = [];
    class BrowserWindow {
        constructor(options) {
            this.options = options;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
            this.sent = [];
            this.handlers = {};
            this.destroyed = false;
            this.webContents = { send: (channel, payload) => this.sent.push([channel, payload]), on: () => {}, reload: () => {} };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
        loadFile() {}
        on(name, fn) { this.handlers[name] = fn; }
        setAlwaysOnTop() {}
        setIgnoreMouseEvents() {}
        setFocusable() {}
        setMenu() {}
        setTitle() {}
        showInactive() {}
        show() {}
        hide() {}
        focus() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
    }
    const handled = new Map();
    const ipcMain = { handle: (c, fn) => handled.set(c, fn), on: () => {} };
    const globalShortcut = { register: () => true, unregister: () => {} };
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const screen = { getPrimaryDisplay: () => display, getAllDisplays: () => [display] };
    return { electron: { BrowserWindow, ipcMain, globalShortcut, screen }, windows, handled };
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
const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timed out");
        await sleep(10);
    }
};

const OSU4 = "[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n448,192,1100,1,0,0:0:0:0:\n";
const GAME = "Q:\\Games\\osu!";
const frameOf = (state, live, { client = "stable", folders = true, geki = 0, mods = { rate: 1 }, player = "PlayerOne" } = {}) => ({
    client,
    state: { number: state },
    beatmap: { checksum: "abc", time: { live }, mode: { number: 3 } },
    play: { mode: { number: 3 }, hits: { geki, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 }, mods, playerName: player },
    ...(folders ? { folders: { game: GAME }, profile: { name: "PlayerOne" } } : {}),
});

// a stand-in for app/keyReader.js: what the overlay asks of it, and its handlers to send keys with
function fakeReaders() {
    const made = [];
    const factory = (handlers) => {
        const r = { handlers, calls: [], listen: (vks) => r.calls.push(["listen", vks]), idle: () => r.calls.push(["idle"]), stop: async () => { r.calls.push(["stop"]); } };
        made.push(r);
        return r;
    };
    return { factory, made };
}

async function setup({ cfg = "ManiaLayouts4K = A S OemSemicolon OemQuotes\nManiaLayoutSelected4K = 0", json = null } = {}) {
    const tosu = await startTosu();
    const fake = fakeElectron();
    const userData = await mkdtemp(path.join(tmpdir(), "overlay keys "));
    const readers = fakeReaders();
    const asked = [];
    const logs = [];
    const overlay = createOverlay({
        electron: fake.electron, userData, port: tosu.port, t, WebSocketImpl: WebSocket, log: (l) => logs.push(l),
        fetchImpl: async (url) => {
            if (String(url).endsWith("/json/v2")) {
                if (!json) throw new Error("no /json/v2");
                return { ok: true, text: async () => JSON.stringify(json) };
            }
            return { ok: true, text: async () => OSU4 };
        },
        keyReader: readers.factory,
        osuConfig: async ({ gameDir, profile }) => {
            asked.push({ gameDir, profile });
            return cfg === null || gameDir !== GAME ? null : { file: path.join(gameDir, "osu!.Tester.cfg"), layouts: parseManiaLayouts(cfg) };
        },
    });
    // a play's frames, its clock going on from where the last ones left it, until cond() holds
    let clock = 300;
    const play = async (cond, opts = {}) => {
        for (const from = clock; !cond(); clock += 50) {
            if (clock > from + 3000) throw new Error("timed out");
            tosu.send(frameOf(2, clock, opts));
            await sleep(40);
        }
    };
    const lastState = () => {
        const win = overlay.windowFor("keys");
        return win?.sent.filter(([c]) => c === "overlay-state").at(-1)?.[1] ?? null;
    };
    return { tosu, fake, overlay, readers, asked, logs, play, lastState, close: async () => { overlay.dispose(); await tosu.close(); } };
}

const listens = (r) => r.calls.filter((c) => c[0] === "listen").map((c) => c[1]);

test("overlay off: no reader is ever made; on: a stable play listens to the cfg's keys, its keys are the presses, and none after", async () => {
    const s = await setup();
    try {
        s.tosu.send(frameOf(2, 100));
        await sleep(100);
        assert.equal(s.readers.made.length, 0, "the overlay is off");
        s.overlay.apply({ enabled: true });
        await until(() => s.tosu.connected());
        s.tosu.send(frameOf(5, 0));
        await sleep(100);
        assert.equal(s.readers.made.length, 0, "song select: nothing to listen to");
        await s.play(() => s.readers.made[0] && listens(s.readers.made[0]).length > 0);
        const r = s.readers.made[0];
        assert.deepEqual(listens(r), [[65, 83, 186, 222]], "A S ; ' from osu!'s cfg");
        assert.deepEqual(s.asked.at(-1), { gameDir: GAME, profile: "PlayerOne" }, "the game folder and profile from tosu's frames");
        assert.deepEqual(s.overlay.listeningKeys(), { keys: 4, names: ["A", "S", "OemSemicolon", "OemQuotes"], source: "osu", file: "osu!.Tester.cfg" });

        // its keys: the play's presses (a key no lane has is nothing)
        await s.play(() => s.overlay.isShown("keys"));
        const now = performance.now();
        r.handlers.onKey({ vk: 83, down: true, at: now });
        r.handlers.onKey({ vk: 83, down: false, at: now + 20 });
        r.handlers.onKey({ vk: 222, down: true, at: now + 5 });
        r.handlers.onKey({ vk: 70, down: true, at: now + 6 });
        await until(() => s.lastState()?.lanes.source === "kbd");
        await s.play(() => s.lastState()?.lanes.counts.join() === "0,1,0,1");
        assert.ok(s.lastState().kps.max > 0, "the KPS counts them");

        // results: nothing listened to; song select: still nothing; the reader stays, idle
        s.tosu.send(frameOf(7, 4000));
        await until(() => r.calls.at(-1)?.[0] === "idle");
        s.tosu.send(frameOf(5, 0));
        await sleep(700);
        assert.equal(listens(r).length, 1);
        assert.ok(!r.calls.some((c) => c[0] === "stop"));
        // the next play listens again
        await s.play(() => listens(r).length === 2);
        assert.equal(s.readers.made.length, 1, "one reader for every play");
        for (const l of s.logs) assert.doesNotMatch(l, /OemSemicolon|OemQuotes|\b(65|83|186|222)\b/, l);
    } finally {
        await s.close();
    }
    assert.ok(s.readers.made[0].calls.some((c) => c[0] === "stop"), "the app's end stops it");
});

test("keys set by hand win over osu!'s; clearing them gives osu!'s back; the setting off stops the reader", async () => {
    const s = await setup();
    try {
        s.overlay.apply({ enabled: true });
        await until(() => s.tosu.connected());
        await s.play(() => listens(s.readers.made[0] ?? { calls: [] }).length > 0);
        const r = s.readers.made[0];
        const set = s.fake.handled.get("overlay-set");
        await set(null, { keyboard: { keys: { 4: ["Z", "X", "OemPeriod", "OemQuestion"] } } });
        await until(() => listens(r).length === 2);
        assert.deepEqual(listens(r)[1], [90, 88, 190, 191]);
        assert.equal(s.overlay.listeningKeys().source, "manual");
        const info = await s.fake.handled.get("overlay-keys")(null, 4);
        assert.deepEqual(info.osu, ["A", "S", "OemSemicolon", "OemQuotes"]);
        assert.deepEqual(info.manual, ["Z", "X", "OemPeriod", "OemQuestion"]);
        assert.deepEqual(info.effective, { names: ["Z", "X", "OemPeriod", "OemQuestion"], source: "manual", file: null });
        assert.equal(info.found, true);
        assert.equal(info.file, "osu!.Tester.cfg");
        await set(null, { keyboard: { keys: { 4: null } } });
        await until(() => listens(r).length === 3);
        assert.deepEqual(listens(r)[2], [65, 83, 186, 222]);
        await set(null, { keyboard: { enabled: false } });
        assert.ok(r.calls.some((c) => c[0] === "stop"), "turned off: the reader goes");
        await s.play(() => s.overlay.isShown("keys"));
        await sleep(200);
        assert.equal(s.readers.made.length, 1, "and no new one while it is off");
        // back on in the middle of the play: listened to again
        await set(null, { keyboard: { enabled: true } });
        await until(() => s.readers.made.length === 2 && listens(s.readers.made[1]).length === 1);
        // the overlay off: stopped
        await set(null, { enabled: false });
        assert.ok(s.readers.made[1].calls.some((c) => c[0] === "stop"));
    } finally {
        await s.close();
    }
});

test("no cfg: osu!'s defaults (D F J K); a cfg without the key count: osu!'s default for it; lazer: never", async () => {
    const s = await setup({ cfg: null });
    try {
        s.overlay.apply({ enabled: true });
        await until(() => s.tosu.connected());
        // frames without the folder (an older tosu) and no /json/v2: the cfg can't be found
        await s.play(() => listens(s.readers.made[0] ?? { calls: [] }).length > 0, { folders: false });
        assert.deepEqual(listens(s.readers.made[0])[0], [68, 70, 74, 75]);
        assert.equal(s.overlay.listeningKeys().source, "default");
        const info = await s.fake.handled.get("overlay-keys")(null, 4);
        assert.equal(info.found, false);
        assert.equal(info.osu, null);
    } finally {
        await s.close();
    }

    const only7 = await setup({ cfg: "ManiaLayouts7K = S D F Space J K L", json: { folders: { game: GAME } } });
    try {
        only7.overlay.apply({ enabled: true });
        await until(() => only7.tosu.connected());
        await only7.play(() => listens(only7.readers.made[0] ?? { calls: [] }).length > 0, { folders: false });
        assert.deepEqual(only7.asked.at(-1).gameDir, GAME, "the folder from /json/v2");
        assert.equal(only7.overlay.listeningKeys().source, "osuDefault");
        assert.deepEqual(only7.overlay.listeningKeys().names, ["D", "F", "J", "K"]);
    } finally {
        await only7.close();
    }

    const lazer = await setup();
    try {
        lazer.overlay.apply({ enabled: true });
        await until(() => lazer.tosu.connected());
        await lazer.play(() => lazer.overlay.isShown("keys"), { client: "lazer" });
        await sleep(300);
        assert.equal(lazer.readers.made.length, 0, "lazer has its own key counters");
    } finally {
        await lazer.close();
    }
});

test("an unbound lane in osu!'s layout (None): the other lanes are listened to, that one shows no key", async () => {
    const s = await setup({ cfg: ["ManiaLayouts4K = A S None OemQuotes", "ManiaLayoutSelected4K = 0"].join("\n") });
    try {
        s.overlay.apply({ enabled: true });
        await until(() => s.tosu.connected());
        await s.play(() => s.readers.made[0] && listens(s.readers.made[0]).length > 0);
        const r = s.readers.made[0];
        assert.deepEqual(listens(r), [[65, 83, 222]], "not osu!'s defaults: the player's own keys");
        assert.deepEqual(s.overlay.listeningKeys(), { keys: 4, names: ["A", "S", null, "OemQuotes"], source: "osu", file: "osu!.Tester.cfg" });
        const info = await s.fake.handled.get("overlay-keys")(null, 4);
        assert.deepEqual(info.osu, ["A", "S", null, "OemQuotes"]);
        await s.play(() => s.overlay.isShown("keys"));
        const now = performance.now();
        r.handlers.onKey({ vk: 222, down: true, at: now });
        r.handlers.onKey({ vk: 222, down: false, at: now + 20 });
        await s.play(() => s.lastState()?.lanes.counts.join() === "0,0,0,1");
    } finally {
        await s.close();
    }
});

test("autoplay, spectating, someone's replay: no key is listened to, the map's judgements stay the lanes", async () => {
    for (const opts of [{ player: "SomeoneElse" }, { mods: { name: "AT", rate: 1 } }]) {
        const s = await setup();
        try {
            s.overlay.apply({ enabled: true });
            await until(() => s.tosu.connected());
            await s.play(() => s.overlay.isShown("keys"), opts);
            await s.play(() => s.lastState()?.lanes, opts);
            await sleep(200);
            assert.equal(s.readers.made.reduce((n, r) => n + listens(r).length, 0), 0, JSON.stringify(opts));
            assert.equal(s.lastState().lanes.source, "map");
            // the player's own play right after: listened to
            await s.play(() => s.readers.made[0] && listens(s.readers.made[0]).length > 0);
        } finally {
            await s.close();
        }
    }
});

test("neither the KPS nor the key lines shown: no key is read", async () => {
    const s = await setup();
    try {
        s.overlay.apply({ enabled: true, widgets: { kps: { enabled: false }, keys: { enabled: false } } });
        await until(() => s.tosu.connected());
        await s.play(() => s.overlay.isShown("judgements"));
        await sleep(300);
        assert.equal(s.readers.made.length, 0);
        // the key lines back on mid-play: listened to
        s.overlay.apply({ widgets: { keys: { enabled: true } } });
        await s.play(() => listens(s.readers.made[0] ?? { calls: [] }).length === 1);
        s.overlay.apply({ widgets: { keys: { enabled: false } } });
        assert.ok(s.readers.made[0].calls.some((c) => c[0] === "stop"), "and off again: the reader goes");
    } finally {
        await s.close();
    }
});
