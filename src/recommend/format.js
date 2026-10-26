// Small display helpers for recommendation cards.

export function mmss(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "+0.3", "−0.2" (typographic minus), "0.0"
export function signed(x, digits = 1) {
    const v = Number(x);
    if (!Number.isFinite(v)) return "—";
    const text = Math.abs(v).toFixed(digits);
    if (Number(text) === 0) return (0).toFixed(digits);
    return `${v > 0 ? "+" : "−"}${text}`;
}

// 950 → "950", 126009 → "126k", 1234567 → "1.2M"
export function shortNumber(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
    return String(Math.round(v));
}
