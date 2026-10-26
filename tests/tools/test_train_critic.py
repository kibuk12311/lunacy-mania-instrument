"""Tests for tools/train_critic.py (plain asserts; no pytest in the venv).

Run: .venv/Scripts/python.exe -I tests/tools/test_train_critic.py
"""
import importlib.util
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("train_critic", ROOT / "tools" / "train_critic.py")
tc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tc)


def test_split_rule_matches_js():
    # crc32 values computed with node:zlib (tools/make-critic-negatives.mjs splitOf)
    assert tc.split_of("4k|streamchallenge5") == "val"  # 3698516581 % 10 == 1
    assert tc.split_of("song|1") == "train"  # 1663259909 % 10 == 9
    assert tc.split_of("p:1stshukusainoelementalia") == "train"


def test_export_matches_xgboost_and_reference_matches_export():
    import xgboost as xgb
    rng = np.random.default_rng(1)
    X = rng.normal(size=(3000, 12)).astype(np.float32)
    X[rng.random(X.shape) < 0.15] = np.nan
    y = (np.nan_to_num(X[:, 0]) - np.nan_to_num(X[:, 3]) + 0.3 * rng.normal(size=3000) > 0).astype(np.float32)
    booster = tc.train_xgb({"objective": "binary:logistic", "max_depth": 4, "eta": 0.2}, X, y, None, None, None, 40, "cpu")
    spec_ = tc.export_xgb(booster, X[:1000])
    margin = booster.predict(xgb.DMatrix(X), output_margin=True)
    ref = tc.raw_predict(spec_, X)
    assert np.max(np.abs(margin - ref)) < 1e-4, np.max(np.abs(margin - ref))
    # the scalar reference (score_ref's tree walk) equals the vectorised one exactly
    for i in range(0, 3000, 250):
        assert tc._tree_raw(spec_, [float(v) for v in X[i]]) == ref[i]


def test_rank_head_export():
    import xgboost as xgb
    rng = np.random.default_rng(2)
    X = rng.normal(size=(600, 6)).astype(np.float32)
    q = np.repeat(np.arange(100), 6)
    y = tc.rank_labels(q, X[:, 0] + 0.1 * rng.normal(size=600))
    booster = tc.train_xgb({"objective": "rank:pairwise", "max_depth": 3, "eta": 0.3}, X, y, None, None, None, 20, "cpu", qid=q)
    spec_ = tc.export_xgb(booster, X)
    assert np.max(np.abs(booster.predict(xgb.DMatrix(X, qid=q), output_margin=True) - tc.raw_predict(spec_, X))) < 1e-4
    acc, pairs = tc.pairwise_accuracy(q, y, tc.raw_predict(spec_, X))
    assert pairs == 100 * 15 and acc > 0.8


def test_pairwise_accuracy_and_spearman():
    assert tc.pairwise_accuracy(["a", "a", "a"], [1, 2, 3], [0.1, 0.2, 0.3]) == (1.0, 3)
    assert tc.pairwise_accuracy(["a", "a", "b", "b"], [1, 2, 1, 2], [0.2, 0.1, 0.2, 0.1]) == (0.0, 2)
    assert tc.pairwise_accuracy(["a", "a"], [1, 1], [0.1, 0.2]) == (None, 0)
    assert abs(tc.spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12
    assert tc.rank_labels(["x", "x", "y"], [3.0, 1.0, 5.0]).tolist() == [1, 0, 0]


def test_row_weights_balance_each_map():
    meta = [{"map": "m1", "group": "g", "kind": "human"}, {"map": "m1", "group": "g", "kind": "human"},
            {"map": "m1", "group": "g", "kind": "gen"}, {"map": "m1", "group": "g", "kind": "perturb"}, {"map": "m1", "group": "g", "kind": "perturb"},
            {"map": "m2", "group": "g", "kind": "human"}, {"map": "m2", "group": "g", "kind": "gen"}]
    w = tc.row_weights(meta, list(range(len(meta))))
    s = 1 / math.sqrt(2)
    assert abs(w[0] + w[1] - s) < 1e-6 and abs(w[2] + w[3] + w[4] - s) < 1e-6
    assert abs(w[5] - s) < 1e-6 and abs(w[6] - s) < 1e-6


def test_style_eligibility_counts_diffs_and_groups():
    with tempfile.TemporaryDirectory() as d:
        corpus = Path(d) / "corpus.jsonl"
        # one mapper under two names (renamed): one creatorKey by user id, counted together
        lines = [{"creator": "Many" if k % 2 else "Many_Old", "creatorKey": "u:5", "group": f"g{k % 8}"} for k in range(30)]
        lines += [{"creator": "FewGroups", "creatorKey": "n:fewgroups", "group": f"g{k % 3}"} for k in range(40)]
        lines += [{"creator": "few", "creatorKey": "n:few", "group": f"g{k}"} for k in range(10)]
        lines += [{"creator": "4k advanced", "creatorKey": None, "group": f"e{k}"} for k in range(40)]  # converts: no key
        corpus.write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")
        counts = tc.creator_counts(str(corpus), [])
    assert counts["u:5"][:2] == (30, 8)
    assert tc.eligible_creators(counts) == {"u:5"}
    assert all(k.startswith(("u:", "n:")) for k in counts)
    assert tc.is_creator("u:5") and tc.is_creator("n:jubo") and not tc.is_creator("n:unknown") and not tc.is_creator(None)
    for placeholder in ("Unknown", "copied from copied f", "blank", "Hard", "another"):
        assert not tc.is_creator(placeholder), placeholder
    assert tc.is_creator("Dani") and tc.is_creator("jubo")
    assert tc.eligible_creators({"unknown": (999, 99, "Unknown"), "jubo": (40, 9, "jubo")}) == {"jubo"}


def test_fun_labels_jsonl_csv_and_missing():
    with tempfile.TemporaryDirectory() as d:
        j = Path(d) / "fun.jsonl"
        j.write_text("\n".join(json.dumps(x) for x in [
            {"beatmapId": 11, "playsResid": 0.5, "favResid": -0.1, "setId": 7, "year": 2019},
            {"chartKey": "abc", "fun": {"playsResid": 1.5, "favResid": None}},
            {"beatmapId": 12, "playsResid": None, "favResid": None},
        ]), encoding="utf-8")
        labels = tc.read_fun_labels(j)
        assert labels[("b", "11")]["playsResid"] == 0.5 and labels[("b", "11")]["setId"] == 7
        assert labels[("c", "abc")]["playsResid"] == 1.5
        assert ("b", "12") not in labels
        c = Path(d) / "fun.csv"
        c.write_text("beatmapId,playsResid,favResid,setId\n5,0.25,0.75,9\n", encoding="utf-8")
        assert tc.read_fun_labels(c)[("b", "5")]["favResid"] == 0.75
        assert tc.find_fun_labels("none", d) is None
        assert tc.find_fun_labels(str(Path(d) / "missing.jsonl"), d) is None
        (Path(d) / "fun-labels.jsonl").write_text(j.read_text(encoding="utf-8"), encoding="utf-8")
        assert tc.find_fun_labels("auto", d) == Path(d) / "fun-labels.jsonl"


def test_score_ref_blend():
    names = ["a", "b", "map_issues_per1000", "map_forced_per1000"]
    leaf = lambda v: {"feature": [0], "threshold": [0.0], "missingLeft": [0], "left": [0], "right": [0], "leaf": [1], "value": [v]}
    split = {"feature": [0, 0, 0], "threshold": [0.5, 0, 0], "missingLeft": [1, 0, 0], "left": [1, 0, 0], "right": [2, 0, 0], "leaf": [0, 1, 1], "value": [0, -1.0, 2.0]}
    critic = {"kind": "critic-v1", "features": ["a", "b"], "human": {"baseline": [0.25], "iterations": [[split], [leaf(0.5)]]},
              "fun": {"within": {"baseline": [0.0], "iterations": [[leaf(1.0)]]}, "zWithin": {"mean": 0.0, "std": 2.0}, "cross": None, "zCross": None},
              "style": {"keys": ["x"], "unknown": True, "features": ["b"], "W": [[1.0], [0.0]], "b": [0.0, 0.0]},
              "norm": {"names": names, "mean": [0, 1, 0, 0], "std": [1, 2, 1, 1], "zH": {"mean": 1.0, "std": 0.5}},
              "blend": {"wF": 0.2, "wP": 1.0, "wU": 0.0, "wS": 0.5}}
    r = tc.score_ref(critic, names, [1.0, 3.0, 5.0, 20.0], style="x")
    raw = 0.25 + 2.0 + 0.5
    assert abs(r["human"] - 1 / (1 + math.exp(-raw))) < 1e-12
    zH = (raw - 1.0) / 0.5
    assert abs(r["fun"] - 0.5) < 1e-12
    assert abs(r["play"] - (-0.5 - 1.0)) < 1e-12
    lp = 1.0 - math.log(math.exp(1.0) + 1.0)
    assert abs(r["style"] - lp) < 1e-12
    assert abs(r["score"] - (zH + 0.2 * 0.5 + r["play"] + 0.5 * lp)) < 1e-12
    missing = tc.score_ref(critic, names, [None, None, None, None])
    assert missing["style"] is None and missing["play"] == 0
    assert abs(missing["human"] - 1 / (1 + math.exp(-(0.25 - 1.0 + 0.5)))) < 1e-12, "missing a goes left"


def test_personal_rule_matches_critic_js():
    base = {"v": 1, "names": ["a"], "w": [1.0], "b": 0.0, "n": 12, "positives": 4, "negatives": 8, "looAuc": 0.6, "weight": 0.5}
    assert tc.personal_active(base)
    for bad in ({"n": 11}, {"positives": 3}, {"negatives": 3}, {"looAuc": 0.59}, {"looAuc": None}, {"weight": 0}):
        assert not tc.personal_active({**base, **bad}), bad
    assert abs(tc.personal_weight(base) - 12 / 52) < 1e-15
    assert tc.personal_weight({**base, "n": 2000}) == 0.5
    critic = {"kind": "critic-v1", "features": ["a"], "human": None, "norm": {"names": ["a"], "mean": [0.0], "std": [1.0]}}
    on = tc.score_ref(critic, ["a"], [2.0], personal=base)
    off = tc.score_ref(critic, ["a"], [2.0], personal={**base, "looAuc": 0.5})
    assert off["personal"] is None and abs(on["personal"] - 2.0) < 1e-12
    assert abs(on["score"] - off["score"] - (12 / 52) * 2.0) < 1e-12


def test_tree_reference_compares_float32():
    c32 = float(np.float32(0.3))
    below = float(np.nextafter(np.float32(c32), np.float32(-np.inf)))
    tree = {"feature": [0, 0, 0], "threshold": [below, 0, 0], "missingLeft": [0, 0, 0], "left": [1, 0, 0], "right": [2, 0, 0],
            "leaf": [0, 1, 1], "value": [0.0, -1.0, 1.0]}
    spec = {"baseline": [0.0], "iterations": [[tree]]}
    assert tc._tree_raw(spec, [below + 2 ** -28]) == -1.0, "rounds to the threshold in float32: left, as XGBoost"
    assert tc._tree_raw(spec, [c32 - 2 ** -28]) == 1.0, "rounds up to the condition: right"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as error:  # noqa: BLE001 - report every failing test
            failed += 1
            print(f"FAIL {name}: {error!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
