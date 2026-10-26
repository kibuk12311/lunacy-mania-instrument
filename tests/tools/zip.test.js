import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { openZip, extractZip, safeJoin, safeEntryParts } from "../../tools/lib/zip.mjs";
import { downloadResumable, createApiClient } from "../../tools/fetch-etterna-packs.mjs";
import { makeZip } from "./fixtures/makeZip.js";

async function tempDir(t) {
    const dir = await mkdtemp(path.join(tmpdir(), "zip-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
async function zipFile(t, entries, opts) {
    const dir = await tempDir(t);
    const file = path.join(dir, "a.zip");
    await writeFile(file, makeZip(entries, opts));
    return { dir, file };
}
const files = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).replace(/\\/g, "/")).sort();

// 3 MB that compresses a little: several 1 MB reads and many inflate chunks
const big = Buffer.concat([randomBytes(1_500_000), Buffer.alloc(1_500_000, 0x41)]);

for (const [label, opts] of [
    ["plain", {}],
    ["zip64", { zip64: true }],
    ["wrong directory offset", { prefix: Buffer.from("junk glued in front of the archive") }],
    ["zip64 with a wrong directory offset", { zip64: true, prefix: Buffer.alloc(777, 9) }],
]) {
    test(`zip (${label}): stored and deflated entries, read and streamed to disk`, async (t) => {
        const { dir, file } = await zipFile(t, [
            { name: "Pack/Song/chart.sm", data: "#TITLE:x;" },
            { name: "Pack/Song/audio.ogg", data: big },
            { name: "Pack/Song/stored.mp3", data: "stored bytes", method: 0 },
            { name: "Pack/Song/desc.ssc", data: "#NOTES:;", descriptor: true },
            { name: "Pack/Song/bg.png", data: "png" },
        ], opts);
        const zip = await openZip(file);
        try {
            assert.deepEqual(zip.entries.map((e) => e.name), ["Pack/Song/chart.sm", "Pack/Song/audio.ogg", "Pack/Song/stored.mp3", "Pack/Song/desc.ssc", "Pack/Song/bg.png"]);
            const [chart, audio, stored, desc] = zip.entries;
            assert.equal((await zip.readEntry(chart)).toString(), "#TITLE:x;");
            assert.equal((await zip.readEntry(stored)).toString(), "stored bytes");
            assert.equal((await zip.readEntry(desc)).toString(), "#NOTES:;");
            assert.equal(audio.size, big.length);
            const out = path.join(dir, "out", "audio.ogg");
            assert.equal(await zip.extractEntry(audio, out), big.length);
            assert.equal(createHash("sha1").update(await readFile(out)).digest("hex"), createHash("sha1").update(big).digest("hex"));
        } finally {
            await zip.close();
        }
        const dest = path.join(dir, "x");
        const res = await extractZip(file, dest, { filter: (name) => /\.(sm|ssc|ogg|mp3)$/i.test(name) });
        assert.deepEqual(res.skipped, []);
        assert.deepEqual(await files(dest), ["Pack/Song/audio.ogg", "Pack/Song/chart.sm", "Pack/Song/desc.ssc", "Pack/Song/stored.mp3"]);
    });
}

test("zip: names that would leave the folder are never written", async (t) => {
    const { dir, file } = await zipFile(t, [
        { name: "../evil.sm", data: "x" },
        { name: "a/../../evil2.sm", data: "x" },
        { name: "C:/evil3.sm", data: "x" },
        { name: "/abs.sm", data: "x" },
        { name: "\\\\server\\share\\evil4.sm", data: "x" },
        { name: "a\\..\\..\\evil5.sm", data: "x" },
        { name: "song/con.sm", data: "x" },
        { name: "song/stream.sm:hidden", data: "x" },
        { name: "ok/fine.sm", data: "fine" },
    ]);
    const dest = path.join(dir, "dest");
    const res = await extractZip(file, dest);
    assert.deepEqual(res.extracted.map((e) => e.name), ["ok/fine.sm"]);
    assert.equal(res.skipped.length, 8);
    assert.deepEqual(await files(dir), ["a.zip", "dest/ok/fine.sm"]);
});

test("safe paths: trailing dots and spaces dropped, bad characters replaced, escapes refused", () => {
    assert.deepEqual(safeEntryParts("Pack/Song.../a?.sm"), ["Pack", "Song", "a_.sm"]);
    assert.equal(safeEntryParts("Pack/.../x.sm"), null);
    assert.equal(safeEntryParts(""), null);
    assert.equal(safeEntryParts("d:x.sm"), null);
    const root = path.resolve("C:/root");
    assert.equal(safeJoin(root, "a/b.sm"), path.join(root, "a", "b.sm"));
    assert.equal(safeJoin(root, "a/../../b.sm"), null);
});

test("zip: size caps, lying sizes and bad CRCs leave no file behind", async (t) => {
    const data = Buffer.alloc(50_000, 1);
    const { dir, file } = await zipFile(t, [
        { name: "big.ogg", data },
        { name: "lies.ogg", data, size: 1000 }, // declares 1000 bytes, inflates to 50 000 (a zip bomb in small)
        { name: "crc.ogg", data, crc: 1234 },
    ]);
    const dest = path.join(dir, "dest");
    const res = await extractZip(file, dest, { maxEntryBytes: 10_000 });
    assert.deepEqual(res.extracted, []);
    // big.ogg and crc.ogg are over the cap; lies.ogg passes it by its declared size but is stopped once it inflates past that
    assert.deepEqual(res.skipped.map((s) => [s.name, /cap/.test(s.reason) ? "cap" : /declared size/.test(s.reason) ? "lies" : s.reason]),
        [["big.ogg", "cap"], ["lies.ogg", "lies"], ["crc.ogg", "cap"]]);
    const zip = await openZip(file);
    try {
        const [bigE, lies, crc] = zip.entries;
        await assert.rejects(zip.extractEntry(lies, path.join(dir, "l.ogg")), /declared size/);
        await assert.rejects(zip.extractEntry(crc, path.join(dir, "c.ogg")), /CRC/);
        await assert.rejects(zip.readEntry(crc), /CRC/);
        await assert.rejects(zip.readEntry(lies), /declared size/);
        await assert.rejects(zip.readEntry(bigE, { maxBytes: 10 }), /cap/);
    } finally {
        await zip.close();
    }
    assert.deepEqual(await files(dir), ["a.zip"]); // no .part and no half file anywhere
});

test("zip: names without the UTF-8 flag (CP437) and Info-ZIP unicode paths", async (t) => {
    const raw = Buffer.from([0x53, 0x6f, 0x6e, 0x67, 0x81, 0x2e, 0x73, 0x6d]); // "Song" + CP437 ü + ".sm"
    const unicodeName = Buffer.from("曲.sm", "utf8");
    const legacy = Buffer.from("x.sm");
    const up = Buffer.alloc(9 + unicodeName.length);
    up.writeUInt16LE(0x7075, 0);
    up.writeUInt16LE(5 + unicodeName.length, 2);
    up[4] = 1;
    up.writeUInt32LE(crc32(legacy), 5);
    unicodeName.copy(up, 9);
    const { file } = await zipFile(t, [
        { name: raw, data: "a", utf8: false },
        { name: legacy, data: "b", utf8: false, extra: up },
    ]);
    const zip = await openZip(file);
    try {
        assert.deepEqual(zip.entries.map((e) => e.name), ["Songü.sm", "曲.sm"]);
    } finally {
        await zip.close();
    }
});

test("zip: not a zip, or a truncated one, is an error rather than a guess", async (t) => {
    const dir = await tempDir(t);
    const junk = path.join(dir, "junk.zip");
    await writeFile(junk, "<html>rate limited</html>");
    await assert.rejects(openZip(junk), /not a zip/);
    const whole = makeZip([{ name: "a.sm", data: big }]);
    const cut = path.join(dir, "cut.zip");
    await writeFile(cut, Buffer.concat([whole.subarray(0, 1000), whole.subarray(whole.length - 200)]));
    await assert.rejects(async () => {
        const zip = await openZip(cut);
        try {
            await zip.extractEntry(zip.entries[0], path.join(dir, "a.sm"));
        } finally {
            await zip.close();
        }
    });
});

// ---- the Etterna fetcher's download (fake fetch, no network) ------------------------------------------------

function fakeHost(data, { ignoreRange = false, dropAt = null, limited = 0 } = {}) {
    const calls = [];
    let dropped = false;
    const fetchImpl = async (url, opts = {}) => {
        const range = opts.headers?.range ?? null;
        calls.push({ url, range });
        if (limited > 0) {
            limited -= 1;
            return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
        }
        const start = !ignoreRange && range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
        const body = data.subarray(start);
        const headers = start > 0
            ? { "content-length": String(body.length), "content-range": `bytes ${start}-${data.length - 1}/${data.length}` }
            : { "content-length": String(data.length) };
        let step = 0;
        const stream = new ReadableStream({
            async pull(c) {
                if (dropAt !== null && !dropped && start < dropAt) {
                    if (step++ === 0) return c.enqueue(new Uint8Array(body.subarray(0, dropAt - start)));
                    dropped = true;
                    await new Promise((r) => setTimeout(r, 30));
                    return c.error(new Error("connection reset"));
                }
                if (step++ === 0) return c.enqueue(new Uint8Array(body));
                c.close();
            },
        });
        return new Response(stream, { status: start > 0 ? 206 : 200, headers });
    };
    return { fetchImpl, calls };
}

const zipBytes = makeZip([{ name: "a.sm", data: big }]);
const quiet = { sleepImpl: async () => {}, logImpl: () => {}, hosts: ["downloads.etternaonline.com"] };
const URL0 = "https://downloads.etternaonline.com/ranked/Pack%20%231.zip";

test("download: a dropped connection resumes with Range from what is on disk", async (t) => {
    const dir = await tempDir(t);
    const host = fakeHost(zipBytes, { dropAt: 1_000_000 });
    const dest = path.join(dir, "1.zip");
    const res = await downloadResumable(URL0, dest, { ...quiet, fetchImpl: host.fetchImpl });
    assert.equal(res.resumedFrom, 1_000_000);
    assert.deepEqual(host.calls.map((c) => c.range), [null, "bytes=1000000-"]);
    assert.ok((await readFile(dest)).equals(zipBytes));
    await assert.rejects(stat(`${dest}.part`));
});

test("download: a host that ignores Range starts over; 429 waits for Retry-After", async (t) => {
    const dir = await tempDir(t);
    const host = fakeHost(zipBytes, { dropAt: 500_000, ignoreRange: true, limited: 1 });
    const waits = [];
    const dest = path.join(dir, "2.zip");
    await downloadResumable(URL0, dest, { ...quiet, sleepImpl: async (ms) => { waits.push(ms); }, fetchImpl: host.fetchImpl });
    assert.equal(waits[0], 2000);
    assert.ok((await readFile(dest)).equals(zipBytes));
});

test("download: other hosts, 404s and non-zips are refused", async (t) => {
    const dir = await tempDir(t);
    await assert.rejects(downloadResumable("https://evil.example/x.zip", path.join(dir, "a.zip"), quiet), /unexpected download host/);
    const notFound = async () => new Response("nope", { status: 404 });
    await assert.rejects(downloadResumable(URL0, path.join(dir, "b.zip"), { ...quiet, fetchImpl: notFound }), (e) => e.final === true);
    const html = fakeHost(Buffer.from("<html>maintenance</html>"));
    await assert.rejects(downloadResumable(URL0, path.join(dir, "c.zip"), { ...quiet, fetchImpl: html.fetchImpl }), /not a zip/);
    assert.deepEqual(await readdir(dir), []);
});

test("download: a zip with data glued in front is kept; a big non-zip is final, a short one is retried later", async (t) => {
    const dir = await tempDir(t);
    const glued = makeZip([{ name: "a.sm", data: "#TITLE:x;" }], { prefix: Buffer.from("MZ self-extractor stub") });
    const ok = await downloadResumable(URL0, path.join(dir, "glued.zip"), { ...quiet, fetchImpl: fakeHost(glued).fetchImpl });
    assert.ok((await readFile(ok.file)).equals(glued));
    const zip = await openZip(ok.file);
    assert.deepEqual(zip.entries.map((e) => e.name), ["a.sm"]);
    await zip.close();
    await rm(ok.file);
    const html = fakeHost(Buffer.from("<html>maintenance</html>"));
    await assert.rejects(downloadResumable(URL0, path.join(dir, "short.zip"), { ...quiet, fetchImpl: html.fetchImpl }), (e) => /not a zip/.test(e.message) && !e.final);
    const junk = fakeHost(randomBytes(2_000_000));
    await assert.rejects(downloadResumable(URL0, path.join(dir, "junk.zip"), { ...quiet, fetchImpl: junk.fetchImpl }), (e) => /not a zip/.test(e.message) && e.final === true);
    assert.deepEqual(await readdir(dir), []);
});

test("API client: one request at a time, spaced out, 429 honoured", async () => {
    const seen = [];
    let first = true;
    const fetchImpl = async (url) => {
        seen.push(url);
        if (first) {
            first = false;
            return new Response("", { status: 429, headers: { "retry-after": "3" } });
        }
        return Response.json({ data: [{ id: seen.length }], meta: { last_page: 1 } });
    };
    const waits = [];
    const api = createApiClient({ fetchImpl, base: "https://api.test", gapMs: 1100, sleepImpl: async (ms) => { waits.push(ms); }, logImpl: () => {} });
    const items = await api.list("/packs");
    assert.equal(items.length, 1);
    assert.deepEqual(seen, ["https://api.test/packs?limit=2000", "https://api.test/packs?limit=2000"]);
    assert.ok(waits.some((ms) => ms > 2000), `waited ${waits}`);
});

test("numbered copies of a long file name stay different after shortening", async () => {
    const { fitName, fitNumbered } = await import("../../tools/fetch-etterna-packs.mjs");
    const dir = "A:/SneezeyTrain/etterna/songs/" + "x".repeat(150);
    const name = `${"Artist ".repeat(6)} - ${"Title ".repeat(10)} (mapper) [Hard].osu`;
    const first = fitName(dir, name);
    const copies = [2, 3, 10].map((n) => fitNumbered(dir, name, n));
    assert.equal(new Set([first, ...copies].map((s) => s.toLowerCase())).size, 4);
    for (const c of [first, ...copies]) {
        assert.ok(dir.length + 1 + c.length <= 240, c);
        assert.ok(c.endsWith(".osu"));
    }
    assert.ok(copies[0].endsWith(" (2).osu"));
});
