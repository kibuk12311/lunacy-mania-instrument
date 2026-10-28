// shared/osz.js: stored entries (the app's own src/gen/osz.js writer) and deflated ones (node:zlib), UTF-8 names,
// a directory offset shifted by bytes in front, damaged zips, the size cap, entry lookup by an .osu's name.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildOsz } from "../../../src/gen/osz.js";
import { ZipError, entryKey, findEntry, readZip } from "../../../extension/shared/osz.js";
import { makeChart } from "../../fixtures/makeChart.js";
import { makeZip } from "../fixtures/zip.js";

const chart = makeChart({ kind: "stream", seconds: 20 });
const audio = Buffer.from(randomBytes(70_000));

async function contents(entries) {
    return Object.fromEntries(await Promise.all(entries.map(async (e) => [e.name, Buffer.from(await e.read())])));
}

test("stored entries written by the app's buildOsz", async () => {
    const zip = buildOsz([{ name: "Artist - Title (Me) [Hard].osu", data: chart }, { name: "audio.mp3", data: audio }]);
    const entries = readZip(new Uint8Array(zip));
    assert.deepEqual(entries.map((e) => [e.name, e.method, e.size]), [["Artist - Title (Me) [Hard].osu", 0, Buffer.byteLength(chart)], ["audio.mp3", 0, audio.length]]);
    const files = await contents(entries);
    assert.equal(files["Artist - Title (Me) [Hard].osu"].toString("utf8"), chart);
    assert.ok(files["audio.mp3"].equals(audio));
});

test("deflated entries, UTF-8 names with or without the flag, a shifted directory", async () => {
    const entries = [
        { name: "Ёлка ★ [Гамма].osu", data: chart },
        { name: "sub/Audio.OGG", data: audio },
        { name: "bg.jpg", data: Buffer.alloc(10, 7), method: 0 },
    ];
    for (const options of [{}, { utf8Flag: false }, { prefix: Buffer.from("GLUED DATA IN FRONT"), keepDeclaredOffset: true }]) {
        const zip = makeZip(entries, options);
        const files = await contents(readZip(zip));
        assert.deepEqual(Object.keys(files), ["Ёлка ★ [Гамма].osu", "sub/Audio.OGG", "bg.jpg"], JSON.stringify(options));
        assert.equal(files["Ёлка ★ [Гамма].osu"].toString("utf8"), chart);
        assert.ok(files["sub/Audio.OGG"].equals(audio));
        assert.ok(files["bg.jpg"].equals(Buffer.alloc(10, 7)));
    }
    // read() works on a view into a bigger buffer, too
    const zip = makeZip(entries);
    const padded = new Uint8Array(zip.length + 20);
    padded.set(zip, 10);
    const inView = await contents(readZip(padded.subarray(10, 10 + zip.length)));
    assert.equal(inView["Ёлка ★ [Гамма].osu"].toString("utf8"), chart);
});

test("damaged zips throw ZipError (code not-zip)", async () => {
    assert.throws(() => readZip(new Uint8Array(0)), ZipError);
    assert.throws(() => readZip(new TextEncoder().encode("<!doctype html><html>not a zip at all, osu! sent a page</html>")), (e) => e instanceof ZipError && e.code === "not-zip");
    const zip = makeZip([{ name: "a.osu", data: chart }]);
    const noDirectory = zip.slice(0, zip.length - 30);
    assert.throws(() => readZip(noDirectory), ZipError);
    // a broken deflate stream: read() rejects
    const broken = makeZip([{ name: "a.osu", data: chart }]);
    for (let i = 40; i < 200; i += 1) broken[i] ^= 0x5a;
    const [entry] = readZip(broken);
    await assert.rejects(entry.read(), ZipError);
    // the local header moved away
    const moved = makeZip([{ name: "a.osu", data: chart, method: 0 }]);
    moved[0] = 0;
    await assert.rejects(readZip(moved)[0].read(), ZipError);
    // an unknown method
    const odd = makeZip([{ name: "a.osu", data: chart, method: 0 }]);
    const view = new DataView(odd.buffer);
    const central = odd.length - 22 - 46 - "a.osu".length;
    view.setUint16(central + 10, 12, true);
    await assert.rejects(readZip(odd)[0].read(), /method 12/);
});

test("the size cap stops an entry that would unpack past it", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    const zip = makeZip([{ name: "big.wav", data: big }]);
    await assert.rejects(readZip(zip, { maxEntryBytes: 1024 * 1024 })[0].read(), /too big/);
    assert.equal((await readZip(zip)[0].read()).length, big.length);
});

test("findEntry: an .osu's AudioFilename in any case, with \\ or /, next to the .osu's folder first", () => {
    const entries = [{ name: "Audio.mp3" }, { name: "sub/audio.mp3" }, { name: "SB/Hit.wav" }];
    assert.equal(findEntry(entries, "audio.MP3").name, "Audio.mp3");
    assert.equal(findEntry(entries, "AUDIO.mp3", "sub").name, "sub/audio.mp3");
    assert.equal(findEntry(entries, "sb\\hit.wav").name, "SB/Hit.wav");
    assert.equal(findEntry(entries, "missing.ogg"), null);
    assert.equal(findEntry(entries, ""), null);
    assert.equal(entryKey(".\\A\\B.osu"), "a/b.osu");
});
