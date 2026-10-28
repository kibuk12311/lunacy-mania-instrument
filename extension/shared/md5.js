// MD5 of bytes as 32 lowercase hex digits: osu! names a difficulty's .osu by it (json-beatmapset checksum).
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
    10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

const toBytes = (input) => (typeof input === "string" ? new TextEncoder().encode(input)
    : input instanceof Uint8Array ? input : new Uint8Array(input ?? []));

export function md5Hex(input) {
    const bytes = toBytes(input);
    const length = bytes.length;
    const padded = new Uint8Array((((length + 8) >>> 6) + 1) * 64);
    padded.set(bytes);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    const bits = length * 8;
    view.setUint32(padded.length - 8, bits >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32) >>> 0, true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const m = new Uint32Array(16);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(off + i * 4, true);
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i += 1) {
            let f, g;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }
            const sum = (a + f + K[i] + m[g]) >>> 0;
            a = d;
            d = c;
            c = b;
            b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }
    let hex = "";
    for (const word of [a0, b0, c0, d0]) {
        for (let i = 0; i < 4; i += 1) hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
}
