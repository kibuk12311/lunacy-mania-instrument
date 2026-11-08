// Main-process side of Etterna (app/etternaClient.js): the folder and its switch, the list of its charts with Etterna's
// own MSD at a rate, their dans on the background line, and a picked chart on the analysis card. Every handler answers
// instead of throwing; the window is told of every change on "etterna-state".
import { msdAt } from "./etternaLibrary.js";
import { t } from "../src/i18n/i18n.js";

const MAX_DANS = 50; // ids one "etterna-dans" call works out
const fail = (error) => ({ ok: false, message: String(error?.message ?? error) });
const rateOf = (rate) => (typeof rate === "number" && Number.isFinite(rate) && rate >= 0.5 && rate <= 3 ? rate : null);
const badRate = () => ({ ok: false, message: "rate must be a number from 0.5 to 3.0" });

// why the analyzer gave no dan, in the Rate tab's words (app/renderer/rateBatch.js)
function whyNot(r) {
    if (r?.kind === "not-rice") return r.reason === "ln" ? t("rate.batch.row.ln") : t("rate.batch.row.notRice");
    if (r?.kind === "too-short") return t("rate.batch.row.tooShort");
    return String(r?.message ?? t("rate.batch.row.error"));
}

// a row as the window gets it: without the whole MSD table, with the Overall MSD at the rate
const rowOut = ({ msd, file, fileKey, index, ...row }, rate) => ({ ...row, msdAtRate: msdAt(msd, rate) });

// etterna: createEtternaClient(); analysis: the shared analysis service (analyzeQueued: the background line);
// card: { showExternal } of the selection controller; dialog: Electron's
export function createEtternaHandlers({ etterna, analysis, card, dialog = null, window = () => null, log = () => {} }) {
    // the window numbers its lists; the dans of an older one still waiting on the background line are dropped
    let latestBatch = 0;
    return {
        status: () => etterna.status().catch(fail),
        async pickFolder() {
            if (!dialog) return { ok: false, message: t("app.etterna.notFolder") };
            const picked = await dialog.showOpenDialog(window() ?? undefined, { title: t("app.etterna.pickTitle"), properties: ["openDirectory"] });
            if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, cancelled: true };
            return etterna.link(picked.filePaths[0]).catch(fail);
        },
        detect: () => etterna.detect().catch(fail),
        unlink: () => etterna.unlink().then((s) => ({ ok: true, ...s }), fail),
        async setEnabled(req) {
            if (typeof req?.on !== "boolean") return { ok: false, message: "on must be true or false" };
            return etterna.setEnabled(req.on).then((s) => ({ ok: true, ...s }), fail);
        },
        async search(req) {
            try {
                const rate = rateOf(req?.rate) ?? 1;
                const query = typeof req?.query === "string" ? req.query.slice(0, 200) : "";
                return { ok: true, rows: etterna.search(query, { limit: 200 }).map((r) => rowOut(r, rate)) };
            } catch (error) {
                return fail(error);
            }
        },
        // → { ok, dans: { id: { label, numeric } | { label: "", numeric: null, why } } } for the rows the window shows
        async dans(req) {
            const rate = rateOf(req?.rate);
            if (rate === null) return badRate();
            if (!Array.isArray(req?.ids)) return { ok: false, message: "ids must be a list" };
            const ids = [...new Set(req.ids.filter((id) => typeof id === "string"))].slice(0, MAX_DANS);
            const batch = Number.isSafeInteger(req.batch) ? req.batch : null;
            if (batch !== null) latestBatch = Math.max(latestBatch, batch);
            const isCancelled = () => batch !== null && batch < latestBatch;
            const dans = {};
            await Promise.all(ids.map(async (id) => {
                try {
                    const row = etterna.row(id);
                    if (!row) return void (dans[id] = { label: "", numeric: null, why: t("app.etterna.noChart") });
                    if (row.skip) return void (dans[id] = { label: "", numeric: null, why: row.skip });
                    const chart = await etterna.chart(id);
                    if (!chart?.osu) return void (dans[id] = { label: "", numeric: null, why: t("app.etterna.noChart") });
                    const r = await analysis.analyzeQueued(chart.osu, rate, { isCancelled });
                    dans[id] = r?.kind === "ok" ? { label: r.label, numeric: r.numeric } : { label: "", numeric: null, why: whyNot(r) };
                } catch (error) {
                    dans[id] = { label: "", numeric: null, why: String(error?.message ?? error) };
                }
            }));
            return { ok: true, dans };
        },
        async select(req) {
            const rate = rateOf(req?.rate);
            if (rate === null) return badRate();
            if (typeof req?.id !== "string") return { ok: false, message: t("app.etterna.noChart") };
            try {
                const row = etterna.row(req.id);
                if (!row) return { ok: false, message: t("app.etterna.noChart") };
                if (row.skip) return { ok: false, message: t("app.etterna.notRated", { reason: row.skip }) };
                const chart = await etterna.chart(req.id);
                if (!chart?.osu) return { ok: false, message: t("app.etterna.noChart") };
                card?.showExternal({ id: `etterna:${req.id}`, text: chart.osu, rate });
                log(`etterna: on the card ${chart.label} at ${rate}x`);
                return { ok: true, label: chart.label };
            } catch (error) {
                return fail(error);
            }
        },
    };
}

export function registerEtternaIpc({ ipcMain, etterna, analysis, card, dialog, window, hooks, send, log }) {
    const h = createEtternaHandlers({ etterna, analysis, card, dialog, window, log });
    // the page reloaded (a language switch): what is known of Etterna again
    hooks?.on("window-load", () => void h.status().then((s) => send("etterna-state", s), () => {}));
    ipcMain.handle("etterna-status", () => h.status());
    ipcMain.handle("etterna-pick-folder", () => h.pickFolder());
    ipcMain.handle("etterna-detect", () => h.detect());
    ipcMain.handle("etterna-unlink", () => h.unlink());
    ipcMain.handle("etterna-set-enabled", (_e, req) => h.setEnabled(req));
    ipcMain.handle("etterna-search", (_e, req) => h.search(req));
    ipcMain.handle("etterna-dans", (_e, req) => h.dans(req));
    ipcMain.handle("etterna-select", (_e, req) => h.select(req));
    return h;
}
