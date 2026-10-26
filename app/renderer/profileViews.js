// Pieces the Profile tab and the picks' progress share: a skill summary (overall + the four axes, with the local
// profile's ± and confidence), the per-pattern table, a play's line, the history chart and the change texts.
import { TILE_NAMES, patternById } from "../../src/recommend/catalog.js";
import { chartPath, DAY_MS } from "../../src/recommend/progress.js";
import { AXES, PATTERNS } from "../../src/localProfile/model.js";
import { signed } from "../../src/recommend/format.js";
import { numericToLabel, labelBeside } from "../../src/core/labels.js";
import { t } from "../../src/i18n/i18n.js";
import { el, rateText } from "./recCard.js";

// the chart's lines for the local profile: the overall dan, the four axes, the seven patterns
export const LOCAL_AXES = ["dan", ...AXES, ...PATTERNS.map((p) => `p:${p}`)];
const SVG = "http://www.w3.org/2000/svg";
const BOX = { width: 300, height: 110, pad: 8 };

export function localAxisName(axis) {
    if (axis === "dan") return t("recommend.progress.axisDan");
    if (axis.startsWith("p:")) return patternById(axis.slice(2))?.name ?? axis;
    return TILE_NAMES[axis] ?? axis;
}

const fix = (x, d = 2) => (Number.isFinite(x) ? Number(x).toFixed(d) : "—");
const danName = (x) => (Number.isFinite(x) ? numericToLabel(x).text : "—");

// "Дан: Gamma mid → Gamma high (+0.20)"
export function localChangeText(change) {
    if (!change) return "";
    const delta = Number.isFinite(change.danDelta) ? ` (${signed(change.danDelta, 2)})` : "";
    return t("recommend.progress.dan", { from: danName(change.danFrom), to: danName(change.danTo), delta });
}

// "Speed +0.30 · Стрим +0.20 · …", what moved, biggest gain first
export function localAxesText(change) {
    return (change?.axes ?? []).filter((a) => Math.abs(a.delta) >= 0.005).map((a) => `${localAxisName(a.axis)} ${signed(a.delta, 2)}`).join(" · ");
}

function svg(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
}

// points [{ at, dan, ratings }] → the line of one axis as an <svg> (marks: times to dot on it), null without points
export function lineChart(points, axis, { from, to, marks = [] } = {}) {
    const c = chartPath(points, axis, { ...BOX, from, to }, marks);
    if (!c.d) return null;
    const chart = svg("svg", { viewBox: `0 0 ${BOX.width} ${BOX.height}`, class: "rec-chart-svg", role: "img" });
    chart.append(
        svg("line", { x1: BOX.pad, y1: BOX.height - BOX.pad, x2: BOX.width - BOX.pad, y2: BOX.height - BOX.pad, class: "rec-chart-base" }),
        svg("line", { x1: BOX.pad, y1: BOX.height / 2, x2: BOX.width - BOX.pad, y2: BOX.height / 2, class: "prof-chart-grid" }),
        svg("path", { d: c.d, class: "rec-chart-line" }),
        ...c.dots.map((d) => svg("circle", { cx: d.x, cy: d.y, r: 1.8, class: "rec-chart-dot" })),
        ...c.marks.map((m) => svg("circle", { cx: m.x, cy: m.y, r: 3.5, class: "rec-chart-mark" })),
    );
    const digits = axis === "dan" ? 1 : 2;
    // the scale at the top, middle and bottom, large enough to read at the window's width
    const mid = (c.hi + c.lo) / 2;
    for (const [value, y] of [[c.hi, BOX.pad + 11], [mid, BOX.height / 2 + 4], [c.lo, BOX.height - BOX.pad - 3]]) {
        const label = svg("text", { x: BOX.pad, y, class: "prof-chart-label" });
        label.textContent = value.toFixed(digits);
        chart.append(label);
    }

    return chart;
}

const CONFIDENCE = { low: "profile.conf.low", medium: "profile.conf.medium", high: "profile.conf.high" };

// One estimate (src/localProfile/model.js aggregate) as "Gamma high 13.42 ±0.31" and its confidence line.
export function estimateText(est) {
    if (!est || !Number.isFinite(est.dan)) return { main: t("profile.local.fewPlays"), sub: t("profile.local.mapsSoFar", { n: est?.maps ?? 0 }) };
    return {
        main: `${labelBeside(est.dan)} ${fix(est.dan)} ±${fix(est.halfWidth)}`,
        sub: `${t(CONFIDENCE[est.confidence] ?? "profile.conf.low")} · ${t("profile.local.mapsSoFar", { n: est.maps })}`,
    };
}

// The overall dan and the four axes. skill: the tracker's (readSkill) or the local one (with axes: estimates).
export function skillSummary(skill, { name = "", tag = "" } = {}) {
    const box = el("div", "prof-card");
    const head = el("div", "prof-head");
    head.append(el("span", "prof-name", name));
    if (tag) head.append(el("span", "prof-tag", tag));
    box.append(head);
    const overall = el("div", "prof-overall");
    if (Number.isFinite(skill?.overall)) {
        overall.append(el("span", "prof-dan", labelBeside(skill.overall, skill.overallLabel)), el("span", "prof-num", fix(skill.overall)));
        if (skill.partial) overall.append(el("span", "muted prof-partial", t("profile.local.partial")));
    } else {
        overall.append(el("span", "muted", skill?.local ? t("profile.local.notEnough") : "—"));
    }
    box.append(overall);
    const axes = el("div", "prof-axes");
    for (const axis of AXES) {
        const row = el("div", "prof-axis");
        row.append(el("span", "prof-axis-name", TILE_NAMES[axis]));
        if (skill?.local) {
            const e = estimateText(skill.axes?.[axis]);
            row.append(el("span", `prof-axis-dan${Number.isFinite(skill.axes?.[axis]?.dan) ? "" : " muted"}`, e.main), el("span", "muted prof-axis-sub", e.sub));
        } else {
            const dan = skill?.tiles?.[axis];
            row.append(el("span", "prof-axis-dan", Number.isFinite(dan) ? `${labelBeside(dan)} ${fix(dan)}` : "—"));
        }
        axes.append(row);
    }
    box.append(axes);
    return box;
}

// The seven patterns of the local profile: dan ± range, confidence, maps.
export function patternTable(skill) {
    const box = el("div", "prof-table");
    for (const id of PATTERNS) {
        const est = skill?.patterns?.[id];
        const e = estimateText(est);
        const row = el("div", `prof-trow${Number.isFinite(est?.dan) ? "" : " few"}`);
        row.append(el("span", "prof-tname", patternById(id)?.name ?? id), el("span", "prof-tdan", e.main), el("span", "muted prof-tsub", e.sub));
        box.append(row);
    }
    return box;
}

const OUTCOME = { pass: "", fail: "profile.play.fail", quit: "profile.play.quit" };

// "сегодня" / "вчера" / "3 дн. назад" / a date for older plays
export function whenText(at, now = Date.now()) {
    const days = Math.max(0, Math.floor((now - at) / DAY_MS));
    if (days === 0) return t("recommend.progress.today");
    if (days === 1) return t("recommend.progress.yesterday");
    if (days < 60) return t("recommend.progress.daysAgo", { n: days });
    return new Date(at).toISOString().slice(0, 10);
}

// One play: its map, then "1.1x · 96.42% · карта 13.4 → 13.1 · вчера"
export function playRow(play, now = Date.now(), { showPerf = true } = {}) {
    const row = el("div", `prof-play${play.outcome === "pass" ? "" : " bad"}`);
    const name = [play.artist, play.title].filter(Boolean).join(" — ") || t("profile.play.unknown");
    // the tracker's difficulty names come with their own brackets ("[4K] Hard")
    const version = !play.version ? "" : play.version.startsWith("[") ? play.version : `[${play.version}]`;
    const title = el("div", "rec-title", version ? `${name} ${version}` : name);
    title.title = title.textContent;
    const parts = [];
    if (Number.isFinite(play.rate) && Math.abs(play.rate - 1) > 1e-6) parts.push(rateText(play.rate));
    if (Number.isFinite(play.accuracy)) parts.push(`${play.accuracy.toFixed(2)}%`);
    if (OUTCOME[play.outcome]) parts.push(t(OUTCOME[play.outcome]));
    if (showPerf && Number.isFinite(play.mapDan)) {
        parts.push(Number.isFinite(play.perf) ? t("profile.play.perf", { map: fix(play.mapDan, 1), perf: fix(play.perf, 2) }) : t("profile.play.map", { map: fix(play.mapDan, 1) }));
    } else if (play.unrated) {
        parts.push(t("profile.play.unrated"));
    }
    if (Number.isFinite(play.at)) parts.push(whenText(play.at, now));
    row.append(title, el("div", "muted prof-play-line", parts.join(" · ")));
    return row;
}
