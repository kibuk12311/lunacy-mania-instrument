// The analysis tab's difficulty line and pattern strip: binned Sunny strain, the hardest stretches,
// the pattern family of each stretch of the map, and the details job that puts them together.
import test from "node:test";
import assert from "node:assert/strict";
import { makeChart } from "./fixtures/makeChart.js";
import { chartInfo } from "../src/core/features.js";
import { BINS, binStrain, hardestRanges, familyOf, binFamilies, familyShares, computeDetails, detailsJob } from "../src/analysis/timeline.js";

const inst = (Pattern, SpecificType, Start, End, { Mixed = false, MsPerBeat = 333 } = {}) => ({ Pattern, SpecificType, Mixed, Start, End, MsPerBeat });

test("binStrain keeps the highest value per bin, zero for empty bins and NaN, scaled to the map's peak", () => {
    const strain = binStrain([0, 5, 12, 25, 31, 39, 50], [1, 3, NaN, 2, 8, 4, 99], { startMs: 0, endMs: 40, bins: 4 });
    // 0–10: max(1, 3); 10–20: NaN only; 20–30: 2; 30–40: max(8, 4); 50 lies past the end
    assert.deepEqual(strain, [0.375, 0, 0.25, 1]);
    assert.equal(BINS, 120);
    assert.equal(binStrain([1, 2], [5, 5], { startMs: 0, endMs: 10 }).length, BINS);
});

test("binStrain: points before the start are left out, the last point lands in the last bin, three decimals", () => {
    assert.deepEqual(binStrain([-5, 0, 10, 30], [9, 3, 1, 7], { startMs: 0, endMs: 30, bins: 3 }), [0.429, 0.143, 1]);
    assert.deepEqual(binStrain([], [], { startMs: 0, endMs: 30, bins: 3 }), [0, 0, 0]);
    assert.deepEqual(binStrain([1, 2], [0, -1], { startMs: 0, endMs: 30, bins: 3 }), [0, 0, 0]);
    assert.deepEqual(binStrain([1], [1], { startMs: 10, endMs: 10, bins: 2 }), [0, 0]);
});

test("hardestRanges merges neighbouring bins near the peak, in seconds, strongest first", () => {
    // 10 bins over 20 s: bins 2–3 (peak 1) and 6–8 (peak 0.9) reach 0.85 of the peak
    const strain = [0.1, 0.5, 0.9, 1, 0.2, 0.3, 0.86, 0.9, 0.88, 0.1];
    assert.deepEqual(hardestRanges(strain, { durationSec: 20 }), [
        { fromSec: 4, toSec: 8, peak: 1 },
        { fromSec: 12, toSec: 18, peak: 0.9 },
    ]);
});

test("hardestRanges: short runs are dropped except the peak's own, which widens to minBins; at most max ranges", () => {
    const strain = [0.2, 1, 0.5, 0.9, 0.2, 0.95, 0.95, 0.2, 0.9, 0.9, 0.2, 0.88, 0.9];
    const ranges = hardestRanges(strain, { durationSec: 13, max: 3 });
    // the peak (bin 1) is alone and widens over its stronger neighbour; bin 3 alone is noise
    assert.deepEqual(ranges.map((r) => [r.fromSec, r.toSec, r.peak]), [[1, 3, 1], [5, 7, 0.95], [8, 10, 0.9]]);
    assert.equal(hardestRanges(strain, { durationSec: 13, max: 1 }).length, 1);
    assert.deepEqual(hardestRanges(strain, { durationSec: 13, minBins: 1 }).map((r) => r.fromSec), [1, 5, 3]);
    assert.deepEqual(hardestRanges([0, 0, 0], { durationSec: 3 }), []);
    assert.deepEqual(hardestRanges([1, 1], { durationSec: 0 }), []);
});

test("familyOf: the whole table", () => {
    assert.equal(familyOf(inst("Stream", null, 0, 10)), "stream");
    assert.equal(familyOf(inst("Stream", "Minitrills", 0, 10)), "stream");
    assert.equal(familyOf(inst("Chordstream", "Handstream", 0, 10)), "handstream");
    assert.equal(familyOf(inst("Chordstream", "Jumpstream", 0, 10)), "jumpstream");
    assert.equal(familyOf(inst("Chordstream", "Split Trill", 0, 10)), "jumpstream");
    assert.equal(familyOf(inst("Chordstream", null, 0, 10)), "jumpstream");
    assert.equal(familyOf(inst("Jacks", "Chordjacks", 0, 10)), "chordjack");
    assert.equal(familyOf(inst("Jacks", "Minijacks", 0, 10)), "jack");
    assert.equal(familyOf(inst("Jacks", null, 0, 10)), "jack");
    // by the generator's own table (search.js NAME_FAMILY): a quadstream is a chordjack, gluts and longjacks jacks
    assert.equal(familyOf(inst("Jacks", "Quadstream", 0, 10)), "chordjack");
    assert.equal(familyOf(inst("Jacks", "Gluts", 0, 10)), "jack");
    assert.equal(familyOf(inst("Chordstream", "Jumptrill", 0, 10)), "jumpstream");
    for (const p of ["Coordination", "Density", "Wildcard"]) assert.equal(familyOf(inst(p, null, 0, 10)), null);
    assert.equal(familyOf(inst("Coordination", "Release", 0, 10)), null);
    // 60000 / 2500 = 24 BPM: too slow to count, as the pattern report drops it
    assert.equal(familyOf(inst("Stream", null, 0, 10, { MsPerBeat: 2500 })), null);
    assert.equal(familyOf(inst("Stream", null, 0, 10, { MsPerBeat: 2400 })), "stream");
    assert.equal(familyOf(inst("Stream", null, 0, 10, { MsPerBeat: 0 })), null);
});

test("binFamilies picks the family that covers most of each bin, by time overlap", () => {
    // 4 bins of 100 ms
    const families = binFamilies([
        inst("Chordstream", "Jumpstream", 0, 70),
        inst("Stream", null, 60, 100), // bin 0: jumpstream 70 ms vs stream 40 ms
        inst("Jacks", "Chordjacks", 100, 200),
        inst("Jacks", null, 150, 200), // bin 1: chordjack covers all of it
        inst("Coordination", null, 200, 300), // bin 2: nothing that counts → break
        inst("Stream", null, 300, 320), // bin 3: 20% covered → break
    ], { durationMs: 400, rate: 1, bins: 4 });
    assert.deepEqual(families, ["jumpstream", "chordjack", "-", "-"]);
});

test("binFamilies: overlapping instances count once, minCover and the tech share, times divided by the rate", () => {
    // overlapping windows of one stretch cover 40% of the bin, not 80%
    assert.deepEqual(binFamilies([inst("Stream", null, 0, 40), inst("Stream", null, 0, 40)], { durationMs: 100, rate: 1, bins: 1 }), ["stream"]);
    assert.deepEqual(binFamilies([inst("Stream", null, 0, 25), inst("Stream", null, 0, 25)], { durationMs: 100, rate: 1, bins: 1 }), ["-"]);
    assert.deepEqual(binFamilies([inst("Stream", null, 0, 50)], { durationMs: 100, rate: 1, bins: 1, minCover: 0.6 }), ["-"]);
    // uneven rhythm over 60% of the bin is tech, whichever family it is
    assert.deepEqual(binFamilies([inst("Chordstream", "Jumpstream", 0, 100, { Mixed: true })], { durationMs: 100, rate: 1, bins: 1 }), ["tech"]);
    assert.deepEqual(binFamilies([
        inst("Chordstream", "Jumpstream", 0, 100),
        inst("Stream", null, 0, 50, { Mixed: true }),
    ], { durationMs: 100, rate: 1, bins: 1 }), ["jumpstream"]);
    // at 2x a pattern at 0–200 ms of the chart plays in 0–100 ms
    assert.deepEqual(binFamilies([inst("Jacks", null, 0, 200)], { durationMs: 200, rate: 2, bins: 2 }), ["jack", "-"]);
    assert.deepEqual(binFamilies([], { durationMs: 0, rate: 1, bins: 2 }), ["-", "-"]);
});

test("familyShares: share of the played bins per family, largest first, breaks left out", () => {
    assert.deepEqual(familyShares(["jumpstream", "-", "jumpstream", "tech", "-", "jumpstream", "handstream", "handstream"]), [
        { family: "jumpstream", share: 0.5 },
        { family: "handstream", share: 0.333 },
        { family: "tech", share: 0.167 },
    ]);
    assert.deepEqual(familyShares(["-", "-"]), []);
});

test("computeDetails on a synthetic jumpstream: 120 bins, the card's duration, the expected family", () => {
    const text = makeChart({ kind: "jumpstream", bpm: 180, seconds: 60 });
    for (const rate of [1, 1.5]) {
        const details = computeDetails(text, rate);
        assert.equal(details.v, 2);
        assert.equal(details.durationSec, chartInfo(text, rate).durationSec);
        assert.equal(details.strain.length, BINS);
        assert.equal(details.families.length, BINS);
        assert.equal(details.flavourBins.length, BINS);
        assert.ok(Array.isArray(details.flavours) && details.flavours.length <= 5);
        assert.equal(Math.max(...details.strain), 1);
        assert.ok(details.strain.every((v) => v >= 0 && v <= 1));
        assert.equal(familyShares(details.families)[0].family, "jumpstream");
        assert.ok(details.hardest.length >= 1 && details.hardest.length <= 3);
        for (const r of details.hardest) assert.ok(r.fromSec >= 0 && r.fromSec < r.toSec && r.toSec <= details.durationSec + 1e-9, JSON.stringify(r));
        assert.ok(JSON.stringify(details).length < 4000);
    }
    const stream = computeDetails(makeChart({ kind: "stream", bpm: 170, seconds: 40 }), 1);
    assert.equal(familyShares(stream.families)[0].family, "stream");
});

test("detailsJob is the worker's answer: the details, or an error with its message", () => {
    const text = makeChart({ kind: "stream", bpm: 150, seconds: 30 });
    const ok = detailsJob(text, 1);
    assert.equal(ok.kind, "details");
    assert.deepEqual(ok.details, computeDetails(text, 1));
    const bad = detailsJob("not a chart", 1);
    assert.equal(bad.kind, "error");
    assert.equal(typeof bad.message, "string");
    assert.ok(bad.message.length > 0);
});
