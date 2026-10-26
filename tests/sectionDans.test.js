// «Дан по частям» under the analysis card: the chart's geometry (bars along the time, dans on the axis, the whole map's
// line), the block's HTML in Russian and English (counting, failed, the hardest part, the part told below), its place
// among the blocks, and the panel taking the parts from main and a tapped part.
import test from "node:test";
import assert from "node:assert/strict";
import { levelName, partInfo, sectionGeometry, sectionsBlock } from "../app/renderer/sectionDans.js";
import { renderExtras } from "../app/renderer/analysisExtras.js";
import { createAnalysisPanel } from "../app/renderer/analysisPanel.js";
import { fakeDom, fire } from "./helpers/fakeDom.js";
import { setLang } from "../src/i18n/i18n.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const inLang = (lang, fn) => {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const SECTIONS = {
    v: 1, rate: 1, durationSec: 200, top: 2,
    parts: [
        { fromSec: 0, toSec: 30, notes: 200, raw: 11.8, dan: 12, primary: "Stream", tech: false },
        { fromSec: 30, toSec: 40, notes: 9, raw: null, dan: null, primary: null, tech: false },
        { fromSec: 50, toSec: 95, notes: 900, raw: 14.4, dan: 14.6, primary: "Jumpstream", tech: false },
        { fromSec: 95, toSec: 200, notes: 1500, raw: 13.9, dan: 13.8, primary: "Jacks", tech: true },
    ],
};
const RESULT = { kind: "ok", label: "Delta mid", numeric: 14, primary: "Jumpstream", tech: false, rate: 1, durationSec: 200, msd: {} };

test("levels on the axis: numbers to 10, Greek names after, nothing outside the scale", () => {
    assert.equal(levelName(7), "7");
    assert.equal(levelName(14), "Delta");
    assert.equal(levelName(20), "Kappa");
    assert.equal(levelName(21), "");
    assert.equal(levelName(0), "");
});

test("geometry: bars where the parts are in time, as tall as their dans, a quiet part flat, the whole map's line", () => {
    const g = sectionGeometry(SECTIONS, 14);
    assert.deepEqual([g.lo, g.hi], [11, 16], "a dan of room under the lowest and over the highest");
    assert.equal(g.bars.length, 4);
    assert.deepEqual(g.bars.map((b) => Math.round(b.left)), [0, 15, 25, 48]);
    assert.deepEqual(g.bars.map((b) => Math.round(b.width * 10) / 10), [15, 5, 22.5, 52.5]);
    assert.equal(g.bars[0].height, 20, "12 on 11..16");
    assert.equal(g.bars[1].quiet, true);
    assert.equal(g.bars[1].height, 0);
    assert.equal(g.bars[2].top, true);
    assert.equal(g.bars.filter((b) => b.top).length, 1);
    assert.equal(g.map, 60, "the whole map's 14 on 11..16");
    assert.ok(Math.abs(g.bars[2].height - 72) < 1e-9);
    assert.deepEqual(g.ticks.map((k) => k.name), ["Beta", "Delta", "Zeta"], "every second dan on five dans of scale");
    assert.deepEqual(g.ticks.map((k) => k.at), [20, 60, 100]);
    // a flat map stays flat and at least four dans tall; low dans keep 0 as their floor
    const flat = sectionGeometry({ durationSec: 60, top: 0, parts: [{ fromSec: 0, toSec: 60, dan: 1.5 }] }, 1.5);
    assert.ok(flat.hi - flat.lo >= 4 && flat.lo === 0);
    // a long map: at most five names on the axis
    const wide = sectionGeometry({ durationSec: 60, top: 1, parts: [{ fromSec: 0, toSec: 30, dan: 2 }, { fromSec: 30, toSec: 60, dan: 18 }] }, 17);
    assert.ok(wide.ticks.length <= 5 && wide.ticks.length >= 3, `${wide.ticks.length} ticks`);
    assert.equal(sectionGeometry({ parts: [{ fromSec: 0, toSec: 10, dan: null }] }, 10), null);
    assert.equal(sectionGeometry(null, 10), null);
});

test("a part in words, Russian and English: time, the dan's name and number, its pattern, the hardest said", () => {
    assert.equal(partInfo(SECTIONS.parts[2], { top: true }), "0:50–1:35 · Epsilon low · 14.6 · Jumpstream · самая сложная часть");
    assert.equal(partInfo(SECTIONS.parts[3]), "1:35–3:20 · Delta low/mid · 13.8 · Jacks · tech");
    assert.equal(partInfo(SECTIONS.parts[1]), "0:30–0:40 · тихая часть: мало нот для дана");
    assert.equal(inLang("en", () => partInfo(SECTIONS.parts[2], { top: true })), "0:50–1:35 · Epsilon low · 14.6 · Jumpstream · the hardest part");
    assert.equal(inLang("en", () => partInfo(SECTIONS.parts[1])), "0:30–0:40 · a quiet part: too few notes for a dan");
    assert.equal(partInfo({ fromSec: 0, toSec: 30, dan: 21.4, primary: "Stream" }), "0:00–0:30 · выше Kappa · 21.4 · Stream");
});

test("the block: counting, failed, no dan anywhere; the chart with names, the hardest marked, the whole map's line", () => {
    assert.ok(plain(sectionsBlock(undefined)).includes("Дан по частям считаем дан каждой части…"));
    assert.ok(plain(inLang("en", () => sectionsBlock(undefined))).includes("Dan by part working out each part's dan…"));
    assert.ok(plain(sectionsBlock(null)).includes("не вышло"));
    assert.ok(plain(inLang("en", () => sectionsBlock(null))).includes("Couldn't work out the dan by part"));
    assert.ok(plain(sectionsBlock({ ...SECTIONS, top: -1, parts: [SECTIONS.parts[1]] })).includes("нет частей"));

    const html = sectionsBlock(SECTIONS, { mapDan: 14 });
    const text = plain(html);
    assert.ok(text.includes("самая сложная 0:50–1:35 · Epsilon low"), "the chip");
    assert.ok(text.includes("вся карта: Delta mid"), "the whole map's line");
    for (const name of ["Beta", "Delta", "Zeta"]) assert.ok(text.includes(name), `${name} on the axis`);
    assert.equal((html.match(/data-part="/g) ?? []).length, 4, "a bar for each part, the quiet one too");
    assert.equal((html.match(/an-sec-top/g) ?? []).length, 1);
    assert.ok(/class="an-sec-bar fam-jumpstream an-sec-top an-sec-sel" data-part="2"/.test(html), "the hardest: its family's colour, marked and told");
    assert.ok(html.includes('class="an-sec-bar fam-tech" data-part="3"'), "tech coloured as tech");
    assert.ok(html.includes("an-sec-quiet"));
    assert.ok(html.includes('<span class="an-sec-name">Epsilon low</span>'), "the dan's name on a wide bar");
    assert.ok(!/data-part="1"[^>]*>[^<]*<span class="an-sec-name">/.test(html), "none on the quiet one");
    assert.ok(text.includes("0:50–1:35 · Epsilon low · 14.6 · Jumpstream · самая сложная часть"), "the hardest told below");
    assert.ok(text.includes("0:00") && text.includes("3:20"), "the time axis");
    // a tapped part is told instead
    const tapped = sectionsBlock(SECTIONS, { mapDan: 14, selected: 0 });
    assert.ok(/<div class="an-sec-info"[^>]*>0:00–0:30 · Beta mid · 12.0 · Stream<\/div>/.test(tapped));
    assert.ok(tapped.includes('an-sec-bar fam-stream an-sec-sel" data-part="0"'));
    // English
    const en = plain(inLang("en", () => sectionsBlock(SECTIONS, { mapDan: 14 })));
    assert.ok(en.includes("Dan by part") && en.includes("hardest 0:50–1:35 · Epsilon low") && en.includes("whole map: Delta mid"));
    // what comes from outside is escaped
    const odd = sectionsBlock({ ...SECTIONS, parts: [{ fromSec: 0, toSec: 30, dan: 12, primary: "<b>x</b>" }], top: 0 }, { mapDan: 12 });
    assert.ok(!odd.includes("<b>x</b>") && odd.includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("among the blocks: after the difficulty line, only for a map with a key; the card's own dan untouched", () => {
    const view = { screen: "result", result: RESULT, key: "k@1.000" };
    const base = { view, details: null, profile: { state: "idle" }, ladder: new Map(), ladderOpen: false };
    const counting = renderExtras({ ...base });
    assert.ok(counting.includes("an-sec") && plain(counting).includes("считаем дан каждой части…"));
    const done = renderExtras({ ...base, sections: SECTIONS });
    assert.ok(done.includes("an-sec-chart"));
    assert.ok(done.indexOf("an-sec") < done.indexOf("an-ladder"), "before the ladder");
    assert.equal(renderExtras({ ...base, view: { screen: "result", result: RESULT }, sections: SECTIONS }).includes("an-sec"), false, "no key: no parts");
    assert.equal(RESULT.numeric, 14);
});

test("the panel: parts from main for their own key only (also before the card), a tap tells that part, a new map starts over", async () => {
    let onSections;
    const api = { onAnalysisSections: (cb) => { onSections = cb; return () => {}; } };
    const dom = fakeDom(api);
    const card = dom.$("card");
    let draws = 0;
    const profile = { getProfile: () => ({ state: "idle" }), onProfile: () => () => {}, ensureProfile: () => Promise.resolve() };
    const panel = createAnalysisPanel({ card, redraw: () => { draws += 1; }, profile, setTimer: () => 0, clearTimer: () => {} });
    assert.equal(typeof onSections, "function");
    const view = (key) => ({ screen: "result", result: RESULT, key });
    assert.ok(plain(panel.html(view("a"))).includes("считаем дан каждой части…"));
    onSections({ key: "b", sections: SECTIONS });
    await flush();
    assert.ok(!panel.html(view("a")).includes("an-sec-chart"), "another map's parts");
    onSections({ key: "a", sections: SECTIONS });
    await flush();
    assert.ok(draws >= 1);
    assert.ok(panel.html(view("a")).includes("an-sec-chart"));
    // a tap on a bar: told below, and drawn again
    const before = draws;
    await fire(card, "click", { target: { dataset: { part: "3" }, parentElement: card } });
    assert.equal(panel.state.partSel, 3);
    assert.ok(draws > before);
    assert.ok(plain(panel.html(view("a"))).includes("1:35–3:20 · Delta low/mid · 13.8 · Jacks · tech"));
    // a failure, then another map whose parts came first
    onSections({ key: "a", sections: null });
    await flush();
    assert.ok(plain(panel.html(view("a"))).includes("не вышло"));
    assert.equal(panel.state.partSel, null);
    onSections({ key: "c", sections: SECTIONS });
    assert.ok(panel.html(view("c")).includes("an-sec-chart"));
    // hovering where the DOM has no chart does nothing
    await fire(card, "mouseover", { target: { dataset: {} } });
    // the list of all parts unfolds on a click and is remembered with the ladder's state
    assert.ok(plain(panel.html(view("c"))).includes("Все части (4) ▸"));
    await fire(card, "click", { target: { dataset: { toggle: "parts" }, parentElement: card } });
    assert.equal(dom.storage.get("analysis-extras"), JSON.stringify({ ladderOpen: false, partsOpen: true }));
    const open = panel.html(view("c"));
    assert.ok(plain(open).includes("Все части (4) ▾"));
    assert.equal((open.match(/data-part="/g) ?? []).length, 8, "4 bars and 4 rows");
});

test("the list of parts: each part's time, dan and pattern, the quiet one said, the hardest marked; English too", () => {
    const html = sectionsBlock(SECTIONS, { mapDan: 14, open: true });
    const rows = [...html.matchAll(/<button type="button" class="(an-srow[^"]*)" data-part="(\d)"[^>]*>(.*?)<\/button>/g)];
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => plain(r[3]).trim()), [
        "0:00–0:30 Beta mid 12.0 Stream",
        "0:30–0:40 тихая часть",
        "0:50–1:35 Epsilon low 14.6 Jumpstream",
        "1:35–3:20 Delta low/mid 13.8 Jacks · tech",
    ]);
    assert.equal(rows[2][1], "an-srow an-srow-top an-srow-sel");
    assert.ok(!sectionsBlock(SECTIONS, { mapDan: 14 }).includes("an-srow"), "folded: no rows");
    const en = plain(inLang("en", () => sectionsBlock(SECTIONS, { mapDan: 14, open: true })));
    assert.ok(en.includes("All parts (4) ▾") && en.includes("quiet part"));
});
