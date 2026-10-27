// Run with: npx electron tests/smoke/electron-overlay-cpu.mjs <out dir> [--seconds 10] — how much CPU the in-game
// overlay costs, per process, in the states it lives in. The widgets are real windows on the screen (not headless),
// put in the bottom-right corner of the primary screen, fed by a fake tosu (HTTP + WebSocket on a free port, never
// 24077): a made-up 4K map, song select, a play, its results. User data goes into <out dir>/cpu-user-data.
// The states, in order: the edit mode (made-up numbers), song select with the widgets hidden again, a play, its
// results screen (shown), song select after the play (hidden), osu! closed (the fake tosu gone, the windows kept).
// Each is left to settle, then measured for --seconds: the cores used by the main process, the GPU process and each
// widget's renderer (app.getAppMetrics()). Writes <out dir>/overlay-cpu.json and prints a table.
import { app, ipcMain, BrowserWindow, screen } from "electron";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { t } from "../../src/i18n/i18n.js";
import { createOverlay } from "../../app/overlay/overlayManager.js";
import { WIDGETS, widgetSize } from "../../src/overlay/settings.js";

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith("-") && !a.endsWith(".mjs") && !/^\d+$/.test(a)) ?? "overlay-cpu");
const SECONDS = Number(args[args.indexOf("--seconds") + 1]) || 10;
const SETTLE_MS = 2500;
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, "cpu-user-data"), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "cpu-user-data"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the made-up map: 4K, a note every 90 ms ----
const notes = Array.from({ length: 2000 }, (_, i) => ({ t: 1000 + i * 90, col: [0, 2, 1, 3, 0, 3, 2, 1][i % 8] }));
const osu = [
    "osu file format v14", "", "[General]", "Mode: 3", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "", "[HitObjects]",
    ...notes.map((n) => `${Math.floor(((n.col + 0.5) * 512) / 4)},192,${n.t},1,0,0:0:0:0:`),
].join("\r\n");

// ---- the fake tosu: song select, a play (from startPlay()), its results (results()), gone (close()) ----
async function startFakeTosu() {
    const http = createServer((req, res) => {
        if (req.url === "/files/beatmap/file") {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(osu);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    const main = new WebSocketServer({ noServer: true });
    const precise = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
        const target = req.url === "/websocket/v2" ? main : req.url === "/websocket/v2/precise" ? precise : null;
        if (!target) return socket.destroy();
        target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws));
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    let playStart = null;
    let state = "select";
    const live = () => (playStart === null ? 0 : Date.now() - playStart);
    const frame = () => {
        const now = live();
        const hit = notes.filter((n) => n.t <= now - 20).length;
        const number = state === "results" ? 7 : state === "play" ? 2 : 5;
        return {
            state: { number, name: state },
            beatmap: { checksum: "cpu-map", time: { live: now }, mode: { number: 3, name: "mania" } },
            play: {
                mode: { number: 3 }, hits: { geki: hit, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 },
                hitErrorArray: [], unstableRate: 0, accuracy: null, mods: { name: "", array: [], rate: 1 },
            },
        };
    };
    const key = { isPressed: false, count: 0 };
    const timers = [
        setInterval(() => { const j = JSON.stringify(frame()); for (const ws of main.clients) ws.send(j); }, 100),
        setInterval(() => {
            const j = JSON.stringify({ currentTime: live(), keys: { k1: key, k2: key, m1: key, m2: key } });
            for (const ws of precise.clients) ws.send(j);
        }, 20),
    ];
    return {
        port: http.address().port,
        startPlay: () => { playStart = Date.now() - 500; state = "play"; },
        results: () => { state = "results"; },
        select: () => { state = "select"; playStart = null; },
        close: () => {
            timers.forEach(clearInterval);
            for (const ws of [...main.clients, ...precise.clients]) ws.terminate();
            main.close();
            precise.close();
            http.close();
        },
    };
}

// cores used per process over SECONDS: the main process, the GPU process, each widget's renderer, the rest
async function measure(overlay, label) {
    await sleep(SETTLE_MS);
    const cumulative = () => new Map(app.getAppMetrics().map((m) => [m.pid, { type: m.type, cpu: m.cpu.cumulativeCPUUsage }]));
    const a = cumulative();
    const started = performance.now();
    await sleep(SECONDS * 1000);
    const b = cumulative();
    const wall = (performance.now() - started) / 1000;
    const owner = new Map();
    for (const w of WIDGETS) {
        const win = overlay.windowFor(w);
        if (win && !win.isDestroyed()) owner.set(win.webContents.getOSProcessId(), w);
    }
    const row = { state: label, main: 0, gpu: 0, other: 0 };
    for (const w of WIDGETS) row[w] = 0;
    for (const [pid, { type, cpu }] of b) {
        const before = a.get(pid)?.cpu ?? 0;
        const cores = Math.max(0, cpu - before) / wall;
        const key = owner.get(pid) ?? (type === "Browser" ? "main" : type === "GPU" ? "gpu" : "other");
        row[key] += cores;
    }
    row.widgets = WIDGETS.reduce((s, w) => s + row[w], 0);
    row.total = row.main + row.gpu + row.other + row.widgets;
    for (const k of Object.keys(row)) if (typeof row[k] === "number") row[k] = Math.round(row[k] * 1000) / 1000;
    row.shown = WIDGETS.filter((w) => overlay.isShown(w)).length;
    console.log(JSON.stringify(row));
    return row;
}

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = "en"; });
    const tosu = await startFakeTosu();
    const display = screen.getPrimaryDisplay();
    console.log(`display ${display.size.width}×${display.size.height} at ${display.displayFrequency} Hz, ${navigator.hardwareConcurrency} threads`);
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain, globalShortcut: { register: () => true, unregister: () => {} }, screen },
        userData: app.getPath("userData"), port: tosu.port, t, log: (l) => console.log("log", l),
    });
    const rows = [];
    let failed = false;
    try {
        // the widgets in a column at the bottom-right corner of the primary screen, out of the way
        const area = display.workArea;
        let y = area.y + area.height;
        const place = {};
        for (const w of [...WIDGETS].reverse()) {
            const size = widgetSize(w, "card", 1, null);
            y -= size.height + 4;
            place[w] = { x: area.x + area.width - 340, y };
        }
        overlay.apply({ enabled: true, showOnResults: true, widgets: place });
        await sleep(1000);
        overlay.setEdit(true);
        rows.push(await measure(overlay, "edit mode (shown, made-up numbers)"));
        overlay.setEdit(false);
        rows.push(await measure(overlay, "song select (hidden)"));
        tosu.startPlay();
        for (let i = 0; i < 50 && !WIDGETS.every((w) => overlay.isShown(w)); i += 1) await sleep(100);
        rows.push(await measure(overlay, "playing (shown)"));
        tosu.results();
        rows.push(await measure(overlay, "results screen (shown)"));
        tosu.select();
        for (let i = 0; i < 50 && WIDGETS.some((w) => overlay.isShown(w)); i += 1) await sleep(100);
        rows.push(await measure(overlay, "song select after a play (hidden)"));
        tosu.close();
        rows.push(await measure(overlay, "osu! closed (hidden)"));
    } catch (error) {
        console.error(error);
        failed = true;
    } finally {
        overlay.dispose();
        tosu.close();
    }
    writeFileSync(path.join(outDir, "overlay-cpu.json"), JSON.stringify(rows, null, 1));
    console.table(rows.map((r) => ({ state: r.state, shown: r.shown, total: r.total, gpu: r.gpu, widgets: r.widgets, main: r.main, ...Object.fromEntries(WIDGETS.map((w) => [w, r[w]])) })));
    app.exit(failed ? 1 : 0);
});
