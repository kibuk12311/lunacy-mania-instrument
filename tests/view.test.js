import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderView, formatDuration, CALCS } from "../app/renderer/view.js";
import { setLang, t as tr, allKeys } from "../src/i18n/i18n.js";

const OK = {
    kind: "ok", label: "Gamma low/mid", numeric: 12.8, halfWidth: 0.34, confidence: "высокая",
    primary: "Jumpstream", top3: [{ name: "Jumpstream", share: 0.46 }, { name: "Handstream", share: 0.22 }, { name: "Chordjacks", share: 0.15 }],
    tech: true, bpm: 199.6, durationSec: 161, rate: 1.5,
};

test("result card shows label, confidence, bars and chips", () => {
    const html = renderView({ screen: "result", result: OK }, {});
    for (const s of ["Gamma low/mid", "12.8", "уверенность высокая · разброс ±0.3", "Jumpstream", "46%", "22%", "15%", "Tech", "200 BPM", "2:41", "×1.5"]) {
        assert.ok(html.includes(s), s);
    }
});

test("the old compact flag changes nothing: the compact mode is gone (0.9.6)", () => {
    const html = renderView({ screen: "result", result: OK }, { compact: true });
    assert.equal(html, renderView({ screen: "result", result: OK }, {}));
    assert.ok(html.includes("уверенность"));
});

test("no Tech chip and no rate chip at 1x without tech", () => {
    const html = renderView({ screen: "result", result: { ...OK, tech: false, rate: 1 } }, {});
    assert.ok(!html.includes(">Tech<"));
    assert.ok(!html.includes("×"));
});

test("state texts", () => {
    const cases = [
        [{ screen: "waiting-osu" }, "Ждём osu! (stable или lazer)…"],
        [{ screen: "loading" }, "Считаем…"],
        [{ screen: "result", result: { kind: "not-rice", reason: "keys", keys: 7 } }, "Не 4K (7k)"],
        [{ screen: "result", result: { kind: "not-rice", reason: "ln", keys: 4 } }, "LN-карта — не считаем"],
        [{ screen: "result", result: { kind: "too-short" } }, "Слишком короткая карта"],
        [{ screen: "result", result: { kind: "error", message: "boom" } }, "Ошибка: boom"],
        [{ screen: "tosu-failed", reason: "порт занят" }, "Не удалось запустить tosu: порт занят"],
        [{ screen: "osu-updated" }, "osu! обновилась? Нужна новая версия приложения"],
    ];
    for (const [view, text] of cases) assert.ok(renderView(view, {}).includes(text), text);
});

test("html is escaped", () => {
    const html = renderView({ screen: "result", result: { kind: "error", message: "<b>x</b>" } }, {});
    assert.ok(!html.includes("<b>x</b>"));
});

test("formatDuration", () => {
    assert.equal(formatDuration(161), "2:41");
    assert.equal(formatDuration(59.6), "1:00");
    assert.equal(formatDuration(5), "0:05");
});

test("non-mania text", () => {
    const html = renderView({ screen: "result", result: { kind: "not-rice", reason: "mode", keys: 4 } }, {});
    assert.ok(html.includes("Не osu!mania"));
});

const FULL = {
    ...OK,
    calcs: { mixed: 13.2, daniel: 12.7, azusa: 13, roxy: null, companella: 11.6 },
    sunny: 6.34,
    msd: { overall: 26.2, stream: 24.11, jumpstream: 25.94, handstream: 16.98, stamina: 23.98, jackspeed: 17.14, chordjack: 18.02, technical: 25.27 },
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("CALCS lists ours first, the five dan calculators and the comparison", async () => {
    const { CALCS } = await import("../app/renderer/view.js");
    assert.deepEqual(CALCS.map((c) => c.id), ["ours", "mixed", "daniel", "azusa", "roxy", "companella", "all"]);
    assert.equal(CALCS[0].name, "Общий");
});

test("MSD and Sunny star line under our dan", () => {
    const t = text(renderView({ screen: "result", result: FULL }, {}));
    assert.ok(t.includes("MSD 26.20"), t);
    assert.ok(t.includes("Sunny ★6.34"), t);
    assert.ok(t.includes("Gamma low/mid 12.8"));
    assert.ok(t.includes("уверенность высокая"));
});

test("a chosen calculator replaces the big dan and keeps ours for comparison", () => {
    const t = text(renderView({ screen: "result", result: FULL }, { calc: "daniel" }));
    assert.ok(t.startsWith(" Gamma low 12.7 Daniel") || t.includes("Gamma low 12.7 Daniel"), t);
    assert.ok(t.includes("общий: Gamma low/mid 12.8"), t);
    assert.ok(!t.includes("уверенность"));
    assert.ok(t.includes("MSD 26.20") && t.includes("46%"));
});

test("a calculator with no estimate says so", () => {
    const t = text(renderView({ screen: "result", result: FULL }, { calc: "roxy" }));
    assert.ok(t.includes("— нет оценки Roxy"), t);
});

test("comparison lists every calculator and all MSD skillsets", () => {
    const html = renderView({ screen: "result", result: FULL }, { calc: "all" });
    const t = text(html);
    for (const s of ["Общий Gamma low/mid 12.8", "Mixed Gamma mid/high 13.2", "Daniel Gamma low 12.7", "Azusa Gamma mid 13.0",
        "Roxy — нет оценки", "Companella Beta low 11.6", "Stream 24.1", "JS 25.9", "HS 17.0", "Stamina 24.0",
        "JackSpeed 17.1", "CJ 18.0", "Tech 25.3", "Sunny ★6.34"]) assert.ok(t.includes(s), s);
    assert.ok(!t.includes("46%"), "no pattern bars in the comparison");
    assert.ok(t.includes("Jumpstream"));
});

test("old results without calculators still render, unknown choice falls back to ours", () => {
    const t = text(renderView({ screen: "result", result: OK }, { calc: "mixed" }));
    assert.ok(t.includes("— нет оценки Mixed"), t);
    assert.ok(!t.includes("MSD"));
    assert.ok(text(renderView({ screen: "result", result: FULL }, { calc: "nope" })).includes("уверенность высокая"));
});

// English interface
const inEnglish = (fn) => {
    setLang("en");
    try {
        fn();
    } finally {
        setLang("ru");
    }
};
const CYRILLIC = /[А-Яа-яЁё]/;

test("English: state texts", () => inEnglish(() => {
    const cases = [
        [{ screen: "waiting-osu" }, "Waiting for osu! (stable or lazer)…"],
        [{ screen: "loading" }, "Calculating…"],
        [{ screen: "result", result: { kind: "not-rice", reason: "mode", keys: 4 } }, "Not osu!mania"],
        [{ screen: "result", result: { kind: "not-rice", reason: "keys", keys: 7 } }, "Not 4K (7k)"],
        [{ screen: "result", result: { kind: "not-rice", reason: "ln", keys: 4 } }, "LN map — not rated"],
        [{ screen: "result", result: { kind: "too-short" } }, "Map is too short"],
        [{ screen: "result", result: { kind: "error", message: "boom" } }, "Error: boom"],
        [{ screen: "result", result: { kind: "error" } }, "Error: unknown"],
        [{ screen: "tosu-failed", reason: "port busy" }, "Couldn't start tosu: port busy"],
        [{ screen: "osu-updated" }, "Did osu! update? You need a new version of the app"],
    ];
    for (const [view, expected] of cases) {
        const html = renderView(view, {});
        assert.ok(html.includes(expected.replace("'", "&#39;")), `${expected}: ${html}`);
        assert.ok(!CYRILLIC.test(html), html);
    }
}));

test("English: result card, chosen calculator and comparison", () => inEnglish(() => {
    const result = FULL;
    const own = text(renderView({ screen: "result", result }, {}));
    assert.ok(own.includes("Gamma low/mid 12.8") && own.includes("confidence high · spread ±0.3"), own);
    const daniel = text(renderView({ screen: "result", result }, { calc: "daniel" }));
    assert.ok(daniel.includes("Gamma low 12.7 Daniel") && daniel.includes("overall: Gamma low/mid 12.8"), daniel);
    assert.ok(text(renderView({ screen: "result", result }, { calc: "roxy" })).includes("— no estimate Roxy"));
    const all = renderView({ screen: "result", result }, { calc: "all" });
    for (const s of ["Overall Gamma low/mid 12.8", "Roxy — no estimate", "Daniel Gamma low 12.7"]) assert.ok(text(all).includes(s), s);
    for (const html of [own, daniel, all]) assert.ok(!CYRILLIC.test(html), html);
}));

test("English: a result worded in Russian (cache, or analysed before the switch) reads in English", () => inEnglish(() => {
    const cached = { ...FULL, label: "ниже 1 дана", numeric: 0.3, confidence: "высокая", confidenceLevel: "high" };
    const own = text(renderView({ screen: "result", result: cached }, {}));
    assert.ok(own.includes("below dan 1 0.3") && own.includes("confidence high · spread ±0.3"), own);
    const daniel = text(renderView({ screen: "result", result: cached }, { calc: "daniel" }));
    assert.ok(daniel.includes("overall: below dan 1 0.3"), daniel);
    const all = text(renderView({ screen: "result", result: cached }, { calc: "all" }));
    assert.ok(all.includes("Overall below dan 1 0.3"), all);
    for (const html of [own, daniel, all]) assert.ok(!CYRILLIC.test(html), html);
}));

test("English: an old cached result without confidenceLevel is worded from its half width", () => inEnglish(() => {
    for (const [halfWidth, word] of [[0.34, "high"], [0.5, "medium"], [0.9, "low"]]) {
        const html = text(renderView({ screen: "result", result: { ...OK, halfWidth } }, {}));
        assert.ok(html.includes(`confidence ${word} · spread`), html);
    }
}));

test("a result worded in English reads in Russian again", () => {
    const cached = { ...FULL, label: "above Kappa", numeric: 20.6, confidence: "medium", confidenceLevel: "medium", halfWidth: 0.5 };
    const own = text(renderView({ screen: "result", result: cached }, {}));
    assert.ok(own.includes("выше Kappa 20.6") && own.includes("уверенность средняя · разброс ±0.5"), own);
    assert.ok(text(renderView({ screen: "result", result: cached }, { calc: "mixed" })).includes("общий: выше Kappa 20.6"));
});

test("calculator names follow the language", () => {
    assert.deepEqual([CALCS[0].name, CALCS.at(-1).name, CALCS[1].name], ["Общий", "Все", "Mixed"]);
    inEnglish(() => {
        assert.deepEqual([CALCS[0].name, CALCS.at(-1).name, CALCS[1].name], ["Overall", "All", "Mixed"]);
        assert.equal(CALCS[0].hint, "our analyzer — combines every calculator and pattern");
        assert.equal(CALCS[6].hint, "every calculator side by side");
        assert.equal(CALCS[2].hint, undefined);
    });
});

test("index.html: every marked key exists and its Russian text is the one in the markup", () => {
    const html = readFileSync(new URL("../app/renderer/index.html", import.meta.url), "utf8");
    const keys = new Set(allKeys());
    const used = [];
    for (const [, attrs, inner] of html.matchAll(/<[a-z]+\b([^>]*)>([^<]*)/gi)) {
        const attr = (name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
        const pairs = [["data-i18n", inner.trim()], ["data-i18n-title", attr("title")], ["data-i18n-placeholder", attr("placeholder")], ["data-i18n-value", null]];
        for (const [name, russian] of pairs) {
            const key = attr(name);
            if (!key) continue;
            used.push(key);
            // the shared markup's keys are html.*; a tab's own section uses <area>.html.* from its message file (tabs v2)
            assert.ok(/^(\w+\.)?html\./.test(key) && keys.has(key), `${name}="${key}" has no message`);
            if (russian !== null) assert.equal(tr(key), russian, key);
        }
    }
    // and no html.* text is left unused
    assert.deepEqual(used.filter((k) => k.startsWith("html.")).sort(), [...keys].filter((k) => k.startsWith("html.")).sort());
});

test("index.html texts have English", () => inEnglish(() => {
    assert.equal(tr("html.tab.recommend"), "Picks");
    assert.equal(tr("html.tab.create"), "Create");
    assert.equal(tr("html.tab.createTitle"), "Create a map");
    assert.equal(tr("html.mar.defaultTitle"), "My marathon");
    assert.equal(tr("html.rec.userPlaceholder"), "osu! name or id");
}));

test("a rate map's chip: its own rate, a tooltip saying where the ladder counts from, the mods' rate beside it", () => {
    const at = (rate, rateMap) => renderView({ screen: "result", result: { ...OK, rate }, rateMap }, {});
    const own = at(1.2, { rate: 1.2, virtual: false });
    assert.ok(own.includes('<span class="chip an-ratemap" title="Рейт-карта: оригинал на ×1.2 отдельным файлом. Дан — её собственный, а «Дан на рейтах» считается от оригинала.">рейт-карта ×1.2</span>'), own);
    assert.ok(!own.includes(">×1.2<"), "no second ×1.2 chip");
    const withDt = at(1.8, { rate: 1.2, virtual: true });
    assert.ok(withDt.includes('<span class="chip">×1.8</span><span class="chip an-ratemap"'), withDt);
    assert.ok(withDt.includes("он восстановлен из рейт-карты"));
    // DT past the ladder: the card is the file at the mods' rate, so that rate is a chip of its own
    assert.ok(at(1.5, { rate: 1.5, beyond: true }).includes('<span class="chip">×1.5</span><span class="chip an-ratemap"'));
    setLang("en");
    try {
        assert.ok(at(1.2, { rate: 1.2 }).includes(">rate map ×1.2</span>"));
    } finally {
        setLang("ru");
    }
    // a plain map at a rate: as before
    assert.ok(at(1.5, undefined).includes('<span class="chip">×1.5</span></div>'));
});
