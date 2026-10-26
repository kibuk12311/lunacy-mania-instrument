import test from "node:test";
import assert from "node:assert/strict";
import { readTar, safeTarName, parsePax, parseNumber } from "../../tools/lib/tar.mjs";

// ---- a small tar writer for the tests ----------------------------------------------------------------
function header({ name = "", size = 0, flag = "0", prefix = "", gnu = false, base256 = false }) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, "latin1");
    h.write("0000000\0", 108, "latin1");
    h.write("0000000\0", 116, "latin1");
    if (base256) {
        h[124] = 0x80;
        let v = size;
        for (let i = 135; i > 124; i--) { h[i] = v % 256; v = Math.floor(v / 256); }
    } else h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    h.write("00000000000\0", 136, "latin1");
    h.write(flag, 156, "latin1");
    if (gnu) h.write("ustar  \0", 257, "latin1");
    else { h.write("ustar\0", 257, "latin1"); h.write("00", 263, "latin1"); }
    h.write(prefix, 345, 155, "utf8");
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return h;
}
const padTo = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
function paxRecords(obj) {
    let out = "";
    for (const [k, v] of Object.entries(obj)) {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
        out += `${len}${body}`;
    }
    return Buffer.from(out, "utf8");
}
function file(name, data, opts = {}) {
    const body = Buffer.from(data);
    return Buffer.concat([header({ name, size: body.length, ...opts }), padTo(body)]);
}
const END = Buffer.alloc(1024);

// Splits a buffer into small chunks, as a network stream would deliver it.
async function* chunked(buf, size = 7) {
    for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(buf.length, i + size));
}
async function collect(source, options) {
    const out = [];
    for await (const e of readTar(source, options)) out.push({ ...e, data: e.type === "file" ? (await e.read()).toString("utf8") : null });
    return out;
}

test("reads plain ustar entries from tiny chunks, with prefix and directories", async () => {
    const tar = Buffer.concat([
        header({ name: "dir/", flag: "5" }),
        file("a.json", '{"x":1}'),
        file("b.opus", "x".repeat(1000), { prefix: "deep/path" }),
        END,
    ]);
    const entries = await collect(chunked(tar, 13));
    assert.deepEqual(entries.map((e) => [e.name, e.type, e.size]), [["dir/", "directory", 0], ["a.json", "file", 7], ["deep/path/b.opus", "file", 1000]]);
    assert.equal(entries[2].data, "x".repeat(1000));
    assert.equal(entries[1].headerOffset, 512);
    assert.equal(entries[1].dataOffset, 1024);
    assert.equal(entries[1].endOffset, 1536);
});

test("pax path/size overrides and GNU long names; offsets point at the first header of the chain", async () => {
    const longName = `${"n".repeat(150)}/000001.json`;
    const pax = paxRecords({ path: longName, mtime: "1768316444.95" });
    const gnuName = `${"g".repeat(120)}.opus`;
    const tar = Buffer.concat([
        header({ name: "././@PaxHeader", size: pax.length, flag: "x" }), padTo(pax),
        file("short.json", "{}"),
        header({ name: "././@LongLink", size: gnuName.length + 1, flag: "L", gnu: true }), padTo(Buffer.from(`${gnuName}\0`)),
        file(gnuName.slice(0, 99), "AUDIO", { gnu: true }),
        END,
    ]);
    const entries = await collect([tar]);
    assert.equal(entries[0].name, longName);
    assert.equal(entries[0].mtime, 1768316444.95);
    assert.equal(entries[0].headerOffset, 0);
    assert.equal(entries[1].name, gnuName);
    assert.equal(entries[1].data, "AUDIO");
    assert.equal(entries[1].headerOffset, 2048);
});

test("entries the caller does not read are skipped; a web ReadableStream works", async () => {
    const tar = Buffer.concat([file("skip.bin", "s".repeat(5000)), file("keep.txt", "kept"), END]);
    const stream = new ReadableStream({
        start(c) { for (let i = 0; i < tar.length; i += 1000) c.enqueue(new Uint8Array(tar.subarray(i, i + 1000))); c.close(); },
    });
    const seen = [];
    for await (const e of readTar(stream)) {
        if (e.name === "keep.txt") seen.push((await e.read()).toString());
        else seen.push(`skipped ${e.size}`);
    }
    assert.deepEqual(seen, ["skipped 5000", "kept"]);
});

test("baseOffset and skipBytes let a reader start in the middle of an archive", async () => {
    const first = file("a.txt", "A".repeat(700));
    const tar = Buffer.concat([first, file("b.txt", "B"), END]);
    const ranged = await collect([tar.subarray(first.length)], { baseOffset: first.length });
    assert.deepEqual(ranged.map((e) => [e.name, e.headerOffset]), [["b.txt", first.length]]);
    const ignoredRange = await collect(chunked(tar, 100), { skipBytes: first.length });
    assert.deepEqual(ignoredRange.map((e) => [e.name, e.headerOffset, e.data]), [["b.txt", first.length, "B"]]);
});

test("rejects bad checksums, truncated data, a missing end marker and oversize entries", async () => {
    const good = file("a.txt", "hello");
    const broken = Buffer.from(good);
    broken[10] ^= 0xff;
    await assert.rejects(collect([Buffer.concat([broken, END])]), /checksum/);
    await assert.rejects(collect([good.subarray(0, 515)]), /ended/);
    await assert.rejects(collect([good]), /end-of-archive/);
    assert.equal((await collect([good], { allowMissingEnd: true })).length, 1);
    await assert.rejects(collect([Buffer.concat([good, END])], { maxEntrySize: 3 }), /cap/);
    const bigPax = Buffer.concat([header({ name: "p", size: 5000, flag: "x" }), padTo(Buffer.alloc(5000, 0x41)), END]);
    await assert.rejects(collect([bigPax], { maxMetaSize: 1000 }), /too large/);
});

test("number fields: octal and GNU base-256", () => {
    assert.equal(parseNumber(header({ size: 0o1234 }), 124, 12), 0o1234);
    assert.equal(parseNumber(header({ size: 9_000_000_000, base256: true }), 124, 12), 9_000_000_000);
    assert.deepEqual(parsePax(paxRecords({ path: "ä/b", size: "12" })), { path: "ä/b", size: "12" });
});

test("safeTarName refuses traversal, absolute and drive paths", () => {
    assert.equal(safeTarName("./a/b.json"), "a/b.json");
    assert.equal(safeTarName("../x"), null);
    assert.equal(safeTarName("a/../../x"), null);
    assert.equal(safeTarName("/etc/x"), null);
    assert.equal(safeTarName("C:/x"), null);
    assert.equal(safeTarName("a\\..\\x"), null);
    assert.equal(safeTarName("a/b:c"), null);
    assert.equal(safeTarName(""), null);
});
