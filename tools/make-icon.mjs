// Draws the app icon (4K mania lanes with a rising jumpstream, gold and blue notes on the app's dark panel)
// and writes app/assets/icon.png (256 px) and build/icon.ico (16–256 px). Run: node tools/make-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD = [245, 198, 107];
const BLUE = [143, 211, 255];
const TOP = [46, 38, 70];
const BOTTOM = [20, 18, 28];

// Shapes on a 256 grid, drawn in order: { x, y, w, h, r, color | gradient }.
const W = 44;
const lane = (i) => 25 + i * 54;
const note = (col, y, color) => ({ x: lane(col), y, w: W, h: 24, r: 8, color });
const SHAPES = [
    { x: 8, y: 8, w: 240, h: 240, r: 56, gradient: [TOP, BOTTOM] },
    ...[1, 2, 3].map((i) => ({ x: lane(i) - 6, y: 34, w: 2, h: 172, r: 1, color: [70, 62, 98] })),
    note(0, 176, GOLD), note(1, 136, BLUE), note(2, 96, BLUE), note(3, 56, GOLD),
    note(0, 96, GOLD), note(3, 136, GOLD), note(1, 56, BLUE),
    { x: 25, y: 214, w: 206, h: 8, r: 4, color: GOLD },
];

function inside(s, px, py) {
    if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
    const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
    const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= s.r ** 2;
}

function render(size, ss = 4) {
    const px = Buffer.alloc(size * size * 4);
    const scale = 256 / size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let [r, g, b, a] = [0, 0, 0, 0];
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const gx = (x + (sx + 0.5) / ss) * scale;
                    const gy = (y + (sy + 0.5) / ss) * scale;
                    let c = null;
                    for (const s of SHAPES) {
                        if (!inside(s, gx, gy)) continue;
                        if (s.gradient) {
                            const t = (gy - s.y) / s.h;
                            c = s.gradient[0].map((v, i) => v + (s.gradient[1][i] - v) * t);
                        } else c = s.color;
                    }
                    if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
                }
            }
            const o = (y * size + x) * 4;
            const n = ss * ss;
            // colour averaged over covered samples, alpha = coverage
            px[o] = a ? Math.round(r / a) : 0;
            px[o + 1] = a ? Math.round(g / a) : 0;
            px[o + 2] = a ? Math.round(b / a) : 0;
            px[o + 3] = Math.round((a / n) * 255);
        }
    }
    return png(size, px);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
    ]);
}

// ICO with PNG-encoded entries (Vista+ reads them at every size).
function ico(images) {
    const head = Buffer.alloc(6 + images.length * 16);
    head.writeUInt16LE(0, 0);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(images.length, 4);
    let offset = head.length;
    images.forEach(({ size, data }, i) => {
        const e = 6 + i * 16;
        head[e] = size >= 256 ? 0 : size;
        head[e + 1] = size >= 256 ? 0 : size;
        head.writeUInt16LE(1, e + 4);
        head.writeUInt16LE(32, e + 6);
        head.writeUInt32LE(data.length, e + 8);
        head.writeUInt32LE(offset, e + 12);
        offset += data.length;
    });
    return Buffer.concat([head, ...images.map((im) => im.data)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: render(size) }));
mkdirSync(path.join(root, "build"), { recursive: true });
writeFileSync(path.join(root, "app", "assets", "icon.png"), images.at(-1).data);
writeFileSync(path.join(root, "build", "icon.ico"), ico(images));
console.log("icon.png 256 px, icon.ico", sizes.join("/"));
