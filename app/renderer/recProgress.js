// "Прогресс": how many picked maps were played in the last 7 / 30 / 90 days, how each went, and how the dan and
// MinaCalc ratings moved since (a small SVG chart with a dot where a picked map was played).
import { HISTORY_AXES, chartPath, DAY_MS } from "../../src/recommend/progress.js";
import { signed } from "../../src/recommend/format.js";
import { t, plural as pluralOf } from "../../src/i18n/i18n.js";
import { numericToLabel, labelKey } from "../../src/core/labels.js";
import { el, button, call, failText, rateText } from "./recCard.js";
import { ensureTrackerProfile } from "./profile.js";
import { LOCAL_AXES, localAxisName, localChangeText, localAxesText, lineChart } from "./profileViews.js";

export const PROGRESS_DAYS = [7, 30, 90];
// the chart's axes: the dan, then the ratings
export const CHART_AXES = ["dan", ...HISTORY_AXES];
const SVG = "http://www.w3.org/2000/svg";
const BOX = { width: 300, height: 110, pad: 8 };

const triesWord = (n) => pluralOf(n, {
    ru: [t("recommend.progress.try.one"), t("recommend.progress.try.few"), t("recommend.progress.try.many")],
    en: [t("recommend.progress.try.one"), t("recommend.progress.try.many")],
});

// "сегодня", "вчера", "3 дн. назад"
export function agoText(at, now) {
    const days = Math.max(0, Math.floor((now - at) / DAY_MS));
    if (days === 0) return t("recommend.progress.today");
    if (days === 1) return t("recommend.progress.yesterday");
    return t("recommend.progress.daysAgo", { n: days });
}

// The line of one pick: "✓ 96.3% · 1.1x · 3 дн. назад", "✗ не пройдена" or "не сыграна".
export function playLine(pick, now) {
    const play = pick?.play;
    if (!play) return { text: t("recommend.progress.notPlayed"), cls: "muted", played: false };
    const tries = Number(pick.tries) > 1 ? ` · ${pick.tries} ${triesWord(pick.tries)}` : "";
    if (play.passed === false) return { text: `${t("recommend.progress.failed")}${tries}`, cls: "bad", played: true };
    const acc = play.accuracy === null || play.accuracy === undefined ? NaN : Number(play.accuracy);
    const parts = [Number.isFinite(acc) ? `✓ ${(acc <= 1 ? acc * 100 : acc).toFixed(1)}%` : "✓"];
    if (Number.isFinite(play.rate) && Math.abs(play.rate - 1) > 1e-6) parts.push(rateText(play.rate));
    if (Number.isFinite(play.at)) parts.push(agoText(play.at, now));
    return { text: parts.join(" · ") + tries, cls: "ok", played: true };
}

export const summaryText = (r) => t("recommend.progress.summary", { played: Number(r?.played) || 0, total: Number(r?.total) || 0 });

// One end of the change: the tracker's own label, or past its table "above Kappa" (with the number when there is one).
function danName(end) {
    if (!end) return "—";
    if (!end.above) return end.label ?? "—";
    return labelKey(end.dan) === "above" ? numericToLabel(end.dan).text : t("core.label.aboveKappa");
}

// "Дан: gamma+ → delta-- (+0.4)"
export function danChangeText(change) {
    if (!change) return "";
    const from = danName(change.danFrom);
    const to = danName(change.danTo);
    const delta = Number.isFinite(change.danDelta) ? ` (${signed(change.danDelta)})` : "";
    return t("recommend.progress.dan", { from, to, delta });
}

// "Stream +1.30 · Overall +1.23 · …", the axes that moved, biggest gain first.
export function axesText(change) {
    return (change?.axes ?? []).filter((a) => Math.abs(a.delta) >= 0.005).map((a) => `${a.axis} ${signed(a.delta, 2)}`).join(" · ");
}

const axisName = (axis) => (axis === "dan" ? t("recommend.progress.axisDan") : axis);

const $ = (id) => document.getElementById(id);
let shared = null; // { view(), saveView(patch), hasPlayer() }
let last = null; // the last answer, for switching chart axes
let token = 0;

const status = (text) => { $("rec-progress-status").textContent = text; };

function renderChips(box, items, selected, name, onPick) {
    box.replaceChildren(...items.map((id) => {
        const chip = el("span", id === selected ? "sel" : "", name(id));
        chip.addEventListener("click", () => onPick(id));
        return chip;
    }));
}

function svg(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
}

function renderChart(r) {
    const axis = shared.view().progressAxis;
    renderChips($("rec-progress-axes"), CHART_AXES, axis, axisName, (id) => {
        shared.saveView({ progressAxis: id });
        renderChart(last);
    });
    const marks = r.picks.filter((p) => p.play && Number.isFinite(p.play.at)).map((p) => p.play.at);
    const c = chartPath(r.points, axis, { ...BOX, from: r.since, to: r.now }, marks);
    const box = $("rec-progress-chart");
    if (!c.d) {
        box.replaceChildren(el("div", "muted", t("recommend.progress.noChart")));
        return;
    }
    const chart = svg("svg", { viewBox: `0 0 ${BOX.width} ${BOX.height}`, class: "rec-chart-svg", role: "img" });
    chart.append(
        svg("line", { x1: BOX.pad, y1: BOX.height - BOX.pad, x2: BOX.width - BOX.pad, y2: BOX.height - BOX.pad, class: "rec-chart-base" }),
        svg("path", { d: c.d, class: "rec-chart-line" }),
        ...c.marks.map((m) => svg("circle", { cx: m.x, cy: m.y, r: 3.5, class: "rec-chart-mark" })),
    );
    const hi = svg("text", { x: BOX.pad, y: BOX.pad + 8, class: "rec-chart-label" });
    hi.textContent = axis === "dan" ? c.hi.toFixed(1) : c.hi.toFixed(2);
    const lo = svg("text", { x: BOX.pad, y: BOX.height - BOX.pad - 3, class: "rec-chart-label" });
    lo.textContent = axis === "dan" ? c.lo.toFixed(1) : c.lo.toFixed(2);
    chart.append(hi, lo);
    box.replaceChildren(chart);
}

function pickRow(pick, now) {
    const row = el("div", "rec-progress-row");
    const name = el("div", "rec-title", `${pick.artist} — ${pick.title}`);
    name.title = `${name.textContent} ${pick.version}`;
    const line = playLine(pick, now);
    const state = el("div", `rec-progress-state ${line.cls}`, line.text);
    row.append(name, state);
    if (!line.played) {
        const actions = el("div", "rec-actions");
        actions.append(button("osu!direct", t("recommend.direct.title"), async () => {
            const r = await call(() => window.danApi.recOpen("direct", pick.beatmapId));
            if (!r?.ok) status(failText(r));
        }));
        row.append(actions);
    }
    return row;
}

// the local profile's period: its own axes and patterns on the chart (src/localProfile/model.js dailySkill)
let localAxis = "dan";
function renderLocal(r) {
    $("rec-progress-summary").textContent = summaryText(r);
    $("rec-progress-list").replaceChildren(...r.picks.map((p) => pickRow(p, r.now)));
    $("rec-progress-change").replaceChildren(...(r.change ? [el("div", "rec-progress-dan", localChangeText(r.change)), el("div", "muted", localAxesText(r.change))] : []));
    const axes = LOCAL_AXES.filter((a) => a === "dan" || r.points.some((p) => Number.isFinite(p.ratings?.[a])));
    if (!axes.includes(localAxis)) localAxis = "dan";
    renderChips($("rec-progress-axes"), axes, localAxis, localAxisName, (id) => {
        localAxis = id;
        renderLocal(r);
    });
    const marks = r.picks.filter((p) => p.play && Number.isFinite(p.play.at)).map((p) => p.play.at);
    $("rec-progress-chart").replaceChildren(lineChart(r.points, localAxis, { from: r.since, to: r.now, marks }) ?? el("div", "muted", t("recommend.progress.noChart")));
    if (!r.total) status(t("recommend.progress.noPicks"));
    else status("");
}

function render(r) {
    if (r.local) return renderLocal(r);
    $("rec-progress-summary").textContent = summaryText(r);
    $("rec-progress-list").replaceChildren(...r.picks.map((p) => pickRow(p, r.now)));
    const change = el("div", "rec-progress-dan", danChangeText(r.change));
    const axes = el("div", "muted", axesText(r.change));
    $("rec-progress-change").replaceChildren(...(r.change ? [change, axes] : []));
    renderChart(r);
    if (!r.total) status(t("recommend.progress.noPicks"));
    else status(r.partial ? t("recommend.progress.partial") : "");
}

function clear() {
    $("rec-progress-summary").textContent = "";
    $("rec-progress-list").replaceChildren();
    $("rec-progress-change").replaceChildren();
    $("rec-progress-chart").replaceChildren();
}

async function load() {
    const run = ++token;
    status(t("recommend.progress.loading"));
    // the local profile answers from main's own plays: no mania-tracker needed
    if (shared.settings().source === "local") {
        const r = await call(() => window.danApi.recProgress?.(shared.view().progressDays, true) ?? Promise.resolve({ ok: false }));
        if (run !== token) return;
        if (!r?.ok) {
            clear();
            return status(failText(r));
        }
        last = { ...r, now: Date.now() };
        return render(last);
    }
    // main answers for the loaded player: the shared profile brings in the saved one if there is none yet
    const tracker = shared.hasPlayer() ? { state: "ready" } : await ensureTrackerProfile();
    if (run !== token) return;
    // a hand-set profile has no plays: progress needs mania-tracker
    if (tracker?.state !== "ready" && shared.settings().source === "manual") {
        clear();
        return status(t("recommend.progress.needTracker"));
    }
    const days = shared.view().progressDays;
    const r = await call(() => window.danApi.recProgress?.(days) ?? Promise.resolve({ ok: false }));
    if (run !== token) return;
    if (!r?.ok) {
        clear();
        return status(failText(r));
    }
    last = { ...r, now: Date.now() };
    render(last);
}

function renderDays() {
    renderChips($("rec-progress-days"), PROGRESS_DAYS, shared.view().progressDays, (d) => t("recommend.progress.days", { n: d }), (d) => {
        shared.saveView({ progressDays: d });
        renderDays();
        load();
    });
}

export function initProgress(s) {
    shared = s;
    renderDays();
}

export const showProgress = () => load();
