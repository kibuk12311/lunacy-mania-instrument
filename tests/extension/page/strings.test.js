import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STRINGS, PLURALS, makeStrings, errorText, countText } from "../../../extension/content/strings.js";
import { ERR } from "../../../extension/shared/protocol.js";
import analysisMessages from "../../../src/i18n/messages/analysis.js";

test("every key has ru and en, non-empty, with the same {slots}", () => {
    const slots = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const [key, entry] of Object.entries(STRINGS)) {
        assert.ok(typeof entry.ru === "string" && entry.ru.trim(), `${key} ru`);
        assert.ok(typeof entry.en === "string" && entry.en.trim(), `${key} en`);
        assert.equal(slots(entry.ru), slots(entry.en), `${key} slots`);
    }
    for (const [name, forms] of Object.entries(PLURALS)) {
        assert.equal(forms.ru.length, 3, name);
        assert.equal(forms.en.length, 2, name);
    }
});

test("the app's own wording is copied as it is", () => {
    const same = {
        "card.confidence": "analysis.confidence", "card.ln": "analysis.ln", "card.notFourKey": "analysis.notFourKey",
        "card.notMania": "analysis.notMania", "card.tooShort": "analysis.tooShort", "card.error": "analysis.error",
        "card.errorUnknown": "analysis.errorUnknown", "rates.title": "analysis.ladder.title", "rates.now": "analysis.ladder.now",
        "rates.counting": "analysis.ladder.counting", "card.counting": "analysis.ladder.counting",
    };
    for (const [ours, app] of Object.entries(same)) assert.deepEqual(STRINGS[ours], analysisMessages[app], ours);
    assert.equal(STRINGS["card.confidence"].ru, "уверенность {confidence} · разброс ±{spread}");
    assert.equal(STRINGS["play.fullNote"].ru, "скачает .osz с osu! — нужен вход, считается в лимит загрузок");
});

test("every ERR code is worded in both languages", () => {
    const ru = makeStrings("ru");
    const en = makeStrings("en");
    for (const code of Object.values(ERR)) {
        assert.ok(STRINGS[`err.${code}`], code);
        assert.notEqual(errorText(ru, { code }), ru("card.errorUnknown"), code);
    }
    assert.equal(errorText(ru, { code: ERR.CONTEXT }), "расширение обновилось — обнови страницу");
    assert.equal(errorText(en, { code: ERR.HTTP, status: 502 }), "osu! answered with error 502");
    assert.equal(errorText(ru, { code: "nope" }), "неизвестная");
    assert.equal(errorText(en, null), "unknown");
});

test("counts are pluralized", () => {
    assert.equal(countText(makeStrings("ru"), 1, "ru"), "1 сложность");
    assert.equal(countText(makeStrings("ru"), 3, "ru"), "3 сложности");
    assert.equal(countText(makeStrings("ru"), 16, "ru"), "16 сложностей");
    assert.equal(countText(makeStrings("en"), 1, "en"), "1 difficulty");
    assert.equal(countText(makeStrings("en"), 4, "en"), "4 difficulties");
});

test("every t() key used by the page lane exists", () => {
    const dir = fileURLToPath(new URL("../../../extension/content/", import.meta.url));
    const used = new Set();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
        const src = readFileSync(dir + file, "utf8");
        for (const m of src.matchAll(/\bt\(\s*"([\w.-]+)"/g)) used.add(m[1]);
    }
    assert.ok(used.size > 20);
    for (const key of used) assert.ok(STRINGS[key], `missing ${key}`);
});

test("no osu! branding claims: never official, never made by osu!", () => {
    for (const [key, entry] of Object.entries(STRINGS)) {
        for (const text of [entry.ru, entry.en]) {
            assert.doesNotMatch(text, /official|официальн/i, key);
        }
    }
    assert.match(STRINGS["panel.footerHint"].en, /not made by osu!/);
});
