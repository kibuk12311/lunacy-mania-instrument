import test from "node:test";
import assert from "node:assert/strict";
import { uleb128, osuString, encodeCollectionDb, decodeCollectionDb, COLLECTION_DB_VERSION } from "../../src/recommend/collectionDb.js";

const bytes = (buf) => [...buf];
const md5 = (n) => n.toString(16).padStart(32, "0");

test("ULEB128 lengths", () => {
    assert.deepEqual(bytes(uleb128(0)), [0x00]);
    assert.deepEqual(bytes(uleb128(127)), [0x7f]);
    assert.deepEqual(bytes(uleb128(128)), [0x80, 0x01]);
    assert.deepEqual(bytes(uleb128(300)), [0xac, 0x02]);
    assert.deepEqual(bytes(uleb128(16384)), [0x80, 0x80, 0x01]);
});

test("osu! strings: 0x0b, the byte length, UTF-8; an empty one is a single 0x00", () => {
    assert.deepEqual(bytes(osuString("")), [0x00]);
    assert.deepEqual(bytes(osuString(null)), [0x00]);
    assert.deepEqual(bytes(osuString("ab")), [0x0b, 0x02, 0x61, 0x62]);
    // Cyrillic: two bytes a letter, so the length counts bytes, not letters
    const ru = osuString("Мира");
    assert.deepEqual(bytes(ru.subarray(0, 2)), [0x0b, 0x08]);
    assert.equal(ru.subarray(2).toString("utf8"), "Мира");
    const long = osuString("x".repeat(200));
    assert.deepEqual(bytes(long.subarray(0, 3)), [0x0b, 0xc8, 0x01]);
    assert.equal(long.length, 203);
});

test("the file layout: version, collection count, then each name, count and hashes", () => {
    const buf = encodeCollectionDb({ collections: [{ name: "A", hashes: [md5(1)] }] });
    assert.equal(buf.readInt32LE(0), 20150203);
    assert.equal(COLLECTION_DB_VERSION, 20150203);
    assert.equal(buf.readInt32LE(4), 1);
    assert.deepEqual(bytes(buf.subarray(8, 11)), [0x0b, 0x01, 0x41]);
    assert.equal(buf.readInt32LE(11), 1);
    assert.deepEqual(bytes(buf.subarray(15, 17)), [0x0b, 32]);
    assert.equal(buf.subarray(17).toString("latin1"), md5(1));
    assert.equal(buf.length, 17 + 32);
});

test("encode → decode gives the same collections back, Cyrillic names included", () => {
    const collections = [
        { name: "Lunacy mania picks", hashes: [md5(1), md5(2), md5(3)] },
        { name: "Подбор — джампстрим", hashes: [] },
        { name: "", hashes: [md5(0xabcdef)] },
    ];
    const back = decodeCollectionDb(encodeCollectionDb({ version: 20150203, collections }));
    assert.deepEqual(back, { version: 20150203, collections });
    // 300 hashes: still one Int32 count each
    const many = Array.from({ length: 300 }, (_, i) => md5(i));
    assert.deepEqual(decodeCollectionDb(encodeCollectionDb({ collections: [{ name: "x", hashes: many }] })).collections[0].hashes, many);
});

test("a cut or garbled file is refused", () => {
    const good = encodeCollectionDb({ collections: [{ name: "A", hashes: [md5(1)] }] });
    assert.throws(() => decodeCollectionDb(good.subarray(0, good.length - 5)));
    assert.throws(() => decodeCollectionDb(Buffer.from([1, 2, 3])));
    const badMarker = Buffer.from(good);
    badMarker[8] = 0x07;
    assert.throws(() => decodeCollectionDb(badMarker));
});
