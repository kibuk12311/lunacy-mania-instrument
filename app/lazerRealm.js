// osu! lazer's own database, read on demand: where lazer keeps its data (lazerDataDir), a file of its hashed store
// (lazerFile), and the mania maps and scores in client.realm (createLazerRealm). The database is read in a utility
// process (app/lazerRealmWorker.js) from a copy in a temp folder of ours; nothing is ever written into lazer's folder.
import fsPromises from "node:fs/promises";
import path from "node:path";
import { t } from "../src/i18n/i18n.js";

export const REALM_FILE = "client.realm";
const SHA256 = /^[0-9a-f]{64}$/;
const WORKER_DIR = /^realm-[A-Za-z0-9]{6}$/; // the worker's own folders (mkdtemp "realm-XXXXXX")
const EXIT_GRACE_MS = 3_000; // a worker that hasn't exited this long after its answer is killed
const NOT_FOUND = Object.freeze({ found: false, maps: Object.freeze([]), scores: Object.freeze([]) });

const messageOf = (error) => String(error?.message ?? error);

// The data folder: the "FullPath = …" of %APPDATA%\osu\storage.ini when the user moved it, else %APPDATA%\osu; only a
// folder with a client.realm (lazer, too, goes back to its default folder when the moved one is gone). → path | null
export async function lazerDataDir({ env = process.env, fs = fsPromises } = {}) {
    const appData = env?.APPDATA;
    if (!appData) return null;
    const base = path.join(appData, "osu");
    const hasRealm = (dir) => fs.stat(path.join(dir, REALM_FILE)).then(() => true, () => false);
    const ini = await fs.readFile(path.join(base, "storage.ini"), "utf8").catch(() => "");
    const moved = /^\s*FullPath\s*=\s*(.+?)\s*$/im.exec(String(ini).replace(/^﻿/, ""))?.[1];
    if (moved && path.isAbsolute(moved) && (await hasRealm(moved))) return path.normalize(moved);
    return (await hasRealm(base)) ? base : null;
}

// A file of lazer's store by its sha256 (lower case hex): <data>\files\a\ab\abcdef…; null for anything else.
export function lazerFile(dataDir, hash) {
    const h = String(hash ?? "").toLowerCase();
    if (!dataDir || !SHA256.test(h)) return null;
    return path.join(dataDir, "files", h[0], h.slice(0, 2), h);
}

// dataDir(): lazer's data folder or null (lazerDataDir); tmpDir: a folder of ours the worker copies the database into;
// spawn(): a utilityProcess-like child (postMessage, on("message" | "exit"), kill) running app/lazerRealmWorker.js.
// Nothing is read until asked. read() → { found, maps, scores } (src/lazer/realmDump.js), the same answer while
// client.realm keeps its size and mtime; one read at a time (a second caller gets the same promise); an unreadable
// database rejects with a translated message.
export function createLazerRealm({ dataDir, tmpDir, spawn, fs = fsPromises, log = () => {}, now = Date.now, timeoutMs = 60_000 }) {
    let cache = null; // { key, dir, value, byHash }
    let reading = null; // the read in progress
    let lastError = null; // why the last read failed, until one works

    const failure = (message) => new Error(t("app.lazer.readFailed", { message }));

    // Only our own worker folders, directly in tmpDir: a crash or a kill can leave one, with a copy of the database.
    const ownFolder = (dir) => typeof dir === "string"
        && path.dirname(path.resolve(dir)) === path.resolve(tmpDir) && WORKER_DIR.test(path.basename(dir));

    async function removeFolder(dir) {
        if (!ownFolder(dir)) return;
        try {
            await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
            log(`lazer realm: a temp folder stayed (${error?.code ?? "error"})`);
        }
    }

    // Before a read no worker of ours runs (one read at a time, one app), so any folder of theirs is left over.
    async function removeLeftovers() {
        const names = await fs.readdir(tmpDir).catch(() => []);
        await Promise.all(names.filter((name) => WORKER_DIR.test(String(name))).map((name) => removeFolder(path.join(tmpDir, String(name)))));
    }

    // One worker for one read of realmPath → { maps, scores }; on a timeout it is killed. Its folder is removed after it
    // exits when it couldn't remove it itself.
    function runWorker(realmPath) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn();
            } catch (error) {
                reject(failure(messageOf(error)));
                return;
            }
            let settled = false;
            let ownDir = null;
            let removed = false;
            let graceTimer = null;
            const kill = () => {
                try {
                    child.kill();
                } catch {
                    // already gone
                }
            };
            const settle = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(value);
            };
            const timer = setTimeout(() => {
                settle(new Error(t("app.lazer.readTimeout")));
                kill();
            }, timeoutMs);
            child.on("message", (msg) => {
                if (!msg || typeof msg !== "object") return;
                if (!("ok" in msg)) {
                    if (typeof msg.dir === "string") ownDir = msg.dir;
                    return;
                }
                removed = msg.removed === true;
                if (msg.ok === true) settle(null, { maps: Array.isArray(msg.maps) ? msg.maps : [], scores: Array.isArray(msg.scores) ? msg.scores : [] });
                else settle(failure(messageOf(msg.message)));
                try {
                    child.postMessage({ bye: true });
                } catch {
                    // it is exiting already
                }
                clearTimeout(graceTimer);
                graceTimer = setTimeout(kill, EXIT_GRACE_MS);
            });
            child.on("exit", (code) => {
                clearTimeout(timer);
                clearTimeout(graceTimer);
                settle(new Error(t("app.lazer.readerStopped", { code: code ?? "?" })));
                if (ownDir && !removed) void removeFolder(ownDir);
            });
            try {
                child.postMessage({ realmPath, tmpDir });
            } catch (error) {
                settle(failure(messageOf(error)));
                kill();
            }
        });
    }

    async function load() {
        const dir = await dataDir();
        const file = dir ? path.join(dir, REALM_FILE) : null;
        const st = file ? await fs.stat(file).catch(() => null) : null;
        if (!st) return NOT_FOUND;
        const key = `${dir}\n${st.size}\n${st.mtimeMs}`;
        if (cache?.key === key) return cache.value;
        const started = now();
        let dump;
        try {
            await removeLeftovers();
            dump = await runWorker(file);
        } catch (error) {
            lastError = messageOf(error);
            log(`lazer realm: read failed after ${now() - started} ms: ${lastError}`);
            throw error;
        }
        lastError = null;
        const value = { found: true, maps: dump.maps, scores: dump.scores };
        cache = { key, dir, value, byHash: null };
        log(`lazer realm: ${dump.maps.length} maps, ${dump.scores.length} scores in ${now() - started} ms`);
        return value;
    }

    function read() {
        reading ??= load().finally(() => {
            reading = null;
        });
        return reading;
    }

    // → { found, dataDir, error? }: whether lazer's database is there, and why the last read failed if it did
    async function status() {
        try {
            const dir = (await dataDir()) ?? null;
            return { found: Boolean(dir), dataDir: dir, ...(lastError ? { error: lastError } : {}) };
        } catch (error) {
            return { found: false, dataDir: null, error: messageOf(error) };
        }
    }

    // The .osu text of a map by its sha256 (utf8, without a BOM); null when lazer has no such file.
    async function text(hash) {
        const file = lazerFile(await dataDir(), hash);
        if (!file) return null;
        const data = await fs.readFile(file).catch(() => null);
        if (data == null) return null;
        return (Buffer.isBuffer(data) ? data.toString("utf8") : String(data)).replace(/^﻿/, "");
    }

    // The map's .osu, audio and background in lazer's store, the `source` app/lazerMaps.js copyLazerMap takes:
    // { path, audioPath, backgroundPath } (a missing audio or background is null); null for a map lazer doesn't have.
    // It reads the database (read()) for the map's file names, so it rejects as read() does.
    async function sourceOf(hash) {
        const h = String(hash ?? "").toLowerCase();
        if (!SHA256.test(h)) return null;
        const value = await read();
        const entry = cache?.value === value ? cache : null;
        if (!value.found || !entry) return null;
        entry.byHash ??= new Map(value.maps.map((m) => [m.hash, m]));
        const map = entry.byHash.get(h);
        const there = async (fileHash) => {
            const file = lazerFile(entry.dir, fileHash);
            return file && (await fs.stat(file).then(() => true, () => false)) ? file : null;
        };
        const osuPath = map ? await there(h) : null;
        if (!osuPath) return null;
        return { path: osuPath, audioPath: await there(map.audio), backgroundPath: await there(map.background) };
    }

    return { status, read, text, sourceOf };
}
