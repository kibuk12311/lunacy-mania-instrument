// The wave strip under the timing: time ↔ x, zoom 0.5–20 s around the mouse, drag scrolling, min/max peaks per pixel,
// and the strip itself on the fake DOM (click sets the cursor, arrows nudge, the wheel zooms).
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire } from "../helpers/fakeDom.js";
import { timeToX, xToTime, zoomView, scrollView, peaks, lineDiv, createWaveStrip, SPAN_MIN_MS, SPAN_MAX_MS } from "../../app/renderer/waveStrip.js";

test("time ↔ x over the view", () => {
    const view = { startMs: 10000, spanMs: 4000 };
    assert.equal(timeToX(10000, view, 400), 0);
    assert.equal(timeToX(12000, view, 400), 200);
    assert.equal(timeToX(14000, view, 400), 400);
    assert.equal(xToTime(100, view, 400), 11000);
    for (const x of [0, 37.5, 123, 400]) assert.ok(Math.abs(timeToX(xToTime(x, view, 400), view, 400) - x) < 1e-9);
});

test("zoom: 0.5 s to 20 s, the time under the mouse stays under the mouse, the view stays inside the song", () => {
    const view = { startMs: 10000, spanMs: 4000 };
    const anchor = 11000;
    const inside = zoomView(view, 0.5, anchor, 60000);
    assert.equal(inside.spanMs, 2000);
    assert.ok(Math.abs(timeToX(anchor, inside, 400) - timeToX(anchor, view, 400)) < 1e-9);
    assert.equal(zoomView(view, 1e-3, anchor, 60000).spanMs, SPAN_MIN_MS);
    assert.equal(zoomView(view, 1e3, anchor, 60000).spanMs, SPAN_MAX_MS);
    assert.equal(SPAN_MIN_MS, 500);
    assert.equal(SPAN_MAX_MS, 20000);
    assert.equal(zoomView({ startMs: 0, spanMs: 4000 }, 2, 0, 60000).startMs, 0);
    // a song shorter than the widest view
    assert.deepEqual(zoomView({ startMs: 0, spanMs: 4000 }, 10, 2000, 9000), { startMs: 0, spanMs: 9000 });
});

test("drag scrolling moves the view by the dragged time, never before 0 or past the end", () => {
    const view = { startMs: 10000, spanMs: 4000 };
    assert.deepEqual(scrollView(view, 100, 400, 60000), { startMs: 9000, spanMs: 4000 }, "dragging right shows earlier audio");
    assert.deepEqual(scrollView(view, -200, 400, 60000), { startMs: 12000, spanMs: 4000 });
    assert.equal(scrollView(view, 1e6, 400, 60000).startMs, 0);
    assert.equal(scrollView(view, -1e6, 400, 60000).startMs, 56000);
});

test("peaks: the min and max of the samples under each pixel", () => {
    const sr = 1000;
    const samples = Float32Array.from({ length: 4000 }, (_, i) => (i >= 1000 && i < 1010 ? (i % 2 ? 0.8 : -0.6) : 0.01));
    const p = peaks(samples, sr, { startMs: 0, spanMs: 4000 }, 4);
    assert.equal(p.length, 8);
    assert.ok(Math.abs(p[2] - -0.6) < 1e-6 && Math.abs(p[3] - 0.8) < 1e-6, `pixel 1: ${p[2]}, ${p[3]}`);
    assert.ok(Math.abs(p[0] - 0.01) < 1e-6 && Math.abs(p[1] - 0.01) < 1e-6);
    // before the song and past its end: silence
    const out = peaks(samples, sr, { startMs: -2000, spanMs: 1000 }, 2);
    assert.deepEqual([...out], [0, 0, 0, 0]);
});

test("line density: 1/4 lines while they are 5 px apart, then 1/2, then beats", () => {
    assert.equal(lineDiv(500, { spanMs: 2000 }, 400), 4); // a beat is 100 px
    assert.equal(lineDiv(500, { spanMs: 20000 }, 400), 2); // 10 px
    assert.equal(lineDiv(300, { spanMs: 20000 }, 400), 1); // 6 px
});

test("the strip: a click sets the cursor, a drag does not; arrows nudge (Shift ×5); the wheel zooms", async () => {
    const { $ } = fakeDom({});
    const canvas = $("wave-strip");
    const cursor = [];
    const nudges = [];
    const strip = createWaveStrip({
        canvas, getTiming: () => ({ sections: [{ timeMs: 0, bpm: 120, meter: 4 }] }), getSelected: () => 0,
        getCursor: () => 3000, onCursor: (ms) => cursor.push(ms), onNudge: (d) => nudges.push(d),
    });
    strip.setSong({ samples: new Float32Array(44100 * 2), sampleRate: 22050, durationMs: 60000 });
    strip.showAround(0);
    const width = strip.width;
    assert.ok(width > 0);
    const before = { ...strip.view };

    await fire(canvas, "pointerdown", { offsetX: width / 2, button: 0, pointerId: 1 });
    await fire(canvas, "pointerup", { offsetX: width / 2, pointerId: 1 });
    assert.equal(cursor.length, 1);
    assert.ok(Math.abs(cursor[0] - xToTime(width / 2, before, width)) < 1e-6);

    await fire(canvas, "pointerdown", { offsetX: 10, button: 0, pointerId: 1 });
    await fire(canvas, "pointermove", { offsetX: 60, buttons: 1, pointerId: 1 });
    await fire(canvas, "pointerup", { offsetX: 60, pointerId: 1 });
    assert.equal(cursor.length, 1, "a drag is not a click");

    let prevented = 0;
    await fire(canvas, "keydown", { key: "ArrowRight", preventDefault: () => { prevented += 1; } });
    await fire(canvas, "keydown", { key: "ArrowLeft", shiftKey: true, preventDefault: () => { prevented += 1; } });
    await fire(canvas, "keydown", { key: "a" });
    assert.deepEqual(nudges, [1, -5]);
    assert.equal(prevented, 2);

    const span = strip.view.spanMs;
    await fire(canvas, "wheel", { deltaY: -100, offsetX: width / 2, preventDefault() {} });
    assert.ok(strip.view.spanMs < span, "wheel up zooms in");
    await fire(canvas, "wheel", { deltaY: 100, offsetX: width / 2, preventDefault() {} });
    await fire(canvas, "wheel", { deltaY: 100, offsetX: width / 2, preventDefault() {} });
    assert.ok(strip.view.spanMs > span, "wheel down zooms out");
});
