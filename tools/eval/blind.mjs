// Blind play test packs (addendum §7, plan §10 Gate 3): one .osz per song holding the song's audio and two
// generated difficulties named [X] and [Y], the engines behind X and Y drawn at random per song. The key (which
// engine is X) goes to a separate JSON file, never into a pack, and nothing in a pack names an engine.
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildOsz } from "../../src/gen/osz.js";

export const BLIND_TAGS = "lunacy-mania generated blind";
export const CANDIDATES_DIR = "A:/SneezeyTrain/candidates";

const dateText = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const blindKeyPath = (date = new Date(), dir = CANDIDATES_DIR) => path.join(dir, `blind-${dateText(date)}.json`);
export const blindDirPath = (date = new Date(), dir = CANDIDATES_DIR) => path.join(dir, `blind-${dateText(date)}`);

// The difficulty name becomes `version` and the tags the fixed blind tags; everything else stays byte for byte.
export function setVersion(osuText, version) {
    const eol = osuText.includes("\r\n") ? "\r\n" : "\n";
    let text = osuText.replace(/^Tags:.*$/m, `Tags:${BLIND_TAGS}`);
    if (/^Version:.*$/m.test(text)) text = text.replace(/^Version:.*$/m, `Version:${version}`);
    else text = text.replace(/^\[Metadata\][ \t]*(?=\r?$)/m, `[Metadata]${eol}Version:${version}`);
    return text;
}

// The audio line points at the pack's own audio entry.
export const setAudio = (osuText, audioName) => osuText.replace(/^AudioFilename:.*$/m, `AudioFilename: ${audioName}`);

const safeName = (s) => String(s ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "song";

async function exists(file) {
    return !!(await stat(file).catch(() => null));
}

// file → the first of file, file-2, file-3 … (before the extension) that does not exist yet.
export async function freePath(file, sep = "-") {
    if (!(await exists(file))) return file;
    const ext = path.extname(file);
    const base = file.slice(0, file.length - ext.length);
    for (let k = 2; ; k += 1) {
        const f = `${base}${sep}${k}${ext}`;
        if (!(await exists(f))) return f;
    }
}

// n picks spread over the dan range (sorted by dan, evenly spaced).
export function spreadByDan(picks, n) {
    const sorted = [...picks].sort((a, b) => a.dan - b.dan);
    if (sorted.length <= n) return sorted;
    if (n === 1) return [sorted[Math.floor(sorted.length / 2)]];
    return Array.from({ length: n }, (_, k) => sorted[Math.round((k * (sorted.length - 1)) / (n - 1))]);
}

// songs: [{ title, artist, audioName, audio: Buffer, info?, maps: { A: { osuText, numeric?, ... }, B: {...} } }]
// rng() in [0, 1) draws which engine becomes X. meta (engines, config) is copied into the key.
export async function writeBlindPack({ songs, outDir, keyFile, rng, meta = {}, date = new Date() }) {
    const rel = path.relative(path.resolve(outDir), path.resolve(keyFile));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error(`the key file must not be inside the pack folder (${keyFile})`);
    await mkdir(outDir, { recursive: true });
    const files = [];
    const entries = [];
    for (const [k, song] of songs.entries()) {
        const X = rng() < 0.5 ? "A" : "B";
        const Y = X === "A" ? "B" : "A";
        const stem = `${safeName(song.artist)} - ${safeName(song.title)}`;
        const osu = (which) => ({ name: `${stem} (Lunacy mania) [${which}].osu`, data: setAudio(setVersion((which === "X" ? song.maps[X] : song.maps[Y]).osuText, which), song.audioName) });
        const osz = buildOsz([{ name: song.audioName, data: song.audio }, osu("X"), osu("Y")], date);
        const file = await freePath(path.join(outDir, `${String(k + 1).padStart(2, "0")} ${stem}.osz`), " ");
        await writeFile(file, osz);
        files.push(file);
        const numeric = { A: song.maps.A.numeric ?? null, B: song.maps.B.numeric ?? null };
        const inRange = { A: song.maps.A.inRange ?? null, B: song.maps.B.inRange ?? null };
        entries.push({ k: k + 1, osz: path.basename(file), title: song.title, artist: song.artist, ...(song.info ?? {}), X, Y, numeric, inRange });
    }
    const key = {
        made: date.toISOString(), packDir: path.resolve(outDir), ...meta,
        howTo: "Play each pack's [X] and [Y] without opening this file; write down which one you prefer per song, then compare with X/Y here.",
        songs: entries,
    };
    const written = await freePath(keyFile);
    await mkdir(path.dirname(written), { recursive: true });
    await writeFile(written, JSON.stringify(key, null, 1));
    return { files, keyFile: written, key };
}
