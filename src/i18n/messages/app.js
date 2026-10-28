// "app" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
export default {
    // tray menu; the language item shows both languages at once ("Язык / Language"), built from this entry in main.js
    "app.tray.show": { ru: "Показать", en: "Show" },
    "app.tray.alwaysOnTop": { ru: "Поверх всех окон", en: "Always on top" },
    "app.tray.language": { ru: "Язык", en: "Language" },
    "app.tray.checkUpdates": { ru: "Проверить обновления", en: "Check for updates" },
    "app.tray.autoUpdate": { ru: "Проверять обновления автоматически", en: "Check for updates automatically" },
    "app.tray.settings": { ru: "Настройки…", en: "Settings…" },
    "app.tray.quit": { ru: "Выход", en: "Quit" },

    // updates from GitHub Releases (app/updater.js): the installed build updates itself, the portable one sends to the page
    "app.update.title": { ru: "Обновление", en: "Update" },
    "app.update.ok": { ru: "ОК", en: "OK" },
    "app.update.upToDate": { ru: "У тебя последняя версия ({version})", en: "You have the latest version ({version})" },
    "app.update.downloading": {
        ru: "Нашлась версия {version}, она скачивается в фоне. Когда будет готова, программа предложит перезапуститься.",
        en: "Found version {version}, it's downloading in the background. When it's ready, the app will offer to restart.",
    },
    "app.update.ready": { ru: "Версия {version} готова", en: "Version {version} is ready" },
    "app.update.readyDetail": {
        ru: "Перезапусти программу, чтобы установить её. Если позже — она установится, когда ты закроешь программу.",
        en: "Restart the app to install it. If you choose later, it installs when you quit the app.",
    },
    "app.update.restart": { ru: "Перезапустить сейчас", en: "Restart now" },
    "app.update.later": { ru: "Позже", en: "Later" },
    "app.update.available": { ru: "Вышла версия {version}", en: "Version {version} is out" },
    "app.update.portableDetail": {
        ru: "Это портативная версия, сама она не обновляется. Скачай новый exe со страницы релиза — или поставь установщик (Setup), он обновляется сам.",
        en: "This is the portable version, it can't update itself. Download the new exe from the release page — or use the installer (Setup), which updates itself.",
    },
    "app.update.openPage": { ru: "Открыть страницу загрузки", en: "Open the download page" },
    "app.update.failed": { ru: "Не удалось проверить обновления", en: "Couldn't check for updates" },
    "app.update.devOnly": { ru: "Обновления проверяются только в собранной программе", en: "Updates are checked only in the built app" },

    // tosu: starting it, and reading the selected map from it
    "app.tosu.portBusy": { ru: "порт {port} занят другой программой", en: "port {port} is taken by another program" },
    "app.tosu.noAnswer": { ru: "tosu не отвечает, попробуй перезапустить приложение", en: "tosu isn't responding, try restarting the app" },
    "app.tosu.missing": { ru: "tosu.exe не найден: {exe}", en: "tosu.exe not found: {exe}" },
    "app.tosu.startFailed": { ru: "tosu не запустился: {message}", en: "tosu didn't start: {message}" },
    "app.tosu.exitCode": { ru: "tosu завершился с кодом {code}", en: "tosu exited with code {code}" },
    "app.tosu.exited": { ru: "tosu неожиданно завершился", en: "tosu quit unexpectedly" },
    "app.tosu.status": { ru: "tosu вернул {status}", en: "tosu answered {status}" },
    "app.tosu.openOsu": { ru: "открой osu! и выбери карту", en: "open osu! and pick a map" },
    // a map copied out of osu! lazer's file store (app/lazerMaps.js)
    "app.lazer.noAudio": { ru: "в osu! lazer у карты не нашлось аудиофайла", en: "osu! lazer has no audio file for this map" },
    // osu! lazer's database (client.realm), read from a copy in the background (app/lazerRealm.js)
    "app.lazer.readFailed": { ru: "не удалось прочитать базу osu! lazer: {message}", en: "couldn't read the osu! lazer database: {message}" },
    "app.lazer.readTimeout": { ru: "база osu! lazer читалась слишком долго", en: "reading the osu! lazer database took too long" },
    "app.lazer.readerStopped": { ru: "чтение базы osu! lazer прервалось (код {code})", en: "reading the osu! lazer database stopped (code {code})" },
    "app.tosu.noMap": { ru: "в osu! не выбрана карта", en: "no map is selected in osu!" },
    "app.select.noFile": { ru: "не удалось получить файл карты", en: "couldn't get the map file" },

    // the background calculation (analysis and map generation)
    "app.worker.exited": { ru: "фоновый расчёт завершился", en: "the background calculation stopped" },
    "app.worker.closing": { ru: "приложение закрывается", en: "the app is closing" },
    "app.worker.timeout": { ru: "расчёт занял слишком долго", en: "the calculation took too long" },

    // checks on what the window asks for
    "app.gen.failed": { ru: "не удалось создать карту", en: "couldn't create the map" },
    "app.rate.range": { ru: "рейт от 0.5 до 2", en: "the rate must be from 0.5 to 2" },
    "app.rate.checkInput": { ru: "проверь рейт (0.5–2), OD и HP (0–10)", en: "check the rate (0.5–2), OD and HP (0–10)" },
    "app.noSuchFile": { ru: "нет такого файла", en: "no such file" },

    // marathon
    "app.marathon.needOsu": { ru: "нужен файл .osu", en: "this needs an .osu file" },
    "app.marathon.noMaps": { ru: "добавь хотя бы одну карту", en: "add at least one map" },
    "app.marathon.badRate": { ru: "рейт каждой карты — от 0.5 до 2", en: "each map's rate must be from 0.5 to 2" },
    "app.marathon.badGap": { ru: "пауза — от 0 до 120 секунд", en: "the break must be from 0 to 120 seconds" },
    "app.marathon.badDiff": { ru: "OD и HP — от 0 до 10", en: "OD and HP must be from 0 to 10" },
    "app.marathon.defaultTitle": { ru: "Марафон", en: "Marathon" },
    "app.marathon.not4k": { ru: "«{name}» — не 4K osu!mania", en: "“{name}” isn't 4K osu!mania" },
    "app.marathon.noNotes": { ru: "в карте «{title}» нет нот", en: "the map “{title}” has no notes" },
    // background subtitle: "4K марафон · 5 карт · 12:34 · Beta mid → Delta low"; the count picks one of these with plural()
    "app.marathon.kind": { ru: "4K марафон", en: "4K marathon" },
    "app.marathon.maps.one": { ru: "{n} карта", en: "{n} map" },
    "app.marathon.maps.few": { ru: "{n} карты", en: "{n} maps" },
    "app.marathon.maps.many": { ru: "{n} карт", en: "{n} maps" },

    // recommendations ("Подбор" / "Picks")
    "app.rec.notLoggedIn": { ru: "открой osu! и войди в аккаунт — или впиши ник вручную", en: "open osu! and log in — or type a username yourself" },
    "app.rec.noOsuFile": { ru: "не удалось скачать .osu карты", en: "couldn't download the map's .osu" },
    "app.rec.unknownError": { ru: "что-то пошло не так", en: "something went wrong" },
    "app.rec.noDownloader": { ru: "нет загрузчика", en: "no downloader" },
    "app.rec.needPlayer": { ru: "впиши ник или id игрока на osu!", en: "type an osu! username or player id" },
    "app.rec.choosePattern": { ru: "выбери паттерн", en: "pick a pattern" },
    "app.rec.chooseGoal": { ru: "выбери цель", en: "pick a goal" },
    "app.rec.chooseLength": { ru: "выбери длину карт", en: "pick a map length" },
    "app.rec.chooseDan": { ru: "выбери дан — от 1 дана до Kappa", en: "pick a dan — from Dan 1 to Kappa" },
    "app.rec.fitFailed": { ru: "не удалось подобрать рейт", en: "couldn't find a rate" },
    "app.rec.noMapData": { ru: "нет данных об этой карте", en: "no data about this map" },
    "app.rec.cantOpen": { ru: "не получилось открыть эту карту", en: "couldn't open this map" },
    "app.rec.directFailed": { ru: "не удалось открыть карту в osu! — он установлен?", en: "couldn't open the map in osu! — is it installed?" },
    "app.rec.pageFailed": { ru: "не удалось открыть страницу карты", en: "couldn't open the map's page" },
    "app.rec.notOpened": {
        ru: "скачано, но osu! не открыл файл — открой его сам («Показать файл»)",
        en: "downloaded, but osu! didn't open the file — open it yourself (“Show file”)",
    },

    // >>> shared v2: texts more than one tab uses (a cancelled background analysis, the player profile)
    "app.shared.cancelled": { ru: "Отменено", en: "Cancelled" },
    "app.shared.profileFailed": { ru: "Профиль не загрузился: {message}", en: "Couldn't load the profile: {message}" },
    // <<< shared v2

    // >>> mapgen-P: the create tab's main-process checks (generate-map, detect-timing, the stubbed channels)
    "app.gen.badRequest": { ru: "Неверный запрос: {what}", en: "Bad request: {what}" },
    "app.gen.unknownId": { ru: "Эта карта уже забыта — создай её заново", en: "This map is no longer in memory — generate it again" },
    "app.gen.timingChanged": {
        ru: "Тайминг или части песни изменились — закреплённые части к этой карте не подходят",
        en: "The timing or the song parts changed — the locked parts don't fit this map",
    },
    "app.gen.timingFailed": { ru: "Не удалось определить тайминг", en: "Couldn't detect the timing" },
    "app.notReady": { ru: "В этой версии ещё не готово", en: "Not available in this build yet" },
    // <<< mapgen-P

    // >>> mapgen-C: export, song tags and remap (stream C)
    "app.export.mixedSongs": { ru: "В один набор можно сохранить только сложности одной песни", en: "A mapset can only hold difficulties of one song" },
    "app.export.badImage": { ru: "Фон — только .jpg или .png до 15 МБ", en: "Background must be a .jpg or .png up to 15 MB" },
    "app.export.badRate": { ru: "Рейт — от 0.5 до 2, не 1", en: "Rate must be 0.5–2 and not 1" },
    "app.export.setKind": { ru: "4K набор сложностей", en: "4K mapset" },
    "app.remap.unknownMap": { ru: "Сначала выбери карту", en: "Pick a map first" },
    "app.remap.needOsu": { ru: "Нужен файл .osu", en: "This needs an .osu file" },
    "app.remap.notRice": { ru: "Переделка работает только для рисовых 4K-карт", en: "Remapping works only for 4K rice maps" },
    // the remap changed nothing (src/gen/remap.js gave back the original): no file is written
    "app.remap.unchanged": { ru: "Ближе к этому дану карту не сделать, файл не создан", en: "The map can't get closer to that dan, so no file was written" },
    // …and with «Можно миниджеки и анкоры» it would have got there, or much closer
    "app.remap.unchangedNoJacks": {
        ru: "Без новых миниджеков и анкоров до этого дана не дойти, файл не создан. Попробуй с «Можно миниджеки и анкоры»",
        en: "This dan can't be reached without new minijacks and anchors, so no file was written. Try turning on “Allow minijacks and anchors”",
    },
    // <<< mapgen-C
};
