// "rate" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
export default {
    // dan preview at the chosen rate; {tech} is " · Tech" or empty
    "rate.preview.counting": { ru: "Считаем дан на ×{rate}…", en: "Working out the dan at ×{rate}…" },
    "rate.preview.ok": { ru: "На ×{rate}: {label} · {numeric} · {primary}{tech}", en: "At ×{rate}: {label} · {numeric} · {primary}{tech}" },
    "rate.preview.notMania": { ru: "Не osu!mania — дан не считаем", en: "Not osu!mania — no dan for this one" },
    "rate.preview.ln": { ru: "LN-карта — дан не считаем", en: "LN map — no dan for this one" },
    "rate.preview.lnHint": { ru: "LN-карта — включи «Без LN», чтобы посчитать дан", en: "LN map — turn on “No LN” to get a dan" },
    "rate.preview.keys": { ru: "Не 4K ({keys}k) — дан не считаем", en: "Not 4K ({keys}k) — no dan for this one" },
    "rate.preview.tooShort": { ru: "Слишком короткая карта", en: "This map is too short" },
    "rate.error": { ru: "Ошибка: {message}", en: "Error: {message}" },

    // the selected map and the rate-changed copy
    "rate.noMap": { ru: "Нет карты: {message}", en: "No map: {message}" },
    "rate.notManiaMap": { ru: "Это не osu!mania карта.", en: "This isn't an osu!mania map." },
    "rate.creating": { ru: "Создаём… (аудио пересчитывается один раз на каждый рейт)", en: "Creating… (the audio is re-rendered once per rate)" },
    "rate.done": {
        ru: "Готово: [{version}] в папке карты. Если в osu! не появилась — нажми F5 в выборе карт.",
        en: "Done: [{version}] is in the map's folder. If osu! doesn't show it, press F5 in song select.",
    },
    // osu! lazer has no Songs folder: the copies are packed into an .osz that lazer imports as a set of its own
    "rate.html.lazerNote": {
        ru: "osu! lazer: копии собираются в один .osz в Документы\\Lunacy mania\\карты и открываются в lazer — он импортирует их отдельным набором карт.",
        en: "osu! lazer: the copies are packed into one .osz in the app's maps folder (Documents\\Lunacy mania) and opened in lazer — it imports them as a separate beatmap set.",
    },
    "rate.doneLazer": {
        ru: "Готово: [{version}] — .osz открыт в osu! lazer, карта появится отдельным набором после импорта. Файл: {file}",
        en: "Done: [{version}] — the .osz is open in osu! lazer, the map shows up as a separate set once it's imported. File: {file}",
    },
    "rate.doneLazerNotOpened": {
        ru: "Готово: [{version}], но .osz не открылся сам — перетащи его в окно osu! lazer. Файл: {file}",
        en: "Done: [{version}], but the .osz didn't open by itself — drag it into the osu! lazer window. File: {file}",
    },
    // the badge after the map's name when it has holds
    "rate.lnBadge": { ru: "LN {pct}%", en: "LN {pct}%" },
    "rate.lnBadgeTitle": { ru: "Доля длинных нот (холдов) на карте", en: "Share of long notes (holds) in the map" },

    // copy options, as preset chips name them
    "rate.option.mirror": { ru: "Зеркало", en: "Mirror" },
    "rate.option.noLn": { ru: "Без LN", en: "No LN" },

    // presets
    "rate.preset.empty": { ru: "Пока пусто — настрой и нажми «Сохранить пресет»", en: "Nothing yet — set things up and press “Save preset”" },
    "rate.preset.apply": { ru: "Поставить эти настройки", en: "Use these settings" },
    "rate.preset.remove": { ru: "Убрать пресет", en: "Remove preset" },
    "rate.preset.saved": { ru: "Пресет сохранён: {label}", en: "Preset saved: {label}" },
    "rate.preset.failed": { ru: "Пресет не сохранился: {message}", en: "Couldn't save the preset: {message}" },

    // rate for a dan
    "rate.target.start": { ru: "Ищем…", en: "Searching…" },
    "rate.target.searching": { ru: "Ищем… ×{rate} → {numeric}", en: "Searching… ×{rate} → {numeric}" },
    "rate.target.found": { ru: "{label} → ×{rate} ({numeric}), {tried}", en: "{label} → ×{rate} ({numeric}), {tried}" },
    "rate.target.closest": { ru: "{label}: ближе всего ×{rate} ({numeric}), {tried}", en: "{label}: the closest is ×{rate} ({numeric}), {tried}" },
    "rate.target.tried.one": { ru: "проверен {n} рейт", en: "{n} rate tried" },
    "rate.target.tried.few": { ru: "проверено {n} рейта", en: "{n} rates tried" },
    "rate.target.tried.many": { ru: "проверено {n} рейтов", en: "{n} rates tried" },
    "rate.target.above": { ru: "Даже на ×{rate} только {label}", en: "Even at ×{rate} it's only {label}" },
    "rate.target.below": { ru: "Даже на ×{rate} уже {label}", en: "Even at ×{rate} it's already {label}" },
    "rate.target.failed": { ru: "Не нашли: {message}", en: "Not found: {message}" },

    // several rates at once
    "rate.batch.count.one": { ru: "{n} рейт", en: "{n} rate" },
    "rate.batch.count.few": { ru: "{n} рейта", en: "{n} rates" },
    "rate.batch.count.many": { ru: "{n} рейтов", en: "{n} rates" },
    "rate.batch.create": { ru: "Создать отмеченные ({n})", en: "Create checked ({n})" },
    "rate.batch.counting": { ru: "Считаем даны {index}/{total}…", en: "Counting dans {index}/{total}…" },
    "rate.batch.progress": { ru: "Создаём {index}/{total}: ×{rate}…", en: "Creating {index}/{total}: ×{rate}…" },
    "rate.batch.done.one": { ru: "Готово: {n} карта. F5 в выборе карт.", en: "Done: {n} map. Press F5 in song select." },
    "rate.batch.done.few": { ru: "Готово: {n} карты. F5 в выборе карт.", en: "Done: {n} maps. Press F5 in song select." },
    "rate.batch.done.many": { ru: "Готово: {n} карт. F5 в выборе карт.", en: "Done: {n} maps. Press F5 in song select." },
    // lazer: every copy of the batch in one .osz
    "rate.batch.lazerOpened": {
        ru: "Готово, копий: {n} — один .osz открыт в osu! lazer (импорт отдельным набором). Файл: {file}",
        en: "Done, {n} copies — one .osz is open in osu! lazer (imported as a separate set). File: {file}",
    },
    "rate.batch.lazerNotOpened": {
        ru: "Готово, копий: {n}, но .osz не открылся сам — перетащи его в окно osu! lazer. Файл: {file}",
        en: "Done, {n} copies, but the .osz didn't open by itself — drag it into the osu! lazer window. File: {file}",
    },
    "rate.batch.failed": { ru: "Не вышло: ×{rate} ({message})", en: "Failed: ×{rate} ({message})" },
    "rate.batch.stopped": { ru: "Остановлено", en: "Stopped" },
    "rate.batch.rowTitle": { ru: "Поставить этот рейт", en: "Use this rate" },
    "rate.batch.row.ln": { ru: "LN-карта", en: "LN map" },
    "rate.batch.row.notRice": { ru: "не 4K рис", en: "not 4K rice" },
    "rate.batch.row.tooShort": { ru: "коротко", en: "too short" },
    "rate.batch.row.error": { ru: "ошибка", en: "error" },

    // index.html (#rate-tab)
    "rate.html.presets": { ru: "Пресеты:", en: "Presets:" },
    "rate.html.target": { ru: "Рейт под дан", en: "Rate for a dan" },
    "rate.html.find": { ru: "Найти рейт", en: "Find rate" },
    "rate.html.mirror": { ru: "Зеркально (колонки наоборот)", en: "Mirror (flip columns)" },
    "rate.html.noLn": { ru: "Без LN (LN → обычные ноты)", en: "No LN (holds → normal notes)" },
    "rate.html.savePreset": { ru: "Сохранить пресет", en: "Save preset" },
    "rate.html.batch": { ru: "Несколько рейтов", en: "Several rates" },
    "rate.html.from": { ru: "от", en: "from" },
    "rate.html.to": { ru: "до", en: "to" },
    "rate.html.step": { ru: "шаг", en: "step" },
    "rate.html.countDans": { ru: "Посчитать даны", en: "Count dans" },
    "rate.html.stop": { ru: "Стоп", en: "Stop" },

    // main-process answers
    "rate.err.busy": { ru: "уже идёт расчёт рейтов", en: "rates are already being worked out" },
    "rate.err.badSteps": { ru: "рейты — от 0.5 до 2, шаг от 0.01, не больше 31 за раз", en: "rates go from 0.5 to 2, a step of at least 0.01, at most 31 at a time" },
    "rate.err.badTarget": { ru: "выбери дан — от 1 дана до Kappa", en: "pick a dan — from Dan 1 to Kappa" },
    "rate.err.cancelled": { ru: "отменено", en: "cancelled" },
};
