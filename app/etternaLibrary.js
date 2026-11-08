// The 4K charts of an Etterna install, for the Etterna block in ⚙ Settings (app/etternaClient.js). Read only, as Etterna
// 0.75 lays its folder out (its Windows install is portable: Songs, Save and Cache beside Program\Etterna.exe):
//   - charts: every .sm / .ssc under Songs\, AdditionalSongs\ and the folders Save\Preferences.ini names in
//     AdditionalSongFolders; Songs\<pack>\<song>\ or a song straight in Songs\; a song with both files is read from its
//     .ssc, as Etterna does. Each dance-single chart becomes the .osu text the analyzer takes (src/etterna/simfile.js,
//     StepMania's own timing); a chart it cannot convert (warps, fakes…) stays listed with its reason;
//   - MSD and chart key: from Cache\cache.db (Etterna's own numbers for this install), always read from a copy in the
//     app's cache folder so a running game is never touched; matched by step file and order among the file's
//     dance-single charts. No cache, another version of it or a copy that fails leaves them empty, the charts stay;
//   - the index: what each file gave, by size and modified time, kept in the cache folder, so a start reads only the
//     files that changed. Chart text is not kept: chart(id) converts its file again when it is asked for.
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { convertSimfile, decodeSimfile } from "../src/etterna/simfile.js";

export const CACHE_DB_VERSION = 248;
const INDEX_VERSION = 1;
const INDEX_FILE = "etterna-index.json";
const CACHE_COPY = "etterna-cache.db";
const SIMFILE = /\.(sm|ssc)$/i;
const YIELD_EVERY = 50;
// MSD in cache.db: 14 rates, 0.7x to 2.0x by 0.1, each Overall, Stream, Jumpstream, Handstream, Stamina, JackSpeed,
// Chordjack, Technical
const MSD_RATES = 14;
const MSD_VALUES = 8;

const isDir = (dir) => {
    try {
        return statSync(dir).isDirectory();
    } catch {
        return false;
    }
};
const slash = (p) => p.split(path.sep).join("/");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// The install folder for a folder the user picked: the one with Songs\, picked as itself, its Songs or its Program.
// → the folder, or null
export function etternaFolderOf(dir) {
    if (typeof dir !== "string" || !dir) return null;
    const at = path.resolve(dir);
    if (isDir(path.join(at, "Songs"))) return at;
    if (/^(songs|program)$/i.test(path.basename(at)) && isDir(path.join(path.dirname(at), "Songs"))) return path.dirname(at);
    return null;
}

// where the installer puts Etterna by default, and where people usually keep it
export function etternaCandidates(env = process.env) {
    const list = ["C:\\Games\\Etterna", "C:\\Etterna"];
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) if (base) list.push(path.join(base, "Etterna"));
    return list;
}

// → the first candidate that is an Etterna folder, or null
export function detectEtterna({ candidates = etternaCandidates() } = {}) {
    for (const c of candidates) {
        const found = etternaFolderOf(c);
        if (found) return found;
    }
    return null;
}

// cache.db's MSD text → [14 rates][8 values], or null when it is not that
export function parseMsd(text) {
    if (typeof text !== "string" || !text) return null;
    const rates = text.split(":").map((r) => r.split(",").map(Number));
    if (rates.length !== MSD_RATES || rates.some((r) => r.length !== MSD_VALUES || r.some((v) => !Number.isFinite(v)))) return null;
    return rates;
}

// the Overall MSD at a rate: only the 0.1 steps cache.db has, else null
export function msdAt(msd, rate) {
    if (!msd || !Number.isFinite(rate)) return null;
    const i = Math.round((rate - 0.7) * 10);
    if (i < 0 || i >= MSD_RATES || Math.abs(0.7 + i / 10 - rate) > 1e-6) return null;
    return msd[i][0];
}

// AdditionalSongFolders from Save\Preferences.ini: absolute folders, "," or ";" between them
function additionalFolders(ini) {
    const line = /^\s*AdditionalSongFolders\s*=(.*)$/im.exec(ini ?? "")?.[1] ?? "";
    return line.split(/[,;]/).map((s) => s.trim()).filter((s) => s && path.isAbsolute(s));
}

// The song folders under one root: [{ dir, pack, root }]
async function songDirs(root) {
    const out = [];
    let tops = [];
    try {
        tops = await readdir(root, { withFileTypes: true });
    } catch {
        return out;
    }
    const simfilesIn = async (dir) => (await readdir(dir).catch(() => [])).filter((f) => SIMFILE.test(f));
    for (const top of tops) {
        if (!top.isDirectory()) continue;
        const dir = path.join(root, top.name);
        if ((await simfilesIn(dir)).length) {
            out.push({ dir, pack: "", root });
            continue;
        }
        for (const song of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (song.isDirectory()) out.push({ dir: path.join(dir, song.name), pack: top.name, root });
        }
    }
    return out;
}

// the one simfile Etterna reads in a song folder: its .ssc, else its .sm (first by name)
async function simfileOf(dir) {
    const files = (await readdir(dir).catch(() => [])).filter((f) => SIMFILE.test(f)).sort();
    const pick = files.find((f) => /\.ssc$/i.test(f)) ?? files.find((f) => /\.sm$/i.test(f));
    return pick ? path.join(dir, pick) : null;
}

// One simfile → its dance-single rows (without MSD / key)
function rowsOf(text, file, pack, fileKey) {
    const res = convertSimfile(text, { ext: path.extname(file).toLowerCase() });
    return res.charts.filter((c) => c.stepsType === "dance-single").map((c) => ({
        id: `${fileKey}|${c.index}`,
        file,
        fileKey,
        index: c.index,
        pack,
        title: c.title || res.song.title || path.basename(path.dirname(file)),
        artist: c.artist || res.song.artist || "",
        version: c.version || [c.difficulty, c.meter].filter(Boolean).join(" "),
        meter: Number.isFinite(Number(c.meter)) ? Number(c.meter) : null,
        notes: c.ok ? c.stats.notes : 0,
        lengthMs: c.ok ? Math.max(0, c.stats.lastMs - c.stats.firstMs) : 0,
        hash: c.ok ? c.hash : null,
        skip: c.ok ? null : String(c.reason ?? "?"),
    }));
}

// folder: the Etterna install; cacheDir: the app's folder for the index and the copy of cache.db;
// read(file) → bytes (tests count it); copy(from, to): how cache.db is copied; sqlite() → the node:sqlite module
export function createEtternaLibrary({ folder, cacheDir, log = () => {}, read = (file) => readFile(file), copy = copyFile, sqlite = () => import("node:sqlite") }) {
    let rows = [];
    const byId = new Map();

    async function loadIndex() {
        try {
            const data = JSON.parse(await readFile(path.join(cacheDir, INDEX_FILE), "utf8"));
            return data?.version === INDEX_VERSION && data.folder === folder ? data.files ?? {} : {};
        } catch {
            return {};
        }
    }

    // cache.db (from a copy) → Map of lower-cased step file → [{ msd, key }] of its dance-single steps in order
    async function readCache() {
        const steps = new Map();
        const from = path.join(folder, "Cache", "cache.db");
        const to = path.join(cacheDir, CACHE_COPY);
        try {
            await stat(from);
        } catch {
            return steps;
        }
        try {
            await copy(from, to);
            const { DatabaseSync } = await sqlite();
            const db = new DatabaseSync(to, { readOnly: true });
            try {
                const version = db.prepare("SELECT VERSION FROM dbinfo").get()?.VERSION;
                if (Number(version) !== CACHE_DB_VERSION) {
                    log(`etterna: cache.db version ${version}, not ${CACHE_DB_VERSION}: no MSD`);
                    return steps;
                }
                for (const s of db.prepare("SELECT STEPSTYPE, METER, MSD, CHARTKEY, STEPFILENAME FROM steps ORDER BY id").all()) {
                    if (String(s.STEPSTYPE).toLowerCase() !== "dance-single") continue;
                    const file = String(s.STEPFILENAME ?? "").toLowerCase();
                    if (!steps.has(file)) steps.set(file, []);
                    const key = /^X[0-9a-f]{40}$/i.test(String(s.CHARTKEY)) ? String(s.CHARTKEY) : null;
                    const meter = s.METER === null || s.METER === undefined ? null : Number(s.METER);
                    steps.get(file).push({ msd: parseMsd(s.MSD), key, meter: Number.isFinite(meter) ? meter : null });
                }
            } finally {
                db.close();
            }
        } catch (error) {
            log(`etterna: cache.db not read: ${error?.message ?? error}`);
            return new Map();
        }
        return steps;
    }

    // a simfile's key: "/"-separated from the install folder when inside it (as cache.db names it), else its full path
    const inside = (base, file) => {
        const rel = path.relative(base, file);
        return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
    };
    const fileKeyOf = (file) => {
        const rel = inside(folder, file);
        return rel !== null ? `/${slash(rel)}` : slash(file);
    };
    // the name cache.db gives it: Etterna mounts every AdditionalSongFolders entry at /AdditionalSongs
    const cacheKeyOf = (file, root, extra) => {
        const rel = extra ? inside(root, file) : null;
        return (rel !== null ? `/AdditionalSongs/${slash(rel)}` : fileKeyOf(file)).toLowerCase();
    };

    async function refresh({ onProgress = () => {} } = {}) {
        await mkdir(cacheDir, { recursive: true });
        const index = await loadIndex();
        const ini = await readFile(path.join(folder, "Save", "Preferences.ini"), "utf8").catch(() => "");
        const extras = new Set(additionalFolders(ini));
        const roots = [path.join(folder, "Songs"), path.join(folder, "AdditionalSongs"), ...extras];
        const songs = [];
        for (const root of roots) songs.push(...(await songDirs(root)));
        const files = {};
        const next = [];
        let done = 0;
        for (const { dir, pack, root } of songs) {
            const file = await simfileOf(dir);
            done += 1;
            if (done % YIELD_EVERY === 0) {
                onProgress({ done, total: songs.length });
                await nextTurn();
            }
            if (!file) continue;
            const st = await stat(file).catch(() => null);
            if (!st) continue;
            const fileKey = fileKeyOf(file);
            const known = index[file];
            let found = known && known.size === st.size && known.mtimeMs === st.mtimeMs ? known.rows : null;
            if (!found) {
                try {
                    found = rowsOf(decodeSimfile(await read(file)), file, pack, fileKey);
                } catch (error) {
                    // not remembered: a file locked for a moment is read on the next scan
                    log(`etterna: ${file} not read: ${error?.message ?? error}`);
                    continue;
                }
            }
            const cacheKey = cacheKeyOf(file, root, extras.has(root));
            found = found.map((r) => ({ ...r, cacheKey }));
            files[file] = { size: st.size, mtimeMs: st.mtimeMs, rows: found };
            next.push(...found);
        }
        onProgress({ done: songs.length, total: songs.length });
        const cache = await readCache();
        const order = new Map();
        rows = next.map((r) => {
            const n = order.get(r.fileKey) ?? 0;
            order.set(r.fileKey, n + 1);
            let hit = cache.get(r.cacheKey)?.[n] ?? null;
            // matched by order: a row whose meter is not the chart's belongs to another chart, so none rather than wrong
            if (hit && hit.meter !== null && r.meter !== null && hit.meter !== r.meter) hit = null;
            return { ...r, msd: hit?.msd ?? null, key: hit?.key ?? null };
        });
        byId.clear();
        for (const r of rows) byId.set(r.id, r);
        try {
            await writeFile(path.join(cacheDir, INDEX_FILE), JSON.stringify({ version: INDEX_VERSION, folder, files }));
        } catch (error) {
            log(`etterna: index not saved: ${error?.message ?? error}`);
        }
        const skipped = rows.filter((r) => r.skip).length;
        log(`etterna: ${rows.length} charts in ${songs.length} song folders (${skipped} not convertible)`);
        return { charts: rows.length, skipped, songs: songs.length };
    }

    const sortKey = (r) => `${r.pack}\u0000${r.title}\u0000${r.version}`.toLowerCase();
    function search(query, { limit = 200 } = {}) {
        const q = String(query ?? "").trim().toLowerCase();
        const ranked = [];
        for (const r of rows) {
            if (!q) {
                ranked.push({ r, rank: 0 });
                continue;
            }
            const rank = [r.title, r.artist, r.pack, r.version].findIndex((f) => String(f ?? "").toLowerCase().includes(q));
            if (rank !== -1) ranked.push({ r, rank });
        }
        ranked.sort((a, b) => a.rank - b.rank || (sortKey(a.r) < sortKey(b.r) ? -1 : sortKey(a.r) > sortKey(b.r) ? 1 : 0));
        return ranked.slice(0, limit).map((x) => x.r);
    }

    // → { id, osu (null when not convertible), label } of one listed chart, or null
    async function chart(id) {
        const r = byId.get(id);
        if (!r) return null;
        const label = `${r.artist} - ${r.title} [${r.version}]`;
        if (r.skip) return { id, osu: null, label };
        const res = convertSimfile(decodeSimfile(await read(r.file)), { ext: path.extname(r.file).toLowerCase() });
        const c = res.charts.find((x) => x.index === r.index);
        return { id, osu: c?.ok ? c.osu : null, label };
    }

    return { refresh, search, chart, size: () => rows.length, row: (id) => byId.get(id) ?? null };
}
