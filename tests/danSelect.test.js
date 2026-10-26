import test from "node:test";
import assert from "node:assert/strict";
import { nearestLevelStep, fillDanSelects, readDanSelects } from "../app/renderer/danSelect.js";
import { fakeDom } from "./helpers/fakeDom.js";
import { setLang } from "../src/i18n/i18n.js";

test("nearestLevelStep: the closest level and step of the dan picker", () => {
    assert.deepEqual(nearestLevelStep(13.0), { level: 13, step: "mid" });
    assert.deepEqual(nearestLevelStep(12.6), { level: 13, step: "low" });
    assert.deepEqual(nearestLevelStep(13.26), { level: 13, step: "mid/high" });
    assert.deepEqual(nearestLevelStep(13.45), { level: 13, step: "high" });
    assert.deepEqual(nearestLevelStep(0.6), { level: 1, step: "low" });
    assert.deepEqual(nearestLevelStep(20.4), { level: 20, step: "high" });
    assert.deepEqual(nearestLevelStep(-3), { level: 1, step: "low" });
    assert.deepEqual(nearestLevelStep(99), { level: 20, step: "high" });
    assert.deepEqual(nearestLevelStep(NaN), { level: 13, step: "mid" });
});

test("fillDanSelects fills both selects and picks the nearest; readDanSelects reads the dan back", () => {
    const { $ } = fakeDom();
    fillDanSelects($("lv"), $("st"), 12.6);
    assert.equal($("lv").children.length, 20);
    assert.equal($("st").children.length, 5);
    assert.equal($("lv").value, "13");
    assert.equal($("st").value, "low");
    assert.equal($("lv").children[12].textContent, "Gamma");
    assert.equal($("lv").children[0].textContent, "1 дан");
    assert.deepEqual($("lv").children.filter((o) => o.selected).map((o) => o.value), ["13"]);
    assert.deepEqual($("st").children.filter((o) => o.selected).map((o) => o.value), ["low"]);
    assert.equal(readDanSelects($("lv"), $("st")), 12.6);
    $("lv").value = "20";
    $("st").value = "high";
    assert.equal(readDanSelects($("lv"), $("st")), 20.4);
    $("lv").value = "junk";
    assert.equal(readDanSelects($("lv"), $("st")), null);
});

test("level names follow the language", () => {
    const { $ } = fakeDom();
    setLang("en");
    try {
        fillDanSelects($("lv"), $("st"), 5);
        assert.equal($("lv").children[0].textContent, "Dan 1");
    } finally {
        setLang("ru");
    }
});
