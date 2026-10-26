// Which of several generated variants is best: in range first, then pattern accuracy (to 0.05), then the critic's
// score (to 0.25; only when both answers have one: wave 3, ML addendum §2.1), then fewer awkward spots, then a dan
// nearer the middle of the range. answers: generate-map answers (§2.3).
const numericOf = (a) => (a?.result?.kind === "ok" && Number.isFinite(a.result.numeric) ? a.result.numeric : null);
const CRITIC_STEP = 0.25;
const criticOf = (a) => (Number.isFinite(a?.critic?.score) ? Math.round(a.critic.score / CRITIC_STEP) : null);

export function rankVariants(list, range) {
    const key = (a) => {
        const r = range ?? a.range ?? null;
        const n = numericOf(a);
        const inside = r && n !== null ? n >= r.lo && n < r.hi : !!a.reachable;
        const mid = r ? (r.lo + r.hi) / 2 : n ?? 0;
        return {
            inside: inside ? 1 : 0,
            pattern: Math.round((Number(a.patternScore) || 0) / 0.05),
            critic: criticOf(a),
            issues: a.issues?.length ?? 0,
            off: n === null ? Infinity : Math.abs(n - mid),
        };
    };
    const byCritic = (x, y) => (x.critic !== null && y.critic !== null ? y.critic - x.critic : 0);
    return [...list]
        .map((a) => ({ a, k: key(a) }))
        .sort((x, y) => y.k.inside - x.k.inside || y.k.pattern - x.k.pattern || byCritic(x.k, y.k) || x.k.issues - y.k.issues || x.k.off - y.k.off)
        .map(({ a }) => a);
}
