import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    convertSimfile, parseMsd, parseNoteData, buildClock, decodeSimfile, osuFileName,
} from "../../tools/lib/sm2osu.mjs";
import { processPackZip, msdLookup, selectPacks, packDownloadUrl, parseSize, parseArgs, fitName } from "../../tools/fetch-etterna-packs.mjs";
import { parseRows } from "../../src/gen/mapRows.js";
import { parseRedTimingPoints } from "../../src/gen/grid.js";
import { makeZip } from "./fixtures/makeZip.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "etterna");
const fixture = (name) => readFile(path.join(FIX, name), "utf8");

// [{ col, t, end }] from the [HitObjects] of an .osu text
function objects(osu) {
    const lines = osu.split(/\r?\n/);
    const at = lines.indexOf("[HitObjects]");
    return lines.slice(at + 1).filter((l) => l.includes(",")).map((l) => {
        const p = l.split(",");
        const ln = (Number(p[3]) & 128) !== 0;
        return { col: Math.floor((Number(p[0]) * 4) / 512), t: Number(p[2]), end: ln ? Number(p[5].split(":")[0]) : null };
    });
}
function redLines(osu) {
    const lines = osu.split(/\r?\n/);
    const at = lines.indexOf("[TimingPoints]");
    return lines.slice(at + 1, lines.indexOf("", at + 1)).map((l) => l.split(",").map(Number)).map((p) => ({ t: p[0], beat: p[1], red: p[6] }));
}
const field = (osu, name) => new RegExp(`^${name}:\\s*(.*?)\\r?$`, "m").exec(osu)?.[1];
function near(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: ${JSON.stringify(actual)}`);
    expected.forEach((e, i) => {
        const a = actual[i];
        assert.equal(a.col, e.col, `${label} #${i} column`);
        assert.ok(Math.abs(a.t - e.t) <= 1, `${label} #${i}: ${a.t} ms, expected ${e.t}`);
        if (e.end === null || e.end === undefined) assert.equal(a.end, null, `${label} #${i} should be a tap`);
        else assert.ok(a.end !== null && Math.abs(a.end - e.end) <= 1, `${label} #${i}: hold end ${a.end}, expected ${e.end}`);
    });
}

test("sm: offset, BPM change, stop, 12ths/24ths, holds and rolls land on exact milliseconds", async () => {
    const res = convertSimfile(await fixture("timing.sm"), { ext: ".sm" });
    assert.equal(res.kind, "sm");
    assert.equal(res.song.music, "Audio.OGG");
    const [challenge, hard, double, empty] = res.charts;
    assert.equal(challenge.ok, true, challenge.reason);
    assert.equal(challenge.version, "Challenge 24");
    assert.equal(challenge.creator, "Charter A");
    // beat 0 at 100 ms, 500 ms a beat; the stop on beat 4 (0.5 s) comes after its notes; 240 BPM from beat 8
    near(objects(challenge.osu), [
        { col: 0, t: 100 }, { col: 1, t: 600 }, { col: 2, t: 1100 }, { col: 3, t: 1600 },
        { col: 0, t: 2100, end: 3600 }, // hold over the stop
        { col: 0, t: 4600 }, { col: 1, t: 4683.33 }, { col: 2, t: 4766.67 }, { col: 3, t: 4850 }, // 12ths
        { col: 0, t: 5600 }, { col: 1, t: 5641.67 }, { col: 2, t: 5808.33 }, // 24ths
        { col: 0, t: 6600, end: 7100 }, // roll; the lift, fake, mine and headless tail are gone
    ], "challenge");
    assert.deepEqual(redLines(challenge.osu), [
        { t: 100, beat: 500, red: 1 }, { t: 2600, beat: 500, red: 1 }, { t: 4600, beat: 250, red: 1 },
    ]);
    assert.equal(challenge.stats.strayTails, 1);
    assert.equal(challenge.stats.holds, 2);

    assert.equal(hard.ok, true, hard.reason);
    assert.equal(hard.version, "Hard 12");
    assert.equal(hard.creator, "Pack Maker"); // empty description → the song's #CREDIT
    near(objects(hard.osu), [
        { col: 0, t: 100 }, { col: 1, t: 131.25 }, { col: 3, t: 2068.75 }, // 64ths
        { col: 0, t: 2100 }, // hold head cut short by a tap in its column: a tap, as in StepMania
        { col: 1, t: 2610.42 }, { col: 0, t: 3600 }, { col: 2, t: 4589.58 }, // 192nds after the stop; last head never closed
        { col: 3, t: 4600 }, { col: 1, t: 5579.17 }, // 48ths at 240 BPM
    ], "hard");
    assert.equal(hard.stats.cancelledHolds, 1);
    assert.equal(hard.stats.unclosedHolds, 1);

    assert.equal(double.ok, false);
    assert.equal(double.code, "stepsType");
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "noNotes");

    for (const osu of [challenge.osu, hard.osu]) {
        assert.equal(field(osu, "Mode"), "3");
        assert.equal(field(osu, "CircleSize"), "4");
        assert.equal(field(osu, "OverallDifficulty"), "8");
        assert.equal(field(osu, "HPDrainRate"), "8");
        assert.equal(field(osu, "AudioFilename"), "Audio.OGG");
        assert.equal(field(osu, "Title"), "Fixture Song");
        assert.equal(field(osu, "Artist"), "Fixture Artist");
        assert.equal(field(osu, "PreviewTime"), "10500");
    }
});

test("ssc: per-chart offset/BPMs/delays replace the song's timing; warps and fakes are skipped with a reason", async () => {
    const res = convertSimfile(await fixture("split.ssc"), { ext: ".ssc", audioFilename: "Track.mp3" });
    assert.equal(res.kind, "ssc");
    const [songTiming, own, warps, fakes, scrolls, pump] = res.charts;
    assert.equal(songTiming.ok, true, songTiming.reason);
    assert.equal(songTiming.version, "Challenge 20");
    assert.equal(songTiming.creator, "Chart Credit");
    assert.equal(field(songTiming.osu, "Title"), "SSC Song Translit");
    assert.equal(field(songTiming.osu, "TitleUnicode"), "SSC Song");
    assert.equal(field(songTiming.osu, "AudioFilename"), "Track.mp3");
    // 60 BPM, offset 0, the song's stop of 0.25 s after beat 1
    near(objects(songTiming.osu), [{ col: 0, t: 0 }, { col: 1, t: 1000 }, { col: 2, t: 2250 }, { col: 3, t: 3250 }], "song timing");
    assert.deepEqual(redLines(songTiming.osu).map((p) => [p.t, p.beat]), [[0, 1000], [1250, 1000]]);

    assert.equal(own.ok, true, own.reason);
    assert.equal(own.version, "Split Timing 21"); // an Edit is named by its description
    assert.equal(own.creator, "Song Credit");
    assert.equal(own.ownTiming, true);
    // its own offset -0.05 and 150 BPM, a 0.25 s delay BEFORE beat 2, 100 BPM from beat 4; the song's stop is not used
    near(objects(own.osu), [{ col: 0, t: 50 }, { col: 1, t: 450 }, { col: 0, t: 1100 }, { col: 1, t: 1500 }, { col: 3, t: 1900 }], "own timing");
    assert.deepEqual(redLines(own.osu).map((p) => [p.t, p.beat]), [[50, 400], [1100, 400], [1900, 600]]);

    assert.equal(warps.ok, false);
    assert.equal(warps.code, "warps");
    assert.equal(fakes.ok, false);
    assert.equal(fakes.code, "fakes");
    assert.equal(scrolls.ok, true, scrolls.reason); // scroll speed is visual only: the notes keep their times
    assert.deepEqual(scrolls.visual, ["scrolls"]);
    near(objects(scrolls.osu), [{ col: 0, t: 0 }, { col: 1, t: 0 }, { col: 2, t: 0 }, { col: 3, t: 0 }], "quad");
    assert.equal(pump.ok, false);
    assert.equal(pump.code, "stepsType");
});

test("negative BPMs (warps written as tempo) skip the chart", async () => {
    const res = convertSimfile(await fixture("warp.sm"), { ext: ".sm" });
    assert.equal(res.charts.length, 1);
    assert.equal(res.charts[0].ok, false);
    assert.equal(res.charts[0].code, "negativeBpm");
});

test("the project's own .osu readers see the same notes and red lines", async () => {
    const res = convertSimfile(await fixture("timing.sm"), { ext: ".sm" });
    const osu = res.charts[0].osu;
    const rows = parseRows(osu, 4);
    assert.equal(rows[0].t, 100);
    assert.equal(rows[0].mask, 1);
    assert.deepEqual(parseRedTimingPoints(osu).map((p) => [p.time, p.beatLength]), [[100, 500], [2600, 500], [4600, 250]]);
});

test("stop and BPM change on one beat: the notes on it come first, the new tempo starts after the pause", () => {
    const clock = buildClock({ offset: "0", bpms: "0=120,4=60", stops: "4=1" });
    assert.equal(clock.timeAt(4 * 48), 2); // beat 4 itself, before the stop
    assert.equal(clock.timeAt(5 * 48), 2 + 1 + 1); // one 60 BPM beat after a 1 s stop
    assert.deepEqual(clock.redLines.map((l) => [l.sec, l.bpm]), [[0, 120], [3, 60]]);
    // a delay on beat 2 moves the notes on beat 2 too
    const d = buildClock({ offset: "0", bpms: "0=60", delays: "2=0.5" });
    assert.equal(d.timeAt(96), 2.5);
    assert.equal(d.timeAt(95), 95 / 48);
    assert.throws(() => buildClock({ bpms: "0=120", stops: "1=-0.5" }), (e) => e.code === "negativeStop");
    assert.throws(() => buildClock({ bpms: "0=0" }), (e) => e.code === "zeroBpm");
    assert.throws(() => buildClock({ bpms: "0=120,1=99999" }), (e) => e.code === "extremeBpm");
    assert.throws(() => buildClock({ bpms: "" }), (e) => e.code === "noBpms");
});

test("MSD reader: comments, escapes and a missing semicolon", () => {
    const tags = parseMsd("#TITLE:A\\;B // comment\n;\n#ARTIST:X\n#MUSIC:a.ogg;");
    assert.deepEqual(tags.map((t) => [t.name, t.params.map((p) => p.trim())]), [["TITLE", ["A;B"]], ["ARTIST", ["X"]], ["MUSIC", ["a.ogg"]]]);
});

test("note rows: any subdivision maps onto the 48-per-beat grid; a 5-wide row in a 4K chart is refused", () => {
    const seven = parseNoteData(["1000", ...Array(6).fill("0000")].join("\n") + "\n,\n" + ["0000", "0001", ...Array(5).fill("0000")].join("\n"));
    assert.deepEqual(seven.taps.map((n) => n.row), [0, 192 + Math.round(192 / 7)]);
    assert.throws(() => parseNoteData("10000\n0000\n0000\n0000"), (e) => e.code === "rowWidth");
});

test("simfile bytes: BOM dropped, Shift-JIS read as such", () => {
    assert.equal(decodeSimfile(Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x41])), "#A");
    const sjis = Buffer.from([0x23, 0x54, 0x49, 0x54, 0x4c, 0x45, 0x3a, 0x93, 0xfa, 0x96, 0x7b, 0x3b]); // #TITLE:日本;
    assert.equal(decodeSimfile(sjis), "#TITLE:日本;");
    assert.equal(osuFileName({ artist: "A/B", title: "T?", creator: "C", version: "Hard 12" }), "A_B - T_ (C) [Hard 12].osu");
});

test("pack zip → one folder per song with audio, simfiles and .osu files; duplicates, gimmicks and unsafe names left out", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "eo-pack-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sm = await fixture("timing.sm");
    const ssc = await fixture("split.ssc");
    const warp = await fixture("warp.sm");
    const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(5000, 7)]);
    const zipFile = path.join(root, "99.zip");
    await writeFile(zipFile, makeZip([
        { name: "Fixture Pack/Song A/timing.sm", data: sm },
        { name: "Fixture Pack/Song A/audio.ogg", data: ogg },
        { name: "Fixture Pack/Song A/preview.mp3", data: Buffer.alloc(100, 1) },
        { name: "Fixture Pack/Song A/bg.png", data: Buffer.alloc(100, 2) },
        { name: "Fixture Pack/Song B/split.ssc", data: ssc, method: 0 },
        { name: "Fixture Pack/Song B/split.sm", data: warp },
        { name: "Fixture Pack/Song B/Track.mp3", data: Buffer.alloc(3000, 3) },
        { name: "Fixture Pack/Song C/dupe.sm", data: sm },
        { name: "Fixture Pack/Song C/x.ogg", data: ogg },
        { name: "Fixture Pack/Song D/warp.sm", data: warp },
        { name: "Fixture Pack/Song D/warp.ogg", data: ogg },
        { name: "Fixture Pack/Song E/noaudio.sm", data: sm.replace("Fixture Song", "Silent Song") },
        // its own notes, but a damaged audio entry: only this song is lost
        { name: "Fixture Pack/Song F/f.sm", data: "#TITLE:Broken;#ARTIST:X;#MUSIC:f.ogg;#OFFSET:0;#BPMS:0=100;\n#NOTES:dance-single::Hard:3::\n1000\n0100\n0010\n0001\n;" },
        { name: "Fixture Pack/Song F/f.ogg", data: ogg, crc: 1234 },
        { name: "../evil.ogg", data: ogg },
        { name: "Fixture Pack/../../evil.sm", data: sm },
    ]));
    const songsRoot = path.join(root, "songs");
    const apiSongs = [{ id: 7, name: "Fixture Song", artist: "Fixture Artist", difficulties: [{ name: "Challenge", msd: "24.7335", keys: 4 }, { name: "Hard", msd: "12.5", keys: 4 }] }];
    const m = await processPackZip(zipFile, { id: 99, name: "Fixture Pack", songs: 5 }, { songsRoot, apiSongs, seen: new Map() });

    assert.deepEqual((await readdir(songsRoot)).sort(), ["99 Song A", "99 Song B"]);
    const a = (await readdir(path.join(songsRoot, "99 Song A"))).sort();
    assert.deepEqual(a.filter((f) => !f.endsWith(".osu")), ["audio.ogg", "timing.sm"]);
    const osuA = a.filter((f) => f.endsWith(".osu"));
    assert.equal(osuA.length, 2);
    for (const f of osuA) {
        const text = await readFile(path.join(songsRoot, "99 Song A", f), "utf8");
        assert.equal(field(text, "AudioFilename"), "audio.ogg"); // #MUSIC "Audio.OGG" matched without case
    }
    assert.deepEqual(await readFile(path.join(songsRoot, "99 Song A", "audio.ogg")), ogg);
    const b = (await readdir(path.join(songsRoot, "99 Song B"))).sort();
    assert.deepEqual(b.filter((f) => !f.endsWith(".osu")), ["Track.mp3", "split.sm", "split.ssc"]); // .ssc used, .sm kept
    assert.equal(b.filter((f) => f.endsWith(".osu")).length, 3);
    assert.deepEqual(await readdir(root).then((l) => l.filter((f) => f.startsWith("evil"))), []);

    assert.equal(m.totals.songsWritten, 2);
    assert.equal(m.totals.chartsConverted, 5);
    assert.equal(m.totals.reasons.duplicate, 2);
    assert.equal(m.totals.reasons.negativeBpm, 1);
    assert.equal(m.totals.reasons.noAudio, 1);
    assert.equal(m.totals.reasons.warps, 1);
    assert.equal(m.totals.reasons.fakes, 1);
    assert.equal(m.totals.reasons.badAudio, 1);
    assert.ok(m.skippedSongs.some((s) => s.dir === "Fixture Pack/Song F" && /CRC/.test(s.reason)));
    const songA = m.songs.find((s) => s.folder === "99 Song A");
    assert.deepEqual(songA.charts.map((c) => [c.version, c.msd]), [["Challenge 24", 24.73], ["Hard 12", 12.5]]);
    assert.ok(m.skippedSongs.some((s) => /unsafe/.test(s.reason)));
});

// a tiny 4K simfile: its own title, audio and notes
const tinySm = (title, music, rows) => `#TITLE:${title};#ARTIST:X;#MUSIC:${music};#OFFSET:0;#BPMS:0=100;\n#NOTES:dance-single::Hard:3::\n${rows.join("\n")}\n;`;
const oggOf = (n) => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(3000 + n, n)]);

test("flat pack: several songs in one folder each get the audio their own #MUSIC names", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "eo-flat-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const zipFile = path.join(root, "1.zip");
    await writeFile(zipFile, makeZip([
        { name: "Pack/one.sm", data: tinySm("One", "one.ogg", ["1000", "0100", "0010", "0001"]) },
        { name: "Pack/one.ogg", data: oggOf(1) },
        { name: "Pack/two.sm", data: tinySm("Two", "two.ogg", ["0001", "0010", "0100", "1000"]) },
        { name: "Pack/two.ogg", data: oggOf(2) },
        // the same song again in another simfile (an edit): it joins "one", not a folder of its own
        { name: "Pack/one-edit.sm", data: tinySm("One", "ONE.ogg", ["1001", "0110", "1001", "0110"]) },
        // no #MUSIC, but an audio file of its own name
        { name: "Pack/three.sm", data: tinySm("Three", "", ["1100", "0011", "1100", "0011"]) },
        { name: "Pack/three.mp3", data: Buffer.alloc(2000, 3) },
        // names an audio that is not there: with several audio files nothing is guessed
        { name: "Pack/four.sm", data: tinySm("Four", "missing.ogg", ["1010", "0101", "1010", "0101"]) },
    ]));
    const songsRoot = path.join(root, "songs");
    const m = await processPackZip(zipFile, { id: 1, name: "Flat" }, { songsRoot, seen: new Map() });
    assert.deepEqual((await readdir(songsRoot)).sort(), ["1 Pack - one", "1 Pack - three", "1 Pack - two"]);
    const expect = { "1 Pack - one": ["one.ogg", 2], "1 Pack - two": ["two.ogg", 1], "1 Pack - three": ["three.mp3", 1] };
    for (const [folder, [audio, charts]] of Object.entries(expect)) {
        const list = await readdir(path.join(songsRoot, folder));
        assert.deepEqual(list.filter((f) => /\.(ogg|mp3)$/.test(f)), [audio], folder);
        const osu = list.filter((f) => f.endsWith(".osu"));
        assert.equal(osu.length, charts, folder);
        for (const f of osu) assert.equal(field(await readFile(path.join(songsRoot, folder, f), "utf8"), "AudioFilename"), audio, `${folder}/${f}`);
    }
    assert.deepEqual(await readFile(path.join(songsRoot, "1 Pack - two", "two.ogg")), oggOf(2));
    assert.deepEqual((await readdir(path.join(songsRoot, "1 Pack - one"))).filter((f) => f.endsWith(".sm")).sort(), ["one-edit.sm", "one.sm"]);
    assert.deepEqual((await readdir(path.join(songsRoot, "1 Pack - two"))).filter((f) => f.endsWith(".sm")), ["two.sm"]);
    assert.equal(m.totals.reasons.noAudio, 1);
    assert.ok(m.skippedSongs.some((s) => /^four: audio "missing\.ogg" is not in the pack/.test(s.reason)));
});

test("two lanes: a chart another lane is still writing is waited for, and taken if that song loses its audio", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "eo-lanes-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const shared = tinySm("Shared", "s.ogg", ["1000", "0100", "0010", "0001"]);
    const zipA = path.join(root, "1.zip");
    const zipB = path.join(root, "2.zip");
    await writeFile(zipA, makeZip([{ name: "A/S/s.sm", data: shared }, { name: "A/S/s.ogg", data: oggOf(5), crc: 1234 }]));
    await writeFile(zipB, makeZip([{ name: "B/S/s.sm", data: shared }, { name: "B/S/s.ogg", data: oggOf(5) }]));
    const probe = await processPackZip(zipB, { id: 2 }, { songsRoot: path.join(root, "probe"), seen: new Map() });
    const hash = probe.songs[0].charts[0].hash;

    // a claim that is not settled yet holds the other lane back; given back, the chart is taken
    for (const keep of [false, true]) {
        const seen = new Map();
        let release;
        const claim = { pack: 1, where: "1 S [Hard 3]", settled: new Promise((r) => { release = r; }) };
        seen.set(hash, claim);
        let finished = false;
        const run = processPackZip(zipB, { id: 2 }, { songsRoot: path.join(root, `wait-${keep}`), seen }).finally(() => { finished = true; });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(finished, false, "the lane went on before the claim was settled");
        if (keep) delete claim.settled;
        else seen.delete(hash);
        release();
        const m = await run;
        assert.equal(m.totals.chartsConverted, keep ? 0 : 1);
        assert.equal(m.totals.reasons.duplicate ?? 0, keep ? 1 : 0);
        assert.equal(seen.get(hash).pack, keep ? 1 : 2);
        assert.equal(seen.get(hash).settled, undefined);
    }

    // both packs at once, either order: the chart ends up once, in the pack whose audio is whole
    const lanes = [[zipA, { id: 1 }], [zipB, { id: 2 }]];
    for (const order of [lanes, [...lanes].reverse()]) {
        const seen = new Map();
        const songsRoot = path.join(root, `both-${order[0][1].id}`);
        const results = await Promise.all(order.map(([file, pack]) => processPackZip(file, pack, { songsRoot, seen })));
        assert.equal(results.reduce((s, m) => s + m.totals.chartsConverted, 0), 1);
        assert.equal(seen.get(hash).pack, 2);
        assert.equal(seen.get(hash).settled, undefined);
        assert.deepEqual(await readdir(songsRoot), ["2 S"]);
    }
});

test("pack list: 4K-tagged packs with enough songs, smallest first on request; download links encoded and host-checked", () => {
    const packs = [
        { id: 1, name: "Big", song_count: 300, size: "2.5 GB", tags: [{ type: "keyCount", name: "4k" }], download: "https://downloads.etternaonline.com/ranked/Big.zip" },
        { id: 2, name: "Small", song_count: 120, size: "609.6 MB", tags: [{ type: "keyCount", name: "4k" }] },
        { id: 3, name: "Few", song_count: 20, size: "10 MB", tags: [{ type: "keyCount", name: "4k" }] },
        { id: 4, name: "Seven", song_count: 500, size: "1 GB", tags: [{ type: "keyCount", name: "7k" }] },
    ];
    assert.deepEqual(selectPacks(packs, { minSongs: 100 }).map((p) => p.id), [1, 2]);
    assert.deepEqual(selectPacks(packs, { minSongs: 100, smallestFirst: true }).map((p) => p.id), [2, 1]);
    assert.equal(parseSize("609.6 MB"), Math.round(609.6 * 1024 * 1024));
    assert.equal(packDownloadUrl("https://downloads.etternaonline.com/ranked/Super Polska Chordjack #1.zip"),
        "https://downloads.etternaonline.com/ranked/Super%20Polska%20Chordjack%20%231.zip");
    assert.equal(packDownloadUrl("https://evil.example/ranked/x.zip"), null);
    assert.equal(packDownloadUrl("http://downloads.etternaonline.com/ranked/x.zip"), null);
    const lookup = msdLookup([{ name: "Song", artist: "Art", difficulties: [{ name: "Edit", msd: "20" }, { name: "Edit", msd: "22.456" }] }]);
    assert.equal(lookup("song", "ART", "Edit", 1).msd, 22.46);
    const dir = "A:/x".padEnd(200, "y");
    const short = fitName(dir, `${"long name ".repeat(10)}[Hard 12].osu`);
    assert.ok(dir.length + 1 + short.length <= 240 && short.endsWith(".osu"), short);
    assert.equal(fitName("A:/x", "a.osu"), "a.osu");
    assert.deepEqual(parseArgs(["out", "--min-songs=50", "--limit", "1", "--smallest-first", "--lanes", "9"]),
        { _: ["out"], minSongs: 50, limit: 1, lanes: 3, smallestFirst: true, list: false, refreshList: false });
});

