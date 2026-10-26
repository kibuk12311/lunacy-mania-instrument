// Overlay settings, kept in userData\overlay.json: on/off, the results-screen option, and per widget its style,
// opacity, scale, position and which lines it shows. normalizeOverlaySettings() turns anything (an old file,
// a broken one, a patch from the settings window) into a complete, valid object.

export const STYLES = ["minimal", "card", "neon", "classic", "compact"];
export const WIDGETS = ["judgements", "kps", "keys"];
export const EDIT_HOTKEY = "CommandOrControl+Shift+O";
export const SCALE = { min: 0.5, max: 2.5 };
export const OPACITY = { min: 0.2, max: 1 };

// what each widget can show (checkboxes in the settings window), all on by default
export const SHOW = {
    judgements: ["counts", "ratio", "accuracy", "ur"],
    kps: ["now", "max", "graph"],
    keys: ["lines", "counts"],
};

// window size at scale 1 per widget and style (CSS px); minimal is smaller, compact is one line
const SIZES = {
    judgements: { default: [184, 196], minimal: [150, 150], compact: [480, 40] },
    kps: { default: [210, 128], minimal: [180, 104], compact: [250, 40] },
    keys: { default: [196, 260], compact: [240, 120] },
};

const DEFAULT_STYLE = { judgements: "card", kps: "card", keys: "card" };

export function widgetSize(widget, style, scale = 1) {
    const sizes = SIZES[widget] ?? SIZES.kps;
    const [w, h] = sizes[style] ?? sizes.default;
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

const clamp = (x, { min, max }, fallback) => (Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback);

function normalizeWidget(widget, raw) {
    const show = {};
    for (const key of SHOW[widget]) show[key] = raw?.show?.[key] !== false;
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

export function normalizeOverlaySettings(raw) {
    const widgets = {};
    for (const w of WIDGETS) widgets[w] = normalizeWidget(w, raw?.widgets?.[w]);
    return {
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
    const size = widgetSize(widget, w.style, w.scale);
    const onScreen = (x, y) => displays.some(({ workArea: a }) =>
        x + size.width > a.x + 20 && x < a.x + a.width - 20 && y >= a.y - 10 && y < a.y + a.height - 20);
    if (w.x !== null && w.y !== null && onScreen(w.x, w.y)) return { x: w.x, y: w.y, ...size };
    const a = displays[0]?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };
    const offsets = { judgements: [24, 120], kps: [24, 340], keys: [250, 120] };
    const [dx, dy] = offsets[widget] ?? [24, 24];
    return { x: a.x + dx, y: a.y + dy, ...size };
}

// "CommandOrControl+Shift+O" → "Ctrl+Shift+O", as the hint and the tray show it
export const hotkeyLabel = (accelerator = EDIT_HOTKEY) => accelerator.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");
