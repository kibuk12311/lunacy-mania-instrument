"""Train the critic (critic.json, kind "critic-v1") on the rows of tools/make-critic-negatives.mjs.

Heads (addendum §4.1-§4.3):
  human  XGBoost binary:logistic, human map (and its column mirror) vs generated / v2 / perturbed maps.
         Mirrored copies (made by the JS tool, same song group, same split) are training rows; metrics use originals.
  fun    XGBoost rank:pairwise within a set on playsResid (qid = set) and across sets on favResid
         (qid = dan bin x year), z-scored on val humans. Only when fun labels exist (E's tools/fun-labels.py);
         without them there is no fun head and blend.wF = 0.
  style  multinomial logistic regression on the standardised features over the creators with >= 30 diffs across
         >= 8 song groups (counted in the corpus) plus "unknown".
Also: norm (means/stds of train humans; zH = the human logit on val humans), blend defaults, feature gains and
parity probes whose expected values come from score_ref below - src/gen/critic.js must match them within 1e-6.

Splits come from the rows: "train" trains, "val" early-stops / calibrates / picks the sweep config, "test" is
only reported (and is what tools/eval-critic.mjs reads).

Usage: python -I tools/train_critic.py --data A:/SneezeyTrain/critic/data --out A:/SneezeyTrain/critic/critic.json
         [--report <file.md>] [--sweep] [--trees 600] [--depth 6] [--eta 0.05] [--device cuda]
         [--fun auto|none|<labels.jsonl|csv>] [--corpus A:/SneezeyTrain/corpus/corpus.jsonl]
         [--fixture tests/fixtures/critic-parity.json] [--seed 7]
"""
import argparse
import csv
import json
import math
import re
import sys
import time
import zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

META = ["map_forced_per1000"]  # CRITIC_META in src/gen/criticFeatures.js: never an input of a learned head
DEFAULT_BLEND = {"wF": 0.15, "wP": 1.0, "wU": 0.0, "wS": 0.5}
STYLE_MIN_DIFFS = 30
STYLE_MIN_GROUPS = 8
STYLE_MIN_TRAIN = 5
FUN_CANDIDATES = [
    "{data}/fun-labels.jsonl",
    "A:/SneezeyTrain/mapper3/fun-labels.jsonl",
    "A:/SneezeyTrain/mapper3/fun-labels.csv",
    "A:/SneezeyTrain/hf-meta/fun-labels.jsonl",
    "A:/SneezeyTrain/hf-meta/fun-labels.csv",
]
SEED = [7]  # --seed (a second critic for the anti-gaming check uses another one)
SWEEP = [{"max_depth": d, "eta": e, "min_child_weight": w} for d in (4, 6, 8) for e in (0.05, 0.1) for w in (1, 8)]


# ---- data -------------------------------------------------------------------------------------------------------

def read_jsonl(path):
    # split on "\n" only: names may hold U+2028 / U+0085, which str.splitlines() would split on
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f.read().split("\n") if line.strip()]


def load(data_dir):
    data_dir = Path(data_dir)
    names = json.loads((data_dir / "feature_names.json").read_text(encoding="utf-8"))
    meta = read_jsonl(data_dir / "index.jsonl")
    F = len(names)
    X = np.fromfile(data_dir / "features.f32", dtype=np.float32)
    if X.size != len(meta) * F:
        raise SystemExit(f"features.f32 holds {X.size / F:.1f} rows, index.jsonl {len(meta)}")
    return names, meta, X.reshape(len(meta), F)


def column(meta, key, default=None):
    return np.array([m.get(key, default) for m in meta], dtype=object)


def split_of(group):
    """The JS splitOf rule for train groups: crc32(group) % 10 == 1 -> val."""
    return "val" if zlib.crc32(str(group).encode("utf-8")) % 10 == 1 else "train"


def row_weights(meta, idx):
    """Per map: its human rows weigh 1 in total and its negative rows 1 in total; then 1/sqrt(maps in the group)."""
    pos, neg, maps_in_group = Counter(), Counter(), defaultdict(set)
    for i in idx:
        m = meta[i]
        (pos if m["kind"] == "human" else neg)[m["map"]] += 1
        maps_in_group[m.get("group")].add(m["map"])
    w = np.empty(len(idx), dtype=np.float32)
    for k, i in enumerate(idx):
        m = meta[i]
        share = 1.0 / (pos[m["map"]] if m["kind"] == "human" else neg[m["map"]])
        w[k] = share / math.sqrt(len(maps_in_group[m.get("group")]))
    return w


# ---- trees: export in the app's flat format and the reference evaluator (src/gen/learnedModel.js treeRaw) ------

def export_xgb(booster, X_probe):
    """Binary XGBoost booster -> {baseline: [1], iterations: [[tree]], classes}. XGBoost splits on `x < cond`, the
    JS evaluator on `x <= threshold`, so thresholds move one float32 step down. The base margin is what the trees do
    not explain, measured on a probe sample. Trees are read from the model's own JSON (save_raw), not from the text
    dump, whose split values can be tokens like `inf` that are not JSON."""
    model = json.loads(booster.save_raw("json"))
    flat = []
    for tree in model["learner"]["gradient_booster"]["model"]["trees"]:
        left, right = tree["left_children"], tree["right_children"]
        t = {k: [] for k in ("feature", "threshold", "missingLeft", "left", "right", "leaf", "value")}
        for i in range(len(left)):
            if left[i] == -1:  # a leaf: its weight sits in split_conditions
                for k, v in (("feature", 0), ("threshold", 0.0), ("missingLeft", 0), ("left", 0), ("right", 0), ("leaf", 1)):
                    t[k].append(v)
                t["value"].append(round(float(tree["split_conditions"][i]), 7))
            else:
                cond = np.float32(tree["split_conditions"][i])
                thr = float(np.nextafter(cond, np.float32(-np.inf)))
                # a split at -inf sends every value right: so does -1e300, which JSON can hold
                thr = thr if math.isfinite(thr) else (-1e300 if thr < 0 else 1e300)
                t["feature"].append(int(tree["split_indices"][i]))
                t["threshold"].append(thr)
                t["missingLeft"].append(int(tree["default_left"][i]))
                t["left"].append(int(left[i]))
                t["right"].append(int(right[i]))
                t["leaf"].append(0)
                t["value"].append(0.0)
        flat.append(t)
    spec = {"baseline": [0.0], "iterations": [[t] for t in flat], "classes": [0, 1]}
    import xgboost as xgb
    margin = booster.predict(xgb.DMatrix(X_probe), output_margin=True).reshape(-1)
    spec["baseline"] = [float(np.median(margin - raw_predict(spec, X_probe)))]
    return spec


def raw_predict(spec, X):
    """Reference evaluator for exported trees: float64, the same summation order as treeRaw in JS."""
    X = np.asarray(X, dtype=np.float64)
    out = np.full(len(X), float(spec["baseline"][0]))
    for trees in spec["iterations"]:
        t = trees[0]
        feat, thr, ml, left, right, leaf, val = (np.asarray(t[k]) for k in ("feature", "threshold", "missingLeft", "left", "right", "leaf", "value"))
        node = np.zeros(len(X), dtype=np.int64)
        active = leaf[node] == 0
        while active.any():
            idx = np.where(active)[0]
            v = X[idx, feat[node[idx]]]
            go_left = np.where(np.isnan(v), ml[node[idx]] == 1, v <= thr[node[idx]])
            node[idx] = np.where(go_left, left[node[idx]], right[node[idx]])
            active = leaf[node] == 0
        out += val[node].astype(np.float64)
    return out


def train_xgb(params, X, y, w, Xv, yv, trees, device, qid=None, qid_v=None):
    import xgboost as xgb
    base = {"tree_method": "hist", "device": device, "subsample": 0.8, "colsample_bytree": 0.8, "lambda": 1.0, "seed": SEED[0]}
    base.update(params)
    dtrain = xgb.DMatrix(X, label=y, weight=w, qid=qid)
    evals = []
    if Xv is not None and len(Xv):
        evals = [(xgb.DMatrix(Xv, label=yv, qid=qid_v), "val")]
    try:
        booster = xgb.train(base, dtrain, trees, evals=evals, early_stopping_rounds=50 if evals else None, verbose_eval=False)
    except xgb.core.XGBoostError as error:
        if device == "cpu":
            raise
        print(f"cuda failed ({str(error)[:80]}), training on the cpu", flush=True)
        base["device"] = "cpu"
        booster = xgb.train(base, dtrain, trees, evals=evals, early_stopping_rounds=50 if evals else None, verbose_eval=False)
    if evals and getattr(booster, "best_iteration", None) is not None:
        booster = booster[: booster.best_iteration + 1]
    return booster


# ---- metrics ------------------------------------------------------------------------------------------------------

def auc(scores_pos, scores_neg):
    if not len(scores_pos) or not len(scores_neg):
        return None
    from sklearn.metrics import roc_auc_score
    y = np.r_[np.ones(len(scores_pos)), np.zeros(len(scores_neg))]
    return float(roc_auc_score(y, np.r_[scores_pos, scores_neg]))


def kind_aucs(meta, idx, scores):
    """AUC of human rows against each negative kind (and each perturbation) among original (unmirrored) rows."""
    kinds = column(meta, "kind")[idx]
    subs = column(meta, "sub")[idx]
    keep = column(meta, "mirror", 0)[idx] == 0
    pos = scores[(kinds == "human") & keep]
    out = {"all": auc(pos, scores[(kinds != "human") & keep]), "humans": int(len(pos))}
    for k in sorted(set(kinds) - {"human"}):
        out[k] = auc(pos, scores[(kinds == k) & keep])
    for s in sorted(x for x in set(subs[kinds == "perturb"]) if x):
        out[f"perturb:{s}"] = auc(pos, scores[(kinds == "perturb") & (subs == s) & keep])
    if (subs == "swapSection").any():  # near chance for map-level features (see tools/eval-critic.mjs)
        out["perturb:noSwap"] = auc(pos, scores[(kinds == "perturb") & (subs != "swapSection") & keep])
    return out


def pairwise_accuracy(groups, labels, scores):
    """Share of pairs inside each group, with different labels, that the scores order the same way."""
    by = defaultdict(list)
    for g, l, s in zip(groups, labels, scores):
        by[g].append((l, s))
    agree = total = 0
    for items in by.values():
        for a in range(len(items)):
            for b in range(a + 1, len(items)):
                (la, sa), (lb, sb) = items[a], items[b]
                if la == lb:
                    continue
                total += 1
                agree += 1 if (la - lb) * (sa - sb) > 0 else 0.5 if sa == sb else 0
    return (agree / total if total else None), total


def spearman(a, b):
    if len(a) < 3:
        return None
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    c = np.corrcoef(ra, rb)[0, 1]
    return None if np.isnan(c) else float(c)


def bootstrap_ci(values, n=1000, seed=7):
    """95% CI of the mean of 0/1 (or any) values, by resampling."""
    v = np.asarray(values, dtype=float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    means = [v[rng.integers(0, len(v), len(v))].mean() for _ in range(n)]
    return [float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))]


# ---- fun labels (E's tools/fun-labels.py) --------------------------------------------------------------------------

def find_fun_labels(arg, data_dir):
    if arg == "none":
        return None
    if arg != "auto":
        return Path(arg) if Path(arg).exists() else None
    for c in FUN_CANDIDATES:
        p = Path(c.format(data=data_dir))
        if p.exists():
            return p
    return None


def read_fun_labels(path):
    """-> {("b", beatmapId) | ("c", chartKey): {playsResid, favResid, setId, year, danBin}}; rows may nest the fields
    under "fun" (mapper3 index.jsonl)."""
    rows = []
    if str(path).lower().endswith(".csv"):
        with open(path, encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
    else:
        rows = read_jsonl(path)
    out = {}

    def num(v):
        try:
            x = float(v)
            return x if math.isfinite(x) else None
        except (TypeError, ValueError):
            return None

    for r in rows:
        fun = r.get("fun") if isinstance(r.get("fun"), dict) else r
        if not fun:
            continue
        lab = {"playsResid": num(fun.get("playsResid")), "favResid": num(fun.get("favResid")),
               "setId": r.get("setId") or r.get("beatmapSetId") or fun.get("setId"),
               "year": r.get("year") or fun.get("year"), "danBin": r.get("danBin") or fun.get("danBin")}
        if lab["playsResid"] is None and lab["favResid"] is None:
            continue
        if r.get("beatmapId") not in (None, ""):
            out[("b", str(r["beatmapId"]).split(".")[0])] = lab
        if r.get("chartKey"):
            out[("c", r["chartKey"])] = lab
    return out


def fun_rows(meta, labels, idx):
    """The human, unmirrored rows among idx that have a fun label -> (rows, labels)."""
    rows, labs = [], []
    for i in idx:
        m = meta[i]
        if m["kind"] != "human" or m.get("mirror", 0):
            continue
        lab = labels.get(("b", str(m.get("beatmapId")))) if m.get("beatmapId") is not None else None
        lab = lab or (labels.get(("c", m.get("chartKey"))) if m.get("chartKey") else None)
        if lab:
            rows.append(i)
            labs.append(lab)
    return rows, labs


def rank_labels(qids, values):
    """Within each qid, values -> integer ranks 0..n-1 (rank:pairwise wants relevance grades)."""
    out = np.zeros(len(values), dtype=np.float32)
    by = defaultdict(list)
    for k, q in enumerate(qids):
        by[q].append(k)
    for ks in by.values():
        order = sorted(ks, key=lambda k: values[k])
        for r, k in enumerate(order):
            out[k] = r
    return out


def train_rank_head(X, meta, labels, splits, field, qid_of, device, trees=400, depth=5, eta=0.05):
    """A rank:pairwise head on one fun field; -> (spec, z, metrics) or None when there is too little."""
    parts = {}
    for name in ("train", "val", "test"):
        rows, labs = fun_rows(meta, labels, np.where(splits == name)[0])
        keep = [(r, l) for r, l in zip(rows, labs) if l[field] is not None and qid_of(meta[r], l) is not None]
        parts[name] = keep
    if len(parts["train"]) < 50:
        return None
    mats = {}
    for name, keep in parts.items():
        if not keep:
            mats[name] = None
            continue
        q = np.array([str(qid_of(meta[r], l)) for r, l in keep])
        order = np.argsort(q, kind="stable")
        rows = np.array([keep[k][0] for k in order])
        vals = np.array([keep[k][1][field] for k in order], dtype=float)
        qn = q[order]
        _, qid = np.unique(qn, return_inverse=True)
        mats[name] = (X[rows], rank_labels(qn, vals), qid, vals, qn)
    Xt, yt, qt, _, _ = mats["train"]
    v = mats["val"]
    booster = train_xgb({"objective": "rank:pairwise", "max_depth": depth, "eta": eta, "eval_metric": "ndcg", "ndcg_exp_gain": False},
                        Xt, yt, None, v[0] if v else None, v[1] if v else None, trees, device, qid=qt, qid_v=v[2] if v else None)
    spec = export_xgb(booster, Xt[: min(len(Xt), 2000)])
    ref_v = raw_predict(spec, (v or mats["train"])[0])
    z = {"mean": float(ref_v.mean()), "std": float(ref_v.std() or 1.0)}
    metrics = {}
    for name in ("val", "test"):
        m = mats[name]
        if not m:
            continue
        s = raw_predict(spec, m[0])
        acc, pairs = pairwise_accuracy(m[4], m[3], s)
        metrics[name] = {"rows": int(len(s)), "pairwiseAcc": acc, "pairs": pairs, "spearman": spearman(m[3], s)}
    return spec, z, metrics


# ---- style ---------------------------------------------------------------------------------------------------------

def creator_counts(corpus_path, meta):
    """creatorKey -> (diffs, song groups, display name), from the corpus (all sources) or else from the data. The key is
    the corpus `creatorKey` ("u:<osu! user id>", merged by user id, else "n:<lower-cased name>"; none for converts), the
    same key the corpus weights cap and make-critic-negatives writes as `creator`."""
    diffs, groups, names = Counter(), defaultdict(set), {}
    if corpus_path and Path(corpus_path).exists():
        with open(corpus_path, encoding="utf-8") as f:
            for line in f.read().split("\n"):
                if not line.strip():
                    continue
                try:
                    c = json.loads(line)
                except json.JSONDecodeError:
                    continue
                key = c.get("creatorKey")
                if not key:
                    continue
                name = (c.get("creator") or "").strip() or key
                diffs[key] += 1
                groups[key].add(c.get("group"))
                names.setdefault(key, name)
    else:
        for m in meta:
            if m["kind"] == "human" and not m.get("mirror") and m.get("creator"):
                diffs[m["creator"]] += 1
                groups[m["creator"]].add(m.get("group"))
                names.setdefault(m["creator"], m.get("creatorName") or m["creator"])
    return {k: (diffs[k], len(groups[k]), names[k]) for k in diffs}


# Creator fields that name no mapper (chart converters and placeholders): never a style, always "unknown".
NOT_A_CREATOR = re.compile(r"^(unknown|blank|none|n/?a|-+|\?+|another|copied from.*|beginner|easy|normal|medium|hard|"
                           r"insane|expert|challenge|edit|hidden|various|various artists|converted.*|auto.*)$")


def is_creator(key):
    """A creatorKey that names a mapper: any "u:<id>"; an "n:<name>" (or a bare name) unless the name is a placeholder."""
    if not key:
        return False
    k = str(key).strip().lower()
    if k.startswith("u:"):
        return True
    return not NOT_A_CREATOR.match(k[2:] if k.startswith("n:") else k)


def eligible_creators(counts, min_diffs=STYLE_MIN_DIFFS, min_groups=STYLE_MIN_GROUPS):
    return {k for k, (d, g, _) in counts.items() if d >= min_diffs and g >= min_groups and is_creator(k)}


def standardise(X, mean, std):
    Z = (np.asarray(X, dtype=np.float64) - mean) / std
    Z[~np.isfinite(Z)] = 0.0
    return Z


def train_style_head(X, meta, splits, names, norm, counts, keys=None, Cs=(0.01, 0.1, 1.0), seed=7):
    """-> (style json, metrics) or None. keys: the classes to use (default: eligible creators with enough train maps)."""
    from sklearn.linear_model import LogisticRegression
    feat = [n for n in names if n not in META]
    cols = [names.index(n) for n in feat]
    mean = np.array([norm["mean"][names.index(n)] for n in feat])
    std = np.array([norm["std"][names.index(n)] for n in feat])
    human = np.array([m["kind"] == "human" and not m.get("mirror") for m in meta])
    creators = column(meta, "creator")
    if keys is None:
        ok = eligible_creators(counts)
        train_count = Counter(c for c, s, h in zip(creators, splits, human) if h and s == "train" and c in ok)
        keys = sorted(k for k, n in train_count.items() if n >= STYLE_MIN_TRAIN)
    if len(keys) < 2:
        return None
    label_of = {k: i for i, k in enumerate(keys)}
    unknown = len(keys)
    y = np.array([label_of.get(c, unknown) for c in creators])
    parts = {s: np.where(human & (splits == s))[0] for s in ("train", "val", "test")}
    Z = {s: standardise(X[idx][:, cols], mean, std) for s, idx in parts.items()}

    def topk(model, s, k):
        idx = parts[s]
        known = y[idx] != unknown
        if not known.any():
            return None
        p = model.predict_log_proba(Z[s][known])
        cls = list(model.classes_)
        col = np.array([cls.index(c) if c in cls else -1 for c in y[idx][known]])
        rank = (p > p[np.arange(len(p)), col][:, None]).sum(axis=1)
        return float((rank < k).mean())

    best = None
    for C in Cs:
        model = LogisticRegression(C=C, max_iter=3000, class_weight="balanced", random_state=seed)
        model.fit(Z["train"], y[parts["train"]])
        score = topk(model, "val", 5)
        if best is None or (score or 0) > (best[0] or 0):
            best = (score, C, model)
    _, C, model = best
    cls = list(model.classes_)
    W, b = [], []
    for c in list(range(len(keys))) + [unknown]:
        if c in cls:
            W.append([round(float(v), 8) for v in model.coef_[cls.index(c)]])
            b.append(round(float(model.intercept_[cls.index(c)]), 8))
        else:  # a class without train rows: never predicted
            W.append([0.0] * len(feat))
            b.append(-30.0)
    style = {"keys": keys, "names": [counts.get(k, (0, 0, k))[2] for k in keys], "maps": [int(counts.get(k, (0, 0, k))[0]) for k in keys],
             "unknown": True, "features": feat, "W": W, "b": b}
    metrics = {"classes": len(keys), "C": C, "top1": {s: topk(model, s, 1) for s in ("val", "test")},
               "top5": {s: topk(model, s, 5) for s in ("val", "test")}, "chanceTop5": min(1.0, 5 / (len(keys) + 1))}
    return style, metrics


# ---- the reference scorer (src/gen/critic.js must match it) -------------------------------------------------------

def _gather(names_all, x, names):
    at = {n: k for k, n in enumerate(names_all)}
    out = []
    for n in names:
        v = x[at[n]] if n in at else None
        out.append(float("nan") if v is None else float(v))
    return out


def _tree_raw(spec, xs):
    out = float(spec["baseline"][0])
    for trees in spec["iterations"]:
        t = trees[0]
        node = 0
        while not t["leaf"][node]:
            v = float(np.float32(xs[t["feature"][node]]))  # critic.js: float32 before the comparisons, like XGBoost
            left = t["missingLeft"][node] == 1 if math.isnan(v) else v <= t["threshold"][node]
            node = t["left"][node] if left else t["right"][node]
        out += t["value"][node]
    return out


def _z(v, z):
    return (v - z["mean"]) / z["std"] if z and z.get("std", 0) > 0 else v


PERSONAL_RULE = {"minVotes": 12, "minEachSign": 4, "minLooAuc": 0.6, "maxWeight": 0.5, "weightHalf": 40}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def personal_weight(p):
    """critic.js personalWeight: the model's weight, never above min(0.5, n / (n + 40)) (addendum §2.7)."""
    n = p.get("n") if p else None
    cap = min(PERSONAL_RULE["maxWeight"], n / (n + PERSONAL_RULE["weightHalf"])) if _num(n) and n > 0 else 0.0
    return min(p["weight"], cap) if _num(p.get("weight")) else cap


def personal_active(p):
    """critic.js personalActive: n >= 12 votes, >= 4 of each sign, leave-one-out AUC >= 0.6 (addendum §2.7)."""
    r = PERSONAL_RULE
    return bool(p and p.get("v") == 1 and p.get("names") and len(p["names"]) == len(p.get("w", []))
                and _num(p.get("n")) and p["n"] >= r["minVotes"]
                and _num(p.get("positives")) and p["positives"] >= r["minEachSign"]
                and _num(p.get("negatives")) and p["negatives"] >= r["minEachSign"]
                and _num(p.get("looAuc")) and p["looAuc"] >= r["minLooAuc"] and personal_weight(p) > 0)


def score_ref(critic, names_all, x, style=None, personal=None):
    """critic.js score() in plain Python: x is the CRITIC_FEATURES vector (None/NaN = missing)."""
    x = [float("nan") if v is None else float(v) for v in x]
    at = {n: k for k, n in enumerate(names_all)}
    blend = {**DEFAULT_BLEND, **(critic.get("blend") or {})}
    norm = critic.get("norm") or {}
    xs = _gather(names_all, x, critic["features"])
    human = zH = None
    if critic.get("human"):
        raw = _tree_raw(critic["human"], xs)
        human = 1 / (1 + math.exp(-raw))
        zH = _z(raw, norm.get("zH"))
    zF = None
    fun = critic.get("fun")
    if fun:
        heads = [(fun.get("within"), fun.get("zWithin")), (fun.get("cross"), fun.get("zCross"))]
        heads = [(s, z) for s, z in heads if s]
        if heads:
            zF = sum(_z(_tree_raw(s, xs), z) for s, z in heads) / len(heads)

    def val(name):
        v = x[at[name]] if name in at else float("nan")
        return v if math.isfinite(v) else None

    play = -(val("map_issues_per1000") or 0) / 10 - (val("map_forced_per1000") or 0) / 20
    zU = None
    if personal_active(personal):
        nidx = {n: k for k, n in enumerate(norm.get("names", []))}
        s = personal.get("b", 0.0)
        for j, n in enumerate(personal["names"]):
            v = val(n)
            if v is None:
                continue
            if n in nidx:
                mean, std = norm["mean"][nidx[n]], norm["std"][nidx[n]]
            else:
                mean, std = (personal.get("mean") or [0] * len(personal["names"]))[j], (personal.get("std") or [1] * len(personal["names"]))[j]
            s += personal["w"][j] * ((v - mean) / std if std > 0 else v - mean)
        zU = max(-8.0, min(8.0, s))
    logp = None
    st = critic.get("style")
    if style is not None and st and style in st["keys"]:
        nidx = {n: k for k, n in enumerate(norm["names"])}
        z = []
        for n in st["features"]:
            v = x[at[n]] if n in at else float("nan")
            mean, std = norm["mean"][nidx[n]], norm["std"][nidx[n]]
            z.append((v - mean) / (std if std > 0 else 1) if math.isfinite(v) else 0.0)
        logits = []
        for row, b in zip(st["W"], st["b"]):
            s = b
            for wj, zj in zip(row, z):
                s += wj * zj
            logits.append(s)
        mx = max(logits)
        logp = logits[st["keys"].index(style)] - mx - math.log(sum(math.exp(l - mx) for l in logits))
    s = blend["wP"] * play
    if zH is not None:
        s += zH
    if zF is not None:
        s += blend["wF"] * zF
    if zU is not None:
        s += personal_weight(personal) * zU
    if logp is not None:
        s += blend["wS"] * logp
    return {"human": human, "fun": zF, "play": play, "personal": zU, "style": logp, "score": s}


def finite(obj):
    """NaN and infinities -> None, so the JSON is strict (the app's JSON.parse refuses NaN / Infinity)."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: finite(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [finite(v) for v in obj]
    return obj


def strict_json(obj):
    return json.dumps(obj, allow_nan=False)


def json_roundtrip(obj):
    return json.loads(strict_json(obj))


def probes(critic, names, X, rows, styles, personal=None):
    out = []
    for k, i in enumerate(rows):
        # the shortest decimal of each float32: JS and Python parse the same text into the same double
        x = [None if not math.isfinite(float(v)) else float(np.format_float_positional(np.float32(v), unique=True, trim="-")) for v in X[i]]
        style = styles[k % len(styles)] if styles else None
        p = personal if (personal and k % 3 == 2) else None
        out.append({"x": x, "style": style, **({"personal": p} if p else {}), "expect": score_ref(critic, names, x, style, p)})
    return out


# ---- main ----------------------------------------------------------------------------------------------------------

def build_critic(args, names, meta, X, splits, log, small=False):
    kinds = column(meta, "kind")
    mirror = column(meta, "mirror", 0).astype(int)
    head_names = [n for n in names if n not in META]
    cols = [names.index(n) for n in head_names]
    y = (kinds == "human").astype(np.float32)
    tr = np.where(splits == "train")[0]
    va = np.where((splits == "val") & (mirror == 0))[0]
    te = np.where((splits == "test") & (mirror == 0))[0]
    if not len(tr) or y[tr].min() == y[tr].max():
        raise SystemExit("no train rows of both classes")
    w = row_weights(meta, tr)
    Xh = X[:, cols]

    # ---- human head (+ sweep) ----
    import xgboost as xgb
    if small:
        cfg = {"max_depth": 3, "eta": 0.3, "min_child_weight": 1}
        booster = train_xgb({"objective": "binary:logistic", **cfg}, Xh[tr], y[tr], w, None, None, 12, args.device)
    else:
        best = None
        for cfg in (SWEEP if args.sweep else [{"max_depth": args.depth, "eta": args.eta, "min_child_weight": 1}]):
            t0 = time.time()
            params = {"objective": "binary:logistic", "eval_metric": "auc", **cfg}
            booster = train_xgb(params, Xh[tr], y[tr], w, Xh[va] if len(va) else None, y[va] if len(va) else None, args.trees, args.device)
            p_val = booster.predict(xgb.DMatrix(Xh[va])) if len(va) else None
            val_auc = auc(p_val[y[va] == 1], p_val[y[va] == 0]) if p_val is not None else None
            log(f"  human head {cfg}: val AUC {val_auc if val_auc is None else round(val_auc, 4)}, {booster.num_boosted_rounds()} trees, {time.time() - t0:.1f} s")
            if best is None or (val_auc or 0) > (best[0] or 0):
                best = (val_auc, cfg, booster)
        _, cfg, booster = best
    probe_rows = tr[np.linspace(0, len(tr) - 1, min(len(tr), 4000)).astype(int)]
    spec = export_xgb(booster, Xh[probe_rows])
    xgb_margin = booster.predict(xgb.DMatrix(Xh[probe_rows[:500]]), output_margin=True)
    export_err = float(np.max(np.abs(xgb_margin - raw_predict(spec, Xh[probe_rows[:500]]))))
    calib = va if len(va) else tr
    raw_h = raw_predict(spec, Xh[calib[kinds[calib] == "human"]])
    zH = {"mean": float(raw_h.mean()), "std": float(raw_h.std() or 1.0)}
    gains = sorted(booster.get_score(importance_type="gain").items(), key=lambda kv: -kv[1])[:30]
    gains = [(head_names[int(k.lstrip("f"))], round(v, 2)) for k, v in gains]

    # ---- norm (train humans, unmirrored) ----
    hum = tr[(kinds[tr] == "human") & (mirror[tr] == 0)]
    with np.errstate(all="ignore"):
        mean = np.nanmean(X[hum].astype(np.float64), axis=0)
        std = np.nanstd(X[hum].astype(np.float64), axis=0)
    mean = np.where(np.isfinite(mean), mean, 0.0)
    std = np.where(np.isfinite(std) & (std > 1e-9), std, 1.0)
    norm = {"names": names, "mean": [round(float(v), 8) for v in mean], "std": [round(float(v), 8) for v in std], "zH": zH}

    # ---- fun heads ----
    fun = None
    fun_metrics = None
    labels = None
    fun_path = find_fun_labels(args.fun, args.data)
    if fun_path:
        labels = read_fun_labels(fun_path)
        log(f"  fun labels: {fun_path} ({len(labels)} keys)")
    elif small:
        labels = synthetic_fun_labels(meta, X, names)
        log("  fun labels: synthetic (parity fixture only)")
    else:
        log("  fun labels: none found - no fun head, wF = 0")
    if labels:
        def within_q(m, lab):
            return lab.get("setId") or m.get("setId")

        def cross_q(m, lab):
            return f"{lab.get('danBin') or round(m.get('dan') or 0)}:{lab.get('year') or 0}"

        kw = {"trees": 8, "depth": 2, "eta": 0.3} if small else {}
        within = train_rank_head(Xh, meta, labels, splits, "playsResid", within_q, args.device, **kw)
        cross = train_rank_head(Xh, meta, labels, splits, "favResid", cross_q, args.device, **kw)
        if within or cross:
            fun = {"within": within[0] if within else None, "zWithin": within[1] if within else None,
                   "cross": cross[0] if cross else None, "zCross": cross[1] if cross else None}
            fun_metrics = {"within": within[2] if within else None, "cross": cross[2] if cross else None, "labels": str(fun_path or "synthetic")}

    # ---- style head ----
    counts = creator_counts(args.corpus, meta)
    style_keys = None
    if small:
        human_rows = [m for m, s in zip(meta, splits) if m["kind"] == "human" and not m.get("mirror") and s == "train" and is_creator(m.get("creator"))]
        style_keys = sorted(k for k, _ in Counter(m["creator"] for m in human_rows).most_common(3))
    st = train_style_head(X, meta, splits, names, norm, counts, keys=style_keys, Cs=(0.1,) if small else (0.01, 0.1, 1.0), seed=SEED[0])
    style, style_metrics = st if st else (None, None)

    critic = {
        "kind": "critic-v1", "version": 1, "features": head_names, "human": spec, "fun": fun, "style": style, "norm": norm,
        "blend": {**DEFAULT_BLEND, "wF": DEFAULT_BLEND["wF"] if fun else 0.0},
    }
    critic = json_roundtrip(critic)
    # ---- metrics with the exported trees (what the app computes) ----
    metrics = {"config": cfg, "trees": len(spec["iterations"]), "exportMaxErr": export_err, "rows": {s: int((splits == s).sum()) for s in ("train", "val", "test")}}
    for name, idx in (("val", va), ("test", te)):
        if len(idx):
            metrics[name] = kind_aucs(meta, idx, raw_predict(critic["human"], Xh[idx]))
    metrics["fun"] = fun_metrics
    metrics["style"] = style_metrics
    metrics["gains"] = gains
    return critic, metrics, labels


def synthetic_fun_labels(meta, X, names):
    """Labels for the parity fixture only (no real fun data yet): a noisy function of two features."""
    rng = np.random.default_rng(3)
    a, b = names.index("w_rhythm_entropy_mean"), names.index("map_bar_repeat")
    out = {}
    for i, m in enumerate(meta):
        if m["kind"] != "human" or m.get("mirror"):
            continue
        v = float(np.nan_to_num(X[i, a])) - float(np.nan_to_num(X[i, b])) + float(rng.normal() * 0.3)
        out[("c", m.get("chartKey") or m["map"])] = {"playsResid": v, "favResid": -v, "setId": m.get("setId") or (m.get("group") or "")[:4], "year": 2020, "danBin": None}
        if not m.get("chartKey"):
            m["chartKey"] = m["map"]
    return out


def write_report(path, args, metrics, critic, minutes):
    lines = [f"# Critic training ({time.strftime('%Y-%m-%d %H:%M')})", "", f"- data: `{args.data}`", f"- out: `{args.out}`",
             f"- rows: {metrics['rows']}", f"- human head: {metrics['config']}, {metrics['trees']} trees; export max |XGBoost - JSON| = {metrics['exportMaxErr']:.2e}",
             f"- minutes: {minutes:.1f}", ""]
    for s in ("val", "test"):
        if s in metrics:
            lines.append(f"## {s} AUC (human vs …)")
            lines += [f"- {k}: {v if not isinstance(v, float) else round(v, 4)}" for k, v in metrics[s].items()]
            lines.append("")
    lines.append(f"## fun\n\n{json.dumps(metrics.get('fun'), indent=1)}\n")
    lines.append(f"## style\n\n{json.dumps(metrics.get('style'), indent=1)}\n")
    lines.append("## top feature gains (human head)\n")
    lines += [f"- {n}: {g}" for n, g in metrics["gains"]]
    lines.append(f"\nblend: {critic['blend']}")
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", default=None)
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--trees", type=int, default=600)
    ap.add_argument("--depth", type=int, default=6)
    ap.add_argument("--eta", type=float, default=0.05)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--fun", default="auto")
    ap.add_argument("--corpus", default="A:/SneezeyTrain/corpus/corpus.jsonl")
    ap.add_argument("--fixture", default=None, help="also write a small parity fixture critic (tests/fixtures/critic-parity.json)")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)
    SEED[0] = args.seed
    t0 = time.time()

    def log(msg):
        print(msg, flush=True)

    names, meta, X = load(args.data)
    splits = column(meta, "split")
    log(f"rows {len(meta)}, features {len(names)}, splits {dict(Counter(splits))}, kinds {dict(Counter(column(meta, 'kind')))}")
    critic, metrics, _ = build_critic(args, names, meta, X, splits, log)
    styles = critic["style"]["keys"] if critic.get("style") else []
    rows = np.where((splits == ("val" if (splits == "val").any() else "train")))[0]
    pick = rows[np.linspace(0, len(rows) - 1, min(8, len(rows))).astype(int)]
    critic["metrics"] = metrics
    critic["parity"] = probes(critic, names, X, pick, [None, *styles[:1]])
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    critic["metrics"] = finite(critic["metrics"])
    Path(args.out).write_text(strict_json(critic), encoding="utf-8")
    minutes = (time.time() - t0) / 60
    for s in ("val", "test"):
        if s in metrics:
            log(f"{s}: " + ", ".join(f"{k} {v:.4f}" if isinstance(v, float) else f"{k} {v}" for k, v in metrics[s].items()))
    log(f"style: {metrics['style']}")
    log(f"fun: {metrics['fun']}")
    log(f"wrote {args.out} ({Path(args.out).stat().st_size / 1e6:.2f} MB) in {minutes:.1f} min")
    if args.report:
        write_report(args.report, args, metrics, critic, minutes)
    if args.fixture:
        small, small_metrics, _ = build_critic(args, names, [dict(m) for m in meta], X, splits, lambda m: None, small=True)
        if small.get("style"):  # the committed fixture carries no mapper names
            n = len(small["style"]["keys"])
            small["style"]["keys"] = [f"style-{chr(97 + k)}" for k in range(n)]
            small["style"]["names"] = [f"Style {chr(65 + k)}" for k in range(n)]
        keys = small["style"]["keys"] if small.get("style") else []
        personal = {"v": 1, "names": ["w_jack_rate_mean", "w_rhythm_entropy_mean", "map_issues_per1000"], "w": [-1.5, 0.7, -0.2], "b": 0.1, "n": 20,
                    "positives": 9, "negatives": 11, "looAuc": 0.72, "weight": 0.3}
        rows = np.where(splits != "train")[0] if (splits != "train").any() else np.arange(len(meta))
        pick = rows[np.linspace(0, len(rows) - 1, min(7, len(rows))).astype(int)]
        fixture = {"note": "Small critic from tools/train_critic.py --fixture (synthetic fun labels when none exist); expected values from score_ref.",
                   "critic": small, "probes": probes(small, names, X, pick, [None, *keys[:2]], personal)}
        Path(args.fixture).write_text(strict_json(fixture), encoding="utf-8")
        log(f"wrote the parity fixture {args.fixture} ({Path(args.fixture).stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main(sys.argv[1:])
