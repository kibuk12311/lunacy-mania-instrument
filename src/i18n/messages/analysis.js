// "analysis" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
// The analysis card (app/renderer/view.js) and its calculator picker.
export default {
    // calculator picker
    "analysis.calc.ours": { ru: "Общий", en: "Overall" },
    "analysis.calc.oursHint": { ru: "наш анализатор — сводит все калькуляторы и паттерны", en: "our analyzer — combines every calculator and pattern" },
    "analysis.calc.all": { ru: "Все", en: "All" },
    "analysis.calc.allHint": { ru: "все калькуляторы рядом", en: "every calculator side by side" },

    // the card
    "analysis.noEstimate": { ru: "нет оценки", en: "no estimate" },
    "analysis.confidence": { ru: "уверенность {confidence} · разброс ±{spread}", en: "confidence {confidence} · spread ±{spread}" },
    "analysis.versus": { ru: "общий: {label} {numeric}", en: "overall: {label} {numeric}" },

    // states and maps we don't rate
    "analysis.notMania": { ru: "Не osu!mania", en: "Not osu!mania" },
    "analysis.ln": { ru: "LN-карта — не считаем", en: "LN map — not rated" },
    "analysis.notFourKey": { ru: "Не 4K ({keys}k)", en: "Not 4K ({keys}k)" },
    "analysis.tooShort": { ru: "Слишком короткая карта", en: "Map is too short" },
    "analysis.error": { ru: "Ошибка: {message}", en: "Error: {message}" },
    "analysis.errorUnknown": { ru: "неизвестная", en: "unknown" },
    "analysis.loading": { ru: "Считаем…", en: "Calculating…" },
    "analysis.tosuFailed": { ru: "Не удалось запустить tosu: {reason}", en: "Couldn't start tosu: {reason}" },
    "analysis.osuUpdated": { ru: "osu! обновилась? Нужна новая версия приложения", en: "Did osu! update? You need a new version of the app" },
    "analysis.waiting": { ru: "Ждём osu!…", en: "Waiting for osu!…" },

    // >>> analysis v2: the blocks under the card (app/renderer/analysisExtras.js) and the analysis-rate channel
    // the difficulty line and the pattern strip
    "analysis.extras.title": { ru: "Сложность по ходу карты", en: "Difficulty over the map" },
    "analysis.extras.peak": { ru: "пик {from}–{to}", en: "peak {from}–{to}" },
    "analysis.extras.hint": { ru: "Самое тяжёлое: {from}–{to} · Sunny strain относительно пика карты", en: "Hardest: {from}–{to} · Sunny strain relative to the map's peak" },
    "analysis.extras.flat": { ru: "Sunny strain относительно пика карты", en: "Sunny strain relative to the map's peak" },
    "analysis.extras.strip": { ru: "Паттерны по ходу карты", en: "Patterns along the map" },
    "analysis.extras.flavourStrip": { ru: "Разновидности паттернов по ходу карты", en: "Pattern kinds along the map" },
    "analysis.extras.break": { ru: "пауза", en: "break" },

    // "for you": the map against the player's mania-tracker dan
    "analysis.fit.title": { ru: "Для тебя ({name})", en: "For you ({name})" },
    "analysis.fit.line": { ru: "{who}: {label} ({dan}) · карта {delta} — {band}", en: "{who}: {label} ({dan}) · map {delta} — {band}" },
    "analysis.fit.tile": { ru: "{tile}-дан", en: "{tile} dan" },
    "analysis.fit.overall": { ru: "общий дан", en: "overall dan" },
    "analysis.fit.band.easy": { ru: "легко — разминка", en: "easy — warm-up" },
    "analysis.fit.band.comfort": { ru: "комфорт — пройдёшь уверенно", en: "comfort — a solid pass" },
    "analysis.fit.band.growth": { ru: "рост — реально пройти", en: "growth — a doable push" },
    "analysis.fit.band.challenge": { ru: "челлендж — тяжело, но шанс есть", en: "challenge — hard, but there's a chance" },
    "analysis.fit.band.hard": { ru: "пока вряд ли — попробуй рейт пониже", en: "probably not yet — try a lower rate" },
    "analysis.fit.msd": { ru: "MSD {axis}: {map} против твоих {player} ({d})", en: "MSD {axis}: {map} vs your {player} ({d})" },
    "analysis.fit.noDan": { ru: "На трекере пока нет твоего дана", en: "The tracker has no dan for you yet" },
    "analysis.fit.noProfile": { ru: "Сравнить с твоим скиллом — укажи ник во вкладке «Подбор»", en: "Compare with your skill — set your nick in the Picks tab" },
    "analysis.fit.loading": { ru: "Загружаем профиль…", en: "Loading profile…" },

    // the dan of the same chart at other rates
    "analysis.ladder.title": { ru: "Дан на рейтах", en: "Dan by rate" },
    "analysis.ladder.now": { ru: "● сейчас", en: "● now" },
    "analysis.ladder.growth": { ru: "твой рост", en: "your growth" },
    "analysis.ladder.counting": { ru: "считаем…", en: "counting…" },
    "analysis.ladder.hint": { ru: "нажми — открыть во вкладке «Рейт»", en: "click to open in the Rate tab" },

    // main-process refusals of analysis-rate
    "analysis.err.request": { ru: "Неверный запрос", en: "Bad request" },
    "analysis.err.rate": { ru: "Рейт должен быть от 0.5 до 2", en: "The rate must be between 0.5 and 2" },
    // <<< analysis v2
};
