// The five overlay widgets as DOM, shared by the widget windows and the style previews in the settings window.
// mountWidget(root, widget, { style, show, dan }) builds it once; update(snapshot) puts in the numbers,
// paint(clock) draws the canvases (the KPS and NPS graphs, the key lines, the Dan line) for the map time of the moment.
// The Dan widget's map data comes with its config (dan: src/overlay/dan.js's payload), or inside a made-up snapshot.
import { t } from "../../src/i18n/i18n.js";
import { formatAccuracy, formatCount, formatKps, formatUr } from "../../src/overlay/format.js";
import { shortJudgement } from "../../src/overlay/interludeData.js";
import { danSparkGeometry, easeToward, graphCeiling, graphPoints, holdRounded, laneColor, laneRects, paletteFor } from "../../src/overlay/draw.js";
import { danKey, danView } from "../../src/overlay/dan.js";

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

// The rows of the judgements widget: osu!'s six, or Interlude's ruleset (judgeNames of the snapshot): its six under
// its own short names, or its own list when it has another number of judgements.
function judgementRows(names) {
    if (!names) return JUDGEMENTS.map((j) => ({ label: j.label(), cls: j.cls, value: (s) => s.hits[j.key] }));
    if (names.mapped) {
        return JUDGEMENTS.map((j, i) => ({ label: names.labels?.[i] ?? j.label(), cls: j.cls, value: (s) => s.hits[j.key] }));
    }
    const last = names.names.length - 1;
    return names.names.map((name, i) => ({
        label: shortJudgement(name),
        cls: i === last ? "j-miss" : JUDGEMENTS[Math.min(i, 4)].cls,
        value: (s) => s.judgeNames?.counts?.[i] ?? 0,
    }));
}
const rowsKey = (names) => (names ? `${names.mapped ? "6" : "n"}|${names.names.join("|")}` : "osu");

function mountJudgements(box, { style, show }) {
    let rows = null;
    let rowList = [];
    let cells = [];
    let shownKey = null;
    function buildRows(names) {
        shownKey = rowsKey(names);
        rowList = judgementRows(names);
        cells = [];
        rows.replaceChildren(...rowList.map((j) => {
            const row = el("div", `j-row ${j.cls}`);
            const cell = el("span", "j-value", "0");
            cells.push(cell);
            row.append(el("span", "j-label", j.label), cell);
            return row;
        }));
    }
    if (show.counts) {
        rows = el("div", "j-rows");
        buildRows(null);
        box.append(rows);
    }
    let ratio = null;
    let ratioLabel = null;
    if (show.ratio) {
        const line = el("div", "j-ratio");
        line.append((ratioLabel = el("span", "j-label", "MAX:300")), (ratio = el("b", "j-ratio-value", "—")));
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
            const names = s.judgeNames ?? null;
            if (rows && rowsKey(names) !== shownKey) buildRows(names);
            rowList.forEach((j, i) => { cells[i].textContent = formatCount(j.value(s)); });
            if (ratio) ratio.textContent = s.ratio;
            if (ratioLabel) ratioLabel.textContent = names?.mapped && names.labels ? `${names.labels[0]}:${names.labels[1]}` : "MAX:300";
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

// The payload that belongs to a snapshot: the made-up one inside it, else main's when it is for the same map and rate
// (a payload for the map before is "still counting" for this one).
export function danPayloadFor(snapshot, configured) {
    if (snapshot?.dan) return snapshot.dan;
    if (!configured || !snapshot?.checksum) return null;
    return configured.key === danKey(snapshot.checksum, snapshot.rate) ? configured : null;
}

// the map's dan at the play's rate, its pattern and how sure; the dan along the map with a playhead and "now";
// "for you"; on the results screen the play's own dan
function mountDan(box, { style, show, zoom, dan = null }) {
    let num = null;
    let label = null;
    let conf = null;
    if (show.map) {
        const head = el("div", "d-head");
        const side = el("span", "d-side");
        side.append((label = el("span", "d-label", "—")), (conf = el("span", "d-conf", "")));
        head.append((num = el("b", "d-num", "—")), side);
        box.append(head);
    }
    const pattern = show.pattern ? el("div", "d-pattern", "") : null;
    if (pattern) box.append(pattern);
    let canvas = null;
    let now = null;
    if (show.live) {
        box.append((canvas = el("canvas", "d-spark")));
        box.append((now = el("div", "d-now", "")));
    }
    const play = show.play ? el("div", "d-play", "") : null;
    if (play) box.append(play);
    const fit = show.forYou ? el("div", "d-fit", "") : null;
    if (fit) box.append(fit);
    box.classList.toggle("d-empty", !box.children.length);
    let payload = null;
    let view = null;
    const setText = (node, text) => {
        if (!node) return;
        node.textContent = text;
        node.hidden = !text;
    };
    return {
        update(s) {
            payload = danPayloadFor(s, dan);
            view = danView(payload ?? { state: "counting" }, s);
            box.dataset.state = view.state;
            if (num) num.textContent = view.number;
            if (label) label.textContent = view.label;
            setText(conf, view.confidence);
            setText(pattern, view.pattern);
            // the results screen: the play's own dan in place of "now"
            setText(now, view.results && view.play && play ? "" : view.now);
            setText(play, view.play);
            setText(fit, view.forYou);
            if (fit) fit.className = `d-fit${view.band ? ` band-${view.band}` : ""}`;
            if (canvas) canvas.hidden = view.state !== "ok" || !payload?.sections?.length;
        },
        paint() {
            if (!canvas || canvas.hidden || !canvas.clientWidth || !payload?.sections?.length) return;
            const { ctx, w, h } = sizedContext(canvas, zoom);
            const pal = paletteFor(style);
            const g = danSparkGeometry(payload.sections, { width: w, height: h, mapDan: payload.numeric, progress: view?.progress ?? 0 });
            if (!g.points.length) return;
            // the map's own dan, a thin guide across
            if (g.refY !== null) {
                ctx.globalAlpha = style === "minimal" ? 0.3 : 0.45;
                ctx.fillStyle = "#ffffff";
                for (let x = 0; x < w; x += 6) ctx.fillRect(x, Math.round(g.refY), 3, 1);
                ctx.globalAlpha = 1;
            }
            // ahead dimmed, played in full, as the NPS graph
            ctx.save();
            ctx.globalAlpha = 0.45;
            strokeGraph(ctx, g.points, { w, h, style, colour: pal.graph });
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, g.playX, h);
            ctx.clip();
            strokeGraph(ctx, g.points, { w, h, style, colour: pal.graph, glow: pal.glow });
            ctx.restore();
            ctx.globalAlpha = 1;
            ctx.fillStyle = pal.lit;
            ctx.shadowColor = pal.glow ? pal.lit : "transparent";
            ctx.shadowBlur = pal.glow ?? 0;
            ctx.fillRect(Math.min(w - 2, Math.max(0, g.playX - 1)), 0, 2, h);
            ctx.shadowBlur = 0;
        },
        style,
    };
}

const MOUNTS = { judgements: mountJudgements, kps: mountKps, nps: mountNps, keys: mountKeys, dan: mountDan };

// root gets the style's classes; returns { update(snapshot), paint(clock) }
export function mountWidget(root, widget, { style, show, zoom = 1, dan = null }) {
    root.replaceChildren();
    root.className = `ov ov-${widget} style-${style}`;
    const box = el("div", "ov-box");
    root.append(box);
    return (MOUNTS[widget] ?? mountKps)(box, { style, show, zoom, dan });
}

// the map time to draw at: the snapshot's clock run on with the real time since it came (no further than 300 ms)
export function clockAt(snapshot, receivedAt, now) {
    if (!snapshot) return 0;
    if (!snapshot.running) return snapshot.clock;
    return snapshot.clock + Math.min(Math.max(0, now - receivedAt), 300) * (snapshot.rate || 1);
}
