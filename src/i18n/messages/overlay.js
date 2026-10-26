// "overlay" texts: key → { ru, en }. The in-game overlay: its tray items (app/overlay/overlayManager.js),
// the settings window (app/overlay/settings.*) and the widgets (app/overlay/widget.*, app/overlay/render.js).
export default {
    // tray: the «Оверлей» submenu
    "overlay.tray.menu": { ru: "Оверлей", en: "Overlay" },
    "overlay.tray.enabled": { ru: "Показывать во время игры", en: "Show while playing" },
    "overlay.tray.edit": { ru: "Двигать окошки ({hotkey})", en: "Move the widgets ({hotkey})" },
    "overlay.tray.settings": { ru: "Настройки оверлея…", en: "Overlay settings…" },

    // the settings window
    "overlay.window.title": { ru: "Оверлей — Lunacy mania", en: "Overlay — Lunacy mania" },
    "overlay.set.heading": { ru: "Оверлей в игре", en: "In-game overlay" },
    "overlay.set.enabled": { ru: "Показывать оверлей во время игры", en: "Show the overlay while playing" },
    "overlay.set.showOnResults": { ru: "И на экране результатов", en: "Also on the results screen" },
    "overlay.set.edit": { ru: "Двигать и менять размер", en: "Move and resize" },
    "overlay.set.editDone": { ru: "Готово, закрепить", en: "Done, lock them" },
    "overlay.set.hint": {
        ru: "Это отдельные окошки поверх игры, в osu! ничего не встраивается. osu! должен быть в оконном или безрамочном режиме: поверх полноэкранной игры их не видно. Во время игры клики проходят сквозь них. {hotkey} — включить или выключить перемещение: тащи окошко мышью, уголок справа внизу меняет размер.",
        en: "These are separate windows over the game, nothing is injected into osu!. osu! must be in windowed or borderless mode: they can't be seen over a fullscreen game. While you play, clicks go through them. {hotkey} turns moving on or off: drag a widget with the mouse, its bottom-right corner resizes it.",
    },
    "overlay.set.keysNote": {
        ru: "В mania osu! не отдаёт нажатия клавиш, поэтому линии строятся по попаданиям и нотам карты; если tosu отдаёт счётчики клавиш, берутся они.",
        en: "In mania osu! doesn't report key presses, so the lines are rebuilt from the judgements and the map's notes; when tosu reports key counters, those are used.",
    },
    "overlay.set.show": { ru: "Показывать это окошко", en: "Show this widget" },
    "overlay.set.style": { ru: "Стиль", en: "Style" },
    "overlay.set.opacity": { ru: "Видимость", en: "Opacity" },
    "overlay.set.scale": { ru: "Размер", en: "Size" },
    "overlay.set.styles": { ru: "Все стили (пример с выдуманными числами)", en: "All styles (a sample with made-up numbers)" },

    // the three widgets
    "overlay.widget.judgements": { ru: "Попадания", en: "Judgements" },
    "overlay.widget.kps": { ru: "KPS", en: "KPS" },
    "overlay.widget.keys": { ru: "Линии нажатий", en: "Key lines" },

    // what each widget can show
    "overlay.show.counts": { ru: "Счёт: MAX, 300, 200, 100, 50, мимо", en: "Counts: MAX, 300, 200, 100, 50, miss" },
    "overlay.show.ratio": { ru: "Соотношение MAX:300", en: "MAX:300 ratio" },
    "overlay.show.accuracy": { ru: "Точность", en: "Accuracy" },
    "overlay.show.ur": { ru: "UR (разброс попаданий)", en: "UR (unstable rate)" },
    "overlay.show.now": { ru: "KPS сейчас (за последнюю секунду)", en: "KPS now (over the last second)" },
    "overlay.show.max": { ru: "Максимум KPS за игру", en: "Max KPS this play" },
    "overlay.show.graph": { ru: "График за 10 секунд", en: "Graph of the last 10 seconds" },
    "overlay.show.lines": { ru: "Линии нажатий", en: "Press lines" },
    "overlay.show.keyCounts": { ru: "Нажатия на каждую клавишу", en: "Presses per key" },

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
    "overlay.edit.badge": { ru: "тащи · уголок — размер", en: "drag · corner resizes" },
};
