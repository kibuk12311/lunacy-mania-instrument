// A result of analyzeChart worded in English (as the worker answers and the cache keeps it) → the same result
// worded in another language, with the app's own words: the dan's label (numericToLabel: "below dan 1" /
// "ниже 1 дана", "above Kappa · 21.3" / "выше Kappa · 21.3"; "Gamma mid" is the same in both), the confidence word
// and the "no calculator" error. Uses the analyzer's copied labels.js and i18n.js (static imports, allowed in the
// service worker); tools/build-extension.mjs puts them in lib/.
import { confidenceWord, numericToLabel } from "../lib/src/core/labels.js";
import { setLang, t } from "../lib/src/i18n/i18n.js";
import { LANGS } from "../shared/lang.js";

const NO_CALCULATOR = "core.analyze.noCalculator";

function wordedIn(lang, fn) {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("en");
    }
}

const noCalculatorWords = new Set(LANGS.map((lang) => wordedIn(lang, () => t(NO_CALCULATOR))));

export function relabel(result, lang = "en") {
    if (!result || typeof result !== "object") return result;
    const target = LANGS.includes(lang) ? lang : "en";
    return wordedIn(target, () => {
        if (result.kind === "ok" && Number.isFinite(result.numeric)) {
            return { ...result, label: numericToLabel(result.numeric).text, confidence: confidenceWord(result.confidenceLevel) };
        }
        if (result.kind === "error" && noCalculatorWords.has(result.message)) return { ...result, message: t(NO_CALCULATOR) };
        return { ...result };
    });
}
