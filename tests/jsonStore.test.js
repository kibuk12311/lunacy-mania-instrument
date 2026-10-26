import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJsonStore } from "../app/jsonStore.js";

const dirFor = () => mkdtemp(path.join(tmpdir(), "store-"));
const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === "number") : []);

test("no file yet: the normalized fallback", async () => {
    const store = createJsonStore({ file: path.join(await dirFor(), "a.json"), normalize: list, fallback: [] });
    assert.deepEqual(await store.get(), []);
});

test("broken JSON: the normalized fallback", async () => {
    const dir = await dirFor();
    const file = path.join(dir, "a.json");
    await writeFile(file, "{ not json", "utf8");
    const store = createJsonStore({ file, normalize: list, fallback: [1] });
    assert.deepEqual(await store.get(), [1]);
});

test("the file is read once, later reads come from memory", async () => {
    const dir = await dirFor();
    const file = path.join(dir, "a.json");
    await writeFile(file, "[1, 2]", "utf8");
    let reads = 0;
    const fs = { ...(await import("node:fs/promises")), readFile: async (...args) => { reads += 1; return (await import("node:fs/promises")).readFile(...args); } };
    const store = createJsonStore({ file, normalize: list, fallback: [], fs });
    assert.deepEqual(await store.get(), [1, 2]);
    assert.deepEqual(await store.get(), [1, 2]);
    assert.equal(reads, 1);
});

test("set goes through normalize and reaches the disk", async () => {
    const dir = await dirFor();
    const file = path.join(dir, "a.json");
    const store = createJsonStore({ file, normalize: list, fallback: [] });
    assert.deepEqual(await store.set([1, "x", 2]), [1, 2]);
    assert.deepEqual(await store.get(), [1, 2]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [1, 2]);
    // a fresh store over the same file reads what was written
    assert.deepEqual(await createJsonStore({ file, normalize: list, fallback: [] }).get(), [1, 2]);
});

test("what get hands out can be changed without touching the store", async () => {
    const store = createJsonStore({ file: path.join(await dirFor(), "a.json"), normalize: list, fallback: [] });
    await store.set([1]);
    (await store.get()).push(5);
    assert.deepEqual(await store.get(), [1]);
});

test("two updates at once keep both writes", async () => {
    const dir = await dirFor();
    const file = path.join(dir, "a.json");
    const store = createJsonStore({ file, normalize: list, fallback: [] });
    await Promise.all([store.update((xs) => [...xs, 1]), store.update((xs) => [...xs, 2]), store.set([7]).then(() => store.update((xs) => [...xs, 3]))]);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved, await store.get());
    assert.ok(saved.includes(3) && saved.includes(7), JSON.stringify(saved));
    const again = createJsonStore({ file, normalize: list, fallback: [] });
    await Promise.all([again.update((xs) => [...xs, 10]), again.update((xs) => [...xs, 11])]);
    assert.deepEqual((await again.get()).slice(-2), [10, 11]);
});

test("no .tmp file is left after a set", async () => {
    const dir = await dirFor();
    const store = createJsonStore({ file: path.join(dir, "a.json"), fallback: {} });
    await store.set({ a: 1 });
    await store.set({ a: 2 });
    assert.deepEqual(await readdir(dir), ["a.json"]);
});

test("a Cyrillic folder in the path works, and missing folders are made", async () => {
    const dir = await dirFor();
    const file = path.join(dir, "Мира", "профиль", "profile.json");
    const store = createJsonStore({ file, fallback: null });
    assert.equal(await store.get(), null);
    await store.set({ name: "Мира" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { name: "Мира" });
    await mkdir(path.join(dir, "Мира2"), { recursive: true });
    await writeFile(path.join(dir, "Мира2", "x.json"), "{\"a\":3}", "utf8");
    assert.deepEqual(await createJsonStore({ file: path.join(dir, "Мира2", "x.json") }).get(), { a: 3 });
});

test("a normalize that throws on the saved content falls back", async () => {
    const dir = await dirFor();
    const file = path.join(dir, "a.json");
    await writeFile(file, "\"bad\"", "utf8");
    const normalize = (x) => {
        if (x === "bad") throw new Error("bad");
        return x;
    };
    assert.deepEqual(await createJsonStore({ file, normalize, fallback: { ok: 1 } }).get(), { ok: 1 });
});
