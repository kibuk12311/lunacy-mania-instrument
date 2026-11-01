// The Replay tab's main side. A replay is a .osr: dropped or picked anywhere, or from osu! stable's own folders (Replays,
// and Data\r, where it keeps one for every local score). Its map is found by md5 in the Songs folder (the local profile's
// index, app/osuSongsScan.js, so a scan made once serves both), its audio is handed to the window, and the skin set in
// osu! is read as it is: skin.ini's 4K section and the pictures it names. Everything under the osu! folder is only
// ever read; the one thing this module writes is its own replay.json (the folder picked by hand, the after-a-play switch)
// in userData. The folder: the one picked (checked on every read, app/osuFolder.js), else what tosu says while osu! stable
// runs, else the local profile's, %LOCALAPPDATA%\osu!, or where Windows opens stable's .osz files from.
// Dans and pattern families come from the map's usual details and parts (the shared cache, the background line).
// When a play ends (the local profile's recorder sees it from tosu) the replay osu! stable writes for it into Data\r is
// looked for by the map's md5 and the file's time, and the window is told: only told, so nothing takes focus from the game.
// Stable's own header counts are 16 bits; a replay's are put right in analyzeReplay, the list's here (LIST_WRAP_BYTES).
import path from "node:path";
import * as nodeFs from "node:fs/promises";
import { createJsonStore } from "./jsonStore.js";
import { songsIndexAt } from "./osuSongsScan.js";
import { songsIndexFile } from "./localProfileIpc.js";
import { gameFolderOf, osuAssociation } from "./osuFolder.js";
import { decodeIni, skinImages, walkSkin } from "./skinIpc.js";
import { detailsKey, looksLikeDetails } from "./analysisDetails.js";
import { sectionsKey, looksLikeSections } from "./analysisSections.js";
import { cacheKey } from "../src/core/cache.js";
import { parseSkinIni, pairsOf, getValue, maniaSections } from "../src/skin/skinIni.js";
import { maniaConfig } from "../src/skin/maniaFields.js";
import { parseManiaNotes } from "../src/overlay/maniaNotes.js";
import { noteTimes, splitSections } from "../src/analysis/sections.js";
import { BREAK } from "../src/analysis/timeline.js";
import { readOsr, unpackFrames, keyPresses, fullCounts, MANIA, COUNT_WRAP } from "../src/replay/osr.js";
import { analyzeReplay } from "../src/replay/analyze.js";
import { accuracyPercent, KINDS } from "../src/replay/judge.js";
import { handsOf, validFingers } from "../src/replay/fingers.js";
import { t } from "../src/i18n/i18n.js";

export const LIST_MAX = 40;
export const FOLDERS = [{ dir: "Replays", id: "exported" }, { dir: path.join("Data", "r"), id: "local" }];
const LIST_READ_MAX = 240; // files read for their header per list: most recent first, other modes are skipped over
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const INDEX_FRESH_MS = 60_000; // the Songs folder is looked over at most this often, unless a map is not found
const EARLIER_MAX = 12; // earlier plays of a map worked out for the comparison, newest first
// After a play: how long to look for its replay. A pass always gets one, but when is up to osu!: on 66 real passes the file
// came 0.6 to 164 s after the results screen opened (median 9 s, 1 in 6 after 20 s), maybe only as the player leaves that
// screen, so a pass is looked for as long as anyone sits there, and until a little after the next play has begun. A failed
// or quit play has one only if the player saved it by hand, so those are not waited for long.
export const ENDED_WAIT_MS = { pass: 10 * 60_000, fail: 4_000, quit: 1_500 };
export const NEXT_PLAY_GRACE_MS = 15_000;
const WAIT_NOTE_MS = 3_000; // a replay this quick needs no note that it is on its way
const ENDED_STEP_MS = 400;
const ENDED_SLOW_STEP_MS = 2_000; // Data\r holds thousands of files: after the first moments it is looked over less often
const ENDED_SLOW_AFTER_MS = 30_000;
// A replay under this many packed bytes cannot hold 65 536 judgements, so its counts cannot have wrapped (real replays pack
// to 2 bytes or more a judgement). Only a longer one costs the list a look at its map.
const LIST_WRAP_BYTES = 64 * 1024;
const fail = (error) => ({ ok: false, message: String(error?.message ?? error) });

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/[\\/]+$/, "") : null);

// What tosu says of osu! stable: { game, songs, skin } (nulls while it reads lazer, osu! is closed or tosu is down).
export async function tosuFolders(port, fetchImpl = globalThis.fetch) {
    const none = { game: null, songs: null, skin: null };
    if (!port) return none;
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return none;
        const j = await res.json();
        if (String(j?.client ?? "stable").toLowerCase() === "lazer") return none;
        return { game: clean(j?.folders?.game), songs: clean(j?.folders?.songs), skin: clean(j?.folders?.skin) };
    } catch {
        return none;
    }
}

// The .cfg of the Windows user last playing: osu!.<user>.cfg, "Key = Value" lines → { skin, songs } (nulls without one).
export async function readOsuConfig(game, fs = nodeFs) {
    const none = { skin: null, songs: null };
    const names = (await fs.readdir(game).catch(() => [])).map(String).filter((n) => /^osu!\..+\.cfg$/i.test(n));
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await fs.stat(path.join(game, name)).catch(() => null))?.mtimeMs ?? 0 })));
    const newest = dated.sort((a, b) => b.at - a.at)[0];
    if (!newest) return none;
    const text = await fs.readFile(path.join(game, newest.name), "utf8").catch(() => "");
    const value = (key) => clean(new RegExp(`^${key}\\s*=\\s*(.*?)\\s*$`, "m").exec(text)?.[1] ?? null);
    const dir = value("BeatmapDirectory");
    return { skin: value("Skin"), songs: dir ? path.resolve(game, dir) : null };
}

// A map's audio file name from the .osu's [General].
export const audioFileOf = (osuText) => /^\s*AudioFilename\s*:\s*(.+?)\s*$/m.exec(String(osuText))?.[1] ?? null;
export const overallDifficulty = (osuText) => {
    const od = Number(/^\s*OverallDifficulty\s*:\s*([\d.]+)/m.exec(String(osuText))?.[1]);
    return Number.isFinite(od) ? od : 5;
};

const shownCounts = (h) => ({ ...h.counts, accuracy: accuracyPercent(h.counts) });

// fs, tosu ({ game, songs, skin }) and the index are injected; profileFolder() → the folder the local profile keeps;
// association() → the folder Windows knows (app/osuFolder.js); analysis / worker / cache: the shared analysis, used only
// for the parts' dans and the pattern families.
export function createReplayService({
    userData, env = process.env, fs = nodeFs, dialog = null, window = () => null, log = () => {}, send = () => {},
    tosu = async () => ({ game: null, songs: null, skin: null }), profileFolder = async () => null, association = async () => null, songsIndex = null,
    analysis = null, worker = null, cache = null, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    playing = () => false,
}) {
    const store = createJsonStore({
        file: path.join(userData, "replay.json"), fallback: { folder: null, afterPlay: true },
        normalize: (v) => ({ folder: clean(v?.folder), afterPlay: v?.afterPlay !== false }),
    });
    const index = songsIndex ?? songsIndexAt(songsIndexFile(userData));
    let charts = null; // md5 → the map (the last scan's answer)
    let scannedAt = 0;
    let scannedDir = null;
    let scanning = null; // the scan under way: { dir, run }
    let current = null; // the replay open: { id, file, text, mapPath, rate, analysis, notes, keys, od, header }
    let nextId = 1;
    let lastEnded = 0; // which play's replay is being waited for: a newer play ends the wait for an older one

    const isDir = async (p) => Boolean((await fs.stat(p).catch(() => null))?.isDirectory());

    // What was saved is only ever read here: a folder inside the game counts as the game, one that leads nowhere is passed
    // over, and stays saved in case its drive comes back.
    // { folder, source: "picked" | "tosu" | "profile" | "default" | "association" | null, picked }
    async function folder() {
        const picked = await gameFolderOf((await store.get()).folder, fs);
        if (picked) return { folder: picked, source: "picked", picked };
        const live = await tosu();
        if (live.game && await isDir(live.game)) return { folder: live.game, source: "tosu", picked: null };
        const others = {
            profile: () => profileFolder().catch(() => null),
            default: () => (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "osu!") : null),
            association,
        };
        for (const [source, where] of Object.entries(others)) {
            const game = await gameFolderOf(await where(), fs);
            if (game) return { folder: game, source, picked: null };
        }
        return { folder: null, source: null, picked: null };
    }

    async function songsDir(game) {
        const live = await tosu();
        for (const dir of [live.songs, (await readOsuConfig(game, fs)).songs, path.join(game, "Songs")]) {
            if (dir && await isDir(dir)) return dir;
        }
        return null;
    }

    // md5 → the map; a rescan at most every INDEX_FRESH_MS unless asked (a replay whose map was just not found)
    async function mapIndex(game, { force = false } = {}) {
        const dir = await songsDir(game);
        if (!dir) return null;
        if (charts && scannedDir === dir && !force && now() - scannedAt < INDEX_FRESH_MS) return charts;
        if (scanning?.dir === dir) return scanning.run; // one of another folder is left to end, unheard: the folder was changed
        const scan = { dir, run: null };
        scanning = scan;
        scan.run = index.scan(dir, {
            onProgress: ({ done, total }) => { if (scanning === scan) send("replay-progress", { done, total }); },
        }).then((r) => {
            charts = r.charts;
            scannedAt = now();
            scannedDir = dir;
            return charts;
        }).finally(() => { if (scanning === scan) scanning = null; });
        return scan.run;
    }

    // The header's counts for the list, which has no frames to go by: put right only when they are short of the map's notes
    // by whole 65 536s, a play that got to the end. (A failed play that long keeps its wrapped counts here.)
    async function listCounts(h, map) {
        if (!map || h.packed.length < LIST_WRAP_BYTES) return h.counts;
        const notes = parseManiaNotes((await fs.readFile(map.path)).toString("utf8")).notes.length;
        return (notes - h.total) % COUNT_WRAP === 0 ? fullCounts(h.counts, notes) : h.counts;
    }

    async function list({ titles = false, limit = LIST_MAX } = {}) {
        const place = await folder();
        if (!place.folder) return { ok: true, ...place, items: [] };
        const found = [];
        for (const { dir, id } of FOLDERS) {
            const full = path.join(place.folder, dir);
            for (const name of (await fs.readdir(full).catch(() => [])).map(String).filter((n) => n.toLowerCase().endsWith(".osr"))) {
                const stat = await fs.stat(path.join(full, name)).catch(() => null);
                if (stat?.isFile()) found.push({ file: path.join(full, name), kind: id, at: stat.mtimeMs, size: stat.size });
            }
        }
        found.sort((a, b) => b.at - a.at);
        const maps = titles ? await mapIndex(place.folder).catch(() => null) : null;
        const items = [];
        const seen = new Set();
        for (const entry of found.slice(0, LIST_READ_MAX)) {
            if (items.length >= limit) break;
            if (entry.size > MAX_REPLAY_BYTES) continue;
            try {
                const h = readOsr(await fs.readFile(entry.file));
                if (h.mode !== MANIA) continue;
                // the same play exported into Replays and kept in Data\r: once
                const key = `${h.md5}:${h.at ?? entry.at}:${h.score}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const map = maps?.get(h.md5) ?? null;
                const counts = await listCounts(h, map);
                items.push({
                    file: entry.file, kind: entry.kind, md5: h.md5, player: h.player, at: h.at ?? entry.at, modNames: h.modNames, rate: h.rate,
                    accuracy: accuracyPercent(counts), miss: counts.miss, score: h.score,
                    artist: map?.artist ?? null, title: map?.title ?? null, version: map?.version ?? null, found: titles ? Boolean(map) : null,
                });
            } catch {
                // a replay that cannot be read is left out of the list
            }
        }
        return { ok: true, ...place, items };
    }

    function publicReplay(file, h) {
        return {
            file: path.basename(file), player: h.player, at: h.at, modNames: h.modNames, rate: h.rate, score: h.score,
            maxCombo: h.maxCombo, perfect: h.perfect, counts: shownCounts(h), md5: h.md5,
        };
    }

    async function chooseFile(given) {
        if (given) return String(given);
        const r = await dialog?.showOpenDialog(window(), { title: t("replay.pickTitle"), properties: ["openFile"], filters: [{ name: "osu! replay", extensions: ["osr"] }] });
        return !r || r.canceled || !r.filePaths?.[0] ? null : r.filePaths[0];
    }

    async function open({ file = null } = {}) {
        const chosen = await chooseFile(file);
        if (!chosen) return { ok: false, cancelled: true };
        if (!/\.osr$/i.test(chosen)) return { ok: false, message: t("replay.err.notReplay") };
        const stat = await fs.stat(chosen).catch(() => null);
        if (!stat?.isFile()) return { ok: false, message: t("replay.err.noFile") };
        if (stat.size > MAX_REPLAY_BYTES) return { ok: false, message: t("replay.err.tooBig") };
        let header;
        try {
            header = readOsr(await fs.readFile(chosen));
        } catch {
            return { ok: false, message: t("replay.err.badReplay") };
        }
        if (header.mode !== MANIA) return { ok: false, message: t("replay.err.notMania") };
        const place = await folder();
        const replay = publicReplay(chosen, header);
        const id = nextId;
        nextId += 1;
        current = null;
        let map = null;
        if (place.folder) {
            const maps = await mapIndex(place.folder).catch(() => null);
            map = maps?.get(header.md5) ?? null;
            if (!map && maps) map = (await mapIndex(place.folder, { force: true }).catch(() => null))?.get(header.md5) ?? null;
        }
        if (!map) return { ok: true, id, replay, map: null, analysis: null, reason: "nomap", folder: place.folder };
        const bytes = await fs.readFile(map.path);
        const text = bytes.toString("utf8").replace(/^﻿/, "");
        const { notes, keys } = parseManiaNotes(text);
        let frames;
        try {
            frames = unpackFrames(header.packed, keys);
        } catch {
            return { ok: false, message: t("replay.err.badReplay") };
        }
        const columns = keyPresses(frames, keys);
        const parts = splitSections(noteTimes(text), { rate: header.rate }).map(({ fromMs, toMs }) => ({ fromMs, toMs }));
        const od = overallDifficulty(text);
        const result = analyzeReplay({ header, notes, keys, od, frames, columns, parts });
        replay.counts = shownCounts({ counts: result.headerCounts });
        replay.maxCombo = result.headerCombo ?? replay.maxCombo;
        const mapInfo = {
            artist: map.artist, title: map.title, version: map.version, od, keys, audio: Boolean(audioFileOf(text)),
            notes: notes.map((n) => ({ t: n.t, col: n.col, end: n.end })),
        };
        current = { id, file: chosen, text, mapPath: map.path, rate: header.rate, analysis: result.reason ? null : result, notes, keys, od, header };
        log(`replay: ${notes.length} notes, ${result.reason ?? `manip ${result.manip.percent}%`}`);
        return {
            ok: true, id, replay, map: mapInfo, presses: columns, analysis: result.reason ? null : result, reason: result.reason ?? null,
            lastMs: frames.times.at(-1) ?? 0,
        };
    }

    // The song of the replay open: its bytes, from the map's own folder.
    async function audio({ id } = {}) {
        if (!current || current.id !== id) return { ok: false, stale: true };
        const name = audioFileOf(current.text);
        if (!name) return { ok: false, message: t("replay.err.noAudio") };
        const dir = path.dirname(current.mapPath);
        const file = path.resolve(dir, name);
        if (!file.startsWith(path.resolve(dir) + path.sep)) return { ok: false, message: t("replay.err.noAudio") };
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile() || stat.size > MAX_AUDIO_BYTES) return { ok: false, message: t("replay.err.noAudio") };
        return { ok: true, id, data: await fs.readFile(file) };
    }

    // A skin of osu!'s Skins folder as it is, read only: folder asked for, else the one set in osu!. Without any, or with
    // plain, the plain playfield: config with osu!'s defaults and no pictures.
    async function skin({ folder: asked = null, plain: wantPlain = false } = {}) {
        const place = await folder();
        const root = place.folder ? path.join(place.folder, "Skins") : null;
        const plain = { ok: true, skins: [], current: null, chosen: null, name: null, config: maniaConfig(new Map()), images: {}, mania4: false };
        if (!root || !(await isDir(root))) return plain;
        const skins = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
        const set = (await tosu()).skin ?? (await readOsuConfig(place.folder, fs)).skin;
        const inList = (name) => skins.find((s) => s.toLowerCase() === String(name ?? "").toLowerCase()) ?? null;
        const chosen = wantPlain ? null : inList(asked) ?? inList(set);
        const answer = { ...plain, skins, current: inList(set) };
        if (!chosen) return answer;
        const dir = path.join(root, chosen);
        const files = await walkSkin(dir, fs).catch(() => []);
        const iniName = files.find((f) => f.toLowerCase() === "skin.ini");
        const doc = parseSkinIni(iniName ? decodeIni(await fs.readFile(path.join(dir, iniName))).text : "");
        const config = maniaConfig(pairsOf(doc, { mania: 4 }));
        const images = await skinImages(dir, files, [...new Set(Object.values(config.images))], fs);
        return { ...answer, chosen, name: getValue(doc, "General", "Name") || chosen, config, images, mania4: maniaSections(doc).some((s) => s.keys === 4) };
    }

    async function cachedOr(key, looksRight, work) {
        const hit = await Promise.resolve(cache?.get(key)).catch(() => null);
        if (looksRight(hit)) return hit;
        const value = await work();
        if (looksRight(value)) await Promise.resolve(cache?.set(key, value)).catch(() => {});
        return looksRight(value) ? value : null;
    }

    // What takes the analysis: the pattern families' manip and the parts' dans, as soon as the background line gets there.
    async function details({ id } = {}) {
        const open = current;
        if (!open || open.id !== id || !open.analysis) return { ok: false, stale: true };
        if (!analysis) return { ok: true, id, families: [], spanMs: 0, dans: [] };
        const stillOpen = () => current?.id === id;
        const key = cacheKey(open.text, open.rate);
        const job = (fn) => analysis.enqueue((on = worker) => fn(on), { isCancelled: () => !stillOpen() });
        const info = await cachedOr(detailsKey(key), looksLikeDetails, async () => (await job((on) => on.details(open.text, open.rate)))?.details ?? null);
        if (!stillOpen()) return { ok: false, stale: true };
        const parts = await cachedOr(sectionsKey(key), looksLikeSections, async () => (await job((on) => on.sections(open.text, open.rate)))?.sections ?? null);
        if (!stillOpen()) return { ok: false, stale: true };
        return {
            ok: true, id, families: (info?.families ?? []).map((family) => (family && family !== BREAK ? family : null)),
            spanMs: (info?.durationSec ?? 0) * 1000 * open.rate, dans: parts ? parts.parts.map((p) => p.dan ?? null) : [],
        };
    }

    // The replays of a map: [{ file, at (the file's time) }]. Data\r names its files <md5>-<ticks>.osr, so nothing else
    // there is looked at; Replays names them after the player, so its newest are offered too and `since` leaves old ones.
    async function replaysOfMap(game, md5, since = 0) {
        const found = [];
        for (const { dir, id } of FOLDERS) {
            const full = path.join(game, dir);
            const names = (await fs.readdir(full).catch(() => [])).map(String).filter((n) => {
                const low = n.toLowerCase();
                return low.endsWith(".osr") && (id !== "local" || low.startsWith(`${md5}-`));
            });
            for (const name of names) {
                const stat = await fs.stat(path.join(full, name)).catch(() => null);
                if (stat?.isFile() && stat.size <= MAX_REPLAY_BYTES && stat.mtimeMs >= since) found.push({ file: path.join(full, name), at: stat.mtimeMs });
            }
        }
        return found.sort((a, b) => b.at - a.at).slice(0, LIST_READ_MAX);
    }

    const samePlay = (a, b) => a.md5 === b.md5 && a.score === b.score && a.at === b.at;

    // The player's earlier plays of the map open, each worked out like the open one: newest first, up to EARLIER_MAX.
    // fingers: the tab's (they decide the hands, so the manip here counts what the open play's manip counts).
    // → { plays: [{ at, rate, modNames, accuracy, misses, maxCombo, ur, manip, pairs }], total }.
    async function earlier({ id, fingers = null } = {}) {
        const open = current;
        if (!open || open.id !== id || !open.analysis) return { ok: false, stale: true };
        const place = await folder();
        const none = { ok: true, id, plays: [], total: 0 };
        if (!place.folder) return none;
        const { header, notes, keys, od } = open;
        const hands = handsOf(validFingers(fingers));
        const before = [];
        for (const entry of await replaysOfMap(place.folder, header.md5)) {
            try {
                const h = readOsr(await fs.readFile(entry.file));
                if (h.mode !== MANIA || h.md5 !== header.md5 || h.player !== header.player || samePlay(h, header) || before.some((other) => samePlay(other, h))) continue;
                if ((h.at ?? entry.at) < (header.at ?? Infinity)) before.push(h);
            } catch {
                // a replay that cannot be read is left out
            }
        }
        before.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        const plays = [];
        for (const h of before.slice(0, EARLIER_MAX)) {
            await sleep(0); // a long list must not hold up the window's other calls
            if (current?.id !== id) return { ok: false, stale: true };
            try {
                const frames = unpackFrames(h.packed, keys);
                const a = analyzeReplay({ header: h, notes, keys, od, frames, columns: keyPresses(frames, keys), hands });
                if (a.reason) continue;
                plays.push({ at: h.at, rate: h.rate, modNames: h.modNames, accuracy: a.accuracy, misses: a.counts.miss, maxCombo: a.headerCombo, ur: a.ur, manip: a.manip.percent, pairs: a.manip.pairs });
            } catch {
                // left out
            }
        }
        return { ok: true, id, plays, total: before.length };
    }

    // The newest replay of a play that just ended, null when there is none yet: a file of its map written since it began.
    async function replayOfPlay(play, game) {
        for (const entry of await replaysOfMap(game, play.md5, play.startedAt)) {
            try {
                const h = readOsr(await fs.readFile(entry.file));
                if (h.mode === MANIA && h.md5 === play.md5) return entry.file;
            } catch {
                // osu! may still be writing it: the next look reads it whole
            }
        }
        return null;
    }

    // Watching one's own replay in osu! reads as a play of one's own, with no new file. What gives it away: the play's counts
    // are those of a replay of the map already there before it began. (16 bits, so compared as the file holds them.)
    async function looksWatched(play, game) {
        if (!play.hits) return false;
        const sameCounts = (h) => KINDS.every((k) => h.counts[k] % COUNT_WRAP === (play.hits[k] ?? 0) % COUNT_WRAP);
        for (const entry of await replaysOfMap(game, play.md5)) {
            if (entry.at >= play.startedAt) continue;
            try {
                const h = readOsr(await fs.readFile(entry.file));
                if (h.mode === MANIA && h.md5 === play.md5 && sameCounts(h)) return true;
            } catch {
                // a replay that cannot be read is left out
            }
        }
        return false;
    }

    // A play ended (the local profile's recorder). Looks for its replay and tells the window: replay-ended { outcome, md5,
    // artist, title, version, rate, accuracy, at, file, reason, moved } with file the replay, or null and reason "noFolder",
    // "lazer" (lazer keeps replays in its own store) or "none", moved when the player is in the next play by then, so the
    // tab should not jump. Also with waiting: true, once, when a pass's replay is taking its time (no word yet on whether it
    // will come). A replay that was only watched in osu! gets its own file looked for all the same, in case it was a real
    // play with the very same counts, but no "no replay" at the end of that: nothing is said.
    async function playEnded(play) {
        if (!(await store.get()).afterPlay || !play?.md5) return null;
        lastEnded += 1;
        const turn = lastEnded;
        const told = {
            outcome: play.outcome, md5: play.md5, artist: play.artist, title: play.title, version: play.version, rate: play.rate,
            accuracy: play.accuracy === null || play.accuracy === undefined ? null : Math.round(play.accuracy * 10000) / 100, at: play.at,
        };
        const answer = (file, reason = null, moved = false) => {
            const out = { ...told, file, reason, moved };
            send("replay-ended", out);
            return out;
        };
        if (play.client === "lazer") return answer(null, "lazer");
        const place = await folder();
        if (!place.folder) return answer(null, "noFolder");
        const from = now();
        const until = from + (ENDED_WAIT_MS[play.outcome] ?? ENDED_WAIT_MS.quit);
        const watched = await looksWatched(play, place.folder);
        let nextPlayAt = null;
        let noted = watched || play.outcome !== "pass";
        for (;;) {
            const file = await replayOfPlay(play, place.folder);
            if (turn !== lastEnded || !(await store.get()).afterPlay) return null;
            if (file) return answer(file);
            if (playing()) nextPlayAt ??= now();
            const moved = nextPlayAt !== null && now() - nextPlayAt >= NEXT_PLAY_GRACE_MS;
            if (moved || now() >= until) {
                if (watched) return null;
                return answer(null, "none", moved);
            }
            if (!noted && now() - from >= WAIT_NOTE_MS) {
                noted = true;
                send("replay-ended", { ...told, file: null, reason: null, waiting: true });
            }
            await sleep(now() - from < ENDED_SLOW_AFTER_MS ? ENDED_STEP_MS : ENDED_SLOW_STEP_MS);
            if (turn !== lastEnded) return null;
        }
    }

    async function setAfterPlay({ on = true } = {}) {
        await store.update((v) => ({ ...v, afterPlay: Boolean(on) }));
        return { ok: true, afterPlay: Boolean(on) };
    }

    async function setFolder(next) {
        await store.update((v) => ({ ...v, folder: clean(next) }));
        charts = null;
        scanning = null;
        const place = { ok: true, ...(await folder()) };
        send("replay-folder", place);
        return place;
    }

    async function pickFolder() {
        const r = await dialog?.showOpenDialog(window(), { title: t("replay.pickFolder"), properties: ["openDirectory"] });
        if (!r || r.canceled || !r.filePaths?.[0]) return { ok: false, cancelled: true };
        const game = await gameFolderOf(r.filePaths[0], fs);
        if (!game) return { ok: false, message: t("replay.err.notOsuFolder") };
        return setFolder(game);
    }

    const safe = (fn) => async (req) => {
        try {
            return await fn(req ?? {});
        } catch (error) {
            log(`replay: ${error?.message}`);
            return fail(error);
        }
    };

    return {
        status: safe(async () => ({ ok: true, ...(await folder()), afterPlay: (await store.get()).afterPlay })),
        list: safe(list), open: safe(open), audio: safe(audio), skin: safe(skin), details: safe(details), earlier: safe(earlier),
        pickFolder: safe(pickFolder), resetFolder: safe(() => setFolder(null)), setAfterPlay: safe(setAfterPlay), playEnded: safe(playEnded),
    };
}

export function registerReplayIpc({ ipcMain, paths, dialog, window, log, send, tosu, analysis, worker, resultCache, localProfile, hooks }) {
    // made on the first call: registering does no I/O and reads no paths
    let service = null;
    const get = () => (service ??= createReplayService({
        userData: paths.userData, dialog, window, log, send, tosu: () => tosuFolders(tosu.port), analysis, worker, cache: resultCache,
        profileFolder: async () => (await localProfile?.osuFolder?.()) ?? null, association: osuAssociation,
        playing: () => localProfile?.playing?.() ?? false,
    }));
    const s = new Proxy({}, { get: (_t, key) => (req) => get()[key](req) });
    ipcMain.handle("replay-status", () => s.status());
    ipcMain.handle("replay-list", (_e, req) => s.list(req));
    ipcMain.handle("replay-open", (_e, req) => s.open(req));
    ipcMain.handle("replay-audio", (_e, req) => s.audio(req));
    ipcMain.handle("replay-skin", (_e, req) => s.skin(req));
    ipcMain.handle("replay-details", (_e, req) => s.details(req));
    ipcMain.handle("replay-earlier", (_e, req) => s.earlier(req));
    ipcMain.handle("replay-after-play", (_e, req) => s.setAfterPlay(req));
    ipcMain.handle("replay-pick-folder", () => s.pickFolder());
    ipcMain.handle("replay-reset-folder", () => s.resetFolder());
    // the recorder runs from the window's first load on (app/localProfileIpc.js), and so does listening to it
    let listening = false;
    hooks?.on?.("window-load", () => {
        if (listening) return;
        listening = true;
        localProfile?.onPlayEnded?.((play) => { void s.playEnded(play); });
    });
}
