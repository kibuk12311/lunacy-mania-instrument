// Main-process side of the "Создать карту" tab (mapgen v3): generate-map and detect-timing.
// Generating never writes a file: the map goes into the store and the window gets its id; saving is export-set
// (app/exportIpc.js). Everything the window sends is checked here, and every handler answers instead of throwing.
import { PATTERN_NAMES } from "../src/gen/patterns.js";
import { flavoursOf } from "../src/gen/flavours.js";
import { parseRows } from "../src/gen/mapRows.js";
import { audioNameFor } from "./mapExport.js";
import { t } from "../src/i18n/i18n.js";

export const PART_KINDS = ["intro", "build", "drop", "break", "outro", "part"];
export const SNAPS = [4, 3, 6, 8];
const MIXES = ["sections", "mixed"];
const MAX_SECTIONS = 256;
const MAX_PARTS = 24;
const MAX_OWN_RANGES = 8;
const MAX_DAN = 21;
const MAX_ISSUES = 50;
const MAX_JOB_ID = 64;
// a lock holds while the timing and the locked part edges are the same, within these
const SECTION_TIME_MS = 0.5;
const SECTION_BPM = 1e-6;
const PART_EDGE_MS = 1;
// today's generators put every row on 1/4
const Q4_GRID = { 4: 1, 3: 0, 6: 0, 8: 0 };

// A refused request names the field: «Неверный запрос: timing.sections[1].bpm».
class BadRequest extends Error {
    constructor(what) {
        super(what);
        this.what = what;
    }
}
const bad = (what) => { throw new BadRequest(what); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isSafeInteger(v);
const isList = (v) => Array.isArray(v) || ArrayBuffer.isView(v);
const optional = (v, ok, what) => { if (v !== undefined && !ok(v)) bad(what); };

// Timing (or the old {bpm, offsetMs}) → { sections, bpm, offsetMs }, the mirrors taken from the first section.
export function checkTiming(timing, durationMs = Infinity, what = "timing") {
    if (!isObject(timing)) bad(what);
    const raw = timing.sections ?? (isNumber(timing.bpm) && isNumber(timing.offsetMs) ? [{ timeMs: timing.offsetMs, bpm: timing.bpm, meter: 4 }] : null);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SECTIONS) bad(`${what}.sections`);
    const sections = raw.map((s, i) => {
        const at = `${what}.sections[${i}]`;
        if (!isObject(s)) bad(at);
        if (!isNumber(s.timeMs) || s.timeMs < 0 || s.timeMs >= durationMs) bad(`${at}.timeMs`);
        if (i > 0 && !(s.timeMs > raw[i - 1].timeMs)) bad(`${at}.timeMs`);
        if (!isNumber(s.bpm) || s.bpm < 40 || s.bpm > 400) bad(`${at}.bpm`);
        const meter = s.meter ?? 4;
        if (!isInt(meter) || meter < 1 || meter > 16) bad(`${at}.meter`);
        return { timeMs: s.timeMs, bpm: s.bpm, meter };
    });
    return { sections, bpm: sections[0].bpm, offsetMs: sections[0].timeMs };
}

function checkRange(range, what) {
    if (!isObject(range) || !isNumber(range.lo) || !isNumber(range.hi) || range.lo < 0 || range.hi > MAX_DAN || !(range.lo < range.hi)) bad(what);
}

// a pattern may name some of its family's flavours (sub-patterns, src/gen/flavours.js), each once
function checkPatterns(patterns, what) {
    if (!Array.isArray(patterns) || patterns.length < 1 || patterns.length > PATTERN_NAMES.length) bad(what);
    patterns.forEach((p, i) => {
        if (!isObject(p) || !PATTERN_NAMES.includes(p.name)) bad(`${what}[${i}].name`);
        if (!isNumber(p.share) || p.share < 0) bad(`${what}[${i}].share`);
        if (p.flavours !== undefined) {
            const own = flavoursOf(p.name);
            const ok = Array.isArray(p.flavours) && p.flavours.length <= own.length && new Set(p.flavours).size === p.flavours.length
                && p.flavours.every((f) => own.includes(f));
            if (!ok) bad(`${what}[${i}].flavours`);
        }
    });
}

function checkEnvelope(envelope, what) {
    if (!isObject(envelope) || !isList(envelope.values) || !isNumber(envelope.hopSec) || envelope.hopSec <= 0) bad(what);
}

function checkParts(parts, durationMs) {
    if (!Array.isArray(parts) || parts.length > MAX_PARTS) bad("request.parts");
    parts.forEach((p, i) => {
        const at = `request.parts[${i}]`;
        if (!isObject(p) || !isNumber(p.startMs) || !isNumber(p.endMs) || !(p.startMs < p.endMs) || p.startMs < 0 || p.startMs >= durationMs) bad(at);
        if (!PART_KINDS.includes(p.kind)) bad(`${at}.kind`);
        if (p.range !== undefined && p.range !== null) checkRange(p.range, `${at}.range`);
        if (p.patterns !== undefined && p.patterns !== null) checkPatterns(p.patterns, `${at}.patterns`);
        optional(p.empty, (v) => typeof v === "boolean", `${at}.empty`);
        optional(p.seed, isInt, `${at}.seed`);
    });
    if (parts.filter((p) => p.range).length > MAX_OWN_RANGES) bad("request.parts");
}

function checkRequest(request, durationMs) {
    if (!isObject(request)) bad("request");
    if (request.range !== undefined && request.range !== null) checkRange(request.range, "request.range");
    else if (!isNumber(request.target) || request.target <= 0 || request.target > MAX_DAN) bad("request.range");
    checkPatterns(request.patterns, "request.patterns");
    optional(request.mix, (v) => MIXES.includes(v), "request.mix");
    optional(request.stamina, (v) => isNumber(v) && v >= 0 && v <= 1, "request.stamina");
    optional(request.burst, (v) => isNumber(v) && v >= 0 && v <= 1, "request.burst");
    if (!isInt(request.seed)) bad("request.seed");
    optional(request.planSeed, isInt, "request.planSeed");
    optional(request.noteSeed, isInt, "request.noteSeed");
    optional(request.snaps, (v) => Array.isArray(v) && v.includes(4) && v.every((s) => SNAPS.includes(s)) && new Set(v).size === v.length, "request.snaps");
    optional(request.normalizeSv, (v) => typeof v === "boolean", "request.normalizeSv");
    if (request.parts !== undefined && request.parts !== null) checkParts(request.parts, durationMs);
    if (request.lock !== undefined && request.lock !== null) {
        const { lock } = request;
        if (!isObject(lock) || typeof lock.fromId !== "string" || !lock.fromId) bad("request.lock");
        const count = request.parts?.length ?? 0;
        if (!Array.isArray(lock.parts) || !lock.parts.length || !lock.parts.every((i) => isInt(i) && i >= 0 && i < count)) bad("request.lock.parts");
    }
}

// The whole generate-map message → its checked parts (timing normalised to sections).
export function checkGenerate(req) {
    if (!isObject(req)) bad("request");
    if (req.jobId !== undefined && (typeof req.jobId !== "string" || req.jobId.length > MAX_JOB_ID)) bad("jobId");
    if (typeof req.audioPath !== "string" || !req.audioPath) bad("audioPath");
    if (req.title !== undefined && typeof req.title !== "string") bad("title");
    if (!isNumber(req.durationMs) || req.durationMs <= 0) bad("durationMs");
    checkEnvelope(req.envelope, "envelope");
    const timing = checkTiming(req.timing, req.durationMs);
    checkRequest(req.request, req.durationMs);
    return { jobId: req.jobId ?? null, audioPath: req.audioPath, title: req.title ?? "", durationMs: req.durationMs, envelope: req.envelope, timing, request: req.request };
}

const sameSections = (a, b) => a.length === b.length && a.every((s, i) =>
    Math.abs(s.timeMs - b[i].timeMs) <= SECTION_TIME_MS && Math.abs(s.bpm - b[i].bpm) <= SECTION_BPM && s.meter === b[i].meter);

// lock → the worker's `locked` (rows of the base map inside the locked parts), or null when it no longer fits.
function resolveLock(lock, { audioPath, timing, parts }, base) {
    if (!base || base.audioPath !== audioPath || !sameSections(base.timing.sections, timing.sections)) return null;
    const ranges = [];
    for (const i of lock.parts) {
        const was = base.parts?.[i];
        const now = parts[i];
        if (!was || Math.abs(was.startMs - now.startMs) > PART_EDGE_MS || Math.abs(was.endMs - now.endMs) > PART_EDGE_MS) return null;
        ranges.push([was.startMs, was.endMs]);
    }
    const inside = (time) => ranges.some(([from, to]) => time >= from && time < to);
    return { rows: parseRows(base.osuText).filter((r) => inside(r.t)), ranges, knob: base.knob, planSeed: base.planSeed };
}

const badRequest = (what) => ({ ok: false, code: "badRequest", message: t("app.gen.badRequest", { what }) });

export function registerCreateIpc({ ipcMain, generatorClient, generatedStore, log }) {
    ipcMain.handle("generate-map", async (event, raw) => {
        const started = Date.now();
        let req;
        try {
            req = checkGenerate(raw);
        } catch (error) {
            if (error instanceof BadRequest) return badRequest(error.what);
            return { ok: false, code: "failed", message: String(error?.message ?? error) };
        }
        try {
            const { jobId, audioPath, title, durationMs, envelope, timing } = req;
            const { lock, ...request } = req.request;
            let locked = null;
            if (lock) {
                const base = generatedStore.get(lock.fromId);
                locked = resolveLock(lock, { audioPath, timing, parts: request.parts }, base);
                if (!locked) return { ok: false, code: "timingChanged", message: t(base ? "app.gen.timingChanged" : "app.gen.unknownId") };
            }
            const want = request.range ? `${request.range.lo}..${request.range.hi}` : request.target;
            log(`generate ${title} dan ${want} ${request.patterns.map((p) => p.name).join("+")}${lock ? ` lock ${lock.parts.join(",")}` : ""}`);
            const forward = (p) => {
                try {
                    if (event?.sender?.isDestroyed?.()) return;
                    event.sender.send("generate-progress", { jobId, phase: p.phase, i: p.i, n: p.n, ...(p.kind ? { kind: p.kind } : {}) });
                } catch {
                    // the window went away; the job goes on
                }
            };
            const out = await generatorClient.generate({
                timing, envelope, durationMs, request,
                ...(locked ? { locked } : {}),
                meta: { title, audioFilename: audioNameFor(audioPath) },
            }, forward);
            if (out?.kind !== "generated") {
                log(`generate failed: ${out?.message}`);
                return { ok: false, code: "failed", message: out?.message ?? t("app.gen.failed") };
            }
            const knob = out.knob ?? out.offset ?? out.lambda ?? null;
            const planSeed = out.planSeed ?? request.planSeed ?? request.seed;
            const noteSeed = out.noteSeed ?? request.noteSeed ?? request.seed;
            const range = out.range ?? request.range ?? null;
            const parts = out.parts ?? [];
            const id = generatedStore.put({
                osuText: out.osuText, version: out.version, title, audioPath, timing,
                // a later lock is checked against the parts the map was really made with
                parts: parts.length ? parts.map(({ startMs, endMs, kind }) => ({ startMs, endMs, kind })) : (request.parts ?? []),
                knob, planSeed, noteSeed, engine: out.engine, result: out.result, range,
            });
            const ms = Date.now() - started;
            log(`generated ${id} got ${out.result?.numeric} reachable ${out.reachable} in ${ms} ms`);
            return {
                ok: true, id, engine: out.engine, modelInfo: out.modelInfo, version: out.version, osuText: out.osuText,
                result: out.result, reachable: out.reachable, range, noteCount: out.noteCount, patternScore: out.patternScore,
                ...(Number.isFinite(out.flavourScore) ? { flavourScore: out.flavourScore, familyScore: out.familyScore } : {}),
                flavours: Array.isArray(out.flavours) ? out.flavours : [],
                knob, planSeed, noteSeed,
                stats: out.stats ?? null, issues: (out.issues ?? []).slice(0, MAX_ISSUES), parts,
                retries: out.retries ?? { blocks: 0, dan: null }, grid: out.grid ?? Q4_GRID, ms,
            };
        } catch (error) {
            log(`generate failed: ${error?.message}`);
            return { ok: false, code: "failed", message: String(error?.message ?? error) };
        }
    });

    ipcMain.handle("detect-timing", async (_e, raw) => {
        let fine = null;
        let hint = null;
        try {
            if (!isObject(raw)) bad("request");
            checkEnvelope(raw.envelope, "envelope");
            if (raw.fine !== undefined && raw.fine !== null) {
                checkEnvelope(raw.fine, "fine");
                fine = raw.fine;
            }
            if (raw.hint !== undefined && raw.hint !== null) hint = checkTiming(raw.hint, Infinity, "hint");
        } catch (error) {
            if (error instanceof BadRequest) return badRequest(error.what);
            return { ok: false, message: String(error?.message ?? error) };
        }
        try {
            const out = await generatorClient.detectTiming({ envelope: raw.envelope, fine, hint });
            if (out?.kind !== "timing") return { ok: false, message: out?.message ?? t("app.gen.timingFailed") };
            return { ok: true, timing: out.timing, modelInfo: out.modelInfo };
        } catch (error) {
            return { ok: false, message: String(error?.message ?? error) };
        }
    });
}
