import { test } from "node:test";
import assert from "node:assert/strict";
import { ctxTimeAt, planStart, startChartFor, createClock, LEAD_IN_MS } from "../../../extension/player/clock.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("chart time follows ctx time × rate, offset in real ms", () => {
    const c = createClock({ startAt: 10, startChartMs: 5000, rate: 1 });
    close(c.chartAt(10), 5000);
    close(c.chartAt(11.5), 6500);
    const fast = createClock({ startAt: 10, startChartMs: 5000, rate: 1.5 });
    close(fast.chartAt(12), 8000);
    const off = createClock({ startAt: 10, startChartMs: 5000, rate: 1, offsetMs: 20 });
    close(off.chartAt(10), 5020);
    const offFast = createClock({ startAt: 10, startChartMs: 5000, rate: 1.5, offsetMs: 20 });
    close(offFast.chartAt(10), 5030); // 20 real ms = 30 chart ms at 1.5×
    offFast.offsetMs = -10;
    close(offFast.chartAt(10), 4985);
});

test("output timestamp maps an event instant to the ctx time being heard", () => {
    const ctx = { currentTime: 5.2, getOutputTimestamp: () => ({ contextTime: 5.1, performanceTime: 1000 }), outputLatency: 0.04 };
    close(ctxTimeAt(ctx, 1000), 5.1);
    close(ctxTimeAt(ctx, 1050), 5.15); // 50 ms later
    close(ctxTimeAt(ctx, 990), 5.09);
    const c = createClock({ startAt: 5, startChartMs: 0, rate: 1 });
    close(c.chartAtInstant(ctx, 1050, 1060), 150);
});

test("without a usable timestamp: currentTime − outputLatency, else baseLatency", () => {
    close(ctxTimeAt({ currentTime: 3, outputLatency: 0.05, baseLatency: 0.01 }, 100), 2.95);
    close(ctxTimeAt({ currentTime: 3, outputLatency: 0, baseLatency: 0.01 }, 100), 2.99);
    close(ctxTimeAt({ currentTime: 3 }, 100), 3);
    // an event 20 ms in the past is placed 20 ms back
    close(ctxTimeAt({ currentTime: 3, outputLatency: 0.05 }, 980, 1000), 2.93);
    // zero stamp (not running yet) and a stale stamp fall back too
    close(ctxTimeAt({ currentTime: 3, outputLatency: 0.05, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, 10), 2.95);
    close(ctxTimeAt({ currentTime: 3, outputLatency: 0.05, getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 10 }) }, 10), 2.95);
});

test("lead-in: 1.5 s of real time before the first note or the preview start", () => {
    assert.equal(LEAD_IN_MS, 1500);
    assert.equal(startChartFor({ firstNoteMs: 4000, rate: 1 }), 2500);
    assert.equal(startChartFor({ firstNoteMs: 4000, rate: 1.5 }), 1750);
    assert.equal(startChartFor({ firstNoteMs: 4000, previewStartMs: 13805, rate: 1 }), 12305);
    assert.equal(startChartFor({ firstNoteMs: 500, rate: 0.8 }), -700);
});

test("planStart: buffer offset when the start is inside the audio, a delay when before it", () => {
    const inside = planStart({ ctxNow: 2, startChartMs: 12305, audioZeroChartMs: 0, rate: 1, ahead: 0.1 });
    close(inside.startAt, 2.1);
    close(inside.when, 2.1);
    close(inside.bufferOffset, 12.305);
    // preview: audio 0 = PreviewTime 13805, start 1.5 s before → the audio waits 1.5 s
    const preview = planStart({ ctxNow: 2, startChartMs: 12305, audioZeroChartMs: 13805, rate: 1, ahead: 0.1 });
    close(preview.when, 3.6);
    close(preview.bufferOffset, 0);
    // at 1.5× the 1.5 s of chart before the audio pass in 1 s
    const fast = planStart({ ctxNow: 0, startChartMs: 13805 - 1500, audioZeroChartMs: 13805, rate: 1.5, ahead: 0 });
    close(fast.when, 1);
    // the clock and the plan agree: when the audio's 0 is heard, chart time = audioZeroChartMs
    for (const rate of [0.8, 1, 1.35]) {
        const p = planStart({ ctxNow: 1, startChartMs: -700, audioZeroChartMs: 0, rate });
        const c = createClock({ startAt: p.startAt, startChartMs: -700, rate });
        close(c.chartAt(p.when), 0, 1e-6);
    }
});
