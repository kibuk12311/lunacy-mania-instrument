# Lunacy mania: dans for osu! — browser extension design

Status: architecture, 2026-10-27. Branch `feature/osu-extension` (from `feature/v3`, app 0.10.3, analyzer vendor commit
`b700ebc0`). This file is the contract between the three lanes below; a lane changes only its own files and builds
against the interfaces here. Nothing is committed by the lanes.

Name: **"Lunacy mania: dans for osu!"** / **«Lunacy mania: даны для osu!»**. Never the osu! logo, never "official".

## 1. What it does

1. On `https://osu.ppy.sh/beatmapsets/<setId>` (first load, Turbo navigation, `#mania/<beatmapId>` switch) it shows,
   for every osu!mania 4K difficulty of the set (not converts, not other key counts or modes), Lunacy mania's dan:
   label ("Delta mid"), number (14.0), main pattern, confidence — computed by the app's own analyzer
   (`src/core/analyze.js` + `models/dan_model.json`, unchanged) from the public `.osu`
   (`GET https://osu.ppy.sh/osu/<beatmapId>`). For the selected difficulty also the dan on rates 0.8×–1.5× (step 0.05,
   like the app's «Дан на рейтах»). Results are cached.
2. «Сыграть демо» opens an in-page 4K player (D F J K, rebindable; holds; down/upscroll; scroll speed; rate 0.8–1.5;
   osu!mania judgements by OD; accuracy and combo; offset nudge; Esc closes). Audio: (a) the 10 s preview
   `https://b.ppy.sh/preview/<setId>.mp3` with the notes of that stretch, no login; (b) the full map from
   `https://osu.ppy.sh/beatmapsets/<setId>/download?noVideo=1` with the user's own osu! session (like the site's Download
   button; counts toward osu!'s download limits — the UI says so); (c) fallback: drop or pick an `.osz`.

## 2. Verified facts (investigation, 2026-10-27)

Saved in the workflow scratch folder `<scratch>/osu-ext/design/` (page.html, show.js, commons.js, 4961226.osu,
preview.mp3, headers; probes in `probe/`, `probe-ext/`, `probe-cookie/`). `<scratch>` is the session scratchpad the
workflow names; no local path belongs in any file of the extension.

### osu! site
- `GET /beatmapsets/2316993` → 200 `text/html`, **no Content-Security-Policy header** on the page. (curl with a
  Chrome User-Agent got a Cloudflare 403 `Cf-Mitigated: challenge`; a real browser normally passes — headless may not.)
- Cookie: `osu_session=…; Max-Age=2592000; path=/; domain=.ppy.sh; secure; httponly; samesite=lax`.
- Page data in `<script type="application/json">` tags: `json-current-user` (`{}` when logged out, an object with `id`
  when logged in), `json-route-section` (`{"action":"show","controller":"beatmapsets_controller","namespace":"main","section":"beatmaps"}`),
  `json-beatmapset`, `json-comments`, `json-config`, `json-genres`, `json-languages`,
  `json-recommended-star-difficulty-all`. osu-web reads `json-beatmapset` with `parseJson(id)` **without removing it**
  and saves its React state into the mount's `data-state` on `turbo:before-cache`.
- `json-beatmapset`: `id, artist, title, creator, preview_url ("https://b.ppy.sh/preview/<id>.mp3"), status, video,
  availability {download_disabled, more_information}, beatmaps[], converts[]`. Each beatmap: `id, beatmapset_id,
  mode ("mania"), mode_int (3), cs (4 = keys), accuracy (OD), version, difficulty_rating, total_length, hit_length,
  convert (false), count_circles, count_sliders, checksum, status, url ("https://osu.ppy.sh/beatmaps/<id>")…`.
  **`checksum` = MD5 of the `.osu` bytes** (verified: 4961226 → `18e40e4ddcbd746c9577e25e73f04d4a`).
- `<html lang="en">` is the site language (osu! locale); `<div class="js-react u-contents" data-react="beatmapset-page">`
  is the React mount; navigation is Hotwired **Turbo** (`turbo:load`, `turbo:before-cache` on `document`;
  `<meta name="turbo-cache-control" content="no-preview">`).
- DOM (from the page bundle `/assets/js/beatmapsets-show.*.js`, React-rendered, not in the HTML):
  `.osu-page.osu-page--generic-compact` > [`.beatmapset-header`, `.beatmapset-info`, `.user-profile-pages`].
  `.beatmapset-header` > `.beatmapset-header__box--main` > `.beatmapset-header__beatmap-picker-box` >
  `.beatmapset-beatmap-picker` > `a.beatmapset-beatmap-picker__beatmap` (+ `--active`), `href` =
  `https://osu.ppy.sh/beatmapsets/<set>#<mode>/<id>`; hover sets osu-web's hovered beatmap and
  `.beatmapset-header__diff-name` shows the hovered/current version; `.beatmapset-header__buttons` holds Download;
  `.beatmapset-stats` is the right column.
- Selecting a difficulty: `history.replaceState(history.state, "", url + "#mania/<id>")` — **no hashchange or popstate
  event** (content scripts cannot see replaceState) → poll `location.hash` + observe the picker's `--active` class.
- `GET /osu/4961226` → 200 `text/plain;charset=UTF-8`, `Content-Disposition: attachment`, **no
  Access-Control-Allow-Origin** (even with `Origin`).
- `GET https://b.ppy.sh/preview/2316993.mp3` → 200 **`audio/ogg` (Ogg Vorbis, "OggS")** despite `.mp3`, 98 278 B,
  `Cache-Control: public, max-age=604800`, no ACAO. Starts at PreviewTime, ~10.1 s.
- `GET /beatmapsets/2316993/download` **without login → 302 `Location: https://osu.ppy.sh/beatmapsets/2316993`**
  (398 B HTML meta-refresh). Logged in it redirects to osu!'s file host (not observable here; expected `*.ppy.sh`).
  osu-web answers 429 when the hourly download allowance is used up.
- Set 2316993 is a dan pack: 16 4K diffs with **different AudioFilename/PreviewTime** (4961226: `Tb.mp3`, 13805),
  one diff with 2 notes. The set preview fits at most one diff of such a set.

### Analyzer in a browser
- Import graph of `src/core/analyze.js`: 83 files, 993 KB (src/core 8, vendor/leoblack 58, src/i18n 17). The only
  static Node import is `import { readFile } from "node:fs/promises";` in `src/core/model.js`. All other `node:` uses
  are dynamic and behind `IS_NODE` (companella `node:url`, ett/calc `node:fs/promises`, MinaCalc 74/75 `node:module`).
- Run-time data: `models/dan_model.json` (4 KB), 6 MinaCalc wasm (1.4 MB, fetched via `locateFile`),
  `estimator/companella/dan_model.onnx` (304 KB), ONNX Runtime browser entry `ort/ort.wasm.min.mjs` (50 KB, computed
  import — **not** in `analyzerVersion.DATA_FILES`), `ort/ort-wasm-simd-threaded.mjs` + `.wasm` (12.4 MB). ~15 MB total.
- **Probe**: the graph served as plain ES modules to a module Worker in headless Edge 156 under
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`, with only the model.js import line swapped for a fetch shim:
  4961226 → 1.0×: Gamma low 12.6, high, Jumpstream, calcs mixed 12.6 / daniel 12.8 / azusa 12.5 / roxy 12.6 /
  companella 12.2, sunny 7.11; 1.2×: Epsilon low 14.7 — **identical to Node**. 544 ms first call (wasm init), 116 ms next.
- Licenses: app MIT; vendor/leoblack MIT (copyright Leo_Black, notice must ship); MinaCalc (Etterna) MIT; ONNX Runtime
  Web MIT → shipping inside an extension is fine with the notices.

### Extension platform (probes in headless Chrome 156 / Edge 156)
- Branded Chrome ≥137 ignores `--load-extension`. **Works**: launch with `--remote-debugging-pipe
  --enable-unsafe-extension-debugging`, then CDP `Extensions.loadUnpacked {path}` → `{id}` (Chrome 156 and Edge 156,
  `--headless=new`, temp `--user-data-dir`).
- With `--host-resolver-rules` mapping `osu.ppy.sh`, `b.ppy.sh`, `bm1.ppy.sh` to a local HTTPS fixture and
  `--ignore-certificate-errors`:
  - **service worker `fetch(…, {credentials:"include"})` sends the SameSite=Lax `.ppy.sh` cookie, follows the 302 to
    another `*.ppy.sh` host (cookie sent there too) and reads the body**; without the cookie it lands on the set's HTML
    page (= the logged-out answer).
  - offscreen document (reason `WORKERS`) → module `Worker` → dynamic `import()` inside the worker: works.
  - content script `import(chrome.runtime.getURL("x.js"))` of a web-accessible module works; the module keeps
    `chrome.runtime`.
  - content-script `fetch("/beatmapsets/1/download")` **fails** ("Failed to fetch") after the cross-origin redirect.
  - an extension iframe (web-accessible `frame.html`) in the page can fetch `b.ppy.sh` directly and has
    `chrome.permissions`; `chrome.storage` needs the `storage` permission.
- Firefox is not installed on this machine; openssl 3.5 is (Git for Windows). Electron 38 is in node_modules but its
  extension support has no `chrome.offscreen` → not used for smoke tests.

## 3. Architecture

```
osu.ppy.sh tab                                   extension origin (chrome-extension:// / moz-extension://)
┌──────────────────────────────┐   sendMessage   ┌─────────────────────────────────────────────┐
│ content/loader.js (classic)  │ ──lm:analyze──▶ │ background (Chrome: module service worker,   │
│  └ import() content/main.js  │ ──lm:osu──────▶ │   Firefox: module event page)                │
│    panel in a shadow root    │ ◀── responses ─ │  router · fetchers · cache (IndexedDB)       │
│    after .beatmapset-header  │                 │  analysisHost ─┬─ Chrome: offscreen doc ──┐  │
│                              │                 │                └─ Firefox: Worker direct  │  │
│ iframe player/player.html ◀──┼── URL params    │  analysis/worker.js (module Worker) ◀─────┘  │
│  (extension page, overlay)   │── port lm:fetch▶│    lib/src/core/analyze.js (copied graph)    │
│  postMessage close ─────────▶│                 │  network: osu.ppy.sh, b.ppy.sh, (*.ppy.sh    │
└──────────────────────────────┘                 │   only as osu!'s own download redirect)      │
                                                 └─────────────────────────────────────────────┘
```

Decisions:
- **All network in the background** (SW / Firefox event page): the only context that both carries the user's osu!
  cookie on `/download` (verified) and can read cross-origin bodies (host permissions). Content script and player never
  fetch remote URLs; they call `shared/client.js`.
- **Analysis in a module Worker**: MV3 service workers forbid `import()`, and the analyzer needs it (ett/calc, ORT).
  Chrome/Edge: one offscreen document (reason `WORKERS`) owns the Worker. Firefox: the background page creates the
  Worker itself. Both run the same `analysis/worker.js`.
- **Analyzer copied by the build, not changed**: `tools/build-extension.mjs` copies the import graph of
  `src/core/analyze.js` and `src/core/labels.js` (via `importGraph` from `src/core/analyzerVersion.js`) and the data
  files into `build/<target>/lib/` keeping relative paths, and rewrites exactly one line of the *copy* of
  `src/core/model.js`: `import { readFile } from "node:fs/promises";` →
  `import { readFile } from "../../../analysis/readFileShim.js";`. The build fails if that line is not there exactly
  once or if any other static `node:`/bare import remains. No bundler (none in node_modules; not needed).
- **Same answers as the app**: the cache key includes the app's analyzer fingerprint (`analyzerFingerprint()` from
  `src/core/analyzerVersion.js`, computed at build time into `lib/analyzerVersion.generated.js`); a core test runs the
  built copy in Node and deep-equals `analyzeChart` of the original on fixture charts.
- **Player = extension page in an iframe** overlaying the osu! page: own document (no osu-web styles, keys or React),
  own CSP, gets keyboard focus, AudioContext unlocked by a click/Space inside it (ready screen). Data comes through
  `shared/client.js`: `.osu` by message; preview and `.osz` bytes through a port in base64 chunks (Chrome extension
  messaging is JSON-only). Unzip and audio decode happen in the player.
- **Content script** is a classic `content/loader.js` that `import()`s `content/main.js` (web-accessible modules), so
  the page lane writes plain ES modules testable with `node:test`.
- **Storage**: IndexedDB in the background (`.osu` texts and results), `chrome.storage.local` for small settings. No
  page-origin storage, no `localStorage`.
- **Language**: page and player follow `<html lang>` of osu! (ru/uk/be/kk → ru, else en), falling back to
  `navigator.language`. The dan's own words (below dan 1, above Kappa, confidence) come from the analyzer's messages
  (`lib/src/i18n`) — the background rewords a cached result for the requested language.

### Manifests (core)

Common to `extension/manifest.chrome.json` and `extension/manifest.firefox.json`:

```json
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "description": "__MSG_extDescription__",
  "default_locale": "en",
  "version": "0.1.0",
  "icons": { "16": "icons/icon.png", "32": "icons/icon.png", "48": "icons/icon.png", "128": "icons/icon.png" },
  "permissions": ["storage"],
  "host_permissions": ["https://osu.ppy.sh/*", "https://b.ppy.sh/*", "https://*.ppy.sh/*"],
  "content_scripts": [{ "matches": ["https://osu.ppy.sh/*"], "js": ["content/loader.js"], "run_at": "document_idle" }],
  "web_accessible_resources": [{ "resources": ["content/*", "shared/*", "player/*", "icons/*"],
                                 "matches": ["https://osu.ppy.sh/*"] }],
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
}
```
- Chrome adds `"background": {"service_worker": "background/sw.js", "type": "module"}`, `"offscreen"` in permissions,
  `"minimum_chrome_version": "116"` (offscreen `WORKERS`, `runtime.getContexts`).
- Firefox adds `"background": {"scripts": ["background/firefox.js"], "type": "module"}` and
  `"browser_specific_settings": {"gecko": {"id": "lunacy-mania-dans@lunacy-mania", "strict_min_version": "128.0",
  "data_collection_permissions": {"required": ["none"]}}}`; no offscreen permission, no `offscreen/` folder.
- `https://*.ppy.sh/*` is there only so osu!'s own download redirect (to its file host) can be read; our code requests
  only `osu.ppy.sh/osu/<id>`, `osu.ppy.sh/beatmapsets/<id>/download?noVideo=1` and `b.ppy.sh/preview/<id>.mp3`, and the
  background refuses a final response whose host is not `ppy.sh` or `*.ppy.sh` (error `host`).
- `_locales/{en,ru}/messages.json`: `extName` = "Lunacy mania: dans for osu!" / "Lunacy mania: даны для osu!";
  `extDescription` ≤ 132 chars, e.g. en "Lunacy mania dans for every osu!mania 4K map on osu! beatmap pages, dans on
  rates and a demo to play. Not made by osu!." (119), ru "Дан Lunacy mania для каждой 4K-карты osu!mania на страницах
  карт osu!, дан на рейтах и демо прямо там. Не от osu!." (114).
- Icon: `app/assets/icon.png` (the app's own 256 px icon: 4K lanes, gold/blue notes) copied to `icons/icon.png`.
- No `action`/popup, no options page in 0.1.0.

### Build output

`node tools/build-extension.mjs [--target chrome|firefox|all] [--out <dir>]` (default all, `extension/build`) →
`extension/build/chrome/` and `extension/build/firefox/`, each a complete unpacked extension:

```
manifest.json  LICENSE  THIRD_PARTY_NOTICES.md  icons/icon.png  _locales/…
background/ offscreen/ (chrome only) analysis/ shared/ content/ player/      ← copied from extension/
lib/src/core/*.js  lib/src/i18n/**  lib/vendor/leoblack/js/**  lib/vendor/leoblack/LICENSE  lib/models/dan_model.json
lib/analyzerVersion.generated.js   ← export const ANALYZER = { fingerprint, appVersion, vendor }
```
Also exported for tests: `export async function buildExtension({ root, out, targets }) → { targets: {name: dir}, files,
bytes, fingerprint }`; run as a script only when it is the entry module. `.gitignore` gets `extension/build/`;
`package.json` gets `"build:extension"` and `"smoke:extension"` scripts.

## 4. Lanes and file ownership

Every path below belongs to exactly one lane. Lanes may **read** anything (including `src/`, `app/`, `tests/fixtures/`,
`tests/helpers/`, `src/gen/osz.js` for making test zips) and must not write outside their list. Never edit
`src/core/*`, `src/analysis/*`, `src/gen/*`, `vendor/*`. Scratch files: `<scratch>/osu-ext/<lane>/` only.

### core
```
extension/manifest.chrome.json            extension/manifest.firefox.json
extension/_locales/en/messages.json       extension/_locales/ru/messages.json
extension/THIRD_PARTY_NOTICES.md
extension/background/sw.js                Chrome entry: registers listeners synchronously, imports router
extension/background/firefox.js           Firefox entry
extension/background/router.js            onMessage (lm:analyze, lm:osu, lm:info, lm:cache-clear) + onConnect (lm:fetch)
extension/background/fetchers.js          fetchOsu, streamPreview, streamOsz (+ error classification)
extension/background/cache.js             IndexedDB stores + memory LRU; injectable backend for tests
extension/background/analysisHost.js      queue (priority), 1 job at a time, 60 s timeout; offscreen or direct Worker
extension/background/relabel.js           cached result → words of a language (lib labels.js / i18n.js)
extension/offscreen/offscreen.html        extension/offscreen/offscreen.js
extension/analysis/worker.js              module Worker: setLang("en"), analyzeChart(text, rate)
extension/analysis/readFileShim.js        readFile(url) for the copied model.js (fetch; file: URLs under Node)
extension/shared/protocol.js  extension/shared/rates.js  extension/shared/lang.js     (frozen, §5.1 — write first)
extension/shared/client.js                page/player → background calls (§5.2)
extension/shared/transfer.js              base64 chunk encode/decode
extension/shared/osz.js                   zip reader (stored + deflate via DecompressionStream "deflate-raw")
extension/shared/osuMeta.js               readOsuMeta(text)
extension/shared/md5.js                   md5Hex(bytes)
tools/build-extension.mjs                 tools/smoke-extension.mjs
tests/extension/core/**                   tests/extension/fixtures/**  (fake osu-web site for the smoke test)
tests/extension/helpers/fakeChrome.js     (fake chrome.runtime/storage; other lanes may import it read-only)
.gitignore (one line)                     package.json (two script lines)
```

### page
```
extension/content/loader.js               classic content script: guard + import(chrome.runtime.getURL("content/main.js"))
extension/content/main.js                 start(): page detection, data flow, generation counter
extension/content/site.js                 everything that knows osu-web: selectors, json-beatmapset, selected id, login hint
extension/content/nav.js                  turbo:load / turbo:before-cache / hash poll / MutationObserver → callbacks
extension/content/panel.js                shadow-DOM panel: chips, selected card, rates list, play buttons
extension/content/strings.js              ru/en texts of the panel
extension/content/styles.js               CSS text for the shadow root
extension/content/playerFrame.js          overlay iframe open/close, postMessage, Esc, scroll lock
tests/extension/page/**
```

### player
```
extension/player/player.html  extension/player/player.css
extension/player/main.js                  boot(params): states, wiring
extension/player/chart.js                 .osu → playable 4K chart
extension/player/judge.js                 windows by OD, judgements, LN rules, accuracy, combo, UR
extension/player/clock.js                 audio clock ↔ chart time, latency, offset
extension/player/audio.js                 AudioContext, decode, play/stop/pause at a rate
extension/player/input.js                 event.code bindings, rebinding, pause on blur
extension/player/render.js                canvas 2D playfield
extension/player/settings.js              chrome.storage.local "lm.player.v1"
extension/player/source.js                preview / full .osz / dropped file → { chart, audioBytes }
extension/player/ui.js                    ready, loading, error, settings, results screens (DOM)
extension/player/strings.js               ru/en texts of the player
tests/extension/player/**
```

## 5. Interfaces

### 5.1 Frozen shared modules (core writes these verbatim first; page and player import them)

`extension/shared/protocol.js`
```js
// Message names, port names and error codes shared by every part of the extension (extension/DESIGN.md §5).
export const MSG = Object.freeze({ ANALYZE: "lm:analyze", OSU: "lm:osu", INFO: "lm:info", CACHE_CLEAR: "lm:cache-clear" });
export const PORT_FETCH = "lm:fetch";
export const OFFSCREEN_TARGET = "lm-offscreen";
export const PLAYER_SOURCE = "lunacy-mania-player";
export const SITE_ORIGIN = "https://osu.ppy.sh";
export const PRIORITY = Object.freeze({ HIGH: "high", NORMAL: "normal", LOW: "low" });
export const ERR = Object.freeze({
    NETWORK: "network", HTTP: "http", NOT_FOUND: "not-found", RATE_LIMITED: "rate-limited",
    LOGIN: "login", LIMIT: "limit", DISABLED: "disabled", NOT_ZIP: "not-zip", TOO_BIG: "too-big", HOST: "host",
    PERMISSION: "permission", ANALYSIS: "analysis", TIMEOUT: "timeout", BAD_REQUEST: "bad-request",
    CANCELLED: "cancelled", CONTEXT: "context",
});
```

`extension/shared/rates.js`
```js
// The rates the panel and the player offer: 0.8× … 1.5× in steps of 0.05 (the app's ladder goes 0.9–1.5).
export const RATES = Object.freeze(Array.from({ length: 15 }, (_, i) => (80 + i * 5) / 100));
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const rateKey = (rate) => Math.round(Number(rate) * 100) / 100;
// 1 → "1.0", 0.85 → "0.85", 1.5 → "1.5" (the UI adds "×")
export function formatRate(rate) {
    const r = rateKey(rate);
    return Number.isInteger(Math.round(r * 100) / 10) ? r.toFixed(1) : r.toFixed(2);
}
```

`extension/shared/lang.js`
```js
// Interface language of the extension: the osu! site's language (<html lang>), else the browser's; ru or en.
export const LANGS = Object.freeze(["ru", "en"]);
export const langForLocale = (locale) => (/^(ru|uk|be|kk)\b/i.test(String(locale ?? "")) ? "ru" : "en");
export function siteLang(doc = globalThis.document, nav = globalThis.navigator) {
    const marked = doc?.documentElement?.getAttribute?.("lang");
    return langForLocale(marked || nav?.language || "en");
}
// dict: { key: { ru, en } } (a value may be a function of params); t("k", { n: 3 }) fills {n}; unknown keys show themselves
export function makeT(dict, lang) {
    return (key, params = {}) => {
        const entry = dict[key];
        if (!entry) return key;
        const value = entry[lang] ?? entry.en;
        const text = typeof value === "function" ? value(params) : String(value);
        return text.replace(/\{(\w+)\}/g, (slot, name) => (name in params ? String(params[name]) : slot));
    };
}
// ru takes [one, few, many], en [one, other]
export function plural(n, { ru, en }, lang) {
    const c = Math.abs(Math.trunc(Number(n) || 0));
    if (lang === "en") return c === 1 ? en[0] : en[1];
    const m100 = c % 100, m10 = c % 10;
    if (m100 >= 11 && m100 <= 14) return ru[2];
    if (m10 === 1) return ru[0];
    return m10 >= 2 && m10 <= 4 ? ru[1] : ru[2];
}
```

### 5.2 `extension/shared/client.js` (core; used by page and player)

Every function resolves (never rejects on a failure the user can meet) with `{ ok: true, … }` or
`{ ok: false, error: { code, status?, message? } }`; `code` is one of `ERR`; `message` is an English diagnostic, the UI
words the code itself. "Extension context invalidated" (the extension was reloaded under an open tab) → `ERR.CONTEXT`.

```js
analyze({ beatmapId, checksum = null, rate = 1, lang = "en", priority = "normal" }) → Promise<AnalyzeResponse>
getOsu({ beatmapId, checksum = null })        → Promise<{ ok:true, beatmapId, text, md5, meta: OsuMeta } | Fail>
getPreview({ setId, onProgress, signal })     → Promise<{ ok:true, bytes: Uint8Array, contentType } | Fail>
getOsz({ setId, noVideo = true, onProgress, signal }) → Promise<{ ok:true, bytes: Uint8Array, contentType, fileName } | Fail>
info()                                        → Promise<{ ok:true, version, analyzer: { fingerprint, appVersion } }>
```
`onProgress({ received, total })` (`total` null when unknown); `signal` an AbortSignal (→ `ERR.CANCELLED`).

`AnalyzeResponse`:
```
{ ok: true, beatmapId, rate, cached: boolean, meta: OsuMeta, result: DanResult, analyzer: { fingerprint, appVersion } }
{ ok: false, beatmapId, rate, error: { code, status?, message? } }
```
`DanResult` = `analyzeChart(text, rate)` of `src/core/analyze.js`, exactly, with `label`, `confidence` and error
`message` worded in `lang`:
- `{ kind: "ok", label, numeric, halfWidth, confidence, confidenceLevel: "high"|"medium"|"low", primary, top3: [{name, share}],
  tech, calcs: { mixed, daniel, azusa, roxy, companella }, sunny, msd: { overall, stream, … } | null, bpm, durationSec, rate }`
- `{ kind: "not-rice", reason: "mode" | "ln" | "keys", keys }` (LN share > 15 % → "ln")
- `{ kind: "too-short" }` (fewer than 80 notes)
- `{ kind: "error", message }`

`OsuMeta` (`readOsuMeta(text)` in `shared/osuMeta.js`): `{ mode, keys, od, hp, previewTime, audioFilename, audioLeadIn,
title, artist, creator, version, beatmapId, beatmapSetId, noteCount, lnCount, firstNoteMs, lastNoteMs }` (numbers or
null; `keys` = round(CircleSize) for mode 3; `previewTime` −1 when unset).

### 5.3 Background protocol (core-internal, documented for tests)

Rule R1: every `runtime.onMessage` listener (background, offscreen, player) handles only messages whose `type` it owns
and **returns `undefined`** for the rest; it returns `true` only when it will call `sendResponse`. The offscreen
document also requires `target === OFFSCREEN_TARGET`. (Messages from content scripts reach every extension page.)

- `{ type: MSG.ANALYZE, beatmapId, checksum, rate, lang, priority }` → `AnalyzeResponse`. Validation: integer id > 0,
  `rate` in [0.5, 2] → `rateKey`, `lang` in LANGS (else "en"), priority in PRIORITY. Flow: `.osu` from cache (valid when
  `md5 === checksum`, or no checksum and fetched < 24 h ago) else `fetchOsu`; key
  `${fingerprint}|${md5}|${rate.toFixed(2)}`; result from cache else `analysisHost.analyze(text, rate, priority)`;
  concurrent equal keys share one promise; respond with `relabel(result, lang)`.
- `{ type: MSG.OSU, beatmapId, checksum }` → `{ ok, beatmapId, text, md5, meta }`.
- `{ type: MSG.INFO }` → `{ ok, version, analyzer }`. `{ type: MSG.CACHE_CLEAR }` → `{ ok: true }`.
- Port `PORT_FETCH`: client posts `{ type: "get", what: "preview", setId }` or
  `{ type: "get", what: "osz", setId, noVideo: true }`, may post `{ type: "cancel" }` or disconnect (→ abort).
  Background posts `{ type: "meta", contentType, total, fileName }`, then `{ type: "chunk", data: <base64 of ≤ 1 MiB> }`
  … and `{ type: "progress", received, total }` (at least every 5 s, also keeps the Chrome SW awake), then
  `{ type: "done", received }` or `{ type: "error", code, status?, message? }`.
- SW ↔ offscreen: `sendMessage({ target: OFFSCREEN_TARGET, type: "lm:job", jobId, text, rate })` →
  `{ ok: true, result } | { ok: false, code: "analysis"|"timeout", message }`. Offscreen ↔ Worker: `postMessage`.
- `fetchOsu(id)`: `GET https://osu.ppy.sh/osu/<id>`, `credentials: "omit"`; ≤ 2 in flight; 404 → not-found; 429 →
  wait `Retry-After` (≤ 10 s) and retry once, then rate-limited; body bytes → `md5Hex` → `TextDecoder("utf-8")`. A
  request (headers and body) with no answer in 30 s is aborted and answers `network` («.osu: no answer in 30 s»), so the
  page words it as a connection problem; `timeout` stays the analysis' own (analysisHost's 60 s).
- `streamPreview(setId)`: `GET https://b.ppy.sh/preview/<setId>.mp3`, `credentials: "omit"`; 404 → not-found.
- `streamOsz(setId)`: `GET https://osu.ppy.sh/beatmapsets/<setId>/download?noVideo=1`, `credentials: "include"`,
  `redirect: "follow"`. Classification: TypeError → network; 401/403 → login; 404 → not-found; 410/451 → disabled;
  429 → limit; other non-2xx → http; 2xx with `text/html` or not starting `PK\x03\x04` → login when the final URL is
  the set page (`/beatmapsets/<id>`), else not-zip; final host not ppy.sh → host; > 300 MB → too-big.
  It is started only by the user's click in the player.
- Cache (IndexedDB `lunacy-mania`, v1): store `osu` {beatmapId → {md5, text, fetchedAt, usedAt}} capped at 64 MB of
  text (LRU by usedAt), store `results` {key → {result, savedAt, usedAt}} capped at 5000 entries; memory LRU in front.
  Results are stored worded in en; `relabel` rewrites `label` (`numericToLabel(numeric).text`), `confidence`
  (`confidenceWord(confidenceLevel)`) and `core.analyze.noCalculator` errors under `setLang(lang)` of the copied
  `lib/src/core/labels.js` / `lib/src/i18n/i18n.js` (both static imports, allowed in the SW).
- analysisHost: one Worker, jobs sorted high → normal → low, FIFO inside; 60 s per job → terminate and recreate the
  Worker, answer `timeout`. Chrome: `chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})` + one in-flight
  `createDocument({ url: "offscreen/offscreen.html", reasons: ["WORKERS"], justification: "Runs the dan analyzer (WebAssembly) in a worker" })`;
  the document stays open. Firefox: `new Worker(runtime.getURL("analysis/worker.js"), { type: "module" })`.

### 5.4 Page ↔ osu-web (page lane; all selectors live in `content/site.js`)
- Active only when `location.pathname` matches `^/beatmapsets/(\d+)/?$`. Run once at start and on every `turbo:load`;
  on `turbo:before-cache` remove the host and close the player (Turbo snapshots the DOM).
- Set data: `JSON.parse(#json-beatmapset.textContent)`; fallback: React mount `[data-react="beatmapset-page"]`
  `dataset.state` → `.beatmapset`; last resort: one same-origin `fetch(location.pathname)` of the page HTML (content
  scripts fetch same-origin with no CORS issue; no other fetch is allowed in the page lane).
- 4K diffs: `beatmaps.filter(b => b.mode === "mania" && !b.convert && Math.round(b.cs) === 4)`, ordered like the picker
  (`difficulty_rating` ascending, then id). No diffs → no panel at all.
- Selected id: `location.hash` `#mania/(\d+)`; else `.beatmapset-beatmap-picker__beatmap--active` `href`; else the first
  4K diff. Watch: 300 ms hash poll while on a set page, `click` on picker anchors, MutationObserver on the picker
  (attributes `class`), `popstate`/`hashchange`. Hover over a picker anchor may highlight the matching chip.
- Logged-in hint: `#json-current-user` parses to an object with `id` → true; `{}` → false; missing → null.
- Host: `<section data-lm-root>` with an **open** shadow root, inserted `afterend` of `.beatmapset-header`; fallbacks:
  `beforebegin` of `.beatmapset-info`, prepend to `.osu-page--generic-compact`, else `position: fixed` bottom-right.
  A MutationObserver re-inserts it if React drops it. Never write into React's own nodes; text via `textContent` only.
- Work: on page open request the selected diff first (`priority: "high"`), the others `"normal"`, ≤ 3 requests in
  flight; rates (`RATES`, the selected diff only, `"low"`) only while the rates block is open (state in
  `chrome.storage.local` `lm.page.v1` `{ ratesOpen }`, default closed). A generation counter drops answers for a page
  that is gone.
- Preview fit: from the `meta` of the answers — if the 4K diffs' `audioFilename` or `previewTime` differ, pass
  `previewWarn=1`; selected diff with `previewTime < 0` → preview button disabled with a reason.

### 5.5 Page ↔ player (iframe)
- `content/playerFrame.js` creates `<iframe data-lm-player allow="autoplay" src="<runtime.getURL('player/player.html')>#<params>">`
  `position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; z-index: 2147483646`, focuses it on load, sets
  `documentElement.style.overflow = "hidden"` (restored on close), closes on Esc in the page, on `turbo:before-cache`
  and on the player's close message. One player at a time.
- Params (`URLSearchParams` in the hash): `set` (setId), `map` (beatmapId), `src` = `preview` | `full` | `file`,
  `rate` (`formatRate`), `lang`, `checksum`, `login` = `1` | `0` | `` (unknown), `previewWarn` = `0` | `1`.
- Player → page: `parent.postMessage({ source: PLAYER_SOURCE, type: "close" }, SITE_ORIGIN)`. The page accepts it only
  when `event.source === iframe.contentWindow` and `event.origin` is the extension's origin
  (`new URL(chrome.runtime.getURL("")).origin`). No page → player messages.

### 5.6 Player behaviour contract (player lane)
- Data: `.osu` via `getOsu({ beatmapId: map, checksum })`; preview via `getPreview({ setId })`; full via
  `getOsz({ setId, noVideo: true })` only after the user presses «Скачать с osu!» (text: uses your osu! login in this
  browser and counts toward osu!'s download limit, like the site's Download button); file via drop or
  `<input type=file accept=".osz,.zip">`. From an `.osz`: the `.osu` whose `BeatmapID` = `map` (else whose MD5 =
  `checksum`, else the only 4K mania one, else a list to choose from) and the entry named by its `AudioFilename`
  (case-insensitive, `\` = `/`). Errors are shown by code; `login` says «Войди на osu.ppy.sh в этом браузере — или
  перетащи .osz сюда» and offers the file fallback; `limit` says osu!'s download limit is reached.
- Keys `event.code` (layout-independent): default `["KeyD","KeyF","KeyJ","KeyK"]`, rebinding by pressing four keys
  (Escape, Tab, Enter, Space not allowed); `repeat` ignored; bound keys `preventDefault`.
- Settings (`chrome.storage.local` `lm.player.v1`): `{ keys, downscroll: true, speed: 24 (10–40, visible span
  11485 / speed ms of real time, as app/renderer/playfield.js), rate: 1 (RATES), offsetMs: 0 (−300…300), volume: 0.6 }`.
  `-` / `=` nudge the offset by 5 ms (Shift: 1 ms) during play.
- States (also `document.documentElement.dataset.lmPlayer`): `loading` → `ready` (click/Space/Enter starts; this
  gesture unlocks the AudioContext) → `countdown` → `playing` ⇄ `paused` (blur/visibility → `ctx.suspend()`, click or
  Space resumes) → `results` (R or Space: again) ; `error` anywhere; Esc closes from any state.
- Clock: `AudioBufferSourceNode`, `playbackRate = rate` (pitch follows the rate; say so in settings). Chart time of an
  instant: `chartMs = startChartMs + ((ctxTime − startAt) · 1000 + offsetMs) · rate`, where `ctxTime` for an event
  comes from `ctx.getOutputTimestamp()` (`contextTime + (event.timeStamp − performanceTime) / 1000`) or, without it,
  `ctx.currentTime − (ctx.outputLatency || ctx.baseLatency || 0)`. The offset is real ms (audio latency is real time),
  so it is added before the rate and one offset fits every rate. Rendering uses the same mapping at the rAF time.
  Lead-in 1.5 s of real time before the first note / the preview start. A start waits for the AudioContext unlock;
  each start carries a token, and a start overtaken by a later one (a blur sent it back to ready, the user started
  again) returns without building a game.
- Preview stretch: audio 0 = the selected diff's `PreviewTime`; play notes with head in
  `[PreviewTime, PreviewTime + duration·1000 − 300]`, drop LNs whose tail is past the end; `previewWarn=1` shows
  «превью общее для набора — может не совпасть с этой сложностью».
- Judgement (osu!stable mania, windows in **real** ms — hit error = Δchart / rate): MAX ±16, 300 ±(64 − 3·OD),
  200 ±(97 − 3·OD), 100 ±(127 − 3·OD), 50 ±(151 − 3·OD), miss window 188 − 3·OD (a press earlier than that is ignored;
  a press inside it but outside 50 is a miss; a note passing +50 unhit is a miss). LN: head as a note; tail judged on
  release with windows × 1.5; release earlier than the tail's 50 window → tail miss (combo break, body greys);
  still held after the tail's 50 window → tail 50; head miss → the tail counts as a miss too.
- Accuracy = osu!stable mania (`maniaAccuracy` of `src/overlay/format.js`, copied, with a test that compares):
  `100 · (300·(MAX+300) + 200·n200 + 100·n100 + 50·n50) / (300 · judgements)`; combo +1 per non-miss judgement, reset on
  miss; results also show max combo and UR (`unstableRate` of the same file).
- Look: app palette (`--bg #14121c`, `--panel #1c1928`, `--line #2c2840`, `--text #eee`, `--muted #8a8698`,
  `--gold #f5c66b`, `--blue #8fd3ff`); 4K lanes: outer gold, inner blue (the app icon); judge line, key-press glow,
  judgement text, combo, accuracy, progress; downscroll/upscroll. Only 4 keys (`keys !== 4` → error).
- Test hooks: `documentElement.dataset.lmPlayer` (state), `dataset.lmError` (error code), `dataset.lmStats`
  (JSON `{ max, n300, n200, n100, n50, miss, combo, maxCombo, acc, notes }`, updated live).

### 5.7 Page panel contract (page lane; also the smoke test's hooks)
- Host `[data-lm-root]`, attributes `data-set-id`, `data-lm-state` = `loading` | `ready`.
- Chips (one per 4K diff, picker order): `[data-lm-chip][data-beatmap-id][data-state]` with state `pending` | `ok` |
  `not-rice` | `too-short` | `error`, `data-numeric` (ok), `aria-current="true"` on the selected one; text = label (e.g.
  "Delta mid") + number; title = version + confidence. Click selects that difficulty by clicking osu-web's picker
  anchor for it (fallback: set the hash and re-read). When osu-web's picker (or the hash) is on a difficulty that is
  not one of the chips (7K, osu!, a convert), no chip is `aria-current` and instead of the card and the side boxes the
  panel shows `[data-lm-foreign]` «Выбрана не 4K-сложность — дан есть только у osu!mania 4K, выбери её выше»; picking
  a 4K difficulty (there or on a chip) brings the card back.
- Card `[data-lm-card][data-beatmap-id]`: label + number, «уверенность {word} · разброс ±{halfWidth}» (app wording),
  main pattern, top 3 with shares, Tech, BPM, length; not-rice → «LN-карта — не считаем» / «Не 4K»; too-short →
  «Слишком короткая карта»; error → «Ошибка: …»; network errors worded by code.
- Rates: `[data-lm-rates-toggle]` («Дан на рейтах ▸/▾»), rows `[data-lm-rate-row][data-rate][data-state][data-numeric]`
  (label, number, delta from 1.0×, «● сейчас» on the chosen demo rate); clicking a row sets the demo rate. A failed
  row (`data-state="error"`) sits in `.rate-line` with a small `[data-lm-action="retry-rate"][data-rate]` «Ещё раз»
  that asks that rate again (high priority); failed rates are also asked again when the block is opened again or the
  difficulty is selected again.
- Buttons: `[data-lm-action="play-preview"]` «Сыграть демо (10 с)», `[data-lm-action="play-full"]` «Полная карта»
  with the note «скачает .osz с osu! — нужен вход, считается в лимит загрузок», `[data-lm-action="play-file"]`
  «Свой .osz». Shown for any 4K mania diff (also LN maps). Small footer: «Lunacy mania <appVersion>» — never osu!'s
  branding.

## 6. Tests

`node --test "tests/extension/**/*.test.js"` (also part of `npm test`); no network, no browser. Each lane:
`node --test tests/extension/<lane>/`.

core (`tests/extension/core/`):
- build: graph copied with relative paths; the model.js line swapped exactly once; no static `node:`/bare import left
  in `lib/`; every DATA_FILE except `ort.node.min.mjs`, plus `ort.wasm.min.mjs`, present; manifests valid JSON, the two
  equal except background/offscreen/gecko/minimum_chrome_version; locales have `extName`/`extDescription` ≤ 132; the
  fingerprint equals `analyzerFingerprint()`.
- parity: import `<tmp build>/chrome/lib/src/core/analyze.js` in Node (the shim reads `file:` URLs with a guarded dynamic
  `node:fs/promises` import) and deep-equal the original `analyzeChart` on `makeChart`/`randomChart` charts at 1.0× and
  1.2×, plus a 7K and an LN chart.
- privacy: in the code files of `extension/` (`.js .json .html .css`, not `DESIGN.md`, not `build/`) the only URL
  hosts are `osu.ppy.sh`, `b.ppy.sh`, `*.ppy.sh`; no `eval`, `new Function`, remote `<script src>`; in the whole build
  output no absolute local paths (match concrete ones: `:\Users\`, `:/Users/`, `/home/`, the worktree and scratch
  roots — not a bare `[A-Za-z]:` pattern, which vendor `ett/calc.js` has as a regex), no e-mail addresses, no Windows
  user name.
- md5 (vs `node:crypto`), osz (stored + deflate entries made with `src/gen/osz.js` / `node:zlib`, damaged, shifted
  directory, UTF-8 names, size cap), osuMeta, transfer (round trip), cache (LRU, caps), relabel (ru/en, below/above),
  fetchers (fake fetch: logged-out 302 → login, 429 → limit/retry, html → login, PK → ok, host check),
  analysisHost (priority order, timeout restart), router (R1, validation, shared in-flight promise).

page (`tests/extension/page/`): site.js on a saved osu-web body (the fixture shapes in §2: picker anchors, json tags,
lang), 4K filtering (mania 4K only, converts/7K/osu! skipped), selected-id resolution (hash, active class, fallback),
nav callbacks (turbo:load, before-cache, hash poll with fake timers), panel rendering per result kind and state
attributes, strings coverage (every key has ru and en), playerFrame params and message origin check — with an injected
fake client and a small DOM helper of its own.

player (`tests/extension/player/`): chart parsing (columns from x, LN end times, OD, PreviewTime), judge windows per OD
and the LN rules, accuracy = `src/overlay/format.js` `maniaAccuracy`, UR, clock mapping (rate, latency, offset),
input bindings (`event.code`, repeat, rebinding refusals), preview stretch selection, `.osz` entry choice (BeatmapID,
checksum, single 4K, list), settings defaults/clamping, strings coverage.

### Smoke test (`tools/smoke-extension.mjs`, core owns; page/player expose the hooks of §5.6–5.7)

`node tools/smoke-extension.mjs [--browser chrome|edge|<exe>] [--tmp <dir>] [--live] [--keep]`; exit 0 pass, 1 fail,
3 skip (no browser / no openssl). Hard timeout 180 s; always kills the browser and removes the temp profile.
1. Build into `<tmp>/build`. Generate a throwaway self-signed cert (openssl, SAN osu.ppy.sh, b.ppy.sh, bm1.ppy.sh) in
   `<tmp>/cert`.
2. Fixture HTTPS server on 127.0.0.1 (from `tests/extension/fixtures/site/`): a fake osu-web page per set
   (`<html lang>`, `#json-current-user {}`, `#json-beatmapset` with 2 rice 4K diffs + 1 LN-heavy 4K + 1 7K + 1 osu!
   diff + a convert, checksums = MD5 of the served `.osu`; the header/picker DOM of §2; a small `fake-osu-web.js` that
   toggles `--active` + `history.replaceState` on picker clicks and does a fake Turbo visit: `turbo:before-cache`,
   body swap, `pushState`, `turbo:load`), `/osu/<id>` from `makeChart`/`randomChart` (≥ 80 notes, PreviewTime set),
   `/preview/<setId>.mp3` = 10 s WAV from `tests/fixtures/clickTrack.js`, `/beatmapsets/<id>/download?noVideo=1` →
   302 to the set page without cookie, 302 to `https://bm1.ppy.sh/d/<id>` with cookie `osu_session=smoke`, which serves
   an `.osz` from `src/gen/osz.js` (the `.osu` + the WAV). The server logs every Host.
3. `chrome|msedge --headless=new --user-data-dir=<tmp>/profile --no-first-run --no-default-browser-check
   --remote-debugging-pipe --enable-unsafe-extension-debugging --ignore-certificate-errors --mute-audio
   --autoplay-policy=no-user-gesture-required
   --host-resolver-rules="MAP osu.ppy.sh 127.0.0.1:<p>,MAP b.ppy.sh 127.0.0.1:<p>,MAP bm1.ppy.sh 127.0.0.1:<p>,MAP * ~NOTFOUND"`
   (spawn stdio `["ignore","ignore","ignore","pipe","pipe"]`, NUL-terminated JSON on fds 3/4), CDP
   `Extensions.loadUnpacked { path: <tmp>/build/chrome }`, `Target.createTarget` on
   `https://osu.ppy.sh/beatmapsets/<set>#mania/<id>`, `Runtime.evaluate` reading the open shadow root.
4. Checks (each with a `Page.captureScreenshot` into `<tmp>/shots/`): chips only for the 4K mania ids; every chip
   reaches a final state; each ok chip's `data-numeric` and label equal Node's `analyzeChart` of the same fixture
   `.osu`; LN diff → not-rice; clicking the second picker anchor moves the card; opening rates gives 15 rows and 1.2×
   equals Node; play-preview → `iframe[data-lm-player]`, player target (`type: "iframe"`, url
   `chrome-extension://<id>/player/player.html`) reaches `ready`; `Input.dispatchKeyEvent` Space → `playing`, D/F/J/K
   presses → `lmStats` counts move, results reached; Escape → iframe gone; play-full without cookie →
   `lmError = "login"`; `Storage.setCookies` `osu_session=smoke` (.ppy.sh, secure, httpOnly, Lax) → play-full reaches
   `ready`; fake Turbo visit → old host removed, new set's chips appear; the server saw only osu.ppy.sh, b.ppy.sh,
   bm1.ppy.sh.
5. `--live` (opt-in, once): no host mapping, real `https://osu.ppy.sh/beatmapsets/2316993#mania/4961226`; Cloudflare
   challenge (title "Just a moment…" / challenge form) → SKIP; else the chip of 4961226 must equal Node's answer on the
   `.osu` the smoke script fetched itself (a handful of requests: the page, its 16 `.osu`, the preview; never
   `/download`).
Firefox: no browser here — build `--target firefox` and check its manifest in the unit tests; `web-ext` is not
installed and is not to be downloaded without asking.

## 7. Risks and their answers
- Logged-in download host unknown (can't log in here): `*.ppy.sh` host permission covers osu!'s own hosts; anything else
  → `host`/`network` error with the `.osz` drop fallback. To be confirmed by the user once with their own session.
- Cloudflare may challenge headless browsers on the live site → the fixture smoke is the gate, live is best-effort.
- osu-web markup changes (React class names) → selectors only in `content/site.js`, layered fallbacks, floating panel
  as last resort; data comes from `json-beatmapset`, not from markup.
- React may drop our sibling node on re-render → MutationObserver re-inserts; we never touch React's nodes.
- `replaceState` difficulty switches are invisible to events → 300 ms hash poll on set pages only.
- The set preview belongs to one diff (dan packs differ in audio) → `previewWarn`; PreviewTime −1 → preview off.
- Size ~15 MB (ORT 12.4 MB wasm, needed for Companella = same dans as the app); first analysis ~0.5 s for wasm init,
  the offscreen document stays open.
- Chrome extension messaging is JSON → base64 chunks (+33 %); `noVideo=1` keeps `.osz` small; 300 MB cap.
- MV3 SW idles after 30 s → progress messages every ≤ 5 s during downloads; pending `sendMessage` answers keep it up.
- Firefox untested here: background-page `fetch` cookies with SameSite=Lax, module workers (FF ≥ 114),
  `DecompressionStream("deflate-raw")` (FF ≥ 113) → `strict_min_version` 128; to be checked on a machine with Firefox.
- Audio latency differs per device → offset nudge and setting; `getOutputTimestamp` with a fallback.
- Web-accessible resources make the extension detectable by osu! pages (needed for the iframe and the content
  modules); no `use_dynamic_url` (its URLs break `import(runtime.getURL())`).
- Extension reload leaves dead content scripts → `ERR.CONTEXT`, the panel says «обнови страницу».
- Download quota: only on the user's click, the UI says it counts; 429 → `limit`.
