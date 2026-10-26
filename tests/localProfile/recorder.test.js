// Plays from a sequence of tosu /websocket/v2 frames (src/localProfile/recorder.js): a pass ends on the results
// screen, a quit and a fail when gameplay is left, a retry ends the try before it; results opened from song select,
// someone else's play and a play with almost no notes are not recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { createPlayRecorder, readRecordFrame, LEAVE_MS } from "../../src/localProfile/recorder.js";

const MD5 = "d41d8cd98f00b204e9800998ecf8427e";
const hits = (geki, h300 = 0, katu = 0, h100 = 0, h50 = 0, miss = 0) => ({ geki, 300: h300, katu, 100: h100, 50: h50, 0: miss });
const frame = (state, { h = hits(0), client = "stable", mods = { name: "", array: [] }, results = null, health = 100, player = "TestPlayer", checksum = MD5, combo = 0 } = {}) => ({
    client, state: { number: state },
    profile: { name: "TestPlayer" },
    beatmap: { checksum, id: 123, set: 45, artist: "Artist", title: "Song", version: "4K Hard", mode: { number: 3 }, time: { live: 1000 } },
    play: { playerName: player, mode: { number: 3 }, mods, hits: h, combo: { max: combo }, healthBar: { normal: health }, accuracy: 97 },
    ...(results ? { resultsScreen: results } : {}),
});
const PLAYING = 2;
const SELECT = 5;
const RESULTS = 7;

function run(frames) {
    const plays = [];
    const r = createPlayRecorder({ onPlay: (p) => plays.push(p) });
    let now = 0;
    for (const [f, dt = 100] of frames) {
        now += dt;
        r.onJson(f, now);
    }
    return { plays, recorder: r, now };
}

test("a pass: gameplay, then the results screen → one play with its judgements, rate, mods and map", () => {
    const dt = { name: "DT", array: [{ acronym: "DT" }] };
    const { plays } = run([
        [frame(SELECT)],
        [frame(PLAYING, { h: hits(10), mods: dt })],
        [frame(PLAYING, { h: hits(300, 40, 10, 2, 0, 1), mods: dt, combo: 250 })],
        [frame(RESULTS, { h: hits(300, 40, 10, 2, 0, 1), mods: dt, combo: 250 })],
        [frame(RESULTS, { h: hits(300, 40, 10, 2, 0, 1), mods: dt })],
        [frame(SELECT)],
    ]);
    assert.equal(plays.length, 1);
    const p = plays[0];
    assert.equal(p.outcome, "pass");
    assert.equal(p.md5, MD5);
    assert.deepEqual(p.hits, { max: 300, n300: 40, n200: 10, n100: 2, n50: 0, miss: 1 });
    assert.equal(p.rate, 1.5);
    assert.deepEqual(p.mods, ["DT"]);
    assert.equal(p.maxCombo, 250);
    assert.equal(p.client, "stable");
    assert.deepEqual([p.beatmapId, p.beatmapsetId, p.artist, p.title, p.version], [123, 45, "Artist", "Song", "4K Hard"]);
    // stable accuracy: (300·340 + 200·10 + 100·2) / (300·353)
    assert.equal(p.accuracy, Math.round(((300 * 340 + 200 * 10 + 100 * 2) / (300 * 353)) * 1e6) / 1e6);
    assert.ok(p.at > p.startedAt);
});

test("lazer: the play is reset on the results screen and the score shown there has the numbers", () => {
    const rate = { name: "DT", array: [{ acronym: "DT", settings: { speed_change: 1.2 } }], rate: 1.2 };
    const { plays } = run([
        [frame(PLAYING, { client: "lazer", h: hits(200, 20), mods: rate })],
        [frame(RESULTS, { client: "lazer", h: hits(0), mods: rate, results: { hits: hits(512, 41, 11, 3, 1, 2), mods: rate, maxCombo: 400 } })],
    ]);
    assert.equal(plays.length, 1);
    assert.equal(plays[0].client, "lazer");
    assert.equal(plays[0].rate, 1.2);
    assert.deepEqual(plays[0].hits, { max: 512, n300: 41, n200: 11, n100: 3, n50: 1, miss: 2 });
    assert.equal(plays[0].maxCombo, 400);
});

test("leaving gameplay: a quit, or a fail with an empty health bar; one odd frame does not end the play", () => {
    const quit = run([
        [frame(PLAYING, { h: hits(100) })],
        [frame(SELECT), 100], // one stray frame
        [frame(PLAYING, { h: hits(150) }), 100],
        [frame(SELECT), 100],
        [frame(SELECT), LEAVE_MS],
    ]);
    assert.deepEqual(quit.plays.map((p) => [p.outcome, p.hits.max]), [["quit", 150]]);
    const fail = run([
        [frame(PLAYING, { h: hits(100) })],
        [frame(PLAYING, { h: hits(120, 0, 0, 0, 0, 30), health: 0 })],
        [frame(SELECT)],
        [frame(SELECT), LEAVE_MS],
    ]);
    assert.deepEqual(fail.plays.map((p) => p.outcome), ["fail"]);
});

test("a retry ends the try before it; another map ends the play too", () => {
    const { plays } = run([
        [frame(PLAYING, { h: hits(200) })],
        [frame(PLAYING, { h: hits(3) })], // retry: the counts start over
        [frame(PLAYING, { h: hits(250) })],
        [frame(RESULTS, { h: hits(250) })],
    ]);
    assert.deepEqual(plays.map((p) => [p.outcome, p.hits.max]), [["quit", 200], ["pass", 250]]);
    const other = run([
        [frame(PLAYING, { h: hits(200) })],
        [frame(PLAYING, { h: hits(5), checksum: "f".repeat(32) })],
        [frame(RESULTS, { h: hits(300), checksum: "f".repeat(32) })],
    ]);
    assert.deepEqual(other.plays.map((p) => [p.outcome, p.md5[0]]), [["quit", "d"], ["pass", "f"]]);
});

test("not recorded: results opened from song select, someone else's play, a play of a few notes", () => {
    assert.equal(run([[frame(SELECT)], [frame(RESULTS, { h: hits(500) })], [frame(SELECT)]]).plays.length, 0);
    assert.equal(run([[frame(PLAYING, { h: hits(300), player: "Someone" })], [frame(RESULTS, { h: hits(300), player: "Someone" })]]).plays.length, 0);
    assert.equal(run([[frame(PLAYING, { h: hits(5) })], [frame(RESULTS, { h: hits(5) })]]).plays.length, 0);
    // osu! standard (mode 0) is no mania play
    const std = frame(PLAYING, { h: hits(300) });
    std.play.mode.number = 0;
    std.beatmap.mode.number = 0;
    assert.equal(run([[std], [frame(RESULTS, { h: hits(300) })]]).plays.length, 0);
});

test("tosu going down ends a play as a quit", () => {
    const { plays, recorder, now } = run([[frame(PLAYING, { h: hits(300) })]]);
    assert.equal(recorder.playing(), true);
    recorder.onDown(now + 10);
    assert.deepEqual(plays.map((p) => p.outcome), ["quit"]);
});

test("readRecordFrame: the extras the overlay does not read", () => {
    const f = readRecordFrame(frame(PLAYING, { h: hits(1), health: 42, combo: 9, player: "someone" }));
    assert.equal(f.health, 42);
    assert.equal(f.maxCombo, 9);
    assert.equal(f.foreign, true);
    assert.deepEqual(readRecordFrame({ play: { mods: { name: "HDDT" } } }).mods, ["HD", "DT"]);
});
