import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, noteY, visibleSpanMs, laneColor, createRenderer, COLORS, hexAlpha } from "../../../extension/player/render.js";
import { visibleSpanMs as appSpan } from "../../../app/renderer/playfield.js";
import { createJudge } from "../../../extension/player/judge.js";

test("visible span is the app's: 11485 / speed ms of real time", () => {
    for (const speed of [10, 24, 40]) assert.equal(visibleSpanMs(speed), appSpan(speed));
    assert.equal(visibleSpanMs(24), 11485 / 24);
});

test("lanes: outer gold, inner blue", () => {
    assert.deepEqual([0, 1, 2, 3].map((c) => laneColor(c)), [COLORS.gold, COLORS.blue, COLORS.blue, COLORS.gold]);
    assert.equal(hexAlpha("#f5c66b", 0.5), "rgba(245,198,107,0.5)");
});

test("downscroll notes fall to a judge line near the bottom, upscroll rise to one below the top bar", () => {
    const down = layout(800, 600, { downscroll: true });
    const up = layout(800, 600, { downscroll: false });
    assert.ok(down.hitY > 500);
    assert.ok(up.hitY > up.topBar && up.hitY < 150);
    assert.equal(down.fieldW, down.laneW * 4);
    assert.equal(down.left, Math.round((800 - down.fieldW) / 2));
    const span = 500;
    assert.equal(noteY(1000, 1000, down, span), down.hitY);
    assert.equal(noteY(1500, 1000, down, span), 0); // one span ahead: the top edge
    assert.equal(noteY(1000, 1000, up, span), up.hitY);
    assert.equal(noteY(1500, 1000, up, span), 600); // the bottom edge
    assert.ok(noteY(900, 1000, down, span) > down.hitY); // passed notes go on past the line
});

test("a frame draws every kind of note in both directions without throwing", () => {
    let calls = 0;
    const g = new Proxy({}, {
        get: (o, k) => (k in o ? o[k] : k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => { calls += 1; }),
        set: (o, k, v) => { o[k] = v; return true; },
    });
    const canvas = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: () => g };
    const r = createRenderer(canvas, { win: { devicePixelRatio: 2 } });
    const judge = createJudge({ notes: [{ col: 0, t: 1000, end: null }, { col: 1, t: 1000, end: 1800 }, { col: 2, t: 1100, end: 1500 }, { col: 3, t: 1200, end: null }], od: 8 });
    judge.press(1, 1000); // held LN
    judge.press(2, 1100);
    judge.release(2, 1200); // released early: grey body
    for (const downscroll of [true, false]) {
        r.reset();
        r.draw({ now: 1250, rate: 1, speed: 24, downscroll, keys: 4, judge, held: [false, true, false, false], labels: ["D", "F", "J", "K"], combo: 1, acc: 66.67, progress: 0.3, flash: { judgement: "n300", at: 0 }, toast: { text: "x", at: 0 }, banner: "Get ready", sideLines: ["1.0×"], perfNow: 100 });
    }
    assert.equal(canvas.width, 1600); // devicePixelRatio
    assert.equal(canvas.height, 1200);
    assert.ok(calls > 30);
});

test("a long hold in view does not make every frame walk the notes already gone", () => {
    let calls = 0;
    const g = new Proxy({}, {
        get: (o, k) => (k in o ? o[k] : k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => { calls += 1; }),
        set: (o, k, v) => { o[k] = v; return true; },
    });
    const canvas = { clientWidth: 1280, clientHeight: 720, width: 0, height: 0, getContext: () => g };
    const notes = [{ col: 0, t: 0, end: 120000 }];
    for (let t = 100; t < 120000; t += 125) notes.push({ col: 1 + (Math.floor(t / 125) % 3), t, end: null });
    const judge = createJudge({ notes, od: 8 });
    judge.press(0, 0);
    const r = createRenderer(canvas, { win: { devicePixelRatio: 1 } });
    let max = 0;
    for (let now = 0; now < 120000; now += 50) {
        judge.update(now);
        calls = 0;
        r.draw({ now, rate: 1, speed: 24, downscroll: true, keys: 4, judge, held: [true, false, false, false], labels: ["D", "F", "J", "K"], combo: 1, acc: 50, progress: now / 120000, perfNow: now, sideLines: [] });
        max = Math.max(max, calls);
    }
    assert.ok(max < 200, `ctx calls per frame: ${max}`);
});
