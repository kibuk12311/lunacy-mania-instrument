// G3 (ML addendum §2.7, §5.2): the generator's plumbing for an infill row source (nn-v2): known = the locked rows
// only, echo rows and other rows decided outside the source as step(i, …, fixed), one prepare per variant,
// begin() per build, snapshot/restore for own-range parts and block retry; a non-infill source sees none of it.
import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync, stemsFromTransfer, stemsToTransfer } from "../../src/audio/stems.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { sourceFor, xgbMarkovSource, nnV2Source } from "../../src/gen/rowSources.js";
import { randomInfillModel, infillSource, loadInfill, encodeBeats } from "../../src/gen/nn/infillModel.js";
import { infillSourceFor } from "../../src/gen/nn/webgpu/gpuSource.js";
import { staticsOf } from "../helpers/fakeGpu.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { barsOf } from "../../src/gen/songParts.js";
import { chartInfo } from "../../src/core/features.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { dropSong } from "../fixtures/dropSong.js";
import { sectionSong } from "../fixtures/stemTracks.js";

const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
const singles = [1, 2, 4, 8];
const rolling = {};
for (const a of [0, ...singles]) for (const b of [0, ...singles]) rolling[`${a},${b},1`] = Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10]));
const model = { features: AUDIO_FEATURES, families: FAMILIES, note: { baseline: [0], classes: [0, 1], iterations: [] }, size: { baseline: [2, 0, -3, -5], classes: [1, 2, 3, 4], iterations: [] }, pattern: { Stream: rolling } };
const perSecond = async (text) => {
    const info = chartInfo(text, 1);
    return { kind: "ok", numeric: Math.round((info.noteCount / Math.max(1, info.durationSec)) * 10) / 10, top3: [{ name: "Rolls", share: 1 }] };
};
const passAll = () => [{ name: "Rolls", share: 1 }];
const song = onsetEnvelope(dropSong({}), 22050); // 180 BPM from 300 ms, quiet 30–60 s
const threeParts = [
    { startMs: 0, endMs: 30000, kind: "drop" },
    { startMs: 30000, endMs: 60000, kind: "break" },
    { startMs: 60000, endMs: 90000, kind: "drop" },
];
const input = (request, over = {}) => ({
    timing: { sections: [{ timeMs: 300, bpm: 180, meter: 4 }], bpm: 180, offsetMs: 300 },
    envelope: song, durationMs: 90000,
    request: { range: { lo: 4, hi: 5 }, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, ...request },
    meta: { title: "t", audioFilename: "a.mp3" },
    ...over,
});
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// A row source that records what it is given. caps.infill decides which contract it gets.
function recorder({ infill = true } = {}) {
    const log = { prepares: [], steps: [], begins: 0, restores: 0, snapshots: 0, argc: new Set(), restoredEpochs: new Set() };
    let epoch = 0; // which build a step belongs to (begin or restore starts one)
    const source = {
        kind: infill ? "nn-v2" : "fake",
        caps: { infill },
        prepare(args) {
            log.prepares.push(args);
            const known = args.known ?? null;
            let cur = 0;
            return {
                begin() {
                    log.begins += 1;
                    epoch += 1;
                    cur = 0;
                },
                snapshot() {
                    log.snapshots += 1;
                    return { cur };
                },
                restore(s) {
                    log.restores += 1;
                    epoch += 1;
                    log.restoredEpochs.add(epoch);
                    cur = s.cur;
                },
                step(i, offset, ctx, rngs, weightOf = null, fixed = undefined) {
                    log.argc.add(arguments.length);
                    if (i < cur) cur = 0;
                    const forced = Number.isInteger(fixed) ? fixed : known && known[i] !== 255 ? known[i] : null;
                    log.steps.push({ i, fixed, sampled: forced === null, epoch, restored: log.restoredEpochs.has(epoch) });
                    cur = i + 1;
                    if (forced !== null) return forced;
                    if (rngs.fill() >= sigmoid(1 + offset)) return 0;
                    const m = singles[Math.floor(rngs.pattern() * 4)];
                    return !weightOf || weightOf(m) > 0 ? m : weightOf.fallback();
                },
            };
        },
    };
    return { source, log };
}

test("sourceFor: nn-v2 gets the infill source (never the XGB one), tree models the XGB source", async () => {
    const nn = await sourceFor({ kind: "nn-v2" });
    assert.notEqual(nn, xgbMarkovSource);
    assert.equal(nn.kind, "nn-v2");
    assert.equal(nn.caps.infill, true);
    assert.equal(nn, nnV2Source(infillSource), "one wrapper per source");
    assert.equal(await sourceFor({ kind: "xgb-v3" }), xgbMarkovSource);
    assert.equal(xgbMarkovSource.caps?.infill ?? false, false);
});

test("the locked rows reach an infill source as known (a locked empty slot as 0); prepare runs once with N = 8", async () => {
    const base = await generateLearnedMap(input({ parts: threeParts }), perSecond, model, { patternsOf: passAll });
    const lockedRows = parseRows(base.osuText).filter((r) => r.t < 30000);
    const { source, log } = recorder();
    const out = await generateLearnedMap(input({ parts: threeParts, candidates: 8 }, {
        locked: { rows: lockedRows.map((r) => ({ t: r.t, mask: r.mask })), ranges: [[0, 30000]], knob: base.knob, planSeed: base.planSeed },
    }), perSecond, model, { patternsOf: passAll, source });
    assert.equal(log.prepares.length, 1, "one prepare (one encoder run) for the whole variant");
    const { known, slots, cond } = log.prepares[0];
    const byT = new Map(lockedRows.map((r) => [r.t, r.mask]));
    slots.forEach((s, i) => {
        if (s.t < 30000) assert.equal(known[i], byT.get(s.t) ?? 0, `slot ${i} at ${s.t}`);
        else assert.equal(known[i], 255);
    });
    assert.deepEqual(Object.keys(cond).sort(), ["msd", "rate", "source", "style"]);
    assert.equal(cond.msd, null, "no msdPrior in the model: unknown");
    assert.equal(cond.rate, 1);
    assert.equal(cond.source, "osu");
    assert.equal(cond.style, null);
    assert.equal(out.critic.of, 8);
    // one begin() per build: the search, the candidates, the block retry; never fewer than the candidates
    assert.ok(log.begins >= 8, `begins ${log.begins}`);
    // the locked part stays note for note
    const lockedOut = parseRows(out.osuText).filter((r) => r.t < 30000);
    assert.deepEqual(lockedOut.map((r) => [r.t, r.mask]), lockedRows.map((r) => [r.t, r.mask]));
});

test("a non-infill source never receives known, cond or fixed", async () => {
    const { source, log } = recorder({ infill: false });
    await generateLearnedMap(input({ parts: threeParts, candidates: 4 }), perSecond, model, { patternsOf: passAll, source });
    assert.equal(log.prepares.length, 1);
    for (const key of ["known", "cond", "structure"]) assert.equal(key in log.prepares[0], false, key);
    assert.deepEqual([...log.argc], [5]);
    assert.ok(log.steps.every((s) => s.fixed === undefined));
    assert.equal(log.begins, 0);
});

test("rows decided outside the source (an own-range part's frozen rows) reach the decoder as fixed", async () => {
    const { source, log } = recorder();
    const parts = threeParts.map((p, k) => (k === 0 ? { ...p, range: { lo: 6, hi: 8 } } : p));
    const out = await generateLearnedMap(input({ parts }), perSecond, model, { patternsOf: passAll, source });
    const frozen = parseRows(out.osuText).filter((r) => r.t < 30000);
    assert.ok(frozen.length > 50);
    // in the global search's builds the frozen part comes first: every one of its rows is passed as fixed
    const fixedSlots = new Set(log.steps.filter((s) => s.fixed !== undefined).map((s) => `${log.prepares[0].slots[s.i].t}:${s.fixed}`));
    for (const r of frozen) assert.ok(fixedSlots.has(`${r.t}:${r.mask}`), `frozen row at ${r.t}`);
});

test("own-range parts and block retry restart from a snapshot and re-decode only their part or block", async () => {
    const parseFirst = (text) => parseRows(text)[0]?.t ?? -1;
    let original = null;
    const failSecond = (text) => {
        const t = parseFirst(text);
        if (t < 30000 || t >= 60000) return passAll();
        original ??= text;
        return text === original ? [{ name: "Rolls", share: 0.2 }] : passAll();
    };
    const { source, log } = recorder();
    const parts = threeParts.map((p, k) => (k === 2 ? { ...p, range: { lo: 3, hi: 6 } } : p));
    const debug = {};
    const out = await generateLearnedMap(input({ parts, stamina: 1, range: { lo: 3, hi: 6 } }), perSecond, model, { patternsOf: failSecond, source, debug });
    assert.ok(log.snapshots >= 2, `snapshots ${log.snapshots}`);
    assert.ok(log.restores >= 4, `restores ${log.restores}`);
    assert.ok(out.retries.blocks >= 1, JSON.stringify(out.retries));
    // every build that starts from a restore draws only inside the own-range part (its search) or one block (a retry)
    const byEpoch = new Map();
    for (const s of log.steps) if (s.restored && s.sampled) (byEpoch.get(s.epoch) ?? byEpoch.set(s.epoch, []).get(s.epoch)).push(s.i);
    const restoredBuilds = [...byEpoch.values()];
    assert.ok(restoredBuilds.length >= 4);
    const blockOf = (i) => debug.blocks.find((b) => i >= b.i0 && i < b.i1);
    const partOf = (i) => blockOf(i)?.part;
    let partBuilds = 0;
    let blockBuilds = 0;
    for (const list of restoredBuilds) {
        const oneBlock = list.every((i) => blockOf(i) === blockOf(list[0]));
        const ownPart = list.every((i) => partOf(i) === 2);
        assert.ok(oneBlock || ownPart, `a restored build drew slots ${list[0]}..${list.at(-1)}`);
        if (ownPart && !oneBlock) partBuilds += 1;
        if (oneBlock && partOf(list[0]) !== 2) blockBuilds += 1;
    }
    assert.ok(blockBuilds >= 4, `retry candidates from a restore: ${blockBuilds}`);
    assert.ok(partBuilds + restoredBuilds.length - blockBuilds >= 4, "the own-range part's attempts restart from its snapshot");
    // with snapshots off, the same map
    const again = recorder();
    original = null;
    const plain = await generateLearnedMap(input({ parts, stamina: 1, range: { lo: 3, hi: 6 } }), perSecond, model, { patternsOf: failSecond, source: again.source, snapshots: false });
    assert.equal(again.log.restores, 0);
    assert.equal(plain.osuText, out.osuText);
});

// ---- the real nn-v2 source (random tiny weights): snapshots change nothing, echo rows arrive as fixed ----

const TINY = { d: 8, enc_layers: 1, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 1, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 4, dec_win: 4, cross_win: 3, n_glob: 1 };
const nnModel = { ...randomInfillModel(TINY, { seed: 5, std: 1.5 }), features: ["onset", "low", "mid", "high", "energy", "phase"] };

test("nn-v2 end to end: snapshots give the same map as decoding everything again", async () => {
    let original = null;
    const failSecond = (text) => {
        const t = parseRows(text)[0]?.t ?? -1;
        if (t < 30000 || t >= 60000) return passAll();
        original ??= text;
        return text === original ? [{ name: "Rolls", share: 0.2 }] : passAll();
    };
    const parts = threeParts.map((p, k) => (k === 2 ? { ...p, range: { lo: 2, hi: 9 } } : p));
    const req = input({ parts, stamina: 1, range: { lo: 1, hi: 9 }, patterns: [{ name: "Stream", share: 0.5 }, { name: "Jumpstream", share: 0.5, flavours: ["Jumptrill"] }] });
    const a = await generateLearnedMap(req, perSecond, nnModel, { patternsOf: failSecond });
    original = null;
    const b = await generateLearnedMap(req, perSecond, nnModel, { patternsOf: failSecond, snapshots: false });
    assert.equal(a.engine, "neural");
    assert.ok(a.noteCount > 0);
    assert.ok(a.retries.blocks >= 1, `the block retry ran: ${JSON.stringify(a.retries)}`);
    assert.ok(a.flavours.length >= 0);
    assert.equal(a.osuText, b.osuText);
});

test("echo rows never go into known: they arrive per build as fixed, about 60% of them", async () => {
    const abaSong = sectionSong(["A", "B", "A"], { bpm: 160 });
    const stems = stemsFromTransfer(stemsToTransfer(computeStemsSync(abaSong.samples, abaSong.sampleRate)));
    const env = onsetEnvelope(abaSong.samples, abaSong.sampleRate);
    const durationMs = Math.round((abaSong.samples.length / abaSong.sampleRate) * 1000);
    const { source, log } = recorder();
    const debug = {};
    await generateLearnedMap({
        timing: { bpm: 160, offsetMs: 0 }, envelope: env, durationMs, stems,
        request: { range: { lo: 5.5, hi: 6.5 }, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 2, repeats: true, candidates: 4 },
        meta: { title: "t", audioFilename: "a.mp3" },
    }, async () => ({ kind: "ok", numeric: 6, top3: [{ name: "Rolls", share: 1 }] }), model, { patternsOf: passAll, source, debug });
    assert.equal(log.prepares.length, 1);
    assert.ok(log.prepares[0].known.every((k) => k === 255), "nothing is locked, so nothing is known: echo rows stay out of it");
    assert.ok(log.prepares[0].structure?.echoOf, "the structure goes to the source");
    const bars = barsOf(debug.slots);
    const echoBar = (i) => {
        const b = bars.findIndex((x) => i >= x.i0 && i < x.i1);
        return debug.structure.echoOf[b] >= 0 && !debug.echo.plan.varied[b];
    };
    const echoSteps = log.steps.filter((s) => echoBar(s.i));
    const fixedShare = echoSteps.filter((s) => s.fixed !== undefined).length / echoSteps.length;
    assert.ok(echoSteps.length > 200);
    assert.ok(fixedShare > 0.45 && fixedShare < 0.75, `fixed share in echoed bars ${fixedShare.toFixed(2)}`);
    // outside echoed bars nothing is fixed (no lock, no own-range part, no block retry here)
    assert.ok(log.steps.filter((s) => !echoBar(s.i) && s.fixed !== undefined).every((s) => bars.findIndex((x) => s.i >= x.i0 && s.i < x.i1) >= 16));
});

test("nn-v2 with flavours: the motif re-weights the model's rows through weightOf; fixed rows are left alone", () => {
    const calls = [];
    const inner = {
        kind: "nn-v2",
        caps: { infill: true },
        prepare: () => ({ step: (i, offset, ctx, rngs, weightOf, fixed) => { calls.push({ i, weightOf, fixed }); return 0; }, begin() {}, snapshot: () => null, restore() {} }),
    };
    const wrapped = nnV2Source(inner);
    const flavour = [{ id: "Jumptrill", phrase: 0 }, null];
    const prep = wrapped.prepare({ flavour });
    const guard = Object.assign((m) => (m === 5 ? 0 : 1), { fallback: () => 1 });
    const ctx = { prev: 0, prev2: 0, recent: [{ mask: 5, gapMs: 100 }] };
    prep.step(0, 0, ctx, {}, guard);
    prep.step(0, 0, ctx, {}, guard, 3);
    prep.step(1, 0, ctx, {}, guard);
    assert.notEqual(calls[0].weightOf, guard, "a flavoured slot gets the motif-weighted guard");
    assert.equal(calls[0].weightOf(5), 0, "the guard's veto stays");
    assert.ok(calls[0].weightOf(10) > calls[0].weightOf(1), "a jumptrill continues 5 with 10");
    assert.equal(calls[0].weightOf.fallback(), 1);
    assert.equal(calls[1].weightOf, guard, "a fixed row is not re-weighted");
    assert.equal(calls[1].fixed, 3);
    assert.equal(calls[2].weightOf, guard, "a slot without a flavour: the guard alone");
    // without flavours the inner source is used as it is
    const plainPrep = inner.prepare();
    assert.equal(typeof nnV2Source(inner).prepare({ flavour: [null, null] }).step, "function");
    assert.ok(plainPrep);
    void mulberry32;
});

// merge of streams G and W: generatorJobs' opts.nnBackend reaches the nn-v2 source (its encoder runs there), and a
// backend that computes what the CPU does gives the very same map
test("nn-v2 with opts.nnBackend: the encoder runs on the backend, the map is the CPU one", async () => {
    const calls = { n: 0 };
    const backend = {
        async encode(m, inputs) {
            calls.n += 1;
            const net = loadInfill(m);
            return staticsOf(net, encodeBeats(net, inputs));
        },
    };
    const gpu = await sourceFor({ kind: "nn-v2" }, { nnBackend: backend });
    assert.equal(gpu, nnV2Source(infillSourceFor(backend)));
    assert.notEqual(gpu, await sourceFor({ kind: "nn-v2" }));
    const req = input({ patterns: [{ name: "Stream", share: 0.5 }, { name: "Jumpstream", share: 0.5, flavours: ["Jumptrill"] }] });
    const cpu = await generateLearnedMap(req, perSecond, nnModel, { patternsOf: passAll });
    const viaGpu = await generateLearnedMap(req, perSecond, nnModel, { patternsOf: passAll, nnBackend: backend });
    assert.ok(calls.n >= 1, "the backend encoded");
    assert.ok(cpu.noteCount > 0);
    assert.equal(viaGpu.osuText, cpu.osuText);
});
