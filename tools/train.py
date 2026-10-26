"""Train the combined dan model on benchmark features, evaluate honestly, export a JSON model + meta.

Usage:
  python -I tools/train.py                 full run → models/, reports/benchmark.md
  python -I tools/train.py --check         quick ONNX parity check on 50 rows
  python -I tools/train.py --dump-parity tests/fixtures/model-parity.json
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
TUNED = {"est_azusa", "est_roxy", "est_mixed", "has_azusa", "has_roxy", "has_mixed",
         "est_min", "est_max", "est_mean", "est_range"}
MSD_SKILLSETS = ["msd_stream", "msd_jumpstream", "msd_handstream", "msd_stamina",
                 "msd_jackspeed", "msd_chordjack", "msd_technical"]
# Baselines are the officially published benchmark results (data/bench/results/<name>.csv).
BASELINES = ["Mixed", "Roxy", "Azusa", "Daniel", "Companella", "ISOR", "Sunny"]
CLEAN_MIN_ROWS = 50
SEED = 7


def load_rows(path):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    names = list(rows[0]["vector"].keys())
    for r in rows:
        if list(r["vector"].keys()) != names:
            sys.exit(f"feature order mismatch in row {r['name']}")
    return rows, names


def matrix(rows, names):
    return np.array([[np.nan if r["vector"][n] is None else float(r["vector"][n]) for n in names] for r in rows],
                    dtype=np.float32)


def variant_names(all_names, variant):
    return all_names if variant == "B" else [n for n in all_names if n not in TUNED]


def candidates():
    return {
        "ridge": lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                                       RidgeCV(alphas=np.logspace(-2, 3, 21))),
        "gbm": lambda: HistGradientBoostingRegressor(max_depth=4, learning_rate=0.05, max_iter=400,
                                                     min_samples_leaf=20, l2_regularization=1.0, random_state=SEED),
    }


def oof_predict(make_model, X, y, groups):
    pred = np.full(len(y), np.nan)
    for train, test in GroupKFold(n_splits=5).split(X, y, groups):
        model = make_model().fit(X[train], y[train])
        pred[test] = model.predict(X[test])
    return pred


def metrics(y, pred, patterns):
    ok = ~np.isnan(pred)
    if not ok.any():
        return None
    err = y[ok] - pred[ok]
    by_pattern = {}
    for p in sorted(set(patterns)):
        mask = ok & (patterns == p)
        if mask.any():
            by_pattern[p] = float(np.mean(np.abs(y[mask] - pred[mask])))
    return {"n": int(ok.sum()), "mae": float(np.mean(np.abs(err))), "bias": float(np.mean(err)),
            "within1": float(np.mean(np.abs(err) <= 1)), "byPattern": by_pattern}


def baseline_pred(rows, key):
    return np.array([np.nan if r["vector"][key] is None else float(r["vector"][key]) for r in rows])


def published_pred(rows, results_dir, algorithm):
    import csv
    path = Path(results_dir) / f"{algorithm}.csv"
    if not path.exists():
        return None
    got = {}
    for r in csv.DictReader(path.open(encoding="utf-8")):
        try:
            got[r["name"]] = float(r["got"])
        except ValueError:
            pass
    return np.array([got.get(r["name"], np.nan) for r in rows])


def export_json(model):
    """Plain-JSON model for the JS app: ridge coefficients or HGB trees (no ONNX runtime needed)."""
    if isinstance(model, HistGradientBoostingRegressor):
        trees = []
        for (predictor,) in model._predictors:
            n = predictor.nodes
            trees.append({
                "feature": n["feature_idx"].astype(int).tolist(),
                "threshold": n["num_threshold"].astype(float).tolist(),
                "missingLeft": n["missing_go_to_left"].astype(int).tolist(),
                "left": n["left"].astype(int).tolist(),
                "right": n["right"].astype(int).tolist(),
                "leaf": n["is_leaf"].astype(int).tolist(),
                "value": n["value"].astype(float).tolist(),
            })
        return {"type": "gbm", "baseline": float(np.ravel(model._baseline_prediction)[0]), "trees": trees}
    imputer, scaler, ridge = model.steps[0][1], model.steps[1][1], model.steps[2][1]
    return {"type": "ridge", "impute": imputer.statistics_.tolist(), "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(), "coef": ridge.coef_.tolist(), "intercept": float(ridge.intercept_)}


MEAN_SPEC_FEATURES = ["est_mixed", "est_azusa"]
MEAN_SPEC_FALLBACK = ["est_roxy", "est_daniel", "est_companella"]


def mean_spec(names):
    """Parameter-free ensemble: mean of Mixed and Azusa, else the first available fallback estimator."""
    return {"type": "mean", "features": [names.index(f) for f in MEAN_SPEC_FEATURES],
            "fallback": [names.index(f) for f in MEAN_SPEC_FALLBACK]}


def json_predict(spec, X):
    """Reference evaluator — the JS one in src/core/model.js must match it."""
    X = np.asarray(X, dtype=float)
    if spec["type"] == "mean":
        out = np.full(len(X), np.nan)
        for i, x in enumerate(X):
            main = x[spec["features"]]
            main = main[~np.isnan(main)]
            if len(main):
                out[i] = main.mean()
            else:
                fb = x[spec["fallback"]]
                fb = fb[~np.isnan(fb)]
                out[i] = fb[0] if len(fb) else np.nan
        return out
    if spec["type"] == "ridge":
        Z = np.where(np.isnan(X), spec["impute"], X)
        return spec["intercept"] + ((Z - spec["mean"]) / spec["scale"]) @ np.array(spec["coef"])
    out = np.full(len(X), spec["baseline"])
    for i, x in enumerate(X):
        for t in spec["trees"]:
            node = 0
            while not t["leaf"][node]:
                v = x[t["feature"][node]]
                go_left = t["missingLeft"][node] if np.isnan(v) else v <= t["threshold"][node]
                node = t["left"][node] if go_left else t["right"][node]
            out[i] += t["value"][node]
    return out


def spread_table(errors, ranges):
    """4 quantile bins over estimator disagreement; half width = 80th percentile |error| per bin."""
    finite = ~np.isnan(ranges)
    edges = np.quantile(ranges[finite], [0.25, 0.5, 0.75]).tolist() if finite.sum() >= 8 else []
    idx = np.where(finite, np.searchsorted(edges, np.nan_to_num(ranges), side="right"), len(edges))
    half = []
    for b in range(len(edges) + 1):
        e = np.abs(errors[idx == b])
        half.append(float(np.quantile(e, 0.8)) if len(e) else float(np.quantile(np.abs(errors), 0.8)))
    return {"bins": edges, "halfWidth": half}


def tune_tech(rows):
    tech = np.array([r["pattern"] == "tech" for r in rows])
    speedy = np.array([r["pattern"] in ("speed", "stamina") for r in rows])
    mixed = np.array([r["vector"]["top_cluster_mixed"] == 1 for r in rows])
    tvals = np.array([r["vector"]["msd_technical"] or 0 for r in rows], dtype=float)
    tops = np.array([max((r["vector"][k] or 0) for k in MSD_SKILLSETS) for r in rows], dtype=float)
    best = None
    for ratio in np.round(np.arange(0.70, 0.9901, 0.01), 2):
        flag = mixed & (tvals >= ratio * tops)
        tp, fp, fn = (flag & tech).sum(), (flag & ~tech).sum(), (~flag & tech).sum()
        f1 = 2 * tp / max(1, 2 * tp + fp + fn)
        cand = {"ratio": float(ratio), "f1": float(f1), "techHit": float(flag[tech].mean()) if tech.any() else 0.0,
                "speedStaminaHit": float(flag[speedy].mean()) if speedy.any() else 0.0}
        if best is None or cand["f1"] > best["f1"]:
            best = cand
    return best


def fmt(m):
    if not m:
        return "— | — | — | — |"
    return f"{m['n']} | {m['mae']:.3f} | {m['bias']:+.3f} | {m['within1']:.0%} |"


def write_report(path, results, chosen, reason, clean_info, tech, patterns):
    lines = ["# Точность анализатора данов (4K рис)", "",
             f"Дата: {datetime.now(timezone.utc).date()}. Шкала: 1–10 даны, Alpha = 11 … Kappa = 20. "
             "Ошибка = ожидаемое − предсказанное, в уровнях дана.", "",
             f"**В приложении: вариант {chosen}.** {reason}", ""]
    for title, key in (("Перекрёстная проверка (5 частей, разбиение по песням)", "oof"),
                       ("Чистый набор (карты, добавленные после настройки Azusa/Roxy/Mixed)", "clean")):
        lines += [f"## {title}", ""]
        if key == "clean":
            lines += [clean_info, ""]
        lines += ["| Алгоритм | Карт | Средняя ошибка | Смещение | В пределах ±1 |", "|---|---|---|---|---|"]
        for name, m in results[key].items():
            lines.append(f"| {name} | {fmt(m)}")
        lines += ["", "Средняя ошибка по типам карт:", "",
                  "| Алгоритм | " + " | ".join(patterns) + " |", "|---|" + "---|" * len(patterns)]
        for name, m in results[key].items():
            cells = [f"{m['byPattern'][p]:.2f}" if m and p in m["byPattern"] else "—" for p in patterns]
            lines.append(f"| {name} | " + " | ".join(cells) + " |")
        lines.append("")
    lines += ["## Метка Tech", "",
              f"Порог MSD Technical ≥ {tech['ratio']:.2f} × главный скиллсет (и неровный ритм главного паттерна). "
              f"Ставится на {tech['techHit']:.0%} карт типа tech и на {tech['speedStaminaHit']:.0%} карт speed/stamina "
              f"(F1 = {tech['f1']:.2f}).", ""]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", default=str(ROOT / "data/features.jsonl"))
    ap.add_argument("--clean", default=str(ROOT / "data/clean-names.json"))
    ap.add_argument("--out", default=str(ROOT / "models"))
    ap.add_argument("--report", default=str(ROOT / "reports/benchmark.md"))
    ap.add_argument("--results", default=str(ROOT / "data/bench/results"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dump-parity")
    args = ap.parse_args()

    rows, all_names = load_rows(args.features)
    y = np.array([r["expected"] for r in rows], dtype=float)
    groups = np.array([r["group"] for r in rows])
    patterns = np.array([r["pattern"] for r in rows])

    if args.check:
        sub = slice(0, 50)
        X = matrix(rows[sub], all_names)
        for name, make in candidates().items():
            model = make().fit(X, y[sub])
            diff = np.max(np.abs(json_predict(export_json(model), X) - model.predict(X)))
            if diff > 1e-4:
                sys.exit(f"parity FAILED for {name}: {diff}")
        print("parity ok")
        return

    clean = set(json.loads(Path(args.clean).read_text(encoding="utf-8"))["names"])
    is_clean = np.array([r["name"] in clean for r in rows])
    clean_groups = set(groups[is_clean])
    train_for_clean = ~np.isin(groups, list(clean_groups))

    results = {"oof": {}, "clean": {}}
    best = {}
    for variant in ("A", "B"):
        names = variant_names(all_names, variant)
        X = matrix(rows, names)
        scored = []
        for model_name, make in candidates().items():
            pred = oof_predict(make, X, y, groups)
            scored.append((metrics(y, pred, patterns)["mae"], model_name, pred))
        mae, model_name, pred = min(scored, key=lambda s: s[0])
        clean_pred = np.full(len(y), np.nan)
        if is_clean.any() and train_for_clean.any():
            m = candidates()[model_name]().fit(X[train_for_clean], y[train_for_clean])
            clean_pred[is_clean] = m.predict(X[is_clean])
        best[variant] = {"names": names, "model": model_name, "oof": pred, "clean": clean_pred}
        label = f"Наш, вариант {variant} ({model_name})"
        results["oof"][label] = metrics(y, pred, patterns)
        results["clean"][label] = metrics(y, clean_pred, patterns)

    X_all = matrix(rows, all_names)
    mspec = mean_spec(all_names)
    mean_pred = json_predict(mspec, X_all)
    best["M"] = {"names": all_names, "model": "mean", "oof": mean_pred,
                 "clean": np.where(is_clean, mean_pred, np.nan), "spec": mspec}
    results["oof"]["Наш, вариант M (среднее Mixed+Azusa)"] = metrics(y, mean_pred, patterns)
    results["clean"]["Наш, вариант M (среднее Mixed+Azusa)"] = metrics(y, best["M"]["clean"], patterns)

    for name in BASELINES:
        p = published_pred(rows, args.results, name)
        if p is None:
            continue
        results["oof"][name] = metrics(y, p, patterns)
        results["clean"][name] = metrics(y, np.where(is_clean, p, np.nan), patterns)

    def mae(v, k):
        label = "Наш, вариант M (среднее Mixed+Azusa)" if v == "M" else f"Наш, вариант {v} ({best[v]['model']})"
        return results[k][label]
    mixed_oof = results["oof"]["Mixed"]["mae"]
    if is_clean.sum() >= CLEAN_MIN_ROWS:
        chosen = min(("A", "B", "M"), key=lambda v: mae(v, "clean")["mae"])
        reason = (f"Выбран по меньшей ошибке на чистом наборе ({int(is_clean.sum())} карт). "
                  "Выбор делался по этому же набору среди трёх вариантов, так что выигрыш может быть чуть завышен.")
        clean_info = (f"Карт в чистом наборе: {int(is_clean.sum())}. Модель обучалась без них и без других рейтов "
                      "тех же песен. Набор в основном из импорта «δ-таблицы», поэтому смещён к уровню Delta.")
    else:
        chosen = "A" if mae("A", "oof")["mae"] < mixed_oof else "B"
        reason = ("Чистого набора слишком мало, выбран по перекрёстной проверке."
                  + (" Цифра варианта B может быть завышена: Azusa/Roxy/Mixed подгонялись на этих же картах." if chosen == "B" else ""))
        clean_info = f"Чистый набор слишком мал ({int(is_clean.sum())} карт) — честной отдельной проверки нет."

    sel = best[chosen]
    X = matrix(rows, sel["names"])
    if chosen == "M":
        spec = sel["spec"]
    else:
        final = candidates()[sel["model"]]().fit(X, y)
        spec = export_json(final)
        if np.max(np.abs(json_predict(spec, X) - final.predict(X))) > 1e-6:
            sys.exit("final JSON parity failed")

    range_key = "esta_range" if chosen == "A" else "est_range"
    ranges = baseline_pred(rows, range_key)
    spread = spread_table(y - sel["oof"], ranges)
    tech = tune_tech(rows)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {"modelSpec": spec, "featureNames": sel["names"], "variant": chosen, "model": sel["model"], "rangeFeature": range_key,
            "techMsdRatio": tech["ratio"], "spread": spread,
            "metrics": {"oof": mae(chosen, "oof"), "clean": mae(chosen, "clean"), "mixedOof": results["oof"]["Mixed"]},
            "trainedAt": datetime.now(timezone.utc).isoformat(),
            "leoblackCommit": (ROOT / "vendor/leoblack/VERSION").read_text().strip()}
    (out / "dan_model.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    write_report(args.report, results, chosen, reason, clean_info, tech, sorted(set(patterns)))

    if args.dump_parity:
        pick = np.linspace(0, len(rows) - 1, 10).astype(int)
        sample = [{"vector": {n: rows[i]["vector"][n] for n in sel["names"]},
                   "prediction": float(json_predict(spec, X[i:i + 1])[0])} for i in pick]
        Path(args.dump_parity).write_text(json.dumps(sample, indent=1), encoding="utf-8")

    print(json.dumps({"chosen": chosen, "model": sel["model"], "oof": mae(chosen, "oof")["mae"],
                      "mixedOof": mixed_oof, "clean": (mae(chosen, "clean") or {}).get("mae"),
                      "mixedClean": (results["clean"]["Mixed"] or {}).get("mae"), "tech": tech}, ensure_ascii=False))


if __name__ == "__main__":
    main()
