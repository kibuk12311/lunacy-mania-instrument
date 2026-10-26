// Closed-loop dan targeting (0.9.8): the learned generator's own search only moves one density knob inside fixed
// limits (knob ≤ 1, 1/4 grid unless asked, the family's own chord sizes, the light parts held down), so a hard request
// came out at dan 3–7 whatever was asked. Here a map that fell short of its range is made again on the rungs of
// BOOST_LADDER, each lifting more of those limits (generateLearned.js opts.boost), until the analysed dan is in the
// range or the time budget is spent; the closest map wins. A map that is still short reports the song's ceiling: the
// dan it reached and the rate at which that map would reach the request (the analyser at that rate), for the window's
// «для этой песни максимум ≈ … — попробуй рейт».
// generate(boost) → the generator's response (boost null: the plain request); analyze(osuText, rate) → result.

// knobMax: the density knob's top (plain: 1); contrast: × the light parts' push-down; chord: log-weight per extra note
// of a row; danLift: added to the dan the model is conditioned on; snaps: grids allowed beside the request's; denser:
// the grid choice leans towards the finer grids.
export const BOOST_LADDER = Object.freeze([
    Object.freeze({ rung: 1, knobMax: 3, contrast: 0.5, chord: 0.5, danLift: 0.5, snaps: Object.freeze([8]), denser: false }),
    Object.freeze({ rung: 2, knobMax: 5, contrast: 0.25, chord: 1, danLift: 1.5, snaps: Object.freeze([8, 6, 3]), denser: true }),
    Object.freeze({ rung: 3, knobMax: 8, contrast: 0, chord: 1.6, danLift: 3, snaps: Object.freeze([8, 6, 3]), denser: true }),
]);
// a map that came out too hard (over the range by SOFTEN_OVER or more) is made once more lighter: a lower knob, fewer
// chords, the model conditioned lower, the light parts held down more
export const SOFTEN = Object.freeze({ rung: -1, knobMin: -12, contrast: 1.5, chord: -0.8, danLift: -1.5 });
const SOFTEN_OVER = 0.5;
export const DEFAULT_TARGET_BUDGET_MS = 30000;
// how far short the plain map is → the first rung tried (a map far short skips the gentle rungs)
const RUNG_BY_GAP = [[1.5, 0], [4, 1], [Infinity, 2]];
// the rates the ceiling note may suggest (the rate tab's ladder)
export const SUGGEST_RATES = Object.freeze([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0]);

const numericOf = (r) => (r?.result?.kind === "ok" && Number.isFinite(r.result.numeric) ? r.result.numeric : null);
const inside = (n, range) => n !== null && n >= range.lo && n < range.hi;
// how far a dan is from the range (0 inside)
export function rangeGap(n, range) {
    if (n === null) return Infinity;
    if (n < range.lo) return range.lo - n;
    if (n >= range.hi) return n - range.hi;
    return 0;
}

export function firstRung(gap) {
    return RUNG_BY_GAP.find(([upTo]) => gap <= upTo)[1];
}

// The lowest SUGGEST_RATES rate at which the map's dan reaches the middle of the range, or null (none up to 2.0x or
// no analyser).
export async function suggestRate(osuText, range, analyze) {
    if (!osuText || typeof analyze !== "function") return null;
    const want = Math.max(range.lo, (range.lo + range.hi) / 2 - 0.2);
    for (const rate of SUGGEST_RATES) {
        const r = await analyze(osuText, rate).catch(() => null);
        if (r?.kind === "ok" && Number.isFinite(r.numeric) && r.numeric >= want) return { rate, numeric: r.numeric };
    }
    return null;
}

// Halfway (w = 0.5) between two rungs, for when one fell short and the next went over: every number blended, the
// grids and the lean of the denser one.
export function blendBoost(a, b, w = 0.5) {
    const lo = a ?? { rung: 0, knobMax: 1, contrast: 1, chord: 0, danLift: 0 };
    const mix = (k, d) => (lo[k] ?? d) * (1 - w) + (b[k] ?? d) * w;
    return {
        rung: Math.round((lo.rung + b.rung) * 50) / 100, knobMax: mix("knobMax", 1), contrast: mix("contrast", 1), chord: mix("chord", 0),
        danLift: mix("danLift", 0), ...(b.snaps ? { snaps: b.snaps } : {}), denser: Boolean(b.denser && lo.denser),
    };
}

// → the chosen response plus targeting: { attempts: [{ rung, numeric, ms }], rung (0 = plain, −1 = softened, a half
// rung when blended) } and, when the map is still short of the range, ceiling: { numeric, rate, rateNumeric } (rate
// null when no rate up to 2.0x reaches it; only after the top rung was tried and no try went over the range). range null (a single target) or a map in range: the plain answer,
// unchanged but for `targeting`. Each try after the first must fit what is left of budgetMs (judged by the last one).
export async function generateToTarget({ generate, range, analyze = null, budgetMs = DEFAULT_TARGET_BUDGET_MS, now = () => performance.now(), onRung = null }) {
    const started = now();
    const attempts = [];
    const run = async (boost) => {
        const t0 = now();
        const response = await generate(boost);
        attempts.push({ rung: boost?.rung ?? 0, numeric: numericOf(response), ms: Math.round(now() - t0) });
        return response;
    };
    const plain = await run(null);
    const done = (best, extra = {}) => ({ ...best, targeting: { attempts, rung: best.boost?.rung ?? 0 }, ...extra });
    const n0 = numericOf(plain);
    if (!range || n0 === null || inside(n0, range)) return done(plain);
    // the next try must fit the budget (a boosted try takes about as long as the one before)
    const fits = () => now() - started + attempts.at(-1).ms <= budgetMs;
    let best = plain;
    let bestGap = rangeGap(n0, range);
    const consider = (r) => {
        const gap = rangeGap(numericOf(r), range);
        if (gap < bestGap) {
            best = r;
            bestGap = gap;
        }
    };
    if (n0 >= range.hi) {
        if (n0 >= range.hi + SOFTEN_OVER && fits()) {
            onRung?.(SOFTEN);
            consider(await run(SOFTEN));
        }
        return done(best);
    }

    let below = null; // the strongest rung that still fell short (null: the plain map)
    for (let k = firstRung(bestGap); k < BOOST_LADDER.length && fits(); k += 1) {
        const rung = BOOST_LADDER[k];
        onRung?.(rung);
        const r = await run(rung);
        consider(r);
        const n = numericOf(r);
        if (inside(n, range)) break;
        if (n !== null && n >= range.hi) {
            // over the range: once halfway between this rung and the one that fell short
            if (fits()) {
                const half = blendBoost(below, rung);
                onRung?.(half);
                consider(await run(half));
            }
            break;
        }
        below = rung;
    }
    const n = numericOf(best);
    if (inside(n, range) || (n !== null && n >= range.hi)) return done(best);
    // a ceiling only when it is one: the top rung was tried and no try went over the range (a budget that ran out
    // early, or a rung over the range with the half below it, says nothing about what the song allows)
    const top = BOOST_LADDER.at(-1).rung;
    const over = attempts.some((a) => a.numeric !== null && a.numeric >= range.hi);
    if (!attempts.some((a) => a.rung >= top) || over) return done(best);
    const rate = await suggestRate(best.osuText, range, analyze);
    return done(best, {
        ceiling: { numeric: n, rate: rate?.rate ?? null, rateNumeric: rate?.numeric ?? null },
    });
}
