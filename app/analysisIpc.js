// Main-process side of the "Анализ" tab beyond the card itself (the card comes from selectionController):
// details of the selected map (app/analysisDetails.js) on "analysis-details", the ladder's dans on "analysis-rate".
// Registering only hangs the channel and the hooks; work starts with the first result.
import { createDetailsService } from "./analysisDetails.js";

const DETAILS_CHANNEL = "analysis-details";

export function registerAnalysisIpc(deps) {
    const { ipcMain, hooks, send, log } = deps;
    const service = createDetailsService({
        analysis: deps.analysis,
        worker: deps.worker,
        cache: deps.resultCache,
        send: (payload) => send(DETAILS_CHANNEL, payload),
        log,
    });
    hooks.on("result", (r) => service.onResult(r));
    // the page reloaded (a language switch): the view comes again from main.js, its details from here
    hooks.on("window-load", () => {
        const payload = service.last();
        if (payload) send(DETAILS_CHANNEL, payload);
    });
    ipcMain.handle("analysis-rate", (_e, request) => service.rate(request));
    return service;
}
