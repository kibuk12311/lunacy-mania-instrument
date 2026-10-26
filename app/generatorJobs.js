// The create tab's jobs inside the worker (mapgen v3): generate, timing, remap and fit-personal.
// Each kind imports its modules when it is first asked for, so a missing module breaks only its own kind.
//
// The mapper model (wave 3, docs/2026-10-25-mapgen-v3-ml-addendum.md §1.1, §11): the first file of
// modelOrder(request.modelSize) that loads and whose `needs` are met (needs: ["stems", "structure"] wants the song's
// stems); with none the rule-based generator runs. Every file and critic.json is read at most once per worker.
// - modelSize "auto" (the default, «Классическая» in the picker): the proven v1 model, mapper.json. Release 0.9.0:
//   the held-out evaluation said no-ship for every newer model, so they are experimental choices only.
// - "xgb3": mapper-xgb3.json; "s" / "m" / "l": that nn-v2 size, then each smaller one (L without a GPU is allowed:
//   slow). Every experimental choice falls back to mapper.json, with a sizeNote { want, got } (got: the choice that
//   ran, "auto" for mapper.json, null for the rules).
// - critic.json is optional: when it loads it goes to the generator as opts.critic, else null.
// - Model folders: the app's models/; for dev, first the folders in the LUNACY_MODEL_DIR environment variable
//   (several joined by ";" on Windows), e.g. LUNACY_MODEL_DIR=A:\SneezeyTrain\candidates;A:\SneezeyTrain\critic
// - Stream W's hook (the GPU): nnBackend() → the GPU renderer's nn-v2 encoder (app/gpuWorkerLink.js) or null. It is
//   asked for only when the picked model is nn-v2, and given to the generator as opts.nnBackend, where the nn-v2 row
//   source runs its encoder on it (src/gen/nn/webgpu/gpuSource.js infillSourceFor); null or absent: all CPU, and the
//   generator's opts are exactly as before. modelInfo.gpu is true when a job had the GPU backend.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NN2_FILES = Object.freeze({ l: "mapper-nn2-l.json", m: "mapper-nn2-m.json", sd: "mapper-nn2-s-distilled.json", s: "mapper-nn2-s.json" });
export const XGB3_FILE = "mapper-xgb3.json";
export const CLASSIC_FILE = "mapper.json";
export const MODEL_FILES = [NN2_FILES.l, NN2_FILES.m, NN2_FILES.sd, NN2_FILES.s, XGB3_FILE, CLASSIC_FILE];
export const CRITIC_FILE = "critic.json";
export const MODEL_SIZES = ["auto", "xgb3", "s", "m", "l"];
export const APP_MODEL_DIR = fileURLToPath(new URL("../models/", import.meta.url));
// the picker choice each file answers to
const CHOICE_OF_FILE = { [NN2_FILES.l]: "l", [NN2_FILES.m]: "m", [NN2_FILES.sd]: "s", [NN2_FILES.s]: "s", [XGB3_FILE]: "xgb3", [CLASSIC_FILE]: "auto" };
const ORDER = {
    auto: [CLASSIC_FILE],
    xgb3: [XGB3_FILE, CLASSIC_FILE],
    s: [NN2_FILES.sd, NN2_FILES.s, CLASSIC_FILE],
    m: [NN2_FILES.m, NN2_FILES.sd, NN2_FILES.s, CLASSIC_FILE],
    l: [NN2_FILES.l, NN2_FILES.m, NN2_FILES.sd, NN2_FILES.s, CLASSIC_FILE],
};
const KINDS = new Set(["generate", "timing", "remap", "fit-personal"]);
// what each `needs` entry wants from the job; the structure is built from the stems (src/gen/structure.js)
const NEEDS = { stems: (have) => have.stems, structure: (have) => have.stems };

// The model files to try, in order, for a picker choice; anything unknown is "auto" (mapper.json). The order is
// the same with or without a graphics card: "auto" is the classic model on every computer.
export function modelOrder(modelSize = "auto") {
    return [...(Object.hasOwn(ORDER, modelSize) ? ORDER[modelSize] : ORDER.auto)];
}

// Whether a model's `needs` are met by what the job has ({ stems: boolean }). No `needs`: always.
export function needsMet(model, have) {
    const needs = model?.needs;
    if (needs === undefined || needs === null) return true;
    return Array.isArray(needs) && needs.every((need) => NEEDS[need]?.(have) === true);
}

const stylesOf = (model) => (Array.isArray(model?.styles) ? model.styles : [])
    .filter((s) => s && typeof s.key === "string" && s.key)
    .map((s) => ({ key: s.key, name: typeof s.name === "string" && s.name ? s.name : s.key, maps: Number(s.maps) || 0 }));

// What the window shows about the model: { kind, grid, maps, size, styles, critic, stems } (+ sizeNote on a fallback).
export function modelInfoOf(model, { critic = null, stems = false } = {}) {
    const base = model
        ? { kind: model.kind ?? "xgb-v1", grid: model.grid ?? "q4", maps: Number(model.metrics?.maps) || 0 }
        : { kind: "rules", grid: "q4", maps: 0 };
    const size = typeof model?.size === "string" ? model.size.toLowerCase() : null;
    return { ...base, size, styles: stylesOf(model), critic: critic?.kind ?? null, stems: Boolean(stems) };
}

const engineOf = (model) => (typeof model?.kind === "string" && model.kind.startsWith("nn-") ? "neural" : "learned");

const splitDirs = (dirs) => (Array.isArray(dirs) ? dirs : String(dirs ?? "").split(path.delimiter)).map((d) => d.trim()).filter(Boolean);

// LUNACY_MODEL_DIR's folders, then the app's models/.
export function modelDirs({ env = process.env, appDir = APP_MODEL_DIR } = {}) {
    return [...splitDirs(env.LUNACY_MODEL_DIR), appDir];
}

// A reader over the LUNACY_MODEL_DIR folders (or the ones given), or null when there are none.
export function devModelReader(dirs = process.env.LUNACY_MODEL_DIR) {
    const list = splitDirs(dirs);
    if (!list.length) return null;
    return async (name) => {
        for (const dir of list) {
            const m = await readFile(path.join(dir, name), "utf8").then(JSON.parse, () => null);
            if (m) return m;
        }
        throw new Error(`${name}: not in ${list.join(", ")}`);
    };
}

// The model files and critic.json found in any of the folders (checked, never read), in MODEL_FILES order.
export async function listModelFiles(dirs = modelDirs()) {
    const isFile = (file) => stat(file).then((s) => s.isFile(), () => false);
    const found = [];
    for (const name of [...MODEL_FILES, CRITIC_FILE]) {
        for (const dir of dirs) {
            if (await isFile(path.join(dir, name))) {
                found.push(name);
                break;
            }
        }
    }
    return found;
}

// generator-info's modelInfo: engines, sizes and the critic from the files there; the kind, grid, maps, size and
// styles from the worker's last model info (null before the worker has answered).
export function generatorInfoOf(files, last = null) {
    const has = (name) => files.includes(name);
    const neural = files.some((f) => f.startsWith("mapper-nn"));
    const learned = has(XGB3_FILE) || has(CLASSIC_FILE);
    return {
        kind: last?.kind ?? null, grid: last?.grid ?? null, maps: Number(last?.maps) || 0, size: last?.size ?? null,
        styles: Array.isArray(last?.styles) ? last.styles : [],
        critic: has(CRITIC_FILE) ? "critic-v1" : null,
        engines: [...(neural ? ["neural"] : []), ...(learned ? ["learned"] : []), "rules"],
        sizes: {
            auto: has(CLASSIC_FILE), xgb3: has(XGB3_FILE),
            s: has(NN2_FILES.s) || has(NN2_FILES.sd), m: has(NN2_FILES.m), l: has(NN2_FILES.l), distilled: has(NN2_FILES.sd),
        },
        modelSizes: MODEL_SIZES,
        files: [...files],
    };
}

// load(spec) imports a module relative to this file; readModel(name) → the parsed model from the app's models/, or
// rejects; devModels: the LUNACY_MODEL_DIR reader, tried first (a `gpu` option is ignored since 0.9.0: "auto" no
// longer depends on the graphics card); nnBackend() → Promise of the GPU encoder backend or null (stream W).
export function createGeneratorJobs({ load = (spec) => import(spec), readModel, analyze, devModels = devModelReader(), nnBackend = null }) {
    const readers = [devModels, readModel].filter(Boolean);
    const files = new Map(); // name → Promise<model | null>
    const read = (name) => {
        if (!files.has(name)) {
            files.set(name, (async () => {
                for (const reader of readers) {
                    const m = await Promise.resolve().then(() => reader(name)).catch(() => null);
                    if (m) return m;
                }
                return null;
            })());
        }
        return files.get(name);
    };

    // → { model, sizeNote? } for a model-strength choice and what the job has
    async function pick(modelSize, have) {
        const want = Object.hasOwn(ORDER, modelSize) && modelSize !== "auto" ? modelSize : null;
        for (const name of modelOrder(modelSize)) {
            const m = await read(name);
            if (!m || !needsMet(m, have)) continue;
            const got = CHOICE_OF_FILE[name] ?? null;
            return { model: m, ...(want && got !== want ? { sizeNote: { want, got } } : {}) };
        }
        return { model: null, ...(want ? { sizeNote: { want, got: null } } : {}) };
    }

    let criticPromise = null;
    const critic = () => (criticPromise ??= (async () => {
        const json = await read(CRITIC_FILE);
        if (!json) return { json: null, critic: null };
        try {
            const { loadCritic } = await load("../src/gen/critic.js");
            return { json, critic: loadCritic(json) };
        } catch {
            return { json: null, critic: null };
        }
    })());

    async function generate(payload, onProgress) {
        const { envelopeFromTransfer } = await load("../src/audio/onset.js");
        const { stems: transfer, ...rest } = payload;
        const input = { ...rest, envelope: envelopeFromTransfer(payload.envelope) };
        if (transfer) {
            const { stemsFromTransfer } = await load("../src/audio/stems.js");
            input.stems = stemsFromTransfer(transfer);
        }
        const stems = Boolean(input.stems);
        const { model: m, sizeNote } = await pick(payload.request?.modelSize, { stems });
        const { critic: c } = await critic();
        const modelInfo = { ...modelInfoOf(m, { critic: c, stems }), ...(sizeNote ? { sizeNote } : {}) };
        if (!m) {
            const { generateMap } = await load("../src/gen/generate.js");
            const out = await generateMap(input, analyze, { onProgress });
            return { kind: "generated", ...out, engine: "rules", modelInfo };
        }
        const { generateLearnedMap } = await load("../src/gen/generateLearned.js");
        const backend = m.kind === "nn-v2" && nnBackend ? await Promise.resolve().then(nnBackend).catch(() => null) : null;
        const out = await generateLearnedMap(input, analyze, m, { onProgress, critic: c, personal: payload.personal ?? null, deadlineMs: payload.deadlineMs ?? null, ...(backend ? { nnBackend: backend } : {}) });
        return { kind: "generated", ...out, engine: engineOf(m), modelInfo: backend ? { ...modelInfo, gpu: true } : modelInfo };
    }

    async function timing({ envelope, fine = null, hint = null }) {
        const { envelopeFromTransfer } = await load("../src/audio/onset.js");
        const { detectTimingFull } = await load("../src/audio/timingJob.js");
        const found = await detectTimingFull({ envelope: envelopeFromTransfer(envelope), fine, hint });
        const { model: m } = await pick("auto", { stems: false });
        return { kind: "timing", timing: found, modelInfo: modelInfoOf(m, { critic: (await critic()).critic }) };
    }

    async function remap(payload, onProgress) {
        const { remapChart } = await load("../src/gen/remap.js");
        const { osuText, range, seed } = payload;
        const { model: m } = await pick("auto", { stems: false });
        const out = await remapChart({ osuText, range, seed }, analyze, m, { onProgress });
        return { kind: "remapped", ...out };
    }

    // the personal reranker, fitted here so main never blocks (§2.7): { entries } → { kind: "personal", personal }
    async function fitPersonalJob(payload) {
        const { fitPersonal } = await load("../src/gen/personal.js");
        const { json } = await critic();
        const personal = await fitPersonal(Array.isArray(payload.entries) ? payload.entries : [], { norm: json?.norm ?? null });
        return { kind: "personal", personal: personal ?? null };
    }

    const jobs = { generate, timing, remap, "fit-personal": fitPersonalJob };
    return {
        has: (kind) => KINDS.has(kind),
        // never throws: a failure is { kind: "error", message }
        async run(kind, payload, onProgress) {
            try {
                return await jobs[kind](payload ?? {}, onProgress);
            } catch (error) {
                return { kind: "error", message: String(error?.message ?? error) };
            }
        },
    };
}
