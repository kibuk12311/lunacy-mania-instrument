// src/replay/hints.js on made-up reports (no real play, no real number): each rule fires at its limit and not under it, not
// under its minimum sample, not where the play's numbers cannot carry it; a play where nothing stands out gets no hint at all.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHints, biasTells, HINTS } from "../../src/replay/hints.js";
import { MANIP } from "../../src/replay/manip.js";
import { PACE } from "../../src/replay/flow.js";
import { setLang, getLang, t } from "../../src/i18n/i18n.js";
import { AREAS } from "../../src/i18n/messages/index.js";

const apart = HINTS.momentSec + 1; // seconds of play that keep two moments apart
const finger = (id, ur, more = {}) => ({ finger: id, ur, notes: 1000, misses: 0, breaks: 0, holds: null, ...more });
const hand = (columns, more = {}) => ({ columns, notes: 2000, misses: 0, ...more });
const column = (col, mean, hits = 1000) => ({ col, mean, hits });
const noManip = (pairs = 0) => ({ pairs, glued: 0, percent: pairs ? 0 : null, chance: null, loose: false, thin: false, hands: { left: { pairs: 0, glued: 0, percent: null }, right: { pairs: 0, glued: 0, percent: null } } });
const result = (t, col, more = {}) => ({ t, col, end: null, kind: "max", press: t, delta: 0, ...more });

// A whole play where nothing stands out: every test below changes what its rule reads.
function quiet() {
    return {
        replay: { counts: { max: 900, n300: 90, n200: 8, n100: 2, n50: 0, miss: 0 }, modNames: [], rate: 1 },
        analysis: {
            rate: 1, fromMs: 0, toMs: 300_000, reachedMs: 300_000, scoreV2: false, holds: false, holdHeavy: false, played: 1000, notes: 1000, comparison: { same: true },
            accuracy: 98, ur: 150, sd: 15, results: [], byColumn: [column(0, 0), column(1, 0), column(2, 0), column(3, 0)],
        },
        report: {
            fingers: [finger("L3", 150), finger("L2", 150), finger("R2", 150), finger("R3", 150)], hands: { left: hand([0, 1]), right: hand([2, 3]) },
            balance: { leftAhead: 0 }, manip: noManip(), pairs: [], drift: null, pace: null, breaks: [], ghosts: null, parts: [], hardest: null, families: [],
        },
        later: null, earlier: null, bias: null,
    };
}
const change = (edit) => {
    const data = quiet();
    edit(data);
    return data;
};
const ids = (data, limits) => Object.values(buildHints(data, limits).bySection).flat().map((h) => h.id);
const fires = (data, id, limits) => Object.values(buildHints(data, limits).bySection).flat().find((h) => h.id === id) ?? null;
const silent = (data, limits) => assert.deepEqual(ids(data, limits), []);
const under = (limit) => limit * 0.99;
const notWhole = (data) => { data.analysis.played = data.analysis.notes - 1; };
const notExact = (data) => { data.analysis.holdHeavy = true; data.analysis.comparison = { same: false }; };
const withV2 = (data) => { data.analysis.scoreV2 = true; data.analysis.holds = true; data.analysis.comparison = null; };

test("a play where nothing stands out gets no hint, no filler", () => {
    assert.deepEqual(buildHints(quiet()), { top: [], bySection: {} });
    assert.deepEqual(buildHints({}), { top: [], bySection: {} }, "nothing at all to go by");
});

test("every limit lives in one frozen object", () => {
    assert.ok(Object.isFrozen(HINTS));
    for (const group of Object.values(HINTS)) if (typeof group === "object") assert.ok(Object.isFrozen(group));
    assert.equal(HINTS.perSection, 2);
    assert.equal(HINTS.top, 3);
});

// ---- judgements ----
const lostPlay = (edit = () => {}) => change((d) => {
    d.replay.counts = { max: 870, n300: 0, n200: 120, n100: 0, n50: 0, miss: 10 }; // 5 % lost, 1 % of it on misses
    edit(d);
});
const exactly = { ...HINTS, judgements: { ...HINTS.judgements, minShare: 0.2, mostShare: 0.5, minLost: 5, minMisses: 10, minNotes: 1000 } };

test("judgements: what share of the lost accuracy went on misses", () => {
    const h = fires(lostPlay(), "judgements.misses", exactly);
    assert.equal(h.section, "judgements");
    assert.equal(h.key, "replay.hint.judge.misses");
    assert.deepEqual(h.params, { lost: 5, misses: 1 });
    assert.equal(h.seek, undefined, "it has no place on the map");
    const mostly = lostPlay((d) => { d.replay.counts = { max: 880, n300: 0, n200: 90, n100: 0, n50: 0, miss: 30 }; });
    assert.equal(fires(mostly, "judgements.misses", exactly).key, "replay.hint.judge.mostlyMisses");
});

test("judgements: not under its limits, its minimum sample, nor where the counts cannot carry it", () => {
    const limit = (over) => ({ ...HINTS, judgements: { ...exactly.judgements, ...over } });
    silent(lostPlay(), limit({ minShare: 0.21 }));
    silent(lostPlay(), limit({ minLost: 5.1 }));
    silent(lostPlay(), limit({ minMisses: 11 }));
    silent(lostPlay(), limit({ minNotes: 1001 }));
    silent(lostPlay(notWhole), exactly);
    silent(lostPlay((d) => { d.analysis.scoreV2 = true; }), exactly);
});

test("judgements: a replay with no map still has osu!'s own counts, and nothing else is said of it", () => {
    const { replay } = lostPlay();
    const hints = buildHints({ replay }, exactly);
    assert.deepEqual(hints.top.map((h) => h.id), ["judgements.misses"]);
    silent({ replay: { ...replay, modNames: ["V2"] } }, exactly);
});

// ---- fingers ----
const unevenPlay = (gap, edit = () => {}) => change((d) => {
    d.report.fingers[3].ur = 150 + gap;
    edit(d);
});
const fingerLimits = (over = {}) => ({ ...HINTS, fingers: { ...HINTS.fingers, minGap: 30, minRatio: 1.2, ...over } });

test("fingers: the least even one, with the combo breaks on it when they are told exactly", () => {
    const h = fires(unevenPlay(30), "fingers.uneven", fingerLimits());
    assert.equal(h.key, "replay.hint.finger.uneven");
    assert.deepEqual(h.params, { finger: "R3", gap: 30 });
    const data = unevenPlay(30, (d) => {
        d.report.fingers[3].breaks = 6;
        d.report.breaks = new Array(23).fill({ shape: null, cause: "none", part: null });
    });
    const told = fires(data, "fingers.uneven", fingerLimits());
    assert.equal(told.key, "replay.hint.finger.unevenBreaks");
    assert.deepEqual(told.params, { finger: "R3", gap: 30, breaks: 6, of: 23 });
    notExact(data);
    assert.equal(fires(data, "fingers.uneven", fingerLimits()).key, "replay.hint.finger.uneven", "a hold-heavy map's breaks are near, not exact");
});

test("fingers: not under the gap, the ratio or the minimum hits, and a default that needs a real gap", () => {
    silent(unevenPlay(under(30)), fingerLimits());
    silent(unevenPlay(30), fingerLimits({ minRatio: 1.21 }));
    silent(unevenPlay(30, (d) => { d.report.fingers[3].misses = 1000 - HINTS.fingers.minHits + 1; }), fingerLimits());
    silent(unevenPlay(30, (d) => { d.report.fingers = [d.report.fingers[3]]; }), fingerLimits());
    assert.ok(fires(unevenPlay(HINTS.fingers.minGap * 2), "fingers.uneven"));
    silent(unevenPlay(under(HINTS.fingers.minGap)));
});

// ---- hands ----
const chords = (n) => Array.from({ length: n }, (_, i) => [result(i * 100, 0), result(i * 100, 3)]).flat();
const aheadPlay = (ms, edit = () => {}) => change((d) => {
    d.report.balance.leftAhead = ms;
    edit(d);
});

test("hands: the hand in a hurry, and chords only when the map has them", () => {
    const { minMs, minChords, minHits } = HINTS.hands;
    assert.equal(fires(aheadPlay(minMs), "hands.ahead").key, "replay.hint.hand.left");
    assert.equal(fires(aheadPlay(-minMs), "hands.ahead").key, "replay.hint.hand.right");
    assert.deepEqual(fires(aheadPlay(minMs), "hands.ahead").params, { ms: minMs });
    assert.equal(fires(aheadPlay(minMs, (d) => { d.analysis.results = chords(minChords); }), "hands.ahead").key, "replay.hint.hand.leftChords");
    assert.equal(fires(aheadPlay(-minMs, (d) => { d.analysis.results = chords(minChords); }), "hands.ahead").key, "replay.hint.hand.rightChords");
    assert.equal(fires(aheadPlay(minMs, (d) => { d.analysis.results = chords(minChords - 1); }), "hands.ahead").key, "replay.hint.hand.left");
    silent(aheadPlay(under(minMs)));
    silent(aheadPlay(-under(minMs)));
    silent(aheadPlay(minMs, (d) => { d.report.hands.left.notes = minHits - 1; }));
    silent(aheadPlay(minMs, (d) => { d.report.hands.right.notes = minHits - 1; }));
    silent(aheadPlay(null));
});

// ---- manip ----
// each pair a run of its own unless `gap` brings them closer
const pairsOn = (n, t0, { glued = 0, hand: side = "left", gap = apart * 1000 } = {}) => Array.from({ length: n }, (_, i) => ({
    t: t0 + i * gap, tb: t0 + i * gap + 50, col: 0, colb: 1, hand: side, written: 100, played: i < glued ? 5 : 100, glued: i < glued,
}));
const tally = (pairs, glued) => ({ pairs, glued, percent: pairs ? Math.round((glued / pairs) * 1000) / 10 : null });
// the manip rules with the chance of a group's count out of the way, for what is about their other limits
const anyCount = { ...HINTS, manip: { ...HINTS.manip, minRuns: 1, maxChance: 1, maxHandChance: 1 } };
const MANIP_MS = 3_000_000;

// streams up to half of the map, jumpstreams after it, at a spread where chance glues next to nothing
function manipPlay({ glued = 30, pairs = 50, jump = pairs, stream = 50, gluedStream = 0, gap } = {}) {
    return change((d) => {
        const list = [...pairsOn(stream, 1000, { glued: gluedStream, gap }), ...pairsOn(jump, MANIP_MS / 2, { glued, gap })];
        d.analysis.sd = 5;
        d.report.pairs = list;
        d.report.manip = {
            ...tally(list.length, glued + gluedStream), chance: 0, loose: false, thin: false,
            hands: { left: tally(list.length, glued + gluedStream), right: tally(0, 0) },
        };
        d.later = { families: ["stream", "jumpstream"], spanMs: MANIP_MS, dans: [] };
        d.report.families = [
            { family: "jumpstream", notes: 2000, ur: 150, ...tally(jump, glued) },
            { family: "stream", notes: 2000, ur: 150, ...tally(stream, gluedStream) },
        ];
        d.analysis.results = list.flatMap((p) => [result(p.t, p.col), result(p.tb, p.colb)]);
    });
}

test("manip: the family glued the most, and whether the window lets it through", () => {
    const h = fires(manipPlay(), "manip.family");
    assert.equal(h.key, "replay.hint.manip.familyForgiven");
    assert.deepEqual(h.params, { families: "jumpstream", percent: 60 });
    const worse = manipPlay();
    worse.analysis.results = worse.analysis.results.map((r) => ({ ...r, kind: "n100" }));
    assert.equal(fires(worse, "manip.family").key, "replay.hint.manip.family");
    const limit = { ...HINTS, manip: { ...HINTS.manip, minPercent: 60 } };
    assert.ok(fires(manipPlay(), "manip.family", limit));
    assert.equal(fires(manipPlay({ glued: 29 }), "manip.family", limit), null);
});

test("manip: isThin and isLoose rule, as they do the numbers", () => {
    assert.equal(fires(change((d) => Object.assign(d, manipPlay())), "manip.family")?.id, "manip.family");
    const thin = manipPlay();
    thin.report.manip.thin = true;
    silent(thin);
    const loose = manipPlay();
    loose.report.manip.loose = true;
    silent(loose);
    const scatter = manipPlay({ glued: 10 });
    assert.ok(fires(scatter, "manip.family", anyCount), "20 % at a tight spread");
    scatter.analysis.sd = 60; // at this one about as much comes by itself
    assert.equal(fires(scatter, "manip.family", anyCount), null);
    const few = manipPlay({ pairs: MANIP.minPairs - 1, glued: 15 });
    assert.equal(fires(few, "manip.family"), null, "the family's own pairs are too few");
    const alone = manipPlay();
    alone.report.families = alone.report.families.slice(0, 1);
    assert.equal(fires(alone, "manip.family"), null, "«the most» needs something to be compared with");
    const thinOther = manipPlay({ stream: MANIP.minPairs - 1 });
    assert.equal(fires(thinOther, "manip.family", anyCount), null, "and a family with too few pairs is nothing to compare with");
    assert.equal(fires({ ...manipPlay(), later: null }, "manip.family"), null, "families come later");
});

// a play of `left` and `right`, the tallies of its hands, the headline what they add up to
function handsPlay(left, right, sd = 5) {
    const data = manipPlay({ pairs: left.pairs, glued: left.glued, stream: 0 });
    data.analysis.sd = sd;
    data.report.manip = { ...data.report.manip, ...tally(left.pairs + right.pairs, left.glued + right.glued), hands: { left, right } };
    data.report.pairs = [...pairsOn(left.pairs, 1000, { glued: left.glued }), ...pairsOn(right.pairs, 1000 + (left.pairs + 1) * apart * 1000, { glued: right.glued, hand: "right" })];
    return data;
}

test("manip: one hand more than the other, and one part of the map more than the rest", () => {
    const h = fires(handsPlay(tally(50, 25), tally(50, 5)), "manip.hand");
    assert.equal(h.key, "replay.hint.manip.leftHand");
    assert.deepEqual(h.params, { percent: 50, other: 10 });
    assert.equal(fires(handsPlay(tally(50, 5), tally(50, 25)), "manip.hand").key, "replay.hint.manip.rightHand");
    assert.equal(fires(handsPlay(tally(MANIP.minPairs - 1, 10), tally(50, 5)), "manip.hand"), null, "thin");
    assert.equal(fires(handsPlay(tally(50, 25), tally(MANIP.minPairs - 1, 1)), "manip.hand", anyCount), null, "thin on the side it is compared with");
    assert.equal(fires(handsPlay(tally(50, 13), tally(50, 13)), "manip.hand", anyCount), null, "no gap");

    const parts = manipPlay({ stream: 50, jump: 50, glued: 25 });
    parts.report.pairs = [...pairsOn(50, 1000, { gap: 100 }), ...pairsOn(50, 150_000, { glued: 25, gap: 100 })];
    parts.report.parts = [
        { index: 0, fromMs: 0, toMs: 100_000, notes: 500, ...tally(50, 0) },
        { index: 1, fromMs: 100_000, toMs: 300_000, notes: 500, ...tally(50, 25) },
    ];
    const part = fires(parts, "manip.part");
    assert.deepEqual(part.params, { from: 100_000, to: 300_000, percent: 50 });
    assert.equal(part.seek, 100_000, "a place on the map");
    parts.report.parts = parts.report.parts.slice(1);
    assert.equal(fires(parts, "manip.part"), null, "one part has nothing to stand out from");
});

// the hands apart, `top` of the left's 50 pairs glued against the right's 5
const gluedHandPlay = (top, sd = 5) => handsPlay(tally(50, top), tally(50, 5), sd);
// three parts of 50 pairs each, the last with `top` glued, or as many pairs as `pairs`
function gluedPartPlay(top, { sd = 5, pairs = 50 } = {}) {
    const data = manipPlay({ stream: 50, jump: 50, glued: top });
    data.analysis.sd = sd;
    const part = (index, list) => ({ index, fromMs: index * 100_000, toMs: (index + 1) * 100_000, notes: 500, ...tally(list.length, list.filter((p) => p.glued).length) });
    data.report.pairs = [...pairsOn(50, 1000, { gap: 100 }), ...pairsOn(50, 101_000, { gap: 100 }), ...pairsOn(pairs, 201_000, { glued: top, gap: 100 })];
    data.report.parts = [part(0, pairsOn(50, 0, { gap: 100 })), part(1, pairsOn(50, 0, { gap: 100 })), part(2, pairsOn(pairs, 0, { glued: top, gap: 100 }))];
    return data;
}

test("manip: a hand stands up like the headline does, and only over its limits", () => {
    assert.ok(fires(gluedHandPlay(10), "manip.hand", anyCount), "20 % against 10 % at a tight spread");
    assert.equal(fires(gluedHandPlay(10, 60), "manip.hand", anyCount), null, "at this spread about as much comes by itself");
    const limit = (over) => ({ ...HINTS, manip: { ...HINTS.manip, ...over } });
    assert.ok(fires(gluedHandPlay(25), "manip.hand", limit({ minHandPercent: 50 })));
    assert.equal(fires(gluedHandPlay(25), "manip.hand", limit({ minHandPercent: 51 })), null);
});

test("manip: a hand or a family stands out of the play's own percent by more than a pair or two", () => {
    const hands = (left, right) => handsPlay(tally(...left), tally(...right));
    assert.ok(fires(hands([21, 3], [25, 2]), "manip.hand", anyCount), "14 % against 8 %, over both limits of the gap");
    assert.equal(fires(hands([21, 3], [25, 2]), "manip.hand"), null, "and one pair");
    assert.equal(fires(hands([50, 10], [50, 5]), "manip.hand"), null, "10 of 15 runs at half of the pairs comes about once in seven plays");
    assert.ok(fires(hands([400, 80], [400, 40]), "manip.hand"), "and 80 of 120 not");
    const limit = (maxChance) => ({ ...HINTS, manip: { ...HINTS.manip, maxChance, maxHandChance: maxChance } });
    assert.ok(fires(hands([50, 15], [50, 5]), "manip.hand", limit(0.021)), "15 of 20 at half of the pairs: about once in 48");
    assert.equal(fires(hands([50, 15], [50, 5]), "manip.hand", limit(0.02)), null);

    const family = (over) => manipPlay({ jump: 30, stream: 30, ...over });
    assert.ok(fires(family({ glued: 5, gluedStream: 3 }), "manip.family", anyCount), "17 % against 10 %");
    assert.equal(fires(family({ glued: 5, gluedStream: 3 }), "manip.family"), null, "two pairs of difference");
    assert.equal(fires(manipPlay({ glued: 31, gluedStream: 30 }), "manip.family"), null, "62 % against 60 % is the headline, not the family");
    assert.ok(fires(manipPlay({ glued: 20, jump: 100, stream: 100 }), "manip.family"), "20 % against none of 100");
    assert.ok(fires(manipPlay({ glued: 15, gluedStream: 5 }), "manip.family", limit(0.021)));
    assert.equal(fires(manipPlay({ glued: 15, gluedStream: 5 }), "manip.family", limit(0.02)), null);
});

test("manip: neighbouring glued pairs are one run, and a group takes separate runs", () => {
    const { minRuns } = HINTS.manip;
    assert.equal(fires(manipPlay({ gap: 100 }), "manip.family", { ...anyCount, manip: { ...anyCount.manip, minRuns } }), null, "thirty pairs of one run");
    const hands = handsPlay(tally(50, 40), tally(50, 0));
    hands.report.pairs = [...pairsOn(50, 1000, { glued: 40, gap: 100 }), ...pairsOn(50, 500_000, { hand: "right" })];
    assert.equal(fires(hands, "manip.hand", { ...anyCount, manip: { ...anyCount.manip, minRuns } }), null);
    const runs = (n) => manipPlay({ glued: n, jump: 40, stream: 40 });
    const only = { ...anyCount, manip: { ...anyCount.manip, minRuns, minPercent: 1 } };
    assert.ok(fires(runs(minRuns), "manip.family", only));
    assert.equal(fires(runs(minRuns - 1), "manip.family", only), null);
    const hand = (n) => handsPlay(tally(40, n), tally(40, 0));
    const handOnly = { ...HINTS, manip: { ...only.manip, minHandPercent: 1, minHandGap: 1 } };
    assert.ok(fires(hand(minRuns), "manip.hand", handOnly));
    assert.equal(fires(hand(minRuns - 1), "manip.hand", handOnly), null);
});

// `glued` pairs of the jumpstreams `sec` seconds of the map apart, the rate of the play `rate`, nothing else glued
function runsPlay(sec, rate = 1, glued = 6) {
    const data = manipPlay({ glued, jump: 40, stream: 40, gap: sec * 1000 });
    data.analysis.rate = rate;
    return data;
}
const runLimits = (over = {}) => ({ ...HINTS, manip: { ...HINTS.manip, maxChance: 1, ...over } });

test("manip: glued pairs at most runSec of play apart are one run", () => {
    const { runSec } = HINTS.manip;
    assert.equal(fires(runsPlay(runSec), "manip.family", runLimits()), null, "exactly the limit apart");
    assert.ok(fires(runsPlay(runSec + 0.05), "manip.family", runLimits()), "a little more");
    assert.equal(fires(runsPlay(runSec + 0.05, 1.5), "manip.family", runLimits()), null, "that much of the map is less of play at a higher rate");
    assert.ok(fires(runsPlay(runSec, 0.75), "manip.family", runLimits()), "and more at a lower one");
});

test("manip: runs are grouped once, over all the glued pairs, so a group cannot part one into more runs than there are", () => {
    // one chain runSec apart, every other pair on the left: on their own those are three runs of one
    const data = handsPlay(tally(50, 3), tally(50, 2));
    const pair = (i, side) => ({ ...pairsOn(1, 1000 + i * HINTS.manip.runSec * 1000, { glued: 1, hand: side })[0] });
    data.report.pairs = [...data.report.pairs.filter((p) => !p.glued), pair(0, "left"), pair(1, "right"), pair(2, "left"), pair(3, "right"), pair(4, "left")].sort((a, b) => a.t - b.t);
    assert.equal(fires(data, "manip.hand", { ...HINTS, manip: { ...HINTS.manip, maxHandChance: 0.5, minHandPercent: 1, minHandGap: 1 } }), null);
});

test("manip: a run counts for a group when most of its pairs are in it, against the group's share of the pairs", () => {
    const limits = (maxHandChance) => ({ ...HINTS, manip: { ...HINTS.manip, maxHandChance, minHandPercent: 1, minHandGap: 1 } });
    // `runs` runs, each `left` pairs of the left hand with `right` of the right, among as many pairs of each hand again
    const play = (runs, left, right, plainRight = 0) => {
        const data = handsPlay(tally(50, runs * left), tally(50 + plainRight, runs * right));
        const close = (t, hand, n) => pairsOn(n, t, { glued: n, hand, gap: 100 });
        data.report.pairs = [
            ...Array.from({ length: runs }, (_, i) => [...close(i * 10 * apart * 1000, "left", left), ...close(i * 10 * apart * 1000 + left * 100, "right", right)]).flat(),
            ...pairsOn(50 - runs * left, 900_000), ...pairsOn(50 + plainRight - runs * right, 901_000, { hand: "right" }),
        ].sort((a, b) => a.t - b.t);
        return data;
    };
    assert.ok(fires(play(5, 2, 1), "manip.hand", limits(0.04)), "five of five at half of the pairs: 3 in 100");
    assert.equal(fires(play(5, 2, 1), "manip.hand", limits(0.03)), null);
    assert.equal(fires(play(5, 2, 2), "manip.hand", limits(1)), null, "half is not most");
    assert.ok(fires(play(5, 2, 1, 100), "manip.hand", limits(0.002)), "and at a quarter of the pairs: 1 in 1000");
    assert.equal(fires(play(5, 2, 1, 100), "manip.hand", limits(0.0009)), null);
    const fourOfSix = play(6, 2, 1);
    fourOfSix.report.pairs = fourOfSix.report.pairs.map((p) => (p.t >= 40 * apart * 1000 && p.t < 900_000 ? { ...p, hand: p.hand === "left" ? "right" : "left" } : p));
    assert.ok(fires(fourOfSix, "manip.hand", limits(0.31)), "four of six come about once in three plays");
    assert.equal(fires(fourOfSix, "manip.hand", limits(0.3)), null, "the runs on the other side count");
});

test("manip: a part stands up like the headline does, and only over its limits", () => {
    assert.ok(fires(gluedPartPlay(25), "manip.part"));
    assert.equal(fires(gluedPartPlay(0, { pairs: MANIP.minPairs - 1 }), "manip.part"), null, "nothing stands up to be the top");
    const thin = gluedPartPlay(MANIP.minPairs - 1, { pairs: MANIP.minPairs - 1 });
    assert.equal(fires(thin, "manip.part"), null, "a part of too few pairs reads 100 %, and is not told");
    assert.ok(fires(gluedPartPlay(10), "manip.part"), "20 % at a tight spread");
    assert.equal(fires(gluedPartPlay(10, { sd: 60 }), "manip.part"), null, "at this spread about as much comes by itself");
    const limit = (over) => ({ ...HINTS, manip: { ...HINTS.manip, ...over } });
    const gap = 50 - gluedPartPlay(25).report.manip.percent;
    assert.ok(fires(gluedPartPlay(25), "manip.part", limit({ minPartPercent: 50, minPartGap: gap })));
    assert.equal(fires(gluedPartPlay(25), "manip.part", limit({ minPartPercent: 51 })), null);
    assert.equal(fires(gluedPartPlay(25), "manip.part", limit({ minPartGap: gap + 1 })), null);
});

// A family of `pairs` pairs among `others` more, glued in `runs` runs of `each` neighbouring pairs, on the limits as they stand.
function familyRuns({ runs, each = 1, pairs = 50, others = 50 }) {
    const data = manipPlay({ glued: 0, jump: pairs, stream: others });
    const run = (i) => pairsOn(each, MANIP_MS / 2 + i * apart * 1000, { glued: each, gap: 100 });
    const plain = pairsOn(pairs - runs * each, MANIP_MS / 2 + (runs + 1) * apart * 1000);
    const list = [...pairsOn(others, 1000, { gap: 100 }), ...Array.from({ length: runs }, (_, i) => run(i)).flat(), ...plain];
    const glued = runs * each;
    data.report.pairs = list;
    data.report.manip = { ...data.report.manip, ...tally(pairs + others, glued), hands: { left: tally(pairs + others, glued), right: tally(0, 0) } };
    data.report.families = [{ family: "jumpstream", notes: 2000, ur: 150, ...tally(pairs, glued) }, { family: "stream", notes: 2000, ur: 150, ...tally(others, 0) }];
    data.analysis.results = list.flatMap((p) => [result(p.t, p.col), result(p.tb, p.colb)]);
    return data;
}

test("manip: the limits as they stand, a family's chance between what passes and what does not", () => {
    assert.ok(fires(familyRuns({ runs: 10 }), "manip.family"), "ten of ten at half of the pairs: 1 in 1024");
    assert.equal(fires(familyRuns({ runs: 9 }), "manip.family"), null, "nine of nine: 1 in 512");
});

test("manip: the limits as they stand, a hand's chance between what passes and what does not", () => {
    assert.ok(fires(handsPlay(tally(50, 6), tally(50, 0)), "manip.hand"), "six of six at half of the pairs: 1 in 64");
    assert.equal(fires(handsPlay(tally(50, 5), tally(50, 0)), "manip.hand"), null, "five of five: 1 in 32");
});

test("manip: the limits as they stand, three runs at least however few of the pairs the group has", () => {
    const small = (runs) => familyRuns({ runs, each: 2, pairs: 20, others: 2000 });
    assert.equal(fires(small(2), "manip.family"), null, "two runs, at 1 % of the pairs a chance of 1 in 10 000");
    assert.ok(fires(small(3), "manip.family"));
});

test("manip: the limits as they stand, pairs a quarter of a second of play apart are one run", () => {
    assert.equal(fires(runsPlay(0.25, 1, 12), "manip.family"), null);
    assert.ok(fires(runsPlay(0.3, 1, 12), "manip.family"));
    assert.equal(fires(handsPlay(tally(50, 8), tally(50, 0)), "manip.hand", { ...HINTS, manip: { ...HINTS.manip, runSec: HINTS.momentSec } }).id, "manip.hand", "each of these pairs a run of its own");
});

// ---- errors ----
const columnPlay = (ms, hits = 1000) => change((d) => { d.analysis.byColumn = [column(0, 0), column(1, 0), column(2, ms, hits), column(3, 0)]; });

test("errors: the column off from the others, either way", () => {
    const { minMs, minHits } = HINTS.errors;
    const late = fires(columnPlay(minMs), "errors.column");
    assert.equal(late.key, "replay.hint.err.columnLate");
    assert.deepEqual(late.params, { col: 3, ms: minMs });
    assert.equal(fires(columnPlay(-minMs), "errors.column").key, "replay.hint.err.columnEarly");
    silent(columnPlay(under(minMs)));
    silent(columnPlay(minMs, minHits - 1));
    silent(change((d) => { d.analysis.byColumn = [column(0, 0), column(1, 20)]; }));
    silent(change((d) => { d.analysis.byColumn = [column(0, 0), column(1, 20), { col: 2, mean: null, hits: 0 }, { col: 3, mean: null, hits: 0 }]; }));
});

// ---- the hit position ----
const P = HINTS.position;
const leaning = (ms, { plays = P.plays, maps = P.plays, hitPosition = 415 } = {}) => change((d) => {
    d.bias = {
        plays: Array.from({ length: plays }, (_, i) => ({ md5: `map${i % maps}`, mean: ms, at: i, hits: 1000 })),
        position: { hitPosition, maniaSpeed: 24, speedPerMap: false, speedByBpm: false },
    };
});

test("the hit position: a steady lean of the last plays, its direction, never a size of step", () => {
    const late = fires(leaning(P.minMs), "errors.position");
    assert.equal(late.section, "errors");
    assert.equal(late.key, "replay.hint.position.late");
    assert.deepEqual(late.params, { ms: P.minMs, hit: 415 }, "the lean and where the line is now: no step");
    assert.equal(fires(leaning(-P.minMs), "errors.position").key, "replay.hint.position.early");
    assert.equal(fires(leaning(P.minMs), "errors.position").seek, undefined);
    silent(leaning(under(P.minMs)));
    silent(leaning(-under(P.minMs)));
});

test("the hit position: never from one play, too few plays, too few maps, or plays that do not agree", () => {
    silent(leaning(9, { plays: 1, maps: 1 }));
    silent(leaning(9, { plays: P.minPlays - 1 }));
    assert.ok(fires(leaning(9, { plays: P.minPlays, maps: P.minPlays }), "errors.position"));
    silent(leaning(9, { maps: P.minMaps - 1 }));
    assert.ok(fires(leaning(9, { maps: P.minMaps }), "errors.position"));
    const split = leaning(P.minMs * 3);
    const off = Math.floor(P.plays * (1 - P.minShare)) + 1; // too many plays that do not lean with the mean
    split.bias.plays.forEach((p, i) => { p.mean = i < off ? 0 : p.mean; });
    silent(split);
    silent(change((d) => { d.bias = { plays: [], position: null }; }));
    silent(change((d) => { d.bias = null; }));
});

test("the hit position: what is unknown or at its end is not offered", () => {
    assert.equal(fires(leaning(9, { hitPosition: null }), "errors.position").key, "replay.hint.position.lateUnknown");
    assert.deepEqual(fires(leaning(9, { hitPosition: null }), "errors.position").params, { ms: 9 });
    assert.equal(fires(leaning(-9, { hitPosition: null }), "errors.position").key, "replay.hint.position.earlyUnknown");
    assert.equal(fires(leaning(9, { hitPosition: P.hitHigh }), "errors.position").key, "replay.hint.position.lateEnd", "the line is at the bottom already");
    assert.equal(fires(leaning(-9, { hitPosition: P.hitLow }), "errors.position").key, "replay.hint.position.earlyEnd");
    assert.equal(fires(leaning(-9, { hitPosition: P.hitHigh }), "errors.position").key, "replay.hint.position.early");
    const none = leaning(9);
    delete none.bias.position;
    assert.equal(fires(none, "errors.position").key, "replay.hint.position.lateUnknown");
});

test("the hit position: pressing late means a larger value, it is something to try and compare, the judging stays", () => {
    const words = {
        en: { "replay.hint.position.late": /larger HitPosition/, "replay.hint.position.lateUnknown": /larger HitPosition/, "replay.hint.position.early": /smaller HitPosition/, "replay.hint.position.earlyUnknown": /smaller HitPosition/ },
        ru: { "replay.hint.position.late": /увеличить HitPosition/, "replay.hint.position.lateUnknown": /увеличить HitPosition/, "replay.hint.position.early": /уменьшить HitPosition/, "replay.hint.position.earlyUnknown": /уменьшить HitPosition/ },
    };
    try {
        for (const [lang, list] of Object.entries(words)) {
            setLang(lang);
            for (const [key, re] of Object.entries(list)) {
                const text = t(key, { ms: 9, hit: 415 });
                assert.match(text, re);
                assert.match(text, lang === "ru" ? /сравни/ : /compare/);
                assert.match(text, lang === "ru" ? /оффсет/ : /offset/);
                assert.match(text, lang === "ru" ? /Судейство/ : /Judging/);
            }
        }
    } finally {
        setLang("ru");
    }
});

test("the lean's answer says whether it tells anything, so that the tab need not draw for one that does not", () => {
    assert.equal(biasTells(leaning(9).bias), true);
    assert.equal(biasTells(leaning(under(P.minMs)).bias), false);
    assert.equal(biasTells({ plays: [], position: null }), false);
    assert.equal(biasTells(null), false);
});

// ---- drift ----
const driftPlay = (firstUr, lastUr, edit = () => {}) => change((d) => {
    d.report.drift = { first: { ur: firstUr, mean: 0, hits: 1000 }, last: { ur: lastUr, mean: 0, hits: 1000 }, urChange: lastUr - firstUr, meanChange: 0 };
    edit(d);
});
const driftLimits = (over = {}) => ({ ...HINTS, drift: { ...HINTS.drift, minRise: 50, minRatio: 1.5, ...over } });
const spread = (first, last) => [...Array.from({ length: first }, (_, i) => result(i, 0)), ...Array.from({ length: last }, (_, i) => result(250_000 + i, 0))];

test("drift: UR rising to the end looks like fatigue, unless the end of the map is simply denser", () => {
    const tired = fires(driftPlay(100, 150, (d) => { d.analysis.results = spread(100, 100); }), "drift.fatigue", driftLimits());
    assert.equal(tired.key, "replay.hint.drift.tired");
    assert.deepEqual(tired.params, { start: 100, end: 150 });
    const denser = fires(driftPlay(100, 150, (d) => { d.analysis.results = spread(100, 100 * HINTS.drift.denser); }), "drift.fatigue", driftLimits());
    assert.equal(denser.key, "replay.hint.drift.denser");
    silent(driftPlay(100, 149), driftLimits({ minRatio: 1.1 }));
    silent(driftPlay(100, 150), driftLimits({ minRatio: 1.51 }));
    silent(driftPlay(100, 150, notWhole), driftLimits());
    silent(driftPlay(100, 150, (d) => { d.report.drift.first = null; }), driftLimits());
});

test("drift: presses sliding later or earlier towards the end", () => {
    const { minSlide } = HINTS.drift;
    const slide = (ms, edit = () => {}) => driftPlay(100, 100, (d) => { d.report.drift.meanChange = ms; edit(d); });
    assert.equal(fires(slide(minSlide), "drift.slide").key, "replay.hint.drift.later");
    assert.equal(fires(slide(-minSlide), "drift.slide").key, "replay.hint.drift.earlier");
    silent(slide(under(minSlide)));
    silent(slide(minSlide, notWhole));
    silent(change((d) => { d.report.drift = { first: null, last: null, urChange: null, meanChange: null }; }));
});

test("drift: neither rule stands on a third with too few hits, and a mean takes more of them than a spread", () => {
    const { minFatigueHits, minSlideHits, minSlide } = HINTS.drift;
    assert.ok(minSlideHits > minFatigueHits);
    const thirds = (firstHits, lastHits, edit = () => {}) => (d) => { d.report.drift.first.hits = firstHits; d.report.drift.last.hits = lastHits; edit(d); };
    assert.ok(fires(driftPlay(100, 150, thirds(minFatigueHits, minFatigueHits)), "drift.fatigue", driftLimits()));
    silent(driftPlay(100, 150, thirds(minFatigueHits - 1, 1000)), driftLimits());
    silent(driftPlay(100, 150, thirds(1000, minFatigueHits - 1)), driftLimits());
    const sliding = (d) => { d.report.drift.meanChange = minSlide * 2; };
    assert.ok(fires(driftPlay(100, 100, thirds(minSlideHits, minSlideHits, sliding)), "drift.slide"));
    silent(driftPlay(100, 100, thirds(minSlideHits - 1, 1000, sliding)));
    silent(driftPlay(100, 100, thirds(1000, minSlideHits - 1, sliding)));
});

// ---- pace ----
// `written` notes a second; lostAt: { second of the play: notes of it left unpressed }
function paceOf(written, lostAt = {}, { rate = 1, fromMs = 0 } = {}) {
    return change((d) => {
        d.report.pace = { written, played: written, peakWritten: Math.max(...written), peakPlayed: Math.max(...written), stretches: [] };
        Object.assign(d.analysis, { rate, fromMs });
        d.analysis.results = written.flatMap((n, s) => Array.from({ length: n }, (_, i) => result(fromMs + (s * 1000 + i) * rate, i % 4, i < (lostAt[s] ?? 0) ? { press: null } : {})));
    });
}
const seconds = (...blocks) => blocks.flatMap(([n, notes]) => new Array(n).fill(notes));
// `calm` seconds at `calmNotes` notes a second, then `dense` at 20, with `lost` notes left unpressed there in `moments` moments
// and `slip` under it
function pacePlay({ calm = 20, dense = 20, lost = 12, moments = 3, slip = 0, calmNotes = 5, rate = 1, fromMs = 0 } = {}) {
    const lostAt = { 0: slip };
    for (let i = 0; i < lost; i += 1) {
        const second = calm + 2 + (i % moments) * apart;
        lostAt[second] = (lostAt[second] ?? 0) + 1;
    }
    return paceOf(seconds([calm, calmNotes], [dense, 20]), lostAt, { rate, fromMs });
}
const paceLimits = (over = {}) => ({ ...HINTS, pace: { ...HINTS.pace, minSec: 10, minLost: 5, minAbove: 0.01, maxUnder: 0.002, minMoments: 3, maxChance: 1, ...over } });

test("pace: the density from which notes stop being pressed", () => {
    const smooth = (PACE.smoothSec - 1) / 2;
    const h = fires(pacePlay(), "pace.ceiling", paceLimits());
    assert.equal(h.key, "replay.hint.pace.ceiling");
    assert.ok(h.params.keep > 5 && h.params.keep <= 20, `the ceiling is between the two (${h.params.keep})`);
    assert.ok(h.seek >= (20 - smooth) * 1000 - 500 && h.seek < 40_000, "a place on the map, where the first note is left");
    assert.equal(fires(pacePlay({ lost: 4 }), "pace.ceiling", paceLimits()), null, "too few notes left unpressed");
    assert.ok(fires(pacePlay({ calm: 14, dense: 14 }), "pace.ceiling", paceLimits({ minSec: 14 })));
    assert.equal(fires(pacePlay({ calm: 14, dense: 14 }), "pace.ceiling", paceLimits({ minSec: 15 })), null, "too few seconds on either side");
    assert.equal(fires(pacePlay({ calm: 15, dense: 14 }), "pace.ceiling", paceLimits({ minSec: 15 })), null, "too few seconds over it");
    assert.equal(fires(pacePlay({ calm: 14, dense: 15 }), "pace.ceiling", paceLimits({ minSec: 15 })), null, "too few seconds under it");
    assert.equal(fires(pacePlay({ lost: 5 }), "pace.ceiling", paceLimits({ minAbove: 0.02 })), null, "too small a share over it");
    assert.equal(fires(pacePlay({ slip: 2 }), "pace.ceiling", paceLimits()), null, "notes left under it too: then it is no ceiling");
    const unsure = pacePlay();
    notExact(unsure);
    assert.equal(fires(unsure, "pace.ceiling", paceLimits()), null);
});

test("pace: a ceiling's place goes by the rate of the play", () => {
    assert.equal(fires(pacePlay({ rate: 1.5, fromMs: 1000 }), "pace.ceiling", paceLimits()).seek, 22 * 1000 * 1.5 + 1000 - 500, "half a second before the first note left");
});

test("pace: a collapse that ends a failed play is no ceiling", () => {
    const failed = pacePlay();
    notWhole(failed);
    assert.equal(fires(failed, "pace.ceiling", paceLimits()), null);
});

test("pace: it takes separate moments, one stumble is one however many notes went in it", () => {
    const { minMoments } = HINTS.pace;
    const play = (moments) => pacePlay({ lost: moments * 4, moments });
    assert.ok(fires(play(minMoments), "pace.ceiling", paceLimits({ minMoments })));
    assert.equal(fires(play(minMoments - 1), "pace.ceiling", paceLimits({ minMoments })), null);
    assert.ok(fires(play(minMoments - 1), "pace.ceiling", paceLimits({ minMoments: minMoments - 1 })));
    assert.equal(fires(pacePlay({ lost: 30, moments: 1 }), "pace.ceiling", paceLimits()), null, "thirty notes of one stumble");
});

test("pace: lost seconds at most momentSec of play apart are one moment", () => {
    const { momentSec } = HINTS;
    const written = seconds([30, 5], [40, 20]);
    const lostAt = (gap) => ({ 40: 4, [40 + gap]: 4, [40 + gap * 2]: 4 });
    assert.equal(fires(paceOf(written, lostAt(momentSec)), "pace.ceiling", paceLimits()), null, "exactly the limit apart");
    assert.ok(fires(paceOf(written, lostAt(momentSec + 1)), "pace.ceiling", paceLimits()), "a second more");
    assert.equal(fires(paceOf(written, lostAt(momentSec), { rate: 1.5 }), "pace.ceiling", paceLimits()), null, "seconds of play, whatever the rate");
    assert.equal(fires(paceOf(written, lostAt(momentSec), { rate: 0.75 }), "pace.ceiling", paceLimits()), null);
    assert.ok(fires(paceOf(written, lostAt(momentSec + 1), { rate: 0.75 }), "pace.ceiling", paceLimits()));
});

test("pace: a moment is grouped once, over all the lost seconds, so a density cannot part it into more moments than there are", () => {
    // 30 to 34 are one moment, and over the density only 30, 32 and 34, twice momentSec apart: on their own, three of one. Smoothed
    // over three seconds, the seconds with few notes between those with many are the denser ones
    const { momentSec } = HINTS;
    const written = seconds([29, 5], [1, 20], [1, 5], [1, 20], [1, 5], [1, 20], [1, 5], [1, 20], [30, 5]);
    const lostAt = { 30: 4, [30 + momentSec]: 1, [30 + momentSec * 2]: 4, [30 + momentSec * 3]: 1, [30 + momentSec * 4]: 4 };
    assert.equal(momentSec, 1, "the blocks above are drawn for this limit");
    assert.equal(fires(paceOf(written, lostAt), "pace.ceiling", paceLimits({ minSec: 3, maxUnder: 1, maxChance: 0.5 })), null);
});

test("pace: a moment counts over a density when most of its lost notes are", () => {
    // each moment has `over` notes in a second at 10, smoothed, and `under` in one at 5, the play's lowest, momentSec apart
    const { momentSec } = HINTS;
    const play = (over, under) => {
        const block = 6;
        const written = seconds([20, 5], ...Array.from({ length: 3 }, () => [[3, 20], [block - 3, 5]]).flat(), [20, 5]);
        const lostAt = {};
        for (let i = 0; i < 3; i += 1) Object.assign(lostAt, { [23 + i * block]: over, [23 + momentSec + i * block]: under });
        return paceOf(written, lostAt);
    };
    const limits = paceLimits({ minSec: 5, minLost: 3, maxUnder: 1 });
    assert.equal(momentSec, 1, "the blocks above are drawn for this limit");
    assert.ok(fires(play(3, 2), "pace.ceiling", limits));
    assert.equal(fires(play(2, 2), "pace.ceiling", limits), null, "half is not most");
    assert.equal(fires(play(1, 2), "pace.ceiling", limits), null, "and a note of a moment does not make it over");
});

test("pace: as many moments over a density as the notes there give by themselves make no ceiling", () => {
    // 76 % of the notes are over the ceiling found, so three of three come 44 times in 100
    assert.ok(fires(pacePlay(), "pace.ceiling", paceLimits({ maxChance: 0.44 })));
    assert.equal(fires(pacePlay(), "pace.ceiling", paceLimits({ maxChance: 0.43 })), null, "by the notes, not by the seconds, which would make it 11");
    const sure = paceLimits({ maxChance: 0.01 });
    assert.equal(fires(pacePlay(), "pace.ceiling", sure), null);
    assert.ok(fires(pacePlay({ calm: 300 }), "pace.ceiling", sure), "nor three of three where there are few of the notes");
    assert.equal(fires(pacePlay({ calmNotes: 0 }), "pace.ceiling", paceLimits({ maxChance: 0.85 })), null, "nothing under it to set it against");
    // a fourth moment, under it: three of four come 75 times in 100
    const under = (maxChance) => fires(paceOf(seconds([20, 5], [20, 20]), { 2: 1, 22: 4, 26: 4, 30: 4 }), "pace.ceiling", paceLimits({ maxUnder: 1, maxChance }));
    assert.ok(under(0.76));
    assert.equal(under(0.74), null, "the moments under it count");
});

test("pace: the limits as they stand", () => {
    // three of three over the ceiling at the notes' share there, the chance on either side of the limit, and of the limit before it
    assert.ok(fires(pacePlay({ calm: 130 }), "pace.ceiling"), "47 in 1000");
    assert.equal(fires(pacePlay({ calm: 125 }), "pace.ceiling"), null, "51 in 1000");
    assert.ok(fires(pacePlay({ calm: 300 }), "pace.ceiling"), "and 8 in 1000");
    assert.equal(fires(pacePlay({ calm: 700, moments: 2 }), "pace.ceiling"), null, "two moments, whatever their chance");
    assert.ok(fires(pacePlay({ calm: 700 }), "pace.ceiling"), "three");
    const stumbles = (gap) => paceOf(seconds([700, 5], [40, 20]), { 710: 0, 712: 4, [712 + gap]: 4, [712 + gap * 2]: 4 });
    assert.equal(fires(stumbles(1), "pace.ceiling"), null, "a second apart: one moment");
    assert.ok(fires(stumbles(2), "pace.ceiling"), "two: three of them");
});

test("pace: the best of the densities that pass, not the last", () => {
    // most of what is lost at 12 a second, a note now and then at 20: over 20 it would pass too, but it parts the two worse
    const written = seconds([40, 5], [30, 12], [30, 20]);
    const lostAt = { 44: 6, 50: 6, 56: 6, 74: 1, 80: 1, 86: 1 };
    const h = fires(paceOf(written, lostAt), "pace.ceiling", paceLimits({ minLost: 3, minAbove: 0.001, maxUnder: 1 }));
    assert.equal(h.params.keep, 10);
    // over 20 the share is the larger, but so is what it leaves under it: the notes lost at 12 are the ceiling's too
    const close = paceOf(seconds([40, 5], [50, 12], [30, 20]), { 44: 4, 54: 4, 64: 4, 94: 6, 100: 6, 106: 6 });
    assert.equal(fires(close, "pace.ceiling", paceLimits({ maxUnder: 1 })).params.keep, 10);
});

test("pace: an early miss was pressed, too soon: it is no note left unpressed", () => {
    const early = (play) => {
        for (const r of play.analysis.results) if (r.press === null) r.early = true;
        return play;
    };
    assert.equal(fires(early(pacePlay()), "pace.ceiling", paceLimits()), null, "over the ceiling they do not make one");
    const under = pacePlay({ slip: 2 });
    for (const r of under.analysis.results.slice(0, 2)) r.early = true;
    assert.ok(fires(under, "pace.ceiling", paceLimits()), "and under it they do not spoil one");
});

test("pace: a stretch of falling behind long enough, with its place", () => {
    const { minBehindSec } = HINTS.pace;
    const behind = (sec) => change((d) => {
        d.analysis.fromMs = 1000;
        d.analysis.rate = 1.5;
        d.report.pace = { written: new Array(60).fill(5), played: new Array(60).fill(5), peakWritten: 5, peakPlayed: 5, stretches: [{ kind: "behind", fromSec: 10, toSec: 10 + sec, written: 12, played: 8 }, { kind: "spam", fromSec: 40, toSec: 59, written: 5, played: 9 }] };
    });
    const h = fires(behind(minBehindSec), "pace.behind");
    assert.deepEqual(h.params, { from: 16000, to: 16000 + minBehindSec * 1500, played: 8, written: 12 });
    assert.equal(h.seek, 15500);
    silent(behind(minBehindSec - 1));
});

// ---- holds ----
const holds = (count, late, early, more = {}) => ({ count, clean: count - late - early, early, late, dropped: 0, meanRelease: 0, earlyMean: -60, lateMean: 70, ...more });
const holdPlay = (edit) => change((d) => {
    d.analysis.holds = true;
    d.report.fingers[0].holds = holds(12, 3, 0);
    d.report.fingers[1].holds = holds(12, 4, 0);
    edit?.(d);
});
const holdLimits = (over = {}) => ({ ...HINTS, holds: { ...HINTS.holds, minHolds: 24, minCount: 7, minLate: 7 / 24, minEarly: 0.25, ...over } });

test("holds: how many were let go late or early and by how much", () => {
    const h = fires(holdPlay(), "holds.late", holdLimits());
    assert.equal(h.key, "replay.hint.hold.late");
    assert.deepEqual(h.params, { n: 7, of: 24, ms: 70 });
    const data = holdPlay((d) => {
        d.report.fingers[0].holds = holds(12, 0, 3, { earlyMean: -40 });
        d.report.fingers[1].holds = holds(12, 0, 4, { earlyMean: -75 });
    });
    const early = fires(data, "holds.early", holdLimits({ minEarly: 7 / 24 }));
    assert.equal(early.key, "replay.hint.hold.early");
    assert.deepEqual(early.params, { n: 7, of: 24, ms: 60 }, "the mean of both, counted by how many");
});

test("holds: not under the limits or the sample, and only when the data is sure", () => {
    silent(holdPlay(), holdLimits({ minHolds: 25 }));
    silent(holdPlay(), holdLimits({ minCount: 8 }));
    silent(holdPlay(), holdLimits({ minLate: 0.3 }));
    silent(holdPlay(notExact), holdLimits());
    silent(holdPlay(withV2), holdLimits());
    assert.ok(fires(holdPlay((d) => { d.analysis.holdHeavy = true; d.analysis.comparison = { same: true }; }), "holds.late", holdLimits()), "a hold-heavy map whose recount matches the header");
    silent(change(() => {}), holdLimits());
});

// ---- ghosts ----
const ghostLimits = (over = {}) => ({ ...HINTS, ghosts: { ...HINTS.ghosts, maxChance: 1, ...over } });
const ghostPlay = (byColumn, inFlow) => change((d) => {
    const total = byColumn.reduce((a, b) => a + b, 0);
    d.report.ghosts = { total, idle: total - inFlow, inFlow, byColumn, bins: new Array(60).fill(0) };
});

test("ghosts: most of them on one column, in the flow", () => {
    const limits = ghostLimits({ minTotal: 10, minColumnShare: 0.5, minFlowShare: 0.8 });
    const h = fires(ghostPlay([1, 5, 2, 2], 8), "ghosts.column", limits);
    assert.equal(h.key, "replay.hint.ghost.column");
    assert.deepEqual(h.params, { n: 5, of: 10, col: 2 });
    silent(ghostPlay([1, 4, 3, 2], 8), limits);
    silent(ghostPlay([1, 5, 2, 2], 7), limits);
    silent(ghostPlay([1, 5, 2, 1], 8), limits);
});

test("ghosts: what falls on one of four columns often enough by itself is not told", () => {
    assert.equal(fires(ghostPlay([2, 1, 1, 4], 8), "ghosts.column"), null, "half of eight");
    assert.equal(fires(ghostPlay([2, 7, 2, 1], 12), "ghosts.column"), null, "7 of 12 comes about once in 70 plays");
    assert.ok(fires(ghostPlay([1, 8, 2, 1], 12), "ghosts.column"), "8 of 12 about once in 350");
    assert.equal(fires(ghostPlay([1, 8, 2, 1], 12), "ghosts.column", ghostLimits({ maxChance: 0.002 })), null);
    assert.ok(fires(ghostPlay([1, 7, 2, 1], 11), "ghosts.column", ghostLimits({ minTotal: 11, maxChance: 0.01 })), "the fewer the more of them it takes");
});

// ---- breaks ----
// 90 streams after 10 jumps; a break's shape is taken from what is written at it
const rollThenJumps = () => {
    const out = [];
    for (let i = 0; i < 90; i += 1) out.push(result(i * 100, i % 4));
    for (let i = 0; i < 10; i += 1) out.push(result(10_000 + i * 1000, 0), result(10_000 + i * 1000, 1));
    return out;
};
const brk = (t, shape, cause = "none", part = 0) => ({ t, col: 0, combo: 10, shape, cause, part });
const breakPlay = (list, edit = () => {}) => change((d) => {
    d.analysis.results = rollThenJumps();
    d.report.breaks = list;
    edit(d);
});
const breakLimits = (over = {}) => ({ ...HINTS, breaks: { ...HINTS.breaks, minBreaks: 8, minOnShape: 6, minShare: 0.75, minLift: 2, minCause: 0.6, minMoments: 3, maxChance: 1, ...over } });
// each break a moment of its own
const onJumps = (n, others, cause = "none") => [...Array.from({ length: n }, (_, i) => brk(i * apart * 1000, "jump", cause)), ...Array.from({ length: others }, (_, i) => brk((n + i) * apart * 1000, "stream"))];
// each moment of `shapes` a second apart, all of them on `shapes`
const inMoments = (moments, ...shapes) => Array.from({ length: moments }, (_, i) => shapes.map((shape, j) => brk(i * 10 * apart * 1000 + j * 1000, shape))).flat();

test("breaks: the shape they fall on and how, worded by the cause", () => {
    const h = fires(breakPlay(onJumps(6, 2)), "breaks.shape", breakLimits());
    assert.equal(h.key, "replay.hint.break.none");
    assert.deepEqual(h.params, { n: 6, of: 8, shape: "jump" });
    assert.equal(fires(breakPlay(onJumps(6, 2, "early")), "breaks.shape", breakLimits()).key, "replay.hint.break.early");
    const hold = breakPlay(onJumps(6, 2, "released"));
    assert.equal(fires(hold, "breaks.shape", breakLimits()).key, "replay.hint.break.released");
    const mixed = onJumps(6, 2);
    for (const b of mixed.slice(0, 3)) b.cause = "early";
    assert.equal(fires(breakPlay(mixed), "breaks.shape", breakLimits()).key, "replay.hint.break.shape", "no cause stands out");
    assert.deepEqual(fires(breakPlay(mixed), "breaks.shape", breakLimits()).params, { n: 6, of: 8, shape: "jump" });
});

test("breaks: a cause worded counts only the breaks that had it", () => {
    const list = onJumps(6, 2);
    list[0].cause = "early";
    const h = fires(breakPlay(list), "breaks.shape", breakLimits({ minOnShape: 5 }));
    assert.equal(h.key, "replay.hint.break.none");
    assert.deepEqual(h.params, { n: 5, of: 8, shape: "jump" }, "5 not pressed of the 6 on jumps");
});

test("breaks: a cause is worded from its share on, and on as many breaks as a shape takes", () => {
    const mixed = (n, others, none) => onJumps(n, others).map((b, i) => (i < n - none ? { ...b, cause: "early" } : b));
    const limits = (over) => breakLimits({ minOnShape: 6, minShare: 0.5, minCause: 0.6, ...over });
    assert.equal(fires(breakPlay(mixed(10, 2, 6)), "breaks.shape", limits()).key, "replay.hint.break.none", "exactly at the limit");
    assert.equal(fires(breakPlay(mixed(10, 2, 6)), "breaks.shape", limits({ minCause: 0.61 })).key, "replay.hint.break.shape");
    const few = fires(breakPlay(mixed(5, 3, 3)), "breaks.shape", limits({ minBreaks: 5, minOnShape: 4 }));
    assert.equal(few.key, "replay.hint.break.shape", "3 of 5 is share enough, but 3 are too few to tell a cause by");
    assert.deepEqual(few.params, { n: 5, of: 8, shape: "jump" });
    assert.equal(fires(breakPlay(mixed(5, 3, 4)), "breaks.shape", limits({ minBreaks: 5, minOnShape: 4 })).key, "replay.hint.break.none");
});

test("breaks: a shape needs breaks of its own, however few there are in all", () => {
    assert.equal(fires(breakPlay(onJumps(5, 2)), "breaks.shape", breakLimits({ minBreaks: 7, minShare: 0.5 })), null, "too few on the shape");
    assert.ok(fires(breakPlay(onJumps(6, 2)), "breaks.shape", breakLimits({ minBreaks: 7, minShare: 0.5 })));
    assert.equal(buildHints(breakPlay(onJumps(2, 2))).top.length, 0, "two of four is no main point");
    assert.ok(HINTS.breaks.minOnShape >= 4);
});

test("breaks: as many on a shape as chance gives by itself are not told, however large the lift", () => {
    // about a fifth of the notes are jumps here: 3 of 6 on them comes by itself, 5 of 8 does not
    const limits = breakLimits({ minBreaks: 5, minOnShape: 4, minShare: 0.5, minLift: 2, maxChance: 0.01 });
    assert.equal(fires(breakPlay(onJumps(3, 3)), "breaks.shape", { ...limits, breaks: { ...limits.breaks, minOnShape: 3 } }), null);
    assert.ok(fires(breakPlay(onJumps(5, 3)), "breaks.shape", limits));
    const tight = { ...limits, breaks: { ...limits.breaks, maxChance: 0.000001 } };
    assert.equal(fires(breakPlay(onJumps(5, 3)), "breaks.shape", tight), null);
    assert.ok(fires(breakPlay(onJumps(40, 0)), "breaks.shape", tight), "and a long list of them is plain");
});

test("breaks: a shape takes separate moments, one stumble is one however many breaks went in it", () => {
    const limits = breakLimits({ minBreaks: 5, minOnShape: 4, minShare: 0.5, minLift: 1 });
    const { minMoments } = limits.breaks;
    const play = (moments) => breakPlay(inMoments(moments, "jump", "jump", "jump"));
    assert.deepEqual(fires(play(minMoments), "breaks.shape", limits).params, { n: minMoments * 3, of: minMoments * 3, shape: "jump" }, "the text says the breaks, they are true");
    assert.equal(fires(play(minMoments - 1), "breaks.shape", limits), null);
    assert.ok(fires(play(minMoments - 1), "breaks.shape", breakLimits({ ...limits.breaks, minMoments: minMoments - 1 })));
    assert.equal(fires(breakPlay(inMoments(1, "jump", "jump", "jump", "jump", "jump", "jump", "stream", "stream")), "breaks.shape", limits), null, "6 of 8 in one moment");
    assert.equal(fires(breakPlay(inMoments(1, "jump", "jump", "jump", "jump", "jump", "jump", "stream", "stream")), "breaks.shape"), null);
});

test("breaks: breaks at most momentSec of play apart are one moment", () => {
    const limits = breakLimits({ minBreaks: 5, minOnShape: 4, minShare: 0.5, minLift: 1 });
    const every = (sec, rate = 1) => breakPlay(Array.from({ length: 6 }, (_, i) => brk(i * sec * 1000, "jump")), (d) => { d.analysis.rate = rate; });
    assert.equal(fires(every(HINTS.momentSec), "breaks.shape", limits), null, "exactly the limit apart");
    assert.ok(fires(every(HINTS.momentSec + 1), "breaks.shape", limits), "a second more");
    assert.equal(fires(every(HINTS.momentSec * 1.5, 1.5), "breaks.shape", limits), null, "that much of the map is less of play at a higher rate");
    assert.ok(fires(every(HINTS.momentSec, 0.75), "breaks.shape", limits), "and more at a lower one");
    const judged = every(HINTS.momentSec);
    const [a, b, c, d, e, f] = judged.report.breaks;
    judged.report.breaks = [a, c, b, e, d, f]; // a hold let go is judged at its end, after the notes under it
    assert.equal(fires(judged, "breaks.shape", limits), null, "by the time of the notes, in whatever order they were judged");
});

test("breaks: a moment is grouped once, over all the breaks, so a shape cannot part it into more moments than there are", () => {
    // one chain of breaks momentSec apart, every other one on jumps: on their own those are three moments of one
    const chain = ["jump", "stream", "jump", "stream", "jump"].map((shape, i) => brk(i * HINTS.momentSec * 1000, shape));
    assert.equal(fires(breakPlay(chain), "breaks.shape", breakLimits({ minBreaks: 5, minOnShape: 3, minShare: 0.5, minLift: 1, maxChance: 0.5 })), null);
});

test("breaks: a moment counts on a shape when most of its breaks are", () => {
    const limits = breakLimits({ minBreaks: 5, minOnShape: 4, minShare: 0.5, minLift: 1 });
    assert.ok(fires(breakPlay(inMoments(3, "jump", "jump", "stream")), "breaks.shape", limits));
    assert.equal(fires(breakPlay(inMoments(3, "jump", "jump", "stream", "stream")), "breaks.shape", limits), null, "half is not most");
});

test("breaks: moments are held against the written share of the shape, each moment once", () => {
    // about a fifth of the notes are jumps: three moments of six on them come 8 times in 100
    const list = [...inMoments(3, "jump", "jump", "jump"), ...inMoments(3, "stream", "stream", "stream").map((b) => ({ ...b, t: b.t + 400_000 }))];
    const limits = (maxChance) => breakLimits({ minBreaks: 5, minOnShape: 4, minShare: 0.5, minLift: 1, maxChance });
    assert.ok(fires(breakPlay(list), "breaks.shape", limits(0.08)));
    assert.equal(fires(breakPlay(list), "breaks.shape", limits(0.07)), null);
});

test("breaks: the limits as they stand, a shape", () => {
    // jumps are 18 % of the notes here, or 10 % with fewer of them
    const scarce = () => {
        const out = [];
        for (let i = 0; i < 90; i += 1) out.push(result(i * 100, i % 4));
        for (let i = 0; i < 5; i += 1) out.push(result(10_000 + i * 1000, 0), result(10_000 + i * 1000, 1));
        return out;
    };
    assert.ok(fires(breakPlay(onJumps(4, 2)), "breaks.shape"), "four of six come 12 times in 1000");
    assert.equal(fires(breakPlay(onJumps(5, 5)), "breaks.shape"), null, "five of ten 23 times in 1000");
    const moments = (n) => breakPlay(inMoments(n, "jump", "jump", "jump"), (d) => { d.analysis.results = scarce(); });
    assert.equal(fires(moments(2), "breaks.shape"), null, "two moments, whatever their chance");
    assert.ok(fires(moments(3), "breaks.shape"), "three");
    const every = (sec) => breakPlay(Array.from({ length: 6 }, (_, i) => brk(i * sec * 1000, "jump")));
    assert.equal(fires(every(1), "breaks.shape"), null, "a second apart: one moment");
    assert.ok(fires(every(2), "breaks.shape"), "two: six of them");
});

test("breaks: on a long map the shapes are sampled, and tell the same", () => {
    let looks = 0;
    const long = breakPlay(onJumps(6, 2), (d) => {
        const list = Array.from({ length: 40 }, () => rollThenJumps()).flat().map((r, i) => ({ ...r, t: i * 100 }));
        list.slice = function counted(...range) {
            looks += 1;
            return Array.prototype.slice.apply(this, range);
        };
        d.analysis.results = list;
    });
    assert.ok(fires(long, "breaks.shape", breakLimits({ shapeNotes: 400 })));
    assert.ok(looks <= 400, `a look at at most the limit's notes (${looks})`);
});

test("breaks: a long map's share of a shape is of the notes looked at, not of all it has", () => {
    const jumps = Array.from({ length: 2000 }, (_, i) => [result(i * 1000, 0), result(i * 1000, 1)]).flat();
    const play = breakPlay(onJumps(6, 2), (d) => { d.analysis.results = jumps; });
    assert.equal(fires(play, "breaks.shape", breakLimits({ shapeNotes: 400 })), null, "the long map is nearly all jumps");
});

test("breaks: not on what the map is simply made of, not on too few, not when they are not told exactly", () => {
    const stream = Array.from({ length: 8 }, (_, i) => brk(i, "stream"));
    assert.equal(fires(breakPlay(stream), "breaks.shape", breakLimits()), null, "the map is nearly all streams");
    assert.equal(fires(breakPlay(onJumps(6, 2)), "breaks.shape", breakLimits({ minBreaks: 9 })), null, "too few breaks");
    assert.equal(fires(breakPlay(onJumps(6, 3)), "breaks.shape", breakLimits()), null, "too small a share");
    assert.equal(fires(breakPlay(onJumps(6, 2)), "breaks.shape", breakLimits({ minLift: 100 })), null);
    assert.equal(fires(breakPlay(onJumps(6, 2), notExact), "breaks.shape", breakLimits()), null);
    assert.equal(fires(breakPlay(Array.from({ length: 8 }, (_, i) => brk(i, null))), "breaks.shape", breakLimits()), null, "no shape known");
});

const partOf = (index, fromMs) => ({ index, fromMs, toMs: fromMs + 30_000, notes: 500 });
// the parts of a map of three, and `list` on it
const partPlay = (list, edit = () => {}) => breakPlay(list, (d) => {
    d.report.parts = [partOf(0, 0), partOf(1, 30_000), partOf(2, 60_000)];
    edit(d);
});
const partApart = HINTS.breaks.partMomentSec + 1; // seconds of play that keep two moments of a part apart

test("breaks: most of them in one part of the map, with its place", () => {
    const list = (inPart) => [...Array.from({ length: inPart }, (_, i) => brk(32_000 + i * partApart * 1000, "stream", "none", 1)), ...Array.from({ length: 8 - inPart }, (_, i) => brk(i * partApart * 1000, "stream", "none", 0))];
    const play = (inPart, edit) => partPlay(list(inPart), edit);
    const limits = breakLimits({ minInPart: 6, partShare: 0.75 });
    const h = fires(play(6), "breaks.part", limits);
    assert.equal(h.key, "replay.hint.break.part");
    assert.deepEqual(h.params, { n: 6, of: 8, from: 30_000, to: 60_000 });
    assert.equal(h.seek, 31_000);
    assert.equal(fires(play(5), "breaks.part", limits), null);
    assert.equal(fires(play(6), "breaks.part", breakLimits({ minInPart: 7, partShare: 0.5 })), null, "too few in the part");
    assert.equal(fires(play(6), "breaks.part", breakLimits({ minInPart: 6, partShare: 0.76 })), null, "too small a share");
    assert.equal(fires(play(6), "breaks.part", breakLimits({ minInPart: 6, partShare: 0.75, minBreaks: 9 })), null, "too few in all");
    assert.ok(fires(play(6), "breaks.part", breakLimits({ minInPart: 6, partShare: 0.75, maxChance: 0.05 })), "6 of 8 in a third of the map");
    assert.equal(fires(play(6), "breaks.part", breakLimits({ minInPart: 6, partShare: 0.75, maxChance: 0.01 })), null, "chance does that 1 time in 50");
    const large = play(6, (d) => { d.report.parts[1].notes = 9000; });
    assert.equal(fires(large, "breaks.part", breakLimits({ minInPart: 6, partShare: 0.75, maxChance: 0.05 })), null, "and most of the map is simply where most of them fall");
    const only = play(6, (d) => { d.report.parts[0].notes = 0; d.report.parts[2].notes = 0; });
    assert.equal(fires(only, "breaks.part", breakLimits({ minInPart: 6, partShare: 0.75, maxChance: 0.05 })), null, "as it is when all the notes are in that part");
    assert.equal(fires(play(6, (d) => { d.report.parts.pop(); }), "breaks.part", limits), null, "too few parts");
    assert.equal(fires(play(6, notExact), "breaks.part", limits), null);
});

const inPart = (over = {}) => breakLimits({ minBreaks: 5, minInPart: 4, partShare: 0.5, minPartMoments: 3, ...over });
// `moments` moments of three breaks a second apart in the part 1, and `others` breaks, each a moment, in the part 0
const stumblesIn = (moments, others = 0) => [
    ...Array.from({ length: moments }, (_, i) => [0, 1, 2].map((j) => brk(31_000 + i * (partApart + 2) * 1000 + j * 1000, "stream", "none", 1))).flat(),
    ...Array.from({ length: others }, (_, i) => brk(i * partApart * 1000, "stream", "none", 0)),
];

test("breaks: a part takes separate moments, one stumble is one however many breaks went in it", () => {
    assert.deepEqual(fires(partPlay(stumblesIn(3)), "breaks.part", inPart()).params, { n: 9, of: 9, from: 30_000, to: 60_000 }, "the text says the breaks, they are true");
    assert.equal(fires(partPlay(stumblesIn(2)), "breaks.part", inPart()), null);
    assert.ok(fires(partPlay(stumblesIn(2)), "breaks.part", inPart({ minPartMoments: 2 })));
    assert.equal(fires(partPlay(stumblesIn(1, 2)), "breaks.part", inPart({ minPartMoments: 1, minInPart: 3, maxChance: 0.5 })), null, "one of three moments, where the notes give more");
});

test("breaks: breaks in a part at most partMomentSec of play apart are one moment", () => {
    const { partMomentSec } = HINTS.breaks;
    const every = (sec, rate = 1) => partPlay(Array.from({ length: 6 }, (_, i) => brk(31_000 + i * sec * 1000, "stream", "none", 1)), (d) => { d.analysis.rate = rate; });
    assert.equal(fires(every(partMomentSec), "breaks.part", inPart()), null, "exactly the limit apart");
    assert.ok(fires(every(partMomentSec + 1), "breaks.part", inPart()), "a second more");
    assert.equal(fires(every(partMomentSec * 1.5, 1.5), "breaks.part", inPart()), null, "that much of the map is less of play at a higher rate");
    assert.ok(fires(every(partMomentSec, 0.75), "breaks.part", inPart()), "and more at a lower one");
});

test("breaks: the same breaks can be moments of a shape and one moment of a part", () => {
    // a stumble stays in its part to the last break, so a part goes by a longer gap than a shape
    const { momentSec, breaks: { partMomentSec } } = HINTS;
    const gap = momentSec + 1;
    assert.ok(gap <= partMomentSec, "the gap below lies between the two limits");
    const list = Array.from({ length: 6 }, (_, i) => brk(31_000 + i * gap * 1000, "jump", "none", 1));
    assert.ok(fires(partPlay(list), "breaks.shape", breakLimits({ minBreaks: 5, minOnShape: 4, minShare: 0.5, minLift: 1 })), "six moments on the shape");
    assert.equal(fires(partPlay(list), "breaks.part", inPart()), null, "one in the part");
});

test("breaks: a moment is grouped once, over all the breaks, so a part cannot take more moments than there are", () => {
    // one chain partMomentSec apart, every other one in the part: on their own those are three moments of one
    const chain = [1, 0, 1, 0, 1].map((index, i) => brk(30_000 + i * HINTS.breaks.partMomentSec * 1000, "stream", "none", index));
    assert.equal(fires(partPlay(chain), "breaks.part", inPart({ minInPart: 3, maxChance: 0.5 })), null);
});

test("breaks: a moment counts in a part when most of its breaks are, against the part's share of the notes", () => {
    const moment = (at, ...indexes) => indexes.map((index, j) => brk(at + j * 1000, "stream", "none", index));
    const play = (...indexes) => partPlay(Array.from({ length: 3 }, (_, i) => moment(i * 10 * partApart * 1000, ...indexes)).flat());
    const limits = inPart({ minInPart: 3, maxChance: 0.04 });
    assert.ok(fires(play(1, 1, 0), "breaks.part", limits), "three of three in a third of the map: 4 in 100");
    assert.equal(fires(play(1, 1, 0), "breaks.part", inPart({ minInPart: 3, maxChance: 0.03 })), null);
    assert.equal(fires(play(1, 1, 0, 0), "breaks.part", limits), null, "half is not most");
    // the moments of the other parts count: three of five in a third come 21 times in 100
    const five = [...Array.from({ length: 3 }, (_, i) => moment(31_000 + i * partApart * 1000, 1)).flat(), ...moment(0, 0), ...moment(partApart * 1000, 2)];
    assert.ok(fires(partPlay(five), "breaks.part", inPart({ minInPart: 3, maxChance: 0.21 })));
    assert.equal(fires(partPlay(five), "breaks.part", inPart({ minInPart: 3, maxChance: 0.2 })), null);
});

test("breaks: the limits as they stand, a part takes more moments than a shape, for it is the top of the parts", () => {
    const moments = (n, others = 0) => partPlay([...Array.from({ length: n }, (_, i) => brk(31_000 + i * partApart * 1000, "stream", "none", 1)), ...Array.from({ length: others }, (_, i) => brk(i * partApart * 1000, "stream", "none", 0))]);
    assert.ok(fires(moments(6, 2), "breaks.part"), "six of eight in a third of the map: 20 in 1000");
    assert.equal(fires(moments(6, 3), "breaks.part"), null, "six of nine: 42 in 1000");
    const five = moments(5);
    five.report.breaks.push(brk(31_000 + 500, "stream", "none", 1));
    assert.equal(fires(five, "breaks.part"), null, "five moments, whatever their chance");
    assert.ok(fires(moments(6), "breaks.part"), "six");
    const every = (sec) => partPlay(Array.from({ length: 6 }, (_, i) => brk(31_000 + i * sec * 1000, "stream", "none", 1)));
    assert.equal(fires(every(2), "breaks.part"), null, "two seconds apart: one moment");
    assert.ok(fires(every(3), "breaks.part"), "three: six of them");
});

// ---- hardest ----
const hardPlay = (versusRest, notes = 500, edit = () => {}) => change((d) => {
    d.report.hardest = { basis: "dan", parts: [{ fromMs: 89_000, toMs: 118_000, notes, versusRest }, { fromMs: 0, toMs: 30_000, notes, versusRest: versusRest / 2 }, { fromMs: 30_000, toMs: 60_000, notes, versusRest: null }] };
    edit(d);
});

test("hardest: the part furthest under the rest of the map is the place to start", () => {
    const { minDelta, minNotes } = HINTS.hardest;
    const h = fires(hardPlay(-minDelta), "hardest.part");
    assert.equal(h.key, "replay.hint.hard.part");
    assert.deepEqual(h.params, { from: 89_000, to: 118_000, delta: minDelta });
    assert.equal(h.seek, 89_000);
    silent(hardPlay(-under(minDelta)));
    silent(hardPlay(-minDelta, minNotes - 1));
    silent(hardPlay(-minDelta, 500, notWhole));
    silent(hardPlay(-minDelta, 500, notExact));
    silent(hardPlay(minDelta));
});

// ---- dan by part ----
const danPart = (index, dan, accuracy, notes = 500) => ({ index, fromMs: index * 30_000, toMs: (index + 1) * 30_000, dan, accuracy, notes });
const danPlay = (parts, edit = () => {}) => change((d) => {
    d.report.parts = parts;
    d.later = { families: [], spanMs: 0, dans: parts.map((p) => p.dan) };
    edit(d);
});
const steps = (fall) => [danPart(0, 13.0, 97), danPart(1, 13.4, 97), danPart(2, 14.0, fall), danPart(3, 14.5, fall)];

test("dan by part: the dan where the accuracy falls", () => {
    const { minDrop } = HINTS.parts;
    const h = fires(danPlay(steps(97 - minDrop)), "parts.dan");
    assert.equal(h.key, "replay.hint.part.dan");
    assert.deepEqual(h.params, { easy: 13.4, hold: 97, hard: 14, fall: 97 - minDrop });
    assert.equal(h.seek, 60_000, "the worst of the part over it");
    silent(danPlay(steps(97 - under(minDrop))));
    assert.equal(fires(danPlay(steps(90), (d) => { d.later = null; }), "parts.dan"), null, "dans come later");
    assert.equal(fires(danPlay(steps(90), notWhole), "parts.dan"), null);
    assert.equal(fires(danPlay(steps(90), notExact), "parts.dan"), null);
    assert.equal(fires(danPlay([danPart(0, 13, 97), danPart(1, 14, 80)]), "parts.dan"), null, "too few parts");
    assert.equal(fires(danPlay(steps(90).map((p) => ({ ...p, notes: HINTS.parts.minNotes - 1 }))), "parts.dan"), null, "too few notes in each");
    assert.equal(fires(danPlay(steps(90).map((p) => ({ ...p, dan: 13 }))), "parts.dan"), null, "one dan has no step");
    assert.equal(fires(danPlay([danPart(0, 13, 97), danPart(1, 13.02, 97), danPart(2, 13.04, 80)]), "parts.dan"), null, "nor have two dans of one name");
    assert.equal(fires(danPlay([danPart(0, 0.1, 97), danPart(1, 0.2, 80), danPart(2, 0.3, 80)]), "parts.dan"), null, "a dan with no name is not told");
    assert.equal(fires(danPlay([danPart(0, 13, 97), danPart(1, 14, 97), danPart(2, 21, 80)]), "parts.dan"), null, "whichever end");
});

// ---- families ----
const familyPlay = (worst, best, notes = 500) => change((d) => {
    d.later = { families: ["stream"], spanMs: 300_000, dans: [] };
    d.report.families = [{ family: "jumpstream", notes, ur: worst, pairs: 0 }, { family: "stream", notes, ur: best, pairs: 0 }, { family: "jack", notes: 5, ur: 900, pairs: 0 }];
});

test("patterns: the weakest against the best", () => {
    const { minGap, minRatio, minNotes } = HINTS.families;
    const low = minGap / (minRatio - 1);
    const h = fires(familyPlay(low + minGap, low), "families.weak");
    assert.equal(h.key, "replay.hint.family.weak");
    assert.deepEqual(h.params, { family: "jumpstream", ur: Math.round(low + minGap), on: "stream", otherUr: Math.round(low) });
    silent(familyPlay(low + under(minGap), low), { ...HINTS, families: { ...HINTS.families, minRatio: 1.01 } });
    silent(familyPlay(minGap * 10 + minGap, minGap * 10), { ...HINTS, families: { ...HINTS.families, minRatio: 1.2 } });
    silent(familyPlay(low + minGap, low, minNotes - 1));
    assert.equal(fires({ ...familyPlay(low + minGap, low), later: null }, "families.weak"), null);
});

// ---- earlier plays ----
const old = (ur, accuracy = 98, more = {}) => ({ at: 1, rate: 1, modNames: [], accuracy, misses: 0, maxCombo: 1, ur, manip: 0, pairs: 0, whole: true, ...more });
const earlierPlay = (plays, edit = () => {}) => change((d) => {
    d.earlier = { plays, total: plays.length };
    edit(d);
});

test("earlier plays: the same accuracy with a better UR is progress", () => {
    const { minUr, minPlays, sameAccuracy, plays } = HINTS.earlier;
    const better = 150 + minUr;
    const list = new Array(minPlays).fill(old(better));
    const h = fires(earlierPlay(list), "earlier.progress");
    assert.equal(h.key, "replay.hint.earlier.progress");
    assert.deepEqual(h.params, { ur: minUr });
    silent(earlierPlay(new Array(minPlays).fill(old(150 + under(minUr)))));
    silent(earlierPlay(list.slice(1)));
    silent(earlierPlay(new Array(minPlays).fill(old(better, 98 + sameAccuracy + 0.01))));
    silent(earlierPlay(new Array(minPlays).fill(old(better, 98 - sameAccuracy - 0.01))));
    silent(earlierPlay(list, notWhole));
    silent(earlierPlay(list, (d) => { d.analysis.scoreV2 = true; }));
    silent(earlierPlay(list, notExact));
    silent(earlierPlay(new Array(minPlays).fill(old(better, 98, { exact: false }))));
    silent(earlierPlay(new Array(minPlays).fill(old(better, 98, { rate: 1.1 }))));
    silent(earlierPlay(new Array(minPlays).fill(old(better, 98, { modNames: ["HR"] }))));
    silent(earlierPlay(new Array(minPlays).fill(old(better, 98, { whole: false }))));
    silent(earlierPlay(new Array(minPlays).fill(old(null))));
    assert.deepEqual(fires(earlierPlay([old(null), ...list]), "earlier.progress").params, { ur: minUr }, "a play with no UR is left out, not held against as none");
    assert.deepEqual(fires(earlierPlay([old(better, null), ...list]), "earlier.progress").params, { ur: minUr }, "and one with no accuracy");
    assert.deepEqual(fires(earlierPlay([...new Array(plays).fill(old(better)), old(9999)]), "earlier.progress").params, { ur: minUr }, "the last few only");
});

// ---- together ----
// many rules at once: the columns, the fingers, the hands, two of the drift
const busy = () => change((d) => {
    d.analysis.byColumn = [column(0, 0), column(1, 0), column(2, 90), column(3, 0)];
    d.report.fingers[3].ur = 1000;
    d.report.balance.leftAhead = 30;
    d.report.drift = { first: { ur: 100, mean: 0, hits: 1000 }, last: { ur: 500, mean: 90, hits: 1000 }, urChange: 400, meanChange: 90 };
    d.report.hardest = { basis: "nps", parts: [{ fromMs: 1000, toMs: 2000, notes: 500, versusRest: -20 }] };
});

test("the strongest of a play: at most three, one per section, strongest first; at most two in a fold", () => {
    const { top, bySection } = buildHints(busy());
    assert.equal(top.length, 3);
    assert.equal(new Set(top.map((h) => h.section)).size, 3);
    assert.deepEqual(top.map((h) => h.weight), [...top.map((h) => h.weight)].sort((a, b) => b - a));
    assert.equal(top[0].id, "hardest.part");
    for (const list of Object.values(bySection)) assert.ok(list.length <= 2);
    assert.equal(bySection.drift.length, 2);
    assert.equal(buildHints(busy(), { ...HINTS, perSection: 1 }).bySection.drift.length, 1);
    for (const h of Object.values(bySection).flat()) {
        assert.deepEqual(Object.keys(h).filter((k) => !["seek"].includes(k)), ["id", "section", "key", "params", "weight"]);
    }
    const bias = leaning(40);
    const withBias = buildHints({ ...busy(), bias: bias.bias });
    assert.ok(withBias.top.some((h) => h.id === "errors.position"), "the hit position can reach the top");
    assert.ok(withBias.bySection.errors.some((h) => h.id === "errors.position"), "and stays in its fold");
});

test("one hint is a top of one, and a hint's weight grows with how far it stands out", () => {
    assert.equal(buildHints(columnPlay(HINTS.errors.minMs)).top.length, 1);
    const at = (ms) => fires(columnPlay(ms), "errors.column").weight;
    assert.ok(at(HINTS.errors.minMs * 2) > at(HINTS.errors.minMs));
    assert.equal(at(HINTS.errors.minMs * 100), at(HINTS.errors.minMs * HINTS.strongest), "up to a point");
});

test("the texts: both languages, a guess worded as a guess, nothing about cheating, no blame", () => {
    const hints = Object.entries(AREAS.replay).filter(([key]) => key.startsWith("replay.hint."));
    assert.ok(hints.length > 30);
    const text = (key, lang) => {
        setLang(lang);
        return t(key, { start: 120, end: 190 });
    };
    for (const [key] of hints) {
        assert.doesNotMatch(`${text(key, "ru")} ${text(key, "en")}`, /читер|читы|обман|cheat|abuse|плох|ужас|позор|\bbad\b|terrible|awful/i, key);
    }
    for (const key of ["replay.hint.drift.tired", "replay.hint.drift.denser", "replay.hint.ghost.column", "replay.hint.break.none", "replay.hint.break.early"]) {
        assert.match(text(key, "ru"), /похоже/i, key);
        assert.match(text(key, "en"), /looks like/i, key);
    }
    assert.equal(text("replay.hint.drift.tired", "ru"), "К концу UR вырос со 120 до 190, похоже на усталость.");
    setLang("ru");
    assert.equal(t("replay.hint.drift.tired", { start: 90, end: 190 }), "К концу UR вырос с 90 до 190, похоже на усталость.");
    assert.equal(t("replay.hint.drift.tired", { start: 200, end: 300 }), "К концу UR вырос с 200 до 300, похоже на усталость.");
    assert.match(t("replay.hint.pace.ceiling", { keep: 21 }), /до 21 нажатия в секунду/);
    assert.match(t("replay.hint.pace.ceiling", { keep: 11 }), /до 11 нажатий в секунду/);
    assert.match(t("replay.hint.pace.ceiling", { keep: 24 }), /до 24 нажатий в секунду/);
});

test("the texts: Russian takes the singular after a number ending in 1, and after a fraction", () => {
    setLang("ru");
    const say = (key, params) => t(key, { shape: "на стримах", col: 2, finger: "Левый средний", gap: 30, ms: 70, from: "1:00", to: "2:00", ...params });
    assert.match(say("replay.hint.hold.late", { n: 41, of: 151 }), /^41 из 151 холда отпущен поздно/);
    assert.match(say("replay.hint.hold.late", { n: 41, of: 111 }), /^41 из 111 холдов отпущен поздно/);
    assert.match(say("replay.hint.hold.late", { n: 11, of: 150 }), /^11 из 150 холдов отпущены поздно/);
    assert.match(say("replay.hint.hold.early", { n: 42, of: 151 }), /^42 из 151 холда отпущены рано/);
    assert.match(say("replay.hint.hold.early", { n: 21, of: 40 }), /^21 из 40 холдов отпущен рано/);
    for (const key of ["replay.hint.break.shape", "replay.hint.break.none", "replay.hint.break.early", "replay.hint.break.released", "replay.hint.break.off"]) {
        assert.match(say(key, { n: 6, of: 21 }), /^6 из 21 срыва на стримах/, key);
        assert.match(say(key, { n: 6, of: 11 }), /^6 из 11 срывов на стримах/, key);
        assert.match(say(key, { n: 6, of: 22 }), /^6 из 22 срывов на стримах/, key);
    }
    assert.match(say("replay.hint.break.part", { n: 6, of: 31 }), /^6 из 31 срыва на 1:00–2:00/);
    assert.match(say("replay.hint.finger.unevenBreaks", { breaks: 6, of: 21 }), /на нём 6 из 21 срыва\./);
    assert.match(say("replay.hint.finger.unevenBreaks", { breaks: 6, of: 23 }), /на нём 6 из 23 срывов\./);
    assert.match(say("replay.hint.ghost.column", { n: 12, of: 21 }), /^12 из 21 лишнего нажатия на 2-й колонке/);
    assert.match(say("replay.hint.ghost.column", { n: 12, of: 20 }), /^12 из 20 лишних нажатий на 2-й колонке/);
    assert.match(say("replay.hint.pace.behind", { played: 8, written: 21 }), /8 из 21 нажатия в секунду/);
    assert.match(say("replay.hint.pace.behind", { played: 8, written: 12 }), /8 из 12 нажатий в секунду/);
    assert.match(say("replay.hint.pace.behind", { played: "8,4", written: "12,5" }), /8,4 из 12,5 нажатия в секунду/);
});

test("the texts: tech reads as a thing that can be glued", () => {
    setLang("ru");
    assert.equal(t("replay.hint.manip.family", { families: t("replay.hint.many.tech"), percent: 15 }), "Сильнее всего склеены тех-паттерны, 15 %.");
});

// ---- an Interlude play (src/replay/analyzeInterlude.js): no header, exact, judged by its ruleset ----
const SC_SLOTS = [["Marvellous", "max"], ["Perfect", "n300"], ["Great", "n200"], ["Good", "n100"], ["Bad", "n50"], ["Miss", "miss"]];
const interlude = (data) => {
    Object.assign(data.analysis, { source: "interlude", exact: true, holdHeavy: false, comparison: null, ruleset: { name: "SC J4", judgements: SC_SLOTS.map(([name, slot]) => ({ name, slot })) } });
    data.replay = { modNames: null, rate: 1 };
    return data;
};

test("an Interlude play: no header's counts, no mod names, earlier plays without them, and nothing breaks", () => {
    const data = interlude(quiet());
    assert.deepEqual(buildHints(data), { top: [], bySection: {} });
    const worse = 150 + HINTS.earlier.minUr;
    data.earlier = { plays: [old(worse, 98, { modNames: null }), old(worse, 98, { modNames: null })], total: 2 };
    assert.deepEqual(ids(data), ["earlier.progress"], "the same mods: none on either side");
    assert.deepEqual(buildHints({ analysis: null, replay: { modNames: null } }), { top: [], bySection: {} });
});

test("an Interlude play at a rate: its earlier plays are of its rate as the tab shows it, not as its scores keep it", () => {
    const data = interlude(quiet());
    data.analysis.rate = Math.fround(1.1); // 1.100000023841858, what the judging takes
    data.replay = { modNames: ["MR"], rate: 1.1 };
    const worse = 150 + HINTS.earlier.minUr;
    data.earlier = { plays: [old(worse, 98, { rate: 1.1, modNames: ["MR"] }), old(worse, 98, { rate: 1.1, modNames: ["MR"] })], total: 2 };
    assert.deepEqual(ids(data), ["earlier.progress"]);
    data.earlier.plays = data.earlier.plays.map((p) => ({ ...p, rate: 1.15 }));
    assert.deepEqual(ids(data), [], "another rate");
});

// an Interlude analysis's results and the totals the engine gives with them: a judgement per result and per ghost tap
// judged (ghostPoints: the points of each), the accuracy their points over their count
const judgedPlay = (analysis, results, ghostPoints = []) => {
    const points = [...results.map((r) => r.points), ...ghostPoints];
    Object.assign(analysis, {
        results, judgementCounts: [points.length, 0, 0, 0, 0, 0], accuracy: (points.reduce((a, b) => a + b, 0) / points.length) * 100,
    });
};

test("an Interlude play: the accuracy lost to misses by its ruleset's points, in words true below 0 %", () => {
    const judged = (n, kind, points, from) => Array.from({ length: n }, (_, i) => result((from + i) * 100, i % 4, { kind, points, weight: 1 }));
    const data = interlude(quiet());
    judgedPlay(data.analysis, [...judged(900, "max", 1, 0), ...judged(80, "n200", 0.5, 900), ...judged(20, "miss", -1, 980)]);
    // lost: 80 × 0.5 + 20 × 2 of 1000 = 8 %; on misses 20 × 2 = 4 %
    const h = fires(data, "judgements.misses");
    assert.equal(h.key, "replay.hint.judge.mostlyMissesIl");
    assert.deepEqual(h.params, { lost: 8, misses: 4 });
    // SC takes a point away for a miss: 60 misses of 100 notes leave the accuracy at −20 %, 120 % short of 100 %
    const poor = interlude(quiet());
    judgedPlay(poor.analysis, [...judged(40, "max", 1, 0), ...judged(60, "miss", -1, 40)]);
    const below = fires(poor, "judgements.misses");
    assert.equal(below.key, "replay.hint.judge.mostlyMissesIl");
    assert.deepEqual(below.params, { lost: 120, misses: 120 });
    const was = getLang();
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        assert.match(t(below.key, { lost: 120, misses: 120 }), lang === "ru" ? /^До 100 % точности не хватает 120 %/ : /^The accuracy is 120 % short of 100 %/);
    }
    setLang(was);
    // a ruleset with a GhostTapJudgement scores presses that met no note: what is lost is the play's own accuracy's
    // shortfall, those judgements counted too, never more or less than the accuracy shown says
    const ghosts = interlude(quiet());
    judgedPlay(ghosts.analysis, [...judged(900, "max", 1, 0), ...judged(80, "n200", 0.5, 900), ...judged(20, "miss", -1, 980)], [-1, -1, -1]);
    const withGhosts = fires(ghosts, "judgements.misses");
    assert.equal(withGhosts.params.lost, Math.round((100 - ghosts.analysis.accuracy) * 10) / 10);
    assert.equal(withGhosts.params.lost, 8.6, "920 − 3 points of 1003 judgements");
    assert.equal(withGhosts.params.misses, 4, "the notes' misses, 40 points of 1003");
    notWhole(data);
    assert.equal(fires(data, "judgements.misses"), null, "a failed play: not the whole map");
});

test("an Interlude play: the window that lets glued notes through is told without osu!'s OD", () => {
    const data = interlude(manipPlay());
    const h = fires(data, "manip.family");
    assert.equal(h.key, "replay.hint.manip.familyForgivenIl");
    assert.deepEqual(h.params, { families: "jumpstream", percent: 60, judgement: "Perfect" });
    data.analysis.results = data.analysis.results.map((r) => ({ ...r, kind: "n100" }));
    assert.equal(fires(data, "manip.family").key, "replay.hint.manip.family");
});

test("an Interlude play: no HitPosition hint, its counts are exact, a break judged too far off is told as such", () => {
    assert.ok(fires(leaning(P.minMs), "errors.position"));
    assert.equal(fires(interlude(leaning(P.minMs)), "errors.position"), null);
    const uneven = interlude(unevenPlay(30, (d) => {
        d.report.fingers[3].breaks = 6;
        d.report.breaks = new Array(23).fill({ shape: null, cause: "none", part: null });
    }));
    uneven.analysis.holds = true;
    assert.equal(fires(uneven, "fingers.uneven", fingerLimits()).key, "replay.hint.finger.unevenBreaks", "exact, holds or not");
    uneven.analysis.exact = false;
    assert.equal(fires(uneven, "fingers.uneven", fingerLimits()).key, "replay.hint.finger.uneven");
    const off = fires(breakPlay(onJumps(6, 2, "off")), "breaks.shape", breakLimits());
    assert.equal(off.key, "replay.hint.break.off", "pressed, but judged too far off to keep the combo");
    assert.deepEqual(off.params, { n: 6, of: 8, shape: "jump" });
});

test("breaks: whatever the cause, the hint's text is there in both languages", () => {
    for (const cause of ["none", "early", "released", "off", "unheard-of"]) {
        const { key } = fires(breakPlay(onJumps(6, 2, cause)), "breaks.shape", breakLimits());
        const entry = AREAS.replay[key];
        assert.ok(entry && entry.ru && entry.en, `${cause}: ${key}`);
    }
});
