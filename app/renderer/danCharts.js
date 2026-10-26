// The Profile tab's dan pictures: the four skills (Speed / Jack / Stamina / Tech) and the overall on one dan axis
// («Шкала») or as a spider chart («Паутинка»), the axis ticks the pattern bars and the history chart share, and the
// one-line legend that says what "13.00" means. Inline SVG only; colours come from the CSS (styles-profile.css).
// A dan level L covers L − 0.5 … L + 0.5 (src/core/labels.js rounds): L − 0.4 reads "low", L "mid", L + 0.4 "high".
import { TILE_NAMES } from "../../src/recommend/catalog.js";
import { AXES } from "../../src/localProfile/model.js";
import { numericToLabel } from "../../src/core/labels.js";
import { t, plural } from "../../src/i18n/i18n.js";
import { el } from "./recCard.js";

const SVG = "http://www.w3.org/2000/svg";
const MODE_KEY = "profile-skill-chart";
export const CHART_MODES = ["scale", "radar"];
// the scale: names on the left, the dan axis to the right of them, one row a skill, the overall's line through all
// (viewBoxes about as wide as the card at the default 320 px window, so 11 px of text stays 11 px there)
export const SCALE = { width: 260, x0: 58, x1: 252, top: 22, row: 24, bottom: 18 };
export const RADAR = { width: 260, height: 224, cx: 130, cy: 114, r: 74 };
const MIN_LABEL_PX = 44; // a dan name ("Epsilon") needs about this much room on the axis
const STEP_LABEL_PX = 66; // a level this wide also gets its "low" / "high" words
const BY_MAPS = {
    ru: ["profile.chart.byMaps.one", "profile.chart.byMaps.few", "profile.chart.byMaps.many"],
    en: ["profile.chart.byMaps.one", "profile.chart.byMaps.many"],
};
const CONFIDENCE = { low: "profile.conf.low", medium: "profile.conf.medium", high: "profile.conf.high" };

const fix = (x, d = 2) => (Number.isFinite(x) ? Number(x).toFixed(d) : "—");
const r1 = (v) => Math.round(v * 10) / 10;

// A level's own name on the axis: "9", "Alpha" … "Kappa"; past Kappa "выше Kappa" once, then plain numbers.
export function levelName(level) {
    if (level > 21) return String(level);
    if (level === 21) return numericToLabel(21, { number: false }).text;
    if (level < 1) return numericToLabel(0).text;
    return numericToLabel(level).text.split(" ")[0];
}

// The dans worth showing for these values (a skill's dan and its ± ends): a level on each side of them (below /
// above), at least minLevels levels, never below dan 1. → { first, last, lo, hi } (lo / hi: the axis ends), null
// without values.
export function danWindow(values, { margin = 1, below = margin, above = margin, minLevels = 3 } = {}) {
    const known = (values ?? []).filter(Number.isFinite);
    if (!known.length) return null;
    let first = Math.round(Math.min(...known)) - below;
    let last = Math.round(Math.max(...known)) + above;
    while (last - first + 1 < minLevels) {
        last += 1;
        if (last - first + 1 < minLevels) first -= 1;
    }
    if (first < 1) [first, last] = [1, last + 1 - first];
    return { first, last, lo: first - 0.5, hi: last + 0.5 };
}

// value → x on [x0, x1] for a window; past its ends the value stays at the end
export function scaleX(win, x0, x1) {
    return (v) => r1(x0 + ((Math.min(win.hi, Math.max(win.lo, v)) - win.lo) / (win.hi - win.lo)) * (x1 - x0));
}

// The axis of a window: an edge between every two levels, a low / mid / high tick in each. A level's name sits on
// its mid tick, every n-th level when the levels are narrow; "low" / "high" are written only on wide levels.
// px: the axis' width on screen when x0 … x1 are not pixels (the pattern bars place by percent).
// → [{ value, x, kind: "edge" | "low" | "mid" | "high", label }]
export function levelTicks(win, x0, x1, { px = x1 - x0 } = {}) {
    const x = scaleX(win, x0, x1);
    const levelPx = px / (win.last - win.first + 1);
    const every = Math.max(1, Math.ceil(MIN_LABEL_PX / levelPx));
    const steps = levelPx >= STEP_LABEL_PX;
    const ticks = [];
    for (let level = win.first; level <= win.last; level += 1) {
        ticks.push({ value: level - 0.5, x: x(level - 0.5), kind: "edge", label: "" });
        ticks.push({ value: level - 0.4, x: x(level - 0.4), kind: "low", label: steps ? "low" : "" });
        ticks.push({ value: level, x: x(level), kind: "mid", label: (level - win.first) % every === 0 ? levelName(level) : "" });
        ticks.push({ value: level + 0.4, x: x(level + 0.4), kind: "high", label: steps ? "high" : "" });
    }
    ticks.push({ value: win.last + 0.5, x: x(win.last + 0.5), kind: "edge", label: "" });
    return ticks;
}

// The history chart's dan scale (its y runs from hi at the top to lo at the bottom, as chartPath draws it):
// grid lines between dans and between low / mid / high, and labels "Gamma low 12.6" that keep 14 px apart, mids
// first. → { lines: [{ y, kind: "edge" | "step" }], labels: [{ value, y, text }] }
export function danYTicks(lo, hi, { height, pad = 0 }) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { lines: [], labels: [] };
    const y = (v) => r1(pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad));
    const inside = (v) => v >= lo - 1e-9 && v <= hi + 1e-9;
    const lines = [];
    const candidates = [];
    for (let level = Math.floor(lo) - 1; level <= Math.ceil(hi) + 1; level += 1) {
        for (const [v, kind] of [[level - 0.5, "edge"], [level - 0.2, "step"], [level + 0.2, "step"]]) {
            if (v > lo && v < hi) lines.push({ y: y(v), kind });
        }
        if (inside(level)) candidates.push({ value: level, rank: 0 });
        for (const v of [level - 0.4, level + 0.4]) if (inside(v)) candidates.push({ value: Math.round(v * 10) / 10, rank: 1 });
    }
    candidates.sort((a, b) => a.rank - b.rank || a.value - b.value);
    const labels = [];
    for (const c of candidates) {
        const at = y(c.value);
        if (labels.every((l) => Math.abs(l.y - at) >= 14)) labels.push({ value: c.value, y: at, text: `${numericToLabel(c.value, { number: false }).text} ${c.value.toFixed(1)}` });
    }
    if (!labels.length) {
        const mid = Math.round(((lo + hi) / 2) * 100) / 100;
        labels.push({ value: mid, y: y(mid), text: `${numericToLabel(mid, { number: false }).text} ${mid.toFixed(2)}` });
    }
    return { lines, labels: labels.sort((a, b) => a.y - b.y) };
}

// The skill's rows: the four axes with what is known of each. The local profile has estimates (± and confidence),
// the tracker's and the hand-set profile only a dan. → [{ key, name, dan, halfWidth, confidence, maps, known }]
export function skillRows(skill) {
    return AXES.map((key) => {
        const est = skill?.local ? skill.axes?.[key] : null;
        const dan = skill?.local ? est?.dan : skill?.tiles?.[key];
        const known = Number.isFinite(dan);
        return {
            key, name: TILE_NAMES[key] ?? key, dan: known ? dan : null, known,
            halfWidth: known && Number.isFinite(est?.halfWidth) ? est.halfWidth : null,
            confidence: known && CONFIDENCE[est?.confidence] ? est.confidence : null,
            maps: skill?.local && Number.isFinite(est?.maps) ? est.maps : null,
        };
    });
}

// Every value the picture must hold: the dans, their ± ends and the overall. The spider's centre is a dan below
// them and its outer ring the level of the highest, so the shape fills the chart.
function windowOf(skill, rows, options) {
    const values = rows.flatMap((r) => (r.known ? [r.dan - (r.halfWidth ?? 0), r.dan + (r.halfWidth ?? 0)] : []));
    if (Number.isFinite(skill?.overall)) values.push(skill.overall);
    return danWindow(values, options);
}
export const RADAR_WINDOW = { below: 1, above: 0 };

const mapsText = (n) => t(plural(n, BY_MAPS), { n });

// "Stamina: Gamma mid (13.00 ± 0.43), уверенность средняя, по 6 картам"
export function rowTip(row) {
    if (!row.known) return [`${row.name}: ${t("profile.local.fewPlays")}`, ...(row.maps ? [t("profile.local.mapsSoFar", { n: row.maps })] : [])].join(", ");
    const range = Number.isFinite(row.halfWidth) ? `${fix(row.dan)} ± ${fix(row.halfWidth)}` : fix(row.dan);
    const parts = [`${row.name}: ${numericToLabel(row.dan, { number: false }).text} (${range})`];
    if (row.confidence) parts.push(t(CONFIDENCE[row.confidence]));
    if (Number.isFinite(row.maps) && row.maps > 0) parts.push(mapsText(row.maps));
    return parts.join(", ");
}

// "Общий: Gamma mid (13.00)"
export function overallTip(skill) {
    if (!Number.isFinite(skill?.overall)) return "";
    return `${t("profile.chart.overall")}: ${numericToLabel(skill.overall, { number: false }).text} (${fix(skill.overall)})`;
}

// "13.00 = Gamma mid. Целое число — дан …" for the overall (or 13.00 when there is none); without ± for a skill
// that has no ranges (the tracker's).
export function legendText(skill) {
    const n = Number.isFinite(skill?.overall) ? skill.overall : 13;
    const ranges = skillRows(skill).some((r) => Number.isFinite(r.halfWidth));
    return t(ranges ? "profile.chart.legend" : "profile.chart.legendNoRange", { num: fix(n), label: numericToLabel(n, { number: false }).text });
}

// The spider chart's points: Speed up, Jack right, Stamina down, Tech left; the centre is the window's low end,
// the outer ring its high end. An axis without a dan sits in the centre. → [{ key, angle, x, y, radius, known }]
export function radarPoints(rows, win, { cx, cy, r }) {
    const radius = (v) => (Math.min(win.hi, Math.max(win.lo, v)) - win.lo) / (win.hi - win.lo) * r;
    return rows.map((row, i) => {
        const angle = -Math.PI / 2 + (i * Math.PI) / 2;
        const rad = row.known ? radius(row.dan) : 0;
        return { key: row.key, angle, radius: r1(rad), x: r1(cx + Math.cos(angle) * rad), y: r1(cy + Math.sin(angle) * rad), known: row.known };
    });
}

export const radarRadius = (win, r) => (v) => r1((Math.min(win.hi, Math.max(win.lo, v)) - win.lo) / (win.hi - win.lo) * r);

// ---- SVG ----

export function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
}

// a hover / tap target: its <title> is the tooltip, entering or clicking it puts the text in the caption line
function target(node, text, onPick) {
    node.append(svg("title", {}, text));
    node.addEventListener("mouseenter", () => onPick(text));
    node.addEventListener("click", () => onPick(text));
    return node;
}

const bandClass = (row) => `prof-conf-${row.confidence ?? (Number.isFinite(row.halfWidth) ? "low" : "none")}`;

// «Шкала»: one row a skill on a shared dan axis, its ± as a band, the overall as a gold line through all rows.
export function scaleSvg(skill, onPick = () => {}) {
    const rows = skillRows(skill);
    const win = windowOf(skill, rows);
    if (!win) return null;
    const { width, x0, x1, top, row: rowH, bottom } = SCALE;
    const height = top + rows.length * rowH + bottom;
    const x = scaleX(win, x0, x1);
    const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "prof-viz-svg", role: "img" });
    const plotBottom = top + rows.length * rowH;
    for (const tick of levelTicks(win, x0, x1)) {
        if (tick.kind === "edge") chart.append(svg("line", { x1: tick.x, y1: top - 6, x2: tick.x, y2: plotBottom, class: "prof-viz-edge" }));
        else if (tick.kind === "mid") chart.append(svg("line", { x1: tick.x, y1: top - 4, x2: tick.x, y2: plotBottom, class: "prof-viz-grid" }));
        else chart.append(svg("line", { x1: tick.x, y1: top - 4, x2: tick.x, y2: top, class: "prof-viz-tick" }));
        if (tick.label) chart.append(svg("text", { x: tick.x, y: tick.kind === "mid" ? 11 : top - 7, class: `prof-viz-axis${tick.kind === "mid" ? "" : " step"}`, "text-anchor": "middle" }, tick.label));
    }
    rows.forEach((row, i) => {
        const mid = top + i * rowH + rowH / 2;
        const g = svg("g", { class: `prof-viz-row${row.known ? "" : " few"}`, "data-key": row.key });
        g.append(svg("rect", { x: 0, y: mid - rowH / 2, width, height: rowH, class: "prof-viz-hit" }));
        g.append(svg("text", { x: 2, y: mid + 4, class: "prof-viz-name" }, row.name));
        if (row.known) {
            g.append(svg("line", { x1: x0, y1: mid, x2: x1, y2: mid, class: "prof-viz-track" }));
            if (Number.isFinite(row.halfWidth)) {
                const [a, b] = [x(row.dan - row.halfWidth), x(row.dan + row.halfWidth)];
                g.append(svg("rect", { x: a, y: mid - 5, width: r1(Math.max(1, b - a)), height: 10, rx: 3, class: `prof-viz-band ${bandClass(row)}` }));
            }
            g.append(svg("circle", { cx: x(row.dan), cy: mid, r: 4.5, class: `prof-viz-dot ${bandClass(row)}` }));
        } else {
            g.append(svg("line", { x1: x0, y1: mid, x2: x1, y2: mid, class: "prof-viz-track few" }));
            g.append(svg("text", { x: (x0 + x1) / 2, y: mid + 4, class: "prof-viz-few", "text-anchor": "middle" }, t("profile.local.fewPlays")));
        }
        chart.append(target(g, rowTip(row), onPick));
    });
    if (Number.isFinite(skill?.overall)) {
        const ox = x(skill.overall);
        const g = svg("g", { class: "prof-viz-overall" });
        g.append(svg("line", { x1: ox, y1: top - 2, x2: ox, y2: plotBottom + 2, class: "prof-viz-overall-line" }));
        const anchor = ox < x0 + 40 ? "start" : ox > x1 - 40 ? "end" : "middle";
        g.append(svg("text", { x: ox, y: plotBottom + 14, class: "prof-viz-overall-text", "text-anchor": anchor }, `${t("profile.chart.overall")} ${numericToLabel(skill.overall, { number: false }).text}`));
        chart.append(target(g, overallTip(skill), onPick));
    }
    return chart;
}

// «Паутинка»: the four skills as a diamond over rings at every dan, the overall as a gold ring, ± as whiskers.
export function radarSvg(skill, onPick = () => {}) {
    const rows = skillRows(skill);
    const win = windowOf(skill, rows, RADAR_WINDOW);
    if (!win) return null;
    const { width, height, cx, cy, r } = RADAR;
    const radius = radarRadius(win, r);
    const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "prof-viz-svg radar", role: "img" });
    chart.append(svg("circle", { cx, cy, r, class: "prof-viz-edge ring" }));
    let lastLabel = -Infinity;
    for (let level = win.first; level <= win.last; level += 1) {
        const rr = radius(level);
        chart.append(svg("circle", { cx, cy, r: rr, class: "prof-viz-grid ring" }));
        // the rings' names on the diagonal between Speed and Jack, clear of the axes' own labels
        if (rr - lastLabel >= 14) {
            chart.append(svg("text", { x: r1(cx + rr * Math.SQRT1_2 + 2), y: r1(cy - rr * Math.SQRT1_2 - 2), class: "prof-viz-axis ring" }, levelName(level)));
            lastLabel = rr;
        }
    }
    const points = radarPoints(rows, win, { cx, cy, r });
    for (const p of points) chart.append(svg("line", { x1: cx, y1: cy, x2: r1(cx + Math.cos(p.angle) * r), y2: r1(cy + Math.sin(p.angle) * r), class: "prof-viz-edge" }));
    if (Number.isFinite(skill?.overall)) {
        chart.append(target(svg("circle", { cx, cy, r: radius(skill.overall), class: "prof-viz-overall-line ring" }), overallTip(skill), onPick));
    }
    chart.append(svg("polygon", { points: points.map((p) => `${p.x},${p.y}`).join(" "), class: `prof-viz-shape${rows.every((row) => row.known) ? "" : " few"}` }));
    rows.forEach((row, i) => {
        const p = points[i];
        const [cos, sin] = [Math.cos(p.angle), Math.sin(p.angle)];
        const g = svg("g", { class: `prof-viz-row${row.known ? "" : " few"}`, "data-key": row.key });
        if (row.known && Number.isFinite(row.halfWidth)) {
            const [a, b] = [radius(row.dan - row.halfWidth), radius(row.dan + row.halfWidth)];
            g.append(svg("line", { x1: r1(cx + cos * a), y1: r1(cy + sin * a), x2: r1(cx + cos * b), y2: r1(cy + sin * b), class: `prof-viz-whisker ${bandClass(row)}` }));
        }
        if (row.known) g.append(svg("circle", { cx: p.x, cy: p.y, r: 4.5, class: `prof-viz-dot ${bandClass(row)}` }));
        // the axis' name and dan at its outer end: above and below for Speed / Stamina, at the sides for Jack / Tech
        const value = row.known ? numericToLabel(row.dan, { number: false }).text : t("profile.local.fewPlays");
        const place = [
            { x: cx, y: cy - r - 18, anchor: "middle" }, { x: width - 2, y: cy - 8, anchor: "end" },
            { x: cx, y: cy + r + 14, anchor: "middle" }, { x: 2, y: cy - 8, anchor: "start" },
        ][i];
        const name = svg("text", { x: place.x, y: place.y, class: "prof-viz-name", "text-anchor": place.anchor }, row.name);
        const sub = svg("text", { x: place.x, y: place.y + (i % 2 ? 24 : 11), class: `prof-viz-value${row.known ? "" : " few"}`, "text-anchor": place.anchor }, value);
        g.append(name, sub, svg("circle", { cx: row.known ? p.x : r1(cx + cos * r), cy: row.known ? p.y : r1(cy + sin * r), r: 11, class: "prof-viz-hit" }));
        chart.append(target(g, rowTip(row), onPick));
    });
    return chart;
}

function readMode() {
    try {
        const m = globalThis.localStorage?.getItem(MODE_KEY);
        return CHART_MODES.includes(m) ? m : "scale";
    } catch {
        return "scale";
    }
}

function writeMode(m) {
    try {
        globalThis.localStorage?.setItem(MODE_KEY, m);
    } catch {
        // not remembered, still shown
    }
}

// The skill's picture under its summary: «Шкала / Паутинка», the chart, a caption line that names what was hovered
// or tapped, and the legend. null when not one skill has a dan yet (the summary says so).
export function skillChart(skill, { mode } = {}) {
    if (!skillRows(skill).some((row) => row.known) && !Number.isFinite(skill?.overall)) return null;
    const box = el("div", "prof-viz");
    const modes = el("div", "chips prof-viz-modes");
    const holder = el("div", "prof-viz-holder");
    const tip = el("div", "prof-viz-tip muted", t("profile.chart.tapHint"));
    const pick = (text) => { tip.textContent = text; tip.className = "prof-viz-tip"; };
    let shown = CHART_MODES.includes(mode) ? mode : readMode();
    const draw = () => {
        modes.replaceChildren(...CHART_MODES.map((m) => {
            const chip = el("span", m === shown ? "sel" : "", t(`profile.chart.${m}`));
            chip.addEventListener("click", () => { shown = m; writeMode(m); draw(); });
            return chip;
        }));
        holder.replaceChildren((shown === "radar" ? radarSvg : scaleSvg)(skill, pick));
    };
    draw();
    box.append(modes, holder, tip, el("div", "prof-viz-legend muted", legendText(skill)));
    return box;
}
