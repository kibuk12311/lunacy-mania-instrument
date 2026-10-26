// Interlude's library, read only. Interlude (github.com/YAVSRG/YAVSRG) is portable: Interlude.exe, Songs\ and Data\
// sit in one folder (Program.fs sets the exe's folder as the working directory, get_game_folder names folders in it).
//   Songs\charts.db  — SQLite, table charts (prelude/src/Data/ChartDatabase/DbCharts.fs): Id = the chart's hash,
//                      metadata columns, Keys, Origin (JSON list, an osu! origin has the .osu's Md5, BeatmapId,
//                      BeatmapSetId), Audio/Background (JSON AssetLocation: {"Hash": h} = Songs\.assets\h[0..1]\h,
//                      {"Absolute": path}, "Missing", "Deleted") and Chart (the binary chart, src/interlude/chart.js).
//   Songs\.origins\  — the file a chart was imported from, as <hh>\<hash>.osu (ChartDatabase.Import, store_original).
//   Data\scores.db   — SQLite, table scores (prelude/src/Data/UserDatabase/DbScores.fs): ChartId, Timestamp (unix ms),
//                      Rate, IsFailed.
// Both databases are in WAL mode (Percyqaz.Data Sqlite.init) and Interlude may have them open, so they are never
// opened where they are: each is copied (with its -wal) into the app's own cache folder when it changed, and the copy
// is read. Nothing in Interlude's folder is ever written.
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { decodeChart, chartToOsu, osuChartHash } from "../src/interlude/chart.js";

export const CHARTS_DB = path.join("Songs", "charts.db");
export const SCORES_DB = path.join("Data", "scores.db");
export const COLLECTIONS_JSON = path.join("Data", "collections.json");
const SEARCH_LIMIT = 60;

const statOf = (file) => stat(file).catch(() => null);
const parseJson = (text, fallback) => {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
};

// What the user picked (the folder, Interlude.exe, or its Songs / Data folder) → Interlude's folder, or null when
// there is no Songs\charts.db there.
export async function interludeFolderOf(picked) {
    if (typeof picked !== "string" || !picked.trim() || !path.isAbsolute(picked)) return null;
    let dir = path.resolve(picked);
    const s = await statOf(dir);
    if (s?.isFile()) dir = path.dirname(dir);
    const tries = [dir];
    if (/^(songs|data)$/i.test(path.basename(dir))) tries.unshift(path.dirname(dir));
    for (const d of tries) if ((await statOf(path.join(d, CHARTS_DB)))?.isFile()) return d;
    return null;
}

// Common places a portable Interlude is unzipped to; the first that holds a library wins.
export function folderCandidates({ home = "", env = {} } = {}) {
    const roots = [
        home && path.join(home, "Desktop"), home && path.join(home, "Downloads"), home && path.join(home, "Documents"),
        home && path.join(home, "Games"), home, env.LOCALAPPDATA, env.APPDATA, "C:\\Games", "D:\\Games", "C:\\", "D:\\",
    ].filter(Boolean);
    const out = [];
    for (const root of roots) for (const name of ["Interlude", "interlude", "YAVSRG\\Interlude"]) out.push(path.join(root, name));
    return [...new Set(out)];
}

export async function detectFolder(candidates) {
    for (const dir of candidates) {
        const found = await interludeFolderOf(dir);
        if (found) return found;
    }
    return null;
}

// AssetLocation as stored → an absolute path, or null.
export function assetPath(folder, location) {
    const loc = typeof location === "string" ? parseJson(location, location) : location;
    if (loc && typeof loc === "object") {
        if (typeof loc.Hash === "string" && /^[0-9A-Fa-f]{2,}$/.test(loc.Hash)) {
            return path.join(folder, "Songs", ".assets", loc.Hash.slice(0, 2), loc.Hash);
        }
        if (typeof loc.Absolute === "string" && path.isAbsolute(loc.Absolute)) return loc.Absolute;
    }
    return null;
}

// The osu! origins of a chart (its Origin column) → [{ md5, beatmapId, beatmapsetId, rate, od }].
export function osuOrigins(text) {
    const list = parseJson(text, []);
    if (!Array.isArray(list)) return [];
    return list.map((o) => o?.Osu).filter((o) => o && typeof o === "object").map((o) => ({
        md5: typeof o.Md5 === "string" ? o.Md5.toLowerCase() : null,
        beatmapId: Number.isSafeInteger(o.BeatmapId) && o.BeatmapId > 0 ? o.BeatmapId : null,
        beatmapsetId: Number.isSafeInteger(o.BeatmapSetId) && o.BeatmapSetId > 0 ? o.BeatmapSetId : null,
        rate: Number(o.SourceRate ?? 1),
        od: Number.isFinite(o.SourceOD) ? o.SourceOD : null,
    }));
}

// The audio format from a file's first bytes (Interlude's assets have no extension).
export function audioExt(head) {
    const b = Buffer.from(head ?? []);
    if (b.subarray(0, 4).toString("latin1") === "OggS") return ".ogg";
    if (b.subarray(0, 4).toString("latin1") === "RIFF") return ".wav";
    if (b.subarray(0, 4).toString("latin1") === "fLaC") return ".flac";
    if (b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ".mp3";
    return ".mp3";
}
export function imageExt(head) {
    const b = Buffer.from(head ?? []);
    if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return ".png";
    if (b[0] === 0xff && b[1] === 0xd8) return ".jpg";
    return ".png";
}

const lower = (s) => String(s ?? "").toLowerCase();
const words = (q) => lower(q).split(/\s+/).filter(Boolean);

// folder() → Interlude's folder or null; cacheDir: where the copies of its databases go (the app's userData).
// sqlite() → the node:sqlite module (injected by tests or imported on first use).
export function createInterludeLibrary({ folder, cacheDir, log = () => {}, sqlite = () => import("node:sqlite") }) {
    const copies = new Map(); // which db → { key, file } of the copy made last
    let index = null; // { key, folder, byHash, list, byMd5, byBeatmap }

    // A database copied out when it changed (its size and time, and its -wal's) → the copy's path.
    async function snapshot(name, rel) {
        const dir = folder();
        if (!dir) throw new Error("no Interlude folder");
        const src = path.join(dir, rel);
        const [db, wal] = await Promise.all([statOf(src), statOf(`${src}-wal`)]);
        if (!db?.isFile()) throw Object.assign(new Error(`${rel} not found`), { code: "NO_DB" });
        const key = `${src}|${db.size}|${db.mtimeMs}|${wal?.size ?? -1}|${wal?.mtimeMs ?? -1}`;
        const known = copies.get(name);
        if (known?.key === key) return { file: known.file, key };
        const out = path.join(cacheDir, `${name}.db`);
        await mkdir(cacheDir, { recursive: true });
        await rm(`${out}-shm`, { force: true });
        await rm(`${out}-wal`, { force: true });
        await copyFile(src, out);
        if (wal?.isFile()) await copyFile(`${src}-wal`, `${out}-wal`);
        copies.set(name, { key, file: out });
        log(`interlude: ${rel} copied (${Math.round(db.size / 1024)} KB${wal ? ` + wal ${Math.round(wal.size / 1024)} KB` : ""})`);
        return { file: out, key };
    }

    // One reader of the copies at a time: two asks at once must not copy over a file the other one reads.
    let queue = Promise.resolve();
    const serial = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    };

    // fn(db) on a copy of a database; one more copy is made if the first was caught half-written.
    const withDb = (name, rel, fn) => serial(() => readCopy(name, rel, fn));
    async function readCopy(name, rel, fn) {
        const { DatabaseSync } = await sqlite();
        for (let attempt = 1; ; attempt += 1) {
            const { file, key } = await snapshot(name, rel);
            let db = null;
            try {
                db = new DatabaseSync(file);
                return { value: fn(db), key };
            } catch (error) {
                copies.delete(name);
                if (attempt >= 2 || !/malformed|not a database|locked|busy/i.test(String(error?.message))) throw error;
            } finally {
                try {
                    db?.close();
                } catch {
                    // already closed
                }
            }
        }
    }

    async function load() {
        const dir = folder();
        const { value, key } = await withDb("charts", CHARTS_DB, (db) => {
            if (index && index.key === copies.get("charts")?.key && index.folder === dir) return null;
            return db.prepare(`SELECT Id, Title, TitleNative, Artist, ArtistNative, DifficultyName, Creator, Source, Tags,
                Keys, Length, BPM, Rating, Origin, Packs, Audio, Background, PreviewTime, DateAdded FROM charts`).all();
        });
        if (value === null) return index;
        const byHash = new Map();
        const byMd5 = new Map();
        const byBeatmap = new Map();
        for (const row of value) {
            const origins = osuOrigins(row.Origin);
            const meta = {
                hash: String(row.Id), title: String(row.Title ?? ""), titleNative: row.TitleNative ?? null,
                artist: String(row.Artist ?? ""), artistNative: row.ArtistNative ?? null, version: String(row.DifficultyName ?? ""),
                creator: String(row.Creator ?? ""), source: row.Source ?? null, tags: parseJson(row.Tags, []),
                keys: Number(row.Keys), lengthMs: Number(row.Length), bpm: Number(row.BPM), rating: Number(row.Rating),
                packs: parseJson(row.Packs, []), audio: row.Audio, background: row.Background,
                previewTime: Number(row.PreviewTime), added: Number(row.DateAdded), origins,
            };
            meta.search = lower([meta.artist, meta.title, meta.version, meta.creator, meta.artistNative, meta.titleNative,
                ...(Array.isArray(meta.packs) ? meta.packs : [])].filter(Boolean).join(" "));
            byHash.set(meta.hash, meta);
            for (const o of origins) {
                if (o.md5 && !byMd5.has(o.md5)) byMd5.set(o.md5, meta.hash);
                // a chart imported from the map itself (not a rate of it) stands for its beatmap id
                if (o.beatmapId && (Math.abs(o.rate - 1) < 1e-6 || !byBeatmap.has(o.beatmapId))) byBeatmap.set(o.beatmapId, meta.hash);
            }
        }
        index = { key, folder: dir, byHash, byMd5, byBeatmap, list: [...byHash.values()].sort((a, b) => b.added - a.added) };
        log(`interlude: library of ${byHash.size} charts`);
        return index;
    }

    const brief = (m) => ({
        hash: m.hash, title: m.title, artist: m.artist, version: m.version, creator: m.creator, keys: m.keys,
        lengthMs: m.lengthMs, bpm: m.bpm, rating: Number.isFinite(m.rating) ? Math.round(m.rating * 100) / 100 : null,
        beatmapId: m.origins.find((o) => o.beatmapId)?.beatmapId ?? null,
    });

    // Charts whose artist, title, difficulty name, creator or pack hold every word of the query, newest first;
    // keys: only charts of that key count (null: any).
    async function search(query, { keys = 4, limit = SEARCH_LIMIT } = {}) {
        const { list } = await load();
        const want = words(query);
        const out = [];
        let total = 0;
        for (const m of list) {
            if (keys && m.keys !== keys) continue;
            if (want.length && !want.every((w) => m.search.includes(w))) continue;
            total += 1;
            if (out.length < limit) out.push(brief(m));
        }
        return { items: out, total, size: list.length };
    }

    // Every chart of a key count (null: any), with its osu! origins, newest first: the session page's library.
    async function list({ keys = 4 } = {}) {
        const idx = await load();
        return idx.list.filter((m) => !keys || m.keys === keys).map((m) => ({ ...brief(m), origins: m.origins }));
    }

    // The binary chart of a hash, decoded.
    async function chart(hash) {
        const { value } = await withDb("charts", CHARTS_DB, (db) => db.prepare("SELECT Keys, Chart FROM charts WHERE Id = ?").get(String(hash)));
        if (!value) return null;
        return decodeChart(Buffer.from(value.Chart), Number(value.Keys));
    }

    // A chart as an .osu to analyse and to make copies of: the .osu it was imported from when Interlude kept it and
    // it is still this chart (its hash matches), else one made from the chart. With the audio and background files
    // it needs and the names the .osu gives them.
    async function osuFor(hash) {
        const { byHash } = await load();
        const meta = byHash.get(String(hash));
        if (!meta) return null;
        const dir = folder();
        const audio = assetPath(dir, meta.audio);
        const background = assetPath(dir, meta.background);
        const head = async (file, n = 16) => (file ? readFile(file).then((b) => b.subarray(0, n)).catch(() => null) : null);
        const original = path.join(dir, "Songs", ".origins", meta.hash.slice(0, 2), `${meta.hash}.osu`);
        const originalText = await readFile(original, "utf8").catch(() => null);
        if (originalText && osuChartHash(originalText) === meta.hash) {
            const audioName = /^AudioFilename\s*:\s*(.+)$/m.exec(originalText)?.[1]?.trim() || null;
            const bgName = /^0\s*,\s*0\s*,\s*"?([^",\r\n]+)"?/m.exec(originalText)?.[1]?.trim() || null;
            return { meta, text: originalText, original: true, audio, audioName, background, backgroundName: bgName };
        }
        const decoded = await chart(meta.hash);
        if (!decoded) return null;
        const audioHead = await head(audio);
        const audioName = audio ? (path.extname(audio) ? path.basename(audio) : `audio${audioExt(audioHead)}`) : null;
        const bgHead = await head(background);
        const backgroundName = background ? (path.extname(background) ? path.basename(background) : `bg${imageExt(bgHead)}`) : null;
        const od = meta.origins.find((o) => o.od !== null)?.od ?? null;
        const text = chartToOsu(decoded, {
            title: meta.title, titleNative: meta.titleNative, artist: meta.artist, artistNative: meta.artistNative,
            creator: meta.creator, version: meta.version, source: meta.source, tags: meta.tags, previewTime: meta.previewTime,
            audio: audioName, background: backgroundName, od,
        });
        return { meta, text, original: false, audio, audioName, background, backgroundName };
    }

    // The charts played in Interlude: Map hash → { at, rate, plays } (the last play's time in ms and rate).
    async function played() {
        const { value } = await withDb("scores", SCORES_DB, (db) => db.prepare(
            "SELECT ChartId, MAX(Timestamp) AS At, COUNT(*) AS Plays FROM scores GROUP BY ChartId").all());
        const out = new Map();
        for (const r of value) out.set(String(r.ChartId), { at: Number(r.At), plays: Number(r.Plays) });
        return out;
    }

    // osu! beatmap id → { beatmapsetId, accuracy: null, rate: null, playedAt } for every chart played in Interlude
    // that came from osu! (the shape the picks use for their played maps).
    async function playedBeatmaps() {
        const [plays, { byHash }] = await Promise.all([played(), load()]);
        const out = new Map();
        for (const [hash, p] of plays) {
            const meta = byHash.get(hash);
            for (const o of meta?.origins ?? []) {
                if (o.beatmapId) out.set(o.beatmapId, { beatmapsetId: o.beatmapsetId, accuracy: null, rate: null, playedAt: p.at, interlude: true });
            }
        }
        return out;
    }

    // The library's chart for a map we have: its osu! md5, its beatmap id, or the hash Interlude would give the
    // .osu text. → hash or null
    async function find({ md5 = null, beatmapId = null, osuText = null } = {}) {
        const idx = await load();
        if (md5 && idx.byMd5.has(lower(md5))) return idx.byMd5.get(lower(md5));
        if (osuText) {
            const own = osuChartHash(osuText);
            if (own && idx.byHash.has(own)) return own;
        }
        if (beatmapId && idx.byBeatmap.has(beatmapId)) return idx.byBeatmap.get(beatmapId);
        return null;
    }

    return {
        search, list, chart, osuFor, played, playedBeatmaps, find,
        meta: async (hash) => (await load()).byHash.get(String(hash)) ?? null,
        size: async () => (await load()).byHash.size,
        forget() {
            index = null;
            copies.clear();
        },
    };
}
