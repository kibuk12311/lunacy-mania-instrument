import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest, normalizeParts } from "../../src/gen/request.js";
import { deriveSeed } from "../../src/gen/rng.js";
import { setLang } from "../../src/i18n/i18n.js";

test("deriveSeed: the same inputs give the same seed, near inputs unrelated ones", () => {
    assert.equal(deriveSeed(7, 1, 2), deriveSeed(7, 1, 2));
    const seeds = new Set([deriveSeed(7, 1, 2), deriveSeed(7, 2, 1), deriveSeed(7, 1, 3), deriveSeed(8, 1, 2), deriveSeed(7, 1)]);
    assert.equal(seeds.size, 5);
    assert.ok(Number.isInteger(deriveSeed(-5, 2 ** 40)) && deriveSeed(-5) >= 0 && deriveSeed(-5) < 2 ** 32);
});

test("normalizeRequest fills in seeds, snaps, normalizeSv and the slider defaults", () => {
    const r = normalizeRequest({ range: { lo: 12.5, hi: 13.5 }, patterns: [{ name: "Stream", share: 3 }, { name: "Jack", share: 1 }], seed: 5 }, 60000);
    assert.deepEqual(r.range, { lo: 12.5, hi: 13.5 });
    assert.equal(r.target, 13);
    assert.deepEqual(r.patterns, [{ name: "Stream", share: 0.75 }, { name: "Jack", share: 0.25 }]);
    assert.equal(r.planSeed, 5);
    assert.equal(r.noteSeed, 5);
    assert.deepEqual(r.snaps, [4]);
    assert.equal(r.normalizeSv, true);
    assert.equal(r.mix, "sections");
    assert.equal(r.stamina, 0.5);
    assert.equal(r.burst, 0.3);
    const own = normalizeRequest({ target: 8, patterns: [{ name: "Tech", share: 1 }], seed: 1, planSeed: 2, noteSeed: 3, snaps: [8, 4, 3], normalizeSv: false, stamina: 0, burst: 1, mix: "mixed" }, 60000);
    assert.equal(own.range, null);
    assert.equal(own.target, 8);
    assert.deepEqual([own.planSeed, own.noteSeed], [2, 3]);
    assert.deepEqual(own.snaps, [4, 3, 8]);
    assert.equal(own.normalizeSv, false);
    assert.deepEqual([own.stamina, own.burst, own.mix], [0, 1, "mixed"]);
});

test("normalizeParts sorts, clips, closes gaps and covers the whole song", () => {
    const parts = normalizeParts([
        { startMs: 30000, endMs: 95000, kind: "drop" },
        { startMs: 2000, endMs: 25000, kind: "intro", range: { lo: 3, hi: 5 } },
    ], 90000);
    assert.deepEqual(parts.map((p) => [p.startMs, p.endMs, p.kind]), [[0, 30000, "intro"], [30000, 90000, "drop"]]);
    assert.deepEqual(parts[0].range, { lo: 3, hi: 5 });
});

test("parts shorter than a bar join a neighbour, and at most 24 stay", () => {
    const tiny = normalizeParts([
        { startMs: 0, endMs: 10000, kind: "intro" },
        { startMs: 10000, endMs: 10500, kind: "drop" },
        { startMs: 10500, endMs: 60000, kind: "break", empty: true },
    ], 60000, { barMs: 2000 });
    assert.deepEqual(tiny.map((p) => [p.startMs, p.endMs, p.kind]), [[0, 10500, "intro"], [10500, 60000, "break"]]);
    assert.equal(tiny[1].empty, true);
    const many = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 5000, endMs: (i + 1) * 5000, kind: "part" }));
    const capped = normalizeParts(many, 200000, { barMs: 2000 });
    assert.equal(capped.length, 24);
    assert.equal(capped[0].startMs, 0);
    assert.equal(capped.at(-1).endMs, 200000);
    capped.forEach((p, i) => i && assert.equal(p.startMs, capped[i - 1].endMs));
});

test("part patterns are normalised and bad parts are refused with a message that names the field", () => {
    const [p] = normalizeParts([{ startMs: 0, endMs: 60000, kind: "drop", patterns: [{ name: "Jumpstream", share: 2 }, { name: "Tech", share: 2 }] }], 60000);
    assert.deepEqual(p.patterns, [{ name: "Jumpstream", share: 0.5 }, { name: "Tech", share: 0.5 }]);
    setLang("en");
    try {
        assert.throws(() => normalizeParts([{ startMs: 0, endMs: 60000, kind: "solo" }], 60000), /The song parts are invalid: parts\[0\]\.kind/);
        assert.throws(() => normalizeParts([{ startMs: 0, endMs: 60000, kind: "drop", range: { lo: 5, hi: 4 } }], 60000), /parts\[0\]\.range/);
        assert.throws(() => normalizeParts([{ startMs: 0, endMs: 60000, kind: "drop", patterns: [{ name: "Polka", share: 1 }] }], 60000), /parts\[0\]\.patterns/);
        const nine = Array.from({ length: 9 }, (_, i) => ({ startMs: i * 10000, endMs: (i + 1) * 10000, kind: "part", range: { lo: 3, hi: 4 } }));
        assert.throws(() => normalizeParts(nine, 90000), /parts/);
    } finally {
        setLang("ru");
    }
    assert.throws(() => normalizeParts([{ startMs: 0, endMs: 60000, kind: "solo" }], 60000), /Части песни заданы неверно/);
});
