import test from "node:test";
import assert from "node:assert/strict";
import {
    cleanFavourite, parseFavourites, addFavourite, removeFavourite, withMd5, cleanPick, parsePicks, addPick,
    MAX_FAVOURITES, MAX_PICKS,
} from "../../src/recommend/favourites.js";

const SEED = {
    primaryPattern: "jumpstream", msdAll: { Jumpstream: 29.35 }, patternsAll: { jumpstream: 1 }, bpm: 262.5, lengthSec: 188, dan: 12.98,
};
const CARD = {
    beatmapId: 2701197, beatmapsetId: 1302447, artist: "Jeff Williams", title: "Time to Say Goodbye", version: "[4K] Farewell 1.05x",
    creator: "Halogen-", dan: 12.98, danLabel: "Gamma mid", bpm: 262.5, lengthSec: 188,
    cover: "https://assets.ppy.sh/beatmaps/1302447/covers/list.jpg", seed: SEED,
    // card fields a favourite does not keep
    score: 0.7, playCount: 18901, delta: 0.48, played: null,
};
const fav = (id, extra = {}) => ({ ...CARD, beatmapId: id, beatmapsetId: id + 1, ...extra });

test("a favourite keeps the card's known fields only", () => {
    const f = cleanFavourite({ ...CARD, addedAt: 5, md5: "0123456789abcdef0123456789abcdef" });
    assert.deepEqual(f, {
        beatmapId: 2701197, beatmapsetId: 1302447, artist: "Jeff Williams", title: "Time to Say Goodbye", version: "[4K] Farewell 1.05x",
        creator: "Halogen-", dan: 12.98, danLabel: "Gamma mid", bpm: 262.5, lengthSec: 188,
        cover: "https://assets.ppy.sh/beatmaps/1302447/covers/list.jpg", seed: SEED, addedAt: 5, md5: "0123456789abcdef0123456789abcdef",
    });
});

test("bad ids are refused; bad fields fall back", () => {
    for (const beatmapId of [0, -1, 1.5, "12", null, 2 ** 60]) assert.equal(cleanFavourite({ ...CARD, beatmapId }), null, String(beatmapId));
    assert.equal(cleanFavourite({ ...CARD, beatmapsetId: "x" }), null);
    assert.equal(cleanFavourite(null), null);
    const f = cleanFavourite({
        ...CARD, artist: 5, title: "t".repeat(500), dan: NaN, danLabel: 7, bpm: -1, lengthSec: "x",
        cover: "https://evil.example/x.jpg", seed: { ...SEED, primaryPattern: "nope" }, md5: "NOT-A-HASH", addedAt: "yesterday",
    });
    assert.equal(f.artist, "");
    assert.equal(f.title.length, 200);
    assert.equal(f.dan, null);
    assert.equal(f.danLabel, "");
    assert.equal(f.bpm, null);
    assert.equal(f.lengthSec, null);
    assert.equal(f.cover, null);
    assert.equal(f.seed, null);
    assert.equal(f.addedAt, null);
    assert.ok(!("md5" in f));
    // a dan without a label gets ours
    assert.equal(cleanFavourite({ ...CARD, danLabel: undefined }).danLabel, "Gamma mid");
});

test("the favourites file: broken JSON or a wrong shape is an empty list", () => {
    assert.deepEqual(parseFavourites("{oops"), { version: 1, items: [] });
    assert.deepEqual(parseFavourites(null), { version: 1, items: [] });
    assert.deepEqual(parseFavourites({ items: "x" }), { version: 1, items: [] });
    assert.deepEqual(parseFavourites([1, 2]), { version: 1, items: [] });
    const doc = parseFavourites(JSON.stringify({ version: 1, items: [fav(1), { junk: true }, fav(2), fav(1, { title: "again" })] }));
    assert.deepEqual(doc.items.map((f) => f.beatmapId), [1, 2]);
    assert.equal(doc.items[0].title, "Time to Say Goodbye");
});

test("adding: new ones on top, no repeats, at most 500 (the oldest go)", () => {
    let doc = parseFavourites(null);
    doc = addFavourite(doc, fav(1), 100);
    doc = addFavourite(doc, fav(2), 200);
    assert.deepEqual(doc.items.map((f) => [f.beatmapId, f.addedAt]), [[2, 200], [1, 100]]);
    // a repeat changes nothing: its place, md5 and time stay
    doc = withMd5(doc, new Map([[1, "a".repeat(32)]]));
    doc = addFavourite(doc, fav(1, { title: "other" }), 300);
    assert.deepEqual(doc.items.map((f) => [f.beatmapId, f.addedAt, f.md5 ?? null]), [[2, 200, null], [1, 100, "a".repeat(32)]]);
    assert.equal(doc.items[1].title, "Time to Say Goodbye");
    // a bad card is not added
    assert.equal(addFavourite(doc, { beatmapId: -1 }, 400).items.length, 2);

    for (let i = 10; i < 10 + MAX_FAVOURITES; i++) doc = addFavourite(doc, fav(i), i);
    assert.equal(MAX_FAVOURITES, 500);
    assert.equal(doc.items.length, 500);
    assert.equal(doc.items[0].beatmapId, 509);
    assert.ok(!doc.items.some((f) => f.beatmapId === 1 || f.beatmapId === 2));
    assert.equal(parseFavourites({ items: [...doc.items, fav(9999)] }).items.length, 500);
});

test("removing and storing md5s", () => {
    let doc = { version: 1, items: [cleanFavourite(fav(1)), cleanFavourite(fav(2))] };
    doc = withMd5(doc, new Map([[2, "b".repeat(32)], [3, "c".repeat(32)], [1, "bad"]]));
    assert.equal(doc.items[1].md5, "b".repeat(32));
    assert.ok(!("md5" in doc.items[0]));
    doc = removeFavourite(doc, 1);
    assert.deepEqual(doc.items.map((f) => f.beatmapId), [2]);
    assert.deepEqual(removeFavourite(doc, 42).items.map((f) => f.beatmapId), [2]);
});

test("the picks journal: the first time a map was picked wins, at most 1000", () => {
    const pick = (id, at, how = "download") => ({ ...CARD, beatmapId: id, beatmapsetId: id + 1, how, at });
    assert.deepEqual(cleanPick(pick(1, 50, "fav")), {
        beatmapId: 1, beatmapsetId: 2, artist: "Jeff Williams", title: "Time to Say Goodbye", version: "[4K] Farewell 1.05x",
        dan: 12.98, danLabel: "Gamma mid", how: "fav", at: 50,
    });
    assert.equal(cleanPick(pick(1, 50, "site")), null);
    assert.equal(cleanPick(pick(1, NaN)), null);
    assert.equal(cleanPick(pick(0, 50)), null);

    let doc = parsePicks("not json");
    assert.deepEqual(doc, { version: 1, items: [] });
    doc = addPick(doc, pick(1, 100, "fav"));
    doc = addPick(doc, pick(2, 200));
    doc = addPick(doc, pick(1, 300, "download"));
    assert.deepEqual(doc.items.map((p) => [p.beatmapId, p.at, p.how]), [[2, 200, "download"], [1, 100, "fav"]]);
    for (let i = 10; i < 10 + MAX_PICKS; i++) doc = addPick(doc, pick(i, 1000 + i));
    assert.equal(doc.items.length, MAX_PICKS);
    assert.equal(doc.items.at(-1).beatmapId, 10);
    assert.deepEqual(parsePicks({ items: [pick(5, 1), pick(5, 2), { how: "x" }] }).items.map((p) => p.at), [1]);
});
