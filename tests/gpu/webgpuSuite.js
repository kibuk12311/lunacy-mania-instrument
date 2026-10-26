// Browser-side WebGPU checks for the nn-v2 GPU path (stream W), run inside Electron by tests/smoke/electron-webgpu.mjs:
// GPU logits against PyTorch's (the parity probes of a model JSON) and against the JS path, the encoder output against
// encodeBeats, and the batched decoder against createDecoder. Every check returns { name, ok, worst, tol, ms }.
import { loadInfill, randomInfillModel, teacherForced, probeInputs, encodeBeats, IN_DIM, N_LANES } from "../../src/gen/nn/infillModel.js";
import { createInfillGpu } from "../../src/gen/nn/webgpu/infillGpu.js";
import { probeGpu, checkModelOnGpu } from "../../src/gen/nn/webgpu/gpuProbe.js";
import { mulberry32 } from "../../src/gen/rng.js";

const maxDiff = (a, b) => {
    let w = 0;
    for (let i = 0; i < a.length; i += 1) w = Math.max(w, Math.abs(a[i] - b[i]));
    return w;
};
const maxDiff2 = (A, B) => A.reduce((w, a, k) => Math.max(w, maxDiff(a, B[k])), 0);

// a random probe-shaped input: T beats, mixed grids, some visible masks, echo keys beyond the window
export function randomInputs(net, T, seed = 1) {
    const rng = mulberry32(seed);
    const divs = [4, 4, 3, 4, 6, 4, 8, 4];
    const DIV = [4, 3, 6, 8];
    const x = new Float32Array(T * IN_DIM);
    const visible = new Uint8Array(T * N_LANES).fill(255);
    const rows = new Uint8Array(T * N_LANES);
    const div = new Uint8Array(T);
    for (let t = 0; t < T; t += 1) {
        const dv = divs[t % divs.length];
        div[t] = DIV.indexOf(dv);
        for (let l = 0; l < dv; l += 1) {
            const o = t * IN_DIM + l * 12;
            for (let k = 0; k < 11; k += 1) x[o + k] = rng() * 2 - 1;
            x[o + 11] = 1;
            rows[t * N_LANES + l] = rng() < 0.4 ? 1 + Math.floor(rng() * 15) : 0;
            if (rng() < 0.2) visible[t * N_LANES + l] = Math.floor(rng() * 16);
        }
        for (let k = 96; k < IN_DIM - 4; k += 1) x[t * IN_DIM + k] = rng() * 2 - 1;
        x[t * IN_DIM + IN_DIM - 4 + div[t]] = 1;
    }
    const echo = new Int32Array(T * 2).fill(-1);
    for (let t = 70; t < T; t += 3) {
        echo[t * 2] = t - 66;
        echo[(t - 66) * 2 + 1] = t;
    }
    const fam = Uint8Array.from({ length: T }, (_, t) => t % 7);
    const dan = Float32Array.from({ length: T }, (_, t) => 5 + (t % 13));
    return {
        T, x, visible, rows, div, fam, dan, danKnown: 1, msd: Float64Array.from({ length: 8 }, (_, k) => 10 + k),
        style: net.arch.n_styles > 1 ? 1 : 0, source: 1, rate: 1, echo,
    };
}

export const wantedOf = (inp, n, seed) => {
    const rng = mulberry32(seed);
    const out = [];
    while (out.length < n) {
        const b = Math.floor(rng() * inp.T);
        const l = Math.floor(rng() * 8);
        if (inp.x[b * IN_DIM + l * 12 + 11] > 0.5) out.push([b, l]);
    }
    return out;
};

export async function runSuite({ device, models = {}, archs = {}, tol = 2e-3 }) {
    const results = [];
    const check = async (name, fn) => {
        const t0 = performance.now();
        try {
            const r = await fn();
            const limit = r.tol ?? tol;
            results.push({ name, ok: r.worst <= limit, worst: r.worst, tol: limit, ms: Math.round(performance.now() - t0) });
        } catch (error) {
            results.push({ name, ok: false, error: String(error?.stack ?? error), ms: Math.round(performance.now() - t0) });
        }
    };
    // 0. the start-up probe the app runs (GPU encoder + CPU decoder against plain JS, a small random model)
    await check("start-up probe (GPU encoder, CPU decoder) vs JS", async () => probeGpu(device));
    // 1. each model's own parity probes (PyTorch logits): the app's path (GPU encoder, CPU decoder) and all-GPU
    for (const [label, model] of Object.entries(models)) {
        let gpu = null;
        await check(`${label}: upload and compile`, async () => {
            gpu = await createInfillGpu(device, model);
            return { worst: 0 };
        });
        if (!gpu) continue;
        await check(`${label}: its parity probes with the GPU encoder and the CPU decoder (the app's path) vs PyTorch`, async () => checkModelOnGpu(gpu, model));
        for (const probe of model.parity?.probes ?? []) {
            await check(`${label} probe ${probe.name} (T ${probe.T}), all on the GPU, vs PyTorch`, async () => {
                const inp = probeInputs(probe);
                const got = await gpu.teacherForced(inp, inp.rows, probe.check);
                return { worst: maxDiff2(got, probe.logits), tol: model.parity.tolerance ?? tol };
            });
        }
        gpu.destroy();
    }
    // 2. random models in the preset shapes: GPU against the JS path
    for (const [label, arch] of Object.entries(archs)) {
        const model = randomInfillModel({ ...arch, size: label }, { seed: 7, styles: [{ key: "a", name: "A", maps: 1 }] });
        const net = loadInfill(model);
        let gpu = null;
        await check(`${label}: upload and compile`, async () => {
            gpu = await createInfillGpu(device, model);
            return { worst: 0 };
        });
        if (!gpu) continue;
        const T = arch.T ?? 160;
        const inp = randomInputs(net, T, 3);
        await check(`${label} encoder out vs encodeBeats (T ${T})`, async () => {
            const enc = await gpu.encode(inp);
            const ref = encodeBeats(net, inp);
            enc.release();
            return { worst: maxDiff(enc.out, ref.out) };
        });
        await check(`${label} teacher-forced logits vs JS (T ${T})`, async () => {
            const wanted = wantedOf(inp, 60, 5);
            const got = await gpu.teacherForced(inp, inp.rows, wanted);
            const ref = teacherForced(net, inp, inp.rows, wanted);
            return { worst: maxDiff2(got, ref) };
        });
        gpu.destroy();
    }
    return results;
}
