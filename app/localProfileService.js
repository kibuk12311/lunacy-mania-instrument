// The local profile's main-process side: records the plays osu! (stable and lazer, through tosu) finishes, imports the
// history once (osu! stable's scores.db matched to the Songs folder, Interlude's Data\scores.db, osu! lazer's scores
// read from a copy of its realm database by app/lazerRealm.js), analyses each map at its rate once (the shared analysis
// cache, and maps.json), and keeps the skill (src/localProfile/model.js) up to date one play at a time. Every
// dependency is injected; nothing here throws at a caller.
// A lazer play the live recording already took is its imported score too (same map, rate, judgements): kept once.
import { createHash } from "node:crypto";
import path from "node:path";
import { createSkillModel, dailySkill, AXES, PATTERNS, performanceDan, DAY_MS } from "../src/localProfile/model.js";
import { parseScoresDb, mainPlayer } from "../src/localProfile/scoresDb.js";
import { createPlayRecorder } from "../src/localProfile/recorder.js";
import { mapKeyOf, mapSummary } from "./localProfileStore.js";

const TEXT_CACHE = 6; // .osu texts of the maps played last (fetched from tosu while the play goes on)
const md5Of = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
// What tosu served (the file's bytes, or text) → { md5 of the bytes as osu! names the map, the text to analyse }.
// The md5 is taken over the bytes: decoding first would drop a BOM and change it.
function served(x) {
    if (x === null || x === undefined) return null;
    const bytes = Buffer.isBuffer(x) ? x : x instanceof Uint8Array ? Buffer.from(x) : Buffer.from(String(x), "utf8");
    return { md5: createHash("md5").update(bytes).digest("hex"), text: bytes.toString("utf8").replace(/^﻿/, "") };
}
const round2 = (x) => Math.round(x * 100) / 100;

// store: app/localProfileStore.js; analyze(text, rate) → analysis result (the shared, cached service);
// fetchMapText() → the .osu tosu has selected (its bytes, or its text); readFile(path) → Buffer; songsIndex: app/osuSongsScan.js;
// osuFolders() → { game, songs } tosu reports for osu! stable (or nulls); defaultOsuFolder: %LOCALAPPDATA%\osu!;
// interlude: { linked(), scores(), osuFor(hash) }; lazer: app/lazerRealm.js { status(), read(), text(hash) } or null;
// preferredPlayer() → the osu! name logged in (tosu), or null; emit(channel, payload) → the window.
export function createLocalProfileService({
    store, analyze, fetchMapText = async () => null, readFile, exists = async () => false, songsIndex = null,
    osuFolders = async () => ({ game: null, songs: null }), defaultOsuFolder = null, interlude = null, lazer = null,
    preferredPlayer = async () => null, emit = () => {}, log = () => {}, now = Date.now,
}) {
    let model = null; // createSkillModel() over every stored play
    let cachedSkill = null; // { at, skill }
    let job = null; // the import running: { source, cancelled, progress }
    const texts = new Map(); // md5 → .osu text
    let queue = Promise.resolve();
    const serial = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    };

    const mapOf = (key) => store.mapsNow().get(key) ?? null;

    async function ensureModel() {
        if (model) return model;
        const plays = await store.plays();
        const next = createSkillModel();
        for (const p of plays) next.add(p, mapOf(p.mapKey));
        model ??= next;
        return model;
    }

    function rebuild() {
        model = null;
        cachedSkill = null;
    }

    async function skill() {
        await ensureModel();
        const at = now();
        if (!cachedSkill || at - cachedSkill.at > 60_000) cachedSkill = { at, skill: model.skill(at) };
        return cachedSkill.skill;
    }

    async function changed() {
        cachedSkill = null;
        try {
            emit("local-profile-changed", { skill: await skill() });
        } catch (error) {
            log(`local profile: notify failed: ${error?.message}`);
        }
    }

    // A map at a rate → its summary: maps.json, else the analysis (whose own cache has it if any tab analysed it);
    // noText: getText had none (the .osu is gone). A map asked again while it is worked out (its next play, begun
    // ahead) waits for that answer, so its getText is not called again and noText tells every play.
    const mapping = new Map(); // key → Promise of { key, map, noText? }
    function mapFor(md5, rate, getText) {
        const key = mapKeyOf(md5, rate);
        if (!mapping.has(key)) mapping.set(key, workOutMap(key, rate, getText).finally(() => mapping.delete(key)));
        return mapping.get(key);
    }

    async function workOutMap(key, rate, getText) {
        const known = await store.map(key);
        if (known) return { key, map: known };
        const text = await getText();
        if (!text) return { key, map: null, noText: true };
        const result = await analyze(text, rate);
        const summary = mapSummary(result);
        // a transient failure (the worker busy, cancelled) is worked out again next time
        if (summary && !(result?.kind === "error" && result.transient)) await store.setMap(key, summary);
        return { key, map: summary?.kind === "error" ? null : summary };
    }

    // An import's maps worked out analyze.lanes at once (the background line runs that many): ahead(todo, keyOf,
    // prepare) → mapAt(i), prepare(todo[i]) with the next ones begun as well, until lanes − 1 other maps are under way
    // or lanes × 2 plays are begun and not taken (a map played many times in a row is not read for all its plays at
    // once). keyOf(x): the map (and rate) x works out, so its other plays add none, or null when there is nothing to
    // work out (the loop skips those). The loop still takes the plays in order.
    function ahead(todo, keyOf, prepare) {
        const lanes = Math.max(1, Math.floor(Number(analyze.lanes) || 1));
        const begun = new Map(); // index (of a play with a key) → prepare's promise
        const waiting = new Map(); // index begun and not taken yet → its key
        let next = 0;
        const begin = () => {
            const j = next++;
            const key = keyOf(todo[j]);
            if (key !== null) {
                const p = prepare(todo[j]);
                p.catch(() => {}); // one begun ahead of a stop is never waited for
                waiting.set(j, key);
                begun.set(j, p);
            }
        };
        return (i) => {
            while (next <= i) begin();
            const own = waiting.get(i);
            waiting.delete(i);
            const others = () => new Set([...waiting.values()].filter((k) => k !== own)).size;
            while (others() < lanes - 1 && waiting.size < lanes * 2 && next < todo.length) begin();
            const p = begun.get(i) ?? null;
            begun.delete(i);
            return p;
        };
    }

    async function addPlay(play, map) {
        const { added, play: stored } = await store.addPlay(play);
        if (!added) return null;
        (await ensureModel()).add(stored, map ?? mapOf(stored.mapKey));
        return stored;
    }

    // ---- live ----

    function remember(md5, text) {
        texts.delete(md5);
        texts.set(md5, text);
        while (texts.size > TEXT_CACHE) texts.delete(texts.keys().next().value);
    }

    let fetching = null;
    function prefetch(md5) {
        if (!md5 || texts.has(md5) || fetching === md5) return;
        fetching = md5;
        Promise.resolve().then(fetchMapText).then((x) => {
            // the map must still be the one played (tosu answers for what is selected now)
            const got = served(x);
            if (got?.md5 === md5) remember(md5, got.text);
        }).catch(() => {}).finally(() => { if (fetching === md5) fetching = null; });
    }

    async function recordLive(p) {
        const settings = await store.settings();
        if (!settings.record) return null;
        const play = { ...p, id: `live:${p.client ?? "osu"}:${p.md5}:${p.startedAt}`, source: "live" };
        const fetchNow = () => Promise.resolve().then(fetchMapText).then((x) => {
            const got = served(x);
            return got?.md5 === p.md5 ? got.text : null;
        }).catch(() => null);
        const { map } = await mapFor(p.md5, p.rate, async () => texts.get(p.md5) ?? (await fetchNow()));
        const stored = await addPlay(play, map);
        const perf = stored ? performanceDan(stored, map) : null;
        log(`local profile: ${p.outcome} ${p.artist} - ${p.title} [${p.version}] ${p.rate}x ${p.accuracy !== null ? (p.accuracy * 100).toFixed(2) : "—"}%${perf ? ` → ${perf.dan}` : ""}${stored ? "" : " (already there)"}`);
        if (stored) await changed();
        return stored;
    }

    const recorder = createPlayRecorder({ onPlay: (p) => { serial(() => recordLive(p)).catch((e) => log(`local profile: live play not kept: ${e?.message}`)); } });

    function onTosuJson(json, at = now()) {
        recorder.onJson(json, at);
        const current = recorder.current();
        if (current) prefetch(current.md5);
    }

    // ---- import ----

    function progress(source, phase, done, total, extra = {}) {
        if (job) job.progress = { source, phase, done, total, ...extra };
        emit("local-profile-import", { source, phase, done, total, ...extra });
    }

    async function osuFolderNow(given) {
        if (given) return given;
        const settings = await store.settings();
        if (settings.osuFolder) return settings.osuFolder;
        const fromTosu = (await osuFolders().catch(() => null))?.game;
        return fromTosu || defaultOsuFolder;
    }

    // osu! stable's scores.db (mania, the main player's) → plays; only scores not in the profile yet are analysed,
    // so a stopped import goes on where it stopped.
    async function importStable({ folder = null } = {}) {
        const osu = await osuFolderNow(folder);
        if (!osu) return { ok: false, reason: "no-folder" };
        const dbFile = path.join(osu, "scores.db");
        if (!(await exists(dbFile))) return { ok: false, reason: "no-scores", folder: osu };
        await store.updateSettings((s) => ({ ...s, osuFolder: osu }));
        const parsed = parseScoresDb(await readFile(dbFile));
        const player = mainPlayer(parsed.scores, await preferredPlayer().catch(() => null));
        const mine = parsed.scores.filter((s) => s.player === player && s.md5).sort((a, b) => a.at - b.at);
        const plays = mine.map((s) => ({
            id: `stable:${s.replayMd5 || `${s.md5}:${s.at}`}`, source: "stable-db", client: "stable", md5: s.md5, rate: s.rate,
            mods: s.modNames, hits: s.hits, maxCombo: s.maxCombo, outcome: "pass", at: s.at,
        }));
        const todo = [];
        for (const p of plays) if (!(await store.has(p))) todo.push(p);
        log(`local profile: scores.db ${parsed.scores.length} mania scores, ${mine.length} by the main player, ${todo.length} new`);
        let charts = new Map();
        if (todo.length) {
            const tosuSongs = (await osuFolders().catch(() => null)) ?? {};
            const songs = tosuSongs.songs && tosuSongs.game && path.resolve(tosuSongs.game) === path.resolve(osu) ? tosuSongs.songs : path.join(osu, "Songs");
            const scanned = await songsIndex.scan(songs, {
                onProgress: ({ done, total }) => progress("stable", "scan", done, total),
                isCancelled: () => Boolean(job?.cancelled),
            });
            charts = scanned.charts;
            if (scanned.cancelled) return finishImport("stable", { added: 0, total: plays.length, done: plays.length - todo.length, player, cancelled: true });
        }
        let added = 0;
        let missing = 0;
        const mapAt = ahead(todo, (p) => (charts.has(p.md5) ? mapKeyOf(p.md5, p.rate) : null),
            (p) => mapFor(p.md5, p.rate, async () => (await readFile(charts.get(p.md5).path)).toString("utf8")));
        for (const [i, p] of todo.entries()) {
            if (job?.cancelled) return finishImport("stable", { added, total: plays.length, done: plays.length - todo.length + i, player, cancelled: true, missing });
            const chart = charts.get(p.md5);
            progress("stable", "analyse", i, todo.length, { added });
            if (!chart) {
                missing += 1;
                continue;
            }
            const { map } = await mapAt(i);
            const stored = await addPlay({ ...p, beatmapId: chart.beatmapId, beatmapsetId: chart.beatmapsetId, artist: chart.artist, title: chart.title, version: chart.version }, map);
            if (stored) added += 1;
            if (added && added % 50 === 0) await changed();
        }
        return finishImport("stable", { added, total: plays.length, done: plays.length, player, missing });
    }

    // Interlude's scores (no judgements: a pass is weaker evidence, see the model) → plays.
    async function importInterlude() {
        if (!interlude || !(await interlude.linked())) return { ok: false, reason: "no-interlude" };
        const rows = await interlude.scores();
        const plays = rows.map((r) => ({ ...r, id: `interlude:${r.hash}:${r.at}` }));
        const known = new Set((await store.plays()).map((p) => p.id));
        const todo = plays.filter((p) => !known.has(p.id));
        let added = 0;
        // a chart is read once while it is being read (its plays begun ahead share that read)
        const reading = new Map(); // hash → Promise of its .osu
        const osuOf = (hash) => {
            if (!reading.has(hash)) reading.set(hash, interlude.osuFor(hash).catch(() => null).finally(() => reading.delete(hash)));
            return reading.get(hash);
        };
        const mapAt = ahead(todo, (r) => `${r.hash}@${r.rate}`, async (r) => {
            const osu = await osuOf(r.hash);
            if (!osu) return null;
            const origin = osu.meta?.origins?.find((o) => o.md5 && Math.abs((o.rate ?? 1) - 1) < 1e-6) ?? osu.meta?.origins?.[0] ?? null;
            const md5 = origin?.md5 ?? md5Of(osu.text);
            return { osu, origin, md5, ...(await mapFor(md5, r.rate, async () => osu.text)) };
        });
        for (const [i, r] of todo.entries()) {
            if (job?.cancelled) return finishImport("interlude", { added, total: plays.length, done: plays.length - todo.length + i, cancelled: true });
            progress("interlude", "analyse", i, todo.length, { added });
            const got = await mapAt(i);
            if (!got) continue;
            const { osu, origin, md5, map } = got;
            const stored = await addPlay({
                id: r.id, source: "interlude-db", client: "interlude", md5, rate: r.rate, outcome: r.failed ? "fail" : "pass", at: r.at,
                beatmapId: origin?.beatmapId ?? null, beatmapsetId: origin?.beatmapsetId ?? null,
                artist: osu.meta?.artist ?? "", title: osu.meta?.title ?? "", version: osu.meta?.version ?? "",
            }, map);
            if (stored) added += 1;
        }
        return finishImport("interlude", { added, total: plays.length, done: plays.length });
    }

    // osu! lazer's scores (a copy of its realm database, read by app/lazerRealm.js) → plays: the main player's on 4K maps
    // at a fixed rate (wind up / down and adaptive speed have none). Each map at its rate is analysed once from the .osu
    // in lazer's files store; a map lazer no longer lists (or whose .osu is gone) is counted as missing.
    async function importLazer() {
        if (!lazer) return { ok: false, reason: "no-lazer" };
        progress("lazer", "read", 0, 0);
        const data = await lazer.read();
        if (!data?.found) return { ok: false, reason: "no-lazer" };
        const maps = new Map((data.maps ?? []).map((m) => [m.hash, m]));
        const usable = (data.scores ?? []).filter((s) => s.keys === 4 && s.md5 && Number.isFinite(s.rate));
        const player = mainPlayer(usable, await preferredPlayer().catch(() => null));
        const mine = usable.filter((s) => s.player === player).sort((a, b) => a.at - b.at);
        // md5 + rate + hits make the play's mapKey and judgement signature: the store knows a live play by them
        const plays = mine.map((s) => {
            const m = maps.get(s.hash) ?? null;
            return {
                hash: s.hash, known: Boolean(m),
                play: {
                    id: `lazer:${s.id}`, source: "lazer-db", client: "lazer", md5: s.md5, rate: s.rate, mods: s.mods, hits: s.hits,
                    maxCombo: s.maxCombo, outcome: s.failed ? "fail" : "pass", at: s.at,
                    beatmapId: m?.beatmapId ?? null, beatmapsetId: m?.setId ?? null, artist: m?.artist ?? "", title: m?.title ?? "", version: m?.version ?? "",
                },
            };
        });
        const todo = [];
        for (const x of plays) if (!(await store.has(x.play))) todo.push(x);
        log(`local profile: lazer ${data.scores?.length ?? 0} mania scores, ${usable.length} on 4K at a fixed rate, ${mine.length} by the main player, ${todo.length} new`);
        let added = 0;
        let missing = 0;
        const mapAt = ahead(todo, ({ hash, known, play }) => (known ? `${hash}@${play.rate}` : null),
            ({ hash, play }) => mapFor(play.md5, play.rate, () => lazer.text(hash).catch(() => null)));
        for (const [i, { known, play }] of todo.entries()) {
            if (job?.cancelled) return finishImport("lazer", { added, total: plays.length, done: plays.length - todo.length + i, player, cancelled: true, missing });
            progress("lazer", "analyse", i, todo.length, { added });
            if (!known) {
                missing += 1;
                continue;
            }
            const { map, noText } = await mapAt(i);
            if (noText) {
                missing += 1;
                continue;
            }
            const stored = await addPlay(play, map);
            if (stored) added += 1;
            if (stored && added % 50 === 0) await changed();
        }
        return finishImport("lazer", { added, total: plays.length, done: plays.length, player, missing });
    }

    async function finishImport(source, r) {
        const finished = !r.cancelled;
        await store.updateSettings((s) => ({
            ...s, imports: { ...s.imports, [source]: { at: now(), added: r.added, total: r.total, done: r.done, finished, player: r.player ?? null } },
        }));
        const where = source === "lazer" ? "in lazer's library" : "in Songs";
        log(`local profile: ${source} import ${finished ? "done" : "stopped"}: ${r.added} added of ${r.total}${r.missing ? `, ${r.missing} maps not ${where}` : ""}`);
        await changed();
        return { ok: true, source, ...r, finished };
    }

    const IMPORTS = { stable: importStable, interlude: importInterlude, lazer: importLazer };

    // one import at a time; → its answer
    async function runImport(source, options) {
        if (job) return { ok: false, reason: "busy" };
        job = { source, cancelled: false, progress: null };
        try {
            return await IMPORTS[source](options);
        } catch (error) {
            log(`local profile: ${source} import failed: ${error?.message}`);
            return { ok: false, reason: "failed", message: String(error?.message ?? error) };
        } finally {
            job = null;
            emit("local-profile-import", { source, phase: "end" });
        }
    }

    // ---- what the window shows ----

    // A play with its map and performance, for the lists.
    function describe(p) {
        const map = mapOf(p.mapKey);
        const perf = performanceDan(p, map);
        return {
            id: p.id, client: p.client, source: p.source, artist: p.artist, title: p.title, version: p.version, rate: p.rate,
            mods: p.mods, accuracy: p.hits ? round2(accuracyPct(p.hits)) : p.accuracy === null ? null : round2(p.accuracy * 100),
            outcome: p.outcome, at: p.at, beatmapId: p.beatmapId, mapDan: map?.kind === "ok" ? map.numeric : null,
            mapLabel: map?.kind === "ok" ? map.label : null, unrated: !map || map.kind !== "ok", perf: perf?.dan ?? null,
            calcs: map?.kind === "ok" ? map.calcs : null,
        };
    }

    async function status({ recent = 12, top = 5 } = {}) {
        const plays = await store.plays();
        const k = await skill();
        const byId = new Map(plays.map((p) => [p.id, p]));
        const topOf = (est) => (est?.top ?? []).slice(0, top).map((x) => ({ ...describe(byId.get(x.playId)), eff: x.eff, weight: x.weight })).filter((x) => x.id);
        // lazer: every lazer play (recorded or imported); lazerDb: the ones its database import added
        const counts = { plays: plays.length, rated: k.analyzedPlays, live: 0, stable: 0, interlude: 0, lazer: 0, lazerDb: 0 };
        for (const p of plays) {
            if (p.source === "live") counts.live += 1;
            if (p.source === "stable-db") counts.stable += 1;
            if (p.source === "interlude-db") counts.interlude += 1;
            if (p.source === "lazer-db") counts.lazerDb += 1;
            if (p.client === "lazer") counts.lazer += 1;
        }
        return {
            ok: true,
            skill: k,
            settings: await store.settings(),
            counts,
            top: Object.fromEntries([...AXES.map((a) => [a, topOf(k.axes[a])]), ...PATTERNS.map((p) => [`p:${p}`, topOf(k.patterns[p])])]),
            recent: [...plays].sort((a, b) => b.at - a.at).slice(0, recent).map(describe),
            importing: job ? { source: job.source, ...(job.progress ?? {}) } : null,
            interludeLinked: Boolean(interlude && (await interlude.linked().catch(() => false))),
            lazerFound: Boolean(lazer && (await lazer.status().catch(() => null))?.found),
        };
    }

    // The skill over the last `days` days: daily points (overall, axes, patterns), the plays of the period and its
    // best ones, the change first → last.
    async function history(days) {
        const plays = await store.plays();
        const to = now();
        const since = to - days * DAY_MS;
        const points = dailySkill(plays, mapOf, { from: since, to });
        const inPeriod = plays.filter((p) => p.at >= since).sort((a, b) => b.at - a.at);
        const described = inPeriod.map(describe);
        const best = described.filter((p) => p.perf !== null).sort((a, b) => b.perf - a.perf).slice(0, 10);
        // every play of the period as the picks' progress joins them (src/recommend/progress.js joinPicks)
        const joinable = inPeriod.filter((p) => p.beatmapId).map((p) => ({
            beatmapId: p.beatmapId, at: p.at, rate: p.rate, passed: p.outcome === "pass",
            accuracy: p.hits ? accuracyPct(p.hits) / 100 : p.accuracy,
        }));
        return { ok: true, since, now: to, points, change: pointsChange(points), plays: described.slice(0, 30), best, count: inPeriod.length, joinable };
    }

    // osu! beatmap id → { beatmapsetId, accuracy, rate, playedAt } of every map played (the picks' "hide played").
    async function playedBeatmaps() {
        const out = new Map();
        for (const p of await store.plays()) {
            if (!p.beatmapId) continue;
            const known = out.get(p.beatmapId);
            if (!known || p.at > known.playedAt) {
                out.set(p.beatmapId, { beatmapsetId: p.beatmapsetId, accuracy: p.hits ? accuracyPct(p.hits) / 100 : p.accuracy, rate: p.rate, playedAt: p.at, local: true });
            }
        }
        return out;
    }

    return {
        onTosuJson,
        onTosuDown: () => recorder.onDown(now()),
        recordLive: (p) => serial(() => recordLive(p)),
        skill,
        status,
        history,
        playedBeatmaps,
        importStable: (options) => runImport("stable", options),
        importInterlude: () => runImport("interlude"),
        importLazer: () => runImport("lazer"),
        cancelImport: () => { if (job) job.cancelled = true; return { ok: true }; },
        importing: () => (job ? { source: job.source, ...(job.progress ?? {}) } : null),
        // whether live plays are recorded (the overlay's Dan widget shows a play's own dan only then)
        recording: async () => {
            try {
                return (await store.settings()).record === true;
            } catch {
                return false;
            }
        },
        setRecord: async (on) => {
            const s = await store.updateSettings((x) => ({ ...x, record: Boolean(on) }));
            // the Profile tab's box and the Settings page's follow it
            emit("local-profile-changed", { skill: await skill(), record: s.record });
            return { ok: true, record: s.record };
        },
        exportBundle: () => store.exportBundle(),
        importBundle: async (bundle) => {
            const r = await store.importBundle(bundle);
            rebuild();
            await changed();
            return r;
        },
        reset: async () => {
            await store.reset();
            rebuild();
            await changed();
            return { ok: true };
        },
    };
}

function accuracyPct(h) {
    const total = h.max + h.n300 + h.n200 + h.n100 + h.n50 + h.miss;
    return total ? (100 * (300 * (h.max + h.n300) + 200 * h.n200 + 100 * h.n100 + 50 * h.n50)) / (300 * total) : 0;
}

// First → last point: the overall dan and every axis / pattern both ends have, biggest gain first.
export function pointsChange(points) {
    if (!points?.length) return null;
    const first = points[0];
    const last = points.at(-1);
    const keys = [...AXES, ...PATTERNS.map((p) => `p:${p}`)];
    const axes = keys.filter((k) => Number.isFinite(first.ratings?.[k]) && Number.isFinite(last.ratings?.[k]))
        .map((k) => ({ axis: k, from: first.ratings[k], to: last.ratings[k], delta: round2(last.ratings[k] - first.ratings[k]) }))
        .sort((a, b) => b.delta - a.delta);
    const danDelta = Number.isFinite(first.dan) && Number.isFinite(last.dan) ? round2(last.dan - first.dan) : null;
    return { danFrom: first.dan ?? null, danTo: last.dan ?? null, danDelta, axes };
}
