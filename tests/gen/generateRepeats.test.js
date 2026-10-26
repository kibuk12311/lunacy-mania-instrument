import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync, stemsFromTransfer, stemsToTransfer } from "../../src/audio/stems.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { barsOf } from "../../src/gen/songParts.js";
import { ECHO_DEFAULTS } from "../../src/gen/echo.js";
import { goldenModel } from "../fixtures/familyGolden.js";
import { sectionSong } from "../fixtures/stemTracks.js";

// G2 (ML addendum §2.3): an A B A song (8 bars each, 160 BPM) with its light stems, as the renderer sends them.
const song = sectionSong(["A", "B", "A"], { bpm: 160 });
const stems = stemsFromTransfer(stemsToTransfer(computeStemsSync(song.samples, song.sampleRate)));
const envelope = onsetEnvelope(song.samples, song.sampleRate);
const durationMs = Math.round((song.samples.length / song.sampleRate) * 1000);
const BAR_MS = (4 * 60000) / 160;
const LAG_MS = 16 * BAR_MS;
const inRange = async () => ({ kind: "ok", numeric: 6, top3: [{ name: "Jumpstream", share: 1 }] });
const inputOf = (extra = {}, input = {}) => ({
    timing: { bpm: 160, offsetMs: 0 }, envelope, durationMs, stems,
    request: { range: { lo: 5.5, hi: 6.5 }, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 1, ...extra },
    meta: { title: "repeats", audioFilename: "a.mp3" },
    ...input,
});
const opts = (extra = {}) => ({ patternsOf: () => [{ name: "Jumpstream", share: 1 }], ...extra });
const MIRROR = (m) => ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3);

test("repeats: false gives v3 output bit for bit, with or without stems", async () => {
    const { stems: _drop, ...noStems } = inputOf();
    const v3 = await generateLearnedMap(noStems, inRange, goldenModel, opts());
    const off = await generateLearnedMap(inputOf({ repeats: false }), inRange, goldenModel, opts());
    assert.equal(off.osuText, v3.osuText);
    assert.equal(v3.structure, undefined, "no stems, no structure");
    assert.ok(off.structure.phrases.length > 0, "with stems the structure is answered (for the window)");
    // repeats asked for without stems: nothing to repeat by, v3 again
    const noStemsOn = await generateLearnedMap({ ...noStems, request: { ...noStems.request, repeats: true } }, inRange, goldenModel, opts());
    assert.equal(noStemsOn.osuText, v3.osuText);
});

test("with repeats the second A copies the first one's rows except in varied bars; about a quarter of them vary", async () => {
    let varied = 0;
    let echoed = 0;
    let matched = 0;
    let compared = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
        const debug = {};
        const out = await generateLearnedMap(inputOf({ repeats: true, seed }), inRange, goldenModel, opts({ debug }));
        const s = debug.structure;
        const { plan } = debug.echo;
        assert.ok(out.structure.repeats.some((r) => Math.abs(r.bMs - r.aMs - LAG_MS) < 2), JSON.stringify(out.structure.repeats));
        const rows = parseRows(out.osuText, 4);
        const at = new Map(rows.map((r) => [Math.round(r.t), r.mask]));
        const bars = barsOf(debug.slots);
        const retriedSlots = new Set(debug.retried.flatMap((k) => {
            const b = debug.blocks.find((x) => x.index === k);
            return Array.from({ length: b.i1 - b.i0 }, (_, j) => b.i0 + j);
        }));
        for (let b = 0; b < bars.length; b += 1) {
            if (!(s.echoOf[b] >= 0)) continue;
            if (plan.fill[b]) {
                assert.equal(plan.varied[b], 1, "the fill bar is always varied");
                continue;
            }
            echoed += 1;
            varied += plan.varied[b];
            if (plan.varied[b]) continue;
            const src = bars[s.echoOf[b]];
            const lag = debug.slots[bars[b].i0].t - debug.slots[src.i0].t;
            for (let i = bars[b].i0; i < bars[b].i1; i += 1) {
                if (retriedSlots.has(i)) continue;
                const t = debug.slots[i].t;
                const mine = at.get(t) ?? 0;
                const theirs = at.get(t - lag) ?? 0;
                compared += 1;
                if (mine === (plan.mirrored[b] ? MIRROR(theirs) : theirs)) matched += 1;
            }
        }
    }
    assert.ok(echoed > 100, `echoed bars ${echoed}`);
    assert.ok(Math.abs(varied / echoed - ECHO_DEFAULTS.pVar) <= 0.1, `varied share ${(varied / echoed).toFixed(3)}`);
    // a copy the guard vetoes is re-sampled, so a few slots may differ; everything else is the first A's
    assert.ok(matched / compared > 0.97, `matched ${matched}/${compared}`);
    assert.ok(compared > 1000, `compared ${compared}`);
});

test("copies the guard vetoes are re-sampled, never kept", async () => {
    const debug = {};
    await generateLearnedMap(inputOf({ repeats: true, seed: 3 }), inRange, goldenModel, opts({ debug }));
    assert.ok(debug.echoStats.copied > 100, JSON.stringify(debug.echoStats));
    assert.ok(debug.echoStats.builds > 1);
});

test("a phrase-aligned family switch is never in the middle of a phrase (mixed, with repeats)", async () => {
    const patterns = [{ name: "Stream", share: 0.4 }, { name: "Jumpstream", share: 0.3 }, { name: "Handstream", share: 0.3 }];
    for (let seed = 1; seed <= 6; seed += 1) {
        const debug = {};
        await generateLearnedMap(inputOf({ repeats: true, seed, mix: "mixed", patterns }), inRange, goldenModel, opts({ debug }));
        const s = debug.structure;
        const bars = barsOf(debug.slots);
        const starts = new Set(s.phrases.map((p) => bars[p.bar].i0));
        for (let i = 1; i < debug.assign.length; i += 1) {
            if (debug.assign[i] && debug.assign[i - 1] && debug.assign[i] !== debug.assign[i - 1]) assert.ok(starts.has(i), `seed ${seed}: switch at slot ${i}`);
        }
        // and no block runs across a phrase start
        for (const b of debug.blocks) for (const i of starts) assert.ok(!(i > b.i0 && i < b.i1) || b.i1 - b.i0 < 64, `block ${b.index} [${b.i0}, ${b.i1}) crosses ${i}`);
    }
});
