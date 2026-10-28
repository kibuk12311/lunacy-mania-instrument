// The blocks under the analysis card as HTML: the difficulty line, the pattern strip and its legend, "for you"
// and the ladder of rates, in both languages; nothing for maps without a dan.
import test from "node:test";
import assert from "node:assert/strict";
import {
    renderExtras, strainSvg, familyStrip, familyLegend, forYouLine, ladderRows, ladderRates, formatRate, LADDER_RATES,
} from "../app/renderer/analysisExtras.js";
import { setLang } from "../src/i18n/i18n.js";

const RESULT = {
    kind: "ok", label: "Gamma mid", numeric: 13, primary: "Jumpstream", tech: false, rate: 1, durationSec: 120,
    msd: { jumpstream: 26.04, stream: 24 },
};
const strain = Array.from({ length: 120 }, (_, i) => (i >= 60 && i < 72 ? 1 : 0.4));
const families = Array.from({ length: 120 }, (_, i) => (i < 10 ? "-" : i < 70 ? "jumpstream" : i < 100 ? "handstream" : "tech"));
const DETAILS = { v: 1, durationSec: 120, strain, hardest: [{ fromSec: 60, toSec: 72, peak: 1 }], families };
const SKILL = { overall: 12.5, tiles: { speed: 13.1, stamina: 12.6, tech: 11.9, jack: null }, msd: { Jumpstream: 24.9 } };
const READY = { state: "ready", player: { id: 1, username: "Мира", avatarUrl: "" }, skill: SKILL };
const state = (over = {}) => ({
    view: { screen: "result", result: RESULT, key: "k@1.000" }, details: DETAILS, profile: READY,
    ladder: new Map(), ladderOpen: false, ...over,
});
// the text a reader sees: tags dropped
const plain = (html) => html.replace(/<[^>]*>/g, "");
const inLang = (lang, fn) => {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};

test("nothing is drawn for results that are not ok, or for other screens", () => {
    for (const result of [{ kind: "not-rice", reason: "keys", keys: 7 }, { kind: "too-short" }, { kind: "error", message: "x" }]) {
        assert.equal(renderExtras(state({ view: { screen: "result", result, key: "k" } })), "");
    }
    assert.equal(renderExtras(state({ view: { screen: "loading" } })), "");
    assert.equal(renderExtras(state({ view: null })), "");
    // a view without a key (the file could not be read) has no ladder; with nothing else there is no block at all
    const keyless = renderExtras(state({ view: { screen: "result", result: RESULT } }));
    assert.ok(!keyless.includes("data-toggle"));
    assert.ok(keyless.includes("Для тебя"));
    assert.equal(renderExtras(state({ view: { screen: "result", result: RESULT }, details: null, profile: { state: "idle" } })), "");
});

test("the difficulty line: title, peak chip, the hint, 0:00 and the end", () => {
    const ru = renderExtras(state());
    for (const s of ["Сложность по ходу карты", "пик 1:00–1:12", "Самое тяжёлое: 1:00–1:12 · Sunny strain относительно пика карты", "0:00", "2:00", "<svg"]) {
        assert.ok(ru.includes(s), s);
    }
    const en = inLang("en", () => renderExtras(state()));
    for (const s of ["Difficulty over the map", "peak 1:00–1:12", "Hardest: 1:00–1:12 · Sunny strain relative to the map&#39;s peak"]) assert.ok(en.includes(s), s);
    // without a stand-out stretch the hint keeps its second half
    const flat = renderExtras(state({ details: { ...DETAILS, hardest: [] } }));
    assert.ok(!flat.includes("пик "));
    assert.ok(flat.includes("Sunny strain относительно пика карты"));
    // details not here yet (or failed): the rest still shows
    const none = renderExtras(state({ details: null }));
    assert.ok(!none.includes("<svg"));
    assert.ok(none.includes("Для тебя"));
});

test("strainSvg: one area, the hardest stretch filled apart, scaled into 34 px", () => {
    const svg = strainSvg(strain, DETAILS.hardest, 120);
    assert.match(svg, /^<svg[^>]*viewBox="0 0 120 34"/);
    assert.equal((svg.match(/class="an-tl-area"/g) ?? []).length, 1);
    assert.equal((svg.match(/class="an-tl-hot"/g) ?? []).length, 1);
    assert.equal(strainSvg([], [], 0), "");
});

test("the pattern strip runs families together; the legend has English names and shares, breaks in the language", () => {
    const strip = familyStrip(families);
    assert.equal((strip.match(/<i /g) ?? []).length, 4);
    assert.ok(strip.includes("fam-jumpstream") && strip.includes("fam-handstream") && strip.includes("fam-tech") && strip.includes("fam-break"));
    assert.ok(strip.includes("flex-grow:60"));
    assert.ok(strip.includes("title=\"пауза\""));
    assert.ok(inLang("en", () => familyStrip(families)).includes("title=\"break\""));
    const legend = familyLegend(families);
    for (const s of ["Jumpstream 55%", "Handstream 27%", "Tech 18%"]) assert.ok(legend.includes(s), s);
    assert.ok(legend.indexOf("Jumpstream") < legend.indexOf("Handstream"));
    assert.ok(plain(legend).includes("Jumpstream 55%Handstream 27%Tech 18%"));
    assert.equal(familyLegend(["-", "-"]), "");
});

test("for you: the tile dan, the band and MSD, in both languages", () => {
    const ru = plain(renderExtras(state()));
    for (const s of ["Для тебя (Мира)", "Stamina-дан: Gamma low (12.6) · карта +0.4 — рост — реально пройти", "MSD Jumpstream: 26.0 против твоих 24.9 (+1.1)"]) {
        assert.ok(ru.includes(s), s);
    }
    const en = plain(inLang("en", () => renderExtras(state())));
    for (const s of ["For you (Мира)", "Stamina dan: Gamma low (12.6) · map +0.4 — growth — a doable push", "MSD Jumpstream: 26.0 vs your 24.9 (+1.1)"]) {
        assert.ok(en.includes(s), s);
    }
    // the jack tile has no dan: the overall one
    const jack = renderExtras(state({ view: { screen: "result", result: { ...RESULT, primary: "Minijacks", numeric: 11.8 }, key: "k" } }));
    assert.ok(jack.includes("общий дан: Gamma low (12.5) · карта −0.7 — легко — разминка"), jack);
});

test("for you without a ready profile: loading, the failure, the link to the picks tab, nothing while idle", () => {
    assert.ok(forYouLine(null, { state: "loading" }).includes("Загружаем профиль…"));
    assert.ok(forYouLine(null, { state: "failed", message: "нет сети" }).includes("Профиль не загрузился: нет сети"));
    const link = forYouLine(null, { state: "none" });
    assert.ok(link.includes("data-go=\"recommend\""));
    assert.ok(link.includes("Сравнить с твоим скиллом — укажи ник во вкладке «Подбор»"));
    assert.ok(inLang("en", () => forYouLine(null, { state: "none" })).includes("Compare with your skill — set your nick in the Picks tab"));
    assert.equal(forYouLine(null, { state: "idle" }), "");
    assert.ok(forYouLine(null, READY).includes("На трекере пока нет твоего дана"));
});

test("the ladder: folded by default, rows with data-rate, now and growth marks, deltas from 1.0x", () => {
    const folded = renderExtras(state());
    assert.ok(folded.includes("Дан на рейтах ▸"));
    assert.ok(folded.includes("data-toggle=\"ladder\""));
    assert.ok(!folded.includes("data-rate="));

    const ladder = new Map([[0.9, { state: "ok", numeric: 12.4 }], [1.1, { state: "ok", numeric: 13.5 }], [1.2, { state: "ok", numeric: 13.9 }],
        [1.3, { state: "pending" }], [1.4, { state: "fail" }], [1.5, { state: "ok", numeric: 15.2 }]]);
    const open = renderExtras(state({ ladderOpen: true, ladder }));
    assert.ok(open.includes("Дан на рейтах ▾"));
    for (const rate of LADDER_RATES) assert.ok(open.includes(`data-rate="${rate}"`), String(rate));
    assert.ok(open.includes("1.2×"));
    assert.ok(open.includes("Delta low/mid"));
    assert.ok(open.includes("13.9"));
    assert.ok(open.includes("+0.9"));
    assert.ok(open.includes("считаем…"));
    assert.ok(open.includes("—"));
    assert.ok(open.includes("● сейчас"));
    assert.ok(open.includes("твой рост"));
    assert.ok(open.includes("нажми — открыть во вкладке «Рейт»"));
    const en = inLang("en", () => renderExtras(state({ ladderOpen: true, ladder })));
    for (const s of ["Dan by rate ▾", "● now", "your growth", "counting…", "click to open in the Rate tab"]) assert.ok(en.includes(s), s);
});

test("the ladder of a rate map: the now row is its original's from the ladder (counting until then), not the card's dan", () => {
    const view = { screen: "result", result: { ...RESULT, numeric: 13, rate: 1.2 }, key: "k", rateMap: { rate: 1.2, virtual: false } };
    const ladder = new Map([[1, { state: "ok", numeric: 12 }]]);
    const row = (html) => /<button[^>]*data-rate="1\.2".*?<\/button>/.exec(html)?.[0] ?? "";
    const counting = row(renderExtras(state({ view, ladderOpen: true, ladder })));
    assert.ok(counting.includes("an-lnow") && counting.includes("считаем…"), counting);
    assert.ok(!counting.includes("13.0"));
    ladder.set(1.2, { state: "ok", numeric: 13.4 });
    const known = row(renderExtras(state({ view, ladderOpen: true, ladder })));
    assert.ok(known.includes("an-lnow") && known.includes("13.4") && known.includes("+1.4"), known);
    // a plain map: the now row is the card's own, as before
    const plainRow = row(renderExtras(state({ view: { ...view, rateMap: undefined }, ladderOpen: true, ladder })));
    assert.ok(plainRow.includes("13.0") && plainRow.includes("+1.0"), plainRow);
});

test("the ladder of a rate map past its range (DT on a 1.5x one): the original's rows, none marked now", () => {
    const view = { screen: "result", result: { ...RESULT, numeric: 13, rate: 1.5 }, key: "k", rateMap: { rate: 1.5, virtual: false, beyond: true } };
    const ladder = new Map([[1, { state: "ok", numeric: 8 }], [1.5, { state: "ok", numeric: 9.9 }]]);
    const html = renderExtras(state({ view, ladderOpen: true, ladder }));
    assert.ok(!html.includes("an-lnow") && !html.includes("an-now"), "no row of the original is the one played");
    const row = /<button[^>]*data-rate="1\.5".*?<\/button>/.exec(html)?.[0] ?? "";
    assert.ok(row.includes("9.9") && !row.includes("13.0"), row);
});

test("ladderRows: the now mark sits on the current rate, growth on its rate, the 1.0x row has no delta", () => {
    const rows = [
        { rate: 1, state: "ok", numeric: 13 },
        { rate: 1.1, state: "ok", numeric: 13.4 },
        { rate: 1.5, state: "ok", numeric: 15.1 },
    ];
    const html = ladderRows(rows, { currentRate: 1.5, growthRate: 1.1 });
    const row = (rate) => html.split("<button").find((part) => part.includes(`data-rate="${rate}"`));
    assert.ok(row(1.5).includes("● сейчас") && !row(1.5).includes("твой рост"));
    assert.ok(row(1.1).includes("твой рост") && row(1.1).includes("+0.4"));
    assert.ok(!row(1).includes("+") && !row(1).includes("−"));
    assert.ok(row(1.5).includes("+2.1"));
});

test("ladderRates puts a current rate off the list in its place; formatRate keeps one decimal at least", () => {
    assert.deepEqual(LADDER_RATES, [0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5]);
    assert.deepEqual(ladderRates(1.5), LADDER_RATES);
    assert.deepEqual(ladderRates(0.75), [0.75, ...LADDER_RATES]);
    assert.deepEqual(ladderRates(1.15), LADDER_RATES);
    assert.deepEqual(ladderRates(1.12), [0.9, 0.95, 1, 1.05, 1.1, 1.12, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5]);
    assert.deepEqual([1, 0.9, 1.15, 0.75].map(formatRate), ["1.0", "0.9", "1.15", "0.75"]);
});

test("everything from outside is escaped", () => {
    const evil = { state: "ready", player: { username: "<b>x</b>" }, skill: SKILL };
    const html = renderExtras(state({ profile: evil }));
    assert.ok(!html.includes("<b>x</b>"));
    assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
    const failed = forYouLine(null, { state: "failed", message: "<img src=x>" });
    assert.ok(!failed.includes("<img"));
    assert.ok(!familyStrip(["<i>", "stream"]).includes("<i>\""));
});
