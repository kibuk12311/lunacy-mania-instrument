# Map generator v3: ML addendum (wave 3)

- **Date:** 2026-10-25.
- **Extends:** `docs/2026-10-25-mapgen-v3-plan.md` (called "the plan" below; "§n" means a section of the plan).
- **Precedence:** the plan wins everywhere this addendum is silent. Where this addendum changes a contract it says so explicitly, and every change is **additive and optional**: with the new fields absent, v3 behaves exactly as the plan specifies.
  - **One explicit exception:** this addendum supersedes the plan's §13 line "No transformer" for the in-app, pure-JS nn-v2 model only (§4.4, §10). The rest of that §13 line still holds for v3 and for this addendum: no ONNX runtime model, no Python at runtime, no cloud training, no packaging of the corpus or any audio. The only place ONNX may ever appear is the later optional stems module, stream Q, under its own plan (§10.1).
- **Timing:** nothing here starts before wave 2 (streams A1, A2, B, C, running now) has merged into `feature/v3`. No file listed here is edited while wave 2 is running.
- **Parallel plan:** `docs/2026-10-25-tabs-v2-plan.md` ("tabs-v2") is running too. Its frozen and owned files are respected through the contract in §8.1. P-ml does not start before the tabs-v2 integration has merged (W3-0).

User request: «Добавляй всё». That means all eight items:

1. a critic that makes N candidates (10–20) and picks the best;
2. light stems in the app (HPSS plus kick/snare/hat detectors);
3. song structure (repeats and phrases);
4. a small infilling transformer with skillset/dan/family conditioning and native lock-and-regenerate;
5. a "fun" reward model from player data;
6. mapper style conditioning;
7. user ratings in the app, plus a personal reranker;
8. augmentation and data cleaning.

---

## 0. Facts checked while writing this

**Hardware and Python**
- RTX 5080 16 GB (Blackwell, sm_120).
- `.venv` has numpy 2.5.4, scikit-learn 1.9.1 and xgboost 3.4.1.
- **PyTorch is not installed.** `tools/requirements.txt` lists only numpy, pandas, scikit-learn and py7zr. xgboost is installed but not listed; D adds it (§9).
- Torch arrives with D4's `tools/requirements-nn.txt` (cu130 wheels). Task N0 below asserts `torch.cuda.get_device_capability() == (12, 0)` and a bf16 matmul before any training.

**Plain-JS speed on this machine** (Node 24, 16 threads, scratch benchmarks, single thread)
- Dense `Float32Array` matmul (700×96 · 96×384): **2.9 GFLOP/s**.
- Mat-vec 64×256 with 4-way unrolled dot products: **3.9 GFLOP/s**; 160×64: 3.4 GFLOP/s.
- For friends' laptops this addendum budgets **1.0 GFLOP/s**.

**Stems speed**
- STFT of 240 s at 22,050 Hz (frame 1024, hop 512, `src/audio/fft.js`): 190 ms.
- Median filters, naive sort per cell: 2.9 s, which is not usable.
- **Sliding sorted-window median**, kernel 17 in time and in frequency on 256 pooled bins: **220 ms**.
- At hop 256 (the onset envelope's hop) both numbers roughly double, giving about **0.85 s for a 4-minute song** on this machine. That is before the separate chroma STFT, which §2.2 adds (total about 1.1 s).

**Analyser speed:** `analyzeChart` on corpus maps takes 26–217 ms (365–3705 objects, up to 4 min). Budget: 0.25 s per call on this machine, 0.6 s on a laptop.

**Labels we already have**
- `A:/SneezeyTrain/manifest.json` (6147 sets): each diff has tracker `dan`, `primary`, `patterns{}`, `lnShare`, and **an MSD vector** (`Stream, Jumpstream, Handstream, Stamina, JackSpeed, Chordjack, Technical, Overall, LN`). Each set has a `playCount`.
- `analyzeChart` already returns `msd` for any chart through `analyzeEtternaFromText` (8 skillsets, `MSD_KEYS` in `src/core/features.js`). Every map from every source, generated maps included, can get the same MSD labels in JS.

**Corpus state**
- The fetch run has done about 788 of 5651 sets (13.5 GB). osu.direct is rate-limiting it until 00:00 UTC.
- `A:/SneezeyTrain/hf` has 72 sets from `tools/fetch-hf-osu.mjs`.
- `tools/lib/sm2osu.mjs` (an .sm/.ssc → .osu converter that skips stops and warps), `tools/lib/tar.mjs` and `tools/lib/zip.mjs` exist. They are uncommitted and belong to stream D.

**Code seams**
- `envelopeFromTransfer` (in `onset.js`, which is frozen) rebuilds only `values`, `energy` and `bands`. Any extra audio data must travel **beside** the envelope, not inside it.
- `app/generatorJobs.js` loads `MODEL_FILES = ["mapper-nn.json", "mapper.json"]`.
- `slotFeatures(envelope, slots, bpm, names)` already selects columns by name and already knows `AUDIO_FEATURES_V2`.

---

## 1. Where each item plugs in

| # | Item | Runs in | Contract it touches | Seam |
|---|---|---|---|---|
| 1 | Critic + N candidates | worker | §2.2 `request.candidates`; §2.3 `critic`; §2.6 store | new candidate loop in `generateLearned.js`, after the global search and before block retry; scoring in `src/gen/critic.js` |
| 2 | Stems (HPSS, kick/snare/hat) | renderer (on song load) + dataset tool | §2.2 new top-level `stems` beside `envelope` | `src/audio/stems.js`; slot columns by name (§2.8, `AUDIO_FEATURES_V3`) |
| 3 | Structure | worker (prepare) + dataset tool | §2.3 `structure`; §2.7 `prepare({ structure })` | `src/gen/structure.js`; echo copying in `src/gen/echo.js`; phrase-aligned blocks in `assign.js` and `partReport.js` |
| 4 | Infill transformer | worker | §2.7 `prepare({ known, cond })`, `source.caps`; §2.8 `kind: "nn-v2"` | a **row source** (§2.7): `src/gen/nn/infillModel.js` → `infillSource`, picked by `sourceFor(model)` |
| 5 | Fun head | worker | inside `critic` | a head in `models/critic.json`; used for reranking only |
| 6 | Mapper style | worker + UI | §2.2 `request.style`; §2.8 `styles`, `stylePattern` | XGB: per-creator pattern tables; nn-v2: style embedding; critic: style head for reranking |
| 7 | Ratings + personal reranker | main (store) + worker (fitting and scoring) + renderer (UI) | new channels `rate-variant`, `ratings-summary`, `ratings-export`, `generator-info`; worker payload `personal` | `src/gen/personal.js`; a term in the critic blend |
| 8 | Augmentation and cleaning | tools only | none in the app | dataset v3 builder, `train_*.py` |

**The model seam stays the §2.7 row-source interface.**
- Everything that decides rows is either a source (XGB + Markov, nn-v1, nn-v2), the guard (`weightOf`), or rows forced from outside the source: locked rows, and now echo rows.
- Everything that picks between whole maps sits **above** the source: search, candidates, critic, rankVariants.

### 1.1 Contract additions (all optional; absent = v3 exactly)

**§2.2 `generate-map` request**

```js
{ ...v3 fields,
  stems?: StemsTransfer,            // top level, beside envelope (envelopeFromTransfer drops unknown fields)
  request: { ...v3 fields,
    candidates?: int,               // 1..20, default 1 (= v3). N candidates per variant; the critic picks one
    style?: string | null,          // a key of modelInfo.styles; null or absent = no style
    repeats?: boolean,              // repeated sections get consistent patterns; default false here, the UI sends true
  } }

StemsTransfer = { v: 1, hopSec, frameOffsetSec, frames,
  kick, snare, hat, harm, percShare: Float32Array(frames),  // 0..1 curves
  chroma: Uint8Array(frames*12), timbre: Uint8Array(frames*12) }   // quantised 0..255
  // chroma is computed on its own longer window (§2.2) and held over the main frames it covers
```

- **Validation** (`app/createIpc.js`, a P task):
  - `v === 1`;
  - `frames` within ±2 of `envelope.values.length`;
  - every array has the right length;
  - total bytes ≤ 16 MB;
  - `candidates` is an integer from 1 to 20;
  - `style` is null or a key from the loaded model's `styles`.
- **`normalizeRequest`** (`src/gen/request.js`, which the worker re-runs) also learns `candidates`, `style` and `repeats`. That is a G task (G1, G2, G4; §8).
- The renderer **never** sends `personal`, critic weights or deadlines. Main adds them to the worker payload:

```js
worker payload += { personal: PersonalModel | null, deadlineMs: 4000 }   // deadline of the candidate phase only
PersonalModel = { v: 1, names: string[], w: number[], b: number, n: int, weight: number }
```

**§2.3 `generate-map` response**

```js
{ ...v3 fields,
  noteSeed,                          // now the PICKED candidate's seed, so lock and regenerate reproduce the map
  critic?: { kind: "critic-v1" | "heuristic", score, human, fun, play, personal, style,
             picked: int, of: int, analysed: int, ms },          // human/fun/style are null when that head is missing
  structure?: { phrases: [{ startMs, bars }], repeats: [{ aMs, bMs, lenMs, sim }] },   // at most 64 of each
  modelInfo: { ...v3, critic: "critic-v1" | "heuristic" | null, stems: boolean,
               styles: [{ key, name, maps }] } }   // styles is empty when the model has none
```

**§2.6 store entry** adds `critic` (including `features: number[]`, the critic's feature vector, kept for ratings and **never sent to the renderer**), `style` and `candidates`.

**§2.7 row source**

```js
source.prepare({ model, audio, slots, dan, family,
                 known?: Uint8Array,       // per slot: 255 = free, else the LOCKED mask (0..15) there; never echo rows
                 cond?: { msd: Float32Array(8) | null, style: int /* −1 = none */, rate: 1 },
                 structure?: Structure })
step(i, fixed?)                            // fixed: a mask 0..15 decided outside the source for this build (echo rows)
source.caps = { infill: boolean }          // XGB and nn-v1: false (they ignore known/cond/structure/fixed)
```

- `generateLearned.js` still forces locked and echo rows itself, as in §1.11.
- With `caps.infill` it also passes the **locked** rows as `known`, so the model sees the **right-hand** context too. That is what "native" lock-and-regenerate means here.
  - `known` is the same for every search evaluation and every candidate of a variant, so the encoder that reads it runs once per prepare (§5.2).
- **Echo rows are not in `known`.** They depend on `noteSeed_k` and on rows decoded earlier in the same build, so they go per build through `step(i, fixed)`: the source teacher-forces `fixed` into its decoder state, with no sampling and no RNG use. The encoder never sees them; the model links to the source bar through the encoder's echo keys (§4.4) and the decoder.

**§2.8 model JSON**
- New optional keys:
  - `needs: ["stems", "structure"]`: the worker refuses the model when the stems are missing and falls back to the next model file;
  - `styles: [{ key, name, maps }]`;
  - `stylePattern: { [key]: { [family]: table } }`, the same shape as `pattern`;
  - `styleBias: { [key]: number }`, a note log-odds offset;
  - `msdPrior: { bins: number[], families: string[], table: number[][][] }`: the median MSD vector per (dan bin × family);
  - `kind: "nn-v2"` with `arch` and `weights` (§4.4).
- `AUDIO_FEATURES_V3` = `AUDIO_FEATURES_V2` plus 8 stem columns and 6 structure columns (§3.3).
- A new file, `models/critic.json`, is loaded optionally by the worker (§4.1).
- `MODEL_FILES` becomes `["mapper-nn2.json", "mapper-nn.json", "mapper.json"]`.

**New channels** (all `ipcMain.handle`; registered from `registerCreateIpc`, so `main.js` stays frozen; see §8.1 for where their store and paths come from)

| Channel | Input | Output | Owner |
|---|---|---|---|
| `generator-info` | none | `{ ok, modelInfo }` (with `styles` and `critic`) | P |
| `rate-variant` | `{ id, vote: 1 \| -1 \| 0, tags: string[≤4] ⊂ RATING_TAGS }` | `{ ok, n }` | U |
| `ratings-summary` | none | `{ ok, n, up, down, active: boolean, auc: number \| null }` | U |
| `ratings-export` | none | `{ ok, file }`: a JSON file in `docsDir`, never overwritten | U |

**Progress (§2.4):** new phases `"candidates"` (with `i`, `n`) and `"critic"`.

---

## 2. Item by item

### 2.1 Critic and N candidates (item 1)

**Where the loop goes in the A2.10 pipeline:** after step 5 (global search) and step 6 (dan retry), **before** step 7 (block retry).
1. Take the search's best knob. Candidate `k = 0` is the search's best map itself, so `candidates: 1` is v3 bit for bit.
2. Candidates `k = 1..N−1` rebuild with `noteSeed_k = deriveSeed(noteSeed, 0xC0DE, k)` at the same knob.
   - Parts with their own range keep their frozen rows (A2.10 step 4).
   - Locked rows stay forced.
3. **Stage 1 (cheap, every candidate):** `criticFeatures(rows, slots, audio, stems, structure)` and then `critic.score(features, { style, personal })`.
   - This stage runs no `analyze`. It is time-boxed by `deadlineMs`, and at least 4 candidates are always built.
4. **Stage 2 (top K = 3 by stage 1):** one `analyze` each. Order:
   1. in range;
   2. `patternScore` rounded to 0.05;
   3. stage-1 score plus `0.5 · msdFit`, where `msdFit = −‖msd − msdTarget‖₂ / 3` and `msdTarget = msdPrior(dan mid, families)`;
   4. fewer issues.
   - `msdPrior` exists only in a model that carries it (xgb-v3, E4). With a model without `msdPrior` (B0's v1 or v1.5), `msdFit` is null and the term is 0, so stage 2 orders by in range, `patternScore`, stage-1 score and issues. The JS lookup is `src/gen/msdPrior.js` (G, §8).
5. If no analysed candidate is in range and the search best was, the search best wins. **The critic never trades away the dan.**
6. Block retry and describe run on the winner. Block-retry candidates are also scored by stage 1, with weight 0.1 next to `patternScore`.

**Score blend (stage 1)**

```
s1 = zH + wF·zF + wP·P + wU·zU + wS·logPstyle
```

- `zH` is the logit of the human head, standardised on held-out human maps.
- `zF` is the fun head's z-score.
- `P = −issuesPer1000/10 − forcedPer1000/20`, using A2's `findIssues` and the guard's `forced` count.
- `zU` is the personal reranker (§2.7).
- The weights live in `critic.json.blend` and are tuned on validation songs (task R4), not hard-coded.
  - Starting values: `wF = 0.15`, `wP = 1`, `wU = 0` until a personal model is active, and `wS = 0.5` only when a style is chosen.

**Without `critic.json`** the worker uses the heuristic critic (`kind: "heuristic"`): `s1 = wP·P` plus `msdFit` in stage 2 when the model has `msdPrior`. This lets the loop ship before any model is trained, if it passes the ship rule (§7).

**rankVariants (A2.9)** gets one new level, between `patternScore` and issues: `critic.score` rounded to 0.25. It applies only when both cards have a critic.

**Cards.** Each card is already the best of N, so the renderer's outer loop (B7) makes **2** cards instead of 3 when `candidates > 1` (`CARDS_WITH_CRITIC = 2`, one constant). «Ещё вариант» is unchanged. *Decision for the user: 1, 2 or 3 cards. The default is 2.*

### 2.2 Stems (item 2)

**Algorithm** (`src/audio/hpss.js` and `src/audio/stems.js`, plain JS, used by the renderer and by the dataset tool)
1. STFT over the same mono 22,050 Hz samples the renderer already has: frame 1024, hop 256, Hann window, `fft.js`. Frames are aligned exactly like `onsetEnvelope`: frame f is at `(f·256 + 768)/sr`.
2. Magnitudes are pooled to 256 bins (pairs of bins).
3. HPSS (Fitzgerald):
   - `H` = median over 17 frames (about 200 ms) per bin;
   - `P` = median over 17 bins per frame;
   - both use the sliding sorted-window median (§0);
   - soft masks `Mh = H²/(H²+P²+ε)` and `Mp = 1−Mh`.
4. **Percussive detectors:** positive log-flux of `Mp·S`, measured in three bands:

   | Detector | Band | Notes |
   |---|---|---|
   | **kick** | 40–150 Hz | |
   | **snare** | 150–400 Hz and 1.5–5 kHz | its own flux needs both bands up within ±1 frame |
   | **hat** | 5–10 kHz | |

   Each curve is normalised by its P99 over the song, then clipped to [0, 1].
5. **Harmonic:**
   - `harm` = positive log-flux of `Mh·S` over 100 Hz–5 kHz, which picks up melodic note onsets;
   - `chroma` = 12 pitch classes, L2-normalised per frame. The main STFT is too coarse for it (21.5 Hz bins, 43 Hz after pooling, while a semitone at 110–500 Hz is 6–30 Hz), so chroma has **its own STFT**:
     - frame 4096 (5.4 Hz bins, **unpooled**), hop 2048 (about 93 ms), Hann, the same samples and `fft.js`;
     - bins mapped by frequency to pitch classes over **130 Hz–5 kHz** (C3 up; below C3 a semitone is narrower than about 1.5 bins);
     - harmonic weighting: each bin is multiplied by `Mh` interpolated to that grid (nearest main frame, the pooled bin that holds the frequency);
     - each chroma frame is held over the 8 main frames it covers, so `StemsTransfer` keeps one chroma row per main frame;
     - extra cost: about 2.6k FFTs of 4096, about 0.6 of the main STFT's work, roughly **+0.25 s** for 4 minutes on this machine;
   - `timbre` = the DCT (coefficients 1–12) of 24 log band energies of `S`.
   - `percShare = ΣP² / (ΣH² + ΣP²)` per frame.
6. `stemsToTransfer` and `stemsFromTransfer` quantise chroma and timbre to `Uint8`. Size: about 20.7k frames × 44 B, roughly 0.9 MB for 4 minutes.

**Time:** STFT about 0.38 s + medians about 0.44 s + chroma STFT about 0.25 s + detectors ≈ **1.1 s for a 4-minute song** on this machine. The target is **≤ 1.2 s** here and ≤ 3.3 s on a laptop.

**Where it runs**
- In `createTab.js`, right after `onsetEnvelope` on song load. It is chunked with a yield every 2048 frames so the status «Разбираем звук на партии…» can paint. Wiring this call is task U0 (§8).
- The dataset builder calls the same function on the ffmpeg-decoded samples, so training and inference use the same code. Decoder differences (Chromium vs ffmpeg resampling) are checked in task S1 (curve correlation ≥ 0.97 on 10 songs).
- Demucs is **not** part of this addendum. High-quality separated stems are a **later optional download**, stream Q, outside this addendum's scope; the seam is described in §10.1.

**Slot columns** (`slotFeatures`, by name): `kick`, `snare`, `hat`, `harm`, `perc_share`, `kick_share`, `snare_share`, `hat_share`.
- The first five are sampled at the slot like `onset`, through `strengthsAt`.
- `*_share` is the value divided by the beat maximum of that curve, like `beat_share`.

**Old models never ask for these columns,** so their rows stay bit-identical. That is tested.

### 2.3 Song structure (item 3)

**`src/gen/structure.js`** runs in the worker during prepare, after `slotsForTiming`.

1. **Bars:** `barsOf(slots)` from A2's `songParts.js`.
2. **Bar vector:** mean chroma (12), mean timbre (12), and a percussive pattern of 12 values (kick, snare and hat at the 4 quarter positions of a beat, averaged over the bar). Each block is z-scored per song, and the blocks are weighted 1 / 0.7 / 0.7.
3. **SSM:** cosine similarity between bars. At ≤ 300 bars that is at most 90k cells.
4. **Repeats:**
   - for each lag L ≥ 4 bars, smooth the diagonal with a 4-bar box;
   - keep runs above τ (start at 0.75, tuned in S2 with `tools/eval-structure.mjs`) of at least 4 bars;
   - pick them greedily without overlap, longest first, and snap lengths to a multiple of 4 bars when within 1 bar.
   - Output: `repeats: [{ a, b, len, sim }]` (bar indexes) and `echoOf: Int32Array(bars)`, the matching earlier bar or −1.
5. **Phrases:**
   - Foote novelty with a checkerboard kernel of 8 bars;
   - the 4-bar grid phase φ ∈ {0..3} that maximises novelty at grid lines plus part starts (from `detectParts`) wins;
   - phrases are 4 bars, merged into 8 when the novelty at the mid line is below the median;
   - every part start is a phrase start.
6. **Slot columns:** `phrase_pos` (0..1 inside the phrase), `is_phrase_start`, `bar_in_phrase`, `has_echo`, `rep_sim`, `novelty`.

**What it does to generation** (in G, only with `request.repeats`)
- **Families.**
  - In mixed mode, `assignByParts` switches families only at phrase starts: the 32-slot chunk becomes a phrase.
  - A repeated part takes the family plan of its first occurrence.
  - `planBlocks` cuts blocks at phrase starts. The 32-slot minimum and the merging rule stay.
- **Echo rows** (`src/gen/echo.js`).
  - For a bar with `echoOf ≥ 0` whose source bar has already been built, copy its rows onto the same beat and phase.
  - Bars on a grid the source does not have are re-sampled.
  - Then a variation pass re-samples whole bars through the source:
    - always the last bar of each 8-bar phrase (the "fill bar");
    - each other echoed bar with probability `pVar = 0.25`;
    - and, per phrase, an optional mirror of the copy with probability 0.15, applied to the whole phrase so hands stay consistent.
  - Copied rows go through the guard. A row the guard vetoes is re-sampled.
  - The variation RNG is `deriveSeed(noteSeed, 0xEC40, bar)`.
- With an infill source, echo rows are passed per build through `step(i, fixed)` (§1.1, §2.7), **not** as `known`, with a `strength` of 0.6 meaning 40% of them are dropped back to "free", so the model makes the small variations itself. The drop uses `deriveSeed(noteSeed_k, 0xEC41, bar)`. Because echo rows never reach the encoder, the encoder still runs once per prepare.

### 2.4 Infill transformer (item 4)

The spec is in §4.4 and the JS design in §5.
- "Lock a part and regenerate the rest" uses the v3 `lock` request unchanged.
  - The worker passes the locked rows as `known`.
  - The bidirectional encoder sees the locked parts on **both** sides of a gap.
  - The decoder teacher-forces them into its KV cache.
- U adds the inverse action «Перегенерировать только эту часть», which locks every other part. It is renderer-only, through the same `lock` field.

### 2.5 Fun (item 5)

- A head of the critic (§4.2), used **only for reranking**, with a small weight.
- RL fine-tuning is not done. The cheap alternative (reward-filtered fine-tuning, N5) is optional and comes only after reranking has shown a gain.

### 2.6 Style (item 6)

- **XGB path** (shippable first):
  - `stylePattern[key][family]` is per-creator pattern counts. The source samples from `counts_global + α·counts_creator` with α = 4, backing off to the global table where the creator has fewer than `MIN_EVIDENCE` rows.
  - `styleBias[key]` shifts note log-odds by the creator's mean density residual.
- **nn-v2:** a style embedding (§4.4).
- **Critic style head:** `wS·log P(style | map)` in stage 1, only when a style is chosen.
- **Never** written into the map:
  - `Creator:` stays the user's field;
  - `Tags` get no mapper names;
  - the version line gets no name.

### 2.7 Ratings and the personal reranker (item 7)

**Store:** `userData/ratings.json` through `createJsonStore` (tabs-v2's `app/jsonStore.js`, imported only, never edited; §8.1).
- At most 2000 entries, newest kept. `normalize` drops bad entries.
- Entry: `{ at, vote, tags, version, range, families, modelKind, criticKind, features: number[], names: string[], audioKey }`.
  - `features` comes from the store entry of `id`.
  - `audioKey = sha1(audioPath).slice(0, 12)`.
- No audio and no chart text is stored.

**`RATING_TAGS`**

| Kind | Key | Russian | English |
|---|---|---|---|
| 👎 | `tooJacky` | «слишком джековая» | "too jacky" |
| 👎 | `awkward` | «неудобно рукам» | "uncomfortable for the hands" |
| 👎 | `boring` | «скучно» | "boring" |
| 👎 | `offMusic` | «не в музыку» | "doesn't follow the music" |
| 👎 | `tooDense` | «слишком плотно» | "too dense" |
| 👎 | `tooSparse` | «слишком пусто» | "too sparse" |
| 👍 | `fun` | «весело» | "fun" |
| 👍 | `human` | «как у маппера» | "feels hand-made" |
| 👍 | `comfy` | «удобно» | "comfortable" |

**Personal model** (`src/gen/personal.js`, pure; **fitted and scored in the worker**, never on the main thread; user decision)
- L2 logistic regression on the standardised critic features (means and stds from `critic.json.norm`), fitted with IRLS (at most 25 iterations).
  - Cost per iteration: `XᵀWX` is n·p² = 2000 · 250² = 125M multiply-adds (about 250 MFLOP), about 80 ms at 3 GFLOP/s; the 250 × 250 Cholesky solve is negligible.
  - At a typical 6 iterations that is about **0.5 s** on this machine (about 1.5 s on a laptop); the 25-iteration cap is about 2 s (about 6 s on a laptop).
  - Leave-one-out AUC uses the one-step (hat-matrix) approximation, so it needs no refits.
  - This runs as a `fit-personal` job in the generator worker (the utility process), so the Electron main thread never blocks. A fit queued behind a running generation waits; the generation uses the last cached model.
- **Tag priors.** The Gaussian prior is centred on a sum of tag directions:
  - `tooJacky` pushes jack features negative;
  - `awkward` pushes hand-imbalance, one-hand-jump and anchor features negative;
  - `boring` pushes entropy features positive;
  - and so on.
  - Each tag's feature groups are named in `TAG_PRIORS`. A few tagged votes therefore already move the right weights.
- **Active** when n ≥ 12 with at least 4 of each sign **and** the leave-one-out AUC is ≥ 0.6.
- Weight: `wU = min(0.5, n/(n+40))`.
- After each `rate-variant` (debounced 2 s) main sends the stored entries to the worker as a `fit-personal` job and caches the `PersonalModel` it returns. Main does no fitting itself. The `generate-map` worker payload carries the cached model (§1.1).

**Export:** «Выгрузить мои оценки» writes the JSON to `docsDir`, so the user can send it to Sneezey for global training by hand. There is no network.

### 2.8 Augmentation and cleaning (item 8)

This is all in §3.

---

## 3. Data pipeline v2 (dataset v3, `A:/SneezeyTrain/mapper3`)

This builds on D2's dataset v2 (`mapper2`). `mapper2` stays as it is: it is the baseline's data.

### 3.1 Sources

| Source | Path | Chart format | Labels it brings |
|---|---|---|---|
| osu! Songs | `A:/Games/osu!/Songs` | .osu | ours |
| tracker corpus | `A:/SneezeyTrain/sets` + `manifest.json` | .osu | tracker dan, tracker MSD, set playCount |
| HF ranked/loved | `A:/SneezeyTrain/hf` (`fetch-hf-osu.mjs`) | .osu | creator, ids; playcount, passcount and favourites from `project-riz/osu-beatmap-tags` `metadata.csv` |
| EtternaOnline packs | `A:/SneezeyTrain/etterna/songs/<packId> <song>/` + `packs/<packId>.json` (D's existing `tools/fetch-etterna-packs.mjs`, extended in E1) | .sm/.ssc → `sm2osu.mjs` | EtternaOnline MSD per chart (in the pack manifest) |
| Dan Reform v2.2, Drive packs | `A:/SneezeyTrain/packs/<name>` | .osz | course and pack membership (used for weighting) |

- The user has approved Etterna big packs, HF osu-beatmaps, the Drive packs and Dan Reform (`.lekhapion/research.md`).
- **`project-riz/osu-beatmap-tags` is a different HF repo.** Fetching its `metadata.csv` needs the user's OK if that approval does not cover it (task E1 asks first).
  - **If the user declines,** there are no per-diff plays, passes or favourites, and no set favourites: the tracker supplies only `setPlays`. Then `fun` is null for every map, `fun-labels.py` (E5) is skipped, R3 trains no fun head (`critic.json` has none, `fun` is null in responses, `wF = 0`), and V2's "fun weight" decision is recorded as «no data» and skipped. Nothing else depends on the fun labels.
- Downloads stay untrusted:
  - only chart text and audio are extracted, with size caps;
  - names come from validated ids;
  - nothing is executed;
  - all of D1's zip rules apply.

### 3.2 Cleaning and dedupe (`src/corpus/fingerprint.js`)

**Chart key** (rate- and mirror-invariant)
- Take the first 256 row intervals **in beats**, quantised to 1/48, plus the column sequence.
- Canonical form = the lexicographically smaller of the sequence and its mirror (column c → 3−c).
- `chartKey = sha1(canonical)`.
- Two charts with one chartKey but different BPM are **rate variants**: `rate = bpm / bpm_canonical`.

**Audio key**
- Take 60 s of chroma from 30 s in, at 2 Hz, as a sign-of-difference bit string (64 bits × 8 bands).
- `audioKey` is its hash. Hamming distance ≤ 40/512 counts as the same recording. Rate edits are excluded because the lengths differ.

**Song group**
- Union-find over the D2 `songKey` (title + length), `audioKey` matches and `chartKey` matches.
- This is the unit for splits and for the per-song weight.

**Dedupe**
- A chart present in several sources keeps one copy. Priority: Songs > tracker corpus > HF > Dan Reform/Drive > Etterna.
- The other copies only add labels: Etterna MSD, playcounts, creator.

**Rate variants**
- **Dropped by default.** The canonical copy is the one whose audio length matches the group's most common length.
- `--rate-variants keep` keeps at most one variant per chart with weight 0.25 and `rate` conditioning. That is for the ablation in E4 (`train_mapper.py --rate-variants`) only; E3 writes the variants with their `rate` label so E4 can choose.

**Filters** (on top of D1 `pickDiffs`)
- LN share ≤ 0.15, with LNs converted to taps;
- `residualOffgrid ≤ 0.2`;
- Etterna charts with stops or warps are skipped (as in `sm2osu.mjs`);
- at least 100 rows;
- no 1/12 or 1/16 dumps (more than 10% of rows off the {4, 3, 6, 8} grid);
- courses (several songs joined into one chart) are dropped when an "original rates" copy exists.

**Weights**

```
w = 1/sqrt(diffs in the song group)
  · min(1, 0.03 / packShare)
  · min(1, 0.02 / creatorShare)
  · min(1, 2·median_bin / bin)
```

- `packShare` and `creatorShare` are shares of the total weight.
- `bin` is the weight of the map's dan bin.
- Large dumps (Valedumps, Yolo Dumps) and single prolific creators can then never dominate.

### 3.3 Features per map

- **`.f32`:** `AUDIO_FEATURES_V3` per slot = `AUDIO_FEATURES_V2` (23 columns) + stem columns (8) + structure columns (6) = **37**.
- **`.b32`:** `BEAT_FEATURES_V3` per beat = `BEAT_FEATURES` (15) + chroma (12) + timbre (12) + `phrase_pos`, `is_phrase_start`, `has_echo`, `rep_sim`, `novelty`, `meter` = **45**.
- **`.u8`** `[note, mask, family, div]`, **`.t32`** and **`.bd8`**: as in D2.
- **`.st.json`:** the structure (phrases, repeats, `echoOf`), for the transformer's echo links and for the structure metrics.
- **Mirroring** happens on the fly in training. It is not stored.

### 3.4 Labels (`index.jsonl` fields added to D2's)

```
songGroup, chartKey, audioKey, rate, packId, creatorKey, creatorName, year, weight,
msdOurs[8], msdEtterna[8] | null, msdTracker[8] | null, danOurs, danTracker | null,
fun: { plays, passes, favs, setPlays, setFavs, playsResid, passResid, favResid } | null
```

- **`msdOurs`** comes from `analyzeChart(...).msd`. It is the conditioning label everywhere, because the app can compute the same thing.
  - `msdEtterna` and `msdTracker` are used only to report the calibration MAE.
  - If the MAE of `msdOurs.overall` against `msdEtterna.overall` is above 1.5, E2 stops and reports.
- **Dan:** D3's isotonic tracker → ours mapping stays. It is applied to Etterna charts through `danOurs` only.
- **Creators:**
  - `creatorKey` = lowercase, trimmed name, merged by HF `user_id` where known;
  - a style is eligible with ≥ 30 rice diffs across ≥ 8 song groups after dedupe, expected 40–80 creators;
  - everyone else is `unknown`.
- **Fun residuals** (`tools/fun-labels.py`):
  - `playsResid` = residual of `log1p(plays)` after a set fixed effect + the diff's star rank in its set + diff count + whether it is the top diff;
  - `passResid` = residual of the pass ratio after a spline in star rating;
  - `favResid` = residual of `log1p(setFavs)` after `log1p(setPlays)` + year + approval status.
  - Tracker `setPlays` fills in where HF has no row.

### 3.5 Splits

- `test` = `crc32(songGroup) % 10 == 0`, `val` = `== 1`, the rest is train.
- `mapper3/heldout.json` (written by E3) lists the songGroups and every member songKey, so D5's tool can assert no overlap with `mapper2` either.
- The same split serves every model here: XGB v3, critic, fun, style, nn-v2.
- **Critic negatives** are generated from train and val songs for training, and from test songs for evaluation. They are never mixed.

### 3.6 Augmentation (training time)

| Augmentation | Where | Rule |
|---|---|---|
| Column mirror | nn-v2, critic | p = 0.5. Masks are bit-reversed; families and styles are unchanged; mirrored humans are positives for the critic |
| Pattern-table symmetrisation | `train_mapper.py` | counts += mirrored counts. Its own ablation flag; must not lower the validation log-loss |
| Rate variants | ablation only | see §3.2 |
| Condition dropout | nn-v2 | dan 10%, MSD 30%, style 20%, family 10% → "unknown" |
| Span masking | nn-v2 | §4.4 |

---

## 4. Model specs

### 4.1 Critic: human-likeness head (`models/critic.json`, `kind: "critic-v1"`)

**Features** (`src/gen/criticFeatures.js`, `CRITIC_FEATURES`, about 250 names, stable order)
- **Per 16-beat window** (about 70 values):
  - notes and rows per beat; size shares s1–s4;
  - left share and |left − 0.5|; column shares; max/min column ratio;
  - jack rate, max jack run and min jack gap (ms), each overall and in streamy families;
  - mask bigram entropy;
  - shares of trills, rolls (1234/4321 runs), split-hand jumps and one-hand jumps; anchor ratio;
  - interval histogram in beats (1/8, 1/6, 1/4, 1/3, 1/2, 1, more);
  - rhythm entropy;
  - mean onset at rows minus mean onset at empty slots;
  - the correlation of row size with onset, and the shares of rows on kick, snare and hat peaks;
  - the share of rows where the onset is below 0.1;
  - echo similarity: row Jaccard against the `echoOf` bar, or −1 when there is no echo.
- **Per map:** P10, mean and P90 of each window feature, plus:
  - density–energy correlation;
  - longest jack; issues and forced rows per 1000 (A2's `findIssues`, guard `forced`);
  - divisor shares;
  - and as context only, the target dan, the family shares and the BPM.

**Model**
- XGBoost `binary:logistic`, about 600 trees, depth 6.
- Exported with D's `export_xgb` and evaluated with `treeRaw`, so the parity tooling is reused.
- Calibration (`norm.zH = {mean, std}`) is measured on held-out human maps.

**Training data**
- **Positives:** human maps from train songs, re-rendered from their labelled slots through `toOsu`. Timing quantisation, the lack of LNs and the grid are then identical to generated maps, so the critic cannot learn file artefacts.
- **Negatives (3 per positive):**
  1. the v3 generator with B0's model on the same song, at the human map's dan, seeds 1–3;
  2. the v2 generator (from the git tag before v3);
  3. perturbed humans, one kind picked at random:
     - columns remapped randomly within each row size;
     - 1-beat segment shuffles;
     - jack insertion;
     - 30% of rows shifted by one slot;
     - ±15% density noise;
     - an 8-beat section swapped in from another map of the same dan.
  - Made by `tools/make-critic-negatives.mjs`, using the JS generator and `slotFeatures` v3.
- **Volume:** about 30k positives + 90k negatives, about 300 MB of features.
- **5080 budget:** CUDA hist, about 10 min per fit; with a 12-config sweep, under 2 h.

**Optional window head:** the same features per window, giving a "weakest window" pointer for block retry. It ships only if it beats `scoreBlock` on block-retry outcomes (R5).

### 4.2 Fun head (in `critic.json`)

- Same features.
- **Within-set head:** XGBoost `rank:pairwise` with `qid = set` on `playsResid`.
- **Cross-set head:** `rank:pairwise` with `qid = (dan bin, year)` on `favResid`.
- `zF = 0.5·z(within) + 0.5·z(cross)`.
- **Data:** HF ranked/loved 4K rice diffs that have metadata, expected 8–15k. About 400 trees, depth 5; minutes on the GPU.
- **Expected signal is weak.** Song popularity is confounded with the mapping, which is why the within-set comparison and the residuals exist. The ship rule (§7) decides whether it gets any weight.
- **Without `metadata.csv`** (the user declined, §3.1) this head is not trained at all.

### 4.3 Style head (in `critic.json`)

- Multinomial logistic regression on the standardised features over the eligible creators plus `unknown`.
- About 250 × 81 weights; plain JS.
- **Uses:**
  - reranking when a style is chosen;
  - the style-accuracy metric: top-5 accuracy of the head on maps generated in style X.
- 30 s of training on the CPU.

### 4.4 Infill transformer (`models/mapper-nn2.json`, `kind: "nn-v2"`)

**Tokens are beats, not slots.** A 4-minute song at 175 BPM has about 700 beats and 3000 slots.

**Beat input**
- Lanes: 8 slot lanes, padded, in the beat's own grid order. Each lane has 12 values: `onset`, `low`, `mid`, `high`, `kick`, `snare`, `hat`, `harm`, `perc_share`, `energy`, `phase`, and present (0/1).
- Plus `BEAT_FEATURES_V3` (45) and a one-hot of the beat's divisor (4).
- **145 values** → Linear → d.

**Visible chart:** for each beat, the sum over lanes of `maskEmb[known mask] + laneEmb[lane]`, and a learned `[FREE]` vector for free slots. This is the infill input. At inference it holds the **locked** rows only (`known`); echo rows reach the model only through the decoder's teacher forcing (§2.7, §5.2).

**Conditioning, added to every beat token**
- dan as 16 Fourier features;
- MSD as 8 values (or "unknown");
- family per beat (7 embeddings, including unknown);
- style (`K + 1` embeddings);
- rate (1 value, always 1 unless the ablation keeps rate variants).

**Encoder** (bidirectional, once per prepare)
- d = 96, 4 layers, 4 heads, FFN 384, pre-LN, GELU, ALiBi relative bias.
- Attention is **local**: ±32 beats, plus up to 2 **echo keys** (the beats at `echoOf` × meter + offset from the structure) and 4 global condition tokens.
- About 70 keys per query, so long context costs O(T).

**Decoder** (causal over beats, KV cache)
- d = 64, 2 layers, 4 heads, FFN 256.
- Self-attention over the last 32 decoded beats.
- Cross-attention to the encoder outputs at ±32 beats; static K/V, computed once.
- The input of beat b is the embedding of beat b−1's actual rows.

**Lane head** (per slot, sequential inside the beat)
- Input: decoder state (64) + lane embedding (16) + the last 4 masks with their gaps (4 × 17) + the slot's 12 lane values = 160.
- 160 → 64 → 64 → **16 logits**, where logit 0 is "no row".
- At inference, `logits[0] -= knob + adjust[i]` (as in nn-v1) and `log weightOf(mask)` is added; a weight of 0 gives −∞.

**Parameters**

| Block | Parameters |
|---|---|
| Input projection + embeddings | about 30k |
| Encoder (4 × 110.6k) | 442k |
| Decoder (2 × (16.4k self + 20.5k cross + 32.8k FFN)) | 139k |
| Lane head | 15k |
| **Total** | **about 0.63 M** |

- Stored as f16 + per-tensor scale, base64: about 1.3 MB of weights, about 1.8 MB of JSON. That is under §10 Gate 0's 5 MB.

**Training** (`tools/train_infill.py`)
- **Windows:** 512 beats, about 3 min. A whole song usually fits in 1–2 windows.
- **Masking schedule per window:**
  - 30% everything free (unconditional);
  - 35% 1–4 random spans covering 20–80%;
  - 20% whole parts free (from `detectParts` boundaries stored in `.st.json`; the rest is visible);
  - 15% prefix continuation.
  - **On top of that, in 25% of windows:** in bars with `echoOf ≥ 0`, 60% of the free slots are teacher-forced in the decoder while staying `[FREE]` in the encoder input, and they are left out of the loss. This matches how echo rows arrive at inference.
- **Loss:** cross-entropy over the 16 classes on free slots only, with label smoothing 0.05. Auxiliary losses: family per beat (0.1) and notes per beat (0.1).
- **Settings:** 10% scheduled sampling in the decoder; mirror p = 0.5; the condition dropouts of §3.6.
- **Optimiser:** AdamW (lr 2e-3, cosine, 2k warm-up, weight decay 0.05), bf16 autocast, batch 32 windows, about 60k steps.
- **Data:** about 80k charts after dedupe (osu! about 20–25k + Etterna about 55k), about 56M beat tokens.
- **Compute:** 60k steps × 32 windows × 512 beats ≈ 983M beat tokens, about **17.5 epochs** of 56M (10 epochs would be about 34k steps).
  - 6 · 0.63M · 983M ≈ 3.7 PFLOP. The lane head runs per slot, about 4.3 times per beat, so it adds about 6 · 15.4k · 3.3 · 983M ≈ 0.3 PFLOP that 6·N·D does not count. Total **about 4 PFLOP**.
  - At a realistic 5–10 TFLOP/s for a model this small, that is about **7–13 minutes** of math.
  - Loading data from memmap and kernel-launch overhead dominate at this size, so budget **4–6 h per run** and **≤ 2 days** for the sweep (3 sizes × 2 masking schedules). The math is not what sets that budget.
  - VRAM is under 4 GB.
- **Export** (`tools/export_infill.py`):
  - weights are rounded to f16 **before** the parity probes are computed;
  - 3 probes: a full window, a lock window and a style window, each with logits at 40 slots;
  - JS must match within 2e-3.

**Optional N5, reward-filtered fine-tuning**
- Generate 8 maps per train song.
- Keep the top 20% by stage-1 score among those in range.
- Fine-tune 1 epoch at lr 2e-4.
- Done only if critic reranking alone has already passed §7. It is gated like any model.

### 4.5 XGB v3 (`mapper.json`, `kind: "xgb-v3"`)

- D3's trainer on `mapper3`, with:
  - the `AUDIO_FEATURES_V3` columns;
  - symmetrised pattern tables;
  - `stylePattern` and `styleBias`;
  - `msdPrior`;
  - the §3.2 weights.
- This is the cheapest way to get stems and style into the app, and it is the A-side for nn-v2.

---

## 5. JS inference design and performance budget

### 5.1 Kernels (`src/gen/nn/kernels.js`)

- Weights are stored transposed so the inner loops are contiguous. f16 is decoded to `Float32Array` once at load.
- `matmul` uses i-p-j ordering (2.9 GFLOP/s measured). `matvec` uses 4-way unrolled dot products (3.4–3.9 GFLOP/s).
- Also: LayerNorm, GELU (tanh form), softmax with a max shift, and local attention with an explicit key list (window + echo + global).
- **No WebAssembly and no ONNX.** WASM SIMD is listed as later work (§10).

### 5.2 `infillSource.prepare`

1. Build the beat inputs and encode. The encoder runs **once per prepare**; one prepare serves all searches and candidates of a variant.
   - This holds because the encoder's visible chart is `known`, the locked rows only, which are the same for every build of the variant. Echo rows, which change with `noteSeed_k` and with rows decoded earlier in the build, go through `step(i, fixed)` into the decoder (§2.7), so they never invalidate the encoder output.
2. Precompute the cross-attention K/V per decoder layer: 2 × 700 × 2 × 64 floats ≈ 0.7 MB.
3. Return `{ step }` as in §2.7.
   - When `step(i)` enters a new beat, it runs one decoder step: it appends K/V to a ring buffer of 32 beats × 2 layers.
   - Each slot then runs the lane head.
   - `known` rows, and the `fixed` rows of `step(i, fixed)`, are teacher-forced, with no sampling and no RNG use.
4. **Snapshots:** `snapshot()` and `restore(s)` copy the ring buffers (about 8k floats). Block retry and own-range part searches can then re-decode one block or one part from its start, without decoding the whole map again.

### 5.3 Cost per map (4 min, 700 beats, 3000 slots)

| Step | Work | This machine (3 GFLOP/s) | Laptop (1 GFLOP/s) |
|---|---|---|---|
| Stems (renderer, once per song) | STFT + HPSS + chroma STFT + detectors | ≤ 1.2 s | ≤ 3.3 s |
| Structure (worker, per prepare) | SSM ≤ 300², novelty | ≤ 30 ms | ≤ 80 ms |
| nn-v2 encoder (per prepare) | 0.73 GFLOP | 0.25 s | 0.75 s |
| nn-v2 one build | decoder 0.20 + lane head 0.09 = 0.29 GFLOP | 0.10 s | 0.30 s |
| XGB one build (today's source) | Markov + guard | ≤ 40 ms | ≤ 100 ms |
| Critic stage 1 per candidate | features + about 1k trees + LR | ≤ 10 ms | ≤ 25 ms |
| `analyze` (stage 2 and search) | per call | 0.25 s | 0.6 s |

**Per variant, nn-v2, N = 12, no own-range parts**

| Phase | This machine | Laptop |
|---|---|---|
| Encoder | 0.25 s | 0.75 s |
| Search, 5 evaluations (`{coarse: 3, refine: 2, reseeds: 1, keep: 1}` for nn-v2, because the model is already conditioned on the dan) | 5 × 0.35 s | 5 × 0.9 s |
| Candidates | 12 × 0.11 s | time box 4 s, about 12 |
| Stage 2 | 3 × 0.25 s | 3 × 0.6 s |
| Describe | about 0.5 s | about 1 s |
| **Total** | **about 4.5 s** | **about 12 s** |

The encoder line appears once per variant, not once per candidate, because echo rows never reach the encoder (§5.2).

**Per variant, XGB v3, N = 12:** the v3 search (≤ 8 s p95, A2.12) + 0.6 s of candidates + 0.75 s of stage 2. **Target: p95 ≤ 9.5 s.**

**Targets** (`tools/bench-gen.mjs`, 4-min songs, p95)
- ≤ 8 s per variant for nn-v2 on this machine;
- ≤ 15 s on a 4-core laptop with N adapting through the time box;
- stems ≤ 1.2 s on this machine (§2.2).
- If `bench-nn.mjs` measures under 0.8 GFLOP/s on the laptop profile, the encoder shrinks to d = 64 before training (decided in N0).

**Optional G5:** a pool of `min(4, cores − 1)` `worker_threads` inside the utility process for candidates, with features shared through `SharedArrayBuffer`. Results are identical in any order, because each candidate has its own seed. Done only if the laptop p95 misses its target.

---

## 6. UI additions (create tab)

`index.html` stays P's, and P-ml edits it only inside `<section id="create-tab">`, never its first or last line (tabs-v2 §1.3; §8.1). Everything below is built by JS into containers. Styles go into a marked block `/* >>> mapgen-ML */ … /* <<< mapgen-ML */` at the end of `create.css` with the class prefix `.ml-`, so no new `<link>` is needed in `index.html` (tabs-v2's foundation places the CSS links).

**`#gen-options`** (a new group container added by P inside `#create-tab`, before `#generate`; header `create.html.genOptions` «Генератор»), filled by `app/renderer/genOptions.js`:
- «Вариантов на выбор» slider, 1–20, default 12. Hint: «критик выбирает лучший · ≈{sec} с». The seconds are estimated from the last run's `ms` per candidate.
- «Стиль маппера» select: «Без стиля», then `name (maps)` from `generator-info`. Disabled when the model has no styles.
- «Повторы — похожими паттернами» checkbox, default on. Disabled, with a hint, when there are no stems or no structure.

**Result card** (`resultView.js`):
- Critic line: «Критик: как у человека {h}% · интерес {f} · удобство {p} · лучший из {n}». A missing head is left out of the line.
- `ratingBar.js`: 👍 / 👎, and after a vote, up to 4 tag chips from `RATING_TAGS`.
- After the personal model is active: «Учитываю твои оценки: {n}».

**Part editor** (`timeline.js`)
- «Перегенерировать только эту часть», which locks all other parts.
- Thin phrase ticks on the energy curve.
- Repeated parts share an underline colour (from `structure.repeats`).

**Progress:** `create.progress.candidates` and `create.progress.critic`.

**Settings:** «Выгрузить мои оценки» (`ratings-export`) under the result.

**i18n keys:** all of them go into `src/i18n/messages/create.js`, inside the plan's `// ---- stream B ----` block, which U takes over from B (§8). There is no new marker. `app.js` and `html.js` are frozen by tabs-v2 and are not edited; following tabs-v2 §1.3, the markup key uses `create.html.*` and the main-process error uses `create.err.*`.

| Key | Russian | English |
|---|---|---|
| `create.html.genOptions` | «Генератор» | "Generator" |
| `create.ml.candidates` | «Вариантов на выбор» | "Candidates to choose from" |
| `create.ml.candidatesHint` | «критик выбирает лучший · ≈{sec} с» | "the critic picks the best · ≈{sec} s" |
| `create.ml.style` / `.styleNone` / `.styleOption` | «Стиль маппера» / «Без стиля» / «{name} ({maps})» | "Mapper style" / "No style" / "{name} ({maps})" |
| `create.ml.repeats` / `.repeatsOff` | «Повторы — похожими паттернами» / «нужен разбор звука — перезагрузи песню» | "Repeats get similar patterns" / "needs the sound breakdown — reload the song" |
| `create.ml.critic` | «Критик: как у человека {h}% · интерес {f} · удобство {p} · лучший из {n}» | "Critic: human-like {h}% · fun {f} · comfort {p} · best of {n}" |
| `create.ml.rate.up` / `.down` / `.thanks` | «Нравится» / «Не нравится» / «Спасибо — учту» | "Like" / "Dislike" / "Thanks — noted" |
| `create.ml.tag.{tooJacky,awkward,boring,offMusic,tooDense,tooSparse,fun,human,comfy}` | see §2.7 | see §2.7 |
| `create.ml.personal` | «Учитываю твои оценки: {n}» | "Using your ratings: {n}" |
| `create.ml.export` / `.exported` | «Выгрузить мои оценки» / «Сохранено: {file}» | "Export my ratings" / "Saved: {file}" |
| `create.ml.onlyThisPart` | «Перегенерировать только эту часть» | "Regenerate only this part" |
| `create.ml.stems` | «Разбираем звук на партии…» | "Splitting the sound into parts…" |
| `create.progress.candidates` / `.critic` | «Пробуем варианты: {i} из {n}…» / «Критик сравнивает лучшие…» | "Trying candidates: {i} of {n}…" / "The critic compares the best ones…" |
| `create.err.badRating` | «Оценка не сохранена: {what}» | "Rating not saved: {what}" |

---

## 7. Ship rule

**Baseline B0** = the v3 generator with whatever model D5 shipped (v1 or v1.5), `candidates: 1`, no stems, no repeats. Its metrics are recorded once in `reports/mapper.md` («B0»).

**A new piece ships only if both of these hold:**
1. it beats B0, or the previous shipped piece, on held-out metrics;
2. it wins a blind play test.

**Every piece must also pass all of these:**
- §10 Gate 0 (tests, parity, size, held-out assertion), now against the `mapper3` songGroups.
- `tools/compare-mappers.mjs` (D's, extended in V1 with `--config` for candidates, critic, style and repeats), on 180 held-out songs × seeds 1, 2, 3 in the range form:
  - dan hit rate ≥ B0;
  - pattern accuracy ≥ B0 − 0.01;
  - violations per 1000 ≤ B0;
  - onset F1 ≥ B0 − 0.005;
  - jack-loop rate ≤ max(B0, human × 1.2);
  - p95 time within §5.3.
- **Blind test:** `tools/blind-pack.mjs` makes one .osz per song with two diffs named `[X]` and `[Y]` at random, and keeps the key in `A:/SneezeyTrain/candidates/blind-<date>.json`. The user plays 5 held-out songs across dans. **B ships only if it is preferred on 3 or more of the 5.**

**Per piece**

| Piece | Must improve (paired bootstrap 95% CI above 0) | Extra checks |
|---|---|---|
| Candidates + heuristic critic | violations per 1000 vs N = 1; **or** msdFit, only when the shipped model has `msdPrior` (B0's v1 or v1.5 has none, so on B0 the rule is violations alone) | — |
| Critic-v1 (human head) | held-out AUC human vs v3-generated ≥ 0.85 and vs perturbed ≥ 0.90; the human score of picks under a **second critic** (other seed, other negative seeds) beats random picks | Anti-gaming: the picks' pattern accuracy and onset F1 must not drop |
| Fun head | within-set pairwise accuracy ≥ 0.58 with CI above 0.5; cross-set Spearman ≥ 0.15 | `wF` stays 0 unless the blind test with `wF > 0` wins |
| Stems columns (xgb-v3 with vs without) | note AUC + 0.005 **or** onset F1 + 0.01 | stems time ≤ 1.2 s; decoder correlation ≥ 0.97 |
| Structure / repeats | repeat consistency gap: \|rowJaccard(gen at repeats) − human\| shrinks ≥ 30% vs B0; phrase-start boundary F at ±1 bar ≥ 0.6 on `eval-structure.mjs` | pattern accuracy not below B0 − 0.01 |
| Style | the style head's top-5 accuracy on maps made in style X ≥ 2× the no-style rate, averaged over the 10 largest styles | also blind: "which one is X?" on 3 pairs (information only) |
| nn-v2 | §10 Gate 2 (written for nn-v1; here applied unchanged to nn-v2) against the best shipped XGB, plus infill: lock 50% of a human map and regenerate the rest; onset F1 on the regenerated part ≥ XGB's; seam violations within ±2 beats of a lock ≤ XGB's | JS/PyTorch parity; p95 ≤ 8 s |
| Personal reranker | none globally: it is per user | active only at leave-one-out AUC ≥ 0.6 (§2.7) |
| Augmentation and cleaning | each change, as an ablation in E4 (trained on the E3 dataset with and without the change): validation log-loss and the D5 metrics not worse | — |

**Kill switches** (no code change needed):
- `candidates: 1`;
- no `critic.json`;
- a model without `needs`;
- `repeats: false`;
- `style: null`.

A model that fails stays in `A:/SneezeyTrain/candidates/`, as in §10.

---

## 8. Workstreams (wave 3)

**W3-0, the entry gate**
- Wave 2 (A1, A2, B, C) is merged into `feature/v3`.
- D2 (`mapper2`) is built.
- D5 has a verdict, which defines B0.
- **tabs-v2 phase 2** (its I1–I2: all four tabs merged into `main`, `npm test` green) is done, and `main` is merged into `feature/v3`. The working tree today has tabs-v2 edits pending in `preload.cjs`, `index.html`, `analysisWorker.js`, `workerClient.js` and others; P-ml builds on their merged state, never on a half-merged one.
- `npm test` is green.

**Ownership rules**
- Ownership of a wave-2 file passes to exactly **one** wave-3 stream, named below, only after its wave-2 owner has merged. In particular, the files modified in the working tree right now (for example A1's `slotFeatures.js`) stay with their wave-2 owner until that owner's merge; the taking stream starts from the merged file.
- P and D keep everything they own. Wave 3 asks them for small tasks: P-ml for P, and E for D.
- One worktree per stream. Rebase onto `feature/v3` before merging. Tests are written first.

**Merge order:** P-ml1 → S → U1 → G1 → E2 → R → G2 → U0 → U2 → E3 → E4 → G4 → N → G3 → V. G5 (optional) merges any time after G3.

### 8.1 Contract with tabs-v2 (`docs/2026-10-25-tabs-v2-plan.md`)

tabs-v2 runs beside mapgen v3. Its foundation froze some files and gave others to its streams. This addendum keeps to those rules:

| tabs-v2 file or rule | What this addendum does |
|---|---|
| `app/main.js` (frozen; tabs-v2 §1.3) | **Not edited.** `main.js` already calls `registerCreateIpc(deps)` once. The new channels are registered inside it (§1.1). |
| `deps` (frozen object; tabs-v2 §3.1) | **No new dep.** `registerRatingsIpc(deps)` reads `deps.paths.userData` (for `ratings.json`) and `deps.paths.docsDir` (for the export), and reaches the worker through the existing `deps.generatorClient`. If a new dep is ever needed, it goes as a **request** to the tabs-v2 integrator, never as an edit. |
| `tests/registerIpc.test.js` (frozen; `IO_DEPS` is a fixed list) | **Not edited.** Registration does no I/O, starts no timer and calls no dep. The ratings store is created lazily on the first handler call, because `deps.paths` is a stub at register time in that test. |
| `app/jsonStore.js` (tabs-v2 foundation) | Imported only (`createJsonStore`), never edited. |
| `src/i18n/messages/app.js`, `html.js`, `index.js` (frozen) | **Not edited**, and the freeze is not lifted. Every new key lives in `create.js` (§6). |
| `tests/i18n-coverage.test.js` (frozen) | Not edited. New keys are double-quoted literals; Cyrillic appears only in messages. |
| `app/preload.cjs` (per-tab marked blocks; tabs-v2 §3.4) | The 4 new methods (`generatorInfo`, `rateVariant`, `ratingsSummary`, `ratingsExport`) go **only inside** the `// >>> create (mapgen v3)` … `// <<< create` block. |
| `app/renderer/index.html` (each stream inside its own section) | `#gen-options` goes inside `<section id="create-tab">`, not on its first or last line. **No new `<link>`**: the styles go into a marked block of `create.css` (§6). |
| `app/renderer/renderer.js`, `styles.css` (frozen) | Not edited. |
| `app/analysisWorker.js`, `app/workerClient.js` (tabs-v2 A owns their `details` parts) | Not edited by this addendum. |
| `src/gen/request.js` exports `LEVELS`, `STEPS`, `targetNumeric` (read by tabs-v2's `danSelect.js`) | G adds fields to `normalizeRequest` only; these three exports stay unchanged. |

### P-ml: plumbing (P owner)

**Edits** `app/createIpc.js`, `app/generatorJobs.js`, the `// >>> create (mapgen v3)` block of `app/preload.cjs`, the inside of `<section id="create-tab">` in `app/renderer/index.html`, and `tests/createIpc.test.js`. Creates `tests/generatorJobsMl.test.js`. It does not edit `html.js` or `app.js` (§8.1).
- `app/generatorJobs.js` is not in the plan's P ownership list. This addendum assigns it to P (through P-ml), because the model load order and `MODEL_FILES` live there (§0), not in `analysisWorker.js`.

- **P-ml1** (first, about half a day)
  - Validation of `stems`, `candidates` and `style` (§1.1).
  - Main adds `personal` and `deadlineMs` to the worker payload (stub: `personal: null`).
  - `generator-info`.
  - Calls `registerRatingsIpc(deps)` from `registerCreateIpc`, with a P0-style stub `app/ratingsIpc.js` that U takes over. `registerCreateIpc` passes the whole `deps` on; no new dep (§8.1).
  - Preload, inside the `// >>> create (mapgen v3)` block only: `generatorInfo`, `rateVariant`, `ratingsSummary`, `ratingsExport`.
  - In `generatorJobs`:
    - `MODEL_FILES` becomes 3 files;
    - a model whose `needs` is not met (no stems) is skipped;
    - `critic.json` is loaded optionally;
    - `stemsFromTransfer` is passed beside the envelope;
    - the engine label covers nn-v2: `m.kind.startsWith("nn-") ? "neural" : "learned"` (today it checks only `"nn-v1"`);
    - a `fit-personal` job kind that calls `fitPersonal` from `src/gen/personal.js` (stub in P-ml1: returns null; U1 fills it in).
  - Stub modules `src/gen/critic.js` (heuristic), `src/audio/stems.js` (`stemsFromTransfer` only), `src/gen/structure.js` (returns null) and `src/gen/personal.js` (`fitPersonal` returns null), so every stream can import them from day 1.
  - The `#gen-options` container, inside `<section id="create-tab">`.
  - **Tests:** each validation case; `personal` from the renderer is ignored; a `needs: ["stems"]` model without stems falls back to `mapper.json`; an `nn-v2` model is labelled `"neural"`; `generator-info` returns styles; `fit-personal` runs in the worker job table; no file is written; `tests/registerIpc.test.js` stays green unchanged.

### S: stems and structure (new stream)

**Owns** `src/audio/hpss.js`, `src/audio/stems.js`, `src/gen/structure.js`, `tools/bench-stems.mjs`, `tools/eval-structure.mjs`, `tests/gen/{hpss,stems,structure}.test.js` and `tests/fixtures/stemTracks.js`.

**Takes over** `src/gen/slotFeatures.js` and `tests/gen/slotFeatures.test.js` from A1, only after A1 has merged (W3-0). `slotFeatures.js` is modified in the working tree now; those changes are A1's.

- **S1 `hpss.js` and `stems.js`.**
  - Tests, using synthetic tracks from `stemTracks.js`:
    - a 440 Hz sine plus clicks: ≥ 90% of the sine's energy lands in H and ≥ 80% of each click's energy in P;
    - a 60 Hz decaying burst peaks `kick` and not `hat`;
    - high-passed noise bursts peak `hat`;
    - noise plus 200 Hz bursts peak `snare`;
    - a C-major triad gives the top chroma bins C, E, G, both at C3–G3 (131–196 Hz, the lowest octave the chroma covers) and at C5;
    - a semitone pair at 131 and 139 Hz lands in two different pitch classes;
    - frame times equal `onsetEnvelope`'s;
    - a transfer round trip is within 1/255;
    - the sliding median equals a naive median on random data.
  - Bench: 240 s in ≤ 1.2 s (`bench-stems.mjs`; not a unit test).
  - Decoder check: Chromium vs ffmpeg curve correlation ≥ 0.97 on 10 songs (`--decoder` as in A1.7).
- **S2 `structure.js`.**
  - Tests:
    - a synthetic A B A B′ song (chroma patterns of 8 bars each) gives repeats (A→A at lag 16 bars) and phrase starts every 8 bars within ±1 bar;
    - a flat click track gives no repeats and a single phrase grid;
    - a part start always starts a phrase;
    - `echoOf` points backwards only;
    - output is deterministic.
  - `eval-structure.mjs`: on 100 human maps, the boundary F against density/family change points, and the human row Jaccard at detected repeats vs random bar pairs (this sets the target in §7). It tunes τ and the novelty kernel.
- **S3 `slotFeatures` v3.** Adds the `AUDIO_FEATURES_V3` names and the signature `slotFeatures(envelope, slots, bpm, names, { stems, structure } = {})`.
  - Tests:
    - v1 and v2 names give **bit-identical** rows to before;
    - v3 names without stems throw `missing stems`;
    - values are finite on mixed grids;
    - `kick_share` ≤ 1.

### E: data pipeline v2 (D owner; D's files stay D's)

**Edits** `tools/build-mapper-dataset.mjs`, `tools/train_mapper.py`, `tools/fetch-train-sets.mjs` (no change while it runs), `tools/fetch-etterna-packs.mjs`, `tools/fetch-hf-osu.mjs`, `tools/lib/*` and `.gitignore`.
- `fetch-etterna-packs.mjs`, `fetch-hf-osu.mjs` and `tools/lib/` are D's and untracked today. E's first commit adds them as they are, before changing anything.

**New:** `src/corpus/fingerprint.js`, `src/corpus/sources.js`, `src/corpus/weights.js`, `tools/ingest-packs.mjs`, `tools/fun-labels.py`, `tests/corpus/{fingerprint,sources,weights}.test.js`. There is **no** new `fetch-etterna.mjs`: the existing `fetch-etterna-packs.mjs` already lists packs, resumes downloads, extracts, converts and writes the MSD into `packs/<packId>.json`.

- **E0 `.gitignore`:** add `models/critic.json`, `models/mapper-nn2.json` and `models/mapper-nn.json` (if D4 has not), next to the existing `models/mapper.json`. `mapper3` lives on `A:` outside the repo; parity fixtures hold probe numbers only, never corpus charts or audio (§9).
- **E1 Ingest** (can start at W3-0; it needs no app code). This step downloads; nothing beyond the approved sources (§3.1).
  - `fetch-etterna-packs.mjs`, extended only where needed: a lock file against two runs at once, the per-chart MSD join key (chart hash) in the manifest, and D1's zip rules checked against its streaming extractor.
  - `ingest-packs.mjs`: Dan Reform and Drive packs.
  - HF `metadata.csv`: **ask the user first** (§3.1). Then assert its header has `beatmap_id`, `playcount`, `passcount` and `favourite_count` before using it.
  - Tests: the .sm fixtures go through `sm2osu` into rows; a stop chart is skipped; the MSD join is by chart hash.
- **E2 Fingerprints, groups, weights.**
  - Tests:
    - a mirrored copy and a 1.1x copy share a chartKey (the second gets rate 1.1);
    - an Etterna convert of a Songs map lands in the same songGroup;
    - the union-find is transitive;
    - pack and creator caps hold on a synthetic index;
    - the split stays stable when maps are added.
- **E3 Dataset v3 build** (after S3 merges).
  - Writes `.f32` v3, `.b32` v3, `.st.json`, the §3.4 labels and `mapper3/heldout.json` (§3.5). `report.json` adds the MSD calibration MAE, creator counts and the per-source dedupe table.
  - Do a `--limit 200` run first and check it by eye.
- **E4 `train_mapper.py` v3:** reads `mapper3`, adds `--mirror-tables`, `--styles`, `--msd-prior` and `--rate-variants`, and writes `xgb-v3`. Each ablation goes into `reports/mapper.md`.
  - Tests: `mapperParity` is extended to `stylePattern`; G's JS `msdPrior` lookup (`src/gen/msdPrior.js`, merged in G1) matches Python.
- **E5 `fun-labels.py`:** the residuals of §3.4, with a sanity report (the residuals do not correlate with star rating, |ρ| < 0.1). Skipped when the user declined `metadata.csv` (§3.1).

### R: critic, fun and style (new stream)

**Owns** `src/gen/criticFeatures.js`, `src/gen/critic.js` (replacing the P stub), `tools/make-critic-negatives.mjs`, `tools/train_critic.py`, `tools/eval-critic.mjs`, `tests/gen/{criticFeatures,critic}.test.js` and `tests/fixtures/critic-parity.json`. Writes `models/critic.json` (on SHIP only).

- **R1 `criticFeatures`** (after A2 and S2).
  - Tests:
    - names are stable and the count matches `CRITIC_FEATURES`;
    - a pure 1234 roll gives roll share 1 and jack rate 0;
    - a left-only map gives |left − 0.5| = 0.5;
    - mirroring keeps every hand-symmetric feature and swaps the column shares;
    - rows exactly on kick peaks give kick share 1;
    - a 3000-row map takes ≤ 10 ms (bench).
- **R2 Negatives:** `make-critic-negatives.mjs` with each perturbation as a pure function. Tests: each perturbation changes what it should and only that (for example, a column remap keeps the row times and sizes).
- **R3 Training:** human, fun and style heads; `norm`; `blend` defaults; parity probes. **Budget: under 3 h on the 5080 including sweeps.**
  - Column-mirror augmentation (§3.6): mirrored copies of positives and negatives (p = 0.5) are added as feature rows, in the same song group as the original so the split holds. Mirrored humans stay positives.
  - No fun head when there are no fun labels (§3.1).
- **R4 Blend tuning** on validation songs: grid over `wF`, `wP` and `wS`, maximising the §7 composite (dan hit, pattern accuracy, violations) of the picks. It writes `critic.json.blend`.
- **R5 (optional):** the window head for block retry.
- **`critic.js` tests:**
  - the heuristic critic orders by issues;
  - with a fixture critic, scores match `critic-parity.json` within 1e-6;
  - missing heads give null fields and are not counted;
  - the style term is used only when a style is set;
  - the personal term is used only when it is active.

### G: generator integration (new stream)

**Takes over from A2** `src/gen/generateLearned.js`, `src/gen/assign.js`, `src/gen/variants.js`, `src/gen/rowSources.js`, `src/gen/partReport.js`, `src/gen/request.js`, `src/gen/learnedModel.js` and their tests.

**New:** `src/gen/candidates.js`, `src/gen/echo.js`, `src/gen/msdPrior.js`, `tests/gen/{candidates,echo,msdPrior,generateCritic,generateRepeats}.test.js`.

- **G1 Candidate loop** (§2.1), with the heuristic critic.
  - `normalizeRequest` (`request.js`) accepts `candidates` (integer 1..20, default 1) and passes `style` and `repeats` through (their checks come in G4 and G2). `LEVELS`, `STEPS` and `targetNumeric` stay unchanged (§8.1).
  - `msdPrior.js`: `msdPriorOf(model, danMid, families)` → `Float32Array(8) | null`, and `msdFit(msd, target)` → number or null.
  - Tests:
    - `normalizeRequest` keeps `candidates` 1..20, clamps or refuses the rest, and defaults to 1; the three exports above are unchanged;
    - a model without `msdPrior` gives `msdFit` null and a stage-2 order without that term; a fixture `msdPrior` picks the closer-MSD candidate on a stage-1 tie;
    - `candidates: 1` gives the same `osuText` as before (golden);
    - N = 8 gives deterministic output per seeds;
    - the picked `noteSeed` reproduces the map with `candidates: 1`;
    - the time box stops at the deadline but keeps at least 4;
    - an out-of-range candidate never beats an in-range search best;
    - locked rows are identical in every candidate;
    - progress reports `candidates` with increasing `i`;
    - `rankVariants` puts the higher critic score first within one `patternScore` bucket.
- **G2 Repeats and phrases** (after S2).
  - `assignByParts` changes families only at phrase starts in mixed mode; `planBlocks` cuts at phrase starts; `echo.js` as in §2.3; `normalizeRequest` accepts `repeats` as a boolean (default false).
  - Tests:
    - with `repeats: true` on an A B A song, the second A's rows equal the first's except in varied bars, and the share of varied bars is within 0.25 ± 0.1 over 20 seeds;
    - the fill bar is always varied;
    - guard vetoes are re-sampled, never kept;
    - `repeats: false` gives v3 output bit for bit;
    - a phrase-aligned family switch is never in the middle of a phrase.
- **G3 Infill plumbing** (after N2).
  - `sourceFor` gets `kind === "nn-v2"` → `(await import("./nn/infillModel.js")).infillSource`.
  - `known` gets the locked rows only. Echo rows go per build through `step(i, fixed)` at strength 0.6 (§2.3).
  - `cond` gets `msdPrior` (null when the model has none: "unknown") and the style.
  - Own-range parts and block retry use `snapshot`/`restore` when `caps.infill` is set.
  - Tests use a fake infill source that records `known`, `fixed` and `prepare` calls: locked rows appear in `known`; echo rows never appear in `known` and arrive as `fixed`; `prepare` runs once per variant with N = 8; a non-infill source never receives `known` or `fixed`; a restore re-decodes only the block.
- **G4 Style for XGB:** `xgbMarkovSource` (`rowSources.js`) and the pattern sampling in `learnedModel.js` blend in `stylePattern` and `styleBias`; `normalizeRequest` accepts `style` (null or a string; the key check against `styles` stays in `createIpc.js`). Tests: a fixture style whose table always gives mask 5 raises the share of mask 5; `style: null` gives today's masks.
- **G5 (optional):** the `worker_threads` candidate pool (§5.3).

### U: ratings and UI (new stream)

**Owns** `app/ratingsStore.js`, `app/ratingsIpc.js` (taking over P's stub), `src/gen/personal.js` (taking over P's stub), `app/renderer/genOptions.js`, `app/renderer/ratingBar.js`, and `tests/{ratingsStore,ratingsIpc,personal}.test.js` and `tests/create/{genOptions,ratingBar}.test.js`.

**Takes over from B** `app/renderer/createTab.js`, `resultView.js`, `timeline.js` and `create.css` (U adds only the `/* >>> mapgen-ML */` block to it), with their tests, and the plan's `// ---- stream B ----` block of `src/i18n/messages/create.js` with the existing `create.*` keys. All new keys of §6 go into that block.

- **U0 Stems wiring in `createTab.js`** (after S1 and P-ml1).
  - Calls `computeStems` right after `onsetEnvelope` on song load, yielding every 2048 frames, with the status `create.ml.stems`; keeps the result with the song; builds `stemsToTransfer` and sends it as the top-level `stems` of `generate-map`.
  - A stems failure is logged and leaves `stems` absent; generation still works (the worker falls back, §9).
  - Tests: the call yields between chunks; the status shows and clears; the transfer is sent beside `envelope`; a thrown error leaves no `stems` and the request still goes out; a new song drops the old stems.
- **U1 Store, IPC, personal** (after P-ml1).
  - The store is created lazily from `deps.paths.userData` on the first handler call; the export goes to `deps.paths.docsDir` (§8.1).
  - Fitting runs only in the worker: `ratingsIpc` sends a `fit-personal` job through `deps.generatorClient` and caches the answer.
  - Tests:
    - the cap of 2000 keeps the newest;
    - bad tags are refused with `create.err.badRating`;
    - an unknown id gives `app.gen.unknownId`;
    - the export never overwrites;
    - `fitPersonal` on separable data reaches AUC 1;
    - a few `tooJacky` 👎 votes give negative jack weights (tag prior);
    - the model is inactive below the thresholds;
    - `registerRatingsIpc` with stub deps does no I/O and calls no dep;
    - a `rate-variant` call never fits on the main thread: it sends one `fit-personal` job after the 2 s debounce;
    - IRLS on 2000 × 250 converges within 25 iterations (bench, not a time assertion in `npm test`: about 0.5 s at 6 iterations on this machine, §2.7).
- **U2 UI** (after G1).
  - `genOptions` (N slider, style select from `generator-info`, repeats checkbox), the critic line, `ratingBar`, «только эту часть», phrase ticks and repeat underlines, and `CARDS_WITH_CRITIC`.
  - Tests:
    - the request carries `candidates`, `style` and `repeats`;
    - the stems (from U0) are sent when present;
    - «только эту часть» sends a lock of all other parts;
    - the critic line skips missing heads;
    - the vote buttons call `rateVariant` with the card's id;
    - Cyrillic appears only in messages (the existing i18n tests).
  - Smoke: `electron-ui.mjs create preview` at 480 px, both languages, no horizontal overflow.
- **U3:** «Учитываю твои оценки» after activation, and the export button.

### N: infill transformer (new stream; D keeps `nnModel.js` (nn-v1) and `requirements-nn.txt`)

**Owns** `tools/nn/{infill_model,infill_data}.py`, `tools/train_infill.py`, `tools/export_infill.py`, `src/gen/nn/{kernels,f16,infillModel}.js`, `tools/bench-nn.mjs`, `tests/gen/nn/{kernels,infillModel,kvCache}.test.js` and `tests/fixtures/infill-parity.json`.

- **N0** (at W3-0; needs D4's `requirements-nn.txt`).
  - Check torch on sm_120.
  - Write `kernels.js` and `f16.js`; `bench-nn.mjs` prints GFLOP/s and the projected §5.3 times for 3 sizes.
  - Tests:
    - matmul and matvec against a naive reference;
    - softmax is stable at ±80;
    - f16 decoding covers subnormals, ±0 and Inf;
    - local attention with an explicit key list equals dense attention masked to the same keys.
- **N1 Data loader and model** (after E3).
  - 512-beat windows from memmap, the masking schedule, mirroring, condition dropout.
  - Python tests (`pytest`, `.venv`): masks never hide visible slots in the loss; mirroring is an involution; window edges are correct.
- **N2 JS source and parity.**
  - `infillSource` with the encoder, static cross K/V, ring KV cache, lane head, `known` teacher forcing and `snapshot`/`restore`.
  - Tests:
    - parity with `infill-parity.json` within 2e-3 (skipped when the fixture is missing);
    - `known` slots, and `fixed` slots of `step(i, fixed)`, are always returned unchanged and consume no RNG;
    - changing `fixed` between builds never re-runs the encoder;
    - decoding the whole map equals decoding with a snapshot/restore at a block boundary;
    - raising the knob gives more rows;
    - `weightOf` 0 vetoes;
    - same seed, same output;
    - a dense model of 4 beats × 1 layer matches hand-computed logits.
- **N3 Training sweep** and export to `A:/SneezeyTrain/candidates/mapper-nn2-*.json`.
- **N4** The infill evaluation in `compare-mappers` (with V).
- **N5 (optional):** reward-filtered fine-tuning (§4.4).

### V: evaluation and ship (D owner)

**Edits** `tools/compare-mappers.mjs` and `reports/mapper.md`. **New:** `tools/blind-pack.mjs`, `tools/bench-gen.mjs`.

- **V1:** `--config` JSON (candidates, critic file, repeats, style), the repeat-consistency metric, the infill mode, the style-accuracy metric, and the second-critic anti-gaming check.
  - Tests (`tests/tools/`): the config parser; the blind pack randomises names and writes a key; the held-out assertion against the `mapper3` groups.
- **V2:** one ship decision per piece, in this order:
  1. candidates + heuristic critic;
  2. xgb-v3 (stems, mirror, weights);
  3. critic-v1;
  4. repeats;
  5. style;
  6. fun weight (recorded as «no data» and skipped when there are no fun labels, §3.1);
  7. nn-v2.
  - Each decision is recorded in `reports/mapper.md` with its blind-test result.
  - Version bump on any ship, as in §10.

**Rough effort**

| Stream | Effort | Notes |
|---|---|---|
| P-ml | 1 day | |
| S | 3 days | |
| E | 1 week wall-clock | mostly downloads and machine time; Etterna about 117 GB for the 130 big packs |
| R | 3 days + 1 day of training | |
| G | 4 days | |
| U | 3 days | |
| N | 1 week + about 2 days of GPU | |
| V | 2 days + the user's blind sessions | |

---

## 9. Risks and mitigations

- **The critic learns artefacts instead of quality.**
  - Positives are re-rendered through the same writer and grid, so there are no LNs and no timing artefacts.
  - Feature gains are reviewed in R3.
  - The anti-gaming second critic (§7) checks the picks.
  - The blind test decides.
- **Reranking overfits the critic** ("Goodhart").
  - Stage 2 keeps the dan and `patternScore` above the critic.
  - The blend is tuned on validation songs, never on test songs.
- **Time on friends' laptops.**
  - The candidate phase is time-boxed (`deadlineMs`).
  - N adapts, with at least 4.
  - The nn-v2 search budget is reduced; snapshots replace full re-decodes.
  - G5 threads only if needed.
- **Stems differ between Chromium and ffmpeg decoding.** Columns are relative (P99-normalised, beat shares). There is a correlation gate of ≥ 0.97 (S1), and parity tests run on the JS code that both paths share.
- **Stems missing in a session** (an old renderer path, or a tool that sends no stems): the worker falls back to a model without `needs`. The UI disables «Повторы» with a hint.
- **Structure false repeats** (loops in EDM) make maps monotonous. `pVar`, the fill bars, the guard, and the ship metric require the repeat-consistency gap to shrink, not to overshoot (gen Jaccard ≤ human + 0.1).
- **The fun signal is mostly song popularity.** Within-set residuals, `wF` ≤ 0.15, and it stays at 0 unless the blind test wins.
- **Style: too little data per creator, or the user wanting a name we cannot imitate.** Only creators with ≥ 30 diffs across ≥ 8 groups. The style is a reranking and table blend, not a promise. The UI shows the map count. Names are never written into maps.
- **Etterna charts differ in style from osu! rice** (dumps, files made for keyboards with other conventions). Per-pack caps; the source is one of the transformer's dropout conditions; the ablation on osu!-only validation songs must not lose.
- **Licences.** HF data is "osu-terms", for private training. Models contain no audio and no charts and stay in private builds for friends, like today's `mapper.json`. Nothing from the corpus is committed or packaged (§9).
- **The transformer is too slow or too weak in JS.**
  - N0 measures before training and shrinks the model when the laptop budget fails.
  - XGB v3 with critic, stems, style and repeats ships independently of the transformer.
- **Ownership collisions.** Every file has one wave-3 owner. Taking a wave-2 file waits for its merge. P and D files change only through P-ml and E tasks. Files frozen or owned by tabs-v2 change only inside their marked blocks or through a request to its integrator (§8.1).
- **Disk.** Etterna big packs about 117 GB, HF about 80 GB, `mapper3` about 15 GB of features. A: has 1.6 TB free.
- **Privacy of ratings.** Local only. `audioKey` is a short hash. Export is manual. There is no network call.

---

## 10. Explicitly NOT done in this addendum

- **Plan §13 "No transformer" is superseded** by this addendum for one thing only: the in-app nn-v2 infill model (§4.4), run in pure JS (§5). Everything else on that §13 line still holds.
- No Demucs or other neural source separation in this addendum (see §10.1 for the later optional module), no ONNX runtime in this addendum's code, no WebAssembly/SIMD kernels, no GPU in the app, and no Python or torch at runtime.
- No RL (PPO or similar) fine-tuning. Only the optional reward-filtered fine-tuning (N5), after reranking has proven itself.
- No cloud training, and no online learning from friends' ratings. Global training on ratings happens only from files users export by hand.
- No MSD skillset sliders in the UI. The target MSD comes from `msdPrior(dan, families)`.
- No new key counts, no LNs, no 1/12 or 1/16 (§13 of the plan still holds), and no changes to `analyzeChart`, `onset.js` or `dan_model.json`.
- No style for creators below the data threshold, no "style transfer" of a specific map, and no mapper names written into generated files.
- No graveyard expansion, no Malody converts, no archive.org Dan Archive and no 49 GB Drive ranked dump, unless the user approves them separately.
- No sharing of ratings between users, no accounts, and no server.
- No change to the outer "variants" contract (§1.2): one `generate-map` call is still one variant. N candidates live inside that call.

### 10.1 Later: high-quality stems, stream Q (out of scope here)

User decision: Demucs-style separated stems come **later**, as an **optional download**, in a separate stream "Q" with its own plan.
- **ONNX is allowed only inside that optional module.** Nothing in this addendum loads or requires ONNX, and the app works fully without Q.
- **The seam Q plugs into:** the top-level `stems` field of `generate-map` (§1.1).
  - Q produces a `StemsTransfer` of the same shape (`v: 1`, same curves, same frame grid as `onsetEnvelope`) from the separated sources, instead of or after the light HPSS stems of §2.2.
  - Validation, `stemsFromTransfer`, `slotFeatures` (by name) and `needs: ["stems"]` stay as they are, so light-stem models keep working with either.
  - Whether a model trained on Q's stems needs its own `needs` value, and where Q's job runs, are Q's decisions.

## 11. Amendment 2026-10-25 (user decisions): bigger models, GPU inference, distillation, more data

- **Size sweep for nn-v2 (stream N):** train three sizes on the same data and splits — S ≈ 0.6M (§4.4 as written), M ≈ 2.5M (d = 192, 6 encoder layers, decoder d = 96 × 3), L ≈ 10M (d = 320, 8 encoder layers, decoder d = 160 × 4). Same masking schedules, same export format (`kind: "nn-v2"`, a `size` field). Pick by the §7 metrics, not by size.
- **GPU inference in the app (new stream W, after N):** a WebGPU path for the nn-v2 kernels (matmul, attention with ALiBi, GELU, layer norm, the lane head) in the renderer process (WebGPU is available in Electron's renderer, not in the utility worker), with the same inputs/outputs and parity probes as the JS path (≤ 2e-3). Chosen automatically when `navigator.gpu` gives an adapter and the probe passes; CPU JS stays the fallback. The big model (L) runs only on the GPU path; without a GPU the app uses the distilled small model. Budget: ≤ 2 s per variant for L on a mid-range GPU. Also use the GPU path for the critic's stage-1 batch when available.
- **Distillation:** a student S-size model trained to match the best teacher's slot distributions (KL on the 16 logits, temperature 2) plus the usual cross-entropy; ships as the CPU model if it beats the plain S model on §7.
- **More data (user-approved 2026-10-25):** Drive "osu!mania Ranked + Loved 2013–2025" (18 .rar, 49 GB; RAR read with Windows' built-in bsdtar/libarchive 3.8.9, no install) → `A:/SneezeyTrain/ranked`; Malody 4K Converts from mirror.reenigne.net (41 zips minus the MSD 38–104 one, ~38 GB, .sm + audio) → `A:/SneezeyTrain/malody`. Both go through the corpus index and dedupe like every other source.
- **Model strength picker (user request, stream U + W):** in the create tab's `#gen-options`, «Сила модели» / "Model strength": **Авто** (default: the strongest size that the machine runs within budget — L with a working WebGPU adapter, else the distilled S), **Быстрая** (S), **Сбалансированная** (M), **Мощная** (L). Each choice shows the measured time per variant on this machine (a 1-variant probe on first use, cached in userData) and whether it runs on the GPU or the CPU; L without a GPU is allowed but marked «медленно (без видеокарты)» with the estimated time. The request carries `modelSize: "auto"|"s"|"m"|"l"`; the worker/renderer loads `mapper-nn2-<size>.json` lazily; a missing file falls back to the next smaller size with a note. The choice is remembered. i18n keys in U's block of create.js (ru + en).
