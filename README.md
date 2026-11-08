# Lunacy mania instrument

**osu!mania 4K dan calculator and toolkit** for osu! stable, lazer and Interlude.

**English** · [Русский](README.ru.md)

**Lunacy mania** is a small always-on-top window for **osu!mania 4K rice** players. It shows the dan of the map you have selected in osu!, changes rates, builds marathons and dan courses, picks maps for your skill and can map a song for you.

[![Latest release](https://img.shields.io/github/v/release/kibuk12311/lunacy-mania-instrument?label=download)](https://github.com/kibuk12311/lunacy-mania-instrument/releases/latest)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-informational)
![License](https://img.shields.io/badge/license-MIT-green)

![The app's tabs](docs/images/tabs-en.png)

## What it does

| Tab | What you get |
|---|---|
| **Analysis** | The dan of the selected map (Alpha…Kappa and the numbered dans below; past Kappa high it reads "above Kappa · 21.3"), how sure it is, the main patterns, MSD and Sunny ★. Pick the calculator: our combined one, Mixed, Daniel, Azusa, Roxy, Companella, or all of them side by side. A difficulty line along the map, patterns by part, **dan by part** (each part of the map rated by the dan model as a map of its own, a step chart with the hardest part marked), "for you" (how the map compares with your skill) and a dan-by-rate ladder. DT and HT are taken into account. |
| **Rate** | Makes rate versions of a map next to the original (audio included, pitch kept or not). Finds the rate that puts a map at a target dan, does several rates at once, mirrors a chart or strips its LNs, and remembers presets. |
| **Marathon** | Joins maps into one marathon or dan course `.osz`, with breaks you choose. Course templates, an automatic marathon built from your skill profile, and a difficulty curve of the whole course. |
| **Picks** | Maps worth playing for your skill, by pattern and goal (comfort, growth, challenge) or your own dan range. Your skill comes from [mania-tracker](https://mania-tracker.com). One-click download, a training plan, similar maps, favourites exported as an osu! collection, and progress over time. |
| **Replay** | A play taken apart from its `.osr` (dropped, picked, or from osu! stable's own folders, which are only read): the manip percent first, then playback on your own skin with the song, judgements recounted against the replay's, and statistics per finger and per hand, timing from start to end, keys against the map, ghost presses, combo breaks with their place and pattern, the hardest parts, dan by part and earlier plays. When a play ends in osu! stable the tab opens its replay by itself, without taking the focus from the game. Interlude's own plays are in the same list (from its `Data\scores.db`, only read), judged exactly as Interlude judges them, by the ruleset chosen in Interlude or any other of its rulesets, and a play that ends in Interlude opens by itself too. 4K only; nothing of this goes to the overlay. |
| **Create** (Create map) | Maps a song for you: detects BPM and offset (also songs with several BPMs, 1/3 and 1/6 snaps), finds the song's parts and lets you give each part its own dan and patterns. Several variants, a preview player with a playfield, locking a part and regenerating the rest, a whole mapset or a dan ladder in one click, rate versions, metadata and background. It can also remap an existing map one dan up or down, keeping its trills and adding no minijacks or anchors unless you allow them. |
| **Skin** | An osu!mania 4K skin editor and builder: open one of your osu! skins (as a copy), an `.osk`, or make one from scratch (note shape, column colours, keys, holds, stage, judgements, lighting — all drawn by the app, @1x and @2x). Edit the [Mania] 4K values and pictures with a live playfield preview, undo / redo, and save an `.osk` that osu! stable and lazer import; a skin made from scratch also exports for Interlude. |

The interface is in Russian and English (on the Settings page — ⚙ under the card — or the tray menu).

![The Replay tab: the manip percent, playback on your skin, statistics per finger and keys against the map's density](docs/images/replay-en.png)

## Download

Get it from the [latest release](https://github.com/kibuk12311/lunacy-mania-instrument/releases/latest):

- **`Lunacy-mania-Setup-<version>.exe`** — the installer. Installs for your Windows user only (no admin), adds Start menu and desktop shortcuts, and **updates itself**: when a new version is out it downloads it in the background and asks to restart.
- **`Lunacy-mania-Portable-<version>.exe`** — portable, nothing to install. It tells you when a new version is out and opens the download page.

The app isn't code-signed, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.

**Needs:** Windows 10 or 11 (64-bit) and **osu! stable or osu! lazer** — or **[Interlude](https://github.com/YAVSRG/YAVSRG)** (portable, from 0.9.2; see below). The app reads the selected map through [tosu](https://github.com/tosuapp/tosu), which comes bundled and starts by itself (the footer shows which one it is connected to). Picks, downloads and update checks need the internet; everything else works offline.

**With Interlude** (0.9.2) — Interlude has no API that says what is selected or played in it, so the app works with its folder, and a small bundled helper, `interlude-reader.exe`, reads the running game the way tosu reads osu!:
- **Link the folder:** ⚙ Settings → Interlude → «Pick folder…» (the folder with Interlude.exe, Songs and Data) or «Find». The app only reads Interlude's `Songs\charts.db` and `Data\scores.db`, from copies it makes in its own folder; nothing is ever written into `Songs`. Once it is linked and Interlude is on, the **IL** button in the card's footer opens that block.
- **Turn it off:** «Enable Interlude», the block's first line (0.10.11), turns Interlude off for the whole app and keeps the folder: no Interlude maps in sessions, no Interlude plays in the Replay tab, no following the game. Tick it again and everything is back, with nothing analysed anew.
- **Analyse a chart:** search Interlude's library in the same panel (artist, title, difficulty) and click a chart: the card shows its dan, patterns, MSD and rates, and the Rate tab works on it (a copy with its audio goes to Documents\Lunacy mania\interlude).
- **Send maps to Interlude:** rate copies, marathons, generated maps, remaps and downloads get a «→ Interlude» button. Interlude can't be told to import a file from outside, so the app packs an .osz, shows it in Explorer and brings Interlude to the front (or starts it) — drag the .osz onto Interlude's window.
- **Playlists:** «Playlist in Interlude» adds a marathon list (each map at its rate), the Picks plan or your favourites to Interlude's `Data\collections.json` as a playlist. Interlude must be closed (it rewrites that file when it exits); the old file is kept as `collections.json.bak-<date>`, and maps not in your Interlude library yet are listed — import them first.
- **Played maps:** with the folder linked, Picks' «hide played» also hides osu! maps you played in Interlude.
- **Live card:** with «Follow Interlude live» on (the default once the folder is linked; the IL panel), the card shows the chart you select in Interlude at its rate, like osu!'s selection, and the footer reads **«Interlude · live»**. With osu! running too, whichever selection changed last has the card. A chart that isn't in the linked library yet (just imported) is shown by its name with a note.
- **Overlay:** the in-game overlay shows plays in Interlude: the judgements under the ruleset's own names (SC, Wife3, osu!mania…) with Interlude's accuracy, KPS and key lines from your real presses, UR from the hit deltas, the chart's NPS; a retry starts over, the score screen counts as the results.
- **How the reader works:** it only *reads* Interlude's memory (like dotnet-dump; no writing, no injection, no network). It needs a .NET helper file (`mscordaccore.dll`) matching Interlude's runtime; one ships with the app. If none fits, the panel says so — tick «Download .NET's helper file if it's missing» and it is fetched once from Microsoft's symbol server and kept. **Antivirus:** reading another program's memory can make a heuristic antivirus flag the unsigned `interlude-reader.exe`; it's in `resources\interlude-reader\` — add that folder to the exclusions if it gets removed (the panel then says the helper is missing). Run Interlude normally, not as administrator (the panel tells you if it can't open the process).
- **«Did Interlude update? The scanner didn't find …»:** a new Interlude version renamed something the reader looks for. The rest keeps working (pick charts in the IL panel as before); a new version of the app fixes it — report it with the line from the panel.

**With Etterna** (0.10.12) — the app reads your Etterna folder; nothing is read from the running game and nothing is written into it:
- **Link the folder:** ⚙ Settings → Etterna → «Pick folder…» (the folder with Songs and Program) or «Find». Every 4K chart (`dance-single`) in `Songs`, `AdditionalSongs` and the folders named in Etterna's `AdditionalSongFolders` is read; Etterna's MSD comes from a copy of its `Cache\cache.db`. The first time takes a while for a big library; after that only changed files are read again.
- **Dans:** search the list (pack, song, artist, difficulty) and pick a rate from 0.7x to 2.0x: each chart shows Etterna's own MSD at that rate (0.1 steps) and its dan beside it. Click a chart to put it on the card: dan by part, patterns and details, at that rate. Charts the converter can't place exactly (warps, fakes) are listed as not rated.
- **Turn it off:** «Enable Etterna», the block's first line, turns Etterna off for the whole app and keeps the folder.

**On osu! lazer** a few things work differently, because lazer keeps its maps in its own file store instead of a Songs folder:
- **Rate**, **remap** and **«+ selected in osu!»** in Marathon work on a copy of the map in Documents\Lunacy mania\lazer; nothing is ever written into lazer's folder. Rate copies and remaps are packed into an .osz (in Documents\Lunacy mania\карты) and opened, so lazer imports them as a **separate beatmap set** (no F5 needed; if lazer doesn't open it, drag the .osz into its window).
- **Collections:** lazer can't take a collection.db. The export still writes one (for stable) and, with lazer connected, a list of the maps with links next to it, so you can add them to a collection in lazer yourself.
- Lazer's own speeds (DT/HT at any speed, Rate Adjust) are read as the rate everywhere, and the overlay's key lines use lazer's real key presses. Run lazer in **Borderless** or **Windowed** mode for the overlay. tosu downloads what it needs for each new lazer version by itself; right after a lazer update that can take a moment.

## How to use

1. Start osu! and the app, go to song select. The card shows the selected map's dan.
2. **⚙** under the card opens the **Settings** page (also "Settings…" in the tray): the calculator, the language, 📌 always on top, the overlay, Interlude, the profile source and "Record my plays", folders, updates, osu!/tosu, caches and About. 📌, the language and "Check for updates" are in the tray icon's menu too. (The old compact mode is gone since 0.9.6 — the in-game overlay does that job.)
3. Rate copies made in the Rate tab are written next to the original map in your `Songs` folder (a new difficulty plus its sped-up audio), the way rate changers usually work; press F5 in song select to see them (on osu! lazer they come as an .osz instead, see above). Everything else the app makes (marathons, generated maps, downloads, collections) goes to `Documents\Lunacy mania`, and finished `.osz` files are opened in osu! so the game imports them.

## In-game overlay

Small windows of their own over the game (nothing is injected; osu! in windowed or borderless mode), click-through while you play, for osu! stable, lazer and Interlude: **Judgements** (counts, MAX:300, accuracy, UR), **KPS** (now, max, a 10 s graph), **Map NPS** (the map's density at the play position, its peak, the whole map with a playhead), **Key lines** (presses per lane), **Dan** and, if you turn it on, **Map info** (a panel like streamers have, for the map selected or being played: its background, title, artist, difficulty, mapper, mods, rate, BPM, length, stars, dan and a progress bar, each field optional; song select too). You choose whether they show during a play, in a pause and on the results screen (all on by default), in five styles (Minimal, Card, Neon, osu! classic, Compact), each with its own background and text opacity, size, position, font, digit weight, corner radius and colours (per judgement, the graphs', per key-line column), which judgements show, the graphs' length and smoothing and the key lines' speed and thickness; Ctrl+Shift+O (or the tray, or the Settings page) moves them, snapping to the screen's edges and an optional grid. The overlay can speak English or Russian on its own, whatever the app's language. Turn them on in the tray's «Overlay» menu, the overlay block of the **Settings** page (⚙ under the card), or the overlay settings window.

![The Map info widget in three of its five styles](docs/images/overlay-map-en.png)

**KPS and key lines in osu! stable** come from your keyboard: osu! stable tells tosu no key presses in mania, so the app's small helper (`key-reader.exe`) hears your lane keys through Windows' Raw Input — a listener, not a hook: no input delay, nothing injected, osu! untouched. It hears **only the lane keys of the map being played, only during the play**, and saves nothing. The keys come from osu!'s own settings (`osu!.<you>.cfg`, the selected layout of the map's key count); in the overlay settings window you can see them, set them by hand per lane, or turn «Read keys from the keyboard» off — the lines are then rebuilt from the judgements and the map's notes as before. lazer and Interlude report their presses themselves.

**Dan** shows the map's overall dan at the play's rate — the card's own estimate, label and number (e.g. «13.0 Gamma mid», past Kappa high «above Kappa») — and out of the box nothing else. Optional lines, off until turned on in the overlay settings: the main pattern and how sure, "+0.8 vs your level" against the profile chosen in Picks (mania-tracker, hand-set or My profile), and on the results screen "this play: …", your play's dan by the local profile's model (while recording plays is on). The window is as tall as the lines it shows. The dan of each part of the map is in the Analysis tab ("Dan by part"), not in the overlay. The map is analysed once per map and rate (the card's result when it showed the map; tosu's map file or Interlude's library chart otherwise), never during the play; until then it says "working out…", and not-4K, LN and non-mania maps say so.

## Profile

The **Profile** tab holds both profiles. **mania-tracker**: your tracker player (dan, the four tiles, MinaCalc ratings, history chart, recent plays, a link to the site). **My profile** is learnt from your own plays, offline: plays that reach the results screen in osu! stable or lazer are recorded (through tosu), and your history can be imported once from osu! stable's `scores.db` (matched to your `Songs` folder) and from Interlude. Each play gets a performance dan (the map's dan at its rate, adjusted for accuracy, full at 96.5%), attributed to Speed / Jack / Stamina / Tech and the seven patterns by the map's pattern shares; each is the weighted mean of your best 20 maps, with a ± range and a confidence, and the overall dan is the mean of the four axes. Plays on maps that are vibro at the rate played (long, fast jacks hammered rather than jacked; the card marks such a map «Vibro», its dan stays its own) are kept and listed but don't move your dans, and neither do plays on maps below OD 7 or with EZ (marked «<OD7»); the page says how many were left out. Choose it as the source in Picks and it drives picks, the plan, the auto-marathon and "for you". It's stored in the app's user data folder; export, import and reset are on the page. osu! lazer's past plays are imported from a copy of its own database ("Import from osu! lazer"; lazer itself is only read). How it works: [docs/local-profile.md](docs/local-profile.md).

## Skin

The **Skin** tab edits the osu!mania 4K part of a skin — the `[Mania]` section with `Keys: 4` of `skin.ini` — and makes new 4K skins. Skins from osu!'s `Skins` folder are copied into a working copy first (the folder is only read); `.osk` / `.zip` files are unpacked the same way. Everything else in `skin.ini` (other sections, other key counts, comments, spacing, encoding, line endings) is kept exactly. Supported keys: ColumnStart, ColumnRight, ColumnWidth, ColumnSpacing, ColumnLineWidth, HitPosition, LightPosition, ScorePosition, ComboPosition, BarlineHeight, WidthForNoteHeightScale, LightingNWidth, LightingLWidth, UpsideDown, KeysUnderNotes, JudgementLine, NoteBodyStyle (and NoteBodyStyle# in the preview), SpecialStyle, ComboBurstStyle, KeyFlipWhenUpsideDown, NoteFlipWhenUpsideDown, SeparateScore, LightFramePerSecond, Colour1–4, ColourLight1–4, ColourColumnLine, ColourBarline, ColourJudgementLine, ColourKeyWarning, ColourHold, ColourBreak, KeyImage#, KeyImage#D, NoteImage#, NoteImage#H, NoteImage#L, NoteImage#T, StageLeft, StageRight, StageBottom, StageHint, StageLight, LightingN, LightingL, WarningArrow, Hit0, Hit50, Hit100, Hit200, Hit300, Hit300g, and [General] Name and Author. Every picture (notes, LN parts, keys, stage, lighting, judgements) can be swapped for your own PNG, JPG or WebP: click its thumbnail or drop a file on it; it is saved as PNG at @1x and @2x, and "Reset" / "Apply to all columns" are next to it. Exports go to `Documents\Lunacy mania\скины`: an `.osk` (opened, so osu! imports it) or a folder copy.

**Interlude** gets its own `.isk` package, for skins made from scratch only (for an existing osu! skin use Interlude's own import and editor). Your own pictures go into it too (fitted into Interlude's square frames). What carries over from the builder: note, hold head/body/tail and receptor pictures per column (receptors drawn from the note shape, pressed and not), column colours, column width (×1080/480) and spacing, lane colour, column light, hit explosions, stage edges and a judgement line. What doesn't: key images (Interlude has receptors), the hit position and scroll direction (Interlude's own settings), judgement pictures (they belong to Interlude's HUD and ruleset), ScorePosition / ComboPosition / LightPosition and the per-key `[Mania]` values of other key counts. Drop the `.isk` on Interlude's window to install it.

## Generated maps and osu! rules

Maps from the Create map tab are made by a trained model, so they are **for practice and local play**. osu!'s [Ranking Criteria](https://osu.ppy.sh/wiki/en/Ranking_criteria) require hit objects, hitsounds and timing to come from direct human input, so AI-made maps can't be ranked or loved. Local plays have no leaderboard or pp, and neither do rate copies or marathons. If you upload a generated map anywhere, say it was made with AI. Rate copies and marathons of other people's maps are for yourself; uploading them needs the mappers' and artists' permission.

## Privacy

No account and no telemetry. The app only talks to: mania-tracker (your skill and played maps, when you load a profile), the beatmap mirrors osu.direct, Sayobot and BeatConnect (downloads), osu.ppy.sh (map pages and `.osu` files) and GitHub (update checks) — plus, only if you turn on «Download .NET's helper file if it's missing», Microsoft's symbol server once for the Interlude reader. Your settings stay on your PC.

## Building from source

Needs Windows, [Node.js](https://nodejs.org) 22 or newer and git.

```bash
git clone https://github.com/kibuk12311/lunacy-mania-instrument.git
cd lunacy-mania-instrument
npm ci
node tools/fetch-tosu.mjs
npm start
```

- `node tools/fetch-tosu.mjs` downloads the pinned tosu release into `vendor/tosu/` and checks its sha256.
- The trained map generator `models/mapper.json` (~37 MB) is not in git. Download `mapper.json` from a release into `models/`; without it the generator runs in its rule-based mode. `npm start` reads `models/`; the release build ships the generator's models as `resources\models\` beside `app.asar`, so an update that leaves them alone does not download them again, and `dan_model.json` stays inside `app.asar`.
- The generator picks the first model that loads and fits the request (`app/generatorJobs.js`): the neural `mapper-nn2-{l,m,s}.json` sizes (on "auto", L and M only with a GPU path; the distilled `mapper-nn2-s-distilled.json` before the plain S), then `mapper-xgb3.json`, `mapper-nn.json`, `mapper.json`. A model that needs the song's stems is skipped without them. `critic.json` is optional.
- For development, set `LUNACY_MODEL_DIR` to folders to read models from before `models/` (joined by `;`), for example `set LUNACY_MODEL_DIR=D:\models\candidates;D:\models\critic` before `npm start`. Nothing is copied; unset it to go back to the shipped models.
- With a WebGPU adapter, the neural models' encoder runs on the GPU in a hidden window (`app/gpuWorker*`, `src/gen/nn/webgpu/`); the decoder and the sampling stay on the CPU, and without a GPU, or when the GPU fails its parity probe, everything runs on the CPU. `npx electron tests/smoke/electron-webgpu.mjs` checks the GPU kernels against PyTorch and the JS path, `npx electron tests/smoke/electron-gpu-link.mjs` checks the worker-to-GPU link, and `npx electron tools/bench-gpu.mjs` times both paths (numbers in `docs/2026-10-26-webgpu-stream-w.md`).
- `npm test` runs the tests (Node's built-in test runner).
- `npm run build:keys` builds the keyboard reader (`native/key-reader`, C#, needs the .NET 8 SDK) into `native/key-reader/out/key-reader.exe` and runs its self-test (made-up Raw Input records, no keyboard); `npm start` runs it from there, the release build ships it as `resources\key-reader\` and refuses to pack without it. `npx electron tests/smoke/electron-overlay.mjs <out> --kbd` checks the overlay with a stand-in helper against a jittery fake tosu.
- `npm run build:reader` builds the Interlude reader (`native/interlude-reader`, C# with [ClrMD](https://github.com/microsoft/clrmd); needs the .NET 8 SDK) into `native/interlude-reader/out/reader/`: `interlude-reader.exe` and a bundled .NET DAC. `npm start` runs it from there, the release build ships it as `resources\interlude-reader\`. Build it before `npm run dist` (the build refuses to pack without it). Its own tests: `powershell -File native/interlude-reader/build.ps1` (with the fake Interlude) and `node native/interlude-reader/test.mjs`; `node tools/record-interlude-lines.mjs` records its lines into `tests/fixtures/` for the app's tests, and `npx electron tests/smoke/electron-interlude.mjs <out> --live` / `npx electron tests/smoke/electron-overlay.mjs <out> --interlude` run the app against the fake game.
- `npm run dist` builds the installer, the portable exe and `latest.yml` into `dist/`.


### Project layout

```
app/        Electron main process, IPC per tab, workers, renderer (app/renderer)
src/        the logic: core (analysis), rate, recommend, gen (map generator), audio, analysis, skin (skin.ini, builder, Interlude), i18n
vendor/     LeoBlack's ManiaMapAnalyser (dan estimators, pattern finder, MinaCalc, Sunny)
models/     dan model and the generator's learned mapper
tools/      data fetchers, dataset builders, training (Python) and evaluation scripts
tests/      unit tests, fixtures and Electron smoke scripts (tests/smoke)
docs/       design notes and plans
```

### Training the generator

The learned mapper is trained on community 4K charts (ranked and loved osu! maps, EtternaOnline packs, Malody converts, dan course packs). The pipeline is in `tools/`: `fetch-*.mjs` collect charts, `build-mapper-dataset.mjs` turns them into training rows, `train_mapper.py` trains the model (`pip install -r tools/requirements.txt`), and `eval-generator.mjs`, `eval-timing.mjs` and `eval-parts.mjs` measure it on held-out songs. The charts themselves are not part of this repository.

## Credits

- Dan estimators, pattern finder and Sunny star rating: [ManiaMapAnalyser](https://github.com/LeoBlackMT/osumania_map_analyser) by Leo_Black (MIT).
- MSD: MinaCalc from [Etterna](https://github.com/etternagame/etterna).
- Reading osu!: [tosu](https://github.com/tosuapp/tosu). Reading Interlude: [ClrMD](https://github.com/microsoft/clrmd) (MIT) and the .NET runtime's DAC (MIT).
- Interlude formats: read from [Prelude](https://github.com/YAVSRG/YAVSRG) by Percyqaz (MIT), re-implemented.
- Player skill and map dans: [mania-tracker](https://mania-tracker.com).
- Audio: [FFmpeg](https://ffmpeg.org).

Full list and licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Sneezey. Bundled third-party programs keep their own licenses.

Author: Sneezey · Discord: sneezey123
