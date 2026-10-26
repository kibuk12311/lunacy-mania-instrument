// The Dan widget's data, kept pure so it can be tested: what main sends the widget with its config (the map's dan at
// the play's rate from the card's analysis, the dan along the map, "for you" against the player's profile, whether the
// local profile records) and what the widget works out from it every frame (the dan at the play position, the play's
// own performance dan on the results screen), plus the words it shows.
//
// The dan along the map: the card's difficulty line (src/analysis/timeline.js computeDetails: Sunny's strain, the
// highest per bin, scaled to the map's own peak) turned into dans around the map's dan. The map's dan stands for its
// hard part (the strain's SECTION_REF quantile, breaks left out); every other part is moved by SECTION_SLOPE dans per
// unit of log strain — what a rate change does to a dan against what it does to Sunny's strain (synthetic 4K streams,
// jumpstreams and jacks at 0.9–1.2×, dan 5–17: 14–17 dans per unit) — and kept within [dan − SECTION_BELOW, dan +
// SECTION_ABOVE]. A bin under BREAK_STRAIN of the peak is a break (null). It is an estimate of "how hard here", not a
// dan of its own: no section is rated by the model.
import { t } from "../i18n/i18n.js";
import { confidenceWord, labelBeside, labelKey, numericToLabel } from "../core/labels.js";
import { performanceDan } from "../localProfile/model.js";
import { fitForSkill } from "../analysis/mapFit.js";

export const SECTION_SLOPE = 14;
export const SECTION_REF = 0.9;
export const SECTION_BELOW = 8;
export const SECTION_ABOVE = 2;
export const BREAK_STRAIN = 0.08;
// the payload's states: a dan, still being worked out, or why there is none
export const DAN_STATES = ["ok", "counting", "notMania", "not4k", "ln", "short", "none"];

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// "<checksum>|<rate>": one map at one rate (the rate to two decimals, as the card keys it)
export const danKey = (checksum, rate) => `${checksum}|${(Math.round((Number(rate) > 0 ? Number(rate) : 1) * 100) / 100).toFixed(2)}`;

// The card's analysis result → the widget's state for it.
export function danStateOf(result) {
    if (!result) return "counting";
    if (result.kind === "ok" && finite(result.numeric) !== null) return "ok";
    if (result.kind === "not-rice") return result.reason === "mode" ? "notMania" : result.reason === "ln" ? "ln" : "not4k";
    if (result.kind === "too-short") return "short";
    return "none";
}

function quantile(values, q) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

// details.strain (each bin 0..1 of the map's peak) and the map's dan → a dan per bin (one decimal), null for breaks;
// null without a strain line.
export function sectionDans(strain, mapDan, { slope = SECTION_SLOPE, ref = SECTION_REF, below = SECTION_BELOW, above = SECTION_ABOVE, breakAt = BREAK_STRAIN } = {}) {
    const dan = finite(mapDan);
    if (dan === null || !Array.isArray(strain) || !strain.length) return null;
    const values = strain.map((v) => finite(Number(v)) ?? 0);
    const played = values.filter((v) => v >= breakAt);
    const level = quantile(played, ref);
    if (!(level > 0)) return null;
    const lo = Math.max(0, dan - below);
    const hi = dan + above;
    return values.map((v) => (v < breakAt ? null : round1(clamp(dan + slope * Math.log(v / level), lo, hi))));
}

// How far into the map the play is (0..1) at map time clock: the payload's firstMs / lastMs are the first and last
// note on the play's clock (osu!: the .osu's own times; Interlude: 0 at the first note).
export function danProgress(payload, clock) {
    const first = finite(payload?.firstMs);
    const last = finite(payload?.lastMs);
    if (first === null || last === null || !(last > first) || finite(clock) === null) return 0;
    return clamp((clock - first) / (last - first), 0, 1);
}

// The dan at a point of the map (progress 0..1): the mean of the sections within ±spread bins, breaks left out;
// null in a break (or without sections).
export function danAt(sections, progress, spread = 2) {
    const n = sections?.length ?? 0;
    if (!n) return null;
    const i = Math.round(clamp(progress, 0, 1) * (n - 1));
    if (sections[i] === null) return null;
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - spread); j <= Math.min(n - 1, i + spread); j += 1) {
        if (sections[j] === null) continue;
        sum += sections[j];
        count += 1;
    }
    return count ? round1(sum / count) : null;
}

// The play's performance dan (the local profile's model) from the results screen's judgements, or null: no map dan,
// no judgements, autoplay-like mods.
export function playDanOf(payload, hits, mods = []) {
    if (payload?.state !== "ok" || finite(payload.numeric) === null || !hits) return null;
    const total = ["max", "n300", "n200", "n100", "n50", "miss"].reduce((s, k) => s + (Number(hits[k]) || 0), 0);
    if (!total) return null;
    return performanceDan({ outcome: "pass", hits, mods }, { kind: "ok", numeric: payload.numeric })?.dan ?? null;
}

// +0.4, −0.7 (a minus sign), ±0.0
export function signedDan(x) {
    const text = Math.abs(x).toFixed(1);
    if (text === "0.0") return "±0.0";
    return x > 0 ? `+${text}` : `−${text}`;
}

// ---- words ----

// The dan as the widget's head shows it: { number: "13.0", label: "Gamma mid" } (past Kappa high "выше Kappa" beside
// the number), and as one line: "Gamma mid · 13.0", "выше Kappa · 21.3".
export function danHead(n) {
    const v = finite(n);
    if (v === null) return { number: "—", label: "—", line: "—" };
    const label = labelBeside(v);
    return { number: v.toFixed(1), label, line: labelKey(v) === "above" ? numericToLabel(v).text : `${label} · ${v.toFixed(1)}` };
}

// why a map has no dan, in words («считаем…», «не 4K» …); "" for "ok"
export function danStateText(state) {
    switch (state) {
        case "ok": return "";
        case "counting": return t("overlay.dan.counting");
        case "notMania": return t("overlay.dan.notMania");
        case "not4k": return t("overlay.dan.not4k");
        case "ln": return t("overlay.dan.ln");
        case "short": return t("overlay.dan.short");
        default: return t("overlay.dan.none");
    }
}

// the main pattern: "Jumpstream", "Jumpstream · tech"; "" without one
export function patternText(payload) {
    const name = typeof payload?.primary === "string" ? payload.primary : "";
    if (!name) return payload?.tech ? "Tech" : "";
    return payload.tech ? `${name} · tech` : name;
}

export const confidenceText = (level) => (level ? t("overlay.dan.confidence", { word: confidenceWord(level) }) : "");

// «сейчас: Gamma high», «сейчас: перерыв»
export const nowText = (dan) => (finite(dan) === null ? t("overlay.dan.nowBreak") : t("overlay.dan.now", { label: numericToLabel(dan).text }));

// «+0.8 к твоему уровню»; "" without a fit
export const forYouText = (fit) => (fit && finite(fit.delta) !== null ? t("overlay.dan.forYou", { delta: signedDan(fit.delta) }) : "");

// «эта игра: Gamma low/mid»
export const playText = (dan) => (finite(dan) === null ? "" : t("overlay.dan.play", { label: numericToLabel(dan).text }));

// Everything the widget writes for a payload and a snapshot: { state, number, label, line, confidence, pattern, now,
// nowDan, progress, forYou, band, play, playDan, results }. payload: the config's dan (or the fake one).
export function danView(payload, snapshot) {
    const state = DAN_STATES.includes(payload?.state) ? payload.state : "counting";
    const results = snapshot?.phase === "results";
    const progress = results ? 1 : danProgress(payload, snapshot?.clock);
    if (state !== "ok") {
        const text = danStateText(state);
        return { state, number: "—", label: text, line: text, confidence: "", pattern: "", now: "", nowDan: null, progress, forYou: "", band: null, play: "", playDan: null, results };
    }
    const head = danHead(payload.numeric);
    const nowDan = Array.isArray(payload.sections) ? danAt(payload.sections, progress) : null;
    const hasSections = Array.isArray(payload.sections) && payload.sections.length > 0;
    const playDan = (results || payload.preview) && payload.recording ? playDanOf(payload, snapshot?.hits, snapshot?.mods) : null;
    return {
        state,
        number: head.number,
        label: head.label,
        line: head.line,
        confidence: confidenceText(payload.confidenceLevel),
        pattern: patternText(payload),
        now: hasSections ? nowText(nowDan) : "",
        nowDan,
        progress,
        forYou: forYouText(payload.fit),
        band: payload.fit?.band ?? null,
        play: playText(playDan),
        playDan,
        results,
    };
}

// ---- the payload (main) ----

// A profile's skill as the renderer sends it, kept to numbers: { overall, tiles: { speed, … }, msd: { Stream, … } }.
export function cleanSkill(skill) {
    if (!skill || typeof skill !== "object") return null;
    const numbers = (o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {})
        .filter(([k, v]) => typeof k === "string" && k.length <= 32 && finite(v) !== null).slice(0, 16));
    const out = { overall: finite(skill.overall), tiles: numbers(skill.tiles), msd: numbers(skill.msd) };
    return out.overall === null && !Object.keys(out.tiles).length ? null : out;
}

// What main sends the Dan widget for the map of a play: { key, checksum, rate, state } and, with a dan, the numbers,
// the main pattern, the confidence, the dan along the map (sections, firstMs, lastMs), the fit to the player's skill
// and whether plays are recorded (the play's own dan). entry: createDanSource()'s; mode: the play's (3 = mania).
export function buildDanPayload({ checksum, rate = 1, mode = 3, entry = null, skill = null, recording = false }) {
    const key = danKey(checksum, rate);
    const base = { key, checksum, rate: Number(rate) > 0 ? Number(rate) : 1 };
    if (mode !== 3 && mode !== null && mode !== undefined) return { ...base, state: "notMania" };
    const r = entry?.result ?? null;
    const state = danStateOf(r);
    if (state !== "ok") return { ...base, state };
    const fit = skill ? fitForSkill(r, skill) : null;
    return {
        ...base,
        state,
        numeric: r.numeric,
        primary: typeof r.primary === "string" ? r.primary : null,
        tech: r.tech === true,
        confidenceLevel: ["high", "medium", "low"].includes(r.confidenceLevel) ? r.confidenceLevel : null,
        sections: Array.isArray(entry.sections) ? entry.sections : null,
        firstMs: finite(entry.firstMs),
        lastMs: finite(entry.lastMs),
        fit: fit ? { delta: fit.delta, playerDan: fit.playerDan, band: fit.band, source: fit.source, tile: fit.tile } : null,
        recording: recording === true,
    };
}
