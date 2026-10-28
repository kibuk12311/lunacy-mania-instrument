// Wave strip of the create tab's timing group (mapgen v3): 96 px of the song with the beat lines in the snap palette,
// the red lines (sections) and the cursor. The wheel zooms 0.5–20 s around the mouse, dragging scrolls, a click sets
// the cursor; while it has focus ←/→ nudge the chosen red line 1 ms (Shift: 5 ms).
// The song is drawn in two layers so loud, limited, bass-heavy masters are not a solid wall: the onset envelope as
// teal bars from the bottom (where sounds start), and over it the min/max per pixel of a 300 Hz high-passed copy of
// the samples (the bass that put a full swing into every pixel of the raw waveform is gone; kicks and snares keep their
// edges). Both use song-wide scales worked out once in setSong (the 99.9th percentile of 256-sample block peaks, the
// envelope's 20th to 99.5th percentile), so heights do not jump while scrolling and quiet songs fill the strip too.
import { t } from "../../src/i18n/i18n.js";
import { SNAP_COLORS, sectionsOf, gridLines, beatMsAt, prepareCanvas } from "./snapColors.js";

export const SPAN_MIN_MS = 500;
export const SPAN_MAX_MS = 20000;
const HEIGHT = 96;
const WIDTH = 432; // until the canvas has a CSS width
const MIN_LINE_PX = 5;
const CLICK_PX = 3;
const ZOOM_STEP = 1.25;
const BACKGROUND = "#1c1928";
const WAVE_COLOR = "#8a86a8";
export const ENVELOPE_COLOR = "#4fc4a4";
const ENVELOPE_ALPHA = 0.9;
const WAVE_ALPHA = 0.62; // the bars show through the waveform
const HIGH_PASS_HZ = 300;
const BLOCK = 256;
const SCALE_PERCENTILE = 0.999;
const SCALE_FLOOR = 1e-3; // about −60 dBFS: digital silence is not blown up into noise
const ENVELOPE_FLOOR = 0.2;
const ENVELOPE_TOP = 0.995;

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

// A 2nd-order high-pass (RBJ biquad, Q 1/√2) of the samples, zero initial state.
export function highPass(samples, sampleRate, cutoffHz = HIGH_PASS_HZ) {
    const w = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = (1 + cos) / 2 / a0;
    const b1 = -(1 + cos) / a0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    const out = new Float32Array(samples.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const x = samples[i];
        const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y;
    }
    return out;
}

// The song-wide full scale of a signal: the 99.9th percentile of the peaks |x| of its 256-sample blocks (a few clicks
// do not shrink the rest), never below SCALE_FLOOR.
export function blockScale(x) {
    const n = Math.floor(x.length / BLOCK);
    if (!n) return SCALE_FLOOR;
    const blocks = new Float32Array(n);
    for (let b = 0; b < n; b += 1) {
        let m = 0;
        for (let i = b * BLOCK; i < (b + 1) * BLOCK; i += 1) {
            const a = Math.abs(x[i]);
            if (a > m) m = a;
        }
        blocks[b] = m;
    }
    blocks.sort();
    return Math.max(SCALE_FLOOR, blocks[Math.floor(SCALE_PERCENTILE * (n - 1))]);
}

// The envelope's song-wide bar range { lo, span }: its 20th percentile (the floor) to its 99.5th (full height).
export function envelopeRange(values) {
    const s = Float32Array.from(values ?? []).filter((v) => v > 0).sort();
    if (!s.length) return { lo: 0, span: 1 };
    const lo = s[Math.floor(ENVELOPE_FLOOR * (s.length - 1))];
    return { lo, span: s[Math.floor(ENVELOPE_TOP * (s.length - 1))] - lo || 1 };
}

// Bar heights 0..1 per pixel: the largest envelope frame under each pixel, scaled to the song's range. Takes the
// envelope as onsetEnvelope() returns it or as its transfer ({ frameOffsetSec }).
export function envelopeHeights(envelope, range, view, width) {
    const out = new Float32Array(width);
    const values = envelope?.values;
    if (!values?.length || !(envelope.hopSec > 0)) return out;
    const hop = envelope.hopSec;
    const first = typeof envelope.frameTimeSec === "function" ? envelope.frameTimeSec(0) : (envelope.frameOffsetSec ?? 0);
    const offset = first - hop / 2;
    for (let x = 0; x < width; x += 1) {
        const a = (view.startMs + (x / width) * view.spanMs) / 1000;
        const b = (view.startMs + ((x + 1) / width) * view.spanMs) / 1000;
        const f0 = Math.max(0, Math.floor((a - offset) / hop));
        const f1 = Math.min(values.length - 1, Math.ceil((b - offset) / hop));
        let m = 0;
        for (let f = f0; f <= f1; f += 1) if (values[f] > m) m = values[f];
        out[x] = m > 0 ? Math.min(1, Math.max(0, (m - range.lo) / range.span)) : 0;
    }
    return out;
}

// Once per song: the high-passed samples and both song-wide scales.
export function prepareWave({ samples, sampleRate, envelope = null }) {
    const hp = highPass(samples, sampleRate);
    return { hp, sampleRate, scale: blockScale(hp), envelope, range: envelopeRange(envelope?.values) };
}

// The song's two layers on a 2d context over the caller's background: the envelope bars from the bottom, then the
// high-passed min/max around the middle. Returns { bars, wave } (the drawn heights 0..1 per pixel; wave is half the
// min/max span) and leaves globalAlpha at 1.
export function drawWave(ctx, wave, view, width, height) {
    const bars = envelopeHeights(wave.envelope, wave.range, view, width);
    ctx.globalAlpha = ENVELOPE_ALPHA;
    ctx.fillStyle = ENVELOPE_COLOR;
    for (let x = 0; x < width; x += 1) {
        if (bars[x] > 0) ctx.fillRect(x, height - bars[x] * height, 1, bars[x] * height);
    }
    const mid = height / 2;
    const p = peaks(wave.hp, wave.sampleRate, view, width);
    const drawn = new Float32Array(width);
    ctx.globalAlpha = WAVE_ALPHA;
    ctx.fillStyle = WAVE_COLOR;
    for (let x = 0; x < width; x += 1) {
        const lo = Math.max(-1, p[2 * x] / wave.scale);
        const hi = Math.min(1, p[2 * x + 1] / wave.scale);
        drawn[x] = Math.max(0, hi - lo) / 2;
        ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
    }
    ctx.globalAlpha = 1;
    return { bars, wave: drawn };
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
    let wave = null;
    let view = { startMs: 0, spanMs: 6000 };
    let width = WIDTH;
    let drag = null;
    canvas.title = t("create.timing.nudgeHint");

    function draw() {
        const { ctx, width: w } = prepareCanvas(canvas, WIDTH, HEIGHT);
        width = w;
        if (!ctx) return;
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, w, HEIGHT);
        if (!song) return;
        drawWave(ctx, wave, view, w, HEIGHT);
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
        // { samples, sampleRate, durationMs, envelope? }: the mono samples the song was analysed from and its onset
        // envelope (src/audio/onset.js; without one only the waveform is drawn)
        setSong(next) {
            song = next;
            wave = next ? prepareWave(next) : null;
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
