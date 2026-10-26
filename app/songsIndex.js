// The local osu! Songs folder, read only: which set folders it has (by the id at the start of the folder name,
// listed at most once every 5 minutes) and, for one set, the chart with a given BeatmapID. No .osu is read
// outside the set asked for, and nothing is ever written there.
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

const TTL_MS = 5 * 60_000;

// songsDir: async () → the Songs folder or null (osu! closed).
export function createSongsIndex({ songsDir, readdir = fsReaddir, readFile = fsReadFile, now = Date.now, ttlMs = TTL_MS }) {
    let listing = null; // { dir, at, sets: Map setId → folder names }

    async function sets() {
        let dir = null;
        try {
            dir = await songsDir();
        } catch {
            return null;
        }
        if (typeof dir !== "string" || !dir) return null;
        if (listing && listing.dir === dir && now() - listing.at < ttlMs) return listing;
        let names;
        try {
            names = await readdir(dir);
        } catch {
            return null;
        }
        const bySet = new Map();
        for (const name of names) {
            const m = /^(\d+) /.exec(String(name));
            if (!m) continue;
            const id = Number(m[1]);
            if (!bySet.has(id)) bySet.set(id, []);
            bySet.get(id).push(String(name));
        }
        listing = { dir, at: now(), sets: bySet };
        return listing;
    }

    // → { path, osuText } of the set's chart with that BeatmapID, or null
    async function find(setId, beatmapId) {
        const id = Number(setId);
        const wanted = Number(beatmapId);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(wanted) || wanted <= 0) return null;
        const known = await sets();
        for (const folder of known?.sets.get(id) ?? []) {
            const full = path.join(known.dir, folder);
            let files;
            try {
                files = await readdir(full);
            } catch {
                continue;
            }
            for (const file of files.map(String).filter((f) => f.toLowerCase().endsWith(".osu"))) {
                try {
                    const osuText = await readFile(path.join(full, file), "utf8");
                    if (Number(/^BeatmapID\s*:\s*(\d+)/m.exec(osuText)?.[1]) === wanted) return { path: path.join(full, file), osuText };
                } catch {
                    // an unreadable chart is just not this one
                }
            }
        }
        return null;
    }

    return { find };
}
