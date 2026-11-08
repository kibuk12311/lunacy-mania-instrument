// Etterna texts (app/etternaClient.js, app/etternaIpc.js, app/renderer/etternaPanel.js): key → { ru, en }.
export default {
    // main process
    "app.etterna.pickTitle": { ru: "Папка Etterna (где Songs и Program)", en: "Etterna folder (with Songs and Program)" },
    "app.etterna.notFolder": {
        ru: "Это не папка Etterna: в ней нет Songs. Выбери папку, где лежат Songs и Program.",
        en: "This isn't an Etterna folder: there's no Songs in it. Pick the folder with Songs and Program.",
    },
    "app.etterna.notFound": {
        ru: "Etterna не нашлась в обычных местах (C:\\Games, Program Files). Выбери папку вручную.",
        en: "Etterna wasn't found in the usual places (C:\\Games, Program Files). Pick the folder yourself.",
    },
    "app.etterna.folderGone": { ru: "Папки Etterna больше нет или в ней нет Songs: {folder}", en: "The Etterna folder is gone or has no Songs: {folder}" },
    "app.etterna.off": { ru: "Etterna выключена (⚙ Настройки → Etterna).", en: "Etterna is turned off (⚙ Settings → Etterna)." },
    "app.etterna.noChart": { ru: "Этой карты нет в библиотеке Etterna.", en: "This chart isn't in Etterna's library." },
    "app.etterna.notRated": { ru: "Эту карту не получилось перевести: {reason}", en: "This chart couldn't be converted: {reason}" },
    // the block in ⚙ Settings (app/renderer/etternaPanel.js)
    "etterna.panel.enable": { ru: "Включить Etterna", en: "Enable Etterna" },
    "etterna.panel.enableTitle": {
        ru: "Сними галочку, и программа будет вести себя так, будто Etterna не подключена. Папка запомнится, и при включении карты не придётся читать заново.",
        en: "Untick it and the app acts as if Etterna weren't linked. The folder is kept, so turning it on again doesn't read the charts anew.",
    },
    "etterna.panel.pick": { ru: "Выбрать папку…", en: "Pick folder…" },
    "etterna.panel.detect": { ru: "Найти", en: "Find" },
    "etterna.panel.unlink": { ru: "Отвязать", en: "Unlink" },
    "etterna.panel.notLinked": { ru: "Укажи папку Etterna (где Songs и Program)", en: "Point to your Etterna folder (the one with Songs and Program)" },
    "etterna.panel.linked": { ru: "Etterna подключена, карт: {n}", en: "Etterna is linked, charts: {n}" },
    "etterna.panel.scanning": { ru: "Читаю карты: {done} из {total}", en: "Reading charts: {done} of {total}" },
    "etterna.panel.searchPlaceholder": { ru: "Пак, песня, автор, сложность", en: "Pack, song, artist, difficulty" },
    "etterna.panel.rate": { ru: "Скорость", en: "Rate" },
    "etterna.panel.rateTitle": { ru: "Дан и MSD на этой скорости. MSD у Etterna есть только для шагов 0.1.", en: "The dan and MSD at this rate. Etterna has MSD only for 0.1 steps." },
    "etterna.panel.count": { ru: "Найдено: {n}", en: "Found: {n}" },
    "etterna.panel.countMore": { ru: "Показаны первые {n}, уточни поиск", en: "The first {n} are shown, narrow the search" },
    "etterna.panel.msd": { ru: "MSD {value}", en: "MSD {value}" },
    "etterna.panel.danPending": { ru: "дан…", en: "dan…" },
    "etterna.panel.notRated": { ru: "не считается: {reason}", en: "not rated: {reason}" },
    "etterna.panel.offNote": { ru: "Etterna выключена: её карт нет в программе. Папка запомнена.", en: "Etterna is turned off: its charts aren't in the app. The folder is kept." },
    "etterna.panel.offNoteNoFolder": { ru: "Etterna выключена.", en: "Etterna is turned off." },
    "etterna.panel.note": {
        ru: "Карты читаются из папки Etterna, в саму игру программа ничего не пишет. Дан — второе число рядом с MSD самой Etterna. Нажми на карту, чтобы открыть её на карточке.",
        en: "Charts are read from the Etterna folder; the app writes nothing into the game. The dan is a second number next to Etterna's own MSD. Click a chart to open it on the card.",
    },
    "etterna.panel.working": { ru: "Секунду…", en: "One moment…" },
    "etterna.panel.failed": { ru: "Не получилось: {message}", en: "Didn't work: {message}" },
    "etterna.panel.selected": { ru: "На карточке: {name}", en: "On the card: {name}" },
};
