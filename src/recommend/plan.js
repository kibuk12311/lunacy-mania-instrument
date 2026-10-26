// A training plan: 5 or 6 maps from warm-up to challenge around the player's dan (or a dan picked by hand),
// over 1–3 patterns in turn. One wide tracker search per pattern fills every slot; an empty slot gets one search of its own.
import { GOALS, TILE_NAMES, patternById } from "./catalog.js";
import { targetForWindow } from "./skill.js";
import { searchParams, rankSets, SEARCH_PAGE_SIZE } from "./rank.js";
import { titleKey, sameChart } from "./recommend.js";
import { numericToLabel } from "../core/labels.js";
import { t } from "../i18n/i18n.js";

export const PLAN_SIZES = [5, 6];
export const PLAN_PAGES = 3;
// The MSD target of a slot sits where the goal of the same kind puts it.
const ROLE_GOAL = { warmup: "comfort", growth: "growth", challenge: "challenge" };

const WARMUP = [{ role: "warmup", dan: [-0.7, -0.35] }, { role: "warmup", dan: [-0.35, -0.05] }];
const CHALLENGE = { role: "challenge", dan: [0.5, 0.9] };
const GROWTH = {
    5: [[0, 0.25], [0.25, 0.5]],
    6: [[0, 0.2], [0.15, 0.35], [0.3, 0.5]],
};

// Slot windows around the player's dan; null for a size the plan doesn't offer.
export function planSlots(size) {
    if (!PLAN_SIZES.includes(size)) return null;
    return [...WARMUP.map((s) => ({ ...s, dan: [...s.dan] })), ...GROWTH[size].map((dan) => ({ role: "growth", dan: [...dan] })), { ...CHALLENGE, dan: [...CHALLENGE.dan] }];
}

// Each slot's pattern (the patterns take the slots in turn) and its search target.
export function slotTargets({ skill, manualDan, patternIds, slots }) {
    return slots.map((slot, i) => {
        const patternId = patternIds[i % patternIds.length];
        const goal = GOALS.find((g) => g.id === ROLE_GOAL[slot.role]);
        const target = targetForWindow({ skill, manualDan, patternId, dan: slot.dan, msdOffset: goal?.msd ?? null });
        return { ...slot, patternId, target };
    });
}

// Two cards of a plan are the same chart when they share a set, a beatmap, or a song with the same dan and length
// (slots of different patterns rate MSD on different skillsets, so MSD is left out here).
const sameSong = (a, b) => {
    const key = titleKey(a.title);
    return key !== "" && key === titleKey(b.title)
        && sameChart({ dan: a.dan, msd: null, lengthSec: a.lengthSec }, { dan: b.dan, msd: null, lengthSec: b.lengthSec });
};
export const clashes = (card, others) => others.some((o) => o
    && (o.beatmapId === card.beatmapId || o.beatmapsetId === card.beatmapsetId || sameSong(o, card)));

// rankedBySlot[i]: slot i's candidates, best first → the card each slot takes (null when none is left), in slot order.
export function fillPlan(slots, rankedBySlot, { taken = [] } = {}) {
    const picked = [...taken];
    return slots.map((_, i) => {
        const card = (rankedBySlot[i] ?? []).find((c) => !clashes(c, picked)) ?? null;
        if (card) picked.push(card);
        return card;
    });
}

export const planTotalSec = (cards) => cards.reduce((sum, c) => sum + (Number(c?.lengthSec) || 0), 0);

export function createPlanner({ api, recommender, pages = PLAN_PAGES }) {
    let session = null; // { ranked, cards } of the last plan, for swap
    let builds = 0;

    // Up to `count` pages of one search, without repeating a set.
    async function fetchPages(query, count) {
        const items = [];
        const seen = new Set();
        for (let page = 0; page < count; page++) {
            const res = await api.searchMaps(searchParams({ ...query, page }));
            for (const item of res.items ?? []) {
                if (!item || seen.has(item.beatmapsetId)) continue;
                seen.add(item.beatmapsetId);
                items.push(item);
            }
            if ((res.items?.length ?? 0) < SEARCH_PAGE_SIZE) break;
        }
        return items;
    }

    // The slot's cards: played maps and re-uploads of them left out.
    function rankFor(items, target, played) {
        const playedCharts = [];
        const cards = rankSets(items, target, { played, hidePlayed: true, onPlayed: (chart) => playedCharts.push(chart) });
        return cards.filter((card) => {
            const key = titleKey(card.title);
            return !(key && playedCharts.some((c) => titleKey(c.title) === key && sameChart(c, card)));
        });
    }

    async function build(req) {
        const run = ++builds;
        session = null;
        const slots = planSlots(req?.size);
        if (!slots) throw new Error(t("recommend.err.planSize"));
        const patternIds = Array.isArray(req.patternIds) ? req.patternIds.filter((id) => patternById(id)) : [];
        if (!patternIds.length) throw new Error(t("core.rec.unknownPattern"));
        const player = recommender.currentPlayer();
        let skill = null;
        let plays = { played: new Map(), partial: false };
        // a hand-set profile (manualProfile.js manualSkill) takes the place of the tracker's skill
        const handSet = req.manual && req.manualSkill?.manual ? req.manualSkill : null;
        if (handSet) {
            skill = handSet;
            // a loaded profile's plays and a linked Interlude's (recommend.js extraPlayed) are still left out
            plays = await recommender.playedMaps().catch(() => ({ played: new Map(), partial: true }));
        } else if (req.manual) {
            if (!Number.isFinite(req.manualDan)) throw new Error(t("core.rec.needManualDan"));
            // a loaded profile's plays and a linked Interlude's (recommend.js extraPlayed) are still left out
            plays = await recommender.playedMaps().catch(() => ({ played: new Map(), partial: true }));
        } else {
            if (!player) throw new Error(t("core.rec.needProfile"));
            skill = player.skill;
            plays = await recommender.playedMaps();
        }
        const targets = slotTargets({ skill, manualDan: req.manual && !handSet ? req.manualDan : null, patternIds, slots });
        const query = (patternId, lo, hi) => ({ patternId, lo, hi, lengthId: req.lengthId, rankedOnly: Boolean(req.rankedOnly) });

        const itemsByPattern = new Map();
        for (const patternId of [...new Set(targets.map((s) => s.patternId))]) {
            const own = targets.filter((s) => s.patternId === patternId);
            const lo = Math.min(...own.map((s) => s.target.lo));
            const hi = Math.max(...own.map((s) => s.target.hi));
            itemsByPattern.set(patternId, await fetchPages(query(patternId, lo, hi), pages));
        }
        const ranked = targets.map((s) => rankFor(itemsByPattern.get(s.patternId), s.target, plays.played));
        const cards = fillPlan(targets, ranked);
        for (let i = 0; i < cards.length; i++) {
            if (cards[i]) continue;
            const { patternId, target } = targets[i];
            const own = rankFor(await fetchPages(query(patternId, target.lo, target.hi), 1), target, plays.played);
            const ownIds = new Set(own.map((c) => c.beatmapId));
            ranked[i] = [...own, ...ranked[i].filter((c) => !ownIds.has(c.beatmapId))];
            cards[i] = own.find((c) => !clashes(c, cards)) ?? null;
        }
        if (run === builds) session = { ranked, cards };

        const head = targets[0].target;
        return {
            header: {
                playerDan: head.playerDan,
                label: numericToLabel(head.playerDan).text,
                tile: head.source === "tile" ? TILE_NAMES[head.tile] ?? null : null,
                source: head.source,
                ...(head.handSet ? { handSet: true } : {}),
                patternId: head.patternId,
            },
            slots: targets.map((s, i) => ({ role: s.role, patternId: s.patternId, lo: s.target.lo, hi: s.target.hi, center: s.target.center, card: cards[i] })),
            totalSec: planTotalSec(cards),
            playedPartial: Boolean(plays.partial),
        };
    }

    // The slot's next candidate from the last plan (round the list), one that clashes with no other slot; null if none.
    function swap(slot) {
        const s = session;
        if (!s) throw new Error(t("recommend.err.noPlan"));
        if (!Number.isInteger(slot) || slot < 0 || slot >= s.cards.length) throw new Error(t("recommend.err.badSlot"));
        const list = s.ranked[slot];
        const current = s.cards[slot];
        const others = s.cards.filter((c, i) => i !== slot && c);
        const start = current ? list.indexOf(current) : -1;
        for (let k = 1; k <= list.length; k++) {
            const c = list[(start + k) % list.length];
            if (c === current || clashes(c, others)) continue;
            s.cards[slot] = c;
            return c;
        }
        return null;
    }

    return { build, swap };
}
