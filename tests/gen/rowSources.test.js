import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { slotFeatures, AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { sampleRow, sampleMask } from "../../src/gen/learnedModel.js";
import { xgbMarkovSource, sourceFor } from "../../src/gen/rowSources.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const singles = [1, 2, 4, 8];
const stream = {};
for (const a of [0, ...singles]) for (const b of [0, ...singles]) {
    stream[`${a},${b},1`] = Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10 + m]));
}
stream["1,2,2"] = { 5: 30, 12: 30 };
const pattern = { Stream: stream };
const counted = (seed) => {
    const rng = mulberry32(seed);
    const f = () => { f.calls += 1; return rng(); };
    f.calls = 0;
    return f;
};

test("with weightOf ≡ 1 the same RNG gives the same rows, and draws the same number of times", () => {
    const one = Object.assign(() => 1, { fallback: () => 15 });
    const a = counted(3);
    const b = counted(3);
    let pa = 0, pb = 0, qa = 0, qb = 0;
    for (let k = 0; k < 300; k += 1) {
        const ma = sampleRow(pattern, "Stream", pa, qa, [1, 0.5, 0.2, 0.1], a);
        const mb = sampleRow(pattern, "Stream", pb, qb, [1, 0.5, 0.2, 0.1], b, one);
        assert.equal(mb, ma, `row ${k}`);
        [qa, pa, qb, pb] = [pa, ma, pb, mb];
    }
    assert.equal(a.calls, b.calls);
    const c = counted(5);
    const d = counted(5);
    for (let k = 0; k < 50; k += 1) assert.equal(sampleMask(pattern, "Stream", 1, 2, 2, d, one), sampleMask(pattern, "Stream", 1, 2, 2, c));
    assert.equal(c.calls, d.calls);
});

test("a zero weight vetoes a row; when every row is vetoed the fallback is used", () => {
    const no4 = Object.assign((m) => (m & 4 ? 0 : 1), { fallback: () => 99 });
    for (let s = 0; s < 100; s += 1) assert.equal(sampleRow(pattern, "Stream", 1, 2, [1, 1, 1, 1], mulberry32(s), no4) & 4, 0);
    const none = Object.assign(() => 0, { fallback: () => 99 });
    assert.equal(sampleRow(pattern, "Stream", 1, 2, [1, 1, 1, 1], mulberry32(1), none), 99);
    assert.equal(sampleMask(pattern, "Stream", 1, 2, 2, mulberry32(1), none), 99);
});

test("order-3 tables use the last three rows when they are well seen, else order 2", () => {
    const deep = { Stream: { "1,2,4,1": { 8: 50 }, "1,2,8,1": { 4: 1 }, "1,2,2,1": { 4: 30 } } };
    for (let s = 0; s < 20; s += 1) assert.equal(sampleRow(deep, "Stream", 1, 2, [1, 1, 1, 1], mulberry32(s), null, 4), 8);
    // the context 1,2,8 has one sighting: the order-2 counts of (1,2) decide
    const picks = new Set(Array.from({ length: 40 }, (_, s) => sampleRow(deep, "Stream", 1, 2, [1, 1, 1, 1], mulberry32(s), null, 8)));
    assert.ok(picks.has(4) && picks.has(8));
});

const { samples, sampleRate } = clickTrack({ bpm: 120, offsetMs: 0, seconds: 20 });
const envelope = onsetEnvelope(samples, sampleRate);
const constant = (logit) => ({
    features: AUDIO_FEATURES, families: ["Stream"],
    note: { baseline: [logit], classes: [0, 1], iterations: [] },
    size: { baseline: [3, 0, -2, -4], classes: [1, 2, 3, 4], iterations: [] },
    pattern,
});

test("the XGB source draws fill and size once per slot and follows the knob", () => {
    const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 19000);
    const audio = { envelope, ...slotFeatures(envelope, slots, 120, AUDIO_FEATURES) };
    const prep = xgbMarkovSource.prepare({ model: constant(0), audio, slots, dan: new Float64Array(slots.length).fill(5), family: slots.map(() => "Stream") });
    const fill = counted(1);
    const size = counted(2);
    let rows = 0;
    const ctx = { prev: 0, prev2: 0, recent: [] };
    for (let i = 0; i < slots.length; i += 1) {
        const m = prep.step(i, 3, ctx, { fill, size, pattern: mulberry32(9) });
        if (m) {
            rows += 1;
            ctx.prev2 = ctx.prev;
            ctx.prev = m;
        }
    }
    assert.equal(fill.calls, slots.length);
    assert.equal(size.calls, slots.length);
    assert.ok(rows > 0.9 * slots.length, `${rows}`);
});

test("for a 1/4-only model a triplet beat expects as many rows as its four quarters", () => {
    const divs = (i) => (i % 2 ? 3 : 4);
    const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 19000, { divOf: divs });
    const audio = { envelope, ...slotFeatures(envelope, slots, 120, AUDIO_FEATURES) };
    const prep = xgbMarkovSource.prepare({ model: constant(-1), audio, slots, dan: new Float64Array(slots.length).fill(5), family: slots.map(() => "Stream") });
    const sig = (x) => 1 / (1 + Math.exp(-x));
    const beat = slots.filter((s) => s.beat === 5).map((s) => slots.indexOf(s));
    assert.equal(beat.length, 3);
    const expected = beat.reduce((a, i) => a + sig(prep.noteRaw[i]), 0);
    assert.ok(Math.abs(expected - 4 * sig(-1)) < 1e-3, `${expected}`);
    const plain = slots.filter((s) => s.beat === 4).map((s) => slots.indexOf(s));
    assert.ok(plain.every((i) => Math.abs(prep.noteRaw[i] + 1) < 1e-9));
    // a model trained on every grid is left alone
    const v2 = xgbMarkovSource.prepare({ model: { ...constant(-1), grid: "snap-v2" }, audio, slots, dan: new Float64Array(slots.length).fill(5), family: slots.map(() => "Stream") });
    assert.ok(beat.every((i) => Math.abs(v2.noteRaw[i] + 1) < 1e-9));
});

test("sourceFor picks the XGB source for tree models", async () => {
    assert.equal(await sourceFor({}), xgbMarkovSource);
    assert.equal(await sourceFor({ kind: "xgb-v2" }), xgbMarkovSource);
});

// ---- G4: mapper style for the XGB path (stylePattern blended into the Markov counts, styleBias on the note odds) ----

const fiveEverywhere = (n) => {
    const t = {};
    for (const a of [0, ...singles, 5, 12]) for (const b of [0, ...singles, 5, 12]) t[`${a},${b},2`] = { 5: n };
    return t;
};
const rowsWith = (style, seed = 11, count = 400) => {
    const rng = mulberry32(seed);
    let p = 0;
    let q = 0;
    const out = [];
    for (let k = 0; k < count; k += 1) {
        const m = style === undefined
            ? sampleRow(pattern, "Stream", p, q, [1, 1, 1, 1], rng)
            : sampleRow(pattern, "Stream", p, q, [1, 1, 1, 1], rng, null, null, null, style);
        out.push(m);
        [q, p] = [p, m];
    }
    return out;
};
const share = (rows, m) => rows.filter((x) => x === m).length / rows.length;

test("G4: a style table that always continues with mask 5 raises the share of mask 5; no style gives today's rows", () => {
    const plain = rowsWith(undefined);
    assert.deepEqual(rowsWith(null), plain);
    const styled = rowsWith({ pattern: { Stream: fiveEverywhere(30) }, alpha: 4 });
    assert.ok(share(styled, 5) > share(plain, 5) + 0.25, `share of 5: ${share(styled, 5).toFixed(2)} vs ${share(plain, 5).toFixed(2)}`);
    // a creator seen fewer than MIN_EVIDENCE times at the level the global table uses leaves its counts alone (two
    // sightings per context: 14 after one row, under 20)
    assert.deepEqual(rowsWith({ pattern: { Stream: fiveEverywhere(2) }, alpha: 4 }), plain);
    // a family the creator never mapped: the global table alone
    assert.deepEqual(rowsWith({ pattern: { Jack: fiveEverywhere(30) }, alpha: 4 }), plain);
});

test("G4: the XGB source reads stylePattern and styleBias for the chosen style only", () => {
    const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 19000);
    const audio = { envelope, ...slotFeatures(envelope, slots, 120, AUDIO_FEATURES) };
    const base = constant(-1);
    const styledModel = { ...base, stylePattern: { "n:five": { Stream: fiveEverywhere(30) } }, styleBias: { "n:five": 2 }, styles: [{ key: "n:five", name: "Five", maps: 40 }] };
    const args = { audio, slots, dan: new Float64Array(slots.length).fill(5), family: slots.map(() => "Stream") };
    const decode = (prep) => {
        const fill = mulberry32(1);
        const size = mulberry32(2);
        const pat = mulberry32(3);
        const ctx = { prev: 0, prev2: 0, recent: [] };
        const out = [];
        for (let i = 0; i < slots.length; i += 1) {
            const m = prep.step(i, 3, ctx, { fill, size, pattern: pat });
            out.push(m);
            if (m) {
                ctx.prev2 = ctx.prev;
                ctx.prev = m;
                ctx.recent.unshift({ mask: m, gapMs: 250 });
            }
        }
        return out;
    };
    const today = xgbMarkovSource.prepare({ model: base, ...args });
    const none = xgbMarkovSource.prepare({ model: styledModel, ...args, style: null });
    const styled = xgbMarkovSource.prepare({ model: styledModel, ...args, style: "n:five" });
    const unknown = xgbMarkovSource.prepare({ model: styledModel, ...args, style: "n:nobody" });
    assert.deepEqual(Array.from(none.noteRaw), Array.from(today.noteRaw));
    assert.deepEqual(Array.from(unknown.noteRaw), Array.from(today.noteRaw));
    assert.ok(Array.from(styled.noteRaw).every((v, i) => Math.abs(v - (today.noteRaw[i] + 2)) < 1e-12));
    assert.deepEqual(decode(none), decode(today));
    assert.deepEqual(decode(unknown), decode(today));
    const rows = decode(styled).filter(Boolean);
    const plainRows = decode(today).filter(Boolean);
    assert.ok(share(rows, 5) > share(plainRows, 5) + 0.25, `share of 5: ${share(rows, 5).toFixed(2)} vs ${share(plainRows, 5).toFixed(2)}`);
});
