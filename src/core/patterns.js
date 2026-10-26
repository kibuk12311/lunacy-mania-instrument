// Pattern summary on top of LeoBlack's Interlude-style pattern report.

const MSD_SKILLSETS = ["stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"];

function clusterName(cluster) {
    return cluster.SpecificTypes?.length > 0 ? cluster.SpecificTypes[0][0] : cluster.Pattern;
}

// Share of total pattern time per cluster name, largest first.
export function patternShares(report) {
    const clusters = report?.Clusters ?? [];
    const total = clusters.reduce((sum, c) => sum + (Number(c.Amount) || 0), 0);
    if (!total) return [];
    const byName = new Map();
    for (const c of clusters) {
        const name = clusterName(c);
        byName.set(name, (byName.get(name) ?? 0) + (Number(c.Amount) || 0) / total);
    }
    return [...byName.entries()].map(([name, share]) => ({ name, share })).sort((a, b) => b.share - a.share);
}

// Tech = the most important cluster has uneven rhythm AND MinaCalc rates Technical near the top skillset.
export function isTech(report, msd, techMsdRatio) {
    const top = report?.Clusters?.[0];
    if (!top?.Mixed || !msd) return false;
    const values = MSD_SKILLSETS.map((k) => Number(msd[k])).filter(Number.isFinite);
    if (!values.length || !Number.isFinite(Number(msd.technical))) return false;
    return Number(msd.technical) >= techMsdRatio * Math.max(...values);
}

export function summarizePatterns(report, msd, { techMsdRatio = 0.93 } = {}) {
    const top3 = patternShares(report).slice(0, 3);
    return {
        primary: top3[0]?.name ?? null,
        top3,
        tech: isTech(report, msd, techMsdRatio),
    };
}
