// The trill momentum of generateLearnedMap (0.10.4): a started trill is continued about as often as in human maps.
// The table and its rules (which alternations, how long, which families), the run it counts, and in a real build: single
// trills last longer than v3 drew them, request.trills: false draws as v3, chordjacks, jacks and flavoured slots are
// never pushed, nor a trill past TRILL_RUN_CAP rows, nor one a build already continues as often as human maps do, nor
// one of a kind that already holds TRILL_SHARE of the build's rows. The rule path (no model file) may continue a
// stream's trill too.
import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import {
    generateLearnedMap, trillMomentum, trillRunAfter, trillCounts, noteTrill, alternationKind, rollUnderWay,
    trillRows, noteTrillRow, trillShareFull, TRILL_MOMENTUM, TRILL_TARGET, TRILL_EVIDENCE, TRILL_RUN_CAP, TRILL_SHARE,
} from "../../src/gen/generateLearned.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { nextRow, TRILL_CONTINUE, rollUnderWay as rollUnderWayCols } from "../../src/gen/patterns.js";
import { flavourMarks } from "../../src/gen/flavourMetrics.js";
import { generateMap } from "../../src/gen/generate.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const BEAT = 400; // ms (150 BPM): half a beat is 200 ms
const HALF = BEAT / 2 + 1;
// recent rows (newest first) from oldest-first masks, every gap `gapMs`
const recentOf = (masks, gapMs = 100) => masks.slice().reverse().map((mask) => ({ mask, gapMs }));
// the run after pushing these rows one by one, as buildSteps does
function runOf(masks, gaps = masks.map(() => 100)) {
    const recent = [];
    let run = 0;
    masks.forEach((mask, k) => {
        recent.unshift({ mask, gapMs: k ? gaps[k] : Infinity });
        if (recent.length > 8) recent.pop();
        run = trillRunAfter(recent, run, HALF);
    });
    return run;
}
const ctxOf = (masks, gaps) => ({ recent: recentOf(masks), trillRun: runOf(masks, gaps) });

test("the tables: single notes pushed most and longest, jumptrills only at the start, up to the human maps' rates", () => {
    assert.deepEqual(TRILL_MOMENTUM.single, [2, 2, 3, 3]);
    assert.deepEqual(TRILL_MOMENTUM.jumpRoll, [2, 1.5, 1, 1]);
    // split jumps (5 ↔ 10, 6 ↔ 9) are not pushed: that push took the jumptrills' place
    assert.deepEqual(Object.keys(TRILL_MOMENTUM), ["single", "jumpRoll"]);
    assert.deepEqual(TRILL_TARGET.single, [0.11, 0.16, 0.66, 0.84]);
    assert.deepEqual(Object.keys(TRILL_TARGET), Object.keys(TRILL_MOMENTUM));
    for (const t of Object.values(TRILL_TARGET)) assert.ok(t.every((x) => x > 0 && x < 1));
    assert.equal(TRILL_RUN_CAP, 16);
    assert.equal(TRILL_EVIDENCE, 6);
    assert.ok(Object.isFrozen(TRILL_MOMENTUM) && Object.isFrozen(TRILL_MOMENTUM.single) && Object.isFrozen(TRILL_TARGET.jumpRoll));
    assert.equal(alternationKind(1, 2), "single");
    assert.equal(alternationKind(1, 8), "single");
    assert.equal(alternationKind(3, 12), "jumpRoll");
    assert.equal(alternationKind(12, 3), "jumpRoll");
    assert.equal(alternationKind(5, 10), "jumpSplit");
    assert.equal(alternationKind(6, 9), "jumpSplit");
    assert.equal(alternationKind(7, 8), null, "a hand and a note: chord trills are not pushed");
    assert.equal(alternationKind(1, 1), null, "a jack");
    assert.equal(alternationKind(3, 4), null, "a jump and a note");
});

test("the run: two disjoint close rows start it, each row repeating the one before last adds one, a jack or a gap ends it", () => {
    assert.equal(runOf([]), 0);
    assert.equal(runOf([1]), 1);
    assert.equal(runOf([1, 2]), 2);
    assert.equal(runOf([1, 2, 1]), 3);
    assert.equal(runOf([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]), 12, "past the 8 recent rows");
    assert.equal(runOf([1, 2, 1, 4]), 2, "a new pair starts again");
    assert.equal(runOf([1, 2, 1, 1]), 1, "a jack");
    assert.equal(runOf([1, 2, 1, 2], [0, 100, 100, 300]), 1, "more than half a beat apart");
    assert.equal(runOf([3, 12, 3, 12, 3]), 5);
});

const pushOf = (masks, family = "Stream", counts = null, gapMs = 100) => {
    const c = trillMomentum(ctxOf(masks), gapMs, BEAT, family, counts);
    return c && { mask: c.mask, beta: c.beta };
};

test("the push: AB → A by the table, by length, never for split jumps, chord trills, chordjacks, jacks, long gaps or from the cap on", () => {
    // AB: the next A weighs 2× (a single-note trill of 2 rows)
    assert.deepEqual(pushOf([2, 1]), { mask: 2, beta: 2 });
    assert.deepEqual(trillMomentum(ctxOf([2, 1]), 100, BEAT, "Stream"), { mask: 2, beta: 2, kind: "single", bucket: 0 });
    // ABA → B, 3 rows: 2×; ABAB → A, 4 rows: 3×; 8 rows: 3×
    assert.deepEqual(pushOf([1, 2, 1]), { mask: 2, beta: 2 });
    assert.deepEqual(pushOf([1, 2, 1, 2], "Jumpstream"), { mask: 1, beta: 3 });
    assert.deepEqual(pushOf([4, 8, 4, 8, 4, 8, 4, 8], "Tech"), { mask: 4, beta: 3 });
    // two-note rows between the hands (jumptrills): 2× then 1.5×, nothing (β 1) from the 4th row
    assert.deepEqual(pushOf([3, 12], "Jumpstream"), { mask: 3, beta: 2 });
    assert.deepEqual(pushOf([3, 12, 3], "Jumpstream"), { mask: 12, beta: 1.5 });
    assert.deepEqual(pushOf([3, 12, 3, 12], "Jumpstream"), { mask: 3, beta: 1 });
    // split jumps: never
    for (const masks of [[5, 10], [5, 10, 5], [6, 9], [9, 6, 9, 6]]) assert.equal(pushOf(masks, "Handstream"), null, `${masks}`);
    // never: a hand and a note, a chordjack or a jack, the next slot more than half a beat on, one row, no rows
    assert.equal(pushOf([7, 8], "Handstream"), null);
    assert.equal(pushOf([2, 1], "Chordjack"), null);
    assert.equal(pushOf([2, 1], "Jack"), null);
    assert.equal(pushOf([2, 1], "Stream", null, 250), null);
    assert.equal(pushOf([1]), null);
    assert.equal(trillMomentum({ recent: [], trillRun: 0 }, Infinity, BEAT, "Stream"), null);
    // the cap: 15 rows still pushed, 16 not
    const trill = (n) => Array.from({ length: n }, (_, k) => (k % 2 ? 2 : 1));
    assert.equal(runOf(trill(TRILL_RUN_CAP - 1)), TRILL_RUN_CAP - 1);
    assert.deepEqual(pushOf(trill(TRILL_RUN_CAP - 1)), { mask: 2, beta: 3 });
    assert.equal(pushOf(trill(TRILL_RUN_CAP)), null);
});

test("never above the human rate: once a build's trills of a kind and length go on that often, they get no push", () => {
    const counts = trillCounts();
    const four = [1, 2, 1, 2]; // a single-note trill of 4 rows: bucket 2, the human maps go on 66% of the time
    const chance = trillMomentum(ctxOf(four), 100, BEAT, "Stream", counts);
    assert.deepEqual(chance, { mask: 1, beta: 3, kind: "single", bucket: 2 });
    // five such trills went on, one did not (5/6 = 83%): still pushed until TRILL_EVIDENCE of them were seen …
    for (let k = 0; k < TRILL_EVIDENCE - 1; k += 1) noteTrill(counts, chance, k === 0 ? 4 : 1);
    assert.equal(pushOf(four, "Stream", counts).beta, 3);
    noteTrill(counts, chance, 1);
    assert.deepEqual([...counts.single.slice(4, 6)], [6, 5]);
    // … then not, as 83% is over 66%; other lengths and kinds keep their push
    assert.equal(pushOf(four, "Stream", counts).beta, 1);
    assert.equal(pushOf([4, 8, 4, 8, 4, 8, 4, 8], "Stream", counts).beta, 3);
    assert.equal(pushOf([2, 1], "Stream", counts).beta, 2);
    assert.equal(pushOf([3, 12], "Jumpstream", counts).beta, 2);
    // trills that stopped bring the rate under 66% again: pushed again
    for (let k = 0; k < 3; k += 1) noteTrill(counts, chance, 8);
    assert.ok(counts.single[5] / counts.single[4] < TRILL_TARGET.single[2]);
    assert.equal(pushOf(four, "Stream", counts).beta, 3);
    // a slot left empty (mask 0) or without a chance counts nothing
    noteTrill(counts, chance, 0);
    noteTrill(counts, null, 1);
    assert.equal(counts.single[4], 9);
});

// rows of an alternation fed one by one into a build's trillRows, as buildSteps' pushRow does
function feedRows(rows, masks) {
    const recent = [];
    let run = 0;
    for (const mask of masks) {
        recent.unshift({ mask, gapMs: 100 });
        if (recent.length > 8) recent.pop();
        run = trillRunAfter(recent, run, HALF);
        noteTrillRow(rows, { recent, trillRun: run });
    }
}

test("nor once a build's trills of a kind hold TRILL_SHARE of its rows: the ceiling caps how often they go on, this how many", () => {
    // over the human maps' 90th percentile (rows in alternations of 4+ rows) where the kind is most common: single
    // notes 0.096 on stream maps, two-note rows 0.157 on jumpstream maps
    assert.ok(TRILL_SHARE.single > 0.096 && TRILL_SHARE.jump > 0.157 && TRILL_SHARE.evidence >= 32);
    assert.ok(Object.isFrozen(TRILL_SHARE));
    // counting: a trill's rows once it has four (all four at once), then one a row; the other rows as rows only
    const rows = trillRows();
    feedRows(rows, [1, 2, 1]);
    assert.deepEqual(rows, { rows: 3, single: 0, jump: 0 });
    feedRows(rows, [1, 2, 1, 2]);
    assert.deepEqual(rows, { rows: 7, single: 4, jump: 0 });
    feedRows(rows, [1, 2, 1, 2, 1, 4, 8]);
    assert.deepEqual(rows, { rows: 14, single: 9, jump: 0 });
    // two-note rows: the jump trills (3 ↔ 12) and the split ones (5 ↔ 10) together; a hand and a note: neither
    const two = trillRows();
    feedRows(two, [3, 12, 3, 12]);
    feedRows(two, [5, 10, 5, 10, 5]);
    feedRows(two, [7, 8, 7, 8]);
    assert.deepEqual(two, { rows: 13, single: 0, jump: 9 });
    // full: from TRILL_SHARE.evidence rows on, once the kind's group holds the share; the other group not
    const at = (n, single, jump) => ({ rows: n, single, jump });
    assert.equal(trillShareFull(at(TRILL_SHARE.evidence - 1, 60, 60), "single"), false, "too few rows yet");
    assert.equal(trillShareFull(at(100, 100 * TRILL_SHARE.single, 0), "single"), true);
    assert.equal(trillShareFull(at(100, 100 * TRILL_SHARE.single - 1, 0), "single"), false);
    assert.equal(trillShareFull(at(100, 0, 100 * TRILL_SHARE.jump), "jumpRoll"), true);
    assert.equal(trillShareFull(at(100, 0, 100 * TRILL_SHARE.jump), "jumpSplit"), true);
    assert.equal(trillShareFull(at(100, 0, 100), "single"), false);
    assert.equal(trillShareFull(null, "single"), false);
    // the push: none once full, else as it was
    const push = (masks, family, held) => trillMomentum(ctxOf(masks), 100, BEAT, family, null, held);
    assert.deepEqual(push([1, 2, 1, 2], "Stream", at(100, 20, 0)), { mask: 1, beta: 1, kind: "single", bucket: 2 });
    assert.deepEqual(push([1, 2, 1, 2], "Stream", at(100, 0, 40)), { mask: 1, beta: 3, kind: "single", bucket: 2 });
    assert.deepEqual(push([3, 12], "Jumpstream", at(100, 0, 20)), { mask: 3, beta: 1, kind: "jumpRoll", bucket: 0 });
    assert.deepEqual(push([3, 12], "Jumpstream", at(100, 20, 10)), { mask: 3, beta: 2, kind: "jumpRoll", bucket: 0 });
    assert.deepEqual(push([3, 12], "Jumpstream", null), { mask: 3, beta: 2, kind: "jumpRoll", bucket: 0 });
});

// ---- in a build: a model whose rows are single notes, the column before last a third as likely as the other two
// (it continues a trill 1 time in 7, about as the classic model does) ----
const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
const SINGLES = [1, 2, 4, 8];
// the pattern table of such a model: the column before last weighs `back` against 30 for each other one
function singlesTable(back) {
    const table = { "0,0,1": Object.fromEntries(SINGLES.map((m) => [m, 30])) };
    for (const prev of SINGLES) {
        for (const prev2 of [0, ...SINGLES]) {
            table[`${prev},${prev2},1`] = Object.fromEntries(SINGLES.filter((m) => m !== prev).map((m) => [m, m === prev2 ? back : 30]));
        }
    }
    return table;
}
const singles = singlesTable(10);
const model = {
    features: AUDIO_FEATURES,
    families: FAMILIES,
    // a row on nearly every slot, whatever the knob
    note: { baseline: [8], classes: [0, 1], iterations: [] },
    size: { baseline: [0, -9, -9, -9], classes: [1, 2, 3, 4], iterations: [] },
    pattern: Object.fromEntries(FAMILIES.map((f) => [f, singles])),
};
const song = clickTrack({ bpm: 150, offsetMs: 400, seconds: 60 });
const envelope = onsetEnvelope(song.samples, song.sampleRate);
const input = (request = {}) => ({
    timing: { bpm: 150, offsetMs: 400 }, envelope, durationMs: 60000,
    request: { range: { lo: 2.5, hi: 3.5 }, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 1, burst: 0.3, seed: 3, ...request },
    meta: { title: "t", audioFilename: "a.mp3" },
});
const inRange = async () => ({ kind: "ok", numeric: 3 });

// how often a map's rows continue an alternation, by its length so far (2–3 rows, 4 and more)
function continuation(osuText) {
    const rows = parseRows(osuText, 4).sort((a, b) => a.t - b.t);
    const out = { short: [0, 0], long: [0, 0], rows: rows.length };
    const recent = [];
    let run = 0;
    for (let k = 0; k < rows.length; k += 1) {
        if (k >= 2 && run >= 2 && rows[k].t - rows[k - 1].t <= HALF) {
            const bucket = run <= 3 ? out.short : out.long;
            bucket[1] += 1;
            if (rows[k].mask === recent[1].mask) bucket[0] += 1;
        }
        recent.unshift({ mask: rows[k].mask, gapMs: k ? rows[k].t - rows[k - 1].t : Infinity });
        if (recent.length > 8) recent.pop();
        run = trillRunAfter(recent, run, HALF);
    }
    return out;
}
const rate = ([a, n]) => a / Math.max(1, n);

// how often trills go on, with the momentum and without, over three seeds: { short: [on, off], long: [on, off], … }
async function onOff(m) {
    const sum = (list, key) => list.reduce((s, c) => [s[0] + c[key][0], s[1] + c[key][1]], [0, 0]);
    const on = [];
    const off = [];
    for (const seed of [1, 2, 3]) {
        on.push(continuation((await generateLearnedMap(input({ seed }), inRange, m)).osuText));
        off.push(continuation((await generateLearnedMap(input({ seed, trills: false }), inRange, m)).osuText));
    }
    return { on, off, short: [rate(sum(on, "short")), rate(sum(off, "short"))], long: [rate(sum(on, "long")), rate(sum(off, "long"))], longN: [sum(on, "long")[1], sum(off, "long")[1]] };
}

test("in a build: a model that cuts its trills short goes on with them from the 4th row, its trill starts stay as they were", async () => {
    const r = await onOff(model);
    assert.ok(r.on.every((c) => c.rows > 400), `rows ${r.on.map((c) => c.rows)}`);
    // v3: 1 in 7 at every length; with the momentum the 4th row on goes on far more often (towards the human maps' 2 in 3)
    assert.ok(r.short[1] > 0.08 && r.short[1] < 0.22, `v3 at 2–3 rows: ${r.short[1]}`);
    assert.ok(r.long[0] > r.long[1] + 0.1, `4+ rows: ${r.long}`);
    assert.ok(r.long[0] < TRILL_TARGET.single[2] + 0.05, `4+ rows: ${r.long[0]}, never over the human rate`);
    assert.ok(r.longN[0] > r.longN[1], "more trills reach 4 rows");
    // starts (2–3 rows): human maps go on 11–16% of the time, as this model does already: about the same
    assert.ok(Math.abs(r.short[0] - r.short[1]) < 0.06, `2–3 rows: ${r.short}`);
});

test("in a build: a model that trills more than human maps do gets no more trills", async () => {
    // the column before last 8 times as likely as each other one: it goes on about 3 times in 4 at every length
    const r = await onOff({ ...model, pattern: Object.fromEntries(FAMILIES.map((f) => [f, singlesTable(240)])) });
    assert.ok(r.short[1] > 0.7 && r.long[1] > 0.7, `v3: ${r.short[1]}, ${r.long[1]}`);
    assert.ok(Math.abs(r.short[0] - r.short[1]) < 0.06, `2–3 rows: ${r.short}`);
    assert.ok(Math.abs(r.long[0] - r.long[1]) < 0.06, `4+ rows: ${r.long}`);
});

// the share of a map's rows in single-note alternations of 4+ rows (as TRILL_SHARE counts them)
function trillShare(osuText) {
    const rows = parseRows(osuText, 4).sort((a, b) => a.t - b.t);
    const held = trillRows();
    const recent = [];
    let run = 0;
    for (let k = 0; k < rows.length; k += 1) {
        recent.unshift({ mask: rows[k].mask, gapMs: k ? rows[k].t - rows[k - 1].t : Infinity });
        if (recent.length > 8) recent.pop();
        run = trillRunAfter(recent, run, HALF);
        noteTrillRow(held, { recent, trillRun: run });
    }
    return held.single / Math.max(1, held.rows);
}

test("in a build: a model that already floods its map with trills, if it cuts each one short, gets no more of them", async () => {
    // the column before last as likely as each other one: a third of the trills go on at every length, under the human
    // rate from the 4th row on, so the ceiling alone would push them, but its maps hold 0.3 of their rows in trills
    const flood = { ...model, pattern: Object.fromEntries(FAMILIES.map((f) => [f, singlesTable(30)])) };
    const share = async (m, trills) => {
        let s = 0;
        for (const seed of [1, 2, 3]) s += trillShare((await generateLearnedMap(input({ seed, ...(trills ? {} : { trills: false }) }), inRange, m)).osuText);
        return s / 3;
    };
    const off = await share(flood, false);
    const on = await share(flood, true);
    assert.ok(off > 2 * TRILL_SHARE.single, `v3: ${off}`);
    assert.ok(on - off < 0.02, `with the momentum ${on}, v3 ${off}`);
    // the model that cuts its trills short and holds few of them is still pushed (the test above), to more trills
    assert.ok((await share(model, true)) > (await share(model, false)) + 0.01);
});

test("trills: false gives the same map every time; chordjack and jack maps, and flavoured slots, are never pushed", async () => {
    const a = await generateLearnedMap(input({ trills: false }), inRange, model);
    const b = await generateLearnedMap(input({ trills: false }), inRange, model);
    assert.equal(a.osuText, b.osuText);
    const plain = await generateLearnedMap(input(), inRange, model);
    assert.notEqual(plain.osuText, a.osuText, "the stream map does change");
    for (const name of ["Chordjack", "Jack"]) {
        const req = { patterns: [{ name, share: 1 }] };
        const pushed = await generateLearnedMap(input(req), inRange, model);
        const v3 = await generateLearnedMap(input({ ...req, trills: false }), inRange, model);
        assert.equal(pushed.osuText, v3.osuText, name);
        assert.ok(continuation(v3.osuText).short[1] > 50, `${name}: the map has alternations the push could have taken`);
    }
    // every slot of a flavoured family follows its motif
    const req = { patterns: [{ name: "Stream", share: 1, flavours: ["Trills"] }] };
    assert.equal((await generateLearnedMap(input(req), inRange, model)).osuText, (await generateLearnedMap(input({ ...req, trills: false }), inRange, model)).osuText);
});

// ---- the rule path (no model file): its streams never came back to the row before last, so they had no trills ----
test("the rule path's streams: the row before last comes back TRILL_CONTINUE of the time with trills, never without", () => {
    const run = (opts) => {
        const rng = mulberry32(3);
        const rows = [];
        for (let i = 0; i < 4000; i += 1) rows.push(nextRow("Stream", rows, rng, 0.6, i, opts));
        return rows;
    };
    const back = (rows) => rows.filter((r, i) => i >= 2 && r[0] === rows[i - 2][0]).length / (rows.length - 2);
    assert.equal(back(run()), 0);
    assert.equal(back(run({ trills: false })), 0);
    const on = run({ trills: true });
    assert.ok(Math.abs(back(on) - TRILL_CONTINUE) < 0.03, `${back(on)}`);
    assert.ok(on.every((r, i) => r.length === 1 && (i === 0 || r[0] !== on[i - 1][0])), "still single notes, no jacks");
});

test("the rule generator: a stream map holds trills unless request.trills is false", async () => {
    const back = (text) => {
        const rows = parseRows(text, 4).sort((a, b) => a.t - b.t);
        return rows.filter((r, i) => i >= 2 && r.mask === rows[i - 2].mask && r.t - rows[i - 1].t <= HALF).length / rows.length;
    };
    const req = { range: undefined, target: 4 };
    const on = await generateMap(input(req), inRange);
    const off = await generateMap(input({ ...req, trills: false }), inRange);
    assert.ok(back(on.osuText) > 0.025, `${back(on.osuText)}`);
    assert.equal(back(off.osuText), 0);
});

// ---- rolls (flavourMetrics.js Rolls: a sweep 1 2 3 4 or 4 3 2 1) are a kind of trill too: the push must not take
// their place (it did: AB → A cut every roll at its second or third note) ----
test("a roll under way is never pushed into a trill: its first two or three notes, either way", () => {
    for (const masks of [[1, 2], [8, 4], [1, 2, 4], [8, 4, 2], [4, 1, 2], [2, 8, 4]]) {
        assert.ok(rollUnderWay(...masks), `${masks}`);
        assert.equal(pushOf(masks), null, `${masks}`);
    }
    // not a roll: the other pairs, a sweep from the middle, a finished sweep
    for (const masks of [[2, 1], [2, 4], [4, 8], [1, 4], [2, 4, 8], [1, 2, 4, 8]]) assert.equal(rollUnderWay(...masks), false, `${masks}`);
    assert.deepEqual(pushOf([2, 4]), { mask: 2, beta: 2 });
    assert.deepEqual(pushOf([4, 8]), { mask: 4, beta: 2 });
    // once the trill has begun (A B A) it is pushed as before
    assert.deepEqual(pushOf([1, 2, 1]), { mask: 2, beta: 2 });
    // the rule path's version, on column lists
    assert.ok(rollUnderWayCols([], [0], [1]) && rollUnderWayCols([3], [2], [1]) && rollUnderWayCols([1], [3], [2]));
    assert.ok(!rollUnderWayCols([], [1], [0]) && !rollUnderWayCols([1], [2], [3]) && !rollUnderWayCols([0], [1, 2], [3]));
});

const rollShare = (masks) => {
    const { marks } = flavourMarks(masks.map((mask, k) => ({ t: k * 100, mask })), ["Rolls"]);
    return marks.Rolls.reduce((s, x) => s + x, 0) / masks.length;
};

test("the rule path's streams: as many rolls with trills as without", () => {
    const share = (opts) => {
        let sum = 0;
        for (const seed of [1, 2, 3, 4, 5]) {
            const rng = mulberry32(seed);
            const rows = [];
            for (let i = 0; i < 6000; i += 1) rows.push(nextRow("Stream", rows, rng, 0.6, i, opts));
            sum += rollShare(rows.map((r) => 1 << r[0]));
        }
        return sum / 5;
    };
    const off = share({ trills: false });
    const on = share({ trills: true });
    assert.ok(off > 0.03, `rolls without trills ${off}`);
    assert.ok(on > 0.95 * off, `rolls ${on} with trills vs ${off} without`);
});

test("in a build: the momentum keeps the model's rolls", async () => {
    let on = 0;
    let off = 0;
    for (const seed of [1, 2, 3, 4]) {
        const masksOf = (text) => parseRows(text, 4).sort((a, b) => a.t - b.t).map((r) => r.mask);
        on += rollShare(masksOf((await generateLearnedMap(input({ seed }), inRange, model)).osuText));
        off += rollShare(masksOf((await generateLearnedMap(input({ seed, trills: false }), inRange, model)).osuText));
    }
    assert.ok(off > 0.1, `rolls without the momentum ${off / 4}`);
    assert.ok(on > 0.93 * off, `rolls ${on / 4} with the momentum vs ${off / 4} without`);
});
