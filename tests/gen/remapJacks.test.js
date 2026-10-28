// Remapping makes no minijack or anchor the original did not have unless allowJacks says it may (the remap panel's
// «Можно миниджеки и анкоры»): easier never brings two rows of one column next to each other or shifts a column onto
// every other row, harder never puts a note there; with allowJacks they come, but only after every note that makes none.
import test from "node:test";
import assert from "node:assert/strict";
import * as remap from "../../src/gen/remap.js";
import { flavourMarks } from "../../src/gen/flavourMetrics.js";

const { parseChart, removalOrder, additionOrder, applyKnob, remapChart } = remap;
const BEAT = 400; // 150 BPM: 1/4 = 100 ms
const T0 = 1000;
const x = (c) => Math.floor(((c + 0.5) * 512) / 4);
const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
const KNOBS = [0.1, 0.25, 0.5, 0.75, 1];
const ANCHOR_HITS = 5; // a x a y a x a: players call a column on every other row an anchor from five hits on

// One red line; each section a pattern of masks (bit c = column c) repeated at `per` rows a beat; the rows at `holds`
// (indexes into the pattern) are short holds; drift(k): ms the section's row k is late (a mapper's rounding).
function mapOf(sections) {
    const objects = [];
    for (const s of sections) {
        for (let k = 0; k < Math.round(s.beats * s.per); k += 1) {
            const t = Math.round(T0 + (s.beat + k / s.per) * BEAT) + (s.drift?.(k) ?? 0);
            const m = s.masks[k % s.masks.length];
            const hold = s.holds?.includes(k % s.masks.length);
            for (let c = 0; c < 4; c += 1) {
                if (m & (1 << c)) objects.push(hold ? `${x(c)},192,${t},128,0,${t + BEAT / 8}:0:0:0:0:` : `${x(c)},192,${t},1,0,0:0:0:0:`);
            }
        }
    }
    return [
        "osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "Mode: 3", "",
        "[Metadata]", "Title:Jacks", "Artist:Tester", "Creator:Someone", "Version:Jacks", "Tags:fixture", "BeatmapID:1", "",
        "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "", "[TimingPoints]", `${T0},${BEAT},4,2,0,60,1,0`, "",
        "[HitObjects]", ...objects, "",
    ].join("\r\n");
}
// a jumpjack of four at 1/2 (so the longest jack the original has is 4: the old guard let jacks that long anywhere)
const JUMPJACK = { beat: 0, beats: 4, per: 2, masks: [3, 3, 3, 3, 12, 12, 12, 12] };
// 1/4 jumpstream whose jumps share a column: [02] 1 [03] 2 … — no jack, no trill, but taking out the singles between
// would bring the jumps next to each other
const SHARED = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [5, 2, 9, 4, 6, 1, 10, 4] }]);
// 1/2 jumpstream without a jack, where harder puts rows between the rows, then a 1/4 stream of singles
const SPARSE = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 2, masks: [5, 2, 8, 3, 4, 9, 2, 8] }, { beat: 24, beats: 12, per: 4, masks: [1, 4, 2, 8, 4, 1, 8, 2] }]);
// a 1/4 stream whose rows on the beat and the half beat (a hold) are column 0: the only notes easier may take out are
// the quarter ones between, and each of those would bring two of them next to each other
const HELD = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [1, 2, 1, 4], holds: [2] }]);
// the jump [01] twice and then [02] (all but [02] holds): its own jack, which the analyzer does not call a minijack
// (the row after keeps column 0), but [01] [01] [2], or [01] [01] [3] with [02] gone, would be one
const JUMP_TWICE = mapOf([{ beat: 0, beats: 16, per: 4, masks: [3, 3, 5, 8], holds: [0, 1, 3] }]);
// a 1/4 stream of single notes where column 0 comes on every other row three times (rows 0-4), skips a row (6), three
// times more (8-12), then a jack (12-13) and every other row again: one chain of column 0 from row 8 with 8 hits, but
// no run on every other row longer than 4. Column 0 on row 6 would join rows 0-12 into one run of 7.
const JOIN = [1, 2, 1, 4, 1, 2, 8, 4, 1, 2, 1, 4, 1, 1, 8, 1, 2, 1, 4, 1, 8, 1, 2, 4, 8, 2, 4, 8];
const JOINED = mapOf([{ beat: 0, beats: JOIN.length / 4, per: 4, masks: JOIN }]);
// a 1/4 stream of singles without every-other-row runs (rows 100 ms apart: the analyzer's motif break is 260 ms)
const STREAM = { beat: 0, beats: 16, per: 4, masks: [1, 4, 2, 8, 4, 1, 8, 2] };
// STREAM, then a 1/2 stream whose rows on the beat are 0 1 0 3 0 1 0 3 0 1: column 0 on every fourth row. Thinned to
// 1/2 and 1/1, the stream's rows are 200 ms apart (the break 520 ms) and the beats' column 0 comes on every other row
// five times, 400 ms apart: past the original's break, inside the thinned map's.
const SPREAD = mapOf([STREAM, { beat: 18, beats: 10, per: 2, masks: [1, 4, 2, 8, 1, 4, 8, 2] }]);
// STREAM, then 12 rows of holds (easier takes none out) at 1/4 that the analyzer reads as an Anchor (column 0 on every
// other row, three jumps) but for a 300 ms gap halfway: past the original's motif break (260 ms), so it marks none of
// them. Once most of the stream is thinned to 1/2, the break is 520 ms and those 12 rows are an Anchor, far from any
// change.
const ALL_HELD = [0, 1, 2, 3, 4, 5];
const HELD_ANCHOR = [{ beat: 20, beats: 1.5, per: 4, masks: [1, 2, 1, 12, 1, 2], holds: ALL_HELD },
    { beat: 22, beats: 1.5, per: 4, masks: [1, 12, 1, 4, 1, 10], holds: ALL_HELD }];
const LATENT = mapOf([STREAM, ...HELD_ANCHOR]);
// STREAM thinned to 1/2 (its rows on the beat and the half beat)
const STREAM_HALF = { ...STREAM, per: 2, masks: [1, 2, 4, 8] };
// HELD with its rows on the half beat (the holds) 2 ms late, as a mapper's rounding leaves them: taking out the quarter
// note before one brings column 0 together 202 ms apart, 2 ms over half a beat
const DRIFT = (k) => (k % 4 === 2 ? 2 : 0);
const HELD_DRIFT = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [1, 2, 1, 4], holds: [2], drift: DRIFT }]);
// SPARSE with its 1/2 jumpstream's rows off the beat 2 ms late (gaps 202 and 198 ms), where harder puts notes onto rows
const SPARSE_DRIFT = mapOf([JUMPJACK, { beat: 6, beats: 16, per: 2, masks: [5, 2, 8, 3, 4, 9, 2, 8], drift: (k) => (k % 2 ? 2 : 0) },
    { beat: 24, beats: 12, per: 4, masks: [1, 4, 2, 8, 4, 1, 8, 2] }]);
// a 1/4 stream with [03] three times twice in it, each followed by 1 2 3 0: the analyzer marks the second and third jump
// and the single after them Minijacks. Taking out that single (the plan's rules see the original's own jump twice there)
// marks the row after it, and every longer prefix of the plan stays marked until a later change takes the jump apart.
const TRIPLET = { beats: 2, per: 4, masks: [9, 9, 9, 2, 4, 8, 1, 2] };
const TRIPLETS = mapOf([STREAM, { ...TRIPLET, beat: 16 }, { ...STREAM, beat: 18, beats: 8 }, { ...TRIPLET, beat: 26 }, { ...STREAM, beat: 28, beats: 8 }]);
// STREAM, then the jump [03] six times at 1/2: harder putting new rows between them makes columns 0 and 3 each come on
// every other row six times (where the original had them on six rows in a row)
const JUMPJACK_HALF = { beat: 17, beats: 3, per: 2, masks: [9] };
const SPLIT = mapOf([STREAM, JUMPJACK_HALF]);

const rowsOf = (text) => parseChart(text).rows.filter((r) => r.mask);
const near = (a, b) => b.t - a.t <= BEAT / 2 + 1;
const nearDrift = (a, b) => b.t - a.t <= BEAT / 2 + 3; // a jack at 1/2 with a mapper's 1-2 ms of rounding
const together = (a, b) => b.t - a.t <= 250; // the fixtures' rows are 100 or 200 ms apart, their sections over a beat
// the analyzer's motif break for a map's rows (flavourMetrics.js chains): 2.6 × the median row step, at least 250 ms
function motifBreak(rows) {
    const gaps = rows.slice(1).map((r, i) => r.t - rows[i].t).sort((a, b) => a - b);
    return Math.max(250, 2.6 * (gaps[Math.floor(gaps.length / 2)] ?? 0));
}
const notesOf = (text) => text.split("[HitObjects]")[1].split(/\r?\n/).filter((l) => l.split(",").length >= 5).length;
// Jacks (two rows in a row sharing a column within half a beat) the original did not have: one it had has those
// columns on every original row from the one to the other, each two in a row a jack (a jack the remap only thinned).
function newJacks(origRows, rows, close = near) {
    const out = [];
    for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        const shared = a.mask & b.mask;
        if (!shared || !close(a, b)) continue;
        const span = origRows.filter((r) => r.t >= a.t - 2 && r.t <= b.t + 2);
        const had = span.length >= 2 && Math.abs(span[0].t - a.t) <= 2 && Math.abs(span.at(-1).t - b.t) <= 2
            && span.every((r, k) => (r.mask & shared) === shared && (k === 0 || close(span[k - 1], r)));
        if (!had) out.push(`${a.t}→${b.t}`);
    }
    return out;
}
// Runs of column bit on every other row (the row between without it, rows close together): { i, j, hits, trill }
function everyOther(rows, bit, close = together) {
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
        if (!(rows[i].mask & bit) || (i >= 2 && rows[i - 2].mask & bit && !(rows[i - 1].mask & bit) && close(rows[i - 2], rows[i - 1]) && close(rows[i - 1], rows[i]))) continue;
        let hits = 1;
        let j = i;
        while (j + 2 < rows.length && !(rows[j + 1].mask & bit) && rows[j + 2].mask & bit && close(rows[j], rows[j + 1]) && close(rows[j + 1], rows[j + 2])) {
            hits += 1;
            j += 2;
        }
        const span = rows.slice(i, j + 1);
        out.push({ t0: rows[i].t, t1: rows[j].t, hits, trill: span.every((r, k) => popcount(r.mask) === 1 && r.mask === span[k % 2].mask) });
    }
    return out;
}
// Anchors the original did not have: a column on every other row at least five times, whatever the rows between
// have, longer than every such run of that column the original had there and, where every row of it is one the
// original had (its own jack thinned), than any one chain of that column's hits on the original's rows at most two
// apart that holds the whole run; a trill (two rows of one note each taking turns) is none. And the analyzer's own (flavourMetrics.js Anchor and Minijacks): rows it marks in the remap that it did not
// mark in the original.
function newAnchors(origRows, rows) {
    const chains = [0, 1, 2, 3].map((c) => {
        const out = [];
        let last = -9;
        origRows.forEach((r, i) => {
            if (!(r.mask & (1 << c))) return;
            if (i - last <= 2 && origRows.slice(last + 1, i + 1).every((q, k) => together(origRows[last + k], q))) {
                out.at(-1).t1 = r.t;
                out.at(-1).hits += 1;
            } else {
                out.push({ t0: r.t, t1: r.t, hits: 1 });
            }
            last = i;
        });
        return out;
    });
    const found = [];
    for (let c = 0; c < 4; c += 1) {
        const had = everyOther(origRows, 1 << c);
        for (const { t0, t1, hits, trill } of everyOther(rows, 1 << c)) {
            if (hits < ANCHOR_HITS || trill) continue;
            const runs = had.filter((h) => h.t1 >= t0 - 2 && h.t0 <= t1 + 2).map((h) => h.hits);
            const thinned = rows.filter((r) => r.t >= t0 - 2 && r.t <= t1 + 2).every((r) => origRows.some((q) => Math.abs(q.t - r.t) <= 2));
            const holding = thinned ? chains[c].filter((h) => h.t0 <= t0 + 2 && h.t1 >= t1 - 2).map((h) => h.hits) : [];
            if (hits > Math.max(0, ...runs, ...holding)) found.push(`col ${c} ×${hits} at ${t0}`);
        }
    }
    return [...found, ...analyzerNew(origRows, rows)];
}
function analyzerNew(origRows, rows) {
    const ids = ["Anchor", "Minijacks"];
    const was = flavourMarks(origRows, ids).marks;
    const now = flavourMarks(rows, ids).marks;
    const marked = new Map(ids.map((id) => [id, new Set(origRows.filter((_, i) => was[id][i]).map((r) => r.t))]));
    const out = [];
    for (const id of ids) rows.forEach((r, i) => {
        if (now[id][i] && !marked.get(id).has(r.t)) out.push(`${id} at ${r.t}`);
    });
    return out;
}

// pattern models: one that would put every new note into a jack (it repeats the last row's columns), one that would
// make anchors (it repeats the columns of the row two back)
function lover(wants) {
    const pattern = {};
    for (const family of ["Jumpstream", "Stream", "Handstream", "Jack", "Chordjack", "Tech"]) {
        pattern[family] = {};
        for (let prev = 0; prev < 16; prev += 1) {
            for (let prev2 = 0; prev2 < 16; prev2 += 1) {
                for (let size = 1; size <= 3; size += 1) {
                    const masks = {};
                    for (let m = 1; m < 16; m += 1) if (popcount(m) === size) masks[m] = wants(m, prev, prev2) ? 1000 : 1;
                    pattern[family][`${prev},${prev2},${size}`] = masks;
                }
            }
        }
    }
    return { pattern };
}
const jackLover = lover((m, prev) => (m & prev) !== 0);
const anchorLover = lover((m, prev, prev2) => (m & prev2) !== 0 && !(m & prev));

test("the fixtures: no jack or anchor counts as new against itself, and thinning SHARED's singles would join its jumps", () => {
    for (const text of [SHARED, SPARSE]) {
        const rows = rowsOf(text);
        assert.deepEqual(newJacks(rows, rows), []);
        assert.deepEqual(newAnchors(rows, rows), []);
        assert.deepEqual(remap.freshPatterns(parseChart(text), text), { jacks: 0, anchors: 0 });
        assert.equal(remap.maxJackOf(rows), 4);
    }
    const rows = rowsOf(SHARED);
    const jumpsOnly = rows.filter((r) => popcount(r.mask) === 2 && r.t > T0 + 5 * BEAT);
    assert.ok(newJacks(rows, jumpsOnly).length > 10, "the jumps alone are jacks the original did not have");
});

test("two short runs on every other row joined into one are a new anchor, though a longer chain of that column is near", () => {
    const chart = parseChart(JOINED);
    assert.deepEqual(remap.freshPatterns(chart, JOINED), { jacks: 0, anchors: 0 });
    const joined = mapOf([{ beat: 0, beats: JOIN.length / 4, per: 4, masks: JOIN.map((m, k) => (k === 6 ? m | 1 : m)) }]);
    assert.equal(remap.freshPatterns(chart, joined).anchors, 1);
    assert.equal(newAnchors(rowsOf(JOINED), rowsOf(joined)).length, 1);
    // and harder never puts it there, even with a model that wants it
    for (const seed of [1, 2, 3, 4, 5]) {
        const additions = additionOrder(chart, { seed, model: anchorLover });
        assert.ok(!additions.some((a) => a.t === rowsOf(JOINED)[6].t && a.col === 0), `seed ${seed}`);
        for (const knob of KNOBS) {
            const out = applyKnob(chart, { additions }, knob).osuText;
            assert.deepEqual(remap.freshPatterns(chart, out).anchors, 0, `seed ${seed} at ${knob}`);
            // column 0 (the others may thicken into a jumptrill, which is none)
            assert.deepEqual(newAnchors(rowsOf(JOINED), rowsOf(out)).filter((a) => a.startsWith("col 0")), [], `seed ${seed} at ${knob}`);
        }
    }
});

test("a column on every other row three or four times is no anchor; five times, more than the original had there, is one", () => {
    const pattern = [2, 4, 8, 4, 2, 8, 4, 8];
    const base = mapOf([{ beat: 0, beats: 8, per: 4, masks: pattern }]);
    const chart = parseChart(base);
    assert.deepEqual(remap.freshPatterns(chart, base), { jacks: 0, anchors: 0 });
    // column 0 (which the original never has) on rows 10, 12, … instead of what they had
    const masks = (hits) => Array.from({ length: 32 }, (_, k) => (k >= 10 && k <= 10 + 2 * (hits - 1) && k % 2 === 0 ? 1 : pattern[k % 8]));
    for (const [hits, anchors] of [[3, 0], [4, 0], [5, 1], [6, 1]]) {
        const out = mapOf([{ beat: 0, beats: 8, per: 4, masks: masks(hits) }]);
        assert.deepEqual(remap.freshPatterns(chart, out), { jacks: 0, anchors }, `${hits} hits`);
        assert.equal(newAnchors(rowsOf(base), rowsOf(out)).length, anchors, `${hits} hits`);
    }
});

test("easier makes no minijack or anchor the original did not have, however far it thins", () => {
    const chart = parseChart(SHARED);
    const orig = rowsOf(SHARED);
    for (const seed of [1, 2, 3]) {
        const removals = removalOrder(chart, { seed });
        for (const knob of KNOBS) {
            const out = applyKnob(chart, { removals }, -knob);
            const rows = rowsOf(out.osuText);
            assert.deepEqual(newJacks(orig, rows), [], `seed ${seed} at −${knob}`);
            assert.deepEqual(newAnchors(orig, rows), [], `seed ${seed} at −${knob}`);
            assert.deepEqual(remap.freshPatterns(chart, out.osuText), { jacks: 0, anchors: 0 }, `seed ${seed} at −${knob}`);
        }
        assert.ok(applyKnob(chart, { removals }, -1).removed > 0.3 * chart.notes.length, "it still thins a lot");
    }
});

test("easier: a column thinned onto every other row is an anchor by the thinned map's motif break, not the original's", () => {
    const chart = parseChart(SPREAD);
    const orig = rowsOf(SPREAD);
    // thinned to 1/2 and 1/1, the beats' column 0 on every other row five times, 400 ms apart: freshPatterns counts it
    const thinned = mapOf([STREAM_HALF, { beat: 18, beats: 10, per: 1, masks: [1, 2, 1, 8] }]);
    assert.equal(remap.freshPatterns(chart, thinned).anchors, 1);
    for (const seed of [1, 2, 3]) {
        const removals = removalOrder(chart, { seed });
        for (const knob of KNOBS) {
            const out = applyKnob(chart, { removals }, -knob).osuText;
            const rows = rowsOf(out);
            const gap = motifBreak(rows);
            const close = (a, b) => b.t - a.t <= gap;
            for (let c = 0; c < 4; c += 1) {
                const had = Math.max(0, ...everyOther(orig, 1 << c, close).map((r) => r.hits));
                const fresh = everyOther(rows, 1 << c, close).filter((r) => !r.trill && r.hits >= ANCHOR_HITS && r.hits > had);
                assert.deepEqual(fresh.map((r) => `col ${c} ×${r.hits} at ${r.t0}`), [], `seed ${seed} at −${knob}`);
            }
            assert.deepEqual(remap.freshPatterns(chart, out), { jacks: 0, anchors: 0 }, `seed ${seed} at −${knob}`);
        }
        assert.ok(applyKnob(chart, { removals }, -1).removed > 0.3 * chart.notes.length, "it still thins a lot");
    }
});

test("easier does not make the original's own jump jack a minijack it did not have", () => {
    const chart = parseChart(JUMP_TWICE);
    const orig = rowsOf(JUMP_TWICE);
    assert.deepEqual(analyzerNew(orig, orig), []);
    assert.equal(flavourMarks(orig, ["Minijacks"]).marks.Minijacks.reduce((a, b) => a + b, 0), 0, "none in the original");
    for (const seed of [1, 2, 3]) {
        const removals = removalOrder(chart, { seed });
        for (const knob of KNOBS) {
            const out = applyKnob(chart, { removals }, -knob);
            assert.deepEqual(newAnchors(orig, rowsOf(out.osuText)), [], `seed ${seed} at −${knob}`);
            assert.deepEqual(remap.freshPatterns(chart, out.osuText), { jacks: 0, anchors: 0 }, `seed ${seed} at −${knob}`);
        }
        // what is left to take out: column 2 of [02] (column 0 stays on all three)
        assert.ok(applyKnob(chart, { removals }, -1).removed > 0, "it still thins");
    }
});

test("harder makes no minijack or anchor the original did not have, even with a model that wants them", () => {
    for (const [name, model] of [["jacks", jackLover], ["anchors", anchorLover], ["none", null]]) {
        // SHARED is a 1/4 jumpstream: its singles have no column the rows around lack, so it gets next to nothing
        for (const [text, least] of [[SPARSE, 0.3], [SHARED, 0]]) {
            const chart = parseChart(text);
            const orig = rowsOf(text);
            for (const seed of [1, 2, 3]) {
                const additions = additionOrder(chart, { seed, model });
                assert.ok(additions.length >= least * chart.notes.length, `${name} seed ${seed}: it still adds (${additions.length})`);
                for (const knob of KNOBS) {
                    const out = applyKnob(chart, { additions }, knob);
                    const rows = rowsOf(out.osuText);
                    assert.deepEqual(newJacks(orig, rows), [], `${name} seed ${seed} at ${knob}`);
                    assert.deepEqual(newAnchors(orig, rows), [], `${name} seed ${seed} at ${knob}`);
                    assert.deepEqual(remap.freshPatterns(chart, out.osuText), { jacks: 0, anchors: 0 });
                }
            }
        }
    }
});

test("with jacks allowed they may come, but only after every note that makes none", () => {
    for (const [name, model] of [["jacks", jackLover], ["anchors", anchorLover]]) {
        const chart = parseChart(SPARSE);
        const orig = rowsOf(SPARSE);
        let fresh = 0;
        for (const seed of [1, 2, 3]) {
            const strict = additionOrder(chart, { seed, model });
            const loose = additionOrder(chart, { seed, model, jacks: true });
            assert.deepEqual(loose.slice(0, strict.length), strict, `${name} seed ${seed}: the clean notes first, the same`);
            assert.ok(loose.length > strict.length, `${name} seed ${seed}: more after them`);
            const all = rowsOf(applyKnob(chart, { additions: loose }, 1).osuText);
            fresh += newJacks(orig, all).length + newAnchors(orig, all).length;
            // never a jack longer than the original's longest
            assert.ok(remap.maxJackOf(all) <= remap.maxJackOf(orig));
        }
        assert.ok(fresh > 0, `${name}: allowed, the model gets some`);
    }
    // easier: a removal that would bring two rows of one column together waits until all the others are done (the
    // stream's 0 1 0 2 reads as a minitrill: treated as plain notes here, the trill rule would never let one go)
    const chart = parseChart(HELD);
    const orig = rowsOf(HELD);
    for (const seed of [1, 2, 3]) {
        const strict = removalOrder(chart, { seed, trills: false });
        const loose = removalOrder(chart, { seed, trills: false, jacks: true });
        assert.deepEqual(loose.slice(0, strict.length), strict, `seed ${seed}: the clean removals first, the same`);
        assert.ok(strict.length > 0 && loose.length > strict.length, `seed ${seed}: ${strict.length} then ${loose.length}`);
        assert.deepEqual(newJacks(orig, rowsOf(applyKnob(chart, { removals: strict }, -1).osuText)), []);
        const all = rowsOf(applyKnob(chart, { removals: loose }, -1).osuText);
        assert.ok(newJacks(orig, all).length > 0, `seed ${seed}: allowed, they come at the end`);
        assert.ok(remap.maxJackOf(all) <= remap.maxJackOf(orig), "never longer than the original's longest");
    }
});

test("remapChart makes none by default and misses a range out of reach without them; allowJacks: true reaches it", async () => {
    // SHARED: next to no clean addition (its singles have no column the rows around lack), many with jacks
    const chart = parseChart(SHARED);
    const n0 = chart.notes.length;
    const notes = (text) => text.split("[HitObjects]")[1].split(/\r?\n/).filter((l) => l.split(",").length >= 5).length;
    const analyze = async (text) => {
        const numeric = Math.round((10 * notes(text)) / n0 * 10) / 10;
        return { kind: "ok", numeric, top3: [{ name: "Jumpstream", share: 1 }] };
    };
    // the most notes a layout without new jacks gets, over the seeds a search tries
    const seeds = [1, 1 + 7919, 1 + 2 * 7919, 1 + 3 * 7919, 1 + 104729];
    const strictMost = Math.max(...seeds.map((s) => additionOrder(chart, { seed: s, model: jackLover }).length));
    const looseLeast = Math.min(...seeds.map((s) => additionOrder(chart, { seed: s, model: jackLover, jacks: true }).length));
    assert.ok(looseLeast > strictMost + 0.05 * n0, `${strictMost} vs ${looseLeast}`);
    const lo = Math.ceil((10 * (n0 + strictMost + 0.02 * n0)) / n0 * 10) / 10;
    const range = { lo, hi: lo + 0.2 };
    assert.ok((10 * (n0 + looseLeast)) / n0 >= range.hi, "in reach with jacks");
    const strict = await remapChart({ osuText: SHARED, range, seed: 1 }, analyze, jackLover);
    assert.equal(strict.reachable, false);
    assert.ok(strict.added <= strictMost);
    assert.deepEqual(newJacks(rowsOf(SHARED), rowsOf(strict.osuText)), []);
    for (const allowJacks of ["yes", 1, null]) {
        const odd = await remapChart({ osuText: SHARED, range, seed: 1, allowJacks }, analyze, jackLover);
        assert.equal(odd.osuText, strict.osuText, `allowJacks ${JSON.stringify(allowJacks)} counts as false`);
    }
    const loose = await remapChart({ osuText: SHARED, range, seed: 1, allowJacks: true }, analyze, jackLover);
    assert.equal(loose.reachable, true, `got ${loose.result.numeric}`);
    assert.ok(loose.added > strictMost);
});

test("allowJacks: true takes the clean changes alone when they reach the range, and else as few that make jacks as it can", async () => {
    const chart = parseChart(SPARSE);
    const n0 = chart.notes.length;
    const notes = (text) => text.split("[HitObjects]")[1].split(/\r?\n/).filter((l) => l.split(",").length >= 5).length;
    const analyze = async (text) => ({ kind: "ok", numeric: Math.round((10 * notes(text)) / n0 * 10) / 10, top3: [{ name: "Jumpstream", share: 1 }] });
    // in reach without new jacks: the same map as without allowJacks
    const range = { lo: 10.5, hi: 10.9 };
    const strict = await remapChart({ osuText: SPARSE, range, seed: 1 }, analyze, jackLover);
    assert.equal(strict.reachable, true);
    const loose = await remapChart({ osuText: SPARSE, range, seed: 1, allowJacks: true }, analyze, jackLover);
    assert.equal(loose.osuText, strict.osuText);
    assert.deepEqual(newJacks(rowsOf(SPARSE), rowsOf(loose.osuText)), []);
    // out of reach without them (SHARED: next to no clean addition), and a wide range: just past the clean changes, not
    // as far as the plan goes
    const shared = parseChart(SHARED);
    const s0 = shared.notes.length;
    const seeds = [1, 1 + 7919, 1 + 2 * 7919, 1 + 3 * 7919, 1 + 104729];
    const strictMost = Math.max(...seeds.map((s) => additionOrder(shared, { seed: s, model: jackLover }).length));
    const looseLeast = Math.min(...seeds.map((s) => additionOrder(shared, { seed: s, model: jackLover, jacks: true }).length));
    const lo = Math.ceil((10 * (s0 + strictMost + 1)) / s0 * 10) / 10;
    const byShared = async (text) => ({ kind: "ok", numeric: Math.round((10 * notes(text)) / s0 * 10) / 10, top3: [{ name: "Jumpstream", share: 1 }] });
    const far = await remapChart({ osuText: SHARED, range: { lo, hi: 99 }, seed: 1, allowJacks: true }, byShared, jackLover);
    assert.equal(far.reachable, true);
    assert.ok(far.added < looseLeast - 2, `${far.added} of ${strictMost}…${looseLeast}`);
});

test("remapChart never gives the analyzer an Anchor row where the original had none, even one far from every change", async () => {
    const chart = parseChart(LATENT);
    const orig = rowsOf(LATENT);
    const n0 = chart.notes.length;
    assert.deepEqual(analyzerNew(orig, orig), []);
    assert.deepEqual(remap.freshPatterns(chart, LATENT), { jacks: 0, anchors: 0 });
    // the stream thinned to 1/2, the holds as they were: the analyzer reads them as an Anchor now
    const thinned = rowsOf(mapOf([STREAM_HALF, ...HELD_ANCHOR]));
    assert.ok(analyzerNew(orig, thinned).filter((m) => m.startsWith("Anchor")).length >= 12, "an Anchor now");
    const analyze = async (text) => ({ kind: "ok", numeric: Math.round((10 * notesOf(text)) / n0 * 10) / 10, top3: [{ name: "Stream", share: 1 }] });
    // a range that needs all of the stream's quarter notes out (leaving a few of them in, which the clean stage does for
    // a change the whole-map check turns down, reaches 6.5 without that Anchor)
    const range = { lo: 5.85, hi: 6.05 };
    for (const seed of [1, 2, 3]) {
        const out = await remapChart({ osuText: LATENT, range, seed }, analyze, null);
        assert.ok(out.removed > 0.2 * n0, `seed ${seed}: it still thins (${out.removed})`);
        assert.deepEqual(analyzerNew(orig, rowsOf(out.osuText)), [], `seed ${seed}`);
        assert.deepEqual(remap.freshPatterns(chart, out.osuText), { jacks: 0, anchors: 0 }, `seed ${seed}`);
        assert.equal(out.reachable, false, `seed ${seed}: in the range only with that Anchor (${out.result.numeric})`);
        // with allowJacks the clean changes the whole-map check stopped come back, before any that makes a jack
        const on = await remapChart({ osuText: LATENT, range, seed, allowJacks: true }, analyze, null);
        assert.equal(on.reachable, true, `seed ${seed}, allowJacks: ${on.result.numeric}`);
    }
});

test("allowJacks: true stops the changes that make jacks at the shortest prefix that reaches the range, though more would fit the mix better", async () => {
    const chart = parseChart(SHARED);
    const n0 = chart.notes.length;
    const seeds = [1, 1 + 7919, 1 + 2 * 7919, 1 + 3 * 7919, 1 + 104729];
    const strictMost = Math.max(...seeds.map((s) => additionOrder(chart, { seed: s, model: jackLover }).length));
    const looseLeast = Math.min(...seeds.map((s) => additionOrder(chart, { seed: s, model: jackLover, jacks: true }).length));
    // ten notes more and the mix is closer to the original's (all jumpstream), 0.3 → 0.75: worth more than the jack
    // penalty (and less than half the mix, which it would not give up)
    const dan = (n) => Math.round((10 * (n0 + n)) / n0 * 10) / 10;
    const analyze = async (text) => {
        const n = notesOf(text) - n0;
        const share = n <= 0 ? 1 : n < 10 ? 0.3 : 0.75;
        return { kind: "ok", numeric: dan(n), top3: [{ name: "Jumpstream", share }, { name: "Stream", share: 1 - share }] };
    };
    const lo = dan(strictMost + 1) + 0.1;
    let need = 0;
    while (dan(need) < lo) need += 1;
    assert.ok(need > strictMost && need < 10 && looseLeast > 20, `${strictMost} < ${need} < 10, ${looseLeast}`);
    const out = await remapChart({ osuText: SHARED, range: { lo, hi: 99 }, seed: 1, allowJacks: true }, analyze, jackLover);
    assert.equal(out.reachable, true);
    assert.equal(out.added, need, `${out.added} added, ${need} reach it (clean ${strictMost}, all ${looseLeast})`);
    // but not where the shortest lost most of the original's mix that a longer one in range kept (0.1 → 0.9)
    const lost = async (text) => {
        const n = notesOf(text) - n0;
        const share = n <= 0 ? 1 : n < 10 ? 0.1 : 0.9;
        return { kind: "ok", numeric: dan(n), top3: [{ name: "Jumpstream", share }, { name: "Stream", share: 1 - share }] };
    };
    const kept = await remapChart({ osuText: SHARED, range: { lo, hi: 99 }, seed: 1, allowJacks: true }, lost, jackLover);
    assert.equal(kept.reachable, true);
    assert.ok(kept.added >= 10 && kept.added < looseLeast, `${kept.added} added`);
});

test("allowJacks: true does not take a miss that makes jacks for less than half a dan", async () => {
    const chart = parseChart(SPARSE);
    const n0 = chart.notes.length;
    const notes = (text) => text.split("[HitObjects]")[1].split(/\r?\n/).filter((l) => l.split(",").length >= 5).length;
    const strictMost = Math.max(...[1, 1 + 7919, 1 + 2 * 7919, 1 + 3 * 7919, 1 + 104729].map((s) => additionOrder(chart, { seed: s, model: jackLover }).length));
    // every note past the clean ones is worth a hundredth of a dan, and the range is far above
    const analyze = async (text) => {
        const n = notes(text) - n0;
        return { kind: "ok", numeric: Math.round(10 * (10 + n / n0 + 0.01 * Math.max(0, n - strictMost))) / 10, top3: [{ name: "Jumpstream", share: 1 }] };
    };
    const range = { lo: 14.5, hi: 15.5 };
    const strict = await remapChart({ osuText: SPARSE, range, seed: 1 }, analyze, jackLover);
    const loose = await remapChart({ osuText: SPARSE, range, seed: 1, allowJacks: true }, analyze, jackLover);
    assert.equal(strict.reachable, false);
    assert.equal(loose.osuText, strict.osuText);
});

test("jacksWouldHelp: a map it could not change without new jacks says whether allowJacks would have", async () => {
    const chart = parseChart(SHARED);
    const n0 = chart.notes.length;
    const notes = (text) => text.split("[HitObjects]")[1].split(/\r?\n/).filter((l) => l.split(",").length >= 5).length;
    // SHARED has next to no clean addition; twenty notes more make it 12
    const analyze = async (text) => ({ kind: "ok", numeric: notes(text) >= n0 + 20 ? 12 : 10, top3: [{ name: "Jumpstream", share: 1 }] });
    const range = { lo: 11.5, hi: 12.5 };
    const off = await remapChart({ osuText: SHARED, range, seed: 1 }, analyze, jackLover);
    assert.equal(off.reachable, false);
    assert.equal(off.added + off.removed + off.moved, 0, "the original back");
    assert.equal(off.jacksWouldHelp, true);
    const on = await remapChart({ osuText: SHARED, range, seed: 1, allowJacks: true }, analyze, jackLover);
    assert.equal(on.reachable, true);
    assert.equal(on.jacksWouldHelp, false);
    // where the jacks would not help either, it says so
    const flat = async () => ({ kind: "ok", numeric: 10, top3: [{ name: "Jumpstream", share: 1 }] });
    const none = await remapChart({ osuText: SHARED, range, seed: 1 }, flat, jackLover);
    assert.equal(none.added + none.removed + none.moved, 0);
    assert.equal(none.jacksWouldHelp, false);
});

test("a jack a mapper's rounding puts 1-2 ms over half a beat is still one: counted, and neither direction makes it", () => {
    // all the quarter notes out: column 0 on the beat and on the half beat, 202 and 198 ms apart, as without the drift
    const thinned = (drift) => mapOf([JUMPJACK, { beat: 6, beats: 16, per: 4, masks: [1, 0, 1, 4], holds: [2], drift }]);
    assert.equal(remap.freshPatterns(parseChart(HELD), thinned(undefined)).jacks, 16);
    assert.equal(remap.freshPatterns(parseChart(HELD_DRIFT), thinned(DRIFT)).jacks, 16, "202 ms is a jack at 1/2 too");
    const chart = parseChart(HELD_DRIFT);
    const orig = rowsOf(HELD_DRIFT);
    for (const seed of [1, 2, 3]) {
        const removals = removalOrder(chart, { seed, trills: false });
        for (const knob of KNOBS) {
            const out = applyKnob(chart, { removals }, -knob).osuText;
            assert.deepEqual(newJacks(orig, rowsOf(out), nearDrift), [], `easier seed ${seed} at −${knob}`);
            assert.deepEqual(remap.freshPatterns(chart, out), { jacks: 0, anchors: 0 }, `easier seed ${seed} at −${knob}`);
        }
    }
    const sparse = parseChart(SPARSE_DRIFT);
    const before = rowsOf(SPARSE_DRIFT);
    for (const seed of [1, 2, 3]) {
        const additions = additionOrder(sparse, { seed, model: jackLover });
        assert.ok(additions.length > 0.2 * sparse.notes.length, `harder seed ${seed}: it still adds (${additions.length})`);
        for (const knob of KNOBS) {
            const out = applyKnob(sparse, { additions }, knob).osuText;
            assert.deepEqual(newJacks(before, rowsOf(out), nearDrift), [], `harder seed ${seed} at ${knob}`);
            assert.deepEqual(remap.freshPatterns(sparse, out), { jacks: 0, anchors: 0 }, `harder seed ${seed} at ${knob}`);
        }
    }
});

test("the clean stage leaves out a change the whole-map check turns down and goes on past it, so a range past it is reached", async () => {
    const chart = parseChart(TRIPLETS);
    const orig = rowsOf(TRIPLETS);
    const n0 = chart.notes.length;
    assert.deepEqual(remap.freshPatterns(chart, TRIPLETS), { jacks: 0, anchors: 0 });
    assert.deepEqual(analyzerNew(orig, orig), []);
    // the plan for seed 1: its prefixes pass the whole-map check, then fail for a stretch, then pass again
    const removals = removalOrder(chart, { seed: 1 });
    const passes = (k) => {
        const out = applyKnob(chart, { removals: removals.slice(0, k) }, -1).osuText;
        const fresh = remap.freshPatterns(chart, out);
        return !fresh.jacks && !fresh.anchors && !analyzerNew(orig, rowsOf(out)).length;
    };
    const from = removals.findIndex((_, k) => !passes(k + 1)) + 1;
    let to = from;
    while (to < removals.length && !passes(to + 1)) to += 1;
    assert.ok(from > 10 && to - from > 10 && passes(to + 1), `fails from ${from} to ${to}`);
    // a range that takes as many notes out as the middle of that stretch
    const dan = (removed) => Math.round((10 * (n0 - removed)) / n0 * 10) / 10;
    const mid = Math.round((from + to) / 2);
    const range = { lo: dan(mid) - 0.05, hi: dan(mid) + 0.05 };
    assert.ok(dan(from - 1) > range.hi && dan(to + 1) < range.lo, JSON.stringify({ range, from: dan(from - 1), to: dan(to + 1) }));
    const analyze = async (text) => ({ kind: "ok", numeric: Math.round((10 * notesOf(text)) / n0 * 10) / 10, top3: [{ name: "Stream", share: 1 }] });
    const out = await remapChart({ osuText: TRIPLETS, range, seed: 1 }, analyze, null);
    assert.equal(out.reachable, true, `got ${out.result.numeric} for [${range.lo}, ${range.hi})`);
    assert.deepEqual(remap.freshPatterns(chart, out.osuText), { jacks: 0, anchors: 0 });
    assert.deepEqual(analyzerNew(orig, rowsOf(out.osuText)), []);
});

test("a jumpjack split by new rows onto every other row is a new anchor; the same jack thinned onto every other row is not", () => {
    const chart = parseChart(SPLIT);
    assert.deepEqual(remap.freshPatterns(chart, SPLIT), { jacks: 0, anchors: 0 });
    // new rows 2 and 4 between the jumps: columns 0 and 3 on every other row six times each
    const split = mapOf([STREAM, { beat: 17, beats: 2.75, per: 4, masks: [9, 2, 9, 4] }]);
    assert.equal(remap.freshPatterns(chart, split).anchors, 2);
    assert.equal(newAnchors(rowsOf(SPLIT), rowsOf(split)).filter((a) => a.startsWith("col")).length, 2);
    // the original's 1/4 jumpjack with column 0 taken out of every other row: its own jack thinned
    const jack = mapOf([STREAM, { beat: 17, beats: 2.75, per: 4, masks: [9] }]);
    const thinned = mapOf([STREAM, { beat: 17, beats: 2.75, per: 4, masks: [9, 8] }]);
    assert.deepEqual(remap.freshPatterns(parseChart(jack), thinned), { jacks: 0, anchors: 0 });
    // and harder never splits it, even with a model that wants anchors
    const [t0, t1] = [T0 + 17 * BEAT - 2, T0 + 19.5 * BEAT + 2];
    const at = (a) => Number(a.split(" at ")[1]);
    for (const seed of [1, 2, 3]) {
        const additions = additionOrder(chart, { seed, model: anchorLover });
        for (const knob of KNOBS) {
            const out = applyKnob(chart, { additions }, knob).osuText;
            assert.equal(remap.freshPatterns(chart, out).anchors, 0, `seed ${seed} at ${knob}`);
            const there = newAnchors(rowsOf(SPLIT), rowsOf(out)).filter((a) => /^col [03] /.test(a) && at(a) >= t0 && at(a) <= t1);
            assert.deepEqual(there, [], `seed ${seed} at ${knob}`);
        }
    }
});

test("jacksWouldHelp: a miss that changed the map says so too, where allowJacks would reach the range", async () => {
    // SHARED: a few clean additions, many with jacks
    const chart = parseChart(SHARED);
    const n0 = chart.notes.length;
    const seeds = [1, 1 + 7919, 1 + 2 * 7919, 1 + 3 * 7919, 1 + 104729];
    const strictMost = Math.max(...seeds.map((s) => additionOrder(chart, { seed: s, model: jackLover }).length));
    const analyze = async (text) => ({ kind: "ok", numeric: Math.round((10 * notesOf(text)) / n0 * 10) / 10, top3: [{ name: "Jumpstream", share: 1 }] });
    const lo = Math.ceil((10 * (n0 + strictMost + 0.02 * n0)) / n0 * 10) / 10;
    const range = { lo, hi: lo + 0.2 };
    const off = await remapChart({ osuText: SHARED, range, seed: 1 }, analyze, jackLover);
    assert.equal(off.reachable, false);
    assert.ok(off.added > 0, "it changed the map");
    assert.equal(off.jacksWouldHelp, true);
    const on = await remapChart({ osuText: SHARED, range, seed: 1, allowJacks: true }, analyze, jackLover);
    assert.equal(on.reachable, true, `got ${on.result.numeric}`);
    assert.equal(on.jacksWouldHelp, false);
});
