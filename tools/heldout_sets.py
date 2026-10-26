"""Write data/mapper/heldout.json: the sets train_mapper.py kept out of training (same split, same seed)."""
import json
import sys
import zlib
from pathlib import Path

import numpy as np
from sklearn.model_selection import GroupShuffleSplit

data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data/mapper")
maps = [json.loads(l) for l in (data_dir / "index.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
groups = np.concatenate([np.full(m["slots"], zlib.crc32(m["set"].encode("utf-8"))) for m in maps])
_, test_idx = next(GroupShuffleSplit(n_splits=1, test_size=0.15, random_state=7).split(np.zeros(len(groups)), groups=groups))
test_groups = set(np.unique(groups[test_idx]).tolist())
held = sorted({m["set"] for m in maps if zlib.crc32(m["set"].encode("utf-8")) in test_groups})
(data_dir / "heldout.json").write_text(json.dumps(held, ensure_ascii=False), encoding="utf-8")
print(f"{len(held)} held-out sets")
