"""Tests for the nn-v2 data pipeline and model (pytest style; pytest is not in the venv, so this file also runs on
its own):  .venv/Scripts/python.exe -I tools/nn/test_infill.py"""
from __future__ import annotations

import atexit
import gc
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nn import infill_data as D  # noqa: E402
from nn import infill_model as M  # noqa: E402

torch.set_num_threads(2)  # steadier on a busy machine than one thread per core
_PACK = None
_TEMP = []


def temp_dir(prefix):
    d = Path(tempfile.mkdtemp(prefix=prefix))
    _TEMP.append(d)
    return d


@atexit.register
def _cleanup():
    global _PACK
    _PACK = None  # close the memmaps first: Windows keeps mapped files
    gc.collect()
    for d in _TEMP:
        shutil.rmtree(d, ignore_errors=True)


def loud(model, std=0.3, seed=0):
    """Random weights big enough that every path visibly moves the logits (a fresh init is ~0.02)."""
    g = torch.Generator().manual_seed(seed)
    with torch.no_grad():
        for p in model.parameters():
            p.copy_(torch.randn(p.shape, generator=g) * std)
    return model.eval()


def synth_pack():
    global _PACK
    if _PACK is None:
        out = temp_dir("nn2-test-")
        rng = np.random.default_rng(7)
        w = D.PackWriter(out)
        for k in range(40):
            w.add(D.synthetic_record(rng, k, nb=[700, 1100, 300, 90][k % 4]))
        w.close({"data": "test"})
        _PACK = D.Pack(out)
    return _PACK


def to_torch(b):
    out = {}
    for k, v in b.items():
        if k == "mode":
            continue
        t = torch.from_numpy(np.asarray(v))
        out[k] = t
    return out


def test_mirroring_is_an_involution():
    m = np.arange(16)
    assert (D.mirror_masks(D.mirror_masks(m)) == m).all()
    assert list(D.mirror_masks(np.array([1, 2, 4, 8, 3, 12, 5, 6, 15, 0]))) == [8, 4, 2, 1, 12, 3, 10, 6, 15, 0]
    t = torch.arange(16)
    assert torch.equal(M.mirror_masks(M.mirror_masks(t)), t)
    assert (M.mirror_masks(t).numpy() == D.mirror_masks(m)).all()
    # popcount (row size) and the hand balance flip
    pop = lambda v: bin(int(v)).count("1")
    assert all(pop(D.mirror_masks(np.array([v]))[0]) == pop(v) for v in range(16))


def test_training_windows_are_true_rows_or_their_mirror_both_occur():
    pack = synth_pack()
    rng = np.random.default_rng(3)
    seen = set()
    for _ in range(80):
        mi = int(rng.integers(len(pack.maps)))
        m = pack.maps[mi]
        start = int(rng.integers(0, max(1, m["beats"] - 512 + 1)))
        w = D.window(pack, mi, start, rng, train=True)
        nb = min(512, m["beats"] - start)
        truth = np.asarray(pack.mm["masks"][m["offset"] + start: m["offset"] + start + nb], dtype=np.int64)
        truth = np.where(w["present"][:nb], truth, 0)
        if (w["rows"][:nb] == truth).all() and (D.mirror_masks(truth) != truth).any():
            seen.add("plain")
        elif (w["rows"][:nb] == D.mirror_masks(truth)).all():
            seen.add("mirror")
            if start > 0:  # the context before the window is mirrored with it
                prev = np.asarray(pack.mm["masks"][m["offset"] + start - 1], dtype=np.int64)
                assert (w["prev_rows"] == D.mirror_masks(np.where(w["prev_present"], prev, 0))).all()
        else:
            assert (w["rows"][:nb] == truth).all(), "rows are neither the truth nor its mirror"
    assert seen == {"plain", "mirror"}


def test_masks_never_hide_visible_slots_in_the_loss():
    pack = synth_pack()
    rng = np.random.default_rng(5)
    modes = set()
    for _ in range(200):
        mi = int(rng.integers(len(pack.maps)))
        start = int(rng.integers(0, max(1, pack.maps[mi]["beats"] - 100)))
        w = D.window(pack, mi, start, rng, train=True)
        modes.add(w["mode"])
        assert not (w["loss"] & w["visible"]).any(), "a visible slot is in the loss"
        assert not (w["loss"] & ~w["present"]).any(), "a padded lane is in the loss"
        assert not (w["loss"] & ~w["valid"][:, None]).any(), "a padded beat is in the loss"
        assert not (w["visible"] & ~w["present"]).any()
        assert (w["protect"] >= w["visible"]).all()
        assert not (w["loss"] & w["protect"]).any(), "echo-forced slots must stay out of the loss"
        if w["mode"] == "free":
            assert not w["visible"].any()
    assert modes == {"free", "spans", "parts", "prefix"}


def test_the_schedule_shares_are_close_to_the_plan():
    rng = np.random.default_rng(11)
    present = np.ones((512, 8), bool)
    counts = {}
    for _ in range(4000):
        mode, vis = D.visible_mask(rng, 512, present, [0, 128, 300])
        counts[mode] = counts.get(mode, 0) + 1
        if mode == "prefix":
            k = vis[:, 0].sum()
            assert vis[:k].all() and not vis[k:].any()
    for mode, p in D.SCHEDULE:
        assert abs(counts[mode] / 4000 - p) < 0.03, (mode, counts[mode])


def test_window_edges():
    pack = synth_pack()
    mi = next(i for i, m in enumerate(pack.maps) if m["beats"] == 1100)
    m = pack.maps[mi]
    off = m["offset"]
    for start in (0, 1, 512, 1100 - 512, 1100 - 37):
        w = D.window(pack, mi, start, np.random.default_rng(0), train=False, mode="free")
        nb = min(512, 1100 - start)
        assert w["valid"].sum() == nb and w["valid"][:nb].all()
        assert not w["present"][nb:].any() and not w["rows"][nb:].any() and (w["x"][nb:, :96] == 0).all()
        truth = np.asarray(pack.mm["masks"][off + start: off + start + nb], dtype=np.int64)
        assert (w["rows"][:nb] == np.where(w["present"][:nb], truth, 0)).all()
        assert ((w["echo"] == -1) | ((w["echo"] >= 0) & (w["echo"] < nb))).all()
        assert w["has_prev"] == (start > 0)
        # the lane history before the window: the last 4 rows, oldest first, positions relative to the window
        naive = []
        for b in range(start):
            dv = D.DIV_CLASSES[int(pack.mm["div"][off + b])]
            for lane in range(dv):
                mk = int(pack.mm["masks"][off + b, lane])
                if mk:
                    naive.append((mk, (b - start) + lane / dv))
        naive = naive[-4:]
        k0 = 4 - len(naive)
        assert list(w["pre_mask"][k0:]) == [mk for mk, _ in naive]
        assert np.allclose(w["pre_pos"][k0:], [p for _, p in naive])
        assert not w["pre_mask"][:k0].any()
        # lane positions in beats
        dv = D.DIV_VALUE[w["div"][:nb]]
        assert np.allclose(w["pos"][:nb, 1], np.arange(nb) + 1 / dv)
    # validation windows cover every beat of every held-out map exactly once (windows under 16 beats skipped)
    vals = D.val_windows(pack, mode="free")
    total = sum(int(v["valid"].sum()) for v in vals)
    expect = 0
    for i in D.select_maps(pack, "val"):
        nbm = pack.maps[i]["beats"]
        expect += sum(min(512, nbm - s) for s in range(0, nbm, 512) if nbm - s >= 16)
    assert total == expect


def test_echo_pairs_point_back_and_forward():
    back = np.array([-1, -1, 0, 1, -1, 2])
    e = D.echo_pairs(back)
    assert list(e[:, 0]) == [-1, -1, 0, 1, -1, 2]
    assert list(e[:, 1]) == [2, 3, 5, -1, -1, -1]
    assert (D.echo_pairs(np.array([3, -1, -1, -1]))[:, 0] == -1).all(), "an echo never points forward"


def naive_history(rows, present, pos, pre_mask, pre_pos):
    B, T, L = rows.shape
    out = np.zeros((B, T, L, 68), np.float32)
    for b in range(B):
        seq = [(int(pre_mask[b, k]), float(pre_pos[b, k])) for k in range(4) if pre_mask[b, k] > 0]
        for t in range(T):
            for lane in range(L):
                recent = seq[-4:][::-1]
                for k in range(4):
                    if k < len(recent):
                        mk, p = recent[k]
                        out[b, t, lane, 17 * k + mk] = 1
                        out[b, t, lane, 17 * k + 16] = min(pos[b, t, lane] - p, 4) / 4
                    else:
                        out[b, t, lane, 17 * k + 16] = 1
                if present[b, t, lane] and rows[b, t, lane] > 0:
                    seq.append((int(rows[b, t, lane]), float(pos[b, t, lane])))
    return out


def test_history_features_match_a_naive_loop():
    rng = np.random.default_rng(2)
    B, T = 3, 30
    div = rng.integers(0, 4, (B, T))
    dv = D.DIV_VALUE[div]
    present = np.arange(8)[None, None] < dv[..., None]
    rows = np.where(present & (rng.random((B, T, 8)) < 0.3), rng.integers(1, 16, (B, T, 8)), 0)
    pos = (np.arange(T)[None, :, None] + np.arange(8)[None, None] / dv[..., None]).astype(np.float32)
    pre_mask = np.array([[0, 0, 3, 5], [1, 2, 4, 8], [0, 0, 0, 0]])
    pre_pos = np.array([[0, 0, -2.5, -0.25], [-9, -3, -1, -0.5], [0, 0, 0, 0]], np.float32)
    got = M.history_features(torch.from_numpy(rows), torch.from_numpy(present), torch.from_numpy(pos),
                             torch.from_numpy(pre_mask), torch.from_numpy(pre_pos)).numpy()
    ref = naive_history(rows, present, pos, pre_mask, pre_pos)
    assert np.allclose(got[present], ref[present], atol=1e-6)


def small_batch(pack, n=2, mode="spans", seed=0):
    rng = np.random.default_rng(seed)
    items = []
    for k in range(n):
        mi = D.select_maps(pack, "train")[k]
        items.append(D.window(pack, mi, 0, rng, train=False, mode=mode, T=96))
    return to_torch(D.collate(items))


def test_the_decoder_is_causal_in_time():
    torch.manual_seed(0)
    pack = synth_pack()
    model = loud(M.build_model("XS", n_styles=pack.n_styles()))
    b = small_batch(pack)
    with torch.no_grad():
        base = model(b)["logits"]
        for (bt, t, lane) in [(0, 10, 0), (1, 40, 2), (0, 70, 1)]:
            if not b["present"][bt, t, lane]:
                continue
            ctx = b["rows"].clone()
            ctx[bt, t, lane] = (int(ctx[bt, t, lane]) % 15) + 1
            got = model(b, ctx_rows=ctx)["logits"]
            diff = (got - base).abs().amax(-1)[bt]  # (T,8)
            before = torch.zeros_like(diff, dtype=torch.bool)
            before[:t] = True
            before[t, : lane + 1] = True
            assert diff[before].max() < 1e-6, f"slot ({t},{lane}) leaks into the past"
            assert diff[~before].max() > 1e-6, "a row changes nothing after it"
            assert (got[1 - bt] - base[1 - bt]).abs().max() < 1e-6, "windows of a batch must not mix"


def test_visible_rows_reach_the_past_through_the_encoder():
    torch.manual_seed(1)
    pack = synth_pack()
    model = loud(M.build_model("XS", n_styles=pack.n_styles()), seed=1)
    b = small_batch(pack, mode="free")
    with torch.no_grad():
        base = model(b)["logits"]
        b2 = dict(b)
        vis = b["visible"].clone()
        vis[0, 60:70] = b["present"][0, 60:70]
        b2["visible"] = vis
        got = model(b2)["logits"]
    assert (got[0, :50] - base[0, :50]).abs().max() > 1e-6, "the encoder is bidirectional: a later lock changes earlier logits"


def test_echo_cells_only_outside_the_local_window():
    model = M.build_model("XS")
    T = 100
    valid = torch.ones(1, T, dtype=torch.bool)
    echo = torch.full((1, T, 2), -1)
    echo[0, 80, 0] = 20  # far: an echo key
    echo[0, 30, 0] = 10  # 20 beats: already a window key, so no echo cell
    echo[0, 90, 1] = 99  # forward, near
    _, cells = model.encoder_bias(valid, echo)
    assert cells[0, 0, 80, 20] and not cells[0, 0, 30, 10] and not cells[0, 0, 90, 99]
    assert int(cells.sum()) == 1


def test_a_short_training_run_learns_the_synthetic_rules():
    torch.manual_seed(0)
    pack = synth_pack()
    model = M.build_model("XS", n_styles=pack.n_styles())
    model.in_mean.copy_(torch.tensor(pack.meta["inMean"]))
    model.in_inv.copy_(torch.tensor(pack.meta["inInv"]))
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    stream = D.train_batches(pack, 8, seed=1, T=96)
    losses = []
    for _ in range(40):
        b = to_torch(next(stream))
        out = model(b)
        lm = b["loss"]
        loss = torch.nn.functional.cross_entropy(out["logits"][lm], b["rows"][lm])
        opt.zero_grad()
        loss.backward()
        opt.step()
        losses.append(float(loss.detach()))
    assert np.mean(losses[-10:]) < np.mean(losses[:5]) - 0.3, (losses[:5], losses[-10:])


def write_v3_map(root, mid, rec, bpm=150.0, bars=None, flat=False):
    """A map in the dataset v3 layout from a record, as stream E's builder writes it (tools/build-mapper-dataset.mjs):
    maps/<id[0:2]>/<id>.* (flat maps/<id>.* with flat=True), .bs32 CSR beat offsets, .st.json with meter, bars
    [{ startMs, endMs, beat }], echoOf per bar and parts [{ startMs, beat }]. `bars`: the first beat of each bar
    (default every 4 beats)."""
    names = D.AUDIO_FEATURES_V3
    col = {n: k for k, n in enumerate(names)}
    f32, u8, t32 = [], [], []
    beat_ms = 60000 / bpm
    for b, dcls in enumerate(rec["div"]):
        dv = D.DIV_CLASSES[int(dcls)]
        for lane in range(dv):
            row = np.zeros(len(names), np.float32)
            for k, n in enumerate(D.LANE_VALUES[:-1]):
                if n in col:
                    row[col[n]] = rec["lanes"][b, lane, k]
            row[col["div"]] = dv
            row[col["phase"]] = lane / dv
            f32.append(row)
            m = int(rec["masks"][b, lane])
            u8.append([1 if m else 0, m, int(rec["fam"][b]) if rec["fam"][b] < 6 else 255, dv])
            t32.append(b * beat_ms + lane * beat_ms / dv)
    base = root / "maps" / mid if flat else root / "maps" / mid[:2] / mid
    base.parent.mkdir(parents=True, exist_ok=True)
    np.asarray(f32, np.float32).tofile(f"{base}.f32")
    np.asarray(u8, np.uint8).tofile(f"{base}.u8")
    np.asarray(t32, np.float32).tofile(f"{base}.t32")
    nb = len(rec["div"])
    bs = np.concatenate([[0], np.cumsum([D.DIV_CLASSES[int(d)] for d in rec["div"]])]).astype(np.int32)
    bs.tofile(f"{base}.bs32")
    beat = rec["beat"].copy()
    beat[:, D.BEAT_FEATURES_V3.index("bpm")] = bpm
    beat[:, D.BEAT_FEATURES_V3.index("meter")] = 4
    beat.astype(np.float32).tofile(f"{base}.b32")
    starts = bars if bars is not None else list(range(0, nb, 4))
    bar_list = [{"startMs": s * beat_ms, "endMs": (starts[k + 1] if k + 1 < len(starts) else nb) * beat_ms, "beat": s} for k, s in enumerate(starts)]
    echo_of = [-1] * len(starts)
    echo_of[5] = 1  # bar 5 (beats 20..23 on the 4-beat grid) repeats bar 1 (beats 4..7)
    parts = [{"startMs": 0, "beat": 0}, {"startMs": 40 * beat_ms, "beat": 40}, {"startMs": 100 * beat_ms + 3, "beat": 100}]
    st = {"v": 2, "kind": "structure", "meter": 4, "parts": parts, "bars": bar_list, "echoOf": echo_of, "phrases": [{"bar": 0, "bars": len(starts)}]}
    Path(f"{base}.st.json").write_text(__import__("json").dumps(st), encoding="utf-8")


def test_dataset_v3_layout_reads_back_through_the_pack_cli():
    import json
    root = temp_dir("nn2-v3-")
    rng = np.random.default_rng(9)
    recs = [D.synthetic_record(rng, k, nb=160) for k in range(3)]
    with open(root / "index.jsonl", "w", encoding="utf-8") as f:
        for k, rec in enumerate(recs):
            write_v3_map(root, f"a{k}0f{k}", rec, flat=(k == 2))  # two in E's shards, one in the old flat layout
            f.write(json.dumps({"id": f"a{k}0f{k}", "songGroup": f"g{k}", "source": "songs", "danOurs": 7.5, "msdOurs": [1] * 8,
                                "weight": 0.5, "creatorKey": "c", "split": "train", "rate": 0.95}) + "\n")
    assert (root / "maps" / "a0" / "a00f0.u8").exists() and (root / "maps" / "a20f2.u8").exists()
    out = root / "pack"
    D.main(["pack", "--data", str(root), "--out", str(out)])
    pack = D.Pack(out)
    assert pack.meta["maps"] == 3 and not pack.meta["skipped"], pack.meta["skipped"]
    assert pack.meta["rateCond"] == "one" and all(m["rate"] == 1.0 for m in pack.maps), "rate edits are rate 1 by default"
    for k, rec in enumerate(recs):
        m = pack.maps[k]
        sl = slice(m["offset"], m["offset"] + m["beats"])
        assert m["beats"] == 160 and m["source"] == D.SOURCES.index("osu") and m["dan"] == 7.5 and m["weight"] == 0.5
        assert (np.asarray(pack.mm["masks"][sl]) == rec["masks"]).all()
        assert (np.asarray(pack.mm["div"][sl]) == rec["div"]).all()
        assert (np.asarray(pack.mm["fam"][sl]) == rec["fam"]).all()
        lanes = np.asarray(pack.mm["lanes"][sl], np.float32)
        present = lanes[:, :, D.PRESENT] > 0.5
        assert (present.sum(1) == D.DIV_VALUE[rec["div"]]).all()
        assert np.allclose(lanes[present][:, 0], rec["lanes"][present][:, 0], atol=1e-3)  # onset (stored as f16)
        echo = np.asarray(pack.mm["echo"][sl])
        assert list(echo[20:24, 0]) == [4, 5, 6, 7] and list(echo[4:8, 1]) == [20, 21, 22, 23]
        assert (echo[:, 0] >= 0).sum() == 4
        assert m["parts"] == [0, 40, 100]


def test_echo_links_follow_the_bars_of_st_json():
    """A bar of 3 beats (a red line mid-song): the st.json bars move every later bar; the reader must take them, not
    re-cut bars every 4 beats from the BPM column (bars_from_beats, which sees no red line here)."""
    import json
    root = temp_dir("nn2-bars-")
    rec = D.synthetic_record(np.random.default_rng(3), 0, nb=64)
    bars = [0, 4, 8, 11, 15, 19, 23, 27, 31]  # bar 3 has 3 beats
    write_v3_map(root, "bb01", rec, bars=bars)
    entry = {"id": "bb01", "songGroup": "g", "source": "songs", "danOurs": 5, "split": "train"}
    got, why = D.read_map_v3(root, entry)
    assert why is None, why
    back = got["echo"][:, 0]
    # echoOf[5] = 1: bar 5 = beats 19..22 repeats bar 1 = beats 4..7
    assert list(back[19:23]) == [4, 5, 6, 7], list(back[16:24])
    assert (back >= 0).sum() == 4


def test_rate_condition_is_one_unless_kept():
    assert D.rate_of({"rate": 0.95}) == 1.0 and D.rate_of({"rate": 1.1}) == 1.0 and D.rate_of({}) == 1.0
    assert D.rate_of({"rate": 0.95}, "keep") == 0.95
    assert D.rate_of({"rate": 1.13}, "keep") == 1.15 and D.rate_of({"rate": 1.12}, "keep") == 1.1
    assert D.rate_of({"rate": None}, "keep") == 1.0 and D.rate_of({"rate": -1}, "keep") == 1.0


def test_both_masking_schedules_are_distributions():
    for name, sched in D.SCHEDULES.items():
        assert abs(sum(p for _, p in sched) - 1) < 1e-9, name
        assert {m for m, _ in sched} == {"free", "spans", "parts", "prefix"}


def test_export_rounds_every_weight_to_f16_before_the_probes():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import export_infill as E
    pack = synth_pack()
    model = loud(M.build_model("XS", n_styles=pack.n_styles()), std=0.2, seed=3)
    entries = E.round_to_f16(model)
    for name, p in model.named_parameters():
        if name.startswith("aux_"):
            assert name not in entries
            continue
        scale = entries[name]["scale"]
        # what the JS decodes (half x scale in float32) is exactly the weight the probes were computed with
        raw =np.frombuffer(__import__("base64").b64decode(entries[name]["f16"]), dtype="<f2").astype(np.float32) * np.float32(scale)
        assert np.array_equal(raw.reshape(p.shape), p.detach().numpy()), name
    windows, rng = E.probe_windows(pack, 64, model.cfg.n_styles, 1)
    probes = [E.make_probe(model, name, w, rng) for name, w in windows]
    assert [p["name"] for p in probes] == ["full", "lock", "style"]
    for p in probes:
        assert len(p["check"]) == E.CHECKS and p["T"] <= 64
        vis = np.frombuffer(__import__("base64").b64decode(p["visible"]), np.uint8)
        assert (vis != 255).any() == (p["name"] != "full")
    assert (probes[2]["style"] >= 1) == (model.cfg.n_styles > 1), "the style probe uses a style when the model has one"


def test_distillation_kl_is_zero_against_itself_and_positive_otherwise():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import train_infill as TI
    pack = synth_pack()
    model = loud(M.build_model("XS", n_styles=pack.n_styles()), seed=4)
    b = small_batch(pack, mode="spans")
    b["protect"] = b["visible"].clone()
    with torch.no_grad():
        out = model(b)
        _, same = TI.losses(model, out, b, teacher_logits=out["logits"])
        _, other = TI.losses(model, out, b, teacher_logits=out["logits"].flip(-1))
    assert abs(same["kl"]) < 1e-5 and other["kl"] > 0.1


if __name__ == "__main__":
    failed = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as err:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(err).__name__}: {err}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
