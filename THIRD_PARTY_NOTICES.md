# Third-party notices

Lunacy mania (Lunacy mania instrument) is MIT-licensed (see `LICENSE`). It builds on the work below; thank you to everyone who made it.

## In this repository

| Component | Where | License |
|---|---|---|
| [ManiaMapAnalyser](https://github.com/LeoBlackMT/osumania_map_analyser) by Leo_Black — the dan estimators (Mixed, Daniel, Azusa, Roxy, Companella), the pattern finder, Sunny star rating and the MinaCalc builds | `vendor/leoblack/` (pinned commit in `vendor/leoblack/VERSION`) | MIT, `vendor/leoblack/LICENSE` |
| MinaCalc from [Etterna](https://github.com/etternagame/etterna), compiled to WebAssembly (MSD) | inside `vendor/leoblack/js/ett/` | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (runs the Companella model) | inside `vendor/leoblack/js/estimator/companella/ort/` | MIT |
| Interlude's file formats — the chart blob and its id, the osu! conversion, collections.json — re-implemented in our own code from reading [Prelude](https://github.com/YAVSRG/YAVSRG/tree/main/prelude) by Percyqaz and its [Percyqaz.Data](https://github.com/percyqaz/Percyqaz.Data) JSON codecs (no code copied; Interlude's client itself, GPLv3, was only read) | `src/interlude/`, `app/interludeLibrary.js` | Prelude and Percyqaz.Data: MIT |

## Bundled with the release builds

These are separate programs that the app starts; they are not linked into it. Each one's license text is shipped next to it in the build, except the Interlude reader's, which are at the end of this file (shipped with every build).

| Component | Version | License | Source |
|---|---|---|---|
| [tosu](https://github.com/tosuapp/tosu) — reads osu! stable's memory so the app knows the selected map | v4.26.3 (`resources/tosu/`) | LGPL-3.0 | https://github.com/tosuapp/tosu |
| [FFmpeg](https://ffmpeg.org), static Windows build from gyan.dev via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) — audio decoding and rate changes | 6.0 essentials (`resources/ffmpeg/`) | GPL-3.0 | https://github.com/FFmpeg/FFmpeg/commit/ea3d24bbe3 |
| [Electron](https://www.electronjs.org) and Chromium | 38.2.0 | MIT; Chromium's licenses are in `LICENSES.chromium.html` next to the exe | https://github.com/electron/electron |
| [electron-updater](https://github.com/electron-userland/electron-builder) | see `package.json` | MIT | https://github.com/electron-userland/electron-builder |
| [onnxruntime-common](https://github.com/microsoft/onnxruntime) | see `package.json` | MIT | https://github.com/microsoft/onnxruntime |
| `interlude-reader.exe` — our own read-only reader of the running Interlude (`native/interlude-reader/`, MIT like the app), a self-contained single-file .NET 8 program | `resources/interlude-reader/` | MIT | this repository |
| — inside it: [ClrMD](https://github.com/microsoft/clrmd) (Microsoft.Diagnostics.Runtime) — reads a .NET process's memory | 4.2.751201 | MIT | https://github.com/microsoft/clrmd |
| — inside it: the [.NET runtime](https://github.com/dotnet/runtime) and libraries the program is published with | 8.0 | MIT | https://github.com/dotnet/runtime |
| `mscordaccore.dll`, the .NET data access component (DAC), from Microsoft's official `Microsoft.NETCore.App.Runtime.win-x64` NuGet package — loaded by the reader to read Interlude's runtime | 9.0.22 (`resources/interlude-reader/dac/9.0.22/`) | MIT | https://github.com/dotnet/runtime |

## Online services the app talks to

No account or key is needed for any of them, and nothing is sent except the request itself.

- [mania-tracker](https://mania-tracker.com) — player skill, played maps and map dans for the Picks tab.
- [osu.direct](https://osu.direct), [Sayobot](https://osu.sayobot.cn) and [BeatConnect](https://beatconnect.io) — beatmap mirrors for the one-click download.
- [osu!](https://osu.ppy.sh) — map pages and `.osu` files.
- GitHub Releases of this repository — update checks.
- Only if the user turns on «Download .NET's helper file if it's missing» in the IL panel: Microsoft's public symbol server (msdl.microsoft.com), once, for the DAC matching the running Interlude.

## License texts for the Interlude reader

ClrMD and the .NET runtime (including `mscordaccore.dll`) are under the MIT license:

```
The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Data the map generator was trained on


The models in `models/` were trained on community-made osu!mania 4K charts: ranked and loved osu! maps (fetched through the mirrors above and the [project-riz/osu-beatmaps](https://huggingface.co/datasets/project-riz/osu-beatmaps) dataset), [EtternaOnline](https://etternaonline.com) packs, Malody 4K convert packs and public dan course packs. The charts belong to their mappers; they are used only to learn patterns and are not shipped with the app.
