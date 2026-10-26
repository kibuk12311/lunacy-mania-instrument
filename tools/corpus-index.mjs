// One index over every training source for the 4K rice mapper: osu! Songs, tracker sets, HuggingFace ranked/loved,
// the Ranked + Loved 2013-2025 archive, Drive + Dan Reform packs, converted Etterna charts and Malody converts. Each
// root is Songs-like (one folder per set/song holding .osu files and audio). Keeps osu!mania 4K rice charts (Mode 3,
// CircleSize 4, 100+ objects, at most 15% long notes)
// whose audio exists, removes duplicates (same chart at any rate, mirrored or not), groups charts by song and splits
// the song groups into train / heldout / quarantine. Train on split === "train" only: a "quarantine" group is a
// train-side group that looks like a held-out song under looser rules (see leakGuard) and is used for neither.
//
// Usage: node tools/corpus-index.mjs [outFile=A:/SneezeyTrain/corpus/corpus.jsonl] [--workers N] [--calc-dan]
//          [--full] [--fresh-split] [--extra-heldout 0.04] [--seed corpus-v1]
//          [--songs DIR] [--sets DIR] [--hf DIR] [--ranked DIR] [--packs DIR] [--etterna DIR] [--malody DIR]
//                                                                                     (a root "-" is skipped)
//          [--manifest FILE] [--hf-meta FILE] [--etterna-packs DIR] [--malody-packs DIR] [--heldout FILE] [--cache FILE]
//          [--fp-dir DIR] [--ffmpeg PATH] [--no-fingerprint]
//   <outFile>                one line per unique chart (duplicates listed inside the line)
//   <outDir>/summary.json    counts per source, per dan bin, duplicates, held-out size
//   <outDir>/cache.jsonl     per .osu file (path, mtime, size → parsed chart or reject reason), per audio file key;
//                            a re-run only reads files that are new or changed (--full ignores the cache)
//   <outDir>/fp/             Chromaprint fingerprint per audio key (ffmpeg's chromaprint muxer; an empty file = the
//                            audio did not decode), for the leak guard's audio rule. Without ffmpeg the guard falls
//                            back to its metadata rules alone.
// Roots are only read, never written. The held-out split is sticky: song keys that were held out by the previous
// output stay held out (--fresh-split ignores that), so a growing corpus never moves a song from heldout to train.
// Each line also carries its training `weight` (src/corpus/weights.js: per song group, source, pack, creator and dan
// bin; computed over the train split, and separately over the held-out split; 0 in quarantine), its `pack` and its
// `creatorKey`. Lines are written with tools/lib/jsonl.mjs, so Python's str.splitlines() cannot break them.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { createReadStream, readFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { readdir, readFile, writeFile, stat, open, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLine } from "./lib/jsonl.mjs";
import { corpusWeights, packKeyOf, creatorKeyOf, creatorIdsFromMeta } from "../src/corpus/weights.js";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.join(path.dirname(SELF), "..");

export const DEFAULTS = {
    out: "A:/SneezeyTrain/corpus/corpus.jsonl",
    roots: {
        hf: "A:/SneezeyTrain/hf",
        ranked: "A:/SneezeyTrain/ranked/sets",
        sets: "A:/SneezeyTrain/sets",
        songs: "A:/Games/osu!/Songs",
        packs: "A:/SneezeyTrain/packs/sets",
        etterna: "A:/SneezeyTrain/etterna/songs",
        malody: "A:/SneezeyTrain/malody/songs",
    },
    manifest: "A:/SneezeyTrain/manifest.json",
    hfMeta: "A:/SneezeyTrain/hf-meta/metadata.csv",
    etternaPacks: "A:/SneezeyTrain/etterna/packs",
    malodyPacks: "A:/SneezeyTrain/malody/packs",
    heldout: path.join(REPO_ROOT, "data/mapper/heldout.json"),
    extraHeldout: 0.04,
    seed: "corpus-v1",
    ffmpeg: "ffmpeg",
};

// Preference when the same chart appears more than once (lower wins). Ranked/loved anywhere (HF, the Ranked + Loved
// archive, or an .osu whose md5 is a ranked/loved difficulty in metadata.csv) counts as tier 0; Malody converts are
// .sm converts like the Etterna packs and share their tier. Within a tier SOURCE_ORDER decides (HF before the archive,
// Etterna before Malody).
export const SOURCE_TIER = { hf: 0, ranked: 0, sets: 1, songs: 2, packs: 3, etterna: 4, malody: 4 };
export const SOURCE_ORDER = ["hf", "ranked", "sets", "songs", "packs", "etterna", "malody"];
const SOURCE_RANK = Object.fromEntries(SOURCE_ORDER.map((s, i) => [s, i]));
const RANKED_SOURCES = new Set(["hf", "ranked"]);

const MIN_OBJECTS = 100;
const MAX_LN_SHARE = 0.15;
const AUDIO_HASH_BYTES = 1024 * 1024;
const MAX_OSU_BYTES = 16 * 1024 * 1024;
const ROW_MERGE_MS = 1;
const SHARED_AUDIO_MAX_SONGS = 8; // an audio key shared by more song keys than this (silence, placeholder) does not join groups
const CACHE_VERSION = 2; // of the .osu entries (v2: ArtistUnicode / TitleUnicode)

const norm = (p) => p.replace(/\\/g, "/");
const sha1 = (x) => createHash("sha1").update(x).digest("hex");
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// ---- .osu parsing ---------------------------------------------------------------------------------------------

export function parseOsu(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const head = {};
    const timing = [];
    const objects = [];
    let section = "";
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("//")) continue;
        if (line[0] === "[" && line.endsWith("]")) { section = line.slice(1, -1); continue; }
        if (section === "HitObjects") {
            const p = line.split(",");
            if (p.length < 4) continue;
            const x = Number(p[0]);
            const t = Number(p[2]);
            const type = Number(p[3]);
            if (!Number.isFinite(x) || !Number.isFinite(t)) continue;
            objects.push({ x, t, ln: (type & 128) !== 0 });
        } else if (section === "TimingPoints") {
            const p = line.split(",");
            const t = Number(p[0]);
            const beatLength = Number(p[1]);
            const uninherited = p.length < 7 ? true : p[6].trim() === "1";
            if (uninherited && Number.isFinite(t) && beatLength > 0) timing.push({ t, beatLength });
        } else if (section === "General" || section === "Metadata" || section === "Difficulty") {
            const i = line.indexOf(":");
            if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
    }
    return { head, timing, objects };
}

// Rows: objects at the same time (±1 ms) with a 4-bit column mask; only heads count (LN tails are ignored).
export function toRows(objects, keys = 4) {
    const notes = objects.map((o) => ({ t: o.t, c: Math.min(keys - 1, Math.max(0, Math.floor((o.x * keys) / 512))) }))
        .sort((a, b) => a.t - b.t);
    const rows = [];
    for (const n of notes) {
        const last = rows[rows.length - 1];
        if (last && n.t - last.t <= ROW_MERGE_MS) last.mask |= 1 << n.c;
        else rows.push({ t: n.t, mask: 1 << n.c });
    }
    return rows;
}

const MIRROR4 = Array.from({ length: 16 }, (_, m) => ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3));

// Rate- and mirror-invariant chart key: masks plus inter-row gaps measured in units of the typical gap (median, then
// refined as the mean of gaps within ±15% of it), quantised to 1/12 (log-scale above 8 units, so breaks survive
// ms rounding). The key is the smaller hash of the sequence and its column mirror.
export function chartKey(rows) {
    if (rows.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!(median > 0)) return null;
    let sum = 0;
    let n = 0;
    for (const g of gaps) if (g >= median * 0.85 && g <= median * 1.15) { sum += g; n++; }
    const unit = sum / n;
    const q = gaps.map((g) => {
        const r = g / unit;
        return r <= 8 ? Math.round(r * 12) : 1000 + Math.round(Math.log2(r) * 16);
    });
    const plain = Buffer.alloc(rows.length * 3);
    const mirror = Buffer.alloc(rows.length * 3);
    for (let i = 0; i < rows.length; i++) {
        const g = i < q.length ? q[i] : 0;
        plain[i * 3] = rows[i].mask;
        mirror[i * 3] = MIRROR4[rows[i].mask];
        plain.writeUInt16LE(g, i * 3 + 1);
        mirror.writeUInt16LE(g, i * 3 + 1);
    }
    const a = sha1(plain);
    const b = sha1(mirror);
    return (a < b ? a : b).slice(0, 24);
}

// Rate written in a version / file name: "1.2x", "x1.2", "[1.25x]", "1,2x", "Rate 1.2", "1_1x" (audio names).
export function rateFromText(text) {
    if (!text) return null;
    const s = String(text).toLowerCase();
    const pats = [
        /(?:^|[^\w.])(\d(?:[.,]\d{1,3})?)\s*x(?![a-z0-9])/,
        /(?:^|[^\w])x\s*(\d(?:[.,]\d{1,3})?)(?![\d.])/,
        /\brate\s*[:=]?\s*(\d(?:[.,]\d{1,3})?)(?![\d.])/,
        /(?:^|[^\d])(\d)_(\d{1,3})x(?![a-z0-9])/,
    ];
    for (let i = 0; i < pats.length; i++) {
        const re = new RegExp(pats[i].source, "g");
        let m;
        while ((m = re.exec(s))) {
            const v = i === 3 ? Number(`${m[1]}.${m[2]}`) : Number(m[1].replace(",", "."));
            // A bare integer ("repeated 3x", "x2 collab") is a rate only when it stands alone in brackets or as "Rate 2".
            if (i < 2 && /^\d$/.test(m[1]) && !new RegExp(`[\\[(]\\s*(?:${m[1]}\\s*x|x\\s*${m[1]})\\s*[\\])]`).test(s)) continue;
            if (v >= 0.5 && v <= 3) return v;
        }
    }
    return null;
}

const RATE_TOKEN = /[\[({]?\s*(?:\d(?:[.,]\d{1,3})?\s*x(?![a-z0-9])|\bx\s*\d(?:[.,]\d{1,3})?(?![\d.])|\brate\s*\d(?:[.,]\d{1,3})?)(?:\s*rate)?\s*[\])}]?/giu;
const MARKER_WORDS = /\b(speed\s*up|sped\s*up|nightcore|slowed|cut|short|tv\s*size|tv\s*ver|full|extended|long|game|size|ver\.?|version|edit|bpm|rate|mix(?:ed)?\s*ver|radio|feat\.?|ft\.?)(?![\p{L}])/iu;
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/iu;

function stripMarkers(s) {
    let x = String(s ?? "").normalize("NFKC").toLowerCase();
    x = x.replace(RATE_TOKEN, " ");
    // Bracketed groups that only describe the cut / speed of the audio (keep "(Cranky Remix)" and the like).
    x = x.replace(/[\[(（【{][^\])）】}]*[\])）】}]/gu, (g) => (MARKER_WORDS.test(g) ? " " : g));
    x = x.replace(/[-~～]\s*(?:speed\s*up|sped\s*up|nightcore|cut\s*ver\.?|short\s*ver\.?|tv\s*size)\s*[-~～]?/giu, " ");
    x = x.replace(FEAT, "");
    return x;
}
const compact = (s) => s.replace(/[^\p{L}\p{N}]+/gu, "");

const VARIOUS = new Set(["variousartists", "variousartist", "various", "va", "variosartists", "variousartistes"]);
export function isPackLike(artist, title) {
    return VARIOUS.has(compact(String(artist ?? "").normalize("NFKC").toLowerCase())) || /\bpacks?\b/i.test(String(title ?? ""));
}

// SONG key: normalised artist + title without rate / speed-up / cut markers and featured artists. Pack charts
// ("Various Artists - X Pack") name the song in the difficulty: there the key comes from the version text.
export function songKey({ artist, title, version }) {
    if (isPackLike(artist, title)) {
        let v = String(version ?? "").normalize("NFKC").toLowerCase();
        v = v.replace(/^\s*[\[(][^\])]*[\])]\s*/u, ""); // leading [mapper] / (pack tag)
        // trailing (High) / [Lv.20] / ([Crz]Rachel), possibly several
        for (let prev = ""; prev !== v;) { prev = v; v = v.replace(/\s*(?:\((?:[^()]|\[[^\]]*\])*\)|\[[^\[\]]*\])\s*$/u, ""); }
        v = stripMarkers(v);
        v = v.replace(/\b(?:lv\.?\s*\d+|\d+k|easy|normal|hard|insane|expert|challenge|beginner|another|hyper|\d+)\b/giu, " ");
        const c = compact(v);
        if (c.length >= 3) return `p:${c}`;
        return `p:${compact(stripMarkers(title))}|${compact(String(version ?? "").toLowerCase())}`;
    }
    const a = compact(stripMarkers(artist));
    const t = compact(stripMarkers(title));
    return `${a}|${t}`;
}

// Other spellings of the same song key from the .osu's ArtistUnicode / TitleUnicode (romaji "Senbonzakura" and
// "千本桜" are one song): every artist × title combination of the romanised and the unicode fields, primary key
// excluded. A copy that only knows the kanji title (an old conversion) meets the romaji chart in "artist|千本桜".
export function songKeyAlts(c) {
    if (isPackLike(c.artist, c.title)) return [];
    const primary = c.songKey ?? songKey(c);
    const artists = [...new Set([c.artist, c.artistUnicode].map((x) => compact(stripMarkers(x))).filter(Boolean))];
    const titles = [...new Set([c.title, c.titleUnicode].map((x) => compact(stripMarkers(x))).filter(Boolean))];
    const out = new Set();
    for (const a of artists) {
        if (VARIOUS.has(a)) continue;
        for (const t of titles) out.add(`${a}|${t}`);
    }
    out.delete(primary);
    return [...out];
}

function dominantBpm(timing, firstT, lastT) {
    if (!timing.length) return null;
    const dur = new Map();
    const tp = [...timing].sort((a, b) => a.t - b.t);
    for (let i = 0; i < tp.length; i++) {
        const s = Math.max(tp[i].t, i === 0 ? firstT : tp[i].t);
        const e = i + 1 < tp.length ? Math.min(tp[i + 1].t, lastT) : lastT;
        const k = Math.round(tp[i].beatLength * 1000);
        dur.set(k, (dur.get(k) ?? 0) + Math.max(0, e - s));
    }
    let best = null;
    let bestDur = -1;
    for (const [k, d] of dur) if (d > bestDur) { best = k; bestDur = d; }
    return best ? round(60000 / (best / 1000), 3) : null;
}

const intOrNull = (s) => (/^\d+$/.test(String(s ?? "").trim()) && Number(s) > 0 ? Number(s) : null);

// Filter + describe one .osu file. Returns { rec } or { reject }.
export async function describeChart(osuPath, source, text) {
    const { head, timing, objects } = parseOsu(text);
    if (Number(head.Mode) !== 3) return { reject: "mode" };
    if (Number(head.CircleSize) !== 4) return { reject: "keys" };
    if (objects.length < MIN_OBJECTS) return { reject: "short" };
    const lnShare = objects.filter((o) => o.ln).length / objects.length;
    if (lnShare > MAX_LN_SHARE) return { reject: "ln" };
    const audioName = head.AudioFilename;
    // A "no-audio" reject names the file it looked for (null: none named), so a re-run can see when it arrives.
    if (!audioName || audioName.toLowerCase() === "virtual") return { reject: "no-audio", audio: null };
    if (/[\\/]\.\.[\\/]|^\.\.[\\/]|^[a-z]:|^[\\/]/i.test(audioName)) return { reject: "audio-path" };
    const audioPath = norm(path.join(path.dirname(osuPath), audioName));
    const audioStat = await stat(audioPath).catch(() => null);
    if (!audioStat?.isFile()) return { reject: "no-audio", audio: audioPath };
    const rows = toRows(objects);
    const key = chartKey(rows);
    if (!key) return { reject: "degenerate" };
    const spanMs = rows[rows.length - 1].t - rows[0].t;
    return {
        rec: {
            source,
            osu: norm(osuPath),
            folder: path.basename(path.dirname(osuPath)),
            audio: audioPath,
            audioSize: audioStat.size,
            audioMtime: audioStat.mtimeMs,
            md5: createHash("md5").update(text, "utf8").digest("hex"),
            beatmapId: intOrNull(head.BeatmapID),
            beatmapSetId: intOrNull(head.BeatmapSetID),
            artist: head.Artist ?? "",
            title: head.Title ?? "",
            artistUnicode: head.ArtistUnicode ?? "",
            titleUnicode: head.TitleUnicode ?? "",
            creator: head.Creator ?? "",
            version: head.Version ?? "",
            objects: objects.length,
            rows: rows.length,
            lnShare: round(lnShare, 4),
            spanMs,
            bpm: dominantBpm(timing, rows[0].t, rows[rows.length - 1].t),
            chartKey: key,
        },
    };
}

// AUDIO key: byte size + sha1 of the first MiB (no decoding).
export async function audioKey(file, size) {
    const fh = await open(file, "r");
    try {
        const buf = Buffer.alloc(Math.min(AUDIO_HASH_BYTES, size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return `${size}:${sha1(buf.subarray(0, bytesRead)).slice(0, 20)}`;
    } finally {
        await fh.close();
    }
}

// AUDIO fingerprint: Chromaprint (ffmpeg's chromaprint muxer, raw 32-bit values, one per ~0.124 s). Survives another
// encode and a cut (TV size, game version); not a rate change with pitch. Stored per audio key: <dir>/ab/<hash>.fp.
export const fpFile = (dir, audioKey) => {
    const h = sha1(audioKey).slice(0, 24);
    return norm(path.join(dir, h.slice(0, 2), `${h}.fp`));
};
const FP_TIMEOUT_MS = 180_000;
function fingerprintTo(audio, file, ffmpeg) {
    return new Promise((resolve) => {
        execFile(ffmpeg, ["-v", "error", "-nostdin", "-i", audio, "-vn", "-ac", "1", "-ar", "11025", "-f", "chromaprint", "-fp_format", "raw", "-"],
            { encoding: "buffer", maxBuffer: 1 << 26, timeout: FP_TIMEOUT_MS, windowsHide: true }, async (err, stdout) => {
                // an empty file marks audio that did not decode, so it is not tried again on every run
                const buf = err || !stdout ? Buffer.alloc(0) : stdout.subarray(0, stdout.length & ~3);
                try {
                    await mkdir(path.dirname(file), { recursive: true });
                    await writeFile(`${file}.tmp`, buf);
                    await rename(`${file}.tmp`, file);
                    resolve(buf.length > 0);
                } catch { resolve(false); }
            });
    });
}
export function readFingerprint(file) {
    let b;
    try { b = readFileSync(file); } catch { return undefined; }
    if (b.length < 4) return null;
    return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3)));
}
export function ffmpegHasChromaprint(ffmpeg) {
    try {
        const r = spawnSync(ffmpeg, ["-hide_banner", "-h", "muxer=chromaprint"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
        return r.status === 0 && /fp_format/.test(`${r.stdout}${r.stderr}`);
    } catch { return false; }
}

// ---- worker ---------------------------------------------------------------------------------------------------

// An unchanged .osu still depends on its audio file, which may arrive or still be growing after the .osu (the sets
// folder keeps downloading). Returns the hit (with the audio file's current size + mtime for a chart) or null when
// the .osu must be read again: a "no-audio" reject whose audio now exists (or an old entry that did not name it),
// or a chart whose audio is gone.
async function cacheHit(c) {
    if (c.r === "no-audio") {
        if (c.a === null) return { hit: true };
        if (c.a === undefined) return null;
        return (await stat(c.a).catch(() => null))?.isFile() ? null : { hit: true };
    }
    if (!c.a) return { hit: true };
    const as = await stat(c.a).catch(() => null);
    return as?.isFile() ? { hit: true, az: as.size, am: as.mtimeMs } : null;
}

async function workerMain() {
    let analyzeChart = null;
    parentPort.on("message", async (job) => {
        if (job.type === "stop") { process.exit(0); }
        try {
            if (job.type === "dirs") {
                const out = [];
                for (const { dir, source, cached } of job.dirs) {
                    const names = await readdir(dir).catch(() => []);
                    for (const name of names) {
                        if (!name.toLowerCase().endsWith(".osu")) continue;
                        const p = norm(path.join(dir, name));
                        const st = await stat(p).catch(() => null);
                        if (!st?.isFile()) continue;
                        const c = cached?.[p];
                        if (c && c.m === st.mtimeMs && c.z === st.size) {
                            const hit = await cacheHit(c);
                            if (hit) { out.push({ p, ...hit }); continue; }
                        }
                        let entry;
                        if (st.size > MAX_OSU_BYTES) entry = { p, m: st.mtimeMs, z: st.size, r: "big" };
                        else {
                            try {
                                const text = await readFile(p, "utf8");
                                const d = await describeChart(p, source, text);
                                entry = { p, m: st.mtimeMs, z: st.size, ...(d.rec ? { c: d.rec } : { r: d.reject }) };
                                if (d.audio !== undefined) entry.a = d.audio;
                            } catch (e) {
                                entry = { p, m: st.mtimeMs, z: st.size, r: "error", e: String(e?.message ?? e).slice(0, 200) };
                            }
                        }
                        out.push(entry);
                    }
                }
                parentPort.postMessage({ id: job.id, out });
            } else if (job.type === "audio") {
                const out = [];
                for (const a of job.files) {
                    try { out.push({ ...a, k: await audioKey(a.p, a.z) }); } catch { out.push({ ...a, k: null }); }
                }
                parentPort.postMessage({ id: job.id, out });
            } else if (job.type === "fp") {
                const out = [];
                for (const a of job.files) out.push({ key: a.key, ok: await fingerprintTo(a.p, a.file, job.ffmpeg) });
                parentPort.postMessage({ id: job.id, out });
            } else if (job.type === "dan") {
                if (!analyzeChart) ({ analyzeChart } = await import("../src/core/analyze.js"));
                const out = [];
                for (const p of job.files) {
                    try {
                        const r = await analyzeChart(await readFile(p, "utf8"), 1);
                        out.push({ p, dan: r.kind === "ok" ? r.numeric : null });
                    } catch { out.push({ p, dan: null }); }
                }
                parentPort.postMessage({ id: job.id, out });
            }
        } catch (e) {
            parentPort.postMessage({ id: job.id, error: String(e?.stack ?? e) });
        }
    });
}

class Pool {
    constructor(n) {
        this.workers = Array.from({ length: n }, () => new Worker(SELF, { workerData: { corpusWorker: true } }));
        this.idle = [...this.workers];
        this.queue = [];
        this.pending = new Map();
        this.nextId = 1;
        for (const w of this.workers) {
            w.on("message", (msg) => {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                this.idle.push(w);
                this.pump();
                if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.out);
            });
            w.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); });
        }
    }
    run(job) {
        return new Promise((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.pump(); });
    }
    pump() {
        while (this.idle.length && this.queue.length) {
            const w = this.idle.pop();
            const { job, resolve, reject } = this.queue.shift();
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            w.postMessage({ ...job, id });
        }
    }
    async close() {
        for (const w of this.workers) w.postMessage({ type: "stop" });
        await Promise.all(this.workers.map((w) => new Promise((r) => w.once("exit", r))));
    }
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---- label sources --------------------------------------------------------------------------------------------

// Streaming CSV (quoted fields, "" escapes, newlines inside quotes). Calls onRow(fields[]) per record.
export async function readCsv(file, onRow) {
    let field = "";
    let row = [];
    let quoted = false;
    let pendingQuote = false;
    const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
    for await (const chunkText of stream) {
        for (let i = 0; i < chunkText.length; i++) {
            const ch = chunkText[i];
            if (quoted) {
                if (pendingQuote) {
                    pendingQuote = false;
                    if (ch === '"') { field += '"'; continue; }
                    quoted = false; // closing quote, fall through to the unquoted handling of ch
                } else if (ch === '"') { pendingQuote = true; continue; } else { field += ch; continue; }
            }
            if (ch === '"' && field === "") quoted = true;
            else if (ch === ",") { row.push(field); field = ""; } else if (ch === "\n") {
                row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
                onRow(row);
                row = [];
                field = "";
            } else field += ch;
        }
    }
    if (pendingQuote) quoted = false;
    if (field !== "" || row.length) { row.push(field); onRow(row); }
}

// osu! API v1 metadata (HF): 4K mania rows only → by beatmap_id and by file md5.
export async function loadHfMeta(file) {
    const byId = new Map();
    const byMd5 = new Map();
    if (!file || file === "-") return { byId, byMd5 };
    if (!(await stat(file).catch(() => null))) return { byId, byMd5 };
    let cols = null;
    await readCsv(file, (r) => {
        if (!cols) { cols = Object.fromEntries(r.map((n, i) => [n.trim(), i])); return; }
        if (r[cols.mode] !== "3" || Number(r[cols.diff_size]) !== 4) return;
        const id = Number(r[cols.beatmap_id]);
        if (!id) return;
        const num = (k) => (r[cols[k]] === undefined || r[cols[k]] === "" ? null : Number(r[cols[k]]));
        const m = {
            beatmapId: id,
            beatmapSetId: num("beatmapset_id"),
            approved: num("approved"),
            playcount: num("playcount"),
            passcount: num("passcount"),
            favouriteCount: num("favourite_count"),
            creator: r[cols.creator] ?? null,
            creatorId: num("creator_id"),
            md5: (r[cols.file_md5] ?? "").toLowerCase(),
            hitLength: num("hit_length"),
            year: Number(String(r[cols.approved_date] || r[cols.submit_date] || "").slice(0, 4)) || null,
        };
        byId.set(id, m);
        if (m.md5) byMd5.set(m.md5, m);
    });
    return { byId, byMd5 };
}

// Tracker manifest: per BeatmapID rawDan + MSD.
export async function loadTracker(file) {
    const byId = new Map();
    if (!file || file === "-") return byId;
    const text = await readFile(file, "utf8").catch(() => null);
    if (!text) return byId;
    for (const s of JSON.parse(text).sets ?? []) {
        for (const d of s.diffs ?? []) {
            if (!d.beatmapId) continue;
            byId.set(Number(d.beatmapId), { rawDan: d.dan ?? null, msd: d.msd ?? null, primary: d.primary ?? null, setId: s.setId });
        }
    }
    return byId;
}

// Etterna pack manifests: per converted .osu file (absolute path, lower-case) the chart's Etterna MSD. The Malody
// fetcher (tools/fetch-zip-packs.mjs) writes manifests of the same shape (msd null: the zips are only binned by MSD).
export async function loadEtterna(dir, songsRoot, byFile = new Map()) {
    if (!dir || dir === "-" || !songsRoot || songsRoot === "-") return byFile;
    const names = await readdir(dir).catch(() => []);
    for (const n of names.filter((x) => x.endsWith(".json"))) {
        let pack;
        try { pack = JSON.parse(await readFile(path.join(dir, n), "utf8")); } catch { continue; }
        for (const song of pack.songs ?? []) {
            for (const c of song.charts ?? []) {
                if (!song.folder || !c.file) continue;
                const p = norm(path.join(songsRoot, song.folder, c.file)).toLowerCase();
                byFile.set(p, { msd: c.msd ?? null, pack: pack.name ?? null, packId: pack.id ?? null, eoSongId: c.eoSongId ?? null });
            }
        }
    }
    return byFile;
}

// ---- dedupe, rate guesses, groups, split ---------------------------------------------------------------------

class UnionFind {
    constructor() { this.parent = new Map(); }
    find(x) {
        if (!this.parent.has(x)) this.parent.set(x, x);
        let r = x;
        while (this.parent.get(r) !== r) r = this.parent.get(r);
        while (this.parent.get(x) !== r) { const n = this.parent.get(x); this.parent.set(x, r); x = n; }
        return r;
    }
    union(a, b) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
}

const isOne = (r) => r === null || Math.abs(r - 1) < 0.02;

// Rate of every member of one chart-key group: against a reference member assumed at a known rate (md5 matches an
// osu! difficulty → 1.0; else the best member without a rate marker → 1.0; else a member with a marker).
export function guessRates(members) {
    const ref = members.find((m) => m.metaMd5) ?? members.find((m) => m.textRate === null) ?? members.find((m) => m.textRate);
    const refRate = ref.metaMd5 ? 1 : (ref.textRate ?? 1);
    for (const m of members) {
        if (m === ref || members.length === 1 || !(m.spanMs > 0) || !(ref.spanMs > 0)) {
            m.rate = m === ref ? refRate : (m.textRate ?? 1);
            m.rateFrom = m.metaMd5 ? "osu-md5" : m.textRate ? "text" : "default";
            continue;
        }
        const r = round((ref.spanMs * refRate) / m.spanMs, 2);
        // A written rate wins unless the reference is a known osu! original and the spans disagree.
        if (m.textRate && (!ref.metaMd5 || Math.abs(m.textRate - r) <= 0.05)) { m.rate = m.textRate; m.rateFrom = "text"; } else { m.rate = r; m.rateFrom = "sibling"; }
    }
}

export function danBin(labels) {
    const d = labels.rawDan ?? labels.calcDan;
    if (Number.isFinite(d)) return `dan:${String(Math.max(0, Math.min(20, Math.floor(d)))).padStart(2, "0")}`;
    if (Number.isFinite(labels.etternaMsd)) return `msd:${String(Math.min(40, Math.floor(labels.etternaMsd / 4) * 4)).padStart(2, "0")}`;
    return "none";
}

const median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

export function buildCorpus(charts, { tracker, hfMeta, etterna, heldoutFolders, stickySongKeys, extraHeldout, seed, calcDan, fingerprints = null, weightOpts = {} }) {
    const creatorIds = creatorIdsFromMeta(hfMeta.byId.values());
    // labels + ranked tier
    for (const c of charts) {
        const meta = hfMeta.byMd5.get(c.md5) ?? null;
        c.metaMd5 = !!meta;
        const metaById = c.beatmapId ? hfMeta.byId.get(c.beatmapId) : null;
        c.meta = meta ?? metaById ?? null;
        const approved = c.meta?.approved;
        c.ranked = RANKED_SOURCES.has(c.source) || (meta && [1, 2, 4].includes(approved));
        c.tier = c.ranked ? 0 : SOURCE_TIER[c.source];
        c.songKey = songKey(c);
        c.altKeys = songKeyAlts(c);
        c.textRate = rateFromText(c.version) ?? rateFromText(path.basename(c.audio)) ?? rateFromText(c.title);
    }
    // chart-key groups → kept + duplicates
    const byChart = new Map();
    for (const c of charts) {
        if (!byChart.has(c.chartKey)) byChart.set(c.chartKey, []);
        byChart.get(c.chartKey).push(c);
    }
    const kept = [];
    let duplicates = 0;
    for (const members of byChart.values()) {
        members.sort((a, b) => a.tier - b.tier || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.osu < b.osu ? -1 : 1));
        guessRates(members);
        members.sort((a, b) => (isOne(a.rate) ? 0 : 1) - (isOne(b.rate) ? 0 : 1) || a.tier - b.tier
            || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.osu < b.osu ? -1 : 1));
        const [k, ...rest] = members;
        k.dups = rest;
        duplicates += rest.length;
        kept.push(k);
    }
    // labels on the kept chart; filled from duplicates at rate 1 when the kept one has none
    for (const k of kept) {
        const labels = {
            rawDan: null, trackerMsd: null, trackerPrimary: null, etternaMsd: null,
            playcount: null, passcount: null, favouriteCount: null, approved: null, calcDan: null,
        };
        for (const m of [k, ...k.dups]) {
            if (!isOne(m.rate)) continue;
            const bid = m.beatmapId ?? (m.metaMd5 ? m.meta.beatmapId : null);
            const t = bid ? tracker.get(bid) : null;
            if (t && labels.rawDan === null) { labels.rawDan = t.rawDan; labels.trackerMsd = t.msd; labels.trackerPrimary = t.primary; }
            const e = etterna.get(m.osu.toLowerCase());
            if (e && labels.etternaMsd === null) labels.etternaMsd = e.msd;
            const meta = m.metaMd5 ? m.meta : (bid ? hfMeta.byId.get(bid) : null);
            if (meta && labels.playcount === null) {
                labels.playcount = meta.playcount; labels.passcount = meta.passcount;
                labels.favouriteCount = meta.favouriteCount; labels.approved = meta.approved;
            }
        }
        if (calcDan) labels.calcDan = calcDan.get(k.osu) ?? null;
        k.labels = labels;
        // what the weights cap: the chart's pack and its creator (src/corpus/weights.js)
        k.pack = packKeyOf({ source: k.source, folder: k.folder, packId: etterna.get(k.osu.toLowerCase())?.packId ?? null,
            packLike: isPackLike(k.artist, k.title), beatmapSetId: k.beatmapSetId ?? (k.metaMd5 ? k.meta.beatmapSetId : null) });
        k.creatorKey = creatorKeyOf({ source: k.source, creator: k.creator, creatorId: k.meta?.creatorId ?? null }, creatorIds);
    }
    // song groups: union of song keys, audio keys and chart keys over every chart (duplicates included)
    const audioSongs = new Map();
    for (const c of charts) {
        if (!c.audioKey) continue;
        if (!audioSongs.has(c.audioKey)) audioSongs.set(c.audioKey, new Set());
        audioSongs.get(c.audioKey).add(c.songKey);
    }
    const uf = new UnionFind();
    // A pack song ("p:<title from the version>") joins the songs whose own title is that title.
    const packTitles = new Set(charts.filter((c) => c.songKey.startsWith("p:")).map((c) => c.songKey.slice(2)));
    for (const c of charts) {
        const s = `s:${c.songKey}`;
        if (!c.songKey.startsWith("p:")) {
            for (const key of [c.songKey, ...c.altKeys]) {
                const t = key.slice(key.indexOf("|") + 1);
                if (t.length >= 5 && packTitles.has(t)) uf.union(s, `s:p:${t}`);
            }
        }
        for (const alt of c.altKeys) uf.union(s, `s:${alt}`);
        uf.union(s, `c:${c.chartKey}`);
        if (c.audioKey && audioSongs.get(c.audioKey).size <= SHARED_AUDIO_MAX_SONGS) uf.union(s, `a:${c.audioKey}`);
    }
    const titleJoins = joinSameTitle(charts, uf);
    const groups = new Map(); // root → { key, kept: [], songKeys:Set, seed:false, sticky:false }
    for (const k of kept) {
        const root = uf.find(`s:${k.songKey}`);
        if (!groups.has(root)) groups.set(root, { root, kept: [], songKeys: new Set(), seed: false, sticky: false });
        const g = groups.get(root);
        g.kept.push(k);
        for (const m of [k, ...k.dups]) {
            g.songKeys.add(m.songKey);
            if (heldoutFolders.has(m.folder)) g.seed = true;
            if (stickySongKeys.has(m.songKey)) g.sticky = true;
        }
    }
    for (const g of groups.values()) {
        g.key = [...g.songKeys].sort()[0];
        g.bin = danBin({
            rawDan: median(g.kept.map((k) => k.labels.rawDan)),
            calcDan: median(g.kept.map((k) => k.labels.calcDan)),
            etternaMsd: median(g.kept.map((k) => k.labels.etternaMsd)),
        });
        g.hash = sha1(`${seed}|${g.key}`);
    }
    // split: held-out seeds, then per dan bin ~extraHeldout of the groups (sticky ones first, then lowest hash)
    const byBin = new Map();
    for (const g of groups.values()) {
        if (!byBin.has(g.bin)) byBin.set(g.bin, []);
        byBin.get(g.bin).push(g);
    }
    for (const list of byBin.values()) {
        for (const g of list) g.split = g.seed ? "heldout" : "train";
        const target = Math.round(list.length * extraHeldout);
        let extra = 0;
        for (const g of list) if (!g.seed && g.sticky) { g.split = "heldout"; g.reason = "sticky"; extra++; }
        for (const g of list.filter((x) => x.split === "train").sort((a, b) => (a.hash < b.hash ? -1 : 1))) {
            if (extra >= target) break;
            g.split = "heldout"; g.reason = "extra"; extra++;
        }
        for (const g of list) if (g.seed) g.reason = "seed";
    }
    const leak = leakGuard([...groups.values()], { fingerprints });
    const weights = splitWeights([...groups.values()], weightOpts);
    return { kept, groups: [...groups.values()], duplicates, titleJoins, leak, weights };
}

const sig = (x, d = 5) => (Number.isFinite(x) ? Number(x.toPrecision(d)) : null);

// Training weight of every kept chart (src/corpus/weights.js), over the train split and separately over the held-out
// split (for weighted evaluation); quarantine charts weigh 0. Returns per-split stats for the summary.
export function splitWeights(groups, opts = {}) {
    const stats = {};
    for (const g of groups) if (g.split === "quarantine") for (const k of g.kept) k.weight = 0;
    for (const split of ["train", "heldout"]) {
        const members = [];
        for (const g of groups) if (g.split === split) for (const k of g.kept) members.push({ k, g });
        const res = corpusWeights(members.map(({ k, g }) => ({
            group: g.key, source: k.source, ranked: !!k.ranked, pack: k.pack ?? null, creator: k.creatorKey ?? null, bin: g.bin,
        })), opts);
        const bySource = {};
        members.forEach(({ k }, i) => {
            k.weight = sig(res.weights[i]);
            const s = (bySource[k.source] ??= { charts: 0, weight: 0 });
            s.charts++;
            s.weight += res.weights[i];
        });
        for (const s of Object.values(bySource)) { s.share = sig(s.weight / Math.max(1, members.length), 3); s.weight = sig(s.weight, 6); }
        stats[split] = {
            charts: members.length, capsHeld: res.capsHeld, rounds: res.rounds, maxPackShare: sig(res.stats.maxPackShare, 3),
            maxCreatorShare: sig(res.stats.maxCreatorShare, 3), maxBinRatio: sig(res.stats.maxBinRatio, 3), bySource,
        };
    }
    return stats;
}

const foldBpm = (b) => {
    if (!(b > 0) || !Number.isFinite(b)) return null;
    while (b >= 200) b /= 2;
    while (b < 100) b *= 2;
    return b;
};
const spanRatio = (a, b) => Math.min(a.spanMs, b.spanMs) / Math.max(a.spanMs, b.spanMs);

// The same song under another artist spelling ("Camellia" / "かめりあ", "Steinjo" / "Steinjo & Erlend", "Luca
// Turilli" / "Rhapsody") with another encode of the audio has neither song key nor audio key in common. Song keys
// with the same title part join when two of their charts also agree on the music: the same dominant BPM (±0.5%,
// half / double time allowed) and nearly the same span (±3%), or, without a BPM, the same object count and span
// (±1%). A shared title alone is not enough ("Pretender", "Hi High" exist as different songs). Returns the number
// of joins that merged two groups.
export const TITLE_JOIN = { bpmTol: 0.005, spanMin: 0.97, objSpanMin: 0.99 };
export function joinSameTitle(charts, uf) {
    const byTitle = new Map();
    for (const c of charts) {
        if (c.songKey.startsWith("p:") || !(c.spanMs > 0)) continue;
        const titles = new Set([c.songKey, ...(c.altKeys ?? [])].map((k) => k.slice(k.indexOf("|") + 1)));
        for (const t of titles) {
            if (!t) continue;
            if (!byTitle.has(t)) byTitle.set(t, []);
            byTitle.get(t).push(c);
        }
    }
    let joins = 0;
    const join = (a, b) => {
        const ra = uf.find(`s:${a.songKey}`);
        const rb = uf.find(`s:${b.songKey}`);
        if (ra === rb) return;
        uf.union(ra, rb);
        joins++;
    };
    for (const list of byTitle.values()) {
        if (list.length < 2 || new Set(list.map((c) => c.songKey)).size < 2) continue;
        const withBpm = list.map((c) => ({ c, fb: foldBpm(c.bpm) })).filter((x) => x.fb);
        // BPMs just under 200 must still meet those just over (folded to ~100): those are also listed once more at x2
        const window = [...withBpm, ...withBpm.filter((x) => x.fb < 100 * (1 + TITLE_JOIN.bpmTol)).map((x) => ({ c: x.c, fb: x.fb * 2 }))]
            .sort((a, b) => a.fb - b.fb);
        for (let i = 0; i < window.length; i++) {
            const a = window[i];
            for (let j = i + 1; j < window.length && window[j].fb <= a.fb * (1 + TITLE_JOIN.bpmTol); j++) {
                const b = window[j];
                if (a.c.songKey !== b.c.songKey && spanRatio(a.c, b.c) >= TITLE_JOIN.spanMin) join(a.c, b.c);
            }
        }
        if (withBpm.length === list.length) continue;
        const byObjects = new Map();
        for (const c of list) {
            if (!byObjects.has(c.objects)) byObjects.set(c.objects, []);
            byObjects.get(c.objects).push(c);
        }
        for (const same of byObjects.values()) {
            for (let i = 0; i < same.length; i++) {
                for (let j = i + 1; j < same.length; j++) {
                    const [a, b] = [same[i], same[j]];
                    if (a.songKey === b.songKey || (foldBpm(a.bpm) && foldBpm(b.bpm))) continue;
                    if (spanRatio(a, b) >= TITLE_JOIN.objSpanMin) join(a, b);
                }
            }
        }
    }
    return joins;
}

// ---- leak guard -----------------------------------------------------------------------------------------------

// Group joins stay strict: a wrong join merges two songs for good. They cannot see the same song under a title
// spelling found in neither .osu (romaji / kanji without the unicode fields, a subtitle, a remix), a cut / TV-size
// copy, a rate-changed copy, or another audio encode. A held-out song must not reach training from any source, and
// a false alarm here only costs training data, so every train group with a chart that looks like a held-out chart
// is set aside as split "quarantine" (neither train nor held-out; recomputed each run, never sticky, never pulls
// further groups). Rules, any chart of the group (duplicates included) against any held-out chart:
//   audio   the Chromaprint fingerprints share a stretch of at least FP.minNear frames (~12 s) at one offset: the same
//           recording in any encode, cut or edit, whatever the metadata says
//   title   a shared title (the full one, or its base without bracketed / ~subtitle~ / " - " parts) and one of: a
//           remix / cover / version word in the part that differs, an artist in common, the same dominant BPM, or
//           the same length in beats (±3%)
//   rate    an artist in common, the same length in beats (±1.5%) and a BPM ratio on a 0.05 step in 0.7-1.6: a
//           rate-changed copy under another title (a pitch-shifted copy is out of reach of the fingerprint)
//   artist  an artist in common (Artist or ArtistUnicode, also split at & , x vs feat) and the same dominant BPM
//           (±0.5%, half / double time allowed); only when one of the two has no fingerprint, else the audio rule
//           decides
// Not caught: a rate-changed (pitch-shifted) copy whose artist and title spellings both differ from the held-out ones.
export const LEAK = { bpmTol: 0.005, titleBeatsTol: 0.03, rateBeatsTol: 0.015, rateStepTol: 0.003, rateMin: 0.7, rateMax: 1.6, minBase: 3 };
export const FP = { minVotes: 20, minNear: 100, nearBits: 3, maxChain: 48 };
const FP_FRAME_SEC = 0.1238;
const JUNK_ARTISTS = new Set([...VARIOUS, "unknown", "unknownartist", "none", "na", "noartist", "artist", "untitled", "4k", "7k", "cv"]);
const ARTIST_SPLIT = /\s*(?:[&＆,、，/／×+()（）[\]【】]|\bx\b|\bvs\.?|\band\b|\bwith\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bmeets\b|\bcv\s*[.:：])\s*/iu;
const REMIXY = /(remix|rmx|\bmix\b|bootleg|cover|arrange|\bflip\b|\bvip\b|rework|refix|remaster|instrumental|\binst\b|off\s*vocal|acoustic|piano|orchestra|nightcore|sped|slowed|extended|\blong\b|\bshort\b|\bcut\b|\bfull\b|\btv\b|\bver\b|version|\bedit\b|\blive\b|remake|bass\s*boost|hardcore)/iu;

function leakFeatures(c) {
    if (c.leakF) return c.leakF;
    const titles = new Map(); // compact title → { full, remixy }
    const artists = new Set();
    const add = (t, full, remixy) => {
        if (!t || (!full && t.length < LEAK.minBase)) return;
        const was = titles.get(t);
        titles.set(t, { full: full || !!was?.full, remixy: remixy || !!was?.remixy });
    };
    if (c.songKey.startsWith("p:")) {
        if (!c.songKey.includes("|")) add(c.songKey.slice(2), true, false);
    } else {
        for (const raw of [c.title, c.titleUnicode]) {
            const x = stripMarkers(raw);
            const full = compact(x);
            add(full, true, false);
            const baseStr = x.replace(/[[(（【{<][^\])）】}>]*[\])）】}>]/gu, " ").replace(/[~～〜][^~～〜]*[~～〜]?/gu, " ")
                .replace(/\s[-–—]\s.*$/u, " ").replace(/\s-[^-]+-\s*$/u, " ");
            const base = compact(baseStr);
            if (base && base !== full) add(base, false, REMIXY.test(x) && !REMIXY.test(baseStr));
        }
        for (const raw of [c.artist, c.artistUnicode]) {
            const s = String(raw ?? "").normalize("NFKC").toLowerCase();
            for (const a of [compact(stripMarkers(s)), compact(s), ...s.split(ARTIST_SPLIT).map(compact)]) {
                if (a && a.length >= 2 && !JUNK_ARTISTS.has(a)) artists.add(a);
            }
        }
    }
    const fb = foldBpm(c.bpm);
    c.leakF = { titles, artists, fb, beats: fb && c.spanMs > 0 ? (c.spanMs * fb) / 60000 : null };
    return c.leakF;
}

const near = (x, y, tol) => Math.abs(x / y - 1) <= tol;
const bpmClose = (a, b) => !!(a.fb && b.fb) && (near(a.fb, b.fb, LEAK.bpmTol) || near(a.fb * 2, b.fb, LEAK.bpmTol) || near(a.fb, b.fb * 2, LEAK.bpmTol));
const beatsClose = (a, b, tol) => !!(a.beats && b.beats) && [1, 2, 0.5].some((k) => near(a.beats * k, b.beats, tol));
// Rate ρ: true BPM × ρ and span / ρ, so the length in beats stays; the folded BPMs differ by ρ times the fold factor
// k that the beat counts differ by. Rate copies use 0.05 steps (1.1x, 1.25x, 1.5x ...).
function rateCopy(t, h) {
    if (!(t.fb && h.fb && t.beats && h.beats)) return false;
    for (const k of [1, 2, 0.5]) {
        if (!near(t.beats, h.beats * k, LEAK.rateBeatsTol)) continue;
        const rho = t.fb / h.fb / k;
        if (rho < LEAK.rateMin || rho > LEAK.rateMax || Math.abs(rho - 1) < 0.02) continue;
        if (Math.abs(rho - Math.round(rho * 20) / 20) <= LEAK.rateStepTol) return true;
    }
    return false;
}

// Which metadata rule (if any) says train chart features t and held-out chart features h are the same song.
// bothFp: both charts have a fingerprint, so a same-BPM copy under another title is left to the audio rule.
export function leakRule(t, h, bothFp = false) {
    let shared = false;
    let remixy = false;
    for (const [k, v] of t.titles) {
        const w = h.titles.get(k);
        if (!w) continue;
        shared = true;
        if (!(v.full && w.full)) remixy ||= v.remixy || w.remixy;
    }
    let artist = false;
    for (const a of t.artists) if (h.artists.has(a)) { artist = true; break; }
    const bpm = bpmClose(t, h);
    if (shared && (remixy || artist || bpm || beatsClose(t, h, LEAK.titleBeatsTol))) return "title";
    if (artist && rateCopy(t, h)) return "rate";
    if (artist && bpm && !bothFp) return "artist";
    return null;
}

const popcount = (x) => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

// Index over the held-out fingerprints (chained hash on the exact 32-bit values; static runs such as silence and
// values found in more than FP.maxChain places are skipped). match(fp) → { index, offset, near } of the held-out
// fingerprint sharing the longest aligned stretch with fp (frames within FP.nearBits bits), or null.
export function fingerprintIndex(prints) {
    let n = 0;
    for (const p of prints) n += p.length;
    const bits = Math.min(26, Math.max(10, Math.ceil(Math.log2(n * 1.5 + 2))));
    const head = new Int32Array(1 << bits).fill(-1);
    const next = new Int32Array(n);
    const val = new Uint32Array(n);
    const who = new Uint32Array(n);
    const frame = new Uint32Array(n);
    let e = 0;
    const slot = (v) => Math.imul(v, 0x9e3779b1) >>> (32 - bits);
    prints.forEach((p, idx) => {
        for (let i = 0; i < p.length; i++) {
            if (i > 0 && p[i] === p[i - 1]) continue;
            const s = slot(p[i]);
            val[e] = p[i]; who[e] = idx; frame[e] = i; next[e] = head[s]; head[s] = e; e++;
        }
    });
    const nearCount = (a, b, offset) => {
        let c = 0;
        for (let j = Math.max(0, -offset); j < b.length && j + offset < a.length; j++) {
            if (j > 0 && b[j] === b[j - 1]) continue;
            if (popcount(a[j + offset] ^ b[j]) <= FP.nearBits) c++;
        }
        return c;
    };
    const SPAN = 1 << 22;
    return {
        match(fp) {
            if (!fp || fp.length < FP.minNear) return null;
            const votes = new Map();
            const hits = [];
            for (let j = 0; j < fp.length; j++) {
                if (j > 0 && fp[j] === fp[j - 1]) continue;
                const v = fp[j];
                hits.length = 0;
                for (let x = head[slot(v)]; x !== -1 && hits.length <= FP.maxChain; x = next[x]) if (val[x] === v) hits.push(x);
                if (hits.length > FP.maxChain) continue;
                for (const x of hits) {
                    const key = who[x] * SPAN + (frame[x] - j + SPAN / 2);
                    votes.set(key, (votes.get(key) ?? 0) + 1);
                }
            }
            const top = [...votes].filter(([, c]) => c >= FP.minVotes).sort((a, b) => b[1] - a[1]).slice(0, 5);
            let best = null;
            for (const [key] of top) {
                const index = Math.floor(key / SPAN);
                const offset = (key % SPAN) - SPAN / 2;
                const c = nearCount(prints[index], fp, offset);
                if (c >= FP.minNear && (!best || c > best.near)) best = { index, offset, near: c };
            }
            return best;
        },
    };
}

// fingerprints: { get(audioKey) → Uint32Array | null (did not decode) | undefined (none) }, or null: audio rule off.
export function leakGuard(groups, { fingerprints = null } = {}) {
    const byTitle = new Map();
    const byArtist = new Map();
    const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    const fpOf = new Map();
    const fp = (m) => {
        if (!fingerprints || !m.audioKey) return null;
        if (!fpOf.has(m.audioKey)) {
            const p = fingerprints.get(m.audioKey);
            fpOf.set(m.audioKey, p && p.length ? p : null);
        }
        return fpOf.get(m.audioKey);
    };
    const heldPrints = [];
    const heldOfPrint = [];
    const heldAudio = new Set();
    for (const g of groups) {
        if (g.split !== "heldout") continue;
        for (const m of g.kept.flatMap((k) => [k, ...k.dups])) {
            const f = leakFeatures(m);
            const p = fp(m);
            const h = { m, f, g, fp: !!p };
            for (const t of f.titles.keys()) push(byTitle, t, h);
            for (const a of f.artists) push(byArtist, a, h);
            if (p && !heldAudio.has(m.audioKey)) { heldAudio.add(m.audioKey); heldPrints.push(p); heldOfPrint.push(h); }
        }
    }
    const index = heldPrints.length ? fingerprintIndex(heldPrints) : null;
    const audioMatch = new Map(); // train audio key → { h, offset, near } or null
    const stats = { groups: 0, charts: 0, byRule: { audio: 0, title: 0, rate: 0, artist: 0 }, heldoutPrints: heldPrints.length, trainCharts: 0, trainChartsNoPrint: 0 };
    for (const g of groups) {
        if (g.split !== "train") continue;
        let found = null;
        const members = g.kept.flatMap((k) => [k, ...k.dups]);
        for (const m of members) {
            const f = leakFeatures(m);
            const mine = fp(m);
            if (mine && index) {
                if (!audioMatch.has(m.audioKey)) {
                    const r = index.match(mine);
                    audioMatch.set(m.audioKey, r ? { h: heldOfPrint[r.index], offset: r.offset, near: r.near } : null);
                }
                const a = audioMatch.get(m.audioKey);
                if (a) {
                    found = { rule: "audio", of: a.h.g.key, chart: m.osu, heldoutChart: a.h.m.osu, offsetSec: round(a.offset * FP_FRAME_SEC, 1), sharedSec: round(a.near * FP_FRAME_SEC, 1) };
                    break;
                }
            }
            const seen = new Set();
            for (const list of [...[...f.titles.keys()].map((t) => byTitle.get(t)), ...[...f.artists].map((a) => byArtist.get(a))]) {
                for (const h of list ?? []) {
                    if (seen.has(h)) continue;
                    seen.add(h);
                    const rule = leakRule(f, h.f, !!mine && h.fp);
                    if (rule) { found = { rule, of: h.g.key, chart: m.osu, heldoutChart: h.m.osu }; break; }
                }
                if (found) break;
            }
            if (found) break;
        }
        for (const m of members) { stats.trainCharts++; if (!fp(m)) stats.trainChartsNoPrint++; }
        if (!found) continue;
        g.split = "quarantine";
        g.reason = "leak-guard";
        g.leak = found;
        stats.groups++;
        stats.charts += g.kept.length;
        stats.byRule[found.rule]++;
    }
    return stats;
}

function outLine(k, g) {
    return {
        source: k.source,
        osu: k.osu,
        audio: k.audio,
        beatmapId: k.beatmapId ?? (k.metaMd5 ? k.meta.beatmapId : null),
        beatmapSetId: k.beatmapSetId ?? (k.metaMd5 ? k.meta.beatmapSetId : null),
        artist: k.artist,
        title: k.title,
        creator: k.creator,
        version: k.version,
        objects: k.objects,
        lnShare: k.lnShare,
        bpm: k.bpm,
        spanMs: k.spanMs,
        md5: k.md5,
        ranked: !!k.ranked,
        chartKey: k.chartKey,
        audioKey: k.audioKey,
        songKey: k.songKey,
        group: g.key,
        danBin: g.bin,
        rate: k.rate,
        rateFrom: k.rateFrom,
        labels: k.labels,
        pack: k.pack ?? null,
        creatorKey: k.creatorKey ?? null,
        creatorId: k.meta?.creatorId ?? null,
        year: k.meta?.year ?? null,
        weight: k.weight ?? null,
        split: g.split,
        splitReason: g.split !== "train" ? g.reason : undefined,
        leak: g.leak, // quarantine only: { rule, of: held-out group, chart, heldoutChart }
        duplicates: k.dups.map((d) => ({ source: d.source, osu: d.osu, audio: d.audio, beatmapId: d.beatmapId, rate: d.rate, rateFrom: d.rateFrom, songKey: d.songKey })),
    };
}

// ---- driver ---------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
    const o = { ...DEFAULTS, roots: { ...DEFAULTS.roots }, workers: Math.max(1, availableParallelism() - 1), full: false, freshSplit: false, calcDan: false, cache: null, fpDir: null, fingerprint: true };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--workers") o.workers = Math.max(1, Number(next()) || 1);
        else if (a === "--full") o.full = true;
        else if (a === "--fresh-split") o.freshSplit = true;
        else if (a === "--calc-dan") o.calcDan = true;
        else if (a === "--extra-heldout") o.extraHeldout = Number(next());
        else if (a === "--seed") o.seed = next();
        else if (a === "--manifest") o.manifest = next();
        else if (a === "--hf-meta") o.hfMeta = next();
        else if (a === "--etterna-packs") o.etternaPacks = next();
        else if (a === "--malody-packs") o.malodyPacks = next();
        else if (a === "--heldout") o.heldout = next();
        else if (a === "--cache") o.cache = next();
        else if (a === "--fp-dir") o.fpDir = next();
        else if (a === "--ffmpeg") o.ffmpeg = next();
        else if (a === "--no-fingerprint") o.fingerprint = false;
        else if (a.startsWith("--") && a.slice(2) in o.roots) o.roots[a.slice(2)] = next();
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else pos.push(a);
    }
    if (pos[0]) o.out = pos[0];
    o.cache ??= path.join(path.dirname(o.out), "cache.jsonl");
    o.fpDir ??= path.join(path.dirname(o.out), "fp");
    return o;
}

async function readCache(file) {
    const charts = new Map();
    const audio = new Map();
    const dan = new Map();
    const text = await readFile(file, "utf8").catch(() => "");
    let osuOk = false;
    for (const line of text.split("\n")) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        // an older version only loses its .osu entries (their chart fields changed); audio keys and dans stay valid
        if (e.v !== undefined) { osuOk = e.v === CACHE_VERSION; continue; }
        if (e.k === "osu") { if (osuOk) charts.set(e.p, e); }
        else if (e.k === "audio") audio.set(e.p, e);
        else if (e.k === "dan") dan.set(e.p, e);
    }
    return { charts, audio, dan };
}

async function writeAtomic(file, text) {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
}

async function writeLines(file, lines) {
    const tmp = `${file}.tmp`;
    const fh = await open(tmp, "w");
    try {
        let buf = [];
        let size = 0;
        for (const l of lines) {
            const s = `${jsonLine(l)}\n`;
            buf.push(s);
            size += s.length;
            if (size > 4 << 20) { await fh.write(buf.join("")); buf = []; size = 0; }
        }
        if (buf.length) await fh.write(buf.join(""));
    } finally {
        await fh.close();
    }
    await rename(tmp, file);
}

async function previousHeldout(out) {
    const keys = new Set();
    const text = await readFile(out, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
        if (!line) continue;
        try {
            const r = JSON.parse(line);
            if (r.split !== "heldout") continue;
            keys.add(r.songKey);
            for (const d of r.duplicates ?? []) if (d.songKey) keys.add(d.songKey);
        } catch { /* ignore */ }
    }
    return keys;
}

const defaultLog = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function run(opts, log = defaultLog) {
    const t0 = Date.now();
    const outDir = path.dirname(opts.out);
    // Roots are read only: no output folder (corpus, summary, cache) may be a root or lie inside one.
    const within = (dir, root) => {
        const d = norm(path.resolve(dir)).toLowerCase().replace(/\/+$/, "");
        const r = norm(path.resolve(root)).toLowerCase().replace(/\/+$/, "");
        return d === r || d.startsWith(`${r}/`);
    };
    for (const r of Object.values(opts.roots)) {
        if (!r || r === "-") continue;
        for (const [f, d] of [[opts.out, path.dirname(opts.out)], [opts.cache, path.dirname(opts.cache)], [opts.fpDir, opts.fpDir]]) {
            if (d && within(d, r)) throw new Error(`output ${f} is inside the corpus root ${r}`);
        }
    }
    await mkdir(outDir, { recursive: true });
    await mkdir(path.dirname(opts.cache), { recursive: true });
    const cache = opts.full ? { charts: new Map(), audio: new Map(), dan: new Map() } : await readCache(opts.cache);
    const cachedByDir = new Map();
    for (const e of cache.charts.values()) {
        const d = norm(path.dirname(e.p));
        if (!cachedByDir.has(d)) cachedByDir.set(d, {});
        cachedByDir.get(d)[e.p] = { m: e.m, z: e.z, r: e.r, a: e.c ? e.c.audio : e.a };
    }

    const pool = new Pool(opts.workers);
    try {
        // 1) list + parse
        const dirs = [];
        const perSource = {};
        for (const source of SOURCE_ORDER) {
            const root = opts.roots[source];
            perSource[source] = { root: root === "-" ? null : root, dirs: 0, osuFiles: 0, rice: 0, kept: 0, duplicates: 0, rejected: {}, parsed: 0, cached: 0 };
            if (!root || root === "-") continue;
            const ents = await readdir(root, { withFileTypes: true }).catch(() => []);
            for (const d of ents) {
                if (!d.isDirectory() || d.name.startsWith("_")) continue;
                const dir = norm(path.join(root, d.name));
                dirs.push({ dir, source, cached: cachedByDir.get(dir) ?? null });
                perSource[source].dirs++;
            }
        }
        log(`listing ${dirs.length} folders with ${opts.workers} workers`);
        const entries = new Map();
        let done = 0;
        await Promise.all(chunk(dirs, 64).map(async (batch) => {
            const out = await pool.run({ type: "dirs", dirs: batch });
            for (const e of out) {
                const src = batch.find((b) => e.p.startsWith(`${b.dir}/`))?.source;
                if (e.hit) {
                    const { k, ...was } = cache.charts.get(e.p);
                    // the audio file's size + mtime as of now, so a changed (e.g. finished downloading) file is hashed again
                    if (was.c && e.az !== undefined) was.c = { ...was.c, audioSize: e.az, audioMtime: e.am };
                    entries.set(e.p, { ...was, source: src });
                    perSource[src].cached++;
                } else { entries.set(e.p, { ...e, source: src }); perSource[src].parsed++; }
            }
            done += batch.length;
            if (done % 2048 < 64) log(`  ${done}/${dirs.length} folders, ${entries.size} .osu`);
        }));
        const charts = [];
        for (const e of entries.values()) {
            const s = perSource[e.source];
            s.osuFiles++;
            if (e.c) { charts.push({ ...e.c, source: e.source }); s.rice++; } else s.rejected[e.r] = (s.rejected[e.r] ?? 0) + 1;
        }
        log(`${entries.size} .osu files, ${charts.length} 4K rice charts with audio`);

        // 2) audio keys (unique files; cached by mtime + size)
        const audioFiles = new Map();
        for (const c of charts) if (!audioFiles.has(c.audio)) audioFiles.set(c.audio, { p: c.audio, m: c.audioMtime, z: c.audioSize });
        const audioKeys = new Map();
        const todo = [];
        for (const a of audioFiles.values()) {
            const c = cache.audio.get(a.p);
            if (c && c.m === a.m && c.z === a.z && c.key) audioKeys.set(a.p, c); else todo.push(a);
        }
        log(`${audioFiles.size} audio files, hashing ${todo.length}`);
        await Promise.all(chunk(todo, 64).map(async (batch) => {
            for (const r of await pool.run({ type: "audio", files: batch })) audioKeys.set(r.p, { p: r.p, m: r.m, z: r.z, key: r.k });
        }));
        for (const c of charts) c.audioKey = audioKeys.get(c.audio)?.key ?? null;

        // 2b) audio fingerprints for the leak guard (one per audio key, kept in fpDir; only new keys are decoded)
        const fpInfo = { on: false, keys: 0, computed: 0, failed: 0 };
        let fingerprints = null;
        if (opts.fingerprint && ffmpegHasChromaprint(opts.ffmpeg)) {
            fpInfo.on = true;
            const byKey = new Map();
            for (const c of charts) if (c.audioKey && !byKey.has(c.audioKey)) byKey.set(c.audioKey, c.audio);
            fpInfo.keys = byKey.size;
            const need = [];
            for (const [key, p] of byKey) {
                const file = fpFile(opts.fpDir, key);
                if (!(await stat(file).catch(() => null))) need.push({ key, p, file });
            }
            log(`fingerprints: ${byKey.size} audio keys, decoding ${need.length}`);
            let n = 0;
            await Promise.all(chunk(need, 8).map(async (batch) => {
                for (const r of await pool.run({ type: "fp", files: batch, ffmpeg: opts.ffmpeg })) { fpInfo.computed++; if (!r.ok) fpInfo.failed++; }
                n += batch.length;
                if (n % 1000 < 8) log(`  fingerprints ${n}/${need.length}`);
            }));
            fingerprints = { get: (key) => readFingerprint(fpFile(opts.fpDir, key)) };
        } else log(opts.fingerprint ? `no ffmpeg with chromaprint at "${opts.ffmpeg}": leak guard without the audio rule` : "fingerprints off");

        // 3) labels
        const [tracker, hfMeta, etterna, heldoutList] = await Promise.all([
            loadTracker(opts.manifest),
            loadHfMeta(opts.hfMeta),
            loadEtterna(opts.etternaPacks, opts.roots.etterna).then((m) => loadEtterna(opts.malodyPacks, opts.roots.malody, m)),
            opts.heldout && opts.heldout !== "-" ? readFile(opts.heldout, "utf8").then(JSON.parse).catch(() => []) : [],
        ]);
        log(`labels: tracker ${tracker.size}, hf meta ${hfMeta.byId.size}, etterna + malody charts ${etterna.size}, held-out folders ${heldoutList.length}`);

        // 4) optional own dan (our calculator) for the charts that stay after dedupe
        let calcDan = null;
        if (opts.calcDan) {
            const first = buildCorpus(charts.map((c) => ({ ...c })), {
                tracker, hfMeta, etterna, heldoutFolders: new Set(), stickySongKeys: new Set(), extraHeldout: 0, seed: opts.seed, calcDan: null,
            });
            calcDan = new Map();
            const need = [];
            for (const k of first.kept) {
                const c = cache.dan.get(k.osu);
                const e = entries.get(k.osu);
                if (c && c.m === e.m && c.z === e.z) calcDan.set(k.osu, c.dan); else need.push(k.osu);
            }
            log(`own dan: ${need.length} charts to analyse (${calcDan.size} cached)`);
            let n = 0;
            await Promise.all(chunk(need, 16).map(async (batch) => {
                for (const r of await pool.run({ type: "dan", files: batch })) {
                    calcDan.set(r.p, r.dan);
                    const e = entries.get(r.p);
                    cache.dan.set(r.p, { k: "dan", p: r.p, m: e.m, z: e.z, dan: r.dan });
                }
                n += batch.length;
                if (n % 2000 < 16) log(`  dan ${n}/${need.length}`);
            }));
        }

        // 5) dedupe + groups + split
        const stickySongKeys = opts.freshSplit ? new Set() : await previousHeldout(opts.out);
        const { kept, groups, duplicates, titleJoins, leak, weights } = buildCorpus(charts, {
            tracker, hfMeta, etterna, heldoutFolders: new Set(heldoutList), stickySongKeys,
            extraHeldout: opts.extraHeldout, seed: opts.seed, calcDan, fingerprints,
        });
        const groupOf = new Map();
        for (const g of groups) for (const k of g.kept) groupOf.set(k, g);
        kept.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.osu < b.osu ? -1 : 1));
        await writeLines(opts.out, kept.map((k) => outLine(k, groupOf.get(k))));

        // 6) summary
        const perBin = {};
        const split = {
            train: { groups: 0, charts: 0 },
            heldout: { groups: 0, charts: 0, seed: 0, sticky: 0, extra: 0 },
            quarantine: { groups: 0, charts: 0, byRule: leak.byRule },
        };
        for (const g of groups) {
            perBin[g.bin] ??= { groups: 0, charts: 0, heldoutGroups: 0, heldoutCharts: 0, quarantineGroups: 0 };
            perBin[g.bin].groups++;
            perBin[g.bin].charts += g.kept.length;
            split[g.split].groups++;
            split[g.split].charts += g.kept.length;
            if (g.split === "heldout") { perBin[g.bin].heldoutGroups++; perBin[g.bin].heldoutCharts += g.kept.length; split.heldout[g.reason]++; }
            if (g.split === "quarantine") perBin[g.bin].quarantineGroups++;
        }
        for (const k of kept) { perSource[k.source].kept++; perSource[k.source].duplicates += k.dups.length; }
        const dupBySource = {};
        for (const k of kept) for (const d of k.dups) { const key = `${d.source}→${k.source}`; dupBySource[key] = (dupBySource[key] ?? 0) + 1; }
        const rateFrom = {};
        for (const c of charts) rateFrom[c.rateFrom] = (rateFrom[c.rateFrom] ?? 0) + 1;
        const labelCounts = { rawDan: 0, etternaMsd: 0, playcount: 0, calcDan: 0 };
        for (const k of kept) for (const l of Object.keys(labelCounts)) if (k.labels[l] !== null && k.labels[l] !== undefined) labelCounts[l]++;
        const heldoutFolders = new Set(heldoutList);
        const seedFoldersFound = new Set(charts.filter((c) => heldoutFolders.has(c.folder)).map((c) => c.folder));
        const summary = {
            made: new Date().toISOString(),
            sec: Math.round((Date.now() - t0) / 1000),
            out: norm(opts.out),
            osuFiles: entries.size,
            riceCharts: charts.length,
            uniqueCharts: kept.length,
            duplicates,
            duplicatesBySource: dupBySource,
            songGroups: groups.length,
            titleJoins,
            leakGuard: { ...leak, fingerprints: fpInfo },
            largestGroups: [...groups].sort((a, b) => b.kept.length - a.kept.length).slice(0, 10).map((g) => ({ key: g.key, charts: g.kept.length, songKeys: g.songKeys.size })),
            perSource,
            perDanBin: Object.fromEntries(Object.entries(perBin).sort()),
            split,
            heldoutSeedFolders: { listed: heldoutList.length, found: seedFoldersFound.size, missing: heldoutList.filter((f) => !seedFoldersFound.has(f)) },
            labels: labelCounts,
            weights,
            rateFrom,
            audioFiles: audioFiles.size,
            audioHashed: todo.length,
        };
        await writeAtomic(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);

        // 7) cache (only files that still exist)
        const cacheLines = [{ v: CACHE_VERSION }];
        for (const e of entries.values()) {
            const { source, hit, ...rest } = e;
            cacheLines.push({ k: "osu", ...rest });
        }
        for (const a of audioKeys.values()) cacheLines.push({ k: "audio", ...a });
        for (const d of cache.dan.values()) if (entries.has(d.p)) cacheLines.push(d);
        await writeLines(opts.cache, cacheLines);
        log(`done in ${summary.sec}s: ${kept.length} unique charts, ${duplicates} duplicates, ${groups.length} song groups, heldout ${split.heldout.groups} groups / ${split.heldout.charts} charts, quarantine ${split.quarantine.groups} groups / ${split.quarantine.charts} charts`);
        return summary;
    } finally {
        await pool.close();
    }
}

if (!isMainThread && workerData?.corpusWorker) {
    await workerMain();
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    run(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
