"""Train the learned mapper on a dataset built by tools/build-mapper-dataset.mjs.

Models (all exported to plain JSON for the app):
  note    - P(row at this slot | audio features, map dan, section pattern family)   gradient boosted trees
  size    - P(row has 1..4 notes | same features)                                   gradient boosted trees
  pattern - P(next row's columns | previous two rows, row size, family)              counts from real maps

Datasets
  v1  data/mapper, mapper15: index.jsonl (train only), maps/<id>.f32 [S x F], maps/<id>.u8 [S x 3]; the test (15%) and
      early-stopping (10% of the rest) song groups are picked by crc32 of the group.
  v3  mapper3 (format.json): index.jsonl with split train / val / test, maps/<ab>/<id>.* (layout: the header of
      build-mapper-dataset.mjs); per-map training weights from the index; exports kind "xgb-v3", grid "snap-v2".

Memory: maps are streamed in batches of --batch-rows slots (xgb.DataIter -> QuantileDMatrix), never all at once. Host
memory is one batch (2M slots ~ 0.3 GB) + the quantised matrix with its labels and weights + the cached slot labels:
measured ~70 bytes per training slot on mapper15 (24 columns; 1.1 GB at 4M slots, 1.6 GB at 11.7M), so the full
80M-slot set needs ~6-7 GB and 110M slots ~9 GB; the GPU holds its own copy of the quantised matrix.

Robustness: index lines are split at "\\n" only (str.splitlines() breaks at U+2028 / U+0085 in chart names); a map with
non-finite features, or a BPM outside 20..1000, is skipped with a warning.

Usage: python -I tools/train_mapper.py [data=data/mapper] [model=models/mapper.json] [report=reports/mapper.md]
         [--device cuda|cpu] [--batch-rows 2000000] [--max-rounds 1500] [--limit-maps N] [--weights index|none]
         [--dan ours|tracker] [--mirror-tables] [--msd-prior] [--styles] [--rate-variants drop|keep]
  --mirror-tables  pattern counts += their column mirror (addendum §3.6); the validation pattern log-loss of both
                   tables is reported either way, so one run shows whether the ablation helps
  --msd-prior      msdPrior: median MSD vector per (dan bin x family) of the train maps (needs msdOurs: v3 only)
  --styles         styles / stylePattern / styleBias for creators with >= 30 train maps over >= 8 song groups (v3)
  --rate-variants  mapper3 holds one copy per chart (the corpus dedupes rates): "keep" is not available yet
"""
import argparse
import gc
import json
import sys
import zlib
from collections import defaultdict
from pathlib import Path

import numpy as np
import xgboost as xgb
from sklearn.metrics import roc_auc_score, average_precision_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataset3 import FAMILIES, MIRROR, MSD8, read_jsonl, warn  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONTEXT_RESET_SLOTS = 8  # v1: a gap of 2 beats (8 empty 1/4 slots) starts a new pattern phrase
CONTEXT_RESET_BEATS = 2  # v3: as in src/gen/generateLearned.js, a gap of more than 2 beats (in ms)
SEED = 7
BPM_MIN, BPM_MAX = 20, 1000
N_FAM = len(FAMILIES)
PATTERN_SHAPE = (N_FAM, 16, 16, 5, 16)  # family, prev, prev2, size, mask
STYLE_MIN_MAPS, STYLE_MIN_GROUPS = 30, 8


def popcount(m):
    return ((m >> 0) & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1)


# ---- data ------------------------------------------------------------------------------------------------------------

class Dataset:
    def __init__(self, data_dir, weights="index", dan="ours"):
        self.dir = Path(data_dir)
        self.v3 = (self.dir / "format.json").exists()
        rows, bad = read_jsonl(self.dir / "index.jsonl")
        if bad:
            warn(f"{bad} unreadable index lines skipped")
        self.rows = rows
        fn = self.dir / "feature_names.json"
        self.names = json.loads(fn.read_text(encoding="utf-8")) if fn.exists() else None
        self.use_weights = weights == "index" and self.v3
        self.dan_label = dan
        self.skipped = {}
        self.col = {n: i for i, n in enumerate(self.names or [])}
        # labels (3-4 bytes per slot) and v3 slot times (4) stay in RAM after the first pass: every later pass then
        # opens one file per map instead of three (a cold file open costs ~5 ms here; 80M slots -> ~0.6 GB)
        self.cache = {}

    def _labels(self, row, width):
        hit = self.cache.get(row["id"])
        if hit is None:
            lab = np.fromfile(f"{self.base(row)}.u8", dtype=np.uint8)
            t = np.fromfile(f"{self.base(row)}.t32", dtype=np.float32) if self.v3 else None
            hit = (lab, t)
            if lab.size == row["slots"] * width:
                self.cache[row["id"]] = hit
        return hit

    def split_of(self, row):
        if self.v3:
            return row.get("split", "train")
        g = str(row.get("group") or row.get("set") or row["id"])
        if zlib.crc32(g.encode("utf-8")) % 100 < 15:
            return "test"
        return "val" if zlib.crc32(f"{g}|val".encode("utf-8")) % 100 < 10 else "train"

    def base(self, row):
        return self.dir / "maps" / row["id"][:2] / row["id"] if self.v3 else self.dir / "maps" / row["id"]

    def dan(self, row):
        if not self.v3:
            return row["dan"]
        if self.dan_label == "tracker" and row.get("danTracker") is not None:
            return row["danTracker"]
        return row.get("danOurs")

    def load(self, row):
        """(X [S, F], note, mask, fam, t or None, beatMs or None) of one map, or None (skipped, with a warning once)."""
        key = row["id"]
        if key in self.skipped:
            return None
        why = None
        try:
            S, F = row["slots"], row["features"]
            width = 4 if self.v3 else 3
            X = np.fromfile(f"{self.base(row)}.f32", dtype=np.float32)
            lab, t32 = self._labels(row, width)
            if X.size != S * F or lab.size != S * width:
                why = f"file sizes do not match the index ({X.size} floats, {lab.size} labels for {S} slots)"
            else:
                X = X.reshape(S, F)
                lab = lab.reshape(S, width)
                bpm = row.get("bpm")
                dan = self.dan(row)
                if not np.isfinite(X).all():
                    why = "non-finite features"
                elif bpm is None or not (BPM_MIN <= float(bpm) <= BPM_MAX):
                    why = f"BPM {bpm} outside {BPM_MIN}..{BPM_MAX}"
                elif "bpm" in self.col and (X[:, self.col["bpm"]].max() > BPM_MAX or X[:, self.col["bpm"]].min() < BPM_MIN):
                    why = f"a slot BPM outside {BPM_MIN}..{BPM_MAX}"
                elif dan is None or not np.isfinite(dan):
                    why = "no dan label"
        except (OSError, ValueError) as e:
            why = f"unreadable: {e}"
        if why:
            self.skipped[key] = why
            warn(f"map {key} ({row.get('osuPath') or row.get('osu')}) skipped: {why}")
            return None
        t = beat_ms = None
        if self.v3:
            t = t32.astype(np.float64)
            if "slot_ms" in self.col:
                beat_ms = X[:, self.col["slot_ms"]].astype(np.float64) * lab[:, 3]
        return X, lab[:, 0], lab[:, 1], lab[:, 2], t, beat_ms

    def design(self, row, loaded):
        X, note, mask, fam = loaded[:4]
        onehot = np.zeros((len(note), N_FAM), dtype=np.float32)
        known = fam < N_FAM
        onehot[np.where(known)[0], fam[known]] = 1
        dan = np.full((len(note), 1), self.dan(row), dtype=np.float32)
        return np.hstack([X, dan, onehot])

    def weight(self, row):
        w = row.get("weight") if self.use_weights else None
        return float(w) if w is not None and np.isfinite(w) and w > 0 else 1.0


def mask_sizes(masks):
    m = np.asarray(masks, dtype=np.int64)
    return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1)


class MapIter(xgb.DataIter):
    """Batches of whole maps (about batch_rows slots each) for QuantileDMatrix; kind "note" = every slot, "size" = slots
    with a row (label = notes in the row - 1). Memory: one batch at a time."""

    def __init__(self, ds, rows, kind, batch_rows):
        self.ds, self.rows, self.kind, self.batch_rows = ds, rows, kind, batch_rows
        self.i = 0
        self.max_batch = 0
        super().__init__()

    def next(self, input_data):
        xs, ys, ws = [], [], []
        n = 0
        while self.i < len(self.rows) and n < self.batch_rows:
            row = self.rows[self.i]
            self.i += 1
            loaded = self.ds.load(row)
            if loaded is None:
                continue
            X = self.ds.design(row, loaded)
            note, mask = loaded[1], loaded[2]
            if self.kind == "size":
                pos = note == 1
                X, y = X[pos], (mask_sizes(mask[pos]) - 1).astype(np.float32)
            else:
                y = note.astype(np.float32)
            if not len(y):
                continue
            xs.append(X)
            ys.append(y)
            ws.append(np.full(len(y), self.ds.weight(row), dtype=np.float32))
            n += len(y)
        if not xs:
            return False
        self.max_batch = max(self.max_batch, n)
        input_data(data=np.vstack(xs), label=np.concatenate(ys), weight=np.concatenate(ws))
        return True

    def reset(self):
        self.i = 0


def batches(ds, rows, batch_rows):
    """[(row, loaded, design matrix)] lists of about batch_rows slots (maps that fail to load are skipped)."""
    out, n = [], 0
    for r in rows:
        loaded = ds.load(r)
        if loaded is None:
            continue
        X = ds.design(r, loaded)
        out.append((r, loaded, X))
        n += len(X)
        if n >= batch_rows:
            yield out
            out, n = [], 0
    if out:
        yield out


def predict(booster, X):
    # DMatrix input runs on the booster's device without the inplace_predict device-mismatch warning
    return booster.predict(xgb.DMatrix(X))


# ---- pattern tables ----------------------------------------------------------------------------------------------------

def pattern_codes(note, mask, fam, reset):
    """Codes into PATTERN_SHAPE (flattened) for each row of one map; reset[k] = row k starts a new phrase."""
    idx = np.flatnonzero(note)
    if not len(idx):
        return np.zeros(0, dtype=np.int64)
    m = mask[idx].astype(np.int64)
    f = fam[idx].astype(np.int64)
    r = np.asarray(reset, dtype=bool)
    prev = np.zeros_like(m)
    prev2 = np.zeros_like(m)
    prev[1:] = m[:-1]
    prev[r] = 0
    r1 = np.zeros_like(r)
    r1[1:] = r[:-1]
    prev2[2:] = m[:-2]
    prev2[r | r1] = 0
    ok = (f < N_FAM) & (m > 0)
    code = (((f * 16 + prev) * 16 + prev2) * 5 + mask_sizes(m)) * 16 + m
    return code[ok]


def row_resets_v1(note):
    """v1 rule: a row after more than CONTEXT_RESET_SLOTS empty slots (or the first row) starts a phrase."""
    idx = np.flatnonzero(note)
    gaps = np.diff(idx, prepend=-10 ** 9) - 1
    return gaps > CONTEXT_RESET_SLOTS


def row_resets_v3(note, t, beat_ms):
    """v3 rule (generateLearned.js): a row more than 2 beats (in ms) after the previous row starts a phrase."""
    idx = np.flatnonzero(note)
    gap = np.diff(t[idx], prepend=-np.inf)
    limit = CONTEXT_RESET_BEATS * (beat_ms[idx] if beat_ms is not None else np.full(len(idx), np.inf))
    return gap > limit


def mirror_counts(c):
    """c[f, prev, prev2, size, mask] -> the same counts with every mask column-mirrored."""
    return c[:, MIRROR][:, :, MIRROR][..., MIRROR]


def counts_to_tables(c):
    """dense counts -> counts[family]["prev,prev2,size"][mask] (the shape the app reads)."""
    out = {f: defaultdict(dict) for f in FAMILIES}
    for f, p, p2, s, m in zip(*np.nonzero(c)):
        out[FAMILIES[f]][f"{p},{p2},{s}"][int(m)] = int(c[f, p, p2, s, m])
    return {f: dict(v) for f, v in out.items()}


SIZE_MASKS = np.array([sum(1 for x in range(16) if popcount(x) == s) for s in range(5)], dtype=np.float64)


def pattern_log_loss(train_counts, val_codes, alpha=0.5):
    """Mean -log P(mask | family, prev, prev2, size) on validation rows, add-alpha smoothing over the masks of that size."""
    if not len(val_codes):
        return float("nan")
    c = train_counts.reshape(-1, 16).astype(np.float64)
    ctx, m = val_codes // 16, val_codes % 16
    size = (ctx % 5).astype(int)
    num = c[ctx, m] + alpha
    den = c[ctx].sum(1) + alpha * SIZE_MASKS[size]
    return float(np.mean(-np.log(num / den)))


# ---- export ------------------------------------------------------------------------------------------------------------

def export_xgb(booster, n_classes, X_probe):
    """XGBoost booster -> {baseline: [K], iterations: [[tree per class]]} in the same flat format as sklearn trees.
    XGBoost splits on `x < cond`; the JS evaluator uses `x <= threshold`, so thresholds move one float32 step down."""
    dumps = [json.loads(t) for t in booster.get_dump(dump_format="json")]
    flat = []
    for root in dumps:
        nodes = {}
        stack = [root]
        while stack:
            n = stack.pop()
            nodes[n["nodeid"]] = n
            stack.extend(n.get("children", []))
        order = sorted(nodes)
        index = {nid: i for i, nid in enumerate(order)}
        t = {k: [] for k in ("feature", "threshold", "missingLeft", "left", "right", "leaf", "value")}
        for nid in order:
            n = nodes[nid]
            if "leaf" in n:
                t["feature"].append(0); t["threshold"].append(0.0); t["missingLeft"].append(0)
                t["left"].append(0); t["right"].append(0); t["leaf"].append(1); t["value"].append(round(float(n["leaf"]), 7))
            else:
                cond = np.float32(n["split_condition"])
                t["feature"].append(int(str(n["split"]).lstrip("f")))
                t["threshold"].append(float(np.nextafter(cond, np.float32(-np.inf))))
                t["missingLeft"].append(1 if n["missing"] == n["yes"] else 0)
                t["left"].append(index[n["yes"]]); t["right"].append(index[n["no"]])
                t["leaf"].append(0); t["value"].append(0.0)
        flat.append(t)
    iterations = [flat[i:i + n_classes] for i in range(0, len(flat), n_classes)]
    spec = {"baseline": [0.0] * n_classes, "iterations": iterations, "classes": list(range(1, n_classes + 1)) if n_classes > 1 else [0, 1]}
    # Base margin is whatever the trees do not explain: measure it on a probe sample.
    margin = booster.predict(xgb.DMatrix(X_probe), output_margin=True).reshape(len(X_probe), -1)
    spec["baseline"] = np.median(margin - raw_predict(spec, X_probe), axis=0).astype(float).tolist()
    return spec


def raw_predict(spec, X):
    """Reference evaluator for the exported trees (the JS one must match)."""
    K = len(spec["baseline"])
    out = np.tile(np.array(spec["baseline"], dtype=float), (len(X), 1))
    for trees in spec["iterations"]:
        for k, t in enumerate(trees):
            feat, thr, ml, left, right, leaf, val = (np.array(t[x]) for x in
                                                    ("feature", "threshold", "missingLeft", "left", "right", "leaf", "value"))
            node = np.zeros(len(X), dtype=int)
            active = ~leaf[node].astype(bool)
            while active.any():
                idx = np.where(active)[0]
                v = X[idx, feat[node[idx]]]
                go_left = np.where(np.isnan(v), ml[node[idx]] == 1, v <= thr[node[idx]])
                node[idx] = np.where(go_left, left[node[idx]], right[node[idx]])
                active = ~leaf[node].astype(bool)
            out[:, k] += val[node]
    return out


# ---- optional heads ----------------------------------------------------------------------------------------------------

def dominant_family(fam):
    known = fam[fam < N_FAM]
    return int(np.bincount(known, minlength=N_FAM).argmax()) if len(known) else -1


def msd_prior(entries, bins=tuple(range(0, 21)), min_maps=5):
    """entries: [(dan, family index or -1, msd8 list)] -> { bins, families, msd, table[bin][family] = median MSD8 | null }.
    A cell with fewer than min_maps maps takes the median of its whole dan bin. Families: FAMILIES + "unknown".
    TODO(stream G, G1): parity with src/gen/msdPrior.js msdPriorOf(model, danMid, families) once G merges (E4 test)."""
    fams = FAMILIES + ["unknown"]
    cells = defaultdict(list)
    for dan, f, msd in entries:
        if msd is None or dan is None or not np.isfinite(dan):
            continue
        b = int(min(max(np.floor(dan), bins[0]), bins[-1]))
        v = np.array([np.nan if x is None else x for x in msd], dtype=np.float64)
        cells[(b, f if f >= 0 else N_FAM)].append(v)
        cells[(b, -1)].append(v)
    table = []
    for b in bins:
        row = []
        for fi in range(len(fams)):
            vs = cells.get((b, fi)) or []
            if len(vs) < min_maps:
                vs = cells.get((b, -1)) or []
            if len(vs) < min_maps:
                row.append(None)
                continue
            med = np.nanmedian(np.vstack(vs), axis=0)
            row.append([None if not np.isfinite(x) else round(float(x), 3) for x in med])
        table.append(row)
    return {"bins": list(bins), "families": fams, "msd": MSD8, "table": table}


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


# ---- main --------------------------------------------------------------------------------------------------------------

def parse_args(argv):
    ap = argparse.ArgumentParser(description="Train the learned mapper (see the module docstring).")
    ap.add_argument("data", nargs="?", default=str(ROOT / "data/mapper"))
    ap.add_argument("out", nargs="?", default=str(ROOT / "models/mapper.json"))
    ap.add_argument("report", nargs="?", default=str(ROOT / "reports/mapper.md"))
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--batch-rows", type=int, default=2_000_000)
    ap.add_argument("--max-rounds", type=int, default=1500)
    ap.add_argument("--limit-maps", type=int, default=0)
    ap.add_argument("--weights", choices=["index", "none"], default="index")
    ap.add_argument("--dan", choices=["ours", "tracker"], default="ours")
    ap.add_argument("--mirror-tables", action="store_true")
    ap.add_argument("--msd-prior", action="store_true")
    ap.add_argument("--styles", action="store_true")
    ap.add_argument("--rate-variants", choices=["drop", "keep"], default="drop")
    return ap.parse_args(argv)


def main(argv=None):
    a = parse_args(sys.argv[1:] if argv is None else argv)
    if a.rate_variants == "keep":
        # TODO(E3): build mapper3 with the corpus duplicates at other rates (weight 0.25, `rate` conditioning) first.
        sys.exit("--rate-variants keep: mapper3 holds one copy per chart (the corpus dedupes rate variants); not built yet")
    out_path, report_path = Path(a.out), Path(a.report)
    ds = Dataset(a.data, weights=a.weights, dan=a.dan)
    if (a.msd_prior or a.styles) and not ds.v3:
        sys.exit("--msd-prior and --styles need a mapper3 dataset (msdOurs, creatorKey)")
    rows = ds.rows[: a.limit_maps] if a.limit_maps else ds.rows
    split = {"train": [], "val": [], "test": []}
    for r in rows:
        s = ds.split_of(r)
        if s in split:
            split[s].append(r)
    print(f"maps: train {len(split['train'])}, val {len(split['val'])}, test {len(split['test'])} "
          f"({'v3' if ds.v3 else 'v1'} data, weights {'index' if ds.use_weights else 'none'})", flush=True)
    params = {"tree_method": "hist", "device": a.device, "max_depth": 9, "eta": 0.06, "subsample": 0.8,
              "colsample_bytree": 0.9, "min_child_weight": 50, "lambda": 2.0, "max_bin": 256, "seed": SEED}

    # note model
    it_train = MapIter(ds, split["train"], "note", a.batch_rows)
    dtrain = xgb.QuantileDMatrix(it_train, max_bin=256)
    dval = xgb.QuantileDMatrix(MapIter(ds, split["val"], "note", a.batch_rows), ref=dtrain, max_bin=256)
    train_slots = dtrain.num_row()
    print(f"note matrix: {train_slots:,} train slots, {dval.num_row():,} val slots, largest batch {it_train.max_batch:,} slots", flush=True)
    note_booster = xgb.train({**params, "objective": "binary:logistic", "eval_metric": "logloss"}, dtrain, num_boost_round=a.max_rounds,
                             evals=[(dval, "val")], early_stopping_rounds=40, verbose_eval=100)
    note_booster = note_booster[: note_booster.best_iteration + 1]
    del dtrain, dval
    gc.collect()

    # size model (slots with a row only)
    strain = xgb.QuantileDMatrix(MapIter(ds, split["train"], "size", a.batch_rows), max_bin=256)
    sval = xgb.QuantileDMatrix(MapIter(ds, split["val"], "size", a.batch_rows), ref=strain, max_bin=256)
    size_booster = xgb.train({**params, "objective": "multi:softprob", "num_class": 4, "eval_metric": "mlogloss"}, strain,
                             num_boost_round=min(800, a.max_rounds), evals=[(sval, "val")], early_stopping_rounds=30, verbose_eval=100)
    size_booster = size_booster[: size_booster.best_iteration + 1]
    del strain, sval
    gc.collect()

    # test metrics, in batches of whole maps. Everything kept past a batch is a copy (np.array): a view (a column of X, a
    # slice of pb, a row stride of X) would keep the whole map's design matrix or the batch's predictions alive, and the
    # loop would hold every test map in memory by the end.
    onset_col = ds.col.get("onset", 3)
    y_all, p_all, onset_all, corr = [], [], [], []
    size_true, size_prob = [], []
    probe_rows, size_probe_rows = [], []
    for batch in batches(ds, split["test"], a.batch_rows):
        Xb = np.vstack([X for _, _, X in batch])
        pb = predict(note_booster, Xb)
        at = 0
        for r, loaded, X in batch:
            note, mask = loaded[1], loaded[2]
            p = pb[at: at + len(X)]
            at += len(X)
            y_all.append(np.array(note)); p_all.append(np.array(p)); onset_all.append(np.array(X[:, onset_col]))
            pos = note == 1
            if pos.any():
                size_true.append(np.array(mask_sizes(mask[pos])))
                size_probe_rows.append(np.array(X[pos][:: max(1, int(pos.sum()) // 20)]))
            probe_rows.append(np.array(X[:: max(1, len(X) // 40)]))
            sec = len(note) // 32
            if len(note) >= 128 and sec > 1:
                real = note[: sec * 32].reshape(sec, 32).sum(1)
                pred = p[: sec * 32].reshape(sec, 32).sum(1)
                if real.std() > 0 and pred.std() > 0:
                    corr.append(np.corrcoef(real, pred)[0, 1])
        pos_all = np.concatenate([loaded[1] for _, loaded, _ in batch]) == 1
        if pos_all.any():
            size_prob.append(predict(size_booster, Xb[pos_all]).reshape(-1, 4))
        del Xb, pb, batch
    y_all, p_all, onset_all = np.concatenate(y_all), np.concatenate(p_all), np.concatenate(onset_all)
    auc, ap = roc_auc_score(y_all, p_all), average_precision_score(y_all, p_all)
    auc_onset, ap_onset = roc_auc_score(y_all, onset_all), average_precision_score(y_all, onset_all)
    print(f"note model: {note_booster.num_boosted_rounds()} trees, AUC {auc:.3f} (onset alone {auc_onset:.3f}), AP {ap:.3f} (onset alone {ap_onset:.3f})", flush=True)
    size_true, size_prob = np.concatenate(size_true), np.concatenate(size_prob)
    size_acc = float((size_prob.argmax(1) + 1 == size_true).mean())
    size_base = float(np.mean(size_true == np.bincount(size_true).argmax()))
    print(f"size model: accuracy {size_acc:.3f} (most common size {size_base:.3f})", flush=True)
    density_corr = float(np.median(corr)) if corr else float("nan")
    print(f"section density correlation (median over test maps): {density_corr:.3f}", flush=True)

    # pattern tables (train maps), validation log-loss with and without the mirror
    counts = np.zeros(int(np.prod(PATTERN_SHAPE)), dtype=np.int64)
    val_codes = []
    style_maps = defaultdict(list)
    msd_entries = []
    for part in ("train", "val"):
        for r in split[part]:
            loaded = ds.load(r)
            if loaded is None:
                continue
            note, mask, fam, t, beat_ms = loaded[1:]
            reset = row_resets_v3(note, t, beat_ms) if ds.v3 else row_resets_v1(note)
            codes = pattern_codes(note, mask, fam, reset)
            if part == "train":
                counts += np.bincount(codes, minlength=counts.size)
                if ds.v3:
                    msd_entries.append((r.get("danOurs"), dominant_family(fam), r.get("msdOurs")))
                    if r.get("creatorKey"):
                        style_maps[r["creatorKey"]].append(r)
            else:
                val_codes.append(codes)
    counts = counts.reshape(PATTERN_SHAPE)
    mirrored = counts + mirror_counts(counts)
    val_codes = np.concatenate(val_codes) if val_codes else np.zeros(0, dtype=np.int64)
    pll, pll_m = pattern_log_loss(counts, val_codes), pattern_log_loss(mirrored, val_codes)
    print(f"pattern tables: validation log-loss {pll:.4f}, mirrored {pll_m:.4f} ({'used' if a.mirror_tables else 'not used'})", flush=True)
    table_counts = mirrored if a.mirror_tables else counts

    probe = np.vstack(probe_rows)[:3000]
    size_probe = np.vstack(size_probe_rows)[:3000]
    note_spec = export_xgb(note_booster, 1, probe)
    size_spec = export_xgb(size_booster, 4, size_probe)
    raw = raw_predict(note_spec, probe)[:, 0]
    want = note_booster.predict(xgb.DMatrix(probe))
    if np.max(np.abs(1 / (1 + np.exp(-raw)) - want)) > 1e-3:
        sys.exit(f"note model export parity failed: {np.max(np.abs(1 / (1 + np.exp(-raw)) - want))}")
    raw_s = raw_predict(size_spec, size_probe)
    probs = np.exp(raw_s - raw_s.max(1, keepdims=True))
    probs /= probs.sum(1, keepdims=True)
    want_s = size_booster.predict(xgb.DMatrix(size_probe)).reshape(len(size_probe), 4)
    if np.max(np.abs(probs - want_s)) > 1e-3:
        sys.exit(f"size model export parity failed: {np.max(np.abs(probs - want_s))}")

    model = {
        "features": ds.names, "conditioning": ["dan"] + [f"fam_{f}" for f in FAMILIES], "families": FAMILIES,
        "note": note_spec, "size": size_spec, "pattern": counts_to_tables(table_counts),
        "metrics": {"maps": len(split["train"]), "slots": int(train_slots), "noteAuc": auc, "noteAucOnset": auc_onset, "noteAp": ap,
                    "noteApOnset": ap_onset, "sizeAccuracy": size_acc, "sizeBaseline": size_base, "densityCorr": density_corr,
                    "patternValLogLoss": pll, "patternValLogLossMirrored": pll_m, "skippedMaps": len(ds.skipped)},
        "parity": {"x": probe[:5].tolist(), "noteP": note_booster.predict(xgb.DMatrix(probe[:5])).tolist(),
                   "sizeP": size_booster.predict(xgb.DMatrix(probe[:5])).reshape(5, 4).tolist()},
    }
    if ds.v3:
        model["kind"] = "xgb-v3"
        model["grid"] = "snap-v2"
        model["training"] = {"mirrorTables": a.mirror_tables, "weights": a.weights, "dan": a.dan, "rateVariants": a.rate_variants}
    if a.msd_prior:
        model["msdPrior"] = msd_prior(msd_entries)
    if a.styles:
        # TODO(stream G, G4): xgbMarkovSource / learnedModel.js read stylePattern + styleBias; the parity test (E4) follows.
        styles, style_pattern, style_bias = [], {}, {}
        for key, maps in sorted(style_maps.items(), key=lambda kv: -len(kv[1])):
            if len(maps) < STYLE_MIN_MAPS or len({m.get("songGroup") for m in maps}) < STYLE_MIN_GROUPS:
                continue
            c = np.zeros(int(np.prod(PATTERN_SHAPE)), dtype=np.int64)
            notes = preds = slots = 0.0
            for r in maps:
                loaded = ds.load(r)
                if loaded is None:
                    continue
                note, mask, fam, t, beat_ms = loaded[1:]
                c += np.bincount(pattern_codes(note, mask, fam, row_resets_v3(note, t, beat_ms)), minlength=c.size)
                notes += float(note.sum())
                preds += float(predict(note_booster, ds.design(r, loaded)).sum())
                slots += len(note)
            c = c.reshape(PATTERN_SHAPE)
            styles.append({"key": key, "name": maps[0].get("creatorName") or key, "maps": len(maps)})
            style_pattern[key] = counts_to_tables(c + mirror_counts(c) if a.mirror_tables else c)
            # how much denser (log-odds) this creator maps than the note model expects at the same dan and audio
            style_bias[key] = round(logit(notes / slots) - logit(preds / slots), 4) if slots else 0.0
        model["styles"], model["stylePattern"], model["styleBias"] = styles, style_pattern, style_bias
        print(f"styles: {len(styles)} creators with >= {STYLE_MIN_MAPS} maps over >= {STYLE_MIN_GROUPS} song groups", flush=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join([
        "# Обученный генератор: как он угадывает карты мапперов", "",
        f"Обучено на {len(split['train'])} картах 4K рис ({train_slots:,} точек сетки). "
        f"Проверка — на {len(split['test'])} картах песен, которых модель не видела.", "",
        "| Что | Модель | Старый способ (сила удара) |", "|---|---|---|",
        f"| Где поставить ноту, AUC (1 = идеально, 0.5 = наугад) | {auc:.3f} | {auc_onset:.3f} |",
        f"| Где поставить ноту, точность-полнота (AP) | {ap:.3f} | {ap_onset:.3f} |",
        f"| Сколько нот в строке, точность | {size_acc:.1%} | {size_base:.1%} (всегда самый частый размер) |",
        f"| Плотность по частям песни совпадает с маппером (корреляция) | {density_corr:.2f} | — |",
        f"| Таблицы паттернов, log-loss на проверке (с зеркалом) | {pll:.4f} ({pll_m:.4f}) | — |",
        "", f"Пропущено карт с битыми данными: {len(ds.skipped)}.",
    ]), encoding="utf-8")
    print(f"saved {out_path} ({out_path.stat().st_size / 1e6:.1f} MB); skipped maps {len(ds.skipped)}", flush=True)
    return model


if __name__ == "__main__":
    main()
