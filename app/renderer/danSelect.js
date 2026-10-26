// The level + step dan picker (1 дан low … Kappa high) for any tab. The one place that reads the generator's
// LEVELS / STEPS, so a change there is followed here only.
import { LEVELS, STEPS, targetNumeric } from "../../src/gen/request.js";

const DEFAULT = { level: 13, step: "mid" };

// The picker's closest entry to a dan; ends clamp, a non-number gives Gamma mid.
export function nearestLevelStep(numeric) {
    if (!Number.isFinite(numeric)) return { ...DEFAULT };
    let best = null;
    for (const level of LEVELS) {
        for (const step of STEPS) {
            const d = Math.abs(targetNumeric(level.value, step.id) - numeric);
            if (!best || d < best.d - 1e-9) best = { d, level: level.value, step: step.id };
        }
    }
    return { level: best.level, step: best.step };
}

function option(value, text, selected) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = text;
    node.selected = selected;
    return node;
}

// Fills both selects (level names in the current language) and selects the entry nearest to `numeric`.
export function fillDanSelects(levelSel, stepSel, numeric) {
    const pick = nearestLevelStep(numeric);
    levelSel.replaceChildren(...LEVELS.map((l) => option(String(l.value), l.name, l.value === pick.level)));
    stepSel.replaceChildren(...STEPS.map((s) => option(s.id, s.id, s.id === pick.step)));
    levelSel.value = String(pick.level);
    stepSel.value = pick.step;
}

// The dan the two selects show, or null when they hold something else.
export function readDanSelects(levelSel, stepSel) {
    const level = LEVELS.find((l) => String(l.value) === levelSel.value);
    const step = STEPS.find((s) => s.id === stepSel.value);
    return level && step ? targetNumeric(level.value, step.id) : null;
}
