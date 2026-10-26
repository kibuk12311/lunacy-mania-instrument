// The GPU side of the generator worker ↔ GPU renderer link (ML addendum §11, stream W). Runs in the hidden renderer
// (app/gpuWorker.html): opens a WebGPU device, runs the start-up probe, and answers requests on MessagePorts:
//   { id, op: "hello" }                        → { id, ok, capability }
//   { id, op: "load", key, model }             → { id, ok, check }    upload + compile + the model's own parity probes
//   { id, op: "encode", key, inputs }          → { id, ok, e2d, cross: Float32Array[] }   (encoderPayload(inputs))
//   { id, op: "unload", key }                  → { id, ok }
// A failure is { id, ok: false, message }; nothing here throws past a request. capability = { gpuAvailable, adapter,
// reason, probe: { worst, ms }, decoder: "cpu" } — gpuAvailable only when there is an adapter and the probe passed.
import { createInfillGpu } from "./infillGpu.js";
import { probeGpu, checkModelOnGpu } from "./gpuProbe.js";

export const adapterName = (info) => [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") || "unknown GPU";

export function createGpuServer({ gpu = globalThis.navigator?.gpu, create = createInfillGpu, probe = probeGpu, check = checkModelOnGpu, log = () => {} } = {}) {
    let device = null;
    let capability = null;
    const models = new Map(); // key → Promise<gpu model>

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

    async function load(key, model) {
        const cap = await start();
        if (!cap.gpuAvailable) throw new Error(`no GPU: ${cap.reason}`);
        if (!models.has(key)) {
            const p = (async () => {
                const g = await create(device, model);
                const c = await check(g, model);
                if (!c.ok) {
                    g.destroy();
                    throw new Error(`the model's parity probes fail on this GPU: ${c.worst} > ${c.tol}`);
                }
                g.check = c;
                return g;
            })();
            models.set(key, p);
            p.catch(() => models.delete(key));
        }
        return models.get(key);
    }

    const ops = {
        hello: async () => ({ capability: await start() }),
        load: async ({ key, model }) => ({ check: (await load(key, model)).check }),
        encode: async ({ key, inputs }) => {
            const g = models.get(key);
            if (!g) throw new Error(`model ${key} is not loaded`);
            const enc = await (await g).encode(inputs, { read: "statics" });
            enc.release();
            const cross = enc.cross.map((c) => c.slice());
            return { e2d: enc.e2d, cross, transfer: [enc.e2d.buffer, ...cross.map((c) => c.buffer)] };
        },
        unload: async ({ key }) => {
            const g = models.get(key);
            models.delete(key);
            if (g) (await g.catch(() => null))?.destroy();
            return {};
        },
    };

    async function handle(msg) {
        const op = ops[msg?.op];
        if (!op) return { ok: false, message: `unknown op ${msg?.op}` };
        try {
            return { ok: true, ...(await op(msg)) };
        } catch (error) {
            return { ok: false, message: String(error?.message ?? error) };
        }
    }

    // port: a DOM MessagePort (renderer) or anything with postMessage + onmessage / on("message"); transferable:
    // whether ArrayBuffers may be moved instead of copied (same-process ports only)
    function serve(port, { transferable = false } = {}) {
        const reply = async (msg) => {
            const { transfer = [], ...out } = await handle(msg);
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

    return { start, serve, handle, capability: () => capability };
}
