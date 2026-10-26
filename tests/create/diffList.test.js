// The difficulty list: rows of from/to dan, at most 5, the 3-dan ladder, ranges easiest first, and the
// «Создать набор» label on the generate button.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import { ladderRows, rowRanges, nextRow, createDiffList, MAX_DIFFS, DEFAULT_ROW } from "../../app/renderer/diffList.js";

const row = (a, sa, b, sb) => ({ from: { level: a, step: sa }, to: { level: b, step: sb } });

test("the ladder: level − 1, level and level + 1, each from low to high, inside the scale", () => {
    assert.deepEqual(ladderRows(13), [row(12, "low", 12, "high"), row(13, "low", 13, "high"), row(14, "low", 14, "high")]);
    assert.deepEqual(rowRanges(ladderRows(13)), [{ lo: 11.5, hi: 12.5 }, { lo: 12.5, hi: 13.5 }, { lo: 13.5, hi: 14.5 }]);
    assert.deepEqual(ladderRows(1).map((r) => r.from.level), [1, 2, 3], "shifted up at the bottom");
    assert.deepEqual(ladderRows(20).map((r) => r.from.level), [18, 19, 20], "and down at the top");
});

test("ranges come out easiest first, a reversed row reads the same", () => {
    const ranges = rowRanges([row(15, "low", 15, "high"), row(12, "mid", 11, "low"), row(13, "low", 14, "high")]);
    assert.deepEqual(ranges.map((r) => Math.round(r.lo * 10) / 10), [10.5, 12.5, 14.5]);
    assert.ok(Math.abs(ranges[0].hi - 12.1) < 1e-9);
});

test("a new row is the last one a level up; the list stops at 5", () => {
    assert.equal(MAX_DIFFS, 5);
    assert.deepEqual(nextRow([row(12, "low", 14, "high")]), row(13, "low", 15, "high"));
    assert.deepEqual(nextRow([row(19, "low", 20, "high")]), row(20, "low", 20, "high"));
    assert.equal(nextRow(Array.from({ length: 5 }, () => DEFAULT_ROW)), null);
});

test("the list on the fake DOM: + difficulty up to 5, ✕ down to 1, the ladder, and the generate button's label", async () => {
    setLang("en");
    try {
        const { $ } = fakeDom({});
        const button = $("generate");
        const changes = [];
        const list = createDiffList({ root: $("diffs"), generateButton: button, onChange: (n) => changes.push(n) });
        const all = (n) => [n, ...n.children.flatMap(all)];
        const btn = (text) => all($("diffs")).find((n) => n.tagName === "BUTTON" && n.textContent === text);
        const removes = () => all($("diffs")).filter((n) => n.tagName === "BUTTON" && n.title === "Remove");

        assert.equal($("diffs").hidden, false);
        assert.equal(list.count, 1);
        assert.equal(button.textContent, "Create map");
        assert.deepEqual(list.ranges(), [{ lo: 11.5, hi: 14.5 }], "today's default: Beta low … Delta high");
        assert.equal(removes()[0].disabled, true, "the last row stays");

        for (let i = 0; i < 6; i += 1) await fire(btn("+ difficulty"));
        assert.equal(list.count, 5);
        assert.equal(btn("+ difficulty").disabled, true);
        assert.equal(button.textContent, "Create mapset (5 difficulties)");
        await fire(removes()[0]);
        assert.equal(list.count, 4);

        await fire(btn("Ladder: 3 dans in a row"));
        assert.equal(list.count, 3);
        assert.deepEqual(list.ranges().map((r) => r.lo), [11.5, 12.5, 13.5], "around the first row's from level (Gamma)");
        assert.ok(textOf($("diffs")).includes("from"), textOf($("diffs")));

        // the selects edit their row
        const selects = all($("diffs")).filter((n) => n.dataset?.role === "level-from");
        selects[0].value = "5";
        await fire(selects[0], "change");
        assert.equal(list.ranges()[0].lo, 4.5);
        assert.ok(changes.length >= 3);
    } finally {
        setLang("ru");
    }
});

test("Russian: the set label counts difficulties", () => {
    setLang("ru");
    const { $ } = fakeDom({});
    const list = createDiffList({ root: $("diffs"), generateButton: $("generate") });
    list.setRows(ladderRows(13));
    assert.equal($("generate").textContent, "Создать набор (3 сложности)");
    list.setRows([...ladderRows(13), DEFAULT_ROW, DEFAULT_ROW]);
    assert.equal($("generate").textContent, "Создать набор (5 сложностей)");
    list.setRows([DEFAULT_ROW]);
    assert.equal($("generate").textContent, "Создать карту");
});
