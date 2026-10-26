// osu! lazer keeps every map in its hashed file store (<data>\files\a\ab\abc…, see tosuClient.js), so nothing is ever
// written there. A map picked in lazer is copied out, read only, into Documents\<app>\lazer\<set>\ under the names its
// .osu uses (so the tabs that work on a folder like stable's Songs keep working), and whatever the app makes for lazer
// goes back in as an .osz that lazer imports when it is opened.
// Every .osu put in such an .osz gets BeatmapSetID:-1 and BeatmapID:0: lazer marks an existing set with the same
// online id for deletion when it imports another one, so a rate copy carrying the original's id would replace it.
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildOsz } from "../src/gen/osz.js";
import { setField } from "../src/gen/osuMeta.js";
import { rateText } from "../src/rate/rateMap.js";
import { safeFileName } from "./mapExport.js";
import { t } from "../src/i18n/i18n.js";

const exists = (p) => access(p).then(() => true, () => false);
const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";

export const lazerDirOf = (docsDir) => path.join(docsDir, "lazer");

// The background named in [Events] ("0,0,"bg.jpg",0,0" or without the quotes), or null.
export function backgroundName(osuText) {
    const m = /^0\s*,\s*0\s*,\s*("([^"]+)"|([^,\r\n]+))/m.exec(String(osuText));
    const name = (m?.[2] ?? m?.[3] ?? "").trim();
    return name || null;
}

// An .osu lazer imports as a set of its own: no online ids to collide with the map it was made from.
export function lazerSafe(osuText) {
    return setField(setField(osuText, "Metadata", "BeatmapSetID", "-1"), "Metadata", "BeatmapID", "0");
}

const osuName = (text) => `${safeFileName(`${field(text, "Artist")} - ${field(text, "Title")} (${field(text, "Creator")}) [${field(text, "Version")}]`)}.osu`;

// A name that is only a file in one folder: no "..", no folders.
const plainName = (name) => (name && path.basename(name) === name && name !== "." && name !== ".." ? name : null);

// source: tosu's { path, audioPath, backgroundPath } of the map selected in lazer; osuText: that map's .osu.
// → { path, dir } of the copy. Files already copied (same size) are kept; the lazer store is only read.
export async function copyLazerMap({ source, osuText, root }) {
    const setId = Number(field(osuText, "BeatmapSetID"));
    const tag = setId > 0 ? String(setId) : `x${createHash("md5").update(String(source?.audioPath ?? source?.path ?? "")).digest("hex").slice(0, 8)}`;
    const dir = path.join(root, safeFileName(`${tag} ${field(osuText, "Artist")} - ${field(osuText, "Title")}`));
    await mkdir(dir, { recursive: true });
    const copyIn = async (from, name) => {
        const plain = plainName(name);
        if (!from || !plain) return null;
        const to = path.join(dir, plain);
        const [a, b] = await Promise.all([stat(from).catch(() => null), stat(to).catch(() => null)]);
        if (!a) return null;
        if (!b || b.size !== a.size) await copyFile(from, to);
        return to;
    };
    const audio = await copyIn(source?.audioPath, field(osuText, "AudioFilename"));
    if (!audio) throw new Error(t("app.lazer.noAudio"));
    await copyIn(source?.backgroundPath, backgroundName(osuText));
    const file = path.join(dir, osuName(osuText));
    await writeFile(file, osuText, "utf8");
    return { path: file, dir };
}

// An .osz in outDir from charts [{ name, osuText }] and the files of their folder they name (audio, background),
// under a name no file has yet. → the .osz path.
export async function packLazerOsz({ charts, dir, outDir, baseName }) {
    const entries = [];
    const names = new Set();
    const add = async (name) => {
        const plain = plainName(name);
        if (!plain || names.has(plain.toLowerCase())) return;
        const file = path.join(dir, plain);
        if (!(await exists(file))) return;
        names.add(plain.toLowerCase());
        entries.push({ name: plain, data: await readFile(file) });
    };
    for (const c of charts) {
        entries.push({ name: c.name, data: Buffer.from(lazerSafe(c.osuText), "utf8") });
        names.add(c.name.toLowerCase());
    }
    for (const c of charts) {
        await add(field(c.osuText, "AudioFilename"));
        await add(backgroundName(c.osuText));
    }
    await mkdir(outDir, { recursive: true });
    const base = safeFileName(baseName);
    let file = path.join(outDir, `${base}.osz`);
    for (let n = 2; await exists(file); n += 1) file = path.join(outDir, `${base} (${n}).osz`);
    await writeFile(file, buildOsz(entries));
    return file;
}

// Rate copies for lazer: the map copied out of the store, each rate made there by makeCopy (rateCreate.js), all of
// them in one .osz in outDir. onRate({ index, total, rate }) before each; isCancelled() between them.
// → { file | null, made: [{ rate, version, osuPath }], failed: [{ rate, message }], cancelled }
export async function createLazerRates({ ffmpeg, source, osuText, rates, options, lazerDir, outDir, makeCopy, onRate = () => {}, isCancelled = () => false, log = () => {} }) {
    const local = await copyLazerMap({ source, osuText, root: lazerDir });
    const made = [];
    const failed = [];
    const charts = [];
    let cancelled = false;
    for (const [i, rate] of rates.entries()) {
        if (isCancelled()) {
            cancelled = true;
            break;
        }
        onRate({ index: i + 1, total: rates.length, rate });
        try {
            const out = await makeCopy({ ffmpeg, beatmapPath: local.path, rate, ...options, osuText });
            log(`rate map (lazer) ${out.osuPath}${out.reusedAudio ? " (audio reused)" : ""}`);
            made.push({ rate, version: out.version, osuPath: out.osuPath });
            charts.push({ name: path.basename(out.osuPath), osuText: out.osuText });
        } catch (error) {
            failed.push({ rate, message: String(error?.message ?? error) });
        }
    }
    if (!charts.length) return { file: null, made, failed, cancelled };
    const list = made.map((m) => `${rateText(m.rate)}x`).join(" ");
    const file = await packLazerOsz({
        charts, dir: local.dir, outDir,
        baseName: `${field(osuText, "Artist")} - ${field(osuText, "Title")} [${field(osuText, "Version")}] ${list}`,
    });
    return { file, made, failed, cancelled };
}
