// Player settings in chrome.storage.local under "lm.player.v1" (extension/DESIGN.md §5.6), always clamped.
import { RATES, rateKey } from "../shared/rates.js";
import { DEFAULT_KEYS, validKeys } from "./input.js";

export const STORAGE_KEY = "lm.player.v1";
export const SPEED = Object.freeze({ min: 10, max: 40, initial: 24 });
export const OFFSET = Object.freeze({ min: -300, max: 300 });

export const DEFAULTS = Object.freeze({
    keys: DEFAULT_KEYS,
    downscroll: true,
    speed: SPEED.initial,
    rate: 1,
    offsetMs: 0,
    volume: 0.6,
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The nearest offered rate (RATES), or null for something that is not a number.
export function snapRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    let best = RATES[0];
    for (const r of RATES) if (Math.abs(r - n) < Math.abs(best - n)) best = r;
    return rateKey(best);
}

export function clampSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);
    const speed = num(s.speed);
    const offset = num(s.offsetMs);
    const volume = num(s.volume);
    return {
        keys: validKeys(s.keys) ? [...s.keys] : [...DEFAULTS.keys],
        downscroll: typeof s.downscroll === "boolean" ? s.downscroll : DEFAULTS.downscroll,
        speed: Number.isFinite(speed) ? clamp(Math.round(speed), SPEED.min, SPEED.max) : DEFAULTS.speed,
        rate: snapRate(s.rate) ?? DEFAULTS.rate,
        offsetMs: Number.isFinite(offset) ? clamp(Math.round(offset), OFFSET.min, OFFSET.max) : DEFAULTS.offsetMs,
        volume: Number.isFinite(volume) ? clamp(Math.round(volume * 100) / 100, 0, 1) : DEFAULTS.volume,
    };
}

// storage: chrome.storage.local-like ({ get(key) → Promise<{[key]: value}>, set(obj) → Promise }), or null.
export async function loadSettings(storage) {
    try {
        const got = await storage?.get?.(STORAGE_KEY);
        return clampSettings(got?.[STORAGE_KEY]);
    } catch {
        return clampSettings(null);
    }
}

export async function saveSettings(storage, settings) {
    const value = clampSettings(settings);
    try {
        await storage?.set?.({ [STORAGE_KEY]: value });
    } catch { /* storage gone (extension reloaded): the settings still apply for this session */ }
    return value;
}

// In-memory stand-in when chrome.storage is not there.
export function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
        async set(obj) { Object.assign(data, structuredClone(obj)); },
        data,
    };
}
