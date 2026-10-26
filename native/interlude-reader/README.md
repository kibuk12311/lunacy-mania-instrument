# interlude-reader

A read-only "now playing" reader for [Interlude](https://github.com/YAVSRG/YAVSRG) (F#, .NET 9). It works like
tosu does for osu!. It is a small C# console app. It attaches to a running `Interlude.exe` with
[ClrMD](https://github.com/microsoft/clrmd) and prints one JSON object per line on stdout: the selected chart, rate,
mods, the current screen, and live score data during gameplay.

It is written for the Lunacy mania Electron app, which owns the process: it spawns the reader, reads stdout line by
line, and stops it by closing its stdin.

## Safety model

* **Read-only, passive.** The reader calls `DataTarget.AttachToProcess(pid, suspend: false)`. That is
  `OpenProcess` plus `ReadProcessMemory`. It never suspends, injects into, writes to or debugs the game. The DAC
  (`mscordaccore.dll`) is loaded into the *reader's* process. If something goes wrong, only the reader crashes.
* **No network by default.** ClrMD gets a file locator that never downloads anything. `--allow-download` turns on
  Microsoft's public symbol server, for the DAC only (see [DAC](#the-dac-problem)).
* **Names are resolved, never hard-coded offsets.** Types and fields are looked up by their F# source names in the
  target's metadata at attach time. Field offsets come from the runtime, so a rebuild of the game does not break the
  reader. Only a *rename* does, and that is reported as an error status instead of a crash.

## Build

Requirements: .NET 8 SDK (8.0.4xx). Internet access is needed the first time only, for NuGet restore (ClrMD,
runtime packs).

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1                 # reader + DAC 9.0.22 + test fixtures
powershell -ExecutionPolicy Bypass -File build.ps1 -SkipFake       # reader only
powershell -ExecutionPolicy Bypass -File build.ps1 -DacVersions 9.0.20,9.0.21,9.0.22
powershell -ExecutionPolicy Bypass -File build.ps1 -NoTrim         # if a future ClrMD breaks under trimming
```

The output goes to `out\reader\`:

```
out\reader\interlude-reader.exe          single file, self-contained, trimmed, win-x64 (~12 MB)
out\reader\dac\9.0.22\mscordaccore.dll   bundled DAC(s), ~1.4 MB each
```

Test (it needs the fixtures from a full `build.ps1`):

```powershell
node test.mjs        # 43 checks, about 45 s; writes out\test-samples.json
```

## Command line

```
interlude-reader.exe [options]
  --pid N                attach to this process id only
  --name NAME            process name to look for (default Interlude)
  --dac PATH             use this mscordaccore.dll
  --allow-download       allow fetching the DAC from msdl.microsoft.com once (cached in %LOCALAPPDATA%)
  --no-mismatch-fallback never use a DAC whose patch version differs from the target runtime
  --selection-hz F       poll rate outside gameplay (default 4)
  --play-hz F            poll rate during gameplay (default 30)
  --no-events            do not emit per-note hit events
  --once                 print one snapshot and exit
  --no-stdin-exit        keep running when stdin closes (default: exit on stdin EOF)
  --exit-with-target     exit (code 0) when the target process exits instead of waiting for a new one
  --verbose              trace to stderr
  --dump FILTER          diagnostic: list target types/static fields matching FILTER and exit
```

Exit codes (mostly relevant with `--once`): 0 ok, 2 game not running, 3 no DAC, 4 cannot open the process,
5 not a .NET process, 6 runtime init failed, 64 bad arguments. In normal mode the reader never exits because of
the game. It waits, re-attaches when Interlude restarts, and exits only when stdin closes.

## Protocol (v1)

stdout is UTF-8, one JSON object per line (`\n`). Every line has `"v": 1`. There are two kinds of line.

### Status lines (`"status"` key)

| status | when | extra keys |
|---|---|---|
| `waiting` | Interlude is not running, has exited, or its runtime is not loaded yet. Emitted once per state change. | `reason` |
| `attached` | Attached to a process. | `pid`, `client`, `version` (Interlude's `Updates.short_version`), `clr` (e.g. `9.0.21`), `clrFileVersion`, `singleFile`, `dac {path, exact, source}`, `fields` (resolved compiled names, for diagnostics) |
| `resolved` | Statics that did not exist yet at attach time became readable. F# initialises module files lazily, see below. | `fields` |
| `error` | Something cannot be read. Each distinct problem is reported **once** per attach. | `code`, `reason` |

Error codes:

* `field_not_found`: an expected type or field is missing, most likely because an Interlude update renamed it.
  The rest keeps working. For example, `{"v":1,"status":"error","code":"field_not_found","reason":"field SelectedChart._rate/rate not found (Interlude version 0.7.28.7)"}`
  means the chart is still reported, only without `rate`.
* `dac_not_found`: no usable `mscordaccore.dll` was found. The reader retries every 30 s.
* `attach_failed`: `OpenProcess` was denied, for example when the game runs elevated and the app does not.
* `not_dotnet`, `runtime_init_failed`: unexpected target or DAC failure.
* `read_failed`: about 50 polls in a row failed. This is reported once; polling goes on.

### State lines (`"client": "interlude"`)

```json
{"v":1,"client":"interlude","version":"0.7.28.7","pid":12624,"screen":"levelselect",
 "chart":{"hash":"…","title":"Freedom Dive","artist":"xi","diff":"4K Another","creator":"Mapper One",
          "keys":4,"lengthMs":258000,"bpm":222,"rating":6.75,"rate":1.25,
          "mods":[{"id":"mirror","state":0},{"id":"nln","state":1}]},
 "autoplay":false,"play":null}
```

* `screen` is one of `splash`, `mainmenu`, `lobby`, `levelselect`, `play`, `practice`, `edithud`, `replay` or
  `score` (`Interlude.UI.ScreenType`). Before the screen module is readable it is `unknown`.
* `chart` is `SelectedChart.CACHE_DATA` (a `ChartMeta`), or `null` when nothing is selected. Its fields:
  * `hash`: Interlude's chart hash.
  * `lengthMs`: the chart length at rate 1.0.
  * `bpm`: the chart's main BPM at rate 1.0.
  * `rating`: Interlude's difficulty rating at rate 1.0.
  * Optional `titleNative` and `artistNative`.
  * `rate`: the selected rate (`SelectedChart.rate`).
  * `mods`: the selected `ModState` (`Map<string,int64>`), sorted by id.
* Outside play screens a state line is emitted **only when something changes** (the poll rate is 4/s).
* On `play`, `practice` and `replay` screens a line is emitted **every poll** (30/s), with `play`:

```json
"play":{"playId":1,"timeMs":2516.5,"songTimeMs":3516.5,"paused":false,"durationMs":125000,"rate":1.25,
        "ruleset":"SC (J4)",
        "hits":{"MARVELLOUS":39,"PERFECT":10,"GREAT":0,"GOOD":0,"BAD":0,"MISS":2},
        "judgements":[39,10,0,0,0,2],
        "accuracy":0.917647,"points":46.8,"maxPoints":51,
        "combo":1,"bestCombo":24,"comboBreaks":2,"maxPossibleCombo":51,
        "notesPassed":51,"eventCount":51,"keyMask":4,"keysDown":[2],
        "events":[{"i":50,"t":2500,"c":2,"k":"hit","d":16.52,"j":0,"m":false}]}
```

| key | meaning |
|---|---|
| `playId` | Goes up for every new play: entering a play screen, or a retry. It is detected because the event count drops or the clock jumps back more than 1 s. A backwards seek in practice mode also counts as a new play. |
| `timeMs` | Chart time: `SongPlayer.TimeWithOffset - first note`. Negative during lead-in. It is in song milliseconds, so it advances `rate` times faster than wall time. |
| `songTimeMs` | Audio position with offsets, the same clock gameplay uses. |
| `paused` | The song clock is paused. |
| `durationMs` | First to last note, in chart milliseconds (`ScoreProcessor.Duration`). |
| `rate` | The rate the play was started with (`ScoreProcessor.Rate`). |
| `ruleset`, `hits` | Ruleset name and judgement counts, keyed by the ruleset's judgement names in ruleset order. `judgements` holds the same counts as an array. |
| `accuracy` | `points_scored / max_possible_points`, 1.0 before the first judgement. This is Interlude's own accuracy for the active ruleset (for example Wife3 or SC). |
| `combo`, `bestCombo`, `comboBreaks`, `maxPossibleCombo` | Combo state, straight from `ScoreProcessor`. |
| `notesPassed` | Notes that are hit or expired (`expired_notes_index`). |
| `keyMask`, `keysDown` | Column press state (`KeyPressReader.current_pressed_keys`, bit *n* = column *n*), as seen by the scoring engine. It is sampled at the poll rate, so short taps between polls are missed. Use `events` for exact hits. |
| `eventCount` | Total `ScoringEvent`s so far. |
| `events` | **Only the new** scoring events since the previous line (at most 512 per line). `i` is the note index, `t` the note's chart time, `c` the column, `k` the kind (`hit`, `hold`, `release`, `drophold`, `regrabhold`, `ghosttap`), `d` the hit delta in ms (negative means early, already divided by rate as Interlude does), `j` the judgement index into `judgements` (missing when the ruleset does not judge this event), `m` missed. If you concatenate `events` over a play you get exactly `eventCount` events, in order. `--no-events` turns this off. |

When the play screen is left, one line with `"play": null` is emitted.

## Integration in Lunacy mania

Done in the app (0.9.2): `app/interludeReader.js` owns the process (spawn, line reader, restart with backoff 1 s → 60 s,
stop by closing stdin, kill as a fallback; `--allow-download` only when the user ticks the setting),
`app/interludeLive.js` turns the lines into the card (selection → library lookup at the selected rate), the live state
in the IL panel and the overlay feed, and `src/overlay/interludeData.js` maps play frames onto the overlay session.
`npm run build:reader` (from the app's root) runs `build.ps1 -SkipFake`. The app's tests replay lines recorded against
the fake (`tools/record-interlude-lines.mjs` → `tests/fixtures/interlude-reader-lines.json`) and run the real reader
against the fake end to end (`tests/interludeReaderE2E.test.js`).

The original sketch:

```js
const { spawn } = require('child_process');
const readline = require('readline');
const exe = app.isPackaged
  ? path.join(process.resourcesPath, 'interlude-reader', 'interlude-reader.exe')
  : path.join(__dirname, '..', 'native', 'interlude-reader', 'out', 'reader', 'interlude-reader.exe');
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
readline.createInterface({ input: child.stdout }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.status) { /* waiting / attached / resolved / error */ }
  else if (msg.client === 'interlude') { /* state: msg.screen, msg.chart, msg.play */ }
});
child.on('exit', code => { /* restart with backoff unless the app is quitting */ });
// stop: child.stdin.end()  (the reader exits within milliseconds; kill() as a fallback)
```

* Keep stdin as a **pipe**. With `stdio: 'ignore'` stdin is at EOF right away and the reader exits. If needed, pass
  `--no-stdin-exit`.
* electron-builder: ship the folder as an extra resource, so the exe stays outside the asar:

```json
"extraResources": [
  { "from": "native/interlude-reader/out/reader", "to": "interlude-reader",
    "filter": ["interlude-reader.exe", "dac/**"] }
]
```

* Run `build.ps1 -SkipFake` before packaging. The reader is about 12 MB, plus about 1.4 MB for each bundled DAC.
* To merge with the osu! flow, map `chart.hash` to Interlude's hash, use `chart.rate`, and use `play.hits` and
  `play.accuracy`.

## First run on the real Interlude (checklist)

Run these from `native\interlude-reader\out\reader\` (or `resources\interlude-reader\` of an installed app) with
Interlude open on the level select screen and a 4K chart selected. Nothing here writes to the game.

1. `interlude-reader.exe --once` → an `attached` line and one state line. Check in `attached`: `version` (Interlude's,
   e.g. `0.7.28.7`), `clr` (the runtime it ships, e.g. `9.0.x`), `dac.source` / `dac.exact` (`bundled` and `true` is
   best; `exact: false` means the 9.0.22 DAC is used on another 9.0 patch, which should still work), and that `fields`
   has no `null` for `SelectedChart.*` once a chart is selected. Exit code 3 = no DAC (`dac_not_found`): try again with
   `--allow-download` once, then note the `clr` version so it can be bundled.
2. In the state line: `screen` is `levelselect`, `chart.hash` / `title` / `artist` / `diff` match what Interlude shows,
   `chart.rate` follows the rate (change it in game and run `--once` again), `chart.mods` lists the mods.
3. `interlude-reader.exe --dump SelectedChart` → the compiled names of the module; compare with the table above
   (`CACHE_DATA@N`, `_rate@N`, `_selected_mods@N`, `autoplay@N`). Same with `--dump Screen`, `--dump PlayScreen`,
   `--dump ScoreProcessor` and `--dump Audio` if anything is missing. Any `field_not_found` line names the field.
4. Live: `interlude-reader.exe --verbose` (Ctrl+C to stop), then play a chart for ~20 s: a line per poll with `play`;
   check `timeMs` starts negative and counts up ~`rate`× wall time, `hits` keys are the ruleset's names (SC, Wife3,
   osu!mania…), `accuracy` matches Interlude's HUD, `events` carry `c` (column), `d` (delta) and `j`, `keysDown` lights
   while holding a key. Retry once → `playId` goes up; finish → `screen` `score` and `play: null`.
5. **To confirm against the game** (the fake can't tell): whether an event's `t` is on the same clock as `timeMs`
   (0 at the first note — the app assumes so for the key lines and KPS; if `t` turns out to be absolute song time, the
   app's `pressTime()` needs the first note added back), the event kinds for holds (`hold`, `release`, `drophold`,
   `regrabhold`), practice mode and replays, an elevated Interlude (`attach_failed`), Interlude closing and reopening
   (`waiting` → `attached`), and the `field_not_found` text if a newer Interlude renamed something.
6. In the app: link the folder, keep «Следить за Interlude вживую» on; the footer reads «Interlude · live», the card
   follows the selection at its rate, the overlay (OV on) shows the play. `userData\log.txt` has the reader's
   `interlude live:` lines (attach, DAC source, selections).

## How it works


### Compiled names (found with `--dump`, against fixtures built with the same F# shapes)

F# module-level `let` / `let mutable` bindings compile to a static property on the module class. The backing
static field is `name@<line>` on the file's startup class `<StartupCode$Assembly>.$<FileName>`. The reader tries the
module class first (in case a future compiler uses `--realsig+` and puts the field there), then the startup class
of that file, then every startup class in the assembly. Line suffixes (`@43`) are matched by pattern, so code that
moves around does not matter.

| Interlude source | Compiled (fixture, F# 8; same scheme in F# 9) |
|---|---|
| `Interlude.UI.Screen.current_type` (module `Screen` next to type `Screen` → `ScreenModule`) | `<StartupCode$Interlude>.$Screen.current_type@N` (int, non-GC static) |
| `Screen.current` (private) | `<StartupCode$Interlude>.$Screen.current@N` |
| `Interlude.Features.Gameplay.SelectedChart.CACHE_DATA` | `<StartupCode$Interlude>.$SelectedChart.CACHE_DATA@N` (`FSharpOption<ChartMeta>`, field `value`) |
| `SelectedChart._rate` (`Setting.Bounded<float32<rate>>`) | `$SelectedChart._rate@N` → record field `Get@` → closure `Setting+simple@36-1<float>` → field `x` (`FSharpRef<float>`) → `contents@` |
| `SelectedChart._selected_mods` | `$SelectedChart._selected_mods@N` → same Setting path → `FSharpMap` → `tree` → `MapTree`/`MapTreeNode` (`k`, `v`, `left`, `right`) |
| `SelectedChart.autoplay` | `$SelectedChart.autoplay@N` (bool) |
| `Interlude.Updates.short_version` | `<StartupCode$Interlude>.$Updates.short_version@N` |
| `Percyqaz.Flux.Audio.SongPlayerInstance.Song` | `<StartupCode$Percyqaz-Flux>.$Audio.Song@N` (`SongPlayer`: `time_at_start_of_frame`, `compensation_at_start_of_frame`, `rate`, `global_offset`, `song.LocalOffset@`, `state._tag`) |
| `ChartMeta` record | backing fields `Hash@`, `Title@`, `Artist@`, `DifficultyName@`, `Creator@`, `Keys@`, `Length@`, `BPM@`, `Rating@`, … |
| play screen | `Screen.current` is the object expression `<StartupCode$Interlude>.$PlayScreen+Create@N : IPlayScreen`, field `state` (`PlayState`) → `scoring@N` (the `let mutable scoring`) → `ScoreProcessor` |
| `ScoreProcessor` (and its bases `GameplayEventProcessor`, `KeyPressReader`) | `judgement_counts`, `points_scored`, `max_possible_points`, `current_combo`, `best_combo`, `combo_breaks`, `max_possible_combo`, `scoring_events` (`List<ScoringEvent>`), `ruleset`, `first_note`, `expired_notes_index`, `current_pressed_keys` (`Bitmask{Value@: uint16}`), `Rate@`, `Duration@` |
| `ScoringEvent` | `Index@`, `Time@`, `Column@`, `Inner@` (`ScoringEventInner+Hit` etc. → `item` → anonymous record `Delta@`, `Judgement@` (`FSharpOption<Tuple<int,float>>` → `m_Item1`), `Missed@`) |

The real game could not be inspected: it is not installed here, and downloading and running Interlude binaries
was off limits. The fixture in `fake/` mirrors the declarations from the Interlude source (names, types, mutability,
class `let` vs `member val`, object expression, module/type name clash) and is built like the game: an F# EXE across
4 assemblies, `PublishSingleFile`, self-contained, `PublishTrimmed` with `TrimMode=partial`. Run
`interlude-reader --dump SelectedChart` against the real game to confirm.

### Things that turned out to matter

* **Interlude is single-file + self-contained** (`tools/Client/Releases.fs`: `-p:PublishSingleFile=True
  --self-contained true`). The runtime is linked into `Interlude.exe` and no `mscordaccore.dll` ships with it.
  See below.
* **Statics appear lazily.** F# initialises each file on first access, so `$SelectedChart` may not exist yet when
  the reader attaches. Even after it does, the DAC instance has cached the old view: new modules and types show up
  with `null` names. `ClrRuntime.FlushCachedData()` frees ClrMD's metadata importers and crashes the reader with an
  AccessViolation, so the reader **recreates the ClrRuntime** instead. That is a fresh DAC instance and takes about
  50 to 150 ms. It happens every 2 s while statics are still missing (for at most 120 s), and when a type without
  metadata is seen (for example the first play after attach). In steady state, no refreshes happen.
* **Static slot storage.** On .NET 8 and 9, reference statics are in pinned-heap arrays and their addresses are
  stable. If a slot ever turns out to be in a movable GC array, the reader follows the strong handle to that array
  on each read instead of caching the address. `fields` in the `attached` line shows the storage class.
* **Objects move.** Nothing below the static roots is cached by address. Each poll walks
  `static → screen → PlayState → ScoreProcessor` again, which is about 60 small `ReadProcessMemory` calls. Field
  layouts are cached per MethodTable. A forced compacting GC in the middle of play is part of the test.
* **No heap walks.** Nothing ever enumerates the GC heap. The play objects are reached from `Screen.current`.

### The DAC problem

ClrMD needs `mscordaccore.dll` from the same .NET build as the target. For a single-file app it is not on disk
anywhere. Search order:

1. `--dac PATH`
2. paths reported by ClrMD (for framework-dependent targets, the shared framework directory)
3. `<reader>\dac\<version>\mscordaccore.dll` (bundled by `build.ps1 -DacVersions`, taken from the official
   `Microsoft.NETCore.App.Runtime.win-x64` NuGet packages)
4. `%LOCALAPPDATA%\interlude-reader\dac\<version>\` (cache)
5. next to the target exe, and `%ProgramFiles%\dotnet\shared\Microsoft.NETCore.App\<version>\`
6. only with `--allow-download`: Microsoft's symbol server, using the index stored in the target's runtime. The
   result is cached in (4), so later runs are offline.
7. fallback: the newest DAC with the **same major.minor** from (3) to (5), loaded with `ignoreMismatch`. The
   `attached` line then reports `"exact": false`.

`<version>` is the product version, for example `9.0.21`. ClrMD reports coreclr's *file* version
(`9.0.2126.50404`) and the reader converts it. Which 9.0.x Interlude 0.7.28.7 was built with is not known (the
release is built on the developer's machine), so the build bundles the newest one (9.0.22) for the fallback.
Servicing releases practically never change what the DAC reads. In the tests, a 9.0.22 DAC read a 9.0.21 process
correctly. If exactness matters, pass `--allow-download` once, or bundle the exact version once the `attached` line
shows it.

## Performance (measured against the fixture, 150 s soak test)

| | CPU (% of one core) | working set | private bytes |
|---|---|---|---|
| level select, idle (4 Hz polls, nothing emitted) | 0.18 % | 46 MB | 18 MB |
| gameplay (30 Hz, about 31 lines/s, about 21 KiB/s of JSON) | 1.2 % | 48 MB, flat over 90 s | 19.5 MB, flat |

A poll takes about 0.3 ms. Most of the working set is the DAC and the runtime. A small gen0 GC is forced every 8 MB
allocated; without it, garbage grows until the first GC, which can take tens of MB.

Binary: 12.0 MB single file (trimmed and compressed). Without trimming it is 34.2 MB. ClrMD's only trim warning is
in its symbol-server HTTP code, which only runs with `--allow-download`.

## Limitations and risks

* **Interlude updates.** Anything listed in the table above can be renamed. A rename gives a `field_not_found`
  status for that part only. Fixes are usually a one-line name change in `InterludeModel.cs`. Higher-risk spots:
  * `PlayState.scoring`: also found by type, as a fallback.
  * The object-expression play screen: only its `state` field is needed, inherited from `IPlayScreen`.
  * `Setting` closures: the walker follows `Get@` through wrapper closures until it finds an `FSharpRef`.
  * Moving `SelectedChart` or `Screen` to another file or module: the startup class name changes, but the reader
    searches all startup classes.
* **.NET major upgrades.** If Interlude moves to .NET 10, a .NET 10 DAC is needed (bundle `10.0.x`), and possibly a
  newer ClrMD. ClrMD 3.1 could **not** read static fields on .NET 9 (DomainLocalModule is gone), which is why this
  uses ClrMD 4.2.
* **Torn reads.** The game is not paused while being read. A frame can mix values from two game frames, for
  example a judgement count one higher than `eventCount`. Values are re-read at 30/s, so this corrects itself.
  Consumers should not assume cross-field invariants within a single line.
* **No lazer-like extras.** The reader exposes what Interlude's scoring holds: judgements, accuracy and combo
  under the active ruleset. There is no pp and no osu!-style score; compute them in the app from `events` if
  needed. Hit deltas are available through `events`.
* **Key state** is sampled. Exact input timing is not exposed.
* **Elevation.** An elevated Interlude cannot be opened by a non-elevated reader. You get `attach_failed`.
* **Antivirus.** Reading another process's memory is legitimate (dotnet-dump does the same), but heuristic AV may
  flag unsigned tools that do it. Signing the exe helps.
* Windows x64 only. Interlude's Linux and macOS builds would need ClrMD's Linux/macOS data readers and the matching
  DAC; this is not done.
