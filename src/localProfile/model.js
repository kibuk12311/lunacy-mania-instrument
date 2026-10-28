// The local profile's skill model: the player's own plays (recorded live or imported from the game's score files)
// → a dan per axis (Speed / Jack / Stamina / Tech, mania-tracker's four tiles), per pattern (the picks tab's seven)
// and overall, each with a ± range and a confidence. Pure functions; docs/local-profile.md explains every constant.
//
//   one play  → its performance dan: the map's dan at the play's rate (our analysis), moved by the accuracy
//               (full credit at REF_ACC, a little more near perfect, steadily less below) and by the misses; none
//               for a map that is vibro at that rate (src/vibro/detect.js, kept beside the map's summary): such a
//               pass says little about the player's jacks, so it is listed but moves no dan (MODEL.VIBRO_EXCLUDE);
//   one map  → its attribution: which patterns (and so which axes) it is evidence for, from the analysis's pattern
//               shares (LeoBlack's top three, the tech flag, the length);
//   many plays → per key (an axis or a pattern) the best play of each map, ordered by performance (old plays fade a
//               little a year), the top TOP_N weighted DECAY^i × share × quality, their weighted mean. Shown only with
//               enough evidence; the ± range narrows with it. Overall = the mean of the four axes, as mania-tracker
//               reads its own (src/recommend/manualProfile.js manualOverall).
import { numericToLabel } from "../core/labels.js";
import { NAME_FAMILY } from "../gen/search.js";
import { patternById } from "../recommend/catalog.js";

export const AXES = ["speed", "jack", "stamina", "tech"];
// the picks tab's patterns (src/recommend/catalog.js REC_PATTERNS), each under its tile
export const PATTERNS = ["stream", "jumpstream", "handstream", "stamina", "chordjack", "jack", "tech"];
export const DAY_MS = 86_400_000;

export const MODEL = Object.freeze({
    // accuracy (osu!stable mania accuracy in %, MAX and 300 both 300) → dan adjustment
    REF_ACC: 96.5, // full credit: "a map at your level" is one you can 96–97% (v1)
    ABOVE_SLOPE: 0.08, // + per % above the reference …
    ABOVE_MAX: 0.25, // … at most this (reached at ~99.6%)
    BELOW_SLOPE: 0.2, // − per % below the reference, down to KNEE_ACC
    KNEE_ACC: 93, // below this the map is clearly over the player's head
    STEEP_SLOPE: 0.35, // − per % below the knee
    FLOOR: -2.5, // never more than this below the map's dan
    MISS_SLOPE: 10, // − dan per unit of miss rate (1% misses → −0.1) on top of what they cost the accuracy …
    MISS_MAX: 0.4, // … at most this
    // a pass without judgements (Interlude's scores keep only a replay): counted as "passed it", weaker evidence
    NO_ACC_CREDIT: -0.5,
    NO_ACC_QUALITY: 0.5,
    // aggregation
    TOP_N: 20, // mania-tracker's rc dan counts 20 clears per skillset (tests/fixtures/mt/skills.json clearWindow)
    DECAY: 0.95, // the i-th best play weighs DECAY^i, like pp
    FADE_PER_YEAR: 0.5, // a play older than GRACE_DAYS counts this much less per year when ordering and averaging …
    GRACE_DAYS: 30,
    HALF_LIFE_DAYS: 180, // … and its evidence for the ± and the confidence halves every HALF_LIFE_DAYS
    MIN_SHARE: 0.2, // a map is evidence for a key only when at least this share of it is that key
    WARMUP_BELOW: 2, // plays this far below the third best say nothing about the ceiling (warm-ups): left out
    MIN_EVIDENCE: 2, // the summed evidence (share × quality) a key needs before it shows a dan …
    MIN_MAPS: 3, // … and from at least this many different maps
    SPREAD: 0.9, // ± = SPREAD / √evidence, within [MIN_HALF, MAX_HALF]
    MIN_HALF: 0.1,
    MAX_HALF: 1.2,
    MEDIUM_EVIDENCE: 4, // confidence: low below this, medium below HIGH_EVIDENCE, else high
    HIGH_EVIDENCE: 10,
    // attribution
    TECH_SHARE: 0.4, // a map the analysis calls tech: this much of it is Tech, the rest by its patterns
    STAMINA_FROM_SEC: 120, // a map longer than this is partly Stamina evidence …
    STAMINA_FULL_SEC: 360, // … up to STAMINA_MAX of it at this length
    STAMINA_MAX: 0.5,
    // a pass on a map that is vibro at its rate (map.vibro.vibro, src/vibro/detect.js) is no evidence: kept and
    // listed, counted in vibroPlays, but in no axis, pattern or overall dan
    VIBRO_EXCLUDE: true,
});

// Mods that make a play not the player's own (autoplay, cinema, relax, autopilot) or not a play at all.
export const EXCLUDED_MODS = ["AT", "CN", "RX", "AP", "AU", "AL"];

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// osu!stable mania accuracy in % (the overlay's formula, src/overlay/format.js), null without judgements.
export function accuracyOf(hits) {
    if (!hits) return null;
    const n = (k) => Math.max(0, Number(hits[k]) || 0);
    const total = n("max") + n("n300") + n("n200") + n("n100") + n("n50") + n("miss");
    if (!total) return null;
    return (100 * (300 * (n("max") + n("n300")) + 200 * n("n200") + 100 * n("n100") + 50 * n("n50"))) / (300 * total);
}

export function missRate(hits) {
    if (!hits) return 0;
    const n = (k) => Math.max(0, Number(hits[k]) || 0);
    const total = n("max") + n("n300") + n("n200") + n("n100") + n("n50") + n("miss");
    return total ? n("miss") / total : 0;
}

// The dan adjustment for an accuracy in %: 0 at REF_ACC, up to +ABOVE_MAX near perfect, down to FLOOR.
export function accuracyAdjust(accPct, m = MODEL) {
    const acc = finite(accPct);
    if (acc === null) return null;
    if (acc >= m.REF_ACC) return Math.min(m.ABOVE_MAX, (acc - m.REF_ACC) * m.ABOVE_SLOPE);
    if (acc >= m.KNEE_ACC) return -(m.REF_ACC - acc) * m.BELOW_SLOPE;
    const atKnee = -(m.REF_ACC - m.KNEE_ACC) * m.BELOW_SLOPE;
    return Math.max(m.FLOOR, atKnee - (m.KNEE_ACC - acc) * m.STEEP_SLOPE);
}

const excluded = (mods) => (Array.isArray(mods) ? mods : []).some((x) => EXCLUDED_MODS.includes(String(x).toUpperCase()));

// Whether a map's summary says it is vibro at its rate (no answer is not vibro: the play counts as it always did).
export const isVibroMap = (map) => map?.vibro?.vibro === true;

// A play that would be evidence (a pass, the player's own, on a map with a dan) but is left out: the map is vibro.
export function vibroExcluded(play, map, m = MODEL) {
    if (!m.VIBRO_EXCLUDE || !isVibroMap(map) || !play || play.outcome !== "pass" || excluded(play.mods)) return false;
    return map.kind === "ok" && finite(map.numeric) !== null;
}

// One play on a map (its analysis summary at the play's rate) → { dan, quality, adjust, accuracy } or null when it is
// no evidence: not a pass (a fail or a quit tells only that the player stopped), autoplay-like mods, a map without a
// dan (LN, not 4K, too short), or a map that is vibro at that rate (vibroExcluded).
export function performanceDan(play, map, m = MODEL) {
    if (!play || play.outcome !== "pass" || excluded(play.mods)) return null;
    const mapDan = map?.kind === "ok" ? finite(map.numeric) : null;
    if (mapDan === null) return null;
    if (m.VIBRO_EXCLUDE && isVibroMap(map)) return null;
    const acc = play.hits ? accuracyOf(play.hits) : (finite(play.accuracy) !== null ? play.accuracy * 100 : null);
    if (acc === null) {
        return { dan: round2(mapDan + m.NO_ACC_CREDIT), mapDan, quality: m.NO_ACC_QUALITY, adjust: m.NO_ACC_CREDIT, accuracy: null };
    }
    const misses = Math.min(m.MISS_MAX, missRate(play.hits) * m.MISS_SLOPE);
    const adjust = accuracyAdjust(acc, m) - misses;
    return { dan: round2(mapDan + adjust), mapDan, quality: 1, adjust: round2(adjust), accuracy: acc };
}

// The card's pattern names (LeoBlack clusters) → the picks tab's pattern ids, by the generator's own families.
const PATTERN_OF = Object.fromEntries(Object.entries(NAME_FAMILY).map(([name, family]) => [name, family.toLowerCase()]));
// a map without named patterns: its strongest MinaCalc skillset stands for it
const MSD_PATTERN = { stream: "stream", jumpstream: "jumpstream", handstream: "handstream", chordjack: "chordjack", jackspeed: "jack", technical: "tech" };

// A map's analysis summary → { patterns: { id: share }, axes: { tile: share } }, both summing to 1 (empty when the
// map says nothing usable).
export function attribution(map, m = MODEL) {
    const patterns = {};
    const add = (id, w) => { if (w > 0) patterns[id] = (patterns[id] ?? 0) + w; };
    for (const p of Array.isArray(map?.top3) ? map.top3 : []) {
        const id = PATTERN_OF[p?.name];
        if (id && finite(p.share) > 0) add(id, p.share);
    }
    let total = Object.values(patterns).reduce((s, w) => s + w, 0);
    if (!total && map?.msd && typeof map.msd === "object") {
        const best = Object.entries(MSD_PATTERN).map(([k, id]) => [id, finite(map.msd[k])]).filter(([, v]) => v !== null)
            .sort((a, b) => b[1] - a[1])[0];
        if (best) add(best[0], 1);
        total = Object.values(patterns).reduce((s, w) => s + w, 0);
    }
    const scale = (f) => { for (const id of Object.keys(patterns)) patterns[id] *= f; };
    if (total) scale(1 / total);
    if (map?.tech) {
        if (total) scale(1 - m.TECH_SHARE);
        add("tech", total ? m.TECH_SHARE : 1);
        total = 1;
    }
    const sec = finite(map?.durationSec);
    const stamina = sec === null ? 0 : m.STAMINA_MAX * clamp((sec - m.STAMINA_FROM_SEC) / (m.STAMINA_FULL_SEC - m.STAMINA_FROM_SEC), 0, 1);
    if (stamina > 0 && total) {
        scale(1 - stamina);
        add("stamina", stamina);
    }
    const axes = {};
    for (const [id, w] of Object.entries(patterns)) {
        const tile = patternById(id)?.tile;
        if (tile) axes[tile] = (axes[tile] ?? 0) + w;
    }
    const tidy = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    return { patterns: tidy(patterns), axes: tidy(axes) };
}

// Evidence items of one key ([{ dan, share, quality, at, mapKey, playId }]) at time now → the key's estimate:
// { dan, halfWidth, confidence, evidence, maps, top: [{ playId, dan, eff, weight }] }, dan null below the minimum.
export function aggregate(items, now, m = MODEL) {
    const effOf = (it) => {
        const ageDays = Math.max(0, (now - it.at) / DAY_MS);
        return it.dan - (m.FADE_PER_YEAR * Math.max(0, ageDays - m.GRACE_DAYS)) / 365;
    };
    const best = new Map(); // mapKey → { item, eff }
    for (const it of items ?? []) {
        if (!(it.share >= m.MIN_SHARE) || it.at > now) continue;
        const eff = effOf(it);
        const known = best.get(it.mapKey);
        if (!known || eff > known.eff) best.set(it.mapKey, { item: it, eff });
    }
    const sorted = [...best.values()]
        .sort((a, b) => b.eff - a.eff || b.item.at - a.item.at || (a.item.playId < b.item.playId ? -1 : a.item.playId > b.item.playId ? 1 : 0));
    // the third best (not the best: one lucky or misread map must not throw the rest out)
    const floor = sorted.length ? sorted[Math.min(2, sorted.length - 1)].eff - m.WARMUP_BELOW : -Infinity;
    const ranked = sorted.filter((x) => x.eff >= floor).slice(0, m.TOP_N);
    let sumW = 0;
    let sum = 0;
    let evidence = 0; // recency-weighted: the ± and the confidence
    let support = 0; // as played: whether there is enough at all (an old history still has a dan, just a wider one)
    const top = ranked.map(({ item, eff }, i) => {
        const weight = m.DECAY ** i * item.share * item.quality;
        sumW += weight;
        sum += weight * eff;
        support += item.share * item.quality;
        evidence += item.share * item.quality * 0.5 ** (Math.max(0, now - item.at) / DAY_MS / m.HALF_LIFE_DAYS);
        return { playId: item.playId, mapKey: item.mapKey, dan: item.dan, eff: round2(eff), weight: Math.round(weight * 1000) / 1000 };
    });
    const maps = ranked.length;
    const enough = support >= m.MIN_EVIDENCE && maps >= m.MIN_MAPS && sumW > 0;
    const confidence = evidence < m.MEDIUM_EVIDENCE ? "low" : evidence < m.HIGH_EVIDENCE ? "medium" : "high";
    return {
        dan: enough ? round2(sum / sumW) : null,
        halfWidth: enough ? round2(clamp(m.SPREAD / Math.sqrt(Math.max(evidence, 1e-6)), m.MIN_HALF, m.MAX_HALF)) : null,
        confidence: enough ? confidence : "none",
        evidence: round2(evidence),
        maps,
        top,
    };
}

// The model's running state: plays are added one by one (in any order) and skill(now) reads the estimate; adding a
// play only appends its evidence, so a new play costs nothing like a recompute of the whole history.
// maps: (mapKey) → the analysis summary of a map at a rate, or null.
export function createSkillModel({ model = MODEL } = {}) {
    // "axis:speed" / "pattern:stream" → that key's evidence items
    const byKey = new Map([...AXES.map((k) => `axis:${k}`), ...PATTERNS.map((p) => `pattern:${p}`)].map((k) => [k, []]));
    const seen = new Set();
    let rated = 0;
    let total = 0;
    let vibro = 0; // passes left out because their map is vibro
    let lastAt = null;

    // → the play's performance (null when it is no evidence)
    function add(play, map) {
        if (!play?.id || seen.has(play.id)) return null;
        seen.add(play.id);
        total += 1;
        const perf = performanceDan(play, map, model);
        if (!perf) {
            if (vibroExcluded(play, map, model)) vibro += 1;
            return null;
        }
        rated += 1;
        lastAt = Math.max(lastAt ?? play.at, play.at);
        const { patterns, axes } = attribution(map, model);
        const base = { dan: perf.dan, quality: perf.quality, at: play.at, mapKey: play.mapKey, playId: play.id };
        for (const [k, share] of Object.entries(axes)) byKey.get(`axis:${k}`)?.push({ ...base, share });
        for (const [p, share] of Object.entries(patterns)) byKey.get(`pattern:${p}`)?.push({ ...base, share });
        return { ...perf, patterns, axes };
    }

    function skill(now = Date.now()) {
        const axes = Object.fromEntries(AXES.map((k) => [k, aggregate(byKey.get(`axis:${k}`), now, model)]));
        const patterns = Object.fromEntries(PATTERNS.map((p) => [p, aggregate(byKey.get(`pattern:${p}`), now, model)]));
        return skillObject({ axes, patterns, rated, total, vibro, lastAt });
    }

    return { add, skill, size: () => total, rated: () => rated, vibro: () => vibro };
}

// The estimates → the skill object every consumer takes (src/recommend/skill.js readSkill's shape: overall, tiles,
// msd, ready, analyzedPlays), plus local: true and the per-axis / per-pattern details. A tile without enough evidence
// is null, so src/recommend/skill.js playerDanFor falls back to the overall dan there.
export function skillObject({ axes, patterns, rated = 0, total = 0, vibro = 0, lastAt = null }) {
    const tiles = Object.fromEntries(AXES.map((k) => [k, axes[k]?.dan ?? null]));
    const known = AXES.map((k) => tiles[k]).filter((d) => d !== null);
    const overall = known.length ? round2(known.reduce((s, d) => s + d, 0) / known.length) : null;
    return {
        ready: overall !== null,
        status: overall !== null ? "local" : "local-empty",
        tracked: false,
        local: true,
        analyzedPlays: rated,
        totalPlays: total,
        vibroPlays: vibro, // passes on vibro maps: kept and listed, in no dan
        lastPlayAt: lastAt,
        overall,
        overallLabel: overall === null ? null : numericToLabel(overall).text,
        // the overall dan leaves out axes without enough plays yet
        partial: overall !== null && known.length < AXES.length,
        tiles,
        msd: {},
        axes,
        patterns,
    };
}

// The whole history at once (same answer as adding the plays one by one): plays [{ id, mapKey, at, outcome, hits,
// accuracy, mods }] with maps(mapKey) → summary.
export function skillFromPlays(plays, maps, now = Date.now(), model = MODEL) {
    const s = createSkillModel({ model });
    for (const p of plays ?? []) s.add(p, maps(p.mapKey));
    return s.skill(now);
}

// Daily points of the skill over time for a chart: the skill at the end of each day that had plays (at most
// maxPoints of them, evenly picked, the last day always), from `from` on. Each point { at, dan (overall), ratings:
// { speed, jack, stamina, tech, stream, … } } — the shape src/recommend/progress.js chartPath reads.
export function dailySkill(plays, maps, { from = -Infinity, to = Date.now(), maxPoints = 90, model = MODEL } = {}) {
    const sorted = [...(plays ?? [])].filter((p) => Number.isFinite(p?.at) && p.at <= to).sort((a, b) => a.at - b.at);
    const allDays = [...new Set(sorted.map((p) => Math.floor(p.at / DAY_MS)))];
    const endOf = (day) => Math.min(to, (day + 1) * DAY_MS - 1);
    const inside = allDays.filter((d) => endOf(d) >= from);
    // the last day before the period opens the line, moved to its start: where the player stood then
    const before = allDays.filter((d) => endOf(d) < from).at(-1);
    let picked = inside;
    if (inside.length > maxPoints) {
        const step = (inside.length - 1) / (maxPoints - 1);
        picked = [...new Set(Array.from({ length: maxPoints }, (_, i) => inside[Math.round(i * step)]))];
    }
    if (before !== undefined) picked = [before, ...picked];
    const s = createSkillModel({ model });
    const points = [];
    let i = 0;
    for (const day of picked) {
        const end = endOf(day);
        while (i < sorted.length && sorted[i].at <= end) {
            s.add(sorted[i], maps(sorted[i].mapKey));
            i += 1;
        }
        const k = s.skill(end);
        const ratings = {};
        for (const a of AXES) if (k.axes[a].dan !== null) ratings[a] = k.axes[a].dan;
        for (const p of PATTERNS) if (k.patterns[p].dan !== null) ratings[`p:${p}`] = k.patterns[p].dan;
        if (k.overall !== null || Object.keys(ratings).length) points.push({ at: day === before ? from : end, dan: k.overall, ratings });
    }
    return points;
}
