import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseParams, previewStretch, normalizeName, findAudio, chooseOsu, readOszMaps, readAudio, PREVIEW_TAIL_MS } from "../../../extension/player/source.js";
import { parseChart } from "../../../extension/player/chart.js";
import { readZip } from "../../../extension/shared/osz.js";
import { md5Hex } from "../../../extension/shared/md5.js";
import { buildOsz } from "../../../src/gen/osz.js";
import { makeChart } from "../../fixtures/makeChart.js";

const md5 = (s) => createHash("md5").update(s).digest("hex");
const withMeta = (text, { id, version, audio = "audio.mp3", keys = 4, mode = 3 } = {}) => text
    .replace("AudioFilename: audio.mp3", `AudioFilename: ${audio}`)
    .replace("Mode: 3", `Mode: ${mode}`)
    .replace(/Version:.*/, `Version:${version}\r\nBeatmapID:${id}`)
    .replace(/CircleSize:\d+/, `CircleSize:${keys}`);

test("params from the hash, with safe fallbacks", () => {
    const p = parseParams("#set=2316993&map=4961226&src=full&rate=1.2&lang=ru&checksum=18E40E4DDCBD746C9577E25E73F04D4A&login=0&previewWarn=1");
    assert.deepEqual(p, { set: 2316993, map: 4961226, src: "full", rate: 1.2, lang: "ru", checksum: "18e40e4ddcbd746c9577e25e73f04d4a", login: false, previewWarn: true });
    const q = parseParams("#set=x&map=-1&src=evil&rate=9&checksum=zz&login=", "uk-UA");
    assert.deepEqual(q, { set: null, map: null, src: "preview", rate: null, lang: "ru", checksum: null, login: null, previewWarn: false });
    assert.equal(parseParams("", "de").lang, "en");
    assert.equal(parseParams("#login=1").login, true);
    assert.equal(parseParams("#rate=0.85").rate, 0.85);
});

test("preview stretch: heads in [PreviewTime, PreviewTime + duration − 300 ms], LNs past the end dropped", () => {
    const notes = [
        { col: 0, t: 13000, end: null }, // before
        { col: 1, t: 13805, end: null }, // at the start: kept
        { col: 2, t: 18000, end: 19000 }, // LN inside: kept
        { col: 3, t: 23000, end: 23700 }, // LN tail past 23805 − 300: dropped
        { col: 0, t: 23505, end: null }, // exactly at the end: kept
        { col: 1, t: 23506, end: null }, // after: dropped
    ];
    const s = previewStretch(notes, 13805, 10);
    assert.equal(PREVIEW_TAIL_MS, 300);
    assert.equal(s.startMs, 13805);
    assert.equal(s.endMs, 23805);
    assert.deepEqual(s.notes.map((n) => n.t), [13805, 18000, 23505]);
    assert.equal(previewStretch(notes, 13805, 0).notes.length, 0);
});

test("audio by AudioFilename: case-insensitive, \\ = /, bare name as a last resort", () => {
    const entries = [{ name: "Sub/Song.mp3" }, { name: "bg.jpg" }, { name: "other/hit.wav" }, { name: "x/HIT.wav" }];
    assert.equal(normalizeName(".\\Sub\\SONG.mp3"), "sub/song.mp3");
    assert.equal(findAudio(entries, "Sub\\song.MP3").name, "Sub/Song.mp3");
    assert.equal(findAudio(entries, "song.mp3").name, "Sub/Song.mp3");
    assert.equal(findAudio(entries, "hit.wav"), null); // two candidates: no guess
    assert.equal(findAudio(entries, "missing.ogg"), null);
    assert.equal(findAudio(entries, ""), null);
});

function maps(list) {
    return list.map(({ name, text }) => ({ name, md5: md5(text), text, chart: parseChart(text) }));
}

test("which .osu: BeatmapID, else MD5, else the only 4K mania one, else a list", () => {
    const a = withMeta(makeChart({ seconds: 5 }), { id: 11, version: "A" });
    const b = withMeta(makeChart({ seconds: 6 }), { id: 12, version: "B" });
    const seven = withMeta(makeChart({ seconds: 5, keys: 7 }), { id: 13, version: "7K", keys: 7 });
    const all = maps([{ name: "a.osu", text: a }, { name: "b.osu", text: b }, { name: "c.osu", text: seven }]);
    assert.equal(chooseOsu(all, { map: 12 }).pick.name, "b.osu");
    assert.equal(chooseOsu(all, { map: 12 }).by, "id");
    assert.equal(chooseOsu(all, { map: 99, checksum: md5(a) }).pick.name, "a.osu");
    assert.equal(chooseOsu(all, { map: 99, checksum: md5(a) }).by, "md5");
    assert.deepEqual(chooseOsu(all, { map: 99 }).choices.map((m) => m.name), ["a.osu", "b.osu"]);
    const one = maps([{ name: "b.osu", text: b }, { name: "c.osu", text: seven }]);
    assert.equal(chooseOsu(one, { map: 99 }).by, "only");
    assert.equal(chooseOsu(one, {}).pick.name, "b.osu");
    assert.deepEqual(chooseOsu(maps([{ name: "c.osu", text: seven }]), {}), { none: true });
});

test("a real .osz (src/gen/osz.js) through the core zip reader: map, md5 and audio", async () => {
    const a = withMeta(makeChart({ seconds: 5 }), { id: 21, version: "Easy", audio: "Song.OGG" });
    const b = withMeta(makeChart({ seconds: 8, kind: "jumpstream" }), { id: 22, version: "Hard", audio: "Song.OGG" });
    const audio = Buffer.from("OggS fake audio bytes");
    const osz = buildOsz([
        { name: "Artist - Title (Mapper) [Easy].osu", data: Buffer.from(a) },
        { name: "Artist - Title (Mapper) [Hard].osu", data: Buffer.from(b) },
        { name: "song.ogg", data: audio },
        { name: "bg.jpg", data: Buffer.from([1, 2, 3]) },
    ]);
    const read = await readOszMaps(new Uint8Array(osz), { readZip, md5Hex });
    assert.equal(read.ok, true);
    assert.equal(read.maps.length, 2);
    assert.equal(read.maps[1].md5, md5(b));
    const byChecksum = chooseOsu(read.maps, { map: 999, checksum: md5(b) });
    assert.equal(byChecksum.pick.chart.version, "Hard");
    const byId = chooseOsu(read.maps, { map: 21 });
    assert.equal(byId.pick.chart.version, "Easy");
    const sound = await readAudio(read.entries, byId.pick.chart);
    assert.equal(sound.ok, true);
    assert.equal(sound.name, "song.ogg");
    assert.deepEqual(Buffer.from(sound.bytes), audio);
    const noAudio = buildOsz([{ name: "x.osu", data: Buffer.from(a) }]);
    const r2 = await readOszMaps(new Uint8Array(noAudio), { readZip, md5Hex });
    assert.deepEqual(await readAudio(r2.entries, r2.maps[0].chart), { ok: false, code: "no-audio", name: "Song.OGG" });
});

test("not a zip, or a zip without .osu", async () => {
    assert.deepEqual(await readOszMaps(new Uint8Array([1, 2, 3, 4, 5]), { readZip, md5Hex }), { ok: false, code: "not-zip" });
    const onlyAudio = buildOsz([{ name: "song.ogg", data: Buffer.from("x") }]);
    assert.deepEqual(await readOszMaps(new Uint8Array(onlyAudio), { readZip, md5Hex }), { ok: false, code: "no-chart" });
});
