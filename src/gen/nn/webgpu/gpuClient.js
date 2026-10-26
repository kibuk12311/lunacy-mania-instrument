// The generator worker's side of the GPU link (ML addendum §11, stream W): a port to the hidden GPU renderer
// (src/gen/nn/webgpu/gpuServer.js), its capability, and a backend for createGpuInfillSource.
//
//   const gpu = createGpuClient();
//   gpu.attach(port)                 // Electron MessagePortMain, Node worker_threads MessagePort or a DOM MessagePort
//   await gpu.ready(4000)            // the capability, or null when the renderer did not answer in time
//   gpu.available()                  // an adapter, and the start-up probe passed
//   gpu.backend.encode(model, inp)   // → { e2d, cross } (the model is uploaded and checked once, on first use)
//
// Without a port (no GPU renderer, tests, the CLI tools) nothing is available and nothing waits.
import { encoderPayload } from "./gpuSource.js";

const listen = (port, fn) => {
    if (typeof port.on === "function") {
        port.on("message", (e) => fn(e?.data !== undefined && e?.ports !== undefined ? e.data : e));
        port.start?.();
    } else {
        port.onmessage = (e) => fn(e.data);
    }
};

export function createGpuClient({ timeoutMs = 30_000 } = {}) {
    let port = null;
    let nextId = 0;
    let capability = null;
    const pending = new Map();
    const waiters = new Set();
    const keys = new WeakMap(); // model object → { key, loaded: Promise }
    let nextKey = 0;

    function settle(id, msg) {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.message ?? "GPU request failed"));
    }

    function request(op, body = {}, ms = timeoutMs) {
        if (!port) return Promise.reject(new Error("no GPU link"));
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`GPU ${op}: no answer in ${ms} ms`));
            }, ms);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            try {
                port.postMessage({ id, op, ...body });
            } catch (error) {
                settle(id, { ok: false, message: String(error?.message ?? error) });
            }
        });
    }

    function attach(p) {
        port = p;
        listen(p, (msg) => {
            if (msg && pending.has(msg.id)) settle(msg.id, msg);
        });
        p.on?.("close", () => {
            if (port !== p) return;
            port = null;
            capability = capability ? { ...capability, gpuAvailable: false, reason: "the GPU renderer went away" } : null;
            for (const [id] of [...pending]) settle(id, { ok: false, message: "the GPU renderer went away" });
        });
        request("hello").then((msg) => {
            capability = msg.capability ?? null;
        }, () => {
            capability = { gpuAvailable: false, adapter: null, reason: "no answer from the GPU renderer", probe: null, decoder: "cpu" };
        }).finally(() => {
            for (const w of waiters) w();
            waiters.clear();
        });
    }

    // the capability once the renderer has answered hello (or failed to); null after ms without one
    function ready(ms = 4000) {
        if (capability || !port) return Promise.resolve(capability);
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                waiters.delete(done);
                resolve(capability);
            };
            const timer = setTimeout(done, ms);
            timer.unref?.();
            waiters.add(done);
        });
    }

    const backend = {
        async encode(model, inputs) {
            let entry = keys.get(model);
            if (!entry) {
                const key = `m${++nextKey}`;
                entry = { key, loaded: request("load", { key, model }, 120_000) };
                keys.set(model, entry);
            }
            await entry.loaded; // a model that failed its GPU checks keeps failing here: the source then uses the CPU
            const out = await request("encode", { key: entry.key, inputs: encoderPayload(inputs) });
            return { e2d: out.e2d, cross: out.cross };
        },
    };

    // closes the port (the renderer's side closes with it); pending requests fail
    function close() {
        const p = port;
        port = null;
        for (const [id] of [...pending]) settle(id, { ok: false, message: "the GPU link closed" });
        try {
            p?.close?.();
        } catch {
            // already closed
        }
    }

    return {
        attach,
        close,
        ready,
        backend,
        attached: () => Boolean(port),
        capability: () => capability,
        available: () => Boolean(port && capability?.gpuAvailable),
    };
}
