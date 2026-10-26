import test from "node:test";
import assert from "node:assert/strict";
import {
    familyOf, rowJaccard, repeatConsistency, repeatGap, divisorF1, beatGridStats, percentile, pairedBootstrap,
    summarize, verdict, isCollapse, formatSummaryTable, phaseTimer,
} from "../../tools/eval/compare.mjs";

const rowsAt = (list) => list.map(([t, mask]) => ({ t, mask }));

test("pattern names map to the generator's families; unknown names fall back to Jumpstream", () => {
    assert.equal(familyOf("Minitrills"), "Stream");
    assert.equal(familyOf("Rolls"), "Stream");
    assert.equal(familyOf("Chordjacks"), "Chordjack");
    assert.equal(familyOf("Longjacks"), "Jack");
    assert.equal(familyOf("Jumptrill"), "Jumpstream");
    assert.equal(familyOf("Dense Chordstream"), "Chordjack");
    assert.equal(familyOf(undefined), "Jumpstream");
    assert.equal(familyOf("Something new"), "Jumpstream");
});

test("row Jaccard of a repeat: an exact copy is 1, a mirrored copy 0, a half copy 1/3", () => {
    const a = [[0, 1], [100, 2], [200, 4], [300, 8]];
    const copy = rowsAt([...a, ...a.map(([t, m]) => [t + 1000, m])]);
    assert.equal(rowJaccard(copy, 0, 1000, 400), 1);
    const mirror = (m) => [0, 1, 2, 3].reduce((x, c) => x | ((m >> c) & 1) << (3 - c), 0);
    const mirrored = rowsAt([...a, ...a.map(([t, m]) => [t + 1000, mirror(m)])]);
    assert.equal(rowJaccard(mirrored, 0, 1000, 400), 0);
    const half = rowsAt([...a, [1000, 1], [1100, 2], [1200, 1], [1300, 1]]);
    assert.equal(rowJaccard(half, 0, 1000, 400), 2 / 6);
    // a few ms of jitter still matches; empty on both sides gives null
    assert.equal(rowJaccard(rowsAt([[0, 1], [1004, 1]]), 0, 1000, 400), 1);
    assert.equal(rowJaccard(rowsAt([[5000, 1]]), 0, 1000, 400), null);
});

test("repeat consistency gap is |gen − human| over the same repeats, null without repeats", () => {
    const human = rowsAt([[0, 1], [100, 2], [1000, 1], [1100, 2]]); // J = 1
    const gen = rowsAt([[0, 1], [100, 2], [1000, 4], [1100, 2]]); // J = 1/3
    const repeats = [{ aMs: 0, bMs: 1000, lenMs: 400 }];
    assert.equal(repeatConsistency(human, repeats), 1);
    assert.equal(repeatConsistency(gen, repeats), 1 / 3);
    assert.ok(Math.abs(repeatGap(gen, human, repeats) - 2 / 3) < 1e-12);
    assert.equal(repeatGap(gen, human, []), null);
    assert.equal(repeatGap(gen, human, undefined), null);
});

test("beat grid stats and divisor F1 on off-1/4 beats", () => {
    const beats = [0, 1, 2, 3].map((k) => ({ t: k * 600, beatMs: 600 }));
    // beat 0: 1/4 rows, beat 1: 1/8 rows, beat 2: 1/3 rows, beat 3 empty
    const human = rowsAt([[0, 1], [150, 2], [600, 1], [675, 2], [750, 4], [1200, 1], [1400, 2], [1600, 4]]);
    const h = beatGridStats(human, beats);
    assert.deepEqual([...h.labels], [4, 8, 3, 4]);
    assert.equal(h.active, 3);
    assert.equal(h.offQuarter, 2 / 3);
    assert.equal(h.triplet, 1 / 3);
    // generated: 1/4 everywhere → no off-1/4 beat found
    const genQ = beatGridStats(rowsAt([[0, 1], [600, 1], [1200, 1]]), beats);
    assert.equal(divisorF1(h.labels, genQ.labels), 0);
    // same grids → 1; the right beat on the wrong grid does not count
    assert.equal(divisorF1(h.labels, h.labels), 1);
    assert.equal(divisorF1(h.labels, Uint8Array.from([4, 8, 6, 4])), 0.5);
    // no off-1/4 beat on either side → null
    assert.equal(divisorF1(Uint8Array.from([4, 4]), Uint8Array.from([4, 4])), null);
});

test("percentile, paired bootstrap and collapse", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
    assert.equal(percentile([], 0.5), null);
    const pairs = Array.from({ length: 30 }, (_, i) => [0.5 + (i % 3) * 0.01, 0.6 + (i % 3) * 0.01]);
    const ci = pairedBootstrap(pairs, { iters: 500, seed: 3 });
    assert.ok(Math.abs(ci.mean - 0.1) < 1e-9);
    assert.ok(ci.lo > 0.09 && ci.hi < 0.11);
    assert.deepEqual(pairedBootstrap(pairs, { iters: 500, seed: 3 }), ci, "seeded = reproducible");
    const noisy = Array.from({ length: 40 }, (_, i) => [0.5, 0.5 + (i % 2 ? 0.2 : -0.2)]);
    const c2 = pairedBootstrap(noisy, { iters: 500, seed: 1 });
    assert.ok(c2.lo < 0 && c2.hi > 0);
    assert.equal(pairedBootstrap([], {}).mean, null);
    assert.equal(isCollapse({ dan: 9.6, numeric: 2.6 }), true);
    assert.equal(isCollapse({ dan: 9.6, numeric: 7.1 }), false);
    assert.equal(isCollapse({ dan: 9.6, numeric: null }), true);
});

const rec = (over) => ({
    ok: true, engine: "A", snaps: "q4", form: "range", seed: 1, song: 0, osu: true, trills: false,
    dan: 10, numeric: 10, reachable: true, f1: 0.7, corr: 0.6, pattern: 0.8, viol: 2, jackLoop: 0.01, humanJackLoop: 0.02,
    maxStreamyJack: 2, offQuarterRows: 0, humanOffQuarter: 0.1, divF1: null, repeatGap: null, ms: 1000, ...over,
});

test("summary per engine × snaps × form, with views and paired CIs against the baseline", () => {
    const records = [];
    for (let song = 0; song < 6; song += 1) {
        for (const seed of [1, 2]) {
            records.push(rec({ song, seed, engine: "A", f1: 0.6, reachable: song < 3, ms: 1000 + song }));
            records.push(rec({ song, seed, engine: "B", f1: 0.7, reachable: song < 4, numeric: song === 5 ? 2.5 : 10, osu: song % 2 === 0, ms: 2000 }));
        }
    }
    records.push(rec({ song: 9, engine: "B", ok: false, error: "boom" }));
    const s = summarize(records, { baseline: "A", views: ["all", "osu"], iters: 200 });
    const a = s.find((x) => x.view === "all" && x.engine === "A");
    const b = s.find((x) => x.view === "all" && x.engine === "B");
    assert.equal(a.runs, 12);
    assert.equal(a.songs, 6);
    assert.equal(a.hits, 6);
    assert.equal(a.hitRate, 0.5);
    assert.ok(Math.abs(a.f1 - 0.6) < 1e-12);
    assert.equal(b.failed, 1);
    assert.equal(b.collapses, 2);
    assert.ok(Math.abs(b.ci.f1.mean - 0.1) < 1e-9);
    assert.ok(b.ci.f1.lo > 0);
    assert.equal(a.ci, null, "the baseline has no CI against itself");
    assert.equal(a.p95Ms, 1005);
    const bOsu = s.find((x) => x.view === "osu" && x.engine === "B");
    assert.equal(bOsu.songs, 3);
    const table = formatSummaryTable(s.filter((x) => x.view === "all"));
    assert.match(table, /\| A \| q4 \| range \|/);
    assert.match(table, /6\/12/);
    assert.match(table, /n\/a/); // no repeat gap available
});

test("verdict follows the ship rule: each check against the baseline", () => {
    const base = { hitRate: 0.5, pattern: 0.8, viol: 2, f1: 0.7, jackLoop: 0.02, humanJackLoop: 0.02, p95Ms: 5000 };
    const same = verdict(base, { ...base });
    assert.equal(same.ship, true);
    assert.equal(same.checks.length, 6);
    const worse = verdict(base, { ...base, f1: 0.69, viol: 2.5, p95Ms: 9000 });
    assert.equal(worse.ship, false);
    assert.deepEqual(worse.checks.filter((c) => !c.ok).map((c) => c.name).sort(), ["f1", "p95", "violations"]);
    // pattern may drop by 0.01, jack loops may reach human × 1.2
    assert.equal(verdict(base, { ...base, pattern: 0.7905, jackLoop: 0.024 }).ship, true);
    assert.equal(verdict(base, { ...base, pattern: 0.785 }).ship, false);
    assert.equal(verdict(base, { ...base, p95Ms: 9000 }, { p95BudgetMs: 9500 }).ship, true);
});

test("phase timer gives the time since each progress event to that event's phase", () => {
    let now = 0;
    const timer = phaseTimer(() => now);
    now = 100; timer.on({ phase: "prepare" });
    now = 110; timer.on({ phase: "search" });
    now = 300; timer.on({ phase: "search" });
    now = 500; timer.on({ phase: "retry" });
    now = 520; timer.on({ phase: "describe" });
    now = 600;
    assert.deepEqual(timer.done(), { prepare: 110, search: 390, retry: 20, describe: 80 });
});
