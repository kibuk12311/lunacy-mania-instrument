// N candidates per variant and the critic that picks one (ML addendum §2.1, stream G1). It runs after the global
// search and the dan retry, before the block retry:
// - candidate 0 is the search's best map itself (so candidates: 1 is v3 bit for bit); candidates 1..N−1 are rebuilt
//   at the same knob with noteSeed_k = deriveSeed(noteSeed, 0xC0DE, k) — the very build the search's evaluate(knob,
//   noteSeed_k) makes, so a run with candidates: 1 and that note seed lands on the same map when its search does;
// - stage 1 (every candidate, no analysis): the critic's score of the map's criticFeatures; the phase is time-boxed by
//   deadlineMs but always builds at least 4 (or all, when fewer were asked for);
// - stage 2: the top 3 by stage 1 get one analysis each; the search best, already analysed, is compared too. Order:
//   in range, then patternScore to 0.05, then stage 1 + 0.5·msdFit (msdFit = −‖msd − msdPrior‖₂ / 3, 0 without a
//   prior: src/gen/msdPrior.js), then fewer issues, then the lower k. In range first: the critic never trades away the
//   dan, and an out-of-range candidate never beats an in-range search best.
//
//   pickCandidate({ n, first, build(k) → { seed, rows, …}, stage1(rows) → { score, …, features }, analyze(rows) → result,
//                   judge(candidate) → { inside, patternScore, msdFit, issues }, deadlineMs, now, onProgress, buildMany?,
//                   estimate? })
//     → { winner, list, of, analysed, ms, batched, fit }   (winner/list items: { k, seed, rows, result?, s1, judged? })
// Progress: { phase: "candidates", i, n } after each candidate (i increasing), { phase: "critic", i, n } per analysis.
// buildMany(ks, { keepGoing }) (stream W, D3): the candidates k = 1 … n−1 built together (one batch on the GPU
// decoder), → their { seed, rows, … } in order (a missing one ends the list); keepGoing(done) is the deadline above
// for builds that must go on one by one (a GPU that failed mid-batch). Without it, one by one, as always.
// estimate(ks) → { batchMs, buildMs } or null: that batch's time, and one build's one by one. A batch takes about its
// rounds' time whatever its size, so the deadline cannot cut it short: it goes only when it is not slower than the loop
// would be (stageMs: the time box above with builds of buildMs each), else the loop, as without a GPU (batched: which
// one ran; fit: { batchMs, buildMs, stageMs } when there was an estimate).
import { deriveSeed } from "./rng.js";
import { criticFor, heuristicCritic } from "./critic.js";

export const CANDIDATE_SEED = 0xc0de;
export const MIN_CANDIDATES = 4;
export const STAGE2_TOP = 3;
export const PATTERN_STEP = 0.05;
export const MSD_WEIGHT = 0.5;
export const RETRY_CRITIC_WEIGHT = 0.1; // block-retry candidates: stage 1 next to the block's pattern score
export const DEFAULT_DEADLINE_MS = 4000;

export const candidateSeed = (noteSeed, k) => (k === 0 ? noteSeed : deriveSeed(noteSeed, CANDIDATE_SEED, k));

// opts.critic → a critic: one already loaded (it has score()), a critic.json object (loadCritic), or — with nothing,
// or a file that does not load — the heuristic critic (kind "heuristic": the play term alone).
export function resolveCritic(c) {
    if (c && typeof c.score === "function") return c;
    if (c && typeof c === "object") {
        try {
            return criticFor(c);
        } catch {
            return heuristicCritic();
        }
    }
    return heuristicCritic();
}

// Stage 2's comparison of two judged candidates ({ k, inside 0/1, pattern (score / 0.05, rounded), s2, issues }).
export function compareStage2(a, b) {
    return (b.inside - a.inside) || (b.pattern - a.pattern) || (b.s2 - a.s2) || (a.issues - b.issues) || (a.k - b.k);
}

const byStage1 = (a, b) => (b.s1.score - a.s1.score) || (a.k - b.k);

// The one-by-one stage's time with builds of buildMs each: candidate k (from 1) is built while k < minBuilt or the
// k − 1 before it took less than the deadline, so ⌈deadline / buildMs⌉ of them, at least minBuilt − 1, at most n − 1.
export function stageMs({ n, buildMs, deadlineMs = DEFAULT_DEADLINE_MS, minBuilt = MIN_CANDIDATES }) {
    if (!(buildMs > 0) || n < 2) return 0;
    return Math.min(n - 1, Math.max(minBuilt - 1, Math.ceil(deadlineMs / buildMs))) * buildMs;
}

export async function pickCandidate({ n, first, build, stage1, analyze, judge, deadlineMs = DEFAULT_DEADLINE_MS, now = () => performance.now(), onProgress = () => {}, minBuilt = MIN_CANDIDATES, top = STAGE2_TOP, buildMany = null, estimate = null }) {
    const t0 = now();
    const list = [{ ...first, k: 0, s1: stage1(first.rows) }];
    onProgress({ phase: "candidates", i: 0, n });
    const ks = Array.from({ length: Math.max(0, n - 1) }, (_, j) => j + 1);
    const guess = buildMany && n > 2 && estimate ? estimate(ks) : null;
    const fit = guess ? { batchMs: guess.batchMs, buildMs: guess.buildMs, stageMs: stageMs({ n, buildMs: guess.buildMs, deadlineMs, minBuilt }) } : null;
    const batched = Boolean(buildMany) && n > 2 && (!fit || fit.batchMs <= fit.stageMs);
    if (batched) {
        // the next build (k = done + 1) goes on while the sequential loop below would have built it
        const built = await buildMany(ks, { keepGoing: (done) => !(done + 1 >= minBuilt && now() - t0 >= deadlineMs) });
        for (let j = 0; j < ks.length && built[j]; j += 1) {
            list.push({ ...built[j], k: ks[j], s1: stage1(built[j].rows) });
            onProgress({ phase: "candidates", i: ks[j], n });
        }
    } else {
        for (let k = 1; k < n; k += 1) {
            if (k >= minBuilt && now() - t0 >= deadlineMs) break;
            const c = build(k);
            list.push({ ...c, k, s1: stage1(c.rows) });
            onProgress({ phase: "candidates", i: k, n });
        }
    }
    // stage 2: the best few by stage 1, and the search best (analysed already)
    const chosen = [...list].sort(byStage1).slice(0, top);
    if (!chosen.includes(list[0])) chosen.push(list[0]);
    const pending = chosen.filter((c) => !c.result);
    for (let j = 0; j < pending.length; j += 1) {
        onProgress({ phase: "critic", i: j, n: pending.length });
        pending[j].result = await analyze(pending[j].rows);
    }
    for (const c of chosen) {
        const j = judge(c);
        c.judged = {
            k: c.k,
            inside: j.inside ? 1 : 0,
            pattern: Math.round((Number(j.patternScore) || 0) / PATTERN_STEP),
            s2: c.s1.score + MSD_WEIGHT * (Number.isFinite(j.msdFit) ? j.msdFit : 0),
            issues: j.issues ?? 0,
            msdFit: Number.isFinite(j.msdFit) ? j.msdFit : null,
        };
    }
    chosen.sort((a, b) => compareStage2(a.judged, b.judged));
    return { winner: chosen[0], list, of: list.length, analysed: chosen.length, ms: now() - t0, batched, fit };
}
