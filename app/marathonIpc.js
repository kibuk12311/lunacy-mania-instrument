// Main-process side of the "Марафон" tab: maps added from osu! or from .osu files, each with its rate;
// one .osz with a dan-style background; the auto-marathon that fills the list. Every handler answers instead of throwing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mapInfo } from "./rateCreate.js";
import { copyLazerMap, lazerDirOf } from "./lazerMaps.js";
import { createMarathon } from "./marathonCreate.js";
import { createMarathonAutoHandlers } from "./marathonAutoIpc.js";
import { createSongsIndex } from "./songsIndex.js";
import { fetchSongsFolder } from "./tosuClient.js";
import { validRate, validDiff } from "./validate.js";
import { cutRange } from "../src/rate/marathon.js";
import { rateForDan } from "../src/rate/rateForDan.js";
import { createAutoMarathon } from "../src/rate/autoMarathon.js";
import { extractChart } from "../src/rate/oszRead.js";
import { t } from "../src/i18n/i18n.js";

const MAX_PLAN = 64;

// The template's dan per map for the background's curve: numbers only, or no plan at all.
function cleanPlan(plan) {
    if (!Array.isArray(plan) || !plan.length || plan.length > MAX_PLAN) return null;
    return plan.every((d) => typeof d === "number" && Number.isFinite(d) && d > 0 && d < 25) ? plan : null;
}

export function registerMarathonIpc({ ipcMain, tosu, analysis, ffmpegPath, renderPng, paths, log, send, trackerApi, recommender, downloader, profile }) {
    const describe = async (beatmapPath) => {
        const text = await readFile(beatmapPath, "utf8");
        const info = mapInfo(text);
        const ok4k = /^Mode:\s*3/m.test(text) && Number(/^CircleSize:\s*([\d.]+)/m.exec(text)?.[1]) === 4;
        return { ok: true, path: beatmapPath, name: `${info.artist} - ${info.title} [${info.version}]`, bpm: info.bpm, ok4k };
    };
    // osu! lazer: the map is copied out of its file store (read only) into Documents\<app>\lazer under its own
    // names, so the marathon reads its chart and audio from a folder like stable's (lazerMaps.js)
    const currentPath = async () => {
        const source = tosu.beatmap ? await tosu.beatmap() : { client: "stable", path: await tosu.beatmapPath() };
        if (source.client !== "lazer") return source.path;
        const local = await copyLazerMap({ source, osuText: await readFile(source.path, "utf8"), root: lazerDirOf(paths.docsDir) });
        log(`marathon: lazer map copied to ${local.path}`);
        return local.path;
    };
    ipcMain.handle("marathon-add-current", async () => {
        try {
            return await describe(await currentPath());
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });
    ipcMain.handle("marathon-add-file", async (_e, file) => {
        if (!String(file).toLowerCase().endsWith(".osu")) return { ok: false, message: t("app.marathon.needOsu") };
        try {
            return await describe(file);
        } catch (error) {
            return { ok: false, message: error.message };
        }
    });
    // our dan of a chart at a rate: { label, numeric }, both empty when there is none
    const danFor = async (osuText, rate) => {
        const r = await analysis.analyze(osuText, rate);
        return r.kind === "ok" ? { label: r.label, numeric: r.numeric } : { label: "", numeric: null };
    };
    ipcMain.handle("marathon-dan", async (_e, req) => {
        const { file, rate } = req ?? {};
        const none = { label: "", numeric: null, cutMs: null };
        if (!validRate(Number(rate)) || typeof file !== "string") return none;
        let text;
        try {
            text = await readFile(file, "utf8");
        } catch {
            return none;
        }
        const cutMs = cutRange(text)?.cutMs ?? null;
        try {
            return { ...(await danFor(text, Number(rate))), cutMs };
        } catch {
            return { ...none, cutMs };
        }
    });
    ipcMain.handle("marathon-create", async (_e, req) => {
        const entries = (req?.entries ?? []).map((e) => ({ path: String(e.path), rate: Number(e.rate) }));
        const gapMs = Math.round(Number(req?.gapSec) * 1000);
        const od = req?.od === "" || req?.od === null ? null : Number(req.od);
        const hp = req?.hp === "" || req?.hp === null ? null : Number(req.hp);
        if (!entries.length) return { ok: false, message: t("app.marathon.noMaps") };
        if (entries.some((e) => !validRate(e.rate))) return { ok: false, message: t("app.marathon.badRate") };
        if (!(gapMs >= 0 && gapMs <= 120000)) return { ok: false, message: t("app.marathon.badGap") };
        if (!validDiff(od) || !validDiff(hp)) return { ok: false, message: t("app.marathon.badDiff") };
        try {
            log(`marathon ${req.title}: ${entries.length} maps, gap ${gapMs} ms`);
            const out = await createMarathon({
                ffmpeg: await ffmpegPath(), entries, gapMs, pitch: Boolean(req.pitch),
                title: String(req.title || t("app.marathon.defaultTitle")).slice(0, 80), od, hp, outDir: paths.mapsDir, danFor, renderPng,
                plan: cleanPlan(req.plan),
            });
            log(`marathon saved ${out.file}`);
            return { ok: true, file: out.file, totalMs: out.totalMs };
        } catch (error) {
            log(`marathon failed: ${error.message}`);
            return { ok: false, message: error.message };
        }
    });

    // Auto-marathon. The Songs folder is only read; a downloaded set's chart, audio and background are copied
    // into скачанные/марафон/<set id>/, so every path the list gets back was made here.
    const songs = createSongsIndex({ songsDir: () => fetchSongsFolder(tosu.port) });
    const auto = createAutoMarathon({
        searchMaps: (params) => trackerApi.searchMaps(params),
        played: async () => (await recommender.playedMaps()).played,
        findLocal: (setId, beatmapId) => songs.find(setId, beatmapId),
        download: (request) => downloader.download(request),
        readFile: (file) => readFile(file),
        extract: (buffer, beatmapId, setId, options) => extractChart(buffer, beatmapId, path.join(paths.downloadsDir, "марафон", String(setId)), options),
        // the background line: a map picked in osu! meanwhile still gets its card first
        analyze: (osuText, rate) => analysis.analyzeQueued(osuText, rate),
        rateForDan,
        progress: (event) => send("marathon-auto-progress", event),
        log,
    });
    const autoHandlers = createMarathonAutoHandlers({ auto, profile, log });
    ipcMain.handle("marathon-auto", (_e, req) => autoHandlers.start(req));
    ipcMain.handle("marathon-auto-cancel", () => autoHandlers.cancel());
}
