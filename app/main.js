import { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, screen, shell, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pickDocsDir } from "./docsFolder.js";
import { installTosu, isPortFree, killOrphanTosu, startTosu, TOSU_PORT } from "./tosuManager.js";
import { createWorkerClient } from "./workerClient.js";
import { connectTosu, fetchCurrentOsu, fetchCurrentBeatmap, fetchCurrentBeatmapPath, fetchProfile } from "./tosuClient.js";
import { createRecommender } from "../src/recommend/recommend.js";
import { createTrackerApi } from "../src/recommend/tracker.js";
import { createDownloader } from "../src/recommend/download.js";
import { createSelectionController } from "./selectionController.js";
import { createAnalysisService } from "./analysisService.js";
import { createHooks } from "./hooks.js";
import { createJsonStore } from "./jsonStore.js";
import { createProfileService, normalizeProfileRecord, registerProfileIpc } from "./profileService.js";
import { registerAnalysisIpc } from "./analysisIpc.js";
import { registerRateIpc } from "./rateIpc.js";
import { registerMarathonIpc } from "./marathonIpc.js";
import { registerRecommendIpc } from "./recommendIpc.js";
import { registerCreateIpc } from "./createIpc.js";
import { registerExportIpc } from "./exportIpc.js";
import { createGeneratedStore } from "./generatedStore.js";
import { createPngRenderer } from "./renderPng.js";
import { loadWindowState, saveWindowState, DEFAULT_WINDOW } from "./windowState.js";
import { createUpdater, isPortableRun, updateMode } from "./updater.js";
import { createOverlay } from "./overlay/overlayManager.js";
import { createCache } from "../src/core/cache.js";
import { setLang, getLang, langForLocale, LANGS, LANG_NAMES, t } from "../src/i18n/i18n.js";
import appTexts from "../src/i18n/messages/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const TITLE = `Lunacy mania ${version}`;
const COMPACT_HEIGHT = 64;
const TOSU_WATCHDOG_MS = 20_000;

let win = null;
let tray = null;
let tosu = null;
let tosuSocket = null;
let workerClient = null;
let generatorClient = null;
let createTabBounds = null; // window size while the "Создать карту" tab is open (not persisted)
let analysisBounds = null;
const CREATE_TAB_SIZE = { width: 480, height: 880 }; // the tab scrolls past this
let state = null;
let lastView = { screen: "waiting-osu" };
let quitting = false;
let fullHeight = null;
let tosuFailure = null; // () → why tosu failed, in the current language (the window asks again after a language switch)
let updater = null; // app/updater.js: GitHub Releases updates (the tray's two update items)
let overlay = null; // app/overlay/overlayManager.js: the in-game overlay widgets (the tray's «Overlay» submenu)
let osuClient = null; // the osu! tosu reads: "stable" | "lazer" | null (none, or tosu down)

const stateFile = () => path.join(app.getPath("userData"), "window.json");

// Short diagnostic log in userData\log.txt (rewritten on each start) so problems can be reported.
let logStarted = false;
function log(line) {
    const file = path.join(app.getPath("userData"), "log.txt");
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
        if (logStarted) appendFileSync(file, text, "utf8");
        else writeFileSync(file, text, "utf8");
        logStarted = true;
    } catch {
        // logging must never break the app
    }
}
// Main-process events the tab modules subscribe to (see hooks.js).
const hooks = createHooks({ log });
const bundledTosuDir = () => (app.isPackaged ? path.join(process.resourcesPath, "tosu") : path.join(here, "..", "vendor", "tosu"));

// tosu will not run from %TEMP%, where the portable exe unpacks itself, so run a copy kept in userData.
async function launchTosu(controller) {
    const runDir = path.join(app.getPath("userData"), "tosu");
    if (killOrphanTosu(runDir)) log("killed tosu left over from a previous run");
    try {
        installTosu(bundledTosuDir(), runDir);
    } catch (error) {
        log(`tosu install failed: ${error.message}`); // a missing bundle is reported by startTosu
    }
    log(`start ${TITLE}, tosu ${runDir}`);

    if (!(await isPortFree(TOSU_PORT))) {
        const reusable = await fetch(`http://127.0.0.1:${TOSU_PORT}/json/v2`, { signal: AbortSignal.timeout(2000) })
            .then((r) => r.json()).then((j) => Boolean(j?.state)).catch(() => false);
        log(`port ${TOSU_PORT} busy, ${reusable ? "a tosu already answers there, using it" : "not tosu"}`);
        if (!reusable) tosuFailed(controller, () => t("app.tosu.portBusy", { port: TOSU_PORT }));
        return null;
    }
    return startTosu({
        tosuDir: runDir,
        onExit: (error) => {
            log(`tosu exit ${error?.message ?? "ok"}`);
            if (error && !quitting) tosuFailed(controller, () => error.retell?.() ?? error.message);
        },
    });
}

// which osu! tosu reads (from its frames), told to the window when it changes
function setOsuClient(client) {
    const next = client === "stable" || client === "lazer" ? client : null;
    if (next === osuClient) return;
    osuClient = next;
    log(`osu! client ${next ?? "none"}`);
    send("osu-client", { client: next });
}

function tosuFailed(controller, reason) {
    tosuFailure = reason;
    controller.onTosuFailed(reason());
}

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function settings() {
    return { alwaysOnTop: state.alwaysOnTop, compact: state.compact, lang: getLang() };
}

function persist() {
    // While the create tab is open the window is temporarily bigger; keep the analysis-tab size on disk.
    if (win && !win.isDestroyed() && !win.isMinimized() && !createTabBounds) Object.assign(state, win.getBounds());
    saveWindowState(stateFile(), state);
}

function toggle(key) {
    state[key] = !state[key];
    if (key === "alwaysOnTop") win.setAlwaysOnTop(state.alwaysOnTop);
    if (key === "compact") {
        const [width, height] = win.getContentSize();
        if (state.compact) {
            fullHeight = height;
            win.setContentSize(width, COMPACT_HEIGHT);
        } else {
            win.setContentSize(width, Math.max(fullHeight ?? 0, DEFAULT_WINDOW.height - 40));
        }
    }
    persist();
    send("settings", settings());
    buildTray();
}

function buildTray() {
    const menu = Menu.buildFromTemplate([
        { label: t("app.tray.show"), click: () => { win.show(); win.focus(); } },
        { label: t("app.tray.alwaysOnTop"), type: "checkbox", checked: state.alwaysOnTop, click: () => toggle("alwaysOnTop") },
        { label: t("app.tray.compact"), type: "checkbox", checked: state.compact, click: () => toggle("compact") },
        ...(overlay?.trayItems() ?? []),
        {
            // both languages at once ("Язык / Language"), so it can be found whichever one is on
            label: LANGS.map((l) => appTexts["app.tray.language"][l]).join(" / "),
            submenu: LANGS.map((l) => ({ label: LANG_NAMES[l], type: "radio", checked: getLang() === l, click: () => switchLang(l) })),
        },
        { type: "separator" },
        { label: t("app.tray.checkUpdates"), click: () => void updater?.check({ manual: true }) },
        { label: t("app.tray.autoUpdate"), type: "checkbox", checked: state.autoUpdate, click: () => toggle("autoUpdate") },
        { type: "separator" },
        { label: t("app.tray.quit"), click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
}

// The whole window reloads in the new language; main and the worker switch with it.
function switchLang(lang) {
    if (!LANGS.includes(lang) || lang === getLang()) return;
    state.lang = setLang(lang);
    persist();
    buildTray();
    if (win && !win.isDestroyed()) win.webContents.reload();
    overlay?.reload();
}

function createWindow() {
    // an install from before the language setting stays Russian; a new one follows the system
    const known = existsSync(stateFile());
    state = loadWindowState(stateFile(), [screen.getPrimaryDisplay(), ...screen.getAllDisplays()]);
    state.lang = setLang(state.lang ?? (known ? "ru" : langForLocale(app.getLocale())));
    win = new BrowserWindow({
        x: state.x, y: state.y, width: state.width, height: state.height,
        minWidth: 220, minHeight: 90,
        title: TITLE,
        alwaysOnTop: state.alwaysOnTop,
        autoHideMenuBar: true,
        backgroundColor: "#14121c",
        icon: path.join(here, "assets", "icon.png"),
        webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    win.setMenu(null);
    win.loadFile(path.join(here, "renderer", "index.html"));
    win.on("page-title-updated", (e) => e.preventDefault());
    win.webContents.on("did-finish-load", () => {
        send("settings", settings());
        // a tosu failure shown before a language switch is told again in the new language
        send("view", lastView.screen === "tosu-failed" && tosuFailure ? { ...lastView, reason: tosuFailure() } : lastView);
        send("osu-client", { client: osuClient });
        hooks.emit("window-load");
    });
    win.on("moved", persist);
    win.on("resized", persist);
    win.on("close", () => persist());
    win.on("closed", () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
    app.whenReady().then(main);
}

async function main() {
    // preload asks for the language synchronously while the page loads, so this is in place before the window
    ipcMain.on("get-lang", (event) => { event.returnValue = getLang(); });
    createWindow();
    // installed build: electron-updater; portable exe: the release page; dev run: nothing by itself (app/updater.js)
    updater = createUpdater({
        mode: updateMode({ packaged: app.isPackaged, portable: isPortableRun(process.env) }),
        version,
        loadAutoUpdater: async () => (await import("electron-updater")).default.autoUpdater,
        dialog,
        window: () => (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : null),
        openExternal: (url) => shell.openExternal(url),
        fetch: globalThis.fetch,
        log, t,
        autoCheck: () => state.autoUpdate,
    });
    updater.start();
    overlay = createOverlay({
        electron: { BrowserWindow, ipcMain, globalShortcut, screen },
        userData: app.getPath("userData"), port: TOSU_PORT, t, log,
        onChange: () => buildTray(), icon: path.join(here, "assets", "icon.png"), mainWindow: () => win,
    });
    tray = new Tray(nativeImage.createFromPath(path.join(here, "assets", "icon.png")).resize({ width: 32, height: 32, quality: "best" }));
    tray.setToolTip(TITLE);
    tray.on("click", () => { win.show(); win.focus(); });
    buildTray();

    // A folder from an older name of the app is kept, so whoever has one keeps their maps there (app/docsFolder.js).
    const docsDir = pickDocsDir(app.getPath("documents"), existsSync);
    const mapsDir = path.join(docsDir, "карты");
    const insideMaps = (file) => path.resolve(String(file)).startsWith(path.resolve(mapsDir) + path.sep);
    // Generation has its own worker, so a long job never holds up the analysis card (the create tab, app/createIpc.js).
    generatorClient = createWorkerClient({ spawn: () => utilityProcess.fork(path.join(here, "analysisWorker.js")) });
    // ffmpeg for rate-changed audio (rate tab, marathons)
    const ffmpegPath = async () => (app.isPackaged
        ? path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe")
        : (await import("ffmpeg-static")).default);
    // HTML → 1920×1080 PNG in a hidden offscreen window (marathon backgrounds)
    const renderPng = createPngRenderer(BrowserWindow);

    // One of each shared service for the whole app, made before any tab registers; none does I/O until asked
    // (the worker process starts on the first analysis).
    const userData = app.getPath("userData");
    workerClient = createWorkerClient({ spawn: () => utilityProcess.fork(path.join(here, "analysisWorker.js")) });
    // Not "cache": Chromium already owns userData\Cache and Windows paths ignore case.
    // Versioned, so a new build with a retrained model never serves old dans.
    const resultCache = createCache({ dir: path.join(userData, `results-${version}`) });
    const analysis = createAnalysisService({ worker: workerClient, cache: resultCache, log });
    const trackerApi = createTrackerApi();
    const recommender = createRecommender({ api: trackerApi });
    const downloadsDir = path.join(docsDir, "скачанные");
    const downloader = createDownloader({ dir: downloadsDir });
    const profile = createProfileService({
        recommender, send, log,
        store: createJsonStore({ file: path.join(userData, "profile.json"), normalize: normalizeProfileRecord, fallback: null }),
    });
    // Every tab registers its channels from this one object; a tab builds what it lacks from these (main.js is frozen).
    // Every URL opened or fetched is built in the tab modules, never taken from the renderer.
    const deps = Object.freeze({
        ipcMain, shell, send, log, t,
        paths: Object.freeze({ userData, docsDir, mapsDir, downloadsDir }),
        insideMaps,
        // beatmap(): { client: "stable" | "lazer", path, audioPath, backgroundPath }; on lazer the paths are in its file store
        tosu: Object.freeze({
            port: TOSU_PORT, beatmapPath: () => fetchCurrentBeatmapPath(TOSU_PORT), beatmap: () => fetchCurrentBeatmap(TOSU_PORT),
            profile: () => fetchProfile(TOSU_PORT), client: () => osuClient,
        }),
        worker: workerClient,
        analysis,
        resultCache,
        trackerApi, recommender, downloader, profile,
        ffmpegPath,
        renderPng,
        hooks,
        // the create tab: its own worker and the generated maps it hands out by id
        generatorClient,
        generatedStore: createGeneratedStore({ max: 24 }),
    });
    registerProfileIpc(deps);
    // >>> tabs v2: one register call per tab (frozen)
    registerAnalysisIpc(deps);
    registerRateIpc(deps);
    registerMarathonIpc(deps);
    registerRecommendIpc(deps);
    registerCreateIpc(deps);
    registerExportIpc(deps);
    // <<< tabs v2

    ipcMain.handle("open-map", (_e, file) => (insideMaps(file) ? shell.openPath(file) : t("app.noSuchFile")));
    ipcMain.on("show-map", (_e, file) => { if (insideMaps(file)) shell.showItemInFolder(file); });
    ipcMain.on("tab", (_e, tab) => {
        if (tab === "create" && !createTabBounds) {
            analysisBounds = win.getBounds();
            createTabBounds = true;
            win.setBounds({ ...analysisBounds, width: Math.max(analysisBounds.width, CREATE_TAB_SIZE.width), height: Math.max(analysisBounds.height, CREATE_TAB_SIZE.height) });
        } else if (tab === "analysis" && createTabBounds) {
            createTabBounds = null;
            win.setBounds(analysisBounds);
        }
    });

    ipcMain.on("set-lang", (_e, lang) => switchLang(lang));
    ipcMain.on("toggle-always-on-top", () => toggle("alwaysOnTop"));
    ipcMain.on("toggle-compact", () => toggle("compact"));

    const controller = createSelectionController({
        fetchOsu: () => fetchCurrentOsu(TOSU_PORT),
        analyze: workerClient.analyze,
        cache: resultCache,
        onResult: (r) => hooks.emit("result", r),
        onView: (view) => {
            lastView = view;
            log(`view ${view.screen}${view.result ? ` ${view.result.kind} ${view.result.label ?? view.result.message ?? ""}` : ""}${view.reason ? ` ${view.reason}` : ""}`);
            send("view", view);
        },
    });
    setInterval(() => controller.tick(), 1000);

    let everConnected = false;
    setTimeout(() => {
        if (!everConnected && !quitting) tosuFailed(controller, () => t("app.tosu.noAnswer"));
    }, TOSU_WATCHDOG_MS);
    tosu = await launchTosu(controller);
    let lastFrameKey = null;
    tosuSocket = connectTosu({
        port: TOSU_PORT,
        onFrame: (frame) => {
            const key = `${frame.state} ${frame.checksum} ${frame.rate}`;
            if (key !== lastFrameKey) log(`frame ${key}`);
            lastFrameKey = key;
            setOsuClient(frame.client);
            controller.onFrame(frame);
        },
        onStatus: (status) => {
            if (status === "connected") everConnected = true;
            if (status === "down") setOsuClient(null);
            log(`tosu ${status}`);
            controller.onTosuStatus(status);
        },
    });
}

app.on("before-quit", async (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    try {
        tosuSocket?.close();
        overlay?.dispose();
        await tosu?.stop();
        workerClient?.dispose();
        generatorClient?.dispose();
    } finally {
        app.exit(0);
    }
});
