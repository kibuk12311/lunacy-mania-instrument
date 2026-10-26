import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
    infillSource, loadInfill, randomInfillModel, teacherForced, buildInfillInputs, probeInputs, infillStats, infillShapes,
    IN_DIM, LANE_VALUES,
} from "../../../src/gen/nn/infillModel.js";
import { encodeF16 } from "../../../src/gen/nn/f16.js";
import { referenceLogits } from "./reference.js";
import { onsetEnvelope } from "../../../src/audio/onset.js";
import { slotsForTiming } from "../../../src/gen/grid.js";
import { slotFeatures, AUDIO_FEATURES_V2 } from "../../../src/gen/slotFeatures.js";
import { mulberry32 } from "../../../src/gen/rng.js";
import { clickTrack } from "../../fixtures/clickTrack.js";
import { computeStemsSync } from "../../../src/audio/stems.js";
import { songStructure } from "../../../src/gen/structure.js";
import { BEAT_FEATURES_V3 as SHARED_BEAT_V3, beatFeaturesV3 } from "../../../src/gen/beatFeatures.js";
import { BEAT_FEATURES_V3 } from "../../../src/gen/nn/infillModel.js";

const TINY = { d: 8, enc_layers: 2, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 2, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 4, dec_win: 4, cross_win: 3, n_glob: 2 };

const counted = (seed) => {
    const rng = mulberry32(seed);
    const f = () => { f.calls += 1; return rng(); };
    f.calls = 0;
    return f;
};

// ---- parity with PyTorch ----
const fixture = await readFile(new URL("../../fixtures/infill-parity.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);
const shipped = [];
for (const name of await readdir(new URL("../../../models/", import.meta.url)).catch(() => [])) {
    if (/^mapper-nn2.*\.json$/.test(name)) shipped.push([name, await readFile(new URL(`../../../models/${name}`, import.meta.url), "utf8").then(JSON.parse)]);
}

function checkParity(model, label) {
    const net = loadInfill(model);
    const tol = model.parity.tolerance ?? 2e-3;
    assert.ok(model.parity.probes.length >= 3, `${label}: 3 probes`);
    for (const probe of model.parity.probes) {
        const inp = probeInputs(probe);
        const got = teacherForced(net, inp, inp.rows, probe.check);
        assert.equal(got.length, probe.logits.length);
        let worst = 0;
        got.forEach((g, k) => g.forEach((v, c) => { worst = Math.max(worst, Math.abs(v - probe.logits[k][c])); }));
        assert.ok(worst <= tol, `${label} probe ${probe.name}: max |Δ logit| ${worst} > ${tol}`);
    }
}

test("JS logits match PyTorch on the parity fixture (≤ 2e-3)", { skip: !fixture && "tests/fixtures/infill-parity.json missing" }, () => {
    assert.equal(fixture.kind, "nn-v2");
    assert.ok(fixture.size, "the export carries a size");
    assert.deepEqual(fixture.parity.probes.map((p) => p.name), ["full", "lock", "style"]);
    assert.ok(fixture.parity.probes.every((p) => p.check.length === 40));
    checkParity(fixture, "fixture");
});

test("shipped nn-v2 models match their own parity probes", { skip: !shipped.length && "no models/mapper-nn2*.json" }, () => {
    for (const [name, model] of shipped) checkParity(model, name);
});

// ---- the incremental path against a dense reference ----
function handInputs(T, { seed = 1, divs = null, echo = [] } = {}) {
    const rng = mulberry32(seed);
    const x = new Float32Array(T * IN_DIM);
    const div = new Uint8Array(T);
    const rows = new Uint8Array(T * 8);
    const visible = new Uint8Array(T * 8).fill(255);
    for (let t = 0; t < T; t += 1) {
        div[t] = divs ? divs[t % divs.length] : 0;
        const dv = [4, 3, 6, 8][div[t]];
        for (let l = 0; l < dv; l += 1) {
            for (let k = 0; k < 11; k += 1) x[t * IN_DIM + l * 12 + k] = rng();
            x[t * IN_DIM + l * 12 + 11] = 1;
            rows[t * 8 + l] = rng() < 0.4 ? 1 + Math.floor(rng() * 15) : 0;
            if (rng() < 0.2) visible[t * 8 + l] = rows[t * 8 + l];
        }
        for (let k = 96; k < 141; k += 1) x[t * IN_DIM + k] = rng() * 2 - 1;
        x[t * IN_DIM + 141 + div[t]] = 1;
    }
    const e = new Int32Array(T * 2).fill(-1);
    for (const [q, k, slot] of echo) e[q * 2 + slot] = k;
    return {
        T, x, div, rows, visible, fam: Uint8Array.from({ length: T }, (_, t) => t % 7), dan: Float32Array.from({ length: T }, (_, t) => 4 + t / T),
        danKnown: 1, msd: Float64Array.from({ length: 8 }, (_, k) => 10 + k), style: 1, source: 1, rate: 1, echo: e,
    };
}

function compareToReference(arch, inp, what) {
    const model = randomInfillModel(arch, { seed: 3, std: 1.5, styles: [{ key: "a", name: "a", maps: 40 }] });
    const net = loadInfill(model);
    const ref = referenceLogits(net, inp, inp.rows);
    const wanted = [];
    for (let b = 0; b < inp.T; b += 1) for (let l = 0; l < [4, 3, 6, 8][inp.div[b]]; l += 1) wanted.push([b, l]);
    const got = teacherForced(net, inp, inp.rows, wanted);
    let worst = 0;
    got.forEach((g, k) => {
        const [b, l] = wanted[k];
        g.forEach((v, c) => { worst = Math.max(worst, Math.abs(v - ref[(b * 8 + l) * 16 + c])); });
    });
    assert.ok(worst < 1e-4, `${what}: max |Δ| ${worst}`);
    return { net, ref };
}

test("a dense model of 4 beats × 1 layer matches hand-computed (dense reference) logits", () => {
    const arch = { ...TINY, enc_layers: 1, dec_layers: 1, win: 1, dec_win: 2, cross_win: 1, n_glob: 1 };
    compareToReference(arch, handInputs(4, { echo: [[3, 0, 0], [0, 3, 1]] }), "4 beats");
});

test("a zero model gives exactly the head's bias", () => {
    const model = randomInfillModel(TINY, { seed: 1 });
    for (const [name, shape] of Object.entries(infillShapes(model.arch))) model.weights[name] = encodeF16(new Float32Array(shape.reduce((a, b) => a * b, 1)));
    const bias = Float32Array.from({ length: 16 }, (_, k) => (k - 8) / 4);
    model.weights["head3.bias"] = encodeF16(bias);
    const inp = { ...handInputs(6), style: 0 };
    const got = teacherForced(loadInfill(model), inp, inp.rows, [[0, 0], [3, 2], [5, 3]]);
    for (const g of got) assert.deepEqual(g, Array.from(bias));
    assert.throws(() => teacherForced(loadInfill(model), { ...inp, style: 1 }, inp.rows, [[0, 0]]), /out of range/);
});

test("long windows, echo keys, mixed grids and 2 layers match the dense reference", () => {
    const inp = handInputs(30, { divs: [0, 0, 1, 3, 2, 0], echo: [[20, 3, 0], [3, 20, 1], [29, 10, 0], [12, 13, 0]] });
    compareToReference(TINY, inp, "30 beats");
});

// ---- the row source ----
const { samples, sampleRate } = clickTrack({ bpm: 150, offsetMs: 0, seconds: 24 });
const envelope = onsetEnvelope(samples, sampleRate);
const divPattern = [4, 4, 3, 3, 4, 6, 8, 4];
const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 22000, { divOf: (b) => divPattern[b % divPattern.length] });
const v2 = slotFeatures(envelope, slots, 150, AUDIO_FEATURES_V2);
const audio = { envelope, names: v2.names, rows: v2.rows };
const dan = new Float64Array(slots.length).fill(9);
const family = slots.map((s) => (s.beat % 16 < 8 ? "Stream" : "Jumpstream"));
const model = randomInfillModel(TINY, { seed: 7, std: 1.5 });

function build(prep, { offset = 0, seed = 1, fixedAt = null, from = 0, to = slots.length, weightOf = null, rngs = null } = {}) {
    const r = rngs ?? { fill: counted(seed), size: counted(seed + 1), pattern: counted(seed + 2) };
    const out = [];
    prep.begin();
    for (let i = from; i < to; i += 1) out.push(prep.step(i, offset, null, r, weightOf, fixedAt?.(i)));
    return { rows: out, rngs: r };
}

test("beat inputs: one token per beat, lanes in grid order, present flags, the divisor one-hot, visible from known", () => {
    const net = loadInfill(model);
    const known = new Uint8Array(slots.length).fill(255);
    known[5] = 9;
    const inp = buildInfillInputs(net, { audio, slots, dan, family, known });
    const beats = new Set(slots.map((s) => s.beat));
    assert.equal(inp.T, beats.size);
    const PRESENT = LANE_VALUES.indexOf("present");
    for (let b = 0; b < inp.T; b += 1) {
        const dv = [4, 3, 6, 8][inp.div[b]];
        assert.equal(dv, divPattern[b % divPattern.length]);
        for (let l = 0; l < 8; l += 1) assert.equal(inp.x[b * IN_DIM + l * 12 + PRESENT], l < dv ? 1 : 0, `beat ${b} lane ${l}`);
        assert.equal(inp.x[b * IN_DIM + 141 + inp.div[b]], 1);
    }
    assert.ok(inp.x.every(Number.isFinite));
    const phase = LANE_VALUES.indexOf("phase");
    slots.forEach((s, i) => assert.ok(Math.abs(inp.x[inp.beatOf[i] * IN_DIM + inp.laneOf[i] * 12 + phase] - s.pos / s.div) < 1e-6));
    assert.equal(inp.visible[inp.beatOf[5] * 8 + inp.laneOf[5]], 9);
    assert.equal(inp.visible.filter((v) => v !== 255).length, 1);
    assert.equal(inp.fam[0], 0);
    assert.equal(inp.fam[8], 1);
    // without columns from the caller, the v2 ones are computed from the envelope: the same numbers
    const own = buildInfillInputs(net, { audio: { envelope }, slots, dan, family });
    assert.deepEqual(own.x, buildInfillInputs(net, { audio, slots, dan, family }).x);
});

test("known slots and fixed slots are returned unchanged and consume no RNG", () => {
    const known = new Uint8Array(slots.length).fill(255);
    for (let i = 10; i < 60; i += 1) known[i] = (i * 7) % 16;
    const prep = infillSource.prepare({ model, audio, slots, dan, family, known });
    assert.equal(infillSource.caps.infill, true);
    const rngs = { fill: counted(1), size: counted(2), pattern: counted(3) };
    prep.begin();
    for (let i = 10; i < 60; i += 1) assert.equal(prep.step(i, 0, null, rngs, null), (i * 7) % 16);
    for (let i = 60; i < 90; i += 1) assert.equal(prep.step(i, 0, null, rngs, null, (i * 3) % 16), (i * 3) % 16);
    assert.equal(rngs.fill.calls + rngs.size.calls + rngs.pattern.calls, 0);
    prep.step(90, 0, null, rngs, null);
    assert.equal(rngs.fill.calls, 1);
});

test("changing fixed between builds never re-runs the encoder", () => {
    const before = infillStats.encodes;
    const prep = infillSource.prepare({ model, audio, slots, dan, family });
    assert.equal(infillStats.encodes - before, 1);
    const a = build(prep, { fixedAt: (i) => (i % 9 === 0 ? 5 : undefined) });
    const b = build(prep, { fixedAt: (i) => (i % 7 === 0 ? 10 : undefined) });
    build(prep, {});
    assert.equal(prep.stats.encodes, 1);
    assert.equal(infillStats.encodes - before, 1);
    assert.notDeepEqual(a.rows, b.rows);
    // a fixed row changes the free rows after it, never those before it
    const c = build(prep, { fixedAt: (i) => (i === 200 ? 15 : undefined) });
    const plain = build(prep, {});
    assert.deepEqual(c.rows.slice(0, 200), plain.rows.slice(0, 200));
});

test("decoding the whole map equals decoding with a snapshot/restore at a block boundary", () => {
    const prep = infillSource.prepare({ model, audio, slots, dan, family });
    const whole = build(prep, { seed: 4, offset: 1 }).rows;
    const cut = 300;
    const rngsA = { fill: counted(4), size: counted(5), pattern: counted(6) };
    prep.begin();
    for (let i = 0; i < cut; i += 1) prep.step(i, 1, null, rngsA, null);
    const snap = prep.snapshot();
    // a different try of the block after the cut …
    const other = { fill: counted(99), size: counted(98), pattern: counted(97) };
    for (let i = cut; i < slots.length; i += 1) prep.step(i, 1, null, other, null);
    // … then back to the cut, with the streams where they were
    prep.restore(snap);
    const tail = [];
    for (let i = cut; i < slots.length; i += 1) tail.push(prep.step(i, 1, null, rngsA, null));
    assert.deepEqual(tail, whole.slice(cut));
});

test("raising the knob gives more rows", () => {
    const prep = infillSource.prepare({ model, audio, slots, dan, family });
    const count = (offset) => build(prep, { offset, seed: 2 }).rows.filter(Boolean).length;
    const n = [-6, -2, 0, 2, 6].map(count);
    for (let k = 1; k < n.length; k += 1) assert.ok(n[k] >= n[k - 1], `knob steps: ${n.join(", ")}`);
    assert.ok(n[4] > n[0] + slots.length * 0.3, `knob steps: ${n.join(", ")}`);
});

test("weightOf 0 vetoes a row; when every row is vetoed the fallback is used", () => {
    const prep = infillSource.prepare({ model, audio, slots, dan, family });
    const no4 = Object.assign((m) => (m & 4 ? 0 : 1), { fallback: () => 2 });
    const rows = build(prep, { offset: 4, weightOf: no4 }).rows;
    assert.ok(rows.filter(Boolean).length > 100);
    assert.ok(rows.every((m) => !(m & 4)));
    let fell = 0;
    const none = Object.assign(() => 0, { fallback: () => { fell += 1; return 8; } });
    const all = build(prep, { offset: 4, weightOf: none }).rows;
    assert.ok(fell > 0 && all.every((m) => m === 0 || m === 8));
    assert.equal(all.filter((m) => m === 8).length, fell);
});

test("same seed, same output; begin() makes a build independent of the builds before it", () => {
    const p1 = infillSource.prepare({ model, audio, slots, dan, family });
    const p2 = infillSource.prepare({ model, audio, slots, dan, family });
    const a = build(p1, { seed: 11 }).rows;
    assert.deepEqual(build(p2, { seed: 11 }).rows, a);
    assert.deepEqual(build(p1, { seed: 11 }).rows, a);
    assert.notDeepEqual(build(p1, { seed: 12 }).rows, a);
    // part B alone vs part B after part A in the same prepare
    const alone = build(p2, { seed: 5, from: 400, to: 600 }).rows;
    build(p1, { seed: 6, from: 0, to: 400 });
    assert.deepEqual(build(p1, { seed: 5, from: 400, to: 600 }).rows, alone);
});

test("a step below the last decided slot starts a new build", () => {
    const prep = infillSource.prepare({ model, audio, slots, dan, family });
    const r = () => ({ fill: counted(3), size: counted(4), pattern: counted(5) });
    const first = [];
    const r1 = r();
    for (let i = 0; i < 120; i += 1) first.push(prep.step(i, 0, null, r1, null));
    const again = [];
    const r2 = r();
    for (let i = 0; i < 120; i += 1) again.push(prep.step(i, 0, null, r2, null)); // no begin(): i = 0 < 120
    assert.deepEqual(again, first);
});

test("echo keys come from structure.echoOf over barsOf(slots), pointing back and forward", () => {
    const net = loadInfill(model);
    const echoOf = new Int32Array(40).fill(-1);
    echoOf[12] = 2; // bar 12 repeats bar 2
    const inp = buildInfillInputs(net, { audio, slots, dan, family, structure: { echoOf } });
    // bars are 4 beats on a constant BPM: beat 48 + o echoes beat 8 + o
    for (let o = 0; o < 4; o += 1) {
        assert.equal(inp.echo[(48 + o) * 2], 8 + o);
        assert.equal(inp.echo[(8 + o) * 2 + 1], 48 + o);
    }
    assert.equal(inp.echo.filter((v) => v >= 0).length, 8);
    assert.deepEqual(buildInfillInputs(net, { audio, slots, dan, family }).echo.filter((v) => v >= 0), new Int32Array(0));
});

test("a real songStructure (bars without slot ranges) gives the same echo keys as barsOf bars", () => {
    const net = loadInfill(model);
    const stems = computeStemsSync(samples, sampleRate);
    const st = songStructure({ stems, slots, envelope });
    assert.ok(st.bars.length > 12 && st.bars[0].i0 === undefined);
    const echoOf = Int32Array.from(st.bars, () => -1);
    echoOf[12] = 2;
    const real = buildInfillInputs(net, { audio, slots, dan, family, structure: { ...st, echoOf } }).echo;
    const plain = buildInfillInputs(net, { audio, slots, dan, family, structure: { echoOf } }).echo;
    assert.deepEqual(real, plain);
    assert.ok(real.some((v) => v >= 0));
});

test("with stems and a structure the beat inputs are beatFeaturesV3, the dataset builder's numbers", () => {
    assert.equal(BEAT_FEATURES_V3, SHARED_BEAT_V3, "one list for the builder and the source");
    const net = loadInfill(model);
    const stems = computeStemsSync(samples, sampleRate);
    const structure = songStructure({ stems, slots, envelope });
    const inp = buildInfillInputs(net, { audio: { ...audio, stems }, slots, dan, family, structure });
    const beats = [];
    slots.forEach((s) => { if (s.pos === 0) beats.push({ t: s.t, beatMs: s.beatMs, bpm: s.bpm }); });
    const want = beatFeaturesV3(envelope, beats, { stems, structure }).rows;
    const B = BEAT_FEATURES_V3.length;
    const LANE_IN = IN_DIM - B - 4;
    let worst = 0;
    for (let b = 0; b < inp.T; b += 1) for (let k = 0; k < B; k += 1) worst = Math.max(worst, Math.abs(inp.x[b * IN_DIM + LANE_IN + k] - want[b * B + k]));
    assert.ok(worst < 1e-6, `${worst}`);
    const chroma = BEAT_FEATURES_V3.indexOf("chroma0");
    assert.ok(Array.from({ length: inp.T }, (_, b) => inp.x[b * IN_DIM + LANE_IN + chroma]).some((v) => v !== 0));
});

test("cond: style by key or index, the data source defaults to osu, msd null is unknown", () => {
    const styled = randomInfillModel(TINY, { seed: 2, styles: [{ key: "x", name: "X", maps: 50 }, { key: "y", name: "Y", maps: 40 }] });
    const net = loadInfill(styled);
    const base = { audio, slots, dan, family };
    assert.equal(buildInfillInputs(net, { ...base, cond: { style: "y" } }).style, 2);
    assert.equal(buildInfillInputs(net, { ...base, cond: { style: 0 } }).style, 1);
    assert.equal(buildInfillInputs(net, { ...base, cond: { style: -1 } }).style, 0);
    assert.equal(buildInfillInputs(net, { ...base, cond: { style: "nobody" } }).style, 0);
    assert.equal(buildInfillInputs(net, base).source, 1);
    assert.equal(buildInfillInputs(net, { ...base, cond: { source: "etterna" } }).source, 2);
    assert.equal(buildInfillInputs(net, { ...base, cond: { msd: null } }).msd, null);
    const p1 = infillSource.prepare({ model: styled, ...base, cond: { style: "x" } });
    const p2 = infillSource.prepare({ model: styled, ...base, cond: { style: "y" } });
    assert.notDeepEqual(build(p1, { offset: 2 }).rows, build(p2, { offset: 2 }).rows);
});

test("an empty slot list gives a source that makes no rows", () => {
    const prep = infillSource.prepare({ model, audio: {}, slots: [], dan: new Float64Array(0), family: [] });
    assert.equal(prep.step(0, 0, null, {}, null), 0);
});
