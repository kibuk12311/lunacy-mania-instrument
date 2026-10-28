import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STRINGS, ERROR_CODES, errorKey } from "../../../extension/player/strings.js";
import { ERR } from "../../../extension/shared/protocol.js";
import { makeT } from "../../../extension/shared/lang.js";
import { FILE_FALLBACK } from "../../../extension/player/source.js";

const dir = fileURLToPath(new URL("../../../extension/player/", import.meta.url));
const sample = { n: 3, ms: -12, rate: "1.2", od: 8, keys: "D F J K", sec: 10, name: "song.mp3", status: "503", got: "1.0 MB", total: "2.0", artist: "A", title: "T", version: "V" };

test("every text has ru and en, both non-empty", () => {
    for (const [key, entry] of Object.entries(STRINGS)) {
        for (const lang of ["ru", "en"]) {
            const v = entry[lang];
            assert.ok(v !== undefined, `${key} has no ${lang}`);
            const text = typeof v === "function" ? v(sample) : v;
            assert.equal(typeof text, "string", `${key}.${lang}`);
            assert.ok(text.trim().length > 0, `${key}.${lang} is empty`);
        }
        assert.deepEqual(Object.keys(entry).sort(), ["en", "ru"], key);
    }
});

test("every error code the player can show has a text; every ERR is covered", () => {
    for (const code of ERROR_CODES) assert.ok(STRINGS[`err.${code}`], code);
    for (const code of Object.values(ERR)) assert.ok(ERROR_CODES.includes(code), code);
    for (const code of FILE_FALLBACK) assert.ok(ERROR_CODES.includes(code), code);
    assert.equal(errorKey("login"), "err.login");
    assert.equal(errorKey("whatever"), "err.unknown");
});

test("the texts the brief fixes", () => {
    const ru = makeT(STRINGS, "ru");
    assert.equal(ru("err.login"), "Войди на osu.ppy.sh в этом браузере — или перетащи .osz сюда");
    assert.equal(ru("previewWarn"), "Превью общее для набора — может не совпасть с этой сложностью.");
    assert.equal(ru("full.download"), "Скачать с osu!");
    assert.match(ru("full.text"), /лимит загрузок/);
    assert.match(makeT(STRINGS, "en")("full.text"), /download limit/);
    assert.match(ru("err.limit"), /лимит загрузок/i);
    assert.match(ru("settings.ratePitch"), /высоту звука/);
    assert.equal(ru("ready.notes", { n: 1 }), "1 нота");
    assert.equal(ru("ready.notes", { n: 3 }), "3 ноты");
    assert.equal(ru("ready.notes", { n: 11 }), "11 нот");
    assert.equal(makeT(STRINGS, "en")("ready.notes", { n: 1 }), "1 note");
    assert.equal(ru("toast.offset", { ms: 5 }), "Оффсет +5 мс");
    assert.equal(ru("toast.offset", { ms: -5 }), "Оффсет −5 мс");
    // never claims to be osu!
    for (const entry of Object.values(STRINGS)) for (const v of [entry.ru, entry.en]) {
        const text = typeof v === "function" ? v(sample) : v;
        assert.doesNotMatch(text, /official|официальн/i);
    }
});

test("every t(\"key\") in the player's code exists", () => {
    const used = new Set();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
        const src = readFileSync(dir + file, "utf8");
        for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
        for (const m of src.matchAll(/\bt\(`rebind\.\$\{[^}]+\}`/g)) used.add("rebind.refused").add("rebind.duplicate") && m;
    }
    assert.ok(used.size > 40, `found ${used.size}`);
    for (const key of used) assert.ok(STRINGS[key], `missing text ${key}`);
});
