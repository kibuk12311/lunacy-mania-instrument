// The flavour catalogue (src/gen/flavours.js): 22 sub-patterns under the six families, the finder's names, names and
// hints in both languages, the guard's exceptions, motif weights that pick the motif's next row, and the flavours the
// analysis looks for (those of 0.10.3: a flavour added since is the generator's only).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    FAMILY_FLAVOURS, FLAVOUR_IDS, FLAVOUR_FAMILY, FINDER_NAME, FLAVOUR_LIMITS, familyOfFlavour, flavoursOf, isFlavour,
    flavourName, flavourHint, motifWeights, direction, ANALYSIS_FLAVOUR_IDS, GENERATOR_ONLY_FLAVOURS,
} from "../../src/gen/flavours.js";
import { PATTERN_NAMES } from "../../src/gen/patterns.js";
import { limitsOf, LIMITS } from "../../src/gen/playability.js";
import { NAME_FAMILY } from "../../src/gen/search.js";
import { setLang } from "../../src/i18n/i18n.js";

const m = (s) => s.split(" ").map((tok) => tok.replace(/[[\]]/g, "").split("").reduce((x, c) => x | (1 << (Number(c) - 1)), 0));
const best = (w) => {
    let top = 1;
    for (let k = 2; k < 16; k += 1) if (w[k] > w[top]) top = k;
    return top;
};
// newest first, as the generators keep their rows
const recentOf = (s) => m(s).reverse();

test("22 flavours, each under one of the six families", () => {
    assert.deepEqual(Object.keys(FAMILY_FLAVOURS), PATTERN_NAMES);
    assert.equal(FLAVOUR_IDS.length, 22);
    assert.equal(new Set(FLAVOUR_IDS).size, 22);
    assert.deepEqual(flavoursOf("Chordjack"), ["Handjack", "Jumpjack", "Quadhand", "JumpQuad", "Quadstream"]);
    for (const id of FLAVOUR_IDS) {
        assert.ok(PATTERN_NAMES.includes(familyOfFlavour(id)), id);
        assert.ok(flavoursOf(FLAVOUR_FAMILY[id]).includes(id));
        assert.ok(isFlavour(id));
    }
    assert.equal(familyOfFlavour("Stream"), null);
    assert.equal(isFlavour("Stream"), false);
    assert.deepEqual(flavoursOf("Nope"), []);
});

// what 0.10.3 analysed with: every saved analysis (the detected flavours, the flavour strip) was made with exactly these
const FLAVOURS_0_10_3 = [
    "Rolls", "Trills", "Minitrills", "RunningMan", "Jumptrill", "SplitTrill", "Anchor", "Dumpstream", "ChordTrills",
    "DenseHandstream", "JumpyHandstream", "Handjack", "Jumpjack", "Quadhand", "Quadstream", "Minijacks", "Longjacks", "Gluts",
    "Speedjacks", "Coordination", "JackyStream",
];

test("the analysis looks for the flavours of 0.10.3, in their order; the newer ones are the generator's", () => {
    assert.deepEqual([...ANALYSIS_FLAVOUR_IDS], FLAVOURS_0_10_3);
    assert.deepEqual([...GENERATOR_ONLY_FLAVOURS], ["JumpQuad"]);
    assert.deepEqual(FLAVOUR_IDS.filter((id) => !FLAVOURS_0_10_3.includes(id)), [...GENERATOR_ONLY_FLAVOURS]);
    assert.ok(Object.isFrozen(ANALYSIS_FLAVOUR_IDS));
});

test("the finder-named flavours use names the 4K finder really gives, mapped to the same family", () => {
    const defs = readFileSync(new URL("../../vendor/leoblack/js/patterns/patternsDef.js", import.meta.url), "utf8");
    const fourK = defs.slice(defs.indexOf("export function SPECIFIC_4K"), defs.indexOf("export function SPECIFIC_7K"));
    for (const [id, name] of Object.entries(FINDER_NAME)) {
        assert.ok(fourK.includes(`["${name}"`), `${name} is a 4K sub-type`);
        assert.equal(NAME_FAMILY[name], FLAVOUR_FAMILY[id], `${name} belongs to ${FLAVOUR_FAMILY[id]}`);
    }
});

test("every flavour has a name and a hint in both languages", () => {
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        for (const id of FLAVOUR_IDS) {
            assert.notEqual(flavourName(id), `gen.flavour.${id}`, `${lang} ${id}`);
            assert.notEqual(flavourHint(id), `gen.flavour.${id}.hint`, `${lang} ${id} hint`);
            assert.equal(/[А-Яа-яЁё]/.test(flavourName(id)), lang === "ru", `${lang} ${id}: ${flavourName(id)}`);
        }
    }
    setLang("ru");
    assert.equal(flavourName("Rolls"), "Роллы");
    assert.equal(flavourName("Quadhand"), "Квадхенд");
    assert.equal(flavourName("JumpQuad"), "Чордджеки 2/4");
    assert.match(flavourHint("JumpQuad"), /\[12\]\[1234\]\[34\]\[1234\]/);
    setLang("en");
    assert.equal(flavourName("Jumptrill"), "Jumptrills");
    assert.equal(flavourName("JumpQuad"), "2/4 chordjacks");
    setLang("ru");
});

test("the guard's exceptions: only anchors loosen the anchor cap and the hand range; longjacks only the column pull", () => {
    assert.deepEqual(Object.keys(FLAVOUR_LIMITS).sort(), ["Anchor", "Longjacks", "RunningMan"]);
    for (const id of FLAVOUR_IDS) {
        const family = FLAVOUR_FAMILY[id];
        const lim = limitsOf(family, id);
        // no flavour lets a column jack longer or faster than its family does
        assert.equal(lim.jack, LIMITS[family].jack, id);
        assert.equal(lim.minJackMs, LIMITS[family].minJackMs, id);
    }
    assert.ok(limitsOf("Jumpstream", "Anchor").anchor > LIMITS.Jumpstream.anchor);
    assert.deepEqual(limitsOf("Stream", "RunningMan").hand, [0.25, 0.75]);
    assert.deepEqual(limitsOf("Stream").hand, [0.35, 0.65]);
    assert.equal(limitsOf("Stream", "Trills").anchor, LIMITS.Stream.anchor);
});

test("motif weights: a weight per mask, every flavour has a clear favourite whatever came before", () => {
    const pasts = ["", "1", "1 2", "[12] [34]", "[123] 4", "[1234] [12]", "1 1 1", "[12] [12] [12] [12]"];
    for (const id of FLAVOUR_IDS) {
        for (const past of pasts) {
            const w = motifWeights(id, past ? recentOf(past) : [], 1);
            assert.equal(w.length, 16, id);
            assert.equal(w[0], 0);
            assert.ok([...w].every((x) => x >= 0 && Number.isFinite(x)), `${id} after ${past}`);
            assert.ok(Math.max(...w) > 0, `${id} after ${past}`);
        }
    }
    assert.equal(motifWeights("Nope", []), null);
});

test("motif weights continue each motif", () => {
    const next = (id, past, phrase = 0) => best(motifWeights(id, recentOf(past), phrase));
    assert.equal(next("Rolls", "1 2 3"), m("4")[0]); // the sweep goes on
    assert.ok(![m("3")[0], m("4")[0]].includes(next("Rolls", "1 2 3 4")), "after a sweep: no bounce, no jack");
    assert.equal(next("Rolls", "1 2 3 4"), m("2")[0], "after a sweep: not its first column either (the finder's 5th note)");
    // between sweeps the link heads for the far edge, and the next sweep runs whole (2 1 | 4 3 2 1)
    assert.equal(next("Rolls", "1 2 3 4 2 1"), m("4")[0]);
    assert.equal(next("Rolls", "1 2 3 4 2 1 4 3"), m("2")[0], "the old 1st-and-5th rule does not cut a sweep short");
    assert.equal(next("Trills", "1 2 1"), m("2")[0]);
    assert.notEqual(next("Trills", "1 2 1 2"), m("1")[0], "a trill is 4 notes");
    assert.notEqual(next("Minitrills", "1 2 1"), m("2")[0], "a minitrill is 3 notes");
    assert.equal(next("RunningMan", "1 2", 0), m("1")[0], "phrase 0 anchors column 1");
    assert.equal(next("Jumptrill", "[12]"), m("[34]")[0]);
    assert.equal(next("SplitTrill", "[13]"), m("[24]")[0]);
    assert.equal(next("ChordTrills", "[123]"), m("4")[0]);
    assert.equal(next("Quadstream", "[12] 3 4 [12]"), 15);
    assert.equal(next("JumpQuad", "[12]"), 15, "a quad after a jump");
    assert.equal(next("JumpQuad", "[12] [1234]"), m("[34]")[0], "then the other half of the jump");
    assert.equal(next("JumpQuad", "[13] [1234]"), m("[24]")[0]);
    assert.equal(next("JumpQuad", "[1234] [23] [23]"), 15, "a jump at most twice");
    assert.equal(next("JumpQuad", "[23] [23] [1234]"), 15, "a doubled jump, then the quad doubled too");
    assert.equal(next("JumpQuad", "[23] [23] [1234] [1234]"), m("[14]")[0], "never a third quad");
    assert.equal(next("Minijacks", "3 [12]"), m("[12]")[0], "the jump is played twice");
    assert.equal(next("Jumpjack", "[23]"), m("[23]")[0]);
    assert.equal(next("Longjacks", "[12] [12] [12]"), m("[12]")[0]);
    assert.equal(next("Gluts", "[12] [12]", 0), m("[23]")[0]);
    assert.equal(next("Speedjacks", "2 3"), m("3")[0]);
    // anchors never jack the anchor
    const anchorAfter = motifWeights("Anchor", recentOf("[12]"), 0);
    assert.ok(anchorAfter[m("1")[0]] < 0.01 && anchorAfter[m("[13]")[0]] < 0.01);
});

test("2/4 chordjacks: only jumps and quads, a jack on two columns every row, the pair moving on only now and then", () => {
    const top = (past, phrase = 0) => best(motifWeights("JumpQuad", recentOf(past), phrase));
    // the phrase picks the first pair: [12]/[34], [13]/[24], [14]/[23]
    assert.ok([m("[12]")[0], m("[34]")[0]].includes(top("", 0)));
    assert.ok([m("[13]")[0], m("[24]")[0]].includes(top("", 1)));
    assert.ok([m("[14]")[0], m("[23]")[0]].includes(top("", 2)));
    const notes = (k) => [0, 1, 2, 3].filter((c) => k & (1 << c)).length;
    const weightOf = (w, keep) => [...w].reduce((a, x, k) => a + (keep(k) ? x : 0), 0);
    for (const past of ["[12]", "[12] [1234]", "[12] [12] [1234]", "[12] [12] [1234] [1234]", "[1234] [13] [1234] [24] [1234]"]) {
        for (const phrase of [0, 1]) {
            const w = motifWeights("JumpQuad", recentOf(past), phrase);
            const prev = m(past).at(-1);
            // a jump or a quad that keeps two columns of the row before: nearly all the weight
            const motif = weightOf(w, (k) => (notes(k) === 2 || k === 15) && notes(k & prev) >= 2);
            assert.ok(motif / weightOf(w, () => true) > 0.97, `${past} (phrase ${phrase})`);
        }
    }
    // a column held for four rows already is kept no longer: after Q [13] Q [12] Q column 1 has five
    const w = motifWeights("JumpQuad", recentOf("[1234] [13] [1234] [12] [1234]"), 0);
    for (const kept of ["[12]", "[13]", "[14]"]) assert.ok(w[m(kept)[0]] <= 0.01, kept);
    assert.ok(w[m("[34]")[0]] === 1 && w[m("[23]")[0]] > 0.01, "the other half, or a new pair keeping column 2");
    // doubling: every other phrase doubles its rows more often
    const doubled = (phrase) => motifWeights("JumpQuad", recentOf("[1234] [12]"), phrase)[m("[12]")[0]];
    assert.ok(doubled(1) > 2 * doubled(0));
});

test("direction is the finder's: both edges move the same way", () => {
    assert.equal(direction(m("1")[0], m("[23]")[0]), 1);
    assert.equal(direction(m("[34]")[0], m("[12]")[0]), -1);
    assert.equal(direction(m("[23]")[0], m("[14]")[0]), 0);
    assert.equal(direction(0, m("1")[0]), 0);
});
