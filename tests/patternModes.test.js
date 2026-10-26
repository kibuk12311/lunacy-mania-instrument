// The «Общие / Подробно» (General / Detailed) switch: one remembered value for every tab, what each tab shows in each
// mode (the create tab's chips and part editor, the result cards and part lines, the analysis card and its strip,
// the picks' and the auto-marathon's patterns), and that switching to General keeps the kinds but sends none.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire } from "./helpers/fakeDom.js";
import { setLang } from "../src/i18n/i18n.js";
import {
    getPatternMode, setPatternMode, onPatternMode, resetPatternMode, isDetailed, patternLabel, patternsInMode, patternModeHtml,
    createPatternModeSwitch,
} from "../app/renderer/patternMode.js";
import { patternsOf, choiceOf, renderPatternChips, toggleFamily, toggleFlavour } from "../app/renderer/patternPicker.js";
import { cardLines, partLine } from "../app/renderer/resultView.js";
import { renderView } from "../app/renderer/view.js";
import { renderExtras, flavourStrip, flavourLegend } from "../app/renderer/analysisExtras.js";
import { toPartSpecs } from "../app/renderer/timeline.js";
import { requestFrom, parseSettings } from "../app/renderer/recommendTab.js";
import { planRequest } from "../app/renderer/recPlan.js";
import { REC_PATTERNS, REC_KINDS, recPatternsFor, patternInMode, patternIdsInMode, patternById } from "../src/recommend/catalog.js";
import { purity } from "../src/recommend/rank.js";
import { FLAVOUR_IDS, FAMILY_FLAVOURS } from "../src/gen/flavours.js";
import { PATTERN_NAMES } from "../src/gen/patterns.js";

const fresh = (storage = {}) => {
    const dom = fakeDom({}, { storage });
    resetPatternMode();
    return dom;
};
const inLang = (lang, fn) => {
    setLang(lang);
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("one remembered mode: General by default, Detailed kept in storage, every listener hears a change once", () => {
    fresh();
    assert.equal(getPatternMode(), "general");
    assert.equal(isDetailed(), false);
    const heard = [];
    const stop = onPatternMode((m) => heard.push(m));
    setPatternMode("detailed");
    setPatternMode("detailed"); // no change, nothing heard
    setPatternMode("weird"); // not a mode
    assert.deepEqual(heard, ["detailed"]);
    assert.equal(globalThis.localStorage.getItem("pattern-mode"), "detailed");
    stop();
    setPatternMode("general");
    assert.deepEqual(heard, ["detailed"], "a stopped listener hears nothing");
    // read back by the next window; junk or no storage at all start General
    fresh({ "pattern-mode": "detailed" });
    assert.equal(getPatternMode(), "detailed");
    fresh({ "pattern-mode": "everything" });
    assert.equal(getPatternMode(), "general");
    fakeDom({}, { storage: null });
    resetPatternMode();
    assert.equal(getPatternMode(), "general");
    setPatternMode("detailed");
    assert.equal(getPatternMode(), "detailed", "applied even when it cannot be remembered");
});

test("the switch: two chips that follow the mode wherever it changes; the string form for the analysis card", async () => {
    const dom = fresh();
    const box = createPatternModeSwitch(globalThis.document);
    const [general, detailed] = box.children;
    assert.equal(general.className, "sel");
    assert.equal(detailed.textContent, "Подробно");
    await fire(detailed);
    assert.equal(getPatternMode(), "detailed");
    assert.equal(detailed.className, "sel");
    assert.equal(general.className, "");
    setPatternMode("general"); // from another tab
    assert.equal(general.className, "sel");
    const html = patternModeHtml();
    assert.ok(html.includes('data-pattern-mode="general" class="sel"') && html.includes('data-pattern-mode="detailed"'), html);
    assert.ok(inLang("en", () => patternModeHtml()).includes(">Detailed<"));
    assert.ok(dom);
});

test("finder names in each mode: General their family, Detailed the catalogue's kind (unknown names stay)", () => {
    fresh();
    for (const [name, family] of [["Rolls", "Stream"], ["Chordstream", "Jumpstream"], ["Split Trill", "Jumpstream"], ["Quadstream", "Chordjacks"], ["Gluts", "Jacks"], ["Jacks", "Jacks"]]) {
        assert.equal(patternLabel(name, false), family, name);
    }
    assert.equal(patternLabel("Release", false), "Release");
    assert.equal(patternLabel("Split Trill", true), "Сплит-триллы");
    assert.equal(inLang("en", () => patternLabel("Split Trill", true)), "Split trills");
    assert.equal(patternLabel("Jumpstream", true), "Jumpstream");
    assert.equal(patternLabel(null, true), null);
    const top3 = [{ name: "Rolls", share: 0.3 }, { name: "Jumpstream", share: 0.45 }, { name: "Trills", share: 0.25 }];
    assert.deepEqual(patternsInMode(top3, false), [{ name: "Stream", share: 0.55 }, { name: "Jumpstream", share: 0.45 }]);
    assert.deepEqual(patternsInMode(top3, true).map((p) => p.name), ["Jumpstream", "Роллы", "Триллы"]);
});

test("the create chips: General the six families; Detailed a line per family with all its kinds", async () => {
    fresh();
    const box = globalThis.document.createElement("div");
    const choice = choiceOf([{ name: "Stream", share: 100, flavours: ["Trills"] }]);
    const calls = [];
    const handlers = { onFamily: (name) => calls.push(["family", name]), onFlavour: (name, id) => calls.push(["flavour", name, id]) };
    renderPatternChips(box, choice, { detailed: false, ...handlers });
    assert.equal(box.className, "chips");
    assert.deepEqual(box.children.map((c) => c.dataset.pattern), PATTERN_NAMES);
    assert.deepEqual(box.children.map((c) => c.className), PATTERN_NAMES.map((n) => (n === "Stream" ? "sel" : "")));
    renderPatternChips(box, choice, { detailed: true, ...handlers });
    assert.equal(box.className, "chips pp-detailed");
    assert.equal(box.children.length, 6);
    const kinds = box.children.flatMap((line) => line.children.filter((c) => c.dataset.flavour));
    assert.deepEqual(kinds.map((c) => c.dataset.flavour), FLAVOUR_IDS, "every kind is there, in the catalogue's order");
    assert.ok(kinds.every((c) => c.title.length > 0), "each kind has a hint");
    assert.deepEqual(kinds.filter((c) => c.className.includes("sel")).map((c) => c.dataset.flavour), ["Trills"]);
    assert.equal(box.children[0].children[0].title, "Stream: любые разновидности");
    await fire(kinds.find((c) => c.dataset.flavour === "Gluts"));
    await fire(box.children[3].children[0]);
    assert.deepEqual(calls, [["flavour", "Jack", "Gluts"], ["family", "Chordjack"]]);
});

test("choosing: a kind picks its family, the last family stays, a family off drops its kinds; General sends families only", () => {
    const choice = choiceOf([{ name: "Jumpstream", share: 100 }]);
    toggleFlavour(choice, "Jack", "Longjacks");
    assert.equal(choice.families.get("Jack"), 50);
    toggleFlavour(choice, "Jack", "Gluts");
    assert.deepEqual(patternsOf(choice, true), [{ name: "Jumpstream", share: 100 }, { name: "Jack", share: 50, flavours: ["Longjacks", "Gluts"] }]);
    // General: the same families, no kinds, and the kinds are still there for Detailed
    assert.deepEqual(patternsOf(choice, false), [{ name: "Jumpstream", share: 100 }, { name: "Jack", share: 50 }]);
    assert.deepEqual([...choice.flavours.get("Jack")], ["Longjacks", "Gluts"]);
    toggleFlavour(choice, "Jack", "Longjacks");
    toggleFlavour(choice, "Jack", "Gluts");
    assert.deepEqual(patternsOf(choice, true), [{ name: "Jumpstream", share: 100 }, { name: "Jack", share: 50 }], "no kind left: any kind");
    toggleFlavour(choice, "Jack", "Gluts");
    toggleFamily(choice, "Jack");
    assert.equal(choice.flavours.has("Jack"), false);
    toggleFamily(choice, "Jumpstream", { keepOne: true });
    assert.deepEqual(patternsOf(choice, true), [{ name: "Jumpstream", share: 100 }], "the last family stays");
    // the order of kinds is the catalogue's, whatever the clicks
    const c2 = choiceOf([{ name: "Stream", share: 1, flavours: ["RunningMan", "Rolls"] }]);
    assert.deepEqual(patternsOf(c2, true)[0].flavours, ["Rolls", "RunningMan"]);
});

test("the part editor's specs: a part's kinds go in Detailed only", () => {
    const parts = [{ startMs: 0, endMs: 1000, kind: "drop", patterns: [{ name: "Jack", share: 1, flavours: ["Gluts"] }] }];
    assert.deepEqual(toPartSpecs(parts, { detailed: true })[0].patterns, [{ name: "Jack", share: 1, flavours: ["Gluts"] }]);
    assert.deepEqual(toPartSpecs(parts, { detailed: false })[0].patterns, [{ name: "Jack", share: 1 }]);
    assert.deepEqual(toPartSpecs(parts)[0].patterns, [{ name: "Jack", share: 1 }], "General unless told");
});

const ANSWER = {
    reachable: true, noteCount: 600, patternScore: 0.7, familyScore: 0.62, flavourScore: 0.81,
    flavours: [{ id: "Jumptrill", share: 0.41 }, { id: "Anchor", share: 0.2 }],
    result: { kind: "ok", label: "Gamma mid", numeric: 13, confidenceLevel: "high", top3: [{ name: "Jumptrill", share: 0.5 }, { name: "Chordstream", share: 0.3 }, { name: "Rolls", share: 0.2 }] },
};

test("a result card: General the family match and families, Detailed the kinds' match and the kinds found", () => {
    fresh();
    const general = cardLines(ANSWER, { lo: 12.5, hi: 13.5 }, { detailed: false }).map((l) => l.text).join("\n");
    assert.ok(general.includes("Паттерны совпали с заказом на 62%"), general);
    assert.ok(general.includes("Jumpstream 80% · Stream 20%"), general);
    const detailed = cardLines(ANSWER, { lo: 12.5, hi: 13.5 }, { detailed: true }).map((l) => l.text).join("\n");
    assert.ok(detailed.includes("Разновидности паттернов совпали с заказом на 81%"), detailed);
    assert.ok(detailed.includes("Джамптриллы 41% · Анкоры 20%"), detailed);
    // a map made without kinds: Detailed shows the finder's names as kinds, the family match as before
    const old = { ...ANSWER, flavourScore: undefined, familyScore: undefined, flavours: [] };
    const oldLines = cardLines(old, { lo: 12.5, hi: 13.5 }, { detailed: true }).map((l) => l.text).join("\n");
    assert.ok(oldLines.includes("Паттерны совпали с заказом на 70%") && oldLines.includes("Джамптриллы 50%"), oldLines);
    const en = inLang("en", () => cardLines(ANSWER, { lo: 12.5, hi: 13.5 }, { detailed: true }).map((l) => l.text).join("\n"));
    assert.ok(en.includes("Pattern kinds match what you asked for: 81%") && en.includes("Jumptrills 41%"), en);
});

test("a part line: General its families and their match, Detailed its planned kinds and how they came out", () => {
    const report = { startMs: 0, endMs: 30000, families: ["Jumpstream"], patternScore: 0.7, dan: { label: "Gamma mid" }, flavours: ["Anchor"], flavourScore: 0.83, detected: [] };
    assert.ok(partLine(report, { detailed: false }).includes("Jumpstream"));
    assert.ok(partLine(report, { detailed: false }).includes("70%"));
    const detailed = partLine(report, { detailed: true });
    assert.ok(detailed.includes("Анкоры") && detailed.includes("83%"), detailed);
    // nothing planned: the kinds found there
    const found = partLine({ ...report, flavours: [], flavourScore: null, detected: [{ id: "Rolls", share: 0.5 }] }, { detailed: true });
    assert.ok(found.includes("Роллы"), found);
});

test("the analysis card: General families, Detailed the finder's kinds by the catalogue's names", () => {
    const result = { kind: "ok", label: "Gamma mid", numeric: 13, halfWidth: 0.3, confidence: "высокая", primary: "Jumptrill",
        top3: [{ name: "Jumptrill", share: 0.46 }, { name: "Handstream", share: 0.22 }, { name: "Minijacks", share: 0.15 }], tech: false, bpm: 180, durationSec: 120, rate: 1 };
    fresh();
    const general = plain(renderView({ screen: "result", result }, { compact: false }));
    assert.ok(general.includes("Jumpstream 46%") && general.includes("Jacks 15%"), general);
    setPatternMode("detailed");
    const detailed = plain(renderView({ screen: "result", result }, { compact: false }));
    assert.ok(detailed.includes("Джамптриллы 46%") && detailed.includes("Миниджеки 15%"), detailed);
});

test("the pattern strip: General families, Detailed the kinds along the map (older details keep the families)", () => {
    fresh();
    const families = Array.from({ length: 120 }, (_, i) => (i < 60 ? "jumpstream" : "jack"));
    const flavourBins = Array.from({ length: 120 }, (_, i) => (i < 30 ? "Jumptrill" : i < 60 ? "Anchor" : i < 70 ? "-" : "Gluts"));
    const details = { v: 2, durationSec: 120, strain: new Array(120).fill(0.5), hardest: [], families, flavours: [{ id: "Jumptrill", share: 0.25 }, { id: "Gluts", share: 0.4 }], flavourBins };
    const state = { view: { screen: "result", result: { kind: "ok", numeric: 13, rate: 1 }, key: "k" }, compact: false, details, profile: { state: "idle" }, ladder: new Map(), ladderOpen: false };
    const general = renderExtras(state);
    assert.ok(general.includes("fam-jumpstream") && !general.includes("Анкоры"));
    assert.ok(general.includes('data-pattern-mode="general" class="sel"'), "the switch sits in the strip's head");
    setPatternMode("detailed");
    const detailed = renderExtras(state);
    assert.ok(detailed.includes('title="Анкоры"') && detailed.includes('title="Глюты"'), detailed);
    assert.ok(detailed.includes("fl-edge"), "two kinds of one family in a row are told apart");
    assert.ok(plain(detailed).includes("Джамптриллы 25%"));
    // details from before kinds: the families, even in Detailed
    const old = renderExtras({ ...state, details: { ...details, v: 1, flavours: undefined, flavourBins: undefined } });
    assert.ok(old.includes("fam-jumpstream") && !old.includes("Анкоры"));
    assert.equal(flavourStrip([]), "");
    assert.equal(flavourLegend([{ id: "Nope", share: 1 }]), "");
});

test("picks and auto-marathon: General the seven patterns, Detailed the tracker's kinds after their parents", () => {
    assert.equal(recPatternsFor(false), REC_PATTERNS);
    assert.deepEqual(recPatternsFor(true).map((p) => p.id), ["stream", "jumpstream", "handstream", "stamina", "chordjack", "quadstream", "handjack", "jack", "speedjack", "tech"]);
    assert.deepEqual(REC_KINDS.map((p) => [p.id, p.parent, p.tile, p.msd]), [["quadstream", "chordjack", "jack", "Chordjack"], ["handjack", "chordjack", "jack", "Chordjack"], ["speedjack", "jack", "jack", "JackSpeed"]]);
    assert.equal(patternById("speedjack").msdFit, false);
    assert.deepEqual(REC_KINDS.map((p) => p.name), ["Квадстрим", "Хендджек", "Спидджек"]);
    assert.deepEqual(inLang("en", () => REC_KINDS.map((p) => p.name)), ["Quadstream", "Handjack", "Speedjack"]);
    assert.equal(patternInMode("quadstream", false), "chordjack");
    assert.equal(patternInMode("quadstream", true), "quadstream");
    assert.deepEqual(patternIdsInMode(["quadstream", "chordjack", "speedjack"], false), ["chordjack", "jack"]);
    // a kind has no share of its own on the tracker: it ranks by its parent's
    const shares = { stream: 0.2, jumpstream: 0.3, handstream: 0.2, chordjack: 1, jack: 0.4 };
    assert.equal(purity(shares, "handjack"), purity(shares, "chordjack"));
    // the request: in General a remembered kind asks for its parent
    fresh();
    const s = parseSettings(JSON.stringify({ patternId: "handjack" }));
    assert.equal(s.patternId, "handjack", "a kind is a valid saved choice");
    assert.equal(requestFrom(s, { detailed: false }).patternId, "chordjack");
    assert.equal(requestFrom(s, { detailed: true }).patternId, "handjack");
    assert.equal(requestFrom(s).patternId, "chordjack", "General unless switched");
    const view = { planSize: 5, planPatterns: ["speedjack", "jack", "tech"] };
    assert.deepEqual(planRequest(view, { source: "tracker", lengthId: "any" }, null, { detailed: false }).patternIds, ["jack", "tech"]);
    assert.deepEqual(planRequest(view, { source: "tracker", lengthId: "any" }, null, { detailed: true }).patternIds, ["speedjack", "jack", "tech"]);
    assert.ok(Object.keys(FAMILY_FLAVOURS).every((f) => PATTERN_NAMES.includes(f)));
});
