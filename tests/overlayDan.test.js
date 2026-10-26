// The overlay's Dan widget: the dan along the map, the playhead and "now", the words it shows in both languages,
// the payload main builds (states, "for you", recording), the line's geometry, its settings and their migration, the
// main-side source (the card's result reused, one analysis per map and rate, retries), the widget's DOM, and the
// manager feeding it for osu! stable, lazer and Interlude.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BREAK_STRAIN, SECTION_SLOPE, buildDanPayload, cleanSkill, danAt, danHead, danKey, danProgress, danStateOf, danStateText,
    danView, forYouText, nowText, patternText, playDanOf, playText, sectionDans, signedDan, confidenceText,
} from "../src/overlay/dan.js";
import { danSparkGeometry } from "../src/overlay/draw.js";
import { fakeDan, fakeSnapshot } from "../src/overlay/fake.js";
import { SHOW, WIDGETS, applyPatch, normalizeOverlaySettings, placeWidget, widgetSize } from "../src/overlay/settings.js";
import { createDanSource, makeDanAnalyzer, overlayChecksum, RETRY_MS } from "../app/overlay/danSource.js";
import { createOverlay, loadOverlaySettings, OVERLAY_CHANNELS } from "../app/overlay/overlayManager.js";
import { detailsKey } from "../app/analysisDetails.js";
import { cacheKey } from "../src/core/cache.js";
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

// ---- the dan along the map ----

test("sections: a flat map is its dan all along; harder and easier parts move by the log of the strain; breaks are null", () => {
    assert.deepEqual(sectionDans([1, 1, 1, 1], 13), [13, 13, 13, 13]);
    const s = sectionDans([0, 0.8, 1, 1, 1, 1, 1, 1, 1, 1, 0.02], 13);
    assert.equal(s[0], null, "an empty bin is a break");
    assert.equal(s.at(-1), null, `under ${BREAK_STRAIN} of the peak is a break`);
    assert.equal(s[1], Math.round((13 + SECTION_SLOPE * Math.log(0.8)) * 10) / 10, "0.8 of the hard part's strain");
    assert.equal(s[1], 9.9);
    assert.equal(s[2], 13, "the hard part is the map's dan");
    // never more than 2 over, 8 under, never below 0
    assert.equal(sectionDans([0.1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 13)[0], 5);
    assert.equal(sectionDans([0.1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3)[0], 0);
    assert.equal(Math.max(...sectionDans([1, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6], 10)), 12);
    assert.equal(sectionDans([], 13), null);
    assert.equal(sectionDans([1, 1], null), null);
    assert.equal(sectionDans([0, 0], 13), null, "all breaks: no line");
});

test("progress and the dan at the play position: first to last note, smoothed over ±2 sections, a break says so", () => {
    const payload = { firstMs: 1000, lastMs: 11_000 };
    assert.equal(danProgress(payload, 0), 0);
    assert.equal(danProgress(payload, 6000), 0.5);
    assert.equal(danProgress(payload, 20_000), 1);
    assert.equal(danProgress({}, 5000), 0);
    const sections = [10, 10, 10, 12, 14, 14, 14, null, 14];
    assert.equal(danAt(sections, 0), 10);
    assert.equal(danAt(sections, 0.5), 12.8, "the mean of 10, 12, 14, 14, 14");
    assert.equal(danAt(sections, 7 / 8), null, "in a break");
    assert.equal(danAt([], 0.5), null);
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

test("the words: label and number, past Kappa, the states, now, for you, this play — Russian and English", () => {
    assert.deepEqual(danHead(13), { number: "13.0", label: "Gamma mid", line: "Gamma mid · 13.0" });
    assert.deepEqual(danHead(12.8), { number: "12.8", label: "Gamma low/mid", line: "Gamma low/mid · 12.8" });
    assert.deepEqual(danHead(21.3), { number: "21.3", label: "выше Kappa", line: "выше Kappa · 21.3" });
    assert.equal(inLang("en", () => danHead(21.3).line), "above Kappa · 21.3");
    assert.equal(danHead(null).line, "—");
    assert.equal(signedDan(0.8), "+0.8");
    assert.equal(signedDan(-0.34), "−0.3");
    assert.equal(signedDan(0.01), "±0.0");
    assert.equal(nowText(13.2), "сейчас: Gamma mid/high");
    assert.equal(nowText(null), "сейчас: перерыв");
    assert.equal(inLang("en", () => nowText(15.4)), "now: Epsilon high");
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

test("payload: keyed by map and rate; the card's numbers, pattern, confidence, the line, the fit, recording", () => {
    assert.equal(danKey("abc", 1), "abc|1.00");
    assert.equal(danKey("abc", 1.2000001), "abc|1.20");
    assert.equal(danKey("abc", 0), "abc|1.00");
    const entry = { result: { ...OK, msd: null }, sections: [12, 13, null], firstMs: 1000, lastMs: 101_000 };
    const skill = cleanSkill({ overall: 12.6, tiles: { stamina: 12.2, jack: 11, speed: null, tech: "x" }, msd: { Jumpstream: 25.1 }, junk: 1 });
    assert.deepEqual(skill, { overall: 12.6, tiles: { stamina: 12.2, jack: 11 }, msd: { Jumpstream: 25.1 } });
    const p = buildDanPayload({ checksum: "abc", rate: 1.2, mode: 3, entry, skill, recording: true });
    assert.equal(p.key, "abc|1.20");
    assert.equal(p.state, "ok");
    assert.equal(p.numeric, 13);
    assert.equal(p.primary, "Jumpstream");
    assert.equal(p.confidenceLevel, "high");
    assert.deepEqual(p.sections, [12, 13, null]);
    assert.equal(p.firstMs, 1000);
    assert.equal(p.lastMs, 101_000);
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
        checksum: "abc", rate: 1, entry: { result: OK, sections: [10, 12, 14, 14, 13], firstMs: 0, lastMs: 4000 },
        skill: { overall: 12.5, tiles: { stamina: 12.2 } }, recording: true,
    });
    const playing = danView(payload, { phase: "playing", clock: 2000, hits: { max: 10, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(playing.line, "Gamma mid · 13.0");
    assert.equal(playing.pattern, "Jumpstream");
    assert.equal(playing.progress, 0.5);
    assert.equal(playing.now, "сейчас: Gamma low", "the middle: the mean of all five, 12.6");
    assert.equal(playing.forYou, "+0.8 к твоему уровню");
    assert.equal(playing.band, "challenge");
    assert.equal(playing.play, "", "the play's own dan waits for the results screen");
    const results = danView(payload, { phase: "results", clock: 2000, hits: { max: 1000, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(results.progress, 1);
    assert.equal(results.play, "эта игра: Gamma mid/high");
    assert.equal(results.playDan, 13.25);
    const off = danView({ ...payload, recording: false }, { phase: "results", hits: { max: 10, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 } });
    assert.equal(off.play, "", "recording off: no play dan");
    const counting = danView({ state: "counting" }, { phase: "playing", clock: 0 });
    assert.equal(counting.label, "считаем…");
    assert.equal(counting.number, "—");
    assert.equal(counting.now, "");
    const noLine = danView({ ...payload, sections: null }, { phase: "playing", clock: 0 });
    assert.equal(noLine.now, "", "no line yet: no now");
});

// ---- the line's geometry ----

test("dan line geometry: across the width, the map's dan as a guide, breaks on the bottom, a flat map stays flat", () => {
    const g = danSparkGeometry([10, 12, null, 14], { width: 90, height: 30, mapDan: 13, progress: 0.5 });
    assert.equal(g.points.length, 4);
    assert.equal(g.points[0].x, 0);
    assert.equal(g.points[3].x, 90);
    assert.equal(g.lo, 10);
    assert.equal(g.hi, 14);
    assert.equal(g.points[0].y, 28, "the lowest at the bottom (pad 2)");
    assert.equal(g.points[3].y, 2, "the highest at the top");
    assert.equal(g.points[2].y, 28, "a break on the bottom edge");
    assert.equal(g.refY, 2 + 26 * (1 - 3 / 4));
    assert.equal(g.playX, 45);
    const flat = danSparkGeometry([13, 13, 13], { width: 60, height: 20, mapDan: 13 });
    assert.deepEqual([flat.lo, flat.hi], [12, 14], "at least two dans tall");
    assert.ok(flat.points.every((p) => p.y === 10));
    assert.deepEqual(danSparkGeometry([], { width: 10, height: 10 }).points, []);
    assert.equal(danSparkGeometry([1], { width: 10, height: 10, progress: 3 }).playX, 10);
});

// ---- settings ----

test("settings: the Dan widget's defaults, its lines, its size and place; an overlay.json from before it gets it", async () => {
    assert.ok(WIDGETS.includes("dan"));
    const d = normalizeOverlaySettings(null);
    assert.deepEqual(d.widgets.dan, {
        enabled: true, style: "card", opacity: 1, scale: 1, x: null, y: null,
        show: { map: true, pattern: true, live: true, forYou: true, play: true },
    });
    assert.deepEqual(SHOW.dan, ["map", "pattern", "live", "forYou", "play"]);
    assert.deepEqual(widgetSize("dan", "card"), { width: 230, height: 170 });
    assert.deepEqual(widgetSize("dan", "compact", 1.5), { width: 840, height: 60 });
    const placed = placeWidget("dan", d, [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]);
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
    // a line turned off, a broken one dropped
    const patched = applyPatch(migrated, { widgets: { dan: { show: { forYou: false, nope: true }, style: "minimal", scale: 9 } } });
    assert.equal(patched.widgets.dan.show.forYou, false);
    assert.equal(patched.widgets.dan.show.play, true);
    assert.equal("nope" in patched.widgets.dan.show, false);
    assert.equal(patched.widgets.dan.style, "minimal");
    assert.equal(patched.widgets.dan.scale, 2.5);
});

test("the made-up Dan payload: shaped like main's, its line along the fake NPS map, every line shown in a preview", () => {
    const fake = fakeDan(100_000);
    const real = buildDanPayload({ checksum: "x", entry: { result: OK, sections: [1], firstMs: 0, lastMs: 1 }, skill: { overall: 12 }, recording: true });
    assert.deepEqual(Object.keys(fake).filter((k) => k !== "preview").sort(), Object.keys(real).sort());
    assert.ok(fake.sections.some((v) => v === null) && fake.sections.some((v) => v > 13));
    assert.equal(fake.firstMs, 90_000, "the playhead goes round with the NPS preview's map");
    const snap = fakeSnapshot(100_000);
    const v = danView(snap.dan, snap);
    assert.equal(v.line, "Gamma mid · 13.0");
    assert.ok(v.now.startsWith("сейчас: "));
    assert.equal(v.forYou, "+0.8 к твоему уровню");
    assert.ok(v.play.startsWith("эта игра: "), "the preview shows the play's dan too");
});

// ---- the widget's DOM ----

test("the Dan widget's DOM: every line it is asked for, the payload only for its own map and rate, states in words", async () => {
    fakeDom();
    const { mountWidget, danPayloadFor } = await import("../app/overlay/render.js");
    const payload = buildDanPayload({ checksum: "m", rate: 1.2, entry: { result: OK, sections: [12, 13, 14], firstMs: 0, lastMs: 1000 }, skill: { overall: 12.2 }, recording: true });
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
    for (const part of ["13.0", "Gamma mid", "уверенность: высокая", "Jumpstream", "сейчас: Gamma mid", "+0.8 к твоему уровню"]) {
        assert.ok(text.includes(part), `${part} in ${text}`);
    }
    view.paint(500); // a canvas of no size draws nothing, without failing
    view.update({ phase: "results", checksum: "m", rate: 1.2, clock: 900, hits: { max: 1000, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, mods: [] });
    const box = root.children[0];
    const now = box.children.find((n) => n.className === "d-now");
    const play = box.children.find((n) => n.className === "d-play");
    assert.equal(play.textContent, "эта игра: Gamma mid/high");
    assert.equal(now.hidden, true, "the play's dan takes the place of now");
    view.update({ phase: "playing", checksum: "n", rate: 1, clock: 0 });
    assert.equal(box.dataset.state, "counting");
    assert.ok(textOf(root).includes("считаем…"));

    // only the lines asked for
    const few = document.createElement("div");
    mountWidget(few, "dan", { style: "compact", show: { map: true, pattern: false, live: false, forYou: false, play: false }, dan: payload });
    assert.deepEqual(few.children[0].children.map((n) => n.className), ["d-head"]);
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

test("source: one analysis per map and rate however often it is asked; the first note from the map; retried after a failure", async () => {
    const text = makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 });
    const calls = [];
    const gate = deferred();
    let clock = 0;
    const changed = [];
    const source = createDanSource({
        analyze: async (req) => {
            calls.push(req);
            await gate.promise;
            return { result: { ...OK, rate: req.rate, durationSec: 60 }, details: { strain: [0.5, 1, 1, 1, 1] } };
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
    assert.equal(e.firstMs, 1000, "makeChart starts at 1000 ms");
    assert.equal(e.lastMs, 1000 + 60_000 * 1.2, "the play's clock runs at the rate");
    assert.equal(e.sections.length, 5);
    assert.equal(e.sections[1], 13);
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

test("source: the card's result is kept under the overlay's key at once, its details after; an Interlude chart's first note is 0", async () => {
    const text = makeChart({ kind: "stream", bpm: 170, seconds: 60 });
    const gate = deferred();
    const seen = [];
    const source = createDanSource({
        analyze: async (req) => {
            seen.push(req);
            await gate.promise;
            return { result: req.result, details: { strain: [1, 1, 1] } };
        },
    });
    assert.equal(overlayChecksum("external:HASH"), "interlude:HASH");
    assert.equal(overlayChecksum("md5"), "md5");
    source.fromCard({ checksum: "external:HASH", text, rate: 1.25, result: OK, key: "k" });
    await flush();
    const key = danKey("interlude:HASH", 1.25);
    assert.equal(source.stateOf(key), "ok", "the card's dan shows before its line");
    assert.equal(source.get(key).firstMs, 0);
    assert.equal(seen[0].result, OK, "the card's result goes in as it is: no second analysis");
    gate.resolve();
    await flush();
    await flush();
    assert.deepEqual(source.get(key).sections, [13, 13, 13]);
    // the same again: nothing more to do; a transient error from the card is no result
    source.fromCard({ checksum: "external:HASH", text, rate: 1.25, result: OK });
    source.fromCard({ checksum: "abc", text, rate: 1, result: { kind: "error", transient: true } });
    await flush();
    assert.equal(seen.length, 1);
    assert.equal(source.get(danKey("abc", 1)), null);
    // a few maps kept, the oldest go
    const small = createDanSource({ analyze: async () => ({ result: OK, details: null }), keep: 2 });
    for (const c of ["a", "b", "c"]) small.want(c, 1, { text });
    await flush();
    assert.equal(small.get("a|1.00"), null);
    assert.ok(small.get("c|1.00"));
});

test("the analyser: the card's cached result and details, else the worker's background line, and the details cached", async () => {
    const text = makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 });
    const store = new Map();
    const cache = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
    const jobs = [];
    const details = { v: 2, strain: [1], families: [], flavourBins: [], durationSec: 60 };
    const analysis = {
        analyzeQueued: async (tx, rate) => { jobs.push(["analyze", rate]); return { ...OK, rate }; },
        enqueue: async (fn) => fn(),
    };
    const worker = { details: async (tx, rate) => { jobs.push(["details", rate]); return { kind: "details", details }; } };
    const analyze = makeDanAnalyzer({ analysis, worker, cache });
    const first = await analyze({ text, rate: 1.1 });
    assert.equal(first.result.numeric, 13);
    assert.deepEqual(first.details, details);
    assert.deepEqual(store.get(detailsKey(cacheKey(text, 1.1))), details, "the card's details job finds them too");
    const again = await analyze({ text, rate: 1.1, result: OK });
    assert.deepEqual(again.details, details);
    assert.deepEqual(jobs, [["analyze", 1.1], ["details", 1.1]], "the second time all from the cache and the card");
    const notRice = await makeDanAnalyzer({ analysis: { analyzeQueued: async () => ({ kind: "not-rice", reason: "keys" }) }, worker, cache })({ text, rate: 1 });
    assert.deepEqual(notRice, { result: { kind: "not-rice", reason: "keys" }, details: null });
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
            return options.analyze ? options.analyze(req) : { result: { ...OK, rate: req.rate, durationSec: 60 }, details: { strain: [0.6, 1, 1, 1] } };
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
        assert.equal(last.firstMs, 1000);
        assert.equal(last.sections.length, 4);
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
        analyze: (req) => (req.result ? { result: req.result, details: { strain: [1, 1] } } : { result: { kind: "not-rice", reason: "keys", keys: 7 }, details: null }),
    }, async ({ overlay, ws, calls, configs }) => {
        // the card had this map at 1.2 (lazer's DT speed)
        overlay.onCardResult({ checksum: "lz", text: makeChart({ kind: "stream", seconds: 60 }), rate: 1.2, result: OK, key: "k" });
        await settle();
        const dt = { name: "DT", array: [{ acronym: "DT", settings: { speed_change: 1.2 } }], rate: 1.2 };
        for (let live = 1000; live < 1500; live += 100) ws.send(tosuJson({ client: "lazer", checksum: "lz", live, mods: dt }));
        await settle();
        assert.equal(calls.length, 1, "only the card's result's line, no new analysis");
        assert.equal(calls[0].result, OK);
        assert.equal(configs().at(-1).key, "lz|1.20");
        assert.equal(configs().at(-1).state, "ok");
        assert.deepEqual(configs().at(-1).sections, [13, 13]);
        // a 7K map
        ws.send(tosuJson({ client: "lazer", checksum: "7k", live: 1000, mods: { rate: 1 } }));
        await settle();
        assert.equal(configs().at(-1).state, "not4k");
    });
});

test("manager, Interlude: the library chart's text, the reader's clock from the first note; recording off keeps the play dan away", async () => {
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
        assert.equal(p.firstMs, 0, "Interlude's clock starts at the first note");
        assert.equal(p.lastMs, 60_000 * 1.25);
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
    await withOverlay({ analyze: async (req) => { await gate.promise; return { result: { ...OK, rate: req.rate }, details: null }; } }, async ({ overlay, ws, calls, configs }) => {
        ws.send(tosuJson({ live: 1000 }));
        await settle();
        assert.equal(configs().at(-1).state, "counting");
        gate.resolve();
        await settle();
        assert.equal(configs().at(-1).state, "ok");
        assert.equal(configs().at(-1).sections, null, "no details: no line, the dan all the same");
        overlay.apply({ widgets: { dan: { enabled: false } } });
        ws.send(tosuJson({ checksum: "other", live: 1000 }));
        await settle();
        assert.equal(calls.length, 1);
    });
});
