// Extra training data for the 4K rice mapper from the Hugging Face dataset project-riz/osu-beatmaps (WebDataset tars:
// <seq>.json with every beatmap that shares one audio track, the .osu text embedded, plus <seq>.<audio>).
// Each tar shard is streamed and filtered on the fly: a sample is kept only if one of its beatmaps is osu!mania 4K
// rice (Mode 3, CircleSize 4, 100+ objects, at most 15% long notes). Nothing else touches the disk.
//
// Usage: node tools/fetch-hf-osu.mjs [outRoot=A:/SneezeyTrain/hf] [--variant compressed|original] [--limit N]
//                                    [--lanes 2] [--shard data-000073[,data-000010]]
//   <outRoot>/<beatmapset_id>/<seq>.<audio ext>   audio of the sample (several samples of one set share the folder)
//   <outRoot>/<beatmapset_id>/<beatmap_id>.osu   each kept 4K difficulty, AudioFilename pointing at that audio
//   <outRoot>/state.jsonl                         one line per finished shard: { shard, ok, samples, kept, diffs, … }
// Re-runs skip finished shards; a shard that was interrupted starts again (its kept files are simply rewritten).
// Downloads are untrusted data: only chart text and audio bytes are read, output names come from validated ids,
// every entry has a size cap. License of the dataset: osu! terms, research/private training use only.
import { mkdir, readFile, writeFile, appendFile, rename, stat, rm, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTar, safeTarName } from "./lib/tar.mjs";

export const REPO = "project-riz/osu-beatmaps";
const API = `https://huggingface.co/api/datasets/${REPO}`;
const RESOLVE = `https://huggingface.co/datasets/${REPO}/resolve/main`;
const USER_AGENT = "dan-analyzer training-data tool (private use)";
const MAX_JSON = 64 * 1024 * 1024;
const MAX_AUDIO = 256 * 1024 * 1024;
const MAX_CHART = 8 * 1024 * 1024;
const AUDIO_EXT = new Set(["mp3", "ogg", "opus", "wav", "flac"]);
const IDLE_MS = 60_000;
const MAX_RETRIES = 6;
const LOG_EVERY = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const defaultLog = (...a) => console.log(stamp(), ...a);

// ---- sample filtering ---------------------------------------------------------------------------------------

// Python's json.dumps writes NaN / Infinity for missing numbers (diff_aim on mania maps): turn them into null.
export function parseLooseJson(text) {
    if (typeof text !== "string") text = Buffer.from(text).toString("utf8");
    try { return JSON.parse(text); } catch { /* fall through to the slow path */ }
    let out = "";
    let last = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inString) {
            if (c === 92) i++; // backslash: skip the escaped char
            else if (c === 34) inString = false;
            continue;
        }
        if (c === 34) { inString = true; continue; }
        let len = 0;
        if (c === 78 && text.startsWith("NaN", i)) len = 3;
        else if (c === 73 && text.startsWith("Infinity", i)) len = 8;
        else if (c === 45 && text.startsWith("-Infinity", i)) len = 9;
        if (len) {
            out += text.slice(last, i) + "null";
            i += len - 1;
            last = i + 1;
        }
    }
    return JSON.parse(out + text.slice(last));
}

function sectionLines(content, name) {
    const start = content.search(new RegExp(`^[ \\t]*\\[${name}\\][ \\t]*\\r?$`, "m"));
    if (start < 0) return [];
    const lines = content.slice(start).split(/\r?\n/);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
        if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) break;
        out.push(lines[i]);
    }
    return out;
}

function headerValue(content, key) {
    const m = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*([^\\r\\n]*)`, "m").exec(content);
    return m ? m[1].trim() : null;
}

// Is this beatmap (one element of the sample's "beatmaps") an osu!mania 4K rice chart?
export function rice4k(bm) {
    const content = bm?.content;
    if (typeof content !== "string" || content.length > MAX_CHART || !content.includes("[HitObjects]")) return { ok: false, reason: "no chart" };
    const modeText = headerValue(content, "Mode");
    const mode = modeText !== null ? Number(modeText) : Number(bm.mode);
    if (mode !== 3) return { ok: false, reason: "mode" };
    const csText = headerValue(content, "CircleSize");
    const keys = csText !== null ? Number(csText) : Number(bm.diff_size);
    if (keys !== 4) return { ok: false, reason: "keys" };
    let objects = 0;
    let ln = 0;
    for (const line of sectionLines(content, "HitObjects")) {
        const f = line.split(",");
        if (f.length < 5) continue;
        objects++;
        if ((Number(f[3]) & 128) !== 0) ln++;
    }
    if (objects < 100) return { ok: false, reason: "short", objects };
    const lnShare = ln / objects;
    if (lnShare > 0.15) return { ok: false, reason: "ln", objects, lnShare };
    return { ok: true, objects, lnShare };
}

const validId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// The chart as saved: AudioFilename names the saved audio, BeatmapID/BeatmapSetID are present (taken from the
// dataset's metadata where the file has none or a placeholder).
export function prepareOsu(content, { audioName, beatmapId, beatmapsetId }) {
    let text = content;
    const audioLine = `AudioFilename: ${audioName}`;
    if (/^[ \t]*AudioFilename[ \t]*:/m.test(text)) text = text.replace(/^[ \t]*AudioFilename[ \t]*:[^\r\n]*/m, audioLine);
    else if (/^[ \t]*\[General\][ \t]*\r?$/m.test(text)) text = text.replace(/^([ \t]*\[General\][ \t]*)(\r?)$/m, `$1$2\n${audioLine}$2`);
    else text = text.replace(/^([^\r\n]*)(\r?\n)/, `$1$2$2[General]$2${audioLine}$2`);

    const ensure = (key, value) => {
        if (!value) return;
        const re = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*([^\\r\\n]*)`, "m");
        const m = re.exec(text);
        if (m) {
            if (!(Number(m[1]) > 0)) text = text.replace(re, `${key}:${value}`);
        } else if (/^[ \t]*\[Metadata\][ \t]*\r?$/m.test(text)) {
            text = text.replace(/^([ \t]*\[Metadata\][ \t]*)(\r?)$/m, `$1$2\n${key}:${value}$2`);
        } else if (/^[ \t]*\[Difficulty\]/m.test(text)) {
            text = text.replace(/^([ \t]*\[Difficulty\])/m, `[Metadata]\n${key}:${value}\n\n$1`);
        }
    };
    ensure("BeatmapSetID", beatmapsetId);
    ensure("BeatmapID", beatmapId);
    return text;
}

// "<dir>/<key>.<ext…>" → WebDataset key and extension (the extension starts at the first dot of the base name).
export function splitKey(name) {
    const slash = name.lastIndexOf("/");
    const dot = name.indexOf(".", slash + 1);
    if (dot <= slash + 1) return null;
    return { key: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

// The original variant names every audio ".mp3" whatever it is; look at the bytes.
export function audioExt(data, declared) {
    const head = data.subarray(0, 4).toString("latin1");
    if (declared === "opus") return "opus";
    if (head === "OggS") return "ogg";
    if (head === "RIFF") return "wav";
    if (head === "fLaC") return "flac";
    return AUDIO_EXT.has(declared) ? declared : "mp3";
}

async function writeAtomic(file, data) {
    const part = `${file}.part`;
    await writeFile(part, data);
    await rename(part, file);
}

// Writes one kept sample; returns the number of .osu files written.
export async function saveSample(outRoot, { seq, audio, picks }) {
    const counts = new Map();
    for (const p of picks) {
        const id = validId(p.bm.beatmapset_id);
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const setId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const dir = path.join(outRoot, String(setId ?? `seq-${seq}`));
    await mkdir(dir, { recursive: true });
    const audioName = `${seq}.${audioExt(audio.data, audio.ext)}`;
    const audioPath = path.join(dir, audioName);
    const existing = await stat(audioPath).catch(() => null);
    if (existing?.size !== audio.data.length) await writeAtomic(audioPath, audio.data);
    let written = 0;
    for (const { bm } of picks) {
        const beatmapId = validId(bm.beatmap_id);
        const name = beatmapId ? `${beatmapId}.osu` : `${seq}-${written}.osu`;
        const text = prepareOsu(bm.content, { audioName, beatmapId, beatmapsetId: validId(bm.beatmapset_id) });
        await writeAtomic(path.join(dir, name), text);
        written++;
    }
    return { dir, audioName, written };
}

// ---- Hugging Face listing -----------------------------------------------------------------------------------

async function getJson(fetchImpl, url) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
        if ((res.status === 429 || res.status >= 500) && attempt < 5) {
            await sleep(retryAfterMs(res, 30_000));
            continue;
        }
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return { body: await res.json(), link: res.headers.get("link") };
    }
}

async function listTree(fetchImpl, dir) {
    const out = [];
    let url = `${API}/tree/main${dir ? `/${dir}` : ""}`;
    while (url) {
        const { body, link } = await getJson(fetchImpl, url);
        if (!Array.isArray(body)) throw new Error(`unexpected tree listing for ${dir || "/"}`);
        out.push(...body);
        url = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
    }
    return out;
}

// Variant folders with their shard counts and sizes; picks the requested one, else the smaller "compressed".
export async function listShards({ fetchImpl = globalThis.fetch, variant } = {}) {
    const root = await listTree(fetchImpl, "");
    const folders = root.filter((e) => e.type === "directory").map((e) => e.path);
    const variants = {};
    for (const folder of folders) {
        const shards = (await listTree(fetchImpl, folder))
            .filter((e) => e.type === "file" && /\.tar$/i.test(e.path) && safeTarName(e.path) === e.path)
            .map((e) => ({ path: e.path, size: Number(e.lfs?.size ?? e.size) || 0 }))
            .sort((a, b) => a.path.localeCompare(b.path));
        if (shards.length) variants[folder] = { shards, count: shards.length, bytes: shards.reduce((s, x) => s + x.size, 0) };
    }
    const chosen = variant ?? (variants.compressed ? "compressed" : Object.keys(variants).sort((a, b) => variants[a].bytes - variants[b].bytes)[0]);
    if (!variants[chosen]) throw new Error(`variant "${chosen}" not found; the dataset has: ${Object.keys(variants).join(", ") || "nothing"}`);
    return { variant: chosen, shards: variants[chosen].shards, variants };
}

// ---- streaming one shard --------------------------------------------------------------------------------------

function retryAfterMs(res, fallback) {
    const h = res.headers.get("retry-after");
    if (!h) return fallback;
    const s = Number(h);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 3600_000);
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(1000, Math.min(t - Date.now(), 3600_000)) : fallback;
}

// The response body as an async iterable that aborts the request when nothing arrives for idleMs.
async function* idleGuard(body, controller, idleMs) {
    let timer = setTimeout(() => controller.abort(new Error(`no data for ${idleMs / 1000}s`)), idleMs);
    try {
        for await (const chunk of body) {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(new Error(`no data for ${idleMs / 1000}s`)), idleMs);
            yield chunk;
        }
    } finally {
        clearTimeout(timer);
    }
}

class FatalError extends Error {}

// Opens the shard at byte `from` (a Range request). Waits out 429 / 503 with their Retry-After.
async function openShard({ url, from, fetchImpl, expectSize, log, label }) {
    for (let waits = 0; ; waits++) {
        const controller = new AbortController();
        const headers = { "user-agent": USER_AGENT };
        if (from > 0) headers.range = `bytes=${from}-`;
        const res = await fetchImpl(url, { headers, redirect: "follow", signal: controller.signal });
        if ((res.status === 429 || res.status === 503) && waits < 20) {
            const ms = retryAfterMs(res, 60_000);
            log(`${label}: HTTP ${res.status}, waiting ${Math.round(ms / 1000)}s`);
            await res.body?.cancel().catch(() => {});
            await sleep(ms);
            continue;
        }
        if (res.status === 404 || res.status === 403 || res.status === 401) throw new FatalError(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let skipBytes = 0;
        let total = null;
        if (from > 0 && res.status === 206) {
            const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(res.headers.get("content-range") ?? "");
            if (!m || Number(m[1]) !== from) throw new Error(`bad Content-Range "${res.headers.get("content-range")}"`);
            if (m[2] !== "*") total = Number(m[2]);
        } else {
            if (from > 0) skipBytes = from; // the server ignored Range: drop what we already had
            total = Number(res.headers.get("content-length")) || null;
        }
        if (expectSize && total && total !== expectSize) throw new FatalError(`size ${total}, the listing said ${expectSize}`);
        return { body: res.body, controller, skipBytes, baseOffset: from > 0 && !skipBytes ? from : 0 };
    }
}

/**
 * Streams one shard and keeps the 4K rice samples. Resumes inside the shard with a Range request when the
 * connection drops (from the first header of the sample that was in progress), so nothing is counted twice.
 */
export async function processShard({ shard, outRoot, fetchImpl = globalThis.fetch, log = defaultLog, idleMs = IDLE_MS,
    maxRetries = MAX_RETRIES, retryDelayMs = 5000, baseUrl = RESOLVE }) {
    const url = `${baseUrl}/${shard.path.split("/").map(encodeURIComponent).join("/")}`;
    const label = shard.path;
    const c = { samples: 0, kept: 0, diffs: 0, mania4kSeen: 0, rejectedLn: 0, rejectedShort: 0, noAudio: 0, skipped: 0 };
    const started = Date.now();
    let resumeAt = 0;
    let group = null;

    const flush = async (g) => {
        if (!g) return;
        c.samples++;
        if (g.picks?.length) {
            if (!g.audio) c.noAudio++;
            else {
                const r = await saveSample(outRoot, { seq: g.seq, audio: g.audio, picks: g.picks });
                c.kept++;
                c.diffs += r.written;
            }
        }
        if (c.samples % LOG_EVERY === 0) log(`${label}: ${c.samples} samples, kept ${c.kept} (${c.diffs} 4K diffs)`);
    };

    for (let failures = 0; ;) {
        let stream;
        try {
            stream = await openShard({ url, from: resumeAt, fetchImpl, expectSize: shard.size || null, log, label });
            group = null;
            const entries = readTar(idleGuard(stream.body, stream.controller, idleMs), {
                baseOffset: stream.baseOffset, skipBytes: stream.skipBytes, maxEntrySize: MAX_AUDIO,
            });
            for await (const entry of entries) {
                if (entry.type !== "file") continue;
                const name = safeTarName(entry.name);
                const parts = name && splitKey(name);
                if (!parts) { c.skipped++; continue; }
                if (!group || group.key !== parts.key) {
                    try { await flush(group); } catch (e) { throw new FatalError(`writing ${group.seq}: ${e.message}`); }
                    resumeAt = entry.headerOffset;
                    const seq = parts.key.slice(parts.key.lastIndexOf("/") + 1);
                    group = { key: parts.key, seq: /^[A-Za-z0-9_-]{1,64}$/.test(seq) ? seq : null, picks: null, audio: null };
                    if (!group.seq) c.skipped++;
                }
                if (!group.seq) continue;
                if (parts.ext === "json") {
                    if (entry.size > MAX_JSON) { group.picks = []; continue; }
                    let meta;
                    try { meta = parseLooseJson((await entry.read()).toString("utf8")); } catch { group.picks = []; continue; }
                    group.picks = [];
                    for (const bm of Array.isArray(meta?.beatmaps) ? meta.beatmaps : []) {
                        const r = rice4k(bm);
                        if (r.reason !== "mode" && r.reason !== "keys" && r.reason !== "no chart") c.mania4kSeen++;
                        if (r.reason === "ln") c.rejectedLn++;
                        if (r.reason === "short") c.rejectedShort++;
                        if (r.ok) group.picks.push({ bm });
                    }
                    if (!group.picks.length) group.audio = null; // audio that came first is dropped
                } else if (AUDIO_EXT.has(parts.ext)) {
                    if (group.picks && !group.picks.length) continue; // rejected already: let it stream past
                    if (entry.size > MAX_AUDIO || entry.size === 0) continue;
                    group.audio = { data: await entry.read(), ext: parts.ext };
                }
            }
            try { await flush(group); } catch (e) { throw new FatalError(`writing ${group?.seq}: ${e.message}`); }
            group = null;
            const sec = Math.round((Date.now() - started) / 1000);
            log(`${label}: done in ${sec}s, ${c.samples} samples, kept ${c.kept} with ${c.diffs} 4K rice diffs (${c.mania4kSeen} 4K seen, ${c.rejectedLn} LN, ${c.rejectedShort} short)`);
            return { ...c, sec };
        } catch (error) {
            stream?.controller.abort();
            if (error instanceof FatalError || ++failures > maxRetries) throw error;
            const wait = Math.min(retryDelayMs * 2 ** (failures - 1), 120_000);
            log(`${label}: ${error.message}; resuming at byte ${resumeAt} in ${Math.round(wait / 1000)}s (try ${failures}/${maxRetries})`);
            await sleep(wait);
        }
    }
}

// ---- whole run --------------------------------------------------------------------------------------------------

export async function readState(stateFile) {
    const text = await readFile(stateFile, "utf8").catch(() => "");
    const done = new Map();
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            if (r.ok && r.shard) done.set(r.shard, r);
        } catch { /* a torn last line from a killed run */ }
    }
    return done;
}

export function refuseSongs(outRoot) {
    const parts = path.resolve(outRoot).split(/[\\/]+/).map((p) => p.toLowerCase());
    if (parts.includes("songs")) throw new Error(`refusing to write into a Songs folder: ${outRoot}`);
}

export async function run({ outRoot, variant, limit = Infinity, lanes = 2, only = null, fetchImpl = globalThis.fetch,
    log = defaultLog, retryDelayMs, baseUrl } = {}) {
    refuseSongs(outRoot);
    await mkdir(outRoot, { recursive: true });
    const listing = await listShards({ fetchImpl, variant });
    for (const [name, v] of Object.entries(listing.variants)) log(`variant ${name}: ${v.count} shards, ${(v.bytes / 1e9).toFixed(1)} GB`);
    log(`using ${listing.variant}`);
    const stateFile = path.join(outRoot, "state.jsonl");
    const done = await readState(stateFile);
    let todo = listing.shards.filter((s) => !done.has(s.path));
    if (only?.length) todo = todo.filter((s) => only.some((o) => s.path.includes(o)));
    todo = todo.slice(0, Number.isFinite(limit) ? limit : undefined);
    log(`${done.size} shards done before, ${todo.length} to fetch now (${(todo.reduce((s, x) => s + x.size, 0) / 1e9).toFixed(1)} GB)`);
    const results = [];
    let next = 0;
    const lane = async () => {
        while (next < todo.length) {
            const shard = todo[next++];
            const record = { shard: shard.path, variant: listing.variant, size: shard.size };
            try {
                Object.assign(record, { ok: true }, await processShard({ shard, outRoot, fetchImpl, log, retryDelayMs, baseUrl }));
            } catch (error) {
                Object.assign(record, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
                log(`${shard.path}: failed: ${record.error}`);
            }
            record.at = new Date().toISOString();
            await appendFile(stateFile, `${JSON.stringify(record)}\n`, "utf8");
            results.push(record);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(3, lanes)) }, lane));
    const all = [...done.values(), ...results.filter((r) => r.ok)];
    const diffs = all.reduce((s, r) => s + (r.diffs ?? 0), 0);
    const bytes = all.reduce((s, r) => s + (r.size ?? 0), 0);
    if (all.length) {
        const total = listing.shards.reduce((s, x) => s + x.size, 0);
        log(`so far ${all.length}/${listing.shards.length} shards: ${diffs} 4K rice diffs; at this rate the whole variant gives about ${Math.round(diffs * total / Math.max(1, bytes))}`);
    }
    return { variant: listing.variant, results, done: all.length, shards: listing.shards.length };
}

// One copy per output folder: a second run would rewrite the same files.
async function takeLock(outRoot) {
    const lock = path.join(outRoot, "fetch-hf.lock");
    const old = Number(await readFile(lock, "utf8").catch(() => ""));
    if (old && old !== process.pid) {
        let alive = false;
        try { process.kill(old, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
        if (alive) throw new Error(`another fetch-hf-osu (pid ${old}) is using ${outRoot}`);
    }
    const fh = await open(lock, "w");
    await fh.writeFile(String(process.pid));
    await fh.close();
    return async () => { await rm(lock, { force: true }); };
}

export function parseArgs(argv) {
    const opts = { outRoot: "A:/SneezeyTrain/hf", variant: undefined, limit: Infinity, lanes: 2, only: null };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (a === "--variant") opts.variant = value();
        else if (a === "--limit") opts.limit = Number(value());
        else if (a === "--lanes") opts.lanes = Number(value());
        else if (a === "--shard") opts.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else rest.push(a);
    }
    if (rest[0]) opts.outRoot = rest[0];
    if (opts.variant && !/^[a-z0-9_-]+$/i.test(opts.variant)) throw new Error("bad --variant");
    if (!(opts.limit > 0)) throw new Error("--limit must be a positive number");
    if (!(opts.lanes >= 1)) throw new Error("--lanes must be 1–3");
    return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
    const opts = parseArgs(process.argv.slice(2));
    refuseSongs(opts.outRoot);
    await mkdir(opts.outRoot, { recursive: true });
    const release = await takeLock(opts.outRoot);
    try {
        await run(opts);
    } finally {
        await release();
    }
}
