// The create tab's worker jobs (mapgen v3): model load order, engines, progress, and kinds that fail on their own.
import test from "node:test";
import assert from "node:assert/strict";
import { createGeneratorJobs, modelInfoOf, MODEL_FILES } from "../app/generatorJobs.js";
import { onsetEnvelope, envelopeToTransfer } from "../src/audio/onset.js";
import { detectTiming } from "../src/audio/tempo.js";
import { clickTrack } from "./fixtures/clickTrack.js";

const xgb = { families: ["Stream"], metrics: { maps: 6326 } };
const nn = { kind: "nn-v1", grid: "snap-v2", families: ["Stream"], metrics: { maps: 9000 } };

// Fake modules by specifier; a specifier that is not listed fails to load like a missing file.
function fakeLoad(modules, seen = []) {
    return async (spec) => {
        seen.push(spec);
        if (!(spec in modules)) throw new Error(`Cannot find module '${spec}'`);
        return modules[spec];
    };
}

const onset = { envelopeFromTransfer: (e) => ({ ...e, rebuilt: true }) };
const learned = {
    generateLearnedMap: async (input, analyze, model, opts) => {
        opts.onProgress?.({ phase: "search", i: 1, n: 2 });
        return { osuText: "osu", version: "v", engine: "learned", sawModel: model, sawEnvelope: input.envelope, analyze };
    },
};
const rules = { generateMap: async (input, _analyze, opts) => { opts.onProgress?.({ phase: "search", i: 1, n: 1 }); return { osuText: "rules", rebuilt: input.envelope.rebuilt }; } };
const models = (files) => async (name) => {
    if (!(name in files)) throw new Error("ENOENT");
    return files[name];
};

test("the neural model is tried first, then the tree model", () => {
    assert.deepEqual(MODEL_FILES, ["mapper-nn.json", "mapper.json"]);
});

test("generate uses the tree model when it is the one that loads", async () => {
    const analyze = () => {};
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": learned }),
        readModel: models({ "mapper.json": xgb }),
        analyze,
    });
    const progress = [];
    const r = await jobs.run("generate", { envelope: { values: [1] }, request: {} }, (p) => progress.push(p));
    assert.equal(r.kind, "generated");
    assert.equal(r.engine, "learned");
    assert.equal(r.sawModel, xgb);
    assert.equal(r.analyze, analyze);
    assert.deepEqual(r.sawEnvelope, { values: [1], rebuilt: true });
    assert.deepEqual(r.modelInfo, { kind: "xgb-v1", grid: "q4", maps: 6326 });
    assert.deepEqual(progress, [{ phase: "search", i: 1, n: 2 }]);
});

test("generate prefers the neural model when it loads", async () => {
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": { generateLearnedMap: async (_i, _a, model) => ({ sawModel: model }) } }),
        readModel: models({ "mapper-nn.json": nn, "mapper.json": xgb }),
        analyze: () => {},
    });
    const r = await jobs.run("generate", { envelope: {}, request: {} }, () => {});
    assert.equal(r.sawModel, nn);
    assert.equal(r.engine, "neural");
    assert.deepEqual(r.modelInfo, { kind: "nn-v1", grid: "snap-v2", maps: 9000 });
});

test("without a model the rule-based generator runs", async () => {
    const seen = [];
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/gen/generate.js": rules }, seen),
        readModel: models({}),
        analyze: () => {},
    });
    const progress = [];
    const r = await jobs.run("generate", { envelope: {}, request: {} }, (p) => progress.push(p.phase));
    assert.equal(r.kind, "generated");
    assert.equal(r.engine, "rules");
    assert.equal(r.rebuilt, true);
    assert.deepEqual(r.modelInfo, { kind: "rules", grid: "q4", maps: 0 });
    assert.deepEqual(progress, ["search"]);
    assert.ok(!seen.includes("../src/gen/generateLearned.js"));
});

test("the model is read once per worker", async () => {
    let reads = 0;
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": learned, "../src/audio/timingJob.js": { detectTimingFull: () => ({ bpm: 1 }) } }),
        readModel: async (name) => { reads += 1; if (name === "mapper.json") return xgb; throw new Error("ENOENT"); },
        analyze: () => {},
    });
    await jobs.run("generate", { envelope: {} }, () => {});
    await jobs.run("timing", { envelope: {} }, () => {});
    await jobs.run("generate", { envelope: {} }, () => {});
    assert.equal(reads, 2); // mapper-nn.json (missing) and mapper.json, once
});

test("a missing module breaks only its own kind", async () => {
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": learned }),
        readModel: models({ "mapper.json": xgb }),
        analyze: () => {},
    });
    const timing = await jobs.run("timing", { envelope: {} }, () => {});
    assert.equal(timing.kind, "error");
    assert.match(timing.message, /timingJob/);
    const remap = await jobs.run("remap", { osuText: "x" }, () => {});
    assert.equal(remap.kind, "error");
    assert.equal((await jobs.run("generate", { envelope: {} }, () => {})).kind, "generated");
});

test("a generator that throws comes back as an error result", async () => {
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": { generateLearnedMap: async () => { throw new Error("boom"); } } }),
        readModel: models({ "mapper.json": xgb }),
        analyze: () => {},
    });
    assert.deepEqual(await jobs.run("generate", { envelope: {} }, () => {}), { kind: "error", message: "boom" });
});

test("timing answers a Timing and the model info", async () => {
    let got = null;
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/audio/onset.js": onset, "../src/audio/timingJob.js": { detectTimingFull: (args) => { got = args; return { sections: [{ timeMs: 5, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 5 }; } } }),
        readModel: models({ "mapper.json": xgb }),
        analyze: () => {},
    });
    const fine = { values: new Float32Array(4), hopSec: 0.001 };
    const hint = { bpm: 120, offsetMs: 0 };
    const r = await jobs.run("timing", { envelope: { values: [] }, fine, hint }, () => {});
    assert.deepEqual(r, { kind: "timing", timing: { sections: [{ timeMs: 5, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 5 }, modelInfo: modelInfoOf(xgb) });
    assert.equal(got.envelope.rebuilt, true);
    assert.equal(got.fine, fine);
    assert.equal(got.hint, hint);
});

test("remap passes the chart, the analyser, the model and progress", async () => {
    const analyze = () => {};
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/gen/remap.js": { remapChart: async (req, a, model, opts) => { opts.onProgress({ phase: "search", i: 1, n: 1 }); return { osuText: req.osuText, same: a === analyze, model }; } } }),
        readModel: models({ "mapper.json": xgb }),
        analyze,
    });
    const progress = [];
    const r = await jobs.run("remap", { osuText: "chart", range: { lo: 1, hi: 2 }, seed: 3 }, (p) => progress.push(p));
    assert.deepEqual(r, { kind: "remapped", osuText: "chart", same: true, model: xgb });
    assert.equal(progress.length, 1);
});

test("only the create kinds are jobs", () => {
    const jobs = createGeneratorJobs({ readModel: models({}), analyze: () => {} });
    assert.deepEqual(["generate", "timing", "remap", "analyze", undefined, "details"].map((k) => jobs.has(k)), [true, true, true, false, false, false]);
});

test("the real timing module finds the click track's tempo, as one section", async () => {
    const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312, seconds: 30 });
    const envelope = onsetEnvelope(samples, sampleRate);
    const jobs = createGeneratorJobs({ readModel: models({}), analyze: () => {} });
    const r = await jobs.run("timing", { envelope: envelopeToTransfer(envelope) }, () => {});
    assert.equal(r.kind, "timing");
    const old = detectTiming(envelope);
    assert.equal(r.timing.bpm, old.bpm);
    assert.equal(r.timing.offsetMs, old.offsetMs);
    assert.deepEqual(r.timing.sections, [{ timeMs: old.offsetMs, bpm: old.bpm, meter: 4 }]);
    assert.deepEqual(r.modelInfo, { kind: "rules", grid: "q4", maps: 0 });
});
