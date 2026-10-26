// The personal reranker (docs/2026-10-25-mapgen-v3-ml-addendum.md §2.7): an L2 logistic regression on the critic's
// standardised features, fitted from the user's 👍/👎 in the generator worker (the "fit-personal" job), never in main.
//
// fitPersonal(entries, { norm, lambda, maxIter }) → PersonalModel | null
//   entries: [{ vote: 1 | -1, tags: string[], features: (number | null)[], names: string[] }] (the ratings store's,
//            app/ratingsStore.js); an entry without features, or whose names do not match them, is left out.
//   norm:    critic.json's { names, mean, std }; without it the means and stds come from the entries.
//   null when nothing can be fitted (no usable entry, or every vote has the same sign).
// PersonalModel = { v: 1, names, w, b, mean, std, n, positives, negatives, looAuc, weight, active, lambda, iterations,
//                   converged } — the shape src/gen/critic.js scores with (personalActive, personalLogit). An inactive
//                   model has weight 0, so the critic never counts it; main sends only an active one to the generator.
//
// Fitting: Newton steps (IRLS) on the penalised log-likelihood, at most 25 of them, halving a step that makes it
// worse. The Gaussian prior is centred on a sum of tag directions (TAG_PRIORS): every tagged vote moves the centre of
// the features its tag names, so a few «слишком джековая» votes already push the jack weights negative.
// The leave-one-out AUC uses the one-step (hat-matrix) approximation, so it needs no refits.
// Active (§2.7, src/gen/critic.js PERSONAL_RULE): n ≥ 12, at least 4 of each sign, leave-one-out AUC ≥ 0.6;
// weight = min(0.5, n/(n + 40)).

export const TAGS_DOWN = Object.freeze(["tooJacky", "awkward", "boring", "offMusic", "tooDense", "tooSparse"]);
export const TAGS_UP = Object.freeze(["fun", "human", "comfy"]);
export const RATING_TAGS = Object.freeze([...TAGS_DOWN, ...TAGS_UP]);

export const LAMBDA = 1; // the L2 strength on standardised features
export const MAX_ITER = 25;
export const TAG_STEP = 0.25; // how far one tagged vote moves the prior centre of each feature its tag names
export const TAG_CAP = 1.5; // the centre never goes past ±TAG_CAP
const Z_CLAMP = 6; // standardised values are clipped here, so one odd map cannot dominate
const TOL = 1e-6;
const W_FLOOR = 1e-9;

// Feature groups, by name (src/gen/criticFeatures.js CRITIC_FEATURES): windows (w_*_p10/mean/p90) and the map.
const JACKS = /^(w_(jack_rate|jack_run|minijack|longjack|chordjack)(_streamy)?_|map_(longest_jack|jack_loop|issue_jack|issue_fastjack))/;
const JACK_GAPS = /^w_jack_gap_ms/;
const HANDS = /^(w_(left_dev|one_hand_jump|anchor|col_ratio|hand_run)_|map_(issue_anchor|issue_hand|issue_columns|forced_per1000))/;
const ISSUES = /^map_(issues_per1000|forced_per1000|issue_)/;
const VARIETY = /^(w_(bigram_entropy|mask_entropy|rhythm_entropy|col_entropy)_|map_(bigram_entropy|mask_entropy)$)/;
const LOOPS = /^(w_loop_|map_(beat_repeat|jack_loop)$)/;
const ON_MUSIC = /^(w_(onset_gap|onset_rows|onset_recall|size_onset_corr|kick_rows|snare_rows|hat_rows)_|map_(density_energy_corr|density_onset_corr|kick_rows|snare_rows|hat_rows)$)/;
const OFF_MUSIC = /^w_onset_low_rows_/;
const DENSITY = /^(w_(notes_per_beat|rows_per_beat)_|map_(notes_per_beat|rows_per_beat|peak_nps)$)/;
const EMPTY = /^w_empty_beats_/;
const ECHO = /^(w_echo_sim_|map_echo_sim$)/;
const FOLLOWS_ENERGY = /^map_density_energy_corr$/;

// tag → [feature group, direction]: where a vote with that tag says the user's taste lies
export const TAG_PRIORS = Object.freeze({
    tooJacky: [[JACKS, -1], [JACK_GAPS, 1]],
    awkward: [[HANDS, -1], [ISSUES, -1]],
    boring: [[VARIETY, 1], [LOOPS, -1]],
    offMusic: [[ON_MUSIC, 1], [OFF_MUSIC, -1]],
    tooDense: [[DENSITY, -1], [EMPTY, 1]],
    tooSparse: [[DENSITY, 1], [EMPTY, -1]],
    fun: [[VARIETY, 1], [FOLLOWS_ENERGY, 1]],
    human: [[ON_MUSIC, 1], [ECHO, 1], [ISSUES, -1]],
    comfy: [[HANDS, -1], [ISSUES, -1]],
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const sig7 = (x) => Number(x.toPrecision(7)); // what the model keeps of each number
// log σ(e) and log(1 − σ(e)), without overflow
const logSig = (e) => Math.min(0, e) - Math.log1p(Math.exp(-Math.abs(e)));

// The prior centre over `names` for the tags of these entries.
export function priorCentre(names, entries) {
    const counts = new Map();
    for (const e of entries) for (const tag of e.tags ?? []) if (TAG_PRIORS[tag]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const m = new Float64Array(names.length);
    for (const [tag, count] of counts) {
        for (const [group, dir] of TAG_PRIORS[tag]) {
            names.forEach((name, j) => { if (group.test(name)) m[j] += dir * TAG_STEP * count; });
        }
    }
    for (let j = 0; j < m.length; j += 1) m[j] = Math.max(-TAG_CAP, Math.min(TAG_CAP, m[j]));
    return m;
}

// Area under the ROC curve of scores against labels (1 / 0); ties count a half; null without both labels.
export function aucOf(scores, labels) {
    const order = Array.from(scores.keys()).sort((a, b) => scores[a] - scores[b]);
    let pos = 0;
    let neg = 0;
    let rankSum = 0;
    for (let i = 0; i < order.length;) {
        let j = i;
        while (j + 1 < order.length && scores[order[j + 1]] === scores[order[i]]) j += 1;
        const rank = (i + j) / 2 + 1; // the tie group's mid-rank, 1-based
        for (let k = i; k <= j; k += 1) {
            if (labels[order[k]]) {
                pos += 1;
                rankSum += rank;
            } else {
                neg += 1;
            }
        }
        i = j + 1;
    }
    if (!pos || !neg) return null;
    return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// In-place Cholesky of the d×d symmetric positive definite A (row-major; the lower triangle becomes L), or null.
function cholesky(A, d) {
    for (let j = 0; j < d; j += 1) {
        const rj = j * d;
        let s = A[rj + j];
        for (let k = 0; k < j; k += 1) s -= A[rj + k] * A[rj + k];
        if (!(s > 0)) return null;
        const l = Math.sqrt(s);
        A[rj + j] = l;
        for (let i = j + 1; i < d; i += 1) {
            const ri = i * d;
            let t = A[ri + j];
            for (let k = 0; k < j; k += 1) t -= A[ri + k] * A[rj + k];
            A[ri + j] = t / l;
        }
    }
    return A;
}

// L z = x into z
function forward(L, d, x, z) {
    for (let i = 0; i < d; i += 1) {
        const ri = i * d;
        let s = x[i];
        for (let k = 0; k < i; k += 1) s -= L[ri + k] * z[k];
        z[i] = s / L[ri + i];
    }
    return z;
}

// Lᵀ y = z into y
function backward(L, d, z, y) {
    for (let i = d - 1; i >= 0; i -= 1) {
        let s = z[i];
        for (let k = i + 1; k < d; k += 1) s -= L[k * d + i] * y[k];
        y[i] = s / L[i * d + i];
    }
    return y;
}

// The usable entries as a standardised n×p design matrix over `names`; a missing value counts as the mean.
function design(names, entries, norm) {
    const columns = new Map(); // an entry's names array → where each of `names` sits in it (−1: not there)
    const columnsOf = (list) => {
        if (!columns.has(list)) {
            const local = new Map(list.map((name, k) => [name, k]));
            columns.set(list, Int32Array.from(names, (name) => local.get(name) ?? -1));
        }
        return columns.get(list);
    };
    const p = names.length;
    const raw = entries.map((e) => {
        const cols = columnsOf(e.names);
        return Float64Array.from({ length: p }, (_, j) => (cols[j] >= 0 && isNum(e.features[cols[j]]) ? e.features[cols[j]] : NaN));
    });
    const normAt = new Map((Array.isArray(norm?.names) ? norm.names : []).map((name, k) => [name, k]));
    const mean = new Float64Array(p);
    const std = new Float64Array(p);
    for (let j = 0; j < p; j += 1) {
        const k = normAt.get(names[j]);
        if (k !== undefined && isNum(norm.mean?.[k]) && isNum(norm.std?.[k])) {
            mean[j] = norm.mean[k];
            std[j] = norm.std[k] > 0 ? norm.std[k] : 1;
            continue;
        }
        let s = 0;
        let s2 = 0;
        let c = 0;
        for (const row of raw) {
            if (!Number.isNaN(row[j])) {
                s += row[j];
                s2 += row[j] * row[j];
                c += 1;
            }
        }
        mean[j] = c ? s / c : 0;
        const v = c ? s2 / c - mean[j] * mean[j] : 0;
        std[j] = v > 1e-18 ? Math.sqrt(v) : 1;
    }
    const X = new Float64Array(entries.length * p);
    raw.forEach((row, i) => {
        for (let j = 0; j < p; j += 1) {
            const z = Number.isNaN(row[j]) ? 0 : (row[j] - mean[j]) / std[j];
            X[i * p + j] = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));
        }
    });
    return { X, mean, std };
}

// A usable entry: a vote of ±1 and as many features (numbers or null) as names.
const usable = (e) => Boolean(e) && (e.vote === 1 || e.vote === -1) && Array.isArray(e.features) && Array.isArray(e.names)
    && e.features.length > 0 && e.features.length === e.names.length;

export async function fitPersonal(entries, { norm = null, lambda = LAMBDA, maxIter = MAX_ITER } = {}) {
    const list = (Array.isArray(entries) ? entries : []).filter(usable);
    const positives = list.filter((e) => e.vote === 1).length;
    const negatives = list.length - positives;
    if (!positives || !negatives) return null;
    // the feature list: the critic's own when it has a norm, else the newest entry's
    const names = Array.isArray(norm?.names) && norm.names.length ? [...norm.names] : [...list.at(-1).names];
    const n = list.length;
    const p = names.length;
    const d = p + 1; // the weights, then the intercept
    const { X, mean, std } = design(names, list, norm);
    const y = Float64Array.from(list, (e) => (e.vote === 1 ? 1 : 0));
    const m = priorCentre(names, list);

    const theta = new Float64Array(d);
    theta.set(m);
    theta[p] = Math.log(positives / negatives);
    const eta = new Float64Array(n);
    const prob = new Float64Array(n);
    const W = new Float64Array(n);
    const A = new Float64Array(d * d);
    const g = new Float64Array(d);
    const z = new Float64Array(d);
    const step = new Float64Array(d);
    const xi = new Float64Array(d);
    const trial = new Float64Array(d);

    const linear = (th) => {
        for (let i = 0; i < n; i += 1) {
            const row = i * p;
            let s = th[p];
            for (let j = 0; j < p; j += 1) s += X[row + j] * th[j];
            eta[i] = s;
        }
    };
    // the penalised log-likelihood at th, with eta = linear(th)
    const objective = (th) => {
        let ll = 0;
        for (let i = 0; i < n; i += 1) ll += y[i] ? logSig(eta[i]) : logSig(-eta[i]);
        let pen = 0;
        for (let j = 0; j < p; j += 1) pen += (th[j] - m[j]) ** 2;
        return ll - (lambda / 2) * pen;
    };
    const weights = () => {
        for (let i = 0; i < n; i += 1) {
            prob[i] = sigmoid(eta[i]);
            W[i] = Math.max(W_FLOOR, prob[i] * (1 - prob[i]));
        }
    };
    // A = X̃ᵀWX̃ + Λ with X̃ = [X, 1] (the lower triangle summed, then mirrored); Λ leaves the intercept nearly free
    const hessian = () => {
        A.fill(0);
        for (let i = 0; i < n; i += 1) {
            const w = W[i];
            const row = i * p;
            for (let j = 0; j < p; j += 1) xi[j] = X[row + j];
            xi[p] = 1;
            for (let j = 0; j < d; j += 1) {
                const wx = w * xi[j];
                if (wx === 0) continue;
                const base = j * d;
                for (let k = 0; k <= j; k += 1) A[base + k] += wx * xi[k];
            }
        }
        for (let j = 0; j < p; j += 1) A[j * d + j] += lambda;
        A[p * d + p] += 1e-8;
        for (let j = 0; j < d; j += 1) for (let k = j + 1; k < d; k += 1) A[j * d + k] = A[k * d + j];
    };

    linear(theta);
    let current = objective(theta);
    let iterations = 0;
    let converged = false;
    while (iterations < maxIter) {
        iterations += 1;
        weights();
        g.fill(0);
        for (let i = 0; i < n; i += 1) {
            const r = y[i] - prob[i];
            const row = i * p;
            for (let j = 0; j < p; j += 1) g[j] += X[row + j] * r;
            g[p] += r;
        }
        for (let j = 0; j < p; j += 1) g[j] -= lambda * (theta[j] - m[j]);
        hessian();
        if (!cholesky(A, d)) break;
        backward(A, d, forward(A, d, g, z), step);
        // the Newton step, halved while it makes the objective worse
        let scale = 1;
        let next = current;
        for (let half = 0; half < 30; half += 1) {
            for (let j = 0; j < d; j += 1) trial[j] = theta[j] + scale * step[j];
            linear(trial);
            next = objective(trial);
            if (next >= current - 1e-12) break;
            scale /= 2;
        }
        let biggest = 0;
        for (let j = 0; j < d; j += 1) biggest = Math.max(biggest, Math.abs(trial[j] - theta[j]));
        theta.set(trial);
        current = next;
        if (biggest < TOL) {
            converged = true;
            break;
        }
    }

    // leave-one-out logits by the one-step approximation: η₋ᵢ = ηᵢ − qᵢ·(yᵢ − pᵢ) / (1 − Wᵢ·qᵢ), qᵢ = x̃ᵢᵀ A⁻¹ x̃ᵢ
    linear(theta);
    weights();
    hessian();
    let looAuc = null;
    if (cholesky(A, d)) {
        const loo = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
            const row = i * p;
            for (let j = 0; j < p; j += 1) xi[j] = X[row + j];
            xi[p] = 1;
            forward(A, d, xi, z);
            let q = 0;
            for (let j = 0; j < d; j += 1) q += z[j] * z[j];
            loo[i] = eta[i] - (q * (y[i] - prob[i])) / (1 - Math.min(0.999, W[i] * q));
        }
        looAuc = aucOf(loo, y);
    }

    const { PERSONAL_RULE: rule } = await import("./critic.js");
    const active = n >= rule.minVotes && positives >= rule.minEachSign && negatives >= rule.minEachSign
        && looAuc !== null && looAuc >= rule.minLooAuc;
    const weight = active ? Math.min(rule.maxWeight, n / (n + rule.weightHalf)) : 0;
    return {
        v: 1, names,
        w: Array.from(theta.subarray(0, p), sig7), b: sig7(theta[p]),
        mean: Array.from(mean, sig7), std: Array.from(std, sig7),
        n, positives, negatives, looAuc: looAuc === null ? null : sig7(looAuc),
        weight: sig7(weight), active, lambda, iterations, converged,
    };
}
