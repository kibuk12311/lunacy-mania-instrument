// The mapper style from the request to the model (0.9.5): generateLearnedMap hands request.style to the row source
// (`style` for the XGB source, cond.style for an infill source), the map says which style it was made with only when
// the model has it, and the worker's generate job passes the request through to the model that ran.
import test from "node:test";
import assert from "node:assert/strict";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { randomInfillModel } from "../../src/gen/nn/infillModel.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { chartInfo } from "../../src/core/features.js";
import { createGeneratorJobs } from "../../app/generatorJobs.js";
import { clickTrack } from "../fixtures/clickTrack.js";

const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
const singles = [1, 2, 4, 8];
const rolling = {};
for (const a of [0, ...singles]) for (const b of [0, ...singles]) rolling[`${a},${b},1`] = Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10]));
// a mapper whose every continuation is the jump 5 (columns 1 and 3)
const fives = {};
for (const a of [0, ...singles, 5]) for (const b of [0, ...singles, 5]) for (const n of [1, 2]) fives[`${a},${b},${n}`] = { 5: 40 };
const STYLES = [{ key: "n:five", name: "Five", maps: 40 }, { key: "u:9", name: "u:9", maps: 3 }];
const xgb = {
    kind: "xgb-v3", features: AUDIO_FEATURES, families: FAMILIES, note: { baseline: [0], classes: [0, 1], iterations: [] },
    size: { baseline: [2, 0, -3, -5], classes: [1, 2, 3, 4], iterations: [] }, pattern: { Stream: rolling },
    styles: STYLES, stylePattern: { "n:five": { Stream: fives } }, styleBias: { "n:five": 0 },
};
const perSecond = async (text) => {
    const info = chartInfo(text, 1);
    return { kind: "ok", numeric: Math.round((info.noteCount / Math.max(1, info.durationSec)) * 10) / 10, top3: [{ name: "Rolls", share: 1 }] };
};
const song = clickTrack({ bpm: 150, offsetMs: 400, seconds: 40 });
const envelope = onsetEnvelope(song.samples, song.sampleRate);
const input = (style, range = { lo: 3, hi: 4 }) => ({
    timing: { sections: [{ timeMs: 400, bpm: 150, meter: 4 }], bpm: 150, offsetMs: 400 }, envelope, durationMs: 40000,
    request: { range, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 4, ...(style === undefined ? {} : { style }) },
    meta: { title: "t", audioFilename: "a.mp3" },
});
const share = (text, mask) => {
    const rows = parseRows(text);
    return rows.filter((r) => r.mask === mask).length / Math.max(1, rows.length);
};

// a row source that records what prepare is given and makes single notes
function recorder(infill) {
    const prepares = [];
    let k = 0;
    return {
        prepares,
        source: {
            kind: infill ? "nn-v2" : "fake", caps: { infill },
            prepare(args) {
                prepares.push(args);
                return { begin() {}, snapshot: () => ({}), restore() {}, step: (i, _o, _c, _r, _w, fixed) => (Number.isInteger(fixed) ? fixed : i % 2 ? 0 : singles[k++ % 4]) };
            },
        },
    };
}

test("the request's style reaches the XGB source as `style` and an infill source as cond.style", async () => {
    for (const infill of [false, true]) {
        const rec = recorder(infill);
        const out = await generateLearnedMap(input("u:9"), perSecond, { ...xgb, kind: infill ? "nn-v2" : "xgb-v3" }, { source: rec.source });
        assert.ok(rec.prepares.length >= 1);
        for (const args of rec.prepares) {
            if (infill) {
                assert.equal(args.cond.style, "u:9");
                assert.equal("style" in args, false);
            } else {
                assert.equal(args.style, "u:9");
                assert.equal(args.cond, undefined);
            }
        }
        assert.equal(out.style, "u:9", "the map names the style it was made with");
    }
    // no style: the source gets null (or nothing), the map names none
    const rec = recorder(false);
    const out = await generateLearnedMap(input(null), perSecond, xgb, { source: rec.source });
    assert.equal(rec.prepares[0].style, undefined);
    assert.equal("style" in out, false);
    const nn = recorder(true);
    await generateLearnedMap(input(undefined), perSecond, { ...xgb, kind: "nn-v2" }, { source: nn.source });
    assert.equal(nn.prepares[0].cond.style ?? null, null);
});

test("a style the model does not have is not claimed by the map", async () => {
    const { styles: _s, stylePattern: _p, styleBias: _b, ...plain } = xgb;
    const out = await generateLearnedMap(input("n:five"), perSecond, plain, { source: recorder(false).source });
    assert.equal("style" in out, false);
});

test("XGB end to end: the style's own tables change the notes (more of its jump), no style keeps today's map", async () => {
    const { styles: _s, stylePattern: _p, styleBias: _b, ...plain } = xgb;
    const today = await generateLearnedMap(input(null), perSecond, plain);
    const none = await generateLearnedMap(input(null), perSecond, xgb);
    const styled = await generateLearnedMap(input("n:five"), perSecond, xgb);
    assert.equal(none.osuText, today.osuText, "no style: the same map as a model without styles");
    assert.notEqual(styled.osuText, none.osuText);
    assert.ok(share(styled.osuText, 5) > share(none.osuText, 5) + 0.2, `share of 5: ${share(styled.osuText, 5).toFixed(2)} vs ${share(none.osuText, 5).toFixed(2)}`);
    assert.equal(styled.style, "n:five");
});

test("nn-v2 end to end (random tiny weights): two styles give two different maps from the same seed", async () => {
    const TINY = { d: 8, enc_layers: 1, enc_heads: 2, enc_ffn: 16, dec_d: 8, dec_layers: 1, dec_heads: 2, dec_ffn: 16, lane_hidden: 8, win: 4, dec_win: 4, cross_win: 3, n_glob: 1 };
    const nn = { ...randomInfillModel(TINY, { seed: 5, std: 1.5, styles: STYLES }), features: ["onset", "low", "mid", "high", "energy", "phase"] };
    const wide = { lo: 1, hi: 9 };
    const a = await generateLearnedMap(input("n:five", wide), perSecond, nn);
    const b = await generateLearnedMap(input("u:9", wide), perSecond, nn);
    const again = await generateLearnedMap(input("u:9", wide), perSecond, nn);
    assert.equal(b.osuText, again.osuText, "the same style and seed: the same map");
    assert.notEqual(a.osuText, b.osuText);
    assert.equal(a.style, "n:five");
    assert.equal(b.style, "u:9");
});

test("the worker's generate job passes the style to the model the choice loads; the classic fallback has none", async () => {
    const seen = [];
    const learned = { generateLearnedMap: async (inp, _a, model, opts) => { seen.push({ style: inp.request.style, model }); return generateLearnedMap(inp, perSecond, model, opts); } };
    const modules = {
        "../src/audio/onset.js": { envelopeFromTransfer: () => envelope },
        "../src/gen/generateLearned.js": learned,
    };
    const { styles: _s, stylePattern: _p, styleBias: _b, ...classic } = xgb;
    const files = { "mapper-xgb3.json": xgb, "mapper.json": { ...classic, kind: undefined } };
    const jobs = createGeneratorJobs({
        load: async (spec) => modules[spec] ?? import(new URL(spec, new URL("../../app/", import.meta.url))),
        readModel: async (name) => { if (!files[name]) throw new Error("ENOENT"); return files[name]; },
        analyze: perSecond, devModels: null,
    });
    const run = (modelSize) => jobs.run("generate", { ...input("n:five"), envelope: {}, request: { ...input("n:five").request, modelSize } });
    const made = await run("xgb3");
    assert.equal(made.kind, "generated", made.message);
    assert.equal(seen.at(-1).model, xgb);
    assert.equal(seen.at(-1).style, "n:five");
    assert.equal(made.style, "n:five");
    assert.deepEqual(made.modelInfo.styles.map((s) => s.key), ["n:five", "u:9"]);
    const fell = await run("auto");
    assert.equal(fell.kind, "generated", fell.message);
    assert.equal("style" in fell, false, "the classic model has no styles: the map claims none");
});
