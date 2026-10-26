// Run with: npx electron tests/smoke/electron-overlay.mjs <out dir> — the in-game overlay against a fake tosu.
// The fake tosu (HTTP + WebSocket on a free port, never 24077) serves a made-up 4K map and plays it: song select,
// then a play with judgements every 100 ms and a precise feed whose key counters never move (as in mania).
// The widget windows are made headless (never put on the screen) and captured: every widget in every style, in
// Russian and in English, plus the edit mode and the settings window. User data goes into <out dir>/user-data.
// Exits 1 when a check fails.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { setLang, t } from "../../src/i18n/i18n.js";
import { createOverlay } from "../../app/overlay/overlayManager.js";
import { STYLES, WIDGETS } from "../../src/overlay/settings.js";

const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("-") && !a.endsWith(".mjs")) ?? "overlay-smoke");
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
let lang = "ru";
let failed = false;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the made-up map: 4K, about 11 notes a second, a hold now and then ----
const NOTE_MS = 90;
const notes = [];
for (let i = 0; i < 700; i += 1) {
    const t0 = 1000 + i * NOTE_MS;
    const col = [0, 2, 1, 3, 0, 3, 2, 1][i % 8];
    const hold = i % 13 === 6 ? 360 : 0;
    notes.push({ t: t0, col, end: hold ? t0 + hold : null });
}
const osu = [
    "osu file format v14", "", "[General]", "Mode: 3", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "",
    "[HitObjects]",
    ...notes.map((n) => {
        const x = Math.floor(((n.col + 0.5) * 512) / 4);
        return n.end ? `${x},192,${n.t},128,0,${n.end}:0:0:0:0:` : `${x},192,${n.t},1,0,0:0:0:0:`;
    }),
].join("\r\n");
// every judgement in time order: heads and hold releases (osu!stable judges both)
const judgements = notes.flatMap((n) => (n.end ? [n.t, n.end] : [n.t])).sort((a, b) => a - b);
const kindOf = (i) => {
    const r = (i * 7919) % 1000;
    return r < 790 ? "geki" : r < 960 ? "300" : r < 985 ? "katu" : r < 993 ? "100" : r < 997 ? "50" : "0";
};

// ---- the fake tosu ----
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
    let playStart = null; // real ms when the play's clock was 0
    const live = () => (playStart === null ? 0 : Date.now() - playStart);
    const frame = () => {
        const now = live();
        const hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
        const errors = [];
        for (let i = 0; i < judgements.length && judgements[i] <= now - 20; i += 1) {
            hits[kindOf(i)] += 1;
            errors.push(((i * 37) % 31) - 15);
        }
        return {
            state: { number: playStart === null ? 5 : 2, name: playStart === null ? "selectPlay" : "play" },
            beatmap: { checksum: "smoke-map", time: { live: now }, mode: { number: 3, name: "mania" } },
            play: { mode: { number: 3 }, hits, hitErrorArray: errors.slice(-200), unstableRate: 0, accuracy: null, mods: { name: "", array: [], rate: 1 } },
        };
    };
    const timers = [
        setInterval(() => { const j = JSON.stringify(frame()); for (const ws of main.clients) ws.send(j); }, 100),
        setInterval(() => {
            const j = JSON.stringify({ currentTime: live(), keys: { k1: { isPressed: false, count: 0 }, k2: { isPressed: false, count: 0 }, m1: { isPressed: false, count: 0 }, m2: { isPressed: false, count: 0 } } });
            for (const ws of precise.clients) ws.send(j);
        }, 20),
    ];
    return {
        port: http.address().port,
        startPlay: () => { playStart = Date.now() - 500; },
        close: () => { timers.forEach(clearInterval); main.close(); precise.close(); http.close(); },
    };
}

async function capture(win, file, { background = true } = {}) {
    // a game-like backdrop behind the transparent widget, so the capture shows what it would over osu!
    if (background) {
        await win.webContents.executeJavaScript(`document.body.style.background =
            "radial-gradient(circle at 30% 20%, #3a3157 0%, #1d1830 55%, #0d0b15 100%)"; true`);
    }
    // a hidden window does not paint by itself: a 1 px resize makes it draw a fresh frame
    const bounds = win.getBounds();
    win.setBounds({ ...bounds, width: bounds.width + 1 });
    await sleep(150);
    win.setBounds(bounds);
    await sleep(150);
    writeFileSync(path.join(outDir, file), (await win.webContents.capturePage()).toPNG());
    console.log("shot", file);
}

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    const tosu = await startFakeTosu();
    // a stand-in for the global hotkey, so the smoke never takes a key from the desktop
    const globalShortcut = { register: () => true, unregister: () => {} };
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain, globalShortcut, screen },
        userData: app.getPath("userData"), port: tosu.port, t, log: (l) => console.log("log", l), headless: true,
    });
    try {
        overlay.apply({ enabled: true });
        await sleep(600);
        check(WIDGETS.every((w) => !overlay.isShown(w)), "song select: no widget shown");
        tosu.startPlay();
        for (let i = 0; i < 50 && !WIDGETS.every((w) => overlay.isShown(w)); i += 1) await sleep(100);
        check(WIDGETS.every((w) => overlay.isShown(w)), "playing: every widget shown");
        const win = (w) => overlay.windowFor(w);
        check(win("kps").isAlwaysOnTop(), "always on top");
        await sleep(2500); // let the play run

        const state = await win("judgements").webContents.executeJavaScript(`({
            text: document.getElementById("widget").innerText,
            cls: document.getElementById("widget").className })`);
        console.log("judgements", JSON.stringify(state));
        check(/\d+\.\d\d:1/.test(state.text), "judgements show the MAX:300 ratio");
        check(/\d+\.\d\d%/.test(state.text), "judgements show the accuracy");
        const keys = await win("keys").webContents.executeJavaScript(
            `[...document.querySelectorAll(".l-count")].map((n) => Number(n.textContent))`);
        console.log("key counts", JSON.stringify(keys));
        check(keys.length === 4 && keys.every((n) => n > 0), "the key lines count presses in all four lanes (from the map)");
        const kpsNow = await win("kps").webContents.executeJavaScript(`Number(document.querySelector(".k-now-value").textContent)`);
        check(kpsNow >= 8 && kpsNow <= 14, `KPS now is about 11 (${kpsNow})`);

        for (const l of ["ru", "en"]) {
            if (l !== lang) {
                lang = l;
                setLang(l);
                overlay.reload();
                await sleep(800);
            }
            for (const style of STYLES) {
                overlay.apply({ widgets: Object.fromEntries(WIDGETS.map((w) => [w, { style }])) });
                await sleep(500);
                for (const w of WIDGETS) await capture(win(w), `${l}-${style}-${w}.png`);
            }
            const cls = await win("kps").webContents.executeJavaScript(`document.getElementById("widget").className`);
            check(cls.includes(`style-${STYLES.at(-1)}`), `${l}: the style class follows the setting (${cls})`);
            // the edit mode: dashed frame, badge, corner grip
            overlay.apply({ widgets: Object.fromEntries(WIDGETS.map((w) => [w, { style: "card" }])) });
            overlay.setEdit(true);
            await sleep(400);
            for (const w of WIDGETS) await capture(win(w), `${l}-edit-${w}.png`);
            const editing = await win("kps").webContents.executeJavaScript(`document.body.classList.contains("editing")`);
            check(editing, `${l}: the edit mode reaches the widget`);
            overlay.setEdit(false);
            // the settings window, long enough to show the whole page
            const sw = overlay.openSettings();
            await new Promise((r) => (sw.webContents.isLoading() ? sw.webContents.once("did-finish-load", r) : r()));
            await sleep(700);
            const height = await sw.webContents.executeJavaScript("document.documentElement.scrollHeight");
            sw.setContentSize(600, Math.min(height, 4000));
            await sleep(500);
            await capture(sw, `${l}-settings.png`, { background: false });
            const title = await sw.webContents.executeJavaScript("document.querySelector('h1').textContent");
            check(title === (l === "ru" ? "Оверлей в игре" : "In-game overlay"), `${l}: settings heading "${title}"`);
            sw.destroy();
        }
        // the corner resize path: a bigger scale gives a bigger window
        const before = win("kps").getBounds();
        overlay.apply({ widgets: { kps: { scale: 1.5 } } });
        await sleep(200);
        const after = win("kps").getBounds();
        check(after.width > before.width && after.height > before.height, `scale 1.5 resizes the window (${before.width}×${before.height} → ${after.width}×${after.height})`);
    } catch (error) {
        console.error(error);
        failed = true;
    } finally {
        overlay.dispose();
        tosu.close();
        app.exit(failed ? 1 : 0);
    }
});
