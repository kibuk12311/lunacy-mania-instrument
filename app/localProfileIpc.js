// The local profile's place in the app: made in main.js before the tabs (the picks' "hide played" and the profile
// consumers read it), its own tosu socket for the live recording, and its channels for the Profile tab.
// Read only outside userData: osu!'s scores.db and Songs, Interlude's folder (through app/interludeLibrary.js).
import path from "node:path";
import { readFile, writeFile, stat } from "node:fs/promises";
import { connectTosu } from "./tosuClient.js";
import { createLocalProfileStore } from "./localProfileStore.js";
import { createLocalProfileService } from "./localProfileService.js";
import { createSongsMd5Index } from "./osuSongsScan.js";
import { readRecent } from "../src/recommend/progress.js";
import { t } from "../src/i18n/i18n.js";

export const HISTORY_DAYS = [7, 30, 90, 365];
export const TRACKER_SITE = "https://mania-tracker.com/player/";
const fail = (error) => ({ ok: false, message: String(error?.message ?? error) });

// tosu's /json/v2 folders while it reads osu! stable: { game, songs } (nulls otherwise).
async function osuFoldersFrom(port, fetchImpl = globalThis.fetch) {
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { game: null, songs: null };
        const j = await res.json();
        if (String(j?.client ?? "stable").toLowerCase() === "lazer") return { game: null, songs: null };
        const clean = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/[\\/]+$/, "") : null);
        return { game: clean(j?.folders?.game), songs: clean(j?.folders?.songs) };
    } catch {
        return { game: null, songs: null };
    }
}

// The service over the app's own folders. interlude: app/interludeClient.js; analysis: app/analysisService.js.
export function createLocalProfile({ userData, analysis, interlude = null, port, env = process.env, log = () => {}, send = () => {}, tosuProfile = async () => null }) {
    const dir = path.join(userData, "local-profile");
    const store = createLocalProfileStore({ dir });
    return createLocalProfileService({
        store,
        // the background line: a play's map never holds up the selected map's card
        analyze: (text, rate) => analysis.analyzeQueued(text, rate),
        // the bytes: the md5 osu! names the map by is over them (a BOM included)
        fetchMapText: async () => {
            const res = await fetch(`http://127.0.0.1:${port}/files/beatmap/file`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`tosu ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        },
        readFile: (file) => readFile(file),
        exists: async (file) => Boolean((await stat(file).catch(() => null))?.isFile()),
        songsIndex: createSongsMd5Index({ indexFile: path.join(dir, "songs-md5.json") }),
        osuFolders: () => osuFoldersFrom(port),
        defaultOsuFolder: env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "osu!") : null,
        interlude: interlude ? {
            linked: async () => Boolean((await interlude.status())?.linked),
            scores: () => interlude.library.scores(),
            osuFor: (hash) => interlude.library.osuFor(hash),
        } : null,
        preferredPlayer: async () => (await tosuProfile())?.name ?? null,
        emit: send,
        log,
    });
}

// The mania-tracker player's recent plays for the Profile tab: readRecent plus the names.
export function recentPlays(json, limit = 15) {
    const raw = Array.isArray(json?.payload) ? json.payload : Array.isArray(json) ? json : [];
    const byId = new Map(raw.map((s) => [Number(s?.beatmap_id ?? s?.beatmap?.id), s]));
    return readRecent(json).sort((a, b) => b.at - a.at).slice(0, limit).map((r) => {
        const s = byId.get(r.beatmapId);
        return {
            ...r, artist: String(s?.beatmapset?.artist ?? ""), title: String(s?.beatmapset?.title ?? ""),
            version: String(s?.beatmap?.version ?? ""), rank: typeof s?.rank === "string" ? s.rank : null,
        };
    });
}

export function createLocalProfileHandlers({ localProfile, dialog = null, window = () => null, shell = null, recommender = null, trackerApi = null, log = () => {}, readText = (f) => readFile(f, "utf8"), writeText = (f, s) => writeFile(f, s, "utf8") }) {
    async function exportFile() {
        try {
            const day = new Date().toISOString().slice(0, 10);
            const r = await dialog?.showSaveDialog(window(), {
                title: t("profile.local.exportTitle"), defaultPath: `lunacy-mania-profile-${day}.json`, filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (!r || r.canceled || !r.filePath) return { ok: false, cancelled: true };
            const bundle = await localProfile.exportBundle();
            await writeText(r.filePath, JSON.stringify(bundle));
            log(`local profile: exported ${bundle.plays.length} plays`);
            return { ok: true, file: r.filePath, plays: bundle.plays.length };
        } catch (error) {
            return fail(error);
        }
    }

    async function importFile() {
        try {
            const r = await dialog?.showOpenDialog(window(), { title: t("profile.local.importTitle"), properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
            if (!r || r.canceled || !r.filePaths?.[0]) return { ok: false, cancelled: true };
            let bundle;
            try {
                bundle = JSON.parse(await readText(r.filePaths[0]));
            } catch {
                return { ok: false, message: t("profile.local.badBackup") };
            }
            const out = await localProfile.importBundle(bundle);
            if (!out.ok) return { ok: false, message: t("profile.local.badBackup") };
            log(`local profile: imported ${out.added} plays (${out.skipped} already there)`);
            return out;
        } catch (error) {
            return fail(error);
        }
    }

    async function pickOsuFolder() {
        try {
            const r = await dialog?.showOpenDialog(window(), { title: t("profile.local.pickOsu"), properties: ["openDirectory"] });
            if (!r || r.canceled || !r.filePaths?.[0]) return { ok: false, cancelled: true };
            return await localProfile.importStable({ folder: r.filePaths[0] });
        } catch (error) {
            return fail(error);
        }
    }

    async function trackerRecent() {
        const player = recommender?.currentPlayer?.();
        if (!player || !trackerApi) return { ok: false, message: t("core.rec.needProfile") };
        try {
            return { ok: true, plays: recentPlays(await trackerApi.recent(player.id)) };
        } catch (error) {
            return fail(error);
        }
    }

    async function openTracker() {
        const player = recommender?.currentPlayer?.();
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, message: t("core.rec.needProfile") };
        try {
            await shell?.openExternal(`${TRACKER_SITE}${id}`);
            return { ok: true };
        } catch (error) {
            return fail(error);
        }
    }

    const safe = (fn) => async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            log(`local profile: ${error?.message}`);
            return fail(error);
        }
    };

    return {
        status: safe(() => localProfile.status()),
        history: safe((req) => (HISTORY_DAYS.includes(req?.days) ? localProfile.history(req.days) : { ok: false, message: t("recommend.err.badDays") })),
        importHistory: safe((req) => (req?.source === "interlude" ? localProfile.importInterlude() : localProfile.importStable())),
        cancelImport: safe(() => localProfile.cancelImport()),
        setRecord: safe((req) => localProfile.setRecord(req?.on !== false)),
        reset: safe(() => localProfile.reset()),
        exportFile, importFile, pickOsuFolder, trackerRecent, openTracker,
    };
}

// main.js deps → the channels, and the live recording on its own tosu socket.
export function registerLocalProfileIpc({ ipcMain, dialog, window, shell, log, localProfile, recommender, trackerApi, tosu, hooks }) {
    if (!localProfile) return;
    const h = createLocalProfileHandlers({ localProfile, dialog, window, shell, recommender, trackerApi, log });
    ipcMain.handle("local-profile-status", () => h.status());
    ipcMain.handle("local-profile-history", (_e, req) => h.history(req));
    ipcMain.handle("local-profile-import", (_e, req) => h.importHistory(req));
    ipcMain.handle("local-profile-import-cancel", () => h.cancelImport());
    ipcMain.handle("local-profile-pick-osu", () => h.pickOsuFolder());
    ipcMain.handle("local-profile-record", (_e, req) => h.setRecord(req));
    ipcMain.handle("local-profile-export", () => h.exportFile());
    ipcMain.handle("local-profile-import-file", () => h.importFile());
    ipcMain.handle("local-profile-reset", () => h.reset());
    ipcMain.handle("tracker-recent", () => h.trackerRecent());
    ipcMain.handle("tracker-open-site", () => h.openTracker());
    // the recording starts with the window (registering does no I/O), once
    let socket = null;
    hooks?.on?.("window-load", () => {
        socket ??= connectTosu({
            port: tosu.port,
            parse: (json) => json,
            onFrame: (json) => localProfile.onTosuJson(json),
            onStatus: (status) => { if (status === "down") localProfile.onTosuDown(); },
        });
    });
}
