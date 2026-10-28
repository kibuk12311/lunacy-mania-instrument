// Chrome/Edge offscreen document (reason WORKERS): owns the analysis Worker for the service worker, which cannot start
// one. Answers only messages with target OFFSCREEN_TARGET and a type it owns (rule R1, extension/DESIGN.md §5.3):
//   { target, type: "lm:job", jobId, text, rate } → { ok: true, result } | { ok: false, code, message }
//   { target, type: "lm:reset" }                  → throws the Worker away (after a timeout); the next job makes a new one
import { OFFSCREEN_TARGET } from "../shared/protocol.js";
import { OFFSCREEN_JOB, OFFSCREEN_RESET, createWorkerRunner } from "../background/analysisHost.js";

const runner = createWorkerRunner(() => new Worker(new URL("../analysis/worker.js", import.meta.url), { type: "module" }));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || message.target !== OFFSCREEN_TARGET) return undefined;
    if (sender?.id && sender.id !== chrome.runtime.id) return undefined;
    if (message.type === OFFSCREEN_JOB) {
        runner.run({ text: message.text, rate: message.rate }).then(sendResponse);
        return true;
    }
    if (message.type === OFFSCREEN_RESET) {
        runner.reset();
        sendResponse({ ok: true });
    }
    return undefined;
});
