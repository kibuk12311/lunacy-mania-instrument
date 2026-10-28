// DOM of the demo player: top bar, the canvas, the screens (loading, download, file, choose, ready, pause, results,
// error) and the settings panel. Text only through textContent. main.js owns the logic and calls these.
import { RATES, formatRate } from "../shared/rates.js";
import { keyLabel } from "./input.js";
import { SPEED, OFFSET } from "./settings.js";
import { JUDGEMENT_TEXT } from "./render.js";

export function h(doc, tag, props = {}, children = []) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = String(value);
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else if (key in node && key !== "list" && typeof value !== "string") node[key] = value;
        else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
}

export function createUi({ doc, t }) {
    const root = doc.getElementById("lm-player") ?? doc.body;
    const mk = (tag, props, children) => h(doc, tag, props, children);

    const mapLine = mk("div", { class: "lm-map" });
    const settingsBtn = mk("button", { class: "lm-btn lm-ghost", type: "button", text: t("settings"), dataset: { lmAction: "settings" } });
    const closeBtn = mk("button", { class: "lm-btn lm-ghost lm-close", type: "button", title: t("close"), "aria-label": t("close"), text: "×", dataset: { lmAction: "close" } });
    const top = mk("header", { class: "lm-top" }, [
        mk("div", { class: "lm-brand" }, [mk("span", { text: t("brand") }), mk("span", { class: "lm-muted lm-small", text: ` · ${t("notOsu")}` })]),
        mapLine,
        mk("div", { class: "lm-top-actions" }, [settingsBtn, closeBtn]),
    ]);
    const canvas = mk("canvas", { class: "lm-canvas", "aria-hidden": "true" });
    const screen = mk("div", { class: "lm-screen", role: "dialog", "aria-live": "polite" });
    const panel = mk("aside", { class: "lm-settings", hidden: true, "aria-label": t("settings") });
    const dropVeil = mk("div", { class: "lm-drop", hidden: true }, [mk("div", { text: t("file.drop") })]);
    const fileInput = mk("input", { type: "file", accept: ".osz,.zip", class: "lm-file-input", hidden: true, dataset: { lmFile: "" } });
    root.replaceChildren(top, canvas, screen, panel, dropVeil, fileInput);

    let onFile = null;
    fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";
        if (file) onFile?.(file);
    });

    function card(children, { cls = "", onClickBackground = null } = {}) {
        const body = mk("div", { class: `lm-card ${cls}`.trim() }, children);
        screen.replaceChildren(body);
        screen.hidden = false;
        screen.onclick = onClickBackground
            ? (event) => {
                if (event.target.closest?.("button, input, select, label, a")) return;
                onClickBackground(event);
            }
            : null;
        return body;
    }

    const button = (text, onClick, { primary = false, action = null } = {}) =>
        mk("button", { class: `lm-btn${primary ? " lm-primary" : ""}`, type: "button", text, onclick: onClick, dataset: action ? { lmAction: action } : undefined });

    const filePicker = () => button(t("file.pick"), () => fileInput.click(), { action: "pick-file" });

    const ui = {
        root,
        canvas,
        screen,
        settingsButton: settingsBtn,
        closeButton: closeBtn,
        onFile(fn) { onFile = fn; },
        pickFile() { fileInput.click(); },
        setMap(chart) {
            mapLine.textContent = chart ? t("map", { artist: chart.artist || "?", title: chart.title || "?", version: chart.version || "?" }) : "";
        },
        showDrop(on) { dropVeil.hidden = !on; },
        hideScreen() {
            screen.hidden = true;
            screen.replaceChildren();
            screen.onclick = null;
        },
        showLoading(text, { progress = null, onCancel = null } = {}) {
            const bar = mk("div", { class: "lm-progress" }, [mk("div", { class: "lm-progress-fill" })]);
            if (progress === null) bar.classList.add("lm-indeterminate");
            else bar.firstChild.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
            card([mk("p", { class: "lm-lead", text }), bar, onCancel ? button(t("cancel"), onCancel, { action: "cancel" }) : null]);
        },
        showFull({ loggedOut, onDownload }) {
            card([
                mk("h2", { text: t("full.title") }),
                mk("p", { text: t("full.text") }),
                loggedOut ? mk("p", { class: "lm-warn", text: t("full.loggedOut") }) : null,
                mk("div", { class: "lm-row" }, [button(t("full.download"), onDownload, { primary: true, action: "download" }), filePicker()]),
                mk("p", { class: "lm-muted lm-small", text: t("file.or") }),
            ]);
        },
        showFile() {
            card([
                mk("h2", { text: t("file.title") }),
                mk("p", { text: t("file.text") }),
                mk("div", { class: "lm-row" }, [button(t("file.pick"), () => fileInput.click(), { primary: true, action: "pick-file" })]),
            ], { cls: "lm-dropzone" });
        },
        showChoices(choices, onPick) {
            card([
                mk("h2", { text: t("choose.title") }),
                mk("p", { text: t("choose.text") }),
                mk("div", { class: "lm-list" }, choices.map((c, i) => mk("button", {
                    class: "lm-btn lm-choice", type: "button", text: c.chart.version || c.name, dataset: { lmChoice: String(i) },
                    onclick: () => onPick(c),
                }))),
            ]);
        },
        showReady({ lines, warn, onStart }) {
            card([
                mk("h2", { text: t("ready.hint") }),
                mk("ul", { class: "lm-facts" }, lines.filter(Boolean).map((line) => mk("li", { text: line }))),
                warn ? mk("p", { class: "lm-warn", text: warn }) : null,
                mk("div", { class: "lm-row" }, [button(t("ready.start"), onStart, { primary: true, action: "start" })]),
            ], { onClickBackground: onStart });
        },
        showPause({ onResume }) {
            card([
                mk("h2", { text: t("pause.title") }),
                mk("p", { text: t("pause.text") }),
                mk("div", { class: "lm-row" }, [button(t("pause.resume"), onResume, { primary: true, action: "resume" })]),
            ], { cls: "lm-translucent", onClickBackground: onResume });
        },
        showResults({ stats, ur, meanError, offsetTip, onAgain }) {
            const row = (name, value) => mk("div", { class: "lm-stat" }, [mk("span", { class: "lm-muted", text: name }), mk("b", { text: value })]);
            const counts = mk("div", { class: "lm-counts" }, ["max", "n300", "n200", "n100", "n50", "miss"].map((k) =>
                mk("div", { class: `lm-count lm-j-${k}` }, [mk("span", { text: JUDGEMENT_TEXT[k] }), mk("b", { text: String(stats[k]) })])));
            card([
                mk("h2", { text: t("results.title") }),
                mk("div", { class: "lm-big", text: stats.acc === null ? "—" : `${stats.acc.toFixed(2)}%` }),
                counts,
                row(t("results.maxCombo"), String(stats.maxCombo)),
                row(t("results.ur"), ur === null ? "—" : ur.toFixed(2)),
                meanError === null ? null : row(t("results.mean"), t("results.meanValue", { ms: Math.round(meanError) })),
                offsetTip === null ? null : mk("p", { class: "lm-muted lm-small", text: t("results.offsetTip", { ms: offsetTip }) }),
                mk("p", { class: "lm-muted", text: t("results.again") }),
                mk("div", { class: "lm-row" }, [button(t("restart"), onAgain, { primary: true, action: "again" })]),
            ]);
        },
        showError({ code, text, fallback, actions = [] }) {
            card([
                mk("h2", { text: t("err.title") }),
                mk("p", { class: "lm-lead", text, dataset: { lmErrorText: code } }),
                mk("div", { class: "lm-row" }, [
                    ...actions.map((a) => button(a.label, a.onClick, { primary: !!a.primary, action: a.action })),
                    fallback ? filePicker() : null,
                ]),
                fallback ? mk("p", { class: "lm-muted lm-small", text: t("file.or") }) : null,
            ], { cls: fallback ? "lm-dropzone" : "" });
        },
        // settings: { keys, downscroll, speed, rate, offsetMs, volume }, source; on: { change(patch), source(kind), rebind() }
        renderSettings({ settings, source, locked, rebinding = null }, on) {
            const field = (label, control, hint = null) =>
                mk("div", { class: "lm-field" }, [mk("div", { class: "lm-label", text: label }), control, hint ? mk("div", { class: "lm-muted lm-small", text: hint }) : null]);
            const seg = (name, options, value, onPick) => mk("div", { class: "lm-seg", role: "radiogroup", dataset: { lmSetting: name } },
                options.map(([v, label]) => mk("button", {
                    type: "button", class: `lm-seg-btn${v === value ? " lm-on" : ""}`, text: label, "aria-pressed": v === value ? "true" : "false",
                    disabled: locked, onclick: () => onPick(v), dataset: { value: String(v) },
                })));
            const rateSelect = mk("select", { class: "lm-select", disabled: locked, dataset: { lmSetting: "rate" }, onchange: (e) => on.change({ rate: Number(e.target.value) }) },
                RATES.map((r) => mk("option", { value: String(r), text: `${formatRate(r)}×`, selected: Math.abs(r - settings.rate) < 1e-9 })));
            const range = (name, min, max, step, value, toPatch, show) => {
                const out = mk("span", { class: "lm-range-value", text: show(value) });
                const input = mk("input", {
                    type: "range", min: String(min), max: String(max), step: String(step), value: String(value), dataset: { lmSetting: name },
                    oninput: (e) => { out.textContent = show(Number(e.target.value)); },
                    onchange: (e) => on.change(toPatch(Number(e.target.value))),
                });
                return mk("div", { class: "lm-range" }, [input, out]);
            };
            const keysRow = mk("div", { class: "lm-keys" }, [
                ...settings.keys.map((k, i) => mk("kbd", { class: rebinding && rebinding.index === i ? "lm-kbd lm-on" : "lm-kbd", text: rebinding ? (i < rebinding.index ? keyLabel(rebinding.keys[i]) : "…") : keyLabel(k) })),
                mk("button", { type: "button", class: "lm-btn lm-small-btn", text: t("settings.rebind"), disabled: locked || !!rebinding, onclick: on.rebind, dataset: { lmAction: "rebind" } }),
            ]);
            const rebindLine = rebinding
                ? mk("div", { class: rebinding.problem ? "lm-warn lm-small" : "lm-gold lm-small" }, [
                    mk("span", { text: rebinding.problem ? t(`rebind.${rebinding.problem}`) : t("rebind.prompt", { n: rebinding.index + 1 }) }),
                    mk("span", { class: "lm-muted", text: ` · ${t("rebind.cancel")}` }),
                ])
                : null;
            panel.replaceChildren(...[
                mk("h3", { text: t("settings") }),
                field(t("settings.source"), seg("source", [["preview", t("source.preview")], ["full", t("source.full")], ["file", t("source.file")]], source, on.source)),
                field(t("settings.rate"), rateSelect, t("settings.ratePitch")),
                field(t("settings.speed"), range("speed", SPEED.min, SPEED.max, 1, settings.speed, (v) => ({ speed: v }), String)),
                field(t("settings.scroll"), seg("downscroll", [[true, t("scroll.down")], [false, t("scroll.up")]], settings.downscroll, (v) => on.change({ downscroll: v }))),
                field(t("settings.keys"), keysRow, null),
                rebindLine,
                field(t("settings.offset"), range("offsetMs", OFFSET.min, OFFSET.max, 1, settings.offsetMs, (v) => ({ offsetMs: v }), (v) => t("ms", { ms: v })), t("settings.offsetHint")),
                field(t("settings.volume"), range("volume", 0, 100, 1, Math.round(settings.volume * 100), (v) => ({ volume: v / 100 }), (v) => `${v}%`)),
                mk("div", { class: "lm-row" }, [mk("button", { type: "button", class: "lm-btn lm-primary", text: t("settings.close"), onclick: on.close, dataset: { lmAction: "settings-close" } })]),
            ].filter(Boolean));
        },
        setSettingsOpen(open) {
            panel.hidden = !open;
            settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
        },
        get settingsOpen() { return !panel.hidden; },
    };
    return ui;
}
