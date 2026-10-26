// Geometry of the two drawn parts, kept pure so it can be tested: the key-lines bars and the KPS graph.
// Colours per style live here too, since the canvas needs them as values.

// Lane colours (K1–K4) and the graph colour per style.
export const PALETTE = {
    minimal: { lanes: ["#ffffff", "#ffffff", "#ffffff", "#ffffff"], graph: "#ffffff", lit: "#ffffffcc" },
    card: { lanes: ["#8fd3ff", "#f5c66b", "#f5c66b", "#8fd3ff"], graph: "#f5c66b", lit: "#f5c66b" },
    neon: { lanes: ["#22f0ff", "#ff3df2", "#ff3df2", "#22f0ff"], graph: "#22f0ff", lit: "#ff3df2", glow: 10 },
    classic: { lanes: ["#e8e8e8", "#4fb3ff", "#4fb3ff", "#e8e8e8"], graph: "#ffcc22", lit: "#ffcc22" },
    compact: { lanes: ["#7be08f", "#c9a2ff", "#c9a2ff", "#7be08f"], graph: "#7be08f", lit: "#7be08f" },
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

// KPS history → polyline points in width × height, the top at least `floor` KPS so a calm stretch stays low.
export function graphPoints(history, { width, height, floor = 10, pad = 2 }) {
    const list = Array.isArray(history) && history.length ? history : [0];
    const top = Math.max(floor, ...list);
    const stepX = list.length > 1 ? width / (list.length - 1) : 0;
    return list.map((v, i) => ({ x: i * stepX, y: pad + (height - 2 * pad) * (1 - Math.max(0, v) / top) }));
}
