// The rates of a batch: from … to with a step, worked out in whole hundredths so 1.15 never turns into
// 1.1500000000000001. Ends the wrong way round are swapped; the far end is left out when the step misses it.

export const MAX_BATCH = 31;
const MIN_RATE = 0.5;
const MAX_RATE = 2;
const EPS = 1e-9;

// → { rates } (ascending) | { error: "range" | "step" | "too-many" }
export function rateSteps(from, to, step) {
    let a = Number(from);
    let b = Number(to);
    const s = Number(step);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: "range" };
    if (!Number.isFinite(s) || s < 0.01 - EPS) return { error: "step" };
    if (a > b) [a, b] = [b, a];
    if (a < MIN_RATE - EPS || b > MAX_RATE + EPS) return { error: "range" };
    const lo = Math.round(a * 100);
    const hi = Math.round(b * 100);
    const by = Math.max(1, Math.round(s * 100));
    const count = Math.floor((hi - lo) / by) + 1;
    if (count > MAX_BATCH) return { error: "too-many" };
    return { rates: Array.from({ length: count }, (_, i) => (lo + i * by) / 100) };
}
