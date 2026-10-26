// Main-process side of the "Рейт" tab: the map selected in osu!, its dan at a rate, the rate for a dan, several rates
// at once, rate-changed difficulties in its folder (mirrored and without holds if asked) and saved presets.
// Every handler answers instead of throwing. One rate job (search, batch, copy) runs at a time; a job reads the map's
// path from tosu once, at its start, and is cancelled by a flag looked at between its steps.
// osu! lazer has no Songs folder (its maps are hashed files nothing may be written next to), so there the copies are
// made from a copy of the map in Documents\<app>\lazer and handed to lazer as one .osz it imports (lazerMaps.js).
// A chart picked from Interlude's library is a copy in Documents\<app>\interlude as well: the copies are made next to
// it and go to Interlude as one .osz (sendInterlude, app/interludeClient.js), which is dropped onto its window.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createRateMap, mapInfo } from "./rateCreate.js";
import { createLazerRates, lazerDirOf } from "./lazerMaps.js";
import { createJsonStore } from "./jsonStore.js";
import { validRate, validDiff, MIN_DAN, MAX_DAN } from "./validate.js";
import { rateForDan } from "../src/rate/rateForDan.js";
import { rateSteps, MAX_BATCH } from "../src/rate/rateSteps.js";
import { transformOsu, lnShare } from "../src/rate/chartTransform.js";
import { normalizePresets } from "../src/rate/presets.js";
import { t } from "../src/i18n/i18n.js";

const TARGET_TRIES = 10;
const round2 = (x) => Math.round(x * 100) / 100;
const message = (error) => String(error?.message ?? error);
// null or an empty field keeps the map's own value
const diffOf = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const options = (req) => ({ mirror: req?.mirror === true, noLn: req?.noLn === true });

// One row of a batch: the BPM at that rate and the dan, or what kept it from having one.
function batchRow(rate, bpm, result) {
    const ok = result?.kind === "ok";
    const row = {
        rate, bpm: Math.round(bpm * rate), kind: result?.kind ?? "error",
        label: ok ? result.label : null, numeric: ok ? result.numeric : null, primary: ok ? result.primary ?? null : null,
    };
    if (!ok) for (const k of ["reason", "keys", "message"]) if (result?.[k] !== undefined) row[k] = result[k];
    return row;
}

// beatmap() → tosu's { client, path, audioPath, backgroundPath } (with beatmapPath() alone the map is osu! stable's);
// lazerRates(args) → createLazerRates() with its folders filled in; openPath(file) → "" or why it could not be opened.
export function createRateHandlers({
    beatmapPath, beatmap = null, readText, stat: statFile, analysis, createRateMap: makeCopy, ffmpegPath, presets, progress, log,
    rateForDan: findRate, lazerRates = null, openPath = async () => "", sendInterlude = null,
}) {
    let current = null; // the running job: { cancelled }
    const selected = async () => (beatmap ? await beatmap() : { client: "stable", path: await beatmapPath() });

    // lazer: the copies made from the map copied out of lazer, packed into one .osz, opened so lazer imports it
    async function forLazer({ source, text, rates, opts, key, isCancelled }) {
        const out = await lazerRates({
            ffmpeg: await ffmpegPath(), source, osuText: text, rates, options: opts, isCancelled, log,
            onRate: ({ index, total, rate }) => { if (total > 1) progress({ job: "create", key, index, total, rate }); },
        });
        let opened = false;
        if (out.file) {
            const problem = await openPath(out.file);
            opened = !problem;
            log(`rate lazer osz ${out.file}${problem ? ` not opened: ${problem}` : " opened"}`);
        }
        return { ...out, opened };
    }

    // The map's key: its path and when it last changed, so an edited map counts as another one.
    async function keyOf(file) {
        try {
            const mtime = (await statFile(file))?.mtimeMs;
            return Number.isFinite(mtime) ? `${file}|${Math.round(mtime)}` : file;
        } catch {
            return file;
        }
    }

    // Runs one job with the map read once; a second job while one runs is told so.
    async function job(name, work) {
        if (current) return { ok: false, message: t("rate.err.busy") };
        const self = { cancelled: false };
        current = self;
        try {
            const source = await selected();
            const file = source.path;
            const text = await readText(file);
            const key = await keyOf(file);
            return await work({ file, source, text, key, isCancelled: () => self.cancelled });
        } catch (error) {
            log(`rate ${name} failed: ${message(error)}`);
            return { ok: false, message: message(error) };
        } finally {
            if (current === self) current = null;
        }
    }

    // A list of rates to copy: 1…MAX_BATCH valid ones, each once, ascending; null when it is not that.
    function rateList(value) {
        if (!Array.isArray(value) || !value.length || value.length > MAX_BATCH * 2) return null;
        if (!value.every((r) => typeof r === "number" && validRate(r))) return null;
        const rates = [...new Set(value.map(round2))].sort((a, b) => a - b);
        return rates.length <= MAX_BATCH ? rates : null;
    }

    return {
        async info() {
            try {
                const source = await selected();
                const text = await readText(source.path);
                const mania = /^Mode:\s*3/m.test(text);
                return {
                    ok: true, info: mapInfo(text), mania, keys: Number(/^CircleSize:\s*([\d.]+)/m.exec(text)?.[1]),
                    lnShare: lnShare(text), key: await keyOf(source.path), client: source.client ?? "stable",
                };
            } catch (error) {
                return { ok: false, message: message(error) };
            }
        },

        // { rate, mirror, noLn } or, as before, a bare number
        async preview(req) {
            const rate = typeof req === "number" ? req : req?.rate;
            if (!validRate(rate)) return { kind: "error", message: t("app.rate.range") };
            try {
                const text = await readText(await beatmapPath());
                return await analysis.analyze(transformOsu(text, options(req)), rate);
            } catch (error) {
                return { kind: "error", message: message(error) };
            }
        },

        async create(req) {
            const rate = Number(req?.rate);
            const od = diffOf(req?.od);
            const hp = diffOf(req?.hp);
            if (!validRate(rate) || !validDiff(od) || !validDiff(hp)) return { ok: false, message: t("app.rate.checkInput") };
            return job("create", async ({ file, source, text, key, isCancelled }) => {
                if (source.client === "lazer" && lazerRates) {
                    const out = await forLazer({ source, text, rates: [rate], opts: { pitch: Boolean(req.pitch), od, hp, ...options(req) }, key, isCancelled });
                    if (!out.file) return { ok: false, message: out.failed[0]?.message ?? t("rate.err.cancelled") };
                    return { ok: true, version: out.made[0].version, file: out.file, client: "lazer", opened: out.opened };
                }
                try {
                    const out = await makeCopy({ ffmpeg: await ffmpegPath(), beatmapPath: file, rate, pitch: Boolean(req.pitch), od, hp, ...options(req), osuText: text });
                    log(`rate map ${out.osuPath}${out.reusedAudio ? " (audio reused)" : ""}`);
                    if (source.client === "interlude" && sendInterlude) {
                        const sent = await sendInterlude([out.osuPath]);
                        return { ok: true, version: out.version, file: sent.osz ?? out.osuPath, client: "interlude", sent: sent.ok, sendMessage: sent.message };
                    }
                    return { ok: true, version: out.version, file: out.osuPath };
                } catch (error) {
                    log(`rate map failed: ${message(error)}`);
                    return { ok: false, message: message(error) };
                }
            });
        },

        async target(req) {
            const target = typeof req?.target === "number" ? req.target : NaN;
            if (!(target >= MIN_DAN && target <= MAX_DAN)) return { ok: false, message: t("rate.err.badTarget") };
            const opts = options(req);
            return job("target", async ({ text, key, isCancelled }) => {
                const started = Date.now();
                const chart = transformOsu(text, opts);
                let index = 0;
                const out = await findRate({
                    analyze: (osu, rate) => analysis.analyzeQueued(osu, rate, { isCancelled }),
                    osuText: chart, target, min: 0.5, max: 2, step: 0.01, maxTries: TARGET_TRIES, isCancelled,
                    onTry: ({ rate, numeric }) => {
                        index += 1;
                        progress({ job: "target", key, index, total: TARGET_TRIES, rate, numeric });
                    },
                });
                const tried = out.tries ?? [];
                log(`rate target ${target}${opts.mirror ? " mirror" : ""}${opts.noLn ? " noLn" : ""} → ${out.ok ? `×${out.rate} ${out.numeric} (${out.reason})` : out.reason}`
                    + `, ${index} tries, ${Date.now() - started} ms`);
                if (out.ok) {
                    return { ok: true, key, rate: out.rate, label: out.label, numeric: out.numeric, result: out.result, tries: tried, reason: out.reason };
                }
                if (out.reason === "cancelled") return { ok: false, key, reason: "cancelled", message: t("rate.err.cancelled") };
                return { ok: false, key, reason: out.reason, result: out.result, message: out.result?.message ?? "" };
            });
        },

        async batchDans(req) {
            const steps = rateSteps(req?.from, req?.to, req?.step);
            if (steps.error) return { ok: false, message: t("rate.err.badSteps") };
            const opts = options(req);
            return job("dans", async ({ text, key, isCancelled }) => {
                const started = Date.now();
                const chart = transformOsu(text, opts);
                const bpm = mapInfo(text).bpm;
                const rows = [];
                let cancelled = false;
                for (const [i, rate] of steps.rates.entries()) {
                    if (isCancelled()) {
                        cancelled = true;
                        break;
                    }
                    const result = await analysis.analyzeQueued(chart, rate, { isCancelled });
                    if (result?.cancelled) {
                        cancelled = true;
                        break;
                    }
                    const row = batchRow(rate, bpm, result);
                    rows.push(row);
                    progress({ job: "dans", key, index: i + 1, total: steps.rates.length, rate, numeric: row.numeric, row });
                }
                cancelled ||= isCancelled() && rows.length < steps.rates.length;
                log(`rate batch dans ${rows.length}/${steps.rates.length}${cancelled ? " cancelled" : ""}, ${Date.now() - started} ms`);
                return cancelled ? { ok: true, key, rows, cancelled: true } : { ok: true, key, rows };
            });
        },

        async batchCreate(req) {
            const rates = rateList(req?.rates);
            if (!rates) return { ok: false, message: t("rate.err.badSteps") };
            const od = diffOf(req?.od);
            const hp = diffOf(req?.hp);
            if (!validDiff(od) || !validDiff(hp)) return { ok: false, message: t("app.rate.checkInput") };
            const opts = { pitch: req?.pitch === true, od, hp, ...options(req) };
            return job("create", async ({ file, source, text, key, isCancelled }) => {
                const started = Date.now();
                if (source.client === "lazer" && lazerRates) {
                    const out = await forLazer({ source, text, rates, opts, key, isCancelled });
                    const made = out.made.map((m) => ({ rate: m.rate, version: m.version, file: out.file }));
                    log(`rate batch create (lazer) made ${made.length}, failed ${out.failed.length} of ${rates.length}, ${Date.now() - started} ms`);
                    const answer = { ok: true, key, made, failed: out.failed, client: "lazer", osz: out.file, opened: out.opened };
                    return out.cancelled ? { ...answer, cancelled: true } : answer;
                }
                const ffmpeg = await ffmpegPath();
                const made = [];
                const failed = [];
                let cancelled = false;
                for (const [i, rate] of rates.entries()) {
                    if (isCancelled()) {
                        cancelled = true;
                        break;
                    }
                    progress({ job: "create", key, index: i + 1, total: rates.length, rate });
                    try {
                        const out = await makeCopy({ ffmpeg, beatmapPath: file, rate, ...opts, osuText: text });
                        log(`rate map ${out.osuPath}${out.reusedAudio ? " (audio reused)" : ""}`);
                        made.push({ rate, version: out.version, file: out.osuPath });
                    } catch (error) {
                        log(`rate map ×${rate} failed: ${message(error)}`);
                        failed.push({ rate, message: message(error) });
                    }
                }
                cancelled ||= isCancelled() && made.length + failed.length < rates.length;
                if (source.client === "interlude" && sendInterlude && made.length) {
                    const sent = await sendInterlude(made.map((m) => m.file));
                    log(`rate batch create (interlude) made ${made.length}, failed ${failed.length} of ${rates.length}`);
                    const answer = { ok: true, key, made, failed, client: "interlude", osz: sent.osz ?? null, sent: sent.ok, sendMessage: sent.message };
                    return cancelled ? { ...answer, cancelled: true } : answer;
                }
                log(`rate batch create made ${made.length}, failed ${failed.length} of ${rates.length}${cancelled ? " cancelled" : ""}, ${Date.now() - started} ms`);
                return cancelled ? { ok: true, key, made, failed, cancelled: true } : { ok: true, key, made, failed };
            });
        },

        cancel() {
            if (current) current.cancelled = true;
        },

        async getPresets() {
            try {
                return { ok: true, presets: normalizePresets(await presets.get()) };
            } catch (error) {
                return { ok: false, message: message(error) };
            }
        },

        async savePresets(req) {
            try {
                return { ok: true, presets: normalizePresets(await presets.set(normalizePresets(req?.presets))) };
            } catch (error) {
                return { ok: false, message: message(error) };
            }
        },
    };
}

export function registerRateIpc({ ipcMain, shell, tosu, analysis, ffmpegPath, paths, send, log, interlude = null }) {
    // made on first use: registering touches nothing on disk
    let store = null;
    const presetStore = () => (store ??= createJsonStore({ file: path.join(paths.userData, "rate-presets.json"), normalize: normalizePresets, fallback: [] }));
    const handlers = createRateHandlers({
        beatmapPath: () => tosu.beatmapPath(),
        beatmap: tosu.beatmap ? () => tosu.beatmap() : null,
        lazerRates: (args) => createLazerRates({ ...args, lazerDir: lazerDirOf(paths.docsDir), outDir: paths.mapsDir, makeCopy: createRateMap }),
        openPath: async (file) => (shell ? shell.openPath(file) : ""),
        sendInterlude: interlude ? (files) => interlude.send(files) : null,
        readText: (file) => readFile(file, "utf8"),
        stat: (file) => stat(file),
        analysis,
        createRateMap,
        ffmpegPath,
        presets: { get: () => presetStore().get(), set: (value) => presetStore().set(value) },
        progress: (payload) => send("rate-progress", payload),
        log,
        rateForDan,
    });
    ipcMain.handle("rate-info", () => handlers.info());
    ipcMain.handle("rate-preview", (_e, req) => handlers.preview(req));
    ipcMain.handle("rate-create", (_e, req) => handlers.create(req));
    ipcMain.handle("rate-target", (_e, req) => handlers.target(req));
    ipcMain.handle("rate-batch-dans", (_e, req) => handlers.batchDans(req));
    ipcMain.handle("rate-batch-create", (_e, req) => handlers.batchCreate(req));
    ipcMain.on("rate-cancel", () => handlers.cancel());
    ipcMain.handle("rate-presets-get", () => handlers.getPresets());
    ipcMain.handle("rate-presets-save", (_e, req) => handlers.savePresets(req));
}
