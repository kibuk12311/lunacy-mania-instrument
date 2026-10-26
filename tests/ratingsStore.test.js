// The ratings store (app/ratingsStore.js, addendum §2.7): the cap of 2000 keeps the newest, bad entries are dropped,
// one entry per variant id, the critic's feature names are kept once, the last fitted model is kept, and the export
// writes a new file every time and never over an old one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRatingsStore, normalizeRatings, MAX_RATINGS } from "../app/ratingsStore.js";

const NAMES = ["a", "b", "c"];
const entry = (id, at, over = {}) => ({
    id, at, vote: 1, tags: [], version: "Gamma mid Jumpstream", range: { lo: 12.5, hi: 13.5 }, families: ["Jumpstream"],
    modelKind: "learned", criticKind: "heuristic", features: [1, 2, 3], names: NAMES, audioKey: "0123456789ab", ...over,
});
const tempStore = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ratings-store-"));
    return { dir, file: path.join(dir, "ratings.json"), store: createRatingsStore({ file: path.join(dir, "ratings.json") }) };
};

test("normalize: bad entries are dropped, one per id (the newest), oldest first, unused name sets dropped", () => {
    const raw = {
        v: 1,
        nameSets: [["x"], NAMES],
        entries: [
            { ...entry("a", 5), names: 1 },
            { ...entry("b", 3), names: 1, vote: 2 }, // a vote that is not one
            { ...entry("c", 4), names: 1, tags: ["nope"] },
            { ...entry("d", 2), names: 1, tags: ["fun", "human", "comfy", "boring", "awkward"] },
            { ...entry("e", 1), names: 1, id: "" },
            { ...entry("a", 9), names: 1, vote: -1 }, // the same variant rated again later
            { ...entry("f", 7), names: 1, features: [1, 2] }, // features that do not match their names: kept without them
            { ...entry("g", 8), names: 1, audioKey: "C:/songs/song.mp3" },
            "junk",
        ],
        model: { v: 1, w: [1], names: ["a"] },
    };
    const out = normalizeRatings(raw);
    assert.deepEqual(out.entries.map((e) => [e.id, e.at, e.vote]), [["f", 7, 1], ["g", 8, 1], ["a", 9, -1]]);
    assert.deepEqual(out.nameSets, [NAMES], "the set nobody uses is gone, the other renumbered");
    assert.equal(out.entries[2].names, 0);
    assert.deepEqual(out.entries[0].features, [], "a wrong length keeps the vote, not the features");
    assert.equal(out.entries[0].names, -1);
    assert.equal(out.entries[1].audioKey, "", "only a short hash is kept, never a path");
    assert.deepEqual(out.model, raw.model);
    assert.deepEqual(normalizeRatings(null), { v: 1, nameSets: [], entries: [], model: null });
});

test("the cap of 2000 keeps the newest", async () => {
    const { store, file } = await tempStore();
    const many = Array.from({ length: MAX_RATINGS + 5 }, (_, i) => ({ ...entry(`id-${i}`, 1000 + i), names: 0 }));
    // written as a file of 2005 entries, read back through normalize
    await writeFile(file, JSON.stringify({ v: 1, nameSets: [NAMES], entries: many, model: null }), "utf8");
    const reread = createRatingsStore({ file });
    const kept = await reread.entries();
    assert.equal(kept.length, MAX_RATINGS);
    assert.equal(kept[0].id, "id-5", "the 5 oldest went");
    assert.equal(kept.at(-1).id, `id-${MAX_RATINGS + 4}`);
    // one more through put: still 2000, the oldest goes
    assert.equal(await reread.put(entry("newest", 99_999)), MAX_RATINGS);
    const after = await reread.entries();
    assert.equal(after[0].id, "id-6");
    assert.equal(after.at(-1).id, "newest");
    assert.ok(store);
});

test("put and remove by id; names kept once and shared on reading; the model is kept", async () => {
    const { store, file } = await tempStore();
    assert.equal(await store.put(entry("a", 1)), 1);
    assert.equal(await store.put(entry("b", 2, { vote: -1, tags: ["tooJacky"] })), 2);
    assert.equal(await store.put(entry("a", 3, { vote: -1 })), 2, "rating the same variant again replaces its entry");
    assert.equal(await store.put(entry("c", 4, { features: [], names: [] })), 3, "a variant without a critic is kept without features");
    const disk = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(disk.nameSets, [NAMES], "the names are on disk once");
    assert.deepEqual(disk.entries.map((e) => e.names), [0, 0, -1]);
    const list = await store.entries();
    assert.deepEqual(list.map((e) => [e.id, e.vote]), [["b", -1], ["a", -1], ["c", 1]]);
    assert.equal(list[0].names, list[1].names, "one shared array per name set");
    assert.deepEqual(list[2].names, []);
    assert.deepEqual(await store.summary(), { n: 3, up: 1, down: 2 });
    assert.equal((await store.find("b")).tags[0], "tooJacky");
    assert.equal(await store.find("zzz"), null);
    assert.equal(await store.remove("b"), 2);
    await store.setModel({ v: 1, w: [0.5], names: ["a"], active: true });
    const again = createRatingsStore({ file });
    assert.deepEqual((await again.model()).w, [0.5]);
    assert.equal((await again.entries()).length, 2);
});

test("the export writes a new file each time and never over one that is there; nothing to export: no file", async () => {
    const { store, dir } = await tempStore();
    const docs = path.join(dir, "docs");
    assert.equal(await store.exportTo(docs), null);
    await store.put(entry("a", 1));
    const now = new Date(2026, 9, 26, 12).getTime();
    // a file of that name is already there: it stays as it was
    const { mkdir } = await import("node:fs/promises");
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(docs, "lunacy-ratings-2026-10-26.json"), "mine", "utf8");
    const first = await store.exportTo(docs, { now, app: "0.8.0" });
    const second = await store.exportTo(docs, { now, app: "0.8.0" });
    assert.equal(path.basename(first), "lunacy-ratings-2026-10-26-2.json");
    assert.equal(path.basename(second), "lunacy-ratings-2026-10-26-3.json");
    assert.equal(await readFile(path.join(docs, "lunacy-ratings-2026-10-26.json"), "utf8"), "mine");
    const body = JSON.parse(await readFile(first, "utf8"));
    assert.equal(body.kind, "lunacy-ratings");
    assert.equal(body.app, "0.8.0");
    assert.equal(body.n, 1);
    assert.deepEqual(body.nameSets, [NAMES]);
    assert.equal(body.entries[0].vote, 1);
    assert.deepEqual((await readdir(docs)).sort(), ["lunacy-ratings-2026-10-26-2.json", "lunacy-ratings-2026-10-26-3.json", "lunacy-ratings-2026-10-26.json"]);
});
