// Main-process side of the GPU path (stream W, ML addendum §11): the hidden renderer that holds the WebGPU device
// (app/gpuWorker.html), started on first use, and the MessagePorts that link it to whoever asks:
//   - a generator worker that wants the GPU encoder posts { gpuPort: true }; app/workerClient.js hands that worker to
//     the hook registered here, and the worker gets { kind: "gpu-port" } with a port (or with none: no GPU here);
//   - main keeps one port of its own for the capability, which generator-info shows (createIpc.js):
//     { gpuAvailable, adapter, reason, probe: { worst, ms }, decoder }.
// Nothing happens at register time (tests/registerIpc.test.js): the window starts on the first ask or info().
// Outside Electron (node tests, CLI tools) the GPU is simply unavailable.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setGpuPortHook } from "./workerClient.js";
import { createGpuClient } from "../src/gen/nn/webgpu/gpuClient.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GPU_PAGE = path.join(here, "gpuWorker.html");
export const GPU_PRELOAD = path.join(here, "gpuWorkerPreload.cjs");
export const GPU_PORT_CHANNEL = "lunacy-gpu-port";
const none = (reason) => ({ gpuAvailable: false, adapter: null, reason, probe: null, decoder: "cpu" });

// electron: the electron module (tests pass a fake); by default it is imported only inside Electron.
export function createGpuWorkerHost({ electron = null, log = () => {}, helloMs = 15_000 } = {}) {
    let win = null;
    let starting = null;
    let capability = null;
    let link = null; // main's own client of the GPU page (the capability)

    const electronModule = async () => electron ?? (process.versions?.electron ? await import("electron") : null);

    async function start() {
        const e = await electronModule();
        if (!e?.BrowserWindow || !e.MessageChannelMain) {
            capability = none("no Electron");
            return null;
        }
        await e.app?.whenReady?.();
        win = new e.BrowserWindow({
            show: false, width: 64, height: 64, skipTaskbar: true,
            webPreferences: { preload: GPU_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
        });
        const wc = win.webContents;
        wc.on("will-navigate", (event) => event.preventDefault());
        wc.setWindowOpenHandler?.(() => ({ action: "deny" }));
        const lost = (reason) => {
            capability = none(reason);
            starting = null;
            win = null;
            link?.close();
            link = null;
        };
        wc.on("render-process-gone", (_e, details) => {
            log(`gpu renderer gone: ${details?.reason}`);
            const w = win;
            lost(`the GPU renderer stopped (${details?.reason})`);
            w?.destroy();
        });
        win.on("closed", () => lost("the GPU renderer closed"));
        await win.loadFile(GPU_PAGE);
        const { port1, port2 } = new e.MessageChannelMain();
        wc.postMessage(GPU_PORT_CHANNEL, null, [port2]);
        link = createGpuClient();
        link.attach(port1);
        capability = (await link.ready(helloMs)) ?? none("the GPU renderer did not answer");
        log(`gpu: ${capability.gpuAvailable ? `${capability.adapter}, probe ${capability.probe?.worst} in ${capability.probe?.ms} ms` : capability.reason}`);
        return e;
    }

    let underway = false;
    const ensure = () => {
        if (!starting) {
            underway = true;
            starting = start().catch((error) => {
                capability = none(String(error?.message ?? error));
                log(`gpu: ${capability.reason}`);
                starting = null;
                return null;
            }).finally(() => {
                underway = false;
            });
        }
        return starting;
    };

    // a utility process asked for a port (its { gpuPort: true }); it always gets an answer
    async function connect(worker) {
        const e = await ensure();
        if (!e || !win || !capability?.gpuAvailable) {
            worker.postMessage({ kind: "gpu-port", none: true, capability });
            return;
        }
        const { port1, port2 } = new e.MessageChannelMain();
        win.webContents.postMessage(GPU_PORT_CHANNEL, null, [port2]);
        worker.postMessage({ kind: "gpu-port" }, [port1]);
    }

    // the capability, starting the GPU renderer if needed; after ms without an answer, what is known so far
    async function info(ms = 3000) {
        const done = ensure();
        if (capability && !underway) return capability;
        await Promise.race([done, new Promise((r) => setTimeout(r, ms))]);
        return capability ?? none("still starting");
    }

    return {
        ensure, connect, info,
        capability: () => capability,
        dispose() {
            link?.close();
            link = null;
            win?.destroy();
            win = null;
        },
    };
}

// From registerCreateIpc (main.js stays frozen): the host, and the worker client's hook for { gpuPort: true }.
export function registerGpuWorkerHost(deps = {}) {
    const host = createGpuWorkerHost({ log: (message) => deps.log?.(message) });
    setGpuPortHook((worker) => void host.connect(worker));
    return host;
}
