// The overlay settings window: on/off, the results screen, the edit mode, and a card per widget (on/off, style,
// opacity, size, what it shows) with a live preview, then every style side by side. All numbers are made up.
import { applyI18n, setLang, t } from "../../src/i18n/i18n.js";
import { fakeSnapshot } from "../../src/overlay/fake.js";
import { OPACITY, SCALE, SHOW, STYLES, WIDGETS, hotkeyLabel, widgetSize } from "../../src/overlay/settings.js";
import { mountWidget } from "./render.js";

const api = window.overlayApi;
setLang(api.lang);
document.documentElement.lang = api.lang;
applyI18n(document);
document.title = t("overlay.window.title");

const SHOW_TEXT = {
    counts: "overlay.show.counts", ratio: "overlay.show.ratio", accuracy: "overlay.show.accuracy", ur: "overlay.show.ur",
    now: "overlay.show.now", max: "overlay.show.max", graph: "overlay.show.graph",
    lines: "overlay.show.lines",
};
// the key widget's "counts" is per key; the NPS widget's lines are about the map
const NPS_TEXT = { now: "overlay.show.npsNow", peak: "overlay.show.peak", graph: "overlay.show.npsGraph" };
const DAN_TEXT = {
    map: "overlay.show.danMap", pattern: "overlay.show.danPattern",
    forYou: "overlay.show.danForYou", play: "overlay.show.danPlay",
};
const showText = (widget, key) => {
    if (widget === "keys" && key === "counts") return "overlay.show.keyCounts";
    if (widget === "dan") return DAN_TEXT[key];
    return widget === "nps" ? NPS_TEXT[key] : SHOW_TEXT[key];
};

let settings = null;
let edit = false;
const previews = []; // { view, key } painted every frame
const cards = {};

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

const set = (patch) => api.set(patch).then((r) => render(r));
const setWidget = (widget, patch) => set({ widgets: { [widget]: patch } });

// a widget drawn at its real size in a box of its own, zoomed as asked
function preview(widget, style, show, zoom) {
    const frame = el("div", "frame");
    const size = widgetSize(widget, style, 1, show);
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    frame.style.zoom = String(zoom);
    const view = mountWidget(frame, widget, { style, show, zoom });
    view.update(fakeSnapshot(performance.now()));
    return { frame, view };
}

function slider(labelKey, range, value, onInput) {
    const row = el("label", "slider");
    const input = el("input");
    input.type = "range";
    input.min = String(Math.round(range.min * 100));
    input.max = String(Math.round(range.max * 100));
    input.step = "5";
    input.value = String(Math.round(value * 100));
    const shown = el("span", "", `${input.value}%`);
    input.addEventListener("input", () => {
        shown.textContent = `${input.value}%`;
        onInput(Number(input.value) / 100);
    });
    row.append(el("span", "", t(labelKey)), input, shown);
    return { row, set: (v) => { if (document.activeElement !== input) { input.value = String(Math.round(v * 100)); shown.textContent = `${input.value}%`; } } };
}

function buildCard(widget) {
    const card = el("section", "wcard");
    const title = el("h3");
    const on = el("input");
    on.type = "checkbox";
    on.addEventListener("change", () => setWidget(widget, { enabled: on.checked }));
    const onLabel = el("label", "check keep");
    onLabel.append(on, el("span", "", t("overlay.set.show")));
    title.append(el("span", "", t(`overlay.widget.${widget}`)), onLabel);

    const controls = el("div", "controls");
    const styleRow = el("div", "styles");
    const styleButtons = STYLES.map((style) => {
        const b = el("button", "", t(`overlay.style.${style}`));
        b.addEventListener("click", () => setWidget(widget, { style }));
        styleRow.append(b);
        return { style, b };
    });
    const w0 = settings.widgets[widget];
    const opacity = slider("overlay.set.opacity", OPACITY, w0.opacity, (v) => setWidget(widget, { opacity: v }));
    const scale = slider("overlay.set.scale", SCALE, w0.scale, (v) => setWidget(widget, { scale: v }));
    const shows = el("div", "shows");
    const showBoxes = SHOW[widget].map((key) => {
        const box = el("input");
        box.type = "checkbox";
        box.addEventListener("change", () => setWidget(widget, { show: { [key]: box.checked } }));
        const label = el("label", "check");
        label.append(box, el("span", "", t(showText(widget, key))));
        shows.append(label);
        return { key, box };
    });
    controls.append(el("div", "", t("overlay.set.style")), styleRow, opacity.row, scale.row, shows);
    if (widget === "keys") controls.append(el("p", "hint", t("overlay.set.keysNote")));
    if (widget === "nps") controls.append(el("p", "hint", t("overlay.set.npsNote")));
    if (widget === "dan") controls.append(el("p", "hint", t("overlay.set.danNote")));
    const stage = el("div", "stage");
    card.append(title, controls, stage);
    $("widgets").append(card);
    cards[widget] = { card, on, styleButtons, opacity, scale, showBoxes, stage, key: "" };
}

function renderCard(widget) {
    const c = cards[widget];
    const w = settings.widgets[widget];
    c.card.classList.toggle("off", !w.enabled);
    c.on.checked = w.enabled;
    for (const { style, b } of c.styleButtons) b.classList.toggle("sel", style === w.style);
    c.opacity.set(w.opacity);
    c.scale.set(w.scale);
    for (const { key, box } of c.showBoxes) box.checked = w.show[key];
    const key = JSON.stringify([w.style, w.show, w.scale, w.opacity]);
    if (key === c.key) return;
    c.key = key;
    const zoom = Math.min(w.scale, 1.4);
    const p = preview(widget, w.style, w.show, zoom);
    p.frame.style.opacity = String(w.opacity);
    c.stage.replaceChildren(p.frame);
    const i = previews.findIndex((x) => x.widget === widget);
    if (i >= 0) previews.splice(i, 1);
    previews.push({ widget, view: p.view });
}

function buildGallery() {
    for (const style of STYLES) {
        const row = el("div", "grow");
        const stage = el("div", "stage");
        for (const widget of WIDGETS) {
            const show = Object.fromEntries(SHOW[widget].map((k) => [k, true]));
            const p = preview(widget, style, show, 0.8);
            stage.append(p.frame);
            previews.push({ widget: `gallery-${style}-${widget}`, view: p.view });
        }
        row.append(el("div", "name", t(`overlay.style.${style}`)), stage);
        $("gallery").append(row);
    }
}

function render(payload) {
    settings = payload.settings;
    edit = payload.edit;
    $("enabled").checked = settings.enabled;
    $("results").checked = settings.showOnResults;
    const button = $("edit");
    button.textContent = edit ? t("overlay.set.editDone") : `${t("overlay.set.edit")} (${hotkeyLabel()})`;
    button.classList.toggle("on", edit);
    if (!cards.judgements) WIDGETS.forEach(buildCard);
    WIDGETS.forEach(renderCard);
}

$("hint").textContent = t("overlay.set.hint", { hotkey: hotkeyLabel() });
$("enabled").addEventListener("change", (e) => set({ enabled: e.target.checked }));
$("results").addEventListener("change", (e) => set({ showOnResults: e.target.checked }));
$("edit").addEventListener("click", () => api.setEdit(!edit));
api.onSettings(render);

let lastUpdate = 0;
function frame(now) {
    if (now - lastUpdate > 100) {
        const fake = fakeSnapshot(now);
        for (const p of previews) p.view.update(fake);
        lastUpdate = now;
    }
    for (const p of previews) p.view.paint(now);
    requestAnimationFrame(frame);
}

api.get().then((payload) => {
    render(payload);
    buildGallery();
    requestAnimationFrame(frame);
});
