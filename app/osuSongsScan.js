// osu! stable's Songs folder → which .osu has which md5 (the key scores.db names a map by), read only.
// Only 4K osu!mania charts are kept. The index lives in the app's own userData (songs-md5.json) and is saved every
// SAVE_EVERY folders, so a scan stopped halfway (cancel, the app closed) goes on where it stopped; a set folder is
// read again only when its modification time changed. Nothing in the Songs folder is ever written.
import * as nodeFs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const INDEX_VERSION = 1;
const SAVE_EVERY = 200;

const line = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, "m").exec(text)?.[1] ?? "";

// One .osu file's bytes → { md5, beatmapId, beatmapsetId, artist, title, version } for a 4K mania chart, else null.
export function chartEntry(bytes) {
    const buf = Buffer.from(bytes);
    const head = buf.subarray(0, 8192).toString("utf8");
    if (Number(line(head, "Mode")) !== 3 || Number(line(head, "CircleSize")) !== 4) return null;
    const id = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
    return {
        md5: createHash("md5").update(buf).digest("hex"),
        beatmapId: id(line(head, "BeatmapID")),
        beatmapsetId: id(line(head, "BeatmapSetID")),
        artist: line(head, "Artist"),
        title: line(head, "Title"),
        version: line(head, "Version"),
    };
}

export function createSongsMd5Index({ indexFile, fs = nodeFs }) {
    let index = null; // { v, dir, folders: { name: { mtimeMs, charts: [{ file, ...entry }] } } }

    async function load(dir) {
        if (index?.dir === dir) return index;
        try {
            const saved = JSON.parse(await fs.readFile(indexFile, "utf8"));
            index = saved?.v === INDEX_VERSION && saved.dir === dir && saved.folders && typeof saved.folders === "object"
                ? saved : { v: INDEX_VERSION, dir, folders: {} };
        } catch {
            index = { v: INDEX_VERSION, dir, folders: {} };
        }
        return index;
    }

    async function save() {
        await fs.mkdir(path.dirname(indexFile), { recursive: true });
        await fs.writeFile(`${indexFile}.tmp`, JSON.stringify(index), "utf8");
        await fs.rename(`${indexFile}.tmp`, indexFile);
    }

    // Scans songsDir (only what changed) → Map md5 → { path, beatmapId, beatmapsetId, artist, title, version }.
    // onProgress({ done, total }) per folder; isCancelled() stops between folders (what was read is kept).
    async function scan(songsDir, { onProgress = () => {}, isCancelled = () => false } = {}) {
        const dir = path.resolve(songsDir);
        await load(dir);
        const names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        const present = new Set(names);
        for (const name of Object.keys(index.folders)) if (!present.has(name)) delete index.folders[name];
        let changed = 0;
        let cancelled = false;
        for (const [i, name] of names.entries()) {
            if (isCancelled()) {
                cancelled = true;
                break;
            }
            const full = path.join(dir, name);
            const st = await fs.stat(full).catch(() => null);
            const known = index.folders[name];
            if (st && known && known.mtimeMs === st.mtimeMs) {
                if (i % 50 === 0) onProgress({ done: i, total: names.length });
                continue;
            }
            const charts = [];
            const files = await fs.readdir(full).catch(() => []);
            for (const file of files.map(String).filter((f) => f.toLowerCase().endsWith(".osu"))) {
                try {
                    const entry = chartEntry(await fs.readFile(path.join(full, file)));
                    if (entry) charts.push({ file, ...entry });
                } catch {
                    // an unreadable chart is skipped
                }
            }
            index.folders[name] = { mtimeMs: st?.mtimeMs ?? 0, charts };
            changed += 1;
            if (changed % SAVE_EVERY === 0) await save().catch(() => {});
            onProgress({ done: i + 1, total: names.length });
        }
        if (changed || cancelled) await save().catch(() => {});
        onProgress({ done: cancelled ? Object.keys(index.folders).length : names.length, total: names.length });
        const out = new Map();
        for (const [name, folder] of Object.entries(index.folders)) {
            for (const c of folder.charts ?? []) {
                if (!out.has(c.md5)) {
                    out.set(c.md5, {
                        path: path.join(dir, name, c.file), beatmapId: c.beatmapId ?? null, beatmapsetId: c.beatmapsetId ?? null,
                        artist: c.artist ?? "", title: c.title ?? "", version: c.version ?? "",
                    });
                }
            }
        }
        return { charts: out, cancelled, folders: names.length };
    }

    return { scan };
}
