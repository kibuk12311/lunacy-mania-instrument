// Browser-side speed of the nn-v2 paths (stream W), run inside Electron by tools/bench-gpu.mjs: for each size, a
// 4-minute song (tools/bench-nn.mjs' song: 175 BPM, mixed grids, ≈ 4.4 slots per beat) through
//   cpu        infillSource.prepare + one build, plain JS (this renderer's V8, the same engine as the worker);
//   gpu-enc    createGpuInfillSource: the encoder and static K/V on the GPU, then the same CPU build;
//   gpu-dec×B  createGpuDecodeSession: B builds at once with the decoder on the GPU (one dispatch per beat for all B),
//              the history, the last two lane-head layers and the sampling on the CPU.
// The GPU-decoded rows are compared with the CPU build's (same seeds): `agree` is the share of slots with the same row.
import { infillSource, randomInfillModel, loadInfill, buildInfillInputs, infillFlops } from "../../src/gen/nn/infillModel.js";
import { createInfillGpu } from "../../src/gen/nn/webgpu/infillGpu.js";
import { createGpuInfillSource, createGpuDecodeSession } from "../../src/gen/nn/webgpu/gpuSource.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { envelopeFromTransfer } from "../../src/audio/onset.js";
import { mulberry32 } from "../../src/gen/rng.js";

const now = () => performance.now();
const rngsOf = (seed) => ({ fill: mulberry32(seed), size: mulberry32(seed ^ 0x51), pattern: mulberry32(seed ^ 0xa3) });

export function benchSong({ seconds = 240, bpm = 175 } = {}) {
    const rng = mulberry32(1);
    const rand = (n) => Float32Array.from({ length: n }, () => Math.abs(rng() - 0.5));
    const divs = [4, 4, 4, 4, 4, 4, 3, 4, 4, 8, 4, 6];
    const slots = slotsForTiming({ bpm, offsetMs: 0 }, seconds * 1000, { divOf: (b) => divs[b % divs.length] });
    const frames = Math.floor((seconds * 22050) / 256);
    const envelope = envelopeFromTransfer({ values: rand(frames), energy: rand(frames), bands: { low: rand(frames), mid: rand(frames), high: rand(frames) }, hopSec: 256 / 22050, frameOffsetSec: 768 / 22050 });
    const dan = new Float64Array(slots.length).fill(10);
    const family = slots.map(() => "Stream");
    return { slots, envelope, dan, family, beats: new Set(slots.map((s) => s.beat)).size };
}

export async function runBench({ device, archs, batches = [1, 3, 12], keepAlive = [0], song = benchSong() }) {
    const out = [];
    const { slots, envelope, dan, family } = song;
    const args = (model) => ({ model, audio: { envelope }, slots, dan, family });
    for (const [label, arch] of Object.entries(archs)) {
        const model = randomInfillModel({ ...arch, size: label }, { seed: 3 });
        const net = loadInfill(model);
        const row = { size: label, beats: song.beats, slots: slots.length, flops: infillFlops(arch, song.beats, slots.length) };
        // ---- CPU ----
        let t = now();
        const cpuPrep = infillSource.prepare(args(model));
        row.cpuPrepare = now() - t;
        const cpuRows = new Uint8Array(slots.length);
        t = now();
        cpuPrep.begin();
        const r0 = rngsOf(11);
        for (let i = 0; i < slots.length; i += 1) cpuRows[i] = cpuPrep.step(i, 0, null, r0, null);
        row.cpuBuild = now() - t;
        // ---- GPU encoder, CPU decoder ----
        t = now();
        const gpu = await createInfillGpu(device, model);
        row.gpuSetup = now() - t;
        const backend = { encode: async (_m, inputs) => { const e = await gpu.encode(inputs, { read: true }); e.release(); return { e2d: e.e2d, cross: e.cross }; } };
        const src = createGpuInfillSource(backend);
        await src.prepare(args(model)); // warm-up (first dispatches of each pipeline)
        t = now();
        const gpuPrep = await src.prepare(args(model));
        row.gpuPrepare = now() - t;
        row.gpuPrepareUsedGpu = gpuPrep.stats.gpu;
        t = now();
        gpuPrep.begin();
        const r1 = rngsOf(11);
        let same = 0;
        for (let i = 0; i < slots.length; i += 1) same += gpuPrep.step(i, 0, null, r1, null) === cpuRows[i] ? 1 : 0;
        row.gpuEncCpuBuild = now() - t;
        row.gpuEncAgree = same / slots.length;
        // ---- GPU decoder, B builds at once ----
        const inputs = buildInfillInputs(net, args(model));
        const enc = await gpu.encode(inputs, { read: false });
        row.dec = [];
        for (const ka of keepAlive) for (const B of batches) {
            const session = createGpuDecodeSession(gpu, enc, inputs, { keepAlive: ka });
            const streams = Array.from({ length: B }, () => session.stream());
            const before = { ...session.stats };
            t = now();
            const rowsOf = await Promise.all(streams.map(async (s, k) => {
                const rngs = rngsOf(11 + k);
                const mine = new Uint8Array(slots.length);
                s.begin();
                for (let i = 0; i < slots.length; i += 1) mine[i] = await s.step(i, 0, null, rngs, null);
                return mine;
            }));
            const ms = now() - t;
            let agree = 0;
            for (let i = 0; i < slots.length; i += 1) agree += rowsOf[0][i] === cpuRows[i] ? 1 : 0;
            row.dec.push({
                B, keepAlive: ka, ms, perBuild: ms / B, dispatches: session.stats.dispatches - before.dispatches,
                gpuMs: session.stats.gpuMs - before.gpuMs, maxBatch: session.stats.maxBatch, agree: agree / slots.length,
            });
            streams.forEach((s) => s.close());
        }
        enc.release();
        gpu.destroy();
        out.push(row);
    }
    return out;
}
