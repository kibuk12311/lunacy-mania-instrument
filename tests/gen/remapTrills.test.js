// Remapping keeps trills of every kind (flavours.js Trills, Minitrills, Jumptrill, SplitTrill, ChordTrills, Rolls):
// easier halves a trill's rhythm and then takes its chords down to single notes, so it stays a trill and gets no jack;
// harder puts no new row inside one and turns single-note trills into whole jumptrills or split trills.
import test from "node:test";
import assert from "node:assert/strict";
import * as remap from "../../src/gen/remap.js";
import { flavourMarks } from "../../src/gen/flavourMetrics.js";

const { parseChart, removalOrder, additionOrder, applyKnob, remapChart } = remap;
const KINDS = ["Trills", "Minitrills", "Jumptrill", "SplitTrill", "ChordTrills", "Rolls"];
const BEAT = 400; // 150 BPM: 1/4 = 100 ms
const T0 = 1000;
const x = (c) => Math.floor(((c + 0.5) * 512) / 4);
const KNOBS = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8, -0.9, -1];

// One red line; each section a pattern of masks (bit c = column c) repeated at `per` rows a beat. Every note has a
// whistle, so a note line that moved keeps something to show.
function mapOf(sections) {
    const objects = [];
    for (const s of sections) {
        for (let k = 0; k < Math.round(s.beats * s.per); k += 1) {
            const t = Math.round(T0 + (s.beat + k / s.per) * BEAT);
            const m = s.masks[k % s.masks.length];
            for (let c = 0; c < 4; c += 1) if (m & (1 << c)) objects.push(`${x(c)},192,${t},1,2,0:0:0:0:`);
        }
    }
    return [
        "osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "Mode: 3", "",
        "[Metadata]", "Title:Trills", "Artist:Tester", "Creator:Someone", "Version:Trills", "Tags:fixture", "BeatmapID:1", "",
        "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "", "[TimingPoints]", `${T0},${BEAT},4,2,0,60,1,0`, "",
        "[HitObjects]", ...objects, "",
    ].join("\r\n");
}
// a jumpjack of four (so the longest jack the original has is 4, and a jack of that length would pass the old guard)
const JUMPJACK = { beat: 0, beats: 4, per: 2, masks: [3, 3, 3, 3, 12, 12, 12, 12] };
// jumps on the beat and singles between, no trill of any kind
const STREAM = (beat, beats = 8) => ({ beat, beats, per: 4, masks: [9, 2, 4, 2] });
const SINGLES = mapOf([
    JUMPJACK,
    { beat: 6, beats: 16, per: 4, masks: [2, 4, 2, 4, 1, 8, 1, 8] }, // 1/4 trills across the hands
    { beat: 23, beats: 16, per: 4, masks: [1, 2, 1, 2, 4, 8, 4, 8] }, // 1/4 trills on one hand
    STREAM(40, 16),
    { beat: 57, beats: 16, per: 2, masks: [1, 2, 4, 8, 4, 2] }, // a 1/2 roll
]);
const JUMPS = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [3, 12] }, { beat: 23, beats: 16, per: 4, masks: [5, 10] }, STREAM(40)]);
const CHORDS = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [7, 8] }, { beat: 23, beats: 16, per: 4, masks: [1, 14] }, STREAM(40)]);
const TRIPLETS = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 3, masks: [2, 4, 2, 4, 1, 8, 1, 8] }, { beat: 23, beats: 8, per: 6, masks: [3, 12] }, STREAM(32)]);
const FIXTURES = { SINGLES, JUMPS, CHORDS, TRIPLETS };

const rowsOf = (text) => parseChart(text).rows;
// the original's trills: [t0, t1] of each stretch of rows some trill kind marks
function trillSpans(rows) {
    const { marks } = flavourMarks(rows, KINDS);
    const spans = [];
    let from = -1;
    for (let i = 0; i <= rows.length; i += 1) {
        const marked = i < rows.length && KINDS.some((k) => marks[k][i]);
        if (marked && from < 0) from = i;
        if (!marked && from >= 0) {
            spans.push([rows[from].t, rows[i - 1].t]);
            from = -1;
        }
    }
    return spans;
}
const inside = (t, spans) => spans.some(([a, b]) => t >= a - 2 && t <= b + 2);
// two rows in a row inside a trill that share a column at most a beat apart
function repeatsInside(rows, spans) {
    const out = [];
    for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        if (inside(a.t, spans) && inside(b.t, spans) && (a.mask & b.mask) && b.t - a.t <= BEAT + 1) out.push(`${a.t}→${b.t}`);
    }
    return out;
}
const objectLines = (text) => text.split("[HitObjects]")[1].split(/\r?\n/).filter((l) => l.split(",").length >= 5);
const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
// rows of a plain two-column trill (a b a b …, rows at most a beat apart), which the detector names only at its end
function plainTrill(rows) {
    const out = new Uint8Array(rows.length);
    for (let i = 0; i + 3 < rows.length; i += 1) {
        const [a, b] = [rows[i].mask, rows[i + 1].mask];
        if (popcount(a) !== 1 || popcount(b) !== 1 || a === b || rows[i + 2].mask !== a || rows[i + 3].mask !== b) continue;
        let close = true;
        for (let k = i + 1; k <= i + 3; k += 1) if (rows[k].t - rows[k - 1].t > BEAT + 1) close = false;
        if (close) out.fill(1, i, i + 4);
    }
    return out;
}
// the share of the rows inside the original's trills that some trill kind still marks; for trills of any kind, a plain
// two-column trill counts too (what a chord trill whose singles are on the beat halves down to)
function trillShare(rows, spans, kinds = KINDS) {
    const { marks } = flavourMarks(rows, KINDS);
    const plain = kinds === KINDS ? plainTrill(rows) : new Uint8Array(rows.length);
    let all = 0;
    let marked = 0;
    rows.forEach((r, i) => {
        if (!inside(r.t, spans)) return;
        all += 1;
        if (plain[i] || kinds.some((k) => marks[k][i])) marked += 1;
    });
    return all ? marked / all : 0;
}

test("the fixtures' trills are what the detector calls trills, without a jack, and nothing else is", () => {
    for (const [name, text] of Object.entries(FIXTURES)) {
        const rows = rowsOf(text);
        const spans = trillSpans(rows);
        assert.ok(spans.length >= 2, name);
        assert.deepEqual(repeatsInside(rows, spans), [], name);
        assert.ok(trillShare(rows, spans) === 1);
        assert.ok(rows.filter((r) => inside(r.t, spans)).length >= 0.6 * rows.length, `${name}: mostly trills`);
    }
});

test("easier never makes a jack inside a trill of any kind, however far it thins", () => {
    for (const [name, text] of Object.entries(FIXTURES)) {
        const chart = parseChart(text);
        const spans = trillSpans(chart.rows);
        for (const seed of [1, 2]) {
            const plan = { removals: removalOrder(chart, { seed }) };
            for (const knob of KNOBS) {
                const rows = rowsOf(applyKnob(chart, plan, knob).osuText);
                assert.deepEqual(repeatsInside(rows, spans), [], `${name} seed ${seed} at ${knob}`);
            }
        }
    }
});

test("easier keeps a trill a trill: halfway down, the rows of every kind of trill still read as trills", () => {
    for (const [name, text] of Object.entries(FIXTURES)) {
        const chart = parseChart(text);
        const spans = trillSpans(chart.rows);
        for (const seed of [1, 2, 3]) {
            const out = applyKnob(chart, { removals: removalOrder(chart, { seed }) }, -0.5);
            assert.ok(out.removed > 0.25 * chart.notes.length, `${name}: it did thin (${out.removed})`);
            const share = trillShare(rowsOf(out.osuText), spans);
            assert.ok(share >= 0.8, `${name} seed ${seed}: ${share.toFixed(2)} of the trill rows are still trills`);
        }
    }
});

test("jumptrills, split trills and chord trills halve before they lose notes, and stay trills", () => {
    // a chord trill with its hands on the beat stays one; with its singles on the beat its hands go down to one note
    // (a trill), as an easier map gets no new note
    for (const [text, kinds, sizes] of [[JUMPS, ["Jumptrill", "SplitTrill"], [2]], [CHORDS, KINDS, [1, 3]]]) {
        const chart = parseChart(text);
        const spans = trillSpans(chart.rows).filter(([a, b]) => b - a > 4 * BEAT);
        for (const seed of [1, 2, 3]) {
            const rows = rowsOf(applyKnob(chart, { removals: removalOrder(chart, { seed }) }, -0.5).osuText);
            const left = rows.filter((r) => inside(r.t, spans));
            assert.ok(left.length <= 0.85 * chart.rows.filter((r) => inside(r.t, spans)).length, "the trills did thin");
            assert.ok(left.every((r) => sizes.includes(popcount(r.mask))), `seed ${seed}: rows keep their size ${left.map((r) => r.mask)}`);
            assert.ok(trillShare(rows, spans, kinds) >= 0.8, `seed ${seed}: still ${kinds}`);
        }
    }
    const chart = parseChart(CHORDS);
    const hands = [T0 + 6 * BEAT, T0 + 22 * BEAT]; // the first section: [012] on the beat, [3] between
    for (const seed of [1, 2, 3]) {
        const rows = rowsOf(applyKnob(chart, { removals: removalOrder(chart, { seed }) }, -0.5).osuText);
        assert.ok(trillShare(rows, [hands], ["ChordTrills"]) >= 0.9, `seed ${seed}: the chord trill with its hands on the beat is one still`);
    }
});

test("a halving that would repeat a column moves the note kept to the other column of its row: only its x changes", () => {
    const chart = parseChart(SINGLES);
    const before = new Map(chart.notes.map((n) => [n.line, n]));
    const out = applyKnob(chart, { removals: removalOrder(chart, { seed: 1 }) }, -0.6);
    assert.ok(out.moved > 0, "some notes moved");
    // a moved note counts once as removed (from its place) and once as added (at the new one); nothing else is added
    assert.equal(out.added, out.moved, "easier adds no note but the moved ones");
    const lines = objectLines(out.osuText);
    assert.equal(lines.length, chart.notes.length - out.removed + out.added);
    const moved = lines.filter((l) => !before.has(l));
    assert.equal(moved.length, out.moved);
    const atTime = new Map(chart.notes.map((n) => [`${n.t}|${n.line.split(",").slice(1).join(",")}`, n]));
    for (const l of moved) {
        const [lx, ...rest] = l.split(",");
        const source = atTime.get(`${rest[1]}|${rest.join(",")}`);
        assert.ok(source, `${l} is an original note's line but for x`);
        assert.notEqual(Number(lx), x(source.col), "on another column");
        assert.equal(rest[3], "2", "with its hitsound");
    }
    const times = lines.map((l) => Number(l.split(",")[2]));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    const seen = new Set(lines.map((l) => `${l.split(",")[2]}|${l.split(",")[0]}`));
    assert.equal(seen.size, lines.length, "no two notes on one spot");
});

test("no row on the beat is left empty, in triplet and 1/6 trills too", () => {
    const chart = parseChart(TRIPLETS);
    for (const seed of [1, 2, 3]) {
        const left = new Set(rowsOf(applyKnob(chart, { removals: removalOrder(chart, { seed }) }, -1).osuText).map((r) => r.t));
        for (const r of chart.rows.filter((row) => row.div === 1)) assert.ok(left.has(r.t), `seed ${seed}: beat row at ${r.t}`);
    }
});

test("harder puts no new row inside a trill, and a single-note trill thickens into whole jumptrills or split trills", () => {
    const chart = parseChart(SINGLES);
    const spans = trillSpans(chart.rows);
    const orig = new Map(chart.rows.map((r) => [r.t, r.mask]));
    let upgraded = 0;
    for (const seed of [1, 2, 3]) {
        const plan = { additions: additionOrder(chart, { seed, model: null }) };
        for (const knob of [0.25, 0.5, 0.75, 1]) {
            const rows = rowsOf(applyKnob(chart, plan, knob).osuText);
            const { marks } = flavourMarks(rows, KINDS);
            assert.deepEqual(repeatsInside(rows, spans), [], `seed ${seed} at ${knob}`);
            rows.forEach((r, i) => {
                if (!inside(r.t, spans)) return;
                assert.ok(orig.has(r.t), `seed ${seed} at ${knob}: a new row at ${r.t} inside a trill`);
                if (r.mask === orig.get(r.t)) return;
                upgraded += 1;
                assert.equal(popcount(r.mask), 2, `${r.t}: a single made a jump`);
                assert.ok(marks.Jumptrill[i] || marks.SplitTrill[i], `seed ${seed} at ${knob}: the row at ${r.t} reads as a jumptrill or split trill`);
            });
        }
    }
    assert.ok(upgraded > 0, "some trill was thickened");
});

test("easier remaps through remapChart keep the trills, report moved notes, and pick the layout that kept the most", async () => {
    const chart = parseChart(SINGLES);
    const spans = trillSpans(chart.rows);
    const n0 = chart.notes.length;
    const seen = [];
    const analyze = async (text) => {
        const notes = objectLines(text).length;
        const numeric = Math.round((10 * notes) / n0 * 10) / 10;
        seen.push({ text, numeric });
        return { kind: "ok", numeric, top3: [{ name: "Stream", share: 1 }] };
    };
    for (const range of [{ lo: 8.5, hi: 9.5 }, { lo: 6.5, hi: 7.5 }]) {
        seen.length = 0;
        const out = await remapChart({ osuText: SINGLES, range, seed: 3 }, analyze, null);
        assert.equal(out.reachable, true);
        assert.equal(out.added, out.moved);
        assert.equal(objectLines(out.osuText).length, n0 - out.removed + out.added);
        assert.ok(Number.isInteger(out.moved));
        const share = (text) => trillShare(rowsOf(text), spans);
        assert.ok(share(out.osuText) >= 0.85, `${range.lo}: ${share(out.osuText)}`);
        const inRange = seen.slice(1).filter((a) => a.numeric >= range.lo && a.numeric < range.hi);
        assert.ok(inRange.length > 1);
        const best = Math.max(...inRange.map((a) => share(a.text)));
        assert.ok(share(out.osuText) >= best - 1e-9, `kept ${share(out.osuText)} of the best ${best}`);
    }
});

test("a plain two-column trill (a b a b …, which the detector names only at its end) is kept as one too", () => {
    // a long stream after them, so both trills fit in what harder may add whole (a trill thickened part of the way
    // reads as an anchor at its end: it thickens as a whole)
    const text = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [1, 2] }, { beat: 23, beats: 16, per: 4, masks: [2, 4] }, STREAM(40, 64)]);
    const chart = parseChart(text);
    const spans = [[T0 + 6 * BEAT, T0 + 22 * BEAT - 100], [T0 + 23 * BEAT, T0 + 39 * BEAT - 100]];
    const orig = new Map(chart.rows.map((r) => [r.t, r.mask]));
    for (const seed of [1, 2]) {
        const removals = removalOrder(chart, { seed });
        for (const knob of KNOBS) {
            const rows = rowsOf(applyKnob(chart, { removals }, knob).osuText);
            assert.deepEqual(repeatsInside(rows, spans), [], `seed ${seed} at ${knob}`);
        }
        const half = rowsOf(applyKnob(chart, { removals }, -0.5).osuText).filter((r) => inside(r.t, spans));
        assert.ok(half.length < 0.9 * chart.rows.filter((r) => inside(r.t, spans)).length, "the trills did thin");
        assert.ok(half.every((r) => popcount(r.mask) === 1), "still single notes");
        const additions = additionOrder(chart, { seed, model: null });
        const rows = rowsOf(applyKnob(chart, { additions }, 1).osuText);
        const { marks } = flavourMarks(rows, KINDS);
        assert.deepEqual(repeatsInside(rows, spans), [], `seed ${seed} harder`);
        let upgraded = 0;
        rows.forEach((r, i) => {
            if (!inside(r.t, spans)) return;
            assert.ok(orig.has(r.t), `a new row at ${r.t} inside a trill`);
            if (r.mask === orig.get(r.t)) return;
            upgraded += 1;
            assert.ok(marks.Jumptrill[i] || marks.SplitTrill[i], `the row at ${r.t} reads as a jumptrill or split trill`);
        });
        assert.ok(upgraded >= 8, `seed ${seed}: ${upgraded} rows thickened`);
    }
});

test("easier thins the trills and the rest of the map at the same rate, so the mix of patterns stays", () => {
    // stream, then a jumptrill, then jumpstream: the trill neither waits until the rest is gone nor goes first
    const MIXED = mapOf([{ beat: 0, beats: 16, per: 4, masks: [9, 2, 4, 2, 6, 1, 8, 4] }, { beat: 17, beats: 16, per: 4, masks: [3, 12] },
        { beat: 34, beats: 16, per: 4, masks: [5, 2, 9, 4, 3, 8, 6, 1] }]);
    for (const [name, text] of Object.entries({ ...FIXTURES, MIXED })) {
        const chart = parseChart(text);
        const spans = trillSpans(chart.rows);
        const notesOf = (rows, inTrill) => rows.filter((r) => inside(r.t, spans) === inTrill).reduce((s, r) => s + r.notes.length, 0);
        const [in0, out0] = [notesOf(chart.rows, true), notesOf(chart.rows, false)];
        for (const seed of [1, 2]) {
            const plan = { removals: removalOrder(chart, { seed }) };
            for (const knob of [-0.1, -0.2, -0.3, -0.5]) {
                const rows = rowsOf(applyKnob(chart, plan, knob).osuText);
                const [a, b] = [1 - notesOf(rows, true) / in0, 1 - notesOf(rows, false) / out0];
                assert.ok(Math.abs(a - b) <= 0.1, `${name} seed ${seed} at ${knob}: ${a.toFixed(2)} of the trills' notes gone, ${b.toFixed(2)} of the rest's`);
            }
        }
    }
});

test("a range out of reach while the trills stay trills is searched once more treating them like any other notes", async () => {
    // an analyzer that rates trills harder: keeping them, the dan cannot get below 4.5
    const chart = parseChart(SINGLES);
    const n0 = chart.notes.length;
    const analyze = async (text) => {
        const rows = rowsOf(text);
        const { marks } = flavourMarks(rows, KINDS);
        const share = rows.filter((_, i) => KINDS.some((k) => marks[k][i])).length / rows.length;
        const numeric = Math.round((10 * objectLines(text).length / n0 + 6 * share) * 10) / 10;
        return { kind: "ok", numeric, top3: [{ name: "Stream", share: 1 }] };
    };
    const keeping = { removals: removalOrder(chart, { seed: 1 }) };
    for (let knob = 0; knob >= -1; knob -= 0.05) assert.ok((await analyze(applyKnob(chart, keeping, knob).osuText)).numeric >= 4, `at ${knob}`);
    const out = await remapChart({ osuText: SINGLES, range: { lo: 3.0, hi: 3.8 }, seed: 1 }, analyze, null);
    assert.equal(out.reachable, true, `got ${out.result.numeric}`);
});

test("missing the range anyway, the trills are not given up for a dan or two: only a plan half a dan closer wins", async () => {
    // an analyzer with a floor: a layout that kept the trills (no column twice in a row inside one) reads at least
    // `keep`, one that broke them at least `broke`; the range [lo, hi) is out of reach either way
    const chart = parseChart(SINGLES);
    const spans = trillSpans(chart.rows);
    const n0 = chart.notes.length;
    const run = async ({ keep, broke, range }) => {
        const analyze = async (text) => {
            const v = Math.round((10 * objectLines(text).length) / n0 * 10) / 10;
            const floor = repeatsInside(rowsOf(text), spans).length ? broke : keep;
            return { kind: "ok", numeric: Math.max(v, floor), top3: [{ name: "Stream", share: 1 }] };
        };
        return remapChart({ osuText: SINGLES, range, seed: 1 }, analyze, null);
    };
    // the plan that breaks the trills reaches hi, which is still out of the range: the trills stay
    const near = await run({ keep: 4.0, broke: 3.9, range: { lo: 3.7, hi: 3.9 } });
    assert.equal(near.reachable, false);
    assert.equal(near.result.numeric, 4.0, "the layout that kept the trills");
    assert.deepEqual(repeatsInside(rowsOf(near.osuText), spans), []);
    // half a dan closer or more, it does win
    const far = await run({ keep: 4.0, broke: 3.4, range: { lo: 2.9, hi: 3.1 } });
    assert.equal(far.reachable, false);
    assert.equal(far.result.numeric, 3.4);
});

test("missing it either way by about as much, the plan that kept the original's pattern mix better wins", async () => {
    // as above, but the original and the layouts that broke the trills read as Jumpstream, the ones that kept them as
    // Stream: the plan that broke them is a step closer, not half a dan, and it is the one with the original's mix
    const chart = parseChart(SINGLES);
    const spans = trillSpans(chart.rows);
    const n0 = chart.notes.length;
    const analyze = async (text) => {
        const v = Math.round((10 * objectLines(text).length) / n0 * 10) / 10;
        const broke = repeatsInside(rowsOf(text), spans).length > 0;
        return { kind: "ok", numeric: Math.max(v, broke ? 3.9 : 4.0), top3: [{ name: text === SINGLES || broke ? "Jumpstream" : "Stream", share: 1 }] };
    };
    const out = await remapChart({ osuText: SINGLES, range: { lo: 3.7, hi: 3.9 }, seed: 1 }, analyze, null);
    assert.equal(out.reachable, false);
    assert.equal(out.result.numeric, 3.9);
    assert.equal(out.result.top3[0].name, "Jumpstream");
});

test("how far a dan is from the range: a dan at hi (which is outside) is a step away, not in it", () => {
    const range = { lo: 10.1, hi: 10.3 };
    assert.equal(remap.missBy(10.2, range), 0);
    assert.equal(remap.missBy(10.1, range), 0);
    assert.ok(Math.abs(remap.missBy(10.3, range) - 0.1) < 1e-9);
    assert.ok(Math.abs(remap.missBy(10.4, range) - 0.2) < 1e-9);
    assert.ok(Math.abs(remap.missBy(9.9, range) - 0.2) < 1e-9);
    assert.equal(remap.missBy(NaN, range), Infinity);
});

test("of the layouts in range, a jumptrill that became a trill of single notes counts as half kept", () => {
    const jumps = mapOf([STREAM(0), { beat: 9, beats: 16, per: 4, masks: [3, 12] }, STREAM(26)]);
    const singles = mapOf([STREAM(0), { beat: 9, beats: 16, per: 4, masks: [1, 4] }, STREAM(26)]);
    const chart = parseChart(jumps);
    const { runs } = remap.trillRuns(chart);
    assert.ok(runs.length > 0);
    assert.ok(Math.abs(remap.trillKept(chart, runs, jumps) - 1) < 0.05, "the jumptrill itself");
    const half = remap.trillKept(chart, runs, singles);
    assert.ok(half > 0.4 && half < 0.6, `the trill of single notes: ${half}`);
});
