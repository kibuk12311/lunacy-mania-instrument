// Window position/size, the two toggles, the language and the automatic update check, kept in a small JSON file in userData.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LANGS } from "../src/i18n/i18n.js";

export const DEFAULT_WINDOW = { width: 320, height: 380, alwaysOnTop: false, compact: false, autoUpdate: true };

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
    const state = {
        width: Number.isFinite(saved.width) ? saved.width : DEFAULT_WINDOW.width,
        height: Number.isFinite(saved.height) ? saved.height : DEFAULT_WINDOW.height,
        alwaysOnTop: saved.alwaysOnTop === true,
        compact: saved.compact === true,
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
    const { x, y, width, height, alwaysOnTop, compact, lang = null, autoUpdate = true } = state;
    writeFileSync(file, JSON.stringify({ x, y, width, height, alwaysOnTop, compact, lang, autoUpdate: autoUpdate !== false }), "utf8");
}
