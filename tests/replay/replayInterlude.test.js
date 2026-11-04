// Interlude's own plays in the Replay tab, the main side (app/replayInterlude.js, and app/replayIpc.js handing them
// there): the list beside osu!'s, opening a play judged by the ruleset chosen in Interlude or another, the ruleset built
// in when that one cannot be read, the chart's audio, the earlier plays of the chart, why a play cannot be shown, and
// the wait for a play's new row of scores.db after it ends.
// Every Interlude folder here is a temp fixture (tests/fixtures/interludeFolder.js) with a made-up chart and made-up
// replays (tests/fixtures/makeIlReplay.js); nothing is ever written into it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeInterludeFolder } from "../fixtures/interludeFolder.js";
import { makeIlReplay, framesOfPresses } from "../fixtures/makeIlReplay.js";
import { rollNotes, chartText, honestPresses } from "../fixtures/makeOsr.js";
import { osuJson } from "../interlude/rulesets.js";
import { createInterludeLibrary } from "../../app/interludeLibrary.js";
import { createInterludeClient } from "../../app/interludeClient.js";
import { createIlReplays, parsePlayId, playIdOf, rateShown, BUILTIN_RULESET, IL_ENDED_WAIT_MS, IL_ENDED_SLACK_MS } from "../../app/replayInterlude.js";
import { createReplayService } from "../../app/replayIpc.js";
import { analyzeIlReplay } from "../../src/replay/analyzeInterlude.js";
import { readIlReplay, applyIlMods, ilNotes } from "../../src/interlude/replay.js";
import { parseRuleset, SC_J4 } from "../../src/interlude/ruleset.js";
import { setLang, t as say } from "../../src/i18n/i18n.js";

const DAY = Date.UTC(2026, 9, 5);
const AUDIO = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64, 3)]);

// Presses of the chart's notes (ms of the chart) → the Replay blob, its times from the first note.
const blobOf = (presses, first) => makeIlReplay(framesOfPresses(presses.map((p) => ({ ...p, t: p.t - first, up: p.up - first }))));

// One chart of 60 notes rolled over the four columns, and plays of it: an honest one, a mirrored one, a failed one
// (half of it), one imported from osu! (not listed), one with a mod not followed, a damaged one, a 7K one and one whose
// chart is gone from charts.db; the rulesets osu! OD8 (chosen in Interlude), osu! OD10 and a file that is no ruleset.
async function fixture(t, { options = { SelectedRuleset: "osu-od8" }, rulesetDir = "Rulesets" } = {}) {
    const notes = rollNotes({ count: 60, stepMs: 150 });
    const text = chartText(notes, { title: "Roll Of Plays", artist: "Synth", version: "4K Roll" });
    const first = notes[0].t;
    const honest = honestPresses(notes, { sdMs: 9, seed: 4 });
    const mirrored = honestPresses(notes, { sdMs: 12, seed: 5 }).map((p) => ({ ...p, col: 3 - p.col }));
    const half = honestPresses(notes.slice(0, 30), { sdMs: 9, seed: 6 });
    const plays = [
        { index: 0, at: DAY + 6000, replay: blobOf(honest, first), imported: true },
        { index: 0, at: DAY + 5000, replay: blobOf(honest, first) },
        { index: 0, at: DAY + 4000, replay: blobOf(mirrored, first), mods: { mirror: 0 }, rate: Math.fround(1.1) },
        { index: 0, at: DAY + 3000, replay: blobOf(half, first), failed: true },
        { index: 0, at: DAY + 2000, replay: blobOf(honest, first), mods: { shuffle: 0 } },
        { index: 0, at: DAY + 1000, replay: Buffer.from("not a replay") },
        { index: 0, at: DAY + 500, replay: blobOf(honest, first), keys: 7 },
    ];
    const f = await makeInterludeFolder({
        charts: [{ osuText: text, title: "Roll Of Plays", artist: "Synth", version: "4K Roll", audio: AUDIO }],
        plays, options, rulesetDir,
        rulesets: { "osu-od8": osuJson(8), "osu-od10": osuJson(10), broken: "{ not a ruleset" },
    });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    // a play of a chart charts.db does not have (deleted from the library since)
    const db = new DatabaseSync(path.join(f.root, "Data", "scores.db"));
    db.prepare("INSERT INTO scores (ChartId, Timestamp, Replay, Rate, Mods, IsImported, Keys, IsFailed) VALUES (?, ?, ?, 1, '{}', 0, 4, 0)")
        .run("AB".repeat(32), DAY + 100, blobOf(honest, first));
    db.close();
    const hash = f.charts[0].hash;
    const cacheDir = path.join(f.root, "..", `${path.basename(f.root)}-cache`);
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const logs = [];
    let folder = f.root;
    const library = createInterludeLibrary({ folder: () => folder, cacheDir, log: (m) => logs.push(m) });
    const interlude = { folder: () => folder, library, ready: async () => {} };
    const play = (at) => playIdOf(hash, at);
    return {
        ...f, hash, notes, first, honest, mirrored, library, interlude, logs, play,
        setFolder: (dir) => { folder = dir; },
        // what the engine makes of a play by a ruleset, to compare with
        expected: (at, ruleset, { mods = {}, failed = false, rate = 1 } = {}) => {
            const row = plays.find((p) => p.at === at);
            const chart = applyIlMods(f.charts[0].chart, mods);
            return analyzeIlReplay({ ruleset, chart, notes: ilNotes(chart), frames: readIlReplay(row.replay), rate, failed });
        },
    };
}

// every file under dir with its size and time, to show a folder was not written to
async function filesOf(dir) {
    const out = {};
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!e.isFile()) continue;
        const file = path.join(e.parentPath ?? e.path, e.name);
        const s = await stat(file);
        out[path.relative(dir, file)] = `${s.size}|${s.mtimeMs}`;
    }
    return out;
}

const OD8 = parseRuleset(osuJson(8));
const OD10 = parseRuleset(osuJson(10));

test("a play's id is interlude:<chart>:<at>; anything else is no play", () => {
    assert.equal(playIdOf("ABC123", 1700000000000), "interlude:ABC123:1700000000000");
    assert.deepEqual(parsePlayId("interlude:ABC123:1700000000000"), { chart: "ABC123", at: 1700000000000 });
    for (const bad of [null, "", "interlude:ABC", "interlude:../x:1", "osu:ABC:1", "interlude:ABC:1.5", "C:\\replay.osr"]) assert.equal(parsePlayId(bad), null, String(bad));
});

test("the list: Interlude's own plays newest first, judged by the ruleset chosen in Interlude, and why one cannot be", async (t) => {
    const f = await fixture(t);
    const before = await filesOf(f.root);
    const il = createIlReplays({ interlude: f.interlude });
    const { interlude, items } = await il.list();
    assert.deepEqual(interlude, { linked: true, ok: true, reason: null });
    assert.deepEqual(items.map((i) => i.at), [5000, 4000, 3000, 2000, 1000, 500, 100].map((d) => DAY + d), "newest first, the imported play left out");
    const [honest, mirror, failed, shuffled, damaged, seven, gone] = items;
    assert.deepEqual(
        { ...honest, accuracy: null },
        {
            kind: "interlude", play: f.play(DAY + 5000), chart: f.hash, at: DAY + 5000, rate: 1, modNames: [], accuracy: null, miss: 0, failed: false,
            artist: "Synth", title: "Roll Of Plays", version: "4K Roll", found: true, reason: null,
        },
    );
    assert.equal(honest.accuracy, f.expected(DAY + 5000, OD8).accuracy, "the engine's accuracy, by osu! OD8");
    assert.deepEqual([mirror.modNames, mirror.rate, mirror.accuracy], [["MR"], 1.1, f.expected(DAY + 4000, OD8, { mods: { mirror: 0 }, rate: Math.fround(1.1) }).accuracy]);
    const half = f.expected(DAY + 3000, OD8, { failed: true });
    assert.deepEqual([failed.failed, failed.accuracy, failed.miss], [true, half.accuracy, half.counts.miss], "a failed play judged as far as it went");
    assert.deepEqual([shuffled.reason, shuffled.accuracy, shuffled.modNames], ["mods", null, ["SHF"]]);
    assert.deepEqual([damaged.reason, seven.reason], ["badReplay", "keys"]);
    assert.deepEqual([gone.reason, gone.found, gone.title], ["nochart", false, null]);
    assert.ok(items.every((i) => !("replay" in i)), "no replay bytes in the list");
    assert.equal((await il.list({ limit: 2 })).items.length, 2);
    assert.deepEqual(await filesOf(f.root), before, "nothing in Interlude's folder changed");
    JSON.stringify(items);
});

test("the list's accuracies are worked out once a play and ruleset, again for another ruleset", async (t) => {
    const f = await fixture(t);
    let read = 0;
    const library = { ...f.library, replay: async (...args) => { read += 1; return f.library.replay(...args); } };
    const il = createIlReplays({ interlude: { ...f.interlude, library } });
    await il.list();
    const first = read;
    assert.ok(first >= 6);
    await il.list();
    assert.equal(read, first, "the same plays by the same ruleset: nothing read again");
    await writeFile(path.join(f.root, "Data", "options.json"), JSON.stringify({ SelectedRuleset: "osu-od10" }));
    const again = await il.list();
    assert.ok(read > first);
    assert.equal(again.items[0].accuracy, f.expected(DAY + 5000, OD10).accuracy);
});

test("the library failing for a moment is not kept as a broken replay: the list says so, and the next one judges the play", async (t) => {
    const f = await fixture(t);
    const logs = [];
    const busy = { replay: 1, chart: 0 };
    const once = (name) => async (...args) => {
        if (busy[name] > 0) {
            busy[name] -= 1;
            throw new Error("database is locked");
        }
        return f.library[name](...args);
    };
    const library = { ...f.library, replay: once("replay"), chart: once("chart") };
    const il = createIlReplays({ interlude: { ...f.interlude, library }, log: (m) => logs.push(m) });
    assert.deepEqual(await il.list(), { interlude: { linked: true, ok: false, reason: "dbFailed" }, items: [] });
    assert.ok(logs.some((m) => /database is locked/.test(m)));
    const { interlude, items } = await il.list();
    assert.equal(interlude.ok, true);
    assert.deepEqual([items[0].reason, items[0].accuracy], [null, f.expected(DAY + 5000, OD8).accuracy], "the play judged once the library reads again");
    // the same with charts.db busy, for a ruleset not judged by yet
    busy.chart = 1;
    await writeFile(path.join(f.root, "Data", "options.json"), JSON.stringify({ SelectedRuleset: "osu-od10" }));
    assert.equal((await il.list()).interlude.reason, "dbFailed");
    const again = (await il.list()).items;
    assert.deepEqual([again[0].reason, again[0].accuracy], [null, f.expected(DAY + 5000, OD10).accuracy]);
    assert.deepEqual(again.slice(4, 6).map((i) => i.reason), ["badReplay", "keys"], "a damaged replay is still one");
});

test("a rate stored as a float32 is given as the decimal it stands for, the same in the list, an open play and its earlier plays", async (t) => {
    assert.deepEqual([1.100000023841858, 1.2999999523162842, 0.8999999761581421, 1, 1.125, Math.fround(1.05)].map(rateShown), [1.1, 1.3, 0.9, 1, 1.125, 1.05]);
    const f = await fixture(t);
    t.after(() => rm(path.join(f.root, "..", `${path.basename(f.root)}-user`), { recursive: true, force: true }));
    // two more plays of the chart at ×1.3, as Interlude stores it
    const db = new DatabaseSync(path.join(f.root, "Data", "scores.db"));
    const insert = db.prepare("INSERT INTO scores (ChartId, Timestamp, Replay, Rate, Mods, IsImported, Keys, IsFailed) VALUES (?, ?, ?, ?, '{}', 0, 4, 0)");
    for (const at of [DAY + 7000, DAY + 6500]) insert.run(f.hash, at, blobOf(f.honest, f.first), Math.fround(1.3));
    db.close();
    const s = service(f);
    const listed = await s.list({ titles: false });
    assert.deepEqual(listed.items.slice(0, 2).map((i) => [i.at, i.rate]), [[DAY + 7000, 1.3], [DAY + 6500, 1.3]]);
    const opened = await s.open({ play: f.play(DAY + 7000) });
    assert.equal(opened.replay.rate, 1.3);
    const earlier = await s.earlier({ id: opened.id });
    const same = earlier.plays.filter((p) => p.rate === opened.replay.rate);
    assert.deepEqual(same.map((p) => p.at), [DAY + 6500], "the earlier play at the same rate compares equal with the open one");
    assert.ok(earlier.plays.every((p) => String(p.rate).length <= 4), "no float32 tails in the earlier plays");
});

test("opening a play: the chart as played, presses, the analysis by the chosen ruleset, the rulesets to switch to", async (t) => {
    const f = await fixture(t);
    const il = createIlReplays({ interlude: f.interlude });
    const { answer, state } = await il.open({ play: f.play(DAY + 5000) });
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.replay, {
        source: "interlude", play: f.play(DAY + 5000), chart: f.hash, at: DAY + 5000, rate: 1, modNames: [], failed: false,
        counts: { ...answer.analysis.counts, accuracy: answer.analysis.accuracy }, maxCombo: answer.analysis.combo.max,
        player: null, md5: null, score: null, file: null,
    });
    assert.deepEqual([answer.map.title, answer.map.artist, answer.map.version, answer.map.keys, answer.map.audio], ["Roll Of Plays", "Synth", "4K Roll", 4, true]);
    assert.deepEqual(answer.map.notes, f.notes, "the notes at their own times in ms of the chart");
    assert.equal(answer.presses.length, 4);
    assert.equal(answer.presses[0][0].t, f.honest[0].t);
    assert.equal(answer.reason, null);
    const expected = f.expected(DAY + 5000, OD8);
    assert.deepEqual([answer.analysis.source, answer.analysis.accuracy, answer.analysis.counts], ["interlude", expected.accuracy, expected.counts]);
    assert.ok(answer.analysis.parts.length >= 1, "the parts of the chart");
    assert.deepEqual(answer.ruleset, { id: "osu-od8", name: OD8.name, fallback: false });
    assert.deepEqual(answer.rulesets.map((r) => r.id).sort(), ["osu-od10", "osu-od8"], "the file that is no ruleset is not offered");
    assert.ok(answer.lastMs > f.notes.at(-1).t);
    assert.equal(state.text.includes("[HitObjects]"), true, "the .osu the details are worked out from");
    JSON.stringify(answer);

    const other = (await il.open({ play: f.play(DAY + 5000), ruleset: "osu-od10" })).answer;
    assert.deepEqual([other.ruleset.id, other.analysis.accuracy], ["osu-od10", f.expected(DAY + 5000, OD10).accuracy], "judged again by another ruleset");
    const mirror = (await il.open({ play: f.play(DAY + 4000) })).answer;
    assert.deepEqual(mirror.map.notes.map((n) => n.col), f.notes.map((n) => 3 - n.col), "mirrored as played");
    assert.deepEqual([mirror.replay.modNames, mirror.replay.rate], [["MR"], 1.1], "the rate stored as a float32 given as the decimal it stands for");
    const failed = (await il.open({ play: f.play(DAY + 3000) })).answer;
    assert.equal(failed.replay.failed, true);
    assert.equal(failed.analysis.failed, true);
    assert.ok(failed.analysis.played < failed.analysis.notes);
});

test("a ruleset that cannot be read: SC J4 built in, and the answer says so", async (t) => {
    const f = await fixture(t, { options: { SelectedRuleset: "broken" } });
    const il = createIlReplays({ interlude: f.interlude });
    const { answer } = await il.open({ play: f.play(DAY + 5000) });
    assert.deepEqual(answer.ruleset, { id: BUILTIN_RULESET, name: SC_J4.name, fallback: true });
    assert.equal(answer.analysis.accuracy, f.expected(DAY + 5000, SC_J4).accuracy);
    assert.equal((await il.open({ play: f.play(DAY + 5000), ruleset: "..\\..\\Data\\options" })).answer.ruleset.fallback, true, "no ruleset from outside the folder");
    assert.equal((await il.list()).items[0].accuracy, f.expected(DAY + 5000, SC_J4).accuracy);
    assert.ok(f.logs.some((m) => /ruleset broken not used/.test(m)));
    // no options.json (Interlude never closed yet): its default, SC J4, with no word of a fallback
    await rm(path.join(f.root, "Data", "options.json"));
    assert.deepEqual((await il.open({ play: f.play(DAY + 5000) })).answer.ruleset, { id: BUILTIN_RULESET, name: SC_J4.name, fallback: false });
});

test("while Interlude runs, the ruleset it judged its last play by comes before options.json, written only as it closes", async (t) => {
    const f = await fixture(t);
    let live = OD10.name;
    const c = clockAt(DAY + 60_000);
    const il = createIlReplays({ interlude: f.interlude, liveRuleset: () => live, now: c.now, sleep: c.sleep });
    assert.equal((await il.list()).items[0].accuracy, f.expected(DAY + 5000, OD10).accuracy, "the list by the one Interlude judges by");
    const opened = (await il.open({ play: f.play(DAY + 5000) })).answer;
    assert.deepEqual([opened.ruleset, opened.analysis.accuracy], [{ id: "osu-od10", name: OD10.name, fallback: false }, f.expected(DAY + 5000, OD10).accuracy]);
    assert.equal((await il.open({ play: f.play(DAY + 5000), ruleset: "osu-od8" })).answer.ruleset.id, "osu-od8", "one asked for still wins");
    // a play that just ended: by the ruleset its own lines named, else the last one seen
    saveRow(f, { at: c.now() - 100 });
    const ended = (ruleset) => il.ended({ client: "interlude", chart: f.hash, rate: 1, startedAt: c.now() - 40_000, endedAt: c.now(), outcome: "finished", ruleset });
    const round = (x) => Math.round(x * 100) / 100;
    assert.equal((await ended(OD8.name)).found.accuracy, round(f.expected(DAY + 5000, OD8).accuracy));
    assert.equal((await ended(null)).found.accuracy, round(f.expected(DAY + 5000, OD10).accuracy));
    // a name none of the rulesets has: options.json's
    live = "Some Other Ruleset";
    assert.deepEqual((await il.open({ play: f.play(DAY + 5000) })).answer.ruleset, { id: "osu-od8", name: OD8.name, fallback: false });
    // SC J4 by name with no file of it: Interlude's built-in one, no fallback to speak of
    live = SC_J4.name;
    assert.deepEqual((await il.open({ play: f.play(DAY + 5000) })).answer.ruleset, { id: BUILTIN_RULESET, name: SC_J4.name, fallback: false });
    // not followed, or Interlude closed since: options.json again
    live = null;
    assert.equal((await il.open({ play: f.play(DAY + 5000) })).answer.ruleset.id, "osu-od8");
    assert.equal((await il.list()).items[0].accuracy, f.expected(DAY + 5000, OD8).accuracy);
});

test("a play the library cannot read is refused in words, without paths; scores.db gone is no play, charts.db gone no chart", async (t) => {
    setLang("en");
    const f = await fixture(t);
    const open = (library) => createIlReplays({ interlude: { ...f.interlude, library: { ...f.library, ...library } }, log: () => {} }).open({ play: f.play(DAY + 5000) });
    const throws = (error) => async () => { throw error; };
    // the -wal deleted as Interlude closed, twice over: fs's own message names the player's folders
    const copy = Object.assign(new Error("ENOENT: no such file or directory, copyfile 'X:\\Some\\Interlude\\Data\\scores.db-wal' -> 'Y:\\cache\\scores.db-wal'"), { code: "ENOENT", syscall: "copyfile" });
    const refused = await open({ replay: throws(copy) });
    assert.deepEqual(refused, { answer: { ok: false, message: say("app.interlude.dbFailed", { message: "ENOENT" }) }, state: null });
    assert.doesNotMatch(refused.answer.message, /scores|Some|\\/);
    const noDb = Object.assign(new Error("Data\\scores.db not found"), { code: "NO_DB" });
    assert.equal((await open({ replay: throws(noDb) })).answer.message, say("replay.err.noPlay"));
    assert.equal((await open({ replay: throws(new Error("database is locked")) })).answer.message, say("app.interlude.dbFailed", { message: "database is locked" }));
    const noCharts = await open({ chart: throws(Object.assign(new Error("Songs\\charts.db not found"), { code: "NO_DB" })) });
    assert.deepEqual([noCharts.answer.ok, noCharts.answer.reason, noCharts.state], [true, "nochart", null]);
    assert.equal((await open({ osuFor: throws(copy) })).answer.message, say("app.interlude.dbFailed", { message: "ENOENT" }));
});

test("what a play cannot give is said: its chart gone, mods not followed, a damaged replay, not 4K", async (t) => {
    const f = await fixture(t);
    const il = createIlReplays({ interlude: f.interlude });
    const open = async (at) => (await il.open({ play: f.play(at) })).answer;
    const shuffled = await open(DAY + 2000);
    assert.deepEqual([shuffled.ok, shuffled.reason, shuffled.mods, shuffled.analysis], [true, "mods", ["SHF"], null]);
    assert.equal(shuffled.map.notes.length, 60, "the chart is still shown");
    assert.deepEqual([(await open(DAY + 1000)).reason, (await open(DAY + 500)).reason], ["badReplay", "keys"]);
    const gone = await il.open({ play: playIdOf("AB".repeat(32), DAY + 100) });
    assert.deepEqual([gone.answer.reason, gone.answer.map, gone.answer.analysis, gone.state], ["nochart", null, null, null]);
    assert.equal((await il.open({ play: f.play(DAY + 1234) })).answer.ok, false, "no such play");
    assert.equal((await il.open({ play: "C:\\x.osr" })).answer.ok, false);
});

test("no Interlude, an unlinked one or a folder gone: no plays, no error, and why", async (t) => {
    assert.deepEqual(await createIlReplays().list(), { interlude: { linked: false, ok: false, reason: "unlinked" }, items: [] });
    assert.equal((await createIlReplays().open({ play: "interlude:AB:1" })).answer.ok, false);
    const f = await fixture(t);
    const il = createIlReplays({ interlude: f.interlude });
    f.setFolder(null);
    assert.deepEqual(await il.list(), { interlude: { linked: false, ok: false, reason: "unlinked" }, items: [] });
    f.setFolder(path.join(f.root, "gone"));
    assert.deepEqual(await il.list(), { interlude: { linked: true, ok: false, reason: "missing" }, items: [] });
    // a folder whose scores.db cannot be read
    f.setFolder(f.root);
    await writeFile(path.join(f.root, "Data", "scores.db"), "not a database");
    await rm(path.join(f.root, "Data", "scores.db-wal"), { force: true });
    f.library.forget();
    assert.deepEqual(await il.list(), { interlude: { linked: true, ok: false, reason: "dbFailed" }, items: [] });
    // nothing played yet: no scores.db
    await rm(path.join(f.root, "Data", "scores.db"));
    assert.deepEqual(await il.list(), { interlude: { linked: true, ok: true, reason: null }, items: [] });
});

test("Interlude turned off in ⚙ Settings: no plays listed, none opened, nothing told after a play; on again, all of it back", async (t) => {
    setLang("en");
    t.after(() => setLang("ru"));
    const f = await fixture(t);
    const docs = path.join(f.root, "..", `${path.basename(f.root)}-docs`);
    t.after(() => rm(docs, { recursive: true, force: true }));
    let saved = { folder: null };
    const interlude = createInterludeClient({ store: { get: async () => saved, set: async (x) => { saved = x; } }, docsDir: docs, mapsDir: docs, cacheDir: path.join(docs, "cache") });
    await interlude.link(f.root);
    const sent = [];
    const s = service(f, { interlude, send: (channel, payload) => sent.push([channel, payload]) });
    t.after(() => rm(path.join(f.root, "..", `${path.basename(f.root)}-user`), { recursive: true, force: true }));
    assert.equal((await s.list({ titles: false })).items.length, 7);

    await interlude.setLiveSettings({ enabled: false });
    const listed = await s.list({ titles: false });
    assert.deepEqual([listed.items, listed.interlude], [[], { linked: false, ok: false, reason: "off" }]);
    const opened = await s.open({ play: f.play(DAY + 5000) });
    assert.deepEqual([opened.ok, opened.message], [false, "Interlude is turned off (⚙ Settings → Interlude)."]);
    const c = clockAt(DAY + 60_000);
    const il = createIlReplays({ interlude, now: c.now, sleep: c.sleep });
    const play = { client: "interlude", chart: f.hash, rate: 1, startedAt: c.now() - 40_000, endedAt: c.now(), outcome: "finished" };
    assert.equal(await il.ended(play), null, "no Interlude play is waited for");
    assert.equal(await s.playEnded(play), null);
    assert.deepEqual(sent.filter(([channel]) => channel === "replay-ended"), [], "the tab is told nothing");

    await interlude.setLiveSettings({ enabled: true });
    assert.equal((await s.list({ titles: false })).items.length, 7);
    assert.equal((await s.open({ play: f.play(DAY + 5000) })).ok, true);
    // turned off while a play's row is waited for: the wait ends with nothing
    c.later(1_000, () => interlude.setLiveSettings({ enabled: false }));
    const from = c.now();
    assert.equal(await il.ended({ ...play, startedAt: from - 40_000 }), null);
    assert.ok(c.now() - from < 2_000);
    // turned off after the window was told the row is on its way: the wait is closed, so the note does not stay
    await interlude.setLiveSettings({ enabled: true });
    c.later(5_000, () => interlude.setLiveSettings({ enabled: false }));
    let noted = 0;
    const later = c.now();
    assert.deepEqual(await il.ended({ ...play, startedAt: later - 40_000 }, { waiting: () => { noted += 1; } }), { reason: "off" });
    assert.equal(noted, 1);
    assert.ok(c.now() - later < 7_000);
    // and not when a newer play ended meanwhile (that one has the tab)
    await interlude.setLiveSettings({ enabled: true });
    c.later(5_000, () => interlude.setLiveSettings({ enabled: false }));
    let wanted = true;
    c.later(4_500, () => { wanted = false; });
    assert.equal(await il.ended({ ...play, startedAt: c.now() - 40_000 }, { waiting: () => {}, stillWanted: async () => wanted }), null);
    // the folder unlinked after the window was told: the wait is closed too, as a folder that cannot be read
    await c.sleep(1_000); // the switch left over from the step above
    await interlude.setLiveSettings({ enabled: true });
    c.later(5_000, () => interlude.unlink());
    noted = 0;
    const unlinked = c.now();
    assert.deepEqual(await il.ended({ ...play, startedAt: unlinked - 40_000 }, { waiting: () => { noted += 1; } }), { reason: "noFolder" });
    assert.equal(noted, 1);
    assert.ok(c.now() - unlinked < 7_000);
});

// The service (app/replayIpc.js) with no osu! folder at all and Interlude linked.
function service(f, over = {}) {
    return createReplayService({
        userData: path.join(f.root, "..", `${path.basename(f.root)}-user`), env: {}, interlude: f.interlude,
        tosu: async () => ({ game: null, songs: null, skin: null }), association: async () => null, ...over,
    });
}

test("the tab's calls for an Interlude play: list, open, audio, details, earlier plays, no lean", async (t) => {
    const f = await fixture(t);
    t.after(() => rm(path.join(f.root, "..", `${path.basename(f.root)}-user`), { recursive: true, force: true }));
    const s = service(f);
    const listed = await s.list({ titles: false });
    assert.deepEqual([listed.ok, listed.folder, listed.interlude.ok, listed.items.length], [true, null, true, 7], "Interlude's plays with no osu! folder");
    const opened = await s.open({ play: f.play(DAY + 5000) });
    assert.equal(opened.ok, true);
    assert.equal(typeof opened.id, "number");
    const audio = await s.audio({ id: opened.id });
    assert.deepEqual([audio.ok, audio.id, Buffer.compare(audio.data, AUDIO)], [true, opened.id, 0]);
    assert.equal((await s.audio({ id: opened.id + 1 })).stale, true);
    const details = await s.details({ id: opened.id });
    assert.deepEqual(details, { ok: true, id: opened.id, families: [], spanMs: 0, dans: [] });
    assert.deepEqual(await s.bias({ id: opened.id }), { ok: true, id: opened.id, plays: [], position: null });
    const earlier = await s.earlier({ id: opened.id, fingers: ["L3", "L2", "R2", "R3"] });
    assert.equal(earlier.ok, true);
    assert.equal(earlier.total, 5, "every earlier play of the chart, the one without a chart not");
    assert.deepEqual(earlier.plays.map((p) => p.at), [DAY + 4000, DAY + 3000], "those that can be judged, newest first");
    const [mirror, failed] = earlier.plays;
    const expected = f.expected(DAY + 4000, OD8, { mods: { mirror: 0 }, rate: Math.fround(1.1) });
    assert.deepEqual(
        { ...mirror, manip: null, pairs: null, ur: null },
        { at: DAY + 4000, rate: 1.1, modNames: ["MR"], failed: false, accuracy: expected.accuracy, misses: expected.counts.miss, maxCombo: expected.combo.max, ur: null, manip: null, pairs: null, whole: true, exact: true },
    );
    assert.deepEqual([failed.failed, failed.whole], [true, false]);
    // judged by the ruleset the open play is judged by
    const od10 = await s.open({ play: f.play(DAY + 5000), ruleset: "osu-od10" });
    const again = await s.earlier({ id: od10.id });
    assert.equal(again.plays[0].accuracy, f.expected(DAY + 4000, OD10, { mods: { mirror: 0 }, rate: Math.fround(1.1) }).accuracy);
    assert.equal((await s.earlier({ id: opened.id })).stale, true, "the play opened before is no longer open");
    // a play with a reason: no analysis, so nothing more to ask
    const shuffled = await s.open({ play: f.play(DAY + 2000) });
    assert.equal(shuffled.reason, "mods");
    assert.equal((await s.earlier({ id: shuffled.id })).stale, true);
    assert.equal((await s.audio({ id: shuffled.id })).ok, true, "its chart still plays");
    assert.equal((await s.open({ play: f.play(DAY + 1) })).ok, false);
});

test("an Interlude play refused leaves the replay on screen open, as a refused .osr does", async (t) => {
    const f = await fixture(t);
    t.after(() => rm(path.join(f.root, "..", `${path.basename(f.root)}-user`), { recursive: true, force: true }));
    const s = service(f);
    const opened = await s.open({ play: f.play(DAY + 5000) });
    assert.equal(opened.ok, true);
    const stillOpen = async (said) => {
        assert.equal((await s.audio({ id: opened.id })).ok, true, `${said}: its audio`);
        assert.equal((await s.earlier({ id: opened.id })).ok, true, `${said}: its earlier plays`);
    };
    assert.equal((await s.open({ play: f.play(DAY + 1234) })).ok, false, "a play gone from scores.db since the list was read");
    await stillOpen("a play gone");
    assert.equal((await s.open({ play: "interlude:nothing" })).ok, false);
    await stillOpen("no play id");
    f.setFolder(path.join(f.root, "gone"));
    assert.equal((await s.open({ play: f.play(DAY + 4000) })).ok, false, "the folder gone");
    f.setFolder(f.root);
    await stillOpen("the folder gone");
    assert.equal((await s.open({ file: path.join(f.root, "x.txt") })).ok, false);
    await stillOpen("not an .osr");
    // one opened takes its place
    const next = await s.open({ play: f.play(DAY + 4000) });
    assert.equal((await s.audio({ id: opened.id })).stale, true);
    assert.equal((await s.audio({ id: next.id })).ok, true);
    // two at once: the newer one is open, whichever answers first; the older comes back stale
    const [a, b] = await Promise.all([s.open({ play: f.play(DAY + 5000) }), s.open({ play: f.play(DAY + 4000) })]);
    assert.deepEqual([a, (await s.audio({ id: b.id })).ok], [{ ok: false, stale: true }, true]);
});

test("the shared details reach an Interlude play from its .osu and rate", async (t) => {
    const f = await fixture(t);
    t.after(() => rm(path.join(f.root, "..", `${path.basename(f.root)}-user`), { recursive: true, force: true }));
    const asked = [];
    const analysis = { enqueue: async (fn) => fn() };
    const worker = {
        details: async (text, rate) => {
            asked.push(["details", text.includes("Roll Of Plays"), rate]);
            return { details: { v: 2, durationSec: 9, strain: [], families: ["roll", null], flavourBins: [] } };
        },
        sections: async (text, rate) => {
            asked.push(["sections", text.includes("Roll Of Plays"), rate]);
            return { sections: { v: 1, parts: [{ dan: 3 }], top: 0 } };
        },
    };
    const s = service(f, { analysis, worker });
    const opened = await s.open({ play: f.play(DAY + 4000) });
    const details = await s.details({ id: opened.id });
    assert.deepEqual(asked, [["details", true, Math.fround(1.1)], ["sections", true, Math.fround(1.1)]]);
    assert.deepEqual([details.families, details.dans], [["roll", null], [3]]);
});

test("a Data\\Rulesets folder is read too", async (t) => {
    const f = await fixture(t, { rulesetDir: path.join("Data", "Rulesets") });
    const { answer } = await createIlReplays({ interlude: f.interlude }).open({ play: f.play(DAY + 5000) });
    assert.deepEqual(answer.ruleset, { id: "osu-od8", name: OD8.name, fallback: false });
});

// ---- after a play in Interlude: its new row of scores.db ----

// A pretend clock for the wait: sleep moves it and runs, once, what was asked for by then.
function clockAt(start) {
    let clock = start;
    const timed = [];
    return {
        now: () => clock,
        later: (ms, step) => timed.push({ at: clock + ms, step }),
        sleep: async (ms) => {
            clock += ms;
            for (const item of timed.filter((x) => clock >= x.at)) {
                timed.splice(timed.indexOf(item), 1);
                await item.step();
            }
        },
    };
}
// Interlude saving a play, as it does when one ends
function saveRow(f, { chart = f.hash, at, replay = blobOf(f.honest, f.first), failed = false }) {
    const db = new DatabaseSync(path.join(f.root, "Data", "scores.db"));
    db.prepare("INSERT INTO scores (ChartId, Timestamp, Replay, Rate, Mods, IsImported, Keys, IsFailed) VALUES (?, ?, ?, 1, '{}', 0, 4, ?)")
        .run(chart, at, replay, failed ? 1 : 0);
    db.close();
}
// the wait as the service runs it, with the plays read counted
function waiter(f, { start = DAY + 60_000 } = {}) {
    const c = clockAt(start);
    const reads = [];
    const library = { ...f.library, replays: async (q) => { reads.push(q); return f.library.replays(q); } };
    const il = createIlReplays({ interlude: { ...f.interlude, library }, now: c.now, sleep: c.sleep });
    const play = (over = {}) => ({ client: "interlude", chart: f.hash, rate: 1, startedAt: c.now() - 40_000, endedAt: c.now(), outcome: "finished", ...over });
    return { ...c, il, reads, play };
}

test("after a play: its row is taken when Interlude saves it, judged by the chosen ruleset; scores.db is read again only when it changed", async (t) => {
    const f = await fixture(t);
    const w = waiter(f);
    let at = null;
    w.later(2_000, () => {
        at = w.now();
        saveRow(f, { at });
    });
    let noted = 0;
    const play = w.play();
    const r = await w.il.ended(play, { waiting: () => { noted += 1; } });
    assert.deepEqual({ ...r.found, accuracy: null }, {
        play: f.play(at), at, rate: 1, failed: false, accuracy: null, artist: "Synth", title: "Roll Of Plays", version: "4K Roll",
    });
    assert.equal(r.found.accuracy, Math.round(f.expected(DAY + 5000, OD8).accuracy * 100) / 100, "the same presses as the honest play, by osu! OD8");
    assert.equal(w.reads.length, 2, "read once at first, then only once it had changed");
    assert.deepEqual([w.reads[0].chart, w.reads[0].since], [f.hash, play.startedAt - IL_ENDED_SLACK_MS], "the chart's plays saved since the play began");
    assert.equal(noted, 0, "a row that quick needs no note");

    await w.sleep(20_000); // a retry from the score screen, failed this time
    const failedAt = w.now() + 100;
    w.later(100, () => saveRow(f, { at: failedAt, replay: blobOf(f.honest.slice(0, 20), f.first), failed: true }));
    const failed = await w.il.ended(w.play({ startedAt: w.now() - 15_000 }));
    assert.deepEqual([failed.found.play, failed.found.failed], [f.play(failedAt), true]);
});

test("after a play: rows saved before it began or of another chart are not it; a slow one is told once, none ends in 'none'; a quit is not waited for long", async (t) => {
    const f = await fixture(t);
    const w = waiter(f);
    saveRow(f, { at: w.now() - 50_000 }); // a play before this one began
    saveRow(f, { chart: "AB".repeat(32), at: w.now() }); // another chart's
    let noted = 0;
    let from = w.now();
    assert.deepEqual(await w.il.ended(w.play(), { waiting: () => { noted += 1; } }), { reason: "none" });
    assert.ok(w.now() - from >= IL_ENDED_WAIT_MS.finished);
    assert.equal(noted, 1);
    assert.equal(w.reads.length, 1, "scores.db never changed: read once");

    from = w.now();
    noted = 0;
    let at = null;
    w.later(10_000, () => {
        at = w.now();
        saveRow(f, { at });
    });
    assert.equal((await w.il.ended(w.play({ startedAt: from - 1_000 }), { waiting: () => { noted += 1; } })).found.play, f.play(at));
    assert.equal(noted, 1, "told once that it is on its way");

    await w.sleep(5_000); // the next play: begun after that row was saved
    from = w.now();
    assert.deepEqual(await w.il.ended(w.play({ startedAt: from - 1_000, outcome: "quit" }), { waiting: () => { noted += 1; } }), { reason: "none" });
    assert.ok(w.now() - from >= IL_ENDED_WAIT_MS.quit && w.now() - from < IL_ENDED_WAIT_MS.quit + 1_000);
    assert.equal(noted, 1, "a quit gets no note");
});

test("after a play: a score screen before the end (a fail partway, a quit out with 'Save and show score') has its row found in the quit's short wait", async (t) => {
    const f = await fixture(t);
    const w = waiter(f);
    // saved as the play ended, before the score screen opened (so before the end was heard of)
    const at = w.now() - 50;
    saveRow(f, { at, replay: blobOf(f.honest.slice(0, 20), f.first), failed: true });
    let noted = 0;
    const from = w.now();
    const r = await w.il.ended(w.play({ startedAt: from - 20_000, outcome: "quit" }), { waiting: () => { noted += 1; } });
    assert.deepEqual([r.found.play, r.found.failed], [f.play(at), true]);
    assert.ok(w.now() - from < IL_ENDED_WAIT_MS.quit, "found at the first look");
    assert.equal(noted, 0);
});

test("after a play: no longer wanted ends the wait with nothing; no folder says so", async (t) => {
    const f = await fixture(t);
    const w = waiter(f);
    let wanted = true;
    w.later(1_000, () => { wanted = false; });
    const from = w.now();
    assert.equal(await w.il.ended(w.play(), { stillWanted: async () => wanted }), null);
    assert.ok(w.now() - from < 2_000);
    f.setFolder(null);
    assert.deepEqual(await w.il.ended(w.play()), { reason: "noFolder" });
    assert.equal(await w.il.ended(w.play(), { stillWanted: async () => false }), null);
});
