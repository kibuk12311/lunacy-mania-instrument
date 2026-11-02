# Interlude replays in the Replay tab (0.10.10)

Interlude (github.com/YAVSRG/YAVSRG) keeps every saved play's replay in `Data\scores.db`, table `scores`
(`Id, ChartId, Timestamp, Replay BLOB, Rate REAL, Mods TEXT (JSON), IsImported, IsFailed, Keys`). The Replay tab reads
only osu! `.osr` files today. This adds Interlude's own plays: listed beside osu!'s, opened, judged the way Interlude
judges them, and opened by themselves after a play in Interlude.

## Decisions

- **Judging.** Interlude does not store judgements: its score screen re-judges the replay with the selected ruleset.
  We port Prelude's judging (MIT: `prelude/src/Gameplay/Scoring/GameplayEventProcessor.fs`, `HitMechanics.fs`,
  `ScoreProcessor.fs`, `OsuHolds.fs`, `Rulesets/*.fs`, `Lamps.fs`, `Grades.fs`) to JS, float32-exact (`Math.fround`
  on every float32 operation, as `src/interlude/chart.js` does). The port must give the same events, judgement
  counts, accuracy (bit-identical double), combo and combo breaks as Interlude's own compiled Prelude on real plays.
- **Ruleset.** The one selected in Interlude (`Data\options.json` `SelectedRuleset` = file `Rulesets\<id>.ruleset`,
  JSON). Interlude writes options.json only as it closes, so while it is followed live the ruleset the reader saw on
  its last play (by name) comes first; with no options.json yet it is SC J4, Interlude's default. The report can switch
  to any other ruleset in that folder (judging takes milliseconds). A missing or invalid file falls back to SC J4,
  Interlude's default, built in, and the report says so.
- **Failed plays** (`IsFailed`) are judged up to the last frame (what was played), like a failed osu! play. Interlude
  itself judges them over the whole chart (`ProcessEntireReplay`, every note after the fail a miss) and shows that
  accuracy, marked failed; the report gives it in the accuracy tile's title. Plays that were not failed are judged to
  the end like Interlude.
- **Mods.** `mirror`, `noln` (states 0-3) and `nosv` are supported (the notes are changed the way Prelude changes
  them). Any other stored mod (`shuffle`, `random`, `inverse`, `column_swap`) gives the reason "mods" with its names:
  none of the plays checked use them, so they could not be checked against Interlude.
- **Imported plays** (`IsImported`: osu! replays imported into Interlude) are not listed: the tab reads them from
  osu! itself.
- **Six slots.** The analysis keeps osu!'s six slots (`max, n300, n200, n100, n50, miss`) so everything downstream
  works, and adds the ruleset's own judgements for what is shown. A ruleset of six judgements (all shipped ones:
  osu! ODx, SC Jx, Wife3 Jx) fills them in order; another count maps the way the overlay does
  (`src/overlay/interludeData.js mapJudgements`): the first ones in order, the last one is the miss. The report and
  the playback show the ruleset's names and colours, counts per ruleset judgement come from the engine (exact).
- **No header.** An Interlude replay has no counts of its own: the recount is the result. No "In the replay"
  column, no comparison, no ScoreV2/hold approximation notes.
- **Timing hints** about HitPosition (bias) are osu!-only: none for Interlude plays.
- **Imported or not, Keys other than 4** open with the reason "keys", like osu!.

## Contracts

### Engine (`src/interlude/`, pure)

- `replay.js`
  - `readIlReplay(blob) → { times: Float32Array, masks: Uint16Array }`: gunzip, int32 count, frames of float32
    ChartTime (ms since the first note of the chart after mods, at rate 1.0) + uint16 key mask. Throws on a bad
    stream, a wrong length, a non-finite or decreasing time.
  - `parseIlMods(text) → { mods: { id: state }, unsupported: [id], labels: [display name] }`.
  - `applyIlMods(chart, mods) → chart` for `{ keys, notes: [{ time, data }], bpm, sv }` (decodeChart's shape):
    mirror, noln (0-3), nosv; order as Prelude (`Mods.fs`).
  - `ilNotes(chart) → [{ t, col, end }]`: the app's note shape, `t`/`end` in chart ms (absolute), `end` null for a tap.
- `ruleset.js`
  - `parseRuleset(json) → ruleset` (validated; float32 windows; throws why on an unknown or invalid variant).
  - `SC_J4` (the built-in fallback), `rulesetSlots(ruleset) → [slot per judgement]`.
- `judge.js`
  - `judgeIlReplay({ ruleset, chart, frames, rate, untilLastFrame }) → { events, counts, accuracy, pointsScored,
    maxPossiblePoints, maxCombo, maxPossibleCombo, comboBreaks, lamp, grade, formattedAccuracy }`, `chart` after
    mods, `rate` as float32. `events` in emission order with `kind` (HIT, HOLD, RELEASE, DROP_HOLD, REGRAB_HOLD,
    GHOST_TAP), `index` (note row), `time` and `noteTime` (chart ms since the first note), `column`, `delta` (real ms,
    positive late), `judgement`, `points`, `missed`, `overhold`, `dropped`, `combo` (INCREASE, BREAK,
    BREAK_INSTEAD_OF_INCREASE, NO_CHANGE): the oracle's schema, so a test can compare them one to one.

### Analysis (`src/replay/analyzeInterlude.js`)

`analyzeIlReplay({ ruleset, chart, notes, frames, rate, failed, parts, hands }) → analysis | { reason }` with the
same fields as `analyzeReplay` (src/replay/analyze.js) plus:

- `source: "interlude"`, `exact: true`, `failed`, `od: null`, `scoreV2: false`, `holdHeavy: false`,
  `headerCounts: null`, `headerCombo: null`, `comparison: null`.
- `ruleset: { name, judgements: [{ name, color: "#rrggbb", breaksCombo, slot, early, late }] }` (windows in real ms),
  `judgementCounts: [count per ruleset judgement]`, `counts` (six slots), `accuracy` (percent, may be negative),
  `accuracyText` (Interlude's own formatting), `wholeAccuracyText` (a failed play's accuracy over the whole chart, as
  Interlude shows it; null on a whole play), `lamp`, `grade` (names, or null).
- `combo: { max, breaks: [{ t, col, combo }] }` from the engine's combo (a combo breaks on every judgement whose
  `BreaksCombo` is set and on a dropped hold, not only on a miss; a ghost tap a ruleset judges and breaks on is one too,
  with `ghost: true` and its `j`). `t` is the note's (a hold's head); a hold broken after its head adds `at`, when it was
  let go, or its end's time with `end: true`, and the break list shows that time ("hold end" for the end).
- `steps: [{ t, combo, j, points }]`: one per engine event that changed the combo or gave a judgement, in the engine's
  order (t chart ms, absolute; `j`/`points` null for none). The playback's combo, running counts and running accuracy
  read them as they are: rebuilding them from `results` (one per note) cannot know the engine's order within a ms, a
  hold's drops or a head hit on a failed play whose end never came.
- `results`: one per note reached, as today (`t, col, end, kind, at, press, up, early, delta`) plus `j` (ruleset
  judgement of the note, null when none), `points` (sum of the note's points), `weight` (how many judgements the note
  got: 0, 1 or 2) and `breaks` (the note broke the combo). `early` is always false. Times in chart ms (absolute),
  `delta` real ms.
- `unfinished`: on a failed play, the holds whose head was judged but whose end never came (still held at the last
  frame, or never grabbed), in the shape of `results`; empty on a whole play. Not counted anywhere: the playback's
  stage draws them, since its HUD counts their heads.
- `windows`: the six osu! keys as today (chart ms, so × rate), each the widest side of the slot's ruleset window, and
  `miss` the widest note window: code that reads them keeps working; exact colouring reads `ruleset.judgements`.
- `ghosts`: GHOST_TAP presses `[{ t, col }]`.

Accuracy of any set of results (per finger, per part): `resultsAccuracy(list)` in `src/replay/judge.js`: Σpoints /
Σweight × 100 when the results carry `weight`, else osu!'s formula as now (the osu! path does not change).

### Main side

- `app/interludeLibrary.js`: `replays({ limit, chart, since })` (rows without the blob, newest first, not imported),
  `replay(chart, timestamp)` (the row with its blob), `rulesets()` / `ruleset(id)` / `selectedRuleset()` (read only).
- `app/replayInterlude.js`: list, open, audio path, earlier plays, the play-ended wait; `app/replayIpc.js` branches to
  it. A play's id is `interlude:<ChartId>:<Timestamp>`.
- IPC (additive): `replay-list` items gain `{ kind: "interlude", play, chart, at, rate, modNames, accuracy, miss,
  failed, artist, title, version, found }`, the reply gains `interlude: { linked, ok, reason }`;
  `replay-open({ play, ruleset })` answers like an `.osr` open plus `replay.source: "interlude"`, `replay.play`,
  `replay.failed`, `rulesets: [{ id, name }]`, `ruleset: { id, name, fallback }`, reasons `keys`, `mods` (with
  `mods`: Interlude's own short names, SHF, RD, …, as `modNames` are), `empty`, `nochart`, `badReplay`; a play id that
  is no play or a play gone from scores.db is refused with `replay.err.noPlay`; `replay-earlier` works for Interlude
  plays (same chart, same ruleset, `rate` as the tab shows it); `replay-bias` answers no plays; `replay-ended` for
  Interlude carries `play`, `chart` and `source: "interlude"`, and `reason: "noFolder"` when Interlude's folder cannot
  be read.
- After a play: `app/interludeLive.js` sees the play screen give way to another, the local profile passes the play
  end to its listeners (not to the recorder), and the Replay tab waits for the new row of `scores.db` like it waits for
  osu!'s file.

## Checks

- Prelude's own tests ported as golden cases (`GameplayEventProcessorTests`, `ScoreProcessorTests`,
  `RulesetOsuParityTests`, `RulesetQuaverParityTests`, `LampTests`, `GradeTests`, `ReplayTests`).
- Off the repo, on a real player's plays: every event, count, accuracy and combo of the port against Interlude's own
  compiled Prelude (extracted from Interlude.exe and run on the same replays) for every 4K play and every ruleset.
- The tab: list, open, ruleset switch, after-a-play, in the tests and once in the real window.
