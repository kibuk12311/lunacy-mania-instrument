// The player's own maps for the session page: every 4K osu!mania chart in osu! stable's Songs folder and in a linked
// Interlude library, each analysed once (dan, main patterns, length) and remembered in userData\session-library.json.
// Songs is only read: an .osu whose size and time did not change since the last scan is not read again, and only the
// head of an .osu is read until it is known to be 4K mania. Interlude is read through its library
// (app/interludeLibrary.js, copies of its databases). osu! lazer keeps its maps in a realm database and hashed files,
// which nothing outside lazer can list, so it is not a source here.
// The analysis runs in the background line (app/analysisService.js analyzeQueued), one map at a time, and can be
// paused; the store is written every few maps, so a closed app goes on where it stopped.
import * as nodeFs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { RATE_TAG } from "../src/rate/rateMap.js";

export const STORE_VERSION = 1;
const HEAD_BYTES = 16 * 1024;
const LIST_CONCURRENCY = 8;
const SAVE_EVERY = 100;
const SAVE_MS = 15_000;
const MARATHON_TAG = "lunacy-mania-marathon";

const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The head of an .osu → "mania4k" | "other" | "unknown" (the [Difficulty] section is not in it).
export function headKind(text) {
    const mode = /^Mode\s*:\s*(\d+)/m.exec(text);
    if (mode && mode[1] !== "3") return "other";
    // a head without [Difficulty]: the rest of the file has it, unless the notes start already (a broken file)
    if (!/^\[Difficulty\]/m.test(text)) return /^\[HitObjects\]/m.test(text) ? "other" : "unknown";
    if (!mode) return "other"; // no Mode line: osu!standard
    const cs = Number(/^CircleSize\s*:\s*([\d.]+)/m.exec(text)?.[1]);
    return cs === 4 ? "mania4k" : "other";
}

// A whole .osu → what the library keeps of it, or null when it is not one to play in a session (not 4K mania, or a
// copy the app made: a rate copy or a marathon, whose own map is there already).
export function chartMeta(text) {
    if (headKind(text) !== "mania4k") return null;
    const tags = field(text, "Tags");
    if (tags.split(/\s+/).some((x) => x === RATE_TAG || x === MARATHON_TAG)) return null;
    const beatmapId = Number(field(text, "BeatmapID"));
    const setId = Number(field(text, "BeatmapSetID"));
    return {
        artist: field(text, "Artist"), title: field(text, "Title"), version: field(text, "Version"), creator: field(text, "Creator"),
        beatmapId: Number.isSafeInteger(beatmapId) && beatmapId > 0 ? beatmapId : null,
        setId: Number.isSafeInteger(setId) && setId > 0 ? setId : null,
    };
}

// What of an analysis result the library keeps; a chart the analysis does not rate keeps its kind only.
export function analysisSummary(r) {
    if (r?.kind !== "ok") return { kind: String(r?.kind ?? "error"), ...(r?.reason ? { reason: r.reason } : {}) };
    return {
        kind: "ok", numeric: r.numeric, label: r.label, primary: r.primary ?? null,
        top3: (r.top3 ?? []).slice(0, 3).map((p) => ({ name: String(p.name), share: Math.round(Number(p.share) * 1000) / 1000 })),
        tech: Boolean(r.tech), durationSec: Math.round(Number(r.durationSec) || 0), bpm: Math.round(Number(r.bpm) || 0),
    };
}

// The store as read → a valid one (anything else starts empty).
export function normalizeStore(x, analyzer) {
    const out = { v: STORE_VERSION, analyzer, songsDir: null, folders: {}, maps: {} };
    if (!isObject(x) || x.v !== STORE_VERSION) return out;
    if (typeof x.songsDir === "string" && path.isAbsolute(x.songsDir)) out.songsDir = x.songsDir;
    if (isObject(x.folders)) out.folders = x.folders;
    if (isObject(x.maps)) {
        for (const [id, m] of Object.entries(x.maps)) {
            if (!isObject(m) || !/^(osu:[0-9a-f]{32}|il:[0-9A-F]{64})$/.test(id)) continue;
            // an analysis of another version of the app stays usable until this one has redone it
            out.maps[id] = x.analyzer === analyzer ? m : { ...m, stale: Boolean(m.a) || m.stale };
        }
    }
    return out;
}

// songsDir() → osu! stable's Songs folder from tosu (null while osu! is closed or lazer runs); defaultSongs: where
// stable puts it by default; interlude: app/interludeClient.js; analyze(osuText, rate) → result (the background line);
// file: the store; analyzer: the app version (a new one analyses again); onChange(status) after every step.
export function createSessionLibrary({
    songsDir = async () => null, defaultSongs = null, interlude = null, analyze, file, analyzer = "0", fs = nodeFs,
    log = () => {}, onChange = () => {}, now = Date.now,
}) {
    let store = null;
    let loading = null;
    let picked = null; // a Songs folder picked in the window this run
    let running = null; // Promise of the scan + analysis in progress
    let paused = false;
    let phase = "idle"; // idle | listing | analysing | paused | done
    let lastError = null;
    let lastScan = null; // { ms, listed, read } of the last listing
    let interludeState = { linked: false, count: 0 };
    let dirty = 0;
    let savedAt = 0;
    let savePromise = Promise.resolve();

    const load = () => (loading ??= fs.readFile(file, "utf8").then(JSON.parse).catch(() => null)
        .then((x) => { store = normalizeStore(x, analyzer); return store; }));

    function save() {
        if (!store) return savePromise;
        dirty = 0;
        savedAt = now();
        const text = JSON.stringify(store);
        savePromise = savePromise.then(async () => {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(`${file}.tmp`, text, "utf8");
            await fs.rename(`${file}.tmp`, file);
        }).catch((error) => log(`session library save failed: ${error?.message}`));
        return savePromise;
    }

    function counts() {
        const c = { stable: 0, interlude: 0, both: 0, total: 0, analysed: 0, pending: 0, stale: 0, skipped: 0, failed: 0 };
        for (const m of Object.values(store?.maps ?? {})) {
            c.total += 1;
            if (m.path && m.hash) c.both += 1;
            else if (m.path) c.stable += 1;
            else c.interlude += 1;
            if (m.a?.kind === "ok") c.analysed += 1;
            else if (m.a?.kind === "error") c.failed += 1;
            else if (m.a) c.skipped += 1;
            if (!m.a || m.stale) c.pending += 1;
            if (m.stale) c.stale += 1;
        }
        return c;
    }

    async function status() {
        await load();
        return {
            phase, paused, songsDir: store.songsDir, interlude: interludeState, counts: counts(), lastScan,
            ...(lastError ? { error: lastError } : {}),
        };
    }

    const tell = () => { status().then(onChange, () => {}); };

    const statOf = (p) => fs.stat(p).catch(() => null);

    // The Songs folder: osu!'s own (tosu), the one picked, the one seen last, stable's default place.
    async function resolveSongs() {
        let dir = null;
        try {
            dir = await songsDir();
        } catch {
            dir = null;
        }
        for (const d of [dir, picked, store.songsDir, defaultSongs]) {
            if (typeof d === "string" && d && (await statOf(d))?.isDirectory()) return d;
        }
        return null;
    }

    async function readHead(p) {
        const handle = await fs.open(p, "r");
        try {
            const buf = Buffer.alloc(HEAD_BYTES);
            const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
            return buf.subarray(0, bytesRead).toString("utf8");
        } finally {
            await handle.close();
        }
    }

    // One set folder: its .osu files, each read again only when its size or time changed (a folder's own time does
    // not change when a file in it is saved over, so every file is looked at). → { entry: { files }, read }
    async function listFolder(dir, name, known) {
        const full = path.join(dir, name);
        let names;
        try {
            names = await fs.readdir(full);
        } catch {
            return null;
        }
        const files = {};
        let read = 0;
        for (const f of names.map(String).filter((x) => x.toLowerCase().endsWith(".osu"))) {
            const p = path.join(full, f);
            const fst = await statOf(p);
            if (!fst?.isFile()) continue;
            const old = known?.files?.[f];
            if (old && old.s === fst.size && old.m === fst.mtimeMs) {
                files[f] = old;
                continue;
            }
            read += 1;
            let id = null;
            try {
                const head = await readHead(p);
                const kind = headKind(head);
                if (kind !== "other") {
                    const bytes = await fs.readFile(p);
                    const meta = chartMeta(bytes.toString("utf8"));
                    if (meta) {
                        id = `osu:${md5(bytes)}`;
                        const prev = store.maps[id];
                        store.maps[id] = { ...(prev ?? {}), ...meta, path: p, md5: id.slice(4) };
                    }
                }
            } catch (error) {
                log(`session library: ${p} not read: ${error?.message}`);
            }
            files[f] = { s: fst.size, m: fst.mtimeMs, id };
        }
        return { entry: { files }, read };
    }

    async function listSongs() {
        const dir = await resolveSongs();
        if (!dir) return { dir: null, listed: 0, read: 0 };
        if (store.songsDir !== dir) {
            // another folder: what was known of the old one is not this one's
            store.folders = {};
            store.songsDir = dir;
        }
        let names = [];
        try {
            names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => String(d.name));
        } catch (error) {
            log(`session library: Songs not listed: ${error?.message}`);
            return { dir, listed: 0, read: 0 };
        }
        const folders = {};
        let next = 0;
        let read = 0;
        const worker = async () => {
            while (next < names.length) {
                const name = names[next++];
                const out = await listFolder(dir, name, store.folders[name]);
                if (out) {
                    folders[name] = out.entry;
                    read += out.read;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, names.length) }, worker));
        store.folders = folders;
        return { dir, listed: names.length, read };
    }

    // The ids every listed .osu stands for, and the paths they are at now.
    // A folder whose chart the store has lost is listed again next time.
    function stableIds() {
        const ids = new Map();
        for (const [name, folder] of Object.entries(store.folders)) {
            for (const [f, e] of Object.entries(folder.files ?? {})) {
                if (!e?.id) continue;
                if (!store.maps[e.id]) delete store.folders[name];
                else if (!ids.has(e.id)) ids.set(e.id, path.join(store.songsDir, name, f));
            }
        }
        return ids;
    }

    async function listInterlude() {
        const st = interlude ? await interlude.status().catch(() => ({ linked: false })) : { linked: false };
        if (!st.linked) {
            interludeState = { linked: false, count: 0 };
            return new Map();
        }
        try {
            const charts = await interlude.library.list({ keys: 4 });
            interludeState = { linked: true, count: charts.length };
            return new Map(charts.map((c) => [c.hash, c]));
        } catch (error) {
            interludeState = { linked: true, count: 0, error: String(error?.message ?? error) };
            log(`session library: Interlude not read: ${error?.message}`);
            return new Map();
        }
    }

    // The maps the store keeps: every stable chart listed (with the Interlude chart that is the same .osu), then the
    // Interlude charts that are not in Songs. Charts gone from both are forgotten.
    function merge(stable, charts) {
        const maps = {};
        const byMd5 = new Map();
        for (const [id, p] of stable) {
            const m = store.maps[id];
            if (!m) continue;
            const { hash: _old, ...rest } = m;
            maps[id] = { ...rest, path: p };
            byMd5.set(id.slice(4), id);
        }
        for (const [hash, c] of charts) {
            const same = (c.origins ?? []).map((o) => o.md5).find((h) => h && byMd5.has(h));
            if (same) {
                maps[byMd5.get(same)].hash = hash;
                continue;
            }
            const id = `il:${hash}`;
            const prev = store.maps[id];
            maps[id] = {
                ...(prev ?? {}), hash, artist: c.artist, title: c.title, version: c.version, creator: c.creator,
                beatmapId: c.beatmapId ?? null,
            };
        }
        store.maps = maps;
    }

    async function textOf(id, m) {
        if (m.path) return fs.readFile(m.path, "utf8");
        const osu = await interlude.library.osuFor(m.hash);
        if (!osu) throw new Error("chart not found in Interlude");
        return osu.text;
    }

    async function analyseAll(isStopped) {
        // never analysed first, then the ones another version analysed
        const todo = Object.entries(store.maps).filter(([, m]) => !m.a || m.stale).sort((x, y) => Number(Boolean(x[1].stale)) - Number(Boolean(y[1].stale)));
        for (const [id] of todo) {
            if (isStopped()) return false;
            const m = store.maps[id];
            if (!m || (m.a && !m.stale)) continue;
            let result;
            try {
                result = await analyze(await textOf(id, m), 1);
            } catch (error) {
                result = { kind: "error", message: String(error?.message ?? error) };
            }
            // a worker hiccup (or a stop) is no answer: the map is tried again on the next scan
            if (result?.transient || !store.maps[id]) continue;
            const { stale: _s, ...rest } = store.maps[id];
            store.maps[id] = { ...rest, a: analysisSummary(result) };
            dirty += 1;
            if (dirty >= SAVE_EVERY || now() - savedAt > SAVE_MS) await save();
            tell();
        }
        return true;
    }

    async function run() {
        await load();
        lastError = null;
        phase = "listing";
        tell();
        const started = now();
        const songs = await listSongs();
        const charts = await listInterlude();
        merge(stableIds(), charts);
        lastScan = { ms: now() - started, sets: songs.listed, read: songs.read };
        log(`session library: ${songs.dir ?? "no Songs folder"}: ${songs.listed} sets, ${songs.read} .osu read; Interlude ${interludeState.linked ? charts.size : "not linked"}; ${Object.keys(store.maps).length} maps, listed in ${lastScan.ms} ms`);
        await save();
        if (paused) {
            phase = "paused";
            tell();
            return;
        }
        phase = "analysing";
        tell();
        const finished = await analyseAll(() => paused);
        await save();
        phase = finished ? "done" : "paused";
        log(`session library: analysis ${phase}, ${counts().analysed} rated, ${counts().pending} to go`);
        tell();
    }

    // Lists and analyses once at a time; asked again meanwhile, the same run answers.
    function scan() {
        running ??= run().catch((error) => {
            lastError = String(error?.message ?? error);
            phase = "idle";
            log(`session library failed: ${lastError}`);
            tell();
        }).finally(() => { running = null; });
        return running;
    }

    return {
        status,
        scan,
        pause() {
            paused = true;
            tell();
        },
        resume() {
            paused = false;
            return scan();
        },
        // The Settings page's "clear": the list and its analyses forgotten (not while a scan runs); the next scan
        // lists and analyses again.
        async clear() {
            if (running) return { ok: false, busy: true };
            await load();
            store = normalizeStore(null, analyzer);
            lastScan = null;
            lastError = null;
            phase = "idle";
            await save();
            tell();
            return { ok: true };
        },
        // A Songs folder picked in the window (osu! closed, or not where tosu says).
        async pickSongs(dir) {
            await load();
            picked = dir;
            // a run already going is for the folder before: this one is listed after it
            await (running ?? Promise.resolve());
            return scan();
        },
        // The analysed, rated maps as the session builder takes them.
        async maps() {
            await load();
            const out = [];
            for (const [id, m] of Object.entries(store.maps)) {
                if (m.a?.kind !== "ok") continue;
                out.push({
                    id, artist: m.artist, title: m.title, version: m.version, creator: m.creator, beatmapId: m.beatmapId ?? null,
                    numeric: m.a.numeric, label: m.a.label, primary: m.a.primary, top3: m.a.top3, tech: m.a.tech,
                    durationSec: m.a.durationSec, bpm: m.a.bpm,
                    sources: { ...(m.path ? { stable: { path: m.path, md5: m.md5 } } : {}), ...(m.hash ? { interlude: { hash: m.hash } } : {}) },
                });
            }
            return out;
        },
        // The chart text of a map of the library (for a rate fit).
        async text(id) {
            await load();
            const m = store.maps[id];
            if (!m) throw new Error("not in the library");
            return textOf(id, m);
        },
        idle: () => running ?? Promise.resolve(),
        flush: () => save(),
    };
}
