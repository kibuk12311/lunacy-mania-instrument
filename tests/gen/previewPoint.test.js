// The song-select preview point (mapgen v3, stream C): the loudest drop, else the loudest 15 s, snapped back to a bar.
import test from "node:test";
import assert from "node:assert/strict";
import { pickPreviewMs } from "../../src/gen/previewPoint.js";

const HOP = 0.01;
// RMS loudness per 10 ms frame: quiet everywhere, `loud` (in seconds, [from, to)) at full level
function envelope(seconds, loud = [], { withEnergy = true } = {}) {
    const n = Math.round(seconds / HOP);
    const level = Float32Array.from({ length: n }, (_, f) => (loud.some(([a, b]) => f * HOP >= a && f * HOP < b) ? 1 : 0.1));
    return {
        values: withEnergy ? new Float32Array(n).fill(0.2) : level,
        energy: withEnergy ? level : undefined,
        hopSec: HOP,
        frameTimeSec: (f) => f * HOP,
    };
}
const timing = { sections: [{ timeMs: 500, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 500 }; // a bar every 2000 ms from 500

test("a loud block at 60–75 s gives a point within one bar before 60 s, on a bar line", () => {
    const p = pickPreviewMs(envelope(120, [[60, 75]]), { timing, durationMs: 120000 });
    assert.ok(p <= 60000 && p > 58000, `point ${p}`);
    assert.equal((p - 500) % 2000, 0);
});

test("the point is never in the last 15 s", () => {
    const p = pickPreviewMs(envelope(120, [[108, 120]]), { timing, durationMs: 120000 });
    assert.ok(p <= 105000, `point ${p}`);
});

test("the first 10% is skipped", () => {
    const p = pickPreviewMs(envelope(120, [[0, 15]]), { timing, durationMs: 120000 });
    assert.ok(p >= 12000 - 2000, `point ${p}`);
});

test("a song under 30 s uses 40%", () => {
    assert.equal(pickPreviewMs(envelope(20, [[10, 12]]), { timing, durationMs: 20000 }), 8000);
});

test("the loudest drop part wins over the loudest window", () => {
    const env = envelope(120, [[30, 40], [60, 75]]);
    const parts = [
        { startMs: 0, endMs: 30000, kind: "intro" },
        { startMs: 30500, endMs: 40500, kind: "drop" },
        { startMs: 40500, endMs: 60500, kind: "break" }, // the second drop is louder all through
        { startMs: 60500, endMs: 74500, kind: "drop" },
        { startMs: 74500, endMs: 120000, kind: "outro" },
    ];
    assert.equal(pickPreviewMs(env, { timing, durationMs: 120000, parts }), 60500);
    // with only the first drop marked, its start is taken although a louder stretch exists
    assert.equal(pickPreviewMs(env, { timing, durationMs: 120000, parts: parts.map((p, i) => (i === 3 ? { ...p, kind: "part" } : p)) }), 30500);
});

test("a drop that starts in the last 15 s is not used", () => {
    const parts = [{ startMs: 0, endMs: 110000, kind: "part" }, { startMs: 110000, endMs: 120000, kind: "drop" }];
    const p = pickPreviewMs(envelope(120, [[60, 75]]), { timing, durationMs: 120000, parts });
    assert.ok(p <= 60000 && p > 58000, `point ${p}`);
});

test("without RMS loudness the onset envelope is used; old {bpm, offsetMs} timing snaps too", () => {
    const p = pickPreviewMs(envelope(120, [[60, 75]], { withEnergy: false }), { timing: { bpm: 120, offsetMs: 500 }, durationMs: 120000 });
    assert.ok(p <= 60000 && p > 58000, `point ${p}`);
    assert.equal((p - 500) % 2000, 0);
});

test("each section snaps on its own bars", () => {
    const two = { sections: [{ timeMs: 500, bpm: 120, meter: 4 }, { timeMs: 40000, bpm: 150, meter: 3 }] };
    const p = pickPreviewMs(envelope(120, [[61, 75]]), { timing: two, durationMs: 120000 });
    const bar = (60000 / 150) * 3;
    const k = (p - 40000) / bar;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `point ${p}`);
    assert.ok(p <= 61000 && p > 61000 - bar, `point ${p}`);
});

test("no timing: the window start itself, as a whole ms", () => {
    const p = pickPreviewMs(envelope(120, [[60, 75]]), { durationMs: 120000 });
    assert.ok(Number.isInteger(p));
    assert.ok(Math.abs(p - 60000) <= 250, `point ${p}`);
});
