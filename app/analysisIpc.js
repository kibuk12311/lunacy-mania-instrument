// Main-process side of the "Анализ" tab beyond the card itself (the card comes from selectionController):
// details of the selected map (app/analysisDetails.js) on "analysis-details", its dan by part (app/analysisSections.js)
// on "analysis-sections", the ladder's dans on "analysis-rate".
// Registering only hangs the channel and the hooks; work starts with the first result.
import { createDetailsService } from "./analysisDetails.js";
import { createSectionsService } from "./analysisSections.js";

const DETAILS_CHANNEL = "analysis-details";
const SECTIONS_CHANNEL = "analysis-sections";

export function registerAnalysisIpc(deps) {
    const { ipcMain, hooks, send, log } = deps;
    const service = createDetailsService({
        analysis: deps.analysis,
        worker: deps.worker,
        cache: deps.resultCache,
        send: (payload) => send(DETAILS_CHANNEL, payload),
        log,
    });
    const sections = createSectionsService({
        analysis: deps.analysis,
        worker: deps.worker,
        cache: deps.resultCache,
        send: (payload) => send(SECTIONS_CHANNEL, payload),
        log,
    });
    hooks.on("result", (r) => {
        service.onResult(r);
        sections.onResult(r);
    });
    // the page reloaded (a language switch): the view comes again from main.js, its details and parts from here
    hooks.on("window-load", () => {
        const payload = service.last();
        if (payload) send(DETAILS_CHANNEL, payload);
        const parts = sections.last();
        if (parts) send(SECTIONS_CHANNEL, parts);
    });
    ipcMain.handle("analysis-rate", (_e, request) => service.rate(request));
    return service;
}
