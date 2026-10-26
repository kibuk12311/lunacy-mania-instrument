// The pattern families of the analysis tab's strip, shared by the worker job (timeline.js) and the renderer
// (app/renderer/analysisExtras.js); no LeoBlack here, so the window can import it.

// the families the strip knows, in the order a tie goes to; BREAK marks a bin with too little pattern in it
export const FAMILIES = ["stream", "jumpstream", "handstream", "chordjack", "jack", "tech"];
export const BREAK = "-";

// Share of the played bins per family, largest first, to three decimals; breaks are left out.
export function familyShares(families) {
    const counts = new Map();
    let total = 0;
    for (const f of families ?? []) {
        if (f === BREAK || !FAMILIES.includes(f)) continue;
        counts.set(f, (counts.get(f) ?? 0) + 1);
        total += 1;
    }
    return [...counts.entries()]
        .sort((x, y) => y[1] - x[1] || FAMILIES.indexOf(x[0]) - FAMILIES.indexOf(y[0]))
        .map(([family, n]) => ({ family, share: Math.round((n / total) * 1000) / 1000 }));
}
