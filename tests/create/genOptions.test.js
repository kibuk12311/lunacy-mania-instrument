// The generator options (app/renderer/genOptions.js, addendum §6, §11 / U2): the model picker (0.9.0: Classic, the
// default and what "auto" runs, then the experimental XGBoost v3 and Neural net S / M / L, each with a line on why it
// is experimental and where it runs, the ones that cannot run greyed out with the reason), the number of candidates
// (default 1: no critic), the style from generator-info and the repeats box; what the request carries; the choices
// and measured times remembered; 2 cards per run when the critic picks from several candidates.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import {
    createGenOptions, sizeChoices, autoPick, sizeLine, loadOptions, CARDS_WITH_CRITIC, DEFAULT_CANDIDATES, STORE_KEY, MODEL_SIZES, EXPERIMENTAL,
    stylesOf, styleName, styleOptionText, styleMatches,
} from "../../app/renderer/genOptions.js";

const all = (n) => [n, ...n.children.flatMap(all)];
const sizeButton = (root, size) => all(root).find((n) => n.tagName === "BUTTON" && n.dataset.size === size);
const byRole = (root, role) => all(root).find((n) => n.dataset?.role === role);
const INFO = {
    kind: "nn-v2", grid: "snap-v2", maps: 900, size: "s", critic: "critic-v1", engines: ["neural", "learned", "rules"],
    styles: [{ key: "mapperA", name: "Mapper A", maps: 40 }, { key: "mapperB", name: "Mapper B", maps: 31 }],
    sizes: { auto: true, xgb3: true, s: true, m: true, l: true, distilled: true }, modelSizes: MODEL_SIZES,
};

async function options({ info = INFO, gpu = false, storage = {}, failInfo = false } = {}) {
    let answer = info;
    const dom = fakeDom({ generatorInfo: async () => { if (failInfo) throw new Error("no channel"); return { ok: true, modelInfo: answer }; } }, { storage });
    const root = dom.$("gen-options");
    root.hidden = true;
    const opts = createGenOptions({ root, gpu: async () => gpu });
    await opts.ready;
    return { ...dom, root, opts, setInfo: (next) => { answer = next; } };
}

test("defaults: Classic (auto), 1 candidate (no critic), no style, repeats on; all five models are offered", async () => {
    setLang("en");
    try {
        const { root, opts } = await options();
        assert.equal(root.hidden, false);
        assert.deepEqual(MODEL_SIZES, ["auto", "xgb3", "s", "m", "l"]);
        assert.deepEqual(opts.request(), { modelSize: "auto", candidates: DEFAULT_CANDIDATES, style: null, repeats: true });
        assert.equal(DEFAULT_CANDIDATES, 1);
        const text = textOf(root);
        for (const name of ["Model", "Classic", "XGBoost v3 (experimental)", "Neural net S (experimental, fast)", "Neural net M (experimental)",
            "Neural net L (experimental, needs a graphics card)", "Candidates to choose from", "Mapper style", "Repeats get similar patterns"]) {
            assert.ok(text.includes(name), `${name} in ${text}`);
        }
        assert.ok(sizeButton(root, "auto").className.includes("sel"));
        assert.ok(!sizeButton(root, "auto").className.includes("exp"));
        for (const size of EXPERIMENTAL) assert.ok(sizeButton(root, size).className.includes("exp"), size);
        assert.ok(text.includes("one candidate, no critic"));
        assert.equal(opts.variants(3), 3, "no critic: the usual number of cards");
        assert.equal(loadOptions(() => null).candidates, 1);
    } finally {
        setLang("ru");
    }
});

test("the picker: Classic is the proven default; each experimental option says why; L needs a graphics card and its file", async () => {
    setLang("en");
    try {
        const noGpu = await options({ gpu: false });
        assert.ok(textOf(sizeButton(noGpu.root, "auto")).includes("the proven model, used by default · on the CPU"), textOf(sizeButton(noGpu.root, "auto")));
        assert.ok(textOf(sizeButton(noGpu.root, "xgb3")).includes("experimental: hits the dan more often, but its patterns are a little weaker · on the CPU"));
        assert.ok(textOf(sizeButton(noGpu.root, "s")).includes("experimental: closer to the dan, but the notes feel less hand-made · on the CPU"), textOf(sizeButton(noGpu.root, "s")));
        assert.ok(textOf(sizeButton(noGpu.root, "m")).includes("experimental: best at hitting the dan, but the notes feel less hand-made"));
        const l = sizeButton(noGpu.root, "l");
        assert.equal(l.disabled, true);
        assert.ok(textOf(l).includes("experimental: the largest neural net · needs a graphics card — none found here"), textOf(l));
        await fire(l);
        assert.equal(noGpu.opts.request().modelSize, "auto", "a greyed-out choice cannot be picked");
        await fire(sizeButton(noGpu.root, "xgb3"));
        assert.equal(noGpu.opts.request().modelSize, "xgb3");

        const withGpu = await options({ gpu: true });
        assert.equal(sizeButton(withGpu.root, "l").disabled, false);
        assert.ok(textOf(sizeButton(withGpu.root, "l")).includes("on the graphics card"));
        assert.ok(textOf(sizeButton(withGpu.root, "auto")).includes("on the CPU"), "auto stays the classic model with a GPU");
        await fire(sizeButton(withGpu.root, "l"));
        assert.equal(withGpu.opts.request().modelSize, "l");

        // L is still training: without its file it is greyed out and says so, even with a graphics card
        const noL = await options({ gpu: true, info: { ...INFO, sizes: { ...INFO.sizes, l: false } } });
        assert.equal(sizeButton(noL.root, "l").disabled, true);
        assert.ok(textOf(sizeButton(noL.root, "l")).includes("still training — coming in a later update"), textOf(sizeButton(noL.root, "l")));

        const noFiles = await options({ gpu: true, info: { ...INFO, sizes: { auto: true, xgb3: false, s: false, m: false, l: false, distilled: false }, engines: ["learned", "rules"] } });
        for (const size of ["xgb3", "s", "m"]) {
            assert.equal(sizeButton(noFiles.root, size).disabled, true, size);
            assert.ok(textOf(sizeButton(noFiles.root, size)).includes("model not installed yet"), size);
        }
        assert.equal(sizeButton(noFiles.root, "auto").disabled, false);
        const noClassic = await options({ info: { ...INFO, sizes: { ...INFO.sizes, auto: false } } });
        assert.equal(sizeButton(noClassic.root, "auto").disabled, false, "auto is always open");
        assert.ok(textOf(sizeButton(noClassic.root, "auto")).includes("now: rules"));
        // the worker's own word on the graphics card wins over this window's
        assert.equal(sizeChoices({ ...INFO, gpu: false }, { gpu: false }).find((c) => c.size === "l").why, "noGpu");
        const reported = await options({ gpu: true, info: { ...INFO, gpu: false } });
        assert.equal(sizeButton(reported.root, "l").disabled, true);
        // stream W's shape: { gpuAvailable, adapter, reason, decoder }
        const failedProbe = await options({ gpu: true, info: { ...INFO, gpu: { gpuAvailable: false, adapter: "x", reason: "parity", decoder: "cpu" } } });
        assert.equal(sizeButton(failedProbe.root, "l").disabled, true);
        const workerGpu = await options({ gpu: false, info: { ...INFO, gpu: { gpuAvailable: true, adapter: "x", reason: null, decoder: "cpu" } } });
        assert.equal(sizeButton(workerGpu.root, "l").disabled, false);
    } finally {
        setLang("ru");
    }
});

test("the picker in Russian: the names and the experimental hints", async () => {
    const { root } = await options({ gpu: false });
    const text = textOf(root);
    for (const name of ["Модель", "Классическая", "XGBoost v3 (эксперимент)", "Нейросеть S (эксперимент, быстрая)", "Нейросеть M (эксперимент)",
        "Нейросеть L (эксперимент, нужна видеокарта)", "проверенная модель — по умолчанию"]) {
        assert.ok(text.includes(name), `${name} in ${text}`);
    }
    for (const size of EXPERIMENTAL) assert.ok(textOf(sizeButton(root, size)).includes("эксперимент:"), size);
});

test("the helpers: auto is the classic model (null only when generator-info says it is missing); unknown files count as there", () => {
    assert.equal(autoPick(INFO), "auto");
    assert.equal(autoPick(null), "auto");
    assert.equal(autoPick({ sizes: { auto: false } }), null);
    assert.deepEqual(sizeChoices(null, { gpu: true }).map((c) => c.ok), [true, true, true, true, true]);
    assert.deepEqual(sizeChoices(null, { gpu: false }).map((c) => [c.size, c.ok, c.why]),
        [["auto", true, null], ["xgb3", true, null], ["s", true, null], ["m", true, null], ["l", false, "noGpu"]]);
    assert.deepEqual(sizeChoices({ sizes: { s: true } }, { gpu: true }).map((c) => c.ok), [true, true, true, true, true], "an older main without the keys");
    setLang("en");
    try {
        const line = sizeLine({ size: "m", ok: true, onGpu: false }, { info: INFO, times: { m: 4200 } });
        assert.equal(line, "experimental: best at hitting the dan, but the notes feel less hand-made · on the CPU · ≈4.2 s per variant");
    } finally {
        setLang("ru");
    }
});

test("the choices are remembered; one that became impossible is sent as auto", async () => {
    const storage = {};
    const first = await options({ gpu: true, storage });
    await fire(sizeButton(first.root, "m"));
    const count = byRole(first.root, "candidates");
    count.value = "5";
    await fire(count, "input");
    await fire(count, "change");
    const style = byRole(first.root, "style");
    style.value = "mapperB";
    await fire(style, "change");
    const repeats = byRole(first.root, "repeats");
    repeats.checked = false;
    await fire(repeats, "change");
    const saved = JSON.parse(first.storage.get(STORE_KEY));
    assert.deepEqual(saved, { modelSize: "m", candidates: 5, style: "mapperB", repeats: false });
    assert.deepEqual(first.opts.request(), { modelSize: "m", candidates: 5, style: "mapperB", repeats: false });

    const again = await options({ gpu: true, storage: Object.fromEntries(first.storage) });
    assert.deepEqual(again.opts.request(), { modelSize: "m", candidates: 5, style: "mapperB", repeats: false });
    assert.equal(byRole(again.root, "candidates").value, "5");

    // the file of M is gone and so are the styles: the request falls back, the choice stays remembered
    const gone = await options({ gpu: true, storage: Object.fromEntries(first.storage), info: { ...INFO, styles: [], sizes: { ...INFO.sizes, m: false } } });
    assert.deepEqual(gone.opts.request(), { modelSize: "auto", candidates: 5, style: null, repeats: false });
    assert.equal(byRole(gone.root, "style").disabled, true);
    assert.equal(loadOptions(() => ({ getItem: () => "{broken" })).modelSize, "auto", "a broken entry gives the defaults");
});

test("cards per run: 2 when the critic picks from several candidates, else the usual number", async () => {
    const { root, opts } = await options();
    assert.equal(CARDS_WITH_CRITIC, 2);
    assert.equal(opts.variants(3), 3);
    const count = byRole(root, "candidates");
    count.value = "8";
    await fire(count, "change");
    assert.equal(opts.variants(3), 2);
    assert.equal(opts.request().candidates, 8);
    count.value = "1";
    await fire(count, "change");
    assert.equal(opts.variants(3), 3);
    assert.equal(opts.request().candidates, 1);
});

test("the style list comes from generator-info and follows it when it is asked again", async () => {
    setLang("en");
    try {
        const { root, opts, setInfo } = await options({ info: { ...INFO, styles: [] } });
        const style = byRole(root, "style");
        assert.equal(style.disabled, true);
        assert.equal(textOf(style), "No style");
        setInfo(INFO);
        await opts.refresh();
        assert.equal(style.disabled, false);
        assert.deepEqual(style.children.map((o) => [o.value, o.textContent]), [["", "No style"], ["mapperA", "Mapper A · 40 maps"], ["mapperB", "Mapper B · 31 maps"]]);
        style.value = "mapperA";
        await fire(style, "change");
        assert.equal(opts.request().style, "mapperA");
    } finally {
        setLang("ru");
    }
});

test("repeats need the song's stems: off with a hint without them, on again with them", async () => {
    setLang("en");
    try {
        const { root, opts } = await options();
        opts.setStems(false);
        const repeats = byRole(root, "repeats");
        assert.equal(repeats.disabled, true);
        assert.equal(opts.request().repeats, false);
        assert.ok(textOf(root).includes("needs the sound breakdown — reload the song"));
        opts.setStems(true);
        assert.equal(repeats.disabled, false);
        assert.equal(opts.request().repeats, true);
    } finally {
        setLang("ru");
    }
});

test("measured times: per variant on the option that ran, per candidate in the slider's hint", async () => {
    setLang("en");
    try {
        const { root, opts } = await options({ gpu: true });
        opts.noteAnswer({ ms: 3400, modelInfo: { size: null } }, "auto");
        assert.ok(textOf(sizeButton(root, "auto")).includes("≈3.4 s per variant"), textOf(sizeButton(root, "auto")));
        opts.noteAnswer({ ms: 5100, modelInfo: { size: "s" } }, "s");
        assert.ok(textOf(sizeButton(root, "s")).includes("≈5.1 s per variant"));
        // M was asked for but the classic model ran (no stems): the time is the classic model's
        opts.noteAnswer({ ms: 2600, modelInfo: { size: null, sizeNote: { want: "m", got: "auto" } } }, "m");
        assert.ok(textOf(sizeButton(root, "auto")).includes("≈2.6 s per variant"));
        assert.ok(!textOf(sizeButton(root, "m")).includes("per variant"));
        const count = byRole(root, "candidates");
        count.value = "12";
        await fire(count, "input");
        opts.noteAnswer({ ms: 3400, modelInfo: { size: null }, critic: { ms: 1200, of: 12 } }, "auto");
        assert.ok(textOf(root).includes("the critic picks the best · ≈1.2 s"), "12 candidates × 100 ms");
        count.value = "1";
        await fire(count, "input");
        assert.ok(textOf(root).includes("one candidate, no critic"));
    } finally {
        setLang("ru");
    }
});

test("without generator-info (an older main) every size with a file unknown stays open but L still needs a GPU", async () => {
    const { root, opts } = await options({ failInfo: true, gpu: false });
    assert.equal(sizeButton(root, "s").disabled, false);
    assert.equal(sizeButton(root, "m").disabled, false);
    assert.equal(sizeButton(root, "l").disabled, true);
    assert.equal(opts.request().modelSize, "auto");
});

// merge of streams U and W: generator-info starts main's GPU renderer only once this window asked for an adapter
test("with probeAtStart false, generator-info is asked with gpu: false until askGpu(), then with gpu: true", async () => {
    const asks = [];
    const dom = fakeDom({ generatorInfo: async (o) => { asks.push(o); return { ok: true, modelInfo: { ...INFO, gpu: asks.length > 1 ? { gpuAvailable: true, adapter: "x", reason: null, decoder: "cpu" } : null } }; } }, { storage: {} });
    const root = dom.$("gen-options");
    const opts = createGenOptions({ root, gpu: async () => false, probeAtStart: false });
    await opts.ready;
    assert.deepEqual(asks, [{ gpu: false }]);
    assert.equal(sizeButton(root, "l").disabled, true, "no GPU known yet");
    await opts.askGpu();
    assert.deepEqual(asks, [{ gpu: false }, { gpu: true }]);
    assert.equal(sizeButton(root, "l").disabled, false, "the worker's GPU counts");
    await opts.refresh();
    assert.deepEqual(asks.at(-1), { gpu: true });
});

// ---- 0.9.5: the style list of the model picked, before anything was generated ----

// generator-info's stylesBySize as main sends it (app/modelStyles.js); the nn-v2 lists carry raw keys as names
const XGB = [
    { key: "n:dani", name: "Dani", maps: 185 }, { key: "n:magikarp1234", name: "Magikarp1234", maps: 288 },
    { key: "u:13747903", name: "[Crz]hinako1804", maps: 230 }, { key: "u:77", name: null, user: "77", maps: 1 },
];
const NN = [{ key: "n:magikarp1234", name: "Magikarp1234", maps: 288 }, { key: "n:-beajek-", name: "n:-beajek-", maps: 115 }];
const BY_SIZE = { ...INFO, styles: [], stylesBySize: { auto: [], xgb3: XGB, s: NN, m: NN, l: NN } };
const optionTexts = (style) => style.children.map((o) => o.textContent);

test("Classic has no styles: the list is off and says why; XGBoost v3 and the nn show their own lists at once", async () => {
    setLang("en");
    try {
        const { root, opts } = await options({ gpu: true, info: BY_SIZE });
        const style = byRole(root, "style");
        const hint = byRole(root, "style-hint");
        assert.equal(style.disabled, true);
        assert.equal(byRole(root, "style-filter").hidden, true);
        assert.equal(hint.textContent, "the classic model has no styles — pick XGBoost v3 or a neural net");
        await fire(sizeButton(root, "xgb3"));
        assert.equal(style.disabled, false);
        assert.deepEqual(optionTexts(style), ["No style", "Magikarp1234 · 288 maps", "[Crz]hinako1804 · 230 maps", "Dani · 185 maps", "mapper #77 · 1 map"], "most maps first");
        assert.ok(hint.textContent.includes("on XGBoost v3 a style does little"), hint.textContent);
        await fire(sizeButton(root, "s"));
        assert.deepEqual(optionTexts(style), ["No style", "Magikarp1234 · 288 maps", "-beajek- · 115 maps"], "the n: prefix goes");
        assert.ok(hint.textContent.includes("gently moves the notes"), hint.textContent);
        assert.equal(opts.request().style, null);
    } finally {
        setLang("ru");
    }
});

test("another model keeps the style when it has it, else «Без стиля» with a note; the request carries the model's own", async () => {
    setLang("en");
    try {
        const { root, opts } = await options({ gpu: true, info: BY_SIZE });
        const style = byRole(root, "style");
        await fire(sizeButton(root, "xgb3"));
        style.value = "n:magikarp1234";
        await fire(style, "change");
        assert.deepEqual(opts.request(), { modelSize: "xgb3", candidates: 1, style: "n:magikarp1234", repeats: true });
        await fire(sizeButton(root, "m"));
        assert.equal(opts.request().style, "n:magikarp1234", "M has it too");
        assert.equal(style.value, "n:magikarp1234");
        await fire(sizeButton(root, "xgb3"));
        style.value = "n:dani";
        await fire(style, "change");
        await fire(sizeButton(root, "s"));
        assert.equal(opts.request().style, null);
        assert.equal(opts.chosen.style, null);
        assert.equal(style.value, "");
        const note = byRole(root, "style-hint").textContent;
        assert.ok(note.startsWith("“Neural net S (experimental, fast)” has no “Dani” style"), note);
        await fire(sizeButton(root, "xgb3"));
        assert.ok(!byRole(root, "style-hint").textContent.includes("has no"), "the note goes with the next pick");
        // to Classic: nothing to keep
        style.value = "n:dani";
        await fire(style, "change");
        await fire(sizeButton(root, "auto"));
        assert.equal(opts.request().style, null);
        assert.ok(byRole(root, "style-hint").textContent.includes("“Classic” has no “Dani” style"));
    } finally {
        setLang("ru");
    }
});

test("the search box filters the list (name or key, any case), Enter takes the first match, Esc clears it", async () => {
    setLang("en");
    try {
        const many = Array.from({ length: 121 }, (_, i) => ({ key: `n:m${i}`, name: `Mapper ${i}`, maps: 200 - i }));
        const { root, opts } = await options({ gpu: true, info: { ...BY_SIZE, stylesBySize: { ...BY_SIZE.stylesBySize, xgb3: [...XGB, ...many] } } });
        await fire(sizeButton(root, "xgb3"));
        const style = byRole(root, "style");
        const filter = byRole(root, "style-filter");
        assert.equal(filter.hidden, false);
        assert.equal(style.children.length, 1 + 125);
        filter.value = "CRZ";
        await fire(filter, "input");
        assert.deepEqual(optionTexts(style), ["No style", "[Crz]hinako1804 · 230 maps"]);
        assert.ok(byRole(root, "style-hint").textContent.includes("1 of 125 found"));
        filter.value = "mapper 12";
        await fire(filter, "input");
        assert.deepEqual(optionTexts(style).slice(0, 3), ["No style", "Mapper 12 · 188 maps", "Mapper 120 · 80 maps"]);
        await fire(filter, "keydown", { key: "Enter" });
        assert.equal(opts.request().style, "n:m12");
        // the chosen style stays in the list whatever the search
        filter.value = "zzz";
        await fire(filter, "input");
        assert.deepEqual(optionTexts(style), ["No style", "Mapper 12 · 188 maps"]);
        assert.ok(byRole(root, "style-hint").textContent.includes("nothing found — clear the search"));
        await fire(filter, "keydown", { key: "Enter" });
        assert.equal(opts.request().style, "n:m12", "Enter with no match changes nothing");
        await fire(filter, "keydown", { key: "Escape" });
        assert.equal(filter.value, "");
        assert.equal(style.children.length, 1 + 125);
        let focused = false;
        style.focus = () => { focused = true; };
        await fire(filter, "keydown", { key: "ArrowDown" });
        assert.equal(focused, true, "the down arrow goes into the list");
    } finally {
        setLang("ru");
    }
});

test("style names and the option text: plural maps in ru, «маппер #id» for an osu! user without a name; an older main's styles", () => {
    setLang("ru");
    assert.equal(styleOptionText({ key: "n:a", name: "A", maps: 1 }), "A · 1 карта");
    assert.equal(styleOptionText({ key: "n:a", name: "A", maps: 3 }), "A · 3 карты");
    assert.equal(styleOptionText({ key: "n:a", name: "A", maps: 288 }), "A · 288 карт");
    assert.equal(styleOptionText({ key: "n:a", name: "A", maps: 11 }), "A · 11 карт");
    assert.equal(styleName({ key: "u:5", name: null, user: "5" }), "маппер #5");
    assert.ok(styleMatches({ key: "u:5", user: "5" }, "маппер #5"));
    assert.ok(styleMatches({ key: "n:dani", name: "Dani" }, "n:da"));
    assert.ok(!styleMatches({ key: "n:dani", name: "Dani" }, "x"));
    // an older main: no stylesBySize, the last model's styles for every choice
    assert.deepEqual(stylesOf({ styles: [{ key: "k", name: "K", maps: 2 }] }, "xgb3"), [{ key: "k", name: "K", user: null, maps: 2 }]);
    assert.deepEqual(stylesOf({ styles: [{ key: "k", name: "K", maps: 2 }], stylesBySize: { auto: [] } }, "auto"), []);
    assert.deepEqual(stylesOf(null, "s"), []);
});

test("0.9.8 «Автоподбор»: available() says what can run; apply() sets the model, candidates and repeats and remembers them", async () => {
    const { opts, storage } = await options({ gpu: true });
    opts.setStems(true);
    const can = opts.available();
    assert.equal(can.sizes.auto, true);
    assert.equal(can.sizes.m, true);
    assert.equal(can.gpu, true);
    assert.equal(can.stems, true);
    assert.equal(can.critic, true);
    opts.apply({ modelSize: "m", candidates: 4, repeats: true });
    assert.deepEqual(opts.request(), { modelSize: "m", candidates: 4, style: null, repeats: true });
    assert.equal(JSON.parse(storage.get(STORE_KEY)).modelSize, "m");
    assert.equal(opts.variants(3), CARDS_WITH_CRITIC);
    // an unknown size is ignored; the rest still applies
    opts.apply({ modelSize: "zz", candidates: 1 });
    assert.equal(opts.request().modelSize, "m");
    assert.equal(opts.request().candidates, 1);
    // a file that is not there is not offered
    const { opts: few } = await options({ info: { ...INFO, sizes: { auto: true, xgb3: false, s: false, m: false, l: false } } });
    assert.deepEqual(Object.entries(few.available().sizes).filter(([, v]) => v).map(([k]) => k), ["auto"]);
});
