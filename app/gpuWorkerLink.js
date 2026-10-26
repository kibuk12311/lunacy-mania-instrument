// The generator worker's link to the GPU renderer (stream W, ML addendum §11). Used from app/analysisWorker.js's
// create block: on the first nn-v2 job it asks main for a port ({ gpuPort: true }, answered by app/gpuWorkerHost.js
// through app/workerClient.js), then hands generatorJobs a backend for the GPU encoder, or null (no GPU, no answer,
// the probe failed). Every wait is bounded, so a missing GPU only costs the first job up to waitMs once.
import { createGpuClient } from "../src/gen/nn/webgpu/gpuClient.js";

export function createGpuWorkerLink({ post, waitMs = 8000 } = {}) {
    const client = createGpuClient();
    let asked = null;
    let arrived = null;
    const ask = () => (asked ??= new Promise((resolve) => {
        arrived = resolve;
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
        try {
            post({ gpuPort: true });
        } catch {
            resolve();
        }
    }));
    return {
        client,
        // a message from main; true when it was the GPU port (or main's "no GPU here")
        accept(data, ports) {
            if (data?.kind !== "gpu-port") return false;
            if (ports?.[0]) client.attach(ports[0]);
            arrived?.();
            return true;
        },
        // the GPU encoder backend for createGpuInfillSource, or null
        async backend() {
            await ask();
            const cap = await client.ready(waitMs);
            return cap?.gpuAvailable ? client.backend : null;
        },
        // for modelOrder("auto"): true only when the GPU path runs the big sizes within the §11 budget, i.e. when
        // the decoder runs on the GPU too; with the encoder on the GPU and the decoder on the CPU (decoder: "cpu"),
        // L costs ≈ 38 s a variant here (docs/2026-10-26-webgpu-stream-w.md), so auto stays on the CPU sizes
        autoGpu: () => client.available() && client.capability()?.decoder === "gpu",
    };
}
