// Run with: npx electron tests/smoke/electron-worker.mjs — checks analyzeChart, the create tab's timing kind
// (mapgen v3) and the analysis tab's details kind inside an Electron utility process.
import { app, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChart } from "../fixtures/makeChart.js";
import { clickTrack } from "../fixtures/clickTrack.js";
import { onsetEnvelope, envelopeToTransfer } from "../../src/audio/onset.js";

const here = path.dirname(fileURLToPath(import.meta.url));
app.whenReady().then(() => {
    const worker = utilityProcess.fork(path.join(here, "..", "..", "app", "analysisWorker.js"));
    const t0 = Date.now();
    const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312, seconds: 30 });
    const results = {};
    worker.on("message", ({ id, result }) => {
        if (!result) return; // progress
        results[id] = result;
        console.log("SMOKE", ["", "analyze", "timing", "details"][id], Date.now() - t0, "ms", JSON.stringify(result));
        if (!results[1] || !results[2] || !results[3]) return;
        worker.kill();
        const details = results[3].details;
        app.exit(results[1].kind === "ok" && results[2].kind === "timing" && results[3].kind === "details" && details?.strain?.length === 120 ? 0 : 1);
    });
    worker.postMessage({ id: 1, osuText: makeChart({ kind: "jack", bpm: 170, seconds: 120 }), rate: 1 });
    worker.postMessage({ id: 2, kind: "timing", payload: { envelope: envelopeToTransfer(onsetEnvelope(samples, sampleRate)) } });
    worker.postMessage({ id: 3, kind: "details", osuText: makeChart({ kind: "jumpstream", bpm: 180, seconds: 90 }), rate: 1.2 });
    setTimeout(() => { console.log("SMOKE timeout"); app.exit(2); }, 30000);
});
