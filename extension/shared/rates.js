// The rates the panel and the player offer: 0.8× … 1.5× in steps of 0.05 (the app's ladder goes 0.9–1.5).
export const RATES = Object.freeze(Array.from({ length: 15 }, (_, i) => (80 + i * 5) / 100));
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const rateKey = (rate) => Math.round(Number(rate) * 100) / 100;
// 1 → "1.0", 0.85 → "0.85", 1.5 → "1.5" (the UI adds "×")
export function formatRate(rate) {
    const r = rateKey(rate);
    return Number.isInteger(Math.round(r * 100) / 10) ? r.toFixed(1) : r.toFixed(2);
}
