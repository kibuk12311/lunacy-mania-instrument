// Shipped dan model (models/dan_model.json, produced by tools/train.py). Mirrors train.py's json_predict.
import { readFile } from "node:fs/promises";
import { confidenceLevelFor, confidenceWord } from "./labels.js";

const DEFAULT_MODEL_URL = new URL("../../models/dan_model.json", import.meta.url);
// Uncertainty doubles when neither Mixed nor Azusa answered and a fallback estimator was used.
const FALLBACK_SPREAD_FACTOR = 2;

const isMissing = (v) => v === null || v === undefined || Number.isNaN(v);

export function evaluateSpec(spec, x) {
    if (spec.type === "mean") {
        const main = spec.features.map((i) => x[i]).filter((v) => !isMissing(v));
        if (main.length) return main.reduce((a, b) => a + b, 0) / main.length;
        const fb = spec.fallback.map((i) => x[i]).find((v) => !isMissing(v));
        return fb ?? null;
    }
    if (spec.type === "ridge") {
        return spec.coef.reduce((sum, c, i) => {
            const v = isMissing(x[i]) ? spec.impute[i] : x[i];
            return sum + ((v - spec.mean[i]) / spec.scale[i]) * c;
        }, spec.intercept);
    }
    let out = spec.baseline;
    for (const t of spec.trees) {
        let node = 0;
        while (!t.leaf[node]) {
            const v = x[t.feature[node]];
            const goLeft = isMissing(v) ? t.missingLeft[node] === 1 : v <= t.threshold[node];
            node = goLeft ? t.left[node] : t.right[node];
        }
        out += t.value[node];
    }
    return out;
}

function usedFallback(spec, x) {
    return spec.type === "mean" && spec.features.every((i) => isMissing(x[i]));
}

export async function loadModel(url = DEFAULT_MODEL_URL) {
    const meta = JSON.parse(await readFile(url, "utf8"));
    const { modelSpec, featureNames, spread, rangeFeature, techMsdRatio } = meta;

    // Confidence travels as a stable level ("high" | "medium" | "low") next to its word in the current language,
    // so code compares the level and a cached result can be worded again with confidenceWord (labels.js).
    const confidenceFor = (halfWidth) => confidenceWord(confidenceLevelFor(halfWidth));

    function halfWidthFor(range) {
        if (isMissing(range)) return spread.halfWidth.at(-1);
        const bin = spread.bins.filter((edge) => range >= edge).length;
        return spread.halfWidth[bin];
    }

    function predict(vector) {
        const x = featureNames.map((n) => (isMissing(vector[n]) ? null : Number(vector[n])));
        const numeric = evaluateSpec(modelSpec, x);
        if (numeric === null || !Number.isFinite(numeric)) {
            return { numeric: null, halfWidth: null, confidence: confidenceWord("low"), confidenceLevel: "low" };
        }
        const base = halfWidthFor(vector[rangeFeature]);
        const halfWidth = usedFallback(modelSpec, x) ? base * FALLBACK_SPREAD_FACTOR : base;
        const confidenceLevel = confidenceLevelFor(halfWidth);
        return { numeric, halfWidth, confidence: confidenceWord(confidenceLevel), confidenceLevel };
    }

    return { featureNames, techMsdRatio, predict, confidenceFor, confidenceLevelFor, meta };
}
