// nn-v2 row sources over the GPU (ML addendum §11, stream W).
//
// createGpuInfillSource(backend): the same source as infillSource (src/gen/nn/infillModel.js §2.7 interface), but
//   prepare() is async and runs the encoder and the decoder's static K/V through backend.encode(model, inputs); the
//   decoder and the sampler stay infillSource's own (CPU), so step() is synchronous and draws the same RNG as the CPU
//   path. A backend failure falls back to the CPU encoder for that prepare. The caller awaits prepare (awaiting a
//   plain object is harmless, so `await source.prepare(…)` works for every source).
//
// createGpuDecodeSession(gpu, encoded, inputs): the decoder on the GPU too, for builds that run concurrently: each
//   stream() is one build with async step(); the decoder steps of all streams waiting at the same time go to the GPU
//   in one dispatch (one workgroup per build). Same semantics as infillSource's step (known and fixed rows are
//   teacher-forced and draw no RNG; a slot below the last one starts a new build), same pickRow.
import { infillSource, loadInfill, buildInfillInputs, pickRow, createHistory, IN_DIM, N_LANES, DIV_CLASSES } from "../infillModel.js";

const FREE = 255;
const HIST_LEN = 68;

// x normalised as the encoder and the lane head read it (encodeBeats' xn)
export function normalizedInputs(net, inp) {
    const xn = new Float32Array(inp.T * IN_DIM);
    for (let t = 0; t < inp.T; t += 1) for (let c = 0; c < IN_DIM; c += 1) xn[t * IN_DIM + c] = (inp.x[t * IN_DIM + c] - net.mean[c]) * net.inv[c];
    return xn;
}

// What a backend needs of buildInfillInputs' result (plain typed arrays, so it crosses a MessagePort).
export function encoderPayload(inp) {
    const { T, x, visible, fam, dan, danKnown, msd, style, source, rate, echo, div } = inp;
    return { T, x, visible, fam, dan, danKnown, msd, style, source, rate, echo, div };
}

// backend.encode(model, inputs) → Promise<{ e2d: Float32Array(T·dd), cross: Float32Array[dec_layers] (T·2dd each) }>
export function createGpuInfillSource(backend, { onError = null } = {}) {
    return {
        kind: "nn-v2",
        caps: { infill: true },
        gpu: true,
        async prepare(args) {
            const net = loadInfill(args.model);
            const inputs = buildInfillInputs(net, args);
            if (!inputs.T) return infillSource.prepare({ ...args, encoded: { inputs } });
            let enc = null;
            try {
                const got = await backend.encode(args.model, inputs);
                if (got?.e2d?.length === inputs.T * net.arch.dec_d && got.cross?.length === net.arch.dec_layers) {
                    enc = { T: inputs.T, d: net.arch.d, out: null, xn: normalizedInputs(net, inputs), e2d: got.e2d, cross: got.cross };
                } else {
                    throw new Error("nn-v2 GPU: the encoder answered with the wrong shapes");
                }
            } catch (error) {
                onError?.(error);
            }
            const prep = infillSource.prepare({ ...args, encoded: { inputs, ...(enc ? { enc } : {}) } });
            prep.stats.gpu = Boolean(enc);
            return prep;
        },
    };
}

// ---- the decoder on the GPU, batched over concurrent builds ----
// gpu: createInfillGpu's object; encoded: gpu.encode(inputs, { read: false }) (GPU-resident); known as in prepare.
// keepAlive: that many chains of empty GPU submissions run while a decode is waiting, which keeps the GPU process
// polling and roughly halves the readback latency on Windows (§ numbers in docs/2026-10-26-webgpu-stream-w.md).
export function createGpuDecodeSession(gpu, encoded, inputs, { known = null, schedule = null, keepAlive = 0, maxBatch = Infinity } = {}) {
    const net = gpu.net;
    const { dec_d: dd, lane_hidden: hh } = net.arch;
    const dec = gpu.decoder(encoded);
    const inp = inputs;
    const T = inp.T;
    const stats = { dispatches: 0, beats: 0, batched: 0, maxBatch: 0, gpuMs: 0 };
    let pending = [];
    let scheduled = false;
    // a macrotask after the current microtasks: every stream resumed by the last readback has queued its next beat
    const later = schedule ?? ((fn) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
            ch.port1.close();
            fn();
        };
        ch.port2.postMessage(0);
    });
    let inFlight = 0;
    let alive = 0;
    let lastAsk = 0;
    // a keep-alive chain: a 16-byte copy and its readback, again and again (each one a real GPU process round trip)
    const pulse = async () => {
        alive += 1;
        const dev = gpu.device;
        const src = dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const dst = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        try {
            while (inFlight > 0 || performance.now() - lastAsk < 20) {
                const e = dev.createCommandEncoder();
                e.copyBufferToBuffer(src, 0, dst, 0, 16);
                dev.queue.submit([e.finish()]);
                await dst.mapAsync(GPUMapMode.READ);
                dst.unmap();
            }
        } finally {
            src.destroy();
            dst.destroy();
            alive -= 1;
        }
    };
    async function flush() {
        scheduled = false;
        const list = pending.splice(0, maxBatch);
        if (pending.length) later(flush);
        if (!list.length) return;
        inFlight += 1;
        while (alive < keepAlive) pulse();
        stats.dispatches += 1;
        stats.batched += list.length;
        stats.maxBatch = Math.max(stats.maxBatch, list.length);
        const t0 = performance.now();
        try {
            const res = await dec.run(list.map((r) => r.item));
            stats.gpuMs += performance.now() - t0;
            list.forEach((r, k) => r.resolve(res[k]));
        } catch (error) {
            list.forEach((r) => r.reject(error));
        } finally {
            inFlight -= 1;
        }
    }
    const request = (item) => new Promise((resolve, reject) => {
        pending.push({ item, resolve, reject });
        lastAsk = performance.now();
        stats.beats += item.n;
        if (!scheduled) {
            scheduled = true;
            later(flush);
        }
    });
    const posOf = (i) => inp.beatOf[i] + inp.laneOf[i] / DIV_CLASSES[inp.div[inp.beatOf[i]]];
    const knownAt = (i) => (known && known[i] !== FREE ? known[i] & 15 : null);
    const per = dec.per;

    function stream() {
        let slot = dec.slot();
        const rows = new Uint8Array(T * N_LANES);
        const hist = createHistory();
        const logits = new Float32Array(16);
        const p = new Float64Array(16);
        const h = new Float32Array(HIST_LEN);
        let cur = 0;
        let beat = 0; // beats decoded so far in this build
        let last = null; // the decoder output of beat `beat − 1`
        const begin = () => {
            cur = 0;
            beat = 0;
            last = null;
            hist.clear();
        };
        const record = (i, m) => {
            rows[inp.beatOf[i] * N_LANES + inp.laneOf[i]] = m;
            hist.push(m, posOf(i));
        };
        async function sample(i, offset, rngs, weightOf) {
            const b = inp.beatOf[i];
            if (beat <= b) {
                const n = b - beat + 1;
                const prev = new Uint8Array(n * N_LANES);
                for (let k = 0; k < n; k += 1) if (beat + k > 0) prev.set(rows.subarray((beat + k - 1) * N_LANES, (beat + k) * N_LANES), k * N_LANES);
                const res = await request({ slot, b0: beat, n, rows: prev });
                last = res.subarray((n - 1) * per, n * per);
                beat = b + 1;
            }
            gpu.laneHead(last, dd + inp.laneOf[i] * hh, hist.features(posOf(i), h), logits);
            return pickRow(logits, offset, rngs, weightOf, p);
        }
        return {
            begin,
            async step(i, offset, ctx, rngs, weightOf = null, fixed = undefined) {
                if (i < cur) begin();
                while (cur < i) {
                    record(cur, knownAt(cur) ?? 0);
                    cur += 1;
                }
                const forced = Number.isInteger(fixed) && fixed >= 0 && fixed < 16 ? fixed : knownAt(i);
                const m = forced ?? (await sample(i, offset, rngs, weightOf));
                record(i, m);
                cur = i + 1;
                return m;
            },
            snapshot() {
                const copy = dec.slot();
                dec.copy(slot, copy);
                return { cur, beat, last, rows: rows.slice(), hist: hist.snapshot(), ring: copy };
            },
            restore(s) {
                cur = s.cur;
                beat = s.beat;
                last = s.last;
                rows.set(s.rows);
                hist.restore(s.hist);
                dec.copy(s.ring, slot);
            },
            dropSnapshot(s) { dec.free(s.ring); },
            close() {
                if (slot !== null) dec.free(slot);
                slot = null;
            },
            get rows() { return rows; },
        };
    }
    return { stream, stats, inputs: inp, T };
}

// A local backend for createGpuInfillSource over createInfillGpu objects, one per model object (renderer side).
export function localGpuBackend(device, createInfillGpu) {
    const byModel = new WeakMap();
    return {
        async encode(model, inputs) {
            if (!byModel.has(model)) byModel.set(model, createInfillGpu(device, model));
            const gpu = await byModel.get(model);
            const enc = await gpu.encode(inputs, { read: true });
            enc.release();
            return { e2d: enc.e2d, cross: enc.cross };
        },
    };
}

export { buildInfillInputs };

// The nn-v2 row source for a job: over the GPU encoder when the job has a backend (generatorJobs' opts.nnBackend),
// else the plain-JS infillSource. For the generator's sourceFor (G3): `return infillSourceFor(opts.nnBackend)`, and
// `await source.prepare(…)` (the GPU one is async; awaiting the CPU one changes nothing).
const gpuSources = new WeakMap();
export function infillSourceFor(nnBackend = null) {
    if (!nnBackend) return infillSource;
    if (!gpuSources.has(nnBackend)) gpuSources.set(nnBackend, createGpuInfillSource(nnBackend));
    return gpuSources.get(nnBackend);
}
