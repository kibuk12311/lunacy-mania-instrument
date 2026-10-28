// The vibro detector (src/vibro/detect.js) on synthetic charts: long fast jacks of one key, a jumpjack or a hammered
// chord are vibro, normal jacks are not (too slow, too short, chords that move), the share of the map decides, the rate
// is the real speed; and the detector stays out of the analysis (the analyzer fingerprint never reaches it).
import test from "node:test";
import assert from "node:assert/strict";
import { detectVibro, detectVibroRows, vibroRows, vibroSummary, vibroCurrent, vibroRate, VIBRO } from "../src/vibro/detect.js";
import { importGraph, readFrom, APP_ROOT } from "../src/core/analyzerVersion.js";
import { chartOf, stream, jack, chordjack, after } from "./fixtures/makeVibroChart.js";

const filler = (n = 200) => stream(1000, n, 120); // 1/4 at 125 BPM, no jack in it
const withPiece = (piece, n = 200) => {
    const head = filler(n);
    return [...head, ...piece(after(head))];
};

test("a long one-key jack at 90 ms is vibro; the same at 110 ms is a jack like any other", () => {
    const fast = detectVibro(chartOf(withPiece((t) => jack(t, 100, 90))), 1);
    assert.equal(fast.judged, true);
    assert.equal(fast.vibro, true);
    assert.equal(fast.notes, 300);
    assert.equal(fast.vibroNotes, 100);
    assert.equal(fast.share, 0.333);
    assert.equal(fast.longestRows, 100);
    assert.equal(fast.peakGapMs, 90);
    assert.equal(fast.runs.length, 1);
    assert.deepEqual(fast.runs[0].cols, [0]);
    assert.equal(fast.runs[0].repeat, 1);
    assert.equal(fast.runs[0].endMs - fast.runs[0].startMs, 99 * 90);
    assert.equal(fast.confidence, "high");
    const slow = detectVibro(chartOf(withPiece((t) => jack(t, 100, 110))), 1);
    assert.equal(slow.vibro, false);
    assert.equal(slow.share, 0);
    assert.equal(slow.runs.length, 0);
    assert.equal(slow.confidence, "high");
});

test("normal jacks are not vibro: 1/4 at 150 BPM in bursts of 16, short fast bursts, chordjack's moving chords", () => {
    // 1/4 jack bursts at 150 BPM (100 ms) between streams: slower than the link
    const bursts = [];
    let t = 1000;
    for (let i = 0; i < 12; i += 1) {
        const s = stream(t, 16, 100);
        const j = jack(after(s, 100), 16, 100, [i % 4]);
        bursts.push(...s, ...j);
        t = after(j, 100);
    }
    const a = detectVibro(chartOf(bursts), 1);
    assert.equal(a.vibro, false);
    assert.equal(a.share, 0);
    // minijacks and 7-row bursts at 70 ms: shorter than a run
    const short = [];
    t = 1000;
    for (let i = 0; i < 30; i += 1) {
        const s = stream(t, 8, 120);
        const j = jack(after(s, 120), i % 2 ? 7 : 4, 70, [i % 4]);
        short.push(...s, ...j);
        t = after(j, 120);
    }
    const b = detectVibro(chartOf(short), 1);
    assert.equal(b.vibro, false);
    assert.equal(b.runs.length, 0);
    // [12][23][34][41] at 80 ms for 300 rows: every row shares a column, but only half its notes repeat
    const c = detectVibro(chartOf(chordjack(1000, 300, 80)), 1);
    assert.equal(c.vibro, false);
    assert.equal(c.share, 0);
});

test("jumpjacks, quad jacks and a hammered chord are vibro: the notes repeat, not just one column", () => {
    const jump = detectVibro(chartOf(withPiece((t) => jack(t, 100, 85, [0, 1]))), 1);
    assert.equal(jump.vibro, true);
    assert.deepEqual(jump.runs[0].cols, [0, 1]);
    assert.equal(jump.share, 0.5); // 200 of 400 notes
    const quad = detectVibro(chartOf(withPiece((t) => jack(t, 60, 90, [0, 1, 2, 3]))), 1);
    assert.equal(quad.vibro, true);
    assert.equal(quad.share, 0.545);
    assert.equal(quad.confidence, "high");
    // the chord held for 5 rows, then moved by one column ([123]×5, [234]×5, …): 14 of every 15 notes repeat
    const blocks = Array.from({ length: 120 }, (_, i) => [1000 + i * 80, Math.floor(i / 5) % 2 ? [1, 2, 3] : [0, 1, 2]]);
    const held = detectVibro(chartOf(blocks), 1);
    assert.equal(held.vibro, true);
    assert.equal(held.runs.length, 1);
    assert.ok(held.runs[0].repeat >= VIBRO.MIN_REPEAT, `repeat ${held.runs[0].repeat}`);
});

test("the rate is the real speed: a 100 ms jack is vibro at 1.1x, a 90 ms one is not at 0.9x; times are real ms", () => {
    const text100 = chartOf(withPiece((t) => jack(t, 100, 100)));
    assert.equal(detectVibro(text100, 1).vibro, false);
    const sped = detectVibro(text100, 1.1);
    assert.equal(sped.vibro, true);
    assert.equal(sped.peakGapMs, 90.9);
    const text90 = chartOf(withPiece((t) => jack(t, 100, 90)));
    assert.equal(detectVibro(text90, 0.9).vibro, false);
    // the run starts after 200 rows at 120 ms and a 500 ms pause: 24 380 chart ms in, 1.2x faster in real time
    const atRate = detectVibro(text90, 1.2);
    assert.equal(atRate.runs[0].startMs, Math.round((199 * 120 + 500) / 1.2));
    assert.equal(vibroRate(atRate), 13); // 1000 / 75 ms
});

test("the share decides: a 30-note dump in a 330-note map is listed but not vibro, 40 in 340 is", () => {
    const some = detectVibro(chartOf(withPiece((t) => jack(t, 30, 80), 300)), 1);
    assert.equal(some.vibro, false);
    assert.equal(some.runs.length, 1);
    assert.equal(some.longestRows, 30);
    assert.equal(some.share, 0.091);
    assert.equal(some.confidence, "low");
    const more = detectVibro(chartOf(withPiece((t) => jack(t, 40, 80), 300)), 1);
    assert.equal(more.vibro, true);
    assert.equal(more.share, 0.118);
    assert.equal(more.confidence, "low", "just over the line");
});

test("only 4K mania charts are judged; a short one is not; rows are read as the analysis reads them", () => {
    const rows = withPiece((t) => jack(t, 100, 90));
    assert.equal(detectVibro(chartOf(rows, { mode: 0 }), 1), null);
    assert.equal(detectVibro(chartOf(rows, { keys: 7 }), 1), null);
    assert.equal(detectVibro("not a map", 1), null);
    assert.equal(detectVibro(null, 1), null);
    const short = detectVibro(chartOf(jack(1000, 120, 60)), 1);
    assert.equal(short.judged, false);
    assert.equal(short.vibro, false);
    // notes within 2 ms are one row; the section after [HitObjects] ends at the next header
    const text = chartOf([[1000, [0]], [1001, [2]], [1100, [1]]]) + "[Colours]\r\nCombo1 : 255,0,0\r\n";
    assert.deepEqual(vibroRows(text), [{ t: 1000, mask: 0b101 }, { t: 1100, mask: 0b10 }]);
    assert.deepEqual(detectVibroRows([], 1).judged, false);
});

test("the summary kept beside a map: rounded, checked, and of this version", () => {
    const v = detectVibro(chartOf(withPiece((t) => jack(t, 100, 90))), 1);
    const s = vibroSummary(v);
    assert.deepEqual(s, { v: VIBRO.VERSION, vibro: true, share: 0.333, longestRows: 100, peakGapMs: 90, confidence: "high" });
    assert.deepEqual(vibroSummary(JSON.parse(JSON.stringify(s))), s, "it survives maps.json");
    assert.equal(vibroCurrent(s), true);
    assert.equal(vibroCurrent({ ...s, v: VIBRO.VERSION + 1 }), false);
    assert.equal(vibroCurrent(null), false);
    for (const junk of [null, 1, {}, { v: 1, vibro: "yes", share: 0.5 }, { v: 1, vibro: true, share: 2 }, { v: 1.5, vibro: true, share: 0.5 }]) {
        assert.equal(vibroSummary(junk), null, JSON.stringify(junk));
    }
    assert.equal(vibroSummary({ v: 1, vibro: false, share: 0, confidence: "maybe" }).confidence, "low");
});

test("the detector is not part of the analysis: the analyzer fingerprint's modules never reach src/vibro", async () => {
    const { texts } = await importGraph(readFrom(APP_ROOT));
    assert.ok(texts.has("src/core/analyze.js"));
    assert.deepEqual([...texts.keys()].filter((k) => k.startsWith("src/vibro/")), []);
});
