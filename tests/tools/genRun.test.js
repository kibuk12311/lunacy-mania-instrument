import test from "node:test";
import assert from "node:assert/strict";
import { timingOfChart, songFromText, snapsOf, buildInput, infillPlan, scoreRun } from "../../tools/eval/genRun.mjs";
import { parseConfig } from "../../tools/eval/compare.mjs";
import { makeChart } from "../fixtures/makeChart.js";

const chart = (opts) => makeChart({ kind: "jumpstream", bpm: 180, seconds: 40, ...opts });
const withRed = (text, lines) => text.replace(/\[TimingPoints\]\r?\n[^\r\n]+/, `[TimingPoints]\n${lines.join("\n")}`);

test("the human red lines become the timing; one before 0 moves forward by whole beats, absurd BPMs are dropped", () => {
    const t = timingOfChart(withRed(chart(), ["-500,400,4,1,0,100,1,0", "20000,60000,4,1,0,100,1,0", "30000,300,4,1,0,100,1,0"]));
    assert.deepEqual(t.sections.map((s) => [s.timeMs, Math.round(s.bpm)]), [[300, 150], [30000, 200]]);
    assert.throws(() => timingOfChart(withRed(chart(), ["0,1,4,1,0,100,1,0"])), /red line/);
});

test("a song from the chart text: family from the primary pattern, osu!/trills/variable tags, off-1/4 share", () => {
    const s = songFromText({ osuPath: "x.osu", dan: 9.6, primary: "Minitrills" }, chart(), { audioMs: 20000 });
    assert.equal(s.family, "Stream");
    assert.equal(s.durationMs, 20000, "the audio length caps the song");
    assert.equal(s.tags.trills, true);
    assert.equal(s.tags.osu, true, "picks without a source are Songs maps");
    assert.equal(s.tags.variable, false);
    assert.equal(s.human.offQuarter, 0);
    assert.equal(songFromText({ osuPath: "x.osu", dan: 5, primary: "Chordjacks", source: "etterna" }, chart()).tags.osu, false);
    assert.equal(snapsOf("auto", s).join(","), "4");
    assert.equal(snapsOf("all", s).join(","), "4,3,6,8");
    assert.equal(snapsOf("auto", { human: { offQuarter: 0.4 } }).join(","), "4,3,6,8");
    assert.throws(() => snapsOf("q5", s), /snaps/);
});

test("the request: range form is the human dan ± 0.5, target form the label; wave-3 fields only when asked", () => {
    const s = songFromText({ osuPath: "x.osu", dan: 7.2, primary: "Jumpstream" }, chart());
    const plain = buildInput(s, { form: "range", seed: 2, snaps: [4], cfg: parseConfig(null) });
    assert.deepEqual(plain.request.range, { lo: 6.7, hi: 7.7 });
    assert.equal(plain.request.target, undefined);
    assert.deepEqual(plain.request.patterns, [{ name: "Jumpstream", share: 1 }]);
    assert.equal(plain.request.seed, 2);
    for (const k of ["candidates", "repeats", "style", "parts"]) assert.ok(!(k in plain.request), k);
    assert.equal(plain.locked, undefined);
    assert.equal(plain.personal, null);
    assert.equal(plain.deadlineMs, 4000);
    const strict = buildInput(s, { form: "target", seed: 1, snaps: [4, 3, 6, 8], cfg: parseConfig({ candidates: 8, repeats: true, style: "S" }) });
    assert.equal(strict.request.target, 7.2);
    assert.equal(strict.request.range, undefined);
    assert.deepEqual(strict.request.snaps, [4, 3, 6, 8]);
    assert.equal(strict.request.candidates, 8);
    assert.equal(strict.request.repeats, true);
    assert.equal(strict.request.style, "S");
});

test("infill plan: 8 parts end to end, the even ones locked to the human rows", () => {
    const s = songFromText({ osuPath: "x.osu", dan: 7, primary: "Jumpstream" }, chart());
    const plan = infillPlan(s);
    assert.equal(plan.parts.length, 8);
    assert.equal(plan.parts[0].startMs, 0);
    assert.equal(plan.parts.at(-1).endMs, s.durationMs);
    plan.parts.slice(1).forEach((p, k) => assert.equal(p.startMs, plan.parts[k].endMs));
    assert.equal(plan.locked.ranges.length, 4);
    assert.ok(plan.locked.rows.length > 0 && plan.locked.rows.every((r) => plan.inLocked(r.t)));
    assert.ok(plan.locked.rows.length < s.humanRows.length);
    const input = buildInput(s, { form: "range", seed: 5, snaps: [4], cfg: parseConfig({ infill: true }), infill: plan });
    assert.equal(input.request.parts.length, 8);
    assert.equal(input.locked.planSeed, 5);
    assert.equal(input.locked.ranges.length, 4);
});

test("scoring the human map against itself: F1 1, density corr 1, no collapse metrics broken", () => {
    const text = chart();
    const s = songFromText({ osuPath: "x.osu", dan: 7, primary: "Jumpstream" }, text);
    const response = { osuText: text, result: { kind: "ok", numeric: 7.1, top3: [{ name: "Jumpstream", share: 0.8 }] }, reachable: true, knob: 0.5, grid: { 4: 1, 3: 0, 6: 0, 8: 0 } };
    const m = scoreRun(s, response);
    assert.equal(m.f1, 1);
    assert.ok(Math.abs(m.corr - 1) < 1e-9 || m.corr === 0, `corr ${m.corr}`);
    assert.equal(m.numeric, 7.1);
    assert.equal(m.reachable, true);
    assert.equal(m.pattern, 0.8);
    assert.equal(m.offQuarterRows, 0);
    assert.equal(m.divF1, null);
    assert.equal(m.repeatGap, null);
    assert.equal(m.critic, null);
    assert.equal(m.rows, s.humanRows.length);
    // with a structure answer the repeat gap is measured (the same rows → 0) and the critic block is kept
    const withMl = scoreRun(s, { ...response, structure: { repeats: [{ aMs: 1000, bMs: 5000, lenMs: 2000 }] }, critic: { kind: "heuristic", score: 1, picked: 2, of: 8 } });
    assert.equal(withMl.repeatGap, 0);
    assert.deepEqual(withMl.critic, { kind: "heuristic", score: 1, picked: 2, of: 8 });
    // infill: F1 on the free parts only, issues near the seams counted
    const plan = infillPlan(s);
    const inf = scoreRun(s, response, { infill: plan });
    assert.equal(inf.f1Free, 1);
    assert.ok(Number.isInteger(inf.seamIssues));
    // an empty answer scores 0, not NaN
    const empty = scoreRun(s, { osuText: "", result: { kind: "too-short" }, reachable: false });
    assert.equal(empty.f1, 0);
    assert.equal(empty.numeric, null);
});
