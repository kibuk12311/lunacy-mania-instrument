// Saved rate-tab settings ("presets"): { rate, pitch, od|null, hp|null, mirror, noLn }. null OD/HP keep the map's own.
import { t } from "../i18n/i18n.js";
import { rateText } from "./rateMap.js";

export const MAX_PRESETS = 12;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const toNumber = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

function diff(v) {
    const x = toNumber(v);
    return Number.isFinite(x) ? Math.round(clamp(x, 0, 10) * 10) / 10 : null;
}

// One preset in its clean form, or null when it cannot be one (no rate).
function normalizePreset(p) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const rate = toNumber(p.rate);
    if (!Number.isFinite(rate)) return null;
    return {
        rate: Math.round(clamp(rate, 0.5, 2) * 100) / 100,
        pitch: p.pitch === true,
        od: diff(p.od),
        hp: diff(p.hp),
        mirror: p.mirror === true,
        noLn: p.noLn === true,
    };
}

export function samePreset(a, b) {
    const x = normalizePreset(a);
    const y = normalizePreset(b);
    return Boolean(x && y) && Object.keys(x).every((k) => x[k] === y[k]);
}

// Bad entries are dropped, values clamped, the same preset kept once (the first), at most MAX_PRESETS.
export function normalizePresets(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const p = normalizePreset(raw);
        if (p && !out.some((q) => samePreset(q, p))) out.push(p);
        if (out.length >= MAX_PRESETS) break;
    }
    return out;
}

// The chip text: "×1.3 · NC · OD 8 · Mirror".
export function presetLabel(p) {
    const q = normalizePreset(p);
    if (!q) return "";
    return [
        `×${rateText(q.rate)}`,
        q.pitch && "NC",
        q.od !== null && `OD ${q.od}`,
        q.hp !== null && `HP ${q.hp}`,
        q.mirror && t("rate.option.mirror"),
        q.noLn && t("rate.option.noLn"),
    ].filter(Boolean).join(" · ");
}
