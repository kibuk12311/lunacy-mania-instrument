// src/interlude/ruleset.js: every kind of note priority, hold mechanics and accuracy a .ruleset can hold, the checks
// Prelude's Ruleset.Validate makes, the windows taken from them, the built-in SC J4, the six slots and how an accuracy
// is written. The rulesets here are made in the test (tests/interlude/rulesets.js).
import test from "node:test";
import assert from "node:assert/strict";
import { parseRuleset, formatAccuracy, rulesetSlots, SC_J4 } from "../../src/interlude/ruleset.js";
import { rulesetJson, osuJson, wife3Json, quaverJson } from "./rulesets.js";

const f = Math.fround;
const sixPoints = { PointsPerJudgement: [1, 0.9, 0.5, 0, -0.5, -1] };
const six = (over = {}) => rulesetJson({
    judgements: [[[-20, 20], false], [[-40, 40], false], [[-80, 80], false], [[-120, 120], true], [[-160, 160], true], [null, true]],
    hold: { OnlyRequireHold: 150 }, accuracy: sixPoints, ...over,
});

test("a ruleset's JSON: names, colours, float32 windows, lamps, grades; as text, bytes (a BOM too) or object", () => {
    const json = six({
        lamps: [{ Name: "FC", Color: [255, 1, 2, 3], Requirement: { ComboBreaksAtMost: 0 } }, { Name: "PFC", Color: [255, 4, 5, 6], Requirement: { JudgementAtMost: [1, 0] } }],
        grades: [{ Name: "A", Color: [255, 10, 20, 30], Accuracy: 0.9 }, { Name: "S", Color: [255, 40, 50, 60], Accuracy: 0.95 }],
    });
    json.Judgements[0].TimingWindows = [-16.4, 16.4];
    for (const input of [json, JSON.stringify(json), Buffer.from(`﻿${JSON.stringify(json)}`)]) {
        const r = parseRuleset(input);
        assert.equal(r.name, "Test");
        assert.deepEqual(r.judgements[0], { name: "J0", color: "#00ffff", breaksCombo: false, windows: [f(-16.4), f(16.4)] });
        assert.equal(r.judgements[5].windows, null);
        assert.deepEqual(r.lamps.map((l) => [l.name, l.color, l.requirement]), [["FC", "#010203", { kind: "comboBreaks", count: 0 }], ["PFC", "#040506", { kind: "judgement", judgement: 1, count: 0 }]]);
        assert.deepEqual(r.grades.map((g) => [g.name, g.accuracy]), [["A", 0.9], ["S", 0.95]]);
        assert.deepEqual(r.noteWindows, [-160, 160], "the widest: the last judgement with windows");
        assert.deepEqual(r.releaseWindows, [-150, 150]);
        assert.ok(Object.isFrozen(r) && Object.isFrozen(r.judgements[0]));
    }
});

test("note priorities: osu!mania, Etterna, Interlude with its threshold; ghost tap judgement", () => {
    assert.deepEqual(parseRuleset(six()).notePriority, { kind: "osuMania" });
    assert.deepEqual(parseRuleset(six({ priority: "Etterna" })).notePriority, { kind: "etterna" });
    assert.deepEqual(parseRuleset(six({ priority: { Interlude: 90.3 } })).notePriority, { kind: "interlude", cbrush: f(90.3) });
    assert.equal(parseRuleset(six()).ghostTapJudgement, null);
    assert.equal(parseRuleset(six({ ghost: 5 })).ghostTapJudgement, 5);
});

test("hold mechanics, each kind, and the release windows they make", () => {
    const osu = parseRuleset(osuJson(8));
    assert.equal(osu.holdMechanics.kind, "osuMania");
    assert.equal(osu.holdMechanics.windows.Window320, 19.5);
    assert.deepEqual(osu.releaseWindows, [-164.5, 102.5], "−Window0, Window100 − 1");
    assert.deepEqual(osu.judgements.map((j) => j.windows), [[-16.5, 16.5], [-40.5, 40.5], [-73.5, 73.5], [-103.5, 102.5], [-127.5, 102.5], [-164.5, 102.5]]);
    assert.deepEqual(SC_J4.holdMechanics, { kind: "headJudgementOr", early: -180, late: 180, ifDropped: 3, ifOverheld: 3 });
    assert.deepEqual(SC_J4.releaseWindows, [-180, 180]);
    const wife = parseRuleset(wife3Json(7));
    assert.deepEqual([wife.holdMechanics, wife.accuracy], [{ kind: "onlyRequireHold", window: 180 }, { kind: "wifeCurve", judge: 7 }]);
    const quaver = parseRuleset(quaverJson());
    assert.equal(quaver.holdMechanics.kind, "judgeReleasesSeparately");
    assert.equal(quaver.holdMechanics.ifOverheld, 4);
    assert.deepEqual(quaver.releaseWindows, [-190.5, 190.5], "the last release window there is");
    const releases = parseRuleset(six({ hold: { OnlyJudgeReleases: 3 } }));
    assert.deepEqual(releases.holdMechanics, { kind: "onlyJudgeReleases", ifDropped: 3 });
    assert.deepEqual(releases.releaseWindows, releases.noteWindows);
});

test("the built-in SC J4 is Interlude's default, as Prelude's SC.create 4 makes it", () => {
    assert.equal(SC_J4.name, "SC J4");
    assert.deepEqual(SC_J4.judgements.map((j) => [j.name, j.windows, j.breaksCombo]), [
        ["Marvellous", [-22.5, 22.5], false], ["Perfect", [-45, 45], false], ["Great", [-90, 90], false],
        ["Good", [-135, 135], true], ["Bad", [-180, 180], true], ["Miss", null, true],
    ]);
    assert.deepEqual(SC_J4.accuracy.points, [1, 0.9, 0.5, -0.5, -1, -1]);
    assert.deepEqual(SC_J4.notePriority, { kind: "interlude", cbrush: 90 });
    assert.deepEqual([SC_J4.lamps.length, SC_J4.grades.length, SC_J4.decimals], [9, 11, 2]);
});

test("what Prelude refuses to load is refused, saying why", () => {
    const refuse = (json, why) => assert.throws(() => parseRuleset(json), why);
    refuse("{", /not JSON/);
    refuse("[]", /not a record/);
    refuse(six({ hold: { HoldThemAll: 1 } }), /unknown hold mechanics HoldThemAll/);
    refuse(six({ hold: { CombineHeadAndTail: { Something: [] } } }), /unknown head and tail rule/);
    refuse(six({ priority: "Random" }), /unknown note priority/);
    refuse(six({ accuracy: { Percent: 1 } }), /unknown accuracy/);
    refuse(six({ lamps: [{ Name: "x", Color: [255, 0, 0, 0], Requirement: { NoMisses: 0 } }] }), /unknown lamp requirement/);
    refuse({ ...six(), Judgements: [] }, /at least one judgement/);
    const narrower = six();
    narrower.Judgements[1].TimingWindows = [-10, 40];
    refuse(narrower, /Early window/);
    const lateNarrower = six();
    lateNarrower.Judgements[2].TimingWindows = [-80, 30];
    refuse(lateNarrower, /Late window/);
    refuse(six({ grades: [{ Name: "A", Color: [255, 0, 0, 0], Accuracy: 0.9 }, { Name: "B", Color: [255, 0, 0, 0], Accuracy: 0.8 }] }), /Grade boundary/);
    refuse(six({ lamps: [{ Name: "PFC", Color: [255, 0, 0, 0], Requirement: { JudgementAtMost: [1, 0] } }, { Name: "FC", Color: [255, 0, 0, 0], Requirement: { ComboBreaksAtMost: 0 } }] }), /stricter/);
    refuse(six({ lamps: [{ Name: "x", Color: [255, 0, 0, 0], Requirement: { JudgementAtMost: [9, 0] } }] }), /invalid judgement/);
    refuse(six({ ghost: 6 }), /GhostTapJudgement must be a valid/);
    refuse(six({ ghost: 1, accuracy: { WifeCurve: 4 } }), /GhostTapJudgement must be used with PointsPerJudgement/);
    refuse(six({ priority: { Interlude: 170 } }), /must not exceed/);
    refuse(six({ priority: { Interlude: -1 } }), /non-negative/);
    refuse(six({ hold: { CombineHeadAndTail: { HeadJudgementOr: [-180, 180, 3, 3] } }, accuracy: { WifeCurve: 4 } }), /PointsPerJudgement accuracy/);
    refuse(six({ hold: { CombineHeadAndTail: { HeadJudgementOr: [10, 180, 3, 3] } } }), /non-positive/);
    refuse(six({ hold: { CombineHeadAndTail: { HeadJudgementOr: [-180, 180, 6, 3] } } }), /valid judgement/);
    refuse(six({ hold: { CombineHeadAndTail: { HeadJudgementOr: [-180, 180, 3] } } }), /needs 4 values/);
    const osu = osuJson(8);
    osu.HoldMechanics.CombineHeadAndTail.OsuMania.Window200 = -1;
    refuse(osu, /Window200 must be non-negative/);
    refuse({ ...osuJson(8), Judgements: osuJson(8).Judgements.slice(1), Accuracy: { PointsPerJudgement: [1, 1, 1, 1, 1] } }, /exactly 6 judgements/);
    refuse(six({ hold: { OnlyRequireHold: -5 } }), /non-negative/);
    refuse(six({ hold: { JudgeReleasesSeparately: [[null, null], 4] } }), /match judgement count/);
    refuse(six({ hold: { JudgeReleasesSeparately: [[[-10, 10], [-5, 20], null, null, null, null], 4] } }), /Early release window/);
    refuse(six({ hold: { OnlyJudgeReleases: 8 } }), /valid judgement/);
    refuse(six({ accuracy: { WifeCurve: 10 } }), /judge value/);
    refuse(six({ accuracy: { PointsPerJudgement: [1, 0] } }), /provides 2 values/);
    refuse({ ...six(), Formatting: { DecimalPlaces: "FIVE" } }, /decimal places/);
    refuse(six({ hold: { OnlyRequireHold: 600 } }), /500ms/);
    const noColour = six();
    delete noColour.Judgements[0].Color;
    refuse(noColour, /colour/);
    refuse({ ...six(), Judgements: [{ ...six().Judgements[0], BreaksCombo: "no" }] }, /BreaksCombo/);
});

test("the six slots: six judgements in order; of another count the last is the miss, past the fifth with the 50s", () => {
    const of = (n) => ({ judgements: new Array(n).fill({}) });
    assert.deepEqual(rulesetSlots(SC_J4), ["max", "n300", "n200", "n100", "n50", "miss"]);
    assert.deepEqual(rulesetSlots(of(5)), ["max", "n300", "n200", "n100", "miss"]);
    assert.deepEqual(rulesetSlots(of(8)), ["max", "n300", "n200", "n100", "n50", "n50", "n50", "miss"]);
    assert.deepEqual(rulesetSlots(of(2)), ["max", "miss"]);
    assert.deepEqual(rulesetSlots(of(1)), ["max"]);
});

test("accuracy written as Interlude writes it, with two, three or four places", () => {
    const two = { decimals: 2 };
    assert.equal(formatAccuracy(two, 1), "100.00%");
    assert.equal(formatAccuracy(two, 0.99999), "99.9990%");
    assert.equal(formatAccuracy(two, 0.99985), "99.985%");
    assert.equal(formatAccuracy(two, 0.95125), "95.13%");
    assert.equal(formatAccuracy(two, -4.110383189122272), "-411.04%");
    assert.equal(formatAccuracy({ decimals: 3 }, 1), "100.000%");
    assert.equal(formatAccuracy({ decimals: 3 }, 0.9512), "95.120%");
    assert.equal(formatAccuracy({ decimals: 4 }, 1), "100.0000%");
});
