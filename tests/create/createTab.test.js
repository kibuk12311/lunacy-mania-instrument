// The create tab put together (mapgen v3, B7) on the fake DOM: loading a song (worker timing, local fallback),
// 3 variants of one range with seeds base + v·1009, a mapset with one variant per difficulty and the same seeds,
// progress for this job only, «Стоп», «Ещё вариант», a lock and «Перегенерировать незакреплённое», timingChanged,
// the mode chips and what the export panel gets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { clickTrack } from "../fixtures/clickTrack.js";
import { setLang } from "../../src/i18n/i18n.js";

const BASE = JSON.parse(readFileSync(new URL("../fixtures/generateResult.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const all = (n) => [n, ...n.children.flatMap(all)];
const buttons = (root, text) => all(root).filter((n) => n.tagName === "BUTTON" && n.textContent === text);

// Web Audio as far as the tab uses it: decoding gives a 20 s click track at 174 BPM.
function fakeAudio() {
    const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312, seconds: 20, sampleRate: 22050 });
    const buffer = { duration: samples.length / sampleRate, sampleRate, length: samples.length };
    globalThis.AudioContext = class {
        constructor() { Object.assign(this, { currentTime: 0, sampleRate: 22050, state: "running", destination: {}, outputLatency: 0, baseLatency: 0 }); }
        async decodeAudioData() { return buffer; }
        close() {}
        resume() {}
        getOutputTimestamp() { return { contextTime: 0, performanceTime: 0 }; }
        createGain() { return { gain: { value: 1 }, connect: (n) => n }; }
        createBuffer(_c, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
        createBufferSource() { return { connect: (n) => n, start() {}, stop() {}, onended: null }; }
    };
    globalThis.OfflineAudioContext = class {
        createBufferSource() { return { connect() {}, start() {} }; }
        get destination() { return {}; }
        async startRendering() { return { getChannelData: () => samples }; }
    };
}

const PARTS = [
    { startMs: 0, endMs: 6000, kind: "intro" },
    { startMs: 6000, endMs: 14000, kind: "drop" },
    { startMs: 14000, endMs: 20000, kind: "outro" },
];
// the answer for a request: the fixture with its own id and seeds, its parts the ones asked for
let answers = 0;
function answerFor(req, { numeric = 13.0, patternScore = 0.8 } = {}) {
    answers += 1;
    const parts = (req.request.parts ?? []).map((p, index) => ({
        index, startMs: p.startMs, endMs: p.endMs, kind: p.kind, families: ["Jumpstream"], wanted: p.range ?? null, empty: Boolean(p.empty),
        locked: Boolean(req.request.lock?.parts.includes(index)), noteCount: 40, patternScore: 0.8,
        dan: { numeric: 12.9, label: "Gamma mid", top3: [] }, inRange: p.range ? true : null, issues: 0, retried: 0,
    }));
    return {
        ...BASE, id: `id-${answers}`, planSeed: req.request.planSeed, noteSeed: req.request.noteSeed, parts, patternScore,
        result: { ...BASE.result, numeric }, range: req.request.range, issues: [],
    };
}

let copies = 0;
async function loadedTab(api = {}, opts = {}) {
    fakeAudio();
    const calls = { generate: [], timing: [], selection: [], loaded: [] };
    let progress = null;
    const dom = fakeDom({
        pathForFile: () => "C:/songs/song.mp3",
        detectTiming: async (req) => {
            calls.timing.push(req);
            return { ok: true, timing: { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 }, modelInfo: { kind: "xgb-v1", grid: "q4", maps: 6326 } };
        },
        generateMap: async (req) => { calls.generate.push(req); return answerFor(req); },
        onGenerateProgress: (cb) => { progress = cb; return () => {}; },
        ...api,
    });
    copies += 1;
    const mod = await import(`../../app/renderer/createTab.js?copy=${copies}`);
    let seed = 0.5;
    mod.initCreateTab({
        random: () => seed,
        core: { detectParts: opts.noParts ? null : opts.detectParts ?? (() => PARTS.map((p) => ({ ...p }))), energyCurve: null, rankVariants: opts.rank ?? null },
        exportPanel: ({ getSelection }) => ({
            onSongLoaded: (song) => calls.loaded.push(song),
            onSelectionChanged: () => calls.selection.push(getSelection()),
        }),
        remapPanel: () => ({}),
    });
    await fire(dom.$("file"), "change", { target: { files: [{ name: "song.mp3", arrayBuffer: async () => new ArrayBuffer(8) }] } });
    for (let i = 0; i < 200 && dom.$("generate").disabled; i += 1) await sleep(10);
    assert.equal(dom.$("generate").disabled, false, "the song loaded");
    return { ...dom, mod, calls, emit: (p) => progress?.(p), setSeed: (s) => { seed = s; } };
}

const BASE_SEED = 1 + Math.floor(0.5 * 999983);

test("loading: timing from the worker with the fine onsets, parts on the timeline, groups shown, the export panel told", async () => {
    const { $, calls } = await loadedTab();
    const [req] = calls.timing;
    assert.ok(req.envelope.values.length > 0 && req.envelope.hopSec > 0);
    assert.ok(req.fine.values.length > req.envelope.values.length, "fine onsets are finer than the envelope");
    assert.equal($("bpm").value, "174");
    assert.equal($("offset").value, "312");
    assert.equal($("parts-group").hidden, false);
    assert.equal($("preview").hidden, false);
    assert.equal($("diffs").hidden, false);
    assert.equal($("create-mode").hidden, false);
    assert.ok(textOf($("part-editor")).includes("3"), textOf($("part-editor")));
    assert.equal(calls.loaded.length, 1);
    assert.equal(calls.loaded[0].path, "C:/songs/song.mp3");
    assert.deepEqual(calls.loaded[0].parts.map((p) => p.kind), ["intro", "drop", "outro"]);
});

test("loading: the local detector when the worker cannot tell", async () => {
    const { $ } = await loadedTab({ detectTiming: async () => ({ ok: false, message: "no worker" }) });
    const bpm = Number($("bpm").value);
    assert.ok(bpm > 170 && bpm < 178, `bpm ${bpm}`);
});

test("one range: 3 variants, seeds base + v·1009, the parts and snaps sent, the best card chosen", async () => {
    setLang("en");
    try {
        const rank = (list) => [...list].sort((a, b) => b.noteSeed - a.noteSeed); // the last made wins
        const { $, mod, calls } = await loadedTab({}, { rank });
        await fire($("generate"));
        assert.equal(calls.generate.length, 3);
        assert.deepEqual(calls.generate.map((r) => [r.request.planSeed, r.request.noteSeed, r.request.seed]),
            [0, 1, 2].map((v) => [BASE_SEED + v * 1009, BASE_SEED + v * 1009, BASE_SEED + v * 1009]));
        assert.equal(new Set(calls.generate.map((r) => r.jobId)).size, 3);
        const [first] = calls.generate;
        assert.deepEqual(first.timing, { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 });
        assert.deepEqual(first.request.snaps, [4]);
        assert.equal(first.request.normalizeSv, true);
        assert.deepEqual(first.request.parts, PARTS);
        assert.deepEqual(first.request.range, { lo: 11.5, hi: 14.5 });
        assert.deepEqual(first.request.patterns, [{ name: "Jumpstream", share: 1 }]);
        assert.equal(first.request.lock, undefined);

        const { diffs, focus } = mod.createTabState();
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].cards.length, 3);
        assert.equal(diffs[0].bestId, diffs[0].cards[2].id);
        assert.deepEqual(focus, { d: 0, id: diffs[0].cards[2].id }, "the best card is on the playfield");
        const text = textOf($("gen-result"));
        assert.ok(text.includes("Variant A") && text.includes("Variant C"));
        assert.equal($("generate").textContent, "Create map", "the button is back from «Stop»");
        assert.equal($("gen-status").textContent, "");
        assert.deepEqual(calls.selection.at(-1).diffs.map((d) => d.id), [diffs[0].cards[2].id]);
        assert.equal(calls.selection.at(-1).song.timing.bpm, 174);
    } finally {
        setLang("ru");
    }
});

test("a mapset: one variant per difficulty, easiest first, all with the same base seeds", async () => {
    setLang("en");
    try {
        const { $, mod, calls } = await loadedTab();
        await fire(buttons($("diffs"), "Ladder: 3 dans in a row")[0]);
        assert.equal($("generate").textContent, "Create mapset (3 difficulties)");
        await fire($("generate"));
        assert.equal(calls.generate.length, 3);
        assert.deepEqual(calls.generate.map((r) => r.request.range.lo), [10.5, 11.5, 12.5]);
        assert.ok(calls.generate.every((r) => r.request.planSeed === BASE_SEED && r.request.noteSeed === BASE_SEED));
        const { diffs } = mod.createTabState();
        assert.deepEqual(diffs.map((d) => d.cards.length), [1, 1, 1]);
        assert.deepEqual(calls.selection.at(-1).diffs.map((d) => d.range.lo), [10.5, 11.5, 12.5]);
    } finally {
        setLang("ru");
    }
});

test("progress of this job only, with its phase; «Stop» ends the run after the call that is going", async () => {
    setLang("en");
    try {
        let release = null;
        const { $, calls, emit } = await loadedTab({
            generateMap: async (req) => {
                calls.generate.push(req);
                await new Promise((resolve) => { release = resolve; });
                return answerFor(req);
            },
        });
        const run = fire($("generate"));
        await sleep(5);
        const [req] = calls.generate;
        assert.equal($("generate").textContent, "Stop");
        emit({ jobId: req.jobId, phase: "partSearch", i: 1, n: 3, kind: "drop" });
        assert.equal($("gen-status").textContent, "Variant 1 of 3… Tuning the dan: part 2 of 3 (Drop)");
        emit({ jobId: "someone-else", phase: "retry", i: 0, n: 1 });
        assert.equal($("gen-status").textContent, "Variant 1 of 3… Tuning the dan: part 2 of 3 (Drop)", "another job's progress is not shown");
        emit({ jobId: req.jobId, phase: "describe", i: 0, n: 1 });
        assert.equal($("gen-status").textContent, "Variant 1 of 3… Checking the parts…");
        await fire($("generate")); // «Stop»
        release();
        await run;
        assert.equal(calls.generate.length, 1, "stopped after the first variant");
        assert.equal($("generate").textContent, "Create map");
    } finally {
        setLang("ru");
    }
});

test("«Another variant» adds a card with new seeds; lock a part and «Regenerate the unlocked parts»", async () => {
    setLang("en");
    try {
        const { $, mod, calls, setSeed } = await loadedTab();
        await fire($("generate"));
        setSeed(0.25);
        await fire(buttons($("gen-result"), "Another variant")[0]);
        assert.equal(calls.generate.length, 4);
        const more = calls.generate[3].request;
        assert.equal(more.planSeed, 1 + Math.floor(0.25 * 999983));
        assert.equal(more.noteSeed, more.planSeed);
        let { diffs } = mod.createTabState();
        assert.equal(diffs[0].cards.length, 4);

        // lock part 1 of the chosen card from the timeline's editor
        const chosen = diffs[0].cards.find((c) => c.id === diffs[0].selectedId);
        const timelineLock = () => buttons($("part-editor"), "Lock")[0];
        await fire($("timeline"), "pointerdown", { offsetX: 432 * 0.5, button: 0 });
        await fire($("timeline"), "pointerup", { offsetX: 432 * 0.5 });
        assert.ok(timelineLock(), "the chosen card's parts line up with the timeline: it can lock");
        await fire(timelineLock());
        assert.deepEqual([...chosen.locks], [1]);
        setSeed(0.75);
        await fire(buttons($("gen-result"), "Regenerate the unlocked parts")[0]);
        const regen = calls.generate.at(-1).request;
        assert.deepEqual(regen.lock, { fromId: chosen.id, parts: [1] });
        assert.equal(regen.planSeed, chosen.answer.planSeed, "the base map's plan seed");
        assert.equal(regen.noteSeed, 1 + Math.floor(0.75 * 999983), "a new note seed");
        assert.deepEqual(regen.parts, PARTS, "the base map's parts");
        ({ diffs } = mod.createTabState());
        assert.equal(diffs[0].cards.length, 5);
        assert.deepEqual([...diffs[0].cards.at(-1).locks], [1], "the new card keeps the lock");
    } finally {
        setLang("ru");
    }
});

test("parts found past the song's end are cut at its end, so the worker's parts still line up for a lock", async () => {
    setLang("en");
    try {
        // detectParts ends at the envelope's end, a little after the decoded song (20 s here); the worker cuts there
        const past = PARTS.map((p, i) => (i === PARTS.length - 1 ? { ...p, endMs: 20070.75 } : { ...p }));
        const { $, calls } = await loadedTab({
            generateMap: async (req) => {
                calls.generate.push(req);
                const answer = answerFor(req);
                for (const part of answer.parts) part.endMs = Math.min(part.endMs, req.durationMs);
                return answer;
            },
        }, { detectParts: () => past.map((p) => ({ ...p })) });
        await fire($("generate"));
        const sent = calls.generate[0];
        assert.equal(sent.request.parts.at(-1).endMs, sent.durationMs);
        assert.ok(sent.request.parts.every((p) => p.startMs < sent.durationMs && p.endMs <= sent.durationMs));
        await fire($("timeline"), "pointerdown", { offsetX: 432 * 0.5, button: 0 });
        await fire($("timeline"), "pointerup", { offsetX: 432 * 0.5 });
        assert.ok(buttons($("part-editor"), "Lock")[0], "the timeline can lock a part of the chosen card");
    } finally {
        setLang("ru");
    }
});

test("timingChanged on a regenerate clears the locks and says why", async () => {
    setLang("en");
    try {
        let refuse = false;
        const { $, mod, calls } = await loadedTab({
            generateMap: async (req) => {
                calls.generate.push(req);
                return refuse ? { ok: false, code: "timingChanged", message: "x" } : answerFor(req);
            },
        });
        await fire($("generate"));
        const { diffs } = mod.createTabState();
        await fire(buttons($("gen-result"), "Lock")[0]);
        const locked = diffs[0].cards.find((c) => c.locks.size);
        assert.ok(locked, "a card's part row locks that part");
        refuse = true;
        await fire(buttons($("gen-result"), "Regenerate the unlocked parts")[0]);
        assert.equal(calls.generate.at(-1).request.lock.fromId, locked.id);
        assert.equal(locked.locks.size, 0);
        assert.equal($("gen-status").textContent, "Timing changed — locked parts were cleared");
        assert.equal(buttons($("gen-result"), "Regenerate the unlocked parts").length, 0);
    } finally {
        setLang("ru");
    }
});

test("an error from the generator is shown and keeps nothing; no parts module: no parts sent", async () => {
    setLang("en");
    try {
        const { $, calls } = await loadedTab({
            generateMap: async (req) => { calls.generate.push(req); return { ok: false, code: "failed", message: "boom" }; },
        }, { noParts: true });
        await fire($("generate"));
        assert.equal(calls.generate.length, 1);
        assert.equal(calls.generate[0].request.parts, undefined);
        assert.equal($("gen-status").textContent, "Error: boom");
        assert.equal($("gen-result").hidden, true);
    } finally {
        setLang("ru");
    }
});

test("the mode chips switch between the song and the remap panel", async () => {
    fakeAudio();
    const dom = fakeDom({ pathForFile: () => "" });
    const song = dom.$("song-mode");
    const remap = dom.$("remap-panel");
    const chips = ["song", "remap"].map((mode) => {
        const chip = document.createElement("span");
        chip.dataset.mode = mode;
        return chip;
    });
    dom.$("create-mode").children = chips;
    copies += 1;
    const mod = await import(`../../app/renderer/createTab.js?copy=${copies}`);
    mod.initCreateTab({ core: { detectParts: null, energyCurve: null, rankVariants: null }, exportPanel: () => ({}), remapPanel: () => ({}) });
    await fire(chips[1]);
    assert.equal(song.hidden, true);
    assert.equal(remap.hidden, false);
    await fire(chips[0]);
    assert.equal(song.hidden, false);
    assert.equal(remap.hidden, true);
});
