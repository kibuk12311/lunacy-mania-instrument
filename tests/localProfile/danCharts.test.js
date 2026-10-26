// The Profile tab's dan pictures (app/renderer/danCharts.js, the bars and the history chart's dan scale in
// profileViews.js): the geometry (value → x, the window, the ticks, the ± bands, the spider's points), the tips and
// the legend in ru / en, empty and low-confidence states, and both pages of the tab through a fake DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
    levelName, danWindow, scaleX, levelTicks, danYTicks, skillRows, rowTip, overallTip, legendText, radarPoints, radarRadius,
    scaleSvg, radarSvg, skillChart, SCALE, RADAR,
} from "../../app/renderer/danCharts.js";
import { patternTable, lineChart } from "../../app/renderer/profileViews.js";
import { PATTERNS } from "../../src/localProfile/model.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { fakeDom, textOf, fire } from "../helpers/fakeDom.js";

const NOW = Date.now();

// fakeDom plus SVG nodes that keep their attributes
function dom(api = {}, options) {
    const d = fakeDom(api, options);
    const make = globalThis.document.createElement;
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(make(tag), { attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
    globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
    return d;
}

// every node under one, itself included
const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
const byClass = (node, cls) => all(node).filter((n) => String(n.attrs?.class ?? n.className ?? "").split(" ").includes(cls));

const est = (dan, halfWidth, confidence, maps) => ({ dan, halfWidth, confidence, maps, evidence: 1, top: [] });
function localSkill() {
    return {
        local: true, overall: 13.07, partial: true,
        tiles: { speed: 13.42, jack: 12.8, stamina: 13, tech: null },
        axes: { speed: est(13.42, 0.31, "high", 12), jack: est(12.8, 0.9, "low", 3), stamina: est(13, 0.43, "medium", 6), tech: est(null, null, "none", 1) },
        patterns: Object.fromEntries(PATTERNS.map((p, i) => [p, i < 3 ? est(12.5 + i * 0.4, 0.3 + i * 0.1, ["high", "medium", "low"][i], 4 + i) : est(null, null, "none", i - 3)])),
    };
}
const trackerSkill = () => ({ overall: 13.27, overallLabel: "Gamma mid/high", tiles: { speed: 14, jack: 12.6, stamina: 13.2, tech: 13.3 }, msd: { Stream: 30.1 } });

test("the dan names on the axis: numbers, then Alpha … Kappa, then «выше Kappa»", () => {
    setLang("ru");
    assert.deepEqual([9, 10, 11, 13, 20].map(levelName), ["9", "10", "Alpha", "Gamma", "Kappa"]);
    assert.equal(levelName(21), "выше Kappa");
    assert.equal(levelName(22), "22");
    setLang("en");
    assert.equal(levelName(21), "above Kappa");
    setLang("ru");
});

test("the window: a dan on each side of the values, at least three, never below dan 1", () => {
    assert.deepEqual(danWindow([12.57, 13.43]), { first: 12, last: 14, lo: 11.5, hi: 14.5 });
    assert.deepEqual(danWindow([13]), { first: 12, last: 14, lo: 11.5, hi: 14.5 });
    assert.deepEqual(danWindow([12.9, 13.1], { margin: 0 }), { first: 12, last: 14, lo: 11.5, hi: 14.5 }, "too narrow: grows on both sides to three levels");
    assert.deepEqual(danWindow([1.2]), { first: 1, last: 3, lo: 0.5, hi: 3.5 });
    assert.deepEqual(danWindow([10.2, 17.8]), { first: 9, last: 19, lo: 8.5, hi: 19.5 });
    assert.deepEqual(danWindow([12.6, 13.8], { below: 1, above: 0 }), { first: 12, last: 14, lo: 11.5, hi: 14.5 }, "the spider's: a dan below only");
    assert.deepEqual(danWindow([13.2], { below: 1, above: 0 }), { first: 12, last: 14, lo: 11.5, hi: 14.5 });
    assert.equal(danWindow([]), null);
    assert.equal(danWindow([null, NaN]), null);
});

test("value → x: the window's ends at the plot's ends, clamped outside", () => {
    const x = scaleX({ first: 12, last: 14, lo: 11.5, hi: 14.5 }, 62, 292);
    assert.equal(x(11.5), 62);
    assert.equal(x(14.5), 292);
    assert.equal(x(13), 177);
    assert.equal(x(9), 62);
    assert.equal(x(30), 292);
});

test("the axis ticks: an edge between dans, low / mid / high in each, names thinned on a crowded axis", () => {
    const wide = levelTicks({ first: 12, last: 14, lo: 11.5, hi: 14.5 }, 62, 292);
    assert.equal(wide.length, 3 * 4 + 1);
    assert.deepEqual(wide.filter((k) => k.kind === "mid").map((k) => k.label), ["Alpha", "Beta", "Gamma"].map((_, i) => levelName(12 + i)));
    assert.deepEqual(wide.filter((k) => k.kind === "edge").map((k) => k.value), [11.5, 12.5, 13.5, 14.5]);
    assert.ok(wide.filter((k) => k.kind === "low").every((k) => k.label === "low"), "76 px a level: room for low / high");
    const lowTick = wide.find((k) => k.kind === "low" && k.value === 12.6);
    assert.ok(lowTick && Math.abs(lowTick.x - 62 - (1.1 / 3) * 230) < 0.1);
    const crowded = levelTicks({ first: 9, last: 19, lo: 8.5, hi: 19.5 }, 62, 292);
    const names = crowded.filter((k) => k.kind === "mid" && k.label).map((k) => k.label);
    assert.deepEqual(names, ["9", "Beta", "Epsilon", "Theta"], "21 px a level: every third name");
    assert.ok(crowded.filter((k) => k.kind === "high").every((k) => k.label === ""));
});

test("the history chart's dan scale: names with numbers 14 px apart, a line between dans", () => {
    const box = { height: 110, pad: 8 };
    const narrow = danYTicks(12.9, 13.1, box);
    assert.deepEqual(narrow.labels.map((l) => l.text), ["Gamma mid 13.0"]);
    const wide = danYTicks(11.6, 14.4, box);
    const texts = wide.labels.map((l) => l.text);
    assert.ok(texts.includes("Alpha mid 11.0") === false && texts.includes("Beta mid 12.0") && texts.includes("Gamma mid 13.0") && texts.includes("Delta mid 14.0"), texts.join(", "));
    assert.ok(!texts.some((x) => x.includes("low") || x.includes("high")), "34 px a dan: mids only");
    assert.deepEqual(danYTicks(12.5, 13.5, box).labels.map((l) => l.text), ["Gamma high 13.4", "Gamma mid 13.0", "Gamma low 12.6"], "94 px a dan: low / mid / high");
    for (let i = 1; i < wide.labels.length; i += 1) assert.ok(wide.labels[i].y - wide.labels[i - 1].y >= 14);
    assert.deepEqual(wide.lines.filter((l) => l.kind === "edge").map((l) => l.y), [12.5, 13.5].map((v) => Math.round((8 + (1 - (v - 11.6) / 2.8) * 94) * 10) / 10));
    // a tiny range with no tick inside still names its middle
    assert.deepEqual(danYTicks(13.15, 13.25, box).labels.map((l) => l.text), ["Gamma mid/high 13.20"]);
    assert.deepEqual(danYTicks(null, 13, box), { lines: [], labels: [] });
});

test("the tips say the dan's name, its number ± range, the confidence and the maps, in ru and en", () => {
    setLang("ru");
    const rows = skillRows(localSkill());
    assert.deepEqual(rows.map((r) => r.key), ["speed", "jack", "stamina", "tech"]);
    assert.equal(rowTip(rows[2]), "Stamina: Gamma mid (13.00 ± 0.43), уверенность средняя, по 6 картам");
    assert.equal(rowTip({ ...rows[2], maps: 1 }), "Stamina: Gamma mid (13.00 ± 0.43), уверенность средняя, по 1 карте");
    assert.equal(rowTip({ ...rows[2], maps: 21 }), "Stamina: Gamma mid (13.00 ± 0.43), уверенность средняя, по 21 карте");
    assert.equal(rowTip(rows[3]), "Tech: мало игр, карт: 1");
    assert.equal(rowTip({ ...rows[0], dan: 21.3 }), "Speed: выше Kappa (21.30 ± 0.31), уверенность высокая, по 12 картам");
    const tracker = skillRows(trackerSkill());
    assert.equal(rowTip(tracker[2]), "Stamina: Gamma mid/high (13.20)");
    assert.equal(overallTip(trackerSkill()), "Общий: Gamma mid/high (13.27)");
    assert.equal(legendText(localSkill()), "13.07 = Gamma mid. Целое число — дан (11 = Alpha … 20 = Kappa), дробь — low/mid/high внутри дана; ± — насколько уверена оценка");
    assert.ok(!legendText(trackerSkill()).includes("±"), "the tracker has no ± ranges");
    assert.ok(legendText({ local: true, axes: {} }).startsWith("13.00 = Gamma mid."), "no dan yet: the example");
    setLang("en");
    assert.equal(rowTip(rows[2]), "Stamina: Gamma mid (13.00 ± 0.43), medium confidence, from 6 maps");
    assert.equal(rowTip({ ...rows[2], maps: 1 }), "Stamina: Gamma mid (13.00 ± 0.43), medium confidence, from 1 map");
    assert.equal(rowTip(rows[3]), "Tech: not enough plays, maps: 1");
    assert.ok(legendText(localSkill()).startsWith("13.07 = Gamma mid. The whole number is the dan"));
    setLang("ru");
});

test("the spider's points: Speed up, Jack right, Stamina down, Tech left; no dan → the centre", () => {
    const win = { first: 12, last: 14, lo: 11.5, hi: 14.5 };
    const rows = skillRows(localSkill());
    const p = radarPoints(rows, win, { cx: 150, cy: 118, r: 78 });
    const rad = radarRadius(win, 78);
    assert.equal(rad(11.5), 0);
    assert.equal(rad(14.5), 78);
    assert.deepEqual([p[0].x, p[0].y], [150, Math.round((118 - rad(13.42)) * 10) / 10], "Speed straight up");
    assert.deepEqual([p[1].x, p[1].y], [Math.round((150 + rad(12.8)) * 10) / 10, 118], "Jack to the right");
    assert.deepEqual([p[2].x, p[2].y], [150, Math.round((118 + rad(13)) * 10) / 10], "Stamina down");
    assert.deepEqual([p[3].x, p[3].y, p[3].known], [150, 118, false], "Tech has no dan");
});

test("the scale: a row a skill, the ± band to scale and faded by confidence, «мало игр» dashed, the overall's line", () => {
    dom();
    setLang("ru");
    const picked = [];
    const chart = scaleSvg(localSkill(), (text) => picked.push(text));
    assert.equal(chart.attrs.viewBox, `0 0 ${SCALE.width} ${SCALE.top + 4 * SCALE.row + SCALE.bottom}`);
    const rows = byClass(chart, "prof-viz-row");
    assert.deepEqual(rows.map((r) => r.attrs["data-key"]), ["speed", "jack", "stamina", "tech"]);
    // the window holds every dan ± its range: jack 12.8 − 0.9 = 11.9 … speed 13.73 → levels 11 … 15
    const x = scaleX(danWindow([13.42 - 0.31, 13.42 + 0.31, 12.8 - 0.9, 12.8 + 0.9, 13 - 0.43, 13 + 0.43, 13.07]), SCALE.x0, SCALE.x1);
    const [speedBand] = byClass(rows[0], "prof-viz-band");
    assert.equal(Number(speedBand.attrs.x), x(13.11));
    assert.ok(Math.abs(speedBand.attrs.width - (x(13.73) - x(13.11))) < 0.11);
    assert.ok(speedBand.attrs.class.includes("prof-conf-high"));
    assert.ok(byClass(rows[1], "prof-viz-band")[0].attrs.class.includes("prof-conf-low"), "low confidence: the faintest band");
    assert.equal(Number(byClass(rows[2], "prof-viz-dot")[0].attrs.cx), x(13));
    assert.equal(byClass(rows[3], "prof-viz-band").length, 0);
    assert.ok(textOf(rows[3]).includes("мало игр"));
    assert.ok(byClass(rows[3], "prof-viz-track")[0].attrs.class.includes("few"));
    const [overall] = byClass(chart, "prof-viz-overall-line");
    assert.equal(Number(overall.attrs.x1), x(13.07));
    assert.ok(textOf(chart).includes("Общий Gamma mid"));
    assert.ok(textOf(chart).includes("Alpha") && textOf(chart).includes("Gamma"));
    // hover and tap name the row
    fire(rows[2], "mouseenter");
    fire(rows[0], "click");
    assert.deepEqual(picked, [rowTip(skillRows(localSkill())[2]), rowTip(skillRows(localSkill())[0])]);
    assert.ok(all(rows[2]).some((n) => n.tagName === "TITLE" && n.textContent.includes("по 6 картам")), "a native tooltip too");
    // the tracker's skill: dots, no bands
    const tracker = scaleSvg(trackerSkill());
    assert.equal(byClass(tracker, "prof-viz-band").length, 0);
    assert.equal(byClass(tracker, "prof-viz-dot").length, 4);
    assert.equal(scaleSvg({ local: true, overall: null, axes: {} }), null);
});

test("the spider chart: rings at every dan, the overall ring, whiskers, names and dans at the ends", () => {
    dom();
    setLang("en");
    const chart = radarSvg(localSkill());
    assert.equal(chart.attrs.viewBox, `0 0 ${RADAR.width} ${RADAR.height}`);
    assert.ok(byClass(chart, "ring").length >= 5);
    assert.equal(byClass(chart, "prof-viz-whisker").length, 3, "three axes with a ±");
    assert.equal(byClass(chart, "prof-viz-dot").length, 3);
    assert.ok(byClass(chart, "prof-viz-shape")[0].attrs.class.includes("few"), "an axis without a dan: the shape is dashed");
    const text = textOf(chart);
    assert.ok(text.includes("Speed") && text.includes("Gamma low/mid") && text.includes("not enough plays"), text);
    assert.ok(!/[А-Яа-яЁё]/.test(text));
    setLang("ru");
});

test("the chart box: «Шкала / Паутинка» remembered, the caption follows the pointer, the legend; nothing without a dan", () => {
    const { storage } = dom();
    setLang("ru");
    const box = skillChart(localSkill());
    const [modes, holder, tip, legend] = box.children;
    assert.deepEqual(modes.children.map((c) => c.textContent), ["Шкала", "Паутинка"]);
    assert.equal(modes.children[0].className, "sel");
    assert.equal(tip.textContent, t("profile.chart.tapHint"));
    assert.ok(legend.textContent.startsWith("13.07 = Gamma mid."));
    fire(byClass(holder, "prof-viz-row")[2], "click");
    assert.equal(tip.textContent, "Stamina: Gamma mid (13.00 ± 0.43), уверенность средняя, по 6 картам");
    fire(modes.children[1]);
    assert.equal(storage.get("profile-skill-chart"), "radar");
    assert.equal(box.children[0].children[1].className, "sel");
    assert.ok(byClass(holder, "prof-viz-shape").length === 1, "the spider is drawn");
    assert.ok(byClass(skillChart(localSkill()).children[1], "prof-viz-shape").length === 1, "the next one opens as a spider");
    assert.equal(skillChart({ local: true, overall: null, axes: {} }), null);
    assert.equal(skillChart(null), null);
});

test("the pattern bars: best first, a bar to the dan with a ± whisker, «мало игр» greyed last, the dan names above", () => {
    dom();
    setLang("ru");
    const table = patternTable(localSkill());
    const rows = table.children.filter((c) => String(c.className).startsWith("prof-trow"));
    assert.equal(rows.length, 7);
    const names = rows.map((r) => r.children[0].textContent);
    assert.deepEqual(names.slice(0, 3), ["Хендстрим", "Джампстрим", "Стрим"], names.join(", "));
    const dans = rows.slice(0, 3).map((r) => r.children[2].textContent);
    assert.ok(dans[0].includes("13.30") && dans[1].includes("12.90") && dans[2].includes("12.50"), dans.join(" / "));
    assert.ok(rows.slice(3).every((r) => r.className.includes("few") && r.children[2].textContent.includes("мало игр")));
    // the bars: same axis for all, in percent of the column
    const win = danWindow([12.5 - 0.3, 12.5 + 0.3, 12.9 - 0.4, 12.9 + 0.4, 13.3 - 0.5, 13.3 + 0.5]);
    const x = scaleX(win, 0, 100);
    const [bar] = byClass(rows[0], "prof-bar");
    assert.equal(Number(bar.attrs.width), x(13.3));
    assert.ok(bar.attrs.class.includes("prof-conf-low"));
    assert.equal(Number(byClass(rows[0], "prof-bar-whisker")[0].attrs.x1), x(12.8));
    assert.equal(byClass(rows[4], "prof-bar").length, 0);
    const axis = table.children.find((c) => c.className === "prof-bars-axis");
    // 11 … 15: five levels in about 180 px, every other name
    assert.deepEqual(axis.children.map((s) => s.textContent), ["Alpha", "Gamma", "Epsilon"]);
    assert.equal(axis.children[1].style.left, `${x(13)}%`);
    // no pattern with a dan: rows only, no axis
    const empty = patternTable({ local: true, patterns: {} });
    assert.ok(!empty.children.some((c) => c.className === "prof-bars-axis"));
    assert.ok(textOf(empty).includes("мало игр"));
});

test("the history chart names its dan axis in dans, the tracker's ratings in numbers", () => {
    dom();
    const points = [0, 1, 2, 3].map((i) => ({ at: NOW - (3 - i) * 86_400_000, dan: 12.6 + i * 0.4, ratings: { speed: 12.4 + i * 0.4, Stream: 30 + i } }));
    const labels = (chart) => byClass(chart, "prof-chart-label").map((n) => n.textContent);
    const dan = lineChart(points, "dan", { from: NOW - 4 * 86_400_000, to: NOW });
    assert.ok(labels(dan).some((l) => l === "Gamma mid 13.0"), labels(dan).join(", "));
    assert.ok(byClass(dan, "prof-chart-edge").length >= 1, "a line between dans");
    const speed = lineChart(points, "speed", { from: NOW - 4 * 86_400_000, to: NOW });
    assert.ok(labels(speed).some((l) => l.startsWith("Beta") || l.startsWith("Gamma")));
    const stream = lineChart(points, "Stream", { from: NOW - 4 * 86_400_000, to: NOW });
    assert.deepEqual(labels(stream), ["33.00", "31.50", "30.00"]);
    assert.equal(lineChart([], "dan"), null);
});

// ---- both pages of the tab ----

async function profileTab(lang, page) {
    setLang(lang);
    const skill = localSkill();
    const api = {
        localProfileStatus: async () => ({
            ok: true, skill, settings: { record: true, imports: {} }, counts: { plays: 20, rated: 18, live: 2, stable: 18, interlude: 0 },
            top: {}, recent: [], importing: null, interludeLinked: false,
        }),
        localProfileHistory: async () => ({ ok: true, since: NOW - 90 * 86_400_000, now: NOW, points: [], change: null }),
        recPlayer: async () => ({ ok: true, player: { id: 1, username: "TestPlayer", avatarUrl: null }, skill: trackerSkill() }),
        recProgress: async () => ({ ok: false, message: "x" }),
        trackerRecent: async () => ({ ok: true, plays: [] }),
        onLocalProfileChanged: () => {}, onLocalProfileImport: () => {}, onProfileChanged: () => {},
        profileGet: async () => ({ ok: false }), profileEnsure: async () => ({ ok: false, reason: "none" }),
    };
    const d = dom(api, { storage: { "rec-settings": JSON.stringify({ source: "local" }), "profile-view": JSON.stringify({ page }) } });
    const mod = await import(`../../app/renderer/profileTab.js?viz${lang}${page}${Math.random()}`);
    mod.initProfileTab();
    mod.onProfileTabShown();
    await new Promise((r) => setTimeout(r, 20));
    return d;
}

for (const lang of ["ru", "en"]) {
    test(`Profile tab (${lang}), my profile: the scale under the summary, the legend, the pattern bars`, async () => {
        const { $ } = await profileTab(lang, "local");
        try {
            const card = $("prof-local-card");
            const viz = card.children.find((c) => c.className === "prof-viz");
            assert.ok(viz, "the chart box");
            const text = textOf(viz);
            assert.ok(text.includes(t("profile.chart.scale")) && text.includes(t("profile.chart.radar")) && text.includes("13.07 = Gamma mid"));
            assert.equal(byClass(viz, "prof-viz-row").length, 4);
            assert.ok(text.includes(t("profile.local.fewPlays")), "Tech: not enough plays");
            const bars = textOf($("prof-local-patterns"));
            assert.ok(bars.includes("13.30") && bars.includes("Gamma"));
            if (lang === "en") assert.ok(!/[А-Яа-яЁё]/.test(`${textOf(card)} ${bars}`), `${textOf(card)} ${bars}`);
        } finally {
            setLang("ru");
        }
    });

    test(`Profile tab (${lang}), mania-tracker: the same chart for the tracker's four skills and overall`, async () => {
        const { $ } = await profileTab(lang, "tracker");
        try {
            $("prof-user").value = "TestPlayer";
            await fire($("prof-load"));
            await new Promise((r) => setTimeout(r, 20));
            const card = $("prof-tracker-card");
            const viz = card.children.find((c) => c.className === "prof-viz");
            assert.ok(viz, textOf(card));
            assert.equal(byClass(viz, "prof-viz-dot").length, 4);
            assert.equal(byClass(viz, "prof-viz-band").length, 0, "the tracker has no ± ranges");
            assert.equal(byClass(viz, "prof-viz-overall-line")[0].attrs.x1 > 0, true);
            const text = textOf(viz);
            assert.ok(text.includes("13.27 = Gamma mid/high") && !text.includes("±"), text);
            if (lang === "en") assert.ok(!/[А-Яа-яЁё]/.test(textOf(card)), textOf(card));
        } finally {
            setLang("ru");
        }
    });
}
