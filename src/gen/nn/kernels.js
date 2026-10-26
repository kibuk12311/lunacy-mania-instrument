// Plain-JS kernels for the nn-v2 infill transformer (no WebAssembly, no ONNX). Linear weights keep PyTorch's
// layout, [out][in] row-major, so every output is a dot product over contiguous memory; dot products are unrolled
// 4 ways (separate accumulators) because that is what V8 runs fastest (§5.1 of the ML addendum).

// C = A·B for A n×k and B k×m (i-p-j order: the inner loop walks a row of B and a row of C).
export function matmul(A, B, n, k, m, out = new Float32Array(n * m)) {
    out.fill(0, 0, n * m);
    for (let i = 0; i < n; i += 1) {
        const ci = i * m;
        for (let p = 0; p < k; p += 1) {
            const a = A[i * k + p];
            if (a === 0) continue;
            const bp = p * m;
            for (let j = 0; j < m; j += 1) out[ci + j] += a * B[bp + j];
        }
    }
    return out;
}

function dot(a, ao, b, bo, k) {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let p = 0;
    for (; p + 3 < k; p += 4) {
        s0 += a[ao + p] * b[bo + p];
        s1 += a[ao + p + 1] * b[bo + p + 1];
        s2 += a[ao + p + 2] * b[bo + p + 2];
        s3 += a[ao + p + 3] * b[bo + p + 3];
    }
    for (; p < k; p += 1) s0 += a[ao + p] * b[bo + p];
    return s0 + s1 + s2 + s3;
}

// C = A·Wᵀ for A n×k and W m×k (each output is a dot product of two contiguous rows).
export function matmulT(A, W, n, k, m, out = new Float32Array(n * m)) {
    for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) out[i * m + j] = dot(A, i * k, W, j * k, k);
    return out;
}

// Rows of X (n×inDim) through a Linear (W outDim×inDim, bias outDim or null): n×outDim.
export function linearRows(X, n, W, b, inDim, outDim, out = new Float32Array(n * outDim)) {
    for (let i = 0; i < n; i += 1) {
        const xo = i * inDim;
        const oo = i * outDim;
        for (let j = 0; j < outDim; j += 1) out[oo + j] = dot(X, xo, W, j * inDim, inDim) + (b ? b[j] : 0);
    }
    return out;
}

// y = W·x (+ b): W m×k, x read from x[xo..xo+k), y written to out[oo..oo+m).
export function matvec(W, x, xo, m, k, out = new Float32Array(m), oo = 0, b = null) {
    for (let j = 0; j < m; j += 1) out[oo + j] = dot(W, j * k, x, xo, k) + (b ? b[j] : 0);
    return out;
}

export function layerNorm(x, xo, n, gain, bias, out, oo, eps = 1e-5) {
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += x[xo + i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i += 1) {
        const d = x[xo + i] - mean;
        v += d * d;
    }
    const inv = 1 / Math.sqrt(v / n + eps);
    for (let i = 0; i < n; i += 1) out[oo + i] = (x[xo + i] - mean) * inv * gain[i] + bias[i];
    return out;
}

const GELU_C = Math.sqrt(2 / Math.PI);
export const gelu = (v) => 0.5 * v * (1 + Math.tanh(GELU_C * (v + 0.044715 * v * v * v)));

export function geluInPlace(x, xo, n) {
    for (let i = 0; i < n; i += 1) x[xo + i] = gelu(x[xo + i]);
    return x;
}

// Softmax over x[o..o+n) in place, shifted by the maximum so ±80 (or ±1000) never overflows.
export function softmaxInPlace(x, o, n) {
    let max = -Infinity;
    for (let i = 0; i < n; i += 1) if (x[o + i] > max) max = x[o + i];
    let z = 0;
    for (let i = 0; i < n; i += 1) {
        const e = Math.exp(x[o + i] - max);
        x[o + i] = e;
        z += e;
    }
    for (let i = 0; i < n; i += 1) x[o + i] /= z;
    return x;
}

// ALiBi slopes for H heads: 2^(−8(h+1)/H).
export function alibiSlopes(H) {
    return Float64Array.from({ length: H }, (_, h) => 2 ** ((-8 * (h + 1)) / H));
}

// One attention head for one query over an explicit key list (window keys, echo keys, global tokens …).
// q at Q[qo..qo+dh); key s's head slice at K[s·stride + ko ..], its value at V[s·stride + vo ..] (K and V may be one
// fused qkv buffer); bias[k] is added to key k's score; the result goes to out[oo..oo+dh). scores: scratch ≥ nKeys.
export function attendHead(Q, qo, K, ko, V, vo, stride, dh, keys, bias, nKeys, scale, out, oo, scores) {
    let max = -Infinity;
    for (let k = 0; k < nKeys; k += 1) {
        const s = dot(Q, qo, K, keys[k] * stride + ko, dh) * scale + bias[k];
        scores[k] = s;
        if (s > max) max = s;
    }
    let z = 0;
    for (let k = 0; k < nKeys; k += 1) {
        const e = Math.exp(scores[k] - max);
        scores[k] = e;
        z += e;
    }
    for (let c = 0; c < dh; c += 1) out[oo + c] = 0;
    for (let k = 0; k < nKeys; k += 1) {
        const p = scores[k] / z;
        const at = keys[k] * stride + vo;
        for (let c = 0; c < dh; c += 1) out[oo + c] += p * V[at + c];
    }
    return out;
}
