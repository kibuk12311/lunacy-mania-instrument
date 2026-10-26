// Geometry of the drawn parts, kept pure so it can be tested: the key-lines bars and the KPS and NPS graphs.
// Colours per style live here too, since the canvas needs them as values.

// Lane colours (K1–K4), the KPS graph colour and the NPS map graph colour per style.
export const PALETTE = {
    minimal: { lanes: ["#ffffff", "#ffffff", "#ffffff", "#ffffff"], graph: "#ffffff", lit: "#ffffffcc", nps: "#ffffff" },
    card: { lanes: ["#8fd3ff", "#f5c66b", "#f5c66b", "#8fd3ff"], graph: "#f5c66b", lit: "#f5c66b", nps: "#8fd3ff" },
    neon: { lanes: ["#22f0ff", "#ff3df2", "#ff3df2", "#22f0ff"], graph: "#22f0ff", lit: "#ff3df2", nps: "#ff3df2", glow: 10 },
    classic: { lanes: ["#e8e8e8", "#4fb3ff", "#4fb3ff", "#e8e8e8"], graph: "#ffcc22", lit: "#ffcc22", nps: "#33dd55" },
    compact: { lanes: ["#7be08f", "#c9a2ff", "#c9a2ff", "#7be08f"], graph: "#7be08f", lit: "#7be08f", nps: "#c9a2ff" },
};

export const paletteFor = (style) => PALETTE[style] ?? PALETTE.card;
export const laneColor = (style, col) => {
    const lanes = paletteFor(style).lanes;
    return lanes[col % lanes.length];
};

// Press bars → rectangles in a box width × height: the newest presses at the bottom, moving up as time goes on.
// bars: [{ col, start, end }] in map ms (end null: still held), clock: map ms now, spanMs: map ms from bottom to top.
export function laneRects(bars, { clock, spanMs, keys, width, height, gap = 3, minHeight = 2 }) {
    const laneWidth = width / Math.max(1, keys);
    const px = height / Math.max(1, spanMs);
    const rects = [];
    for (const b of bars) {
        if (b.col < 0 || b.col >= keys || b.start > clock) continue;
        const end = b.end === null || b.end > clock ? clock : b.end;
        const top = height - (clock - b.start) * px;
        let bottom = height - (clock - end) * px;
        if (bottom <= 0) continue;
        if (bottom - top < minHeight) bottom = top + minHeight;
        rects.push({
            col: b.col,
            x: b.col * laneWidth + gap / 2,
            y: Math.max(0, top),
            w: Math.max(1, laneWidth - gap),
            h: Math.min(height, bottom) - Math.max(0, top),
        });
    }
    return rects;
}

// A graph history → polyline points in width × height. history is either evenly spaced values (the NPS map profile)
// or the KPS meter's { values, shift }: grid samples, one step apart, then the point at the clock itself at the right
// edge; the grid is drawn `shift` steps to the left, so it scrolls smoothly instead of stepping.
// top: the value at the top edge (graphCeiling(), eased by the widget); without one, the highest value, at least floor.
export function graphPoints(history, { width, height, top, floor = 10, pad = 2 }) {
    const grid = !Array.isArray(history) && Array.isArray(history?.values) && history.values.length > 1;
    const list = grid ? history.values : Array.isArray(history) && history.length ? history : [0];
    const ceiling = top > 0 ? top : Math.max(floor, ...list);
    const y = (v) => pad + (height - 2 * pad) * (1 - Math.min(1, Math.max(0, v) / ceiling));
    if (grid) {
        const n = list.length - 2; // grid steps across the width
        const stepX = width / Math.max(1, n);
        const shift = Math.min(1, Math.max(0, history.shift || 0));
        const pts = list.slice(0, -1).map((v, i) => ({ x: (i - shift) * stepX, y: y(v) }));
        pts.push({ x: width, y: y(list.at(-1)) });
        return pts;
    }
    const stepX = list.length > 1 ? width / (list.length - 1) : 0;
    return list.map((v, i) => ({ x: i * stepX, y: y(v) }));
}

// The value at the top of a graph: a little above the play's max (or the map's peak), never under floor. It only
// moves when a new max comes, and the widget eases towards it, so the scale never jumps from one frame to the next.
export const graphCeiling = (max, floor = 10) => Math.max(floor, (Number(max) || 0) * 1.15);

// current → target, exponentially with time constant tauMs over dtMs (current null: straight to target)
export function easeToward(current, target, dtMs, tauMs) {
    if (!Number.isFinite(current)) return target;
    if (!(dtMs > 0)) return current;
    return current + (target - current) * (1 - Math.exp(-dtMs / Math.max(1, tauMs)));
}

// The integer a big number shows: it moves off `shown` only once value is clearly nearer another integer
// (more than `band` away), so a rate sitting at 10.5 does not flick between 10 and 11.
export function holdRounded(shown, value, band = 0.7) {
    if (!Number.isFinite(value)) return 0;
    return Number.isFinite(shown) && Math.abs(value - shown) < band ? shown : Math.round(value);
}
