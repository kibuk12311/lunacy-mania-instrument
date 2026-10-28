// Remapping an existing map to another dan (mapgen v3, stream C): only [HitObjects] changes; notes are taken away
// (off-beats and chord notes first, never holds, never the last note of a row on the beat) or added (chords on strong
// beats, rows between rows), never making a jack longer than the original's longest.
import test from "node:test";
import assert from "node:assert/strict";
import { parseChart, removalOrder, additionOrder, applyKnob, remapChart, maxJackOf } from "../../src/gen/remap.js";
import { readMeta } from "../../src/gen/osuMeta.js";
import { DEFAULT_BUDGET } from "../../src/gen/search.js";
import { chartInfo } from "../../src/core/features.js";
import { numericToLabel } from "../../src/core/labels.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const RED_A = { time: 1000, bpm: 150 };
const RED_B = { time: 25000, bpm: 180 };
const x = (c) => Math.floor(((c + 0.5) * 512) / 4);

// Two red lines (150 → 180 BPM) with a break between; 1/4 runs and 1/2 runs, jumps on every other beat, a few short
// holds, and no two rows in a row share a column (its longest jack is 1). Note lines carry hitsounds, so "byte for
// byte" means something.
function fixtureChart() {
    const objects = [];
    let prev = 0;
    let turn = 0;
    const single = () => {
        for (let i = 0; i < 4; i += 1) {
            const c = [0, 2, 1, 3][(turn + i) % 4];
            if (!(prev & (1 << c))) {
                turn = (turn + i + 1) % 4;
                return [c];
            }
        }
        throw new Error("no column");
    };
    const pair = () => [[0, 2], [1, 3], [0, 3], [1, 2]].find(([a, b]) => !(prev & ((1 << a) | (1 << b))));
    const section = ({ time, bpm }, beats, holdsEvery) => {
        const beat = 60000 / bpm;
        for (let b = 0; b < beats; b += 1) {
            const quarter = b % 8 < 4;
            for (let k = 0; k < 4; k += quarter ? 1 : 2) {
                const t = Math.round(time + (b + k / 4) * beat);
                const cols = k === 0 && b % 2 === 0 ? pair() : single();
                cols.forEach((c, i) => {
                    if (i === 0 && cols.length === 2 && b % holdsEvery === 0) objects.push(`${x(c)},192,${t},128,0,${Math.round(t + beat / 8)}:0:0:0:0:`);
                    else objects.push(`${x(c)},192,${t},1,${k % 2 ? 8 : i * 2},0:0:0:0:`);
                });
                prev = cols.reduce((m, c) => m | (1 << c), 0);
            }
        }
        prev = 0;
    };
    section(RED_A, 46, 16);
    section(RED_B, 56, 12);
    return [
        "osu file format v14",
        "",
        "[General]",
        "AudioFilename: audio.mp3",
        "PreviewTime: 12000",
        "Mode: 3",
        "",
        "[Metadata]",
        "Title:Fixture",
        "Artist:Tester",
        "Creator:Someone",
        "Version:Hard",
        "Tags:fixture",
        "BeatmapID:12345",
        "BeatmapSetID:678",
        "",
        "[Difficulty]",
        "HPDrainRate:8",
        "CircleSize:4",
        "OverallDifficulty:8",
        "",
        "[Events]",
        "//Background and Video events",
        "0,0,\"bg.jpg\",0,0",
        "//Break Periods",
        "2,20000,24000",
        "",
        "[TimingPoints]",
        `${RED_A.time},400,4,2,0,60,1,0`,
        `${RED_A.time},-100,4,2,0,60,0,0`,
        `${RED_B.time},333.333333333333,4,2,0,60,1,0`,
        `${RED_B.time},-120,4,2,0,60,0,0`,
        "",
        "[HitObjects]",
        ...objects,
        "",
    ].join("\r\n");
}

const sectionText = (text, name) => {
    const lines = text.split(/\r?\n/);
    const start = lines.indexOf(`[${name}]`);
    let end = start + 1;
    while (end < lines.length && !/^\[.+\]$/.test(lines[end])) end += 1;
    return lines.slice(start, end).join("\n");
};
const objectLines = (text) => sectionText(text, "HitObjects").split("\n").slice(1).filter((l) => l.split(",").length >= 5);
const rowsOf = (text) => parseChart(text).rows.filter((r) => r.mask);

// A stand-in for the analyser: dan 10 at the fixture's note count, in proportion to notes; chords read as Jumpstream.
const ORIGINAL = fixtureChart();
const N0 = chartInfo(ORIGINAL, 1).noteCount;
let analyses = 0;
async function fakeAnalyze(text) {
    analyses += 1;
    const rows = rowsOf(text);
    const chords = rows.filter((r) => r.mask & (r.mask - 1)).length / rows.length;
    const numeric = Math.round((10 * chartInfo(text, 1).noteCount) / N0 * 10) / 10;
    return { kind: "ok", numeric, label: numericToLabel(numeric).text, top3: [{ name: "Jumpstream", share: chords }, { name: "Stream", share: 1 - chords }] };
}

// a pattern model that would love jacks: after any row it repeats that row's columns
const jackLover = { pattern: { Jumpstream: {}, Stream: {} } };
for (const family of ["Jumpstream", "Stream"]) {
    for (let prev = 0; prev < 16; prev += 1) {
        for (let size = 1; size <= 2; size += 1) {
            const masks = {};
            for (let m = 1; m < 16; m += 1) if (popcount(m) === size) masks[m] = (m & prev) === m || (prev & m) === prev ? 1000 : 1;
            for (let prev2 = 0; prev2 < 16; prev2 += 1) jackLover.pattern[family][`${prev},${prev2},${size}`] = masks;
        }
    }
}
function popcount(m) { return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1); }

test("the chart is read into rows on the grid of their own red line", () => {
    const chart = parseChart(ORIGINAL);
    assert.equal(chart.notes.length, N0);
    assert.equal(chart.keys, 4);
    const onBeat = chart.rows.filter((r) => r.div === 1);
    assert.ok(onBeat.length >= 40);
    assert.ok(chart.rows.filter((r) => popcount(r.mask) === 2).every((r) => r.div === 1), "the fixture's jumps sit on the beat");
    const b = chart.rows.find((r) => r.t > RED_B.time + 100 && r.div === 4);
    assert.ok(Math.abs(b.beatMs - 60000 / 180) < 1e-6);
});

test("−1 dan removes notes and +1 adds notes, and both land in range", async () => {
    const down = await remapChart({ osuText: ORIGINAL, range: { lo: 8.5, hi: 9.5 }, seed: 1 }, fakeAnalyze, null);
    assert.equal(down.reachable, true);
    assert.ok(down.result.numeric >= 8.5 && down.result.numeric < 9.5);
    assert.ok(down.removed > 0 && down.added === 0);
    assert.equal(chartInfo(down.osuText, 1).noteCount, N0 - down.removed);
    const up = await remapChart({ osuText: ORIGINAL, range: { lo: 10.5, hi: 11.5 }, seed: 1 }, fakeAnalyze, null);
    assert.equal(up.reachable, true);
    assert.ok(up.result.numeric >= 10.5 && up.result.numeric < 11.5);
    assert.ok(up.added > 0 && up.removed === 0);
});

test("only [HitObjects] changes; timing points, events and kept note lines are byte for byte the same", async () => {
    for (const range of [{ lo: 8.5, hi: 9.5 }, { lo: 10.5, hi: 11.5 }]) {
        const out = await remapChart({ osuText: ORIGINAL, range, seed: 4 }, fakeAnalyze, null);
        for (const name of ["General", "Events", "TimingPoints", "Difficulty"]) assert.equal(sectionText(out.osuText, name), sectionText(ORIGINAL, name), name);
        const before = new Set(objectLines(ORIGINAL));
        const after = objectLines(out.osuText);
        const fresh = after.filter((l) => !before.has(l));
        // a new note is a plain line; a note a trill's halving moved to another column is its own line with another x
        const plain = fresh.filter((l) => /^\d+,192,\d+,1,0,0:0:0:0:$/.test(l));
        assert.equal(plain.length, out.added - out.moved);
        const butX = new Set([...before].map((l) => l.replace(/^[^,]*/, "")));
        for (const l of fresh.filter((f) => !plain.includes(f))) assert.ok(butX.has(l.replace(/^[^,]*/, "")), l);
        assert.equal(fresh.length - plain.length, out.moved);
        // a moved note counts once as removed (from its place) and once as added (at the new one)
        assert.equal(after.length - fresh.length, before.size - out.removed);
        const times = after.map((l) => Number(l.split(",")[2]));
        assert.deepEqual(times, [...times].sort((a, b) => a - b), "objects stay in time order");
        assert.ok(out.osuText.includes("\r\n") && !/[^\r]\n/.test(out.osuText), "CRLF stays CRLF");
    }
});

test("the new difficulty is named after its dan, gets BeatmapID:0 and the remap tag", async () => {
    const out = await remapChart({ osuText: ORIGINAL, range: { lo: 8.5, hi: 9.5 }, seed: 1 }, fakeAnalyze, null);
    const meta = readMeta(out.osuText);
    assert.equal(out.version, `Hard (${numericToLabel(out.result.numeric).text} remap)`);
    assert.equal(meta.version, out.version);
    assert.equal(meta.beatmapId, "0");
    assert.equal(meta.beatmapSetId, "678");
    assert.equal(meta.tags, "fixture lunacy-mania-remap");
    assert.deepEqual([meta.title, meta.artist, meta.creator], ["Fixture", "Tester", "Someone"]);
});

test("holds are never removed and no row on the beat is left empty, however far it thins", () => {
    const chart = parseChart(ORIGINAL);
    const plan = { removals: removalOrder(chart, { seed: 9 }), additions: [] };
    const out = applyKnob(chart, plan, -1);
    const lines = new Set(objectLines(out.osuText));
    for (const l of objectLines(ORIGINAL).filter((o) => o.split(",")[3] === "128")) assert.ok(lines.has(l), `hold ${l}`);
    const left = new Set(rowsOf(out.osuText).map((r) => r.t));
    for (const r of chart.rows.filter((row) => row.div === 1)) assert.ok(left.has(r.t), `beat row at ${r.t}`);
    assert.ok(out.removed > N0 * 0.4, `removed ${out.removed}`);
    assert.ok(maxJackOf(rowsOf(out.osuText)) <= maxJackOf(chart.rows), "thinning makes no longer jack either");
});

test("thickening never makes a jack longer than the original's longest, even with a model that loves jacks", () => {
    const chart = parseChart(ORIGINAL);
    const longest = maxJackOf(chart.rows);
    for (const seed of [1, 2, 3]) {
        const plan = { removals: [], additions: additionOrder(chart, { seed, model: jackLover }) };
        assert.ok(plan.additions.length > 0);
        assert.ok(plan.additions.length <= Math.floor(N0 / 2), "at most half again as many notes");
        const out = applyKnob(chart, plan, 1);
        assert.ok(maxJackOf(rowsOf(out.osuText)) <= longest, `seed ${seed}`);
        for (const k of [0.25, 0.5, 0.75]) assert.ok(maxJackOf(rowsOf(applyKnob(chart, plan, k).osuText)) <= longest, `seed ${seed} at ${k}`);
    }
});

test("added notes stay off the holds and on each red line's own 1/4 grid", () => {
    const chart = parseChart(ORIGINAL);
    const out = applyKnob(chart, { removals: [], additions: additionOrder(chart, { seed: 5, model: null }) }, 1);
    const before = new Set(objectLines(ORIGINAL));
    const fresh = objectLines(out.osuText).filter((l) => !before.has(l)).map((l) => ({ t: Number(l.split(",")[2]), col: Math.floor((Number(l.split(",")[0]) * 4) / 512) }));
    assert.ok(fresh.some((n) => n.t > RED_B.time) && fresh.some((n) => n.t < RED_A.time + 19000));
    for (const n of fresh) {
        const red = n.t >= RED_B.time ? RED_B : RED_A;
        const step = 60000 / red.bpm / 4;
        const k = (n.t - red.time) / step;
        assert.ok(Math.abs(k - Math.round(k)) * step <= 1, `note at ${n.t}`);
        assert.ok(!(n.t > 20000 && n.t < 24000), "nothing in the break");
    }
    const holds = chart.notes.filter((n) => n.hold);
    for (const h of holds) for (const n of fresh) assert.ok(!(n.col === h.col && n.t >= h.t && n.t <= h.end), `note ${n.t} inside hold ${h.t}–${h.end}`);
});

test("a map with two red lines keeps both", async () => {
    const out = await remapChart({ osuText: ORIGINAL, range: { lo: 10.5, hi: 11.5 }, seed: 2 }, fakeAnalyze, null);
    const reds = sectionText(out.osuText, "TimingPoints").split("\n").filter((l) => l.split(",")[6] === "1");
    assert.deepEqual(reds, [`${RED_A.time},400,4,2,0,60,1,0`, `${RED_B.time},333.333333333333,4,2,0,60,1,0`]);
});

test("the same seed gives the same map; another seed another layout", async () => {
    const a = await remapChart({ osuText: ORIGINAL, range: { lo: 8.5, hi: 9.5 }, seed: 7 }, fakeAnalyze, null);
    const b = await remapChart({ osuText: ORIGINAL, range: { lo: 8.5, hi: 9.5 }, seed: 7 }, fakeAnalyze, null);
    assert.equal(a.osuText, b.osuText);
    const chart = parseChart(ORIGINAL);
    assert.notDeepEqual(removalOrder(chart, { seed: 1 }).slice(0, 20), removalOrder(chart, { seed: 2 }).slice(0, 20));
});

test("the original's pattern breakdown is what an in-range layout is scored by", async () => {
    // an analyser that only calls a layout Jumpstream while (nearly) all of the original's chord share survives
    const share = (text) => { const rows = rowsOf(text); return rows.filter((r) => r.mask & (r.mask - 1)).length / rows.length; };
    const original = share(ORIGINAL);
    const picky = async (text) => ({ ...(await fakeAnalyze(text)), top3: [{ name: share(text) >= original * 0.97 ? "Jumpstream" : "Stream", share: 1 }] });
    for (const seed of [1, 2, 3]) {
        const out = await remapChart({ osuText: ORIGINAL, range: { lo: 8.5, hi: 9.5 }, seed }, picky, null);
        assert.equal(out.reachable, true);
        assert.ok(share(out.osuText) >= original * 0.97, `seed ${seed}: the original's Jumpstream is kept`);
    }
});

test("the jack-free fixture really has no jacks", () => {
    assert.equal(maxJackOf(parseChart(ORIGINAL).rows), 1);
});

test("progress is reported per analysis, the original is analysed once more at the start", async () => {
    const seen = [];
    analyses = 0;
    await remapChart({ osuText: ORIGINAL, range: { lo: 8.5, hi: 9.5 }, seed: 1 }, fakeAnalyze, null, { onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 3);
    assert.deepEqual(seen.map((p) => p.i), seen.map((_, i) => i + 1));
    assert.ok(seen.every((p) => p.phase === "search" && p.n >= p.i));
    assert.equal(analyses, seen.length + 1);
});

test("a range the dan steps over is searched once more with other layouts; one out of reach is not", async () => {
    // the dan jumps from 9.3 straight to 8.8, so [9.0, 9.1) is never hit; nothing goes below 1
    const stepping = async (text) => {
        analyses += 1;
        const ratio = chartInfo(text, 1).noteCount / N0;
        const numeric = ratio >= 0.91 ? 9.3 + (ratio - 0.91) * 10 : ratio >= 0.85 ? 8.8 : Math.max(1, Math.round(ratio * 100) / 10);
        return { kind: "ok", numeric, label: numericToLabel(numeric).text, top3: [{ name: "Stream", share: 1 }] };
    };
    // a search analyses each prefix once (its bisection can come back to one), the second one a plan of its own
    const once = DEFAULT_BUDGET.coarse + 1 + DEFAULT_BUDGET.refine;
    const twoSearches = (n) => n > 1 + once && n <= 1 + 2 * once;
    analyses = 0;
    const missed = await remapChart({ osuText: ORIGINAL, range: { lo: 9.0, hi: 9.1 }, seed: 1 }, stepping, null);
    assert.equal(missed.reachable, false);
    assert.ok([8.8, 9.3].includes(Math.round(missed.result.numeric * 10) / 10), `the closest comes back: ${missed.result.numeric}`);
    assert.ok(twoSearches(analyses), `two searches (${analyses})`);
    analyses = 0;
    const far = await remapChart({ osuText: ORIGINAL, range: { lo: 0.2, hi: 0.4 }, seed: 1 }, stepping, null);
    assert.equal(far.reachable, false);
    assert.equal(analyses, 1 + DEFAULT_BUDGET.coarse + 1, "one search: nothing came below the range");
    // a map the analyzer no longer reads (an easier one that is mostly holds now) went past the range too
    const unread = async (text) => {
        analyses += 1;
        const ratio = chartInfo(text, 1).noteCount / N0;
        if (ratio < 0.85) return { kind: "not-rice", message: "ln" };
        return { kind: "ok", numeric: ratio >= 0.91 ? 9.3 + (ratio - 0.91) * 10 : 8.8, label: "x", top3: [{ name: "Stream", share: 1 }] };
    };
    analyses = 0;
    const past = await remapChart({ osuText: ORIGINAL, range: { lo: 8.0, hi: 8.5 }, seed: 1 }, unread, null);
    assert.equal(past.reachable, false);
    assert.ok(twoSearches(analyses), `two searches: one went past the range (${analyses})`);
});

test("a map already in range comes back unchanged apart from its name", async () => {
    const out = await remapChart({ osuText: ORIGINAL, range: { lo: 9.5, hi: 10.5 }, seed: 1 }, fakeAnalyze, null);
    assert.deepEqual([out.removed, out.added, out.reachable], [0, 0, true]);
    assert.deepEqual(objectLines(out.osuText), objectLines(ORIGINAL));
});

test("a map without notes, or one the analyser cannot read, is refused in the current language", async () => {
    const empty = ORIGINAL.split("[HitObjects]")[0] + "[HitObjects]\r\n";
    await assert.rejects(remapChart({ osuText: empty, range: { lo: 1, hi: 2 }, seed: 1 }, fakeAnalyze, null), { message: t("gen.remap.noRows") });
    setLang("en");
    try {
        await assert.rejects(remapChart({ osuText: ORIGINAL, range: { lo: 1, hi: 2 }, seed: 1 }, async () => ({ kind: "too-short" }), null),
            { message: "Couldn't work out this map's dan: too-short" });
    } finally {
        setLang("ru");
    }
});

test("LF files stay LF and a BOM stays", async () => {
    const lf = "﻿" + ORIGINAL.replaceAll("\r\n", "\n");
    const out = await remapChart({ osuText: lf, range: { lo: 8.5, hi: 9.5 }, seed: 1 }, fakeAnalyze, null);
    assert.ok(!out.osuText.includes("\r"));
    assert.ok(out.osuText.startsWith("﻿osu file format v14\n"));
});

test("thickening keeps the map's share of jacks: a note that would make the map jackier waits until nothing else fits", () => {
    // one quick jumpjack (so a jack as fast as 1/4 is allowed), then a 1/2 jumpstream with no jack, which gets rows
    // between its rows; the model would put every new note into a jack
    const BEAT = 400;
    const objects = [];
    const put = (t, m) => {
        for (let c = 0; c < 4; c += 1) if (m & (1 << c)) objects.push(`${x(c)},192,${t},1,0,0:0:0:0:`);
    };
    for (let k = 0; k < 16; k += 1) put(1000 + k * (BEAT / 4), [3, 3, 12, 12][k % 4]);
    const stream = [5, 2, 8, 3, 4, 9, 2, 8];
    for (let k = 0; k < 96; k += 1) put(1000 + 5 * BEAT + k * (BEAT / 2), stream[k % stream.length]);
    const text = ["osu file format v14", "", "[General]", "Mode: 3", "", "[Metadata]", "Version:Jacks", "", "[Difficulty]", "CircleSize:4", "",
        "[TimingPoints]", `1000,${BEAT},4,2,0,60,1,0`, "", "[HitObjects]", ...objects, ""].join("\r\n");
    const chart = parseChart(text);
    const share = (rows) => rows.filter((r, i) => i > 0 && (r.mask & rows[i - 1].mask) && r.t - rows[i - 1].t <= BEAT / 2 + 1).length / rows.length;
    const before = share(chart.rows);
    assert.ok(before > 0);
    for (const seed of [1, 2, 3]) {
        const plan = { additions: additionOrder(chart, { seed, model: jackLover }) };
        for (const knob of [0.5, 1]) {
            const rows = rowsOf(applyKnob(chart, plan, knob).osuText);
            assert.ok(rows.reduce((n, r) => n + popcount(r.mask), 0) > chart.notes.length, "notes were added");
            assert.ok(share(rows) <= before + 1e-9, `seed ${seed} at ${knob}: ${share(rows).toFixed(3)} of the rows a jack, the original ${before.toFixed(3)}`);
        }
    }
});
