// The analyzer the build copies into lib/ answers exactly as the app's own src/core/analyze.js: the built copy (with
// the model.js shim reading file: URLs) and the original each run in a process of their own on the same charts at
// 1.0× and 1.2×, plus a 7K, an LN-heavy and a too-short chart, and the results must be deep-equal.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { makeChart } from "../../fixtures/makeChart.js";
import { randomChart } from "../../fixtures/randomChart.js";
import { ROOT, buildForTest } from "./buildHelper.js";

const run = promisify(execFile);
const CHILD = fileURLToPath(new URL("./analyzeAll.mjs", import.meta.url));
// Under Node the copied Companella loads ONNX Runtime's Node entry, which the extension does not ship.
const ORT_NODE = "vendor/leoblack/js/estimator/companella/ort/ort.node.min.mjs";

const CHARTS = [
    makeChart({ kind: "stream", bpm: 190, seconds: 50 }),
    makeChart({ kind: "jumpstream", bpm: 170, seconds: 60 }),
    makeChart({ kind: "jack", bpm: 150, seconds: 45 }),
    randomChart(11, { seconds: 70 }),
    randomChart(23, { seconds: 70 }),
    randomChart(37, { seconds: 60, lnShare: 0.08 }),
];
const JOBS = [
    ...CHARTS.flatMap((text) => [{ text, rate: 1 }, { text, rate: 1.2 }]),
    { text: makeChart({ kind: "stream", keys: 7, seconds: 40 }), rate: 1 },
    { text: makeChart({ kind: "ln", seconds: 40 }), rate: 1 },
    { text: makeChart({ kind: "stream", seconds: 3 }), rate: 1 },
];

async function analyzeIn(moduleFile, jobsFile) {
    const { stdout } = await run(process.execPath, [CHILD, pathToFileURL(moduleFile).href, jobsFile], { maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
    return JSON.parse(stdout);
}

test("the built copy of the analyzer equals the original analyzeChart", { timeout: 300_000 }, async (t) => {
    const built = await buildForTest(t, { targets: ["chrome"], inWorktree: true });
    const lib = path.join(built.targets.chrome, "lib");
    await copyFile(path.join(ROOT, ORT_NODE), path.join(lib, ORT_NODE));
    const jobsFile = path.join(built.out, "jobs.json");
    await writeFile(jobsFile, JSON.stringify(JOBS));

    const [copy, original] = await Promise.all([
        analyzeIn(path.join(lib, "src", "core", "analyze.js"), jobsFile),
        analyzeIn(path.join(ROOT, "src", "core", "analyze.js"), jobsFile),
    ]);
    assert.equal(copy.length, JOBS.length);
    assert.deepEqual(copy, original);

    const kinds = copy.map((r) => r.kind);
    assert.equal(kinds.filter((k) => k === "ok").length, CHARTS.length * 2, kinds.join(","));
    assert.deepEqual(kinds.slice(-3), ["not-rice", "not-rice", "too-short"]);
    assert.equal(copy.at(-3).reason, "keys");
    assert.equal(copy.at(-2).reason, "ln");
    // a rate moves the dan (the 1.2× answer is a different, higher one)
    assert.ok(copy[2].numeric > copy[0].numeric, `${copy[0].numeric} → ${copy[2].numeric}`);
    assert.ok(copy.every((r) => r.kind !== "ok" || Number.isFinite(r.calcs.companella)), "Companella answered in the copy");
});
