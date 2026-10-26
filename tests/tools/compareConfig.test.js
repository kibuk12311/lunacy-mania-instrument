import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseConfig, configFor, requestExtras, optionStatus, availability, CONFIG_DEFAULTS, parseCompareArgs } from "../../tools/eval/compare.mjs";

test("no config gives the v3 defaults (candidates 1, no critic, no repeats, no style, no infill)", () => {
    for (const raw of [undefined, null, "", "{}", {}]) {
        const cfg = parseConfig(raw);
        assert.deepEqual({ ...cfg, per: undefined }, { ...CONFIG_DEFAULTS, per: undefined });
        assert.deepEqual(cfg.per, {});
    }
    assert.equal(CONFIG_DEFAULTS.candidates, 1);
    assert.deepEqual(requestExtras(parseConfig(null)), {});
});

test("config accepts every planned option, from JSON text or an object", () => {
    const cfg = parseConfig(JSON.stringify({ candidates: 12, critic: "critic.json", repeats: true, style: "Evening", infill: true, deadlineMs: 2500 }), { baseDir: "A:/cfg" });
    assert.equal(cfg.candidates, 12);
    assert.equal(cfg.critic, path.resolve("A:/cfg", "critic.json"));
    assert.equal(cfg.repeats, true);
    assert.equal(cfg.style, "Evening");
    assert.equal(cfg.infill, true);
    assert.equal(cfg.deadlineMs, 2500);
    assert.deepEqual(requestExtras(cfg), { candidates: 12, repeats: true, style: "Evening" });
    assert.equal(parseConfig({ critic: null, style: null }).critic, null);
});

test("config refuses bad values and unknown keys (typos), naming the field", () => {
    const bad = [
        [{ candidates: 0 }, /candidates/], [{ candidates: 21 }, /candidates/], [{ candidates: 2.5 }, /candidates/],
        [{ candidates: "8" }, /candidates/], [{ repeats: "yes" }, /repeats/], [{ style: 3 }, /style/], [{ style: "" }, /style/],
        [{ critic: 7 }, /critic/], [{ infill: 1 }, /infill/], [{ deadlineMs: -1 }, /deadlineMs/],
        [{ candidate: 4 }, /unknown.*candidate/], [{ per: { B: { per: {} } } }, /per/], [{ per: [] }, /per/], ["[1,2]", /object/],
        ["{not json", /JSON/],
    ];
    for (const [raw, re] of bad) assert.throws(() => parseConfig(raw), re, JSON.stringify(raw));
    // comment keys are allowed
    assert.equal(parseConfig({ _note: "B0 run", $schema: "x" }).candidates, 1);
});

test("per-engine overrides merge over the shared options", () => {
    const cfg = parseConfig({ candidates: 4, per: { B: { candidates: 8, critic: "c.json" }, rules: { candidates: 1 } } }, { baseDir: "A:/x" });
    assert.equal(configFor(cfg, "A").candidates, 4);
    assert.equal(configFor(cfg, "A").critic, null);
    assert.equal(configFor(cfg, "B").candidates, 8);
    assert.equal(configFor(cfg, "B").critic, path.resolve("A:/x", "c.json"));
    assert.equal(configFor(cfg, "rules").candidates, 1);
    assert.equal(configFor(cfg, "B").per, undefined);
});

test("an option the generator does not answer to is reported as not available", () => {
    const cfg = parseConfig({ candidates: 8, critic: "c.json", repeats: true, style: "X" }, { baseDir: "A:/x" });
    // today's v3 answer: no critic block, no structure
    const plain = { ok: true, osuText: "", knob: 0 };
    assert.deepEqual(optionStatus(cfg, plain), {
        candidates: "not available", critic: "not available", repeats: "not available", style: "not available", infill: "off",
    });
    // a wave-3 answer with the candidate loop, critic-v1, structure and a style term
    const ml = { ok: true, critic: { kind: "critic-v1", of: 8, picked: 3, style: -0.4 }, structure: { phrases: [], repeats: [] } };
    assert.deepEqual(optionStatus(cfg, ml), { candidates: "used", critic: "used", repeats: "used", style: "used", infill: "off" });
    // heuristic critic only: candidates used, the critic file not
    const heur = { critic: { kind: "heuristic", of: 8, style: null } };
    const s = optionStatus(cfg, heur);
    assert.equal(s.candidates, "used");
    assert.equal(s.critic, "not available");
    assert.equal(s.style, "not available");
    // defaults are "off" whatever the answer says
    assert.deepEqual(optionStatus(parseConfig(null), ml), { candidates: "off", critic: "off", repeats: "off", style: "off", infill: "off" });
    // the infill mode is the tool's own: used when the tool ran it
    assert.equal(optionStatus(parseConfig({ infill: true }), plain, { infillRan: true }).infill, "used");
});

test("availability over many runs: used, not available or partial", () => {
    const cfg = parseConfig({ candidates: 4 });
    const yes = { critic: { kind: "heuristic", of: 4 } };
    const no = {};
    assert.equal(availability(cfg, [yes, yes]).candidates, "used");
    assert.equal(availability(cfg, [no, no]).candidates, "not available");
    assert.equal(availability(cfg, [yes, no, no]).candidates, "partial (1/3)");
    assert.equal(availability(cfg, []).candidates, "not available");
    assert.equal(availability(cfg, [yes]).repeats, "off");
});

test("command line: models, rules, seeds, forms, snaps and the picks or held-out source", () => {
    const a = parseCompareArgs(["--a", "m1.json", "--b", "m2.json", "--picks", "p.json", "--seeds", "1,2,3", "--form", "both", "--snaps", "q4,all", "--rules", "--jobs", "3", "--limit", "5"]);
    assert.deepEqual(a.engines.map((e) => [e.label, e.kind, e.path ?? null]), [["A", "model", "m1.json"], ["B", "model", "m2.json"], ["rules", "rules", null]]);
    assert.deepEqual(a.seeds, [1, 2, 3]);
    assert.deepEqual(a.forms, ["range", "target"]);
    assert.deepEqual(a.snaps, ["q4", "all"]);
    assert.equal(a.picks, "p.json");
    assert.equal(a.jobs, 3);
    assert.equal(a.limit, 5);
    const b = parseCompareArgs(["--model", "v1=models/mapper.json", "--model", "v15=A:/m/mapper15.json", "--heldout", "180", "--corpus", "c.jsonl"]);
    assert.deepEqual(b.engines.map((e) => [e.label, e.path]), [["v1", "models/mapper.json"], ["v15", "A:/m/mapper15.json"]]);
    assert.equal(b.heldout, 180);
    assert.deepEqual(b.seeds, [1, 2, 3]);
    assert.deepEqual(b.forms, ["range"]);
    assert.deepEqual(b.snaps, ["auto"]);
    assert.equal(b.baseline, "v1");
    assert.throws(() => parseCompareArgs(["--picks", "p.json"]), /model/);
    assert.throws(() => parseCompareArgs(["--a", "m.json"]), /picks|heldout/);
    assert.throws(() => parseCompareArgs(["--a", "m.json", "--picks", "p", "--form", "strict"]), /form/);
    assert.throws(() => parseCompareArgs(["--a", "m.json", "--picks", "p", "--snaps", "q5"]), /snaps/);
    assert.throws(() => parseCompareArgs(["--a", "m.json", "--picks", "p", "--seeds", "1,x"]), /seeds/);
    assert.throws(() => parseCompareArgs(["--a", "m.json", "--picks", "p", "--bogus", "1"]), /unknown/);
    assert.throws(() => parseCompareArgs(["--model", "a=m.json", "--model", "a=n.json", "--picks", "p"]), /twice/);
    assert.equal(parseCompareArgs(["--a", "m.json", "--picks", "p", "--baseline", "rules", "--rules"]).baseline, "rules");
    assert.throws(() => parseCompareArgs(["--a", "m.json", "--picks", "p", "--baseline", "Z"]), /baseline/);
});

test("blind-pack and bench-gen command lines", async () => {
    const { parseBlindArgs } = await import("../../tools/blind-pack.mjs");
    const { parseBenchArgs } = await import("../../tools/bench-gen.mjs");
    const b = parseBlindArgs(["--picks", "h.json", "--a", "v1=models/mapper.json", "--b", "rules", "--songs", "0,4"]);
    assert.deepEqual([b.a.label, b.a.kind, b.a.path], ["v1", "model", "models/mapper.json"]);
    assert.deepEqual([b.b.label, b.b.kind], ["rules", "rules"]);
    assert.deepEqual(b.songs, [0, 4]);
    assert.equal(b.n, 5);
    assert.equal(parseBlindArgs(["--picks", "h.json", "--a", "m1.json", "--b", "m2.json"]).b.label, "B");
    assert.throws(() => parseBlindArgs(["--picks", "h.json", "--a", "x=m1.json", "--b", "x=m2.json"]), /different labels/);
    assert.throws(() => parseBlindArgs(["--a", "m1.json", "--b", "m2.json"]), /picks/);
    assert.throws(() => parseBlindArgs(["--picks", "h.json", "--a", "m1.json"]), /--b/);
    const c = parseBenchArgs(["--picks", "p.json", "--model", "v1=m.json", "--rules", "--limit", "4", "--min-sec", "180", "--budget", "9.5"]);
    assert.deepEqual(c.engines.map((e) => e.label), ["v1", "rules"]);
    assert.equal(c.limit, 4);
    assert.equal(c.minSec, 180);
    assert.equal(c.budgetMs, 9500);
    assert.throws(() => parseBenchArgs(["--picks", "p.json"]), /engine/);
    assert.throws(() => parseBenchArgs(["--picks", "p.json", "--rules", "--snaps", "x"]), /snaps/);
    assert.throws(() => parseBenchArgs(["--picks", "p.json", "--rules", "--what", "1"]), /unknown/);
});
