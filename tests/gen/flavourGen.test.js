// Flavours in the generators: the request keeps and checks them, the plan spreads them over parts and phrases, both
// generators show them (motif biasing), the range search prefers maps that show them (flavour first, family second),
// and with no flavour chosen both generators write exactly the maps they wrote before (tests/fixtures/familyGolden.json)
// as long as the finder reports names whose family did not change; the fuller name table moves the learned maps where
// it reports the newly mapped ones (tests/fixtures/familyGoldenNames.json, recorded with the new table).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeShares, normalizeParts, normalizeRequest, cleanFlavours } from "../../src/gen/request.js";
import { assignByParts, assignFlavours } from "../../src/gen/assign.js";
import { NAME_FAMILY, patternScore, flavourAwareScore, flavourCoverageOf, planShares, FAMILY_TIEBREAK, FINDER_WEIGHT } from "../../src/gen/search.js";
import { sampleRow } from "../../src/gen/learnedModel.js";
import { motifWeights } from "../../src/gen/flavours.js";
import { buildChart } from "../../src/gen/build.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { generateMap } from "../../src/gen/generate.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { flavourShares } from "../../src/gen/flavourMetrics.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { chartInfo } from "../../src/core/features.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { goldenCases, goldenNamedCases, goldenModel } from "../fixtures/familyGolden.js";
import { partsSong, PARTS_SONG, PARTS_SONG_BPM, PARTS_SONG_OFFSET } from "../fixtures/partsSong.js";

const GOLDEN = JSON.parse(readFileSync(new URL("../fixtures/familyGolden.json", import.meta.url), "utf8"));
const GOLDEN_NAMES = JSON.parse(readFileSync(new URL("../fixtures/familyGoldenNames.json", import.meta.url), "utf8"));

// ---- the request ----

test("flavours ride along with their family; the shares drop unknown or foreign ones, the worker refuses them, none leaves the pattern as before", () => {
    assert.deepEqual(cleanFlavours("Stream", ["Trills", "Rolls", "Jumptrill", "Trills"]), ["Rolls", "Trills"]);
    assert.deepEqual(normalizeShares([{ name: "Stream", share: 1, flavours: ["Rolls"] }, { name: "Jack", share: 1 }]), [
        { name: "Stream", share: 0.5, flavours: ["Rolls"] }, { name: "Jack", share: 0.5 },
    ]);
    assert.deepEqual(normalizeShares([{ name: "Stream", share: 1, flavours: [] }]), [{ name: "Stream", share: 1 }]);
    assert.deepEqual(normalizeRequest({ target: 5, patterns: [{ name: "Jack", share: 2, flavours: ["Gluts", "Longjacks", "Gluts"] }] }, 1000).patterns,
        [{ name: "Jack", share: 1, flavours: ["Longjacks", "Gluts"] }]);
    // the worker refuses a flavour that is not its pattern's own (or unknown) at the top level, as in a part
    assert.throws(() => normalizeRequest({ target: 5, patterns: [{ name: "Stream", share: 1, flavours: ["Gluts", "Rolls"] }] }, 1000),
        /patterns\[0\]\.flavours/);
    assert.throws(() => normalizeRequest({ target: 5, patterns: [{ name: "Jack", share: 1 }, { name: "Jack", share: 1, flavours: ["Nope"] }] }, 1000),
        /patterns\[1\]\.flavours/);
    assert.throws(() => normalizeRequest({ target: 5, patterns: [{ name: "Jack", share: 1, flavours: "Gluts" }] }, 1000), /patterns\[0\]\.flavours/);
    const parts = normalizeParts([{ startMs: 0, endMs: 5000, kind: "drop", patterns: [{ name: "Handstream", share: 1, flavours: ["ChordTrills"] }] }], 5000);
    assert.deepEqual(parts[0].patterns, [{ name: "Handstream", share: 1, flavours: ["ChordTrills"] }]);
    assert.throws(() => normalizeParts([{ startMs: 0, endMs: 5000, kind: "drop", patterns: [{ name: "Stream", share: 1, flavours: ["Gluts"] }] }], 5000),
        /patterns\.flavours/);
    // the 2/4 chordjack is a Chordjack flavour, in the catalogue's order, and no other family's
    assert.deepEqual(normalizeRequest({ target: 9, patterns: [{ name: "Chordjack", share: 1, flavours: ["Quadstream", "JumpQuad"] }] }, 1000).patterns,
        [{ name: "Chordjack", share: 1, flavours: ["JumpQuad", "Quadstream"] }]);
    assert.throws(() => normalizeRequest({ target: 9, patterns: [{ name: "Jack", share: 1, flavours: ["JumpQuad"] }] }, 1000), /patterns\[0\]\.flavours/);
});

// ---- the plan: variety ----

const BEAT_MS = 375; // 160 BPM
const slotsOf = (beats) => slotsForTiming({ bpm: 160, offsetMs: 0 }, beats * BEAT_MS - 1);
const partsOf = (bars) => {
    let at = 0;
    return bars.map((n, k) => {
        const p = { startMs: at, endMs: at + n * 4 * BEAT_MS, kind: "part", seed: k };
        at = p.endMs;
        return p;
    });
};
const idsIn = (plan, slots, part) => [...new Set(plan.filter((f, i) => f && slots[i].t >= part.startMs && slots[i].t < part.endMs).map((f) => f.id))];

test("no flavours chosen: no flavour anywhere, and the families' plan is the same with or without flavours", () => {
    const slots = slotsOf(64);
    const parts = partsOf([8, 8]);
    const plain = [{ name: "Stream", share: 1 }];
    const assign = assignByParts(slots, parts, plain, "sections", mulberry32(3));
    assert.ok(assignFlavours(slots, parts, assign, plain, "sections", mulberry32(4)).every((f) => f === null));
    const flavoured = [{ name: "Stream", share: 1, flavours: ["Rolls", "Trills"] }];
    assert.deepEqual(assignByParts(slots, parts, flavoured, "sections", mulberry32(3)), assign);
});

test("by song parts: the flavours take turns from part to part, so parts next to each other differ", () => {
    const slots = slotsOf(4 * 8 * 4);
    const parts = partsOf([8, 8, 8, 8]);
    const patterns = [{ name: "Jumpstream", share: 1, flavours: ["Jumptrill", "SplitTrill", "Anchor"] }];
    const assign = assignByParts(slots, parts, patterns, "sections", mulberry32(1));
    const plan = assignFlavours(slots, parts, assign, patterns, "sections", mulberry32(2));
    const perPart = parts.map((p) => idsIn(plan, slots, p));
    assert.ok(perPart.every((ids) => ids.length === 1), JSON.stringify(perPart));
    for (let k = 1; k < perPart.length; k += 1) assert.notEqual(perPart[k][0], perPart[k - 1][0]);
    assert.equal(new Set(perPart.flat()).size, 3, "all three get their turn");
});

test("by song parts: a part longer than 16 bars moves on every 8 bars", () => {
    const slots = slotsOf(32 * 4);
    const parts = partsOf([32]);
    const patterns = [{ name: "Stream", share: 1, flavours: ["Rolls", "Trills"] }];
    const assign = assignByParts(slots, parts, patterns, "sections", mulberry32(1));
    const plan = assignFlavours(slots, parts, assign, patterns, "sections", mulberry32(5));
    const byBar = Array.from({ length: 32 }, (_, bar) => plan[bar * 16].id);
    for (let bar = 0; bar < 32; bar += 1) assert.equal(byBar[bar], byBar[bar - (bar % 8)], `bar ${bar} keeps its phrase's flavour`);
    for (let bar = 8; bar < 32; bar += 8) assert.notEqual(byBar[bar], byBar[bar - 1], `a new flavour at bar ${bar}`);
    // the phrase number grows, so the anchor or pair of each phrase differs
    assert.ok(plan[0].phrase < plan[31 * 16].phrase);
});

test("mixed: every family switches flavour every 4–8 bars, never to the same one", () => {
    const slots = slotsOf(64 * 4);
    const parts = partsOf([64]);
    const patterns = [{ name: "Chordjack", share: 1, flavours: ["Handjack", "Quadhand", "Quadstream"] }];
    const assign = assignByParts(slots, parts, patterns, "mixed", mulberry32(1));
    const plan = assignFlavours(slots, parts, assign, patterns, "mixed", mulberry32(9));
    const phrases = [];
    plan.forEach((f, i) => {
        if (!f) return;
        const bar = Math.floor(slots[i].beat / 4);
        if (!phrases.length || phrases.at(-1).f !== f) phrases.push({ f, from: bar, to: bar });
        else phrases.at(-1).to = bar;
    });
    assert.ok(phrases.length >= 8, `${phrases.length} phrases`);
    for (let k = 1; k < phrases.length; k += 1) {
        assert.notEqual(phrases[k].f.id, phrases[k - 1].f.id);
        if (k < phrases.length - 1) {
            const bars = phrases[k].to - phrases[k].from + 1;
            assert.ok(bars >= 4 && bars <= 8, `phrase of ${bars} bars`);
        }
    }
});

test("a part's own flavours win over the map's; an empty part has none", () => {
    const slots = slotsOf(48);
    const parts = partsOf([4, 4, 4]);
    parts[1].patterns = [{ name: "Jack", share: 1, flavours: ["Longjacks"] }];
    parts[2].empty = true;
    const defaults = [{ name: "Stream", share: 1, flavours: ["Trills"] }];
    const assign = assignByParts(slots, parts, defaults, "sections", mulberry32(1));
    const plan = assignFlavours(slots, parts, assign, defaults, "sections", mulberry32(2));
    assert.deepEqual(idsIn(plan, slots, parts[0]), ["Trills"]);
    assert.deepEqual(idsIn(plan, slots, parts[1]), ["Longjacks"]);
    assert.deepEqual(idsIn(plan, slots, parts[2]), []);
});

// ---- scoring ----

test("NAME_FAMILY knows the finder's core names and its jumptrill; the old names keep their families", () => {
    assert.equal(NAME_FAMILY.Jumptrill, "Jumpstream");
    assert.equal(NAME_FAMILY.Chordstream, "Jumpstream");
    assert.equal(NAME_FAMILY.Jacks, "Jack");
    for (const [name, family] of Object.entries({ Rolls: "Stream", "Split Trill": "Jumpstream", Quadstream: "Chordjack", Gluts: "Jack" })) assert.equal(NAME_FAMILY[name], family);
    assert.equal(patternScore([{ name: "Jumptrill", share: 0.7 }, { name: "Stream", share: 0.3 }], ["Jumpstream"]), 0.7);
});

const jumptrillRows = (n, flavour) => Array.from({ length: n }, (_, k) => ({ t: k * 90, mask: k % 2 ? 12 : 3, ...(flavour ? { flavour } : {}) }));
const singlesRows = (n, flavour) => Array.from({ length: n }, (_, k) => ({ t: k * 90, mask: 1 << ((k * 3) % 4), ...(flavour ? { flavour } : {}) }));

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const byFinder = (top3) => (fams) => patternScore(top3, fams);

test("without flavours the score is the family score, exactly as before", () => {
    const s = flavourAwareScore({ rows: jumptrillRows(40), top3: [{ name: "Jumpstream", share: 1 }], families: ["Jumpstream"], familyScoreOf: () => 0.83 });
    assert.deepEqual(s, { score: 0.83, target: 0.83, patternScore: 0.83, flavourScore: null, familyScore: 0.83, coverage: null });
    assert.equal(flavourCoverageOf(jumptrillRows(40), []), null);
});

test("planShares: each family's share of the planned slots, empty slots left out", () => {
    assert.deepEqual(planShares(["Stream", "Stream", null, "Jack"]), { Stream: 2 / 3, Jack: 1 / 3 });
    assert.deepEqual(planShares(["Stream", "Stream", null, "Jack"], 2, 4), { Jack: 1 });
});

test("with flavours: target = plain families' score + share × flavour coverage; rank = target + 0.1 × family score", () => {
    // half plain Stream, half Jumpstream planned as jumptrills
    const rows = [...jumptrillRows(20, "Jumptrill").map((r) => ({ ...r, family: "Jumpstream" })),
        ...singlesRows(20).map((r) => ({ ...r, t: r.t + 5000, family: "Stream" }))];
    const shares = { Stream: 0.5, Jumpstream: 0.5 };
    const families = ["Stream", "Jumpstream"];
    const top3 = [{ name: "Jumptrill", share: 0.5 }, { name: "Stream", share: 0.5 }];
    const s = flavourAwareScore({ rows, top3, families, shares, familyScoreOf: byFinder(top3) });
    near(s.coverage.Jumptrill.ours, 1, "our detector finds every planned jumptrill row");
    near(s.coverage.Jumptrill.finder, 1, "the finder names as much of the map as was planned");
    near(s.target, 0.5 + 0.5 * 1, "target");
    near(s.score, s.target + FAMILY_TIEBREAK * 1, "rank");
    near(s.flavourScore, 1, "flavour score");
    near(s.patternScore, 1, "pattern score");
    // the same map whose planned jumptrills came out as singles: the family score cannot make up for it
    const flat = [...singlesRows(20, "Jumptrill").map((r) => ({ ...r, family: "Jumpstream" })), ...rows.slice(20)];
    const top3b = [{ name: "Jumpstream", share: 0.5 }, { name: "Stream", share: 0.5 }];
    const missed = flavourAwareScore({ rows: flat, top3: top3b, families, shares, familyScoreOf: byFinder(top3b) });
    near(missed.flavourScore, 0, "nothing came out");
    near(missed.target, 0.5, "only the plain family counts");
    assert.ok(s.score > missed.score + 0.4, "flavour first");
    // the same flavour result: the family decides
    const one = jumptrillRows(40, "Jumptrill");
    const good = flavourAwareScore({ rows: one, top3: [{ name: "Jumptrill", share: 1 }], families: ["Jumpstream"], familyScoreOf: () => 0.9 });
    const weak = flavourAwareScore({ rows: one, top3: [{ name: "Jumptrill", share: 1 }], families: ["Jumpstream"], familyScoreOf: () => 0.2 });
    near(good.target, weak.target, "same target");
    near(good.score - weak.score, FAMILY_TIEBREAK * 0.7, "family second");
    // the finder naming it counts too (FINDER_WEIGHT of a named flavour's coverage)
    const unnamed = flavourAwareScore({ rows: one, top3: [{ name: "Jumpstream", share: 1 }], families: ["Jumpstream"], familyScoreOf: () => 0.9 });
    near(good.flavourScore - unnamed.flavourScore, FINDER_WEIGHT, "finder part");
    // no finder result at all (an excerpt not analysed): our detector alone
    near(flavourAwareScore({ rows: one, top3: null, families: ["Jumpstream"], familyScoreOf: () => 0 }).flavourScore, 1, "ours only");
});

// ---- biasing ----

test("sampleRow: the motif bends the learned rows, and without it the draws are the old ones", () => {
    const table = { Jumpstream: { "3,12,2": { 5: 50, 10: 50, 12: 1 } } };
    const size = [1, 1, 1, 1];
    const draw = (bias, seed) => {
        const rng = mulberry32(seed);
        return Array.from({ length: 200 }, () => sampleRow(table, "Jumpstream", 3, 12, size, rng, null, null, bias));
    };
    const plain = draw(null, 1);
    assert.deepEqual(draw(undefined, 1), plain);
    const motif = draw(motifWeights("Jumptrill", [3, 12]), 1);
    const share = (rows, m) => rows.filter((x) => x === m).length / rows.length;
    assert.ok(share(plain, 12) < 0.05);
    assert.ok(share(motif, 12) > 0.9, `jumptrill continues with [34]: ${share(motif, 12)}`);
});

test("rule path: flavoured slots follow the motif, the others are untouched", () => {
    const slots = slotsOf(128);
    const intensity = new Float64Array(slots.length).fill(1);
    const assign = new Array(slots.length).fill("Stream");
    const base = buildChart({ slots, intensity, assign, lambda: 1.2, seed: 4, bpm: 160 });
    assert.deepEqual(buildChart({ slots, intensity, assign, lambda: 1.2, seed: 4, bpm: 160, flavour: new Array(slots.length).fill(null) }), base);
    const phrase = { id: "Trills", phrase: 0 };
    const rows = buildChart({ slots, intensity, assign, lambda: 1.2, seed: 4, bpm: 160, flavour: new Array(slots.length).fill(phrase) });
    assert.ok(rows.every((r) => r.flavour === "Trills"));
    const shares = Object.fromEntries(flavourShares(rows.map((r) => ({ t: r.t, cols: r.cols }))).map((x) => [x.id, x.share]));
    const before = Object.fromEntries(flavourShares(base).map((x) => [x.id, x.share]));
    assert.ok(shares.Trills > 0.6 && shares.Trills > 3 * before.Trills, `trills ${shares.Trills} vs ${before.Trills}`);
});

test("rule path: 2/4 chordjack slots are jumps and quads in turn, with a jack on every row", () => {
    const slots = slotsOf(128);
    const intensity = new Float64Array(slots.length).fill(1);
    const assign = new Array(slots.length).fill("Chordjack");
    const share = (rows, id) => flavourShares(rows.map((r) => ({ t: r.t, cols: r.cols }))).find((x) => x.id === id).share;
    for (const lambda of [0.5, 1.2]) {
        const base = buildChart({ slots, intensity, assign, lambda, seed: 4, bpm: 160 });
        for (const phrase of [0, 1]) {
            const rows = buildChart({ slots, intensity, assign, lambda, seed: 4, bpm: 160, flavour: new Array(slots.length).fill({ id: "JumpQuad", phrase }) });
            assert.ok(share(rows, "JumpQuad") > 0.85 && share(base, "JumpQuad") < 0.1, `λ ${lambda}: ${share(rows, "JumpQuad")} vs ${share(base, "JumpQuad")}`);
            const sizes = rows.map((r) => r.cols.length);
            assert.ok(sizes.filter((n) => n === 2 || n === 4).length / sizes.length > 0.97);
            // every jump of the six comes up, the quads about every other row
            const jumps = new Set(rows.filter((r) => r.cols.length === 2).map((r) => r.cols.join("")));
            assert.equal(jumps.size, 6, [...jumps].join(" "));
            assert.ok(Math.abs(sizes.filter((n) => n === 4).length / sizes.length - 0.5) < 0.08);
        }
    }
});

const song = { timing: { bpm: PARTS_SONG_BPM, offsetMs: PARTS_SONG_OFFSET }, envelope: onsetEnvelope(partsSong(), 22050), durationMs: PARTS_SONG.at(-1).endMs };
const stand = async (text) => ({ kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / 150) * 100) / 100, top3: [{ name: "Jumpstream", share: 1 }] });

test("learned path: a flavour shows in the map (coverage far above the family alone), with the flavour scores reported", async () => {
    const run = (patterns) => generateLearnedMap({ ...song, request: { range: { lo: 5.5, hi: 6.5 }, patterns, mix: "sections", stamina: 0.5, burst: 0.3, seed: 7 }, meta: { title: "t", audioFilename: "a.mp3" } },
        stand, goldenModel, { patternsOf: () => [{ name: "Jumpstream", share: 1 }] });
    const plain = await run([{ name: "Jumpstream", share: 1 }]);
    const flavoured = await run([{ name: "Jumpstream", share: 1, flavours: ["SplitTrill"] }]);
    const cover = (r) => flavourShares(parseRows(r.osuText, 4)).find((x) => x.id === "SplitTrill").share;
    assert.ok(cover(flavoured) > 0.5 && cover(flavoured) > 3 * cover(plain), `${cover(flavoured)} vs ${cover(plain)}`);
    // the stand-in finder never names split trills, so only our detector's half of the score is there to get
    assert.ok(flavoured.flavourScore > 0.4, String(flavoured.flavourScore));
    assert.ok(Number.isFinite(flavoured.familyScore));
    assert.equal(plain.flavourScore, undefined);
    assert.equal(flavoured.flavours[0].id, "SplitTrill");
    assert.ok(flavoured.parts.some((p) => p.flavours.includes("SplitTrill") && Number.isFinite(p.flavourScore)));
    assert.ok(plain.parts.every((p) => p.flavours.length === 0 && p.flavourScore === null));
});

test("rule path end to end: a flavour shows and is scored", async () => {
    const run = (patterns) => generateMap({ ...song, request: { target: 6, patterns, mix: "sections", stamina: 0.5, burst: 0.3, seed: 7 }, meta: { title: "t", audioFilename: "a.mp3" } }, stand);
    const longjacks = (r) => flavourShares(parseRows(r.osuText, 4)).find((x) => x.id === "Longjacks").share;
    const plain = await run([{ name: "Jack", share: 1 }]);
    const r = await run([{ name: "Jack", share: 1, flavours: ["Longjacks"] }]);
    assert.ok(longjacks(r) > 0.25 && longjacks(r) > 3 * longjacks(plain), `${longjacks(r)} vs ${longjacks(plain)}`);
    assert.ok(r.flavourScore > 0.15 && plain.flavourScore === undefined, String(r.flavourScore));
});

test("both paths end to end: the 2/4 chordjack shows and is scored, Quadhand on the same song is another motif", async () => {
    const chordjacks = async (text) => ({ kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / 250) * 100) / 100, top3: [{ name: "Chordjacks", share: 1 }] });
    const input = (flavours) => ({ ...song, request: { target: 9, range: { lo: 8.5, hi: 9.5 }, patterns: [{ name: "Chordjack", share: 1, ...(flavours ? { flavours } : {}) }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7 }, meta: { title: "t", audioFilename: "a.mp3" } });
    const shares = (r) => Object.fromEntries(flavourShares(parseRows(r.osuText, 4)).map((x) => [x.id, x.share]));
    for (const engine of ["rules", "learned"]) {
        const run = (flavours) => (engine === "rules" ? generateMap(input(flavours), chordjacks)
            : generateLearnedMap(input(flavours), chordjacks, goldenModel, { patternsOf: () => [{ name: "Chordjack", share: 1 }] }));
        const plain = shares(await run(null));
        const r = await run(["JumpQuad"]);
        const quad = shares(await run(["Quadhand"]));
        const mine = shares(r);
        assert.ok(mine.JumpQuad > 0.6 && mine.JumpQuad > 3 * plain.JumpQuad, `${engine}: ${mine.JumpQuad} vs ${plain.JumpQuad}`);
        assert.ok(r.flavourScore > 0.5, `${engine}: ${r.flavourScore}`);
        assert.equal(r.flavours[0].id, "JumpQuad", engine);
        assert.ok(quad.JumpQuad < 0.1 && mine.Quadhand < 0.1, `${engine}: the two motifs stay apart (${quad.JumpQuad}, ${mine.Quadhand})`);
    }
});

test("families only, with a finder naming only Jumpstream and Chordjacks: both generators write exactly the maps they wrote before flavours existed", async () => {
    assert.deepEqual(await goldenCases(), GOLDEN);
});

// Not the old maps: the fuller finder-name table (NAME_FAMILY) moves family-only learned maps whenever the finder
// reports Chordstream, Jacks, Brackets …, since the search keeps the attempt with the best pattern score. Recorded on
// purpose with the new table; with the old one 6 of these 16 come out differently (Jumpstream, Handstream and Jack,
// both seeds).
test("families only, with a finder naming Chordstream, Jacks, Brackets …: the learned maps the fuller name table gives", async () => {
    assert.deepEqual(await goldenNamedCases(), GOLDEN_NAMES);
});
