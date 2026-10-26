// osu! stable's scores.db (src/localProfile/scoresDb.js) on a synthetic file made here (tests/fixtures/makeScoresDb.js).
import test from "node:test";
import assert from "node:assert/strict";
import { parseScoresDb, modNames, rateOfMods, mainPlayer, ticksToMs, MOD_BITS } from "../../src/localProfile/scoresDb.js";
import { makeScoresDb } from "../fixtures/makeScoresDb.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const AT = Date.UTC(2026, 9, 20, 18, 30, 15, 123);

test("reads every mania score with its judgements, mods, rate and time; other modes are left out", () => {
    const bytes = makeScoresDb([
        { md5: A, player: "TestPlayer", replayMd5: "c".repeat(32), geki: 900, n300: 300, katu: 50, n100: 10, n50: 2, miss: 3, score: 912345, maxCombo: 777, mods: MOD_BITS.DT | MOD_BITS.NC, at: AT, onlineId: 4242 },
        { md5: A, player: "TestPlayer", mode: 0, n300: 100, at: AT },
        { md5: B.toUpperCase(), player: "Someone", n300: 10, mods: MOD_BITS.HT | MOD_BITS.TP, tpInfo: 1.5, at: AT + 1000 },
        { md5: B, player: "TestPlayer", n300: 5, mods: MOD_BITS.MR | MOD_BITS.NF, at: AT + 2000, perfect: true },
    ]);
    const db = parseScoresDb(bytes);
    assert.equal(db.version, 20240101);
    assert.equal(db.beatmaps, 3);
    assert.equal(db.scores.length, 3, "the osu!standard score is left out");
    const [first, other, last] = db.scores;
    assert.equal(first.md5, A);
    assert.equal(first.player, "TestPlayer");
    assert.equal(first.replayMd5, "c".repeat(32));
    assert.deepEqual(first.hits, { max: 900, n300: 300, n200: 50, n100: 10, n50: 2, miss: 3 });
    assert.equal(first.score, 912345);
    assert.equal(first.maxCombo, 777);
    assert.deepEqual(first.modNames, ["NC"]);
    assert.equal(first.rate, 1.5);
    assert.equal(first.at, AT);
    assert.equal(first.onlineId, "4242");
    // Target Practice brings one more double; md5 comes lower-case
    assert.equal(other.md5, B);
    assert.deepEqual(other.modNames, ["HT", "TP"]);
    assert.equal(other.rate, 0.75);
    assert.deepEqual(last.modNames, ["NF", "MR"]);
    assert.equal(last.perfect, true);
    assert.equal(last.onlineId, null);
    assert.equal(parseScoresDb(bytes, { mode: null }).scores.length, 4);
});

test("mods, rates and times", () => {
    assert.deepEqual(modNames(MOD_BITS.DT | MOD_BITS.HD), ["HD", "DT"]);
    assert.deepEqual(modNames(MOD_BITS.SD | MOD_BITS.PF), ["PF"]);
    assert.equal(rateOfMods(["HT"]), 0.75);
    assert.equal(rateOfMods(["MR"]), 1);
    assert.equal(ticksToMs(621355968000000000n), 0);
});

test("a cut or broken file throws instead of reading garbage; an empty one has no scores", () => {
    const bytes = makeScoresDb([{ md5: A, n300: 1, at: AT }]);
    assert.throws(() => parseScoresDb(bytes.subarray(0, bytes.length - 5)), /ends too early/);
    const bad = Buffer.from(bytes);
    bad[8] = 0x07; // the beatmap md5's string flag
    assert.throws(() => parseScoresDb(bad), /bad string/);
    assert.deepEqual(parseScoresDb(makeScoresDb([])).scores, []);
});

test("the main player: the logged-in one when they have scores, else the one with the most", () => {
    const scores = [{ player: "TestPlayer" }, { player: "TestPlayer" }, { player: "Friend" }];
    assert.equal(mainPlayer(scores), "TestPlayer");
    assert.equal(mainPlayer(scores, "friend"), "Friend");
    assert.equal(mainPlayer(scores, "nobody"), "TestPlayer");
    assert.equal(mainPlayer([]), null);
});
