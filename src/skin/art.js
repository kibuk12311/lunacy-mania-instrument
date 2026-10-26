// The builder's pictures, all drawn here: notes in four shapes (circle, bar, arrow, diamond), hold bodies and ends,
// keys pressed and not, the stage's hint, borders and column light, hit lighting. Sizes in px of the image being
// made, so one drawing serves @1x and @2x (and Interlude's square frames).
import { createImage, circle, roundBox, polygon, outline, hexRgb, mix, lighter, darker, vertical } from "./raster.js";

export { SHAPES } from "./options.js";
// arrows point the way their column is played on a dance pad: left, down, up, right
const ARROW_TURN = [Math.PI / 2, 0, Math.PI, -Math.PI / 2];

const rotate = (points, cx, cy, angle) => points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * Math.cos(angle) - dy * Math.sin(angle), cy + dx * Math.sin(angle) + dy * Math.cos(angle)];
});

// The outline of a note shape inside a w × h box (centre cx, cy): a distance function.
// size: 0–1 of the box the shape takes; column: which way an arrow points.
export function noteShape(shape, w, h, { size = 0.85, column = 0 } = {}) {
    const cx = w / 2;
    const cy = h / 2;
    switch (shape) {
    case "bar": return roundBox(cx, cy, (w * size) / 2, h / 2 - Math.max(1, h * 0.06), Math.min(h, w) * 0.32);
    case "diamond": {
        const r = (Math.min(w, h) * size) / 2;
        return polygon([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], r * 0.12);
    }
    case "arrow": {
        const r = (Math.min(w, h) * size) / 2;
        // pointing down: a head and a stem
        const pts = [[cx - r * 0.34, cy - r], [cx + r * 0.34, cy - r], [cx + r * 0.34, cy - r * 0.05], [cx + r, cy - r * 0.05],
            [cx, cy + r * 0.98], [cx - r, cy - r * 0.05], [cx - r * 0.34, cy - r * 0.05]];
        return polygon(rotate(pts, cx, cy, ARROW_TURN[column % 4]), r * 0.1);
    }
    default: return circle(cx, cy, (Math.min(w, h) * size) / 2);
    }
}

// A note: the shape filled with the colour (lighter at the top), a dark rim and a small shine.
export function drawNote(image, shape, colour, opts = {}) {
    const { width: w, height: h } = image;
    const sdf = noteShape(shape, w, h, opts);
    const rim = Math.max(1, Math.min(w, h) * 0.07);
    image.fill(sdf, vertical(lighter(colour, 0.45), darker(colour, 0.12), h * 0.1, h * 0.9));
    image.fill(outline(sdf, rim), [...darker(colour, 0.55), 0.9]);
    // the shine: a soft spot up and left of the centre
    const spot = circle(w * 0.4, h * (shape === "bar" ? 0.4 : 0.34), Math.min(w, h) * (shape === "bar" ? 0.16 : 0.12));
    image.fill((x, y) => Math.max(spot(x, y), sdf(x, y) + rim), [255, 255, 255, 0.35], { soft: Math.min(w, h) * 0.08 });
    return image;
}

export const NOTE_FILL = { bar: 1, circle: 0.72, arrow: 0.62, diamond: 0.7 };

// A hold body tile: w × h, the colour darker and see-through; style "solid" | "stripes" | "fade".
export function drawBody(image, shape, colour, { size = 0.85, style = "solid" } = {}) {
    const { width: w, height: h } = image;
    const half = (w * size * (NOTE_FILL[shape] ?? 0.72)) / 2;
    const body = (x) => Math.abs(x - w / 2) - half;
    const base = darker(colour, 0.2);
    const paint = (x, y) => {
        if (style === "fade") return [...base, 0.25 + 0.55 * (1 - Math.abs(x - w / 2) / half)];
        if (style === "stripes") return [...(Math.floor((x + y) / (w * 0.18)) % 2 ? base : lighter(base, 0.25)), 0.85];
        return [...base, 0.82];
    };
    image.fill((x) => body(x), paint, { soft: 1 });
    // the edges a touch brighter
    image.fill((x) => Math.abs(body(x) + Math.max(1, w * 0.03)) - Math.max(1, w * 0.03), [...lighter(colour, 0.3), 0.9]);
    return image;
}

// A hold end: the body's width, rounded at both ends, so it reads right in either scroll direction.
export function drawTail(image, shape, colour, { size = 0.85 } = {}) {
    const { width: w, height: h } = image;
    const half = (w * size * (NOTE_FILL[shape] ?? 0.72)) / 2;
    const sdf = roundBox(w / 2, h / 2, half, h / 2 - 1, Math.min(half, h / 2));
    image.fill(sdf, [...lighter(darker(colour, 0.2), 0.15), 0.9]);
    image.fill(outline(sdf, Math.max(1, w * 0.04)), [...lighter(colour, 0.3), 0.95]);
    return image;
}

// A key under the hit line: a panel with the column's colour along its top; pressed, the panel lights up.
// style: "plain" | "ring" | "glow"
export function drawKey(image, shape, colour, { pressed = false, style = "plain", theme = "dark", column = 0 } = {}) {
    const { width: w, height: h } = image;
    const dark = theme === "light" ? [228, 228, 238] : [24, 22, 34];
    const edge = Math.max(1, w * 0.04);
    const panel = roundBox(w / 2, h / 2, w / 2 - edge, h / 2 - edge, w * 0.12);
    const fill = style === "glow"
        ? vertical(pressed ? lighter(colour, 0.2) : mix(dark, colour, 0.35), dark, 0, h * 0.9)
        : (pressed ? () => [...mix(dark, colour, 0.45), 1] : () => [...dark, 1]);
    image.fill(panel, fill);
    image.fill(outline(panel, edge), [...(pressed ? lighter(colour, 0.35) : mix(dark, colour, 0.5)), 1]);
    // the colour strip along the top
    image.fill(roundBox(w / 2, edge * 3, w / 2 - edge * 3, edge * 1.3, edge), [...(pressed ? lighter(colour, 0.5) : colour), 1]);
    if (style === "ring") {
        const s = Math.min(w, h * 0.6) * 0.62;
        const icon = createImage(s, s);
        const sdf = noteShape(shape === "bar" ? "circle" : shape, s, s, { size: 0.9, column });
        icon.fill(outline(sdf, Math.max(1, s * 0.09)), [...(pressed ? lighter(colour, 0.5) : mix(dark, colour, 0.7)), 1]);
        if (pressed) icon.fill(sdf, [...colour, 0.45]);
        image.draw(icon, Math.round((w - s) / 2), Math.round(h * 0.45 - s / 2));
    }
    if (pressed) image.glow(roundBox(w / 2, edge * 3, w / 2 - edge * 3, edge, edge), lighter(colour, 0.6), h * 0.25, 0.5);
    return image;
}

// The line notes are hit on: a bright bar across, softly glowing.
export function drawHint(image, colour) {
    const { width: w, height: h } = image;
    const bar = roundBox(w / 2, h / 2, w / 2, Math.max(1, h * 0.1), 0);
    image.glow(bar, colour, h * 0.45, 0.55);
    image.fill(bar, [...lighter(colour, 0.6), 1]);
    return image;
}

// A border of the stage: a thin bright line (left: on its right edge, right: on its left edge).
export function drawBorder(image, colour, side = "left") {
    const { width: w, height: h } = image;
    const x = side === "left" ? w - Math.max(1, w * 0.35) : Math.max(1, w * 0.35);
    const line = roundBox(x, h / 2, Math.max(0.5, w * 0.18), h / 2, 0);
    image.glow(line, colour, w * 0.6, 0.35);
    image.fill(line, [...colour, 0.95]);
    return image;
}

// Column light: white fading upwards (osu! tints it with ColourLight#; Interlude gets it coloured).
export function drawColumnLight(image, colour = [255, 255, 255]) {
    const { width: w, height: h } = image;
    image.fill(() => -1, (x, y) => {
        const k = y / h;
        const side = 1 - Math.pow(Math.abs(x - w / 2) / (w / 2), 3);
        return [...colour, Math.max(0, k * k * 0.85 * side)];
    });
    return image;
}

// Hit lighting: a glow burst around the centre.
export function drawBurst(image, colour = [255, 255, 255]) {
    const { width: w, height: h } = image;
    const r = Math.min(w, h) * 0.16;
    image.glow(circle(w / 2, h / 2, r), colour, Math.min(w, h) * 0.34, 0.85);
    image.fill(circle(w / 2, h / 2, r * 0.7), [...lighter(colour, 0.7), 0.9], { soft: r * 0.6 });
    return image;
}

export { createImage, hexRgb };
