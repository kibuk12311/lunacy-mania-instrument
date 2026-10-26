// The overlay's Dan widget: only the map's overall dan out of the box (0.9.6's dan along the map and "now" are gone),
// the words it shows in both languages, the payload main builds (states, "for you", recording), its settings, size
// and the migration of 0.9.6's file, the main-side source (the card's result reused, one analysis per map and rate,
// retries), the widget's DOM, and the manager feeding it for osu! stable, lazer and Interlude.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as danModule from "../src/overlay/dan.js";
import * as drawModule from "../src/overlay/draw.js";
import {
    buildDanPayload, cleanSkill, danHead, danKey, danStateOf, danStateText,
    danView, forYouText, patternText, playDanOf, playText, signedDan, confidenceText,
} from "../src/overlay/dan.js";
import { fakeDan, fakeSnapshot } from "../src/overlay/fake.js";
import {
    SETTINGS_VERSION, SHOW, SHOW_OFF, WIDGETS, applyPatch, migrateOverlaySettings, normalizeOverlaySettings, placeWidget, widgetSize,
} from "../src/overlay/settings.js";
import { createDanSource, makeDanAnalyzer, overlayChecksum, RETRY_MS } from "../app/overlay/danSource.js";
import { createOverlay, loadOverlaySettings, OVERLAY_CHANNELS } from "../app/overlay/overlayManager.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { makeChart } from "./fixtures/makeChart.js";
import { fakeDom, textOf } from "./helpers/fakeDom.js";

const inLang = (lang, fn) => {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};
const OK = { kind: "ok", numeric: 13, label: "Gamma mid", primary: "Jumpstream", tech: false, confidenceLevel: "high", halfWidth: 0.3, durationSec: 100, rate: 1 };
const flush = () => new Promise((r) => setImmediate(r));

// ---- only the overall dan ----

test("no dan along the map any more: the strain estimate, the playhead and its line are gone from the widget's code", () => {
    for (const name of ["sectionDans", "danAt", "danProgress", "nowText", "SECTION_SLOPE", "BREAK_STRAIN"]) assert.equal(name in danModule, false, name);
    assert.equal("danSparkGeometry" in drawModule, false);
    assert.equal(t("overlay.dan.now"), "overlay.dan.now", "its words are gone too");
});

test("the play's own dan: the local profile's model on the results' judgements; nothing without a dan or judgements", () => {
    const payload = { state: "ok", numeric: 13 };
    // 96.5% is full credit: 0.965 × 300 × n of 300s and 200s mixed → about 13
    const hits = { max: 790, n300: 0, n200: 210, n100: 0, n50: 0, miss: 0 }; // 93.0%
    assert.ok(Math.abs(playDanOf(payload, hits) - (13 - 3.5 * 0.2)) < 0.05);
    assert.equal(playDanOf(payload, { max: 1000, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }), 13.25, "near perfect: at most +0.25");
    assert.equal(playDanOf(payload, hits, ["AT"]), null, "autoplay is no play of yours");
    assert.equal(playDanOf(payload, { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }), null);
    assert.equal(playDanOf({ state: "counting" }, hits), null);
});

// ---- words ----

test("the words: label and number, past Kappa, the states, for you, this play — Russian and English", () => {
    assert.deepEqual(danHead(13), { number: "13.0", label: "Gamma mid", line: "Gamma mid · 13.0" });
    assert.deepEqual(danHead(12.8), { number: "12.8", label: "Gamma low/mid", line: "Gamma low/mid · 12.8" });
    assert.deepEqual(danHead(21.3), { number: "21.3", label: "выше Kappa", line: "выше Kappa · 21.3" });
    assert.equal(inLang("en", () => danHead(21.3).line), "above Kappa · 21.3");
    assert.equal(danHead(null).line, "—");
    assert.equal(signedDan(0.8), "+0.8");
    assert.equal(signedDan(-0.34), "−0.3");
    assert.equal(signedDan(0.01), "±0.0");
    assert.equal(forYouText({ delta: 0.8 }), "+0.8 к твоему уровню");
    assert.equal(inLang("en", () => forYouText({ delta: -1.2 })), "−1.2 vs your level");
    assert.equal(forYouText(null), "");
    assert.equal(playText(12.8), "эта игра: Gamma low/mid");
    assert.equal(inLang("en", () => playText(21.4)), "this play: above Kappa · 21.4");
    assert.equal(playText(null), "");
    assert.equal(confidenceText("high"), "уверенность: высокая");
    assert.equal(inLang("en", () => confidenceText("low")), "confidence: low");
    assert.equal(patternText({ primary: "Jumpstream" }), "Jumpstream");
    assert.equal(patternText({ primary: "Jacks", tech: true }), "Jacks · tech");
    assert.equal(patternText({}), "");
    const ru = { counting: "считаем…", notMania: "не mania", not4k: "не 4K", ln: "LN-карта, без дана", short: "слишком короткая", none: "нет оценки" };
    const en = { counting: "working out…", notMania: "not mania", not4k: "not 4K", ln: "LN map, no dan", short: "too short", none: "no estimate" };
    for (const [state, text] of Object.entries(ru)) assert.equal(danStateText(state), text);
    for (const [state, text] of Object.entries(en)) assert.equal(inLang("en", () => danStateText(state)), text);
    assert.equal(danStateText("ok"), "");
});

test("the analysis result's state: a dan, not mania, not 4K, LN, too short, an error", () => {
    assert.equal(danStateOf(null), "counting");
    assert.equal(danStateOf(OK), "ok");
    assert.equal(danStateOf({ kind: "not-rice", reason: "mode" }), "notMania");
    assert.equal(danStateOf({ kind: "not-rice", reason: "keys", keys: 7 }), "not4k");
    assert.equal(danStateOf({ kind: "not-rice", reason: "ln", keys: 4 }), "ln");
    assert.equal(danStateOf({ kind: "too-short" }), "short");
    assert.equal(danStateOf({ kind: "error", message: "x" }), "none");
});

// ---- the payload ----

test("payload: keyed by map and rate; the card's numbers, pattern, confidence, the fit, recording — no line", () => {
    assert.equal(danKey("abc", 1), "abc|1.00");
    assert.equal(danKey("abc", 1.2000001), "abc|1.20");
    assert.equal(danKey("abc", 0), "abc|1.00");
    const entry = { result: { ...OK, msd: null } };
    const skill = cleanSkill({ overall: 12.6, tiles: { stamina: 12.2, jack: 11, speed: null, tech: "x" }, msd: { Jumpstream: 25.1 }, junk: 1 });
    assert.deepEqual(skill, { overall: 12.6, tiles: { stamina: 12.2, jack: 11 }, msd: { Jumpstream: 25.1 } });
    const p = buildDanPayload({ checksum: "abc", rate: 1.2, mode: 3, entry, skill, recording: true });
    assert.equal(p.key, "abc|1.20");
    assert.equal(p.state, "ok");
    assert.equal(p.numeric, 13);
    assert.equal(p.primary, "Jumpstream");
    assert.equal(p.confidenceLevel, "high");
    for (const gone of ["sections", "firstMs", "lastMs"]) assert.equal(gone in p, false, gone);
    assert.deepEqual(p.fit, { delta: 0.8, playerDan: 12.2, band: "challenge", source: "tile", tile: "stamina" }, "Jumpstream is under the Stamina tile");
    assert.equal(p.recording, true);
    // no profile, recording off
    const bare = buildDanPayload({ checksum: "abc", rate: 1, entry });
    assert.equal(bare.fit, null);
    assert.equal(bare.recording, false);
    // the states without a dan carry only the key
    assert.deepEqual(buildDanPayload({ checksum: "abc", rate: 1, entry: null }), { key: "abc|1.00", checksum: "abc", rate: 1, state: "counting" });
    assert.equal(buildDanPayload({ checksum: "abc", mode: 0, entry }).state, "notMania", "osu!standard: no analysis wanted");
    assert.equal(buildDanPayload({ checksum: "abc", entry: { result: { kind: "not-rice", reason: "keys", keys: 7 } } }).state, "not4k");
    assert.equal(buildDanPayload({ checksum: "abc", mode: null, entry }).state, "ok", "Interlude tells no mode: mania");
    assert.equal(cleanSkill(null), null);
    assert.equal(cleanSkill({ tiles: {} }), null);
});

test("danView: the widget's lines while playing, on the results screen, and for a map still being worked out", () => {
    const payload = buildDanPayload({
        checksum: "abc", rate: 1, entry: { result: OK },
        skill: { overall: 12.5, tiles: { stamina: 12.2 } }, recording: true,
    });
    const playing = danView(payload, { phase: "playing", clock: 2000, hits: { max: 10, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(playing.line, "Gamma mid · 13.0");
    assert.equal(playing.pattern, "Jumpstream");
    for (const gone of ["now", "nowDan", "progress"]) assert.equal(gone in playing, false, gone);
    assert.equal(playing.forYou, "+0.8 к твоему уровню");
    assert.equal(playing.band, "challenge");
    assert.equal(playing.play, "", "the play's own dan waits for the results screen");
    const results = danView(payload, { phase: "results", clock: 2000, hits: { max: 1000, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(results.play, "эта игра: Gamma mid/high");
    assert.equal(results.playDan, 13.25);
    const off = danView({ ...payload, recording: false }, { phase: "results", hits: { max: 10, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(off.play, "", "recording off: no play dan");
    const counting = danView({ state: "counting" }, { phase: "playing", clock: 0 });
    assert.equal(counting.label, "считаем…");
    assert.equal(counting.number, "—");
});

// ---- settings ----

test("settings: the Dan widget's defaults are the overall dan alone; its size follows its lines; an overlay.json from before it gets it", async () => {
    assert.ok(WIDGETS.includes("dan"));
    const d = normalizeOverlaySettings(null);
    assert.equal(d.v, SETTINGS_VERSION);
    assert.deepEqual(d.widgets.dan, {
        enabled: true, style: "card", opacity: 1, scale: 1, x: null, y: null,
        show: { map: true, pattern: false, forYou: false, play: false },
    });
    assert.deepEqual(SHOW.dan, ["map", "pattern", "forYou", "play"]);
    assert.deepEqual(SHOW_OFF.dan, ["pattern", "forYou", "play"]);
    // the other widgets' lines stay on by default
    assert.ok(Object.values(d.widgets.judgements.show).every(Boolean));
    // the overall dan alone: a small window; each extra line one row more (compact: wider)
    assert.deepEqual(widgetSize("dan", "card", 1, d.widgets.dan.show), { width: 220, height: 64 });
    assert.deepEqual(widgetSize("dan", "card", 1, { map: true, pattern: true, forYou: true, play: false }), { width: 220, height: 104 });
    assert.deepEqual(widgetSize("dan", "card"), { width: 220, height: 124 }, "without lines told: room for all");
    assert.deepEqual(widgetSize("dan", "compact", 1.5, d.widgets.dan.show), { width: 345, height: 60 });
    assert.deepEqual(widgetSize("dan", "compact", 1, { pattern: true }), { width: 390, height: 40 });
    const placed = placeWidget("dan", d, [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]);
    assert.deepEqual([placed.width, placed.height], [220, 64]);
    assert.ok(placed.y + placed.height <= 1080 && placed.x >= 0);
    // 0.9.5's file: four widgets set up, no dan
    const old = {
        enabled: true, showOnResults: false,
        widgets: {
            judgements: { enabled: false, style: "neon", opacity: 0.6, scale: 1.2, x: 10, y: 20, show: { ur: false } },
            kps: { style: "compact" }, nps: { enabled: true }, keys: { show: { counts: false } },
        },
    };
    const dir = await mkdtemp(path.join(tmpdir(), "дан-"));
    const file = path.join(dir, "overlay.json");
    await writeFile(file, JSON.stringify(old), "utf8");
    const migrated = loadOverlaySettings(file);
    assert.equal(migrated.enabled, true);
    assert.equal(migrated.showOnResults, false);
    assert.deepEqual(migrated.widgets.judgements, { enabled: false, style: "neon", opacity: 0.6, scale: 1.2, x: 10, y: 20, show: { counts: true, ratio: true, accuracy: true, ur: false } });
    assert.equal(migrated.widgets.kps.style, "compact");
    assert.equal(migrated.widgets.keys.show.counts, false);
    assert.deepEqual(migrated.widgets.dan, d.widgets.dan, "the new widget with its defaults");
    // an extra turned on, a broken one dropped
    const patched = applyPatch(migrated, { widgets: { dan: { show: { forYou: true, nope: true }, style: "minimal", scale: 9 } } });
    assert.equal(patched.widgets.dan.show.forYou, true);
    assert.equal(patched.widgets.dan.show.play, false);
    assert.equal("nope" in patched.widgets.dan.show, false);
    assert.equal(patched.widgets.dan.style, "minimal");
    assert.equal(patched.widgets.dan.scale, 2.5);
    // and kept so: a v2 file is never migrated again
    assert.deepEqual(normalizeOverlaySettings(JSON.parse(JSON.stringify(patched))), patched);
});

test("settings migration from 0.9.6: the line and now dropped; extras never touched go off, a choice made is kept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "дан-096-"));
    let n = 0;
    const load = async (dan) => {
        n += 1;
        const file = path.join(dir, `overlay-${n}.json`);
        await writeFile(file, JSON.stringify({ enabled: true, showOnResults: true, widgets: { dan } }), "utf8");
        return loadOverlaySettings(file).widgets.dan;
    };
    // as 0.9.6 wrote it out of the box: every line on
    const untouched = await load({ enabled: true, style: "neon", opacity: 0.8, scale: 1.3, x: 40, y: 50, show: { map: true, pattern: true, live: true, forYou: true, play: true } });
    assert.deepEqual(untouched, { enabled: true, style: "neon", opacity: 0.8, scale: 1.3, x: 40, y: 50, show: { map: true, pattern: false, forYou: false, play: false } });
    // the line turned off but the extras left as they came: off now
    assert.deepEqual((await load({ show: { map: true, pattern: true, live: false, forYou: true, play: true } })).show, { map: true, pattern: false, forYou: false, play: false });
    // "for you" turned off by hand: the player chose, the rest of their choice kept
    assert.deepEqual((await load({ show: { map: true, pattern: true, live: true, forYou: false, play: true } })).show, { map: true, pattern: true, forYou: false, play: true });
    // the head turned off stays off
    assert.deepEqual((await load({ show: { map: false, pattern: false, live: true, forYou: true, play: true } })).show, { map: false, pattern: false, forYou: true, play: true });
    // no dan widget, or a v2 file: as it is
    assert.deepEqual(migrateOverlaySettings({ widgets: {} }), { widgets: {} });
    const v2 = { v: 2, widgets: { dan: { show: { pattern: true, forYou: true, play: true } } } };
    assert.equal(migrateOverlaySettings(v2), v2);
    assert.equal(migrateOverlaySettings(null), null);
});

test("the made-up Dan payload: shaped like main's, no line, every line turned on shown in a preview", () => {
    const fake = fakeDan();
    const real = buildDanPayload({ checksum: "x", entry: { result: OK }, skill: { overall: 12 }, recording: true });
    assert.deepEqual(Object.keys(fake).filter((k) => k !== "preview").sort(), Object.keys(real).sort());
    assert.equal("sections" in fake, false);
    const snap = fakeSnapshot(100_000);
    const v = danView(snap.dan, snap);
    assert.equal(v.line, "Gamma mid · 13.0");
    assert.equal(v.forYou, "+0.8 к твоему уровню");
    assert.ok(v.play.startsWith("эта игра: "), "the preview shows the play's dan too");
});

// ---- the widget's DOM ----

test("the Dan widget's DOM: the overall dan alone by default, extras when asked, no line or canvas; states in words", async () => {
    fakeDom();
    const { mountWidget, danPayloadFor } = await import("../app/overlay/render.js");
    const payload = buildDanPayload({ checksum: "m", rate: 1.2, entry: { result: OK }, skill: { overall: 12.2 }, recording: true });
    assert.equal(danPayloadFor({ checksum: "m", rate: 1.2 }, payload), payload);
    assert.equal(danPayloadFor({ checksum: "m", rate: 1 }, payload), null, "another rate: still counting");
    assert.equal(danPayloadFor({ checksum: "other", rate: 1.2 }, payload), null);
    const fake = fakeSnapshot(0);
    assert.equal(danPayloadFor(fake, payload), fake.dan, "a made-up snapshot brings its own");

    const root = document.createElement("div");
    const all = Object.fromEntries(SHOW.dan.map((k) => [k, true]));
    const view = mountWidget(root, "dan", { style: "card", show: all, dan: payload });
    assert.equal(root.className, "ov ov-dan style-card");
    view.update({ phase: "playing", checksum: "m", rate: 1.2, clock: 500, hits: null, mods: [] });
    const text = textOf(root);
    for (const part of ["13.0", "Gamma mid", "уверенность: высокая", "Jumpstream", "+0.8 к твоему уровню"]) {
        assert.ok(text.includes(part), `${part} in ${text}`);
    }
    assert.ok(!text.includes("сейчас"), "no now");
    view.paint(500); // nothing to draw
    view.update({ phase: "results", checksum: "m", rate: 1.2, clock: 900, hits: { max: 1000, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, mods: [] });
    const box = root.children[0];
    assert.deepEqual(box.children.map((n) => n.className), ["d-head", "d-pattern", "d-play", "d-fit band-challenge"], "no line, no canvas");
    const play = box.children.find((n) => n.className === "d-play");
    assert.equal(play.textContent, "эта игра: Gamma mid/high");
    view.update({ phase: "playing", checksum: "n", rate: 1, clock: 0 });
    assert.equal(box.dataset.state, "counting");
    assert.ok(textOf(root).includes("считаем…"));

    // out of the box: the overall dan alone, without its confidence; an old "live" asks for nothing
    const few = document.createElement("div");
    const fewView = mountWidget(few, "dan", { style: "compact", show: { ...normalizeOverlaySettings(null).widgets.dan.show, live: true }, dan: payload });
    fewView.update({ phase: "playing", checksum: "m", rate: 1.2, clock: 500, hits: null, mods: [] });
    assert.deepEqual(few.children[0].children.map((n) => n.className), ["d-head"]);
    assert.ok(textOf(few).includes("13.0") && textOf(few).includes("Gamma mid") && !textOf(few).includes("уверенность"));
    const above = document.createElement("div");
    const aboveView = mountWidget(above, "dan", { style: "card", show: { map: true }, dan: { ...payload, numeric: 21.3 } });
    aboveView.update({ phase: "playing", checksum: "m", rate: 1.2, clock: 0 });
    assert.ok(textOf(above).includes("21.3") && textOf(above).includes("выше Kappa"), "past Kappa: the number and the words");
    setLang("en");
    try {
        const en = document.createElement("div");
        const v = mountWidget(en, "dan", { style: "neon", show: all, dan: null });
        v.update({ phase: "playing", checksum: "q", rate: 1, clock: 0, mode: 3 });
        assert.ok(textOf(en).includes("working out…"));
    } finally {
        setLang("ru");
    }
});

// ---- the main-side source ----

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

test("source: one analysis per map and rate however often it is asked; retried after a failure", async () => {
    const text = makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 });
    const calls = [];
    const gate = deferred();
    let clock = 0;
    const changed = [];
    const source = createDanSource({
        analyze: async (req) => {
            calls.push(req);
            await gate.promise;
            return { result: { ...OK, rate: req.rate, durationSec: 60 } };
        },
        now: () => clock,
        onChange: (k) => changed.push(k),
    });
    let fetched = 0;
    const getText = async () => { fetched += 1; return text; };
    const key = source.want("m1", 1.2, { text: getText });
    for (let i = 0; i < 20; i += 1) source.want("m1", 1.2, { text: getText });
    assert.equal(key, "m1|1.20");
    assert.equal(source.stateOf(key), "counting");
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(fetched, 1);
    gate.resolve();
    await flush();
    await flush();
    const e = source.get(key);
    assert.equal(e.state, "done");
    assert.equal(e.result.numeric, 13);
    assert.equal("sections" in e, false);
    assert.ok(changed.includes(key));
    // another rate is another map
    source.want("m1", 1, { text: getText });
    await flush();
    assert.equal(calls.length, 2);

    // a map whose file can't be had: failed, asked again only after RETRY_MS
    const failing = createDanSource({ analyze: async () => ({ result: OK }), now: () => clock });
    let tries = 0;
    const none = async () => { tries += 1; return null; };
    failing.want("x", 1, { text: none });
    await flush();
    assert.equal(failing.get("x|1.00").state, "failed");
    failing.want("x", 1, { text: none });
    await flush();
    assert.equal(tries, 1);
    clock += RETRY_MS;
    failing.want("x", 1, { text: none });
    await flush();
    assert.equal(tries, 2);
    // no analyser at all: no estimate, said once
    const bare = createDanSource({});
    bare.want("y", 1, { text: "x" });
    await flush();
    assert.equal(bare.stateOf("y|1.00"), "none");
});

test("source: the card's result is kept under the overlay's key at once, no analysis of its own", async () => {
    const text = makeChart({ kind: "stream", bpm: 170, seconds: 60 });
    const seen = [];
    const source = createDanSource({ analyze: async (req) => { seen.push(req); return { result: req.result }; } });
    assert.equal(overlayChecksum("external:HASH"), "interlude:HASH");
    assert.equal(overlayChecksum("md5"), "md5");
    source.fromCard({ checksum: "external:HASH", text, rate: 1.25, result: OK, key: "k" });
    const key = danKey("interlude:HASH", 1.25);
    assert.equal(source.stateOf(key), "ok", "the card's dan at once");
    assert.equal(source.get(key).result, OK);
    // the same again: nothing more to do; a transient error from the card is no result
    const version = source.get(key).version;
    source.fromCard({ checksum: "external:HASH", text, rate: 1.25, result: OK });
    source.fromCard({ checksum: "abc", text, rate: 1, result: { kind: "error", transient: true } });
    await flush();
    assert.equal(seen.length, 0);
    assert.equal(source.get(key).version, version);
    assert.equal(source.get(danKey("abc", 1)), null);
    // a play wanting it later finds it
    assert.equal(source.want("interlude:HASH", 1.25, { text }), key);
    await flush();
    assert.equal(seen.length, 0);
    // a few maps kept, the oldest go
    const small = createDanSource({ analyze: async () => ({ result: OK }), keep: 2 });
    for (const c of ["a", "b", "c"]) small.want(c, 1, { text });
    await flush();
    assert.equal(small.get("a|1.00"), null);
    assert.ok(small.get("c|1.00"));
});

test("the analyser: the card's result as it is, else the shared cache or the worker's background line", async () => {
    const text = makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 });
    const jobs = [];
    const analysis = { analyzeQueued: async (tx, rate) => { jobs.push(rate); return { ...OK, rate }; } };
    const analyze = makeDanAnalyzer({ analysis });
    const first = await analyze({ text, rate: 1.1 });
    assert.equal(first.result.numeric, 13);
    assert.deepEqual(Object.keys(first), ["result"], "no details: no line to make");
    const again = await analyze({ text, rate: 1.1, result: OK });
    assert.equal(again.result, OK);
    assert.deepEqual(jobs, [1.1]);
    const notRice = await makeDanAnalyzer({ analysis: { analyzeQueued: async () => ({ kind: "not-rice", reason: "keys" }) } })({ text, rate: 1 });
    assert.deepEqual(notRice, { result: { kind: "not-rice", reason: "keys" } });
});

// ---- the manager: osu! stable, lazer, Interlude ----

function fakeElectron() {
    const windows = [];
    class BrowserWindow {
        constructor(options) {
            this.options = options;
            this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
            this.sent = [];
            this.destroyed = false;
            this.webContents = { send: (c, p) => this.sent.push([c, p]), on: () => {}, reload: () => {} };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
        loadFile(file, opts) { this.query = opts?.query; }
        on() {}
        setAlwaysOnTop() {}
        setIgnoreMouseEvents() {}
        setFocusable() {}
        setMenu() {}
        setTitle() {}
        showInactive() {}
        show() {}
        hide() {}
        focus() {}
        getPosition() { return [0, 0]; }
        setBounds() {}
    }
    const handled = new Map();
    const listened = new Map();
    const ipcMain = { handle: (c, fn) => handled.set(c, fn), on: (c, fn) => listened.set(c, fn) };
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const screen = { getPrimaryDisplay: () => display, getAllDisplays: () => [display] };
    return { electron: { BrowserWindow, ipcMain, globalShortcut: { register: () => true, unregister: () => {} }, screen }, windows, listened };
}

// a WebSocket stand-in for tosu: frames pushed by the test to every /websocket/v2 socket
function fakeSockets() {
    const sockets = [];
    class FakeSocket {
        constructor(url) {
            this.url = url;
            this.listeners = {};
            sockets.push(this);
            setImmediate(() => this.fire("open", {}));
        }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        fire(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
        close() {}
    }
    const send = (json) => {
        for (const s of sockets) if (s.url.endsWith("/websocket/v2")) s.fire("message", { data: JSON.stringify(json) });
    };
    return { FakeSocket, send };
}

const tosuJson = ({ state = 2, checksum = "m1", live = 2000, mode = 3, mods = { rate: 1 }, client, hits = {} }) => ({
    ...(client ? { client } : {}),
    state: { number: state },
    beatmap: { checksum, time: { live }, mode: { number: mode } },
    play: { mode: { number: mode }, hits: { geki: 0, "300": 0, katu: 0, "100": 0, "50": 0, "0": 0, ...hits }, mods },
});

const danConfigs = (windows) => windows.find((w) => w.query?.w === "dan")?.sent.filter(([c]) => c === "overlay-config").map(([, p]) => p.dan) ?? [];

async function withOverlay(options, fn) {
    const fake = fakeElectron();
    const ws = fakeSockets();
    const userData = await mkdtemp(path.join(tmpdir(), "дан-оверлей-"));
    const calls = [];
    const overlay = createOverlay({
        electron: fake.electron, userData, port: 1, t, WebSocketImpl: ws.FakeSocket,
        fetchImpl: async () => ({ ok: true, text: async () => options.text ?? makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 }) }),
        danAnalyze: async (req) => {
            calls.push(req);
            return options.analyze ? options.analyze(req) : { result: { ...OK, rate: req.rate, durationSec: 60 } };
        },
        recording: async () => options.recording ?? true,
        interludeText: async (hash) => (options.interlude ? options.interlude(hash) : null),
        ...options.extra,
    });
    try {
        overlay.apply({ enabled: true });
        overlay.setEdit(true); // every window made at once
        await flush();
        await fn({ overlay, fake, ws, calls, configs: () => danConfigs(fake.windows) });
    } finally {
        overlay.dispose();
    }
}

const settle = async () => {
    for (let i = 0; i < 6; i += 1) await flush();
};

test("manager, osu! stable: the play's map analysed once, its dan sent with the Dan widget's config; the profile and the rate", async () => {
    await withOverlay({}, async ({ overlay, ws, calls, configs, fake }) => {
        assert.ok(OVERLAY_CHANNELS.on.includes("overlay-profile"));
        for (let live = 1000; live < 2000; live += 100) ws.send(tosuJson({ live }));
        await settle();
        assert.equal(calls.length, 1, "one analysis for the whole play");
        assert.equal(calls[0].rate, 1);
        const last = configs().at(-1);
        assert.equal(last.key, "m1|1.00");
        assert.equal(last.state, "ok");
        assert.equal(last.numeric, 13);
        assert.equal("sections" in last, false);
        assert.equal(last.fit, null, "no profile yet");
        assert.equal(last.recording, true);
        const sentBefore = configs().length;
        ws.send(tosuJson({ live: 2100 }));
        await settle();
        assert.equal(configs().length, sentBefore, "nothing new: nothing sent");
        // the main window tells the profile in use: "for you" comes
        fake.listened.get("overlay-profile")(null, { skill: { overall: 12, tiles: { stamina: 12.2 } } });
        assert.deepEqual(configs().at(-1).fit, { delta: 0.8, playerDan: 12.2, band: "challenge", source: "tile", tile: "stamina" });
        // the results screen keeps the play's map
        ws.send(tosuJson({ state: 7, live: 2100, hits: { geki: 50 } }));
        await settle();
        assert.equal(configs().at(-1).key, "m1|1.00");
        // the same map again with DT (stable's 1.5): another key, one more analysis
        ws.send(tosuJson({ state: 5, live: 0 }));
        ws.send(tosuJson({ state: 2, live: 1000, mods: { name: "DT", rate: 1 } }));
        await settle();
        assert.equal(calls.length, 2);
        assert.equal(calls[1].rate, 1.5);
        assert.equal(configs().at(-1).key, "m1|1.50");
        // osu!standard: no analysis, "not mania"
        ws.send(tosuJson({ state: 2, checksum: "std", mode: 0, live: 500 }));
        await settle();
        assert.equal(calls.length, 2);
        assert.equal(configs().at(-1).state, "notMania");
    });
});

test("manager, osu! lazer: lazer's own speed is the rate; a not-4K map says so; the card's result is used as it is", async () => {
    await withOverlay({
        analyze: (req) => (req.result ? { result: req.result } : { result: { kind: "not-rice", reason: "keys", keys: 7 } }),
    }, async ({ overlay, ws, calls, configs }) => {
        // the card had this map at 1.2 (lazer's DT speed)
        overlay.onCardResult({ checksum: "lz", text: makeChart({ kind: "stream", seconds: 60 }), rate: 1.2, result: OK, key: "k" });
        await settle();
        const dt = { name: "DT", array: [{ acronym: "DT", settings: { speed_change: 1.2 } }], rate: 1.2 };
        for (let live = 1000; live < 1500; live += 100) ws.send(tosuJson({ client: "lazer", checksum: "lz", live, mods: dt }));
        await settle();
        assert.equal(calls.length, 0, "the card's result: no new analysis");
        assert.equal(configs().at(-1).key, "lz|1.20");
        assert.equal(configs().at(-1).state, "ok");
        assert.equal(configs().at(-1).numeric, 13);
        // a 7K map
        ws.send(tosuJson({ client: "lazer", checksum: "7k", live: 1000, mods: { rate: 1 } }));
        await settle();
        assert.equal(configs().at(-1).state, "not4k");
    });
});

test("manager, Interlude: the library chart's text analysed once; recording off keeps the play dan away", async () => {
    const asked = [];
    await withOverlay({
        recording: false,
        interlude: (hash) => { asked.push(hash); return makeChart({ kind: "jumpstream", bpm: 160, seconds: 60 }); },
    }, async ({ overlay, calls, configs }) => {
        const line = (timeMs, playId = 1, screen = "play") => ({
            client: "interlude", screen, chart: { hash: "HASH1", rate: 1.25, keys: 4 },
            play: screen === "play" ? { playId, timeMs, rate: 1.25, hits: { MARVELLOUS: 0, PERFECT: 0, GREAT: 0, GOOD: 0, BAD: 0, MISS: 0 }, events: [] } : null,
        });
        for (let ms = 0; ms < 600; ms += 100) overlay.onInterlude(line(ms));
        await settle();
        assert.deepEqual(asked, ["HASH1"]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].rate, 1.25);
        const p = configs().at(-1);
        assert.equal(p.key, "interlude:HASH1|1.25");
        assert.equal(p.state, "ok");
        assert.equal(p.recording, false);
        // a retry (a new play id): the same map, nothing worked out again
        for (let ms = 0; ms < 300; ms += 100) overlay.onInterlude(line(ms, 2));
        await settle();
        assert.equal(calls.length, 1);
        // the score screen keeps it
        overlay.onInterlude(line(0, 2, "score"));
        await settle();
        assert.equal(configs().at(-1).key, "interlude:HASH1|1.25");
    });
});

test("manager: the Dan widget turned off asks for nothing; while its analysis runs it says it is counting", async () => {
    const gate = deferred();
    await withOverlay({ analyze: async (req) => { await gate.promise; return { result: { ...OK, rate: req.rate } }; } }, async ({ overlay, ws, calls, configs }) => {
        ws.send(tosuJson({ live: 1000 }));
        await settle();
        assert.equal(configs().at(-1).state, "counting");
        gate.resolve();
        await settle();
        assert.equal(configs().at(-1).state, "ok");
        overlay.apply({ widgets: { dan: { enabled: false } } });
        ws.send(tosuJson({ checksum: "other", live: 1000 }));
        await settle();
        assert.equal(calls.length, 1);
    });
});
