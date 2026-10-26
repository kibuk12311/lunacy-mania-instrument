// The create tab's one snap palette and beat grid, shared by the playfield, the wave strip and the timeline:
// a colour per beat fraction (1/1 red, 1/2 blue, 1/3 purple, 1/4 yellow, 1/6 pink, 1/8 orange) for notes and grid lines,
// read from a Timing ({ sections }, or the old { bpm, offsetMs }). Also sizes canvases for sharp lines on HiDPI screens.

export const SNAP_COLORS = { 1: "#ff8f8f", 2: "#8fd3ff", 3: "#c9a2ff", 4: "#f5c66b", 6: "#ff9ad5", 8: "#ffb36b", 0: "#8a8698" };
// the fractions a note can sit on, simplest first: 1/2 is a 1/2 even though 1/4, 1/6 and 1/8 grids hold it too
const FRACTIONS = [1, 2, 3, 4, 6, 8];
const MAX_LINES = 20000;

// Timing → its red lines [{ timeMs, bpm, meter }], sorted.
export function sectionsOf(timing) {
    const raw = timing?.sections ?? [{ timeMs: timing?.offsetMs ?? 0, bpm: timing?.bpm ?? 120, meter: 4 }];
    return raw.map((s) => ({ timeMs: Number(s.timeMs), bpm: Number(s.bpm), meter: s.meter ?? 4 })).sort((a, b) => a.timeMs - b.timeMs);
}

// The section in force at t; before the first red line the first one (its grid runs backwards).
export function sectionIndexAt(sections, t) {
    let i = 0;
    while (i + 1 < sections.length && sections[i + 1].timeMs <= t) i += 1;
    return i;
}

export const beatMsAt = (timing, t) => {
    const sections = sectionsOf(timing);
    return 60000 / sections[sectionIndexAt(sections, t)].bpm;
};

// The beat fraction a time sits on: { div: 1|2|3|4|6|8, color }, div 0 when it is on none of them (1/12, 1/16, off-grid).
export function snapOf(t, timing, tolMs = 2) {
    const sections = sectionsOf(timing);
    const s = sections[sectionIndexAt(sections, t)];
    const beatMs = 60000 / s.bpm;
    const phase = (t - s.timeMs) / beatMs;
    const frac = phase - Math.floor(phase);
    for (const d of FRACTIONS) {
        if (Math.abs(frac - Math.round(frac * d) / d) * beatMs <= tolMs) return { div: d, color: SNAP_COLORS[d] };
    }
    return { div: 0, color: SNAP_COLORS[0] };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Grid lines in [fromMs, toMs) with every beat cut into `div`: [{ t, div, bar }]. A line's div is its own fraction
// (a 1/4 grid gives 1, 4, 2, 4 …); bar marks the first beat of a measure (meter-many beats from the section's red line).
export function gridLines(timing, fromMs, toMs, div = 4) {
    const sections = sectionsOf(timing);
    const lines = [];
    sections.forEach((s, i) => {
        const step = 60000 / s.bpm / div;
        const segStart = i === 0 ? -Infinity : s.timeMs;
        const segEnd = i + 1 < sections.length ? sections[i + 1].timeMs : Infinity;
        const from = Math.max(fromMs, segStart);
        const to = Math.min(toMs, segEnd);
        if (!(to > from)) return;
        for (let k = Math.ceil((from - s.timeMs) / step - 1e-9); lines.length < MAX_LINES; k += 1) {
            const t = s.timeMs + k * step;
            if (t >= to - 1e-9) break;
            const j = ((k % div) + div) % div;
            const beat = Math.floor(k / div);
            lines.push({ t, div: j === 0 ? 1 : div / gcd(j, div), bar: j === 0 && ((beat % s.meter) + s.meter) % s.meter === 0 });
        }
    });
    return lines;
}

// Sizes a canvas for its CSS width (or `width` when it has none yet) at the screen's pixel ratio;
// returns { ctx, width, height } in CSS pixels, ctx null where there is no 2d context.
export function prepareCanvas(canvas, width, height) {
    const ratio = globalThis.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth || width);
    // a new backing size only when it changes: setting it clears and reallocates the canvas
    if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    if (canvas.style) canvas.style.height = `${height}px`;
    const ctx = canvas.getContext?.("2d") ?? null;
    ctx?.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width: w, height };
}

// m:ss for a song time in ms (negative times read as 0:00).
export function clockText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
