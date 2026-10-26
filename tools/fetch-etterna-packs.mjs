// Extra training data for the 4K mapper: the big 4K packs from EtternaOnline, converted to osu!mania.
// Lists packs from the public API, keeps 4K-tagged ones with at least --min-songs songs, downloads each zip
// (Range resume), extracts only charts (.sm/.ssc) and audio with the streaming zip reader, converts every
// dance-single chart to an .osu next to its audio, writes a manifest per pack and deletes the zip.
// Output is outside osu! (never the Songs folder) and has the shape tools/build-mapper-dataset.mjs reads:
//   <outRoot>/songs/<packId> <song folder>/   audio + .sm/.ssc + one .osu per chart (AudioFilename = that audio)
//   <outRoot>/packs/<packId>.json             manifest: songs, charts converted/skipped with reasons, Etterna MSD
//   <outRoot>/state.jsonl                     one line per finished pack (re-runs skip ok/final ones)
//   <outRoot>/_zips/<packId>.zip(.part)       while downloading; removed after a successful extraction
// Downloads are untrusted data: nothing from them is executed, only chart text and audio are read.
// Usage: node tools/fetch-etterna-packs.mjs [outRoot=A:/SneezeyTrain/etterna] [--min-songs 100] [--limit N]
//        [--smallest-first] [--lanes 2] [--list] [--refresh-list]
import { mkdir, readdir, readFile, writeFile, appendFile, rename, rm, rmdir, stat, statfs } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openZip, safeEntryParts } from "./lib/zip.mjs";
import { convertSimfile, decodeSimfile, parseSimfile, osuFileName } from "./lib/sm2osu.mjs";

export const API_BASE = "https://api.etternaonline.com/api";
export const DOWNLOAD_HOSTS = ["downloads.etternaonline.com"];
const USER_AGENT = "dan-analyzer training-data fetcher (private use; 2-3 downloads at a time)";
const CHART_EXT = new Set([".sm", ".ssc"]);
const AUDIO_EXT = new Set([".mp3", ".ogg", ".opus", ".wav", ".flac"]);
const MAX_CHART_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 400 * 1024 * 1024;
const MAX_PACK_BYTES = 40 * 1024 * 1024 * 1024;
const NOT_A_ZIP_FINAL_BYTES = 1024 * 1024;
const CATALOG_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const PAUSE_MS = 2000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lower = (s) => String(s ?? "").toLowerCase();

// "609.6 MB" → bytes (the API gives sizes as text).
export function parseSize(text) {
    const m = /^\s*([\d.]+)\s*(B|KB|MB|GB|TB)?\s*$/i.exec(String(text ?? ""));
    if (!m) return null;
    const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[(m[2] ?? "B").toUpperCase()];
    return Math.round(Number(m[1]) * mult);
}

// The API's download link, URL-encoded per path segment ("#", "&", spaces are common in pack names),
// or null when it points anywhere but the expected download host.
export function packDownloadUrl(raw, hosts = DOWNLOAD_HOSTS) {
    const m = /^https:\/\/([^/?#]+)\/(.+)$/i.exec(String(raw ?? "").trim());
    if (!m || !hosts.includes(m[1].toLowerCase())) return null;
    const segments = m[2].split("/");
    if (segments.some((s) => s === ".." || s === ".")) return null;
    return `https://${m[1].toLowerCase()}/${segments.map((s) => encodeURIComponent(s)).join("/")}`;
}

// API packs → the ones to fetch: tagged 4k, song_count ≥ minSongs; API order, or smallest first.
export function selectPacks(apiPacks, { minSongs = 100, smallestFirst = false } = {}) {
    const out = [];
    for (const p of apiPacks ?? []) {
        const is4k = (p.tags ?? []).some((t) => t?.type === "keyCount" && lower(t.name) === "4k");
        if (!is4k || !(Number(p.song_count) >= minSongs) || !Number.isSafeInteger(p.id)) continue;
        out.push({
            id: p.id, name: String(p.name ?? p.id), songs: Number(p.song_count), bytes: parseSize(p.size),
            sizeText: p.size ?? null, download: p.download ?? null, overall: Number(p.overall) || null,
            skillsets: Object.fromEntries(["stream", "jumpstream", "handstream", "jacks", "chordjacks", "stamina", "technical"]
                .map((k) => [k, Number(p[k]) || null])),
            tags: (p.tags ?? []).map((t) => t?.name).filter(Boolean),
        });
    }
    if (smallestFirst) out.sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity) || a.id - b.id);
    return out;
}

export function retryAfterMs(headers, fallbackMs) {
    const v = headers?.get?.("retry-after");
    if (v) {
        const sec = Number(v);
        if (Number.isFinite(sec) && sec >= 0) return Math.min(30 * 60_000, sec * 1000);
        const at = Date.parse(v);
        if (Number.isFinite(at)) return Math.min(30 * 60_000, Math.max(0, at - Date.now()));
    }
    return fallbackMs;
}

// One API request at a time, at least gapMs apart (the API answered 429 to ~12 at once); 429/503 wait it out.
export function createApiClient({ fetchImpl = globalThis.fetch, base = API_BASE, gapMs = 1100, sleepImpl = sleep, logImpl = log } = {}) {
    let nextAt = 0;
    let chain = Promise.resolve();
    async function run(pathQuery) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const wait = nextAt - Date.now();
            if (wait > 0) await sleepImpl(wait);
            nextAt = Date.now() + gapMs;
            let res;
            try {
                res = await fetchImpl(base + pathQuery, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
            } catch (error) {
                logImpl(`API ${pathQuery}: ${error?.message ?? error}, retrying`);
                await sleepImpl(5000 * (attempt + 1));
                continue;
            }
            if (res.status === 429 || res.status === 503) {
                const ms = retryAfterMs(res.headers, 60_000);
                logImpl(`API asks us to wait ${Math.round(ms / 1000)} s`);
                nextAt = Date.now() + ms;
                continue;
            }
            if (!res.ok) throw new Error(`API ${res.status} for ${pathQuery}`);
            return res.json();
        }
        throw new Error(`API gave up on ${pathQuery}`);
    }
    function get(pathQuery) {
        const p = chain.then(() => run(pathQuery));
        chain = p.catch(() => {});
        return p;
    }
    // every page of a paginated list
    async function list(pathQuery, perPage = 2000) {
        const sep = pathQuery.includes("?") ? "&" : "?";
        const first = await get(`${pathQuery}${sep}limit=${perPage}`);
        const items = [...(first?.data ?? [])];
        const last = Number(first?.meta?.last_page) || 1;
        for (let page = 2; page <= last; page += 1) {
            const more = await get(`${pathQuery}${sep}limit=${perPage}&page=${page}`);
            items.push(...(more?.data ?? []));
        }
        return items;
    }
    return { get, list };
}

const finalError = (message) => Object.assign(new Error(message), { final: true });

// url → dest, resuming dest.part with Range when the host allows it; restarts when it answers 200 instead.
// Waits out 429/503 (Retry-After), gives up for good on 403/404/410, checks the length and that it is a zip.
export async function downloadResumable(url, dest, {
    fetchImpl = globalThis.fetch, sleepImpl = sleep, logImpl = log, hosts = DOWNLOAD_HOSTS, maxBytes = MAX_PACK_BYTES,
    idleMs = 60_000, retries = 8, label = path.basename(dest),
} = {}) {
    const part = `${dest}.part`;
    await mkdir(path.dirname(dest), { recursive: true });
    const hostOk = (u) => {
        try {
            const h = new URL(u).hostname.toLowerCase();
            return hosts.includes(h) || h.endsWith(".etternaonline.com");
        } catch {
            return false;
        }
    };
    if (!hostOk(url)) throw finalError(`unexpected download host in ${url}`);
    let resumedFrom = 0;
    let failures = 0;
    let waits = 0;
    while (failures <= retries) {
        const have = (await stat(part).catch(() => null))?.size ?? 0;
        const controller = new AbortController();
        let idle = setTimeout(() => controller.abort(), idleMs);
        const alive = () => {
            clearTimeout(idle);
            idle = setTimeout(() => controller.abort(), idleMs);
        };
        try {
            const headers = { "user-agent": USER_AGENT };
            if (have > 0) headers.range = `bytes=${have}-`;
            const res = await fetchImpl(url, { headers, redirect: "follow", signal: controller.signal });
            if (res.url && !hostOk(res.url)) throw finalError(`redirected to an unexpected host: ${res.url}`);
            if (res.status === 429 || res.status === 503) {
                const ms = retryAfterMs(res.headers, 5 * 60_000);
                logImpl(`${label}: host asks us to wait ${Math.round(ms / 1000)} s`);
                await res.body?.cancel().catch(() => {});
                clearTimeout(idle);
                if (++waits > 20) throw new Error("host kept refusing (429/503)");
                await sleepImpl(ms);
                continue;
            }
            if (res.status === 416 && have > 0) {
                await res.body?.cancel().catch(() => {});
                const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1]);
                if (total === have) break; // the part file is already complete
                await rm(part, { force: true });
                throw new Error(`range not satisfiable at ${have}, restarting`);
            }
            if ([403, 404, 410].includes(res.status)) throw finalError(`HTTP ${res.status}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            let start = 0;
            let total = null;
            if (res.status === 206) {
                const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers.get("content-range") ?? "");
                if (!cr || Number(cr[1]) !== have) {
                    await res.body?.cancel().catch(() => {});
                    await rm(part, { force: true });
                    throw new Error("host answered a different range, restarting");
                }
                start = have;
                total = cr[3] === "*" ? null : Number(cr[3]);
                resumedFrom = have;
            } else {
                const len = Number(res.headers.get("content-length"));
                total = Number.isFinite(len) && len > 0 ? len : null;
                if (have > 0) logImpl(`${label}: host ignored the range, starting over`);
            }
            if (total !== null && total > maxBytes) throw finalError(`${total} bytes is over the ${maxBytes} byte cap`);
            let received = 0;
            let lastLog = Date.now();
            const counter = new Transform({
                transform(chunk, _e, done) {
                    alive();
                    received += chunk.length;
                    if (start + received > maxBytes) return done(finalError("download is over the size cap"));
                    if (Date.now() - lastLog > 60_000) {
                        lastLog = Date.now();
                        logImpl(`${label}: ${((start + received) / 1e9).toFixed(2)}${total ? ` / ${(total / 1e9).toFixed(2)}` : ""} GB`);
                    }
                    done(null, chunk);
                },
            });
            await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part, { flags: start > 0 ? "a" : "w" }));
            const size = (await stat(part)).size;
            if (total !== null && size !== total) throw new Error(`got ${size} of ${total} bytes`);
            break;
        } catch (error) {
            if (error?.final) throw error;
            failures += 1;
            const why = error?.name === "AbortError" ? "no data for a while" : error?.message ?? String(error);
            if (failures > retries) throw new Error(`${label}: gave up after ${retries} retries (${why})`);
            logImpl(`${label}: ${why}; retry ${failures}/${retries}`);
            await sleepImpl(Math.min(120_000, 5000 * failures));
        } finally {
            clearTimeout(idle);
        }
    }
    // whatever the zip reader opens is a zip (also one with data glued in front); anything else is thrown away
    try {
        await (await openZip(part)).close();
    } catch (error) {
        const bytes = (await stat(part)).size;
        await rm(part, { force: true });
        const message = `the download is not a zip (${bytes} bytes: ${error.message})`;
        // a short body is most likely an error page and worth another try on a later run; megabytes that are
        // no zip will be no zip next time either
        throw bytes > NOT_A_ZIP_FINAL_BYTES ? finalError(message) : new Error(message);
    }
    await rename(part, dest);
    return { file: dest, bytes: (await stat(dest)).size, resumedFrom };
}

// ---- turning one pack zip into song folders ---------------------------------------------------------------

const normKey = (s) => lower(s).normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
const safeName = (s, max = 80) => String(s ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim()
    .slice(0, max).replace(/[. ]+$/, "");
const MAX_PATH_CHARS = 240; // osu!, ffmpeg and Python on Windows still trip over paths past 260

// name, shortened (extension kept) so that dir/name stays within MAX_PATH_CHARS
export function fitName(dir, name, max = MAX_PATH_CHARS) {
    const room = max - dir.length - 1;
    if (name.length <= room) return name;
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    return `${stem.slice(0, Math.max(8, room - ext.length)).replace(/[. ]+$/, "")}${ext}`;
}

// fitName for the n-th copy of a name: the " (n)" is added after the shortening, so on a long path the copies
// can't be cut back to one and the same name (that looped forever on a pack with two equal difficulty names).
export function fitNumbered(dir, name, n, max = MAX_PATH_CHARS) {
    const ext = path.extname(name);
    const suffix = ` (${n})`;
    const fitted = fitName(dir, name, max - suffix.length);
    return `${fitted.slice(0, fitted.length - ext.length)}${suffix}${ext}`;
}

// MSD per chart from the API's song list of the pack (matched by title + artist, then difficulty name).
export function msdLookup(apiSongs) {
    const byBoth = new Map();
    const byTitle = new Map();
    for (const s of apiSongs ?? []) {
        const t = normKey(s.name);
        const both = `${t}|${normKey(s.artist)}`;
        if (!byBoth.has(both)) byBoth.set(both, []);
        byBoth.get(both).push(s);
        if (!byTitle.has(t)) byTitle.set(t, []);
        byTitle.get(t).push(s);
    }
    return (title, artist, difficulty, ordinal = 0) => {
        const list = byBoth.get(`${normKey(title)}|${normKey(artist)}`) ?? (byTitle.get(normKey(title))?.length === 1 ? byTitle.get(normKey(title)) : null);
        if (!list || list.length !== 1) return { msd: null, songId: null };
        const song = list[0];
        const diffs = (song.difficulties ?? []).filter((d) => (d.keys === undefined || Number(d.keys) === 4) && lower(d.name) === lower(difficulty));
        const d = diffs.length === 1 ? diffs[0] : diffs[ordinal] ?? null;
        const msd = d ? Number(d.msd) : NaN;
        return { msd: Number.isFinite(msd) ? Math.round(msd * 100) / 100 : null, songId: song.id ?? null };
    };
}

const stemOf = (name) => path.posix.basename(name).replace(/\.[^.]+$/, "");
const isSsc = (entry) => lower(entry.name).endsWith(".ssc");

// the audio entry that #MUSIC names (path from the simfile's folder, else the same file name or stem there)
function matchAudio(group, music, audioByPath) {
    if (!music) return null;
    const rel = music.replace(/\\/g, "/");
    const joined = path.posix.normalize(group.dir === "." ? rel : `${group.dir}/${rel}`);
    if (!joined.startsWith("../") && joined !== "..") {
        const hit = audioByPath.get(lower(joined));
        if (hit) return hit;
    }
    const base = lower(path.posix.basename(rel));
    const stem = base.replace(/\.[^.]+$/, "");
    return group.audio.find((a) => lower(path.posix.basename(a.name)) === base)
        ?? group.audio.find((a) => lower(stemOf(a.name)) === stem) ?? null;
}

// The simfiles of one folder ([{ src, text, music }]) as songs: [{ stem, texts, files, audio, why }].
// An .sm and an .ssc of the same name are one song (StepMania prefers the .ssc; the .sm is the fallback when
// no .ssc could be read), and simfiles that play the same audio are one song. A flat pack keeps several songs
// in one folder, so each song gets the audio its own #MUSIC names, never the first simfile's.
export function songsOfFolder(group, read, audioByPath) {
    const byStem = new Map();
    for (const r of read) {
        const key = lower(stemOf(r.src.name));
        if (!byStem.has(key)) byStem.set(key, { stem: stemOf(r.src.name), files: [] });
        byStem.get(key).files.push(r);
    }
    const units = [...byStem.values()];
    for (const u of units) {
        u.files.sort((a, b) => Number(isSsc(b.src)) - Number(isSsc(a.src)));
        u.music = u.files.map((f) => f.music).find(Boolean) ?? "";
        u.audio = matchAudio(group, u.music, audioByPath);
    }
    if (units.length === 1) {
        // one song in the folder: a missing or wrong #MUSIC still means this folder's audio
        if (!units[0].audio && group.audio.length) units[0].audio = [...group.audio].sort((a, b) => b.size - a.size)[0]; // the full song, not a preview clip
    } else {
        for (const u of units.filter((x) => !x.audio)) {
            u.audio = group.audio.find((a) => lower(stemOf(a.name)) === lower(u.stem)) ?? (group.audio.length === 1 ? group.audio[0] : null);
            if (!u.audio && group.audio.length) {
                u.why = `${u.stem}: ${u.music ? `audio "${u.music}" is not in the pack` : "no #MUSIC"} and ${group.audio.length} audio files in a folder with ${units.length} simfiles`;
            }
        }
    }
    const out = [];
    const byAudio = new Map();
    for (const u of units) {
        const ssc = u.files.filter((f) => isSsc(f.src));
        const texts = ssc.length ? ssc : u.files;
        if (!u.audio) {
            out.push({ stem: u.stem, texts, files: u.files, audio: null, why: u.why ?? (u.music ? `audio "${u.music}" is not in the pack` : "no audio") });
            continue;
        }
        let song = byAudio.get(u.audio);
        if (!song) {
            song = { stem: u.stem, texts: [], files: [], audio: u.audio, why: null };
            byAudio.set(u.audio, song);
            out.push(song);
        }
        song.texts.push(...texts);
        song.files.push(...u.files);
    }
    return out;
}

// A claim in `seen` is { pack, where } once its chart is on disk (or from an earlier run's manifest), and
// { pack, where, settled: Promise } while another lane is still writing that song: a lane that meets such a
// claim waits for it (the song may lose its audio and give the chart back) before calling the chart a duplicate.
// A lane waits only between its own songs, when it holds no unsettled claim itself, so two lanes never wait on
// each other.
// (The caller re-checks synchronously right before it claims: an async helper would give other lanes a turn
// between its last check and the claims.)
function openClaims(seen, hashes, packId) {
    return [...new Set(hashes)].map((h) => seen.get(h)).filter((c) => c?.settled && c.pack !== packId).map((c) => c.settled);
}

// zip → <songsRoot>/<packId> <song>/…; `seen` (hash → claim, see above) drops charts already taken from other packs.
export async function processPackZip(zipFile, pack, { songsRoot, apiSongs = [], seen = new Map(), logImpl = () => {} } = {}) {
    const zip = await openZip(zipFile);
    const claimed = [];
    const mine = new Set();
    const lookup = msdLookup(apiSongs);
    const songs = [];
    const skippedSongs = [];
    const reasons = {};
    const count = (code) => {
        reasons[code] = (reasons[code] ?? 0) + 1;
    };
    try {
        const groups = new Map();
        const audioByPath = new Map();
        let unsafe = 0;
        for (const e of zip.entries) {
            if (e.isDirectory) continue;
            const ext = lower(path.posix.extname(e.name));
            if (!CHART_EXT.has(ext) && !AUDIO_EXT.has(ext)) continue;
            const parts = safeEntryParts(e.name);
            if (!parts || e.name.replace(/\\/g, "/").split("/").includes("..")) {
                unsafe += 1;
                continue;
            }
            const name = path.posix.normalize(e.name.replace(/\\/g, "/"));
            const dir = path.posix.dirname(name);
            const key = lower(dir);
            if (!groups.has(key)) groups.set(key, { dir, charts: [], audio: [] });
            if (CHART_EXT.has(ext)) groups.get(key).charts.push(e);
            else {
                groups.get(key).audio.push(e);
                audioByPath.set(lower(name), e);
            }
        }
        if (unsafe) skippedSongs.push({ dir: null, reason: `${unsafe} entries with unsafe paths ignored` });
        const usedFolders = new Set();
        const tag = `eo-pack-${pack.id}`;
        for (const g of [...groups.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
            if (!g.charts.length) continue;
            const read = [];
            for (const src of g.charts) {
                try {
                    const text = decodeSimfile(await zip.readEntry(src, { maxBytes: MAX_CHART_BYTES }));
                    read.push({ src, text, music: parseSimfile(text, { ext: src.name }).song.MUSIC?.trim() || "" });
                } catch (error) {
                    skippedSongs.push({ dir: g.dir, reason: `${path.posix.basename(src.name)}: ${error.message}` });
                    count("read");
                }
            }
            if (!read.length) continue;
            const lastDir = g.dir === "." ? "" : path.posix.basename(g.dir);
            const folderSongs = songsOfFolder(g, read, audioByPath);
            const several = folderSongs.filter((s) => s.audio).length > 1;
            for (const song of folderSongs) {
                const { audio, texts } = song;
                if (!audio) {
                    skippedSongs.push({ dir: g.dir, reason: song.why });
                    count("noAudio");
                    continue;
                }
                if (audio.size > MAX_AUDIO_BYTES) {
                    skippedSongs.push({ dir: g.dir, reason: `${several ? `${song.stem}: ` : ""}audio is ${audio.size} bytes, over the cap` });
                    count("audioTooBig");
                    continue;
                }
                // several songs in one folder: each is named after its simfile
                const title = several ? (lastDir ? `${lastDir} - ${song.stem}` : song.stem) : (lastDir || song.stem);
                const folderBase = `${pack.id} ${safeName(title, 80) || "song"}`;
                let folder = folderBase;
                for (let k = 2; usedFolders.has(lower(folder)); k += 1) folder = `${folderBase} (${k})`;
                const songDir = path.join(songsRoot, folder);
                const audioName = fitName(songDir, safeName(path.posix.basename(audio.name), 120) || "audio.ogg");
                const record = { dir: g.dir, folder, audio: audioName, sources: [], charts: [], skipped: [] };
                const converted = texts.map(({ src, text }) => ({
                    src, res: convertSimfile(text, { ext: src.name, audioFilename: audioName, tags: tag, fallbackTitle: several ? song.stem : lastDir }),
                }));
                const hashes = converted.flatMap(({ res }) => res.charts.filter((c) => c.ok).map((c) => c.hash));
                for (let open = openClaims(seen, hashes, pack.id); open.length; open = openClaims(seen, hashes, pack.id)) await Promise.all(open);
                // from the last check above to the end of the claim loop below nothing awaits
                const claims = []; // { hash, entry, prev, resolve } of this song, settled in the finally below
                let outcome = "abort";
                try {
                    const toWrite = [];
                    for (const { src, res } of converted) {
                        record.title = record.title ?? res.song.title;
                        record.artist = record.artist ?? res.song.artist;
                        const ordinal = new Map();
                        for (const c of res.charts) {
                            const source = path.posix.basename(src.name);
                            if (!c.ok) {
                                record.skipped.push({ source, stepsType: c.stepsType, difficulty: c.difficulty, meter: c.meter, code: c.code, reason: c.reason });
                                count(c.code);
                                continue;
                            }
                            // a duplicate of another pack, or of an earlier song of this pack in this pass (an earlier,
                            // interrupted pass over this same pack does not count)
                            const dupOf = seen.get(c.hash);
                            if (dupOf && (dupOf.pack !== pack.id || mine.has(c.hash))) {
                                record.skipped.push({ source, difficulty: c.difficulty, meter: c.meter, code: "duplicate", reason: `same notes as ${dupOf.where}` });
                                count("duplicate");
                                continue;
                            }
                            if (!dupOf) claimed.push(c.hash);
                            let resolve;
                            const entry = { pack: pack.id, where: `${folder} [${c.version}]`, settled: new Promise((r) => { resolve = r; }) };
                            claims.push({ hash: c.hash, entry, prev: dupOf ?? null, resolve });
                            seen.set(c.hash, entry);
                            mine.add(c.hash);
                            const k = lower(c.difficulty);
                            const ord = ordinal.get(k) ?? 0;
                            ordinal.set(k, ord + 1);
                            const { msd, songId } = lookup(res.song.title, res.song.artist, c.difficulty, ord);
                            let file = fitName(songDir, osuFileName(c));
                            for (let n = 2; toWrite.some((w) => lower(w.file) === lower(file)); n += 1) {
                                file = fitNumbered(songDir, osuFileName(c), n);
                            }
                            toWrite.push({ file, osu: c.osu });
                            record.charts.push({
                                file, source, difficulty: c.difficulty, meter: c.meter, version: c.version, creator: c.creator,
                                msd, eoSongId: songId, hash: c.hash, ownTiming: c.ownTiming, visual: c.visual, ...c.stats,
                            });
                        }
                    }
                    if (!toWrite.length) {
                        skippedSongs.push({ dir: g.dir, reason: `${several ? `${song.stem}: ` : ""}no chart left to convert`, charts: record.skipped });
                        outcome = "keep";
                        continue;
                    }
                    await mkdir(songDir, { recursive: true });
                    try {
                        await zip.extractEntry(audio, path.join(songDir, audioName), { maxBytes: MAX_AUDIO_BYTES });
                    } catch (error) {
                        if (/^E[A-Z]+$/.test(error?.code ?? "")) throw error; // the disk, not the archive: stop the pack
                        // one damaged entry costs this song only; its charts are not taken (and a lane waiting on
                        // them takes them instead)
                        outcome = "drop";
                        await rmdir(songDir).catch(() => {}); // only if it is still empty (it was made just above)
                        skippedSongs.push({ dir: g.dir, reason: `${several ? `${song.stem}: ` : ""}audio: ${error.message}` });
                        count("badAudio");
                        continue;
                    }
                    usedFolders.add(lower(folder));
                    for (const { src, text } of song.files) { // keep the simfiles (.sm and .ssc) next to the conversions
                        const name = fitName(songDir, safeName(path.posix.basename(src.name), 120));
                        if (!name || lower(name) === lower(audioName)) continue;
                        await writeFile(path.join(songDir, name), Buffer.from(text, "utf8"));
                        record.sources.push(name);
                    }
                    for (const w of toWrite) await writeFile(path.join(songDir, w.file), w.osu, "utf8");
                    outcome = "keep";
                    songs.push(record);
                    logImpl(`${folder}: ${toWrite.length} charts`);
                } finally {
                    for (const cl of claims) {
                        if (seen.get(cl.hash) === cl.entry) {
                            if (outcome === "keep") delete cl.entry.settled;
                            else if (outcome === "drop" || !cl.prev) seen.delete(cl.hash);
                            else seen.set(cl.hash, cl.prev); // the pack stops: an earlier pass's claim stays as it was
                        }
                        if (outcome !== "keep") mine.delete(cl.hash);
                        cl.resolve();
                    }
                }
            }
        }
    } catch (error) {
        for (const h of claimed) if (seen.get(h)?.pack === pack.id) seen.delete(h); // a failed pack gives its charts back
        throw error;
    } finally {
        await zip.close();
    }
    const converted = songs.reduce((s, x) => s + x.charts.length, 0);
    const skippedCharts = songs.reduce((s, x) => s + x.skipped.length, 0)
        + skippedSongs.reduce((s, x) => s + (x.charts?.length ?? 0), 0);
    return {
        id: pack.id, name: pack.name, download: pack.download ?? null, apiSongCount: pack.songs ?? null,
        bytes: pack.bytes ?? null, overallMsd: pack.overall ?? null, skillsets: pack.skillsets ?? null,
        made: new Date().toISOString(),
        totals: { songsWritten: songs.length, songsSkipped: skippedSongs.filter((s) => s.dir !== null).length, chartsConverted: converted, chartsSkipped: skippedCharts, reasons },
        songs, skippedSongs,
    };
}

// ---- the run --------------------------------------------------------------------------------------------

export function parseArgs(argv) {
    const opts = { _: [], minSongs: 100, limit: 0, lanes: 2, smallestFirst: false, list: false, refreshList: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const [flag, inline] = a.startsWith("--") ? a.split(/=(.*)/s) : [a];
        const value = () => (inline !== undefined ? inline : argv[++i]);
        if (flag === "--min-songs") opts.minSongs = Number(value());
        else if (flag === "--limit") opts.limit = Number(value());
        else if (flag === "--lanes") opts.lanes = Number(value());
        else if (flag === "--smallest-first") opts.smallestFirst = true;
        else if (flag === "--list") opts.list = true;
        else if (flag === "--refresh-list") opts.refreshList = true;
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else opts._.push(a);
    }
    if (!Number.isFinite(opts.minSongs) || opts.minSongs < 0) throw new Error("--min-songs needs a number");
    if (!Number.isFinite(opts.limit) || opts.limit < 0) throw new Error("--limit needs a number");
    opts.lanes = Math.max(1, Math.min(3, Math.floor(opts.lanes) || 2)); // polite: at most 3 at once per host
    return opts;
}

async function loadCatalog(api, outRoot, { refresh, save }) {
    const file = path.join(outRoot, "packs-api.json");
    if (!refresh) {
        const cached = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
        if (cached?.packs?.length && Date.now() - Date.parse(cached.fetched) < CATALOG_MAX_AGE_MS) return cached.packs;
    }
    const packs = await api.list("/packs");
    if (save) {
        await mkdir(outRoot, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ fetched: new Date().toISOString(), packs }), "utf8");
        await rename(`${file}.tmp`, file);
    }
    return packs;
}

async function loadSeen(manifestDir) {
    const seen = new Map();
    for (const f of (await readdir(manifestDir).catch(() => [])).filter((x) => /^\d+\.json$/.test(x))) {
        const m = await readFile(path.join(manifestDir, f), "utf8").then(JSON.parse).catch(() => null);
        for (const s of m?.songs ?? []) for (const c of s.charts ?? []) if (c.hash) seen.set(c.hash, { pack: m.id, where: `${s.folder} [${c.version}]` });
    }
    return seen;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const outRoot = path.resolve(opts._[0] ?? "A:/SneezeyTrain/etterna");
    if (/[\\/]osu!?[^\\/]*[\\/]songs([\\/]|$)/i.test(outRoot)) throw new Error(`refusing to write into an osu! Songs folder: ${outRoot}`);
    const api = createApiClient();
    const catalog = await loadCatalog(api, outRoot, { refresh: opts.refreshList, save: !opts.list });
    const selected = selectPacks(catalog, { minSongs: opts.minSongs, smallestFirst: opts.smallestFirst });
    const totalBytes = selected.reduce((s, p) => s + (p.bytes ?? 0), 0);
    log(`${catalog.length} packs listed; ${selected.length} 4K packs with ≥${opts.minSongs} songs, ${(totalBytes / 1e9).toFixed(1)} GB`);
    if (opts.list) {
        for (const p of selected) console.log(`${String(p.id).padStart(5)}  ${String(p.songs).padStart(5)} songs  ${String(p.sizeText).padStart(10)}  msd ${p.overall?.toFixed(1) ?? "?"}  ${p.name}`);
        return;
    }
    const stateFile = path.join(outRoot, "state.jsonl");
    const manifestDir = path.join(outRoot, "packs");
    const songsRoot = path.join(outRoot, "songs");
    const zipDir = path.join(outRoot, "_zips");
    await mkdir(manifestDir, { recursive: true });
    await mkdir(songsRoot, { recursive: true });
    const done = new Set((await readFile(stateFile, "utf8").catch(() => "")).split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((s) => s && (s.ok || s.final)).map((s) => s.id));
    let todo = selected.filter((p) => !done.has(p.id));
    if (opts.limit > 0) todo = todo.slice(0, opts.limit);
    log(`${done.size} packs already done, ${todo.length} to fetch now (${(todo.reduce((s, p) => s + (p.bytes ?? 0), 0) / 1e9).toFixed(1)} GB), ${opts.lanes} at a time`);
    const seen = await loadSeen(manifestDir);
    let next = 0;
    let stop = false;
    const totals = { packs: 0, songs: 0, charts: 0, failed: 0 };
    async function lane() {
        while (!stop && next < todo.length) {
            const pack = todo[next++];
            const label = `#${pack.id} ${pack.name}`;
            const record = { id: pack.id, name: pack.name };
            const zipFile = path.join(zipDir, `${pack.id}.zip`);
            try {
                const fs = await statfs(outRoot);
                const free = Number(fs.bavail) * Number(fs.bsize);
                const need = (pack.bytes ?? 2e9) * 2.2 + 5e9;
                if (free < need) {
                    log(`${label}: only ${(free / 1e9).toFixed(1)} GB free, need ~${(need / 1e9).toFixed(1)} GB; stopping`);
                    stop = true;
                    break;
                }
                const url = packDownloadUrl(pack.download);
                if (!url) throw finalError(`unexpected download link: ${pack.download}`);
                const apiSongs = await api.list(`/packs/${pack.id}/songs`).catch((error) => {
                    log(`${label}: no song list from the API (${error.message}); MSD will be missing`);
                    return [];
                });
                const have = await stat(zipFile).catch(() => null);
                if (!have) {
                    log(`${label}: downloading ${pack.sizeText ?? "?"}`);
                    await downloadResumable(url, zipFile, { label });
                }
                const manifest = await processPackZip(zipFile, pack, { songsRoot, apiSongs, seen });
                manifest.apiSongsListed = apiSongs.length;
                const mf = path.join(manifestDir, `${pack.id}.json`);
                await writeFile(`${mf}.tmp`, JSON.stringify(manifest, null, 1), "utf8");
                await rename(`${mf}.tmp`, mf);
                const zipBytes = (await stat(zipFile)).size;
                await rm(zipFile); // exactly the zip this run downloaded; the extracted folders stay
                Object.assign(record, { ok: true, bytes: zipBytes, songs: manifest.totals.songsWritten, charts: manifest.totals.chartsConverted, skipped: manifest.totals.chartsSkipped });
                totals.packs += 1;
                totals.songs += manifest.totals.songsWritten;
                totals.charts += manifest.totals.chartsConverted;
                log(`${label}: ${manifest.totals.songsWritten} songs, ${manifest.totals.chartsConverted} charts (${manifest.totals.chartsSkipped} skipped)`);
            } catch (error) {
                totals.failed += 1;
                if (/not a zip|central directory|truncated/i.test(error?.message ?? "")) {
                    await rm(zipFile, { force: true }); // our own broken download: fetch it again next run
                }
                Object.assign(record, { ok: false, final: Boolean(error?.final), error: String(error?.message ?? error).slice(0, 300) });
                log(`${label}: failed: ${record.error}`);
            }
            await appendFile(stateFile, `${JSON.stringify(record)}\n`, "utf8");
            await sleep(PAUSE_MS); // a short breather for the host between packs
        }
    }
    await Promise.all(Array.from({ length: opts.lanes }, () => lane()));
    log(`done: ${totals.packs} packs, ${totals.songs} songs, ${totals.charts} charts this run; ${totals.failed} failed`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) await main();
