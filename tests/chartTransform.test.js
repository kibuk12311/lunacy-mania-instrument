// Chart transforms for rate copies: mirrored columns, holds turned into notes, the LN share and the name suffix.
import test from "node:test";
import assert from "node:assert/strict";
import { mirrorOsu, noLnOsu, transformOsu, transformSuffix, lnShare } from "../src/rate/chartTransform.js";

const chart = (keys, objects, eol = "\r\n") => [
    "osu file format v14", "",
    "[General]", "AudioFilename: song.mp3", "Mode: 3", "",
    "[Metadata]", "Title:Song", "Version:Hard", "",
    "[Difficulty]", "HPDrainRate:7", `CircleSize:${keys}`, "OverallDifficulty:8", "",
    "[TimingPoints]", "300,500,4,2,0,60,1,0", "",
    "[HitObjects]", ...objects, "",
].join(eol);

const objects = (text) => {
    const lines = text.split(/\r?\n/);
    const start = lines.indexOf("[HitObjects]");
    return lines.slice(start + 1).filter(Boolean);
};
const xs = (text) => objects(text).map((l) => Number(l.split(",")[0]));

test("mirror 4K: columns flip, 64↔448 and 192↔320; nothing else changes", () => {
    const src = chart(4, ["64,192,1000,1,0,0:0:0:0:", "192,192,1100,1,0,0:0:0:0:", "320,192,1200,128,0,1500:0:0:0:0:", "448,192,1300,5,0,0:0:0:0:"]);
    const out = mirrorOsu(src);
    assert.deepEqual(xs(out), [448, 320, 192, 64]);
    assert.deepEqual(objects(out).map((l) => l.split(",").slice(1).join(",")), objects(src).map((l) => l.split(",").slice(1).join(",")));
    // every line outside [HitObjects] is untouched, line endings too
    assert.equal(out.split("[HitObjects]")[0], src.split("[HitObjects]")[0]);
    assert.ok(out.includes("\r\n"));
});

test("mirror 7K: the middle column stays, the outer ones swap", () => {
    const col = (c) => Math.floor(((c + 0.5) * 512) / 7);
    const src = chart(7, [0, 1, 2, 3, 4, 5, 6].map((c, i) => `${col(c)},192,${1000 + i * 100},1,0,0:0:0:0:`));
    assert.deepEqual(xs(mirrorOsu(src)), [6, 5, 4, 3, 2, 1, 0].map(col));
    assert.equal(xs(mirrorOsu(src))[3], col(3));
});

test("mirroring twice gives the original text (x in canonical lane positions)", () => {
    const src = chart(4, ["64,192,1000,1,0,0:0:0:0:", "192,192,1100,128,0,1400:0:0:0:0:", "448,192,1200,1,0,0:0:0:0:"], "\n");
    assert.equal(mirrorOsu(mirrorOsu(src)), src);
    // an off-centre x lands on the canonical position of its lane
    const odd = chart(4, ["10,192,1000,1,0,0:0:0:0:", "500,192,1100,1,0,0:0:0:0:"]);
    assert.deepEqual(xs(mirrorOsu(mirrorOsu(odd))), [64, 448]);
});

test("mirror without a column count leaves the chart alone", () => {
    const src = chart("x", ["64,192,1000,1,0,0:0:0:0:"]);
    assert.equal(mirrorOsu(src), src);
});

test("no-LN: a hold becomes a note at its head, plain notes are not touched", () => {
    const src = chart(4, ["64,192,1000,1,0,0:0:0:0:", "192,192,2400,128,0,3600:0:0:0:0:", "320,192,2600,132,2,3000:1:2:0:0:hit.wav"]);
    const out = noLnOsu(src);
    assert.deepEqual(objects(out), ["64,192,1000,1,0,0:0:0:0:", "192,192,2400,1,0,0:0:0:0:", "320,192,2600,5,2,1:2:0:0:hit.wav"]);
    assert.equal(lnShare(out), 0);
    assert.equal(out.split("[HitObjects]")[0], src.split("[HitObjects]")[0]);
});

test("lnShare: holds over all objects; an empty chart is 0", () => {
    const src = chart(4, ["64,192,1000,1,0,0:0:0:0:", "192,192,2400,128,0,3600:0:0:0:0:", "320,192,2600,1,0,0:0:0:0:", "448,192,2700,128,0,2900:0:0:0:0:"]);
    assert.equal(lnShare(src), 0.5);
    assert.equal(lnShare(chart(4, [])), 0);
    assert.equal(lnShare("not a chart"), 0);
});

test("transformOsu: nothing asked gives the very same text; both at once", () => {
    const src = chart(4, ["64,192,1000,1,0,0:0:0:0:", "192,192,2400,128,0,3600:0:0:0:0:"]);
    assert.equal(transformOsu(src, {}), src);
    assert.equal(transformOsu(src, { mirror: false, noLn: false }), src);
    assert.equal(transformOsu(src), src);
    assert.deepEqual(objects(transformOsu(src, { mirror: true, noLn: true })), ["448,192,1000,1,0,0:0:0:0:", "320,192,2400,1,0,0:0:0:0:"]);
    assert.equal(transformOsu(src, { mirror: true }), mirrorOsu(src));
    assert.equal(transformOsu(src, { noLn: true }), noLnOsu(src));
});

test("name suffix: NC, Mirror, NoLN in that order", () => {
    assert.equal(transformSuffix({ pitch: true, mirror: true, noLn: true }), " NC Mirror NoLN");
    assert.equal(transformSuffix({ noLn: true, mirror: true }), " Mirror NoLN");
    assert.equal(transformSuffix({ pitch: true }), " NC");
    assert.equal(transformSuffix({ noLn: true }), " NoLN");
    assert.equal(transformSuffix({}), "");
    assert.equal(transformSuffix(), "");
});
