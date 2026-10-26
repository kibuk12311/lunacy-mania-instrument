// nn-v2 speed on this machine (ML addendum §0, §5.3): kernel GFLOP/s, then for each size (tools/nn/sizes.json) the
// measured prepare (inputs + encoder + the decoder's static K/V) and one build (decoder + lane head over every slot)
// of a 4-minute song, and the projected per-variant time of §5.3 here and on the 1 GFLOP/s laptop budget.
// Usage: node tools/bench-nn.mjs [--sizes S,M,L] [--seconds 240] [--bpm 175] [--reps 2] [--candidates 12]
//        node tools/bench-nn.mjs --model A:/SneezeyTrain/candidates/mapper-nn2-s.json   (its parity probes, then its speed)
import { readFile } from "node:fs/promises";
import { matmul, matmulT, matvec } from "../src/gen/nn/kernels.js";
import { infillSource, randomInfillModel, infillFlops, loadInfill, probeInputs, teacherForced } from "../src/gen/nn/infillModel.js";
import { slotsForTiming } from "../src/gen/grid.js";
import { envelopeFromTransfer } from "../src/audio/onset.js";
import { mulberry32 } from "../src/gen/rng.js";

const arg = (name, dflt) => {
    const k = process.argv.indexOf(`--${name}`);
    return k > 0 ? process.argv[k + 1] : dflt;
};
const modelFile = arg("model", null);
const sizes = modelFile ? ["file"] : arg("sizes", "S,M,L").split(",");
const seconds = Number(arg("seconds", 240));
const bpm = Number(arg("bpm", 175));
const reps = Number(arg("reps", 2));
const candidates = Number(arg("candidates", 12));
const LAPTOP_GFLOPS = 1.0;
// §5.3 costs that are not the model: analyze per call, critic stage 1 per candidate, describe (this machine / laptop)
const ANALYZE = [0.25, 0.6];
const CRITIC = [0.01, 0.025];
const DESCRIBE = [0.5, 1.0];
const SEARCH_EVALS = 5;
const STAGE2 = 3;

const rng = mulberry32(1);
const rand = (n) => Float32Array.from({ length: n }, () => rng() - 0.5);
const best = (f, r) => {
    f();
    let t = Infinity;
    for (let k = 0; k < r; k += 1) {
        const t0 = performance.now();
        f();
        t = Math.min(t, (performance.now() - t0) / 1000);
    }
    return t;
};
const gflops = (flops, sec) => flops / sec / 1e9;
const f2 = (x) => x.toFixed(2);

console.log(`node ${process.version}, single thread\n`);
console.log("kernel                         GFLOP/s");
{
    const [n, k, m] = [700, 96, 384];
    const A = rand(n * k);
    const B = rand(k * m);
    const W = rand(m * k);
    console.log(`matmul i-p-j 700×96·96×384     ${f2(gflops(2 * n * k * m, best(() => matmul(A, B, n, k, m), 10)))}`);
    console.log(`matmulT (dots) 700×96·(384×96)ᵀ ${f2(gflops(2 * n * k * m, best(() => matmulT(A, W, n, k, m), 10)))}`);
    for (const [r, c] of [[64, 256], [160, 64], [64, 160]]) {
        const Wm = rand(r * c);
        const x = rand(c);
        const t = best(() => { for (let it = 0; it < 2000; it += 1) matvec(Wm, x, 0, r, c); }, 5) / 2000;
        console.log(`matvec ${r}×${c}`.padEnd(31) + f2(gflops(2 * r * c, t)));
    }
}

// a 4-minute song: mostly 1/4 with some 1/3, 1/6 and 1/8 beats (≈ 4.3 slots per beat), and a random envelope
const divs = [4, 4, 4, 4, 4, 4, 3, 4, 4, 8, 4, 6];
const slots = slotsForTiming({ bpm, offsetMs: 0 }, seconds * 1000, { divOf: (b) => divs[b % divs.length] });
const beats = new Set(slots.map((s) => s.beat)).size;
const frames = Math.floor((seconds * 22050) / 256);
const envelope = envelopeFromTransfer({ values: rand(frames).map(Math.abs), energy: rand(frames).map(Math.abs), bands: { low: rand(frames).map(Math.abs), mid: rand(frames).map(Math.abs), high: rand(frames).map(Math.abs) }, hopSec: 256 / 22050, frameOffsetSec: 768 / 22050 });
const dan = new Float64Array(slots.length).fill(10);
const family = slots.map(() => "Stream");
const presets = JSON.parse(await readFile(new URL("./nn/sizes.json", import.meta.url), "utf8"));
const fileModel = modelFile ? JSON.parse(await readFile(modelFile, "utf8")) : null;
if (fileModel) {
    const net = loadInfill(fileModel);
    const tol = fileModel.parity?.tolerance ?? 2e-3;
    let ok = true;
    for (const probe of fileModel.parity?.probes ?? []) {
        const inp = probeInputs(probe);
        const got = teacherForced(net, inp, inp.rows, probe.check);
        let worst = 0;
        got.forEach((g, k) => g.forEach((v, c) => { worst = Math.max(worst, Math.abs(v - probe.logits[k][c])); }));
        ok &&= worst <= tol;
        console.log(`parity ${probe.name}: ${probe.T} beats, max |Δ logit| ${worst.toExponential(2)} (≤ ${tol}) ${worst <= tol ? "ok" : "FAIL"}`);
    }
    console.log(`${modelFile}: kind ${fileModel.kind}, size ${fileModel.size}, parity ${ok ? "PASS" : "FAIL"}`);
    if (!ok) process.exitCode = 1;
}
console.log(`\nsong: ${seconds} s at ${bpm} BPM → ${beats} beats, ${slots.length} slots; per variant: ${SEARCH_EVALS} search builds + ${candidates} candidates`);
console.log("size  params   prepare s (GFLOP, GFLOP/s)   build s (GFLOP, GFLOP/s)   variant here s   laptop s (1 GFLOP/s)");
for (const size of sizes) {
    const arch = fileModel ? { ...fileModel.arch, size: fileModel.size } : { ...presets[size], size };
    const model = fileModel ?? randomInfillModel(arch, { seed: 3 });
    const params = Object.values(model.weights).reduce((s, w) => s + Buffer.from(w.f16, "base64").length / 2, 0);
    const fl = infillFlops(arch, beats, slots.length);
    let prep = null;
    const tPrep = best(() => { prep = infillSource.prepare({ model, audio: { envelope }, slots, dan, family }); }, reps);
    const rngs = { fill: mulberry32(1), size: mulberry32(2), pattern: mulberry32(3) };
    const tBuild = best(() => {
        prep.begin();
        for (let i = 0; i < slots.length; i += 1) prep.step(i, 0, null, rngs, null);
    }, reps);
    const here = tPrep + SEARCH_EVALS * (tBuild + ANALYZE[0]) + candidates * (tBuild + CRITIC[0]) + STAGE2 * ANALYZE[0] + DESCRIBE[0];
    const lap = (f) => f / (LAPTOP_GFLOPS * 1e9);
    const laptop = lap(fl.prepare) + SEARCH_EVALS * (lap(fl.build) + ANALYZE[1]) + candidates * (lap(fl.build) + CRITIC[1]) + STAGE2 * ANALYZE[1] + DESCRIBE[1];
    console.log(`${String(arch.size).padEnd(5)} ${(params / 1e6).toFixed(2)}M   ${f2(tPrep).padStart(6)} (${f2(fl.prepare / 1e9)}, ${f2(gflops(fl.prepare, tPrep))})`.padEnd(46)
        + `${f2(tBuild).padStart(6)} (${f2(fl.build / 1e9)}, ${f2(gflops(fl.build, tBuild))})`.padEnd(27)
        + `${f2(here).padStart(8)}`.padEnd(17) + `${f2(laptop).padStart(8)}`);
}
console.log(`\n§5.3 targets: ≤ 8 s per variant here, ≤ 15 s on a 4-core laptop (N adapts through the time box). The laptop column`
    + ` assumes the ${LAPTOP_GFLOPS} GFLOP/s budget; under 0.8 GFLOP/s measured on a laptop, the encoder shrinks to d = 64 (N0).`);
