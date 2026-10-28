import { test } from "node:test";
import assert from "node:assert/strict";
import { createPanel, stateOf, patternLabel, patternShares, formatDuration } from "../../../extension/content/panel.js";
import { makeStrings } from "../../../extension/content/strings.js";
import { RATES, rateKey } from "../../../extension/shared/rates.js";
import { makeDocument } from "./helpers/dom.js";
import { okResult, meta } from "./helpers/fixture.js";

const DIFFS = [
    { id: 11, version: "[4K] Easy", stars: 3.1, checksum: null },
    { id: 12, version: "[4K] LN", stars: 4, checksum: null },
    { id: 13, version: "[4K] Short", stars: 4.5, checksum: null },
    { id: 14, version: "[4K] Broken", stars: 5, checksum: null },
    { id: 15, version: "[4K] Wait", stars: 6, checksum: null },
];
const ok = (id, result) => ({ ok: true, beatmapId: id, rate: result.rate ?? 1, cached: false, meta: meta(id), result, analyzer: { fingerprint: "f", appVersion: "0.10.3" } });

function results() {
    return new Map([
        [11, ok(11, okResult(12.6, { label: "Gamma low", confidence: "высокая" }))],
        [12, ok(12, { kind: "not-rice", reason: "ln", keys: 4 })],
        [13, ok(13, { kind: "too-short" })],
        [14, { ok: false, beatmapId: 14, rate: 1, error: { code: "network", message: "Failed to fetch" } }],
    ]);
}

function make(lang = "ru") {
    const doc = makeDocument("<div></div>");
    const actions = [];
    const panel = createPanel({ doc, t: makeStrings(lang), lang, onAction: (a) => actions.push(a) });
    doc.body.append(panel.host);
    return { doc, panel, actions, $: (s) => panel.root.querySelector(s), $$: (s) => panel.root.querySelectorAll(s) };
}

const vm = (extra = {}) => ({
    setId: 77, diffs: DIFFS, selectedId: 11, results: results(), ratesOpen: false, rates: new Map(), demoRate: 1,
    preview: { disabled: false, warn: false }, full: { disabled: false, login: null }, appVersion: "0.10.3", ...extra,
});

test("small helpers", () => {
    assert.equal(stateOf(undefined), "pending");
    assert.equal(stateOf({ ok: false }), "error");
    assert.equal(stateOf({ ok: true, result: { kind: "error", message: "x" } }), "error");
    assert.equal(patternLabel("Rolls"), "Stream");
    assert.equal(patternLabel("Chordjacks"), "Chordjacks");
    assert.equal(patternLabel("Something new"), "Something new");
    assert.deepEqual(patternShares([{ name: "Jumpstream", share: 0.4 }, { name: "Rolls", share: 0.35 }, { name: "Trills", share: 0.25 }]).map((p) => [p.name, Math.round(p.share * 100)]), [["Stream", 60], ["Jumpstream", 40]]);
    assert.equal(formatDuration(125), "2:05");
});

test("host: open shadow root, set id, loading until every chip is final", () => {
    const { panel, $$ } = make();
    assert.equal(panel.host.getAttribute("data-lm-root"), "");
    assert.equal(panel.host.shadowRoot.mode, "open");
    panel.render(vm());
    assert.equal(panel.host.getAttribute("data-set-id"), "77");
    assert.equal(panel.host.getAttribute("data-lm-state"), "loading", "15 is still pending");
    const all = results();
    all.set(15, ok(15, okResult(20)));
    panel.render(vm({ results: all }));
    assert.equal(panel.host.getAttribute("data-lm-state"), "ready");
    assert.equal($$("style").length, 1);
});

test("chips: one per diff in order, state per result kind, numeric, aria-current", () => {
    const { panel, $$ } = make();
    panel.render(vm());
    const chips = $$("[data-lm-chip]");
    assert.deepEqual(chips.map((c) => c.getAttribute("data-beatmap-id")), ["11", "12", "13", "14", "15"]);
    assert.deepEqual(chips.map((c) => c.getAttribute("data-state")), ["ok", "not-rice", "too-short", "error", "pending"]);
    assert.equal(chips[0].getAttribute("data-numeric"), "12.6");
    assert.equal(chips[0].getAttribute("data-label"), "Gamma low");
    assert.equal(chips[1].getAttribute("data-numeric"), null);
    assert.equal(chips[0].getAttribute("aria-current"), "true");
    assert.equal(chips.filter((c) => c.hasAttribute("aria-current")).length, 1);
    assert.match(chips[0].textContent, /Gamma low12\.6/);
    assert.match(chips[0].textContent, /\[4K\] Easy/);
    assert.equal(chips[0].getAttribute("title"), "[4K] Easy — уверенность высокая · разброс ±0.4");
    assert.match(chips[1].textContent, /LN$/);
    assert.match(chips[2].textContent, /коротко$/);
    assert.match(chips[3].textContent, /ошибка$/);
    assert.match(chips[4].textContent, /считаем…$/);
});

test("card per result kind, in the app's words", () => {
    const { panel, $ } = make();
    panel.render(vm());
    let card = $("[data-lm-card]");
    assert.equal(card.getAttribute("data-beatmap-id"), "11");
    assert.match(card.textContent, /Gamma low12\.6/);
    assert.match(card.textContent, /уверенность высокая · разброс ±0\.4/);
    assert.match(card.textContent, /MSD 25\.50 · Sunny ★7\.11/);
    assert.match(card.textContent, /Stream/);
    assert.match(card.textContent, /Jumpstream50%/);
    assert.match(card.textContent, /180 BPM/);
    assert.match(card.textContent, /2:05/);
    assert.match(card.textContent, /Companella 12\.2/);

    const words = { 12: "LN-карта — не считаем", 13: "Слишком короткая карта", 14: "Ошибка: нет связи с osu!", 15: "считаем…" };
    for (const [id, text] of Object.entries(words)) {
        panel.render(vm({ selectedId: Number(id) }));
        card = $("[data-lm-card]");
        assert.equal(card.getAttribute("data-beatmap-id"), id);
        assert.match(card.textContent, new RegExp(text), id);
    }
    // the error card offers a retry
    panel.render(vm({ selectedId: 14 }));
    assert.ok($('[data-lm-action="retry"][data-beatmap-id="14"]'));

    const keys = results();
    keys.set(12, ok(12, { kind: "not-rice", reason: "keys", keys: 7 }));
    panel.render(vm({ selectedId: 12, results: keys }));
    assert.match($("[data-lm-card]").textContent, /Не 4K \(7k\)/);
    keys.set(12, ok(12, { kind: "error", message: "нет калькулятора" }));
    panel.render(vm({ selectedId: 12, results: keys }));
    assert.match($("[data-lm-card]").textContent, /Ошибка: нет калькулятора/);
    keys.set(12, { ok: false, error: { code: "context" } });
    panel.render(vm({ selectedId: 12, results: keys }));
    assert.match($("[data-lm-card]").textContent, /обнови страницу/);
});

test("English words", () => {
    const { panel, $ } = make("en");
    panel.render(vm({ selectedId: 12 }));
    assert.match($("[data-lm-card]").textContent, /LN map — not rated/);
    assert.match(panel.root.textContent, /Play demo \(10 s\)/);
    assert.match(panel.root.textContent, /Lunacy mania 0\.10\.3/);
});

test("rates: toggle, 15 rows with state, numeric, delta and «● сейчас»", () => {
    const { panel, $, $$ } = make();
    panel.render(vm());
    const toggle = $("[data-lm-rates-toggle]");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.match(toggle.textContent, /Дан на рейтах ▸/);
    assert.equal($$("[data-lm-rate-row]").length, 0);

    const rates = new Map([[rateKey(1.2), ok(11, okResult(14.7, { label: "Epsilon low", rate: 1.2 }))], [rateKey(0.8), { ok: false, error: { code: "timeout" } }]]);
    panel.render(vm({ ratesOpen: true, rates, demoRate: 1.2 }));
    assert.match($("[data-lm-rates-toggle]").textContent, /▾/);
    const rows = $$("[data-lm-rate-row]");
    assert.equal(rows.length, RATES.length);
    assert.equal(rows.length, 15);
    const byRate = Object.fromEntries(rows.map((r) => [r.getAttribute("data-rate"), r]));
    assert.deepEqual(Object.keys(byRate), ["0.8", "0.85", "0.9", "0.95", "1.0", "1.05", "1.1", "1.15", "1.2", "1.25", "1.3", "1.35", "1.4", "1.45", "1.5"]);
    assert.equal(byRate["1.2"].getAttribute("data-state"), "ok");
    assert.equal(byRate["1.2"].getAttribute("data-numeric"), "14.7");
    assert.match(byRate["1.2"].textContent, /1\.2×Epsilon low14\.7\+2\.1● сейчас/);
    assert.equal(byRate["1.0"].getAttribute("data-numeric"), "12.6", "1.0× is the card's own answer");
    assert.equal(byRate["1.0"].hasAttribute("data-current"), false);
    assert.equal(byRate["0.8"].getAttribute("data-state"), "error");
    assert.equal(byRate["1.5"].getAttribute("data-state"), "pending");
    assert.match(byRate["1.5"].textContent, /считаем…/);

    // not rice → no rows, a note
    panel.render(vm({ ratesOpen: true, selectedId: 12 }));
    assert.equal($$("[data-lm-rate-row]").length, 0);
    assert.match(panel.root.textContent, /дан на рейтах не считаем/);
});

test("buttons: hooks, notes, disabled states", () => {
    const { panel, $ } = make();
    panel.render(vm());
    const preview = $('[data-lm-action="play-preview"]');
    const full = $('[data-lm-action="play-full"]');
    const file = $('[data-lm-action="play-file"]');
    assert.match(preview.textContent, /Сыграть демо \(10 с\)/);
    assert.match(preview.textContent, /рейт 1\.0×/);
    assert.match(full.textContent, /Полная карта/);
    assert.match(full.textContent, /нужен вход, считается в лимит загрузок/);
    assert.match(file.textContent, /Свой \.osz/);
    assert.equal(preview.hasAttribute("disabled"), false);

    panel.render(vm({ preview: { disabled: true, warn: true }, full: { disabled: true, login: false } }));
    assert.equal($('[data-lm-action="play-preview"]').hasAttribute("disabled"), true);
    assert.match($('[data-lm-action="play-preview"]').textContent, /нет точки превью/);
    assert.equal($('[data-lm-action="play-full"]').hasAttribute("disabled"), true);
    assert.match($('[data-lm-action="play-full"]').textContent, /не даёт скачать/);
    assert.equal($('[data-lm-action="play-file"]').hasAttribute("disabled"), false);

    panel.render(vm({ preview: { disabled: false, warn: true }, full: { disabled: false, login: false } }));
    assert.match($('[data-lm-action="play-preview"]').textContent, /превью общее для набора/);
    assert.match($('[data-lm-action="play-full"]').textContent, /ты не вошёл на osu\.ppy\.sh/);
    assert.match(panel.root.textContent, /Lunacy mania 0\.10\.3/);
    assert.doesNotMatch(panel.root.textContent, /official|официальн/i);
});

test("clicks become actions; disabled buttons do nothing", () => {
    const { panel, $, actions } = make();
    panel.render(vm({ ratesOpen: true, preview: { disabled: true } }));
    $('[data-lm-chip][data-beatmap-id="13"] .ver').click();
    $("[data-lm-rates-toggle]").click();
    $('[data-lm-rate-row][data-rate="1.15"] .r').click();
    $('[data-lm-action="play-full"] .note').click();
    $('[data-lm-action="play-file"]').click();
    $('[data-lm-action="play-preview"]').click();
    assert.deepEqual(actions, [
        { type: "select", id: 13 }, { type: "toggle-rates" }, { type: "rate", rate: 1.15 },
        { type: "play-full", id: 11 }, { type: "play-file", id: 11 },
    ]);
    panel.render(vm({ selectedId: 14 }));
    $('[data-lm-action="retry"]').click();
    assert.deepEqual(actions.at(-1), { type: "retry", id: 14 });
});

test("data goes in as text, never as markup", () => {
    const { panel, $, $$ } = make();
    const evil = '<img src=x onerror="alert(1)">';
    const all = results();
    all.set(11, ok(11, okResult(10, { label: evil, primary: evil })));
    panel.render(vm({ diffs: [{ ...DIFFS[0], version: evil }, ...DIFFS.slice(1)], results: all }));
    assert.equal($$("img").length, 0);
    assert.ok($("[data-lm-chip]").textContent.includes(evil));
    assert.equal($("[data-lm-chip]").getAttribute("data-label"), evil);
});

test("focus survives a re-render", () => {
    const { panel, $ } = make();
    panel.render(vm());
    $('[data-lm-chip][data-beatmap-id="13"]').focus();
    panel.render(vm({ selectedId: 13 }));
    assert.equal(panel.root.activeElement, $('[data-lm-chip][data-beatmap-id="13"]'));
});

test("destroy removes the host", () => {
    const { panel, doc } = make();
    panel.render(vm());
    panel.destroy();
    assert.equal(doc.querySelector("[data-lm-root]"), null);
});
