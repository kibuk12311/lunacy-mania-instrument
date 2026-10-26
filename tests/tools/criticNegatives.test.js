import test from "node:test";
import assert from "node:assert/strict";
import {
    PERTURBATIONS, perturb, mirrorRows, remapColumns, shuffleBeats, insertJacks, shiftRows, densityNoise, swapSection,
    chartSlots, splitOf, parseList, packRows, unpackRows, readGenCache, planJobs, normalizeMap,
} from "../../tools/make-critic-negatives.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { slotsForTiming } from "../../src/gen/grid.js";
import { mulberry32, deriveSeed } from "../../src/gen/rng.js";

// 150 BPM, 1/4: 100 ms between slots
const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 90000);
const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const beatOf = (r) => slots[r.i].beat;

// a seeded human-like map: singles, jumps, hands, gaps of 1–3 slots
function mapOf(seed, n = 400, from = 8) {
    const rng = mulberry32(seed);
    const rows = [];
    for (let i = from; i < slots.length && rows.length < n; i += rng() < 0.6 ? 1 : 2 + Math.floor(rng() * 2)) {
        const r = rng();
        const mask = r < 0.6 ? 1 << Math.floor(rng() * 4) : r < 0.9 ? [3, 5, 6, 9, 10, 12][Math.floor(rng() * 6)] : [7, 11, 13, 14][Math.floor(rng() * 4)];
        rows.push({ t: slots[i].t, mask, i });
    }
    return rows;
}
const key = (r) => `${r.i}:${r.mask}`;
const frozen = (rows) => JSON.stringify(rows);

test("every perturbation is pure: same seed, same rows; the input is not touched", () => {
    const rows = mapOf(1);
    const donor = { rows: mapOf(2), slots };
    const before = frozen(rows);
    for (const [kind, fn] of Object.entries(PERTURBATIONS)) {
        const a = fn(rows, slots, mulberry32(5), { donor });
        const b = fn(rows, slots, mulberry32(5), { donor });
        assert.deepEqual(a, b, kind);
        assert.equal(frozen(rows), before, `${kind} mutated its input`);
        assert.notDeepEqual(a, rows, `${kind} changed nothing`);
        for (let k = 1; k < a.length; k += 1) assert.ok(a[k].i > a[k - 1].i, `${kind}: sorted, one row per slot`);
        for (const r of a) assert.equal(r.t, slots[r.i].t, `${kind}: rows sit on slots`);
    }
});

test("column remap keeps the row times and sizes and changes columns", () => {
    const rows = mapOf(3);
    const out = remapColumns(rows, slots, mulberry32(1));
    assert.equal(out.length, rows.length);
    let changed = 0;
    out.forEach((r, k) => {
        assert.equal(r.t, rows[k].t);
        assert.equal(popcount(r.mask), popcount(rows[k].mask));
        if (r.mask !== rows[k].mask) changed += 1;
    });
    assert.ok(changed > rows.length * 0.4, `${changed}`);
});

test("beat shuffle moves whole beats inside each bar: same rows per bar, same positions and masks", () => {
    const rows = mapOf(4);
    const out = shuffleBeats(rows, slots, mulberry32(2));
    const perBar = (rs) => {
        const m = new Map();
        for (const r of rs) m.set(Math.floor(beatOf(r) / 4), [...(m.get(Math.floor(beatOf(r) / 4)) ?? []), `${slots[r.i].pos}:${r.mask}`].sort());
        return m;
    };
    assert.deepEqual(perBar(out), perBar(rows));
    assert.ok(out.some((r, k) => r.t !== rows[k].t), "some beat moved");
});

test("jack insertion keeps times and sizes; every changed row jacks with the row before", () => {
    const rows = mapOf(5);
    const out = insertJacks(rows, slots, mulberry32(3));
    assert.equal(out.length, rows.length);
    let changed = 0;
    out.forEach((r, k) => {
        assert.equal(r.t, rows[k].t);
        assert.equal(popcount(r.mask), popcount(rows[k].mask));
        if (r.mask !== rows[k].mask) {
            changed += 1;
            assert.ok(r.mask & out[k - 1].mask, `row ${k} is a jack now`);
        }
    });
    assert.ok(changed >= rows.length * 0.08 && changed <= rows.length * 0.25, `${changed}`);
});

test("row shift moves about 30% of the rows by exactly one slot and keeps the masks", () => {
    const rows = mapOf(6);
    const out = shiftRows(rows, slots, mulberry32(4));
    assert.equal(out.length, rows.length);
    assert.deepEqual(out.map((r) => r.mask).sort(), rows.map((r) => r.mask).sort());
    const before = new Set(rows.map(key));
    const moved = out.filter((r) => !before.has(key(r)));
    assert.ok(moved.length >= rows.length * 0.15 && moved.length <= rows.length * 0.35, `${moved.length}`);
    const at = new Map(rows.map((r) => [r.i, r.mask]));
    for (const r of moved) assert.ok(at.get(r.i - 1) === r.mask || at.get(r.i + 1) === r.mask, `slot ${r.i} came from a neighbour`);
});

test("density noise removes or adds 15% of the rows and keeps the others as they were", () => {
    const rows = mapOf(7);
    const before = new Set(rows.map(key));
    const signs = new Set();
    for (let seed = 1; seed <= 6; seed += 1) {
        const out = densityNoise(rows, slots, mulberry32(deriveSeed(seed, 7)));
        const diff = out.length - rows.length;
        assert.equal(Math.abs(diff), Math.round(0.15 * rows.length), `seed ${seed}`);
        signs.add(Math.sign(diff));
        const after = new Set(out.map(key));
        if (diff < 0) for (const r of out) assert.ok(before.has(key(r)));
        else for (const r of rows) assert.ok(after.has(key(r)));
    }
    assert.deepEqual([...signs].sort(), [-1, 1], "both directions happen");
});

test("section swap replaces one 8-beat section with the donor's rows and nothing else", () => {
    const rows = mapOf(8);
    const donorRows = mapOf(9, 400, 40);
    const out = swapSection(rows, slots, mulberry32(5), { donor: { rows: donorRows, slots } });
    const changedBeats = new Set();
    const before = new Set(rows.map(key));
    const after = new Set(out.map(key));
    for (const r of out) if (!before.has(key(r))) changedBeats.add(beatOf(r));
    for (const r of rows) if (!after.has(key(r))) changedBeats.add(beatOf(r));
    const beats = [...changedBeats].sort((a, b) => a - b);
    assert.ok(beats.length > 0);
    assert.ok(beats.at(-1) - beats[0] < 8, `changes inside one 8-beat section: ${beats}`);
    // the new section is the donor's pattern: positions and masks of some 8 beats of the donor
    const sectionStart = beats[0] - ((beats[0] - beatOf(rows[0])) % 8);
    const mine = out.filter((r) => beatOf(r) >= sectionStart && beatOf(r) < sectionStart + 8).map((r) => `${beatOf(r) - sectionStart}:${slots[r.i].pos}:${r.mask}`);
    const donorSections = new Set();
    const d0 = beatOf(donorRows[0]);
    for (let s = d0; s < beatOf(donorRows.at(-1)); s += 8) {
        donorSections.add(donorRows.filter((r) => beatOf(r) >= s && beatOf(r) < s + 8).map((r) => `${beatOf(r) - s}:${slots[r.i].pos}:${r.mask}`).join(","));
    }
    assert.ok(donorSections.has(mine.join(",")), "the section came from the donor");
});

test("mirroring reverses the columns and is an involution", () => {
    const rows = mapOf(10);
    const m = mirrorRows(rows);
    assert.deepEqual(m.map((r) => r.t), rows.map((r) => r.t));
    assert.equal(mirrorRows([{ t: 0, i: 0, mask: 0b0001 }])[0].mask, 0b1000);
    assert.equal(mirrorRows([{ t: 0, i: 0, mask: 0b0110 }])[0].mask, 0b0110);
    assert.deepEqual(mirrorRows(m), rows);
});

test("perturb picks a kind, falls back when it changed nothing, and swaps only with a donor", () => {
    const rows = mapOf(11);
    const kinds = new Set();
    for (let seed = 1; seed <= 40; seed += 1) {
        const { kind, rows: out } = perturb(rows, slots, mulberry32(seed));
        kinds.add(kind);
        assert.notDeepEqual(out, rows);
    }
    assert.ok(!kinds.has("swapSection"), "no donor, no swap");
    assert.ok(kinds.size >= 4, [...kinds].join());
    // a full 1/4 stream has no free slot to shift into: shiftRows falls back to another kind
    const full = slots.slice(0, 200).map((s, i) => ({ t: s.t, mask: 1 << (i % 4), i }));
    const { kind } = perturb(full, slots, mulberry32(1), { kinds: ["shiftRows", "remapColumns"] });
    assert.equal(kind, "remapColumns");
});

test("chart slots: the human map's grid from 2 s before its first row to 1 s after its last", () => {
    const points = [{ time: 1000, beatLength: 400 }];
    const rows = [{ t: 5000, mask: 1 }, { t: 9000, mask: 2 }];
    const s = chartSlots(points, rows, 60000);
    assert.equal(s[0].t, 3000);
    assert.equal(s.at(-1).t, 9900, "the last slot before last row + 1 s");
    assert.ok(s.every((x) => x.div === 4 && x.beatMs === 400));
    assert.equal(chartSlots(points, rows, 9500).at(-1).t, 9400, "audio end − 50 ms caps it");
});

test("split: held-out sets are test, train song groups go to val by crc32 % 10 == 1", () => {
    assert.equal(splitOf({ split: "heldout", group: "a" }), "test");
    assert.equal(splitOf({ split: "test", group: "a" }), "test");
    assert.equal(splitOf({ split: "val", group: "a" }), "val");
    const groups = Array.from({ length: 400 }, (_, k) => `song|${k}`);
    const val = groups.filter((g) => splitOf({ split: "train", group: g }) === "val").length;
    assert.ok(val > 20 && val < 70, `${val}`);
    assert.equal(splitOf({ split: "train", group: "song|1" }), splitOf({ split: "train", group: "song|1" }));
    assert.equal(splitOf({ split: "quarantine", group: "a" }), null);
});

test("section-swap donors come from the song's own split: train, val and test pools never mix", () => {
    const songs = [];
    for (let k = 0; k < 60; k += 1) {
        const split = ["train", "val", "test"][k % 3];
        songs.push({ song: `s${k}`, audio: `a${k}`, split, maps: [{ id: `m${k}`, dan: 5 + (k % 2) * 0.2, audio: `a${k}`, osuPath: `${split}/${k}.osu` }] });
    }
    const jobs = planJobs(songs, { perSong: 2, seed: 3 });
    let donors = 0;
    for (const j of jobs) {
        for (const [id, d] of Object.entries(j.donors)) {
            donors += 1;
            assert.equal(d.split, j.split, `${id}`);
            assert.ok(d.osuPath.startsWith(`${j.split}/`), `${id} (${j.split}) got a donor from ${d.osuPath}`);
            assert.notEqual(d.osuPath, j.maps.find((m) => m.id === id).osuPath, "never its own song");
        }
    }
    assert.equal(donors, 60);
    assert.deepEqual(planJobs(songs, { perSong: 2, seed: 3 }), jobs, "deterministic per seed");
});

test("mapper3 index lines: dan, group, off-grid share, creatorKey and the sharded .f32 path", () => {
    const v3 = normalizeMap({ id: "ab12cd", songGroup: "g|x", danOurs: 6.1, danTracker: 5.8, residualOffgrid: 0.01, audioPath: "A:/x.mp3",
        osuPath: "A:/x.osu", beatmapSetId: 9, creatorKey: "u:7", creatorName: "Seven", split: "val" });
    assert.equal(v3.dan, 5.8, "the tracker's dan when known, like mapper15's dan");
    assert.equal(v3.group, "g|x");
    assert.equal(v3.offgridShare, 0.01);
    assert.equal(v3.audio, "A:/x.mp3");
    assert.equal(v3.setId, 9);
    assert.equal(v3.f32, "maps/ab/ab12cd.f32");
    assert.equal(splitOf(v3), "val");
    assert.equal(normalizeMap({ id: "ab12cd", songGroup: "g", danOurs: 6.1, danTracker: null }).dan, 6.1);
    const v15 = normalizeMap({ id: "3_1", group: "g", dan: 4, offgridShare: 0.1 });
    assert.equal(v15.f32, "maps/3_1.f32");
    assert.equal(v15.dan, 4);
});

test("negative mix parsing", () => {
    assert.deepEqual(parseList("gen:1,perturb:2"), { gen: 1, perturb: 2 });
    assert.throws(() => parseList("gen:x"));
    assert.throws(() => parseList("other:1"));
});

test("generated rows round-trip through the gen-rows.jsonl cache", async () => {
    const rows = [{ t: 1000, mask: 1 }, { t: 1107, mask: 6 }, { t: 1214, mask: 15 }];
    const packed = packRows(rows);
    assert.deepEqual(packed, { t: [1000, 107, 107], m: [1, 6, 15] });
    assert.deepEqual(unpackRows(packed), rows);
    const dir = await mkdtemp(path.join(tmpdir(), "critic-cache-"));
    try {
        const file = path.join(dir, "gen-rows.jsonl");
        const lines = [
            JSON.stringify({ key: "12_0|gen|2", map: "12_0", kind: "gen", seed: 2, forced: 3, ...packed }),
            JSON.stringify({ key: "13_1|v2|1", map: "13_1", kind: "v2", seed: 1, forced: 0, t: [5], m: [8] }),
            "garbage",
        ];
        await writeFile(file, `${lines.join("\n")}\n`);
        const cache = await readGenCache(file);
        assert.deepEqual([...cache.keys()], ["12_0|gen|2", "13_1|v2|1"]);
        assert.deepEqual(unpackRows(JSON.parse(cache.get("12_0|gen|2"))), rows);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
