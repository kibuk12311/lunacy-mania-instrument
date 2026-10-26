// Main-process side of "Прогресс": the picks journal of the period joined with the plays mania-tracker knows
// (recent scores, else skill plays) and the player's skill history as chart points. Dependencies are injected; nothing throws.
import { readRecent, readHistory, dailyPoints, skillChange, joinPicks, DAY_MS } from "../src/recommend/progress.js";
import { t } from "../src/i18n/i18n.js";

export const PROGRESS_DAYS = [7, 30, 90];
const HISTORY_CACHE_MS = 5 * 60_000;
const MAX_HISTORY_PAGES = 8;

const fail = (error) => ({ ok: false, message: error?.message || t("app.rec.unknownError") });

// store: app/recStore.js; trackerApi: recent, skillHistory; recommender: currentPlayer, playedMaps.
export function createProgressHandlers({
    store, trackerApi, recommender, log = () => {}, now = Date.now, historyTtlMs = HISTORY_CACHE_MS, maxPages = MAX_HISTORY_PAGES,
}) {
    // player id → the history pages read so far: { at, items (newest first), nextBefore, pages, done }
    const histories = new Map();

    // Pages until one reaches back past `since` (the snapshot before the period opens the chart), the end, or maxPages.
    async function historySince(id, since) {
        let h = histories.get(id);
        if (!h || now() - h.at >= historyTtlMs) {
            h = { at: now(), items: [], nextBefore: null, pages: 0, done: false };
            histories.set(id, h);
        }
        while (!h.done && h.pages < maxPages && !(h.items.length && h.items.at(-1).at < since)) {
            const page = readHistory(await trackerApi.skillHistory(id, h.pages ? { before: h.nextBefore } : {}));
            h.items.push(...page.items);
            h.pages += 1;
            h.nextBefore = page.nextBefore;
            if (!page.nextBefore || !page.items.length) h.done = true;
        }
        return h.items;
    }

    // one at a time: quick switches between 7 / 30 / 90 share the history pages instead of reading them twice
    let queue = Promise.resolve();
    const serial = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    };

    async function run(days) {
        const player = recommender.currentPlayer();
        if (!player) return { ok: false, message: t("core.rec.needProfile") };
        const since = now() - days * DAY_MS;
        try {
            const picks = (await store.picks.list()).filter((p) => p.at >= since);
            const missing = [];
            const lost = (what) => (error) => {
                missing.push(what);
                log(`rec progress ${what} failed: ${error?.message}`);
            };
            const [recent, played, history] = await Promise.all([
                Promise.resolve().then(() => trackerApi.recent(player.id)).then(readRecent).catch((e) => { lost("recent")(e); return []; }),
                Promise.resolve().then(() => recommender.playedMaps()).then((r) => r.played).catch((e) => { lost("plays")(e); return new Map(); }),
                historySince(player.id, since).catch((e) => { lost("history")(e); return []; }),
            ]);
            const joined = joinPicks(picks, recent, played);
            const points = dailyPoints(history, since);
            const playedCount = joined.filter((p) => p.play).length;
            log(`rec progress ${days}d: ${playedCount}/${joined.length} played, ${points.length} points${missing.length ? `, no ${missing.join("+")}` : ""}`);
            return {
                ok: true, since, picks: joined, played: playedCount, total: joined.length,
                points, change: skillChange(points), partial: missing.length > 0,
            };
        } catch (error) {
            log(`rec progress failed: ${error?.message}`);
            return fail(error);
        }
    }

    function progress(req) {
        const days = req?.days;
        if (!PROGRESS_DAYS.includes(days)) return Promise.resolve({ ok: false, message: t("recommend.err.badDays") });
        return serial(() => run(days));
    }

    return { progress };
}
