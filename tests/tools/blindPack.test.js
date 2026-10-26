import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBlindPack, setVersion, setAudio, blindKeyPath, spreadByDan } from "../../tools/eval/blind.mjs";
import { blindTitle } from "../../tools/blind-pack.mjs";
import { mulberry32 } from "../../src/gen/rng.js";
import { readOsz, osuTexts } from "../fixtures/readOsz.js";
import { makeChart } from "../fixtures/makeChart.js";

const SECRET_A = "model-alpha-secret";
const SECRET_B = "model-beta-secret";

// Two different generated maps per song; their Version lines carry engine-ish text that must not survive.
function songs(n) {
    return Array.from({ length: n }, (_, k) => ({
        title: `Song ${k}`, artist: "Tester", audioName: `audio${k}.mp3`, audio: Buffer.from(`fake audio ${k}`),
        info: { dan: 3 + k, family: "Stream", seed: 1 },
        maps: {
            A: { label: SECRET_A, osuText: makeChart({ kind: "stream", bpm: 150 + k }).replace(/^Version:.*$/m, `Version:${SECRET_A} 7 mid`), numeric: 7 },
            B: { label: SECRET_B, osuText: makeChart({ kind: "jumpstream", bpm: 150 + k }).replace(/^Version:.*$/m, `Version:${SECRET_B} 7 high`), numeric: 7.4 },
        },
    }));
}

async function tmp() {
    return mkdtemp(path.join(tmpdir(), "blind-"));
}

test("setVersion replaces the difficulty name and the tags, and nothing else", () => {
    const text = makeChart({ kind: "stream" }).replace(/^Version:.*$/m, "Version:secret").replace(/\[Metadata\]/, "[Metadata]\r\nTags:secret tags");
    const out = setVersion(text, "X");
    assert.match(out, /^Version:X$/m);
    assert.doesNotMatch(out, /secret/);
    assert.match(out, /^Tags:lunacy-mania generated blind$/m);
    assert.equal(out.split("[HitObjects]")[1], text.split("[HitObjects]")[1]);
    // a file without a Version line gets one in [Metadata]
    assert.match(setVersion("osu file format v14\r\n\r\n[Metadata]\r\nTitle:x\r\n", "Y"), /\[Metadata\]\r\nVersion:Y/);
});

test("blind pack: one .osz per song with [X] and [Y] at random, the key outside the packs", async () => {
    const root = await tmp();
    try {
        const outDir = path.join(root, "blind-2026-10-26");
        const keyFile = path.join(root, "blind-2026-10-26.json");
        const list = songs(16);
        const { files, keyFile: written, key } = await writeBlindPack({ songs: list, outDir, keyFile, rng: mulberry32(7), meta: { a: { label: SECRET_A }, b: { label: SECRET_B } } });
        assert.equal(written, keyFile);
        assert.equal(files.length, 16);
        assert.deepEqual((await readdir(outDir)).filter((f) => !f.endsWith(".osz")), [], "only .osz files in the pack folder");
        const xs = key.songs.map((s) => s.X);
        assert.ok(xs.includes("A") && xs.includes("B"), `both orders occur: ${xs.join("")}`);
        for (const [k, s] of key.songs.entries()) {
            assert.equal(s.Y, s.X === "A" ? "B" : "A");
            const buf = await readFile(path.join(outDir, s.osz));
            const raw = buf.toString("latin1");
            for (const secret of [SECRET_A, SECRET_B, "\"X\":", "key"]) assert.ok(!raw.includes(secret), `${s.osz} leaks ${secret}`);
            const entries = readOsz(buf);
            assert.equal(entries.size, 3);
            assert.equal(entries.get(list[k].audioName).toString(), `fake audio ${k}`);
            const texts = osuTexts(entries);
            const xName = [...texts.keys()].find((n) => n.endsWith("[X].osu"));
            const yName = [...texts.keys()].find((n) => n.endsWith("[Y].osu"));
            assert.ok(xName && yName, [...texts.keys()].join(", "));
            assert.equal(texts.get(xName), setAudio(setVersion(list[k].maps[s.X].osuText, "X"), list[k].audioName));
            assert.equal(texts.get(yName), setAudio(setVersion(list[k].maps[s.Y].osuText, "Y"), list[k].audioName));
            assert.match(texts.get(xName), /^AudioFilename: audio\d+\.mp3$/m);
        }
        const saved = JSON.parse(await readFile(keyFile, "utf8"));
        assert.deepEqual(saved.songs.map((s) => s.X), xs);
        assert.equal(saved.a.label, SECRET_A);
        assert.equal(saved.songs[0].numeric.A, 7);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("blind pack never overwrites a key and refuses a key inside the pack folder", async () => {
    const root = await tmp();
    try {
        const outDir = path.join(root, "blind");
        const keyFile = path.join(root, "blind.json");
        await writeFile(keyFile, "old key");
        const first = await writeBlindPack({ songs: songs(2), outDir, keyFile, rng: mulberry32(1) });
        assert.equal(first.keyFile, path.join(root, "blind-2.json"));
        assert.equal(await readFile(keyFile, "utf8"), "old key");
        // a second run into the same pack folder does not overwrite its .osz files either
        const second = await writeBlindPack({ songs: songs(2), outDir, keyFile, rng: mulberry32(1) });
        assert.equal(second.keyFile, path.join(root, "blind-3.json"));
        assert.equal(new Set([...first.files, ...second.files]).size, 4);
        await mkdir(path.join(root, "p"), { recursive: true });
        await assert.rejects(writeBlindPack({ songs: songs(1), outDir: path.join(root, "p"), keyFile: path.join(root, "p", "k.json"), rng: mulberry32(1) }), /inside/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a pack chart's blind title takes its difficulty name, whitespace after `Version:` and leading s included", () => {
    const pack = { artist: "Various Artists", title: "4th Dan Pack" };
    assert.equal(blindTitle({ ...pack, text: "[Metadata]\nVersion:  speed - Sakura 1.1x\n" }), "4th Dan Pack - speed - Sakura 1.1x");
    assert.equal(blindTitle({ ...pack, text: "Version:sss\r\n" }), "4th Dan Pack - sss");
    assert.equal(blindTitle({ artist: "Camellia", title: "Exit This Earth", text: "Version:Hard\n" }), "Exit This Earth");
    assert.equal(blindTitle({ ...pack, text: "no version line" }), "4th Dan Pack");
});

test("default key path is A:/SneezeyTrain/candidates/blind-<date>.json; songs spread across dans", () => {
    const d = new Date(2026, 9, 26);
    assert.equal(blindKeyPath(d).replace(/\\/g, "/"), "A:/SneezeyTrain/candidates/blind-2026-10-26.json");
    const picks = Array.from({ length: 30 }, (_, i) => ({ dan: 3 + i * 0.5 }));
    const five = spreadByDan(picks, 5);
    assert.equal(five.length, 5);
    assert.ok(five[0].dan <= 4 && five[4].dan >= 16, five.map((p) => p.dan).join(","));
    assert.ok(five.every((p, i) => i === 0 || p.dan > five[i - 1].dan));
    assert.equal(spreadByDan(picks.slice(0, 3), 5).length, 3);
});
