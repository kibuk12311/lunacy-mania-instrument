// Wave strip of the create tab's timing group (mapgen v3): 96 px of the song's waveform (min/max per pixel) with the
// beat lines in the snap palette, the red lines (sections) and the cursor. The wheel zooms 0.5–20 s around the mouse,
// dragging scrolls, a click sets the cursor; while it has focus ←/→ nudge the chosen red line 1 ms (Shift: 5 ms).
import { t } from "../../src/i18n/i18n.js";
import { SNAP_COLORS, sectionsOf, gridLines, beatMsAt, prepareCanvas } from "./snapColors.js";

export const SPAN_MIN_MS = 500;
export const SPAN_MAX_MS = 20000;
const HEIGHT = 96;
const WIDTH = 432; // until the canvas has a CSS width
const MIN_LINE_PX = 5;
const CLICK_PX = 3;
const ZOOM_STEP = 1.25;

export const timeToX = (ms, view, width) => ((ms - view.startMs) / view.spanMs) * width;
export const xToTime = (x, view, width) => view.startMs + (x / width) * view.spanMs;

const clampView = ({ startMs, spanMs }, durationMs) => {
    const span = Math.min(SPAN_MAX_MS, Math.max(SPAN_MIN_MS, spanMs), Math.max(SPAN_MIN_MS, durationMs));
    return { startMs: Math.max(0, Math.min(startMs, durationMs - span)), spanMs: span };
};

// Zooms by factor (< 1 in) keeping anchorMs at the same x.
export function zoomView(view, factor, anchorMs, durationMs) {
    const spanMs = Math.min(SPAN_MAX_MS, Math.max(SPAN_MIN_MS, view.spanMs * factor), Math.max(SPAN_MIN_MS, durationMs));
    const at = (anchorMs - view.startMs) / view.spanMs;
    return clampView({ startMs: anchorMs - at * spanMs, spanMs }, durationMs);
}

// Dragging by dxPx to the right shows earlier audio.
export const scrollView = (view, dxPx, width, durationMs) => clampView({ startMs: view.startMs - (dxPx / width) * view.spanMs, spanMs: view.spanMs }, durationMs);

// [min0, max0, min1, max1, …] of the samples under each of `width` pixels; silence outside the song.
export function peaks(samples, sampleRate, view, width) {
    const out = new Float32Array(width * 2);
    const perPx = (view.spanMs / 1000 / width) * sampleRate;
    const first = (view.startMs / 1000) * sampleRate;
    for (let x = 0; x < width; x += 1) {
        const start = Math.floor(first + x * perPx);
        const end = Math.max(start + 1, Math.floor(first + (x + 1) * perPx));
        const from = Math.max(0, start);
        const to = Math.min(samples.length, end);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = from; i < to; i += 1) {
            const v = samples[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (hi >= lo) {
            out[2 * x] = lo;
            out[2 * x + 1] = hi;
        }
    }
    return out;
}

// The finest of 1/4, 1/2 and 1/1 whose lines stay MIN_LINE_PX apart.
export function lineDiv(beatMs, view, width) {
    const beatPx = (beatMs / view.spanMs) * width;
    if (beatPx / 4 >= MIN_LINE_PX) return 4;
    if (beatPx / 2 >= MIN_LINE_PX) return 2;
    return 1;
}

// getTiming() → Timing, getSelected() → the chosen red line, getCursor() → ms; onCursor(ms) on a click, onNudge(±ms) on a key.
export function createWaveStrip({ canvas, getTiming, getSelected, getCursor, onCursor, onNudge }) {
    let song = null;
    let view = { startMs: 0, spanMs: 6000 };
    let width = WIDTH;
    let drag = null;
    canvas.title = t("create.timing.nudgeHint");

    function draw() {
        const { ctx, width: w } = prepareCanvas(canvas, WIDTH, HEIGHT);
        width = w;
        if (!ctx) return;
        ctx.fillStyle = "#1c1928";
        ctx.fillRect(0, 0, w, HEIGHT);
        if (!song) return;
        const mid = HEIGHT / 2;
        const p = peaks(song.samples, song.sampleRate, view, w);
        ctx.fillStyle = "#8a86a8";
        for (let x = 0; x < w; x += 1) {
            const lo = Math.max(-1, p[2 * x]);
            const hi = Math.min(1, p[2 * x + 1]);
            ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
        }
        const timing = getTiming();
        const div = lineDiv(beatMsAt(timing, view.startMs + view.spanMs / 2), view, w);
        for (const line of gridLines(timing, view.startMs, view.startMs + view.spanMs, div)) {
            const x = Math.round(timeToX(line.t, view, w));
            const tall = line.div === 1 ? HEIGHT : line.div === 2 ? HEIGHT * 0.5 : HEIGHT * 0.3;
            ctx.globalAlpha = line.div === 1 ? 0.7 : 0.45;
            ctx.fillStyle = SNAP_COLORS[line.div] ?? SNAP_COLORS[0];
            ctx.fillRect(x, HEIGHT - tall, line.bar ? 2 : 1, tall);
        }
        ctx.globalAlpha = 1;
        const selected = getSelected();
        ctx.font = "10px Segoe UI, sans-serif";
        sectionsOf(timing).forEach((s, i) => {
            const x = timeToX(s.timeMs, view, w);
            if (x < -40 || x > w) return;
            ctx.fillStyle = i === selected ? "#f5c66b" : "#b08a45";
            ctx.fillRect(Math.round(x) - 1, 0, 3, HEIGHT);
            ctx.fillText(`${Math.round(s.bpm * 100) / 100}`, Math.round(x) + 4, 11);
        });
        const cx = Math.round(timeToX(getCursor(), view, w));
        ctx.fillStyle = "#eeeeee";
        ctx.fillRect(cx, 0, 1, HEIGHT);
    }

    const xOf = (e) => (Number.isFinite(e.offsetX) ? e.offsetX : 0);
    canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !song) return;
        drag = { x: xOf(e), last: xOf(e), moved: false };
        canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!drag || !(e.buttons & 1)) return;
        const x = xOf(e);
        if (Math.abs(x - drag.x) > CLICK_PX) drag.moved = true;
        if (!drag.moved) return;
        view = scrollView(view, x - drag.last, width, song.durationMs);
        drag.last = x;
        draw();
    });
    canvas.addEventListener("pointerup", (e) => {
        if (!drag) return;
        const wasClick = !drag.moved;
        drag = null;
        if (wasClick) onCursor?.(xToTime(xOf(e), view, width));
    });
    canvas.addEventListener("wheel", (e) => {
        if (!song) return;
        e.preventDefault?.();
        view = zoomView(view, e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP, xToTime(xOf(e), view, width), song.durationMs);
        draw();
    }, { passive: false });
    canvas.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault?.();
        onNudge?.((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1));
    });

    return {
        // { samples, sampleRate, durationMs }: the mono samples the song was analysed from
        setSong(next) {
            song = next;
            canvas.hidden = !next;
            view = clampView(view, next?.durationMs ?? 0);
            draw();
        },
        // puts ms a fifth into the view
        showAround(ms) {
            if (song) view = clampView({ startMs: ms - view.spanMs / 5, spanMs: view.spanMs }, song.durationMs);
            draw();
        },
        // while playing: redraw, and follow the cursor when it runs out of the view
        frame(nowMs) {
            if (song && (nowMs < view.startMs || nowMs > view.startMs + view.spanMs)) {
                view = clampView({ startMs: nowMs - view.spanMs / 10, spanMs: view.spanMs }, song.durationMs);
            }
            draw();
        },
        redraw: draw,
        get view() { return view; },
        get width() { return width; },
    };
}
