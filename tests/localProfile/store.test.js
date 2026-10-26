// The local profile on disk (app/localProfileStore.js) and the Songs md5 index (app/osuSongsScan.js), in temp folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, utimes } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalProfileStore, normalizePlay, mapSummary, mapKeyOf, BUNDLE_FORMAT } from "../../app/localProfileStore.js";
import { createSongsMd5Index, chartEntry } from "../../app/osuSongsScan.js";
import { makeChart } from "../fixtures/makeChart.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const HITS = { max: 500, n300: 50, n200: 10, n100: 1, n50: 0, miss: 2 };
const play = (extra = {}) => ({ id: "live:stable:x:1", source: "live", client: "stable", md5: A, rate: 1.1, hits: HITS, outcome: "pass", at: 1_790_000_000_000, title: "Song", ...extra });
const tempDir = () => mkdtemp(path.join(tmpdir(), "local-profile-"));

test("normalizePlay keeps only a well-formed play; mapSummary keeps the dans and the shares", () => {
    const p = normalizePlay(play({ md5: A.toUpperCase(), mods: ["DT", "bad mod", 3] }));
    assert.equal(p.md5, A);
    assert.equal(p.mapKey, `${A}@1.10`);
    assert.deepEqual(p.mods, ["DT"]);
    assert.equal(normalizePlay(play({ md5: "zz" })), null);
    assert.equal(normalizePlay(play({ rate: 9 })), null);
    assert.equal(normalizePlay(play({ id: "" })), null);
    assert.equal(normalizePlay(play({ outcome: "weird" })).outcome, "pass");
    const s = mapSummary({ kind: "ok", numeric: 13.4, label: "Gamma mid/high", calcs: { mixed: 13.2, daniel: null }, top3: [{ name: "Stream", share: 0.7 }],
        tech: true, durationSec: 150, msd: { stream: 25 }, rate: 1.1, extra: "dropped" });
    assert.deepEqual(s, { kind: "ok", numeric: 13.4, label: "Gamma mid/high", calcs: { mixed: 13.2 }, msd: { stream: 25 }, top3: [{ name: "Stream", share: 0.7 }], tech: true, primary: null, durationSec: 150 });
    assert.deepEqual(mapSummary({ kind: "not-rice", reason: "ln" }), { kind: "not-rice" });
    assert.equal(mapSummary(null), null);
    assert.equal(mapKeyOf(A, 1), `${A}@1.00`);
});

test("plays are appended, kept once (same id, or same map, rate and judgements), and read back after a restart", async () => {
    const dir = await tempDir();
    const store = createLocalProfileStore({ dir });
    assert.equal((await store.addPlay(play())).added, true);
    assert.equal((await store.addPlay(play())).added, false, "same id");
    assert.equal((await store.addPlay(play({ id: "stable:replay" }))).added, false, "the scores.db copy of a recorded play");
    assert.equal((await store.addPlay(play({ id: "stable:other", hits: { ...HITS, miss: 3 } }))).added, true);
    assert.equal((await store.addPlay({ id: "x" })).added, false);
    await store.setMap(`${A}@1.10`, { kind: "ok", numeric: 13, top3: [] });
    // a half-written last line (the app closed while writing) is skipped
    await appendFile(path.join(dir, "plays.jsonl"), '{"id":"cut', "utf8");
    const again = createLocalProfileStore({ dir });
    assert.equal((await again.plays()).length, 2);
    assert.equal((await again.map(`${A}@1.10`)).numeric, 13);
    assert.equal(await again.has(play({ id: "anything" })), true);
});

test("export, import into another profile (merged), reset", async () => {
    const one = createLocalProfileStore({ dir: await tempDir() });
    await one.addPlay(play());
    await one.addPlay(play({ id: "p2", md5: B, at: 1_780_000_000_000 }));
    await one.setMap(`${B}@1.10`, { kind: "not-rice" });
    await one.updateSettings((s) => ({ ...s, record: false }));
    const bundle = await one.exportBundle();
    assert.equal(bundle.format, BUNDLE_FORMAT);
    assert.equal(bundle.plays.length, 2);
    assert.equal(bundle.settings.record, false);

    const two = createLocalProfileStore({ dir: await tempDir() });
    await two.addPlay(play());
    const r = await two.importBundle(JSON.parse(JSON.stringify(bundle)));
    assert.deepEqual(r, { ok: true, added: 1, skipped: 1 });
    assert.deepEqual((await two.plays()).map((p) => p.id), ["p2", "live:stable:x:1"], "sorted by time");
    assert.deepEqual(await two.map(`${B}@1.10`), { kind: "not-rice" });
    assert.deepEqual(await two.importBundle({ plays: [] }), { ok: false, added: 0, skipped: 0 });

    await one.reset();
    assert.equal((await one.plays()).length, 0);
    assert.equal(await one.map(`${B}@1.10`), null);
    assert.equal((await one.settings()).record, false, "the record switch stays");
});

test("Songs index: only 4K mania charts, by the md5 of their bytes; unchanged folders are not read again", async () => {
    const root = await tempDir();
    const songs = path.join(root, "Songs");
    const four = makeChart({ kind: "stream" }).replace("Version:", "BeatmapID:777\r\nBeatmapSetID:55\r\nVersion:");
    const seven = makeChart({ keys: 7 });
    await mkdir(path.join(songs, "55 Test - Song"), { recursive: true });
    await writeFile(path.join(songs, "55 Test - Song", "a.osu"), four, "utf8");
    await writeFile(path.join(songs, "55 Test - Song", "b.osu"), seven, "utf8");
    await writeFile(path.join(songs, "55 Test - Song", "audio.mp3"), "not audio");
    const md5 = createHash("md5").update(Buffer.from(four, "utf8")).digest("hex");
    assert.equal(chartEntry(Buffer.from(seven)), null);

    let reads = 0;
    const counting = { ...fs, readFile: (...a) => { reads += 1; return fs.readFile(...a); } };
    const index = createSongsMd5Index({ indexFile: path.join(root, "index.json"), fs: counting });
    const first = await index.scan(songs);
    assert.deepEqual([...first.charts.keys()], [md5]);
    assert.deepEqual(first.charts.get(md5), { path: path.join(songs, "55 Test - Song", "a.osu"), beatmapId: 777, beatmapsetId: 55, artist: "Test", title: "Synthetic stream", version: "stream 180" });
    const readsAfterFirst = reads;
    // a new index object over the saved file: nothing is read again
    const second = await createSongsMd5Index({ indexFile: path.join(root, "index.json"), fs: counting }).scan(songs);
    assert.equal(second.charts.size, 1);
    assert.equal(reads - readsAfterFirst, 1, "only the saved index itself");
    // a folder that changed is read again
    await mkdir(path.join(songs, "56 Other"), { recursive: true });
    await writeFile(path.join(songs, "56 Other", "c.osu"), makeChart({ kind: "jack" }), "utf8");
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(songs, "56 Other"), later, later);
    const third = await index.scan(songs);
    assert.equal(third.charts.size, 2);
    // a stopped scan keeps what it read and says so
    const stopped = await createSongsMd5Index({ indexFile: path.join(root, "other.json") }).scan(songs, { isCancelled: () => true });
    assert.equal(stopped.cancelled, true);
    assert.equal(JSON.parse(await readFile(path.join(root, "other.json"), "utf8")).v, 1);
});
