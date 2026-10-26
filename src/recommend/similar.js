// "More like this": maps close to a card's seed (its dan, MinaCalc skillsets, pattern shares, BPM and length).
import { patternById } from "./catalog.js";
import { searchParams, seedOf, toCard, byScore, inWindow, looksVibro, popularityOf, SEED_MSD_AXES, SEED_PATTERNS } from "./rank.js";
import { titleKey, sameChart } from "./recommend.js";
import { t } from "../i18n/i18n.js";

// The search window around the seed's dan, and how many tracker pages it reads.
export const SIMILAR_WINDOW = 0.35;
export const SIMILAR_PAGES = 2;
export const SIMILAR_LIMIT = 5;

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const within = (x, lo, hi) => (finite(x) !== null && x >= lo && x <= hi ? x : null);

function keep(from, keys, lo, hi) {
    const out = {};
    if (!from || typeof from !== "object") return out;
    for (const key of keys) {
        if (!Object.hasOwn(from, key)) continue;
        const v = within(from[key], lo, hi);
        if (v !== null) out[key] = round2(v);
    }
    return out;
}

// A seed sent back by the renderer, rebuilt from known keys only; null without a dan or with a pattern the picks don't offer.
export function cleanSeed(x) {
    if (!x || typeof x !== "object") return null;
    const pattern = typeof x.primaryPattern === "string" ? patternById(x.primaryPattern) : null;
    const dan = within(x.dan, 0.01, 25);
    if (!pattern || dan === null) return null;
    const bpm = within(x.bpm, 1, 2000);
    const lengthSec = within(x.lengthSec, 0, 36000);
    return {
        primaryPattern: pattern.id,
        msdAll: keep(x.msdAll, SEED_MSD_AXES, 0, 100),
        patternsAll: keep(x.patternsAll, SEED_PATTERNS, 0, 2),
        bpm: bpm === null ? null : round2(bpm),
        lengthSec: lengthSec === null ? null : round2(lengthSec),
        dan: round2(dan),
    };
}

// The tracker search for one page of candidates: the seed's primary pattern, its dan ± 0.35, any length.
export function similarParams(seed, rankedOnly, page = 0) {
    return searchParams({
        patternId: seed.primaryPattern, lo: round2(seed.dan - SIMILAR_WINDOW), hi: round2(seed.dan + SIMILAR_WINDOW),
        lengthId: "any", rankedOnly: Boolean(rankedOnly), page,
    });
}

const gap = (a, b) => (finite(a) !== null && finite(b) !== null ? Math.abs(a - b) : null);
function meanGap(a, b, keys) {
    const both = keys.filter((key) => finite(a?.[key]) !== null && finite(b?.[key]) !== null);
    if (!both.length) return null;
    return both.reduce((sum, key) => sum + Math.abs(a[key] - b[key]), 0) / both.length;
}
// each term is capped at 1; a term without data on either side counts as far
const term = (x, scale) => (x === null ? 1 : Math.min(1, x / scale));

// 0 = the same chart … 1 = nothing alike.
export function seedDistance(a, b) {
    return 0.35 * term(gap(a.dan, b.dan), SIMILAR_WINDOW)
        + 0.25 * term(meanGap(a.msdAll, b.msdAll, SEED_MSD_AXES), 2)
        + 0.2 * term(meanGap(a.patternsAll, b.patternsAll, SEED_PATTERNS), 0.3)
        + 0.12 * term(gap(a.bpm, b.bpm), 60)
        + 0.08 * term(gap(a.lengthSec, b.lengthSec), 120);
}

// 0..1; a well-known map gets a small lift.
export function similarity(seed, diff, item = null) {
    const other = seedOf(diff, item, seed.primaryPattern);
    if (!other) return 0;
    const sim = 1 - seedDistance(seed, other) + 0.05 * popularityOf(diff?.playCount);
    return Math.round(clamp(sim, 0, 1) * 1e4) / 1e4;
}

export function simLabel(sim) {
    if (sim >= 0.8) return t("recommend.similar.very");
    if (sim >= 0.6) return t("recommend.similar.close");
    return t("recommend.similar.loose");
}

const diffsOf = (item) => (Array.isArray(item?.diffs) && item.diffs.length ? item.diffs : [item]);

// Tracker sets → up to `limit` cards (one per set), most similar first, each with sim and simLabel.
// Left out: the map's own set (self.beatmapsetId, or the set the map turns up in), re-uploads of it (same title key,
// dan and length), LN-heavy, vibro and out-of-window charts, and played ones when hidePlayed.
export function pickSimilar(items, seed, { played = new Map(), hidePlayed = false, limit = SIMILAR_LIMIT, self = {} } = {}) {
    const pattern = patternById(seed.primaryPattern);
    const target = { patternId: pattern.id, msdAxis: pattern.msd, playerDan: seed.dan, msdTarget: null };
    const span = { lo: seed.dan - SIMILAR_WINDOW, hi: seed.dan + SIMILAR_WINDOW };
    const selfId = self?.beatmapId ?? null;
    const selfSet = self?.beatmapsetId
        ?? (items ?? []).find((item) => item && diffsOf(item).some((d) => d?.beatmapId === selfId))?.beatmapsetId ?? null;
    const selfKey = titleKey(self?.title);
    const selfChart = { dan: seed.dan, msd: seed.msdAll?.[pattern.msd] ?? null, lengthSec: seed.lengthSec };
    const chartOf = (diff, item) => {
        const msd = finite(diff.msd?.[pattern.msd]);
        return { dan: finite(diff.dan?.rawDan), msd: msd === null ? null : round2(msd), lengthSec: diff.length ?? item.length ?? null };
    };

    const cards = [];
    for (const item of items ?? []) {
        if (!item) continue;
        let best = null;
        for (const diff of diffsOf(item)) {
            if (!diff) continue;
            const setId = diff.beatmapsetId ?? item.beatmapsetId;
            if ((selfSet !== null && setId === selfSet) || (selfId !== null && diff.beatmapId === selfId)) continue;
            if (!inWindow(diff, span) || looksVibro(diff, item)) continue;
            const play = played.get(diff.beatmapId) ?? null;
            if (play && hidePlayed) continue;
            if (selfKey && titleKey(diff.title ?? item.title) === selfKey && sameChart(chartOf(diff, item), selfChart)) continue;
            const score = similarity(seed, diff, item);
            if (!best || score > best.score) best = { diff, play, setPlayed: false, score };
        }
        if (best) cards.push({ ...toCard(item, best, target), sim: best.score, simLabel: simLabel(best.score) });
    }
    cards.sort(byScore);

    const kept = [];
    for (const card of cards) {
        const key = titleKey(card.title);
        if (key && kept.some((c) => titleKey(c.title) === key && sameChart(c, card))) continue;
        kept.push(card);
        if (kept.length >= limit) break;
    }
    return kept;
}
