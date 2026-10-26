// nn-v2: the infill transformer (ML addendum §4.4, §5), plain JS, as a row source (plan §2.7).
//
//   infillSource.prepare({ model, audio, slots, dan, family, known?, cond?, structure? })
//     → { step(i, offset, ctx, rngs, weightOf, fixed?) → mask, begin(), snapshot(), restore(s), stats }
//   infillSource.caps = { infill: true }
//
// Tokens are beats. prepare builds the beat inputs (8 slot lanes × 12 values, 45 beat features, the divisor one-hot),
// adds the visible chart (`known`: per slot 255 = free, else the locked mask) and the conditions, and runs the
// bidirectional encoder once; it also precomputes the decoder's cross-attention K/V. step(i) decides slot i:
//   - a `known` slot, or a `fixed` mask (0..15, the 6th argument: echo rows, rows decided outside the source), is
//     returned unchanged and teacher-forced into the decoder, with no RNG use;
//   - otherwise the lane head gives 16 logits (0 = no row, k = the row with column mask k); logits[0] −= offset
//     (knob + adjust, as nn-v1); one rngs.fill() draw decides row / no row, then log weightOf(mask) is added to the
//     row logits (weight 0 → −∞) and one rngs.pattern() draw picks the row; all rows vetoed → weightOf.fallback().
//     So the guard never changes the density, as with the XGB source.
// Slots must be stepped in increasing order within one build. begin() starts a new build (rows decided so far are
// forgotten); a step below the last decided slot also starts one. Slots skipped inside a build count as their known
// mask, else as empty — rows decided outside the source should be passed as `fixed` so the decoder sees them.
// snapshot()/restore(s) copy the decoder's ring caches and the rows, so one block or part can be re-decoded from its
// start. The math matches tools/nn/infill_model.py (tests/fixtures/infill-parity.json, ≤ 2e-3).
import { decodeF16, encodeF16 } from "./f16.js";
import { linearRows, matvec, layerNorm, geluInPlace, softmaxInPlace, attendHead, alibiSlopes } from "./kernels.js";
import { slotFeatures, AUDIO_FEATURES_V2 } from "../slotFeatures.js";
import { beatFeatures } from "../snap.js";
import { BEAT_FEATURES_V3, beatFeaturesV3 } from "../beatFeatures.js";
import { barsOf } from "../songParts.js";
import { mulberry32 } from "../rng.js";

export const N_LANES = 8;
export const LANE_VALUES = ["onset", "low", "mid", "high", "kick", "snare", "hat", "harm", "perc_share", "energy", "phase", "present"];
export { BEAT_FEATURES_V3 }; // src/gen/beatFeatures.js: the one list the dataset builder and this source share
export const DIV_CLASSES = [4, 3, 6, 8];
export const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
export const SOURCES = ["unknown", "osu", "etterna", "malody"];
const NV = LANE_VALUES.length; // 12
const LANE_IN = N_LANES * NV; // 96
export const IN_DIM = LANE_IN + BEAT_FEATURES_V3.length + DIV_CLASSES.length; // 145
const PRESENT = LANE_VALUES.indexOf("present");
const N_CLASSES = 16;
const N_HIST = 4;
const HIST_DIM = 17;
const HIST_LEN = N_HIST * HIST_DIM;
const GAP_CLIP = 4;
const COND_DIM = 27;
const MSD_SCALE = 20;
const FREE = 255;
const DAN_PERIODS = Array.from({ length: 8 }, (_, k) => 40 / 2 ** (k / 2));

export const ARCH_DEFAULTS = { lane_emb: 16, win: 32, dec_win: 32, cross_win: 32, n_glob: 4, n_styles: 1, n_sources: SOURCES.length };

const prod = (shape) => shape.reduce((a, b) => a * b, 1);

// Every exported tensor and its shape, named as in the PyTorch state_dict (Linear weights are [out, in]).
export function infillShapes(archIn) {
    const a = { ...ARCH_DEFAULTS, ...archIn };
    const { d, dec_d: dd, enc_ffn: ef, dec_ffn: df, lane_hidden: hh, lane_emb: le } = a;
    const s = {
        "in_proj.weight": [d, IN_DIM], "in_proj.bias": [d],
        "mask_emb.weight": [N_CLASSES, d], free_emb: [d], "lane_emb.weight": [N_LANES, d],
        "cond_proj.weight": [d, COND_DIM], "cond_proj.bias": [d],
        "fam_emb.weight": [FAMILIES.length + 1, d], "style_emb.weight": [a.n_styles, d], "source_emb.weight": [a.n_sources, d],
        glob_emb: [a.n_glob, d],
    };
    const ln = (p, n) => { s[`${p}.weight`] = [n]; s[`${p}.bias`] = [n]; };
    const lin = (p, o, i) => { s[`${p}.weight`] = [o, i]; s[`${p}.bias`] = [o]; };
    for (let l = 0; l < a.enc_layers; l += 1) {
        const p = `enc.${l}`;
        ln(`${p}.ln1`, d); lin(`${p}.qkv`, 3 * d, d); lin(`${p}.proj`, d, d); ln(`${p}.ln2`, d);
        lin(`${p}.fc1`, ef, d); lin(`${p}.fc2`, d, ef); s[`${p}.echo_bias`] = [a.enc_heads];
    }
    ln("enc_ln", d);
    lin("e2d", dd, d);
    s["dec_mask_emb.weight"] = [N_CLASSES, dd];
    s["dec_lane_emb.weight"] = [N_LANES, dd];
    s.bos = [dd];
    for (let l = 0; l < a.dec_layers; l += 1) {
        const p = `dec.${l}`;
        ln(`${p}.ln1`, dd); lin(`${p}.qkv`, 3 * dd, dd); lin(`${p}.proj`, dd, dd); ln(`${p}.ln2`, dd);
        lin(`${p}.cq`, dd, dd); lin(`${p}.ckv`, 2 * dd, d); lin(`${p}.cproj`, dd, dd); ln(`${p}.ln3`, dd);
        lin(`${p}.fc1`, df, dd); lin(`${p}.fc2`, dd, df);
    }
    ln("dec_ln", dd);
    s["head_lane_emb.weight"] = [N_LANES, le];
    lin("head1", hh, dd + le + HIST_LEN + NV);
    lin("head2", hh, hh);
    lin("head3", N_CLASSES, hh);
    return s;
}

const loaded = new WeakMap();

// The model JSON → decoded float32 weights (once per model object).
export function loadInfill(model) {
    if (loaded.has(model)) return loaded.get(model);
    if (model?.kind !== "nn-v2") throw new Error(`not an nn-v2 model: ${model?.kind}`);
    const arch = { ...ARCH_DEFAULTS, ...model.arch };
    const W = {};
    for (const [name, shape] of Object.entries(infillShapes(arch))) {
        const t = model.weights?.[name];
        if (!t) throw new Error(`nn-v2 model: missing weight ${name}`);
        const v = decodeF16(t.f16, t.scale ?? 1);
        if (v.length !== prod(shape)) throw new Error(`nn-v2 model: ${name} has ${v.length} values, expected ${shape.join("×")}`);
        W[name] = v;
    }
    const mean = Float32Array.from(model.norm?.mean ?? new Array(IN_DIM).fill(0));
    const inv = Float32Array.from(model.norm?.inv ?? new Array(IN_DIM).fill(1));
    if (mean.length !== IN_DIM || inv.length !== IN_DIM) throw new Error("nn-v2 model: norm must have 145 values");
    const net = {
        arch, W, mean, inv,
        families: arch.families ?? FAMILIES,
        sources: arch.sources ?? SOURCES,
        styles: model.styles ?? [],
        encSlopes: alibiSlopes(arch.enc_heads),
        decSlopes: alibiSlopes(arch.dec_heads),
    };
    loaded.set(model, net);
    return net;
}

function condVector(out, dan, danKnown, msd, msdKnown, rate) {
    for (let k = 0; k < 8; k += 1) {
        const a = (2 * Math.PI * dan) / DAN_PERIODS[k];
        out[k] = danKnown ? Math.sin(a) : 0;
        out[8 + k] = danKnown ? Math.cos(a) : 0;
    }
    out[16] = danKnown ? 1 : 0;
    for (let k = 0; k < 8; k += 1) out[17 + k] = msdKnown ? msd[k] / MSD_SCALE : 0;
    out[25] = msdKnown ? 1 : 0;
    out[26] = rate - 1;
    return out;
}

const addInto = (dst, dOff, src, sOff, n) => {
    for (let j = 0; j < n; j += 1) dst[dOff + j] += src[sOff + j];
};

export const infillStats = { encodes: 0 };

// The encoder over a song's beats. inp = { T, x (T×145 raw), visible (T×8, 255 = free), fam (T), dan (T),
// danKnown, msd (8) | null, style (embedding index), source (embedding index), rate, echo (T×2, −1 = none) }.
export function encodeBeats(net, inp) {
    infillStats.encodes += 1;
    const { arch, W } = net;
    const d = arch.d;
    const T = inp.T;
    const inRange = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
    if (!inRange(inp.style, arch.n_styles) || !inRange(inp.source, arch.n_sources)) throw new Error(`nn-v2: style ${inp.style} / source ${inp.source} out of range`);
    for (let t = 0; t < T; t += 1) if (!inRange(inp.fam[t], FAMILIES.length + 1)) throw new Error(`nn-v2: family ${inp.fam[t]} out of range`);
    const G = arch.n_glob;
    const S = T + G;
    const H = arch.enc_heads;
    const dh = d / H;
    const win = arch.win;
    const xn = new Float32Array(T * IN_DIM);
    for (let t = 0; t < T; t += 1) {
        for (let c = 0; c < IN_DIM; c += 1) xn[t * IN_DIM + c] = (inp.x[t * IN_DIM + c] - net.mean[c]) * net.inv[c];
    }
    const seq = new Float32Array(S * d);
    linearRows(xn, T, W["in_proj.weight"], W["in_proj.bias"], IN_DIM, d, seq);
    const maskE = W["mask_emb.weight"];
    const laneE = W["lane_emb.weight"];
    const free = W.free_emb;
    for (let t = 0; t < T; t += 1) {
        for (let l = 0; l < N_LANES; l += 1) {
            if (!(inp.x[t * IN_DIM + l * NV + PRESENT] > 0.5)) continue;
            const v = inp.visible[t * N_LANES + l];
            if (v === FREE) addInto(seq, t * d, free, 0, d);
            else addInto(seq, t * d, maskE, v * d, d);
            addInto(seq, t * d, laneE, l * d, d);
        }
    }
    const msdKnown = inp.msd ? 1 : 0;
    const c = new Float64Array(COND_DIM);
    const tmp = new Float32Array(d);
    const condW = W["cond_proj.weight"];
    const condB = W["cond_proj.bias"];
    const famE = W["fam_emb.weight"];
    const styleE = W["style_emb.weight"];
    const sourceE = W["source_emb.weight"];
    const so = inp.style * d;
    const ro = inp.source * d;
    let danSum = 0;
    for (let t = 0; t < T; t += 1) {
        danSum += inp.dan[t];
        condVector(c, inp.dan[t], inp.danKnown, inp.msd, msdKnown, inp.rate);
        matvec(condW, c, 0, d, COND_DIM, tmp, 0, condB);
        const fo = inp.fam[t] * d;
        for (let j = 0; j < d; j += 1) seq[t * d + j] += tmp[j] + famE[fo + j] + styleE[so + j] + sourceE[ro + j];
    }
    condVector(c, T ? danSum / T : 0, inp.danKnown, inp.msd, msdKnown, inp.rate);
    matvec(condW, c, 0, d, COND_DIM, tmp, 0, condB);
    const globE = W.glob_emb;
    for (let g = 0; g < G; g += 1) {
        for (let j = 0; j < d; j += 1) seq[(T + g) * d + j] = globE[g * d + j] + tmp[j] + styleE[so + j] + sourceE[ro + j];
    }
    // layers
    const ffn = arch.enc_ffn;
    const y = new Float32Array(S * d);
    const qkv = new Float32Array(S * 3 * d);
    const att = new Float32Array(S * d);
    const ff = new Float32Array(S * ffn);
    const res = new Float32Array(S * d);
    const maxKeys = Math.max(2 * win + 1 + 2 + G, T + G);
    const keys = new Int32Array(maxKeys);
    const kind = new Int8Array(maxKeys); // 0 window (bias −slope·dist), 1 echo, 2 global
    const dist = new Float64Array(maxKeys);
    const bias = new Float64Array(maxKeys);
    const scores = new Float64Array(maxKeys);
    const scale = 1 / Math.sqrt(dh);
    for (let L = 0; L < arch.enc_layers; L += 1) {
        const p = `enc.${L}`;
        for (let s = 0; s < S; s += 1) layerNorm(seq, s * d, d, W[`${p}.ln1.weight`], W[`${p}.ln1.bias`], y, s * d);
        linearRows(y, S, W[`${p}.qkv.weight`], W[`${p}.qkv.bias`], d, 3 * d, qkv);
        const echoBias = W[`${p}.echo_bias`];
        for (let q = 0; q < S; q += 1) {
            let n = 0;
            if (q < T) {
                for (let s = Math.max(0, q - win); s <= Math.min(T - 1, q + win); s += 1) {
                    keys[n] = s;
                    kind[n] = 0;
                    dist[n] = Math.abs(q - s);
                    n += 1;
                }
                for (let e = 0; e < 2; e += 1) {
                    const k = inp.echo[q * 2 + e];
                    if (k >= 0 && k < T && Math.abs(k - q) > win) {
                        keys[n] = k;
                        kind[n] = 1;
                        n += 1;
                    }
                }
            } else {
                for (let s = 0; s < T; s += 1) {
                    keys[n] = s;
                    kind[n] = 2;
                    n += 1;
                }
            }
            for (let g = 0; g < G; g += 1) {
                keys[n] = T + g;
                kind[n] = 2;
                n += 1;
            }
            for (let h = 0; h < H; h += 1) {
                const slope = net.encSlopes[h];
                for (let k = 0; k < n; k += 1) bias[k] = kind[k] === 0 ? -slope * dist[k] : kind[k] === 1 ? echoBias[h] : 0;
                attendHead(qkv, q * 3 * d + h * dh, qkv, d + h * dh, qkv, 2 * d + h * dh, 3 * d, dh, keys, bias, n, scale, att, q * d + h * dh, scores);
            }
        }
        linearRows(att, S, W[`${p}.proj.weight`], W[`${p}.proj.bias`], d, d, res);
        for (let i = 0; i < S * d; i += 1) seq[i] += res[i];
        for (let s = 0; s < S; s += 1) layerNorm(seq, s * d, d, W[`${p}.ln2.weight`], W[`${p}.ln2.bias`], y, s * d);
        linearRows(y, S, W[`${p}.fc1.weight`], W[`${p}.fc1.bias`], d, ffn, ff);
        geluInPlace(ff, 0, S * ffn);
        linearRows(ff, S, W[`${p}.fc2.weight`], W[`${p}.fc2.bias`], ffn, d, res);
        for (let i = 0; i < S * d; i += 1) seq[i] += res[i];
    }
    const out = new Float32Array(T * d);
    for (let t = 0; t < T; t += 1) layerNorm(seq, t * d, d, W["enc_ln.weight"], W["enc_ln.bias"], out, t * d);
    return { T, d, out, xn };
}

// The causal decoder over beats with a ring cache of the last dec_win beats per layer, plus the lane head.
// advance(prevRows, prevOff) decodes the next beat from the rows of the beat before it (prevRows[prevOff + lane],
// present lanes only; null for the first beat); laneLogits(lane, hist, out) → the 16 logits of a slot of that beat.
export function createDecoder(net, enc, inp) {
    const { arch, W } = net;
    const T = enc.T;
    const d = arch.d;
    const dd = arch.dec_d;
    const H = arch.dec_heads;
    const dh = dd / H;
    const R = arch.dec_win;
    const CW = arch.cross_win;
    const ffn = arch.dec_ffn;
    const hh = arch.lane_hidden;
    const le = arch.lane_emb;
    const LD = arch.dec_layers;
    const e2d = linearRows(enc.out, T, W["e2d.weight"], W["e2d.bias"], d, dd);
    const cross = Array.from({ length: LD }, (_, l) => linearRows(enc.out, T, W[`dec.${l}.ckv.weight`], W[`dec.${l}.ckv.bias`], d, 2 * dd));
    let ring = Array.from({ length: LD }, () => new Float32Array(R * 2 * dd));
    let z = new Float32Array(dd);
    let beat = 0;
    const u = new Float32Array(dd);
    const y = new Float32Array(dd);
    const qkv = new Float32Array(3 * dd);
    const q = new Float32Array(dd);
    const att = new Float32Array(dd);
    const tmp = new Float32Array(dd);
    const ff = new Float32Array(ffn);
    const nk = Math.max(R, 2 * CW + 1);
    const keys = new Int32Array(nk);
    const dist = new Float64Array(nk);
    const bias = new Float64Array(nk);
    const scores = new Float64Array(nk);
    const scale = 1 / Math.sqrt(dh);
    const headIn = new Float32Array(dd + le + HIST_LEN + NV);
    const h1 = new Float32Array(hh);
    const h2 = new Float32Array(hh);
    const presentAt = (b, l) => inp.x[b * IN_DIM + l * NV + PRESENT] > 0.5;

    function advance(prevRows, prevOff = 0) {
        const b = beat;
        for (let j = 0; j < dd; j += 1) u[j] = e2d[b * dd + j];
        if (b === 0 || !prevRows) {
            addInto(u, 0, W.bos, 0, dd);
        } else {
            for (let l = 0; l < N_LANES; l += 1) {
                if (!presentAt(b - 1, l)) continue;
                addInto(u, 0, W["dec_mask_emb.weight"], prevRows[prevOff + l] * dd, dd);
                addInto(u, 0, W["dec_lane_emb.weight"], l * dd, dd);
            }
        }
        for (let L = 0; L < LD; L += 1) {
            const p = `dec.${L}`;
            const cache = ring[L];
            layerNorm(u, 0, dd, W[`${p}.ln1.weight`], W[`${p}.ln1.bias`], y, 0);
            matvec(W[`${p}.qkv.weight`], y, 0, 3 * dd, dd, qkv, 0, W[`${p}.qkv.bias`]);
            cache.set(qkv.subarray(dd, 3 * dd), (b % R) * 2 * dd);
            let n = 0;
            for (let s = Math.max(0, b - R + 1); s <= b; s += 1) {
                keys[n] = s % R;
                dist[n] = b - s;
                n += 1;
            }
            for (let h = 0; h < H; h += 1) {
                for (let k = 0; k < n; k += 1) bias[k] = -net.decSlopes[h] * dist[k];
                attendHead(qkv, h * dh, cache, h * dh, cache, dd + h * dh, 2 * dd, dh, keys, bias, n, scale, att, h * dh, scores);
            }
            matvec(W[`${p}.proj.weight`], att, 0, dd, dd, tmp, 0, W[`${p}.proj.bias`]);
            addInto(u, 0, tmp, 0, dd);
            layerNorm(u, 0, dd, W[`${p}.ln2.weight`], W[`${p}.ln2.bias`], y, 0);
            matvec(W[`${p}.cq.weight`], y, 0, dd, dd, q, 0, W[`${p}.cq.bias`]);
            n = 0;
            for (let s = Math.max(0, b - CW); s <= Math.min(T - 1, b + CW); s += 1) {
                keys[n] = s;
                dist[n] = Math.abs(b - s);
                n += 1;
            }
            const kv = cross[L];
            for (let h = 0; h < H; h += 1) {
                for (let k = 0; k < n; k += 1) bias[k] = -net.decSlopes[h] * dist[k];
                attendHead(q, h * dh, kv, h * dh, kv, dd + h * dh, 2 * dd, dh, keys, bias, n, scale, att, h * dh, scores);
            }
            matvec(W[`${p}.cproj.weight`], att, 0, dd, dd, tmp, 0, W[`${p}.cproj.bias`]);
            addInto(u, 0, tmp, 0, dd);
            layerNorm(u, 0, dd, W[`${p}.ln3.weight`], W[`${p}.ln3.bias`], y, 0);
            matvec(W[`${p}.fc1.weight`], y, 0, ffn, dd, ff, 0, W[`${p}.fc1.bias`]);
            geluInPlace(ff, 0, ffn);
            matvec(W[`${p}.fc2.weight`], ff, 0, dd, ffn, tmp, 0, W[`${p}.fc2.bias`]);
            addInto(u, 0, tmp, 0, dd);
        }
        layerNorm(u, 0, dd, W["dec_ln.weight"], W["dec_ln.bias"], z, 0);
        beat += 1;
    }

    // logits of lane `lane` of the last decoded beat; hist = the 68 history values
    function laneLogits(lane, hist, out = new Float32Array(N_CLASSES)) {
        const b = beat - 1;
        headIn.set(z, 0);
        headIn.set(W["head_lane_emb.weight"].subarray(lane * le, (lane + 1) * le), dd);
        headIn.set(hist, dd + le);
        headIn.set(enc.xn.subarray(b * IN_DIM + lane * NV, b * IN_DIM + (lane + 1) * NV), dd + le + HIST_LEN);
        matvec(W["head1.weight"], headIn, 0, hh, headIn.length, h1, 0, W["head1.bias"]);
        geluInPlace(h1, 0, hh);
        matvec(W["head2.weight"], h1, 0, hh, hh, h2, 0, W["head2.bias"]);
        geluInPlace(h2, 0, hh);
        return matvec(W["head3.weight"], h2, 0, N_CLASSES, hh, out, 0, W["head3.bias"]);
    }

    return {
        get beat() { return beat; },
        advance,
        laneLogits,
        reset() { beat = 0; },
        snapshot: () => ({ beat, z: z.slice(), ring: ring.map((r) => r.slice()) }),
        restore(s) {
            beat = s.beat;
            z = s.z.slice();
            ring = s.ring.map((r) => r.slice());
        },
    };
}

// The lane head's history: the last 4 rows (newest first), as one-hot mask + gap in beats (clipped to 4, / 4).
function createHistory() {
    const mask = new Uint8Array(N_HIST);
    const pos = new Float64Array(N_HIST);
    let n = 0;
    return {
        push(m, p) {
            if (!m) return;
            for (let k = N_HIST - 1; k > 0; k -= 1) {
                mask[k] = mask[k - 1];
                pos[k] = pos[k - 1];
            }
            mask[0] = m;
            pos[0] = p;
            n = Math.min(N_HIST, n + 1);
        },
        features(p, out) {
            out.fill(0);
            for (let k = 0; k < N_HIST; k += 1) {
                if (k < n) {
                    out[k * HIST_DIM + mask[k]] = 1;
                    out[k * HIST_DIM + 16] = Math.min(p - pos[k], GAP_CLIP) / GAP_CLIP;
                } else {
                    out[k * HIST_DIM + 16] = 1;
                }
            }
            return out;
        },
        clear() { n = 0; },
        snapshot: () => ({ mask: mask.slice(), pos: pos.slice(), n }),
        restore(s) {
            mask.set(s.mask);
            pos.set(s.pos);
            n = s.n;
        },
    };
}

const divOfBeat = (inp, b) => {
    if (inp.div) return DIV_CLASSES[inp.div[b]];
    for (let k = 0; k < DIV_CLASSES.length; k += 1) if (inp.x[b * IN_DIM + IN_DIM - DIV_CLASSES.length + k] > 0.5) return DIV_CLASSES[k];
    return 4;
};

// Teacher-forced logits at chosen slots ([[beat, lane], …]) with the given rows (T×8): what the parity probes check.
export function teacherForced(net, inp, rows, wanted) {
    const enc = encodeBeats(net, inp);
    const dec = createDecoder(net, enc, inp);
    const hist = createHistory();
    const want = new Map(wanted.map(([b, l], k) => [b * N_LANES + l, k]));
    const out = new Array(wanted.length);
    const h = new Float32Array(HIST_LEN);
    for (let b = 0; b < inp.T; b += 1) {
        dec.advance(b ? rows : null, (b - 1) * N_LANES);
        const dv = divOfBeat(inp, b);
        for (let l = 0; l < N_LANES; l += 1) {
            if (!(inp.x[b * IN_DIM + l * NV + PRESENT] > 0.5)) continue;
            const p = b + l / dv;
            const k = want.get(b * N_LANES + l);
            if (k !== undefined) out[k] = Array.from(dec.laneLogits(l, hist.features(p, h)));
            hist.push(rows[b * N_LANES + l], p);
        }
    }
    return out;
}

// ---- beat inputs from the generator's slots ----
function beatGroups(slots) {
    const first = [];
    for (let i = 0; i < slots.length; i += 1) {
        const s = slots[i];
        const p = slots[i - 1];
        if (i === 0 || s.beat !== p.beat || (s.pos ?? s.sub) <= (p.pos ?? p.sub)) first.push(i);
    }
    return first;
}

function columnsByName(names, rows, wanted) {
    const F = names?.length ?? 0;
    return wanted.map((name) => {
        const k = names ? names.indexOf(name) : -1;
        return k < 0 ? null : (i) => rows[i * F + k];
    });
}

function styleIndex(net, style) {
    if (style === null || style === undefined) return 0;
    const n = net.arch.n_styles;
    if (typeof style === "string") {
        const k = net.styles.findIndex((s) => s.key === style);
        return k >= 0 && k + 1 < n ? k + 1 : 0;
    }
    return Number.isInteger(style) && style >= 0 && style + 1 < n ? style + 1 : 0;
}

function sourceIndex(net, source) {
    if (source === null || source === undefined) return Math.max(0, net.sources.indexOf("osu"));
    if (typeof source === "string") return Math.max(0, net.sources.indexOf(source));
    return Number.isInteger(source) && source >= 0 && source < net.arch.n_sources ? source : 0;
}

// Per beat, the beat it echoes (−1 = none): structure.echoBeat if given, else structure.echoOf per bar with bars from
// structure.bars when they carry { i0 } slot ranges, else barsOf(slots, structure.meter) — the very bars songStructure
// cut from the same slots (its own bars are { startMs, endMs } only); when their count differs from structure.bars,
// each structure bar starts at the first slot at or after its startMs.
function barsWithSlots(structure, slots) {
    const given = structure.bars;
    if (given?.length && Number.isInteger(given[0].i0)) return given;
    const cut = barsOf(slots, structure.meter ?? 4);
    if (!given?.length || given.length === cut.length) return cut;
    let i = 0;
    return given.map((bar) => {
        while (i < slots.length && slots[i].t < bar.startMs - 0.5) i += 1;
        return { i0: i };
    });
}

function echoBeats(structure, slots, beatOf, T) {
    const back = new Int32Array(T).fill(-1);
    if (!structure) return back;
    if (structure.echoBeat) {
        for (let t = 0; t < T; t += 1) back[t] = structure.echoBeat[t] ?? -1;
        return back;
    }
    const echoOf = structure.echoOf;
    if (!echoOf?.length) return back;
    const bars = barsWithSlots(structure, slots);
    const start = bars.map((bar) => beatOf[Math.min(slots.length - 1, bar.i0)]);
    for (let B = 0; B < bars.length && B < echoOf.length; B += 1) {
        const E = echoOf[B];
        if (!(E >= 0) || E >= bars.length) continue;
        const b1 = B + 1 < bars.length ? start[B + 1] : T;
        const e1 = E + 1 < bars.length ? start[E + 1] : T;
        for (let o = 0; start[B] + o < b1; o += 1) if (start[E] + o < e1) back[start[B] + o] = start[E] + o;
    }
    return back;
}

export function buildInfillInputs(net, { audio = {}, slots, dan, family, known = null, cond = null, structure = null }) {
    const first = beatGroups(slots);
    const T = first.length;
    const beatOf = new Int32Array(slots.length);
    const laneOf = new Uint8Array(slots.length);
    const div = new Uint8Array(T);
    for (let b = 0; b < T; b += 1) {
        const end = b + 1 < T ? first[b + 1] : slots.length;
        const dv = slots[first[b]].div ?? 4;
        const cls = DIV_CLASSES.indexOf(dv);
        if (cls < 0) throw new Error(`nn-v2: beat divisor ${dv} is not one of 4/3/6/8`);
        div[b] = cls;
        for (let i = first[b]; i < end; i += 1) {
            beatOf[i] = b;
            laneOf[i] = slots[i].pos ?? slots[i].sub;
        }
    }
    // lane values by name: the caller's columns, else the v2 ones computed here, else 0 (absent in training too)
    const laneNames = LANE_VALUES.slice(0, PRESENT);
    const given = columnsByName(audio.names, audio.rows, laneNames);
    const missingV2 = laneNames.filter((name, k) => !given[k] && AUDIO_FEATURES_V2.includes(name));
    if (missingV2.length && audio.envelope && slots.length) {
        const own = slotFeatures(audio.envelope, slots, slots[0].bpm, missingV2);
        const cols = columnsByName(own.names, own.rows, laneNames);
        laneNames.forEach((name, k) => { if (!given[k] && cols[k]) given[k] = cols[k]; });
    }
    const x = new Float32Array(T * IN_DIM);
    for (let i = 0; i < slots.length; i += 1) {
        const o = beatOf[i] * IN_DIM + laneOf[i] * NV;
        for (let k = 0; k < PRESENT; k += 1) x[o + k] = given[k] ? given[k](i) : 0;
        x[o + PRESENT] = 1;
    }
    // beat features by name: audio.beat = { names, rows } (dataset v3's per-beat columns), else computed here — all of
    // BEAT_FEATURES_V3 with beatFeaturesV3 (the dataset builder's function) when audio.stems and a structure are given,
    // else the 15 BEAT_FEATURES (the rest stay 0, meter 4)
    let beatCols = columnsByName(audio.beat?.names, audio.beat?.rows, BEAT_FEATURES_V3);
    if (!audio.beat && audio.envelope && T) {
        const beats = first.map((i) => {
            const s = slots[i];
            const beatMs = s.beatMs ?? 60000 / s.bpm;
            return { t: s.t - ((s.pos ?? s.sub) * beatMs) / (s.div ?? 4), beatMs, bpm: s.bpm };
        });
        const own = audio.stems && structure?.bars ? beatFeaturesV3(audio.envelope, beats, { stems: audio.stems, structure }) : beatFeatures(audio.envelope, beats);
        beatCols = columnsByName(own.names, own.rows, BEAT_FEATURES_V3);
    }
    const meterCol = BEAT_FEATURES_V3.indexOf("meter");
    for (let b = 0; b < T; b += 1) {
        const o = b * IN_DIM + LANE_IN;
        for (let k = 0; k < BEAT_FEATURES_V3.length; k += 1) x[o + k] = beatCols[k] ? beatCols[k](b) : k === meterCol ? 4 : 0;
        x[b * IN_DIM + IN_DIM - DIV_CLASSES.length + div[b]] = 1;
    }
    const visible = new Uint8Array(T * N_LANES).fill(FREE);
    if (known) for (let i = 0; i < slots.length; i += 1) if (known[i] !== FREE) visible[beatOf[i] * N_LANES + laneOf[i]] = known[i] & 15;
    const fam = new Uint8Array(T);
    const danBeat = new Float32Array(T);
    let danKnown = 1;
    for (let b = 0; b < T; b += 1) {
        const f = net.families.indexOf(family?.[first[b]]);
        fam[b] = f >= 0 ? f : net.families.length;
        const v = dan?.[first[b]];
        if (Number.isFinite(v)) danBeat[b] = v;
        else danKnown = 0;
    }
    const back = echoBeats(structure, slots, beatOf, T);
    const echo = new Int32Array(T * 2).fill(-1);
    for (let t = T - 1; t >= 0; t -= 1) {
        const e = back[t];
        if (e >= 0 && e < t) {
            echo[t * 2] = e;
            echo[e * 2 + 1] = t; // the first later beat that echoes e
        }
    }
    const msd = cond?.msd && cond.msd.length === 8 ? Float64Array.from(cond.msd) : null;
    return {
        T, x, visible, fam, dan: danBeat, danKnown, msd, style: styleIndex(net, cond?.style), source: sourceIndex(net, cond?.source),
        rate: cond?.rate ?? 1, echo, div, beatOf, laneOf, first,
    };
}

// ---- the row source ----
export const infillSource = {
    kind: "nn-v2",
    caps: { infill: true },
    prepare({ model, audio, slots, dan, family, known = null, cond = null, structure = null }) {
        const net = loadInfill(model);
        const inp = buildInfillInputs(net, { audio, slots, dan, family, known, cond, structure });
        const stats = { encodes: 0, decoded: 0 };
        if (!inp.T) return { step: () => 0, begin() {}, snapshot: () => null, restore() {}, stats, inputs: inp };
        const enc = encodeBeats(net, inp);
        stats.encodes += 1;
        const dec = createDecoder(net, enc, inp);
        const hist = createHistory();
        const rows = new Uint8Array(inp.T * N_LANES);
        const logits = new Float32Array(N_CLASSES);
        const p = new Float64Array(N_CLASSES);
        const h = new Float32Array(HIST_LEN);
        const posOf = (i) => inp.beatOf[i] + inp.laneOf[i] / DIV_CLASSES[inp.div[inp.beatOf[i]]];
        const knownAt = (i) => (known && known[i] !== FREE ? known[i] & 15 : null);
        let cur = 0;
        const begin = () => {
            cur = 0;
            dec.reset();
            hist.clear();
        };
        const record = (i, m) => {
            rows[inp.beatOf[i] * N_LANES + inp.laneOf[i]] = m;
            hist.push(m, posOf(i));
        };
        const sample = (i, offset, rngs, weightOf) => {
            const b = inp.beatOf[i];
            while (dec.beat <= b) {
                const pb = dec.beat;
                dec.advance(pb ? rows : null, (pb - 1) * N_LANES);
                stats.decoded += 1;
            }
            dec.laneLogits(inp.laneOf[i], hist.features(posOf(i), h), logits);
            logits[0] -= offset;
            for (let k = 0; k < N_CLASSES; k += 1) p[k] = logits[k];
            softmaxInPlace(p, 0, N_CLASSES);
            if (rngs.fill() < p[0]) return 0;
            let total = 0;
            for (let k = 1; k < N_CLASSES; k += 1) {
                const w = weightOf ? weightOf(k) : 1;
                p[k] *= w > 0 ? w : 0;
                total += p[k];
            }
            const fallback = () => (weightOf?.fallback ? weightOf.fallback() : 0);
            if (!(total > 0)) return fallback();
            let r = rngs.pattern() * total;
            for (let k = 1; k < N_CLASSES; k += 1) {
                r -= p[k];
                if (r < 0) return k;
            }
            for (let k = N_CLASSES - 1; k > 0; k -= 1) if (p[k] > 0) return k;
            return fallback();
        };
        return {
            stats,
            inputs: inp,
            begin,
            step(i, offset, ctx, rngs, weightOf = null, fixed = undefined) {
                if (i < cur) begin();
                while (cur < i) {
                    record(cur, knownAt(cur) ?? 0);
                    cur += 1;
                }
                const forced = Number.isInteger(fixed) && fixed >= 0 && fixed < 16 ? fixed : knownAt(i);
                const m = forced ?? sample(i, offset, rngs, weightOf);
                record(i, m);
                cur = i + 1;
                return m;
            },
            snapshot: () => ({ cur, rows: rows.slice(), hist: hist.snapshot(), dec: dec.snapshot() }),
            restore(s) {
                cur = s.cur;
                rows.set(s.rows);
                hist.restore(s.hist);
                dec.restore(s.dec);
            },
        };
    },
};

// ---- helpers for tests, the bench and the exporter's checks ----

function bytesOf(b64) {
    if (typeof Buffer !== "undefined") {
        const buf = Buffer.from(b64, "base64");
        return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    const bin = atob(b64);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
const arrayOf = (v, Type) => (typeof v === "string" ? new Type(bytesOf(v).buffer) : Type.from(v));

// A parity probe of the model JSON (written by tools/export_infill.py) → teacherForced inputs, with `rows`.
export function probeInputs(probe) {
    return {
        T: probe.T,
        x: arrayOf(probe.x, Float32Array),
        visible: arrayOf(probe.visible, Uint8Array),
        rows: arrayOf(probe.rows, Uint8Array),
        div: arrayOf(probe.div, Uint8Array),
        fam: Uint8Array.from(probe.fam),
        dan: Float32Array.from(probe.dan),
        danKnown: probe.danKnown ? 1 : 0,
        msd: probe.msd ? Float64Array.from(probe.msd) : null,
        style: probe.style,
        source: probe.source,
        rate: probe.rate ?? 1,
        echo: Int32Array.from(probe.echo),
    };
}

// A model JSON with random weights for an arch ({ d, enc_layers, … } as in tools/nn/sizes.json).
export function randomInfillModel(archIn, { seed = 1, std = 1, styles = [] } = {}) {
    const arch = { ...ARCH_DEFAULTS, ...archIn, n_styles: Math.max(archIn.n_styles ?? 1, styles.length + 1) };
    const rng = mulberry32(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const weights = {};
    for (const [name, shape] of Object.entries(infillShapes(arch))) {
        const n = prod(shape);
        const fanIn = shape.length === 2 && name.endsWith(".weight") && !name.includes("emb") ? shape[1] : 1;
        const isGain = /ln\d?\.weight$|_ln\.weight$/.test(name);
        const v = Float32Array.from({ length: n }, () => (isGain ? 1 + 0.1 * gauss() : (std * gauss()) / Math.sqrt(fanIn) * (name.endsWith(".bias") ? 0.1 : 1)));
        weights[name] = encodeF16(v);
    }
    return {
        kind: "nn-v2", size: arch.size ?? "custom", arch, styles,
        norm: { mean: new Array(IN_DIM).fill(0), inv: new Array(IN_DIM).fill(1) },
        families: FAMILIES, features: LANE_VALUES.slice(0, PRESENT).filter((n) => AUDIO_FEATURES_V2.includes(n)), weights,
    };
}

// Multiply-adds × 2 of one prepare (encoder + the decoder's static K/V) and of one build, for T beats and n slots.
export function infillFlops(archIn, T, n, { echoKeys = 1 } = {}) {
    const a = { ...ARCH_DEFAULTS, ...archIn };
    const { d, dec_d: dd } = a;
    const keys = Math.min(T, 2 * a.win + 1) + echoKeys + a.n_glob;
    const encLayer = 2 * d * 3 * d + 2 * d * d + 4 * d * a.enc_ffn + 4 * keys * d;
    const encoder = T * (2 * IN_DIM * d + 2 * COND_DIM * d + a.enc_layers * encLayer) + a.n_glob * a.enc_layers * (encLayer + 4 * T * d);
    const statics = T * (2 * d * dd + a.dec_layers * 2 * d * 2 * dd);
    const decLayer = 2 * dd * 3 * dd + 3 * 2 * dd * dd + 4 * dd * a.dec_ffn + 4 * Math.min(T, a.dec_win) * dd + 4 * Math.min(T, 2 * a.cross_win + 1) * dd;
    const decoder = T * a.dec_layers * decLayer;
    const hin = dd + a.lane_emb + HIST_LEN + NV;
    const lane = n * 2 * (hin * a.lane_hidden + a.lane_hidden * a.lane_hidden + a.lane_hidden * N_CLASSES);
    return { prepare: encoder + statics, encoder, statics, decoder, lane, build: decoder + lane };
}
