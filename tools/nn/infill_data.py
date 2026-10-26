"""Data for the nn-v2 infill transformer: map readers, a compact beat "pack" on disk (memmap), 512-beat windows,
the masking schedule, mirroring and condition dropout (ML addendum §3.3, §3.6, §4.4).

  python -I tools/nn/infill_data.py pack --data A:/SneezeyTrain/mapper3 --out A:/SneezeyTrain/nn2/pack-v3 [--limit N]
  python -I tools/nn/infill_data.py pack --layout v15 --data A:/SneezeyTrain/mapper15 --out ... --limit 600
  python -I tools/nn/infill_data.py synth --out A:/SneezeyTrain/nn2/pack-synth --maps 600

Dataset v3 layout this codes to: stream E's mapper3 (tools/build-mapper-dataset.mjs --format v3, layout in its
header). All of it is read in `read_map_v3`:
  <root>/index.jsonl                one map per line: id, songGroup, source, danOurs (or dan), msdOurs[8] | null,
                                    weight, creatorKey (or style), split ("train"/"val"/"test", else crc32(songGroup) % 10),
                                    rate, rateFrom, optional beat0 (the first beat that has slots)
  <root>/feature_names.json         slot feature names of .f32 (default AUDIO_FEATURES_V3, 37)
  <root>/beat_feature_names.json    beat feature names of .b32 (default BEAT_FEATURES_V3, 45)
  maps/<id[0:2]>/<id>.*  (two-character shards; a flat maps/<id>.* is read too, for older slices)
  .f32  float32 [slots x F]        .u8  uint8 [slots x 4] = note, mask, family (255 none), div
  .t32  float32 slot times (ms)    .b32 float32 [beats x 45]   .bd8 uint8 divisor per beat
  .bs32 int32 [beats + 1] CSR offsets: the slots of beat b are [bs[b], bs[b+1]) (used when present)
  .st.json  { meter, echoOf: [per bar], bars: [{ startMs, endMs, beat }] (beat = the bar's first beat), echoBeat?: [per
              beat], parts: [{ startMs, beat } | { startBeat }], phrases: [{ bar, bars }] }
            The bars are the builder's barsOf(slots, meter) (the bars songStructure cut), so echo links here map bars
            to beats exactly as the structure did; bars_from_beats is only the fallback for files without bars.
Slots are the labelled grid of each beat, beat after beat; a beat's lanes are its slots in grid order.

Rate: the corpus keeps ONE copy per chart key (tools/corpus-index.mjs: rate-1 copies first), so a mapper3 rate other
than 1 (0.95, 1.1 ...) is a chart that exists only as a rate edit, made for and played on its own (rate-changed) audio.
It is no rate variant of another training chart, and the app always asks at rate 1. So the rate condition is 1 for every
map by default (`--rate-cond one`); `--rate-cond keep` (the §3.2 ablation) stores the index rate rounded to 0.05 steps.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nn.infill_model import (  # noqa: E402
    BEAT_FEATURES_V3, DIV_CLASSES, FAMILIES, FAM_UNKNOWN, IN_DIM, LANE_VALUES, N_LANES, N_LANE_VALUES, SOURCES,
)

AUDIO_FEATURES = ["sub", "is_beat", "is_half", "onset", "low", "mid", "high", "onset_prev", "onset_next", "low_prev",
                  "low_next", "beat_share", "onset_local", "energy", "energy_delta", "bpm", "slot_ms"]
AUDIO_FEATURES_V2 = AUDIO_FEATURES + ["div", "phase", "is_third", "beat_on3", "beat_on4", "beat_on8"]
AUDIO_FEATURES_V3 = (AUDIO_FEATURES_V2 + ["kick", "snare", "hat", "harm", "perc_share", "kick_share", "snare_share", "hat_share"]
                     + ["phrase_pos", "is_phrase_start", "bar_in_phrase", "has_echo", "rep_sim", "novelty"])
OSU_SOURCES = {"songs", "sets", "corpus", "hf", "packs", "ranked", "osu", "drive", "danreform"}
WINDOW = 512
PRESENT = LANE_VALUES.index("present")
PHASE = LANE_VALUES.index("phase")
DIV_VALUE = np.array(DIV_CLASSES, dtype=np.float32)

# masking schedule (§4.4) and condition dropout (§3.6, §9)
SCHEDULE = (("free", 0.30), ("spans", 0.35), ("parts", 0.20), ("prefix", 0.15))
# the sweep's second schedule (3 sizes x 2 schedules, §4.4): more locked context, for lock-and-regenerate
SCHEDULES = {"plan": SCHEDULE, "lock": (("free", 0.15), ("spans", 0.35), ("parts", 0.35), ("prefix", 0.15))}
ECHO_WINDOWS = 0.25
ECHO_FORCED = 0.6
MIRROR_P = 0.5
DROP = {"dan": 0.10, "msd": 0.30, "style": 0.20, "family": 0.10, "source": 0.20}
STYLE_MIN_DIFFS = 30
STYLE_MIN_GROUPS = 8


def source_id(name) -> int:
    n = str(name or "").lower()
    if n in OSU_SOURCES:
        return SOURCES.index("osu")
    if n.startswith("etterna"):
        return SOURCES.index("etterna")
    if n.startswith("malody"):
        return SOURCES.index("malody")
    return 0


def split_of(entry) -> str:
    s = entry.get("split")
    if s in ("train", "val", "test"):
        return s
    k = zlib.crc32(str(entry.get("songGroup") or entry.get("group") or entry.get("songKey") or entry.get("id")).encode("utf-8")) % 10
    return "test" if k == 0 else "val" if k == 1 else "train"


def mirror_masks(m):
    m = np.asarray(m)
    return ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3)


def div_class(div_values):
    out = np.full(len(div_values), -1, dtype=np.int64)
    for k, d in enumerate(DIV_CLASSES):
        out[np.asarray(div_values) == d] = k
    return out


def build_x(lanes, beat, div):
    """lanes (n,8,12), beat (n,45), div class (n,) -> the raw 145 inputs per beat."""
    n = len(div)
    onehot = np.zeros((n, len(DIV_CLASSES)), dtype=np.float32)
    onehot[np.arange(n), np.asarray(div, dtype=np.int64)] = 1
    return np.concatenate([np.asarray(lanes, np.float32).reshape(n, N_LANES * N_LANE_VALUES), np.asarray(beat, np.float32), onehot], 1)


def echo_pairs(back):
    """echo back (per beat, -1 = none) -> (n,2) [back, forward]: forward = the first later beat whose back is this one."""
    back = np.asarray(back, dtype=np.int64)
    n = len(back)
    fwd = np.full(n, -1, dtype=np.int64)
    for t in range(n - 1, -1, -1):
        e = back[t]
        if 0 <= e < t:
            fwd[e] = t
    return np.stack([np.where((back >= 0) & (back < np.arange(n)), back, -1), fwd], 1).astype(np.int32)


def bars_from_beats(bpm, meter):
    """First beat of each bar, as songParts.barsOf cuts them: a new bar every `meter` beats from each BPM change."""
    starts = []
    section = 0
    for b in range(len(bpm)):
        if b == 0 or abs(float(bpm[b]) - float(bpm[b - 1])) > 1e-3:
            section = b
        if (b - section) % max(1, int(round(meter[b] or 4))) == 0:
            starts.append(b)
    return starts


def echo_from_structure(st, nb, bar_starts):
    if st is None:
        return np.full(nb, -1, dtype=np.int64)
    if "echoBeat" in st:
        e = np.asarray(st["echoBeat"][:nb], dtype=np.int64)
        return np.concatenate([e, np.full(nb - len(e), -1, dtype=np.int64)])
    echo_of = st.get("echoOf") or []
    starts = st.get("bars") or bar_starts
    starts = [s if isinstance(s, (int, float)) else s.get("startBeat", s.get("beat", 0)) for s in starts]
    back = np.full(nb, -1, dtype=np.int64)
    for B, E in enumerate(echo_of):
        if E is None or E < 0 or B >= len(starts) or E >= len(starts):
            continue
        b0, e0 = int(starts[B]), int(starts[E])
        b1 = int(starts[B + 1]) if B + 1 < len(starts) else nb
        e1 = int(starts[E + 1]) if E + 1 < len(starts) else nb
        for o in range(b1 - b0):
            if e0 + o < e1 and b0 + o < nb:
                back[b0 + o] = e0 + o
    return back


def part_starts(st, nb, beat_ms):
    starts = {0}
    if st:
        if "partStarts" in st:
            starts.update(int(b) for b in st["partStarts"])
        for p in st.get("parts") or st.get("phrases") or []:
            if "startBeat" in p:
                starts.add(int(p["startBeat"]))
            elif isinstance(p.get("beat"), (int, float)):
                starts.add(int(p["beat"]))  # mapper3 parts: the beat of the part's first slot
            elif "startMs" in p and beat_ms is not None and len(beat_ms):
                starts.add(int(np.abs(beat_ms - float(p["startMs"])).argmin()))  # part starts are rounded slot times
    return sorted(s for s in starts if 0 <= s < nb)


def _read(path, dtype, cols=None):
    a = np.fromfile(path, dtype=dtype)
    return a.reshape(-1, cols) if cols else a


def _times(path):
    if not path.exists():
        return None
    t = np.fromfile(path, dtype=np.float32)
    if len(t) > 1 and np.all(np.diff(t) >= -1e-3) and np.isfinite(t).all():
        return t.astype(np.float64)
    t = np.fromfile(path, dtype=np.int32).astype(np.float64)
    return t if len(t) > 1 and np.all(np.diff(t) >= 0) else None


RATE_STEP = 0.05


def rate_of(entry, mode="one"):
    """The rate condition of a map (see the header): 1, or with mode "keep" the index rate on a 0.05 grid."""
    if mode != "keep":
        return 1.0
    r = entry.get("rate")
    r = float(r) if isinstance(r, (int, float)) and math.isfinite(r) and r > 0 else 1.0
    return round(round(r / RATE_STEP) * RATE_STEP, 2)


def map_base(root: Path, map_id: str) -> Path:
    """maps/<id[0:2]>/<id> (mapper3's shards), else the flat maps/<id>."""
    sharded = root / "maps" / map_id[:2] / map_id
    if Path(f"{sharded}.u8").exists():
        return sharded
    return root / "maps" / map_id


def read_map_v3(root: Path, entry: dict, slot_names=None, beat_names=None, rate_mode="one"):
    """One map of dataset v3 -> a map record (see `record`), or (None, reason)."""
    slot_names = slot_names or AUDIO_FEATURES_V3
    beat_names = beat_names or BEAT_FEATURES_V3
    base = map_base(root, entry["id"])
    f32 = _read(Path(f"{base}.f32"), np.float32, len(slot_names))
    u8 = _read(Path(f"{base}.u8"), np.uint8, 4)
    b32 = _read(Path(f"{base}.b32"), np.float32, len(beat_names))
    if len(f32) != len(u8) or not len(u8):
        return None, "slot files disagree"
    col = {n: k for k, n in enumerate(slot_names)}
    div = u8[:, 3].astype(np.int64)
    bs_path = Path(f"{base}.bs32")
    if bs_path.exists():
        # the builder's CSR beat -> slot offsets: exact beats, positions = index inside the beat
        first = np.fromfile(bs_path, dtype=np.int32).astype(np.int64)
        if len(first) < 2 or first[0] != 0 or first[-1] != len(u8) or (np.diff(first) <= 0).any():
            return None, "bad beat offsets"
        pos = np.arange(len(u8)) - np.repeat(first[:-1], np.diff(first))
    else:
        phase = f32[:, col["phase"]] if "phase" in col else None
        if phase is None:
            return None, "no phase column"
        pos = np.rint(phase * div).astype(np.int64)
        starts = [0]
        for i in range(1, len(u8)):
            if pos[i] <= pos[i - 1] or div[i] != div[i - 1]:
                starts.append(i)
        first = np.asarray(starts + [len(u8)])
    ng = len(first) - 1
    beat0 = int(entry.get("beat0", 0))
    if beat0 + ng > len(b32) or (beat0 == 0 and "beat0" not in entry and ng != len(b32)):
        return None, f"{ng} slot beats vs {len(b32)} beat rows"
    dcls = div_class(div[first[:-1]])
    if (dcls < 0).any() or (pos >= N_LANES).any():
        return None, "divisor outside 4/3/6/8"
    lanes = np.zeros((ng, N_LANES, N_LANE_VALUES), dtype=np.float32)
    masks = np.zeros((ng, N_LANES), dtype=np.uint8)
    beat_of = np.repeat(np.arange(ng), np.diff(first))
    for k, name in enumerate(LANE_VALUES):
        if name == "present":
            lanes[beat_of, pos, k] = 1
        elif name in col:
            lanes[beat_of, pos, k] = f32[:, col[name]]
    masks[beat_of, pos] = np.where(u8[:, 0] > 0, u8[:, 1], 0)
    bcol = {n: k for k, n in enumerate(beat_names)}
    beat = np.zeros((ng, len(BEAT_FEATURES_V3)), dtype=np.float32)
    for k, name in enumerate(BEAT_FEATURES_V3):
        if name in bcol:
            beat[:, k] = b32[beat0:beat0 + ng, bcol[name]]
    fam = u8[first[:-1], 2].astype(np.int64)
    fam = np.where(fam < len(FAMILIES), fam, FAM_UNKNOWN).astype(np.uint8)
    st_path = Path(f"{base}.st.json")
    st = json.loads(st_path.read_text(encoding="utf-8")) if st_path.exists() else None
    meter = beat[:, BEAT_FEATURES_V3.index("meter")] if "meter" in bcol else np.full(ng, 4.0)
    bpm = beat[:, BEAT_FEATURES_V3.index("bpm")]
    times = _times(Path(f"{base}.t32"))
    beat_ms = times[first[:-1]] if times is not None and len(times) == len(u8) else None
    back = echo_from_structure(st, ng, bars_from_beats(bpm, meter))
    return record(lanes, beat, dcls, masks, fam, echo_pairs(back), part_starts(st, ng, beat_ms), entry, rate=rate_of(entry, rate_mode)), None


def read_map_v15(root: Path, entry: dict):
    """A map of the v1.5 XGB dataset (mapper15: 1/4 slots, 17 features, [note, mask, family]) as a v3 record: lanes
    from onset/low/mid/high/energy, s0/s3/s6/s9 from the quarter onsets, no stems, no structure. For small real
    slices only (the data stream's dataset v3 is the real input)."""
    base = root / "maps" / entry["id"]
    f32 = _read(base.with_suffix(".f32"), np.float32, len(AUDIO_FEATURES))
    u8 = _read(base.with_suffix(".u8"), np.uint8, 3)
    if len(f32) != len(u8) or len(u8) < 64:
        return None, "slot files disagree"
    if not np.isfinite(f32).all():
        return None, "non-finite features"
    col = {n: k for k, n in enumerate(AUDIO_FEATURES)}
    sub = f32[:, col["sub"]].astype(np.int64)
    first = [0] + [i for i in range(1, len(sub)) if sub[i] <= sub[i - 1]]
    first = np.asarray(first + [len(sub)])
    ng = len(first) - 1
    beat_of = np.repeat(np.arange(ng), np.diff(first))
    lanes = np.zeros((ng, N_LANES, N_LANE_VALUES), dtype=np.float32)
    for name in ("onset", "low", "mid", "high", "energy"):
        lanes[beat_of, sub, LANE_VALUES.index(name)] = f32[:, col[name]]
    lanes[beat_of, sub, PHASE] = sub / 4
    lanes[beat_of, sub, PRESENT] = 1
    masks = np.zeros((ng, N_LANES), dtype=np.uint8)
    masks[beat_of, sub] = np.where(u8[:, 0] > 0, u8[:, 1], 0)
    beat = np.zeros((ng, len(BEAT_FEATURES_V3)), dtype=np.float32)
    onset = lanes[:, :4, LANE_VALUES.index("onset")]
    mx = onset.max(1)
    for k in range(4):
        beat[:, 3 * k] = np.where(mx > 0, onset[:, k] / np.maximum(mx, 1e-9), 0)
    beat[:, BEAT_FEATURES_V3.index("beat_max")] = mx
    beat[:, BEAT_FEATURES_V3.index("energy")] = f32[first[:-1], col["energy"]]
    beat[:, BEAT_FEATURES_V3.index("bpm")] = f32[first[:-1], col["bpm"]]
    fam = u8[first[:-1], 2].astype(np.int64)
    fam = np.where(fam < len(FAMILIES), fam, FAM_UNKNOWN).astype(np.uint8)
    parts = list(range(0, ng, 32))
    return record(lanes, beat, np.zeros(ng, dtype=np.int64), masks, fam, echo_pairs(np.full(ng, -1)), parts, entry), None


def record(lanes, beat, div, masks, fam, echo, parts, entry, rate=None):
    msd = entry.get("msdOurs")
    return {
        "lanes": lanes, "beat": beat, "div": np.asarray(div, dtype=np.uint8), "masks": masks, "fam": fam, "echo": echo,
        "parts": [int(p) for p in parts],
        "meta": {
            "id": entry.get("id"), "group": entry.get("songGroup") or entry.get("group") or entry.get("songKey"),
            "source": source_id(entry.get("source")), "sourceName": entry.get("source"),
            "dan": entry.get("danOurs", entry.get("dan")),
            "msd": [float(v) for v in msd] if msd is not None and len(msd) == 8 else None,
            "style": entry.get("style") or entry.get("creatorKey"),
            "weight": entry.get("weight"), "split": split_of(entry), "rate": float(rate if rate is not None else rate_of(entry)),
        },
    }


# ---- synthetic maps: learnable rules (rows follow onsets, families shape the masks, bars repeat) ----
def synthetic_record(rng, k, nb=None):
    nb = nb or int(rng.integers(120, 900))
    dan = float(rng.uniform(2, 16))
    div = rng.choice(4, size=nb, p=[0.8, 0.08, 0.04, 0.08]).astype(np.int64)
    run = 0
    for b in range(1, nb):  # grids come in runs
        if run > 0:
            div[b] = div[b - 1]
            run -= 1
        elif div[b] != 0:
            run = int(rng.integers(1, 6))
    fam_sec = rng.integers(0, len(FAMILIES), size=nb // 8 + 1)
    fam = np.repeat(fam_sec, 8)[:nb].astype(np.uint8)
    lanes = np.zeros((nb, N_LANES, N_LANE_VALUES), dtype=np.float32)
    masks = np.zeros((nb, N_LANES), dtype=np.uint8)
    beat = np.zeros((nb, len(BEAT_FEATURES_V3)), dtype=np.float32)
    bpm = float(rng.uniform(120, 220))
    energy = np.clip(np.cumsum(rng.normal(0, 0.05, nb)) % 1.0, 0, 1)
    thr = 0.75 - dan / 30
    prev = 0
    back = np.full(nb, -1, dtype=np.int64)
    for b in range(nb):
        dv = DIV_CLASSES[div[b]]
        src = b - 48 if b >= 48 and (b // 16) % 4 == 3 else None  # every 4th 16-beat block repeats the one 48 beats back
        for l in range(dv):
            on = float(rng.random()) * (1.3 if l == 0 else 0.9)
            if src is not None and div[src] == div[b]:
                on = lanes[src, l, 0]
            lanes[b, l, 0] = on
            lanes[b, l, 1:4] = on * rng.uniform(0.5, 1.0, 3)
            lanes[b, l, LANE_VALUES.index("kick")] = on if l == 0 else 0
            lanes[b, l, LANE_VALUES.index("energy")] = energy[b]
            lanes[b, l, PHASE] = l / dv
            lanes[b, l, PRESENT] = 1
            if src is not None and div[src] == div[b]:
                m = int(masks[src, l])
                back[b] = src
            elif on > thr:
                f = FAMILIES[fam[b]]
                if f == "Stream":
                    m = [1, 2, 4, 8][(int(math.log2(prev & -prev)) + 1) % 4] if prev and prev & (prev - 1) == 0 else 1
                elif f == "Jumpstream":
                    m = 5 if prev in (10, 0) else 10 if prev == 5 else 3
                elif f == "Handstream":
                    m = 7 if prev != 7 else 14
                elif f == "Chordjack":
                    m = 15 if l == 0 else 6
                elif f == "Jack":
                    m = 9
                else:
                    m = int(rng.integers(1, 16))
            else:
                m = 0
            masks[b, l] = m
            if m:
                prev = m
        s = lanes[b, :dv, 0]
        beat[b, BEAT_FEATURES_V3.index("beat_max")] = s.max()
        beat[b, BEAT_FEATURES_V3.index("energy")] = energy[b]
        beat[b, BEAT_FEATURES_V3.index("bpm")] = bpm
        beat[b, BEAT_FEATURES_V3.index("meter")] = 4
        beat[b, BEAT_FEATURES_V3.index("has_echo")] = 1.0 if back[b] >= 0 else 0.0
    entry = {"id": f"synth{k}", "songGroup": f"g{k // 2}", "source": "osu" if k % 3 else "etterna", "danOurs": dan,
             "msdOurs": [dan * 2] * 8 if k % 2 else None, "weight": 1.0, "creatorKey": f"c{k % 5}"}
    return record(lanes, beat, div, masks, fam, echo_pairs(back), list(range(0, nb, 64)), entry)


# ---- pack: every map's beats in a few flat files, memory-mapped for training ----
PACK_FILES = {"lanes": (np.float16, (N_LANES, N_LANE_VALUES)), "beat": (np.float16, (len(BEAT_FEATURES_V3),)),
              "div": (np.uint8, ()), "masks": (np.uint8, (N_LANES,)), "fam": (np.uint8, ()), "echo": (np.int32, (2,))}


class PackWriter:
    def __init__(self, out: Path):
        self.out = Path(out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.files = {k: open(self.out / f"{k}.bin", "wb") for k in PACK_FILES}
        self.maps = open(self.out / "maps.jsonl", "w", encoding="utf-8")
        self.n = 0
        self.count = 0
        self.sum = np.zeros(IN_DIM, dtype=np.float64)
        self.sq = np.zeros(IN_DIM, dtype=np.float64)
        self.stat_beats = 0
        self.skipped = {}

    def add(self, rec):
        nb = len(rec["div"])
        for k, (dt, _) in PACK_FILES.items():
            self.files[k].write(np.ascontiguousarray(rec[k], dtype=dt).tobytes())
        meta = {**rec["meta"], "offset": self.n, "beats": nb, "parts": rec["parts"]}
        self.maps.write(json.dumps(meta, ensure_ascii=False) + "\n")
        if meta["split"] == "train":
            x = build_x(rec["lanes"].astype(np.float16).astype(np.float32), rec["beat"].astype(np.float16).astype(np.float32), rec["div"])
            self.sum += x.sum(0)
            self.sq += (x.astype(np.float64) ** 2).sum(0)
            self.stat_beats += nb
        self.n += nb
        self.count += 1

    def skip(self, reason):
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def close(self, info=None):
        for f in self.files.values():
            f.close()
        self.maps.close()
        maps = [json.loads(line) for line in (self.out / "maps.jsonl").read_text(encoding="utf-8").splitlines() if line]
        n = max(1, self.stat_beats)
        mean = self.sum / n
        std = np.sqrt(np.maximum(self.sq / n - mean ** 2, 0))
        inv = np.where(std >= 1e-3, 1 / np.maximum(std, 1e-3), 0.0)
        styles = eligible_styles(maps)
        meta = {"version": 1, "beats": self.n, "maps": self.count, "laneValues": LANE_VALUES, "beatFeatures": BEAT_FEATURES_V3,
                "divClasses": DIV_CLASSES, "families": FAMILIES, "sources": SOURCES, "inMean": mean.tolist(), "inInv": inv.tolist(),
                "styles": styles, "skipped": self.skipped,
                "splits": {s: sum(1 for m in maps if m["split"] == s) for s in ("train", "val", "test")}, **(info or {})}
        (self.out / "pack.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        return meta


def eligible_styles(maps):
    """Creators with at least 30 train diffs across at least 8 song groups (§3.4); everyone else is `unknown`."""
    diffs, groups = {}, {}
    for m in maps:
        key = m.get("style")
        if not key or m["split"] != "train":
            continue
        diffs[key] = diffs.get(key, 0) + 1
        groups.setdefault(key, set()).add(m.get("group"))
    keys = sorted(k for k in diffs if diffs[k] >= STYLE_MIN_DIFFS and len(groups[k]) >= STYLE_MIN_GROUPS)
    return [{"key": k, "name": k, "maps": diffs[k]} for k in keys]


class Pack:
    def __init__(self, path):
        self.path = Path(path)
        self.meta = json.loads((self.path / "pack.json").read_text(encoding="utf-8"))
        self.maps = [json.loads(line) for line in (self.path / "maps.jsonl").read_text(encoding="utf-8").splitlines() if line]
        self.style_ids = {s["key"]: i + 1 for i, s in enumerate(self.meta["styles"])}
        self._mm = None

    @property
    def mm(self):
        if self._mm is None:  # opened lazily, so a Pack can be sent to DataLoader workers
            n = self.meta["beats"]
            self._mm = {k: np.memmap(self.path / f"{k}.bin", dtype=dt, mode="r", shape=(n, *shape)) for k, (dt, shape) in PACK_FILES.items()}
        return self._mm

    def __getstate__(self):
        return {**self.__dict__, "_mm": None}

    def n_styles(self):
        return len(self.meta["styles"]) + 1


# ---- windows ----
def visible_mask(rng, nb, present, parts, mode=None, schedule=SCHEDULE):
    """The masking schedule: which slots of a window are visible (known) to the encoder. -> (mode, (nb,8) bool)."""
    if mode is None:
        r = rng.random()
        acc = 0.0
        for mode, p in schedule:
            acc += p
            if r < acc:
                break
    vis_beats = np.zeros(nb, dtype=bool)
    if mode == "parts":
        cuts = sorted({p for p in parts if 0 < p < nb})
        segs = list(zip([0] + cuts, cuts + [nb]))
        if len(segs) < 2:
            mode = "spans"
        else:
            free = rng.random(len(segs)) < 0.5
            if free.all():
                free[rng.integers(len(segs))] = False
            if not free.any():
                free[rng.integers(len(segs))] = True
            for (a, b), f in zip(segs, free):
                vis_beats[a:b] = not f
    if mode == "spans":
        vis_beats[:] = True
        k = int(rng.integers(1, 5))
        cover = rng.uniform(0.2, 0.8) * nb
        lens = rng.dirichlet(np.ones(k)) * cover
        for ln in lens:
            ln = max(1, int(round(ln)))
            a = int(rng.integers(0, max(1, nb - ln + 1)))
            vis_beats[a:a + ln] = False
    elif mode == "prefix":
        vis_beats[: int(round(rng.uniform(0.1, 0.7) * nb))] = True
    return mode, vis_beats[:, None] & present


def window(pack: Pack, mi: int, start: int, rng, train=True, mode=None, T=WINDOW, schedule=SCHEDULE):
    """One window of T beats from map mi starting at beat `start`: the numpy arrays the model's batch needs."""
    m = pack.maps[mi]
    mm = pack.mm
    off = m["offset"]
    nb = min(T, m["beats"] - start)
    sl = slice(off + start, off + start + nb)
    lanes = np.zeros((T, N_LANES, N_LANE_VALUES), np.float32)
    lanes[:nb] = mm["lanes"][sl]
    beat = np.zeros((T, len(BEAT_FEATURES_V3)), np.float32)
    beat[:nb] = mm["beat"][sl]
    div = np.zeros(T, np.int64)
    div[:nb] = mm["div"][sl]
    rows = np.zeros((T, N_LANES), np.int64)
    rows[:nb] = mm["masks"][sl]
    fam_true = np.full(T, FAM_UNKNOWN, np.int64)
    fam_true[:nb] = mm["fam"][sl]
    echo = np.full((T, 2), -1, np.int64)
    e = mm["echo"][sl].astype(np.int64) - start
    echo[:nb] = np.where((e >= 0) & (e < nb) & (mm["echo"][sl] >= 0), e, -1)
    valid = np.zeros(T, bool)
    valid[:nb] = True
    present = lanes[:, :, PRESENT] > 0.5
    rows = np.where(present, rows, 0)
    pos = (np.arange(T)[:, None] + np.arange(N_LANES)[None, :] / DIV_VALUE[div][:, None]).astype(np.float32)
    # the beat before the window, and the last 4 rows before it (the lane head's history)
    has_prev = start > 0
    prev_rows = np.zeros(N_LANES, np.int64)
    prev_present = np.zeros(N_LANES, bool)
    if has_prev:
        prev_rows[:] = mm["masks"][off + start - 1]
        prev_present[:] = mm["lanes"][off + start - 1, :, PRESENT] > 0.5
        prev_rows = np.where(prev_present, prev_rows, 0)
    pre_mask = np.zeros(4, np.int64)
    pre_pos = np.zeros(4, np.float32)
    got = []
    b = start - 1
    while b >= 0 and len(got) < 4:
        dv = DIV_CLASSES[int(mm["div"][off + b])]
        for l in range(dv - 1, -1, -1):
            mk = int(mm["masks"][off + b, l])
            if mk and mm["lanes"][off + b, l, PRESENT] > 0.5:
                got.append((mk, (b - start) + l / dv))
                if len(got) == 4:
                    break
        b -= 1
    for k, (mk, p) in enumerate(reversed(got)):  # oldest first, newest at index 3
        pre_mask[4 - len(got) + k] = mk
        pre_pos[4 - len(got) + k] = p
    parts = [p - start for p in m["parts"] if start <= p < start + nb]
    mode, visible = visible_mask(rng, nb, present[:nb], [0] + parts, mode=mode, schedule=schedule)
    vis = np.zeros((T, N_LANES), bool)
    vis[:nb] = visible
    echo_forced = np.zeros((T, N_LANES), bool)
    if train and rng.random() < ECHO_WINDOWS:
        has_echo = echo[:, 0] >= 0
        echo_forced = has_echo[:, None] & present & ~vis & (rng.random((T, N_LANES)) < ECHO_FORCED)
    loss = present & ~vis & ~echo_forced & valid[:, None]
    # conditions
    dan = m["dan"]
    dan_known = dan is not None and np.isfinite(dan)
    msd = np.zeros(8, np.float32)
    msd_known = m.get("msd") is not None
    if msd_known:
        msd[:] = m["msd"]
    style = pack.style_ids.get(m.get("style"), 0)
    source = m["source"]
    fam = fam_true.copy()
    if train:
        if rng.random() < DROP["dan"]:
            dan_known = False
        if rng.random() < DROP["msd"]:
            msd_known = False
        if rng.random() < DROP["style"]:
            style = 0
        if rng.random() < DROP["family"]:
            fam[:] = FAM_UNKNOWN
        if rng.random() < DROP["source"]:
            source = 0
        if rng.random() < MIRROR_P:
            rows = mirror_masks(rows)
            prev_rows = mirror_masks(prev_rows)
            pre_mask = mirror_masks(pre_mask)
    w = m.get("weight")
    return {
        "x": build_x(lanes, beat, div), "rows": rows, "present": present, "visible": vis, "valid": valid, "loss": loss,
        "protect": vis | echo_forced, "fam": fam, "fam_true": fam_true, "dan": np.full(T, float(dan) if dan_known else 0.0, np.float32),
        "dan_known": np.float32(dan_known), "msd": msd, "msd_known": np.float32(msd_known), "style": np.int64(style),
        "source": np.int64(source), "rate": np.float32(m.get("rate") or 1), "echo": echo, "prev_rows": prev_rows,
        "prev_present": prev_present, "has_prev": np.bool_(has_prev), "pre_mask": pre_mask, "pre_pos": pre_pos, "pos": pos,
        "div": div, "weight": np.float32(1.0 if w is None else w), "mode": mode,
    }


def collate(items):
    out = {}
    for k in items[0]:
        if k == "mode":
            out[k] = [it[k] for it in items]
        else:
            out[k] = np.stack([np.asarray(it[k]) for it in items])
    return out


def map_weights(pack, idx):
    """Sampling weight per map: its §3.2 weight (else 1/sqrt(diffs in its song group)) times its window count."""
    groups = {}
    for i in idx:
        groups[pack.maps[i]["group"]] = groups.get(pack.maps[i]["group"], 0) + 1
    w = []
    for i in idx:
        m = pack.maps[i]
        base = m["weight"] if m.get("weight") is not None else 1 / math.sqrt(groups[m["group"]])
        w.append(base * math.ceil(m["beats"] / WINDOW))
    w = np.asarray(w, dtype=np.float64)
    return w / w.sum()


def select_maps(pack, split, sources=None):
    return [i for i, m in enumerate(pack.maps) if m["split"] == split and (sources is None or m["source"] in sources)]


def train_batches(pack: Pack, batch, seed, sources=None, T=WINDOW, schedule="plan"):
    """An endless stream of training batches (numpy)."""
    rng = np.random.default_rng(seed)
    idx = select_maps(pack, "train", sources)
    if not idx:
        raise ValueError("no training maps in the pack")
    p = map_weights(pack, idx)
    while True:
        picks = rng.choice(len(idx), size=batch, p=p)
        items = []
        for k in picks:
            mi = idx[k]
            nb = pack.maps[mi]["beats"]
            start = int(rng.integers(0, max(1, nb - T + 1)))
            items.append(window(pack, mi, start, rng, train=True, T=T, schedule=SCHEDULES[schedule]))
        yield collate(items)


def val_windows(pack: Pack, sources=None, mode="free", limit=None, T=WINDOW, split="val"):
    """Deterministic validation windows: every T beats of every held-out map, one masking mode, no augmentation."""
    out = []
    for mi in select_maps(pack, split, sources):
        for start in range(0, pack.maps[mi]["beats"], T):
            if pack.maps[mi]["beats"] - start < 16:
                continue
            out.append(window(pack, mi, start, np.random.default_rng(zlib.crc32(f"{mi}:{start}:{mode}".encode())), train=False, mode=mode, T=T))
            if limit and len(out) >= limit:
                return out
    return out


def osu_sources():
    return {SOURCES.index("osu")}


# ---- CLI ----
def iter_index(root: Path, layout: str):
    files = ["index.jsonl"] + (["index-heldout.jsonl"] if layout == "v15" else [])
    for name in files:
        p = root / name
        if not p.exists():
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:  # json lines; names may hold U+2028, so never splitlines() on the whole file
                line = line.strip()
                if not line:
                    continue
                e = json.loads(line)
                if layout == "v15":
                    e["split"] = "train" if name == "index.jsonl" else ("val" if zlib.crc32(str(e.get("group")).encode()) % 2 == 0 else "test")
                yield e


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    pk = sub.add_parser("pack", help="pack a dataset into memmapped beat files")
    pk.add_argument("--data", required=True)
    pk.add_argument("--out", required=True)
    pk.add_argument("--layout", choices=["v3", "v15"], default="v3")
    pk.add_argument("--limit", type=int, default=0, help="maps per split at most (0 = all)")
    pk.add_argument("--sources", default="", help="comma list of source names to keep (default all)")
    pk.add_argument("--every", type=int, default=1, help="keep every N-th index line (a spread-out slice)")
    pk.add_argument("--rate-cond", choices=["one", "keep"], default="one",
                    help="rate condition: 1 for every map (default; see the header) or the index rate on a 0.05 grid")
    sy = sub.add_parser("synth", help="write a synthetic pack")
    sy.add_argument("--out", required=True)
    sy.add_argument("--maps", type=int, default=400)
    sy.add_argument("--seed", type=int, default=1)
    a = ap.parse_args(argv)
    if a.cmd == "synth":
        rng = np.random.default_rng(a.seed)
        w = PackWriter(Path(a.out))
        for k in range(a.maps):
            w.add(synthetic_record(rng, k))
        print(json.dumps({k: v for k, v in w.close({"data": "synthetic"}).items() if k in ("beats", "maps", "splits")}))
        return
    root = Path(a.data)
    keep = {s.strip().lower() for s in a.sources.split(",") if s.strip()}
    slot_names = json.loads((root / "feature_names.json").read_text(encoding="utf-8")) if (root / "feature_names.json").exists() else None
    beat_names = json.loads((root / "beat_feature_names.json").read_text(encoding="utf-8")) if (root / "beat_feature_names.json").exists() else None
    w = PackWriter(Path(a.out))
    per_split = {}
    for line_no, e in enumerate(iter_index(root, a.layout)):
        if line_no % max(1, a.every):
            continue
        if keep and str(e.get("source", "")).lower() not in keep:
            continue
        s = split_of(e)
        if a.limit and per_split.get(s, 0) >= (a.limit if s == "train" else max(1, a.limit // 5)):
            continue
        try:
            rec, why = read_map_v15(root, e) if a.layout == "v15" else read_map_v3(root, e, slot_names, beat_names, a.rate_cond)
        except (OSError, ValueError, KeyError) as err:
            rec, why = None, type(err).__name__
        if rec is None:
            w.skip(why)
            continue
        w.add(rec)
        per_split[s] = per_split.get(s, 0) + 1
        if w.count % 500 == 0:
            print(f"{w.count} maps, {w.n} beats", flush=True)
    meta = w.close({"data": str(root), "layout": a.layout, "rateCond": a.rate_cond})
    print(json.dumps({k: meta[k] for k in ("beats", "maps", "splits", "skipped")}))


if __name__ == "__main__":
    main()
