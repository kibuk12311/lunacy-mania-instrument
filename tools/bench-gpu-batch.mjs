// The GPU batches of builds (stream W, D3/D4) measured on this machine's GPU with the shipped models (S, M, L in models/)
// through the real worker ↔ GPU renderer path: main's GPU host (app/gpuWorkerHost.js) and a utility process that links
// to it as app/analysisWorker.js does (tests/smoke/gpuBatchWorker.mjs). Synthetic songs only (tests/fixtures).
//   1. parity: the GPU batch's logits against the CPU decoder over the same rows, rows of the same seeds, a whole
//      variant on the CPU and through the batches;
//   2. model time per variant (prepare + builds + snapshots, debug.timing) on a 4-minute song: cpu (no GPU), d1 (GPU
//      encoder, CPU builds: 0.10.2's path), batch (D3/D4), with candidates 12 and 1, alternating with 0.10.2's own
//      code (--old: a checkout of 0.10.2 with vendor/) — the machine may be busy: medians;
//   3. one generate-map job end to end through the real app/analysisWorker.js, and through 0.10.2's (--old), alternating;
//   GPU utilisation from nvidia-smi (when there is one) over each run.
// Usage: npx electron tools/bench-gpu-batch.mjs [--sizes s,m,l] [--repeats 3] [--candidates 12,1] [--parts parity,time,e2e]
//        [--modes old-d1,d1,batch] [--old <0.10.2 dir>] [--out dir]. Not part of npm test (it needs a GPU); numbers go to docs/2026-10-26-webgpu-stream-w.md.
import { app, utilityProcess } from "electron";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerClient } from "../app/workerClient.js";
import { registerGpuWorkerHost } from "../app/gpuWorkerHost.js";
import { envelopeToTransfer, onsetEnvelope } from "../src/audio/onset.js";
import { computeStemsSync, stemsToTransfer } from "../src/audio/stems.js";
import { sectionSong } from "../tests/fixtures/stemTracks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const arg = (name, dflt) => {
    const k = process.argv.indexOf(`--${name}`);
    return k > 0 ? process.argv[k + 1] : dflt;
};
const outDir = arg("out", path.join(tmpdir(), "lunacy-bench-gpu-batch"));
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
const sizes = arg("sizes", "s,m,l").split(",");
const repeats = Number(arg("repeats", 3));
const candidateSet = arg("candidates", "12,1").split(",").map(Number);
const parts = new Set(arg("parts", "parity,time,e2e").split(","));
// the modes that alternate in the timing part (cpu runs once before them; 0.10.2's old-d1 too, unless named here)
const modes = arg("modes", null)?.split(",") ?? null;
const oldDir = arg("old", null);
const log = (...a) => console.log(...a);
const median = (xs) => {
    const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// nvidia-smi's utilisation every 200 ms, with the time each sample came in
const gpuSamples = [];
let smi = null;
function startSmi() {
    try {
        smi = spawn("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits", "-lms", "200"], { windowsHide: true });
        smi.stdout.on("data", (buf) => {
            for (const line of String(buf).split(/\r?\n/)) if (/^\d+/.test(line.trim())) gpuSamples.push({ t: Date.now(), u: Number(line.trim()) });
        });
        smi.on("error", () => { smi = null; });
    } catch {
        smi = null;
    }
}
function gpuOver(started, ended) {
    const xs = gpuSamples.filter((s) => s.t >= started && s.t <= ended).map((s) => s.u);
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return { mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p90: sorted[Math.floor(0.9 * (sorted.length - 1))], max: sorted.at(-1), n: xs.length };
}

app.whenReady().then(async () => {
    const t0 = Date.now();
    const host = registerGpuWorkerHost({ log: (m) => log("host:", m) });
    startSmi();
    const report = { started: new Date().toISOString(), parity: [], time: [], e2e: [] };
    const bench = createWorkerClient({
        spawn: () => utilityProcess.fork(path.join(root, "tests", "smoke", "gpuBatchWorker.mjs"), oldDir ? ["--old", oldDir] : []),
        generateTimeoutMs: 1_200_000,
    });
    // the CPU-only runs in a process of their own: the CPU encoder feeds V8 float64 arrays into the kernels the decoder
    // shares, which slows every later decode in that process by ~25 % (and would make the d1 runs look slower than
    // 0.10.2's, whose modules never see it)
    let benchCpu = null;
    const ask = async (payload) => {
        const client = payload.mode === "cpu"
            ? (benchCpu ??= createWorkerClient({ spawn: () => utilityProcess.fork(path.join(root, "tests", "smoke", "gpuBatchWorker.mjs")), generateTimeoutMs: 1_200_000 }))
            : bench;
        const out = await client.generate(payload, () => {});
        if (out.kind !== "generated") throw new Error(`${payload.kind}: ${out.message}`);
        return out;
    };
    try {
        const linkInfo = await ask({ kind: "link" });
        log("link:", JSON.stringify(linkInfo));
        report.capability = linkInfo.capability;
        if (!linkInfo.backend) {
            log("no GPU backend: nothing to measure");
            app.exit(3);
            return;
        }
        // first use of each model on the GPU: upload, parity probes, the decoder kernel's compile
        for (const size of sizes) log(`warm ${size}: ${(await ask({ kind: "warm", size })).ms} ms`);

        if (parts.has("parity")) {
            for (const size of sizes) {
                for (const song of ["click174", "parts160"]) {
                    const r = await ask({ kind: "parity", size, song, builds: 4 });
                    report.parity.push(r);
                    const v = (k) => `${k} ${r.variant[k].same ? "same" : `differs (${r.variant[k].rowsOnlyCpu} of the CPU's rows not there)`}, ${r.variant[k].batched} builds batched`;
                    log(`parity ${size} ${song}: ${r.compared} slots, max |Δ logit| ${r.worstLogit.toExponential(2)}, rows differing ${r.rowsDiffer}/${r.rowsTotal}`
                        + `; whole variant vs cpu (${r.variant.cpu.notes} notes, dan ${r.variant.cpu.dan}): ${["d1", "batch"].map(v).join("; ")}`);
                }
                // builds restored from a GPU snapshot halfway (own-range parts, block retries)
                const r = await ask({ kind: "parity", size, song: "parts160", builds: 4, snapshotAt: 0.5, variants: false });
                report.parity.push(r);
                log(`parity ${size} parts160 from a snapshot at slot ${r.cut}: head rows differing ${r.headDiffer}, ${r.compared} slots, max |Δ logit| ${r.worstLogit.toExponential(2)}, rows differing ${r.rowsDiffer}/${r.rowsTotal}, fell back ${r.fellBack}`);
            }
        }

        if (parts.has("time")) {
            const song = "sections175";
            for (const size of sizes) {
                for (const candidates of candidateSet) {
                    const runs = [];
                    const one = async (mode) => {
                        const r = await ask({ kind: "time", size, song, mode, candidates });
                        r.gpu = gpuOver(r.started, r.ended);
                        runs.push(r);
                        report.time.push(r);
                        log(`time ${size} cand ${candidates} ${mode.padEnd(6)}: model ${r.modelMs} ms, total ${r.ms} ms, of ${r.of}, gpu ${JSON.stringify(r.gpu)}`
                            + (r.batch ? `, rounds ${r.batch.rounds}, max batch ${r.batch.maxBatch}, decode ${Math.round(r.batch.decodeMs)} ms` : ""));
                    };
                    await one("cpu");
                    for (let k = 0; k < repeats; k += 1) {
                        const order = [...(modes ?? ["old-d1", "d1", "batch"])];
                        for (const mode of k % 2 ? order.reverse() : order) await one(mode);
                    }
                }
            }
        }

        if (parts.has("e2e") && sizes.includes("l")) {
            const s = sectionSong(Array.from({ length: 22 }, (_, k) => ["A", "B", "A", "B'", "C"][k % 5]), { bpm: 175 });
            const envelope = onsetEnvelope(s.samples, s.sampleRate);
            const payload = {
                timing: { sections: [{ timeMs: 0, bpm: 175, meter: 4 }], bpm: 175, offsetMs: 0 }, envelope: envelopeToTransfer(envelope),
                durationMs: Math.round((s.samples.length / s.sampleRate) * 1000), stems: stemsToTransfer(computeStemsSync(s.samples, s.sampleRate)),
                request: { range: { lo: 7, hi: 9 }, patterns: [{ name: "Stream", share: 0.5 }, { name: "Jumpstream", share: 0.5 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, modelSize: "l", candidates: 12, repeats: true },
                meta: { title: "bench e2e", audioFilename: "a.mp3" }, personal: null, deadlineMs: 4000, targetBudgetMs: 30000,
            };
            const workers = {
                new: () => utilityProcess.fork(path.join(root, "app", "analysisWorker.js")),
                ...(oldDir ? { old: () => utilityProcess.fork(path.join(oldDir, "app", "analysisWorker.js"), [], { env: { ...process.env, LUNACY_MODEL_DIR: path.join(root, "models") } }) } : {}),
            };
            const clients = Object.fromEntries(Object.entries(workers).map(([k, sp]) => [k, createWorkerClient({ spawn: sp, generateTimeoutMs: 600_000 })]));
            // the first job of each worker links to the GPU and loads L: not timed
            for (const [k, c] of Object.entries(clients)) {
                const w = await c.generate({ ...payload, request: { ...payload.request, candidates: 1 } }, () => {});
                log(`e2e warm ${k}: ${w.kind} gpu ${w.modelInfo?.gpu ?? false} ${w.message ?? ""}`);
            }
            for (let k = 0; k < repeats; k += 1) {
                for (const name of k % 2 ? Object.keys(clients).reverse() : Object.keys(clients)) {
                    const phases = {};
                    const started = Date.now();
                    const out = await clients[name].generate(payload, (p) => { phases[p.phase] = (phases[p.phase] ?? 0) + 1; });
                    const ended = Date.now();
                    const r = {
                        worker: name, ms: ended - started, kind: out.kind, gpuLink: out.modelInfo?.gpu ?? false, numeric: out.result?.numeric ?? null,
                        of: out.critic?.of ?? null, attempts: out.targeting?.attempts?.map((a) => ({ rung: a.rung, numeric: a.numeric, ms: a.ms })) ?? null,
                        phases, gpu: gpuOver(started, ended), message: out.message ?? null,
                    };
                    report.e2e.push(r);
                    log(`e2e ${name}: ${r.ms} ms, ${r.kind}, dan ${r.numeric}, of ${r.of}, tries ${JSON.stringify(r.attempts)}, gpu ${JSON.stringify(r.gpu)}`);
                }
            }
            for (const c of Object.values(clients)) c.dispose();
            for (const name of Object.keys(clients)) {
                const runs = report.e2e.filter((r) => r.worker === name);
                log(`e2e ${name}: median ${median(runs.map((r) => r.ms))} ms, candidates ${runs.map((r) => r.of).join("/")}, gpu % ${median(runs.map((r) => r.gpu?.mean))}`);
            }
        }

        // ---- the table ----
        log("\nmodel time per variant (median ms; prepare + builds + snapshots), 4-minute song, gpu utilisation mean/p90 of the batch runs:");
        for (const size of sizes) {
            for (const candidates of candidateSet) {
                const of = (mode) => report.time.filter((r) => r.size === size && r.candidates === candidates && r.mode === mode);
                const m = (mode) => median(of(mode).map((r) => r.modelMs));
                const tot = (mode) => median(of(mode).map((r) => r.ms));
                const util = median(of("batch").map((r) => r.gpu?.mean));
                const utilD1 = median(of("d1").map((r) => r.gpu?.mean));
                log(`${size.toUpperCase()} cand ${String(candidates).padStart(2)}: model cpu ${m("cpu")} | d1 ${m("d1")} | batch ${m("batch")}`
                    + ` || total old-d1 ${tot("old-d1")} | d1 ${tot("d1")} | batch ${tot("batch")} || gpu % d1 ${utilD1} batch ${util}`);
            }
        }
    } catch (error) {
        log("bench failed:", error?.stack ?? error);
        report.error = String(error?.message ?? error);
    }
    report.totalMs = Date.now() - t0;
    writeFileSync(path.join(outDir, "bench-gpu-batch.json"), JSON.stringify(report, null, 1));
    log(`total ${Math.round(report.totalMs / 1000)} s; ${path.join(outDir, "bench-gpu-batch.json")}`);
    smi?.kill();
    bench.dispose();
    benchCpu?.dispose();
    host.dispose();
    app.exit(report.error ? 1 : 0);
});
setTimeout(() => {
    console.log("bench timeout");
    smi?.kill();
    app.exit(2);
}, 3_000_000);
