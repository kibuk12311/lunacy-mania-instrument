// A stand-in for createInfillGpu (src/gen/nn/webgpu/infillGpu.js) that computes everything on the CPU with the plain-JS
// path, so the GPU-side logic (sources, decode sessions, the worker ↔ renderer protocol) is testable without a GPU.
// encode() gives encodeBeats' numbers; decoder(enc).run() gives, per beat, createDecoder's z and the lane head's first
// layer without the history (the same split as the GPU kernel).
// exactBackend(): a decode-capable backend (gpuClient's interface) in process, whose decoder answers are createDecoder's
// z, read by exactHead: the lane head exactly as the CPU source computes it, so a batch over it samples the CPU's very
// rows (the generator's batch path must then give the CPU path's maps bit for bit).
import { loadInfill, encodeBeats, createDecoder, IN_DIM, N_LANES, LANE_VALUES } from "../../src/gen/nn/infillModel.js";
import { createGpuInfillSource } from "../../src/gen/nn/webgpu/gpuSource.js";
import { linearRows } from "../../src/gen/nn/kernels.js";
import { createLaneHead } from "../../src/gen/nn/webgpu/infillGpu.js";

const NV = LANE_VALUES.length;
const PRESENT = LANE_VALUES.indexOf("present");

// the lane head's first layer for lane l of beat b with no history: b1 + W1·[z, laneEmb_l, 0, laneValues]
export function baseOf(net, z, xn, b, l) {
    const { dec_d: dd, lane_hidden: hh, lane_emb: le } = net.arch;
    const hin = dd + le + 68 + NV;
    const W1 = net.W["head1.weight"];
    const hle = net.W["head_lane_emb.weight"];
    const out = new Float32Array(hh);
    for (let j = 0; j < hh; j += 1) {
        let s = net.W["head1.bias"][j];
        for (let i = 0; i < dd; i += 1) s += W1[j * hin + i] * z[i];
        for (let i = 0; i < le; i += 1) s += W1[j * hin + dd + i] * hle[l * le + i];
        for (let c = 0; c < NV; c += 1) s += W1[j * hin + dd + le + 68 + c] * xn[b * IN_DIM + l * NV + c];
        out[j] = s;
    }
    return out;
}

export function staticsOf(net, enc) {
    const { d, dec_d: dd } = net.arch;
    return {
        e2d: linearRows(enc.out, enc.T, net.W["e2d.weight"], net.W["e2d.bias"], d, dd),
        cross: Array.from({ length: net.arch.dec_layers }, (_, l) => linearRows(enc.out, enc.T, net.W[`dec.${l}.ckv.weight`], net.W[`dec.${l}.ckv.bias`], d, 2 * dd)),
    };
}

export function fakeInfillGpu(model, { calls = [] } = {}) {
    const net = loadInfill(model);
    const { dec_d: dd, lane_hidden: hh } = net.arch;
    return {
        net, arch: net.arch, device: null, calls,
        laneHead: createLaneHead(net),
        async encode(inp, { read = true } = {}) {
            calls.push(["encode", inp.T, read]);
            const enc = encodeBeats(net, inp);
            return { ...enc, ...staticsOf(net, enc), inp, release() {} };
        },
        decoder(enc) {
            const per = dd + N_LANES * hh;
            const decs = new Map();
            let next = 0;
            const freed = [];
            const decOf = (slot) => {
                if (!decs.has(slot)) decs.set(slot, createDecoder(net, enc, enc.inp));
                return decs.get(slot);
            };
            return {
                per,
                slot: () => (freed.length ? freed.pop() : next++),
                free: (slot) => freed.push(slot),
                copy: (from, to) => decOf(to).restore(decOf(from).snapshot()),
                async run(list, { last = false } = {}) {
                    calls.push(["run", list.length]);
                    await Promise.resolve();
                    const all = list.map(({ slot, b0, n, rows }) => {
                        const dec = decOf(slot);
                        if (b0 === 0) dec.reset();
                        if (dec.beat !== b0) throw new Error(`fake decoder: slot ${slot} at beat ${dec.beat}, asked for ${b0}`);
                        const out = new Float32Array(n * per);
                        for (let k = 0; k < n; k += 1) {
                            const b = b0 + k;
                            dec.advance(b ? rows : null, k * N_LANES);
                            const z = dec.snapshot().z;
                            out.set(z, k * per);
                            for (let l = 0; l < N_LANES; l += 1) {
                                if (!(enc.inp.x[b * IN_DIM + l * NV + PRESENT] > 0.5)) continue;
                                out.set(baseOf(net, z, enc.xn, b, l), k * per + dd + l * hh);
                            }
                        }
                        return out;
                    });
                    return last ? all.map((out, k) => out.slice((list[k].n - 1) * per)) : all;
                },
            };
        },
        destroy() {},
    };
}

// fail(round) → true makes that decode round throw ("device lost"); hang(round) → true makes it never answer;
// rounds: every decode's item count; sessions: the open ones.
export function exactBackend({ fail = null, hang = null } = {}) {
    const sessions = new Map();
    const rounds = [];
    let next = 0;
    return {
        rounds,
        sessions,
        released: [],
        async encode(model, inputs, { keep = false } = {}) {
            const net = loadInfill(model);
            const enc = encodeBeats(net, inputs);
            const statics = staticsOf(net, enc);
            if (!keep) return statics;
            const id = ++next;
            sessions.set(id, { net, enc: { ...enc, ...statics }, inputs, rings: new Map() });
            return { ...statics, session: id };
        },
        async decode(session, { ops = [], items = [] } = {}) {
            const s = sessions.get(session);
            if (!s) throw new Error(`decode session ${session} is not open`);
            const ring = (ref) => {
                if (!s.rings.has(ref)) s.rings.set(ref, createDecoder(s.net, s.enc, s.inputs));
                return s.rings.get(ref);
            };
            for (const [kind, a, b] of ops) {
                if (kind === "copy") ring(b).restore(ring(a).snapshot());
                else s.rings.delete(a);
            }
            if (!items.length) return {};
            rounds.push(items.length);
            if (fail?.(rounds.length)) throw new Error("device lost");
            if (hang?.(rounds.length)) return new Promise(() => {});
            await Promise.resolve();
            const dd = s.net.arch.dec_d;
            const out = new Float32Array(items.length * dd);
            items.forEach(({ ref, b0, n, rows }, k) => {
                const dec = ring(ref);
                if (b0 === 0) dec.reset();
                if (dec.beat !== b0) throw new Error(`exact decoder: ring ${ref} at beat ${dec.beat}, asked for ${b0}`);
                for (let j = 0; j < n; j += 1) dec.advance(b0 + j ? rows : null, j * N_LANES);
                out.set(dec.snapshot().z, k * dd);
            });
            return { out, stride: dd };
        },
        release(session) {
            this.released.push(session);
            sessions.delete(session);
        },
    };
}

// the CPU source's lane head over a decoder state z (as createDecoder.laneLogits computes it, on a scratch decoder):
// a head factory for createGpuBatch
export function exactHead(net, enc, inputs) {
    const dec = createDecoder(net, enc, inputs);
    const ring = dec.snapshot().ring;
    return (z, lane, hist, logits, b) => {
        dec.restore({ beat: b + 1, z, ring });
        return dec.laneLogits(lane, hist, logits);
    };
}

// the GPU source over exactBackend's answers; its batches go together whenever 2 or more builds can (a tiny model's
// CPU decoder is far cheaper than any GPU round, so batches would never pay for it)
export const exactGpuSource = (backend, opts = {}) => createGpuInfillSource(backend, { ...opts, batch: { head: exactHead, policy: "always", ...opts.batch } });
