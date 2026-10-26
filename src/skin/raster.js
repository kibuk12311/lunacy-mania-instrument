// A tiny software painter for the skin builder: shapes as signed distance functions (negative inside, in pixels),
// one pixel of anti-aliasing at the edge, painted over an RGBA canvas with "source over". Our own drawing only.
import { encodePng } from "./png.js";

export function createImage(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    // straight (not premultiplied) RGBA as floats 0–1 while drawing
    const px = new Float32Array(w * h * 4);
    const image = {
        width: w, height: h, px,
        // paint(x, y) → [r, g, b, a] (0–255 colour, 0–1 alpha) where sdf(x, y) < 0, softened over one pixel
        fill(sdf, paint, { box = null, soft = 1 } = {}) {
            const [x0, y0, x1, y1] = box ?? [0, 0, w, h];
            for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y += 1) {
                for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x += 1) {
                    const cx = x + 0.5;
                    const cy = y + 0.5;
                    const d = sdf(cx, cy);
                    const cover = Math.max(0, Math.min(1, 0.5 - d / soft));
                    if (cover <= 0) continue;
                    const [r, g, b, a = 1] = typeof paint === "function" ? paint(cx, cy, d) : paint;
                    blend(x, y, r, g, b, a * cover);
                }
            }
            return image;
        },
        // a soft glow: alpha falls from `alpha` at d ≤ 0 to 0 at d = radius (outside the shape)
        glow(sdf, colour, radius, alpha = 1) {
            for (let y = 0; y < h; y += 1) {
                for (let x = 0; x < w; x += 1) {
                    const d = sdf(x + 0.5, y + 0.5);
                    if (d >= radius) continue;
                    const k = d <= 0 ? 1 : 1 - d / radius;
                    blend(x, y, colour[0], colour[1], colour[2], alpha * k * k);
                }
            }
            return image;
        },
        // the image turned upside down (a hold tail made from a head)
        flipped() {
            const out = createImage(w, h);
            for (let y = 0; y < h; y += 1) out.px.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
            return out;
        },
        // another image drawn at (dx, dy) with no scaling
        draw(other, dx = 0, dy = 0) {
            for (let y = 0; y < other.height; y += 1) {
                for (let x = 0; x < other.width; x += 1) {
                    const i = (y * other.width + x) * 4;
                    const a = other.px[i + 3];
                    if (a > 0 && x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) {
                        blend(x + dx, y + dy, other.px[i] * 255, other.px[i + 1] * 255, other.px[i + 2] * 255, a);
                    }
                }
            }
            return image;
        },
        bytes() {
            const out = new Uint8Array(w * h * 4);
            for (let i = 0; i < out.length; i += 1) out[i] = Math.round(Math.max(0, Math.min(1, px[i])) * 255);
            return out;
        },
        png() { return encodePng(w, h, image.bytes()); },
    };
    function blend(x, y, r, g, b, a) {
        if (a <= 0) return;
        const i = (y * w + x) * 4;
        const da = px[i + 3];
        const oa = a + da * (1 - a);
        if (oa <= 0) return;
        px[i] = ((r / 255) * a + px[i] * da * (1 - a)) / oa;
        px[i + 1] = ((g / 255) * a + px[i + 1] * da * (1 - a)) / oa;
        px[i + 2] = ((b / 255) * a + px[i + 2] * da * (1 - a)) / oa;
        px[i + 3] = oa;
    }
    return image;
}

// An RGBA byte picture (a decoded PNG) as an image to draw with.
export function fromRgba(width, height, data) {
    const image = createImage(width, height);
    for (let i = 0; i < width * height * 4; i += 1) image.px[i] = data[i] / 255;
    return image;
}

// A picture scaled into w × h, smoothly (each target pixel averages the source pixels under it, alpha-weighted so
// edges don't go dark). mode "fit": aspect kept, centred, see-through around it; "stretch": fills w × h exactly.
export function fitted(source, w, h, { mode = "fit" } = {}) {
    const out = createImage(w, h);
    const fit = Math.min(w / source.width, h / source.height);
    const kx = mode === "stretch" ? w / source.width : fit;
    const ky = mode === "stretch" ? h / source.height : fit;
    const ox = (w - source.width * kx) / 2;
    const oy = (h - source.height * ky) / 2;
    const steps = Math.max(1, Math.min(8, Math.ceil(1 / Math.min(kx, ky))));
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            // the source area under this pixel
            const x0 = (x - ox) / kx;
            const x1 = (x + 1 - ox) / kx;
            const y0 = (y - oy) / ky;
            const y1 = (y + 1 - oy) / ky;
            if (x1 <= 0 || y1 <= 0 || x0 >= source.width || y0 >= source.height) continue;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let sy = 0; sy < steps; sy += 1) {
                for (let sx = 0; sx < steps; sx += 1) {
                    const px = Math.floor(x0 + ((sx + 0.5) * (x1 - x0)) / steps);
                    const py = Math.floor(y0 + ((sy + 0.5) * (y1 - y0)) / steps);
                    if (px < 0 || py < 0 || px >= source.width || py >= source.height) continue;
                    const i = (py * source.width + px) * 4;
                    const al = source.px[i + 3];
                    r += source.px[i] * al;
                    g += source.px[i + 1] * al;
                    b += source.px[i + 2] * al;
                    a += al;
                }
            }
            if (a <= 0) continue;
            const o = (y * w + x) * 4;
            out.px[o] = r / a;
            out.px[o + 1] = g / a;
            out.px[o + 2] = b / a;
            out.px[o + 3] = a / (steps * steps);
        }
    }
    return out;
}

// ---- distance functions ----

export const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

// a box centred at (cx, cy), half sizes hw × hh, corners rounded by r
export const roundBox = (cx, cy, hw, hh, r = 0) => (x, y) => {
    const rr = Math.min(r, hw, hh);
    const qx = Math.abs(x - cx) - hw + rr;
    const qy = Math.abs(y - cy) - hh + rr;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
};

// a line from (ax, ay) to (bx, by), radius r: a stroke with round ends
export const segment = (ax, ay, bx, by, r) => (x, y) => {
    const px = x - ax;
    const py = y - ay;
    const dx = bx - ax;
    const dy = by - ay;
    const k = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - dx * k, py - dy * k) - r;
};

// a polygon [[x, y], …] (any simple one), its corners rounded by r
export const polygon = (points, r = 0) => (x, y) => {
    let d = Infinity;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        const ex = xj - xi;
        const ey = yj - yi;
        const wx = x - xi;
        const wy = y - yi;
        const k = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
        d = Math.min(d, Math.hypot(wx - ex * k, wy - ey * k));
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return (inside ? -d : d) - r;
};

export const union = (...shapes) => (x, y) => Math.min(...shapes.map((s) => s(x, y)));
export const subtract = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));
// the ring of a shape: within `width` of its edge, inside
export const outline = (shape, width) => (x, y) => Math.abs(shape(x, y) + width / 2) - width / 2;

// ---- colours ----

export function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""));
    const v = m ? Number.parseInt(m[1], 16) : 0xffffff;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
export const lighter = (c, k) => mix(c, [255, 255, 255], k);
export const darker = (c, k) => mix(c, [0, 0, 0], k);

// a vertical gradient from `top` at y0 to `bottom` at y1, alpha a
export const vertical = (top, bottom, y0, y1, a = 1) => (x, y) => {
    const k = Math.max(0, Math.min(1, (y - y0) / (y1 - y0 || 1)));
    return [...mix(top, bottom, k), a];
};
