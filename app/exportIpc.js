// Main-process side of saving and remapping (mapgen v3, stream C).
// export-set takes store ids, never .osu text or a path to write: one .osz with every difficulty, its rate versions,
// the metadata, preview point and background (one id with no rates keeps today's "<title> [<version>].osz").
// song-tags reads the song's own title and artist. remap-load describes an .osu the window picked (a file, or the map
// selected in osu!) and remembers it; remap-create only works on remembered maps and writes the new difficulty next
// to the original, never over a file. Everything from the window is checked; every handler answers instead of throwing.
import { readFile, writeFile, stat, access } from "node:fs/promises";
import path from "node:path";
import { exportMapset, probeTags } from "./mapsetExport.js";
import { safeFileName } from "./mapExport.js";
import { validRate } from "./validate.js";
import { readMeta, setVersion } from "../src/gen/osuMeta.js";
import { RICE_MAX_LN_RATIO } from "../src/core/rice.js";
import { t } from "../src/i18n/i18n.js";

const MAX_IDS = 8;
const MAX_RATES = 3;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png"]);
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".flac", ".m4a", ".opus", ".aac"]);
const BACKGROUNDS = new Set(["none", "image", "danCourse"]);
const META_LIMITS = { title: 200, artist: 200, source: 200, creator: 100, tags: 1000 };
const MAX_DAN = 21;
// .osz entries osu! can play straight away; other songs (wav, flac) need ffmpeg to become an mp3
const PLAYABLE = new Set([".mp3", ".ogg"]);

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };
const bad = (what) => refuse(t("app.gen.badRequest", { what }));
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exists = (p) => access(p).then(() => true, () => false);
const answerOf = (error) => ({ ok: false, message: String(error?.message ?? error) });

async function checkImage(imagePath) {
    if (typeof imagePath !== "string" || !path.isAbsolute(imagePath) || !IMAGE_EXTS.has(path.extname(imagePath).toLowerCase())) refuse(t("app.export.badImage"));
    const info = await stat(imagePath).catch(() => null);
    if (!info?.isFile() || info.size > MAX_IMAGE_BYTES) refuse(t("app.export.badImage"));
    return imagePath;
}

// the export-set message → its checked parts
async function checkExport(req) {
    if (!isObject(req)) bad("request");
    const { ids } = req;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS || !ids.every((id) => typeof id === "string" && id)) bad("ids");
    const rawRates = req.rates ?? [];
    if (!Array.isArray(rawRates) || rawRates.length > MAX_RATES) bad("rates");
    // rates go by hundredths (the version names show two decimals), so 1.004 is 1.0 and refused like it
    const rounded = rawRates.map((r) => (typeof r === "number" ? Math.round(r * 100) / 100 : NaN));
    if (!rounded.every((r) => validRate(r) && r !== 1)) refuse(t("app.export.badRate"));
    const rates = [...new Set(rounded)];
    const metaIn = req.meta ?? {};
    if (!isObject(metaIn)) bad("meta");
    const meta = {};
    for (const [key, limit] of Object.entries(META_LIMITS)) {
        const v = metaIn[key];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string" || v.length > limit) bad(`meta.${key}`);
        meta[key] = v;
    }
    const previewMs = req.previewMs ?? null;
    if (previewMs !== null && !(typeof previewMs === "number" && Number.isFinite(previewMs) && previewMs >= 0)) bad("previewMs");
    if (req.pitch !== undefined && typeof req.pitch !== "boolean") bad("pitch");
    const bg = req.background ?? { mode: "none" };
    if (!isObject(bg) || !BACKGROUNDS.has(bg.mode)) bad("background");
    const background = { mode: bg.mode };
    if (bg.mode === "image" || (bg.mode === "danCourse" && bg.imagePath !== undefined && bg.imagePath !== null)) background.imagePath = await checkImage(bg.imagePath);
    return { ids, meta, previewMs, background, rates, pitch: req.pitch === true };
}

// 4K osu!mania, and rice (at most 15% long notes, the analyser's own rule)
function chartFacts(osuText) {
    const lines = osuText.split(/\r?\n/);
    const mode = Number(/^Mode:\s*(\d+)/m.exec(osuText)?.[1] ?? 0);
    const keys = Number(/^CircleSize:\s*([\d.]+)/m.exec(osuText)?.[1]);
    const start = lines.findIndex((l) => l.trim() === "[HitObjects]");
    const objects = start < 0 ? [] : lines.slice(start + 1).filter((l) => l.split(",").length >= 5);
    const holds = objects.filter((l) => (Number(l.split(",")[3]) & 128) !== 0).length;
    const ok4k = mode === 3 && keys === 4;
    return { ok4k, rice: ok4k && objects.length > 0 && holds / objects.length <= RICE_MAX_LN_RATIO };
}

// deps as main.js hands them out; renderAudio only for tests (the default renders through ffmpeg)
export function registerExportIpc({ ipcMain, generatedStore, paths, log, analysis = null, worker = null, ffmpegPath = null, renderPng = null, tosu = null, generatorClient = null, renderAudio = undefined }) {
    const analyze = (text, rate) => (analysis ? analysis.analyze(text, rate) : worker.analyze(text, rate));
    // main always hands its ffmpeg over; a tool or smoke test that does not gets the dev copy, as main does unpackaged
    const ffmpeg = async () => (ffmpegPath ? ffmpegPath() : (await import("ffmpeg-static")).default);

    ipcMain.handle("export-set", async (_e, raw) => {
        let req;
        try {
            req = await checkExport(raw);
        } catch (error) {
            return error instanceof Refusal ? { ok: false, message: error.message } : answerOf(error);
        }
        const entries = req.ids.map((id) => generatedStore.get(id));
        if (entries.some((e) => !e)) return { ok: false, message: t("app.gen.unknownId") };
        if (entries.some((e) => e.audioPath !== entries[0].audioPath)) return { ok: false, message: t("app.export.mixedSongs") };
        try {
            const { audioPath } = entries[0];
            const needsFfmpeg = req.rates.length > 0 || !PLAYABLE.has(path.extname(audioPath).toLowerCase());
            const title = req.meta.title?.trim() || entries[0].title;
            // one map with no rate versions keeps today's file name
            const single = entries.length === 1 && !req.rates.length;
            const out = await exportMapset({
                ffmpeg: needsFfmpeg ? await ffmpeg() : null,
                dir: paths.mapsDir, audioPath,
                diffs: entries.map((e) => ({ osuText: e.osuText, version: e.version, result: e.result })),
                meta: { ...req.meta, title }, previewMs: req.previewMs, background: req.background, rates: req.rates, pitch: req.pitch,
                danFor: (text) => analyze(text, 1), renderPng, renderAudio,
                name: single ? `${title} [${entries[0].version}]` : null,
            });
            log(`saved ${out.file} (${out.entries.length} difficulties)`);
            return { ok: true, file: out.file, entries: out.entries };
        } catch (error) {
            log(`save failed: ${error?.message}`);
            return answerOf(error);
        }
    });

    ipcMain.handle("song-tags", async (_e, audioPath) => {
        if (typeof audioPath !== "string" || !path.isAbsolute(audioPath) || !AUDIO_EXTS.has(path.extname(audioPath).toLowerCase())) {
            return { ok: false, message: t("app.gen.badRequest", { what: "audioPath" }) };
        }
        try {
            const { artist, title } = await probeTags(await ffmpeg(), audioPath);
            return { ok: true, artist, title };
        } catch (error) {
            return answerOf(error);
        }
    });

    // the maps remap-load described this session: remap-create works on these only
    const loaded = new Map(); // resolved path → { rice }
    ipcMain.handle("remap-load", async (_e, req) => {
        try {
            if (!isObject(req)) bad("request");
            let file;
            if (req.current === true) {
                if (!tosu) bad("current");
                file = await tosu.beatmapPath();
            } else {
                if (typeof req.file !== "string" || !path.isAbsolute(req.file)) bad("file");
                file = req.file;
            }
            if (!String(file).toLowerCase().endsWith(".osu")) refuse(t("app.remap.needOsu"));
            const text = await readFile(file, "utf8");
            const info = readMeta(text);
            const { ok4k, rice } = chartFacts(text);
            let numeric = null;
            let label = null;
            if (rice) {
                const result = await analyze(text, 1);
                if (result?.kind === "ok") ({ numeric, label } = result);
            }
            loaded.set(path.resolve(file), { rice });
            return { ok: true, path: file, name: `${info.artist} - ${info.title} [${info.version}]`, ok4k, rice, numeric, label };
        } catch (error) {
            return error instanceof Refusal ? { ok: false, message: error.message } : answerOf(error);
        }
    });

    ipcMain.handle("remap-create", async (_e, req) => {
        try {
            if (!isObject(req)) bad("request");
            const known = typeof req.path === "string" ? loaded.get(path.resolve(req.path)) : null;
            if (!known) refuse(t("app.remap.unknownMap"));
            const { range } = req;
            if (!isObject(range) || !Number.isFinite(range.lo) || !Number.isFinite(range.hi) || range.lo < 0 || range.hi > MAX_DAN || !(range.lo < range.hi)) bad("range");
            const seed = req.seed ?? 1;
            if (!Number.isSafeInteger(seed)) bad("seed");
            if (!known.rice) refuse(t("app.remap.notRice"));
            const osuText = await readFile(req.path, "utf8");
            if (!chartFacts(osuText).rice) refuse(t("app.remap.notRice"));
            log(`remap ${req.path} to ${range.lo}..${range.hi}`);
            const out = await generatorClient.remap({ osuText, range: { lo: range.lo, hi: range.hi }, seed }, () => {});
            if (out?.kind !== "remapped") return { ok: false, message: out?.message ?? t("app.gen.failed") };
            // next to the original, under a name no file has yet
            const dir = path.dirname(req.path);
            const info = readMeta(out.osuText);
            const nameFor = (version) => path.join(dir, `${safeFileName(`${info.artist} - ${info.title} (${info.creator}) [${version}]`)}.osu`);
            let version = out.version;
            for (let n = 2; await exists(nameFor(version)); n += 1) version = `${out.version} ${n}`;
            const file = nameFor(version);
            await writeFile(file, version === out.version ? out.osuText : setVersion(out.osuText, version), { encoding: "utf8", flag: "wx" });
            log(`remapped ${file}: ${out.result?.numeric} (-${out.removed} +${out.added})`);
            return {
                ok: true, file, version, numeric: out.result?.numeric ?? null, label: out.result?.label ?? null,
                reachable: Boolean(out.reachable), removed: out.removed, added: out.added,
            };
        } catch (error) {
            if (!(error instanceof Refusal)) log(`remap failed: ${error?.message}`);
            return error instanceof Refusal ? { ok: false, message: error.message } : answerOf(error);
        }
    });
}
