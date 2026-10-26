// The picks tab's new modes driven through helpers/fakeDom: the plan, favourites with the ☆ marks and the export,
// progress with its chart; and the text helpers in both languages.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, textOf, fire } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import { togglePattern, planRequest, planHeaderText, roleText } from "../../app/renderer/recPlan.js";
import { exportDoneText, exportProgressText } from "../../app/renderer/recFavourites.js";
import { agoText, playLine, summaryText, danChangeText, axesText } from "../../app/renderer/recProgress.js";
import { parseView, DEFAULT_VIEW, sameAccount, modeName, metaParts } from "../../app/renderer/recommendTab.js";
import { similarRequest } from "../../app/renderer/recSimilar.js";

const DAY = 86_400_000;
globalThis.Option = class Option {
    constructor(text, value, _defaultSelected, selected) {
        Object.assign(this, { text, value, selected: Boolean(selected) });
    }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// depth-first: the first node that matches
function find(node, pred) {
    if (pred(node)) return node;
    for (const kid of node.children ?? []) {
        const hit = find(kid, pred);
        if (hit) return hit;
    }
    return null;
}
const buttonIn = (node, text) => find(node, (n) => n.tagName === "BUTTON" && n.textContent === text);

test("plan helpers: pattern chips in turn, the request, the header", () => {
    assert.deepEqual(togglePattern(["jumpstream"], "stream"), ["jumpstream", "stream"]);
    assert.deepEqual(togglePattern(["jumpstream", "stream"], "jumpstream"), ["stream"]);
    assert.deepEqual(togglePattern(["jumpstream"], "jumpstream"), ["jumpstream"], "the last one stays");
    assert.deepEqual(togglePattern(["stream", "tech", "jack"], "chordjack"), ["tech", "jack", "chordjack"], "a fourth pushes out the first");
    assert.deepEqual(togglePattern(["stream"], "nope"), ["stream"]);

    const settings = { source: "manual", lengthId: "short", rankedOnly: 1 };
    assert.deepEqual(planRequest({ planSize: 6, planPatterns: ["tech"] }, settings, 13.2), { size: 6, patternIds: ["tech"], lengthId: "short", rankedOnly: true, manual: true, manualDan: 13.2 });
    assert.equal(planRequest({ planSize: 5, planPatterns: ["tech"] }, { ...settings, source: "tracker" }, 13.2).manualDan, null);

    const header = { playerDan: 13.26, label: "Gamma mid/high", tile: "Stamina" };
    assert.equal(planHeaderText(header, 5, 1040), "План: Stamina Gamma mid/high (13.26) · 5 карт · ≈ 17:20");
    assert.equal(planHeaderText({ playerDan: 13, label: "Gamma mid", tile: null }, 1, 61), "План: Gamma mid (13.00) · 1 карта · ≈ 1:01");
    assert.deepEqual(["warmup", "growth", "challenge"].map(roleText), ["Разминка", "Рост", "Челлендж"]);
    setLang("en");
    try {
        assert.equal(planHeaderText(header, 5, 1040), "Plan: Stamina Gamma mid/high (13.26) · 5 maps · ≈ 17:20");
        assert.equal(planHeaderText(header, 1, 60), "Plan: Stamina Gamma mid/high (13.26) · 1 map · ≈ 1:00");
        assert.deepEqual(["warmup", "growth", "challenge"].map(roleText), ["Warm-up", "Growth", "Challenge"]);
    } finally {
        setLang("ru");
    }
});

test("favourites and similar helpers", () => {
    assert.equal(exportDoneText({ count: 42, skipped: 1 }), "Готово: 42 карты, пропущено 1");
    assert.equal(exportDoneText({ count: 5, skipped: 0 }), "Готово: 5 карт");
    assert.equal(exportProgressText({ done: 3, total: 42 }), "Экспорт… 3 / 42");
    const card = { beatmapId: 1, beatmapsetId: 2, title: "T", seed: { dan: 13 }, extra: "x" };
    assert.deepEqual(similarRequest(card, { rankedOnly: 1, hidePlayed: 0 }), { beatmapId: 1, beatmapsetId: 2, title: "T", seed: { dan: 13 }, rankedOnly: true, hidePlayed: false });
    setLang("en");
    try {
        assert.equal(exportDoneText({ count: 42, skipped: 1 }), "Done: 42 maps, 1 skipped");
        assert.equal(exportDoneText({ count: 1, skipped: 0 }), "Done: 1 map");
    } finally {
        setLang("ru");
    }
});

test("progress lines: played, failed or not yet; the dan and MSD change", () => {
    const now = Date.parse("2026-10-25T18:00:00Z");
    assert.deepEqual([now, now - DAY - 1, now - 3 * DAY].map((at) => agoText(at, now)), ["сегодня", "вчера", "3 дн. назад"]);
    const played = { play: { accuracy: 0.963, rate: 1.1, at: now - 3 * DAY, passed: true }, tries: 1 };
    assert.deepEqual(playLine(played, now), { text: "✓ 96.3% · 1.1x · 3 дн. назад", cls: "ok", played: true });
    assert.equal(playLine({ ...played, play: { ...played.play, rate: 1 }, tries: 3 }, now).text, "✓ 96.3% · 3 дн. назад · 3 попытки");
    assert.deepEqual(playLine({ play: { accuracy: 0.5, passed: false, at: now }, tries: 1 }, now), { text: "✗ не пройдена", cls: "bad", played: true });
    assert.deepEqual(playLine({ play: null, tries: 0 }, now), { text: "не сыграна", cls: "muted", played: false });
    assert.equal(summaryText({ played: 7, total: 15 }), "Сыграно 7 из 15 подобранных");
    const change = { danFrom: { label: "gamma+" }, danTo: { label: "delta--" }, danDelta: 0.4, axes: [{ axis: "Stream", delta: 1.3 }, { axis: "Jack", delta: 0 }, { axis: "Tech", delta: -0.25 }] };
    assert.equal(danChangeText(change), "Дан: gamma+ → delta-- (+0.4)");
    assert.equal(axesText(change), "Stream +1.30 · Tech −0.25");
    assert.equal(danChangeText(null), "");
    setLang("en");
    try {
        assert.deepEqual([now, now - DAY, now - 3 * DAY].map((at) => agoText(at, now)), ["today", "yesterday", "3 days ago"]);
        assert.equal(playLine(played, now).text, "✓ 96.3% · 1.1x · 3 days ago");
        assert.equal(playLine({ ...played, tries: 2 }, now).text, "✓ 96.3% · 1.1x · 3 days ago · 2 tries");
        assert.equal(playLine({ play: { passed: false }, tries: 1 }, now).text, "✗ failed");
        assert.equal(playLine({ play: null }, now).text, "not played yet");
        assert.equal(summaryText({ played: 7, total: 15 }), "Played 7 of 15 picks");
        assert.equal(danChangeText(change), "Dan: gamma+ → delta-- (+0.4)");
    } finally {
        setLang("ru");
    }
});

test("the view settings, the account match and the mode names", () => {
    assert.deepEqual(parseView(null), DEFAULT_VIEW);
    assert.deepEqual(parseView("{oops"), DEFAULT_VIEW);
    const v = parseView(JSON.stringify({ mode: "plan", planSize: 6, planPatterns: ["tech", "nope", "tech", "stream", "jack", "chordjack"], progressDays: 90, progressAxis: "Stream", favName: "x" }));
    assert.deepEqual(v, { mode: "plan", planSize: 6, planPatterns: ["tech", "stream", "jack"], progressDays: 90, progressAxis: "Stream", favName: "x" });
    assert.deepEqual(parseView(JSON.stringify({ mode: "evil", planSize: 9, planPatterns: [], progressDays: 14, progressAxis: "LN" })), DEFAULT_VIEW);
    assert.equal(DEFAULT_VIEW.favName, "Lunacy mania picks");
    const p = { id: 1234567, username: "TestPlayer" };
    assert.deepEqual(["testplayer", " TESTPLAYER ", "1234567", "TestPlaye", "", null].map((q) => sameAccount(p, q)), [true, true, true, false, false, false]);
    assert.deepEqual(["picks", "plan", "fav", "progress"].map((m) => modeName(m, 3)), ["Подбор", "План", "Избранное (3)", "Прогресс"]);
    setLang("en");
    try {
        assert.deepEqual(["picks", "plan", "fav", "progress"].map((m) => modeName(m, 3)), ["Picks", "Plan", "Favourites (3)", "Progress"]);
    } finally {
        setLang("ru");
    }
    // moved to recCard.js, still read from the tab module
    assert.equal(metaParts({ danLabel: "Gamma mid", playCount: 5 })[0].text, "Gamma mid");
});

// ---- the tab through the fake DOM ----

const SEED = { primaryPattern: "jumpstream", msdAll: {}, patternsAll: {}, bpm: 200, lengthSec: 120, dan: 13 };
const card = (id, extra = {}) => ({
    beatmapId: id, beatmapsetId: id + 100, artist: "Artist", title: `Song ${id}`, version: "[4K] V", creator: "C", status: "ranked",
    stars: 5, bpm: 200, lengthSec: 120, playCount: 5000, cover: null, dan: 13.1, danLabel: "Gamma mid", delta: 0.1, msd: 30,
    purity: 0.8, purityLabel: "чистый", played: null, setPlayed: false, score: 0.5, seed: SEED, ...extra,
});

function makeApi() {
    const calls = { plan: [], swap: [], favAdd: [], favRemove: [], export: [], progress: [], similar: [], download: [] };
    let favItems = [];
    let exportProgress = null;
    const api = {
        onRecDownloadProgress: () => {},
        onProfileChanged: () => {},
        onRecFavExportProgress: (cb) => { exportProgress = cb; return () => {}; },
        recPlayer: async () => ({ ok: true, player: { id: 7, username: "Luna" }, skill: { overall: 13, tiles: {}, analyzedPlays: 1 } }),
        recPlan: async (req) => {
            calls.plan.push(req);
            return {
                ok: true,
                header: { playerDan: 13, label: "Gamma mid", tile: null, source: "manual", patternId: "jumpstream" },
                slots: [
                    { role: "warmup", patternId: "jumpstream", lo: 12.3, hi: 12.65, center: 12.48, card: card(1, { lengthSec: 100 }) },
                    { role: "challenge", patternId: "jumpstream", lo: 13.5, hi: 13.9, center: 13.7, card: null },
                ],
                totalSec: 100,
                playedPartial: false,
            };
        },
        recPlanSwap: async (slot) => { calls.swap.push(slot); return { ok: true, card: card(9, { lengthSec: 200 }) }; },
        recSimilar: async (req) => { calls.similar.push(req); return { ok: true, cards: [card(20, { sim: 0.9, simLabel: "очень похожа" })] }; },
        recFavList: async () => ({ ok: true, items: favItems }),
        recFavAdd: async (c) => { calls.favAdd.push(c.beatmapId); favItems = [c, ...favItems]; return { ok: true, items: favItems }; },
        recFavRemove: async (id) => { calls.favRemove.push(id); favItems = favItems.filter((f) => f.beatmapId !== id); return { ok: true, items: favItems }; },
        recFavExport: async (name) => {
            calls.export.push(name);
            exportProgress?.({ done: 1, total: 2 });
            return { ok: true, file: "C:/docs/коллекции/collection.db", count: 1, skipped: 1 };
        },
        recShow: async () => ({ ok: true }),
        recDownload: async (req) => { calls.download.push(req); return { ok: true, file: `C:/dl/${req.beatmapsetId}.osz`, opened: true, reused: false }; },
        recOurs: async () => ({ ok: true, ours: { label: "Gamma mid" }, rate: 1.05, rateLabel: "Gamma high", reason: null }),
        recOpen: async () => ({ ok: true }),
        recProgress: async (days) => {
            calls.progress.push(days);
            const now = Date.now();
            return {
                ok: true, since: now - days * DAY, played: 1, total: 2, partial: false,
                picks: [
                    { beatmapId: 1, artist: "A", title: "Played one", version: "V", at: now - 2 * DAY, play: { accuracy: 0.97, rate: 1, at: now - DAY, passed: true }, tries: 1 },
                    { beatmapId: 2, artist: "A", title: "Not yet", version: "V", at: now - DAY, play: null, tries: 0 },
                ],
                points: [{ at: now - days * DAY, dan: 13.4, label: "gamma++", ratings: { Overall: 33 } }, { at: now, dan: 13.6, label: "delta--", ratings: { Overall: 34 } }],
                change: { danFrom: { label: "gamma++", dan: 13.4 }, danTo: { label: "delta--", dan: 13.6 }, danDelta: 0.2, axes: [{ axis: "Overall", from: 33, to: 34, delta: 1 }] },
            };
        },
    };
    return { api, calls };
}

test("modes, the plan with a swap, the ☆ marks with the favourites count, the export and progress", async () => {
    const { api, calls } = makeApi();
    const { $ } = fakeDom(api, { storage: { "rec-settings": JSON.stringify({ source: "manual", level: 13, step: "mid" }) } });
    // the progress chart draws SVG
    const make = globalThis.document.createElement;
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(make(tag), { setAttribute(key, value) { this[key] = value; } });
    const { initRecommendTab, onRecommendTabShown } = await import("../../app/renderer/recommendTab.js");
    initRecommendTab();
    await onRecommendTabShown();
    await settle();
    const modes = $("rec-mode").children;
    assert.deepEqual(modes.map((c) => c.textContent), ["Подбор", "План", "Избранное (0)", "Прогресс"]);
    assert.equal($("rec-picks-pane").hidden, false);
    assert.equal($("rec-plan-pane").hidden, true);

    // the plan
    await fire(modes[1]);
    assert.deepEqual([$("rec-picks-pane").hidden, $("rec-plan-pane").hidden, $("rec-filters").hidden, $("rec-plan-run").hidden, $("rec-fav-pane").hidden], [true, false, false, false, true]);
    assert.deepEqual($("rec-plan-size").children.map((c) => c.textContent), ["5", "6"]);
    await fire($("rec-plan-size").children[1]);
    await fire($("rec-plan-go"));
    assert.deepEqual(calls.plan, [{ size: 6, patternIds: ["jumpstream"], lengthId: "any", rankedOnly: false, manual: true, manualDan: 13 }]);
    assert.equal($("rec-plan-head").textContent, "План: Gamma mid (13.00) · 1 карта · ≈ 1:40");
    assert.equal($("rec-plan-list").children.length, 2);
    const [first, empty] = $("rec-plan-list").children;
    assert.ok(textOf(first).includes("Разминка"));
    assert.ok(textOf(empty).includes("Челлендж") && textOf(empty).includes("Для этого места карт не нашлось"));
    assert.equal($("rec-plan-status").textContent, "Не на все места нашлись карты");
    await fire(buttonIn(first, "↻ Другая"));
    assert.deepEqual(calls.swap, [0]);
    assert.ok(textOf($("rec-plan-list").children[0]).includes("Song 9"));
    assert.equal($("rec-plan-head").textContent, "План: Gamma mid (13.00) · 1 карта · ≈ 3:20");
    // all its cards downloaded one by one, through each card
    await fire($("rec-plan-download"));
    assert.deepEqual(calls.download, [{ beatmapsetId: 109, beatmapId: 9, artist: "Artist", title: "Song 9" }]);
    assert.equal($("rec-plan-status").textContent, "Скачано 1 из 1");

    // ☆ on the plan's card adds it; the mode chip counts it
    const star = buttonIn($("rec-plan-list").children[0], "☆");
    assert.equal(star.title, "В избранное");
    await fire(star);
    assert.deepEqual(calls.favAdd, [9]);
    assert.equal(star.textContent, "★");
    assert.equal(star.title, "В избранном");
    assert.equal(modes[2].textContent, "Избранное (1)");

    // similar maps under the card
    await fire(buttonIn($("rec-plan-list").children[0], "Похожие"));
    assert.equal(calls.similar[0].beatmapId, 9);
    const similar = find($("rec-plan-list").children[0], (n) => n.className === "rec-similar");
    assert.equal(similar.hidden, false);
    assert.ok(textOf(similar).includes("Похожие на эту") && textOf(similar).includes("очень похожа") && textOf(similar).includes("Song 20"));

    // favourites: the list, ✕, the export
    await fire(modes[2]);
    await settle();
    assert.equal($("rec-fav-list").children.length, 1);
    assert.equal($("rec-fav-name").value, "Lunacy mania picks");
    $("rec-fav-name").value = "Мои";
    await fire($("rec-fav-export"));
    assert.deepEqual(calls.export, ["Мои"]);
    assert.equal(textOf($("rec-fav-result")), "Готово: 1 карта, пропущено 1 | Показать файл");
    assert.equal($("rec-fav-export").textContent, "Экспорт в collection.db");
    await fire(buttonIn($("rec-fav-list").children[0], "✕"));
    assert.deepEqual(calls.favRemove, [9]);
    assert.equal($("rec-fav-list").children.length, 0);
    assert.equal($("rec-fav-status").textContent, "Пока пусто — отмечай карты кнопкой ☆");
    assert.equal(modes[2].textContent, "Избранное (0)");

    // progress: the period chips, the lines, the change and the chart
    await fire(modes[3]);
    await settle();
    assert.deepEqual(calls.progress, [30]);
    assert.deepEqual($("rec-progress-days").children.map((c) => c.textContent), ["7 дн", "30 дн", "90 дн"]);
    assert.equal($("rec-progress-summary").textContent, "Сыграно 1 из 2 подобранных");
    assert.ok(textOf($("rec-progress-list")).includes("✓ 97.0% · вчера"));
    assert.ok(textOf($("rec-progress-list")).includes("не сыграна | osu!direct"));
    assert.ok(textOf($("rec-progress-change")).startsWith("Дан: gamma++ → delta-- (+0.2) | Overall +1.00"));
    const chart = $("rec-progress-chart").children[0];
    assert.equal(chart.tagName, "SVG");
    assert.ok(chart.children.some((n) => n.tagName === "PATH" && /^M/.test(n.d)));
    assert.ok(chart.children.some((n) => n.tagName === "CIRCLE"), "a dot where the picked map was played");
    await fire($("rec-progress-days").children[0]);
    await settle();
    assert.deepEqual(calls.progress, [30, 7]);
    assert.equal(JSON.parse(globalThis.localStorage.getItem("rec-view")).progressDays, 7);
});

test("a card's «our analysis» line follows the General / Detailed switch from another tab", async () => {
    const { api } = makeApi();
    api.recOurs = async () => ({ ok: true, ours: { label: "Gamma mid", primary: "Rolls" }, rate: null, rateLabel: null, reason: "in-target" });
    const { $ } = fakeDom(api, { storage: { "rec-settings": JSON.stringify({ source: "manual", level: 13, step: "mid" }) } });
    const { resetPatternMode, setPatternMode } = await import("../../app/renderer/patternMode.js");
    resetPatternMode();
    const { initRecommendTab, onRecommendTabShown } = await import("../../app/renderer/recommendTab.js");
    initRecommendTab();
    await onRecommendTabShown();
    await settle();
    await fire($("rec-mode").children[1]);
    await fire($("rec-plan-go"));
    const first = $("rec-plan-list").children[0];
    await fire(buttonIn(first, "Наш анализ"));
    await settle();
    const ours = () => find(first, (n) => n.className === "rec-ours" && !n.hidden && n.children.length > 0).children[0].textContent;
    assert.equal(ours(), "Наш анализатор: Gamma mid · Stream");
    setPatternMode("detailed");
    assert.equal(ours(), "Наш анализатор: Gamma mid · Роллы");
    setPatternMode("general");
    assert.equal(ours(), "Наш анализатор: Gamma mid · Stream");
});
