// The judgement texts' letters: our own stroke font on a 4 × 6 grid (y down), drawn as round-capped lines, in three
// looks: "round" (thick), "thin" and "pixel" (blocky cells, no smoothing).
import { createImage, segment, union, mix, lighter, darker } from "./raster.js";

const O = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]];
const P = [[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]];
const GLYPHS = {
    0: [O],
    1: [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
    2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
    3: [[[0, 0], [4, 0], [2, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [1, 6], [0, 5]]],
    5: [[[4, 0], [0, 0], [0, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [0, 6]]],
    A: [[[0, 6], [0, 2], [2, 0], [4, 2], [4, 6]], [[0, 3.6], [4, 3.6]]],
    B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
    C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
    D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
    E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
    F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
    G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.5, 3.5]]],
    H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
    I: [[[0.8, 0], [3.2, 0]], [[2, 0], [2, 6]], [[0.8, 6], [3.2, 6]]],
    K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.6]], [[1.4, 2.4], [4, 6]]],
    L: [[[0, 0], [0, 6], [4, 6]]],
    M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
    N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
    O: [O],
    P: [P],
    R: [P, [[2, 3], [4, 6]]],
    S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
    T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
    U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
    X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
    Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
};
export const FONT_CHARS = Object.keys(GLYPHS).join("");
export { FONTS } from "./options.js";
const GAP = 1.6;

// The strokes of a text as segments [ax, ay, bx, by] in grid units, laid out left to right.
export function textStrokes(text) {
    const out = [];
    let x = 0;
    for (const ch of String(text).toUpperCase()) {
        if (ch !== " ") for (const line of GLYPHS[ch] ?? []) for (let i = 1; i < line.length; i += 1) out.push([line[i - 1][0] + x, line[i - 1][1], line[i][0] + x, line[i][1]]);
        x += 4 + GAP;
    }
    return { strokes: out, width: Math.max(4, x - GAP) };
}

// A text as an image: `unit` px per grid step, the colour with a lighter top, a dark outline and a soft glow.
// → raster image (src/skin/raster.js)
// scale: the image is that many times the size of the scale-1 one, to the pixel (@2x is exactly twice @1x)
export function renderText(text, { unit = 6, scale = 1, font = "round", colour = [255, 255, 255], outline = true, glow = true } = {}) {
    const { strokes, width } = textStrokes(text);
    const weight = font === "thin" ? 0.32 : 0.62;
    const border = outline ? (font === "thin" ? 0.45 : 0.55) : 0;
    const pad = (weight + border + 1.2) * unit;
    const base = unit / scale;
    const image = createImage(Math.ceil(width * base + (pad / scale) * 2) * scale, Math.ceil(6 * base + (pad / scale) * 2) * scale);
    const lines = strokes.map(([ax, ay, bx, by]) => [pad + ax * unit, pad + ay * unit, pad + bx * unit, pad + by * unit]);
    const shape = (r) => union(...lines.map(([ax, ay, bx, by]) => segment(ax, ay, bx, by, r * unit)));
    // the pixel look reads its shape at the centre of cells of 0.75 grid steps, edges hard
    const cell = 0.75 * unit;
    const sample = font === "pixel"
        ? (sdf) => (x, y) => sdf((Math.floor(x / cell) + 0.5) * cell, (Math.floor(y / cell) + 0.5) * cell) - cell * 0.15
        : (sdf) => sdf;
    const soft = font === "pixel" ? 0.01 : 1;
    const inner = sample(shape(weight));
    if (glow) image.glow(inner, mix(colour, [255, 255, 255], 0.2), 1.1 * unit, 0.35);
    if (outline) image.fill(sample(shape(weight + border)), [...darker(colour, 0.78), 0.95], { soft });
    const top = pad;
    const bottom = pad + 6 * unit;
    image.fill(inner, (x, y) => [...mix(lighter(colour, 0.55), colour, Math.max(0, Math.min(1, (y - top) / (bottom - top)))), 1], { soft });
    return image;
}
