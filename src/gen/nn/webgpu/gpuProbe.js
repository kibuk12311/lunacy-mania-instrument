// The checks that decide whether the GPU path is used (ML addendum §11, stream W): it is chosen only when WebGPU gives
// an adapter AND these pass. Both run the path generation really uses — the encoder and the decoder's static K/V on the
// GPU, the decoder, lane head and sampling on the CPU (createDecoder over the GPU's numbers):
//   probeGpu(device)            a small random model, GPU against the plain-JS path (no file needed; at start-up)
//   checkModelOnGpu(gpu, model) the model's own parity probes (PyTorch logits, written by tools/export_infill.py)
// Both answer { ok, worst, tol, ms }; ok means max |Δ logit| ≤ tol (2e-3, as the CPU path's own parity).
import { createDecoder, createHistory, loadInfill, randomInfillModel, teacherForced, probeInputs, IN_DIM, N_LANES, LANE_VALUES } from "../infillModel.js";
import { createInfillGpu } from "./infillGpu.js";
import { mulberry32 } from "../../rng.js";

const NV = LANE_VALUES.length;
const PRESENT = LANE_VALUES.indexOf("present");
const DIV_CLASSES = [4, 3, 6, 8];
export const PROBE_TOLERANCE = 2e-3;
// small, but every kernel's loops run past one tile / one workgroup and the attention windows clip
export const PROBE_ARCH = { d: 48, enc_layers: 2, enc_heads: 4, enc_ffn: 80, dec_d: 32, dec_layers: 2, dec_heads: 4, dec_ffn: 64, lane_hidden: 24, win: 8, dec_win: 8, cross_win: 6, n_glob: 2 };

const divOf = (inp, b) => {
    if (inp.div) return DIV_CLASSES[inp.div[b]];
    for (let k = 0; k < DIV_CLASSES.length; k += 1) if (inp.x[b * IN_DIM + IN_DIM - DIV_CLASSES.length + k] > 0.5) return DIV_CLASSES[k];
    return 4;
};

// Teacher-forced logits at wanted slots ([[beat, lane], …]) with the encoder on the GPU and the decoder on the CPU.
export async function teacherForcedGpuEncoder(gpu, inp, rows, wanted) {
    const enc = await gpu.encode(inp, { read: true });
    enc.release();
    const dec = createDecoder(gpu.net, enc, inp);
    const hist = createHistory();
    const want = new Map(wanted.map(([b, l], k) => [b * N_LANES + l, k]));
    const out = new Array(wanted.length);
    const h = new Float32Array(68);
    for (let b = 0; b < inp.T; b += 1) {
        dec.advance(b ? rows : null, (b - 1) * N_LANES);
        const dv = divOf(inp, b);
        for (let l = 0; l < N_LANES; l += 1) {
            if (!(inp.x[b * IN_DIM + l * NV + PRESENT] > 0.5)) continue;
            const p = b + l / dv;
            const k = want.get(b * N_LANES + l);
            if (k !== undefined) out[k] = Array.from(dec.laneLogits(l, hist.features(p, h)));
            hist.push(rows[b * N_LANES + l], p);
        }
    }
    return out;
}

const worstOf = (A, B) => A.reduce((w, a, k) => a.reduce((x, v, c) => Math.max(x, Math.abs(v - B[k][c])), w), 0);

// A probe input: T beats of mixed grids, some visible masks, echo keys beyond the window.
export function probeCase(net, T = 40, seed = 1) {
    const rng = mulberry32(seed);
    const grids = [4, 3, 4, 6, 4, 8];
    const x = new Float32Array(T * IN_DIM);
    const visible = new Uint8Array(T * N_LANES).fill(255);
    const rows = new Uint8Array(T * N_LANES);
    const div = new Uint8Array(T);
    const wanted = [];
    for (let t = 0; t < T; t += 1) {
        const dv = grids[t % grids.length];
        div[t] = DIV_CLASSES.indexOf(dv);
        for (let l = 0; l < dv; l += 1) {
            const o = t * IN_DIM + l * NV;
            for (let k = 0; k < PRESENT; k += 1) x[o + k] = rng() * 2 - 1;
            x[o + PRESENT] = 1;
            rows[t * N_LANES + l] = rng() < 0.4 ? 1 + Math.floor(rng() * 15) : 0;
            if (rng() < 0.15) visible[t * N_LANES + l] = Math.floor(rng() * 16);
            if ((t * 7 + l) % 9 === 0) wanted.push([t, l]);
        }
        for (let k = N_LANES * NV; k < IN_DIM - 4; k += 1) x[t * IN_DIM + k] = rng() * 2 - 1;
        x[t * IN_DIM + IN_DIM - 4 + div[t]] = 1;
    }
    const echo = new Int32Array(T * 2).fill(-1);
    for (let t = 24; t < T; t += 5) {
        echo[t * 2] = t - 20;
        echo[(t - 20) * 2 + 1] = t;
    }
    return {
        inp: {
            T, x, visible, div, echo, fam: Uint8Array.from({ length: T }, (_, t) => t % 7), dan: Float32Array.from({ length: T }, (_, t) => 3 + (t % 11)),
            danKnown: 1, msd: Float64Array.from({ length: 8 }, (_, k) => 8 + 2 * k), style: net.arch.n_styles > 1 ? 1 : 0, source: 1, rate: 1,
        },
        rows, wanted,
    };
}

export async function probeGpu(device, { create = createInfillGpu, tol = PROBE_TOLERANCE } = {}) {
    const t0 = performance.now();
    const model = randomInfillModel(PROBE_ARCH, { seed: 5, styles: [{ key: "probe", name: "probe", maps: 1 }] });
    const net = loadInfill(model);
    const gpu = await create(device, model);
    try {
        const { inp, rows, wanted } = probeCase(net);
        const got = await teacherForcedGpuEncoder(gpu, inp, rows, wanted);
        const ref = teacherForced(net, inp, rows, wanted);
        const worst = worstOf(got, ref);
        return { ok: worst <= tol, worst, tol, ms: Math.round(performance.now() - t0) };
    } finally {
        gpu.destroy();
    }
}

// The model's own parity probes through the GPU encoder; a model without probes passes on the synthetic probe alone.
export async function checkModelOnGpu(gpu, model, { tol = null } = {}) {
    const t0 = performance.now();
    const limit = tol ?? model?.parity?.tolerance ?? PROBE_TOLERANCE;
    let worst = 0;
    const probes = model?.parity?.probes ?? [];
    for (const probe of probes) {
        const inp = probeInputs(probe);
        worst = Math.max(worst, worstOf(await teacherForcedGpuEncoder(gpu, inp, inp.rows, probe.check), probe.logits));
    }
    return { ok: worst <= limit, worst, tol: limit, probes: probes.length, ms: Math.round(performance.now() - t0) };
}
