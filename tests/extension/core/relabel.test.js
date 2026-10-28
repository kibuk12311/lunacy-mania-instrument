// background/relabel.js in a built copy (it imports the analyzer's labels.js and i18n.js from lib/): an English
// result worded in Russian and back with the app's own words, below dan 1 and above Kappa, the confidence word, the
// "no calculator" error; anything else unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { confidenceWord, numericToLabel } from "../../../src/core/labels.js";
import { setLang, t } from "../../../src/i18n/i18n.js";
import { buildForTest } from "./buildHelper.js";

const app = (lang, fn) => {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};
const okResult = (numeric, level) => ({
    kind: "ok", label: app("en", () => numericToLabel(numeric).text), numeric, halfWidth: 0.3,
    confidence: app("en", () => confidenceWord(level)), confidenceLevel: level, primary: "Jumpstream", rate: 1,
});

test("relabel words a cached English result in the page's language like the app", async (t_) => {
    const built = await buildForTest(t_, { targets: ["chrome"] });
    const { relabel } = await import(pathToFileURL(path.join(built.targets.chrome, "background", "relabel.js")).href);

    for (const [numeric, level] of [[12.6, "high"], [0.3, "medium"], [21.3, "low"], [14, "high"]]) {
        const en = okResult(numeric, level);
        const ru = relabel(en, "ru");
        assert.equal(ru.label, app("ru", () => numericToLabel(numeric).text), `${numeric}`);
        assert.equal(ru.confidence, app("ru", () => confidenceWord(level)));
        assert.equal(ru.numeric, numeric);
        assert.equal(ru.primary, "Jumpstream");
        assert.deepEqual(relabel(ru, "en"), en, "back to English");
        assert.deepEqual(relabel(en, "de"), en, "an unknown language is English");
    }
    assert.equal(relabel(okResult(0.3, "low"), "ru").label, "ниже 1 дана");
    assert.equal(relabel(okResult(21.3, "low"), "ru").label, "выше Kappa · 21.3");
    assert.equal(relabel(okResult(12.6, "high"), "ru").label, "Gamma low");
    assert.equal(relabel(okResult(12.6, "high"), "ru").confidence, "высокая");

    const noCalc = { kind: "error", message: app("en", () => t("core.analyze.noCalculator")) };
    assert.equal(relabel(noCalc, "ru").message, app("ru", () => t("core.analyze.noCalculator")));
    assert.deepEqual(relabel({ kind: "error", message: "wasm exploded" }, "ru"), { kind: "error", message: "wasm exploded" });
    assert.deepEqual(relabel({ kind: "not-rice", reason: "ln", keys: 4 }, "ru"), { kind: "not-rice", reason: "ln", keys: 4 });
    assert.deepEqual(relabel({ kind: "too-short" }, "ru"), { kind: "too-short" });
    assert.equal(relabel(null, "ru"), null);
});
