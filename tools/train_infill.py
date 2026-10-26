"""Train the nn-v2 infill transformer (ML addendum §4.4, §11) on a pack from tools/nn/infill_data.py.

  # a size of the sweep (S ~0.6M, M ~2.5M, L ~10M)
  .venv/Scripts/python.exe -I tools/train_infill.py --pack A:/SneezeyTrain/nn2/pack-v3 --out A:/SneezeyTrain/nn2/runs/S --size S
  # distillation: a student S on a teacher's slot distributions (KL at T = 2 on the 16 logits + the usual CE)
  .venv/Scripts/python.exe -I tools/train_infill.py --pack ... --out .../S-distill --size S --teacher .../L/best.pt
  # resume after a stop: the same command with --resume
  # N0: torch sees the RTX 5080 (sm_120) and bf16 matmuls work
  .venv/Scripts/python.exe -I tools/train_infill.py --check-gpu

Writes <out>/last.pt (every --ckpt-every steps and at the end), <out>/best.pt (best validation CE on osu!-only held-out
songs, all slots free) and <out>/log.jsonl. Export with tools/export_infill.py.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nn import infill_data as D  # noqa: E402
from nn.infill_model import Cfg, InfillModel, N_CLASSES, FAM_UNKNOWN  # noqa: E402

LABEL_SMOOTHING = 0.05
AUX_FAM = 0.1
AUX_NOTES = 0.1


class Windows(torch.utils.data.IterableDataset):
    def __init__(self, pack_dir, batch, seed, sources, window, schedule="plan"):
        super().__init__()
        self.pack_dir, self.batch, self.seed, self.sources, self.window, self.schedule = pack_dir, batch, seed, sources, window, schedule

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        pack = D.Pack(self.pack_dir)
        yield from D.train_batches(pack, self.batch, self.seed * 1000 + wid, self.sources, T=self.window, schedule=self.schedule)


class Prefetch:
    """Batches made by background threads (numpy releases the GIL; one thread keeps up with an L step). Processes
    would each import torch with its CUDA DLLs, which on Windows costs ~1-2 GB of commit memory per worker."""

    def __init__(self, pack_dir, batch, seed, sources, window, threads=1, depth=6, schedule="plan"):
        self.q = queue.Queue(depth)
        self.stop = False
        for k in range(threads):
            gen = D.train_batches(D.Pack(pack_dir), batch, seed * 1000 + k, sources, T=window, schedule=schedule)
            threading.Thread(target=self._run, args=(gen,), daemon=True).start()

    def _run(self, gen):
        while not self.stop:
            self.q.put(next(gen))

    def __iter__(self):
        while True:
            yield self.q.get()


def to_device(b, dev):
    out = {}
    for k, v in b.items():
        if k == "mode":
            continue
        t = v if torch.is_tensor(v) else torch.from_numpy(np.asarray(v))
        out[k] = t.to(dev, non_blocking=True)
    return out


def build_from(cfg_json, n_styles=None):
    cfg = Cfg(**{k: v for k, v in cfg_json.items() if k in Cfg.__dataclass_fields__})
    if n_styles is not None:
        cfg.n_styles = n_styles
    return InfillModel(cfg)


def load_checkpoint(path, device="cpu"):
    ck = torch.load(path, map_location=device, weights_only=False)
    model = build_from(ck["cfg"])
    model.load_state_dict(ck["model"])
    return model.to(device), ck


def param_groups(model, wd):
    decay, no_decay = [], []
    for n, p in model.named_parameters():
        (decay if p.dim() == 2 and "emb" not in n else no_decay).append(p)
    return [{"params": decay, "weight_decay": wd}, {"params": no_decay, "weight_decay": 0.0}]


def lr_at(step, total, warmup, base):
    if step < warmup:
        return base * (step + 1) / warmup
    p = (step - warmup) / max(1, total - warmup)
    return base * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(1.0, p))))


def scheduled_rows(model, b, share, gen):
    """10% scheduled sampling: the rows of a share of beats (free, unprotected slots) are replaced by the model's own
    samples from a teacher-forced pass, so the decoder learns to continue from its own rows."""
    if share <= 0:
        return b["rows"]
    with torch.no_grad():
        logits = model(b)["logits"].float()
        drawn = torch.distributions.Categorical(logits=logits).sample()
    beats = torch.rand(b["valid"].shape, device=logits.device, generator=gen) < share
    swap = beats[..., None] & b["present"] & ~b["protect"] & b["valid"][..., None]
    return torch.where(swap, drawn, b["rows"])


def losses(model, out, b, teacher_logits=None, distill_t=2.0, alpha=0.5):
    lm = b["loss"]
    logits = out["logits"].float()
    w = b["weight"].float()[:, None, None].expand_as(lm)[lm]
    target = b["rows"][lm].long()
    sel = logits[lm]
    ce = F.cross_entropy(sel, target, reduction="none", label_smoothing=LABEL_SMOOTHING)
    ce = (ce * w).sum() / w.sum().clamp(min=1e-6)
    total = ce
    parts = {"ce": float(ce.detach())}
    if teacher_logits is not None:
        t = distill_t
        tp = F.log_softmax(teacher_logits.float()[lm] / t, -1)
        sp = F.log_softmax(sel / t, -1)
        kl = (F.kl_div(sp, tp, log_target=True, reduction="none").sum(-1) * w).sum() / w.sum().clamp(min=1e-6) * t * t
        total = (1 - alpha) * ce + alpha * kl
        parts["kl"] = float(kl.detach())
    beat_mask = b["valid"] & lm.any(-1)
    fam_ok = beat_mask & (b["fam_true"] != FAM_UNKNOWN)
    if fam_ok.any():
        fam = F.cross_entropy(out["fam"].float()[fam_ok], b["fam_true"][fam_ok].long())
        total = total + AUX_FAM * fam
        parts["fam"] = float(fam.detach())
    if beat_mask.any():
        r = b["rows"].long()
        notes = ((r & 1) + ((r >> 1) & 1) + ((r >> 2) & 1) + ((r >> 3) & 1)).float().sum(-1)
        nl = F.smooth_l1_loss(out["notes"].float()[beat_mask], torch.log1p(notes[beat_mask]))
        total = total + AUX_NOTES * nl
        parts["notes"] = float(nl.detach())
    return total, parts


@torch.no_grad()
def evaluate(model, windows, device, batch=16, amp=True):
    """CE (no smoothing) on the free slots, note AUC (P(row) = 1 - p0), the row accuracy given a row, and the mean
    predicted vs true row rate."""
    from sklearn.metrics import roc_auc_score
    model.eval()
    ce_sum, n = 0.0, 0
    p_rows, is_row, correct, rows_n = [], [], 0, 0
    for k in range(0, len(windows), batch):
        b = to_device(D.collate(windows[k:k + batch]), device)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp and device.type == "cuda"):
            logits = model(b)["logits"].float()
        lm = b["loss"]
        sel = logits[lm]
        tgt = b["rows"][lm].long()
        ce_sum += float(F.cross_entropy(sel, tgt, reduction="sum"))
        n += int(tgt.numel())
        pr = 1 - torch.softmax(sel, -1)[:, 0]
        p_rows.append(pr.cpu().numpy())
        is_row.append((tgt > 0).cpu().numpy())
        has = tgt > 0
        if has.any():
            correct += int((sel[has][:, 1:].argmax(-1) + 1 == tgt[has]).sum())
            rows_n += int(has.sum())
    model.train()
    pr = np.concatenate(p_rows) if p_rows else np.zeros(0)
    yr = np.concatenate(is_row) if is_row else np.zeros(0)
    auc = float(roc_auc_score(yr, pr)) if len(np.unique(yr)) == 2 else None
    return {"ce": ce_sum / max(1, n), "auc": auc, "rowAcc": correct / max(1, rows_n), "predRate": float(pr.mean()) if len(pr) else None,
            "trueRate": float(yr.mean()) if len(yr) else None, "slots": n}


def save(path, model, opt, step, args, best, pack_meta, metrics):
    tmp = Path(str(path) + ".tmp")
    torch.save({"cfg": model.cfg.to_json(), "model": model.state_dict(), "opt": opt.state_dict() if opt else None, "step": step,
                "args": vars(args), "best": best, "pack": {k: pack_meta[k] for k in ("styles", "sources", "families", "data", "beats", "maps", "splits") if k in pack_meta},
                "metrics": metrics}, tmp)
    os.replace(tmp, path)


def check_gpu():
    """N0: torch sees the RTX 5080 as sm_120 and bf16 matmuls run (addendum §0). -> dict; exits when not."""
    info = {"torch": torch.__version__, "cuda": torch.version.cuda, "available": torch.cuda.is_available()}
    if not info["available"]:
        raise SystemExit(f"no CUDA device: {info}")
    info.update(device=torch.cuda.get_device_name(0), capability=list(torch.cuda.get_device_capability(0)),
                arch=torch.cuda.get_arch_list(), vramGB=round(torch.cuda.get_device_properties(0).total_memory / 2 ** 30, 1))
    g = torch.Generator(device="cuda").manual_seed(0)
    a = torch.randn(1024, 1024, device="cuda", generator=g)
    b = torch.randn(1024, 1024, device="cuda", generator=g)
    ref = a.double() @ b.double()
    got = (a.bfloat16() @ b.bfloat16()).double()
    info["bf16RelErr"] = float((got - ref).norm() / ref.norm())
    if info["capability"] != [12, 0] or "sm_120" not in info["arch"] or not info["bf16RelErr"] < 1e-2:
        raise SystemExit(f"GPU check failed: {json.dumps(info)}")
    return info


def main(argv=None):
    if (sys.argv[1:] if argv is None else argv) == ["--check-gpu"]:
        print(json.dumps(check_gpu()))
        return None
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pack", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", default="S", help="a preset of tools/nn/sizes.json: XS, S, M, L")
    ap.add_argument("--steps", type=int, default=60000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--window", type=int, default=D.WINDOW)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--warmup", type=int, default=2000)
    ap.add_argument("--wd", type=float, default=0.05)
    ap.add_argument("--sched-sample", type=float, default=0.1)
    ap.add_argument("--schedule", choices=sorted(D.SCHEDULES), default="plan", help="masking schedule (plan = §4.4; lock = more locked context)")
    ap.add_argument("--sources", default="", help="train on these sources only (comma list of osu, etterna, malody)")
    ap.add_argument("--val-every", type=int, default=1000)
    ap.add_argument("--val-limit", type=int, default=400, help="validation windows per mode")
    ap.add_argument("--ckpt-every", type=int, default=2000)
    ap.add_argument("--minutes", type=float, default=0, help="stop after this many minutes (0 = no limit)")
    ap.add_argument("--workers", type=int, default=0, help="DataLoader worker processes (0 = background threads, see --threads)")
    ap.add_argument("--threads", type=int, default=1, help="batch-making threads when --workers is 0")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--teacher", default="", help="checkpoint of a teacher: distillation mode")
    ap.add_argument("--distill-t", type=float, default=2.0)
    ap.add_argument("--distill-alpha", type=float, default=0.5)
    ap.add_argument("--no-amp", action="store_true")
    args = ap.parse_args(argv)

    torch.manual_seed(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pack = D.Pack(args.pack)
    names = {s: k for k, s in enumerate(pack.meta["sources"])}
    sources = {names[s.strip()] for s in args.sources.split(",") if s.strip()} or None
    cfg = Cfg.preset(args.size, n_styles=pack.n_styles())
    model = InfillModel(cfg)
    model.in_mean.copy_(torch.tensor(pack.meta["inMean"], dtype=torch.float32))
    model.in_inv.copy_(torch.tensor(pack.meta["inInv"], dtype=torch.float32))
    model.to(device)
    opt = torch.optim.AdamW(param_groups(model, args.wd), lr=args.lr, betas=(0.9, 0.98), fused=device.type == "cuda")
    step, best = 0, None
    if args.resume and (out / "last.pt").exists():
        ck = torch.load(out / "last.pt", map_location=device, weights_only=False)
        model.load_state_dict(ck["model"])
        if ck.get("opt"):
            opt.load_state_dict(ck["opt"])
        step, best = ck["step"], ck.get("best")
        print(f"resumed at step {step}", flush=True)
    teacher = None
    if args.teacher:
        teacher, tck = load_checkpoint(args.teacher, device)
        teacher.eval().requires_grad_(False)
        print(f"teacher {tck['cfg'].get('size')} with {teacher.n_params()} params", flush=True)
    amp = not args.no_amp and device.type == "cuda"
    print(f"nn-v2 {args.size}: {model.n_params()} exported params, {pack.meta['maps']} maps / {pack.meta['beats']} beats in the pack, "
          f"device {device}{' bf16' if amp else ''}", flush=True)

    osu = D.osu_sources()
    val = {mode: D.val_windows(pack, sources=osu, mode=mode, limit=args.val_limit, T=args.window) for mode in ("free", "parts")}
    if not val["free"]:
        print("no osu! validation maps: validating on every source", flush=True)
        val = {mode: D.val_windows(pack, mode=mode, limit=args.val_limit, T=args.window) for mode in ("free", "parts")}
    if args.workers > 0:
        loader = torch.utils.data.DataLoader(Windows(args.pack, args.batch, args.seed + step, sources, args.window, args.schedule), batch_size=None,
                                             num_workers=args.workers, pin_memory=device.type == "cuda", persistent_workers=True, prefetch_factor=4)
    else:
        loader = Prefetch(args.pack, args.batch, args.seed + step, sources, args.window, threads=max(1, args.threads), schedule=args.schedule)
    gen = torch.Generator(device=device).manual_seed(args.seed + step)
    log = open(out / "log.jsonl", "a", encoding="utf-8")
    t0 = time.time()
    last_print = t0
    seen = 0
    metrics = {}
    model.train()
    for raw in loader:
        if step >= args.steps or (args.minutes and time.time() - t0 > args.minutes * 60):
            break
        b = to_device(raw, device)
        for g in opt.param_groups:
            g["lr"] = lr_at(step, args.steps, args.warmup, args.lr)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp):
            ctx = scheduled_rows(model, b, args.sched_sample, gen)
            res = model(b, ctx_rows=ctx)
            tl = None
            if teacher is not None:
                with torch.no_grad():
                    tl = teacher(b, ctx_rows=ctx)["logits"]
            loss, parts = losses(model, res, b, tl, args.distill_t, args.distill_alpha)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        step += 1
        seen += int(b["valid"].sum())
        now = time.time()
        if now - last_print > 30 or step == 1:
            rate = step / max(1e-9, now - t0)
            mem = torch.cuda.max_memory_allocated() / 2 ** 30 if device.type == "cuda" else 0
            print(f"step {step} loss {float(loss.detach()):.4f} {json.dumps(parts)} lr {opt.param_groups[0]['lr']:.2e} "
                  f"{rate:.2f} it/s {seen / (now - t0):.0f} beats/s mem {mem:.2f} GB", flush=True)
            last_print = now
        if step % args.val_every == 0 or step == args.steps:
            metrics = {mode: evaluate(model, w, device, amp=amp) for mode, w in val.items() if w}
            rec = {"step": step, "time": round(now - t0, 1), "train": parts, "val": metrics}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(f"val {json.dumps(metrics)}", flush=True)
            if metrics and (best is None or metrics["free"]["ce"] < best):
                best = metrics["free"]["ce"]
                save(out / "best.pt", model, None, step, args, best, pack.meta, metrics)
        if step % args.ckpt_every == 0:
            save(out / "last.pt", model, opt, step, args, best, pack.meta, metrics)
    metrics = {mode: evaluate(model, w, device, amp=amp) for mode, w in val.items() if w}
    if metrics and (best is None or metrics["free"]["ce"] < best):
        best = metrics["free"]["ce"]
        save(out / "best.pt", model, None, step, args, best, pack.meta, metrics)
    save(out / "last.pt", model, opt, step, args, best, pack.meta, metrics)
    elapsed = time.time() - t0
    summary = {"step": step, "minutes": round(elapsed / 60, 2), "itPerSec": round(step / max(1e-9, elapsed), 2),
               "beatsPerSec": round(seen / max(1e-9, elapsed)), "val": metrics, "best": best, "params": model.n_params()}
    log.write(json.dumps({"final": summary}) + "\n")
    log.close()
    print(f"done {json.dumps(summary)}", flush=True)
    return summary


if __name__ == "__main__":
    main()
