// Saves a generated map as "<title> [<version>].osz" next to its audio, never overwriting an earlier one.
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { buildOsz } from "../src/gen/osz.js";

export function safeFileName(name) {
    return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "") || "map";
}

const exists = (p) => access(p).then(() => true, () => false);

export const audioNameFor = (audioPath) => `audio${path.extname(audioPath).toLowerCase() || ".mp3"}`;

export async function saveGeneratedMap({ dir, audioPath, title, version, osuText }) {
    await mkdir(dir, { recursive: true });
    const base = safeFileName(`${title} [${version}]`);
    let target = path.join(dir, `${base}.osz`);
    for (let n = 2; await exists(target); n += 1) target = path.join(dir, `${base} (${n}).osz`);
    const osz = buildOsz([
        { name: `${base}.osu`, data: Buffer.from(osuText, "utf8") },
        { name: audioNameFor(audioPath), data: await readFile(audioPath) },
    ]);
    await writeFile(target, osz);
    return target;
}
