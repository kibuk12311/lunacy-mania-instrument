// View object (from the selection controller) → HTML for the card. Pure, so it can be tested in Node.
import { labelBeside, confidenceLevelFor, confidenceWord } from "../../src/core/labels.js";
import { t } from "../../src/i18n/i18n.js";
import { isDetailed, patternLabel, patternsInMode } from "./patternMode.js";

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Which dan the card leads with: ours, one of the vendored calculators, or all of them side by side.
// Our own names are getters, so they are read in the language of the moment.
export const CALCS = [
    { id: "ours", get name() { return t("analysis.calc.ours"); }, get hint() { return t("analysis.calc.oursHint"); } },
    { id: "mixed", name: "Mixed", hint: "LeoBlack Mixed" },
    { id: "daniel", name: "Daniel" },
    { id: "azusa", name: "Azusa" },
    { id: "roxy", name: "Roxy" },
    { id: "companella", name: "Companella" },
    { id: "all", get name() { return t("analysis.calc.all"); }, get hint() { return t("analysis.calc.allHint"); } },
];
const DAN_CALCS = CALCS.filter((c) => c.id !== "ours" && c.id !== "all");
const MSD_NAMES = {
    overall: "Overall", stream: "Stream", jumpstream: "JS", handstream: "HS", stamina: "Stamina",
    jackspeed: "JackSpeed", chordjack: "CJ", technical: "Tech",
};

// A result can come from the cache or from before a language switch, so its words are rebuilt from its numbers:
// our label from the rounded numeric (as analyze.js does), the confidence word from its level or half width. Every
// label here sits beside its number, so "above Kappa" does not repeat it.
const ownLabel = (r) => (Number.isFinite(r.numeric) ? labelBeside(r.numeric) : r.label);
const confidenceOf = (r) => confidenceWord(r.confidenceLevel ?? confidenceLevelFor(r.halfWidth));

// { label, numeric } of a calculator, or null when it has no estimate for this chart.
function danOf(r, calc) {
    if (calc === "ours") return { label: ownLabel(r), numeric: r.numeric };
    const value = r.calcs?.[calc];
    return Number.isFinite(value) ? { label: labelBeside(value), numeric: value } : null;
}

function danHead(dan, tag) {
    const label = dan ? escape(dan.label) : "—";
    const numeric = dan ? dan.numeric.toFixed(1) : escape(t("analysis.noEstimate"));
    const name = tag ? `<span class="calc-tag">${escape(tag)}</span>` : "";
    return `<div class="dan"><span class="label">${label}</span><span class="numeric">${numeric}</span>${name}</div>`;
}

const skillsetEntries = (r) => Object.entries(MSD_NAMES).filter(([k]) => k !== "overall" && Number.isFinite(r.msd?.[k]));

function starsLine(r) {
    const parts = [
        Number.isFinite(r.msd?.overall) ? `MSD ${r.msd.overall.toFixed(2)}` : null,
        Number.isFinite(r.sunny) ? `Sunny ★${r.sunny.toFixed(2)}` : null,
    ].filter(Boolean);
    if (!parts.length) return "";
    const skillsets = skillsetEntries(r).map(([k, name]) => `${name} ${r.msd[k].toFixed(2)}`).join(", ");
    return `<div class="stars"${skillsets ? ` title="${escape(`MSD: ${skillsets}`)}"` : ""}>${parts.join(" · ")}</div>`;
}

function calcList(r) {
    const rows = [CALCS[0], ...DAN_CALCS].map((c) => {
        const dan = danOf(r, c.id);
        const value = dan ? `<b>${escape(dan.label)}</b><i>${dan.numeric.toFixed(1)}</i>` : `<b>—</b><i>${escape(t("analysis.noEstimate"))}</i>`;
        return `<div class="calc-row${c.id === "ours" ? " ours" : ""}"><span>${escape(c.name)}</span>${value}</div>`;
    }).join("");
    const skillsets = skillsetEntries(r).map(([k, name]) => `<span>${escape(name)} ${r.msd[k].toFixed(1)}</span>`).join("");
    return `<div class="calc-list">${rows}</div>${skillsets ? `<div class="msd-list">${skillsets}</div>` : ""}`;
}

export function formatDuration(sec) {
    const total = Math.round(sec);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const message = (text) => `<div class="message">${escape(text)}</div>`;

// A chart from Interlude the app has no file of (not in the linked library): its names as Interlude gave them, the rate
// and why there is no dan.
function externalInfo(info = {}) {
    const name = [info.artist, info.title].filter(Boolean).join(" - ") || "?";
    const rate = Number.isFinite(info.rate) && Math.abs(info.rate - 1) > 1e-6 ? ` · ${info.rate.toFixed(2).replace(/0$/, "")}×` : "";
    return `<div class="message external-info"><div class="ext-name">${escape(name)}${info.diff ? ` <span class="muted">[${escape(info.diff)}]</span>` : ""}${escape(rate)}</div>`
        + `<div class="ext-note muted">${escape(info.note ?? "")}</div></div>`;
}

function resultCard(r, compact, calc) {
    const lead = calc === "all" ? "ours" : calc;
    const own = lead === "ours";
    const head = danHead(danOf(r, lead), own ? null : CALCS.find((c) => c.id === lead).name);
    // the analyser's patterns in the General / Detailed mode: by family, or by the catalogue's kinds
    const detailed = isDetailed();
    const primary = `<div class="primary">${escape(patternLabel(r.primary, detailed) ?? "—")}</div>`;
    if (compact) return head + primary;

    const confidence = own
        ? `<div class="confidence">${escape(t("analysis.confidence", { confidence: confidenceOf(r), spread: r.halfWidth.toFixed(1) }))}</div>`
        : `<div class="versus">${escape(t("analysis.versus", { label: ownLabel(r), numeric: r.numeric.toFixed(1) }))}</div>`;
    const bars = patternsInMode(r.top3, detailed).map(({ name, share }) => {
        const pct = Math.round(share * 100);
        return `<div class="bar-row"><span>${escape(name)}</span><span>${pct}%</span></div>`
            + `<div class="bar"><i style="width:${pct}%"></i></div>`;
    }).join("");
    const chips = [
        r.tech ? "Tech" : null,
        Number.isFinite(r.bpm) ? `${Math.round(r.bpm)} BPM` : null,
        Number.isFinite(r.durationSec) ? formatDuration(r.durationSec) : null,
        r.rate !== 1 ? `×${r.rate}` : null,
    ].filter(Boolean).map((c) => `<span class="chip">${escape(c)}</span>`).join("");
    // the comparison needs the room the pattern bars take
    if (calc === "all") return head + confidence + calcList(r) + starsLine(r) + primary + `<div class="chips">${chips}</div>`;
    return head + confidence + starsLine(r) + primary + `<div class="bars">${bars}</div>` + `<div class="chips">${chips}</div>`;
}

function resultView(r, compact, calc) {
    switch (r.kind) {
        case "ok": return resultCard(r, compact, calc);
        case "not-rice":
            if (r.reason === "mode") return message(t("analysis.notMania"));
            return message(r.reason === "ln" ? t("analysis.ln") : t("analysis.notFourKey", { keys: r.keys ?? "?" }));
        case "too-short": return message(t("analysis.tooShort"));
        default: return message(t("analysis.error", { message: r.message ?? t("analysis.errorUnknown") }));
    }
}

// client: the osu! tosu reads ("stable" | "lazer" | null); lazer's "updated?" hint is its own;
// interlude: an Interlude folder is linked, so the waiting card says a chart can be picked from it
export function renderView(view, { compact, calc = "ours", client = null, interlude = false }) {
    const chosen = CALCS.some((c) => c.id === calc) ? calc : "ours";
    switch (view?.screen) {
        case "loading": return message(t("analysis.loading"));
        case "result": return resultView(view.result, compact, chosen);
        case "tosu-failed": return message(t("analysis.tosuFailed", { reason: view.reason }));
        case "external-info": return externalInfo(view.info);
        case "osu-updated": return message(t(client === "lazer" ? "analysis.lazerUpdated" : "analysis.osuUpdated"));
        default: return message(interlude ? `${t("analysis.waiting")} ${t("analysis.waitingInterlude")}` : t("analysis.waiting"));
    }
}
