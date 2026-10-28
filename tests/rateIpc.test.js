// The rate tab's main-process handlers with fakes: one job at a time, cancelling between steps, the map's path read
// once per job, analyses through the shared service (its cache keyed by the transformed text), progress tagged with
// the map's key, checked input, presets normalised on save, and the channels registerRateIpc hangs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheKey } from "../src/core/cache.js";
import { mirrorOsu, noLnOsu } from "../src/rate/chartTransform.js";
import { rateForDan } from "../src/rate/rateForDan.js";
import { createRateHandlers, registerRateIpc } from "../app/rateIpc.js";
import { makeChart } from "./fixtures/makeChart.js";
import { t } from "../src/i18n/i18n.js";

const MAP = "C:/Songs/1 A - T/A - T (M) [Hard].osu";
const TEXT = makeChart({ kind: "jumpstream", bpm: 180, seconds: 20 });
const LN_TEXT = makeChart({ kind: "ln", bpm: 180, seconds: 20, lnShare: 0.4 });
const round1 = (x) => Math.round(x * 10) / 10;
const sha = (key) => key.split("@")[0];

// The shared analysis service, faked: a cache by cacheKey, the "worker" counted; dan = 12 + 3·(rate − 1).
function fakeAnalysis({ gate = null } = {}) {
    const cache = new Map();
    const calls = { analyze: 0, queued: 0, worker: 0, keys: [] };
    async function work(text, rate) {
        const key = cacheKey(text, rate);
        calls.keys.push(key);
        if (cache.has(key)) return cache.get(key);
        calls.worker += 1;
        if (gate) await gate(rate);
        const numeric = round1(12 + 3 * (rate - 1));
        const result = { kind: "ok", numeric, label: `L${numeric}`, primary: "Jumpstream" };
        cache.set(key, result);
        return result;
    }
    return {
        calls,
        analyze: (text, rate) => { calls.analyze += 1; return work(text, rate); },
        analyzeQueued: async (text, rate, { isCancelled = () => false } = {}) => {
            calls.queued += 1;
            if (isCancelled()) return { kind: "error", transient: true, cancelled: true, message: "cancelled" };
            return work(text, rate);
        },
    };
}

function setup({ text = TEXT, analysis = fakeAnalysis(), createRateMap, presetsValue = [] } = {}) {
    const seen = { paths: 0, reads: 0, ffmpeg: 0, progress: [], logs: [], made: [] };
    let stored = presetsValue;
    const handlers = createRateHandlers({
        beatmapPath: async () => { seen.paths += 1; return MAP; },
        readText: async (file) => { seen.reads += 1; assert.equal(file, MAP); return text; },
        stat: async () => ({ mtimeMs: 1234.4 }),
        analysis,
        createRateMap: createRateMap ?? (async (req) => {
            seen.made.push(req);
            return { osuPath: `${req.rate}.osu`, version: `Hard ${req.rate}x`, reusedAudio: false };
        }),
        ffmpegPath: async () => { seen.ffmpeg += 1; return "ffmpeg.exe"; },
        presets: { get: async () => stored, set: async (v) => { stored = v; return v; } },
        progress: (p) => seen.progress.push(p),
        log: (line) => seen.logs.push(line),
        rateForDan,
    });
    return { handlers, analysis, seen, stored: () => stored };
}

const manual = () => {
    const waiting = [];
    const gate = () => new Promise((resolve) => waiting.push(resolve));
    const release = () => { while (waiting.length) waiting.shift()(); };
    const next = async () => { while (!waiting.length) await new Promise((r) => setImmediate(r)); waiting.shift()(); };
    return { gate, release, next, waiting };
};

test("info: the map's fields, its LN share and the key (path and change time)", async () => {
    const { handlers } = setup({ text: LN_TEXT });
    const r = await handlers.info();
    assert.equal(r.ok, true);
    assert.equal(r.mania, true);
    assert.equal(r.keys, 4);
    assert.equal(r.info.bpm, 180);
    assert.ok(r.lnShare > 0.3 && r.lnShare < 0.5, String(r.lnShare));
    assert.equal(r.key, `${MAP}|1234`);
    const plain = await setup().handlers.info();
    assert.equal(plain.lnShare, 0);
});

test("preview takes a bare number or { rate, mirror, noLn } and analyses the changed chart", async () => {
    const { handlers, analysis } = setup({ text: LN_TEXT });
    assert.equal((await handlers.preview(1.2)).kind, "ok");
    assert.equal(analysis.calls.keys.at(-1), cacheKey(LN_TEXT, 1.2));
    await handlers.preview({ rate: 1.3, mirror: true, noLn: true });
    assert.equal(analysis.calls.keys.at(-1), cacheKey(mirrorOsu(noLnOsu(LN_TEXT)), 1.3));
    await handlers.preview({ rate: 1.3, noLn: true });
    assert.equal(analysis.calls.keys.at(-1), cacheKey(noLnOsu(LN_TEXT), 1.3));
    // the preview goes past the background line
    assert.equal(analysis.calls.queued, 0);
    for (const bad of [3, "1.2", null, { rate: "1.1" }, { rate: NaN }]) {
        const r = await handlers.preview(bad);
        assert.equal(r.kind, "error", JSON.stringify(bad));
        assert.equal(r.message, t("app.rate.range"));
    }
});

test("rate for a dan: the path is read once, every try is reported with the key, the answer carries the key", async () => {
    const { handlers, analysis, seen } = setup();
    const r = await handlers.target({ target: 13 });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "hit");
    assert.ok(Math.abs(r.result.numeric - 13) <= 0.05);
    // 12 + 3·(r − 1) rounds to 13.0 from ×1.32 to ×1.34
    assert.ok(r.rate >= 1.32 && r.rate <= 1.34, String(r.rate));
    assert.equal(r.key, `${MAP}|1234`);
    assert.ok(r.tries.length <= 10);
    assert.equal(seen.paths, 1);
    assert.equal(seen.reads, 1);
    // all in the background line
    assert.equal(analysis.calls.analyze, 0);
    assert.equal(analysis.calls.queued, r.tries.length);
    assert.equal(seen.progress.length, r.tries.length);
    assert.ok(seen.progress.every((p) => p.job === "target" && p.key === r.key && typeof p.rate === "number"));
    assert.deepEqual(seen.progress.map((p) => p.index), r.tries.map((_, i) => i + 1));
    assert.ok(seen.logs.some((l) => l.startsWith("rate target ")), seen.logs.join("\n"));
});

test("a search after a batch finds the batch's dans in the cache (keyed by the transformed chart)", async () => {
    const { handlers, analysis } = setup();
    const batch = await handlers.batchDans({ from: 1, to: 1.3, step: 0.1, mirror: true });
    assert.equal(batch.ok, true);
    assert.deepEqual(batch.rows.map((row) => row.rate), [1, 1.1, 1.2, 1.3]);
    const before = analysis.calls.worker;
    const r = await handlers.target({ target: 12.9, mirror: true });
    assert.equal(r.ok, true);
    assert.ok(r.rate >= 1.29 && r.rate <= 1.31, String(r.rate));
    // 1.0 at least came from the batch
    assert.ok(analysis.calls.worker - before < r.tries.length, `${analysis.calls.worker - before} of ${r.tries.length}`);
    const mirrored = sha(cacheKey(mirrorOsu(TEXT), 1));
    assert.ok(analysis.calls.keys.every((k) => sha(k) === mirrored), "every analysis was of the mirrored chart");
});

test("edges of the range and a chart with no dan", async () => {
    const above = await setup().handlers.target({ target: 18 });
    assert.equal(above.ok, true);
    assert.equal(above.reason, "above-range");
    assert.equal(above.rate, 2);
    const failed = await setup({ analysis: { analyzeQueued: async () => ({ kind: "not-rice", reason: "ln", keys: 4 }) } }).handlers.target({ target: 13 });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "base-failed");
    assert.equal(failed.result.kind, "not-rice");
});

test("one rate job at a time: a second one is told it is busy, and the next one after it runs", async () => {
    const g = manual();
    const { handlers } = setup({ analysis: fakeAnalysis({ gate: g.gate }) });
    const first = handlers.target({ target: 13 });
    await new Promise((r) => setImmediate(r));
    for (const second of [
        handlers.batchDans({ from: 1, to: 1.2, step: 0.1 }),
        handlers.target({ target: 12 }),
        handlers.batchCreate({ rates: [1.1] }),
        handlers.create({ rate: 1.1, pitch: false, od: null, hp: null }),
    ]) {
        assert.deepEqual(await second, { ok: false, message: t("rate.err.busy") });
    }
    // info, preview and presets are not jobs
    assert.equal((await handlers.info()).ok, true);
    g.release();
    const timer = setInterval(g.release, 1);
    try {
        assert.equal((await first).ok, true);
        assert.equal((await handlers.batchDans({ from: 1, to: 1.2, step: 0.1 })).ok, true);
    } finally {
        clearInterval(timer);
    }
});

test("cancel stops a batch between steps; nothing more is analysed and the rows so far come back", async () => {
    const g = manual();
    const { handlers, analysis, seen } = setup({ analysis: fakeAnalysis({ gate: g.gate }) });
    const job = handlers.batchDans({ from: 1, to: 1.5, step: 0.05 });
    await g.next(); // ×1.0 done
    await g.next(); // ×1.05 done
    while (seen.progress.length < 2) await new Promise((r) => setImmediate(r));
    handlers.cancel();
    g.release();
    const r = await job;
    assert.equal(r.ok, true);
    assert.equal(r.cancelled, true);
    assert.ok(r.rows.length >= 2 && r.rows.length < 11, String(r.rows.length));
    const worked = analysis.calls.worker;
    assert.ok(worked <= r.rows.length + 1);
    // the next job is not cancelled (both rates are in the cache, so the gate does not hold them)
    const again = await handlers.batchDans({ from: 1, to: 1.05, step: 0.05 });
    assert.equal(again.ok, true);
    assert.equal(again.cancelled, undefined);
    assert.equal(again.rows.length, 2);
    // a search cancelled midway
    const g2 = manual();
    const s = setup({ analysis: fakeAnalysis({ gate: g2.gate }) });
    const search = s.handlers.target({ target: 13 });
    await g2.next();
    s.handlers.cancel();
    g2.release();
    const stopped = await search;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.reason, "cancelled");
    assert.equal(stopped.message, t("rate.err.cancelled"));
});

test("batch dans: one row per rate with BPM and dan, each sent as progress with the key", async () => {
    const { handlers, seen } = setup();
    const r = await handlers.batchDans({ from: 1.2, to: 1, step: 0.1, noLn: true });
    assert.equal(r.ok, true);
    assert.equal(r.key, `${MAP}|1234`);
    assert.deepEqual(r.rows, [
        { rate: 1, bpm: 180, kind: "ok", label: "L12", numeric: 12, primary: "Jumpstream" },
        { rate: 1.1, bpm: 198, kind: "ok", label: "L12.3", numeric: 12.3, primary: "Jumpstream" },
        { rate: 1.2, bpm: 216, kind: "ok", label: "L12.6", numeric: 12.6, primary: "Jumpstream" },
    ]);
    assert.deepEqual(seen.progress.map((p) => [p.job, p.key, p.index, p.total, p.rate, p.row.numeric]),
        r.rows.map((row, i) => ["dans", r.key, i + 1, 3, row.rate, row.numeric]));
    assert.equal(seen.paths, 1);
    assert.ok(seen.logs.some((l) => l.startsWith("rate batch dans")), seen.logs.join("\n"));
});

test("a rate that fails in a batch gets a row without a dan", async () => {
    const analysis = {
        analyzeQueued: async (_text, rate) => (rate > 1.05 ? { kind: "error", message: "boom" } : { kind: "ok", numeric: 12, label: "Gamma low", primary: "Stream" }),
    };
    const r = await setup({ analysis }).handlers.batchDans({ from: 1, to: 1.1, step: 0.1 });
    assert.equal(r.rows[1].kind, "error");
    assert.equal(r.rows[1].numeric, null);
    assert.equal(r.rows[1].message, "boom");
});

test("bad rates, steps and targets are refused before anything is read", async () => {
    const { handlers, seen } = setup();
    for (const req of [{ from: 1, to: 1.5, step: 0 }, { from: 0.2, to: 1, step: 0.1 }, { from: 1, to: 2, step: 0.01 }, null, "x", { from: "a", to: 1, step: 0.1 }]) {
        assert.deepEqual(await handlers.batchDans(req), { ok: false, message: t("rate.err.badSteps") }, JSON.stringify(req));
    }
    for (const req of [{ rates: [] }, { rates: [1.1, 3] }, { rates: "1.1" }, { rates: Array.from({ length: 32 }, (_, i) => 0.5 + i * 0.01) }, null, { rates: [NaN] }]) {
        assert.deepEqual(await handlers.batchCreate(req), { ok: false, message: t("rate.err.badSteps") }, JSON.stringify(req));
    }
    assert.deepEqual(await handlers.batchCreate({ rates: [1.1], od: 11 }), { ok: false, message: t("app.rate.checkInput") });
    for (const req of [{ target: "x" }, { target: 0 }, { target: 99 }, null, {}]) {
        assert.deepEqual(await handlers.target(req), { ok: false, message: t("rate.err.badTarget") }, JSON.stringify(req));
    }
    assert.deepEqual(await handlers.create({ rate: 5 }), { ok: false, message: t("app.rate.checkInput") });
    assert.deepEqual(await handlers.create({ rate: 1.2, hp: -1 }), { ok: false, message: t("app.rate.checkInput") });
    assert.equal(seen.paths, 0);
    assert.equal(seen.reads, 0);
});

test("batch create: one copy per rate from the text read once, with the options; a failed rate does not stop the rest", async () => {
    const made = [];
    const createRateMap = async (req) => {
        made.push(req);
        if (req.rate === 1.2) throw new Error("disk full");
        return { osuPath: `${req.rate}.osu`, version: `Hard ${req.rate}x Mirror`, reusedAudio: false };
    };
    const { handlers, seen } = setup({ createRateMap });
    const r = await handlers.batchCreate({ rates: [1.3, 1.1, 1.2, 1.1], pitch: true, od: "8.5", hp: null, mirror: true, noLn: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.made, [{ rate: 1.1, version: "Hard 1.1x Mirror", file: "1.1.osu" }, { rate: 1.3, version: "Hard 1.3x Mirror", file: "1.3.osu" }]);
    assert.deepEqual(r.failed, [{ rate: 1.2, message: "disk full" }]);
    assert.deepEqual(made.map((m) => m.rate), [1.1, 1.2, 1.3]);
    for (const m of made) {
        assert.equal(m.osuText, TEXT);
        assert.equal(m.beatmapPath, MAP);
        assert.equal(m.ffmpeg, "ffmpeg.exe");
        assert.deepEqual([m.pitch, m.od, m.hp, m.mirror, m.noLn], [true, 8.5, null, true, false]);
    }
    assert.equal(seen.paths, 1);
    assert.equal(seen.reads, 1);
    assert.equal(seen.ffmpeg, 1);
    assert.deepEqual(seen.progress.map((p) => [p.job, p.key, p.index, p.total, p.rate]),
        [["create", r.key, 1, 3, 1.1], ["create", r.key, 2, 3, 1.2], ["create", r.key, 3, 3, 1.3]]);
    assert.ok(seen.logs.some((l) => l.startsWith("rate batch create")), seen.logs.join("\n"));
});

test("batch create stops between copies when cancelled", async () => {
    let s = null;
    const createRateMap = async (req) => {
        if (req.rate === 1.1) s.handlers.cancel();
        return { osuPath: "x.osu", version: "v", reusedAudio: true };
    };
    s = setup({ createRateMap });
    const r = await s.handlers.batchCreate({ rates: [1.1, 1.2, 1.3] });
    assert.equal(r.cancelled, true);
    assert.equal(r.made.length, 1);
});

test("single create keeps its answer and passes mirror and no-LN", async () => {
    const { handlers, seen } = setup();
    const r = await handlers.create({ rate: 1.25, pitch: true, od: "", hp: 7, mirror: true, noLn: true });
    assert.deepEqual(r, { ok: true, version: "Hard 1.25x", file: "1.25.osu" });
    assert.deepEqual([seen.made[0].rate, seen.made[0].pitch, seen.made[0].od, seen.made[0].hp, seen.made[0].mirror, seen.made[0].noLn],
        [1.25, true, null, 7, true, true]);
    const failing = setup({ createRateMap: async () => { throw new Error("no audio"); } });
    assert.deepEqual(await failing.handlers.create({ rate: 1.1 }), { ok: false, message: "no audio" });
});

test("handlers answer instead of throwing when tosu or the disk fail", async () => {
    const handlers = createRateHandlers({
        beatmapPath: async () => { throw new Error("osu! is closed"); },
        readText: async () => "", stat: async () => ({}), analysis: fakeAnalysis(), createRateMap: async () => ({}),
        ffmpegPath: async () => "", presets: { get: async () => { throw new Error("bad disk"); }, set: async () => { throw new Error("bad disk"); } },
        progress: () => {}, log: () => {}, rateForDan,
    });
    assert.deepEqual(await handlers.info(), { ok: false, message: "osu! is closed" });
    assert.equal((await handlers.preview(1.2)).kind, "error");
    assert.deepEqual(await handlers.target({ target: 13 }), { ok: false, message: "osu! is closed" });
    assert.deepEqual(await handlers.batchDans({ from: 1, to: 1.1, step: 0.1 }), { ok: false, message: "osu! is closed" });
    assert.deepEqual(await handlers.getPresets(), { ok: false, message: "bad disk" });
    assert.deepEqual(await handlers.savePresets({ presets: [] }), { ok: false, message: "bad disk" });
    handlers.cancel(); // nothing running: nothing happens
    // the lock is free again after a failed job
    assert.deepEqual(await handlers.target({ target: 13 }), { ok: false, message: "osu! is closed" });
});

test("presets are normalised when saved and read", async () => {
    const { handlers, stored } = setup({ presetsValue: [{ rate: 1.2 }, "junk"] });
    assert.deepEqual(await handlers.getPresets(), { ok: true, presets: [{ rate: 1.2, pitch: false, od: null, hp: null, mirror: false, noLn: false }] });
    const r = await handlers.savePresets({ presets: [{ rate: 9, od: 8, mirror: true }, { rate: 2, od: 8, mirror: true }, null] });
    assert.deepEqual(r, { ok: true, presets: [{ rate: 2, pitch: false, od: 8, hp: null, mirror: true, noLn: false }] });
    assert.deepEqual(stored(), r.presets);
    assert.deepEqual(await handlers.savePresets("x"), { ok: true, presets: [] });
});

test("registerRateIpc hangs the v2 channels; presets live in userData/rate-presets.json across restarts", async () => {
    const userData = await mkdtemp(path.join(tmpdir(), "rate-ipc-"));
    const register = () => {
        const handled = new Map();
        const listened = new Map();
        const sent = [];
        registerRateIpc({
            ipcMain: { handle: (c, fn) => handled.set(c, fn), on: (c, fn) => listened.set(c, fn) },
            tosu: { beatmapPath: async () => { throw new Error("no osu"); } },
            analysis: fakeAnalysis(), ffmpegPath: async () => "ffmpeg", paths: { userData },
            send: (channel, payload) => sent.push([channel, payload]), log: () => {},
        });
        return { handled, listened, sent };
    };
    const first = register();
    assert.deepEqual([...first.handled.keys()].sort(), ["rate-batch-create", "rate-batch-dans", "rate-create", "rate-info", "rate-presets-get",
        "rate-presets-save", "rate-preview", "rate-target"]);
    assert.deepEqual([...first.listened.keys()], ["rate-cancel"]);
    assert.equal((await first.handled.get("rate-preview")({}, 1.2)).kind, "error");
    const saved = await first.handled.get("rate-presets-save")({}, { presets: [{ rate: 1.3, pitch: true }] });
    assert.equal(saved.ok, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(userData, "rate-presets.json"), "utf8")), saved.presets);
    const second = register();
    assert.deepEqual(await second.handled.get("rate-presets-get")({}), saved);
    first.listened.get("rate-cancel")({});
});

// waits (a bounded while) until check() holds
async function until(check, what) {
    for (let i = 0; i < 500; i += 1) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 2));
    }
    assert.fail(`timed out waiting for ${what}`);
}

test("the ladder asks analysis.lanes rates at once (the background line runs that many) and sends its rows in order", async () => {
    const g = manual();
    const analysis = Object.assign(fakeAnalysis({ gate: g.gate }), { lanes: 3 });
    const { handlers, seen } = setup({ analysis });
    const job = handlers.batchDans({ from: 1, to: 1.25, step: 0.05 });
    await until(() => g.waiting.length >= 3, "three rates under way");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(g.waiting.length, 3, "three under way, the fourth waits for a free lane");
    g.waiting.splice(1, 1)[0](); // ×1.05 answers before ×1.0
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen.progress, [], "no row before ×1.0's");
    await until(() => { g.release(); return seen.progress.length === 6; }, "all six rows");
    const r = await job;
    assert.deepEqual(r.rows.map((row) => row.rate), [1, 1.05, 1.1, 1.15, 1.2, 1.25]);
    assert.deepEqual(seen.progress.map((p) => p.index), [1, 2, 3, 4, 5, 6]);
    assert.equal(analysis.calls.worker, 6);
});

test("a ladder cancelled with rates asked ahead stops there and asks for nothing more", async () => {
    const g = manual();
    const analysis = Object.assign(fakeAnalysis({ gate: g.gate }), { lanes: 3 });
    const { handlers } = setup({ analysis });
    const job = handlers.batchDans({ from: 1, to: 1.5, step: 0.05 });
    await until(() => g.waiting.length >= 3, "three rates under way");
    handlers.cancel();
    g.release();
    const r = await job;
    assert.equal(r.cancelled, true);
    assert.equal(analysis.calls.queued, 3, "the three asked ahead, no more");
});

// ---- a rate map on the analysis card: the tab works on its original, never on the sped-up copy ----

const RATE_MAP_FILE = "C:/Songs/1 A - T/A - T (M) [Hard 1.2x (216bpm) Mirror].osu";
const ORIGINAL_FILE = "C:/Songs/1 A - T/A - T (M) [Hard].osu";
const REBUILT = makeChart({ kind: "stream", bpm: 180, seconds: 20 });

// handlers whose card shows a rate map: `origin` as the selection controller's rateMap() gives it
function withOrigin(origin, { source = { client: "stable", path: RATE_MAP_FILE } } = {}) {
    const seen = { reads: [], made: [], analysed: [] };
    const files = { [ORIGINAL_FILE]: TEXT, [RATE_MAP_FILE]: "the rate map itself", [source.path]: "the rate map itself" };
    const handlers = createRateHandlers({
        beatmapPath: async () => source.path,
        beatmap: async () => source,
        readText: async (file) => { seen.reads.push(file); return files[file]; },
        stat: async () => ({ mtimeMs: 99 }),
        analysis: {
            analyze: async (text, rate) => { seen.analysed.push([text, rate]); return { kind: "ok", numeric: 12, label: "L" }; },
            analyzeQueued: async (text, rate) => { seen.analysed.push([text, rate]); return { kind: "ok", numeric: 12, label: "L" }; },
        },
        createRateMap: async (req) => { seen.made.push(req); return { osuPath: `${req.rate}.osu`, version: `Hard ${req.rate}x`, reusedAudio: false }; },
        ffmpegPath: async () => "ffmpeg.exe",
        progress: () => {},
        log: () => {},
        rateMap: () => origin,
    });
    return { handlers, seen };
}

test("a rate map's original from its folder: the tab's map, its key, the rate map's Mirror told, copies made from it and its audio", async () => {
    const origin = { rate: 1.2, path: ORIGINAL_FILE, file: RATE_MAP_FILE, client: "stable", virtual: false, mirror: true, noLn: false, text: "mirrored", version: "Hard 1.2x (216bpm) Mirror" };
    const { handlers, seen } = withOrigin(origin);
    const info = await handlers.info();
    assert.equal(info.ok, true);
    assert.equal(info.info.version, "jumpstream 180", "the original's own fields");
    assert.equal(info.key, `${ORIGINAL_FILE}|99`, "the original's key, as when it is selected in osu!");
    assert.deepEqual(info.origin, { rate: 1.2, virtual: false, mirror: true, noLn: false, version: "Hard 1.2x (216bpm) Mirror" });
    await handlers.preview({ rate: 1.3 });
    assert.deepEqual(seen.analysed.at(-1), [TEXT, 1.3], "the original's own file at ×1.3, the tab's options on top of it");
    const made = await handlers.create({ rate: 1.3, pitch: false });
    assert.equal(made.ok, true);
    // the copy is the original's at ×1.3 with its own audio: the rate map's (already ×1.2) is never sped up again
    assert.deepEqual([seen.made[0].beatmapPath, seen.made[0].osuText, seen.made[0].rate], [ORIGINAL_FILE, TEXT, 1.3]);
    assert.ok(!seen.reads.includes(RATE_MAP_FILE), "the rate map's file is never read");
});

test("an original made back from a rate map: dans at any rate, no copies (its audio is the rate map's, already at ×1.2)", async () => {
    const origin = { rate: 1.2, path: null, file: RATE_MAP_FILE, client: "stable", virtual: true, mirror: true, noLn: false, text: REBUILT, version: "Hard 1.2x (216bpm) Mirror" };
    const { handlers, seen } = withOrigin(origin);
    const info = await handlers.info();
    assert.equal(info.info.version, "stream 180");
    assert.equal(info.key, `${RATE_MAP_FILE}|99#original`, "not the rate map's own key");
    assert.deepEqual(info.origin, { rate: 1.2, virtual: true, mirror: false, noLn: false, version: "Hard 1.2x (216bpm) Mirror" }, "its Mirror is in its chart already");
    await handlers.preview(1.1);
    assert.deepEqual(seen.analysed.at(-1), [REBUILT, 1.1]);
    const dans = await handlers.batchDans({ from: 1, to: 1.1, step: 0.1 });
    assert.deepEqual(dans.rows.map((r) => r.rate), [1, 1.1]);
    assert.deepEqual(seen.analysed.slice(-2), [[REBUILT, 1], [REBUILT, 1.1]]);
    const one = await handlers.create({ rate: 1.3 });
    const many = await handlers.batchCreate({ rates: [1.1, 1.3] });
    assert.equal(one.ok, false);
    assert.equal(one.message, t("rate.err.noOriginal"));
    assert.equal(many.ok, false);
    assert.deepEqual(seen.made, [], "no copy, no audio rendered");
    assert.deepEqual(seen.reads, []);
});

test("a rate map the finder had no file of (osu! lazer, or tosu's path unchecked): the made-back original, never the rate map", async () => {
    const hashed = "C:/lazer/files/ab/abcdef";
    for (const [client, source] of [["lazer", { client: "lazer", path: hashed }], ["stable", { client: "stable", path: RATE_MAP_FILE }]]) {
        const origin = { rate: 1.2, path: null, file: null, client, virtual: true, mirror: false, noLn: false, text: REBUILT, version: "Hard 1.2x (216bpm)" };
        const { handlers, seen } = withOrigin(origin, { source });
        const info = await handlers.info();
        assert.equal(info.info.version, "stream 180", `${client}: the original's fields`);
        assert.equal(info.key, `${source.path}|99#original`, `${client}: not the rate map's own key`);
        assert.equal(info.client, client);
        assert.deepEqual(info.origin, { rate: 1.2, virtual: true, mirror: false, noLn: false, version: "Hard 1.2x (216bpm)" });
        await handlers.preview({ rate: 1.3 });
        assert.deepEqual(seen.analysed.at(-1), [REBUILT, 1.3], `${client}: the ladder's ×1.3 row, not the rate map at ×1.3`);
        const made = await handlers.create({ rate: 1.3 });
        assert.equal(made.ok, false);
        assert.equal(made.message, t("rate.err.noOriginal"));
        assert.deepEqual(seen.made, []);
        assert.deepEqual(seen.reads, [], `${client}: the rate map's file is never read`);
    }
});

test("without a rate map on the card the tab takes the selection as before", async () => {
    const { handlers, seen } = withOrigin(null);
    const info = await handlers.info();
    assert.equal(info.origin, null);
    assert.equal(info.key, `${RATE_MAP_FILE}|99`);
    assert.deepEqual(seen.reads, [RATE_MAP_FILE]);
});
