"""Reader for the mapper3 dataset (tools/build-mapper-dataset.mjs --format v3; layout in that file's header).

Used by tools/train_mapper.py, and meant for the nn-v2 loader (stream N) and the critic (stream R):

    ds = Mapper3("A:/SneezeyTrain/mapper3")
    for row in ds.rows("train"):
        X = ds.slot_features(row)          # float32 [S, F]  (np.memmap, nothing read until used)
        lab = ds.slot_labels(row)          # uint8   [S, 4]  note, mask, family, div
        tok = beat_tokens(ds, row)         # float32 [T, 8*12 + B + 4]  the addendum §4.4 beat token
        masks = mirror_masks(lab[:, 1])    # column mirror for augmentation (§3.6), never stored

Index lines are split at "\\n" only (read_jsonl): str.splitlines() also breaks at U+2028, U+0085 and friends, which
chart names contain.
"""
import json
import sys
import zlib
from pathlib import Path

import numpy as np

FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"]
MSD8 = ["overall", "stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"]
LANES = 8
LANE_VALUES = ["onset", "low", "mid", "high", "kick", "snare", "hat", "harm", "perc_share", "energy", "phase", "present"]
DIVS = [4, 3, 6, 8]
# column mirror of a 4-key mask: column c -> 3 - c
MIRROR = np.array([((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3) for m in range(16)], dtype=np.uint8)


def warn(msg):
    print(f"warning: {msg}", file=sys.stderr, flush=True)


def read_jsonl(path):
    """Rows of a JSONL file, split at b"\\n" only; blank lines skipped; bad lines counted, never fatal."""
    rows, bad = [], 0
    for raw in Path(path).read_bytes().split(b"\n"):
        line = raw.rstrip(b"\r")
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line.decode("utf-8")))
        except (ValueError, UnicodeDecodeError):
            bad += 1
    return rows, bad


def group_hash(group):
    """crc32 of the UTF-8 song group: the same number as tools/lib/dataset3.mjs groupHash()."""
    return zlib.crc32(str(group).encode("utf-8"))


def mirror_masks(masks):
    return MIRROR[np.asarray(masks, dtype=np.uint8)]


class Mapper3:
    def __init__(self, root):
        self.root = Path(root)
        fmt = self.root / "format.json"
        self.format = json.loads(fmt.read_text(encoding="utf-8")) if fmt.exists() else {"format": "mapper3", "version": 3}
        self.feature_names = json.loads((self.root / "feature_names.json").read_text(encoding="utf-8"))
        bfn = self.root / "beat_feature_names.json"
        self.beat_feature_names = json.loads(bfn.read_text(encoding="utf-8")) if bfn.exists() else []
        self.index, bad = read_jsonl(self.root / "index.jsonl")
        if bad:
            warn(f"{bad} unreadable lines in {self.root / 'index.jsonl'}")

    def rows(self, split=None):
        return [r for r in self.index if split is None or r.get("split") == split]

    def base(self, row):
        return self.root / "maps" / row["id"][:2] / row["id"]

    def _arr(self, row, ext, dtype, shape, mmap):
        p = Path(f"{self.base(row)}.{ext}")
        if mmap:
            return np.memmap(p, dtype=dtype, mode="r", shape=shape)
        return np.fromfile(p, dtype=dtype).reshape(shape)

    def slot_features(self, row, mmap=True):
        return self._arr(row, "f32", np.float32, (row["slots"], row["features"]), mmap)

    def slot_labels(self, row, mmap=True):
        return self._arr(row, "u8", np.uint8, (row["slots"], 4), mmap)

    def slot_times(self, row, mmap=True):
        return self._arr(row, "t32", np.float32, (row["slots"],), mmap)

    def beat_features(self, row, mmap=True):
        return self._arr(row, "b32", np.float32, (row["beats"], row["beatFeatures"]), mmap)

    def beat_divs(self, row, mmap=True):
        return self._arr(row, "bd8", np.uint8, (row["beats"],), mmap)

    def beat_offsets(self, row):
        return np.fromfile(f"{self.base(row)}.bs32", dtype=np.int32)

    def structure(self, row):
        return json.loads(Path(f"{self.base(row)}.st.json").read_text(encoding="utf-8"))

    def slot_beats(self, row):
        """Per slot: its beat index and its position in that beat as a fraction (pos / div)."""
        bs = self.beat_offsets(row)
        counts = np.diff(bs)
        beat = np.repeat(np.arange(len(counts)), counts)
        pos = np.arange(row["slots"]) - bs[beat]
        div = self.slot_labels(row, mmap=False)[:, 3].astype(np.float64)
        return beat, pos / np.maximum(div, 1)


def beat_tokens(ds, row, lanes=LANES):
    """The nn-v2 beat token of addendum §4.4: lanes x LANE_VALUES (from the .f32 columns of the beat's slots; a column
    the dataset does not have, e.g. the stem columns under v2 names, is 0; `present` is 1 for a real slot), then the beat
    columns of .b32, then a one-hot of the grid the beat's slots are cut on (4, 3, 6, 8: the .u8 div of its first slot)."""
    X = ds.slot_features(row, mmap=False)
    names = ds.feature_names
    cols = [names.index(v) if v in names else -1 for v in LANE_VALUES[:-1]]
    bs = ds.beat_offsets(row)
    T = row["beats"]
    L = len(LANE_VALUES)
    lane = np.zeros((T, lanes, L), dtype=np.float32)
    counts = np.diff(bs)
    for k in range(lanes):
        have = counts > k
        idx = bs[:-1][have] + k
        for j, c in enumerate(cols):
            if c >= 0:
                lane[have, k, j] = X[idx, c]
        lane[have, k, L - 1] = 1.0
    B = ds.beat_features(row, mmap=False) if row.get("beatFeatures") else np.zeros((T, 0), dtype=np.float32)
    grid = ds.slot_labels(row, mmap=False)[bs[:-1], 3]
    onehot = np.zeros((T, len(DIVS)), dtype=np.float32)
    for j, d in enumerate(DIVS):
        onehot[grid == d, j] = 1.0
    return np.concatenate([lane.reshape(T, lanes * L), B.astype(np.float32), onehot], axis=1)
