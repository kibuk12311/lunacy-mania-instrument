// Past Kappa high (20.5 and up) there are no more dans: every place that shows a dan reads «выше Kappa» with the
// number ("выше Kappa · 21.3"), once, and never clamps it to "Kappa high" or loses it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLang } from "../src/i18n/i18n.js";
import { renderView } from "../app/renderer/view.js";
import { forYouLine, ladderRows } from "../app/renderer/analysisExtras.js";
import { skillLines, targetText } from "../app/renderer/recommendTab.js";
import { planHeaderText } from "../app/renderer/recPlan.js";
import { danChangeText } from "../app/renderer/recProgress.js";
import { cardLines } from "../app/renderer/resultView.js";
import { badgeText } from "../app/renderer/timeline.js";
import { readHistory, skillChange } from "../src/recommend/progress.js";
import { readSkill } from "../src/recommend/skill.js";

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const inLang = (lang, fn) => {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};
const count = (s, part) => s.split(part).length - 1;

test("the card: «выше Kappa» beside its own number, not twice; the other calculators too", () => {
    const result = { kind: "ok", label: "выше Kappa · 21.3", numeric: 21.3, halfWidth: 0.4, confidenceLevel: "medium", primary: "Jumpstream", top3: [], rate: 1, calcs: { mixed: 22.04 } };
    const own = text(renderView({ screen: "result", result }, {}));
    assert.ok(own.includes("выше Kappa 21.3"), own);
    assert.equal(count(own, "21.3"), 1, own);
    const mixed = text(renderView({ screen: "result", result }, { calc: "mixed" }));
    assert.ok(mixed.includes("выше Kappa 22.0") && mixed.includes("общий: выше Kappa 21.3"), mixed);
    const all = text(renderView({ screen: "result", result }, { calc: "all" }));
    assert.ok(!all.includes("Kappa high") && !all.includes("undefined"), all);
    assert.ok(inLang("en", () => text(renderView({ screen: "result", result }, {}))).includes("above Kappa 21.3"));
});

test("analysis extras: «для тебя» and the dan-by-rate ladder show «выше Kappa» once with the number", () => {
    const ready = { state: "ready", player: { id: 1, username: "Тестер" }, skill: {} };
    const line = forYouLine({ source: "overall", playerDan: 21.2, delta: -0.5, band: "comfort", msd: null }, ready);
    assert.ok(line.includes("выше Kappa (21.2)"), line);
    const html = ladderRows([{ rate: 1, state: "ok", numeric: 20.2 }, { rate: 1.3, state: "ok", numeric: 21.8 }]);
    const row = html.split("<button").find((part) => part.includes('data-rate="1.3"'));
    assert.ok(text(row).includes("выше Kappa 21.8"), row);
    assert.equal(count(row, "21.8"), 1, row);
    assert.ok(html.includes("Kappa mid/high"));
});

test("picks: a tracker profile above Kappa reads «выше Kappa» (not Kappa high), with the number once", () => {
    const skill = readSkill({ status: "ready", modes: [{ keyCount: 4, analyzedPlays: 10, dan: { rc: { rawDan: 21.06, skillsets: { speed: { rawDan: 22.4 } } } } }] });
    assert.equal(skill.overall, 21.06);
    assert.equal(skill.overallLabel, "выше Kappa · 21.1");
    const [main, tiles] = skillLines("Тестер", skill);
    assert.ok(main.includes("общий дан выше Kappa (21.06)"), main);
    assert.ok(tiles.includes("выше Kappa · 22.4"), tiles);
    const target = {
        patternId: "jumpstream", goalId: "growth", source: "tile", tile: "speed", playerDan: 22.4, playerDanLabel: "выше Kappa · 22.4",
        lo: 22.4, hi: 22.9, center: 22.65, halfWidth: 0.25,
    };
    assert.equal(targetText(target, "Джампстрим"), "Твой дан для паттерна «Джампстрим»: выше Kappa (22.40) → ищем 22.40–22.90");
    assert.equal(planHeaderText({ playerDan: 21.06, label: "выше Kappa · 21.1", tile: "Speed" }, 5, 1040), "План: Speed выше Kappa (21.06) · 5 карт · ≈ 17:20");
});

test("create: the card and a part's badge above Kappa", () => {
    const base = JSON.parse(readFileSync(new URL("./fixtures/generateResult.json", import.meta.url), "utf8"));
    const lines = cardLines({ ...base, range: null, reachable: false, result: { ...base.result, numeric: 20.9, label: "выше Kappa · 20.9" } }, { lo: 19.5, hi: 20.5 }).map((l) => l.text);
    assert.ok(lines[0].startsWith("≈ Ближе всего получилось: выше Kappa · 20.9 (диапазон Kappa low — Kappa high)"), lines[0]);
    assert.equal(count(lines[0], "20.9"), 1, lines[0]);
    assert.deepEqual(badgeText({ dan: { numeric: 20.7, label: "выше Kappa · 20.7" }, wanted: null }), { text: "≈ выше Kappa · 20.7", ok: null });
});

test("mania-tracker history past its table: the dan keeps its number and the change reads «выше Kappa»", () => {
    const row = (recordedAt, rc) => ({ recordedAt, snapshot: { dan: { rc }, ratings: {} } });
    const { items } = readHistory({ items: [
        row("2026-10-01T10:00:00Z", { label: "kappa+", beyondTable: false }),
        row("2026-10-20T10:00:00Z", { label: "kappa++", beyondTable: true }),
        row("2026-10-25T10:00:00Z", { rawDan: 21.4, label: "kappa++", beyondTable: true }),
    ] });
    assert.deepEqual(items.map((i) => [i.dan, i.above ?? false]), [[20.2, false], [20.4, true], [21.4, true]]);
    const change = skillChange(items);
    assert.deepEqual(change.danTo, { label: "kappa++", dan: 21.4, above: true });
    assert.equal(danChangeText(change), "Дан: kappa+ → выше Kappa · 21.4 (+1.2)");
    assert.equal(danChangeText(skillChange(items.slice(0, 2))), "Дан: kappa+ → выше Kappa (+0.2)");
    assert.equal(inLang("en", () => danChangeText(change)), "Dan: kappa+ → above Kappa · 21.4 (+1.2)");
    // an ordinary history has no "above" mark at all
    assert.equal("above" in items[0], false);
});
