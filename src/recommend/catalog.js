// What the recommendation tab offers: patterns (mania-tracker ids), goals and length filters.
import { t } from "../i18n/i18n.js";

// name / hint are getters: each read gives the text in the current language, so nothing freezes it at import time.
const pattern = (id, rest) => ({ id, get name() { return t(`recommend.pattern.${id}`); }, ...rest });
const goal = (id, rest) => ({
    id,
    get name() { return t(`recommend.goal.${id}`); },
    get hint() { return t(`recommend.goal.${id}Hint`); },
    ...rest,
});
const length = (id, rest = {}) => ({ id, get name() { return t(`recommend.length.${id}`); }, ...rest });

// msd: the MinaCalc skillset the pattern is rated on; tile: the rice dan tile its charts fall under on mania-tracker.
// msdFit false: the player's rating on that skillset doesn't line up with the charts (JackSpeed sits ~7 below
// the MSD of jack charts at the player's own jack dan), so those rank by dan only.
export const REC_PATTERNS = [
    pattern("stream", { msd: "Stream", tile: "speed" }),
    pattern("jumpstream", { msd: "Jumpstream", tile: "stamina" }),
    pattern("handstream", { msd: "Handstream", tile: "stamina" }),
    pattern("stamina", { msd: "Stamina", tile: "stamina" }),
    pattern("chordjack", { msd: "Chordjack", tile: "jack" }),
    pattern("jack", { msd: "JackSpeed", tile: "jack", msdFit: false }),
    pattern("tech", { msd: "Technical", tile: "tech" }),
];

// Kinds of those patterns that mania-tracker's map search filters by too (patterns=<id>: the maps it tags so), offered
// in the Detailed mode (app/renderer/patternMode.js); each is rated and tiled like its parent.
export const REC_KINDS = [
    pattern("quadstream", { msd: "Chordjack", tile: "jack", parent: "chordjack" }),
    pattern("handjack", { msd: "Chordjack", tile: "jack", parent: "chordjack" }),
    pattern("speedjack", { msd: "JackSpeed", tile: "jack", msdFit: false, parent: "jack" }),
];

// How many patterns a pick can take at once: no limit beyond every pattern and kind there is.
export const MAX_PATTERN_PICKS = REC_PATTERNS.length + REC_KINDS.length;

// The patterns offered in the General / Detailed mode: General the seven, Detailed each kind right after its parent.
export const recPatternsFor = (detailed) => (detailed ? REC_PATTERNS.flatMap((p) => [p, ...REC_KINDS.filter((k) => k.parent === p.id)]) : REC_PATTERNS);
// A chosen id as the mode uses it: in General a kind stands for its parent (the kind stays remembered).
export const patternInMode = (id, detailed) => (detailed ? id : patternById(id)?.parent ?? id);
// Chosen ids in the mode, each once, in order.
export const patternIdsInMode = (ids, detailed) => [...new Set(ids.map((id) => patternInMode(id, detailed)))];

// dan: window around the player's dan for the pattern; msd: offset from the player's MinaCalc rating on its skillset.
export const GOALS = [
    goal("comfort", { dan: [-0.6, -0.1], msd: -1.0 }),
    goal("growth", { dan: [0, 0.5], msd: 0.75 }),
    goal("challenge", { dan: [0.5, 1.2], msd: 2.0 }),
];

// Seconds; a missing bound is open.
export const LENGTHS = [
    length("any"),
    length("short", { lenMax: 150 }),
    length("medium", { lenMin: 120, lenMax: 240 }),
    length("long", { lenMin: 240 }),
];

export const TILE_NAMES = { speed: "Speed", stamina: "Stamina", tech: "Tech", jack: "Jack" };

export const patternById = (id) => REC_PATTERNS.find((p) => p.id === id) ?? REC_KINDS.find((p) => p.id === id) ?? null;
export const goalById = (id) => GOALS.find((g) => g.id === id) ?? null;
export const lengthById = (id) => LENGTHS.find((l) => l.id === id) ?? null;
