// Stream W, D3/D4: builds stepped together on the GPU decoder (src/gen/nn/webgpu/gpuBatch.js) and the decode sessions
// of the worker ↔ GPU renderer link (gpuServer.js / gpuClient.js). The GPU is a CPU stand-in: exactBackend (its
// answers give the CPU source's very logits, so a batch must sample the CPU's rows exactly) or fakeInfillGpu behind a
// real server over MessagePorts (the GPU's split lane head).
import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { infillSource, loadInfill, randomInfillModel, buildInfillInputs, encodeBeats } from "../../../src/gen/nn/infillModel.js";
import { createGpuBatch, STEP_WAIT, MIN_BATCH, ROUND_RATIO, ROUND_PRIOR_MS, PROBE_ROUNDS, PROBE_MS, CPU_PROBES } from "../../../src/gen/nn/webgpu/gpuBatch.js";
import { createGpuInfillSource, normalizedInputs } from "../../../src/gen/nn/webgpu/gpuSource.js";
import { createGpuServer } from "../../../src/gen/nn/webgpu/gpuServer.js";
import { createGpuClient } from "../../../src/gen/nn/webgpu/gpuClient.js";
import { exactBackend, exactHead, exactGpuSource, fakeInfillGpu, staticsOf } from "../../helpers/fakeGpu.js";
import { slotsForTiming } from "../../../src/gen/grid.js";
import { onsetEnvelope } from "../../../src/audio/onset.js";
import { clickTrack } from "../../fixtures/clickTrack.js";
import { mulberry32 } from "../../../src/gen/rng.js";

const TINY = { d: 8, enc_layers: 2, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 2, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 4, dec_win: 4, cross_win: 3, n_glob: 2 };
const model = randomInfillModel(TINY, { seed: 7, std: 1.5 });
const net = loadInfill(model);
const { samples, sampleRate } = clickTrack({ bpm: 150, offsetMs: 0, seconds: 30 });
const envelope = onsetEnvelope(samples, sampleRate);
const divPattern = [4, 4, 3, 3, 4, 6, 8, 4];
const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 28000, { divOf: (b) => divPattern[b % divPattern.length] });
const dan = new Float64Array(slots.length).fill(9);
const family = slots.map(() => "Stream");
const known = new Uint8Array(slots.length).fill(255);
for (let i = 30; i < 45; i += 1) known[i] = (i * 5) % 16;
const args = { model, audio: { envelope }, slots, dan, family, known };
const inputs = buildInfillInputs(net, args);
const rngsOf = (seed) => ({ fill: mulberry32(seed), size: mulberry32(seed + 1), pattern: mulberry32(seed + 2) });
const cpu = infillSource.prepare(args);

// the CPU source's build of slots [0, upTo) with a seed (fixedAt: rows decided outside the source)
function cpuBuild(seed, { upTo = slots.length, fixedAt = null, prep = cpu } = {}) {
    const r = rngsOf(seed);
    prep.begin();
    return Array.from({ length: upTo }, (_, i) => prep.step(i, 0.5, null, r, null, fixedAt?.(i)));
}
// the same build as a batch maker
const maker = (seed, { upTo = slots.length, fixedAt = null, throwAt = -1 } = {}) => function* build(s) {
    const r = rngsOf(seed);
    s.begin();
    const out = [];
    for (let i = 0; i < upTo; i += 1) {
        if (i === throwAt) throw new Error("a build failed");
        let m = s.step(i, 0.5, null, r, null, fixedAt?.(i));
        if (m === STEP_WAIT) m = yield STEP_WAIT;
        out.push(m);
    }
    return out;
};
const enc = () => ({ T: inputs.T, d: net.arch.d, out: null, xn: normalizedInputs(net, inputs), ...staticsOf(net, encodeBeats(net, inputs)) });
async function batchOver(backend, over = {}) {
    const got = await backend.encode(model, inputs, { keep: true });
    return createGpuBatch({ backend, session: got.session, net, enc: { ...enc(), e2d: got.e2d, cross: got.cross }, inputs, known, head: exactHead, ...over });
}

test("lockstep: the builds waiting together share one decode per beat, a build that ends drops out, rows = the CPU's", async () => {
    const backend = exactBackend();
    const batch = await batchOver(backend);
    const fixedAt = (i) => (i % 13 === 0 ? 7 : undefined);
    const plan = [{ seed: 5 }, { seed: 6, upTo: 60 }, { seed: 7, fixedAt }, { seed: 8, upTo: 130 }];
    const rows = await batch.run(plan.map((p) => maker(p.seed, p)));
    plan.forEach((p, k) => assert.deepEqual(rows[k], cpuBuild(p.seed, p), `build ${k}`));
    // one round per decoded beat (a few multi-beat items over the known stretch), all four together at first
    assert.equal(backend.rounds[0], 4);
    assert.ok(backend.rounds.length <= inputs.T + 2, `${backend.rounds.length} rounds for ${inputs.T} beats`);
    const lastBeatOf = (upTo) => inputs.beatOf[upTo - 1];
    // after build 1 (60 slots) ends, every round carries at most 3; after build 3 at most 2
    const fourUntil = backend.rounds.findIndex((n) => n < 4);
    assert.ok(fourUntil > 0 && fourUntil <= lastBeatOf(60) + 1, `the 60-slot build left at round ${fourUntil}`);
    assert.ok(backend.rounds.slice(fourUntil).every((n) => n <= 3));
    assert.equal(backend.rounds.at(-1), 2);
    assert.equal(batch.stats.maxBatch, 4);
    assert.equal(batch.off, false);
    // every stream's ring is freed after the batch (copies none, frees four)
    await new Promise((r) => setImmediate(r));
    assert.equal(backend.sessions.get(1).rings.size, 0);
    assert.equal(MIN_BATCH, 2);
});

test("snapshots: builds restored from a GPU snapshot decode on from it and give the CPU's rows", async () => {
    const backend = exactBackend();
    const batch = await batchOver(backend);
    const cut = 70;
    const head = function* snap(s) {
        const r = rngsOf(3);
        s.begin();
        for (let i = 0; i < cut; i += 1) if (s.step(i, 0.5, null, r, null) === STEP_WAIT) yield STEP_WAIT;
        return s.snapshot();
    };
    const snap = await batch.snapshot(head);
    assert.ok(snap.ref !== null);
    const tail = (seed) => function* build(s) {
        s.restore(snap);
        const r = rngsOf(seed);
        const out = [];
        for (let i = cut; i < slots.length; i += 1) {
            let m = s.step(i, 0.5, null, r, null);
            if (m === STEP_WAIT) m = yield STEP_WAIT;
            out.push(m);
        }
        return out;
    };
    const got = await batch.run([tail(11), tail(12), tail(13)]);
    // the CPU: the same head, snapshot, then each tail
    const r = rngsOf(3);
    cpu.begin();
    for (let i = 0; i < cut; i += 1) cpu.step(i, 0.5, null, r, null);
    const s0 = cpu.snapshot();
    [11, 12, 13].forEach((seed, k) => {
        cpu.restore(s0);
        const rr = rngsOf(seed);
        assert.deepEqual(got[k], Array.from({ length: slots.length - cut }, (_, j) => cpu.step(cut + j, 0.5, null, rr, null)), `tail ${seed}`);
    });
    batch.drop(snap);
    await new Promise((res) => setImmediate(res));
    assert.equal(backend.sessions.get(1).rings.size, 0, "the snapshot's ring went with drop()");
});

test("a build that throws fails the batch with its error; the others stop, their rings are freed, the next batch runs", async () => {
    const backend = exactBackend();
    const batch = await batchOver(backend);
    await assert.rejects(batch.run([maker(1), maker(2, { throwAt: 50 }), maker(3)]), /a build failed/);
    await new Promise((r) => setImmediate(r));
    assert.equal(backend.sessions.get(1).rings.size, 0);
    assert.equal(batch.off, false, "a build's own error is not the GPU's");
    const rows = await batch.run([maker(4), maker(5)]);
    assert.deepEqual(rows, [cpuBuild(4), cpuBuild(5)]);
});

test("a GPU error mid-batch: the batch finishes on the CPU with the CPU's rows, and the batch is off from then on", async () => {
    for (const at of [1, 2, 17, 60]) {
        const errors = [];
        const backend = exactBackend({ fail: (round) => round === at });
        const batch = await batchOver(backend, { onError: (e) => errors.push(e.message) });
        const fixedAt = (i) => (i % 11 === 0 ? 3 : undefined);
        const rows = await batch.run([maker(5), maker(6, { fixedAt }), maker(7, { upTo: 90 })]);
        assert.deepEqual(rows, [cpuBuild(5), cpuBuild(6, { fixedAt }), cpuBuild(7, { upTo: 90 })], `failing at round ${at}`);
        assert.deepEqual(errors, ["device lost"]);
        assert.equal(batch.off, true);
        assert.equal(batch.stats.fallbacks, 1);
        const before = backend.rounds.length;
        assert.deepEqual(await batch.run([maker(8), maker(9)]), [cpuBuild(8), cpuBuild(9)]);
        assert.equal(backend.rounds.length, before, "an off batch never asks the GPU again");
    }
    // what is finished on the CPU is the caller's choice: none, or as long as a predicate (a deadline) says so
    const abandon = await batchOver(exactBackend({ fail: (r) => r === 3 }));
    assert.deepEqual(await abandon.run([maker(1), maker(2)], { afterFailure: "abandon" }), [undefined, undefined]);
    const some = await batchOver(exactBackend({ fail: (r) => r === 3 }));
    const got = await some.run([maker(1), maker(2), maker(3)], { afterFailure: (done) => done < 2 });
    assert.deepEqual(got, [cpuBuild(1), cpuBuild(2), undefined]);
});

test("a GPU that stops answering: the decode times out, the batch finishes on the CPU; the wrong shapes count as a failure", async () => {
    const backend = exactBackend({ hang: (round) => round === 4 });
    const slow = (fn) => ({ ...backend, decode: (s, body, o) => Promise.race([fn(s, body, o), new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${o.timeoutMs} ms`)), o.timeoutMs))]) });
    const batch = await batchOver(slow(backend.decode.bind(backend)), { firstDecodeMs: 2000, decodeMs: 50 });
    const t0 = performance.now();
    assert.deepEqual(await batch.run([maker(1), maker(2)]), [cpuBuild(1), cpuBuild(2)]);
    assert.ok(performance.now() - t0 < 1500);
    assert.equal(batch.off, true);
    const wrong = exactBackend();
    const bad = await batchOver({ ...wrong, decode: async () => ({ out: new Float32Array(3), stride: 3 }) });
    assert.deepEqual(await bad.run([maker(1), maker(2)]), [cpuBuild(1), cpuBuild(2)]);
    assert.equal(bad.off, true);
});

test("cancellation mid-batch: an aborted signal ends the batch at the next beat with its reason; nothing hangs, rings are freed", async () => {
    const backend = exactBackend();
    const batch = await batchOver(backend);
    const ac = new AbortController();
    const counting = { ...backend, decode: (s, body, o) => {
        if (backend.rounds.length === 10) ac.abort();
        return backend.decode(s, body, o);
    } };
    const b2 = await batchOver(counting);
    await assert.rejects(b2.run([maker(1), maker(2)], { signal: ac.signal }), { name: "AbortError" });
    assert.ok(backend.rounds.length <= 12, `${backend.rounds.length} rounds`);
    await new Promise((r) => setImmediate(r));
    assert.equal(backend.sessions.get(2).rings.size, 0);
    // the batch itself stays usable, and the other one was never touched
    assert.deepEqual(await b2.run([maker(3), maker(4)]), [cpuBuild(3), cpuBuild(4)]);
    assert.equal(batch.off, false);
    batch.release();
    b2.release();
    assert.deepEqual(backend.released, [1, 2]);
    assert.equal(backend.sessions.size, 0);
});

test("before anything is learnt batches pay where a GPU round costs less than ROUND_RATIO CPU decoder beats; rounds are learnt as they come", async () => {
    assert.equal((await batchOver(exactBackend(), { policy: "always" })).pays(), true);
    // a fresh tiny model: its CPU decoder takes microseconds a beat, no GPU round (the prior) is worth that
    const model3 = randomInfillModel(TINY, { seed: 9 });
    const net3 = loadInfill(model3);
    const inputs3 = buildInfillInputs(net3, { ...args, model: model3 });
    const got3 = await exactBackend().encode(model3, inputs3);
    const auto = createGpuBatch({
        backend: exactBackend(), session: 1, net: net3, inputs: inputs3, known, head: exactHead,
        enc: { T: inputs3.T, d: net3.arch.d, out: null, xn: normalizedInputs(net3, inputs3), e2d: got3.e2d, cross: got3.cross },
    });
    assert.equal(auto.costs().roundMs, ROUND_PRIOR_MS);
    assert.equal(auto.pays(), false);
    assert.ok(auto.costs().cpuBeatMs > 0 && auto.costs().cpuBeatMs < ROUND_PRIOR_MS / ROUND_RATIO, JSON.stringify(auto.costs()));
    // another one: rounds of 2 ms (a fake clock) pull its estimate towards 2 ms; the decoder takes 0 ms on that clock,
    // so batches never pay for it, and an "always" batch still runs and teaches the rounds
    const model2 = randomInfillModel(TINY, { seed: 8 });
    const net2 = loadInfill(model2);
    const inputs2 = buildInfillInputs(net2, { ...args, model: model2 });
    let t = 0;
    const base = exactBackend();
    const slow = { ...base, decode: async (...a) => { t += 2; return base.decode(...a); } };
    const got = await slow.encode(model2, inputs2, { keep: true });
    const enc2 = { T: inputs2.T, d: net2.arch.d, out: null, xn: normalizedInputs(net2, inputs2), e2d: got.e2d, cross: got.cross };
    const make = (policy) => createGpuBatch({ backend: slow, session: got.session, net: net2, enc: enc2, inputs: inputs2, known, head: exactHead, now: () => t, policy });
    assert.equal(make("auto").costs().roundMs, ROUND_PRIOR_MS);
    await make("always").run([maker(1), maker(2), maker(3)]);
    const learnt = make("auto");
    assert.ok(Math.abs(learnt.costs().roundMs - 2) < 0.1, JSON.stringify(learnt.costs()));
    assert.equal(learnt.costs().probing, false);
    // off by what was measured, not by the prior: this variant's first rounds probe the GPU again (see below)
    assert.equal(learnt.pays(), true);
    assert.equal(learnt.costs().probing, true);
    assert.equal(learnt.costs().cpuBeatMs, 0);
});

test("the round cost is learnt from one-beat rounds only: a round that decodes many beats (a snapshot, a fixed start) does not count", async () => {
    const model4 = randomInfillModel(TINY, { seed: 10 });
    const net4 = loadInfill(model4);
    const inputs4 = buildInfillInputs(net4, { ...args, model: model4 });
    let t = 0;
    const base = exactBackend();
    // 6 ms a round + 0.5 ms a beat
    const slow = { ...base, decode: async (session, body, o) => { t += 6 + 0.5 * body.items.reduce((s, it) => s + it.n, 0); return base.decode(session, body, o); } };
    const got = await slow.encode(model4, inputs4, { keep: true });
    const enc4 = { T: inputs4.T, d: net4.arch.d, out: null, xn: normalizedInputs(net4, inputs4), e2d: got.e2d, cross: got.cross };
    const batch = createGpuBatch({ backend: slow, session: got.session, net: net4, enc: enc4, inputs: inputs4, known: null, head: exactHead, now: () => t, policy: "always" });
    await batch.run([maker(1), maker(2)]);
    const before = batch.costs().roundMs;
    assert.ok(Math.abs(before - 7) < 0.2, JSON.stringify(batch.costs())); // two builds a round: 6 + 2 × 0.5
    // late in the variant: a build whose rows are fixed up to near the end decodes ~all its beats in one round
    const upTo = slots.length - 4;
    const [rows] = await batch.run([maker(3, { fixedAt: (i) => (i < upTo ? (i * 3) % 16 : undefined) })]);
    assert.equal(rows.length, slots.length);
    assert.ok(batch.stats.beats > batch.stats.rounds, "a round decoded several beats");
    assert.ok(Math.abs(batch.costs().roundMs - before) < 0.2, JSON.stringify({ before, after: batch.costs() }));
});

// A fresh model (its learnt costs start from the priors) on a clock the test drives: while clock.cpu > 0 every now()
// adds that much (the CPU decoder's timing: one beat = one clock.cpu), a decode round adds roundOf(body), and a build
// adds clock.js each time it goes on after a round (its JS on the batch path). variant() is one variant's batch.
function timedModel(seed) {
    const m = randomInfillModel(TINY, { seed });
    const n = loadInfill(m);
    const inp = buildInfillInputs(n, { ...args, model: m });
    const clock = { t: 0, cpu: 0, js: 0, roundOf: () => 4.3 };
    const now = () => (clock.t += clock.cpu);
    const base = exactBackend();
    const backend = { ...base, decode: async (s, body, o) => {
        if (body.items?.length) clock.t += clock.roundOf(body);
        return base.decode(s, body, o);
    } };
    const prep = infillSource.prepare({ ...args, model: m });
    return {
        clock, base, inp,
        async variant(over = {}) {
            const got = await backend.encode(m, inp, { keep: true });
            const enc0 = { T: inp.T, d: n.arch.d, out: null, xn: normalizedInputs(n, inp), e2d: got.e2d, cross: got.cross };
            return createGpuBatch({ backend, session: got.session, net: n, enc: enc0, inputs: inp, known, head: exactHead, now, ...over });
        },
        // a build of the whole song as a batch maker, and the same build on this model's CPU source
        maker: (seed) => function* build(s) {
            const r = rngsOf(seed);
            s.begin();
            const out = [];
            for (let i = 0; i < slots.length; i += 1) {
                let m = s.step(i, 0.5, null, r, null);
                if (m === STEP_WAIT) {
                    m = yield STEP_WAIT;
                    clock.t += clock.js;
                }
                out.push(m);
            }
            return out;
        },
        cpuBuild: (seed) => cpuBuild(seed, { prep }),
    };
}
// pays() as a variant's first batch asks it: the CPU beat is timed then, at `cpu` ms a beat
const near = (a, b) => Math.abs(a - b) < 1e-6;
const asked = (v, clock, cpu) => {
    clock.cpu = cpu;
    const p = v.pays();
    clock.cpu = 0;
    return p;
};

test("one stall does not turn batches off: the round's cost leaves the slowest (and fastest) of the last rounds out", async () => {
    // M's costs on an RTX 5080: a CPU beat of 0.3 ms, rounds of 4.3 against 19 × 0.3 = 5.7
    const tm = timedModel(21);
    const v1 = await tm.variant();
    assert.equal(asked(v1, tm.clock, 0.3), true);
    const at = tm.base.rounds.length;
    await v1.run([tm.maker(1), tm.maker(2), tm.maker(3)]);
    const perBatch = tm.base.rounds.length - at;
    // one 40 ms round 3 rounds before the end of the next batch (an average of the rounds then read 5.8 ms: off for
    // the rest of the session)
    let k = 0;
    tm.clock.roundOf = () => (++k === perBatch - 3 ? 40 : 4.3);
    await v1.run([tm.maker(4), tm.maker(5)]);
    assert.equal(k, perBatch);
    const v2 = await tm.variant();
    assert.equal(asked(v2, tm.clock, 0.3), true);
    assert.equal(v2.costs().probing, false, "it pays by what was measured, no probe needed");
    assert.ok(near(v2.costs().roundMs, 4.3), JSON.stringify(v2.costs()));
    const v3 = await tm.variant();
    assert.equal(asked(v3, tm.clock, 0.3), true);
});

test("rounds that come at two speeds cost their mean, not the speed most of them have (S's 0.8 and 3 ms)", async () => {
    const tm = timedModel(27);
    const v1 = await tm.variant();
    assert.equal(asked(v1, tm.clock, 0.3), true);
    let k = 0;
    tm.clock.roundOf = () => (k++ % 5 < 3 ? 0.8 : 3);
    await v1.run([tm.maker(1), tm.maker(2)]);
    const r = v1.costs().roundMs;
    assert.ok(r > 1.4 && r < 1.9, `${r}: a median would say 0.8`);
});

test("a GPU slow for a stretch turns batches off; later variants probe it with bounded cost (backing off) and batch again once it is fast", async () => {
    const tm = timedModel(22);
    const v1 = await tm.variant();
    assert.equal(asked(v1, tm.clock, 0.3), true);
    await v1.run([tm.maker(1), tm.maker(2)]);
    // the GPU is busy for a whole batch: rounds of 20 ms, against 19 × 0.3 = 5.7
    tm.clock.roundOf = () => 20;
    await v1.run([tm.maker(3), tm.maker(4)]);
    const probe = async (ms, { afterFailure = "finish" } = {}) => {
        const v = await tm.variant();
        const pays = asked(v, tm.clock, 0.3);
        const probing = v.costs().probing;
        tm.clock.roundOf = () => ms;
        const at = tm.base.rounds.length;
        const rows = pays ? await v.run([tm.maker(5), tm.maker(6)], { afterFailure }) : null;
        return { v, pays, probing, rows, rounds: tm.base.rounds.length - at };
    };
    // off by what was measured: the next variant's first rounds go to the GPU again, PROBE_MS of them at 20 ms; they
    // still do not pay, so that batch finishes on the CPU decoder (the CPU's rows) and the variant builds there
    const p2 = await probe(20);
    assert.deepEqual([p2.pays, p2.probing], [true, true]);
    assert.ok(p2.rounds <= PROBE_MS / 20 + 2, `${p2.rounds} rounds`);
    assert.deepEqual(p2.rows, [tm.cpuBuild(5), tm.cpuBuild(6)]);
    assert.deepEqual([p2.v.pays(), p2.v.off, p2.v.stats.fallbacks, p2.v.stats.probes], [false, false, 0, 1]);
    assert.equal(await p2.v.snapshot(function* none(s) { yield* []; return s.snapshot(); }), null, "the variant is on the CPU");
    // the next probe waits a variant, then two, …
    assert.deepEqual((await probe(20)).pays, false);
    const p4 = await probe(20, { afterFailure: "abandon" });
    assert.deepEqual([p4.pays, p4.probing, p4.rows], [true, true, [undefined, undefined]]);
    assert.equal((await probe(20)).pays, false);
    assert.equal((await probe(20)).pays, false);
    // … and when it comes the GPU is fast again: the probe's own rounds decide, the batch goes on there
    const p7 = await probe(4.3);
    assert.deepEqual([p7.pays, p7.probing], [true, true]);
    assert.ok(p7.rounds > PROBE_ROUNDS + 10, `${p7.rounds} rounds: the whole batch on the GPU`);
    assert.deepEqual(p7.rows, [tm.cpuBuild(5), tm.cpuBuild(6)]);
    assert.deepEqual([p7.v.pays(), p7.v.costs().probing, near(p7.v.costs().roundMs, 4.3)], [true, false, true]);
    const p8 = await probe(4.3);
    assert.deepEqual([p8.pays, p8.probing], [true, false]);
});

test("a variant that pays again clears the probes' wait: the next slow stretch is probed at once", async () => {
    const tm = timedModel(26);
    const v1 = await tm.variant();
    assert.equal(asked(v1, tm.clock, 0.3), true);
    tm.clock.roundOf = () => 20;
    await v1.run([tm.maker(1), tm.maker(2)]);
    const v2 = await tm.variant();
    assert.equal(asked(v2, tm.clock, 0.3), true);
    await v2.run([tm.maker(3), tm.maker(4)]);
    assert.equal(v2.pays(), false, "the probe failed: the next probe would wait a variant");
    // the GPU is fast again and a batch says so (here one that always goes), then a variant pays by what was measured
    tm.clock.roundOf = () => 4.3;
    await (await tm.variant({ policy: "always" })).run([tm.maker(5), tm.maker(6)]);
    const v3 = await tm.variant();
    assert.deepEqual([asked(v3, tm.clock, 0.3), v3.costs().probing], [true, false]);
    tm.clock.roundOf = () => 20;
    await v3.run([tm.maker(7), tm.maker(8)]);
    const v4 = await tm.variant();
    assert.deepEqual([asked(v4, tm.clock, 0.3), v4.costs().probing], [true, true]);
});

test("a model whose batches decode few beats a round learns its own ratio (K) from a variant run to its end", async () => {
    const tm = timedModel(23);
    tm.clock.roundOf = () => 4.3;
    // a variant shorter than MIN_VARIANT_ROUNDS teaches nothing
    const short = await tm.variant();
    assert.equal(asked(short, tm.clock, 0.3), true);
    await short.run([tm.maker(1), tm.maker(2), tm.maker(3)]);
    short.release();
    assert.equal(short.costs().perRound, ROUND_RATIO);
    // three builds a round (a few rounds skip over the known stretch): K ≈ 3 build-beats a round, not 19
    const v1 = await tm.variant();
    assert.equal(asked(v1, tm.clock, 0.3), true);
    for (let k = 0; k < 4; k += 1) await v1.run([tm.maker(4 + 3 * k), tm.maker(5 + 3 * k), tm.maker(6 + 3 * k)]);
    v1.release();
    const K = v1.costs().perRound;
    const oneBeat = (v1.stats.beats - 3) / (v1.stats.rounds - 1); // every round costs the same: K = beats per round
    assert.ok(near(K, oneBeat) && K > 3 && K < 4, `K ${K}, beats a round ${oneBeat}`);
    // 4.3 ms rounds against K × 0.3 ms of CPU decoder: these batches do not pay (the next variant probes)
    const v2 = await tm.variant();
    assert.equal(asked(v2, tm.clock, 0.3), true);
    assert.equal(v2.costs().probing, true);
    assert.equal(v2.costs().perRound, K);
});

// One variant of 4 batches of 3 builds on a fresh model (as "learns its own ratio" above), its rounds costing
// roundOf(round number, extra beats); → the K it teaches and the model, for the variants after it
async function learnK(seed, roundOf) {
    const tm = timedModel(seed);
    let k = 0;
    tm.clock.roundOf = (body) => roundOf(++k, body.items.reduce((n, it) => n + it.n - 1, 0));
    const v = await tm.variant();
    assert.equal(asked(v, tm.clock, 2), true);
    for (let b = 0; b < 4; b += 1) await v.run([tm.maker(4 + 3 * b), tm.maker(5 + 3 * b), tm.maker(6 + 3 * b)]);
    v.release();
    return { tm, K: v.costs().perRound, rounds: k };
}

test("K does not follow a stall or a slow stretch in the variant it is learnt from (the round's cost does, while it lasts)", async () => {
    const clean = await learnK(28, () => 4.3);
    assert.ok(clean.K > 3 && clean.K < 4, `K ${clean.K}`);
    // one 1.5 s round, a stretch of 80 rounds at 20 ms, and a stall on the first round that skips over the known
    // stretch: timed against the round at the end, this variant's decode gave K ≈ 0.7, too low for 4.3 ms rounds
    // against 2 ms CPU beats, and every later probe failed by it
    let skips = 0;
    const busy = await learnK(28, (k, extra) => {
        if (extra > 0 && ++skips === 1) return 1500;
        if (k === 100) return 1500;
        return k >= 120 && k < 200 ? 20 : 4.3;
    });
    assert.ok(skips > 1, "the stalled round was one of several that skip ahead");
    assert.ok(near(busy.K, clean.K), `K ${busy.K}, without the stalls ${clean.K}`);
    const v = await busy.tm.variant();
    assert.deepEqual([asked(v, busy.tm.clock, 2), v.costs().probing], [true, false]);
});

test("K counts what a round's extra beats (a build skipping ahead) cost the GPU, against the one-beat rounds", async () => {
    const flat = await learnK(29, () => 4.3);
    // 4.3 ms a round + 1.2 ms an extra beat: each extra beat costs 1.2 / 4.3 of a one-beat round
    let extra = 0;
    const priced = await learnK(29, (k, x) => {
        if (k > 1) extra += x; // the session's first round teaches nothing
        return 4.3 + 1.2 * x;
    });
    assert.ok(extra > 0);
    const beats = flat.K * (flat.rounds - 1);
    assert.ok(near(priced.K, beats / (priced.rounds - 1 + (1.2 / 4.3) * extra)), `K ${priced.K}, without ${flat.K}`);
    assert.ok(priced.K < flat.K);
});

test("the CPU beat is timed in every variant and the median of the last CPU_PROBES kept (one probe varies with the load, the first runs beside the kernel's compile)", async () => {
    const tm = timedModel(24);
    const beats = [];
    for (const cpu of [2.4, 1.3, 1.8, 0.1, 1.2, 1.25]) {
        const v = await tm.variant();
        asked(v, tm.clock, cpu);
        beats.push(v.costs().cpuBeatMs);
    }
    assert.equal(CPU_PROBES, 5);
    [2.4, 1.85, 1.8, 1.55, 1.3, 1.25].forEach((want, k) => assert.ok(near(beats[k], want), `${beats}`));
});

test("estimate: a batch's time is its rounds (one per beat a build waits at) × (round + each build's JS); one CPU build decodes every beat", async () => {
    const tm = timedModel(25);
    const v = await tm.variant();
    asked(v, tm.clock, 0.3);
    tm.clock.roundOf = () => 4;
    tm.clock.js = 0.05;
    await v.run([tm.maker(1), tm.maker(2)]);
    tm.clock.js = 0;
    const c = v.costs();
    [[c.roundMs, 4], [c.jsMs, 0.05], [c.cpuBeatMs, 0.3], [c.headMs, 0]].forEach(([got, want]) => assert.ok(near(got, want), JSON.stringify(c)));
    for (const ranges of [[[0, slots.length]], [[50, 120], [150, 200]]]) {
        const free = ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, j) => a + j)).filter((i) => known[i] === 255);
        const beatsOf = free.map((i) => tm.inp.beatOf[i]);
        const rounds = new Set(beatsOf).size;
        const e = v.estimate({ builds: 11, ranges });
        assert.deepEqual([e.rounds, e.slots, e.beats], [rounds, free.length, Math.max(...beatsOf) + 1]);
        assert.ok(near(e.batchMs, rounds * (4 + 11 * 0.05)), JSON.stringify(e));
        assert.ok(near(e.buildMs, e.beats * 0.3 + rounds * 0.05), JSON.stringify(e));
    }
    assert.equal((await tm.variant({ policy: "always" })).estimate({ builds: 11, ranges: [[0, slots.length]] }), null);
});

// ---- the decode sessions over the real protocol (MessagePorts), the GPU being fakeInfillGpu ----
function serverWith(over = {}) {
    const created = [];
    const server = createGpuServer({
        gpu: { requestAdapter: async () => ({ info: { vendor: "nvidia" }, limits: {}, requestDevice: async () => ({ lost: new Promise(() => {}) }) }) },
        create: async (_device, m) => {
            const g = fakeInfillGpu(m);
            created.push(g);
            return g;
        },
        probe: async () => ({ ok: true, worst: 1e-7, tol: 2e-3, ms: 1 }),
        check: async () => ({ ok: true, worst: 1e-7, tol: 2e-3, probes: 0, ms: 1 }),
        ...over,
    });
    return { server, created };
}
function linked(server, { timeoutMs = 5000 } = {}) {
    const { port1, port2 } = new MessageChannel();
    server.serve(port2);
    const client = createGpuClient({ timeoutMs });
    client.attach(port1);
    return { client, port1, port2, close: () => { port1.close(); port2.close(); } };
}
const gpuBuild = async (prep, seeds, opts = {}) => prep.batch.run(seeds.map((seed) => maker(seed, opts)));

test("protocol: encode with keep opens a decode session; a batch over it gives the CPU's rows; release closes it", async () => {
    const { server } = serverWith();
    const { client, close } = linked(server);
    try {
        await client.ready(2000);
        const prep = await createGpuInfillSource(client.backend).prepare(args);
        assert.equal(prep.stats.gpu, true);
        assert.ok(prep.batch, "a backend that decodes gives the prepare a batch");
        assert.equal(server.sessions(), 1);
        const fixedAt = (i) => (i % 9 === 0 ? 6 : undefined);
        const rows = await gpuBuild(prep, [21, 22, 23], { fixedAt });
        // the GPU's split lane head is the CPU's up to float32 rounding: the same rows here
        [21, 22, 23].forEach((seed, k) => assert.deepEqual(rows[k], cpuBuild(seed, { fixedAt }), `seed ${seed}`));
        assert.ok(prep.batch.stats.rounds >= inputs.T - 5 && prep.batch.stats.rounds <= inputs.T + 2, `${prep.batch.stats.rounds} rounds`);
        // one build at a time is still the CPU source's own step (D1)
        assert.deepEqual(cpuBuild(21, { fixedAt, prep }), cpuBuild(21, { fixedAt }));
        prep.release();
        await client.ready(10);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(server.sessions(), 0);
        // a backend without decode: no batch, as before
        const plain = await createGpuInfillSource({ encode: client.backend.encode }).prepare(args);
        assert.equal(plain.batch, undefined);
        assert.equal(server.sessions(), 0, "and no session kept for it");
    } finally {
        close();
    }
});

test("protocol: sessions are bounded, an unknown one is refused, the ring ops keep their order, a closed port frees its own", async () => {
    const { server } = serverWith({ maxSessions: 2 });
    const { client, port2, close } = linked(server);
    try {
        await client.ready(2000);
        const a = await client.backend.encode(model, inputs, { keep: true });
        const b = await client.backend.encode(model, inputs, { keep: true });
        const c = await client.backend.encode(model, inputs, { keep: true });
        assert.deepEqual([a.session, b.session, c.session], [1, 2, 3]);
        assert.equal(server.sessions(), 2, "the oldest went");
        await assert.rejects(client.backend.decode(a.session, { items: [{ ref: 1, b0: 0, n: 1, rows: new Uint8Array(8) }] }), /session 1 is not open/);
        await assert.rejects(client.backend.decode(b.session, { ops: [["copy", 99, 5]], items: [] }), /no ring 99/);
        // decode 3 beats into ring 1, copy it to 2, both go on from beat 3: the same answer
        const prev = (b0, n) => new Uint8Array(n * 8);
        await client.backend.decode(c.session, { items: [{ ref: 1, b0: 0, n: 3, rows: prev(0, 3) }] });
        const got = await client.backend.decode(c.session, { ops: [["copy", 1, 2]], items: [{ ref: 1, b0: 3, n: 1, rows: prev(3, 1) }, { ref: 2, b0: 3, n: 1, rows: prev(3, 1) }] });
        assert.equal(got.stride, 8 * TINY.lane_hidden);
        assert.deepEqual(got.out.subarray(0, got.stride), got.out.subarray(got.stride));
        // without keep: no session
        assert.equal((await client.backend.encode(model, inputs)).session, undefined);
        assert.equal(server.sessions(), 2);
        // the worker's port closes: its sessions go
        port2.close();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(server.sessions(), 0);
    } finally {
        close();
    }
});

test("protocol: the GPU renderer goes away mid-batch: the batch finishes on the CPU with the CPU's rows", async () => {
    const { server } = serverWith();
    const { client, port1, close } = linked(server);
    try {
        await client.ready(2000);
        const errors = [];
        const prep = await createGpuInfillSource(client.backend, { onError: (e) => errors.push(e.message) }).prepare(args);
        let rounds = 0;
        const realDecode = client.backend.decode;
        client.backend.decode = (...a) => {
            rounds += 1;
            if (rounds === 25) port1.close();
            return realDecode(...a);
        };
        const rows = await gpuBuild(prep, [31, 32]);
        assert.deepEqual(rows, [cpuBuild(31), cpuBuild(32)]);
        assert.equal(prep.batch.off, true);
        assert.match(errors[0], /went away|closed|no GPU link/);
        client.backend.decode = realDecode;
    } finally {
        close();
    }
});

test("protocol: a snapshot taken before any beat was decoded (a part at the song's start) restores without a ring", async () => {
    const { server } = serverWith();
    const { client, close } = linked(server);
    try {
        await client.ready(2000);
        const prep = await createGpuInfillSource(client.backend).prepare(args);
        const empty = await prep.batch.snapshot(function* first(s) {
            s.begin();
            yield* [];
            return s.snapshot();
        });
        assert.equal(empty.ref, null);
        const from = (seed) => function* build(s) {
            s.restore(empty);
            const r = rngsOf(seed);
            const out = [];
            for (let i = 0; i < slots.length; i += 1) {
                let m = s.step(i, 0.5, null, r, null);
                if (m === STEP_WAIT) m = yield STEP_WAIT;
                out.push(m);
            }
            return out;
        };
        assert.deepEqual(await prep.batch.run([from(51), from(52)]), [cpuBuild(51), cpuBuild(52)]);
        assert.equal(prep.batch.off, false, "no failed ring copy, no fallback");
        prep.release();
    } finally {
        close();
    }
});

test("the exact stand-in source: a GPU source over exactBackend gives each prepare a batch with the CPU's lane head", async () => {
    const backend = exactBackend();
    const prep = await exactGpuSource(backend).prepare(args);
    assert.ok(prep.batch);
    assert.deepEqual(await prep.batch.run([maker(41), maker(42)]), [cpuBuild(41), cpuBuild(42)]);
    prep.release();
    assert.equal(backend.sessions.size, 0);
});
