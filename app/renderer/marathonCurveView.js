// The marathon tab's difficulty curve under the list: the SVG from src/rate/marathonCurve.js (the same one the
// background gets), the total line and the warnings. Drawn from the list alone, no IPC.
import { t, plural } from "../../src/i18n/i18n.js";
import { curveRows, curveWarnings, curveSvg, formatTime } from "../../src/rate/marathonCurve.js";
import { numericToLabel } from "../../src/core/labels.js";

const MAPS_KEYS = {
    ru: ["marathon.auto.maps.one", "marathon.auto.maps.few", "marathon.auto.maps.many"],
    en: ["marathon.auto.maps.one", "marathon.auto.maps.many"],
};
// "4 карты" / "4 maps"
export const mapsText = (n) => t(plural(n, MAPS_KEYS), { n });

// +0.6 / −0.15
const signed = (d) => `${d > 0 ? "+" : "−"}${Number(Math.abs(d).toFixed(2))}`;

function line(className, text) {
    const node = document.createElement("div");
    node.className = className;
    node.textContent = text;
    return node;
}

// entries: the list's rows { rate, dan, numeric, cutMs }; gapSec: the pause; plan: the template's dan per map or null.
export function drawCurve(container, entries, gapSec, plan = null) {
    if (!container) return;
    const { rows, totalMs } = curveRows(entries.map((e) => ({ cutMs: e.cutMs, rate: e.rate, numeric: e.numeric, label: e.numeric === null ? "" : e.dan })),
        Math.max(0, Number(gapSec) || 0) * 1000);
    const chart = document.createElement("div");
    chart.className = "mar-curve-svg";
    chart.innerHTML = curveSvg(rows, { totalMs, width: 300, height: 96, plan, planLabel: t("marathon.curve.plan") });
    const known = rows.filter((r) => r.numeric !== null);
    const name = (r) => (r ? r.label || numericToLabel(r.numeric).text : "—");
    const total = line("muted", t("marathon.curve.total", { time: formatTime(totalMs), maps: mapsText(rows.length), from: name(known[0]), to: name(known.at(-1)) }));
    const warnings = curveWarnings(rows).map((w) => line("mar-warn", w.kind === "drop"
        ? t("marathon.curve.drop", { i: w.i, delta: signed(w.delta) })
        : t("marathon.curve.jump", { delta: signed(w.delta), a: w.a, b: w.b })));
    container.replaceChildren(chart, total, ...warnings);
}
