"""Fun labels for the critic's fun head (mapgen v3 ML addendum §3.4, task E5): popularity residuals of osu!mania 4K
difficulties from project-riz/osu-beatmap-tags metadata.csv (osu! API v1 fields; downloaded with the user's OK).

  playsResid  residual of log1p(plays) after a set fixed effect + the diff's star rank in its set + whether it is the
              set's top diff (the diff count is constant inside a set, so the fixed effect absorbs it); null for a set
              with a single 4K diff (nothing to compare it with)
  passResid   residual of the pass ratio (passes / plays, diffs with >= 50 plays) after a cubic spline in star rating
  favResid    residual of log1p(setFavs) after log1p(setPlays) + year + approval status (a set-level number, the same
              for every diff of the set). osu! API v1 favourite_count is per set, so favs == setFavs here.
  setPlays    plays of the whole set (every mode in metadata.csv); the tracker manifest's playCount fills sets HF lacks
              (those get a set-only line: { setId, setPlays }).

Sanity (report): the Spearman correlation of each residual with the star rating must stay under 0.1 in size. If a
residual fails it with the plan's covariates, the star rating is added to that regression (playsResid: a within-set
spline in the diff's stars; favResid: a spline in the set's top stars; passResid: a finer spline) and the report says so.

Usage: python -I tools/fun-labels.py [metadata.csv=A:/SneezeyTrain/hf-meta/metadata.csv]
         [--manifest A:/SneezeyTrain/manifest.json] [--out A:/SneezeyTrain/corpus/fun-labels.jsonl]
Writes <out> (one line per 4K diff, by beatmapId, plus set-only lines) and <out minus .jsonl>-report.json.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import SplineTransformer

NEEDED = ["beatmap_id", "playcount", "passcount", "favourite_count"]
USED = NEEDED + ["beatmapset_id", "mode", "diff_size", "difficultyrating", "approved", "approved_date", "submit_date"]
MIN_PASS_PLAYS = 50
RHO_MAX = 0.1


def _year(row_date):
    s = str(row_date or "")
    return int(s[:4]) if s[:4].isdigit() else None


def _resid_ols(y, X):
    m = LinearRegression().fit(X, y)
    return y - m.predict(X)


def _spline(x, n_knots=8):
    return SplineTransformer(n_knots=n_knots, degree=3, include_bias=False).fit_transform(np.asarray(x, dtype=float).reshape(-1, 1))


def _rho(a, b):
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 10:
        return None
    r = spearmanr(a[ok], b[ok]).statistic
    return None if not np.isfinite(r) else float(r)


def fun_labels(rows, tracker_set_plays=None):
    """rows: metadata.csv records (dicts or a DataFrame, every mode). Returns (label lines, report)."""
    df = rows if isinstance(rows, pd.DataFrame) else pd.DataFrame(rows)
    header_ok = all(c in df.columns for c in NEEDED)
    if not header_ok:
        raise ValueError(f"metadata.csv lacks {[c for c in NEEDED if c not in df.columns]}")
    for c in ["beatmap_id", "beatmapset_id", "playcount", "passcount", "favourite_count", "difficultyrating", "approved", "mode", "diff_size"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    set_plays_all = df.groupby("beatmapset_id")["playcount"].sum(min_count=1)
    d = df[(df["mode"] == 3) & (df["diff_size"] == 4)].copy()
    d = d[d["beatmap_id"].notna() & d["beatmapset_id"].notna()]
    d["year"] = [(_year(a) or _year(b)) for a, b in zip(d.get("approved_date", [None] * len(d)), d.get("submit_date", [None] * len(d)))]
    d["stars"] = d["difficultyrating"].astype(float)
    d["setPlays"] = d["beatmapset_id"].map(set_plays_all)
    d["setDiffs"] = d.groupby("beatmapset_id")["beatmap_id"].transform("count")
    report = {"header": {"ok": header_ok, "columns": NEEDED}, "diffs4k": int(len(d)), "sets4k": int(d["beatmapset_id"].nunique()), "sanity": {}, "notes": []}

    # playsResid: within-set (fixed effect = demean by set), on star rank and top diff
    y = np.log1p(d["playcount"].astype(float).clip(lower=0))
    rank = d.groupby("beatmapset_id")["stars"].rank(method="first") - 1
    n = d["setDiffs"].astype(float)
    rank_rel = np.where(n > 1, rank / np.maximum(n - 1, 1), 0.0)
    top = (rank == n - 1).astype(float)
    multi = (n > 1) & y.notna() & d["stars"].notna()
    plays_resid = pd.Series(np.nan, index=d.index)

    def fit_plays(with_stars):
        sub = pd.DataFrame({"y": y[multi], "r": rank_rel[multi.values], "t": top[multi], "s": d.loc[multi, "beatmapset_id"]})
        cols = ["y", "r", "t"]
        if with_stars:
            # the star rating itself, as a spline (each basis column is demeaned within the set like the rest)
            basis = _spline(d.loc[multi, "stars"])
            for j in range(basis.shape[1]):
                sub[f"b{j}"] = basis[:, j]
                cols.append(f"b{j}")
        dm = sub[cols] - sub.groupby("s")[cols].transform("mean")
        plays_resid[multi] = _resid_ols(dm["y"].values, dm[cols[1:]].values)

    if multi.any():
        fit_plays(False)

    # passResid: pass ratio after a spline in stars
    pr = d["passcount"].astype(float) / d["playcount"].astype(float)
    okp = (d["playcount"] >= MIN_PASS_PLAYS) & pr.notna() & d["stars"].notna() & np.isfinite(pr)
    pass_resid = pd.Series(np.nan, index=d.index)
    if okp.sum() > 20:
        pass_resid[okp] = _resid_ols(pr[okp].values, _spline(d.loc[okp, "stars"]))

    # favResid: per set, log1p(setFavs) after log1p(setPlays) + year + approval status
    sets = d.groupby("beatmapset_id").agg(favs=("favourite_count", "first"), plays=("setPlays", "first"), year=("year", "first"),
                                          approved=("approved", "first"), top=("stars", "max"))
    sets = sets[sets["favs"].notna() & sets["plays"].notna()]

    def fav_design(s, with_stars):
        parts = [np.log1p(s["plays"].clip(lower=0).values).reshape(-1, 1),
                 pd.get_dummies(s["year"].fillna(0).astype(int), prefix="y").values.astype(float),
                 pd.get_dummies(s["approved"].fillna(0).astype(int), prefix="a").values.astype(float)]
        if with_stars:
            parts.append(_spline(s["top"].fillna(s["top"].median())))
        return np.hstack(parts)

    fav_set = pd.Series(np.nan, index=sets.index)
    if len(sets) > 20:
        fav_set[:] = _resid_ols(np.log1p(sets["favs"].clip(lower=0).values), fav_design(sets, False))
    fav_resid = d["beatmapset_id"].map(fav_set)
    stars = d["stars"].values.astype(float)

    def check(name, values):
        rho = _rho(np.asarray(values, dtype=float), stars)
        ok = rho is not None and abs(rho) < RHO_MAX
        report["sanity"][name] = {"spearmanStars": None if rho is None else round(rho, 4), "ok": ok,
                                  "n": int(np.isfinite(np.asarray(values, dtype=float)).sum())}
        return ok

    if not check("playsResid", plays_resid) and multi.any():
        report["notes"].append("playsResid: |rho| >= 0.1 with star rank + top diff alone; a within-set spline in the star rating was added")
        fit_plays(True)
        check("playsResid", plays_resid)
    if not check("passResid", pass_resid) and okp.sum() > 20:
        report["notes"].append("passResid: refit with a finer star spline")
        pass_resid[okp] = _resid_ols(pr[okp].values, _spline(d.loc[okp, "stars"], 16))
        check("passResid", pass_resid)
    if not check("favResid", fav_resid) and len(sets) > 20:
        report["notes"].append("favResid: |rho| >= 0.1 with the plan's covariates; a spline in the set's top star rating was added")
        fav_set[:] = _resid_ols(np.log1p(sets["favs"].clip(lower=0).values), fav_design(sets, True))
        fav_resid = d["beatmapset_id"].map(fav_set)
        check("favResid", fav_resid)

    num = lambda v: None if v is None or not np.isfinite(v) else (int(v) if float(v).is_integer() else round(float(v), 5))  # noqa: E731
    lines = []
    for i, (idx, r) in enumerate(d.iterrows()):
        lines.append({
            "beatmapId": int(r["beatmap_id"]), "setId": int(r["beatmapset_id"]),
            "plays": num(r["playcount"]), "passes": num(r["passcount"]), "favs": num(r["favourite_count"]),
            "setPlays": num(r["setPlays"]), "setFavs": num(r["favourite_count"]),
            "playsResid": num(plays_resid[idx]), "passResid": num(pass_resid[idx]), "favResid": num(fav_resid[idx]),
            "stars": num(r["stars"]), "setDiffs": int(r["setDiffs"]), "year": r["year"], "approved": num(r["approved"]),
        })
    known_sets = set(int(s) for s in d["beatmapset_id"].unique())
    tracker_only = 0
    for sid, plays in (tracker_set_plays or {}).items():
        if int(sid) not in known_sets and plays is not None:
            lines.append({"setId": int(sid), "setPlays": int(plays)})
            tracker_only += 1
    report["trackerOnlySets"] = tracker_only
    report["withPlaysResid"] = int(np.isfinite(plays_resid.values).sum())
    report["withPassResid"] = int(np.isfinite(pass_resid.values).sum())
    report["withFavResid"] = int(np.isfinite(np.asarray(fav_resid, dtype=float)).sum())
    return lines, report


def tracker_plays(manifest):
    try:
        m = json.loads(Path(manifest).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {s["setId"]: s.get("playCount") for s in m.get("sets", []) if s.get("setId") and s.get("playCount") is not None}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fun labels (popularity residuals) from metadata.csv")
    ap.add_argument("metadata", nargs="?", default="A:/SneezeyTrain/hf-meta/metadata.csv")
    ap.add_argument("--manifest", default="A:/SneezeyTrain/manifest.json")
    ap.add_argument("--out", default="A:/SneezeyTrain/corpus/fun-labels.jsonl")
    a = ap.parse_args(argv)
    head = pd.read_csv(a.metadata, nrows=0)
    missing = [c for c in NEEDED if c not in head.columns]
    if missing:
        sys.exit(f"{a.metadata}: header lacks {missing}")
    df = pd.read_csv(a.metadata, usecols=[c for c in USED if c in head.columns], dtype=str, keep_default_na=False)
    lines, report = fun_labels(df, tracker_plays(a.manifest))
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        for l in lines:
            f.write(json.dumps(l, ensure_ascii=True) + "\n")
    tmp.replace(out)
    report.update({"metadata": a.metadata, "out": str(out), "lines": len(lines)})
    rep = out.with_name(out.stem + "-report.json")
    rep.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
