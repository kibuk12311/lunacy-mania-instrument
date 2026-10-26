import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCritic, heuristicCritic, criticFor, playTerm, personalLogit, personalActive, personalWeight, DEFAULT_BLEND, PERSONAL_RULE } from "../../src/gen/critic.js";
import { CRITIC_FEATURES, criticFeatures } from "../../src/gen/criticFeatures.js";
import { slotsForTiming } from "../../src/gen/grid.js";

const fixture = await readFile(new URL("../fixtures/critic-parity.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);
const trained = await readFile(new URL("../../models/critic.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);
const at = (name) => CRITIC_FEATURES.indexOf(name);
const vec = (values = {}) => {
    const x = new Float64Array(CRITIC_FEATURES.length).fill(NaN);
    for (const [k, v] of Object.entries(values)) x[at(k)] = v;
    return x;
};
// a probe vector in the order of the names it was made with (critic.norm.names) → today's CRITIC_FEATURES order
const toVector = (x, names) => {
    const out = new Float64Array(CRITIC_FEATURES.length).fill(NaN);
    names.forEach((n, k) => {
        const j = CRITIC_FEATURES.indexOf(n);
        if (j >= 0 && x[k] !== null) out[j] = x[k];
    });
    return out;
};
const probeNames = (json) => json.norm?.names ?? CRITIC_FEATURES;
const fromJson = (x, json = fixture?.critic) => toVector(x, probeNames(json));

test("the heuristic critic orders by issues and forced rows; its heads are null", () => {
    const c = heuristicCritic();
    assert.equal(c.kind, "heuristic");
    const clean = c.score(vec({ map_issues_per1000: 0, map_forced_per1000: 0 }));
    const some = c.score(vec({ map_issues_per1000: 5, map_forced_per1000: 0 }));
    const forced = c.score(vec({ map_issues_per1000: 5, map_forced_per1000: 40 }));
    assert.ok(clean.score > some.score && some.score > forced.score);
    assert.equal(some.play, -0.5);
    assert.equal(forced.play, -0.5 - 2);
    for (const r of [clean, some]) {
        assert.equal(r.human, null);
        assert.equal(r.fun, null);
        assert.equal(r.style, null);
        assert.equal(r.personal, null);
        assert.equal(r.kind, "heuristic");
    }
    assert.deepEqual(c.styles, []);
    assert.equal(criticFor(null).kind, "heuristic");
});

test("the heuristic critic scores real criticFeatures: a map with jack issues scores lower", () => {
    const slots = slotsForTiming({ bpm: 150, offsetMs: 0 }, 60000);
    const roll = slots.slice(0, 400).map((s, i) => ({ t: s.t, mask: 1 << (i % 4), i }));
    const lefty = slots.slice(0, 400).map((s, i) => ({ t: s.t, mask: [1, 2, 1, 2, 1, 4][i % 6], i }));
    const c = heuristicCritic();
    assert.ok(c.score(criticFeatures(roll, slots)).score > c.score(criticFeatures(lefty, slots)).score);
});

test("fixture critic: every score matches the Python reference within 1e-6", { skip: !fixture && "tests/fixtures/critic-parity.json missing" }, () => {
    const c = loadCritic(fixture.critic);
    assert.equal(c.kind, "critic-v1");
    assert.ok(fixture.probes.length >= 6);
    for (const [k, p] of fixture.probes.entries()) {
        const r = c.score(fromJson(p.x), { style: p.style, personal: p.personal ?? null });
        const close = (a, b, what) => {
            if (b === null) assert.equal(a, null, `${what} ${k}`);
            else assert.ok(Math.abs(a - b) <= 1e-6, `${what} ${k}: ${a} vs ${b}`);
        };
        close(r.human, p.expect.human, "human");
        close(r.fun, p.expect.fun, "fun");
        close(r.style, p.expect.style, "style");
        close(r.play, p.expect.play, "play");
        close(r.personal, p.expect.personal, "personal");
        close(r.score, p.expect.score, "score");
    }
});

test("missing heads give null fields and are not counted", { skip: !fixture && "fixture missing" }, () => {
    const full = loadCritic(fixture.critic);
    const noFun = loadCritic({ ...fixture.critic, fun: null });
    const noStyle = loadCritic({ ...fixture.critic, style: null });
    const p = fixture.probes.find((q) => q.style) ?? fixture.probes[0];
    const x = fromJson(p.x);
    const style = full.styles[0].key;
    const a = full.score(x, { style });
    const b = noFun.score(x, { style });
    assert.equal(b.fun, null);
    assert.ok(Math.abs(a.score - b.score - full.blend.wF * a.fun) < 1e-9);
    const c = noStyle.score(x, { style });
    assert.equal(c.style, null);
    assert.ok(Math.abs(a.score - c.score - full.blend.wS * a.style) < 1e-9);
    assert.deepEqual(noStyle.styles, []);
});

test("the style term is used only when a style is set (and known)", { skip: !fixture && "fixture missing" }, () => {
    const c = loadCritic(fixture.critic);
    const x = fromJson(fixture.probes[0].x);
    const none = c.score(x);
    const unknown = c.score(x, { style: "nobody at all" });
    const styled = c.score(x, { style: c.styles[0].key });
    assert.equal(none.style, null);
    assert.equal(unknown.style, null);
    assert.equal(unknown.score, none.score);
    assert.ok(styled.style <= 0);
    assert.ok(Math.abs(styled.score - none.score - c.blend.wS * styled.style) < 1e-9);
    assert.ok(c.styles.every((s) => typeof s.key === "string" && typeof s.name === "string" && Number.isInteger(s.maps)));
});

test("the personal term is used only when the personal model is active", () => {
    const c = heuristicCritic();
    const x = vec({ map_issues_per1000: 2, map_forced_per1000: 0, w_jack_rate_mean: 0.4 });
    const personal = { v: 1, names: ["w_jack_rate_mean"], w: [-2], b: 0.5, n: 30, positives: 14, negatives: 16, looAuc: 0.7, weight: 0.4, mean: [0.2], std: [0.1] };
    assert.ok(personalActive(personal));
    assert.ok(!personalActive({ ...personal, weight: 0 }));
    assert.ok(!personalActive({ ...personal, w: [] }));
    assert.ok(!personalActive(null));
    const z = personalLogit(personal, x, null);
    assert.ok(Math.abs(z - (0.5 - 2 * ((0.4 - 0.2) / 0.1))) < 1e-12);
    const off = c.score(x, { personal: { ...personal, weight: 0 } });
    const on = c.score(x, { personal });
    assert.equal(off.personal, null);
    assert.ok(Math.abs(on.personal - z) < 1e-12);
    assert.ok(Math.abs(on.score - off.score - 0.4 * z) < 1e-12);
    // a missing feature counts as the mean (z = 0)
    assert.equal(personalLogit(personal, vec({}), null), 0.5);
});

test("the personal model is active only by the §2.7 rule: n >= 12, >= 4 of each sign, leave-one-out AUC >= 0.6", () => {
    const p = { v: 1, names: ["w_jack_rate_mean"], w: [-2], b: 0, n: 12, positives: 4, negatives: 8, looAuc: 0.6, weight: 0.5 };
    assert.deepEqual(PERSONAL_RULE, { minVotes: 12, minEachSign: 4, minLooAuc: 0.6, maxWeight: 0.5, weightHalf: 40 });
    assert.ok(personalActive(p), "exactly at every threshold");
    assert.ok(!personalActive({ ...p, n: 11 }));
    assert.ok(!personalActive({ ...p, positives: 3 }));
    assert.ok(!personalActive({ ...p, negatives: 3 }));
    assert.ok(!personalActive({ ...p, looAuc: 0.59 }));
    assert.ok(!personalActive({ ...p, looAuc: undefined }), "a model without its leave-one-out AUC is never active");
    assert.ok(!personalActive({ ...p, positives: undefined }));
    // wU = min(its weight, 0.5, n/(n + 40))
    assert.equal(personalWeight(p), 12 / 52);
    assert.equal(personalWeight({ ...p, n: 2000 }), 0.5);
    assert.equal(personalWeight({ ...p, n: 2000, weight: 0.2 }), 0.2);
    const c = heuristicCritic();
    const x = vec({ map_issues_per1000: 0, map_forced_per1000: 0, w_jack_rate_mean: 1 });
    assert.equal(c.score(x, { personal: { ...p, looAuc: 0.5 } }).personal, null);
    const on = c.score(x, { personal: p });
    assert.ok(Math.abs(on.score - (12 / 52) * on.personal) < 1e-12);
});

test("tree heads compare float32 features, as XGBoost does (f32(x) < condition)", () => {
    // condition c = f32(0.3); the export stores nextafter(c, -inf) for the `x <= threshold` walk
    const c32 = Math.fround(0.3);
    const below = c32 - 2 ** -25; // the float32 just under c32 (exponent of 0.3 is -2: ulp 2^-25)
    assert.equal(Math.fround(below), below);
    const name = "w_jack_rate_mean";
    const tree = { feature: [0, 0, 0], threshold: [below, 0, 0], missingLeft: [0, 0, 0], left: [1, 0, 0], right: [2, 0, 0], leaf: [0, 1, 1], value: [0, -1, 1] };
    const critic = loadCritic({ kind: "critic-v1", features: [name], human: { baseline: [0], iterations: [[tree]] } });
    const at = (v) => critic.score(vec({ [name]: v })).human;
    const left = 1 / (1 + Math.exp(1));
    const right = 1 / (1 + Math.exp(-1));
    assert.equal(at(below), left, "f32(x) = nextafter(c) < c: left");
    assert.equal(at(c32), right, "f32(x) = c: right");
    // a double just above the stored threshold that rounds to it in float32: XGBoost goes left, so must we
    const between = below + 2 ** -28;
    assert.equal(Math.fround(between), below);
    assert.equal(at(between), left);
    // a double just below c that rounds up to c in float32: XGBoost goes right
    const upper = c32 - 2 ** -28;
    assert.equal(Math.fround(upper), c32);
    assert.equal(at(upper), right);
});

test("a critic maps its features by name, so a different order gives the same scores", { skip: !fixture && "fixture missing" }, () => {
    const c = loadCritic(fixture.critic);
    const x = fromJson(fixture.probes[1].x);
    const ref = c.score(x);
    // the same trees over reversed names: every split index points at the same name
    const names = fixture.critic.features;
    const rev = [...names].reverse();
    const remap = (spec) => spec && {
        ...spec,
        iterations: spec.iterations.map((trees) => trees.map((t) => ({ ...t, feature: t.feature.map((f, n) => (t.leaf[n] ? f : names.length - 1 - f)) }))),
    };
    const reordered = loadCritic({
        ...fixture.critic, features: rev, human: remap(fixture.critic.human), fun: null,
    });
    const noFun = loadCritic({ ...fixture.critic, fun: null });
    assert.ok(Math.abs(reordered.score(x).score - noFun.score(x).score) < 1e-12);
    assert.ok(Math.abs(reordered.score(x).human - ref.human) < 1e-12);
});

test("loadCritic refuses what is not a critic", () => {
    assert.throws(() => loadCritic({ kind: "xgb-v1" }), /critic/);
    assert.throws(() => loadCritic({ kind: "critic-v1", features: ["a"], human: null }), /critic/);
    assert.equal(DEFAULT_BLEND.wP, 1);
    assert.equal(DEFAULT_BLEND.wU, 0);
    assert.equal(playTerm(vec({})), 0, "missing play features count as clean");
});

test("models/critic.json (when shipped) matches its own parity probes", { skip: !trained && "models/critic.json not shipped" }, () => {
    const c = loadCritic(trained);
    for (const p of trained.parity) {
        const r = c.score(fromJson(p.x, trained), { style: p.style });
        assert.ok(Math.abs(r.score - p.expect.score) <= 1e-6);
        assert.ok(Math.abs(r.human - p.expect.human) <= 1e-6);
    }
});
