# Requests from stream mapgen-ui (B, create-tab UI)

## 1. For the lead / P: delete `tests/createTabCompat.test.js`
- It tests the P0 compatibility flow, where «Создать карту» generated and then saved through `export-set` in one click, with today's result card and its links.
- Plan §1.1 and §12 say that flow lasts only until B lands. B's `createTab.js` no longer saves anything: generating fills the variant cards, and saving is C's export panel.
- So all 3 of its tests fail now, by design.
- What replaces it: `tests/create/createTab.test.js`. It covers the request shape (timing sections, seeds, parts, snaps), the variants and mapset loops, progress by jobId, «Стоп», «Ещё вариант», lock plus regenerate, `timingChanged`, the mode chips and the `getSelection()` contract.

## 2. For the lead: the B8 smoke script is `tests/smoke/electron-create.mjs`, not `electron-ui.mjs create preview`
- The tabs-v2 plan (§1.2) gives `tests/smoke/electron-ui.mjs` to tabs-analysis, which is editing it now. So B8 lives in its own file.
- Run it with `npx electron tests/smoke/electron-create.mjs <outDir> [lang=en]`.
  - User data goes in `<outDir>/user-data`, and the window is muted.
  - Fake `detect-timing` and `generate-map` handlers answer from `tests/fixtures/generateResult.json`.
  - It writes `create-{timing,parts,preview,cards}-{ru,en}.png` and exits 1 if anything overflows the tab sideways.
- The old `create` argument of `electron-ui.mjs` can stay or go; that is tabs-analysis's call.

## 3. For P-final: removing `#dan-rows`
- `createTab.js` no longer reads `#level`, `#step`, `#level-to` or `#step-to`. It hides `#dan-rows`, and `#diffs` (diffList.js) holds the difficulty rows.
- When P-final removes that markup, `tests/createShells.test.js` must change too. Its test «the song mode wraps every control the tab has today» still lists those four ids.

## 4. For A2 (no change needed if the contract holds): how the renderer calls the core
- `createTab.js` imports `src/gen/songParts.js` (`detectParts`, `energyCurve`) and `src/gen/variants.js` (`rankVariants`) with a dynamic `import()`.
  - Until they exist, parts come from the worker's `PartReport[]` and the ranking falls back to `rankFallback` in `resultView.js` (§A2.9 order).
- `detectParts(envelope, slots)` gets the renderer's `onsetEnvelope(...)` (with `frameTimeSec`) and `slotsForTiming(timing, durationMs)`. It should return `[{ startMs, endMs, kind }]`. Other fields are ignored, and an unknown kind is shown as "part".
- `energyCurve(envelope, durationMs, 432)` should give 432 values in 0–1.
- `rankVariants(answers, range)` gets §2.3 answers. It should return them best first (copies are fine, matched by `id`).
- Progress `partSearch`: `i` is read as 0-based, so the text shows `i + 1` (capped at `n`).
- Issue fields: `columns` is worded from `ratio`, falling back to `n`. `pct` is read as a percent; a value ≤ 1 is taken as a share and multiplied by 100.

## 5. For A1 (FYI)
- `createTab.js` statically imports `fineOnset` from `src/audio/fineOnset.js`, and `slotsForTiming`, `clickTimes`, `sectionsToPoints` and `timingSections` from `src/gen/grid.js`. B therefore has to be committed together with A1.
- `detect-timing` gets `fine: { values, hopSec }` from `fineOnset(samples, 22050)`. «Подогнать по волне» sends the same, plus `hint: <current Timing>`. `Timing.refinedErrMs` is shown in the note when present.

## 6. For C (FYI)
- I removed `create.link.open`, `create.link.show` and `create.link.again` from create.js. They belonged to the old one-click result card. C has `create.save.open` / `create.save.show`, and B has `create.variant.more`.
- `initExportPanel({ root, metaRoot, player, getSelection })` is called once at init. `onSongLoaded(song)` is called after every song load, and `onSelectionChanged()` after every run, «Взять этот» and part edit.
  - `song = { path, title, durationMs, envelope, timing, parts }`.
  - `player` is B's audio player (`playFrom(startSec, seconds, { clicks })`, `pause()`, `now()`, `subscribe(fn)`).
