// The hidden GPU renderer's page script (stream W, ML addendum §11): WebGPU lives in Electron's renderers, not in the
// utility worker that generates, so this page holds the GPUDevice and serves the nn-v2 encoder to whoever main gives
// a port (app/gpuWorkerHost.js; the generator worker through app/gpuWorkerLink.js). It loads no remote content and
// has no Node; the preload only hands MessagePorts over (app/gpuWorkerPreload.cjs).
import { createGpuServer } from "../src/gen/nn/webgpu/gpuServer.js";

const server = createGpuServer({ log: (message) => console.log(message) });
server.start();
window.addEventListener("message", (event) => {
    if (event.source === window && event.data === "lunacy-gpu-port" && event.ports?.[0]) server.serve(event.ports[0]);
});
