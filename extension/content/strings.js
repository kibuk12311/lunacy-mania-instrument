// The panel's texts, ru and en (key → { ru, en }; {slot} values are filled by makeT of shared/lang.js). Where the app
// says the same thing, the words are the app's (src/i18n/messages/analysis.js), copied as they are.
import { makeT, plural } from "../shared/lang.js";

export const STRINGS = Object.freeze({
    // head and footer
    "panel.title": { ru: "Даны Lunacy mania", en: "Lunacy mania dans" },
    "panel.subtitle": { ru: "4K-сложности этого набора", en: "4K difficulties of this set" },
    "panel.count": { ru: "{n} {word}", en: "{n} {word}" },
    "panel.footer": { ru: "Lunacy mania {version}", en: "Lunacy mania {version}" },
    "panel.footerHint": { ru: "Расширение Lunacy mania, не от osu!", en: "A Lunacy mania extension, not made by osu!" },
    "panel.notFourK": { ru: "Выбрана не 4K-сложность — дан есть только у osu!mania 4K, выбери её выше", en: "The selected difficulty isn't 4K — only osu!mania 4K ones get a dan; pick one above" },
    "panel.aria": { ru: "Даны Lunacy mania для 4K-сложностей", en: "Lunacy mania dans for the 4K difficulties" },

    // the app's own card wording (analysis.*)
    "card.confidence": { ru: "уверенность {confidence} · разброс ±{spread}", en: "confidence {confidence} · spread ±{spread}" },
    "card.ln": { ru: "LN-карта — не считаем", en: "LN map — not rated" },
    "card.notFourKey": { ru: "Не 4K ({keys}k)", en: "Not 4K ({keys}k)" },
    "card.notMania": { ru: "Не osu!mania", en: "Not osu!mania" },
    "card.tooShort": { ru: "Слишком короткая карта", en: "Map is too short" },
    "card.error": { ru: "Ошибка: {message}", en: "Error: {message}" },
    "card.errorUnknown": { ru: "неизвестная", en: "unknown" },
    "card.counting": { ru: "считаем…", en: "counting…" },
    "card.pattern": { ru: "Главный паттерн", en: "Main pattern" },
    "card.retry": { ru: "Ещё раз", en: "Try again" },
    "card.stars": { ru: "★{stars} на osu!", en: "★{stars} on osu!" },
    "card.calcs": { ru: "Калькуляторы", en: "Calculators" },

    // short chip texts
    "chip.counting": { ru: "считаем…", en: "counting…" },
    "chip.ln": { ru: "LN", en: "LN" },
    "chip.keys": { ru: "{keys}K", en: "{keys}K" },
    "chip.notMania": { ru: "не mania", en: "not mania" },
    "chip.tooShort": { ru: "коротко", en: "too short" },
    "chip.error": { ru: "ошибка", en: "error" },

    // the dan on rates (analysis.ladder.*)
    "rates.title": { ru: "Дан на рейтах", en: "Dan by rate" },
    "rates.now": { ru: "● сейчас", en: "● now" },
    "rates.counting": { ru: "считаем…", en: "counting…" },
    "rates.hint": { ru: "нажми на рейт — демо пойдёт на нём", en: "click a rate to play the demo at it" },
    "rates.none": { ru: "Для этой сложности дан на рейтах не считаем", en: "No dan by rate for this difficulty" },
    "rates.wait": { ru: "Сначала посчитаем дан на 1.0×", en: "Working out the 1.0× dan first" },

    // the demo
    "play.title": { ru: "Демо", en: "Demo" },
    "play.preview": { ru: "Сыграть демо (10 с)", en: "Play demo (10 s)" },
    "play.previewNote": { ru: "превью osu!, без входа", en: "osu!'s preview, no login" },
    "play.previewWarn": { ru: "превью общее для набора — может не совпасть с этой сложностью", en: "the preview is shared by the set — it may not match this difficulty" },
    "play.previewNone": { ru: "у этой сложности нет точки превью", en: "this difficulty has no preview point" },
    "play.full": { ru: "Полная карта", en: "Full map" },
    "play.fullNote": { ru: "скачает .osz с osu! — нужен вход, считается в лимит загрузок", en: "downloads the .osz from osu! — needs a login, counts toward the download limit" },
    "play.fullLoggedOut": { ru: "ты не вошёл на osu.ppy.sh — войди или возьми свой .osz", en: "you're not logged in on osu.ppy.sh — log in or use your own .osz" },
    "play.fullDisabled": { ru: "osu! не даёт скачать этот набор", en: "osu! doesn't allow downloading this set" },
    "play.file": { ru: "Свой .osz", en: "Your own .osz" },
    "play.fileNote": { ru: "перетащи или выбери файл", en: "drop or pick a file" },
    "play.rate": { ru: "рейт {rate}×", en: "rate {rate}×" },
    "play.keys": { ru: "клавиши D F J K, Esc — выход", en: "keys D F J K, Esc to leave" },

    // errors by code (shared/protocol.js ERR); the page words them itself
    "err.network": { ru: "нет связи с osu!", en: "can't reach osu!" },
    "err.http": { ru: "osu! ответил ошибкой {status}", en: "osu! answered with error {status}" },
    "err.not-found": { ru: "карта не найдена на osu!", en: "osu! has no such map" },
    "err.rate-limited": { ru: "osu! просит подождать — попробуй чуть позже", en: "osu! asks to wait — try again a bit later" },
    "err.login": { ru: "нужен вход на osu.ppy.sh", en: "you need to log in on osu.ppy.sh" },
    "err.limit": { ru: "лимит загрузок osu! исчерпан — попробуй позже", en: "osu!'s download limit is reached — try later" },
    "err.disabled": { ru: "osu! не даёт скачать этот набор", en: "osu! doesn't allow downloading this set" },
    "err.not-zip": { ru: "osu! прислал не .osz", en: "osu! didn't send an .osz" },
    "err.too-big": { ru: "файл слишком большой", en: "the file is too big" },
    "err.host": { ru: "загрузка ушла на чужой адрес — не берём", en: "the download went to a foreign address — refused" },
    "err.permission": { ru: "у расширения нет доступа к osu.ppy.sh — проверь его разрешения", en: "the extension has no access to osu.ppy.sh — check its permissions" },
    "err.analysis": { ru: "анализатор не справился с картой", en: "the analyzer failed on this map" },
    "err.timeout": { ru: "анализ шёл слишком долго", en: "the analysis took too long" },
    "err.bad-request": { ru: "неверный запрос", en: "bad request" },
    "err.cancelled": { ru: "отменено", en: "cancelled" },
    "err.context": { ru: "расширение обновилось — обнови страницу", en: "the extension was updated — reload the page" },
});

// Plural word forms used with "panel.count"
export const PLURALS = Object.freeze({
    diffs: { ru: ["сложность", "сложности", "сложностей"], en: ["difficulty", "difficulties"] },
});

export const makeStrings = (lang) => makeT(STRINGS, lang);

// The words of an error { code, status?, message? } (unknown codes → "unknown"/«неизвестная»).
export function errorText(t, error) {
    const code = error?.code;
    const key = `err.${code}`;
    if (code && STRINGS[key]) return t(key, { status: error.status ?? "?" });
    return t("card.errorUnknown");
}

export function countText(t, n, lang) {
    return t("panel.count", { n, word: plural(n, PLURALS.diffs, lang) });
}
