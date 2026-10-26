// "For you" on the analysis card: which of the player's tile dans a map is measured against, how far the map is
// from it (the band), the MinaCalc comparison, and the ladder rate that is the player's growth.
import test from "node:test";
import assert from "node:assert/strict";
import { tileForResult, msdAxisFor, bandFor, fitForSkill, growthRate } from "../src/analysis/mapFit.js";

const ok = (primary, rest = {}) => ({ kind: "ok", numeric: 13, primary, tech: false, msd: { stream: 24, jumpstream: 26, handstream: 21, chordjack: 22, jackspeed: 20, technical: 25 }, ...rest });
const SKILL = {
    overall: 12.5,
    overallLabel: "Gamma low",
    tiles: { speed: 13.1, stamina: 12.6, tech: 11.9, jack: null },
    msd: { Overall: 25, Stream: 25.4, Jumpstream: 24.9, Handstream: 23, Chordjack: 21, JackSpeed: 19, Technical: 24 },
};

test("tileForResult: tech wins, else the main pattern's tile, else nothing", () => {
    assert.equal(tileForResult(ok("Jumpstream", { tech: true })), "tech");
    for (const p of ["Jumpstream", "Handstream", "Chordstream", "Split Trill", "Jumptrill"]) assert.equal(tileForResult(ok(p)), "stamina", p);
    for (const p of ["Stream", "Rolls", "Trills", "Minitrills"]) assert.equal(tileForResult(ok(p)), "speed", p);
    for (const p of ["Chordjacks", "Jacks", "Minijacks", "Longjacks", "Gluts", "Quadstream"]) assert.equal(tileForResult(ok(p)), "jack", p);
    for (const p of ["Coordination", "Density", null, undefined]) assert.equal(tileForResult(ok(p)), null, String(p));
});

test("msdAxisFor: the pattern's MinaCalc skillset, none for plain jacks (as the picks tab ranks them)", () => {
    assert.deepEqual(msdAxisFor(ok("Jumpstream")), { ours: "jumpstream", tracker: "Jumpstream" });
    assert.deepEqual(msdAxisFor(ok("Handstream")), { ours: "handstream", tracker: "Handstream" });
    assert.deepEqual(msdAxisFor(ok("Rolls")), { ours: "stream", tracker: "Stream" });
    assert.deepEqual(msdAxisFor(ok("Chordjacks")), { ours: "chordjack", tracker: "Chordjack" });
    assert.deepEqual(msdAxisFor(ok("Stream", { tech: true })), { ours: "technical", tracker: "Technical" });
    assert.equal(msdAxisFor(ok("Minijacks")), null);
    assert.equal(msdAxisFor(ok("Jacks")), null);
    assert.equal(msdAxisFor(ok("Coordination")), null);
    // the main pattern's family is the generator's own table (search.js NAME_FAMILY): gluts are jacks, a quadstream a
    // chordjack, the finder's 7K-style chordstream names their families
    assert.equal(msdAxisFor(ok("Gluts")), null);
    assert.deepEqual(msdAxisFor(ok("Quadstream")), { ours: "chordjack", tracker: "Chordjack" });
    assert.deepEqual(msdAxisFor(ok("Dense Chordstream")), { ours: "chordjack", tracker: "Chordjack" });
});

test("bandFor: the edges", () => {
    const cases = [[-2, "easy"], [-0.61, "easy"], [-0.6, "comfort"], [-0.11, "comfort"], [-0.1, "growth"], [0, "growth"], [0.5, "growth"],
        [0.51, "challenge"], [1.2, "challenge"], [1.21, "hard"], [3, "hard"]];
    for (const [delta, band] of cases) assert.equal(bandFor(delta), band, String(delta));
});

test("fitForSkill against the tile dan, with the MSD comparison", () => {
    assert.deepEqual(fitForSkill(ok("Jumpstream"), SKILL), {
        tile: "stamina", source: "tile", playerDan: 12.6, delta: 0.4, band: "growth",
        msd: { axis: "Jumpstream", map: 26, player: 24.9, delta: 1.1 },
    });
    // tech wins over the main pattern
    const tech = fitForSkill(ok("Jumpstream", { tech: true, numeric: 11.2 }), SKILL);
    assert.equal(tech.tile, "tech");
    assert.equal(tech.delta, -0.7);
    assert.equal(tech.band, "easy");
    assert.deepEqual(tech.msd, { axis: "Technical", map: 25, player: 24, delta: 1 });
});

test("fitForSkill falls back to the overall dan; no MSD where either side lacks it; nothing without a dan", () => {
    // the jack tile has no dan on the tracker, and plain jacks have no MSD comparison
    assert.deepEqual(fitForSkill(ok("Minijacks", { numeric: 14 }), SKILL), {
        tile: "jack", source: "overall", playerDan: 12.5, delta: 1.5, band: "hard", msd: null,
    });
    const other = fitForSkill(ok("Coordination"), SKILL);
    assert.equal(other.source, "overall");
    assert.equal(other.tile, null);
    assert.equal(fitForSkill(ok("Stream", { msd: null }), SKILL).msd, null);
    assert.equal(fitForSkill(ok("Stream"), { ...SKILL, msd: {} }).msd, null);
    assert.equal(fitForSkill(ok("Stream"), { overall: null, tiles: {}, msd: {} }), null);
    assert.equal(fitForSkill(ok("Stream"), null), null);
    assert.equal(fitForSkill({ kind: "too-short" }, SKILL), null);
});

test("growthRate: the ladder rate whose dan is nearest the player's dan + 0.25", () => {
    const rows = [
        { rate: 0.9, numeric: 12.1 }, { rate: 1, numeric: 12.6 }, { rate: 1.1, numeric: 13.1 },
        { rate: 1.2, numeric: 13.6 }, { rate: 1.3, numeric: null },
    ];
    assert.equal(growthRate(rows, 12.5), 1); // 12.75: 12.6 is nearest
    assert.equal(growthRate(rows, 12.75), 1.1); // 13.0
    assert.equal(growthRate(rows, 13.2), 1.2);
    // a tie goes to the rate nearer 1.0x
    assert.equal(growthRate([{ rate: 1.2, numeric: 13 }, { rate: 1, numeric: 12 }], 12.25), 1);
    assert.equal(growthRate(rows, 20), 1.2);
    assert.equal(growthRate([], 12), null);
    assert.equal(growthRate(rows, null), null);
});
