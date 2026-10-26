import { chartInfo, computeFeatures } from "./features.js";
import { isRice } from "./rice.js";
import { summarizePatterns } from "./patterns.js";
import { loadModel } from "./model.js";
import { numericToLabel } from "./labels.js";
import { t } from "../i18n/i18n.js";

const MIN_NOTES = 80;
// Dan-scale calculators shown next to ours; Sunny is a star rating and travels separately.
const CALC_KEYS = ["mixed", "daniel", "azusa", "roxy", "companella"];

const round = (x, digits) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : null);

let modelPromise = null;
function getModel() {
    modelPromise ??= loadModel();
    return modelPromise;
}

// minNotes: the fewest notes a chart needs for a dan (a part of a map, src/analysis/sections.js, asks for fewer)
export async function analyzeChart(osuText, rate, { minNotes = MIN_NOTES } = {}) {
    try {
        const info = chartInfo(osuText, rate);
        if (info.mode !== 3) {
            return { kind: "not-rice", reason: "mode", keys: info.keys };
        }
        if (info.keys === null || !isRice(info)) {
            return { kind: "not-rice", reason: info.keys === 4 ? "ln" : "keys", keys: info.keys };
        }
        if (info.noteCount < minNotes) {
            return { kind: "too-short" };
        }

        const [features, model] = await Promise.all([computeFeatures(osuText, rate), getModel()]);
        const { numeric, halfWidth, confidence, confidenceLevel } = model.predict(features.vector);
        if (numeric === null) {
            return { kind: "error", message: t("core.analyze.noCalculator") };
        }
        const patterns = summarizePatterns(features.patternReport, features.msd, { techMsdRatio: model.techMsdRatio });
        // One decimal everywhere, so the label is derived from exactly the number the window shows.
        const rounded = Math.round(numeric * 10) / 10;
        return {
            kind: "ok",
            label: numericToLabel(rounded).text,
            numeric: rounded,
            halfWidth,
            confidence,
            confidenceLevel,
            ...patterns,
            calcs: Object.fromEntries(CALC_KEYS.map((k) => [k, round(features.est?.[k], 1)])),
            sunny: round(features.est?.sunny, 2),
            msd: features.msd ? Object.fromEntries(Object.entries(features.msd).map(([k, v]) => [k, round(v, 2)])) : null,
            bpm: features.bpm,
            durationSec: features.durationSec,
            rate,
        };
    } catch (error) {
        return { kind: "error", message: String(error?.message ?? error) };
    }
}
