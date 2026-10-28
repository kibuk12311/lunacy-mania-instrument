import { test } from "node:test";
import assert from "node:assert/strict";
import { hitWindows, judgementFor, createJudge, maniaAccuracy, unstableRate, TAIL_FACTOR } from "../../../extension/player/judge.js";
import * as format from "../../../src/overlay/format.js";

test("osu!stable windows per OD", () => {
    assert.deepEqual({ ...hitWindows(0) }, { max: 16, n300: 64, n200: 97, n100: 127, n50: 151, miss: 188 });
    assert.deepEqual({ ...hitWindows(8) }, { max: 16, n300: 40, n200: 73, n100: 103, n50: 127, miss: 164 });
    assert.deepEqual({ ...hitWindows(10) }, { max: 16, n300: 34, n200: 67, n100: 97, n50: 121, miss: 158 });
    const w = hitWindows(7.5);
    assert.equal(w.n300, 64 - 22.5);
    assert.deepEqual({ ...hitWindows(15) }, { ...hitWindows(10) }); // clamped
    assert.deepEqual({ ...hitWindows(-3) }, { ...hitWindows(0) });
});

test("judgement by absolute error, boundaries included", () => {
    const w = hitWindows(8);
    assert.equal(judgementFor(0, w), "max");
    assert.equal(judgementFor(16, w), "max");
    assert.equal(judgementFor(-16.5, w), "n300");
    assert.equal(judgementFor(40, w), "n300");
    assert.equal(judgementFor(41, w), "n200");
    assert.equal(judgementFor(-73, w), "n200");
    assert.equal(judgementFor(103, w), "n100");
    assert.equal(judgementFor(127, w), "n50");
    assert.equal(judgementFor(128, w), null);
});

test("press: early outside the miss window is ignored, inside it but outside 50 is a miss", () => {
    const j = createJudge({ notes: [{ col: 0, t: 1000, end: null }, { col: 0, t: 1500, end: null }], od: 8 });
    assert.deepEqual(j.press(0, 1000 - 165), []); // 165 > miss 164: ignored
    const ev = j.press(0, 1000 - 140); // within 164, outside 127
    assert.equal(ev.length, 1);
    assert.equal(ev[0].judgement, "miss");
    assert.equal(j.head[0], "miss");
    const ok = j.press(0, 1500 + 10);
    assert.equal(ok[0].judgement, "max");
    assert.equal(ok[0].error, 10);
    assert.ok(j.done);
});

test("notes passing +50 unhit become misses; wrong column does nothing", () => {
    const j = createJudge({ notes: [{ col: 1, t: 1000, end: null }], od: 8 });
    assert.deepEqual(j.press(2, 1000), []);
    assert.deepEqual(j.update(1127), []);
    const ev = j.update(1128);
    assert.equal(ev[0].judgement, "miss");
    assert.equal(j.stats().miss, 1);
});

test("hit errors are real ms: Δchart / rate", () => {
    const j = createJudge({ notes: [{ col: 0, t: 1000, end: null }, { col: 1, t: 1000, end: null }], od: 8, rate: 1.5 });
    const a = j.press(0, 1000 + 30); // 30 chart ms at 1.5× = 20 real ms → 300
    assert.equal(a[0].judgement, "n300");
    assert.equal(a[0].error, 20);
    const b = j.press(1, 1000 - 24); // −16 real → MAX
    assert.equal(b[0].judgement, "max");
    // at 1.5× a head is missed only after 127 real ms = 190.5 chart ms
    const k = createJudge({ notes: [{ col: 0, t: 0, end: null }], od: 8, rate: 1.5 });
    assert.deepEqual(k.update(190), []);
    assert.equal(k.update(191)[0].judgement, "miss");
});

test("LN: head as a note, tail windows ×1.5 on release", () => {
    const j = createJudge({ notes: [{ col: 0, t: 1000, end: 2000 }], od: 8 });
    const tw = j.tailWindows;
    assert.equal(tw.n300, 40 * TAIL_FACTOR);
    assert.equal(tw.max, 24);
    assert.equal(j.total, 2);
    assert.equal(j.press(0, 1005)[0].judgement, "max");
    assert.equal(j.holding[0], 0);
    const rel = j.release(0, 2000 + 55); // 55 > 40 (300) but ≤ 60 (300 ×1.5)
    assert.equal(rel[0].kind, "tail");
    assert.equal(rel[0].judgement, "n300");
    assert.equal(j.holding[0], -1);
    assert.deepEqual(j.stats(), { max: 1, n300: 1, n200: 0, n100: 0, n50: 0, miss: 0, combo: 2, maxCombo: 2, acc: 100, notes: 2 });
});

test("LN: early release → tail miss and a greyed body; combo breaks", () => {
    const j = createJudge({ notes: [{ col: 0, t: 1000, end: 2000 }, { col: 1, t: 900, end: null }], od: 8 });
    j.press(1, 900);
    j.press(0, 1000);
    assert.equal(j.combo, 2);
    const ev = j.release(0, 2000 - 191); // earlier than the tail's 50 window (127 × 1.5 = 190.5)
    assert.equal(ev[0].judgement, "miss");
    assert.equal(j.broken[0], true);
    assert.equal(j.combo, 0);
    assert.equal(j.stats().maxCombo, 2);
});

test("LN: held past the tail's 50 window → tail 50", () => {
    const j = createJudge({ notes: [{ col: 3, t: 1000, end: 1500 }], od: 8 });
    j.press(3, 1000);
    assert.deepEqual(j.update(1500 + 190), []);
    const ev = j.update(1500 + 191);
    assert.equal(ev[0].kind, "tail");
    assert.equal(ev[0].judgement, "n50");
    assert.equal(j.holding[3], -1);
    assert.deepEqual(j.release(3, 1800), []); // nothing left to release
});

test("LN: a missed head also misses the tail", () => {
    const j = createJudge({ notes: [{ col: 2, t: 1000, end: 3000 }], od: 5 });
    const ev = j.update(1000 + 137); // 50 window at OD 5 = 136
    assert.deepEqual(ev.map((e) => [e.kind, e.judgement]), [["head", "miss"], ["tail", "miss"]]);
    assert.equal(j.broken[0], true);
    assert.ok(j.done);
    assert.deepEqual(j.press(2, 2900), []); // a late press on the body does nothing
});

test("finish misses what is left and releases held LNs", () => {
    const j = createJudge({ notes: [{ col: 0, t: 1000, end: 1200 }, { col: 1, t: 5000, end: null }], od: 8 });
    j.press(0, 1000);
    const ev = j.finish(1210);
    assert.deepEqual(ev.map((e) => [e.kind, e.judgement]), [["tail", "max"], ["head", "miss"]]);
    assert.ok(j.done);
});

test("accuracy is the overlay's maniaAccuracy, also on random counts", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    assert.equal(maniaAccuracy({}), format.maniaAccuracy({}));
    for (let i = 0; i < 300; i += 1) {
        const counts = { max: Math.floor(rand() * 900), n300: Math.floor(rand() * 300), n200: Math.floor(rand() * 60), n100: Math.floor(rand() * 30), n50: Math.floor(rand() * 10), miss: Math.floor(rand() * 20) };
        assert.equal(maniaAccuracy(counts), format.maniaAccuracy(counts));
    }
    assert.equal(maniaAccuracy({ max: 1, n300: 1, n200: 1, n100: 1, n50: 1, miss: 1 }), (100 * (600 + 200 + 100 + 50)) / 1800);
    // the source of the copy is the same text
    assert.equal(maniaAccuracy.toString(), format.maniaAccuracy.toString());
    assert.equal(unstableRate.toString().replace(/\s+/g, " "), format.unstableRate.toString().replace(/\s+/g, " "));
});

test("UR = 10 × standard deviation of head errors, like the overlay", () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({ col: i % 4, t: 1000 + i * 400, end: null }));
    const j = createJudge({ notes, od: 8 });
    const errs = [-10, 5, 12, -3, 0, 8];
    notes.forEach((n, i) => j.press(n.col, n.t + errs[i]));
    assert.deepEqual(j.errors(), errs);
    assert.equal(j.ur(), format.unstableRate(errs));
    assert.ok(Math.abs(j.meanError() - 2) < 1e-9);
    assert.equal(unstableRate([1]), null);
    const stats = j.stats();
    assert.equal(stats.max + stats.n300, 6);
    assert.equal(stats.combo, 6);
});

test("columns are judged in order: a press takes the earliest note of its column", () => {
    const j = createJudge({ notes: [{ col: 0, t: 1000, end: null }, { col: 0, t: 1100, end: null }], od: 8 });
    const ev = j.press(0, 1060); // closer to the second, but the first is still open (+60 ≤ 127)
    assert.equal(ev[0].index, 0);
    assert.equal(ev[0].judgement, "n200");
    assert.equal(j.press(0, 1100)[0].index, 1);
});
