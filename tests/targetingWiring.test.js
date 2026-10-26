// The dan targeting's wiring (0.9.8): the worker job wraps the learned generator in src/gen/targeting.js (and runs it
// once when that module is missing), main sends the time budget and passes the targeting and the ceiling to the
// window (which may not set the budget itself), and the card says what happened.
import test from "node:test";
import assert from "node:assert/strict";
import { createGeneratorJobs } from "../app/generatorJobs.js";
import { registerCreateIpc } from "../app/createIpc.js";
import { createGeneratedStore } from "../app/generatedStore.js";
import { setLang } from "../src/i18n/i18n.js";

const onset = { envelopeFromTransfer: (e) => e };
const modelFile = { kind: "xgb-v1", grid: "q4", metrics: { maps: 10 } };
const realLoad = (extra) => async (spec) => (spec in extra ? extra[spec] : import(new URL(spec, new URL("../app/", import.meta.url)).href));

test("the generate job boosts a map that fell short and reports the targeting; plain maps in range are left alone", async () => {
    const seen = [];
    const learned = {
        generateLearnedMap: async (_input, _analyze, _model, opts) => {
            seen.push(opts.boost ?? null);
            const numeric = opts.boost ? 13 : 8;
            return { osuText: "x", result: { kind: "ok", numeric }, reachable: numeric >= 12.5, ...(opts.boost ? { boost: opts.boost } : {}) };
        },
    };
    const progress = [];
    const jobs = createGeneratorJobs({
        load: realLoad({ "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": learned }),
        readModel: async (name) => (name === "mapper.json" ? modelFile : null), analyze: async () => ({ kind: "ok", numeric: 0 }), devModels: null,
    });
    const out = await jobs.run("generate", { envelope: {}, request: { range: { lo: 12.5, hi: 13.5 } }, targetBudgetMs: 60000 }, (p) => progress.push(p));
    assert.equal(out.kind, "generated");
    assert.equal(out.result.numeric, 13);
    assert.ok(out.targeting.rung > 0);
    assert.ok(seen.length >= 2 && seen[0] === null && seen[1] !== null);
    assert.ok(progress.some((p) => p.phase === "boost"));
    seen.length = 0;
    const inRange = await jobs.run("generate", { envelope: {}, request: { range: { lo: 7.5, hi: 8.5 } } }, () => {});
    assert.equal(inRange.result.numeric, 8);
    assert.deepEqual(seen, [null]);
    assert.equal(inRange.targeting.rung, 0);
});

test("without the targeting module the generator runs once, exactly as before", async () => {
    const seen = [];
    const learned = { generateLearnedMap: async (_i, _a, _m, opts) => { seen.push(opts); return { osuText: "x", result: { kind: "ok", numeric: 2 } }; } };
    const modules = { "../src/audio/onset.js": onset, "../src/gen/generateLearned.js": learned };
    const jobs = createGeneratorJobs({
        load: async (spec) => { if (!(spec in modules)) throw new Error("missing"); return modules[spec]; },
        readModel: async (name) => (name === "mapper.json" ? modelFile : null), analyze: () => {}, devModels: null,
    });
    const out = await jobs.run("generate", { envelope: {}, request: { range: { lo: 12.5, hi: 13.5 } } }, () => {});
    assert.equal(out.kind, "generated");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].boost, undefined);
    assert.equal(out.targeting, undefined);
});

function ipc(answer) {
    const handlers = {};
    const calls = [];
    registerCreateIpc({
        ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { handlers[c] = fn; } },
        generatorClient: { async generate(payload) { calls.push(payload); return answer; } },
        generatedStore: createGeneratedStore(), log: () => {},
        styleCatalog: { async bySize() { return { auto: [] }; } },
    });
    const event = { sender: { send() {}, isDestroyed: () => false } };
    return { calls, generate: (req) => handlers["generate-map"](event, req) };
}
const req = (over = {}) => ({
    jobId: "j", audioPath: "C:/s.mp3", title: "S", durationMs: 60000,
    envelope: { values: new Float32Array(8), hopSec: 0.0116, frameOffsetSec: 0.01 },
    timing: { sections: [{ timeMs: 0, bpm: 135, meter: 4 }], bpm: 135, offsetMs: 0 },
    request: { range: { lo: 12.5, hi: 13.5 }, patterns: [{ name: "Jumpstream", share: 1 }], seed: 1, ...over },
});

test("main sends the targeting budget (the window cannot), and passes the targeting and the ceiling on", async () => {
    const { calls, generate } = ipc({
        kind: "generated", osuText: "osu file format v14\n\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n", version: "v", result: { kind: "ok", numeric: 9.9 },
        reachable: false, engine: "learned", modelInfo: { kind: "xgb-v1" },
        targeting: { attempts: [{ rung: 0 }, { rung: 3 }], rung: 3 }, ceiling: { numeric: 9.9, rate: 1.2, rateNumeric: 12.6 },
    });
    const answer = await generate(req({ targetBudgetMs: 1 }));
    assert.equal(answer.ok, true);
    assert.equal(calls[0].targetBudgetMs, 30000);
    assert.equal("targetBudgetMs" in calls[0].request, false);
    assert.deepEqual(answer.targeting, { rung: 3, tries: 2 });
    assert.deepEqual(answer.ceiling, { numeric: 9.9, rate: 1.2, rateNumeric: 12.6 });
});

test("the card says the song's ceiling with the rate to try, or that the dan was pulled up", async () => {
    const { targetingLine, cardLines } = await import("../app/renderer/resultView.js");
    setLang("ru");
    try {
        const c = targetingLine({ ceiling: { numeric: 11.4, rate: 1.2, rateNumeric: 12.6 } });
        assert.equal(c.cls, "warn");
        assert.equal(c.text, "Для этой песни максимум ≈ Alpha high — попробуй рейт 1.2x (тогда ≈ Gamma low)");
        assert.match(targetingLine({ ceiling: { numeric: 4.3, rate: null } }).text, /^Для этой песни максимум ≈ 4 mid\/high:/);
        assert.match(targetingLine({ targeting: { rung: 2, tries: 3 } }).text, /шаг 2 из 3/);
        assert.match(targetingLine({ targeting: { rung: -1 } }).text, /легче/);
        assert.equal(targetingLine({ targeting: { rung: 0 } }), null);
        assert.equal(targetingLine({}), null);
        setLang("en");
        assert.equal(targetingLine({ ceiling: { numeric: 11.4, rate: 1.2, rateNumeric: 12.6 } }).text, "This song tops out at ≈ Alpha high — try rate 1.2x (≈ Gamma low then)");
        const lines = cardLines({ result: { kind: "ok", numeric: 11.4, label: "Alpha high" }, reachable: false, range: { lo: 12.5, hi: 13.5 }, noteCount: 900, ceiling: { numeric: 11.4, rate: 1.2, rateNumeric: 12.6 } }, null, { detailed: false });
        assert.ok(lines.some((l) => l.cls === "warn" && l.text.startsWith("This song tops out")));
    } finally {
        setLang("ru");
    }
});
