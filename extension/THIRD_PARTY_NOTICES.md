# Third-party notices — Lunacy mania: dans for osu!

This extension is made by the Lunacy mania app (MIT, see `LICENSE`). It is not made by osu! or ppy Pty Ltd and is not
endorsed by them. It counts dans with the app's own analyzer, copied unchanged into `lib/`, which builds on the work
below. Thank you to everyone who made it.

| Component | Where in the extension | License |
|---|---|---|
| ManiaMapAnalyser by Leo_Black (github.com/LeoBlackMT/osumania_map_analyser) — the dan estimators (Mixed, Daniel, Azusa, Roxy, Companella), the pattern finder, Sunny star rating and the MinaCalc builds | `lib/vendor/leoblack/` (with a few speed-ups of the Lunacy mania app marked in the code; same results) | MIT, `lib/vendor/leoblack/LICENSE` |
| MinaCalc from Etterna (github.com/etternagame/etterna), compiled to WebAssembly (MSD) | inside `lib/vendor/leoblack/js/ett/` | MIT |
| ONNX Runtime Web (github.com/microsoft/onnxruntime), runs the Companella model | inside `lib/vendor/leoblack/js/estimator/companella/ort/` | MIT, Copyright (c) Microsoft Corporation |

## What the extension talks to

Only osu!'s own public addresses, and only for the map page you have open:

- `osu.ppy.sh/osu/<beatmap id>` — the `.osu` file of each 4K difficulty, to count its dan (no login).
- `b.ppy.sh/preview/<set id>.mp3` — the 10 s preview, when you press the demo button (no login).
- `osu.ppy.sh/beatmapsets/<set id>/download?noVideo=1` — only when you press «Full map» in the player. It uses your
  osu! login in this browser, like the site's own Download button, and counts toward osu!'s download limit. osu!
  may send the file from another of its own `*.ppy.sh` addresses.

No telemetry, no accounts, no other servers. Results and `.osu` files are kept in the extension's own storage in this
browser.

## MIT license texts

Lunacy mania: see `LICENSE`. ManiaMapAnalyser: see `lib/vendor/leoblack/LICENSE`.

MinaCalc (Etterna) is under the MIT license, as published with Etterna (github.com/etternagame/etterna, file
`LICENSE`); the same MIT terms as below apply.

ONNX Runtime Web:

```
MIT License

Copyright (c) Microsoft Corporation

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
