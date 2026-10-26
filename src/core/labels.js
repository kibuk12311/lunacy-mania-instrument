// Numeric dan scale: 1–10 are numbered dans, Alpha = 11 … Kappa = 20.
import { t } from "../i18n/i18n.js";

const GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"];

function stepForOffset(d) {
    if (d <= -0.3) return "low";
    if (d <= -0.1) return "low/mid";
    if (d <= 0.1) return "mid";
    if (d <= 0.3) return "mid/high";
    return "high";
}

function levelName(level) {
    return level <= 10 ? String(level) : GREEK[level - 11];
}

// The label without its words: "none", "below", "above" or e.g. "Gamma mid", the same in every language.
function labelParts(n) {
    if (!Number.isFinite(n)) return { key: "none", level: null, step: null };
    if (n < 0.5) return { key: "below", level: null, step: null };
    if (n >= 20.5) return { key: "above", level: null, step: null };
    const level = Math.round(n);
    // Round the offset so that e.g. 13.3 − 13 lands on 0.3, not 0.30000000000000071.
    const step = stepForOffset(Math.round((n - level) * 1e6) / 1e6);
    return { key: `${levelName(level)} ${step}`, level, step };
}

// Two dans carry the same label exactly when their keys match; compare these, not the shown text.
export const labelKey = (n) => labelParts(n).key;

export function numericToLabel(n) {
    const { key, level, step } = labelParts(n);
    if (key === "none") return { text: "—", level, step };
    if (key === "below") return { text: t("core.label.belowFirst"), level, step };
    if (key === "above") return { text: t("core.label.aboveKappa"), level, step };
    return { text: key, level, step };
}

// Confidence level of a dan estimate from its half width (the ± spread); stored with the result, worded at display time.
export function confidenceLevelFor(halfWidth) {
    if (halfWidth <= 0.35) return "high";
    if (halfWidth <= 0.7) return "medium";
    return "low";
}

// The word for a confidence level ("high" | "medium" | "low") in the current language; anything else reads as low.
export function confidenceWord(level) {
    if (level === "high") return t("core.confidence.high");
    if (level === "medium") return t("core.confidence.medium");
    return t("core.confidence.low");
}
