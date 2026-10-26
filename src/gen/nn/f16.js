// IEEE 754 half precision: how nn-v2 weights are stored in the model JSON (f16 bits, base64, little endian, plus
// one float32 scale per tensor: value = half × scale). Decoded to Float32Array once at load.

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

export function f16ToF32(h) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) return sign * frac * 2 ** -24; // ±0 and subnormals
    if (exp === 0x1f) return frac ? Number.NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

// float → half bits, round to nearest even (as numpy's float16 cast).
export function f32ToF16(value) {
    F32[0] = value;
    const x = U32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
    let e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;
    if (e <= 0) {
        if (e < -10) return sign; // below half the smallest subnormal
        mant |= 0x800000;
        const shift = 14 - e;
        const half = 1 << (shift - 1);
        const rest = mant & ((1 << shift) - 1);
        let out = mant >>> shift;
        if (rest > half || (rest === half && out & 1)) out += 1;
        return sign | out;
    }
    const rest = mant & 0x1fff;
    let out = (e << 10) | (mant >>> 13);
    if (rest > 0x1000 || (rest === 0x1000 && out & 1)) out += 1; // a carry into the exponent is still right
    return sign | out;
}

function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof Buffer !== "undefined") return Buffer.from(data, "base64");
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
}

function base64Of(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// A lookup table for all 65536 halves, built on first use (256 KB).
let TABLE = null;
const table = () => {
    if (!TABLE) {
        TABLE = new Float32Array(0x10000);
        for (let h = 0; h < 0x10000; h += 1) TABLE[h] = f16ToF32(h);
    }
    return TABLE;
};

// base64 (or raw bytes) of little-endian halves → Float32Array of half × scale.
export function decodeF16(data, scale = 1, out = null) {
    const bytes = bytesOf(data);
    const n = bytes.length >> 1;
    const res = out ?? new Float32Array(n);
    const t = table();
    for (let i = 0; i < n; i += 1) res[i] = t[bytes[2 * i] | (bytes[2 * i + 1] << 8)] * scale;
    return res;
}

// Float32 values → { f16: base64, scale } with scale = the largest |value| (1 for an all-zero tensor), as
// tools/export_infill.py writes them. Used by tests and the bench to build models.
export function encodeF16(values) {
    let max = 0;
    for (const v of values) if (Math.abs(v) > max) max = Math.abs(v);
    F32[0] = max > 0 ? max : 1;
    const scale = F32[0];
    const bytes = new Uint8Array(values.length * 2);
    for (let i = 0; i < values.length; i += 1) {
        const h = f32ToF16(values[i] / scale);
        bytes[2 * i] = h & 0xff;
        bytes[2 * i + 1] = h >> 8;
    }
    return { f16: base64Of(bytes), scale };
}
