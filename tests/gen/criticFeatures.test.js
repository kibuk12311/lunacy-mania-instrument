import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { criticFeatures, CRITIC_FEATURES, CRITIC_META, WINDOW_FEATURES, MAP_FEATURES, mirrorMask } from "../../src/gen/criticFeatures.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { barsOf } from "../../src/gen/songParts.js";
import { mulberry32 } from "../../src/gen/rng.js";

// 150 BPM, 1/4: 100 ms between slots, 400 ms per beat
const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 120000);
const at = (name) => {
    const k = CRITIC_FEATURES.indexOf(name);
    assert.ok(k >= 0, `no feature ${name}`);
    return k;
};
const rowsOf = (masks, step = 1, from = 0) => masks.map((mask, k) => ({ t: slots[from + k * step].t, mask, i: from + k * step }));
const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-12;

// a seeded map with every row size, jacks, trills and gaps
function randomMap(n, seed = 7) {
    const rng = mulberry32(seed);
    const rows = [];
    let i = 8;
    while (rows.length < n && i < slots.length) {
        const r = rng();
        const mask = r < 0.55 ? 1 << Math.floor(rng() * 4) : r < 0.85 ? [3, 5, 6, 9, 10, 12][Math.floor(rng() * 6)] : r < 0.97 ? [7, 11, 13, 14][Math.floor(rng() * 4)] : 15;
        rows.push({ t: slots[i].t, mask, i });
        i += rng() < 0.75 ? 1 : 2 + Math.floor(rng() * 3);
    }
    return rows;
}

test("names are unique and stable, and the vector has one value per name", () => {
    assert.equal(new Set(CRITIC_FEATURES).size, CRITIC_FEATURES.length);
    assert.equal(CRITIC_FEATURES.length, WINDOW_FEATURES.length * 3 + MAP_FEATURES.length);
    assert.equal(CRITIC_FEATURES.length, 219);
    // the order is part of every trained critic.json: changing it must be deliberate (update this hash too)
    const hash = createHash("sha1").update(CRITIC_FEATURES.join(",")).digest("hex").slice(0, 12);
    assert.equal(hash, "65a2c0015689");
    assert.deepEqual(CRITIC_META, ["map_forced_per1000"]);
    const v = criticFeatures(randomMap(400), slots);
    assert.equal(v.length, CRITIC_FEATURES.length);
});

test("a pure 1234 roll gives roll share 1 and jack rate 0", () => {
    const rows = rowsOf(Array.from({ length: 640 }, (_, k) => 1 << (k % 4)));
    const v = criticFeatures(rows, slots);
    for (const s of ["p10", "mean", "p90"]) {
        assert.equal(v[at(`w_roll_${s}`)], 1, `roll ${s}`);
        assert.equal(v[at(`w_jack_rate_${s}`)], 0, `jack ${s}`);
        assert.equal(v[at(`w_trill_${s}`)], 0, `trill ${s}`);
    }
    assert.equal(v[at("map_longest_jack")], 1);
    assert.equal(v[at("w_gap_4_mean")], 1);
    assert.equal(v[at("map_notes_per_beat")], 4);
});

test("a left-only map gives |left − 0.5| = 0.5", () => {
    const rows = rowsOf(Array.from({ length: 400 }, (_, k) => (k % 2 ? 1 : 2)));
    const v = criticFeatures(rows, slots);
    assert.equal(v[at("w_left_dev_mean")], 0.5);
    assert.equal(v[at("w_left_dev_p10")], 0.5);
    assert.equal(v[at("map_left_share")], 1);
    assert.equal(v[at("w_trill_p90")], 1);
    assert.ok(v[at("w_trill_mean")] > 0.99, "every row but the first two is a trill");
    assert.equal(v[at("w_hand_run_mean")] > 30, true);
});

test("mirroring keeps every hand-symmetric feature and swaps the column shares", () => {
    const rows = randomMap(1500, 11);
    const mirrored = rows.map((r) => ({ ...r, mask: mirrorMask(r.mask) }));
    const a = criticFeatures(rows, slots);
    const b = criticFeatures(mirrored, slots);
    const swap = { 0: 3, 1: 2, 2: 1, 3: 0 };
    CRITIC_FEATURES.forEach((name, k) => {
        const col = /^(w_col|map_col)(\d)(.*)$/.exec(name);
        if (col) {
            const partner = `${col[1]}${swap[col[2]]}${col[3]}`;
            assert.ok(same(b[k], a[at(partner)]), `${name} ↔ ${partner}`);
        } else if (name === "map_left_share") {
            assert.ok(Math.abs(b[k] - (1 - a[k])) < 1e-12, name);
        } else {
            assert.ok(same(a[k], b[k]), `${name}: ${a[k]} vs ${b[k]}`);
        }
    });
    assert.notEqual(a[at("map_col0")], a[at("map_col3")], "the test map is not symmetric itself");
});

test("rows exactly on kick peaks give kick share 1; no stems give missing stem features", () => {
    const rows = rowsOf(Array.from({ length: 300 }, (_, k) => 1 << (k % 4)), 2, 4);
    const hopSec = 256 / 22050;
    const frameOffsetSec = 768 / 22050;
    const frames = Math.ceil(130 / hopSec);
    const kick = new Float32Array(frames);
    const hat = new Float32Array(frames);
    for (const r of rows) kick[Math.round((r.t / 1000 - frameOffsetSec) / hopSec)] = 1;
    for (let f = 5; f < frames; f += 37) hat[f] = 0.8; // hats away from the rows
    const stems = { v: 1, hopSec, frameOffsetSec, frames, kick, snare: new Float32Array(frames), hat };
    const v = criticFeatures(rows, slots, null, stems);
    assert.equal(v[at("w_kick_rows_mean")], 1);
    assert.equal(v[at("map_kick_rows")], 1);
    assert.equal(v[at("map_snare_rows")], 0);
    assert.ok(v[at("map_hat_rows")] < 0.2);
    const none = criticFeatures(rows, slots);
    for (const name of ["w_kick_rows_mean", "map_kick_rows", "map_hat_rows"]) assert.ok(Number.isNaN(none[at(name)]), name);
});

test("echo similarity: 1 for a copied bar, −1 without echoes, missing without a structure", () => {
    // the same 2-bar phrase over and over: every bar echoes the bar two before it
    const phrase = [1, 2, 4, 8, 3, 0, 12, 0, 1, 1, 2, 4, 6, 9, 0, 15, 8, 4, 2, 1, 0, 0, 5, 10, 1, 2, 4, 8, 12, 3, 12, 3];
    const masks = Array.from({ length: 640 }, (_, k) => phrase[k % phrase.length]);
    const rows = rowsOf(masks).filter((r) => r.mask);
    const bars = barsOf(slots);
    const echoOf = Int32Array.from(bars, (_, b) => (b >= 2 ? b - 2 : -1));
    const v = criticFeatures(rows, slots, null, null, { echoOf });
    assert.equal(v[at("map_echo_sim")], 1);
    assert.equal(v[at("w_echo_sim_p90")], 1);
    const noEcho = criticFeatures(rows, slots, null, null, { echoOf: new Int32Array(bars.length).fill(-1) });
    assert.equal(noEcho[at("map_echo_sim")], -1);
    assert.ok(Number.isNaN(criticFeatures(rows, slots)[at("map_echo_sim")]));
});

test("audio by name or by envelope columns gives the same features; onsets at rows show up", () => {
    const rows = randomMap(800, 5);
    const onset = new Float64Array(slots.length).fill(0.05);
    const energy = Float64Array.from(slots, (_, i) => 0.5 + 0.5 * Math.sin(i / 200));
    for (const r of rows) onset[r.i] = 0.9;
    const names = ["sub", "onset", "energy"];
    const flat = new Float32Array(slots.length * 3);
    for (let i = 0; i < slots.length; i += 1) flat.set([slots[i].sub, onset[i], energy[i]], i * 3);
    const a = criticFeatures(rows, slots, { onset: Float32Array.from(onset), energy: Float32Array.from(energy) });
    const b = criticFeatures(rows, slots, { names, rows: flat });
    CRITIC_FEATURES.forEach((name, k) => assert.ok(same(a[k], b[k]), name));
    assert.ok(Math.abs(a[at("w_onset_gap_mean")] - 0.85) < 1e-6);
    assert.equal(a[at("w_onset_low_rows_mean")], 0);
    assert.equal(a[at("w_onset_recall_mean")], 1);
    assert.ok(a[at("w_size_onset_corr_mean")] > 0.5);
    assert.ok(Number.isNaN(criticFeatures(rows, slots)[at("w_onset_gap_mean")]), "no audio: missing");
});

test("unsorted rows, rows without a slot index and cols instead of masks give the same vector", () => {
    const rows = randomMap(600, 3);
    const a = criticFeatures(rows, slots, null, null, null, { dan: 7.5 });
    const shuffled = [...rows].reverse().map((r) => ({ t: r.t, cols: [0, 1, 2, 3].filter((c) => r.mask & (1 << c)) }));
    const b = criticFeatures(shuffled, slots, null, null, null, { dan: 7.5 });
    CRITIC_FEATURES.forEach((name, k) => assert.ok(same(a[k], b[k]), name));
    assert.equal(a[at("ctx_dan")], 7.5);
    assert.equal(a[at("ctx_bpm")], 150);
    assert.ok(Number.isNaN(criticFeatures(rows, slots)[at("ctx_dan")]));
});

test("forced rows and issues per 1000 notes", () => {
    const rows = rowsOf(Array.from({ length: 200 }, (_, k) => [1, 2, 1, 2, 1, 4][k % 6])); // a stream on the left hand, column 4 unused
    rows[3].forced = true;
    rows[9].forced = true;
    const v = criticFeatures(rows, slots);
    assert.equal(v[at("map_forced_per1000")], 10);
    assert.ok(v[at("map_issues_per1000")] > 0);
    assert.equal(v[at("map_issue_columns")], 1);
    assert.equal(criticFeatures(rows, slots, null, null, null, { forced: 4 })[at("map_forced_per1000")], 20);
    const clean = criticFeatures(rowsOf(Array.from({ length: 200 }, (_, k) => 1 << (k % 4))), slots);
    assert.equal(clean[at("map_issues_per1000")], 0);
});

test("an empty or tiny map gives a vector of the right length without throwing", () => {
    assert.equal(criticFeatures([], slots).length, CRITIC_FEATURES.length);
    const v = criticFeatures(rowsOf([1, 2, 4]), slots);
    assert.equal(v.length, CRITIC_FEATURES.length);
    assert.ok(Number.isNaN(v[at("w_roll_mean")]));
});

test("bench: a 3000-row map takes at most 10 ms", () => {
    const long = slotsForTiming({ bpm: 190, offsetMs: 0 }, 300000);
    const rng = mulberry32(99);
    const rows = [];
    for (let i = 0; i < long.length && rows.length < 3000; i += 1) {
        if (rng() < 0.85) rows.push({ t: long[i].t, mask: 1 + Math.floor(rng() * 15), i, family: "Jumpstream" });
    }
    const onset = Float32Array.from(long, () => rng());
    const energy = Float32Array.from(long, (_, i) => i / long.length);
    const audio = { onset, energy };
    assert.equal(rows.length, 3000);
    for (let k = 0; k < 3; k += 1) criticFeatures(rows, long, audio);
    let best = Infinity;
    for (let k = 0; k < 7; k += 1) {
        const t0 = performance.now();
        criticFeatures(rows, long, audio);
        best = Math.min(best, performance.now() - t0);
    }
    console.log(`criticFeatures, 3000 rows: ${best.toFixed(2)} ms (best of 7)`);
    assert.ok(best <= 10, `${best.toFixed(2)} ms`);
});

test("a foreign 8-beat section shows up as a seam and as the section that fits the onsets least", () => {
    // a roll on every onset, then one section of jumpjacks on the off-beats
    const onset = new Float64Array(slots.length).fill(0.05);
    const rows = [];
    for (let i = 0; i < 640; i += 1) {
        onset[i] = i % 2 === 0 ? 0.9 : 0.05;
        if (i % 2 === 0) rows.push({ t: slots[i].t, mask: 1 << ((i / 2) % 4), i });
    }
    const swapped = rows.filter((r) => r.i < 320 || r.i >= 352);
    for (let i = 321; i < 352; i += 2) swapped.push({ t: slots[i].t, mask: 0b0011, i });
    const a = criticFeatures(rows, slots, { onset });
    const b = criticFeatures(swapped, slots, { onset });
    assert.equal(a[at("map_seam_max")], 0);
    assert.ok(b[at("map_seam_max")] > 1, `${b[at("map_seam_max")]}`);
    assert.ok(b[at("map_seam_ratio")] > 5);
    assert.ok(a[at("map_chunk_onset_min")] > 0.8);
    assert.ok(b[at("map_chunk_onset_min")] < 0, "the swapped section sits on the quiet slots");
    assert.ok(b[at("map_family_changes")] > 0);
});

test("stems with a frameTimeSec function (like the onset envelope) read the same as hopSec/frameOffsetSec", () => {
    const rows = rowsOf(Array.from({ length: 200 }, (_, k) => 1 << (k % 4)), 2, 4);
    const hopSec = 256 / 22050;
    const frameOffsetSec = 768 / 22050;
    const frames = Math.ceil(60 / hopSec);
    const kick = new Float32Array(frames);
    for (const r of rows) kick[Math.round((r.t / 1000 - frameOffsetSec) / hopSec)] = 1;
    const zero = new Float32Array(frames);
    const a = criticFeatures(rows, slots, null, { hopSec, frameOffsetSec, kick, snare: zero, hat: zero });
    const b = criticFeatures(rows, slots, null, { frameTimeSec: (f) => frameOffsetSec + f * hopSec, kick, snare: zero, hat: zero });
    CRITIC_FEATURES.forEach((name, k) => assert.ok(same(a[k], b[k]), name));
    assert.equal(b[at("map_kick_rows")], 1);
});
