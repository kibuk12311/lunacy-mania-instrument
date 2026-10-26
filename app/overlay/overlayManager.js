// The in-game overlay: four small windows of their own (judgements, KPS, map NPS, key lines) over osu!, nothing injected.
// Each is transparent, frameless, always on top at the screen-saver level and click-through while you play;
// the edit mode (the hotkey or the tray) lets them be dragged and resized by their corner. They show while osu! is
// playing (and on the results screen if asked), fed by their own tosu sockets: /websocket/v2 for the judgements
// and the clock, /websocket/v2/precise for the key counters. Settings live in userData\overlay.json.
// Showing and hiding go through a gate with hysteresis (src/overlay/visibility.js): one stray frame of another state
// (song select, a score opened from the leaderboard, a reconnect) never flashes the windows.
// Interlude's plays come from the main process (onInterlude(), the lines of app/interludeReader.js) into a session of
// their own; the widgets show whichever game is playing.
// Kept up: a widget meant to be on screen that Windows minimized or hid (Win+D, minimizing the game or the app's own
// window) is put back at once, and while any is shown a light watchdog re-asserts the top-most level every
// KEEP_UP_MS (a borderless game taking focus can push itself above top-most windows).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connectTosu } from "../tosuClient.js";
import { readPlayFrame, readPreciseFrame } from "../../src/overlay/tosuData.js";
import { readInterludeFrame } from "../../src/overlay/interludeData.js";
import { createOverlaySession, LEAVE_MS } from "../../src/overlay/session.js";
import { parseManiaNotes } from "../../src/overlay/maniaNotes.js";
import { createVisibilityGate } from "../../src/overlay/visibility.js";
import {
    EDIT_HOTKEY, WIDGETS, applyPatch, hotkeyLabel, normalizeOverlaySettings, placeWidget, widgetSize,
} from "../../src/overlay/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUSH_MS = 33; // snapshots to the widget windows, about 30 a second while any is shown
const SAVE_DELAY_MS = 400;
export const KEEP_UP_MS = 1500;

export const OVERLAY_CHANNELS = {
    handle: ["overlay-get", "overlay-set"],
    on: ["overlay-edit", "overlay-scale", "overlay-open-settings"],
};

export function loadOverlaySettings(file) {
    try {
        return normalizeOverlaySettings(JSON.parse(readFileSync(file, "utf8")));
    } catch {
        return normalizeOverlaySettings(null);
    }
}

export function saveOverlaySettings(file, settings) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(settings), "utf8");
    renameSync(`${file}.tmp`, file);
}

// electron: { BrowserWindow, ipcMain, globalShortcut, screen }; headless (the smoke test): windows are never put on
// the screen, only marked shown, so their pages can still be captured.
export function createOverlay({
    electron, userData, port, t, log = () => {}, onChange = () => {}, icon, mainWindow = () => null,
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = () => performance.now(), headless = false,
    interludeNotes = async () => null, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
}) {
    const { BrowserWindow, ipcMain, globalShortcut, screen, powerMonitor } = electron;
    const file = path.join(userData, "overlay.json");
    let settings = loadOverlaySettings(file);
    let edit = false;
    let session = createOverlaySession();
    let ilSession = createOverlaySession(); // Interlude's plays
    let ilMapLoading = null;
    let ilLeaveTimer = null;
    let keepUpTimer = null;
    const watched = new WeakSet(); // the main windows whose minimize / restore are listened to
    // the session the widgets show: osu!'s while it plays, else Interlude's while it has a play or its results
    const active = () => (session.phase() === "playing" || ilSession.phase() === "idle" ? session : ilSession);
    const gate = createVisibilityGate();
    let gateTimer = null;
    const windows = new Map(); // widget → BrowserWindow
    const shown = new Map(); // widget → bool
    let settingsWin = null;
    let sockets = [];
    let pushTimer = null;
    let saveTimer = null;
    let mapLoading = null;
    let hotkeyOn = false;
    let disposed = false;

    const alive = (win) => win && !win.isDestroyed();
    const displays = () => [screen.getPrimaryDisplay(), ...screen.getAllDisplays()];

    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                saveOverlaySettings(file, settings);
            } catch (error) {
                log(`overlay settings not saved: ${error.message}`);
            }
        }, SAVE_DELAY_MS);
    }

    const configFor = (widget) => {
        const w = settings.widgets[widget];
        return { widget, style: w.style, opacity: w.opacity, scale: w.scale, show: w.show, edit, hotkey: hotkeyLabel() };
    };

    // the settings window and the main window's overlay block show the same state
    function sendSettings() {
        for (const target of [settingsWin, mainWindow()]) {
            if (alive(target)) target.webContents.send("overlay-settings", { settings, edit });
        }
    }

    // ---- tosu ----

    function loadMap(checksum) {
        if (mapLoading === checksum) return;
        mapLoading = checksum;
        fetchImpl(`http://127.0.0.1:${port}/files/beatmap/file`, { signal: AbortSignal.timeout(5000) })
            .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`status ${res.status}`))))
            .then((text) => session.setMap(checksum, parseManiaNotes(text)))
            .catch((error) => {
                log(`overlay: no map notes (${error.message})`);
                session.setMap(checksum, null);
            })
            .finally(() => { if (mapLoading === checksum) mapLoading = null; });
    }

    function connect() {
        if (sockets.length || disposed) return;
        sockets = [
            connectTosu({
                port, WebSocketImpl, path: "/websocket/v2", parse: readPlayFrame,
                onFrame: (frame) => {
                    const { mapWanted } = session.onFrame(frame, now());
                    if (mapWanted) loadMap(mapWanted);
                    updateVisibility();
                },
                // tosu gone (osu! closed, the app quitting): the play is over as far as the overlay knows
                onStatus: (status) => {
                    if (status !== "down") return;
                    session = createOverlaySession();
                    updateVisibility();
                },
            }),
            connectTosu({
                port, WebSocketImpl, path: "/websocket/v2/precise", parse: readPreciseFrame,
                onFrame: (p) => session.onPrecise(p, now()),
            }),
        ];
    }

    function disconnect() {
        for (const s of sockets) s.close();
        sockets = [];
        session = createOverlaySession();
        ilSession = createOverlaySession();
    }

    // ---- Interlude (the reader's state lines, from main) ----

    function loadInterludeMap(checksum, hash) {
        if (ilMapLoading === checksum) return;
        ilMapLoading = checksum;
        Promise.resolve().then(() => interludeNotes(hash))
            .then((parsed) => ilSession.setMap(checksum, parsed?.notes?.length ? parsed : null))
            .catch((error) => {
                log(`overlay: no Interlude notes (${error?.message})`);
                ilSession.setMap(checksum, null);
            })
            .finally(() => { if (ilMapLoading === checksum) ilMapLoading = null; });
    }

    // msg: a state line of the reader; null: the reader lost Interlude (it closed, or following it was turned off)
    function onInterlude(msg) {
        if (disposed) return;
        if (!msg || !settings.enabled) {
            if (ilSession.phase() !== "idle") ilSession = createOverlaySession();
            updateVisibility();
            return;
        }
        const frame = readInterludeFrame(msg);
        const { mapWanted } = ilSession.onFrame(frame, now());
        if (mapWanted && frame.hash) loadInterludeMap(mapWanted, frame.hash);
        // outside a play the reader writes a line only on a change: the same frame again once it has lasted, so the
        // play ends (a single odd frame in the middle of a play must last LEAVE_MS to end it)
        clearTimeout(ilLeaveTimer);
        ilLeaveTimer = null;
        if (frame.state !== "playing" && ilSession.phase() === "playing") {
            ilLeaveTimer = setTimeout(() => {
                ilLeaveTimer = null;
                if (disposed) return;
                ilSession.onFrame(frame, now());
                updateVisibility();
            }, LEAVE_MS + 20);
        }
        updateVisibility();
    }

    // ---- windows ----

    function makeWindow(widget) {
        const bounds = placeWidget(widget, settings, displays());
        const win = new BrowserWindow({
            ...bounds,
            show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
            resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
            skipTaskbar: true, focusable: edit, alwaysOnTop: true,
            title: t(`overlay.widget.${widget}`),
            webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
        });
        win.setAlwaysOnTop(true, "screen-saver");
        win.setIgnoreMouseEvents(!edit, { forward: true });
        win.setMenu?.(null);
        win.loadFile(path.join(here, "widget.html"), { query: { w: widget } });
        win.webContents.on("did-finish-load", () => {
            win.webContents.send("overlay-config", configFor(widget));
            win.webContents.send("overlay-state", active().snapshot(now()));
        });
        win.on("moved", () => {
            const [x, y] = win.getPosition();
            settings = applyPatch(settings, { widgets: { [widget]: { x, y } } });
            save();
        });
        win.on("closed", () => {
            windows.delete(widget);
            shown.delete(widget);
        });
        // Windows minimized or hid it (Win+D, the game or the app's window minimized) while it is meant to be up
        const putBack = () => setImmediate(() => keepUp(widget));
        win.on("minimize", putBack);
        win.on("hide", putBack);
        win.on("restore", putBack);
        windows.set(widget, win);
        shown.set(widget, false);
        return win;
    }

    // A widget meant to be on screen is put back if Windows took it away, and over the game again.
    function keepUp(only = null) {
        if (disposed || headless) return;
        for (const [widget, win] of windows) {
            if (only && widget !== only) continue;
            if (!shown.get(widget) || !alive(win)) continue;
            try {
                if (win.isMinimized?.()) win.restore();
                if (win.isVisible && !win.isVisible()) win.showInactive();
                win.setAlwaysOnTop(true, "screen-saver");
                win.moveTop?.();
            } catch (error) {
                log(`overlay: keep-up failed (${error?.message})`);
            }
        }
    }

    // the app's own window (pinned or not) minimized, restored or shown again: the widgets stay up, over it
    function watchMain() {
        const main = mainWindow();
        if (!alive(main) || watched.has(main)) return;
        watched.add(main);
        for (const event of ["minimize", "restore", "show", "focus"]) main.on(event, () => setImmediate(() => keepUp()));
    }

    // the play side, through the gate: "playing" that lasts and moves, or the results screen if asked
    function playOn() {
        const session = active();
        const phase = session.phase();
        const want = phase === "playing" || (phase === "results" && settings.showOnResults);
        const at = now();
        const on = gate.update({ want, advancing: phase === "results" || session.advancing(), now: at });
        clearTimeout(gateTimer);
        gateTimer = null;
        const wait = gate.pending(at);
        if (wait !== null && !disposed) gateTimer = setTimeout(updateVisibility, wait + 5);
        return on;
    }

    const wanted = (widget, play) => {
        const w = settings.widgets[widget];
        if (!w.enabled) return false;
        if (edit) return true;
        return settings.enabled && play;
    };

    function updateVisibility() {
        if (disposed) return;
        const play = playOn();
        for (const widget of WIDGETS) {
            const want = wanted(widget, play);
            let win = windows.get(widget);
            if (want && !alive(win)) win = makeWindow(widget);
            if (!alive(win) || shown.get(widget) === want) continue;
            shown.set(widget, want);
            if (headless) continue;
            if (want) {
                // the page gets the play of now before it is shown, so the last play's frame never flashes up
                win.webContents.send("overlay-state", active().snapshot(now()));
                if (win.isMinimized?.()) win.restore();
                win.showInactive();
                win.setAlwaysOnTop(true, "screen-saver");
                win.moveTop?.();
            } else {
                win.hide();
            }
        }
        const anyShown = [...shown.values()].some(Boolean);
        if (anyShown && !pushTimer) pushTimer = setInterval(push, PUSH_MS);
        if (!anyShown && pushTimer) {
            clearInterval(pushTimer);
            pushTimer = null;
        }
        if (anyShown && !keepUpTimer && !headless) {
            watchMain();
            keepUpTimer = every(() => keepUp(), KEEP_UP_MS);
        }
        if (!anyShown && keepUpTimer) {
            stopEvery(keepUpTimer);
            keepUpTimer = null;
        }
    }

    function push() {
        const snap = active().snapshot(now());
        for (const [widget, win] of windows) if (shown.get(widget) && alive(win)) win.webContents.send("overlay-state", snap);
    }

    // a style or a scale change: new size, same corner
    function reconfigure(widget) {
        const win = windows.get(widget);
        if (!alive(win)) return;
        const w = settings.widgets[widget];
        const [x, y] = win.getPosition();
        win.setBounds({ x, y, ...widgetSize(widget, w.style, w.scale) });
        win.webContents.send("overlay-config", configFor(widget));
    }

    function setEdit(on) {
        edit = Boolean(on);
        for (const [widget, win] of windows) {
            if (!alive(win)) continue;
            win.setIgnoreMouseEvents(!edit, { forward: true });
            win.setFocusable(edit);
            win.webContents.send("overlay-config", configFor(widget));
        }
        updateVisibility();
        sendSettings();
        onChange();
    }

    function syncHotkey() {
        const want = settings.enabled && !disposed;
        if (want && !hotkeyOn) {
            hotkeyOn = globalShortcut.register(EDIT_HOTKEY, () => setEdit(!edit));
            if (!hotkeyOn) log(`overlay: hotkey ${EDIT_HOTKEY} is taken`);
        } else if (!want && hotkeyOn) {
            globalShortcut.unregister(EDIT_HOTKEY);
            hotkeyOn = false;
        }
    }

    function apply(patch) {
        const before = settings;
        settings = applyPatch(settings, patch);
        save();
        if (settings.enabled) connect();
        else if (before.enabled) disconnect();
        syncHotkey();
        for (const widget of WIDGETS) {
            const a = before.widgets[widget];
            const b = settings.widgets[widget];
            if (a.style !== b.style || a.scale !== b.scale || a.opacity !== b.opacity || JSON.stringify(a.show) !== JSON.stringify(b.show)) {
                reconfigure(widget);
            }
        }
        updateVisibility();
        sendSettings();
        if (before.enabled !== settings.enabled || WIDGETS.some((w) => before.widgets[w].enabled !== settings.widgets[w].enabled)) onChange();
        return settings;
    }

    function openSettings() {
        if (alive(settingsWin)) {
            settingsWin.show();
            settingsWin.focus();
            return settingsWin;
        }
        settingsWin = new BrowserWindow({
            width: 600, height: 820, minWidth: 420, minHeight: 360, show: !headless,
            title: t("overlay.window.title"), backgroundColor: "#14121c", autoHideMenuBar: true, icon,
            webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
        });
        settingsWin.setMenu?.(null);
        settingsWin.loadFile(path.join(here, "settings.html"));
        settingsWin.on("page-title-updated", (e) => e.preventDefault());
        settingsWin.on("closed", () => { settingsWin = null; });
        return settingsWin;
    }

    // ---- IPC (the widget windows and the settings window share app/overlay/preload.cjs) ----

    ipcMain.handle("overlay-get", () => ({ settings, edit }));
    ipcMain.handle("overlay-set", (_e, patch) => ({ settings: apply(patch), edit }));
    ipcMain.on("overlay-edit", (_e, on) => setEdit(on));
    ipcMain.on("overlay-open-settings", () => openSettings());
    ipcMain.on("overlay-scale", (_e, request) => {
        const widget = request?.widget;
        if (!WIDGETS.includes(widget) || !Number.isFinite(request?.scale)) return;
        settings = applyPatch(settings, { widgets: { [widget]: { scale: request.scale } } });
        save();
        reconfigure(widget);
        sendSettings();
    });

    if (settings.enabled) connect();
    syncHotkey();
    // waking from sleep or a display change can drop the top-most level of the widgets
    powerMonitor?.on?.("resume", () => keepUp());
    screen?.on?.("display-metrics-changed", () => keepUp());
    screen?.on?.("display-added", () => keepUp());

    return {
        trayItems: () => [{
            label: t("overlay.tray.menu"),
            submenu: [
                { label: t("overlay.tray.enabled"), type: "checkbox", checked: settings.enabled, click: () => apply({ enabled: !settings.enabled }) },
                { label: t("overlay.tray.edit", { hotkey: hotkeyLabel() }), type: "checkbox", checked: edit, click: () => setEdit(!edit) },
                { type: "separator" },
                ...WIDGETS.map((widget) => ({
                    label: t(`overlay.widget.${widget}`), type: "checkbox", checked: settings.widgets[widget].enabled,
                    click: () => apply({ widgets: { [widget]: { enabled: !settings.widgets[widget].enabled } } }),
                })),
                { type: "separator" },
                { label: t("overlay.tray.settings"), click: () => openSettings() },
            ],
        }],
        openSettings,
        onInterlude,
        keepUp: () => keepUp(),
        setEdit,
        apply,
        settings: () => settings,
        // the language changed: every overlay page is built again in it
        reload() {
            for (const win of windows.values()) if (alive(win)) win.webContents.reload();
            if (alive(settingsWin)) {
                settingsWin.setTitle(t("overlay.window.title"));
                settingsWin.webContents.reload();
            }
        },
        // for the smoke test and the tests: the window of a widget, and whether it is meant to be on screen
        windowFor: (widget) => windows.get(widget) ?? null,
        isShown: (widget) => shown.get(widget) === true,
        settingsWindow: () => settingsWin,
        dispose() {
            disposed = true;
            clearTimeout(gateTimer);
            clearInterval(pushTimer);
            pushTimer = null;
            clearTimeout(ilLeaveTimer);
            if (keepUpTimer) stopEvery(keepUpTimer);

            keepUpTimer = null;
            if (saveTimer) {
                clearTimeout(saveTimer);
                try { saveOverlaySettings(file, settings); } catch { /* quitting anyway */ }
            }
            for (const s of sockets) s.close();
            sockets = [];
            if (hotkeyOn) globalShortcut.unregister(EDIT_HOTKEY);
            hotkeyOn = false;
            for (const win of windows.values()) if (alive(win)) win.destroy();
            if (alive(settingsWin)) settingsWin.destroy();
        },
    };
}
