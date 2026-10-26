// «Автоподбор» in the create tab (0.9.8, app/renderer/autoPick.js): the plan into the normal controls, the summary
// with «изменить выбор», the profile wait, and the tab's button sending a request made of the plan's choices.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { clickTrack } from "../fixtures/clickTrack.js";
import { setLang } from "../../src/i18n/i18n.js";
import { danRange } from "../../src/gen/search.js";

const BASE = JSON.parse(readFileSync(new URL("../fixtures/generateResult.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const all = (n) => [n, ...n.children.flatMap(all)];

const PLAN = {
    target: 13.2, from: { level: 13, step: "mid" }, to: { level: 13, step: "high" }, source: "profile", playerDan: 13,
    parts: [{ startMs: 0, endMs: 5000, kind: "intro", patterns: [{ name: "Stream", share: 1 }], range: { lo: 10.7, hi: 11.7 } }, { startMs: 5000, endMs: 9000, kind: "drop", patterns: [{ name: "Jumpstream", share: 1 }] }],
    patterns: [{ name: "Stream", share: 56 }, { name: "Jumpstream", share: 44 }], main: "Jumpstream",
    groups: [{ kind: "intro", family: "Stream" }, { kind: "drop", family: "Jumpstream" }],
    model: "xgb3", candidates: 4, repeats: true, snaps: [4, 3, 6, 8], stamina: 0.4, burst: 0.3, sustained: [],
};

test("applyPlan fills every control it is given", async () => {
    fakeDom({});
    const { applyPlan } = await import("../../app/renderer/autoPick.js");
    const seen = {};
    const stamina = { value: "50" };
    const burst = { value: "10" };
    applyPlan(PLAN, {
        diffList: { setRows: (rows) => { seen.rows = rows; } },
        setPatterns: (m) => { seen.patterns = [...m]; },
        setMix: (mix) => { seen.mix = mix; },
        stamina, burst,
        timing: { setSnaps: (s) => { seen.snaps = s; } },
        options: { apply: (o) => { seen.options = o; } },
        timeline: { setParts: (p) => { seen.parts = p; } },
    });
    assert.deepEqual(seen.rows, [{ from: PLAN.from, to: PLAN.to }]);
    assert.deepEqual(seen.patterns, [["Stream", 56], ["Jumpstream", 44]]);
    assert.equal(seen.mix, "sections");
    assert.equal(stamina.value, "40");
    assert.equal(burst.value, "30");
    assert.deepEqual(seen.snaps, [4, 3, 6, 8]);
    assert.deepEqual(seen.options, { modelSize: "xgb3", candidates: 4, repeats: true });
    assert.equal(seen.parts.length, 2);
    assert.ok(seen.parts.every((p) => p.edited), "set parts are not found again over the top");
    assert.deepEqual(seen.parts[0].range, { lo: 10.7, hi: 11.7 });
    // missing controls are skipped
    applyPlan(PLAN, {});
});

test("profileFor: the profile in use, or none when it is slow or fails", async () => {
    const { profileFor } = await import("../../app/renderer/autoPick.js");
    assert.deepEqual(await profileFor(async () => ({ state: "ready", skill: { overall: 9 } })), { state: "ready", skill: { overall: 9 } });
    assert.equal(await profileFor(() => new Promise(() => {}), 20), null);
    assert.equal(await profileFor(async () => { throw new Error("offline"); }), null);
    assert.equal(await profileFor(null), null);
});

test("runAuto: no song → a note and nothing else; busy → nothing", async () => {
    fakeDom({});
    const { runAuto } = await import("../../app/renderer/autoPick.js");
    let status = "";
    let generated = 0;
    setLang("en");
    try {
        assert.equal(await runAuto({ song: () => null, setStatus: (s) => { status = s; }, generate: () => { generated += 1; } }), null);
        assert.equal(status, "Load a song first");
        assert.equal(await runAuto({ busy: () => true, song: () => ({}), generate: () => { generated += 1; } }), null);
        assert.equal(generated, 0);
    } finally {
        setLang("ru");
    }
});

test("runAuto: plan → controls → summary with «изменить выбор» → generate, in that order", async () => {
    const dom = fakeDom({});
    const { runAuto } = await import("../../app/renderer/autoPick.js");
    const order = [];
    const { samples, sampleRate } = clickTrack({ bpm: 170, offsetMs: 200, seconds: 20, sampleRate: 22050 });
    const { onsetEnvelope } = await import("../../src/audio/onset.js");
    const envelope = onsetEnvelope(samples, sampleRate);
    let edited = 0;
    setLang("ru");
    const plan = await runAuto({
        song: () => ({ bpm: 170, durationMs: 20000, envelope, stems: null }),
        parts: () => [{ startMs: 0, endMs: 8000, kind: "intro" }, { startMs: 8000, endMs: 20000, kind: "drop" }],
        ensureProfile: async () => ({ state: "ready", skill: { overall: 11 } }),
        available: () => ({ sizes: { auto: true, xgb3: true }, gpu: false, stems: false, critic: true }),
        controls: { diffList: { setRows: () => order.push("dan") }, options: { apply: () => order.push("model") } },
        summaryRoot: dom.$("auto-summary"),
        onEdit: () => { edited += 1; },
        generate: async () => order.push("generate"),
    });
    assert.deepEqual(order, ["dan", "model", "generate"]);
    assert.equal(plan.source, "profile");
    assert.equal(plan.model, "auto", "no stems: the classic model");
    const box = dom.$("auto-summary");
    assert.equal(box.hidden, false);
    const text = textOf(box);
    assert.match(text, /^Автоподбор: Alpha/);
    assert.match(text, /модель: классическая/);
    const edit = all(box).find((n) => n.dataset?.role === "auto-edit");
    assert.equal(edit.textContent, "изменить выбор");
    await fire(edit, "click");
    assert.equal(edited, 1);
});

// ---- the create tab's button, end to end on the fake DOM ----

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
let copies = 0;
async function loadedTab({ profile = null, info = null } = {}) {
    fakeAudio();
    const calls = { generate: [] };
    const dom = fakeDom({
        pathForFile: () => "C:/songs/song.mp3",
        detectTiming: async () => ({ ok: true, timing: { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 }, modelInfo: { kind: "xgb-v1", grid: "q4", maps: 6326 } }),
        generateMap: async (req) => {
            calls.generate.push(req);
            return { ...BASE, id: `auto-${calls.generate.length}`, planSeed: req.request.planSeed, noteSeed: req.request.noteSeed, parts: [], range: req.request.range, issues: [] };
        },
        onGenerateProgress: () => () => {},
        ...(info ? { generatorInfo: async () => ({ ok: true, modelInfo: info }) } : {}),
    }, { storage: { "create.genOptions": JSON.stringify({ candidates: 1 }) } });
    copies += 1;
    const mod = await import(`../../app/renderer/createTab.js?auto=${copies}`);
    mod.initCreateTab({
        random: () => 0.5,
        core: { detectParts: () => PARTS.map((p) => ({ ...p })), energyCurve: null, rankVariants: null },
        exportPanel: () => ({}), remapPanel: () => ({}),
        gpu: async () => false,
        stems: { computeStems: async () => { throw new Error("no stems here"); } },
        ensureProfile: async () => profile,
    });
    dom.$("generate").disabled = true;
    await fire(dom.$("file"), "change", { target: { files: [{ name: "song.mp3", arrayBuffer: async () => new ArrayBuffer(8) }] } });
    for (let i = 0; i < 300 && dom.$("generate").disabled; i += 1) await sleep(10);
    assert.equal(dom.$("generate").disabled, false, "the song loaded");
    return { ...dom, mod, calls };
}

for (const lang of ["ru", "en"]) {
    test(`the tab's «Автоподбор» button (${lang}): one click sends a request made of the plan, and says what it chose`, async () => {
        setLang(lang);
        try {
            const { $, calls, mod } = await loadedTab({ profile: { state: "ready", skill: { overall: 12 } }, info: { sizes: { auto: true, xgb3: false, s: false, m: false, l: false }, critic: "critic-v1" } });
            const auto = $("auto-map");
            assert.equal(auto.disabled, false, "the button opens with the song");
            await fire(auto, "click");
            for (let i = 0; i < 100 && mod.createTabState().running; i += 1) await sleep(10);
            assert.ok(calls.generate.length >= 1, "it generated");
            const req = calls.generate[0].request;
            // the dan: the player's 12 in the growth band
            assert.ok(req.range.lo >= 11.8 && req.range.lo <= 12 && req.range.hi >= 12.3 && req.range.hi <= 12.5, JSON.stringify(req.range));
            const plannedRange = danRange({ level: 12, step: "mid" }, { level: 12, step: "high" });
            assert.ok(req.range.hi <= plannedRange.hi + 1e-9);
            // the parts went with their own patterns (and quiet ones with an easier range); the whole map's patterns too
            assert.equal(req.parts.length, 3);
            assert.ok(req.parts.every((p) => p.patterns?.length === 1));
            assert.ok(req.patterns.length >= 1);
            // the classic model (no stems), the critic on with candidates, 1/8 allowed
            assert.equal(req.modelSize, "auto");
            assert.equal(req.candidates, 4);
            assert.deepEqual(req.snaps, [4, 8]);
            assert.equal(req.mix, "sections");
            const summary = $("auto-summary");
            assert.equal(summary.hidden, false);
            const text = textOf(summary);
            if (lang === "ru") {
                assert.match(text, /^Автоподбор: Beta/);
                assert.match(text, /модель: классическая/);
                assert.match(text, /изменить выбор/);
            } else {
                assert.match(text, /^Auto: Beta/);
                assert.match(text, /model: Classic/);
                assert.match(text, /edit these choices/);
            }
            // «Создать карту» by hand afterwards: the line no longer describes the settings, so it goes
            await fire($("generate"), "click");
            assert.equal(summary.hidden, true);
        } finally {
            setLang("ru");
        }
    });
}

test("without a profile the tab's «Автоподбор» picks the dan from the song", async () => {
    setLang("en");
    try {
        const { $, calls, mod } = await loadedTab({ profile: { state: "none" } });
        await fire($("auto-map"), "click");
        for (let i = 0; i < 100 && mod.createTabState().running; i += 1) await sleep(10);
        assert.ok(calls.generate.length >= 1);
        assert.match(textOf($("auto-summary")), /No profile/);
    } finally {
        setLang("ru");
    }
});
