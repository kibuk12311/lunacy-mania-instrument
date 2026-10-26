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
// The Dan widget: the map played is analysed for real in this process (src/core/analyze.js and the details job, as the
// worker would), a hand-set profile stands in for the main window's, recording is on: while playing it must show the
// map's dan with its label, the pattern, the confidence, "now" and "for you" in each language, and on the results
// screen at the end (the fake tosu's results state, Interlude's score screen) "this play".
// Exits 1 when a check fails.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { setLang, t } from "../../src/i18n/i18n.js";
import { createOverlay } from "../../app/overlay/overlayManager.js";
import { STYLES, WIDGETS } from "../../src/overlay/settings.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { computeDetails } from "../../src/analysis/timeline.js";

const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("-") && !a.endsWith(".mjs")) ?? "overlay-smoke");
const lazer = process.argv.includes("--lazer");
const interludeMode = process.argv.includes("--interlude");
const RATE = lazer ? 1.2 : interludeMode ? 1.25 : 1; // map ms per real ms
const prefix = lazer ? "lazer-" : interludeMode ? "interlude-" : ""; // names this run's screenshots
// notes a second of the map at 1×: the made-up osu! map below, or the fake Interlude's chart
const NPS_BASE = interludeMode ? 20 : 11.1;
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
            beatmap: { checksum: "smoke-map", time: { live: now }, mode: { number: 3, name: "mania" } },
            play: { mode: { number: 3 }, hits, hitErrorArray: errors.slice(-200), unstableRate: 0, accuracy: null, mods },
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
const danAnalyze = async ({ text, rate, result }) => {
    const r = result ?? await analyzeChart(text, rate);
    let details = null;
    try {
        details = r?.kind === "ok" ? computeDetails(text, rate) : null;
    } catch (error) {
        console.log("details failed", error.message);
    }
    return { result: r, details };
};
// a dan label in either language: "Gamma mid", "12 high", "выше Kappa", "below dan 1" …
const DAN_LABEL = /((Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|\b\d{1,2}) (low|low\/mid|mid|mid\/high|high)|выше Kappa|above Kappa|ниже 1 дана|below dan 1)/;
const danText = (win) => win.webContents.executeJavaScript(`({
    text: document.getElementById("widget").innerText,
    state: document.querySelector(".ov-dan .ov-box")?.dataset.state ?? null,
    pattern: document.querySelector(".d-pattern")?.textContent ?? "",
    spark: (() => { const c = document.querySelector(".d-spark"); return c && !c.hidden ? [c.width, c.height] : null; })() })`);

// The widgets kept up: an overlay of its own (not headless) in the edit mode, so they are on the screen; one minimized,
// one hidden, the app's window (a stand-in) minimized and restored → all back, visible, top-most.
async function keepUpStep(l) {
    const userData = path.join(outDir, `${prefix}keepup-${l}`);
    const main = new BrowserWindow({ width: 300, height: 200, show: false });
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: { register: () => true, unregister: () => {} }, screen },
        userData, port: 1, t, log: (x) => console.log("log", x), mainWindow: () => main,
    });
    try {
        overlay.apply({ enabled: true });
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

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    const tosu = await startFakeTosu();
    // a stand-in for the global hotkey, so the smoke never takes a key from the desktop
    const globalShortcut = { register: () => true, unregister: () => {} };
    const overlay = createOverlay({
        electron: { BrowserWindow, ipcMain, globalShortcut, screen },
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
        check(WIDGETS.every((w) => !overlay.isShown(w)), "song select: no widget shown");
        tosu.blip(2);
        await sleep(250);
        tosu.blip(7);
        await sleep(700);
        check(WIDGETS.every((w) => !overlay.isShown(w)), "song select with a stray play and results frame: still none shown");
        if (il) await il.play();
        else tosu.startPlay();
        for (let i = 0; i < 50 && !WIDGETS.every((w) => overlay.isShown(w)); i += 1) await sleep(100);
        check(WIDGETS.every((w) => overlay.isShown(w)), "playing: every widget shown");
        const win = (w) => overlay.windowFor(w);
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
        check(dan.text.includes("уверенность:") && dan.text.includes("сейчас:") && dan.text.includes("к твоему уровню"),
            "dan: confidence, now and for you (ru)");
        // the fake Interlude's chart is one note round the columns: no named pattern in it, so none is shown
        if (!interludeMode) check(Boolean(dan.pattern), `dan: the main pattern (${dan.pattern})`);
        check(Array.isArray(dan.spark) && dan.spark[0] > 50, "dan: the line along the map is drawn");

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
            check(l === "ru" ? danNow.text.includes("сейчас:") && danNow.text.includes("к твоему уровню")
                : danNow.text.includes("now:") && danNow.text.includes("vs your level"),
            `${l}: the Dan widget's words (${danNow.text.replace(/\s+/g, " ")})`);
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
        check(!danAfter.text.includes(lang === "ru" ? "сейчас:" : "now:"), "results: no \"now\" any more");
        await capture(win("dan"), `${prefix}${lang}-results-dan.png`);
        if (il) {
            // Interlude back in level select: the play is over, the widgets go
            await il.leave();
            for (let i = 0; i < 30 && WIDGETS.some((w) => overlay.isShown(w)); i += 1) await sleep(100);
            check(WIDGETS.every((w) => !overlay.isShown(w)), "interlude: back in level select, no widget shown");
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
