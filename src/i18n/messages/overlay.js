// "overlay" texts: key → { ru, en }. The in-game overlay: its tray items (app/overlay/overlayManager.js), the panel in the
// main window (app/renderer/overlayPanel.js),
// the settings window (app/overlay/settings.*) and the widgets (app/overlay/widget.*, app/overlay/render.js).
export default {
    // tray: the «Оверлей» submenu
    "overlay.tray.menu": { ru: "Оверлей", en: "Overlay" },
    "overlay.tray.enabled": { ru: "Показывать во время игры", en: "Show while playing" },
    "overlay.tray.edit": { ru: "Двигать окошки ({hotkey})", en: "Move the widgets ({hotkey})" },
    "overlay.tray.settings": { ru: "Настройки оверлея…", en: "Overlay settings…" },

    // the main window: the OV button in the footer and its panel (app/renderer/overlayPanel.js)
    "overlay.main.enabled": { ru: "Показывать во время игры", en: "Show while playing" },
    "overlay.main.move": { ru: "Двигать окна ({hotkey})", en: "Move windows ({hotkey})" },
    "overlay.main.moveDone": { ru: "Готово, закрепить", en: "Done, lock them" },
    "overlay.main.settings": { ru: "Все настройки…", en: "All settings…" },

    // the settings window
    "overlay.window.title": { ru: "Оверлей — Lunacy mania", en: "Overlay — Lunacy mania" },
    "overlay.set.heading": { ru: "Оверлей в игре", en: "In-game overlay" },
    "overlay.set.enabled": { ru: "Показывать оверлей во время игры", en: "Show the overlay while playing" },
    "overlay.set.showOnResults": { ru: "И на экране результатов", en: "Also on the results screen" },
    "overlay.set.edit": { ru: "Двигать и менять размер", en: "Move and resize" },
    "overlay.set.editDone": { ru: "Готово, закрепить", en: "Done, lock them" },
    "overlay.set.hint": {
        ru: "Это отдельные окошки поверх игры, в osu! ничего не встраивается. osu! должен быть в оконном или безрамочном режиме (в lazer — «Borderless» или «Windowed»): поверх полноэкранной игры их не видно. Во время игры клики проходят сквозь них. {hotkey} — включить или выключить перемещение: тащи окошко мышью, уголок справа внизу меняет размер.",
        en: "These are separate windows over the game, nothing is injected into osu!. osu! must be in windowed or borderless mode (in lazer, “Borderless” or “Windowed”): they can't be seen over a fullscreen game. While you play, clicks go through them. {hotkey} turns moving on or off: drag a widget with the mouse, its bottom-right corner resizes it.",
    },
    "overlay.set.keysNote": {
        ru: "В mania osu! stable не отдаёт нажатия клавиш, поэтому линии строятся по попаданиям и нотам карты. osu! lazer отдаёт счётчики клавиш — тогда берутся настоящие нажатия.",
        en: "In mania osu! stable doesn't report key presses, so the lines are rebuilt from the judgements and the map's notes. osu! lazer does report its key counters — then the real presses are used.",
    },
    "overlay.set.npsNote": {
        ru: "NPS — плотность самой карты (ноты в секунду), не твоих нажатий: сколько нот сейчас под позицией игры, пик карты и график всей карты с бегунком. Лонг считается одной нотой. С DT, HT и рейтами — в реальном времени.",
        en: "NPS is the density of the map itself (notes per second), not of your presses: the notes at the play position now, the map's peak and a graph of the whole map with a playhead. A hold note counts once. With DT, HT and rate copies it is in real time.",
    },
    "overlay.set.show": { ru: "Показывать это окошко", en: "Show this widget" },
    "overlay.set.style": { ru: "Стиль", en: "Style" },
    "overlay.set.opacity": { ru: "Видимость", en: "Opacity" },
    "overlay.set.scale": { ru: "Размер", en: "Size" },
    "overlay.set.styles": { ru: "Все стили (пример с выдуманными числами)", en: "All styles (a sample with made-up numbers)" },

    "overlay.set.danNote": {
        ru: "Дан — тот же, что на карточке (наш общий расчёт), для карты и рейта этой игры; считается один раз, пока карта выбрана. Линия — сложность по ходу карты (по линии сложности с карточки, в данах вокруг дана карты: это прикидка, а не дан каждого куска), «сейчас» — у позиции игры. «Для тебя» — разница с твоим уровнем по главному паттерну (источник профиля — как в «Подборе»). «Эта игра» — дан твоей игры по модели «Моего профиля» на экране результатов, если запись игр включена.",
        en: "The dan is the card's (our combined estimate) for this play's map and rate, worked out once while the map is selected. The line is how hard the map gets along it (from the card's difficulty line, in dans around the map's dan: an estimate, not a dan of each part), “now” is at the play position. “For you” is the gap to your level for the main pattern (the profile source is the one in Picks). “This play” is your play's dan by the My profile model on the results screen, when recording plays is on.",
    },

    // the five widgets
    "overlay.widget.judgements": { ru: "Попадания", en: "Judgements" },
    "overlay.widget.kps": { ru: "KPS", en: "KPS" },
    "overlay.widget.nps": { ru: "NPS карты", en: "Map NPS" },
    "overlay.widget.keys": { ru: "Линии нажатий", en: "Key lines" },
    "overlay.widget.dan": { ru: "Дан", en: "Dan" },

    // what each widget can show
    "overlay.show.counts": { ru: "Счёт: MAX, 300, 200, 100, 50, мимо", en: "Counts: MAX, 300, 200, 100, 50, miss" },
    "overlay.show.ratio": { ru: "Соотношение MAX:300", en: "MAX:300 ratio" },
    "overlay.show.accuracy": { ru: "Точность", en: "Accuracy" },
    "overlay.show.ur": { ru: "UR (разброс попаданий)", en: "UR (unstable rate)" },
    "overlay.show.now": { ru: "KPS сейчас (за последнюю секунду)", en: "KPS now (over the last second)" },
    "overlay.show.max": { ru: "Максимум KPS за игру", en: "Max KPS this play" },
    "overlay.show.graph": { ru: "График за 10 секунд", en: "Graph of the last 10 seconds" },
    "overlay.show.npsNow": { ru: "NPS сейчас (у позиции игры)", en: "NPS now (at the play position)" },
    "overlay.show.peak": { ru: "Пик NPS карты", en: "The map's peak NPS" },
    "overlay.show.npsGraph": { ru: "График всей карты с бегунком", en: "Graph of the whole map with a playhead" },
    "overlay.show.lines": { ru: "Линии нажатий", en: "Press lines" },
    "overlay.show.keyCounts": { ru: "Нажатия на каждую клавишу", en: "Presses per key" },
    "overlay.show.danMap": { ru: "Дан карты на этом рейте и уверенность", en: "The map's dan at this rate and how sure" },
    "overlay.show.danPattern": { ru: "Главный паттерн", en: "Main pattern" },
    "overlay.show.danLive": { ru: "Сложность по ходу карты и «сейчас»", en: "Difficulty along the map and “now”" },
    "overlay.show.danForYou": { ru: "Для тебя: разница с твоим уровнем", en: "For you: the gap to your level" },
    "overlay.show.danPlay": { ru: "После игры: дан этой игры (Мой профиль)", en: "After the play: this play's dan (My profile)" },

    // the styles
    "overlay.style.minimal": { ru: "Минимал", en: "Minimal" },
    "overlay.style.card": { ru: "Карточка", en: "Card" },
    "overlay.style.neon": { ru: "Неон", en: "Neon" },
    "overlay.style.classic": { ru: "Классика osu!", en: "osu! classic" },
    "overlay.style.compact": { ru: "Компакт", en: "Compact" },

    // labels inside the widgets (the judgement names stay as osu! shows them)
    "overlay.label.miss": { ru: "МИМО", en: "MISS" },
    "overlay.label.acc": { ru: "Точн.", en: "Acc" },
    "overlay.label.max": { ru: "макс", en: "max" },
    "overlay.label.kpsNow": { ru: "KPS", en: "KPS" },
    "overlay.label.npsNow": { ru: "NPS", en: "NPS" },
    "overlay.label.peak": { ru: "пик", en: "peak" },
    // the Dan widget (src/overlay/dan.js)
    "overlay.dan.counting": { ru: "считаем…", en: "working out…" },
    "overlay.dan.notMania": { ru: "не mania", en: "not mania" },
    "overlay.dan.not4k": { ru: "не 4K", en: "not 4K" },
    "overlay.dan.ln": { ru: "LN-карта, без дана", en: "LN map, no dan" },
    "overlay.dan.short": { ru: "слишком короткая", en: "too short" },
    "overlay.dan.none": { ru: "нет оценки", en: "no estimate" },
    "overlay.dan.confidence": { ru: "уверенность: {word}", en: "confidence: {word}" },
    "overlay.dan.now": { ru: "сейчас: {label}", en: "now: {label}" },
    "overlay.dan.nowBreak": { ru: "сейчас: перерыв", en: "now: break" },
    "overlay.dan.forYou": { ru: "{delta} к твоему уровню", en: "{delta} vs your level" },
    "overlay.dan.play": { ru: "эта игра: {label}", en: "this play: {label}" },
    "overlay.edit.badge": { ru: "тащи · уголок — размер", en: "drag · corner resizes" },
};
