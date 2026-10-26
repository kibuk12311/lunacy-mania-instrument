// Window position/size, always on top, the language and the automatic update check, kept in a small JSON file in userData.
// The compact mode is gone (0.9.6, the in-game overlay does its job): a window.json saved in it opens at the normal size.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LANGS } from "../src/i18n/i18n.js";

// 0.9.8: big enough for the whole analysis tab (card, difficulty line, dan by part, the ladder) without scrolling
export const DEFAULT_WINDOW = { width: 440, height: 820, alwaysOnTop: false, autoUpdate: true };
// a window.json from before 0.9.8 (no `size` mark) that is smaller than the new default grows to it once
const SIZE_VERSION = 2;

function centred(size, displays) {
    const area = displays[0].workArea;
    return { x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + (area.height - size.height) / 2) };
}

function isVisible(state, displays) {
    return displays.some(({ workArea: a }) =>
        state.x >= a.x - state.width / 2 && state.x < a.x + a.width - 40
        && state.y >= a.y - 10 && state.y < a.y + a.height - 40);
}

// `displays` = screen.getAllDisplays(), primary first.
export function loadWindowState(file, displays) {
    let saved = {};
    try {
        saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        saved = {};
    }
    const old = saved.size !== SIZE_VERSION;
    const area = displays[0].workArea;
    // never taller or wider than the screen's work area (a laptop's 768 px screen gets the window that fits)
    const fit = (v, max) => Math.max(200, Math.min(v, max));
    let width = Number.isFinite(saved.width) ? saved.width : DEFAULT_WINDOW.width;
    let height = Number.isFinite(saved.height) ? saved.height : DEFAULT_WINDOW.height;
    // saved in the old compact mode, or by a version with the small window: grown to the new default once
    if (old || saved.compact === true) {
        width = Math.max(width, DEFAULT_WINDOW.width);
        height = Math.max(height, DEFAULT_WINDOW.height);
    }
    const state = {
        width: fit(width, area.width - 20),
        height: fit(height, area.height - 20),
        alwaysOnTop: saved.alwaysOnTop === true,
        lang: LANGS.includes(saved.lang) ? saved.lang : null,
        // on unless turned off: a window.json from before this setting has no field and checks
        autoUpdate: saved.autoUpdate !== false,
    };
    const pos = Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : null;
    const placed = pos && isVisible({ ...state, ...pos }, displays) ? pos : centred(state, displays);
    return { x: placed.x, y: placed.y, ...state };
}

export function saveWindowState(file, state) {
    mkdirSync(path.dirname(file), { recursive: true });
    const { x, y, width, height, alwaysOnTop, lang = null, autoUpdate = true } = state;
    writeFileSync(file, JSON.stringify({ x, y, width, height, alwaysOnTop: alwaysOnTop === true, lang, autoUpdate: autoUpdate !== false, size: SIZE_VERSION }), "utf8");
}
