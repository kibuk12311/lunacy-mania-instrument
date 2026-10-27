// The session library's analysis a few maps at once (app/sessionLibrary.js over analyze.lanes, the library's own
// workers in the app): never more than the lanes, a pause that stops new jobs while the running ones finish and are
// kept, the store still saved every 100 maps and every 15 s, and a status after every map.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionLibrary } from "../app/sessionLibrary.js";
import { makeSongsFolder, withMeta } from "./fixtures/songsFolder.js";
import { makeChart } from "./fixtures/makeChart.js";

const tempStore = async () => path.join(await mkdtemp(path.join(tmpdir(), "seslib-lanes-")), "session-library.json");
// n one-chart sets of short 4K charts, each its own .osu (its title is its number)
const library = (n) => makeSongsFolder(Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, artist: "Test", title: `Song ${i}`,
    charts: [{ file: `Test - Song ${i} (M) [Hard].osu`, text: withMeta(makeChart({ kind: "stream", bpm: 150 + (i % 50), seconds: 8 }), { Title: `Song ${i}`, Artist: "Test", Version: "Hard" }) }],
})));
const RESULT = { kind: "ok", numeric: 10, label: "x", primary: "Stream", top3: [{ name: "Stream", share: 1 }], tech: false, durationSec: 8, bpm: 150 };

// analyze with `lanes`, answered by hand (calls[i].resolve()) or by itself after delayMs once `auto` is set
function manualAnalyze(lanes) {
    const f = { calls: [], open: 0, peak: 0, auto: false, delayMs: 0 };
    f.analyze = Object.assign((text) => {
        f.open += 1;
        f.peak = Math.max(f.peak, f.open);
        const title = /^Title:(.*)$/m.exec(text)[1].trim();
        return new Promise((resolve) => {
            const call = { title, resolve: () => { f.open -= 1; resolve(RESULT); } };
            f.calls.push(call);
            if (f.auto) setTimeout(call.resolve, f.delayMs);
        });
    }, { lanes });
    return f;
}

async function until(check, what) {
    for (let i = 0; i < 2000; i += 1) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 2));
    }
    assert.fail(`timed out waiting for ${what}`);
}

test("the library analyses analyze.lanes maps at once, never more, each once", async () => {
    const songs = await library(12);
    const f = manualAnalyze(3);
    const statuses = [];
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: f.analyze, file: await tempStore(), analyzer: "t1", onChange: (s) => statuses.push(s) });
    const scan = lib.scan();
    await until(() => f.calls.length === 3, "three jobs");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 3, "a fourth waits for a free lane");
    f.calls[0].resolve();
    await until(() => f.calls.length === 4, "the next map in the freed lane");
    f.auto = true;
    for (const c of f.calls.slice(1)) c.resolve();
    await scan;
    const st = await lib.status();
    assert.equal(st.phase, "done");
    assert.equal(st.counts.analysed, 12);
    assert.equal(f.calls.length, 12);
    assert.equal(new Set(f.calls.map((c) => c.title)).size, 12, "no map twice");
    assert.equal(f.peak, 3);
    // the progress: a status after every map, the count going up to all of them
    const analysing = statuses.filter((s) => s.phase === "analysing").map((s) => s.counts.analysed);
    assert.ok(analysing.length >= 12);
    assert.equal(Math.max(...analysing), 12);
    await rm(songs, { recursive: true, force: true });
});

test("without lanes the library analyses one map at a time, as before", async () => {
    const songs = await library(4);
    const f = manualAnalyze(undefined);
    f.auto = true;
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: f.analyze, file: await tempStore(), analyzer: "t1" });
    await lib.scan();
    assert.equal((await lib.status()).counts.analysed, 4);
    assert.equal(f.peak, 1);
    await rm(songs, { recursive: true, force: true });
});

test("a pause stops new jobs: the running ones finish and are kept, the rest wait for resume", async () => {
    const songs = await library(10);
    const f = manualAnalyze(3);
    const file = await tempStore();
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: f.analyze, file, analyzer: "t1" });
    const scan = lib.scan();
    await until(() => f.calls.length === 3, "three jobs");
    lib.pause();
    for (const c of f.calls) c.resolve();
    await scan;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 3, "nothing new after the pause");
    let st = await lib.status();
    assert.equal(st.phase, "paused");
    assert.equal(st.counts.analysed, 3, "the three that were running are kept");
    assert.equal(st.counts.pending, 7);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(Object.values(saved.maps).filter((m) => m.a?.kind === "ok").length, 3, "and saved");

    f.auto = true;
    await lib.resume();
    st = await lib.status();
    assert.equal(st.phase, "done");
    assert.equal(st.counts.analysed, 10);
    assert.equal(f.calls.length, 10, "the paused ones are not analysed again");
    assert.equal(f.peak, 3);
    await rm(songs, { recursive: true, force: true });
});

test("the store is still saved every 100 maps and every 15 s while the lanes run", async () => {
    const songs = await library(250);
    // the saves: every store written, with how many maps it had analysed
    const saves = [];
    const fs = { ...nodeFs, writeFile: async (p, text, enc) => {
        if (String(p).endsWith(".tmp")) saves.push(Object.values(JSON.parse(text).maps).filter((m) => m.a).length);
        return nodeFs.writeFile(p, text, enc);
    } };
    const f = manualAnalyze(4);
    f.auto = true;
    f.delayMs = 3; // long enough for all four lanes to be under way at once
    const file = await tempStore();
    await createSessionLibrary({ songsDir: async () => songs, analyze: f.analyze, file, analyzer: "t1", fs }).scan();
    // after the listing, at 100 and 200 (the save every 100 maps), and at the end
    assert.deepEqual(saves, [0, 100, 200, 250]);
    assert.equal(f.peak, 4);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(Object.values(saved.maps).filter((m) => m.a?.kind === "ok").length, 250);

    // a slow library: the clock moves 6 s per map, so every third map is a save (more than 15 s since the last)
    const slow = await library(9);
    const clock = { t: 0 };
    const g = manualAnalyze(3);
    g.analyze = Object.assign((text, rate) => { clock.t += 6000; return f.analyze(text, rate); }, { lanes: 3 });
    saves.length = 0;
    await createSessionLibrary({ songsDir: async () => slow, analyze: g.analyze, file: await tempStore(), analyzer: "t1", fs, now: () => clock.t }).scan();
    assert.ok(saves.length >= 4, `saved on time as well (${saves.join(", ")})`);
    assert.equal(saves.at(-1), 9);
    await rm(songs, { recursive: true, force: true });
    await rm(slow, { recursive: true, force: true });
});

test("a resume while the lanes are still finishing their maps goes on with every lane, to the end", async () => {
    const songs = await library(10);
    const f = manualAnalyze(3);
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: f.analyze, file: await tempStore(), analyzer: "t1" });
    const scan = lib.scan();
    await until(() => f.calls.length === 3, "three jobs");
    lib.pause();
    f.calls[0].resolve();
    f.calls[1].resolve();
    await new Promise((r) => setTimeout(r, 20)); // two lanes have stopped, one map is still under way
    assert.equal(f.calls.length, 3);
    const resumed = lib.resume();
    assert.equal((await lib.status()).paused, false);
    f.peak = f.open;
    f.calls[2].resolve();
    await until(() => f.calls.length >= 6, "all three lanes again");
    assert.equal(f.peak, 3, "every lane is back");
    f.auto = true;
    for (const c of f.calls.slice(3)) c.resolve();
    await Promise.all([scan, resumed]);
    const st = await lib.status();
    assert.equal(st.phase, "done");
    assert.equal(st.counts.pending, 0);
    assert.equal(st.counts.analysed, 10);
    assert.equal(new Set(f.calls.map((c) => c.title)).size, f.calls.length, "no map twice");
    await rm(songs, { recursive: true, force: true });
});

test("a resume while the store is being written after every lane stopped still ends the run done", async () => {
    const songs = await library(6);
    const f = manualAnalyze(2);
    let gate = null; // holds the next store write
    const fs = { ...nodeFs, writeFile: async (p, text, enc) => {
        if (gate) await gate.promise;
        return nodeFs.writeFile(p, text, enc);
    } };
    const lib = createSessionLibrary({ songsDir: async () => songs, analyze: f.analyze, file: await tempStore(), analyzer: "t1", fs });
    const scan = lib.scan();
    await until(() => f.calls.length === 2, "two jobs");
    lib.pause();
    let open;
    gate = { promise: new Promise((r) => { open = r; }) };
    for (const c of f.calls) c.resolve(); // both lanes stop; the run writes the store
    await new Promise((r) => setTimeout(r, 20));
    const resumed = lib.resume();
    f.auto = true;
    gate = null;
    open();
    await Promise.all([scan, resumed]);
    const st = await lib.status();
    assert.equal(st.paused, false);
    assert.equal(st.phase, "done");
    assert.equal(st.counts.pending, 0);
    await rm(songs, { recursive: true, force: true });
});
