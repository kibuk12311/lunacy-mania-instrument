"""Add one mapper style to a shipped nn-v2 model (the create tab's style picker, 0.9.5) without retraining it: the
style embedding gets one more row, at the end (every existing style keeps its id), and only that row is trained, on
that mapper's maps, with every other weight frozen and the training loss of tools/train_infill.py; the export keeps
every other weight of the shipped JSON byte for byte (same f16 bits, same scale, the same JSON text around them).

  # 1. the mapper's maps through the training pipeline: tools/build-mapper-dataset.mjs --format v3 --features v3, then
  #    tools/nn/infill_data.py pack (train split = the maps to learn from, val split = held-out songs to stop on)
  # 2. train the row (the shipped JSON gives the frozen weights; --ckpt the training checkpoint for the aux heads)
  python -I tools/nn/add_style.py train --model models/mapper-nn2-s.json --pack <pack> --key n:<name> --out <dir> \
      [--ckpt A:/SneezeyTrain/nn2/runs/S-plan/best.pt] [--steps 1500] [--lr 1e-2] [--init mean|nearest|<style key>]
      [--max-norm auto] [--ref-pack A:/SneezeyTrain/nn2/pack-v3 | --ref-stats <cache.json>]
  #    --max-norm auto (default) keeps the row no longer than the longest existing style row (uncapped, M and L grew
  #    rows 1.7-2.3x longer than any style the model was trained with, for ~0.005 CE); the nearest style by pattern
  #    stats (family shares, chord sizes, jack share of the train maps) is reported against the training pack
  # 3. the new model file: weights of --model + the trained row, styles + {key, name, maps}, one more parity probe
  python -I tools/nn/add_style.py export --model models/mapper-nn2-s.json --row <dir>/row.pt --pack <pack> --out <file.json>
      [--name <shown name>] [--maps <shown map count>]
  # what changed between two model files (every tensor compared by its f16 bits; exit 1 on any other change)
  python -I tools/nn/add_style.py diff <old.json> <new.json>

<dir>/row.pt: { key, name, maps, groups, row (float32 [d]), init, step, val, baselines }. <dir>/log.jsonl: one line per
validation. Validation is the trainer's (tools/train_infill.py evaluate: CE without smoothing on the free slots, row
AUC, row accuracy), per held-out song group and as their mean (the early-stop metric: songs, not diffs, count).
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nn import infill_data as D  # noqa: E402
from nn.infill_model import Cfg, InfillModel, FAMILIES  # noqa: E402
import train_infill as TI  # noqa: E402

STYLE = "style_emb.weight"


# ---- the shipped JSON <-> PyTorch ----
def decode(entry) -> np.ndarray:
    """A weight of the model JSON as the JS decodes it: half x scale, in float32."""
    h = np.frombuffer(base64.b64decode(entry["f16"]), dtype="<f2").astype(np.float32)
    return (h * np.float32(entry.get("scale", 1))).reshape(entry["shape"])


def quantize(values: np.ndarray, scale) -> bytes:
    """float32 values -> f16 bits of values / scale (export_infill.round_to_f16's rounding, with a given scale)."""
    q = (torch.from_numpy(np.ascontiguousarray(values, dtype=np.float32)) / torch.tensor(np.float32(scale))).half()
    return q.numpy().astype("<f2").tobytes()


def model_from_json(doc, ckpt=None) -> InfillModel:
    """The model of a shipped nn-v2 JSON, with exactly the weights the app decodes. The aux heads are not exported:
    they come from `ckpt` (the training checkpoint), which must round to the very same JSON weights; else they stay
    at their init (then only the CE term of the training loss means anything)."""
    cfg = Cfg(**{k: v for k, v in doc["arch"].items() if k in Cfg.__dataclass_fields__})
    model = InfillModel(cfg)
    sd = model.state_dict()
    for name, p in model.named_parameters():
        if name.startswith("aux_"):
            continue
        if name not in doc["weights"]:
            raise ValueError(f"model JSON lacks {name}")
        sd[name] = torch.from_numpy(decode(doc["weights"][name]).copy())
    sd["in_mean"] = torch.tensor(doc["norm"]["mean"], dtype=torch.float32)
    sd["in_inv"] = torch.tensor(doc["norm"]["inv"], dtype=torch.float32)
    if ckpt:
        ck = torch.load(ckpt, map_location="cpu", weights_only=False)
        for name in doc["weights"]:
            w = ck["model"][name].float()
            scale = np.float32(w.abs().max().item()) if w.numel() and w.abs().max().item() > 0 else np.float32(1)
            if quantize(w.numpy(), scale) != base64.b64decode(doc["weights"][name]["f16"]) or float(scale) != doc["weights"][name]["scale"]:
                raise ValueError(f"{ckpt} is not the checkpoint of this model JSON ({name} differs)")
        for name in sd:
            if name.startswith("aux_"):
                sd[name] = ck["model"][name].float()
    model.load_state_dict(sd)
    return model


class StyleRows(nn.Module):
    """style_emb with one more row: the old rows frozen (a buffer), the new one the only trainable tensor."""

    def __init__(self, old: torch.Tensor, row: torch.Tensor):
        super().__init__()
        self.register_buffer("old", old.detach().clone())
        self.new = nn.Parameter(row.detach().clone().reshape(1, -1))

    @property
    def weight(self):
        return torch.cat([self.old, self.new], 0)

    @property
    def num_embeddings(self):
        return self.old.shape[0] + 1

    def forward(self, idx):
        return F.embedding(idx, self.weight)


def add_row(model: InfillModel, row: torch.Tensor) -> int:
    """Append a style row (all of the model frozen but that row). -> the new style's embedding index."""
    old = model.style_emb.weight.detach()
    for p in model.parameters():
        p.requires_grad_(False)
    model.style_emb = StyleRows(old, row)
    model.cfg.n_styles = old.shape[0] + 1
    return old.shape[0]


def trainable(model):
    return [(n, p) for n, p in model.named_parameters() if p.requires_grad]


# ---- pattern stats of maps (for the nearest style and the report) ----
def map_stats(masks: np.ndarray, fam: np.ndarray, lanes_present: np.ndarray) -> np.ndarray:
    """Per map: family shares of the beats that have one (6), chord size shares of its rows (1..4 notes), the jack
    share (rows sharing a column with the row before), rows per beat. -> float64 [12]."""
    m = np.where(lanes_present, masks, 0).reshape(-1)
    rows = m[m > 0].astype(np.int64)
    out = np.zeros(12)
    f = fam[fam < len(FAMILIES)]
    if len(f):
        out[:6] = np.bincount(f, minlength=6)[:6] / len(f)
    if len(rows):
        size = ((rows & 1) + ((rows >> 1) & 1) + ((rows >> 2) & 1) + ((rows >> 3) & 1))
        out[6:10] = np.bincount(size, minlength=5)[1:5] / len(rows)
        out[10] = float(((rows[1:] & rows[:-1]) > 0).mean()) if len(rows) > 1 else 0.0
        out[11] = len(rows) / max(1, len(fam))
    return out


def pack_style_stats(pack: D.Pack, split="train"):
    """style key -> mean map_stats over its maps of `split` (the maps that carry a style key)."""
    mm = pack.mm
    acc = {}
    for m in pack.maps:
        key = m.get("style")
        if not key or m["split"] != split:
            continue
        sl = slice(m["offset"], m["offset"] + m["beats"])
        s = map_stats(np.asarray(mm["masks"][sl]), np.asarray(mm["fam"][sl]), np.asarray(mm["lanes"][sl, :, D.PRESENT]) > 0.5)
        acc.setdefault(key, []).append(s)
    return {k: np.mean(v, 0) for k, v in acc.items()}


def own_stats(pack: D.Pack, split="train") -> np.ndarray:
    """The pattern stats of the pack's `split` maps: the mean over song groups of each group's mean (rate copies of
    one chart count once)."""
    by = {}
    for m in pack.maps:
        if m["split"] != split:
            continue
        sl = slice(m["offset"], m["offset"] + m["beats"])
        by.setdefault(m["group"], []).append(map_stats(np.asarray(pack.mm["masks"][sl]), np.asarray(pack.mm["fam"][sl]), np.asarray(pack.mm["lanes"][sl, :, D.PRESENT]) > 0.5))
    return np.mean([np.mean(v, 0) for v in by.values()], 0)


def reference_stats(ref_pack="", cache=""):
    """style key -> pattern stats over the training pack's train maps, read from `cache` when it exists (else
    computed from `ref_pack` and written there)."""
    if cache and Path(cache).exists():
        return {k: np.asarray(v) for k, v in json.loads(Path(cache).read_text(encoding="utf-8")).items()}
    if not ref_pack:
        return {}
    stats = pack_style_stats(D.Pack(ref_pack))
    if cache:
        Path(cache).write_text(json.dumps({k: v.tolist() for k, v in stats.items()}), encoding="utf-8")
    return stats


STAT_WEIGHTS = np.array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.0])  # density is the dan's business, not the style's


def nearest_styles(stats_of: dict, target: np.ndarray, keys):
    """Existing style keys sorted by the weighted L1 distance of their pattern stats to `target`."""
    d = [(float(np.abs((stats_of[k] - target) * STAT_WEIGHTS).sum()), k) for k in keys if k in stats_of]
    return sorted(d)


# ---- windows and evaluation ----
def windows_of(pack: D.Pack, split: str, mode: str, T=D.WINDOW):
    """D.val_windows, grouped by song group: {group: [windows]} (the same windows and seeds as the trainer's)."""
    out = {}
    for mi in D.select_maps(pack, split):
        for start in range(0, pack.maps[mi]["beats"], T):
            if pack.maps[mi]["beats"] - start < 16:
                continue
            w = D.window(pack, mi, start, np.random.default_rng(zlib.crc32(f"{mi}:{start}:{mode}".encode())), train=False, mode=mode, T=T)
            out.setdefault(pack.maps[mi]["group"], []).append(w)
    return out


def with_style(ws, style):
    return [{**w, "style": np.int64(style)} for w in ws]


def evaluate_style(model, groups: dict, style: int, device, amp=True):
    """TI.evaluate per song group with every window's style set to `style`; 'songs' = the mean over groups, 'pooled'
    = all slots together."""
    per = {g: TI.evaluate(model, with_style(ws, style), device, amp=amp) for g, ws in sorted(groups.items())}
    allw = [w for ws in groups.values() for w in ws]
    pooled = TI.evaluate(model, with_style(allw, style), device, amp=amp)
    mean = {k: float(np.mean([m[k] for m in per.values() if m[k] is not None])) for k in ("ce", "auc", "rowAcc", "predRate", "trueRate")}
    return {"songs": mean, "pooled": pooled, "perSong": per}


def batches(pack, batch, seed, style, T=D.WINDOW, schedule="plan"):
    """The trainer's batches (masking schedule, mirroring, dan / msd / family / source dropout) on the pack's train maps,
    every window with the new style (its dropout to 0 would only give windows without a gradient for the row)."""
    for b in D.train_batches(pack, batch, seed, T=T, schedule=schedule):
        b["style"] = np.full(len(b["style"]), style, np.int64)
        yield b


# ---- train ----
def cmd_train(a):
    torch.manual_seed(a.seed)
    device = torch.device(a.device)
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = json.loads(Path(a.model).read_text(encoding="utf-8"))
    if any(s.get("key") == a.key for s in doc.get("styles", [])):
        raise SystemExit(f"{a.model} already has the style {a.key}")
    model = model_from_json(doc, a.ckpt or None)
    pack = D.Pack(a.pack)
    own = [m for m in pack.maps if m["split"] == "train"]
    if not own:
        raise SystemExit("no train maps in the pack")
    if not D.select_maps(pack, "val"):
        raise SystemExit("no val maps in the pack: hold out some songs of the mapper (split val) to stop on")
    keys = [s["key"] for s in doc["styles"]]
    W = model.style_emb.weight.detach()
    # init: the mean of the existing style rows, or the row of the nearest style by pattern stats, or a given key
    target = own_stats(pack)
    near = []
    ref = reference_stats(a.ref_pack, a.ref_stats)
    if ref:
        near = nearest_styles(ref, target, keys)
    if a.init == "mean":
        row = W[1:].mean(0)
    elif a.init == "nearest":
        if not near:
            raise SystemExit("--init nearest needs --ref-pack or --ref-stats")
        row = W[keys.index(near[0][1]) + 1]
    else:
        row = W[keys.index(a.init) + 1]
    norms = W[1:].norm(dim=1)
    cap = float(norms.max()) if a.max_norm == "auto" else float(a.max_norm)
    new_id = add_row(model, row)
    tr = trainable(model)
    assert [n for n, _ in tr] == ["style_emb.new"], tr
    model.to(device)
    opt = torch.optim.AdamW([model.style_emb.new], lr=a.lr, betas=(0.9, 0.98), weight_decay=0.0)
    assert len(opt.param_groups) == 1 and len(opt.param_groups[0]["params"]) == 1 and opt.param_groups[0]["params"][0] is model.style_emb.new
    n_frozen = sum(p.numel() for p in model.parameters() if not p.requires_grad)
    print(f"row norm cap {cap:.3f} (existing style rows {float(norms.min()):.3f}..{float(norms.max()):.3f})", flush=True)
    print(f"{doc['size']}: {sum(p.numel() for _, p in tr)} trainable values (style row {new_id}), {n_frozen} frozen; optimizer tensors "
          f"{sum(len(g['params']) for g in opt.param_groups)}; {len(own)} train maps / {len({m['group'] for m in own})} songs", flush=True)

    val = {mode: windows_of(pack, "val", mode) for mode in ("free", "parts")}
    trainw = windows_of(pack, "train", "free")
    amp = device.type == "cuda" and not a.no_amp

    # baselines on the held-out songs: no style (0), every existing style, the nearest by pattern stats, the init row
    base = {"unknown": evaluate_style(model, val["free"], 0, device, amp), "init": evaluate_style(model, val["free"], new_id, device, amp)}
    per_style = {}
    for k, key in enumerate(keys):
        per_style[key] = evaluate_style(model, val["free"], k + 1, device, amp)["songs"]
    best_existing = min(per_style, key=lambda s: per_style[s]["ce"])
    baselines = {"unknown": base["unknown"], "init": base["init"], "bestExisting": {"key": best_existing, **evaluate_style(model, val["free"], keys.index(best_existing) + 1, device, amp)},
                 "nearestByStats": [{"key": k, "dist": round(dd, 4), "songsCe": per_style[k]["ce"]} for dd, k in near[:5]],
                 "existingSongsCe": {k: round(v["ce"], 5) for k, v in per_style.items()}}
    if near:
        nk = near[0][1]
        baselines["nearest"] = {"key": nk, **evaluate_style(model, val["free"], keys.index(nk) + 1, device, amp)}
    print(f"baselines (held-out songs, free, mean CE over songs): unknown {base['unknown']['songs']['ce']:.4f}, init {base['init']['songs']['ce']:.4f}, "
          f"best existing {best_existing} {per_style[best_existing]['ce']:.4f}" + (f", nearest by stats {near[0][1]} {per_style[near[0][1]]['ce']:.4f}" if near else ""), flush=True)

    log = open(out / "log.jsonl", "w", encoding="utf-8")
    gen = torch.Generator(device=device).manual_seed(a.seed)
    best = {"ce": base["init"]["songs"]["ce"], "step": 0, "row": model.style_emb.new.detach().cpu().clone()}
    stale = 0
    t0 = time.time()
    step = 0
    for raw in batches(pack, a.batch, a.seed, new_id):
        if step >= a.steps:
            break
        b = TI.to_device(raw, device)
        for g in opt.param_groups:
            g["lr"] = TI.lr_at(step, a.steps, a.warmup, a.lr)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp):
            ctx = TI.scheduled_rows(model, b, a.sched_sample, gen)
            res = model(b, ctx_rows=ctx)
            loss, parts = TI.losses(model, res, b)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_([model.style_emb.new], 1.0)
        opt.step()
        if cap > 0:  # keep the row as long as the longest trained style row at most: no style the model never saw
            with torch.no_grad():
                n = model.style_emb.new.norm()
                if n > cap:
                    model.style_emb.new.mul_(cap / n)
        step += 1
        if step % a.val_every == 0 or step == a.steps:
            v = evaluate_style(model, val["free"], new_id, device, amp)
            rec = {"step": step, "time": round(time.time() - t0, 1), "train": parts, "val": v["songs"], "valPooled": v["pooled"]["ce"],
                   "rowNorm": float(model.style_emb.new.detach().norm())}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            if v["songs"]["ce"] < best["ce"] - 1e-5:
                best = {"ce": v["songs"]["ce"], "step": step, "row": model.style_emb.new.detach().cpu().clone()}
                stale = 0
            else:
                stale += a.val_every
            print(f"step {step} loss {float(loss.detach()):.4f} val songs CE {v['songs']['ce']:.4f} acc {v['songs']['rowAcc']:.4f} (best {best['ce']:.4f} @ {best['step']}) "
                  f"|row| {rec['rowNorm']:.3f}", flush=True)
            if a.patience and stale >= a.patience:
                print(f"early stop at {step}: no better held-out CE for {stale} steps", flush=True)
                break
    log.close()
    with torch.no_grad():
        model.style_emb.new.copy_(best["row"].to(device))
    final = {mode: evaluate_style(model, ws, new_id, device, amp) for mode, ws in val.items()}
    final_base = {mode: evaluate_style(model, ws, 0, device, amp) for mode, ws in val.items()}
    final_best = {mode: evaluate_style(model, ws, keys.index(best_existing) + 1, device, amp) for mode, ws in val.items()}
    train_fit = {"new": evaluate_style(model, trainw, new_id, device, amp)["songs"], "unknown": evaluate_style(model, trainw, 0, device, amp)["songs"],
                 "bestExisting": evaluate_style(model, trainw, keys.index(best_existing) + 1, device, amp)["songs"]}
    groups = sorted({m["group"] for m in own})
    res = {"key": a.key, "name": a.name, "maps": len(own), "groups": len(groups), "songGroups": groups, "size": doc["size"], "id": new_id,
           "row": best["row"].reshape(-1).float().numpy(), "init": a.init, "step": best["step"], "steps": step, "lr": a.lr, "maxNorm": cap,
           "existingNorms": [float(norms.min()), float(norms.mean()), float(norms.max())],
           "val": final, "valUnknown": final_base, "valBestExisting": final_best, "trainFit": train_fit, "baselines": baselines,
           "heldout": sorted({m["group"] for m in pack.maps if m["split"] == "val"}), "statsTarget": target.tolist()}
    torch.save(res, out / "row.pt")
    summary = {k: res[k] for k in ("key", "size", "id", "maps", "groups", "step", "steps", "init", "lr", "maxNorm", "existingNorms")}
    summary["rowNorm"] = float(best["row"].norm())
    summary["heldoutFree"] = {"new": final["free"]["songs"], "unknown": final_base["free"]["songs"], "bestExisting": {"key": best_existing, **final_best["free"]["songs"]}}
    summary["heldoutParts"] = {"new": final["parts"]["songs"], "unknown": final_base["parts"]["songs"], "bestExisting": final_best["parts"]["songs"]}
    if near:
        summary["nearest"] = {"key": near[0][1], **baselines["nearest"]["songs"]}
    summary["trainFit"] = train_fit
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(json.dumps(summary), flush=True)
    return res


# ---- export ----
def new_style_probe(doc, model, pack, new_id, seed=1, probe_beats=512):
    """One more parity probe (tools/export_infill.py's format): a held-out map of the new style, some rows visible
    (spans), with the new style's index, computed by the f16 weights of the new file."""
    import export_infill as E
    pool = D.select_maps(pack, "val") or D.select_maps(pack, "train")
    mi = sorted(pool, key=lambda i: -min(pack.maps[i]["beats"], probe_beats))[0]
    w = D.window(pack, mi, 0, np.random.default_rng(seed), train=False, mode="spans", T=probe_beats)
    w["style"] = np.int64(new_id)
    return E.make_probe(model, "style-added", w, np.random.default_rng(seed + 7))


def with_style_row(doc: dict, row: np.ndarray, entry: dict, extra=None) -> tuple[dict, np.ndarray]:
    """A copy of the model JSON with one more style: style_emb gets the row (its f16 bits at the shipped scale, so the
    old rows' bits and the scale stay), arch.n_styles + 1, the style appended to `styles`. -> (doc, the row as decoded)."""
    out = json.loads(json.dumps(doc))
    e = out["weights"][STYLE]
    n, d = e["shape"]
    if len(row) != d:
        raise ValueError(f"row has {len(row)} values, the embedding {d}")
    if out["arch"]["n_styles"] != n or len(out["styles"]) + 1 != n:
        raise ValueError("styles, n_styles and the embedding disagree")
    bits = quantize(row, e["scale"])
    decoded = np.frombuffer(bits, dtype="<f2").astype(np.float32) * np.float32(e["scale"])
    if not np.isfinite(decoded).all():
        raise ValueError("the row does not fit f16 at the shipped scale")
    e["f16"] = base64.b64encode(base64.b64decode(e["f16"]) + bits).decode("ascii")
    e["shape"] = [n + 1, d]
    out["arch"]["n_styles"] = n + 1
    out["styles"].append(entry)
    if extra:
        out.setdefault("addedStyles", []).append(extra)
    return out, decoded


def cmd_export(a):
    text = Path(a.model).read_text(encoding="utf-8")
    doc = json.loads(text)
    if json.dumps(doc, separators=(",", ":")) != text:
        raise SystemExit(f"{a.model} does not round-trip through json.dumps: its untouched parts would change")
    res = torch.load(a.row, map_location="cpu", weights_only=False)
    if res["size"] != doc["size"]:
        raise SystemExit(f"row of size {res['size']} for a {doc['size']} model")
    entry = {"key": res["key"], "name": a.name or res["name"], "maps": int(a.maps if a.maps is not None else res["maps"])}
    sm = lambda v: {k: (round(v[k], 5) if isinstance(v[k], float) else v[k]) for k in ("ce", "auc", "rowAcc")}  # noqa: E731
    extra = {"key": res["key"], "id": res["id"], "maps": entry["maps"], "trainDiffs": int(res["maps"]), "songs": res["groups"], "step": res["step"], "init": res["init"],
             "heldoutSongs": res["heldout"], "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
             "heldout": {"new": sm(res["val"]["free"]["songs"]), "unknown": sm(res["valUnknown"]["free"]["songs"]),
                         "bestExisting": {"key": res["baselines"]["bestExisting"]["key"], **sm(res["valBestExisting"]["free"]["songs"])}}}
    new, decoded = with_style_row(doc, np.asarray(res["row"], np.float32), entry, extra)
    model = model_from_json(new)
    model.eval()
    if not np.array_equal(model.style_emb.weight[-1].detach().numpy(), decoded):
        raise AssertionError("the model's new row is not the decoded one")
    pack = D.Pack(a.pack)
    new["parity"]["probes"].append(new_style_probe(new, model, pack, res["id"], seed=a.seed))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(new, separators=(",", ":")), encoding="utf-8")
    report = diff_models(doc, new)
    print(json.dumps({"out": a.out, "id": res["id"], "styles": len(new["styles"]), **report}))
    return report


# ---- diff ----
def diff_models(old: dict, new: dict) -> dict:
    """Every tensor of `old` against `new` by f16 bits and scale; the style embedding's old rows by bits; the rest of
    the JSON by value. -> { tensors, identical, styleRowsKept, added, changedKeys }; raises on anything else."""
    problems = []
    ident = 0
    for name, e in old["weights"].items():
        f = new["weights"].get(name)
        if f is None:
            problems.append(f"{name} missing")
            continue
        if name == STYLE:
            a, b = base64.b64decode(e["f16"]), base64.b64decode(f["f16"])
            n, d = e["shape"]
            if f["scale"] != e["scale"] or b[: len(a)] != a or f["shape"] != [n + 1, d] or len(b) != len(a) + 2 * d:
                problems.append(f"{name}: old rows or scale changed")
            continue
        if f != e:
            problems.append(f"{name} changed")
        else:
            ident += 1
    if set(new["weights"]) != set(old["weights"]):
        problems.append("weight names differ")
    changed = sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
    allowed = {"arch", "styles", "weights", "parity", "addedStyles"}
    if set(changed) - allowed:
        problems.append(f"other keys changed: {sorted(set(changed) - allowed)}")
    if {k: v for k, v in old["arch"].items() if k != "n_styles"} != {k: v for k, v in new["arch"].items() if k != "n_styles"} or new["arch"]["n_styles"] != old["arch"]["n_styles"] + 1:
        problems.append("arch changed beyond n_styles + 1")
    if new["styles"][: len(old["styles"])] != old["styles"] or len(new["styles"]) != len(old["styles"]) + 1:
        problems.append("old styles changed or not one appended")
    if new["parity"]["probes"][: len(old["parity"]["probes"])] != old["parity"]["probes"] or new["parity"].get("tolerance") != old["parity"].get("tolerance"):
        problems.append("old parity probes changed")
    if problems:
        raise AssertionError("; ".join(problems))
    return {"tensors": len(old["weights"]), "identical": ident, "styleRowsKept": old["weights"][STYLE]["shape"][0], "added": new["styles"][-1],
            "changedKeys": changed}


def cmd_diff(a):
    old = json.loads(Path(a.old).read_text(encoding="utf-8"))
    new = json.loads(Path(a.new).read_text(encoding="utf-8"))
    print(json.dumps(diff_models(old, new)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--model", required=True)
    t.add_argument("--pack", required=True)
    t.add_argument("--key", required=True)
    t.add_argument("--name", default="")
    t.add_argument("--out", required=True)
    t.add_argument("--ckpt", default="", help="the training checkpoint of --model: its aux heads complete the training loss")
    t.add_argument("--ref-pack", default="", help="the training pack: pattern stats of every style (nearest style, --init nearest)")
    t.add_argument("--ref-stats", default="", help="a cache file of those stats (read if it exists, else written)")
    t.add_argument("--init", default="mean", help="mean | nearest | <an existing style key>")
    t.add_argument("--steps", type=int, default=1500)
    t.add_argument("--batch", type=int, default=32)
    t.add_argument("--lr", type=float, default=1e-2)
    t.add_argument("--warmup", type=int, default=50)
    t.add_argument("--sched-sample", type=float, default=0.1)
    t.add_argument("--max-norm", default="auto", help="cap on the row's norm: auto = the longest existing style row, 0 = none, or a number")
    t.add_argument("--val-every", type=int, default=50)
    t.add_argument("--patience", type=int, default=400)
    t.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    t.add_argument("--seed", type=int, default=1)
    t.add_argument("--no-amp", action="store_true")
    e = sub.add_parser("export")
    e.add_argument("--model", required=True)
    e.add_argument("--row", required=True)
    e.add_argument("--pack", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--seed", type=int, default=1)
    e.add_argument("--name", default="", help="the name the picker shows (default: the one given to train)")
    e.add_argument("--maps", type=int, default=None, help="the map count the picker shows (default: the train diffs)")
    d = sub.add_parser("diff")
    d.add_argument("old")
    d.add_argument("new")
    a = ap.parse_args(argv)
    if a.cmd == "train" and not a.name:
        a.name = a.key.split(":", 1)[-1]
    return {"train": cmd_train, "export": cmd_export, "diff": cmd_diff}[a.cmd](a)


if __name__ == "__main__":
    main()
