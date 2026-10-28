// A rate map on the card end to end with the real modules and the real analyzer: the finder in main over a fake folder
// holding the rate map and its original, the selection controller, the ladder's service in main and the panel in the
// window. The card's dan stays the file's own at 1.0; it is shown at ×1.2, the ladder marks ×1.2 as now and its rows
// are the original's, the now row too (its 1.0 row is the original at 1.0); a click opens the Rate tab at that rate on
// the original, with the dan its row shows.
import test from "node:test";
import path from "node:path";
import assert from "node:assert/strict";
import { fakeDom, fire } from "./helpers/fakeDom.js";
import { createSelectionController } from "../app/selectionController.js";
import { createRateOrigins } from "../app/rateMapOrigin.js";
import { createDetailsService } from "../app/analysisDetails.js";
import { createAnalysisPanel } from "../app/renderer/analysisPanel.js";
import { LADDER_RATES } from "../app/renderer/analysisExtras.js";
import { createRateHandlers } from "../app/rateIpc.js";
import { analyzeChart } from "../src/core/analyze.js";
import { rateOsu } from "../src/rate/rateMap.js";
import { randomChart } from "./fixtures/randomChart.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
// the real analyzer takes real time: wait for a condition, 30 s at most
async function until(done) {
    for (let waited = 0; waited < 30_000 && !done(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
}
const DIR = path.join("Songs", "1 Test - Synthetic");
const RATE_FILE = path.join(DIR, "rate.osu");
const ORIGINAL_FILE = path.join(DIR, "original.osu");
const ORIGINAL = randomChart(7, { seconds: 40 }).replace(/^Version:[^\r\n]*/m, "Version:Insane\r\nTags:test");
const RATE_MAP = rateOsu(ORIGINAL, { rate: 1.2, audioFilename: "audio 1.2x.mp3" });

function memoryCache() {
    const m = new Map();
    return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}

test("a rate map end to end: its own dan at ×1.2, the ladder of its original, the Rate tab on the original", async () => {
    const files = { [RATE_FILE]: RATE_MAP, [ORIGINAL_FILE]: ORIGINAL };
    const readFile = async (file) => { if (!(file in files)) throw new Error("ENOENT"); return files[file]; };
    const rateOrigin = createRateOrigins({
        beatmap: async () => ({ client: "stable", path: RATE_FILE }),
        readFile, readdir: async () => ["rate.osu", "original.osu", "audio 1.2x.mp3"],
    });
    const analysis = { analyzeQueued: (text, rate) => analyzeChart(text, rate), enqueue: async () => ({ kind: "fail" }) };
    const details = createDetailsService({ analysis, worker: {}, cache: memoryCache(), send: () => {}, setTimer: () => 0, clearTimer: () => {} });
    const views = [];
    const controller = createSelectionController({
        fetchOsu: async () => RATE_MAP, analyze: (text, rate) => analyzeChart(text, rate), cache: memoryCache(),
        onView: (v) => views.push(v), onResult: (r) => details.onResult(r), rateOrigin,
    });
    controller.onFrame({ state: "songselect", checksum: "md5-of-rate-map", rate: 1, mods: [] });
    await until(() => views.at(-1)?.screen === "result");
    const view = views.at(-1);
    const own = await analyzeChart(RATE_MAP, 1);
    assert.equal(view.result.numeric, own.numeric, "the card's dan is the file's own, as before");
    assert.equal(view.result.label, own.label);
    assert.equal(view.result.rate, 1.2);
    assert.deepEqual(view.rateMap, { rate: 1.2, virtual: false });

    // the panel, its ladder open, asking main's service for the other rates
    const asked = [];
    const dom = fakeDom({ analysisRate: (key, rate) => { asked.push(rate); return details.rate({ key, rate }); } }, { storage: { "analysis-extras": JSON.stringify({ ladderOpen: true }) } });
    const timers = [];
    const panel = createAnalysisPanel({
        card: dom.$("card"), profile: { getProfile: () => ({ state: "idle" }), onProfile: () => () => {}, ensureProfile: async () => {} },
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
    });
    panel.html(view);
    timers.shift()();
    await until(() => panel.state.ladder.size >= LADDER_RATES.length);
    assert.equal(panel.state.ladder.size, LADDER_RATES.length);
    assert.deepEqual(asked.slice(0, 2), [1, 1.2], "the now row is the original's too: asked right after 1.0");
    const html = panel.html(view);
    assert.match(html, /class="an-lrow an-lnow" data-rate="1\.2"/, "now at ×1.2");
    const rowNumber = (rate) => Number(new RegExp(`data-rate="${rate}"[^>]*>.*?<span class="an-lnum">([\\d.]+)</span>`).exec(html)?.[1]);
    // this chart's rate map at 1.0 has another dan than its original at ×1.2: the now row is the original's, as the
    // Rate tab its click opens (and as the 1.0 row the deltas are from); the card keeps the file's own
    const originalNow = await analyzeChart(ORIGINAL, 1.2);
    assert.notEqual(originalNow.numeric, own.numeric);
    assert.equal(rowNumber(1.2), originalNow.numeric, "the now row is the original at ×1.2");
    // the other rows are the original's: its 1.0 row is the original at 1.0, the 1.5 row the original at 1.5
    assert.equal(rowNumber(1), (await analyzeChart(ORIGINAL, 1)).numeric);
    assert.equal(rowNumber(1.5), (await analyzeChart(ORIGINAL, 1.5)).numeric);
    assert.notEqual(rowNumber(1), (await analyzeChart(RATE_MAP, 1)).numeric, "not the rate map at 1.0");

    // a click on the 1.3 row: the Rate tab at ×1.3 on the original difficulty from the folder, never the rate map
    const row = { dataset: { rate: "1.3" }, parentElement: dom.$("card") };
    await fire(dom.$("card"), "click", { target: { dataset: {}, parentElement: row } });
    assert.deepEqual(dom.events.map((e) => [e.type, e.detail]), [["open-rate", { rate: 1.3 }]]);
    const previewed = [];
    const handlers = createRateHandlers({
        beatmapPath: async () => RATE_FILE, beatmap: async () => ({ client: "stable", path: RATE_FILE }), readText: readFile,
        stat: async () => ({ mtimeMs: 1 }), analysis: { analyze: async (text, rate) => { previewed.push([text, rate]); return { kind: "ok" }; } },
        rateMap: () => controller.rateMap(), log: () => {},
    });
    const info = await handlers.info();
    assert.equal(info.info.version, "Insane");
    assert.match(info.origin.version, /^Insane 1\.2x \(\d+bpm\)$/);
    assert.deepEqual(info.origin, { rate: 1.2, virtual: false, mirror: false, noLn: false, version: info.origin.version });
    assert.equal(info.key, `${ORIGINAL_FILE}|1`);
    await handlers.preview(1.3);
    assert.deepEqual(previewed, [[ORIGINAL, 1.3]]);
    // the now row's click: the Rate tab's dan at ×1.2 is the one the row shows
    const real = createRateHandlers({
        beatmapPath: async () => RATE_FILE, beatmap: async () => ({ client: "stable", path: RATE_FILE }), readText: readFile,
        stat: async () => ({ mtimeMs: 1 }), analysis: { analyze: (text, rate) => analyzeChart(text, rate) },
        rateMap: () => controller.rateMap(), log: () => {},
    });
    assert.equal((await real.preview(1.2)).numeric, rowNumber(1.2));
});

test("DT taking a rate map past the ladder: the card shows the file as it is, the ladder and the Rate tab keep the original", async () => {
    const rateFile = path.join(DIR, "A - T (M) [Hard 1.5x (270bpm)].osu");
    const originalFile = path.join(DIR, "A - T (M) [Hard].osu");
    const views = [];
    const controller = createSelectionController({
        fetchOsu: async () => "rate-map", analyze: async (text, rate) => ({ kind: "ok", text, rate }), cache: memoryCache(), onView: (v) => views.push(v),
        rateOrigin: async () => ({ rate: 1.5, text: "original", virtual: false, path: originalFile, file: rateFile, client: "stable", mirror: false, noLn: false }),
    });
    const made = [];
    const handlers = createRateHandlers({
        beatmapPath: async () => rateFile, beatmap: async () => ({ client: "stable", path: rateFile }),
        readText: async (f) => (f === originalFile ? "Mode: 3\nOriginal" : "Mode: 3\nRateMap"), stat: async () => ({ mtimeMs: 1 }),
        analysis: { analyze: async () => ({ kind: "ok" }), analyzeQueued: async () => ({ kind: "ok" }) },
        createRateMap: async (req) => { made.push(req.beatmapPath); return { osuPath: "x.osu", version: "v", reusedAudio: false }; },
        ffmpegPath: async () => "ffmpeg", progress: () => {}, log: () => {}, rateMap: () => controller.rateMap(),
    });
    controller.onFrame({ state: "songselect", checksum: "c", rate: 1, mods: [] });
    await until(() => views.at(-1)?.screen === "result");
    assert.equal((await handlers.info()).key, `${originalFile}|1`, "no mods: the original");
    controller.onFrame({ state: "songselect", checksum: "c", rate: 1.5, mods: ["DT"] });
    await flush();
    await until(() => views.at(-1)?.screen === "result");
    assert.equal(views.at(-1).result.rate, 1.5, "2.25 is past the ladder: the card shows the file at the mods' rate");
    assert.deepEqual(views.at(-1).rateMap, { rate: 1.5, virtual: false, beyond: true }, "the ladder: the original's rows, none marked");
    const info = await handlers.info();
    assert.equal(info.key, `${originalFile}|1`, "DT on: still the original");
    assert.equal(info.origin.rate, 1.5);
    await handlers.create({ rate: 1.2, pitch: false });
    assert.deepEqual(made, [originalFile], "a copy of the original, never of the sped-up file");
});
