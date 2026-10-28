// "gen" texts: key → { ru, en }. A value is a string with {param} slots or a function of the params.
export default {
    // mapgen v3: each stream adds its keys only inside its own block
    // >>> mapgen-A: the generator core (parts, requests)
    "gen.parts.bad": { ru: "Части песни заданы неверно: {what}", en: "The song parts are invalid: {what}" },
    // <<< mapgen-A

    // >>> mapgen-C: remap
    "gen.remap.noRows": { ru: "В карте нет нот", en: "The map has no notes" },
    "gen.remap.noDan": { ru: "Не получилось посчитать дан этой карты: {message}", en: "Couldn't work out this map's dan: {message}" },
    // <<< mapgen-C

    // >>> flavours: the sub-patterns of the six families (src/gen/flavours.js), their one-line hints, and the
    // «Общие / Подробно» switch shared by every tab (app/renderer/patternMode.js)
    "gen.patternMode.general": { ru: "Общие", en: "General" },
    "gen.patternMode.detailed": { ru: "Подробно", en: "Detailed" },
    "gen.patternMode.hint": {
        ru: "Общие — шесть основных паттернов; подробно — их разновидности (роллы, джамптриллы, анкоры…). Переключатель один на все вкладки",
        en: "General — the six main patterns; Detailed — their kinds (rolls, jumptrills, anchors…). One switch for every tab",
    },
    "gen.request.bad": { ru: "Запрос на генерацию задан неверно: {what}", en: "The generation request is invalid: {what}" },
    "gen.flavour.any": { ru: "{family}: любые разновидности", en: "{family}: any kind" },
    "gen.flavour.Rolls": { ru: "Роллы", en: "Rolls" },
    "gen.flavour.Rolls.hint": { ru: "Лесенки через все 4 столбца: 1234 / 4321", en: "Staircases across all 4 columns: 1234 / 4321" },
    "gen.flavour.Trills": { ru: "Триллы", en: "Trills" },
    "gen.flavour.Trills.hint": { ru: "Две клавиши по очереди, по 4 ноты: 1212 3232", en: "Two columns in turns, 4 notes each: 1212 3232" },
    "gen.flavour.Minitrills": { ru: "Минитриллы", en: "Minitrills" },
    "gen.flavour.Minitrills.hint": { ru: "Короткие триллы по 3 ноты: 121 343", en: "Short 3-note trills: 121 343" },
    "gen.flavour.RunningMan": { ru: "Раннинг мэн", en: "Running man" },
    "gen.flavour.RunningMan.hint": { ru: "Один столбец через ноту, остальные бегут вокруг: 1213141", en: "One column on every other note, the rest roll around it: 1213141" },
    "gen.flavour.Jumptrill": { ru: "Джамптриллы", en: "Jumptrills" },
    "gen.flavour.Jumptrill.hint": { ru: "Прыжки руками по очереди: [12][34][12][34]", en: "Jumps alternating between the hands: [12][34][12][34]" },
    "gen.flavour.SplitTrill": { ru: "Сплит-триллы", en: "Split trills" },
    "gen.flavour.SplitTrill.hint": { ru: "Разнесённые прыжки по очереди: [13][24][13][24]", en: "Split jumps in turns: [13][24][13][24]" },
    "gen.flavour.Anchor": { ru: "Анкоры", en: "Anchors" },
    "gen.flavour.Anchor.hint": { ru: "Джампстрим, где один столбец звучит через ряд: [12] 3 [14] 2 [13]", en: "Jumpstream with one column on every other row: [12] 3 [14] 2 [13]" },
    "gen.flavour.Dumpstream": { ru: "Дампстрим", en: "Dumpstream" },
    "gen.flavour.Dumpstream.hint": { ru: "Прыжки и одиночки лесенкой в одну сторону: [12] 3 4 / [34] 2 1", en: "Jumps and singles climbing one way: [12] 3 4 / [34] 2 1" },
    "gen.flavour.ChordTrills": { ru: "Чорд-триллы", en: "Chord trills" },
    "gen.flavour.ChordTrills.hint": { ru: "Хенд и оставшаяся нота по очереди: [123] 4 [123] 4", en: "A hand and the leftover note in turns: [123] 4 [123] 4" },
    "gen.flavour.DenseHandstream": { ru: "Плотный хендстрим", en: "Dense handstream" },
    "gen.flavour.DenseHandstream.hint": { ru: "Хенд каждые три ряда: [123] 4 1 [234]", en: "A hand every third row: [123] 4 1 [234]" },
    "gen.flavour.JumpyHandstream": { ru: "Джампи-хендстрим", en: "Jumpy handstream" },
    "gen.flavour.JumpyHandstream.hint": { ru: "Хенды и прыжки, между ними по одиночке: [123] 4 [12] 3", en: "Hands and jumps with a single between them: [123] 4 [12] 3" },
    "gen.flavour.Handjack": { ru: "Хендджеки", en: "Handjacks" },
    "gen.flavour.Handjack.hint": { ru: "Хенды подряд, два столбца повторяются: [123][234][134]", en: "Hands back to back, two columns repeat: [123][234][134]" },
    "gen.flavour.Jumpjack": { ru: "Джампджеки", en: "Jumpjacks" },
    "gen.flavour.Jumpjack.hint": { ru: "Каждый прыжок дважды: [23][23][14][14]", en: "Every jump played twice: [23][23][14][14]" },
    "gen.flavour.Quadhand": { ru: "Квадхенд", en: "Quadhand" },
    "gen.flavour.Quadhand.hint": { ru: "Квады и хенды вперемешку: [1234][123][234]", en: "Quads and hands mixed: [1234][123][234]" },
    "gen.flavour.JumpQuad": { ru: "Чордджеки 2/4", en: "2/4 chordjacks" },
    "gen.flavour.JumpQuad.hint": {
        ru: "Джампы и квады по очереди, джек в каждой строке: [12][1234][34][1234]",
        en: "Jumps and quads in turn, a jack on every row: [12][1234][34][1234]",
    },
    "gen.flavour.Quadstream": { ru: "Квадстрим", en: "Quadstream" },
    "gen.flavour.Quadstream.hint": { ru: "Квад, потом короткий стрим: [1234] 1 3 [24] [1234]", en: "A quad, then a short stream: [1234] 1 3 [24] [1234]" },
    "gen.flavour.Minijacks": { ru: "Миниджеки", en: "Minijacks" },
    "gen.flavour.Minijacks.hint": { ru: "Прыжок дважды, потом дальше: [12][12] 3 4", en: "A jump twice, then on: [12][12] 3 4" },
    "gen.flavour.Longjacks": { ru: "Лонгджеки", en: "Longjacks" },
    "gen.flavour.Longjacks.hint": { ru: "Один столбец 6–8 рядов подряд: [12][12][13][12][14]", en: "One column held for 6–8 rows: [12][12][13][12][14]" },
    "gen.flavour.Gluts": { ru: "Глюты", en: "Gluts" },
    "gen.flavour.Gluts.hint": { ru: "Прыжки сдвигаются на столбец, одна нота общая: [12][23][34]", en: "Jumps sliding by a column, one note shared: [12][23][34]" },
    "gen.flavour.Speedjacks": { ru: "Спидджеки", en: "Speedjacks" },
    "gen.flavour.Speedjacks.hint": { ru: "Быстрые джеки по 2–3 ноты: 111 22 333", en: "Fast 2–3-note jacks: 111 22 333" },
    "gen.flavour.Coordination": { ru: "Координация", en: "Coordination" },
    "gen.flavour.Coordination.hint": { ru: "Одна рука триллит, другая играет своё: 1 3 2 4 1 3 2 3", en: "One hand trills, the other plays its own line: 1 3 2 4 1 3 2 3" },
    "gen.flavour.JackyStream": { ru: "Джеки в стриме", en: "Jacky stream" },
    "gen.flavour.JackyStream.hint": { ru: "Стрим с двойной нотой каждые 3–6 нот: 1 2 2 3 4 1 1", en: "A stream with a doubled note every 3–6 notes: 1 2 2 3 4 1 1" },
    // <<< flavours
};
