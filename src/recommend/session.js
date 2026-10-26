// A practice session from the maps the player already has (the "Сессия" page of the picks tab): warm-up → main block
// → push → cool-down, about as long as asked, from the analysed library (app/sessionLibrary.js) and the player's
// skill (mania-tracker or set by hand). Pure: every map, the skill and the randomness come in, nothing is read here.
import { patternById, goalById, REC_PATTERNS } from "./catalog.js";
import { targetFor } from "./skill.js";
import { NAME_FAMILY } from "../gen/search.js";
import { numericToLabel } from "../core/labels.js";
import { t } from "../i18n/i18n.js";

export const SESSION_MINUTES = [20, 30, 45, 60];
export const MIN_MINUTES = 10;
export const MAX_MINUTES = 180;
export const MAX_SESSION_PATTERNS = 3;
export const PARTS = ["warmup", "main", "push", "cooldown"];
// A map that was played this recently counts as "recently played".
export const RECENT_DAYS = 7;
// Rates a map may be taken at, and how much our dan moves per 1.0 of rate before a real analysis checks it: about one
// dan per 0.1 (measured on the analyser around the middle of the scale; only picks the rate to try first).
// A slowed-down map plays worse than a sped-up one, so rates below 1.0 stay close to it and cost more.
export const RATE = { min: 0.85, max: 1.4, step: 0.05 };
export const DAN_PER_RATE = 10;
// how far from a slot's dan a map may be (after its rate), per part
const TOLERANCE = { warmup: 0.5, main: 0.35, push: 0.45, cooldown: 0.6 };
const WARMUP_SHARE = 0.2;
// ↻ on one map takes one up to this much further from the slot's dan when none is left within the usual distance
const REROLL_WIDEN = 1.6;
// Stamina is no finder family of its own: a long map of a stream family stands for it.
const STAMINA_MIN_SEC = 240;
const STAMINA_FAMILIES = new Set(["stream", "jumpstream", "handstream"]);
// a finder share that makes a map "also" a pattern (not its main one)
const SIDE_SHARE = 0.25;
// the pattern a warm-up or the variety slot of the main block may take instead of the focus
export const RELATED = {
    stream: ["jumpstream", "tech"],
    jumpstream: ["stream", "handstream", "stamina"],
    handstream: ["jumpstream", "stamina", "chordjack"],
    stamina: ["jumpstream", "handstream"],
    chordjack: ["jack", "handstream"],
    jack: ["chordjack"],
    tech: ["stream", "jumpstream"],
};
// kinds of the Detailed mode the finder names itself; the others are told by their parent family only
const KIND_NAMES = { quadstream: ["Quadstream"] };

const round2 = (x) => Math.round(x * 100) / 100;
const round05 = (x) => Math.round(x * 20) / 20;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// A small seeded generator (mulberry32), so a session can be built again from its seed and tests are fixed.
export function seeded(seed) {
    let a = (Number(seed) >>> 0) || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

// A finder name (LeoBlack cluster) → the picks' family id (stream, jumpstream, handstream, chordjack, jack), or null.
const familyOf = (name) => (Object.hasOwn(NAME_FAMILY, name ?? "") ? NAME_FAMILY[name].toLowerCase() : null);

// What patterns an analysed map stands for: its main family (tech when the analysis says so), each family's share
// of the finder's top three, the finder's own names.
export function mapPatterns(a) {
    const shares = {};
    for (const p of a?.top3 ?? []) {
        const f = familyOf(p?.name);
        if (f) shares[f] = (shares[f] ?? 0) + (Number(p.share) || 0);
    }
    const main = a?.tech ? "tech" : familyOf(a?.primary);
    return { main, shares, names: new Set((a?.top3 ?? []).map((p) => p?.name).filter(Boolean)) };
}

// How well a map is the pattern: 1 its main pattern, 0.6 a big side of it, 0 not it.
export function patternFit(map, patternId) {
    const p = patternById(patternId);
    if (!p) return 0;
    const pats = map.patterns ?? mapPatterns(map);
    if (p.parent) {
        const names = KIND_NAMES[p.id];
        if (names) return names.some((n) => pats.names.has(n)) ? 1 : 0;
        return patternFit(map, p.parent);
    }
    if (p.id === "stamina") {
        return STAMINA_FAMILIES.has(pats.main) && (Number(map.durationSec) || 0) >= STAMINA_MIN_SEC ? 1 : 0;
    }
    if (pats.main === p.id) return 1;
    return (pats.shares[p.id] ?? 0) >= SIDE_SHARE ? 0.6 : 0;
}

// The pattern a map is shown under: the first focus pattern it fits, else its main family.
export function shownPattern(map, focus) {
    const hit = focus.find((id) => patternFit(map, id) >= 1) ?? focus.find((id) => patternFit(map, id) > 0);
    return hit ?? (map.patterns ?? mapPatterns(map)).main ?? focus[0] ?? null;
}

const relatedOf = (id) => {
    const p = patternById(id);
    return RELATED[p?.parent ?? id] ?? [];
};

// The rate that brings a map to a dan (estimated) and its dan there; 1.0 without rates or when it is close already.
export function rateFor(numeric, target, allowRates) {
    if (!allowRates || Math.abs(numeric - target) <= 0.2) return { rate: 1, dan: numeric, estimated: false };
    const rate = round2(clamp(round05(1 + (target - numeric) / DAN_PER_RATE), RATE.min, RATE.max));
    if (rate === 1) return { rate: 1, dan: numeric, estimated: false };
    return { rate, dan: round2(numeric + (rate - 1) * DAN_PER_RATE), estimated: true };
}

// A request as the builder takes it, or the reason (in the current language) it cannot be built.
export function cleanSessionRequest(r) {
    const minutes = Number(r?.minutes);
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return t("session.err.minutes", { min: MIN_MINUTES, max: MAX_MINUTES });
    const ids = Array.isArray(r?.patternIds) ? [...new Set(r.patternIds)] : [];
    if (!ids.length || ids.length > MAX_SESSION_PATTERNS || !ids.every((id) => typeof id === "string" && patternById(id))) return t("session.err.patterns");
    if (!goalById(r?.goalId)) return t("app.rec.chooseGoal");
    return { minutes, patternIds: ids, goalId: r.goalId, allowRates: Boolean(r.allowRates), avoidRecent: Boolean(r.avoidRecent) };
}

// Each focus pattern's window for the goal around the player's dan (skill.js targetFor).
function targetsOf({ skill, manualDan, patternIds, goalId }) {
    return patternIds.map((patternId) => targetFor({ skill, manualDan, patternId, goalId }));
}

// The slots of a session of `sec` seconds: warm-up from well below up to the window, the main block in the window
// (every fourth one may be a related pattern), one push above it (two from 45 minutes), one cool-down below.
// avgSec: a usual map's length, to know how many slots fill the time.
function planSlots({ targets, sec, avgSec }) {
    const first = targets[0];
    const warmCount = Math.max(1, Math.round((sec * WARMUP_SHARE) / avgSec));
    const warmFrom = first.playerDan - 1.0;
    const warmTo = first.lo - 0.25;
    const warmup = Array.from({ length: warmCount }, (_, i) => ({
        part: "warmup",
        dan: round2(warmCount === 1 ? (warmFrom + warmTo) / 2 : warmFrom + ((warmTo - warmFrom) * i) / (warmCount - 1)),
        patternIds: targets.map((x) => x.patternId),
    }));
    const pushCount = sec >= 45 * 60 ? 2 : 1;
    const push = Array.from({ length: pushCount }, (_, i) => {
        const tg = targets[i % targets.length];
        return { part: "push", dan: round2(tg.hi + 0.3 + 0.25 * i), patternIds: [tg.patternId] };
    });
    const cooldown = [{ part: "cooldown", dan: round2(first.playerDan - 0.6), patternIds: targets.map((x) => x.patternId) }];
    return { warmup, push, cooldown };
}

// The dan of the k-th main slot of a window: a small wave inside it, so the block is not one dan over and over.
const WAVE = [0.4, 0.65, 0.5, 0.85, 0.3, 0.7];
const mainDan = (tg, k) => round2(tg.lo + (tg.hi - tg.lo) * WAVE[k % WAVE.length]);

// A slot's penalty for a map's pattern, or null when the map does not belong there.
function patternPenalty(map, slot) {
    const fit = Math.max(...slot.patternIds.map((id) => patternFit(map, id)));
    if (fit >= 1) return 0;
    if (fit > 0) return 0.3;
    const related = slot.patternIds.some((id) => relatedOf(id).some((r) => patternFit(map, r) >= 1));
    if (slot.part === "main") return slot.variety && related ? 0.4 : null;
    if (slot.part === "push") return related ? 0.6 : null;
    if (slot.part === "warmup") return related ? 0.2 : 0.7;
    return related ? 0.15 : 0.35; // cool-down: anything goes, the focus first
}

// The best map for a slot: dan distance (after its rate), pattern, rate, a song used already, a little chance.
function pick(slot, ctx) {
    const tol = TOLERANCE[slot.part] * (ctx.widen ?? 1);
    let best = null;
    for (const map of ctx.maps) {
        if (ctx.taken.has(map.id) || slot.avoid?.has(map.id)) continue;
        if (ctx.recent.has(map.id)) continue;
        const pp = patternPenalty(map, slot);
        if (pp === null) continue;
        const fit = rateFor(map.numeric, slot.dan, ctx.allowRates);
        const dist = Math.abs(fit.dan - slot.dan);
        if (dist > tol) continue;
        const sameSong = ctx.songs.has(map.songKey) ? 0.6 : 0;
        // the cool-down leans to a short map
        const length = slot.part === "cooldown" ? clamp(((Number(map.durationSec) || 0) / fit.rate - 120) / 240, 0, 0.5) : 0;
        // 1.0 first: a rate costs, a slow-down twice as much
        const rateCost = (fit.rate - 1) * (fit.rate < 1 ? -6 : 3);
        const score = dist / tol + pp + rateCost + sameSong + length + ctx.random() * 0.35;
        if (!best || score < best.score) best = { map, fit, score };
    }
    return best;
}

function itemOf(slot, { map, fit }, focus) {
    const durationSec = round2((Number(map.durationSec) || 0) / fit.rate);
    return {
        part: slot.part,
        slot: { part: slot.part, dan: slot.dan, patternIds: slot.patternIds, ...(slot.variety ? { variety: true } : {}) },
        mapId: map.id,
        artist: map.artist, title: map.title, version: map.version, creator: map.creator,
        rate: fit.rate,
        dan: fit.dan,
        danLabel: numericToLabel(fit.dan).text,
        estimated: fit.estimated,
        baseDan: map.numeric,
        durationSec,
        patternId: shownPattern(map, slot.patternIds.length ? slot.patternIds : focus),
        sources: map.sources ?? {},
    };
}

// The middle map length of the library, for planning how many slots fit (2:30 when there are none).
function medianLength(maps) {
    const list = maps.map((m) => Number(m.durationSec)).filter((x) => x > 0).sort((a, b) => a - b);
    return list.length ? list[Math.floor(list.length / 2)] : 150;
}

const songKey = (m) => m.songKey ?? `${String(m.artist ?? "").toLowerCase()}|${String(m.title ?? "").toLowerCase()}`;

// maps: the analysed library ({ id, artist, title, version, creator, numeric, primary, top3, tech, durationSec,
// sources }); request: cleanSessionRequest's; skill / manualDan: the player's (one of them); recent: ids to leave out
// (only with avoidRecent); seed: the randomness. → { ok, items, totalSec, requestedSec, targets, notes, seed } or
// { ok: false, reason, message }.
export function buildSession({ maps, request, skill = null, manualDan = null, recent = new Set(), seed = 1 }) {
    const usable = (maps ?? []).filter((m) => finite(m?.numeric) !== null && m.id)
        .map((m) => ({ ...m, songKey: songKey(m), patterns: mapPatterns(m) }));
    if (!usable.length) return { ok: false, reason: "empty", message: t("session.err.empty") };
    const targets = targetsOf({ skill, manualDan, patternIds: request.patternIds, goalId: request.goalId });
    const sec = request.minutes * 60;
    const avgSec = medianLength(usable);
    const ctx = {
        maps: usable, taken: new Set(), songs: new Set(), allowRates: request.allowRates,
        recent: request.avoidRecent ? recent : new Set(), random: seeded(seed),
    };
    const take = (slot) => {
        const found = pick(slot, ctx);
        if (!found) return null;
        ctx.taken.add(found.map.id);
        ctx.songs.add(found.map.songKey);
        return itemOf(slot, found, request.patternIds);
    };

    const plan = planSlots({ targets, sec, avgSec });
    const warmup = plan.warmup.map(take).filter(Boolean);
    // the push and the cool-down are chosen before the main block, so the block fills the time left between them
    const push = plan.push.map(take).filter(Boolean);
    const cooldown = plan.cooldown.map(take).filter(Boolean);
    const timeOf = (list) => list.reduce((s, x) => s + x.durationSec, 0);
    const main = [];
    let used = timeOf(warmup) + timeOf(push) + timeOf(cooldown);
    let misses = 0;
    for (let k = 0; used < sec - avgSec * 0.5 && misses < targets.length * 2 && main.length < 60; k++) {
        const tg = targets[k % targets.length];
        const item = take({ part: "main", dan: mainDan(tg, Math.floor(k / targets.length)), patternIds: [tg.patternId], variety: k % 4 === 3 });
        if (!item) {
            misses += 1;
            continue;
        }
        misses = 0;
        main.push(item);
        used += item.durationSec;
    }

    const items = [...warmup, ...main, ...push, ...cooldown];
    const notes = [];
    if (!main.length) {
        return {
            ok: false, reason: "nothingNear", targets,
            message: t("session.err.nothingNear", { lo: targets[0].lo.toFixed(2), hi: targets[0].hi.toFixed(2) }),
        };
    }
    if (used < sec * 0.75) notes.push("short");
    if (!warmup.length) notes.push("noWarmup");
    if (!push.length) notes.push("noPush");
    if (main.length < 2) notes.push("fewNear");
    return { ok: true, items, totalSec: round2(used), requestedSec: sec, targets, notes, seed };
}

// Another map for one item of a session: the same slot, none of the session's maps, none shown there before
// (shown: ids), a little further from the slot's dan when nothing else is that close. → the new item, or null.
export function rerollItem({ maps, session, index, request, recent = new Set(), shown = [], seed = 1 }) {
    const old = session?.items?.[index];
    if (!old) return null;
    const usable = (maps ?? []).filter((m) => finite(m?.numeric) !== null && m.id)
        .map((m) => ({ ...m, songKey: songKey(m), patterns: mapPatterns(m) }));
    const others = session.items.filter((_, i) => i !== index);
    const byId = new Map(usable.map((m) => [m.id, m]));
    const ctx = {
        maps: usable,
        taken: new Set([...session.items.map((x) => x.mapId), ...shown]),
        songs: new Set(others.map((x) => byId.get(x.mapId)?.songKey).filter(Boolean)),
        allowRates: request.allowRates,
        recent: request.avoidRecent ? recent : new Set(),
        random: seeded(seed),
    };
    // nothing else that close: a little further from the slot's dan, rather than no other map at all
    const found = pick(old.slot, ctx) ?? pick(old.slot, { ...ctx, widen: REROLL_WIDEN });
    return found ? itemOf(old.slot, found, request.patternIds) : null;
}

// The total length of a list of items, in seconds.
export const sessionSeconds = (items) => round2((items ?? []).reduce((s, x) => s + (Number(x.durationSec) || 0), 0));

// The default name of a session: "Session 26.10 · Jumpstream 30 min".
export function sessionName({ patternIds, minutes }, date = new Date()) {
    const day = `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
    const names = (patternIds ?? []).map((id) => patternById(id)?.name).filter(Boolean).join(" + ");
    return t("session.defaultName", { date: day, patterns: names || REC_PATTERNS[0].name, min: minutes });
}
