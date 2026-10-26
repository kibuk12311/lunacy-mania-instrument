// Skin archives: an .osk / .zip read into safe relative paths (it comes from anywhere: every name goes through
// safeEntryPath, sizes are capped), and a skin folder's files packed back into an .osk (a zip, as osu! wants).
import { readZip, safeEntryPath } from "../rate/oszRead.js";
import { buildOsz } from "../gen/osz.js";
import { parseSkinIni, readLine } from "./skinIni.js";
import { imageCandidates } from "./maniaFields.js";

export const MAX_FILES = 5000;
export const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

// buffer → [{ name, read() }] with names relative to the skin's own folder: an archive whose files all sit in one
// folder holding skin.ini (a zipped folder) loses that folder. Throws on a broken or oversized archive.
export function readSkinArchive(buffer) {
    const entries = readZip(buffer).filter((e) => !e.name.endsWith("/"));
    if (entries.length > MAX_FILES) throw new Error("too many files");
    let total = 0;
    const out = [];
    for (const e of entries) {
        const name = safeEntryPath(e.name);
        if (!name) continue;
        total += e.size;
        if (total > MAX_TOTAL_BYTES) throw new Error("too big");
        out.push({ name, read: () => e.read() });
    }
    const tops = new Set(out.map((e) => (e.name.includes("/") ? e.name.split("/")[0].toLowerCase() : "")));
    if (tops.size === 1 && !tops.has("") && out.some((e) => /^[^/]+\/skin\.ini$/i.test(e.name))) {
        for (const e of out) e.name = e.name.slice(e.name.indexOf("/") + 1);
    }
    return out;
}

export const packOsk = (files, date = new Date()) => buildOsz(files.map((f) => ({ name: f.name.replace(/\\/g, "/"), data: f.data })), date);

// Every file name a skin.ini can load, lower case with "/" (each image value as all its candidates).
export function referencedNames(iniText) {
    const names = new Set();
    for (const line of parseSkinIni(iniText).lines) {
        const r = readLine(line.text);
        if (r.kind !== "pair" || !r.value.trim()) continue;
        for (const c of imageCandidates(r.value)) names.add(c.toLowerCase());
    }
    return names;
}

// Which files of the working copy go into an export: all of the skin's own, and of the builder's folder only
// those skin.ini points at (earlier builds stay behind for undo, not in the .osk).
export function exportedFiles(relativeNames, iniText, ownDir = "lunacy") {
    const used = referencedNames(iniText);
    const prefix = `${ownDir.toLowerCase()}/`;
    return relativeNames.filter((name) => {
        const n = name.replace(/\\/g, "/");
        return !n.toLowerCase().startsWith(prefix) || used.has(n.toLowerCase());
    });
}
