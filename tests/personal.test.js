// The personal reranker (src/gen/personal.js, addendum §2.7): IRLS on separable votes reaches a leave-one-out AUC
// of 1, tagged votes move the prior (a few «too jacky» dislikes give negative jack weights), the §2.7 activity rule,
// and the model it makes is the one src/gen/critic.js scores with.
import test from "node:test";
import assert from "node:assert/strict";
import { fitPersonal, aucOf, priorCentre, RATING_TAGS, TAGS_DOWN, TAGS_UP, TAG_PRIORS, MAX_ITER } from "../src/gen/personal.js";
import { personalActive, personalLogit, PERSONAL_RULE } from "../src/gen/critic.js";
import { CRITIC_FEATURES } from "../src/gen/criticFeatures.js";

// a small seeded generator (mulberry32) and a normal from it
function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
    return { next, normal };
}

const NAMES = ["f_signal", "f_noise1", "f_noise2", "f_noise3", "f_noise4", "f_noise5"];

// votes whose first feature separates likes (+1.5) from dislikes (−1.5); the rest is noise
function separable(n, seed = 1) {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
        const vote = i % 2 ? 1 : -1;
        return { vote, tags: [], names: NAMES, features: NAMES.map((_, j) => (j === 0 ? vote * 1.5 + 0.3 * r.normal() : r.normal())) };
    });
}

test("the tags: the §2.7 table, downs then ups, each with a prior", () => {
    assert.deepEqual([...RATING_TAGS], ["tooJacky", "awkward", "boring", "offMusic", "tooDense", "tooSparse", "fun", "human", "comfy"]);
    assert.deepEqual([...TAGS_DOWN, ...TAGS_UP], [...RATING_TAGS]);
    for (const tag of RATING_TAGS) {
        const groups = TAG_PRIORS[tag];
        assert.ok(groups?.length, tag);
        // every tag names at least one real critic feature
        assert.ok(CRITIC_FEATURES.some((name) => groups.some(([re]) => re.test(name))), `${tag} matches no critic feature`);
    }
});

test("aucOf: ranks, ties as a half, null without both labels", () => {
    assert.equal(aucOf([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
    assert.equal(aucOf([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
    assert.equal(aucOf([0.5, 0.5], [0, 1]), 0.5);
    assert.equal(aucOf([0.3, 0.2, 0.4], [1, 0, 0]), 0.5);
    assert.equal(aucOf([1, 2], [1, 1]), null);
});

test("nothing to fit: no usable entry, or one sign only; entries without features are left out", async () => {
    assert.equal(await fitPersonal([]), null);
    assert.equal(await fitPersonal([{ vote: 1 }]), null);
    assert.equal(await fitPersonal(separable(10).map((e) => ({ ...e, vote: 1 }))), null);
    const mixed = [...separable(20), { vote: 1, tags: [], features: [], names: [] }, { vote: -1, tags: [], features: [1, 2], names: NAMES }];
    const model = await fitPersonal(mixed);
    assert.equal(model.n, 20, "the entry without features and the one with a wrong length are not counted");
});

test("separable votes: IRLS converges and the leave-one-out AUC is 1; the model is active and the critic scores with it", async () => {
    const entries = separable(30);
    const model = await fitPersonal(entries);
    assert.equal(model.v, 1);
    assert.deepEqual(model.names, NAMES);
    assert.equal(model.looAuc, 1);
    assert.equal(model.converged, true);
    assert.ok(model.iterations <= MAX_ITER);
    assert.equal(model.active, true);
    assert.ok(model.w[0] > 0.5, `the signal's weight ${model.w[0]}`);
    assert.ok(model.w.slice(1).every((w) => Math.abs(w) < model.w[0]), model.w.join(" "));
    assert.ok(Math.abs(model.weight - Math.min(PERSONAL_RULE.maxWeight, 30 / (30 + PERSONAL_RULE.weightHalf))) < 1e-6, String(model.weight));
    assert.equal(model.positives, 15);
    assert.equal(model.negatives, 15);
    // the critic's own check and logit (with the model's means and stds: no critic.json norm here)
    assert.equal(personalActive(model), true);
    const x = new Array(CRITIC_FEATURES.length).fill(0);
    const liked = personalLogit({ ...model, names: [CRITIC_FEATURES[0]], w: [model.w[0]], mean: [model.mean[0]], std: [model.std[0]] }, x.map((_, k) => (k === 0 ? 1.5 : 0)));
    const disliked = personalLogit({ ...model, names: [CRITIC_FEATURES[0]], w: [model.w[0]], mean: [model.mean[0]], std: [model.std[0]] }, x.map((_, k) => (k === 0 ? -1.5 : 0)));
    assert.ok(liked > disliked);
});

test("the critic's norm, when there is one, sets the means and stds and the feature list", async () => {
    const norm = { names: ["f_signal", "f_noise1"], mean: [0.5, 0], std: [2, 1] };
    const model = await fitPersonal(separable(24), { norm });
    assert.deepEqual(model.names, ["f_signal", "f_noise1"]);
    assert.deepEqual(model.mean, [0.5, 0]);
    assert.deepEqual(model.std, [2, 1]);
    assert.equal(model.looAuc, 1);
});

test("a few «too jacky» dislikes give negative jack weights through the tag prior", async () => {
    const names = ["w_jack_rate_mean", "w_minijack_p90", "map_longest_jack", "w_notes_per_beat_mean", "w_trill_mean", "map_div4"];
    const r = rng(7);
    const noise = () => names.map(() => r.normal());
    const entries = [
        ...Array.from({ length: 4 }, () => ({ vote: -1, tags: ["tooJacky"], names, features: noise() })),
        ...Array.from({ length: 4 }, () => ({ vote: 1, tags: [], names, features: noise() })),
    ];
    const m = priorCentre(names, entries);
    assert.deepEqual(Array.from(m), [-1, -1, -1, 0, 0, 0], "4 tagged votes × 0.25 on each jack feature");
    const model = await fitPersonal(entries);
    const jack = model.w.slice(0, 3);
    const rest = model.w.slice(3);
    assert.ok(jack.every((w) => w < -0.3), `jack weights ${jack.join(" ")}`);
    assert.ok(Math.min(...rest.map(Math.abs)) < Math.min(...jack.map(Math.abs)), `other weights ${rest.join(" ")}`);
    assert.equal(model.active, false, "8 votes are too few to use");
});

test("inactive below the thresholds: fewer than 12 votes, fewer than 4 of a sign, or a leave-one-out AUC under 0.6", async () => {
    const few = await fitPersonal(separable(11));
    assert.ok(few.looAuc > 0.9, `auc ${few.looAuc}`);
    assert.equal(few.active, false);
    assert.equal(few.weight, 0);
    assert.equal(personalActive(few), false, "the critic does not count it either");

    const lopsided = separable(40).filter((e, i) => e.vote === 1 || i < 6).slice(0, 23); // 3 dislikes
    const oneSided = await fitPersonal(lopsided);
    assert.equal(oneSided.negatives, 3);
    assert.equal(oneSided.active, false);

    const r = rng(3);
    const random = Array.from({ length: 40 }, (_, i) => ({ vote: i % 2 ? 1 : -1, tags: [], names: NAMES, features: NAMES.map(() => r.normal()) }));
    const noise = await fitPersonal(random);
    assert.ok(noise.looAuc < PERSONAL_RULE.minLooAuc, `noise auc ${noise.looAuc}`);
    assert.equal(noise.active, false);
});

test("entries whose feature lists differ are matched by name; a missing feature counts as the mean", async () => {
    const entries = separable(30);
    const older = ["f_signal", "f_noise1"];
    entries[0] = { ...entries[0], names: older, features: entries[0].features.slice(0, 2) };
    entries[1] = { ...entries[1], features: entries[1].features.map((v, j) => (j === 0 ? null : v)) };
    const model = await fitPersonal(entries);
    assert.deepEqual(model.names, NAMES, "the newest entry's list");
    assert.equal(model.n, 30);
    assert.ok(model.looAuc > 0.95);
});
