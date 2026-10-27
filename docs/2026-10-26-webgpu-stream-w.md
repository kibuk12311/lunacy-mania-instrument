# Stream W: nn-v2 on WebGPU (ML addendum §11)

- **Date:** 2026-10-26 (night run). Branch `w3b/w`, on `feature/v3` 10bcfb3 + `w3b/p` (P-ml1).
- **Machine:** RTX 5080 (Blackwell), Electron 38.2.0 (Chromium, Dawn on D3D12, shader compiler FXC `d3dcompiler_47.dll`), Node 22.19 inside Electron.
- **Load while measuring:** the training chain was running (a CUDA job on the same GPU at ~27 %, a long dataset job on the CPU). Plain-JS matvec measured 1.6–2.1 GFLOP/s against §0's 2.9–3.9, so every CPU number below is pessimistic by up to ~2×. The GPU latencies may be worse than on an idle GPU too.
- **2026-10-27:** D3 and D4 are built (branch `feature/gpu-batch`, from 0.10.2): builds that can step together decode on the GPU, one request per beat for all of them. See [Batches of builds on the GPU decoder](#batches-of-builds-on-the-gpu-decoder-d3--d4-built-2026-10-27); the decision below is updated, the 2026-10-26 sections are kept as they were measured. Before 0.10.3 shipped, the rule for when batches pay was reworked: one slow round could turn them off for the session, and L's candidates could batch past the point where they cost more than 0.10.2's deadline (see [The rule, measured](#the-rule-measured-2026-10-27)).

## Decision

**The GPU runs the encoder and the decoder's static K/V. Where two or more builds can step together, and it pays for the model on this machine, the GPU also runs their decoder, one request per beat for all of them (D3 + D4, 2026-10-27). The lane head's last layers, the sampling and the playability guard stay in JS, in the utility worker.**

- The hidden GPU renderer is a compute server for the generator worker. The generator itself does not move.
- The capability flag is `{ gpuAvailable, adapter, reason, decoder: "cpu" }`.
  - It appears in generator-info as `modelInfo.gpu`.
  - `decoder: "cpu"` still holds for a build on its own; the batches are decided per variant (`gpuBatch.js` `pays()`), not by the capability.
  - `modelSize: "auto"` uses it through `gpu()`. That flag is true only when the decoder runs on the GPU as well, so "auto" stays on the CPU sizes for now. The reason: L with only the encoder on the GPU costs 38 s per variant here, and §11 wants auto to be "the strongest size within budget".
- **The §11 budget is not met.** It asks for ≤ 2 s per variant for L.
  - Measured with D1 on 2026-10-26: **38.4 s per variant for L** (4-minute song, prepare + 5 search builds + 12 candidates, model time only).
  - Measured with D4 on 2026-10-27, a real variant (the whole search, 12 candidates, the block retry): **8.9 s** against 28.3 s with D1 on the same machine and song; a whole generate-map job with L and 12 candidates takes 9.0 s instead of 14.1 s (and 0.10.2 built only 5 of the 12 by its 4 s deadline); 8.6 s with the reworked rule ([measured](#the-rule-measured-2026-10-27)).
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

## Batches of builds on the GPU decoder (D3 + D4, built 2026-10-27)

- **Machine and load:** the same RTX 5080; a model comparison (`node tools/compare-mappers.mjs`, BelowNormal) on the CPU the whole time, another agent's Electron smoke tests now and then; nothing else on the GPU. nvidia-smi reads 11–13 % with the app idle. Every timing below alternates the old and new code in one process, three times; the tables give medians.

### How it runs

```
utility worker (generator)                                   hidden GPU renderer (gpuServer.js)
  prepare: encode(model, inputs, { keep: true })  ────────▶  encoder + static K/V; keeps them on the GPU: session id
           ◀── e2d, cross (for the CPU decoder), session
  a batch of n builds, per beat:
    each build steps until its slot needs the next beat ─┐
    decode(session, { ops, items: n × { ref, b0, n, rows } })  ──▶  ring copies/frees, then ONE dispatch for the n
           ◀── per item the 8 lane bases of its last beat              builds (one workgroup each), last beat read back
    each build: lane head (history + head2 + head3), pickRow, guard, on to its next wait
  end of the variant: release(session)  ───────────────────▶  buffers and rings freed
```

- **One round trip per beat per batch.** A request carries the beats of every waiting build; builds that skip ahead over known or fixed rows ask for several beats in one item. Snapshots are ring copies inside the next request (`ops`), so they cost no round trip of their own.
- **The generator** (`generateLearned.js`): a build is a generator over a row source (`buildSteps`). On `prep` (the CPU source) it never waits, so `build()` runs it to the end, exactly the old code path. On a batch stream, `step()` answers `STEP_WAIT` when its beat is not decoded yet; the build yields and the batch resumes it with the row. What runs together:
  - the candidates: all n − 1 rebuilt ones in one batch (D3), when that is not slower than building them one by one by the deadline (below);
  - each search step (`searchSteps.js` `prefetch`): the coarse scan with the reseeds of its knobs, both ways of two bisection steps with their reseeds, the nudges, a reseed round. The search asks for the same evaluations in the same order as before and takes them from those builds; the progress events and the 30 s targeting budget are untouched;
  - a weak block's 4 retry candidates;
  - the snapshots the own-range parts and the block retries resume from, taken on the GPU (one dispatch over every beat before the block).
- **Sampling stays in JS.** The GPU gives, per beat and lane, the lane head's first layer without the history; the history, head2, head3, `pickRow` and the guard run in the build's own code with its own seeds, contexts and echo rows. Nothing about the sampling moved to WGSL.
- **When batches pay** (`gpuBatch.js` `pays()`, decided per variant; reworked for 0.10.3, [measured below](#the-rule-measured-2026-10-27)): the GPU must decode a build's beat faster than the CPU decoder does, i.e. a one-beat round must cost less than K beats of the CPU decoder.
  - **K** is how many build-beats a round of this model's batches decodes, in one-beat rounds' worth of GPU time: a round serves several builds, and builds that skip over fixed rows or restore a snapshot decode many beats in one item. It is learnt from each variant that batched to its end, the median of the last 3 variants: its build-beats over its rounds, where a one-beat round counts as one whatever it took and a round that decodes more beats counts one plus its extra beats at what an extra beat costs. That cost is measured against the one-beat rounds of the same moment, the median over the extra beats, at most a round. So a stall or a GPU busy for a few seconds shows in the round's cost while it lasts, not in K. Timing the variant's whole decode against the round at its end did let it into K: one 1.5 s round, or a few seconds of 20 ms rounds, gave a K too low for any later probe to pass, and batches stayed off for the session. Here: 18–19 for M, 11 for L, about 15 for S (measured with the earlier formula; on a steady GPU the two give about the same K, a stall only lowered the earlier one). Before a model's first batch K is 19 and the round 3 ms, which leaves S on its CPU decoder and lets M and L batch. One fixed 19 (0.10.3 before this) let L batch up to rounds of 24.7 ms, about twice its break-even.
  - **The round** is the mean of the last 64 one-beat rounds without their slowest and fastest 8 (never a session's first, which may wait for the kernel's compile). Up to 8 stalls do not move it; a GPU slow for a stretch does. The average of every round used before (α = 0.05) let one 40 ms round, 3 rounds before the end of a batch, turn M's batches off for the rest of the session. It is a mean, not a median, because a batch costs the sum of its rounds: S's rounds come at two speeds (≈ 0.8 and ≈ 3 ms), and a median took the faster one and priced S's candidate batch at 0.85 s when it took about 2.
  - **The CPU beat** is timed in every variant: 8 beats past the attention windows, one pass of 40 beats (two in a model's first variant), ≈ 50 ms for L. The value used is the median of the last 5. One probe varies by ±25 % with the machine's load (M 0.30–0.50 ms here), and a model's first probe runs beside the GPU renderer's compile of its kernel (L 1.9–2.4 ms instead of ≈ 1.3).
  - **Coming back:** once batches are off by what was measured (not by the prior), the next variant probes. Its first 40 one-beat rounds, at most 400 ms of decoding, run on the GPU again and decide by themselves.
    - If they still do not pay, that batch goes on on the CPU, as after a failure, but the GPU is not marked failed. The next probe then waits 1, 2, 4, then at most 8 variants.
    - If they pay, the variant batches, and a variant that pays clears the wait.
    - A slow GPU therefore pays at most about 400 ms per probe.
  - Fewer than 2 builds, or a variant whose batch failed: the CPU decoder (D1), as before.
- **The candidates** batch only when that is not slower than building them one by one by the deadline (`candidates.js`, `gpuBatch.js` `estimate()`). A lockstep batch takes its rounds × (round + each build's JS) whatever its size, so the 4 s deadline cannot cut it short. The fixed ratio above let L's candidate batch run up to 24.7 ms rounds, far past this point.
  - The estimate is made from the learnt costs before the batch starts. The batch's time is one round per beat a build waits at. One build on the CPU decoder is every beat up to its last slot × the CPU beat, plus its whole lane head and the same JS (≈ 5 % short of a real build for M).
  - The batch goes when its time is at most what 0.10.2's loop would take (`stageMs`: ⌈deadline / build⌉ builds, at least 3, at most n − 1). Otherwise the loop runs, exactly as without a GPU.
  - Here that keeps every L and M job's 12 candidates in one batch, and moves them to the loop once rounds are ≈ 1.4× this GPU's.
- **Failures.** A GPU error, a lost device, a closed port, an answer of the wrong shape or no answer (5 s; 60 s for a session's first round, which may wait for the decoder kernel's compile) during a batch: every stream of it replays its rows on `createDecoder` and the batch finishes on the CPU. For the candidates it finishes only as many as the 4 s deadline would have built; for a search step it gives up the speculative builds (the search builds what it asks for, one by one). The rest of that variant builds on the CPU; the next variant tries the GPU again. A build that throws fails the batch with its own error (its streams are freed, nothing hangs). An abort signal ends a batch at the next beat. A worker that goes away takes its sessions with it on the GPU side where its port reports the close; either way the server keeps at most 3.
- **A bug found on the way:** `decoder().copy(from, to)` copied within one buffer, which WebGPU refuses with a validation error and nothing copied. Every snapshot restored on the GPU then decoded from a stale ring (Δ logit up to 2.1, half the rows different). The copy now goes through a scratch ring, a failed copy fails its request (an error scope around the ring ops), and `tests/gpu/webgpuSuite.js` checks a copied ring decodes exactly as the original (Δ = 0 on S, M and L).

### Measured

**Parity** (`npx electron tools/bench-gpu-batch.mjs --parts parity`): the shipped models; 4 builds of a whole song in one batch against the CPU decoder teacher-forced over each build's own rows, and the same seeds' rows on the CPU (offset 0, no guard); then whole variants (4 candidates, repeats, the real analyser and critic) on the CPU and through the batches.

| Model | max \|Δ logit\|, batch builds (click track 174 BPM / six-part song 160 BPM) | restored from a GPU snapshot halfway | rows differing, batch builds vs CPU | whole variants vs the CPU's map |
|---|---|---|---|---|
| S | 1.1e-5 / 9.7e-6 | 8.7e-6 | 0 of 9656 + 0 of 2760 | the same map on both songs (every batch on the GPU) |
| M | 1.3e-5 / 1.0e-5 | 7.5e-6 | 0 of 9656 + 0 of 2760 | the same map on both songs |
| L | 7.8e-6 / 7.6e-6 | 6.1e-6 | 0 of 9656 + 0 of 2760 | the same map on both songs |

- The tolerance is 2e-3 (the models' own parity probes). Before the ring-copy fix the whole variants differed (64 and 154 rows for L), all of it from the restored snapshots.

**Model time per variant**, seconds (prepare + builds + snapshots, `debug.timing`), the 4-minute A B A B' C song at 175 BPM (701 beats, 3091 slots) with its stems, range 7–9, repeats on, the real analyser and critic, every candidate built (deadline off). D1 is this branch's code with a backend that only encodes, which is 0.10.2's path: its total time equals 0.10.2's own code run beside it (last column).

| Model, candidates | D0: CPU only | D1: GPU encoder, CPU builds | **D4: batches on the GPU** | GPU % (nvidia-smi mean / p90), D4 | total time, 0.10.2 / D1 / D4 |
|---|---|---|---|---|---|
| L, 12 | 40.6 | 28.3 | **8.9** (3.2×) | 34 / 61 | 29.6 / 29.6 / 10.3 |
| L, 1 | 17.9 | 8.5 | **3.6** (2.4×) | 31 / 28 | 9.0 / 9.0 / 4.2 |
| M, 12 | 24.3 | 18.3 | **9.5** (1.9×) | 34 / 62 | 19.9 / 20.1 / 11.2 |
| M, 1 | 14.2 | 10.0 | **5.8** (1.7×) | 34 / 56 | 10.8 / 10.6 / 6.4 |
| S, 12 | 6.1 | 4.6 | 4.5 (no batches: they would take 5.8) | 12 / 14 | 6.0 / 6.0 / 5.9 |
| S, 1 | 4.4 | 3.2 | = D1 (they would take 3.5) | 12 / 13 | 4.0 / 3.8 / = D1 |

- nvidia-smi reads 11–13 % with nothing running; D1 never moves it. With batches the GPU decodes 1650–2000 rounds a variant, 4.3–4.5 ms each for M and L (3.0 for S), up to 11 builds a round.
- **The whole job**, through the real `app/analysisWorker.js` (GPU host, port, generatorJobs, dan targeting): L, 12 candidates, the app's 4 s candidate deadline, the same song: **9.0 s** median against **14.1 s** for 0.10.2's worker beside it, and every one of the 12 candidates built (0.10.2: 5). GPU 29 % mean (0.10.2: 13 %).

**The round trip** (`rtt` in `tests/smoke/gpuBatchWorker.mjs`: decode rounds alone, back to back): S 0.97 ms median (the renderer's part 0.7), L 3.5 ms (3.3); flat from 1 to 12 builds. Between real rounds the worker runs the builds' JS, and a round then costs 3.0 (S) to 4.5 ms (L). L's round is mostly the kernel: one workgroup per build walks 4 layers of 160-wide matvecs with loads it cannot overlap (no unrolling, so FXC compiles it in seconds); a faster kernel (4-way unrolled inner loops, or several threads per output) is the next thing to try, and the round trip sets the floor for S and M.

**Measuring pitfall:** in a process that had run the CPU encoder (a CPU-only variant, the parity checks), D1 builds came out ~25 % slower than 0.10.2's code beside them, and the same as it in a process that had not (both measured three times). Most likely V8: `encodeBeats` hands `matvec` a `Float64Array` (the condition vector), which makes the inner `dot` that the decoder shares polymorphic; 0.10.2's code has the same, it just ran in its own copy of the modules there. The bench therefore runs its CPU-only variants in a process of their own. The app's worker runs the CPU encoder only when the GPU's encode failed.

### The rule, measured (2026-10-27)

**Every decode round traced**, one variant per model: 12 candidates, the 4-minute song, the app's 4 s deadline, through the real worker ↔ GPU path. The harness was a scratch copy of the bench worker that times each `decode`. CPU beats come from `pays()`'s own probes.

| | S | M | L |
|---|---|---|---|
| one-beat round, ms: trimmed mean (median; p10–p90) | 2.1–2.4 (1.25–2.95; 0.7–4.3) | 3.5 (3.5; 1.3–4.4) | 3.65 (3.6; 3.0–4.6) |
| GPU time per further beat in one item, ms | 0.09 | 0.15 | 0.24 |
| CPU decoder beat, ms (one probe; it varies with the load) | 0.13–0.28 | 0.30–0.67 | 1.13–1.9 |
| a build's JS between two rounds, batch path, ms | 0.04 | 0.05–0.08 | 0.11–0.15 |
| K learnt (it follows the songs: the parity part's short songs give less) | 11–15 | 10–19 | 7–11 |
| the 11 candidates: one batch vs one by one by the 4 s deadline | 2.25 s vs 1.86 s (12 built) | 2.9 s vs 4.26 s (12 built) | 3.3 s vs 4.54 s (5 built) |
| the same, estimated before the stage (`estimate()`, `stageMs`) | | 2.9–3.0 s vs 3.1–4.1 s | 3.2–3.3 s vs 4.1–4.9 s |

- **Where the candidates move to the loop:** about 1.4× this GPU's round, for both L and M (≈ 5 ms). Below that the batch is the faster stage and builds all 12; above it, 0.10.2's loop is.
- **Where L's search steps stop paying:** K × the CPU beat, 9–21 ms here depending on K and the CPU's load. With the fixed 19 the limit was 24.7 ms, while L's break-even on this song is ≈ 11–13 ms.
- **S** stays on its CPU decoder in the app: before any batch its prior says no, and nothing else teaches it rounds. A batch that always goes, or a direct `prep.batch.run`, does teach it. The bench's parity part does exactly that, and after it S's batches go by its measured costs, which are about even here (below).

**The bench** (`npx electron tools/bench-gpu-batch.mjs --sizes s,m,l --parts parity,time,e2e --repeats 2 --candidates 12,1 --modes d1,batch`), on the final code.
- The CPU was busier than in the morning's run: D1 is 25–30 % slower than in the first table.
- Model time per variant, in seconds; every candidate built (deadline off).
- Parity is as above: max |Δ logit| 1.1e-5 (S), 1.3e-5 (M), 7.8e-6 (L), no row different, the same whole variants.

| Model, candidates | D1 | **batches** | batched | learnt at the end: round ms / K / CPU beat ms |
|---|---|---|---|---|
| L, 12 | 36.4 | **9.1** (4.0×) | both repeats; the 11 candidates in one batch (estimate 3.4 s against 17 s one by one) | 3.5 / 7.2 / 1.9 |
| L, 1 | 11.0 | **3.7** (2.9×) | both repeats | 3.55 / 10.6 / 1.6–1.9 |
| M, 12 | 22.5 | **9.6** (2.3×) | both repeats; the candidates in one batch (2.9–3.0 s against 5.3–6.0 s) | 3.4–3.6 / 10.2 / 0.55–0.61 |
| M, 1 | 12.4 | **5.9** (2.1×) | both repeats | 3.6 / 17.5 / 0.43–0.67 |
| S, 12 | 5.6 | 5.9, then 5.5 | the first variant batched (5 % slower); the next one's probe turned batches off | 2.5 / 12 / 0.14 |
| S, 1 | 4.0 | 3.6 | both repeats (10 % faster; the CPU beat was 0.26–0.28 ms then) | 2.0–2.3 / 12.5 / 0.26–0.28 |

- **The whole job** (L, 12 candidates, the 4 s deadline; `--parts e2e --sizes l --repeats 3` on its own): **8.6 s** median (8.55–8.81 s), all 12 candidates built every time, GPU 34 % mean.
- **Measuring pitfall:** in the run above, with sizes in the order s,m,l, the e2e jobs took 28 s with 4 candidates and an idle GPU. The cause is not the rule. The bench worker had loaded S, M and L as `m1`, `m2`, `m3`, and the e2e worker's `gpuClient` named its own L `m1` too, while the GPU server keeps one model table for every port. Its encode therefore ran on S's weights and came back with S's shapes, failed the shape check, and the variant fell back to the CPU encoder with no batches. The order l,m,s (the command at the end) hides it, because both workers' `m1` is then L. In the app the same happens whenever a respawned generator worker's first model differs from the old worker's first model; a model of the same size would even pass the shape check with the other model's weights. Fixed in 0.10.3: `gpuClient.js` puts a prefix of its own on each key (`c….m1`), and `gpuServer.js` unloads a port's models when that port closes, so a replaced worker's models do not stay on the GPU (tests/gen/nn/webgpu.test.js, "each worker's models are its own"). Since the fix the order of sizes no longer matters.

## Measured (2026-10-26, D1)

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
- **Decoding beat by beat on the GPU, one build at a time.** Each beat needs the rows sampled for the beat before it, and the sampling needs the playability guard, which is JS and decides per slot. So one build is 701 strictly sequential CPU ↔ GPU round trips.
  - That costs 1.7–3.4 ms per beat for one build, depending on size, which is more than the CPU decoder costs for S and M.
  - It wins when several builds decode together: that is D3 + D4, built on 2026-10-27 (above), with one round trip per beat per batch from the worker.
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
- **U** (model-strength picker): `generator-info` → `modelInfo.gpu` = `{ gpuAvailable, adapter, reason, decoder }`. The D4 table above is what each size costs a variant with the GPU now (L 8.9 s, M 9.5 s, S 4.5 s with 12 candidates).
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
- **D3 + D4 (2026-10-27):**
  - `src/gen/nn/webgpu/gpuBatch.js` (new): streams, the lockstep runner, the CPU fallback, `pays()`.
  - `gpuServer.js` / `gpuClient.js`: `encode` with `keep`, `decode`, `release`, sessions per port; `infillGpu.js`: `run(list, { last })`, `warmDecoder()`, the scratch-ring copy, `createKeepAlive`, 64 rings; `gpuSource.js`: `prep.batch` and `prep.release()` when the backend decodes.
  - `src/gen/generateLearned.js`: `buildSteps` (the build as a generator), `buildMany`, the searches' prefetch, the candidates' and the block retry's batches, GPU snapshots, `debug.timing` / `debug.batch`; `src/gen/searchSteps.js` (new): `searchKnob` and `searchRange` with `prefetch`, and `bisectionKnobs` — `search.js` keeps its own copies unchanged, because it is part of the analyzer's fingerprint (the analysis imports `NAME_FAMILY` from it) and an edit there would redo every saved analysis after an update; `tests/gen/searchSteps.test.js` holds the two to the same evaluations (480 random searches); `src/gen/candidates.js`: `buildMany`; `src/gen/rowSources.js`: the flavour wrapper on batch streams.
- **Tests:**
  - `tests/gen/nn/webgpu.test.js`. Its GPU test skips under Node.
  - `tests/gpuWorker.test.js`.
  - `tests/helpers/fakeGpu.js` (a CPU stand-in for the GPU).
  - Electron: `tests/smoke/electron-webgpu.mjs` (parity, with `tests/gpu/webgpuSuite.js`) and `tests/smoke/electron-gpu-link.mjs` (the real worker ↔ GPU path).
  - Bench: `tools/bench-gpu.mjs` with `tests/gpu/webgpuBench.js`.
  - D3 + D4: `tests/gen/nn/gpuBatch.test.js` (lockstep, builds ending at different beats, a build that throws, the GPU failing / not answering / answering wrong, cancellation, snapshots, the protocol's sessions, `pays()`: a stall, a slow stretch, the probes and their wait, K, the CPU beat's median, `estimate()`), `tests/gen/candidates.test.js` (`stageMs` against the loop, the batch or the loop by the estimate), `tests/gen/searchSteps.test.js`, `tests/gen/generateBatch.test.js` (0.10.2's responses bit for bit on the CPU from `tests/fixtures/batchGolden.json`; the same responses and progress through the batches over `tests/helpers/fakeGpu.js` `exactBackend`, also when the GPU fails mid-batch, and when the candidates go one by one by the estimate), `tools/bench-gpu-batch.mjs` with `tests/smoke/gpuBatchWorker.mjs` (parity, timings, the real worker's job, nvidia-smi).

## Commands for after training

None of these is in `npm test`, because each needs the GPU.

```bat
rem every trained candidate's parity probes on this GPU (app path and all-GPU)
set LUNACY_MODEL_DIR=A:\SneezeyTrain\candidates&& npx electron tests\smoke\electron-webgpu.mjs A:\Temp\webgpu-smoke
rem the real worker → GPU path with a trained model (encode time, rows equal to the CPU)
npx electron tests\smoke\electron-gpu-link.mjs A:\Temp\gpu-link --model A:\SneezeyTrain\candidates\mapper-nn2-l.json
rem the timing tables (random weights; time does not depend on them); about 5 minutes
npx electron tools\bench-gpu.mjs --sizes S,M,L,Lenc --keep-alive 0,2,4 --out A:\Temp\bench-gpu
rem D3 + D4 with the shipped models: parity, model time per variant against 0.10.2 (a checkout of it with vendor\ in
rem --old), the real worker's job, nvidia-smi; about 30 minutes
npx electron tools\bench-gpu-batch.mjs --sizes l,m,s --parts parity,time,e2e --repeats 3 --old A:\Temp\lunacy-0.10.2 --out A:\Temp\bench-gpu-batch
```
