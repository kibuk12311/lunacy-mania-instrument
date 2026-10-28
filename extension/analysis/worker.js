// The analysis worker (module Worker): the app's analyzeChart on one .osu at one rate, worded in English (the
// background rewords a result for the page's language, background/relabel.js). Chrome/Edge start it from the
// offscreen document, Firefox from the background page. Message in: { id, text, rate }; out: { id, ok, result } or
// { id, ok: false, code: "analysis", message }.
import { analyzeChart } from "../lib/src/core/analyze.js";
import { setLang } from "../lib/src/i18n/i18n.js";

setLang("en");

self.addEventListener("message", async (event) => {
    const { id, text, rate } = event.data ?? {};
    try {
        if (typeof text !== "string" || !Number.isFinite(rate)) throw new Error("bad job");
        const result = await analyzeChart(text, rate);
        self.postMessage({ id, ok: true, result });
    } catch (error) {
        self.postMessage({ id, ok: false, code: "analysis", message: String(error?.message ?? error) });
    }
});
