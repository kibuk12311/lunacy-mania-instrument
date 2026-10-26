// Reading a downloaded .osz (a zip): the central directory, stored and deflated entries, and copying one
// difficulty with its audio and background into a folder of the app's own. Names come from a download, so
// every one goes through safeEntryPath before it touches the disk.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { t } from "../i18n/i18n.js";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

const damaged = () => new Error(t("marathon.err.badZip"));

// [{ name, method, size, read() → Buffer }] of a zip in memory; throws on anything that is not a readable zip.
export function readZip(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    const from = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let p = buf.length - 22; p >= from; p -= 1) {
        if (buf.readUInt32LE(p) === EOCD) {
            eocd = p;
            break;
        }
    }
    if (eocd < 0) throw damaged();
    const count = buf.readUInt16LE(eocd + 10);
    const size = buf.readUInt32LE(eocd + 12);
    const declared = buf.readUInt32LE(eocd + 16);
    // Some packers write a wrong directory offset (data glued in front); the directory always ends at the EOCD,
    // so its real start comes from its size, and every local header moves by the same amount.
    const okAt = (p) => p >= 0 && p + 4 <= buf.length && buf.readUInt32LE(p) === CENTRAL;
    const shift = okAt(declared) ? 0 : eocd - size - declared;
    let p = declared + shift;
    const entries = [];
    for (let i = 0; i < count; i += 1) {
        if (!okAt(p) || p + 46 > buf.length) throw damaged();
        const method = buf.readUInt16LE(p + 10);
        const packed = buf.readUInt32LE(p + 20);
        const unpacked = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42) + shift;
        // UTF-8 whether or not flag bit 11 says so: that is what .osz packers write
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
        p += 46 + nameLen + extraLen + commentLen;
        entries.push({
            name, method, size: unpacked,
            read() {
                if (local < 0 || local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw damaged();
                const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
                if (start + packed > buf.length || unpacked > MAX_ENTRY_BYTES) throw damaged();
                const raw = buf.subarray(start, start + packed);
                if (method === 0) return Buffer.from(raw);
                if (method === 8) {
                    try {
                        return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
                    } catch {
                        throw damaged();
                    }
                }
                throw damaged();
            },
        });
    }
    return entries;
}

// A zip entry's name as a safe relative path ("sub/file.png"), or null: absolute, drive letters, "..", NUL, empty.
export function safeEntryPath(name) {
    if (typeof name !== "string" || !name || name.includes("\u0000")) return null;
    if (/^[\\/]/.test(name)) return null;
    const parts = name.split(/[\\/]+/).filter((s) => s && s !== ".");
    if (!parts.length || parts.some((s) => s === ".." || s.includes(":"))) return null;
    return parts.join("/");
}

const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const backgroundOf = (osuText) => /^0,0,"([^"]+)"/m.exec(osuText)?.[1] ?? null;

// One difficulty of an .osz into outDir: <beatmapId>.osu, its audio and its background (if the set has it),
// under the names the chart uses. Found by BeatmapID:, else by "[version].osu" at the end of the file name.
// → { osuPath, osuText, audioPath, backgroundPath | null }
export async function extractChart(buffer, beatmapId, outDir, { version = null } = {}) {
    const entries = readZip(buffer);
    const byName = new Map();
    for (const e of entries) {
        const safe = safeEntryPath(e.name);
        if (safe && !byName.has(safe.toLowerCase())) byName.set(safe.toLowerCase(), { ...e, safe });
    }
    const charts = [...byName.values()].filter((e) => e.safe.toLowerCase().endsWith(".osu"));
    let chart = null;
    let osuText = null;
    for (const e of charts) {
        const text = e.read().toString("utf8");
        if (Number(field(text, "BeatmapID")) === Number(beatmapId) && Number(beatmapId) > 0) {
            chart = e;
            osuText = text;
            break;
        }
    }
    if (!chart && version) {
        const tail = `[${String(version).toLowerCase()}].osu`;
        chart = charts.find((e) => e.safe.toLowerCase().endsWith(tail)) ?? null;
        osuText = chart ? chart.read().toString("utf8") : null;
    }
    if (!chart) throw new Error(t("marathon.err.noChart"));

    // the chart's files are relative to its own folder in the set
    const folder = path.posix.dirname(chart.safe);
    const inSet = (name) => {
        const safe = name ? safeEntryPath(folder === "." ? name : `${folder}/${name}`) : null;
        return safe ? byName.get(safe.toLowerCase()) ?? null : null;
    };
    const audioName = field(osuText, "AudioFilename");
    const audio = safeEntryPath(audioName) ? inSet(audioName) : null;
    if (!audio) throw new Error(t("marathon.err.noAudio"));
    const bgName = backgroundOf(osuText);
    const background = bgName && safeEntryPath(bgName) ? inSet(bgName) : null;

    await mkdir(outDir, { recursive: true });
    const place = async (relative, data) => {
        const target = path.join(outDir, ...relative.split("/"));
        if (!path.resolve(target).startsWith(path.resolve(outDir) + path.sep)) throw new Error(t("marathon.err.noAudio"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data);
        return target;
    };
    const osuPath = await place(`${Number(beatmapId) > 0 ? Number(beatmapId) : "chart"}.osu`, Buffer.from(osuText, "utf8"));
    const audioPath = await place(safeEntryPath(audioName), audio.read());
    const backgroundPath = background ? await place(safeEntryPath(bgName), background.read()) : null;
    return { osuPath, osuText, audioPath, backgroundPath };
}
