// Marathon .osz: joined chart + joined audio + dan-course background, from maps on disk.
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMarathon } from "../src/rate/marathon.js";
import { backgroundHtml } from "../src/rate/backgroundHtml.js";
import { curveRows, curveSvg } from "../src/rate/marathonCurve.js";
import { buildOsz } from "../src/gen/osz.js";
import { renderMarathonAudio } from "./marathonAudio.js";
import { safeFileName } from "./mapExport.js";
import { t, plural } from "../src/i18n/i18n.js";

const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const exists = (p) => access(p).then(() => true, () => false);
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

function backgroundFile(osuText) {
    const m = /^0,0,"([^"]+)"/m.exec(osuText);
    return m ? m[1] : null;
}

// "5 maps" with the right plural: plural() picks the key (Russian has three forms), t() the language
const MAPS_KEYS = {
    ru: ["app.marathon.maps.one", "app.marathon.maps.few", "app.marathon.maps.many"],
    en: ["app.marathon.maps.one", "app.marathon.maps.many"],
};
export function mapsWord(n) {
    return t(plural(n, MAPS_KEYS), { n });
}

const minutes = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;

// What danFor answers: { label, numeric } (a bare label still works, it just has no place on the curve).
const asDan = (d) => (typeof d === "string" ? { label: d, numeric: null } : { label: String(d?.label ?? ""), numeric: Number.isFinite(d?.numeric) ? d.numeric : null });

// danFor(osuText, rate) → { label, numeric }; renderPng(html) → PNG buffer (Electron offscreen window in the app);
// plan: the template's dan per map, dashed on the background's curve (null: no template).
export async function createMarathon({ ffmpeg, entries, gapMs, pitch, title, od = null, hp = null, outDir, danFor, renderPng, plan = null }) {
    if (!entries.length) throw new Error(t("app.marathon.noMaps"));
    const maps = [];
    for (const e of entries) {
        const osuText = await readFile(e.path, "utf8");
        const name = `${field(osuText, "Artist")} - ${field(osuText, "Title")} [${field(osuText, "Version")}]`;
        if (field(osuText, "Mode") !== "3" || Number(field(osuText, "CircleSize")) !== 4) throw new Error(t("app.marathon.not4k", { name }));
        maps.push({ ...e, osuText, name, dir: path.dirname(e.path) });
    }

    const built = buildMarathon(maps.map((m) => ({ osuText: m.osuText, rate: m.rate })),
        { gapMs, title, audioFilename: "audio.mp3", background: "bg.png", od, hp });

    const work = await mkdtemp(path.join(tmpdir(), "dan-marathon-"));
    try {
        const audio = path.join(work, "audio.mp3");
        await renderMarathonAudio({
            ffmpeg, gapMs, pitch, output: audio,
            segments: built.segments.map((s, i) => ({ ...s, path: path.join(maps[i].dir, field(maps[i].osuText, "AudioFilename")) })),
        });

        const dans = [];
        for (const m of maps) dans.push(asDan(await danFor(m.osuText, m.rate)));
        const bgName = backgroundFile(maps[0].osuText);
        const bgPath = bgName ? path.join(maps[0].dir, bgName) : null;
        const type = bgPath ? IMAGE_TYPES[path.extname(bgPath).toLowerCase()] : null;
        const imageDataUrl = type && (await exists(bgPath)) ? `data:${type};base64,${(await readFile(bgPath)).toString("base64")}` : null;
        const known = dans.map((d) => d.label).filter(Boolean);
        const subtitle = [t("app.marathon.kind"), mapsWord(maps.length), minutes(built.totalMs), known.length ? `${known[0]} → ${known.at(-1)}` : ""]
            .filter(Boolean).join(" · ");
        // the same numbers as the curve in the tab: each map's cut at its rate, the gaps between them
        const curve = curveRows(built.segments.map((sg, i) => ({ cutMs: sg.srcEndMs - sg.srcStartMs, rate: sg.rate, ...dans[i] })), gapMs);
        const curveText = curve.rows.some((r) => r.numeric !== null)
            ? curveSvg(curve.rows, { totalMs: curve.totalMs, width: 1500, height: 180, plan, planLabel: t("marathon.curve.plan"), showLabels: true, font: 22 })
            : "";
        const png = await renderPng(backgroundHtml({
            title, subtitle, imageDataUrl, curveSvg: curveText,
            items: built.list.map((it, i) => ({ label: it.label, dan: dans[i]?.label ?? "" })),
        }));

        await mkdir(outDir, { recursive: true });
        const base = safeFileName(title);
        let file = path.join(outDir, `${base} [marathon].osz`);
        for (let n = 2; await exists(file); n += 1) file = path.join(outDir, `${base} [marathon] (${n}).osz`);
        await writeFile(file, buildOsz([
            { name: `${base}.osu`, data: Buffer.from(built.osuText, "utf8") },
            { name: "audio.mp3", data: await readFile(audio) },
            { name: "bg.png", data: png },
        ]));
        return { file, totalMs: built.totalMs, list: built.list, dans: dans.map((d) => d.label) };
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}
