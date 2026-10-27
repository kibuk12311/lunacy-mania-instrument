import test from "node:test";
import assert from "node:assert/strict";
import { createAutoMarathon } from "../src/rate/autoMarathon.js";
import { rateForDan } from "../src/rate/rateForDan.js";
import { numericToLabel } from "../src/core/labels.js";
import { makeChart } from "./fixtures/makeChart.js";
import { setLang } from "../src/i18n/i18n.js";

// One tracker set with one 4K diff at a tracker dan.
const item = (setId, beatmapId, dan, extra = {}) => ({
    beatmapsetId: setId, artist: `Artist ${setId}`, title: `Song ${setId}`, creator: "m", status: "ranked",
    diffs: [{ beatmapId, beatmapsetId: setId, version: `V${beatmapId}`, dan: { rawDan: dan }, lnShare: 0, playCount: 1000 - beatmapId % 100, msd: {}, patterns: {}, length: 120, ...extra }],
});

// A chart whose dan at 1.0x is base, +3 per 1.0 of rate (what the fake analyser reads from BeatmapID).
const chartText = (beatmapId, setId) => makeChart({ kind: "stream", bpm: 160, seconds: 30 })
    .replace("[Metadata]", `[Metadata]\r\nBeatmapID:${beatmapId}\r\nBeatmapSetID:${setId}`)
    .replace(/^Title:.*$/m, `Title:Song ${setId}`).replace(/^Artist:.*$/m, `Artist:Artist ${setId}`).replace(/^Version:.*$/m, `Version:V${beatmapId}`);

function world({ sets, bases, local = new Map(), failDownload = new Set(), played = new Map() }) {
    const calls = { search: [], download: [], analyze: [], progress: [], extract: [] };
    let cancelAt = null; // (event) → true to cancel from then on
    let cancelled = false;
    const deps = {
        searchMaps: async (params) => {
            calls.search.push(params);
            return { items: sets(params), total: 0, page: 0 };
        },
        played: async () => played,
        findLocal: async (setId, beatmapId) => local.get(`${setId}/${beatmapId}`) ?? null,
        download: async ({ beatmapsetId, onProgress }) => {
            calls.download.push(beatmapsetId);
            if (failDownload.has(beatmapsetId)) throw new Error(`mirror down for ${beatmapsetId}`);
            onProgress?.({ received: 5, total: 10 });
            return { file: `/dl/${beatmapsetId}.osz`, reused: false };
        },
        readFile: async (file) => Buffer.from(file),
        extract: async (buffer, beatmapId, setId) => {
            calls.extract.push([String(buffer), beatmapId, setId]);
            return { osuPath: `/out/${setId}/${beatmapId}.osu`, osuText: chartText(beatmapId, setId) };
        },
        analyze: async (osuText, rate) => {
            const id = Number(/^BeatmapID:(\d+)/m.exec(osuText)[1]);
            calls.analyze.push([id, rate]);
            const numeric = Math.round((bases.get(id) + 3 * (rate - 1)) * 100) / 100;
            return { kind: "ok", numeric, label: numericToLabel(numeric).text, primary: "Stream" };
        },
        rateForDan,
        progress: (event) => {
            calls.progress.push(event);
            if (cancelAt?.(event)) cancelled = true;
        },
    };
    return { deps, calls, cancelWhen: (fn) => { cancelAt = fn; }, isCancelled: () => cancelled };
}

const request = (targets, patternIds = ["stream"], extra = {}) => ({ targets, patternIds, lengthId: "any", rankedOnly: false, skipPlayed: false, ...extra });

test("a map found in Songs is not downloaded, and fits the target by rate", async () => {
    const w = world({
        sets: () => [item(10, 1001, 12.8)],
        bases: new Map([[1001, 12.4]]),
        local: new Map([["10/1001", { path: "C:/osu/Songs/10 a/x.osu", osuText: chartText(1001, 10) }]]),
    });
    const r = await createAutoMarathon(w.deps).run(request([13]), w.isCancelled);
    assert.deepEqual(w.calls.download, []);
    assert.equal(r.entries.length, 1);
    const e = r.entries[0];
    assert.equal(e.from, "songs");
    assert.equal(e.path, "C:/osu/Songs/10 a/x.osu");
    assert.equal(e.name, "Artist 10 - Song 10 [V1001]");
    assert.ok(Math.abs(e.numeric - 13) <= 0.15, String(e.numeric));
    assert.ok(e.rate >= 0.8 && e.rate <= 1.45);
    assert.equal(e.label, numericToLabel(e.numeric).text);
    assert.ok(e.cutMs > 29000);
    assert.equal(e.targetDan, 13);
    assert.equal(e.trackerDan, 12.8);
    assert.deepEqual([e.beatmapId, e.beatmapsetId], [1001, 10]);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.cancelled, undefined);
});

test("the search window sits around the target, shifted down, with the template's length and the ranked filter", async () => {
    const w = world({ sets: () => [], bases: new Map() });
    await createAutoMarathon(w.deps).run(request([13], ["jumpstream"], { lengthId: "long", rankedOnly: true }), w.isCancelled);
    const p = w.calls.search[0];
    assert.equal(p.patterns, "jumpstream");
    assert.equal(p.lenMin, 240);
    assert.equal(p.statuses, "ranked,loved");
    // [12.5, 13.2] in tracker steps: 12.5 is "12 +2"; 13.2 is "13 +1"
    assert.deepEqual([p.danMin, p.danMinStep, p.danMax, p.danMaxStep], [12, 2, 13, 1]);
});

test("a failed download gives way to the next candidate", async () => {
    const w = world({
        sets: () => [item(10, 1001, 12.9), item(20, 2001, 12.8)],
        bases: new Map([[1001, 12.9], [2001, 12.8]]),
        failDownload: new Set([10]),
    });
    const r = await createAutoMarathon(w.deps).run(request([13]), w.isCancelled);
    assert.deepEqual(w.calls.download, [10, 20]);
    assert.equal(r.entries[0].beatmapsetId, 20);
    assert.equal(r.entries[0].from, "download");
    assert.equal(r.entries[0].path, "/out/20/2001.osu");
    assert.deepEqual(w.calls.extract, [["/dl/20.osz", 2001, 20]]);
    assert.ok(w.calls.progress.some((e) => e.phase === "skip" && e.name === "Artist 10 - Song 10 [V1001]"));
});

test("no set is taken twice, and a set that failed is not tried again", async () => {
    const w = world({
        sets: () => [item(10, 1001, 12.9), item(20, 2001, 12.8), item(30, 3001, 12.7), item(40, 4001, 12.6)],
        bases: new Map([[1001, 12.9], [2001, 12.8], [3001, 12.7], [4001, 12.6]]),
        failDownload: new Set([20]),
    });
    const r = await createAutoMarathon(w.deps).run(request([12.9, 13, 13.1]), w.isCancelled);
    const sets = r.entries.map((e) => e.beatmapsetId);
    assert.equal(new Set(sets).size, sets.length);
    assert.equal(sets.length, 3);
    assert.ok(!sets.includes(20));
    assert.equal(w.calls.download.filter((id) => id === 20).length, 1);
});

test("the patterns take turns, step by step", async () => {
    const w = world({ sets: () => [], bases: new Map() });
    const r = await createAutoMarathon(w.deps).run(request([12, 12.5, 13, 13.5], ["jumpstream", "chordjack"]), w.isCancelled);
    assert.deepEqual(w.calls.search.map((p) => p.patterns), ["jumpstream", "chordjack", "jumpstream", "chordjack"]);
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.warnings.map((x) => [x.kind, x.i]), [["miss", 1], ["miss", 2], ["miss", 3], ["miss", 4]]);
    assert.equal(r.warnings[0].reason, "в трекере нет карт под это окно");
});

test("four patterns take turns in the order they were picked", async () => {
    const w = world({ sets: () => [], bases: new Map() });
    await createAutoMarathon(w.deps).run(request([12, 12.2, 12.4, 12.6, 12.8], ["tech", "stream", "jack", "stamina"]), w.isCancelled);
    assert.deepEqual(w.calls.search.map((p) => p.patterns), ["tech", "stream", "jack", "stamina", "tech"]);
});

test("played maps are skipped when asked", async () => {
    const make = (skipPlayed) => {
        const w = world({
            sets: () => [item(10, 1001, 12.9), item(20, 2001, 12.8)],
            bases: new Map([[1001, 12.9], [2001, 12.8]]),
            played: new Map([[1001, { beatmapsetId: 10, accuracy: 97, rate: 1 }]]),
        });
        return createAutoMarathon(w.deps).run(request([13], ["stream"], { skipPlayed }), w.isCancelled);
    };
    assert.equal((await make(true)).entries[0].beatmapId, 2001);
    assert.equal((await make(false)).entries[0].beatmapId, 1001);
});

test("cancelling stops between phases and keeps the maps already picked", async () => {
    const w = world({
        sets: () => [item(10, 1001, 12.9), item(20, 2001, 12.8)],
        bases: new Map([[1001, 12.9], [2001, 12.8]]),
    });
    w.cancelWhen((e) => e.i === 2 && e.phase === "download");
    const r = await createAutoMarathon(w.deps).run(request([12.9, 13]), w.isCancelled);
    assert.equal(r.cancelled, true);
    assert.equal(r.entries.length, 1);
    // the second map was never analysed
    assert.ok(w.calls.analyze.every(([id]) => id === r.entries[0].beatmapId));
    assert.ok(!w.calls.progress.some((e) => e.phase === "done"));
});

test("progress: search, where the file comes from, analysis, then done", async () => {
    const w = world({
        sets: (p) => (p.patterns === "stream" ? [item(10, 1001, 12.9)] : [item(20, 2001, 12.8)]),
        bases: new Map([[1001, 12.9], [2001, 12.8]]),
        local: new Map([["20/2001", { path: "C:/Songs/20/x.osu", osuText: chartText(2001, 20) }]]),
    });
    await createAutoMarathon(w.deps).run(request([12.9, 13], ["stream", "jumpstream"]), w.isCancelled);
    assert.deepEqual(w.calls.progress.map((e) => `${e.i}/${e.n} ${e.phase}`), [
        "1/2 search", "1/2 download", "1/2 download", "1/2 analyze",
        "2/2 search", "2/2 songs", "2/2 analyze",
        "2/2 done",
    ]);
    const search = w.calls.progress[0];
    assert.equal(search.patternId, "stream");
    assert.equal(search.target, 12.9);
    assert.deepEqual(w.calls.progress.filter((e) => e.phase === "download").map((e) => [e.received, e.total]), [[0, null], [5, 10]]);
    assert.equal(w.calls.progress[1].name, "Artist 10 - Song 10 [V1001]");
    assert.equal(w.calls.progress[5].name, "Artist 20 - Song 20 [V2001]");
    // a set found in Songs is never downloaded, not even ahead
    assert.deepEqual(w.calls.download, [10]);
});

test("the next map's set downloads while this one is analysed, one download at a time", async () => {
    const w = world({
        sets: (p) => (p.patterns === "stream" ? [item(10, 1001, 12.9)] : [item(20, 2001, 12.8)]),
        bases: new Map([[1001, 12.9], [2001, 12.8]]),
    });
    let active = 0;
    let most = 0;
    const download = w.deps.download;
    w.deps.download = async (req) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 20));
        try {
            return await download(req);
        } finally {
            active -= 1;
        }
    };
    let aheadDuringAnalysis = false;
    const analyze = w.deps.analyze;
    w.deps.analyze = async (osuText, rate) => {
        if (/^BeatmapID:1001/m.test(osuText)) {
            await new Promise((r) => setTimeout(r, 60));
            aheadDuringAnalysis = w.calls.download.includes(20);
        }
        return analyze(osuText, rate);
    };
    const r = await createAutoMarathon(w.deps).run(request([12.9, 13], ["stream", "jumpstream"]), w.isCancelled);
    assert.equal(aheadDuringAnalysis, true);
    assert.deepEqual(w.calls.download, [10, 20]);
    assert.equal(most, 1);
    assert.deepEqual(r.entries.map((e) => [e.beatmapsetId, e.from]), [[10, "download"], [20, "download"]]);
    // the second map's line still says it is downloading
    assert.ok(w.calls.progress.some((e) => e.i === 2 && e.phase === "download"));
});

test("nothing reaches the target even at 1.45x: the closest stays, with a warning", async () => {
    const w = world({
        sets: () => [item(10, 1001, 12.5), item(20, 2001, 12.5), item(30, 3001, 12.5), item(40, 4001, 12.5)],
        // at 1.45x: 10.35 + 1.35 = 11.7, 10.65 + 1.35 = 12.0, 10.45 + 1.35 = 11.8 — all short of 13
        bases: new Map([[1001, 10.35], [2001, 10.65], [3001, 10.45], [4001, 12.5]]),
    });
    const r = await createAutoMarathon(w.deps).run(request([13]), w.isCancelled);
    // three candidates at most
    assert.deepEqual(w.calls.download, [10, 20, 30]);
    assert.equal(r.entries[0].beatmapId, 2001);
    assert.equal(r.entries[0].rate, 1.45);
    assert.deepEqual(r.warnings, [{ kind: "short", i: 1, label: numericToLabel(12).text, rate: 1.45 }]);
});

test("too hard even at 0.8x is told apart from too easy", async () => {
    const w = world({ sets: () => [item(10, 1001, 13.1)], bases: new Map([[1001, 14]]) });
    const r = await createAutoMarathon(w.deps).run(request([13]), w.isCancelled);
    assert.equal(r.entries[0].rate, 0.8);
    assert.equal(r.warnings[0].kind, "over");
});

test("a search that fails is a miss with its reason, in the app's language", async () => {
    const w = world({ sets: () => { throw new Error("tracker down"); }, bases: new Map() });
    const r = await createAutoMarathon(w.deps).run(request([13, 13.2]), w.isCancelled);
    assert.deepEqual(r.warnings, [{ kind: "miss", i: 1, reason: "tracker down" }, { kind: "miss", i: 2, reason: "tracker down" }]);
    setLang("en");
    try {
        const empty = world({ sets: () => [], bases: new Map() });
        const out = await createAutoMarathon(empty.deps).run(request([13]), empty.isCancelled);
        assert.equal(out.warnings[0].reason, "the tracker has no maps in this window");
    } finally {
        setLang("ru");
    }
});

test("after Stop no queued download starts; the running one finishes in the background", async () => {
    const w = world({
        sets: (p) => (p.patterns === "stream" ? [item(30, 3001, 12.9), item(40, 4001, 12.8)] : [item(20, 2001, 13)]),
        // set 30 cannot reach 13 even at 1.45x, so map 1 goes on to set 40
        bases: new Map([[3001, 10], [4001, 12.8], [2001, 13]]),
    });
    let release;
    const download = w.deps.download;
    // the look-ahead takes set 20 for map 2 while set 30 is analysed; it hangs, so set 40 waits behind it
    w.deps.download = async (req) => {
        if (req.beatmapsetId === 20) await new Promise((r) => { release = r; });
        return download(req);
    };
    // set 30 is analysed slowly, so the look-ahead has queued set 20 by then
    const analyze = w.deps.analyze;
    w.deps.analyze = async (osuText, rate) => {
        if (/^BeatmapID:3001/m.test(osuText)) await new Promise((r) => setTimeout(r, 20));
        return analyze(osuText, rate);
    };
    w.cancelWhen((e) => e.i === 1 && e.phase === "download" && e.name.includes("Song 40"));
    const r = await createAutoMarathon(w.deps).run(request([13, 13.2], ["stream", "jumpstream"]), w.isCancelled);
    assert.equal(r.cancelled, true);
    assert.deepEqual(r.entries, []);
    release();
    await new Promise((r2) => setTimeout(r2, 30));
    assert.deepEqual(w.calls.download, [30, 20]);
});
