// The overlay settings window: on/off, when the widgets show (a play, a pause, the results screen), the overlay's
// language, snapping to the screen's edges and the drag grid, the edit mode, the keyboard (osu! stable's lane keys:
// read or not, the keys of a key count and where they come from, a key set by hand per lane), and a card per widget
// (on/off, style, background and text opacity, size, what it shows; under "more settings" its font, digit weight,
// corner radius, colours and what only it has: the judgements shown, the graphs' length and smoothing, the key lines'
// speed, thickness and column colours, the map panel's picture) with a live preview at the size set, then every style
// side by side. All numbers are made up.
// The page speaks the overlay's language (its own setting, else the app's); main builds it again when that changes.
// The widgets over the game keep their size while this window is open (main): only the previews here show a new one,
// and each says the size it stands for, whether it is drawn smaller here, and whether that size is still waiting.
// A lane's key is set by clicking it and pressing the key here, in this window (nothing else hears it).
import { LANG_NAMES, applyI18n, setLang, t } from "../../src/i18n/i18n.js";
import { keyLabel, nameOfKeyEvent } from "../../src/overlay/osuKeys.js";
import { fakeSnapshot } from "../../src/overlay/fake.js";
import { createPaintLoop } from "../../src/overlay/paintLoop.js";
import { JUDGEMENT_COLORS, STYLE_RADIUS, laneColor, paletteFor } from "../../src/overlay/draw.js";
import {
    BG_OPACITY, FONT_NAMES, FONTS, JUDGEMENT_KEYS, KPS_GRAPH, MAP_BLUR, MAP_DIM, NPS_GRAPH, RADIUS, SCALE, SHOW, SMOOTH,
    SPEED, STYLES, TEXT_OPACITY, THICKNESS, WEIGHTS, WIDGETS, hotkeyLabel, lookPatch, overlayLang, sessionOptions, sizeOf,
    widgetSize,
} from "../../src/overlay/settings.js";
import { mountWidget } from "./render.js";

const api = window.overlayApi;
setLang(api.lang);

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
const MAP_TEXT = {
    background: "overlay.show.mapBackground", title: "overlay.show.mapTitle", artist: "overlay.show.mapArtist",
    difficulty: "overlay.show.mapDifficulty", mapper: "overlay.show.mapMapper", stars: "overlay.show.mapStars",
    dan: "overlay.show.mapDan", bpm: "overlay.show.mapBpm", length: "overlay.show.mapLength", rate: "overlay.show.mapRate",
    mods: "overlay.show.mapMods", progress: "overlay.show.mapProgress",
};
// a line's text; the graphs' say how long they are
function showText(widget, key, w) {
    if (widget === "keys" && key === "counts") return t("overlay.show.keyCounts");
    if (widget === "dan") return t(DAN_TEXT[key]);
    if (widget === "map") return t(MAP_TEXT[key]);
    if (widget === "kps" && key === "graph") return t("overlay.show.graph", { n: w.graphSec });
    if (widget === "nps" && key === "graph") return w.graphSec > 0 ? t("overlay.show.npsWindow", { n: w.graphSec }) : t("overlay.show.npsGraph");
    return t(widget === "nps" ? NPS_TEXT[key] : SHOW_TEXT[key]);
}
const JUDGEMENT_LABELS = { max: "MAX", n300: "300", n200: "200", n100: "100", n50: "50", miss: () => t("overlay.label.miss") };
const GRID_STEPS = [0, 5, 10, 16, 20, 25, 32, 50];
const CARD_WIDTH = 568; // a card at the window's size, before it is on the page
const CARD_PADDING = 48; // the card's and the stage's padding and borders
const BESIDE_WIDTH = 230; // a preview wider than this goes under the controls, not beside them
const KEY_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const ECHO_MS = 400; // a slider just moved here: main's answers to it come back within this

let settings = null;
let edit = false;
let held = []; // the widgets whose new size waits for this window to close
// the keyboard block: the key count shown, what main says of its keys, the lane waiting for a key, a layout being set
let kbdCount = null;
let kbdInfo = null;
let waiting = null;
let draft = null; // { keys, names } while a layout no one knows is being set lane by lane
let kbdSig = null; // the keyboard settings and the reader's state last asked about
const previews = []; // { widget, view, own } painted every frame while the window is on screen (own: a card's)
const cards = {};

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}
const options = () => (settings ? sessionOptions(settings) : {});

const set = (patch) => api.set(patch).then((r) => render(r));
const setWidget = (widget, patch) => set({ widgets: { [widget]: patch } });

// a widget drawn at its real size in a box of its own, zoomed as asked, with its look (null: the style's)
function preview(widget, style, show, zoom, look = null) {
    const frame = el("div", "frame");
    const size = look ? sizeOf(widget, look, 1) : widgetSize(widget, style, 1, show);
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    frame.style.zoom = String(zoom);
    const view = mountWidget(frame, widget, { style, show, zoom, look });
    view.update(fakeSnapshot(performance.now(), look ? options() : {}));
    return { frame, view };
}

// A range slider: its label, the value as text (format), set(v) from the settings (left alone for a moment after the
// hand moved it: an older value coming back must not pull it away; it follows any other change, a widget's own corner).
function slider(label, { min, max, step, value, format, onInput }) {
    const row = el("label", "slider");
    const input = el("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const shown = el("span", "", format(value));
    let moved = -Infinity;
    input.addEventListener("input", () => {
        moved = performance.now();
        const v = Number(input.value);
        shown.textContent = format(v);
        onInput(v);
    });
    row.append(el("span", "", label), input, shown);
    return {
        row,
        set(v, text = format(v)) {
            if (performance.now() - moved < ECHO_MS) return;
            input.value = String(v);
            shown.textContent = text;
        },
    };
}
const percent = (range, value, labelKey, onInput) => slider(t(labelKey), {
    min: Math.round(range.min * 100), max: Math.round(range.max * 100), step: 5, value: Math.round(value * 100),
    format: (v) => `${v}%`, onInput: (v) => onInput(v / 100),
});

// a select of [value, text] (values as strings in the DOM)
function select(label, choices, onChange) {
    const row = el("label", "field");
    const box = el("select");
    for (const [value, text] of choices) {
        const option = el("option", "", text);
        option.value = String(value);
        box.append(option);
    }
    box.addEventListener("change", () => onChange(box.value));
    row.append(el("span", "", label), box, el("span"));
    return { row, set: (v) => { box.value = String(v); } };
}

// a colour of its own or the style's (shown, marked as not set): set(own, fallback); onInput(colour)
function colorPick(title, onInput) {
    const input = el("input");
    input.type = "color";
    input.title = title;
    input.addEventListener("input", () => onInput(input.value));
    return {
        input,
        set(own, fallback) {
            if (document.activeElement !== input) input.value = own ?? fallback;
            input.classList?.toggle("own", Boolean(own));
        },
    };
}

function smallButton(text, onClick, title) {
    const b = el("button", "small", text);
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
}

const secText = (v) => t("overlay.set.sec", { n: Number.isInteger(v) ? v : v.toFixed(1) });

// ---- what only one widget has ("more settings") ----

function judgementExtras(widget, body) {
    const grid = el("div", "jrows");
    const rows = JUDGEMENT_KEYS.map((key) => {
        const row = el("label", "jrow");
        const box = el("input");
        box.type = "checkbox";
        box.addEventListener("change", () => setWidget(widget, { rows: { [key]: box.checked } }));
        const label = JUDGEMENT_LABELS[key];
        const pick = colorPick(t("overlay.set.colorTip"), (c) => setWidget(widget, { colors: { [key]: c } }));
        row.append(box, el("span", "name", typeof label === "function" ? label() : label), pick.input);
        grid.append(row);
        return { key, box, pick };
    });
    const reset = smallButton(t("overlay.set.reset"), () => setWidget(widget, { colors: Object.fromEntries(JUDGEMENT_KEYS.map((k) => [k, null])) }),
        t("overlay.set.resetTip"));
    const resetRow = el("div", "colors");
    resetRow.append(reset);
    body.append(el("div", "sub-head", t("overlay.set.rows")), grid, resetRow);
    return (w) => {
        const own = JUDGEMENT_COLORS[w.style] ?? JUDGEMENT_COLORS.card;
        for (const r of rows) {
            r.box.checked = w.rows[r.key];
            r.pick.set(w.colors[r.key], own[r.key]);
        }
    };
}

// a graph's colour with its reset
function graphColor(widget, body, fallback, label = "overlay.set.graphColor") {
    const row = el("div", "field");
    const pick = colorPick(t("overlay.set.colorTip"), (c) => setWidget(widget, { graphColor: c }));
    const line = el("div", "colors");
    line.append(pick.input, smallButton(t("overlay.set.reset"), () => setWidget(widget, { graphColor: null }), t("overlay.set.resetTip")));
    row.append(el("span", "", t(label)), line, el("span"));
    body.append(row);
    return (w) => pick.set(w.graphColor, fallback(w.style));
}

function smoothSlider(widget, body, value) {
    return slider(t("overlay.set.smooth"), {
        min: SMOOTH.min, max: SMOOTH.max, step: 0.1, value, format: secText,
        onInput: (v) => setWidget(widget, { smoothSec: Math.round(v * 10) / 10 }),
    });
}

function kpsExtras(widget, body, w0) {
    const colour = graphColor(widget, body, (style) => paletteFor(style).graph);
    const length = slider(t("overlay.set.graphSec"), {
        min: KPS_GRAPH.min, max: KPS_GRAPH.max, step: 1, value: w0.graphSec, format: secText,
        onInput: (v) => setWidget(widget, { graphSec: v }),
    });
    const smooth = smoothSlider(widget, body, w0.smoothSec);
    body.append(length.row, smooth.row, el("p", "hint", t("overlay.set.smoothNote")));
    return (w) => {
        colour(w);
        length.set(w.graphSec);
        smooth.set(w.smoothSec);
    };
}

function npsExtras(widget, body, w0) {
    const colour = graphColor(widget, body, (style) => paletteFor(style).nps);
    const fmt = (v) => (v > 0 ? secText(v) : t("overlay.set.wholeMap"));
    const length = slider(t("overlay.set.graphSec"), {
        min: NPS_GRAPH.min, max: NPS_GRAPH.max, step: 10, value: w0.graphSec, format: fmt,
        onInput: (v) => setWidget(widget, { graphSec: v }),
    });
    const smooth = smoothSlider(widget, body, w0.smoothSec);
    body.append(length.row, smooth.row);
    return (w) => {
        colour(w);
        length.set(w.graphSec);
        smooth.set(w.smoothSec);
    };
}

function keysExtras(widget, body, w0) {
    const speed = slider(t("overlay.set.speed"), {
        min: SPEED.min, max: SPEED.max, step: 0.1, value: w0.speed, format: (v) => `${v.toFixed(1)}×`,
        onInput: (v) => setWidget(widget, { speed: Math.round(v * 10) / 10 }),
    });
    const thick = slider(t("overlay.set.thickness"), {
        min: THICKNESS.min * 100, max: THICKNESS.max * 100, step: 5, value: Math.round(w0.thickness * 100), format: (v) => `${v}%`,
        onInput: (v) => setWidget(widget, { thickness: v / 100 }),
    });
    // the column colours of one key count
    let count = 4;
    const row = el("div", "field");
    const line = el("div", "colors");
    const countBox = el("select");
    for (const n of KEY_COUNTS) {
        const option = el("option", "", t("overlay.set.keysCount", { n }));
        option.value = String(n);
        countBox.append(option);
    }
    countBox.value = String(count);
    const lanesBox = el("div", "colors");
    let picks = [];
    let last = null;
    const build = () => {
        picks = Array.from({ length: count }, (_, col) => {
            const wrap = el("label", "lane-pick");
            const pick = colorPick(`${col + 1}`, (c) => {
                const now = settings.widgets[widget].laneColors[count] ?? Array(count).fill(null);
                const next = [...now];
                next[col] = c;
                setWidget(widget, { laneColors: { [count]: next } });
            });
            wrap.append(pick.input, el("span", "", String(col + 1)));
            return { wrap, pick };
        });
        lanesBox.replaceChildren(...picks.map((p) => p.wrap));
    };
    countBox.addEventListener("change", () => {
        count = Number(countBox.value);
        build();
        if (last) paint(last);
    });
    build();
    line.append(countBox, lanesBox, smallButton(t("overlay.set.reset"), () => setWidget(widget, { laneColors: { [count]: null } }), t("overlay.set.resetTip")));
    row.append(el("span", "", t("overlay.set.laneColors")), line, el("span"));
    body.append(speed.row, thick.row, row);
    function paint(w) {
        last = w;
        picks.forEach(({ pick }, col) => pick.set(w.laneColors[count]?.[col] ?? null, laneColor(w.style, col)));
    }
    return (w) => {
        speed.set(w.speed);
        thick.set(Math.round(w.thickness * 100));
        paint(w);
    };
}

function mapExtras(widget, body, w0) {
    const colour = graphColor(widget, body, (style) => paletteFor(style).graph, "overlay.set.barColor");
    const blur = slider(t("overlay.set.mapBlur"), {
        min: MAP_BLUR.min, max: MAP_BLUR.max, step: 1, value: w0.bgBlur, format: (v) => `${v} px`,
        onInput: (v) => setWidget(widget, { bgBlur: v }),
    });
    const dim = percent(MAP_DIM, w0.bgDim, "overlay.set.mapDim", (v) => setWidget(widget, { bgDim: v }));
    const box = el("input");
    box.type = "checkbox";
    box.addEventListener("change", () => setWidget(widget, { inSelect: box.checked }));
    const select = el("label", "check");
    select.append(box, el("span", "", t("overlay.set.mapSelect")));
    body.append(blur.row, dim.row, select);
    return (w) => {
        colour(w);
        blur.set(w.bgBlur);
        dim.set(Math.round(w.bgDim * 100));
        box.checked = w.inSelect;
    };
}

const EXTRAS = { judgements: judgementExtras, kps: kpsExtras, nps: npsExtras, keys: keysExtras, map: mapExtras };

// the look every widget has: font, digit weight, corner radius
function lookControls(widget, body, w0) {
    const font = select(t("overlay.set.font"), [["", t("overlay.set.styleOwn")], ...Object.keys(FONTS).map((k) => [k, FONT_NAMES[k]])],
        (v) => setWidget(widget, { font: v || null }));
    const weight = select(t("overlay.set.weight"), WEIGHTS.map((n) => [n, n ? `${n} — ${t(`overlay.set.w${n}`)}` : t("overlay.set.styleOwn")]),
        (v) => setWidget(widget, { weight: Number(v) }));
    const radius = slider(t("overlay.set.radius"), {
        min: RADIUS.min, max: RADIUS.max, step: 1, value: w0.radius ?? 0, format: (v) => `${v} px`,
        onInput: (v) => setWidget(widget, { radius: v }),
    });
    const resetRadius = smallButton("↺", () => setWidget(widget, { radius: null }), t("overlay.set.resetTip"));
    radius.row.append(resetRadius);
    radius.row.classList?.add("with-reset");
    body.append(font.row, weight.row, radius.row);
    return (w) => {
        font.set(w.font ?? "");
        weight.set(w.weight);
        const own = widget === "keys" && w.style === "compact" ? 12 : STYLE_RADIUS[w.style] ?? 0;
        radius.set(w.radius ?? own, w.radius === null ? t("overlay.set.styleOwn") : `${w.radius} px`);
    };
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
    const bg = percent(BG_OPACITY, w0.bgOpacity, "overlay.set.bgOpacity", (v) => setWidget(widget, { bgOpacity: v }));
    const text = percent(TEXT_OPACITY, w0.textOpacity, "overlay.set.textOpacity", (v) => setWidget(widget, { textOpacity: v }));
    const scale = percent(SCALE, w0.scale, "overlay.set.scale", (v) => setWidget(widget, { scale: v }));
    const shows = el("div", "shows");
    const showBoxes = SHOW[widget].map((key) => {
        const box = el("input");
        box.type = "checkbox";
        box.addEventListener("change", () => setWidget(widget, { show: { [key]: box.checked } }));
        const label = el("label", "check");
        const span = el("span", "", showText(widget, key, w0));
        label.append(box, span);
        shows.append(label);
        return { key, box, span };
    });
    controls.append(el("div", "", t("overlay.set.style")), styleRow, bg.row, text.row, scale.row, shows);
    if (widget === "keys") controls.append(el("p", "hint", t("overlay.set.keysNote")));
    if (widget === "nps") controls.append(el("p", "hint", t("overlay.set.npsNote")));
    if (widget === "dan") controls.append(el("p", "hint", t("overlay.set.danNote")));
    if (widget === "map") controls.append(el("p", "hint", t("overlay.set.mapNote")));
    const stage = el("div", "stage");
    const note = el("div", "view-note");
    const view = el("div", "view");
    view.append(stage, note);

    // more settings: the look, what only this widget has, the look for every widget
    const more = el("details", "more");
    more.append(el("summary", "", t("overlay.set.more")));
    const body = el("div", "more-body");
    more.append(body);
    const look = lookControls(widget, body, w0);
    const extra = EXTRAS[widget]?.(widget, body, w0) ?? (() => {});
    const all = smallButton(t("overlay.set.applyAll"), () => set(lookPatch(settings, widget)), t("overlay.set.applyAllTip"));
    const allRow = el("div", "colors");
    allRow.append(all);
    body.append(allRow);

    card.append(title, controls, view, more);
    $("widgets").append(card);
    cards[widget] = { card, on, styleButtons, bg, text, scale, showBoxes, stage, note, look, extra, key: "" };
}

function renderCard(widget) {
    const c = cards[widget];
    const w = settings.widgets[widget];
    c.card.classList.toggle("off", !w.enabled);
    c.on.checked = w.enabled;
    for (const { style, b } of c.styleButtons) b.classList.toggle("sel", style === w.style);
    c.bg.set(Math.round(w.bgOpacity * 100));
    c.text.set(Math.round(w.textOpacity * 100));
    c.scale.set(Math.round(w.scale * 100));
    for (const { key, box, span } of c.showBoxes) {
        box.checked = w.show[key];
        span.textContent = showText(widget, key, w);
    }
    c.look(w);
    c.extra(w);
    // the preview at the size set; one too wide for the card is drawn smaller, and says so
    const size = sizeOf(widget, w);
    const base = sizeOf(widget, w, 1);
    const room = Math.max(160, (c.card.clientWidth || CARD_WIDTH) - CARD_PADDING);
    const zoom = Math.min(w.scale, room / base.width);
    c.card.classList.toggle("wide", base.width * zoom > BESIDE_WIDTH);
    const words = [t("overlay.set.previewSize", { w: size.width, h: size.height })];
    if (zoom < w.scale - 0.005) words.push(t("overlay.set.previewSmaller"));
    if (held.includes(widget)) words.push(t("overlay.set.previewHeld"));
    c.note.textContent = words.join(" · ");
    const key = JSON.stringify([{ ...w, x: 0, y: 0, enabled: true }, options(), zoom]);
    if (key === c.key) return;
    c.key = key;
    const p = preview(widget, w.style, w.show, zoom, w);
    c.stage.replaceChildren(p.frame);
    const i = previews.findIndex((x) => x.widget === widget);
    if (i >= 0) previews.splice(i, 1);
    previews.push({ widget, view: p.view, own: true });
}

function buildGallery() {
    for (const style of STYLES) {
        const row = el("div", "grow");
        const stage = el("div", "stage");
        for (const widget of WIDGETS) {
            const show = Object.fromEntries(SHOW[widget].map((k) => [k, true]));
            const p = preview(widget, style, show, 0.8);
            stage.append(p.frame);
            previews.push({ widget: `gallery-${style}-${widget}`, view: p.view, own: false });
        }
        row.append(el("div", "name", t(`overlay.style.${style}`)), stage);
        $("gallery").append(row);
    }
}

// ---- the general block ----

function buildGeneral() {
    const lang = $("lang");
    for (const [value, text] of [["app", t("overlay.set.langApp")], ["ru", LANG_NAMES.ru], ["en", LANG_NAMES.en]]) {
        const option = el("option", "", text);
        option.value = value;
        lang.append(option);
    }
    const grid = $("grid");
    for (const n of GRID_STEPS) {
        const option = el("option", "", n ? t("overlay.set.px", { n }) : t("overlay.set.gridOff"));
        option.value = String(n);
        grid.append(option);
    }
    $("pauseLabel").title = t("overlay.set.pauseTip");
    $("hint").textContent = t("overlay.set.hint", { hotkey: hotkeyLabel() });
}

// ---- the keyboard ----

const FROM = {
    osu: "overlay.kbd.fromOsu", osuDefault: "overlay.kbd.fromOsuDefault", default: "overlay.kbd.fromDefault", manual: "overlay.kbd.fromManual",
};

async function refreshKeys() {
    if (!api.keys) return;
    try {
        kbdInfo = await api.keys(kbdCount);
    } catch {
        return;
    }
    kbdCount = kbdInfo.keys;
    if (draft && draft.keys !== kbdCount) draft = null;
    renderKeys();
}

// the names shown per lane: a layout being set, else the one in use (else none known)
const laneNames = () => draft?.names ?? kbdInfo?.effective?.names ?? Array(kbdCount ?? 4).fill(null);

function renderKeys() {
    if (!settings) return;
    const on = settings.keyboard.enabled;
    $("kbdOn").checked = on;
    document.querySelector?.(".keyboard")?.classList.toggle("off", !on);
    const select = $("kbdCount");
    if (!select.children?.length) {
        for (const n of KEY_COUNTS) {
            const option = el("option", "", `${n}K`);
            option.value = String(n);
            select.append(option);
        }
    }
    select.value = String(kbdCount ?? 4);
    const names = laneNames();
    $("kbdLanes").replaceChildren(...names.map((name, col) => {
        const b = el("button", waiting === col ? "wait" : "", waiting === col ? t("overlay.kbd.press") : name ? keyLabel(name) : "?");
        b.title = `${col + 1}`;
        b.addEventListener("click", () => {
            waiting = waiting === col ? null : col;
            renderKeys();
        });
        return b;
    }));
    const source = draft ? null : kbdInfo?.effective?.source;
    const from = source ? t(FROM[source]) : t("overlay.kbd.unknown");
    $("kbdFrom").textContent = source === "osu" && kbdInfo.file ? `${from} (${kbdInfo.file})` : from;
    $("kbdReset").hidden = !kbdInfo?.manual && !draft;
    const state = kbdInfo?.reader;
    $("kbdHint").textContent = state === "missing" ? t("overlay.kbd.missing") : state === "error" ? t("overlay.kbd.failed") : t("overlay.kbd.rebind");
}

// a key pressed while a lane waits for one: that lane gets it (a lane that had it gets this lane's old key)
function onKeyDown(event) {
    if (waiting === null) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    if (event.keyCode === 27) {
        waiting = null;
        renderKeys();
        return;
    }
    const name = nameOfKeyEvent(event);
    if (!name) return;
    const names = [...laneNames()];
    const col = waiting;
    const other = names.indexOf(name);
    if (other >= 0 && other !== col) names[other] = names[col];
    names[col] = name;
    waiting = null;
    if (names.every(Boolean)) {
        draft = null;
        set({ keyboard: { keys: { [kbdCount]: names } } });
    } else {
        draft = { keys: kbdCount, names };
        renderKeys();
    }
}

function render(payload) {
    settings = payload.settings;
    edit = payload.edit;
    held = payload.held ?? [];
    $("enabled").checked = settings.enabled;
    $("play").checked = settings.showInPlay;
    $("pause").checked = settings.showInPause;
    $("results").checked = settings.showOnResults;
    $("lang").value = settings.lang;
    $("grid").value = String(GRID_STEPS.includes(settings.gridStep) ? settings.gridStep : 0);
    $("snap").checked = settings.snapEdges;
    const button = $("edit");
    button.textContent = edit ? t("overlay.set.editDone") : `${t("overlay.set.edit")} (${hotkeyLabel()})`;
    button.classList.toggle("on", edit);
    if (!cards.judgements) WIDGETS.forEach(buildCard);
    WIDGETS.forEach(renderCard);
    renderKeys();
    // main is asked again only when the keyboard settings or the reader changed (not for every slider step)
    const sig = JSON.stringify([settings.keyboard, payload.reader ?? null]);
    if (sig !== kbdSig) {
        kbdSig = sig;
        refreshKeys();
    }
}

$("enabled").addEventListener("change", (e) => set({ enabled: e.target.checked }));
$("play").addEventListener("change", (e) => set({ showInPlay: e.target.checked }));
$("pause").addEventListener("change", (e) => set({ showInPause: e.target.checked }));
$("results").addEventListener("change", (e) => set({ showOnResults: e.target.checked }));
$("lang").addEventListener("change", (e) => set({ lang: e.target.value }));
$("grid").addEventListener("change", (e) => set({ gridStep: Number(e.target.value) }));
$("snap").addEventListener("change", (e) => set({ snapEdges: e.target.checked }));
$("edit").addEventListener("click", () => api.setEdit(!edit));
$("kbdOn").addEventListener("change", (e) => set({ keyboard: { enabled: e.target.checked } }));
$("kbdCount").addEventListener("change", (e) => {
    kbdCount = Number(e.target.value);
    waiting = null;
    draft = null;
    refreshKeys();
});
$("kbdReset").addEventListener("click", () => {
    waiting = null;
    draft = null;
    set({ keyboard: { keys: { [kbdCount]: null } } });
});
document.addEventListener("keydown", onKeyDown, true);
// a window of another width has room for another preview
window.addEventListener("resize", () => { if (cards.judgements) WIDGETS.forEach(renderCard); });

// the previews move every frame while the window is on screen, and stop while it is minimized or hidden; the cards'
// follow the graphs' and the key lines' settings, the gallery shows every style as it comes
let lastUpdate = 0;
const loop = createPaintLoop({
    paint(now) {
        if (now - lastUpdate > 100) {
            const own = fakeSnapshot(now, options());
            const plain = fakeSnapshot(now);
            for (const p of previews) p.view.update(p.own ? own : plain);
            lastUpdate = now;
        }
        for (const p of previews) p.view.paint(now);
        return false;
    },
    live: () => true,
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (id) => cancelAnimationFrame(id),
});
const onScreen = () => loop.setVisible(document.visibilityState === "visible");
document.addEventListener("visibilitychange", onScreen);

// the page is built once the settings are in: in the overlay's language
api.get().then((payload) => {
    const lang = overlayLang(payload.settings?.lang, api.lang);
    setLang(lang);
    document.documentElement.lang = lang;
    applyI18n(document);
    document.title = t("overlay.window.title");
    buildGeneral();
    api.onSettings(render);
    render(payload);
    buildGallery();
    onScreen();
});
