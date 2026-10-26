import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { buildOsz } from "../src/gen/osz.js";
import { readZip, safeEntryPath, extractChart } from "../src/rate/oszRead.js";
import { setLang } from "../src/i18n/i18n.js";

// A zip whose entries are deflated (method 8), as most .osz from the mirrors are.
function deflatedZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const body = Buffer.from(data);
        const packed = deflateRawSync(body);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(crc32(body), 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, packed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc32(body), 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(body.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + packed.length;
    }
    const size = centrals.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

const osu = ({ version, id, audio = "audio.mp3", bg = "bg.jpg" }) => [
    "osu file format v14", "", "[General]", `AudioFilename: ${audio}`, "Mode: 3", "",
    "[Metadata]", "Title:Song", "Artist:Art", "Creator:Map", `Version:${version}`, ...(id === undefined ? [] : [`BeatmapID:${id}`]), "BeatmapSetID:77", "",
    "[Difficulty]", "CircleSize:4", "", "[Events]", "//Background and Video events", `0,0,"${bg}",0,0`, "",
    "[HitObjects]", "64,192,1000,1,0,0:0:0:0:", "",
].join("\r\n");

test("readZip reads back what buildOsz stored", () => {
    const zip = buildOsz([
        { name: "a.osu", data: Buffer.from("chart") },
        { name: "папка/звук.mp3", data: Buffer.from([1, 2, 3, 4]) },
    ]);
    const entries = readZip(zip);
    assert.deepEqual(entries.map((e) => e.name), ["a.osu", "папка/звук.mp3"]);
    assert.equal(entries[0].read().toString(), "chart");
    assert.deepEqual([...entries[1].read()], [1, 2, 3, 4]);
});

test("readZip inflates deflated entries", () => {
    const text = "x".repeat(5000) + "end";
    const entries = readZip(deflatedZip([{ name: "big.osu", data: text }, { name: "b.png", data: "png" }]));
    assert.equal(entries[0].read().toString(), text);
    assert.equal(entries[1].read().toString(), "png");
});

test("readZip copes with a wrong directory offset (data glued in front) and refuses what is no zip", () => {
    const zip = Buffer.concat([Buffer.from("JUNKJUNK"), deflatedZip([{ name: "a.osu", data: "chart" }])]);
    assert.equal(readZip(zip)[0].read().toString(), "chart");
    assert.throws(() => readZip(Buffer.from("<html>no</html>")));
    assert.throws(() => readZip(Buffer.alloc(0)));
});

test("safeEntryPath refuses absolute paths, .., drive letters and NUL", () => {
    for (const bad of ["../x", "C:\\x", "c:x", "a/../../b", "a/..", "/etc/passwd", "\\\\server\\share", "a\u0000b", "", ".", "./", null]) {
        assert.equal(safeEntryPath(bad), null, JSON.stringify(bad));
    }
    assert.equal(safeEntryPath("sub\\file.png"), "sub/file.png");
    assert.equal(safeEntryPath("./a/./b.mp3"), "a/b.mp3");
    assert.equal(safeEntryPath("Песня [Hard].osu"), "Песня [Hard].osu");
});

test("extractChart copies only the difficulty asked for by BeatmapID, its audio and its background", async () => {
    const zip = deflatedZip([
        { name: "Art - Song (Map) [Easy].osu", data: osu({ version: "Easy", id: 111, audio: "other.mp3", bg: "easy.jpg" }) },
        { name: "Art - Song (Map) [Hard].osu", data: osu({ version: "Hard", id: 222 }) },
        { name: "audio.mp3", data: "AUDIO" },
        { name: "other.mp3", data: "OTHER" },
        { name: "BG.JPG", data: "JPEG" },
        { name: "easy.jpg", data: "EASY" },
    ]);
    const out = path.join(await mkdtemp(path.join(tmpdir(), "марафон ")), "скачанные", "марафон", "77");
    const r = await extractChart(zip, 222, out);
    assert.equal(r.osuPath, path.join(out, "222.osu"));
    assert.match(r.osuText, /Version:Hard/);
    assert.equal(await readFile(r.osuPath, "utf8"), r.osuText);
    assert.equal(await readFile(path.join(out, "audio.mp3"), "utf8"), "AUDIO");
    // names match like on Windows, whatever their case
    assert.equal(await readFile(path.join(out, "bg.jpg"), "utf8"), "JPEG");
    assert.deepEqual((await readdir(out)).sort(), ["222.osu", "audio.mp3", "bg.jpg"]);
});

test("extractChart falls back to [Version] in the file name when the chart has no BeatmapID", async () => {
    const zip = buildOsz([
        { name: "Art - Song (Map) [Normal].osu", data: Buffer.from(osu({ version: "Normal" })) },
        { name: "Art - Song (Map) [Hard].osu", data: Buffer.from(osu({ version: "Hard", id: 0 })) },
        { name: "audio.mp3", data: Buffer.from("A") },
    ]);
    const out = await mkdtemp(path.join(tmpdir(), "osz "));
    const r = await extractChart(zip, 333, out, { version: "Hard" });
    assert.match(r.osuText, /Version:Hard/);
    assert.equal(r.backgroundPath, null);
});

test("extractChart refuses a missing difficulty, a missing audio and an audio path that leaves the folder", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "osz "));
    const zip = (audio, files = []) => buildOsz([{ name: "x.osu", data: Buffer.from(osu({ version: "X", id: 5, audio })) }, ...files]);
    await assert.rejects(extractChart(zip("audio.mp3", [{ name: "audio.mp3", data: Buffer.from("A") }]), 6, out), { message: "в архиве нет этой сложности" });
    await assert.rejects(extractChart(zip("audio.mp3"), 5, out), { message: "в архиве нет звука этой сложности" });
    await assert.rejects(extractChart(zip("../../evil.mp3", [{ name: "../../evil.mp3", data: Buffer.from("E") }]), 5, out),
        { message: "в архиве нет звука этой сложности" });
    assert.deepEqual(await readdir(path.dirname(out)).then((names) => names.includes("evil.mp3")), false);
    setLang("en");
    try {
        await assert.rejects(extractChart(Buffer.from("nope"), 5, out), { message: "the downloaded archive is damaged" });
    } finally {
        setLang("ru");
    }
});
