// The Replay tab's main side over a fixture osu! folder made here only (a made-up player): the folder's order of
// precedence, the recent list, opening a replay, its map by md5, audio, the skin set in osu! read as it is, the details
// from the shared analysis; and nothing under the osu! folder ever changes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReplayService, registerReplayIpc, readOsuConfig, audioFileOf, overallDifficulty, tosuFolders, ENDED_WAIT_MS, NEXT_PLAY_GRACE_MS } from "../../app/replayIpc.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { makeOsr, honestPresses, gluedPresses, rollNotes, chartText } from "../fixtures/makeOsr.js";
import { encodePng } from "../../src/skin/png.js";
import { MOD_BITS } from "../../src/localProfile/scoresDb.js";
import { BINS, BREAK } from "../../src/analysis/timeline.js";

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
    await writeFile(path.join(game, "osu!.TestPlayer.cfg"), "BeatmapDirectory = Songs\r\nSkin = Fixture Skin\r\n");
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
    await mkdir(auto, { recursive: true });
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
    assert.deepEqual(await readOsuConfig(f.game), { skin: "Fixture Skin", songs: path.join(f.game, "Songs") });
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

test("nothing earlier: an empty answer", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const service = createReplayService(f.opts);
    const opened = await service.open({ file: path.join(f.game, "Replays", "honest.osr") });
    const r = await service.earlier({ id: opened.id });
    assert.deepEqual(r.plays, []);
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
