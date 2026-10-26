// Run with: npx electron tests/smoke/electron-gpu-link.mjs [outDir] [--model path/to/mapper-nn2-*.json] [--size S|M|L]
// Stream W end to end: main's GPU host (app/gpuWorkerHost.js) starts the hidden renderer and probes the GPU; a utility
// process asks for a port through app/workerClient.js's hook, then runs the nn-v2 encoder of a model (or of a random
// model in a tools/nn/sizes.json shape, default L) over that port for a 4-minute song and checks it against the CPU.
// Prints the capability and the timings; exits 0 when every check passes, 3 without a WebGPU adapter, 1 otherwise.
import { app, utilityProcess } from "electron";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerClient } from "../../app/workerClient.js";
import { registerGpuWorkerHost } from "../../app/gpuWorkerHost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const arg = (name) => {
    const k = process.argv.indexOf(`--${name}`);
    return k > 0 ? process.argv[k + 1] : null;
};
const outDir = process.argv.slice(2).find((a, k, all) => !a.startsWith("-") && !a.endsWith(".mjs") && !all[k - 1]?.startsWith("--")) ?? path.join(tmpdir(), "lunacy-gpu-link-smoke");
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
const size = arg("size") ?? "L";
const arch = JSON.parse(readFileSync(path.join(root, "tools", "nn", "sizes.json"), "utf8"))[size];

app.whenReady().then(async () => {
    const t0 = Date.now();
    const host = registerGpuWorkerHost({ log: (m) => console.log("host:", m) });
    const client = createWorkerClient({ spawn: () => utilityProcess.fork(path.join(here, "gpuLinkWorker.mjs")), generateTimeoutMs: 280_000 });
    const out = await client.generate({ modelPath: arg("model"), arch: { ...arch, size } }, () => {});
    const cap = await host.info();
    console.log("GPU capability:", JSON.stringify(cap));
    console.log("GPU link:", JSON.stringify(out));
    console.log(`total ${Date.now() - t0} ms`);
    client.dispose();
    host.dispose();
    app.exit(!cap?.gpuAvailable ? 3 : out.kind === "generated" && out.ok ? 0 : 1);
});
setTimeout(() => {
    console.log("GPU link timeout");
    app.exit(2);
}, 300_000);
