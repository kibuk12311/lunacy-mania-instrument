// Lunacy mania: Math.min / Math.max over an array of any length. Spreading 100 000+ values into one call overflows
// the stack (a 2-hour marathon has that many notes). A fold of the same pairwise Math.min / Math.max, so NaN, -0 and
// the empty case (Infinity / -Infinity) come out exactly as Math.min(...values) / Math.max(...values) would.
export function minOf(values) {
    let m = Infinity;
    for (let i = 0; i < values.length; i += 1) m = Math.min(m, values[i]);
    return m;
}

export function maxOf(values) {
    let m = -Infinity;
    for (let i = 0; i < values.length; i += 1) m = Math.max(m, values[i]);
    return m;
}
