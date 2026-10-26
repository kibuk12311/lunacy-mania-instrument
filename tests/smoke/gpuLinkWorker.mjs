// Utility-process half of tests/smoke/electron-gpu-link.mjs: the generator worker's GPU link exactly as
// app/analysisWorker.js wires it (app/gpuWorkerLink.js), asked for a port through app/workerClient.js's hook; then the
// nn-v2 encoder of a model over that port for a 4-minute song, checked against the plain-JS encoder and timed.
import { readFile } from "node:fs/promises";
import { createGpuWorkerLink } from "../../app/gpuWorkerLink.js";
import { createGpuInfillSource } from "../../src/gen/nn/webgpu/gpuSource.js";
import { infillSource, loadInfill, buildInfillInputs, encodeBeats, randomInfillModel } from "../../src/gen/nn/infillModel.js";
import { linearRows } from "../../src/gen/nn/kernels.js";
import { benchSong } from "../gpu/webgpuBench.js";
import { mulberry32 } from "../../src/gen/rng.js";

const link = createGpuWorkerLink({ post: (m) => process.parentPort.postMessage(m) });

async function run({ modelPath = null, arch = null }) {
    const out = {};
    let t = performance.now();
    const backend = await link.backend();
    out.linkMs = Math.round(performance.now() - t);
    out.capability = link.client.capability();
    if (!backend) return { ...out, ok: false, reason: "no backend" };
    const model = modelPath ? JSON.parse(await readFile(modelPath, "utf8")) : randomInfillModel(arch, { seed: 3 });
    const net = loadInfill(model);
    const { slots, envelope, dan, family } = benchSong();
    const args = { model, audio: { envelope }, slots, dan, family };
    const inputs = buildInfillInputs(net, args);
    t = performance.now();
    const first = await backend.encode(model, inputs);
    out.firstEncodeMs = Math.round(performance.now() - t); // upload + compile + the model's parity probes + encode
    const times = [];
    for (let k = 0; k < 3; k += 1) {
        t = performance.now();
        await backend.encode(model, inputs);
        times.push(performance.now() - t);
    }
    out.encodeMs = Math.round(Math.min(...times));
    // the same numbers as the CPU (e2d and the cross K/V from encodeBeats' output)
    const enc = encodeBeats(net, inputs);
    const { d, dec_d: dd } = net.arch;
    const e2d = linearRows(enc.out, inputs.T, net.W["e2d.weight"], net.W["e2d.bias"], d, dd);
    let worst = 0;
    for (let i = 0; i < e2d.length; i += 1) worst = Math.max(worst, Math.abs(e2d[i] - first.e2d[i]));
    for (let l = 0; l < net.arch.dec_layers; l += 1) {
        const c = linearRows(enc.out, inputs.T, net.W[`dec.${l}.ckv.weight`], net.W[`dec.${l}.ckv.bias`], d, 2 * dd);
        for (let i = 0; i < c.length; i += 1) worst = Math.max(worst, Math.abs(c[i] - first.cross[l][i]));
    }
    out.worstStatic = worst;
    // a whole prepare + build through createGpuInfillSource against infillSource: the same rows
    const src = createGpuInfillSource(backend);
    t = performance.now();
    const gp = await src.prepare(args);
    out.gpuPrepareMs = Math.round(performance.now() - t);
    t = performance.now();
    const cp = infillSource.prepare(args);
    out.cpuPrepareMs = Math.round(performance.now() - t);
    const rngs = (s) => ({ fill: mulberry32(s), size: mulberry32(s + 1), pattern: mulberry32(s + 2) });
    const a = rngs(7);
    const b = rngs(7);
    let same = 0;
    t = performance.now();
    for (let i = 0; i < slots.length; i += 1) same += gp.step(i, 0, null, a, null) === cp.step(i, 0, null, b, null) ? 1 : 0;
    out.buildPairMs = Math.round(performance.now() - t);
    out.agree = same / slots.length;
    out.usedGpu = gp.stats.gpu;
    out.beats = inputs.T;
    out.slots = slots.length;
    out.ok = worst <= 2e-3 && out.agree === 1 && out.usedGpu;
    return out;
}

process.parentPort.on("message", async ({ data, ports }) => {
    if (link.accept(data, ports)) return;
    let result;
    try {
        result = { kind: "generated", ...(await run(data.payload ?? {})) };
    } catch (error) {
        result = { kind: "error", message: String(error?.stack ?? error) };
    }
    process.parentPort.postMessage({ id: data.id, result });
});
