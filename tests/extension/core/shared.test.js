// The frozen shared modules of DESIGN §5.1: protocol names, the rate ladder, the language helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { ERR, MSG, OFFSCREEN_TARGET, PLAYER_SOURCE, PORT_FETCH, PRIORITY, SITE_ORIGIN } from "../../../extension/shared/protocol.js";
import { MAX_RATE, MIN_RATE, RATES, formatRate, rateKey } from "../../../extension/shared/rates.js";
import { LANGS, langForLocale, makeT, plural, siteLang } from "../../../extension/shared/lang.js";
import { langForLocale as appLangForLocale } from "../../../src/i18n/i18n.js";

test("protocol: names and error codes, frozen", () => {
    assert.deepEqual({ ...MSG }, { ANALYZE: "lm:analyze", OSU: "lm:osu", INFO: "lm:info", CACHE_CLEAR: "lm:cache-clear" });
    assert.equal(PORT_FETCH, "lm:fetch");
    assert.equal(OFFSCREEN_TARGET, "lm-offscreen");
    assert.equal(PLAYER_SOURCE, "lunacy-mania-player");
    assert.equal(SITE_ORIGIN, "https://osu.ppy.sh");
    assert.deepEqual({ ...PRIORITY }, { HIGH: "high", NORMAL: "normal", LOW: "low" });
    assert.deepEqual(Object.values(ERR).sort(), ["analysis", "bad-request", "cancelled", "context", "disabled", "host", "http",
        "limit", "login", "network", "not-found", "not-zip", "permission", "rate-limited", "timeout", "too-big"]);
    assert.ok(Object.isFrozen(MSG) && Object.isFrozen(ERR) && Object.isFrozen(PRIORITY));
});

test("rates: 0.8 … 1.5 by 0.05, keys and words", () => {
    assert.equal(RATES.length, 15);
    assert.equal(RATES[0], 0.8);
    assert.equal(RATES.at(-1), 1.5);
    assert.ok(RATES.includes(1) && RATES.includes(1.2) && RATES.includes(0.85));
    assert.equal(MIN_RATE, 0.5);
    assert.equal(MAX_RATE, 2);
    assert.equal(rateKey(1.2000000001), 1.2);
    assert.equal(rateKey("1.15"), 1.15);
    assert.equal(formatRate(1), "1.0");
    assert.equal(formatRate(0.85), "0.85");
    assert.equal(formatRate(1.5), "1.5");
    assert.equal(formatRate(1.2), "1.2");
    assert.deepEqual(RATES.map(formatRate).slice(0, 4), ["0.8", "0.85", "0.9", "0.95"]);
});

test("lang: ru for ru/uk/be/kk like the app, <html lang> first, makeT, plural", () => {
    assert.deepEqual([...LANGS], ["ru", "en"]);
    for (const l of ["ru", "ru-RU", "uk", "be", "kk-KZ", "en", "en-US", "de", "", null, "russian"]) {
        assert.equal(langForLocale(l), appLangForLocale(l), String(l));
    }
    const doc = (lang) => ({ documentElement: { getAttribute: () => lang } });
    assert.equal(siteLang(doc("ru"), { language: "en-US" }), "ru");
    assert.equal(siteLang(doc(null), { language: "uk-UA" }), "ru");
    assert.equal(siteLang(doc("en"), { language: "ru" }), "en");
    assert.equal(siteLang({}, {}), "en");
    const t = makeT({ hi: { ru: "Привет, {name}", en: "Hi, {name}" }, n: { ru: (p) => `${p.n} шт.`, en: "{n} pcs" }, only: { en: "only en" } }, "ru");
    assert.equal(t("hi", { name: "Мир" }), "Привет, Мир");
    assert.equal(t("hi"), "Привет, {name}");
    assert.equal(t("n", { n: 3 }), "3 шт.");
    assert.equal(t("only"), "only en");
    assert.equal(t("missing.key"), "missing.key");
    const words = { ru: ["карта", "карты", "карт"], en: ["map", "maps"] };
    assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 111].map((n) => plural(n, words, "ru")), ["карта", "карты", "карт", "карт", "карта", "карты", "карт", "карт"]);
    assert.deepEqual([0, 1, 2].map((n) => plural(n, words, "en")), ["maps", "map", "maps"]);
});
