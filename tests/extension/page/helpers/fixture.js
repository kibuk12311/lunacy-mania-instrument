// A beatmapset page shaped like osu-web's (extension/DESIGN.md §2): <html lang>, the json-* tags, the React mount with
// the header, the difficulty picker (anchors #mania/<id>, one --active), the info block. Invented set and maps.
export const SET_ID = 900001;

const diff = (id, extra) => ({
    beatmapset_id: SET_ID, id, mode: "mania", mode_int: 3, cs: 4, accuracy: 8, convert: false,
    status: "graveyard", total_length: 120, hit_length: 118, count_circles: 900, count_sliders: 10,
    url: `https://osu.ppy.sh/beatmaps/${id}`, checksum: String(id).padStart(32, "a").slice(-32), ...extra,
});

// picker order: difficulty_rating ascending, then id → 1003 (3.1), 1001 (4.2), 1002 (4.2), then the LN one (5.0)
export const BEATMAPS = [
    diff(1001, { version: "[4K] Normal rice", difficulty_rating: 4.2 }),
    diff(1002, { version: "[4K] Hard rice", difficulty_rating: 4.2 }),
    diff(1003, { version: "[4K] Easy rice", difficulty_rating: 3.1 }),
    diff(1004, { version: "[4K] Long notes", difficulty_rating: 5.0, count_sliders: 600 }),
    diff(1005, { version: "[7K] Seven", difficulty_rating: 4.0, cs: 7 }),
    { ...diff(1006, { version: "osu! diff", difficulty_rating: 3.0 }), mode: "osu", mode_int: 0, cs: 4 },
    diff(1007, { version: "a convert", difficulty_rating: 2.0, convert: true }),
];
export const FOUR_K_ORDER = [1003, 1001, 1002, 1004];

export function beatmapset(overrides = {}) {
    return {
        id: SET_ID, artist: "Fixture Artist", title: "Fixture Title", creator: "fixture-mapper",
        preview_url: `https://b.ppy.sh/preview/${SET_ID}.mp3`, status: "graveyard", video: false,
        availability: { download_disabled: false, more_information: null },
        beatmaps: BEATMAPS, converts: [diff(2001, { version: "convert", convert: true, difficulty_rating: 1 })],
        ...overrides,
    };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function pickerHtml(set, activeId) {
    const anchors = set.beatmaps.filter((b) => b.mode === "mania" && !b.convert)
        .sort((a, b) => a.difficulty_rating - b.difficulty_rating || a.id - b.id)
        .map((b) => `<a class="beatmapset-beatmap-picker__beatmap${b.id === activeId ? " beatmapset-beatmap-picker__beatmap--active" : ""}" href="https://osu.ppy.sh/beatmapsets/${set.id}#mania/${b.id}"><div class="beatmap-icon"></div></a>`)
        .join("");
    return `<div class="beatmapset-beatmap-picker">${anchors}</div>`;
}

// rendered: false → only what the server sends (the React mount is empty); json: false → no json-beatmapset tag
export function pageHtml({ set = beatmapset(), lang = "en", user = {}, activeId = 1001, rendered = true, json = true, header = true } = {}) {
    const react = rendered
        ? `<div class="osu-page osu-page--generic-compact">
            ${header ? `<div class="beatmapset-header"><div class="beatmapset-header__box beatmapset-header__box--main">
              <div class="beatmapset-header__beatmap-picker-box">${pickerHtml(set, activeId)}
                <span class="beatmapset-header__diff-name">${esc(set.beatmaps.find((b) => b.id === activeId)?.version ?? "")}</span></div>
              <div class="beatmapset-header__buttons"><a class="btn-osu-big" href="/beatmapsets/${set.id}/download">Download</a></div>
            </div><div class="beatmapset-stats"></div></div>` : ""}
            <div class="beatmapset-info"></div>
            <div class="user-profile-pages"></div>
          </div>`
        : "";
    return `<!DOCTYPE html>
<html prefix="og: http://ogp.me/ns#" lang="${lang}">
<head><meta name="turbo-cache-control" content="no-preview"><title>Fixture</title></head>
<body>
<div class="osu-layout__section osu-layout__section--full">
  <div class="js-react u-contents" data-react="beatmapset-page">${react}</div>
</div>
<script id="json-current-user" type="application/json">
    ${user === null ? "" : JSON.stringify(user)}
</script>
<script id="json-route-section" type="application/json">{"action":"show","controller":"beatmapsets_controller","namespace":"main","section":"beatmaps"}</script>
${json ? `<script id="json-beatmapset" type="application/json">\n        ${JSON.stringify(set)}\n</script>` : ""}
<script id="json-config" type="application/json">{}</script>
</body></html>`;
}

// A DanResult of kind ok, shaped like analyzeChart's
export function okResult(numeric, extra = {}) {
    return {
        kind: "ok", label: `Dan ${numeric.toFixed(1)}`, numeric, halfWidth: 0.4, confidence: "high", confidenceLevel: "high",
        primary: "Rolls", top3: [{ name: "Jumpstream", share: 0.5 }, { name: "Rolls", share: 0.3 }, { name: "Trills", share: 0.2 }],
        tech: false, calcs: { mixed: numeric, daniel: numeric + 0.2, azusa: numeric - 0.1, roxy: numeric, companella: numeric - 0.4 },
        sunny: 7.11, msd: { overall: 25.5 }, bpm: 180, durationSec: 125, rate: 1, ...extra,
    };
}

export function meta(id, extra = {}) {
    return {
        mode: 3, keys: 4, od: 8, hp: 8, previewTime: 30000, audioFilename: "audio.mp3", audioLeadIn: 0,
        title: "Fixture Title", artist: "Fixture Artist", creator: "fixture-mapper", version: "v", beatmapId: id,
        beatmapSetId: SET_ID, noteCount: 900, lnCount: 0, firstNoteMs: 1000, lastNoteMs: 120000, ...extra,
    };
}
