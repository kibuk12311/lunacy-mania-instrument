// The background pool's worker (app/analysisPoolWorker.js) in this process, over a fake parentPort: the analysis kinds
// (analyze, details, sections) answered like app/analysisWorker.js answers them, in the language asked, and nothing of
// the create tab's generator.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { makeChart } from "./fixtures/makeChart.js";
import { stripComments } from "./helpers/source.js";

const port = Object.assign(new EventEmitter(), { sent: [] });
port.postMessage = (message) => port.emit("sent", message);
process.parentPort = port;
await import("../app/analysisPoolWorker.js");

const ask = (data) => new Promise((resolve) => {
    const on = (message) => {
        if (message.id !== data.id) return;
        port.off("sent", on);
        resolve(message);
    };
    port.on("sent", on);
    port.emit("message", { data, ports: [] });
});

test("the analysis kinds are answered by id, like the full worker", async () => {
    const chart = makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 });
    const [a, d, s] = await Promise.all([
        ask({ id: 1, kind: "analyze", osuText: chart, rate: 1, lang: "en" }),
        ask({ id: 2, kind: "details", osuText: chart, rate: 1.1, lang: "en" }),
        ask({ id: 3, kind: "sections", osuText: chart, rate: 1, lang: "en" }),
    ]);
    assert.equal(a.result.kind, "ok");
    assert.ok(Number.isFinite(a.result.numeric));
    assert.equal(d.result.kind, "details");
    assert.equal(s.result.kind, "sections");
    // no kind: an analysis, as the full worker takes it
    assert.equal((await ask({ id: 4, osuText: chart, rate: 1, lang: "en" })).result.kind, "ok");
});

test("a kind it does not do is answered as an error, not left to time out", async () => {
    const r = await ask({ id: 5, kind: "generate", payload: {}, lang: "en" });
    assert.equal(r.result.kind, "error");
    assert.equal(r.result.transient, true);
});

test("it loads none of the generator's jobs or the GPU link", () => {
    const source = stripComments(readFileSync(new URL("../app/analysisPoolWorker.js", import.meta.url), "utf8"));
    assert.doesNotMatch(source, /generatorJobs|gpuWorkerLink|src\/gen\//);
});
