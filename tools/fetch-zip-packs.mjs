// Extra training data for the 4K mapper: the "Malody 4k Converts (…)" zips (StepMania .sm converts of Malody
// charts, binned by MSD) from the reenigne simfile mirror, with the Hugging Face ayousanz/malody-data copy as a
// fallback. Each zip is downloaded (Range resume), only simfiles (.sm/.ssc) and audio are taken out of it with
// the streaming zip reader, every dance-single chart becomes an .osu next to its audio (the very same grouping,
// conversion and dedupe as tools/fetch-etterna-packs.mjs, whose helpers are reused), a manifest is written per zip
// and the zip is deleted. The 38–104 bin (joke charts) is never fetched. The original Malody .mc files, images
// and anything else in the zips are left alone.
// Output is outside osu! (never the Songs folder), in the Etterna fetcher's shape:
//   <outRoot>/songs/<id> <song folder>/   audio + .sm + one .osu per chart (AudioFilename = that audio)
//   <outRoot>/packs/<id>.json             manifest per zip (songs, charts converted/skipped with reasons, msdRange)
//   <outRoot>/state.jsonl                 one line per finished zip (re-runs skip ok/final ones)
//   <outRoot>/_zips/<id>.zip(.part)       while downloading; removed after a successful extraction
//   <outRoot>/_zips/<id>.src              which mirror the .part came from (a switch of mirror starts over)
// Charts already converted from the Etterna packs (their manifests) or from another Malody zip are skipped.
// Downloads are untrusted data: nothing from them is executed, only chart text and audio are read.
// Usage: node tools/fetch-zip-packs.mjs [outRoot=A:/SneezeyTrain/malody] [--list builtin|FILE] [--limit N]
//        [--lanes 2] [--only TEXT[,TEXT]] [--smallest-first] [--show] [--etterna-packs DIR|-]
//   --list FILE: a TSV like download_urls.tsv, one URL or zip name per line, or a saved directory listing (.html).
import { mkdir, readdir, readFile, writeFile, appendFile, rename, rm, stat, statfs, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadResumable, processPackZip } from "./fetch-etterna-packs.mjs";
import { refuseSongs } from "./fetch-drive-packs.mjs";

export const MIRROR_BASE = "https://mirror.reenigne.net/simfiles/";
export const HF_BASE = "https://huggingface.co/datasets/ayousanz/malody-data/resolve/main/";
const START_HOSTS = ["mirror.reenigne.net", "huggingface.co"];
const MAX_ZIP_BYTES = 4 * 1024 ** 3;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_HOPS = 5;
const PAUSE_MS = 2000;
const DEFAULT_ETTERNA_PACKS = "A:/SneezeyTrain/etterna/packs";

// The 4K zips of https://mirror.reenigne.net/simfiles/ (directory listing read 2026-10-25): MSD bin and bytes.
// "38-104" is there too and left out on purpose.
export const BUILTIN_ZIPS = [
    ["0-6 1", 739273517], ["0-6 2", 740280633], ["6-7 1", 631136132], ["6-7 2", 665581329],
    ["7-8 1", 781470784], ["7-8 2", 776887403], ["8-9 1", 692995961], ["8-9 2", 718327102],
    ["9-10 1", 725566720], ["9-10 2", 701847935], ["10-11 1", 1697596416], ["10-11 2", 953694315],
    ["11-12 1", 1850777436], ["11-12 2", 949726842], ["12-13 1", 1104539706], ["12-13 2", 1012255575],
    ["13-14 1", 1180769166], ["13-14 2", 1165321536], ["14-15 1", 827745670], ["14-15 2", 827323824],
    ["14-15 3", 798690717], ["15-16 1", 854583237], ["15-16 2", 926917012], ["15-16 3", 839480881],
    ["16-17 1", 848020141], ["16-17 2", 806327719], ["16-17 3", 864384517], ["17-18 1", 1196460341],
    ["17-18 2", 1261397283], ["18-19 1", 1069998625], ["18-19 2", 1036981034], ["19-20 1", 913690358],
    ["19-20 2", 899474237], ["20-21 1", 758907630], ["20-21 2", 778536365], ["21-22", 1154293485],
    ["22-23", 948693806], ["23-25", 1146746189], ["25-28", 880452832], ["28-38", 789638986],
].map(([bin, bytes]) => [`Malody 4k Converts (${bin}).zip`, bytes]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultLog = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lower = (s) => String(s ?? "").toLowerCase();
const finalError = (message) => Object.assign(new Error(message), { final: true });

// encodeURIComponent plus ( ) ! ' * — the mirror's own links write "%28…%29"
export const encodeName = (name) => encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// "Malody 4k Converts (14-15 3).zip" → { name, id: "mal-14-15-3", lo: 14, hi: 15, part: 3 }; null for anything else
// (other key counts, other files) and for the 38+ bin.
export function parseZipName(name) {
    const m = /^Malody 4k Converts \((\d{1,3})-(\d{1,3})(?: (\d{1,2}))?\)\.zip$/i.exec(String(name ?? "").trim());
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    const part = m[3] ? Number(m[3]) : null;
    if (!(hi > lo) || lo >= 38) return null;
    return { name: `Malody 4k Converts (${lo}-${hi}${part ? ` ${part}` : ""}).zip`, id: `mal-${lo}-${hi}${part ? `-${part}` : ""}`, lo, hi, part };
}

// Only https on the two approved hosts, under the expected paths. Redirect hops after huggingface.co may go to
// its own CDN (*.hf.co / *.huggingface.co: LFS and Xet storage), nowhere else.
export function isAllowedHost(u, { cdn = false } = {}) {
    let url;
    try {
        url = new URL(u);
    } catch {
        return false;
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const h = url.hostname.toLowerCase();
    if (START_HOSTS.includes(h)) return true;
    return cdn && (h.endsWith(".hf.co") || h.endsWith(".huggingface.co"));
}

// A URL from a list → the zip's file name, or null when it is not on the mirror's /simfiles/ or the HF dataset.
export function zipNameOfUrl(u) {
    if (!isAllowedHost(u)) return null;
    const url = new URL(u);
    const p = url.pathname;
    const host = url.hostname.toLowerCase();
    let rest = null;
    if (host === "mirror.reenigne.net" && p.startsWith("/simfiles/")) rest = p.slice("/simfiles/".length);
    if (host === "huggingface.co" && p.startsWith("/datasets/ayousanz/malody-data/resolve/main/")) rest = p.slice("/datasets/ayousanz/malody-data/resolve/main/".length);
    if (!rest || rest.includes("/")) return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return null;
    }
}

// one zip to fetch: the mirror first, Hugging Face second (or the list's URL first and the other one after it)
export function zipEntry(name, { bytes = null, url = null } = {}) {
    const z = parseZipName(name);
    if (!z) return null;
    const mirror = `${MIRROR_BASE}${encodeName(z.name)}`;
    const hf = `${HF_BASE}${encodeName(z.name)}`;
    const urls = url && zipNameOfUrl(url) && url.toLowerCase().includes("huggingface.co") ? [hf, mirror] : [mirror, hf];
    return { ...z, bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null, urls };
}

// List text → zip entries. Takes a TSV (rank, name, url, bytes), one URL or zip name per line, or an HTML
// directory listing (its hrefs). Unknown hosts, other files and the 38+ bin are dropped; the first copy of a
// name wins. → { zips, dropped: [line] }
export function parseListText(text) {
    const zips = [];
    const dropped = [];
    const byName = new Set();
    const add = (name, bytes, url, line) => {
        const z = zipEntry(name, { bytes, url });
        if (!z) {
            dropped.push(line);
            return;
        }
        if (byName.has(lower(z.name))) return;
        byName.add(lower(z.name));
        zips.push(z);
    };
    const s = String(text ?? "");
    if (/<a\s[^>]*href=/i.test(s)) {
        for (const m of s.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>[^<]*<\/a>\s*[^\n<]*?(\d+)\s*$/gim)) {
            const href = m[1];
            const url = /^https:/i.test(href) ? href : `${MIRROR_BASE}${href}`;
            const name = zipNameOfUrl(url);
            if (name && /malody 4k/i.test(name)) add(name, Number(m[2]), url, href);
        }
        return { zips, dropped };
    }
    for (const raw of s.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const cells = line.split("\t").map((c) => c.trim());
        const url = cells.find((c) => /^https?:\/\//i.test(c)) ?? null;
        const bytes = Number(cells.filter((c) => /^\d{4,}$/.test(c)).at(-1)) || null;
        let name = null;
        if (url) name = zipNameOfUrl(url);
        else name = cells.find((c) => /\.zip$/i.test(c)) ?? (cells.length === 1 ? `${cells[0]}.zip` : null);
        if (!name) {
            dropped.push(line);
            continue;
        }
        add(name, bytes, url, line);
    }
    return { zips, dropped };
}

export async function loadList(list) {
    if (!list || lower(list) === "builtin") return { zips: BUILTIN_ZIPS.map(([name, bytes]) => zipEntry(name, { bytes })), dropped: [] };
    const info = await stat(list);
    if (info.size > MAX_LIST_BYTES) throw new Error(`${list} is too big for a list`);
    return parseListText(await readFile(list, "utf8"));
}

// fetch that follows redirects itself so every hop is checked (the first must be an approved host; after
// huggingface.co its CDN is fine too). The response has no url, so the downloader's own redirect check (it
// would also pass *.etternaonline.com) is not the one that counts.
export function guardedFetch(fetchImpl = globalThis.fetch) {
    return async (url, init = {}) => {
        let current = url;
        let viaHf = false;
        for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
            if (!isAllowedHost(current, { cdn: viaHf })) throw finalError(`refusing a download from ${current}`);
            viaHf = viaHf || new URL(current).hostname.toLowerCase() === "huggingface.co";
            const res = await fetchImpl(current, { ...init, redirect: "manual" });
            const location = res.headers?.get?.("location");
            if ([301, 302, 303, 307, 308].includes(res.status) && location) {
                await res.body?.cancel?.().catch(() => {});
                current = new URL(location, current).href;
                continue;
            }
            return { status: res.status, ok: res.ok, headers: res.headers, body: res.body, url: "" };
        }
        throw finalError(`more than ${MAX_HOPS} redirects for ${url}`);
    };
}

// The zip into dest from the first mirror that works. A .part from another mirror is started over, so the
// bytes of one file never come from two places. The error thrown is final only when every source failed for
// good: a mirror that timed out or gave 5xx and then an HF 404 (no copy there) is worth another run later.
export async function downloadWithFallback(zip, dest, {
    fetchImpl = globalThis.fetch, sleepImpl = sleep, logImpl = defaultLog, label = zip.name,
} = {}) {
    const srcFile = dest.replace(/\.zip$/i, ".src");
    const fetchSafe = guardedFetch(fetchImpl);
    const maxBytes = zip.bytes ? Math.min(MAX_ZIP_BYTES, Math.ceil(zip.bytes * 1.05) + 1e6) : MAX_ZIP_BYTES;
    let lastError = null;
    let transientError = null;
    for (const [i, url] of zip.urls.entries()) {
        const before = (await readFile(srcFile, "utf8").catch(() => "")).trim();
        if (before && before !== url) await rm(`${dest}.part`, { force: true });
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(srcFile, url, "utf8");
        try {
            const got = await downloadResumable(url, dest, { fetchImpl: fetchSafe, sleepImpl, logImpl, hosts: START_HOSTS, maxBytes, label });
            return { ...got, url };
        } catch (error) {
            lastError = error;
            if (!error?.final) transientError ??= error;
            if (i + 1 < zip.urls.length) logImpl(`${label}: ${new URL(url).hostname} failed (${error.message}); trying ${new URL(zip.urls[i + 1]).hostname}`);
        }
    }
    throw transientError ?? lastError;
}

// hash → { pack, where } from every manifest in these dirs (the Etterna fetcher's loadSeen is not exported and
// reads numeric names only; see .lekhapion/requests/malody.md)
export async function loadSeenFrom(dirs) {
    const seen = new Map();
    for (const dir of dirs.filter((d) => d && d !== "-")) {
        for (const f of (await readdir(dir).catch(() => [])).filter((x) => x.endsWith(".json"))) {
            const m = await readFile(path.join(dir, f), "utf8").then(JSON.parse).catch(() => null);
            for (const s of m?.songs ?? []) for (const c of s.charts ?? []) if (c.hash && !seen.has(c.hash)) seen.set(c.hash, { pack: m.id, where: `${s.folder} [${c.version}]` });
        }
    }
    return seen;
}

async function readDone(stateFile) {
    const done = new Set();
    for (const l of (await readFile(stateFile, "utf8").catch(() => "")).split("\n")) {
        try {
            const s = JSON.parse(l);
            if (s && (s.ok || s.final)) done.add(s.id);
        } catch {}
    }
    return done;
}

// one run at a time per outRoot (a lock file with the pid; a stale one is taken over)
async function takeLock(file) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fh = await open(file, "wx");
            await fh.writeFile(String(process.pid));
            await fh.close();
            return async () => rm(file, { force: true });
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const pid = Number(await readFile(file, "utf8").catch(() => ""));
            let alive = false;
            try {
                alive = pid > 0 && pid !== process.pid && process.kill(pid, 0);
            } catch {}
            if (alive) throw new Error(`another fetch-zip-packs run (pid ${pid}) holds ${file}`);
            await rm(file, { force: true });
        }
    }
    throw new Error(`could not take ${file}`);
}

export function parseArgs(argv) {
    const opts = { _: [], list: "builtin", limit: 0, lanes: 2, only: [], smallestFirst: false, show: false, etternaPacks: DEFAULT_ETTERNA_PACKS };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const [flag, inline] = a.startsWith("--") ? a.split(/=(.*)/s) : [a];
        const value = () => {
            const v = inline !== undefined ? inline : argv[++i];
            if (v === undefined) throw new Error(`${flag} needs a value`);
            return v;
        };
        if (flag === "--list") opts.list = value();
        else if (flag === "--limit") opts.limit = Number(value());
        else if (flag === "--lanes") opts.lanes = Number(value());
        else if (flag === "--only") opts.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        else if (flag === "--smallest-first") opts.smallestFirst = true;
        else if (flag === "--show") opts.show = true;
        else if (flag === "--etterna-packs") opts.etternaPacks = value();
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else opts._.push(a);
    }
    if (!Number.isFinite(opts.limit) || opts.limit < 0) throw new Error("--limit needs a number");
    opts.lanes = Math.max(1, Math.min(3, Math.floor(opts.lanes) || 2)); // polite: at most 3 at once per host
    opts.outRoot = opts._[0] ?? "A:/SneezeyTrain/malody";
    return opts;
}

// selection: --only matches the bin text ("6-7 1") or the id; smallest first on request
export function selectZips(zips, { only = [], smallestFirst = false } = {}) {
    let out = zips.filter(Boolean);
    if (only.length) out = out.filter((z) => only.some((o) => [`(${lower(o)})`, `(${lower(o)} `].some((k) => lower(z.name).includes(k)) || lower(z.id) === lower(o)));
    if (smallestFirst) out = [...out].sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
    return out;
}

async function defaultFreeBytes(dir) {
    const fs = await statfs(dir);
    return Number(fs.bavail) * Number(fs.bsize);
}

export async function run(opts, { fetchImpl = globalThis.fetch, sleepImpl = sleep, logImpl = defaultLog, freeBytes = defaultFreeBytes, pauseMs = PAUSE_MS } = {}) {
    const outRoot = path.resolve(opts.outRoot);
    refuseSongs(outRoot);
    const { zips, dropped } = await loadList(opts.list);
    if (dropped.length) logImpl(`list: ${dropped.length} lines not taken (not a Malody 4K zip below MSD 38 on an approved host), e.g. ${dropped.slice(0, 2).map((d) => String(d).slice(0, 100)).join(" | ")}`);
    const selected = selectZips(zips, opts);
    const total = selected.reduce((s, z) => s + (z.bytes ?? 0), 0);
    logImpl(`${selected.length} Malody 4K zips selected, ${(total / 1e9).toFixed(1)} GB`);
    if (opts.show) {
        for (const z of selected) logImpl(`${z.id.padEnd(12)} ${String(z.bytes ?? "?").padStart(11)}  ${z.name}`);
        return { zips: 0, songs: 0, charts: 0, failed: 0, selected: selected.length };
    }
    const stateFile = path.join(outRoot, "state.jsonl");
    const manifestDir = path.join(outRoot, "packs");
    const songsRoot = path.join(outRoot, "songs");
    const zipDir = path.join(outRoot, "_zips");
    await mkdir(manifestDir, { recursive: true });
    await mkdir(songsRoot, { recursive: true });
    const unlock = await takeLock(path.join(outRoot, "fetch-zip.lock"));
    const totals = { zips: 0, songs: 0, charts: 0, failed: 0, selected: selected.length };
    try {
        const done = await readDone(stateFile);
        let todo = selected.filter((z) => !done.has(z.id));
        if (opts.limit > 0) todo = todo.slice(0, opts.limit);
        logImpl(`${selected.length - selected.filter((z) => !done.has(z.id)).length} already done, ${todo.length} to fetch now (${(todo.reduce((s, z) => s + (z.bytes ?? 0), 0) / 1e9).toFixed(1)} GB), ${opts.lanes} at a time`);
        const seen = await loadSeenFrom([opts.etternaPacks, manifestDir]);
        logImpl(`${seen.size} chart hashes known from earlier manifests`);
        let next = 0;
        let stop = false;
        let reserved = 0; // room the other lanes' zips in flight will still take (their downloads may not have begun)
        async function lane() {
            while (!stop && next < todo.length) {
                const zip = todo[next++];
                const label = zip.name;
                const record = { id: zip.id, name: zip.name };
                const zipFile = path.join(zipDir, `${zip.id}.zip`);
                const share = (zip.bytes ?? 2e9) * 2.2;
                let held = 0;
                try {
                    const free = (await freeBytes(outRoot)) - reserved;
                    const need = share + 5e9;
                    if (free < need) {
                        logImpl(`${label}: only ${(free / 1e9).toFixed(1)} GB free after the zips in flight, need ~${(need / 1e9).toFixed(1)} GB; stopping`);
                        stop = true;
                        break;
                    }
                    reserved += share;
                    held = share;
                    let url = (await readFile(zipFile.replace(/\.zip$/i, ".src"), "utf8").catch(() => "")).trim() || zip.urls[0];
                    if (!(await stat(zipFile).catch(() => null))) {
                        logImpl(`${label}: downloading ${zip.bytes ? `${(zip.bytes / 1e9).toFixed(2)} GB` : "?"}`);
                        url = (await downloadWithFallback(zip, zipFile, { fetchImpl, sleepImpl, logImpl, label })).url;
                    }
                    const pack = { id: zip.id, name: zip.name.replace(/\.zip$/i, ""), download: url, bytes: zip.bytes };
                    const manifest = await processPackZip(zipFile, pack, { songsRoot, seen });
                    const zipBytes = (await stat(zipFile)).size;
                    Object.assign(manifest, { source: "malody-4k-converts", file: zip.name, msdRange: { lo: zip.lo, hi: zip.hi }, part: zip.part, zipBytes });
                    const mf = path.join(manifestDir, `${zip.id}.json`);
                    await writeFile(`${mf}.tmp`, JSON.stringify(manifest, null, 1), "utf8");
                    await rename(`${mf}.tmp`, mf);
                    await rm(zipFile); // exactly the zip this run downloaded; the extracted folders stay
                    await rm(zipFile.replace(/\.zip$/i, ".src"), { force: true });
                    Object.assign(record, { ok: true, bytes: zipBytes, from: new URL(url).hostname, songs: manifest.totals.songsWritten, charts: manifest.totals.chartsConverted, skipped: manifest.totals.chartsSkipped, duplicates: manifest.totals.reasons.duplicate ?? 0 });
                    totals.zips += 1;
                    totals.songs += manifest.totals.songsWritten;
                    totals.charts += manifest.totals.chartsConverted;
                    logImpl(`${label}: ${manifest.totals.songsWritten} songs, ${manifest.totals.chartsConverted} charts (${manifest.totals.chartsSkipped} skipped, ${record.duplicates} duplicates)`);
                } catch (error) {
                    totals.failed += 1;
                    if (/not a zip|central directory|truncated/i.test(error?.message ?? "")) {
                        await rm(zipFile, { force: true }); // our own broken download: fetch it again next run
                        await rm(zipFile.replace(/\.zip$/i, ".src"), { force: true });
                    }
                    Object.assign(record, { ok: false, final: Boolean(error?.final), error: String(error?.message ?? error).slice(0, 300) });
                    logImpl(`${label}: failed: ${record.error}`);
                } finally {
                    reserved -= held;
                }
                await appendFile(stateFile, `${JSON.stringify(record)}\n`, "utf8");
                if (next < todo.length) await sleepImpl(pauseMs); // a short breather for the host between zips
            }
        }
        await Promise.all(Array.from({ length: opts.lanes }, () => lane()));
    } finally {
        await unlock();
    }
    logImpl(`done: ${totals.zips} zips, ${totals.songs} songs, ${totals.charts} charts this run; ${totals.failed} failed`);
    return totals;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) await run(parseArgs(process.argv.slice(2)));
