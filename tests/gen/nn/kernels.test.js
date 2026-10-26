import test from "node:test";
import assert from "node:assert/strict";
import {
    matmul, matmulT, matvec, linearRows, layerNorm, gelu, softmaxInPlace, attendHead, alibiSlopes,
} from "../../../src/gen/nn/kernels.js";
import { f16ToF32, f32ToF16, decodeF16, encodeF16 } from "../../../src/gen/nn/f16.js";
import { mulberry32 } from "../../../src/gen/rng.js";

const randomArray = (n, seed, scale = 1) => {
    const rng = mulberry32(seed);
    return Float32Array.from({ length: n }, () => (rng() * 2 - 1) * scale);
};
const close = (a, b, tol, what) => {
    assert.equal(a.length, b.length, `${what}: length`);
    for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) <= tol * (1 + Math.abs(b[i])), `${what}[${i}]: ${a[i]} vs ${b[i]}`);
};

// naive references, in float64
function naiveMatmul(A, B, n, k, m) {
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) {
        let s = 0;
        for (let p = 0; p < k; p += 1) s += A[i * k + p] * B[p * m + j];
        out[i * m + j] = s;
    }
    return out;
}

test("matmul (i-p-j) matches a naive product on odd sizes", () => {
    for (const [n, k, m] of [[1, 1, 1], [3, 5, 7], [7, 13, 9], [16, 96, 33]]) {
        const A = randomArray(n * k, n + 1);
        const B = randomArray(k * m, m + 2);
        close(matmul(A, B, n, k, m), naiveMatmul(A, B, n, k, m), 1e-5, `matmul ${n}x${k}x${m}`);
    }
});

test("matmulT (A·Bᵀ, dot products) and linearRows match the naive product, bias added", () => {
    for (const [n, k, m] of [[1, 3, 2], [5, 7, 3], [9, 17, 6], [12, 96, 40]]) {
        const A = randomArray(n * k, 3 * n);
        const W = randomArray(m * k, 5 * m); // m×k: rows are output units, as PyTorch stores Linear weights
        const Bt = new Float32Array(k * m);
        for (let j = 0; j < m; j += 1) for (let p = 0; p < k; p += 1) Bt[p * m + j] = W[j * k + p];
        const ref = naiveMatmul(A, Bt, n, k, m);
        close(matmulT(A, W, n, k, m), ref, 1e-5, `matmulT ${n}x${k}x${m}`);
        const b = randomArray(m, 77);
        const withBias = Float64Array.from(ref, (v, idx) => v + b[idx % m]);
        close(linearRows(A, n, W, b, k, m), withBias, 1e-5, `linearRows ${n}x${k}x${m}`);
    }
});

test("matvec (4-way unrolled) matches the naive dot products, with and without bias, at offsets", () => {
    for (const [m, k] of [[1, 1], [3, 5], [16, 7], [64, 256], [64, 160]]) {
        const W = randomArray(m * k, k);
        const x = randomArray(k + 3, m);
        const b = randomArray(m, 11);
        const ref = new Float64Array(m);
        for (let j = 0; j < m; j += 1) {
            let s = b[j];
            for (let p = 0; p < k; p += 1) s += W[j * k + p] * x[3 + p];
            ref[j] = s;
        }
        const out = new Float32Array(m + 2);
        matvec(W, x, 3, m, k, out, 2, b);
        close(out.subarray(2), ref, 1e-5, `matvec ${m}x${k}`);
        const noBias = matvec(W, x, 3, m, k);
        close(noBias, Float64Array.from(ref, (v, j) => v - b[j]), 1e-5, `matvec no bias ${m}x${k}`);
    }
});

test("softmax is stable at ±80 and sums to 1", () => {
    const x = Float64Array.from([80, -80, 79, 0, 80]);
    softmaxInPlace(x, 0, x.length);
    assert.ok(x.every(Number.isFinite));
    assert.ok(Math.abs(x.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    assert.ok(Math.abs(x[0] - x[4]) < 1e-15 && x[1] < 1e-60 && Math.abs(x[0] / x[2] - Math.E) < 1e-9);
    const big = Float32Array.from([1000, 999, -1000]);
    softmaxInPlace(big, 0, 3);
    assert.ok(big.every(Number.isFinite) && Math.abs(big[0] + big[1] + big[2] - 1) < 1e-6);
    const part = Float64Array.from([5, -80, 80, 7]);
    softmaxInPlace(part, 1, 2); // only the middle two
    assert.equal(part[0], 5);
    assert.equal(part[3], 7);
    assert.ok(Math.abs(part[1] + part[2] - 1) < 1e-12);
});

test("layerNorm normalises to zero mean / unit variance, then applies gain and bias", () => {
    const x = Float32Array.from([1, 2, 3, 4, 10]);
    const g = Float32Array.from([1, 1, 1, 1, 1]);
    const b = new Float32Array(5);
    const out = new Float32Array(5);
    layerNorm(x, 0, 5, g, b, out, 0);
    const mean = out.reduce((a, v) => a + v, 0) / 5;
    const varr = out.reduce((a, v) => a + v * v, 0) / 5;
    assert.ok(Math.abs(mean) < 1e-6 && Math.abs(varr - 1) < 1e-3);
    const g2 = Float32Array.from([2, 2, 2, 2, 2]);
    const b2 = Float32Array.from([1, 1, 1, 1, 1]);
    const out2 = new Float32Array(5);
    layerNorm(x, 0, 5, g2, b2, out2, 0);
    for (let i = 0; i < 5; i += 1) assert.ok(Math.abs(out2[i] - (2 * out[i] + 1)) < 1e-5);
});

test("gelu is the tanh form", () => {
    const ref = (v) => 0.5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + 0.044715 * v ** 3)));
    for (const v of [-6, -1, -0.1, 0, 0.3, 1, 2.5, 9]) assert.ok(Math.abs(gelu(v) - ref(v)) < 1e-12, `gelu(${v})`);
    assert.equal(gelu(0), 0);
});

test("alibi slopes are the geometric sequence 2^(-8(h+1)/H)", () => {
    assert.deepEqual(Array.from(alibiSlopes(4)), [1 / 4, 1 / 16, 1 / 64, 1 / 256]);
    assert.equal(alibiSlopes(8)[0], 2 ** -1);
});

test("attention over an explicit key list equals dense attention masked to the same keys", () => {
    const T = 40;
    const H = 2;
    const dh = 8;
    const d = H * dh;
    const Q = randomArray(T * d, 1, 2);
    const K = randomArray(T * d, 2, 2);
    const V = randomArray(T * d, 3);
    const slopes = alibiSlopes(H);
    const scale = 1 / Math.sqrt(dh);
    for (const q of [0, 7, 21, 39]) {
        // keys: a ±5 window, one far "echo" key with its own bias, and the last key
        const keys = [];
        const bias = [];
        for (let s = Math.max(0, q - 5); s <= Math.min(T - 1, q + 5); s += 1) keys.push(s);
        const echo = (q + 20) % T;
        if (!keys.includes(echo)) keys.push(echo);
        for (let h = 0; h < H; h += 1) {
            const kb = keys.map((s) => (s === echo && Math.abs(s - q) > 5 ? 0.3 : -slopes[h] * Math.abs(s - q)));
            bias.push(kb);
            const out = new Float32Array(d);
            const scores = new Float64Array(keys.length);
            attendHead(Q, q * d + h * dh, K, h * dh, V, h * dh, d, dh, keys, Float64Array.from(kb), keys.length, scale, out, h * dh, scores);
            // dense: every key, −∞ where not listed
            const dense = new Float64Array(T);
            for (let s = 0; s < T; s += 1) {
                const at = keys.indexOf(s);
                if (at < 0) {
                    dense[s] = -Infinity;
                    continue;
                }
                let dot = 0;
                for (let c = 0; c < dh; c += 1) dot += Q[q * d + h * dh + c] * K[s * d + h * dh + c];
                dense[s] = dot * scale + kb[at];
            }
            const max = Math.max(...dense);
            let z = 0;
            for (let s = 0; s < T; s += 1) z += Math.exp(dense[s] - max);
            const ref = new Float64Array(dh);
            for (let s = 0; s < T; s += 1) {
                const p = Math.exp(dense[s] - max) / z;
                for (let c = 0; c < dh; c += 1) ref[c] += p * V[s * d + h * dh + c];
            }
            close(out.subarray(h * dh, (h + 1) * dh), ref, 1e-5, `attention q=${q} h=${h}`);
        }
    }
});

test("f16 decoding covers normals, subnormals, ±0, ±Inf and NaN", () => {
    assert.equal(f16ToF32(0x3c00), 1);
    assert.equal(f16ToF32(0xc000), -2);
    assert.equal(f16ToF32(0x3555), 0.333251953125);
    assert.equal(f16ToF32(0x7bff), 65504);
    assert.equal(f16ToF32(0x0400), 2 ** -14); // smallest normal
    assert.equal(f16ToF32(0x0001), 2 ** -24); // smallest subnormal
    assert.equal(f16ToF32(0x03ff), 1023 * 2 ** -24); // largest subnormal
    assert.equal(f16ToF32(0x8001), -(2 ** -24));
    assert.ok(Object.is(f16ToF32(0x0000), 0));
    assert.ok(Object.is(f16ToF32(0x8000), -0));
    assert.equal(f16ToF32(0x7c00), Infinity);
    assert.equal(f16ToF32(0xfc00), -Infinity);
    assert.ok(Number.isNaN(f16ToF32(0x7e00)));
});

test("f16 encoding rounds to nearest even and round-trips every finite half", () => {
    for (let h = 0; h < 0x10000; h += 1) {
        const v = f16ToF32(h);
        if (Number.isNaN(v)) continue;
        assert.equal(f32ToF16(v), h, `half 0x${h.toString(16)}`);
    }
    assert.equal(f32ToF16(1 + 2 ** -11), 0x3c00); // tie → even
    assert.equal(f32ToF16(1 + 3 * 2 ** -11), 0x3c02); // tie → even (up)
    assert.equal(f32ToF16(1e6), 0x7c00); // overflow → Inf
    assert.equal(f32ToF16(2 ** -26), 0x0000); // underflow below half the smallest subnormal → 0
    assert.equal(f32ToF16(Number.NaN) & 0x7c00, 0x7c00);
});

test("decodeF16 applies the per-tensor scale; encodeF16 picks the scale from the largest value", () => {
    const w = Float32Array.from([0.5, -0.25, 3, 1e-7, -3]);
    const { f16, scale } = encodeF16(w);
    assert.equal(scale, 3);
    const back = decodeF16(f16, scale);
    assert.equal(back.length, 5);
    for (let i = 0; i < 5; i += 1) assert.ok(Math.abs(back[i] - w[i]) <= 3 * 2 ** -11 * Math.abs(w[i] / 3) + 3 * 2 ** -25, `w[${i}]`);
    assert.equal(back[2], 3);
    const zeros = encodeF16(new Float32Array(4));
    assert.equal(zeros.scale, 1);
    assert.deepEqual(Array.from(decodeF16(zeros.f16, zeros.scale)), [0, 0, 0, 0]);
});
