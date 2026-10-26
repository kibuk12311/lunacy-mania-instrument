// Electron utility process: chart analysis and map generation off the main thread.
// Messages: {id, kind: "analyze", osuText, rate} → {id, result}. The create tab's kinds (generate, timing, remap)
// carry {payload} and may post {id, progress} before their {id, result} (app/generatorJobs.js).
import { analyzeChart } from "../src/core/analyze.js";
import { readFile } from "node:fs/promises";
import { setLang } from "../src/i18n/i18n.js";
// >>> create (mapgen v3)
import { createGeneratorJobs } from "./generatorJobs.js";

const readModel = (name) => readFile(new URL(`../models/${name}`, import.meta.url), "utf8").then(JSON.parse);
const createJobs = createGeneratorJobs({ readModel, analyze: analyzeChart });
// <<< create
// >>> analysis v2: details — {kind: "details", osuText, rate} → {kind: "details", details} | {kind: "error", message}
import { detailsJob } from "../src/analysis/timeline.js";
// <<< analysis v2

async function handle(data, post) {
    setLang(data.lang); // messages come back in the language main is in
    // >>> create (mapgen v3)
    if (createJobs.has(data.kind)) return createJobs.run(data.kind, data.payload, (progress) => post({ id: data.id, progress }));
    // <<< create
    // >>> analysis v2: details
    if (data.kind === "details") return detailsJob(data.osuText, data.rate);
    // <<< analysis v2
    return analyzeChart(data.osuText, data.rate);
}

process.parentPort.on("message", async ({ data }) => {
    const post = (message) => process.parentPort.postMessage(message);
    post({ id: data.id, result: await handle(data, post) });
});
