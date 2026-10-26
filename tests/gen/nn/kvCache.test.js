import test from "node:test";
import assert from "node:assert/strict";
import { loadInfill, randomInfillModel, encodeBeats, createDecoder, teacherForced, IN_DIM } from "../../../src/gen/nn/infillModel.js";
import { referenceLogits } from "./reference.js";
import { mulberry32 } from "../../../src/gen/rng.js";

const ARCH = { d: 8, enc_layers: 1, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 2, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 5, dec_win: 8, cross_win: 4, n_glob: 2 };

function inputs(T, seed = 1) {
    const rng = mulberry32(seed);
    const x = new Float32Array(T * IN_DIM);
    const rows = new Uint8Array(T * 8);
    const div = new Uint8Array(T);
    for (let t = 0; t < T; t += 1) {
        div[t] = t % 5 === 4 ? 3 : 0;
        const dv = div[t] === 3 ? 8 : 4;
        for (let l = 0; l < dv; l += 1) {
            for (let k = 0; k < 11; k += 1) x[t * IN_DIM + l * 12 + k] = rng();
            x[t * IN_DIM + l * 12 + 11] = 1;
            rows[t * 8 + l] = rng() < 0.5 ? 1 + Math.floor(rng() * 15) : 0;
        }
        x[t * IN_DIM + 141 + div[t]] = 1;
    }
    return {
        T, x, rows, div, visible: new Uint8Array(T * 8).fill(255), fam: new Uint8Array(T), dan: new Float32Array(T).fill(7),
        danKnown: 1, msd: null, style: 0, source: 1, rate: 1, echo: new Int32Array(T * 2).fill(-1),
    };
}

test("the ring cache (32 beats in the model, 8 here) wraps many times and still equals dense attention", () => {
    for (const layers of [1, 2]) {
        const net = loadInfill(randomInfillModel({ ...ARCH, dec_layers: layers }, { seed: 4, std: 1.5 }));
        const inp = inputs(100);
        const ref = referenceLogits(net, inp, inp.rows);
        const wanted = [];
        for (let b = 0; b < 100; b += 7) wanted.push([b, 0], [b, 3]);
        const got = teacherForced(net, inp, inp.rows, wanted);
        got.forEach((g, k) => {
            const [b, l] = wanted[k];
            g.forEach((v, c) => assert.ok(Math.abs(v - ref[(b * 8 + l) * 16 + c]) < 1e-4, `layers ${layers} beat ${b} lane ${l}`));
        });
    }
});

// logits of lane 0 with an empty history: a function of the decoder state alone
function decodeStates(net, enc, inp, rows, from = 0, to = inp.T, dec = null) {
    const d = dec ?? createDecoder(net, enc, inp);
    const out = [];
    const none = new Float32Array(68);
    for (let k = 0; k < 4; k += 1) none[k * 17 + 16] = 1;
    for (let b = from; b < to; b += 1) {
        d.advance(b ? rows : null, (b - 1) * 8);
        out.push(Array.from(d.laneLogits(0, none)));
    }
    return { out, dec: d };
}

test("with one decoder layer a beat's rows reach exactly the next dec_win beats", () => {
    const net = loadInfill(randomInfillModel({ ...ARCH, dec_layers: 1 }, { seed: 5, std: 1.5 }));
    const inp = inputs(60, 2);
    const enc = encodeBeats(net, inp);
    const base = decodeStates(net, enc, inp, inp.rows).out;
    const rows = inp.rows.slice();
    const j = 20;
    rows[j * 8] = rows[j * 8] === 5 ? 6 : 5;
    const moved = decodeStates(net, enc, inp, rows).out;
    const changed = base.map((v, b) => v.some((x, c) => Math.abs(x - moved[b][c]) > 1e-9));
    // beat j's rows feed beat j + 1's input; its K/V stay in the window for dec_win beats
    for (let b = 0; b < 60; b += 1) assert.equal(changed[b], b > j && b <= j + ARCH.dec_win, `beat ${b}`);
});

test("decoder snapshot/restore round trips, and restoring discards what was decoded after it", () => {
    const net = loadInfill(randomInfillModel(ARCH, { seed: 6, std: 1.5 }));
    const inp = inputs(90, 3);
    const enc = encodeBeats(net, inp);
    const rowsA = inp.rows;
    const rowsB = Uint8Array.from(rowsA, (m, k) => (k % 3 ? m : (m + 1) % 16));
    const { out: whole } = decodeStates(net, enc, inp, rowsA);
    const head = decodeStates(net, enc, inp, rowsA, 0, 41);
    const snap = head.dec.snapshot();
    const b = decodeStates(net, enc, inp, rowsB, 41, 90, head.dec).out;
    assert.notDeepEqual(b, whole.slice(41));
    head.dec.restore(snap);
    assert.equal(head.dec.beat, 41);
    const again = decodeStates(net, enc, inp, rowsA, 41, 90, head.dec).out;
    assert.deepEqual(again, whole.slice(41));
    // the snapshot itself is not changed by decoding after a restore
    head.dec.restore(snap);
    assert.deepEqual(decodeStates(net, enc, inp, rowsA, 41, 90, head.dec).out, whole.slice(41));
});
