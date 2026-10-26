import test from "node:test";
import assert from "node:assert/strict";
import { toOsu, beatDivisorFor } from "../../src/gen/writer.js";
import { parseRedTimingPoints, sectionsToPoints } from "../../src/gen/grid.js";
import { rateOsu } from "../../src/rate/rateMap.js";
import { chartInfo } from "../../src/core/features.js";

const section = (text, name) => {
    const lines = text.split("\r\n");
    const start = lines.indexOf(`[${name}]`);
    const out = [];
    for (let i = start + 1; i < lines.length && lines[i] && !lines[i].startsWith("["); i += 1) out.push(lines[i]);
    return out;
};
const meta = { title: "t", version: "v", audioFilename: "audio.mp3" };
// rows across the whole song, so the 150 BPM section (10 s) outweighs the others (2 s and 4 s)
const rows = [{ t: 0, cols: [0] }, ...Array.from({ length: 160 }, (_, i) => ({ t: 1000 + i * 100, cols: [i % 4] }))];
const sections = [{ timeMs: 1000, bpm: 150, meter: 4 }, { timeMs: 11000, bpm: 200, meter: 4 }, { timeMs: 13000.4, bpm: 75, meter: 3 }];

test("one red line per section and green lines that cancel the scroll change", () => {
    const text = toOsu({ rows, timingPoints: sectionsToPoints(sections), ...meta });
    assert.deepEqual(section(text, "TimingPoints"), [
        "1000,400,4,2,0,60,1,0",
        "11000,300,4,2,0,60,1,0",
        "11000,-133.33333333333334,4,2,0,60,0,0",
        "13000,800,3,2,0,60,1,0",
        "13000,-50,3,2,0,60,0,0",
    ]);
    // the generator's scroll-speed rule is osu!'s: the dominant BPM by time is the 150 one
    assert.equal(chartInfo(text, 1).bpm, 150);
});

test("without normalizeSv there are only red lines", () => {
    const text = toOsu({ rows, timingPoints: sectionsToPoints(sections), normalizeSv: false, ...meta });
    assert.equal(section(text, "TimingPoints").length, 3);
});

test("red lines round-trip through parseRedTimingPoints", () => {
    const text = toOsu({ rows, timingPoints: sectionsToPoints(sections), ...meta });
    assert.deepEqual(parseRedTimingPoints(text), [
        { time: 1000, beatLength: 400 }, { time: 11000, beatLength: 300 }, { time: 13000, beatLength: 800 },
    ]);
});

test("a rate edit scales the red lines and keeps the green ones", () => {
    const text = toOsu({ rows, timingPoints: sectionsToPoints(sections), ...meta });
    const rated = rateOsu(text, { rate: 1.25, audioFilename: "audio 1.25x.mp3" });
    assert.deepEqual(section(rated, "TimingPoints"), [
        "800,320,4,2,0,60,1,0",
        "8800,240,4,2,0,60,1,0",
        "8800,-133.33333333333334,4,2,0,60,0,0",
        "10400,640,3,2,0,60,1,0",
        "10400,-50,3,2,0,60,0,0",
    ]);
});

test("the old single-BPM call writes exactly what it used to", () => {
    const text = toOsu({ rows: [{ t: 1000, cols: [0, 3] }], bpm: 174, offsetMs: 312.4, ...meta });
    assert.deepEqual(section(text, "TimingPoints"), [`312,${60000 / 174},4,2,0,60,1,0`]);
    assert.deepEqual(section(text, "Events"), ["//Background and Video events", "//Break Periods"]);
    assert.ok(text.includes("BeatDivisor: 4\r\n"));
    assert.ok(text.includes("64,192,1000,1,0,0:0:0:0:\r\n448,192,1000,1,0,0:0:0:0:"));
});

test("break periods are written under //Break Periods for note-free gaps of 3 s or more, 200 ms clear of the notes", () => {
    const sparse = [{ t: 1000, cols: [0] }, { t: 2000, cols: [1] }, { t: 9000, cols: [2] }, { t: 10000, cols: [3] }, { t: 11500, cols: [0] }];
    const text = toOsu({ rows: sparse, bpm: 120, offsetMs: 0, breaks: [[2000, 9000], [10000, 11500], [500, 1500]], ...meta });
    assert.deepEqual(section(text, "Events"), ["//Background and Video events", "//Break Periods", "2,2200,8800"]);
    // a break that would cover notes shrinks to the longest free gap in it; none before the first note or after the last
    const covered = toOsu({ rows: sparse, bpm: 120, offsetMs: 0, breaks: [{ startMs: 0, endMs: 9500 }, [11000, 20000]], ...meta });
    assert.deepEqual(section(covered, "Events").slice(2), ["2,2200,8800"]);
    const inside = toOsu({ rows: sparse, bpm: 120, offsetMs: 0, breaks: [[3000, 7000]], ...meta });
    assert.deepEqual(section(inside, "Events").slice(2), ["2,3000,7000"]);
});

test("beat divisor in the editor follows the grids that are used", () => {
    assert.equal(beatDivisorFor([4]), 4);
    assert.equal(beatDivisorFor([4, 8]), 8);
    assert.equal(beatDivisorFor(new Set([4, 3])), 12);
    assert.equal(beatDivisorFor([4, 6, 8]), 12);
    const text = toOsu({ rows, bpm: 120, offsetMs: 0, beatDivisor: 12, ...meta });
    assert.ok(text.includes("BeatDivisor: 12\r\n"));
});

test("extra fields on rows are ignored and a row may give a mask instead of columns", () => {
    const a = toOsu({ rows: [{ t: 500, cols: [1, 2], div: 3, family: "Tech" }], bpm: 120, offsetMs: 0, ...meta });
    const b = toOsu({ rows: [{ t: 500, mask: 0b0110 }], bpm: 120, offsetMs: 0, ...meta });
    assert.equal(a, b);
});
