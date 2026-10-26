// The marathon tab in a fake DOM: rows set from outside (the auto-marathon), the curve under the list, the
// auto-marathon panel with its saved choices, templates, progress, stop and the shared profile.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, textOf, fire } from "./helpers/fakeDom.js";
import { initMarathonTab, setEntries, onListChange } from "../app/renderer/marathonTab.js";
import { progressText, warningText } from "../app/renderer/marathonAuto.js";

const ticks = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const SKILL = { overall: 12, tiles: { speed: 12, stamina: 14.2, tech: 11, jack: 10 }, msd: {} };
const saved = { templateId: "stamina", patternIds: ["handstream", "stamina"], source: "manual", manualDan: 15, rankedOnly: true, mode: "append" };

let autoReply = async () => ({ ok: true, entries: [], warnings: [] });
const autoCalls = [];
let progress = null;
let cancels = 0;
let ensures = 0;
const created = [];
const { $, window, storage } = fakeDom({
    marathonDan: async (_file, rate) => ({ label: `D${rate}`, numeric: 12 + rate, cutMs: 60000 }),
    marathonAuto: async (req) => { autoCalls.push(req); return autoReply(req); },
    marathonAutoCancel: async () => { cancels += 1; return { ok: true }; },
    onMarathonAutoProgress: (cb) => { progress = cb; return () => {}; },
    profileEnsure: async () => { ensures += 1; return { ok: true, player: { id: 1, username: "Мира" }, skill: SKILL }; },
    marathonCreate: async (req) => { created.push(req); return { ok: true, totalMs: 1000, file: "x.osz" }; },
}, { storage: { "marathon.auto.v1": JSON.stringify(saved) } });
$("mar-gap").value = "10";
$("mar-od").value = "8";
$("mar-hp").value = "8";
$("mar-title").value = "Мой марафон";
initMarathonTab();

const names = () => $("mar-list").children.map((row) => row.children[1]?.textContent);
const selected = (box) => box.children.filter((c) => c.className === "sel").map((c) => c.textContent);
const svg = () => $("mar-curve").children[0].innerHTML;
const row = (name, numeric, cutMs = 60000, rate = 1) => ({ path: `${name}.osu`, name, rate, label: `L${numeric}`, numeric, cutMs });

test("the auto-marathon panel comes back with the choices saved last time", () => {
    assert.equal($("mar-tpl").value, "stamina");
    assert.equal($("mar-tpl-hint").textContent, "4 длинные карты (4+ мин): JS/HS/стамина");
    assert.deepEqual(selected($("mar-patterns")), ["Хендстрим", "Стамина"]);
    assert.equal($("mar-src-manual").checked, true);
    assert.equal($("mar-manual").hidden, false);
    assert.equal($("mar-level").value, "15");
    assert.equal($("mar-dan-step").value, "mid");
    assert.equal($("mar-ranked").checked, true);
    assert.equal($("mar-custom").hidden, true);
    // no profile yet: the hint, and played maps can't be skipped
    assert.equal($("mar-profile").textContent, "Профиль не загружен — загрузи его во вкладке «Подбор» или выбери дан вручную.");
    assert.equal($("mar-skip-played").disabled, true);
    // the list is empty: no replace / append choice, no curve
    assert.equal($("mar-mode").hidden, true);
    assert.equal($("mar-curve-box").hidden, true);
});

test("setEntries replaces or appends rows that already know their dan; onListChange hears every change", () => {
    const counts = [];
    const off = onListChange((n) => counts.push(n));
    setEntries([{ ...row("A", 12.6), targetDan: 12.55, rate: 1.1 }, row("B", 13)], "replace");
    assert.deepEqual(names(), ["A", "B"]);
    const first = $("mar-list").children[0];
    assert.equal(first.children[2].value, "1.1");
    assert.equal(first.children[3].textContent, "L12.6");
    assert.equal(first.children[3].title, "цель: Gamma low");
    setEntries([row("C", 13.2)], "append");
    assert.deepEqual(names(), ["A", "B", "C"]);
    setEntries([row("D", 13)], "replace");
    assert.deepEqual(names(), ["D"]);
    // rows without a path are skipped, a rate out of range is clamped
    setEntries([null, { name: "no path" }, { ...row("E", 13), rate: 5 }], "append");
    assert.deepEqual(names(), ["D", "E"]);
    assert.equal($("mar-list").children[1].children[2].value, "2");
    off();
    setEntries([], "replace");
    assert.deepEqual(counts, [2, 3, 1, 2]);
    assert.equal($("mar-mode").hidden, true);
});

test("the curve redraws when a row moves and when the pause changes, with its warnings", () => {
    setEntries([row("Easy", 12.5, 60000), row("Hard", 13, 120000)], "replace");
    assert.equal($("mar-curve-box").hidden, false);
    assert.equal($("mar-mode").hidden, false);
    const before = svg();
    assert.match(before, /^<svg /);
    assert.equal(textOf($("mar-curve")), "Всего 3:10 · 2 карты · L12.5 → L13");
    // "↑" on the second row
    fire($("mar-list").children[1].children[4]);
    assert.deepEqual(names(), ["Hard", "Easy"]);
    assert.notEqual(svg(), before);
    assert.equal(textOf($("mar-curve")), "Всего 3:10 · 2 карты · L13 → L12.5 | Карта 2 легче предыдущей (−0.5)");
    $("mar-gap").value = "30";
    fire($("mar-gap"), "input");
    assert.equal(textOf($("mar-curve")).split(" | ")[0], "Всего 3:30 · 2 карты · L13 → L12.5");
    $("mar-gap").value = "10";
    fire($("mar-gap"), "input");
});

test("a template picked by hand sets the pause, OD/HP, patterns, title and its plan on the curve", async () => {
    setEntries([row("A", 14.5), row("B", 14.7), row("C", 14.8), row("D", 15)], "replace");
    assert.ok(!svg().includes("stroke-dasharray"));
    $("mar-tpl").value = "warmup";
    await fire($("mar-tpl"), "change");
    assert.equal($("mar-gap").value, "20");
    assert.deepEqual(selected($("mar-patterns")), ["Стрим", "Джампстрим"]);
    $("mar-tpl").value = "dan";
    await fire($("mar-tpl"), "change");
    assert.deepEqual([$("mar-gap").value, $("mar-od").value, $("mar-hp").value], ["10", "8", "8"]);
    assert.deepEqual(selected($("mar-patterns")), ["Джампстрим", "Чордджек"]);
    assert.equal($("mar-title").value, "Epsilon Dan Course");
    assert.ok(svg().includes("stroke-dasharray") && svg().includes("план шаблона"));
    assert.equal(JSON.parse(storage.get("marathon.auto.v1")).templateId, "dan");
    // another final dan: the plan and the template's own title follow
    $("mar-level").value = "13";
    await fire($("mar-level"), "change");
    assert.equal($("mar-title").value, "Gamma Dan Course");
    // a title typed by hand stays
    $("mar-title").value = "Мой курс";
    $("mar-level").value = "14";
    await fire($("mar-level"), "change");
    assert.equal($("mar-title").value, "Мой курс");
    $("mar-level").value = "13";
    await fire($("mar-level"), "change");
    // the plan goes to "Create marathon" too
    await fire($("mar-create"));
    assert.deepEqual(created.at(-1).plan, [12.55, 12.7, 12.85, 13]);
    // custom: count and step show up
    $("mar-tpl").value = "custom";
    await fire($("mar-tpl"), "change");
    assert.equal($("mar-custom").hidden, false);
    $("mar-tpl").value = "dan";
    await fire($("mar-tpl"), "change");
});

test("Pick maps: what is asked, progress lines, the rows, the summary and the warnings", async () => {
    setEntries([], "replace");
    const entry = (name, numeric) => ({ ...row(name, numeric), targetDan: numeric, from: "download" });
    autoReply = async () => {
        progress({ i: 1, n: 4, phase: "search", patternId: "jumpstream", target: 12.55 });
        assert.equal($("mar-auto-status").textContent, "Карта 1/4: ищем Джампстрим ≈ Gamma low…");
        assert.equal($("mar-pick").disabled, true);
        assert.equal($("mar-stop").hidden, false);
        progress({ i: 1, n: 4, phase: "download", name: "X", received: 5, total: 10 });
        assert.equal($("mar-auto-status").textContent, "Карта 1/4: …скачиваем X — 50%");
        return {
            ok: true, entries: [entry("P1", 12.55), entry("P2", 12.7)], plan: [12.55, 12.7, 12.85, 13], finalDan: 13,
            warnings: [{ kind: "short", i: 3, label: "Gamma low", rate: 1.45 }, { kind: "miss", i: 4, reason: "нет карт" }],
        };
    };
    await fire($("mar-pick"));
    assert.deepEqual(autoCalls.at(-1), {
        templateId: "dan", count: 4, step: 0.2, source: "manual", manualDan: 13, patternIds: ["jumpstream", "chordjack"], skipPlayed: false, rankedOnly: true,
    });
    assert.deepEqual(names(), ["P1", "P2"]);
    assert.equal($("mar-auto-status").textContent, "Готово: 2 карты подобрано — проверь и жми «Создать марафон».");
    assert.equal(textOf($("mar-auto-result")), "Карта 3: даже на 1.45x только Gamma low | Карта 4: подходящей не нашлось (нет карт)");
    assert.equal($("mar-pick").disabled, false);
    assert.equal($("mar-stop").hidden, true);
    // a list that is not empty: the saved choice was "append"
    await fire($("mar-pick"));
    assert.deepEqual(names(), ["P1", "P2", "P1", "P2"]);
    $("mar-mode-replace").checked = true;
    await fire($("mar-mode-replace"), "change");
    await fire($("mar-pick"));
    assert.deepEqual(names(), ["P1", "P2"]);
    // a pick that found nothing leaves the list alone
    autoReply = async () => ({ ok: true, entries: [], warnings: [{ kind: "miss", i: 1, reason: "x" }] });
    await fire($("mar-pick"));
    assert.deepEqual(names(), ["P1", "P2"]);
    assert.equal($("mar-auto-status").textContent, "Готово: 0 карт подобрано — проверь и жми «Создать марафон».");
});

test("Stop reaches main; a stopped pick keeps what it found; a failed one says why", async () => {
    let finish;
    autoReply = () => new Promise((resolve) => { finish = resolve; });
    const running = fire($("mar-pick"));
    await ticks();
    await fire($("mar-stop"));
    assert.equal(cancels, 1);
    assert.equal($("mar-auto-status").textContent, "Останавливаем…");
    finish({ ok: true, entries: [row("S1", 13)], warnings: [], cancelled: true });
    await running;
    assert.equal($("mar-auto-status").textContent, "Остановлено: 1 карта подобрано.");
    assert.deepEqual(names(), ["S1"]);
    // stop with nothing running asks nothing
    await fire($("mar-stop"));
    assert.equal(cancels, 1);
    autoReply = async () => ({ ok: false, message: "tracker down" });
    await fire($("mar-pick"));
    assert.equal($("mar-auto-status").textContent, "Не вышло: tracker down");
    assert.deepEqual(names(), ["S1"]);
});

test("from the profile: loaded when the tab is first shown, its tile's dan, played maps can be skipped", async () => {
    window.dispatchEvent({ type: "tab-shown", detail: "marathon" });
    await ticks();
    assert.equal(ensures, 1);
    assert.equal($("mar-profile").textContent, "Профиль: Мира, Stamina: Delta mid/high");
    assert.equal($("mar-skip-played").disabled, false);
    window.dispatchEvent({ type: "tab-shown", detail: "marathon" });
    window.dispatchEvent({ type: "tab-shown", detail: "rate" });
    await ticks();
    assert.equal(ensures, 1);
    $("mar-src-profile").checked = true;
    await fire($("mar-src-profile"), "change");
    assert.equal($("mar-manual").hidden, true);
    $("mar-skip-played").checked = true;
    await fire($("mar-skip-played"), "change");
    autoReply = async () => ({ ok: true, entries: [], warnings: [] });
    await fire($("mar-pick"));
    assert.equal(autoCalls.at(-1).source, "profile");
    assert.equal(autoCalls.at(-1).manualDan, null);
    assert.equal(autoCalls.at(-1).skipPlayed, true);
    // the plan follows the profile's dan for the first pattern: stamina 14.2
    setEntries([row("A", 13.8), row("B", 14)], "replace");
    assert.ok(svg().includes("stroke-dasharray"));
});

test("progress and warning lines in English", async () => {
    const { setLang } = await import("../src/i18n/i18n.js");
    setLang("en");
    try {
        assert.equal(progressText({ i: 2, n: 5, phase: "search", patternId: "chordjack", target: 13 }), "Map 2/5: looking for Chordjack ≈ Gamma mid…");
        assert.equal(progressText({ i: 2, n: 5, phase: "songs", name: "S" }), "Map 2/5: …found in Songs — S");
        assert.equal(progressText({ i: 2, n: 5, phase: "download", name: "S", received: 0, total: null }), "Map 2/5: …downloading S");
        assert.equal(progressText({ i: 2, n: 5, phase: "analyze", name: "S" }), "Map 2/5: …fitting the rate");
        assert.equal(progressText({ i: 5, n: 5, phase: "done" }), "");
        assert.equal(warningText({ kind: "short", i: 1, label: "Gamma low", rate: 1.45 }), "Map 1: only Gamma low even at 1.45x");
        assert.equal(warningText({ kind: "over", i: 1, label: "Delta mid", rate: 0.8 }), "Map 1: already Delta mid even at 0.8x");
        assert.equal(warningText({ kind: "miss", i: 2, reason: "no maps" }), "Map 2: nothing fitting found (no maps)");
    } finally {
        setLang("ru");
    }
});
