// Pieces the Profile tab and the picks' progress share: a skill summary (overall + the four axes, with the local
// profile's ± and confidence), the per-pattern bars, a play's line, the history chart and the change texts.
import { TILE_NAMES, patternById } from "../../src/recommend/catalog.js";
import { chartPath, DAY_MS } from "../../src/recommend/progress.js";
import { AXES, PATTERNS } from "../../src/localProfile/model.js";
import { signed } from "../../src/recommend/format.js";
import { numericToLabel, labelBeside } from "../../src/core/labels.js";
import { t } from "../../src/i18n/i18n.js";
import { el, rateText } from "./recCard.js";
import { danWindow, danYTicks, levelTicks, scaleX, svg } from "./danCharts.js";

// the chart's lines for the local profile: the overall dan, the four axes, the seven patterns
export const LOCAL_AXES = ["dan", ...AXES, ...PATTERNS.map((p) => `p:${p}`)];
const BOX = { width: 300, height: 110, pad: 8 };
const BARS_PX = 180; // about how wide the pattern bars are in the default window

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

// the axes whose values are dans (the local profile's, the overall): their chart's scale is named in dans
const danScaled = (axis) => axis === "dan" || AXES.includes(axis) || axis.startsWith("p:");

// points [{ at, dan, ratings }] → the line of one axis as an <svg> (marks: times to dot on it), null without points
export function lineChart(points, axis, { from, to, marks = [] } = {}) {
    const c = chartPath(points, axis, { ...BOX, from, to }, marks);
    if (!c.d) return null;
    const chart = svg("svg", { viewBox: `0 0 ${BOX.width} ${BOX.height}`, class: "rec-chart-svg", role: "img" });
    const dans = danScaled(axis) ? danYTicks(c.lo, c.hi, BOX) : null;
    if (dans) {
        // a line between two dans, a dotted one between low / mid / high
        for (const g of dans.lines) chart.append(svg("line", { x1: BOX.pad, y1: g.y, x2: BOX.width - BOX.pad, y2: g.y, class: g.kind === "edge" ? "prof-chart-edge" : "prof-chart-grid" }));
    } else {
        chart.append(svg("line", { x1: BOX.pad, y1: BOX.height / 2, x2: BOX.width - BOX.pad, y2: BOX.height / 2, class: "prof-chart-grid" }));
    }
    chart.append(
        svg("line", { x1: BOX.pad, y1: BOX.height - BOX.pad, x2: BOX.width - BOX.pad, y2: BOX.height - BOX.pad, class: "rec-chart-base" }),
        svg("path", { d: c.d, class: "rec-chart-line" }),
        ...c.dots.map((d) => svg("circle", { cx: d.x, cy: d.y, r: 1.8, class: "rec-chart-dot" })),
        ...c.marks.map((m) => svg("circle", { cx: m.x, cy: m.y, r: 3.5, class: "rec-chart-mark" })),
    );
    // the scale, large enough to read at the window's width: dan names ("Gamma low 12.6") on a dan axis, else the
    // numbers at the top, middle and bottom
    const labels = dans
        ? dans.labels.map((l) => [l.text, Math.min(BOX.height - BOX.pad - 2, Math.max(BOX.pad + 10, l.y + 4))])
        : [[c.hi, BOX.pad + 11], [(c.hi + c.lo) / 2, BOX.height / 2 + 4], [c.lo, BOX.height - BOX.pad - 3]].map(([v, y]) => [v.toFixed(2), y]);
    for (const [text, y] of labels) {
        const label = svg("text", { x: BOX.pad, y, class: "prof-chart-label" });
        label.textContent = text;
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

// The seven patterns of the local profile as bars on one dan axis (the dan names above them), the best first: a bar
// to the pattern's dan, its ± as a whisker, and "Gamma mid 13.20 ±0.31 · уверенность средняя · карт: 6" under it;
// a pattern with too few plays greyed at the bottom.
export function patternTable(skill) {
    const box = el("div", "prof-table prof-bars");
    const rows = PATTERNS.map((id) => ({ id, est: skill?.patterns?.[id] }))
        .map((r) => ({ ...r, known: Number.isFinite(r.est?.dan) }))
        .sort((a, b) => (b.known - a.known) || (a.known ? b.est.dan - a.est.dan : (b.est?.maps ?? 0) - (a.est?.maps ?? 0)));
    const half = (r) => (Number.isFinite(r.est?.halfWidth) ? r.est.halfWidth : 0);
    const win = danWindow(rows.filter((r) => r.known).flatMap((r) => [r.est.dan - half(r), r.est.dan + half(r)]));
    const ticks = win ? levelTicks(win, 0, 100, { px: BARS_PX }) : []; // the names thinned for the bars' width at 300 px
    if (win) {
        // the axis: dan names over the bars' column, at the same places the bars use (percent of the column)
        const axis = el("div", "prof-bars-axis");
        for (const tick of ticks.filter((k) => k.kind === "mid" && k.label)) {
            const name = el("span", "", tick.label);
            name.style.left = `${tick.x}%`;
            axis.append(name);
        }
        box.append(el("span", "prof-tname"), axis);
    }
    const x = win ? scaleX(win, 0, 100) : null;
    for (const r of rows) {
        const e = estimateText(r.est);
        const conf = r.known ? `prof-conf-${CONFIDENCE[r.est.confidence] ? r.est.confidence : "low"}` : "";
        const row = el("div", `prof-trow${r.known ? "" : " few"}`);
        const name = el("span", "prof-tname", patternById(r.id)?.name ?? r.id);
        const cell = el("div", "prof-bar-cell");
        if (win) {
            const bar = svg("svg", { viewBox: "0 0 100 12", preserveAspectRatio: "none", class: "prof-bar-svg", role: "img" });
            for (const tick of ticks.filter((k) => k.kind === "edge" || k.kind === "mid")) {
                bar.append(svg("line", { x1: tick.x, y1: 0, x2: tick.x, y2: 12, class: tick.kind === "edge" ? "prof-viz-edge" : "prof-viz-grid", "vector-effect": "non-scaling-stroke" }));
            }
            if (r.known) {
                bar.append(svg("rect", { x: 0, y: 3, width: x(r.est.dan), height: 6, rx: 1, class: `prof-bar ${conf}` }));
                if (half(r)) {
                    const [a, b] = [x(r.est.dan - half(r)), x(r.est.dan + half(r))];
                    for (const [x1, y1, x2, y2] of [[a, 6, b, 6], [a, 2, a, 10], [b, 2, b, 10]]) bar.append(svg("line", { x1, y1, x2, y2, class: "prof-bar-whisker", "vector-effect": "non-scaling-stroke" }));
                }
            } else {
                bar.append(svg("line", { x1: 0, y1: 6, x2: 100, y2: 6, class: "prof-viz-track few", "vector-effect": "non-scaling-stroke" }));
            }
            const tip = svg("title", {});
            tip.textContent = `${name.textContent}: ${e.main} · ${e.sub}`;
            bar.append(tip);
            cell.append(bar);
        }
        row.append(name, cell, el("span", "muted prof-tsub", `${e.main} · ${e.sub}`));
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
