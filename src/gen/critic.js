// The critic: how much a whole map looks hand-made, scored from its criticFeatures vector (src/gen/criticFeatures.js).
// G's candidate loop (src/gen/candidates.js) builds N maps, scores each with critic.score and analyses the best few.
//
//   loadCritic(json)       → critic from models/critic.json (kind "critic-v1", made by tools/train_critic.py)
//   heuristicCritic()      → the critic without a model (kind "heuristic"): the play term alone
//   criticFor(json | null) → loadCritic(json), or the heuristic critic when there is no file
//   critic.score(features, { style?, personal? }) →
//       { kind, score, human, fun, play, personal, style }     (a head that is missing or unused is null)
//   critic.styles          → [{ key, name, maps }] for modelInfo.styles (empty without a style head)
//
// Stage-1 score: s1 = zH + wF·zF + wP·P + wU·zU + wS·log P(style | map) (addendum §2.1), where
//   zH = the human head's logit standardised on held-out human maps (human = its probability, for the card),
//   zF = 0.5·z(within-set fun) + 0.5·z(cross-set fun) (one of them alone when only one exists),
//   P  = −issuesPer1000/10 − forcedPer1000/20 (A2's findIssues and the guard's fallbacks),
//   zU = the personal reranker's logit (src/gen/personal.js), counted only when it is active (addendum §2.7: at least
//        12 votes, at least 4 of each sign, leave-one-out AUC >= 0.6), with wU = min(its weight, 0.5, n/(n + 40)),
//   the style term only when a style is chosen and the critic knows it.
// Weights come from critic.json.blend; DEFAULT_BLEND fills in what it lacks.
// Trees: features go through float32 before the comparisons, as XGBoost compares f32(x) < split_condition (the export
// moved each condition one float32 step down for the `x <= threshold` walk of treeRaw, which is exact on float32 x).
// PersonalModel (made by src/gen/personal.js fitPersonal, stream U): { v: 1, names, w, b, mean?, std?, weight,
//   n (votes), positives (👍), negatives (👎), looAuc (leave-one-out AUC) }.
import { CRITIC_FEATURES } from "./criticFeatures.js";
import { treeRaw } from "./learnedModel.js";

export const CRITIC_KIND = "critic-v1";
export const DEFAULT_BLEND = Object.freeze({ wF: 0.15, wP: 1, wU: 0, wS: 0.5 });
export const PERSONAL_RULE = Object.freeze({ minVotes: 12, minEachSign: 4, minLooAuc: 0.6, maxWeight: 0.5, weightHalf: 40 });
const PERSONAL_CLAMP = 8;

const AT = new Map(CRITIC_FEATURES.map((n, k) => [n, k]));
const ISSUES = AT.get("map_issues_per1000");
const FORCED = AT.get("map_forced_per1000");
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const valueAt = (x, k) => (k === undefined || k < 0 || x[k] === null || x[k] === undefined ? NaN : Number(x[k]));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const zOf = (v, z) => (z && isNum(z.std) && z.std > 0 ? (v - z.mean) / z.std : v);

// P: awkward spots and guard fallbacks per 1000 notes (missing counts as clean).
export function playTerm(x) {
    const issues = valueAt(x, ISSUES);
    const forced = valueAt(x, FORCED);
    return 0 - (isNum(issues) ? issues : 0) / 10 - (isNum(forced) ? forced : 0) / 20;
}

// A gather from the CRITIC_FEATURES vector to a head's own feature order (NaN for names this build lacks). `f32`: the
// values are rounded to float32 (the tree heads, see the header); NaN stays NaN.
function gatherer(names, { f32 = false } = {}) {
    const idx = Int32Array.from(names, (n) => (AT.has(n) ? AT.get(n) : -1));
    const out = f32 ? new Float32Array(idx.length) : new Float64Array(idx.length);
    return (x) => {
        for (let j = 0; j < idx.length; j += 1) out[j] = valueAt(x, idx[j]);
        return out;
    };
}

// Means and stds by name, from critic.json.norm ({ names, mean, std }).
function normIndex(norm) {
    if (!norm?.names || !norm.mean || !norm.std) return null;
    const map = new Map();
    norm.names.forEach((n, k) => map.set(n, [norm.mean[k], norm.std[k]]));
    return map;
}

// The weight of an active personal model: its own, never above min(0.5, n/(n + 40)) (§2.7).
export function personalWeight(personal) {
    const { maxWeight, weightHalf } = PERSONAL_RULE;
    const cap = isNum(personal?.n) && personal.n > 0 ? Math.min(maxWeight, personal.n / (personal.n + weightHalf)) : 0;
    return isNum(personal?.weight) ? Math.min(personal.weight, cap) : cap;
}

// The §2.7 activity rule: a well-formed model with n >= 12 votes, >= 4 of each sign, a leave-one-out AUC >= 0.6 and
// a positive weight.
export function personalActive(personal) {
    const { minVotes, minEachSign, minLooAuc } = PERSONAL_RULE;
    return Boolean(personal && personal.v === 1 && Array.isArray(personal.names) && Array.isArray(personal.w)
        && personal.names.length > 0 && personal.names.length === personal.w.length
        && isNum(personal.n) && personal.n >= minVotes
        && isNum(personal.positives) && personal.positives >= minEachSign
        && isNum(personal.negatives) && personal.negatives >= minEachSign
        && isNum(personal.looAuc) && personal.looAuc >= minLooAuc
        && personalWeight(personal) > 0);
}

// The personal model's logit: b + Σ w·z over its names, z standardised by the critic's norm (or the model's own
// mean/std arrays); a missing feature counts as its mean. Clamped to ±8.
export function personalLogit(personal, x, norm = null) {
    if (!personalActive(personal)) return null;
    const byName = norm instanceof Map ? norm : normIndex(norm);
    let s = isNum(personal.b) ? personal.b : 0;
    personal.names.forEach((name, j) => {
        const v = valueAt(x, AT.get(name));
        if (!isNum(v) || !isNum(personal.w[j])) return;
        const [mean, std] = byName?.get(name) ?? [personal.mean?.[j] ?? 0, personal.std?.[j] ?? 1];
        s += personal.w[j] * (std > 0 ? (v - mean) / std : v - mean);
    });
    return Math.max(-PERSONAL_CLAMP, Math.min(PERSONAL_CLAMP, s));
}

function checkTrees(spec, what) {
    if (!spec) return null;
    if (!Array.isArray(spec.baseline) || !Array.isArray(spec.iterations)) throw new Error(`bad critic: ${what} is not a tree model`);
    return spec;
}

function makeCritic({ kind, human = null, fun = null, style = null, norm = null, blend = {}, features = [] }) {
    const w = { ...DEFAULT_BLEND, ...blend };
    const gatherHead = gatherer(features, { f32: true });
    const byName = normIndex(norm);
    // style head: multinomial logistic regression on standardised features
    let styleHead = null;
    if (style?.keys?.length && style.W?.length === style.keys.length + (style.unknown ? 1 : 0)) {
        const names = style.features ?? features;
        const gather = gatherer(names);
        const mean = Float64Array.from(names, (n) => byName?.get(n)?.[0] ?? 0);
        const std = Float64Array.from(names, (n) => byName?.get(n)?.[1] ?? 1);
        const W = style.W.map((row) => Float64Array.from(row));
        const b = Float64Array.from(style.b);
        const keyIndex = new Map(style.keys.map((k, i) => [k, i]));
        styleHead = {
            keyIndex,
            logP(x, key) {
                const v = gather(x);
                const z = new Float64Array(v.length);
                for (let j = 0; j < v.length; j += 1) z[j] = isNum(v[j]) ? (v[j] - mean[j]) / (std[j] > 0 ? std[j] : 1) : 0;
                const logits = W.map((row, c) => {
                    let s = b[c];
                    for (let j = 0; j < z.length; j += 1) s += row[j] * z[j];
                    return s;
                });
                let max = -Infinity;
                for (const l of logits) if (l > max) max = l;
                let sum = 0;
                for (const l of logits) sum += Math.exp(l - max);
                return logits[keyIndex.get(key)] - max - Math.log(sum);
            },
        };
    }
    const funHeads = fun ? [[fun.within, fun.zWithin], [fun.cross, fun.zCross]].filter(([spec]) => spec) : [];
    const styles = styleHead ? style.keys.map((key, i) => ({ key, name: String(style.names?.[i] ?? key), maps: Math.round(style.maps?.[i] ?? 0) })) : [];

    return {
        kind,
        blend: w,
        styles,
        heads: { human: Boolean(human), fun: funHeads.length > 0, style: Boolean(styleHead) },
        norm,
        score(x, { style: key = null, personal = null } = {}) {
            let human01 = null;
            let zH = null;
            if (human) {
                const raw = treeRaw(human, gatherHead(x))[0];
                human01 = sigmoid(raw);
                zH = zOf(raw, norm?.zH);
            }
            let zF = null;
            if (funHeads.length) {
                const xs = gatherHead(x);
                zF = funHeads.reduce((s, [spec, z]) => s + zOf(treeRaw(spec, xs)[0], z), 0) / funHeads.length;
            }
            const play = playTerm(x);
            const zU = personalActive(personal) ? personalLogit(personal, x, byName) : null;
            const logP = key !== null && key !== undefined && styleHead?.keyIndex.has(key) ? styleHead.logP(x, key) : null;
            let s = w.wP * play;
            if (zH !== null) s += zH;
            if (zF !== null) s += w.wF * zF;
            if (zU !== null) s += personalWeight(personal) * zU;
            if (logP !== null) s += w.wS * logP;
            return { kind, score: s, human: human01, fun: zF, play, personal: zU, style: logP };
        },
    };
}

export function loadCritic(json) {
    if (!json || json.kind !== CRITIC_KIND) throw new Error(`not a critic: kind ${json?.kind}`);
    if (!Array.isArray(json.features) || !json.features.length) throw new Error("bad critic: no feature names");
    if (!json.human) throw new Error("bad critic: no human head");
    return makeCritic({
        kind: CRITIC_KIND,
        human: checkTrees(json.human, "human"),
        fun: json.fun ? { ...json.fun, within: checkTrees(json.fun.within, "fun.within"), cross: checkTrees(json.fun.cross, "fun.cross") } : null,
        style: json.style ?? null,
        norm: json.norm ?? null,
        blend: json.blend ?? {},
        features: json.features,
    });
}

export function heuristicCritic() {
    return makeCritic({ kind: "heuristic" });
}

export function criticFor(json) {
    return json ? loadCritic(json) : heuristicCritic();
}
