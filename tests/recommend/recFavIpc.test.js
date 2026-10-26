import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFavHandlers, collectionName, collectionsDir } from "../../app/recFavIpc.js";
import { createRecStore } from "../../app/recStore.js";
import { decodeCollectionDb } from "../../src/recommend/collectionDb.js";
import { setLang } from "../../src/i18n/i18n.js";

const dirFor = () => mkdtemp(path.join(tmpdir(), "избранное-"));
const card = (id, extra = {}) => ({ beatmapId: id, beatmapsetId: id + 1000, artist: "A", title: `Song ${id}`, version: "[4K] X", creator: "C", dan: 13, bpm: 200, lengthSec: 120, ...extra });
const osu = (id) => Buffer.from(`osu file format v14\n[Metadata]\nBeatmapID:${id}\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n`, "utf8");
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

// A real store in a temp folder; fetchBytes answers per beatmap id (a Buffer, or an Error to throw).
async function setup({ answers = {}, cards = {}, ...rest } = {}) {
    const userData = await dirFor();
    const docs = await dirFor();
    const store = createRecStore({ dir: userData });
    const seen = { fetched: [], progress: [], added: [], exported: [], log: [], inFlight: 0, maxInFlight: 0 };
    const handlers = createFavHandlers({
        store,
        docsDir: () => docs,
        fetchBytes: async (url) => {
            seen.fetched.push(url);
            seen.inFlight += 1;
            seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
            await new Promise((r) => setTimeout(r, 5));
            seen.inFlight -= 1;
            const id = Number(url.split("/").pop());
            const answer = answers[id] ?? osu(id);
            if (answer instanceof Error) throw answer;
            return answer;
        },
        progress: (event) => seen.progress.push(event),
        log: (line) => seen.log.push(line),
        cardFor: (id) => cards[id] ?? null,
        onAdded: (c) => seen.added.push(c.beatmapId),
        onExported: (file) => seen.exported.push(file),
        ...rest,
    });
    return { handlers, store, seen, userData, docs };
}

test("list, add and remove; the card main handed out wins over the window's copy", async () => {
    const { handlers, seen } = await setup({ cards: { 2: card(2, { title: "From main" }) } });
    assert.deepEqual(await handlers.list(), { ok: true, items: [] });
    assert.equal((await handlers.add({ card: card(1) })).items.length, 1);
    const r = await handlers.add({ card: card(2, { title: "From the window", md5: "e".repeat(32) }) });
    assert.deepEqual(r.items.map((f) => [f.beatmapId, f.title, f.md5 ?? null]), [[2, "From main", null], [1, "Song 1", null]]);
    assert.deepEqual(seen.added, [1, 2]);
    assert.deepEqual((await handlers.remove({ beatmapId: 1 })).items.map((f) => f.beatmapId), [2]);
    for (const bad of [null, {}, { card: null }, { card: card(-1) }, { card: { ...card(3), beatmapsetId: "x" } }]) {
        assert.equal((await handlers.add(bad)).ok, false, JSON.stringify(bad));
    }
    for (const bad of [null, { beatmapId: 0 }, { beatmapId: "../x" }]) assert.equal((await handlers.remove(bad)).ok, false);
    assert.equal((await handlers.list()).items.length, 1);
});

test("export: fetches the .osu files without an md5 (3 at a time), skips the unavailable, writes коллекции/collection.db", async () => {
    const { handlers, store, seen, docs, userData } = await setup({
        answers: { 3: new Error("не удалось скачать .osu карты"), 4: Buffer.from("<html>not found</html>") },
    });
    for (let id = 1; id <= 7; id++) await store.favourites.add(card(id));
    const r = await handlers.exportDb({ name: "  Мои карты  " });
    const file = path.join(docs, "коллекции", "collection.db");
    assert.deepEqual(r, { ok: true, file, count: 5, skipped: 2 });
    assert.deepEqual(seen.exported, [file]);
    assert.ok(seen.maxInFlight <= 3 && seen.maxInFlight >= 2, String(seen.maxInFlight));
    assert.deepEqual(seen.fetched.map((u) => u.replace(/\d+$/, "")), Array(7).fill("https://osu.ppy.sh/osu/"));
    // progress up to the total
    assert.deepEqual(seen.progress.at(0), { done: 0, total: 7 });
    assert.deepEqual(seen.progress.at(-1), { done: 7, total: 7 });

    const db = decodeCollectionDb(await readFile(file));
    assert.equal(db.version, 20150203);
    assert.equal(db.collections.length, 1);
    assert.equal(db.collections[0].name, "Мои карты");
    assert.deepEqual(new Set(db.collections[0].hashes), new Set([1, 2, 5, 6, 7].map((id) => md5(osu(id)))));
    // only the collection lands in the documents folder; nothing else is written anywhere
    assert.deepEqual(await readdir(docs), ["коллекции"]);
    assert.deepEqual(await readdir(path.join(docs, "коллекции")), ["collection.db"]);
    assert.deepEqual((await readdir(userData)).sort(), ["favourites.json"]);

    // the md5s are kept: the next export only asks for the two that failed
    seen.fetched.length = 0;
    const again = await handlers.exportDb({ name: "" });
    assert.equal(again.count, 5);
    assert.deepEqual(seen.fetched.sort(), ["https://osu.ppy.sh/osu/3", "https://osu.ppy.sh/osu/4"]);
    assert.equal(decodeCollectionDb(await readFile(file)).collections[0].name, "Lunacy mania picks");
});

test("export with nothing to export says so and writes nothing", async () => {
    const empty = await setup();
    const r = await empty.handlers.exportDb({ name: "x" });
    assert.equal(r.ok, false);
    assert.match(r.message, /избранно/i);
    assert.deepEqual(await readdir(empty.docs), []);

    const broken = await setup({ answers: { 1: new Error("нет сети") } });
    await broken.store.favourites.add(card(1));
    const none = await broken.handlers.exportDb({});
    assert.equal(none.ok, false);
    assert.deepEqual(await readdir(broken.docs), []);
});

test("two exports at once share one run", async () => {
    const { handlers, store, seen } = await setup();
    await store.favourites.add(card(1));
    const [a, b] = await Promise.all([handlers.exportDb({ name: "a" }), handlers.exportDb({ name: "b" })]);
    assert.deepEqual(a, b);
    assert.equal(seen.fetched.length, 1);
});

test("collection names: trimmed, at most 64, no control characters; the default otherwise", () => {
    assert.equal(collectionName("  TestPlayer  "), "TestPlayer");
    assert.equal(collectionName("x".repeat(80)).length, 64);
    assert.equal(collectionName("a\u0000b\nc"), "abc");
    for (const empty of ["", "   ", null, 42, {}]) assert.equal(collectionName(empty), "Lunacy mania picks");
    assert.equal(collectionsDir("C:/Docs/App"), path.join("C:/Docs/App", "коллекции"));
});

test("a store that fails gives a message, never an exception", async () => {
    const boom = async () => { throw new Error("disk"); };
    const store = { favourites: { list: boom, add: boom, remove: boom, setMd5: boom } };
    const handlers = createFavHandlers({ store, docsDir: () => "C:/nowhere", fetchBytes: boom });
    assert.deepEqual(await handlers.list(), { ok: false, message: "disk" });
    assert.deepEqual(await handlers.add({ card: card(1) }), { ok: false, message: "disk" });
    assert.deepEqual(await handlers.remove({ beatmapId: 1 }), { ok: false, message: "disk" });
    assert.deepEqual(await handlers.exportDb({}), { ok: false, message: "disk" });
});

test("in English the export's refusals are English", async () => {
    const empty = await setup();
    setLang("en");
    try {
        assert.equal((await empty.handlers.exportDb({})).message, "your favourites are empty — add maps with ☆ first");
        assert.equal((await empty.handlers.add({ card: card(-1) })).message, "no data about this map");
    } finally {
        setLang("ru");
    }
});
