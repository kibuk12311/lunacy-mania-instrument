// Run with: npx electron tests/smoke/electron-overlay.mjs <out dir> [--lazer | --interlude] — the in-game overlay against a fake tosu.
// --interlude: the play comes from Interlude instead, as the app gets it: the fake Interlude (native/interlude-reader/
// out/fake, an F# program with Interlude's shapes, never the real game; it hits a note every 50 ms of song time) is
// read by the real interlude-reader.exe through the app's reader manager, and its state lines go to the overlay
// (overlay.onInterlude) at 1.25×, with the chart's notes from a stand-in library. The tosu stays in song select.
// Every mode ends with a keep-up step in each language: widgets in the edit mode really put on the screen for a
// moment, one minimized and one hidden behind the app's back, the app's own window minimized and restored — they
// must all be back up, top-most.
// The fake tosu (HTTP + WebSocket on a free port, never 24077) serves a made-up 4K map and plays it: song select
// (with a stray play and results frame in it), then a play with judgements every 100 ms and a precise feed whose
// key counters never move (as in mania). --lazer: the fake tosu reads osu! lazer instead, as tosu v4.26.3 sends it:
// client "lazer", DT at lazer's own 1.2 speed, and a precise feed without a clock whose key counters are the play's
// four lanes, so the key lines must come from the keys. Either way one stray song-select frame in the middle of the
// play must not start it over.
// The widget windows are made headless (never put on the screen) and captured: every widget in every style, in
// Russian and in English, plus the edit mode and the settings window. User data goes into <out dir>/user-data (lazer-user-data with --lazer).
// The Dan widget: the map played is analysed for real in this process (src/core/analyze.js, as the worker would), a
// hand-set profile stands in for the main window's, recording is on. Out of the box it must show only the map's
// overall dan (label and number, a small window, no line, no canvas, no "now", no extras) in each language; with its
// extras turned on, the pattern, the confidence and "for you" too (never "now"), and on the results screen at the end
// (the fake tosu's results state, Interlude's score screen) "this play".
// The map panel: off out of the box; turned on it shows the map selected in song select (only it) with its picture
// (a little PNG from the fake tosu's /files/beatmap/background, shrunk by the real nativeImage), stays through the play
// with its progress moving at a low rate, in every style and language.
// The settings window (a step of its own in each language, on the real screen, Z order asked of Windows through
// tests/smoke/window-order.ps1): a size set there leaves the widgets as they are, none covers the window, even one
// sitting under it; one moved clear takes its size, the others take theirs when it closes.
// --kbd: osu! stable's keys from the keyboard reader. The real reader manager (app/keyReader.js) runs a stand-in helper
// (tests/smoke/fake-key-helper.mjs: key-reader.exe's protocol and clock, presses from a schedule, written out in
// 25 ms batches) and the real cfg reader reads a made-up osu!.Smoke.cfg (4K: Z X . /) in a made-up game folder that the
// fake tosu names. The fake tosu is a bad one on purpose: its frames come 0-70 ms late and it stops reading for 1.2 s
// every 4 s, then goes on; the player presses every note a little off its time, holds the holds, and mashes a ghost
// press now and then. The same play runs twice at DT (1.5x): with the keyboard setting off (0.10.5's map rebuild:
// "before") and on ("after"). After: every press is a bar starting at its own time (within 2 ms), the lane counts are
// the presses, the KPS graph's finished samples and its max are the presses' own; the numbers of both runs go to
// <out dir>/kbd-measure.json. The helper hears only the cfg's four keys, nothing between plays, and is gone with the app.
// Exits 1 when a check fails.
import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { setLang, t } from "../../src/i18n/i18n.js";
import { createOverlay } from "../../app/overlay/overlayManager.js";
import { STYLES, WIDGETS } from "../../src/overlay/settings.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { createKeyReader } from "../../app/keyReader.js";
import { smoothRate } from "../../src/overlay/kps.js";

const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("-") && !a.endsWith(".mjs")) ?? "overlay-smoke");
const lazer = process.argv.includes("--lazer");
const interludeMode = process.argv.includes("--interlude");
const kbdMode = process.argv.includes("--kbd");
const RATE = lazer ? 1.2 : interludeMode ? 1.25 : kbdMode ? 1.5 : 1; // map ms per real ms
const prefix = lazer ? "lazer-" : interludeMode ? "interlude-" : kbdMode ? "kbd-" : ""; // names this run's screenshots
// notes a second of the map at 1×: the made-up osu! map below, or the fake Interlude's chart
const NPS_BASE = interludeMode ? 20 : 11.1;
// the widgets of a play; the map panel is off out of the box and shows in song select as well
const PLAY_WIDGETS = WIDGETS.filter((w) => w !== "map");
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, `${prefix}user-data`), { recursive: true, force: true }); // a rerun starts from the default settings
app.setPath("userData", path.join(outDir, `${prefix}user-data`));
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
    const hold = i % 13 === 6 ? 150 : 0; // shorter than the gap to its column's next note (the analysis refuses stacked notes)
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

// lazer's precise feed (tosu v4.26.3: keys, hitErrors, tourney, no clock): each lane's presses so far, lit while held
function lazerKeys(now) {
    const counts = [0, 0, 0, 0];
    const held = [false, false, false, false];
    if (now !== null) {
        for (const n of notes) {
            if (n.t > now) break;
            counts[n.col] += 1;
            if (now <= (n.end ?? n.t + 40)) held[n.col] = true;
        }
    }
    const key = (i) => ({ isPressed: held[i], count: counts[i] });
    return { keys: { k1: key(0), k2: key(1), m1: key(2), m2: key(3) }, hitErrors: [], tourney: [] };
}

// ---- the fake tosu ----
async function startFakeTosu() {
    const http = createServer((req, res) => {
        if (req.url === "/files/beatmap/file") {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(osu);
        } else if (req.url === "/files/beatmap/background") {
            backgroundAsked += 1;
            res.writeHead(200, { "content-type": "image/png" });
            res.end(background);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    // the map's picture: a little gradient, a real PNG
    const background = nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 96 * 54 }, (_, i) => [40 + (i % 96) * 2, 60, 200 - (i % 96), 255]).flat()), { width: 96, height: 54 }).toPNG();
    let backgroundAsked = 0;
    const main = new WebSocketServer({ noServer: true });
    const precise = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
        const target = req.url === "/websocket/v2" ? main : req.url === "/websocket/v2/precise" ? precise : null;
        if (!target) return socket.destroy();
        target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws));
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    let playStart = null; // real ms when the play's clock was 0
    let results = false; // the results screen after the play
    const live = () => (playStart === null ? 0 : (Date.now() - playStart) * RATE);
    const frame = () => {
        const now = live();
        const hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
        const errors = [];
        for (let i = 0; i < judgements.length && judgements[i] <= now - 20; i += 1) {
            hits[kindOf(i)] += 1;
            errors.push(((i * 37) % 31) - 15);
        }
        const mods = lazer ? { name: "DT", array: [{ acronym: "DT", settings: { speed_change: RATE } }], rate: RATE } : { name: "", array: [], rate: 1 };
        return {
            ...(lazer ? { client: "lazer", server: "ppy.sh" } : {}),
            state: { number: results ? 7 : playStart === null ? 5 : 2, name: results ? "resultScreen" : playStart === null ? "selectPlay" : "play" },
            beatmap: {
                checksum: "smoke-map", title: "Smoke Map", artist: "Smoke Artist", version: "4K Test", mapper: "Smoke Mapper",
                time: { live: now, firstObject: notes[0].t, lastObject: notes.at(-1).t },
                mode: { number: 3, name: "mania" },
                stats: { stars: { live: 0, total: 4.2 }, bpm: { realtime: 166 * RATE, common: 166 * RATE, min: 166 * RATE, max: 166 * RATE } },
            },
            play: { mode: { number: 3 }, hits, hitErrorArray: errors.slice(-200), unstableRate: 0, accuracy: null, mods },
            files: { background: "bg.png" },
            folders: { beatmap: "smoke" },
        };
    };
    const timers = [
        setInterval(() => { const j = JSON.stringify(frame()); for (const ws of main.clients) ws.send(j); }, 100),
        setInterval(() => {
            const j = JSON.stringify(lazer ? lazerKeys(playStart === null ? null : live()) : { currentTime: live(), keys: { k1: { isPressed: false, count: 0 }, k2: { isPressed: false, count: 0 }, m1: { isPressed: false, count: 0 }, m2: { isPressed: false, count: 0 } } });
            for (const ws of precise.clients) ws.send(j);
        }, 20),
    ];
    return {
        port: http.address().port,
        backgroundAsked: () => backgroundAsked,
        startPlay: () => { playStart = Date.now() - 500; },
        results: () => { results = true; },
        // one frame of another state in the middle of song select (what used to flash the windows)
        blip: (number) => { const j = JSON.stringify({ ...frame(), state: { number } }); for (const ws of main.clients) ws.send(j); },
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

// --interlude: the fake Interlude and the real reader feeding the overlay; → { play(), stop() }
async function startInterlude(overlay) {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { createReaderProcess, readerPath } = await import("../../app/interludeReader.js");
    const READER = readerPath({ packaged: false, appDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app") });
    const FAKE = path.join(path.dirname(READER), "..", "fake", "FakeInterlude.exe");
    if (!existsSync(READER) || !existsSync(FAKE)) throw new Error(`build native/interlude-reader first (${READER})`);
    const fake = spawn(FAKE, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    fake.stdout.on("data", (d) => { out += d; });
    const cmd = async (c) => {
        const at = out.length;
        fake.stdin.write(`${c}\n`);
        for (let w = 0; w < 5000 && !out.slice(at).includes(`ok ${c}`); w += 20) await sleep(20);
    };
    for (let w = 0; w < 15000 && !out.includes("ready"); w += 50) await sleep(50);
    let attached = false;
    const reader = createReaderProcess({
        exe: () => READER, args: () => ["--name", "FakeInterlude"], // the fake only, never a real Interlude
        onMessage: (m) => {
            if (m.status === "attached") attached = true;
            if (m.status === "waiting") overlay.onInterlude(null);
            else if (!m.status && m.client === "interlude") overlay.onInterlude(m);
        },
        log: (l) => console.log("log", l),
    });
    reader.start();
    for (let w = 0; w < 20000 && !attached; w += 50) await sleep(50);
    await cmd("screen levelselect");
    await cmd("select hashB|Blue Zenith|xi|4K Insane|Mapper Two|4|100000|200|5.25");
    await cmd(`rate ${RATE}`);
    await sleep(500);
    return {
        play: () => cmd("play"),
        results: () => cmd("screen score"),
        leave: () => cmd("screen levelselect"),
        async stop() {
            await reader.stop();
            fake.kill();
        },
    };
}
// the fake Interlude's chart: 2000 notes, one every 50 ms round the columns, on the reader's clock (0 at the first)
const interludeNotes = async () => ({ keys: 4, notes: Array.from({ length: 2000 }, (_, i) => ({ t: i * 50, col: i % 4, end: null })) });
// the same chart as the .osu the library would give the Dan widget (its first note at 1000 ms of the file)
const interludeOsu = [
    "osu file format v14", "", "[General]", "Mode: 3", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "", "[HitObjects]",
    ...Array.from({ length: 2000 }, (_, i) => `${Math.floor((((i % 4) + 0.5) * 512) / 4)},192,${1000 + i * 50},1,0,0:0:0:0:`),
].join("\r\n");
// the analysis the app's worker does, here in this process (cached per map and rate by the overlay itself)
const danAnalyze = async ({ text, rate, result }) => ({ result: result ?? await analyzeChart(text, rate) });
// a dan label in either language: "Gamma mid", "12 high", "выше Kappa", "below dan 1" …
const DAN_LABEL = /((Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|\b\d{1,2}) (low|low\/mid|mid|mid\/high|high)|выше Kappa|above Kappa|ниже 1 дана|below dan 1)/;
const danText = (win) => win.webContents.executeJavaScript(`({
    text: document.getElementById("widget").innerText,
    state: document.querySelector(".ov-dan .ov-box")?.dataset.state ?? null,
    pattern: document.querySelector(".d-pattern")?.textContent ?? "",
    lines: [...(document.querySelector(".ov-dan .ov-box")?.children ?? [])].filter((n) => !n.hidden).map((n) => n.className),
    canvas: document.querySelectorAll(".ov-dan canvas").length,
    size: [innerWidth, innerHeight] })`);
// out of the box: the head alone (the overall dan), nothing else, no canvas
const onlyOverall = (dan, l) => {
    const words = l === "ru" ? ["уверенность", "сейчас", "к твоему уровню", "эта игра"] : ["confidence", "now:", "vs your level", "this play"];
    return dan.state === "ok" && DAN_LABEL.test(dan.text) && /\d+\.\d/.test(dan.text) && dan.lines.join() === "d-head" && dan.canvas === 0
        && words.every((w) => !dan.text.includes(w));
};

// The widgets kept up: an overlay of its own (not headless) in the edit mode, so they are on the screen; one minimized,
// one hidden, the app's window (a stand-in) minimized and restored → all back, visible, top-most.
async function keepUpStep(l) {
    const userData = path.join(outDir, `${prefix}keepup-${l}`);
    const main = new BrowserWindow({ width: 300, height: 200, show: false });
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: { register: () => true, unregister: () => {} }, screen, nativeImage },
        userData, port: 1, t, log: (x) => console.log("log", x), mainWindow: () => main,
    });
    try {
        overlay.apply({ enabled: true, widgets: { map: { enabled: true } } });
        overlay.setEdit(true);
        await sleep(800);
        const win = (w) => overlay.windowFor(w);
        check(WIDGETS.every((w) => win(w)?.isVisible()), `${l}: keep-up: the edit mode puts every widget on screen`);
        win("kps").minimize();
        await sleep(400);
        check(!win("kps").isMinimized() && win("kps").isVisible(), `${l}: keep-up: a minimized widget comes back`);
        win("nps").hide();
        await sleep(400);
        check(win("nps").isVisible(), `${l}: keep-up: a widget hidden behind our back comes back`);
        main.emit("minimize");
        main.emit("restore");
        await sleep(400);
        check(WIDGETS.every((w) => win(w)?.isVisible() && !win(w).isMinimized() && win(w).isAlwaysOnTop()),
            `${l}: keep-up: the app's window minimized and restored, every widget still up and top-most`);
        await capture(win("kps"), `${prefix}${l}-keepup-kps.png`);
    } finally {
        overlay.dispose();
        main.destroy();
    }
}


// Windows' own Z order of this app's visible windows, top first: [{ hwnd, topmost, x, y, w, h, title }]
function windowOrder() {
    const pids = app.getAppMetrics().map((m) => m.pid).join(",");
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "window-order.ps1");
    return JSON.parse(execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Pids", pids], { encoding: "utf8" }) || "[]");
}

// «когда ты меняешь размер оверлея в настройках он налазиет на настройки»: an overlay of its own in the edit mode, on the
// real screen, the settings window open, the KPS widget beside it and the judgements one under it.
async function coverStep(l) {
    const userData = path.join(outDir, `${prefix}cover-${l}`);
    rmSync(userData, { recursive: true, force: true });
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: { register: () => true, unregister: () => {} }, screen, nativeImage },
        userData, port: 1, t, log: (x) => console.log("log", x),
    });
    const hwnd = (w) => w.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const a = screen.getPrimaryDisplay().workArea;
    const hit = (p, q) => Math.min(p.x + p.width, q.x + q.width) > Math.max(p.x, q.x) && Math.min(p.y + p.height, q.y + q.height) > Math.max(p.y, q.y);
    try {
        overlay.apply({ snapEdges: false, widgets: { kps: { x: a.x + 200, y: a.y + 120 }, judgements: { x: a.x + 520, y: a.y + 200 } } });
        overlay.setEdit(true);
        await sleep(700);
        const sw = overlay.openSettings();
        await new Promise((r) => (sw.webContents.isLoading() ? sw.webContents.once("did-finish-load", r) : r()));
        sw.setBounds({ x: a.x + 420, y: a.y + 40, width: 600, height: 700 });
        sw.focus();
        await sleep(400);
        const kps = overlay.windowFor("kps");
        const j = overlay.windowFor("judgements");
        const kpsBefore = kps.getBounds();
        const jBefore = j.getBounds();
        check(hit(jBefore, sw.getBounds()), `${l}: cover: the judgements widget sits under the settings window`);
        // what the Size slider sends, for one beside the window, one under it; a style of another size too
        overlay.apply({ widgets: { kps: { scale: 2.5 }, judgements: { scale: 2 }, nps: { style: "compact" } } });
        await sleep(2000); // past a keep-up tick, which raises the widgets
        const size = (w) => { const b = w.getBounds(); return `${b.width}×${b.height}`; };
        check(size(kps) === `${kpsBefore.width}×${kpsBefore.height}`, `${l}: cover: 250% set, the KPS widget keeps its size (${size(kps)})`);
        check(size(j) === `${jBefore.width}×${jBefore.height}`, `${l}: cover: 200% set, the judgements widget keeps its size (${size(j)})`);
        check(!hit(kps.getBounds(), sw.getBounds()), `${l}: cover: the KPS widget does not reach the window`);
        let order = windowOrder();
        const at = (w) => order.findIndex((e) => e.hwnd === hwnd(w));
        console.log("order", JSON.stringify(order.map((e) => [e.title, e.topmost])));
        check(at(sw) === 0 && at(j) > 0, `${l}: cover: Windows has the settings window above every widget (${at(sw)} of ${order.length})`);
        // moved clear: to the right of the window, room for 525 px: it takes the new size
        kps.setPosition(a.x + 1040, a.y + 120);
        kps.emit("moved");
        await sleep(200);
        check(size(kps) === "525×320", `${l}: cover: moved clear of the window, the KPS widget takes its size (${size(kps)})`);
        check(size(j) === `${jBefore.width}×${jBefore.height}`, `${l}: cover: the one under the window goes on waiting`);
        sw.close();
        await sleep(400);
        check(size(j) === "368×356" || size(j) === `${jBefore.width * 2}×${jBefore.height * 2}`, `${l}: cover: settings closed, the judgements widget takes its size (${size(j)})`);
        order = windowOrder();
        check(overlay.windowFor("nps").getBounds().height === 40, `${l}: cover: and the waiting style its own`);
    } finally {
        overlay.dispose();
    }
}

// ---- --kbd: osu! stable's keys from the keyboard reader ----

const hrNow = () => Number(process.hrtime.bigint()) / 1e6; // QueryPerformanceCounter ms, the helper's clock
const KBD_VKS = [90, 88, 190, 191]; // Z X . / : the made-up cfg's 4K layout, lane by lane
const KBD_LAST = 9600; // map ms of the last note pressed
const KBD_FROM = 2500; // presses from here on are compared (the reader is listening well before)
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// the player: every note up to KBD_LAST pressed a little off its time (made up, the same every run), let go after a
// tap or at the hold's end; every 7th note a ghost press on another lane (no judgement). Map ms.
function kbdPlayer() {
    const presses = [];
    const busy = [[], [], [], []];
    const free = (col, a, b) => busy[col].every(([x, y]) => b < x - 8 || a > y + 8);
    const add = (p) => {
        if (!free(p.col, p.down, p.up)) return false;
        busy[p.col].push([p.down, p.up]);
        presses.push(p);
        return true;
    };
    const judgements = [];
    notes.forEach((n, i) => {
        if (n.t > KBD_LAST) return;
        const down = n.t + (((i * 37) % 37) - 18);
        const up = n.end ? n.end + (((i * 13) % 21) - 10) : down + 30 + ((i * 7) % 26);
        if (!add({ col: n.col, down, up, note: true })) return;
        judgements.push(down);
        if (n.end) judgements.push(up);
        if (i % 7 === 3) add({ col: (n.col + 2) % 4, down: n.t + 45, up: n.t + 58, note: false });
    });
    presses.sort((a, b) => a.down - b.down);
    judgements.sort((a, b) => a - b);
    return { presses, judgements };
}

// a fake tosu that reads osu! stable badly: frames 0-70 ms late (in order), no reading for 1.2 s of every 4 s
async function startBadTosu(player, gameDir) {
    const rand = rng(11);
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
    let playStart = null; // hr ms when the map's clock was 0
    let results = false;
    const queue = []; // late frames, in order: { at, json }
    let pump = null;
    const live = () => (playStart === null ? 0 : (hrNow() - playStart) * RATE);
    const frame = () => {
        const now = live();
        let judged = 0;
        while (judged < player.judgements.length && player.judgements[judged] <= now) judged += 1;
        const hits = { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0 };
        for (let i = 0; i < judged; i += 1) hits[i % 5 === 4 ? "300" : "geki"] += 1;
        return {
            client: "stable",
            state: { number: results ? 7 : playStart === null ? 5 : 2 },
            beatmap: { checksum: "smoke-kbd", time: { live: now }, mode: { number: 3, name: "mania" } },
            play: { mode: { number: 3 }, hits, hitErrorArray: [], unstableRate: 0, accuracy: null, mods: { name: "DT", array: [], rate: RATE } },
            folders: { game: gameDir, skin: "", songs: "", beatmap: "" },
            profile: { name: "Smoke" },
        };
    };
    const send = (json) => { for (const ws of main.clients) ws.send(json); };
    // the late frames go out when due, never before one read earlier
    const flush = () => {
        pump = null;
        while (queue.length && queue[0].at <= performance.now()) send(queue.shift().json);
        if (queue.length) pump = setTimeout(flush, Math.max(1, queue[0].at - performance.now()));
    };
    const timers = [
        setInterval(() => {
            const now = live();
            if (playStart !== null && !results && now % 4000 > 2800) return; // tosu reads nothing for a while
            const json = JSON.stringify(frame());
            // a third of the frames go out at once, as tosu sends them; the rest 0-70 ms late (but in order)
            if (rand() < 0.35 && !queue.length) return send(json);
            queue.push({ at: performance.now() + rand() * 70, json });
            queue.forEach((q, i) => { if (i) q.at = Math.max(q.at, queue[i - 1].at); });
            if (!pump) pump = setTimeout(flush, Math.max(1, queue[0].at - performance.now()));
        }, 100),
        setInterval(() => {
            const k = { isPressed: false, count: 0 };
            const j = JSON.stringify({ keys: { k1: k, k2: k, m1: k, m2: k }, hitErrors: [], tourney: [] });
            for (const ws of precise.clients) ws.send(j);
        }, 20),
    ];
    return {
        port: http.address().port,
        startPlay: () => { playStart = hrNow() - 500 / RATE; results = false; return playStart; },
        results: () => { results = true; },
        songSelect: () => { results = false; playStart = null; },
        mapNow: live,
        close: () => { timers.forEach(clearInterval); clearTimeout(pump); main.close(); precise.close(); http.close(); },
    };
}

// what the snapshots showed against what the player did; from: the first map ms compared
function kbdMeasure(snaps, presses, { from = KBD_FROM, sourceOnly = null } = {}) {
    const use = sourceOnly ? snaps.filter((s) => s.source === sourceOnly) : snaps;
    const bars = new Map();
    for (const s of use) for (const b of s.bars) bars.set(`${b.col}:${b.start}`, b);
    const byCol = [[], [], [], []];
    for (const b of bars.values()) byCol[b.col]?.push(b);
    const real = presses.map((p) => p.down / RATE).sort((a, b) => a - b);
    const errs = [];
    let unmatched = 0;
    const compared = presses.filter((p) => p.down >= from);
    for (const p of compared) {
        let best = null;
        for (const b of byCol[p.col]) if (!best || Math.abs(b.start - p.down) < Math.abs(best.start - p.down)) best = b;
        if (!best || Math.abs(best.start - p.down) > 100) unmatched += 1;
        else errs.push(Math.abs(best.start - p.down));
    }
    const kpsErr = [];
    for (const s of use) {
        if (s.clock < from + 1000 || s.clock > KBD_LAST - 100) continue;
        kpsErr.push(Math.abs(s.now - smoothRate(real, s.clock / RATE)));
    }
    let trueMax = 0;
    for (let g = 0; g <= (KBD_LAST + 1000) / RATE; g += 100) trueMax = Math.max(trueMax, smoothRate(real, g));
    const last = use.at(-1);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const round = (x) => Math.round(x * 1000) / 1000;
    return {
        source: last?.source ?? null,
        presses: compared.length,
        withBar: compared.length - unmatched,
        missed: unmatched,
        barStartErrMs: { mean: round(mean(errs)), max: round(Math.max(0, ...errs)) },
        kpsNowErr: { mean: round(mean(kpsErr)), max: round(Math.max(0, ...kpsErr)) },
        kpsMax: round(last?.max ?? 0),
        trueKpsMax: round(trueMax),
        counted: last ? last.counts.reduce((a, b) => a + b, 0) : 0,
    };
}

async function kbdSmoke() {
    const player = kbdPlayer();
    const gameDir = path.join(outDir, "kbd-game");
    rmSync(gameDir, { recursive: true, force: true });
    mkdirSync(gameDir, { recursive: true });
    // a made-up cfg, never a real player's: a couple of lines and the 4K layout
    writeFileSync(path.join(gameDir, "osu!.Smoke.cfg"), ["# osu! configuration for Smoke", "ManiaSpeed = 24",
        "ManiaLayouts4K = Z X OemPeriod OemQuestion", "ManiaLayoutSelected4K = 0", "KeyOverlay = 0"].join("\r\n"));
    const schedule = path.join(outDir, "kbd-schedule.json");
    const commands = path.join(outDir, "kbd-helper-commands.log");
    rmSync(commands, { force: true });
    writeFileSync(schedule, "[]");
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-key-helper.mjs");
    const tosu = await startBadTosu(player, gameDir);
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain, globalShortcut: { register: () => true, unregister: () => {} }, screen },
        userData: app.getPath("userData"), port: tosu.port, t, log: (l) => console.log("log", l), headless: true,
        // the real manager, the stand-in exe: Electron's own exe as node, the fake helper script, its schedule
        keyReader: (handlers) => createKeyReader({
            exe: () => process.execPath, args: () => [helper, schedule, commands],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, log: (l) => console.log("log", l), ...handlers,
        }),
    });
    const win = (w) => overlay.windowFor(w);
    const record = async () => win("keys").webContents.executeJavaScript(`window.__kbd = []; window.overlayApi.onState((s) => {
        if (s.phase !== "playing") return;
        window.__kbd.push({ clock: s.clock, now: s.kps.now, max: s.kps.max, source: s.lanes.source, counts: s.lanes.counts, bars: s.lanes.bars });
        window.__hist = { clock: s.clock, history: s.kps.history };
    }); true`);
    const results = {};
    try {
        overlay.apply({ enabled: true });
        check(overlay.settings().keyboard.enabled, "kbd: reading the keyboard is on out of the box");
        for (const phase of ["before", "after"]) {
            overlay.apply({ keyboard: { enabled: phase === "after" } });
            tosu.songSelect();
            await sleep(700);
            const start = tosu.startPlay();
            // the presses as the helper will report them: their hr times on this play's clock
            writeFileSync(schedule, JSON.stringify(player.presses.map((p) => ({
                vk: KBD_VKS[p.col], down: start + p.down / RATE, up: start + p.up / RATE,
            }))));
            for (let i = 0; i < 60 && !overlay.isShown("keys"); i += 1) await sleep(50);
            check(overlay.isShown("keys"), `kbd ${phase}: the key lines are up`);
            await record();
            while (tosu.mapNow() < KBD_LAST + 700) await sleep(50);
            const listening = overlay.listeningKeys(); // what the reader listens to, while the play is on
            if (phase === "after") await capture(win("keys"), "kbd-keys-after.png");
            const snaps = await win("keys").webContents.executeJavaScript("window.__kbd");
            const hist = await win("keys").webContents.executeJavaScript("window.__hist");
            tosu.results();
            await sleep(400);
            results[phase] = kbdMeasure(snaps, player.presses, { sourceOnly: phase === "after" ? "kbd" : null });
            results[phase].snapshots = snaps.length;
            console.log(`kbd ${phase}`, JSON.stringify(results[phase]));
            if (phase === "before") {
                check(results.before.source === "map", `kbd before: the lines are the map's rebuild (${results.before.source})`);
                check(!existsSync(commands), "kbd before: the setting off, no helper was started");
                continue;
            }
            // after: the presses themselves
            const log = readFileSync(commands, "utf8").split("\n").filter(Boolean);
            const listenLine = log.find((l) => / listen \d/.test(l));
            const listenMap = listenLine ? (Number(listenLine.split(" ")[0]) - start) * RATE : Infinity;
            console.log("kbd helper", JSON.stringify({ commands: log.map((l) => l.replace(/^[\d.]+ /, "")), listenMap: Math.round(listenMap) }));
            check(listenLine?.endsWith(" listen 88,90,190,191"), `kbd: the helper hears the cfg's four keys and no others (${listenLine})`);
            check(listenMap < KBD_FROM - 300, `kbd: listening from map ${Math.round(listenMap)} ms, before the presses compared (${KBD_FROM})`);
            const lk = listening;
            check(lk?.source === "osu" && lk.file === "osu!.Smoke.cfg" && lk.names.join(" ") === "Z X OemPeriod OemQuestion",
                `kbd: the lanes from osu!'s cfg (${JSON.stringify(lk)})`);
            const a = results.after;
            check(a.source === "kbd", `kbd after: the lines are the keyboard's (${a.source})`);
            check(a.missed === 0 && a.withBar === a.presses, `kbd after: a bar for every press, ghost presses too (${a.withBar} of ${a.presses})`);
            check(a.barStartErrMs.max <= 2, `kbd after: every bar starts at its press, within ${a.barStartErrMs.max} ms (mean ${a.barStartErrMs.mean})`);
            // the lane counts: every press the helper reported (all after the listen)
            const heard = player.presses.filter((p) => start + p.down / RATE > Number(listenLine.split(" ")[0]));
            check(a.counted === heard.length, `kbd after: the lanes count the presses (${a.counted} of ${heard.length})`);
            // the KPS graph's finished samples and the max are those of the presses heard
            const heardReal = heard.map((p) => p.down / RATE).sort((x, y) => x - y);
            const tNow = hist.clock / RATE;
            const lastGrid = Math.floor(tNow / 100) * 100;
            const n = hist.history.values.length - 2;
            let worst = 0;
            for (let i = 0; i <= n; i += 1) {
                const g = lastGrid - (n - i) * 100;
                if (g > tNow - 100) continue;
                worst = Math.max(worst, Math.abs(hist.history.values[i] - smoothRate(heardReal, g)));
            }
            let maxHeard = 0;
            for (let g = 0; g <= (KBD_LAST + 1000) / RATE; g += 100) maxHeard = Math.max(maxHeard, smoothRate(heardReal, g));
            a.kpsGraphErr = Math.round(worst * 1000) / 1000;
            // what was compared, for a look when it fails
            if (worst >= 0.05) writeFileSync(path.join(outDir, "kbd-kps-graph.json"), JSON.stringify({ hist, heardReal, tNow, lastGrid }));
            a.kpsMaxHeard = Math.round(maxHeard * 1000) / 1000;
            check(worst < 0.05, `kbd after: the KPS graph is the presses' own (worst sample off by ${a.kpsGraphErr})`);
            check(Math.abs(a.kpsMax - maxHeard) < 0.05, `kbd after: KPS max ${a.kpsMax} = the presses' ${a.kpsMaxHeard}`);
            for (let i = 0; i < 60 && !readFileSync(commands, "utf8").trim().endsWith("stop"); i += 1) await sleep(50);
            check(readFileSync(commands, "utf8").trim().endsWith("stop"), "kbd: the results screen: the helper listens to nothing");
        }
        const b = results.before;
        check(b.missed > 0 || b.barStartErrMs.mean > 5, `kbd before: the map rebuild misses presses or puts them off (${b.missed} missed, ${b.barStartErrMs.mean} ms off)`);
        writeFileSync(path.join(outDir, "kbd-measure.json"), JSON.stringify(results, null, 1));
        // the settings window: the keyboard block with the cfg's keys, in each language
        for (const l of ["ru", "en"]) {
            lang = l;
            setLang(l);
            const sw = overlay.openSettings();
            await new Promise((r) => (sw.webContents.isLoading() ? sw.webContents.once("did-finish-load", r) : r()));
            await sleep(700);
            const kb = await sw.webContents.executeJavaScript(`({ lanes: [...document.querySelectorAll("#kbdLanes button")].map((b) => b.textContent),
                from: document.getElementById("kbdFrom").textContent, on: document.getElementById("kbdOn").checked,
                label: document.querySelector("[data-i18n='overlay.kbd.enabled']").textContent })`);
            console.log("kbd settings", l, JSON.stringify(kb));
            check(kb.on && kb.lanes.join(" ") === "Z X . /", `kbd ${l}: the settings window shows the cfg's keys (${kb.lanes.join(" ")})`);
            check(kb.from === `${t("overlay.kbd.fromOsu")} (osu!.Smoke.cfg)`, `kbd ${l}: and where they come from (${kb.from})`);
            check(kb.label === (l === "ru" ? "Читать клавиши с клавиатуры" : "Read keys from the keyboard"), `kbd ${l}: the switch (${kb.label})`);
            const height = await sw.webContents.executeJavaScript("document.documentElement.scrollHeight");
            sw.setContentSize(600, Math.min(height, 4000));
            await sleep(400);
            await capture(sw, `kbd-${l}-settings.png`, { background: false });
            sw.destroy();
        }
    } finally {
        const pid = Number((existsSync(commands) ? readFileSync(commands, "utf8") : "").match(/^pid (\d+)/)?.[1]);
        await overlay.dispose();
        tosu.close();
        if (pid) {
            let gone = false;
            for (let i = 0; i < 40 && !gone; i += 1) {
                try { process.kill(pid, 0); await sleep(50); } catch { gone = true; }
            }
            check(gone, "kbd: the helper is gone with the app");
            if (!gone) try { process.kill(pid); } catch { /* gone */ }
        }
    }
}

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    if (kbdMode) {
        try {
            await kbdSmoke();
        } catch (error) {
            console.error(error);
            failed = true;
        }
        app.exit(failed ? 1 : 0);
        return;
    }
    const tosu = await startFakeTosu();
    // a stand-in for the global hotkey, so the smoke never takes a key from the desktop
    const globalShortcut = { register: () => true, unregister: () => {} };
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain, globalShortcut, screen, nativeImage },
        userData: app.getPath("userData"), port: tosu.port, t, log: (l) => console.log("log", l), headless: true,
        interludeNotes, danAnalyze, interludeText: async () => interludeOsu, recording: async () => true,
    });
    let il = null;
    try {
        if (interludeMode) il = await startInterlude(overlay);
        overlay.apply({ enabled: true });
        // the profile the main window would tell: a hand-set one, 12 on every tile
        overlay.setProfile({ skill: { overall: 12, tiles: { speed: 12, jack: 12, stamina: 12, tech: 12 } } });
        await sleep(600);
        check(WIDGETS.every((w) => !overlay.isShown(w)), "song select: no widget shown (the map panel is off out of the box)");
        check(overlay.windowFor("map") === null, "the map panel off: no window for it");
        // the map panel turned on: it alone is up in song select, with the selected map and its picture
        const win = (w) => overlay.windowFor(w);
        const mapView = () => win("map").webContents.executeJavaScript(`({
            title: document.querySelector(".m-title")?.textContent, artist: document.querySelector(".m-artist")?.textContent,
            version: document.querySelector(".m-version")?.textContent, mapper: document.querySelector(".m-mapper")?.textContent,
            stars: document.querySelector(".m-stars")?.textContent, dan: document.querySelector(".m-dan")?.textContent,
            bpm: document.querySelector(".m-bpm")?.textContent, len: document.querySelector(".m-len")?.textContent,
            rate: document.querySelector(".m-rate")?.textContent, mods: document.querySelector(".m-mods")?.textContent,
            fill: document.querySelector(".m-fill")?.style.transform,
            image: Boolean(document.querySelector(".m-img")?.src?.startsWith("data:image/jpeg")), natural: document.querySelector(".m-img")?.naturalWidth,
            text: document.getElementById("widget").innerText })`);
        overlay.apply({ widgets: { map: { enabled: true } } });
        if (!il) {
            for (let i = 0; i < 40 && !overlay.isShown("map"); i += 1) await sleep(50);
            check(overlay.isShown("map") && PLAY_WIDGETS.every((w) => !overlay.isShown(w)), "map panel: up in song select, alone");
            await sleep(700);
            const sel = await mapView();
            console.log("map select", JSON.stringify(sel));
            check(sel.title === "Smoke Map" && sel.artist === "Smoke Artist" && sel.version === "[4K Test]" && sel.mapper?.includes("Smoke Mapper"), "map panel: the selected map's names");
            check(sel.stars === "★ 4.20" && /BPM$/.test(sel.bpm ?? "") && /^\d+:\d\d$/.test(sel.len ?? ""), `map panel: stars, BPM, length (${sel.stars} ${sel.bpm} ${sel.len})`);
            check(sel.image && sel.natural === 96, `map panel: the map's picture came, as a JPEG (${sel.natural} px)`);
            check(sel.fill === "scaleX(0)", "map panel: no progress in song select");
            check(tosu.backgroundAsked() === 1, `map panel: the picture fetched once (${tosu.backgroundAsked()})`);
            await capture(win("map"), `${prefix}ru-select-map.png`);
        }
        tosu.blip(2);
        await sleep(250);
        tosu.blip(7);
        await sleep(700);
        check(PLAY_WIDGETS.every((w) => !overlay.isShown(w)), "song select with a stray play and results frame: still no play widget shown");
        if (il) await il.play();
        else tosu.startPlay();
        for (let i = 0; i < 50 && !WIDGETS.every((w) => overlay.isShown(w)); i += 1) await sleep(100);
        check(WIDGETS.every((w) => overlay.isShown(w)), "playing: every widget shown");
        check(win("kps").isAlwaysOnTop(), "always on top");
        await sleep(2500); // let the play run
        // the Dan widget: the map's analysis (in this process here, the worker in the app) comes once
        let dan = await danText(win("dan"));
        for (let i = 0; i < 300 && dan.state !== "ok"; i += 1) {
            await sleep(100);
            dan = await danText(win("dan"));
        }
        console.log("dan", JSON.stringify(dan));
        check(dan.state === "ok" && DAN_LABEL.test(dan.text) && /\d+\.\d/.test(dan.text), `dan: the map's dan with its label (${dan.text.replace(/\s+/g, " ")})`);
        check(onlyOverall(dan, "ru"), `dan: out of the box only the overall dan (${dan.lines.join()} · ${dan.text.replace(/\s+/g, " ")})`);
        check(win("dan").getBounds().height <= 70, `dan: a small window for the overall dan alone (${win("dan").getBounds().height} px)`);
        await capture(win("dan"), `${prefix}ru-dan-default.png`);
        // the extras turned on: the pattern and how sure, "for you" — still no line or "now"
        overlay.apply({ widgets: { dan: { show: { pattern: true, forYou: true, play: true } } } });
        await sleep(600);
        dan = await danText(win("dan"));
        console.log("dan extras", JSON.stringify(dan));
        check(dan.text.includes("уверенность:") && dan.text.includes("к твоему уровню") && !dan.text.includes("сейчас") && dan.canvas === 0,
            "dan extras: confidence and for you, no now, no line (ru)");
        check(win("dan").getBounds().height > 70, `dan extras: the window grows for them (${win("dan").getBounds().height} px)`);
        // the fake Interlude's chart is one note round the columns: no named pattern in it, so none is shown
        if (!interludeMode) check(Boolean(dan.pattern), `dan: the main pattern (${dan.pattern})`);

        // one stray song-select frame in the middle of the play: the play goes on, its KPS max and lanes are kept
        await win("keys").webContents.executeJavaScript(`window.__last = null; window.overlayApi.onState((s) => { window.__last = s; }); true`);
        await sleep(300);
        const beforeBlip = await win("keys").webContents.executeJavaScript("window.__last && { max: window.__last.kps.max, counts: window.__last.lanes.counts, source: window.__last.lanes.source }");
        tosu.blip(5);
        await sleep(300);
        const afterBlip = await win("keys").webContents.executeJavaScript("window.__last && { max: window.__last.kps.max, counts: window.__last.lanes.counts, phase: window.__last.phase }");
        console.log("blip", JSON.stringify({ beforeBlip, afterBlip }));
        check(afterBlip && beforeBlip && afterBlip.max >= beforeBlip.max && afterBlip.max > 0, "a stray song-select frame keeps the KPS max");
        check(afterBlip && afterBlip.counts.reduce((a, b) => a + b, 0) >= beforeBlip.counts.reduce((a, b) => a + b, 0), "and the lane counts");
        check(WIDGETS.every((w) => overlay.isShown(w)), "and the widgets stay");
        // the map panel in the play: the map, the rate, its progress moving, its page told at a low rate only
        await win("map").webContents.executeJavaScript(`window.__states = 0; window.overlayApi.onState(() => { window.__states += 1; }); true`);
        const fillAt = (x) => Number(/scaleX\(([\d.]+)\)/.exec(x.fill ?? "")?.[1] ?? -1);
        const mapBefore = await mapView();
        await sleep(3000);
        const mapAfter = await mapView();
        const mapStates = await win("map").webContents.executeJavaScript("window.__states");
        console.log("map play", JSON.stringify({ mapBefore, mapAfter, mapStates }));
        check(mapAfter.title === (interludeMode ? "Blue Zenith" : "Smoke Map"), `map panel: the play's map (${mapAfter.title})`);
        check(fillAt(mapAfter) > fillAt(mapBefore) && fillAt(mapBefore) > 0, `map panel: its progress moves (${mapBefore.fill} → ${mapAfter.fill})`);
        check(mapStates >= 3 && mapStates <= 9, `map panel: ${mapStates} states in 3 s, at a low rate`);
        check(/ \/ /.test(mapAfter.len ?? ""), `map panel: how far into the map (${mapAfter.len})`);
        if (lazer) check(mapAfter.rate === "1.2×" && mapAfter.mods === "DT", `map panel: lazer's rate and mods (${mapAfter.rate} ${mapAfter.mods})`);
        if (interludeMode) check(mapAfter.rate === "1.25×" && mapAfter.bpm === "250 BPM", `map panel: Interlude's BPM with the rate (${mapAfter.bpm} ${mapAfter.rate})`);
        if (!il) check(DAN_LABEL.test(mapAfter.dan ?? ""), `map panel: the Lunacy dan (${mapAfter.dan})`);
        if (lazer) check(beforeBlip?.source === "keys", `lazer: the key lines come from lazer's key counters (${beforeBlip?.source})`);
        if (interludeMode) check(beforeBlip?.source === "keys", `interlude: the key lines come from Interlude's own presses (${beforeBlip?.source})`);

        const state = await win("judgements").webContents.executeJavaScript(`({
            text: document.getElementById("widget").innerText,
            cls: document.getElementById("widget").className })`);
        console.log("judgements", JSON.stringify(state));
        check(/\d+\.\d\d:1/.test(state.text), "judgements show the MAX:300 ratio");
        if (interludeMode) check(/MARV/.test(state.text) && /PERF/.test(state.text) && /MARV:PERF/.test(state.text), "interlude: the ruleset's own judgement names (SC: MARV, PERF …)");
        check(/\d+\.\d\d%/.test(state.text), "judgements show the accuracy");
        const keys = await win("keys").webContents.executeJavaScript(
            `[...document.querySelectorAll(".l-count")].map((n) => Number(n.textContent))`);
        console.log("key counts", JSON.stringify(keys));
        check(keys.length === 4 && keys.every((n) => n > 0), `the key lines count presses in all four lanes (from the ${lazer || interludeMode ? "keys" : "map"})`);
        const kpsNow = await win("kps").webContents.executeJavaScript(`Number(document.querySelector(".k-now-value").textContent)`);
        check(kpsNow >= 0.72 * NPS_BASE * RATE && kpsNow <= 1.27 * NPS_BASE * RATE, `KPS now is about ${Math.round(NPS_BASE * RATE)} (${kpsNow})`);

        // a steady 11 notes a second: the KPS number and the graph should hold still. The snapshots the window gets
        // are recorded for 2.4 s (the shown number, the graph's top); a few frames of the graph are captured on the way.
        await win("kps").webContents.executeJavaScript(`window.__snaps = []; window.__err = null; window.overlayApi.onState((s) => { try {
            window.__snaps.push({ shown: document.querySelector(".k-now-value")?.textContent, max: s.kps.max,
                top: Math.max(10, ...(Array.isArray(s.kps.history) ? s.kps.history : s.kps.history.values)) }); } catch (e) { window.__err = String(e); } }); true`);
        for (let i = 0; i < 6; i += 1) {
            await sleep(400);
            await capture(win("kps"), `${prefix}kps-seq-${i}.png`);
        }
        const snaps = await win("kps").webContents.executeJavaScript("window.__snaps");
        check(!(await win("kps").webContents.executeJavaScript("window.__err")), "the KPS snapshots read");
        const shownValues = [...new Set(snaps.map((s) => s.shown))];
        const flips = snaps.filter((s, i) => i && s.shown !== snaps[i - 1].shown).length;
        const tops = [...new Set(snaps.map((s) => Math.round(s.top * 10) / 10))];
        console.log("kps steadiness", JSON.stringify({ snapshots: snaps.length, shownValues, flips, tops: tops.slice(0, 12) }));
        writeFileSync(path.join(outDir, `${prefix}kps-steadiness.json`), JSON.stringify({ shownValues, flips, tops, snaps }, null, 1));
        if (interludeMode) {
            // the fake Interlude misses every 25th note on purpose (no press) and jitters its hits by ±37 ms: the number
            // moves a little, but stays near the 25 presses a second it really gets
            const values = shownValues.map(Number);
            check(snaps.length > 40 && values.every((v) => v >= 0.8 * NPS_BASE * RATE && v <= 1.1 * NPS_BASE * RATE),
                `a steady stream with real misses: the KPS number stays near ${NPS_BASE * RATE} (${shownValues.join("/")}, ${flips} changes)`);
        } else {
            check(snaps.length > 40 && shownValues.length <= 2 && flips <= 2, `a steady stream: the KPS number holds (${shownValues.join("/")}, ${flips} changes)`);
        }

        // the map's NPS: the made-up map is a note every 90 ms, 11.1 a second, from start to end
        const nps = await win("nps").webContents.executeJavaScript(`({
            now: Number(document.querySelector(".k-now-value").textContent),
            peak: Number(document.querySelector(".k-max-value").textContent),
            text: document.getElementById("widget").innerText,
            graph: (() => { const c = document.querySelector(".n-graph"); return c ? [c.width, c.height] : null; })() })`);
        console.log("nps", JSON.stringify(nps));
        check(nps.now >= 0.9 * NPS_BASE * RATE && nps.now <= 1.08 * NPS_BASE * RATE && nps.peak >= 0.9 * NPS_BASE * RATE && nps.peak <= 1.17 * NPS_BASE * RATE,
            `NPS now ${nps.now}, peak ${nps.peak} (about ${Math.round(NPS_BASE * RATE)})`);
        check(Array.isArray(nps.graph) && nps.graph[0] > 50, "NPS draws the map's graph");
        check(nps.text.includes("NPS") && nps.text.includes(lang === "ru" ? "пик" : "peak"), `NPS labels (${nps.text.replace(/\s+/g, " ")})`);

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
                for (const w of WIDGETS) await capture(win(w), `${prefix}${l}-${style}-${w}.png`);
            }
            const danNow = await danText(win("dan"));
            check(l === "ru" ? danNow.text.includes("к твоему уровню") && !danNow.text.includes("сейчас")
                : danNow.text.includes("vs your level") && !danNow.text.includes("now:"),
            `${l}: the Dan widget's words (${danNow.text.replace(/\s+/g, " ")})`);
            // and the widget as it comes: the overall dan alone, in every style
            overlay.apply({ widgets: { dan: { show: { pattern: false, forYou: false, play: false } } } });
            for (const style of STYLES) {
                overlay.apply({ widgets: { dan: { style } } });
                await sleep(400);
                const only = await danText(win("dan"));
                check(onlyOverall(only, l), `${l}: ${style}: the overall dan alone (${only.lines.join()} · ${only.text.replace(/\s+/g, " ")})`);
                await capture(win("dan"), `${prefix}${l}-${style}-dan-default.png`);
            }
            overlay.apply({ widgets: { dan: { show: { pattern: true, forYou: true, play: true } } } });
            await sleep(300);
            const peakLabel = await win("nps").webContents.executeJavaScript(`document.querySelector(".k-max .k-unit").textContent`);
            check(peakLabel === (l === "ru" ? "пик" : "peak"), `${l}: NPS peak label "${peakLabel}"`);
            const cls = await win("kps").webContents.executeJavaScript(`document.getElementById("widget").className`);
            check(cls.includes(`style-${STYLES.at(-1)}`), `${l}: the style class follows the setting (${cls})`);
            // the edit mode: dashed frame, badge, corner grip
            overlay.apply({ widgets: Object.fromEntries(WIDGETS.map((w) => [w, { style: "card" }])) });
            overlay.setEdit(true);
            await sleep(400);
            for (const w of WIDGETS) await capture(win(w), `${prefix}${l}-edit-${w}.png`);
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
            await capture(sw, `${prefix}${l}-settings.png`, { background: false });
            const title = await sw.webContents.executeJavaScript("document.querySelector('h1').textContent");
            check(title === (l === "ru" ? "Оверлей в игре" : "In-game overlay"), `${l}: settings heading "${title}"`);
            sw.destroy();
            await keepUpStep(l);
            await coverStep(l);
        }
        // the corner resize path: a bigger scale gives a bigger window
        const before = win("kps").getBounds();
        overlay.apply({ widgets: { kps: { scale: 1.5 } } });
        await sleep(200);
        const after = win("kps").getBounds();
        check(after.width > before.width && after.height > before.height, `scale 1.5 resizes the window (${before.width}×${before.height} → ${after.width}×${after.height})`);
        // the results screen: the Dan widget shows the play's own dan (recording is on), in place of "now"
        if (il) await il.results();
        else tosu.results();
        let danAfter = await danText(win("dan"));
        for (let i = 0; i < 40 && !danAfter.text.includes(lang === "ru" ? "эта игра:" : "this play:"); i += 1) {
            await sleep(100);
            danAfter = await danText(win("dan"));
        }
        console.log("dan results", JSON.stringify(danAfter));
        check(overlay.isShown("dan"), "results: the Dan widget stays (shown on the results screen)");
        check(danAfter.text.includes(lang === "ru" ? "эта игра:" : "this play:") && DAN_LABEL.test(danAfter.text), `results: this play's dan (${danAfter.text.replace(/\s+/g, " ")})`);
        check(!danAfter.text.includes(lang === "ru" ? "сейчас" : "now:") && danAfter.canvas === 0, "results: no \"now\", no line");
        await capture(win("dan"), `${prefix}${lang}-results-dan.png`);
        if (il) {
            // Interlude back in level select: the play is over, the widgets go
            await il.leave();
            for (let i = 0; i < 30 && PLAY_WIDGETS.some((w) => overlay.isShown(w)); i += 1) await sleep(100);
            check(PLAY_WIDGETS.every((w) => !overlay.isShown(w)), "interlude: back in level select, no play widget shown");
            check(overlay.isShown("map"), "interlude: the map panel stays in level select");
        }
    } catch (error) {
        console.error(error);
        failed = true;
    } finally {
        await il?.stop();
        overlay.dispose();
        tosu.close();

        app.exit(failed ? 1 : 0);
    }
});
