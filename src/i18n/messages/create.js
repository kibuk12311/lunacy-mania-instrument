// "create" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
export default {
    // dan levels in the pickers (src/gen/request.js); 11–20 keep their Greek names
    "create.level.dan": { ru: "{n} дан", en: "Dan {n}" },
    "create.error.noPatterns": { ru: "выбери хотя бы один паттерн", en: "pick at least one pattern" },

    // song and timing
    "create.song.noPath": { ru: "Не удалось прочитать путь к файлу.", en: "Couldn't read the file path." },
    "create.song.reading": { ru: "{name} — разбираем песню…", en: "{name} — reading the song…" },
    "create.song.drop": { ru: "Перетащи сюда песню (mp3 / ogg)", en: "Drop a song here (mp3 / ogg)" },
    "create.song.openFailed": { ru: "Не получилось открыть песню: {message}", en: "Couldn't open the song: {message}" },
    "create.timing.auto": {
        ru: "определено автоматически — проверь на слух и поправь, если щелчки не совпадают с битом",
        en: "detected automatically — have a listen and fix it if the clicks are off the beat",
    },
    "create.timing.check": { ru: "Проверь BPM и смещение.", en: "Check the BPM and offset." },
    "create.listen.play": { ru: "▶ проверить на слух", en: "▶ check by ear" },
    "create.listen.stop": { ru: "■ стоп", en: "■ stop" },

    // generating and the result
    "create.generating": { ru: "Создаём карту и подбираем дан… обычно 5–20 секунд", en: "Making the map and tuning the dan… usually 5–20 seconds" },
    "create.error": { ru: "Ошибка: {message}", en: "Error: {message}" },
    "create.result.done": { ru: "Готово: {label} · {numeric} (в диапазоне {range})", en: "Done: {label} · {numeric} (within {range})" },
    "create.result.closest": {
        ru: "Ближе всего получилось: {label} · {numeric} (диапазон {range}) — с этими паттернами на этой песне в него не попасть",
        en: "Closest we got: {label} · {numeric} (range {range}) — these patterns can't reach it on this song",
    },
    "create.result.patternMatch": { ru: "Паттерны совпали с заказом на {pct}%", en: "Patterns match what you asked for: {pct}%" },
    "create.result.flavourMatch": { ru: "Разновидности паттернов совпали с заказом на {pct}%", en: "Pattern kinds match what you asked for: {pct}%" },
    "create.result.stats": {
        ru: "{notes} нот · уверенность {confidence}",
        en: ({ notes }) => `{notes} ${Number(notes) === 1 ? "note" : "notes"} · confidence {confidence}`,
    },

    // mapgen v3: each stream adds its keys only inside its own block (the keys above belong to stream B)
    // >>> mapgen-B: the create tab's UI
    // counted texts: the Russian word follows the number (1 часть, 2 части, 5 частей)
    ...(() => {
        const ru = (n, one, few, many) => {
            const count = Math.abs(Math.trunc(Number(n) || 0));
            const d = count % 10;
            const h = count % 100;
            if (h >= 11 && h <= 14) return many;
            return d === 1 ? one : d >= 2 && d <= 4 ? few : many;
        };
        return {
            "create.timing.variable": {
                ru: ({ n }) => `Найден переменный BPM: {n} ${ru(n, "часть", "части", "частей")} — проверь каждую`,
                en: ({ n }) => `Variable BPM found: {n} ${Number(n) === 1 ? "part" : "parts"} — check each one`,
            },
            "create.generate.set": {
                ru: ({ n }) => `Создать набор ({n} ${ru(n, "сложность", "сложности", "сложностей")})`,
                en: ({ n }) => `Create mapset ({n} ${Number(n) === 1 ? "difficulty" : "difficulties"})`,
            },
            "create.retry.blocks": {
                ru: ({ n }) => `Переделал {n} ${ru(n, "кусок", "куска", "кусков")}, где паттерн не совпадал`,
                en: ({ n }) => `Redid {n} ${Number(n) === 1 ? "spot" : "spots"} where the pattern was off`,
            },
        };
    })(),

    // timing: sections, the wave strip and the snap divisors
    "create.timing.refined": { ru: "Тайминг уточнён по волне (±{err} мс)", en: "Timing refined from the waveform (±{err} ms)" },
    "create.timing.start": { ru: "Начало", en: "Start" },
    "create.timing.meter": { ru: "Размер", en: "Meter" },
    "create.timing.remove": { ru: "Удалить точку", en: "Remove point" },
    "create.timing.addPoint": { ru: "+ точка здесь", en: "+ point here" },
    "create.timing.oneBpm": { ru: "Один BPM на всю песню", en: "One BPM for the whole song" },
    "create.timing.fitWave": { ru: "Подогнать по волне", en: "Snap to waveform" },
    "create.timing.nudgeHint": { ru: "←/→ — сдвиг на 1 мс, с Shift — на 5 мс", en: "←/→ moves 1 ms, with Shift 5 ms" },
    "create.snap.title": { ru: "Дробление сетки", en: "Snap divisors" },
    "create.snap.betaHint": {
        ru: "триплеты пока ставятся по правилам — модель обучена только на 1/4",
        en: "triplets are rule-placed for now — the model was trained on 1/4 only",
    },
    "create.snap.normalizeSv": { ru: "Ровная скорость скролла", en: "Even scroll speed" },

    // song parts: the timeline and the part editor
    "create.parts.kind.intro": { ru: "Вступление", en: "Intro" },
    "create.parts.kind.build": { ru: "Нарастание", en: "Build-up" },
    "create.parts.kind.drop": { ru: "Дроп", en: "Drop" },
    "create.parts.kind.break": { ru: "Затишье", en: "Break" },
    "create.parts.kind.outro": { ru: "Концовка", en: "Outro" },
    "create.parts.kind.part": { ru: "Часть", en: "Part" },
    "create.parts.found": {
        ru: "Найдено частей: {n} · дропов: {d}",
        en: ({ n, d }) => `{n} ${Number(n) === 1 ? "part" : "parts"} found · {d} ${Number(d) === 1 ? "drop" : "drops"}`,
    },
    "create.parts.hint": { ru: "Нажми на часть, чтобы задать ей свой паттерн и дан", en: "Click a part to give it its own pattern and dan" },
    "create.parts.same": { ru: "Как у всей карты", en: "Same as the whole map" },
    "create.parts.anyStep": { ru: "любой", en: "any" },
    "create.parts.empty": { ru: "Без нот", en: "No notes" },
    "create.parts.split": { ru: "Разрезать на курсоре", en: "Split at the cursor" },
    "create.parts.merge": { ru: "Склеить со следующей", en: "Merge with the next" },
    "create.parts.reset": { ru: "Сбросить части", en: "Reset parts" },
    "create.parts.badgeOff": { ru: "≈ {label} (просили {wanted})", en: "≈ {label} (asked for {wanted})" },
    "create.parts.danHint": {
        ru: "Дан этой части, если играть её отдельно — обычно чуть ниже дана всей карты",
        en: "This part's dan if played on its own — usually a bit lower than the whole map's",
    },

    // generating: what the worker is busy with
    "create.progress.partSearch": { ru: "Подбираем дан: часть {i} из {n} ({kind})", en: "Tuning the dan: part {i} of {n} ({kind})" },
    "create.progress.search": { ru: "Подбираем плотность…", en: "Tuning the density…" },
    "create.progress.retry": { ru: "Переделываем неудачные куски…", en: "Redoing weak spots…" },
    "create.progress.describe": { ru: "Проверяем части…", en: "Checking the parts…" },

    // the playfield preview
    "create.play.play": { ru: "▶ играть", en: "▶ play" },
    "create.play.pause": { ru: "❚❚ пауза", en: "❚❚ pause" },
    "create.play.speed": { ru: "Скорость прокрутки", en: "Scroll speed" },
    "create.play.clicks": { ru: "Щелчки на нотах", en: "Hit clicks" },
    "create.play.gridOnly": { ru: "Пока только сетка битов — проверь, что линии совпадают с ударами", en: "Beat grid only for now — check the lines match the hits" },
    "create.play.keys": { ru: "Пробел — играть/пауза, ←/→ — 2 с, колесо — на бит", en: "Space — play/pause, ←/→ — 2 s, wheel — one beat" },

    // variants, difficulties and their cards
    "create.variants.progress": { ru: "Вариант {n} из {total}…", en: "Variant {n} of {total}…" },
    "create.variants.stop": { ru: "Стоп", en: "Stop" },
    "create.variant.name": { ru: "Вариант {letter}", en: "Variant {letter}" },
    "create.variant.best": { ru: "лучший", en: "best" },
    "create.variant.use": { ru: "Взять этот", en: "Use this one" },
    "create.variant.more": { ru: "Ещё вариант", en: "Another variant" },
    "create.stats.sizes": { ru: "Одиночные {s1}% · двойные {s2}% · тройные {s3}% · квады {s4}%", en: "Singles {s1}% · jumps {s2}% · hands {s3}% · quads {s4}%" },
    "create.stats.balance": { ru: "Левая рука {left}% · столбцы {cols}", en: "Left hand {left}% · columns {cols}" },
    "create.stats.jacks": { ru: "Самый длинный джек {all} (в стримах {streamy}) · пик {nps} нот/с", en: "Longest jack {all} (in streams {streamy}) · peak {nps} notes/s" },
    "create.stats.clean": { ru: "Неудобных мест нет", en: "No awkward spots" },
    "create.stats.issues": { ru: "Проблемных мест: {n}", en: "Problem spots: {n}" },
    "create.stats.more": { ru: "ещё {n}", en: "{n} more" },
    "create.issue.jack": { ru: "{time}: джек из {n} нот в столбце {col}", en: "{time}: {n}-note jack in column {col}" },
    "create.issue.anchor": { ru: "{time}: якорь — столбец {col} в {pct}% строк", en: "{time}: anchor — column {col} in {pct}% of rows" },
    "create.issue.hand": { ru: "{time}: перекос на одну руку ({pct}% слева)", en: "{time}: one hand overloaded ({pct}% left)" },
    "create.issue.spike": { ru: "{time}: всплеск плотности ({n} нот за бит)", en: "{time}: density spike ({n} notes in a beat)" },
    "create.issue.fastJack": { ru: "{time}: слишком быстрый джек ({ms} мс)", en: "{time}: jack too fast ({ms} ms)" },
    "create.issue.columns": { ru: "Столбцы неравномерны: самый загруженный в {ratio} раза больше", en: "Columns uneven: the busiest has {ratio}× the notes" },
    "create.part.row": { ru: "{from}–{to} · {family} · паттерн {pct}% · ≈{dan}", en: "{from}–{to} · {family} · pattern {pct}% · ≈{dan}" },
    "create.part.lock": { ru: "Закрепить", en: "Lock" },
    "create.part.locked": { ru: "Закреплено", en: "Locked" },
    "create.part.regen": { ru: "Перегенерировать незакреплённое", en: "Regenerate the unlocked parts" },
    "create.retry.danLow": { ru: "Дан не доставал — повторил с более плотными тихими частями", en: "The dan fell short — retried with denser light parts" },
    "create.retry.danHigh": { ru: "Дан был выше — повторил с более редкими нотами", en: "The dan was too high — retried with sparser notes" },
    "create.lock.timingChanged": { ru: "Тайминг изменился — закреплённые части сброшены", en: "Timing changed — locked parts were cleared" },
    "create.diffs.add": { ru: "+ сложность", en: "+ difficulty" },
    "create.diffs.ladder": { ru: "Лесенка: 3 дана подряд", en: "Ladder: 3 dans in a row" },
    "create.diffs.remove": { ru: "Убрать", en: "Remove" },
    "create.diffs.from": { ru: "от", en: "from" },
    "create.diffs.to": { ru: "до", en: "to" },
    "create.set.progress": { ru: "Сложность {i} из {n} ({dan})…", en: "Difficulty {i} of {n} ({dan})…" },
    "create.result.grid": { ru: "Сетка: {n4}% 1/4 · {n3}% 1/3 · {n6}% 1/6 · {n8}% 1/8", en: "Grid: {n4}% 1/4 · {n3}% 1/3 · {n6}% 1/6 · {n8}% 1/8" },
    "create.result.model": { ru: "Модель: {kind}, обучена на {maps} картах", en: "Model: {kind}, trained on {maps} maps" },
    "create.result.rules": { ru: "Без обученной модели — ноты расставлены по правилам", en: "No trained model — the notes follow rules" },
    "create.model.neural": { ru: "нейросеть", en: "neural net" },
    "create.model.trees": { ru: "деревья решений", en: "decision trees" },
    "create.model.rules": { ru: "правила", en: "rules" },
    // <<< mapgen-B

    // >>> mapgen-C: metadata, saving, rate versions and remap
    "create.meta.artist": { ru: "Исполнитель", en: "Artist" },
    "create.meta.title": { ru: "Название", en: "Title" },
    "create.meta.source": { ru: "Источник", en: "Source" },
    "create.meta.tags": { ru: "Теги", en: "Tags" },
    "create.meta.creator": { ru: "Маппер", en: "Creator" },
    "create.meta.fromTags": { ru: "взято из тегов файла", en: "taken from the file's tags" },
    "create.bg.title": { ru: "Фон", en: "Background" },
    "create.bg.none": { ru: "Без фона", en: "No background" },
    "create.bg.image": { ru: "Картинка", en: "Image" },
    "create.bg.danCourse": { ru: "В стиле дан-курса", en: "Dan-course style" },
    "create.bg.pick": { ru: "выбрать картинку", en: "pick an image" },
    "create.bg.needImage": { ru: "Сначала выбери картинку", en: "Pick an image first" },
    "create.previewAt.label": { ru: "Превью", en: "Preview" },
    "create.previewAt.listen": { ru: "▶ послушать превью", en: "▶ listen to the preview" },
    "create.previewAt.auto": { ru: "выбрано по самой громкой части", en: "picked from the loudest part" },
    "create.previewAt.manual": { ru: "задано вручную", en: "set by hand" },
    "create.previewAt.hint": { ru: "Минуты:секунды, например 1:23.5", en: "Minutes:seconds, for example 1:23.5" },
    "create.rates.title": { ru: "Рейт-версии", en: "Rate versions" },
    "create.rates.custom": { ru: "свой", en: "custom" },
    "create.rates.nightcore": { ru: "Nightcore (меняет тон)", en: "Nightcore (changes pitch)" },
    "create.rates.preparing": { ru: "Готовим аудио {rate}x…", en: "Preparing {rate}x audio…" },
    "create.save.one": { ru: "Сохранить .osz", en: "Save .osz" },
    "create.save.set": { ru: "Сохранить набор .osz ({n})", en: "Save the mapset .osz ({n})" },
    "create.save.saving": { ru: "Сохраняем…", en: "Saving…" },
    "create.save.done": { ru: "Сохранено: {file}", en: "Saved: {file}" },
    "create.save.rateRow": { ru: "{rate}x: {label} ({numeric})", en: "{rate}x: {label} ({numeric})" },
    "create.save.nothing": { ru: "Сначала создай карту", en: "Generate a map first" },
    "create.save.failed": { ru: "Не сохранилось: {message}", en: "Not saved: {message}" },
    "create.save.open": { ru: "Открыть в osu!", en: "Open in osu!" },
    "create.save.show": { ru: "Показать файл", en: "Show file" },
    "create.save.aiNote": {
        ru: "Карта для практики: ИИ-карты нельзя ранкнуть или отправить в Loved. Если выкладываешь её, напиши, что её сделал ИИ.",
        en: "For practice: AI-made maps can't be ranked or loved. If you upload one, say it was made with AI.",
    },
    "create.remap.title": { ru: "Переделать готовую карту под другой дан", en: "Remake an existing map for another dan" },
    "create.remap.hint": {
        ru: "Ноты убираются или добавляются, тайминг, фон и звук остаются как были. Новая сложность ляжет рядом с картой.",
        en: "Notes are removed or added; the timing, background and sound stay as they were. The new difficulty goes next to the map.",
    },
    "create.remap.file": { ru: "+ файл .osu", en: "+ .osu file" },
    "create.remap.fromOsu": { ru: "взять из osu!", en: "take from osu!" },
    "create.remap.loading": { ru: "Считаем дан карты…", en: "Working out the map's dan…" },
    "create.remap.now": { ru: "{name} · сейчас {label} ({numeric})", en: "{name} · now {label} ({numeric})" },
    "create.remap.easier": { ru: "−1 дан", en: "−1 dan" },
    "create.remap.harder": { ru: "+1 дан", en: "+1 dan" },
    "create.remap.custom": { ru: "свой дан", en: "custom dan" },
    "create.remap.go": { ru: "Переделать", en: "Remap" },
    "create.remap.working": { ru: "Переделываем карту… обычно 10–40 секунд", en: "Remapping… usually 10–40 seconds" },
    "create.remap.done": {
        ru: "Готово: [{version}] · {numeric} · убрано {removed} / добавлено {added} нот — в папке карты, нажми F5 в osu!",
        en: "Done: [{version}] · {numeric} · {removed} removed / {added} added notes — in the map's folder, press F5 in osu!",
    },
    "create.remap.closest": {
        ru: "Ближе всего: [{version}] · {numeric} · убрано {removed} / добавлено {added} нот — в папке карты, нажми F5 в osu!",
        en: "Closest we got: [{version}] · {numeric} · {removed} removed / {added} added notes — in the map's folder, press F5 in osu!",
    },
    "create.remap.onlyRice": { ru: "Переделка работает только для рисовых 4K-карт", en: "Remapping works only for 4K rice maps" },
    "create.remap.failed": { ru: "Не вышло: {message}", en: "Didn't work: {message}" },
    // <<< mapgen-C
};
