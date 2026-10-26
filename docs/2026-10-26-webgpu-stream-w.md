# Stream W: nn-v2 on WebGPU (ML addendum §11)

- **Date:** 2026-10-26 (night run). Branch `w3b/w`, on `feature/v3` 10bcfb3 + `w3b/p` (P-ml1).
- **Machine:** RTX 5080 (Blackwell), Electron 38.2.0 (Chromium, Dawn on D3D12, shader compiler FXC `d3dcompiler_47.dll`), Node 22.19 inside Electron.
- **Load while measuring:** the training chain was running (a CUDA job on the same GPU at ~27 %, a long dataset job on the CPU). Plain-JS matvec measured 1.6–2.1 GFLOP/s against §0's 2.9–3.9, so every CPU number below is pessimistic by up to ~2×. The GPU latencies may be worse than on an idle GPU too.

## Decision

**The GPU runs the encoder and the decoder's static K/V. The decoder, the lane head and the sampling stay on the CPU, in the utility worker.**

- The hidden GPU renderer is a compute server for the generator worker. The generator itself does not move.
- The capability flag is `{ gpuAvailable, adapter, reason, decoder: "cpu" }`.
  - It appears in generator-info as `modelInfo.gpu`.
  - `modelSize: "auto"` uses it through `gpu()`. That flag is true only when the decoder runs on the GPU as well, so "auto" stays on the CPU sizes for now. The reason: L with only the encoder on the GPU costs 38 s per variant here, and §11 wants auto to be "the strongest size within budget".
- **The §11 budget is not met.** It asks for ≤ 2 s per variant for L.
  - Measured with the implemented design: **38.4 s per variant for L** (4-minute song, prepare + 5 search builds + 12 candidates, model time only).
  - Best measured design, which needs G to change the generator: **10.5 s**.
  - What does reach about 2 s is an **L encoder with an S decoder**. Its build time is S's (0.30 s), and its encoder is free on the GPU (0.03 s instead of 11.5 s). With the 12 candidates built in parallel (G5 pool), the projection is about 1.9 s.

## How it runs

```
renderer (create tab) ──generate-map──▶ main (createIpc) ──▶ utility worker (analysisWorker.js → generatorJobs → generator)
                                          │                         │ first nn-v2 job: { gpuPort: true }
                                          │ gpuWorkerHost ◀─────────┘ (workerClient hook)
                                          │   creates the hidden page on first use, and a MessageChannelMain per worker
                                          ▼
                              hidden renderer app/gpuWorker.html (sandbox, contextIsolation, no Node, CSP 'self')
                                GPUDevice + src/gen/nn/webgpu/gpuServer.js: hello / load / encode / unload
```

- **One round trip per prepare.**
  1. The worker sends the beat inputs: T × 145 floats plus the masks.
  2. The renderer runs the encoder, `e2d` and the cross-attention K/V.
  3. The worker gets `e2d` and the K/V back, about 4 MB for L. They are copied, because Electron cannot transfer ArrayBuffers to a port in another process.
  4. `createGpuInfillSource` feeds them into `infillSource`'s own decoder and sampler through `prepare({ encoded })`.
  5. So `step()` stays synchronous and draws exactly the RNG the CPU path draws.
- **Checks before use.** The GPU path is used only when `navigator.gpu` gives an adapter and both checks pass:
  - At start-up, a small random model is run on the GPU encoder with the CPU decoder and compared with plain JS (`gpuProbe.js` `probeGpu`).
  - At each model load, the model's own parity probes are run on the same path (`checkModelOnGpu`, ≤ 2e-3).
- **Any failure falls back to the CPU for that prepare.** That covers no adapter, a failed probe, a lost device, a closed port, a timeout or wrong shapes.

## Measured

**Parity, max |Δ logit|** (`npx electron tests/smoke/electron-webgpu.mjs`, `LUNACY_MODEL_DIR=A:\SneezeyTrain\nn2\runs\smoke-v3-S`)

| Check | App path (GPU encoder + CPU decoder) | All on the GPU (decoder kernel) |
|---|---|---|
| start-up probe vs JS | 8.9e-8 | — |
| `tests/fixtures/infill-parity.json` (XS, 3 probes) vs PyTorch | 2.6e-6 | 1.7e-6 – 2.4e-6 |
| `mapper-nn2-s-smoke.json` (S, 3 × 512 beats) vs PyTorch | 3.3e-6 | 1.4e-6 – 3.8e-6 |
| random S / M / L vs JS: encoder output | ≤ 1.9e-6 | |
| random S / M / L vs JS: teacher-forced logits | | ≤ 4.3e-7 |

- Rows sampled with the same seeds agree with the CPU build on **100.0 %** of 3091 slots, for S, M, L and Lenc, on both GPU paths.

**WebGPU in the Electron renderer**

- **Submit → readback round trip, one chain:**
  - p50 3.0 ms (p10 2.3, p90 3.5);
  - the same from a dedicated worker;
  - none of `--disable-gpu-vsync`, `--enable-unsafe-webgpu` or the Dawn feature flags changed it;
  - `--use-webgpu-adapter=d3d11` gives no adapter.
- **With 2 "keep-alive" chains in flight:**
  - p50 0.4–0.6 ms;
  - mean 1.0–1.4 ms;
  - p90 still about 3.4 ms (time slicing with the CUDA job, presumably).
- **`setTimeout(0)` in the hidden page** takes 4.8 ms, so the batching scheduler posts to a `MessageChannel` instead.
- **FXC compile time:**
  - linear: 4–40 ms;
  - layer norm: 3–43 ms;
  - encoder attention: 110–400 ms;
  - decoder kernel with its layers unrolled: 5 s (S) / 14 s (L);
  - decoder kernel with layers looped at run time and loop bounds hidden from the compiler: 2.2–3.4 s, so it is compiled lazily, only when a GPU decoder is asked for.
- **Start-up**, measured through the real utility-process path (`tests/smoke/electron-gpu-link.mjs`):
  - hidden page + device + probe: 0.4–1.3 s;
  - first load of the smoke model (upload, compile and its 3 parity probes): 0.69 s;
  - a random L model: 0.43 s.

**Per size**, for a 4-minute song at 175 BPM (701 beats, 3091 slots; `npx electron tools/bench-gpu.mjs`, random weights in the `tools/nn/sizes.json` shapes). All times are in seconds.

| Size | CPU prepare | GPU prepare | GPU prepare from the worker (encode over the port) | CPU build | GPU-decoded pass, 1 build / 12 builds (per build) |
|---|---|---|---|---|---|
| S | 0.63 | 0.02 | 0.03–0.04 (9–12 ms) | 0.25–0.31 | 1.17 / 1.79 (0.15) |
| M | 3.20 | 0.02 | 0.043 (21 ms) | 0.72 | 1.84 / 2.98 (0.25) |
| L | 12.25 | 0.03 | 0.053 (36 ms) | 2.25 | 2.38 / 4.80 (0.40) |
| Lenc (L encoder, S decoder) | 11.48 | 0.03 | — | 0.30 | 1.53 (2 builds) / 2.28 (0.19) |

- The GPU-decoded passes use keep-alive 2–4; without it, ×1 for S is 2.29 s.
- The single-build GPU pass is noisy under the training load: 1.2–5.4 s for S.

**Model time per variant**, in seconds. Each variant is prepare + 5 search builds + 12 candidates (§5.3). The analyse, critic and describe phases (≈ 2.6 s here) come on top.

| Size | D0: CPU only | **D1: GPU encoder + CPU builds (built)** | D3: D1 with the candidates batched on the GPU decoder | D4: every build GPU-batched (search ×3 + ×2, candidates ×12) |
|---|---|---|---|---|
| S | 4.9 | 5.2 | 3.4 | 4.3 |
| M | 15.7 | 12.2 | 6.6 | 7.0 |
| L | 50.4 | **38.4** | 16.1 | 10.5 |
| Lenc | 16.5 | **5.2** | 3.8 | 5.4 |

## Why not the other designs

- **The hidden renderer runs the whole generator** (the task's first idea). Rejected for two reasons:
  - `analyzeChart` blocks a renderer. The vendored MinaCalc glue sees `window`, takes its web path, and froze the page: an 8 s timer never fired.
  - The job code needs Node built-ins. Electron 38 does load it with `nodeIntegration` (`require(esm)` works), but only at the cost of a Node-enabled renderer.
  - It would also not help: the cost is in the decoder, below.
- **Decoding beat by beat on the GPU.** Each beat needs the rows sampled for the beat before it, and the sampling needs the playability guard, which is JS and decides per slot. So one build is 701 strictly sequential CPU ↔ GPU round trips.
  - That costs 1.7–3.4 ms per beat for one build, depending on size, which is more than the CPU decoder costs for S and M.
  - It only wins when ≥ 3 builds decode together (D3, D4). That needs async, concurrent builds in the generator (G), and run from the worker it would add two process hops per beat.
  - The kernels, the batching session and their tests are here (`createGpuDecodeSession`, `decoderShader`); generation does not use them.
- **Moving the guard and the sampling to the GPU.** That would duplicate the generator's guard, contexts, part boundaries and seed streams in WGSL, a second copy of G's logic that must never drift. Not done.

## For the other streams

- **G3:** route nn-v2 through stream W's helper.
  - In `sourceFor(model, opts)`, return `infillSourceFor(opts.nnBackend)` from `src/gen/nn/webgpu/gpuSource.js` for an nn-v2 model.
  - Write `await source.prepare(…)`. The GPU source is async; awaiting the CPU sources changes nothing.
  - `generatorJobs` already passes `opts.nnBackend` for nn-v2 models when the GPU is there.
- **N:** for M and L, scale the encoder and keep the decoder and lane head at S size (`dec_d` 64 × 2, `lane_hidden` 64). That is "Lenc" above.
  - The L of `sizes.json` (`dec_d` 160 × 4) costs 2.25 s per build on the CPU, and no GPU design measured here brings it near 2 s per variant.
  - Exports must keep their 3 parity probes: the GPU checks them at load.
- **G5:** a worker pool for the candidates turns Lenc's 12 candidate builds into about one build of wall time. Projected: 0.03 + 5 × 0.31 + ≈ 0.3 ≈ **1.9 s** per variant, model time.
- **U** (model-strength picker): `generator-info` → `modelInfo.gpu` = `{ gpuAvailable, adapter, reason, decoder }`. The tables above are the first estimates per size.
  - On this machine the adapter's name is "nvidia blackwell". Chromium does not give the marketing name.
- **Critic stage 1 on the GPU** (§11): not done. Stage 1 is ≤ 10 ms per candidate on the CPU, less than one GPU round trip.

## Files

- **New:**
  - `src/gen/nn/webgpu/`: `wgsl.js` (kernels), `infillGpu.js` (upload, encoder, decoder kernel, lane-head split), `gpuSource.js` (sources, decode session, `infillSourceFor`), `gpuProbe.js`, `gpuServer.js`, `gpuClient.js`.
  - The hidden page: `app/gpuWorker.html`, `app/gpuWorker.js`, `app/gpuWorkerPreload.cjs`.
  - `app/gpuWorkerHost.js` (main process) and `app/gpuWorkerLink.js` (the worker's side).
- **Hooks in other streams' files**, each one small and commented:
  - `app/generatorJobs.js`: an `nnBackend` option. It is asked for only when the model is nn-v2; otherwise `opts` is unchanged.
  - `app/workerClient.js`: `setGpuPortHook` and `{ gpuPort: true }`.
  - `app/analysisWorker.js`, inside the create block: the link, plus the `gpu` and `nnBackend` options.
  - `app/createIpc.js`: `registerGpuWorkerHost(deps)` and `modelInfo.gpu`.
  - `src/gen/nn/infillModel.js`: `prepare({ encoded })`, `createDecoder` using a given `e2d` and `cross`, exported `pickRow` and `createHistory`.
- **Tests:**
  - `tests/gen/nn/webgpu.test.js`. Its GPU test skips under Node.
  - `tests/gpuWorker.test.js`.
  - `tests/helpers/fakeGpu.js` (a CPU stand-in for the GPU).
  - Electron: `tests/smoke/electron-webgpu.mjs` (parity, with `tests/gpu/webgpuSuite.js`) and `tests/smoke/electron-gpu-link.mjs` (the real worker ↔ GPU path).
  - Bench: `tools/bench-gpu.mjs` with `tests/gpu/webgpuBench.js`.

## Commands for after training

None of these is in `npm test`, because each needs the GPU.

```bat
rem every trained candidate's parity probes on this GPU (app path and all-GPU)
set LUNACY_MODEL_DIR=A:\SneezeyTrain\candidates&& npx electron tests\smoke\electron-webgpu.mjs A:\Temp\webgpu-smoke
rem the real worker → GPU path with a trained model (encode time, rows equal to the CPU)
npx electron tests\smoke\electron-gpu-link.mjs A:\Temp\gpu-link --model A:\SneezeyTrain\candidates\mapper-nn2-l.json
rem the timing tables (random weights; time does not depend on them); about 5 minutes
npx electron tools\bench-gpu.mjs --sizes S,M,L,Lenc --keep-alive 0,2,4 --out A:\Temp\bench-gpu
```
