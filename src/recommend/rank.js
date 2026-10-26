// Search params for mania-tracker and the scoring that turns its sets into recommendation cards.
import { numericToLabel } from "../core/labels.js";
import { RICE_MAX_LN_RATIO } from "../core/rice.js";
import { lengthById, patternById } from "./catalog.js";
import { t } from "../i18n/i18n.js";

export const SEARCH_PAGE_SIZE = 48;
// The tracker's lnShare is our lnRatio: above this our analyzer calls the map "not rice".
export const MAX_LN_SHARE = RICE_MAX_LN_RATIO;
// vibro=hide misses many vibro packs (the tracker marks them vibro: false), so names are checked too.
const VIBRO_NAME = /vibro/i;
const PURITY_REF = ["stream", "jumpstream", "handstream", "chordjack", "jack"];
// What a card's seed keeps for "more like this": the seven MinaCalc skillsets and the tracker's eight pattern shares.
export const SEED_MSD_AXES = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];
export const SEED_PATTERNS = ["stream", "jumpstream", "handstream", "stamina", "chordjack", "jack", "tech", "ln"];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round2 = (x) => Math.round(x * 100) / 100;
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// Tracker steps: dan D splits into five 0.2 steps, -2 = (D−0.5, D−0.3] … +2 = (D+0.3, D+0.5].
// A value on a boundary belongs to the lower step, as on the server: 13.5 is gamma++, 13.7 delta--.
export function danBound(x) {
    const dan = Math.ceil(x - 0.5 - 1e-9);
    const step = clamp(Math.ceil((x - dan + 0.5) / 0.2 - 1e-9) - 3, -2, 2);
    return { dan, step };
}

// The server cuts by whole steps, so its window covers [lo, hi]; rankSets trims it exactly.
export function searchParams({ patternId, lo, hi, lengthId, rankedOnly, page = 0 }) {
    const min = danBound(lo);
    const max = danBound(hi);
    const params = {
        sort: "playcount", dir: "desc", page, pageSize: SEARCH_PAGE_SIZE, keys: "4k", patterns: patternId,
        vibro: "hide", lnMax: Math.round(MAX_LN_SHARE * 100),
        danMin: min.dan, danMinStep: min.step, danMax: max.dan, danMaxStep: max.step,
    };
    const length = lengthById(lengthId);
    if (length?.lenMin != null) params.lenMin = length.lenMin;
    if (length?.lenMax != null) params.lenMax = length.lenMax;
    if (rankedOnly) params.statuses = "ranked,loved";
    return params;
}

// How much the chosen pattern stands out from the other rice patterns, 0..1; a kind (catalog.js REC_KINDS, which
// the tracker gives no share of) by its parent's share.
export function purity(patterns, id) {
    const patternId = patternById(id)?.parent ?? id;
    const value = (q) => finite(patterns?.[q]) ?? 0;
    const others = PURITY_REF.filter((q) => q !== patternId);
    const mean = others.reduce((sum, q) => sum + value(q), 0) / others.length;
    return clamp((value(patternId) - mean) / 0.5, 0, 1);
}

export function purityLabel(p) {
    if (p >= 0.7) return t("core.purity.pure");
    if (p >= 0.4) return t("core.purity.mostly");
    return t("core.purity.mixed");
}

// log10 of the play count: 100 plays → 0, 100k → 1.
export const popularityOf = (playCount) => clamp((Math.log10((Number(playCount) || 0) + 1) - 2) / 3, 0, 1);

export function scoreDiff(diff, target, { played = false, setPlayed = false } = {}) {
    const dan = finite(diff?.dan?.rawDan);
    const danFit = dan === null ? 0 : 1 - Math.min(1, Math.abs(dan - target.center) / (target.halfWidth + 0.15));
    const msd = finite(diff?.msd?.[target.msdAxis]);
    const msdFit = target.msdTarget != null && msd !== null
        ? 1 - Math.min(1, Math.abs(msd - target.msdTarget) / 1.5)
        : danFit;
    // Every dan inside the window is playable, so how well-known the map is weighs as much as where it sits.
    let score = 0.25 * danFit + 0.25 * msdFit + 0.2 * purity(diff?.patterns, target.patternId) + 0.3 * popularityOf(diff?.playCount);
    if (setPlayed) score -= 0.1;
    if (played) score -= 0.3;
    return score;
}

export const byScore = (a, b) => b.score - a.score || b.playCount - a.playCount || a.beatmapId - b.beatmapId;

// target: anything with lo and hi.
export function inWindow(diff, target) {
    const dan = finite(diff?.dan?.rawDan);
    if (dan === null) return false;
    if (Number(diff.lnShare) > MAX_LN_SHARE) return false;
    return dan >= target.lo - 1e-9 && dan <= target.hi + 1e-9;
}

export const looksVibro = (diff, item) => ["title", "version", "artist"].some((key) => VIBRO_NAME.test(String(diff[key] ?? item[key] ?? "")));

// What tells a chart apart from its re-uploads in other sets (see recommend.js), as on its card.
function chartOf(item, diff, target) {
    const msd = finite(diff.msd?.[target.msdAxis]);
    return {
        title: diff.title ?? item.title ?? null,
        dan: finite(diff.dan?.rawDan),
        msd: msd === null ? null : round2(msd),
        lengthSec: diff.length ?? item.length ?? null,
    };
}

// played: Map beatmapId → { beatmapsetId, accuracy, rate }.
// onPlayed(chart, play) hears of every played diff, hidden or out of the window too.
export function rankSets(items, target, { played = new Map(), hidePlayed = false, onPlayed = null } = {}) {
    const playedBySet = new Map();
    for (const [beatmapId, play] of played) {
        if (!playedBySet.has(play.beatmapsetId)) playedBySet.set(play.beatmapsetId, new Set());
        playedBySet.get(play.beatmapsetId).add(beatmapId);
    }

    const cards = [];
    for (const item of items ?? []) {
        if (!item) continue;
        const diffs = Array.isArray(item.diffs) && item.diffs.length ? item.diffs : [item];
        let best = null;
        for (const diff of diffs) {
            const play = played.get(diff?.beatmapId) ?? null;
            if (play) onPlayed?.(chartOf(item, diff, target), play);
            if (!inWindow(diff, target) || looksVibro(diff, item)) continue;
            if (play && hidePlayed) continue;
            const setId = diff.beatmapsetId ?? item.beatmapsetId;
            const setPlayed = [...(playedBySet.get(setId) ?? [])].some((id) => id !== diff.beatmapId);
            const score = scoreDiff(diff, target, { played: !!play, setPlayed });
            if (!best || score > best.score) best = { diff, play, setPlayed, score };
        }
        if (best) cards.push(toCard(item, best, target));
    }
    return cards.sort(byScore);
}

// A chart's seed for "more like this", rounded to 0.01; null without a dan. A primary pattern the picks don't offer
// (LN, say) falls back to the pattern the card was found for.
export function seedOf(diff, item = null, fallbackPattern = null) {
    const dan = finite(diff?.dan?.rawDan);
    const primaryPattern = patternById(diff?.primaryPattern ?? item?.primaryPattern)?.id ?? patternById(fallbackPattern)?.id ?? null;
    if (dan === null || !primaryPattern) return null;
    const pick = (key) => finite(diff?.[key] ?? item?.[key] ?? null);
    const rounded = (from, keys) => {
        const out = {};
        for (const key of keys) {
            const v = finite(from?.[key]);
            if (v !== null) out[key] = round2(v);
        }
        return out;
    };
    const bpm = pick("bpm");
    const lengthSec = pick("length");
    return {
        primaryPattern,
        msdAll: rounded(diff.msd, SEED_MSD_AXES),
        patternsAll: rounded(diff.patterns, SEED_PATTERNS),
        bpm: bpm === null ? null : round2(bpm),
        lengthSec: lengthSec === null ? null : round2(lengthSec),
        dan: round2(dan),
    };
}

export function toCard(item, { diff, play, setPlayed, score }, target) {
    const dan = diff.dan.rawDan;
    const msd = finite(diff.msd?.[target.msdAxis]);
    const p = round2(purity(diff.patterns, target.patternId));
    const pick = (key) => diff[key] ?? item[key] ?? null;
    return {
        beatmapId: diff.beatmapId,
        beatmapsetId: pick("beatmapsetId"),
        artist: pick("artist"),
        title: pick("title"),
        version: pick("version"),
        creator: pick("creator"),
        status: pick("status"),
        stars: pick("stars"),
        bpm: pick("bpm"),
        lengthSec: pick("length"),
        playCount: Number(diff.playCount) || 0,
        cover: item.covers?.list ?? null,
        dan,
        danLabel: numericToLabel(dan).text,
        delta: round2(dan - target.playerDan),
        msd: msd === null ? null : round2(msd),
        msdTarget: target.msdTarget ?? null,
        purity: p,
        purityLabel: purityLabel(p),
        played: play ? { accuracy: play.accuracy, rate: play.rate } : null,
        setPlayed,
        score: Math.round(score * 1e4) / 1e4,
        seed: seedOf(diff, item, target.patternId),
    };
}
