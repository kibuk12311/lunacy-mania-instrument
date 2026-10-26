// Variant cards: the best mark follows the ranking, at most 6 cards per difficulty (the oldest that is not the best
// goes), the texts of a card (stats, grid, model, retries, issues, parts with locks) and its buttons.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import { rankFallback, newDiff, addVariant, issueText, cardLines, createResultView, MAX_CARDS } from "../../app/renderer/resultView.js";

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
        assert.ok(all(root).filter((n) => n.tagName === "BUTTON" && n.textContent !== "Use this one").every((b) => b.disabled), "busy: nothing starts another job");
        v.render([], { busy: false });
        assert.equal(root.hidden, true);
    } finally {
        setLang("ru");
    }
});
