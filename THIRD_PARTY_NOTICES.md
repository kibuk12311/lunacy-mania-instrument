# Third-party notices

Lunacy mania (Lunacy mania instrument) is MIT-licensed (see `LICENSE`). It builds on the work below; thank you to everyone who made it.

## In this repository

| Component | Where | License |
|---|---|---|
| [ManiaMapAnalyser](https://github.com/LeoBlackMT/osumania_map_analyser) by Leo_Black — the dan estimators (Mixed, Daniel, Azusa, Roxy, Companella), the pattern finder, Sunny star rating and the MinaCalc builds | `vendor/leoblack/` (pinned commit in `vendor/leoblack/VERSION`) | MIT, `vendor/leoblack/LICENSE` |
| MinaCalc from [Etterna](https://github.com/etternagame/etterna), compiled to WebAssembly (MSD) | inside `vendor/leoblack/js/ett/` | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (runs the Companella model) | inside `vendor/leoblack/js/estimator/companella/ort/` | MIT |

## Bundled with the release builds

These are separate programs that the app starts; they are not linked into it. Each one's license text is shipped next to it in the build.

| Component | Version | License | Source |
|---|---|---|---|
| [tosu](https://github.com/tosuapp/tosu) — reads osu! stable's memory so the app knows the selected map | v4.26.3 (`resources/tosu/`) | LGPL-3.0 | https://github.com/tosuapp/tosu |
| [FFmpeg](https://ffmpeg.org), static Windows build from gyan.dev via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) — audio decoding and rate changes | 6.0 essentials (`resources/ffmpeg/`) | GPL-3.0 | https://github.com/FFmpeg/FFmpeg/commit/ea3d24bbe3 |
| [Electron](https://www.electronjs.org) and Chromium | 38.2.0 | MIT; Chromium's licenses are in `LICENSES.chromium.html` next to the exe | https://github.com/electron/electron |
| [electron-updater](https://github.com/electron-userland/electron-builder) | see `package.json` | MIT | https://github.com/electron-userland/electron-builder |
| [onnxruntime-common](https://github.com/microsoft/onnxruntime) | see `package.json` | MIT | https://github.com/microsoft/onnxruntime |

## Online services the app talks to

No account or key is needed for any of them, and nothing is sent except the request itself.

- [mania-tracker](https://mania-tracker.com) — player skill, played maps and map dans for the Picks tab.
- [osu.direct](https://osu.direct), [Sayobot](https://osu.sayobot.cn) and [BeatConnect](https://beatconnect.io) — beatmap mirrors for the one-click download.
- [osu!](https://osu.ppy.sh) — map pages and `.osu` files.
- GitHub Releases of this repository — update checks.

## Data the map generator was trained on

The models in `models/` were trained on community-made osu!mania 4K charts: ranked and loved osu! maps (fetched through the mirrors above and the [project-riz/osu-beatmaps](https://huggingface.co/datasets/project-riz/osu-beatmaps) dataset), [EtternaOnline](https://etternaonline.com) packs, Malody 4K convert packs and public dan course packs. The charts belong to their mappers; they are used only to learn patterns and are not shipped with the app.
