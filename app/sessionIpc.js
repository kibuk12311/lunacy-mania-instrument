// Main-process side of the picks tab's "Сессия" page: the player's own library (app/sessionLibrary.js), a session
// built from it for their skill (src/recommend/session.js) with the rates checked by a real analysis, one item or the
// whole session drawn again, saved sessions (userData\sessions.json), and the session taken out of the app: an osu!
// stable collection (collection.db in Documents\<app>\коллекции, the collections already there kept, the old file kept
// as collection.db.bak; a rate other than 1.0 made as a rate copy next to the map first, like the rate tab), one
// marathon .osz (app/marathonCreate.js) and, from the window, a playlist in Interlude (interlude-export, with rates).
// Every handler answers instead of throwing; dependencies are injected, so it runs under node:test.
import * as nodeFs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    buildSession, rerollItem, cleanSessionRequest, sessionSeconds, sessionName, RATE, RECENT_DAYS, PARTS,
} from "../src/recommend/session.js";
import { normalizeManualProfile, manualSkill } from "../src/recommend/manualProfile.js";
import { encodeCollectionDb, decodeCollectionDb, COLLECTION_DB_VERSION } from "../src/recommend/collectionDb.js";
import { numericToLabel } from "../src/core/labels.js";
import { createSessionLibrary } from "./sessionLibrary.js";
import { createJsonStore } from "./jsonStore.js";
import { collectionsDir } from "./recFavIpc.js";
import { fetchSongsFolder } from "./tosuClient.js";
import { createRateMap } from "./rateCreate.js";
import { createMarathon } from "./marathonCreate.js";
import { rateForDan } from "../src/rate/rateForDan.js";
import { t } from "../src/i18n/i18n.js";

export const MAX_SAVED = 30;
const MAX_NAME = 64;
const DAY_MS = 86_400_000;
const MARATHON_GAP_MS = 10_000;
const MAX_COPY = 100_000;
const RATE_FIT = { tolerance: 0.1, maxTries: 5 };
const fail = (error) => ({ ok: false, message: String(error?.message || error || t("app.rec.unknownError")) });
const round2 = (x) => Math.round(x * 100) / 100;
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export const sessionLabel = (item) => `${item.artist} - ${item.title} [${item.version}]`;

// What the window typed → a session's name: no control characters, trimmed, at most 64; empty → fallback.
export function cleanSessionName(name, fallback) {
    const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME).trim() : "";
    return clean || fallback;
}

// sessions.json → a list of saved sessions with only what a session is made of.
export function normalizeSaved(x) {
    if (!Array.isArray(x)) return [];
    return x.filter((s) => isObject(s) && typeof s.id === "string" && typeof s.name === "string" && Array.isArray(s.items)
        && isObject(s.request) && s.items.every((i) => isObject(i) && typeof i.mapId === "string" && PARTS.includes(i.part)))
        .slice(0, MAX_SAVED);
}

// A collection named `name` with these MD5s put into collection.db's collections (one of that name replaced).
export function withCollection(collections, name, hashes) {
    return [...(collections ?? []).filter((c) => c?.name !== name), { name, hashes }];
}

// The ids of the library maps played within `days`: { beatmaps: Map beatmapId → { playedAt } (mania-tracker and
// Interlude by its osu! origin), hashes: Map Interlude hash → { at } }.
export function recentIds(maps, { beatmaps = new Map(), hashes = new Map() }, nowMs, days = RECENT_DAYS) {
    const since = nowMs - days * DAY_MS;
    const out = new Set();
    for (const m of maps) {
        const byId = m.beatmapId ? beatmaps.get(m.beatmapId) : null;
        const byHash = m.sources?.interlude?.hash ? hashes.get(m.sources.interlude.hash) : null;
        if ((Number(byId?.playedAt) || 0) >= since || (Number(byHash?.at) || 0) >= since) out.add(m.id);
    }
    return out;
}

// library: createSessionLibrary(); profile: the shared profile (current()); played() → { known, beatmaps, hashes };
// analyze(osuText, rate) → result (the background line); makeRateCopy({ beatmapPath, rate }) → { osuPath } (the rate
// tab's copy, next to the map); copyOut(hash) → { path } of an Interlude chart in Documents\<app>\interlude;
// makeMarathon({ entries, title, plan }) → { file, totalMs }; saved: a JSON store of the saved sessions.
export function createSessionHandlers({
    library, profile, played = async () => ({ known: false }), localSkill = async () => null, analyze, findRate = rateForDan, makeRateCopy = null,
    copyOut = null, makeMarathon = null, saved, docsDir, fs = nodeFs, log = () => {}, progress = () => {},
    now = Date.now, seed = () => Math.floor(Math.random() * 2 ** 31),
}) {
    let current = null; // { request, skill, manualDan, session, shown: Map index → [mapIds], name }
    let busy = false;

    // The skill a session is built for: the local profile's (when asked for), the hand-set profile sent along, else
    // the mania-tracker one main holds.
    async function skillFor(req) {
        if (req?.local) {
            const skill = await Promise.resolve().then(localSkill).catch(() => null);
            return skill?.ready ? { skill } : t("profile.local.notEnough");
        }
        if (req?.manualProfile !== undefined && req?.manualProfile !== null) {
            const skill = manualSkill(normalizeManualProfile(req.manualProfile));
            return skill ? { skill } : t("recommend.err.badManualProfile");
        }
        const p = profile?.current?.();
        return p?.ok && p.skill ? { skill: p.skill } : t("session.err.noProfile");
    }

    async function recentSet(maps, request) {
        if (!request.avoidRecent) return new Set();
        try {
            return recentIds(maps, await played(), now());
        } catch (error) {
            log(`session played failed: ${error?.message}`);
            return new Set();
        }
    }

    // The rate of an item checked by the analysis (rateForDan, from 1.0 towards its slot's dan); a map that does
    // not answer keeps the estimate.
    async function fitRate(item) {
        if (item.rate === 1 && !item.estimated) return item;
        try {
            const osuText = await library.text(item.mapId);
            const out = await findRate({
                analyze: (text, rate) => analyze(text, rate), osuText, target: item.slot.dan,
                min: RATE.min, max: RATE.max, step: RATE.step, ...RATE_FIT,
            });
            if (!out?.ok) return item;
            const baseSec = item.durationSec * item.rate;
            return {
                ...item, rate: out.rate, dan: out.numeric, danLabel: out.label || numericToLabel(out.numeric).text,
                estimated: false, durationSec: round2(baseSec / out.rate),
            };
        } catch (error) {
            log(`session rate fit ${item.mapId} failed: ${error?.message}`);
            return item;
        }
    }

    async function fitRates(items, what) {
        const todo = items.map((x, i) => (x.estimated ? i : -1)).filter((i) => i >= 0);
        const out = [...items];
        for (const [k, i] of todo.entries()) {
            progress({ job: what, phase: "rates", i: k + 1, n: todo.length });
            out[i] = await fitRate(out[i]);
        }
        return out;
    }

    const view = () => ({
        name: current.name, request: current.request, items: current.session.items,
        totalSec: sessionSeconds(current.session.items), requestedSec: current.session.requestedSec,
        targets: current.session.targets, notes: current.session.notes,
    });

    // The library's state as a reason a session cannot be built yet.
    async function emptyReason() {
        const st = await library.status();
        if (st.phase === "listing" || st.phase === "analysing") {
            return t("session.err.stillAnalysing", { done: st.counts.analysed, total: st.counts.total });
        }
        if (!st.counts.total) return t("session.err.noMaps");
        return t("session.err.empty");
    }

    async function build(req) {
        if (busy) return { ok: false, message: t("session.err.busy") };
        const request = cleanSessionRequest(req);
        if (typeof request === "string") return { ok: false, message: request };
        const who = await skillFor(req);
        if (typeof who === "string") return { ok: false, message: who };
        busy = true;
        try {
            const maps = await library.maps();
            if (!maps.length) return { ok: false, reason: "empty", message: await emptyReason() };
            const recent = await recentSet(maps, request);
            const s = seed();
            let session;
            try {
                session = buildSession({ maps, request, skill: who.skill, recent, seed: s });
            } catch (error) {
                return fail(error);
            }
            if (!session.ok) {
                log(`session build ${request.patternIds.join("+")} ${request.goalId} ${request.minutes} min: ${session.reason} (${maps.length} maps)`);
                return { ok: false, reason: session.reason, message: session.message };
            }
            session.items = await fitRates(session.items, "build");
            current = { request, skill: who.skill, session, shown: new Map(), name: sessionName(request, new Date(now())) };
            log(`session build ${request.patternIds.join("+")} ${request.goalId} ${request.minutes} min${request.allowRates ? ", rates" : ""}${recent.size ? `, ${recent.size} recent left out` : ""} → ${session.items.length} maps, ${Math.round(sessionSeconds(session.items))} s of ${session.requestedSec}${session.notes.length ? ` (${session.notes.join(", ")})` : ""}`);
            return { ok: true, session: view() };
        } catch (error) {
            log(`session build failed: ${error?.message}`);
            return fail(error);
        } finally {
            busy = false;
        }
    }

    async function reroll(req) {
        const index = req?.index;
        if (!current) return { ok: false, message: t("session.err.noSession") };
        if (!Number.isInteger(index) || index < 0 || index >= current.session.items.length) return { ok: false, message: t("recommend.err.badSlot") };
        if (busy) return { ok: false, message: t("session.err.busy") };
        busy = true;
        try {
            const maps = await library.maps();
            const recent = await recentSet(maps, current.request);
            const shown = current.shown.get(index) ?? [];
            const item = rerollItem({ maps, session: current.session, index, request: current.request, recent, shown, seed: seed() });
            if (!item) return { ok: false, none: true, message: t("session.err.noOther") };
            const fitted = (await fitRates([item], "reroll"))[0];
            current.shown.set(index, [...shown, current.session.items[index].mapId]);
            current.session.items = current.session.items.map((x, i) => (i === index ? fitted : x));
            return { ok: true, session: view() };
        } catch (error) {
            return fail(error);
        } finally {
            busy = false;
        }
    }

    // ---- saved sessions ----

    async function saveCurrent(req) {
        if (!current) return { ok: false, message: t("session.err.noSession") };
        const name = cleanSessionName(req?.name, current.name);
        current.name = name;
        const entry = { id: `s${now().toString(36)}`, name, at: now(), ...view() };
        try {
            const list = await saved.update((items) => [entry, ...normalizeSaved(items).filter((s) => s.name !== name)].slice(0, MAX_SAVED));
            return { ok: true, id: entry.id, items: list };
        } catch (error) {
            return fail(error);
        }
    }

    async function list() {
        try {
            return { ok: true, items: normalizeSaved(await saved.get()) };
        } catch (error) {
            return fail(error);
        }
    }

    async function open(req) {
        const entry = normalizeSaved(await saved.get().catch(() => [])).find((s) => s.id === req?.id);
        if (!entry) return { ok: false, message: t("session.err.noSaved") };
        const request = cleanSessionRequest(entry.request);
        if (typeof request === "string") return { ok: false, message: request };
        current = {
            request, skill: null, shown: new Map(), name: entry.name,
            session: { items: entry.items, requestedSec: entry.requestedSec ?? request.minutes * 60, targets: entry.targets ?? [], notes: entry.notes ?? [] },
        };
        return { ok: true, session: view() };
    }

    async function remove(req) {
        try {
            const items = await saved.update((all) => normalizeSaved(all).filter((s) => s.id !== req?.id));
            return { ok: true, items };
        } catch (error) {
            return fail(error);
        }
    }

    // ---- export ----

    const md5Of = (bytes) => createHash("md5").update(bytes).digest("hex");

    // The session as an osu! stable collection. → { ok, file, name, count, made, skipped, backup }
    async function exportCollection(req) {
        if (!current) return { ok: false, message: t("session.err.noSession") };
        if (busy) return { ok: false, message: t("session.err.busy") };
        busy = true;
        try {
            const name = cleanSessionName(req?.name, current.name);
            const hashes = [];
            const skipped = [];
            let made = 0;
            const items = current.session.items;
            for (const [i, item] of items.entries()) {
                const stable = item.sources?.stable;
                if (!stable?.path) {
                    skipped.push(sessionLabel(item));
                    continue;
                }
                if (Math.abs(item.rate - 1) < 1e-9) {
                    hashes.push(stable.md5);
                    continue;
                }
                if (!makeRateCopy) {
                    skipped.push(sessionLabel(item));
                    continue;
                }
                progress({ job: "collection", phase: "copy", i: i + 1, n: items.length });
                try {
                    const out = await makeRateCopy({ beatmapPath: stable.path, rate: item.rate });
                    hashes.push(md5Of(await fs.readFile(out.osuPath)));
                    made += 1;
                } catch (error) {
                    log(`session collection: rate copy of ${stable.path} failed: ${error?.message}`);
                    skipped.push(sessionLabel(item));
                }
            }
            if (!hashes.length) return { ok: false, skipped, message: t("session.err.noStable") };
            const dir = collectionsDir(docsDir());
            const file = path.join(dir, "collection.db");
            await fs.mkdir(dir, { recursive: true });
            let collections = [];
            let backup = null;
            const before = await fs.readFile(file).catch(() => null);
            if (before) {
                try {
                    collections = decodeCollectionDb(before).collections;
                } catch {
                    collections = []; // a file this app cannot read is kept as the backup and not merged
                }
                backup = `${file}.bak`;
                await fs.writeFile(backup, before);
            }
            const unique = [...new Set(hashes)];
            await fs.writeFile(`${file}.tmp`, encodeCollectionDb({ version: COLLECTION_DB_VERSION, collections: withCollection(collections, name, unique) }));
            await fs.rename(`${file}.tmp`, file);
            log(`session collection "${name}" ${unique.length} maps (${made} rate copies), ${skipped.length} skipped → ${file}${backup ? `, backup ${backup}` : ""}`);
            return { ok: true, file, name, count: unique.length, made, skipped, backup };
        } catch (error) {
            log(`session collection failed: ${error?.message}`);
            return fail(error);
        } finally {
            busy = false;
        }
    }

    // The session as one marathon .osz in Documents\<app>\карты. → { ok, file, totalMs, skipped }
    async function exportMarathon(req) {
        if (!current) return { ok: false, message: t("session.err.noSession") };
        if (!makeMarathon) return { ok: false, message: t("session.err.noMarathon") };
        if (busy) return { ok: false, message: t("session.err.busy") };
        busy = true;
        try {
            const entries = [];
            const plan = [];
            const skipped = [];
            for (const item of current.session.items) {
                let file = item.sources?.stable?.path ?? null;
                if (!file && item.sources?.interlude?.hash && copyOut) {
                    try {
                        file = (await copyOut(item.sources.interlude.hash)).path;
                    } catch (error) {
                        log(`session marathon: ${item.sources.interlude.hash} not copied out: ${error?.message}`);
                    }
                }
                if (!file) {
                    skipped.push(sessionLabel(item));
                    continue;
                }
                entries.push({ path: file, rate: item.rate });
                plan.push(item.slot.dan);
            }
            if (!entries.length) return { ok: false, message: t("app.marathon.noMaps") };
            progress({ job: "marathon", phase: "build", i: 0, n: entries.length });
            const title = cleanSessionName(req?.name, current.name).slice(0, 80);
            const out = await makeMarathon({ entries, title, plan });
            log(`session marathon "${title}" ${entries.length} maps → ${out.file}`);
            return { ok: true, file: out.file, totalMs: out.totalMs, skipped };
        } catch (error) {
            log(`session marathon failed: ${error?.message}`);
            return fail(error);
        } finally {
            busy = false;
        }
    }

    async function libraryStatus() {
        try {
            const st = await library.status();
            let playedKnown = false;
            try {
                playedKnown = Boolean((await played({ peek: true }))?.known);
            } catch {
                playedKnown = false;
            }
            return { ok: true, ...st, playedKnown };
        } catch (error) {
            return fail(error);
        }
    }

    return {
        libraryStatus,
        scan: () => { void library.scan(); return libraryStatus(); },
        pause: () => { library.pause(); return libraryStatus(); },
        resume: () => { void library.resume(); return libraryStatus(); },
        build, reroll, save: saveCurrent, list, open, remove, exportCollection, exportMarathon,
        current: () => current,
    };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const appVersion = () => {
    try {
        return JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
    } catch {
        return "0";
    }
};

// The session page's channels on the app's shared services (main.js deps).
export function registerSessionIpc({ ipcMain, tosu, analysis, interlude, profile, recommender, ffmpegPath, renderPng, paths, dialog, window, send, log, localProfile = null }) {
    const local = process.env.LOCALAPPDATA;
    // made on first use: registering touches no folder
    let made = null;
    const lib = () => (made ??= createSessionLibrary({
        songsDir: () => fetchSongsFolder(tosu.port),
        defaultSongs: local ? path.join(local, "osu!", "Songs") : null,
        interlude,
        // the background line: the selected map's card never waits for the library
        analyze: (osuText, rate) => analysis.analyzeQueued(osuText, rate),
        file: path.join(paths.userData, "session-library.json"),
        analyzer: appVersion(),
        log,
        onChange: (status) => send("session-library", status),
    }));
    const library = {
        status: () => lib().status(), scan: () => lib().scan(), pause: () => lib().pause(), resume: () => lib().resume(),
        pickSongs: (dir) => lib().pickSongs(dir), maps: () => lib().maps(), text: (id) => lib().text(id),
    };
    let savedStore = null;
    const savedFile = () => (savedStore ??= createJsonStore({ file: path.join(paths.userData, "sessions.json"), normalize: normalizeSaved, fallback: [] }));
    const saved = { get: () => savedFile().get(), update: (fn) => savedFile().update(fn) };
    const played = async ({ peek = false } = {}) => {
        const linked = Boolean((await interlude?.status?.().catch(() => null))?.linked);
        const own = (await localProfile?.playedBeatmaps?.().catch(() => null))?.size > 0;
        const known = Boolean(recommender?.currentPlayer?.()) || linked || own;
        if (peek) return { known };
        const beatmaps = (await recommender.playedMaps().catch(() => ({ played: new Map() }))).played ?? new Map();
        const hashes = linked ? await interlude.library.played().catch(() => new Map()) : new Map();
        return { known, beatmaps, hashes };
    };
    const h = createSessionHandlers({
        library, profile, played,
        localSkill: () => localProfile?.skill() ?? null,
        analyze: (osuText, rate) => analysis.analyzeQueued(osuText, rate),
        makeRateCopy: async ({ beatmapPath, rate }) => createRateMap({ ffmpeg: await ffmpegPath(), beatmapPath, rate, pitch: false }),
        copyOut: (hash) => interlude.copyOut(hash),
        makeMarathon: async ({ entries, title, plan }) => createMarathon({
            ffmpeg: await ffmpegPath(), entries, gapMs: MARATHON_GAP_MS, pitch: false, title, outDir: paths.mapsDir, renderPng, plan,
            danFor: async (osuText, rate) => {
                const r = await analysis.analyze(osuText, rate);
                return r.kind === "ok" ? { label: r.label, numeric: r.numeric } : { label: "", numeric: null };
            },
        }),
        saved,
        docsDir: () => paths.docsDir,
        log,
        progress: (event) => send("session-progress", event),
    });
    ipcMain.handle("session-library-status", () => h.libraryStatus());
    ipcMain.handle("session-library-scan", () => h.scan());
    ipcMain.handle("session-library-pause", () => h.pause());
    ipcMain.handle("session-library-resume", () => h.resume());
    ipcMain.handle("session-library-pick", async () => {
        const picked = await dialog.showOpenDialog(window() ?? undefined, { title: t("session.pickSongsTitle"), properties: ["openDirectory"] });
        if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, cancelled: true };
        void library.pickSongs(picked.filePaths[0]);
        return h.libraryStatus();
    });
    ipcMain.handle("session-build", (_e, req) => h.build(req));
    ipcMain.handle("session-reroll", (_e, req) => h.reroll(req));
    ipcMain.handle("session-save", (_e, req) => h.save(req));
    ipcMain.handle("session-list", () => h.list());
    ipcMain.handle("session-open", (_e, req) => h.open(req));
    ipcMain.handle("session-remove", (_e, req) => h.remove(req));
    ipcMain.handle("session-export-collection", (_e, req) => h.exportCollection(req));
    ipcMain.handle("session-export-marathon", (_e, req) => h.exportMarathon(req));
    // "copy list": the text through Electron's clipboard (the window's own clipboard API wants focus)
    ipcMain.handle("session-copy", async (_e, req) => {
        const text = typeof req?.text === "string" ? req.text.slice(0, MAX_COPY) : "";
        if (!text) return { ok: false };
        const { clipboard } = await import("electron");
        clipboard.writeText(text);
        return { ok: true };
    });
    return h;
}
