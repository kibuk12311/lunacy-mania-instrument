// The manip percent. As the pattern guide words it: manip is when notes of one hand that come one after another get
// pressed together, like a chord, so a trill or a roll turns into jumps.
//
// What is counted (every number lives in MANIP below, nowhere else):
//   a pair: two rows of one hand in a row (left hand: columns 1 and 2, right hand: 3 and 4), each a single note, in
//     different columns, both pressed, written minGapMs to maxGapMs apart in real time. Closer than that they are a
//     chord in all but name; further apart nobody can glue them and they would only water the percent down.
//   manip: such a pair pressed closer together than written by a clear margin: the two presses at most maxShare of the
//     written gap apart AND at least marginMs closer than written. The order of the two presses does not matter
//     (a reversed glue is still a glue); gaps are real ms, so a rate counts as what the hands did.
//   Each note is glued once: the pair right after a glued one shares a note with it and is the gap between two "jumps",
//     not a pair of its own, so it is not counted. A roll or a trill played as jumps is thus 100 %, not 50 %.
// The percent is manip pairs ÷ pairs, overall and per hand, per part of the map, per pattern family, along the map.
// Chosen on the distribution of played ÷ written gaps of 2 100 real replays: honest pairs of 80 ms and up sit around 1
// with a tail ending near 0.5; glued ones form their own bump under 0.4. minGapMs 40 keeps the pairs where a press's
// own scatter (15 ms) is not as big as the gap itself.
// Loose play glues pairs by itself: chancePercent says how many. A percent less than looseMargin points above that is called
// plain scatter, not manip (over 1 814 real replays the excess of honest play is 2 points at the 90th percentile, 5 to 8 at
// the 99th; plays with real manip stand 10 and more above chance). Under minPairs pairs the percent is too thin to stand as a
// headline: one pair moves it by more than looseMargin, and one pair alone reads 0 or 100 %. Pure.
export const MANIP = Object.freeze({ minGapMs: 40, maxGapMs: 200, maxShare: 0.4, marginMs: 30, looseMargin: 5, minPairs: 20 });

// The two hands on 4K unless the Replay tab was told otherwise (src/replay/fingers.js handsOf).
export const HANDS = Object.freeze([{ id: "left", columns: [0, 1] }, { id: "right", columns: [2, 3] }]);

export const isGlued = (writtenMs, playedMs, limits = MANIP) => {
    const played = Math.abs(playedMs);
    return played <= limits.maxShare * writtenMs && writtenMs - played >= limits.marginMs;
};

// results: judgeReplay's (played columns, sorted by t); rate: of the replay.
// → the pairs [{ t, tb, col, colb, hand, written, played, glued }] sorted by t (t, tb: the two notes in ms of the map).
export function manipPairs(results, rate = 1, limits = MANIP, hands = HANDS) {
    const pairs = [];
    for (const hand of hands) {
        let last = null; // the last row of this hand: { t, one (its note when single), n }
        let gluedTo = null; // the note time the last glued pair ended on
        for (let i = 0; i < results.length;) {
            const t = results[i].t;
            let n = 0;
            let one = null;
            for (; i < results.length && results[i].t === t; i += 1) {
                if (hand.columns.includes(results[i].col)) {
                    n += 1;
                    one = results[i];
                }
            }
            if (!n) continue;
            if (last?.n === 1 && n === 1 && last.one.col !== one.col && last.one.press !== null && one.press !== null) {
                const written = (t - last.t) / rate;
                if (written >= limits.minGapMs && written <= limits.maxGapMs) {
                    const played = (one.press - last.one.press) / rate;
                    const glued = isGlued(written, played, limits);
                    if (gluedTo !== last.t) {
                        pairs.push({ t: last.t, tb: t, col: last.one.col, colb: one.col, hand: hand.id, written, played, glued });
                        if (glued) gluedTo = t;
                    }
                }
            }
            last = { t, one, n };
        }
    }
    return pairs.sort((a, b) => a.t - b.t || a.tb - b.tb);
}

// How much of the percent loose timing alone would make: a press scatters by sdMs around its own mean, so a pair's played
// gap scatters by sdMs·√2 around the written one and now and then falls under the limit without anyone gluing.
// Φ by the Abramowitz–Stegun 26.2.17 approximation.
const phi = (z) => {
    const u = 1 / (1 + 0.2316419 * Math.abs(z));
    const tail = (Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)) * u * (0.31938153 + u * (-0.356563782 + u * (1.781477937 + u * (-1.821255978 + u * 1.330274429))));
    return z >= 0 ? 1 - tail : tail;
};
export function chancePercent(pairs, sdMs, limits = MANIP) {
    if (!pairs.length || !(sdMs > 0)) return null;
    const scatter = sdMs * Math.SQRT2;
    let sum = 0;
    for (const { written } of pairs) {
        const limit = Math.min(limits.maxShare * written, written - limits.marginMs);
        if (limit > 0) sum += phi((limit - written) / scatter) - phi((-limit - written) / scatter);
    }
    return Math.round((sum / pairs.length) * 1000) / 10;
}

const share = (glued, pairs) => (pairs ? Math.round((glued / pairs) * 1000) / 10 : null);
// squeezed: how many real ms closer than written the glued pairs were pressed, on average and at most (null with none).
const tally = (list) => {
    const lost = list.filter((p) => p.glued).map((p) => p.written - Math.abs(p.played));
    const glued = lost.length;
    return {
        pairs: list.length, glued, percent: share(glued, list.length),
        squeezed: glued ? { mean: Math.round((lost.reduce((a, b) => a + b, 0) / glued) * 10) / 10, max: Math.round(Math.max(...lost) * 10) / 10 } : null,
    };
};

// Whether a percent is no more than loose timing would make by itself.
export const isLoose = (percent, chance, limits = MANIP) => percent !== null && chance !== null && chance >= 1 && percent - chance < limits.looseMargin;
// Whether there are pairs, but too few for their percent to say much.
export const isThin = (pairs, limits = MANIP) => pairs > 0 && pairs < limits.minPairs;

// pairs → { ...tally, chance (chancePercent at sdMs), loose (isLoose), thin (isThin), hands: { left, right }, bins: [{ pairs, glued }] along
// [fromMs, toMs] of the map, marks: the glued pairs }. percent null when there is no pair to judge.
export function manipSummary(pairs, { fromMs, toMs, bins = 60, sdMs = null } = {}) {
    const row = Array.from({ length: bins }, () => ({ pairs: 0, glued: 0 }));
    const span = Math.max(1, toMs - fromMs);
    for (const p of pairs) {
        const b = row[Math.min(bins - 1, Math.max(0, Math.floor(((p.t - fromMs) / span) * bins)))];
        b.pairs += 1;
        if (p.glued) b.glued += 1;
    }
    const all = tally(pairs);
    const chance = chancePercent(pairs, sdMs);
    return {
        ...all,
        chance, loose: isLoose(all.percent, chance), thin: isThin(all.pairs),
        hands: Object.fromEntries(HANDS.map(({ id }) => [id, tally(pairs.filter((p) => p.hand === id))])),
        bins: row,
        marks: pairs.filter((p) => p.glued),
    };
}

// The same counted over the parts of the map: parts [{ fromMs, toMs }] (ms of the map) → parts with their tally.
export const manipByPart = (pairs, parts) => parts.map((part) => ({
    ...part, ...tally(pairs.filter((p) => p.t >= part.fromMs && p.t < part.toMs)),
}));

// And over the pattern families of the map's details (src/analysis/timeline.js: one family per bin along the play):
// familyAt(t) → family id or null. → [{ family, ...tally }] with the most pairs first, families without pairs left out.
export function manipByFamily(pairs, familyAt) {
    const groups = new Map();
    for (const p of pairs) {
        const family = familyAt(p.t);
        if (!family) continue;
        if (!groups.has(family)) groups.set(family, []);
        groups.get(family).push(p);
    }
    return [...groups].map(([family, list]) => ({ family, ...tally(list) })).sort((a, b) => b.pairs - a.pairs);
}
