import test from "node:test";
import assert from "node:assert/strict";
import { summarizePatterns } from "../src/core/patterns.js";

function cluster(name, amount, mixed = false) {
    return { Pattern: "Chordstream", SpecificTypes: [[name, 1]], Amount: amount, Mixed: mixed };
}

const MSD_BASE = { overall: 25, stream: 20, jumpstream: 25, handstream: 22, stamina: 21, jackspeed: 15, chordjack: 18, technical: 20 };

test("top3 shares are fractions of total pattern time", () => {
    const report = { Clusters: [cluster("Jumpstream", 600), cluster("Handstream", 300), cluster("Chordjacks", 100)] };
    const s = summarizePatterns(report, MSD_BASE);
    assert.equal(s.primary, "Jumpstream");
    assert.deepEqual(s.top3.map((x) => x.name), ["Jumpstream", "Handstream", "Chordjacks"]);
    assert.deepEqual(s.top3.map((x) => Number(x.share.toFixed(3))), [0.6, 0.3, 0.1]);
});

test("same-name clusters are summed", () => {
    const report = { Clusters: [cluster("Jumpstream", 300), cluster("Handstream", 400), cluster("Jumpstream", 300)] };
    const s = summarizePatterns(report, MSD_BASE);
    assert.equal(s.primary, "Jumpstream");
    assert.equal(Number(s.top3[0].share.toFixed(3)), 0.6);
});

test("mixed rhythm without technical MSD is not Tech", () => {
    const report = { Clusters: [cluster("Jumpstream", 600, true)] };
    assert.equal(summarizePatterns(report, MSD_BASE).tech, false);
});

test("mixed rhythm with leading technical MSD is Tech", () => {
    const report = { Clusters: [cluster("Jumpstream", 600, true)] };
    assert.equal(summarizePatterns(report, { ...MSD_BASE, technical: 25 }).tech, true);
});

test("steady rhythm is not Tech even with high technical MSD", () => {
    const report = { Clusters: [cluster("Jumpstream", 600, false)] };
    assert.equal(summarizePatterns(report, { ...MSD_BASE, technical: 30 }).tech, false);
});

test("empty report", () => {
    assert.deepEqual(summarizePatterns({ Clusters: [] }, MSD_BASE), { primary: null, top3: [], tech: false });
    assert.deepEqual(summarizePatterns(null, null), { primary: null, top3: [], tech: false });
});
