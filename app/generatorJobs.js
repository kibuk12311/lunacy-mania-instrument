// The create tab's jobs inside the worker (mapgen v3): generate, timing and remap.
// Each kind imports its modules when it is first asked for, so a missing module breaks only its own kind.
// The mapper model is the first of MODEL_FILES that loads (read once per worker); with none the rule-based generator runs.

export const MODEL_FILES = ["mapper-nn.json", "mapper.json"];
const KINDS = new Set(["generate", "timing", "remap"]);

// What the window shows about the model: { kind, grid, maps }.
export function modelInfoOf(model) {
    if (!model) return { kind: "rules", grid: "q4", maps: 0 };
    return { kind: model.kind ?? "xgb-v1", grid: model.grid ?? "q4", maps: Number(model.metrics?.maps) || 0 };
}

// load(spec) imports a module relative to this file; readModel(name) → the parsed model, or rejects.
export function createGeneratorJobs({ load = (spec) => import(spec), readModel, analyze }) {
    let modelPromise = null;
    const model = () => (modelPromise ??= (async () => {
        for (const name of MODEL_FILES) {
            const m = await Promise.resolve().then(() => readModel(name)).catch(() => null);
            if (m) return m;
        }
        return null;
    })());

    async function generate(payload, onProgress) {
        const { envelopeFromTransfer } = await load("../src/audio/onset.js");
        const input = { ...payload, envelope: envelopeFromTransfer(payload.envelope) };
        const m = await model();
        if (!m) {
            const { generateMap } = await load("../src/gen/generate.js");
            const out = await generateMap(input, analyze, { onProgress });
            return { kind: "generated", ...out, engine: "rules", modelInfo: modelInfoOf(null) };
        }
        const { generateLearnedMap } = await load("../src/gen/generateLearned.js");
        const out = await generateLearnedMap(input, analyze, m, { onProgress });
        const engine = m.kind === "nn-v1" ? "neural" : "learned";
        return { kind: "generated", ...out, engine, modelInfo: modelInfoOf(m) };
    }

    async function timing({ envelope, fine = null, hint = null }) {
        const { envelopeFromTransfer } = await load("../src/audio/onset.js");
        const { detectTimingFull } = await load("../src/audio/timingJob.js");
        const found = await detectTimingFull({ envelope: envelopeFromTransfer(envelope), fine, hint });
        return { kind: "timing", timing: found, modelInfo: modelInfoOf(await model()) };
    }

    async function remap(payload, onProgress) {
        const { remapChart } = await load("../src/gen/remap.js");
        const { osuText, range, seed } = payload;
        const out = await remapChart({ osuText, range, seed }, analyze, await model(), { onProgress });
        return { kind: "remapped", ...out };
    }

    const jobs = { generate, timing, remap };
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
