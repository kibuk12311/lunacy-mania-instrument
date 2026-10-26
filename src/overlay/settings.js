// Overlay settings, kept in userData\overlay.json: on/off, the results-screen option, and per widget its style,
// opacity, scale, position and which lines it shows. normalizeOverlaySettings() turns anything (an old file,
// a broken one, a patch from the settings window) into a complete, valid object.
// v2 (0.9.7): the Dan widget shows only the map's overall dan out of the box. 0.9.6's dan along the map ("live") is
// gone; its extras (pattern, for you, this play) were on by default then and are off now, so a 0.9.6 file that
// still had all three on (never touched) gets them off, and one where any was turned off keeps its choices.

export const STYLES = ["minimal", "card", "neon", "classic", "compact"];
export const WIDGETS = ["judgements", "kps", "nps", "keys", "dan"];
export const EDIT_HOTKEY = "CommandOrControl+Shift+O";
export const SCALE = { min: 0.5, max: 2.5 };
export const OPACITY = { min: 0.2, max: 1 };

export const SETTINGS_VERSION = 2;

// what each widget can show (checkboxes in the settings window), on by default but for SHOW_OFF
export const SHOW = {
    judgements: ["counts", "ratio", "accuracy", "ur"],
    kps: ["now", "max", "graph"],
    nps: ["now", "peak", "graph"],
    keys: ["lines", "counts"],
    // the map's overall dan; the extras: its main pattern (and how sure), "for you", the play's own dan
    dan: ["map", "pattern", "forYou", "play"],
};
// lines off until turned on
export const SHOW_OFF = { dan: ["pattern", "forYou", "play"] };

// window size at scale 1 per widget and style (CSS px); minimal is smaller, compact is one line. The Dan widget's is
// its head (the overall dan) and grows by DAN_LINE per extra line shown (one line taller, or wider in compact).
const SIZES = {
    judgements: { default: [184, 196], minimal: [150, 150], compact: [480, 40] },
    kps: { default: [210, 128], minimal: [180, 104], compact: [250, 40] },
    nps: { default: [210, 128], minimal: [180, 104], compact: [250, 40] },
    keys: { default: [196, 260], compact: [240, 120] },
    dan: { default: [220, 64], minimal: [196, 56], compact: [230, 40] },
};
const DAN_LINE = { default: [0, 20], minimal: [0, 18], compact: [160, 0] };

const DEFAULT_STYLE = { judgements: "card", kps: "card", nps: "card", keys: "card", dan: "card" };

// show: the widget's lines (the Dan widget's size follows how many it shows; without them, all of them)
export function widgetSize(widget, style, scale = 1, show = null) {
    const sizes = SIZES[widget] ?? SIZES.kps;
    let [w, h] = sizes[style] ?? sizes.default;
    if (widget === "dan") {
        const extras = SHOW_OFF.dan.filter((key) => (show ? show[key] === true : true)).length;
        const [dw, dh] = DAN_LINE[style] ?? DAN_LINE.default;
        w += dw * extras;
        h += dh * extras;
    }
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

const clamp = (x, { min, max }, fallback) => (Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback);

function normalizeWidget(widget, raw) {
    const show = {};
    const off = SHOW_OFF[widget] ?? [];
    for (const key of SHOW[widget]) show[key] = off.includes(key) ? raw?.show?.[key] === true : raw?.show?.[key] !== false;
    return {
        enabled: raw?.enabled !== false,
        style: STYLES.includes(raw?.style) ? raw.style : DEFAULT_STYLE[widget],
        opacity: clamp(raw?.opacity, OPACITY, 1),
        scale: Math.round(clamp(raw?.scale, SCALE, 1) * 100) / 100,
        // null: not placed yet (the manager puts it near the top-left corner of the primary screen)
        x: Number.isFinite(raw?.x) ? Math.round(raw.x) : null,
        y: Number.isFinite(raw?.y) ? Math.round(raw.y) : null,
        show,
    };
}

// A file from before v2 (0.9.6 and older): the Dan widget's lines as 0.9.6 read them (all on unless turned off), its
// extras off if none was turned off, "live" dropped.
export function migrateOverlaySettings(raw) {
    if (!raw || typeof raw !== "object" || raw.v >= SETTINGS_VERSION) return raw;
    const dan = raw.widgets?.dan;
    if (!dan || typeof dan !== "object") return raw;
    const old = dan.show && typeof dan.show === "object" ? dan.show : {};
    const extras = SHOW_OFF.dan;
    const untouched = extras.every((key) => old[key] !== false);
    const show = { map: old.map !== false };
    for (const key of extras) show[key] = untouched ? false : old[key] !== false;
    return { ...raw, widgets: { ...raw.widgets, dan: { ...dan, show } } };
}

// An overlay.json from before a widget existed gets that widget with its defaults (on, like the others), the rest kept.
export function normalizeOverlaySettings(input) {
    const raw = migrateOverlaySettings(input);
    const widgets = {};
    for (const w of WIDGETS) widgets[w] = normalizeWidget(w, raw?.widgets?.[w]);
    return {
        v: SETTINGS_VERSION,
        enabled: raw?.enabled === true, // off until turned on
        showOnResults: raw?.showOnResults !== false,
        widgets,
    };
}

// a patch from the settings window applied to the current settings: { enabled }, { widgets: { kps: { style } } }, …
export function applyPatch(current, patch) {
    const next = structuredClone(current);
    if (typeof patch?.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch?.showOnResults === "boolean") next.showOnResults = patch.showOnResults;
    for (const w of WIDGETS) {
        const p = patch?.widgets?.[w];
        if (!p || typeof p !== "object") continue;
        for (const key of ["enabled", "style", "opacity", "scale", "x", "y"]) if (key in p) next.widgets[w][key] = p[key];
        if (p.show && typeof p.show === "object") Object.assign(next.widgets[w].show, p.show);
    }
    return normalizeOverlaySettings(next);
}

// where an unplaced widget goes, and whether a saved spot is still on a screen; displays = [{ workArea }], primary first
export function placeWidget(widget, settings, displays) {
    const w = settings.widgets[widget];
    const size = widgetSize(widget, w.style, w.scale, w.show);
    const onScreen = (x, y) => displays.some(({ workArea: a }) =>
        x + size.width > a.x + 20 && x < a.x + a.width - 20 && y >= a.y - 10 && y < a.y + a.height - 20);
    if (w.x !== null && w.y !== null && onScreen(w.x, w.y)) return { x: w.x, y: w.y, ...size };
    const a = displays[0]?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };
    const offsets = { judgements: [24, 120], kps: [24, 340], nps: [24, 490], keys: [250, 120], dan: [250, 400] };
    const [dx, dy] = offsets[widget] ?? [24, 24];
    return { x: a.x + dx, y: a.y + dy, ...size };
}

// "CommandOrControl+Shift+O" → "Ctrl+Shift+O", as the hint and the tray show it
export const hotkeyLabel = (accelerator = EDIT_HOTKEY) => accelerator.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");
