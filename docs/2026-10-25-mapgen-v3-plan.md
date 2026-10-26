# Map generator v3: implementation plan

- **Date:** 2026-10-25.
- **Repo:** `dan-analyzer`.
- **Base branch:** `feature/v3`, clean at `7cd75f9`.
- **Sources:** five designs: preview-timeline (features 1 and 3), quality (2, 4, 5), timing (6), output (7–10) and model (corpus and model).
- **Precedence:** where the designs disagree, this plan wins. Where this plan says nothing, the design for that feature applies.

User request: «Делай всё и обучи ии на намного больших картах, чтобы было идеально». That means all ten features, plus a much bigger training set and a better model.

---

## 0. Facts checked while integrating

**Corpus download**
- `tools/fetch-train-sets.mjs` already exists (commit `7cd75f9`) and is **running right now** into `A:/SneezeyTrain`.
- The run started at 16:26 local. Its manifest has 6147 sets and 14,857 tracker-labelled diffs. The sets were picked round-robin over dan 1–18, by playcount, and sets already in Songs were skipped by folder id.
- 22 sets were done after about 10 minutes, so the whole run takes about 10 h.
- The model design's `fetch-tracker-corpus.mjs` is **not** built. Stream D extends the existing script, but only after the current run finishes.
- The script has no lock file. **Never start a second run while this one is running.**
- So far one set failed with "bad central directory" (set 1985457, probably zip64). That failure is not marked final, so the next run retries it.

**Model and data**
- `models/mapper.json` is v1.
  - It has 17 names in `model.features`, plus `conditioning`, `families`, `note`, `size`, `pattern`, `metrics` and `parity`.
  - It is gitignored, and so is `data/`.
  - The current dataset is in `data/mapper` (6326 maps; its `heldout.json` lists set names).

**Current code**
- `ipcMain.handle("generate-map")` in `app/main.js` saves the .osz immediately.
- `generateLearnedMap(input, analyze, model)` returns `{osuText, result, offset, reachable, noteCount, version, engine, patternScore}`.
- Tests call it with the legacy `timing: {bpm, offsetMs}`.

**Tests and page constraints**
- `tests/i18n-coverage.test.js` forbids Cyrillic outside `src/i18n/messages`.
- `tests/i18n-tabs.test.js` reads a fixed `SOURCES` list.
- `tests/i18n.test.js` checks that every key appears once, in both languages, with the same `{slots}`.
- The CSP is `img-src 'self' https://assets.ppy.sh data:` and `media-src 'self' blob:`.
  - The playfield uses Web Audio on the AudioBuffer that is already decoded, so no CSP change is needed.
  - A background thumbnail can use a `data:` URL.

---

## 1. Conflict resolutions (binding)

1. **Generating never writes a file.**
   - `generate-map` returns a store id.
   - All writing goes through **one** channel, `export-set`. It replaces `save-generated-map`, `save-generated` and `generate-diff` from the individual designs.
   - The renderer never sends .osu text or an output path to be written. It sends ids only.
2. **One `generate-map` call makes one variant.**
   - "3 variants", "another variant", "regenerate the unlocked parts" and "mapset" are all loops in the renderer over that one call.
   - The renderer ranks variants with `rankVariants` from `src/gen/variants.js`.
3. **Two units: part and block.**
   - **Part** = a song part from `detectParts`, which the user can edit. It is the unit for:
     - the timeline;
     - per-part pattern and dan;
     - the accuracy badge;
     - **locking**.
   - **Block** = an internal unit used for RNG streams and auto-retry. A block is a run of slots inside one part with one assigned family. In mixed mode it is a 32-slot chunk.
     - A block is at least 32 slots. A shorter block merges into the previous block of the same part.
   - The two designs' `parts.js` files become two files:
     - `src/gen/songParts.js`: detection (the preview design);
     - `src/gen/partReport.js`: blocks and scoring (the quality design).
4. **Parts are always present.**
   - The renderer always sends `request.parts`, whether detected or edited.
   - The worker detects them itself when they are missing (tools, smoke tests).
   - Pattern sections always start at part starts (`assignByParts`).
5. **Determinism.**
   - v3 output differs from v2 for the same seed, because of per-block RNG and the playability guard. Seeds are not stored anywhere, so this is accepted.
   - The preview design's "old path stays bit for bit" requirement is dropped.
   - Tests instead check that output is deterministic for a given `(planSeed, noteSeed, parts)`.
6. **Seeds.**
   - `seed` is the legacy field and the default for `planSeed` and `noteSeed`.
   - `planSeed` drives pattern assignment and the snap path.
   - `noteSeed` drives rows.
   - A block's streams use `deriveSeed(noteSeed, part.seed ?? partIndex, blockInPart)`, a new function in `src/gen/rng.js`.
7. **A part's dan is measured on an excerpt.**
   - `excerpt.js` repeats the part until it lasts at least 30 s and has at least 80 notes, and caps it at 120 s.
   - The badge says the dan is "as if played on its own".
   - It is used to search parts that have their own range, and for display. **Retry and revert decisions for the whole map use the whole-map analysis only.**
8. **Timing.**
   - `Timing.sections[]` replaces `{bpm, offsetMs}`. Both old fields stay as mirrors of `sections[0]`, and legacy input is accepted (`timingSections()` in `grid.js`).
   - Detection moves to the worker (`detect-timing`). The old renderer-side `detectTiming` stays as a fallback.
9. **Snap divisors.**
   - The divisor of each beat is one of {4, 3, 6, 8}. 1/12 and 1/16 stay off-grid. The generation default is `[4]`.
   - With the v1 model, divisors come from rules (`snap.js`) and the UI marks them β.
   - With a model that has `grid: "snap-v2"`, divisors come from the model's divisor head.
   - One function decides which: `chooseBeatDivs`.
10. **Feature list.**
    - There is one v2 list (§2.8). Columns are selected **by name** from `model.features`.
    - On an all-1/4 grid the v1 columns are bit-identical to today's.
11. **Row source.**
    - The row-source interface (§2.7) is the only seam between the generator and any model: XGB + Markov today, the neural model later.
    - Playability is a weight function passed into it.
    - Locked rows are handled outside it, in `generateLearned.js`.
12. **One snap palette for notes and grid lines**, by beat fraction: 1/1 red, 1/2 blue, 1/3 purple, 1/4 yellow, 1/6 pink, 1/8 orange. It lives in `app/renderer/snapColors.js`.
13. **Keys.**
    - Arrow keys act on the focused canvas: the playfield seeks ±2 s, the wave strip nudges the offset ±1 ms (±5 ms with Shift).
    - Space plays or pauses unless an input or select has focus.
14. **Corpus and dataset.**
    - The corpus is the `fetch-train-sets.mjs` output in `A:/SneezeyTrain`.
    - Dataset v2 goes in `A:/SneezeyTrain/mapper2`.
    - The held-out split is a hash of `songKey`, so it stays stable as the data grows.
15. **Preview point.**
    - It is computed in the renderer by stream C when a song loads.
    - The generated .osu keeps `PreviewTime` at 40% until `export-set` applies `meta.previewMs`.
16. **One audio player** in the renderer: B's `audioPlayer.js`. It serves the timing check, the playfield and listening to the preview point.
17. **Frozen shared files.**
    - `index.html`, `main.js`, `preload.cjs`, `workerClient.js` and `analysisWorker.js` are edited by stream P in P0, and are frozen after that except for P's own later tasks.
    - New UI is built by JS into the containers P0 creates.
    - P0 also creates stubs for every module that crosses a stream boundary, so every branch can import them from day 1.

---

## 2. Contracts

### 2.1 Timing

```js
Timing = {
  sections: [{ timeMs: number, bpm: number, meter: 4 }], // sorted, 1–256; sections[0].timeMs = first red line
  bpm: number, offsetMs: number,                           // mirrors of sections[0], for old callers
  confidence?: number, variable?: boolean, refinedErrMs?: number,  // from detect-timing, display only
}
```

- Red lines are written rounded to whole ms. The beat length keeps full precision (`60000 / bpm`).
- `timingSections(t)` (grid.js) accepts either `Timing` or `{bpm, offsetMs}`.

### 2.2 `generate-map` request

From the renderer to main, through `danApi.generateMap(req)`:

```js
{
  jobId: string,                      // made by the renderer, echoed in progress events
  audioPath, title, durationMs,
  envelope: EnvelopeTransfer,         // envelopeToTransfer(onsetEnvelope(...)), unchanged
  timing: Timing,
  request: {
    range: { lo, hi },                // danRange(...); the old `target` still works for tools
    patterns: [{ name, share }],      // normalizeShares
    mix: "sections" | "mixed",
    stamina: 0..1, burst: 0..1,
    seed: int,                        // legacy, default of the two below
    planSeed?: int, noteSeed?: int,
    snaps?: number[],                 // subset of [4,3,6,8], must contain 4; default [4]
    normalizeSv?: boolean,            // default true: green lines that cancel BPM scroll changes
    parts?: PartSpec[],               // ≤ 24
    lock?: { fromId: string, parts: int[] },   // indexes into `parts`; main resolves it (below)
  },
}
PartSpec = { startMs, endMs, kind: "intro"|"build"|"drop"|"break"|"outro"|"part",
             range?: { lo, hi }, patterns?: [{ name, share }], empty?: boolean, seed?: int }
```

**Validation** happens in main (`app/createIpc.js`). A failure returns `{ ok: false, code: "badRequest", message }`.
- Sections: strictly sorted; `timeMs` in [0, durationMs); `bpm` in [40, 400]; `meter` an integer from 1 to 16.
- Snaps: a subset of {4, 3, 6, 8} that contains 4.
- Parts:
  - at most 24;
  - each own range has 0 ≤ lo < hi ≤ 21;
  - at most 8 parts have their own range;
  - pattern names are in `PATTERN_NAMES`.
- Lock: all of the following must hold, or main returns `{ ok: false, code: "timingChanged" }`:
  - `fromId` is in the store;
  - the base map has the same `audioPath`;
  - the sections are equal (`timeMs` within ±0.5, `bpm` within ±1e-6);
  - each locked part's `[startMs, endMs]` matches the request's part within ±1 ms.

**Worker payload** (main to worker): the same request, with `lock` replaced by

```js
locked: { rows: [{ t, mask }], ranges: [[startMs, endMs]], knob: number, planSeed: int }
```

- `rows` is `parseRows(base.osuText)` filtered to the locked ranges.
- The payload also carries `meta: { title, audioFilename: audioNameFor(audioPath) }`.
- The worker runs `normalizeParts` and `normalizeRequest` again, because it never trusts the renderer.

### 2.3 `generate-map` response

```js
{ ok: true, id,                         // store id: the only handle for saving and locking
  engine: "neural" | "learned" | "rules",
  modelInfo: { kind: "xgb-v1"|"xgb-v2"|"nn-v1"|"rules", grid: "q4"|"snap-v2", maps: int },
  version, osuText,                     // osuText feeds the playfield; it is never sent back for saving
  result,                               // analyzeChart of the whole map (unchanged shape)
  reachable, range, noteCount, patternScore,
  knob, planSeed, noteSeed,
  stats: RowStats, issues: Issue[],     // at most 50 issues
  parts: PartReport[],
  retries: { blocks: int, dan: "low" | "high" | null },
  grid: { 4: share, 3: share, 6: share, 8: share },   // share of rows on each divisor
  ms: int }
| { ok: false, code: "badRequest" | "timingChanged" | "failed", message }

RowStats   = { notes, rows, sizeShares: [s1,s2,s3,s4], leftShare, colShares: [c0,c1,c2,c3],
               maxJack: { all, streamy }, peakNps, forced }
Issue      = { t, kind: "jack"|"anchor"|"hand"|"fastJack"|"spike"|"columns", col?, n?, pct?, ms? }
PartReport = { index, startMs, endMs, kind, families: string[], wanted: {lo,hi} | null,
               empty, locked, noteCount, patternScore: number | null,
               dan: { numeric, label, top3 } | null, inRange: boolean | null, issues: int, retried: int }
```

- `maxJack.streamy` counts only Stream, Jumpstream, Handstream and Tech blocks.
- `PartReport.dan` and `patternScore` are null for empty parts and for parts with fewer than 24 rows.
- `inRange` is set only when `wanted` is set.

### 2.4 Progress

- **Worker to main:** `{ id, progress: { phase, i, n, kind? } }`. Each progress message re-arms the 180 s timeout in `workerClient`.
- **Main to renderer:** channel `generate-progress` with `{ jobId, phase: "prepare"|"partSearch"|"search"|"retry"|"describe", i, n, kind? }`.

### 2.5 Other channels

All of these use `ipcMain.handle`, except `show-map`, which uses `ipcMain.on`.

| Channel | Input | Output | Owner |
|---|---|---|---|
| `detect-timing` | `{ envelope, fine: { values: Float32Array, hopSec }, hint?: Timing }` | `{ ok, timing: Timing, modelInfo }` | P (the function comes from A1) |
| `export-set` | `{ ids: string[1..8], meta: { title, artist, source, tags, creator }, previewMs: number\|null, background: { mode: "none"\|"image"\|"danCourse", imagePath? }, rates: number[≤3], pitch: boolean }` | `{ ok, file, entries: [{ version, label, numeric, rate }] }` | C |
| `song-tags` | `audioPath` | `{ ok, artist, title }` | C |
| `remap-load` | `{ file } \| { current: true }` | `{ ok, path, name, ok4k, rice, numeric, label }` | C |
| `remap-create` | `{ path, range: {lo,hi}, seed }` | `{ ok, file, version, numeric, label, reachable, removed, added }` | C |
| `open-map`, `show-map` | unchanged: a file inside the maps folder | unchanged | P |

**`detect-timing` with a hint.** With `hint`, detection refines around the hinted values (used by «Подогнать по волне») instead of starting from scratch.

**`export-set` rules**
- All ids must share one `audioPath`.
- File name:
  - one id and no rates gives today's `saveGeneratedMap` name, `${title} [${version}].osz`, so `export.test.js` keeps passing;
  - anything else gives `${artist} - ${title} (mapset).osz`.
- A file is never overwritten.
- `imagePath` must be .jpg, .jpeg or .png, at most 15 MB.
- Each rate must pass `validRate` and must not be 1.

**`remap-create` rule.** It only accepts paths that `remap-load` returned in this session (a Set in main).

**`preload.cjs` additions** (made in P0):
- `generateMap` keeps its name, with the new behaviour;
- `onGenerateProgress(cb)`, which returns an unsubscribe function;
- `detectTiming`, `exportSet`, `songTags`, `remapLoad`, `remapCreate`.

### 2.6 Store (`app/generatedStore.js`, owned by P)

- `createGeneratedStore({ max = 24 })` returns `{ put(entry) → id, get(id), has(id) }`.
- It is an LRU. Ids come from `crypto.randomUUID()`.
- An entry holds `{ osuText, version, title, audioPath, timing, parts, knob, planSeed, noteSeed, engine, result, range }`.

### 2.7 Core JS contracts

**Generators**
- Signatures:
  - `generateLearnedMap(input, analyze, model, opts = {})`;
  - `generateMap(input, analyze, opts = {})`, the rule-based fallback.
- `opts = { onProgress?(p), patternsOf?(osuText) → [{ name, share }] }`.
- The default `patternsOf` is `patternShares(analyzePatternFromText(text, 1).report)`.

**Slots** (A1, `grid.js`)
- `slotsForTiming(timing, endMs, { divOf = () => 4 })` = `slotsForBeats(beatsFromTiming(sectionsToPoints(timingSections(timing)), endMs), divOf)`.
- A slot is `{ t, beat, sub, div, pos, bpm, beatMs }`.
  - `t` is rounded, and computed as `p.time + (j·div + pos)·beatLength/div`. This makes an all-1/4 grid equal `buildSlotsFromTiming` on `t`, `sub` and `bpm`.
  - `beat` is a global beat index.
  - `sub` is the nearest quarter: `round(pos·4/div) mod 4`.

**Divisors** (A1, `snap.js`)
- `chooseBeatDivs({ envelope, beats, allowed, model, dan, families, rng })` returns a `Uint8Array` with one divisor per beat.
- When `model.divisor` exists, it uses the classifier plus a path sampled from `model.snapTransitions`. Otherwise it uses `detectBeatSnaps`.

**Row source** (A2, `rowSources.js`)
- `sourceFor(model)` returns a source.
- `source.prepare({ model, audio, slots, dan: Float64Array, family: string[] })` returns `{ step(i, offset, ctx, rngs, weightOf) → mask }`. A mask of 0 means no row.
- The arguments of `step`:
  - `ctx = { prev, prev2, recent }`, where `recent` holds the last 8 rows as `{ mask, gapMs }`;
  - `rngs = { fill, size, pattern }`;
  - `weightOf(mask)` returns a weight of 0 or more (the guard). When every candidate is 0, the source must return `weightOf.fallback()`.
- The XGB source calls `fill()` and `size()` exactly once per slot, as the code does today.
- `model.kind === "nn-v1"` loads `(await import("./nnModel.js")).neuralSource`. D owns `nnModel.js`.

**Guard** (A2, `playability.js`)
- `createGuard({ slots })` returns `{ push(mask, i, family), weight(mask, i, family, ahead), fallback(i, family), forced }`.
- The same file exports `rowStats(rows, slots)`, `findIssues(rows, slots)` and `LIMITS`.

**Writer** (A1)
- `toOsu({ rows, timingPoints?, bpm, offsetMs, normalizeSv = true, breaks = [], beatDivisor = 4, title, artist, version, audioFilename, creator, previewMs })`.
- Extra fields on rows are ignored.

**Remap** (C)
- `remapChart({ osuText, range, seed }, analyze, model, { onProgress })` returns `{ osuText, result, reachable, removed, added, version }`.

### 2.8 Model JSON contract (D produces it, A2 consumes it)

**Keys**
- All existing keys stay.
- New optional keys:
  - `kind`: "xgb-v2" or "nn-v1"; absent means "xgb-v1";
  - `grid`: "snap-v2"; absent means "q4";
  - `divisor`: a tree spec over `BEAT_FEATURES` plus `conditioning`, with classes [4, 3, 6, 8];
  - `snapTransitions`: a 4×4 table;
  - `patternOrder`: 2 or 3;
  - `danCalibration`;
  - `metrics.maps`.
- Every model that ships keeps `families` and `pattern` in today's shape. Remap and the neural model's prior use them.

**`AUDIO_FEATURES_V2`** = v1's 17 names plus `["div", "phase", "is_third", "beat_on3", "beat_on4", "beat_on8"]`.
- `phase` = pos/div.
- On beats that are not 1/4:
  - `sub` = round(phase·4) mod 4;
  - `is_beat` = 1 when pos = 0;
  - `is_half` = 1 when phase = 0.5;
  - `slot_ms` = beatMs/div.
- The energy lookback is the slot at the same phase 4 beats earlier, which is exactly i−16 on a 1/4 grid.
- The beat max is taken over the slots with the same `beat`.

**`BEAT_FEATURES`** (`snap.js`) = `s0…s11` (onset at the twelve 1/12 positions, divided by the beat max), then `beat_max`, `energy` and `bpm`.

---

## 3. Streams, ownership, order

| Stream | Scope | Branch | Starts after | Effort |
|---|---|---|---|---|
| **P** plumbing | IPC, worker, store, shells, stubs | `v3/plumbing` | nothing | P0: 0.5–1 day, then small tasks |
| **A1** timing and grid core | `src/audio`, grid, snaps, features, writer | `v3/core-timing` | P0 merged | 3 days; A1.1 merges on day 1 |
| **A2** generator core | parts, rules, retry, variants, search | `v3/core-gen` | A1.1 merged | 4 days |
| **B** create-tab UI | renderer for features 1, 2, 3, 5, 6 and the mapset loop | `v3/ui` | P0 merged | 4 days |
| **C** output | features 7 (export), 8, 9, 10 | `v3/output` | P0 merged | 3 days |
| **D** data and model | corpus, dataset v2, training, evaluation | `v3/model` | D1 now; D2 after A1; D5 after A2 | about 1 week wall-clock, mostly machine time |

**Merge order:** P0 → A1 → A2 → C → B → D. D's model ships only with a SHIP verdict (§10).
- Every branch rebases on `feature/v3` before it merges.
- `npm test` must be green at every merge.
- Use a git worktree per stream.

**Rules for shared files**
- **i18n.** P0 adds marked blocks (`// ---- stream B ----`, and so on) to `create.js`, `app.js` and `gen.js`.
  - Each stream edits only inside its own block and only uses its own key prefixes.
  - The existing `create.*` keys belong to B.
  - `html.js` belongs only to P (P0).
- **CSS.** B writes `app/renderer/create.css` and C writes `app/renderer/export.css`. `styles.css` is frozen.
- **`index.html`** is edited only by P (P0 and P-final).
- **`.gitignore`** is owned by D.

---

## 4. Stream P: plumbing

**Owns** `app/main.js`, `app/preload.cjs`, `app/workerClient.js`, `app/analysisWorker.js`, `app/generatedStore.js` (new), `app/createIpc.js` (new), `app/renderer/index.html`, `app/renderer/renderer.js`, `src/i18n/messages/html.js`, `src/i18n/messages/index.js`, `package.json`, `tests/workerClient.test.js`, `tests/generatedStore.test.js` (new), `tests/createIpc.test.js` (new), `tests/i18n-tabs.test.js`, `tests/smoke/electron-generate.mjs`, `tests/smoke/electron-worker.mjs`.

**Creates as stubs, then hands to C:** `app/exportIpc.js`, `app/renderPng.js`, `app/renderer/exportPanel.js`, `app/renderer/remapPanel.js`.

**Also in P0:** the block markers in the message files, and one compatibility edit in `createTab.js` (task 9).

**P0 tasks** (in order, test first)

1. **`workerClient.js`.**
   - Add `generate(payload, onProgress)`, `detectTiming(p)` (20 s timeout) and `remap(p, onProgress)`.
   - A message with `progress` calls the callback and re-arms the timer. Each request still settles exactly once.
   - Tests: progress reaches the callback; the timer is reset; there is one settle; a timeout still kills the worker.
2. **`analysisWorker.js`.**
   - Kinds: `analyze`, `generate`, `timing` (→ `detectTimingFull` from `src/audio/timingJob.js`) and `remap` (→ `remapChart` from `src/gen/remap.js`).
   - Use **dynamic imports per kind**, so a module that is missing only breaks its own kind.
   - Model load order: `models/mapper-nn.json`, then `models/mapper.json`, then the rule-based generator.
   - Pass `onProgress: (p) => process.parentPort.postMessage({ id, progress: p })`.
   - `timing` also returns `modelInfo`.
3. **`generatedStore.js`**, with tests for LRU eviction and unknown ids.
4. **`createIpc.js`**, exporting `registerCreateIpc({ ipcMain, generatorClient, store, log })`.
   - `generate-map`: validate (§2.2), resolve the lock, forward progress with `event.sender.send("generate-progress", …)`, put the result in the store, and return §2.3.
   - `detect-timing`.
   - Tests use a fake `ipcMain` and a fake client. They cover each validation case, a lock that works, `timingChanged`, progress forwarding, and that **no file is written**.
5. **`main.js`.**
   - Replace the inline `generate-map` with `registerCreateIpc` plus `registerExportIpc` (from `app/exportIpc.js`).
   - Move `renderPng` to `app/renderPng.js` as `createPngRenderer(BrowserWindow)`. Marathon keeps using it, injected as now.
   - Set `CREATE_TAB_SIZE` to `{ width: 480, height: 880 }`. The tab scrolls.
6. **Stubs.**
   - `exportIpc.js`: `export-set` for exactly one id with no rates, through `saveGeneratedMap`. `song-tags` and the `remap-*` channels return `{ ok: false, message: t("app.notReady") }`.
   - `exportPanel.js` exports `initExportPanel(opts) → { onSongLoaded() {}, onSelectionChanged() {} }`.
   - `remapPanel.js` exports `initRemapPanel(opts) → {}`.
7. **`preload.cjs`**: add the methods listed in §2.5.
8. **`index.html` shells.** Static headers only; their texts go in `html.js`.
   - `#create-mode` chips (`data-mode="song"` and `"remap"`).
   - `#song-mode`, wrapping the existing groups.
   - Inside the Timing group: `#timing-sections`, `<canvas id="wave-strip" tabindex="0">` and `#snaps`.
   - In the Dan group, wrap the old from/to rows in `#dan-rows` and add `#diffs`.
   - New group `#parts-group`, containing `<canvas id="timeline">` and `#part-editor`.
   - New group `#preview`, containing `<canvas id="playfield" tabindex="0">` and `#play-controls`.
   - After `#gen-result`: groups `#meta-group` and `#export-panel`.
   - `#remap-panel`, hidden.
   - `<link>` tags for `create.css` and `export.css`.
   - In `renderer.js`, `showTab` also dispatches `window.dispatchEvent(new CustomEvent("tab-shown", { detail: tab }))`.
9. **Compatibility edit in `createTab.js`**, so the app keeps working until B lands: after `generateMap`, call `exportSet({ ids: [answer.id], … })` and keep today's result card. B branches after P0, so this causes no conflict.
10. **`tests/i18n-tabs.test.js`**: `SOURCES` becomes every `app/renderer/*.js` plus every `src/gen/*.js`, and the fake DOM gets a stub for `canvas.getContext`.
11. **Smoke tests.** `electron-generate.mjs` uses the new response (id, no file), then saves through the export function. `electron-worker.mjs` covers the `timing` kind.

**Later P tasks**
- P1: add a `generate-map` log line with `ms`, `retries` and `forced`.
- P-final: remove the dead `#dan-rows` markup after B merges, bump the version to 0.8.0, and run `npm run dist` once.

**Live check for P0**
- Run `npm test`.
- Run `npx electron tests/smoke/electron-generate.mjs <out>`: it should print the store id, the saved file and the zip entries.
- Run `npm start`, then «Создать карту» → «Создать карту»: it should behave exactly as today, with the file saved through `export-set`.

**i18n keys for P**

| Key | Russian | English |
|---|---|---|
| `html.create.modeSong` | «Из песни» | "From a song" |
| `html.create.modeRemap` | «Из готовой карты» | "From an existing map" |
| `html.create.parts` | «Части песни» | "Song parts" |
| `html.create.preview` | «Предпросмотр» | "Preview" |
| `html.create.metadata` | «Метаданные» | "Metadata" |
| `html.create.save` | «Сохранение» | "Saving" |
| `app.gen.badRequest` (app.js) | «Неверный запрос: {what}» | "Bad request: {what}" |
| `app.gen.unknownId` | «Эта карта уже забыта — создай её заново» | "This map is no longer in memory — generate it again" |
| `app.notReady` | «В этой версии ещё не готово» | "Not available in this build yet" |

---

## 5. Stream A1: timing and grid core (feature 6, plus the triplet-ready data path)

**Owns** `src/audio/tempo.js`, `src/audio/fineOnset.js` (new), `src/audio/timingJob.js` (new), `src/gen/grid.js`, `src/gen/snap.js` (new), `src/gen/slotFeatures.js`, `src/gen/mapRows.js`, `src/gen/writer.js`, `tools/eval-timing.mjs` (new), `tests/gen/audio.test.js`, `tests/gen/fineOnset.test.js` (new), `tests/gen/grid.test.js` (new), `tests/gen/snap.test.js` (new), `tests/gen/slotFeatures.test.js`, `tests/gen/mapRows.test.js`, `tests/gen/writer.test.js` (new), `tests/fixtures/clickTrack.js`.

**Does not touch** `src/audio/onset.js`. `frameTimeSec` stays as it is, because the model was trained with it. The bias is corrected inside timing detection only.

**Tasks** (test first)

**A1.1 Grid contract.** Merge this on day 1, because A2 and B use it.
- `timingSections`, `sectionsToPoints` → `[{ time, beatLength, meter }]`, `beatsFromTiming(points, endMs)` → `[{ t, beatMs, bpm, index }]`, `slotsForBeats`, `slotsForTiming`, and `clickTimes(points, fromMs, toMs, div)`.
- Keep `buildSlots` and `buildSlotsFromTiming`.
- Tests:
  - an all-1/4 grid equals `buildSlotsFromTiming` on `t`, `sub` and `bpm`, for single and multiple red points;
  - a 1/6 beat has 6 evenly spaced slots and the expected `sub` values;
  - legacy `{bpm, offsetMs}` is accepted.

**A1.2 Writer.**
- `timingPoints`: write one red line per point.
- Green lines: when `normalizeSv` is on and a section's BPM differs from the dominant BPM (by time, same rule as `dominantBeat` in `features.js`), add `${round(time)},${-100*bpm/mainBpm},${meter},2,0,60,0,0` at the same time.
- `breaks`: write `2,start,end` lines under `//Break Periods`, only for gaps of at least 3 s.
- `beatDivisor`: 12 if 1/3 or 1/6 is used, 8 if 1/8 is used, else 4.
- Tests:
  - 3 sections give 3 red lines and 2 green lines with the right values;
  - `parseRedTimingPoints(toOsu(...))` round-trips;
  - `rateOsu` scales only the red lines and keeps the green ones;
  - break lines are written.

**A1.3 `mapRows.js`.**
- `labelSlots` tolerance becomes `min(12, slotStepMs/3)`. It is identical on 1/4 grids up to 416 BPM.
- `labelBeatSnaps(rows, beats, allowed = [4,3,6,8])` returns a `Uint8Array`: for each beat, the smallest grid, tried in the order 4, 3, 6, 8, that holds all of the beat's rows within `min(12, step/3)`. 0 means off-grid.
- Tests: pure 1/4; a triplet beat; 1/6; jittered 1/4 stays 4; 1/16 is 0.

**A1.4 `snap.js`.**
- `BEAT_FEATURES`, `beatFeatures(envelope, beats)` and `gridShares(rows, slots)`.
- `detectBeatSnaps(envelope, beats, allowed)` uses the onset mean at the positions unique to each grid:

  | Grid | Positions |
  |---|---|
  | 1/4 | 1/4, 3/4 |
  | 1/3 | 1/3, 2/3 |
  | 1/6 | 1/6, 5/6 |
  | 1/8 | odd eighths |

  - A beat gets a grid other than 1/4 only if that grid scores above 1.5 × the 1/4 score and above the noise floor.
  - Then a 3-beat median filter is applied, and a triplet run is kept only if it lasts at least 2 beats.
- `chooseBeatDivs` (§2.7).
- Tests:
  - a triplet click section is detected;
  - 1/4 clicks never give 1/3;
  - `allowed = [4]` gives all 4;
  - a fake `model.divisor` tree is used when present.

**A1.5 `slotFeatures` v2.**
- `AUDIO_FEATURES_V2`, and `slotFeatures(envelope, slots, bpm, names = AUDIO_FEATURES)` returning the requested columns in that order.
- Group beats by `slot.beat`, and use the lookback described in §2.8.
- Tests:
  - **bit-identical v1 rows on an all-1/4 single-BPM grid**;
  - finite values on a mixed grid;
  - selection by name.

**A1.6 Timing detection.**
- In `tempo.js`, add `detectTimingSections(envelope, { fine, maxSections = 32, hint })`:
  - a local tempogram over 10 s windows every 2.5 s;
  - a Viterbi pass with a high cost for changing BPM and an extra cost for ×2 and ×½;
  - for each section: refine the BPM by ±2.5 in 0.005 steps; take the phase from the low band;
  - round to a whole BPM only when the drift over the section stays under 3 ms;
  - merge neighbouring sections that differ by under 0.05%;
  - drop sections shorter than 8 beats unless their score margin is over 2×.
- `detectTiming` keeps its current behaviour and tests. When only one state survives, the result equals it.
- `fineOnset.js`:
  - `fineOnset(samples, sr, hop = 32)`;
  - `refineOffset(fine, section, { rangeMs = 15, stepMs = 0.1 })`, with a parabolic peak;
  - `OFFSET_BIAS_MS`, fitted by A1.7 and starting at about 6.
- `timingJob.js`: `detectTimingFull({ envelope, fine, hint })` → `Timing`.
- Tests:
  - a click track 140→180 BPM at 20 s gives 2 sections, the start within 15 ms and the BPM within 0.05;
  - constant 174 BPM gives `variable === false` and the same result as `detectTiming`;
  - a double-time hi-hat track does not split;
  - clicks at 312.4 ms are refined to within 1 ms.
- Add `tempoMapTrack(sections)` and a `triplets` option to `tests/fixtures/clickTrack.js`.

**A1.7 `tools/eval-timing.mjs`.**
- Compares the human red lines against `detectTimingFull` on held-out maps, including multi-BPM maps.
- `--decoder ffmpeg|chromium`. The chromium mode runs under `npx electron` to fit `OFFSET_BIAS_MS` on the app's own decode path.
- Targets:

  | Metric | Target |
  |---|---|
  | BPM within 0.05 | 85% or more |
  | Offset within 5 ms, on maps with the right BPM | 70% or more (today 5/48) |
  | Multi-BPM songs with the right section count | 80% or more |
  | False splits on single-BPM songs | 2% or fewer |
  | Time for a 5-minute song | 300 ms or less |

**i18n for A1:** none. A1 has no user-visible text; the UI is in B.

**Live check for A1:** `npm test`; `node tools/eval-timing.mjs "A:/Games/osu!/Songs" data/mapper`; and the chromium run.

---

## 6. Stream A2: generator core (features 2, 3, 4, 5 and the per-part search)

**Owns** `src/gen/generateLearned.js`, `src/gen/generate.js`, `src/gen/learnedModel.js`, `src/gen/search.js`, `src/gen/assign.js`, `src/gen/request.js`, `src/gen/rng.js`, plus these new files: `src/gen/songParts.js`, `src/gen/excerpt.js`, `src/gen/playability.js`, `src/gen/partReport.js`, `src/gen/variants.js`, `src/gen/rowSources.js`, `src/gen/metrics.js`.

**Also owns** `tools/eval-generator.mjs`, `tools/eval-parts.mjs` (new), and the tests `tests/gen/{songParts,partsRequest,excerpt,playability,partReport,variants,generateParts,metrics,rowSources}.test.js` (new), `tests/gen/{generateLearned,searchRange,generate,learnedModel}.test.js` (extended) and `tests/fixtures/partsSong.js` (new).

**Tasks** (test first)

**A2.1 `request.js`.**
- `normalizeRequest(raw, durationMs)` fills in the seeds, `snaps = [4]`, `normalizeSv = true` and the stamina/burst defaults.
- `normalizeParts(parts, durationMs)`:
  - sorts, clips, and closes gaps by extending the previous part;
  - merges parts shorter than 1 bar into their neighbour;
  - caps the count at 24 by merging the shortest neighbours;
  - checks each range and runs `normalizeShares` on part patterns;
  - throws `t("gen.parts.bad", { what })`.
- `rng.js` gets `deriveSeed(...ints)`.

**A2.2 `songParts.js`.**
- `PART_KINDS`, `barsOf(slots)` (bars are meter-many beats, by `slot.beat`), `barFeatures`, `detectParts(envelope, slots)`, `energyCurve(envelope, durationMs, points)` and `partIndexOfSlots(slots, parts)`.
- The DP, λ = 0.6 and the labelling thresholds are exactly as in the preview design (§3 there).
- Tests:
  - `dropSong` gives drop, break, drop, with boundaries within 1 bar of 30 s and 60 s;
  - the new `partsSong` fixture (intro, build, drop, break, drop, outro) gives the kinds in order;
  - a flat click track gives exactly 1 part;
  - `energyCurve` stays within 0–1 and has the requested length.

**A2.3 `assign.js`.** `assignByParts(slots, parts, defaults, mode, rng)`. Each part runs `assignPatterns` on its own slots; empty parts get `null`. `assignPatterns` itself does not change. Tests: families stay inside their part; sections start at part starts.

**A2.4 `playability.js`.**
- `LIMITS`:

  | Family | jack | anchor | minJackMs |
  |---|---|---|---|
  | Stream | 2 | 0.50 | 65 |
  | Jumpstream | 2 | 0.58 | 65 |
  | Handstream | 3 | 0.65 | 65 |
  | Tech | 3 | 0.60 | 65 |
  | Chordjack | 16 | — | 50 |
  | Jack | 24 | — | 50 |

- The guard:
  - runs reset when the gap is over half a beat, using `slot.beatMs`;
  - keeps a 16-row anchor window and a 32-row hand window;
  - outside Jack and Chordjack, vetoes when the left share goes past 0.35 or 0.65, and otherwise applies a soft pull `exp(-8·(left−0.5)·d)`;
  - applies a matching column pull with β = 4 over 64 rows;
  - takes `ahead[c]` into account at locked or kept boundaries.
- `rowStats` and `findIssues`. A spike is a beat with more than max(8, 2.2 × the mean notes per beat of its 8-beat section). Also report `columns` when the busiest column has more than 1.3× the notes of the quietest.
- Tests (quality design list):
  - a 3rd same-column row in Stream is vetoed; 16 are allowed in Chordjack;
  - after a left-heavy window, a right single outweighs a left single;
  - `fastJack` is flagged at 60 ms in Stream but not at 55 ms in Jack;
  - `ahead` stops a free row from turning a kept 2-note jack into a 3-note jack;
  - a spike is flagged.

**A2.5 `learnedModel.js` and `rowSources.js`.**
- `sampleRow` and `sampleMask` gain `weightOf = null`.
- Add `xgbMarkovSource` and `sourceFor(model)`. Columns are picked by name from `model.features`, through `slotFeatures(..., model.features ?? AUDIO_FEATURES)`.
- `patternOrder: 3` tables use the key `"prev,prev2,prev3,size"`, with a fallback to order 2.
- Tests:
  - with `weightOf ≡ 1`, the same RNG gives the same masks as today's `sampleRow`;
  - a 0 weight vetoes a mask, and the fallback is used when everything is 0;
  - the RNG is consumed the same way as today.

**A2.6 `excerpt.js`.** `excerptOsu(rows, part, timing)` (preview design). Tests: the result reaches at least 30 s and 80 notes; the 120 s cap holds.

**A2.7 `search.js`.** `searchRange({…, budget})` and `searchKnob`, with `budget = { coarse: 8, refine: 6, reseeds: 3, keep: 4 }` by default. Export `NAME_FAMILY`. Test: the budget limits the number of evaluations.

**A2.8 `partReport.js`.**
- `planBlocks(assign, slots, partOf, mix)` returns `[{ index, part, i0, i1, startMs, endMs, families }]`.
- `scoreBlock(rows, block, { patternsOf, render })` returns `null` below 24 rows.
- `describeParts(rows, parts, blocks, { patternsOf, analyze, render, timing })` builds the `PartReport[]`. It analyses an excerpt for each non-empty part with 24 or more rows.

**A2.9 `variants.js`.** `rankVariants(list, range)` sorts by:
1. in range first;
2. `patternScore` rounded to 0.05, higher first;
3. fewer issues;
4. smaller |dan − middle of the range|.

**A2.10 `generateLearned.js` pipeline.** Steps run in this order and report progress after each one.
1. **Prepare.** `normalizeRequest`, then parts (sent or detected), then `chooseBeatDivs` (rng = `planSeed`), then `slotsForTiming`, then features, then `assignByParts` (rng = `locked?.planSeed ?? planSeed`), then `planBlocks`, then `prepare` on the source.
   - The dan input of each slot is the midpoint of its part's own range, or the request target.
   - For q4 models on beats that are not 1/4, rescale the note log-odds so the expected rows per beat equal Σp over the 1/4 slots that beat replaces.
2. **Contrast.** Use today's term, except that parts with their own range use part-relative energy: `min(1, e / max(0.05, P90 of the part))`.
3. **Build.**
   - `build({ knobOf, keep, only })` loops over blocks. Each block has its own `{ fill, size, pattern }` streams.
   - The context is `prev` and `prev2` from the rows just before the block. It resets after a gap of 2 beats, measured in ms.
   - Kept and locked rows are pushed into the guard. Empty parts give no rows and a break line.
4. **Own-range parts** (at most 8). For each one, run `searchRange` on `analyze(excerptOsu(...), 1)` with budget `{6, 4, 2, 2}`, scored by `patternScore` against the part's families. Then freeze that part's knob and rows.
5. **Global search.** All other parts share one knob, found by `searchRange` on the full map. With a lock, the search runs over `[locked.knob ± 0.75]`, clamped to the knob limits.
6. **Dan far off.** If the result is out of range and the dan is below `lo − 0.5`, search once more with `KNOB_MAX` 2.5 and the contrast halved, and set `retries.dan = "low"`. If it is above `hi + 0.5`, search once more with `KNOB_MIN` −9, and set `"high"`.
   - Log `best.knob` (on the Jumpstream 14.3 → 5.7 case it is expected to be stuck at `KNOB_MAX`).
7. **Block retry.** At most 2 rounds.
   - A block is bad when its score is below 0.6, or it has a jack, fastJack, hand or spike issue.
   - Each bad block gets 4 candidates with seed `deriveSeed(noteSeed, p, b, round, k)`. The candidate with the highest `score − 0.1·issues` wins. These candidates use the pattern finder only.
   - After that, one full `analyze`. If the dan left the range, revert to the best map from the search.
8. **Describe.** `rowStats`, `findIssues`, `describeParts` and `gridShares`. Then return §2.3.

**A2.10 tests** (in `generateLearned.test.js` and `generateParts.test.js`; they use the tiny model and a fake analyser with `numeric = notes / seconds`)
- The same seeds give the same `osuText`.
- A Stream table that always continues 1→1 still produces no 3-note runs.
- A drop given a high range and an intro given a low range each land in their own range.
- An empty part has no notes and writes a break line.
- Changing one part's `seed` leaves the other parts' rows identical.
- With a lock, rows inside the locked ranges equal the base map's; rows outside differ.
- A fake `patternsOf` that fails block 2 changes only block 2, and `retries.blocks === 1`.
- When the whole map leaves the range after the retry, the map is reverted.
- An analyser capped low triggers `retries.dan === "low"`.
- `onProgress` is called with increasing `i`.
- Variable-BPM input puts the notes on each section's grid.
- `snaps: [4, 3]` puts triplet rows only on triplet beats, and rows per beat stay within ±15% of the map made with `[4]`.

**A2.11 `generate.js`** (the rule-based fallback) returns the same shape, with `engine: "rules"`. It uses `assignByParts`, `slotsForTiming`, stats, issues and parts reports. It has no lock and no retry.

**A2.12 Evaluation tools.**
- `metrics.js`: `onsetF1(gen, human, tol = 20)`, `densityCorr`, `jackLoopRate`, `violationsPer1000` (from `findIssues`) and `patternAccuracy`.
- `eval-generator.mjs` uses `metrics.js` and reads both v1 (`set` + `osu`) and v2 (`osuPath`, songKey `heldout.json`) indexes. It drops the single-BPM filter and passes the human red lines as sections.
- `eval-parts.mjs` scores the detected boundaries against the points where the human map's density jumps (F-measure at ±2 bars) on 50 maps, to tune λ and the labelling thresholds.

**Targets**, with the v1 model and 12 held-out maps, compared before and after the change:

| Metric | Target |
|---|---|
| In range | 12 of 12 |
| Onset F1 | 0.80 or more (0.815 today) |
| `maxJack.streamy` | 2 or less |
| Violations per 1000 notes | below v2 |
| The 14.3 Jumpstream case | in range, or `retries.dan` set |
| p95 time per variant, 4-min song, no own-range parts | 8 s or less |
| p95 time per variant, 4-min song, 8 own-range parts | 15 s or less |

**i18n for A2** (the stream A block of `gen.js`)

| Key | Russian | English |
|---|---|---|
| `gen.parts.bad` | «Части песни заданы неверно: {what}» | "The song parts are invalid: {what}" |

**Live check for A2:** `npm test`, then `node tools/eval-generator.mjs "A:/Games/osu!/Songs" data/mapper 12` before and after, compared side by side.

---

## 7. Stream B: create-tab UI (features 1, 2, 3, 5, the timing UI of 6, and the mapset loop of 7)

**Owns** `app/renderer/createTab.js` (as orchestrator), these new renderer files: `audioPlayer.js`, `timingPanel.js`, `waveStrip.js`, `timeline.js`, `playfield.js`, `snapColors.js`, `diffList.js`, `resultView.js` and `create.css`, plus `tests/create/*.test.js` (new), `tests/fixtures/generateResult.json` (hand-written to §2.3) and `tests/smoke/electron-ui.mjs`. B also owns the stream B block of `create.js` and the existing `create.*` keys.

**Order of work.** Start with B1 and B4–B6 against the fixture result. Rebase onto A1 and A2 once they merge, for `fineOnset`, `slotsForTiming`, `clickTimes`, `detectParts`, `energyCurve` and `rankVariants`.

**Tasks**

**B1 `audioPlayer.js`.**
- One `AudioContext` over the buffer that is already decoded.
- Methods: `play()`, `pause()`, `seek(ms)`, `playFrom(startSec, seconds, { clicks })`, `now()`.
- Clock: `getOutputTimestamp()` minus `outputLatency || baseLatency`.
- Hit clicks are scheduled every 50 ms with 200 ms look-ahead.
- Tests cover the pure clock and scheduling math.

**B2 `timingPanel.js` and `waveStrip.js`.**
- Sections table with Start, BPM, Meter and ✕.
- Buttons: «+ точка здесь», «Один BPM на всю песню», ×2, ÷2, ×1.5, ×⅔, −5, −1, +1, +5 мс, and «Подогнать по волне» (`detect-timing` with `hint`).
- Wave strip:
  - 96 px high, showing min/max per pixel, beat lines in the snap palette, and section markers;
  - the wheel zooms from 0.5 to 20 s, dragging scrolls, and a click sets the cursor;
  - the arrow keys nudge the offset while the strip has focus.
- `#bpm` and `#offset` edit the selected section.
- «▶ проверить на слух» plays 8 s from the cursor, with `clickTimes`.
- Snap chips: 1/4 (always on), 1/8, 1/3, 1/6. With `modelInfo.grid === "q4"`, 1/3 and 1/6 show β with a hint.
- Checkbox «Ровная скорость скролла» (on by default).
- Tests: the octave buttons, the nudge math and the strip's time↔x mapping.

**B3 `timeline.js`.**
- A 432×64 energy curve with coloured part bands, labels, the playhead, click/drag seeking and badges.
- Part editor: kind select, pattern chips plus share sliders, a dan select («Как у всей карты», or LEVELS plus a step select that includes «любой»), «Без нот», split, merge and reset. A lock toggle appears once a result exists.
- Edited parts get a dot.
- Parts are detected again 300 ms after a BPM or offset change, unless the user has edited them.
- Tests on the pure helpers: split, merge, step «любой» → [level−0.5, level+0.5), and badge text selection.

**B4 `playfield.js` and `snapColors.js`.**
- 4 lanes × 40 px, 300 px high.
- «Скорость прокрутки» from 10 to 40 (default 24); «Щелчки на нотах».
- Exported pure helpers:
  - `visibleSpanMs(speed) = 11485/speed`;
  - `visibleRange`;
  - `noteY`;
  - `snapOf(t, timing)`, which handles 1/3, 1/6 and 1/8.
- Before generation it shows only beat lines.
- It pauses on `tab-shown` (any tab other than create) and when `document.hidden` is true.
- Speed and clicks are kept in `localStorage`, wrapped in try/catch.
- Use `canvas.getContext?.("2d")`, so the fake DOM still works.
- Tests:
  - `visibleRange` matches a linear scan;
  - `noteY` puts the note on the judge line at `t = now`;
  - `snapOf` gives the right colour for 1/1, 1/2, 1/3, 1/4 and 1/6.

**B5 `diffList.js`.**
- Rows of from/to level and step, with ✕; at most 5 rows.
- «+ сложность».
- «Лесенка: 3 дана подряд», which fills level−1, level and level+1, each from low to high.
- `ranges()` returns them easiest first.
- With more than one row, `#generate` reads «Создать набор ({n} …)».
- Tests: the ladder ranges, ordering, and the cap at 5.

**B6 `resultView.js`.**
- One section per difficulty, holding variant cards.
- A card shows:
  - its version, dan line and ✓/≈;
  - the stats lines (sizes, balance, jacks), the grid line and the model line;
  - the issues (first 5, then «ещё {n}»);
  - the part rows with lock toggles, and «лучший» on the best card;
  - «Взять этот».
- At most 6 cards per difficulty; the oldest card that is not the best is dropped.
- Tests with `generateResult.json`: the best mark follows `rankVariants`, and the oldest card is dropped.

**B7 `createTab.js` orchestration.**
- **Loading a song:** decode → `onsetEnvelope` → `fineOnset` → `danApi.detectTiming` (falling back to the local `detectTiming`) → timing panel → `slotsForTiming` + `detectParts` + `energyCurve` → timeline → playfield grid → `exportPanel.onSongLoaded(song)`.
- **«Создать карту»:**
  - with one range, 3 variants, using `planSeed = noteSeed = base + v·1009`;
  - with several ranges, 1 variant per range, easiest first, all with the **same base seeds**.
  - The status shows `create.variants.progress` or `create.set.progress` plus the progress phase text.
  - «Стоп» stops after the current call.
  - After ranking, the best card is selected, and the playfield and timeline badges show it.
- **«Ещё вариант»** (per difficulty): new `planSeed` and `noteSeed`.
- **«Перегенерировать незакреплённое»:** `lock { fromId, parts }`, the base map's `planSeed`, a new `noteSeed`, and the base map's parts. On `timingChanged`, clear the locks and show `create.lock.timingChanged`.
- Progress events are filtered by `jobId`.
- `#create-mode` switches between `#song-mode` and `#remap-panel`.
- **Contract with C:**

  ```js
  const exportPanel = initExportPanel({ root: $("export-panel"), metaRoot: $("meta-group"), player, getSelection });
  // getSelection() → { song: { path, title, durationMs, envelope, timing, parts },
  //                    diffs: [{ id, version, range, result, reachable }] }  // selected variant per difficulty, easiest first
  exportPanel.onSongLoaded(song); exportPanel.onSelectionChanged();
  initRemapPanel({ root: $("remap-panel") });
  ```

**B8 Smoke test.** `electron-ui.mjs create preview`: inject `generateResult.json`, `seek(30000)`, then screenshot the playfield, timeline and cards at 480 px in Russian and English. Nothing may overflow horizontally.

**i18n keys for B** (stream B block of `create.js`; counts use `plural()`)

| Key | Russian | English |
|---|---|---|
| `create.timing.variable` | «Найден переменный BPM: {n} {parts} — проверь каждую» | "Variable BPM found: {n} parts — check each one" |
| `create.timing.refined` | «Тайминг уточнён по волне (±{err} мс)» | "Timing refined from the waveform (±{err} ms)" |
| `create.timing.start` / `.meter` / `.remove` | «Начало» / «Размер» / «Удалить точку» | "Start" / "Meter" / "Remove point" |
| `create.timing.addPoint` / `.oneBpm` / `.fitWave` | «+ точка здесь» / «Один BPM на всю песню» / «Подогнать по волне» | "+ point here" / "One BPM for the whole song" / "Snap to waveform" |
| `create.timing.nudgeHint` | «←/→ — сдвиг на 1 мс, с Shift — на 5 мс» | "←/→ moves 1 ms, with Shift 5 ms" |
| `create.snap.title` | «Дробление сетки» | "Snap divisors" |
| `create.snap.betaHint` | «триплеты пока ставятся по правилам — модель обучена только на 1/4» | "triplets are rule-placed for now — the model was trained on 1/4 only" |
| `create.snap.normalizeSv` | «Ровная скорость скролла» | "Even scroll speed" |
| `create.parts.kind.{intro,build,drop,break,outro,part}` | «Вступление», «Нарастание», «Дроп», «Затишье», «Концовка», «Часть» | "Intro", "Build-up", "Drop", "Break", "Outro", "Part" |
| `create.parts.found` | «Найдено частей: {n} · дропов: {d}» | "{n} parts found · {d} drops" |
| `create.parts.hint` | «Нажми на часть, чтобы задать ей свой паттерн и дан» | "Click a part to give it its own pattern and dan" |
| `create.parts.same` / `.anyStep` / `.empty` | «Как у всей карты» / «любой» / «Без нот» | "Same as the whole map" / "any" / "No notes" |
| `create.parts.split` / `.merge` / `.reset` | «Разрезать на курсоре» / «Склеить со следующей» / «Сбросить части» | "Split at the cursor" / "Merge with the next" / "Reset parts" |
| `create.parts.badgeOff` | «≈ {label} (просили {wanted})» | "≈ {label} (asked for {wanted})" |
| `create.parts.danHint` | «Дан этой части, если играть её отдельно — обычно чуть ниже дана всей карты» | "This part's dan if played on its own — usually a bit lower than the whole map's" |
| `create.progress.partSearch` | «Подбираем дан: часть {i} из {n} ({kind})» | "Tuning the dan: part {i} of {n} ({kind})" |
| `create.progress.search` / `.retry` / `.describe` | «Подбираем плотность…» / «Переделываем неудачные куски…» / «Проверяем части…» | "Tuning the density…" / "Redoing weak spots…" / "Checking the parts…" |
| `create.play.play` / `.pause` | «▶ играть» / «❚❚ пауза» | "▶ play" / "❚❚ pause" |
| `create.play.speed` / `.clicks` | «Скорость прокрутки» / «Щелчки на нотах» | "Scroll speed" / "Hit clicks" |
| `create.play.gridOnly` | «Пока только сетка битов — проверь, что линии совпадают с ударами» | "Beat grid only for now — check the lines match the hits" |
| `create.play.keys` | «Пробел — играть/пауза, ←/→ — 2 с, колесо — на бит» | "Space — play/pause, ←/→ — 2 s, wheel — one beat" |
| `create.variants.progress` | «Вариант {n} из {total}…» | "Variant {n} of {total}…" |
| `create.variant.name` / `.best` / `.use` | «Вариант {letter}» / «лучший» / «Взять этот» | "Variant {letter}" / "best" / "Use this one" |
| `create.variant.more` / `create.variants.stop` | «Ещё вариант» / «Стоп» | "Another variant" / "Stop" |
| `create.stats.sizes` | «Одиночные {s1}% · двойные {s2}% · тройные {s3}% · квады {s4}%» | "Singles {s1}% · jumps {s2}% · hands {s3}% · quads {s4}%" |
| `create.stats.balance` | «Левая рука {left}% · столбцы {cols}» | "Left hand {left}% · columns {cols}" |
| `create.stats.jacks` | «Самый длинный джек {all} (в стримах {streamy}) · пик {nps} нот/с» | "Longest jack {all} (in streams {streamy}) · peak {nps} notes/s" |
| `create.stats.clean` / `.issues` / `.more` | «Неудобных мест нет» / «Проблемных мест: {n}» / «ещё {n}» | "No awkward spots" / "Problem spots: {n}" / "{n} more" |
| `create.issue.jack` | «{time}: джек из {n} нот в столбце {col}» | "{time}: {n}-note jack in column {col}" |
| `create.issue.anchor` | «{time}: якорь — столбец {col} в {pct}% строк» | "{time}: anchor — column {col} in {pct}% of rows" |
| `create.issue.hand` | «{time}: перекос на одну руку ({pct}% слева)» | "{time}: one hand overloaded ({pct}% left)" |
| `create.issue.spike` | «{time}: всплеск плотности ({n} нот за бит)» | "{time}: density spike ({n} notes in a beat)" |
| `create.issue.fastJack` | «{time}: слишком быстрый джек ({ms} мс)» | "{time}: jack too fast ({ms} ms)" |
| `create.issue.columns` | «Столбцы неравномерны: самый загруженный в {ratio} раза больше» | "Columns uneven: the busiest has {ratio}× the notes" |
| `create.part.row` | «{from}–{to} · {family} · паттерн {pct}% · ≈{dan}» | "{from}–{to} · {family} · pattern {pct}% · ≈{dan}" |
| `create.part.lock` / `.locked` / `.regen` | «Закрепить» / «Закреплено» / «Перегенерировать незакреплённое» | "Lock" / "Locked" / "Regenerate the unlocked parts" |
| `create.retry.blocks` (function, `plural()`) | «Переделал {n} кус(ок/ка/ков), где паттерн не совпадал» | "Redid {n} spot(s) where the pattern was off" |
| `create.retry.danLow` / `.danHigh` | «Дан не доставал — повторил с более плотными тихими частями» / «Дан был выше — повторил с более редкими нотами» | "The dan fell short — retried with denser light parts" / "The dan was too high — retried with sparser notes" |
| `create.lock.timingChanged` | «Тайминг изменился — закреплённые части сброшены» | "Timing changed — locked parts were cleared" |
| `create.diffs.add` / `.ladder` / `.remove` | «+ сложность» / «Лесенка: 3 дана подряд» / «Убрать» | "+ difficulty" / "Ladder: 3 dans in a row" / "Remove" |
| `create.generate.set` | «Создать набор ({n} {word})» | "Create mapset ({n} difficulties)" |
| `create.set.progress` | «Сложность {i} из {n} ({dan})…» | "Difficulty {i} of {n} ({dan})…" |
| `create.result.grid` | «Сетка: {n4}% 1/4 · {n3}% 1/3 · {n6}% 1/6 · {n8}% 1/8» | "Grid: {n4}% 1/4 · {n3}% 1/3 · {n6}% 1/6 · {n8}% 1/8" |
| `create.result.model` | «Модель: {kind}, обучена на {maps} картах» | "Model: {kind}, trained on {maps} maps" |
| `create.model.{neural,trees,rules}` | «нейросеть» / «деревья решений» / «правила» | "neural net" / "decision trees" / "rules" |

**Live check for B**
- `npm test` and `npx electron tests/smoke/electron-ui.mjs create preview`.
- Then in `npm start`:
  - Drop a real song and a 174 BPM click track. With «Щелчки на нотах» on, the clicks must sit exactly on the audio clicks, also over Bluetooth output.
  - Seek with the curve and with the keys.
  - Set the first drop to Delta, set a break to «Без нот», and generate: there should be 3 cards with badges.
  - Lock part 2 and press «Перегенерировать незакреплённое». The rows of part 2 must be identical in the playfield.

---

## 8. Stream C: output (features 7 export, 8, 9, 10)

**Owns**
- `src/gen/osuMeta.js`, `src/gen/previewPoint.js` and `src/gen/remap.js` (all new);
- `app/mapsetExport.js` (new), plus `app/exportIpc.js` and `app/renderPng.js` (stubbed by P0, owned by C afterwards);
- `app/rateAudio.js`, `app/rateCreate.js` and `app/mapExport.js`;
- `app/renderer/exportPanel.js` and `app/renderer/remapPanel.js` (stubbed by P0), and `app/renderer/export.css`;
- tests: `tests/gen/{osuMeta,previewPoint,remap}.test.js`, `tests/mapsetExport.test.js`, `tests/exportIpc.test.js` (new), `tests/fixtures/readOsz.js` (new), `tests/rateAudio.test.js` and `tests/rateCreate.test.js` (extended);
- the stream C blocks of `create.js`, `app.js` and `gen.js`.

**Tasks** (test first)

**C1 `osuMeta.js`.**
- `applyMeta(osuText, { title, artist, creator, source, tags, previewMs, background })` rewrites Title/TitleUnicode/Artist/ArtistUnicode/Creator/Source, PreviewTime, and `Tags:lunacy-mania generated <user tags>`.
- It inserts or replaces `0,0,"bg<ext>",0,0` after `//Background and Video events`, strips CR/LF from values, and is idempotent.
- Also exports `setVersion` and `readMeta`.
- Tests:
  - fields are set and CR/LF is stripped;
  - applying twice leaves one background line;
  - the user's tags keep `lunacy-mania generated`.

**C2 `previewPoint.js`.** `pickPreviewMs(envelope, { timing, durationMs, parts, windowSec = 15 })`.
- It takes the start of the loudest "drop" part when one exists.
- Otherwise it takes the loudest 15 s window, skipping the first 10% and the last 15 s, snapped back to a bar on the section grid.
- Songs under 30 s use 40%.
- Tests: a loud block at 60–75 s gives a point within 1 bar before 60 s; the point is never in the last 15 s; a 20 s song gives 40%; `parts` takes priority.

**C3 Song tags and a regex fix.**
- `rateAudio.probeTags(ffmpeg, input)` reads `title` and `artist` from ffmpeg's stderr. Without tags, the file name is split on `" - "`.
- Fix `field` in `rateCreate.js`: `\s` inside the template literal must be `\\s`. Add a test that would have caught it.

**C4 `mapsetExport.js`.**
- `exportMapset({ ffmpeg, dir, audioPath, diffs, meta, previewMs, background, rates, pitch, danFor, renderPng, renderAudio = renderRateAudio })` returns `{ file, entries }`.
- Names and audio:
  - .osu files are named `${artist} - ${title} (${creator}) [${version}].osu`, passed through `safeFileName` and deduplicated;
  - there is one audio file; .wav and .flac sources become `audio.mp3`.
- Rates:
  - the audio for each rate goes into a `mkdtemp` folder, which is cleaned up in `finally`;
  - each rated difficulty is `rateOsu(applyMeta(…))` with its real dan from `danFor`, renamed `"${danLabel} · ${version} ${rateText(rate)}x"` with " NC" when pitch is on.
- Backgrounds:
  - "image" copies the file in as `bg<ext>`;
  - "danCourse" renders `backgroundHtml` through `renderPng` to `bg.png`.
- Tests use a stub `renderAudio`, stub `danFor` and stub `renderPng`, and check:
  - 3 diffs × rates [1.1, 1.2] give 9 .osu, 3 audio files and 1 background;
  - each `AudioFilename` exists in the zip;
  - all files share Title, Artist and `BeatmapSetID:-1`;
  - versions are unique;
  - a rated PreviewTime equals the base value ÷ rate.

**C5 `exportIpc.js` (complete).**
- `export-set` follows the §2.5 rules. It resolves ids through the store and uses `danFor = workerClient.analyze(text, 1)`.
- `song-tags`.
- Tests with fakes cover: an unknown id, ids from different songs, a bad image, a bad rate, and that one id with no rates keeps today's file name.

**C6 `exportPanel.js` and `export.css`.**
- Metadata fields, filled from `song-tags` only where empty.
- Background chips, plus «выбрать картинку» with a `data:` thumbnail.
- The preview field: `pickPreviewMs` on `onSongLoaded`, «▶ послушать превью» through `player.playFrom(previewSec, 10)`, and the auto/manual note.
- Rate checkboxes 1.1x and 1.2x, a custom field (0.5–2, step 0.05) and Nightcore.
- Buttons «Сохранить .osz» (one difficulty) or «Сохранить набор .osz ({n})», then «Открыть в osu!» and «Показать файл». «Открыть в osu!» saves first when the selection has changed since the last save.
- The result list includes the rated dans.

**C7 `remap.js`.**
- `parseChart`, `removalOrder`, `additionOrder` (using `model.pattern`, and `createGuard` from A2 once merged), `applyKnob` and `remapChart` (§2.7). The search reuses `searchRange` and scores with `patternScore` against the original's top3 families.
- Only `[HitObjects]` changes. The new map gets `Version: <old> (<label> remap)`, `BeatmapID:0` and `lunacy-mania-remap` added to Tags.
- Tests (fixture chart, fake analyser):
  - −1 removes notes and +1 adds notes, both reachable;
  - `[TimingPoints]` and `[Events]` stay byte-identical, and kept note lines are byte-identical;
  - holds are kept, and no 1/1 row is left empty;
  - thickening never makes a jack longer than the original's longest;
  - a map with two red lines keeps both.

**C8 Remap channels and panel.**
- `remap-load` (reuses the marathon `describe` logic plus `workerClient.analyze`; `rice` = LN share ≤ 0.15) and `remap-create`, which writes next to the original and never overwrites.
- `remapPanel.js`: «+ файл .osu», «взять из osu!», the chips −1 / +1 / свой дан, and «Переделать».

**i18n keys for C** (stream C block of `create.js`)

| Key | Russian | English |
|---|---|---|
| `create.meta.artist` / `.title` / `.source` / `.tags` / `.creator` | «Исполнитель» / «Название» / «Источник» / «Теги» / «Маппер» | "Artist" / "Title" / "Source" / "Tags" / "Creator" |
| `create.meta.fromTags` | «взято из тегов файла» | "taken from the file's tags" |
| `create.bg.none` / `.image` / `.danCourse` / `.pick` | «Без фона» / «Картинка» / «В стиле дан-курса» / «выбрать картинку» | "No background" / "Image" / "Dan-course style" / "pick an image" |
| `create.previewAt.label` / `.listen` | «Превью» / «▶ послушать превью» | "Preview" / "▶ listen to the preview" |
| `create.previewAt.auto` / `.manual` | «выбрано по самой громкой части» / «задано вручную» | "picked from the loudest part" / "set by hand" |
| `create.rates.title` / `.custom` / `.nightcore` | «Рейт-версии» / «свой» / «Nightcore (меняет тон)» | "Rate versions" / "custom" / "Nightcore (changes pitch)" |
| `create.rates.preparing` | «Готовим аудио {rate}x…» | "Preparing {rate}x audio…" |
| `create.save.one` / `.set` | «Сохранить .osz» / «Сохранить набор .osz ({n})» | "Save .osz" / "Save the mapset .osz ({n})" |
| `create.save.done` | «Сохранено: {file}» | "Saved: {file}" |
| `create.save.rateRow` | «{rate}x: {label} ({numeric})» | "{rate}x: {label} ({numeric})" |
| `create.remap.file` / `.fromOsu` | «+ файл .osu» / «взять из osu!» | "+ .osu file" / "take from osu!" |
| `create.remap.now` | «{name} · сейчас {label} ({numeric})» | "{name} · now {label} ({numeric})" |
| `create.remap.easier` / `.harder` / `.custom` / `.go` | «−1 дан» / «+1 дан» / «свой дан» / «Переделать» | "−1 dan" / "+1 dan" / "custom dan" / "Remap" |
| `create.remap.done` | «Готово: [{version}] · {numeric} · убрано {removed} / добавлено {added} нот — в папке карты, нажми F5 в osu!» | "Done: [{version}] · {numeric} · {removed} removed / {added} added notes — in the map's folder, press F5 in osu!" |
| `create.remap.onlyRice` | «Переделка работает только для рисовых 4K-карт» | "Remapping works only for 4K rice maps" |
| `app.export.mixedSongs` (app.js) | «В один набор можно сохранить только сложности одной песни» | "A mapset can only hold difficulties of one song" |
| `app.export.badImage` | «Фон — только .jpg или .png до 15 МБ» | "Background must be a .jpg or .png up to 15 MB" |
| `app.export.badRate` | «Рейт — от 0.5 до 2, не 1» | "Rate must be 0.5–2 and not 1" |
| `app.remap.unknownMap` | «Сначала выбери карту» | "Pick a map first" |
| `gen.remap.noRows` (gen.js) | «В карте нет нот» | "The map has no notes" |

**Live check for C**
- `npm test`, then the smoke test: 2 difficulties plus `exportMapset` at rate 1.2 with real ffmpeg-static, printing the zip entries.
- Then in `npm start`:
  - Load a song from Songs: Artist and Title are filled.
  - The preview starts at the drop.
  - Make a ladder Beta/Gamma/Delta with rates 1.1 and 1.2 and the dan-course background. In osu!stable it should show one set with 9 difficulties, the right background and preview, and rate audio at the right speed.
  - Remap a known Gamma map −1. The analysis tab should show Beta, and the pattern breakdown should stay close to the original.

---

## 9. Stream D: data, dataset v2, training, evaluation

**Owns**
- Tools: `tools/fetch-train-sets.mjs`, `tools/build-mapper-dataset.mjs`, `tools/train_mapper.py`, `tools/train_mapper_nn.py` (new) and `tools/compare-mappers.mjs` (new). `tools/heldout_sets.py` is retired and deleted, replaced by `mapper2/heldout.json`.
- Requirements: `tools/requirements.txt` (add `xgboost==3.4.1`) and `tools/requirements-nn.txt` (new, torch cu130).
- Code: `src/corpus/select.js`, `src/corpus/zip.js` and `src/gen/nnModel.js` (all new).
- Models and reports: `models/mapper.json` (replaced only on SHIP; the old one is kept as `models/archive/mapper-v1.json`), `models/mapper-nn.json` (only on SHIP), and `reports/mapper.md`.
- Repo: `.gitignore` (add `models/mapper-nn.json` and `models/archive/`).
- Tests: `tests/corpus/*.test.js`, `tests/gen/nnModel.test.js`, `tests/fixtures/nn-parity.json` and `tests/gen/mapperParity.test.js` (extended with the divisor head).

Nothing from the corpus is ever committed or packaged. Models contain no audio.

**D1 Corpus.** This runs now, and the post-run steps add about half a day.
- Let the current run finish. **Do not edit or restart it while it runs.**
- Afterwards:
  - **`src/corpus/zip.js`:**
    - finds the EOCD by searching back past the comment, and supports zip64;
    - caps entries at 100 MB;
    - sanitises names: no `..`, no absolute paths, no drive letters.
    - `fetch-train-sets.mjs` uses it in place of its inline `unzipEntries`.
  - Add a lock file `A:/SneezeyTrain/.lock`.
  - A second pass of the same command retries the failures that are not final.
- **`src/corpus/select.js`:**
  - `pickDiffs(item)`: 4K, `lnShare ≤ 0.15`, not vibro (including the `/vibro/i` name check), and no rate edits (`/\b\d(\.\d+)?x\b|\(\d+\s*bpm\)/i`);
  - `songsHave(dirNames, metas)`: folder ids plus `BeatmapSetID:` and `BeatmapID:` read from every .osu in Songs.
- A corpus report: sets ok and failed, GB, and labelled diffs per dan.
- Expanding to graveyard maps is **not** part of v3, unless D2's dan-bin check fails.
- **Tests:**
  - `zip.test.js`: a stored and a deflated round trip through `buildOsz`; `../` and absolute paths rejected; the size cap enforced; a zip64 fixture.
  - `select.test.js`: using `tests/fixtures/mt/search.json`, the `1.05x (263bpm)` diff is dropped and `BeatmapSetID` detection works.

**D2 Dataset v2.** Starts after A1 merges (`labelBeatSnaps`, `slotsForBeats`, `slotFeatures` v2, `beatFeatures`).

```
node tools/build-mapper-dataset.mjs --source songs="A:/Games/osu!/Songs" --source corpus=A:/SneezeyTrain/sets \
  --labels A:/SneezeyTrain/manifest.json --out A:/SneezeyTrain/mapper2 --workers 12 --max-per-audio 0 [--limit N]
```

- **Maps:**
  - all diffs of each audio, with weight `1/sqrt(diffs per songKey)`;
  - stable ids `sha1(source + relative osu path)`, so maps already built are skipped;
  - dedupe by beatmapId (the Songs copy wins), then by a chart fingerprint (note count + hash of the first 200 row intervals);
  - rate edits are dropped through `pickDiffs`.
- **Labels per beat:** `labelBeatSnaps(rows, beats, [4,3,6,8])`. Slots are built only on each beat's labelled grid, and maps with `residualOffgrid > 0.2` are dropped.
- **Families:** one per 8-beat section, from `sectionFamily(rows, residualOffgridShare)`.
- **Files per map:**
  - `.f32`: `AUDIO_FEATURES_V2`;
  - `.u8`: `[note, mask, family, div]` per slot;
  - `.t32`: slot times;
  - `.b32`: `BEAT_FEATURES` per beat;
  - `.bd8`: the divisor label per beat.
- **Index fields:** `id, source, osuPath, audioPath, songKey, set, beatmapId, beatmapSetId, version, slots, beats, danOurs, danTracker, primaryTracker, msdOverall, playCount, divShare, residualOffgrid, multiBpm`.
- **songKey** = `titleKey(artist, title)` from `recommend.js` + the audio length rounded to 5 s.
- **Gate before training** (`report.json`):
  - every dan bin from 3 to 18 has at least 150 maps;
  - the calibration MAE from tracker to ours is reported;
  - the divisor histogram is close to the measured 84.6 / 3.4 / 2.8 / 8.0 %;
  - first check a 200-map `--limit` build by eye.
- **Tests** (`tests/corpus/dataset.test.js`): a pack copy and a single upload share a songKey; the split stays stable when maps are added; the dedupe rules hold.

**D3 Model v1.5** (XGBoost on the big set; also the baseline for the neural model). Changes to `train_mapper.py`:
- **Split:** `crc32(songKey) % 10 == 0` → test, `== 1` → validation. Write `mapper2/heldout.json` with the songKeys.
- **Data loading:** load through `np.memmap`, then `xgb.QuantileDMatrix` on CUDA. Switch to `ExtMemQuantileDMatrix` only if memory runs out.
- **Weights:** per song, with caps per dan bin.
- **Dan label:** `--dan tracker|ours`.
  - "tracker" is mapped into our scale with an isotonic fit on maps that have both labels, and maps where the two differ by more than 1.5 are dropped.
  - Maps without a tracker label use ours.
  - **Train both labels; the comparison picks one.**
- **Context reset:** 2 beats, in ms, from `.t32` and the slot length.
- **Pattern tables:** order 2 and order 3, each gated by `MIN_EVIDENCE`. Keep the order with the lower validation log-loss.
- **Divisor head:** `multi:softprob` with classes [4, 3, 6, 8] over `BEAT_FEATURES` plus dan and family, weighted by class. Also export `snapTransitions`.
- **Export:** `kind: "xgb-v2"`, `grid: "snap-v2"`, `features`, and parity probes for the note, size and divisor heads. Write `reports/mapper.md` in Russian.
- **Install:** `.venv/Scripts/python -m pip install -r tools/requirements.txt`. Run: `.venv/Scripts/python -I tools/train_mapper.py A:/SneezeyTrain/mapper2 A:/SneezeyTrain/candidates/mapper-xgb2.json reports/mapper.md`.

**D4 Neural candidate (nn-v1).**
- **Script:** `tools/train_mapper_nn.py`. Install with `pip install -r tools/requirements-nn.txt`, using the cu130 wheels; the user's ComfyUI venv shows they work with the RTX 5080.
- **Architecture** (model design §3):
  - **encoder:** Linear(F→64), then 5 residual dilated Conv1d blocks (dilations 1–16);
  - **decoder:** a feed-forward step at every slot, over embeddings of the last 8 masks, the last 4 rows with their gaps, family (10% dropout to "unknown"), dan and W·hᵢ;
  - then GELU 96 → 96 → **16 logits**, where logit 0 is "no row";
  - knob: `logits[0] -= knob + adjust[i]`;
  - pattern prior: `+ λ·log P_markov`, with λ ∈ {0, 0.5, 1} chosen on validation.
- **Training:** 1024-slot windows, AdamW, bf16, label smoothing 0.05 and 10% scheduled sampling.
- **Export:** `models/mapper-nn.json` with `kind: "nn-v1"`, the same `features`, `families`, `pattern` and `divisor` keys, base64 Float32 weights and parity probes. Target size: 5 MB or less.
- **JS:** `src/gen/nnModel.js` exports `neuralSource`, implementing the §2.7 contract.
  - The encoder runs once per prepare.
  - `step()` applies `weightOf` as `log(weight)`, with 0 → −∞.
  - It uses plain `Float32Array` loops.
- **Tests:** hand-set weights give known logits; parity against `nn-parity.json` (skipped when the fixture is missing); forced/banned masks are honoured; more notes as the knob rises; deterministic per seed.

**D5 Comparison and ship.** Starts after A2 merges.
- `node tools/compare-mappers.mjs --a <model> --b <model> --data A:/SneezeyTrain/mapper2 --n 180 --seeds 1,2,3` runs **the same v3 generator** with both models. Only the model file differs.
- **Eval set:** held-out songKeys, stratified by dan 3–18 × the 5 families, plus at least 30 variable-BPM songs and at least 30 triplet songs (10% or more of beats with div ≠ 4).
- **Request forms:** both the strict-label form (`target`) and the range form (±1 dan).
- **Snaps:** `[4,3,6,8]` on the triplet subset, `[4]` elsewhere. No own-range parts.
- **Output:** the metrics table and a `SHIP` or `NO-SHIP` verdict, with a non-zero exit code on NO-SHIP. The table goes into `reports/mapper.md`.
- **Metrics** (functions from A2's `metrics.js`):
  - onset F1 at ±20 ms;
  - section density correlation;
  - dan hit rate;
  - pattern accuracy;
  - violations per 1000 notes;
  - jack-loop rate compared with the human rate;
  - divisor F1 on triplet beats;
  - median and p95 seconds per variant;
  - next-mask log-loss and note AUC (today 0.881).

**Live check for D**
- Run `download --limit` behaviour on 20 sets, press Ctrl+C in the middle, and run again: there must be no duplicates.
- Build with `--limit 200` and inspect the index.
- Run the full build overnight, then training, then compare-mappers.
- Then `npm test`, `npx electron tests/smoke/electron-generate.mjs`, and `npm start` with a 4-minute song: check the time, the model line and the dan, and open the map in osu!.

---

## 10. Ship rule for the new model

**Gate 0 (any candidate)**
- `npm test` is green, including the parity tests.
- The worker loads the file.
- Size: an XGB file 60 MB or less; a neural file 5 MB or less.
- The comparison ran on the songKey held-out set, with no overlap with the training songKeys. The tool asserts this.

**Gate 1: v1.5 (`xgb-v2`) replaces v1.** All of these must hold, against v1 under the same v3 generator:
1. The dan hit rate in the range form is at least v1's.
2. Pattern accuracy is at least v1 − 0.01.
3. Onset F1 is at least v1 − 0.005.
4. Violations per 1000 notes are at most v1's.
5. On the triplet subset, divisor F1 is at least 0.6 (v1 has no triplet rows).
6. p95 time is 8 s or less per variant on 4-minute songs.

**Gate 2: nn-v1 replaces v1.5** (A = the winning v1.5, not the old v1). All of these must hold:
1. Pattern accuracy is at least A − 0.01.
2. The dan hit rate is at least A's.
3. Either onset F1 is at least A + 0.02, with a paired bootstrap 95% interval above 0, **or** density correlation is at least A + 0.03.
4. Violations are at most A's.
5. The jack-loop rate is at most max(A, human × 1.2).
6. p95 time is 8 s or less.
7. The JS/PyTorch parity test passes.

**Gate 3: the user's ear** (required for the neural model; recommended for v1.5).
- Take 5 held-out songs across dans and make the maps with A and B. File names are randomised, and a key is saved separately.
- The user plays them blind in osu!.
- B ships only if the user does not prefer A on 3 or more of the 5.

**Dan label.** "tracker-calibrated" versus "ours" is decided by Gates 1 and 2 on the same eval set: the label whose model passes with the better pattern accuracy wins.

**How a model ships**
- Copy the old `models/mapper.json` to `models/archive/mapper-v1.json`, then put the winner in `models/`.
- The worker's load order (neural, then XGB, then rules) picks it up.
- Bump the version so the result cache (`results-${version}`) starts fresh.
- A model that fails stays in `A:/SneezeyTrain/candidates/`.

---

## 11. Integration and the final live check

1. After each merge, run `npm test` on `feature/v3`.
2. After A2 merges, extend `tests/smoke/electron-generate.mjs` (owned by P). It must cover:
   - a `dropSong` WAV with drop = Delta, break = empty and the rest auto: print each part's numeric value and whether it is in range, and check for a break line;
   - 3 seeds;
   - a lock of part 1 plus a regeneration: the locked rows must be identical;
   - a 2-difficulty `export-set` with rate 1.2: print the zip entries.
3. After B and C merge, a full manual pass in `npm start`, in both languages:
   1. drop a song, check the timing (sections, strip, by ear), and check the parts;
   2. 3 variants; preview each in the playfield;
   3. lock a part and regenerate the rest;
   4. a ladder mapset with rates;
   5. metadata, background and preview point;
   6. save, open in osu!stable, and play;
   7. remap an existing Gamma map −1 and +1.
4. Last: `npm run dist`, then run the portable exe once to confirm the models are inside the asar and the ffmpeg path resolves.

---

## 12. Risks and mitigations

- **Generating no longer saves by itself.** The one-click behaviour changes. P0's compatibility edit keeps the old flow until B lands; after that, the save button is always in view.
- **The guard bends learned row statistics.** F1 or Chordjack dan could drop. A2.12 gates on F1 ≥ 0.80, all 12 in range and streamy jacks ≤ 2. The limits are tuned only through `LIMITS`.
- **An excerpt's dan is not how the part feels inside the full map.** The label says "as if played on its own", the excerpt never decides a revert, and the whole-map dan is always shown.
- **Time.** The worst case is 8 own-range parts × about 17 short evaluations, plus the global search, plus retries, times 3 variants.
  - Progress re-arms the timeout, and «Стоп» stops between variants.
  - Own-range parts are capped at 8.
  - The p95 targets are in A2.12 and §10.
- **False BPM splits** are the worst timing failure. A1 uses a strong change penalty, falls back to `detectTiming` when uncertain, and targets 2% or fewer false splits.
- **Decoder offset.** The MP3 encoder delay in Chromium can differ from osu!/BASS. The bias is fitted on the chromium path (A1.7). The playfield shares the app's decode, so it is consistent with the detected offset.
- **Triplet false positives** from swing or bad timing. Triplets need 2 or more rows per beat in the data and a run of 2 or more beats in the rules, plus the `residualOffgrid` filter and the β label.
- **Feature-order drift between dataset and app.** Columns are selected by name, and there are parity tests on 1/4 grids.
- **Disagreement between tracker and our dan.** Calibration, dropping outliers, and the label ablation.
- **Popularity bias** toward famous high-dan stamina maps. Weight caps per dan bin.
- **Mirrors or the tracker change or block us.** Concurrency 2, rotation, resumable state, and `--limit` for trial runs. Downloaded archives are untrusted: only selected entries are extracted, with caps, and nothing is executed.
- **Memory and disk.** About 6 GB of float32 is read through memmap, with quantized GPU matrices; A: has 1.6 TB free.
- **Lock and timing drift.** Main checks the sections and the part boundaries and returns `timingChanged`.
- **Remap only writes for osu!stable**, into the Songs folder, like the rate tab. Thickening cannot add more than about 50%, so "+1 dan" on a dense map may come back as "closest".
- **Merge conflicts** in the message files. These are avoided by the marked blocks and the key prefix rules; `html.js` and `index.html` belong to P only.

---

## 13. Explicitly NOT done in v3

- No generation of long notes or holds, no key counts other than 4K, and no hitsounds, keysounds, storyboards or video.
- No 1/12 or 1/16 generation, and no SV gimmicks beyond the green lines that normalise BPM changes.
- No changes to `analyzeChart`, `dan_model.json` or `src/audio/onset.js` (including `frameTimeSec`).
- No transformer, no ONNX runtime model, no cloud training, and no packaging of the corpus or any audio.
- No graveyard-tier corpus expansion, unless the D2 dan-bin gate fails.
- No mania-tracker calls when generating. Tracker labels are used only in training.
- No upload to osu! and no ranking-criteria compliance: `BeatmapID:0` and `BeatmapSetID:-1` stay.
- No osu!lazer support for remap, and no writing generated sets into Songs. Sets are exported to `Documents/…/карты`; remap writes next to the original, as the rate tab does.
- No mid-search cancel. «Стоп» stops between variant calls.
- No more than 5 difficulties per mapset, 3 rate versions or 24 parts. At most 8 parts can have their own dan.
