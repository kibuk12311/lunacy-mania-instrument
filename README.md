# Lunacy mania instrument

**English** · [Русский](README.ru.md)

**Lunacy mania** is a small always-on-top window for **osu!mania 4K rice** players. It shows the dan of the map you have selected in osu!, changes rates, builds marathons and dan courses, picks maps for your skill and can map a song for you.

[![Latest release](https://img.shields.io/github/v/release/kibuk12311/lunacy-mania-instrument?label=download)](https://github.com/kibuk12311/lunacy-mania-instrument/releases/latest)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-informational)
![License](https://img.shields.io/badge/license-MIT-green)

![The app's tabs](docs/images/tabs-en.png)

## What it does

| Tab | What you get |
|---|---|
| **Analysis** | The dan of the selected map (Alpha…Omega and the numbered dans below), how sure it is, the main patterns, MSD and Sunny ★. Pick the calculator: our combined one, Mixed, Daniel, Azusa, Roxy, Companella, or all of them side by side. A difficulty line along the map, patterns by part, "for you" (how the map compares with your skill) and a dan-by-rate ladder. DT and HT are taken into account. |
| **Rate** | Makes rate versions of a map next to the original (audio included, pitch kept or not). Finds the rate that puts a map at a target dan, does several rates at once, mirrors a chart or strips its LNs, and remembers presets. |
| **Marathon** | Joins maps into one marathon or dan course `.osz`, with breaks you choose. Course templates, an automatic marathon built from your skill profile, and a difficulty curve of the whole course. |
| **Picks** | Maps worth playing for your skill, by pattern and goal (comfort, growth, challenge) or your own dan range. Your skill comes from [mania-tracker](https://mania-tracker.com). One-click download, a training plan, similar maps, favourites exported as an osu! collection, and progress over time. |
| **Create map** | Maps a song for you: detects BPM and offset (also songs with several BPMs, 1/3 and 1/6 snaps), finds the song's parts and lets you give each part its own dan and patterns. Several variants, a preview player with a playfield, locking a part and regenerating the rest, a whole mapset or a dan ladder in one click, rate versions, metadata and background. It can also remap an existing map one dan up or down. |

The interface is in Russian and English (the RU/EN button under the card, or the tray menu).

## Download

Get it from the [latest release](https://github.com/kibuk12311/lunacy-mania-instrument/releases/latest):

- **`Lunacy-mania-Setup-<version>.exe`** — the installer. Installs for your Windows user only (no admin), adds Start menu and desktop shortcuts, and **updates itself**: when a new version is out it downloads it in the background and asks to restart.
- **`Lunacy-mania-<version>.exe`** — portable, nothing to install. It tells you when a new version is out and opens the download page.

The app isn't code-signed, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.

**Needs:** Windows 10 or 11 (64-bit) and **osu! stable**. The app reads the selected map through [tosu](https://github.com/tosuapp/tosu), which comes bundled and starts by itself. Picks, downloads and update checks need the internet; everything else works offline.

## How to use

1. Start osu! and the app, go to song select. The card shows the selected map's dan.
2. 📌 keeps the window on top, ▭ is the compact mode. Both are also in the tray icon's menu, next to the language and "Check for updates".
3. Rate copies made in the Rate tab are written next to the original map in your `Songs` folder (a new difficulty plus its sped-up audio), the way rate changers usually work; press F5 in song select to see them. Everything else the app makes (marathons, generated maps, downloads, collections) goes to `Documents\Lunacy mania` (if you have the folder of an older version, `Sneezey's dan calculator` or `Анализатор данов`, the app keeps using it), and finished `.osz` files are opened in osu! so the game imports them.

More detail for friends: [docs/for-friends.md](docs/for-friends.md).

## Generated maps and osu! rules

Maps from the Create map tab are made by a trained model, so they are **for practice and local play**. osu!'s [Ranking Criteria](https://osu.ppy.sh/wiki/en/Ranking_criteria) require hit objects, hitsounds and timing to come from direct human input, so AI-made maps can't be ranked or loved. Local plays have no leaderboard or pp, and neither do rate copies or marathons. If you upload a generated map anywhere, say it was made with AI. Rate copies and marathons of other people's maps are for yourself; uploading them needs the mappers' and artists' permission.

## Privacy

No account and no telemetry. The app only talks to: mania-tracker (your skill and played maps, when you load a profile), the beatmap mirrors osu.direct, Sayobot and BeatConnect (downloads), osu.ppy.sh (map pages and `.osu` files) and GitHub (update checks). Your settings stay on your PC.

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
- The trained map generator `models/mapper.json` (~37 MB) is not in git. Download `mapper.json` from a release into `models/`; without it the generator runs in its rule-based mode.
- The generator picks the first model that loads and fits the request (`app/generatorJobs.js`): the neural `mapper-nn2-{l,m,s}.json` sizes (on "auto", L and M only with a GPU path; the distilled `mapper-nn2-s-distilled.json` before the plain S), then `mapper-xgb3.json`, `mapper-nn.json`, `mapper.json`. A model that needs the song's stems is skipped without them. `critic.json` is optional.
- For development, set `LUNACY_MODEL_DIR` to folders to read models from before `models/` (joined by `;`), for example `set LUNACY_MODEL_DIR=A:\SneezeyTrain\candidates;A:\SneezeyTrain\critic` before `npm start`. Nothing is copied; unset it to go back to the shipped models.
- With a WebGPU adapter, the neural models' encoder runs on the GPU in a hidden window (`app/gpuWorker*`, `src/gen/nn/webgpu/`); the decoder and the sampling stay on the CPU, and without a GPU, or when the GPU fails its parity probe, everything runs on the CPU. `npx electron tests/smoke/electron-webgpu.mjs` checks the GPU kernels against PyTorch and the JS path, `npx electron tests/smoke/electron-gpu-link.mjs` checks the worker-to-GPU link, and `npx electron tools/bench-gpu.mjs` times both paths (numbers in `docs/2026-10-26-webgpu-stream-w.md`).
- `npm test` runs the tests (Node's built-in test runner).
- `npm run dist` builds the installer, the portable exe and `latest.yml` into `dist/`.

### Project layout

```
app/        Electron main process, IPC per tab, workers, renderer (app/renderer)
src/        the logic: core (analysis), rate, recommend, gen (map generator), audio, analysis, i18n
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
- Reading osu!: [tosu](https://github.com/tosuapp/tosu).
- Player skill and map dans: [mania-tracker](https://mania-tracker.com).
- Audio: [FFmpeg](https://ffmpeg.org).

Full list and licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Sneezey. Bundled third-party programs keep their own licenses.
