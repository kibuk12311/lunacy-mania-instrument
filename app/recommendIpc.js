// Main-process side of the "Рекомендации" tab: checks what the renderer sends, builds every URL itself, never throws.
// All dependencies are injected (no electron import) so the handlers run under node:test with fakes.

import { patternById, goalById, lengthById } from "../src/recommend/catalog.js";
import { SEARCH_PAGE_SIZE } from "../src/recommend/rank.js";
import { cleanSeed, similarParams, pickSimilar, SIMILAR_PAGES } from "../src/recommend/similar.js";
import { createPlanner, PLAN_SIZES } from "../src/recommend/plan.js";
import { CUSTOM_GOAL } from "../src/recommend/skill.js";
import { normalizeManualProfile, manualSkill } from "../src/recommend/manualProfile.js";
import { t, getLang } from "../src/i18n/i18n.js";
import { MIN_DAN, MAX_DAN, positiveId, danOf } from "./validate.js";
import { createRecStore } from "./recStore.js";
import { createFavHandlers } from "./recFavIpc.js";
import { createProgressHandlers } from "./recProgressIpc.js";

const OURS_CACHE_SIZE = 300;
// Cards the tab was shown (start, more, plan, similar), by beatmap id: the journal and the favourites take their data from here.
const CARD_INDEX_SIZE = 3000;
const SIMILAR_CACHE_SIZE = 50;
const SIMILAR_CACHE_MS = 60_000;
const MAX_PLAN_PATTERNS = 3;
const fail = (error) => ({ ok: false, message: error?.message || t("app.rec.unknownError") });

// rateFit.js is loaded on first use, so these handlers stay testable with a fake.
async function defaultSuggestRate(args) {
    const { suggestRate } = await import("../src/recommend/rateFit.js");
    return suggestRate(args);
}

// onPlayer(query, loaded): told after every successful player load (the shared profile remembers it).
// store: the picks journal (app/recStore.js); planner: src/recommend/plan.js; searchMaps: the tracker search (similar maps).
export function createRecommendHandlers({
    recommender, analyze, fetchText, openExternal, fetchProfile, log = () => {}, suggestRateImpl = defaultSuggestRate,
    downloader = null, openPath = async () => t("app.rec.noDownloader"), showFile = () => {}, progress = () => {},
    onPlayer = () => {}, store = null, planner = null, searchMaps = null, now = Date.now,
}) {
    // start/more share the recommender's paging state, so they run one at a time in the order asked.
    let queue = Promise.resolve();
    const serial = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    };
    // "lang beatmapId@center" → Promise of a suggestRate result; a refusal is kept with its text, so per language
    const oursCache = new Map();
    // The account tosu reported in me(): its name (or id) loads by that exact id, not by the tracker's prefix search.
    let osuAccount = null;

    // beatmapId → card, the most recently shown last
    const cardIndex = new Map();
    function rememberCards(cards) {
        for (const card of cards ?? []) {
            const id = positiveId(card?.beatmapId);
            if (!id) continue;
            cardIndex.delete(id);
            cardIndex.set(id, card);
            if (cardIndex.size > CARD_INDEX_SIZE) cardIndex.delete(cardIndex.keys().next().value);
        }
    }
    const cardFor = (beatmapId) => cardIndex.get(positiveId(beatmapId)) ?? null;

    // The first time a shown map is downloaded, opened in osu!direct or added to the favourites; never holds up the answer.
    function journal(card, how) {
        if (!store || !card) return;
        Promise.resolve()
            .then(() => store.picks.add({ ...card, how, at: now() }))
            .catch((error) => log(`rec journal ${card.beatmapId} ${how} failed: ${error?.message}`));
    }

    async function player(query) {
        const q = typeof query === "string" || typeof query === "number" ? String(query).trim().slice(0, 64) : "";
        if (!q) return { ok: false, message: t("app.rec.needPlayer") };
        const known = osuAccount && (q === String(osuAccount.id) || (osuAccount.name && q.toLowerCase() === osuAccount.name.toLowerCase()))
            ? osuAccount : null;
        try {
            const p = await recommender.loadPlayer(q, known);
            log(`rec player ${p.username} (${p.id}) ${p.skill?.overallLabel ?? "—"}`);
            try {
                onPlayer(q, p);
            } catch (error) {
                log(`rec player remember failed: ${error?.message}`);
            }
            return { ok: true, player: { id: p.id, username: p.username, avatarUrl: p.avatarUrl }, skill: p.skill };
        } catch (error) {
            log(`rec player "${q}" failed: ${error?.message}`);
            return fail(error);
        }
    }

    async function me() {
        try {
            const profile = await fetchProfile();
            const id = positiveId(profile?.id);
            if (id) {
                const name = typeof profile.name === "string" ? profile.name.trim().slice(0, 64) : "";
                osuAccount = { id, name };
                return { ok: true, query: name || String(id) };
            }
        } catch {
            // tosu unreachable is the same as osu! closed
        }
        return { ok: false, message: t("app.rec.notLoggedIn") };
    }

    // Manual mode's hand-set profile (Speed / Jack / Stamina / Tech) as a skill: undefined when none was sent,
    // null when what was sent is not a profile the editor can make.
    function handSetSkill(r) {
        if (!r?.manual || r.manualProfile === undefined || r.manualProfile === null) return undefined;
        return manualSkill(normalizeManualProfile(r.manualProfile));
    }

    // Renderer request → the exact shape the recommender expects, or a reason in the current language.
    // A custom range ("custom" goal) brings { from, to } instead of using the manual dan: both inside the picker's ends.
    const inPicker = (dan) => dan !== null && dan >= MIN_DAN && dan <= MAX_DAN;
    function cleanRequest(r) {
        const pattern = patternById(r?.patternId);
        const custom = r?.goalId === CUSTOM_GOAL;
        const goal = custom ? { id: CUSTOM_GOAL } : goalById(r?.goalId);
        const length = lengthById(r?.lengthId);
        if (!pattern) return t("app.rec.choosePattern");
        if (!goal) return t("app.rec.chooseGoal");
        if (!length) return t("app.rec.chooseLength");
        const manual = Boolean(r.manual);
        let range = null;
        if (custom) {
            const from = danOf(r.range?.from);
            const to = danOf(r.range?.to);
            if (!inPicker(from) || !inPicker(to)) return t("recommend.err.badRange");
            range = { from: Math.min(from, to), to: Math.max(from, to) };
        }
        const skill = handSetSkill(r);
        if (skill === null) return t("recommend.err.badManualProfile");
        const manualDan = manual && !custom && !skill ? danOf(r.manualDan) : null;
        if (manual && !custom && !skill && !inPicker(manualDan)) return t("app.rec.chooseDan");
        return {
            manual, manualDan, ...(skill ? { manualSkill: skill } : {}), patternId: pattern.id, goalId: goal.id, ...(range ? { range } : {}), lengthId: length.id,
            rankedOnly: Boolean(r.rankedOnly), hidePlayed: Boolean(r.hidePlayed),
        };
    }

    function start(request) {
        const req = cleanRequest(request);
        if (typeof req === "string") return Promise.resolve({ ok: false, message: req });
        return serial(async () => {
            try {
                const out = await recommender.start(req);
                const target = out.target;
                const partial = Boolean(out.playedPartial);
                log(`rec start ${req.patternId} ${req.goalId} ${target?.lo}..${target?.hi}${req.manual ? (req.manualSkill ? " (hand-set profile)" : " (manual)") : ""} → ${out.cards.length} cards, server ${out.total}${partial ? ", plays partial" : ""}`);
                rememberCards(out.cards);
                return { ok: true, target, cards: out.cards, more: Boolean(out.more), total: out.total, playedPartial: partial };
            } catch (error) {
                log(`rec start ${req.patternId} ${req.goalId} failed: ${error?.message}`);
                return fail(error);
            }
        });
    }

    function more() {
        return serial(async () => {
            try {
                const out = await recommender.more();
                log(`rec more → ${out.cards.length} cards${out.more ? "" : ", end"}`);
                rememberCards(out.cards);
                return { ok: true, cards: out.cards, more: Boolean(out.more) };
            } catch (error) {
                log(`rec more failed: ${error?.message}`);
                return fail(error);
            }
        });
    }

    // keep=false: a download failure, a transient analyzer error or our dan without a rate (the card offers
    // «попробуй ещё раз»), worth retrying on the next click.
    async function fitRate(beatmapId, trackerDan, center) {
        let transient = false;
        const analyzeOnce = async (osuText, rate) => {
            const r = await analyze(osuText, rate);
            if (r?.transient) transient = true;
            return r;
        };
        try {
            const osuText = await fetchText(`https://osu.ppy.sh/osu/${beatmapId}`);
            // osu.ppy.sh answers an empty 200 for a deleted map
            if (typeof osuText !== "string" || !osuText.includes("[HitObjects]")) throw new Error(t("app.rec.noOsuFile"));
            const result = await suggestRateImpl({ analyze: analyzeOnce, osuText, trackerDan, center });
            if (!result || typeof result !== "object") throw new Error(t("app.rec.fitFailed"));
            log(`rec ours ${beatmapId} → ${result.ok ? `${result.ours?.label} rate ${result.rate ?? "—"}` : result.message}`);
            const noRate = result.ok && result.rate == null && !result.reason;
            return { result, keep: !transient && !noRate };
        } catch (error) {
            log(`rec ours ${beatmapId} failed: ${error?.message}`);
            return { result: fail(error), keep: false };
        }
    }

    function ours(req) {
        const beatmapId = positiveId(req?.beatmapId);
        const trackerDan = danOf(req?.trackerDan);
        const center = danOf(req?.center);
        if (!beatmapId || trackerDan === null || center === null) return Promise.resolve({ ok: false, message: t("app.rec.noMapData") });
        const key = `${getLang()} ${beatmapId}@${center.toFixed(2)}`;
        if (!oursCache.has(key)) {
            const job = fitRate(beatmapId, trackerDan, center).then(({ result, keep }) => {
                if (!keep && oursCache.get(key) === job) oursCache.delete(key);
                return result;
            });
            oursCache.set(key, job);
            if (oursCache.size > OURS_CACHE_SIZE) oursCache.delete(oursCache.keys().next().value);
        }
        return oursCache.get(key);
    }

    async function open(req) {
        const id = positiveId(req?.beatmapId);
        const url = !id ? null
            : req.kind === "site" ? `https://osu.ppy.sh/beatmaps/${id}`
                : req.kind === "direct" ? `osu://b/${id}` : null;
        if (!url) return { ok: false, message: t("app.rec.cantOpen") };
        try {
            await openExternal(url);
            log(`rec open ${url}`);
            if (req.kind === "direct") journal(cardFor(id), "direct");
            return { ok: true };
        } catch (error) {
            log(`rec open ${url} failed: ${error?.message}`);
            return { ok: false, message: t(req.kind === "direct" ? "app.rec.directFailed" : "app.rec.pageFailed") };
        }
    }

    // One click: the set's .osz from a mirror, then osu! opens (imports) it through its file association.
    const downloaded = new Set(); // files this session saved; the only ones "show" reveals
    async function download(req) {
        const beatmapsetId = positiveId(req?.beatmapsetId);
        if (!beatmapsetId || typeof req.beatmapsetId !== "number") return { ok: false, message: t("app.rec.noMapData") };
        const text = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
        try {
            const out = await downloader.download({
                beatmapsetId, artist: text(req.artist), title: text(req.title),
                onProgress: ({ received, total }) => progress({ beatmapsetId, received, total }),
            });
            downloaded.add(out.file);
            log(`rec download ${beatmapsetId} ${out.reused ? "already on disk" : `from ${out.mirror}, ${out.bytes} bytes`}`);
            const card = cardFor(req.beatmapId);
            if (card?.beatmapsetId === beatmapsetId) journal(card, "download");
            const problem = await openPath(out.file);
            if (problem) {
                log(`rec download ${beatmapsetId} open failed: ${problem}`);
                return { ok: true, file: out.file, opened: false, reused: out.reused, message: t("app.rec.notOpened") };
            }
            return { ok: true, file: out.file, opened: true, reused: out.reused };
        } catch (error) {
            log(`rec download ${beatmapsetId} failed: ${error?.message}${error?.details ? ` (${error.details.join("; ")})` : ""}`);
            return fail(error);
        }
    }

    function show(file) {
        if (typeof file !== "string" || !downloaded.has(file)) return { ok: false, message: t("app.noSuchFile") };
        showFile(file);
        return { ok: true };
    }
    // a file the tab wrote itself (the exported collection.db) may be shown too
    const allowShow = (file) => { if (typeof file === "string") downloaded.add(file); };

    // ---- plan ----

    // builds and swaps share the planner's session, so they run one at a time
    let planQueue = Promise.resolve();
    const serialPlan = (fn) => {
        const run = planQueue.then(fn);
        planQueue = run.catch(() => {});
        return run;
    };

    function cleanPlanRequest(r) {
        if (!PLAN_SIZES.includes(r?.size)) return t("recommend.err.planSize");
        const unique = Array.isArray(r.patternIds) ? [...new Set(r.patternIds)] : [];
        if (!unique.length || unique.length > MAX_PLAN_PATTERNS || !unique.every((id) => typeof id === "string" && patternById(id))) {
            return t("recommend.err.planPatterns");
        }
        const length = lengthById(r.lengthId);
        if (!length) return t("app.rec.chooseLength");
        const manual = Boolean(r.manual);
        const skill = handSetSkill(r);
        if (skill === null) return t("recommend.err.badManualProfile");
        const manualDan = manual && !skill ? danOf(r.manualDan) : null;
        if (manual && !skill && !(manualDan >= MIN_DAN && manualDan <= MAX_DAN)) return t("app.rec.chooseDan");
        return { size: r.size, patternIds: unique, lengthId: length.id, rankedOnly: Boolean(r.rankedOnly), manual, manualDan, ...(skill ? { manualSkill: skill } : {}) };
    }

    function plan(request) {
        const req = cleanPlanRequest(request);
        if (typeof req === "string") return Promise.resolve({ ok: false, message: req });
        return serialPlan(async () => {
            try {
                const out = await planner.build(req);
                const cards = out.slots.map((s) => s.card).filter(Boolean);
                rememberCards(cards);
                log(`rec plan ${req.size} ${req.patternIds.join("+")}${req.manual ? (req.manualSkill ? " (hand-set profile)" : " (manual)") : ""} → ${cards.length}/${out.slots.length} cards, ${Math.round(out.totalSec)} s${out.playedPartial ? ", plays partial" : ""}`);
                return { ok: true, header: out.header, slots: out.slots, totalSec: out.totalSec, playedPartial: Boolean(out.playedPartial) };
            } catch (error) {
                log(`rec plan failed: ${error?.message}`);
                return fail(error);
            }
        });
    }

    function planSwap(req) {
        const slot = req?.slot;
        if (!Number.isInteger(slot) || slot < 0 || slot >= Math.max(...PLAN_SIZES)) return Promise.resolve({ ok: false, message: t("recommend.err.badSlot") });
        return serialPlan(async () => {
            try {
                const card = planner.swap(slot) ?? null;
                rememberCards([card]);
                return { ok: true, card };
            } catch (error) {
                return fail(error);
            }
        });
    }

    // ---- similar ----

    const similarCache = new Map(); // "beatmapId ranked hide lang" → { at, job }
    async function findSimilar(seed, self, rankedOnly, hidePlayed) {
        const items = [];
        for (let page = 0; page < SIMILAR_PAGES; page++) {
            const res = await searchMaps(similarParams(seed, rankedOnly, page));
            items.push(...(res?.items ?? []));
            if ((res?.items?.length ?? 0) < SEARCH_PAGE_SIZE) break;
        }
        // plays only mark or hide cards: none known (or none loaded) is no reason to fail
        const { played } = await recommender.playedMaps().catch(() => ({ played: new Map() }));
        return pickSimilar(items, seed, { played, hidePlayed, self });
    }

    async function similar(req) {
        const beatmapId = positiveId(req?.beatmapId);
        const known = beatmapId ? cardFor(beatmapId) : null;
        const seed = cleanSeed(known?.seed) ?? cleanSeed(req?.seed);
        if (!beatmapId || !seed) return { ok: false, message: t("recommend.err.noSeed") };
        const rankedOnly = Boolean(req.rankedOnly);
        const hidePlayed = Boolean(req.hidePlayed);
        const self = {
            beatmapId,
            beatmapsetId: known?.beatmapsetId ?? positiveId(req.beatmapsetId),
            title: known?.title ?? (typeof req.title === "string" ? req.title.slice(0, 200) : ""),
        };
        const key = `${beatmapId} ${rankedOnly} ${hidePlayed} ${getLang()}`;
        const hit = similarCache.get(key);
        let job = hit && now() - hit.at < SIMILAR_CACHE_MS ? hit.job : null;
        if (!job) {
            job = findSimilar(seed, self, rankedOnly, hidePlayed);
            similarCache.delete(key);
            similarCache.set(key, { at: now(), job });
            if (similarCache.size > SIMILAR_CACHE_SIZE) similarCache.delete(similarCache.keys().next().value);
            job.catch(() => { if (similarCache.get(key)?.job === job) similarCache.delete(key); });
        }
        try {
            const cards = await job;
            rememberCards(cards);
            log(`rec similar ${beatmapId} → ${cards.length} cards`);
            return { ok: true, cards };
        } catch (error) {
            log(`rec similar ${beatmapId} failed: ${error?.message}`);
            return fail(error);
        }
    }

    return { player, me, start, more, ours, open, download, show, allowShow, plan, planSwap, similar, cardFor, journal };
}

// The raw bytes of an .osu from osu.ppy.sh (their MD5 is the beatmap's checksum, which collection.db lists).
async function fetchBytes(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
        // network error or timeout: same message as a bad status
    }
    throw new Error(t("app.rec.noOsuFile"));
}

// Text from osu.ppy.sh (an .osu); a bad status, a network error or a timeout all give the same message.
async function fetchText(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) return await res.text();
    } catch {
        // network error or timeout: same message as a bad status
    }
    throw new Error(t("app.rec.noOsuFile"));
}

// The "Подбор" tab's channels on the app's shared services (main.js deps).
export function registerRecommendIpc({ ipcMain, shell, send, log, tosu, analysis, recommender, downloader, profile, trackerApi, paths }) {
    // userData/favourites.json and picks.json; nothing is read before the first use
    const store = createRecStore({ dir: paths.userData });
    const recommend = createRecommendHandlers({
        recommender,
        // background line: a card's rate fit never holds up the selected map's card
        analyze: (osuText, rate) => analysis.analyzeQueued(osuText, rate),
        fetchText,
        openExternal: (url) => shell.openExternal(url),
        fetchProfile: () => tosu.profile(),
        log,
        downloader,
        openPath: (file) => shell.openPath(file),
        showFile: (file) => shell.showItemInFolder(file),
        progress: (event) => send("rec-download-progress", event),
        onPlayer: (query, loaded) => profile.remember(query, loaded),
        store,
        planner: createPlanner({ api: trackerApi, recommender }),
        searchMaps: (params) => trackerApi.searchMaps(params),
    });
    const favourites = createFavHandlers({
        store,
        fetchBytes,
        docsDir: () => paths.docsDir,
        log,
        progress: (event) => send("rec-fav-export-progress", event),
        cardFor: recommend.cardFor,
        onAdded: (card) => recommend.journal(card, "fav"),
        onExported: (file) => recommend.allowShow(file),
        client: () => tosu?.client?.() ?? null,
    });
    const progressHandlers = createProgressHandlers({ store, trackerApi, recommender, log });
    ipcMain.handle("rec-player", (_e, query) => recommend.player(query));
    ipcMain.handle("rec-me", () => recommend.me());
    ipcMain.handle("rec-start", (_e, request) => recommend.start(request));
    ipcMain.handle("rec-more", () => recommend.more());
    ipcMain.handle("rec-ours", (_e, req) => recommend.ours(req));
    ipcMain.handle("rec-open", (_e, req) => recommend.open(req));
    ipcMain.handle("rec-download", (_e, req) => recommend.download(req));
    ipcMain.handle("rec-show", (_e, file) => recommend.show(file));
    ipcMain.handle("rec-plan", (_e, req) => recommend.plan(req));
    ipcMain.handle("rec-plan-swap", (_e, req) => recommend.planSwap(req));
    ipcMain.handle("rec-similar", (_e, req) => recommend.similar(req));
    ipcMain.handle("rec-fav-list", () => favourites.list());
    ipcMain.handle("rec-fav-add", (_e, req) => favourites.add(req));
    ipcMain.handle("rec-fav-remove", (_e, req) => favourites.remove(req));
    ipcMain.handle("rec-fav-export", (_e, req) => favourites.exportDb(req));
    ipcMain.handle("rec-progress", (_e, req) => progressHandlers.progress(req));
}
