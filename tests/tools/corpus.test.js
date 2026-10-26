import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    toRows, chartKey, rateFromText, songKey, songKeyAlts, isPackLike, readCsv, buildCorpus, parseArgs, run, danBin,
} from "../../tools/corpus-index.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");
const quiet = () => {};

function rowsOf(seed, { rate = 1, mirror = false, offset = 0 } = {}) {
    let s = seed;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const objs = [];
    let t = 1000;
    for (let i = 0; i < 300; i++) {
        const cols = rnd() < 0.25 ? [0, 2] : [Math.floor(rnd() * 4)];
        for (const c of cols) objs.push({ x: ((mirror ? 3 - c : c) + 0.5) * 128, t: Math.round(t / rate) + offset, ln: false });
        t += [107.14, 107.14, 214.29, 53.57, 71.43][Math.floor(rnd() * 5)];
    }
    return toRows(objs);
}

test("chart key ignores rate, offset and column mirror, but not a different chart", () => {
    const base = chartKey(rowsOf(7));
    assert.match(base, /^[0-9a-f]{24}$/);
    for (const rate of [0.9, 1.1, 1.25, 1.5, 1.75]) assert.equal(chartKey(rowsOf(7, { rate })), base, `rate ${rate}`);
    assert.equal(chartKey(rowsOf(7, { mirror: true })), base);
    assert.equal(chartKey(rowsOf(7, { mirror: true, rate: 1.3, offset: 51 })), base);
    assert.notEqual(chartKey(rowsOf(8)), base);
});

test("rows merge chords within 1 ms and map x to columns", () => {
    const rows = toRows([{ x: 64, t: 100 }, { x: 448, t: 101 }, { x: 192, t: 200 }]);
    assert.deepEqual(rows, [{ t: 100, mask: 0b1001 }, { t: 200, mask: 0b0010 }]);
});

test("rate from version / file text", () => {
    assert.equal(rateFromText("Hard 1.2x"), 1.2);
    assert.equal(rateFromText("[PORTTAYER] Marisa Nouigai x1.5 (High)"), 1.5);
    assert.equal(rateFromText("Insane [1.25x]"), 1.25);
    assert.equal(rateFromText("Insane (1,1x Rate)"), 1.1);
    assert.equal(rateFromText("13_1_1x.mp3"), 1.1);
    assert.equal(rateFromText("01-dragonforce-holding_on 1.730x.mp3"), 1.73);
    assert.equal(rateFromText("Rate 1.3"), 1.3);
    assert.equal(rateFromText("[4K] Calm"), null);
    assert.equal(rateFromText("Lv.10x Extreme"), null);
    assert.equal(rateFromText("Stage 4"), null);
    assert.equal(rateFromText("Aquaris (hard part only & repeated 3x, snoverpk)"), null);
    assert.equal(rateFromText("Collab x2"), null);
    assert.equal(rateFromText("Insane [2x]"), 2);
    assert.equal(rateFromText("DJ! DJ!!!  0.55x  alpha--"), 0.55);
});

test("song key drops rate, speed-up, cut markers and featured artists", () => {
    const k = songKey({ artist: "Camellia", title: "Fastest Crash" });
    assert.equal(k, "camellia|fastestcrash");
    assert.equal(songKey({ artist: "Camellia", title: "Fastest Crash (Speed Up)" }), k);
    assert.equal(songKey({ artist: "Camellia", title: "Fastest Crash [1.2x]" }), k);
    assert.equal(songKey({ artist: "Camellia", title: "Fastest Crash (Cut Ver.)" }), k);
    assert.equal(songKey({ artist: "Camellia", title: "Fastest Crash (TV Size) x1.1" }), k);
    assert.equal(songKey({ artist: "Camellia feat. Nanahira", title: "Fastest Crash" }), k);
    assert.notEqual(songKey({ artist: "Camellia", title: "Fastest Crash (Cranky Remix)" }), k);
    assert.ok(isPackLike("Various Artists", "Dan ~ REFORM ~ Finalmaps"));
    assert.ok(isPackLike("Beajek", "Eta Stamina Practice Pack"));
    assert.equal(songKey({ artist: "Various Artists", title: "Pack", version: "[PORTTAYER] Marisa Nouigai x1.5 (High)" }), "p:marisanouigai");
    assert.equal(songKey({ artist: "Various Artists", title: "Other Pack", version: "[Beajek] Marisa Nouigai (Mid)" }), "p:marisanouigai");
    assert.equal(songKey({ artist: "Various Artists", title: "Vocaloid Chordjack Pack Vol1", version: "Electric Angel ([Crz]Rachel)" }), "p:electricangel");
    assert.equal(songKey({ artist: "Various Artists", title: "Pack", version: "fake doll feat. Hatsune Miku (Ice V)" }), "p:fakedoll");
});

test("csv reader handles quotes, escaped quotes, commas and CRLF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-csv-"));
    try {
        const f = path.join(dir, "x.csv");
        await writeFile(f, 'a,b,c\r\n1,"x, ""y""",3\r\n2,"multi\nline",\r\n');
        const rows = [];
        await readCsv(f, (r) => rows.push(r));
        assert.deepEqual(rows, [["a", "b", "c"], ["1", 'x, "y"', "3"], ["2", "multi\nline", ""]]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

function fakeChart(i, extra = {}) {
    return {
        source: "sets", osu: `S:/sets/${i}/x.osu`, folder: String(i), audio: `S:/sets/${i}/a.mp3`, audioKey: `a${i}`,
        md5: `m${i}`, beatmapId: 10_000 + i, artist: `Artist ${i}`, title: `Song ${i}`, version: "Hard",
        chartKey: `c${i}`, spanMs: 100_000, textRate: null, ...extra,
    };
}

test("split: seeds, ~4% extra per dan bin, sticky song keys", () => {
    const charts = Array.from({ length: 400 }, (_, i) => fakeChart(i));
    const tracker = new Map(charts.map((c, i) => [c.beatmapId, { rawDan: i < 200 ? 3.5 : 9.2, msd: null }]));
    const ctx = {
        tracker, hfMeta: { byId: new Map(), byMd5: new Map() }, etterna: new Map(),
        heldoutFolders: new Set(["5"]), stickySongKeys: new Set(), extraHeldout: 0.04, seed: "t",
    };
    const res = buildCorpus(charts.map((c) => ({ ...c })), ctx);
    const held = res.groups.filter((g) => g.split === "heldout");
    assert.equal(held.filter((g) => g.reason === "seed").length, 1);
    assert.equal(held.filter((g) => g.bin === "dan:03" && g.reason === "extra").length, 8);
    assert.equal(held.filter((g) => g.bin === "dan:09" && g.reason === "extra").length, 8);
    // sticky: a previously held-out song stays held out even with no extra share
    const sticky = new Set(held.filter((g) => g.reason === "extra").map((g) => g.key));
    const again = buildCorpus(charts.map((c) => ({ ...c })), { ...ctx, extraHeldout: 0, stickySongKeys: sticky });
    assert.deepEqual(new Set(again.groups.filter((g) => g.split === "heldout" && g.reason !== "seed").map((g) => g.key)), sticky);
    assert.equal(danBin({ rawDan: null, etternaMsd: 17.1 }), "msd:16");
});

async function fixtureRun(dir, extra = []) {
    const out = path.join(dir, "out", "corpus.jsonl");
    const root = path.join(dir, "fx");
    const opts = parseArgs([out, "--workers", "2",
        "--songs", path.join(root, "songs"), "--sets", path.join(root, "sets"), "--hf", path.join(root, "hf"),
        "--packs", path.join(root, "packs"), "--etterna", path.join(root, "etterna", "songs"),
        "--manifest", path.join(root, "manifest.json"), "--hf-meta", path.join(root, "hf-meta", "metadata.csv"),
        "--etterna-packs", path.join(root, "etterna", "packs"), "--heldout", path.join(root, "heldout.json"),
        "--ranked", "-", "--malody", "-", "--malody-packs", "-", ...extra]);
    const summary = await run(opts, quiet);
    const lines = (await readFile(out, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    return { summary, lines, root };
}

test("fixture corpus: filters, dedupe, rates, labels, song groups, held-out, incremental re-run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-"));
    try {
        await cp(FIX, path.join(dir, "fx"), { recursive: true });
        const { summary, lines, root } = await fixtureRun(dir);
        assert.equal(summary.osuFiles, 18);
        assert.equal(summary.riceCharts, 13);
        assert.deepEqual(summary.perSource.songs.rejected, { keys: 1, mode: 1, ln: 1, short: 1, "no-audio": 1 });
        assert.equal(summary.uniqueCharts, 9);
        assert.equal(summary.duplicates, 4);

        const find = (pred) => lines.find(pred);
        // Song A Hard: HF copy kept (ranked), tracker mirror + Songs 1.2x copy recorded as duplicates
        const a = find((r) => r.source === "hf");
        assert.equal(a.beatmapId, 1001);
        assert.equal(a.rate, 1);
        assert.deepEqual(a.duplicates.map((d) => [d.source, d.rate, d.rateFrom]).sort(), [["sets", 1, "sibling"], ["songs", 1.2, "text"]]);
        assert.equal(a.labels.rawDan, 3.2);
        assert.equal(a.labels.playcount, 5000);
        assert.equal(a.labels.passcount, 900);
        assert.equal(a.labels.favouriteCount, 42);
        assert.ok(a.ranked);
        // Song B: tracker copy kept, Songs copy sped up without a marker → rate from the sibling
        const b = find((r) => r.title === "Song B");
        assert.equal(b.source, "sets");
        assert.equal(b.labels.rawDan, 7.5);
        assert.deepEqual(b.duplicates.map((d) => [d.source, d.rate, d.rateFrom]), [["songs", 1.3, "sibling"]]);
        // Pack: songs named in the difficulty; Etterna copy of Song F is a duplicate, its MSD still lands as a label
        const e = find((r) => r.version.includes("Song E"));
        assert.equal(e.songKey, "p:songe");
        assert.equal(e.rate, 1.5);
        assert.equal(e.labels.rawDan, null);
        const f = find((r) => r.version.includes("Song F"));
        assert.equal(f.source, "packs");
        assert.equal(f.labels.etternaMsd, 12.5);
        assert.equal(f.group, find((r) => r.version.includes("Song F")).group);
        const c = find((r) => r.title === "Song C");
        assert.equal(c.labels.etternaMsd, 17.13);
        assert.equal(c.danBin, "msd:16");
        // Held-out: the seed folder and the re-upload of the same song in another source
        const held = lines.filter((r) => r.split === "heldout");
        assert.deepEqual(held.map((r) => r.osu.split("/").slice(-2, -1)[0]).sort(), ["300 Artist D - Song D", "301"]);
        assert.ok(held.every((r) => r.songKey === "artistd|songd"));
        assert.deepEqual(summary.heldoutSeedFolders.missing, ["999 Not Here - Gone"]);
        // A TV-size copy of the held-out Song D under a kanji title, another chart and another audio file: no key in
        // common, so it is its own group, but the leak guard keeps it out of training (same artist, same BPM)
        const tv = find((r) => r.title.startsWith("ソングD"));
        assert.notEqual(tv.group, held[0].group);
        assert.equal(tv.split, "quarantine");
        assert.equal(tv.splitReason, "leak-guard");
        assert.equal(tv.leak.rule, "artist");
        assert.equal(tv.leak.of, "artistd|songd");
        assert.equal(summary.split.quarantine.groups, 1);
        assert.equal(lines.filter((r) => r.split === "quarantine").length, 1);
        for (const r of lines) for (const k of ["source", "osu", "audio", "artist", "title", "creator", "version", "chartKey", "audioKey", "songKey", "rate", "labels", "split"]) assert.ok(k in r, k);

        // Re-run: nothing parsed again, same output
        const second = await fixtureRun(dir);
        assert.equal(Object.values(second.summary.perSource).reduce((s, x) => s + x.parsed, 0), 0);
        assert.equal(second.summary.audioHashed, 0);
        assert.deepEqual(second.lines, lines);

        // A new set folder appears (the tracker download keeps going): only it is read
        await cp(path.join(root, "sets", "200"), path.join(root, "sets", "201"), { recursive: true });
        const third = await fixtureRun(dir);
        assert.equal(third.summary.perSource.sets.parsed, 1);
        assert.equal(third.summary.duplicates, 5);
        assert.equal(third.summary.uniqueCharts, 9);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("held-out song under another artist spelling / audio encode joins its group; a shared title alone does not", () => {
    const ctx = {
        tracker: new Map(), hfMeta: { byId: new Map(), byMd5: new Map() }, etterna: new Map(),
        heldoutFolders: new Set(["h1", "h2", "h3", "h4", "h5"]), stickySongKeys: new Set(), extraHeldout: 0, seed: "t",
    };
    let n = 0;
    const ch = (folder, artist, title, bpm, spanMs, objects = 1000 + n) => fakeChart(n++, { folder, artist, title, bpm, spanMs, objects });
    const charts = [
        ch("h1", "Camellia", "Bangin' Burst", 234, 120_000),
        ch("t1", "かめりあ", "Bangin' Burst", 234, 120_400),
        ch("h2", "Steinjo", "Friday Fahrenheit", 167, 150_000),
        ch("t2", "Steinjo & Erlend", "Friday Fahrenheit", 83.5, 148_000), // half-time timing
        ch("h3", "Chroma", "I", 199.8, 118_733),
        ch("t3", "黒魔", "I", 100.2, 119_733), // 200.4 at double time: across the 200 fold
        ch("h4", "Official HIGE DANdism", "Pretender", 92, 315_503),
        ch("t4", "Amehurashi", "Pretender", 173, 141_502),
        ch("h5", "Sewerslvt", "Hi High", 194, 184_021),
        ch("t5", "LOONA", "Hi High", 194, 192_216),
        ch("t6", "LeaF", "I", 280, 152_502),
        ch("t7", "Unknown", "No Timing", null, 100_000, 777),
        ch("t8", "Someone", "No Timing", 150, 100_500, 777),
        ch("t9", "Other", "No Timing", 150, 110_000, 778),
    ];
    const res = buildCorpus(charts.map((c) => ({ ...c })), ctx);
    const splitOf = new Map();
    for (const g of res.groups) for (const k of g.kept) splitOf.set(k.folder, [g.split, g.root]);
    for (const t of ["t1", "t2", "t3"]) assert.equal(splitOf.get(t)[0], "heldout", t);
    for (const t of ["t4", "t6"]) assert.equal(splitOf.get(t)[0], "train", t);
    // "Hi High" at the same BPM is not joined (spans 4% apart), but the leak guard still keeps it out of training
    assert.notEqual(splitOf.get("t5")[1], splitOf.get("h5")[1]);
    assert.equal(splitOf.get("t5")[0], "quarantine");
    assert.equal(splitOf.get("t7")[1], splitOf.get("t8")[1]);
    assert.notEqual(splitOf.get("t9")[1], splitOf.get("t8")[1]);
    assert.equal(res.titleJoins, 4);
});

test("incremental run: audio that arrives after its .osu, audio still being written, output folder = a root", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-"));
    try {
        await cp(FIX, path.join(dir, "fx"), { recursive: true });
        const root = path.join(dir, "fx");
        const set = path.join(root, "sets", "202");
        await mkdir(set);
        const osuName = "Artist B - Song B (m) [Insane].osu";
        await cp(path.join(root, "sets", "200", osuName), path.join(set, osuName));
        const first = await fixtureRun(dir);
        assert.equal(first.summary.perSource.sets.rejected["no-audio"], 1);
        assert.equal(first.summary.duplicates, 4);
        // nothing changed: the missing audio is checked, the .osu is not read again
        const second = await fixtureRun(dir);
        assert.equal(second.summary.perSource.sets.parsed, 0);
        assert.equal(second.summary.perSource.sets.rejected["no-audio"], 1);
        // the audio arrives, first only partly written
        const audio = await readFile(path.join(root, "sets", "200", "audio.mp3"));
        await writeFile(path.join(set, "audio.mp3"), audio.subarray(0, Math.floor(audio.length / 2)));
        const third = await fixtureRun(dir);
        assert.equal(third.summary.perSource.sets.parsed, 1);
        assert.equal(third.summary.perSource.sets.rejected["no-audio"], undefined);
        assert.equal(third.summary.duplicates, 5);
        // the download finishes: the .osu is unchanged, but the audio is hashed again
        await writeFile(path.join(set, "audio.mp3"), audio);
        const fourth = await fixtureRun(dir);
        assert.equal(fourth.summary.perSource.sets.parsed, 0);
        assert.equal(fourth.summary.audioHashed, 1);
        const cache = (await readFile(path.join(dir, "out", "cache.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
        const key = (f) => cache.find((e) => e.k === "audio" && e.p.endsWith(f)).key;
        assert.equal(key("sets/202/audio.mp3"), key("sets/200/audio.mp3"));
        // the output folder may not be a root itself (nor lie inside one)
        for (const out of [path.join(root, "sets", "corpus.jsonl"), path.join(root, "sets", "x", "corpus.jsonl")]) {
            const opts = parseArgs([out, "--workers", "1", "--songs", "-", "--hf", "-", "--packs", "-", "--etterna", "-", "--ranked", "-", "--malody", "-", "--sets", path.join(root, "sets")]);
            await assert.rejects(run(opts, quiet), /inside the corpus root/);
        }
        await assert.rejects(stat(path.join(root, "sets", "x"))); // refused before any folder is made
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("romaji / unicode spellings of one song join through ArtistUnicode / TitleUnicode", () => {
    const romaji = { artist: "Hachi", artistUnicode: "ハチ", title: "Matryoshka", titleUnicode: "マトリョシカ" };
    assert.deepEqual(new Set(songKeyAlts(romaji)), new Set(["ハチ|マトリョシカ", "hachi|マトリョシカ", "ハチ|matryoshka"]));
    assert.deepEqual(songKeyAlts({ artist: "Various Artists", title: "X Pack", artistUnicode: "V", titleUnicode: "Y" }), []);
    const ctx = {
        tracker: new Map(), hfMeta: { byId: new Map(), byMd5: new Map() }, etterna: new Map(),
        heldoutFolders: new Set(["h1"]), stickySongKeys: new Set(), extraHeldout: 0, seed: "t",
    };
    let n = 0;
    const ch = (folder, extra) => fakeChart(n++, { folder, bpm: 160 + n * 7, spanMs: 100_000 + n * 9_000, objects: 900 + n, ...extra });
    const charts = [
        ch("h1", romaji),
        ch("t1", { artist: "Hachi", title: "マトリョシカ" }), // an old conversion: romanised artist, kanji title only
        ch("t2", { artist: "ハチ", title: "マトリョシカ" }),
        ch("t3", { artist: "Hachi", title: "Panda Hero", titleUnicode: "パンダヒーロー" }),
    ];
    const res = buildCorpus(charts.map((c) => ({ ...c })), ctx);
    const splitOf = new Map();
    for (const g of res.groups) for (const k of g.kept) splitOf.set(k.folder, [g.split, g.reason]);
    assert.deepEqual(splitOf.get("t1"), ["heldout", "seed"]);
    assert.deepEqual(splitOf.get("t2"), ["heldout", "seed"]);
    assert.deepEqual(splitOf.get("t3"), ["train", undefined]);
});

test("leak guard: remix, subtitle, TV-size under another title and rate-changed copies of a held-out song leave train", () => {
    const ctx = {
        tracker: new Map(), hfMeta: { byId: new Map(), byMd5: new Map() }, etterna: new Map(),
        heldoutFolders: new Set(["h1", "h2", "h3"]), stickySongKeys: new Set(), extraHeldout: 0, seed: "t",
    };
    let n = 0;
    const ch = (folder, artist, title, bpm, spanMs, extra = {}) => fakeChart(n++, { folder, artist, title, bpm, spanMs, objects: 1000 + n, ...extra });
    const charts = [
        ch("h1", "Camellia", "Fastest Crash", 180, 200_000),
        ch("h2", "Kenshi Yonezu", "Lemon", 87, 255_000),
        ch("h3", "xi", "Freedom Dive", 222.22, 260_000),
        ch("t1", "Cranky", "Fastest Crash (Cranky Remix)", 150, 240_000), // remix by another artist at another BPM
        ch("t2", "Someone", "Lemon -Acoustic Ver.-", 70, 300_000), // subtitle / version suffix
        ch("t3", "Kenshi Yonezu", "レモン", 87, 89_000), // TV size under the kanji title
        ch("t4", "xi", "FD (nightcore)", 266.66, 216_667), // rate 1.2 copy under another title
        ch("t5", "xi", "Blue Zenith", 200, 230_000), // same artist, another song
        ch("t6", "Camellia", "Ghost", 150, 200_000), // same artist, another BPM and length
        ch("t7", "Other", "Lemonade", 87, 255_000), // a longer title that only contains "lemon"
    ];
    const res = buildCorpus(charts.map((c) => ({ ...c })), ctx);
    const by = new Map();
    for (const g of res.groups) for (const k of g.kept) by.set(k.folder, g);
    const rule = (f) => (by.get(f).split === "quarantine" ? by.get(f).leak.rule : by.get(f).split);
    assert.equal(rule("t1"), "title");
    assert.equal(by.get("t1").leak.of, "camellia|fastestcrash");
    assert.equal(rule("t2"), "title");
    assert.equal(rule("t3"), "artist");
    assert.equal(rule("t4"), "rate");
    assert.equal(rule("t5"), "train");
    assert.equal(rule("t6"), "train");
    assert.equal(rule("t7"), "train");
    assert.equal(res.leak.groups, 4);
    assert.deepEqual(res.leak.byRule, { audio: 0, title: 2, rate: 1, artist: 1 });
    // no group is ever both held out and quarantined, and quarantine is not sticky
    assert.ok(res.groups.every((g) => (g.split === "quarantine") === (g.reason === "leak-guard")));
});

test("leak guard audio rule: a cut re-encode under unrelated metadata leaves train; with fingerprints a same-BPM song does not", () => {
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
    const print = (n) => Uint32Array.from({ length: n }, rnd);
    const held = new Uint32Array(1500);
    held.set(print(1300), 200); // 200 frames of silence (value 0), then music
    const reencode = (p) => p.map((v, i) => (i % 3 === 0 ? v ^ (1 << (i % 32)) : v)); // a 1-bit error on every third frame
    const ctx = {
        tracker: new Map(), hfMeta: { byId: new Map(), byMd5: new Map() }, etterna: new Map(),
        heldoutFolders: new Set(["h1"]), stickySongKeys: new Set(), extraHeldout: 0, seed: "t",
    };
    let n = 0;
    const ch = (folder, artist, title, bpm, spanMs) => fakeChart(n++, { folder, artist, title, bpm, spanMs, objects: 1000 + n });
    const charts = [
        ch("h1", "Kenshi Yonezu", "Lemon", 87, 255_000),
        ch("t1", "Someone Else", "Totally Different", 140, 60_000), // its audio: 60 s cut out of the held-out song, re-encoded
        ch("t2", "Kenshi Yonezu", "Uma to Shika", 87, 240_000), // same artist + BPM, other audio: the fingerprints decide
        ch("t3", "Kenshi Yonezu", "Flamingo", 87, 230_000), // same artist + BPM, audio did not decode: conservative
        ch("t4", "Nobody", "Nothing", 120, 100_000), // unrelated
        ch("t5", "Silence", "Quiet", 100, 30_000), // only silence in common
    ];
    const prints = new Map([
        ["a0", held],
        ["a1", reencode(held.slice(600, 1085))],
        ["a2", print(1400)],
        ["a3", null],
        ["a4", print(800)],
        ["a5", new Uint32Array(400)],
    ]);
    const res = buildCorpus(charts.map((c) => ({ ...c })), { ...ctx, fingerprints: { get: (k) => prints.get(k) } });
    const by = new Map();
    for (const g of res.groups) for (const k of g.kept) by.set(k.folder, g);
    assert.equal(by.get("t1").split, "quarantine");
    assert.equal(by.get("t1").leak.rule, "audio");
    assert.equal(by.get("t1").leak.of, "kenshiyonezu|lemon");
    assert.equal(by.get("t1").leak.offsetSec, Math.round(600 * 0.1238 * 10) / 10);
    assert.equal(by.get("t2").split, "train");
    assert.equal(by.get("t3").leak.rule, "artist");
    assert.equal(by.get("t4").split, "train");
    assert.equal(by.get("t5").split, "train");
    assert.deepEqual(res.leak.byRule, { audio: 1, title: 0, rate: 0, artist: 1 });
    // without fingerprints the same-BPM song of the same artist is quarantined too
    const plain = buildCorpus(charts.map((c) => ({ ...c })), ctx);
    assert.deepEqual(plain.leak.byRule, { audio: 0, title: 0, rate: 0, artist: 2 });
});

// A 4K chart with 160 seeded notes on a 150 BPM grid.
function chartText({ title, artist, creator = "m", version = "Hard", beatmapId = 0, setId = 0, audio = "audio.mp3", seed = 1 }) {
    let s = seed;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const lines = ["osu file format v14", "", "[General]", `AudioFilename: ${audio}`, "Mode: 3", "", "[Metadata]", `Title:${title}`,
        `Artist:${artist}`, `Creator:${creator}`, `Version:${version}`, `BeatmapID:${beatmapId}`, `BeatmapSetID:${setId}`, "",
        "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "", "[TimingPoints]", "1000,400,4,1,0,100,1,0", "", "[HitObjects]"];
    let t = 1000;
    for (let i = 0; i < 160; i++) {
        lines.push(`${Math.floor(rnd() * 4) * 128 + 64},192,${t},1,0,0:0:0:0:`);
        t += [100, 200, 100, 50][Math.floor(rnd() * 4)];
    }
    return `${lines.join("\r\n")}\r\n`;
}

test("ranked archive and Malody converts: tiers, dedupe, packs, creators, weights; the held-out split stays sticky", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-"));
    try {
        await cp(FIX, path.join(dir, "fx"), { recursive: true });
        const before = await fixtureRun(dir);
        const heldBefore = new Set(before.lines.filter((r) => r.split === "heldout").map((r) => r.songKey));
        assert.ok(heldBefore.size > 0);
        const root = before.root;
        const put = async (folder, file, text, audio = "audio.mp3") => {
            await mkdir(folder, { recursive: true });
            await writeFile(path.join(folder, file), text);
            await writeFile(path.join(folder, audio), `audio of ${folder}`);
        };
        const ranked = path.join(root, "ranked", "sets");
        // a ranked-archive copy of the HF chart (HF stays the kept copy), a copy of the held-out Song D, a new song
        const songA = (await readFile(path.join(root, "hf", "100", "1001.osu"), "utf8")).replace("AudioFilename: 000001.opus", "AudioFilename: audio.mp3");
        await put(path.join(ranked, "ranked-loved - 100 Artist A - Song A"), "Artist A - Song A (m) [Hard].osu", songA);
        const songD = await readFile(path.join(root, "songs", "300 Artist D - Song D", "Artist D - Song D (m) [Hard].osu"), "utf8");
        await put(path.join(ranked, "ranked-loved - 300 Artist D - Song D"), "Artist D - Song D (m) [Hard].osu", songD.replace(/AudioFilename:.*/, "AudioFilename: audio.mp3"));
        await put(path.join(ranked, "ranked-loved - 700 Artist G - Song G"), "Artist G - Song G (Evening) [Hard].osu",
            chartText({ title: "Song G", artist: "Artist G", creator: "Evening", beatmapId: 7001, setId: 700, seed: 11 }));
        // Malody: a new song, and a convert of the Etterna Song C chart (Etterna stays the kept copy)
        const malody = path.join(root, "malody");
        const songH = "Artist H - Song H (4k Lv.5) [4k Lv.5 5].osu";
        await put(path.join(malody, "songs", "mal-0-6-1 Song H [42] 0"), songH,
            chartText({ title: "Song H", artist: "Artist H\u{2028}Line", creator: "4k Lv.5", version: "4k Lv.5 5", seed: 23 }));
        const songC = await readFile(path.join(root, "etterna", "songs", "1 Song C", "Artist C - Song C (ANOTHER) [Challenge 9].osu"), "utf8");
        await put(path.join(malody, "songs", "mal-0-6-1 Song C [43] 0"), "Artist C - Song C (x) [Lv.9].osu", songC.replace(/AudioFilename:.*/, "AudioFilename: audio.mp3"));
        await mkdir(path.join(malody, "packs"), { recursive: true });
        await writeFile(path.join(malody, "packs", "mal-0-6-1.json"), JSON.stringify({ id: "mal-0-6-1", name: "Malody 4k Converts (0-6 1)",
            songs: [{ folder: "mal-0-6-1 Song H [42] 0", charts: [{ file: songH, msd: null }] }] }));

        const after = await fixtureRun(dir, ["--ranked", ranked, "--malody", path.join(malody, "songs"), "--malody-packs", path.join(malody, "packs")]);
        const { summary, lines } = after;
        assert.equal(summary.perSource.ranked.rice, 3);
        assert.equal(summary.perSource.malody.rice, 2);
        const a = lines.find((r) => r.title === "Song A" && r.version === "Hard");
        assert.equal(a.source, "hf");
        assert.ok(a.duplicates.some((d) => d.source === "ranked"));
        const d = lines.find((r) => r.songKey === "artistd|songd" && r.version === "Hard" && r.split === "heldout");
        assert.equal(d.source, "ranked", "a ranked copy outranks the Songs copy");
        const g = lines.find((r) => r.title === "Song G");
        assert.equal(g.source, "ranked");
        assert.equal(g.ranked, true);
        assert.equal(g.pack, null);
        assert.equal(g.creatorKey, "n:evening");
        const h = lines.find((r) => r.title === "Song H");
        assert.equal(h.source, "malody");
        assert.equal(h.ranked, false);
        assert.equal(h.pack, "malody:mal-0-6-1");
        assert.equal(h.creatorKey, null);
        assert.equal(h.artist, "Artist H\u{2028}Line");
        const c = lines.find((r) => r.title === "Song C");
        assert.equal(c.source, "etterna");
        assert.equal(c.pack, "etterna:1");
        assert.ok(c.duplicates.some((x) => x.source === "malody"));
        // weights: positive and finite in train and held-out, 0 in quarantine; per-split stats in the summary
        for (const r of lines) {
            if (r.split === "quarantine") assert.equal(r.weight, 0);
            else assert.ok(Number.isFinite(r.weight) && r.weight > 0, `${r.osu}: ${r.weight}`);
        }
        assert.equal(summary.weights.train.charts, lines.filter((r) => r.split === "train").length);
        assert.equal(summary.weights.heldout.charts, lines.filter((r) => r.split === "heldout").length);
        assert.ok(summary.weights.train.bySource.malody.charts >= 1);
        // the U+2028 in the Malody artist is escaped: one physical line per chart for every reader
        const raw = await readFile(path.join(dir, "out", "corpus.jsonl"), "utf8");
        assert.equal(raw.includes("\u{2028}"), false);
        assert.equal(raw.trim().split("\n").length, lines.length);
        // sticky: everything held out before still is
        const heldAfter = new Set(lines.filter((r) => r.split === "heldout").flatMap((r) => [r.songKey, ...r.duplicates.map((x) => x.songKey)]));
        for (const k of heldBefore) assert.ok(heldAfter.has(k), k);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
