// The Replay tab's main side over a fixture osu! folder made here only (a made-up player): the folder's order of
// precedence, the recent list, opening a replay, its map by md5, audio, the skin set in osu! read as it is, the details
// from the shared analysis; and nothing under the osu! folder ever changes.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, rename, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReplayService, registerReplayIpc, readOsuConfig, audioFileOf, overallDifficulty, tosuFolders, ENDED_WAIT_MS, NEXT_PLAY_GRACE_MS, LIST_READ_MAX } from "../../app/replayIpc.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { makeOsr, honestPresses, gluedPresses, rollNotes, chartText } from "../fixtures/makeOsr.js";
import { encodePng } from "../../src/skin/png.js";
import { MOD_BITS } from "../../src/localProfile/scoresDb.js";
import { BINS, BREAK } from "../../src/analysis/timeline.js";
import { HINTS } from "../../src/replay/hints.js";

const md5 = (text) => createHash("md5").update(text).digest("hex");
const png = (w = 4, h = 4) => encodePng(w, h, new Uint8Array(w * h * 4).fill(200));

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "lm-replay-"));
    const game = path.join(root, "osu");
    const notes = rollNotes({ count: 200, stepMs: 45 });
    const text = chartText(notes, { title: "Fixture Roll" });
    const map = path.join(game, "Songs", "1 Test - Fixture Roll");
    await mkdir(map, { recursive: true });
    await writeFile(path.join(map, "Test - Fixture Roll (TestPlayer) [Rolls].osu"), text);
    await writeFile(path.join(map, "audio.wav"), Buffer.from("RIFFfake"));
    await mkdir(path.join(game, "Replays"), { recursive: true });
    await mkdir(path.join(game, "Data", "r"), { recursive: true });
    const hash = md5(text);
    const honest = makeOsr({ md5: hash, presses: honestPresses(notes, { sdMs: 8 }), at: Date.UTC(2026, 9, 2) });
    const glued = makeOsr({ md5: hash, presses: gluedPresses(notes), at: Date.UTC(2026, 9, 3), score: 777 });
    const unknown = makeOsr({ md5: "f".repeat(32), presses: [], at: Date.UTC(2026, 9, 1) });
    const standard = makeOsr({ md5: hash, mode: 0, at: Date.UTC(2026, 9, 4) });
    const random = makeOsr({ md5: hash, presses: honestPresses(notes), mods: MOD_BITS.RD });
    await writeFile(path.join(game, "Replays", "honest.osr"), honest);
    await writeFile(path.join(game, "Data", "r", `${hash}-1.osr`), honest); // the same play kept twice
    await writeFile(path.join(game, "Replays", "glued.osr"), glued);
    await writeFile(path.join(game, "Replays", "unknown.osr"), unknown);
    await writeFile(path.join(game, "Replays", "standard.osr"), standard);
    await writeFile(path.join(game, "Replays", "random.osr"), random);
    await writeFile(path.join(game, "Replays", "broken.osr"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(game, "Replays", "note.txt"), "not a replay");
    await utimes(path.join(game, "Replays", "honest.osr"), new Date(Date.UTC(2026, 9, 2)), new Date(Date.UTC(2026, 9, 2)));
    const skin = path.join(game, "Skins", "Fixture Skin");
    await mkdir(path.join(skin, "Notes"), { recursive: true });
    await writeFile(path.join(skin, "skin.ini"), "[General]\r\nName: Fixture Skin\r\n\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 420\r\nColumnWidth: 50,50,50,50\r\nNoteImage0: Notes/n1\r\n", "utf8");
    await writeFile(path.join(skin, "Notes", "n1@2x.png"), png(8, 8));
    await writeFile(path.join(skin, "mania-key1.png"), png());
    await mkdir(path.join(game, "Skins", "Other"), { recursive: true });
    await writeFile(path.join(game, "osu!.TestPlayer.cfg"), "BeatmapDirectory = Songs\r\nSkin = Fixture Skin\r\nUsername = TestPlayer\r\n");
    await writeFile(path.join(game, "osu!.cfg"), "CredentialEndpoint =\r\n");
    const userData = path.join(root, "user-data");
    const opts = {
        userData, env: {}, songsIndex: createSongsMd5Index({ indexFile: path.join(userData, "songs.json") }),
        tosu: async () => ({ game, songs: null, skin: null }),
    };
    return { root, game, notes, text, hash, userData, opts, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// every file under dir: { path: [size, mtime, sha1] }
async function snapshot(dir, sub = "") {
    const out = {};
    for (const e of await readdir(path.join(dir, sub), { withFileTypes: true })) {
        const rel = path.join(sub, e.name);
        if (e.isDirectory()) Object.assign(out, await snapshot(dir, rel));
        else {
            const full = path.join(dir, rel);
            const s = await stat(full);
            out[rel] = [s.size, s.mtimeMs, createHash("sha1").update(await readFile(full)).digest("hex")];
        }
    }
    return out;
}

test("the folder: picked, else tosu, else %LOCALAPPDATA%\\osu!, else none", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService(f.opts);
    assert.deepEqual(await service.status(), { ok: true, folder: f.game, source: "tosu", picked: null, afterPlay: true });
    const quiet = { ...f.opts, tosu: async () => ({ game: null, songs: null, skin: null }) };
    const none = createReplayService({ ...quiet, userData: path.join(f.root, "u2") });
    assert.equal((await none.status()).folder, null);
    const auto = path.join(f.root, "local", "osu!");
    await mkdir(path.join(auto, "Replays"), { recursive: true });
    const byEnv = createReplayService({ ...quiet, userData: path.join(f.root, "u3"), env: { LOCALAPPDATA: path.join(f.root, "local") } });
    assert.equal((await byEnv.status()).source, "default");
    assert.equal((await byEnv.status()).folder, auto);
    const picking = createReplayService({
        ...quiet, userData: path.join(f.root, "u4"), dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [f.game] }) },
    });
    assert.equal((await picking.pickFolder()).source, "picked");
    assert.equal((await picking.status()).picked, f.game);
    assert.equal((await picking.resetFolder()).source, null);
});

const closed = async () => ({ game: null, songs: null, skin: null });
const jsonOf = (userData) => path.join(userData, "replay.json");
async function saved(userData, folder, afterPlay = true) {
    await mkdir(userData, { recursive: true });
    await writeFile(jsonOf(userData), JSON.stringify({ folder, afterPlay }));
}
const dialogGiving = (where) => ({ showOpenDialog: async () => ({ canceled: false, filePaths: [where] }) });
// a folder laid out like a real install: osu!.exe with the game's own folders
async function installed(game) {
    await mkdir(path.join(game, "Songs"), { recursive: true });
    await mkdir(path.join(game, "Skins", "Their Skin"), { recursive: true });
    await writeFile(path.join(game, "osu!.exe"), "exe");
    return game;
}

test("the order: picked, tosu, the profile's, %LOCALAPPDATA%, the .osz association, each looked at only after the one before", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const game = {};
    for (const name of ["picked", "tosu", "profile", "association"]) game[name] = await installed(path.join(f.root, "games", name));
    const local = path.join(f.root, "local");
    game.default = await installed(path.join(local, "osu!"));
    const asked = [];
    const answer = async (has) => {
        const userData = path.join(f.root, `u-${has.join("-")}`);
        if (has.includes("picked")) await saved(userData, game.picked);
        const service = createReplayService({
            ...f.opts, userData, env: has.includes("default") ? { LOCALAPPDATA: local } : {},
            tosu: async () => ({ game: has.includes("tosu") ? game.tosu : null, songs: null, skin: null }),
            profileFolder: async () => { asked.push("profile"); return has.includes("profile") ? game.profile : null; },
            association: async () => { asked.push("association"); return has.includes("association") ? game.association : null; },
        });
        const { folder, source, picked } = await service.status();
        return { folder, source, picked };
    };
    const all = ["picked", "tosu", "profile", "default", "association"];
    assert.deepEqual(await answer(all), { folder: game.picked, source: "picked", picked: game.picked });
    assert.deepEqual(await answer(all.slice(1)), { folder: game.tosu, source: "tosu", picked: null });
    assert.deepEqual(asked, []);
    assert.deepEqual(await answer(all.slice(2)), { folder: game.profile, source: "profile", picked: null });
    assert.deepEqual(asked, ["profile"]);
    asked.length = 0;
    assert.deepEqual(await answer(all.slice(3)), { folder: game.default, source: "default", picked: null });
    assert.deepEqual(asked, ["profile"], "the association is left alone while something else knows");
    assert.deepEqual(await answer(all.slice(4)), { folder: game.association, source: "association", picked: null });
    assert.deepEqual(await answer([]), { folder: null, source: null, picked: null });
});

test("a non-default install is found with osu! closed: the lists fill from the profile's folder or the association", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    for (const [i, over] of [{ profileFolder: async () => f.game }, { association: async () => f.game }].entries()) {
        const service = createReplayService({ ...f.opts, userData: path.join(f.root, `u${i}`), tosu: closed, ...over });
        assert.equal((await service.list({ titles: false })).items.length, 4);
        assert.deepEqual((await service.skin({})).skins, ["Fixture Skin", "Other"]);
    }
});

test("the profile's folder and the association go through the same check: gone, or lazer's, they count for nothing", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const lazer = path.join(f.root, "osulazer", "current");
    await mkdir(lazer, { recursive: true });
    await writeFile(path.join(lazer, "osu!.exe"), "exe");
    for (const [i, nowhere] of [lazer, path.join(f.root, "gone")].entries()) {
        const service = createReplayService({ ...f.opts, userData: path.join(f.root, `u${i}`), tosu: closed, profileFolder: async () => nowhere, association: async () => nowhere });
        assert.equal((await service.status()).folder, null);
    }
    const broken = createReplayService({ ...f.opts, userData: path.join(f.root, "u-broken"), tosu: closed, profileFolder: async () => { throw new Error("no profile"); }, association: async () => f.game });
    assert.equal((await broken.status()).source, "association", "a profile that cannot answer does not stop the search");
    const inside = createReplayService({ ...f.opts, userData: path.join(f.root, "u-inside"), tosu: closed, profileFolder: async () => path.join(f.game, "Songs") });
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    assert.equal((await inside.status()).folder, f.game);
});

test("an empty %LOCALAPPDATA%\\osu! does not hide the install Windows knows", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const local = path.join(f.root, "local");
    await mkdir(path.join(local, "osu!"), { recursive: true });
    const service = createReplayService({ ...f.opts, tosu: closed, env: { LOCALAPPDATA: local }, association: async () => f.game });
    assert.deepEqual([(await service.status()).source, (await service.status()).folder], ["association", f.game]);
});

test("a saved Songs heals by itself, with tosu or without: read as the game folder, replay.json left as it was", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    const songs = path.join(f.game, "Songs");
    for (const [i, tosu] of [async () => ({ game: f.game, songs, skin: null }), closed].entries()) {
        const userData = path.join(f.root, `u${i}`);
        await saved(userData, songs);
        const before = await readFile(jsonOf(userData));
        const service = createReplayService({ ...f.opts, userData, tosu });
        const status = await service.status();
        assert.deepEqual([status.folder, status.source, status.picked], [f.game, "picked", f.game]);
        assert.equal((await service.list({ titles: false })).items.length, 4);
        const skin = await service.skin({});
        assert.deepEqual(skin.skins, ["Fixture Skin", "Other"]);
        assert.equal(skin.chosen, "Fixture Skin");
        assert.deepEqual(await readFile(jsonOf(userData)), before);
    }
});

test("a saved folder that leads nowhere falls through to the next source, kept in case its drive comes back", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const wrong = path.join(f.root, "wrong");
    await mkdir(wrong, { recursive: true });
    for (const [i, nowhere] of [path.join(f.root, "gone", "osu!"), wrong].entries()) {
        const userData = path.join(f.root, `u${i}`);
        await saved(userData, nowhere);
        const before = await readFile(jsonOf(userData));
        const live = createReplayService({ ...f.opts, userData });
        const status = await live.status();
        assert.deepEqual([status.folder, status.source, status.picked], [f.game, "tosu", null]);
        assert.equal((await live.list({ titles: false })).items.length, 4);
        const quiet = createReplayService({ ...f.opts, userData, tosu: closed });
        assert.deepEqual((await quiet.status()).folder, null);
        assert.deepEqual(await readFile(jsonOf(userData)), before);
    }
});

test("a pick anywhere inside the game lands on the game folder, and that is what is saved", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    const places = [
        f.game, path.join(f.game, "Songs"), path.join(f.game, "Skins"), path.join(f.game, "Replays"), path.join(f.game, "Data", "r"),
        path.join(f.game, "Songs", "1 Test - Fixture Roll"), path.join(f.game, "Skins", "Fixture Skin"), path.join(f.game, "Skins", "Fixture Skin", "Notes"),
    ];
    for (const [i, where] of places.entries()) {
        const userData = path.join(f.root, `u${i}`);
        const service = createReplayService({ ...f.opts, userData, tosu: closed, dialog: dialogGiving(where) });
        const r = await service.pickFolder();
        assert.deepEqual([r.ok, r.folder, r.source, r.picked], [true, f.game, "picked", f.game], where);
        assert.equal(JSON.parse(await readFile(jsonOf(userData), "utf8")).folder, f.game);
    }
});

test("a copy without the exe is taken as it is when it holds Replays, Data\\r or Skins; a Songs of its own is not enough", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    for (const [i, part] of [["Replays"], ["Data", "r"], ["Skins"]].entries()) {
        const copy = path.join(f.root, `copy${i}`);
        await mkdir(path.join(copy, ...part), { recursive: true });
        const service = createReplayService({ ...f.opts, userData: path.join(f.root, `u${i}`), tosu: closed, dialog: dialogGiving(copy) });
        assert.equal((await service.pickFolder()).folder, copy);
    }
    const songsOnly = path.join(f.root, "copy-songs");
    await mkdir(path.join(songsOnly, "Songs"), { recursive: true });
    const refused = createReplayService({ ...f.opts, userData: path.join(f.root, "u-songs"), tosu: closed, dialog: dialogGiving(songsOnly) });
    assert.equal((await refused.pickFolder()).ok, false);
});

test("the walk up goes four parents, no further", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    const four = path.join(f.game, "Songs", "a", "b", "c");
    const five = path.join(four, "d");
    await mkdir(five, { recursive: true });
    const reach = createReplayService({ ...f.opts, userData: path.join(f.root, "u4"), tosu: closed, dialog: dialogGiving(four) });
    assert.equal((await reach.pickFolder()).folder, f.game);
    const beyond = createReplayService({ ...f.opts, userData: path.join(f.root, "u5"), tosu: closed, dialog: dialogGiving(five) });
    assert.equal((await beyond.pickFolder()).ok, false);
});

test("a folder that leads to no osu! is refused with a message: nothing saved, nothing told, what was saved stays", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    const lazer = path.join(f.root, "osulazer", "current");
    await mkdir(lazer, { recursive: true });
    await writeFile(path.join(lazer, "osu!.exe"), "exe");
    const empty = path.join(f.root, "empty");
    await mkdir(empty, { recursive: true });
    for (const [i, where] of [lazer, empty, path.join(f.root, "gone")].entries()) {
        const fresh = path.join(f.root, `fresh${i}`);
        const sent = [];
        const first = createReplayService({ ...f.opts, userData: fresh, tosu: closed, dialog: dialogGiving(where), send: (...a) => sent.push(a) });
        const r = await first.pickFolder();
        assert.equal(r.ok, false);
        assert.equal(r.cancelled, undefined);
        assert.match(r.message, /osu!/);
        assert.equal((await stat(jsonOf(fresh)).catch(() => null)), null, "no replay.json appears");
        assert.deepEqual(sent, []);

        const kept = path.join(f.root, `kept${i}`);
        await saved(kept, f.game);
        const before = await readFile(jsonOf(kept));
        const second = createReplayService({ ...f.opts, userData: kept, tosu: closed, dialog: dialogGiving(where) });
        assert.equal((await second.pickFolder()).ok, false);
        assert.deepEqual(await readFile(jsonOf(kept)), before);
        assert.equal((await second.status()).folder, f.game);
    }
});

test("a pick or a reset tells the window, a refused or cancelled one does not", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    const sent = [];
    let dialog = dialogGiving(path.join(f.game, "Songs"));
    const service = createReplayService({
        ...f.opts, tosu: closed, send: (channel, payload) => sent.push([channel, payload]), dialog: { showOpenDialog: (...a) => dialog.showOpenDialog(...a) },
    });
    const picked = await service.pickFolder();
    assert.deepEqual(sent, [["replay-folder", picked]]);
    assert.deepEqual([picked.ok, picked.folder, picked.source, picked.picked], [true, f.game, "picked", f.game]);
    sent.length = 0;
    dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
    assert.deepEqual(await service.pickFolder(), { ok: false, cancelled: true });
    assert.deepEqual(sent, []);
    const reset = await service.resetFolder();
    assert.deepEqual(sent, [["replay-folder", reset]]);
    assert.deepEqual([reset.ok, reset.folder, reset.picked], [true, null, null]);
});

test("a pick or a reset changes the folder and nothing else in replay.json: the after-a-play switch stays off", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    await saved(f.userData, null, false);
    const service = createReplayService({ ...f.opts, tosu: closed, dialog: dialogGiving(f.game) });
    assert.equal((await service.pickFolder()).ok, true);
    assert.equal((await service.status()).afterPlay, false);
    assert.deepEqual(JSON.parse(await readFile(jsonOf(f.userData), "utf8")), { folder: f.game, afterPlay: false });
    await service.resetFolder();
    assert.equal((await service.status()).afterPlay, false);
    assert.deepEqual(JSON.parse(await readFile(jsonOf(f.userData), "utf8")), { folder: null, afterPlay: false });
});

test("a pick looks the Songs folder over again, even the same folder as before", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    const scans = [];
    const service = createReplayService({
        ...f.opts, tosu: closed, dialog: dialogGiving(f.game), association: async () => f.game,
        songsIndex: { scan: async (dir) => { scans.push(dir); return { charts: new Map() }; } },
    });
    const songs = path.join(f.game, "Songs");
    await service.list({ titles: true });
    await service.list({ titles: true });
    assert.deepEqual(scans, [songs], "fresh: not looked over twice");
    await service.pickFolder();
    await service.list({ titles: true });
    assert.deepEqual(scans, [songs, songs]);
});

test("a scan of the old folder still under way does not answer for the one just picked", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const other = await installed(path.join(f.root, "other"));
    await mkdir(path.join(other, "Replays"), { recursive: true });
    await writeFile(path.join(other, "Replays", "a.osr"), makeOsr({ md5: f.hash, presses: honestPresses(f.notes) }));
    let finishOld = null;
    const oldScan = new Promise((resolve) => { finishOld = () => resolve({ charts: new Map() }); });
    const scans = [];
    const service = createReplayService({
        ...f.opts, tosu: closed, dialog: dialogGiving(path.join(other, "Songs")),
        association: async () => f.game,
        songsIndex: {
            scan: async (dir) => {
                scans.push(dir);
                return dir === path.join(other, "Songs") ? { charts: new Map([[f.hash, { artist: "Test", title: "From Other", version: "One", path: "x.osu" }]]) } : oldScan;
            },
        },
    });
    const first = service.list({ titles: true });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.deepEqual(scans, [path.join(f.game, "Songs")]);
    await service.pickFolder();
    const listed = await service.list({ titles: true });
    assert.deepEqual(listed.items.map((i) => i.title), ["From Other"]);
    finishOld();
    await first;
});

// a Songs index whose scans run only as the test says: scans[i] is { dir, progress(done, total), finish() }
function heldScans() {
    const scans = [];
    const songsIndex = {
        scan: (dir, { onProgress }) => new Promise((resolve) => {
            scans.push({ dir, progress: (done, total) => onProgress({ done, total }), finish: () => resolve({ charts: new Map() }) });
        }),
    };
    return { scans, songsIndex };
}
const firstTurn = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test("a scan of the old folder ending leaves the new folder's in its place, and after the change it says nothing", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const other = await installed(path.join(f.root, "other"));
    const { scans, songsIndex } = heldScans();
    const sent = [];
    const service = createReplayService({
        ...f.opts, tosu: closed, association: async () => f.game, dialog: dialogGiving(path.join(other, "Songs")), songsIndex,
        send: (channel, payload) => { if (channel === "replay-progress") sent.push(payload); },
    });
    const first = service.list({ titles: true });
    await firstTurn();
    scans[0].progress(1, 10);
    assert.deepEqual(sent, [{ done: 1, total: 10 }]);
    await service.pickFolder();
    scans[0].progress(2, 10);
    assert.deepEqual(sent, [{ done: 1, total: 10 }], "the old folder's scan no longer speaks");

    const second = service.list({ titles: true });
    await firstTurn();
    assert.deepEqual(scans.map((s) => s.dir), [path.join(f.game, "Songs"), path.join(other, "Songs")]);
    scans[1].progress(3, 20);
    assert.deepEqual(sent.at(-1), { done: 3, total: 20 });
    scans[0].finish();
    await first;
    const third = service.list({ titles: true });
    await firstTurn();
    assert.equal(scans.length, 2, "the new folder's scan is still the one under way: no second one");
    scans[1].finish();
    await Promise.all([second, third]);
});

test("a reset to nothing mid-scan: the scan goes on unheard", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.exe"), "exe");
    await saved(f.userData, f.game);
    const { scans, songsIndex } = heldScans();
    const sent = [];
    const service = createReplayService({ ...f.opts, tosu: closed, songsIndex, send: (channel, payload) => { if (channel === "replay-progress") sent.push(payload); } });
    const list = service.list({ titles: true });
    await firstTurn();
    assert.equal((await service.resetFolder()).folder, null);
    scans[0].progress(5, 10);
    assert.deepEqual(sent, []);
    scans[0].finish();
    await list;
});

test("the folder moving mid-scan with no pick (tosu says another Songs): that one gets its own scan, not the old one's answer", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const moved = path.join(f.root, "Songs elsewhere");
    await mkdir(moved, { recursive: true });
    const { scans, songsIndex } = heldScans();
    let songs = null;
    const service = createReplayService({ ...f.opts, songsIndex, tosu: async () => ({ game: f.game, songs, skin: null }) });
    const first = service.list({ titles: true });
    await firstTurn();
    songs = moved;
    const second = service.list({ titles: true });
    await firstTurn();
    assert.deepEqual(scans.map((s) => s.dir), [path.join(f.game, "Songs"), moved]);
    for (const scan of scans) scan.finish();
    await Promise.all([first, second]);
});

test("the recent list: newest first, mania only, one entry a play, broken files left out", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService(f.opts);
    const quick = await service.list({ titles: false });
    assert.equal(quick.ok, true);
    assert.equal(quick.items.length, 4); // glued, honest once, unknown, random
    assert.ok(quick.items.every((i) => i.title === null && i.player === "TestPlayer"));
    const named = await service.list({ titles: true });
    const honest = named.items.filter((i) => i.score === 1000000 && i.title === "Fixture Roll");
    assert.ok(honest.length >= 1);
    assert.equal(named.items.find((i) => i.md5 === "f".repeat(32)).found, false);
    assert.equal(new Set(named.items.map((i) => i.file)).size, named.items.length);
});

test("a replay opens: its map by md5, the analysis, presses for the playback", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const before = await snapshot(f.game);
    const service = createReplayService(f.opts);
    const glued = await service.open({ file: path.join(f.game, "Replays", "glued.osr") });
    assert.equal(glued.ok, true);
    assert.equal(glued.map.title, "Fixture Roll");
    assert.equal(glued.map.od, 8);
    assert.equal(glued.map.notes.length, 200);
    assert.equal(glued.presses.length, 4);
    assert.equal(glued.reason, null);
    assert.ok(glued.analysis.manip.percent >= 95, `${glued.analysis.manip.percent}`);
    const honest = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    assert.ok(honest.analysis.manip.percent <= 2, `${honest.analysis.manip.percent}`);
    assert.ok(honest.analysis.manip.parts.length >= 1);
    assert.deepEqual(await snapshot(f.game), before, "nothing under the osu! folder changed");
    await JSON.stringify(honest); // plain data for the window
});

test("what a replay cannot give is said, not guessed", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService({ ...f.opts, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
    const open = (name) => service.open({ file: path.join(f.game, "Replays", name) });
    const unknown = await open("unknown.osr");
    assert.equal(unknown.reason, "nomap");
    assert.equal(unknown.map, null);
    assert.equal(unknown.analysis, null);
    assert.equal(unknown.replay.player, "TestPlayer");
    assert.equal((await open("random.osr")).reason, "random");
    assert.equal((await open("standard.osr")).ok, false);
    assert.equal((await open("broken.osr")).ok, false);
    assert.equal((await open("note.txt")).ok, false);
    assert.equal((await open("gone.osr")).ok, false);
    assert.deepEqual(await service.open({}), { ok: false, cancelled: true });
});

test("audio comes from the map's own folder, for the replay open only", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const audio = await service.audio({ id: opened.id });
    assert.equal(audio.ok, true);
    assert.equal(audio.data.toString(), "RIFFfake");
    assert.equal((await service.audio({ id: opened.id + 1 })).stale, true);
    assert.equal(audioFileOf("[General]\r\nAudioFilename: a b.mp3\r\nMode: 3"), "a b.mp3");
    assert.equal(audioFileOf("[General]"), null);
    assert.equal(overallDifficulty("OverallDifficulty:8.5\r\n"), 8.5);
});

test("audio cannot leave the map's folder", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const text = f.text.replace("AudioFilename: audio.wav", "AudioFilename: ..\\..\\secret.txt");
    const dir = path.join(f.game, "Songs", "2 Escape");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "x.osu"), text);
    await writeFile(path.join(f.game, "secret.txt"), "secret");
    await writeFile(path.join(f.game, "Replays", "escape.osr"), makeOsr({ md5: md5(text), presses: honestPresses(f.notes) }));
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "escape.osr") });
    assert.equal((await service.audio({ id: opened.id })).ok, false);
});

test("the skin set in osu! is read as it is: the .cfg, then tosu, a choice, the plain field", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const before = await snapshot(f.game);
    const service = createReplayService(f.opts);
    assert.deepEqual(await readOsuConfig(f.game), { skin: "Fixture Skin", songs: path.join(f.game, "Songs"), player: "TestPlayer", maniaSpeed: null, speedPerMap: null, speedByBpm: null });
    const skin = await service.skin({});
    assert.equal(skin.chosen, "Fixture Skin");
    assert.equal(skin.current, "Fixture Skin");
    assert.equal(skin.name, "Fixture Skin");
    assert.equal(skin.mania4, true);
    assert.equal(skin.config.hitPosition, 420);
    assert.deepEqual(skin.config.columnWidth, [50, 50, 50, 50]);
    assert.ok(skin.images["Notes/n1"].url.startsWith("data:image/png;base64,"));
    assert.equal(skin.images["Notes/n1"].hd, true);
    assert.deepEqual(skin.skins, ["Fixture Skin", "Other"]);
    const other = await service.skin({ folder: "Other" });
    assert.equal(other.chosen, "Other");
    assert.equal(other.mania4, false);
    const plain = await service.skin({ plain: true });
    assert.equal(plain.chosen, null);
    assert.equal(plain.config.hitPosition, 402);
    assert.deepEqual(plain.skins, ["Fixture Skin", "Other"]);
    const live = createReplayService({ ...f.opts, tosu: async () => ({ game: f.game, songs: null, skin: "other" }) });
    assert.equal((await live.skin({})).chosen, "Other");
    const noFolder = createReplayService({ ...f.opts, userData: path.join(f.root, "u5"), tosu: async () => ({ game: null, songs: null, skin: null }) });
    assert.equal((await noFolder.skin({})).chosen, null);
    assert.deepEqual(await snapshot(f.game), before, "the Skins folder is only read");
});

test("details: pattern families and the parts' dans from the shared analysis, cached, dropped for an old replay", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const calls = [];
    const families = new Array(BINS).fill("stream");
    const worker = {
        details: async (_text, rate) => { calls.push(["details", rate]); return { kind: "details", details: { v: 2, durationSec: 10, strain: [], families, flavourBins: [] } }; },
        sections: async () => { calls.push(["sections"]); return { kind: "sections", sections: { v: 1, parts: [{ dan: 12.3 }, { dan: null }], top: 0 } }; },
    };
    const memory = new Map();
    const service = createReplayService({
        ...f.opts, worker, analysis: { enqueue: (fn) => fn() },
        cache: { get: async (k) => memory.get(k) ?? null, set: async (k, v) => { memory.set(k, v); } },
    });
    const opened = await service.open({ file: path.join(f.game, "Replays", "glued.osr") });
    const r = await service.details({ id: opened.id });
    assert.equal(r.ok, true);
    assert.deepEqual(r.dans, [12.3, null]);
    assert.equal(r.families.length, BINS);
    assert.equal(r.families[0], "stream");
    assert.equal(r.spanMs, 10000);
    await service.details({ id: opened.id });
    assert.equal(calls.length, 2, "the second time comes from the cache");
    assert.equal((await service.details({ id: 99 })).stale, true);
});

test("details: a break between patterns comes as null, a family stays what it is", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const worker = {
        details: async () => ({ kind: "details", details: { v: 2, durationSec: 10, strain: [], families: new Array(BINS).fill("none").map((_, i) => (i ? BREAK : "stream")), flavourBins: [] } }),
        sections: async () => ({ kind: "sections", sections: { v: 1, parts: [], top: 0 } }),
    };
    const service = createReplayService({ ...f.opts, worker, analysis: { enqueue: (fn) => fn() }, cache: { get: async () => null, set: async () => {} } });
    const opened = await service.open({ file: path.join(f.game, "Replays", "glued.osr") });
    const r = await service.details({ id: opened.id });
    assert.deepEqual([r.families[0], r.families[1]], ["stream", null]);
});

// A folder whose Data\\r gets a file while the service waits; sleep moves a pretend clock and writes when told.
async function endedFixture(t) {
    const f = await fixture();
    t.after(f.cleanup);
    let clock = Date.now() + 86400000; // after every file the fixture just wrote
    const sent = [];
    const during = [];
    const timed = []; // { after, step }: run once the pretend clock has gone that far from now
    const flags = { playing: false };
    const opts = {
        ...f.opts, now: () => clock, send: (channel, payload) => sent.push([channel, payload]), playing: () => flags.playing,
        sleep: async (ms) => {
            clock += ms;
            for (const step of during.splice(0)) await step();
            for (const item of timed.filter((x) => clock >= x.at)) {
                timed.splice(timed.indexOf(item), 1);
                await item.step();
            }
        },
    };
    const play = (over = {}) => ({
        client: "stable", md5: f.hash, artist: "Test", title: "Fixture Roll", version: "Rolls", rate: 1, accuracy: 0.9512, outcome: "pass", startedAt: clock - 60000, at: clock, ...over,
    });
    const put = async (name, bytes, at = clock) => {
        const file = path.join(f.game, "Data", "r", name);
        await writeFile(file, bytes);
        await utimes(file, new Date(at), new Date(at));
        return file;
    };
    return { ...f, opts, sent, during, flags, play, put, now: () => clock, later: (ms, step) => timed.push({ at: clock + ms, step }) };
}

test("a play ends: the replay written for it is found by md5 and time, the window is told, an older one is not taken", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    const old = await f.put(`${f.hash}-100.osr`, makeOsr({ md5: f.hash, presses: [], at: Date.UTC(2026, 8, 1) }), Date.UTC(2026, 8, 1));
    await stat(old);
    const bytes = makeOsr({ md5: f.hash, presses: honestPresses(f.notes), at: f.now() });
    let written = null;
    f.during.push(async () => { written = await f.put(`${f.hash}-200.osr`, bytes); });
    const out = await service.playEnded(f.play());
    assert.equal(out.file, written);
    assert.equal(out.reason, null);
    assert.equal(out.accuracy, 95.12);
    assert.deepEqual(f.sent.map(([channel]) => channel), ["replay-ended"]);
    assert.equal(f.sent[0][1].file, written);
    assert.equal(f.sent[0][1].title, "Fixture Roll");
});

test("a play ends with no replay: it says so after its wait, sooner for a play not passed", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    const from = f.now();
    const pass = await service.playEnded(f.play());
    assert.deepEqual([pass.file, pass.reason], [null, "none"]);
    assert.ok(f.now() - from >= ENDED_WAIT_MS.pass, "a pass is waited for");
    const failFrom = f.now();
    const fail = await service.playEnded(f.play({ outcome: "fail" }));
    assert.equal(fail.reason, "none");
    assert.ok(f.now() - failFrom < ENDED_WAIT_MS.pass / 2);
    assert.equal((await service.playEnded(f.play({ client: "lazer" }))).reason, "lazer");
});

test("a pass's replay that takes its time is still opened, with no word of it missing meanwhile", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    const bytes = makeOsr({ md5: f.hash, presses: honestPresses(f.notes), at: f.now() });
    for (const seconds of [25, 163.5]) {
        f.sent.length = 0;
        const from = f.now();
        let written = null;
        f.later(seconds * 1000, async () => { written = await f.put(`${f.hash}-${seconds * 10}.osr`, bytes); });
        const out = await service.playEnded(f.play({ startedAt: from - 1000 }));
        assert.equal(out.file, written);
        assert.equal(out.reason, null);
        assert.ok(f.now() - from >= seconds * 1000);
        assert.deepEqual(f.sent.map(([, p]) => [p.waiting ?? false, p.reason, p.file]), [[true, null, null], [false, null, written]], "only that it is on its way, then the replay");
        await rm(written);
    }
});

test("a pass with no replay: told only after the long wait, or a little after the next play began, and then the tab stays", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    const from = f.now();
    const out = await service.playEnded(f.play());
    assert.deepEqual([out.file, out.reason, out.moved], [null, "none", false]);
    assert.ok(f.now() - from >= ENDED_WAIT_MS.pass);

    const start = f.now();
    f.later(40_000, () => { f.flags.playing = true; });
    const next = await service.playEnded(f.play({ startedAt: start - 1000 }));
    assert.deepEqual([next.reason, next.moved], ["none", true]);
    const waited = f.now() - start;
    assert.ok(waited >= 40_000 + NEXT_PLAY_GRACE_MS && waited < 40_000 + NEXT_PLAY_GRACE_MS + 5_000, `${waited}`);

    f.flags.playing = true;
    const bytes = makeOsr({ md5: f.hash, presses: honestPresses(f.notes), at: f.now() });
    let written = null;
    f.later(NEXT_PLAY_GRACE_MS / 2, async () => { written = await f.put(`${f.hash}-500.osr`, bytes); });
    assert.equal((await service.playEnded(f.play({ startedAt: f.now() - 1000 }))).file, written, "a file written as the player moved on is still taken");
});

test("the switch turned off during the wait ends it", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    f.later(1_000, () => service.setAfterPlay({ on: false }));
    const from = f.now();
    assert.equal(await service.playEnded(f.play()), null);
    assert.ok(f.now() - from < 5_000);
    assert.equal(f.sent.length, 0);
});

test("watching one's own replay in osu! is no play: no new file, and no word of a missing one", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    const counts = { max: 40, n300: 7, n200: 1, n100: 0, n50: 0, miss: 2 };
    const old = f.now() - 3600_000;
    await f.put(`${f.hash}-100.osr`, makeOsr({ md5: f.hash, presses: honestPresses(f.notes), counts, at: old }), old);
    const startedAt = f.now() - 60_000;
    assert.equal(await service.playEnded(f.play({ hits: counts, startedAt })), null);
    assert.equal(f.sent.length, 0, "nothing at all reaches the window");
    assert.equal((await service.playEnded(f.play({ hits: { ...counts, miss: 3 }, outcome: "fail", startedAt }))).reason, "none", "other counts are another play");

    const bytes = makeOsr({ md5: f.hash, presses: honestPresses(f.notes), counts, at: f.now() });
    let written = null;
    f.during.push(async () => { written = await f.put(`${f.hash}-200.osr`, bytes); });
    assert.equal((await service.playEnded(f.play({ hits: counts, startedAt: f.now() - 1000 }))).file, written, "a real play with the very same counts still gets its replay");
});

test("a marathon's counts are put right when it is opened and on the list", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const notes = Array.from({ length: 66000 }, (_, i) => ({ t: 1000 + i * 100, col: i % 4, end: null }));
    const dir = path.join(f.game, "Songs", "2 Test - Marathon");
    await mkdir(dir, { recursive: true });
    const text = chartText(notes, { title: "Marathon", version: "Long" });
    await writeFile(path.join(dir, "Test - Marathon (TestPlayer) [Long].osu"), text);
    const hash = md5(text);
    const presses = notes.map((n) => ({ t: n.t, col: n.col, up: n.t + 30 }));
    const service = createReplayService(f.opts);
    const bytes = makeOsr({ md5: hash, presses, counts: { max: 464 }, maxCombo: 464, at: Date.UTC(2026, 9, 3) });
    const file = path.join(f.game, "Replays", "marathon.osr");
    await writeFile(file, bytes);
    const opened = await service.open({ file });
    assert.deepEqual([opened.replay.counts.max, opened.replay.counts.accuracy, opened.replay.maxCombo], [66000, 100, 66000]);
    assert.equal(opened.analysis.played, 66000);
    assert.equal(opened.analysis.comparison.same, true);
    const row = (await service.list({ titles: true })).items.find((i) => i.md5 === hash);
    assert.equal(row.accuracy, 100);
    assert.equal(row.miss, 0);
});

test("a half-written replay is read again; a newer play ends the wait for the older; the switch stops it all", async (t) => {
    const f = await endedFixture(t);
    const service = createReplayService(f.opts);
    const bytes = makeOsr({ md5: f.hash, presses: honestPresses(f.notes), at: f.now() });
    await f.put(`${f.hash}-300.osr`, bytes.subarray(0, 40));
    let whole = null;
    f.during.push(async () => { whole = await f.put(`${f.hash}-300.osr`, bytes); });
    assert.equal((await service.playEnded(f.play({ startedAt: f.now() - 1000 }))).file, whole);

    const other = createReplayService({ ...f.opts, userData: path.join(f.root, "other") });
    await rm(whole);
    f.sent.length = 0;
    let second = null;
    f.during.push(async () => { second = other.playEnded(f.play({ outcome: "fail", md5: "a".repeat(32) })); });
    assert.equal(await other.playEnded(f.play()), null, "the first gives way");
    assert.equal((await second).reason, "none");
    assert.equal(f.sent.length, 1);

    f.sent.length = 0;
    await service.setAfterPlay({ on: false });
    assert.equal((await service.status()).afterPlay, false);
    assert.equal(await service.playEnded(f.play()), null);
    assert.equal(f.sent.length, 0);
    assert.equal((await createReplayService(f.opts).status()).afterPlay, false, "and it is remembered");
});

test("earlier plays of the map: the same player's, older than the one open, each worked out", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const data = path.join(f.game, "Data", "r");
    const older = Date.UTC(2026, 8, 20);
    await writeFile(path.join(data, `${f.hash}-10.osr`), makeOsr({ md5: f.hash, presses: gluedPresses(f.notes), at: older, score: 5 }));
    await writeFile(path.join(data, `${f.hash}-11.osr`), makeOsr({ md5: f.hash, presses: honestPresses(f.notes, { sdMs: 20 }), at: older + 1000, score: 6 }));
    await writeFile(path.join(data, `${f.hash}-12.osr`), makeOsr({ md5: f.hash, player: "Someone Else", presses: honestPresses(f.notes), at: older + 2000, score: 7 }));
    await writeFile(path.join(data, `${f.hash}-13.osr`), makeOsr({ md5: f.hash, presses: honestPresses(f.notes), at: Date.UTC(2026, 11, 1), score: 8 }));
    await writeFile(path.join(data, "ffffffffffffffffffffffffffffffff-1.osr"), makeOsr({ md5: "f".repeat(32), presses: [], at: older }));
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "glued.osr") });
    const r = await service.earlier({ id: opened.id });
    assert.equal(r.ok, true);
    assert.equal(r.total, 4, "the two here, the honest one kept twice (once), the Random one, which has no numbers");
    assert.equal(r.plays.length, 3);
    assert.deepEqual(r.plays.slice(1).map((p) => p.at), [older + 1000, older]);
    assert.ok(r.plays[2].manip > 90, "worked out like the open one");
    assert.ok(r.plays[1].manip < 30);
    assert.ok(r.plays[1].ur > 100);
    const moved = await service.earlier({ id: opened.id, fingers: ["L4", "L3", "L2", "R2"] });
    assert.notEqual(moved.plays[2].pairs, r.plays[2].pairs, "the fingers picked in the tab decide the pairs here too");
    assert.equal(moved.plays[2].accuracy, r.plays[2].accuracy, "and nothing else");
    assert.equal((await service.earlier({ id: 99 })).stale, true);
});

test("earlier plays of the map: each says whether its recount can be told as it is", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const notes = rollNotes({ count: 40, stepMs: 300 }).map((n) => ({ ...n, end: n.t + 150 }));
    const text = chartText(notes, { title: "Fixture Holds" });
    const hash = md5(text);
    await mkdir(path.join(f.game, "Songs", "2 Holds"));
    await writeFile(path.join(f.game, "Songs", "2 Holds", "x.osu"), text);
    const presses = honestPresses(notes, { sdMs: 8 });
    const worked = (await createReplayService(f.opts).open({ file: await put(`${hash}-1.osr`, { at: 1000 }) })).analysis;
    assert.ok(worked.holdHeavy && !worked.comparison.same, "a map of holds, with a header the recount does not match");
    async function put(name, { at, counts = {} }) {
        const file = path.join(f.game, "Data", "r", name);
        await writeFile(file, makeOsr({ md5: hash, presses, at, score: at, counts }));
        return file;
    }
    const open = await put(`${hash}-2.osr`, { at: Date.UTC(2026, 9, 2) });
    await put(`${hash}-3.osr`, { at: Date.UTC(2026, 9, 1), counts: worked.counts });
    await put(`${hash}-4.osr`, { at: Date.UTC(2026, 8, 30) });
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: open });
    const { plays } = await service.earlier({ id: opened.id });
    assert.deepEqual(plays.slice(0, 2).map((p) => p.exact), [true, false]);
});

test("nothing earlier: an empty answer", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.earlier({ id: opened.id });
    assert.deepEqual(r.plays, []);
});

// `count` maps of their own, a play of each `leanMs` off the notes, written after the fixture's own replays, the first the newest
const LEAN_FROM = Date.now() + 86_400_000;
async function leaningPlays(f, { count = HINTS.position.plays + 2, leanMs = 7, player = "TestPlayer", hits = HINTS.position.minHits + 20, cut = 0, first = 0, mods = 0 } = {}) {
    const files = [];
    for (let i = first; i < first + count; i += 1) {
        const notes = rollNotes({ count: hits, stepMs: 70 + i });
        const text = chartText(notes, { title: `Lean ${i}` });
        const hash = md5(text);
        const dir = path.join(f.game, "Songs", `${100 + i} Test - Lean`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `Test - Lean ${i} (TestPlayer) [Rolls].osu`), text);
        const at = LEAN_FROM - i * 1000;
        const presses = honestPresses(notes, { sdMs: 6, seed: i + 1 }).map((p) => ({ ...p, t: p.t + leanMs, up: p.up + leanMs })).slice(0, hits - cut);
        const file = path.join(f.game, "Data", "r", `${hash}-${i}.osr`);
        await writeFile(file, makeOsr({ md5: hash, player, presses, at, score: 1000 + i, mods }));
        await utimes(file, new Date(at), new Date(at));
        files.push(file);
    }
    return files;
}
const closeTo = (actual, expected, near = 1) => assert.ok(Math.abs(actual - expected) <= near, `${actual} is not near ${expected}`);

test("the lean of the latest plays: the newest of the player's, each with its map, played to the end, up to the limit", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const before = await leaningPlays(f);
    const snapshotBefore = await snapshot(f.game);
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.bias({ id: opened.id });
    assert.equal(r.ok, true);
    assert.equal(r.id, opened.id);
    assert.equal(r.plays.length, HINTS.position.plays);
    assert.equal(before.length, HINTS.position.plays + 2);
    assert.deepEqual(r.plays.map((p) => p.at), [...r.plays.map((p) => p.at)].sort((a, b) => b - a), "newest first");
    assert.equal(r.plays[0].at, LEAN_FROM);
    assert.equal(new Set(r.plays.map((p) => p.md5)).size, HINTS.position.plays, "each its own map");
    for (const p of r.plays) {
        closeTo(p.mean, 7);
        assert.equal(p.hits, HINTS.position.minHits + 20);
        assert.deepEqual(Object.keys(p).sort(), ["at", "hits", "md5", "mean"]);
    }
    assert.deepEqual(await snapshot(f.game), snapshotBefore, "the osu! folder is only read");
});

test("the lean of the latest plays: what has nothing to say is left out", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const good = await leaningPlays(f, { count: 3, first: 0 });
    await leaningPlays(f, { count: 2, first: 10, player: "Someone Else" });
    await leaningPlays(f, { count: 2, first: 20, hits: HINTS.position.minHits - 1 });
    await leaningPlays(f, { count: 2, first: 30, hits: HINTS.position.minHits + 60, cut: 40 }); // hits enough, but not to the end
    await leaningPlays(f, { count: 2, first: 40, mods: MOD_BITS.RD });
    const noMap = await leaningPlays(f, { count: 1, first: 50 });
    await rm(path.join(f.game, "Songs", "150 Test - Lean"), { recursive: true });
    await writeFile(path.join(f.game, "Data", "r", "broken.osr"), Buffer.from([1, 2, 3]));
    await utimes(path.join(f.game, "Data", "r", "broken.osr"), new Date(LEAN_FROM), new Date(LEAN_FROM));
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.bias({ id: opened.id });
    const newest = r.plays.filter((p) => p.at >= LEAN_FROM - 100_000);
    assert.equal(newest.length, good.length, "the other player's, the short ones, those cut short, Random's and the one with no map are not counted");
    assert.ok(noMap.length === 1 && newest.every((p) => Math.abs(p.mean - 7) < 1));
});

test("the lean of the latest plays: one play kept twice counts once", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const [file] = await leaningPlays(f, { count: 1 });
    const copy = path.join(f.game, "Replays", "exported.osr");
    await writeFile(copy, await readFile(file));
    await utimes(copy, new Date(LEAN_FROM + 5000), new Date(LEAN_FROM + 5000));
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.bias({ id: opened.id });
    assert.equal(r.plays.filter((p) => p.at === LEAN_FROM).length, 1);
});

test("the lean of the latest plays: each replay is worked out once for its file and time, and goes on when the file does", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const files = await leaningPlays(f, { count: HINTS.position.plays });
    const reads = [];
    const fs = { ...nodeFs, readFile: (file, ...rest) => { reads.push(String(file)); return nodeFs.readFile(file, ...rest); } };
    const service = createReplayService({ ...f.opts, fs });
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const first = await service.bias({ id: opened.id });
    const read = (file) => reads.filter((r) => r === file).length;
    assert.ok(files.every((file) => read(file) === 1), "each read once");
    reads.length = 0;
    const again = await service.bias({ id: opened.id });
    assert.deepEqual(again.plays, first.plays);
    assert.ok(files.every((file) => read(file) === 0), "the second time from memory");
    const later = new Date(LEAN_FROM + 1000);
    await utimes(files[3], later, later);
    reads.length = 0;
    await service.bias({ id: opened.id });
    assert.equal(read(files[3]), 1, "a file with a new time is read again");
    assert.equal(read(files[4]), 0, "and only it");
});

test("the lean of the latest plays: never all at once, and a stale answer is dropped", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await leaningPlays(f, { count: 4 });
    let pauses = 0;
    let onPause = () => {};
    const service = createReplayService({ ...f.opts, sleep: async () => { pauses += 1; await onPause(); } });
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    await service.bias({ id: opened.id });
    assert.ok(pauses >= 4, `a pause before each replay (${pauses})`);
    onPause = async () => {
        onPause = () => {};
        await service.open({ file: path.join(f.game, "Replays", "glued.osr") });
    };
    assert.deepEqual(await service.bias({ id: opened.id }), { ok: false, stale: true }, "another replay was opened meanwhile");
    assert.equal((await service.bias({ id: 99 })).stale, true);
    assert.equal((await service.bias({})).stale, true);
});

test("the lean of the latest plays: no folder, an empty answer", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    let game = f.game;
    const service = createReplayService({ ...f.opts, tosu: async () => ({ game, songs: null, skin: null }) });
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    game = null;
    assert.deepEqual(await service.bias({ id: opened.id }), { ok: true, id: opened.id, plays: [], position: null });
    assert.equal((await service.bias({ id: opened.id + 1 })).stale, true, "asked of a replay not open");
});

test("the lean of the latest plays: told only of the player this osu! is set to, whose skin it is, and with no work otherwise", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await leaningPlays(f, { count: 3, first: 0 });
    const others = await leaningPlays(f, { count: 3, first: 10, player: "Someone Else" });
    const reads = [];
    const fs = { ...nodeFs, readFile: (file, ...rest) => { reads.push(String(file)); return nodeFs.readFile(file, ...rest); } };
    const service = createReplayService({ ...f.opts, fs });
    const theirs = await service.open({ file: others[0] });
    reads.length = 0;
    assert.deepEqual(await service.bias({ id: theirs.id }), { ok: true, id: theirs.id, plays: [], position: null }, "this machine's HitPosition is no one else's");
    assert.deepEqual(reads.filter((file) => file.endsWith(".osr")), [], "no replay was read for it");
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const mine = await service.bias({ id: opened.id });
    assert.equal(mine.plays.filter((p) => p.at >= LEAN_FROM - 2000).length, 3);
    assert.equal(mine.position.hitPosition, 420);
    await writeFile(path.join(f.game, "osu!.TestPlayer.cfg"), "Skin = Fixture Skin\r\nUsername = testplayer \r\n");
    assert.equal((await service.bias({ id: opened.id })).position.hitPosition, 420, "osu! keeps a name as it was typed at login");
});

test("the lean of the latest plays: a .cfg that keeps no name cannot tell whose skin it is, so the skin's value is not told", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await leaningPlays(f, { count: 3, first: 0 });
    await writeFile(path.join(f.game, "osu!.TestPlayer.cfg"), "Username = \r\nSkin = Fixture Skin\r\nManiaSpeed = 24\r\n");
    assert.equal((await readOsuConfig(f.game)).player, null, "an empty line does not take the text of the next one");
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.bias({ id: opened.id });
    assert.equal(r.plays.filter((p) => p.at >= LEAN_FROM - 2000).length, 3, "the lean is still that of the replay's player");
    assert.deepEqual(r.position, { hitPosition: null, maniaSpeed: 24, speedPerMap: null, speedByBpm: null });
});

test("the lean of the latest plays: another player's replays take no work, and are that player's when theirs is opened", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.game, "osu!.TestPlayer.cfg"), "Skin = Fixture Skin\r\n");
    await leaningPlays(f, { count: 3, first: 0 });
    const others = await leaningPlays(f, { count: 3, first: 10, player: "Someone Else" });
    const maps = [];
    const fs = { ...nodeFs, readFile: (file, ...rest) => { if (String(file).endsWith(".osu")) maps.push(String(file)); return nodeFs.readFile(file, ...rest); } };
    const service = createReplayService({ ...f.opts, fs });
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    maps.length = 0;
    const mine = await service.bias({ id: opened.id });
    assert.equal(mine.plays.filter((p) => p.at >= LEAN_FROM - 2000).length, 3);
    assert.deepEqual(maps.filter((file) => file.includes("11")), [], "no map of theirs was read");
    const theirs = await service.open({ file: others[0] });
    const r = await service.bias({ id: theirs.id });
    assert.deepEqual(r.plays.map((p) => p.at), [0, 1, 2].map((i) => LEAN_FROM - (10 + i) * 1000), "and none of the first player's, kept in memory");
});

test("the lean of the latest plays: a file too big to be a replay is not read", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const [big, ...rest] = await leaningPlays(f, { count: 3 });
    const reads = [];
    const fs = {
        ...nodeFs,
        stat: async (file, ...more) => {
            const s = await nodeFs.stat(file, ...more);
            return file === big ? { isFile: () => true, isDirectory: () => false, mtimeMs: s.mtimeMs, size: 1e12 } : s;
        },
        readFile: (file, ...more) => { reads.push(String(file)); return nodeFs.readFile(file, ...more); },
    };
    const service = createReplayService({ ...f.opts, fs });
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.bias({ id: opened.id });
    assert.equal(r.plays.filter((p) => p.at >= LEAN_FROM - 2000).length, rest.length);
    assert.equal(reads.includes(big), false);
});

test("the lean of the latest plays: only so many of the newest files are looked at, whatever they hold", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await leaningPlays(f, { count: 1 });
    const filler = Array.from({ length: LIST_READ_MAX }, (_, i) => path.join(f.game, "Data", "r", `filler-${i}.osr`));
    for (const [i, file] of filler.entries()) {
        await writeFile(file, "not a replay");
        await utimes(file, new Date(LEAN_FROM + 1000 + i), new Date(LEAN_FROM + 1000 + i));
    }
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const found = async () => (await service.bias({ id: opened.id })).plays.filter((p) => p.at === LEAN_FROM).length;
    assert.equal(await found(), 0);
    await rm(filler[0]);
    assert.equal(await found(), 1, "one file less and it is within reach");
});

test("the lean of the latest plays: a replay whose map comes later counts from then on", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await leaningPlays(f, { count: 1, first: 60 });
    const at = path.join(f.game, "Songs", "160 Test - Lean");
    const away = path.join(f.root, "away");
    await rename(at, away);
    let clock = Date.now();
    const service = createReplayService({ ...f.opts, now: () => clock });
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const found = async () => (await service.bias({ id: opened.id })).plays.filter((p) => p.at === LEAN_FROM - 60_000).length;
    assert.equal(await found(), 0);
    await rename(away, at);
    clock += 3_600_000; // the Songs folder is looked over again
    assert.equal(await found(), 1);
});

test("the lean of the latest plays comes with what the skin and the .cfg say", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const position = async () => (await service.bias({ id: opened.id })).position;
    assert.deepEqual(await position(), { hitPosition: 420, maniaSpeed: null, speedPerMap: null, speedByBpm: null }, "lines the .cfg does not have stay unknown");
    await writeFile(path.join(f.game, "osu!.TestPlayer.cfg"), "BeatmapDirectory = Songs\r\nSkin = Fixture Skin\r\nUsername = TestPlayer\r\nManiaSpeed = 24\r\nUsePerBeatmapManiaSpeed = 0\r\nManiaSpeedBPMScale = 1\r\n");
    assert.deepEqual(await position(), { hitPosition: 420, maniaSpeed: 24, speedPerMap: false, speedByBpm: true });
    await writeFile(path.join(f.game, "osu!.TestPlayer.cfg"), "Skin = Other\r\nUsername = TestPlayer\r\n");
    assert.equal((await position()).hitPosition, 402, "a skin with no 4K section: osu!'s default");
    await writeFile(path.join(f.game, "osu!.TestPlayer.cfg"), "Skin = Not There\r\nUsername = TestPlayer\r\n");
    assert.equal((await position()).hitPosition, null);
    const tosu = createReplayService({ ...f.opts, tosu: async () => ({ game: f.game, songs: null, skin: "Fixture Skin" }) });
    const other = await tosu.open({ file: path.join(f.game, "Replays", "honest.osr") });
    assert.equal((await tosu.bias({ id: other.id })).position.hitPosition, 420, "what tosu says of the skin goes first");
});

test("the channel for the lean is registered and the window can reach it", async () => {
    const channels = [];
    registerReplayIpc({ ipcMain: { handle: (name) => { channels.push(name); } }, paths: { userData: os.tmpdir() }, tosu: {}, send: () => {}, log: () => {} });
    assert.ok(channels.includes("replay-bias"));
    assert.match(await readFile(new URL("../../app/preload.cjs", import.meta.url), "utf8"), /replayBias: \(request\) => ipcRenderer\.invoke\("replay-bias", request\)/);
});

test("the recorder's end of a play reaches the service only from the window's load on", async () => {
    let listener = null;
    const handlers = {};
    const hooks = { on: (name, fn) => { handlers[name] = fn; } };
    const calls = [];
    const localProfile = { onPlayEnded: (fn) => { calls.push("listen"); listener = fn; } };
    const ipcMain = { handle: () => {} };
    registerReplayIpc({ ipcMain, paths: { userData: os.tmpdir() }, hooks, localProfile, tosu: {}, send: () => {}, log: () => {} });
    assert.equal(listener, null);
    handlers["window-load"]();
    handlers["window-load"]();
    assert.deepEqual(calls, ["listen"]);
    assert.equal(typeof listener, "function");
});

test("tosu's folders, nulls on lazer or when it is down", async () => {
    const answer = (json) => async () => ({ ok: true, json: async () => json });
    assert.deepEqual(await tosuFolders(1, answer({ client: "stable", folders: { game: "C:\\osu!\\", songs: "C:\\osu!\\Songs", skin: "Some Skin" } })), { game: "C:\\osu!", songs: "C:\\osu!\\Songs", skin: "Some Skin" });
    assert.deepEqual(await tosuFolders(1, answer({ client: "lazer", folders: { game: "x" } })), { game: null, songs: null, skin: null });
    assert.deepEqual(await tosuFolders(1, async () => { throw new Error("down"); }), { game: null, songs: null, skin: null });
    assert.deepEqual(await tosuFolders(null), { game: null, songs: null, skin: null });
});

test("the channels are hung without I/O", () => {
    const handled = [];
    registerReplayIpc({ ipcMain: { handle: (c) => handled.push(c) }, paths: {}, tosu: {} });
    assert.ok(handled.includes("replay-open") && handled.includes("replay-skin"));
    assert.equal(new Set(handled).size, handled.length);
});

test("the local profile's folder reaches the service through its dep", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const handlers = {};
    registerReplayIpc({
        ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } }, paths: { userData: path.join(f.root, "u-dep") }, tosu: {}, send: () => {}, log: () => {},
        localProfile: { osuFolder: async () => f.game },
    });
    const status = await handlers["replay-status"]();
    assert.deepEqual([status.folder, status.source, status.picked], [f.game, "profile", null]);
});
