import test from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, templateById, stepTargets, profileTargets, templateTitle } from "../src/rate/marathonTemplates.js";
import { patternById, lengthById } from "../src/recommend/catalog.js";
import { setLang, t } from "../src/i18n/i18n.js";

test("the four templates, each with its offsets, length, pause, OD/HP and default patterns", () => {
    assert.deepEqual(TEMPLATES.map((x) => x.id), ["dan", "stamina", "warmup", "custom"]);
    assert.deepEqual(templateById("dan").offsets, [-0.45, -0.3, -0.15, 0]);
    assert.equal(templateById("dan").lengthId, "medium");
    assert.equal(templateById("dan").gapSec, 10);
    assert.deepEqual(templateById("stamina").offsets, [-0.6, -0.4, -0.2, 0]);
    assert.equal(templateById("stamina").lengthId, "long");
    assert.equal(templateById("stamina").gapSec, 15);
    assert.equal(templateById("stamina").hp, 7);
    assert.deepEqual(templateById("stamina").defaultPatterns, ["jumpstream", "handstream", "stamina"]);
    assert.deepEqual(templateById("warmup").offsets, [-1.2, -0.7, -0.3, 0, 0.3]);
    assert.equal(templateById("warmup").lengthId, "short");
    assert.equal(templateById("warmup").gapSec, 20);
    assert.equal(templateById("custom").offsets, null);
    for (const tpl of TEMPLATES) {
        assert.ok(lengthById(tpl.lengthId), `${tpl.id} length`);
        assert.ok(tpl.defaultPatterns.length >= 1 && tpl.defaultPatterns.length <= 3, `${tpl.id} patterns`);
        for (const id of tpl.defaultPatterns) assert.ok(patternById(id), `${tpl.id} ${id}`);
        for (const v of [tpl.od, tpl.hp]) assert.ok(v >= 0 && v <= 10, `${tpl.id} od/hp`);
        for (const key of [tpl.nameKey, tpl.hintKey, tpl.titleKey]) assert.notEqual(t(key), key, `${tpl.id} ${key}`);
    }
    assert.equal(templateById("nope"), null);
    assert.equal(templateById(undefined), null);
});

test("step targets: the template's offsets from the final dan", () => {
    assert.deepEqual(stepTargets(templateById("dan"), 13), [12.55, 12.7, 12.85, 13]);
    assert.deepEqual(stepTargets(templateById("stamina"), 15.2), [14.6, 14.8, 15, 15.2]);
    assert.deepEqual(stepTargets(templateById("warmup"), 13), [11.8, 12.3, 12.7, 13, 13.3]);
});

test("step targets round to 0.05", () => {
    assert.deepEqual(stepTargets(templateById("dan"), 13.04), [12.6, 12.75, 12.9, 13.05]);
    assert.deepEqual(stepTargets(templateById("dan"), 12.97), [12.5, 12.65, 12.8, 12.95]);
    for (const d of stepTargets(templateById("warmup"), 11.13)) assert.equal(Math.round(d * 20) / 20, d);
});

test("step targets clamp to dan 1 and to Kappa high", () => {
    assert.deepEqual(stepTargets(templateById("warmup"), 1.5), [1, 1, 1.2, 1.5, 1.8]);
    assert.deepEqual(stepTargets(templateById("warmup"), 20.3), [19.1, 19.6, 20, 20.3, 20.4]);
    assert.deepEqual(stepTargets(templateById("dan"), 25), [20.4, 20.4, 20.4, 20.4]);
});

test("custom: the number of maps and the step, ending on the final dan", () => {
    const custom = templateById("custom");
    assert.deepEqual(stepTargets(custom, 13, { count: 3, step: 0.2 }), [12.6, 12.8, 13]);
    assert.deepEqual(stepTargets(custom, 13, { count: 6, step: 0.4 }), [11, 11.4, 11.8, 12.2, 12.6, 13]);
    assert.deepEqual(stepTargets(custom, 13, { count: 5, step: 0.1 }), [12.6, 12.7, 12.8, 12.9, 13]);
    // out of range or missing → clamped to 3–10 maps and 0.1–0.4 per step; defaults 4 and 0.2
    assert.deepEqual(stepTargets(custom, 13), [12.4, 12.6, 12.8, 13]);
    assert.equal(stepTargets(custom, 13, { count: 12, step: 0.2 }).length, 10);
    assert.equal(stepTargets(custom, 13, { count: 1, step: 0.2 }).length, 3);
    assert.deepEqual(stepTargets(custom, 13, { count: 3, step: 2 }), [12.2, 12.6, 13]);
    // the other templates ignore count and step
    assert.deepEqual(stepTargets(templateById("dan"), 13, { count: 6, step: 0.4 }), [12.55, 12.7, 12.85, 13]);
});

test("a non-number final dan gives no targets", () => {
    assert.deepEqual(stepTargets(templateById("dan"), NaN), []);
    assert.deepEqual(stepTargets(templateById("dan"), null), []);
    assert.deepEqual(stepTargets(null, 13), []);
});

test("the title names the final dan's level, in either language", () => {
    assert.equal(templateTitle(templateById("dan"), 13.04), "Gamma Dan Course");
    assert.equal(templateTitle(templateById("dan"), 7.2), "7 Dan Course");
    assert.equal(templateTitle(templateById("stamina"), 15), "Epsilon — стамина-марафон");
    assert.equal(templateTitle(templateById("dan"), NaN), t("marathon.defaultTitle"));
    setLang("en");
    try {
        assert.equal(templateTitle(templateById("stamina"), 15), "Epsilon Stamina Marathon");
        assert.equal(templateTitle(templateById("warmup"), 12), "Beta Warm-up to Challenge");
        assert.equal(templateTitle(templateById("custom"), 20.4), "Kappa Marathon");
    } finally {
        setLang("ru");
    }
});

test("by profile: the overall dan, or each pattern below its own dan, the patterns taking turns", () => {
    const dan = templateById("dan");
    const skill = { overall: 13, tiles: { speed: 14, stamina: 12.5, jack: 11, tech: null } };
    assert.deepEqual(profileTargets(dan, skill, ["stream", "jack"], "overall"), { finalDan: 13, targets: [12.55, 12.7, 12.85, 13] });
    // Stream on Speed 14, Jack on Jack 11, Stream, Jack: each a step below its own dan
    assert.deepEqual(profileTargets(dan, skill, ["stream", "jack"], "pattern"), { finalDan: 11, targets: [13.55, 10.7, 13.85, 11] });
    // one pattern: what "by profile" always did, the course below that pattern's dan
    assert.deepEqual(profileTargets(dan, skill, ["jumpstream"], "pattern").targets, stepTargets(dan, 12.5));
    // a tile without a dan falls back to the overall one
    assert.equal(profileTargets(dan, skill, ["tech"], "pattern").finalDan, 13);
    // custom: count and step count here too
    assert.equal(profileTargets(templateById("custom"), skill, ["stream"], "pattern", { count: 7, step: 0.1 }).targets.length, 7);
    // nothing to go on
    assert.equal(profileTargets(dan, { tiles: { speed: 14 } }, ["stream"], "overall"), null);
    assert.equal(profileTargets(dan, { tiles: { speed: 14 } }, ["jack"], "pattern"), null);
    assert.equal(profileTargets(dan, null, ["stream"], "pattern"), null);
    assert.equal(profileTargets(dan, skill, [], "pattern"), null);
});
