// One .osz for a whole mapset (mapgen v3, stream C): every difficulty, its rate versions with their own audio,
// one background, shared metadata. Audio, dans and the background picture come from stubs here; the song's tags
// are read by the real ffmpeg.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { exportMapset, parseTags, probeTags } from "../app/mapsetExport.js";
import { toOsu } from "../src/gen/writer.js";
import { readMeta } from "../src/gen/osuMeta.js";
import { readOsz, osuTexts } from "./fixtures/readOsz.js";

const exists = (p) => access(p).then(() => true, () => false);

function diff(version, numeric) {
    const rows = Array.from({ length: 40 }, (_, i) => ({ t: 1000 + i * 125, cols: [i % 4] }));
    return {
        osuText: toOsu({ rows, bpm: 120, offsetMs: 1000, title: "Song", version, audioFilename: "audio.mp3", previewMs: 24000 }),
        version,
        result: { kind: "ok", label: version.split(" ").slice(0, 2).join(" "), numeric },
    };
}

async function setup(audioName = "song.mp3") {
    const dir = await mkdtemp(path.join(tmpdir(), "mapset "));
    const audioPath = path.join(dir, audioName);
    await writeFile(audioPath, Buffer.from("original audio"));
    const outDir = path.join(dir, "maps");
    const calls = { audio: [], dan: [], png: [] };
    const renderAudio = async ({ input, output, rate, pitch }) => {
        calls.audio.push({ input, output, rate, pitch });
        await writeFile(output, `audio at ${rate}${pitch ? " nc" : ""}`);
        return output;
    };
    const danFor = async (osuText) => {
        calls.dan.push(osuText);
        const preview = readMeta(osuText).previewMs;
        return { kind: "ok", label: "Delta low", numeric: 13.6 + preview / 1e9 };
    };
    const renderPng = async (html) => {
        calls.png.push(html);
        return Buffer.from("PNG!");
    };
    const meta = { title: "My Song", artist: "Some Artist", creator: "me", source: "", tags: "test" };
    return { dir, audioPath, outDir, calls, base: { ffmpeg: "ffmpeg.exe", dir: outDir, audioPath, meta, renderAudio, danFor, renderPng } };
}

const three = () => [diff("Beta mid Jumpstream", 12), diff("Gamma mid Jumpstream", 13), diff("Delta mid Jumpstream", 14)];

test("3 difficulties × rates 1.1 and 1.2: 9 .osu, 3 audio files and 1 background in one .osz", async () => {
    const { base, calls } = await setup();
    const out = await exportMapset({ ...base, diffs: three(), previewMs: 30000, background: { mode: "danCourse" }, rates: [1.1, 1.2], pitch: false });
    assert.equal(path.basename(out.file), "Some Artist - My Song (mapset).osz");
    const files = readOsz(await readFile(out.file));
    const names = [...files.keys()];
    assert.equal(names.filter((n) => n.endsWith(".osu")).length, 9);
    assert.deepEqual(names.filter((n) => n.endsWith(".mp3")).sort(), ["audio 1.1x.mp3", "audio 1.2x.mp3", "audio.mp3"]);
    assert.deepEqual(names.filter((n) => n.endsWith(".png")), ["bg.png"]);
    assert.equal(files.get("audio.mp3").toString(), "original audio", "an mp3 goes in as it is");
    assert.equal(files.get("audio 1.2x.mp3").toString(), "audio at 1.2");
    assert.equal(files.get("bg.png").toString(), "PNG!");
    // audio rendered once per rate, from the original
    assert.deepEqual(calls.audio.map((c) => c.rate), [1.1, 1.2]);
    assert.equal(out.entries.length, 9);
    assert.deepEqual(out.entries.map((e) => e.rate), [1, 1.1, 1.2, 1, 1.1, 1.2, 1, 1.1, 1.2]);
});

test("every AudioFilename and background is in the zip; all share title, artist and BeatmapSetID:-1; versions are unique", async () => {
    const { base } = await setup();
    const out = await exportMapset({ ...base, diffs: three(), previewMs: 30000, background: { mode: "danCourse" }, rates: [1.1, 1.2], pitch: false });
    const files = readOsz(await readFile(out.file));
    const osus = [...osuTexts(files).values()].map(readMeta);
    for (const m of osus) {
        assert.ok(files.has(m.audioFilename), m.audioFilename);
        assert.ok(files.has(m.background), m.background);
        assert.equal(m.title, "My Song");
        assert.equal(m.artist, "Some Artist");
        assert.equal(m.creator, "me");
        assert.equal(m.beatmapSetId, "-1");
        assert.ok(m.tags.startsWith("lunacy-mania generated test"), m.tags);
    }
    assert.equal(new Set(osus.map((m) => m.version)).size, 9);
    assert.deepEqual(out.entries.map((e) => e.version).sort(), osus.map((m) => m.version).sort());
    for (const name of osuTexts(files).keys()) assert.match(name, /^Some Artist - My Song \(me\) \[.+\]\.osu$/);
});

test("a rated difficulty is named by its own dan and its PreviewTime is the base point ÷ rate", async () => {
    const { base, calls } = await setup();
    const out = await exportMapset({ ...base, diffs: [diff("Gamma mid Jumpstream", 13)], previewMs: 30000, background: { mode: "none" }, rates: [1.2], pitch: true });
    const osus = [...osuTexts(readOsz(await readFile(out.file))).values()];
    const rated = osus.map(readMeta).find((m) => m.version !== "Gamma mid Jumpstream");
    assert.equal(rated.version, "Delta low · Gamma mid Jumpstream 1.2x NC");
    assert.equal(rated.previewMs, Math.round(30000 / 1.2));
    assert.equal(rated.audioFilename, "audio 1.2x nc.mp3");
    assert.equal(rated.background, null);
    assert.equal(osus.map(readMeta).find((m) => m.version === "Gamma mid Jumpstream").previewMs, 30000);
    assert.equal(calls.dan.length, 1, "the base keeps the dan it was generated with");
    assert.deepEqual(out.entries, [
        { version: "Gamma mid Jumpstream", label: "Gamma mid", numeric: 13, rate: 1 },
        { version: "Delta low · Gamma mid Jumpstream 1.2x NC", label: "Delta low", numeric: 13.6 + 25000 / 1e9, rate: 1.2 },
    ]);
    assert.equal(calls.audio[0].pitch, true);
});

test("the dan-course background lists every difficulty with its dans", async () => {
    const { base, calls } = await setup();
    await exportMapset({ ...base, diffs: three(), previewMs: null, background: { mode: "danCourse" }, rates: [1.1], pitch: false });
    const html = calls.png[0];
    assert.ok(html.includes("My Song"));
    for (const v of ["Beta mid Jumpstream", "Gamma mid Jumpstream", "Delta mid Jumpstream", "1.1x Delta low"]) assert.ok(html.includes(v), v);
});

test("an image background is copied in as bg<ext>, a dan-course one may use it as its backdrop", async () => {
    const { base, dir, calls } = await setup();
    const imagePath = path.join(dir, "Cover.JPG");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const out = await exportMapset({ ...base, diffs: three().slice(0, 1), previewMs: null, background: { mode: "image", imagePath }, rates: [], pitch: false });
    const files = readOsz(await readFile(out.file));
    assert.deepEqual(files.get("bg.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    assert.equal(readMeta([...osuTexts(files).values()][0]).background, "bg.jpg");
    assert.equal(calls.png.length, 0);
    await exportMapset({ ...base, diffs: three().slice(0, 1), previewMs: null, background: { mode: "danCourse", imagePath }, rates: [], pitch: false });
    assert.ok(calls.png[0].includes("data:image/jpeg;base64,"));
});

test("a .wav or .flac song becomes audio.mp3", async () => {
    for (const name of ["song.wav", "song.FLAC"]) {
        const { base, calls } = await setup(name);
        const out = await exportMapset({ ...base, diffs: three().slice(0, 1), previewMs: null, background: { mode: "none" }, rates: [], pitch: false });
        const files = readOsz(await readFile(out.file));
        assert.deepEqual([...files.keys()].filter((n) => !n.endsWith(".osu")), ["audio.mp3"]);
        assert.equal(readMeta([...osuTexts(files).values()][0]).audioFilename, "audio.mp3");
        assert.deepEqual(calls.audio.map((c) => [c.rate, c.pitch]), [[1, false]]);
    }
    const { base } = await setup("song.ogg");
    const out = await exportMapset({ ...base, diffs: three().slice(0, 1), previewMs: null, background: { mode: "none" }, rates: [], pitch: false });
    assert.ok(readOsz(await readFile(out.file)).has("audio.ogg"));
});

test("a given name is used, nothing is overwritten, and the rate audio folder is cleaned up", async () => {
    const { base, outDir, calls } = await setup();
    const args = { ...base, diffs: three().slice(0, 1), previewMs: null, background: { mode: "none" }, rates: [1.3], pitch: false, name: "My Song [Gamma mid Jumpstream]" };
    const a = await exportMapset(args);
    const b = await exportMapset(args);
    assert.equal(path.basename(a.file), "My Song [Gamma mid Jumpstream].osz");
    assert.equal(path.basename(b.file), "My Song [Gamma mid Jumpstream] (2).osz");
    assert.equal((await readdir(outDir)).length, 2);
    for (const c of calls.audio) assert.equal(await exists(path.dirname(c.output)), false, c.output);
});

test("two difficulties with the same name stay apart", async () => {
    const { base } = await setup();
    const out = await exportMapset({ ...base, diffs: [diff("Gamma mid Stream", 13), diff("Gamma mid Stream", 13.1)], previewMs: null, background: { mode: "none" }, rates: [], pitch: false });
    const versions = [...osuTexts(readOsz(await readFile(out.file))).values()].map((t) => readMeta(t).version);
    assert.deepEqual(versions, ["Gamma mid Stream", "Gamma mid Stream (2)"]);
});

test("empty title or artist keep the map's own", async () => {
    const { base } = await setup();
    const out = await exportMapset({ ...base, meta: { title: "", artist: "", creator: "", source: "", tags: "" }, diffs: three().slice(0, 1), previewMs: null, background: { mode: "none" }, rates: [], pitch: false });
    assert.equal(path.basename(out.file), "Unknown - Song (mapset).osz");
});

test("song tags from ffmpeg's report: the file's own tags first, then the file or folder name", () => {
    const mp3 = [
        "Input #0, mp3, from 'C:\\songs\\x.mp3':",
        "  Metadata:",
        "    title           : Freedom Dive",
        "    artist          : xi",
        "  Duration: 00:04:19.00, start: 0.025057, bitrate: 320 kb/s",
        "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s",
        "  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr (attached pic)",
        "    Metadata:",
        "      title           : Album cover",
    ].join("\r\n");
    assert.deepEqual(parseTags(mp3, "C:/songs/x.mp3"), { artist: "xi", title: "Freedom Dive" });
    assert.deepEqual(parseTags(mp3.replace("Freedom Dive", "xi - Freedom Dive (ID: 1)"), "x.mp3"), { artist: "xi", title: "Freedom Dive (ID: 1)" }, "the artist once");
    const ogg = [
        "Input #0, ogg, from 'a.ogg':",
        "  Duration: 00:02:00.00, start: 0.000000, bitrate: 160 kb/s",
        "  Stream #0:0: Audio: vorbis, 44100 Hz, stereo, fltp, 160 kb/s",
        "    Metadata:",
        "      ARTIST          : Camellia",
        "      TITLE           : Exit This Earth's Atomosphere",
    ].join("\n");
    assert.deepEqual(parseTags(ogg, "a.ogg"), { artist: "Camellia", title: "Exit This Earth's Atomosphere" });
    const cover = ["Input #0, mp3, from 'b.mp3':", "  Duration: 00:01:00.00", "  Stream #0:1: Video: png (attached pic)", "    Metadata:", "      title           : Album cover"].join("\n");
    assert.deepEqual(parseTags(cover, "C:/x/Artist Name - Song Name.mp3"), { artist: "Artist Name", title: "Song Name" });
    assert.deepEqual(parseTags("", "C:/Songs/123456 Some One - Some Song/audio.mp3"), { artist: "Some One", title: "Some Song" });
    assert.deepEqual(parseTags("", "C:/music/just a name.ogg"), { artist: "", title: "just a name" });
});

test("probeTags reads the tags of a real file through ffmpeg; a file it cannot read falls back to the name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "теги "));
    const output = path.join(dir, "песня.mp3");
    await new Promise((resolve, reject) => execFile(ffmpegStatic, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "1",
        "-metadata", "title=Тестовая песня", "-metadata", "artist=Some Band", "-codec:a", "libmp3lame", output], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
    assert.deepEqual(await probeTags(ffmpegStatic, output), { artist: "Some Band", title: "Тестовая песня" });
    assert.deepEqual(await probeTags(ffmpegStatic, path.join(dir, "Nobody - Missing.mp3")), { artist: "Nobody", title: "Missing" });
});
