import test from "node:test";
import assert from "node:assert/strict";
import {
    plural, skillLines, targetText, metaParts, whyText, oursLines, oursDone, rateText, parseSettings, requestFrom, DEFAULT_SETTINGS,
    progressText, downloadLine, GOAL_CHIPS,
} from "../../app/renderer/recommendTab.js";
import { setLang } from "../../src/i18n/i18n.js";

test("download progress: percent when the size is known, megabytes otherwise", () => {
    assert.equal(progressText({ received: 0, total: 0 }), "Скачиваю…");
    assert.equal(progressText({ received: 12_000_000, total: 24_000_000 }), "Скачиваю… 50%");
    assert.equal(progressText({ received: 24_000_000, total: 24_000_000 }), "Скачиваю… 100%");
    assert.equal(progressText({ received: 3_500_000, total: null }), "Скачиваю… 3.3 МБ");
    assert.equal(progressText(undefined), "Скачиваю…");
});

test("download result line", () => {
    assert.deepEqual(downloadLine({ ok: true, opened: true, reused: false }), { text: "Открыто в osu! — карта появится после импорта", cls: "ok" });
    assert.deepEqual(downloadLine({ ok: true, opened: true, reused: true }), { text: "Карта уже скачана — открыто в osu! ещё раз", cls: "ok" });
    assert.deepEqual(downloadLine({ ok: true, opened: false, message: "скачано, но osu! не открыл файл" }), { text: "скачано, но osu! не открыл файл", cls: "warn" });
    assert.deepEqual(downloadLine({ ok: false, message: "нет зеркал" }), { text: "нет зеркал", cls: "bad" });
});

const SKILL = {
    ready: true, status: "ready", analyzedPlays: 585,
    overall: 13.66, overallLabel: "Delta low",
    tiles: { speed: 14.28, stamina: 13.26, tech: 13.74, jack: 13.36 },
    msd: { Jumpstream: 30.61 },
};

const TARGET = {
    patternId: "jumpstream", goalId: "growth", source: "tile", tile: "stamina",
    playerDan: 13.26, playerDanLabel: "Gamma mid/high",
    lo: 13.26, hi: 13.76, center: 13.51, halfWidth: 0.25,
    msdAxis: "Jumpstream", msdRating: 30.61, msdTarget: 31.36,
};

const CARD = {
    beatmapId: 2701201, beatmapsetId: 1302447, artist: "Jeff Williams", title: "Time to Say Goodbye",
    version: "[4K] Farewell", creator: "Halogen-", status: "loved", stars: 6.62, bpm: 270, lengthSec: 197, playCount: 177949,
    cover: null, dan: 13.56, danLabel: "Delta low", delta: 0.3, msd: 31.94, msdTarget: 31.36,
    purity: 0.8, purityLabel: "чистый", played: null, setPlayed: false, score: 0.7,
};

test("russian plural forms", () => {
    const forms = ["игра", "игры", "игр"];
    assert.deepEqual([1, 2, 5, 11, 21, 22, 585, 111].map((n) => plural(n, forms)), ["игра", "игры", "игр", "игр", "игра", "игры", "игр", "игр"]);
});

test("skill summary: overall dan, plays and tiles", () => {
    const [main, tiles] = skillLines("TestPlayer", SKILL);
    assert.equal(main, "TestPlayer · общий дан Delta low (13.66) · 585 игр");
    assert.equal(tiles, "Speed Delta mid/high · Stamina Gamma mid/high · Tech Delta low/mid · Jack Gamma high");
});

test("skill summary skips missing tiles and overall", () => {
    const [main, tiles] = skillLines("x", { ...SKILL, overall: null, overallLabel: null, analyzedPlays: 21, tiles: { speed: null, stamina: 13.26, tech: null, jack: null } });
    assert.equal(main, "x · 21 игра");
    assert.equal(tiles, "Stamina Gamma mid/high");
});

test("target line: tile dan, window and msd", () => {
    assert.equal(targetText(TARGET, "Джампстрим"), "Твой дан для паттерна «Джампстрим»: Gamma mid/high (13.26) → ищем 13.26–13.76 · MSD Jumpstream ~31.4");
});

test("target line: manual dan has no msd", () => {
    const t = { ...TARGET, source: "manual", playerDan: 13, playerDanLabel: "Gamma mid", lo: 13, hi: 13.5, msdRating: null, msdTarget: null };
    assert.equal(targetText(t, "Джампстрим"), "Выбранный дан для паттерна «Джампстрим»: Gamma mid (13.00) → ищем 13.00–13.50");
});

test("target line: overall fallback is marked", () => {
    const t = { ...TARGET, source: "overall", playerDan: 13.66, playerDanLabel: "Delta low", lo: 13.66, hi: 14.16, msdTarget: null };
    assert.equal(targetText(t, "Тех"), "Твой дан для паттерна «Тех»: Delta low (13.66, общий) → ищем 13.66–14.16");
});

test("card meta line", () => {
    assert.deepEqual(metaParts(CARD).map((p) => p.text), ["Delta low", "+0.3", "6.6★", "270 BPM", "3:17", "loved", "178k игр"]);
    assert.equal(metaParts(CARD)[0].cls, "rec-dan");
    assert.equal(metaParts({ ...CARD, playCount: 22 }).at(-1).text, "22 игры");
});

test("why line: pattern, purity, msd and played state", () => {
    assert.equal(whyText(CARD, "Джампстрим"), "Джампстрим · чистый · MSD 31.9");
    assert.equal(whyText({ ...CARD, msd: null, played: { accuracy: 0.9622, rate: 1 } }, "Стрим"), "Стрим · чистый · сыграно 96.2%");
    assert.equal(whyText({ ...CARD, played: { accuracy: 0.95, rate: 1.1 } }, "Стрим"), "Стрим · чистый · MSD 31.9 · сыграно 95.0% на 1.1x");
    assert.equal(whyText({ ...CARD, purityLabel: "смешанный", setPlayed: true }, "Тех"), "Тех · смешанный · MSD 31.9 · другая сложность сета уже сыграна");
});

test("rate text", () => {
    assert.deepEqual([1.1, 1.05, 1, 0.75].map(rateText), ["1.1x", "1.05x", "1x", "0.75x"]);
});

test("our analysis lines", () => {
    const ours = { label: "Gamma high", numeric: 13.4, primary: "Jumpstream" };
    assert.deepEqual(oursLines({ ok: true, ours, rate: null, rateLabel: null, reason: "in-target" }).map((l) => l.text),
        ["Наш анализатор: Gamma high · Jumpstream", "уже в цели"]);
    assert.deepEqual(oursLines({ ok: true, ours, rate: 1.1, rateLabel: "Delta low", reason: null }).map((l) => l.text),
        ["Наш анализатор: Gamma high · Jumpstream", "для цели — 1.1x (≈ Delta low)"]);
    assert.deepEqual(oursLines({ ok: true, ours: { ...ours, primary: null }, rate: 1.6, rateLabel: "Delta mid", reason: "out-of-range" }).map((l) => l.text),
        ["Наш анализатор: Gamma high", "для цели — 1.6x (≈ Delta mid) (край диапазона)"]);
    // our dan is known but no rate came out (a transient worker error): say so, the button can be pressed again
    const noRate = oursLines({ ok: true, ours, rate: null, rateLabel: null, reason: null });
    assert.deepEqual(noRate.map((l) => l.text), ["Наш анализатор: Gamma high · Jumpstream", "рейт подобрать не удалось — попробуй ещё раз"]);
    assert.equal(noRate[1].cls, "warn");
    assert.deepEqual([
        { ok: true, rate: null, reason: null },
        { ok: false, message: "x" },
        { ok: true, rate: 1.1, reason: null },
        { ok: true, rate: null, reason: "in-target" },
    ].map(oursDone), [false, false, true, true]);
    const bad = oursLines({ ok: false, message: "не 4K" });
    assert.deepEqual(bad.map((l) => l.text), ["не 4K"]);
    assert.equal(bad[0].cls, "bad");
});

test("settings: defaults, bad json and unknown ids", () => {
    assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings("{oops"), DEFAULT_SETTINGS);
    assert.equal(DEFAULT_SETTINGS.patternId, "jumpstream");
    assert.equal(DEFAULT_SETTINGS.goalId, "growth");
    assert.equal(DEFAULT_SETTINGS.hidePlayed, true);
    assert.equal(DEFAULT_SETTINGS.level, 13);
    assert.equal(DEFAULT_SETTINGS.step, "mid");
    const s = parseSettings(JSON.stringify({ query: "TestPlayer", source: "manual", patternId: "tech", goalId: "nope", lengthId: "long", rankedOnly: true, hidePlayed: false, level: 99, step: "high" }));
    assert.deepEqual(s, { ...DEFAULT_SETTINGS, query: "TestPlayer", source: "manual", patternId: "tech", lengthId: "long", rankedOnly: true, hidePlayed: false, step: "high" });
});

test("request from settings", () => {
    const tracker = requestFrom({ ...DEFAULT_SETTINGS, rankedOnly: true });
    assert.deepEqual(tracker, { manual: false, manualDan: null, patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: true, hidePlayed: true });
    // manual mode with a loaded profile still marks its plays, so the checkbox counts there too
    const manual = requestFrom({ ...DEFAULT_SETTINGS, source: "manual", level: 14, step: "low/mid" });
    assert.deepEqual(manual, { manual: true, manualDan: 13.8, patternId: "jumpstream", goalId: "growth", lengthId: "any", rankedOnly: false, hidePlayed: true });
    assert.equal(requestFrom({ ...DEFAULT_SETTINGS, source: "manual", hidePlayed: false }).hidePlayed, false);
});

test("english: plays plural, skill summary and target lines", () => {
    setLang("en");
    try {
        assert.equal(skillLines("TestPlayer", SKILL)[0], "TestPlayer · overall dan Delta low (13.66) · 585 plays");
        assert.equal(skillLines("x", { ...SKILL, overall: null, analyzedPlays: 1 })[0], "x · 1 play");
        assert.equal(targetText(TARGET, "Jumpstream"), "Your dan for Jumpstream: Gamma mid/high (13.26) → looking for 13.26–13.76 · MSD Jumpstream ~31.4");
        const manual = { ...TARGET, source: "manual", playerDan: 13, playerDanLabel: "Gamma mid", lo: 13, hi: 13.5, msdTarget: null };
        assert.equal(targetText(manual, "Tech"), "Picked dan for Tech: Gamma mid (13.00) → looking for 13.00–13.50");
        const overall = { ...TARGET, source: "overall", playerDan: 13.66, playerDanLabel: "Delta low", lo: 13.66, hi: 14.16, msdTarget: null };
        assert.equal(targetText(overall, "Tech"), "Your dan for Tech: Delta low (13.66, overall) → looking for 13.66–14.16");
    } finally {
        setLang("ru");
    }
});

test("english: card meta and why lines", () => {
    setLang("en");
    try {
        assert.equal(metaParts(CARD).at(-1).text, "178k plays");
        assert.equal(metaParts({ ...CARD, playCount: 1 }).at(-1).text, "1 play");
        assert.equal(metaParts({ ...CARD, playCount: 22 }).at(-1).text, "22 plays");
        assert.equal(whyText({ ...CARD, msd: null, played: { accuracy: 0.9622, rate: 1 } }, "Stream"), "Stream · чистый · played 96.2%");
        assert.equal(whyText({ ...CARD, played: { accuracy: 0.95, rate: 1.1 } }, "Stream"), "Stream · чистый · MSD 31.9 · played 95.0% at 1.1x");
        assert.equal(whyText({ ...CARD, played: { rate: 1 } }, "Stream"), "Stream · чистый · MSD 31.9 · played");
        assert.equal(whyText({ ...CARD, setPlayed: true }, "Tech"), "Tech · чистый · MSD 31.9 · you've played another diff of this set");
    } finally {
        setLang("ru");
    }
});

test("english: our analysis, download progress and result lines", () => {
    setLang("en");
    try {
        const ours = { label: "Gamma high", numeric: 13.4, primary: "Jumpstream" };
        assert.deepEqual(oursLines({ ok: true, ours, reason: "in-target" }).map((l) => l.text), ["Our analyzer: Gamma high · Jumpstream", "already on target"]);
        assert.equal(oursLines({ ok: true, ours, rate: 1.6, rateLabel: "Delta mid", reason: "out-of-range" })[1].text, "for your target — 1.6x (≈ Delta mid) (edge of the range)");
        assert.equal(oursLines({ ok: true, ours, rate: null, reason: null })[1].text, "couldn't find a rate — try again");
        assert.equal(oursLines({ ok: false }).at(0).text, "couldn't calculate it");
        assert.equal(progressText(undefined), "Downloading…");
        assert.equal(progressText({ received: 12_000_000, total: 24_000_000 }), "Downloading… 50%");
        assert.equal(progressText({ received: 3_500_000, total: null }), "Downloading… 3.3 MB");
        assert.deepEqual(downloadLine({ ok: true, opened: true, reused: false }), { text: "Opened in osu! — the map shows up once it's imported", cls: "ok" });
        assert.deepEqual(downloadLine({ ok: true, opened: true, reused: true }), { text: "You already have this map — opened it in osu! again", cls: "ok" });
        assert.deepEqual(downloadLine({ ok: true, opened: false }), { text: "downloaded, but osu! didn't open the file", cls: "warn" });
        assert.deepEqual(downloadLine({ ok: false }), { text: "couldn't download it", cls: "bad" });
        assert.deepEqual([1, 2, 5].map((n) => plural(n, ["one", "few", "many"])), ["one", "many", "many"]);
    } finally {
        setLang("ru");
    }
});

// a custom range from the tracker profile (Gamma mid … Delta low) and the same range in manual mode
const RANGE = { ...TARGET, goalId: "custom", lo: 13, hi: 13.6, center: 13.3, halfWidth: 0.3, msdTarget: null, rangeFrom: 13, rangeTo: 13.6 };
const RANGE_ONLY = { ...RANGE, source: "range", playerDan: 13.3, playerDanLabel: "Gamma mid/high", msdRating: null };

test("custom range: a fourth goal chip, its settings and the request", () => {
    assert.deepEqual(GOAL_CHIPS.map((g) => g.id), ["comfort", "growth", "challenge", "custom"]);
    assert.equal(GOAL_CHIPS[3].name, "Свой диапазон");
    assert.equal(DEFAULT_SETTINGS.rangeFrom, 12);
    assert.equal(DEFAULT_SETTINGS.rangeTo, 13);
    const saved = parseSettings(JSON.stringify({ goalId: "custom", rangeFrom: 20.4, rangeTo: 0.6 }));
    assert.deepEqual(saved, { ...DEFAULT_SETTINGS, goalId: "custom", rangeFrom: 20.4, rangeTo: 0.6 });
    // only what the picker can show is kept: anything else is the default
    for (const bad of [13.85, 0.4, 20.6, "13", null, NaN]) {
        const s = parseSettings(JSON.stringify({ rangeFrom: bad, rangeTo: bad }));
        assert.equal(s.rangeFrom, 12, String(bad));
        assert.equal(s.rangeTo, 13, String(bad));
    }
    assert.equal(parseSettings(JSON.stringify({ rangeFrom: 13.8 })).rangeFrom, 13.8);

    const tracker = requestFrom({ ...DEFAULT_SETTINGS, goalId: "custom", rangeFrom: 14, rangeTo: 12.6 });
    assert.deepEqual(tracker, {
        manual: false, manualDan: null, patternId: "jumpstream", goalId: "custom", range: { from: 12.6, to: 14 },
        lengthId: "any", rankedOnly: false, hidePlayed: true,
    });
    // in manual mode the range is all it needs: no dan from the manual picker
    const manual = requestFrom({ ...DEFAULT_SETTINGS, source: "manual", goalId: "custom", level: 15, step: "high" });
    assert.equal(manual.manual, true);
    assert.equal(manual.manualDan, null);
    assert.deepEqual(manual.range, { from: 12, to: 13 });
    // the other goals send no range
    assert.equal("range" in requestFrom(DEFAULT_SETTINGS), false);
});

test("custom range: the target line shows the chosen range", () => {
    assert.equal(targetText(RANGE, "Джампстрим"), "Твой дан для паттерна «Джампстрим»: Gamma mid/high (13.26) → свой диапазон Gamma mid – Delta low: ищем 13.00–13.60");
    assert.equal(targetText(RANGE_ONLY, "Джампстрим"), "Свой диапазон для паттерна «Джампстрим»: Gamma mid – Delta low → ищем 13.00–13.60");
    const one = { ...RANGE_ONLY, lo: 13, hi: 13, rangeTo: 13 };
    assert.equal(targetText(one, "Тех"), "Свой диапазон для паттерна «Тех»: Gamma mid → ищем 13.00–13.00");
    const overall = { ...RANGE, source: "overall", playerDan: 13.66, playerDanLabel: "Delta low" };
    assert.equal(targetText(overall, "Тех"), "Твой дан для паттерна «Тех»: Delta low (13.66, общий) → свой диапазон Gamma mid – Delta low: ищем 13.00–13.60");
});

test("english: custom range chip and target lines", () => {
    setLang("en");
    try {
        assert.equal(GOAL_CHIPS[3].name, "Custom range");
        assert.ok(GOAL_CHIPS[3].hint && !/[А-Яа-яЁё]/.test(GOAL_CHIPS[3].hint));
        assert.equal(targetText(RANGE, "Jumpstream"), "Your dan for Jumpstream: Gamma mid/high (13.26) → custom range Gamma mid – Delta low: looking for 13.00–13.60");
        assert.equal(targetText(RANGE_ONLY, "Jumpstream"), "Custom range for Jumpstream: Gamma mid – Delta low → looking for 13.00–13.60");
        assert.equal(targetText({ ...RANGE_ONLY, rangeFrom: 0.6, rangeTo: 10.4, lo: 0.6, hi: 10.4 }, "Tech"), "Custom range for Tech: 1 low – 10 high → looking for 0.60–10.40");
    } finally {
        setLang("ru");
    }
});
