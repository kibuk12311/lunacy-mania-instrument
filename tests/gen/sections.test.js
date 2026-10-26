import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateMap } from "../../src/gen/generate.js";
import { chartInfo } from "../../src/core/features.js";
import { dropSong } from "../fixtures/dropSong.js";

const notesIn = (text, fromMs, toMs) => text.split(/\r?\n/).filter((l) => /^\d+,192,\d+,/.test(l))
    .map((l) => Number(l.split(",")[2])).filter((t) => t >= fromMs && t < toMs).length;

for (const target of [6, 12]) {
    test(`light part is clearly lighter than the drops (target ${target})`, async () => {
        const env = onsetEnvelope(dropSong({}), 22050);
        const fake = async (text) => ({ kind: "ok", numeric: chartInfo(text, 1).noteCount / 250 });
        const r = await generateMap({
            timing: { bpm: 180, offsetMs: 300 }, envelope: env, durationMs: 90000,
            request: { target, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 3 },
            meta: { title: "t", audioFilename: "a.mp3" },
        }, fake);
        const loud = (notesIn(r.osuText, 5000, 28000) + notesIn(r.osuText, 62000, 85000)) / 2;
        const quiet = notesIn(r.osuText, 32000, 58000) * (23 / 26);
        assert.ok(quiet < loud * 0.65, `quiet ${quiet.toFixed(0)} vs loud ${loud.toFixed(0)}`);
        assert.ok(quiet > 0, "the light part still has notes");
    });
}
