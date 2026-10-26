// "html" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
// Static markup of app/renderer/index.html (data-i18n, data-i18n-title, data-i18n-placeholder, data-i18n-value).
export default {
    // tabs
    "html.tab.analysis": { ru: "Анализ", en: "Analysis" },
    "html.tab.rate": { ru: "Рейт", en: "Rate" },
    "html.tab.marathon": { ru: "Марафон", en: "Marathon" },
    "html.tab.recommend": { ru: "Подбор", en: "Picks" },
    "html.tab.recommendTitle": { ru: "Рекомендации карт", en: "Map recommendations" },
    "html.tab.create": { ru: "Создать карту", en: "Create map" },

    // Picks tab
    "html.rec.skill": { ru: "Твой скилл", en: "Your skill" },
    "html.rec.userPlaceholder": { ru: "ник или id в osu!", en: "osu! name or id" },
    "html.rec.load": { ru: "Загрузить", en: "Load" },
    "html.rec.me": { ru: "из osu!", en: "from osu!" },
    "html.rec.meTitle": { ru: "Взять ник из запущенной osu!", en: "Use the name from the running osu!" },
    "html.rec.dan": { ru: "дан", en: "dan" },
    "html.rec.pattern": { ru: "Паттерн", en: "Pattern" },
    "html.rec.goal": { ru: "Цель", en: "Goal" },
    "html.rec.filters": { ru: "Фильтры", en: "Filters" },
    "html.rec.length": { ru: "Длина", en: "Length" },
    "html.rec.rankedOnly": { ru: "только ranked / loved", en: "ranked / loved only" },
    "html.rec.hidePlayed": { ru: "не показывать сыгранные", en: "hide maps you've played" },
    "html.rec.go": { ru: "Подобрать карты", en: "Find maps" },
    "html.rec.more": { ru: "Ещё", en: "More" },

    // Marathon tab
    "html.mar.title": { ru: "Название", en: "Title" },
    "html.mar.defaultTitle": { ru: "Мой марафон", en: "My marathon" },
    "html.mar.maps": { ru: "Карты по порядку", en: "Maps in order" },
    "html.mar.empty": { ru: "Пока пусто — добавь карты ниже.", en: "Nothing here yet — add maps below." },
    "html.mar.addCurrent": { ru: "+ выбранная в osu!", en: "+ selected in osu!" },
    "html.mar.addFile": { ru: "+ файл .osu", en: "+ .osu file" },
    "html.mar.settings": { ru: "Настройки", en: "Settings" },
    "html.mar.gap": { ru: "Пауза между картами", en: "Break between maps" },
    "html.mar.seconds": { ru: "с", en: "s" },
    "html.mar.pitch": { ru: "Менять высоту звука на рейтах (nightcore)", en: "Change pitch on rates (nightcore)" },
    "html.mar.create": { ru: "Создать марафон", en: "Create marathon" },

    // Rate tab
    "html.rate.noMap": { ru: "Карта не выбрана", en: "No map selected" },
    "html.rate.refreshTitle": { ru: "Взять карту, выбранную в osu!", en: "Use the map selected in osu!" },
    "html.rate.rate": { ru: "Рейт", en: "Rate" },
    "html.rate.pitch": { ru: "Менять высоту звука (nightcore)", en: "Change pitch (nightcore)" },
    "html.rate.difficulty": { ru: "Сложность", en: "Difficulty" },
    "html.rate.create": { ru: "Создать карту с этим рейтом", en: "Create map at this rate" },

    // Analysis tab footer
    "html.analysis.calcTitle": { ru: "Какой калькулятор показывать", en: "Which calculator to show" },
    "html.analysis.langTitle": { ru: "Язык: русский / English — Language", en: "Language: English / Russian" },
    "html.analysis.pinTitle": { ru: "Поверх всех окон", en: "Always on top" },
    "html.analysis.compactTitle": { ru: "Компактный режим", en: "Compact mode" },

    // Create map tab
    "html.create.drop": { ru: "Перетащи сюда песню (mp3 / ogg) или", en: "Drop a song here (mp3 / ogg) or" },
    "html.create.pickFile": { ru: "выбери файл", en: "pick a file" },
    "html.create.timing": { ru: "Тайминг", en: "Timing" },
    "html.create.offset": { ru: "Смещение", en: "Offset" },
    "html.create.ms": { ru: "мс", en: "ms" },
    "html.create.listen": { ru: "▶ проверить на слух", en: "▶ check by ear" },
    "html.create.dan": { ru: "Дан (диапазон: от любого до любого)", en: "Dan (range: from any to any)" },
    "html.create.patterns": { ru: "Паттерны (можно несколько)", en: "Patterns (pick one or more)" },
    "html.create.mix": { ru: "Как смешивать", en: "How to mix" },
    "html.create.mixSections": { ru: "По частям песни", en: "By song sections" },
    "html.create.mixMixed": { ru: "Вперемешку", en: "All mixed up" },
    "html.create.character": { ru: "Характер", en: "Character" },
    "html.create.stamina": { ru: "Выносливость", en: "Stamina" },
    "html.create.staminaHint": { ru: "много пауз → без отдыха", en: "lots of breaks → no rest" },
    "html.create.burst": { ru: "Всплески", en: "Bursts" },
    "html.create.burstHint": { ru: "ровно → сильные бёрсты", en: "steady → strong bursts" },
    "html.create.generate": { ru: "Создать карту", en: "Create map" },

    // >>> mapgen-P: headers of the create tab's v3 shells (the streams build the rest with JS)
    "html.create.modeSong": { ru: "Из песни", en: "From a song" },
    "html.create.modeRemap": { ru: "Из готовой карты", en: "From an existing map" },
    "html.create.parts": { ru: "Части песни", en: "Song parts" },
    "html.create.preview": { ru: "Предпросмотр", en: "Preview" },
    "html.create.metadata": { ru: "Метаданные", en: "Metadata" },
    "html.create.save": { ru: "Сохранение", en: "Saving" },
    // <<< mapgen-P
};
