// Shared math core for the Sunny and Daniel rework algorithms.
//
// Every function/constant in this file is TEXTUALLY IDENTICAL (whitespace and
// comments ignored) in js/rework/sunnyAlgorithm.js and js/rework/danielAlgorithm.js
// — extracted verbatim, never "improved". Both algorithms depend on the exact
// computation; any numeric/order change here silently changes both estimators.
// See docs/guides/module-conventions.md. Do NOT import this file from
// sunnyWindowAlgorithm.js yet (out of scope for the extraction PR).
//
// EXCEPTION since 042ccee (PR #47 C# osu-author-port sync): stepInterp and
// computeCAndKs are now used ONLY by danielAlgorithm — sunnyAlgorithm.js keeps
// local D1/D2 versions (stepInterp `<=`→`<` exact-match sampling; computeCAndKs
// gains CStepV2/noteHitTimesV2 for effectiveWeights) that differ from daniel's
// old semantics. Do NOT move them back into this shared core: sunny and daniel
// intentionally diverge here.
//
// Lunacy mania: our speed-ups (the cursors in smoothOnCorners, the helpers below that the two algorithms now call)
// are marked "Lunacy mania". Each gives exactly the numbers of the lines it replaces; tools/bench-analyze.mjs
// checks the results against the code before them.

// Graph-smoothing window constants — used only by smoothDForGraph below.
const BREAK_ZERO_THRESHOLD_MS = 400;
const GRAPH_RESAMPLE_INTERVAL_MS = 100;
const SMOOTH_SIGMA_MS = 800;

function bisectLeft(arr, target) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
    }
    return lo;
}

// Lunacy mania: bisectLeft(arr, q) for a loop whose queries mostly go up (notes in time order). A query not
// below the previous one walks on from the previous answer instead of searching from scratch; arr is sorted, so
// it lands on the same index. Any other query (or NaN) is a plain bisectLeft and leaves the cursor where it was.
function bisectLeftFrom(arr) {
    let at = 0;
    let last = -Infinity;
    return (q) => {
    if (!(q >= last)) return bisectLeft(arr, q);
    last = q;
    while (at < arr.length && arr[at] < q) at += 1;
    return at;
    };
}

function bisectRight(arr, target) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
    }
    return lo;
}

function cumulativeSum(x, f) {
    const F = new Float64Array(x.length);
    for (let i = 1; i < x.length; i += 1) {
    F[i] = F[i - 1] + f[i - 1] * (x[i] - x[i - 1]);
    }
    return F;
}

function queryCumsum(q, x, F, f) {
    if (q <= x[0]) return 0;
    if (q >= x[x.length - 1]) return F[F.length - 1];
    const i = bisectRight(x, q) - 1;
    return F[i] + f[i] * (q - x[i]);
}

// Lunacy mania: queryCumsum(q, x, F, f) for queries q that never go down, without its binary search: `at` is
// bisectRight(x, q) for the previous q, so it only moves forward over the sorted x and lands on the same index,
// giving the same value. A query below the previous one (never, from smoothOnCorners) takes queryCumsum.
function cumsumCursor(x, F, f) {
    const cursor = { at: 0, last: -Infinity };
    cursor.query = (q) => {
        if (!(q >= cursor.last)) return queryCumsum(q, x, F, f);
        cursor.last = q;
        if (q <= x[0]) return 0;
        if (q >= x[x.length - 1]) return F[F.length - 1];
        let at = cursor.at;
        while (at < x.length && x[at] <= q) at += 1;
        cursor.at = at;
        const i = at - 1;
        return F[i] + f[i] * (q - x[i]);
    };
    return cursor;
}

function smoothOnCorners(x, f, window, scale = 1.0, mode = "sum") {
    const F = cumulativeSum(x, f);
    const g = new Float64Array(f.length);
    // Lunacy mania: a and b grow with s over the sorted corners; see cumsumCursor.
    const qa = cumsumCursor(x, F, f);
    const qb = cumsumCursor(x, F, f);
    for (let i = 0; i < x.length; i += 1) {
    const s = x[i];
    const a = Math.max(s - window, x[0]);
    const b = Math.min(s + window, x[x.length - 1]);
    const val = qb.query(b) - qa.query(a);
    if (mode === "avg") {
            g[i] = b - a > 0 ? val / (b - a) : 0;
    } else {
            g[i] = scale * val;
    }
    }
    return g;
}

function interpValues(newX, oldX, oldVals) {
    const out = new Float64Array(newX.length);
    let idx = 0;

    for (let i = 0; i < newX.length; i += 1) {
    const x = newX[i];

    if (x <= oldX[0]) {
        out[i] = oldVals[0];
        continue;
    }
    if (x >= oldX[oldX.length - 1]) {
        out[i] = oldVals[oldVals.length - 1];
        continue;
    }

    while (idx + 1 < oldX.length && oldX[idx + 1] < x) {
        idx += 1;
    }

    const x0 = oldX[idx];
    const x1 = oldX[idx + 1];
    const y0 = oldVals[idx];
    const y1 = oldVals[idx + 1];

    if (x1 === x0) {
        out[i] = y0;
        continue;
    }

    const t = (x - x0) / (x1 - x0);
    out[i] = y0 + t * (y1 - y0);
    }

    return out;
}

function stepInterp(newX, oldX, oldVals) {
    const out = new Float64Array(newX.length);
    let idx = 0;
    for (let i = 0; i < newX.length; i += 1) {
    const x = newX[i];
    while (idx + 1 < oldX.length && oldX[idx + 1] <= x) {
        idx += 1;
    }
    const clamped = Math.max(0, Math.min(idx, oldVals.length - 1));
    out[i] = oldVals[clamped];
    }
    return out;
}

function gaussianFilter1d(data, sigmaSamples) {
    if (!Number.isFinite(sigmaSamples) || sigmaSamples <= 0) {
    return Array.from(data);
    }

    const radius = Math.max(1, Math.trunc(4 * sigmaSamples + 0.5));
    const kernelSize = radius * 2 + 1;
    const kernel = new Float64Array(kernelSize);
    let kernelSum = 0;

    for (let i = -radius; i <= radius; i += 1) {
    const v = Math.exp(-0.5 * ((i / sigmaSamples) ** 2));
    kernel[i + radius] = v;
    kernelSum += v;
    }
    for (let i = 0; i < kernelSize; i += 1) {
    kernel[i] /= kernelSum;
    }

    const padded = new Float64Array(data.length + radius * 2);
    for (let i = 0; i < data.length; i += 1) {
    padded[i + radius] = data[i];
    }

    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
    let acc = 0;
    for (let k = 0; k < kernelSize; k += 1) {
        acc += padded[i + k] * kernel[k];
    }
    out[i] = acc;
    }
    return Array.from(out);
}

function rescaleHigh(sr) {
    if (sr <= 9) return sr;
    return 9 + (sr - 9) * (1 / 1.2);
}

// Lunacy mania: a getCorners list, [...new Set(the times, each time + every non-zero offset, 0 and T)]
// .filter((s) => s >= 0 && s <= T).sort((a, b) => a - b), as a merge: the distinct times sorted once, one
// ascending stream per offset (0 among them: the times themselves), merged without repeats between 0 and T. The
// same numbers in the same order. Returns null if a time is NaN or −0 (a Set keeps the first zero it is given,
// which could then be −0), where getCorners keeps its original lines.
function cornerUnion(times, offsets, T) {
    const sorted = new Float64Array(times.length);
    for (let i = 0; i < times.length; i += 1) {
    const s = times[i];
    if (typeof s !== "number" || s !== s || (s === 0 && 1 / s < 0)) return null;
    sorted[i] = s;
    }
    sorted.sort();
    let n = 0;
    for (let i = 0; i < sorted.length; i += 1) {
    if (n === 0 || sorted[i] !== sorted[n - 1]) sorted[n++] = sorted[i];
    }
    if (!(T >= 0)) return [];
    const out = [0];
    let last = 0;
    const at = new Int32Array(offsets.length);
    for (;;) {
    let which = -1;
    let best = 0;
    for (let j = 0; j < offsets.length; j += 1) {
            if (at[j] >= n) continue;
            const v = sorted[at[j]] + offsets[j];
            if (which < 0 || v < best) {
        which = j;
        best = v;
            }
    }
    if (which < 0 || best >= T) break;
    at[which] += 1;
    if (best > last) {
            out.push(best);
            last = best;
    }
    }
    if (T !== last) out.push(T);
    return out;
}

// Lunacy mania: [...new Set([...a, ...b])].sort((x, y) => x - y) for two sorted lists without duplicates (or
// NaN): a merge that keeps a's copy of a number both hold, as the Set keeps the first one it is given.
function mergeSortedUnique(a, b) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) out.push(a[i++]);
    else if (i >= a.length || b[j] < a[i]) out.push(b[j++]);
    else {
            out.push(a[i++]);
            j += 1;
    }
    }
    return out;
}

// Lunacy mania: values.map((_, i) => i).sort((a, b) => values[a] - values[b]) without a comparator call per
// comparison. That sort is stable, so with no NaN among the values its order is the only one: ascending values,
// equal ones (+0 and −0, or two infinities, alike) by index. A stable LSD radix sort of the indexes by the values'
// bits (made unsigned-ordered: sign bit set on positives, all bits flipped on negatives; −0 read as +0) gives
// exactly that order. With a NaN the comparator is inconsistent, so the original line runs; it also runs for short
// lists, where it is the cheaper of the two.
const ARGSORT_BITS = new Float64Array(1);
const ARGSORT_WORDS = new Uint32Array(ARGSORT_BITS.buffer);
const ARGSORT_HI = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 1 : 0;

function stableArgsort(values) {
    const n = values.length;
    if (n < 4096) return values.map((_, j) => j).sort((a, b) => values[a] - values[b]);
    const hi = new Uint32Array(n);
    const lo = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (typeof v !== "number" || v !== v) return values.map((_, j) => j).sort((a, b) => values[a] - values[b]);
    ARGSORT_BITS[0] = v === 0 ? 0 : v;
    const h = ARGSORT_WORDS[ARGSORT_HI];
    const l = ARGSORT_WORDS[1 - ARGSORT_HI];
    if (h >>> 31) {
            hi[i] = ~h >>> 0;
            lo[i] = ~l >>> 0;
    } else {
            hi[i] = (h | 0x80000000) >>> 0;
            lo[i] = l;
    }
    }
    let order = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) order[i] = i;
    let next = new Uint32Array(n);
    const count = new Int32Array(65536);
    for (let pass = 0; pass < 4; pass += 1) {
    const words = pass < 2 ? lo : hi;
    const shift = pass % 2 === 0 ? 0 : 16;
    count.fill(0);
    for (let i = 0; i < n; i += 1) count[(words[i] >>> shift) & 0xffff] += 1;
    if (count[(words[0] >>> shift) & 0xffff] === n) continue; // one digit for all: this pass keeps the order
    let sum = 0;
    for (let d = 0; d < 65536; d += 1) {
            const c = count[d];
            count[d] = sum;
            sum += c;
    }
    for (let i = 0; i < n; i += 1) {
            const index = order[i];
            next[count[(words[index] >>> shift) & 0xffff]++] = index;
    }
    [order, next] = [next, order];
    }
    return Array.from(order);
}

// Lunacy mania: computeAnchor's counts for corner idx, new Array(K).fill(0).map((_, k) => keyUsage400[k][idx])
// sorted with (a, b) => b - a and filtered with `keep`, written into `into` (length K, reused for every corner)
// instead of three new arrays and a sort per corner; returns how many were kept. An insertion sort puts them in
// that same order whenever no count is NaN (equal counts are the same number). With a NaN the comparator is
// inconsistent, so the original lines run and their result is copied into `into`.
function sortedCornerCounts(keyUsage400, K, idx, into, keep) {
    for (let k = 0; k < K; k += 1) {
    const v = keyUsage400[k][idx];
    if (typeof v !== "number" || v !== v) {
            const counts = new Array(K).fill(0).map((_, j) => keyUsage400[j][idx]);
            counts.sort((a, b) => b - a);
            const kept = counts.filter(keep);
            for (let i = 0; i < kept.length; i += 1) into[i] = kept[i];
            return kept.length;
    }
    let i = k - 1;
    while (i >= 0 && into[i] < v) {
            into[i + 1] = into[i];
            i -= 1;
    }
    into[i + 1] = v;
    }
    let n = 0;
    for (let k = 0; k < K; k += 1) {
    if (keep(into[k])) into[n++] = into[k];
    }
    return n;
}

function mergeByHead(a, b) {
    const result = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
    if (a[i][1] <= b[j][1]) {
            result.push(a[i]);
            i += 1;
    } else {
            result.push(b[j]);
            j += 1;
    }
    }
    while (i < a.length) {
    result.push(a[i]);
    i += 1;
    }
    while (j < b.length) {
    result.push(b[j]);
    j += 1;
    }
    return result;
}

function computeCAndKs(K, noteSeq, keyUsage, baseCorners) {
    const noteHitTimes = noteSeq.map((n) => n[1]).sort((a, b) => a - b);

    const CStep = new Float64Array(baseCorners.length);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < baseCorners.length; i += 1) {
    const s = baseCorners[i];
    const low = s - 500;
    const high = s + 500;

    while (lo < noteHitTimes.length && noteHitTimes[lo] < low) {
            lo += 1;
    }
    while (hi < noteHitTimes.length && noteHitTimes[hi] < high) {
            hi += 1;
    }

    CStep[i] = hi - lo;
    }

    const KsStep = new Float64Array(baseCorners.length);
    for (let i = 0; i < baseCorners.length; i += 1) {
    let count = 0;
    for (let k = 0; k < K; k += 1) {
            if (keyUsage[k][i]) count += 1;
    }
    KsStep[i] = Math.max(count, 1);
    }

    return { CStep, KsStep };
}

function applyProximityEnvelope(allCorners, DAll, noteSeq) {
    if (!noteSeq.length) {
    return Array.from(DAll);
    }

    const noteTimes = noteSeq
    .map((n) => Number(n[1]))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

    if (!noteTimes.length) {
    return Array.from(DAll);
    }

    const proximityFadeMs = 500;
    const out = new Float64Array(allCorners.length);
    for (let i = 0; i < allCorners.length; i += 1) {
    const t = allCorners[i];
    const idx = bisectLeft(noteTimes, t);
    const after = idx < noteTimes.length ? Math.abs(noteTimes[idx] - t) : Number.POSITIVE_INFINITY;
    const before = idx > 0 ? Math.abs(noteTimes[idx - 1] - t) : Number.POSITIVE_INFINITY;
    const d = Math.min(after, before);
    const ratio = Math.max(0, Math.min(d / proximityFadeMs, 1));
    const envelope = 0.5 * (1 + Math.cos(Math.PI * ratio));
    out[i] = DAll[i] * envelope;
    }
    return Array.from(out);
}

function smoothDForGraph(allCorners, DAll, noteSeq) {
    if (!allCorners.length || !DAll.length) {
    return [];
    }

    const tStart = allCorners[0];
    const tEnd = allCorners[allCorners.length - 1];
    const uniformTimes = [];
    for (let t = tStart; t <= tEnd + GRAPH_RESAMPLE_INTERVAL_MS; t += GRAPH_RESAMPLE_INTERVAL_MS) {
    uniformTimes.push(t);
    }

    const noteTimes = noteSeq
    .map((n) => Number(n[1]))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

    const uniformD = interpValues(uniformTimes, allCorners, DAll);

    if (noteTimes.length) {
    for (let i = 0; i < uniformTimes.length; i += 1) {
            const t = uniformTimes[i];
            const idx = bisectLeft(noteTimes, t);
            const after = idx < noteTimes.length ? Math.abs(noteTimes[idx] - t) : Number.POSITIVE_INFINITY;
            const before = idx > 0 ? Math.abs(noteTimes[idx - 1] - t) : Number.POSITIVE_INFINITY;
            const dist = Math.min(after, before);
            if (dist > BREAK_ZERO_THRESHOLD_MS) {
        uniformD[i] = 0;
            }
    }
    }

    const sigmaSamples = SMOOTH_SIGMA_MS / GRAPH_RESAMPLE_INTERVAL_MS;
    const smoothed = gaussianFilter1d(uniformD, sigmaSamples);

    if (noteTimes.length) {
    for (let i = 0; i < uniformTimes.length; i += 1) {
            const t = uniformTimes[i];
            const idx = bisectLeft(noteTimes, t);
            const after = idx < noteTimes.length ? Math.abs(noteTimes[idx] - t) : Number.POSITIVE_INFINITY;
            const before = idx > 0 ? Math.abs(noteTimes[idx - 1] - t) : Number.POSITIVE_INFINITY;
            const dist = Math.min(after, before);
            if (dist > BREAK_ZERO_THRESHOLD_MS) {
        smoothed[i] = 0;
            }
    }
    }

    return Array.from(interpValues(allCorners, uniformTimes, smoothed));
}

const jackNerfer = (delta) => 1 - 7e-5 * ((0.15 + Math.abs(delta - 0.08)) ** (-4));

const targetPercentiles = [0.945, 0.935, 0.925, 0.915, 0.845, 0.835, 0.825, 0.815];

export {
    bisectLeft,
    bisectLeftFrom,
    bisectRight,
    cumulativeSum,
    queryCumsum,
    smoothOnCorners,
    interpValues,
    stepInterp,
    gaussianFilter1d,
    rescaleHigh,
    mergeByHead,
    cornerUnion,
    mergeSortedUnique,
    stableArgsort,
    sortedCornerCounts,
    computeCAndKs,
    applyProximityEnvelope,
    smoothDForGraph,
    jackNerfer,
    targetPercentiles
};
