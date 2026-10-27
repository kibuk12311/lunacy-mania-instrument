// osu! lazer's database reader: the dump of realm rows (src/lazer/realmDump.js) on plain look-alike objects, lazer's
// data folder (storage.ini), its file store, createLazerRealm (app/lazerRealm.js) over a fake worker (cache, one read at
// a time, timeout, errors, temp folders), one real round trip (a tiny client.realm with lazer's class names, read by
// app/lazerRealmWorker.js in a forked process) and the build config that ships realm's native module.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpLazer, hitsOf, lazerRate, modsOf, parseMods } from "../src/lazer/realmDump.js";
import { createLazerRealm, lazerDataDir, lazerFile } from "../app/lazerRealm.js";
import { lazerRows, md5, sha } from "./fixtures/lazerRealm.js";
import { t } from "../src/i18n/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const WORKER = path.join(root, "app", "lazerRealmWorker.js");
const FIXTURE = path.join(root, "tests", "fixtures", "lazerRealm.js");
const REALM_NODE = path.join(root, "node_modules", "realm", "prebuilds", "node", "realm.node");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// a promise's value, or "timed out" after ms (the timer never outlives it)
function within(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, "timed out"); })]).finally(() => clearTimeout(timer));
}
const HITS = { max: 800, n300: 300, n200: 20, n100: 5, n50: 2, miss: 3 };

// ---- the dump ----

test("rates: DT/NC at speed_change or 1.5, HT/DC at speed_change or 0.75, to 0.01; variable speeds and broken mods → null", () => {
    assert.equal(lazerRate("[{\"acronym\":\"DT\",\"settings\":{\"speed_change\":1.3}},{\"acronym\":\"CL\"}]"), 1.3);
    assert.equal(lazerRate("[{\"acronym\":\"DT\"}]"), 1.5);
    assert.equal(lazerRate("[{\"acronym\":\"NC\",\"settings\":{}}]"), 1.5);
    assert.equal(lazerRate("[{\"acronym\":\"HT\"}]"), 0.75);
    assert.equal(lazerRate("[{\"acronym\":\"DC\",\"settings\":{\"speed_change\":0.8}}]"), 0.8);
    assert.equal(lazerRate("[{\"acronym\":\"dt\",\"settings\":{\"speed_change\":1.2345}}]"), 1.23, "upper-cased, rounded");
    assert.equal(lazerRate("[{\"acronym\":\"DT\",\"settings\":{\"speed_change\":null}}]"), 1.5);
    assert.equal(lazerRate(""), 1);
    assert.equal(lazerRate("[{\"acronym\":\"HD\"},{\"acronym\":\"MR\"}]"), 1);
    assert.equal(lazerRate(["HT"]), 0.75, "a parsed list works too");
    for (const variable of ["WU", "WD", "AS"]) assert.equal(lazerRate(`[{"acronym":"${variable}"}]`), null, variable);
    assert.equal(lazerRate("[{\"acronym\":\"DT\"},{\"acronym\":\"AS\"}]"), null);
    assert.equal(lazerRate("[{\"acronym\":"), null, "broken JSON");
    assert.equal(lazerRate("{\"acronym\":\"DT\"}"), null, "not a list");
});

test("mods and hits: acronyms in upper case, judgements mapped to the app's hits, others left out", () => {
    assert.deepEqual(modsOf("[{\"acronym\":\"DT\",\"settings\":{\"speed_change\":1.3}},{\"acronym\":\"cl\"}]"), ["DT", "CL"]);
    assert.deepEqual(modsOf(""), []);
    assert.deepEqual(modsOf(null), []);
    assert.equal(modsOf("[1]"), null);
    assert.equal(modsOf("nope"), null);
    assert.deepEqual(parseMods("[{\"acronym\":\"DT\",\"settings\":{\"speed_change\":1.3}}]"), [{ acronym: "DT", settings: { speed_change: 1.3 } }]);
    assert.deepEqual(hitsOf("{\"perfect\":800,\"great\":300,\"good\":20,\"ok\":5,\"meh\":2,\"miss\":3,\"ignore_hit\":9}"), HITS);
    assert.deepEqual(hitsOf({ great: 10 }), { max: 0, n300: 10, n200: 0, n100: 0, n50: 0, miss: 0 });
    assert.deepEqual(hitsOf("{\"perfect\":-4,\"great\":\"x\"}"), { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 });
    assert.equal(hitsOf("{broken"), null);
    assert.equal(hitsOf("[1,2]"), null);
    assert.equal(hitsOf(""), null);
    assert.equal(hitsOf(null), null);
});

test("dump: visible mania maps of sets that stay, with their online ids and audio/background file hashes", () => {
    const rows = lazerRows();
    const { maps } = dumpLazer({ beatmaps: Object.values(rows.beatmaps), scores: [] });
    assert.deepEqual(maps.map((m) => m.version), ["4k", "7k", "solo"], "not the osu! map, the hidden one, or the set being deleted");
    assert.deepEqual(maps[0], {
        hash: sha("osu 4k"), md5: md5("osu 4k"), keys: 4, artist: "Fake Artist", title: "Fake Song", version: "4k",
        creator: "TestMapper", tags: "fake test", beatmapId: 1001, setId: 100,
        audio: sha("audio"), background: sha("bg"), // "bg\bg.jpg" in the .osu, "bg/BG.jpg" in the set
    });
    assert.equal(maps[1].keys, 7);
    assert.equal(maps[1].beatmapId, null, "OnlineID 0");
    assert.equal(maps[1].background, null, "no background named");
    assert.equal(maps[2].setId, null, "OnlineID -1");
    assert.equal(maps[2].audio, sha("audio 3"), "SONG.ogg is song.ogg");
});

test("dump: mania scores that stay; rate, hits, failed, and md5/keys from their map (null when it is gone, updated or converted)", () => {
    const rows = lazerRows();
    const { scores } = dumpLazer({ beatmaps: [], scores: Object.values(rows.scores) });
    assert.deepEqual(scores.map((s) => s.id.slice(-3)), ["201", "202", "203", "204", "205", "208"], "not the osu! play or the one being deleted");
    const [dt, gone, wind, ht, convert, updated] = scores;
    assert.deepEqual(dt, {
        id: "00000000-0000-4000-8000-000000000201", hash: sha("osu 4k"), md5: md5("osu 4k"), keys: 4, player: "TestPlayer",
        at: Date.UTC(2026, 0, 1, 12), mods: ["DT", "CL"], rate: 1.3, hits: HITS, maxCombo: 1234, accuracy: 0.9876, failed: false,
    });
    assert.deepEqual([gone.hash, gone.md5, gone.keys, gone.rate, gone.failed, gone.accuracy], [sha("osu removed"), null, null, 1.5, true, 0.71]);
    assert.deepEqual([wind.mods, wind.rate], [["WU"], null]);
    assert.deepEqual([ht.keys, ht.rate, ht.failed, ht.accuracy], [7, 0.75, false, 1]);
    assert.deepEqual([convert.md5, convert.keys, convert.rate, convert.mods], [md5("osu std"), null, 1, []]);
    assert.deepEqual([updated.hash, updated.md5, updated.keys], [sha("osu 4k before its update"), null, null], "the chart played is not the map's now");
});

test("dump: a broken row is skipped, a broken optional link reads as empty, a collection that breaks keeps what was read", () => {
    const rows = lazerRows();
    const good = rows.beatmaps["4k"];
    const throwing = (key, base) => Object.defineProperty({ ...base }, key, { get() { throw new Error("invalidated"); }, enumerable: true });
    const beatmaps = [
        null,
        42,
        throwing("Ruleset", good),
        { ...good, Hash: "not a hash" },
        { ...good, MD5Hash: undefined },
        { ...good, Difficulty: { CircleSize: Number.NaN } },
        { ...good, BeatmapSet: null },
        throwing("Metadata", { ...good, DifficultyName: "no metadata" }),
        good,
    ];
    const { maps } = dumpLazer({ beatmaps, scores: [] });
    assert.deepEqual(maps.map((m) => m.version), ["no metadata", "4k"]);
    assert.deepEqual([maps[0].title, maps[0].creator, maps[0].audio, maps[0].background], ["", "", null, null]);
    const ok = rows.scores.dt13;
    const scores = [
        { ...ok, Mods: "[{\"acronym\":" },
        { ...ok, Statistics: "{" },
        { ...ok, ID: "" },
        { ...ok, Date: "not a date" },
        { ...ok, BeatmapHash: null, BeatmapInfo: null },
        throwing("BeatmapInfo", ok),
        { ...ok, BeatmapHash: "", User: null },
    ];
    const plays = dumpLazer({ scores }).scores;
    assert.equal(plays.length, 2, "the play whose map link breaks still has its BeatmapHash");
    assert.deepEqual([plays[0].md5, plays[0].keys], [null, null]);
    assert.deepEqual([plays[1].hash, plays[1].player], [sha("osu 4k"), ""], "the hash from its map when the column is empty");
    function* breaking() {
        yield good;
        throw new Error("collection invalidated");
    }
    assert.equal(dumpLazer({ beatmaps: breaking() }).maps.length, 1);
    assert.deepEqual(dumpLazer({}), { maps: [], scores: [] });
    assert.deepEqual(dumpLazer({ beatmaps: null, scores: undefined }), { maps: [], scores: [] });
});

// ---- lazer's folders ----

// Just enough of fs/promises over a map of path → text (a folder exists when a file is in it).
function fakeFs(files = {}) {
    const map = new Map(Object.entries(files).map(([k, v]) => [path.normalize(k), v]));
    const removed = [];
    const missing = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return {
        files: map,
        removed,
        stat: async (p) => {
            const key = path.normalize(p);
            if (map.has(key)) return { size: String(map.get(key)).length, mtimeMs: 1 };
            throw missing(p);
        },
        readFile: async (p) => {
            const key = path.normalize(p);
            if (!map.has(key)) throw missing(p);
            const v = map.get(key);
            return Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
        },
        readdir: async (dir) => [...new Set([...map.keys()]
            .filter((k) => path.dirname(k) === path.normalize(dir) || k.startsWith(path.normalize(dir) + path.sep))
            .map((k) => path.relative(path.normalize(dir), k).split(path.sep)[0]))],
        rm: async (p) => {
            removed.push(path.normalize(p));
            for (const k of [...map.keys()]) if (k === path.normalize(p) || k.startsWith(path.normalize(p) + path.sep)) map.delete(k);
        },
    };
}

const APPDATA = "X:\\fake\\AppData\\Roaming";
const DEFAULT_DIR = path.join(APPDATA, "osu");
const MOVED = "Y:\\Games\\osu!lazer";

test("lazer's data folder: storage.ini's FullPath when it has a client.realm, else %APPDATA%\\osu, else none", async () => {
    const env = { APPDATA };
    const ini = `\uFEFF[General]\r\nFullPath = ${MOVED}\r\nOther = 1\r\n`;
    assert.equal(await lazerDataDir({ env, fs: fakeFs({ [path.join(DEFAULT_DIR, "storage.ini")]: ini, [path.join(MOVED, "client.realm")]: "r" }) }), MOVED);
    // moved, but the folder isn't there: lazer itself goes back to the default one
    assert.equal(await lazerDataDir({ env, fs: fakeFs({ [path.join(DEFAULT_DIR, "storage.ini")]: ini, [path.join(DEFAULT_DIR, "client.realm")]: "r" }) }), DEFAULT_DIR);
    assert.equal(await lazerDataDir({ env, fs: fakeFs({ [path.join(DEFAULT_DIR, "storage.ini")]: ini }) }), null);
    assert.equal(await lazerDataDir({ env, fs: fakeFs({ [path.join(DEFAULT_DIR, "client.realm")]: "r" }) }), DEFAULT_DIR, "no storage.ini");
    assert.equal(await lazerDataDir({ env, fs: fakeFs({ [path.join(DEFAULT_DIR, "storage.ini")]: "FullPath = relative\\path", [path.join(DEFAULT_DIR, "client.realm")]: "r" }) }), DEFAULT_DIR);
    assert.equal(await lazerDataDir({ env, fs: fakeFs({}) }), null, "no lazer");
    assert.equal(await lazerDataDir({ env: {}, fs: fakeFs({ [path.join(DEFAULT_DIR, "client.realm")]: "r" }) }), null, "no APPDATA");
});

test("lazer's file store: <data>\\files\\a\\ab\\abc… by sha256, nothing for anything else", () => {
    const h = sha("osu 4k");
    assert.equal(lazerFile(MOVED, h), path.join(MOVED, "files", h[0], h.slice(0, 2), h));
    assert.equal(lazerFile(MOVED, h.toUpperCase()), path.join(MOVED, "files", h[0], h.slice(0, 2), h));
    assert.equal(lazerFile(MOVED, "..\\..\\x"), null);
    assert.equal(lazerFile(MOVED, md5("x")), null);
    assert.equal(lazerFile(null, h), null);
});

// ---- createLazerRealm over a fake worker ----

const TMP = "X:\\fake\\Temp\\lunacy-mania-lazer";
const OWN = path.join(TMP, "realm-abc123");

// A fake utility process per spawn(); respond(message, child) runs for each message it is sent.
function fakeSpawn(respond) {
    const children = [];
    const spawn = () => {
        const child = new EventEmitter();
        child.sent = [];
        child.killed = false;
        child.postMessage = (message) => {
            child.sent.push(message);
            setImmediate(() => respond(message, child));
        };
        child.kill = () => {
            child.killed = true;
            setImmediate(() => child.emit("exit", null));
        };
        children.push(child);
        return child;
    };
    return { spawn, children };
}

// a worker that answers a read with dump (or with what reply gives), and exits on bye
const answering = (dump, extra = {}) => (message, child) => {
    if (message.realmPath) {
        child.emit("message", { dir: OWN });
        child.emit("message", { ok: true, ...dump, removed: true, ...extra });
    } else if (message.bye) child.emit("exit", 0);
};

function setup({ respond, files = {}, dir = MOVED, timeoutMs = 2_000 } = {}) {
    const fs = fakeFs({ [path.join(MOVED, "client.realm")]: "realm", ...files });
    const worker = fakeSpawn(respond ?? answering(dumpLazer({ beatmaps: Object.values(lazerRows().beatmaps), scores: Object.values(lazerRows().scores) })));
    const logs = [];
    const lazer = createLazerRealm({ dataDir: async () => dir, tmpDir: TMP, spawn: worker.spawn, fs, log: (line) => logs.push(line), timeoutMs });
    return { lazer, fs, worker, logs };
}

test("no lazer: not found, and no worker is started", async () => {
    const { lazer, worker } = setup({ dir: null });
    assert.deepEqual(await lazer.read(), { found: false, maps: [], scores: [] });
    assert.deepEqual(await lazer.status(), { found: false, dataDir: null });
    assert.equal(await lazer.text(sha("osu 4k")), null);
    assert.equal(await lazer.sourceOf(sha("osu 4k")), null);
    assert.equal(worker.children.length, 0);
    // a data folder whose client.realm went away
    const gone = setup();
    gone.fs.files.clear();
    assert.equal((await gone.lazer.read()).found, false);
    assert.equal(gone.worker.children.length, 0);
});

test("a read: one worker, told where the database and our temp folder are, then bye; cached while size and mtime stay", async () => {
    const { lazer, fs, worker, logs } = setup();
    const first = await lazer.read();
    assert.equal(first.found, true);
    assert.deepEqual(first.maps.map((m) => m.version), ["4k", "7k", "solo"]);
    assert.equal(first.scores.length, 6);
    assert.equal(worker.children.length, 1);
    assert.deepEqual(worker.children[0].sent, [{ realmPath: path.join(MOVED, "client.realm"), tmpDir: TMP }, { bye: true }]);
    assert.equal(await lazer.read(), first, "unchanged: the same answer, no new worker");
    assert.equal(worker.children.length, 1);
    fs.files.set(path.join(MOVED, "client.realm"), "realm, grown");
    assert.notEqual(await lazer.read(), first, "another size: read again");
    assert.equal(worker.children.length, 2);
    assert.deepEqual(await lazer.status(), { found: true, dataDir: MOVED });
    assert.ok(logs.some((l) => /3 maps, 6 scores in \d+ ms/.test(l)));
    assert.ok(!logs.join("\n").includes("Fake"), "no map names in the log");
    assert.deepEqual(fs.removed, [], "the worker removed its own folder");
});

test("one read at a time: a second caller gets the same promise", async () => {
    const { lazer, worker } = setup();
    const a = lazer.read();
    const b = lazer.read();
    assert.equal(a, b);
    await a;
    assert.equal(worker.children.length, 1);
});

test("a worker that doesn't answer in time is killed: a translated error, kept in status() until a read works", async () => {
    let silent = true;
    const { lazer, worker, fs } = setup({
        timeoutMs: 40,
        respond: (message, child) => {
            if (message.realmPath) child.emit("message", { dir: OWN });
            if (!silent) answering({ maps: [], scores: [] })(message, child);
        },
    });
    await assert.rejects(lazer.read(), { message: t("app.lazer.readTimeout") });
    assert.equal(worker.children[0].killed, true);
    assert.equal((await lazer.status()).error, t("app.lazer.readTimeout"));
    await sleep(20);
    assert.deepEqual(fs.removed, [OWN], "its folder (with the copy) removed after it exited");
    silent = false;
    assert.equal((await lazer.read()).found, true);
    assert.equal((await lazer.status()).error, undefined);
});

test("an unreadable database, or a worker that stops, rejects with a translated message; nothing is cached", async () => {
    const broken = setup({ respond: (message, child) => {
        if (message.realmPath) child.emit("message", { ok: false, message: "Invalid top array", removed: true });
        else if (message.bye) child.emit("exit", 0);
    } });
    await assert.rejects(broken.lazer.read(), { message: t("app.lazer.readFailed", { message: "Invalid top array" }) });
    await assert.rejects(broken.lazer.read());
    assert.equal(broken.worker.children.length, 2, "a failed read is not cached");
    const crashed = setup({ respond: (message, child) => { if (message.realmPath) child.emit("exit", 3); } });
    await assert.rejects(crashed.lazer.read(), { message: t("app.lazer.readerStopped", { code: 3 }) });
    const unspawnable = setup();
    const lazer = createLazerRealm({ dataDir: async () => MOVED, tmpDir: TMP, spawn: () => { throw new Error("no utility process"); }, fs: unspawnable.fs });
    await assert.rejects(lazer.read(), { message: t("app.lazer.readFailed", { message: "no utility process" }) });
});

test("temp folders: only the worker's own, directly in tmpDir; leftovers swept before a read", async () => {
    const files = {
        [path.join(TMP, "realm-old111", "client.realm")]: "copy",
        [path.join(TMP, "realm-old111", "client.realm.lock")]: "",
        [path.join(TMP, "keep.txt")]: "not ours",
        [path.join(TMP, "realm-toolong123", "x")]: "not a worker folder",
    };
    const outside = "X:\\elsewhere\\realm-abc123";
    let dir = path.join(TMP, "realm-new222");
    const { lazer, fs } = setup({ files, respond: (message, child) => {
        if (message.realmPath) {
            child.emit("message", { dir });
            child.emit("message", { ok: true, maps: [], scores: [], removed: false });
        } else if (message.bye) child.emit("exit", 0);
    } });
    await lazer.read();
    await sleep(10);
    assert.deepEqual(fs.removed, [path.join(TMP, "realm-old111"), path.join(TMP, "realm-new222")]);
    assert.ok(fs.files.has(path.join(TMP, "keep.txt")));
    assert.ok(fs.files.has(path.join(TMP, "realm-toolong123", "x")));
    fs.removed.length = 0;
    dir = outside;
    fs.files.set(path.join(MOVED, "client.realm"), "realm, changed");
    await lazer.read();
    await sleep(10);
    assert.deepEqual(fs.removed, [], "a folder the worker names outside tmpDir is never removed");
});

test("text() and sourceOf(): the .osu without its BOM, the map's files in lazer's store by the names its set gives them", async () => {
    const at = (label) => lazerFile(MOVED, sha(label));
    const { lazer } = setup({ files: {
        [at("osu 4k")]: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("osu file format v14\r\n", "utf8")]),
        [at("audio")]: "mp3",
        [at("osu 7k")]: "osu file format v14",
        [at("osu solo")]: "osu file format v14",
    } });
    assert.equal(await lazer.text(sha("osu 4k")), "osu file format v14\r\n");
    assert.equal(await lazer.text(sha("nowhere")), null);
    assert.equal(await lazer.text("../../client"), null);
    assert.deepEqual(await lazer.sourceOf(sha("osu 4k")), { path: at("osu 4k"), audioPath: at("audio"), backgroundPath: null }, "bg not in the store");
    assert.deepEqual(await lazer.sourceOf(sha("osu 7k").toUpperCase()), { path: at("osu 7k"), audioPath: at("audio"), backgroundPath: null });
    assert.deepEqual(await lazer.sourceOf(sha("osu solo")), { path: at("osu solo"), audioPath: null, backgroundPath: null }, "its audio isn't in the store");
    assert.equal(await lazer.sourceOf(sha("osu std")), null, "not a mania map of the dump");
    assert.equal(await lazer.sourceOf(sha("osu hidden")), null);
    assert.equal(await lazer.sourceOf("nope"), null);
});

// ---- one real round trip ----

// Runs a node script in a child process; resolves with its exit code, kills it after limitMs.
function runNode(file, args, { cwd, limitMs }) {
    return new Promise((resolve, reject) => {
        const child = fork(file, args, { cwd, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2_000); });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${path.basename(file)} took over ${limitMs} ms`));
        }, limitMs);
        child.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(code);
            else reject(new Error(`${path.basename(file)} exited ${code}: ${stderr}`));
        });
    });
}

// spawn() for createLazerRealm over child_process.fork, as utilityProcess.fork is used in main.js
function forkSpawn(file, cwd, children) {
    return () => {
        const child = fork(file, [], { cwd, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
        child.stderr.on("data", () => {});
        const exited = new Promise((resolve) => child.on("exit", resolve));
        children.push({ child, exited });
        return {
            postMessage: (message) => { if (child.connected) child.send(message, () => {}); },
            on: (event, fn) => child.on(event, fn),
            kill: () => child.kill(),
        };
    };
}

test("real round trip: a client.realm with lazer's classes, read from a copy by the worker in a forked process", {
    timeout: 90_000,
    skip: !existsSync(REALM_NODE) && "realm's native module isn't installed",
}, async () => {
    const base = await mkdtemp(path.join(tmpdir(), "lazer-realm-test-"));
    const children = [];
    try {
        const made = path.join(base, "made");
        const data = path.join(base, "data");
        const cwd = path.join(base, "cwd");
        await Promise.all([mkdir(made), mkdir(data), mkdir(cwd)]);
        await runNode(FIXTURE, [path.join(made, "client.realm")], { cwd: made, limitMs: 30_000 });
        // lazer's folder: only its client.realm (no .lock: nobody has it open) and a store with the 4K map's files
        await copyFile(path.join(made, "client.realm"), path.join(data, "client.realm"));
        const put = async (label, content) => {
            const file = lazerFile(data, sha(label));
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, content);
        };
        await put("osu 4k", "\uFEFFosu file format v14\r\n");
        await put("audio", "mp3");
        await put("bg", "jpg");
        const before = (await readdir(data)).sort();
        const tmp = path.join(base, "tmp");
        const lazer = createLazerRealm({ dataDir: async () => data, tmpDir: tmp, spawn: forkSpawn(WORKER, cwd, children), timeoutMs: 45_000 });
        const got = await lazer.read();
        const rows = lazerRows();
        const expected = dumpLazer({ beatmaps: Object.values(rows.beatmaps), scores: Object.values(rows.scores) });
        assert.equal(got.found, true);
        assert.deepEqual(got.maps, expected.maps, "realm's objects dump as their plain look-alikes do");
        assert.deepEqual(got.scores, expected.scores);
        assert.equal(got.maps.length, 3);
        assert.equal(got.scores[0].id, "00000000-0000-4000-8000-000000000201", "a realm uuid reads as its dashed hex");
        assert.deepEqual(await lazer.sourceOf(sha("osu 4k")), {
            path: lazerFile(data, sha("osu 4k")), audioPath: lazerFile(data, sha("audio")), backgroundPath: lazerFile(data, sha("bg")),
        });
        assert.equal(await lazer.text(sha("osu 4k")), "osu file format v14\r\n");
        assert.equal(await lazer.read(), got, "cached");
        assert.equal(children.length, 1);
        // the worker said bye and went; lazer's folder has nothing new, our temp folder nothing left
        assert.equal(await within(children[0].exited, 10_000), 0, "it exited by itself");
        assert.deepEqual((await readdir(data)).sort(), before, "nothing written next to lazer's client.realm");
        let left = [];
        for (let i = 0; i < 40; i += 1) {
            left = (await readdir(tmp).catch(() => [])).filter((name) => name.startsWith("realm-"));
            if (!left.length) break;
            await sleep(50);
        }
        assert.deepEqual(left, [], "the copy's folder is removed");
        assert.deepEqual(await readdir(cwd), [], "nothing written into the working folder");
    } finally {
        for (const { child } of children) if (child.exitCode == null) child.kill();
        await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

// ---- the build ----

// The globs of the build config as a RegExp: **/, **, *, {a,b} (all these patterns use).
function globRegExp(glob) {
    let out = "";
    for (let i = 0; i < glob.length; i += 1) {
        const c = glob[i];
        if (glob.startsWith("**/", i)) { out += "(?:.*/)?"; i += 2; }
        else if (glob.startsWith("**", i)) { out += ".*"; i += 1; }
        else if (c === "*") out += "[^/]*";
        else if (c === "{") out += "(?:";
        else if (c === "}") out += ")";
        else if (c === ",") out += "|";
        else out += c.replace(/[.+?^$()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${out}$`);
}

test("build config: realm's runtime is packed, its native module unpacked from the asar, the mobile and source builds left out", () => {
    const b = pkg.build;
    assert.equal(pkg.dependencies.realm, "20.2.0", "pinned exactly");
    const dropped = b.files.filter((f) => f.startsWith("!")).map((f) => globRegExp(f.slice(1)));
    const isDropped = (file) => dropped.some((re) => re.test(file));
    // what require("realm") and opening a realm load (dist/platform/node/index.js and on), and the package itself
    for (const kept of ["package.json", "dist/Realm.js", "dist/platform/node/index.js", "dist/platform/node/binding.js", "dist/platform/file-system.js",
        "dist/binding/wrapper.generated.js", "dist/schema/normalize.js", "prebuilds/node/realm.node"]) {
        assert.equal(isDropped(`node_modules/realm/${kept}`), false, kept);
    }
    for (const gone of ["prebuilds/android/x86_64/librealm.so", "prebuilds/apple/realm-core.xcframework/Info.plist", "binding/platform.hpp",
        "bindgen/src/realm_js_node_helpers.h", "binding.gyp", "RealmJS.podspec", "dist/Realm.js.map", "dist/Realm.d.ts",
        "dist/public-types/Realm.d.ts", "dist/platform/react-native/fs.js", "dist/scripts/submit-analytics.js", "scripts/submit-analytics.js"]) {
        assert.equal(isDropped(`node_modules/realm/${gone}`), true, gone);
    }
    assert.ok(b.asarUnpack.some((glob) => globRegExp(glob).test("node_modules/realm/prebuilds/node/realm.node")), "realm.node outside the asar");
    assert.equal(b.npmRebuild, false, "realm's N-API prebuild is used as it is: no download or source build while packing");
});
