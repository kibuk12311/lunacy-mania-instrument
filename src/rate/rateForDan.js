// The rate at which a chart reaches a target dan: a binary search over a rate grid (dan is taken to grow with
// the rate), the best of all tries wins. Used by the rate tab (step 0.01) and the auto-marathon (step 0.05).
const round2 = (x) => Math.round(x * 100) / 100;
const EPS = 1e-9;

export async function rateForDan({
    analyze, osuText, target, min = 0.5, max = 2, step = 0.05, tolerance = 0.05,
    maxTries = 10, isCancelled = () => false, onTry = () => {},
}) {
    const tries = []; // every analysis, a failed one with numeric null
    const probes = []; // the ones that gave a dan
    let cancelled = false;

    async function probe(rate) {
        if (isCancelled()) {
            cancelled = true;
            return null;
        }
        let result;
        try {
            result = await analyze(osuText, rate);
        } catch (error) {
            result = { kind: "error", message: String(error?.message ?? error) };
        }
        const numeric = result?.kind === "ok" && Number.isFinite(result.numeric) ? result.numeric : null;
        tries.push({ rate, numeric });
        onTry({ rate, numeric });
        const p = { rate, numeric, result };
        if (numeric !== null) probes.push(p);
        return p;
    }

    const within = (n) => Math.abs(n - target) <= tolerance + EPS;
    // closest to the target; a tie goes to the rate nearer 1.0
    const best = () => probes.reduce((a, b) => {
        const da = Math.abs(a.numeric - target);
        const db = Math.abs(b.numeric - target);
        if (Math.abs(da - db) > EPS) return db < da ? b : a;
        return Math.abs(b.rate - 1) < Math.abs(a.rate - 1) ? b : a;
    });
    let base = null;
    const answer = (p, reason, reached) => ({
        ok: true, rate: p.rate, numeric: p.numeric, label: p.result.label, primary: p.result.primary ?? null,
        result: p.result, base: base.result, reached, tries, reason,
    });
    const settle = (reached) => {
        const p = best();
        return answer(p, within(p.numeric) ? "hit" : "closest", reached);
    };
    const stopped = () => ({ ok: false, reason: "cancelled", result: probes.length ? best().result : null });

    base = await probe(1);
    if (cancelled) return stopped();
    if (base.numeric === null) return { ok: false, reason: "base-failed", result: base.result };
    if (within(base.numeric)) return settle(true);

    const dir = target > base.numeric ? 1 : -1;
    const reaches = (n) => (dir > 0 ? n >= target : n <= target);
    const outOfRange = dir > 0 ? "above-range" : "below-range";
    const count = Math.max(0, Math.floor(((dir > 0 ? max : min) - 1) * dir / step + EPS));
    const grid = Array.from({ length: count + 1 }, (_, i) => round2(1 + dir * i * step)); // grid[0] is 1.0
    if (count === 0) return answer(base, outOfRange, false);

    // The far end first; when its analysis fails, one step inward, at most twice.
    const failed = new Set();
    let hi = null;
    for (let i = count; i >= Math.max(1, count - 2) && tries.length < maxTries; i -= 1) {
        const p = await probe(grid[i]);
        if (cancelled) return stopped();
        if (p.numeric === null) {
            failed.add(i);
            continue;
        }
        if (within(p.numeric)) return settle(true);
        if (!reaches(p.numeric)) return answer(p, outOfRange, false);
        hi = i;
        break;
    }
    if (hi === null) return settle(false); // the range could not be measured

    // First rate that reaches the target, between 1.0 (does not) and hi (does); a failed rate is left out.
    let lo = 0;
    while (tries.length < maxTries) {
        const open = [];
        for (let i = lo + 1; i < hi; i += 1) if (!failed.has(i)) open.push(i);
        if (!open.length) break;
        const i = open[Math.floor(open.length / 2)];
        const p = await probe(grid[i]);
        if (cancelled) return stopped();
        if (p.numeric === null) {
            failed.add(i);
            continue;
        }
        if (within(p.numeric)) return settle(true);
        if (reaches(p.numeric)) hi = i;
        else lo = i;
    }
    return settle(true);
}
