// The MSD a map of some dan and pattern families usually has (ML addendum §2.1 stage 2, §4.5), and how far a
// generated map's MSD is from it. The prior lives in a model that carries it (xgb-v3, written by
// tools/train_mapper.py --msd-prior):
//   model.msdPrior = { bins: number[] (lower dan edges, 0..20), families: string[] (FAMILIES + "unknown"),
//                      msd?: string[] (the skillset order, default MSD8), table[bin][family] = number[8] (null entries) | null }
// Python's rule: a map of dan d lands in bin floor(d) clamped to the bins; a thin cell already holds its whole bin's
// median there, and a bin with too few maps is null.
//
//   msdPriorOf(model, danMid, families) → Float32Array(8) | null
//     families: names or { name, share } (shares weight the mix; names weigh the same). A family the prior does not
//     know uses the "unknown" column. Per skillset, the families' cells are mixed by weight over the cells that have
//     it; with none, the "unknown" column; a bin with nothing at all takes the nearest bin that has data (the lower
//     one on a tie). A skillset no cell has is NaN. No prior: null.
//   msdFit(msd, target) → −‖msd − target‖₂ / 3 over the skillsets both have, or null (either missing, or none shared)
//   msdVector(msd) → analyzeChart's result.msd ({ overall, stream, … }) or an 8-array → Float32Array(8) (NaN = missing)
export const MSD8 = ["overall", "stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"];
export const MSD_FIT_SCALE = 3;
const UNKNOWN = "unknown";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function msdVector(msd, names = MSD8) {
    if (!msd) return null;
    const get = Array.isArray(msd) || ArrayBuffer.isView(msd) ? (k) => msd[k] : (k) => msd[names[k]];
    return Float32Array.from({ length: names.length }, (_, k) => (finite(get(k)) ? get(k) : NaN));
}

// The table row of a dan: the last bin whose lower edge is at or below floor(dan), clamped to the first and last.
function binIndex(bins, dan) {
    const d = Math.floor(dan);
    if (!(d > bins[0])) return 0;
    let k = 0;
    while (k + 1 < bins.length && bins[k + 1] <= d) k += 1;
    return k;
}

const weightsOf = (families) => (Array.isArray(families) ? families : [])
    .map((f) => (typeof f === "string" ? { name: f, w: 1 } : { name: f?.name, w: finite(f?.share) ? Math.max(0, f.share) : 1 }))
    .filter((f) => typeof f.name === "string" && f.w > 0);

// One bin's mix → Float32Array, or null when no cell of it has any value.
function mixBin(prior, row, fams) {
    const n = (prior.msd ?? MSD8).length;
    const col = (name) => {
        const k = prior.families.indexOf(name);
        return k >= 0 ? k : prior.families.indexOf(UNKNOWN);
    };
    const cellOf = (k) => (k >= 0 && Array.isArray(row?.[k]) ? row[k] : null);
    const out = new Float32Array(n).fill(NaN);
    const unknown = cellOf(prior.families.indexOf(UNKNOWN));
    let any = false;
    for (let j = 0; j < n; j += 1) {
        let s = 0;
        let w = 0;
        for (const f of fams) {
            const v = cellOf(col(f.name))?.[j];
            if (finite(v)) {
                s += f.w * v;
                w += f.w;
            }
        }
        if (w > 0) out[j] = s / w;
        else if (finite(unknown?.[j])) out[j] = unknown[j];
        if (Number.isFinite(out[j])) any = true;
    }
    return any ? out : null;
}

export function msdPriorOf(model, danMid, families) {
    const prior = model?.msdPrior;
    if (!prior || !Array.isArray(prior.bins) || !prior.bins.length || !Array.isArray(prior.table) || !Array.isArray(prior.families)) return null;
    if (!finite(danMid)) return null;
    const fams = weightsOf(families);
    const list = fams.length ? fams : [{ name: UNKNOWN, w: 1 }];
    const k0 = binIndex(prior.bins, danMid);
    for (let step = 0; step < prior.bins.length; step += 1) {
        for (const k of step ? [k0 - step, k0 + step] : [k0]) {
            if (k < 0 || k >= prior.table.length) continue;
            const got = mixBin(prior, prior.table[k], list);
            if (got) return got;
        }
    }
    return null;
}

export function msdFit(msd, target) {
    if (!msd || !target) return null;
    let sq = 0;
    let n = 0;
    for (let k = 0; k < Math.min(msd.length, target.length); k += 1) {
        if (!Number.isFinite(msd[k]) || !Number.isFinite(target[k])) continue;
        const d = msd[k] - target[k];
        sq += d * d;
        n += 1;
    }
    if (!n) return null;
    return sq > 0 ? -Math.sqrt(sq) / MSD_FIT_SCALE : 0;
}
