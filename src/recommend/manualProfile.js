// A skill profile set by hand, for players without mania-tracker: their dan on the four axes the tracker rates
// (Speed, Jack, Stamina, Tech), turned into the same skill object readSkill gives (src/recommend/skill.js), so every
// place that takes a tracker profile takes this one too.
import { numericToLabel } from "../core/labels.js";
import { LEVELS, STEPS, targetNumeric } from "../gen/request.js";

// The editor's rows, in the order mania-tracker names them on a profile.
export const MANUAL_AXES = ["speed", "jack", "stamina", "tech"];
export const MANUAL_NAME_MAX = 32;
// The picker's ends (1 дан low … Kappa high) and its grid: every dan it shows is a multiple of 0.2.
const MIN = targetNumeric(LEVELS[0].value, STEPS[0].id);
const MAX = targetNumeric(LEVELS.at(-1).value, STEPS.at(-1).id);
const DEFAULT_DAN = 13; // Gamma mid, the picker's own default

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round2 = (x) => Math.round(x * 100) / 100;

// Any dan → the picker's nearest entry (ends clamp); null for a non-number.
export function snapDan(x) {
    const n = finite(x);
    if (n === null) return null;
    return Math.round(Math.min(MAX, Math.max(MIN, n)) * 5) / 5;
}

// A dan the picker shows exactly (within its ends, on its 0.2 grid), else null: what a saved or sent profile must hold.
export function pickerDan(x) {
    const n = finite(x);
    if (n === null || n < MIN - 1e-9 || n > MAX + 1e-9) return null;
    const snapped = snapDan(n);
    return Math.abs(snapped - n) < 1e-6 ? snapped : null;
}

const cleanName = (name) => (typeof name === "string" ? name.trim().slice(0, MANUAL_NAME_MAX) : "");

// Saved or sent data → { name, speed, jack, stamina, tech }, or null when an axis is missing or off the picker.
export function normalizeManualProfile(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    const out = { name: cleanName(x.name) };
    for (const axis of MANUAL_AXES) {
        const dan = pickerDan(x[axis]);
        if (dan === null) return null;
        out[axis] = dan;
    }
    return out;
}

// One dan on every axis (the old single manual dan); a dan off the picker gives Gamma mid.
export function uniformProfile(dan = DEFAULT_DAN, name = "") {
    const d = snapDan(dan) ?? DEFAULT_DAN;
    return { name: cleanName(name), ...Object.fromEntries(MANUAL_AXES.map((axis) => [axis, d])) };
}

// The overall dan of a hand-set profile: the plain mean of the four axes, to two decimals. That is how mania-tracker's
// own overall reads: in tests/fixtures/mt/skills.json the rc dan 13.66 is exactly the mean of its four skillsets
// (14.28, 13.36, 13.26, 13.74).
export function manualOverall(profile) {
    const dans = MANUAL_AXES.map((axis) => finite(profile?.[axis]));
    if (dans.some((d) => d === null)) return null;
    return round2(dans.reduce((sum, d) => sum + d, 0) / dans.length);
}

// The profile as a skill (readSkill's shape): its tiles and overall, no MinaCalc ratings, no plays, manual: true.
export function manualSkill(profile) {
    const p = normalizeManualProfile(profile);
    if (!p) return null;
    const overall = manualOverall(p);
    return {
        ready: true,
        status: "manual",
        tracked: false,
        manual: true,
        analyzedPlays: 0,
        overall,
        overallLabel: numericToLabel(overall).text,
        tiles: Object.fromEntries(MANUAL_AXES.map((axis) => [axis, p[axis]])),
        msd: {},
    };
}

// A starting point taken from a tracker skill: each tile on the picker's nearest entry; a missing tile takes the
// overall dan, and without that Gamma mid.
export function profileFromSkill(skill, name = "") {
    const fallback = snapDan(skill?.overall) ?? DEFAULT_DAN;
    const out = { name: cleanName(name) };
    for (const axis of MANUAL_AXES) out[axis] = snapDan(skill?.tiles?.[axis]) ?? fallback;
    return out;
}

// The picks tab's saved settings → the hand-set profile in them; settings from before it existed (one manual
// level + step) give that dan on every axis.
export function manualProfileOf(settings) {
    const saved = normalizeManualProfile(settings?.manualProfile);
    if (saved) return saved;
    const level = LEVELS.find((l) => l.value === settings?.level);
    const step = STEPS.find((s) => s.id === settings?.step);
    return uniformProfile(level && step ? targetNumeric(level.value, step.id) : DEFAULT_DAN);
}
