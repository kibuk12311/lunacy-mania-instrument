// Stream W (nn-v2 on WebGPU): the parts that need no GPU run here — the shader generators, the packed weights, the
// split lane head, the GPU sources and decode sessions over a CPU stand-in (tests/helpers/fakeGpu.js), the
// worker ↔ renderer protocol over real MessagePorts. The kernels themselves run where WebGPU is: the GPU tests below
// skip under node (no navigator.gpu); `npx electron tests/smoke/electron-webgpu.mjs` runs them on the real GPU.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import {
    infillSource, loadInfill, randomInfillModel, buildInfillInputs, encodeBeats, createDecoder, createHistory, pickRow, infillStats, teacherForced,
    probeInputs, IN_DIM, N_LANES,
} from "../../../src/gen/nn/infillModel.js";
import { LINEAR, LAYERNORM, LAYER_TENSORS, assembleShader, encAttentionShader, decoderShader, f32, slopesOf } from "../../../src/gen/nn/webgpu/wgsl.js";
import { packWeights, createLaneHead, encoderInputs } from "../../../src/gen/nn/webgpu/infillGpu.js";
import { createGpuInfillSource, createGpuDecodeSession, infillSourceFor, normalizedInputs, encoderPayload } from "../../../src/gen/nn/webgpu/gpuSource.js";
import { createGpuServer, adapterName } from "../../../src/gen/nn/webgpu/gpuServer.js";
import { createGpuClient } from "../../../src/gen/nn/webgpu/gpuClient.js";
import { probeCase, PROBE_ARCH } from "../../../src/gen/nn/webgpu/gpuProbe.js";
import { alibiSlopes } from "../../../src/gen/nn/kernels.js";
import { fakeInfillGpu, baseOf, staticsOf } from "../../helpers/fakeGpu.js";
import { slotsForTiming } from "../../../src/gen/grid.js";
import { onsetEnvelope } from "../../../src/audio/onset.js";
import { clickTrack } from "../../fixtures/clickTrack.js";
import { mulberry32 } from "../../../src/gen/rng.js";

const SIZES = JSON.parse(await readFile(new URL("../../../tools/nn/sizes.json", import.meta.url), "utf8"));
const TINY = { d: 8, enc_layers: 2, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 2, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 4, dec_win: 4, cross_win: 3, n_glob: 2 };
const model = randomInfillModel(TINY, { seed: 7, std: 1.5, styles: [{ key: "a", name: "A", maps: 3 }] });
const net = loadInfill(model);

const { samples, sampleRate } = clickTrack({ bpm: 150, offsetMs: 0, seconds: 14 });
const envelope = onsetEnvelope(samples, sampleRate);
const divPattern = [4, 4, 3, 3, 4, 6, 8, 4];
const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 12000, { divOf: (b) => divPattern[b % divPattern.length] });
const dan = new Float64Array(slots.length).fill(9);
const family = slots.map((s) => (s.beat % 16 < 8 ? "Stream" : "Jumpstream"));
const known = new Uint8Array(slots.length).fill(255);
for (let i = 40; i < 70; i += 1) known[i] = (i * 5) % 16;
const args = { model, audio: { envelope }, slots, dan, family, known };
const rngsOf = (seed) => ({ fill: mulberry32(seed), size: mulberry32(seed + 1), pattern: mulberry32(seed + 2) });
const maxDiff = (a, b) => a.reduce((w, v, i) => Math.max(w, Math.abs(v - b[i])), 0);

function cpuBuild(prep, seed, { offset = 0.5, fixedAt = null, weightOf = null } = {}) {
    const r = rngsOf(seed);
    prep.begin();
    return slots.map((_, i) => prep.step(i, offset, null, r, weightOf, fixedAt?.(i)));
}
const jsBackend = (counter = { n: 0 }) => ({
    async encode(m, inputs) {
        counter.n += 1;
        const n = loadInfill(m);
        return staticsOf(n, encodeBeats(n, inputs));
    },
});

// ---- the GPU itself (skipped where there is none) ----
const gpuApi = globalThis.navigator?.gpu;
test("WebGPU: GPU logits match PyTorch and the JS path (≤ 2e-3)", { skip: !gpuApi && "no WebGPU in this runtime: run npx electron tests/smoke/electron-webgpu.mjs" }, async () => {
    const adapter = await gpuApi.requestAdapter();
    if (!adapter) return;
    const device = await adapter.requestDevice();
    const { runSuite } = await import("../../gpu/webgpuSuite.js");
    const fixture = JSON.parse(await readFile(new URL("../../fixtures/infill-parity.json", import.meta.url), "utf8"));
    const results = await runSuite({ device, models: { fixture }, archs: { S: { ...SIZES.S, T: 96 } } });
    for (const r of results) assert.ok(r.ok, `${r.name}: ${r.error ?? r.worst}`);
});

// ---- shaders ----
test("the shaders are generated per arch: sizes and ALiBi slopes baked in, nothing left unfilled", () => {
    for (const [name, a] of Object.entries(SIZES).filter(([k]) => !k.startsWith("_"))) {
        const arch = { win: 32, dec_win: 32, cross_win: 32, n_glob: 4, lane_emb: 16, ...a };
        const packed = packWeights(loadInfill(randomInfillModel(arch, { seed: 1 })));
        const codes = [LINEAR, LAYERNORM, assembleShader({ d: arch.d, offsets: { style: 0, source: 0, free: 0, mask: 0, lane: 0, fam: 0, glob: 0 } }),
            encAttentionShader({ d: arch.d, H: arch.enc_heads, win: arch.win, G: arch.n_glob }), decoderShader(arch, packed.dec)];
        for (const raw of codes) {
            const code = raw.replace(/\/\/[^\n]*/g, "");
            assert.doesNotMatch(code, /undefined|NaN|\$\{/, name);
            // WGSL reserved words and builtins that must not be names here
            assert.doesNotMatch(code, /\b(shared|common|cross|filter|target)\s*[:=]/, name);
        }
        const dec = codes[4];
        assert.match(dec, new RegExp(`const DD = ${arch.dec_d}u;`));
        assert.match(dec, new RegExp(`var<workgroup> ff: array<f32, ${arch.dec_ffn}>;`));
        assert.match(dec, /for \(var L = 0u; L < nl; L = L \+ 1u\)/, "layers loop at run time");
        assert.equal((dec.match(/@binding\(\d\) var<storage/g) ?? []).length, 7, "7 storage buffers: within WebGPU's default 8 per stage");
        assert.match(codes[3], new RegExp(`const DH = ${arch.d / arch.enc_heads}u;`));
    }
    // the slopes are kernels.js alibiSlopes, as float32 literals
    assert.deepEqual(slopesOf(6), Array.from(alibiSlopes(6)));
    assert.equal(f32(1), "1.00000000e+0f");
    assert.equal(f32(0.125), "1.25000000e-1f");
});

// ---- packed weights and the split lane head ----
test("packed weights: every tensor 4-aligned, transposes and the layer table right", () => {
    const { wall, off, dec } = packWeights(net);
    for (const [name, v] of Object.entries(net.W)) {
        assert.equal(off[name] % 4, 0, name);
        assert.deepEqual(wall.subarray(off[name], off[name] + v.length), v, name);
    }
    const { dec_d: dd } = net.arch;
    const W = net.W["dec.1.qkv.weight"]; // [3dd][dd]
    const T = wall.subarray(off["dec.1.qkvT"]);
    for (let j = 0; j < 3 * dd; j += 1) for (let i = 0; i < dd; i += 1) assert.equal(T[i * 3 * dd + j], W[j * dd + i]);
    dec.layers.forEach((l, L) => LAYER_TENSORS.forEach((name, k) => {
        assert.equal(wall[dec.layerTable + L * LAYER_TENSORS.length + k] * 4, l[name], `${L}.${name}`);
    }));
});

test("the lane head split (GPU: z, lane and lane values; CPU: history, head2, head3) gives the JS logits", () => {
    const inputs = buildInfillInputs(net, args);
    const enc = encodeBeats(net, inputs);
    const dec = createDecoder(net, enc, inputs);
    const head = createLaneHead(net);
    const { wall, off } = packWeights(net);
    const hist = createHistory();
    const h = new Float32Array(68);
    const { dec_d: dd, lane_hidden: hh } = net.arch;
    let worst = 0;
    let n = 0;
    for (let b = 0; b < 12; b += 1) {
        dec.advance(b ? inputs.visible.map((v) => (v === 255 ? 3 : v)) : null, (b - 1) * N_LANES);
        const z = dec.snapshot().z;
        for (let l = 0; l < N_LANES; l += 1) {
            if (!(inputs.x[b * IN_DIM + l * 12 + 11] > 0.5)) continue;
            const p = b + l / 4;
            const feats = hist.features(p, h);
            const want = dec.laneLogits(l, feats);
            const base = baseOf(net, z, enc.xn, b, l);
            // the same base from the packed (GPU) tensors
            const packedBase = new Float32Array(hh);
            for (let j = 0; j < hh; j += 1) {
                let s = wall[off["head1.bias"] + j] + wall[off.h1le + l * hh + j];
                for (let i = 0; i < dd; i += 1) s += wall[off.h1z + i * hh + j] * z[i];
                for (let c = 0; c < 12; c += 1) s += wall[off.h1v + c * hh + j] * enc.xn[b * IN_DIM + l * 12 + c];
                packedBase[j] = s;
            }
            worst = Math.max(worst, maxDiff(base, packedBase), maxDiff(head(base, 0, feats), want));
            hist.push(1 + ((b + l) % 15), p);
            n += 1;
        }
    }
    assert.ok(n > 30);
    assert.ok(worst < 1e-5, `max |Δ| ${worst}`);
});

test("encoder inputs: normalised x, lane codes (65535 absent, 255 free, a visible mask), condition rows", () => {
    const inputs = buildInfillInputs(net, args);
    const host = encoderInputs(net, inputs);
    assert.deepEqual(host.xn, encodeBeats(net, inputs).xn);
    assert.deepEqual(host.xn, normalizedInputs(net, inputs));
    const b = inputs.beatOf[45];
    assert.equal(host.codes[b * 8 + inputs.laneOf[45]], known[45]);
    assert.equal(host.codes[0], 255);
    const b3 = inputs.div.findIndex((d) => d === 1); // a 1/3 beat: lanes 3..7 absent
    assert.deepEqual([...host.codes.subarray(b3 * 8 + 3, b3 * 8 + 8)], [65535, 65535, 65535, 65535, 65535]);
    assert.equal(host.cond.length, (inputs.T + 1) * 27);
    assert.equal(host.cond[16], 1); // dan known
    assert.equal(host.cond[inputs.T * 27 + 16], 1);
    assert.deepEqual(Object.keys(encoderPayload(inputs)).sort(), ["T", "dan", "danKnown", "div", "echo", "fam", "msd", "rate", "source", "style", "visible", "x"]);
});

// ---- the infillModel hooks ----
test("infillSource.prepare takes a precomputed encoder (with or without its static K/V): same rows, no second encode", () => {
    const plain = cpuBuild(infillSource.prepare(args), 3);
    const inputs = buildInfillInputs(net, args);
    const enc = encodeBeats(net, inputs);
    const before = infillStats.encodes;
    assert.deepEqual(cpuBuild(infillSource.prepare({ ...args, encoded: { inputs, enc } }), 3), plain);
    assert.deepEqual(cpuBuild(infillSource.prepare({ ...args, encoded: { inputs, enc: { ...enc, ...staticsOf(net, enc) } } }), 3), plain);
    assert.equal(infillStats.encodes, before);
});

test("pickRow: logit 0 shifted by the offset, the guard's weights, its fallback when it vetoes everything", () => {
    const logits = () => Float32Array.from({ length: 16 }, (_, k) => (k ? 0 : -50));
    const r = rngsOf(1);
    assert.notEqual(pickRow(logits(), 0, r, null), 0);
    assert.equal(pickRow(logits(), -100, rngsOf(1), null), 0);
    assert.equal(pickRow(logits(), 0, rngsOf(2), Object.assign((m) => (m === 6 ? 1 : 0), { fallback: () => 9 })), 6);
    assert.equal(pickRow(logits(), 0, rngsOf(2), Object.assign(() => 0, { fallback: () => 9 })), 9);
});

// ---- the GPU encoder source ----
test("createGpuInfillSource: async prepare on the backend, the CPU decoder and sampler: the very rows of infillSource", async () => {
    const counter = { n: 0 };
    const src = createGpuInfillSource(jsBackend(counter));
    assert.equal(src.kind, "nn-v2");
    assert.equal(src.caps.infill, true);
    const prep = await src.prepare(args);
    assert.equal(prep.stats.gpu, true);
    assert.equal(counter.n, 1);
    const cpu = infillSource.prepare(args);
    const fixedAt = (i) => (i % 11 === 0 ? 5 : undefined);
    const veto = Object.assign((m) => (m & 2 ? 0 : 1), { fallback: () => 4 });
    for (const [seed, opts] of [[1, {}], [2, { fixedAt }], [3, { weightOf: veto, offset: 3 }]]) {
        assert.deepEqual(cpuBuild(prep, seed, opts), cpuBuild(cpu, seed, opts), `seed ${seed}`);
    }
});

test("createGpuInfillSource falls back to the CPU encoder when the backend fails or answers wrong shapes", async () => {
    const plain = cpuBuild(infillSource.prepare(args), 4);
    const errors = [];
    const failing = createGpuInfillSource({ encode: async () => { throw new Error("device lost"); } }, { onError: (e) => errors.push(e.message) });
    const p1 = await failing.prepare(args);
    assert.equal(p1.stats.gpu, false);
    assert.deepEqual(cpuBuild(p1, 4), plain);
    const wrong = createGpuInfillSource({ encode: async () => ({ e2d: new Float32Array(3), cross: [] }) }, { onError: (e) => errors.push(e.message) });
    const p2 = await wrong.prepare(args);
    assert.equal(p2.stats.gpu, false);
    assert.deepEqual(cpuBuild(p2, 4), plain);
    assert.deepEqual(errors, ["device lost", "nn-v2 GPU: the encoder answered with the wrong shapes"]);
    // no slots: no backend call at all
    let asked = 0;
    const empty = await createGpuInfillSource({ encode: async () => { asked += 1; } }).prepare({ ...args, slots: [], dan: [], family: [], known: null });
    assert.equal(empty.step(0, 0, null, rngsOf(1), null), 0);
    assert.equal(asked, 0);
});

test("infillSourceFor: the CPU source without a backend, one GPU source per backend", () => {
    assert.equal(infillSourceFor(null), infillSource);
    assert.equal(infillSourceFor(), infillSource);
    const backend = jsBackend();
    assert.equal(infillSourceFor(backend), infillSourceFor(backend));
    assert.equal(infillSourceFor(backend).gpu, true);
});

// ---- the GPU decode session (batched builds), over the CPU stand-in ----
test("a decode session: concurrent builds share dispatches and give infillSource's rows, known and fixed rows included", async () => {
    const gpu = fakeInfillGpu(model);
    const inputs = buildInfillInputs(net, args);
    const enc = await gpu.encode(inputs, { read: false });
    const ticks = [];
    const session = createGpuDecodeSession(gpu, enc, inputs, { known, schedule: (fn) => ticks.push(setImmediate(fn)) });
    const cpu = infillSource.prepare(args);
    const fixedAt = (i) => (i % 13 === 0 ? 7 : undefined);
    const seeds = [5, 6, 7];
    const builds = await Promise.all(seeds.map(async (seed) => {
        const s = session.stream();
        const r = rngsOf(seed);
        s.begin();
        const out = [];
        for (let i = 0; i < slots.length; i += 1) out.push(await s.step(i, 0.5, null, r, null, fixedAt(i)));
        s.close();
        return out;
    }));
    seeds.forEach((seed, k) => assert.deepEqual(builds[k], cpuBuild(cpu, seed, { fixedAt }), `seed ${seed}`));
    assert.equal(session.stats.maxBatch, 3, "the three builds went to the GPU together");
    assert.ok(session.stats.dispatches <= inputs.T + 2, `${session.stats.dispatches} dispatches for ${inputs.T} beats`);
});

test("a decode stream: snapshot/restore re-decodes from the cut; begin() starts a new build", async () => {
    const gpu = fakeInfillGpu(model);
    const inputs = buildInfillInputs(net, args);
    const enc = await gpu.encode(inputs, { read: false });
    const session = createGpuDecodeSession(gpu, enc, inputs, { known, schedule: (fn) => setImmediate(fn) });
    const s = session.stream();
    const whole = [];
    const r = rngsOf(9);
    for (let i = 0; i < slots.length; i += 1) whole.push(await s.step(i, 0, null, r, null));
    const cut = 120;
    const a = rngsOf(9);
    s.begin();
    for (let i = 0; i < cut; i += 1) await s.step(i, 0, null, a, null);
    const snap = s.snapshot();
    const other = rngsOf(77);
    for (let i = cut; i < slots.length; i += 1) await s.step(i, 0, null, other, null);
    s.restore(snap);
    const tail = [];
    for (let i = cut; i < slots.length; i += 1) tail.push(await s.step(i, 0, null, a, null));
    assert.deepEqual(tail, whole.slice(cut));
    s.dropSnapshot(snap);
    s.close();
});

// ---- the worker ↔ GPU renderer protocol, over real MessagePorts with the CPU stand-in as the GPU ----
function serverWith(over = {}) {
    const created = [];
    const server = createGpuServer({
        gpu: { requestAdapter: async () => ({ info: { vendor: "nvidia", architecture: "blackwell" }, limits: {}, requestDevice: async () => ({ lost: new Promise(() => {}) }) }) },
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
function linked(server) {
    const { port1, port2 } = new MessageChannel();
    server.serve(port2);
    const client = createGpuClient({ timeoutMs: 5000 });
    client.attach(port1);
    return { client, close: () => { port1.close(); port2.close(); } };
}

test("protocol: hello gives the capability; the encoder over the port equals the CPU's; the model is uploaded once", async () => {
    const { server, created } = serverWith();
    const { client, close } = linked(server);
    try {
        const cap = await client.ready(3000);
        assert.deepEqual({ ...cap, probe: undefined }, { gpuAvailable: true, adapter: "nvidia blackwell", reason: null, probe: undefined, decoder: "cpu" });
        assert.equal(client.available(), true);
        const inputs = buildInfillInputs(net, args);
        const got = await client.backend.encode(model, inputs);
        const want = staticsOf(net, encodeBeats(net, inputs));
        assert.deepEqual(got.e2d, want.e2d);
        assert.deepEqual(got.cross, want.cross);
        await client.backend.encode(model, inputs);
        assert.equal(created.length, 1);
        // and through the source: infillSource's rows
        const prep = await createGpuInfillSource(client.backend).prepare(args);
        assert.equal(prep.stats.gpu, true);
        assert.deepEqual(cpuBuild(prep, 2), cpuBuild(infillSource.prepare(args), 2));
    } finally {
        close();
    }
});

test("protocol: each worker's models are its own on the one GPU renderer, and go when its port closes", async () => {
    // a worker that replaced a hung one starts its own model count again: its first model, here one of the same
    // size, must not get the old worker's first model's weights
    const created = [];
    const { server } = serverWith({
        create: async (_device, m) => {
            const g = fakeInfillGpu(m);
            g.destroy = () => { g.destroyed = true; };
            created.push(g);
            return g;
        },
    });
    const other = randomInfillModel(TINY, { seed: 8, std: 1.5, styles: [{ key: "a", name: "A", maps: 3 }] });
    const otherNet = loadInfill(other);
    const old = linked(server);
    const inputs = buildInfillInputs(net, args);
    await old.client.ready(3000);
    await old.client.backend.encode(model, inputs);
    const fresh = linked(server);
    try {
        await fresh.client.ready(3000);
        const got = await fresh.client.backend.encode(other, inputs);
        assert.equal(created.length, 2, "the second worker's model is uploaded on its own");
        assert.deepEqual(got.e2d, staticsOf(otherNet, encodeBeats(otherNet, inputs)).e2d);
        old.close();
        for (let i = 0; i < 50 && !created[0].destroyed; i++) await new Promise((r) => setTimeout(r, 10));
        assert.equal(created[0].destroyed, true, "the closed worker's model goes with its port");
        assert.equal(created[1].destroyed, undefined);
        const again = await fresh.client.backend.encode(other, inputs);
        assert.deepEqual(again.e2d, got.e2d);
    } finally {
        old.close();
        fresh.close();
    }
});

test("protocol: no WebGPU, no adapter, or a failed probe → gpuAvailable false with the reason; loads are refused", async () => {
    const cases = [
        [{ gpu: undefined }, "no WebGPU"],
        [{ gpu: { requestAdapter: async () => null } }, "no adapter"],
        [{ probe: async () => ({ ok: false, worst: 0.5, tol: 2e-3, ms: 1 }) }, "probe 0.5 > 0.002"],
    ];
    for (const [over, reason] of cases) {
        const { server } = serverWith(over);
        const { client, close } = linked(server);
        try {
            const cap = await client.ready(3000);
            assert.equal(cap.gpuAvailable, false);
            assert.equal(cap.reason, reason);
            assert.equal(client.available(), false);
            await assert.rejects(client.backend.encode(model, buildInfillInputs(net, args)), /no GPU/);
        } finally {
            close();
        }
    }
});

test("protocol: a model failing its parity probes on the GPU is refused, and the source then runs on the CPU", async () => {
    const { server, created } = serverWith({ check: async () => ({ ok: false, worst: 0.3, tol: 2e-3 }) });
    const { client, close } = linked(server);
    try {
        await client.ready(3000);
        const errors = [];
        const prep = await createGpuInfillSource(client.backend, { onError: (e) => errors.push(e.message) }).prepare(args);
        assert.equal(prep.stats.gpu, false);
        assert.match(errors[0], /parity probes fail on this GPU/);
        assert.equal(created.length, 1);
        assert.deepEqual(await server.handle({ op: "nope" }), { ok: false, message: "unknown op nope" });
        assert.match((await server.handle({ op: "encode", key: "zz", inputs: {} })).message, /not loaded/);
    } finally {
        close();
    }
});

test("client: without a port nothing is available and nothing waits; a closed port fails its pending requests", async () => {
    const lone = createGpuClient();
    assert.equal(await lone.ready(10), null);
    assert.equal(lone.available(), false);
    await assert.rejects(lone.backend.encode(model, buildInfillInputs(net, args)), /no GPU link/);
    // a server that never answers: the request times out
    const { port1, port2 } = new MessageChannel();
    port2.on("message", () => {});
    const slow = createGpuClient({ timeoutMs: 50 });
    slow.attach(port1);
    assert.equal(await slow.ready(200), slow.capability());
    assert.equal(slow.capability().gpuAvailable, false);
    port1.close();
    port2.close();
    assert.equal(adapterName({}), "unknown GPU");
    assert.equal(adapterName({ vendor: "amd", description: "Radeon" }), "amd Radeon");
});

test("the start-up probe case is deterministic and exercises clipping windows and echo keys", () => {
    const pnet = loadInfill(randomInfillModel(PROBE_ARCH, { seed: 5, styles: [{ key: "probe", name: "probe", maps: 1 }] }));
    const a = probeCase(pnet);
    const b = probeCase(pnet);
    assert.deepEqual(a.inp.x, b.inp.x);
    assert.ok(a.inp.T > 2 * PROBE_ARCH.win + 1);
    assert.ok([...a.inp.echo].some((e, k) => e >= 0 && Math.abs(e - Math.floor(k / 2)) > PROBE_ARCH.win));
    assert.ok(a.wanted.length >= 10);
    const got = teacherForced(pnet, a.inp, a.rows, a.wanted);
    assert.ok(got.every((g) => g.length === 16 && g.every(Number.isFinite)));
});

test("model parity probes decode as the GPU checks read them (probeInputs on the XS fixture)", async () => {
    const fixture = JSON.parse(await readFile(new URL("../../fixtures/infill-parity.json", import.meta.url), "utf8"));
    const inp = probeInputs(fixture.parity.probes[0]);
    assert.equal(inp.T, fixture.parity.probes[0].T);
    assert.equal(inp.x.length, inp.T * IN_DIM);
    assert.equal(inp.rows.length, inp.T * N_LANES);
});
