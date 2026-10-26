import test from "node:test";
import assert from "node:assert/strict";
import { pickCandidate, compareStage2, candidateSeed, resolveCritic, MIN_CANDIDATES, STAGE2_TOP } from "../../src/gen/candidates.js";
import { deriveSeed } from "../../src/gen/rng.js";
import { heuristicCritic } from "../../src/gen/critic.js";

// A stand-in candidate loop: candidate k's "rows" are just its index; stage 1 and the judge read from tables.
function setup({ s1 = [], judge = {}, n = 8, deadlineMs = 4000, clock = null } = {}) {
    const built = [];
    const analysed = [];
    const progress = [];
    let t = 0;
    const now = clock ?? (() => t);
    return {
        built, analysed, progress,
        tick: (ms) => { t += ms; },
        run: (extra = {}) => pickCandidate({
            n, deadlineMs, now,
            first: { k: 0, seed: 100, rows: [0], result: { kind: "ok", numeric: judge[0]?.n ?? 5 } },
            build: (k) => {
                built.push(k);
                return { seed: 100 + k, rows: [k] };
            },
            stage1: (rows) => ({ kind: "heuristic", score: s1[rows[0]] ?? 0, features: [rows[0]] }),
            analyze: async (rows) => {
                analysed.push(rows[0]);
                return { kind: "ok", numeric: judge[rows[0]]?.n ?? 5 };
            },
            judge: (c) => ({
                inside: (judge[c.k]?.inside ?? true) ? 1 : 0,
                patternScore: judge[c.k]?.pattern ?? 0.8,
                msdFit: judge[c.k]?.msdFit ?? null,
                issues: judge[c.k]?.issues ?? 0,
            }),
            onProgress: (p) => progress.push(p),
            ...extra,
        }),
    };
}

test("candidate seeds: k = 0 is the note seed itself, the others are derived with 0xC0DE", () => {
    assert.equal(candidateSeed(77, 0), 77);
    assert.equal(candidateSeed(77, 3), deriveSeed(77, 0xc0de, 3));
    assert.notEqual(candidateSeed(77, 1), candidateSeed(77, 2));
});

test("stage 1 picks the top 3 for an analysis; the search best is always compared (its analysis is free)", async () => {
    const s = setup({ s1: [-3, 0.5, 2, -1, 1.5, 0.1, -2, 0.2] });
    const out = await s.run();
    assert.deepEqual(s.built, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(s.analysed.sort(), [1, 2, 4], "the 3 best by stage 1, without re-analysing the search best");
    assert.equal(out.winner.k, 2);
    assert.equal(out.of, 8);
    assert.equal(out.analysed, STAGE2_TOP + 1);
    assert.deepEqual(s.progress.filter((p) => p.phase === "candidates").map((p) => p.i), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(s.progress.filter((p) => p.phase === "candidates").every((p) => p.n === 8));
    assert.ok(s.progress.some((p) => p.phase === "critic"));
});

test("stage 2 order: in range, pattern score to 0.05, stage 1 + 0.5·msdFit, fewer issues", () => {
    const c = (k, o) => ({ k, inside: 1, pattern: 16, s2: 0, issues: 0, ...o });
    const sorted = (list) => [...list].sort(compareStage2).map((x) => x.k);
    assert.deepEqual(sorted([c(0, { inside: 0, pattern: 20, s2: 9 }), c(1)]), [1, 0]);
    assert.deepEqual(sorted([c(0, { s2: 5 }), c(1, { pattern: 17 })]), [1, 0]);
    assert.deepEqual(sorted([c(0, { issues: 0 }), c(1, { s2: 0.2, issues: 5 })]), [1, 0]);
    assert.deepEqual(sorted([c(0, { issues: 2 }), c(1, { issues: 1 })]), [1, 0]);
    assert.deepEqual(sorted([c(3), c(1)]), [1, 3], "a full tie keeps the lower candidate");
});

test("msdFit: none (model without msdPrior) orders by stage 1; a prior picks the closer MSD on a stage-1 tie", async () => {
    const tie = setup({ s1: [0, 1, 1, 1], n: 4, judge: { 1: { msdFit: null }, 2: { msdFit: null }, 3: { msdFit: null } } });
    assert.equal((await tie.run()).winner.k, 1);
    const prior = setup({ s1: [0, 1, 1, 1], n: 4, judge: { 0: { msdFit: -9 }, 1: { msdFit: -2 }, 2: { msdFit: -0.5 }, 3: { msdFit: -1 } } });
    assert.equal((await prior.run()).winner.k, 2);
});

test("an out-of-range candidate never beats an in-range search best", async () => {
    const s = setup({ s1: [-5, 3, 3, 3, 3, 3, 3, 3], judge: { 0: { inside: true, pattern: 0.5 }, 1: { inside: false, pattern: 1 }, 2: { inside: false, pattern: 1 }, 3: { inside: false, pattern: 1 }, 4: { inside: false }, 5: { inside: false }, 6: { inside: false }, 7: { inside: false } } });
    const out = await s.run();
    assert.equal(out.winner.k, 0);
});

test("the time box stops at the deadline but builds at least 4", async () => {
    const s = setup({ n: 12, deadlineMs: 100 });
    const out = await s.run({ build: (k) => { s.built.push(k); s.tick(80); return { seed: k, rows: [k] }; } });
    assert.equal(out.of, MIN_CANDIDATES);
    assert.deepEqual(s.built, [1, 2, 3]);
    const roomy = setup({ n: 12, deadlineMs: 1000 });
    const r = await roomy.run({ build: (k) => { roomy.built.push(k); roomy.tick(80); return { seed: k, rows: [k] }; } });
    assert.equal(r.of, 13 - 1, "12 built within 1000 ms at 80 ms each would be 960 ms: all of them");
    const tight = setup({ n: 3, deadlineMs: 1 });
    const t = await tight.run({ build: (k) => { tight.built.push(k); tight.tick(80); return { seed: k, rows: [k] }; } });
    assert.equal(t.of, 3, "fewer than 4 asked for: all of them");
});

test("resolveCritic: a loaded critic as it is, a critic.json loaded, nothing (or a broken file) → the heuristic one", () => {
    const c = heuristicCritic();
    assert.equal(resolveCritic(c), c);
    assert.equal(resolveCritic(null).kind, "heuristic");
    assert.equal(resolveCritic({ kind: "critic-v1", features: [] }).kind, "heuristic");
});
