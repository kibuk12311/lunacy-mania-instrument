// Marathon course templates: where each map's dan sits below the final dan, the length of the maps, the pause,
// OD/HP and the patterns to start from. Used by the auto-marathon and by the curve of a list made by hand.
import { numericToLabel } from "../core/labels.js";
import { t } from "../i18n/i18n.js";
import { MAX_PATTERN_PICKS } from "../recommend/catalog.js";
import { playerDanFor } from "../recommend/skill.js";

const MIN_TARGET = 1;
const MAX_TARGET = 20.4; // Kappa high
const round05 = (x) => Math.round(x * 20) / 20;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// offsets: each step's dan relative to the final dan (null: made from count and step, the "custom" one).
export const TEMPLATES = [
    {
        id: "dan", offsets: [-0.45, -0.3, -0.15, 0], lengthId: "medium", gapSec: 10, od: 8, hp: 8,
        defaultPatterns: ["jumpstream", "chordjack"],
        nameKey: "marathon.tpl.dan.name", hintKey: "marathon.tpl.dan.hint", titleKey: "marathon.tpl.dan.title",
    },
    {
        id: "stamina", offsets: [-0.6, -0.4, -0.2, 0], lengthId: "long", gapSec: 15, od: 8, hp: 7,
        defaultPatterns: ["jumpstream", "handstream", "stamina"],
        nameKey: "marathon.tpl.stamina.name", hintKey: "marathon.tpl.stamina.hint", titleKey: "marathon.tpl.stamina.title",
    },
    {
        id: "warmup", offsets: [-1.2, -0.7, -0.3, 0, 0.3], lengthId: "short", gapSec: 20, od: 8, hp: 8,
        defaultPatterns: ["stream", "jumpstream"],
        nameKey: "marathon.tpl.warmup.name", hintKey: "marathon.tpl.warmup.hint", titleKey: "marathon.tpl.warmup.title",
    },
    {
        id: "custom", offsets: null, lengthId: "any", gapSec: 10, od: 8, hp: 8,
        defaultPatterns: ["jumpstream"],
        nameKey: "marathon.tpl.custom.name", hintKey: "marathon.tpl.custom.hint", titleKey: "marathon.tpl.custom.title",
    },
];

// How many patterns an auto-marathon takes turns between (the chips in the panel, the check in main): any.
export const MAX_MARATHON_PATTERNS = MAX_PATTERN_PICKS;

// The custom template's limits and defaults.
export const CUSTOM = { minCount: 3, maxCount: 10, count: 4, minStep: 0.1, maxStep: 0.4, step: 0.2 };

export const templateById = (id) => TEMPLATES.find((x) => x.id === id) ?? null;

function customOffsets({ count, step } = {}) {
    const n = Number.isFinite(Number(count)) && count !== null ? Math.round(clamp(Number(count), CUSTOM.minCount, CUSTOM.maxCount)) : CUSTOM.count;
    const s = Number.isFinite(Number(step)) && step !== null ? clamp(Number(step), CUSTOM.minStep, CUSTOM.maxStep) : CUSTOM.step;
    return Array.from({ length: n }, (_, i) => -(n - 1 - i) * s);
}

// Each step's target dan, ending on the final dan, clamped to [1, 20.4] and rounded to 0.05.
// count / step matter for "custom" only.
export function stepTargets(tpl, finalDan, { count, step } = {}) {
    if (!tpl || typeof finalDan !== "number" || !Number.isFinite(finalDan)) return [];
    const offsets = tpl.offsets ?? customOffsets({ count, step });
    return offsets.map((o) => round05(clamp(finalDan + o, MIN_TARGET, MAX_TARGET)));
}

// "By profile": the course from the player's skill. level "overall": every map below the overall dan, as
// stepTargets does; "pattern": each map below its own pattern's dan (its tile's, else the overall one), the patterns
// taking the maps in turn as the auto-marathon does. → { finalDan (the last map's), targets }, or null when the
// profile has no dan for it.
export function profileTargets(tpl, skill, patternIds, level, { count, step } = {}) {
    if (!tpl || !skill || !Array.isArray(patternIds) || !patternIds.length) return null;
    if (level === "overall") {
        const overall = skill.overall;
        if (typeof overall !== "number" || !Number.isFinite(overall)) return null;
        return { finalDan: overall, targets: stepTargets(tpl, overall, { count, step }) };
    }
    const offsets = tpl.offsets ?? customOffsets({ count, step });
    const dans = offsets.map((_, k) => playerDanFor(skill, patternIds[k % patternIds.length])?.dan ?? null);
    if (dans.some((dan) => dan === null)) return null;
    return { finalDan: dans.at(-1), targets: offsets.map((o, k) => round05(clamp(dans[k] + o, MIN_TARGET, MAX_TARGET))) };
}

// "Gamma Dan Course": the template's title around the final dan's level (Greek name, or the dan's number).
export function templateTitle(tpl, finalDan) {
    if (!tpl || typeof finalDan !== "number" || !Number.isFinite(finalDan)) return t("marathon.defaultTitle");
    const { level } = numericToLabel(clamp(finalDan, MIN_TARGET, MAX_TARGET));
    const name = numericToLabel(level).text.split(" ")[0];
    return t(tpl.titleKey, { level: name });
}
