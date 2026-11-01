// Everything the Replay tab shows of one play, put together in the window: it is worked out there because the fingers can
// change while the replay is open (they decide the hands, and the hands decide the manip) and the map's dans and pattern
// families come later than the replay. A section with no data is null or empty and the tab leaves it out. Pure.
import { manipPairs, manipSummary, manipByFamily, MANIP } from "./manip.js";
import { TIMELINE_BINS } from "./analyze.js";
import { fingerReport, handsOf } from "./fingers.js";
import { timingDrift, paceLine, comboBreaks, ghostReport, partReport, hardestParts, familyReport } from "./flow.js";

// later: what replay-details answered, or null while it is on its way:
// { families: per bin along the map (family id or null), spanMs, dans: per part }.
// → familyAt(ms of the map) → family id or null.
export function familyLine(later, fromMs) {
    const bins = later?.families?.length ?? 0;
    const span = later?.spanMs ?? 0;
    if (!bins || !(span > 0)) return () => null;
    return (ms) => later.families[Math.min(bins - 1, Math.max(0, Math.floor(((ms - fromMs) / span) * bins)))] ?? null;
}

// analysis: analyze.js; presses: per column; fingers: one per column (src/replay/fingers.js); later: as above.
export function buildReport({ analysis, presses, fingers, later = null }) {
    const { results, rate, fromMs, toMs, reachedMs, windows, ghosts, sd } = analysis;
    const hands = handsOf(fingers);
    const pairs = manipPairs(results, rate, MANIP, hands);
    const inPlay = presses.map((list) => list.filter((p) => p.t <= reachedMs + windows.miss));
    const parts = partReport({ analysis, pairs, dans: later?.dans ?? null });
    const familyAt = familyLine(later, fromMs);
    return {
        hands, pairs,
        manip: manipSummary(pairs, { fromMs, toMs, bins: TIMELINE_BINS, sdMs: sd }),
        ...fingerReport(analysis, presses, fingers),
        drift: timingDrift(results, { fromMs, toMs: reachedMs, rate }),
        pace: paceLine({ heads: results.map((r) => r.t), presses: inPlay, fromMs, toMs: reachedMs, rate }),
        breaks: comboBreaks(analysis),
        ghosts: ghostReport({ ghosts, results, rate, fromMs, toMs }),
        parts, hardest: hardestParts(parts),
        families: later ? familyReport(results, manipByFamily(pairs, familyAt), familyAt) : [],
    };
}
