import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { buildSlots, buildSlotsFromTiming, slotsForTiming } from "../../src/gen/grid.js";
import { createHash } from "node:crypto";
import { slotFeatures, AUDIO_FEATURES, AUDIO_FEATURES_V2, AUDIO_FEATURES_V3, STEM_FEATURES } from "../../src/gen/slotFeatures.js";
import { computeStemsSync, stemsToTransfer, stemsFromTransfer } from "../../src/audio/stems.js";
import { songStructure, structureColumns, STRUCTURE_FEATURES } from "../../src/gen/structure.js";
import { strengthsAt, slotStrengths, slotEnergy } from "../../src/gen/intensity.js";
import { clickTrack } from "../fixtures/clickTrack.js";

test("one row of named features per slot", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 150, offsetMs: 400, seconds: 30 });
    const env = onsetEnvelope(samples, sampleRate);
    const slots = buildSlots({ bpm: 150, offsetMs: 400, endMs: 29000 });
    const { names, rows } = slotFeatures(env, slots, 150);
    assert.deepEqual(names, AUDIO_FEATURES);
    assert.equal(rows.length, slots.length * names.length);
    assert.ok(rows.every(Number.isFinite));
    const col = (name) => names.indexOf(name);
    const at = (i, name) => rows[i * names.length + col(name)];
    // beats carry the clicks, the 1/16 slots between them do not
    const beatSlot = slots.findIndex((s) => s.sub === 0 && s.t > 5000);
    assert.ok(at(beatSlot, "onset") > 3 * at(beatSlot + 1, "onset"));
    assert.equal(at(beatSlot, "sub"), 0);
    assert.equal(at(beatSlot + 1, "sub"), 1);
    assert.ok(Math.abs(at(beatSlot, "beat_share") - 1) < 1e-6);
});

// The v1 feature code exactly as the current model was trained with it.
function slotFeaturesV1(envelope, slots, bpm) {
    const n = slots.length;
    const onset = slotStrengths(envelope, slots);
    const band = (name) => (envelope.bands?.[name] ? strengthsAt(envelope.bands[name], envelope.frameTimeSec, slots) : onset);
    const low = band("low");
    const mid = band("mid");
    const high = band("high");
    const energy = slotEnergy(envelope, slots);
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + onset[i];
    const localMean = (i) => {
        const a = Math.max(0, i - 8);
        const b = Math.min(n, i + 9);
        return (prefix[b] - prefix[a]) / (b - a);
    };
    const F = AUDIO_FEATURES.length;
    const rows = new Float32Array(n * F);
    for (let i = 0; i < n; i += 1) {
        const { sub } = slots[i];
        const slotBpm = slots[i].bpm ?? bpm;
        const beatStart = i - sub;
        let beatMax = 0;
        for (let j = Math.max(0, beatStart); j < Math.min(n, beatStart + 4); j += 1) beatMax = Math.max(beatMax, onset[j]);
        const v = [
            sub, sub === 0 ? 1 : 0, sub === 2 ? 1 : 0,
            onset[i], low[i], mid[i], high[i],
            i > 0 ? onset[i - 1] : 0, i + 1 < n ? onset[i + 1] : 0,
            i > 0 ? low[i - 1] : 0, i + 1 < n ? low[i + 1] : 0,
            beatMax > 0 ? onset[i] / beatMax : 0, localMean(i),
            energy[i], energy[i] - (i >= 16 ? energy[i - 16] : energy[i]),
            slotBpm, 60000 / slotBpm / 4,
        ];
        rows.set(v, i * F);
    }
    return rows;
}

test("bit-identical v1 rows on an all-1/4 single-BPM grid", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312, seconds: 40, div: 2 });
    const env = onsetEnvelope(samples, sampleRate);
    const same = (slots, bpm, what) => {
        const now = slotFeatures(env, slots, bpm).rows;
        const was = slotFeaturesV1(env, slots, bpm);
        assert.equal(now.length, was.length, what);
        assert.ok(Buffer.from(now.buffer).equals(Buffer.from(was.buffer)), what);
    };
    same(buildSlots({ bpm: 174, offsetMs: 312, endMs: 39000 }), 174, "generator grid");
    same(slotsForTiming({ bpm: 174, offsetMs: 312 }, 39000), 174, "v3 grid");
    const points = [{ time: 312, beatLength: 60000 / 174 }];
    // the dataset builder's grid, cut to the mapped part (it starts mid-beat)
    same(buildSlotsFromTiming(points, 39000).filter((s) => s.t >= 5100), 174, "dataset grid");
    same(slotsForTiming({ bpm: 174, offsetMs: 312 }, 39000).filter((s) => s.t >= 5100), 174, "v3 dataset grid");
});

test("v2 features: grid columns, and finite values on a mixed grid", () => {
    assert.deepEqual(AUDIO_FEATURES_V2.slice(0, AUDIO_FEATURES.length), AUDIO_FEATURES);
    assert.deepEqual(AUDIO_FEATURES_V2.slice(AUDIO_FEATURES.length), ["div", "phase", "is_third", "beat_on3", "beat_on4", "beat_on8"]);
    const { samples, sampleRate } = clickTrack({ bpm: 120, offsetMs: 0, seconds: 30, triplets: { fromMs: 10000, toMs: 20000 } });
    const env = onsetEnvelope(samples, sampleRate);
    const divs = [4, 3, 6, 8];
    const timing = { sections: [{ timeMs: 0, bpm: 120 }, { timeMs: 15000, bpm: 180 }] };
    const slots = slotsForTiming(timing, 29000, { divOf: (i) => divs[i % 4] });
    const { names, rows } = slotFeatures(env, slots, 120, AUDIO_FEATURES_V2);
    assert.deepEqual(names, AUDIO_FEATURES_V2);
    assert.equal(rows.length, slots.length * names.length);
    assert.ok(rows.every(Number.isFinite));
    const F = names.length;
    const at = (i, name) => rows[i * F + names.indexOf(name)];
    const i3 = slots.findIndex((s) => s.div === 3 && s.pos === 1);
    assert.equal(at(i3, "div"), 3);
    assert.ok(Math.abs(at(i3, "phase") - 1 / 3) < 1e-6);
    assert.equal(at(i3, "is_third"), 1);
    assert.equal(at(i3, "beat_on3"), 1);
    assert.equal(at(i3, "beat_on4"), 0);
    assert.equal(at(i3, "sub"), 1);
    assert.equal(at(i3, "is_beat"), 0);
    assert.ok(Math.abs(at(i3, "slot_ms") - 500 / 3) < 1e-3);
    const i6 = slots.findIndex((s) => s.div === 6 && s.pos === 3);
    assert.equal(at(i6, "is_half"), 1);
    assert.equal(at(i6, "beat_on3"), 1);
    const i8 = slots.findIndex((s) => s.div === 8 && s.pos === 0);
    assert.equal(at(i8, "is_beat"), 1);
    assert.equal(at(i8, "beat_on8"), 1);
    const late = slots.findIndex((s) => s.t >= 16000 && s.div === 4 && s.pos === 0);
    assert.equal(at(late, "bpm"), 180);
});

test("columns are selected by name, in the order asked for", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 150, offsetMs: 400, seconds: 20 });
    const env = onsetEnvelope(samples, sampleRate);
    const slots = slotsForTiming({ bpm: 150, offsetMs: 400 }, 19000);
    const all = slotFeatures(env, slots, 150, AUDIO_FEATURES_V2);
    const some = slotFeatures(env, slots, 150, ["phase", "onset", "bpm"]);
    assert.deepEqual(some.names, ["phase", "onset", "bpm"]);
    for (let i = 0; i < slots.length; i += 1) {
        assert.equal(some.rows[i * 3], all.rows[i * all.names.length + all.names.indexOf("phase")]);
        assert.equal(some.rows[i * 3 + 1], all.rows[i * all.names.length + all.names.indexOf("onset")]);
        assert.equal(some.rows[i * 3 + 2], 150);
    }
    assert.throws(() => slotFeatures(env, slots, 150, ["onset", "nope"]), /nope/);
});

test("the energy look-back is the same phase four beats earlier", () => {
    const { samples, sampleRate } = clickTrack({ bpm: 120, offsetMs: 0, seconds: 30 });
    const env = { ...onsetEnvelope(samples, sampleRate) };
    // loudness that rises steadily, so every look-back has its own value
    env.energy = Float32Array.from(env.energy, (_, f) => 0.01 * 10 ** ((f * 256) / sampleRate / 10));
    const divOf = (i) => (i >= 20 && i < 30 ? 3 : 4);
    const slots = slotsForTiming({ bpm: 120, offsetMs: 0 }, 29000, { divOf });
    const { names, rows } = slotFeatures(env, slots, 120, ["energy", "energy_delta"]);
    assert.deepEqual(names, ["energy", "energy_delta"]);
    const energy = (i) => rows[i * 2];
    const delta = (i) => rows[i * 2 + 1];
    const find = (beat, pos) => slots.findIndex((s) => s.beat === beat && s.pos === pos);
    const check = (beat, pos, back, backPos) => {
        const want = Math.fround(energy(find(beat, pos)) - energy(find(back, backPos)));
        assert.ok(Math.abs(delta(find(beat, pos)) - want) < 1e-6, `${beat}/${pos}`);
        assert.ok(Math.abs(delta(find(beat, pos))) > 1e-4, "a real step back");
    };
    check(26, 1, 22, 1); // triplet slot, 4 beats after a triplet slot of the same phase
    check(31, 3, 27, 2); // a 3/4 slot whose look-back beat is a triplet: the nearest phase there, 2/3
    check(18, 2, 14, 2); // plain 1/4
});

// ---- v3: stems and structure ---------------------------------------------------------------------------------------

const sha1 = (rows) => createHash("sha1").update(Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength)).digest("hex");

function mixedSong() {
    const { samples, sampleRate } = clickTrack({ bpm: 120, offsetMs: 0, seconds: 30, triplets: { fromMs: 10000, toMs: 20000 }, hats: { fromMs: 5000, toMs: 25000, div: 2 } });
    const env = onsetEnvelope(samples, sampleRate);
    const divs = [4, 3, 6, 8];
    const timing = { sections: [{ timeMs: 0, bpm: 120 }, { timeMs: 15000, bpm: 180 }] };
    const mixed = slotsForTiming(timing, 29000, { divOf: (i) => divs[i % 4] });
    return { samples, sampleRate, env, timing, mixed };
}

test("v1 and v2 rows are bit-identical to before v3 (golden hashes)", () => {
    // hashes of the rows the v2 code (before stems and structure) gave for this input
    const { env, timing, mixed } = mixedSong();
    const quarter = buildSlots({ bpm: 120, offsetMs: 0, endMs: 29000 });
    assert.equal(sha1(slotFeatures(env, quarter, 120).rows), "05e5e589c6d0f4b685dbc37184eaa6defe50cea8");
    assert.equal(sha1(slotFeatures(env, mixed, 120, AUDIO_FEATURES).rows), "f3965b6da8d29456e6189b119ed7d5278ddb2646");
    assert.equal(sha1(slotFeatures(env, mixed, 120, AUDIO_FEATURES_V2).rows), "40488bbd9737f096f7770b760771ff747438283d");
    assert.equal(sha1(slotFeatures(env, slotsForTiming(timing, 29000), 120, AUDIO_FEATURES_V2).rows), "998477a1510400acefd05348cb4d18159345ecd4");
});

test("v3 names: v2 plus 8 stem and 6 structure columns", () => {
    assert.equal(AUDIO_FEATURES_V3.length, 37);
    assert.deepEqual(AUDIO_FEATURES_V3.slice(0, AUDIO_FEATURES_V2.length), AUDIO_FEATURES_V2);
    assert.deepEqual(AUDIO_FEATURES_V3.slice(AUDIO_FEATURES_V2.length), [
        "kick", "snare", "hat", "harm", "perc_share", "kick_share", "snare_share", "hat_share",
        "phrase_pos", "is_phrase_start", "bar_in_phrase", "has_echo", "rep_sim", "novelty",
    ]);
    assert.deepEqual(STEM_FEATURES, AUDIO_FEATURES_V3.slice(23, 31));
    assert.deepEqual(STRUCTURE_FEATURES, AUDIO_FEATURES_V3.slice(31));
});

test("v3 columns without stems or structure throw", () => {
    const { env, mixed } = mixedSong();
    assert.throws(() => slotFeatures(env, mixed, 120, AUDIO_FEATURES_V3), /missing stems/);
    assert.throws(() => slotFeatures(env, mixed, 120, ["onset", "kick_share"]), /missing stems/);
    assert.throws(() => slotFeatures(env, mixed, 120, ["kick"], { structure: {} }), /missing stems/);
    const { samples, sampleRate } = mixedSong();
    const stems = computeStemsSync(samples, sampleRate);
    assert.throws(() => slotFeatures(env, mixed, 120, ["kick", "phrase_pos"], { stems }), /missing structure/);
    assert.doesNotThrow(() => slotFeatures(env, mixed, 120, STEM_FEATURES, { stems }));
});

test("v3 rows: finite on a mixed grid, sampled like onset, shares at most 1, old columns untouched", () => {
    const { samples, sampleRate, env, mixed } = mixedSong();
    const stems = stemsFromTransfer(stemsToTransfer(computeStemsSync(samples, sampleRate)));
    const structure = songStructure({ stems, slots: mixed, envelope: env });
    const { names, rows } = slotFeatures(env, mixed, 120, AUDIO_FEATURES_V3, { stems, structure });
    assert.deepEqual(names, AUDIO_FEATURES_V3);
    const F = names.length;
    assert.equal(rows.length, mixed.length * F);
    assert.ok(rows.every(Number.isFinite));
    const col = (name) => Float32Array.from(mixed, (_, i) => rows[i * F + names.indexOf(name)]);
    for (const [name, curve] of [["kick", "kick"], ["snare", "snare"], ["hat", "hat"], ["harm", "harm"], ["perc_share", "percShare"]]) {
        assert.deepEqual(Array.from(col(name)), Array.from(Float32Array.from(strengthsAt(stems[curve], stems.frameTimeSec, mixed))), name);
    }
    for (const name of ["kick_share", "snare_share", "hat_share"]) assert.ok(col(name).every((x) => x >= 0 && x <= 1), name);
    // a share is the slot's value over the best one of its beat (the click track has hats, its clicks are no kicks)
    const hat = col("hat");
    const share = col("hat_share");
    assert.ok(share.some((x) => x === 1));
    const beatOf = mixed.map((s) => s.beat);
    const i = mixed.findIndex((s, k) => s.div === 6 && s.pos === 2 && hat[k] > 0);
    assert.ok(i >= 0);
    const beatMax = Math.max(...mixed.map((_, k) => (beatOf[k] === beatOf[i] ? hat[k] : 0)));
    assert.ok(Math.abs(share[i] - hat[i] / beatMax) < 1e-6);
    const cols = structureColumns(structure, mixed);
    for (const name of STRUCTURE_FEATURES) assert.deepEqual(Array.from(col(name)), Array.from(cols[name]), name);
    // the v2 columns are the same with or without the v3 inputs
    const plain = slotFeatures(env, mixed, 120, AUDIO_FEATURES_V2).rows;
    const withV3 = slotFeatures(env, mixed, 120, AUDIO_FEATURES_V2, { stems, structure }).rows;
    assert.equal(sha1(withV3), sha1(plain));
    for (let k = 0; k < mixed.length; k += 1) {
        for (let c = 0; c < AUDIO_FEATURES_V2.length; c += 1) assert.equal(rows[k * F + c], plain[k * AUDIO_FEATURES_V2.length + c]);
    }
});
