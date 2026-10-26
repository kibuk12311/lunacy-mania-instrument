// Training weights for the 4K rice corpus (mapgen v3 ML addendum §3.2 "Weights", §9 "Etterna charts differ in style"):
//
//   w = source · 1/sqrt(diffs in the song group) · min(1, 0.03 / packShare) · min(1, 0.02 / creatorShare)
//       · min(1, 2 · median_bin / bin)
//
// - source: osu! ranked/loved charts count fully; other osu! charts a little less; Etterna and Malody converts (dumps,
//   keyboard conventions) half. The table is a parameter so the E4 ablation can try others.
// - packShare / creatorShare: the share of the total weight held by the chart's pack / creator. A chart without a pack
//   (most osu! sets) or without a known creator (converts) is not capped there.
// - bin: the total weight of the chart's dan bin; median_bin is the median over the bins (a missing or "none" bin is
//   not capped).
// Capping one pack raises every other share a little, so the caps are applied again until all of them hold (a fixed
// point, reached in a handful of rounds). When they cannot all hold — say every chart sits in 3 packs — the rounds stop
// with the capped groups at equal shares and `capsHeld: false`. Weights are scaled to a mean of 1.
// Pure: no I/O. Used by tools/corpus-index.mjs (the index's `weight`) and tools/build-mapper-dataset.mjs (mapper3).

export const SOURCE_WEIGHT = Object.freeze({ ranked: 1, hf: 1, sets: 0.85, songs: 0.85, packs: 0.85, etterna: 0.5, malody: 0.5 });
export const WEIGHT_CAPS = Object.freeze({ pack: 0.03, creator: 0.02, bin: 2 });

const MAX_ROUNDS = 200;
const TOL = 1e-3;

// Ranked / loved anywhere (HF, the ranked archive, or an .osu whose md5 is a ranked difficulty) counts as ranked.
export function sourceWeight(item, table = SOURCE_WEIGHT) {
    if (item.ranked && table.ranked !== undefined) return table.ranked;
    return table[item.source] ?? 1;
}

// The pack a chart belongs to, for the pack cap: the Etterna pack id, the Malody zip, the Drive / Dan Reform pack
// (the folder prefix the fetchers write, "<pack> - <set>"), or a pack-like osu! set ("Various Artists - X Pack").
// A plain osu! set is no pack: its song group already carries the per-song weight.
export function packKeyOf({ source, folder = "", packId = null, packLike = false, beatmapSetId = null }) {
    const f = String(folder ?? "");
    if (source === "etterna") {
        const id = packId ?? /^(\d+)\s/.exec(f)?.[1] ?? null;
        return id === null ? null : `etterna:${id}`;
    }
    if (source === "malody") {
        const zip = /^(mal-[\w-]+?)\s/.exec(f)?.[1] ?? f.split(" ")[0];
        return zip ? `malody:${zip}` : null;
    }
    if (source === "packs") {
        const name = f.includes(" - ") ? f.slice(0, f.indexOf(" - ")) : f;
        return name ? `packs:${name.trim().toLowerCase()}` : null;
    }
    if (packLike) return `set:${beatmapSetId ?? f}`;
    return null;
}

// name (lower-case, trimmed) → osu! user id, from metadata.csv rows { creator, creatorId }.
export function creatorIdsFromMeta(rows) {
    const byName = new Map();
    for (const r of rows) {
        const name = String(r.creator ?? "").trim().toLowerCase();
        const id = Number(r.creatorId);
        if (name && Number.isFinite(id) && id > 0 && !byName.has(name)) byName.set(name, id);
    }
    return byName;
}

// The creator a chart is capped under (and the style key of addendum §2.6): "u:<osu! user id>" — the chart's own
// creator id (metadata.csv row of this difficulty) when known, else the id metadata.csv gives the name (renamed users
// merge) — else "n:<name>". Etterna and Malody converts carry difficulty names or pack authors in that field: no
// creator. Every consumer (weights, styles, the critic's per-creator caps) reads the corpus line's `creatorKey`.
export function creatorKeyOf({ source, creator, creatorId = null }, idsByName = new Map()) {
    if (source === "etterna" || source === "malody") return null;
    const own = Number(creatorId);
    if (Number.isFinite(own) && own > 0) return `u:${own}`;
    const name = String(creator ?? "").trim().toLowerCase();
    if (!name) return null;
    const id = idsByName.get(name);
    return id ? `u:${id}` : `n:${name}`;
}

const capped = (k) => k !== null && k !== undefined && k !== "" && k !== "none";

// items: [{ group, source, ranked?, pack?, creator?, bin? }] → { weights: Float64Array (mean 1), capsHeld, rounds, stats }.
export function corpusWeights(items, { sources = SOURCE_WEIGHT, caps = WEIGHT_CAPS } = {}) {
    const n = items.length;
    const weights = new Float64Array(n);
    if (!n) return { weights, capsHeld: true, rounds: 0, stats: { maxPackShare: 0, maxCreatorShare: 0, maxBinRatio: 0 } };
    const groupSize = new Map();
    for (const it of items) groupSize.set(it.group, (groupSize.get(it.group) ?? 0) + 1);
    const base = Float64Array.from(items, (it) => sourceWeight(it, sources) / Math.sqrt(groupSize.get(it.group)));
    const factor = { pack: new Map(), creator: new Map(), bin: new Map() };
    const keyOf = { pack: (it) => it.pack, creator: (it) => it.creator, bin: (it) => it.bin };
    const f = (kind, it) => { const k = keyOf[kind](it); return capped(k) ? (factor[kind].get(k) ?? 1) : 1; };
    const sumsBy = (kind) => {
        const m = new Map();
        items.forEach((it, i) => { const k = keyOf[kind](it); if (capped(k)) m.set(k, (m.get(k) ?? 0) + weights[i]); });
        return m;
    };
    let held = false;
    let rounds = 0;
    let stats = null;
    // Excess over the caps; when a round does not shrink it (say one creator holds everything, or every chart sits in
    // 3 packs) the caps cannot hold: stop there instead of shrinking those factors towards 0.
    let lastExcess = Infinity;
    let stalls = 0;
    for (; rounds < MAX_ROUNDS; rounds++) {
        let total = 0;
        for (let i = 0; i < n; i++) {
            const it = items[i];
            weights[i] = base[i] * f("pack", it) * f("creator", it) * f("bin", it);
            total += weights[i];
        }
        let changed = false;
        let excess = 0;
        stats = { maxPackShare: 0, maxCreatorShare: 0, maxBinRatio: 0 };
        for (const kind of ["pack", "creator"]) {
            const cap = caps[kind];
            const stat = kind === "pack" ? "maxPackShare" : "maxCreatorShare";
            for (const [k, s] of sumsBy(kind)) {
                const share = s / total;
                stats[stat] = Math.max(stats[stat], share);
                if (share > cap * (1 + TOL)) {
                    factor[kind].set(k, (factor[kind].get(k) ?? 1) * (cap / share));
                    excess += share - cap;
                    changed = true;
                }
            }
        }
        const bins = sumsBy("bin");
        if (bins.size > 1) {
            const sorted = [...bins.values()].sort((a, b) => a - b);
            const median = sorted[Math.floor((sorted.length - 1) / 2)];
            const limit = caps.bin * median;
            for (const [k, s] of bins) {
                stats.maxBinRatio = Math.max(stats.maxBinRatio, s / median);
                if (s > limit * (1 + TOL)) {
                    factor.bin.set(k, (factor.bin.get(k) ?? 1) * (limit / s));
                    excess += (s - limit) / total;
                    changed = true;
                }
            }
        }
        if (!changed) { held = true; break; }
        if (excess >= lastExcess * (1 - 1e-6)) { if (++stalls >= 3) break; } else stalls = 0;
        lastExcess = excess;
    }
    let total = 0;
    for (let i = 0; i < n; i++) total += weights[i];
    if (!(total > 0) || !Number.isFinite(total)) weights.fill(1);
    else for (let i = 0; i < n; i++) weights[i] = (weights[i] * n) / total;
    return { weights, capsHeld: held, rounds, stats };
}
