// "profile" texts (the Profile tab, the local profile): key → { ru, en }.
export default {
    // the tab and its markup
    "profile.html.tab": { ru: "Профиль", en: "Profile" },
    "profile.html.useFor": { ru: "Профиль для подбора, марафона и анализа", en: "Profile for picks, marathons and analysis" },
    "profile.html.editManual": { ru: "Изменить в «Подборе»", en: "Edit in Picks" },
    "profile.html.picksIntro": {
        ru: "Твой скилл по твоим же играм: приложение записывает игры и само оценивает дан по паттернам.",
        en: "Your skill from your own plays: the app records them and works out your dan per pattern.",
    },
    "profile.html.openProfile": { ru: "Открыть «Профиль»", en: "Open Profile" },
    "profile.html.userPlaceholder": { ru: "ник или id в osu!", en: "osu! name or id" },
    "profile.html.load": { ru: "Загрузить", en: "Load" },
    "profile.html.me": { ru: "из osu!", en: "from osu!" },
    "profile.html.meTitle": { ru: "Взять ник из запущенной osu!", en: "Use the name from the running osu!" },
    "profile.html.history": { ru: "История", en: "History" },
    "profile.html.recent": { ru: "Последние игры", en: "Recent plays" },
    "profile.html.openSite": { ru: "Открыть на mania-tracker.com", en: "Open on mania-tracker.com" },
    "profile.html.record": { ru: "Записывать мои игры", en: "Record my plays" },
    "profile.html.recordNote": {
        ru: "Каждая игра, дошедшая до экрана результатов в osu! (stable или lazer), записывается и анализируется. Всё хранится только на этом компьютере.",
        en: "Every play that reaches the results screen in osu! (stable or lazer) is recorded and analysed. It all stays on this computer.",
    },
    "profile.html.patterns": { ru: "По паттернам", en: "By pattern" },
    "profile.html.top": { ru: "Лучшие игры", en: "Best plays" },
    "profile.html.importHead": { ru: "История игр", en: "Play history" },
    "profile.html.importStable": { ru: "Импорт из osu! stable", en: "Import from osu! stable" },
    "profile.html.pickOsu": { ru: "Папка osu!…", en: "osu! folder…" },
    "profile.html.importInterlude": { ru: "Импорт из Interlude", en: "Import from Interlude" },
    "profile.html.importCancel": { ru: "Стоп", en: "Stop" },
    "profile.html.importNote": {
        ru: "osu! stable: scores.db и папка Songs (только чтение). Interlude: его Data\\scores.db (без точности — слабее как довод). osu! lazer хранит игры в своей базе realm, её не прочитать — у lazer записываются только новые игры.",
        en: "osu! stable: scores.db and the Songs folder (read only). Interlude: its Data\\scores.db (no accuracy there, so weaker evidence). osu! lazer keeps plays in its realm database, which can't be read — for lazer only new plays are recorded.",
    },
    "profile.html.backupHead": { ru: "Резервная копия", en: "Backup" },
    "profile.html.export": { ru: "Экспорт…", en: "Export…" },
    "profile.html.importFile": { ru: "Импорт…", en: "Import…" },
    "profile.html.reset": { ru: "Сбросить профиль", en: "Reset profile" },
    "profile.html.modelNote": {
        ru: "Дан игры = дан карты на её рейте, поправленный на точность (полный при 96.5%). По каждой оси — среднее лучших 20 игр с весами 0.95^i; старые игры понемногу теряют вес.",
        en: "A play's dan = the map's dan at its rate, adjusted for accuracy (full at 96.5%). Each axis is the mean of the best 20 plays weighted 0.95^i; old plays slowly lose weight.",
    },

    // pages and sources
    "profile.page.tracker": { ru: "mania-tracker", en: "mania-tracker" },
    "profile.page.local": { ru: "Мой профиль", en: "My profile" },
    "profile.source.local": { ru: "Мой профиль", en: "My profile" },

    // the mania-tracker page
    "profile.tracker.plays": { ru: "игр в трекере", en: "plays on the tracker" },
    "profile.tracker.msd": { ru: "Рейтинги MinaCalc", en: "MinaCalc ratings" },
    "profile.tracker.none": { ru: "Впиши ник и нажми «Загрузить» или «из osu!».", en: "Type your nick and click Load, or “from osu!”." },
    "profile.tracker.noRecent": { ru: "Трекер не видел недавних игр", en: "The tracker has no recent plays" },

    // the local profile
    "profile.local.name": { ru: "Мой профиль", en: "My profile" },
    "profile.local.tag": { ru: "по моим играм", en: "from my plays" },
    "profile.local.loading": { ru: "Читаю профиль…", en: "Reading the profile…" },
    "profile.local.notEnough": {
        ru: "Пока мало игр для дана — сыграй ещё или импортируй историю в «Профиле»",
        en: "Not enough plays for a dan yet — play some more or import your history in Profile",
    },
    "profile.local.fewPlays": { ru: "мало игр", en: "not enough plays" },
    "profile.local.mapsSoFar": { ru: "карт: {n}", en: "maps: {n}" },
    "profile.local.partial": { ru: "(не по всем осям)", en: "(not every axis yet)" },
    "profile.local.noPlays": { ru: "Игр пока нет", en: "No plays yet" },
    "profile.local.count": { ru: "{n} игр, с даном {rated}", en: "{n} plays, {rated} with a dan" },
    "profile.local.fromLive": { ru: "записано {n}", en: "{n} recorded" },
    "profile.local.fromStable": { ru: "из osu! stable {n}", en: "{n} from osu! stable" },
    "profile.local.fromInterlude": { ru: "из Interlude {n}", en: "{n} from Interlude" },
    "profile.local.noTop": { ru: "Здесь пока нет игр", en: "No plays here yet" },
    "profile.local.compare": { ru: "Сравнение с mania-tracker ({name})", en: "Compared with mania-tracker ({name})" },
    "profile.local.noInterlude": { ru: "Сначала привяжи папку Interlude (кнопка IL на карточке)", en: "Link your Interlude folder first (the IL button on the card)" },
    "profile.local.noHistory": { ru: "Нет игр за это время", en: "No plays in this period" },
    "profile.local.recordOn": { ru: "Игры записываются", en: "Plays are recorded" },
    "profile.local.recordOff": { ru: "Запись выключена", en: "Recording is off" },
    "profile.local.exportTitle": { ru: "Сохранить профиль", en: "Save the profile" },
    "profile.local.importTitle": { ru: "Открыть копию профиля", en: "Open a profile backup" },
    "profile.local.badBackup": { ru: "Это не копия профиля Lunacy mania", en: "That is not a Lunacy mania profile backup" },
    "profile.local.pickOsu": { ru: "Папка osu! (где osu!.exe и scores.db)", en: "The osu! folder (with osu!.exe and scores.db)" },
    "profile.conf.low": { ru: "уверенность низкая", en: "low confidence" },
    "profile.conf.medium": { ru: "уверенность средняя", en: "medium confidence" },
    "profile.conf.high": { ru: "уверенность высокая", en: "high confidence" },

    // the dan pictures (app/renderer/danCharts.js)
    "profile.chart.scale": { ru: "Шкала", en: "Scale" },
    "profile.chart.radar": { ru: "Паутинка", en: "Radar" },
    "profile.chart.overall": { ru: "Общий", en: "Overall" },
    "profile.chart.tapHint": { ru: "Наведи или нажми на отметку — покажу, что значит число", en: "Hover over or tap a marker to see what its number means" },
    "profile.chart.legend": {
        ru: "{num} = {label}. Целое число — дан (11 = Alpha … 20 = Kappa), дробь — low/mid/high внутри дана; ± — насколько уверена оценка",
        en: "{num} = {label}. The whole number is the dan (11 = Alpha … 20 = Kappa), the fraction is low/mid/high within it; ± is how sure the estimate is",
    },
    "profile.chart.legendNoRange": {
        ru: "{num} = {label}. Целое число — дан (11 = Alpha … 20 = Kappa), дробь — low/mid/high внутри дана",
        en: "{num} = {label}. The whole number is the dan (11 = Alpha … 20 = Kappa), the fraction is low/mid/high within it",
    },
    "profile.chart.byMaps.one": { ru: "по {n} карте", en: "from {n} map" },
    "profile.chart.byMaps.few": { ru: "по {n} картам", en: "from {n} maps" },
    "profile.chart.byMaps.many": { ru: "по {n} картам", en: "from {n} maps" },

    // one play
    "profile.play.fail": { ru: "провал", en: "failed" },
    "profile.play.quit": { ru: "вышел", en: "quit" },
    "profile.play.unknown": { ru: "карта без названия", en: "untitled map" },
    "profile.play.perf": { ru: "карта {map} → {perf}", en: "map {map} → {perf}" },
    "profile.play.map": { ru: "карта {map}", en: "map {map}" },
    "profile.play.unrated": { ru: "без дана", en: "no dan" },

    // the history import
    "profile.import.scan": { ru: "Читаю папку Songs: {done} / {total}", en: "Reading the Songs folder: {done} / {total}" },
    "profile.import.analyse": { ru: "Анализ игр: {done} / {total}, добавлено {added}", en: "Analysing plays: {done} / {total}, {added} added" },
    "profile.import.done": { ru: "Готово: добавлено {added} из {total}", en: "Done: {added} of {total} added" },
    "profile.import.stopped": { ru: "Остановлено: добавлено {added} из {total} — нажми ещё раз, чтобы продолжить", en: "Stopped: {added} of {total} added — click again to go on" },
    "profile.import.missing": { ru: "{n} карт нет в Songs", en: "{n} maps not in Songs" },
    "profile.import.lastDone": { ru: "Последний импорт: +{added}, {when}", en: "Last import: +{added}, {when}" },
    "profile.import.lastStopped": { ru: "Импорт не закончен (+{added}, {when}) — можно продолжить", en: "Import not finished (+{added}, {when}) — you can go on" },
    "profile.import.noFolder": { ru: "Не нашёл папку osu! — выбери её кнопкой «Папка osu!…»", en: "Couldn't find the osu! folder — pick it with “osu! folder…”" },
    "profile.import.noScores": { ru: "В {folder} нет scores.db — выбери папку osu!", en: "No scores.db in {folder} — pick the osu! folder" },
    "profile.import.busy": { ru: "Импорт уже идёт", en: "An import is already running" },

    // backup
    "profile.backup.exported": { ru: "Сохранено игр: {n}", en: "{n} plays saved" },
    "profile.backup.imported": { ru: "Добавлено игр: {n} (уже были: {skipped})", en: "{n} plays added ({skipped} were there already)" },
    "profile.backup.resetSure": { ru: "Точно сбросить? Нажми ещё раз", en: "Really reset? Click again" },
    "profile.backup.wasReset": { ru: "Профиль сброшен", en: "The profile was reset" },
};
