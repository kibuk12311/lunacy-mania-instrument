// Run with: npx electron tests/smoke/electron-settings.mjs <out-dir> — the Settings page in the real window, ru then en.
// main's side is the real app/settingsIpc.js (over a Documents folder made in <out-dir>, links opened by a stub that
// only records them) and the real window.json loading (one saved in the old compact mode opens the normal window);
// the other channels the page uses answer as their tabs would (the overlay, Interlude, the local profile, the session
// library, the update check), recording what they are asked. Checked: the footer has only ⚙ (and the client word);
// ⚙ opens the page, «← Назад» closes it, the tray's «Настройки…» ("open-settings") opens it again; every section is
// there in the language of the moment; 📌, the update toggle, the profile source and «Записывать мои игры» reach their
// channels; a cache asks first; the Discord name is copied with a toast; nothing scrolls sideways at 320 px.
// Screenshots (the whole page, the footer, the toast) go to <out-dir>. Exits 1 when a check fails.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setLang, t } from "../../src/i18n/i18n.js";
import { registerSettingsIpc } from "../../app/settingsIpc.js";
import { loadWindowState, DEFAULT_WINDOW } from "../../app/windowState.js";
import { applyPatch, normalizeOverlaySettings } from "../../src/overlay/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("-") && !a.endsWith(".mjs")) ?? "settings-smoke");
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, "user-data"), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "user-data"));
let lang = "ru";
let failed = false;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];

// the window is made again for the second language: closing the first must not quit
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    // ---- main's side ----
    const docsDir = path.join(outDir, "docs", "Lunacy mania");
    registerSettingsIpc({
        ipcMain, paths: { docsDir }, tosu: { port: 24050 }, log: (l) => console.log("log", l),
        shell: { openPath: async (p) => { calls.push(["openPath", p]); return ""; }, openExternal: async (u) => { calls.push(["openExternal", u]); } },
        resultCache: { clear: async () => calls.push(["clear", "results"]) },
        styleCatalog: { clear: async () => calls.push(["clear", "model-styles"]) },
    });
    let settings = { alwaysOnTop: false, autoUpdate: true, lang, version: "0.9.6" };
    let win = null;
    const sendSettings = () => win.webContents.send("settings", { ...settings, lang });
    ipcMain.on("toggle-always-on-top", () => { settings.alwaysOnTop = !settings.alwaysOnTop; calls.push(["pin", settings.alwaysOnTop]); sendSettings(); });
    ipcMain.on("toggle-auto-update", () => { settings.autoUpdate = !settings.autoUpdate; calls.push(["auto", settings.autoUpdate]); sendSettings(); });
    ipcMain.handle("check-updates", async () => { calls.push(["check"]); return { ok: true, outcome: "dev" }; });
    ipcMain.handle("session-copy", (_e, req) => { calls.push(["copy", req?.text]); return { ok: true }; });
    ipcMain.handle("session-library-status", () => ({ songsDir: "D:\\osu!\\Songs", counts: {} }));
    ipcMain.handle("session-library-clear", () => { calls.push(["clear", "session"]); return { ok: true }; });
    ipcMain.handle("session-library-pick", () => ({ ok: false, cancelled: true }));
    let record = true;
    ipcMain.handle("local-profile-status", () => ({ ok: true, settings: { record }, skill: null }));
    ipcMain.handle("local-profile-record", (_e, req) => { record = Boolean(req?.on); calls.push(["record", record]); return { ok: true, record }; });
    ipcMain.handle("local-profile-pick-osu", () => ({ ok: false, cancelled: true }));
    let overlay = { settings: applyPatch(normalizeOverlaySettings(null), { enabled: true }), edit: false };
    ipcMain.handle("overlay-get", () => overlay);
    ipcMain.handle("overlay-set", (_e, patch) => (overlay = { ...overlay, settings: applyPatch(overlay.settings, patch) }));
    ipcMain.on("overlay-edit", () => {});
    ipcMain.on("overlay-open-settings", () => {});
    ipcMain.on("overlay-profile", () => {});
    ipcMain.handle("interlude-status", () => ({ ok: true, linked: false, folder: null }));
    ipcMain.handle("interlude-live-get", () => ({ ok: true, settings: { follow: false, allowDownload: false }, state: { status: "off" }, text: "" }));
    ipcMain.handle("profile-ensure", () => ({ ok: false, reason: "none" }));

    // ---- the old compact mode: a window.json saved in it opens the normal window ----
    const stateFile = path.join(outDir, "user-data", "window.json");
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ x: 50, y: 50, width: 320, height: 103, alwaysOnTop: false, compact: true, lang: "ru" }));
    const state = loadWindowState(stateFile, [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]);
    check(state.height === DEFAULT_WINDOW.height && !("compact" in state), `a window.json from the compact mode opens ${state.width}×${state.height}`);

    try {
        for (const l of ["ru", "en"]) {
            lang = l;
            setLang(l);
            // each language starts from the same settings
            settings = { alwaysOnTop: false, autoUpdate: true, lang, version: "0.9.6" };
            record = true;
            win?.destroy();
            win = new BrowserWindow({ width: 320, height: 380, show: false, backgroundColor: "#14121c",
                webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
            await win.loadFile(path.join(appDir, "renderer", "index.html"));
            const js = (code) => win.webContents.executeJavaScript(code);
            const shot = async (file) => {
                const [w, h] = win.getContentSize();
                win.setContentSize(w + 1, h);
                await sleep(150);
                win.setContentSize(w, h);
                await sleep(200);
                writeFileSync(path.join(outDir, file), (await win.webContents.capturePage()).toPNG());
                console.log("shot", file);
            };
            sendSettings();
            win.webContents.send("view", { screen: "waiting-osu" });
            win.webContents.send("osu-client", { client: "stable" });
            await sleep(300);

            // the footer: only ⚙ and the client word
            const footer = await js(`[...document.querySelectorAll("#analysis-tab footer > *")].filter((n) => !n.hidden).map((n) => n.id)`);
            check(JSON.stringify(footer) === JSON.stringify(["osu-client", "settings-open"]), `${l}: the footer holds ${footer.join(", ")}`);
            check(await js(`!document.getElementById("compact") && !document.querySelector("body.compact")`), `${l}: no compact mode`);
            await shot(`${l}-footer.png`);

            await js(`document.getElementById("settings-open").click(); true`);
            await sleep(500);
            check(await js(`!document.getElementById("settings-page").hidden`), `${l}: ⚙ opens the page`);
            const text = await js(`document.getElementById("settings-page").innerText`);
            const want = l === "ru"
                ? ["Настройки", "Калькулятор на карточке", "Язык / Language", "Поверх всех окон", "ОВЕРЛЕЙ В ИГРЕ", "Дан", "INTERLUDE", "ПРОФИЛЬ", "Записывать мои игры", "ПАПКИ", "ОБНОВЛЕНИЯ", "Версия 0.9.6", "OSU! И TOSU", "tosu на порту 24050", "КЭШ", "О ПРОГРАММЕ", "Автор: Sneezey · Discord:", "sneezey123"]
                : ["Settings", "Calculator on the card", "Language", "Always on top", "IN-GAME OVERLAY", "Dan", "INTERLUDE", "PROFILE", "Record my plays", "FOLDERS", "UPDATES", "Version 0.9.6", "OSU! AND TOSU", "tosu on port 24050", "CACHES", "ABOUT", "Made by Sneezey · Discord:", "sneezey123"];
            const missing = want.filter((w) => !text.includes(w));
            check(!missing.length, `${l}: every section is there (missing: ${missing.join(", ") || "none"})`);
            check(text.includes(docsDir), `${l}: the Documents folder is shown`);
            const sideways = await js(`document.querySelector(".st-body").scrollWidth - document.querySelector(".st-body").clientWidth`);
            check(sideways <= 0, `${l}: nothing scrolls sideways at 320 px (${sideways})`);
            // the whole page in one picture
            const height = await js(`document.querySelector(".st-head").offsetHeight + document.querySelector(".st-body").scrollHeight`);
            win.setContentSize(320, Math.min(height + 10, 4000));
            await sleep(300);
            await shot(`${l}-settings-page.png`);
            win.setContentSize(320, 380);
            await sleep(200);
            await shot(`${l}-settings-top.png`);

            // the controls reach their channels
            calls.length = 0;
            await js(`document.getElementById("pin").click(); true`);
            await sleep(200);
            check(calls.some((c) => c[0] === "pin" && c[1] === true) && (await js(`document.getElementById("pin").checked`)), `${l}: 📌 goes through main and comes back`);
            await js(`[...document.querySelectorAll("#st-updates input")][0].click(); true`);
            await sleep(200);
            check(calls.some((c) => c[0] === "auto" && c[1] === false), `${l}: the update toggle goes through main`);
            await js(`[...document.querySelectorAll("#st-updates button")].find((b) => b.textContent === ${JSON.stringify(t("settings.updates.check"))}).click(); true`);
            await sleep(300);
            check((await js(`document.getElementById("st-updates").innerText`)).includes(t("settings.updates.result.dev")), `${l}: "Check now" says what came out`);
            await js(`document.querySelector('#st-profile [data-source="local"]').click(); true`);
            check((await js(`JSON.parse(localStorage.getItem("rec-settings")).source`)) === "local", `${l}: the profile source is the picks tab's own setting`);
            await js(`document.querySelector('#st-profile [data-source="tracker"]').click(); true`);
            await js(`document.querySelector("#st-profile input").click(); true`);
            await sleep(200);
            check(calls.some((c) => c[0] === "record" && c[1] === false), `${l}: «Записывать мои игры» goes to the local profile`);
            await js(`document.querySelector('#st-caches [data-cache="results"] button').click(); true`);
            check(!calls.some((c) => c[0] === "clear"), `${l}: a cache is not cleared at the first click`);
            await js(`document.querySelector('#st-caches [data-cache="results"] .st-yes').click(); true`);
            await sleep(200);
            check(calls.some((c) => c[0] === "clear" && c[1] === "results"), `${l}: …only after «${t("settings.cache.yes")}»`);
            await js(`[...document.querySelectorAll("#st-about button")].find((b) => b.textContent === "GitHub").click(); true`);
            await sleep(200);
            check(calls.some((c) => c[0] === "openExternal" && /github\.com/.test(c[1])), `${l}: GitHub opens the project's page`);
            await js(`document.querySelector("#st-author .st-discord").click(); true`);
            await sleep(250);
            check(calls.some((c) => c[0] === "copy" && c[1] === "sneezey123") && (await js(`!document.getElementById("st-toast").hidden && document.getElementById("st-toast").textContent`)) === t("settings.about.copied"),
                `${l}: the Discord name is copied, «${t("settings.about.copied")}»`);
            await shot(`${l}-copied.png`);

            // back, and the tray's way in
            await js(`document.getElementById("settings-back").click(); true`);
            await sleep(200);
            check(await js(`document.getElementById("settings-page").hidden`), `${l}: «${t("settings.html.back")}» closes it`);
            win.webContents.send("open-settings", {});
            await sleep(300);
            check(await js(`!document.getElementById("settings-page").hidden`), `${l}: the tray's «${t("app.tray.settings")}» opens it`);
        }
    } catch (error) {
        console.error(error);
        failed = true;
    } finally {
        win?.destroy();
        app.exit(failed ? 1 : 0);
    }
});
