// The skin builder's choices and their defaults, checked: shared by the builder (main) and the Skin tab's form.
// Pure, no node modules.
import { KEYS } from "./maniaFields.js";

export const SHAPES = ["circle", "bar", "arrow", "diamond"];
export const FONTS = ["round", "thin", "pixel"];
export const PATTERNS = ["1221", "1212", "1111", "1234"];
export const HOLD_STYLES = ["solid", "stripes", "fade"];
export const KEY_STYLES = ["plain", "ring", "glow"];
export const STAGE_STYLES = ["plain", "lines", "glow"];
export const JUDGEMENT_STYLES = ["numbers", "words"];
export const PARTS = ["layout", "notes", "holds", "keys", "stage", "lighting", "judgements"];

// colour sets: outer and inner columns, and four of their own for "1234"
export const PALETTES = {
    lunacy: { outer: "#f5c66b", inner: "#8fd3ff", four: ["#ff8f8f", "#8fd3ff", "#7be08f", "#f5c66b"] },
    ice: { outer: "#eef6ff", inner: "#5fb8ff", four: ["#eef6ff", "#5fb8ff", "#5fb8ff", "#eef6ff"] },
    sakura: { outer: "#ffffff", inner: "#ff8fc8", four: ["#ffd1e8", "#ff8fc8", "#ff5fa8", "#ffffff"] },
    lime: { outer: "#d9ff7a", inner: "#3fd0a0", four: ["#d9ff7a", "#3fd0a0", "#2fb0d0", "#a0ff5a"] },
    sunset: { outer: "#ffb36b", inner: "#b07cff", four: ["#ffd36b", "#ff8f6b", "#d07cff", "#8f7cff"] },
    mono: { outer: "#f0f0f0", inner: "#9a9aa8", four: ["#f0f0f0", "#c4c4ce", "#9a9aa8", "#70707e"] },
};

export const DEFAULT_OPTIONS = Object.freeze({
    name: "Lunacy 4K", author: "Player",
    shape: "circle", theme: "dark", palette: "lunacy", pattern: "1221", colours: null,
    columnWidth: 60, noteSize: 85, hitPosition: 410,
    holdStyle: "solid", bodyStyle: 1, keyStyle: "plain", stage: "lines", lighting: true,
    judgements: "numbers", font: "round",
});

const HEX = /^#[0-9a-f]{6}$/i;
const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const clampInt = (value, lo, hi, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const cleanText = (value, fallback) => {
    const s = String(value ?? "").replace(/[\r\n[\]]/g, " ").trim().slice(0, 64);
    return s || fallback;
};

// The column colours a palette and a pattern give.
export function patternColours(palette, pattern) {
    const p = PALETTES[palette] ?? PALETTES.lunacy;
    switch (pattern) {
    case "1212": return [p.outer, p.inner, p.outer, p.inner];
    case "1111": return [p.inner, p.inner, p.inner, p.inner];
    case "1234": return [...p.four];
    default: return [p.outer, p.inner, p.inner, p.outer];
    }
}

// Any request → options the builder can use (unknown values fall back to the defaults).
export function normalizeOptions(raw = {}) {
    const d = DEFAULT_OPTIONS;
    const palette = Object.hasOwn(PALETTES, raw.palette) ? raw.palette : d.palette;
    const pattern = pick(raw.pattern, PATTERNS, d.pattern);
    const own = Array.isArray(raw.colours) && raw.colours.length === KEYS && raw.colours.every((c) => HEX.test(String(c)));
    return {
        name: cleanText(raw.name, d.name), author: cleanText(raw.author, d.author),
        shape: pick(raw.shape, SHAPES, d.shape), theme: pick(raw.theme, ["dark", "light"], d.theme),
        palette, pattern,
        colours: own ? raw.colours.map((c) => c.toLowerCase()) : patternColours(palette, pattern),
        columnWidth: clampInt(raw.columnWidth, 30, 100, d.columnWidth),
        noteSize: clampInt(raw.noteSize, 50, 100, d.noteSize),
        hitPosition: clampInt(raw.hitPosition, 300, 470, d.hitPosition),
        holdStyle: pick(raw.holdStyle, HOLD_STYLES, d.holdStyle),
        bodyStyle: [0, 1, 2].includes(Number(raw.bodyStyle)) ? Number(raw.bodyStyle) : d.bodyStyle,
        keyStyle: pick(raw.keyStyle, KEY_STYLES, d.keyStyle),
        stage: pick(raw.stage, STAGE_STYLES, d.stage),
        lighting: raw.lighting === undefined ? d.lighting : Boolean(raw.lighting),
        judgements: pick(raw.judgements, JUDGEMENT_STYLES, d.judgements),
        font: pick(raw.font, FONTS, d.font),
    };
}

