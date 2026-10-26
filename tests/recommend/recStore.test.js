import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecStore } from "../../app/recStore.js";

const dirFor = () => mkdtemp(path.join(tmpdir(), "подбор-"));
const card = (id) => ({ beatmapId: id, beatmapsetId: id + 1000, artist: "A", title: `Song ${id}`, version: "[4K] X", creator: "C", dan: 13, bpm: 200, lengthSec: 120 });

test("favourites: add, list, remove and md5s go to favourites.json", async () => {
    const dir = await dirFor();
    let now = 100;
    const store = createRecStore({ dir, now: () => now });
    assert.deepEqual(await store.favourites.list(), []);
    await store.favourites.add(card(1));
    now = 200;
    const items = await store.favourites.add(card(2));
    assert.deepEqual(items.map((f) => [f.beatmapId, f.addedAt]), [[2, 200], [1, 100]]);
    await store.favourites.setMd5(new Map([[1, "f".repeat(32)]]));
    assert.deepEqual((await store.favourites.remove(2)).map((f) => f.beatmapId), [1]);
    const onDisk = JSON.parse(await readFile(path.join(dir, "favourites.json"), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.deepEqual(onDisk.items.map((f) => [f.beatmapId, f.md5]), [[1, "f".repeat(32)]]);
    // a new store over the same folder (the next start) reads it back
    assert.deepEqual((await createRecStore({ dir }).favourites.list()).map((f) => f.beatmapId), [1]);
});

test("the picks journal goes to picks.json, the first time a map was picked wins", async () => {
    const dir = await dirFor();
    const store = createRecStore({ dir });
    await store.picks.add({ ...card(5), how: "download", at: 10 });
    await store.picks.add({ ...card(5), how: "fav", at: 20 });
    assert.deepEqual((await store.picks.list()).map((p) => [p.beatmapId, p.how, p.at]), [[5, "download", 10]]);
    const onDisk = JSON.parse(await readFile(path.join(dir, "picks.json"), "utf8"));
    assert.equal(onDisk.items.length, 1);
});

test("writes happen one after another: none is lost when they come at once", async () => {
    const dir = await dirFor();
    const store = createRecStore({ dir });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.favourites.add(card(i + 1))));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.picks.add({ ...card(i + 1), how: "direct", at: i + 1 })));
    assert.equal((await store.favourites.list()).length, 20);
    assert.equal((await createRecStore({ dir }).favourites.list()).length, 20);
    assert.equal((await createRecStore({ dir }).picks.list()).length, 20);
    assert.deepEqual((await readdir(dir)).sort(), ["favourites.json", "picks.json"]);
});

test("a broken file reads as empty and the next write repairs it", async () => {
    const dir = await dirFor();
    await writeFile(path.join(dir, "favourites.json"), "{ not json", "utf8");
    await writeFile(path.join(dir, "picks.json"), JSON.stringify({ items: [{ junk: 1 }, { ...card(3), how: "fav", at: 5 }] }), "utf8");
    const store = createRecStore({ dir });
    assert.deepEqual(await store.favourites.list(), []);
    assert.deepEqual((await store.picks.list()).map((p) => p.beatmapId), [3]);
    await store.favourites.add(card(9));
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "favourites.json"), "utf8")).items.map((f) => f.beatmapId), [9]);
});

test("making the store touches no file", async () => {
    let touched = 0;
    const fs = new Proxy({}, { get: () => () => { touched += 1; throw new Error("no"); } });
    createRecStore({ dir: "C:/nowhere", fs });
    assert.equal(touched, 0);
});
