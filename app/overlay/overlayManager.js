// The in-game overlay: small windows of their own (judgements, KPS, map NPS, key lines, dan, the map panel) over osu!,
// nothing injected.
// Each is transparent, frameless, always on top at the screen-saver level and click-through while you play;
// the edit mode (the hotkey or the tray) lets them be dragged and resized by their corner. They show during a play, in
// a pause and on the results screen, as asked, fed by their own tosu sockets: /websocket/v2 for the judgements
// and the clock, /websocket/v2/precise for the key counters. Settings live in userData\overlay.json.
// Showing and hiding go through a gate with hysteresis (src/overlay/visibility.js): one stray frame of another state
// (song select, a score opened from the leaderboard, a reconnect) never flashes the windows. Each page is told whether
// it is shown ("overlay-visible") and draws nothing while hidden; snapshots go only to shown ones, and only new ones
// unless a play runs.
// Interlude's plays come from the main process (onInterlude(), the lines of app/interludeReader.js) into a session of
// their own; the widgets show whichever game is playing.
// Kept up: a widget meant to be on screen that Windows minimized or hid (Win+D, minimizing the game or the app's own
// window) is put back at once, and while any is shown a light watchdog re-asserts the top-most level every
// KEEP_UP_MS (a borderless game taking focus can push itself above top-most windows).
// The Dan widget's map data (app/overlay/danSource.js: the card's analysis per map and rate, the map's overall dan;
// the player's skill from the main window, whether the local profile records) goes with its config, sent again only
// when it changes.
// osu! stable's real keys (keyReader: app/keyReader.js, the native/key-reader helper): while a stable mania play goes
// on and the keyboard setting is on, the helper is told the play's lane keys and only those (the keys set by hand for
// that key count, else the selected layout in osu!'s own cfg, app/overlay/osuConfig.js, else osu!'s defaults); their
// presses go into the play's session (KPS, key lines). Between plays it listens to nothing; it is stopped when the
// overlay or the setting is turned off, when tosu goes (osu! closed) and with the app. lazer and Interlude never use it.
// While the settings window is open the widget windows keep the size they had when it opened: a new scale, or a style
// or lines that would change that size, show only in its previews (a widget growing there would cover the window being
// used). They take it when it closes, when they or that window are moved so that the new size stays clear of it, or at
// once when resized by their own corner. And the widgets are top-most: the settings window goes above them while it is
// in use (focused, or a widget in the edit mode is), so none ever covers it, and sinks again when another program is
// used (it must not stay over the game). A widget let go after a drag snaps to the edges of its screen and to the drag
// grid, as set; one sitting on the right or bottom edge stays on it when it grows or shrinks, and that spot is saved.
// The map panel (the "map" widget, src/overlay/mapInfo.js): the map of the play, or the map selected in song select
// (osu! through tosu, Interlude through its reader), so it shows there too unless told not to, through a gate of its
// own. It takes no part in the 30-a-second snapshots: its page is sent a state only when something on it changed, and
// the progress at most every PROGRESS_MS. Its picture is fetched once per background, a moment after the selection
// settles, and shrunk here, so the page gets a small JPEG and reaches for nothing itself. Its dan is the Dan widget's
// (a selected map's only after it has stayed selected for SELECT_DAN_MS). tosu outlives osu!: closed in song select, it
// stays connected and goes silent, so frames gone for FRAMES_GONE_MS there take the map away. Interlude's reader writes
// only on a change, so its last line stands (even with the overlay off) until it says Interlude is gone. A map gone from
// under the panel (song select left for the main menu) leaves it showing what it has until its gate lets it go.
// The overlay's pages (the widgets, the settings window) speak the overlay's own language when one is set, else the
// app's; the tray stays in the app's.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { connectTosu } from "../tosuClient.js";
import { readPlayFrame, readPreciseFrame } from "../../src/overlay/tosuData.js";
import { readInterludeFrame } from "../../src/overlay/interludeData.js";
import { createOverlaySession, LEAVE_MS } from "../../src/overlay/session.js";
import { getLang } from "../../src/i18n/i18n.js";
import OVERLAY_TEXTS from "../../src/i18n/messages/overlay.js";
import { parseManiaNotes } from "../../src/overlay/maniaNotes.js";
import { createVisibilityGate } from "../../src/overlay/visibility.js";
import { buildDanPayload, cleanSkill, danKey, danStateOf } from "../../src/overlay/dan.js";
import { mapState } from "../../src/overlay/mapInfo.js";
import { createDanSource } from "./danSource.js";
import { createOsuConfigReader } from "./osuConfig.js";
import { OSU_DEFAULT_LAYOUTS, MAX_KEYS, laneVks, selectedLayout } from "../../src/overlay/osuKeys.js";
import {
    EDIT_HOTKEY, WIDGETS, applyPatch, hotkeyLabel, normalizeOverlaySettings, overlaps, overlayLang, placeWidget,
    resizeAnchored, sessionOptions, sizeOf, snapPosition, withinScreen,
} from "../../src/overlay/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUSH_MS = 33; // snapshots to the widget windows, about 30 a second while any is shown
const SAVE_DELAY_MS = 400;
export const KEEP_UP_MS = 1500;
export const PROGRESS_MS = 500; // the map panel's progress, this often at most
export const SELECT_DAN_MS = 1200; // a map stays selected this long before its dan is worked out for the map panel
const PICTURE_DELAY_MS = 250; // a map only passed by in song select is not fetched
const PICTURE_MAX_BYTES = 30 * 1024 * 1024;
const PICTURE_WIDTH = 640;
const SELECT_HOLD_MS = 1800; // going from song select into a play, the map panel stays until the play's own gate opens
export const FRAMES_GONE_MS = 2500; // tosu sends frames every 100 ms or so: this long without one in song select, osu! is gone

// a map's background → a small JPEG as a data URL, or null (no picture, not one Electron can read)
export function shrinkPicture(bytes, nativeImage) {
    if (!bytes?.length || !nativeImage) return null;
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return null;
    const small = image.getSize().width > PICTURE_WIDTH ? image.resize({ width: PICTURE_WIDTH, quality: "good" }) : image;
    return `data:image/jpeg;base64,${small.toJPEG(72).toString("base64")}`;
}

export const OVERLAY_CHANNELS = {
    handle: ["overlay-get", "overlay-set", "overlay-keys"],
    on: ["overlay-edit", "overlay-scale", "overlay-open-settings", "overlay-profile"],
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

// electron: { BrowserWindow, ipcMain, globalShortcut, screen, nativeImage }; headless (the smoke test): windows are
// never put on the screen, only marked shown, so their pages can still be captured.
// The Dan widget: danAnalyze({ text, rate, result }) → { result } (danSource.js makeDanAnalyzer; without it
// the widget says there is no estimate), interludeText(hash) → the .osu text of an Interlude chart, recording() →
// whether the local profile records plays.
// The keyboard: keyReader({ onKey, onState }) → a reader (app/keyReader.js createKeyReader: listen(vks), idle(),
// stop()); without it no key is ever read. osuConfig({ gameDir, profile }) → { file, layouts } | null (osu!'s cfg).
// The map panel: interludeBackground(hash) → the path of an Interlude chart's background, or null.
export function createOverlay({
    electron, userData, port, t, log = () => {}, onChange = () => {}, icon, mainWindow = () => null,
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = () => performance.now(), headless = false,
    interludeNotes = async () => null, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
    danAnalyze = null, interludeText = async () => null, recording = async () => false,
    keyReader = null, osuConfig = createOsuConfigReader(), interludeBackground = async () => null,
}) {
    const { BrowserWindow, ipcMain, globalShortcut, screen, powerMonitor, nativeImage } = electron;
    const file = path.join(userData, "overlay.json");
    let settings = loadOverlaySettings(file);
    let edit = false;
    // a session with the widgets' settings (the graphs' length and smoothing, the key lines' speed)
    const newSession = () => createOverlaySession(sessionOptions(settings));
    let session = newSession();
    let ilSession = newSession(); // Interlude's plays
    let frozen = null; // widget → the shape its window keeps while the settings window is open (shapeOf)
    let settingsUp = false; // the settings window is held above the widgets
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
    let lastPush = null; // the last snapshot pushed, as JSON
    let saveTimer = null;
    let mapLoading = null;
    let hotkeyOn = false;
    let disposed = false;
    // the Dan widget
    let mapText = null; // { checksum, text } of the osu! map last fetched from tosu
    let skill = null; // the player's skill from the main window (cleanSkill), null without a profile
    let skillVersion = 0;
    let recordingOn = false;
    let recordingKey = null; // the map key recording() was last asked for
    let danSig = null; // what the payload sent was built from
    let danPayload = null;
    const dan = createDanSource({
        analyze: danAnalyze,
        log,
        onChange: () => setImmediate(() => {
            syncDan();
            pushMap();
        }),
    });
    // the map panel
    const mapOf = { osu: null, il: null }; // per game: { info, selecting, liveMs, at (when it last changed) }
    const selectGate = createVisibilityGate({ showAfterMs: 300, hideAfterMs: SELECT_HOLD_MS, trustAfterMs: 300 });
    let selectTimer = null;
    let framesTimer = null;
    let picture = { key: null, url: null, timer: null };
    let pictureToken = 0;
    let mapDanAsk = { key: null, timer: null };
    let mapPush = { sig: null, image: null, progress: null, elapsedMs: null, at: -Infinity };
    // the keyboard
    let keys = null; // the reader, once a play wanted it (until it is stopped)
    let keysFor = null; // what it listens to: { sig, keys, names, source, file, byVk }
    let keysPending = null; // the sig being worked out
    let keysToken = 0;
    let keysState = null; // the reader's last state, for the settings window
    let osu = { client: null, gameDir: null, profile: null }; // from tosu's frames
    let gameDirAsked = false; // tosu's /json/v2 asked once for the game folder (frames without it)
    let lastKeys = null; // the key count of the last stable play (the settings window shows its layout first)

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

    // the overlay's language (its own, else the app's) and its texts in it, for the windows' titles
    const lang = () => overlayLang(settings.lang, getLang());
    function tOverlay(key, params = {}) {
        const value = OVERLAY_TEXTS[key]?.[lang()];
        if (lang() === getLang() || typeof value !== "string") return t(key, params);
        return value.replace(/\{(\w+)\}/g, (slot, name) => (name in params ? String(params[name]) : slot));
    }

    // what sets the size of a widget's window
    const shapeOf = (w) => ({ scale: w.scale, style: w.style, show: w.show, rows: w.rows ?? null });
    const sameShape = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // a widget as its window is built: its settings, or while the settings window is open with the shape it keeps
    function liveWidget(widget) {
        const w = settings.widgets[widget];
        const held = frozen?.get(widget);
        return held ? { ...w, ...held } : w;
    }
    // a new size waits for this widget (it is set, but its window keeps the old one)
    const pending = (widget) => Boolean(frozen) && !sameShape(frozen.get(widget), shapeOf(settings.widgets[widget]));

    // look: the widget's settings (its font, colours, opacities, the judgements shown …); options: what the made-up
    // numbers of the edit mode follow (the graphs' length and smoothing, the key lines' speed); lang: the setting
    const configFor = (widget) => {
        const w = liveWidget(widget);
        const config = {
            widget, style: w.style, scale: w.scale, show: w.show, look: w, lang: settings.lang,
            options: sessionOptions(settings), edit, hotkey: hotkeyLabel(),
        };
        return widget === "dan" ? { ...config, dan: danPayload } : config;
    };

    // the settings window and the main window's overlay block show the same state; held: the widgets whose new size
    // waits for the settings window
    const statePayload = () => ({ settings, edit, reader: keysState?.state ?? null, held: WIDGETS.filter(pending) });
    function sendSettings() {
        for (const target of [settingsWin, mainWindow()]) {
            if (alive(target)) target.webContents.send("overlay-settings", statePayload());
        }
    }

    // ---- tosu ----

    function loadMap(checksum) {
        if (mapLoading === checksum) return;
        mapLoading = checksum;
        fetchImpl(`http://127.0.0.1:${port}/files/beatmap/file`, { signal: AbortSignal.timeout(5000) })
            .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`status ${res.status}`))))
            .then((text) => {
                mapText = { checksum, text };
                session.setMap(checksum, parseManiaNotes(text));
                syncDan();
                syncKeys();
            })
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
                    osu = {
                        client: frame.client ?? osu.client,
                        gameDir: frame.gameDir ?? osu.gameDir,
                        profile: frame.profile ?? osu.profile,
                    };
                    noteMap("osu", frame);
                    watchFrames();
                    const { mapWanted } = session.onFrame(frame, now());
                    if (mapWanted) loadMap(mapWanted);
                    updateVisibility();
                    syncDan();
                    syncKeys();
                    syncMap();
                },
                // tosu gone (osu! closed, the app quitting): the play is over as far as the overlay knows
                onStatus: (status) => {
                    if (status !== "down") return;
                    session = newSession();
                    osu = { client: null, gameDir: null, profile: null };
                    mapOf.osu = null;
                    gameDirAsked = false;
                    dropKeys();
                    updateVisibility();
                    syncMap();
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
        session = newSession();
        ilSession = newSession();
        mapOf.osu = null;
        dropKeys();
    }

    // ---- the keyboard (osu! stable's lane keys) ----

    // the keys are read only for a widget that shows them (the KPS or the key lines)
    const keyboardOn = () => !disposed && settings.enabled && settings.keyboard.enabled && typeof keyReader === "function"
        && (settings.widgets.kps.enabled || settings.widgets.keys.enabled);

    // the game folder: tosu's frames say it; an older tosu's are asked once at /json/v2
    async function gameDir() {
        if (osu.gameDir || gameDirAsked) return osu.gameDir;
        gameDirAsked = true;
        try {
            const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(3000) });
            const json = JSON.parse(await res.text());
            const dir = json?.folders?.game;
            if (typeof dir === "string" && dir) osu = { ...osu, gameDir: dir, profile: osu.profile ?? json?.profile?.name ?? null };
        } catch {
            // no answer (tosu not up yet): asked again next time; meanwhile osu!'s defaults, or the keys set by hand
            gameDirAsked = false;
        }
        return osu.gameDir;
    }

    async function readCfg() {
        const dir = await gameDir();
        if (!dir) return null;
        try {
            return await osuConfig({ gameDir: dir, profile: osu.profile });
        } catch {
            return null;
        }
    }

    // the lane keys of a key count: { names, source: "manual" | "osu" | "osuDefault" | "default", file } or null.
    // cfg: osu!'s cfg read (undefined: read it now)
    async function laneKeys(n, cfg) {
        const manual = settings.keyboard.keys[n];
        if (manual) return { names: manual, source: "manual", file: null };
        const read = cfg === undefined ? await readCfg() : cfg;
        const fromOsu = read ? selectedLayout(read.layouts, n) : null;
        if (fromOsu) return { names: fromOsu, source: "osu", file: path.basename(read.file) };
        const def = OSU_DEFAULT_LAYOUTS[n];
        // osu!'s cfg read but no layout of this key count in it: osu! plays it with its default
        if (def) return { names: [...def], source: read ? "osuDefault" : "default", file: read ? path.basename(read.file) : null };
        return null;
    }

    function ensureReader() {
        keys ??= keyReader({
            onKey,
            onState: (s) => {
                keysState = s;
                if (s.state === "crashed" || s.state === "stopped" || s.state === "error") session.keysGone(now());
                if (s.state === "missing" || s.state === "error" || s.state === "ready") sendSettings();
            },
        });
        return keys;
    }

    // a key of the set listened to (app/keyReader.js): its lane into the play
    function onKey({ vk, down, at }) {
        const col = keysFor?.byVk?.get(vk);
        if (col === undefined) return;
        session.onKey({ col, down, at, keys: keysFor.keys });
    }

    // nothing listened to (the reader stays, idle)
    function idleKeys() {
        keysToken += 1;
        keysPending = null;
        if (!keysFor) return;
        keysFor = null;
        keys?.idle();
        session.keysGone(now());
    }

    // the reader goes (→ a promise of its exit)
    function dropKeys() {
        idleKeys();
        if (!keys) return Promise.resolve();
        const k = keys;
        keys = null;
        keysState = null;
        return Promise.resolve(k.stop()).catch(() => {});
    }

    // After every frame and change: an osu! stable mania play with its key count known → its lane keys listened to;
    // anything else → none.
    function syncKeys() {
        if (!keyboardOn()) {
            dropKeys();
            return;
        }
        const mania = session.mode() === 3 || session.mode() === null;
        // autoplay, spectating, someone's replay: the viewer's keys are no part of it (the map's judgements are)
        const own = session.phase() === "playing" && !session.watching();
        const n = own && osu.client !== "lazer" && mania ? session.playKeys() : null;
        if (!n) {
            idleKeys();
            return;
        }
        lastKeys = n;
        const sig = `${session.map().checksum}|${n}|${JSON.stringify(settings.keyboard.keys[n] ?? null)}`;
        if (keysFor?.sig === sig || keysPending === sig) return;
        keysPending = sig;
        const token = ++keysToken;
        laneKeys(n).then((lane) => {
            if (token !== keysToken || !keyboardOn()) return;
            keysPending = null;
            // a lane osu! has no key for (an unbound one) is not listened to; the others are
            const vks = lane ? laneVks(lane.names) : null;
            if (!vks) {
                // no layout known for this key count: the lines stay the map's
                if (keysFor) session.keysGone(now());
                keysFor = { sig, keys: n, names: null, source: null, byVk: new Map() };
                keys?.idle();
                return;
            }
            const byVk = new Map();
            vks.forEach((vk, col) => { if (vk !== null && !byVk.has(vk)) byVk.set(vk, col); });
            keysFor = { sig, keys: n, names: lane.names, source: lane.source, file: lane.file, byVk };
            // the source only: the keys themselves never go into the log
            log(`overlay: keyboard: ${n}K lanes from ${lane.source}`);
            ensureReader().listen([...byVk.keys()]);
        }, (error) => {
            if (token === keysToken) keysPending = null;
            log(`overlay: keyboard: no lane keys (${error?.message})`);
        });
    }

    // the settings window: the keys of a key count as they are now, where they come from, and the reader's state
    async function keysInfo(n) {
        const count = Number.isInteger(n) && n >= 1 && n <= MAX_KEYS ? n : (lastKeys ?? 4);
        const cfg = await readCfg();
        const osuNames = cfg ? (selectedLayout(cfg.layouts, count) ?? OSU_DEFAULT_LAYOUTS[count] ?? null) : null;
        const effective = await laneKeys(count, cfg);
        return {
            keys: count,
            enabled: settings.keyboard.enabled,
            found: Boolean(cfg), // osu!'s cfg was read
            file: cfg ? path.basename(cfg.file) : null,
            osu: osuNames ? [...osuNames] : null,
            manual: settings.keyboard.keys[count] ?? null,
            effective,
            reader: keysState?.state ?? null,
        };
    }

    // ---- the Dan widget ----

    // the .osu text of a play's map: Interlude's library chart, or the osu! map tosu serves (the one being played)
    async function danText(checksum) {
        if (checksum.startsWith("interlude:")) return interludeText(checksum.slice("interlude:".length));
        if (mapText?.checksum === checksum) return mapText.text;
        const res = await fetchImpl(`http://127.0.0.1:${port}/files/beatmap/file`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const text = await res.text();
        // tosu answers for what is selected now: still this play's map, or the one the map panel shows?
        if (active().map().checksum !== checksum && mapSource()?.info?.checksum !== checksum) throw new Error("another map by now");
        mapText = { checksum, text };
        return text;
    }

    // The map of the play shown (or its results) → its dan worked out once, and the payload sent to the Dan widget
    // when what it is built from changed (another map or rate, the analysis came, the profile, the recording setting).
    function syncDan() {
        if (disposed || !(settings.widgets.dan.enabled || mapDanWanted())) return;
        const { checksum, rate, mode } = active().map();
        if (!checksum) return;
        const key = danKey(checksum, rate);
        const mania = mode === 3 || mode === null;
        if (mania) dan.want(checksum, rate, { text: () => danText(checksum) });
        if (recordingKey !== key) {
            recordingKey = key;
            Promise.resolve().then(recording).then((on) => {
                if (Boolean(on) === recordingOn || disposed) return;
                recordingOn = Boolean(on);
                syncDan();
            }, () => {});
        }
        const sig = `${key}|${mode}|${dan.get(key)?.version ?? 0}|${skillVersion}|${recordingOn}`;
        if (sig === danSig) return;
        danSig = sig;
        danPayload = buildDanPayload({ checksum, rate, mode, entry: dan.get(key), skill, recording: recordingOn });
        const win = windows.get("dan");
        if (alive(win)) win.webContents.send("overlay-config", configFor("dan"));
    }

    // the player's profile in use in the main window (the picks tab's source): { skill } or null
    function setProfile(p) {
        const next = cleanSkill(p?.skill);
        if (JSON.stringify(next) === JSON.stringify(skill)) return;
        skill = next;
        skillVersion += 1;
        syncDan();
    }

    // ---- the map panel ----

    const mapDanWanted = () => settings.widgets.map.enabled && settings.widgets.map.show.dan;

    // what a frame says of a game's map
    function noteMap(source, frame) {
        const before = mapOf[source];
        const selecting = frame.selecting === true;
        const same = before && before.info?.checksum === frame.map?.checksum && before.selecting === selecting;
        mapOf[source] = { info: frame.map ?? null, selecting, liveMs: frame.liveMs ?? null, at: same ? before.at : now() };
    }

    // the game whose map the panel shows: the one playing (or on its results), else the one choosing a map; both
    // choosing: the one that changed last
    function mapSource() {
        if (active() === ilSession && ilSession.phase() !== "idle") return mapOf.il;
        if (session.phase() !== "idle") return mapOf.osu;
        const [a, b] = [mapOf.osu, mapOf.il].map((m) => (m?.selecting && m.info ? m : null));
        return a && b ? (a.at >= b.at ? a : b) : a ?? b;
    }

    // the panel up on its gate's hold with no map left to show: it stays as it is until it goes (no empty card)
    const mapLeaving = () => !mapSource() && shown.get("map") === true && (gate.visible() || selectGate.visible());

    // osu! closed in song select: tosu says nothing more, its socket stays open
    function watchFrames() {
        clearTimeout(framesTimer);
        framesTimer = mapOf.osu?.selecting ? setTimeout(() => {
            mapOf.osu = null;
            settleMap();
        }, FRAMES_GONE_MS) : null;
    }

    // the map panel's dan: { state, numeric } (src/overlay/dan.js's states)
    function mapDanOf(info) {
        if (!info?.checksum || !mapDanWanted()) return null;
        if (info.mode !== 3 && info.mode !== null) return { state: "notMania" };
        const entry = dan.get(danKey(info.checksum, info.rate));
        if (entry?.state === "failed") return { state: "none" };
        const state = danStateOf(entry?.result ?? null);
        return state === "ok" ? { state, numeric: entry.result.numeric } : { state };
    }

    function mapStateNow() {
        const cur = mapSource();
        const info = cur?.info ?? null;
        return mapState(info, { phase: active().phase(), liveMs: cur?.liveMs ?? null, dan: mapDanOf(info) });
    }

    // A new state for the panel's page, when something on it changed; the progress alone no more often than
    // PROGRESS_MS. force: the page has nothing yet. The picture goes along only when it changed.
    function pushMap(force = false) {
        const win = windows.get("map");
        if (disposed || !alive(win) || !shown.get("map") || (!force && mapLeaving())) return;
        const { progress, elapsedMs, ...rest } = mapStateNow();
        const sig = JSON.stringify(rest);
        const at = now();
        const news = force || sig !== mapPush.sig || picture.url !== mapPush.image;
        const moved = progress !== mapPush.progress || elapsedMs !== mapPush.elapsedMs;
        if (!news && !(moved && at - mapPush.at >= PROGRESS_MS)) return;
        const state = { ...rest, progress, elapsedMs };
        if (force || picture.url !== mapPush.image) state.image = picture.url;
        mapPush = { sig, image: picture.url, progress, elapsedMs, at };
        win.webContents.send("overlay-state", state);
    }

    async function loadPicture(info) {
        if (info.checksum?.startsWith("interlude:")) {
            const file = await interludeBackground(info.picture);
            if (!file || (await stat(file)).size > PICTURE_MAX_BYTES) return null;
            return shrinkPicture(await readFile(file), nativeImage);
        }
        const res = await fetchImpl(`http://127.0.0.1:${port}/files/beatmap/background`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        return bytes.length > PICTURE_MAX_BYTES ? null : shrinkPicture(bytes, nativeImage);
    }

    // the picture of the map shown, fetched once per background (the old one stays until the new one is in)
    function syncPicture(info) {
        const key = settings.widgets.map.show.background ? info?.picture ?? null : null;
        if (key === picture.key) return;
        clearTimeout(picture.timer);
        const token = ++pictureToken;
        picture = { key, url: key ? picture.url : null, timer: null };
        if (!key) return;
        picture.timer = setTimeout(() => {
            loadPicture(info).catch((error) => {
                log(`overlay: no map picture (${error?.message})`);
                return null;
            }).then((url) => {
                if (token !== pictureToken) return;
                picture.url = url;
                pushMap();
            });
        }, PICTURE_DELAY_MS);
    }

    // a map being chosen: its dan once it has stayed selected for a moment (a play's comes through syncDan)
    function syncMapDan(cur) {
        const info = cur?.info;
        const wanted = info?.checksum && cur.selecting && mapDanWanted() && (info.mode === 3 || info.mode === null);
        const key = wanted ? danKey(info.checksum, info.rate) : null;
        if (key === mapDanAsk.key) return;
        clearTimeout(mapDanAsk.timer);
        mapDanAsk = {
            key,
            timer: key ? setTimeout(() => dan.want(info.checksum, info.rate, { text: () => danText(info.checksum) }), SELECT_DAN_MS) : null,
        };
    }

    // after every frame and change
    function syncMap() {
        if (disposed) return;
        const cur = settings.enabled && settings.widgets.map.enabled ? mapSource() : null;
        syncMapDan(cur);
        if (mapLeaving()) return;
        syncPicture(cur?.info ?? null);
        pushMap();
    }

    // a gate's moment came with no frame to bring it
    function settleMap() {
        updateVisibility();
        syncMap();
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
        const frame = msg ? readInterludeFrame(msg) : null;
        // noted with the overlay off too: this line may be the last for a long time, and the overlay may come back on
        if (frame) noteMap("il", frame);
        else mapOf.il = null;
        if (!frame || !settings.enabled) {
            if (ilSession.phase() !== "idle") ilSession = newSession();
            updateVisibility();
            syncMap();
            return;
        }
        const { mapWanted } = ilSession.onFrame(frame, now());
        if (mapWanted && frame.hash) loadInterludeMap(mapWanted, frame.hash);
        syncDan();
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
        syncMap();
    }

    // ---- windows ----

    function makeWindow(widget) {
        const bounds = placeWidget(widget, { ...settings, widgets: { ...settings.widgets, [widget]: liveWidget(widget) } }, displays());
        const win = new BrowserWindow({
            ...bounds,
            show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
            resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
            skipTaskbar: true, focusable: edit, alwaysOnTop: true,
            title: tOverlay(`overlay.widget.${widget}`),
            webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
        });
        win.setAlwaysOnTop(true, "screen-saver");
        win.setIgnoreMouseEvents(!edit, { forward: true });
        win.setMenu?.(null);
        win.loadFile(path.join(here, "widget.html"), { query: { w: widget } });
        win.webContents.on("did-finish-load", () => {
            win.webContents.send("overlay-config", configFor(widget));
            if (widget === "map") pushMap(true);
            else win.webContents.send("overlay-state", active().snapshot(now()));
            win.webContents.send("overlay-visible", shown.get(widget) === true);
        });
        // let go after a drag: onto the grid and the screen's edges (as set), and kept there
        win.on("moved", () => {
            const [x, y] = win.getPosition();
            const { width, height } = withinScreen({ x, y, ...sizeOf(widget, liveWidget(widget)) }, displays());
            const to = snapPosition({ x, y, width, height }, displays(), settings);
            if (to.x !== x || to.y !== y) win.setPosition(to.x, to.y);
            settings = applyPatch(settings, { widgets: { [widget]: to } });
            save();
            releaseClear();
        });
        // clicked in the edit mode, Windows raises it: the settings window goes back above it
        win.on("focus", () => liftSettings());
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
        liftSettings();
    }

    // the app's own window (pinned or not) minimized, restored or shown again: the widgets stay up, over it
    function watchMain() {
        const main = mainWindow();
        if (!alive(main) || watched.has(main)) return;
        watched.add(main);
        for (const event of ["minimize", "restore", "show", "focus"]) main.on(event, () => setImmediate(() => keepUp()));
    }

    // the play side, through the gate: as asked for a play that lasts and moves, for a pause and for the results screen
    function playOn() {
        const session = active();
        const phase = session.phase();
        const at = now();
        const playing = phase === "playing";
        // a pause (osu!'s clock standing, Interlude's word) matters only when it is wanted otherwise than the play
        const watchPause = playing && settings.showInPlay !== settings.showInPause;
        const paused = watchPause && session.paused(at);
        const want = playing ? (paused ? settings.showInPause : settings.showInPlay) : phase === "results" && settings.showOnResults;
        // a clock standing is no sign of life, but in a pause wanted on screen it needs none
        const on = gate.update({ want, advancing: phase === "results" || paused || session.advancing(), now: at });
        clearTimeout(gateTimer);
        gateTimer = null;
        let wait = gate.pending(at);
        // the clock standing still turns into a pause with no frame coming: looked at again then
        const pauseIn = watchPause && !paused ? session.pauseIn(at) : null;
        if (pauseIn !== null) wait = wait === null ? pauseIn : Math.min(wait, pauseIn);
        if (wait !== null && !disposed) gateTimer = setTimeout(settleMap, wait + 5);
        return on;
    }

    // the map panel while a map is being chosen, through a gate of its own
    function selectOn() {
        const w = settings.widgets.map;
        const at = now();
        const cur = mapSource();
        const want = settings.enabled && w.enabled && w.inSelect && cur?.selecting === true && Boolean(cur.info);
        const on = selectGate.update({ want, advancing: true, now: at });
        clearTimeout(selectTimer);
        selectTimer = null;
        const wait = selectGate.pending(at);
        if (wait !== null && !disposed) selectTimer = setTimeout(settleMap, wait + 5);
        return on;
    }

    const wanted = (widget, play, select) => {
        const w = settings.widgets[widget];
        if (!w.enabled) return false;
        if (edit) return true;
        return settings.enabled && (play || (widget === "map" && select));
    };

    function updateVisibility() {
        if (disposed) return;
        const play = playOn();
        const select = selectOn();
        let changed = false;
        for (const widget of WIDGETS) {
            const want = wanted(widget, play, select);
            let win = windows.get(widget);
            if (want && !alive(win)) win = makeWindow(widget);
            if (!alive(win) || shown.get(widget) === want) continue;
            shown.set(widget, want);
            changed = true;
            // the page gets the play of now before it is shown, so the last play's frame never flashes up; it draws
            // only while it is meant to be on screen (a hidden window would go on painting at the screen's rate)
            if (want && widget === "map") pushMap(true);
            else if (want) win.webContents.send("overlay-state", active().snapshot(now()));
            win.webContents.send("overlay-visible", want);
            if (headless) continue;
            if (want) {
                if (win.isMinimized?.()) win.restore();
                win.showInactive();
                win.setAlwaysOnTop(true, "screen-saver");
                win.moveTop?.();
            } else {
                win.hide();
            }
        }
        if (changed) liftSettings();
        const anyShown = [...shown.values()].some(Boolean);
        // the map panel takes no snapshots (pushMap)
        const snapshots = [...shown].some(([widget, on]) => on && widget !== "map");
        if (snapshots && !pushTimer) pushTimer = setInterval(push, PUSH_MS);
        if (!snapshots && pushTimer) {
            clearInterval(pushTimer);
            pushTimer = null;
            lastPush = null;
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
        // the same snapshot again (a results screen, a pause: the clock stands) is not sent: it would only be drawn again.
        // A running play's still is: when its frames stop for a moment the session's clock runs on 300 ms and stands
        // there, and the page runs each snapshot's clock on from when it came (render.js clockAt), so without new ones
        // the key lines would run on another 300 ms past the last frame and then jump back
        const sig = JSON.stringify(snap);
        if (sig === lastPush && !snap.running) return;
        lastPush = sig;
        for (const [widget, win] of windows) if (widget !== "map" && shown.get(widget) && alive(win)) win.webContents.send("overlay-state", snap);
    }

    // a style, a scale or a look changed: the size it has now (the same corner, or the same edge of the screen it
    // sits on, and then that new spot is saved: only a drag tells "moved"), and its config
    function reconfigure(widget) {
        const win = windows.get(widget);
        if (!alive(win)) return;
        const size = sizeOf(widget, liveWidget(widget));
        const [x, y] = win.getPosition();
        const now = win.getBounds?.() ?? { x, y, width: null, height: null };
        if (now.width !== size.width || now.height !== size.height) {
            const to = resizeAnchored({ x, y, width: now.width ?? size.width, height: now.height ?? size.height }, size, displays());
            win.setBounds(to);
            if (to.x !== x || to.y !== y) {
                settings = applyPatch(settings, { widgets: { [widget]: { x: to.x, y: to.y } } });
                save();
            }
        }
        win.webContents.send("overlay-config", configFor(widget));
    }

    // While the settings window is open: what does not change a window's size goes through at once (another style of
    // the same size, a line that takes no room); only the rest waits.
    function settleFrozen() {
        if (!frozen) return;
        for (const widget of WIDGETS) {
            const held = frozen.get(widget);
            const next = { ...shapeOf(settings.widgets[widget]), scale: held.scale };
            const [a, b] = [sizeOf(widget, held), sizeOf(widget, next)];
            if (a.width === b.width && a.height === b.height) frozen.set(widget, next);
        }
    }

    // A widget (or the settings window) moved: one whose new size now stays clear of the settings window takes it.
    function releaseClear() {
        if (!frozen || !alive(settingsWin)) return;
        const area = settingsWin.getBounds();
        let released = false;
        for (const widget of WIDGETS) {
            const win = windows.get(widget);
            if (!pending(widget) || !alive(win)) continue;
            const w = settings.widgets[widget];
            if (overlaps(resizeAnchored(win.getBounds(), sizeOf(widget, w), displays()), area)) continue;
            frozen.set(widget, shapeOf(w));
            reconfigure(widget);
            released = true;
        }
        if (released) sendSettings();
    }

    // the settings window above the top-most widgets, while it is in use
    function liftSettings() {
        if (headless || !settingsUp || !alive(settingsWin) || settingsWin.isMinimized?.()) return;
        settingsWin.setAlwaysOnTop(true, "screen-saver");
        settingsWin.moveTop?.();
    }

    // It lost the focus: to a widget in the edit mode it stays up, to anything else it sinks (the game must get its
    // screen back; clicking it again lifts it).
    function sinkSettings() {
        if (headless || disposed || !alive(settingsWin) || settingsWin.isFocused?.()) return;
        const focused = BrowserWindow.getFocusedWindow?.();
        if (focused && [...windows.values()].includes(focused)) return;
        settingsUp = false;
        settingsWin.setAlwaysOnTop(false);
    }

    // what a widget's window and page are built from, but where it is
    const configSig = (widget) => JSON.stringify([{ ...settings.widgets[widget], x: 0, y: 0 }, settings.lang, sessionOptions(settings)]);

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
        const sigs = Object.fromEntries(WIDGETS.map((w) => [w, configSig(w)]));
        settings = applyPatch(settings, patch);
        save();
        if (settings.enabled) connect();
        else if (before.enabled) disconnect();
        syncHotkey();
        syncKeys();
        const options = sessionOptions(settings);
        if (JSON.stringify(options) !== JSON.stringify(sessionOptions(before))) {
            session.configure(options);
            ilSession.configure(options);
        }
        settleFrozen();
        for (const widget of WIDGETS) if (configSig(widget) !== sigs[widget]) reconfigure(widget);
        // the overlay's language: the settings window is built again in it
        if (before.lang !== settings.lang && alive(settingsWin)) {
            settingsWin.setTitle?.(tOverlay("overlay.window.title"));
            settingsWin.webContents.reload();
        }
        updateVisibility();
        syncMap();
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
        // the widgets keep their size while it is open
        frozen = new Map(WIDGETS.map((w) => [w, shapeOf(settings.widgets[w])]));
        settingsWin = new BrowserWindow({
            width: 600, height: 820, minWidth: 420, minHeight: 360, show: !headless,
            title: tOverlay("overlay.window.title"), backgroundColor: "#14121c", autoHideMenuBar: true, icon,
            webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
        });
        settingsWin.setMenu?.(null);
        settingsWin.loadFile(path.join(here, "settings.html"));
        settingsWin.on("page-title-updated", (e) => e.preventDefault());
        settingsWin.on("moved", releaseClear);
        settingsWin.on("resized", releaseClear);
        settingsWin.on("focus", () => {
            settingsUp = true;
            liftSettings();
        });
        settingsWin.on("blur", () => setTimeout(sinkSettings, 60));
        settingsWin.on("closed", () => {
            settingsWin = null;
            settingsUp = false;
            // closed: the widgets take the size set meanwhile
            const kept = frozen;
            frozen = null;
            if (disposed) return;
            for (const widget of WIDGETS) if (!sameShape(kept?.get(widget), shapeOf(settings.widgets[widget]))) reconfigure(widget);
        });
        settingsUp = true;
        liftSettings();
        return settingsWin;
    }

    // ---- IPC (the widget windows and the settings window share app/overlay/preload.cjs) ----

    ipcMain.handle("overlay-get", () => statePayload());
    ipcMain.handle("overlay-set", (_e, patch) => {
        apply(patch);
        return statePayload();
    });
    ipcMain.handle("overlay-keys", (_e, n) => keysInfo(Number(n)));
    ipcMain.on("overlay-edit", (_e, on) => setEdit(on));
    ipcMain.on("overlay-open-settings", () => openSettings());
    ipcMain.on("overlay-profile", (_e, p) => setProfile(p));
    ipcMain.on("overlay-scale", (_e, request) => {
        const widget = request?.widget;
        if (!WIDGETS.includes(widget) || !Number.isFinite(request?.scale)) return;
        settings = applyPatch(settings, { widgets: { [widget]: { scale: request.scale } } });
        // resized by its own corner: its window follows at once, the settings window open or not
        if (frozen) frozen.set(widget, shapeOf(settings.widgets[widget]));
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
        // the card's result for its map (the "result" hook, with the map's checksum): the Dan widget's data at once
        onCardResult: (r) => dan.fromCard(r),
        setProfile,
        keepUp: () => keepUp(),
        setEdit,
        apply,
        settings: () => settings,
        // the language changed: every overlay page is built again in it
        reload() {
            for (const win of windows.values()) if (alive(win)) win.webContents.reload();
            if (alive(settingsWin)) {
                settingsWin.setTitle(tOverlay("overlay.window.title"));
                settingsWin.webContents.reload();
            }
        },
        keysInfo,
        // for the smoke test and the tests: the window of a widget, and whether it is meant to be on screen
        windowFor: (widget) => windows.get(widget) ?? null,
        // what the keyboard reader listens to now ({ keys, names, source, file } or null)
        listeningKeys: () => (keysFor?.names ? { keys: keysFor.keys, names: [...keysFor.names], source: keysFor.source, file: keysFor.file } : null),
        isShown: (widget) => shown.get(widget) === true,
        settingsWindow: () => settingsWin,
        dispose() {
            disposed = true;
            clearTimeout(gateTimer);
            clearTimeout(selectTimer);
            clearTimeout(framesTimer);
            clearTimeout(picture.timer);
            clearTimeout(mapDanAsk.timer);
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
            const keysGone = dropKeys();
            if (hotkeyOn) globalShortcut.unregister(EDIT_HOTKEY);
            hotkeyOn = false;
            for (const win of windows.values()) if (alive(win)) win.destroy();
            if (alive(settingsWin)) settingsWin.destroy();
            // the keyboard reader's exit (it is told to quit; main waits for it before the app goes)
            return keysGone;
        },
    };
}
