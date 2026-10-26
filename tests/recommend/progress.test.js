import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    trackerLabelToDan, rateFromMods, readRecent, readHistory, dailyPoints, skillChange, joinPicks, chartPath, maniaAccuracy, DAY_MS,
} from "../../src/recommend/progress.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/mt/${name}.json`, import.meta.url), "utf8"));
const recentJson = await fixture("recent");
const historyJson = await fixture("history");
const at = (iso) => Date.parse(iso);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("tracker dan labels → our numbers", () => {
    assert.equal(trackerLabelToDan("delta--"), 13.6);
    assert.equal(trackerLabelToDan("10++"), 10.4);
    assert.equal(trackerLabelToDan("kappa"), 20);
    assert.equal(trackerLabelToDan("gamma+"), 13.2);
    assert.equal(trackerLabelToDan("gamma++"), 13.4);
    assert.equal(trackerLabelToDan("Beta-"), 11.8);
    assert.equal(trackerLabelToDan("1"), 1);
    for (const bad of ["", null, "omega", "21", "delta+++", "0", 13]) assert.equal(trackerLabelToDan(bad), null, String(bad));
});

test("rate from mods: DT and NC 1.5 or their speed_change, HT and DC 0.75", () => {
    assert.equal(rateFromMods([{ acronym: "DT" }]), 1.5);
    assert.equal(rateFromMods([{ acronym: "NC", settings: { speed_change: 1.2 } }, { acronym: "CL" }]), 1.2);
    assert.equal(rateFromMods([{ acronym: "HT" }]), 0.75);
    assert.equal(rateFromMods([{ acronym: "DC", settings: { speed_change: 0.8 } }]), 0.8);
    assert.equal(rateFromMods(["DT"]), 1.5);
    assert.equal(rateFromMods([{ acronym: "CL" }, { acronym: "MR" }]), 1);
    assert.equal(rateFromMods(null), 1);
    assert.equal(rateFromMods([{ acronym: "DT", settings: { speed_change: "fast" } }]), 1.5);
});

test("recent plays: 4K mania only, time, accuracy, pass and rate", () => {
    const plays = readRecent(recentJson);
    assert.equal(plays.length, 10);
    assert.deepEqual(plays[0], { beatmapId: 563155, at: at("2026-10-25T13:49:53Z"), accuracy: 0.985476, passed: true, rate: 1, md5: "769a73814caa048d4bf0fc35f44cfaad" });
    assert.equal(plays.find((p) => p.beatmapId === 829747).rate, 1.5);
    assert.equal(plays.find((p) => p.beatmapId === 4170665).rate, 0.75);
    // an unranked play has accuracy 0 on the server: ours from its judgements (lazer weights)
    const unranked = plays.find((p) => p.beatmapId === 1001113);
    close(unranked.accuracy, 458790 / 470005);
    close(maniaAccuracy({ perfect: 1, great: 1 }), 605 / 610);
    assert.equal(maniaAccuracy({}), 0);

    const [one] = recentJson.payload;
    const variant = (patch) => readRecent({ payload: [{ ...one, ...patch, beatmap: { ...one.beatmap, ...patch.beatmap } }] });
    assert.equal(variant({ beatmap: { cs: 7 } }).length, 0, "7K");
    assert.equal(variant({ ruleset_id: 0, beatmap: { mode: "osu" } }).length, 0, "not mania");
    assert.equal(variant({ beatmap: { convert: true } }).length, 0, "a convert");
    assert.equal(variant({ ended_at: "soon" }).length, 0);
    assert.equal(variant({ passed: false })[0].passed, false);
    assert.equal(variant({ rank: "F" })[0].passed, false);
    assert.deepEqual(readRecent(null), []);
    assert.deepEqual(readRecent({ payload: "x" }), []);
});

test("skill history: time, dan from the label, the ratings and the next page's cursor", () => {
    const h = readHistory(historyJson);
    assert.equal(h.nextBefore, 331044);
    assert.equal(h.items.length, 13);
    assert.deepEqual(h.items[0], {
        at: at("2026-10-25T12:48:50.037Z"), label: "delta--", dan: 13.6,
        ratings: { Overall: 34.87, Stream: 34.62, Jumpstream: 30.62, Handstream: 30.35, Stamina: 33.18, JackSpeed: 21.61, Chordjack: 29.36, Technical: 32.95 },
    });
    assert.equal(h.items.at(-1).label, "gamma++");
    assert.deepEqual(readHistory({ items: [{ recordedAt: "x" }, null], nextBefore: "abc" }), { items: [], nextBefore: null });
});

test("daily points: the last snapshot of each day since the start, after the one before it", () => {
    const { items } = readHistory(historyJson);
    const since = at("2026-10-03T00:00:00Z");
    const points = dailyPoints(items, since);
    // the last one before the period (10-02 20:16) opens the line at the period's start
    assert.equal(points[0].at, since);
    assert.equal(points[0].label, "gamma++");
    assert.equal(points[0].ratings.Overall, 33.89);
    // 10-03 has two snapshots (gamma++ 14:55, delta-- 17:55): the later one stands for the day
    assert.equal(points[1].at, at("2026-10-03T17:55:16.103Z"));
    assert.equal(points[1].label, "delta--");
    // one a day from there, in time order
    const days = points.slice(1).map((p) => Math.floor(p.at / DAY_MS));
    assert.deepEqual(days, [...new Set(days)].sort((a, b) => a - b));
    assert.equal(points.at(-1).ratings.Overall, 34.87);
    assert.equal(points.length, 1 + 7);
    // nothing before the period: the line starts with the first day
    assert.equal(dailyPoints(items, at("2026-09-01T00:00:00Z"))[0].at, at("2026-09-26T11:54:53.851Z"));
    assert.deepEqual(dailyPoints([], since), []);
});

test("skill change over the period: dan from → to and the MSD axes, biggest gain first", () => {
    const { items } = readHistory(historyJson);
    const change = skillChange(dailyPoints(items, at("2026-10-02T00:00:00Z")));
    assert.deepEqual(change.danFrom, { label: "gamma++", dan: 13.4 });
    assert.deepEqual(change.danTo, { label: "delta--", dan: 13.6 });
    close(change.danDelta, 0.2);
    // from 09-30 to 10-25: Stream +1.30, Overall +1.23, Stamina +1.19 …
    assert.deepEqual(change.axes.slice(0, 3).map((a) => a.axis), ["Stream", "Overall", "Stamina"]);
    close(change.axes[1].delta, 34.87 - 33.64);
    assert.equal(change.axes.length, 8);
    for (let i = 1; i < change.axes.length; i++) assert.ok(change.axes[i - 1].delta >= change.axes[i].delta);
    const stream = change.axes.find((a) => a.axis === "Stream");
    assert.deepEqual([stream.from, stream.to], [33.32, 34.62]);
    assert.equal(skillChange([]), null);
});

test("joining picks with plays: only plays after the pick count; the best pass wins, tries are counted", () => {
    const recent = readRecent(recentJson);
    const pick = (beatmapId, iso) => ({ beatmapId, beatmapsetId: 1, title: "x", how: "download", at: at(iso) });
    const picks = [
        pick(770548, "2026-10-25T12:00:00Z"), // two plays after (13:24, 13:27), one before (11:15)
        pick(563155, "2026-10-25T14:00:00Z"), // played only before the pick
        pick(4766898, "2026-10-18T00:00:00Z"),
        pick(1234, "2026-10-01T00:00:00Z"), // never played, but skill-plays has it on a later day
        pick(5678, "2026-10-20T15:00:00Z"), // skill-plays has it on the same day: counts at day precision
        pick(9999, "2026-10-20T15:00:00Z"), // skill-plays has it the day before: does not count
    ];
    const played = new Map([
        [1234, { beatmapsetId: 1, accuracy: 0.95, rate: 1.1, playedAt: at("2026-10-11T00:00:00Z") }],
        [5678, { beatmapsetId: 1, accuracy: 0.9, rate: 1, playedAt: at("2026-10-20T00:00:00Z") }],
        [9999, { beatmapsetId: 1, accuracy: 0.9, rate: 1, playedAt: at("2026-10-19T00:00:00Z") }],
    ]);
    const joined = joinPicks(picks, recent, played);
    assert.deepEqual(joined[0].play, { accuracy: 0.989904, rate: 1, at: at("2026-10-25T13:27:24Z"), passed: true });
    assert.equal(joined[0].tries, 2);
    assert.equal(joined[1].play, null);
    assert.equal(joined[1].tries, 0);
    assert.equal(joined[2].tries, 2);
    assert.equal(joined[2].play.accuracy, 0.939564);
    assert.deepEqual(joined[3].play, { accuracy: 0.95, rate: 1.1, at: at("2026-10-11T00:00:00Z"), passed: true });
    assert.equal(joined[4].play.accuracy, 0.9);
    assert.equal(joined[5].play, null);
    assert.equal(joined[0].title, "x");

    // only failed tries: the latest of them, marked failed
    const fails = [
        { beatmapId: 1, at: 10, accuracy: 0.5, passed: false, rate: 1 },
        { beatmapId: 1, at: 20, accuracy: 0.4, passed: false, rate: 1 },
    ];
    const [failed] = joinPicks([{ beatmapId: 1, at: 5 }], fails);
    assert.deepEqual([failed.play.passed, failed.play.at, failed.tries], [false, 20, 2]);
});

test("chart path: the axis over time inside the box, with marks on the line", () => {
    const points = [
        { at: 0, dan: 13, ratings: { Overall: 30 } },
        { at: 10, dan: 13.2, ratings: { Overall: 31 } },
        { at: 20, dan: 13.4, ratings: { Overall: 32 } },
    ];
    const box = { width: 200, height: 100, pad: 10, from: 0, to: 20 };
    const c = chartPath(points, "Overall", box, [10, 15, 99]);
    assert.equal(c.d, "M10.0 90.0 L100.0 50.0 L190.0 10.0");
    assert.deepEqual(c.dots.map((d) => [d.x, d.y]), [[10, 90], [100, 50], [190, 10]]);
    assert.deepEqual([c.lo, c.hi], [30, 32]);
    // a mark sits on the line where the value stood at that time; one outside the box is dropped
    assert.deepEqual(c.marks.map((m) => [m.x, m.y]), [[100, 50], [145, 30]]);
    // the dan line, and a flat line keeps a small span so it sits in the middle
    assert.equal(chartPath(points, "dan", box).d, "M10.0 90.0 L100.0 50.0 L190.0 10.0");
    const flat = chartPath([{ at: 0, ratings: { Overall: 30 } }, { at: 20, ratings: { Overall: 30 } }], "Overall", box);
    assert.equal(flat.d, "M10.0 50.0 L190.0 50.0");
    assert.deepEqual(chartPath([], "Overall", box), { d: "", dots: [], marks: [], lo: null, hi: null });
    assert.deepEqual(chartPath(points, "Nope", box).d, "");
});
