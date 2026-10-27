// The worker's model choice for wave 3 (P-ml1): nn-v2 sizes, xgb and v1 files, the model-strength choice, models
// whose needs are not met, the optional critic, stems beside the envelope, the "neural" label and fit-personal.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createGeneratorJobs, modelInfoOf, modelOrder, needsMet, devModelReader, modelDirs, listModelFiles, generatorInfoOf,
    MODEL_FILES, NN2_FILES, CRITIC_FILE, MODEL_SIZES,
} from "../app/generatorJobs.js";
import { stemsToTransfer } from "../src/audio/stems.js";
import * as slotFeaturesModule from "../src/gen/slotFeatures.js";
import { AUDIO_FEATURES_V2, AUDIO_FEATURES_V3 } from "../src/gen/slotFeatures.js";

const xgb = { families: ["Stream"], metrics: { maps: 6326 } };
const xgb3 = { kind: "xgb-v3", grid: "snap-v2", families: ["Stream"], metrics: { maps: 12000 }, needs: ["stems"] };
const nn2 = (size, extra = {}) => ({ kind: "nn-v2", size: size.toUpperCase(), grid: "snap-v2", metrics: { maps: 30000 }, needs: ["stems", "structure"], ...extra });
const critic = { kind: "critic-v1", features: ["a"], human: { trees: [] }, norm: { mean: [0], std: [1] } };

function fakeLoad(modules, seen = []) {
    return async (spec) => {
        seen.push(spec);
        if (!(spec in modules)) throw new Error(`Cannot find module '${spec}'`);
        return modules[spec];
    };
}
const onset = { envelopeFromTransfer: (e) => ({ ...e, rebuilt: true }) };
const stemsModule = { stemsFromTransfer: (s) => ({ ...s, rebuiltStems: true }) };
const criticModule = { loadCritic: (json) => ({ kind: json.kind, loaded: true }) };
// generateLearnedMap that reports what it was handed
const learned = { generateLearnedMap: async (input, _analyze, model, opts) => ({ osuText: "osu", sawModel: model, sawInput: input, sawOpts: opts }) };
const rules = { generateMap: async (input) => ({ osuText: "rules", sawInput: input }) };
const MODULES = {
    "../src/audio/onset.js": onset, "../src/audio/stems.js": stemsModule, "../src/gen/critic.js": criticModule,
    "../src/gen/generateLearned.js": learned, "../src/gen/generate.js": rules,
};
const models = (files, reads = []) => async (name) => {
    reads.push(name);
    if (!(name in files)) throw new Error("ENOENT");
    return files[name];
};
const STEMS = { v: 1, frames: 4 }; // the fake stems module takes anything
const jobsWith = (files, opts = {}) => createGeneratorJobs({ load: fakeLoad(MODULES), readModel: models(files, opts.reads), analyze: () => {}, ...opts });
const gen = (jobs, payload = {}) => jobs.run("generate", { envelope: { values: [1] }, request: {}, ...payload }, () => {});

test("MODEL_FILES: the nn-v2 sizes (largest first, the distilled S before the plain S), then xgb-v3 and mapper.json", () => {
    assert.deepEqual(NN2_FILES, { l: "mapper-nn2-l.json", m: "mapper-nn2-m.json", sd: "mapper-nn2-s-distilled.json", s: "mapper-nn2-s.json" });
    assert.deepEqual(MODEL_FILES, ["mapper-nn2-l.json", "mapper-nn2-m.json", "mapper-nn2-s-distilled.json", "mapper-nn2-s.json", "mapper-xgb3.json", "mapper.json"]);
    assert.equal(CRITIC_FILE, "critic.json");
    assert.deepEqual(MODEL_SIZES, ["auto", "xgb3", "s", "m", "l"]);
});

// 0.9.0: the held-out evaluation said no-ship for every new model, so "auto" is the proven v1 (mapper.json)
test("modelOrder: auto is the classic mapper.json only; each experimental choice falls back to it", () => {
    const { l, m, sd, s } = NN2_FILES;
    assert.deepEqual(modelOrder("auto"), ["mapper.json"]);
    assert.deepEqual(modelOrder(undefined), ["mapper.json"]);
    assert.deepEqual(modelOrder("xgb3"), ["mapper-xgb3.json", "mapper.json"]);
    assert.deepEqual(modelOrder("s"), [sd, s, "mapper.json"]);
    assert.deepEqual(modelOrder("m"), [m, sd, s, "mapper.json"]);
    assert.deepEqual(modelOrder("l"), [l, m, sd, s, "mapper.json"]); // L without a GPU is allowed (marked in the UI)
    assert.deepEqual(modelOrder("xl"), modelOrder("auto"));
    assert.deepEqual(modelOrder("toString"), modelOrder("auto"));
});

test("needsMet: stems and structure need the stems; an unknown need or a bad list is never met", () => {
    assert.equal(needsMet(xgb, { stems: false }), true);
    assert.equal(needsMet(nn2("s"), { stems: false }), false);
    assert.equal(needsMet(nn2("s"), { stems: true }), true);
    assert.equal(needsMet({ needs: ["gpu"] }, { stems: true }), false);
    assert.equal(needsMet({ needs: "stems" }, { stems: true }), false);
    assert.equal(needsMet({ needs: [] }, { stems: false }), true);
});

test("a needs:[\"stems\"] model without stems falls back to mapper.json", async () => {
    const jobs = jobsWith({ "mapper-nn2-s.json": nn2("s"), "mapper-xgb3.json": xgb3, "mapper.json": xgb });
    const r = await gen(jobs, { request: { modelSize: "s" } });
    assert.equal(r.kind, "generated");
    assert.equal(r.sawModel, xgb);
    assert.equal(r.engine, "learned");
    assert.equal(r.modelInfo.stems, false);
    assert.equal("stems" in r.sawInput, false);
});

// mapper-xgb3.json as shipped has stem columns in `features` but no `needs`: without the stems it used to be picked
// and stop on "missing stems"
test("a model file without needs whose features read the stems or structure is not picked without the stems", async () => {
    const stemName = AUDIO_FEATURES_V3[AUDIO_FEATURES_V2.length];
    const shipped = { kind: "xgb-v3", grid: "snap-v2", metrics: { maps: 12000 }, features: ["onset", stemName] };
    const structural = { ...shipped, features: ["onset", AUDIO_FEATURES_V3.at(-1)] };
    const plain = { ...shipped, features: ["onset", "low"] };
    const withSlots = (files) => createGeneratorJobs({
        load: fakeLoad({ ...MODULES, "../src/gen/slotFeatures.js": slotFeaturesModule }), readModel: models(files), analyze: () => {},
    });
    for (const m of [shipped, structural]) {
        const without = await gen(withSlots({ "mapper-xgb3.json": m, "mapper.json": xgb }), { request: { modelSize: "xgb3" } });
        assert.equal(without.sawModel, xgb, "falls back to the classic model");
        assert.deepEqual(without.modelInfo.sizeNote, { want: "xgb3", got: "auto" });
        const withStems = await gen(withSlots({ "mapper-xgb3.json": m, "mapper.json": xgb }), { stems: STEMS, request: { modelSize: "xgb3" } });
        assert.equal(withStems.sawModel, m, "with the stems it runs");
    }
    const r = await gen(withSlots({ "mapper-xgb3.json": plain, "mapper.json": xgb }), { request: { modelSize: "xgb3" } });
    assert.equal(r.sawModel, plain, "features without stem columns need nothing");
    assert.deepEqual(slotFeaturesModule.featureNeeds(["onset", "nope", stemName]), ["stems"]);
    assert.deepEqual(slotFeaturesModule.featureNeeds(null), []);
});

test("with stems the nn-v2 model is used, labelled neural, and the stems go beside the envelope", async () => {
    const s = nn2("s", { styles: [{ key: "mapperA", name: "Mapper A", maps: 40 }, { key: 7 }] });
    const jobs = jobsWith({ "mapper-nn2-s.json": s, "mapper.json": xgb });
    const r = await gen(jobs, { stems: STEMS, request: { modelSize: "s" } });
    assert.equal(r.sawModel, s);
    assert.equal(r.engine, "neural");
    assert.deepEqual(r.sawInput.stems, { v: 1, frames: 4, rebuiltStems: true });
    assert.deepEqual(r.sawInput.envelope, { values: [1], rebuilt: true });
    assert.equal(r.modelInfo.kind, "nn-v2");
    assert.equal(r.modelInfo.size, "s");
    assert.equal(r.modelInfo.stems, true);
    assert.deepEqual(r.modelInfo.styles, [{ key: "mapperA", name: "Mapper A", maps: 40 }]);
});

test("every nn- kind is neural; xgb kinds are learned", async () => {
    for (const [kind, engine] of [["nn-v1", "neural"], ["nn-v2", "neural"], ["nn-v9", "neural"], ["xgb-v3", "learned"], [undefined, "learned"]]) {
        const r = await gen(jobsWith({ "mapper.json": { kind, metrics: { maps: 1 } } }));
        assert.equal(r.engine, engine, String(kind));
    }
});

test("auto takes the classic mapper.json even with every nn-v2 size, the stems and a GPU path there", async () => {
    const files = { "mapper-nn2-l.json": nn2("l"), "mapper-nn2-m.json": nn2("m"), "mapper-nn2-s-distilled.json": nn2("s", { distilled: true }), "mapper-nn2-s.json": nn2("s"), "mapper-xgb3.json": xgb3, "mapper.json": xgb };
    for (const gpu of [false, true]) {
        const r = await gen(jobsWith(files, { gpu: () => gpu }), { stems: STEMS, request: { modelSize: "auto" } });
        assert.equal(r.sawModel, xgb, `gpu ${gpu}`);
        assert.equal(r.engine, "learned");
        assert.equal("sizeNote" in r.modelInfo, false);
    }
    const plain = await gen(jobsWith(files), { stems: STEMS });
    assert.equal(plain.sawModel, xgb, "no modelSize is auto");
    const l = await gen(jobsWith(files), { stems: STEMS, request: { modelSize: "l" } });
    assert.equal(l.sawModel, files["mapper-nn2-l.json"]);
    assert.equal(l.modelInfo.size, "l");
    const x = await gen(jobsWith(files), { stems: STEMS, request: { modelSize: "xgb3" } });
    assert.equal(x.sawModel, xgb3);
    assert.equal("sizeNote" in x.modelInfo, false);
});

test("a missing choice falls back to the next smaller size, then the classic model, with a note", async () => {
    const files = { "mapper-nn2-m.json": nn2("m"), "mapper-nn2-s.json": nn2("s"), "mapper.json": xgb };
    const r = await gen(jobsWith(files), { stems: STEMS, request: { modelSize: "l" } });
    assert.equal(r.sawModel, files["mapper-nn2-m.json"]);
    assert.deepEqual(r.modelInfo.sizeNote, { want: "l", got: "m" });
    const m = await gen(jobsWith(files), { stems: STEMS, request: { modelSize: "m" } });
    assert.equal("sizeNote" in m.modelInfo, false);
    const classic = await gen(jobsWith({ "mapper.json": xgb }), { stems: STEMS, request: { modelSize: "s" } });
    assert.equal(classic.sawModel, xgb);
    assert.deepEqual(classic.modelInfo.sizeNote, { want: "s", got: "auto" });
    const noXgb3 = await gen(jobsWith({ "mapper.json": xgb }), { request: { modelSize: "xgb3" } });
    assert.deepEqual(noXgb3.modelInfo.sizeNote, { want: "xgb3", got: "auto" });
    const none = await gen(jobsWith({}), { request: { modelSize: "m" } });
    assert.equal(none.engine, "rules");
    assert.deepEqual(none.modelInfo.sizeNote, { want: "m", got: null });
    const noAuto = await gen(jobsWith({}), { request: { modelSize: "auto" } });
    assert.equal("sizeNote" in noAuto.modelInfo, false);
});

test("each model file and critic.json is read at most once per worker", async () => {
    const reads = [];
    const jobs = jobsWith({ "mapper-nn2-s.json": nn2("s"), "mapper.json": xgb, "critic.json": critic }, { reads });
    await gen(jobs);
    await gen(jobs, { stems: STEMS });
    await gen(jobs, { request: { modelSize: "l" } });
    await jobs.run("timing", { envelope: {} }, () => {});
    const counts = {};
    for (const name of reads) counts[name] = (counts[name] ?? 0) + 1;
    assert.ok(Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
});

test("critic.json is loaded when it is there and passed to the generator; without it the critic is null", async () => {
    const withCritic = await gen(jobsWith({ "mapper.json": xgb, "critic.json": critic }));
    assert.deepEqual(withCritic.sawOpts.critic, { kind: "critic-v1", loaded: true });
    assert.equal(withCritic.modelInfo.critic, "critic-v1");
    const without = await gen(jobsWith({ "mapper.json": xgb }));
    assert.equal(without.sawOpts.critic, null);
    assert.equal(without.modelInfo.critic, null);
});

test("a critic.json that does not load is left out and generation goes on", async () => {
    const jobs = createGeneratorJobs({
        load: fakeLoad({ ...MODULES, "../src/gen/critic.js": { loadCritic: () => { throw new Error("not a critic"); } } }),
        readModel: models({ "mapper.json": xgb, "critic.json": { kind: "nope" } }), analyze: () => {},
    });
    const r = await gen(jobs);
    assert.equal(r.kind, "generated");
    assert.equal(r.sawOpts.critic, null);
});

test("the personal model and the deadline from main reach the generator", async () => {
    const personal = { v: 1, names: ["a"], w: [1], b: 0, n: 20, weight: 0.3 };
    const r = await gen(jobsWith({ "mapper.json": xgb }), { personal, deadlineMs: 4000 });
    assert.equal(r.sawOpts.personal, personal);
    assert.equal(r.sawOpts.deadlineMs, 4000);
    const none = await gen(jobsWith({ "mapper.json": xgb }));
    assert.equal(none.sawOpts.personal, null);
});

test("the rule-based generator still runs with no model, and gets the stems too", async () => {
    const r = await gen(jobsWith({}), { stems: STEMS });
    assert.equal(r.engine, "rules");
    assert.equal(r.sawInput.stems.rebuiltStems, true);
    assert.deepEqual(r.modelInfo, { kind: "rules", grid: "q4", maps: 0, size: null, styles: [], critic: null, stems: true });
});

test("fit-personal runs in the worker job table and calls fitPersonal", async () => {
    let got = null;
    const jobs = createGeneratorJobs({
        load: fakeLoad({ "../src/gen/personal.js": { fitPersonal: async (entries, opts) => { got = { entries, opts }; return { v: 1, n: entries.length }; } }, "../src/gen/critic.js": criticModule }),
        readModel: models({ "critic.json": critic }), analyze: () => {},
    });
    assert.equal(jobs.has("fit-personal"), true);
    const r = await jobs.run("fit-personal", { entries: [{ vote: 1 }, { vote: -1 }] }, () => {});
    assert.deepEqual(r, { kind: "personal", personal: { v: 1, n: 2 } });
    assert.equal(got.entries.length, 2);
    assert.deepEqual(got.opts.norm, critic.norm);
});

test("the real personal.js stub fits nothing yet", async () => {
    const jobs = createGeneratorJobs({ readModel: models({}), analyze: () => {} });
    assert.deepEqual(await jobs.run("fit-personal", { entries: [] }, () => {}), { kind: "personal", personal: null });
    const { fitPersonal } = await import("../src/gen/personal.js");
    assert.equal(await fitPersonal([{ vote: 1 }]), null);
});

test("the real stems module rebuilds a StemsTransfer beside the envelope", async () => {
    const frames = 6;
    const curve = () => new Float32Array(frames).fill(0.5);
    const transfer = stemsToTransfer({ hopSec: 0.01, frameOffsetSec: 0, frames, kick: curve(), snare: curve(), hat: curve(), harm: curve(), percShare: curve(), chroma: new Float32Array(frames * 12), timbre: new Float32Array(frames * 12) });
    const jobs = createGeneratorJobs({
        load: (spec) => (spec === "../src/gen/generateLearned.js" ? learned : import(new URL(spec, new URL("../app/", import.meta.url)).href)),
        readModel: models({ "mapper.json": xgb }), analyze: () => {},
    });
    const r = await gen(jobs, { envelope: { values: new Float32Array(frames), hopSec: 0.01, frameOffsetSec: 0 }, stems: transfer });
    assert.equal(r.kind, "generated", r.message);
    assert.equal(r.sawInput.stems.frames, frames);
    assert.equal(typeof r.sawInput.stems.frameTimeSec, "function");
    assert.ok(r.sawInput.stems.chroma instanceof Float32Array);
});

// ---- model folders: the app's models/ and, for dev, LUNACY_MODEL_DIR ----

test("modelDirs: LUNACY_MODEL_DIR folders (split on the path list separator) come before the app's models/", () => {
    const app = path.resolve("models");
    assert.deepEqual(modelDirs({ env: {}, appDir: app }), [app]);
    const dev = ["A:/SneezeyTrain/candidates", "A:/SneezeyTrain/critic"].join(path.delimiter);
    assert.deepEqual(modelDirs({ env: { LUNACY_MODEL_DIR: dev }, appDir: app }), ["A:/SneezeyTrain/candidates", "A:/SneezeyTrain/critic", app]);
    assert.deepEqual(modelDirs({ env: { LUNACY_MODEL_DIR: "  " }, appDir: app }), [app]);
});

test("a LUNACY_MODEL_DIR model is read before the app's own, and the app's is the fallback", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lunacy-models-"));
    await writeFile(path.join(dir, "mapper-nn2-s.json"), JSON.stringify(nn2("s")));
    await writeFile(path.join(dir, "mapper.json"), JSON.stringify({ ...xgb, from: "dev" }));
    assert.equal(devModelReader(""), null);
    const reads = [];
    const jobs = createGeneratorJobs({ load: fakeLoad(MODULES), readModel: models({ "mapper.json": xgb, "critic.json": critic }, reads), analyze: () => {}, devModels: devModelReader(dir) });
    const withStems = await gen(jobs, { stems: STEMS, request: { modelSize: "s" } });
    assert.equal(withStems.sawModel.kind, "nn-v2");
    const plain = await gen(jobs);
    assert.equal(plain.sawModel.from, "dev");
    assert.ok(reads.includes("critic.json")); // not in the dev folder: the app's own
    assert.deepEqual((await readdir(dir)).sort(), ["mapper-nn2-s.json", "mapper.json"]);
});

test("listModelFiles names the model files and critic.json found in any folder, without reading them", async () => {
    const a = await mkdtemp(path.join(tmpdir(), "lunacy-a-"));
    const b = await mkdtemp(path.join(tmpdir(), "lunacy-b-"));
    await writeFile(path.join(a, "mapper-nn2-m.json"), "not json");
    await writeFile(path.join(b, "critic.json"), "{}");
    await writeFile(path.join(b, "mapper.json"), "{}");
    await writeFile(path.join(b, "other.json"), "{}");
    assert.deepEqual(await listModelFiles([a, b, path.join(a, "missing")]), ["mapper-nn2-m.json", "mapper.json", "critic.json"]);
});

test("generatorInfoOf: engines, sizes and the critic from the files; styles and the kind from the worker's last answer", () => {
    const info = generatorInfoOf(["mapper-nn2-l.json", "mapper-nn2-s-distilled.json", "mapper.json", "critic.json"],
        { kind: "nn-v2", grid: "snap-v2", maps: 30000, size: "s", styles: [{ key: "a", name: "A", maps: 3 }], critic: "critic-v1", stems: true });
    assert.deepEqual(info.engines, ["neural", "learned", "rules"]);
    assert.deepEqual(info.sizes, { auto: true, xgb3: false, s: true, m: false, l: true, distilled: true });
    assert.deepEqual(info.modelSizes, ["auto", "xgb3", "s", "m", "l"]);
    assert.equal(info.critic, "critic-v1");
    assert.deepEqual(info.styles, [{ key: "a", name: "A", maps: 3 }]);
    assert.equal(info.kind, "nn-v2");
    const empty = generatorInfoOf([], null);
    assert.deepEqual(empty.engines, ["rules"]);
    assert.deepEqual(empty.sizes, { auto: false, xgb3: false, s: false, m: false, l: false, distilled: false });
    assert.equal(empty.critic, null);
    assert.deepEqual(empty.styles, []);
    assert.equal(empty.kind, null);
});

test("modelInfoOf keeps the v3 fields and adds size, styles, critic and stems", () => {
    assert.deepEqual(modelInfoOf(xgb), { kind: "xgb-v1", grid: "q4", maps: 6326, size: null, styles: [], critic: null, stems: false });
    assert.deepEqual(modelInfoOf(nn2("m"), { critic: { kind: "critic-v1" }, stems: true }),
        { kind: "nn-v2", grid: "snap-v2", maps: 30000, size: "m", styles: [], critic: "critic-v1", stems: true });
});

// The training run's smoke model, when this machine has it: it loads, needs stems, and is picked as the S model.
const SMOKE = "A:/SneezeyTrain/nn2/runs/smoke-v3-S/mapper-nn2-s-smoke.json";
test("the smoke nn-v2 model is wired: needs stems, labelled neural, size s", { skip: !existsSync(SMOKE) && "no smoke model here" }, async () => {
    const smoke = await devModelReader(path.dirname(SMOKE))(path.basename(SMOKE));
    assert.equal(smoke.kind, "nn-v2");
    const jobs = jobsWith({ "mapper-nn2-s.json": smoke, "mapper.json": xgb });
    const without = await gen(jobs, { request: { modelSize: "s" } });
    assert.equal(without.sawModel, xgb);
    const r = await gen(jobs, { stems: STEMS, request: { modelSize: "s" } });
    assert.equal(r.sawModel, smoke);
    assert.equal(r.engine, "neural");
    assert.equal(r.modelInfo.size, "s");
    assert.ok(Array.isArray(r.modelInfo.styles));
});

// ---- the markup and the preload (P-ml1 edits only inside the create tab's section and the create block) ----

test("#gen-options sits inside the create tab, before Generate, hidden until stream U fills it", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(new URL("../app/renderer/index.html", import.meta.url), "utf8");
    const tab = html.slice(html.indexOf("<section id=\"create-tab\""), html.indexOf("</section>", html.indexOf("<section id=\"create-tab\"")));
    assert.ok(tab.includes("<div id=\"gen-options\" class=\"group\" hidden>"));
    assert.ok(tab.indexOf("id=\"gen-options\"") < tab.indexOf("id=\"generate\""));
    assert.ok(tab.includes("data-i18n=\"create.html.genOptions\""));
});

test("the preload's create block has generatorInfo, rateVariant, ratingsSummary and ratingsExport", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../app/preload.cjs", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("// >>> create"), src.indexOf("// <<< create"));
    for (const [name, channel] of [["generatorInfo", "generator-info"], ["rateVariant", "rate-variant"], ["ratingsSummary", "ratings-summary"], ["ratingsExport", "ratings-export"]]) {
        assert.match(block, new RegExp(`${name}: [(][^)]*[)] => ipcRenderer[.]invoke[(]"${channel}"`), name);
        assert.equal(src.split(`${name}:`).length - 1, 1, `${name} once`);
    }
});
