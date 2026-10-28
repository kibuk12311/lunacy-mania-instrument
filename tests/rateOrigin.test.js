// Rate maps (src/rate/rateOrigin.js, app/rateMapOrigin.js): the names the Rate tab and osu-trainer give them, the
// evidence a file is one (its tag, its BPM against the name's, its original beside it with the same notes ÷ the rate),
// the original made back from a rate map, and the finder in main over a fake folder (read only, nothing asked for a
// plain map, lazer never listed). Synthetic charts only; the real analyzer checks the made-back original.
import test from "node:test";
import path from "node:path";
import assert from "node:assert/strict";
import { parseRateVersion, rateVersionOf, findRateOrigin, isOriginalOf, originalFromRateMap, OSU_TRAINER_TAG } from "../src/rate/rateOrigin.js";
import { createRateOrigins } from "../app/rateMapOrigin.js";
import { RATE_TAG, rateOsu, rateVersionName } from "../src/rate/rateMap.js";
import { transformOsu, transformSuffix } from "../src/rate/chartTransform.js";
import { analyzeChart } from "../src/core/analyze.js";
import { makeChart } from "./fixtures/makeChart.js";

// a chart's [Metadata] fields set (added after Version when it has none), CRLF kept
function withMeta(text, fields) {
    const lines = text.split("\r\n");
    for (const [key, value] of Object.entries(fields)) {
        const at = lines.findIndex((l) => l.startsWith(`${key}:`));
        if (at >= 0) lines[at] = `${key}:${value}`;
        else lines.splice(lines.findIndex((l) => l.startsWith("Version:")) + 1, 0, `${key}:${value}`);
    }
    return lines.join("\r\n");
}
const field = (text, key) => new RegExp(`^${key}\\s*:(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
// every hit object's time through fn (osu-trainer's truncation, say)
function retime(text, fn) {
    const [head, objects] = text.split("[HitObjects]");
    return `${head}[HitObjects]${objects.split("\r\n").map((l) => {
        const p = l.split(",");
        if (p.length < 5) return l;
        p[2] = String(fn(Number(p[2])));
        return p.join(",");
    }).join("\r\n")}`;
}
const times = (text) => text.split("[HitObjects]")[1].split("\r\n").filter((l) => l.split(",").length >= 5).map((l) => Number(l.split(",")[2]));

const ORIGINAL = withMeta(makeChart({ kind: "jumpstream", bpm: 180, seconds: 30 }), { Version: "Insane", Tags: "test tags", BeatmapID: "1234567" });
// the Rate tab's copy at 1.2: "Insane 1.2x (216bpm)", the lunacy-mania-rate tag, its own audio
const RATE_MAP = rateOsu(ORIGINAL, { rate: 1.2, audioFilename: "audio 1.2x.mp3" });
const OTHER = withMeta(makeChart({ kind: "stream", bpm: 150, seconds: 30 }), { Version: "Hard", Tags: "", BeatmapID: "7" });

test("parseRateVersion reads the Rate tab's names (with NC / Mirror / NoLN) and osu-trainer's (HP / OD, a decimal comma)", () => {
    assert.deepEqual(parseRateVersion(rateVersionName("Insane", 1.2, 180)), { base: "Insane", rate: 1.2, bpm: 216, pitch: false, mirror: false, noLn: false });
    const marked = rateVersionName("4K Another", 1.25, 180) + transformSuffix({ pitch: true, mirror: true, noLn: true });
    assert.equal(marked, "4K Another 1.25x (225bpm) NC Mirror NoLN");
    assert.deepEqual(parseRateVersion(marked), { base: "4K Another", rate: 1.25, bpm: 225, pitch: true, mirror: true, noLn: true });
    assert.deepEqual(parseRateVersion("Hard 0.85x (153bpm) NoLN"), { base: "Hard", rate: 0.85, bpm: 153, pitch: false, mirror: false, noLn: true });
    // osu-trainer: "{version} {rate:0.##}x ({bpm}bpm)" then " HP{hp} OD{od}" when changed, in the system's number format
    assert.deepEqual(parseRateVersion("Extra 1.3x (234bpm) HP8 OD9.5"), { base: "Extra", rate: 1.3, bpm: 234, pitch: false, mirror: false, noLn: false });
    assert.equal(parseRateVersion("Extra 1,15x (207bpm) OD8,5").rate, 1.15);
    assert.deepEqual(parseRateVersion("Normal 2x"), { base: "Normal", rate: 2, bpm: null, pitch: false, mirror: false, noLn: false });
    assert.equal(parseRateVersion("Easy 0.5x (90bpm)").rate, 0.5);
    assert.equal(rateVersionOf(RATE_MAP).base, "Insane");
});

test("parseRateVersion leaves other names alone: 4x4, 2x Speed, x1.5 jacks, a rate of 1 or out of 0.5…2", () => {
    for (const name of ["4x4", "2x Speed", "Insane", "x1.5 jacks", "x2 jacks", "1.2x", "Hard 1x (180bpm)", "Hard 2.5x (450bpm)",
        "Hard 0.4x", "Hard 1.2x Speed", "Hard 1.2x (216bpm) Hidden", "Hard 1.234x", "Hard 12x", "", null]) {
        assert.equal(parseRateVersion(name), null, String(name));
    }
});

test("a rate map of the Rate tab is told by its tag; its original is made back from it when nowhere else", () => {
    assert.match(field(RATE_MAP, "Tags"), new RegExp(`\\b${RATE_TAG}\\b`));
    const o = findRateOrigin(RATE_MAP);
    assert.equal(o.evidence, "tag");
    assert.equal(o.rate, 1.2);
    assert.equal(o.virtual, true);
    assert.equal(o.sibling, null);
    assert.equal(o.version, "Insane 1.2x (216bpm)");
    // the made-back original: the base name, the tools' tags gone, the rate map's id kept (0 for the Rate tab's copies),
    // the times and BPM × 1.2 again, the audio still the rate map's (so no copy is ever made of it)
    assert.equal(field(o.text, "Version"), "Insane");
    assert.equal(field(o.text, "Tags"), "test tags");
    assert.equal(field(o.text, "BeatmapID"), "0");
    assert.equal(field(o.text, "AudioFilename"), "audio 1.2x.mp3");
    const beat = Number(/^0,([\d.]+),4,1/m.exec(o.text)?.[1]);
    assert.ok(Math.abs(beat - 60000 / 180) < 1e-9, `the red line back at 180 BPM (${beat})`);
    const back = times(o.text);
    const first = times(ORIGINAL);
    assert.equal(back.length, first.length);
    assert.ok(back.every((t, i) => Math.abs(t - first[i]) <= 1), "every time within a millisecond of the original's");
    assert.ok(!o.text.split("\r\n").some((l) => l.endsWith("\r")) && !/[^\r]\n/.test(o.text), "CRLF all through");
    assert.equal(originalFromRateMap(RATE_MAP, parseRateVersion("Insane 1.2x (216bpm)")), o.text);
});

test("osu-trainer's copies: the osutrainer tag, HP / OD marks and truncated times; one meant for DT is left alone", () => {
    const trainer = withMeta(retime(rateOsu(ORIGINAL, { rate: 1.3, audioFilename: "audio 1.300x.mp3" }), (t) => t), {
        Version: "Insane 1.3x (234bpm) OD9", Tags: `test tags ${OSU_TRAINER_TAG}`, BeatmapID: "1234567",
    });
    const o = findRateOrigin(trainer);
    assert.deepEqual([o.evidence, o.rate, o.base, o.virtual], ["tag", 1.3, "Insane", true]);
    assert.equal(field(o.text, "Tags"), "test tags");
    assert.equal(field(o.text, "BeatmapID"), "1234567", "osu-trainer keeps the original's id");
    // its times cut down instead of rounded: still the original's ÷ 1.3
    const cut = withMeta(retime(ORIGINAL, (t) => Math.floor(t / 1.3)), { Version: "Insane 1.3x (234bpm)", Tags: OSU_TRAINER_TAG });
    assert.equal(isOriginalOf(ORIGINAL, cut, parseRateVersion("Insane 1.3x (234bpm)")), true);
    // AR/OD over 10 make osu-trainer write a copy to be played with DT ("… withDT" audio): its speed is not its name's
    const withDt = withMeta(trainer, {}).replace("AudioFilename: audio 1.300x.mp3", "AudioFilename: audio 1.300x withDT.mp3");
    assert.equal(findRateOrigin(withDt), null);
});

test("the name's (Nbpm) equal to the file's own BPM is evidence; any other BPM, or no BPM and no tag, is not", () => {
    const untagged = withMeta(RATE_MAP, { Tags: "test tags" });
    const o = findRateOrigin(untagged);
    assert.deepEqual([o.evidence, o.rate, o.virtual], ["bpm", 1.2, true]);
    assert.equal(findRateOrigin(withMeta(untagged, { Version: "Insane 1.2x (300bpm)" })), null);
    assert.equal(findRateOrigin(withMeta(untagged, { Version: "Insane 1.2x" })), null);
    // a mapper's own "x" names, tagged or not, are never rates
    for (const version of ["4x4", "2x Speed", "x1.5 jacks"]) {
        assert.equal(findRateOrigin(withMeta(RATE_MAP, { Version: version })), null, version);
    }
});

test("the original beside it is found by its notes ÷ the rate (mirrored and without holds as the name says); a look-alike is not", () => {
    const found = findRateOrigin(RATE_MAP, [{ text: OTHER }, { text: RATE_MAP }, { text: ORIGINAL }]);
    assert.deepEqual([found.evidence, found.sibling, found.virtual, found.rate], ["original", 2, false, 1.2]);
    assert.equal(found.text, ORIGINAL, "the original's own text: the ladder shares the cache with it");

    // a mirrored copy without holds of an LN chart: found, and the ladder's chart is the original so changed
    const ln = withMeta(makeChart({ kind: "ln", bpm: 160, seconds: 30, lnShare: 0.1 }), { Version: "Hyper", Tags: "", BeatmapID: "1234567" });
    const suffix = transformSuffix({ pitch: true, mirror: true, noLn: true });
    const copy = rateOsu(transformOsu(ln, { mirror: true, noLn: true }), { rate: 0.9, audioFilename: "a 0.9x nc.mp3", versionSuffix: suffix });
    assert.equal(field(copy, "Version"), "Hyper 0.9x (144bpm) NC Mirror NoLN");
    const lnFound = findRateOrigin(withMeta(copy, { Tags: "" }), [{ text: ln }]);
    assert.deepEqual([lnFound.evidence, lnFound.mirror, lnFound.noLn, lnFound.pitch], ["original", true, true, true]);
    assert.equal(lnFound.text, transformOsu(ln, { mirror: true, noLn: true }));
    assert.equal(isOriginalOf(ln, copy, { ...parseRateVersion(field(copy, "Version")), mirror: false }), false, "unmirrored it is not the same chart");

    // the same names and version but other notes: not the original; with the tag the original is made back instead
    const lookAlike = withMeta(makeChart({ kind: "jumpstream", bpm: 170, seconds: 30 }), { Version: "Insane", Tags: "test tags", BeatmapID: "1234567" });
    assert.equal(isOriginalOf(lookAlike, RATE_MAP, parseRateVersion("Insane 1.2x (216bpm)")), false);
    const tagged = findRateOrigin(RATE_MAP, [{ text: lookAlike }]);
    assert.deepEqual([tagged.evidence, tagged.virtual], ["tag", true]);
    assert.equal(findRateOrigin(withMeta(RATE_MAP, { Version: "Insane 1.2x", Tags: "" }), [{ text: lookAlike }]), null);
    // another mapper's difficulty of that name is not it either
    assert.equal(isOriginalOf(withMeta(ORIGINAL, { Creator: "Someone" }), RATE_MAP, parseRateVersion("Insane 1.2x (216bpm)")), false);
    // with nothing but the name it is not a rate map; with the original beside it, it is
    const bare = withMeta(RATE_MAP, { Version: "Insane 1.2x", Tags: "" });
    assert.equal(findRateOrigin(bare), null);
    assert.equal(findRateOrigin(bare, [{ text: ORIGINAL }]).evidence, "original");
});

test("the real analyzer: the made-back original at the rate map's rate has the original's dan", async () => {
    const original = withMeta(makeChart({ kind: "jumpstream", bpm: 170, seconds: 40 }), { Version: "Insane", Tags: "" });
    const rateMap = rateOsu(original, { rate: 1.2, audioFilename: "a.mp3" });
    const back = findRateOrigin(rateMap).text;
    const [fromOriginal, fromBack] = await Promise.all([analyzeChart(original, 1.2), analyzeChart(back, 1.2)]);
    assert.equal(fromOriginal.kind, "ok");
    assert.equal(fromBack.label, fromOriginal.label);
    assert.equal(fromBack.numeric, fromOriginal.numeric);
    assert.equal(Math.round(fromBack.bpm), 204);
});

// a fake Songs folder: files by path, every read and listing counted
function fakeFolder(files) {
    const seen = { reads: [], lists: [] };
    return {
        seen,
        readFile: async (file) => {
            seen.reads.push(file);
            if (!(file in files)) throw new Error("ENOENT");
            return files[file];
        },
        readdir: async (dir) => {
            seen.lists.push(dir);
            return Object.keys(files).filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
        },
    };
}
const DIR = path.join("Songs", "1 Test - Synthetic");
const RATE_FILE = path.join(DIR, "Test - Synthetic (Test) [Insane 1.2x (216bpm)].osu");
const ORIGINAL_FILE = path.join(DIR, "Test - Synthetic (Test) [Insane].osu");

test("the finder in main: the original from the map's folder once tosu's file is the chart; a plain map costs nothing", async () => {
    const folder = fakeFolder({ [RATE_FILE]: `\uFEFF${RATE_MAP}`, [ORIGINAL_FILE]: ORIGINAL, [path.join(DIR, "other.osu")]: OTHER, [path.join(DIR, "audio.mp3")]: "x" });
    let asked = 0;
    const find = createRateOrigins({ beatmap: async () => { asked += 1; return { client: "stable", path: RATE_FILE }; }, ...folder });
    assert.equal(await find(ORIGINAL, { checksum: "plain" }), null);
    assert.equal(asked, 0, "a chart not named like a rate map asks tosu for nothing");
    assert.equal(folder.seen.reads.length, 0);

    const o = await find(RATE_MAP, { checksum: "abc" });
    assert.deepEqual([o.evidence, o.rate, o.virtual, o.path, o.file, o.client], ["original", 1.2, false, ORIGINAL_FILE, RATE_FILE, "stable"]);
    assert.equal(o.text, ORIGINAL);
    assert.deepEqual(folder.seen.lists, [DIR]);
    assert.ok(!folder.seen.reads.some((f) => f.endsWith(".mp3")), "only .osu files are read");
    // the same map again (DT on, say): kept
    const reads = folder.seen.reads.length;
    assert.equal(await find(RATE_MAP, { checksum: "abc" }), o);
    assert.equal(folder.seen.reads.length, reads);
    assert.equal(asked, 1);
});

test("the finder in main: another file at tosu's path, or lazer, never lists a folder; the tag still tells", async () => {
    const folder = fakeFolder({ [RATE_FILE]: OTHER, [ORIGINAL_FILE]: ORIGINAL });
    const stale = await createRateOrigins({ beatmap: async () => ({ client: "stable", path: RATE_FILE }), ...folder })(RATE_MAP, { checksum: "a" });
    assert.deepEqual([stale.evidence, stale.virtual, stale.path, stale.file], ["tag", true, null, null]);
    assert.deepEqual(folder.seen.lists, []);

    const hashed = path.join("lazer", "files", "a", "ab", "abc");
    const lazerFolder = fakeFolder({ [hashed]: RATE_MAP });
    const lazer = await createRateOrigins({ beatmap: async () => ({ client: "lazer", path: hashed }), ...lazerFolder })(RATE_MAP, { checksum: "b" });
    assert.deepEqual([lazer.evidence, lazer.virtual, lazer.client], ["tag", true, "lazer"]);
    assert.deepEqual(lazerFolder.seen.lists, []);
    assert.deepEqual(lazerFolder.seen.reads, []);

    // tosu without an answer: the chart alone tells, and it is asked again next time
    let tries = 0;
    const find = createRateOrigins({ beatmap: async () => { tries += 1; throw new Error("tosu down"); }, ...fakeFolder({}) });
    assert.equal((await find(RATE_MAP, { checksum: "c" })).evidence, "tag");
    await find(RATE_MAP, { checksum: "c" });
    assert.equal(tries, 2);
});

test("the finder in main: in a set full of rate copies the original, named after the base, is read first and found", async () => {
    // a batch of the Rate tab at 0.5…2 by 0.05 for each of four difficulties: "[Insane 1.05x …]" sorts before "[Insane]"
    const files = {};
    const nameOf = (text) => path.join(DIR, `Test - Synthetic (Test) [${field(text, "Version")}].osu`);
    for (const base of ["Another", "Easy", "Insane", "Normal"]) {
        const src = base === "Insane" ? ORIGINAL : withMeta(ORIGINAL, { Version: base });
        files[nameOf(src)] = src;
        for (let i = 0; i < 31; i += 1) {
            const rate = Math.round((0.5 + 0.05 * i) * 100) / 100;
            if (rate !== 1) files[nameOf(rateOsu(src, { rate, audioFilename: `audio ${rate}x.mp3` }))] = rateOsu(src, { rate, audioFilename: `audio ${rate}x.mp3` });
        }
    }
    assert.equal(files[RATE_FILE], RATE_MAP);
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.ok(Object.keys(sorted).indexOf(ORIGINAL_FILE) > 64, "the original sits past the cap in the folder's order");
    const folder = fakeFolder(sorted);
    const o = await createRateOrigins({ beatmap: async () => ({ client: "stable", path: RATE_FILE }), ...folder })(RATE_MAP, { checksum: "set" });
    assert.deepEqual([o.evidence, o.virtual, o.path], ["original", false, ORIGINAL_FILE]);
    assert.deepEqual(folder.seen.reads, [RATE_FILE, ORIGINAL_FILE], "only the map itself and the file named after its base");
});

test("the finder in main: an original whose file is not named after the base is still looked for among the others", async () => {
    const renamed = path.join(DIR, "renamed.osu");
    const folder = fakeFolder({ [RATE_FILE]: RATE_MAP, [path.join(DIR, "other.osu")]: OTHER, [renamed]: ORIGINAL });
    const o = await createRateOrigins({ beatmap: async () => ({ client: "stable", path: RATE_FILE }), ...folder })(RATE_MAP, { checksum: "r" });
    assert.deepEqual([o.evidence, o.path], ["original", renamed]);
});
