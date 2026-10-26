// «Автоподбор» (0.9.8, src/gen/autoPlan.js): the dan from the profile or the song, the pattern per part from the stems,
// easier quiet parts, the model by what can run, the summary in both languages.
import test from "node:test";
import assert from "node:assert/strict";
import { autoPlan, autoSummary, familyForPart, partFeatures, pickModel, songDan, playerDan, levelStepOf, GROWTH, AUTO_CANDIDATES } from "../../src/gen/autoPlan.js";
import { danRange } from "../../src/gen/search.js";
import { setLang } from "../../src/i18n/i18n.js";

const HOP = 0.01;
const SEC = 100;
const BPM = 160;
const beatMs = 60000 / BPM;
// parts: 0–20 s intro (quiet, melodic, no attacks), 20–50 s drop (loud, kick + snare on every beat),
// 50–75 s verse (fast hats, 1/4), 75–100 s bridge (melodic, mid loud)
const PARTS = [
    { startMs: 0, endMs: 20000, kind: "intro" },
    { startMs: 20000, endMs: 50000, kind: "drop" },
    { startMs: 50000, endMs: 75000, kind: "part" },
    { startMs: 75000, endMs: 100000, kind: "break" },
];
function makeSong({ stems = true } = {}) {
    const n = SEC / HOP;
    const env = new Float32Array(n);
    const kick = new Float32Array(n);
    const snare = new Float32Array(n);
    const hat = new Float32Array(n);
    const harm = new Float32Array(n);
    const perc = new Float32Array(n);
    const at = (ms) => Math.round(ms / 1000 / HOP);
    for (let f = 0; f < n; f += 1) {
        const ms = f * HOP * 1000;
        if (ms < 20000) { env[f] = 0.08; harm[f] = 0.7; perc[f] = 0.1; }
        else if (ms < 50000) { env[f] = 0.2; perc[f] = 0.8; harm[f] = 0.2; }
        else if (ms < 75000) { env[f] = 0.15; perc[f] = 0.7; harm[f] = 0.2; }
        else { env[f] = 0.13; harm[f] = 0.8; perc[f] = 0.2; }
    }
    for (let t = 20000; t < 50000; t += beatMs) { kick[at(t)] = 1; snare[at(t)] = 1; env[at(t)] = 1; }
    for (let t = 50000; t < 75000; t += beatMs / 4) { hat[at(t)] = 1; env[at(t)] = 0.6; }
    for (let t = 75000; t < 100000; t += beatMs / 2) { harm[at(t)] = 1; env[at(t)] = 0.5; }
    const envelope = { values: env, hopSec: HOP, frameTimeSec: (f) => f * HOP };
    return {
        bpm: BPM, durationMs: SEC * 1000, envelope,
        stems: stems ? { v: 1, hopSec: HOP, frameOffsetSec: 0, frames: n, kick, snare, hat, harm, percShare: perc } : null,
    };
}
const ALL = { sizes: { auto: true, xgb3: true, s: true, m: true, l: false }, gpu: true, stems: true, critic: true };

test("structure → patterns: drums → chordjack, fast hats → stream, melodic → tech / jumpstream", () => {
    const song = makeSong();
    const f = partFeatures({ parts: PARTS, envelope: song.envelope, stems: song.stems, bpm: BPM });
    assert.ok(f[1].loud > 0.9 && f[0].loud < 0.6, "the drop is the loudest, the intro quiet");
    assert.ok(f[2].hatBeat >= 3, `hats per beat ${f[2].hatBeat}`);
    const families = PARTS.map((p, i) => familyForPart(f[i], p.kind));
    assert.equal(families[1], "Chordjack");
    assert.equal(families[2], "Stream");
    assert.equal(families[0], "Tech");
    // a busy kick (two per beat) on the loud drums reads as jacks
    assert.equal(familyForPart({ ...f[1], kickBeat: 2 }), "Jack");
    // melodic and loud: handstream, mid: jumpstream
    assert.equal(familyForPart({ loud: 0.95, drums: 0.1, harm: 0.9, perc: 0.2, hatBeat: 0, kickBeat: 0, onsets: 0.5 }), "Handstream");
    assert.equal(familyForPart({ loud: 0.7, drums: 0.1, harm: 0.9, perc: 0.2, hatBeat: 0, kickBeat: 0, onsets: 0.5 }), "Jumpstream");
});

test("without stems the patterns follow the loudness only", () => {
    const song = makeSong({ stems: false });
    const plan = autoPlan({ song, parts: PARTS, profile: null, available: { ...ALL, stems: false } });
    // the loud drop jumpstream, the quiet intro stream
    assert.equal(plan.parts[1].patterns[0].name, "Jumpstream");
    assert.equal(plan.parts[0].patterns[0].name, "Stream");
    assert.ok(plan.parts.every((p) => ["Stream", "Jumpstream"].includes(p.patterns[0].name)));
    assert.equal(plan.repeats, false);
    // no stems: no neural model, no XGBoost v3 (both read the stems)
    assert.equal(plan.model, "auto");
});

test("with a profile the dan is the player's, in the growth band; the main pattern's tile wins over the overall dan", () => {
    const song = makeSong();
    const profile = { state: "ready", skill: { overall: 12.0, tiles: { jack: 13.0, speed: 11.0 } } };
    const plan = autoPlan({ song, parts: PARTS, profile, available: ALL });
    assert.equal(plan.source, "profile");
    assert.equal(plan.main, "Chordjack");
    assert.equal(plan.playerDan, 13);
    assert.equal(plan.target, Math.round((13 + (GROWTH.lo + GROWTH.hi) / 2) * 10) / 10);
    const range = danRange(plan.from, plan.to);
    assert.ok(range.lo >= 13 + GROWTH.lo - 0.21 && range.lo <= 13, `range ${range.lo}..${range.hi}`);
    assert.ok(range.hi >= 13.3 && range.hi <= 13 + GROWTH.hi + 0.01, `range ${range.lo}..${range.hi}`);
    assert.equal(playerDan({ overall: 9 }, "Chordjack"), 9);
    assert.equal(playerDan(null), null);
});

test("without a profile (none, failed, still loading) the dan comes from the song's tempo", () => {
    const song = makeSong();
    for (const profile of [null, { state: "none" }, { state: "failed", message: "x" }, { state: "loading" }]) {
        const plan = autoPlan({ song, parts: PARTS, profile, available: ALL });
        assert.equal(plan.source, "song");
        assert.equal(plan.target, songDan({ bpm: BPM, features: partFeatures({ parts: PARTS, envelope: song.envelope, stems: song.stems, bpm: BPM }) }));
    }
    assert.ok(songDan({ bpm: 120 }) < songDan({ bpm: 180 }));
    assert.equal(songDan({ bpm: 400 }), 12);
    assert.equal(songDan({ bpm: 30 }), 4);
});

test("quiet parts get an easier range of their own; the loud ones follow the map's range", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: { state: "ready", skill: { overall: 10 } }, available: ALL });
    assert.ok(plan.parts[0].range, "the quiet intro");
    assert.ok(plan.parts[0].range.hi <= plan.target - 1);
    assert.equal(plan.parts[1].range, undefined, "the drop");
    // one part only: no own range
    const one = autoPlan({ song: makeSong(), parts: [], profile: null, available: ALL });
    assert.equal(one.parts.length, 1);
    assert.equal(one.parts[0].range, undefined);
});

test("the model: neural M with the GPU and stems, S without M, XGBoost v3 with stems only, else the classic", () => {
    assert.equal(pickModel(ALL).size, "m");
    assert.equal(pickModel({ ...ALL, sizes: { ...ALL.sizes, m: false } }).size, "s");
    assert.equal(pickModel({ ...ALL, gpu: false }).size, "xgb3");
    assert.equal(pickModel({ ...ALL, gpu: false, sizes: { auto: true } }).size, "auto");
    assert.equal(pickModel({}).size, "auto");
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: ALL });
    assert.equal(plan.model, "m");
    assert.equal(plan.candidates, AUTO_CANDIDATES);
    assert.equal(plan.repeats, true);
    assert.deepEqual(plan.snaps, [4, 3, 6, 8]);
    const classic = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: { sizes: { auto: true }, critic: false } });
    assert.equal(classic.candidates, 1);
    assert.deepEqual(classic.snaps, [4, 8]);
});

test("the whole map's patterns are the parts' families by time, and every part names one", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: ALL });
    const names = plan.patterns.map((p) => p.name).sort();
    // the melodic, mid-loud bridge is jumpstream
    assert.deepEqual(names, ["Chordjack", "Jumpstream", "Stream", "Tech"]);
    assert.equal(plan.parts[3].patterns[0].name, "Jumpstream");
    assert.equal(plan.patterns.reduce((s, p) => s + p.share, 0), 100);
    for (const p of plan.parts) assert.equal(p.patterns.length, 1);
});

test("levelStepOf follows the label scale", () => {
    assert.deepEqual(levelStepOf(13), { level: 13, step: "mid" });
    assert.deepEqual(levelStepOf(12.6), { level: 13, step: "low" });
    assert.deepEqual(levelStepOf(13.2), { level: 13, step: "mid/high" });
    assert.deepEqual(levelStepOf(25), { level: 20, step: "high" });
    assert.deepEqual(levelStepOf(0), { level: 1, step: "low" });
});

test("the summary names the dan, each kind's pattern and the model, in Russian and in English", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: { state: "ready", skill: { overall: 13 } }, available: ALL });
    const names = { intro: "вступление", drop: "дроп", part: "куплет", break: "бридж" };
    try {
        setLang("ru");
        const ru = autoSummary(plan, { kindName: (k) => names[k], modelName: () => "нейросеть M" });
        assert.match(ru[0], /^Автоподбор: Gamma/);
        assert.match(ru[0], /дроп — чордджек/);
        assert.match(ru[0], /куплет — стрим/);
        assert.match(ru[0], /вступление — тех/);
        assert.match(ru[0], /модель: нейросеть M$/);
        assert.match(ru[1], /из твоего профиля/);
        setLang("en");
        const en = autoSummary(plan, { kindName: (k) => k, modelName: () => "neural M" });
        assert.match(en[0], /^Auto: Gamma/);
        assert.match(en[0], /drop — chordjack/);
        assert.match(en[0], /model: neural M$/);
        assert.match(en[1], /your profile/);
    } finally {
        setLang("ru");
    }
});

test("long sustained sound is named: the generator makes no LNs", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: ALL });
    assert.ok(plan.sustained.includes(0), "the intro holds long melodic sound with few attacks");
    try {
        setLang("en");
        const lines = autoSummary(plan);
        assert.ok(lines.some((l) => /no LNs/.test(l)));
    } finally {
        setLang("ru");
    }
});
