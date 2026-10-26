// «Автоподбор» (0.9.8): everything the create tab asks for, decided from the loaded song and the player.
// - the dan: the player's dan (the profile in use: mania-tracker, hand-set or local; the tile of the song's main
//   pattern when the profile has it, else the overall dan) in the Analysis tab's "for you" growth band (−0.1 … +0.5,
//   src/analysis/mapFit.js bandFor); without a profile a dan from the song's tempo and how busy it is;
// - per song part, the pattern from the stems (src/audio/stems.js curves) and the loudness: drums (kick + snare) →
//   chordjack, a busy kick → jacks, fast hats → stream, melodic parts → jumpstream / handstream (loud) / tech (quieter);
//   without stems, by loudness alone; quiet parts (and quiet intros, breaks and outros) get an easier range of their
//   own, at most MAX_OWN_RANGES of them;
// - the model: the neural M (or S) when the graphics card and the stems are there, else XGBoost v3 with stems, else
//   the classic model; the critic picks from AUTO_CANDIDATES candidates when critic.json is there; repeats with stems;
//   the grids 1/4 and 1/8 (the triplet grids too for a model with a divisor head);
// - LNs: the generator and the dan analyser are rice only, so none; parts with long sustained sound are named in the
//   summary so the player knows why.
// Pure: no DOM; the renderer's «Автоподбор» (app/renderer/autoPick.js) fills the normal controls from it.
import { t } from "../i18n/i18n.js";
import { numericToLabel } from "../core/labels.js";

export const AUTO_CANDIDATES = 4;
export const MAX_OWN_RANGES = 8;
export const AUTO_FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
// the growth band of the "for you" line: the map a little over the player's dan
export const GROWTH = Object.freeze({ lo: -0.1, hi: 0.5 });
const EASY_DROP = 2; // dans off for a quiet part
const QUIET = 0.5; // a part this loud (against the loudest) or quieter is a quiet one
const QUIET_EDGE = 0.65; // an intro, break or outro this quiet is one too
const MIN_DAN = 1;
const MAX_DAN = 20;
// the dan without a profile: from the tempo, ± how busy the song is
const SONG_DAN = Object.freeze({ base: 2, perBpm: 1 / 22, min: 4, max: 12, busy: 2 });
// pattern rules over a part's stem means (each 0..1 on the song's own scale)
const RULES = Object.freeze({ drums: 0.6, perc: 0.5, kickBusy: 1.6, hatFast: 1.5, harm: 0.45, handLoud: 0.85, jumpLoud: 0.6, sustainHarm: 0.5, sustainOnsets: 0.35 });

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// The dan's label scale: a numeric dan → { level, step } (src/core/labels.js steps).
export function levelStepOf(n) {
    const v = clamp(n, MIN_DAN - 0.4, MAX_DAN + 0.4);
    const level = clamp(Math.round(v), MIN_DAN, MAX_DAN);
    const d = Math.round((v - level) * 1e6) / 1e6;
    const step = d <= -0.3 ? "low" : d <= -0.1 ? "low/mid" : d <= 0.1 ? "mid" : d <= 0.3 ? "mid/high" : "high";
    return { level, step };
}

// The tile a pattern family is played on in the profile (src/recommend/catalog.js tiles).
const TILE_OF = { Stream: "speed", Jumpstream: "speed", Handstream: "stamina", Chordjack: "jack", Jack: "jack", Tech: "tech" };

// The player's dan for a family: the profile's tile when it has one, else its overall dan; null without a dan.
export function playerDan(skill, family = null) {
    if (!skill) return null;
    const tile = family ? finite(skill.tiles?.[TILE_OF[family]]) : null;
    return tile ?? finite(skill.overall);
}

// Mean of a frame curve over [startMs, endMs); hopSec / offsetSec: the curve's frame grid.
function meanOver(curve, hopSec, offsetSec, startMs, endMs) {
    if (!curve?.length || !(hopSec > 0)) return null;
    const a = Math.max(0, Math.floor((startMs / 1000 - offsetSec) / hopSec));
    const b = Math.min(curve.length, Math.ceil((endMs / 1000 - offsetSec) / hopSec));
    if (b <= a) return null;
    let s = 0;
    for (let f = a; f < b; f += 1) s += curve[f];
    return s / (b - a);
}

// Local peaks of a curve over `floor` in [startMs, endMs), per beat.
function peaksPerBeat(curve, hopSec, offsetSec, startMs, endMs, beatMs, floor = 0.3) {
    if (!curve?.length || !(hopSec > 0) || !(beatMs > 0)) return null;
    const a = Math.max(1, Math.floor((startMs / 1000 - offsetSec) / hopSec));
    const b = Math.min(curve.length - 1, Math.ceil((endMs / 1000 - offsetSec) / hopSec));
    let n = 0;
    for (let f = a; f < b; f += 1) if (curve[f] > floor && curve[f] >= curve[f - 1] && curve[f] > curve[f + 1]) n += 1;
    return n / Math.max(1, (endMs - startMs) / beatMs);
}

const envelopeHop = (env) => (finite(env?.hopSec) ?? (typeof env?.frameTimeSec === "function" ? env.frameTimeSec(1) - env.frameTimeSec(0) : null));
const envelopeOffset = (env) => (typeof env?.frameTimeSec === "function" ? env.frameTimeSec(0) : finite(env?.frameOffsetSec) ?? 0);

// What each part sounds like: { loud (0..1 against the loudest part), onsets (peaks per beat), drums, kick, hat, harm,
// perc, kickBeat, hatBeat } — the stem keys null without stems.
export function partFeatures({ parts, envelope, stems = null, bpm }) {
    const beatMs = 60000 / (finite(bpm) ?? 120);
    const eHop = envelopeHop(envelope);
    const eOff = envelopeOffset(envelope);
    const sHop = finite(stems?.hopSec);
    const sOff = finite(stems?.frameOffsetSec) ?? 0;
    const raw = parts.map((p) => {
        const s = (key) => (stems ? meanOver(stems[key], sHop, sOff, p.startMs, p.endMs) : null);
        const kick = s("kick");
        const snare = s("snare");
        return {
            energy: meanOver(envelope?.values, eHop, eOff, p.startMs, p.endMs) ?? 0,
            onsets: peaksPerBeat(envelope?.values, eHop, eOff, p.startMs, p.endMs, beatMs, 0) ?? 0,
            kick, snare, hat: s("hat"), harm: s("harm"), perc: s("percShare"),
            kickBeat: stems ? peaksPerBeat(stems.kick, sHop, sOff, p.startMs, p.endMs, beatMs) : null,
            hatBeat: stems ? peaksPerBeat(stems.hat, sHop, sOff, p.startMs, p.endMs, beatMs) : null,
        };
    });
    const top = (key) => Math.max(1e-6, ...raw.map((r) => r[key] ?? 0));
    const loudTop = top("energy");
    const drumTop = Math.max(1e-6, ...raw.map((r) => ((r.kick ?? 0) + (r.snare ?? 0)) / 2));
    const harmTop = top("harm");
    const onsetTop = top("onsets");
    return raw.map((r) => ({
        loud: r.energy / loudTop,
        onsets: r.onsets / onsetTop,
        drums: stems ? ((r.kick ?? 0) + (r.snare ?? 0)) / 2 / drumTop : null,
        harm: stems ? (r.harm ?? 0) / harmTop : null,
        perc: r.perc,
        kickBeat: r.kickBeat,
        hatBeat: r.hatBeat,
    }));
}

// One part's pattern family from its features (partFeatures), by the rules at the top of the file.
export function familyForPart(f, kind = "part") {
    if (f.drums === null || f.drums === undefined) {
        // no stems: loud parts jumpstream, the rest stream
        return f.loud >= RULES.jumpLoud && kind !== "intro" && kind !== "outro" ? "Jumpstream" : "Stream";
    }
    const percussive = (f.perc ?? 0) >= RULES.perc;
    if (f.drums >= RULES.drums && percussive && f.loud >= RULES.jumpLoud) return (f.kickBeat ?? 0) >= RULES.kickBusy ? "Jack" : "Chordjack";
    if ((f.hatBeat ?? 0) >= RULES.hatFast && percussive) return "Stream";
    if ((f.harm ?? 0) >= RULES.harm && !percussive) {
        if (f.loud >= RULES.handLoud) return "Handstream";
        if (f.loud >= RULES.jumpLoud) return "Jumpstream";
        return "Tech";
    }
    if ((f.hatBeat ?? 0) >= RULES.hatFast) return "Stream";
    return f.loud >= RULES.handLoud && (f.drums ?? 0) >= RULES.drums ? "Handstream" : "Jumpstream";
}

// Long sustained sound with few attacks: melodic and quiet in onsets (where a mapper would put long notes).
const sustained = (f) => f.harm !== null && f.harm >= RULES.sustainHarm && f.onsets <= RULES.sustainOnsets;

// The dan without a profile: the tempo's dan, ± how busy the song is (its mean onsets against its busiest part).
export function songDan({ bpm, features = [] }) {
    const b = finite(bpm) ?? 150;
    const busy = features.length ? features.reduce((s, f) => s + f.onsets * f.loud, 0) / features.length : 0.5;
    return round1(clamp(SONG_DAN.base + b * SONG_DAN.perBpm + SONG_DAN.busy * (busy - 0.5), SONG_DAN.min, SONG_DAN.max));
}

// The model: { size, why } — the neural M (S) with the GPU and stems, else XGBoost v3 with stems, else the classic.
export function pickModel(available = {}) {
    const sizes = available.sizes ?? {};
    if (available.gpu && available.stems && sizes.m) return { size: "m", why: "gpu" };
    if (available.gpu && available.stems && sizes.s) return { size: "s", why: "gpu" };
    if (available.stems && sizes.xgb3) return { size: "xgb3", why: "stems" };
    return { size: "auto", why: "classic" };
}

// The whole plan. song: { bpm, durationMs, envelope, stems? }; parts: the timeline's [{ startMs, endMs, kind }] (none:
// the song as one part); profile: getProfile() (renderer/profile.js) or null; available: genOptions.available().
// → { target, from, to (the dan picker's two ends), wholeSong (no parts were given), source: "profile" | "song", playerDan, parts (with their
// patterns and own ranges), patterns (the whole map's shares), model, candidates, repeats, snaps, stamina, burst,
// sustained (part indexes), groups: [{ kind, family }] for the summary }.
export function autoPlan({ song, parts = [], profile = null, available = {} }) {
    const list = parts.length ? parts : [{ startMs: 0, endMs: song.durationMs, kind: "part" }];
    const features = partFeatures({ parts: list, envelope: song.envelope, stems: song.stems ?? null, bpm: song.bpm });
    const families = list.map((p, i) => familyForPart(features[i], p.kind));
    // the main family: the one of the most song time among the loud parts
    const time = {};
    list.forEach((p, i) => { if (features[i].loud > QUIET) time[families[i]] = (time[families[i]] ?? 0) + (p.endMs - p.startMs); });
    const main = Object.keys(time).sort((a, b) => time[b] - time[a])[0] ?? families[0];

    const skill = profile?.state === "ready" ? profile.skill : null;
    const pDan = playerDan(skill, main);
    const source = pDan !== null ? "profile" : "song";
    const target = round1(clamp(pDan !== null ? pDan + (GROWTH.lo + GROWTH.hi) / 2 : songDan({ bpm: song.bpm, features }), MIN_DAN, MAX_DAN));
    const from = levelStepOf(pDan !== null ? pDan + GROWTH.lo + 0.1 : target - 0.2);
    const to = levelStepOf(pDan !== null ? pDan + GROWTH.hi - 0.1 : target + 0.2);

    // quiet parts (the quietest first) get an easier range of their own
    const quiet = list.map((p, i) => i).filter((i) => features[i].loud <= QUIET || (["intro", "break", "outro"].includes(list[i].kind) && features[i].loud <= QUIET_EDGE));
    quiet.sort((a, b) => features[a].loud - features[b].loud);
    const easy = new Set(quiet.slice(0, MAX_OWN_RANGES).filter(() => list.length > 1));
    const easyDan = Math.max(MIN_DAN, target - EASY_DROP);
    const planned = list.map((p, i) => ({
        startMs: p.startMs, endMs: p.endMs, kind: p.kind,
        patterns: [{ name: families[i], share: 1 }],
        ...(easy.has(i) ? { range: { lo: round1(easyDan - 0.5), hi: round1(easyDan + 0.5) } } : {}),
    }));
    const shares = {};
    list.forEach((p, i) => { shares[families[i]] = (shares[families[i]] ?? 0) + (p.endMs - p.startMs); });
    const total = Object.values(shares).reduce((a, b) => a + b, 0) || 1;
    const patterns = AUTO_FAMILIES.filter((f) => shares[f]).map((name) => ({ name, share: Math.round((shares[name] / total) * 100) }));

    const model = pickModel(available);
    const stems = Boolean(song.stems);
    const dynamic = quiet.length / list.length;
    // the summary's groups: per kind (in song order) the family of most of its time
    const groups = [];
    for (const kind of [...new Set(list.map((p) => p.kind))]) {
        const byFamily = {};
        list.forEach((p, i) => { if (p.kind === kind) byFamily[families[i]] = (byFamily[families[i]] ?? 0) + (p.endMs - p.startMs); });
        groups.push({ kind, family: Object.keys(byFamily).sort((a, b) => byFamily[b] - byFamily[a])[0] });
    }
    return {
        target, from, to, source, playerDan: pDan, wholeSong: !parts.length,
        parts: planned, patterns, main, groups,
        model: model.size, modelWhy: model.why,
        candidates: available.critic ? AUTO_CANDIDATES : 1,
        repeats: stems,
        snaps: model.size === "auto" ? [4, 8] : [4, 3, 6, 8],
        stamina: dynamic > 0.4 ? 0.4 : 0.55,
        burst: 0.3,
        sustained: list.map((_, i) => i).filter((i) => sustained(features[i])),
    };
}

// «Автоподбор: Gamma mid · дроп — джампстрим, куплет — стрим; модель: нейросеть M». kindName(kind) and modelName(size)
// come from the renderer (the timeline's part names, the model picker's).
const FAMILY_KEYS = {
    Stream: "create.auto.family.Stream", Jumpstream: "create.auto.family.Jumpstream", Handstream: "create.auto.family.Handstream",
    Chordjack: "create.auto.family.Chordjack", Jack: "create.auto.family.Jack", Tech: "create.auto.family.Tech",
};
export function autoSummary(plan, { kindName = (k) => k, modelName = (s) => s } = {}) {
    const dan = numericToLabel(plan.target, { number: false }).text;
    const fam = (f) => t(FAMILY_KEYS[f] ?? FAMILY_KEYS.Jumpstream);
    const groups = plan.groups.map((g) => (plan.groups.length > 1 ? `${kindName(g.kind)} — ${fam(g.family)}` : fam(g.family))).join(", ");
    const lines = [t("create.auto.summary", { dan, groups, model: modelName(plan.model) })];
    lines.push(t(plan.source === "profile" ? "create.auto.fromProfile" : "create.auto.fromSong", { dan: Number.isFinite(plan.playerDan) ? numericToLabel(plan.playerDan, { number: false }).text : "" }));
    if (plan.sustained.length) lines.push(t("create.auto.noLn"));
    return lines;
}
