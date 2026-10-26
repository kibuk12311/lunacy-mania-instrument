import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync, stemsFromTransfer, stemsToTransfer } from "../../src/audio/stems.js";
import { slotsForTiming } from "../../src/gen/grid.js";
import { barsOf } from "../../src/gen/songParts.js";
import { songStructure, structureColumns, structureToResponse, STRUCTURE_FEATURES, STRUCTURE_DEFAULTS } from "../../src/gen/structure.js";
import { sectionSong, flatClickSong } from "../fixtures/stemTracks.js";

function prepared(song) {
    const stems = stemsFromTransfer(stemsToTransfer(computeStemsSync(song.samples, song.sampleRate)));
    const envelope = onsetEnvelope(song.samples, song.sampleRate);
    const endMs = (song.samples.length / song.sampleRate) * 1000 - 600;
    const slots = slotsForTiming({ bpm: song.bpm, offsetMs: 0 }, endMs);
    return { stems, envelope, slots };
}

const abab = prepared(sectionSong(["A", "B", "A", "B'"], { bpm: 160 }));
const flat = prepared(flatClickSong({ bars: 24, bpm: 160 }));
const starts = (s) => s.phrases.map((p) => p.bar);
const plain = (s) => JSON.parse(JSON.stringify(s, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));

test("A B A B′ repeats A at a lag of 16 bars and starts a phrase every 8 bars", () => {
    const s = songStructure(abab);
    assert.equal(s.bars.length, 32);
    const echoed = [];
    for (let b = 16; b < 24; b += 1) if (s.echoOf[b] === b - 16) echoed.push(b);
    assert.ok(echoed.length >= 7, `bars 16–23 echo bars 0–7: ${echoed}`);
    assert.ok(s.repeats.some((r) => r.b - r.a === 16 && r.b <= 17 && r.len >= 7), JSON.stringify(s.repeats));
    // the first A and B repeat nothing earlier at a long lag (B against A is no repeat)
    for (let b = 8; b < 16; b += 1) assert.ok(s.echoOf[b] < 0 || b - s.echoOf[b] < 8, `bar ${b} echoes ${s.echoOf[b]}`);
    const got = starts(s);
    assert.equal(got.length, 4, `phrase starts ${got}`);
    [0, 8, 16, 24].forEach((want, k) => assert.ok(Math.abs(got[k] - want) <= 1, `phrase starts ${got}`));
    assert.equal(s.phrases.reduce((n, p) => n + p.bars, 0), 32);
});

test("a flat click track gives no repeats and a single phrase grid", () => {
    const s = songStructure(flat);
    assert.deepEqual(s.repeats, []);
    assert.ok(s.echoOf.every((x) => x === -1));
    assert.ok(s.phrases.every((p) => p.bar % 4 === s.phase), `phase ${s.phase}: ${starts(s)}`);
    assert.ok(s.phrases.slice(1, -1).every((p) => p.bars === 4 || p.bars === 8), JSON.stringify(s.phrases));
});

test("a part start always starts a phrase", () => {
    const bars = barsOf(abab.slots);
    for (const at of [13, 21, 6]) {
        const parts = [{ startMs: 0 }, { startMs: bars[at].startMs }];
        const s = songStructure({ ...abab, parts });
        assert.ok(starts(s).includes(at), `part at bar ${at}: ${starts(s)}`);
        assert.ok(s.phrases.every((p) => p.bars >= 2 || p.bar + p.bars === s.bars.length), `no 1-bar phrase: ${JSON.stringify(s.phrases)}`);
    }
    // parts found by detectParts, when the caller gives only the envelope
    const s = songStructure({ stems: abab.stems, slots: abab.slots, envelope: abab.envelope });
    for (const p of s.partBars) assert.ok(starts(s).includes(p), `detected part at ${p}: ${starts(s)}`);
});

test("echoOf points backwards only, and repeats do not overlap", () => {
    const songs = [abab, flat, prepared(sectionSong(["A", "A", "B", "A", "A", "C"], { barsPerSection: 4, bpm: 180 })), prepared(sectionSong(["A", "B", "C", "B", "A"], { barsPerSection: 4, bpm: 180 }))];
    for (const song of songs) {
        const s = songStructure(song);
        const target = new Int32Array(s.bars.length).fill(-1);
        s.repeats.forEach((r, k) => {
            assert.ok(r.a < r.b && r.len >= STRUCTURE_DEFAULTS.minRepeatBars && r.b + r.len <= s.bars.length, JSON.stringify(r));
            assert.ok(r.sim >= 0 && r.sim <= 1);
            for (let i = 0; i < r.len; i += 1) {
                assert.equal(target[r.b + i], -1, "overlap");
                target[r.b + i] = k;
                assert.equal(s.echoOf[r.b + i], r.a + i);
            }
        });
        s.echoOf.forEach((src, b) => {
            assert.ok(src < b, `bar ${b} echoes ${src}`);
            if (src < 0) assert.equal(target[b], -1);
        });
    }
});

test("the same input gives the same structure", () => {
    const song = () => prepared(sectionSong(["A", "B", "A", "C", "A"], { barsPerSection: 4, bpm: 180 }));
    assert.deepEqual(plain(songStructure(song())), plain(songStructure(song())));
    assert.deepEqual(plain(songStructure(abab)), plain(songStructure(abab)));
});

test("no stems or no slots: no structure", () => {
    assert.equal(songStructure({ stems: null, slots: abab.slots }), null);
    assert.equal(songStructure({ stems: abab.stems, slots: [] }), null);
});

test("slot columns follow the phrases and the echoes", () => {
    const s = songStructure(abab);
    const cols = structureColumns(s, abab.slots);
    assert.deepEqual(Object.keys(cols), STRUCTURE_FEATURES);
    const bars = barsOf(abab.slots);
    for (const name of STRUCTURE_FEATURES) {
        assert.equal(cols[name].length, abab.slots.length);
        assert.ok(cols[name].every(Number.isFinite), name);
    }
    abab.slots.forEach((slot, i) => {
        const k = bars.findIndex((b) => i >= b.i0 && i < b.i1);
        const p = s.phrases.find((ph) => k >= ph.bar && k < ph.bar + ph.bars);
        assert.equal(cols.bar_in_phrase[i], k - p.bar);
        assert.ok(cols.phrase_pos[i] >= 0 && cols.phrase_pos[i] < 1);
        assert.equal(cols.is_phrase_start[i], k === p.bar && i === bars[k].i0 ? 1 : 0);
        assert.equal(cols.has_echo[i], s.echoOf[k] >= 0 ? 1 : 0);
        assert.ok(cols.rep_sim[i] >= 0 && cols.rep_sim[i] <= 1 && (cols.has_echo[i] || cols.rep_sim[i] === 0));
        assert.ok(cols.novelty[i] >= 0 && cols.novelty[i] <= 1);
    });
    // a phrase's position grows through it
    const first = abab.slots.findIndex((_, i) => cols.is_phrase_start[i] === 1 && i > 0);
    assert.ok(cols.phrase_pos[first - 1] > 0.9 && cols.phrase_pos[first] === 0);
    // slots of a cut (the dataset maps only part of a song) get the same values as in the whole
    const cut = abab.slots.filter((x) => x.t >= 9000 && x.t < 40000);
    const cutCols = structureColumns(s, cut);
    const offset = abab.slots.indexOf(cut[0]);
    for (const name of STRUCTURE_FEATURES) cut.forEach((_, j) => assert.equal(cutCols[name][j], cols[name][offset + j], name));
});

test("the response lists phrases and repeats in milliseconds, at most 64 of each", () => {
    const s = songStructure(abab);
    const r = structureToResponse(s);
    assert.equal(r.phrases.length, s.phrases.length);
    assert.equal(r.phrases[1].startMs, s.bars[s.phrases[1].bar].startMs);
    assert.equal(r.phrases[1].bars, s.phrases[1].bars);
    assert.equal(r.repeats.length, s.repeats.length);
    for (const x of r.repeats) assert.ok(x.aMs < x.bMs && x.lenMs > 0 && x.sim >= 0 && x.sim <= 1);
    const many = { ...s, phrases: Array.from({ length: 100 }, (_, k) => ({ bar: 0, bars: 1 + (k % 2) })), repeats: Array.from({ length: 100 }, () => s.repeats[0]) };
    const capped = structureToResponse(many);
    assert.equal(capped.phrases.length, 64);
    assert.equal(capped.repeats.length, 64);
    assert.doesNotThrow(() => structuredClone(s));
});
