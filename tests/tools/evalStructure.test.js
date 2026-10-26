import test from "node:test";
import assert from "node:assert/strict";
import { boundaryF, barRowSets, jaccard, humanChangePoints } from "../../tools/eval-structure.mjs";
import { sectionFamily } from "../../src/gen/mapRows.js";

const BEAT = 500;
const bars = Array.from({ length: 24 }, (_, k) => ({ startMs: k * 4 * BEAT, endMs: (k + 1) * 4 * BEAT, beatMs: BEAT }));

test("boundary F matches each truth line once, within the tolerance", () => {
    assert.deepEqual(boundaryF([], []), { f: 1, precision: 1, recall: 1, hits: 0 });
    assert.equal(boundaryF([8, 16], [8, 16]).f, 1);
    assert.equal(boundaryF([9, 15], [8, 16]).f, 1);
    assert.equal(boundaryF([10], [8]).f, 0);
    // two finds next to one truth line: one hit
    const r = boundaryF([7, 8], [8]);
    assert.equal(r.hits, 1);
    assert.ok(Math.abs(r.f - 2 / 3) < 1e-9);
    assert.equal(r.precision, 0.5);
    assert.equal(r.recall, 1);
});

test("bar row sets key rows by their place in the bar and their columns, optionally mirrored", () => {
    const rows = [
        { t: 0, mask: 1 },
        { t: 250, mask: 2 },
        { t: 2000, mask: 1 },
        { t: 2250, mask: 2 },
        { t: 4000 + 1000 / 3, mask: 8 },
    ];
    const sets = barRowSets(rows, bars);
    assert.equal(jaccard(sets[0], sets[1]), 1);
    assert.equal(jaccard(sets[0], sets[2]), 0);
    assert.equal(jaccard(sets[3], sets[4]), null);
    assert.equal(sets[2].size, 1);
    const mirrored = barRowSets(rows, bars, true);
    assert.equal(jaccard(sets[0], mirrored[1]), 0);
    const flipped = barRowSets([{ t: 0, mask: 8 }, { t: 250, mask: 4 }], bars, true);
    assert.equal(jaccard(sets[0], flipped[0]), 1);
});

test("human change points: a density jump and a family change, one line per change", () => {
    const rows = [];
    // bars 0–7: one note per beat (stream-ish); bars 8–15: 1/4 jumps (twice the rows, chords); bars 16–23: jacks
    for (let k = 0; k < 24; k += 1) {
        for (let q = 0; q < (k >= 8 && k < 16 ? 16 : 4); q += 1) {
            const t = k * 4 * BEAT + (q * 4 * BEAT) / (k >= 8 && k < 16 ? 16 : 4);
            const mask = k < 8 ? 1 << q % 4 : k < 16 ? (q % 2 ? 3 : 12) : 1;
            rows.push({ t, mask });
        }
    }
    for (const densityBars of [2, 4]) {
        const changes = humanChangePoints(rows, bars, sectionFamily, 0, 23, { densityBars });
        assert.ok(changes.some((k) => Math.abs(k - 8) <= 1), `changes ${changes}`);
        assert.ok(changes.some((k) => Math.abs(k - 16) <= 1), `changes ${changes}`);
        assert.ok(changes.every((k) => Math.abs(k - 8) <= 2 || Math.abs(k - 16) <= 2), `changes ${changes}`);
        // nothing near the edges of the mapped bars
        assert.ok(changes.every((k) => k >= 2 && k <= 22));
    }
    // the mapped range limits the windows: a map that starts at bar 8 has no change there
    const later = humanChangePoints(rows.filter((r) => r.t >= 8 * 4 * BEAT), bars, sectionFamily, 8, 23);
    assert.ok(later.every((k) => k >= 10), `changes ${later}`);
});
