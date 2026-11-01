// Overlay settings, kept in userData\overlay.json: on/off, when the widgets show (a play, a pause, the results screen),
// the language of the overlay's own pages, how a dragged widget snaps; per widget its style, its look (background and
// text opacity, font, weight of the numbers, corner radius, colours), its scale, position and which lines it shows,
// and what the widget itself needs (the key lines' speed, thickness and lane colours; the graphs' length and smoothing;
// which judgements show; the map panel's picture and whether it shows while a map is being chosen); and the keyboard:
// whether osu! stable's lane keys are read from it (on out of the box) and the keys set by hand per key count (none:
// osu!'s own). normalizeOverlaySettings() turns anything (an old file, a broken one, a patch from the settings window)
// into a complete, valid object: whatever a file lacks gets its default.
// v2 (0.9.7): the Dan widget shows only the map's overall dan out of the box. 0.9.6's dan along the map ("live") is
// gone; its extras (pattern, for you, this play) were on by default then and are off now, so a 0.9.6 file that
// still had all three on (never touched) gets them off, and one where any was turned off keeps its choices.
// v3: a widget's one opacity became two, its background's and its text's: an older file's opacity goes to both (the
// widget looks as it did). Everything else new in v3 comes with its default, which draws the widgets as before.
// The map panel came later without a new version: a file that lacks it gets it with its defaults, off.
import { canonicalName, MAX_KEYS } from "./osuKeys.js";

export const STYLES = ["minimal", "card", "neon", "classic", "compact"];
export const WIDGETS = ["judgements", "kps", "nps", "keys", "dan", "map"];
// off until turned on (the others are on out of the box)
const WIDGETS_OFF = ["map"];
export const EDIT_HOTKEY = "CommandOrControl+Shift+O";
export const SCALE = { min: 0.5, max: 2.5 };
export const BG_OPACITY = { min: 0, max: 1 };
export const TEXT_OPACITY = { min: 0.2, max: 1 };
export const OPACITY = { min: 0.2, max: 1 }; // the one opacity of v2 and before
export const RADIUS = { min: 0, max: 24 }; // px at scale 1; null: the style's own
export const LANGS = ["app", "ru", "en"]; // "app": the app's language
export const GRID = { min: 0, max: 100 }; // the drag grid step in px (0: none)
// key lines: how fast the presses go up (1: LANE_SPAN_BASE_MS from bottom to top) and how much of its lane a bar fills
export const SPEED = { min: 0.5, max: 3 };
export const THICKNESS = { min: 0.2, max: 1 };
// graphs: seconds of KPS shown; seconds of the map around the playhead (0: the whole map); the smoothing window, s
export const KPS_GRAPH = { min: 3, max: 30 };
export const NPS_GRAPH = { min: 0, max: 120 };
export const NPS_GRAPH_MIN = 10; // a window shorter than this is the whole map
export const SMOOTH = { min: 0.2, max: 2 };
export const DEFAULT_SMOOTH = 0.8; // the meters' own (twice kps.js HALF_MS)
export const DEFAULT_KPS_GRAPH = 10;
// the map panel's picture: its blur in px at scale 1 and how much it is dimmed
export const MAP_BLUR = { min: 0, max: 24 };
export const MAP_DIM = { min: 0, max: 0.9 };
const DEFAULT_MAP_BLUR = 8;
const DEFAULT_MAP_DIM = 0.55;
// fonts: the style's own (null) or one of these, all on any Windows
export const FONTS = {
    segoe: '"Segoe UI", system-ui, sans-serif',
    bahnschrift: 'Bahnschrift, "Segoe UI", sans-serif',
    arial: "Arial, sans-serif",
    arialBlack: '"Arial Black", "Segoe UI Black", sans-serif',
    trebuchet: '"Trebuchet MS", "Segoe UI", sans-serif',
    tahoma: 'Tahoma, "Segoe UI", sans-serif',
    consolas: 'Consolas, "Courier New", monospace',
    impact: 'Impact, "Arial Black", sans-serif',
};
export const FONT_NAMES = {
    segoe: "Segoe UI", bahnschrift: "Bahnschrift", arial: "Arial", arialBlack: "Arial Black", trebuchet: "Trebuchet MS",
    tahoma: "Tahoma", consolas: "Consolas", impact: "Impact",
};
export const WEIGHTS = [0, 400, 600, 700, 800, 900]; // of the numbers; 0: the style's own
// the judgements in order, as the widget's rows and colours name them
export const JUDGEMENT_KEYS = ["max", "n300", "n200", "n100", "n50", "miss"];
// the look "apply to every widget" copies
export const LOOK_KEYS = ["style", "bgOpacity", "textOpacity", "font", "weight", "radius"];

export const SETTINGS_VERSION = 3;

// what each widget can show (checkboxes in the settings window), on by default but for SHOW_OFF
export const SHOW = {
    judgements: ["counts", "ratio", "accuracy", "ur"],
    kps: ["now", "max", "graph"],
    nps: ["now", "peak", "graph"],
    keys: ["lines", "counts"],
    // the map's overall dan; the extras: its main pattern (and how sure), "for you", the play's own dan
    dan: ["map", "pattern", "forYou", "play"],
    // the map panel: its picture, the map's names, its numbers, the dan, how far the play is
    map: ["background", "title", "artist", "difficulty", "mapper", "stars", "dan", "bpm", "length", "rate", "mods", "progress"],
};
// lines off until turned on
export const SHOW_OFF = { dan: ["pattern", "forYou", "play"] };

// window size at scale 1 per widget and style (CSS px); minimal is smaller, compact is one line. The Dan widget's is
// its head (the overall dan) and grows by DAN_LINE per extra line shown (one line taller, or wider in compact); the
// judgements widget's has room for all six counts and loses JUDGEMENT_ROW per count hidden, in one line that count's own
// width (JUDGEMENT_ONE_LINE: what is left keeps its room). Each is wide enough for three digits in every number
// (overlay.css and app/overlay/render.js give them their boxes) in the style's own font, in Russian too, except the keys
// widget above 5 keys: its size does not follow the key count, so its columns get narrower than a count's three digits
// and the count is drawn smaller.
const SIZES = {
    judgements: { default: [192, 196], minimal: [172, 150], classic: [210, 196], compact: [625, 40] },
    kps: { default: [210, 128], minimal: [180, 104], compact: [250, 40] },
    nps: { default: [210, 128], minimal: [180, 104], compact: [250, 40] },
    keys: { default: [196, 260], compact: [240, 120] },
    dan: { default: [220, 64], minimal: [196, 56], compact: [230, 40] },
};
const DAN_LINE = { default: [0, 20], minimal: [0, 18], compact: [160, 0] };
const JUDGEMENT_ROW = { default: 18, minimal: 16, classic: 21 };
const JUDGEMENT_ONE_LINE = { max: 66, n300: 60, n200: 52, n100: 52, n50: 46, miss: 60 };
// The map panel is as tall as the lines it shows: the title across the whole width, the artist and the difficulty with
// the stars and the dan at the right beside them, the line of numbers, the progress bar. In the compact style it is one
// line, as wide as what is on it.
const MAP_LINES = {
    default: { width: 340, pad: 18, title: 23, artist: 17, diff: 16, stats: 21, bar: 9, side: 19 },
    minimal: { width: 300, pad: 10, title: 20, artist: 15, diff: 14, stats: 17, bar: 7, side: 17 },
    classic: { width: 340, pad: 14, title: 25, artist: 18, diff: 17, stats: 22, bar: 9, side: 20 },
};
const MAP_ONE_LINE = { title: 150, artist: 90, difficulty: 80, mapper: 64, stars: 48, dan: 100, bpm: 56, length: 70, rate: 38, mods: 42 };
const MAP_STATS = ["bpm", "length", "rate", "mods"];

function mapSize(style, show) {
    const on = (key) => show?.[key] !== false;
    if (style === "compact") {
        const width = Object.keys(MAP_ONE_LINE).reduce((sum, key) => sum + (on(key) ? MAP_ONE_LINE[key] : 0), 32);
        return [Math.max(160, width), 40];
    }
    const l = MAP_LINES[style] ?? MAP_LINES.default;
    const names = (on("artist") ? l.artist : 0) + (on("difficulty") || on("mapper") ? l.diff : 0);
    const side = ((on("stars") ? 1 : 0) + (on("dan") ? 1 : 0)) * l.side;
    const stats = MAP_STATS.some(on) ? l.stats : 0;
    return [l.width, Math.max(40, l.pad + (on("title") ? l.title : 0) + Math.max(names, side) + stats + (on("progress") ? l.bar : 0))];
}

const DEFAULT_STYLE = { judgements: "card", kps: "card", nps: "card", keys: "card", dan: "card", map: "card" };

// show: the widget's lines (the Dan widget's size follows how many it shows; without them, all of them); rows: the
// judgements shown (without them, all six)
export function widgetSize(widget, style, scale = 1, show = null, rows = null) {
    if (widget === "map") {
        const [mw, mh] = mapSize(style, show);
        return { width: Math.round(mw * scale), height: Math.round(mh * scale) };
    }
    const sizes = SIZES[widget] ?? SIZES.kps;
    let [w, h] = sizes[style] ?? sizes.default;
    if (widget === "dan") {
        const extras = SHOW_OFF.dan.filter((key) => (show ? show[key] === true : true)).length;
        const [dw, dh] = DAN_LINE[style] ?? DAN_LINE.default;
        w += dw * extras;
        h += dh * extras;
    }
    if (widget === "judgements" && rows && show?.counts !== false) {
        const hidden = JUDGEMENT_KEYS.filter((key) => rows[key] === false).slice(0, 5);
        if (style === "compact") w -= hidden.reduce((sum, key) => sum + JUDGEMENT_ONE_LINE[key], 0);
        else h -= (JUDGEMENT_ROW[style] ?? JUDGEMENT_ROW.default) * hidden.length;
    }
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// a widget's window size from its settings (at its own scale, or the one given)
export const sizeOf = (widget, w, scale = w.scale) => widgetSize(widget, w.style, scale, w.show, w.rows ?? null);

const clamp = (x, { min, max }, fallback) => (Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback);
const round2 = (x) => Math.round(x * 100) / 100;
export const cleanColor = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
const npsGraph = (x) => {
    const s = clamp(Math.round(x), NPS_GRAPH, 0);
    return s < NPS_GRAPH_MIN ? 0 : s;
};

// the lane colours set by hand per key count: { "4": ["#ff0000", null, null, "#00ff00"] } (null: the style's)
function cleanLaneColors(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (let k = 1; k <= MAX_KEYS; k += 1) {
        const list = raw[k] ?? raw[String(k)];
        if (!Array.isArray(list)) continue;
        const colors = Array.from({ length: k }, (_, i) => cleanColor(list[i]));
        if (colors.some(Boolean)) out[k] = colors;
    }
    return out;
}

// what only one widget has
const EXTRA = {
    judgements: (raw) => {
        const rows = {};
        const colors = {};
        for (const key of JUDGEMENT_KEYS) {
            rows[key] = raw?.rows?.[key] !== false;
            colors[key] = cleanColor(raw?.colors?.[key]);
        }
        // at least one count stays (hiding them all is the "counts" line off)
        if (!JUDGEMENT_KEYS.some((key) => rows[key])) rows.max = true;
        return { rows, colors };
    },
    kps: (raw) => ({
        graphColor: cleanColor(raw?.graphColor),
        graphSec: clamp(Math.round(raw?.graphSec), KPS_GRAPH, DEFAULT_KPS_GRAPH),
        smoothSec: round2(clamp(raw?.smoothSec, SMOOTH, DEFAULT_SMOOTH)),
    }),
    nps: (raw) => ({
        graphColor: cleanColor(raw?.graphColor),
        graphSec: Number.isFinite(raw?.graphSec) ? npsGraph(raw.graphSec) : 0,
        smoothSec: round2(clamp(raw?.smoothSec, SMOOTH, DEFAULT_SMOOTH)),
    }),
    keys: (raw) => ({
        speed: round2(clamp(raw?.speed, SPEED, 1)),
        thickness: round2(clamp(raw?.thickness, THICKNESS, 1)),
        laneColors: cleanLaneColors(raw?.laneColors),
    }),
    dan: () => ({}),
    map: (raw) => ({
        graphColor: cleanColor(raw?.graphColor), // the progress bar's
        bgBlur: clamp(Math.round(raw?.bgBlur), MAP_BLUR, DEFAULT_MAP_BLUR),
        bgDim: round2(clamp(raw?.bgDim, MAP_DIM, DEFAULT_MAP_DIM)),
        inSelect: raw?.inSelect !== false, // also while a map is being chosen
    }),
};

function normalizeWidget(widget, raw) {
    const show = {};
    const off = SHOW_OFF[widget] ?? [];
    for (const key of SHOW[widget]) show[key] = off.includes(key) ? raw?.show?.[key] === true : raw?.show?.[key] !== false;
    const radius = raw?.radius === null || raw?.radius === undefined ? null : clamp(Math.round(raw.radius), RADIUS, null);
    return {
        enabled: WIDGETS_OFF.includes(widget) ? raw?.enabled === true : raw?.enabled !== false,
        style: STYLES.includes(raw?.style) ? raw.style : DEFAULT_STYLE[widget],
        bgOpacity: round2(clamp(raw?.bgOpacity, BG_OPACITY, 1)),
        textOpacity: round2(clamp(raw?.textOpacity, TEXT_OPACITY, 1)),
        font: Object.hasOwn(FONTS, raw?.font ?? "") ? raw.font : null, // null: the style's own
        weight: WEIGHTS.includes(raw?.weight) ? raw.weight : 0, // 0: the style's own
        radius,
        scale: round2(clamp(raw?.scale, SCALE, 1)),
        // null: not placed yet (the manager puts it near the top-left corner of the primary screen)
        x: Number.isFinite(raw?.x) ? Math.round(raw.x) : null,
        y: Number.isFinite(raw?.y) ? Math.round(raw.y) : null,
        show,
        ...EXTRA[widget](raw),
    };
}

// A file from before v2 (0.9.6 and older): the Dan widget's lines as 0.9.6 read them (all on unless turned off), its
// extras off if none was turned off, "live" dropped. From before v3: a widget's opacity goes to its background and
// its text.
export function migrateOverlaySettings(raw) {
    if (!raw || typeof raw !== "object" || raw.v >= SETTINGS_VERSION) return raw;
    let out = raw;
    const dan = raw.widgets?.dan;
    if (!(raw.v >= 2) && dan && typeof dan === "object") {
        const old = dan.show && typeof dan.show === "object" ? dan.show : {};
        const extras = SHOW_OFF.dan;
        const untouched = extras.every((key) => old[key] !== false);
        const show = { map: old.map !== false };
        for (const key of extras) show[key] = untouched ? false : old[key] !== false;
        out = { ...out, widgets: { ...out.widgets, dan: { ...dan, show } } };
    }
    const old = out.widgets && typeof out.widgets === "object"
        ? Object.values(out.widgets).some((w) => w && typeof w === "object" && Number.isFinite(w.opacity)) : false;
    if (old) {
        const widgets = { ...out.widgets };
        for (const [name, w] of Object.entries(widgets)) {
            if (!w || typeof w !== "object" || !Number.isFinite(w.opacity)) continue;
            const { opacity, ...rest } = w;
            const o = clamp(opacity, OPACITY, 1);
            widgets[name] = { ...rest, bgOpacity: rest.bgOpacity ?? o, textOpacity: rest.textOpacity ?? o };
        }
        out = { ...out, widgets };
    }
    return out;
}

// keys set by hand: { "4": ["A", "S", "OemSemicolon", "OemQuotes"] } — a whole layout of known keys, each once, or nothing
export function cleanManualKeys(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (let k = 1; k <= MAX_KEYS; k += 1) {
        const list = raw[k] ?? raw[String(k)];
        if (!Array.isArray(list) || list.length !== k) continue;
        const names = list.map(canonicalName);
        if (names.every(Boolean) && new Set(names).size === k) out[k] = names;
    }
    return out;
}

const normalizeKeyboard = (raw) => ({
    enabled: raw?.enabled !== false, // on out of the box
    keys: cleanManualKeys(raw?.keys),
});

// An overlay.json from before a widget existed gets that widget with its defaults, the rest kept.
export function normalizeOverlaySettings(input) {
    const raw = migrateOverlaySettings(input);
    const widgets = {};
    for (const w of WIDGETS) widgets[w] = normalizeWidget(w, raw?.widgets?.[w]);
    return {
        v: SETTINGS_VERSION,
        enabled: raw?.enabled === true, // off until turned on
        lang: LANGS.includes(raw?.lang) ? raw.lang : "app",
        showInPlay: raw?.showInPlay !== false,
        showInPause: raw?.showInPause !== false,
        showOnResults: raw?.showOnResults !== false,
        snapEdges: raw?.snapEdges !== false,
        gridStep: clamp(Math.round(raw?.gridStep), GRID, 0),
        widgets,
        keyboard: normalizeKeyboard(raw?.keyboard),
    };
}

const WIDGET_KEYS = [
    "enabled", "style", "bgOpacity", "textOpacity", "font", "weight", "radius", "scale", "x", "y",
    "graphColor", "graphSec", "smoothSec", "speed", "thickness", "bgBlur", "bgDim", "inSelect",
];

// a patch from the settings window applied to the current settings: { enabled }, { widgets: { kps: { style } } }, …
// Objects inside a widget (show, rows, colors) merge; laneColors merge per key count ({ 4: null } drops the count's).
export function applyPatch(current, patch) {
    const next = structuredClone(current);
    const p0 = patch && typeof patch === "object" ? patch : {};
    for (const key of ["enabled", "showInPlay", "showInPause", "showOnResults", "snapEdges"]) if (typeof p0[key] === "boolean") next[key] = p0[key];
    if ("lang" in p0) next.lang = p0.lang;
    if ("gridStep" in p0) next.gridStep = p0.gridStep;
    // { keyboard: { enabled } }, { keyboard: { keys: { 4: [names] } } } sets a layout, { 4: null } gives it back to osu!
    const kb = p0.keyboard;
    if (kb && typeof kb === "object") {
        if (typeof kb.enabled === "boolean") next.keyboard.enabled = kb.enabled;
        if (kb.keys && typeof kb.keys === "object") {
            for (const [k, list] of Object.entries(kb.keys)) {
                if (list === null) delete next.keyboard.keys[k];
                else next.keyboard.keys[k] = list;
            }
        }
    }
    for (const w of WIDGETS) {
        const p = p0.widgets?.[w];
        if (!p || typeof p !== "object") continue;
        const target = next.widgets[w];
        for (const key of WIDGET_KEYS) if (key in p && key in target) target[key] = p[key];
        for (const key of ["show", "rows", "colors"]) {
            if (p[key] && typeof p[key] === "object" && target[key]) Object.assign(target[key], p[key]);
        }
        if (p.laneColors && typeof p.laneColors === "object" && target.laneColors) {
            for (const [k, list] of Object.entries(p.laneColors)) {
                if (list === null) delete target.laneColors[k];
                else target.laneColors[k] = list;
            }
        }
    }
    return normalizeOverlaySettings(next);
}

// the patch that gives every widget the look of widget `from` (its style, opacities, font, weight, radius)
export function lookPatch(settings, from) {
    const w = settings.widgets[from];
    const look = Object.fromEntries(LOOK_KEYS.map((key) => [key, w[key]]));
    return { widgets: Object.fromEntries(WIDGETS.map((name) => [name, { ...look }])) };
}

// What a session (src/overlay/session.js configure()) and the made-up snapshot (src/overlay/fake.js) take from the
// settings: the KPS graph's length and smoothing, the NPS's smoothing and its window around the playhead (0: the
// whole map), the key lines' span (real ms from the bottom to the top).
export const LANE_SPAN_BASE_MS = 1500;
export function sessionOptions(settings) {
    const { kps, nps, keys } = settings.widgets;
    return {
        kpsHistoryMs: kps.graphSec * 1000,
        kpsHalfMs: Math.round((kps.smoothSec * 1000) / 2),
        npsHalfMs: Math.round((nps.smoothSec * 1000) / 2),
        npsWindowMs: nps.graphSec * 1000,
        laneSpanMs: Math.round(LANE_SPAN_BASE_MS / keys.speed),
    };
}

// two rectangles ({ x, y, width, height }) have pixels in common
export const overlaps = (a, b) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
    && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

// the work area a window is mostly on (displays = [{ workArea }], primary first)
export function areaOf(bounds, displays) {
    let best = displays[0]?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };
    let most = 0;
    for (const { workArea: a } of displays) {
        const w = Math.max(0, Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x));
        const h = Math.max(0, Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y));
        if (w * h > most) {
            most = w * h;
            best = a;
        }
    }
    return best;
}

export const SNAP_PX = 14; // an edge of the work area this near (px) is snapped to

// A widget let go at bounds → where it goes: on the grid of its work area (gridStep px; 0: none), then onto an edge
// of the work area within SNAP_PX (snapEdges). → { x, y }
export function snapPosition(bounds, displays, { snapEdges = true, gridStep = 0 } = {}) {
    const a = areaOf(bounds, displays);
    let { x, y } = bounds;
    if (gridStep > 0) {
        x = a.x + Math.round((x - a.x) / gridStep) * gridStep;
        y = a.y + Math.round((y - a.y) / gridStep) * gridStep;
    }
    if (snapEdges) {
        const right = a.x + a.width - bounds.width;
        const bottom = a.y + a.height - bounds.height;
        if (Math.abs(bounds.x - a.x) <= SNAP_PX) x = a.x;
        else if (Math.abs(bounds.x - right) <= SNAP_PX) x = right;
        if (Math.abs(bounds.y - a.y) <= SNAP_PX) y = a.y;
        else if (Math.abs(bounds.y - bottom) <= SNAP_PX) y = bottom;
    }
    return { x: Math.round(x), y: Math.round(y) };
}

// is all of the box on the screens? (across two is fine, and so is the taskbar: a fullscreen game has none)
function wholeOnScreens(box, displays) {
    const on = (x, y) => displays.some(({ workArea, bounds = workArea }) =>
        x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height);
    const [right, bottom] = [box.x + box.width - 1, box.y + box.height - 1];
    return on(box.x, box.y) && on(right, box.y) && on(box.x, bottom) && on(right, bottom);
}

// the whole screen the box is mostly on
function screenOf(box, displays) {
    const area = areaOf(box, displays);
    return displays.find(({ workArea }) => workArea === area)?.bounds ?? area;
}

// A window larger than the screen it is on (a big scale on a small one) is only as large as that screen, from its edge:
// what is in it draws smaller to fit (app/overlay/render.js fitNode()). Across two screens it may stay.
// → { x, y, width, height }
export function withinScreen(box, displays) {
    if (wholeOnScreens(box, displays)) return box;
    const home = screenOf(box, displays);
    const [wide, tall] = [box.width > home.width, box.height > home.height];
    return { x: wide ? home.x : box.x, y: tall ? home.y : box.y, width: wide ? home.width : box.width, height: tall ? home.height : box.height };
}

// A window at bounds taking a new size: its top-left corner stays, but one sitting on the right or bottom edge of its
// work area stays on that edge (it grows to the left or upwards). → { x, y, width, height }
export function resizeAnchored(bounds, size, displays) {
    const a = areaOf(bounds, displays);
    let { x, y } = bounds;
    if (bounds.x > a.x && Math.abs(bounds.x + bounds.width - (a.x + a.width)) <= 1) x = Math.max(a.x, a.x + a.width - size.width);
    if (bounds.y > a.y && Math.abs(bounds.y + bounds.height - (a.y + a.height)) <= 1) y = Math.max(a.y, a.y + a.height - size.height);
    return withinScreen({ x, y, width: size.width, height: size.height }, displays);
}

// where an unplaced widget goes, and whether a saved spot is still on a screen; displays = [{ workArea, bounds }],
// primary first. A saved spot its window no longer fits in (a bigger scale set while it had no window to move, a smaller
// screen) comes back inside that screen, and one larger than the screen fills it (withinScreen()). Across two screens it
// may stay, and over the taskbar (a fullscreen game has none).
// scale: the one its window has (the settings window keeps the widgets at theirs while it is open)
export function placeWidget(widget, settings, displays, scale = settings.widgets[widget].scale) {
    const w = settings.widgets[widget];
    const size = sizeOf(widget, w, scale);
    const onScreen = (x, y) => displays.some(({ workArea: a }) =>
        x + size.width > a.x + 20 && x < a.x + a.width - 20 && y >= a.y - 10 && y < a.y + a.height - 20);
    if (w.x !== null && w.y !== null && onScreen(w.x, w.y)) {
        const box = { x: w.x, y: w.y, ...size };
        if (wholeOnScreens(box, displays)) return box;
        const home = screenOf(box, displays);
        const fitted = withinScreen(box, displays);
        const inside = (at, length, from, room) => Math.max(from, Math.min(at, from + room - length));
        return { ...fitted, x: inside(fitted.x, fitted.width, home.x, home.width), y: inside(fitted.y, fitted.height, home.y, home.height) };
    }
    const a = displays[0]?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };
    const offsets = { judgements: [24, 120], kps: [24, 340], nps: [24, 490], keys: [250, 120], dan: [250, 400], map: [480, 120] };
    const [dx, dy] = offsets[widget] ?? [24, 24];
    return withinScreen({ x: a.x + dx, y: a.y + dy, ...size }, displays);
}

// the language the overlay's pages use: its own setting, else the app's
export const overlayLang = (setting, appLang) => (setting === "ru" || setting === "en" ? setting : appLang === "en" ? "en" : "ru");

// "CommandOrControl+Shift+O" → "Ctrl+Shift+O", as the hint and the tray show it
export const hotkeyLabel = (accelerator = EDIT_HOTKEY) => accelerator.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");
