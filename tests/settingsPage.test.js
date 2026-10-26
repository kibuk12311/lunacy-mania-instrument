// The Settings page (app/renderer/settingsPage.js) and its main side (app/settingsIpc.js): it opens from ⚙ and from
// the tray and closes by «← Назад», Esc or another tab; every setting goes through the channel its own place uses
// (the picks tab's source with its event, the local profile's record setting, main's toggles), so the Profile and
// Picks tabs and the tray stay in sync; the caches ask first; the author's Discord name is copied with a toast.
// Plus the caches' own clear(), the session library's, and the compact mode's way out of main.js.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { setLang } from "../src/i18n/i18n.js";
import { initSettingsPage, DISCORD, updateText, clientText } from "../app/renderer/settingsPage.js";
import { createSettingsHandlers, LINKS } from "../app/settingsIpc.js";
import { createCache } from "../src/core/cache.js";
import { createStyleCatalog } from "../app/modelStyles.js";
import { createSessionLibrary } from "../app/sessionLibrary.js";
import { stripComments } from "./helpers/source.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

function fakeApi() {
    const calls = [];
    const on = {};
    const api = {
        calls, on,
        setLang: (l) => calls.push(["lang", l]),
        toggleAlwaysOnTop: () => calls.push(["pin"]),
        toggleAutoUpdate: () => calls.push(["auto"]),
        checkUpdates: async () => { calls.push(["check"]); return { ok: true, outcome: "latest" }; },
        settingsInfo: async () => ({ ok: true, version: "0.9.6", docsDir: "C:\\Docs\\Lunacy mania", tosuPort: 24050 }),
        settingsOpen: async (target) => { calls.push(["open", target]); return { ok: true }; },
        settingsClearCache: async (which) => { calls.push(["clear", which]); return { ok: true }; },
        sessionLibraryClear: async () => { calls.push(["clear", "session"]); return { ok: false, busy: true }; },
        sessionLibraryStatus: async () => ({ songsDir: "D:\\osu!\\Songs" }),
        sessionLibraryPick: async () => { calls.push(["pickSongs"]); return { songsDir: "E:\\Songs" }; },
        localProfileStatus: async () => ({ ok: true, settings: { record: true } }),
        localProfileRecord: async (v) => { calls.push(["record", v]); return { ok: true, record: v }; },
        localProfilePickOsu: async () => { calls.push(["pickOsu"]); return { ok: true }; },
        sessionCopy: async (text) => { calls.push(["copy", text]); return { ok: true }; },
    };
    for (const name of ["onSettings", "onOpenSettings", "onOsuClient", "onSessionLibrary", "onLocalProfileChanged"]) api[name] = (cb) => { on[name] = cb; };
    return api;
}

function mount({ lang = "ru", storage = { "rec-settings": JSON.stringify({ source: "tracker", query: "nick" }) } } = {}) {
    setLang(lang);
    const api = fakeApi();
    const dom = fakeDom(api, { storage });
    const keys = [];
    globalThis.document.addEventListener = (type, fn) => { if (type === "keydown") keys.push(fn); };
    const page = dom.$("settings-page");
    page.hidden = true;
    const openButton = dom.$("settings-open");
    const timers = [];
    let changed = 0;
    let shown = null;
    const view = initSettingsPage({
        page, openButton, $: dom.$, api, onProfileChange: () => { changed += 1; },
        interlude: { shown: (o) => { shown = o; } },
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    });
    return { ...dom, api, page, openButton, view, keys, timers, changed: () => changed, shown: () => shown };
}

const find = (node, pred) => {
    if (pred(node)) return node;
    for (const c of node.children ?? []) {
        const hit = find(c, pred);
        if (hit) return hit;
    }
    return null;
};
const buttonNamed = (node, text) => find(node, (n) => n.tagName === "BUTTON" && n.textContent === text);

test("opens from ⚙ and the tray, closes by back, Esc and another tab; the Interlude block is told it is shown", async () => {
    const m = mount();
    await fire(m.openButton, "click");
    assert.equal(m.page.hidden, false);
    assert.deepEqual(m.shown(), { focus: false });
    await fire(m.$("settings-back"), "click");
    assert.equal(m.page.hidden, true);
    m.api.on.onOpenSettings(); // the tray's «Настройки…»
    assert.equal(m.page.hidden, false);
    m.keys[0]({ key: "Escape" });
    assert.equal(m.page.hidden, true);
    m.view.open("interlude"); // the IL button under the card: the library, its search focused
    assert.deepEqual(m.shown(), { focus: true });
    m.window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "analysis" } }));
    assert.equal(m.page.hidden, true, "a chart put on the card: back to it");
});

test("what main says: version, the folder, tosu's port, the client; 📌 and the update check go through main's toggles", async () => {
    const m = mount();
    m.view.open();
    await flush();
    m.api.on.onSettings({ alwaysOnTop: true, autoUpdate: false, lang: "ru", version: "0.9.6" });
    m.api.on.onOsuClient({ client: "lazer" });
    for (const id of ["st-updates", "st-about", "st-folders", "st-osu"]) {
        const text = textOf(m.$(id));
        if (id === "st-updates") assert.ok(text.includes("Версия 0.9.6"), text);
        if (id === "st-about") assert.ok(text.includes("Lunacy mania 0.9.6") && text.includes(`Автор: Sneezey · Discord:`) && text.includes(DISCORD), text);
        if (id === "st-folders") assert.ok(text.includes("C:\\Docs\\Lunacy mania") && text.includes("D:\\osu!\\Songs"), text);
        if (id === "st-osu") assert.ok(text.includes("Сейчас: osu! lazer") && text.includes("порту 24050"), text);
    }
    const pin = m.$("pin");
    assert.equal(pin.checked, true, "📌 shows main's state");
    pin.checked = false;
    await fire(pin, "change");
    assert.deepEqual(m.api.calls.at(-1), ["pin"]);
    const auto = find(m.$("st-updates"), (n) => n.tagName === "INPUT");
    assert.equal(auto.checked, false);
    auto.checked = true;
    await fire(auto, "change");
    assert.deepEqual(m.api.calls.at(-1), ["auto"]);
    await fire(buttonNamed(m.$("st-updates"), "Проверить сейчас"), "click");
    assert.ok(textOf(m.$("st-updates")).includes("Это последняя версия."));
    await fire(buttonNamed(m.$("st-folders"), "Открыть"), "click");
    assert.deepEqual(m.api.calls.at(-1), ["open", "docs"]);
    await fire(buttonNamed(m.$("st-folders"), "Выбрать…"), "click");
    assert.ok(textOf(m.$("st-folders")).includes("E:\\Songs"));
    await fire(buttonNamed(m.$("st-about"), "GitHub"), "click");
    assert.deepEqual(m.api.calls.at(-1), ["open", "github"]);
    // the language: one button each, the current one marked; a click on the other asks main
    const en = buttonNamed(m.$("st-lang"), "English");
    await fire(en, "click");
    assert.deepEqual(m.api.calls.at(-1), ["lang", "en"]);
    await fire(buttonNamed(m.$("st-lang"), "Русский"), "click");
    assert.deepEqual(m.api.calls.at(-1), ["lang", "en"], "the current language: nothing");
});

test("the profile source is the picks tab's: the same storage and event both ways; «Записывать мои игры» follows the local profile", async () => {
    const m = mount();
    m.view.open();
    await flush();
    const chip = (id) => find(m.$("st-profile"), (n) => n.dataset?.source === id);
    assert.equal(chip("tracker").className, "sel");
    await fire(chip("local"), "click");
    assert.equal(JSON.parse(m.storage.get("rec-settings")).source, "local");
    assert.equal(JSON.parse(m.storage.get("rec-settings")).query, "nick", "the rest of the picks settings is kept");
    assert.equal(m.changed(), 1, "every tab hears the profile now in use");
    assert.deepEqual(m.events.at(-1).detail, { source: "local", from: "settings" });
    assert.equal(chip("local").className, "sel");
    // the Profile tab picked another one: this page follows
    m.storage.set("rec-settings", JSON.stringify({ source: "manual" }));
    m.window.dispatchEvent(new CustomEvent("profile-source", { detail: { source: "manual", from: "profile" } }));
    assert.equal(chip("manual").className, "sel");
    // recording: read from the local profile, set through it, and a change made on the Profile tab comes back
    const record = find(m.$("st-profile"), (n) => n.tagName === "INPUT");
    assert.equal(record.checked, true);
    record.checked = false;
    await fire(record, "change");
    assert.deepEqual(m.api.calls.at(-1), ["record", false]);
    m.api.on.onLocalProfileChanged({ skill: null, record: true });
    assert.equal(record.checked, true);
    await fire(buttonNamed(m.$("st-profile"), "Открыть «Профиль»"), "click");
    assert.deepEqual(m.events.at(-1).detail, { tab: "profile", page: "tracker" });
});

test("caches: nothing is cleared without «Да»; the session library while a scan runs says so", async () => {
    const m = mount();
    const row = (id) => find(m.$("st-caches"), (n) => n.dataset?.cache === id);
    await fire(buttonNamed(row("results"), "Очистить"), "click");
    assert.ok(textOf(row("results")).includes("Точно очистить?"));
    await fire(buttonNamed(row("results"), "Нет"), "click");
    assert.equal(m.api.calls.filter(([c]) => c === "clear").length, 0);
    await fire(buttonNamed(row("results"), "Очистить"), "click");
    await fire(buttonNamed(row("results"), "Да"), "click");
    assert.deepEqual(m.api.calls.at(-1), ["clear", "results"]);
    assert.ok(textOf(row("results")).includes("Очищено"));
    await fire(buttonNamed(row("model-styles"), "Очистить"), "click");
    await fire(buttonNamed(row("model-styles"), "Да"), "click");
    assert.deepEqual(m.api.calls.at(-1), ["clear", "model-styles"]);
    await fire(buttonNamed(row("session"), "Очистить"), "click");
    await fire(buttonNamed(row("session"), "Да"), "click");
    assert.deepEqual(m.api.calls.at(-1), ["clear", "session"]);
    assert.ok(textOf(row("session")).includes("идёт сканирование"));
});

test("the author: «Автор: Sneezey · Discord: sneezey123» in About and at the bottom; a click copies the name with a toast (en too)", async () => {
    const m = mount({ lang: "en" });
    const bottom = m.$("st-author");
    assert.ok(textOf(bottom).includes("Made by Sneezey · Discord:") && textOf(bottom).includes("sneezey123"));
    const nick = buttonNamed(bottom, DISCORD);
    assert.equal(nick.title, "Copy the Discord name");
    await fire(nick, "click");
    await flush();
    assert.deepEqual(m.api.calls.at(-1), ["copy", "sneezey123"]);
    const toast = m.$("st-toast");
    assert.equal(toast.hidden, false);
    assert.equal(toast.textContent, "copied");
    m.timers.at(-1).fn();
    assert.equal(toast.hidden, true);
    assert.ok(buttonNamed(m.$("st-about"), DISCORD), "the About block has it too");
    setLang("ru");
    assert.equal(updateText("available"), "Есть новая версия — открыта страница загрузки.");
    assert.equal(updateText("nonsense"), "Не удалось проверить обновления.");
    assert.equal(clientText(null), "osu! не найдена (tosu ждёт игру)");
    // the page never opens Discord by itself: no link to it anywhere
    const page = readFileSync(path.join(root, "app/renderer/settingsPage.js"), "utf8");
    assert.ok(!/discord\.(com|gg)/i.test(page));
});

// ---- main ----

test("main: info, fixed places to open (never from the window), caches cleared through their own clear()", async () => {
    const opened = [];
    const cleared = [];
    const h = createSettingsHandlers({
        shell: { openPath: async (p) => { opened.push(["path", p]); return ""; }, openExternal: async (u) => { opened.push(["url", u]); } },
        paths: { docsDir: path.join(await mkdtemp(path.join(tmpdir(), "настройки ")), "Lunacy mania") },
        resultCache: { clear: async () => cleared.push("results") },
        styleCatalog: { clear: async () => cleared.push("model-styles") },
        tosuPort: 24050,
    });
    const info = h.info();
    assert.equal(info.ok, true);
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
    assert.equal(info.tosuPort, 24050);
    assert.deepEqual(await h.open({ target: "docs" }), { ok: true });
    assert.equal(opened[0][0], "path");
    assert.deepEqual(await h.open({ target: "github" }), { ok: true });
    assert.deepEqual(opened.at(-1), ["url", LINKS.github]);
    assert.ok(LINKS.license.endsWith("/LICENSE") && LINKS.notices.endsWith("/THIRD_PARTY_NOTICES.md"));
    assert.equal((await h.open({ target: "https://evil.example" })).ok, false);
    assert.equal((await h.open({ target: "constructor" })).ok, false);
    assert.equal(opened.length, 2);
    assert.deepEqual(await h.clear({ which: "results" }), { ok: true });
    assert.deepEqual(await h.clear({ which: "model-styles" }), { ok: true });
    assert.equal((await h.clear({ which: "../x" })).ok, false);
    assert.deepEqual(cleared, ["results", "model-styles"]);
});

test("the caches' clear(): results gone from memory and disk, mapper styles read again, the session library forgotten", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "кэш "));
    const cache = createCache({ dir: path.join(dir, "results") });
    await cache.set("a@1", { kind: "ok" });
    assert.deepEqual(await cache.get("a@1"), { kind: "ok" });
    await cache.clear();
    assert.equal(await cache.get("a@1"), undefined);
    await cache.clear(); // twice is fine
    await cache.set("b@1", { kind: "ok" });
    assert.deepEqual(await readdir(path.join(dir, "results")), ["b@1.json"]);

    const models = path.join(dir, "models");
    await mkdir(models);
    await writeFile(path.join(models, "mapper-xgb3.json"), JSON.stringify({ styles: [{ key: "a", name: "A", maps: 1 }] }), "utf8");
    let scans = 0;
    const catalog = createStyleCatalog({ dirs: [models], cacheFile: path.join(dir, "model-styles.json"), scan: async () => { scans += 1; return [{ key: "a", name: "A", maps: 1 }]; } });
    await catalog.forFile("mapper-xgb3.json");
    await catalog.forFile("mapper-xgb3.json");
    assert.equal(scans, 1);
    await catalog.clear();
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "model-styles.json"), "utf8")).files, {});
    await catalog.forFile("mapper-xgb3.json");
    assert.equal(scans, 2, "read again after the clear");

    const file = path.join(dir, "session-library.json");
    await writeFile(file, JSON.stringify({ v: 1, analyzer: "x", songsDir: null, folders: {}, maps: { "osu:0123456789abcdef0123456789abcdef": { path: "x" } } }), "utf8");
    const lib = createSessionLibrary({ file, analyzer: "x", analyze: async () => ({ kind: "ok" }) });
    const before = await lib.status();
    assert.deepEqual(await lib.clear(), { ok: true });
    const after = await lib.status();
    assert.equal(after.counts.total, 0);
    assert.ok(before.counts.total >= 0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).maps, {});
});

test("main.js: no compact mode, the tray opens the Settings page, the update check is the tray's", () => {
    const main = stripComments(readFileSync(path.join(root, "app/main.js"), "utf8"));
    assert.ok(!/compact/i.test(main), "nothing of the compact mode left");
    assert.match(main, /app\.tray\.settings/);
    assert.match(main, /send\("open-settings"/);
    assert.match(main, /ipcMain\.on\("toggle-auto-update", \(\) => toggle\("autoUpdate"\)\)/);
    const preload = stripComments(readFileSync(path.join(root, "app/preload.cjs"), "utf8"));
    assert.ok(!/compact/i.test(preload));
    for (const c of ["settings-info", "settings-open", "settings-clear-cache", "session-library-clear", "check-updates", "toggle-auto-update", "open-settings"]) {
        assert.ok(preload.includes(`"${c}"`), c);
    }
});
