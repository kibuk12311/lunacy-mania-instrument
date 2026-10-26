// mania-tracker skills → the player's dan per tile, and the dan/MSD window a goal aims at.
import { numericToLabel } from "../core/labels.js";
import { TILE_NAMES, patternById, goalById } from "./catalog.js";
import { t } from "../i18n/i18n.js";

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round2 = (x) => Math.round(x * 100) / 100;

export function readSkill(json, keyCount = 4) {
    const status = String(json?.status ?? "unknown");
    const mode = Array.isArray(json?.modes) ? json.modes.find((m) => m?.keyCount === keyCount) ?? null : null;
    const rc = mode?.dan?.rc;
    const overall = finite(rc?.rawDan);
    const tiles = {};
    for (const tile of Object.keys(TILE_NAMES)) tiles[tile] = finite(rc?.skillsets?.[tile]?.rawDan);
    const msd = {};
    for (const [axis, value] of Object.entries(mode?.ratings ?? {})) {
        if (finite(value) !== null) msd[axis] = value;
    }
    return {
        ready: status === "ready" && mode !== null,
        status,
        // false: an account nobody added to mania-tracker, so it has no plays there at all
        tracked: json?.tracked !== false,
        analyzedPlays: Number(mode?.analyzedPlays ?? json?.analyzedPlays) || 0,
        overall,
        overallLabel: overall === null ? null : numericToLabel(overall).text,
        tiles,
        msd,
    };
}

// The tile's dan, else the overall rice dan; null when the tracker has neither.
export function playerDanFor(skill, patternId) {
    const pattern = patternById(patternId);
    if (!pattern || !skill) return null;
    const tileDan = finite(skill.tiles?.[pattern.tile]);
    if (tileDan !== null) return { dan: tileDan, source: "tile", tile: pattern.tile };
    const overall = finite(skill.overall);
    if (overall !== null) return { dan: overall, source: "overall", tile: pattern.tile };
    return null;
}

// The dan/MSD window a goal aims at, around the player's dan for the pattern.
export function targetFor({ skill, manualDan, patternId, goalId }) {
    if (!patternById(patternId)) throw new Error(t("core.rec.unknownPattern"));
    const goal = goalById(goalId);
    if (!goal) throw new Error(t("core.rec.unknownGoal"));
    return { ...targetForWindow({ skill, manualDan, patternId, dan: goal.dan, msdOffset: goal.msd }), goalId: goal.id };
}

// Any window dan:[a, b] around the player's dan (or a manual dan), the same shape as targetFor with goalId null.
// msdOffset: the MSD target's offset from the player's rating on the pattern's skillset; null for no MSD target.
export function targetForWindow({ skill, manualDan, patternId, dan, msdOffset = null }) {
    const pattern = patternById(patternId);
    if (!pattern) throw new Error(t("core.rec.unknownPattern"));
    if (!Array.isArray(dan) || dan.length !== 2 || finite(dan[0]) === null || finite(dan[1]) === null || dan[0] > dan[1]) {
        throw new Error(t("core.rec.unknownGoal"));
    }

    let playerDan;
    let source;
    let msdRating = null;
    if (finite(manualDan) !== null) {
        playerDan = manualDan;
        source = "manual";
    } else {
        if (!skill) throw new Error(t("core.rec.noProfileOrDan"));
        const own = playerDanFor(skill, patternId);
        if (!own) throw new Error(t("core.rec.noTileDan"));
        playerDan = own.dan;
        source = own.source;
        msdRating = pattern.msdFit === false ? null : finite(skill.msd?.[pattern.msd]);
    }

    const lo = round2(playerDan + dan[0]);
    const hi = round2(playerDan + dan[1]);
    const offset = finite(msdOffset);
    return {
        patternId: pattern.id,
        goalId: null,
        source,
        tile: pattern.tile,
        playerDan,
        playerDanLabel: numericToLabel(playerDan).text,
        lo,
        hi,
        center: round2((lo + hi) / 2),
        halfWidth: round2((hi - lo) / 2),
        msdAxis: pattern.msd,
        msdRating,
        msdTarget: msdRating === null || offset === null ? null : round2(msdRating + offset),
    };
}

// The goal id of a range the player picks: a from … to pair on the dan picker instead of a window around their dan.
export const CUSTOM_GOAL = "custom";
// Each picked step stands for a 0.2-wide band of dans (Gamma low = 12.5…12.7 around the picker's 12.6), so the window
// of a custom range reaches half a band past both ends: "Gamma low – Delta low" takes every map labelled with either.
const LABEL_HALF_STEP = 0.1;
// The window of a custom range: [from − half a band, to + half a band] (swapped when from > to), the same shape as
// targetFor with goalId "custom" and the two picked ends. The player's dan for the pattern stays the cards' reference
// when the profile has one (source tile / overall); without it (manual mode) the range's middle does (source "range").
// No MSD target: the goals' MSD offsets belong to their own windows, not to an arbitrary range.
export function targetForRange({ skill = null, patternId, from, to }) {
    const pattern = patternById(patternId);
    if (!pattern) throw new Error(t("core.rec.unknownPattern"));
    if (finite(from) === null || finite(to) === null) throw new Error(t("recommend.err.badRange"));
    const [a, b] = from <= to ? [from, to] : [to, from];
    const lo = round2(a - LABEL_HALF_STEP);
    const hi = round2(b + LABEL_HALF_STEP);
    const own = skill ? playerDanFor(skill, patternId) : null;
    const base = own ? own.dan : round2((lo + hi) / 2);
    const window = targetForWindow({ skill: own ? skill : null, manualDan: own ? null : base, patternId, dan: [lo - base, hi - base] });
    return {
        ...window,
        goalId: CUSTOM_GOAL,
        source: own ? window.source : "range",
        lo,
        hi,
        center: round2((lo + hi) / 2),
        halfWidth: round2((hi - lo) / 2),
        msdTarget: null,
        rangeFrom: a,
        rangeTo: b,
    };
}
