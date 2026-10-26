// Main-process side of Interlude (app/interludeClient.js): the folder setting, the library picker that puts a chart
// of Interlude's library on the analysis card, "send to Interlude" for the maps the app makes, and playlists for
// Interlude's collections.json. Every handler answers instead of throwing; the window is told of every change on
// "interlude-state". Following the running game (app/interludeReader.js, app/interludeLive.js) is set here too:
// "interlude-live-get" / "interlude-live-set" ({ live, allowDownload }); its state goes to the window on "interlude-live".
import { readFile } from "node:fs/promises";
import path from "node:path";
import { osuMd5 } from "../src/interlude/chart.js";
import { cleanName } from "../src/interlude/collections.js";
import { positiveId } from "./validate.js";
import { t } from "../src/i18n/i18n.js";

const MAX_ITEMS = 500;
const fail = (error) => ({ ok: false, message: String(error?.message ?? error) });
const inside = (dir, file) => Boolean(dir) && path.resolve(file).startsWith(path.resolve(dir) + path.sep);

// A file the window may hand to "send": an .osz the app made (in its Documents folder) or an .osu anywhere (only read).
export function sendable(file, docsDir) {
    if (typeof file !== "string" || !path.isAbsolute(file)) return false;
    const ext = path.extname(file).toLowerCase();
    return ext === ".osu" || (ext === ".osz" && inside(docsDir, file));
}

// One item of a list to export → { hash, md5, beatmapId, path, rate, label } with only valid parts kept (hash: a chart of
// Interlude's library itself, as the session page knows it).
export function exportItem(item) {
    if (!item || typeof item !== "object") return null;
    const hash = typeof item.hash === "string" && /^[0-9A-F]{64}$/.test(item.hash) ? item.hash : null;
    const md5 = typeof item.md5 === "string" && /^[0-9a-f]{32}$/i.test(item.md5) ? item.md5.toLowerCase() : null;
    const beatmapId = positiveId(item.beatmapId);
    const file = typeof item.path === "string" && path.isAbsolute(item.path) && item.path.toLowerCase().endsWith(".osu") ? item.path : null;
    const rate = Number.isFinite(item.rate) ? item.rate : 1;
    const label = typeof item.label === "string" ? item.label.slice(0, 200) : String(beatmapId ?? (file ? path.basename(file) : "?"));
    return hash || md5 || beatmapId || file ? { hash, md5, beatmapId, path: file, rate, label } : null;
}

// interlude: createInterludeClient(); card: { showExternal } of the selection controller; dialog: Electron's;
// live: () → { state, text } of the live reader (app/interludeLive.js), or null when there is none.
export function createInterludeHandlers({
    interlude, card, dialog = null, window = () => null, paths, log = () => {}, readText = (f) => readFile(f), live = () => null,
}) {
    // what the window shows of following Interlude: the settings, the reader's state and it in words
    async function liveInfo() {
        const settings = await interlude.liveSettings();
        const now = live();
        return { ok: true, settings, state: now?.state ?? { status: "off" }, text: now?.text ?? "" };
    }
    async function select(req) {
        const hash = typeof req?.hash === "string" && /^[0-9A-F]{64}$/.test(req.hash) ? req.hash : null;
        if (!hash) return { ok: false, message: t("app.interlude.noChart") };
        try {
            const sel = await interlude.select(hash);
            card?.showExternal({ id: sel.hash, text: sel.text, rate: 1, onEnd: () => interlude.clearSelection() });
            return { ok: true, label: sel.label, original: sel.original, audio: Boolean(sel.audioPath) };
        } catch (error) {
            log(`interlude: select failed: ${error?.message}`);
            return fail(error);
        }
    }

    async function exportList(req) {
        try {
            const items = (Array.isArray(req?.items) ? req.items.slice(0, MAX_ITEMS) : []).map(exportItem).filter(Boolean);
            if (!items.length) return { ok: false, message: t("app.interlude.nothingToExport") };
            const entries = [];
            const missing = [];
            for (const item of items) {
                if (item.hash && await interlude.library.meta(item.hash)) {
                    entries.push({ hash: item.hash, rate: item.rate });
                    continue;
                }
                let md5 = item.md5;
                let osuText = null;
                if (item.path) {
                    try {
                        const bytes = await readText(item.path);
                        md5 = osuMd5(bytes);
                        osuText = bytes.toString("utf8");
                    } catch {
                        // a file gone since: looked up by what else is known
                    }
                }
                const hash = await interlude.library.find({ md5, beatmapId: item.beatmapId, osuText });
                if (hash) entries.push({ hash, rate: item.rate });
                else missing.push(item.label);
            }
            if (!entries.length) return { ok: false, missing, message: t("app.interlude.noneInLibrary") };
            const out = await interlude.writeCollection({ kind: req?.kind === "folder" ? "folder" : "playlist", name: cleanName(req?.name), entries });
            return { ...out, missing };
        } catch (error) {
            log(`interlude: export failed: ${error?.message}`);
            return fail(error);
        }
    }

    return {
        status: () => interlude.status().catch(fail),
        async pickFolder() {
            if (!dialog) return { ok: false, message: t("app.interlude.notFolder") };
            const picked = await dialog.showOpenDialog(window() ?? undefined, { title: t("app.interlude.pickTitle"), properties: ["openDirectory"] });
            if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, cancelled: true };
            return interlude.link(picked.filePaths[0]).catch(fail);
        },
        detect: () => interlude.detect().catch(fail),
        unlink: () => interlude.unlink().then(() => ({ ok: true }), fail),
        async search(req) {
            try {
                const query = typeof req?.query === "string" ? req.query.slice(0, 200) : "";
                return { ok: true, ...(await interlude.library.search(query, { keys: 4 })) };
            } catch (error) {
                return fail(error);
            }
        },
        select,
        async send(req) {
            const files = (Array.isArray(req?.files) ? req.files : [req?.file]).filter((f) => sendable(f, paths.docsDir));
            if (!files.length) return { ok: false, message: t("app.interlude.badFile") };
            return interlude.send(files);
        },
        exportList,
        liveInfo: () => liveInfo().catch(fail),
        async setLive(req) {
            try {
                const patch = {};
                if (typeof req?.live === "boolean") patch.live = req.live;
                if (typeof req?.allowDownload === "boolean") patch.allowDownload = req.allowDownload;
                await interlude.setLiveSettings(patch);
                return liveInfo();
            } catch (error) {
                return fail(error);
            }
        },
    };
}

export function registerInterludeIpc({ ipcMain, interlude, card, dialog, window, paths, hooks, send, log, interludeLive }) {
    const h = createInterludeHandlers({ interlude, card, dialog, window, paths, log, live: () => interludeLive?.() ?? null });
    // the page reloaded (a language switch): what is known of Interlude again
    hooks?.on("window-load", () => {
        void h.status().then((s) => send("interlude-state", s), () => {});
        void h.liveInfo().then((s) => send("interlude-live", s), () => {});
    });
    ipcMain.handle("interlude-live-get", () => h.liveInfo());
    ipcMain.handle("interlude-live-set", (_e, req) => h.setLive(req));

    ipcMain.handle("interlude-status", () => h.status());
    ipcMain.handle("interlude-pick-folder", () => h.pickFolder());
    ipcMain.handle("interlude-detect", () => h.detect());
    ipcMain.handle("interlude-unlink", () => h.unlink());
    ipcMain.handle("interlude-search", (_e, req) => h.search(req));
    ipcMain.handle("interlude-select", (_e, req) => h.select(req));
    ipcMain.handle("interlude-send", (_e, req) => h.send(req));
    ipcMain.handle("interlude-export", (_e, req) => h.exportList(req));
    return h;
}
