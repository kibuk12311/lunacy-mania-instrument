// "recommend" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
export default {
    // catalog: patterns, goals, length filters
    "recommend.pattern.stream": { ru: "Стрим", en: "Stream" },
    "recommend.pattern.jumpstream": { ru: "Джампстрим", en: "Jumpstream" },
    "recommend.pattern.handstream": { ru: "Хендстрим", en: "Handstream" },
    "recommend.pattern.stamina": { ru: "Стамина", en: "Stamina" },
    "recommend.pattern.chordjack": { ru: "Чордджек", en: "Chordjack" },
    "recommend.pattern.jack": { ru: "Джек", en: "Jack" },
    "recommend.pattern.tech": { ru: "Тех", en: "Tech" },
    // the kinds offered in the Detailed mode (catalog.js REC_KINDS)
    "recommend.pattern.quadstream": { ru: "Квадстрим", en: "Quadstream" },
    "recommend.pattern.handjack": { ru: "Хендджек", en: "Handjack" },
    "recommend.pattern.speedjack": { ru: "Спидджек", en: "Speedjack" },
    "recommend.goal.comfort": { ru: "Комфорт", en: "Comfort" },
    "recommend.goal.comfortHint": { ru: "чуть ниже твоего уровня — набить точность", en: "a bit below your level — work on your accuracy" },
    "recommend.goal.growth": { ru: "Рост", en: "Growth" },
    "recommend.goal.growthHint": { ru: "то, что стоит играть сейчас", en: "what's worth playing right now" },
    "recommend.goal.challenge": { ru: "Челлендж", en: "Challenge" },
    "recommend.goal.challengeHint": { ru: "заметно выше — на пробу", en: "well above your level — give it a shot" },
    "recommend.goal.custom": { ru: "Свой диапазон", en: "Custom range" },
    "recommend.goal.customHint": { ru: "любые даны — «от» и «до» выбираешь сам", en: "any dans — you pick where it starts and ends" },
    "recommend.length.any": { ru: "любая", en: "any" },
    "recommend.length.short": { ru: "до 2:30", en: "up to 2:30" },
    "recommend.length.medium": { ru: "2–4 мин", en: "2–4 min" },
    "recommend.length.long": { ru: "от 4 мин", en: "4+ min" },

    // skill source chips
    "recommend.source.tracker": { ru: "С mania-tracker", en: "From mania-tracker" },
    "recommend.source.manual": { ru: "Вручную", en: "Manual" },

    // the hand-set profile (manual source): no mania-tracker account needed
    "recommend.html.manualIntro": {
        ru: "Нет mania-tracker? Укажи свой уровень по навыкам — подбор, план, авто-марафон и «Для тебя» в анализе возьмут его как профиль.",
        en: "No mania-tracker? Set your level per skill — Picks, the plan, the auto-marathon and “For you” in the analysis use it as your profile.",
    },
    "recommend.manual.axis.speed": { ru: "стрим", en: "stream" },
    "recommend.manual.axis.jack": { ru: "джеки, чордджеки", en: "jacks, chordjacks" },
    "recommend.manual.axis.stamina": { ru: "джампстрим, хендстрим, стамина", en: "jumpstream, handstream, stamina" },
    "recommend.manual.axis.tech": { ru: "тех", en: "tech" },
    "recommend.html.manualName": { ru: "имя (необязательно)", en: "name (optional)" },
    "recommend.html.manualCopy": { ru: "Взять из mania-tracker", en: "Copy from mania-tracker" },
    "recommend.manual.copyTitle": {
        ru: "Подставить даны загруженного профиля mania-tracker — дальше можно поправить",
        en: "Fill in the dans of the loaded mania-tracker profile — then adjust them",
    },
    "recommend.manual.copyNone": {
        ru: "Сначала загрузи ник в «С mania-tracker» — тогда его даны можно взять за основу",
        en: "Load your nick under “From mania-tracker” first — then its dans can be your starting point",
    },
    "recommend.manual.copied": { ru: "Даны взяты из профиля {name} — поправь, если нужно", en: "Took the dans from {name}'s profile — adjust them if you like" },
    "recommend.manual.defaultName": { ru: "Мой профиль", en: "My profile" },
    "recommend.manual.tag": { ru: "вручную", en: "set by hand" },
    "recommend.manual.overallNote": {
        ru: "общий дан — среднее Speed, Jack, Stamina и Tech, как у mania-tracker",
        en: "the overall dan is the mean of Speed, Jack, Stamina and Tech, as on mania-tracker",
    },
    "recommend.manual.noPlays": {
        ru: "Сыгранные карты знают mania-tracker и Interlude — загрузи ник или привяжи папку Interlude (кнопка IL), чтобы их скрывать",
        en: "mania-tracker and Interlude know the maps you've played — load your nick or link your Interlude folder (the IL button) to hide them",
    },
    "recommend.progress.needTracker": {
        ru: "Прогресс считает mania-tracker по твоим играм — у ручного профиля его нет. Загрузи ник в «С mania-tracker», чтобы его увидеть.",
        en: "Progress comes from your plays on mania-tracker — a hand-set profile has none. Load your nick under “From mania-tracker” to see it.",
    },

    // "N plays": Russian picks one of three forms, English one of two (one → "play", few and many → "plays")
    "recommend.play.one": { ru: "игра", en: "play" },
    "recommend.play.few": { ru: "игры", en: "plays" },
    "recommend.play.many": { ru: "игр", en: "plays" },

    // profile and target lines
    "recommend.skill.overall": { ru: "общий дан {label} ({dan})", en: "overall dan {label} ({dan})" },
    "recommend.target.yours": { ru: "Твой дан для паттерна «{pattern}»: {label} ({dan}) → ищем {lo}–{hi}", en: "Your dan for {pattern}: {label} ({dan}) → looking for {lo}–{hi}" },
    "recommend.target.manual": { ru: "Выбранный дан для паттерна «{pattern}»: {label} ({dan}) → ищем {lo}–{hi}", en: "Picked dan for {pattern}: {label} ({dan}) → looking for {lo}–{hi}" },
    "recommend.target.yoursRange": {
        ru: "Твой дан для паттерна «{pattern}»: {label} ({dan}) → свой диапазон {range}: ищем {lo}–{hi}",
        en: "Your dan for {pattern}: {label} ({dan}) → custom range {range}: looking for {lo}–{hi}",
    },
    "recommend.target.range": { ru: "Свой диапазон для паттерна «{pattern}»: {range} → ищем {lo}–{hi}", en: "Custom range for {pattern}: {range} → looking for {lo}–{hi}" },
    "recommend.target.overall": { ru: "{dan}, общий", en: "{dan}, overall" },

    // card lines
    "recommend.card.trackerDan": { ru: "{dan} на mania-tracker", en: "{dan} on mania-tracker" },
    "recommend.played": { ru: "сыграно", en: "played" },
    "recommend.played.acc": { ru: "сыграно {acc}%", en: "played {acc}%" },
    "recommend.played.accRate": { ru: "сыграно {acc}% на {rate}", en: "played {acc}% at {rate}" },
    "recommend.played.set": { ru: "другая сложность сета уже сыграна", en: "you've played another diff of this set" },

    // our analysis
    "recommend.ours.button": { ru: "Наш анализ", en: "Our analysis" },
    "recommend.ours.buttonTitle": { ru: "Посчитать дан нашим анализатором и подобрать рейт под цель", en: "Get the dan from our analyzer and find a rate for your target" },
    "recommend.ours.failed": { ru: "не получилось посчитать", en: "couldn't calculate it" },
    "recommend.ours.main": { ru: "Наш анализатор: {result}", en: "Our analyzer: {result}" },
    "recommend.ours.inTarget": { ru: "уже в цели", en: "already on target" },
    "recommend.ours.rate": { ru: "для цели — {rate}{label}{edge}", en: "for your target — {rate}{label}{edge}" },
    "recommend.ours.edge": { ru: "край диапазона", en: "edge of the range" },
    "recommend.ours.noRate": { ru: "рейт подобрать не удалось — попробуй ещё раз", en: "couldn't find a rate — try again" },

    // download
    "recommend.download.button": { ru: "Скачать", en: "Download" },
    "recommend.download.buttonTitle": { ru: "Скачать .osz и сразу открыть в osu! — supporter не нужен", en: "Download the .osz and open it in osu! right away — no supporter needed" },
    "recommend.download.progress": { ru: "Скачиваю…", en: "Downloading…" },
    "recommend.download.progressPct": { ru: "Скачиваю… {pct}%", en: "Downloading… {pct}%" },
    "recommend.download.progressMb": { ru: "Скачиваю… {mb} МБ", en: "Downloading… {mb} MB" },
    "recommend.download.done": { ru: "Скачано ✓", en: "Downloaded ✓" },
    "recommend.download.failed": { ru: "не удалось скачать", en: "couldn't download it" },
    "recommend.download.notOpened": { ru: "скачано, но osu! не открыл файл", en: "downloaded, but osu! didn't open the file" },
    "recommend.download.reused": { ru: "Карта уже скачана — открыто в osu! ещё раз", en: "You already have this map — opened it in osu! again" },
    "recommend.download.opened": { ru: "Открыто в osu! — карта появится после импорта", en: "Opened in osu! — the map shows up once it's imported" },
    "recommend.download.show": { ru: "Показать файл", en: "Show file" },
    "recommend.download.showTitle": { ru: "Открыть папку со скачанной картой", en: "Open the folder with the downloaded map" },

    // other card buttons
    "recommend.direct.title": { ru: "Открыть в osu! — если карты нет, osu!direct предложит скачать (нужен supporter)", en: "Open in osu! — if you don't have the map, osu!direct offers to download it (needs supporter)" },
    "recommend.page": { ru: "Страница", en: "Page" },
    "recommend.page.title": { ru: "Страница карты на osu.ppy.sh", en: "The map's page on osu.ppy.sh" },

    // status line
    "recommend.status.enterUser": { ru: "Впиши ник или id в osu!", en: "Enter your osu! name or id" },
    "recommend.status.loadingProfile": { ru: "Загружаю профиль…", en: "Loading your profile…" },
    "recommend.status.searching": { ru: "Ищу карты…", en: "Looking for maps…" },
    "recommend.status.nothingYet": { ru: "Пока ничего — нажми «Ещё», поищу дальше", en: "Nothing yet — press “More” and I'll keep looking" },
    "recommend.status.empty": { ru: "Ничего не нашлось — попробуй другую цель, длину или сними «только ranked / loved»", en: "Nothing found — try another goal or length, or untick “ranked / loved only”" },
    "recommend.status.playedPartial": { ru: "Часть сыгранных карт не загрузилась с mania-tracker — отметки «сыграно» могут быть неполными", en: "Some of your plays didn't load from mania-tracker — “played” marks may be incomplete" },
    "recommend.status.error": { ru: "Ошибка: {message}", en: "Error: {message}" },
    "recommend.status.noAnswer": { ru: "нет ответа", en: "no response" },
    "recommend.more": { ru: "Ещё", en: "More" },

    // ---- tabs v2: plan, similar, favourites, progress ----
    // mode chips
    "recommend.mode.picks": { ru: "Подбор", en: "Picks" },
    "recommend.mode.plan": { ru: "План", en: "Plan" },
    "recommend.mode.fav": { ru: "Избранное ({n})", en: "Favourites ({n})" },
    "recommend.mode.progress": { ru: "Прогресс", en: "Progress" },

    // markup of the new modes
    "recommend.html.planSize": { ru: "Карт", en: "Maps" },
    "recommend.html.planPatterns": { ru: "Паттерны — от 1 до 3, по очереди", en: "Patterns — 1 to 3, taking turns" },
    "recommend.html.planGo": { ru: "Составить план", en: "Build plan" },
    "recommend.html.planDownload": { ru: "Скачать всё", en: "Download all" },
    "recommend.html.planFav": { ru: "Всё в избранное", en: "All to favourites" },
    "recommend.html.planRates": { ru: "Рейты под план", en: "Rates for the plan" },
    "recommend.html.planRatesTitle": { ru: "Наш анализ и рейт под каждое место плана", en: "Our analysis and a rate for each spot of the plan" },
    "recommend.html.rangeFrom": { ru: "от", en: "from" },
    "recommend.html.rangeTo": { ru: "до", en: "to" },
    "recommend.html.favName": { ru: "Имя коллекции", en: "Collection name" },
    "recommend.html.favExport": { ru: "Экспорт в collection.db", en: "Export to collection.db" },
    "recommend.html.favHint": {
        ru: "Для osu!stable: добавь через Collection Manager (merge), не заменяй свой collection.db",
        en: "For osu!stable: merge it in with Collection Manager, don't overwrite your own collection.db",
    },
    "recommend.html.favHintLazer": {
        ru: "osu! lazer collection.db не читает: с lazer рядом сохранится список карт со ссылками",
        en: "osu! lazer doesn't read collection.db: with lazer a list of the maps with links is saved next to it",
    },
    "recommend.html.progressNote": { ru: "mania-tracker видит ~70 последних игр и топ-200 по каждой оси", en: "mania-tracker only sees the last ~70 plays and the top 200 per axis" },

    // favourites
    "recommend.fav.add": { ru: "В избранное", en: "Add to favourites" },
    "recommend.fav.in": { ru: "В избранном", en: "In favourites" },
    "recommend.fav.remove": { ru: "Убрать из избранного", en: "Remove from favourites" },
    "recommend.fav.empty": { ru: "Пока пусто — отмечай карты кнопкой ☆", en: "Nothing here yet — mark maps with ☆" },
    "recommend.fav.exporting": { ru: "Экспорт…", en: "Exporting…" },
    "recommend.fav.exportingN": { ru: "Экспорт… {done} / {total}", en: "Exporting… {done} / {total}" },
    "recommend.fav.done": { ru: "Готово: {n} {maps}", en: "Done: {n} {maps}" },
    "recommend.fav.doneSkipped": { ru: "Готово: {n} {maps}, пропущено {skipped}", en: "Done: {n} {maps}, {skipped} skipped" },
    "recommend.fav.lazerNote": {
        ru: "osu! lazer хранит коллекции в своей базе, collection.db в него не добавить — этот файл для osu! stable. Для lazer рядом сохранён список карт со ссылками ({list}): добавь их в коллекцию в самом lazer, недостающие скачай кнопкой «Скачать».",
        en: "osu! lazer keeps collections in its own database, so a collection.db can't be added to it — that file is for osu! stable. For lazer a list of the maps with links is saved next to it ({list}): add them to a collection in lazer itself, and get the ones you lack with the “Download” button.",
    },
    "recommend.fav.showTitle": { ru: "Открыть папку с collection.db", en: "Open the folder with collection.db" },

    // similar maps
    "recommend.similar.very": { ru: "очень похожа", en: "very similar" },
    "recommend.similar.close": { ru: "похожа", en: "similar" },
    "recommend.similar.loose": { ru: "отдалённо", en: "loosely" },
    "recommend.similar.button": { ru: "Похожие", en: "Similar" },
    "recommend.similar.buttonTitle": { ru: "Карты, похожие на эту", en: "Maps like this one" },
    "recommend.similar.title": { ru: "Похожие на эту", en: "More like this" },
    "recommend.similar.loading": { ru: "Ищу похожие…", en: "Looking for similar maps…" },
    "recommend.similar.failed": { ru: "не получилось найти похожие", en: "couldn't find similar maps" },
    "recommend.similar.none": { ru: "Похожих карт не нашлось", en: "No similar maps found" },

    // the plan
    "recommend.plan.map.one": { ru: "карта", en: "map" },
    "recommend.plan.map.few": { ru: "карты", en: "maps" },
    "recommend.plan.map.many": { ru: "карт", en: "maps" },
    "recommend.plan.header": { ru: "План: {who} ({dan}) · {n} {maps} · ≈ {time}", en: "Plan: {who} ({dan}) · {n} {maps} · ≈ {time}" },
    "recommend.plan.role.warmup": { ru: "Разминка", en: "Warm-up" },
    "recommend.plan.role.growth": { ru: "Рост", en: "Growth" },
    "recommend.plan.role.challenge": { ru: "Челлендж", en: "Challenge" },
    "recommend.plan.swap": { ru: "↻ Другая", en: "↻ Another" },
    "recommend.plan.swapTitle": { ru: "Другая карта на это место", en: "Another map for this spot" },
    "recommend.plan.emptySlot": { ru: "Для этого места карт не нашлось", en: "No maps found for this spot" },
    "recommend.plan.building": { ru: "Составляю план…", en: "Building the plan…" },
    "recommend.plan.nothing": { ru: "Ничего не нашлось — попробуй другие паттерны, длину или сними «только ranked / loved»", en: "Nothing found — try other patterns or length, or untick “ranked / loved only”" },
    "recommend.plan.someEmpty": { ru: "Не на все места нашлись карты", en: "Some spots have no maps" },
    "recommend.plan.noOther": { ru: "Других карт для этого места нет", en: "No other maps for this spot" },
    "recommend.plan.downloading": { ru: "Скачиваю {i} из {n}…", en: "Downloading {i} of {n}…" },
    "recommend.plan.downloaded": { ru: "Скачано {done} из {total}", en: "Downloaded {done} of {total}" },
    "recommend.plan.rating": { ru: "Считаю {i} из {n}…", en: "Working out {i} of {n}…" },
    "recommend.plan.favDone": { ru: "Добавлено в избранное: {n}", en: "Added to favourites: {n}" },

    // progress
    "recommend.progress.days": { ru: "{n} дн", en: "{n} days" },
    "recommend.progress.loading": { ru: "Загружаю игры с mania-tracker…", en: "Loading your plays from mania-tracker…" },
    "recommend.progress.summary": { ru: "Сыграно {played} из {total} подобранных", en: "Played {played} of {total} picks" },
    "recommend.progress.today": { ru: "сегодня", en: "today" },
    "recommend.progress.yesterday": { ru: "вчера", en: "yesterday" },
    "recommend.progress.daysAgo": { ru: "{n} дн. назад", en: "{n} days ago" },
    "recommend.progress.failed": { ru: "✗ не пройдена", en: "✗ failed" },
    "recommend.progress.notPlayed": { ru: "не сыграна", en: "not played yet" },
    "recommend.progress.try.one": { ru: "попытка", en: "try" },
    "recommend.progress.try.few": { ru: "попытки", en: "tries" },
    "recommend.progress.try.many": { ru: "попыток", en: "tries" },
    "recommend.progress.dan": { ru: "Дан: {from} → {to}{delta}", en: "Dan: {from} → {to}{delta}" },
    "recommend.progress.axisDan": { ru: "Дан", en: "Dan" },
    "recommend.progress.noChart": { ru: "За этот период mania-tracker не записал скилл", en: "mania-tracker recorded no skill for this period" },
    "recommend.progress.noPicks": { ru: "За этот период подборов нет — скачай или отметь карты во вкладке", en: "No picks in this period — download or mark maps in this tab" },
    "recommend.progress.partial": { ru: "Часть данных не загрузилась с mania-tracker — картина может быть неполной", en: "Some data didn't load from mania-tracker — the picture may be incomplete" },

    // main-process errors
    "recommend.err.badCollectionDb": { ru: "файл collection.db повреждён", en: "the collection.db file is broken" },
    "recommend.err.planSize": { ru: "в плане может быть 5 или 6 карт", en: "a plan has 5 or 6 maps" },
    "recommend.err.planPatterns": { ru: "выбери от 1 до 3 паттернов", en: "pick 1 to 3 patterns" },
    "recommend.err.noPlan": { ru: "сначала составь план", en: "build a plan first" },
    "recommend.err.badSlot": { ru: "нет такого места в плане", en: "there's no such spot in the plan" },
    "recommend.err.noSeed": { ru: "для этой карты нечего сравнивать — найди её заново", en: "nothing to compare this map by — find it again" },
    "recommend.err.favEmpty": { ru: "избранное пусто — сначала добавь карты кнопкой ☆", en: "your favourites are empty — add maps with ☆ first" },
    "recommend.err.exportNone": { ru: "ни одной карты не удалось скачать с osu.ppy.sh — проверь интернет", en: "couldn't fetch a single map from osu.ppy.sh — check your internet connection" },
    "recommend.err.badRange": { ru: "выбери диапазон данов — от 1 дана до Kappa", en: "pick a dan range — from Dan 1 to Kappa" },
    "recommend.err.badManualProfile": {
        ru: "ручной профиль не заполнен — выбери дан для Speed, Jack, Stamina и Tech во вкладке «Подбор»",
        en: "the hand-set profile is incomplete — pick a dan for Speed, Jack, Stamina and Tech on the Picks tab",
    },
    "recommend.err.badDays": { ru: "период — 7, 30 или 90 дней", en: "the period is 7, 30 or 90 days" },
};
