// The Settings page: a full-height page over the window, opened by ⚙ under the card or the tray's «Настройки…»,
// closed by «← Назад» (or Esc). Everything that used to sit under the card and the app's other general settings:
// the calculator (renderer.js keeps its select), the language and 📌, the overlay's block (overlayPanel.js) and
// Interlude's (interludePanel.js), the profile source and «Записывать мои игры», the folders, the update check, osu! and
// tosu, the caches, and an About block with the author.
// Every setting goes through the channel its own place already uses, so the tray, the Profile and Picks tabs and this
// page always show the same: the picks tab's localStorage source (with its "profile-source" event), the local
// profile's record setting, main's always-on-top and update toggles (they come back as "settings").
import { getLang, LANGS, LANG_NAMES, t } from "../../src/i18n/i18n.js";
import { manualChanged } from "./profile.js";

const SETTINGS_KEY = "rec-settings"; // the picks tab's settings: { source, query, manualProfile, … }
const SOURCES = ["tracker", "manual", "local"];
export const DISCORD = "sneezey123";
const TOAST_MS = 1400;
const CACHES = [
    { id: "results", text: "settings.cache.results" },
    { id: "session", text: "settings.cache.session" },
    { id: "model-styles", text: "settings.cache.modelStyles" },
];

const sourceName = (id) => t(id === "tracker" ? "recommend.source.tracker" : id === "manual" ? "recommend.source.manual" : "profile.source.local");
export const updateText = (outcome) => t(`settings.updates.result.${["latest", "dev", "checking", "downloading", "ready", "available"].includes(outcome) ? outcome : "error"}`);
export const clientText = (client) => (client === "stable" || client === "lazer" ? t("settings.osu.client", { client: `osu! ${client}` }) : t("settings.osu.none"));

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, cls = "small", onClick = null) {
    const b = el("button", cls, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
}
function checkRow(text, onChange) {
    const label = el("label", "st-check");
    const box = el("input");
    box.type = "checkbox";
    box.addEventListener("change", () => onChange(box.checked));
    label.append(box, el("span", "", text));
    return { label, box };
}

function readSource(storage) {
    try {
        const s = JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? "null");
        return SOURCES.includes(s?.source) ? s.source : "tracker";
    } catch {
        return "tracker";
    }
}
function writeSource(storage, source) {
    try {
        const s = JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? "null");
        storage()?.setItem(SETTINGS_KEY, JSON.stringify({ ...(s && typeof s === "object" ? s : {}), source }));
    } catch {
        // not kept; the picks tab still gets the event
    }
}

// page: the page's section; openButton: ⚙ under the card; tabButton: ⚙ at the end of the tab bar (opens and closes the
// page, lit while it is open); $: by id; interlude: the IL block (its shown()).
export function initSettingsPage({
    page, openButton, tabButton = null, $ = (id) => document.getElementById(id), api = window.danApi,
    storage = () => globalThis.localStorage, onProfileChange = manualChanged, interlude = null,
    setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    if (!page) return null;
    let settings = { alwaysOnTop: false, autoUpdate: true, version: "" };
    let info = null;
    let client = null;
    let toastTimer = null;

    // ---- open / close ----
    const isOpen = () => !page.hidden;
    function open(section = null) {
        page.hidden = false;
        document.body?.classList?.add("settings-open");
        tabButton?.classList?.add("on");
        void refresh();
        interlude?.shown?.({ focus: section === "interlude" });
        if (section) $(`st-${section}`)?.scrollIntoView?.({ block: "start" });
    }
    function close() {
        page.hidden = true;
        document.body?.classList?.remove("settings-open");
        tabButton?.classList?.remove("on");
    }
    openButton?.addEventListener("click", () => open());
    tabButton?.addEventListener("click", () => (isOpen() ? close() : open()));
    $("settings-back")?.addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) close(); });
    api.onOpenSettings?.(() => open());
    // a tab asked for (the Interlude library put a chart on the card, "Open Profile"): the page gives way
    window.addEventListener("open-tab", () => { if (isOpen()) close(); });

    // ---- the language and 📌 (their rows are in index.html) ----
    const langBox = $("st-lang");
    const langButtons = LANGS.map((l) => {
        const b = button(LANG_NAMES[l], "small", () => { if (l !== getLang()) api.setLang(l); });
        langBox?.append(b);
        return { l, b };
    });
    const pin = $("pin");
    pin?.addEventListener("change", () => {
        if (pin.checked !== settings.alwaysOnTop) api.toggleAlwaysOnTop();
    });

    // ---- profile ----
    const profileBox = $("st-profile");
    const chips = el("div", "chips st-sources");
    const record = checkRow(t("settings.profile.record"), async (on) => {
        record.box.disabled = true;
        try {
            const r = await api.localProfileRecord?.(on);
            if (r?.ok) record.box.checked = r.record;
        } finally {
            record.box.disabled = false;
        }
    });
    const openProfile = button(t("settings.profile.open"), "small", () => {
        window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "profile", page: readSource(storage) === "local" ? "local" : "tracker" } }));
    });
    const trackerNote = el("div", "muted st-note", t("settings.profile.trackerNote"));
    profileBox?.append(el("h3", "", t("settings.profile.title")), el("div", "st-label", t("settings.profile.source")), chips, trackerNote, record.label, openProfile);
    function renderSources() {
        const current = readSource(storage);
        chips.replaceChildren(...SOURCES.map((id) => {
            const chip = el("span", id === current ? "sel" : "", sourceName(id));
            chip.dataset.source = id;
            chip.addEventListener("click", () => pickSource(id));
            return chip;
        }));
        trackerNote.hidden = current !== "tracker";
    }
    function pickSource(id) {
        writeSource(storage, id);
        onProfileChange();
        window.dispatchEvent(new CustomEvent("profile-source", { detail: { source: id, from: "settings" } }));
        renderSources();
    }
    window.addEventListener("profile-source", (e) => { if (e.detail?.from !== "settings") renderSources(); });
    async function renderRecord() {
        try {
            const r = await api.localProfileStatus?.();
            if (r?.ok) record.box.checked = r.settings?.record !== false;
        } catch {
            // the box keeps what it shows
        }
    }
    api.onLocalProfileChanged?.((p) => {
        if (typeof p?.record === "boolean") record.box.checked = p.record;
    });

    // ---- folders ----
    const folders = $("st-folders");
    const docsPath = el("div", "st-path muted");
    const songsPath = el("div", "st-path muted");
    const folderAnswer = el("div", "muted st-note");
    const [docsActions, songsActions, osuActions] = [0, 1, 2].map(() => el("div", "st-actions"));
    folders?.append(
        el("h3", "", t("settings.folders.title")),
        el("div", "st-label", t("settings.folders.docs")), docsPath, docsActions,
        el("div", "st-label", t("settings.folders.songs")), songsPath, songsActions,
        el("div", "st-label", t("settings.folders.osu")), osuActions,
        folderAnswer,
        el("div", "muted st-note", t("settings.folders.skinsNote")),
    );
    docsActions.append(button(t("settings.folders.open"), "small", () => api.settingsOpen?.("docs")));
    songsActions.append(button(t("settings.folders.pickSongs"), "small", async () => {
        const r = await api.sessionLibraryPick?.();
        if (r?.songsDir) songsPath.textContent = r.songsDir;
    }));
    osuActions.append(button(t("settings.folders.pickOsu"), "small", async () => {
        const r = await api.localProfilePickOsu?.();
        if (r?.cancelled) return;
        folderAnswer.textContent = r?.ok === false && r.message ? r.message : t("settings.folders.importing");
    }));
    api.onSessionLibrary?.((s) => { songsPath.textContent = s?.songsDir || t("settings.folders.songsAuto"); });

    // ---- updates ----
    const updates = $("st-updates");
    const versionLine = el("div", "st-label");
    const auto = checkRow(t("settings.updates.auto"), (on) => { if (on !== settings.autoUpdate) api.toggleAutoUpdate?.(); });
    const updateAnswer = el("span", "muted st-note");
    const checkNow = button(t("settings.updates.check"), "small", async () => {
        checkNow.disabled = true;
        updateAnswer.textContent = t("settings.updates.checking");
        try {
            const r = await api.checkUpdates?.();
            updateAnswer.textContent = r?.ok ? updateText(r.outcome) : updateText("error");
        } finally {
            checkNow.disabled = false;
        }
    });
    const updateRow = el("div", "st-actions");
    updateRow.append(checkNow, updateAnswer);
    updates?.append(el("h3", "", t("settings.updates.title")), versionLine, auto.label, updateRow);

    // ---- osu! and tosu ----
    const osu = $("st-osu");
    const clientLine = el("div", "st-label");
    const portLine = el("div", "muted st-note");
    osu?.append(el("h3", "", t("settings.osu.title")), clientLine, portLine);
    const renderClient = () => { clientLine.textContent = clientText(client); };
    api.onOsuClient?.((p) => {
        client = p?.client ?? null;
        renderClient();
    });

    // ---- caches: each with a "sure?" step ----
    const caches = $("st-caches");
    caches?.append(el("h3", "", t("settings.cache.title")));
    for (const c of CACHES) {
        const row = el("div", "st-cache");
        const actions = el("span", "st-actions");
        const answer = el("div", "muted st-note");
        const clear = button(t("settings.cache.clear"), "small");
        const ask = () => {
            const yes = button(t("settings.cache.yes"), "small st-yes", async () => {
                yes.disabled = true;
                const r = await (c.id === "session" ? api.sessionLibraryClear?.() : api.settingsClearCache?.(c.id));
                answer.textContent = r?.ok ? t("settings.cache.done") : r?.busy ? t("settings.cache.busy") : t("settings.cache.failed", { message: r?.message ?? "" });
                actions.replaceChildren(clear);
            });
            const no = button(t("settings.cache.no"), "small", () => actions.replaceChildren(clear));
            actions.replaceChildren(el("span", "st-sure", t("settings.cache.sure")), yes, no);
        };
        clear.addEventListener("click", ask);
        actions.append(clear);
        row.dataset.cache = c.id;
        row.append(el("span", "st-label", t(c.text)), actions, answer);
        caches?.append(row);
    }

    // ---- about and the author ----
    const about = $("st-about");
    const aboutName = el("div", "st-label");
    const links = el("div", "st-actions");
    for (const [target, key] of [["github", "settings.about.github"], ["releases", "settings.about.releases"], ["license", "settings.about.license"], ["notices", "settings.about.notices"]]) {
        links.append(button(t(key), "small", () => api.settingsOpen?.(target)));
    }
    const toast = $("st-toast");
    function copyDiscord() {
        void Promise.resolve(api.sessionCopy?.(DISCORD)).catch(() => {});
        if (!toast) return;
        toast.textContent = t("settings.about.copied");
        toast.hidden = false;
        clearTimer(toastTimer);
        toastTimer = setTimer(() => { toast.hidden = true; }, TOAST_MS);
    }
    const authorLine = (cls) => {
        const line = el("div", cls);
        const nick = button(DISCORD, "st-discord", copyDiscord);
        nick.title = t("settings.about.copyTitle");
        line.append(el("span", "", `${t("settings.about.authorPrefix")} `), nick);
        return line;
    };
    about?.append(el("h3", "", t("settings.about.title")), aboutName, links, authorLine("st-label"));
    $("st-author")?.append(authorLine("st-author-line muted"));

    // ---- main's settings and info ----
    function render() {
        if (pin) pin.checked = Boolean(settings.alwaysOnTop);
        auto.box.checked = settings.autoUpdate !== false;
        for (const { l, b } of langButtons) b.classList.toggle("on", l === getLang());
        const version = settings.version || info?.version || "";
        versionLine.textContent = t("settings.updates.version", { version });
        aboutName.textContent = t("settings.about.name", { version });
        docsPath.textContent = info?.docsDir ?? "";
        portLine.textContent = info?.tosuPort ? t("settings.osu.port", { port: info.tosuPort }) : "";
        renderClient();
    }
    async function refresh() {
        renderSources();
        void renderRecord();
        try {
            const r = await api.settingsInfo?.();
            if (r?.ok) info = r;
        } catch {
            // what main didn't say stays empty
        }
        try {
            const s = await api.sessionLibraryStatus?.();
            songsPath.textContent = s?.songsDir || t("settings.folders.songsAuto");
        } catch {
            songsPath.textContent = t("settings.folders.songsAuto");
        }
        render();
    }
    api.onSettings?.((s) => {
        settings = { ...settings, ...s };
        render();
    });
    renderSources();
    render();
    return { open, close, isOpen, refresh, pickSource, copyDiscord };
}
