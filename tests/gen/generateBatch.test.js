// Stream W, D3/D4 in the generator: builds that do not depend on each other run together on the GPU decoder
// (src/gen/nn/webgpu/gpuBatch.js), the search decides exactly as before. Without a GPU the generator is 0.10.2's bit
// for bit (tests/fixtures/batchGolden.json was recorded with 0.10.2's code). Over exactBackend (a stand-in whose
// decoder answers give the CPU's very logits) the batch path must give the very same responses, also when the GPU
// fails mid-batch (the batch finishes on the CPU) — so the batching changes when a build runs, never what it draws.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { BATCH_CASES, batchGoldenCases, fingerprint, tinyModel } from "../fixtures/batchGolden.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { chartInfo } from "../../src/core/features.js";
import { dropSong } from "../fixtures/dropSong.js";
import { exactBackend, exactGpuSource, fakeInfillGpu } from "../helpers/fakeGpu.js";
import { nnV2Source, sourceFor } from "../../src/gen/rowSources.js";
import { createGpuServer } from "../../src/gen/nn/webgpu/gpuServer.js";
import { createGpuClient } from "../../src/gen/nn/webgpu/gpuClient.js";
import { infillSourceFor, createGpuInfillSource } from "../../src/gen/nn/webgpu/gpuSource.js";

const GOLDEN = JSON.parse(readFileSync(new URL("../fixtures/batchGolden.json", import.meta.url), "utf8"));
const NN2 = GOLDEN.filter((c) => c.name.startsWith("nn2"));
const progressOf = async (run) => {
    const seen = [];
    const out = await run((p) => seen.push(`${p.phase}:${p.i}/${p.n}`));
    return { out, seen };
};

test("without a GPU the generator gives 0.10.2's responses bit for bit (nn-v2, XGB, the shipped S model)", async () => {
    assert.deepEqual(await batchGoldenCases(), GOLDEN);
});

test("with a GPU batch the responses and the progress are the CPU's, and the builds really went together", async () => {
    for (const { name, hash } of NN2) {
        const backend = exactBackend();
        const debug = {};
        const cpu = await progressOf((onProgress) => BATCH_CASES[name]({ onProgress }));
        const gpu = await progressOf((onProgress) => BATCH_CASES[name]({ onProgress, debug, source: nnV2Source(exactGpuSource(backend)) }));
        assert.equal(fingerprint(gpu.out), hash, name);
        assert.deepEqual(gpu.seen, cpu.seen, `${name}: the same progress events`);
        assert.ok(debug.batch.maxBatch >= 2 && debug.batch.rounds > 0, `${name}: ${JSON.stringify(debug.batch)}`);
        assert.ok(debug.timing.batched >= debug.timing.builds / 2, `${name}: ${JSON.stringify(debug.timing)}`);
        assert.equal(debug.batch.fallbacks, 0);
        assert.equal(backend.sessions.size, 0, `${name}: the variant's session was released`);
    }
});

test("a GPU error mid-batch: that batch finishes on the CPU, the rest of the variant builds there, the response is the CPU's", async () => {
    const names = ["nn2 candidates 6 + flavours", "nn2 own-range part + retry", "nn2 repeats + stems", "nn2 target"];
    for (const name of names) {
        for (const at of [1, 40, 300]) {
            const backend = exactBackend({ fail: (round) => round === at });
            const debug = {};
            const out = await BATCH_CASES[name]({ debug, source: nnV2Source(exactGpuSource(backend)) });
            assert.equal(fingerprint(out), GOLDEN.find((c) => c.name === name).hash, `${name}, failing at round ${at}`);
            if (backend.rounds.length >= at) {
                assert.equal(debug.batch.fallbacks, 1, `${name} at ${at}`);
                assert.equal(debug.batch.off, true);
                assert.equal(backend.rounds.length, at, "nothing asked of the GPU after the failure");
            }
        }
    }
    // the next variant (the next job) tries the GPU again
    const backend = exactBackend({ fail: (round) => round === 1 });
    const first = {};
    await BATCH_CASES["nn2 range"]({ debug: first, source: nnV2Source(exactGpuSource(backend)) });
    const second = {};
    await BATCH_CASES["nn2 range"]({ debug: second, source: nnV2Source(exactGpuSource(backend)) });
    assert.equal(first.batch.off, true);
    assert.equal(second.batch.off, false);
    assert.ok(second.batch.rounds > 0);
});

test("the candidates go in one batch (D3); with candidates 1 only the search's steps batch", async () => {
    const backend = exactBackend();
    const debug = {};
    const seen = [];
    await BATCH_CASES["nn2 candidates 6 + flavours"]({ debug, onProgress: (p) => seen.push(p), source: nnV2Source(exactGpuSource(backend)) });
    assert.ok(backend.rounds.some((n) => n === 5), "the 5 rebuilt candidates stepped together");
    assert.deepEqual(seen.filter((p) => p.phase === "candidates").map((p) => p.i), [0, 1, 2, 3, 4, 5]);
    const single = exactBackend();
    const d1 = {};
    await BATCH_CASES["nn2 range"]({ debug: d1, source: nnV2Source(exactGpuSource(single)) });
    assert.ok(d1.batch.maxBatch >= 4, "the coarse scan (and its speculative reseeds) went together");
});

// exactGpuSource whose batch says what the candidates' batch would take (batchMs) against 1 ms a build one by one
function estimating(backend, batchMs) {
    const asked = [];
    const src = nnV2Source(exactGpuSource(backend));
    const source = { ...src, async prepare(args) {
        const prep = await src.prepare(args);
        if (prep.batch) {
            prep.batch = Object.assign(Object.create(prep.batch), {
                estimate: (q) => {
                    asked.push(q);
                    return { batchMs, buildMs: 1 };
                },
            });
        }
        return prep;
    } };
    return { source, asked };
}

test("the candidates batch only when that is not slower than building them one by one by the deadline; the same response", async () => {
    const name = "nn2 candidates 6 + flavours";
    const want = GOLDEN.find((c) => c.name === name).hash;
    const cpu = await progressOf((onProgress) => BATCH_CASES[name]({ onProgress }));
    const batched = {};
    for (const [batchMs, together] of [[1e9, false], [0, true]]) {
        const backend = exactBackend();
        const debug = {};
        const { source, asked } = estimating(backend, batchMs);
        const gpu = await progressOf((onProgress) => BATCH_CASES[name]({ onProgress, debug, source }));
        assert.equal(fingerprint(gpu.out), want, `batch of ${batchMs} ms`);
        assert.deepEqual(gpu.seen, cpu.seen, "the same progress events");
        assert.deepEqual(debug.batch.candidates, { batched: together, batchMs, buildMs: 1, stageMs: 5 });
        // asked once, for the 5 rebuilt candidates over the blocks not fixed (all of them here), in slot order
        assert.equal(asked.length, 1);
        assert.equal(asked[0].builds, 5);
        assert.deepEqual(asked[0].ranges, debug.blocks.map((b) => [b.i0, b.i1]));
        batched[together] = debug.timing.batched;
    }
    assert.equal(batched.true - batched.false, 5, "only the candidates moved");
});

// the real protocol: the worker's gpuClient, the renderer's gpuServer over MessagePorts, the GPU's split lane head
// (fakeInfillGpu); infillSourceFor gives the batching source to any backend that decodes
function linkedBackend() {
    const server = createGpuServer({
        gpu: { requestAdapter: async () => ({ info: {}, limits: {}, requestDevice: async () => ({ lost: new Promise(() => {}) }) }) },
        create: async (_device, m) => fakeInfillGpu(m),
        probe: async () => ({ ok: true, worst: 0, tol: 2e-3, ms: 1 }),
        check: async () => ({ ok: true, worst: 0, tol: 2e-3, probes: 0, ms: 1 }),
    });
    const { port1, port2 } = new MessageChannel();
    server.serve(port2);
    const client = createGpuClient({ timeoutMs: 5000 });
    client.attach(port1);
    return { server, client, port1, close: () => { port1.close(); port2.close(); } };
}

test("through the worker ↔ GPU protocol: batches run, the map comes out, the session is released", async () => {
    const { server, client, close } = linkedBackend();
    try {
        await client.ready(2000);
        assert.equal(infillSourceFor(client.backend).gpu, true);
        const name = "nn2 own-range part + retry";
        const want = GOLDEN.find((c) => c.name === name).hash;
        // opts.nnBackend, as generatorJobs gives it: whether batches pay is the source's call (the stand-in GPU of this
        // file answers in microseconds); either way the same map
        const auto = {};
        assert.equal(fingerprint(await BATCH_CASES[name]({ debug: auto, nnBackend: client.backend })), want);
        assert.equal(auto.batch.fallbacks, 0);
        assert.ok(auto.batch.costs.cpuBeatMs >= 0 && auto.batch.costs.roundMs > 0, JSON.stringify(auto.batch.costs));
        // every batch on the GPU decoder (policy "always")
        const debug = {};
        const out = await BATCH_CASES[name]({ debug, source: nnV2Source(createGpuInfillSource(client.backend, { batch: { policy: "always" } })) });
        assert.ok(debug.batch.rounds > 0 && debug.batch.maxBatch >= 2, JSON.stringify(debug.batch));
        assert.equal(debug.batch.fallbacks, 0);
        assert.ok(out.noteCount > 0);
        // the split head is the CPU's up to float32 rounding: here not one row differs
        assert.equal(fingerprint(out), want);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(server.sessions(), 0);
        assert.equal(typeof (await sourceFor({ kind: "nn-v2" }, { nnBackend: client.backend })).prepare, "function");
    } finally {
        close();
    }
});

test("an own-range part at the very start (its snapshot holds no decoded beat) batches without a fallback", async () => {
    const { client, close } = linkedBackend();
    try {
        await client.ready(2000);
        const parts = [
            { startMs: 0, endMs: 20000, kind: "intro", range: { lo: 2, hi: 4 } },
            { startMs: 20000, endMs: 40000, kind: "break" },
            { startMs: 40000, endMs: 60000, kind: "drop" },
        ];
        const input = {
            timing: { bpm: 180, offsetMs: 300 }, envelope: onsetEnvelope(dropSong({ seconds: 60 }), 22050), durationMs: 60000, deadlineMs: 1e9,
            request: { range: { lo: 3, hi: 6 }, parts, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 1, burst: 0.3, seed: 3, candidates: 3 },
            meta: { title: "t", audioFilename: "a.mp3" },
        };
        // dan from the notes per second
        const analyze = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 60, top3: [{ name: "Rolls", share: 0.8 }] });
        const cpu = await generateLearnedMap(input, analyze, tinyModel, { patternsOf: () => [{ name: "Rolls", share: 0.5 }] });
        const debug = {};
        const gpu = await generateLearnedMap(input, analyze, tinyModel, {
            patternsOf: () => [{ name: "Rolls", share: 0.5 }], debug, source: nnV2Source(createGpuInfillSource(client.backend, { batch: { policy: "always" } })),
        });
        assert.ok(debug.batch.rounds > 0, JSON.stringify(debug.batch));
        assert.equal(debug.batch.fallbacks, 0, "the part's attempts restored the empty snapshot on the GPU");
        assert.equal(gpu.osuText, cpu.osuText);
    } finally {
        close();
    }
});

test("the GPU link closes mid-job: the job still answers, on the CPU from that batch on, and nothing hangs", async () => {
    const { client, port1, close } = linkedBackend();
    try {
        await client.ready(2000);
        let rounds = 0;
        const backend = { ...client.backend, decode: (...a) => {
            rounds += 1;
            if (rounds === 30) port1.close();
            return client.backend.decode(...a);
        } };
        const debug = {};
        const t0 = performance.now();
        const name = "nn2 candidates 6 + flavours";
        const out = await BATCH_CASES[name]({ debug, source: nnV2Source(createGpuInfillSource(backend, { batch: { policy: "always" } })) });
        assert.ok(performance.now() - t0 < 20000);
        assert.equal(debug.batch.off, true);
        assert.equal(debug.batch.fallbacks, 1);
        assert.equal(fingerprint(out), GOLDEN.find((c) => c.name === name).hash);
    } finally {
        close();
    }
});
