// PNG in and out for the skin builder's own images: RGBA 8-bit, written with node's zlib, read back for the
// size of any PNG (its header) and the pixels of a plain RGBA one (the tests check what the builder drew).
import { deflateSync, inflateSync, crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
}

// rgba: width × height × 4 bytes, not premultiplied. Each row filtered "Sub", which keeps flat art small.
export function encodePng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const out = y * (stride + 1);
        raw[out] = 1;
        for (let x = 0; x < stride; x += 1) {
            const v = rgba[y * stride + x];
            const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
            raw[out + 1 + x] = (v - left) & 255;
        }
    }
    return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// { width, height } of a PNG, or null when the bytes are not one.
export function pngSize(buffer) {
    const buf = Buffer.from(buffer ?? []);
    if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// channels per pixel of each 8-bit colour type: grey, RGB, palette, grey + alpha, RGBA
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// { width, height, data (RGBA) } of an 8-bit, non-interlaced PNG of any colour type (palettes with their tRNS
// transparency); throws on anything else (16-bit, interlaced, broken).
export function decodePng(buffer) {
    const buf = Buffer.from(buffer);
    const size = pngSize(buf);
    if (!size) throw new Error("not a PNG");
    const depth = buf[24];
    const type = buf[25];
    const channels = CHANNELS[type];
    if (depth !== 8 || !channels || buf[28] !== 0) throw new Error("only 8-bit, not interlaced");
    const parts = [];
    let palette = null;
    let alphas = null;
    for (let p = 8; p + 8 <= buf.length;) {
        const length = buf.readUInt32BE(p);
        const kind = buf.toString("latin1", p + 4, p + 8);
        const body = buf.subarray(p + 8, p + 8 + length);
        if (kind === "IDAT") parts.push(body);
        else if (kind === "PLTE") palette = body;
        else if (kind === "tRNS") alphas = body;
        else if (kind === "IEND") break;
        p += 12 + length;
    }
    if (type === 3 && !palette) throw new Error("no palette");
    const raw = inflateSync(Buffer.concat(parts));
    const { width, height } = size;
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) throw new Error("short image data");
    const rows = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x += 1) {
            const v = raw[y * (stride + 1) + 1 + x];
            const a = x >= channels ? rows[y * stride + x - channels] : 0;
            const b = y > 0 ? rows[(y - 1) * stride + x] : 0;
            const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
            const pred = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
            rows[y * stride + x] = (v + pred) & 255;
        }
    }
    if (type === 6) return { width, height, data: rows };
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        const o = i * 4;
        if (type === 0) data.set([rows[i], rows[i], rows[i], 255], o);
        else if (type === 4) data.set([rows[i * 2], rows[i * 2], rows[i * 2], rows[i * 2 + 1]], o);
        else if (type === 2) data.set([rows[i * 3], rows[i * 3 + 1], rows[i * 3 + 2], 255], o);
        else {
            const k = rows[i];
            data.set([palette[k * 3] ?? 0, palette[k * 3 + 1] ?? 0, palette[k * 3 + 2] ?? 0, alphas && k < alphas.length ? alphas[k] : 255], o);
        }
    }
    return { width, height, data };
}
