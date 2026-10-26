// Progress since the picks: which picked maps were played (mania-tracker's recent plays, else its skill plays),
// and how the player's dan and MinaCalc ratings moved (its skill history), as points for a small chart.
const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
const STEP = { "--": -0.4, "-": -0.2, "": 0, "+": 0.2, "++": 0.4 };
const KAPPA_HIGH = 20.4;
const ABOVE_KAPPA = 20.5; // src/core/labels.js: from here on a dan reads "above Kappa"
// the rating axes the history keeps (the tracker's "pattern:ln" is left out)
export const HISTORY_AXES = ["Overall", "Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];
export const DAY_MS = 86_400_000;

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round2 = (x) => Math.round(x * 100) / 100;
const dayOf = (ms) => Math.floor(ms / DAY_MS);

// "delta--" → 13.6, "10++" → 10.4, "kappa" → 20: the tracker's step labels on our scale (Alpha = 11 … Kappa = 20).
export function trackerLabelToDan(label) {
    if (typeof label !== "string") return null;
    const m = /^\s*([a-z]+|\d{1,2})(\+\+|\+|--|-)?\s*$/i.exec(label);
    if (!m) return null;
    const base = /^\d+$/.test(m[1]) ? Number(m[1]) : GREEK.indexOf(m[1].toLowerCase()) + 11;
    if (!(base >= 1 && base <= 20) || (!/^\d+$/.test(m[1]) && base < 11)) return null;
    return Math.round((base + STEP[m[2] ?? ""]) * 10) / 10;
}

// osu! mods (lazer objects or acronyms) → the rate: DT/NC 1.5, HT/DC 0.75, or their speed_change.
export function rateFromMods(mods) {
    for (const mod of Array.isArray(mods) ? mods : []) {
        const acronym = typeof mod === "string" ? mod : mod?.acronym;
        const speed = finite(mod?.settings?.speed_change);
        if (acronym === "DT" || acronym === "NC") return speed ?? 1.5;
        if (acronym === "HT" || acronym === "DC") return speed ?? 0.75;
    }
    return 1;
}

// osu!mania accuracy from the judgements, with lazer's weights (what the server reports for ranked plays).
export function maniaAccuracy(stats) {
    const n = (key) => Math.max(0, Number(stats?.[key]) || 0);
    const total = n("perfect") + n("great") + n("good") + n("ok") + n("meh") + n("miss");
    if (!total) return 0;
    return (305 * n("perfect") + 300 * n("great") + 200 * n("good") + 100 * n("ok") + 50 * n("meh")) / (305 * total);
}

// /recent (osu! scores) → [{ beatmapId, at, accuracy, passed, rate, md5 }], 4K osu!mania only (no converts).
export function readRecent(json) {
    const scores = Array.isArray(json?.payload) ? json.payload : Array.isArray(json) ? json : [];
    const out = [];
    for (const s of scores) {
        const beatmapId = Number(s?.beatmap_id ?? s?.beatmap?.id);
        const at = Date.parse(s?.ended_at);
        const mania = s?.ruleset_id === 3 || s?.beatmap?.mode === "mania";
        if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0 || !Number.isFinite(at) || !mania) continue;
        if (Number(s.beatmap?.cs) !== 4 || s.beatmap?.convert === true) continue;
        // an unranked play comes with accuracy 0: worked out from its judgements
        const accuracy = finite(s.accuracy) > 0 ? s.accuracy : maniaAccuracy(s.statistics);
        const md5 = s.beatmap?.checksum ?? s.beatmapChecksum;
        out.push({
            beatmapId, at, accuracy, passed: s.passed !== false && s.rank !== "F", rate: rateFromMods(s.mods),
            md5: typeof md5 === "string" ? md5 : null,
        });
    }
    return out;
}

// /skill-history page → { items: [{ at, label, dan, ratings }], nextBefore }.
export function readHistory(json) {
    const items = [];
    for (const row of Array.isArray(json?.items) ? json.items : []) {
        const at = Date.parse(row?.recordedAt);
        if (!Number.isFinite(at)) continue;
        const rc = row.snapshot?.dan?.rc;
        const label = typeof rc?.label === "string" ? rc.label : null;
        const raw = finite(rc?.rawDan);
        const parsed = trackerLabelToDan(label);
        const ratings = {};
        for (const axis of HISTORY_AXES) {
            const v = finite(row.snapshot?.ratings?.[axis]);
            if (v !== null) ratings[axis] = v;
        }
        // past the top of the tracker's table (its last label, kappa++, is Kappa high): our "above Kappa"; the dan keeps
        // its number (the raw one when the tracker gives it), so deltas and the chart still work
        const above = (raw !== null && raw >= ABOVE_KAPPA) || (rc?.beyondTable === true && (parsed === null || parsed >= KAPPA_HIGH));
        items.push({ at, label, dan: raw ?? parsed, ...(above ? { above } : {}), ratings });
    }
    const next = Number(json?.nextBefore);
    return { items, nextBefore: Number.isSafeInteger(next) && next > 0 ? next : null };
}

// One point a day (the day's last snapshot) from sinceMs on, after the last snapshot before it (moved to sinceMs),
// so the line starts where the player stood when the period began.
export function dailyPoints(items, sinceMs) {
    const sorted = (items ?? []).filter((i) => Number.isFinite(i?.at)).sort((a, b) => a.at - b.at);
    const before = sorted.filter((i) => i.at < sinceMs).at(-1);
    const byDay = new Map();
    for (const i of sorted) if (i.at >= sinceMs) byDay.set(dayOf(i.at), i);
    const point = (i, at = i.at) => ({ at, label: i.label, dan: i.dan, ...(i.above ? { above: true } : {}), ratings: { ...i.ratings } });
    const points = [...byDay.values()].map((i) => point(i));
    if (before) points.unshift(point(before, sinceMs));
    return points;
}

const end = (p) => ({ label: p.label, dan: p.dan, ...(p.above ? { above: true } : {}) });

// First → last point: the dan and every rating axis, biggest gain first; null without points.
export function skillChange(points) {
    if (!points?.length) return null;
    const first = points[0];
    const last = points.at(-1);
    const axes = HISTORY_AXES
        .filter((axis) => finite(first.ratings?.[axis]) !== null && finite(last.ratings?.[axis]) !== null)
        .map((axis) => ({ axis, from: first.ratings[axis], to: last.ratings[axis], delta: round2(last.ratings[axis] - first.ratings[axis]) }))
        .sort((a, b) => b.delta - a.delta);
    const danDelta = finite(first.dan) !== null && finite(last.dan) !== null ? round2(last.dan - first.dan) : null;
    return {
        danFrom: end(first),
        danTo: end(last),
        danDelta,
        axes,
    };
}

// Each pick with the play that counts for it: a recent play after the pick (exact time; the best pass wins, every try
// is counted), else a skill play from the pick's day on (day precision). played: Map beatmapId → { accuracy, rate, playedAt }.
export function joinPicks(picks, recent, played = new Map()) {
    return (picks ?? []).map((pick) => {
        const after = (recent ?? []).filter((r) => r.beatmapId === pick.beatmapId && r.at >= pick.at);
        if (after.length) {
            const passes = after.filter((r) => r.passed);
            const best = passes.length
                ? passes.reduce((a, b) => (b.accuracy > a.accuracy ? b : a))
                : after.reduce((a, b) => (b.at > a.at ? b : a));
            return { ...pick, play: { accuracy: best.accuracy, rate: best.rate, at: best.at, passed: best.passed }, tries: after.length };
        }
        const p = played?.get?.(pick.beatmapId);
        if (p && Number.isFinite(p.playedAt) && dayOf(p.playedAt) >= dayOf(pick.at)) {
            return { ...pick, play: { accuracy: p.accuracy, rate: p.rate, at: p.playedAt, passed: true }, tries: 0 };
        }
        return { ...pick, play: null, tries: 0 };
    });
}

// The axis ("dan" or a rating) over time in box { width, height, pad, from, to } → an SVG path, its dots, and marks
// (times, such as when a picked map was played) placed on the line. A flat line keeps a 0.2 span and sits in the middle.
export function chartPath(points, axis, box, marks = []) {
    const valueOf = (p) => finite(axis === "dan" ? p?.dan : p?.ratings?.[axis]);
    const known = (points ?? []).filter((p) => Number.isFinite(p?.at) && valueOf(p) !== null);
    if (!known.length) return { d: "", dots: [], marks: [], lo: null, hi: null };
    const values = known.map(valueOf);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < 0.2) {
        const mid = (lo + hi) / 2;
        [lo, hi] = [mid - 0.1, mid + 0.1];
    }
    const pad = box.pad ?? 0;
    const from = box.from ?? known[0].at;
    const to = box.to ?? known.at(-1).at;
    const span = Math.max(1, to - from);
    const x = (at) => pad + ((at - from) / span) * (box.width - 2 * pad);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (box.height - 2 * pad);
    const r1 = (v) => Math.round(v * 10) / 10;
    const dots = known.map((p) => ({ x: r1(x(p.at)), y: r1(y(valueOf(p))), at: p.at, value: valueOf(p) }));
    const d = dots.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    // the line's value at a time: between two points it is the straight line, past the ends the end value
    const valueAt = (at) => {
        if (at <= known[0].at) return valueOf(known[0]);
        for (let i = 1; i < known.length; i++) {
            const [a, b] = [known[i - 1], known[i]];
            if (at <= b.at) return valueOf(a) + ((valueOf(b) - valueOf(a)) * (at - a.at)) / Math.max(1, b.at - a.at);
        }
        return valueOf(known.at(-1));
    };
    const placed = (marks ?? []).filter((at) => Number.isFinite(at) && at >= from && at <= to)
        .map((at) => ({ x: r1(x(at)), y: r1(y(valueAt(at))), at }));
    return { d, dots, marks: placed, lo: round2(lo), hi: round2(hi) };
}
