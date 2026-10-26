import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { candidateSeed, MIN_CANDIDATES } from "../../src/gen/candidates.js";
import { CRITIC_FEATURES } from "../../src/gen/criticFeatures.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { chartInfo } from "../../src/core/features.js";
import { goldenModel } from "../fixtures/familyGolden.js";
import { partsSong, PARTS_SONG, PARTS_SONG_BPM, PARTS_SONG_OFFSET } from "../fixtures/partsSong.js";

// G1 (ML addendum §2.1): N candidates per variant, picked by the critic (the heuristic one without critic.json).
const envelope = onsetEnvelope(partsSong(), 22050);
const durationMs = PARTS_SONG.at(-1).endMs;
const stand = (scale) => async (text) => ({
    kind: "ok", numeric: Math.round((chartInfo(text, 1).noteCount / scale) * 100) / 100,
    top3: [{ name: "Jumpstream", share: 0.6 }, { name: "Chordjacks", share: 0.4 }],
});
const inputOf = (extra = {}, input = {}) => ({
    timing: { bpm: PARTS_SONG_BPM, offsetMs: PARTS_SONG_OFFSET }, envelope, durationMs,
    request: { range: { lo: 5.5, hi: 6.5 }, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, ...extra },
    meta: { title: "critic", audioFilename: "a.mp3" },
    ...input,
});
const opts = (extra = {}) => ({ patternsOf: () => [{ name: "Jumpstream", share: 1 }], ...extra });
const withoutMs = ({ ms: _ms, ...rest }) => rest;

test("candidates: 1 is v3 exactly: the same map, the request's note seed, no critic", async () => {
    const plain = await generateLearnedMap(inputOf(), stand(150), goldenModel, opts());
    const one = await generateLearnedMap(inputOf({ candidates: 1 }), stand(150), goldenModel, opts({ critic: { kind: "critic-v1" } }));
    assert.equal(one.osuText, plain.osuText);
    assert.equal(one.noteSeed, 7);
    assert.equal(one.critic, undefined);
    assert.equal(plain.critic, undefined);
});

test("N = 8: deterministic per seeds; the critic answers with the pick, its scores and its feature vector", async () => {
    const progress = [];
    const a = await generateLearnedMap(inputOf({ candidates: 8 }), stand(150), goldenModel, opts({ onProgress: (p) => progress.push(p) }));
    const b = await generateLearnedMap(inputOf({ candidates: 8 }), stand(150), goldenModel, opts());
    assert.equal(a.osuText, b.osuText);
    assert.deepEqual(withoutMs(a.critic), withoutMs(b.critic));
    assert.equal(a.critic.kind, "heuristic");
    assert.equal(a.critic.of, 8);
    assert.ok(a.critic.picked >= 0 && a.critic.picked < 8);
    assert.ok(a.critic.analysed >= 3 && a.critic.analysed <= 4);
    assert.ok(Number.isFinite(a.critic.score) && Number.isFinite(a.critic.play));
    assert.equal(a.critic.human, null);
    assert.equal(a.critic.fun, null);
    assert.equal(a.critic.features.length, CRITIC_FEATURES.length);
    assert.ok(Number.isFinite(a.critic.ms));
    assert.equal(a.noteSeed, candidateSeed(7, a.critic.picked));
    // progress: the candidates in order, then the critic's analyses
    const cand = progress.filter((p) => p.phase === "candidates");
    assert.deepEqual(cand.map((p) => p.i), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(cand.every((p) => p.n === 8));
    const firstCritic = progress.findIndex((p) => p.phase === "critic");
    assert.ok(firstCritic > progress.findIndex((p) => p.phase === "candidates" && p.i === 7));
    assert.ok(progress.findIndex((p) => p.phase === "retry") > firstCritic);
    // another seed gives another pick list
    const c = await generateLearnedMap(inputOf({ candidates: 8, seed: 8 }), stand(150), goldenModel, opts());
    assert.notEqual(c.osuText, a.osuText);
});

// A denser model and an analyser that puts every map in range: the search keeps its first attempt for any seed, so a
// run with candidates: 1 and the picked note seed searches its way to the same knob.
const dense = { ...goldenModel, note: { ...goldenModel.note, baseline: [5] } };
const inRange = async (text) => ({ kind: "ok", numeric: 6, top3: [{ name: "Jumpstream", share: 1 }], n: chartInfo(text, 1).noteCount });

// A stand-in critic that prefers denser maps (the heuristic one ties at 0 on maps the guard kept clean).
const NOTES = CRITIC_FEATURES.indexOf("map_notes_per_beat");
const denser = { kind: "test", styles: [], score: (x) => ({ kind: "test", score: x[NOTES], human: null, fun: null, play: 0, personal: null, style: null }) };

test("the picked noteSeed reproduces the map with candidates: 1", async () => {
    let checked = 0;
    for (const seed of [3, 4, 5, 6, 7, 8, 9, 10]) {
        const many = await generateLearnedMap(inputOf({ candidates: 8, seed }), inRange, dense, opts({ critic: denser }));
        if (many.critic.picked === 0) continue;
        assert.notEqual(many.noteSeed, seed);
        const again = await generateLearnedMap(inputOf({ candidates: 1, seed, noteSeed: many.noteSeed }), inRange, dense, opts());
        if (many.retries.blocks || again.retries.blocks) continue; // the critic's say in the block retry is candidates-only
        assert.equal(again.osuText, many.osuText, `seed ${seed}: picked ${many.critic.picked}`);
        assert.equal(again.knob, many.knob);
        checked += 1;
        if (checked >= 3) break;
    }
    assert.ok(checked >= 2, `only ${checked} seeds picked another candidate than the search best`);
});

test("the time box stops at the deadline but keeps at least 4 candidates", async () => {
    const early = await generateLearnedMap(inputOf({ candidates: 12 }), stand(150), goldenModel, opts({ deadlineMs: 0 }));
    assert.equal(early.critic.of, MIN_CANDIDATES);
    const fromInput = await generateLearnedMap(inputOf({ candidates: 12 }, { deadlineMs: 0 }), stand(150), goldenModel, opts());
    assert.equal(fromInput.critic.of, MIN_CANDIDATES);
    // a clock that runs 1 s per look: the 4 are built, then the 4 s deadline cuts the rest
    let t = 0;
    const slow = await generateLearnedMap(inputOf({ candidates: 12 }), stand(150), goldenModel, opts({ now: () => (t += 1000), deadlineMs: 4000 }));
    assert.ok(slow.critic.of >= MIN_CANDIDATES && slow.critic.of < 12, `built ${slow.critic.of}`);
    const roomy = await generateLearnedMap(inputOf({ candidates: 12 }), stand(150), goldenModel, opts({ deadlineMs: 60000 }));
    assert.equal(roomy.critic.of, 12);
});

test("an out-of-range candidate never beats an in-range search best", async () => {
    // the analyser keeps every map the search tried in range and puts every new one (the candidates) far out of it
    let searching = true;
    const flip = async (text) => ({ kind: "ok", numeric: searching ? 6 : 14, top3: [{ name: "Jumpstream", share: 1 }] });
    const out = await generateLearnedMap(inputOf({ candidates: 8 }), flip, dense, opts({
        onProgress: (p) => { if (p.phase === "candidates") searching = false; },
    }));
    assert.equal(out.critic.picked, 0);
    assert.equal(out.noteSeed, 7);
    assert.equal(out.reachable, true);
});

test("locked rows are identical in every candidate", async () => {
    const base = await generateLearnedMap(inputOf(), stand(150), goldenModel, opts());
    const part = base.parts.find((p) => p.kind === "drop");
    const rows = parseRows(base.osuText, 4).filter((r) => r.t >= part.startMs && r.t < part.endMs);
    assert.ok(rows.length > 20);
    const debug = {};
    const out = await generateLearnedMap(inputOf({ candidates: 8, seed: 21, parts: base.parts.map(({ startMs, endMs, kind }) => ({ startMs, endMs, kind })) }, {
        locked: { rows: rows.map((r) => ({ t: r.t, mask: r.mask })), ranges: [[part.startMs, part.endMs]], knob: base.knob, planSeed: 7 },
    }), stand(150), goldenModel, opts({ debug }));
    assert.equal(debug.candidates.length, 8);
    const key = (list) => list.filter((r) => r.t >= part.startMs && r.t < part.endMs).map((r) => `${r.t}:${r.mask}`).join(" ");
    const want = key(rows);
    for (const c of debug.candidates) assert.equal(key(c.rows), want, `candidate ${c.k}`);
    assert.equal(key(parseRows(out.osuText, 4)), want);
    // and the candidates differ outside the lock
    assert.ok(new Set(debug.candidates.map((c) => c.rows.map((r) => `${r.t}:${r.mask}`).join(" "))).size > 1);
});

test("a trained critic (critic-v1, the parity fixture) scores the candidates with its human head", async () => {
    const fixture = await readFile(new URL("../fixtures/critic-parity.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);
    if (!fixture) return;
    const out = await generateLearnedMap(inputOf({ candidates: 6 }), stand(150), goldenModel, opts({ critic: fixture.critic }));
    assert.equal(out.critic.kind, "critic-v1");
    assert.ok(out.critic.human > 0 && out.critic.human < 1);
    assert.equal(out.critic.of, 6);
});
