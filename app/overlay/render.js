// The four overlay widgets as DOM, shared by the widget windows and the style previews in the settings window.
// mountWidget(root, widget, { style, show }) builds it once; update(snapshot) puts in the numbers,
// paint(clock) draws the canvases (the KPS and NPS graphs, the key lines) for the map time of the moment.
import { t } from "../../src/i18n/i18n.js";
import { formatAccuracy, formatCount, formatKps, formatUr } from "../../src/overlay/format.js";
import { easeToward, graphCeiling, graphPoints, holdRounded, laneColor, laneRects, paletteFor } from "../../src/overlay/draw.js";

const JUDGEMENTS = [
    { key: "max", label: () => "MAX", cls: "j-max" },
    { key: "n300", label: () => "300", cls: "j-300" },
    { key: "n200", label: () => "200", cls: "j-200" },
    { key: "n100", label: () => "100", cls: "j-100" },
    { key: "n50", label: () => "50", cls: "j-50" },
    { key: "miss", label: () => t("overlay.label.miss"), cls: "j-miss" },
];

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

// a canvas that keeps its backing store at the size it is shown (times the zoom and the screen's pixel ratio)
function sizedContext(canvas, zoom) {
    const ratio = (window.devicePixelRatio || 1) * (zoom || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
}

function mountJudgements(box, { style, show }) {
    const cells = {};
    if (show.counts) {
        const rows = el("div", "j-rows");
        for (const j of JUDGEMENTS) {
            const row = el("div", `j-row ${j.cls}`);
            row.append(el("span", "j-label", j.label()), (cells[j.key] = el("span", "j-value", "0")));
            rows.append(row);
        }
        box.append(rows);
    }
    let ratio = null;
    if (show.ratio) {
        const line = el("div", "j-ratio");
        line.append(el("span", "j-label", "MAX:300"), (ratio = el("b", "j-ratio-value", "—")));
        box.append(line);
    }
    let acc = null;
    let ur = null;
    if (show.accuracy || show.ur) {
        const foot = el("div", "j-foot");
        if (show.accuracy) {
            const a = el("span", "j-acc");
            a.append(el("span", "j-label", t("overlay.label.acc")), (acc = el("b", "", "—")));
            foot.append(a);
        }
        if (show.ur) {
            const u = el("span", "j-ur");
            u.append(el("span", "j-label", "UR"), (ur = el("b", "", "—")));
            foot.append(u);
        }
        box.append(foot);
    }
    box.classList.toggle("j-empty", !box.children.length);
    return {
        update(s) {
            for (const j of JUDGEMENTS) if (cells[j.key]) cells[j.key].textContent = formatCount(s.hits[j.key]);
            if (ratio) ratio.textContent = s.ratio;
            if (acc) acc.textContent = formatAccuracy(s.accuracy);
            if (ur) ur.textContent = formatUr(s.ur);
        },
        paint() {},
        style,
    };
}

const NOW_TAU_MS = 180; // the big number eases towards the rate this fast
const TOP_TAU_MS = 600; // and a graph's scale towards its ceiling

// a graph's polyline, stroked and filled underneath; returns the points
function strokeGraph(ctx, pts, { w, h, style, colour, glow }) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineWidth = style === "classic" ? 2.5 : 1.6;
    ctx.strokeStyle = colour;
    ctx.shadowColor = glow ? colour : "transparent";
    ctx.shadowBlur = glow ?? 0;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(w, h);
    ctx.lineTo(pts[0]?.x ?? 0, h);
    ctx.closePath();
    ctx.globalAlpha = style === "minimal" ? 0.12 : 0.22;
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.globalAlpha = 1;
}

// the head of the KPS and NPS widgets: a big number with its unit, a smaller one with its label
function mountHead(box, show, { nowKey, nowUnit, maxKey, maxLabel }) {
    let now = null;
    let max = null;
    const head = el("div", "k-head");
    if (show[nowKey]) {
        const n = el("span", "k-now");
        n.append((now = el("b", "k-now-value", "0")), el("span", "k-unit", nowUnit));
        head.append(n);
    }
    if (show[maxKey]) {
        const m = el("span", "k-max");
        m.append(el("span", "k-unit", maxLabel), (max = el("b", "k-max-value", "0")));
        head.append(m);
    }
    if (head.children.length) box.append(head);
    // the big number: eased towards the latest value every frame, and only changed when it is clearly another integer
    let target = 0;
    let eased = null;
    let shown = 0;
    let last = null;
    return {
        set(nowValue, maxValue) {
            target = nowValue;
            if (max) max.textContent = formatKps(maxValue);
        },
        tick(ms) {
            eased = easeToward(eased, target, last === null ? 0 : ms - last, NOW_TAU_MS);
            last = ms;
            shown = holdRounded(shown, eased);
            if (now) now.textContent = formatKps(shown);
        },
    };
}

function mountKps(box, { style, show, zoom }) {
    const head = mountHead(box, show, {
        nowKey: "now", nowUnit: t("overlay.label.kpsNow"), maxKey: "max", maxLabel: t("overlay.label.max"),
    });
    let canvas = null;
    if (show.graph) box.append((canvas = el("canvas", "k-graph")));
    let history = [];
    let ceiling = graphCeiling(0);
    let top = null;
    let last = null;
    return {
        update(s) {
            head.set(s.kps.now, s.kps.max);
            history = s.kps.history;
            ceiling = graphCeiling(s.kps.max);
        },
        paint() {
            const ms = performance.now();
            head.tick(ms);
            top = easeToward(top, ceiling, last === null ? 0 : ms - last, TOP_TAU_MS);
            last = ms;
            if (!canvas || !canvas.clientWidth) return;
            const { ctx, w, h } = sizedContext(canvas, zoom);
            const pal = paletteFor(style);
            strokeGraph(ctx, graphPoints(history, { width: w, height: h, top }), { w, h, style, colour: pal.graph, glow: pal.glow });
        },
        style,
    };
}

// the map's notes per second: now at the play position, the map's peak, the whole map with a playhead
function mountNps(box, { style, show, zoom }) {
    const head = mountHead(box, show, {
        nowKey: "now", nowUnit: t("overlay.label.npsNow"), maxKey: "peak", maxLabel: t("overlay.label.peak"),
    });
    let canvas = null;
    if (show.graph) box.append((canvas = el("canvas", "k-graph n-graph")));
    let nps = { ready: false, profile: [], progress: 0, peak: 0 };
    return {
        update(s) {
            nps = s.nps ?? nps;
            head.set(nps.now, nps.peak);
        },
        paint() {
            head.tick(performance.now());
            if (!canvas || !canvas.clientWidth) return;
            const { ctx, w, h } = sizedContext(canvas, zoom);
            const pal = paletteFor(style);
            if (!nps.profile.length) return;
            // the map's own peak is the top: the profile is fixed for the play, so is its scale
            const pts = graphPoints(nps.profile, { width: w, height: h, top: graphCeiling(Math.max(...nps.profile), 5) });
            const x = Math.round(nps.progress * w);
            // the part still ahead, dimmed; the part played, tinted in full
            ctx.save();
            ctx.globalAlpha = 0.45;
            strokeGraph(ctx, pts, { w, h, style, colour: pal.nps });
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, x, h);
            ctx.clip();
            strokeGraph(ctx, pts, { w, h, style, colour: pal.nps, glow: pal.glow });
            ctx.fillStyle = pal.nps;
            ctx.globalAlpha = style === "minimal" ? 0.12 : 0.2;
            ctx.fillRect(0, 0, x, h);
            ctx.restore();
            // the playhead
            ctx.globalAlpha = 1;
            ctx.fillStyle = pal.lit;
            ctx.shadowColor = pal.glow ? pal.lit : "transparent";
            ctx.shadowBlur = pal.glow ?? 0;
            ctx.fillRect(Math.min(w - 2, Math.max(0, x - 1)), 0, 2, h);
            ctx.shadowBlur = 0;
        },
        style,
    };
}

function mountKeys(box, { style, show, zoom }) {
    let canvas = null;
    if (show.lines) box.append((canvas = el("canvas", "l-lines")));
    const keysRow = el("div", "l-keys");
    box.append(keysRow);
    let keyCells = [];
    let last = null;
    const ensureKeys = (n) => {
        if (keyCells.length === n) return;
        keyCells = Array.from({ length: n }, (_, col) => {
            const cell = el("div", "l-key");
            cell.style.setProperty("--lane", laneColor(style, col));
            const name = el("span", "l-name", `K${col + 1}`);
            const value = el("b", "l-count", "0");
            cell.append(name);
            if (show.counts) cell.append(value);
            return { cell, value };
        });
        keysRow.replaceChildren(...keyCells.map((k) => k.cell));
    };
    ensureKeys(4);
    return {
        update(s) {
            last = s;
            ensureKeys(s.lanes.keys);
            keyCells.forEach((k, i) => {
                k.value.textContent = formatCount(s.lanes.counts[i]);
                k.cell.classList.toggle("lit", Boolean(s.lanes.pressed[i]));
            });
        },
        paint(clock) {
            if (!canvas || !canvas.clientWidth || !last) return;
            const { ctx, w, h } = sizedContext(canvas, zoom);
            const { keys, spanMs, bars } = last.lanes;
            const pal = paletteFor(style);
            // lane guides
            ctx.globalAlpha = style === "minimal" ? 0.08 : 0.14;
            for (let col = 1; col < keys; col += 1) {
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(Math.round((col * w) / keys), 0, 1, h);
            }
            ctx.globalAlpha = 1;
            const lit = [];
            for (const r of laneRects(bars, { clock, spanMs, keys, width: w, height: h })) {
                ctx.fillStyle = laneColor(style, r.col);
                ctx.shadowColor = pal.glow ? ctx.fillStyle : "transparent";
                ctx.shadowBlur = pal.glow ?? 0;
                // older presses fade out towards the top
                ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, (r.y + r.h) / h);
                ctx.fillRect(r.x, r.y, r.w, r.h);
                if (r.y + r.h >= h - 1) lit[r.col] = true;
            }
            ctx.globalAlpha = 1;
            ctx.shadowBlur = 0;
            keyCells.forEach((k, i) => k.cell.classList.toggle("lit", Boolean(lit[i])));
        },
        style,
    };
}

const MOUNTS = { judgements: mountJudgements, kps: mountKps, nps: mountNps, keys: mountKeys };

// root gets the style's classes; returns { update(snapshot), paint(clock) }
export function mountWidget(root, widget, { style, show, zoom = 1 }) {
    root.replaceChildren();
    root.className = `ov ov-${widget} style-${style}`;
    const box = el("div", "ov-box");
    root.append(box);
    return (MOUNTS[widget] ?? mountKps)(box, { style, show, zoom });
}

// the map time to draw at: the snapshot's clock run on with the real time since it came (no further than 300 ms)
export function clockAt(snapshot, receivedAt, now) {
    if (!snapshot) return 0;
    if (!snapshot.running) return snapshot.clock;
    return snapshot.clock + Math.min(Math.max(0, now - receivedAt), 300) * (snapshot.rate || 1);
}
