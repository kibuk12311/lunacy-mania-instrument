// «Дан по частям» under the analysis card (pure HTML, so it can be tested in Node): the dan of each part of the map
// (src/analysis/sections.js, from main on "analysis-sections") as steps along the map's time, the dans' names on the
// axis, the whole map's dan (the card's) as a dashed line across, the hardest part marked; a part under the pointer
// or tapped is told in the line below (analysisPanel.js: data-part, data-info), and every part with its time, dan and
// pattern is in a list that unfolds (data-toggle="parts", like the ladder). The card's own dan is not touched.
import { t } from "../../src/i18n/i18n.js";
import { labelBeside, labelKey } from "../../src/core/labels.js";
import { NAME_FAMILY } from "../../src/gen/search.js";
import { formatDuration } from "./view.js";

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const pct = (x) => `${Math.round(x * 100) / 100}%`;
const MIN_SPAN = 4; // dans the chart is at least tall, so a flat map stays flat
const LABEL_WIDTH = 12; // % of the map a part needs for its dan's name on the bar (shown once the chart is wide, CSS)

// "Delta" for 14, "7" for 7 (the axis' names; nothing past Kappa or under 1)
export function levelName(dan) {
    const key = labelKey(dan);
    return key === "none" || key === "below" || key === "above" ? "" : key.replace(/ mid$/, "");
}

// The chart in percent of its box: bars [{ i, left, width, height, dan, quiet, top }] along the time, ticks
// [{ dan, name, at }] (whole dans by a step that leaves at most five), the whole map's line `map` (or null) and the
// scale [lo, hi]. null without any part with a dan.
export function sectionGeometry(sections, mapDan = null) {
    const parts = Array.isArray(sections?.parts) ? sections.parts : [];
    const dans = parts.map((p) => finite(p.dan)).filter((d) => d !== null);
    if (!dans.length) return null;
    const whole = finite(mapDan);
    const all = whole === null ? dans : [...dans, whole];
    let lo = Math.max(0, Math.floor(Math.min(...all)) - 1);
    let hi = Math.ceil(Math.max(...all)) + 1;
    if (hi - lo < MIN_SPAN) {
        const grow = MIN_SPAN - (hi - lo);
        const down = Math.min(lo, Math.floor(grow / 2));
        lo -= down;
        hi += grow - down;
    }
    const at = (d) => ((Math.min(hi, Math.max(lo, d)) - lo) / (hi - lo)) * 100;
    const end = Math.max(finite(sections.durationSec) ?? 0, ...parts.map((p) => finite(p.toSec) ?? 0));
    const span = end > 0 ? end : 1;
    const bars = parts.map((p, i) => {
        const dan = finite(p.dan);
        return {
            i,
            left: (Math.max(0, p.fromSec) / span) * 100,
            width: (Math.max(0, p.toSec - p.fromSec) / span) * 100,
            height: dan === null ? 0 : Math.max(2, at(dan)),
            dan,
            quiet: dan === null,
            top: i === sections.top,
        };
    });
    const step = Math.max(1, Math.ceil((hi - lo) / 4));
    const ticks = [];
    for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) {
        const name = levelName(d);
        if (name && d > lo) ticks.push({ dan: d, name, at: at(d) });
    }
    return { bars, ticks, map: whole === null ? null : at(whole), lo, hi };
}

// "Jumpstream", "Jumpstream · tech"; "" without one
const patternOf = (p) => (p.primary ? `${p.primary}${p.tech ? " · tech" : ""}` : p.tech ? "Tech" : "");

// One part in words: "1:35–2:09 · Delta low · 14.6 · Jumpstream · the hardest part", or a quiet part's.
export function partInfo(part, { top = false } = {}) {
    const from = formatDuration(part.fromSec);
    const to = formatDuration(part.toSec);
    const dan = finite(part.dan);
    if (dan === null) return t("analysis.sections.quiet", { from, to });
    const text = t("analysis.sections.info", { from, to, label: labelBeside(dan), dan: dan.toFixed(1) });
    const pattern = patternOf(part);
    return [text, pattern, top ? t("analysis.sections.hardest") : ""].filter(Boolean).join(" · ");
}

// The pattern family's colour class of a part (the strip's), "" when its pattern is none of them
function familyClass(part) {
    if (part.tech) return "fam-tech";
    const family = NAME_FAMILY[part.primary];
    return family ? `fam-${family.toLowerCase()}` : "";
}

// The list of parts: one row (a button) per part — time, dan's name and number, pattern.
function partRows(parts, { top, chosen }) {
    return parts.map((part, i) => {
        const dan = finite(part.dan);
        const cls = ["an-srow", i === top ? "an-srow-top" : "", i === chosen ? "an-srow-sel" : ""].filter(Boolean).join(" ");
        const info = partInfo(part, { top: i === top });
        const name = dan === null ? t("analysis.sections.quietShort") : labelBeside(dan);
        return `<button type="button" class="${cls}" data-part="${i}" data-info="${escape(info)}">`
            + `<span class="an-stime">${escape(formatDuration(part.fromSec))}–${escape(formatDuration(part.toSec))}</span>`
            + `<span class="an-sname${dan === null ? " an-muted" : ""}">${escape(name)}</span>`
            + `<span class="an-snum">${dan === null ? "" : dan.toFixed(1)}</span>`
            + `<span class="an-spat">${escape(patternOf(part))}</span></button>`;
    }).join("");
}

// The block: sections undefined while it is worked out, null when it failed; selected: the part tapped (else the
// hardest is told below the chart); open: the list of parts unfolded.
export function sectionsBlock(sections, { mapDan = null, selected = null, open = false } = {}) {
    const title = `<span class="an-title">${escape(t("analysis.sections.title"))}</span>`;
    if (sections === undefined) {
        return `<div class="an-sec"><div class="an-head">${title}</div><div class="an-muted an-sec-wait">${escape(t("analysis.sections.counting"))}</div></div>`;
    }
    const g = sections ? sectionGeometry(sections, mapDan) : null;
    if (!g) {
        const why = sections ? t("analysis.sections.none") : t("analysis.sections.failed");
        return `<div class="an-sec"><div class="an-head">${title}</div><div class="an-muted">${escape(why)}</div></div>`;
    }
    const parts = sections.parts;
    const top = parts[sections.top];
    const chip = top ? `<span class="an-chip">${escape(t("analysis.sections.top", { from: formatDuration(top.fromSec), to: formatDuration(top.toSec), label: labelBeside(top.dan) }))}</span>` : "";
    const axis = g.ticks.map((k) => `<span style="bottom:${pct(k.at)}">${escape(k.name)}</span>`).join("");
    const grid = g.ticks.map((k) => `<i class="an-sec-grid" style="bottom:${pct(k.at)}"></i>`).join("");
    const chosen = Number.isInteger(selected) && parts[selected] ? selected : sections.top;
    const bars = g.bars.map((b) => {
        const part = parts[b.i];
        const info = partInfo(part, { top: b.top });
        const cls = ["an-sec-bar", familyClass(part), b.top ? "an-sec-top" : "", b.quiet ? "an-sec-quiet" : "", b.i === chosen ? "an-sec-sel" : ""].filter(Boolean).join(" ");
        const name = !b.quiet && b.width >= LABEL_WIDTH ? `<span class="an-sec-name">${escape(labelBeside(b.dan))}</span>` : "";
        return `<button type="button" class="${cls}" data-part="${b.i}" data-info="${escape(info)}" title="${escape(info)}" aria-label="${escape(info)}"`
            + ` style="left:${pct(b.left)};width:${pct(b.width)};height:${pct(b.height)}">${name}</button>`;
    }).join("");
    const map = g.map === null ? ""
        : `<div class="an-sec-map" style="bottom:${pct(g.map)}"></div>`;
    const key = g.map === null ? "" : `<span class="an-sec-key"><i></i>${escape(t("analysis.sections.map", { label: labelBeside(mapDan) }))}</span>`;
    const told = parts[chosen] ? partInfo(parts[chosen], { top: chosen === sections.top }) : "";
    const toggle = `<button type="button" class="an-ltoggle" data-toggle="parts" aria-expanded="${open ? "true" : "false"}">`
        + `${escape(t("analysis.sections.list", { n: parts.length }))} ${open ? "▾" : "▸"}</button>`;
    const list = open ? `<div class="an-srows">${partRows(parts, { top: sections.top, chosen })}</div>` : "";
    return `<div class="an-sec" title="${escape(t("analysis.sections.hint"))}">`
        + `<div class="an-head">${title}${chip}</div>`
        + `<div class="an-sec-chart" role="group" aria-label="${escape(t("analysis.sections.aria"))}">`
        + `<div class="an-sec-axis" aria-hidden="true">${axis}</div>`
        + `<div class="an-sec-plot">${grid}${bars}${map}</div></div>`
        + `<div class="an-axis an-sec-time"><span>0:00</span>${key}<span>${escape(formatDuration(sections.durationSec))}</span></div>`
        + `<div class="an-sec-info" aria-live="polite">${escape(told)}</div>`
        + `<div class="an-sec-list${open ? " open" : ""}">${toggle}${list}</div>`
        + `</div>`;
}
