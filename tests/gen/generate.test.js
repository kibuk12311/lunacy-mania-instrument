import test from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../../src/gen/generate.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { chartInfo } from "../../src/core/features.js";
import { setLang } from "../../src/i18n/i18n.js";

// Envelope of a steady song: an onset on every 1/8, accents on beats, for `seconds`.
function steadyEnvelope({ bpm, offsetMs, seconds }) {
    const hop = 256 / 22050;
    const frames = Math.round(seconds / hop);
    const values = new Float32Array(frames);
    const eighth = 60 / bpm / 2;
    for (let t = offsetMs / 1000, k = 0; t < seconds; t += eighth, k += 1) {
        const f = Math.round(t / hop);
        if (f < frames) values[f] = k % 2 === 0 ? 1 : 0.6;
    }
    return { values, hopSec: hop, frameTimeSec: (f) => f * hop };
}

const base = (over = {}) => ({
    timing: { bpm: 180, offsetMs: 400 },
    envelope: steadyEnvelope({ bpm: 180, offsetMs: 400, seconds: 120 }),
    durationMs: 120000,
    request: { target: 8, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.6, burst: 0.3, seed: 11, ...over },
    meta: { title: "Тест", audioFilename: "audio.mp3" },
});

test("search converges on the target with a monotone fake analyzer", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 300 });
    const r = await generateMap(base({ target: 6 }), fake);
    assert.ok(Math.abs(r.result.numeric - 6) <= 0.15, `got ${r.result.numeric}`);
    assert.equal(r.reachable, true);
});

test("unreachable target is reported with the closest result", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: Math.min(5, chartInfo(text, 1).noteCount / 300) });
    const r = await generateMap(base({ target: 12 }), fake);
    assert.equal(r.reachable, false);
    assert.ok(r.result.numeric <= 5);
});

test("real analyzer: jumpstream map lands on the requested dan", async () => {
    const r = await generateMap(base({ target: 7 }), analyzeChart);
    assert.equal(r.result.kind, "ok");
    assert.ok(Math.abs(r.result.numeric - 7) <= 0.3, `got ${r.result.numeric}`);
    assert.equal(r.result.primary, "Jumpstream");
    assert.ok(r.osuText.includes("Version:"));
});

test("real analyzer: chordjack request reads as chordjack", async () => {
    const r = await generateMap(base({ target: 9, patterns: [{ name: "Chordjack", share: 1 }] }), analyzeChart);
    assert.equal(r.result.kind, "ok");
    assert.ok(Math.abs(r.result.numeric - 9) <= 0.4 || !r.reachable, `got ${r.result.numeric}`);
    assert.match(r.result.primary, /jack/i);
});

test("success means the same label as requested, not just a near number", async () => {
    // 13.1 reads "Gamma mid", 13.2 reads "Gamma mid/high": a 0.1 miss must not count as done.
    const fake = async (text) => {
        const n = chartInfo(text, 1).noteCount;
        return { kind: "ok", numeric: Math.round((12 + n / 2000) * 10) / 10 };
    };
    const r = await generateMap(base({ target: 13.2 }), fake);
    assert.equal(r.result.numeric, 13.2, `got ${r.result.numeric}`);
    assert.equal(r.reachable, true);
});

test("in English the difficulty name uses the English dan label", async () => {
    const fake = async () => ({ kind: "ok", numeric: 0.2 });
    setLang("en");
    try {
        const r = await generateMap(base({ target: 0.3 }), fake);
        assert.equal(r.version, "below dan 1 Jumpstream");
        assert.ok(r.osuText.includes("Version:below dan 1 Jumpstream"));
    } finally {
        setLang("ru");
    }
    const ru = await generateMap(base({ target: 0.3 }), fake);
    assert.equal(ru.version, "ниже 1 дана Jumpstream");
});

test("the rule-based fallback answers in the v3 shape, part by part", async () => {
    const fake = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 300, top3: [{ name: "Jumpstream", share: 1 }] });
    const parts = [
        { startMs: 0, endMs: 40000, kind: "drop" },
        { startMs: 40000, endMs: 60000, kind: "break", empty: true },
        { startMs: 60000, endMs: 120000, kind: "drop", patterns: [{ name: "Chordjack", share: 1 }] },
    ];
    const progress = [];
    const r = await generateMap(base({ target: 6, parts }), fake, { onProgress: (p) => progress.push(p.phase) });
    assert.equal(r.engine, "rules");
    assert.equal(r.parts.length, 3);
    assert.equal(r.parts[1].empty, true);
    assert.equal(r.parts[1].noteCount, 0);
    assert.deepEqual(r.parts[2].families, ["Chordjack"]);
    const times = r.osuText.split(/\r?\n/).filter((l) => /^\d+,192,\d+,/.test(l)).map((l) => Number(l.split(",")[2]));
    assert.ok(!times.some((t) => t >= 40000 && t < 60000));
    assert.match(r.osuText, /\/\/Break Periods\r\n2,\d+,\d+/);
    for (const key of ["stats", "issues", "grid", "retries", "planSeed", "noteSeed", "knob"]) assert.ok(key in r, key);
    assert.deepEqual(r.retries, { blocks: 0, dan: null });
    assert.ok(progress.includes("search") && progress.includes("describe"));
});
