// The fake osu! site of the smoke test (extension/DESIGN.md §6): one HTTPS server on 127.0.0.1 that the browser
// reaches as osu.ppy.sh, b.ppy.sh and bm1.ppy.sh (--host-resolver-rules). It serves beatmapset pages shaped like
// osu-web's (json tags, header, picker), /osu/<id>, /preview/<setId>.mp3 (a WAV), and the download: without the
// cookie osu_session=smoke a 302 back to the set's page (osu!'s logged-out answer), with it a 302 to
// https://bm1.ppy.sh/d/<setId>, which sends an .osz made with the app's src/gen/osz.js. Every request is logged.
import https from "node:https";
import { readFileSync } from "node:fs";
import { buildOsz } from "../../../../src/gen/osz.js";
import { AUDIO_NAME, buildSets, setAudio } from "./sets.js";

const FAKE_SCRIPT = readFileSync(new URL("./fake-osu-web.js", import.meta.url), "utf8");
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// JSON inside <script type="application/json">: no "</" can end the tag early
const jsonTag = (id, value) => `<script id="${id}" type="application/json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;

export function setPage(set, { lang = "en" } = {}) {
    const mania = set.json.beatmaps.filter((b) => b.mode === "mania").sort((x, y) => x.difficulty_rating - y.difficulty_rating || x.id - y.id);
    const picker = mania.map((b) => `<a class="beatmapset-beatmap-picker__beatmap" data-version="${escapeHtml(b.version)}" href="https://osu.ppy.sh/beatmapsets/${set.id}#mania/${b.id}"><span class="beatmap-icon"></span></a>`).join("");
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`Test - ${set.title}`)} · beatmap info | fake osu! for tests</title>
<meta name="turbo-cache-control" content="no-preview">
<script src="/assets/fake-osu-web.js"></script>
</head>
<body class="t-section">
<div class="osu-layout__section osu-layout__section--full">
<div class="js-react u-contents" data-react="beatmapset-page">
<div class="osu-page osu-page--generic-compact">
<div class="beatmapset-header">
<div class="beatmapset-header__box beatmapset-header__box--main">
<div class="beatmapset-header__beatmap-picker-box">
<div class="beatmapset-beatmap-picker">${picker}</div>
<span class="beatmapset-header__diff-name"></span>
</div>
<h1 class="beatmapset-header__details-text beatmapset-header__details-text--title">${escapeHtml(set.title)}</h1>
<div class="beatmapset-header__buttons"><a class="btn-osu-big" href="/beatmapsets/${set.id}/download">Download</a></div>
</div>
<div class="beatmapset-header__box beatmapset-header__box--stats"><div class="beatmapset-stats"></div></div>
</div>
<div class="beatmapset-info"><p>Description of the fake set.</p></div>
<div class="user-profile-pages"><p>Comments.</p></div>
</div>
</div>
</div>
${jsonTag("json-current-user", {})}
${jsonTag("json-route-section", { action: "show", controller: "beatmapsets_controller", namespace: "main", section: "beatmaps" })}
${jsonTag("json-beatmapset", set.json)}
</body>
</html>
`;
}

export async function startFixtureSite({ key, cert, lang = "en" }) {
    const sets = buildSets();
    const bySet = new Map(sets.map((s) => [s.id, s]));
    const osuById = new Map(sets.flatMap((s) => s.diffs.map((d) => [d.json.id, d.osu])));
    const audio = new Map(sets.map((s) => [s.id, setAudio(s)]));
    const log = [];

    const server = https.createServer({ key, cert }, (req, res) => {
        const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
        const url = new URL(req.url, `https://${host}`);
        const cookie = /(?:^|;\s*)osu_session=smoke(?:;|$)/.test(req.headers.cookie ?? "");
        log.push({ host, path: url.pathname + url.search, cookie });
        const send = (status, body, headers = {}) => {
            res.writeHead(status, { "Cache-Control": "no-store", ...headers });
            res.end(body);
        };
        let m;
        if (host === "osu.ppy.sh") {
            if (url.pathname === "/assets/fake-osu-web.js") return send(200, FAKE_SCRIPT, { "Content-Type": "text/javascript; charset=utf-8" });
            if ((m = /^\/beatmapsets\/(\d+)\/?$/.exec(url.pathname)) && bySet.has(Number(m[1]))) {
                return send(200, setPage(bySet.get(Number(m[1])), { lang }), { "Content-Type": "text/html; charset=utf-8" });
            }
            if ((m = /^\/beatmapsets\/(\d+)\/download$/.exec(url.pathname)) && bySet.has(Number(m[1]))) {
                const location = cookie ? `https://bm1.ppy.sh/d/${m[1]}?noVideo=1` : `https://osu.ppy.sh/beatmapsets/${m[1]}`;
                return send(302, "", { Location: location });
            }
            if ((m = /^\/osu\/(\d+)$/.exec(url.pathname)) && osuById.has(Number(m[1]))) {
                return send(200, osuById.get(Number(m[1])), { "Content-Type": "text/plain;charset=UTF-8", "Content-Disposition": `attachment;filename=${m[1]}.osu` });
            }
            return send(404, "not found", { "Content-Type": "text/plain" });
        }
        if (host === "b.ppy.sh" && (m = /^\/preview\/(\d+)\.mp3$/.exec(url.pathname)) && audio.has(Number(m[1]))) {
            return send(200, audio.get(Number(m[1])).preview, { "Content-Type": "audio/wav" });
        }
        if (host === "bm1.ppy.sh" && (m = /^\/d\/(\d+)$/.exec(url.pathname)) && bySet.has(Number(m[1]))) {
            if (!cookie) return send(403, "forbidden", { "Content-Type": "text/plain" });
            const set = bySet.get(Number(m[1]));
            const osz = buildOsz([
                ...set.diffs.map((d) => ({ name: `Test - ${set.title} (Test) [${d.json.version}].osu`, data: d.osu })),
                { name: AUDIO_NAME, data: audio.get(set.id).full },
            ]);
            return send(200, osz, {
                "Content-Type": "application/x-osu-beatmap-archive",
                "Content-Length": String(osz.length),
                "Content-Disposition": `attachment; filename="${set.id} Test - ${set.title}.osz"`,
            });
        }
        return send(404, "not found", { "Content-Type": "text/plain" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        sets,
        log,
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}
