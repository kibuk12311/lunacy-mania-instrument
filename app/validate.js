// Checks on values that come from the renderer, shared by the main-process handlers of every tab.
import { LEVELS, STEPS, targetNumeric } from "../src/gen/request.js";

// Any dan the manual picker can produce: 1 дан low … Kappa high.
export const MIN_DAN = targetNumeric(LEVELS[0].value, STEPS[0].id);
export const MAX_DAN = targetNumeric(LEVELS.at(-1).value, STEPS.at(-1).id);

export const validRate = (r) => Number.isFinite(r) && r >= 0.5 && r <= 2;

// null keeps the map's own value
export const validDiff = (v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 10);

// Only a positive integer (a number or a string of digits) ever goes into a URL.
export function positiveId(value) {
    const id = typeof value === "number" ? value
        : typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const danOf = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 25 ? value : null);
