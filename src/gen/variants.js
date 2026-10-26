// Which of several generated variants is best: in range first, then pattern accuracy (to 0.05), then fewer
// awkward spots, then a dan nearer the middle of the range. answers: generate-map answers (§2.3).
const numericOf = (a) => (a?.result?.kind === "ok" && Number.isFinite(a.result.numeric) ? a.result.numeric : null);

export function rankVariants(list, range) {
    const key = (a) => {
        const r = range ?? a.range ?? null;
        const n = numericOf(a);
        const inside = r && n !== null ? n >= r.lo && n < r.hi : !!a.reachable;
        const mid = r ? (r.lo + r.hi) / 2 : n ?? 0;
        return {
            inside: inside ? 1 : 0,
            pattern: Math.round((Number(a.patternScore) || 0) / 0.05),
            issues: a.issues?.length ?? 0,
            off: n === null ? Infinity : Math.abs(n - mid),
        };
    };
    return [...list]
        .map((a) => ({ a, k: key(a) }))
        .sort((x, y) => y.k.inside - x.k.inside || y.k.pattern - x.k.pattern || x.k.issues - y.k.issues || x.k.off - y.k.off)
        .map(({ a }) => a);
}
