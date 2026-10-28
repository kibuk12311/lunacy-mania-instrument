"""Tests for tools/nn/add_style.py (adding one mapper style to a shipped nn-v2 model). pytest is not in the venv, so
this file also runs on its own:  .venv/Scripts/python.exe -I tools/nn/test_add_style.py"""
from __future__ import annotations

import atexit
import base64
import copy
import gc
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nn import infill_data as D  # noqa: E402
from nn import infill_model as M  # noqa: E402
from nn import add_style as A  # noqa: E402
import export_infill as E  # noqa: E402
import train_infill as TI  # noqa: E402

torch.set_num_threads(2)
ROOT = Path(__file__).resolve().parents[2]
_TEMP = []
_PACK = None


def temp_dir(prefix):
    d = Path(tempfile.mkdtemp(prefix=prefix))
    _TEMP.append(d)
    return d


@atexit.register
def _cleanup():
    global _PACK
    _PACK = None  # Windows keeps memory-mapped files open
    gc.collect()
    for d in _TEMP:
        shutil.rmtree(d, ignore_errors=True)


def synth_pack():
    """40 synthetic maps; every 5th song group held out as val (the songs the new row is stopped on)."""
    global _PACK
    if _PACK is None:
        out = temp_dir("add-style-pack-")
        rng = np.random.default_rng(11)
        w = D.PackWriter(out)
        for k in range(40):
            rec = D.synthetic_record(rng, k, nb=[300, 140, 90, 200][k % 4])
            rec["meta"]["split"] = "val" if (k // 2) % 5 == 0 else "train"
            rec["meta"]["style"] = "n:new"
            w.add(rec)
        w.close({"data": "test"})
        _PACK = D.Pack(out)
    return _PACK


def loud(model, std=0.2, seed=0):
    g = torch.Generator().manual_seed(seed)
    with torch.no_grad():
        for p in model.parameters():
            p.copy_(torch.randn(p.shape, generator=g) * std)
    return model.eval()


def tiny_doc(styles=3, seed=3):
    """A model JSON shaped like the shipped ones (export_infill's f16 weights and parity probes), XS, `styles` styles."""
    pack = synth_pack()
    model = loud(M.build_model("XS", n_styles=styles + 1), seed=seed)
    weights = E.round_to_f16(model)
    windows, rng = E.probe_windows(pack, 64, model.cfg.n_styles, 1)
    probes = [E.make_probe(model, name, w, rng) for name, w in windows]
    cfg = model.cfg.to_json()
    doc = {
        "kind": "nn-v2", "size": cfg["size"], "version": 1,
        "arch": {**cfg, "families": M.FAMILIES, "sources": M.SOURCES, "laneValues": M.LANE_VALUES, "beatFeatures": M.BEAT_FEATURES_V3,
                 "divClasses": M.DIV_CLASSES, "inDim": M.IN_DIM},
        "norm": {"mean": [float(v) for v in model.in_mean], "inv": [float(v) for v in model.in_inv]},
        "families": M.FAMILIES, "needs": ["stems", "structure"],
        "styles": [{"key": f"n:m{k}", "name": f"n:m{k}", "maps": 40 - k} for k in range(styles)],
        "weights": weights, "parity": {"tolerance": 2e-3, "probes": probes}, "metrics": {"params": model.n_params()},
        "pattern": {"x": [1, 2]}, "stylePattern": {"n:m0": {"y": 1}},
    }
    return json.loads(json.dumps(doc)), model, pack


def batch_of(pack, style, seed=0, n=4):
    gen = A.batches(pack, n, seed, style, T=64)
    return TI.to_device(next(gen), torch.device("cpu"))


def logits(model, b):
    with torch.no_grad():
        return model(b)["logits"]


def test_the_json_gives_back_the_exported_weights():
    doc, model, pack = tiny_doc()
    back = A.model_from_json(doc).eval()
    for name, p in model.named_parameters():
        if not name.startswith("aux_"):
            assert torch.equal(back.state_dict()[name], p.detach()), name
    b = batch_of(pack, 2)
    assert torch.equal(logits(back, b), logits(model, b))


def test_only_the_new_row_trains_and_old_styles_answer_as_before():
    doc, model, pack = tiny_doc()
    m = A.model_from_json(doc)
    before = {k: v.clone() for k, v in m.state_dict().items()}
    ref = {s: logits(m, batch_of(pack, s, seed=5)) for s in (0, 1, 3)}
    new_id = A.add_row(m, m.style_emb.weight.detach()[1:].mean(0))
    assert new_id == 4 and m.cfg.n_styles == 5 and m.style_emb.num_embeddings == 5
    assert [n for n, _ in A.trainable(m)] == ["style_emb.new"]
    opt = torch.optim.AdamW([m.style_emb.new], lr=0.05, weight_decay=0.0)
    assert sum(len(g["params"]) for g in opt.param_groups) == 1
    row0 = m.style_emb.new.detach().clone()
    for step in range(5):
        b = batch_of(pack, new_id, seed=step)
        loss, _ = TI.losses(m, m(b), b)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    assert not torch.equal(m.style_emb.new.detach(), row0), "the row learns"
    after = m.state_dict()
    for k, v in before.items():
        if k == "style_emb.weight":
            assert torch.equal(after["style_emb.old"], v), "old style rows"
        else:
            assert torch.equal(after[k], v), k
    for s, want in ref.items():
        assert torch.equal(logits(m, batch_of(pack, s, seed=5)), want), f"style {s} changed"


def test_the_export_keeps_every_other_weight_bit_for_bit():
    doc, _, _ = tiny_doc()
    d = doc["arch"]["d"]
    scale = doc["weights"][A.STYLE]["scale"]
    row = np.linspace(-3 * scale, 3 * scale, d).astype(np.float32)  # beyond the old max |w|: still fits f16 at that scale
    entry = {"key": "n:phylacterya", "name": "phylacterya", "maps": 30}
    new, decoded = A.with_style_row(doc, row, entry, {"key": "n:phylacterya"})
    report = A.diff_models(doc, new)
    assert report["identical"] == len(doc["weights"]) - 1 and report["added"] == entry
    assert new["styles"][:-1] == doc["styles"] and new["styles"][-1] == entry, "appended at the end: old ids stay"
    assert new["arch"]["n_styles"] == doc["arch"]["n_styles"] + 1
    e, f = doc["weights"][A.STYLE], new["weights"][A.STYLE]
    assert f["scale"] == e["scale"] and base64.b64decode(f["f16"])[: len(base64.b64decode(e["f16"]))] == base64.b64decode(e["f16"])
    assert np.array_equal(A.decode(f)[-1], decoded) and np.allclose(decoded, row, rtol=1e-3, atol=1e-6 * scale)
    assert np.array_equal(A.decode(f)[:-1], A.decode(e))
    # the untouched JSON text is the same text
    strip = lambda x: json.dumps({k: v for k, v in x.items() if k not in ("arch", "styles", "weights", "parity", "addedStyles")}, separators=(",", ":"))  # noqa: E731
    assert strip(doc) == strip(new)
    # anything else that changes is refused
    for spoil in ("weight", "style", "scale", "probe", "key"):
        bad = copy.deepcopy(new)
        if spoil == "weight":
            name = next(k for k in bad["weights"] if k != A.STYLE)
            raw = bytearray(base64.b64decode(bad["weights"][name]["f16"]))
            raw[0] ^= 1
            bad["weights"][name]["f16"] = base64.b64encode(bytes(raw)).decode()
        elif spoil == "style":
            bad["styles"][0] = {**bad["styles"][0], "maps": 1}
        elif spoil == "scale":
            bad["weights"][A.STYLE]["scale"] = scale * 2
        elif spoil == "probe":
            bad["parity"]["probes"][0]["style"] = 2
        else:
            bad["pattern"] = {"x": [3]}
        try:
            A.diff_models(doc, bad)
        except AssertionError:
            continue
        raise AssertionError(f"a changed {spoil} passed the diff")


def test_pattern_stats_of_a_hand_made_map():
    masks = np.zeros((4, 8), np.uint8)
    masks[0, 0], masks[0, 2] = 1, 3  # a single, a jump sharing column 0 (a jack)
    masks[1, 0], masks[2, 1] = 7, 15  # a hand sharing columns 0, 1 with the jump; a quad
    present = np.zeros((4, 8), bool)
    present[:, :4] = True
    fam = np.array([3, 3, 0, M.FAM_UNKNOWN], np.uint8)
    s = A.map_stats(masks, fam, present)
    assert np.allclose(s[:6], [1 / 3, 0, 0, 2 / 3, 0, 0])
    assert np.allclose(s[6:10], [0.25, 0.25, 0.25, 0.25])
    assert np.isclose(s[10], 1.0) and np.isclose(s[11], 1.0)
    near = A.nearest_styles({"a": s, "b": s + 0.1, "c": s * 0}, s, ["b", "c", "a"])
    assert [k for _, k in near] == ["a", "b", "c"]


def node_parity(model_file):
    """The app's JS inference on every parity probe of a model file -> worst |logit difference| per probe."""
    node = shutil.which("node")
    if not node:
        return None
    url = (ROOT / "src" / "gen" / "nn" / "infillModel.js").resolve().as_uri()
    code = (f"import {{ loadInfill, teacherForced, probeInputs }} from {json.dumps(url)};\n"
            "import { readFileSync } from 'node:fs';\n"
            "const m = JSON.parse(readFileSync(process.argv[1], 'utf8'));\n"
            "const net = loadInfill(m);\n"
            "console.log(JSON.stringify(m.parity.probes.map((p) => { const inp = probeInputs(p);\n"
            "  const got = teacherForced(net, inp, inp.rows, p.check); let w = 0;\n"
            "  got.forEach((g, k) => g.forEach((v, c) => { w = Math.max(w, Math.abs(v - p.logits[k][c])); }));\n"
            "  return [p.name, p.style, w]; })));\n")
    r = subprocess.run([node, "--input-type=module", "-e", code, str(model_file)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    return json.loads(r.stdout)


def test_train_then_export_end_to_end_and_the_js_agrees():
    doc, _, pack = tiny_doc(seed=7)
    tmp = temp_dir("add-style-run-")
    model_file = tmp / "mapper-nn2-xs.json"
    model_file.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    out = tmp / "run"
    res = A.main(["train", "--model", str(model_file), "--pack", str(pack.path), "--key", "n:phylacterya", "--out", str(out),
                  "--steps", "30", "--val-every", "10", "--patience", "0", "--batch", "4", "--device", "cpu", "--no-amp", "--lr", "0.05"])
    assert res["id"] == len(doc["styles"]) + 1 and res["name"] == "phylacterya" and res["maps"] == sum(1 for m in pack.maps if m["split"] == "train")
    assert res["baselines"]["unknown"]["songs"]["ce"] > 0 and set(res["val"]) == {"free", "parts"}
    assert float(torch.as_tensor(res["row"]).norm()) <= res["maxNorm"] + 1e-4, "the row stays inside the longest existing style row"
    assert (out / "row.pt").exists() and (out / "summary.json").exists() and len((out / "log.jsonl").read_text().splitlines()) == 3
    try:
        A.main(["train", "--model", str(model_file), "--pack", str(pack.path), "--key", "n:m1", "--out", str(tmp / "dup"), "--device", "cpu"])
    except SystemExit:
        pass
    else:
        raise AssertionError("a key the model already has is refused")
    new_file = tmp / "new" / "mapper-nn2-xs.json"
    A.main(["export", "--model", str(model_file), "--row", str(out / "row.pt"), "--pack", str(pack.path), "--out", str(new_file)])
    new = json.loads(new_file.read_text(encoding="utf-8"))
    A.diff_models(doc, new)
    assert new["styles"][-1] == {"key": "n:phylacterya", "name": "phylacterya", "maps": res["maps"]}
    assert [p["name"] for p in new["parity"]["probes"]] == ["full", "lock", "style", "style-added"]
    assert new["parity"]["probes"][-1]["style"] == res["id"]
    assert new["addedStyles"][0]["key"] == "n:phylacterya"
    # the probe of the new style is what the PyTorch model of the new file gives
    m = A.model_from_json(new).eval()
    p = new["parity"]["probes"][-1]
    assert np.array_equal(m.style_emb.weight[-1].detach().numpy(), A.decode(new["weights"][A.STYLE])[-1])
    js = node_parity(new_file)
    if js is not None:
        assert [n for n, _, _ in js] == ["full", "lock", "style", "style-added"]
        assert all(w <= new["parity"]["tolerance"] for _, _, w in js), js
    assert p["T"] > 0


if __name__ == "__main__":
    failed = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as err:  # noqa: BLE001
            failed += 1
            import traceback
            traceback.print_exc()
            print(f"FAIL {name}: {type(err).__name__}: {err}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
