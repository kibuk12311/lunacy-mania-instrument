// Numbers the overlay widgets show, as text: the MAX:300 ratio, accuracy, unstable rate, keys per second.
// Pure functions; the same ones run in the widget windows and in the settings preview.

const DASH = "—";
const finite = (x) => typeof x === "number" && Number.isFinite(x);

// 421 MAX and 100 300s → "4.21:1"; no 300s yet → "∞" (or "—" before the first note); 1000:1 and up drop the decimals.
export function formatRatio(max, n300) {
    const a = Math.max(0, Number(max) || 0);
    const b = Math.max(0, Number(n300) || 0);
    if (b === 0) return a > 0 ? "∞" : DASH;
    const r = a / b;
    return `${r >= 1000 ? Math.round(r) : r.toFixed(2)}:1`;
}

// osu!stable mania accuracy in percent: MAX and 300 both count as 300, then 200, 100, 50, miss 0. null before any judgement.
export function maniaAccuracy({ max = 0, n300 = 0, n200 = 0, n100 = 0, n50 = 0, miss = 0 } = {}) {
    const total = max + n300 + n200 + n100 + n50 + miss;
    if (!(total > 0)) return null;
    return (100 * (300 * (max + n300) + 200 * n200 + 100 * n100 + 50 * n50)) / (300 * total);
}

export function formatAccuracy(acc) {
    return finite(acc) ? `${Math.min(100, Math.max(0, acc)).toFixed(2)}%` : DASH;
}

// Unstable rate from hit errors in ms: ten times their standard deviation (as osu! counts it). null with fewer than two.
export function unstableRate(errors) {
    const list = Array.isArray(errors) ? errors.filter(finite) : [];
    if (list.length < 2) return null;
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    const variance = list.reduce((s, x) => s + (x - mean) ** 2, 0) / list.length;
    return Math.sqrt(variance) * 10;
}

export function formatUr(ur) {
    return finite(ur) && ur > 0 ? ur.toFixed(2) : DASH;
}

export function formatKps(kps) {
    return finite(kps) ? String(Math.max(0, Math.round(kps))) : "0";
}

// Judgement counts as text: thousands are kept whole ("1532"), anything missing reads 0.
export const formatCount = (n) => String(Math.max(0, Math.trunc(Number(n) || 0)));
