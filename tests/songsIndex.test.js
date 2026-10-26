import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSongsIndex } from "../app/songsIndex.js";

const chart = (id) => `osu file format v14\r\n\r\n[General]\r\nAudioFilename: audio.mp3\r\nMode: 3\r\n\r\n[Metadata]\r\nTitle:T\r\nBeatmapID:${id}\r\n`;

async function songs() {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "osu Мира ")), "Songs");
    const set = async (folder, files) => {
        await mkdir(path.join(dir, folder), { recursive: true });
        for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, folder, name), text, "utf8");
    };
    await set("123 Арт - Песня", { "a [Easy].osu": chart(1000), "a [Hard].osu": chart(1001), "audio.mp3": "A" });
    await set("456 Other - X", { "x.osu": chart(2000) });
    await set("no id here", { "y.osu": chart(3000) });
    return dir;
}

// readdir / readFile that count what they read
function counting() {
    const calls = { readdir: [], readFile: [] };
    return {
        calls,
        readdir: (dir) => { calls.readdir.push(dir); return readdir(dir); },
        readFile: (file, enc) => { calls.readFile.push(file); return readFile(file, enc); },
    };
}

test("find gives the chart of that set by its BeatmapID, reading only that set's folder", async () => {
    const dir = await songs();
    const io = counting();
    const index = createSongsIndex({ songsDir: async () => dir, readdir: io.readdir, readFile: io.readFile });
    const hit = await index.find(123, 1001);
    assert.equal(hit.path, path.join(dir, "123 Арт - Песня", "a [Hard].osu"));
    assert.match(hit.osuText, /BeatmapID:1001/);
    assert.deepEqual(io.calls.readdir, [dir, path.join(dir, "123 Арт - Песня")]);
    assert.ok(io.calls.readFile.every((f) => f.startsWith(path.join(dir, "123 Арт - Песня"))));
    assert.equal(await index.find(123, 9999), null);
    assert.equal(await index.find(777, 1001), null);
    assert.equal(await index.find(456, 2000).then((r) => path.basename(r.path)), "x.osu");
});

test("the Songs list is read at most once every 5 minutes", async () => {
    const dir = await songs();
    const io = counting();
    let clock = 0;
    const index = createSongsIndex({ songsDir: async () => dir, readdir: io.readdir, readFile: io.readFile, now: () => clock });
    await index.find(123, 1000);
    clock = 4 * 60_000;
    await index.find(456, 2000);
    await index.find(777, 1);
    assert.equal(io.calls.readdir.filter((d) => d === dir).length, 1);
    clock = 5 * 60_000 + 1;
    await index.find(123, 1000);
    assert.equal(io.calls.readdir.filter((d) => d === dir).length, 2);
});

test("no Songs folder (osu! closed) or an unreadable one finds nothing and throws nothing", async () => {
    const io = counting();
    const none = createSongsIndex({ songsDir: async () => null, readdir: io.readdir, readFile: io.readFile });
    assert.equal(await none.find(123, 1000), null);
    assert.deepEqual(io.calls.readdir, []);
    const failing = createSongsIndex({ songsDir: async () => { throw new Error("tosu down"); } });
    assert.equal(await failing.find(123, 1000), null);
    const missing = createSongsIndex({ songsDir: async () => path.join(tmpdir(), "no such songs folder 4815") });
    assert.equal(await missing.find(123, 1000), null);
    assert.equal(await createSongsIndex({ songsDir: async () => tmpdir() }).find("1; rm", 1000), null);
});
