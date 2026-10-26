// Stream W in the app: the main-process GPU host (app/gpuWorkerHost.js) over a fake Electron, the worker client's
// GPU-port hook, the generator worker's link (app/gpuWorkerLink.js), generatorJobs' nnBackend hook, generator-info's
// gpu field and the hidden page's files. The GPU is the CPU stand-in of tests/helpers/fakeGpu.js.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { createGpuWorkerHost, registerGpuWorkerHost, GPU_PAGE, GPU_PRELOAD, GPU_PORT_CHANNEL } from "../app/gpuWorkerHost.js";
import { createGpuWorkerLink } from "../app/gpuWorkerLink.js";
import { createWorkerClient, setGpuPortHook } from "../app/workerClient.js";
import { createGeneratorJobs } from "../app/generatorJobs.js";
import { registerCreateIpc } from "../app/createIpc.js";
import { createGpuServer } from "../src/gen/nn/webgpu/gpuServer.js";
import { createGpuClient } from "../src/gen/nn/webgpu/gpuClient.js";
import { fakeInfillGpu } from "./helpers/fakeGpu.js";
import { stripComments } from "./helpers/source.js";

const fakeGpuApi = (over = {}) => ({
    gpu: { requestAdapter: async () => ({ info: { vendor: "nvidia", architecture: "blackwell" }, limits: {}, requestDevice: async () => ({ lost: new Promise(() => {}) }) }) },
    create: async (_device, model) => fakeInfillGpu(model),
    probe: async () => ({ ok: true, worst: 1e-7, tol: 2e-3, ms: 3 }),
    check: async () => ({ ok: true, worst: 0, tol: 2e-3, probes: 0, ms: 1 }),
    ...over,
});

// Electron's BrowserWindow / MessageChannelMain, with the GPU page's server behind webContents.postMessage
function fakeElectron(serverOver = {}) {
    const windows = [];
    const server = createGpuServer(fakeGpuApi(serverOver));
    class BrowserWindow {
        constructor(options) {
            this.options = options;
            this.events = {};
            this.posted = [];
            const self = this;
            this.webContents = {
                events: {},
                on(event, fn) { this.events[event] = fn; },
                setWindowOpenHandler(fn) { self.openHandler = fn; },
                postMessage(channel, message, ports) {
                    self.posted.push(channel);
                    if (channel === GPU_PORT_CHANNEL) server.serve(ports[0]);
                },
            };
            windows.push(this);
        }
        async loadFile(file) { this.loaded = file; }
        on(event, fn) { this.events[event] = fn; }
        destroy() { this.destroyed = true; }
    }
    class MessageChannelMain {
        constructor() {
            const { port1, port2 } = new MessageChannel();
            this.port1 = port1;
            this.port2 = port2;
        }
    }
    return { electron: { BrowserWindow, MessageChannelMain, app: { whenReady: async () => {} } }, windows };
}

test("host: a hidden, sandboxed page with only the port preload; navigation blocked; capability from the probe", async () => {
    const { electron, windows } = fakeElectron();
    const host = createGpuWorkerHost({ electron });
    assert.equal(windows.length, 0, "nothing starts before it is asked");
    const cap = await host.info(2000);
    assert.equal(cap.gpuAvailable, true);
    assert.equal(cap.adapter, "nvidia blackwell");
    assert.equal(cap.decoder, "cpu");
    assert.equal(windows.length, 1);
    const [win] = windows;
    assert.equal(win.options.show, false);
    assert.deepEqual(
        { ...win.options.webPreferences },
        { preload: GPU_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    );
    assert.equal(win.loaded, GPU_PAGE);
    let prevented = false;
    win.webContents.events["will-navigate"]({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    assert.deepEqual(win.openHandler(), { action: "deny" });
    await host.info();
    assert.equal(windows.length, 1, "one window for the whole session");
    host.dispose();
    assert.ok(win.destroyed);
});

test("host: a worker that asks gets a working port; with no GPU it gets { none: true } and its capability", async () => {
    const { electron } = fakeElectron();
    const host = createGpuWorkerHost({ electron });
    const sent = [];
    await host.connect({ postMessage: (message, ports) => sent.push({ message, ports }) });
    assert.equal(sent[0].message.kind, "gpu-port");
    assert.equal(sent[0].ports.length, 1);
    const client = createGpuClient();
    client.attach(sent[0].ports[0]);
    assert.equal((await client.ready(2000)).gpuAvailable, true);
    client.close();
    host.dispose();

    const broken = fakeElectron({ probe: async () => ({ ok: false, worst: 1, tol: 2e-3, ms: 1 }) });
    const host2 = createGpuWorkerHost({ electron: broken.electron });
    const got = [];
    await host2.connect({ postMessage: (message, ports) => got.push({ message, ports }) });
    assert.equal(got[0].message.none, true);
    assert.equal(got[0].message.capability.gpuAvailable, false);
    assert.equal(got[0].ports, undefined);
    host2.dispose();
});

test("host: outside Electron the GPU is unavailable at once; a renderer that dies resets the capability", async () => {
    const plain = createGpuWorkerHost({ electron: null });
    const cap = await plain.info(1000);
    assert.equal(cap.gpuAvailable, false);
    assert.equal(cap.reason, "no Electron");
    const { electron, windows } = fakeElectron();
    const host = createGpuWorkerHost({ electron });
    await host.info();
    windows[0].webContents.events["render-process-gone"]({}, { reason: "crashed" });
    assert.equal(host.capability().gpuAvailable, false);
    assert.match(host.capability().reason, /crashed/);
    await host.info(2000);
    assert.equal(windows.length, 2, "the next ask starts a new renderer");
    assert.equal(host.capability().gpuAvailable, true);
    host.dispose();
});

test("worker client: a worker's { gpuPort: true } reaches the hook with that worker; registerGpuWorkerHost sets it", async () => {
    const asked = [];
    setGpuPortHook((w) => asked.push(w));
    const w = Object.assign(new EventEmitter(), { postMessage() {}, kill() {} });
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 50 });
    const pending = client.analyze("x", 1);
    w.emit("message", { gpuPort: true });
    assert.deepEqual(asked, [w]);
    await pending;
    client.dispose();
    const host = registerGpuWorkerHost({ log: () => {} });
    assert.equal(typeof host.connect, "function");
    setGpuPortHook(null);
    w.emit("message", { gpuPort: true }); // no hook: nothing happens
});

test("worker link: asks once, takes the port, hands out the backend; none or silence → null within the wait", async () => {
    const posts = [];
    const link = createGpuWorkerLink({ post: (m) => posts.push(m), waitMs: 1000 });
    assert.equal(link.accept({ id: 1, kind: "analyze" }, []), false);
    const pending = link.backend();
    assert.deepEqual(posts, [{ gpuPort: true }]);
    const { port1, port2 } = new MessageChannel();
    createGpuServer(fakeGpuApi()).serve(port2);
    assert.equal(link.accept({ kind: "gpu-port" }, [port1]), true);
    const backend = await pending;
    assert.equal(typeof backend.encode, "function");
    assert.equal(await link.backend(), backend);
    assert.deepEqual(posts, [{ gpuPort: true }], "asked once");
    assert.equal(link.autoGpu(), false, "the decoder runs on the CPU: auto keeps the CPU sizes");
    port1.close();

    const none = createGpuWorkerLink({ post: () => {}, waitMs: 1000 });
    const p = none.backend();
    none.accept({ kind: "gpu-port", none: true }, []);
    assert.equal(await p, null);
    const silent = createGpuWorkerLink({ post: () => {}, waitMs: 30 });
    const t0 = Date.now();
    assert.equal(await silent.backend(), null);
    assert.ok(Date.now() - t0 < 1000);
    const throwing = createGpuWorkerLink({ post: () => { throw new Error("gone"); }, waitMs: 30 });
    assert.equal(await throwing.backend(), null);
});

test("worker link: auto may use the big sizes only when the GPU renderer says the decoder runs there", async () => {
    const { port1, port2 } = new MessageChannel();
    const server = createGpuServer(fakeGpuApi());
    const handle = server.handle;
    // the same server, but announcing a GPU decoder
    port2.on("message", async (msg) => {
        const out = await handle(msg);
        port2.postMessage({ id: msg.id, ...out, ...(out.capability ? { capability: { ...out.capability, decoder: "gpu" } } : {}) });
    });
    const link = createGpuWorkerLink({ post: () => {}, waitMs: 1000 });
    link.accept({ kind: "gpu-port" }, [port1]);
    await link.client.ready(1000);
    assert.equal(link.autoGpu(), true);
    port1.close();
    port2.close();
});

// ---- generatorJobs' hook ----
const onset = { envelopeFromTransfer: (e) => e };
const learned = { generateLearnedMap: async (_input, _analyze, model, opts) => ({ osuText: "osu", sawModel: model, sawOpts: opts }) };
const fakeLoad = (modules) => async (spec) => {
    if (!(spec in modules)) throw new Error(`Cannot find module '${spec}'`);
    return modules[spec];
};
const MODULES = { "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": learned, "../src/gen/generate.js": { generateMap: async () => ({ osuText: "rules" }) } };
const jobs = (files, nnBackend) => createGeneratorJobs({
    load: fakeLoad(MODULES), analyze: () => {}, devModels: null, nnBackend,
    readModel: async (name) => {
        if (!(name in files)) throw new Error("ENOENT");
        return files[name];
    },
});
const run = (j, request = {}) => j.run("generate", { envelope: { values: [1] }, request }, () => {});

test("generatorJobs: an nn-v2 model gets the GPU backend as opts.nnBackend and modelInfo.gpu; other models never ask", async () => {
    const backend = { encode: async () => ({}) };
    let asked = 0;
    const nnBackend = async () => {
        asked += 1;
        return backend;
    };
    const nn = { kind: "nn-v2", size: "S", grid: "snap-v2" };
    const out = await run(jobs({ "mapper-nn2-s.json": nn }, nnBackend), { modelSize: "s" });
    assert.equal(out.kind, "generated");
    assert.equal(out.sawOpts.nnBackend, backend);
    assert.equal(out.modelInfo.gpu, true);
    assert.equal(out.engine, "neural");
    assert.equal(asked, 1);
    const xgb = await run(jobs({ "mapper.json": { families: ["Stream"] } }, nnBackend));
    assert.equal(asked, 1, "an xgb model does not ask for the GPU");
    assert.equal("nnBackend" in xgb.sawOpts, false);
    assert.equal(xgb.modelInfo.gpu, undefined);
});

test("generatorJobs: no backend, a null one or a failing one → the generator's opts exactly as before", async () => {
    const nn = { kind: "nn-v2", size: "S", grid: "snap-v2" };
    for (const nnBackend of [null, async () => null, async () => { throw new Error("no gpu"); }]) {
        const out = await run(jobs({ "mapper-nn2-s.json": nn }, nnBackend), { modelSize: "s" });
        assert.equal(out.kind, "generated");
        assert.deepEqual(Object.keys(out.sawOpts).sort(), ["critic", "deadlineMs", "onProgress", "personal"]);
        assert.equal(out.modelInfo.gpu, undefined);
    }
});

// ---- generator-info ----
// the model styles are not this test's business: no catalog that would write userData\model-styles.json
const NO_STYLES = { bySize: async () => ({ auto: [], xgb3: [], s: [], m: [], l: [] }) };
test("generator-info: modelInfo.gpu carries the capability (outside Electron: unavailable, with the reason)", async () => {
    const handlers = {};
    registerCreateIpc({
        ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
        generatorClient: {}, generatedStore: {}, log: () => {}, paths: { userData: "x", docsDir: "y" }, styleCatalog: NO_STYLES,
    });
    const info = await handlers["generator-info"]({});
    assert.equal(info.ok, true);
    assert.deepEqual(info.modelInfo.gpu, { gpuAvailable: false, adapter: null, reason: "no Electron", decoder: "cpu" });
    setGpuPortHook(null);
});

test("generator-info with { gpu: false } does not start the GPU renderer: gpu is null until someone asks", async () => {
    const handlers = {};
    registerCreateIpc({
        ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
        generatorClient: {}, generatedStore: {}, log: () => {}, paths: { userData: "x", docsDir: "y" }, styleCatalog: NO_STYLES,
    });
    const before = await handlers["generator-info"]({}, { gpu: false });
    assert.equal(before.ok, true);
    assert.equal(before.modelInfo.gpu, null);
    const asked = await handlers["generator-info"]({}, { gpu: true });
    assert.equal(asked.modelInfo.gpu.reason, "no Electron");
    const after = await handlers["generator-info"]({}, { gpu: false });
    assert.deepEqual(after.modelInfo.gpu, asked.modelInfo.gpu, "once known, it is reported");
    setGpuPortHook(null);
});

// ---- the hidden page's files ----
test("the GPU page: a strict CSP, one module script, no Node; its preload only passes ports on", () => {
    const html = readFileSync(new URL("../app/gpuWorker.html", import.meta.url), "utf8");
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'"/);
    assert.match(html, /<script type="module" src="gpuWorker.js"><\/script>/);
    const preload = stripComments(readFileSync(new URL("../app/gpuWorkerPreload.cjs", import.meta.url), "utf8"));
    assert.doesNotMatch(preload, /contextBridge|exposeInMainWorld|invoke|send\(/);
    assert.match(preload, /ipcRenderer\.on\("lunacy-gpu-port"/);
    const page = stripComments(readFileSync(new URL("../app/gpuWorker.js", import.meta.url), "utf8"));
    assert.match(page, /event\.source === window && event\.data === "lunacy-gpu-port"/);
    const worker = readFileSync(new URL("../app/analysisWorker.js", import.meta.url), "utf8");
    const block = worker.slice(worker.indexOf("// >>> create (stream W)"), worker.indexOf("// <<< create", worker.indexOf("// >>> create (stream W)")));
    assert.match(block, /gpuLink\.accept\(data, ports\)/);
    assert.match(worker, /createGeneratorJobs\(\{ readModel, analyze: analyzeChart, gpu: gpuLink\.autoGpu, nnBackend: gpuLink\.backend \}\)/);
});
