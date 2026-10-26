import test from "node:test";
import assert from "node:assert/strict";
import { searchRange, searchKnob, danRange, patternScore } from "../../src/gen/search.js";
import { setLang } from "../../src/i18n/i18n.js";

test("dan range from two labels covers both whole steps", () => {
    assert.deepEqual(danRange({ level: 13, step: "low" }, { level: 14, step: "high" }), { lo: 12.5, hi: 14.5 });
    assert.deepEqual(danRange({ level: 14, step: "high" }, { level: 13, step: "low" }), { lo: 12.5, hi: 14.5 });
});

test("inside the range the most pattern-accurate attempt wins", async () => {
    // numeric rises with the knob; pattern accuracy is best around knob 0.2
    const evaluate = async (knob) => ({ numeric: 10 + knob * 5, score: 1 - Math.abs(knob - 0.2) });
    const { best, inRange } = await searchRange({ evaluate, lo: 9.5, hi: 13.5, min: -1, max: 1, seed: 1, score: (a) => a.score });
    assert.equal(inRange, true);
    assert.ok(best.numeric >= 9.5 && best.numeric < 13.5);
    assert.ok(Math.abs(best.knob - 0.2) < 0.2, `knob ${best.knob}`);
});

test("out of reach: the attempt closest to the range is returned", async () => {
    const evaluate = async (knob) => ({ numeric: 5 + knob, score: 1 });
    const { best, inRange } = await searchRange({ evaluate, lo: 9.5, hi: 11.5, min: -1, max: 1, seed: 1, score: (a) => a.score });
    assert.equal(inRange, false);
    assert.ok(best.knob > 0.8);
});

test("pattern score counts how much of the map reads as the requested patterns", () => {
    const top3 = [{ name: "Jumpstream", share: 0.6 }, { name: "Minijacks", share: 0.3 }, { name: "Rolls", share: 0.1 }];
    assert.ok(Math.abs(patternScore(top3, ["Jumpstream"]) - 0.6) < 1e-9);
    assert.ok(Math.abs(patternScore(top3, ["Jumpstream", "Stream"]) - 0.7) < 1e-9);
    assert.ok(Math.abs(patternScore(top3, ["Jack"]) - 0.3) < 1e-9);
});

test("searchKnob compares labels by key, so a language switch mid-search still finds the hit", async () => {
    let calls = 0;
    // every attempt reads "below dan 1", like the target; the app switches to English after the first one
    const evaluate = async () => {
        calls += 1;
        setLang("en");
        return { numeric: 0.2 };
    };
    try {
        const { reachable } = await searchKnob({ evaluate, target: 0.3, min: 0, max: 2, seed: 1 });
        assert.equal(reachable, true);
        assert.equal(calls, 1);
    } finally {
        setLang("ru");
    }
});

test("the budget limits the number of evaluations", async () => {
    const { NAME_FAMILY } = await import("../../src/gen/search.js");
    assert.equal(NAME_FAMILY.Chordjacks, "Chordjack");
    let calls = 0;
    // every density is in range: the coarse scan, then reseeds of the first `keep` in-range densities
    const inRange = async (knob) => { calls += 1; return { numeric: 10 + knob }; };
    await searchRange({ evaluate: inRange, lo: 0, hi: 100, min: -1, max: 1, seed: 1, score: () => 1, budget: { coarse: 6, refine: 4, reseeds: 2, keep: 2 } });
    assert.equal(calls, 7 + 2 * 2);
    calls = 0;
    await searchRange({ evaluate: inRange, lo: 0, hi: 100, min: -1, max: 1, seed: 1, score: () => 1 });
    assert.equal(calls, 9 + 4 * 3);
    // never in range: the coarse scan, then at most `refine` bisection steps
    calls = 0;
    const never = async (knob) => { calls += 1; return { numeric: knob < 0 ? 5 : 20 }; };
    await searchRange({ evaluate: never, lo: 10, hi: 11, min: -1, max: 1, seed: 1, score: () => 1, budget: { coarse: 6, refine: 4, reseeds: 2, keep: 2 } });
    assert.equal(calls, 7 + 4);
    calls = 0;
    await searchKnob({ evaluate: never, target: 10.5, min: -1, max: 1, seed: 1, budget: { coarse: 4, refine: 2, reseeds: 1 } });
    assert.ok(calls <= 4 + 2 + 6 + 3, `${calls}`);
});
