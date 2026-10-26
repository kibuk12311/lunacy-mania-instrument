// Electron utility process: chart analysis and map generation off the main thread.
// Messages: {id, kind: "analyze", osuText, rate} → {id, result}. The create tab's kinds (generate, timing, remap)
// carry {payload} and may post {id, progress} before their {id, result} (app/generatorJobs.js).
import { analyzeChart } from "../src/core/analyze.js";
import { readFile } from "node:fs/promises";
import { setLang } from "../src/i18n/i18n.js";
// >>> create (mapgen v3)
import { createGeneratorJobs } from "./generatorJobs.js";
import { createGpuWorkerLink } from "./gpuWorkerLink.js";

const readModel = (name) => readFile(new URL(`../models/${name}`, import.meta.url), "utf8").then(JSON.parse);
// stream W: the GPU renderer's nn-v2 encoder, asked for on the first nn-v2 job (app/gpuWorkerLink.js)
const gpuLink = createGpuWorkerLink({ post: (message) => process.parentPort.postMessage(message) });
const createJobs = createGeneratorJobs({ readModel, analyze: analyzeChart, gpu: gpuLink.autoGpu, nnBackend: gpuLink.backend });
// <<< create
// >>> analysis v2: details — {kind: "details", osuText, rate} → {kind: "details", details} | {kind: "error", message}
import { detailsJob } from "../src/analysis/timeline.js";
// <<< analysis v2
// >>> dan by part — {kind: "sections", osuText, rate} → {kind: "sections", sections} | {kind: "error", message}
import { sectionsJob } from "../src/analysis/sections.js";
// <<< dan by part

async function handle(data, post) {
    setLang(data.lang); // messages come back in the language main is in
    // >>> create (mapgen v3)
    if (createJobs.has(data.kind)) return createJobs.run(data.kind, data.payload, (progress) => post({ id: data.id, progress }));
    // <<< create
    // >>> analysis v2: details
    if (data.kind === "details") return detailsJob(data.osuText, data.rate);
    // <<< analysis v2
    if (data.kind === "sections") return sectionsJob(data.osuText, data.rate);
    return analyzeChart(data.osuText, data.rate);
}

process.parentPort.on("message", async ({ data, ports }) => {
    // >>> create (stream W): main's answer to { gpuPort: true }
    if (gpuLink.accept(data, ports)) return;
    // <<< create
    const post = (message) => process.parentPort.postMessage(message);
    post({ id: data.id, result: await handle(data, post) });
});
