# Notes and requests from stream mapgen-core (A1 + A2)

No change in another stream's files is needed for the contracts to hold. These are things the other streams should
know when they wire the core in.

## 1. For B (create-tab UI): the red lines are placed like people place them, about 23 ms before the attacks

- `detectTimingFull` with `fine` moves every red line by `OFFSET_BIAS_MS` (`src/audio/fineOnset.js`), which is now **−23 ms**.
- It was fitted with `npx electron tools/eval-timing.mjs … --decoder chromium` on 157 held-out maps whose BPM we got right. It is the shift that puts the most human red lines within ±5 ms.
- Human red lines sit about 23 ms before the attacks in the app's own decode (Chromium, 22050 Hz).
  - With the ffmpeg decode the gap is about 27 ms.
  - OGG files show 14–19 ms, so most of it is mapping habit (or osu!'s own latency), not MP3 encoder delay alone.
- **Effect on the B live check «clicks must sit exactly on the audio clicks»:** on a WAV click track the detected red line comes out about 23 ms before the clicks. The playfield's hit clicks will then sound that much early against the decoded buffer.
- If B wants the in-app preview to line up with what it plays, the playfield and the click scheduling can add `-OFFSET_BIAS_MS` when they draw or click. That is B's call.
- The map itself is meant for osu!, where human maps with this offset feel right.

## 2. For B: what the core returns, beyond §2.3

- `detectParts(envelope, slots)` returns `[{ startMs, endMs, kind }]`. The parts are contiguous, start at 0, and end at the envelope's end.
- `energyCurve(envelope, durationMs, n)` returns a `Float64Array` of `n` values in 0–1. A song at one constant level gives all 1.
- `rankVariants(answers, range)` returns a new array, best first, holding the same objects.
- Progress phases are `prepare`, `partSearch` (`i` 0-based, `n`, `kind`), `search` (`i` counts analyses, `n` = 0), `retry` (`i` = round, `n` = 2) and `describe` (`i` 0-based over the parts, `n` = parts).
- Issues:
  - `col` is 0-based.
  - `pct` is a whole percent.
  - `columns` carries `ratio` (busiest ÷ quietest) when the quietest column has notes; it always carries `n` (the busiest column's notes).
- `retries` may also carry `reverted: true`: redone blocks took the dan out of range, so the searched map came back. `retries.blocks` is then 0.
- `Timing.refinedErrMs` is the median distance in ms between the attacks of the strong beats and the grid, averaged over the sections.

## 3. For D (dataset v2): the A1 hooks

- **Beat labels:** `labelBeatSnaps(rows, beats, [4,3,6,8])` (mapRows.js), where `beats = beatsFromTiming(parseRedTimingPoints(osu), endMs)` (grid.js).
- **Slots:** build them only on each beat's labelled grid, with `slotsForBeats(beats, (i) => divs[i] || 4)`. Then `labelSlots(rows, slots)`; its tolerance is now `min(12, step/3)`.
- **Features:** `slotFeatures(envelope, slots, bpm, AUDIO_FEATURES_V2)` and `beatFeatures(envelope, beats)` / `BEAT_FEATURES` (snap.js).
- **Families of `beat_on3/4/8`:** `beat_on3` is set for 1/3 **and** 1/6 beats; `div` tells them apart.
- **Feature names:** pass `names` to `slotFeatures` and store `AUDIO_FEATURES_V2` as the model's `features`. The generator selects columns by these names, and an unknown name throws.
- **Order-3 pattern tables:** the keys are `"prev,prev2,prev3,size"`, and the model sets `patternOrder: 3`. The sampler falls back to order 2, then to order 1, below 20 sightings.
- **Divisor head:** `model.divisor` takes `classes` (default `[4,3,6,8]`) and, optionally, its own `features` list. Without that list its inputs are `BEAT_FEATURES` followed by `model.conditioning` (`dan`, `fam_<Family>`).
  - `snapTransitions` is a 4×4 array in the head's class order (rows: from, columns: to), or `{ from: { to: p } }`.
- **Row source for nn-v1:**
  - `prepare` gets `audio = { envelope, names, rows }`, where `names` are the model's `features` and `rows` are their values per slot.
  - It also gets `dan` (a `Float64Array` per slot) and `family` (a string per slot, null in empty parts; the generator never calls `step` for those slots).
  - `ctx.recent` is newest first.
