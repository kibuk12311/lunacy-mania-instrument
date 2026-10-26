// "core" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
// Covers src/core (analysis, dan labels, confidence) and src/recommend (mania-tracker, picks, rate fit, downloads).
export default {
    // src/core/analyze.js
    "core.analyze.noCalculator": { ru: "ни один калькулятор не смог посчитать карту", en: "none of the calculators could rate this map" },

    // src/core/labels.js: the ends of the dan scale
    "core.label.belowFirst": { ru: "ниже 1 дана", en: "below dan 1" },
    "core.label.aboveKappa": { ru: "выше Kappa", en: "above Kappa" },

    // src/core/model.js: how sure the dan estimate is
    "core.confidence.high": { ru: "высокая", en: "high" },
    "core.confidence.medium": { ru: "средняя", en: "medium" },
    "core.confidence.low": { ru: "низкая", en: "low" },

    // src/recommend/tracker.js
    "core.tracker.down": { ru: "mania-tracker не отвечает — проверь интернет", en: "mania-tracker isn't answering — check your internet connection" },
    "core.tracker.rateLimited": {
        ru: "mania-tracker просит подождать {seconds} с — слишком много запросов подряд",
        en: "mania-tracker asks you to wait {seconds} s — too many requests in a row",
    },
    "core.tracker.status": { ru: "mania-tracker ответил {status}", en: "mania-tracker answered with {status}" },
    "core.tracker.badReply": { ru: "mania-tracker прислал непонятный ответ", en: "mania-tracker sent a reply we couldn't read" },

    // src/recommend/skill.js and recommend.js
    "core.rec.unknownPattern": { ru: "неизвестный паттерн", en: "unknown pattern" },
    "core.rec.unknownGoal": { ru: "неизвестная цель", en: "unknown goal" },
    "core.rec.noProfileOrDan": {
        ru: "сначала загрузи профиль с mania-tracker — или выбери дан вручную",
        en: "load your mania-tracker profile first — or set your dan manually",
    },
    "core.rec.noTileDan": {
        ru: "на mania-tracker пока нет дана для этой плитки — выбери дан вручную",
        en: "mania-tracker has no dan for this skillset yet — set your dan manually",
    },
    "core.rec.playerNotFound": { ru: "игрок не найден на mania-tracker", en: "player not found on mania-tracker" },
    "core.rec.notTracked": {
        ru: "mania-tracker ещё не отслеживает {name} — открой его профиль на mania-tracker.com и попробуй позже",
        en: "mania-tracker isn't tracking {name} yet — open their profile on mania-tracker.com and try again later",
    },
    "core.rec.no4k": { ru: "у {name} нет 4K игр на mania-tracker", en: "{name} has no 4K plays on mania-tracker" },
    "core.rec.notCounted": {
        ru: "mania-tracker ещё не посчитал скилл {name} — открой профиль на mania-tracker.com и попробуй позже",
        en: "mania-tracker hasn't worked out {name}'s skill yet — open the profile on mania-tracker.com and try again later",
    },
    "core.rec.needManualDan": { ru: "выбери дан вручную", en: "set your dan manually" },
    "core.rec.needProfile": { ru: "сначала загрузи профиль с mania-tracker", en: "load your mania-tracker profile first" },
    "core.rec.needPicks": { ru: "сначала подбери карты", en: "find your picks first" },

    // src/recommend/rank.js: how much of the map is the chosen pattern
    "core.purity.pure": { ru: "чистый", en: "pure" },
    "core.purity.mostly": { ru: "в основном", en: "mostly" },
    "core.purity.mixed": { ru: "смешанный", en: "mixed" },

    // src/recommend/rateFit.js
    "core.rateFit.notRice": { ru: "не 4K рис — наш анализатор такие не считает", en: "not 4K rice — our analyzer doesn't rate these" },
    "core.rateFit.tooShort": { ru: "карта слишком короткая", en: "this map is too short" },
    "core.rateFit.failed": { ru: "наш анализатор не смог посчитать карту", en: "our analyzer couldn't rate this map" },

    // src/recommend/download.js
    "core.download.allFailed": {
        ru: "не удалось скачать карту ни с одного зеркала — попробуй позже или открой страницу карты",
        en: "couldn't download the map from any mirror — try again later or open the map's page",
    },
    "core.download.status": { ru: "{host} ответил {status}", en: "{host} answered with {status}" },
    "core.download.tooBig": { ru: "{host}: файл слишком большой", en: "{host}: the file is too big" },
    "core.download.notOsz": { ru: "{host} прислал не .osz", en: "{host} sent something that isn't an .osz" },
    "core.download.noAnswer": { ru: "{host}: не отвечает", en: "{host}: not answering" },
    "core.download.badId": { ru: "неверный номер карты", en: "invalid map id" },
};
