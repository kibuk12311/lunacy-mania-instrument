// The GPU side of the generator worker ↔ GPU renderer link (ML addendum §11, stream W). Runs in the hidden renderer
// (app/gpuWorker.html): opens a WebGPU device, runs the start-up probe, and answers requests on MessagePorts:
//   { id, op: "hello" }                        → { id, ok, capability }
//   { id, op: "load", key, model }             → { id, ok, check }    upload + compile + the model's own parity probes
//   { id, op: "encode", key, inputs, keep? }   → { id, ok, e2d, cross: Float32Array[], session? }   (encoderPayload)
//   { id, op: "decode", session, ops, items }  → { id, ok, out, stride }   one round of a batch of builds (gpuBatch.js)
//   { id, op: "release", session }             → { id, ok }
//   { id, op: "unload", key }                  → { id, ok }
// A failure is { id, ok: false, message }; nothing here throws past a request. capability = { gpuAvailable, adapter,
// reason, probe: { worst, ms }, decoder: "cpu" } — gpuAvailable only when there is an adapter and the probe passed;
// decoder "cpu": one build at a time decodes on the CPU (batches of several builds use the GPU decoder, per session).
// encode with keep leaves the encoder output on the GPU as a decode session (at most maxSessions; the oldest goes
// first). decode applies the ring ops (["copy", from, to], ["free", ref]; refs are the worker's names for its
// streams and snapshots, each given a decoder ring on first use), then decodes items [{ ref, b0, n, rows }] in one
// dispatch and answers, per item, the lane bases of its last beat (8 × lane_hidden floats at out[k·stride …]).
import { createInfillGpu, createKeepAlive } from "./infillGpu.js";
import { probeGpu, checkModelOnGpu } from "./gpuProbe.js";

export const adapterName = (info) => [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") || "unknown GPU";

// keepAlive: keep-alive chains while a batch decodes (createKeepAlive); maxSessions: decode sessions kept at once
export function createGpuServer({ gpu = globalThis.navigator?.gpu, create = createInfillGpu, probe = probeGpu, check = checkModelOnGpu, log = () => {}, keepAlive = 2, maxSessions = 3 } = {}) {
    let device = null;
    let capability = null;
    const models = new Map(); // key → Promise<gpu model>
    const loadedBy = new Map(); // key → the port it was loaded on (its models go when it closes)
    const sessions = new Map(); // id → { key, g, enc, dec, slots: Map(ref → ring slot) }
    let nextSession = 0;
    let alive = null;

    function closeSession(id) {
        const s = sessions.get(id);
        if (!s) return;
        sessions.delete(id);
        for (const slot of s.slots.values()) s.dec.free(slot);
        s.slots.clear();
        s.enc.release();
    }
    function openSession(key, g, enc, owner) {
        const id = ++nextSession;
        sessions.set(id, { key, g, enc, dec: g.decoder(enc), slots: new Map(), owner });
        while (sessions.size > maxSessions) closeSession(sessions.keys().next().value);
        return id;
    }

    async function open() {
        const t0 = performance.now();
        if (!gpu) return { gpuAvailable: false, adapter: null, reason: "no WebGPU", probe: null, decoder: "cpu" };
        const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) return { gpuAvailable: false, adapter: null, reason: "no adapter", probe: null, decoder: "cpu" };
        const lim = adapter.limits ?? {};
        device = await adapter.requestDevice({
            requiredLimits: {
                ...(lim.maxStorageBufferBindingSize ? { maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 2 ** 30) } : {}),
                ...(lim.maxBufferSize ? { maxBufferSize: Math.min(lim.maxBufferSize, 2 ** 30) } : {}),
            },
        });
        const name = adapterName(adapter.info);
        device.lost?.then((info) => {
            capability = { ...capability, gpuAvailable: false, reason: `device lost: ${info?.message ?? ""}` };
            sessions.clear();
            models.clear();
            log(`gpu: device lost ${info?.message ?? ""}`);
        });
        const pr = await probe(device);
        log(`gpu: ${name}, probe max |Δ| ${pr.worst} in ${pr.ms} ms`);
        return {
            gpuAvailable: Boolean(pr.ok), adapter: name, reason: pr.ok ? null : `probe ${pr.worst} > ${pr.tol}`,
            probe: { worst: pr.worst, ms: pr.ms, total: Math.round(performance.now() - t0) }, decoder: "cpu",
        };
    }
    let started = null;
    const start = () => (started ??= open().then((c) => {
        capability = c;
        return c;
    }, (error) => {
        capability = { gpuAvailable: false, adapter: null, reason: String(error?.message ?? error), probe: null, decoder: "cpu" };
        return capability;
    }));

    async function load(key, model, owner = null) {
        const cap = await start();
        if (!cap.gpuAvailable) throw new Error(`no GPU: ${cap.reason}`);
        if (!models.has(key)) {
            if (owner) loadedBy.set(key, owner);
            const p = (async () => {
                const g = await create(device, model);
                const c = await check(g, model);
                if (!c.ok) {
                    g.destroy();
                    throw new Error(`the model's parity probes fail on this GPU: ${c.worst} > ${c.tol}`);
                }
                g.check = c;
                // the decoder kernel compiles in the background: batches of builds need it, and it takes seconds
                g.warmDecoder?.().catch((error) => log(`gpu: decoder kernel: ${error?.message ?? error}`));
                return g;
            })();
            models.set(key, p);
            p.catch(() => models.delete(key));
        }
        return models.get(key);
    }

    const ops = {
        hello: async () => ({ capability: await start() }),
        load: async ({ key, model }, owner) => ({ check: (await load(key, model, owner)).check }),
        encode: async ({ key, inputs, keep = false }, owner) => {
            const g = models.get(key);
            if (!g) throw new Error(`model ${key} is not loaded`);
            const gm = await g;
            const enc = await gm.encode(inputs, { read: "statics" });
            const cross = enc.cross.map((c) => c.slice());
            const session = keep ? openSession(key, gm, enc, owner) : null;
            if (!keep) enc.release();
            return { e2d: enc.e2d, cross, ...(keep ? { session } : {}), transfer: [enc.e2d.buffer, ...cross.map((c) => c.buffer)] };
        },
        // the ring ops are submitted before the first await, so they reach the GPU queue in the order they were sent
        decode: async ({ session, ops = [], items = [] }) => {
            const s = sessions.get(session);
            if (!s) throw new Error(`decode session ${session} is not open`);
            const slotOf = (ref) => {
                if (!s.slots.has(ref)) s.slots.set(ref, s.dec.slot());
                return s.slots.get(ref);
            };
            // a copy the GPU refused would leave a ring silently wrong: its validation error fails the request instead
            const device = s.g.device;
            const copies = ops.some(([kind]) => kind === "copy") && typeof device?.pushErrorScope === "function";
            if (copies) device.pushErrorScope("validation");
            let failed = null;
            try {
                for (const [kind, a, b] of ops) {
                    if (kind === "copy") {
                        if (!s.slots.has(a)) throw new Error(`decode session ${session}: no ring ${a} to copy`);
                        s.dec.copy(s.slots.get(a), slotOf(b));
                    } else if (kind === "free" && s.slots.has(a)) {
                        s.dec.free(s.slots.get(a));
                        s.slots.delete(a);
                    }
                }
            } catch (error) {
                failed = error;
            }
            if (copies) {
                const error = await device.popErrorScope();
                if (error && !failed) failed = new Error(`decode session ${session}: a ring copy failed: ${error.message}`);
            }
            if (failed) throw failed;
            if (!items.length) return {};
            alive ??= createKeepAlive(s.g.device, keepAlive);
            alive.ask();
            alive.begin();
            try {
                const t0 = performance.now();
                const list = items.map((it) => ({ slot: slotOf(it.ref), b0: it.b0, n: it.n, rows: it.rows }));
                const res = await s.dec.run(list, { last: true });
                const { dec_d: dd, lane_hidden: hh } = s.g.arch;
                const stride = 8 * hh;
                const out = new Float32Array(items.length * stride);
                res.forEach((r, k) => out.set(r.subarray(dd, dd + stride), k * stride));
                return { out, stride, ms: performance.now() - t0, transfer: [out.buffer] };
            } finally {
                alive.end();
            }
        },
        release: async ({ session }) => {
            closeSession(session);
            return {};
        },
        unload: async ({ key }) => {
            const g = models.get(key);
            models.delete(key);
            loadedBy.delete(key);
            for (const [id, s] of [...sessions]) if (s.key === key) closeSession(id);
            if (g) (await g.catch(() => null))?.destroy();
            return {};
        },
    };

    // owner: the port the request came on (its decode sessions go when it closes)
    async function handle(msg, owner = null) {
        const op = ops[msg?.op];
        if (!op) return { ok: false, message: `unknown op ${msg?.op}` };
        try {
            return { ok: true, ...(await op(msg, owner)) };
        } catch (error) {
            return { ok: false, message: String(error?.message ?? error) };
        }
    }

    // port: a DOM MessagePort (renderer) or anything with postMessage + onmessage / on("message"); transferable:
    // whether ArrayBuffers may be moved instead of copied (same-process ports only). A port that closes (a worker that
    // went away mid-batch) takes its decode sessions and its models with it, where the port says so (else
    // maxSessions bounds the sessions; a model stays loaded until the renderer goes).
    function serve(port, { transferable = false } = {}) {
        const gone = () => {
            for (const [id, s] of [...sessions]) if (s.owner === port) closeSession(id);
            for (const [key, by] of [...loadedBy]) if (by === port) ops.unload({ key }).catch(() => {});
        };
        if (typeof port.on === "function") port.on("close", gone);
        else port.addEventListener?.("close", gone);
        const reply = async (msg) => {
            const { transfer = [], ...out } = await handle(msg, port);
            const message = { id: msg?.id, ...out };
            try {
                // a port to another process (Electron's MessagePortMain) cannot take ArrayBuffers as transferables:
                // those arrays are copied instead
                if (transfer.length && transferable) port.postMessage(message, transfer);
                else port.postMessage(message);
            } catch {
                try {
                    port.postMessage(message);
                } catch {
                    // the worker went away
                }
            }
        };
        if (typeof port.on === "function") {
            port.on("message", (e) => reply(e?.data !== undefined && e?.ports !== undefined ? e.data : e));
            port.start?.();
        } else {
            port.onmessage = (e) => reply(e.data);
        }
    }

    return { start, serve, handle, capability: () => capability, sessions: () => sessions.size };
}
