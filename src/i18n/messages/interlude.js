// Interlude texts (app/interludeClient.js, app/interludeIpc.js, app/renderer/interlude*.js): key → { ru, en }.
export default {
    // main process
    "app.interlude.pickTitle": { ru: "Папка Interlude (где Interlude.exe, Songs и Data)", en: "Interlude folder (with Interlude.exe, Songs and Data)" },
    "app.interlude.notFolder": {
        ru: "Это не папка Interlude: в ней нет Songs\\charts.db. Выбери папку, где лежат Interlude.exe, Songs и Data.",
        en: "This isn't an Interlude folder: there's no Songs\\charts.db in it. Pick the folder with Interlude.exe, Songs and Data.",
    },
    "app.interlude.notFound": {
        ru: "Interlude не нашёлся в обычных местах (Рабочий стол, Загрузки, Документы, Games). Выбери папку вручную.",
        en: "Interlude wasn't found in the usual places (Desktop, Downloads, Documents, Games). Pick the folder yourself.",
    },
    "app.interlude.folderGone": { ru: "Папки Interlude больше нет или в ней нет Songs\\charts.db: {folder}", en: "The Interlude folder is gone or has no Songs\\charts.db: {folder}" },
    "app.interlude.dbFailed": { ru: "Не удалось прочитать библиотеку Interlude: {message}", en: "Couldn't read Interlude's library: {message}" },
    "app.interlude.noFolder": { ru: "Сначала выбери папку Interlude (кнопка IL внизу карточки).", en: "Pick the Interlude folder first (the IL button under the card)." },
    "app.interlude.noChart": { ru: "Этой карты нет в библиотеке Interlude.", en: "This chart isn't in Interlude's library." },
    "app.interlude.badFile": { ru: "Это не карта, которую можно отправить в Interlude.", en: "This isn't a map that can be sent to Interlude." },
    "app.interlude.sent": {
        ru: "{file} показан в Проводнике, Interlude выведен вперёд — перетащи файл в окно Interlude, и он импортирует карту.",
        en: "{file} is shown in Explorer and Interlude is brought to the front — drag the file onto Interlude's window and it imports the map.",
    },
    "app.interlude.sentStarted": {
        ru: "{file} показан в Проводнике, Interlude запускается — когда откроется, перетащи файл в его окно, и он импортирует карту.",
        en: "{file} is shown in Explorer and Interlude is starting — once it's open, drag the file onto its window and it imports the map.",
    },
    "app.interlude.sentNoGame": {
        ru: "{file} показан в Проводнике. Запусти Interlude и перетащи файл в его окно — так он импортирует карту.",
        en: "{file} is shown in Explorer. Start Interlude and drag the file onto its window — that's how it imports maps.",
    },
    "app.interlude.closeFirst": {
        ru: "Закрой Interlude: пока он запущен, он перезапишет collections.json при выходе. Потом нажми ещё раз.",
        en: "Close Interlude first: while it runs, it overwrites collections.json when it exits. Then press again.",
    },
    "app.interlude.badCollections": {
        ru: "Data\\collections.json не читается ({message}) — ничего не записано.",
        en: "Data\\collections.json can't be read ({message}) — nothing was written.",
    },
    "app.interlude.nothingToExport": { ru: "Список пуст — нечего добавлять.", en: "The list is empty — nothing to add." },
    "app.interlude.noneInLibrary": {
        ru: "Ни одной из этих карт ещё нет в библиотеке Interlude — сначала импортируй их (перетащи .osz в окно Interlude).",
        en: "None of these maps are in your Interlude library yet — import them first (drag their .osz onto Interlude's window).",
    },

    // the window: buttons in the tabs
    "interlude.working": { ru: "…", en: "…" },
    "interlude.failed": { ru: "Не вышло: {message}", en: "Didn't work: {message}" },
    "interlude.send": { ru: "→ Interlude", en: "→ Interlude" },
    "interlude.sendTitle": {
        ru: "Собрать .osz для Interlude, показать его в Проводнике и вывести Interlude вперёд (файл нужно перетащить в его окно)",
        en: "Make an .osz for Interlude, show it in Explorer and bring Interlude to the front (drag the file onto its window)",
    },
    "interlude.export": { ru: "Плейлист в Interlude", en: "Playlist in Interlude" },
    "interlude.exportTitle": {
        ru: "Добавить карты по порядку (со своими рейтами) плейлистом в Data\\collections.json Interlude. Interlude должен быть закрыт; старый файл сохраняется копией.",
        en: "Add the maps in order (with their rates) as a playlist to Interlude's Data\\collections.json. Interlude must be closed; the old file is kept as a copy.",
    },
    "interlude.export.done": { ru: "Плейлист «{name}» добавлен в Interlude, карт: {n}.", en: "Playlist \"{name}\" added to Interlude, charts: {n}." },
    "interlude.export.missing": {
        ru: "Нет в библиотеке Interlude ({n}) — сначала импортируй их: {list}",
        en: "Not in your Interlude library yet ({n}) — import them first: {list}",
    },
    "interlude.export.planName": { ru: "План Lunacy mania", en: "Lunacy mania plan" },

    // the window: the IL panel under the card
    "interlude.html.toggleTitle": { ru: "Interlude: папка и библиотека", en: "Interlude: folder and library" },
    "interlude.badge.title": { ru: "Interlude: папка и библиотека", en: "Interlude: folder and library" },
    "interlude.badge.linkedTitle": { ru: "Папка Interlude подключена: {folder}", en: "Interlude folder linked: {folder}" },
    "interlude.badge.chart": { ru: "Interlude", en: "Interlude" },
    "interlude.badge.chartTitle": { ru: "На карточке карта из библиотеки Interlude: {name}", en: "The card shows a chart from Interlude's library: {name}" },
    "interlude.panel.heading": { ru: "Interlude", en: "Interlude" },
    "interlude.panel.notLinked": { ru: "Папка Interlude не выбрана", en: "No Interlude folder linked" },
    "interlude.panel.linked": { ru: "Папка Interlude подключена · карт в библиотеке: {n}", en: "Interlude folder linked · {n} charts in the library" },
    "interlude.panel.linkedNoCount": { ru: "Папка Interlude подключена", en: "Interlude folder linked" },
    "interlude.panel.pick": { ru: "Выбрать папку…", en: "Pick folder…" },
    "interlude.panel.detect": { ru: "Найти", en: "Find" },
    "interlude.panel.unlink": { ru: "Отвязать", en: "Unlink" },
    "interlude.panel.searchPlaceholder": { ru: "Поиск: исполнитель, название, сложность", en: "Search: artist, title, difficulty" },
    "interlude.panel.count": { ru: "4K карт: {n}", en: "4K charts: {n}" },
    "interlude.panel.countMore": { ru: "Показаны {n} из {total} — уточни поиск", en: "Showing {n} of {total} — narrow the search" },
    "interlude.panel.loading": { ru: "Читаю карту…", en: "Reading the chart…" },
    "interlude.panel.selected": { ru: "На карточке: {name}", en: "On the card: {name}" },
    "interlude.panel.selectedNoAudio": {
        ru: "На карточке: {name} (аудио не найдено — анализ работает, рейт-копии нет)",
        en: "On the card: {name} (no audio found — analysis works, rate copies don't)",
    },
    "interlude.panel.note": {
        ru: "Пока «Следить за Interlude» включено, карточка сама показывает карту, выбранную в игре (с её рейтом), а оверлей — игру в Interlude. Здесь можно выбрать любую карту библиотеки вручную.",
        en: "While \"Follow Interlude live\" is on, the card shows the chart selected in the game (at its rate) and the overlay shows plays in Interlude. Here you can pick any chart of the library by hand.",
    },
    "interlude.panel.live": { ru: "Следить за Interlude вживую", en: "Follow Interlude live" },
    "interlude.panel.liveTitle": {
        ru: "Маленький помощник (interlude-reader.exe) только читает память запущенного Interlude: что выбрано, рейт, моды и счёт игры. Ничего не пишет и не внедряет.",
        en: "A small helper (interlude-reader.exe) only reads the memory of the running Interlude: the selection, rate, mods and the play's score. It never writes or injects anything.",
    },
    "interlude.panel.allowDownload": { ru: "Скачать служебный файл .NET, если его нет", en: "Download .NET's helper file if it's missing" },
    "interlude.panel.allowDownloadTitle": {
        ru: "Один раз скачать mscordaccore.dll с сервера символов Microsoft (msdl.microsoft.com), если подходящего нет в комплекте. Файл сохраняется, дальше всё работает без сети.",
        en: "Download mscordaccore.dll once from Microsoft's symbol server (msdl.microsoft.com) if no matching one is bundled. It is kept, after that everything works offline.",
    },
    "interlude.badge.live": { ru: "Interlude · live", en: "Interlude · live" },
    "interlude.badge.liveTitle": { ru: "Карточка и оверлей следят за Interlude. {text}", en: "The card and the overlay follow Interlude. {text}" },

    // the live reader's state (app/interludeLive.js)
    "app.interlude.live.off": { ru: "Слежение за Interlude выключено.", en: "Following Interlude is off." },
    "app.interlude.live.starting": { ru: "Запускаю чтение Interlude…", en: "Starting to read Interlude…" },
    "app.interlude.live.waiting": { ru: "Interlude не запущен — жду его.", en: "Interlude isn't running — waiting for it." },
    "app.interlude.live.attached": { ru: "Interlude {version} подключён, карточка следит за выбором.", en: "Interlude {version} attached, the card follows the selection." },
    "app.interlude.live.missing": {
        ru: "Нет interlude-reader.exe рядом с приложением (антивирус убрал? переустанови или добавь папку в исключения).",
        en: "interlude-reader.exe is missing next to the app (removed by an antivirus? reinstall, or add the folder to its exclusions).",
    },
    "app.interlude.live.crashed": { ru: "Чтение Interlude упало, перезапуск через {s} с.", en: "Reading Interlude crashed, restarting in {s} s." },
    "app.interlude.live.fieldNotFound": {
        ru: "Interlude обновился? Сканер не нашёл часть данных ({reason}). Остальное работает; нужна новая версия приложения.",
        en: "Did Interlude update? The scanner didn't find part of its data ({reason}). The rest works; a new version of the app is needed.",
    },
    "app.interlude.live.dacNotFound": {
        ru: "Нет служебного файла .NET (mscordaccore.dll) для этой версии Interlude.",
        en: "No .NET helper file (mscordaccore.dll) for this Interlude version.",
    },
    "app.interlude.live.dacHint": {
        ru: "Включи «Скачать служебный файл .NET, если его нет» в панели IL — он скачается один раз с сервера Microsoft.",
        en: "Turn on \"Download .NET's helper file if it's missing\" in the IL panel — it is downloaded once from Microsoft's server.",
    },
    "app.interlude.live.attachFailed": {
        ru: "Нет доступа к процессу Interlude ({reason}). Interlude запущен от администратора? Запусти его обычным образом (или приложение тоже от администратора).",
        en: "No access to Interlude's process ({reason}). Is Interlude running as administrator? Start it normally (or the app as administrator too).",
    },
    "app.interlude.live.readFailed": { ru: "Interlude читается с ошибками ({reason}), пробую дальше.", en: "Reading Interlude keeps failing ({reason}), still trying." },
    "app.interlude.live.otherError": { ru: "Не получается читать Interlude: {code} {reason}", en: "Can't read Interlude: {code} {reason}" },
    "app.interlude.live.notInLibrary": {
        ru: "Этой карты нет в подключённой библиотеке Interlude (или она только что импортирована и ещё не записана) — дан посчитать не из чего.",
        en: "This chart isn't in the linked Interlude library (or it was just imported and isn't saved yet) — there's nothing to work out a dan from.",
    },
    "app.interlude.live.noFolderNote": {
        ru: "Подключи папку Interlude (кнопка IL внизу), чтобы карточка считала дан выбранной в нём карты.",
        en: "Link the Interlude folder (the IL button below) so the card can work out the dan of the chart selected in it.",
    },
};
