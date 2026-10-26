// The blocks under the analysis card as HTML (pure, so they can be tested in Node): the difficulty line and pattern
// strip from the details job, "for you" against the player's mania-tracker dan, and the dan at other rates.
// Everything that comes from outside is escaped. Clicks are handled in analysisPanel.js through data-* attributes.
import { t } from "../../src/i18n/i18n.js";
import { numericToLabel } from "../../src/core/labels.js";
import { BREAK, FAMILIES, familyShares } from "../../src/analysis/families.js";
import { fitForSkill, growthRate } from "../../src/analysis/mapFit.js";
import { TILE_NAMES } from "../../src/recommend/catalog.js";
import { formatDuration } from "./view.js";
import { isDetailed, patternModeHtml } from "./patternMode.js";
import { FLAVOUR_FAMILY, flavourName, isFlavour } from "../../src/gen/flavours.js";

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const LADDER_RATES = [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
// pattern names stay English in both languages, as in the card's bars
const FAMILY_NAMES = { stream: "Stream", jumpstream: "Jumpstream", handstream: "Handstream", chordjack: "Chordjacks", jack: "Jacks", tech: "Tech" };
const BAND_KEYS = {
    easy: "analysis.fit.band.easy",
    comfort: "analysis.fit.band.comfort",
    growth: "analysis.fit.band.growth",
    challenge: "analysis.fit.band.challenge",
    hard: "analysis.fit.band.hard",
};
const H = 34; // the line's height in px, also its viewBox height
const NAME_SLOT = "\uE000"; // stands in for the nick while the heading is escaped

const rateKey = (rate) => Math.round(Number(rate) * 100) / 100;
// 1 → "1.0", 1.15 → "1.15"
export const formatRate = (rate) => rateKey(rate).toFixed(2).replace(/0$/, "");
// +0.4, −0.7 (a minus sign, not a hyphen), ±0.0
function signed(x) {
    const text = Math.abs(x).toFixed(1);
    if (text === "0.0") return "±0.0";
    return x > 0 ? `+${text}` : `−${text}`;
}

// The ladder's rates: LADDER_RATES with the current rate in its place when it is not one of them.
export function ladderRates(currentRate) {
    const rates = [...LADDER_RATES];
    const current = rateKey(currentRate);
    if (Number.isFinite(current) && current >= 0.5 && current <= 2 && !rates.includes(current)) rates.push(current);
    return rates.sort((a, b) => a - b);
}

// ---- the difficulty line ----

// bins [a, b] a stretch in seconds covers
function binsOf(range, n, durationSec) {
    const a = Math.max(0, Math.floor((range.fromSec / durationSec) * n + 1e-6));
    const b = Math.min(n - 1, Math.ceil((range.toSec / durationSec) * n - 1e-6) - 1);
    return [a, Math.max(a, b)];
}

function areaPath(strain, from, to) {
    const y = (v) => (H - Math.max(0, Math.min(1, Number(v) || 0)) * (H - 2)).toFixed(1);
    const points = [];
    for (let i = from; i <= to; i += 1) points.push(`L${i + 0.5} ${y(strain[i])}`);
    return `M${from} ${H} L${from} ${y(strain[from])} ${points.join(" ")} L${to + 1} ${y(strain[to])} L${to + 1} ${H} Z`;
}

// The strain as an area over the map's length, its hardest stretches filled apart; "" without data.
export function strainSvg(strain, hardest, durationSec) {
    const n = strain?.length ?? 0;
    if (!n || !(durationSec > 0)) return "";
    const hot = (hardest ?? []).map((range) => {
        const [a, b] = binsOf(range, n, durationSec);
        return `<path class="an-tl-hot" d="${areaPath(strain, a, b)}"/>`;
    }).join("");
    return `<svg class="an-tl-svg" viewBox="0 0 ${n} ${H}" preserveAspectRatio="none" aria-hidden="true">`
        + `<path class="an-tl-area" d="${areaPath(strain, 0, n - 1)}"/>${hot}</svg>`;
}

// One coloured run per stretch of the same family, on the line's time axis.
export function familyStrip(families) {
    const runs = [];
    for (const raw of families ?? []) {
        const family = FAMILIES.includes(raw) ? raw : BREAK;
        if (runs.length && runs.at(-1).family === family) runs.at(-1).n += 1;
        else runs.push({ family, n: 1 });
    }
    if (!runs.length) return "";
    const items = runs.map(({ family, n }) => {
        const name = family === BREAK ? t("analysis.extras.break") : FAMILY_NAMES[family];
        const cls = family === BREAK ? "fam-break" : `fam-${family}`;
        return `<i class="${cls}" style="flex-grow:${n}" title="${escape(name)}"></i>`;
    }).join("");
    return `<div class="an-fam" role="img" aria-label="${escape(t("analysis.extras.strip"))}">${items}</div>`;
}

// The flavours along the map (the Detailed mode): one run per stretch of the same flavour, in its family's colour,
// a thin edge where one flavour gives way to another of the same family.
export function flavourStrip(bins) {
    const runs = [];
    for (const raw of bins ?? []) {
        const id = isFlavour(raw) ? raw : BREAK;
        if (runs.length && runs.at(-1).id === id) runs.at(-1).n += 1;
        else runs.push({ id, n: 1 });
    }
    if (!runs.length) return "";
    const items = runs.map(({ id, n }, k) => {
        if (id === BREAK) return `<i class="fam-break" style="flex-grow:${n}" title="${escape(t("analysis.extras.break"))}"></i>`;
        const family = FLAVOUR_FAMILY[id].toLowerCase();
        const edge = k > 0 && runs[k - 1].id !== BREAK && FLAVOUR_FAMILY[runs[k - 1].id] === FLAVOUR_FAMILY[id] ? " fl-edge" : "";
        return `<i class="fam-${family}${edge}" style="flex-grow:${n}" title="${escape(flavourName(id))}"></i>`;
    }).join("");
    return `<div class="an-fam" role="img" aria-label="${escape(t("analysis.extras.flavourStrip"))}">${items}</div>`;
}

// Rolls 40% · Anchors 25%: the three largest flavours of the map by our detector.
export function flavourLegend(flavours) {
    const top = (flavours ?? []).filter((f) => isFlavour(f.id)).slice(0, 3);
    if (!top.length) return "";
    const items = top.map(({ id, share }) => `<span><i class="fam-${FLAVOUR_FAMILY[id].toLowerCase()}"></i>${escape(flavourName(id))} ${Math.round(share * 100)}%</span>`);
    return `<div class="an-legend">${items.join("")}</div>`;
}

// "Jumpstream 46% · Handstream 22% · Tech 9%": the three largest families.
export function familyLegend(families) {
    const top = familyShares(families).slice(0, 3);
    if (!top.length) return "";
    const items = top.map(({ family, share }) => `<span><i class="fam-${family}"></i>${escape(FAMILY_NAMES[family])} ${Math.round(share * 100)}%</span>`);
    return `<div class="an-legend">${items.join("")}</div>`;
}

function timelineBlock(details) {
    const svg = strainSvg(details?.strain, details?.hardest, details?.durationSec);
    if (!svg) return "";
    const top = details.hardest?.[0];
    const span = top ? { from: formatDuration(top.fromSec), to: formatDuration(top.toSec) } : null;
    const hint = span ? t("analysis.extras.hint", span) : t("analysis.extras.flat");
    const chip = span ? `<span class="an-chip">${escape(t("analysis.extras.peak", span))}</span>` : "";
    // Detailed: the flavours (details from before flavours have none, so they keep the families)
    const detailed = isDetailed() && Array.isArray(details.flavourBins);
    return `<div class="an-tl" title="${escape(hint)}">`
        + `<div class="an-head"><span class="an-title">${escape(t("analysis.extras.title"))}</span>${chip}${patternModeHtml()}</div>`
        + svg + (detailed ? flavourStrip(details.flavourBins) : familyStrip(details.families))
        + `<div class="an-axis"><span>0:00</span><span>${escape(formatDuration(details.durationSec))}</span></div>`
        + (detailed ? flavourLegend(details.flavours) : familyLegend(details.families))
        + `</div>`;
}

// ---- for you ----

// The "for you" lines for a fit (mapFit.fitForSkill) and the profile state (renderer/profile.js getProfile()).
export function forYouLine(fit, profileState) {
    const state = profileState?.state;
    if (state === "loading") return `<div class="an-foryou an-muted">${escape(t("analysis.fit.loading"))}</div>`;
    if (state === "failed") return `<div class="an-foryou an-muted">${escape(t("app.shared.profileFailed", { message: profileState.message ?? "" }))}</div>`;
    if (state === "none") {
        return `<div class="an-foryou"><button type="button" class="an-link" data-go="recommend">${escape(t("analysis.fit.noProfile"))}</button></div>`;
    }
    if (state !== "ready") return "";
    // the nick keeps its own letter case under the upper-case heading
    const name = `<span class="an-name">${escape(profileState.player?.username ?? "")}</span>`;
    const head = `<div class="an-title">${escape(t("analysis.fit.title", { name: NAME_SLOT })).replace(NAME_SLOT, name)}</div>`;
    if (!fit) return `<div class="an-foryou">${head}<div class="an-muted">${escape(t("analysis.fit.noDan"))}</div></div>`;
    const who = fit.source === "tile" ? t("analysis.fit.tile", { tile: TILE_NAMES[fit.tile] ?? fit.tile }) : t("analysis.fit.overall");
    const line = t("analysis.fit.line", {
        who,
        label: numericToLabel(fit.playerDan).text,
        dan: fit.playerDan.toFixed(1),
        delta: signed(fit.delta),
        band: t(BAND_KEYS[fit.band]),
    });
    const msd = fit.msd
        ? `<div class="an-msd">${escape(t("analysis.fit.msd", { axis: fit.msd.axis, map: fit.msd.map.toFixed(1), player: fit.msd.player.toFixed(1), d: signed(fit.msd.delta) }))}</div>`
        : "";
    return `<div class="an-foryou">${head}<div class="an-fit an-band-${escape(fit.band)}">${escape(line)}</div>${msd}</div>`;
}

// ---- the ladder ----

// rows [{ rate, state: "ok"|"pending"|"fail", numeric? }] → one button per rate; deltas are from the 1.0x row.
export function ladderRows(rows, { currentRate = null, growthRate: growth = null } = {}) {
    const base = rows.find((r) => rateKey(r.rate) === 1 && r.state === "ok" && Number.isFinite(r.numeric));
    const hint = escape(t("analysis.ladder.hint"));
    return rows.map((row) => {
        const rate = rateKey(row.rate);
        const now = currentRate !== null && rate === rateKey(currentRate);
        const grows = growth !== null && rate === rateKey(growth);
        const ok = row.state === "ok" && Number.isFinite(row.numeric);
        const name = ok ? numericToLabel(row.numeric).text : row.state === "pending" ? t("analysis.ladder.counting") : "—";
        const delta = ok && base && rate !== 1 ? signed(row.numeric - base.numeric) : "";
        // the marks follow the dan's name in its own column, so the numbers stay in line
        const tags = [now ? `<em class="an-now">${escape(t("analysis.ladder.now"))}</em>` : "", grows ? `<em class="an-grow">${escape(t("analysis.ladder.growth"))}</em>` : ""].join("");
        const cls = ["an-lrow", now ? "an-lnow" : "", grows ? "an-lgrow" : ""].filter(Boolean).join(" ");
        return `<button type="button" class="${cls}" data-rate="${rate}" title="${hint}">`
            + `<span class="an-lrate">${formatRate(rate)}×</span>`
            + `<span class="an-ldan"><span class="an-lname${ok ? "" : " an-muted"}">${escape(name)}</span>${tags}</span>`
            + `<span class="an-lnum">${ok ? row.numeric.toFixed(1) : ""}</span><span class="an-ldelta">${escape(delta)}</span></button>`;
    }).join("");
}

function ladderBlock({ result, ladder, ladderOpen, fit }) {
    const head = `<button type="button" class="an-ltoggle" data-toggle="ladder" aria-expanded="${ladderOpen ? "true" : "false"}">`
        + `${escape(t("analysis.ladder.title"))} ${ladderOpen ? "▾" : "▸"}</button>`;
    if (!ladderOpen) return `<div class="an-ladder">${head}</div>`;
    const current = rateKey(result.rate ?? 1);
    const rows = ladderRates(current).map((rate) => {
        if (rate === current) return { rate, state: "ok", numeric: result.numeric };
        const row = ladder?.get(rate);
        return { rate, state: row?.state ?? "pending", numeric: row?.numeric };
    });
    const growth = fit ? growthRate(rows.filter((r) => r.state === "ok"), fit.playerDan) : null;
    return `<div class="an-ladder open">${head}<div class="an-lrows">${ladderRows(rows, { currentRate: current, growthRate: growth })}</div></div>`;
}

// state: { view, compact, details (for view.key, or null), profile (getProfile()), ladder: Map rate → row, ladderOpen }
export function renderExtras(state) {
    const result = state?.view?.screen === "result" ? state.view.result : null;
    if (state?.compact || result?.kind !== "ok") return "";
    const profile = state.profile ?? { state: "idle" };
    const fit = profile.state === "ready" ? fitForSkill(result, profile.skill) : null;
    // the ladder asks main by the map's key: a view without one cannot have it
    const ladder = state.view.key ? ladderBlock({ result, ladder: state.ladder, ladderOpen: Boolean(state.ladderOpen), fit }) : "";
    const blocks = timelineBlock(state.details) + forYouLine(fit, profile) + ladder;
    return blocks ? `<div class="an-extras">${blocks}</div>` : "";
}
