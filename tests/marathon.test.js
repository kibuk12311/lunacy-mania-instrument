import test from "node:test";
import assert from "node:assert/strict";
import { buildMarathon } from "../src/rate/marathon.js";
import { setLang } from "../src/i18n/i18n.js";
import { createHash } from "node:crypto";

const x = (c) => Math.floor(((c + 0.5) * 512) / 4);
function map({ title, bpm, offset, notes, sv = [] }) {
    return [
        "osu file format v14", "", "[General]", "AudioFilename: a.mp3", "Mode: 3", "",
        "[Metadata]", `Title:${title}`, "Artist:Art", "Creator:Map", "Version:Hard", "",
        "[Difficulty]", "HPDrainRate:7", "CircleSize:4", "OverallDifficulty:8", "",
        "[TimingPoints]", `${offset},${60000 / bpm},4,2,0,60,1,0`, ...sv.map(([t, v]) => `${t},${v},4,2,0,60,0,0`), "",
        "[HitObjects]", ...notes.map(([t, c, end]) => (end ? `${x(c)},192,${t},128,0,${end}:0:0:0:0:` : `${x(c)},192,${t},1,0,0:0:0:0:`)), "",
    ].join("\r\n");
}
const objects = (text) => text.split(/\r?\n/).filter((l) => /^\d+,192,\d+,/.test(l)).map((l) => {
    const p = l.split(",");
    return { t: Number(p[2]), col: Math.floor((Number(p[0]) * 4) / 512), end: Number(p[3]) & 128 ? Number(p[5].split(":")[0]) : null };
});
const section = (text, name) => {
    const all = text.split(/\r?\n/);
    const s = all.indexOf(`[${name}]`);
    const out = [];
    for (let i = s + 1; i < all.length && all[i] && !all[i].startsWith("["); i += 1) out.push(all[i]);
    return out;
};

// sha256 of buildMarathon's chart for A + B (1.5x, 5 s gap) from before cutRange was split out of it
// (re-taken after the rename: only the Creator and Tags lines changed, to "Lunacy mania" and lunacy-mania-marathon)
const BUILD_HASH = "9d4d8c8da170d55fab79b78842f48cdbecddfb985e01cd2dd7ee4ce2552b7228";
const A = map({ title: "First", bpm: 120, offset: 1000, notes: [[3000, 0], [3500, 1], [5000, 2, 6000]] });
const B = map({ title: "Second", bpm: 150, offset: 200, notes: [[10000, 3], [12000, 0]], sv: [[11000, -50]] });

test("maps follow each other with the gap between them, each at its own rate", () => {
    const r = buildMarathon([{ osuText: A, rate: 1 }, { osuText: B, rate: 2 }], { gapMs: 10000, leadMs: 2000, tailMs: 1000 });
    // map 1: audio 1000..7000 (first note − 2 s … last note end + 1 s) → output 0..6000
    assert.deepEqual(r.segments[0], { index: 0, srcStartMs: 1000, srcEndMs: 7000, rate: 1, outStartMs: 0, outEndMs: 6000 });
    // map 2 at 2x: audio 8000..13000 → 2500 ms long, starts after the 10 s gap
    assert.deepEqual(r.segments[1], { index: 1, srcStartMs: 8000, srcEndMs: 13000, rate: 2, outStartMs: 16000, outEndMs: 18500 });
    const objs = objects(r.osuText);
    assert.deepEqual(objs.map((o) => o.t), [2000, 2500, 4000, 17000, 18000]);
    assert.equal(objs[2].end, 5000);
    assert.equal(r.totalMs, 18500);
});

test("each map gets a red line on its own beat grid, SV is carried over, the gap is a break", () => {
    const r = buildMarathon([{ osuText: A, rate: 1 }, { osuText: B, rate: 2 }], { gapMs: 10000, leadMs: 2000, tailMs: 1000 });
    const tp = section(r.osuText, "TimingPoints");
    // map 1: first beat at or after 1000 → 1000 (+0) → out 0, 500 ms beat
    assert.equal(tp[0], "0,500,4,2,0,60,1,0");
    // map 2: beats every 400 ms from 200; first beat ≥ 8000 is 8200 → out 16000 + 200/2 = 16100, beat 200 ms at 2x
    assert.ok(tp.includes("16100,200,4,2,0,60,1,0"), tp.join(" | "));
    assert.ok(tp.includes("17500,-50,4,2,0,60,0,0"));
    assert.ok(section(r.osuText, "Events").includes("2,6000,16000"));
});

test("metadata names the marathon and lists what is in it", () => {
    const r = buildMarathon([{ osuText: A, rate: 1 }, { osuText: B, rate: 1.5 }],
        { gapMs: 5000, title: "Gamma Dan", audioFilename: "audio.mp3", background: "bg.png", od: 8, hp: 7 });
    assert.ok(r.osuText.includes("Title:Gamma Dan"));
    assert.ok(r.osuText.includes("AudioFilename: audio.mp3"));
    assert.ok(r.osuText.includes('0,0,"bg.png",0,0'));
    assert.ok(r.osuText.includes("CircleSize:4"));
    assert.ok(r.osuText.includes("OverallDifficulty:8"));
    assert.deepEqual(r.list.map((e) => e.label), ["Art - First [Hard]", "Art - Second [Hard] 1.5x"]);
});

test("a map without notes is refused by name, in either language", () => {
    const empty = map({ title: "Silence", bpm: 120, offset: 0, notes: [] });
    assert.throws(() => buildMarathon([{ osuText: empty, rate: 1 }]), { message: "в карте «Silence» нет нот" });
    setLang("en");
    try {
        assert.throws(() => buildMarathon([{ osuText: empty, rate: 1 }]), { message: "the map “Silence” has no notes" });
    } finally {
        setLang("ru");
    }
});

test("cutRange gives the same cut buildMarathon makes, and the cut length", async () => {
    const { cutRange } = await import("../src/rate/marathon.js");
    const r = buildMarathon([{ osuText: A, rate: 1 }, { osuText: B, rate: 2 }], { gapMs: 10000, leadMs: 2000, tailMs: 1000 });
    for (const [i, text] of [A, B].entries()) {
        const cut = cutRange(text, { leadMs: 2000, tailMs: 1000 });
        assert.equal(cut.srcStartMs, r.segments[i].srcStartMs);
        assert.equal(cut.srcEndMs, r.segments[i].srcEndMs);
        assert.equal(cut.cutMs, r.segments[i].srcEndMs - r.segments[i].srcStartMs);
    }
    // buildMarathon's defaults (2 s lead, 1 s tail) are cutRange's
    assert.deepEqual(cutRange(A), { srcStartMs: 1000, srcEndMs: 7000, cutMs: 6000 });
    // a note in the first 2 s: the cut starts at 0
    const early = map({ title: "Early", bpm: 120, offset: 0, notes: [[500, 0], [900, 1]] });
    assert.deepEqual(cutRange(early), { srcStartMs: 0, srcEndMs: 1900, cutMs: 1900 });
    assert.equal(cutRange(map({ title: "Silence", bpm: 120, offset: 0, notes: [] })), null);
    assert.equal(cutRange("not a map"), null);
});

test("buildMarathon's output stays byte for byte the same", () => {
    const r = buildMarathon([{ osuText: A, rate: 1 }, { osuText: B, rate: 1.5 }],
        { gapMs: 5000, title: "Gamma Dan", audioFilename: "audio.mp3", background: "bg.png", od: 8, hp: 7 });
    const hash = createHash("sha256").update(r.osuText).digest("hex");
    assert.equal(hash, BUILD_HASH);
});
