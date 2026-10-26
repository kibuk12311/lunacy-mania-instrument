import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    loadSplitIndex, checkHeldout, requireHeldout, heldoutPool, selectHeldout, labelChart, isOsuSource, normPath,
    defaultSplitFiles, readHeldoutPool, isHeldoutIn, CANDIDATE_SPLITS,
} from "../../tools/eval/heldout.mjs";
import { makeChart } from "../fixtures/makeChart.js";

async function withSplit(lines, fn) {
    const dir = await mkdtemp(path.join(tmpdir(), "heldout-"));
    try {
        const file = path.join(dir, "corpus.jsonl");
        await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        return await fn(file);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const CORPUS = [
    { source: "songs", osu: "A:/Games/osu!/Songs/1 Set/a [Hard].osu", chartKey: "k1", group: "g1", split: "heldout", duplicates: [{ source: "hf", osu: "A:/SneezeyTrain/hf/1/11.osu" }] },
    { source: "etterna", osu: "A:/SneezeyTrain/etterna/songs/p/s/x.osu", chartKey: "k2", group: "g2", split: "train" },
    { source: "sets", osu: "A:/SneezeyTrain/sets/3/c.osu", chartKey: "k3", group: "g3", split: "quarantine" },
    { source: "hf", osu: "A:/SneezeyTrain/hf/4/d.osu", chartKey: "k4", group: "g1", split: "heldout" },
];

test("held-out assertion: picks found by path, duplicate path, chart key or group must all be held out", async () => {
    await withSplit(CORPUS, async (file) => {
        const index = await loadSplitIndex([file]);
        const picks = [
            { osuPath: "A:\\Games\\osu!\\Songs\\1 Set\\a [Hard].osu" }, // backslashes, by path
            { osuPath: "a:/sneezeytrain/hf/1/11.osu" }, // a duplicate's path, any case
            { osuPath: "elsewhere/copy.osu", chartKey: "k4" }, // a copy somewhere else, by chart key
            { osuPath: "elsewhere/other.osu", group: "g1" }, // by song group
        ];
        const report = checkHeldout(picks, index);
        assert.equal(report.problems.length, 0, JSON.stringify(report.problems));
        assert.equal(report.ok, 4);
        assert.doesNotThrow(() => requireHeldout(picks, index));

        const bad = [
            { osuPath: "A:/SneezeyTrain/etterna/songs/p/s/x.osu" },
            { osuPath: "nowhere.osu", chartKey: "k3" },
            { osuPath: "unknown.osu" },
        ];
        const r = checkHeldout(bad, index);
        assert.deepEqual(r.problems.map((p) => p.reason), ["train", "quarantine", "not in the split index"]);
        assert.throws(() => requireHeldout(bad, index), /3 of 3 picks.*train/s);
        // a chart key from the pick's own text is used when the pick has none
        const viaText = checkHeldout([{ osuPath: "z.osu" }], index, { chartKeyOf: () => "k1" });
        assert.equal(viaText.problems.length, 0);
    });
});

test("held-out assertion reads several split files (index.jsonl + index-heldout.jsonl with osuPath)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "heldout2-"));
    try {
        const a = path.join(dir, "index.jsonl");
        const b = path.join(dir, "index-heldout.jsonl");
        await writeFile(a, JSON.stringify({ osuPath: "x/train.osu", chartKey: "t1", group: "gt", split: "train" }) + "\n");
        await writeFile(b, JSON.stringify({ osuPath: "x/held.osu", chartKey: "h1", group: "gh", split: "heldout" }) + "\n\n");
        const index = await loadSplitIndex([a, b]);
        assert.equal(checkHeldout([{ osuPath: "x/held.osu" }], index).problems.length, 0);
        assert.equal(checkHeldout([{ osuPath: "x/train.osu" }], index).problems[0].reason, "train");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a pick held out in the corpus but in a candidate's training split (mapper15) fails; mapper3 test passes, val fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "heldout3-"));
    try {
        const corpus = path.join(dir, "corpus.jsonl");
        const m15 = path.join(dir, "index.jsonl");
        const m3 = path.join(dir, "heldout.json");
        await writeFile(corpus, [
            { source: "hf", osu: "x/a.osu", chartKey: "ka", group: "ga", split: "heldout" },
            { source: "hf", osu: "x/b.osu", chartKey: "kb", group: "gb", split: "heldout" },
            { source: "hf", osu: "x/c.osu", chartKey: "kc", group: "gc", split: "heldout" },
            { source: "hf", osu: "x/d.osu", chartKey: "kd", group: "gd", split: "train" },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n");
        // mapper15 was built when b's song was still on the train side (under another chart path, same group)
        await writeFile(m15, JSON.stringify({ osuPath: "old/b-copy.osu", chartKey: "kb2", group: "gb", split: "train" }) + "\n");
        await writeFile(m3, JSON.stringify({ v: 1, test: [{ group: "ga", songKeys: ["ga"] }], val: [{ group: "gd", songKeys: ["gd", "gd tv"] }], quarantine: [] }));
        const corpusOnly = await loadSplitIndex([corpus]);
        const picks = [{ osuPath: "x/a.osu", group: "ga" }, { osuPath: "x/b.osu", group: "gb" }, { osuPath: "x/c.osu", group: "gc" }];
        assert.equal(checkHeldout(picks, corpusOnly).problems.length, 0, "the corpus alone sees no problem");
        const all = await loadSplitIndex([corpus, m15, m3]);
        const r = checkHeldout(picks, all);
        assert.deepEqual(r.problems.map((p) => [p.osuPath, p.reason]), [["x/b.osu", "train"]]);
        // mapper3's val split is tuned on: never an evaluation song
        assert.equal(checkHeldout([{ osuPath: "y/z.osu", group: "gd tv" }], all).problems[0].reason, "val");
        assert.ok(isHeldoutIn(all, { osu: "x/a.osu", group: "ga" }) && !isHeldoutIn(all, { osu: "x/b.osu", group: "gb" }));
        // the pool for a new held-out set leaves out what any candidate trained on
        const pool = await readHeldoutPool(corpus, { index: all, seed: "s" });
        assert.deepEqual(pool.map((c) => c.group).sort(), ["ga", "gc"]);
        assert.equal(pool.dropped, 1);
        // the default files: the corpus + every candidate split that exists
        assert.deepEqual(defaultSplitFiles("c.jsonl", { exists: (f) => f.includes("mapper15") }), ["c.jsonl", CANDIDATE_SPLITS[0], CANDIDATE_SPLITS[1]]);
        assert.ok(CANDIDATE_SPLITS.includes("A:/SneezeyTrain/mapper3/heldout.json"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the held-out pool keeps one chart per held-out group, rate 1 and osu! sources first, in a seeded order", () => {
    const lines = [
        { source: "etterna", osu: "e/1.osu", group: "g1", split: "heldout", rate: 1 },
        { source: "hf", osu: "h/1.osu", group: "g1", split: "heldout", rate: 1.2 },
        { source: "sets", osu: "s/1.osu", group: "g1", split: "heldout", rate: 1 },
        { source: "hf", osu: "h/2.osu", group: "g2", split: "train", rate: 1 },
        { source: "hf", osu: "h/3.osu", group: "g3", split: "quarantine", rate: 1 },
        ...Array.from({ length: 20 }, (_, i) => ({ source: "etterna", osu: `e/x${i}.osu`, group: `x${i}`, split: "heldout", rate: 1 })),
    ];
    const pool = heldoutPool(lines, { seed: "s1" });
    assert.equal(pool.length, 21);
    assert.equal(new Set(pool.map((c) => c.group)).size, 21);
    assert.ok(!pool.some((c) => c.group === "g2" || c.group === "g3"));
    assert.equal(pool.find((c) => c.group === "g1").osu, "s/1.osu");
    assert.deepEqual(heldoutPool(lines, { seed: "s1" }).map((c) => c.group), pool.map((c) => c.group));
    assert.notDeepEqual(heldoutPool(lines, { seed: "s2" }).map((c) => c.group), pool.map((c) => c.group));
    assert.ok(isOsuSource("hf") && isOsuSource("songs") && isOsuSource("ranked") && !isOsuSource("etterna") && !isOsuSource("malody"));
    assert.equal(normPath("A:\\X\\\\y.osu"), "a:/x/y.osu");
});

const FAMS = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack"];

function pool({ perCell = 3, variableEvery = 0, offEvery = 0, osuEvery = 2 } = {}) {
    const out = [];
    let k = 0;
    for (let dan = 3; dan <= 18; dan += 1) {
        for (const family of FAMS) {
            for (let j = 0; j < perCell; j += 1) {
                out.push({
                    group: `g${k}`, source: k % osuEvery === 0 ? "hf" : "etterna", dan: dan + 0.3, family,
                    variable: variableEvery ? k % variableEvery === 0 : false, offQuarter: offEvery && k % offEvery === 0 ? 0.3 : 0,
                });
                k += 1;
            }
        }
    }
    out.push({ group: "low", source: "hf", dan: 2.9, family: "Stream" }, { group: "high", source: "hf", dan: 19.2, family: "Stream" });
    return out;
}

test("stratified pick: every dan bin 3–18 × family cell once before any twice", () => {
    const { picks } = selectHeldout(pool(), { n: 80, seed: 1, minVariable: 0, minTriplet: 0, osuShare: 0 });
    assert.equal(picks.length, 80);
    const cells = new Map();
    for (const p of picks) cells.set(`${Math.floor(p.dan)}|${p.family}`, (cells.get(`${Math.floor(p.dan)}|${p.family}`) ?? 0) + 1);
    assert.equal(cells.size, 80);
    assert.ok(!picks.some((p) => p.group === "low" || p.group === "high"), "dan 3–18 only");
    assert.equal(new Set(picks.map((p) => p.group)).size, 80);
});

test("stratified pick meets the variable-BPM, triplet and osu! quotas and is deterministic", () => {
    const cands = pool({ variableEvery: 7, offEvery: 5, osuEvery: 2 });
    const opts = { n: 180, seed: 3, minVariable: 30, minTriplet: 30, osuShare: 0.5 };
    const { picks, notes } = selectHeldout(cands, opts);
    assert.equal(picks.length, 180);
    assert.ok(picks.filter((p) => p.variable).length >= 30);
    assert.ok(picks.filter((p) => p.offQuarter >= 0.1).length >= 30);
    assert.ok(picks.filter((p) => isOsuSource(p.source)).length >= 90);
    assert.deepEqual(notes, []);
    assert.deepEqual(selectHeldout(cands, opts).picks.map((p) => p.group), picks.map((p) => p.group));
    // dan bins stay balanced: no bin more than twice another
    const bins = new Map();
    for (const p of picks) bins.set(Math.floor(p.dan), (bins.get(Math.floor(p.dan)) ?? 0) + 1);
    assert.equal(bins.size, 16);
    assert.ok(Math.max(...bins.values()) <= 2 * Math.min(...bins.values()));
});

test("a quota the pool cannot meet is reported, not silently dropped", () => {
    const { picks, notes } = selectHeldout(pool({ perCell: 1 }), { n: 50, seed: 1, minVariable: 30, minTriplet: 0, osuShare: 0 });
    assert.equal(picks.length, 50);
    assert.match(notes.join(" "), /variable-BPM.*0 of 30/);
});

test("labelChart: dan and family from the analyser, BPM changes and off-1/4 beats from the chart", async () => {
    const fake = async () => ({ kind: "ok", numeric: 12.34, primary: "Minitrills", top3: [{ name: "Minitrills", share: 0.7 }] });
    const quarter = await labelChart(makeChart({ kind: "stream", bpm: 180, seconds: 30 }), fake);
    assert.equal(quarter.dan, 12.3);
    assert.equal(quarter.family, "Stream");
    assert.equal(quarter.primary, "Minitrills");
    assert.equal(quarter.variable, false);
    assert.equal(quarter.offQuarter, 0);
    assert.ok(Math.abs(quarter.bpm - 180) < 1e-9);
    // 1/8 rows on a 90 BPM red line = 1/4 rows at 180: every beat needs 1/8
    const eighth = makeChart({ kind: "stream", bpm: 180, seconds: 30 })
        .replace(/\[TimingPoints\]\r?\n([^,\r\n]+),([^,\r\n]+),/, (m, t, len) => `[TimingPoints]\n${t},${Number(len) * 2},`);
    const e = await labelChart(eighth, fake);
    assert.ok(e.offQuarter > 0.9, `offQuarter ${e.offQuarter}`);
    assert.equal(e.triplet, 0);
    const twoBpm = makeChart({ kind: "stream", bpm: 180, seconds: 30 }).replace(/\[TimingPoints\]\r?\n([^\r\n]+)/, (m, line) => {
        const p = line.split(",");
        const later = [String(Number(p[0]) + 10000), String(60000 / 200), ...p.slice(2)].join(",");
        return `[TimingPoints]\n${line}\n${later}`;
    });
    assert.equal((await labelChart(twoBpm, fake)).variable, true);
    assert.equal(await labelChart("not a chart", async () => ({ kind: "error" })), null);
});
