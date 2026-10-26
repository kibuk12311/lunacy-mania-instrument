// "settings" texts: key → { ru, en }. The Settings page (app/renderer/settingsPage.js, its frame in index.html) and its
// main side (app/settingsIpc.js).
export default {
    // the frame: the ⚙ under the card, the page's head and its sections (index.html)
    "settings.html.openTitle": { ru: "Настройки", en: "Settings" },
    "settings.html.back": { ru: "← Назад", en: "← Back" },
    "settings.html.title": { ru: "Настройки", en: "Settings" },
    "settings.html.analysis": { ru: "Анализ", en: "Analysis" },
    "settings.html.calc": { ru: "Калькулятор на карточке", en: "Calculator on the card" },
    "settings.html.window": { ru: "Окно и язык", en: "Window and language" },
    "settings.html.lang": { ru: "Язык / Language", en: "Language" },
    "settings.html.pin": { ru: "📌 Поверх всех окон", en: "📌 Always on top" },

    // the IL button under the card (only with a linked Interlude folder): the library on this page
    "settings.il.openTitle": { ru: "Interlude: папка и библиотека (в настройках)", en: "Interlude: folder and library (in Settings)" },

    // profile
    "settings.profile.title": { ru: "Профиль", en: "Profile" },
    "settings.profile.source": { ru: "Чей скилл берут «Подбор», план, авто-марафон, «Для тебя» и оверлей", en: "Whose skill Picks, the plan, the auto-marathon, “For you” and the overlay use" },
    "settings.profile.trackerNote": { ru: "Ник mania-tracker вводится во вкладке «Подбор».", en: "The mania-tracker name is typed in on the Picks tab." },
    "settings.profile.record": { ru: "Записывать мои игры (Мой профиль)", en: "Record my plays (My profile)" },
    "settings.profile.open": { ru: "Открыть «Профиль»", en: "Open Profile" },

    // folders
    "settings.folders.title": { ru: "Папки", en: "Folders" },
    "settings.folders.docs": { ru: "Что делает программа (карты, марафоны, скины, скачанное)", en: "What the app makes (maps, marathons, skins, downloads)" },
    "settings.folders.open": { ru: "Открыть", en: "Open" },
    "settings.folders.songs": { ru: "Папка Songs для «Сессии»", en: "Songs folder for Session" },
    "settings.folders.songsAuto": { ru: "как скажет osu! (tosu)", en: "as osu! says (tosu)" },
    "settings.folders.pickSongs": { ru: "Выбрать…", en: "Pick…" },
    "settings.folders.osu": { ru: "Импорт старых игр из osu! stable (Мой профиль)", en: "Import old plays from osu! stable (My profile)" },
    "settings.folders.pickOsu": { ru: "Выбрать папку osu! и импортировать…", en: "Pick the osu! folder and import…" },
    "settings.folders.importing": { ru: "Импорт идёт — ход виден во вкладке «Профиль».", en: "Importing — its progress is on the Profile tab." },
    "settings.folders.skinsNote": { ru: "Скины osu! берутся из папки, где osu! (tosu), иначе %LOCALAPPDATA%\\osu!\\Skins.", en: "osu! skins come from where osu! is (tosu), else %LOCALAPPDATA%\\osu!\\Skins." },

    // updates
    "settings.updates.title": { ru: "Обновления", en: "Updates" },
    "settings.updates.version": { ru: "Версия {version}", en: "Version {version}" },
    "settings.updates.auto": { ru: "Проверять обновления автоматически", en: "Check for updates automatically" },
    "settings.updates.check": { ru: "Проверить сейчас", en: "Check now" },
    "settings.updates.checking": { ru: "проверяем…", en: "checking…" },
    "settings.updates.result.latest": { ru: "Это последняя версия.", en: "This is the latest version." },
    "settings.updates.result.dev": { ru: "Запуск из исходников: обновлений нет.", en: "Run from source: no updates." },
    "settings.updates.result.checking": { ru: "Проверка уже идёт.", en: "A check is already running." },
    "settings.updates.result.downloading": { ru: "Новая версия скачивается.", en: "A new version is downloading." },
    "settings.updates.result.ready": { ru: "Новая версия скачана — перезапусти программу.", en: "A new version is downloaded — restart the app." },
    "settings.updates.result.available": { ru: "Есть новая версия — открыта страница загрузки.", en: "A new version is out — the download page is open." },
    "settings.updates.result.error": { ru: "Не удалось проверить обновления.", en: "Couldn't check for updates." },

    // osu! and tosu
    "settings.osu.title": { ru: "osu! и tosu", en: "osu! and tosu" },
    "settings.osu.client": { ru: "Сейчас: {client}", en: "Now: {client}" },
    "settings.osu.none": { ru: "osu! не найдена (tosu ждёт игру)", en: "no osu! (tosu waits for the game)" },
    "settings.osu.port": { ru: "tosu на порту {port} (встроен, запускается сам)", en: "tosu on port {port} (bundled, starts by itself)" },

    // caches
    "settings.cache.title": { ru: "Кэш", en: "Caches" },
    "settings.cache.results": { ru: "Даны карт (результаты анализа)", en: "Map dans (analysis results)" },
    "settings.cache.session": { ru: "Библиотека «Сессии» (список карт и их анализ)", en: "Session library (the map list and its analysis)" },
    "settings.cache.modelStyles": { ru: "Стили мапперов моделей (вкладка «Создать»)", en: "Model mapper styles (Create tab)" },
    "settings.cache.clear": { ru: "Очистить", en: "Clear" },
    "settings.cache.sure": { ru: "Точно очистить?", en: "Clear it?" },
    "settings.cache.yes": { ru: "Да", en: "Yes" },
    "settings.cache.no": { ru: "Нет", en: "No" },
    "settings.cache.done": { ru: "Очищено — посчитается заново, когда понадобится.", en: "Cleared — worked out again when needed." },
    "settings.cache.busy": { ru: "Сейчас идёт сканирование — очисти, когда оно закончится.", en: "A scan is running — clear it when it is done." },
    "settings.cache.failed": { ru: "Не вышло: {message}", en: "Didn't work: {message}" },

    // about
    "settings.about.title": { ru: "О программе", en: "About" },
    "settings.about.name": { ru: "Lunacy mania {version} — дан-калькулятор, рейты, марафоны, подбор карт и генератор для osu!mania 4K", en: "Lunacy mania {version} — a dan calculator, rates, marathons, map picks and a map generator for osu!mania 4K" },
    "settings.about.github": { ru: "GitHub", en: "GitHub" },
    "settings.about.releases": { ru: "Все версии", en: "Releases" },
    "settings.about.license": { ru: "Лицензия MIT", en: "MIT license" },
    "settings.about.notices": { ru: "Сторонние программы и лицензии", en: "Third-party notices" },
    "settings.about.author": { ru: "Автор: Sneezey · Discord: {discord}", en: "Made by Sneezey · Discord: {discord}" },
    "settings.about.authorPrefix": { ru: "Автор: Sneezey · Discord:", en: "Made by Sneezey · Discord:" },
    "settings.about.copyTitle": { ru: "Скопировать ник в Discord", en: "Copy the Discord name" },
    "settings.about.copied": { ru: "скопировано", en: "copied" },

    // main's answers
    "settings.err.request": { ru: "Непонятный запрос", en: "Unknown request" },
};
