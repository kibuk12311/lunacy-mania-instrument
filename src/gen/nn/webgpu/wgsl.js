// WGSL for the nn-v2 infill transformer on WebGPU (ML addendum §11, stream W): the same math as src/gen/nn/kernels.js
// and infillModel.js, in float32 on the GPU. Shaders are generated per model arch so array sizes and the ALiBi slopes
// are compile-time constants. Every weight lives in one packed float32 buffer (`wall`); a kernel gets its tensors as
// element offsets. Plain strings only, no GPU calls here, so the generators are testable without a GPU.

const WG = 256; // invocations of the per-build decoder kernel

// a float32 literal WGSL accepts (always with an exponent, so integers stay floats)
export const f32 = (x) => `${Math.fround(x).toExponential(8)}f`;

const gelu = /* wgsl */ `
fn gelu(v: f32) -> f32 {
    // tanh form, as kernels.js; the argument is clamped because tanh(±10) is ±1 in float32 and some backends give NaN
    // for large |x|
    let a = clamp(0.7978845608028654 * (v + 0.044715 * v * v * v), -10.0, 10.0);
    return 0.5 * v * (1.0 + tanh(a));
}`;

// ALiBi slopes 2^(−8(h+1)/H), as alibiSlopes() in kernels.js
export const slopesOf = (H) => Array.from({ length: H }, (_, h) => 2 ** ((-8 * (h + 1)) / H));
const slopeArray = (H) => `array<f32, ${H}>(${slopesOf(H).map(f32).join(", ")})`;

// Y[n×m] (=|+=) act(X[n×k] · Wᵀ + b), W [m][k] row-major as PyTorch stores a Linear (16×16 tiles in workgroup memory).
// flags: 1 = add the bias, 2 = GELU, 4 = add into Y (the residual stream).
export const LINEAR = /* wgsl */ `
struct P { n: u32, k: u32, m: u32, flags: u32, xOff: u32, yOff: u32, wOff: u32, bOff: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> X: array<f32>;
@group(0) @binding(2) var<storage, read> wall: array<f32>;
@group(0) @binding(3) var<storage, read_write> Y: array<f32>;
var<workgroup> xs: array<array<f32, 16>, 16>;
var<workgroup> ws: array<array<f32, 17>, 16>;
${gelu}
@compute @workgroup_size(16, 16)
fn main(@builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) g: vec3<u32>) {
    let row = g.y * 16u + l.y;
    let col = g.x * 16u + l.x;
    let wr = g.x * 16u + l.y;
    var acc = 0.0;
    let tiles = (p.k + 15u) / 16u;
    for (var t = 0u; t < tiles; t = t + 1u) {
        let kk = t * 16u + l.x;
        var xv = 0.0;
        if (row < p.n && kk < p.k) { xv = X[p.xOff + row * p.k + kk]; }
        xs[l.y][l.x] = xv;
        var wv = 0.0;
        if (wr < p.m && kk < p.k) { wv = wall[p.wOff + wr * p.k + kk]; }
        ws[l.y][l.x] = wv;
        workgroupBarrier();
        for (var q = 0u; q < 16u; q = q + 1u) { acc = acc + xs[l.y][q] * ws[l.x][q]; }
        workgroupBarrier();
    }
    if (row < p.n && col < p.m) {
        var v = acc;
        if ((p.flags & 1u) != 0u) { v = v + wall[p.bOff + col]; }
        if ((p.flags & 2u) != 0u) { v = gelu(v); }
        let at = p.yOff + row * p.m + col;
        if ((p.flags & 4u) != 0u) { Y[at] = Y[at] + v; } else { Y[at] = v; }
    }
}`;

// LayerNorm of `rows` rows of width d (eps 1e-5, two passes like kernels.js), one workgroup of 64 per row.
export const LAYERNORM = /* wgsl */ `
struct P { rows: u32, d: u32, inOff: u32, outOff: u32, gOff: u32, bOff: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> X: array<f32>;
@group(0) @binding(2) var<storage, read> wall: array<f32>;
@group(0) @binding(3) var<storage, read_write> Y: array<f32>;
var<workgroup> red: array<f32, 64>;
fn reduce(li: u32) {
    for (var s = 32u; s > 0u; s = s >> 1u) {
        if (li < s) { red[li] = red[li] + red[li + s]; }
        workgroupBarrier();
    }
}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) g: vec3<u32>) {
    let r = g.x;
    let base = p.inOff + r * p.d;
    var s = 0.0;
    for (var j = li; j < p.d; j = j + 64u) { s = s + X[base + j]; }
    red[li] = s;
    workgroupBarrier();
    reduce(li);
    let mean = red[0] / f32(p.d);
    workgroupBarrier();
    var v = 0.0;
    for (var j = li; j < p.d; j = j + 64u) { let t = X[base + j] - mean; v = v + t * t; }
    red[li] = v;
    workgroupBarrier();
    reduce(li);
    let inv = 1.0 / sqrt(red[0] / f32(p.d) + 1e-5);
    let ob = p.outOff + r * p.d;
    for (var j = li; j < p.d; j = j + 64u) { Y[ob + j] = (X[base + j] - mean) * inv * wall[p.gOff + j] + wall[p.bOff + j]; }
}`;

// The encoder's input: in_proj rows + per present lane (free or mask embedding + lane embedding) + the conditioning
// projection + family, style and source embeddings; then the global tokens. codes[t·8 + l]: 0..15 a visible mask,
// 255 free, 65535 an absent lane.
export function assembleShader({ d, offsets: o }) {
    return /* wgsl */ `
struct P { T: u32, G: u32, style: u32, source: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> inproj: array<f32>;
@group(0) @binding(2) var<storage, read> condp: array<f32>;
@group(0) @binding(3) var<storage, read> codes: array<u32>;
@group(0) @binding(4) var<storage, read> fam: array<u32>;
@group(0) @binding(5) var<storage, read> wall: array<f32>;
@group(0) @binding(6) var<storage, read_write> seq: array<f32>;
const D = ${d}u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x + gid.y * 65535u * 64u;
    if (idx >= (p.T + p.G) * D) { return; }
    let t = idx / D;
    let j = idx % D;
    let sv = wall[${o.style}u + p.style * D + j] + wall[${o.source}u + p.source * D + j];
    if (t < p.T) {
        var v = inproj[t * D + j];
        for (var l = 0u; l < 8u; l = l + 1u) {
            let c = codes[t * 8u + l];
            if (c == 65535u) { continue; }
            if (c == 255u) { v = v + wall[${o.free}u + j]; } else { v = v + wall[${o.mask}u + c * D + j]; }
            v = v + wall[${o.lane}u + l * D + j];
        }
        seq[idx] = v + (condp[t * D + j] + wall[${o.fam}u + fam[t] * D + j] + sv);
    } else {
        let g = t - p.T;
        seq[idx] = wall[${o.glob}u + g * D + j] + condp[p.T * D + j] + sv;
    }
}`;
}

// Encoder self-attention, one invocation per (token, head): window keys (bias −slope·|q−s|), up to 2 echo keys beyond
// the window (bias echo_bias[h]) and the global tokens (bias 0); a global token attends to every beat and global.
// Online softmax (running max), the same result as kernels.js attendHead's two passes.
export function encAttentionShader({ d, H, win, G }) {
    const dh = d / H;
    return /* wgsl */ `
struct P { T: u32, S: u32, echoOff: u32, zero: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> qkv: array<f32>;
@group(0) @binding(2) var<storage, read> echo: array<i32>;
@group(0) @binding(3) var<storage, read> wall: array<f32>;
@group(0) @binding(4) var<storage, read_write> att: array<f32>;
const D = ${d}u;
const H = ${H}u;
const DH = ${dh}u;
const WIN = ${win}i;
const G = ${G}u;
const SLOPES = ${slopeArray(H)};
const SCALE = ${f32(1 / Math.sqrt(dh))};
var<private> acc: array<f32, ${dh}>;
var<private> mx: f32;
var<private> zs: f32;
fn key(qo: u32, ko: u32, bias: f32, dh: u32) {
    var dt = 0.0;
    for (var c = 0u; c < dh; c = c + 1u) { dt = dt + qkv[qo + c] * qkv[ko + c]; }
    let sc = dt * SCALE + bias;
    if (sc > mx) {
        let f = exp(mx - sc);
        zs = zs * f;
        for (var c = 0u; c < dh; c = c + 1u) { acc[c] = acc[c] * f; }
        mx = sc;
    }
    let e = exp(sc - mx);
    zs = zs + e;
    let vo = ko + D;
    for (var c = 0u; c < dh; c = c + 1u) { acc[c] = acc[c] + e * qkv[vo + c]; }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= p.S * H) { return; }
    let q = idx / H;
    let h = idx % H;
    let qo = q * 3u * D + h * DH;
    let hq = h * DH;
    let dh = DH + p.zero;
    mx = -3.0e38;
    zs = 0.0;
    for (var c = 0u; c < dh; c = c + 1u) { acc[c] = 0.0; }
    let T = i32(p.T);
    if (q < p.T) {
        let qi = i32(q);
        let slope = SLOPES[h];
        for (var s = max(0, qi - WIN); s <= min(T - 1, qi + WIN); s = s + 1) {
            key(qo, u32(s) * 3u * D + D + hq, -slope * f32(abs(qi - s)), dh);
        }
        for (var e = 0u; e < 2u; e = e + 1u) {
            let k = echo[q * 2u + e];
            if (k >= 0 && k < T && abs(k - qi) > WIN) { key(qo, u32(k) * 3u * D + D + hq, wall[p.echoOff + h], dh); }
        }
    } else {
        for (var s = 0u; s < p.T; s = s + 1u) { key(qo, s * 3u * D + D + hq, 0.0, dh); }
    }
    for (var g = 0u; g < G; g = g + 1u) { key(qo, (p.T + g) * 3u * D + D + hq, 0.0, dh); }
    let oo = q * D + hq;
    for (var c = 0u; c < dh; c = c + 1u) { att[oo + c] = acc[c] / zs; }
}`;
}


// Per decoder layer, the element offsets of its tensors in wall (at o.layerTable, 18 per layer, each stored as offset / 4,
// which float32 holds exactly up to 2^26 elements; packWeights keeps every tensor 4-aligned).
export const LAYER_TENSORS = ["ln1w", "ln1b", "qkv", "qkvb", "proj", "projb", "ln2w", "ln2b", "cq", "cqb", "cproj", "cprojb", "ln3w", "ln3b", "fc1", "fc1b", "fc2", "fc2b"];
const LT = Object.fromEntries(LAYER_TENSORS.map((name, k) => [name, k]));

// The decoder, one workgroup per build: for n beats from b0 it runs the causal decoder (ring cache of the last R beats
// per layer, cross-attention to the encoder at ±CW) exactly as infillModel.js createDecoder.advance, then writes the
// decoder state z and, per present lane, the lane head's first-layer pre-activation without the history term
// (bias + W·z + W·laneEmb + W·laneValues): `base`. The history (4 rows) is added on the CPU, where the rows are sampled.
// batch: entries first (8 u32 each: slot = the build's ring, b0, n, rowsOff = where in batch the rows of beats
// b0−1 … b0+n−2 are, 8 per beat, outOff = where in outs its n × (DD + 8·HH) floats go), then the rows.
// stat: e2d (T × DD), then the cross-attention K/V per layer (T × 2DD each) at crossOff.
// Matrices are read transposed ([in][out], output index fastest) so reads coalesce. Layers loop at run time and every
// loop bound goes through p.zero, so the D3D shader compiler does not unroll them (an unrolled L decoder took 14 s to
// compile).
export function decoderShader(arch, o) {
    const { dec_d: DD, dec_heads: H, dec_win: R, cross_win: CW, dec_ffn: FFN, dec_layers: LD, lane_hidden: HH } = arch;
    const DH = DD / H;
    const KMAX = Math.max(R, 2 * CW + 1);
    const IN = o.inDim;
    const NV = o.nv;
    const mv = (src, n, m, wOff, bOff, then) => `
    {
        let wo = ${wOff};
        let bo = ${bOff};
        for (var j = tid; j < ${m}; j = j + ${WG}u) {
            var a = wall[bo + j];
            for (var i = 0u; i < ${n}; i = i + 1u) { a = a + wall[wo + i * ${m} + j] * ${src}[i]; }
            ${then}
        }
        workgroupBarrier();
    }`;
    const attend = (qArr, nk, kvBuf, kvAt, dist) => `
    for (var x = tid; x < nh * ${nk}; x = x + ${WG}u) {
        let h = x / ${nk};
        let k = x % ${nk};
        let at = ${kvAt("k")} + h * dh;
        var dt = 0.0;
        for (var c = 0u; c < dh; c = c + 1u) { dt = dt + ${qArr}[h * dh + c] * ${kvBuf}[at + c]; }
        sc[h * KMAX + k] = dt * SCALE - SLOPES[h] * f32(${dist("k")});
    }
    workgroupBarrier();
    if (tid < nh) {
        var m = -3.0e38;
        for (var k = 0u; k < ${nk}; k = k + 1u) { m = max(m, sc[tid * KMAX + k]); }
        var z = 0.0;
        for (var k = 0u; k < ${nk}; k = k + 1u) { let e = exp(sc[tid * KMAX + k] - m); sc[tid * KMAX + k] = e; z = z + e; }
        for (var k = 0u; k < ${nk}; k = k + 1u) { sc[tid * KMAX + k] = sc[tid * KMAX + k] / z; }
    }
    workgroupBarrier();
    for (var x = tid; x < dd; x = x + ${WG}u) {
        let h = x / dh;
        var a = 0.0;
        for (var k = 0u; k < ${nk}; k = k + 1u) { a = a + sc[h * KMAX + k] * ${kvBuf}[${kvAt("k")} + DD + x]; }
        att[x] = a;
    }
    workgroupBarrier();`;
    const w = (name) => `lofs(L, ${LT[name]}u)`;
    return /* wgsl */ `
struct P { T: u32, crossOff: u32, zero: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> batch: array<u32>;
@group(0) @binding(2) var<storage, read> stat: array<f32>;
@group(0) @binding(3) var<storage, read> codes: array<u32>;
@group(0) @binding(4) var<storage, read> xn: array<f32>;
@group(0) @binding(5) var<storage, read> wall: array<f32>;
@group(0) @binding(6) var<storage, read_write> ring: array<f32>;
@group(0) @binding(7) var<storage, read_write> outs: array<f32>;
const DD = ${DD}u;
const DH = ${DH}u;
const R = ${R}u;
const CW = ${CW}u;
const KMAX = ${KMAX}u;
const HH = ${HH}u;
const LD = ${LD}u;
const SLOPES = ${slopeArray(H)};
const SCALE = ${f32(1 / Math.sqrt(DH))};
var<workgroup> u: array<f32, ${DD}>;
var<workgroup> y: array<f32, ${DD}>;
var<workgroup> qkv: array<f32, ${3 * DD}>;
var<workgroup> q: array<f32, ${DD}>;
var<workgroup> att: array<f32, ${DD}>;
var<workgroup> ff: array<f32, ${FFN}>;
var<workgroup> zp: array<f32, ${HH}>;
var<workgroup> sc: array<f32, ${H * KMAX}>;
var<workgroup> red: array<f32, ${WG}>;
var<workgroup> eSlot: u32;
var<workgroup> eB0: u32;
var<workgroup> eN: u32;
var<workgroup> eRows: u32;
var<workgroup> eOut: u32;
${gelu}
fn lofs(L: u32, k: u32) -> u32 { return u32(wall[${o.layerTable}u + L * ${LAYER_TENSORS.length}u + k]) * 4u; }
fn reduce(tid: u32) {
    for (var s = ${WG / 2}u; s > 0u; s = s >> 1u) {
        if (tid < s) { red[tid] = red[tid] + red[tid + s]; }
        workgroupBarrier();
    }
}
// y = LayerNorm(u) with gain and bias at gOff / bOff
fn layerNormU(tid: u32, dd: u32, gOff: u32, bOff: u32) {
    var s = 0.0;
    for (var j = tid; j < dd; j = j + ${WG}u) { s = s + u[j]; }
    red[tid] = s;
    workgroupBarrier();
    reduce(tid);
    let mean = red[0] / f32(dd);
    workgroupBarrier();
    var v = 0.0;
    for (var j = tid; j < dd; j = j + ${WG}u) { let t = u[j] - mean; v = v + t * t; }
    red[tid] = v;
    workgroupBarrier();
    reduce(tid);
    let inv = 1.0 / sqrt(red[0] / f32(dd) + 1e-5);
    for (var j = tid; j < dd; j = j + ${WG}u) { y[j] = (u[j] - mean) * inv * wall[gOff + j] + wall[bOff + j]; }
    workgroupBarrier();
}
fn ringAt(slot: u32, L: u32, r: u32) -> u32 { return ((slot * LD + L) * R + r) * 2u * DD; }
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_index) tid: u32, @builtin(workgroup_id) wid: vec3<u32>) {
    if (tid == 0u) {
        let e = wid.x * 8u;
        eSlot = batch[e];
        eB0 = batch[e + 1u];
        eN = batch[e + 2u];
        eRows = batch[e + 3u];
        eOut = batch[e + 4u];
    }
    let slot = workgroupUniformLoad(&eSlot);
    let b0 = workgroupUniformLoad(&eB0);
    let n = workgroupUniformLoad(&eN);
    let rowsOff = workgroupUniformLoad(&eRows);
    let outOff = workgroupUniformLoad(&eOut);
    let z0 = p.zero;
    let dd = DD + z0;
    let dd2 = 2u * DD + z0;
    let dd3 = 3u * DD + z0;
    let ffn = ${FFN}u + z0;
    let hh = HH + z0;
    let dh = DH + z0;
    let nh = ${H}u + z0;
    let nl = LD + z0;
    let nv = ${NV}u + z0;
    let lanes = 8u + z0;
    for (var k = 0u; k < n; k = k + 1u) {
        let b = b0 + k;
        let lo = select(0u, b + 1u - R, b + 1u > R);
        let nkSelf = b + 1u - lo;
        let clo = select(0u, b - CW, b > CW);
        let chi = min(p.T - 1u, b + CW);
        let nkCross = chi + 1u - clo;
        // the input: e2d of this beat + the embedding of the previous beat's rows (bos on the first beat)
        for (var j = tid; j < dd; j = j + ${WG}u) {
            var v = stat[b * DD + j];
            if (b == 0u) {
                v = v + wall[${o.bos}u + j];
            } else {
                for (var l = 0u; l < lanes; l = l + 1u) {
                    if (codes[(b - 1u) * 8u + l] == 65535u) { continue; }
                    v = v + wall[${o.decMask}u + batch[rowsOff + k * 8u + l] * DD + j];
                    v = v + wall[${o.decLane}u + l * DD + j];
                }
            }
            u[j] = v;
        }
        workgroupBarrier();
        for (var L = 0u; L < nl; L = L + 1u) {
            layerNormU(tid, dd, ${w("ln1w")}, ${w("ln1b")});
            ${mv("y", "dd", "dd3", w("qkv"), w("qkvb"), "qkv[j] = a;")}
            let rb = ringAt(slot, L, b % R);
            for (var c = tid; c < dd2; c = c + ${WG}u) { ring[rb + c] = qkv[DD + c]; }
            storageBarrier();
            workgroupBarrier();
            ${attend("qkv", "nkSelf", "ring", (kk) => `ringAt(slot, L, (lo + ${kk}) % R)`, (kk) => `nkSelf - 1u - ${kk}`)}
            ${mv("att", "dd", "dd", w("proj"), w("projb"), "u[j] = u[j] + a;")}
            layerNormU(tid, dd, ${w("ln2w")}, ${w("ln2b")});
            ${mv("y", "dd", "dd", w("cq"), w("cqb"), "q[j] = a;")}
            ${attend("q", "nkCross", "stat", (kk) => `p.crossOff + (L * p.T + clo + ${kk}) * 2u * DD`, (kk) => `u32(abs(i32(clo + ${kk}) - i32(b)))`)}
            ${mv("att", "dd", "dd", w("cproj"), w("cprojb"), "u[j] = u[j] + a;")}
            layerNormU(tid, dd, ${w("ln3w")}, ${w("ln3b")});
            ${mv("y", "dd", "ffn", w("fc1"), w("fc1b"), "ff[j] = gelu(a);")}
            ${mv("ff", "ffn", "dd", w("fc2"), w("fc2b"), "u[j] = u[j] + a;")}
        }
        // ---- z = dec_ln(u), then the lane head's first layer without the history ----
        layerNormU(tid, dd, ${o.decLnW}u, ${o.decLnB}u);
        let ob = outOff + k * (DD + 8u * HH);
        for (var j = tid; j < dd; j = j + ${WG}u) { outs[ob + j] = y[j]; }
        ${mv("y", "dd", "hh", `${o.h1z}u`, `${o.h1b}u`, "zp[j] = a;")}
        for (var x = tid; x < lanes * hh; x = x + ${WG}u) {
            let l = x / hh;
            let j = x % hh;
            var a = 0.0;
            if (codes[b * 8u + l] != 65535u) {
                a = zp[j] + wall[${o.h1le}u + l * HH + j];
                let xo = b * ${IN}u + l * ${NV}u;
                for (var c = 0u; c < nv; c = c + 1u) { a = a + wall[${o.h1v}u + c * HH + j] * xn[xo + c]; }
            }
            outs[ob + DD + x] = a;
        }
        workgroupBarrier();
    }
}`;
}
