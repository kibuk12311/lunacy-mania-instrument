// Plays judged below OD 7 and the update of a saved profile. The model leaves a pass on a map below MODEL.MIN_OD, or with
// EZ, out of every dan (the play kept, counted and listed; OD 7 counts, HR is read by its tighter windows, an unknown OD
// counts, Interlude's plays count), the store keeps the OD beside the map, and a profile an older version saved updates
// by itself: the pass over the kept maps gives them their OD, the skill is rebuilt, no play is lost, it runs once, a
// backup goes the same way. Fake player only: TestPlayer, id 1234567.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL, performanceDan, leftOutWhy, isLowOdMap, accuracyAdjust, osuOverallDifficulty, namedOverallDifficulty, skillFromPlays, createSkillModel, dailySkill } from "../../src/localProfile/model.js";
import { createLocalProfileStore, mapSummary, mapKeyOf, normalizePlay } from "../../app/localProfileStore.js";
import { createLocalProfileService, withMapFacts } from "../../app/localProfileService.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { VIBRO } from "../../src/vibro/detect.js";
import { dumpLazer, lazerOdSet } from "../../src/lazer/realmDump.js";
import { createPlayRecorder, readRecordFrame } from "../../src/localProfile/recorder.js";
import { chartOf, stream, jack, chordjack } from "../fixtures/makeVibroChart.js";
import { readPlayFrame } from "../../src/overlay/tosuData.js";
import { createOverlaySession } from "../../src/overlay/session.js";
import { danView } from "../../src/overlay/dan.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1, 12);
const md5 = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
const tempDir = () => mkdtemp(path.join(tmpdir(), "local-profile-od-"));
const hits = (n200 = 50, total = 1000) => ({ max: total - n200, n300: 0, n200, n100: 0, n50: 0, miss: 0 }); // 96.67%
const summary = (numeric, name = "Chordjacks", extra = {}) => ({ kind: "ok", numeric, label: "x", top3: [{ name, share: 1 }], tech: false, durationSec: 100, calcs: {}, msd: {}, ...extra });
const NOT_VIBRO = { v: VIBRO.VERSION, vibro: false, share: 0, longestRows: 0, peakGapMs: null, confidence: "high" };
const dansOf = (k) => ({ overall: k.overall, tiles: k.tiles, axes: k.axes, patterns: k.patterns });

// twelve maps at OD 8 (dans 12–14.2) and one map of the given od at dan 20
function history(od) {
    const maps = new Map();
    const plays = [];
    for (let i = 0; i < 12; i += 1) {
        const key = `${String(i).padStart(32, "a")}@1.00`;
        maps.set(key, summary(12 + i * 0.2, "Chordjacks", { vibro: NOT_VIBRO, od: 8 }));
        plays.push({ id: `p${i}`, mapKey: key, at: NOW - (20 - i) * DAY, outcome: "pass", hits: hits(), mods: [] });
    }
    const key = `${"f".repeat(32)}@1.00`;
    maps.set(key, summary(20, "Chordjacks", { vibro: NOT_VIBRO, ...(od === undefined ? {} : { od }) }));
    return { maps, plays, key, odPlay: { id: "od", mapKey: key, at: NOW - DAY, outcome: "pass", hits: hits(), mods: [] } };
}

test("model: below OD 7 is in no dan, 7 itself counts, and an unknown OD counts", () => {
    const low = history(6.9);
    const without = skillFromPlays(low.plays, (k) => low.maps.get(k), NOW);
    const withIt = skillFromPlays([...low.plays, low.odPlay], (k) => low.maps.get(k), NOW);
    assert.notEqual(without.overall, null);
    assert.deepEqual(dansOf(withIt), dansOf(without));
    assert.equal(withIt.lowOdPlays, 1);
    assert.equal(withIt.vibroPlays, 0);
    assert.equal(without.lowOdPlays, 0);
    assert.equal(withIt.totalPlays, without.totalPlays + 1);
    assert.equal(withIt.analyzedPlays, without.analyzedPlays);
    assert.equal(performanceDan(low.odPlay, low.maps.get(low.key)), null);
    assert.equal(leftOutWhy(low.odPlay, low.maps.get(low.key)), "lowOd");
    assert.equal(MODEL.MIN_OD, 7);
    for (const od of [7, 7.5, 10, null, undefined]) {
        const h = history(od);
        const k = skillFromPlays([...h.plays, h.odPlay], (x) => h.maps.get(x), NOW);
        assert.equal(k.lowOdPlays, 0, `OD ${od} counts`);
        assert.equal(performanceDan(h.odPlay, h.maps.get(h.key)).mapDan, 20);
        assert.ok(k.axes.jack.dan > without.axes.jack.dan, `OD ${od}`);
    }
    // the history leaves it out too
    const days = dailySkill([...low.plays, low.odPlay], (k) => low.maps.get(k), { to: NOW });
    const daysWithout = dailySkill(low.plays, (k) => low.maps.get(k), { to: NOW });
    assert.equal(days.at(-1).dan, daysWithout.at(-1).dan);
    // one at a time: the same
    const m = createSkillModel();
    for (const p of [low.odPlay, ...low.plays]) m.add(p, low.maps.get(p.mapKey));
    assert.deepEqual(dansOf(m.skill(NOW)), dansOf(without));
    assert.equal(m.lowOd(), 1);
});

test("model: only a pass that would have counted is counted as left out; Interlude's play keeps its dan; a vibro map is said once", () => {
    const { maps, key, odPlay } = history(5);
    const map = maps.get(key);
    assert.equal(leftOutWhy({ ...odPlay, outcome: "fail" }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["AT"] }, map), null);
    assert.equal(leftOutWhy(odPlay, { kind: "too-short", od: 5 }), null);
    // Interlude judges by the player's ruleset, not by the map's OD
    const interlude = { ...odPlay, client: "interlude", hits: null, accuracy: null };
    assert.equal(leftOutWhy(interlude, map), null);
    assert.equal(performanceDan(interlude, map).dan, 19.5);
    assert.equal(leftOutWhy({ ...odPlay, client: "stable" }, map), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, client: "lazer" }, map), "lowOd");
    // both: one reason, one count
    const both = { ...map, vibro: { ...NOT_VIBRO, vibro: true, share: 0.5 } };
    assert.equal(leftOutWhy(odPlay, both), "vibro");
    const k = skillFromPlays([odPlay], () => both, NOW);
    assert.equal(k.vibroPlays + k.lowOdPlays, 1);
    assert.equal(isLowOdMap({ od: 0 }), true);
    assert.equal(isLowOdMap({ od: null }), false);
    assert.equal(isLowOdMap(null), false);
});

test("model: EZ is always below the line, HR is read by its tighter windows, the rate not at all", () => {
    const { maps, key, odPlay } = history(10);
    const map = maps.get(key);
    assert.equal(leftOutWhy(odPlay, map), null);
    // EZ on OD 10 is still looser than OD 7 (47.6 ms against 43), and needs no OD to be known
    assert.equal(leftOutWhy({ ...odPlay, mods: ["EZ"] }, map), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, mods: ["EZ", "DT"] }, { ...map, od: undefined }), "lowOd");
    assert.equal(performanceDan({ ...odPlay, mods: ["EZ"] }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["EZ"], client: "interlude" }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["EZ"], outcome: "fail" }, map), null);
    // HR: on OD 1.27 and up at least as tight as OD 7, below that not
    const hr = { ...odPlay, mods: ["HR"] };
    assert.equal(leftOutWhy(hr, { ...map, od: 5 }), null);
    assert.equal(leftOutWhy(hr, { ...map, od: 1.27 }), null);
    assert.equal(leftOutWhy(hr, { ...map, od: 1.26 }), "lowOd");
    assert.equal(leftOutWhy(hr, { ...map, od: 0 }), "lowOd");
    assert.equal(performanceDan(hr, { ...map, od: 5 }).mapDan, 20);
    // the rate is in the map's dan, not in its windows
    for (const mods of [["DT"], ["NC"], ["HT"]]) {
        assert.equal(leftOutWhy({ ...odPlay, mods }, { ...map, od: 6.9 }), "lowOd");
        assert.equal(leftOutWhy({ ...odPlay, mods }, { ...map, od: 7 }), null);
    }
});

test("model: with no OD kept, the difficulty name decides; the .osu's OD goes first; nothing else in a name is an OD", () => {
    for (const [name, od] of [["OD0", 0], ["od 6.5", 6.5], ["CJ Marathon 1.5x (OD5)", 5], ["HP8 OD 3", 3], ["OD7", 7], ["OD 7.5", 7.5], ["OD10", 10]]) assert.equal(namedOverallDifficulty(name), od, name);
    for (const name of ["Good 3", "Method 5", "OD", "Insane", "ODD 3", "", null, undefined]) assert.equal(namedOverallDifficulty(name), null, String(name));
    const { maps, key, odPlay } = history(undefined);
    const map = maps.get(key);
    assert.equal(leftOutWhy({ ...odPlay, version: "OD0" }, map), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, version: "OD 6.5" }, map), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, version: "OD 7" }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, version: "Insane" }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, version: "OD0" }, { ...map, od: null }), "lowOd", "looked at, the text has none");
    assert.equal(leftOutWhy({ ...odPlay, version: "OD0" }, { ...map, od: 8 }), null);
    assert.equal(leftOutWhy({ ...odPlay, version: "OD8" }, { ...map, od: 5 }), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, version: "OD0", mods: ["HR"] }, map), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, version: "OD3", mods: ["HR"] }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, version: "OD0", client: "interlude" }, map), null);
});

test("model: the OD a play set itself goes before the map's and its name, either way; EZ and HR still read as they do", () => {
    const { maps, key, odPlay } = history(9);
    const map = maps.get(key);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"], odSet: 5 }, map), "lowOd");
    assert.equal(performanceDan({ ...odPlay, mods: ["DA"], odSet: 6.9 }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"], odSet: 7 }, { ...map, od: 0 }), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"], odSet: 8, version: "OD0" }, { ...map, od: undefined }), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"], odSet: 5 }, { ...map, od: undefined }), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"], odSet: 5, client: "interlude" }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA", "EZ"], odSet: 10 }, map), "lowOd");
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA", "HR"], odSet: 5 }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"], odSet: -15 }, map), "lowOd");
    // DA with the OD left alone (only the drain changed, or nothing): the map's stands
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"] }, map), null);
    assert.equal(leftOutWhy({ ...odPlay, mods: ["DA"] }, { ...map, od: 5 }), "lowOd");
});

test("the OD a lazer play set comes from the mod's settings, on the import and live, and is kept with the play", () => {
    assert.equal(lazerOdSet("[{\"acronym\":\"DA\",\"settings\":{\"overall_difficulty\":5.5}}]"), 5.5);
    assert.equal(lazerOdSet("[{\"acronym\":\"DA\",\"settings\":{\"overall_difficulty\":0}}]"), 0);
    assert.equal(lazerOdSet([{ acronym: "da", settings: { overall_difficulty: -3 } }, { acronym: "DT" }]), -3);
    for (const none of ["[{\"acronym\":\"DA\"}]", "[{\"acronym\":\"DA\",\"settings\":{\"drain_rate\":3}}]", "[{\"acronym\":\"DT\",\"settings\":{\"overall_difficulty\":3}}]", "[{\"acronym\":\"DA\",\"settings\":{\"overall_difficulty\":null}}]", "", null, undefined, "nope", "[1]"]) assert.equal(lazerOdSet(none), null, String(none));
    const row = (Mods) => ({ ID: "a", Date: new Date(NOW), Rank: 3, Mods, Statistics: "{\"perfect\":900}", BeatmapHash: "f".repeat(64), Ruleset: { ShortName: "mania" }, User: { Username: "TestPlayer" } });
    const [da, plain] = dumpLazer({ scores: [row("[{\"acronym\":\"DA\",\"settings\":{\"overall_difficulty\":4}}]"), row("")] }).scores;
    assert.deepEqual(da.mods, ["DA"]);
    assert.equal(da.odSet, 4);
    assert.equal("odSet" in plain, false);

    const play = { id: "lazer:a", source: "lazer-db", client: "lazer", md5: "a".repeat(32), rate: 1, mods: ["DA"], outcome: "pass", at: NOW };
    assert.equal(normalizePlay({ ...play, odSet: 4 }).odSet, 4);
    assert.equal(normalizePlay({ ...play, odSet: 0 }).odSet, 0);
    assert.equal("odSet" in normalizePlay(play), false);
    assert.equal("odSet" in normalizePlay({ ...play, odSet: null }), false);
    assert.equal("odSet" in normalizePlay({ ...play, odSet: "4" }), false);

    const frame = (state, mods) => ({ client: "lazer", state: { number: state }, profile: { name: "TestPlayer" }, beatmap: { checksum: "a".repeat(32), mode: { number: 3 } }, play: { playerName: "TestPlayer", mode: { number: 3 }, mods, hits: { geki: 500 } } });
    const DA = { name: "DA", array: [{ acronym: "DA", settings: { overall_difficulty: 4 } }], rate: 1 };
    assert.equal(readRecordFrame(frame(2, DA)).odSet, 4);
    assert.equal(readRecordFrame(frame(2, { name: "DT", rate: 1.5 })).odSet, null);
    const live = [];
    const rec = createPlayRecorder({ onPlay: (p) => live.push(p) });
    rec.onJson(frame(2, DA), 1000);
    // lazer resets the play on the results screen: what the play said stays
    rec.onJson({ ...frame(7, { name: "DA", array: [{ acronym: "DA" }] }), resultsScreen: {} }, 2000);
    assert.equal(live.length, 1);
    assert.equal(live[0].odSet, 4);
    const other = [];
    const rec2 = createPlayRecorder({ onPlay: (p) => other.push(p) });
    rec2.onJson(frame(2, { name: "", rate: 1 }), 1000);
    rec2.onJson(frame(7, { name: "", rate: 1 }), 2000);
    assert.equal("odSet" in other[0], false);
});

test("the Dan widget reads the OD a lazer play set, not the map's: from tosu's frames through the session to «эта игра»", () => {
    const hits = { geki: 900, "300": 50, katu: 10, "100": 0, "50": 0, 0: 0 };
    const frame = (number, mods, extra = {}) => ({ client: "lazer", state: { number }, beatmap: { checksum: "a".repeat(32), mode: { number: 3 }, time: { live: 1000 } }, play: { mode: { number: 3 }, mods, hits }, ...extra });
    const da = (od) => ({ name: "DA", array: [{ acronym: "DA", settings: { overall_difficulty: od } }], rate: 1 });
    const results = { resultsScreen: { hits, mods: da(4) } };
    assert.equal(readPlayFrame(frame(2, da(4))).odSet, 4);
    assert.equal(readPlayFrame(frame(2, { name: "DT", rate: 1.5 })).odSet, null);
    assert.equal(readPlayFrame(frame(7, { name: "", rate: 1 }, results)).odSet, 4, "lazer's results screen has the score's mods");

    const snapshotOf = (...frames) => {
        const session = createOverlaySession({});
        frames.forEach((f, i) => session.onFrame(readPlayFrame(f), i * 100));
        return session.snapshot(frames.length * 100);
    };
    const payload = { state: "ok", numeric: 13, recording: true, checksum: "a".repeat(32) };
    const played = (od, mapOd) => danView({ ...payload, od: mapOd }, { ...snapshotOf(frame(2, da(od)), frame(7, da(od))), phase: "results" });
    const low = played(5, 8);
    assert.equal(low.play, "<OD7", "a map above the line, set below it");
    assert.equal(low.playDan, null);
    const high = played(8, 0);
    assert.notEqual(high.play, "<OD7", "a map below the line, set above it");
    assert.ok(high.playDan > 0);
    const plain = danView({ ...payload, od: 0 }, snapshotOf(frame(2, { name: "", rate: 1 }), frame(7, { name: "", rate: 1 })));
    assert.equal(plain.play, "<OD7", "no Difficulty Adjust: the map's own OD stands");
});

test("model: the floor takes a badly played map down to where it says nothing, and is reached well past the knee", () => {
    assert.equal(MODEL.FLOOR, -6);
    assert.ok(Math.abs(accuracyAdjust(93) - -0.7) < 1e-9);
    assert.ok(Math.abs(accuracyAdjust(80) - -5.25) < 1e-9, "not floored yet");
    assert.equal(accuracyAdjust(77), -6);
    assert.equal(accuracyAdjust(40), -6);
    const hit100 = (acc) => { const n = Math.round((1 - acc) * 1500); return { max: 1000 - n, n300: 0, n200: 0, n100: n, n50: 0, miss: 0 }; };
    assert.equal(performanceDan({ outcome: "pass", hits: hit100(0.6), mods: ["NF"] }, { kind: "ok", numeric: 19 }).dan, 13);
});

// The case that made the fix, made up: a Jack axis far above the level the player plays at. Rate maps with OD 0 in their
// name, played with EZ or not, their .osu long gone; and DT at a low accuracy on very high dans.
const hitsAt = (acc) => { const n = Math.round((1 - acc) * 1500); return { max: 1000 - n, n300: 0, n200: 0, n100: n, n50: 0, miss: 0 }; };
function inflatedProfile() {
    const maps = new Map();
    const plays = [];
    const add = (id, numeric, acc, version, mods, rate = 1) => {
        const key = `${id.padStart(32, "0")}@${rate.toFixed(2)}`;
        maps.set(key, summary(numeric, "Chordjacks", { vibro: NOT_VIBRO }));
        plays.push({
            id: `stable:${id}`, source: "stable-db", client: "stable", md5: id.padStart(32, "0"), rate, mapKey: key, artist: "Test", title: `Map ${id}`, version, mods,
            hits: hitsAt(acc), accuracy: null, maxCombo: 900, outcome: "pass", at: NOW - (plays.length + 2) * DAY,
        });
    };
    for (let i = 0; i < 24; i += 1) add(`a${i}`, 12.4 + i * 0.05, 0.968, "Insane", []);
    for (let i = 0; i < 8; i += 1) add(`b${i}`, 18.5 + i * 0.08, 0.988, "CJ Marathon OD0", i % 2 ? ["EZ"] : []);
    for (let i = 0; i < 4; i += 1) add(`c${i}`, 18.9, 0.988, "Hard", ["EZ"]);
    for (let i = 0; i < 12; i += 1) add(`d${i}`, 18 + i * 0.09, 0.6 + i * 0.022, "Hard", i % 3 ? ["DT"] : ["DT", "NF"], 1.5);
    return { maps, plays };
}

test("the case: OD 0 and EZ out and the floor at −6 bring the Jack axis back; neither does it alone", () => {
    const { maps, plays } = inflatedProfile();
    const get = (k) => maps.get(k);
    const level = skillFromPlays(plays.filter((p) => p.id.startsWith("stable:a")), get, NOW).axes.jack.dan;
    const after = skillFromPlays(plays, get, NOW);
    assert.equal(after.lowOdPlays, 12);
    assert.ok(Math.abs(after.axes.jack.dan - level) < 0.4, `${after.axes.jack.dan} against ${level}`);
    // what 0.10.5 read: no OD, EZ as any mod, the floor at −2.5
    const OLD = { ...MODEL, FLOOR: -2.5 };
    const blind = plays.map((p) => ({ ...p, version: "Hard", mods: p.mods.filter((x) => x !== "EZ") }));
    assert.ok(skillFromPlays(blind, get, NOW, OLD).axes.jack.dan > 17.5);
    assert.ok(skillFromPlays(blind, get, NOW).axes.jack.dan > 17.5, "the floor alone leaves it");
    assert.ok(skillFromPlays(plays, get, NOW, OLD).axes.jack.dan > level + 1.5, "the OD alone leaves the DT passes on top");
});

test("the OD comes from the .osu text", () => {
    assert.equal(osuOverallDifficulty(chartOf(stream(0, 10, 100), { od: 6.5 })), 6.5);
    assert.equal(osuOverallDifficulty("[Difficulty]\nOverallDifficulty: 0\nApproachRate:9\n"), 0);
    assert.equal(osuOverallDifficulty("[Difficulty]\r\n  OverallDifficulty : 7\r\n"), 7);
    assert.equal(osuOverallDifficulty("[Difficulty]\nHPDrainRate:7\n"), null);
    assert.equal(osuOverallDifficulty("[Difficulty]\nOverallDifficulty:\n"), null);
    assert.equal(osuOverallDifficulty("[Difficulty]\nOverallDifficulty:lots\n"), null);
    assert.equal(osuOverallDifficulty(null), null);
    const text = chartOf(stream(1000, 200, 120), { od: 6 });
    const base = mapSummary({ kind: "ok", numeric: 15, label: "Delta", top3: [] });
    assert.equal(withMapFacts(base, text, 1).od, 6);
    assert.equal(withMapFacts(base, null, 1).od, undefined);
    assert.deepEqual(withMapFacts({ kind: "too-short" }, text, 1), { kind: "too-short" });
    // a text that gives nothing new is no change, so the pass neither writes nor counts it every session
    const notFourKeys = chartOf(stream(1000, 200, 120), { keys: 7, od: 6 });
    const known = { ...base, od: 6 };
    assert.equal(withMapFacts(known, notFourKeys, 1), known);
    assert.equal(withMapFacts(base, notFourKeys, 1).od, 6);
});

test("store: the OD is kept beside the map, survives maps.json and a backup; a backup fills in what this profile lacks", async () => {
    const result = { kind: "ok", numeric: 15, label: "Delta", calcs: {}, msd: {}, top3: [], tech: false, durationSec: 90 };
    assert.equal("od" in mapSummary(result), false, "an analysis result has no OD in it");
    assert.equal(mapSummary({ ...result, od: 6.5 }).od, 6.5);
    assert.equal(mapSummary({ ...result, od: null }).od, null, "looked at, the text has none");
    assert.equal(mapSummary({ ...result, od: "6" }).od, null);
    const dir = await tempDir();
    const store = createLocalProfileStore({ dir });
    const key = mapKeyOf("b".repeat(32), 1.5);
    await store.setMap(key, mapSummary({ ...result, od: 6.5, vibro: NOT_VIBRO }));
    const again = createLocalProfileStore({ dir });
    assert.equal((await again.map(key)).od, 6.5);
    const bundle = await again.exportBundle();
    assert.equal(bundle.maps[key].od, 6.5);
    // no OD and an older answer here: the backup's OD and its current answer are taken; a current answer stays
    const old = { ...NOT_VIBRO, v: VIBRO.VERSION - 1, share: 0.01 };
    const other = createLocalProfileStore({ dir: await tempDir() });
    await other.setMap(key, mapSummary({ ...result, vibro: old }));
    const keyB = mapKeyOf("c".repeat(32), 1);
    await other.setMap(keyB, mapSummary({ ...result, od: 8, vibro: NOT_VIBRO }));
    await other.importBundle({ ...bundle, maps: { ...bundle.maps, [keyB]: mapSummary({ ...result, od: 3, vibro: { ...NOT_VIBRO, share: 0.05 } }) } });
    assert.equal((await other.map(key)).od, 6.5);
    assert.deepEqual((await other.map(key)).vibro, NOT_VIBRO);
    assert.equal((await other.map(keyB)).od, 8);
    assert.deepEqual((await other.map(keyB)).vibro, NOT_VIBRO);
    // setMaps: many at once, bad ones left out
    await other.setMaps([[keyB, mapSummary({ ...result, od: 9 })], [key, null]]);
    assert.equal((await other.map(keyB)).od, 9);
    assert.equal((await other.map(key)).od, 6.5);
    // a reset while the pass still holds answers: what it writes after it brings no map back
    await other.reset();
    await other.setMaps([[keyB, mapSummary({ ...result, od: 9 })]]);
    assert.equal(await other.map(keyB), null);
});

// ---- the service ----

const normalText = (i, od = 8) => chartOf([...stream(1000, 300, 60000 / (150 + i * 5) / 4), ...jack(80_000, 40, 100, [i % 4])], { title: `Normal ${i}`, od });
// the analysis: a dan from the title
function fakeAnalyze() {
    const calls = [];
    const analyze = async (text, rate) => {
        calls.push([md5(text), rate]);
        const title = /^Title:(.*)$/m.exec(text)?.[1]?.trim() ?? "";
        const numeric = Number(/Dan (\d+)/.exec(title)?.[1] ?? NaN) || 12 + Number(/Normal (\d+)/.exec(title)?.[1] ?? 0) * 0.25;
        return { kind: "ok", numeric, label: "x", top3: [{ name: "Chordjacks", share: 0.7 }, { name: "Jumpstream", share: 0.3 }], tech: false, durationSec: 90, calcs: {} };
    };
    return { analyze, calls };
}

test("service, live: a new map below OD 7 is listed with its mark and its dan, and moves no dan", async () => {
    const dir = await tempDir();
    const store = createLocalProfileStore({ dir });
    const a = fakeAnalyze();
    let serving = null;
    const logs = [];
    const s = createLocalProfileService({ store, analyze: a.analyze, fetchMapText: async () => serving, log: (x) => logs.push(x), now: () => NOW });
    const play = (text, i) => {
        serving = text;
        return s.recordLive({
            client: "stable", md5: md5(text), beatmapId: 1_000_000 + i, beatmapsetId: 900_000 + i, artist: "Test", title: /^Title:(.*)$/m.exec(text)[1],
            version: "x", rate: 1, mods: [], hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", startedAt: NOW - (30 - i) * DAY, at: NOW - (30 - i) * DAY + 1000,
        });
    };
    for (let i = 0; i < 8; i += 1) await play(normalText(i), i);
    const before = (await s.status()).skill;
    await play(chartOf(stream(1000, 300, 120), { title: "Dan 20", od: 5 }), 20);
    await play(chartOf(stream(1000, 300, 120), { title: "Dan 13", od: 7 }), 21);
    const st = await s.status();
    assert.equal(st.counts.plays, 10);
    assert.equal(st.counts.rated, 9);
    assert.equal(st.counts.lowOd, 1);
    const low = st.recent.find((p) => p.title === "Dan 20");
    assert.equal(low.lowOd, true);
    assert.equal(low.perf, null);
    assert.equal(low.mapDan, 20, "the map keeps its own dan");
    assert.equal(low.unrated, false);
    assert.equal(low.vibro, null);
    assert.equal(st.recent.find((p) => p.title === "Dan 13").lowOd, false);
    assert.ok(Number.isFinite(st.recent.find((p) => p.title === "Dan 13").perf));
    assert.ok(st.skill.axes.jack.dan < before.axes.jack.dan + 1, "the dan 20 map did not lift it");
    assert.equal((await store.map(mapKeyOf(md5(normalText(0)), 1))).od, 8);
    assert.ok(logs.some((x) => x.includes("(<OD7: no dan)")), logs.join("\n"));
    const h = await s.history(90);
    assert.ok(h.best.every((p) => p.title !== "Dan 20"));
});

// A profile as 0.10.5 wrote it: vibro answers of version 1, no OD; its maps in a Songs folder, one of them gone.
const OLD_ANSWER = { v: 1, vibro: false, share: 0, longestRows: 0, peakGapMs: null, confidence: "high" };
async function oldProfile(root) {
    const songs = path.join(root, "osu!", "Songs");
    const a = fakeAnalyze();
    const piece = [
        ...Array.from({ length: 8 }, (_, i) => ({ text: normalText(i), rate: 1, mods: [] })),
        // EZ on an OD 8 map
        { text: chartOf(chordjack(1000, 500, 100), { title: "Dan 18" }), rate: 1, mods: ["EZ"] },
        // an OD 6 map at a big dan, and one at OD 7
        { text: chartOf(stream(1000, 300, 120), { title: "Dan 17", od: 6 }), rate: 1, mods: [] },
        { text: chartOf(stream(1000, 300, 120), { title: "Dan 13", od: 7 }), rate: 1, mods: [] },
        // an old map left out by the first answer, its .osu gone with the next
        { text: chartOf(stream(1000, 300, 120), { title: "Dan 16", od: 5 }), rate: 1, mods: [], gone: true, answer: { ...OLD_ANSWER, vibro: true, share: 0.3 } },
        { text: chartOf(chordjack(1000, 500, 100), { title: "Dan 15", od: 5 }), rate: 1.5, mods: ["DT"], gone: true },
        // gone as well, its name says what it was
        { text: chartOf(chordjack(1000, 500, 100), { title: "Dan 19", od: 0 }), rate: 1, mods: [], gone: true, version: "Rate OD0" },
    ];
    const lines = [];
    const maps = {};
    for (const [i, x] of piece.entries()) {
        if (!x.gone) {
            const folder = path.join(songs, `${500 + i} Test - Map ${i}`);
            await mkdir(folder, { recursive: true });
            await writeFile(path.join(folder, "map.osu"), x.text, "utf8");
        }
        const key = mapKeyOf(md5(x.text), x.rate);
        maps[key] = { ...mapSummary(await a.analyze(x.text, x.rate)), vibro: x.answer ?? OLD_ANSWER };
        lines.push(JSON.stringify({
            id: `stable:${md5(`${i}`)}`, source: "stable-db", client: "stable", md5: md5(x.text), rate: x.rate, mapKey: key,
            beatmapId: 2_000_000 + i, beatmapsetId: 500 + i, artist: "Test", title: /^Title:(.*)$/m.exec(x.text)[1], version: x.version ?? "x", mods: x.mods,
            hits: hits(40), accuracy: null, maxCombo: 900, outcome: "pass", at: NOW - (40 - i) * DAY,
        }));
    }
    const dir = path.join(root, "profile");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plays.jsonl"), `${lines.join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify(maps), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: path.join(root, "osu!"), imports: {} }), "utf8");
    return { dir, plays: lines.length };
}

const startApp = (dir, extra = {}) => createLocalProfileService({
    store: createLocalProfileStore({ dir }), analyze: async () => assert.fail("nothing is analysed again"), readFile: (f) => readFile(f),
    exists: async (f) => Boolean((await stat(f).catch(() => null))?.isFile()),
    songsIndex: createSongsMd5Index({ indexFile: path.join(dir, "songs-md5.json") }), now: () => NOW, ...extra,
});

test("a profile of the old format updates by itself on the first start: new answers, the skill rebuilt, every play kept, once", async () => {
    const root = await tempDir();
    const { dir, plays } = await oldProfile(root);
    const playsFile = await readFile(path.join(dir, "plays.jsonl"), "utf8");
    const logs = [];
    const events = [];
    const s = startApp(dir, { log: (x) => logs.push(x), emit: (c, p) => events.push([c, p]) });
    const before = await s.status();
    assert.equal(before.counts.lowOd, 2, "not looked at yet: the EZ play and the OD in a name are known already");
    assert.equal(before.counts.vibro, 1, "the first version's answer stands");
    assert.equal(before.counts.rated, plays - 3);

    assert.deepEqual(await s.checkVibro(), { checked: 11, vibro: 0, lowOd: 1, missing: 3 });
    assert.ok(events.some(([c]) => c === "local-profile-changed"), "the window hears the new skill");
    const after = await s.status();
    assert.equal(after.counts.plays, plays, "no play is lost");
    assert.equal(after.counts.vibro, 1, "the map the first answer left out, its .osu gone");
    assert.equal(after.counts.lowOd, 3, "the OD 6 map, the EZ play, the OD 0 in a name");
    assert.equal(after.counts.rated, plays - 4);
    assert.ok(after.skill.tiles.jack < before.skill.tiles.jack, `${after.skill.tiles.jack} < ${before.skill.tiles.jack}`);
    assert.equal(await readFile(path.join(dir, "plays.jsonl"), "utf8"), playsFile, "plays.jsonl is as it was");
    const ez = after.recent.find((p) => p.title === "Dan 18");
    assert.equal(ez.lowOd, true);
    assert.equal(ez.perf, null);
    assert.equal(ez.mapDan, 18);

    // the same dans as a profile that never had those plays
    const store = createLocalProfileStore({ dir });
    const all = await store.plays();
    const maps = (await store.load()).maps;
    const left = all.filter((p) => !["Dan 18", "Dan 17", "Dan 16", "Dan 19"].includes(p.title));
    assert.deepEqual(dansOf(after.skill), dansOf(skillFromPlays(left, (k) => maps.get(k), NOW)));

    // what maps.json holds now: the answers are this version's, the OD beside them
    const onDisk = JSON.parse(await readFile(path.join(dir, "maps.json"), "utf8"));
    const byTitle = (title) => onDisk[all.find((p) => p.title === title).mapKey];
    assert.equal(byTitle("Dan 18").vibro.v, VIBRO.VERSION);
    assert.equal(byTitle("Dan 18").vibro.vibro, false);
    assert.equal(byTitle("Dan 18").od, 8);
    assert.equal(byTitle("Dan 17").od, 6);
    assert.equal(byTitle("Dan 13").od, 7);
    // .osu gone: the answer it had stands, no OD is stored; with none in the name the play counts
    assert.deepEqual(byTitle("Dan 16").vibro, { ...OLD_ANSWER, vibro: true, share: 0.3 });
    assert.equal("od" in byTitle("Dan 16"), false);
    assert.equal("od" in byTitle("Dan 15"), false, "really OD 5, but nothing says so");
    assert.ok(Number.isFinite(after.recent.find((p) => p.title === "Dan 15").perf));
    assert.equal("od" in byTitle("Dan 19"), false);
    assert.equal(after.recent.find((p) => p.title === "Dan 19").lowOd, true);
    assert.ok(logs.some((x) => /vibro and OD looked at on 11 kept maps \(0 vibro, 1 below OD 7\), 3 without their \.osu \(1 by the OD in their name; 2 OD unknown, their plays count\)/.test(x)), logs.join("\n"));

    // once: this session answers from the first pass, the next start touches nothing and comes to the same dans
    assert.equal((await s.checkVibro()).already, true);
    const written = await stat(path.join(dir, "maps.json"));
    const next = startApp(dir);
    assert.deepEqual(await next.checkVibro(), { checked: 0, vibro: 0, lowOd: 0, missing: 3 }, "the three gone maps are only looked for");
    assert.equal((await stat(path.join(dir, "maps.json"))).mtimeMs, written.mtimeMs, "maps.json is not written again");
    assert.deepEqual(dansOf((await next.status()).skill), dansOf(after.skill));

    // a gone .osu that comes back gets its answers on the next start
    const gone = chartOf(stream(1000, 300, 120), { title: "Dan 16", od: 5 });
    const folder = path.join(root, "osu!", "Songs", "999 Test - Back");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "map.osu"), gone, "utf8");
    const back = startApp(dir);
    assert.deepEqual(await back.checkVibro(), { checked: 1, vibro: 0, lowOd: 1, missing: 2 });
    const st = await back.status();
    assert.equal(st.counts.vibro, 0);
    assert.equal(st.counts.lowOd, 4);
});

test("a profile whose .osu are all gone still loses the OD 0 rate maps and the EZ plays, and keeps all its plays", async () => {
    const dir = await tempDir();
    const { maps, plays } = inflatedProfile();
    await writeFile(path.join(dir, "plays.jsonl"), `${plays.map((p) => JSON.stringify(p)).join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify(Object.fromEntries(maps)), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: path.join(dir, "no-osu"), imports: {} }), "utf8");
    const s = startApp(dir);
    assert.deepEqual(await s.checkVibro(), { checked: 0, vibro: 0, lowOd: 0, missing: maps.size });
    const st = await s.status();
    assert.equal(st.counts.plays, plays.length);
    assert.equal(st.counts.lowOd, 12);
    assert.equal(st.counts.rated, plays.length - 12);
    const level = skillFromPlays(plays.filter((p) => p.id.startsWith("stable:a")), (k) => maps.get(k), NOW).axes.jack.dan;
    assert.ok(Math.abs(st.skill.tiles.jack - level) < 0.4, `${st.skill.tiles.jack} against ${level}`);
});

test("a live play that brings the .osu of a kept map puts its earlier plays right: the OD read beats the one in the name", async () => {
    const dir = await tempDir();
    const store = createLocalProfileStore({ dir });
    const text = chartOf(stream(1000, 300, 120), { title: "Dan 16", od: 8 });
    const key = mapKeyOf(md5(text), 1);
    const maps = { [key]: { ...summary(16), vibro: OLD_ANSWER } };
    const lines = [];
    for (let i = 0; i < 8; i += 1) {
        const other = `${String(i).padStart(32, "c")}@1.00`;
        maps[other] = { ...summary(12 + i * 0.1), vibro: OLD_ANSWER, od: 8 };
        lines.push({ id: `stable:${i}`, source: "stable-db", client: "stable", md5: other.slice(0, 32), rate: 1, mapKey: other, title: `Normal ${i}`, version: "x", mods: [], hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", at: NOW - (20 - i) * DAY });
    }
    lines.push({ id: "stable:old", source: "stable-db", client: "stable", md5: md5(text), rate: 1, mapKey: key, title: "Dan 16", version: "Rate OD5", mods: [], hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", at: NOW - 5 * DAY });
    await writeFile(path.join(dir, "plays.jsonl"), `${lines.map((p) => JSON.stringify(p)).join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify(maps), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, imports: {} }), "utf8");
    const s = createLocalProfileService({ store, analyze: async () => assert.fail("kept"), fetchMapText: async () => text, now: () => NOW });
    assert.equal((await s.status()).counts.lowOd, 1);
    await s.recordLive({
        client: "stable", md5: md5(text), beatmapId: 1_000_001, beatmapsetId: 900_001, artist: "Test", title: "Dan 16", version: "Rate OD5", rate: 1, mods: [],
        hits: hits(60), accuracy: null, maxCombo: 900, outcome: "pass", startedAt: NOW - 2000, at: NOW - 1000,
    });
    const st = await s.status();
    assert.equal(st.counts.lowOd, 0);
    assert.equal(st.counts.rated, 10);
    assert.equal((await store.map(key)).od, 8);
});

// One map a stable play and an Interlude play share, its .osu in no Songs folder unless songsText is; Interlude's chart as
// osuFor gives it.
async function sharedMap(chart, { songsText = null } = {}) {
    const dir = await tempDir();
    const text = chartOf(stream(1000, 300, 120), { title: "Dan 19", od: 8 });
    const key = mapKeyOf(md5(songsText ?? text), 1);
    const base = { md5: md5(songsText ?? text), rate: 1, mapKey: key, artist: "Test", title: "Dan 19", version: "Rate OD0", mods: [], outcome: "pass" };
    const plays = [
        { ...base, id: "stable:x", source: "stable-db", client: "stable", hits: hits(), at: NOW - DAY },
        { ...base, id: "interlude:H1:1", source: "interlude-db", client: "interlude", hits: null, at: NOW - DAY + 1 },
    ];
    await writeFile(path.join(dir, "plays.jsonl"), `${plays.map((p) => JSON.stringify(p)).join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify({ [key]: { ...summary(19), vibro: OLD_ANSWER } }), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: "A:/fake/osu!", imports: {} }), "utf8");
    const songsIndex = { scan: async () => ({ charts: new Map(songsText ? [[base.md5, { path: "map.osu" }]] : []) }) };
    const interlude = { linked: async () => true, osuFor: async () => ({ text, meta: {}, ...chart }) };
    const open = () => createLocalProfileService({
        store: createLocalProfileStore({ dir }), analyze: async () => assert.fail("nothing is analysed again"), interlude, songsIndex,
        readFile: async () => Buffer.from(songsText ?? "", "utf8"), now: () => NOW,
    });
    return { dir, key, open };
}
const stableRow = (st) => st.recent.find((p) => p.client === "stable");
const keptMap = async ({ dir, key }) => JSON.parse(await readFile(path.join(dir, "maps.json"), "utf8"))[key];

test("an OD Interlude made up for a chart does not overrule the real one: the name still decides, and it is not stored", async () => {
    const m = await sharedMap({ original: false });
    const s = m.open();
    assert.equal(stableRow(await s.status()).lowOd, true);
    assert.deepEqual(await s.checkVibro(), { checked: 0, vibro: 0, lowOd: 0, missing: 1 });
    const st = await s.status();
    assert.equal(stableRow(st).lowOd, true);
    assert.equal(stableRow(st).perf, null);
    assert.equal(st.recent.find((p) => p.client === "interlude").lowOd, false, "Interlude's own play counts");
    assert.equal("od" in (await keptMap(m)), false);
});

test("a stale vibro answer is still taken from a chart Interlude made, and the OD is left alone", async () => {
    const m = await sharedMap({ original: false });
    await writeFile(path.join(m.dir, "maps.json"), JSON.stringify({ [m.key]: { ...(await keptMap(m)), vibro: { ...OLD_ANSWER, v: VIBRO.VERSION - 1 } } }), "utf8");
    assert.equal((await m.open().checkVibro()).checked, 1);
    const after = await keptMap(m);
    assert.equal(after.vibro.v, VIBRO.VERSION);
    assert.equal("od" in after, false);
});

test("with a made-up OD in Interlude's chart the map's own .osu decides, and an OD that is real is taken", async () => {
    const inSongs = await sharedMap({ original: false }, { songsText: chartOf(stream(1000, 300, 120), { title: "Dan 19", od: 3 }) });
    assert.equal((await inSongs.open().checkVibro()).lowOd, 1);
    assert.equal((await keptMap(inSongs)).od, 3);
    // an origin's SourceOD is real, and so is the .osu Interlude kept
    const source = await sharedMap({ original: false, meta: { origins: [{ od: null }, { od: 8 }] } });
    await source.open().checkVibro();
    assert.equal((await keptMap(source)).od, 8);
    assert.equal(stableRow(await source.open().status()).lowOd, false);
    const kept = await sharedMap({ original: true });
    await kept.open().checkVibro();
    assert.equal((await keptMap(kept)).od, 8);
});

test("Interlude's import keeps no made-up OD, a map only Interlude played is not read again for one, a stable play brings the real one", async () => {
    const store = createLocalProfileStore({ dir: await tempDir() });
    const made = chartOf(stream(1000, 300, 120), { title: "Dan 19", od: 8 });
    const real = chartOf(stream(1000, 300, 120), { title: "Dan 19", od: 5 });
    const key = mapKeyOf(md5(real), 1);
    const a = fakeAnalyze();
    let reads = 0;
    const interlude = {
        linked: async () => true,
        scores: async () => [{ hash: "H1", at: NOW - DAY, rate: 1, failed: false }],
        osuFor: async () => { reads += 1; return { text: made, original: false, meta: { title: "T", origins: [{ md5: md5(real), od: null, rate: 1 }] } }; },
    };
    const s = createLocalProfileService({ store, analyze: a.analyze, interlude, fetchMapText: async () => real, now: () => NOW });
    assert.equal((await s.importInterlude()).ok, true);
    const kept = await store.map(key);
    assert.equal(kept.vibro.v, VIBRO.VERSION);
    assert.equal("od" in kept, false);
    reads = 0;
    assert.deepEqual(await s.checkVibro(), { checked: 0, vibro: 0, lowOd: 0, missing: 0 });
    assert.equal(reads, 0, "its plays do not go by an OD");
    await s.recordLive({ client: "stable", md5: md5(real), artist: "Test", title: "T", version: "x", rate: 1, mods: [], hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", startedAt: NOW - 2000, at: NOW - 1000 });
    assert.equal((await store.map(key)).od, 5);
    assert.equal((await s.status()).counts.lowOd, 1);
});

test("a lazer import keeps the OD Difficulty Adjust set: below the line it is left out on a map above it", async () => {
    const dir = await tempDir();
    const text = chartOf(stream(1000, 300, 120), { title: "Dan 18", od: 9 });
    const hash = "d".repeat(64);
    const score = (id, odSet, n200) => ({ id, hash, md5: md5(text), keys: 4, player: "TestPlayer", at: NOW - DAY, mods: ["DA"], odSet, rate: 1, hits: hits(n200), maxCombo: 500, accuracy: 0.97, failed: false });
    const lazer = { status: async () => ({ found: true }), read: async () => ({ found: true, maps: [{ hash, md5: md5(text), keys: 4, artist: "Test", title: "Dan 18", version: "x", beatmapId: 1_000_002, setId: 900_002 }], scores: [score("a", 4, 50), score("b", null, 60)] }), text: async () => text };
    const s = createLocalProfileService({ store: createLocalProfileStore({ dir }), analyze: fakeAnalyze().analyze, readFile: async () => Buffer.alloc(0), lazer, preferredPlayer: async () => "TestPlayer", now: () => NOW });
    assert.equal((await s.importLazer()).added, 2);
    const st = await s.status();
    assert.equal(st.counts.lowOd, 1);
    assert.equal(st.counts.rated, 1);
    const again = await createLocalProfileStore({ dir }).plays();
    assert.equal(again.find((p) => p.id === "lazer:a").odSet, 4);
    assert.equal("odSet" in again.find((p) => p.id === "lazer:b"), false);
});

test("a backup of the old format goes the same way: imported, then looked at; plays and dans as on the profile it came from", async () => {
    const root = await tempDir();
    const { dir } = await oldProfile(root);
    const bundle = await createLocalProfileStore({ dir }).exportBundle();
    assert.ok(Object.values(bundle.maps).every((m) => m.vibro.v === 1 && !("od" in m)), "an old backup");
    const home = startApp(dir);
    await home.checkVibro();
    const expected = await home.status();

    const elsewhere = path.join(await tempDir(), "profile");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "settings.json"), JSON.stringify({ record: true, osuFolder: path.join(root, "osu!"), imports: {} }), "utf8");
    const s = startApp(elsewhere);
    await s.checkVibro();
    assert.equal((await s.importBundle(bundle)).ok, true);
    let st = await s.status();
    for (let i = 0; i < 50 && st.counts.lowOd < expected.counts.lowOd; i += 1) {
        await s.checkVibro();
        st = await s.status();
    }
    assert.equal(st.counts.plays, expected.counts.plays);
    assert.equal(st.counts.lowOd, expected.counts.lowOd);
    assert.equal(st.counts.vibro, expected.counts.vibro);
    assert.deepEqual(dansOf(st.skill), dansOf(expected.skill));
    assert.equal((await s.checkVibro()).already, true);
});

// 120 kept maps in a fake Songs folder, no disk for the charts
function manyMaps(n) {
    const texts = new Map();
    const maps = {};
    const lines = [];
    for (let i = 0; i < n; i += 1) {
        const text = chartOf(stream(1000, 200, 120), { title: `Normal ${i}`, od: i % 2 ? 8 : 6 });
        texts.set(md5(text), text);
        const key = mapKeyOf(md5(text), 1);
        maps[key] = { ...summary(12, "Jumpstream"), vibro: OLD_ANSWER };
        lines.push(JSON.stringify({
            id: `stable:${i}`, source: "stable-db", client: "stable", md5: md5(text), rate: 1, mapKey: key, title: `Normal ${i}`, mods: [],
            hits: hits(), accuracy: null, maxCombo: 900, outcome: "pass", at: NOW - DAY - i,
        }));
    }
    return { texts, maps, lines };
}

test("the pass over a whole profile writes maps.json a few times, not once a map, and a stopped pass goes on where it stopped", async () => {
    const dir = await tempDir();
    const { texts, maps, lines } = manyMaps(120);
    await writeFile(path.join(dir, "plays.jsonl"), `${lines.join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify(maps), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: "A:/fake/osu!", imports: {} }), "utf8");
    let writes = 0;
    let failAt = 2; // the second write of maps.json fails, as if the app closed there
    const fs = {
        ...nodeFs,
        writeFile: (file, ...rest) => {
            if (file.endsWith("maps.json.tmp")) {
                writes += 1;
                if (writes === failAt) return Promise.reject(new Error("closed"));
            }
            return nodeFs.writeFile(file, ...rest);
        },
    };
    const songsIndex = { scan: async () => ({ charts: new Map([...texts.keys()].map((m) => [m, { path: m }])) }) };
    const open = () => createLocalProfileService({
        store: createLocalProfileStore({ dir, fs }), analyze: async () => assert.fail("nothing is analysed again"),
        readFile: async (m) => Buffer.from(texts.get(m), "utf8"), songsIndex, now: () => NOW,
    });
    const first = await open().checkVibro();
    assert.equal(first.failed, true);
    assert.equal(writes, 2);
    const kept = JSON.parse(await readFile(path.join(dir, "maps.json"), "utf8"));
    assert.equal(Object.values(kept).filter((m) => "od" in m).length, 50, "the first fifty are saved");
    failAt = -1;
    writes = 0;
    const s = open();
    assert.deepEqual(await s.checkVibro(), { checked: 70, vibro: 0, lowOd: 35, missing: 0 });
    assert.equal(writes, 2, "seventy maps, two writes");
    const st = await s.status();
    assert.equal(st.counts.plays, 120);
    assert.equal(st.counts.lowOd, 60);
    assert.equal(st.counts.rated, 60);
});

test("the pass reads while the window goes on: other work runs between the maps", async () => {
    const dir = await tempDir();
    const { texts, maps, lines } = manyMaps(30);
    await writeFile(path.join(dir, "plays.jsonl"), `${lines.join("\n")}\n`, "utf8");
    await writeFile(path.join(dir, "maps.json"), JSON.stringify(maps), "utf8");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ record: true, osuFolder: "A:/fake/osu!", imports: {} }), "utf8");
    let turns = 0;
    let done = false;
    const s = createLocalProfileService({
        store: createLocalProfileStore({ dir }), analyze: async () => null, now: () => NOW,
        // reading a file gives the loop its turn, as the disk does
        readFile: async (m) => { await new Promise((r) => setImmediate(r)); return Buffer.from(texts.get(m), "utf8"); },
        songsIndex: { scan: async () => ({ charts: new Map([...texts.keys()].map((m) => [m, { path: m }])) }) },
    });
    const ticking = (async () => { while (!done) { turns += 1; await new Promise((r) => setImmediate(r)); } })();
    const started = s.checkVibro();
    const status = await s.status(); // the window asks while the pass runs
    assert.equal(status.counts.plays, 30);
    const r = await started;
    done = true;
    await ticking;
    assert.equal(r.checked, 30);
    assert.ok(turns >= 30, `${turns} turns`);
});
