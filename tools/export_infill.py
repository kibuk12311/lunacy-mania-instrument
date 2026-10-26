"""Export a trained nn-v2 checkpoint to the app's model JSON (kind "nn-v2", with a "size" field; ML addendum §4.4).

  .venv/Scripts/python.exe -I tools/export_infill.py A:/SneezeyTrain/nn2/runs/S/best.pt A:/SneezeyTrain/candidates/mapper-nn2-s.json \
      --pack A:/SneezeyTrain/nn2/pack-v3 [--base models/mapper.json] [--probe-beats 512]

Weights are stored as f16 + one float32 scale per tensor (base64, little endian). They are rounded to f16 BEFORE the
parity probes are computed, so the JS (src/gen/nn/infillModel.js) must match the probes within 2e-3: three probes
(a full window, a lock window, a style window), each with the logits of 40 slots. --base copies the XGB model's
pattern tables, divisor head and priors (remap and the grid choice use them).
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nn import infill_data as D  # noqa: E402
from nn.infill_model import (  # noqa: E402
    BEAT_FEATURES_V3, DIV_CLASSES, FAMILIES, IN_DIM, LANE_VALUES, N_LANES, N_LANE_VALUES, SOURCES,
)
from train_infill import load_checkpoint, to_device  # noqa: E402

CHECKS = 40
TOLERANCE = 2e-3
BASE_KEYS = ("pattern", "patternOrder", "divisor", "snapTransitions", "conditioning", "grid", "danCalibration", "msdPrior", "stylePattern", "styleBias")
STEM_LANES = {"kick", "snare", "hat", "harm", "perc_share"}
STRUCTURE_BEATS = {"phrase_pos", "is_phrase_start", "has_echo", "rep_sim", "novelty"}


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode("ascii")


def round_to_f16(model):
    """Every exported tensor -> f16(w / scale) * scale with scale = max |w| as float32; returns the JSON entries."""
    out = {}
    with torch.no_grad():
        for name, p in model.named_parameters():
            if name.startswith("aux_"):
                continue
            w = p.detach().float().cpu()
            scale = np.float32(w.abs().max().item()) if w.numel() and w.abs().max().item() > 0 else np.float32(1)
            q16 = (w / torch.tensor(scale)).half()
            p.copy_((q16.float() * torch.tensor(scale)).to(p.device))
            out[name] = {"shape": list(w.shape), "scale": float(scale), "f16": b64(q16.numpy().astype("<f2"))}
    return out


def probe_batch(w, nb):
    """A window from beat 0 of a map, without padding: what the JS sees for a whole song."""
    keep = {}
    for k, v in w.items():
        if k == "mode":
            continue
        a = np.asarray(v)
        keep[k] = a[:nb] if a.ndim >= 1 and a.shape[0] == len(w["valid"]) else a
    keep["valid"] = np.ones(nb, bool)
    return keep


def make_probe(model, name, w, rng):
    nb = int(w["valid"].sum())
    b = probe_batch(w, nb)
    batch = to_device(D.collate([b]), torch.device("cpu"))
    with torch.no_grad():
        logits = model(batch)["logits"][0].float().numpy()
    present = np.argwhere(b["present"])
    edge = [p for p in present if p[0] < 2 or p[0] >= nb - 2]
    rest = present[rng.choice(len(present), size=min(len(present), CHECKS), replace=False)]
    picks = []
    for p in list(edge[:6]) + list(rest):
        t = (int(p[0]), int(p[1]))
        if t not in picks:
            picks.append(t)
        if len(picks) == CHECKS:
            break
    picks.sort()
    visible = np.where(b["visible"], b["rows"], 255).astype(np.uint8)
    return {
        "name": name, "T": nb, "x": b64(b["x"].astype("<f4")), "visible": b64(visible), "rows": b64(b["rows"].astype(np.uint8)),
        "div": b64(b["div"].astype(np.uint8)), "fam": [int(v) for v in b["fam"]], "dan": [float(v) for v in b["dan"]],
        "danKnown": int(b["dan_known"]), "msd": [float(v) for v in b["msd"]] if b["msd_known"] else None, "style": int(b["style"]),
        "source": int(b["source"]), "rate": float(b["rate"]), "echo": [int(v) for v in b["echo"].reshape(-1)],
        "check": [list(p) for p in picks], "logits": [[float(v) for v in logits[t, l]] for t, l in picks],
    }


def probe_windows(pack, probe_beats, n_styles, seed):
    """The three probes: a full (all free) window, a lock window (whole parts visible) and a style window."""
    rng = np.random.default_rng(seed)
    pool = D.select_maps(pack, "val", D.osu_sources()) or D.select_maps(pack, "val") or list(range(len(pack.maps)))
    pool = sorted(pool, key=lambda i: -min(pack.maps[i]["beats"], probe_beats))
    echo_maps = [i for i in pool if (np.asarray(pack.mm["echo"][pack.maps[i]["offset"]: pack.maps[i]["offset"] + pack.maps[i]["beats"]]) >= 0).any()]
    out = []
    for name, mode, mi in (("full", "free", pool[0]), ("lock", "parts", pool[min(1, len(pool) - 1)]),
                           ("style", "spans", (echo_maps or pool)[0])):
        w = D.window(pack, mi, 0, np.random.default_rng(seed + len(out)), train=False, mode=mode, T=probe_beats)
        if name == "style" and n_styles > 1:
            w["style"] = np.int64(1 + int(rng.integers(n_styles - 1)))
        out.append((name, w))
    return out, rng


def used_lane_values(inv):
    lanes = np.asarray(inv[: N_LANES * N_LANE_VALUES]).reshape(N_LANES, N_LANE_VALUES)
    return [LANE_VALUES[k] for k in range(N_LANE_VALUES - 1) if (lanes[:, k] > 0).any()]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--pack", required=True, help="the pack the model was trained on (probe windows come from its val maps)")
    ap.add_argument("--base", default="", help="an XGB model JSON whose pattern tables, divisor head and priors are copied")
    ap.add_argument("--probe-beats", type=int, default=512)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args(argv)

    model, ck = load_checkpoint(args.checkpoint)
    model.eval()
    weights = round_to_f16(model)
    pack = D.Pack(args.pack)
    windows, rng = probe_windows(pack, args.probe_beats, model.cfg.n_styles, args.seed)
    probes = [make_probe(model, name, w, rng) for name, w in windows]
    inv = model.in_inv.cpu().numpy()
    lanes = used_lane_values(inv)
    beat_inv = inv[N_LANES * N_LANE_VALUES: N_LANES * N_LANE_VALUES + len(BEAT_FEATURES_V3)]
    needs = (["stems"] if STEM_LANES & set(lanes) else []) + (["structure"] if any(beat_inv[BEAT_FEATURES_V3.index(n)] > 0 for n in STRUCTURE_BEATS) else [])
    cfg = model.cfg.to_json()
    styles = ck.get("pack", {}).get("styles", [])
    doc = {
        "kind": "nn-v2", "size": cfg["size"], "version": 1,
        "arch": {**cfg, "families": FAMILIES, "sources": SOURCES, "laneValues": LANE_VALUES, "beatFeatures": BEAT_FEATURES_V3,
                 "divClasses": DIV_CLASSES, "inDim": IN_DIM},
        "norm": {"mean": [float(v) for v in model.in_mean.cpu().numpy()], "inv": [float(v) for v in inv]},
        "families": FAMILIES,
        "features": [n for n in lanes if n in D.AUDIO_FEATURES_V3],
        "needs": needs,
        "styles": styles,
        "weights": weights,
        "parity": {"tolerance": TOLERANCE, "probes": probes},
        "metrics": {"params": model.n_params(), "step": ck.get("step"), "val": ck.get("metrics"), "bestCe": ck.get("best")},
        "data": ck.get("pack", {}).get("data"),
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if args.base:
        base = json.loads(Path(args.base).read_text(encoding="utf-8"))
        for k in BASE_KEYS:
            if k in base:
                doc[k] = base[k]
        doc["base"] = {"kind": base.get("kind", "xgb-v1"), "file": Path(args.base).name}
    text = json.dumps(doc, separators=(",", ":"))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(text, encoding="utf-8")
    print(json.dumps({"out": args.out, "size": cfg["size"], "params": model.n_params(), "MB": round(len(text) / 2 ** 20, 2),
                      "probes": [(p["name"], p["T"]) for p in probes], "features": doc["features"], "needs": needs}))


if __name__ == "__main__":
    main()
