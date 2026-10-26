// Extra training data for the 4K mapper: the approved Google Drive dan/training packs and the Dan ~ REFORM ~
// Conglomeration zip. Drive is read without an account: public folder pages give the child ids and names
// (subfolders are followed), files come from drive.usercontent.google.com (a virus-scan confirm page is handled).
// Every .osz, whether downloaded as is or found inside a .zip, becomes one folder holding its 4K osu!mania .osu
// files (Mode 3, CircleSize 4; other key counts and modes are dropped) and the audio they name. .rar is skipped,
// except for the sources marked `rar` (the osu!mania Ranked + Loved 2013-2025 folder): their .rar files are read with
// Windows' own C:/Windows/System32/tar.exe (bsdtar/libarchive reads RAR and RAR5). Its members are listed first
// (tar -tf), then only the .osz (and loose .osu + audio when there are any) are extracted by extension pattern into
// <outRoot>/_tmp/<key>-rar/; every extracted .osz is read like any other, and the temp folder and the .rar are
// deleted by their exact paths afterwards. Sources marked `optIn` only run when named with --only, and a source's
// own `outRoot` is the default output folder when only such sources run.
// Output is outside osu! (never the Songs folder) and has the shape tools/build-mapper-dataset.mjs reads:
//   <outRoot>/sets/<source> - <set name>/   .osu + the audio each AudioFilename names (point the builder here)
//   <outRoot>/manifests/<key>.json          per download: sets, charts (hash, ids, version), what was dropped and why
//   <outRoot>/manifest.json                 summary over all downloads (rebuilt at the end of every run)
//   <outRoot>/state.jsonl                   one line per finished download (re-runs skip ok/final ones)
//   <outRoot>/drive-list.json               the resolved Drive folder trees (used when a listing fails)
//   <outRoot>/_dl/<key>.part → <key>.bin    while downloading (Range resume); removed after a successful extraction
//   <outRoot>/_tmp/<key>-<n>.osz            an .osz taken out of a .zip while it is read; removed right after
// Downloads are untrusted data: nothing from them is executed, only .osu text and audio are read and written.
// Usage: node tools/fetch-drive-packs.mjs [outRoot=A:/SneezeyTrain/packs] [--only name[,name]] [--limit N]
//        [--match text] [--lanes 2] [--list]
//        node tools/fetch-drive-packs.mjs --only ranked-loved          (→ A:/SneezeyTrain/ranked)
import { mkdir, readdir, readFile, writeFile, appendFile, rename, rm, rmdir, stat, lstat, statfs, open, copyFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openZip, safeJoin, safeEntryParts } from "./lib/zip.mjs";

// The sources the user approved (2026-10-25, .lekhapion/research.md).
export const SOURCES = [
    { name: "ndg-eta", kind: "drive-file", id: "1n46p-r2jZoUuX2mdVSaDIUWEJJt2Un3d", title: "ndg's Eta Training Pack 1" },
    { name: "lakyro-delta-speed", kind: "drive-file", id: "1zQIISe1EfgTaQ3-W1TbS0zJmIJY81yO1", title: "Lakyro Delta Training Pack 3 (SPEED)" },
    { name: "beajek-eta-stamina", kind: "drive-folder", id: "14lsDr_GaMO78DRByjp5Onyvx4UA13jNm" },
    { name: "dani-gamma", kind: "drive-folder", id: "1BxMmV0sVmjta3WyjqLW06JtkSMxrBfUw" },
    { name: "nnd-stamina-v5", kind: "drive-folder", id: "14UK9B3mvgs-BeUVl-yIMBn0jz-LPaCHv" },
    { name: "invisible-pack", kind: "drive-folder", id: "1Od9DgxV94m-JUW9qb0wzb53zxp0M5z7Y" },
    { name: "dani-delta", kind: "drive-folder", id: "1x8jfvZjC9RIcMEEK-oPt9bSHWZ4cwnCE" },
    { name: "dan-reform", kind: "url", url: "https://cdn.emik.dev/archive/dan/all.zip", title: "Dan REFORM Conglomeration v2.2" },
    // approved 2026-10-25: 4 folders (the main one holds 2013-2020, the other three the rest), 18 .rar, 49 GB;
    // its own output folder, only when named with --only
    {
        name: "ranked-loved", kind: "drive-folder", id: "1rxXzQRTpUYlS-7XS3Ub9eS1pix3YwYhT",
        moreFolders: ["1P5e8OW0WbCGl7udWDX7fV7c7rIvCvuGl", "1TWGIBKvyVH4R8no_CwCwT_fxswWGCHy6", "12WN0UZXEuhZh-4mJxNy8qXrqzx2XQvBg"],
        rar: true, optIn: true, outRoot: "A:/SneezeyTrain/ranked",
    },
];
export const DEFAULT_OUT_ROOT = "A:/SneezeyTrain/packs";
export const TAR_EXE = "C:/Windows/System32/tar.exe";

const USER_AGENT = "dan-analyzer training-data fetcher (private use; 2-3 downloads at a time)";
const DRIVE_HOST = "drive.usercontent.google.com";
const ALLOWED_HOSTS = [DRIVE_HOST, "drive.google.com", "cdn.emik.dev"];
const AUDIO_EXT = new Set([".mp3", ".ogg", ".opus", ".wav", ".flac"]);
const SKIP_ARCHIVE_EXT = new Set([".rar", ".7z"]);
const MAX_OSU_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 400 * 1024 * 1024;
const MAX_INNER_BYTES = 6 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const NOT_A_ZIP_FINAL_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 240; // osu!, ffmpeg and Python on Windows still trip over paths past 260
const MAX_FOLDER_DEPTH = 6;
const MIN_FREE_BYTES = 12e9;
const RAR_DISK_FLOOR_BYTES = 3e9; // tar is stopped when the disk gets this full while it extracts
const MAX_TAR_LIST_BYTES = 64 * 1024 * 1024;
const TAR_TIMEOUT_MS = 4 * 3600_000;
const PAUSE_MS = 2000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultLog = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lower = (s) => String(s ?? "").toLowerCase();
const finalError = (message, extra = {}) => Object.assign(new Error(message), { final: true, ...extra });

export const driveDownloadUrl = (id) => `https://${DRIVE_HOST}/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
export const driveFolderUrl = (id) => `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`;

export function hostAllowed(u) {
    try {
        const url = new URL(u);
        if (url.protocol !== "https:") return false;
        const h = url.hostname.toLowerCase();
        return ALLOWED_HOSTS.includes(h) || h.endsWith(".googleusercontent.com");
    } catch {
        return false;
    }
}

export function refuseSongs(outRoot) {
    const parts = path.resolve(outRoot).split(/[\\/]+/).map((p) => p.toLowerCase());
    if (parts.includes("songs") || parts.some((p) => p.startsWith("osu!"))) throw new Error(`refusing to write into an osu! / Songs folder: ${outRoot}`);
}

// ---- Drive pages ------------------------------------------------------------------------------------------

export function decodeHtml(s) {
    return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
        if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k];
    });
}

// The public folder page (embeddedfolderview) → { title, entries: [{ id, name, kind: "file" | "folder" }] }, or
// null when it is no folder listing (a sign-in page, an error page).
export function parseFolderPage(html) {
    const text = String(html ?? "");
    if (!text.includes("flip-entries") && !text.includes("flip-entry")) return null;
    const title = decodeHtml(/<title>([^<]*)<\/title>/i.exec(text)?.[1] ?? "").trim();
    const entries = [];
    const re = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<a href="([^"]*)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const [, id, href, name] = m;
        const kind = /\/drive\/(?:u\/\d+\/)?folders\//.test(href) ? "folder" : "file";
        entries.push({ id, name: decodeHtml(name).trim(), kind });
    }
    return { title, entries };
}

// An HTML answer from the download host: the virus-scan confirm form → { url }, the daily limit → { quota },
// a missing file → { missing }, anything else → null.
export function parseConfirmPage(html) {
    const text = String(html ?? "");
    if (/quota exceeded|too many users have viewed or downloaded this file/i.test(text)) return { quota: true };
    for (const fm of text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        const action = decodeHtml(/\baction="([^"]*)"/i.exec(fm[1])?.[1] ?? "");
        let url;
        try {
            url = new URL(action, `https://${DRIVE_HOST}/`);
        } catch {
            continue;
        }
        if (url.hostname.toLowerCase() !== DRIVE_HOST || url.protocol !== "https:" || !/\/download\b/.test(url.pathname)) continue;
        for (const im of fm[2].matchAll(/<input\b[^>]*>/gi)) {
            const tag = im[0];
            if (!/type="hidden"/i.test(tag)) continue;
            const name = decodeHtml(/\bname="([^"]*)"/i.exec(tag)?.[1] ?? "");
            const value = decodeHtml(/\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? "");
            if (name) url.searchParams.set(name, value);
        }
        if (url.searchParams.get("id")) return { url: url.toString() };
    }
    if (/<title>[^<]*(not found|404)[^<]*<\/title>/i.test(text) || /the requested url was not found|file does not exist/i.test(text)) return { missing: true };
    return null;
}

// Content-Disposition → the file name (RFC 5987 filename* first), or null.
export function contentDispositionName(header) {
    const h = String(header ?? "");
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
    if (star) {
        try {
            return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
        } catch { /* fall through */ }
    }
    const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(h) ?? /filename\s*=\s*([^;]+)/i.exec(h);
    return plain ? plain[1].replace(/\\(.)/g, "$1").trim() : null;
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

async function readTextCapped(res, max = MAX_HTML_BYTES) {
    if (!res.body) return "";
    const chunks = [];
    let n = 0;
    for await (const chunk of res.body) {
        chunks.push(Buffer.from(chunk));
        n += chunk.length;
        if (n >= max) break;
    }
    await res.body.cancel?.().catch(() => {});
    return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

// One page request at a time, gapMs apart; 429/503 wait it out.
export function createPageClient({ fetchImpl = globalThis.fetch, gapMs = 1100, sleepImpl = sleep, logImpl = defaultLog } = {}) {
    let nextAt = 0;
    let chain = Promise.resolve();
    async function run(url) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
            const wait = nextAt - Date.now();
            if (wait > 0) await sleepImpl(wait);
            nextAt = Date.now() + gapMs;
            let res;
            try {
                res = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
            } catch (error) {
                logImpl(`${url}: ${error?.message ?? error}, retrying`);
                await sleepImpl(5000 * (attempt + 1));
                continue;
            }
            if (res.status === 429 || res.status === 503) {
                const ms = retryAfterMs(res.headers, 60_000);
                logImpl(`Drive asks us to wait ${Math.round(ms / 1000)} s`);
                await res.body?.cancel?.().catch(() => {});
                nextAt = Date.now() + ms;
                continue;
            }
            if (res.url && !hostAllowed(res.url)) throw finalError(`folder page redirected to ${new URL(res.url).hostname} (not public?)`);
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { final: [403, 404, 410].includes(res.status) });
            return readTextCapped(res);
        }
        throw new Error(`gave up on ${url}`);
    }
    return (url) => {
        const p = chain.then(() => run(url));
        chain = p.catch(() => {});
        return p;
    };
}

// Every file under a public folder (subfolders followed): [{ id, name, path: "Sub/Sub2" }].
export async function listDriveFolder(folderId, getPage, { depth = 0, seenFolders = new Set(), prefix = "" } = {}) {
    if (depth > MAX_FOLDER_DEPTH || seenFolders.has(folderId)) return [];
    seenFolders.add(folderId);
    const page = parseFolderPage(await getPage(driveFolderUrl(folderId)));
    if (!page) throw new Error(`folder ${folderId}: not a public folder listing`);
    const out = [];
    for (const e of page.entries) {
        if (e.kind === "folder") {
            const sub = prefix ? `${prefix}/${e.name}` : e.name;
            out.push(...await listDriveFolder(e.id, getPage, { depth: depth + 1, seenFolders, prefix: sub }));
        } else {
            out.push({ id: e.id, name: e.name, path: prefix });
        }
    }
    return out;
}

// sources → download items [{ key, source, name, url, path, skip? }]; folder listings fall back to the cache.
export async function resolveItems(sources, { getPage, cache = {}, logImpl = defaultLog } = {}) {
    const items = [];
    const listed = {};
    for (const s of sources) {
        if (s.kind === "drive-file") {
            items.push({ key: `drive-${s.id}`, source: s.name, name: s.title ?? s.id, url: driveDownloadUrl(s.id), path: "" });
        } else if (s.kind === "url") {
            items.push({ key: `url-${s.name}`, source: s.name, name: s.title ?? path.posix.basename(new URL(s.url).pathname), url: s.url, path: "" });
        } else if (s.kind === "drive-folder") {
            let files;
            try {
                // sibling folders (moreFolders) belong to the same source; one that fails falls back like the main one
                const seenFolders = new Set();
                files = [];
                for (const id of [s.id, ...(s.moreFolders ?? [])]) files.push(...await listDriveFolder(id, getPage, { seenFolders }));
                listed[s.name] = { folder: s.id, ...(s.moreFolders ? { moreFolders: s.moreFolders } : {}), listed: new Date().toISOString(), files };
            } catch (error) {
                files = cache[s.name]?.files ?? null;
                logImpl(`${s.name}: folder listing failed (${error.message})${files ? "; using the saved listing" : "; skipped this run"}`);
                if (!files) continue;
                listed[s.name] = cache[s.name];
            }
            for (const f of files) {
                const ext = lower(path.extname(f.name));
                const readable = s.rar && ext === ".rar";
                items.push({
                    key: `drive-${f.id}`, source: s.name, name: f.name, url: driveDownloadUrl(f.id), path: f.path,
                    skip: SKIP_ARCHIVE_EXT.has(ext) && !readable ? `${ext} is not supported` : null,
                    ...(s.rar ? { rar: true } : {}),
                });
            }
        }
    }
    // one file listed in two places is fetched once
    const byKey = new Map();
    for (const it of items) if (!byKey.has(it.key)) byKey.set(it.key, it);
    return { items: [...byKey.values()], listed };
}

// ---- download -----------------------------------------------------------------------------------------------

// url → dest, resuming dest.part with Range; Drive's confirm page is followed, its daily limit is a retry-later
// error (`quota`), 429/503 wait for Retry-After, 403/404/410 give up for good, a .rar/.7z is not downloaded
// (a .rar is, with allowRar). → { file, bytes, name, resumedFrom }
export async function downloadItem(url, dest, {
    fetchImpl = globalThis.fetch, sleepImpl = sleep, logImpl = defaultLog, maxBytes = MAX_DOWNLOAD_BYTES,
    idleMs = 90_000, retries = 8, label = path.basename(dest), allowRar = false,
} = {}) {
    const part = `${dest}.part`;
    await mkdir(path.dirname(dest), { recursive: true });
    if (!hostAllowed(url)) throw finalError(`unexpected download host in ${url}`);
    let current = url;
    let name = null;
    let resumedFrom = 0;
    let failures = 0;
    let waits = 0;
    let hops = 0;
    while (true) {
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
            const res = await fetchImpl(current, { headers, redirect: "follow", signal: controller.signal });
            if (res.url && !hostAllowed(res.url)) {
                await res.body?.cancel?.().catch(() => {});
                throw finalError(`redirected to ${new URL(res.url).hostname} (the file is not public?)`);
            }
            if (res.status === 429 || res.status === 503) {
                const ms = retryAfterMs(res.headers, 5 * 60_000);
                logImpl(`${label}: host asks us to wait ${Math.round(ms / 1000)} s`);
                await res.body?.cancel?.().catch(() => {});
                clearTimeout(idle);
                if (++waits > 10) throw new Error("host kept refusing (429/503)");
                await sleepImpl(ms);
                continue;
            }
            if (/text\/html/i.test(res.headers.get("content-type") ?? "")) {
                const page = parseConfirmPage(await readTextCapped(res));
                if (page?.quota) throw Object.assign(new Error("Drive's download limit for this file is reached; try again in about 24 h"), { quota: true });
                if (page?.missing || res.status === 404 || res.status === 410) throw finalError(`HTTP ${res.status}: file not found`);
                if (page?.url && ++hops <= 3) {
                    current = page.url;
                    logImpl(`${label}: following Drive's confirm page`);
                    continue;
                }
                if (res.status === 403) throw finalError("HTTP 403 (not shared publicly?)");
                throw new Error(`HTTP ${res.status} answered with an HTML page instead of the file`);
            }
            if (res.status === 416 && have > 0) {
                await res.body?.cancel?.().catch(() => {});
                const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1]);
                if (total === have) break; // the part file is already complete
                await rm(part, { force: true });
                throw new Error(`range not satisfiable at ${have}, restarting`);
            }
            if ([403, 404, 410].includes(res.status)) {
                await res.body?.cancel?.().catch(() => {});
                throw finalError(`HTTP ${res.status}`);
            }
            if (!res.ok) {
                await res.body?.cancel?.().catch(() => {});
                throw new Error(`HTTP ${res.status}`);
            }
            name = contentDispositionName(res.headers.get("content-disposition")) ?? name;
            const nameExt = lower(path.extname(name ?? ""));
            if (name && SKIP_ARCHIVE_EXT.has(nameExt) && !(allowRar && nameExt === ".rar")) {
                await res.body?.cancel?.().catch(() => {});
                throw finalError(`${name}: ${path.extname(name)} is not supported`, { skipped: true, fileName: name });
            }
            let start = 0;
            let total = null;
            if (res.status === 206) {
                const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers.get("content-range") ?? "");
                if (!cr || Number(cr[1]) !== have) {
                    await res.body?.cancel?.().catch(() => {});
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
            const body = typeof res.body?.getReader === "function" ? Readable.fromWeb(res.body) : Readable.from(res.body ?? []);
            await pipeline(body, counter, createWriteStream(part, { flags: start > 0 ? "a" : "w" }));
            const size = (await stat(part)).size;
            if (total !== null && size !== total) throw new Error(`got ${size} of ${total} bytes`);
            break;
        } catch (error) {
            if (error?.final || error?.quota) throw error;
            failures += 1;
            const why = error?.name === "AbortError" ? "no data for a while" : error?.message ?? String(error);
            if (failures > retries) throw new Error(`${label}: gave up after ${retries} retries (${why})`);
            logImpl(`${label}: ${why}; retry ${failures}/${retries}`);
            await sleepImpl(Math.min(120_000, 5000 * failures));
        } finally {
            clearTimeout(idle);
        }
    }
    await rename(part, dest);
    return { file: dest, bytes: (await stat(dest)).size, name, resumedFrom };
}

async function sniff(file) {
    const fh = await open(file, "r");
    try {
        const buf = Buffer.alloc(8);
        const { bytesRead } = await fh.read(buf, 0, 8, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

// ---- .osu --------------------------------------------------------------------------------------------------

// What the filter needs from an .osu: mode, key count, audio, a few names, note/LN counts.
export function osuInfo(text) {
    const t = String(text ?? "").replace(/^\uFEFF/, "");
    const field = (k) => new RegExp(`^[ \\t]*${k}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, "m").exec(t)?.[1] ?? null;
    const modeText = field("Mode");
    const hit = /^[ \t]*\[HitObjects\][ \t]*\r?$/m.exec(t);
    let notes = 0;
    let lns = 0;
    if (hit) {
        for (const line of t.slice(hit.index + hit[0].length).split(/\r?\n/)) {
            if (/^\s*\[/.test(line)) break;
            const f = line.split(",");
            if (f.length < 5) continue;
            notes += 1;
            if ((Number(f[3]) & 128) !== 0) lns += 1;
        }
    }
    const num = (v) => (v === null || v === "" ? null : Number(v));
    return {
        mode: modeText === null ? 0 : Number(modeText), keys: num(field("CircleSize")), audio: field("AudioFilename"),
        title: field("Title"), artist: field("Artist"), creator: field("Creator"), version: field("Version"),
        beatmapId: num(field("BeatmapID")), setId: num(field("BeatmapSetID")), notes, lns,
    };
}

const safeName = (s, max = 80) => String(s ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim()
    .slice(0, max).replace(/[. ]+$/, "");
const stemOf = (name) => path.posix.basename(String(name ?? "").replace(/\\/g, "/")).replace(/\.[^.]+$/, "");

// name, shortened (extension kept) so that dir/name stays within MAX_PATH_CHARS
export function fitName(dir, name, max = MAX_PATH_CHARS) {
    const room = max - dir.length - 1;
    if (name.length <= room) return name;
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    return `${stem.slice(0, Math.max(8, room - ext.length)).replace(/[. ]+$/, "")}${ext}`;
}

// fitName for the n-th copy: the " (n)" survives the cut, so a loop counting n up always reaches a free name
// (cutting "long name (2).osu" could drop the suffix and give back the taken name forever)
export function fitNumbered(dir, name, n, max = MAX_PATH_CHARS) {
    const ext = path.extname(name);
    const suffix = ` (${n})`;
    const fitted = fitName(dir, name, max - suffix.length);
    return `${fitted.slice(0, fitted.length - ext.length)}${suffix}${ext}`;
}

// ---- turning one archive into set folders -------------------------------------------------------------------

// The .osu files of one folder of a zip (an .osz, or a folder in a pack) → one set folder, or a skip reason.
async function writeSet(zip, group, audioByPath, folderBase, ctx, out) {
    const { item, setsRoot, seen, mine, usedFolders, claims } = ctx;
    const dropped = {};
    const count = (k) => {
        dropped[k] = (dropped[k] ?? 0) + 1;
        out.dropped[k] = (out.dropped[k] ?? 0) + 1;
    };
    const kept = [];
    for (const e of group.osu) {
        let buf;
        try {
            buf = await zip.readEntry(e, { maxBytes: MAX_OSU_BYTES });
        } catch (error) {
            count("unreadable");
            out.skipped.push({ from: group.from, name: e.name, reason: error.message });
            continue;
        }
        const text = buf.toString("utf8");
        const info = osuInfo(text);
        if (info.mode !== 3) {
            count(`mode${Number.isFinite(info.mode) ? info.mode : "?"}`);
            continue;
        }
        if (info.keys !== 4) {
            count(`${Number.isFinite(info.keys) ? info.keys : "?"}K`);
            continue;
        }
        const audioRef = info.audio ? info.audio.replace(/\\/g, "/").replace(/^(\.\/)+/, "") : "";
        // only audio inside the chart's own folder (no "..", no absolute path)
        const rel = audioRef && !audioRef.split("/").includes("..") && !audioRef.startsWith("/") && !/^[a-z]:/i.test(audioRef)
            ? path.posix.normalize((group.dir === "." ? "" : `${group.dir}/`) + audioRef) : null;
        const audio = rel ? audioByPath.get(lower(rel)) : null;
        if (!audio) {
            count("noAudio");
            out.skipped.push({ from: group.from, name: path.posix.basename(e.name), reason: `audio "${info.audio ?? ""}" is not in the archive` });
            continue;
        }
        if (audio.size > MAX_AUDIO_BYTES) {
            count("audioTooBig");
            continue;
        }
        const hash = createHash("sha1").update(buf).digest("hex");
        // check and claim with no await in between (lanes run side by side)
        const prev = seen.get(hash);
        if ((prev && prev.key !== item.key) || mine.has(hash)) {
            count("duplicate");
            out.skipped.push({ from: group.from, name: path.posix.basename(e.name), reason: `same chart as ${prev?.where ?? "an earlier one of this download"}` });
            continue;
        }
        mine.add(hash);
        claims.push({ hash, prev: prev ?? null });
        seen.set(hash, { key: item.key, where: `${group.from}/${path.posix.basename(e.name)}` });
        kept.push({ entry: e, buf, text, info, audio, audioRef, hash });
    }
    if (!kept.length) {
        out.skippedSets.push({ from: group.from, reason: "no 4K osu!mania chart with its audio", dropped });
        return;
    }
    let folder = safeName(folderBase, 100) || `${item.source} - set`;
    const taken = (f) => (usedFolders.has(lower(f)) && usedFolders.get(lower(f)) !== item.key) || out.folders.has(lower(f));
    for (let k = 2; taken(folder); k += 1) {
        folder = `${safeName(folderBase, 95)} (${k})`;
    }
    const setDir = path.join(setsRoot, folder);
    await mkdir(setDir, { recursive: true });
    out.folders.add(lower(folder));
    usedFolders.set(lower(folder), item.key);
    // each audio once, under its own name relative to the chart folder (renamed when that is unsafe or too long)
    const audioName = new Map();
    let renamed = 0;
    const record = { folder, from: group.from, audio: [], charts: [] };
    for (const k of kept) {
        if (audioName.has(k.audio)) continue;
        const clean = k.audio.cleanName;
        const own = group.dir === "." ? clean : clean.startsWith(`${group.dir}/`) ? clean.slice(group.dir.length + 1) : null;
        let relName = own;
        let target = own ? safeJoin(setDir, own) : null;
        if (!target || target.length > MAX_PATH_CHARS) {
            relName = `audio${++renamed}${lower(path.posix.extname(own))}`;
            target = path.join(setDir, relName);
        }
        try {
            await zip.extractEntry(k.audio, target, { maxBytes: MAX_AUDIO_BYTES });
            audioName.set(k.audio, { relName });
            record.audio.push(relName);
        } catch (error) {
            if (/^E[A-Z]+$/.test(error?.code ?? "")) throw error; // the disk, not the archive
            audioName.set(k.audio, null);
            out.skipped.push({ from: group.from, name: k.audio.name, reason: `audio: ${error.message}` });
        }
    }
    const names = new Set();
    for (const k of kept) {
        const a = audioName.get(k.audio);
        if (!a) {
            count("badAudio");
            if (seen.get(k.hash)?.key === item.key) seen.delete(k.hash);
            mine.delete(k.hash);
            continue;
        }
        // the .osu is written as it came, unless its AudioFilename has to name the file differently
        const sameName = k.info.audio === a.relName; // exact: case and slashes too, for tools off Windows
        // a function replacer: '$&', '$1', '$$' in the audio name stay literal
        const data = sameName ? k.buf : Buffer.from(k.text.replace(/^([ \t]*AudioFilename[ \t]*:).*$/m, (_m, p1) => `${p1} ${a.relName}`), "utf8");
        let file = fitName(setDir, safeName(path.posix.basename(k.entry.name), 200) || "chart.osu");
        if (!lower(file).endsWith(".osu")) file += ".osu";
        for (let n = 2; names.has(lower(file)); n += 1) file = fitNumbered(setDir, `${stemOf(k.entry.name).slice(0, 150)}.osu`, n);
        names.add(lower(file));
        await writeFile(path.join(setDir, file), data);
        const { title, artist, creator, version, beatmapId, setId, notes, lns } = k.info;
        record.charts.push({
            file, audio: a.relName, title, artist, creator, version, beatmapId, setId, notes,
            lnShare: notes ? Math.round((lns / notes) * 1000) / 1000 : 0, hash: k.hash,
        });
        seen.set(k.hash, { key: item.key, where: `${folder} [${version ?? file}]` });
    }
    if (!record.charts.length) {
        await rmdir(setDir).catch(() => {}); // only when nothing is in it
        out.folders.delete(lower(folder));
        out.skippedSets.push({ from: group.from, reason: "no chart left with readable audio", dropped });
        return;
    }
    record.dropped = dropped;
    out.sets.push(record);
}

// One zip (the download itself, or an .osz/.zip inside it): loose .osu folders become sets, inner .osz/.zip are
// taken out to a temp file one at a time and read the same way.
async function readContainer(zip, label, ctx, out, depth) {
    const groups = new Map();
    const audioByPath = new Map();
    const inner = [];
    for (const e of zip.entries) {
        if (e.isDirectory) continue;
        const ext = lower(path.posix.extname(e.name));
        const isOsu = ext === ".osu";
        const isAudio = AUDIO_EXT.has(ext);
        const isInner = ext === ".osz" || ext === ".zip";
        if (SKIP_ARCHIVE_EXT.has(ext)) {
            out.unsupported.push({ from: label, name: e.name, bytes: e.size });
            continue;
        }
        if (ext === ".sm" || ext === ".ssc") out.ignored.simfiles = (out.ignored.simfiles ?? 0) + 1;
        if (!isOsu && !isAudio && !isInner) continue;
        const parts = safeEntryParts(e.name);
        if (!parts || e.name.split("/").includes("..")) {
            out.ignored.unsafePaths = (out.ignored.unsafePaths ?? 0) + 1;
            continue;
        }
        const name = parts.join("/");
        e.cleanName = name;
        if (isInner) inner.push(e);
        else if (isAudio) audioByPath.set(lower(name), e);
        else {
            const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
            if (!groups.has(lower(dir))) groups.set(lower(dir), { dir, osu: [] });
            groups.get(lower(dir)).osu.push(e);
        }
    }
    // audio keys use the cleaned names, and so must the folders the charts are looked up from
    for (const g of [...groups.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
        const lastDir = g.dir === "." ? "" : g.dir.split("/").at(-1);
        g.from = g.dir === "." ? label : `${label}/${g.dir}`;
        await writeSet(zip, g, audioByPath, `${ctx.item.source} - ${lastDir || stemOf(label) || ctx.item.key}`, ctx, out);
    }
    for (const e of inner) {
        const from = `${label}/${e.name}`;
        if (depth >= 2) {
            out.skippedSets.push({ from, reason: "archive nested too deep" });
            continue;
        }
        if (e.size > MAX_INNER_BYTES) {
            out.skippedSets.push({ from, reason: `${e.size} bytes is over the cap` });
            continue;
        }
        // an entry already on disk (a .rar's extracted .osz) is read where it is, then deleted by that same path
        const tmp = e.localPath ?? path.join(ctx.tmpDir, `${ctx.item.key}-${++ctx.tmpCount}${lower(path.posix.extname(e.name))}`);
        try {
            if (!e.localPath) await zip.extractEntry(e, tmp, { maxBytes: MAX_INNER_BYTES });
            const sub = await openZip(tmp);
            try {
                await readContainer(sub, path.posix.basename(e.name), ctx, out, depth + 1);
            } finally {
                await sub.close();
            }
        } catch (error) {
            if (/^E[A-Z]+$/.test(error?.code ?? "") && error.code !== "ENOENT") throw error;
            out.skippedSets.push({ from, reason: error.message });
        } finally {
            await rm(tmp, { force: true }); // exactly the temp file made just above (or the extracted .osz just read)
        }
    }
}

// A downloaded archive → set folders under setsRoot; the manifest of what was written and dropped.
// `seen` (chart sha1 → { key, where }) drops charts already taken from another download; `usedFolders`
// (lowercase folder → key) keeps folder names of different downloads apart.
export async function processArchive(file, item, { setsRoot, tmpDir, seen = new Map(), usedFolders = new Map(), label } = {}) {
    await mkdir(setsRoot, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    return readArchive(() => openZip(file), item, { setsRoot, tmpDir, seen, usedFolders, label: label ?? item.name ?? path.basename(file) });
}

async function readArchive(openContainer, item, { setsRoot, tmpDir, seen, usedFolders, label }) {
    const out = { sets: [], skippedSets: [], skipped: [], unsupported: [], ignored: {}, dropped: {}, folders: new Set() };
    const ctx = { item, setsRoot, tmpDir, seen, usedFolders, mine: new Set(), claims: [], tmpCount: 0 };
    const zip = await openContainer();
    try {
        await readContainer(zip, label, ctx, out, 0);
    } catch (error) {
        // a failed download gives its charts back (an earlier pass's claim stays as it was)
        for (const c of ctx.claims) {
            if (seen.get(c.hash)?.key !== item.key) continue;
            if (c.prev) seen.set(c.hash, c.prev);
            else seen.delete(c.hash);
        }
        throw error;
    } finally {
        await zip.close();
    }
    const charts = out.sets.reduce((s, x) => s + x.charts.length, 0);
    return {
        key: item.key, source: item.source, name: item.name, url: item.url, drivePath: item.path || null,
        made: new Date().toISOString(),
        totals: { sets: out.sets.length, charts, setsSkipped: out.skippedSets.length, dropped: out.dropped, unsupported: out.unsupported.length },
        sets: out.sets, skippedSets: out.skippedSets, skipped: out.skipped, unsupported: out.unsupported, ignored: out.ignored,
    };
}

// ---- .rar through Windows' tar.exe --------------------------------------------------------------------------

// tar.exe with an argument list (no shell, nothing from the archive on the command line) → { code, stdout, stderr }.
// stdout is capped; `signal` kills it.
export function createTarRunner({ exe = TAR_EXE } = {}) {
    return (args, { signal, timeoutMs = TAR_TIMEOUT_MS, maxStdout = MAX_TAR_LIST_BYTES } = {}) => new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal, timeout: timeoutMs, killSignal: "SIGKILL" });
        } catch (error) {
            reject(error);
            return;
        }
        const chunks = [];
        let bytes = 0;
        let over = false;
        let stderr = "";
        child.stdout.on("data", (c) => {
            if (over) return;
            if (bytes + c.length > maxStdout) {
                over = true;
                child.kill("SIGKILL");
                return;
            }
            chunks.push(c);
            bytes += c.length;
        });
        child.stderr.on("data", (c) => {
            if (stderr.length < 64 * 1024) stderr += c.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code, sig) => {
            if (over) reject(new Error(`tar printed more than ${maxStdout} bytes`));
            else resolve({ code, signal: sig, stdout: Buffer.concat(chunks), stderr });
        });
    });
}

// tar -tf output → member names (folders left out). Names tar could not print in the console's code page come
// out with "?" in them; they are only counted, never passed back to tar.
export function decodeListing(buf) {
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
        text = Buffer.from(buf).toString("latin1");
    }
    return text.split(/\r?\n/).filter((l) => l && !/[\\/]$/.test(l));
}

// "*.[oO][sS][zZ]": tar's patterns are case-sensitive
export const caseFreeGlob = (ext) => `*.${[...ext.replace(/^\./, "")].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("")}`;

// What a .rar holds → counts, the unsafe names (absolute, drive letter, "..": never written by us; bsdtar refuses
// "..", and a stripped "/" or "C:" still lands inside the temp folder), nested archives, other kinds by extension,
// and the extension patterns to extract: .osz always, loose .osu + audio only when there are loose .osu.
export function classifyRarMembers(names) {
    const r = { total: 0, osz: 0, osu: 0, audio: 0, unsafe: [], nested: [], other: {}, patterns: [] };
    for (const raw of names) {
        const n = String(raw).replace(/\\/g, "/");
        if (!n || n.endsWith("/")) continue;
        r.total += 1;
        const ext = lower(path.posix.extname(n));
        if (ext === ".osz" || ext === ".osu" || AUDIO_EXT.has(ext)) {
            if (n.includes("\0") || !safeEntryParts(n) || n.split("/").includes("..")) {
                r.unsafe.push(n);
                continue;
            }
            if (ext === ".osz") r.osz += 1;
            else if (ext === ".osu") r.osu += 1;
            else r.audio += 1;
        } else if (SKIP_ARCHIVE_EXT.has(ext) || ext === ".zip") {
            r.nested.push(n);
        } else {
            const k = ext || "(none)";
            r.other[k] = (r.other[k] ?? 0) + 1;
        }
    }
    if (r.osz) r.patterns.push(caseFreeGlob(".osz"));
    if (r.osu) r.patterns.push(caseFreeGlob(".osu"), ...[...AUDIO_EXT].map(caseFreeGlob));
    return r;
}

// Regular files under root (symlinks, junctions and anything else are skipped and counted), names with "/".
async function walkRegularFiles(root, maxDepth = 12) {
    const files = [];
    let others = 0;
    async function walk(dir, rel, depth) {
        for (const d of await readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, d.name);
            const st = await lstat(abs);
            if (st.isSymbolicLink()) others += 1;
            else if (st.isDirectory()) {
                if (depth < maxDepth) await walk(abs, rel ? `${rel}/${d.name}` : d.name, depth + 1);
                else others += 1;
            } else if (st.isFile()) files.push({ name: rel ? `${rel}/${d.name}` : d.name, abs, size: st.size });
            else others += 1;
        }
    }
    await walk(root, "", 0);
    return { files, others };
}

// Files on disk shaped like an open zip, so readContainer reads them the same way.
function folderArchive(files) {
    const cap = (e, maxBytes) => {
        if (e.size > maxBytes) throw new Error(`${e.size} bytes is over the ${maxBytes} byte cap`);
    };
    return {
        entries: files.map((f) => ({ name: f.name, size: f.size, isDirectory: false, localPath: f.abs })),
        async readEntry(e, { maxBytes = Infinity } = {}) {
            cap(e, maxBytes);
            return readFile(e.localPath);
        },
        async extractEntry(e, target, { maxBytes = Infinity } = {}) {
            cap(e, maxBytes);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(e.localPath, target);
        },
        async close() {},
    };
}

// libarchive's seekable zip reader looks for a zip directory in the last 16 KiB of a file, and a .rar whose last
// member is a stored .osz has one there: tar then reads the whole .rar as that one .osz (seen with osumania 2013
// Ranked.rar: 9 members of one set instead of 43 .osz). Zeros after the RAR end block are ignored by the RAR reader
// and push that directory out of reach, so our own downloaded copy gets 128 KiB of them (once).
export const RAR_PAD_BYTES = 128 * 1024;
export async function padForTar(file) {
    const fh = await open(file, "r+");
    try {
        const { size } = await fh.stat();
        const n = Math.min(size, RAR_PAD_BYTES);
        const buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, size - n);
        if (size >= RAR_PAD_BYTES && buf.every((b) => b === 0)) return false;
        await fh.write(Buffer.alloc(RAR_PAD_BYTES), 0, RAR_PAD_BYTES, size);
        return true;
    } finally {
        await fh.close();
    }
}

const freeBytes = async (statfsImpl, dir) => {
    const fs = await statfsImpl(dir);
    return Number(fs.bavail) * Number(fs.bsize);
};
const tail = (s, n = 600) => String(s ?? "").trim().slice(-n);

// A downloaded .rar → set folders, like processArchive. tar lists it, extracts the .osz (and loose .osu + audio)
// into <tmpDir>/<key>-rar/, every .osz there becomes its own set; the temp folder is removed by its exact path
// either way. Errors: `damaged` (tar cannot read it), `diskFull` (the .rar is kept for the next run), and a plain
// error (tar killed or timed out: the .rar is kept and read again next run). A tar that exits non-zero after a
// normal run (refused names, say) still gives the sets it wrote, with `rar.partial` set.
const DISK_FULL_RE = /no space|not enough space|disk (is )?full|write failed|ENOSPC/i;
export async function processRar(file, item, {
    setsRoot, tmpDir, seen = new Map(), usedFolders = new Map(), label, tar = createTarRunner(), logImpl = defaultLog,
    diskFloorBytes = RAR_DISK_FLOOR_BYTES, statfsImpl = statfs, checkMs = 10_000,
} = {}) {
    label ??= item.name ?? path.basename(file);
    await mkdir(setsRoot, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    const padded = await padForTar(file);
    const listing = await tar(["-t", "-f", file]);
    // killed or timed out (code null): says nothing about the archive, so not `damaged` (that deletes the .rar)
    if (listing.signal || listing.code === null) throw new Error(`tar was stopped (${listing.signal ?? "no exit code"}) while listing ${label}; the .rar stays for the next run`);
    const names = decodeListing(listing.stdout);
    if (listing.code !== 0 && !names.length) throw Object.assign(new Error(`tar could not read ${label}: ${tail(listing.stderr) || `exit ${listing.code}`}`), { damaged: true });
    const members = classifyRarMembers(names);
    const info = {
        members: members.total, osz: members.osz, osu: members.osu, audio: members.audio, unsafe: members.unsafe.length,
        unsafeNames: members.unsafe.slice(0, 20), nested: members.nested.length, other: members.other,
        // tar.exe turns names into the console's code page (1251 here); a name it cannot write that way (Japanese,
        // accents) is skipped by tar in the listing and in the extraction alike. Counted so the loss is visible.
        // the zeros at the end of our copy, whether added now or on an earlier try (padForTar leaves them once there)
        paddedBytes: RAR_PAD_BYTES,
        paddedNow: padded,
        unreadableNames: (String(listing.stderr).match(/unreadable filename/gi) ?? []).length,
        ...(listing.code !== 0 ? { listWarnings: tail(listing.stderr) } : {}),
    };
    const workDir = path.join(tmpDir, `${item.key}-rar`);
    await rm(workDir, { recursive: true, force: true }); // a crashed run's leftovers: exactly this archive's temp folder
    await mkdir(workDir, { recursive: true });
    try {
        if (members.patterns.length) {
            if (diskFloorBytes > 0) {
                // room for the extracted copy (an .osz hardly shrinks inside a .rar)
                const free = await freeBytes(statfsImpl, tmpDir);
                const need = (await stat(file)).size + diskFloorBytes;
                if (free < need) throw Object.assign(new Error(`${(free / 1e9).toFixed(1)} GB free, ${(need / 1e9).toFixed(1)} GB needed to extract ${label}; the .rar stays for the next run`), { diskFull: true });
            }
            logImpl(`${label}: ${members.total} members; extracting ${members.osz} .osz${members.osu ? `, ${members.osu} loose .osu and ${members.audio} audio files` : ""}`);
            const controller = new AbortController();
            let full = false;
            const timer = diskFloorBytes > 0 ? setInterval(() => {
                freeBytes(statfsImpl, tmpDir).then((free) => {
                    if (free < diskFloorBytes) {
                        full = true;
                        controller.abort();
                    }
                }, () => {});
            }, checkMs) : null;
            timer?.unref?.();
            let x;
            try {
                x = await tar(["-x", "-f", file, "-C", workDir, ...members.patterns.map((p) => `--include=${p}`)], { signal: controller.signal });
            } catch (error) {
                if (full) throw Object.assign(new Error(`the disk is nearly full; stopped extracting ${label}; the .rar stays for the next run`), { diskFull: true });
                throw error;
            } finally {
                clearInterval(timer);
            }
            if (full) throw Object.assign(new Error(`the disk is nearly full; stopped extracting ${label}; the .rar stays for the next run`), { diskFull: true });
            // killed or timed out (code null): what was written is a cut-off part of the pack, so none of it is kept
            if (x.signal || x.code === null) throw new Error(`tar was stopped (${x.signal ?? "no exit code"}) while extracting ${label}; the .rar stays for the next run`);
            info.tarExit = x.code;
            if (x.code !== 0) {
                info.extractWarnings = tail(x.stderr);
                // the disk filled between two polls: tar failed writing, so the rest of the pack is missing
                // (not judged by the free space now: a whole pack written fills the disk down to about the floor)
                if (DISK_FULL_RE.test(String(x.stderr))) {
                    throw Object.assign(new Error(`tar could not write while extracting ${label} (${tail(x.stderr, 200) || `exit ${x.code}`}); the .rar stays for the next run`), { diskFull: true });
                }
                info.partial = true;
            }
        }
        const { files, others } = await walkRegularFiles(workDir);
        info.extracted = files.length;
        info.extractedOsz = files.filter((f) => lower(path.posix.extname(f.name)) === ".osz").length;
        if (others) info.notRegularFiles = others;
        if (members.patterns.length && !files.length && info.tarExit) {
            throw Object.assign(new Error(`tar extracted nothing from ${label}: ${info.extractWarnings || `exit ${info.tarExit}`}`), { damaged: true });
        }
        const manifest = await readArchive(async () => folderArchive(files), item, { setsRoot, tmpDir, seen, usedFolders, label });
        for (const n of members.nested) manifest.unsupported.push({ from: label, name: n });
        manifest.totals.unsupported = manifest.unsupported.length;
        manifest.rar = info;
        return manifest;
    } finally {
        await rm(workDir, { recursive: true, force: true }); // exactly this archive's temp folder
    }
}

// ---- the run ------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
    // outRoot null: the picked sources' own folder (A:/SneezeyTrain/packs for the first eight, see run)
    const opts = { outRoot: null, only: null, limit: 0, lanes: 2, list: false, match: null };
    let positional = 0;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const [flag, inline] = a.startsWith("--") ? a.split(/=(.*)/s) : [a];
        const value = () => {
            if (inline !== undefined) return inline;
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (flag === "--only") opts.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        else if (flag === "--limit") opts.limit = Number(value());
        else if (flag === "--lanes") opts.lanes = Number(value());
        else if (flag === "--list") opts.list = true;
        else if (flag === "--match") opts.match = value(); // only the downloads whose folder path/name contains this
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else if (positional++ === 0) opts.outRoot = a;
        else throw new Error(`unexpected argument ${a}`);
    }
    if (!Number.isFinite(opts.limit) || opts.limit < 0) throw new Error("--limit needs a number");
    opts.lanes = Math.max(1, Math.min(3, Math.floor(opts.lanes) || 2)); // polite: at most 3 at once per host
    return opts;
}

export async function readState(stateFile) {
    const done = new Map();
    for (const line of (await readFile(stateFile, "utf8").catch(() => "")).split("\n")) {
        if (!line.trim()) continue;
        try {
            const s = JSON.parse(line);
            if (s?.key && (s.ok || s.final)) done.set(s.key, s);
        } catch { /* a torn last line */ }
    }
    return done;
}

async function loadManifests(manifestDir) {
    const list = [];
    for (const f of (await readdir(manifestDir).catch(() => [])).filter((x) => x.endsWith(".json"))) {
        const m = await readFile(path.join(manifestDir, f), "utf8").then(JSON.parse).catch(() => null);
        if (m?.key) list.push(m);
    }
    return list;
}

async function writeJson(file, value) {
    await writeFile(`${file}.tmp`, JSON.stringify(value, null, 1), "utf8");
    await rename(`${file}.tmp`, file);
}

// Only one copy per outRoot: a lock file with the pid (a dead owner's lock is taken over).
async function takeLock(outRoot) {
    const file = path.join(outRoot, "fetch-drive.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fh = await open(file, "wx");
            await fh.writeFile(String(process.pid));
            await fh.close();
            return () => rm(file, { force: true });
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const pid = Number(await readFile(file, "utf8").catch(() => ""));
            let alive = false;
            try {
                if (pid > 0) alive = process.kill(pid, 0); // signal 0 only asks whether it exists
            } catch (e) {
                alive = e?.code === "EPERM";
            }
            if (alive) throw new Error(`another copy (pid ${pid}) is working on ${outRoot}`);
            await rm(file, { force: true });
        }
    }
    throw new Error(`could not take ${file}`);
}

// keys whose archive tar could not read before (a second time is final: a 12 GB file is not fetched forever)
async function readDamaged(stateFile) {
    const keys = new Set();
    for (const line of (await readFile(stateFile, "utf8").catch(() => "")).split("\n")) {
        try {
            const s = line.trim() ? JSON.parse(line) : null;
            if (s?.key && s.damaged) keys.add(s.key);
        } catch { /* a torn last line */ }
    }
    return keys;
}

// The sources a run works on (opt-in ones only when named) and where it writes: the given outRoot, else the
// one folder those sources name (DEFAULT_OUT_ROOT for sources without their own).
export function pickSources(sources, only, outRoot) {
    const unknown = (only ?? []).filter((o) => !sources.some((s) => s.name === o));
    if (unknown.length) throw new Error(`unknown source ${unknown.join(", ")}; known: ${sources.map((s) => s.name).join(", ")}`);
    const picked = only?.length ? sources.filter((s) => only.includes(s.name)) : sources.filter((s) => !s.optIn);
    if (outRoot) return { picked, outRoot };
    const roots = [...new Set(picked.map((s) => s.outRoot ?? DEFAULT_OUT_ROOT))];
    if (roots.length > 1) throw new Error(`these sources write to different folders (${roots.join(", ")}); run them apart or name the outRoot`);
    return { picked, outRoot: roots[0] ?? DEFAULT_OUT_ROOT };
}

export async function run({
    outRoot = null, only = null, limit = 0, lanes = 2, list = false, match = null, sources = SOURCES,
    fetchImpl = globalThis.fetch, sleepImpl = sleep, logImpl = defaultLog, pageGapMs = 1100, pauseMs = PAUSE_MS,
    minFreeBytes = MIN_FREE_BYTES, lock = true, tarImpl = null, rarDiskFloorBytes = RAR_DISK_FLOOR_BYTES,
} = {}) {
    const choice = pickSources(sources, only, outRoot);
    const picked = choice.picked;
    outRoot = path.resolve(choice.outRoot);
    refuseSongs(outRoot);
    await mkdir(outRoot, { recursive: true });
    // --list only reads the saved listing and state (it writes nothing), so it runs beside a full job
    const release = lock && !list ? await takeLock(outRoot) : async () => {};
    try {
        const listFile = path.join(outRoot, "drive-list.json");
        const cache = await readFile(listFile, "utf8").then(JSON.parse).catch(() => ({}));
        const getPage = createPageClient({ fetchImpl, gapMs: pageGapMs, sleepImpl, logImpl });
        const { items, listed } = await resolveItems(picked, { getPage, cache, logImpl });
        if (!list && Object.keys(listed).length) await writeJson(listFile, { ...cache, ...listed });
        const stateFile = path.join(outRoot, "state.jsonl");
        const done = await readState(stateFile);
        if (list) {
            for (const it of items) logImpl(`${done.has(it.key) ? "done " : it.skip ? "skip " : "todo "} ${it.source.padEnd(20)} ${it.path ? `${it.path}/` : ""}${it.name}${it.skip ? ` (${it.skip})` : ""}`);
            return { items, attempted: 0 };
        }
        const manifestDir = path.join(outRoot, "manifests");
        const setsRoot = path.join(outRoot, "sets");
        const dlDir = path.join(outRoot, "_dl");
        const tmpDir = path.join(outRoot, "_tmp");
        await mkdir(manifestDir, { recursive: true });
        const seen = new Map();
        const usedFolders = new Map();
        for (const m of await loadManifests(manifestDir)) {
            for (const s of m.sets ?? []) {
                usedFolders.set(lower(s.folder), m.key);
                for (const c of s.charts ?? []) if (c.hash) seen.set(c.hash, { key: m.key, where: `${s.folder} [${c.version ?? c.file}]` });
            }
        }
        const damaged = await readDamaged(stateFile);
        let todo = items.filter((it) => !done.has(it.key));
        if (match) todo = todo.filter((it) => lower(`${it.path ? `${it.path}/` : ""}${it.name}`).includes(lower(match)));
        if (limit > 0) todo = todo.slice(0, limit);
        logImpl(`${items.length} downloads listed, ${done.size} already done, ${todo.length} to fetch now, ${lanes} at a time`);
        const blockedHosts = new Set();
        const totals = { downloads: 0, sets: 0, charts: 0, failed: 0, skipped: 0 };
        const results = [];
        let next = 0;
        let stop = false;
        const record = async (rec) => {
            results.push(rec);
            await appendFile(stateFile, `${JSON.stringify(rec)}\n`, "utf8");
        };
        async function lane() {
            while (!stop && next < todo.length) {
                const it = todo[next++];
                const label = `${it.source}: ${it.name}`;
                if (it.skip) {
                    totals.skipped += 1;
                    logImpl(`${label}: skipped (${it.skip})`);
                    await record({ key: it.key, source: it.source, name: it.name, ok: false, final: true, skipped: it.skip });
                    continue;
                }
                const host = new URL(it.url).hostname;
                if (blockedHosts.has(host)) {
                    logImpl(`${label}: ${host} hit its download limit earlier in this run; left for the next run`);
                    continue;
                }
                if (minFreeBytes > 0) {
                    const fs = await statfs(outRoot);
                    const free = Number(fs.bavail) * Number(fs.bsize);
                    if (free < minFreeBytes) {
                        logImpl(`only ${(free / 1e9).toFixed(1)} GB free on ${outRoot}; stopping`);
                        stop = true;
                        break;
                    }
                }
                const file = path.join(dlDir, `${it.key}.bin`);
                const meta = path.join(dlDir, `${it.key}.json`);
                const rec = { key: it.key, source: it.source, name: it.name };
                try {
                    let name = it.name;
                    if (await stat(file).catch(() => null)) {
                        name = (await readFile(meta, "utf8").then(JSON.parse).catch(() => null))?.name ?? name;
                    } else {
                        logImpl(`${label}: downloading`);
                        const r = await downloadItem(it.url, file, { fetchImpl, sleepImpl, logImpl, label, allowRar: Boolean(it.rar) });
                        name = r.name ?? it.name;
                        await writeFile(meta, JSON.stringify({ name, bytes: r.bytes, url: it.url }), "utf8");
                        logImpl(`${label}: ${(r.bytes / 1e6).toFixed(1)} MB${r.resumedFrom ? ` (resumed at ${(r.resumedFrom / 1e6).toFixed(1)} MB)` : ""}`);
                    }
                    rec.name = name;
                    const head = await sniff(file);
                    const isRar = head.subarray(0, 4).toString("latin1") === "Rar!";
                    if ((isRar && !it.rar) || head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
                        await rm(file, { force: true });
                        await rm(meta, { force: true });
                        throw finalError(`${name}: a .rar/.7z archive, not supported`, { skipped: true });
                    }
                    let manifest;
                    if (isRar) {
                        try {
                            manifest = await processRar(file, { ...it, name }, {
                                setsRoot, tmpDir, seen, usedFolders, label: name, tar: tarImpl ?? createTarRunner(), logImpl, diskFloorBytes: rarDiskFloorBytes,
                            });
                        } catch (error) {
                            if (error?.diskFull) stop = true; // the .rar stays in _dl and is read on the next run
                            if (error?.damaged) {
                                // fetched once more on the next run, then given up
                                const again = damaged.has(it.key);
                                await rm(file, { force: true });
                                await rm(meta, { force: true });
                                throw Object.assign(new Error(error.message), { final: again, damaged: true });
                            }
                            throw error;
                        }
                    } else {
                        try {
                            manifest = await processArchive(file, { ...it, name }, { setsRoot, tmpDir, seen, usedFolders, label: name });
                        } catch (error) {
                            if (/not a zip|central directory|truncated|zip64/i.test(error?.message ?? "")) {
                                const bytes = (await stat(file)).size;
                                await rm(file, { force: true }); // our own broken download: fetched again next run
                                await rm(meta, { force: true });
                                // no "PK" at the start: some other file (a txt, an image), never a zip, so not fetched again;
                                // a "PK" file that does not read is a cut download, retried while small
                                const isZipHead = head.subarray(0, 2).toString("latin1") === "PK";
                                throw Object.assign(new Error(`not a readable zip (${bytes} bytes: ${error.message})`), { final: !isZipHead || bytes > NOT_A_ZIP_FINAL_BYTES });
                            }
                            throw error;
                        }
                    }
                    manifest.bytes = (await stat(file)).size - (manifest.rar?.paddedBytes ?? 0);
                    await writeJson(path.join(manifestDir, `${it.key}.json`), manifest);
                    await rm(file); // exactly the archive this run downloaded; the extracted folders stay
                    await rm(meta, { force: true });
                    Object.assign(rec, { ok: true, bytes: manifest.bytes, sets: manifest.totals.sets, charts: manifest.totals.charts, dropped: manifest.totals.dropped });
                    if (manifest.unsupported.length) rec.unsupported = manifest.unsupported.map((u) => u.name);
                    if (manifest.rar?.partial) Object.assign(rec, { partial: true, tarExit: manifest.rar.tarExit }); // tar exited non-zero: see the manifest's rar.extractWarnings
                    totals.downloads += 1;
                    totals.sets += manifest.totals.sets;
                    totals.charts += manifest.totals.charts;
                    logImpl(`${label}: ${manifest.totals.sets} sets, ${manifest.totals.charts} 4K charts; dropped ${JSON.stringify(manifest.totals.dropped)}${manifest.unsupported.length ? `; ${manifest.unsupported.length} archives inside not read` : ""}${manifest.rar ? `; tar: ${manifest.rar.extractedOsz}/${manifest.rar.osz} .osz extracted, ${manifest.rar.unsafe} unsafe and ${manifest.rar.unreadableNames} unreadable names` : ""}`);
                } catch (error) {
                    if (error?.quota) blockedHosts.add(host);
                    if (error?.skipped) totals.skipped += 1;
                    else totals.failed += 1;
                    Object.assign(rec, { ok: false, final: Boolean(error?.final), error: String(error?.message ?? error).slice(0, 300) });
                    if (error?.skipped) rec.skipped = "unsupported archive";
                    if (error?.damaged) rec.damaged = true;
                    if (error?.fileName) rec.name = error.fileName;
                    logImpl(`${label}: ${error?.skipped ? "skipped" : "failed"}: ${rec.error}`);
                }
                await record(rec);
                if (pauseMs > 0) await sleepImpl(pauseMs); // a short breather for the host between downloads
            }
        }
        await Promise.all(Array.from({ length: Math.max(1, Math.min(3, lanes)) }, () => lane()));
        // the summary over every download so far
        const all = await loadManifests(manifestDir);
        const state = await readState(stateFile);
        await writeJson(path.join(outRoot, "manifest.json"), {
            made: new Date().toISOString(),
            setsRoot,
            totals: { downloads: all.length, sets: all.reduce((s, m) => s + (m.totals?.sets ?? 0), 0), charts: all.reduce((s, m) => s + (m.totals?.charts ?? 0), 0) },
            downloads: all.map((m) => ({ key: m.key, source: m.source, name: m.name, bytes: m.bytes ?? null, ...m.totals, unsupported: (m.unsupported ?? []).map((u) => u.name) })),
            notFetched: [...state.values()].filter((s) => !s.ok).map((s) => ({ key: s.key, source: s.source, name: s.name, reason: s.skipped ?? s.error })),
        });
        await rmdir(tmpDir).catch(() => {}); // only when empty
        logImpl(`done: ${totals.downloads} downloads, ${totals.sets} sets, ${totals.charts} 4K charts this run; ${totals.skipped} skipped, ${totals.failed} failed`);
        return { items, attempted: todo.length, totals, results };
    } finally {
        await release();
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await run(opts);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) await main();
