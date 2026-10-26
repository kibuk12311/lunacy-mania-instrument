"""Tests for tools/train_mapper.py, tools/dataset3.py and tools/fun-labels.py (plain asserts; pytest-compatible).

Run: .venv/Scripts/python.exe -I tests/py/test_train_mapper.py      (tests/tools/python.test.js runs it in npm test)
"""
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import zlib
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import dataset3  # noqa: E402
import train_mapper as tm  # noqa: E402

V2 = ["sub", "is_beat", "is_half", "onset", "low", "mid", "high", "onset_prev", "onset_next", "low_prev", "low_next",
      "beat_share", "onset_local", "energy", "energy_delta", "bpm", "slot_ms", "div", "phase", "is_third", "beat_on3",
      "beat_on4", "beat_on8"]
BEAT = [f"s{k}" for k in range(12)] + ["beat_max", "energy", "bpm"]


def load_fun_labels():
    spec = importlib.util.spec_from_file_location("fun_labels", ROOT / "tools" / "fun-labels.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def old_pattern_counts(masks, notes, fams, map_ids):
    """The v1 trainer's loop, kept here as the reference for the vectorised version."""
    counts = {}
    prev = prev2 = 0
    gap = tm.CONTEXT_RESET_SLOTS + 1
    last_map = -1
    for i in range(len(notes)):
        if map_ids[i] != last_map:
            prev = prev2 = 0
            gap = tm.CONTEXT_RESET_SLOTS + 1
            last_map = map_ids[i]
        if not notes[i]:
            gap += 1
            continue
        if gap > tm.CONTEXT_RESET_SLOTS:
            prev = prev2 = 0
        m = int(masks[i])
        fam = int(fams[i])
        if fam < len(tm.FAMILIES) and m:
            key = (fam, prev, prev2, tm.popcount(m), m)
            counts[key] = counts.get(key, 0) + 1
        prev2, prev = prev, m
        gap = 0
    return counts


def make_mapper3(root, n_maps=60, slots=600, seed=1):
    """A synthetic mapper3 folder: notes follow the onset column, 56 maps by one creator over 11 song groups,
    one map with an inf feature, one with a 6,000,000 BPM, a name with U+2028 in it."""
    rng = np.random.default_rng(seed)
    root = Path(root)
    (root / "maps").mkdir(parents=True)
    (root / "format.json").write_text(json.dumps({"format": "mapper3", "version": 3, "featureSet": "v2"}))
    (root / "feature_names.json").write_text(json.dumps(V2))
    (root / "beat_feature_names.json").write_text(json.dumps(BEAT))
    lines = []
    for k in range(n_maps):
        mid = f"{k:02d}" + "ab" * 7
        base = root / "maps" / mid[:2] / mid
        base.parent.mkdir(parents=True, exist_ok=True)
        S = slots
        T = S // 4
        X = rng.random((S, len(V2)), dtype=np.float32)
        X[:, V2.index("bpm")] = 150
        X[:, V2.index("slot_ms")] = 100
        X[:, V2.index("div")] = 4
        note = (rng.random(S) < 0.15 + 0.7 * X[:, V2.index("onset")] ** 3).astype(np.uint8)
        mask = np.where(note == 1, rng.integers(1, 16, S), 0).astype(np.uint8)
        fam = np.full(S, k % 6, dtype=np.uint8)
        bpm = 150.0
        if k == 1:
            X[5, 3] = np.inf
        if k == 2:
            bpm = 6_000_000.0
        lab = np.stack([note, mask, fam, np.full(S, 4, np.uint8)], axis=1)
        X.tofile(f"{base}.f32")
        lab.astype(np.uint8).tofile(f"{base}.u8")
        (np.arange(S, dtype=np.float32) * 100).tofile(f"{base}.t32")
        rng.random((T, len(BEAT)), dtype=np.float32).tofile(f"{base}.b32")
        np.full(T, 4, np.uint8).tofile(f"{base}.bd8")
        np.arange(0, S + 1, 4, dtype=np.int32).tofile(f"{base}.bs32")
        (Path(f"{base}.st.json")).write_text(json.dumps({"v": 1, "kind": "parts", "parts": []}))
        split = "test" if k % 7 == 3 else "val" if k % 7 == 5 else "train"
        lines.append({"id": mid, "split": split, "slots": S, "beats": T, "features": len(V2), "beatFeatures": len(BEAT),
                      "bpm": bpm, "danOurs": 3 + (k % 2), "danTracker": None, "weight": 1.0 + (k % 3),
                      "msdOurs": [10 + k % 10 + j * 0.1 for j in range(8)], "songGroup": f"g{k % 11}",
                      "creatorKey": "n:prolific" if k < 56 else "n:other", "creatorName": "Prolific\u2028Mapper",
                      "osuPath": f"x/{k}.osu"})
    with open(root / "index.jsonl", "w", encoding="utf-8", newline="\n") as f:
        for l in lines:
            # raw U+2028 inside the JSON string, as JSON.stringify used to write it: still one record per "\n"
            f.write(json.dumps(l, ensure_ascii=False) + "\n")
    return lines


def quiet(fn, *a, **kw):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        r = fn(*a, **kw)
    return r, out.getvalue(), err.getvalue()


def test_read_jsonl_splits_only_at_newline():
    d = Path(tempfile.mkdtemp())
    try:
        p = d / "x.jsonl"
        p.write_bytes(('{"a": "x\u2028y\u0085z\\u000bw"}\r\n\n{"b": 2}\nnot json\n').encode("utf-8"))  # \v arrives escaped
        rows, bad = dataset3.read_jsonl(p)
        assert rows == [{"a": "x\u2028y\u0085z\u000bw"}, {"b": 2}], rows
        assert bad == 1
        # what the v1.5 trainer did: splitlines() broke the first record apart
        assert len(p.read_text(encoding="utf-8").splitlines()) > 4
    finally:
        shutil.rmtree(d)


def test_group_hash_matches_node():
    # tests/tools/dataset3.test.js asserts the same numbers for node:zlib crc32
    assert dataset3.group_hash("abc|def") == 4184808628
    assert dataset3.group_hash("камелия|曲") == 1075183797


def test_vectorised_pattern_counts_equal_the_v1_loop():
    rng = np.random.default_rng(3)
    maps = []
    for k in range(6):
        S = 700
        note = (rng.random(S) < [0.6, 0.2, 0.05][k % 3]).astype(np.uint8)
        mask = np.where(note == 1, rng.integers(1, 16, S), 0).astype(np.uint8)
        fam = rng.integers(0, 7, S).astype(np.uint8)
        fam[fam == 6] = 255
        maps.append((note, mask, fam))
    ref = old_pattern_counts(np.concatenate([m[1] for m in maps]), np.concatenate([m[0] for m in maps]),
                             np.concatenate([m[2] for m in maps]), np.concatenate([np.full(len(m[0]), i) for i, m in enumerate(maps)]))
    counts = np.zeros(int(np.prod(tm.PATTERN_SHAPE)), dtype=np.int64)
    for note, mask, fam in maps:
        counts += np.bincount(tm.pattern_codes(note, mask, fam, tm.row_resets_v1(note)), minlength=counts.size)
    counts = counts.reshape(tm.PATTERN_SHAPE)
    got = {tuple(int(x) for x in k): int(counts[k]) for k in zip(*np.nonzero(counts))}
    assert got == ref
    tables = tm.counts_to_tables(counts)
    f, p, p2, s, m = next(iter(ref))
    assert tables[tm.FAMILIES[f]][f"{p},{p2},{s}"][m] == ref[(f, p, p2, s, m)]


def test_v3_context_reset_is_two_beats_in_ms():
    note = np.zeros(40, np.uint8)
    note[[0, 1, 9, 10, 30]] = 1
    t = np.arange(40) * 100.0  # 1/4 slots at 150 BPM: beat = 400 ms
    beat_ms = np.full(40, 400.0)
    # gaps: -, 100, 800 (= 2 beats, not more), 100, 2000 ms
    assert tm.row_resets_v3(note, t, beat_ms).tolist() == [True, False, False, False, True]


def test_mirror_tables_are_symmetric():
    rng = np.random.default_rng(5)
    c = rng.integers(0, 5, tm.PATTERN_SHAPE)
    m = c + tm.mirror_counts(c)
    M = dataset3.MIRROR
    for _ in range(200):
        f, p, p2, s, k = (int(rng.integers(0, n)) for n in tm.PATTERN_SHAPE)
        assert m[f, p, p2, s, k] == m[f, M[p], M[p2], s, M[k]]
    assert (tm.mirror_counts(tm.mirror_counts(c)) == c).all()
    assert dataset3.mirror_masks([1, 2, 4, 8, 6, 9]).tolist() == [8, 4, 2, 1, 6, 9]


def test_pattern_log_loss_prefers_the_right_table():
    c = np.zeros(tm.PATTERN_SHAPE, dtype=np.int64)
    c[0, 0, 0, 1, 1] = 90
    c[0, 0, 0, 1, 2] = 10
    good = np.array([(((0 * 16 + 0) * 16 + 0) * 5 + 1) * 16 + 1] * 9 + [(((0 * 16 + 0) * 16 + 0) * 5 + 1) * 16 + 2])
    bad = np.array([(((0 * 16 + 0) * 16 + 0) * 5 + 1) * 16 + 2] * 10)
    assert tm.pattern_log_loss(c, good) < tm.pattern_log_loss(c, bad)


def test_beat_tokens_follow_the_section_4_4_layout():
    d = Path(tempfile.mkdtemp())
    try:
        rows = make_mapper3(d, n_maps=3, slots=40)
        ds = dataset3.Mapper3(d)
        row = ds.index[0]
        tok = dataset3.beat_tokens(ds, row)
        L = len(dataset3.LANE_VALUES)
        assert tok.shape == (row["beats"], 8 * L + len(BEAT) + 4)
        X = ds.slot_features(row, mmap=False)
        # beat 2, lane 1 = slot 9; onset is lane value 0; present is the last lane value; lanes 4..7 are empty (1/4 grid)
        assert tok[2, 1 * L + 0] == X[9, V2.index("onset")]
        assert tok[2, 1 * L + L - 1] == 1 and tok[2, 5 * L + L - 1] == 0
        assert tok[2, 1 * L + dataset3.LANE_VALUES.index("kick")] == 0  # no stem columns under v2 names
        assert (tok[:, -4] == 1).all() and (tok[:, -3:] == 0).all()  # divisor one-hot: all 1/4
        beat, frac = ds.slot_beats(row)
        assert beat[9] == 2 and abs(frac[9] - 0.25) < 1e-9
        assert len(rows) == 3
    finally:
        shutil.rmtree(d)


def test_end_to_end_small_mapper3_on_cpu_streams_batches_and_skips_bad_maps():
    d = Path(tempfile.mkdtemp())
    try:
        make_mapper3(d / "m3")
        model, out, err = quiet(tm.main, [str(d / "m3"), str(d / "model.json"), str(d / "report.md"), "--device", "cpu",
                                          "--batch-rows", "2500", "--max-rounds", "8", "--mirror-tables", "--msd-prior", "--styles"])
        assert "non-finite features" in err and "6000000" in err, err
        assert model["kind"] == "xgb-v3" and model["grid"] == "snap-v2"
        assert model["metrics"]["skippedMaps"] == 2
        assert model["metrics"]["noteAuc"] > 0.6, model["metrics"]
        assert model["features"] == V2
        assert model["training"]["mirrorTables"] is True
        # the pattern table holds mirrored counts: every (prev, prev2, mask) has its mirror image
        stream = model["pattern"]["Stream"]
        for key, by_mask in list(stream.items())[:20]:
            p, p2, s = (int(x) for x in key.split(","))
            mk = f"{dataset3.MIRROR[p]},{dataset3.MIRROR[p2]},{s}"
            for m, n in by_mask.items():
                assert stream[mk][int(dataset3.MIRROR[int(m)])] == n
        prior = model["msdPrior"]
        assert prior["families"][-1] == "unknown" and len(prior["table"]) == len(prior["bins"])
        assert any(cell is not None for row in prior["table"] for cell in row)
        assert [s["key"] for s in model["styles"]] == ["n:prolific"]
        assert model["styles"][0]["name"] == "Prolific\u2028Mapper"
        assert "n:prolific" in model["stylePattern"] and isinstance(model["styleBias"]["n:prolific"], float)
        saved = json.loads((d / "model.json").read_text(encoding="utf-8"))
        assert saved["metrics"]["slots"] == model["metrics"]["slots"]
    finally:
        shutil.rmtree(d)


def test_memory_bounded_iterator_never_holds_more_than_a_batch():
    d = Path(tempfile.mkdtemp())
    try:
        make_mapper3(d / "m3", n_maps=12, slots=600)
        ds = tm.Dataset(d / "m3")
        it = tm.MapIter(ds, ds.rows, "note", 1000)
        sizes = []
        it.reset()
        while it.next(lambda data, label, weight: sizes.append((len(data), len(label), len(weight)))):
            pass
        quiet(lambda: None)
        assert all(a == b == c for a, b, c in sizes)
        assert max(a for a, _, _ in sizes) <= 1000 + 600  # one batch, at most one map over
        assert sum(a for a, _, _ in sizes) == 600 * (12 - 2)  # two bad maps skipped
        it.reset()
        again = []
        while it.next(lambda data, label, weight: again.append(len(data))):
            pass
        assert again == [a for a, _, _ in sizes], "the second pass sees the same batches"
    finally:
        shutil.rmtree(d)


def test_v1_dataset_split_by_group_and_skip():
    d = Path(tempfile.mkdtemp())
    try:
        (d / "maps").mkdir()
        (d / "feature_names.json").write_text(json.dumps(V2[:17]))
        rows = []
        rng = np.random.default_rng(0)
        for k in range(30):
            X = rng.random((200, 17), dtype=np.float32)
            X[:, 15] = 150
            if k == 4:
                X[0, 16] = np.inf  # inf slot_ms, as v1.5's gimmick maps
            X.tofile(d / "maps" / f"{k}_0.f32")
            np.zeros((200, 3), np.uint8).tofile(d / "maps" / f"{k}_0.u8")
            rows.append({"id": f"{k}_0", "set": f"set{k}", "group": f"g{k}", "slots": 200, "features": 17, "dan": 5.0, "bpm": 150})
        (d / "index.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        ds = tm.Dataset(d)
        splits = [ds.split_of(r) for r in rows]
        assert set(splits) <= {"train", "val", "test"}
        assert splits == [ds.split_of(r) for r in rows]
        assert all((zlib.crc32(r["group"].encode()) % 100 < 15) == (s == "test") for r, s in zip(rows, splits))
        (_, _, err) = quiet(lambda: [ds.load(r) for r in rows])
        assert "non-finite" in err and len(ds.skipped) == 1
    finally:
        shutil.rmtree(d)


def test_fun_labels_residuals_and_sanity():
    fl = load_fun_labels()
    rng = np.random.default_rng(11)
    rows = []
    bid = 1
    for s in range(400):
        n = int(rng.integers(1, 6))
        set_pop = rng.normal(8, 1.5)
        stars = np.sort(rng.uniform(1, 7, n))
        favs = int(np.exp(set_pop - 3 + rng.normal(0, 0.3)))
        year = int(rng.integers(2010, 2025))
        for j, st in enumerate(stars):
            plays = int(np.exp(set_pop - 0.3 * j + rng.normal(0, 0.4)))
            pass_ratio = float(np.clip(0.6 - 0.07 * st + rng.normal(0, 0.03), 0.01, 0.99))
            rows.append({"beatmapset_id": s + 1, "beatmap_id": bid, "approved": 1 if s % 5 else 4, "mode": 3, "diff_size": 4,
                         "playcount": plays, "passcount": int(plays * pass_ratio), "favourite_count": favs,
                         "difficultyrating": float(st), "approved_date": f"{year}-01-01 00:00:00", "submit_date": "", "version": f"d{j}"})
            bid += 1
    labels, report = fl.fun_labels(rows, tracker_set_plays={9999: 123})
    by_id = {r["beatmapId"]: r for r in labels if "beatmapId" in r}
    assert len(by_id) == len(rows)
    for key in ("playsResid", "passResid", "favResid"):
        rho = report["sanity"][key]["spearmanStars"]
        assert rho is not None and abs(rho) < 0.1, (key, rho)
        assert report["sanity"][key]["ok"] is True
    single = [r for r in labels if r.get("beatmapId") and r["setDiffs"] == 1]
    assert single and all(r["playsResid"] is None for r in single)
    assert any(r.get("setId") == 9999 and r.get("setPlays") == 123 and "beatmapId" not in r for r in labels)
    assert report["header"]["ok"] is True


def run_all():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(1 if run_all() else 0)
