// Variant cards: the best mark follows the ranking, at most 6 cards per difficulty (the oldest that is not the best
// goes), the texts of a card (stats, grid, model, retries, issues, parts with locks) and its buttons.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import { rankFallback, newDiff, addVariant, issueText, cardLines, criticLine, createResultView, MAX_CARDS } from "../../app/renderer/resultView.js";

const BASE = JSON.parse(readFileSync(new URL("../fixtures/generateResult.json", import.meta.url), "utf8"));
const RANGE = { lo: 12.5, hi: 13.5 };
const variant = (id, { numeric = 13.0, patternScore = 0.8, issues = 0 } = {}) => ({
    ...BASE, id, patternScore, issues: BASE.issues.slice(0, issues), result: { ...BASE.result, numeric },
});

test("the fallback ranking: in range, then pattern score by 0.05, then fewer issues, then nearer the middle", () => {
    const out = rankFallback([
        variant("far", { numeric: 14.2, patternScore: 0.99 }),
        variant("a", { numeric: 13.4, patternScore: 0.81 }),
        variant("b", { numeric: 12.9, patternScore: 0.84, issues: 3 }),
        variant("c", { numeric: 13.2, patternScore: 0.79, issues: 1 }),
        variant("d", { numeric: 13.0, patternScore: 0.70 }),
    ], RANGE);
    // 0.81 and 0.79 round to 0.80, 0.84 rounds to 0.85: b first; a and c tie on the score, c has more issues
    assert.deepEqual(out.map((v) => v.id), ["b", "a", "c", "d", "far"]);
    const tie = rankFallback([variant("edge", { numeric: 13.4 }), variant("mid", { numeric: 13.0 })], RANGE);
    assert.deepEqual(tie.map((v) => v.id), ["mid", "edge"]);
});

test("the best mark follows the ranking given, and the best card is the chosen one", () => {
    // a ranking that prefers fewer notes, to show it is the one used
    const rank = (list) => [...list].sort((a, b) => a.result.numeric - b.result.numeric);
    const diff = newDiff(RANGE);
    addVariant(diff, variant("x", { numeric: 13.3 }), { rank });
    addVariant(diff, variant("y", { numeric: 12.8 }), { rank });
    addVariant(diff, variant("z", { numeric: 13.1 }), { rank });
    assert.equal(diff.bestId, "y");
    assert.equal(diff.selectedId, "y");
    assert.deepEqual(diff.cards.map((c) => c.letter), ["A", "B", "C"]);
    // the copies a ranking may return still find their card
    addVariant(diff, variant("w", { numeric: 12.6 }), { rank: (list) => rank(list).map((v) => ({ ...v })) });
    assert.equal(diff.bestId, "w");
});

test("at most 6 cards: the oldest one that is not the best is dropped", () => {
    const rank = (list) => [...list].sort((a, b) => (a.id === "first" ? -1 : b.id === "first" ? 1 : 0));
    const diff = newDiff(RANGE);
    addVariant(diff, variant("first"), { rank });
    for (let i = 1; i < MAX_CARDS; i += 1) addVariant(diff, variant(`v${i}`), { rank });
    assert.equal(diff.cards.length, MAX_CARDS);
    addVariant(diff, variant("v6"), { rank });
    assert.equal(diff.cards.length, MAX_CARDS);
    assert.deepEqual(diff.cards.map((c) => c.id), ["first", "v2", "v3", "v4", "v5", "v6"], "first is the best, v1 was the oldest after it");
    assert.equal(diff.cards.at(-1).letter, "G", "letters keep counting");
});

test("issue texts: time, 1-based column, count, percent, ms, ratio", () => {
    setLang("en");
    try {
        assert.equal(issueText(BASE.issues[0]), "0:15: 3-note jack in column 2");
        assert.equal(issueText(BASE.issues[1]), "0:18: anchor — column 3 in 41% of rows");
        assert.equal(issueText(BASE.issues[2]), "0:21: one hand overloaded (68% left)");
        assert.equal(issueText(BASE.issues[3]), "0:26: density spike (11 notes in a beat)");
        assert.equal(issueText(BASE.issues[4]), "0:29: jack too fast (58 ms)");
        assert.equal(issueText(BASE.issues[6]), "Columns uneven: the busiest has 1.4× the notes");
        assert.equal(issueText({ t: 1000, kind: "hand", pct: 0.7 }), "0:01: one hand overloaded (70% left)", "a share reads as a percent");
    } finally {
        setLang("ru");
    }
});

test("a card's lines: the dan, patterns, stats, model, retries; the grid only when there are non-1/4 rows", () => {
    setLang("en");
    try {
        const lines = cardLines(BASE, RANGE).map((l) => l.text);
        assert.ok(lines.includes("✓ Done: Gamma mid · 13.0 (within Gamma low — Gamma high)"), lines.join("\n"));
        assert.ok(lines.includes("Patterns match what you asked for: 79%"));
        assert.ok(lines.includes("Singles 62% · jumps 36% · hands 2% · quads 0%"));
        assert.ok(lines.includes("Left hand 51% · columns 25/26/24/25"));
        assert.ok(lines.includes("Longest jack 3 (in streams 2) · peak 19.4 notes/s"));
        assert.ok(lines.includes("Model: decision trees, trained on 6326 maps"));
        assert.ok(lines.includes("Redid 1 spot where the pattern was off"));
        assert.ok(!lines.some((l) => l.startsWith("Grid:")));
        const triplets = cardLines({ ...BASE, grid: { 4: 0.9, 3: 0.06, 6: 0, 8: 0.04 }, retries: { blocks: 0, dan: "low" } }, RANGE).map((l) => l.text);
        assert.ok(triplets.includes("Grid: 90% 1/4 · 6% 1/3 · 0% 1/6 · 4% 1/8"), triplets.join("\n"));
        assert.ok(triplets.includes("The dan fell short — retried with denser light parts"));
        const off = cardLines({ ...BASE, reachable: false, result: { ...BASE.result, numeric: 14.1, label: "Delta low/mid" }, stats: null, modelInfo: { kind: "rules", grid: "q4", maps: 0 } }, RANGE).map((l) => l.text);
        assert.ok(off[0].startsWith("≈ Closest we got: Delta low/mid · 14.1"), off[0]);
        assert.ok(off.includes("No trained model — the notes follow rules"));
        assert.ok(!off.some((l) => l.startsWith("Singles")), "no stats from an old worker: no stats lines");
        // a map too sparse for the analyser: no dan, no confidence, and never "undefined"
        const sparse = cardLines({ ...BASE, reachable: false, noteCount: 41, result: { kind: "too-short" } }, RANGE).map((l) => l.text);
        assert.ok(sparse[0].startsWith("≈ Closest we got: — · —"), sparse[0]);
        assert.ok(sparse.includes("41 notes · confidence —"), sparse.join("\n"));
        assert.ok(!sparse.some((l) => l.includes("undefined")), sparse.join("\n"));
    } finally {
        setLang("ru");
    }
});

function view() {
    const dom = fakeDom({});
    const calls = [];
    const v = createResultView({
        root: dom.$("gen-result"),
        onUse: (d, id) => calls.push(["use", d, id]),
        onMore: (d) => calls.push(["more", d]),
        onRegen: (d, id) => calls.push(["regen", d, id]),
        onToggleLock: (d, id, part) => calls.push(["lock", d, id, part]),
    });
    return { ...dom, v, calls };
}

const all = (n) => [n, ...n.children.flatMap(all)];

test("the view: one section per difficulty, cards with best, use, issues (5, then «n more»), parts with locks, regen", async () => {
    setLang("en");
    try {
        const { $, v, calls } = view();
        const diff = newDiff(RANGE);
        addVariant(diff, variant("a", { issues: 7 }), { rank: rankFallback });
        addVariant(diff, variant("b", { patternScore: 0.95 }), { rank: rankFallback });
        v.render([diff], { busy: false });
        const root = $("gen-result");
        assert.equal(root.hidden, false);
        const text = textOf(root);
        assert.ok(text.includes("Gamma low — Gamma high"), "the section names its range");
        assert.ok(text.includes("Variant A") && text.includes("Variant B"));
        assert.ok(text.includes("best"));
        assert.ok(text.includes("Problem spots: 7"));
        assert.ok(text.includes("2 more"), "first 5 issues, then the rest counted");
        assert.ok(text.includes("0:11–0:33 · Jumpstream · pattern 82% · ≈Delta low/mid"), text);
        assert.ok(text.includes("0:33–0:44 · No notes"));

        const buttons = all(root).filter((n) => n.tagName === "BUTTON");
        await fire(buttons.find((b) => b.textContent === "Another variant"));
        await fire(buttons.find((b) => b.textContent === "Use this one"));
        const lock = buttons.find((b) => b.textContent === "Lock");
        await fire(lock);
        assert.deepEqual(calls.map((c) => c[0]), ["more", "use", "lock"]);
        assert.equal(calls[1][1], 0);
        assert.equal(calls[2][3], 0, "the first part row of its card");
        assert.ok(!buttons.some((b) => b.textContent === "Regenerate the unlocked parts"), "no lock yet: no regen");

        diff.cards[0].locks.add(1);
        v.render([diff], { busy: false });
        const regen = all(root).filter((n) => n.tagName === "BUTTON").find((b) => b.textContent === "Regenerate the unlocked parts");
        assert.ok(regen);
        await fire(regen);
        assert.deepEqual(calls.at(-1), ["regen", 0, diff.cards[0].id]);
        assert.ok(all(root).some((n) => n.tagName === "BUTTON" && n.textContent === "Locked"));

        v.render([diff], { busy: true });
        const jobButtons = all(root).filter((n) => n.tagName === "BUTTON" && n.textContent !== "Use this one" && !n.dataset.vote && !n.dataset.tag);
        assert.ok(jobButtons.every((b) => b.disabled), "busy: nothing starts another job (a vote is not a job)");
        v.render([], { busy: false });
        assert.equal(root.hidden, true);
    } finally {
        setLang("ru");
    }
});

// ---- wave 3 (stream U): the critic line, the size note, the rating bar and the ratings line ----

test("the critic line: the heads there are, a missing one left out; nothing without a critic", () => {
    setLang("en");
    try {
        const full = { kind: "critic-v1", score: 1.1, human: 0.812, fun: 0.34, play: -0.21, personal: null, style: null, picked: 3, of: 12, analysed: 3, ms: 900 };
        assert.equal(criticLine(full), "Critic: human-like 81% · fun +0.3 · comfort −0.2 · best of 12");
        assert.equal(criticLine({ ...full, fun: null }), "Critic: human-like 81% · comfort −0.2 · best of 12");
        assert.equal(criticLine({ kind: "heuristic", score: 0, human: null, fun: null, play: 0, of: 8 }), "Critic: comfort 0.0 · best of 8");
        assert.equal(criticLine({ kind: "heuristic", human: null, fun: null, play: null, of: 1 }), null);
        assert.equal(criticLine(null), null);
        setLang("ru");
        assert.equal(criticLine(full), "Критик: как у человека 81% · интерес +0.3 · удобство −0.2 · лучший из 12");
        setLang("en");
        const lines = cardLines({ ...BASE, critic: full }, RANGE);
        const line = lines.find((l) => l.text.startsWith("Critic:"));
        assert.ok(line && line.title.includes("human-like"), "the line has a hint");
        assert.ok(!cardLines(BASE, RANGE).some((l) => l.text.startsWith("Critic:")));
    } finally {
        setLang("ru");
    }
});

test("nn-v2 and xgb-v3 models are named; a size that was not there is noted", () => {
    setLang("en");
    try {
        const nn = cardLines({ ...BASE, modelInfo: { kind: "nn-v2", grid: "snap-v2", maps: 80000, size: "s", sizeNote: { want: "l", got: "s" } } }, RANGE).map((l) => l.text);
        assert.ok(nn.includes("Model: neural net, trained on 80000 maps"), nn.join(" | "));
        assert.ok(nn.includes("No “Neural net L (experimental, needs a graphics card)” model here — used “Neural net S (experimental, fast)”"), nn.join(" | "));
        const trees = cardLines({ ...BASE, modelInfo: { kind: "xgb-v3", grid: "q4", maps: 20000, sizeNote: { want: "m", got: "xgb3" } } }, RANGE).map((l) => l.text);
        assert.ok(trees.includes("Model: decision trees, trained on 20000 maps"));
        assert.ok(trees.includes("No “Neural net M (experimental)” model here — used “XGBoost v3 (experimental)”"), trees.join(" | "));
        const classic = cardLines({ ...BASE, modelInfo: { kind: "xgb-v1", grid: "q4", maps: 6326, sizeNote: { want: "xgb3", got: "auto" } } }, RANGE).map((l) => l.text);
        assert.ok(classic.includes("No “XGBoost v3 (experimental)” model here — used “Classic”"), classic.join(" | "));
        const rules = cardLines({ ...BASE, modelInfo: { kind: "rules", grid: "q4", maps: 0, sizeNote: { want: "m", got: null } } }, RANGE).map((l) => l.text);
        assert.ok(rules.includes("No “Neural net M (experimental)” model here — made without it"), rules.join(" | "));
        const auto = cardLines({ ...BASE, modelInfo: { kind: "rules", grid: "q4", maps: 0, sizeNote: { want: "auto", got: null } } }, RANGE).map((l) => l.text);
        assert.ok(!auto.some((l) => l.startsWith("No “")), "auto never gets a note");
    } finally {
        setLang("ru");
    }
});

test("every card has the 👍/👎 bar: a vote calls onRate with the card's id and stays through a re-render", async () => {
    setLang("en");
    try {
        const dom = fakeDom({});
        const rated = [];
        const v = createResultView({ root: dom.$("gen-result"), onRate: async (r) => { rated.push(r); return { ok: true, n: rated.length }; } });
        const diff = newDiff(RANGE);
        addVariant(diff, variant("card-a"), { rank: rankFallback });
        addVariant(diff, variant("card-b", { patternScore: 0.95 }), { rank: rankFallback });
        v.render([diff]);
        const votes = () => all(dom.$("gen-result")).filter((n) => n.dataset?.vote === "1");
        assert.equal(votes().length, 2, "one bar per card");
        await fire(votes()[1]);
        assert.deepEqual(rated, [{ id: "card-b", vote: 1, tags: [] }]);
        v.render([diff]);
        assert.ok(votes()[1].className.includes("sel"), "the vote is still shown");
        assert.ok(!votes()[0].className.includes("sel"));
    } finally {
        setLang("ru");
    }
});

test("under the cards: the ratings count, «Using your ratings» once active, and the export button", async () => {
    setLang("en");
    try {
        const dom = fakeDom({});
        let exported = 0;
        const v = createResultView({ root: dom.$("gen-result"), onExport: () => { exported += 1; } });
        const diff = newDiff(RANGE);
        addVariant(diff, variant("a"), { rank: rankFallback });
        v.render([diff], { ratings: { n: 0, active: false } });
        assert.ok(!textOf(dom.$("gen-result")).includes("Export my ratings"), "nothing rated: no ratings line");
        v.render([diff], { ratings: { n: 5, active: false } });
        assert.ok(textOf(dom.$("gen-result")).includes("Your ratings: 5"));
        v.render([diff], { ratings: { n: 14, active: true, note: "Saved: C:/docs/lunacy-ratings-2026-10-26.json" } });
        const text = textOf(dom.$("gen-result"));
        assert.ok(text.includes("Using your ratings: 14"), text);
        assert.ok(text.includes("Saved: C:/docs/lunacy-ratings-2026-10-26.json"));
        await fire(all(dom.$("gen-result")).find((n) => n.tagName === "BUTTON" && n.textContent === "Export my ratings"));
        assert.equal(exported, 1);
        v.render([], { ratings: { n: 14, active: true } });
        assert.equal(dom.$("gen-result").hidden, true, "no cards: nothing shown");
    } finally {
        setLang("ru");
    }
});
