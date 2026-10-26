import test from "node:test";
import assert from "node:assert/strict";
import { t, setLang, getLang, plural, langForLocale, allKeys, LANGS } from "../src/i18n/i18n.js";
import { AREAS } from "../src/i18n/messages/index.js";

test("starts in Russian; unknown languages fall back to Russian", () => {
    assert.equal(getLang(), "ru");
    assert.equal(setLang("en"), "en");
    assert.equal(setLang("de"), "ru");
    assert.equal(setLang(undefined), "ru");
});

test("new installs follow the system locale", () => {
    assert.deepEqual(["ru", "ru-RU", "uk-UA", "en-US", "de", "", null].map(langForLocale), ["ru", "ru", "ru", "en", "en", "en", "en"]);
});

test("an unknown key shows itself", () => {
    assert.equal(t("no.such.key"), "no.such.key");
});

test("plural forms in both languages", () => {
    const forms = { ru: ["карта", "карты", "карт"], en: ["map", "maps"] };
    setLang("ru");
    assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 112].map((n) => plural(n, forms)), ["карта", "карты", "карт", "карт", "карта", "карты", "карт", "карт"]);
    setLang("en");
    assert.deepEqual([0, 1, 2, 21].map((n) => plural(n, forms)), ["maps", "map", "maps", "maps"]);
    setLang("ru");
});

test("every text exists once and in both languages, with the same {slots}", () => {
    const seen = new Map();
    for (const [area, messages] of Object.entries(AREAS)) {
        for (const [key, entry] of Object.entries(messages)) {
            assert.ok(!seen.has(key), `${key} is defined in ${seen.get(key)} and ${area}`);
            seen.set(key, area);
            for (const lang of LANGS) {
                assert.ok(typeof entry[lang] === "string" || typeof entry[lang] === "function", `${key} has no ${lang}`);
            }
            if (typeof entry.ru === "string" && typeof entry.en === "string") {
                const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
                assert.deepEqual(slots(entry.en), slots(entry.ru), `${key}: different {slots}`);
            }
            if (typeof entry.en === "string") assert.ok(!/[А-Яа-яЁё]/.test(entry.en), `${key}: Cyrillic in English text`);
        }
    }
    assert.equal(allKeys().length, seen.size);
});
