// Recommendation session: the current player, a ranked pool of tracker sets and paging through it.
import { REC_PATTERNS, patternById } from "./catalog.js";
import { readSkill, targetFor, targetForRange, CUSTOM_GOAL } from "./skill.js";
import { searchParams, rankSets, byScore, SEARCH_PAGE_SIZE } from "./rank.js";
import { t } from "../i18n/i18n.js";

// Batches fetched in one start()/more() call at most, so a filter that hides everything can't loop forever.
const MAX_BATCHES_PER_CALL = 3;
// The tracker gives only the top 200 plays per axis, and a weak play of a map near your level can miss
// its own axis, so played maps come from every axis at once.
const PLAYED_AXES = [...new Set([...REC_PATTERNS.map((p) => p.msd), "Overall"])];

// A chart re-uploaded in another set (packs, mirrors): same song title, dan, MSD and length.
// titleKey(title), or titleKey(artist, title) for a key of the song: lower case, without [tags], (notes) and punctuation.
export const titleKey = (...parts) => parts.map((part) => String(part ?? "").toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")).join("");
const near = (a, b, eps) => (a === null || b === null ? a === b : Math.abs(a - b) <= eps + 1e-9);
// a, b: { dan, msd, lengthSec } of two charts with the same title key (msd on one skillset, or null on both)
export const sameChart = (a, b) => near(a.dan, b.dan, 0.05) && near(a.msd, b.msd, 0.3) && near(a.lengthSec, b.lengthSec, 2);

function addByTitle(map, card) {
    const key = titleKey(card.title);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(card);
}

// Cards sorted by score → without repeats of a chart already shown or of a better card before it.
function dropRepeats(cards, shown) {
    const kept = new Map();
    return cards.filter((card) => {
        const key = titleKey(card.title);
        const repeat = key !== "" && [...(shown.get(key) ?? []), ...(kept.get(key) ?? [])].some((c) => sameChart(c, card));
        if (!repeat) addByTitle(kept, card);
        return !repeat;
    });
}

// A re-upload of a played chart wins over the played copy (no penalty), so it takes over the mark.
function markPlayed(cards, playedCharts) {
    for (const card of cards) {
        const key = titleKey(card.title);
        if (card.played || key === "") continue;
        const twin = (playedCharts.get(key) ?? []).find((c) => sameChart(c, card));
        if (twin) card.played = { accuracy: twin.play.accuracy, rate: twin.play.rate };
    }
}

// Inside a custom range every dan is one the player asked for, so none is preferred over another (the goals favour
// their window's middle): the cards rank by pattern purity and popularity. Only the ranking sees this copy.
const rankTargetOf = (target) => (target.goalId === CUSTOM_GOAL ? { ...target, halfWidth: Infinity } : target);

export function createRecommender({ api, pageBatch = 4, pageSize = 20 }) {
    let player = null;
    let playerLoads = 0;
    let session = null;
    let starts = 0;
    const playedCache = new Map(); // playerId → Map axis → Promise of that axis's plays

    // known: the exact { id, name } of the account logged in to osu!, which needs no name search.
    // A failed or superseded load leaves the previous player in place.
    async function loadPlayer(query, known = null) {
        const load = ++playerLoads;
        const user = known?.id ? { id: known.id, username: known.name || String(known.id), avatarUrl: null } : await api.findUser(query);
        if (!user) throw new Error(t("core.rec.playerNotFound"));
        const skill = readSkill(await api.skills(user.id));
        if (!skill.ready) {
            const name = user.username;
            if (skill.status === "ready" && !skill.tracked) throw new Error(t("core.rec.notTracked", { name }));
            throw new Error(skill.status === "ready" ? t("core.rec.no4k", { name }) : t("core.rec.notCounted", { name }));
        }
        const loaded = { id: user.id, username: user.username, avatarUrl: user.avatarUrl ?? null, skill };
        if (load === playerLoads) {
            player = loaded;
            playedCache.delete(user.id); // a reload also picks up plays made since
        }
        return loaded;
    }

    // Plays over every axis → { played, partial }. Each axis is asked once; one that failed is asked again on the
    // next start, the rest are kept. Only when no axis arrived is it an error.
    async function playedFor(who) {
        if (!playedCache.has(who.id)) playedCache.set(who.id, new Map());
        const axes = playedCache.get(who.id);
        for (const axis of PLAYED_AXES) {
            if (axes.has(axis)) continue;
            const job = api.playedMaps(who.id, [axis]);
            axes.set(axis, job);
            job.catch(() => { if (axes.get(axis) === job) axes.delete(axis); });
        }
        const results = await Promise.allSettled(PLAYED_AXES.map((axis) => axes.get(axis)));
        const got = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
        if (!got.length) throw results[0].reason;
        const played = new Map();
        for (const plays of got) {
            for (const [beatmapId, play] of plays) {
                if (!(played.get(beatmapId)?.accuracy >= play.accuracy)) played.set(beatmapId, play);
            }
        }
        return { played, partial: got.length < results.length };
    }

    const serverHasMore = (s) => !s.exhausted && (s.total === null || s.nextPage * SEARCH_PAGE_SIZE < s.total);

    // Next pageBatch server pages; the first page goes alone so the total is known before the rest.
    // The paging state moves only once the whole batch has arrived, so a failed batch is fetched again next time.
    async function fetchBatch(s) {
        const next = { nextPage: s.nextPage, total: s.total, exhausted: s.exhausted };
        const fetchPage = (page) => api.searchMaps(searchParams({ ...s.query, page }));
        const take = (res) => {
            if (next.total === null) next.total = res.total;
            if (res.items.length < SEARCH_PAGE_SIZE) next.exhausted = true;
            return res.items;
        };
        const pages = [];
        if (next.total === null) pages.push(take(await fetchPage(next.nextPage++)));
        const rest = [];
        while (pages.length + rest.length < pageBatch && serverHasMore(next)) rest.push(next.nextPage++);
        pages.push(...(await Promise.all(rest.map(fetchPage))).map(take));
        Object.assign(s, next);
        return pages.flat();
    }

    async function fill(s) {
        for (let batch = 0; batch < MAX_BATCHES_PER_CALL && s.queue.length < pageSize && serverHasMore(s); batch++) {
            const items = (await fetchBatch(s)).filter((item) => item && !s.seenSets.has(item.beatmapsetId));
            items.forEach((item) => s.seenSets.add(item.beatmapsetId));
            // A hidden played chart counts as shown, so its re-uploads are dropped as repeats too.
            const onPlayed = (chart, play) => addByTitle(s.hidePlayed ? s.shown : s.playedCharts, { ...chart, play });
            const cards = rankSets(items, s.rankTarget, { played: s.played, hidePlayed: s.hidePlayed, onPlayed });
            s.queue = dropRepeats([...s.queue, ...cards].sort(byScore), s.shown);
            markPlayed(s.queue, s.playedCharts);
        }
    }

    const hasMore = (s) => s.queue.length > 0 || serverHasMore(s);

    function take(s) {
        const cards = s.queue.splice(0, pageSize);
        cards.forEach((card) => addByTitle(s.shown, card));
        return cards;
    }

    async function start(request) {
        const run = ++starts;
        session = null;
        const r = request ?? {};
        if (!patternById(r.patternId)) throw new Error(t("core.rec.unknownPattern"));
        // a custom range is the window itself, so manual mode needs no dan for it
        const custom = r.goalId === CUSTOM_GOAL;
        const targetOf = (skill, manualDan) => (custom
            ? targetForRange({ skill, patternId: r.patternId, from: r.range?.from, to: r.range?.to })
            : targetFor({ skill, manualDan, patternId: r.patternId, goalId: r.goalId }));
        let target;
        let plays = { played: new Map(), partial: false };
        if (r.manual) {
            if (!custom && !Number.isFinite(r.manualDan)) throw new Error(t("core.rec.needManualDan"));
            target = targetOf(null, r.manualDan);
            // With a loaded profile its plays still get marked, and hidden when asked; only hiding needs them.
            if (player) {
                plays = await playedFor(player).catch((error) => {
                    if (r.hidePlayed) throw error;
                    return { played: new Map(), partial: true };
                });
            }
        } else {
            if (!player) throw new Error(t("core.rec.needProfile"));
            target = targetOf(player.skill, null);
            plays = await playedFor(player);
        }
        const s = {
            target,
            rankTarget: rankTargetOf(target),
            played: plays.played,
            hidePlayed: !!r.hidePlayed,
            query: { patternId: target.patternId, lo: target.lo, hi: target.hi, lengthId: r.lengthId, rankedOnly: !!r.rankedOnly },
            nextPage: 0,
            total: null,
            exhausted: false,
            seenSets: new Set(),
            queue: [],
            shown: new Map(), // title key → cards already handed out (and hidden played charts)
            playedCharts: new Map(), // title key → played charts, when they are shown
        };
        await fill(s);
        const cards = take(s);
        if (run === starts) session = s;
        return { target, cards, more: hasMore(s), total: s.total ?? 0, playedPartial: plays.partial };
    }

    async function more() {
        const s = session;
        if (!s) throw new Error(t("core.rec.needPicks"));
        await fill(s);
        // A newer start() replaced this session meanwhile: its cards no longer belong on screen.
        if (s !== session) return { cards: [], more: session ? hasMore(session) : false };
        return { cards: take(s), more: hasMore(s) };
    }

    // The loaded player for other tabs (the profile service): { id, username, avatarUrl, skill } or null.
    const currentPlayer = () => (player ? { id: player.id, username: player.username, avatarUrl: player.avatarUrl, skill: player.skill } : null);

    // The current player's plays over every axis, shared with the picks' own cache; no player → nothing played.
    // Throws only when no axis arrived at all.
    async function playedMaps() {
        if (!player) return { played: new Map(), partial: false };
        return playedFor(player);
    }

    return { loadPlayer, start, more, currentPlayer, playedMaps };
}
