// A dense, float64, all-beats-at-once nn-v2 forward written straight from the PyTorch module (tools/nn/infill_model.py),
// with none of the inference code's tricks (no key lists, no ring cache, no incremental decode). Tests compare the
// real JS path against it.
const IN = 145;
const NV = 12;
const PRESENT = 11;
const DIVS = [4, 3, 6, 8];

const gelu = (v) => 0.5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + 0.044715 * v ** 3)));
function linear(W, b, x, inDim, outDim) {
    const y = new Float64Array(outDim);
    for (let o = 0; o < outDim; o += 1) {
        let s = b ? b[o] : 0;
        for (let i = 0; i < inDim; i += 1) s += W[o * inDim + i] * x[i];
        y[o] = s;
    }
    return y;
}
function ln(x, g, b) {
    const n = x.length;
    const mean = x.reduce((a, v) => a + v, 0) / n;
    const v = x.reduce((a, t) => a + (t - mean) ** 2, 0) / n;
    return Float64Array.from(x, (t, i) => ((t - mean) / Math.sqrt(v + 1e-5)) * g[i] + b[i]);
}
const row = (M, r, n) => Float64Array.from(M.subarray ? M.subarray(r * n, (r + 1) * n) : M.slice(r * n, (r + 1) * n));
const add = (a, b) => Float64Array.from(a, (v, i) => v + b[i]);
const slopes = (H) => Array.from({ length: H }, (_, h) => 2 ** ((-8 * (h + 1)) / H));

// multi-head attention of queries Q (n×D) over keys/values K, V (m×D) with bias(h, q, k) (−Infinity = not allowed)
function mha(Q, K, V, H, bias) {
    const D = Q[0].length;
    const dh = D / H;
    return Q.map((q, qi) => {
        const out = new Float64Array(D);
        for (let h = 0; h < H; h += 1) {
            const sc = K.map((k, ki) => {
                let s = 0;
                for (let c = 0; c < dh; c += 1) s += q[h * dh + c] * k[h * dh + c];
                return s / Math.sqrt(dh) + bias(h, qi, ki);
            });
            const max = Math.max(...sc);
            const e = sc.map((s) => Math.exp(s - max));
            const z = e.reduce((a, v) => a + v, 0);
            e.forEach((p, ki) => { for (let c = 0; c < dh; c += 1) out[h * dh + c] += (p / z) * V[ki][h * dh + c]; });
        }
        return out;
    });
}

function cond(dan, dk, msd, rate) {
    const c = new Float64Array(27);
    for (let k = 0; k < 8; k += 1) {
        const a = (2 * Math.PI * dan) / (40 / 2 ** (k / 2));
        c[k] = dk ? Math.sin(a) : 0;
        c[8 + k] = dk ? Math.cos(a) : 0;
    }
    c[16] = dk ? 1 : 0;
    for (let k = 0; k < 8; k += 1) c[17 + k] = msd ? msd[k] / 20 : 0;
    c[25] = msd ? 1 : 0;
    c[26] = rate - 1;
    return c;
}

export function referenceLogits(net, inp, rows) {
    const { arch: a, W } = net;
    const { T } = inp;
    const d = a.d;
    const dd = a.dec_d;
    const G = a.n_glob;
    const present = (t, l) => inp.x[t * IN + l * NV + PRESENT] > 0.5;
    const xn = Array.from({ length: T }, (_, t) => Float64Array.from({ length: IN }, (_, c) => (inp.x[t * IN + c] - net.mean[c]) * net.inv[c]));
    const style = row(W["style_emb.weight"], inp.style, d);
    const source = row(W["source_emb.weight"], inp.source, d);
    let seq = xn.map((x, t) => {
        let h = linear(W["in_proj.weight"], W["in_proj.bias"], x, IN, d);
        for (let l = 0; l < 8; l += 1) {
            if (!present(t, l)) continue;
            const v = inp.visible[t * 8 + l];
            h = add(h, v === 255 ? Float64Array.from(W.free_emb) : row(W["mask_emb.weight"], v, d));
            h = add(h, row(W["lane_emb.weight"], l, d));
        }
        h = add(h, linear(W["cond_proj.weight"], W["cond_proj.bias"], cond(inp.dan[t], inp.danKnown, inp.msd, inp.rate), 27, d));
        return add(add(add(h, row(W["fam_emb.weight"], inp.fam[t], d)), style), source);
    });
    const danMean = Array.from(inp.dan).reduce((s, v) => s + v, 0) / T;
    const cg = linear(W["cond_proj.weight"], W["cond_proj.bias"], cond(danMean, inp.danKnown, inp.msd, inp.rate), 27, d);
    for (let g = 0; g < G; g += 1) seq.push(add(add(add(row(W.glob_emb, g, d), cg), style), source));
    const es = slopes(a.enc_heads);
    const isEcho = (q, k) => q < T && k < T && Math.abs(q - k) > a.win && (inp.echo[q * 2] === k || inp.echo[q * 2 + 1] === k);
    for (let L = 0; L < a.enc_layers; L += 1) {
        const p = `enc.${L}`;
        const y = seq.map((s) => ln(s, W[`${p}.ln1.weight`], W[`${p}.ln1.bias`]));
        const qkv = y.map((v) => linear(W[`${p}.qkv.weight`], W[`${p}.qkv.bias`], v, d, 3 * d));
        const Q = qkv.map((v) => v.slice(0, d));
        const K = qkv.map((v) => v.slice(d, 2 * d));
        const V = qkv.map((v) => v.slice(2 * d));
        const att = mha(Q, K, V, a.enc_heads, (h, q, k) => {
            if (q >= T || k >= T) return 0;
            if (Math.abs(q - k) <= a.win) return -es[h] * Math.abs(q - k);
            return isEcho(q, k) ? W[`${p}.echo_bias`][h] : -Infinity;
        });
        seq = seq.map((s, i) => add(s, linear(W[`${p}.proj.weight`], W[`${p}.proj.bias`], att[i], d, d)));
        seq = seq.map((s) => {
            const f = linear(W[`${p}.fc1.weight`], W[`${p}.fc1.bias`], ln(s, W[`${p}.ln2.weight`], W[`${p}.ln2.bias`]), d, a.enc_ffn).map(gelu);
            return add(s, linear(W[`${p}.fc2.weight`], W[`${p}.fc2.bias`], f, a.enc_ffn, d));
        });
    }
    const enc = seq.slice(0, T).map((s) => ln(s, W["enc_ln.weight"], W["enc_ln.bias"]));
    // decoder, all beats at once
    const rowsEmb = (b) => {
        let e = new Float64Array(dd);
        for (let l = 0; l < 8; l += 1) {
            if (!present(b, l)) continue;
            e = add(add(e, row(W["dec_mask_emb.weight"], rows[b * 8 + l], dd)), row(W["dec_lane_emb.weight"], l, dd));
        }
        return e;
    };
    let u = enc.map((e, b) => add(linear(W["e2d.weight"], W["e2d.bias"], e, d, dd), b === 0 ? Float64Array.from(W.bos) : rowsEmb(b - 1)));
    const ds = slopes(a.dec_heads);
    for (let L = 0; L < a.dec_layers; L += 1) {
        const p = `dec.${L}`;
        const qkv = u.map((v) => linear(W[`${p}.qkv.weight`], W[`${p}.qkv.bias`], ln(v, W[`${p}.ln1.weight`], W[`${p}.ln1.bias`]), dd, 3 * dd));
        const att = mha(qkv.map((v) => v.slice(0, dd)), qkv.map((v) => v.slice(dd, 2 * dd)), qkv.map((v) => v.slice(2 * dd)), a.dec_heads,
            (h, q, k) => (k <= q && q - k < a.dec_win ? -ds[h] * (q - k) : -Infinity));
        u = u.map((v, i) => add(v, linear(W[`${p}.proj.weight`], W[`${p}.proj.bias`], att[i], dd, dd)));
        const cq = u.map((v) => linear(W[`${p}.cq.weight`], W[`${p}.cq.bias`], ln(v, W[`${p}.ln2.weight`], W[`${p}.ln2.bias`]), dd, dd));
        const kv = enc.map((e) => linear(W[`${p}.ckv.weight`], W[`${p}.ckv.bias`], e, d, 2 * dd));
        const catt = mha(cq, kv.map((v) => v.slice(0, dd)), kv.map((v) => v.slice(dd)), a.dec_heads,
            (h, q, k) => (Math.abs(q - k) <= a.cross_win ? -ds[h] * Math.abs(q - k) : -Infinity));
        u = u.map((v, i) => add(v, linear(W[`${p}.cproj.weight`], W[`${p}.cproj.bias`], catt[i], dd, dd)));
        u = u.map((v) => {
            const f = linear(W[`${p}.fc1.weight`], W[`${p}.fc1.bias`], ln(v, W[`${p}.ln3.weight`], W[`${p}.ln3.bias`]), dd, a.dec_ffn).map(gelu);
            return add(v, linear(W[`${p}.fc2.weight`], W[`${p}.fc2.bias`], f, a.dec_ffn, dd));
        });
    }
    const z = u.map((v) => ln(v, W["dec_ln.weight"], W["dec_ln.bias"]));
    // lane head with a naive history
    const out = new Float64Array(T * 8 * 16);
    const seen = [];
    const hh = a.lane_hidden;
    const le = a.lane_emb;
    for (let b = 0; b < T; b += 1) {
        const dv = DIVS[inp.div[b]];
        for (let l = 0; l < 8; l += 1) {
            if (!present(b, l)) continue;
            const pos = b + l / dv;
            const hist = new Float64Array(68);
            const recent = seen.slice(-4).reverse();
            for (let k = 0; k < 4; k += 1) {
                if (k < recent.length) {
                    hist[17 * k + recent[k][0]] = 1;
                    hist[17 * k + 16] = Math.min(pos - recent[k][1], 4) / 4;
                } else hist[17 * k + 16] = 1;
            }
            const x = Float64Array.from([...z[b], ...row(W["head_lane_emb.weight"], l, le), ...hist, ...xn[b].slice(l * NV, (l + 1) * NV)]);
            const h1 = linear(W["head1.weight"], W["head1.bias"], x, x.length, hh).map(gelu);
            const h2 = linear(W["head2.weight"], W["head2.bias"], h1, hh, hh).map(gelu);
            out.set(linear(W["head3.weight"], W["head3.bias"], h2, hh, 16), (b * 8 + l) * 16);
            if (rows[b * 8 + l]) seen.push([rows[b * 8 + l], pos]);
        }
    }
    return out;
}
