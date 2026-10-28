// The rate tab in a fake DOM: presets apply and save, the rate-for-a-dan answer moves the slider, batch rows fill
// from progress events, progress and answers for another map are dropped, and the LN badge and hint show.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { initRateTab, onRateTabShown, openRateAt, getOptions } from "../app/renderer/rateTab.js";
import { normalizePresets } from "../src/rate/presets.js";
import { setLang } from "../src/i18n/i18n.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const KEY = "C:/Songs/m.osu|1";
const INFO = { ok: true, mania: true, keys: 4, key: KEY, lnShare: 0, info: { artist: "A", title: "T", version: "V", od: 8, hp: 7, bpm: 150 } };
const OK = { kind: "ok", label: "Gamma mid", numeric: 13, primary: "Jumpstream" };

// The tab over a fake danApi; `api` replaces any default method. Progress is sent with emit().
async function tab(api = {}) {
    const seen = { preview: [], saved: [], cancel: 0, created: [] };
    let onProgress = () => {};
    let info = INFO;
    const dom = fakeDom({
        rateInfo: async () => info,
        ratePreview: async (rate, opts) => { seen.preview.push({ rate, ...opts }); return OK; },
        rateCreate: async (req) => { seen.created.push(req); return { ok: true, version: "x" }; },
        rateCancel: () => { seen.cancel += 1; },
        onRateProgress: (cb) => { onProgress = cb; return () => {}; },
        ratePresets: async () => ({ ok: true, presets: [] }),
        rateSavePresets: async (list) => { seen.saved.push(list); return { ok: true, presets: normalizePresets(list) }; },
        ...api,
    });
    dom.$("rate-value").value = "1.1"; // as index.html starts
    initRateTab();
    await tick();
    return { ...dom, seen, emit: (p) => onProgress(p), setInfo: (v) => { info = v; } };
}

test("a preset chip shows its label, a click puts its options in place, ✕ removes it, and the current settings save first", async () => {
    const preset = { rate: 1.3, pitch: true, od: 8.5, hp: null, mirror: true, noLn: false };
    const { $, seen } = await tab({ ratePresets: async () => ({ ok: true, presets: [preset] }) });
    await onRateTabShown();
    const chip = $("rate-presets").children[0];
    assert.equal(textOf(chip), "×1.3 · NC · OD 8.5 · Зеркало | ✕");
    await fire(chip);
    assert.equal($("rate-value").value, "1.3");
    assert.equal($("rate-slider").value, "1.3");
    assert.equal($("rate-pitch").checked, true);
    assert.equal($("rate-od").value, "8.5");
    assert.equal($("rate-hp").value, "7", "null keeps the map's own HP");
    assert.equal($("rate-mirror").checked, true);
    assert.equal($("rate-noln").checked, false);
    assert.deepEqual(getOptions(), preset);
    await sleep(300);
    assert.deepEqual(seen.preview.at(-1), { rate: 1.3, mirror: true, noLn: false });

    await fire(chip.children[1]);
    assert.deepEqual(seen.saved.at(-1), []);
    assert.equal(textOf($("rate-presets")), "Пока пусто — настрой и нажми «Сохранить пресет»");

    $("rate-value").value = "1.25";
    $("rate-od").value = "8"; // the map's own
    await fire($("rate-save-preset"));
    assert.deepEqual(seen.saved.at(-1), [{ rate: 1.25, pitch: true, od: null, hp: null, mirror: true, noLn: false }]);
    assert.equal($("rate-status").textContent, "Пресет сохранён: ×1.25 · NC · Зеркало");
    assert.equal($("rate-presets").children.length, 1);
    // the same settings again: still one chip
    await fire($("rate-save-preset"));
    assert.equal(seen.saved.at(-1).length, 1);
    await sleep(300);
});

test("presets that fail to load or save leave the tab working", async () => {
    const { $ } = await tab({
        ratePresets: async () => { throw new Error("no handler"); },
        rateSavePresets: async () => ({ ok: false, message: "disk full" }),
    });
    assert.equal(textOf($("rate-presets")), "Пока пусто — настрой и нажми «Сохранить пресет»");
    await onRateTabShown();
    await fire($("rate-save-preset"));
    assert.equal($("rate-status").textContent, "Пресет не сохранился: disk full");
    await sleep(300);
});

test("rate for a dan: the picker follows the preview, tries show as they come, the answer moves the slider", async () => {
    let answer = null;
    let asked = null;
    const { $, emit } = await tab({
        ratePreview: async () => ({ ...OK, numeric: 12.6, label: "Gamma low" }),
        rateTarget: (req) => { asked = req; return new Promise((resolve) => { answer = resolve; }); },
    });
    assert.equal($("rate-target-find").disabled, true, "no map yet");
    await onRateTabShown();
    await sleep(300);
    assert.equal($("rate-target-level").value, "13");
    assert.equal($("rate-target-step").value, "low");
    assert.equal($("rate-target-find").disabled, false);

    // picked by hand: Gamma mid
    $("rate-target-step").value = "mid";
    await fire($("rate-target-step"), "change");
    $("rate-noln").checked = true;
    const searching = fire($("rate-target-find"));
    assert.deepEqual(asked, { target: 13, mirror: false, noLn: true });
    assert.equal($("rate-target-status").textContent, "Ищем…");
    assert.equal($("rate-target-find").disabled, true);
    assert.equal($("rate-batch-dans").disabled, true, "one job at a time");
    emit({ job: "target", key: KEY, index: 1, total: 10, rate: 1.15, numeric: 12.6 });
    assert.equal($("rate-target-status").textContent, "Ищем… ×1.15 → 12.6");
    emit({ job: "target", key: "C:/other.osu|5", index: 2, total: 10, rate: 1.9, numeric: 15 });
    assert.equal($("rate-target-status").textContent, "Ищем… ×1.15 → 12.6", "another map's progress is dropped");
    answer({ ok: true, key: KEY, rate: 1.17, numeric: 13.02, label: "Gamma mid", reason: "hit", tries: [1, 2, 3, 4, 5] });
    await searching;
    assert.equal($("rate-slider").value, "1.17");
    assert.equal($("rate-value").value, "1.17");
    assert.equal($("rate-target-status").textContent, "Gamma mid → ×1.17 (13.0), проверено 5 рейтов");
    assert.equal($("rate-target-find").disabled, false);
    // the picker stays where it was put even when the preview shows another dan
    await sleep(300);
    assert.equal($("rate-target-step").value, "mid");
});

test("rate for a dan: the edges, a map with no dan, and English", async () => {
    let next = null;
    const { $ } = await tab({ rateTarget: async () => next });
    await onRateTabShown();
    next = { ok: true, key: KEY, rate: 2, numeric: 12.1, label: "Beta mid", reason: "above-range", tries: [1, 2] };
    await fire($("rate-target-find"));
    assert.equal($("rate-target-status").textContent, "Даже на ×2 только Beta mid");
    assert.equal($("rate-value").value, "2");
    next = { ok: true, key: KEY, rate: 0.5, numeric: 15, label: "Epsilon low", reason: "below-range", tries: [1, 2] };
    await fire($("rate-target-find"));
    assert.equal($("rate-target-status").textContent, "Даже на ×0.5 уже Epsilon low");
    next = { ok: false, key: KEY, reason: "base-failed", result: { kind: "not-rice", reason: "ln", keys: 4 }, message: "" };
    await fire($("rate-target-find"));
    assert.equal($("rate-target-status").textContent, "LN-карта — включи «Без LN», чтобы посчитать дан");
    next = { ok: false, message: "уже идёт расчёт рейтов" };
    await fire($("rate-target-find"));
    assert.equal($("rate-target-status").textContent, "Не нашли: уже идёт расчёт рейтов");
    setLang("en");
    try {
        next = { ok: true, key: KEY, rate: 1.21, numeric: 13.1, label: "Gamma mid", reason: "closest", tries: [1] };
        await fire($("rate-target-find"));
        assert.equal($("rate-target-status").textContent, "Gamma mid: the closest is ×1.21 (13.1), 1 rate tried");
        next = { ok: true, key: KEY, rate: 2, numeric: 12.1, label: "Beta mid", reason: "above-range", tries: [1, 2] };
        await fire($("rate-target-find"));
        assert.equal($("rate-target-status").textContent, "Even at ×2 it's only Beta mid");
    } finally {
        setLang("ru");
    }
    await sleep(300);
});

test("several rates: rows wait, fill from progress one by one, a click sets the rate, checked rows become copies", async () => {
    let finish = null;
    let dansAsked = null;
    let createAsked = null;
    const ROWS = [
        { rate: 1, bpm: 150, kind: "ok", label: "Gamma low", numeric: 12, primary: "Stream" },
        { rate: 1.1, bpm: 165, kind: "ok", label: "Gamma low/mid", numeric: 12.3, primary: "Stream" },
        { rate: 1.2, bpm: 180, kind: "not-rice", label: null, numeric: null, primary: null, reason: "ln", keys: 4 },
    ];
    const { $, emit } = await tab({
        rateBatchDans: (req) => { dansAsked = req; return new Promise((resolve) => { finish = resolve; }); },
        rateBatchCreate: async (req) => {
            createAsked = req;
            return { ok: true, key: KEY, made: [{ rate: 1, version: "V 1x", file: "a.osu" }], failed: [{ rate: 1.2, message: "disk full" }] };
        },
    });
    await onRateTabShown();
    $("rate-batch-from").value = "1";
    $("rate-batch-to").value = "1.2";
    $("rate-batch-step").value = "0.1";
    await fire($("rate-batch-from"), "input");
    assert.equal($("rate-batch-count").textContent, "3 рейта");
    assert.equal($("rate-batch-create").textContent, "Создать отмеченные (0)");
    assert.equal($("rate-batch-create").disabled, true);

    const counting = fire($("rate-batch-dans"));
    assert.deepEqual(dansAsked, { from: 1, to: 1.2, step: 0.1, mirror: false, noLn: false });
    assert.equal($("rate-batch-stop").hidden, false);
    const table = $("rate-batch-table");
    assert.deepEqual(table.children.map(textOf), ["×1.00 | 150 BPM | …", "×1.10 | 165 BPM | …", "×1.20 | 180 BPM | …"]);
    emit({ job: "dans", key: KEY, index: 1, total: 3, rate: 1, numeric: 12, row: ROWS[0] });
    assert.equal(textOf(table.children[0]), "×1.00 | 150 BPM | Gamma low | 12.0");
    assert.equal(textOf(table.children[1]), "×1.10 | 165 BPM | …");
    assert.equal($("rate-batch-status").textContent, "Считаем даны 1/3…");
    emit({ job: "dans", key: "C:/other.osu|9", index: 2, total: 3, rate: 1.1, numeric: 15, row: { ...ROWS[1], label: "Delta" } });
    assert.equal(textOf(table.children[1]), "×1.10 | 165 BPM | …", "another map's row is dropped");
    finish({ ok: true, key: KEY, rows: ROWS });
    await counting;
    assert.deepEqual(table.children.map(textOf), ["×1.00 | 150 BPM | Gamma low | 12.0", "×1.10 | 165 BPM | Gamma low/mid | 12.3", "×1.20 | 180 BPM | LN-карта"]);
    assert.equal($("rate-batch-stop").hidden, true);
    assert.equal($("rate-batch-status").textContent, "");
    assert.equal($("rate-batch-create").textContent, "Создать отмеченные (3)");

    await fire(table.children[1]);
    assert.equal($("rate-value").value, "1.1");

    const box = table.children[1].children[0];
    box.checked = false;
    await fire(box, "change");
    assert.equal($("rate-batch-create").textContent, "Создать отмеченные (2)");
    $("rate-pitch").checked = true;
    await fire($("rate-batch-create"));
    assert.deepEqual(createAsked, { rates: [1, 1.2], pitch: true, od: null, hp: null, mirror: false, noLn: false });
    assert.equal($("rate-batch-status").textContent, "Готово: 1 карта. F5 в выборе карт. Не вышло: ×1.2 (disk full)");
    await sleep(300);
});

test("creating shows each copy as it starts; a stopped batch says so", async () => {
    let finish = null;
    const { $, emit, seen } = await tab({
        rateBatchDans: async () => ({ ok: true, key: KEY, rows: [{ rate: 1.1, bpm: 165, kind: "ok", label: "G", numeric: 12.3, primary: "S" }] }),
        rateBatchCreate: () => new Promise((resolve) => { finish = resolve; }),
    });
    await onRateTabShown();
    $("rate-batch-from").value = "1.1";
    $("rate-batch-to").value = "1.1";
    $("rate-batch-step").value = "0.05";
    await fire($("rate-batch-dans"));
    const creating = fire($("rate-batch-create"));
    assert.equal($("rate-batch-status").textContent, "Создаём 1/1: ×1.1…");
    emit({ job: "create", key: KEY, index: 1, total: 1, rate: 1.1 });
    assert.equal($("rate-batch-status").textContent, "Создаём 1/1: ×1.1…");
    await fire($("rate-batch-stop"));
    assert.equal(seen.cancel, 1);
    finish({ ok: true, key: KEY, made: [], failed: [], cancelled: true });
    await creating;
    assert.equal($("rate-batch-status").textContent, "Остановлено");
    setLang("en");
    try {
        await fire($("rate-batch-from"), "input");
        assert.equal($("rate-batch-count").textContent, "1 rate");
    } finally {
        setLang("ru");
    }
    await sleep(300);
});

test("another map in osu! (or other chart options) stops the running job and clears the table", async () => {
    let finish = null;
    const ROW = { rate: 1, bpm: 150, kind: "ok", label: "Gamma low", numeric: 12, primary: "Stream" };
    const t = await tab({ rateBatchDans: () => new Promise((resolve) => { finish = resolve; }) });
    const { $, emit, seen, setInfo } = t;
    await onRateTabShown();
    $("rate-batch-from").value = "1";
    $("rate-batch-to").value = "1.1";
    $("rate-batch-step").value = "0.1";
    const counting = fire($("rate-batch-dans"));
    assert.equal($("rate-batch-table").children.length, 2);

    setInfo({ ...INFO, key: "C:/Songs/other.osu|2" });
    await onRateTabShown();
    assert.equal(seen.cancel, 1);
    assert.equal($("rate-batch-table").children.length, 0);
    emit({ job: "dans", key: KEY, index: 1, total: 2, rate: 1, row: ROW });
    finish({ ok: true, key: KEY, rows: [ROW] });
    await counting;
    assert.equal($("rate-batch-table").children.length, 0, "the old map's answer is dropped");
    assert.equal($("rate-batch-status").textContent, "");

    // the same map again: nothing is cleared
    const again = fire($("rate-batch-dans"));
    finish({ ok: true, key: "C:/Songs/other.osu|2", rows: [ROW] });
    await again;
    await onRateTabShown();
    assert.equal($("rate-batch-table").children.length, 2);
    assert.equal(seen.cancel, 1);

    // mirror on: the dans no longer match
    $("rate-mirror").checked = true;
    await fire($("rate-mirror"), "change");
    assert.equal($("rate-batch-table").children.length, 0);
    assert.equal(seen.cancel, 1, "nothing was running");
    await sleep(300);
    assert.deepEqual(seen.preview.at(-1), { rate: 1.1, mirror: true, noLn: false });
});

test("the LN badge follows the map; an LN map's preview asks for No LN, and with it the dan is counted", async () => {
    const { $, seen } = await tab({
        rateInfo: async () => ({ ...INFO, lnShare: 0.34 }),
        ratePreview: async (rate, opts) => {
            seen.preview.push({ rate, ...opts });
            return opts?.noLn ? OK : { kind: "not-rice", reason: "ln", keys: 4 };
        },
    });
    await onRateTabShown();
    assert.equal($("rate-ln").hidden, false);
    assert.equal($("rate-ln").textContent, "LN 34%");
    await sleep(300);
    assert.equal($("rate-preview").textContent, "LN-карта — включи «Без LN», чтобы посчитать дан");
    $("rate-noln").checked = true;
    await fire($("rate-noln"), "change");
    await sleep(300);
    assert.equal($("rate-preview").textContent, "На ×1.1: Gamma mid · 13.0 · Jumpstream");
    // single create carries the options
    await fire($("rate-create"));
    assert.deepEqual(seen.created.at(-1), { rate: 1.1, pitch: false, od: null, hp: null, mirror: false, noLn: true });
});

test("openRateAt still sets the next refresh's rate", async () => {
    const { $, seen } = await tab();
    openRateAt(1.35);
    await onRateTabShown();
    assert.equal($("rate-value").value, "1.35");
    await sleep(300);
    assert.equal(seen.preview.at(-1).rate, 1.35);
});

test("the preview and the rows' tooltips follow the General / Detailed switch from another tab", async () => {
    const { resetPatternMode, setPatternMode } = await import("../app/renderer/patternMode.js");
    resetPatternMode();
    let finish = null;
    const { $, emit } = await tab({
        ratePreview: async () => ({ ...OK, primary: "Rolls" }),
        rateBatchDans: () => new Promise((resolve) => { finish = resolve; }),
    });
    await onRateTabShown();
    await sleep(300);
    assert.equal($("rate-preview").textContent, "На ×1.1: Gamma mid · 13.0 · Stream");
    $("rate-batch-from").value = "1";
    $("rate-batch-to").value = "1";
    $("rate-batch-step").value = "0.1";
    const counting = fire($("rate-batch-dans"));
    emit({ key: KEY, job: "dans", index: 1, total: 1, row: { rate: 1, bpm: 150, kind: "ok", label: "Gamma low", numeric: 12, primary: "Rolls" } });
    const dan = () => $("rate-batch-table").children[0].children[3].title;
    assert.equal(dan(), "Gamma low · Stream");
    setPatternMode("detailed");
    assert.equal($("rate-preview").textContent, "На ×1.1: Gamma mid · 13.0 · Роллы");
    assert.equal(dan(), "Gamma low · Роллы");
    setPatternMode("general");
    assert.equal($("rate-preview").textContent, "На ×1.1: Gamma mid · 13.0 · Stream");
    finish({ ok: true, key: KEY, rows: [] });
    await counting;
});

test("a rate map's original: the note says so, its Mirror / No LN come on and go with it; one made back makes no copies", async () => {
    const original = { ...INFO, key: "C:/Songs/orig.osu|1", origin: { rate: 1.2, virtual: false, mirror: true, noLn: true, version: "V 1.2x (180bpm) Mirror NoLN" } };
    const { $, setInfo, seen } = await tab();
    setInfo(original);
    openRateAt(1.3);
    await onRateTabShown();
    assert.equal($("rate-origin-note").hidden, false);
    assert.equal($("rate-origin-note").textContent, "Рейт-карта ×1.2: тут её оригинал — дан и копии считаются от него, а не от рейт-карты.");
    assert.equal($("rate-value").value, "1.3");
    assert.deepEqual([$("rate-mirror").checked, $("rate-noln").checked], [true, true]);
    assert.equal($("rate-create").disabled, false);
    await sleep(300);
    assert.deepEqual(seen.preview.at(-1), { rate: 1.3, mirror: true, noLn: true });

    // made back from the rate map: no copies from the tab, nor from the several-rates table
    setInfo({ ...INFO, key: "C:/Songs/rate.osu|1#original", origin: { rate: 1.2, virtual: true, mirror: false, noLn: false, version: "V 1.2x" } });
    await onRateTabShown();
    assert.equal($("rate-origin-note").textContent, "Рейт-карта ×1.2: оригинала нет в папке карты, он восстановлен из рейт-карты — даны на рейтах считаются, а копии делаются только из настоящего оригинала (выбери его в osu!).");
    assert.deepEqual([$("rate-mirror").checked, $("rate-noln").checked], [false, false]);
    assert.equal($("rate-create").disabled, true);
    assert.equal($("rate-batch-create").disabled, true);

    // a plain map again: no note, copies again, the options stay as the player leaves them
    $("rate-mirror").checked = true;
    setInfo(INFO);
    await onRateTabShown();
    assert.equal($("rate-origin-note").hidden, true);
    assert.equal($("rate-create").disabled, false);
    assert.equal($("rate-mirror").checked, true);
    await sleep(300);
});

test("an original made back from a rate map: its dans fill the table, but its checked rows make no copies", async () => {
    const key = "C:/Songs/rate.osu|1#original";
    const rows = [{ rate: 1, bpm: 150, kind: "ok", label: "Gamma low", numeric: 12, primary: "Stream" }, { rate: 1.1, bpm: 165, kind: "ok", label: "Gamma mid", numeric: 13, primary: "Stream" }];
    const { $ } = await tab({ rateBatchDans: async () => ({ ok: true, key, rows }) });
    const setInfo = (v) => { window.danApi.rateInfo = async () => v; };
    setInfo({ ...INFO, key, origin: { rate: 1.2, virtual: true, mirror: false, noLn: false, version: "V 1.2x" } });
    await onRateTabShown();
    $("rate-batch-from").value = "1";
    $("rate-batch-to").value = "1.1";
    $("rate-batch-step").value = "0.1";
    await fire($("rate-batch-from"), "input");
    await fire($("rate-batch-dans"));
    assert.equal($("rate-batch-create").textContent, "Создать отмеченные (2)");
    assert.equal($("rate-batch-create").disabled, true);
    assert.equal($("rate-batch-dans").disabled, false, "its dans can be counted again");
    await sleep(300);
});

test("a mirrored rate map and its original share the original's key: Mirror / No LN still follow which one is selected", async () => {
    const key = "C:/Songs/orig.osu|1";
    const plain = { ...INFO, key };
    const mirrored = { ...INFO, key, origin: { rate: 1.2, virtual: false, mirror: true, noLn: false, version: "V 1.2x (180bpm) Mirror" } };
    const { $, setInfo, seen } = await tab();
    // the original first, then its mirrored rate map: Mirror comes on, the dans worked out unmirrored go
    setInfo(plain);
    await onRateTabShown();
    assert.equal($("rate-mirror").checked, false);
    setInfo(mirrored);
    openRateAt(1.3);
    await onRateTabShown();
    assert.deepEqual([$("rate-mirror").checked, $("rate-noln").checked], [true, false]);
    await sleep(300);
    assert.deepEqual(seen.preview.at(-1), { rate: 1.3, mirror: true, noLn: false }, "the ladder's mirrored ×1.3 row");
    // the same rate map again: the player's own choice stays
    $("rate-noln").checked = true;
    await onRateTabShown();
    assert.deepEqual([$("rate-mirror").checked, $("rate-noln").checked], [true, true]);
    // back to the plain original: Mirror goes off with the rate map, so no Mirror copy of it by surprise
    setInfo(plain);
    await onRateTabShown();
    assert.deepEqual([$("rate-mirror").checked, $("rate-noln").checked], [false, false]);
    assert.equal($("rate-origin-note").hidden, true);
    await sleep(300);
    assert.deepEqual(seen.preview.at(-1), { rate: 1.3, mirror: false, noLn: false });
});
