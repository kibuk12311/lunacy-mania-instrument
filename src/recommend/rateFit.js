// Our analysis of a recommended map, plus the rate that moves it to the centre of the goal.
import { numericToLabel } from "../core/labels.js";
import { t } from "../i18n/i18n.js";

const round2 = (x) => Math.round(x * 100) / 100;

function failMessage(result) {
    if (result?.kind === "not-rice") return t("core.rateFit.notRice");
    if (result?.kind === "too-short") return t("core.rateFit.tooShort");
    return String(result?.message || t("core.rateFit.failed"));
}

export async function suggestRate({ analyze, osuText, trackerDan, center, min = 0.75, max = 1.6, step = 0.05 }) {
    let base;
    try {
        base = await analyze(osuText, 1);
    } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
    }
    if (base?.kind !== "ok") return { ok: false, message: failMessage(base) };

    const ours = { label: base.label, numeric: base.numeric, primary: base.primary ?? null };
    // The rate label is read from the tracker's dan shifted by how much our dan moved.
    const done = (rate, shift, reason) => ({
        ok: true, ours, rate, rateLabel: rate === null ? null : numericToLabel(trackerDan + shift).text, reason,
    });
    const need = round2(center - trackerDan);
    if (!Number.isFinite(need) || !Number.isFinite(base.numeric)) return done(null, 0, null);
    if (Math.abs(need) < 0.1) return done(null, 0, "in-target");

    // Grid from 1.0x toward the goal: [1, 1.05, …, max] or [1, 0.95, …, min].
    const dir = Math.sign(need);
    const rates = [1];
    for (let k = 1; ; k++) {
        const r = round2(1 + dir * k * step);
        if (r > max + 1e-9 || r < min - 1e-9) break;
        rates.push(r);
    }
    const want = Math.abs(need);
    const last = rates.length - 1;
    if (last === 0) return done(null, 0, "out-of-range");

    // gain(i): how far rates[i] moves our dan toward the goal; assumed to grow with i.
    const gains = new Map([[0, 0]]);
    async function gain(i) {
        if (!gains.has(i)) {
            let r = null;
            try { r = await analyze(osuText, rates[i]); } catch { /* counted as a failed rate */ }
            gains.set(i, r?.kind === "ok" && Number.isFinite(r.numeric) ? round2(dir * (r.numeric - base.numeric)) : null);
        }
        return gains.get(i);
    }

    const edge = await gain(last);
    if (edge === null) return done(null, 0, null);
    if (edge < want) return done(rates[last], dir * edge, "out-of-range");

    // Binary search for the first rate that reaches the goal, then take the closer of it and the one before
    // (1.0x included: one step can overshoot the centre by more than the map is off it; on a tie the rate nearer 1.0x wins).
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const g = await gain(mid);
        if (g === null) return done(null, 0, null);
        if (g >= want) hi = mid;
        else lo = mid;
    }
    const pick = want - gains.get(lo) <= gains.get(hi) - want ? lo : hi;
    if (pick === 0) return done(null, 0, "in-target");
    return done(rates[pick], dir * gains.get(pick), null);
}
