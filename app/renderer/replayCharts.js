// The Replay tab's pictures, each a small inline SVG or canvas with a shared tooltip: where the manip is along the map, the
// hit-error histogram and scatter, the early / late bias of each column, keys against notes, ghost presses. They run as wide as the card
// (the viewBoxes are about 412 wide, the tab's width at the default window) and colours come from the CSS.
import { t } from "../../src/i18n/i18n.js";
import { KIND_COLOUR } from "./replayView.js";

const SVG = "http://www.w3.org/2000/svg";
export const WIDTH = 412;

const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
};
const frame = (height, className) => svg("svg", { viewBox: `0 0 ${WIDTH} ${height}`, class: `rp-chart ${className}`, role: "img" });

// One tooltip for the tab: follows the pointer over a mark's hit target, text from textOf().
function tooltip() {
    let box = document.getElementById("rp-tip");
    if (!box) {
        box = document.createElement("div");
        box.id = "rp-tip";
        box.className = "rp-tip";
        box.hidden = true;
        document.body.append(box);
    }
    return box;
}
export function withTip(target, textOf) {
    const box = tooltip();
    target.addEventListener("pointermove", (e) => {
        const text = textOf(e);
        box.hidden = !text;
        if (!text) return;
        box.textContent = text;
        box.style.left = `${Math.min(e.clientX + 12, (globalThis.innerWidth ?? 440) - 180)}px`;
        box.style.top = `${e.clientY + 14}px`;
    });
    target.addEventListener("pointerleave", () => { box.hidden = true; });
}

// A bar with a 3 px rounded top standing on the baseline at y0.
function bar(x, y0, w, h, cls) {
    const r = Math.min(3, w / 2, h);
    return svg("path", { d: `M${x} ${y0}V${y0 - h + r}Q${x} ${y0 - h} ${x + r} ${y0 - h}H${x + w - r}Q${x + w} ${y0 - h} ${x + w} ${y0 - h + r}V${y0}Z`, class: cls });
}

// Manip along the map: a bar per stretch, as high as the share of its pairs that were glued; none where there are no pairs.
// bins: [{ pairs, glued }]; timeOf(i): text of a bin's start; onSeek(i).
export function manipStrip(bins, { timeOf, onSeek }) {
    const H = 46;
    const base = H - 1;
    const node = frame(H, "rp-strip");
    node.append(svg("line", { x1: 0, x2: WIDTH, y1: base + 0.5, y2: base + 0.5, class: "rp-axis" }));
    const step = WIDTH / bins.length;
    bins.forEach((b, i) => {
        const x = i * step;
        if (b.pairs > 0) {
            const h = (b.glued / b.pairs) * (H - 6);
            if (h > 0) node.append(bar(x + 1, base, step - 2, Math.max(2, h), "rp-manip-bar"));
            else node.append(svg("rect", { x: x + 1, y: base - 1, width: step - 2, height: 1, class: "rp-manip-clean" }));
        }
        const hit = svg("rect", { x, y: 0, width: step, height: H, class: "rp-hit" });
        withTip(hit, () => t("replay.manip.tip", { from: timeOf(i), to: timeOf(i + 1), glued: b.glued, pairs: b.pairs }));
        hit.addEventListener("click", () => onSeek(i));
        node.append(hit);
    });
    return node;
}

// The hit errors' histogram, one bar per bin, coloured by the judgement the bin falls in. histogram: analyze.js;
// kindOfMs(ms) → a judgement.
export function errorBars(histogram, kindOfMs) {
    const H = 90;
    const base = H - 16;
    const node = frame(H, "rp-hist");
    const { counts, from, binMs } = histogram;
    const top = Math.max(1, ...counts);
    const step = WIDTH / counts.length;
    counts.forEach((n, i) => {
        const left = from + i * binMs;
        if (n > 0) {
            const b = bar(i * step + 1, base, Math.max(1, step - 2), Math.max(2, (n / top) * (base - 4)), "rp-hist-bar");
            b.setAttribute("style", `fill:${KIND_COLOUR[kindOfMs(left + binMs / 2)]}`);
            node.append(b);
        }
        const hit = svg("rect", { x: i * step, y: 0, width: step, height: H, class: "rp-hit" });
        withTip(hit, () => t("replay.err.bin", { from: left, to: left + binMs, n }));
        node.append(hit);
    });
    const middle = WIDTH / 2;
    node.append(svg("line", { x1: 0, x2: WIDTH, y1: base + 0.5, y2: base + 0.5, class: "rp-axis" }));
    node.append(svg("line", { x1: middle, x2: middle, y1: 0, y2: base, class: "rp-zero" }));
    const label = (x, text, anchor) => {
        const node2 = svg("text", { x, y: H - 3, "text-anchor": anchor, class: "rp-label" });
        node2.textContent = text;
        return node2;
    };
    node.append(label(0, `${from} ${t("replay.err.early")}`, "start"), label(middle, "0", "middle"), label(WIDTH, `+${-from} ${t("replay.err.late")}`, "end"));
    return node;
}

// Each hit as a dot along the map: late above the line, early under it, misses as red ticks at the bottom. A canvas, a map
// can have tens of thousands. fromMs / toMs: the map's stretch; reach: real ms at the top and bottom; line: slices of the
// play with their mean error, drawn over the dots.
export function errorScatter({ results, fromMs, toMs, reach, timeOf, onSeek, line = [] }) {
    const canvas = document.createElement("canvas");
    canvas.className = "rp-scatter";
    const H = 110;
    const paint = () => {
        const ctx = canvas.getContext?.("2d");
        if (!ctx) return;
        const ratio = globalThis.devicePixelRatio || 1;
        const w = canvas.clientWidth || WIDTH;
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(H * ratio);
        ctx.scale(ratio, ratio);
        const xOf = (t2) => ((t2 - fromMs) / Math.max(1, toMs - fromMs)) * w;
        const yOf = (d) => H / 2 + (Math.max(-reach, Math.min(reach, d)) / reach) * (H / 2 - 4);
        ctx.fillStyle = "#2c2840";
        ctx.fillRect(0, Math.round(H / 2), w, 1);
        for (const r of results) {
            if (r.kind === "miss") {
                ctx.fillStyle = KIND_COLOUR.miss;
                ctx.fillRect(xOf(r.t), H - 8, 1.5, 8);
            } else if (r.delta !== null) {
                ctx.fillStyle = KIND_COLOUR[r.kind];
                ctx.fillRect(xOf(r.t), yOf(-r.delta) - 1, 2, 2);
            }
        }
        if (line.length > 1) {
            ctx.strokeStyle = "#ffffffcc";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            line.forEach((slice, i) => {
                const x = xOf((slice.fromMs + slice.toMs) / 2);
                const y = yOf(-slice.mean);
                if (i) ctx.lineTo(x, y);
                else ctx.moveTo(x, y);
            });
            ctx.stroke();
        }
    };
    const msAt = (e) => {
        const box = canvas.getBoundingClientRect();
        return fromMs + ((e.clientX - box.left) / Math.max(1, box.width)) * (toMs - fromMs);
    };
    withTip(canvas, (e) => {
        const box = canvas.getBoundingClientRect();
        const delta = Math.round(((H / 2 - (e.clientY - box.top)) / (H / 2 - 4)) * reach);
        return t("replay.err.point", { time: timeOf(msAt(e)), delta: delta > 0 ? `+${delta}` : delta });
    });
    canvas.addEventListener("click", (e) => onSeek(msAt(e)));
    // sized once it is in the page
    globalThis.requestAnimationFrame?.(paint);
    canvas.repaint = paint;
    return canvas;
}

// Early / late bias per column: one row each, a dot at the column's mean on an axis around 0.
// columns: analyze.js byColumn; reach: ms at the ends.
export function columnBias(columns) {
    const box = document.createElement("div");
    box.className = "rp-cols";
    const X0 = 0;
    const X1 = 200;
    const reach = Math.max(10, ...columns.map((c) => Math.abs(c.mean ?? 0))) * 1.2;
    for (const c of columns) {
        const row = document.createElement("div");
        row.className = "rp-col";
        const name = document.createElement("span");
        name.textContent = t("replay.col.name", { n: c.col + 1 });
        const plot = svg("svg", { viewBox: `${X0} 0 ${X1} 18`, class: "rp-col-plot", role: "img" });
        plot.append(svg("line", { x1: X0, x2: X1, y1: 9, y2: 9, class: "rp-axis" }), svg("line", { x1: 100, x2: 100, y1: 2, y2: 16, class: "rp-zero" }));
        const value = document.createElement("span");
        value.className = "rp-num";
        if (c.mean === null) value.textContent = t("replay.col.none");
        else {
            plot.append(svg("circle", { cx: 100 + (c.mean / reach) * 96, cy: 9, r: 5, class: "rp-col-dot" }));
            value.textContent = `${c.mean > 0 ? "+" : ""}${c.mean} ${t(c.mean < 0 ? "replay.err.early" : "replay.err.late")}`;
        }
        row.append(name, plot, value);
        withTip(row, () => (c.mean === null ? t("replay.col.none") : t("replay.col.tip", { n: c.col + 1, mean: c.mean, sd: c.sd, miss: c.misses })));
        box.append(row);
    }
    return box;
}

// Notes written against keys pressed, second by second: the written notes as an area, the presses as a line, the stretches
// where the player fell behind or spammed shaded. pace: src/replay/flow.js paceLine; timeOf(second) → text.
export function paceChart(pace, { timeOf, onSeek }) {
    const H = 96;
    const base = H - 2;
    const { written, played, stretches } = pace;
    const top = Math.max(1, ...written, ...played);
    const node = frame(H, "rp-kps");
    const last = Math.max(1, written.length - 1);
    const xOf = (i) => (i / last) * WIDTH;
    const yOf = (v) => base - (v / top) * (base - 6);
    const path = (list) => list.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join("L");
    for (const s of stretches) node.append(svg("rect", { x: xOf(s.fromSec), y: 0, width: Math.max(2, xOf(s.toSec) - xOf(s.fromSec)), height: base, class: `rp-stretch-${s.kind}` }));
    node.append(svg("path", { d: `M0,${base}L${path(written)}L${WIDTH},${base}Z`, class: "rp-nps-area" }));
    node.append(svg("path", { d: `M${path(played)}`, class: "rp-kps-line" }));
    node.append(svg("line", { x1: 0, x2: WIDTH, y1: base + 0.5, y2: base + 0.5, class: "rp-axis" }));
    const cross = svg("line", { x1: 0, x2: 0, y1: 0, y2: base, class: "rp-zero", visibility: "hidden" });
    node.append(cross);
    const cover = svg("rect", { x: 0, y: 0, width: WIDTH, height: H, class: "rp-hit" });
    const at = (e) => {
        const box = node.getBoundingClientRect();
        return Math.max(0, Math.min(last, Math.round(((e.clientX - box.left) / Math.max(1, box.width)) * last)));
    };
    withTip(cover, (e) => {
        const i = at(e);
        cross.setAttribute("x1", xOf(i));
        cross.setAttribute("x2", xOf(i));
        cross.setAttribute("visibility", "visible");
        return t("replay.pace.tip", { time: timeOf(i), written: written[i], played: played[i] });
    });
    cover.addEventListener("pointerleave", () => cross.setAttribute("visibility", "hidden"));
    cover.addEventListener("click", (e) => onSeek(at(e)));
    node.append(cover);
    return node;
}

// How many of something fell in each stretch of the map, a bar each; empty stretches stay empty.
export function countStrip(bins, { timeOf, onSeek }) {
    const H = 34;
    const base = H - 1;
    const node = frame(H, "rp-strip");
    node.append(svg("line", { x1: 0, x2: WIDTH, y1: base + 0.5, y2: base + 0.5, class: "rp-axis" }));
    const step = WIDTH / bins.length;
    const top = Math.max(1, ...bins);
    bins.forEach((n, i) => {
        if (n > 0) {
            node.append(bar(i * step + 1, base, step - 2, Math.max(2, (n / top) * (H - 6)), "rp-ghost-bar"));
            const hit = svg("rect", { x: i * step, y: 0, width: step, height: H, class: "rp-hit" });
            withTip(hit, () => t("replay.ghost.tip", { from: timeOf(i), to: timeOf(i + 1), n }));
            hit.addEventListener("click", () => onSeek(i));
            node.append(hit);
        }
    });
    return node;
}
