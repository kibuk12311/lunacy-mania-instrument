# Requests from stream mapgen-output (C)

## 1. `tests/createStubs.test.js` (owner: the lead, a P0 file): the export panel is no longer a stub

**Why.** The first test there checks that the P0 stub "draws nothing yet". Stream C has now built the panel, which
draws its fields into `#meta-group` and `#export-panel`. Its behaviour is covered by the new
`tests/exportPanel.test.js`, so this assertion now fails by design. The remap-panel test and the canvas test in the
same file still pass, because `initRemapPanel` still returns `{}`.

**Change.** Replace the first test with:

```js
test("the export panel answers the create tab's calls (its drawing is tested in tests/exportPanel.test.js)", () => {
    const { $ } = fakeDom({});
    const panel = initExportPanel({ root: $("export-panel"), metaRoot: $("meta-group"), player: null, getSelection: () => ({ song: null, diffs: [] }) });
    assert.equal(typeof panel.onSongLoaded, "function");
    assert.equal(typeof panel.onSelectionChanged, "function");
    panel.onSongLoaded({ path: "a.mp3" });
    panel.onSelectionChanged();
});
```

I checked this replacement against the current `exportPanel.js`. It passes.

## 2. `app/rateCreate.js` and `tests/rateCreate.test.js` (owner: tabs-rate, R): the `field` regex (mapgen-v3 §8 C3)

Plan §8 gives this fix to stream C. The tabs-v2 plan gives both files to R, and R is editing `rateCreate.js` right
now, so I have not touched them.

**Bug.** The pattern is built in a template literal, where `\s` is just `s`. The pattern therefore reads
`^Titles*:s*(.*)$`. A key written with a space before the colon (`Title : Song`, `Version :Hard`) then reads as `""`.
I confirmed this on the current file: `mapInfo("[Metadata]\nTitle : Spaced\nArtist:  A  \nVersion :Hard\n…")` gives
`title: ""` and `version: ""`.

**Change** (one line):

```js
// was: const field = (text, key) => new RegExp(`^${key}\s*:\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
```

**Test** for `tests/rateCreate.test.js`. It fails today and passes with the change (I checked the fixed pattern
separately):

```js
test("map info reads keys written with spaces around the colon", () => {
    const info = mapInfo("[Metadata]\nTitle : Spaced\nArtist:  A  \nVersion :Hard\nTitleUnicode:U\n[TimingPoints]\n0,500,4,1,0,100,1,0\n");
    assert.equal(info.title, "Spaced");
    assert.equal(info.artist, "A");
    assert.equal(info.version, "Hard");
});
```

## 3. For the record, no action needed

- **`probeTags`.** Plan §8 C3 puts it in `app/rateAudio.js`, which R owns. It lives in `app/mapsetExport.js` instead,
  with its own `execFile`, and it is tested in `tests/mapsetExport.test.js`. Because of that, `tests/rateAudio.test.js`
  and `tests/rateCreate.test.js` were not extended.
- **`createGuard` (A2, `src/gen/playability.js`).** It has not landed yet, so `src/gen/remap.js` keeps its own
  limits. No jack ever gets longer or faster than the original's longest, no new note lands in a hold, and a row grows
  only to the size that 90% of its 8 beats keep. It can switch to the guard once A2 merges, but this is not required.
- **`registerExportIpc(deps)`.** It takes everything from the frozen deps object that already exists: `generatedStore`,
  `paths.mapsDir`, `analysis` (or `worker`), `ffmpegPath`, `renderPng`, `tosu` and `generatorClient`, plus `log`. No
  change to `main.js` or `preload.cjs` is needed.
- **`tests/smoke/electron-generate.mjs` (P).** §11.2 asks for a 2-difficulty `export-set` at rate 1.2. When that is
  added, `registerExportIpc` also needs `worker` (for the rated dans) and `renderPng` (for a dan-course background)
  there, as `tests/smoke/electron-export.mjs` passes them. As called today, with one id and no rates, it works
  unchanged. Its `.wav` song now goes into the `.osz` as `audio.mp3` (plan §8 C4). Without an `ffmpegPath` dep,
  `exportIpc.js` falls back to the dev copy of `ffmpeg-static`, as `main.js` does when the app is not packaged.
