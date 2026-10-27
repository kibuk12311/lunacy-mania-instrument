// Electron utility process of the background pool (app/workerPool.js): the analysis kinds only, answered as
// app/analysisWorker.js answers them — {id, kind: "analyze" (or none), osuText, rate} → {id, result}, "details" and
// "sections" likewise — without the create tab's generator jobs, their models or the GPU link.
import { analyzeChart } from "../src/core/analyze.js";
import { setLang } from "../src/i18n/i18n.js";
import { detailsJob } from "../src/analysis/timeline.js";
import { sectionsJob } from "../src/analysis/sections.js";

const JOBS = {
    analyze: (data) => analyzeChart(data.osuText, data.rate),
    details: (data) => detailsJob(data.osuText, data.rate),
    sections: (data) => sectionsJob(data.osuText, data.rate),
};

async function handle(data) {
    setLang(data.lang); // messages come back in the language main is in
    const job = JOBS[data.kind ?? "analyze"];
    // main sends the pool nothing else; a kind it does not do is answered, never left to time out
    if (!job) return { kind: "error", message: `the pool's worker has no "${data.kind}" job`, transient: true };
    try {
        return await job(data);
    } catch (error) {
        return { kind: "error", message: String(error?.message ?? error), transient: true };
    }
}

process.parentPort.on("message", async ({ data }) => {
    process.parentPort.postMessage({ id: data.id, result: await handle(data) });
});
