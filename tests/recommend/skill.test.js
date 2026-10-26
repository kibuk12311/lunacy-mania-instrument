import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readSkill, playerDanFor, targetFor, targetForWindow, targetForRange, CUSTOM_GOAL } from "../../src/recommend/skill.js";
import { setLang } from "../../src/i18n/i18n.js";

const skills = JSON.parse(await readFile(new URL("../fixtures/mt/skills.json", import.meta.url), "utf8"));

test("readSkill takes the 4K rice dan, its tiles and the MSD ratings", () => {
    const s = readSkill(skills);
    assert.equal(s.ready, true);
    assert.equal(s.status, "ready");
    assert.equal(s.analyzedPlays, 585);
    assert.equal(s.overall, 13.66);
    assert.equal(s.overallLabel, "Delta low");
    assert.deepEqual(s.tiles, { speed: 14.28, stamina: 13.26, tech: 13.74, jack: 13.36 });
    assert.equal(s.msd.Stream, 34.62);
    assert.equal(s.msd.Jumpstream, 30.61);
    assert.equal(s.msd.JackSpeed, 21.61);
    assert.equal(s.tracked, true);
});

test("readSkill tells an account the tracker does not track", () => {
    // live shape for an account nobody added to mania-tracker
    const s = readSkill({ status: "ready", totalPlays: 0, modes: [], tracked: false });
    assert.equal(s.ready, false);
    assert.equal(s.tracked, false);
    assert.equal(readSkill({ status: "ready", modes: [] }).tracked, true);
});

test("readSkill is not ready while pending or without a 4K mode", () => {
    const pending = readSkill({ status: "pending", modes: [], tracked: false });
    assert.equal(pending.ready, false);
    assert.equal(pending.status, "pending");
    assert.equal(pending.overall, null);
    assert.equal(pending.overallLabel, null);
    assert.deepEqual(pending.tiles, { speed: null, stamina: null, tech: null, jack: null });
    assert.deepEqual(pending.msd, {});

    const sevenKeyOnly = readSkill({ ...skills, modes: skills.modes.map((m) => ({ ...m, keyCount: 7 })) });
    assert.equal(sevenKeyOnly.ready, false);
    assert.equal(sevenKeyOnly.overall, null);
    assert.equal(readSkill(skills, 7).ready, false);
    assert.equal(readSkill(null).ready, false);
});

test("the player's dan for a pattern is its tile, else the overall dan", () => {
    const s = readSkill(skills);
    assert.deepEqual(playerDanFor(s, "stream"), { dan: 14.28, source: "tile", tile: "speed" });
    assert.deepEqual(playerDanFor(s, "chordjack"), { dan: 13.36, source: "tile", tile: "jack" });
    const noTiles = { ...s, tiles: { speed: null, stamina: null, tech: null, jack: null } };
    assert.deepEqual(playerDanFor(noTiles, "tech"), { dan: 13.66, source: "overall", tile: "tech" });
    assert.equal(playerDanFor({ ...noTiles, overall: null }, "tech"), null);
});

test("growth target from the stamina tile with the jumpstream MSD", () => {
    const t = targetFor({ skill: readSkill(skills), manualDan: null, patternId: "jumpstream", goalId: "growth" });
    assert.deepEqual(t, {
        patternId: "jumpstream", goalId: "growth", source: "tile", tile: "stamina",
        playerDan: 13.26, playerDanLabel: "Gamma mid/high",
        lo: 13.26, hi: 13.76, center: 13.51, halfWidth: 0.25,
        msdAxis: "Jumpstream", msdRating: 30.61, msdTarget: 31.36,
    });
});

test("comfort and challenge windows are rounded to hundredths", () => {
    const s = readSkill(skills);
    const comfort = targetFor({ skill: s, patternId: "stream", goalId: "comfort" });
    assert.equal(comfort.lo, 13.68);
    assert.equal(comfort.hi, 14.18);
    assert.equal(comfort.center, 13.93);
    assert.equal(comfort.halfWidth, 0.25);
    assert.equal(comfort.msdTarget, 33.62);
    const challenge = targetFor({ skill: s, patternId: "jack", goalId: "challenge" });
    assert.equal(challenge.lo, 13.86);
    assert.equal(challenge.hi, 14.56);
    assert.equal(challenge.center, 14.21);
    assert.equal(challenge.halfWidth, 0.35);
    assert.equal(challenge.msdAxis, "JackSpeed");
    // JackSpeed ratings sit far below the MSD of jack charts at the same dan, so jacks rank by dan alone
    assert.equal(challenge.msdRating, null);
    assert.equal(challenge.msdTarget, null);
    assert.equal(targetFor({ skill: s, patternId: "chordjack", goalId: "challenge" }).msdTarget, 31.36);
});

test("overall dan is used when the tile has no dan", () => {
    const s = readSkill(skills);
    s.tiles.tech = null;
    const t = targetFor({ skill: s, patternId: "tech", goalId: "growth" });
    assert.equal(t.source, "overall");
    assert.equal(t.tile, "tech");
    assert.equal(t.playerDan, 13.66);
    assert.equal(t.msdRating, 32.95);
});

test("a manual dan wins over the skill and has no MSD target", () => {
    const t = targetFor({ skill: readSkill(skills), manualDan: 12.2, patternId: "stream", goalId: "growth" });
    assert.equal(t.source, "manual");
    assert.equal(t.playerDan, 12.2);
    assert.equal(t.playerDanLabel, "Beta mid/high");
    assert.equal(t.lo, 12.2);
    assert.equal(t.hi, 12.7);
    assert.equal(t.msdAxis, "Stream");
    assert.equal(t.msdRating, null);
    assert.equal(t.msdTarget, null);
    assert.equal(targetFor({ skill: null, manualDan: 5, patternId: "tech", goalId: "comfort" }).lo, 4.4);
});

test("no dan to use or unknown ids throw Russian errors", () => {
    const s = readSkill(skills);
    const empty = { ...s, overall: null, tiles: { speed: null, stamina: null, tech: null, jack: null } };
    assert.throws(() => targetFor({ skill: empty, patternId: "stream", goalId: "growth" }), /выбери дан вручную/);
    assert.throws(() => targetFor({ skill: null, manualDan: null, patternId: "stream", goalId: "growth" }), /mania-tracker/);
    assert.throws(() => targetFor({ skill: s, patternId: "ln", goalId: "growth" }), /паттерн/);
    assert.throws(() => targetFor({ skill: s, patternId: "stream", goalId: "speedrun" }), /цель/);
});

test("in English the errors are English and labels keep their dan names", () => {
    const s = readSkill(skills);
    const empty = { ...s, overall: null, tiles: { speed: null, stamina: null, tech: null, jack: null } };
    setLang("en");
    try {
        assert.throws(() => targetFor({ skill: empty, patternId: "stream", goalId: "growth" }),
            { message: "mania-tracker has no dan for this skillset yet — set your dan manually" });
        assert.throws(() => targetFor({ skill: null, manualDan: null, patternId: "stream", goalId: "growth" }),
            { message: "load your mania-tracker profile first — or set your dan manually" });
        assert.throws(() => targetFor({ skill: s, patternId: "ln", goalId: "growth" }), { message: "unknown pattern" });
        assert.throws(() => targetFor({ skill: s, patternId: "stream", goalId: "speedrun" }), { message: "unknown goal" });
        assert.equal(readSkill(skills).overallLabel, "Delta low");
        assert.equal(targetFor({ skill: null, manualDan: 0.2, patternId: "stream", goalId: "growth" }).playerDanLabel, "below dan 1");
    } finally {
        setLang("ru");
    }
});

// targetFor before targetForWindow existed, on every goal (with the tile + MSD, a jack pattern, a manual dan)
const TARGET_SNAPSHOT = [
    {"patternId":"jumpstream","goalId":"comfort","source":"tile","tile":"stamina","playerDan":13.26,"playerDanLabel":"Gamma mid/high","lo":12.66,"hi":13.16,"center":12.91,"halfWidth":0.25,"msdAxis":"Jumpstream","msdRating":30.61,"msdTarget":29.61},
    {"patternId":"jack","goalId":"comfort","source":"tile","tile":"jack","playerDan":13.36,"playerDanLabel":"Gamma high","lo":12.76,"hi":13.26,"center":13.01,"halfWidth":0.25,"msdAxis":"JackSpeed","msdRating":null,"msdTarget":null},
    {"patternId":"tech","goalId":"comfort","source":"manual","tile":"tech","playerDan":12.2,"playerDanLabel":"Beta mid/high","lo":11.6,"hi":12.1,"center":11.85,"halfWidth":0.25,"msdAxis":"Technical","msdRating":null,"msdTarget":null},
    {"patternId":"jumpstream","goalId":"growth","source":"tile","tile":"stamina","playerDan":13.26,"playerDanLabel":"Gamma mid/high","lo":13.26,"hi":13.76,"center":13.51,"halfWidth":0.25,"msdAxis":"Jumpstream","msdRating":30.61,"msdTarget":31.36},
    {"patternId":"jack","goalId":"growth","source":"tile","tile":"jack","playerDan":13.36,"playerDanLabel":"Gamma high","lo":13.36,"hi":13.86,"center":13.61,"halfWidth":0.25,"msdAxis":"JackSpeed","msdRating":null,"msdTarget":null},
    {"patternId":"tech","goalId":"growth","source":"manual","tile":"tech","playerDan":12.2,"playerDanLabel":"Beta mid/high","lo":12.2,"hi":12.7,"center":12.45,"halfWidth":0.25,"msdAxis":"Technical","msdRating":null,"msdTarget":null},
    {"patternId":"jumpstream","goalId":"challenge","source":"tile","tile":"stamina","playerDan":13.26,"playerDanLabel":"Gamma mid/high","lo":13.76,"hi":14.46,"center":14.11,"halfWidth":0.35,"msdAxis":"Jumpstream","msdRating":30.61,"msdTarget":32.61},
    {"patternId":"jack","goalId":"challenge","source":"tile","tile":"jack","playerDan":13.36,"playerDanLabel":"Gamma high","lo":13.86,"hi":14.56,"center":14.21,"halfWidth":0.35,"msdAxis":"JackSpeed","msdRating":null,"msdTarget":null},
    {"patternId":"tech","goalId":"challenge","source":"manual","tile":"tech","playerDan":12.2,"playerDanLabel":"Beta mid/high","lo":12.7,"hi":13.4,"center":13.05,"halfWidth":0.35,"msdAxis":"Technical","msdRating":null,"msdTarget":null},
];

test("targetFor is unchanged on every goal (same values, same key order)", () => {
    const s = readSkill(skills);
    const now = [];
    for (const goalId of ["comfort", "growth", "challenge"]) {
        for (const [patternId, skill, manualDan] of [["jumpstream", s, null], ["jack", s, null], ["tech", null, 12.2]]) {
            now.push(targetFor({ skill, manualDan, patternId, goalId }));
        }
    }
    assert.equal(JSON.stringify(now), JSON.stringify(TARGET_SNAPSHOT));
});

test("targetForWindow: any dan window, the same shape without a goal", () => {
    const s = readSkill(skills);
    const w = targetForWindow({ skill: s, manualDan: null, patternId: "jumpstream", dan: [-0.5, 0.2] });
    assert.deepEqual(w, {
        patternId: "jumpstream", goalId: null, source: "tile", tile: "stamina",
        playerDan: 13.26, playerDanLabel: "Gamma mid/high",
        lo: 12.76, hi: 13.46, center: 13.11, halfWidth: 0.35,
        msdAxis: "Jumpstream", msdRating: 30.61, msdTarget: null,
    });
    assert.equal(targetForWindow({ skill: s, patternId: "jumpstream", dan: [0, 0.5], msdOffset: 0.75 }).msdTarget, 31.36);
    const manual = targetForWindow({ skill: null, manualDan: 13, patternId: "chordjack", dan: [-0.5, 0.2], msdOffset: 1 });
    assert.equal(manual.source, "manual");
    assert.equal(manual.lo, 12.5);
    assert.equal(manual.hi, 13.2);
    assert.equal(manual.center, 12.85);
    assert.equal(manual.msdRating, null);
    assert.equal(manual.msdTarget, null);
    assert.deepEqual(Object.keys(manual), Object.keys(targetFor({ skill: null, manualDan: 13, patternId: "chordjack", goalId: "growth" })));
    assert.throws(() => targetForWindow({ skill: s, patternId: "ln", dan: [0, 1] }), /паттерн/);
    for (const dan of [null, [1], [0.5, 0], [NaN, 1], "0,1"]) {
        assert.throws(() => targetForWindow({ skill: s, patternId: "stream", dan }), /цель/, JSON.stringify(dan));
    }
});

test("targetForRange: a custom range covers the picked steps' whole bands, with the player's own dan when known", () => {
    const s = readSkill(skills);
    const expected = {
        patternId: "jumpstream", goalId: "custom", source: "tile", tile: "stamina",
        playerDan: 13.26, playerDanLabel: "Gamma mid/high",
        lo: 11.9, hi: 13.7, center: 12.8, halfWidth: 0.9,
        msdAxis: "Jumpstream", msdRating: 30.61, msdTarget: null, rangeFrom: 12, rangeTo: 13.6,
    };
    assert.equal(CUSTOM_GOAL, "custom");
    assert.deepEqual(targetForRange({ skill: s, patternId: "jumpstream", from: 12, to: 13.6 }), expected);
    // from > to is swapped
    assert.deepEqual(targetForRange({ skill: s, patternId: "jumpstream", from: 13.6, to: 12 }), expected);
    // the same keys as every other target, plus the two picked ends
    assert.deepEqual(Object.keys(expected), [...Object.keys(targetFor({ skill: s, patternId: "jumpstream", goalId: "growth" })), "rangeFrom", "rangeTo"]);
    // a pattern whose skillset rating doesn't fit has no MSD rating; no MSD target either way
    const jack = targetForRange({ skill: s, patternId: "jack", from: 13, to: 14 });
    assert.equal(jack.source, "tile");
    assert.equal(jack.msdRating, null);
    assert.equal(jack.msdTarget, null);
});

test("targetForRange without a profile (manual mode) or without a dan for the pattern: the range's own middle", () => {
    const one = targetForRange({ skill: null, patternId: "chordjack", from: 13, to: 13 });
    assert.deepEqual(one, {
        patternId: "chordjack", goalId: "custom", source: "range", tile: "jack",
        playerDan: 13, playerDanLabel: "Gamma mid",
        lo: 12.9, hi: 13.1, center: 13, halfWidth: 0.1,
        msdAxis: "Chordjack", msdRating: null, msdTarget: null, rangeFrom: 13, rangeTo: 13,
    });
    const noDan = targetForRange({ skill: { tiles: {}, overall: null, msd: {} }, patternId: "stream", from: 14.2, to: 12.6 });
    assert.equal(noDan.source, "range");
    assert.equal(noDan.lo, 12.5);
    assert.equal(noDan.hi, 14.3);
    assert.equal(noDan.playerDan, 13.4);
    // any dan to any dan: the picker's two ends
    const all = targetForRange({ skill: null, patternId: "tech", from: 0.6, to: 20.4 });
    assert.equal(all.lo, 0.5);
    assert.equal(all.hi, 20.5);
    assert.equal(all.center, 10.5);
});

test("targetForRange refuses an unknown pattern or a range without numbers, in both languages", () => {
    assert.throws(() => targetForRange({ skill: null, patternId: "ln", from: 12, to: 13 }), /паттерн/);
    for (const [from, to] of [[null, 13], [12, undefined], [NaN, 13], ["12", 13]]) {
        assert.throws(() => targetForRange({ skill: null, patternId: "stream", from, to }), /диапазон/, `${from} ${to}`);
    }
    setLang("en");
    try {
        assert.throws(() => targetForRange({ skill: null, patternId: "stream", from: null, to: 13 }), /range/);
    } finally {
        setLang("ru");
    }
});
