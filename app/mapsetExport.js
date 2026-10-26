// One .osz for a generated mapset (mapgen v3, stream C): every difficulty with the same metadata, preview point and
// background, plus rate versions that each get their own audio and are named by their own dan. Never overwrites.
// Also the song's own tags (title, artist) from ffmpeg's report, for the metadata fields.
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOsz } from "../src/gen/osz.js";
import { applyMeta, readMeta, setVersion } from "../src/gen/osuMeta.js";
import { rateOsu, rateText } from "../src/rate/rateMap.js";
import { backgroundHtml } from "../src/rate/backgroundHtml.js";
import { renderRateAudio } from "./rateAudio.js";
import { safeFileName } from "./mapExport.js";
import { t } from "../src/i18n/i18n.js";

const exists = (p) => access(p).then(() => true, () => false);
// osu! plays these as they are; anything else (.wav, .flac) is turned into an mp3 first
const PLAYABLE = new Set([".mp3", ".ogg"]);
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

// ---- song tags ----

// The song's title and artist from ffmpeg's report of the file: the file's own tags (the format's, then the audio
// stream's; a cover picture's "title" is not the song's), else "Artist - Title" from the file name, else from the
// folder (osu!'s "123456 Artist - Title"), else the bare file name as the title.
export function parseTags(stderr, file) {
    const found = {};
    let scope = null; // "input" | "audio" | "other"
    for (const line of String(stderr ?? "").split(/\r?\n/)) {
        if (/^Input #\d+/.test(line)) scope = "input";
        else if (/^\s*Stream #\d+:\d+.*?: Audio:/.test(line)) scope = "audio";
        else if (/^\s*Stream #/.test(line)) scope = "other";
        else if (/^\s*Duration:/.test(line) && scope === "input") scope = "between";
        if (scope !== "input" && scope !== "audio") continue;
        const m = /^\s+(title|artist)\s*:\s*(.*)$/i.exec(line);
        if (m && m[2].trim()) found[m[1].toLowerCase()] ??= m[2].trim();
    }
    if (found.title) {
        const artist = found.artist ?? "";
        // some files carry "Artist - Title" in the title tag too
        const title = artist && found.title.startsWith(`${artist} - `) ? found.title.slice(artist.length + 3).trim() : found.title;
        return { artist, title: title || found.title };
    }
    const fromName = (name) => {
        const i = name.indexOf(" - ");
        return i > 0 ? { artist: name.slice(0, i).trim(), title: name.slice(i + 3).trim() } : null;
    };
    const parsed = path.parse(String(file).replace(/\\/g, "/"));
    const folder = path.basename(parsed.dir).replace(/^\d+\s+/, "");
    return fromName(parsed.name) ?? fromName(folder) ?? { artist: found.artist ?? "", title: parsed.name };
}

export function probeTags(ffmpeg, input) {
    return new Promise((resolve) => {
        execFile(ffmpeg, ["-hide_banner", "-i", input], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_error, _stdout, stderr) => {
            resolve(parseTags(String(stderr ?? ""), input));
        });
    });
}

// ---- the mapset ----

const ratedAudioName = (rate, pitch) => `${safeFileName(`audio ${rateText(rate)}x${pitch ? " nc" : ""}`)}.mp3`;
const labelOf = (result) => (result?.kind === "ok" ? { label: result.label, numeric: result.numeric } : { label: null, numeric: null });

function unique(name, taken) {
    let out = name;
    for (let n = 2; taken.has(out.toLowerCase()); n += 1) out = `${name} (${n})`;
    taken.add(out.toLowerCase());
    return out;
}

async function backgroundFile({ background, title, artist, diffs, renderPng }) {
    const mode = background?.mode ?? "none";
    const imagePath = background?.imagePath ?? null;
    const ext = imagePath ? path.extname(imagePath).toLowerCase() : "";
    if (mode === "image") return { name: `bg${ext}`, data: await readFile(imagePath) };
    if (mode !== "danCourse") return null;
    const imageDataUrl = imagePath && IMAGE_TYPES[ext] ? `data:${IMAGE_TYPES[ext]};base64,${(await readFile(imagePath)).toString("base64")}` : null;
    const items = diffs.map((d) => ({
        label: d.version,
        dan: [d.label, ...d.rated.map((r) => `${rateText(r.rate)}x ${r.label ?? "—"}`)].filter(Boolean).join(" · "),
    }));
    const png = await renderPng(backgroundHtml({ title, subtitle: [artist, t("app.export.setKind")].filter(Boolean).join(" · "), items, imageDataUrl }));
    return { name: "bg.png", data: png };
}

// diffs: [{ osuText, version, result }] easiest first; meta: { title, artist, creator, source, tags } (empty title,
// artist or creator keep the map's own); previewMs: ms or null; background: { mode: "none"|"image"|"danCourse",
// imagePath? }; rates: up to 3, not 1; danFor(osuText) → analysis of a rated difficulty; renderPng(html) → PNG.
// name: the .osz name without extension (default "Artist - Title (mapset)"). → { file, entries }
export async function exportMapset({
    ffmpeg, dir, audioPath, diffs, meta = {}, previewMs = null, background = { mode: "none" }, rates = [], pitch = false,
    danFor, renderPng, renderAudio = renderRateAudio, name = null,
}) {
    if (!diffs?.length) throw new Error("no difficulties");
    const audioExt = path.extname(audioPath).toLowerCase();
    const audioName = PLAYABLE.has(audioExt) ? `audio${audioExt}` : "audio.mp3";
    const bgName = background?.mode === "image" ? `bg${path.extname(background.imagePath).toLowerCase()}`
        : background?.mode === "danCourse" ? "bg.png" : null;

    const work = await mkdtemp(path.join(tmpdir(), "dan-mapset-"));
    try {
        // the song once, then once per rate
        const audioFiles = [];
        if (PLAYABLE.has(audioExt)) {
            audioFiles.push({ name: audioName, data: await readFile(audioPath) });
        } else {
            const out = path.join(work, audioName);
            await renderAudio({ ffmpeg, input: audioPath, output: out, rate: 1, pitch: false });
            audioFiles.push({ name: audioName, data: await readFile(out) });
        }
        for (const rate of rates) {
            const ratedName = ratedAudioName(rate, pitch);
            const out = path.join(work, ratedName);
            await renderAudio({ ffmpeg, input: audioPath, output: out, rate, pitch });
            audioFiles.push({ name: ratedName, data: await readFile(out) });
        }

        const taken = new Set();
        const built = [];
        for (const d of diffs) {
            const version = unique(d.version, taken);
            let text = applyMeta(d.osuText, { ...meta, previewMs: Number.isFinite(previewMs) ? previewMs : undefined, background: bgName });
            text = setVersion(text.replace(/^(AudioFilename:).*$/m, `$1 ${audioName}`), version);
            const own = d.result?.kind === "ok" ? d.result : (danFor ? await danFor(text) : null);
            const rated = [];
            for (const rate of rates) {
                const draft = rateOsu(text, { rate, audioFilename: ratedAudioName(rate, pitch) });
                const found = labelOf(danFor ? await danFor(draft) : null);
                const ratedVersion = unique(`${found.label ? `${found.label} · ` : ""}${version} ${rateText(rate)}x${pitch ? " NC" : ""}`, taken);
                rated.push({ rate, version: ratedVersion, text: setVersion(draft, ratedVersion), ...found });
            }
            built.push({ version, text, rated, ...labelOf(own) });
        }

        const first = readMeta(built[0].text);
        const bg = await backgroundFile({ background, title: first.title, artist: first.artist, diffs: built, renderPng });
        const osuName = (version) => `${safeFileName(`${first.artist} - ${first.title} (${first.creator}) [${version}]`)}.osu`;
        const names = new Set();
        const osuEntries = built.flatMap((d) => [d, ...d.rated]).map((d) => ({ name: unique(osuName(d.version), names), data: Buffer.from(d.text, "utf8") }));

        await mkdir(dir, { recursive: true });
        const base = safeFileName(name ?? `${first.artist} - ${first.title} (mapset)`);
        let file = path.join(dir, `${base}.osz`);
        for (let n = 2; await exists(file); n += 1) file = path.join(dir, `${base} (${n}).osz`);
        await writeFile(file, buildOsz([...osuEntries, ...audioFiles, ...(bg ? [bg] : [])]));
        const entries = built.flatMap((d) => [
            { version: d.version, label: d.label, numeric: d.numeric, rate: 1 },
            ...d.rated.map((r) => ({ version: r.version, label: r.label, numeric: r.numeric, rate: r.rate })),
        ]);
        return { file, entries };
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}
