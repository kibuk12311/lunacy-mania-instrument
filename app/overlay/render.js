// The overlay widgets as DOM, shared by the widget windows and the style previews in the settings window.
// mountWidget(root, widget, { style, show, dan, look }) builds it once (look: the widget's settings, src/overlay/
// settings.js: its font, number weight, radius, opacities and colours, the judgements shown, the key lines' thickness); update(snapshot) puts in the numbers,
// paint(clock) draws the canvases (the KPS and NPS graphs, the key lines) for the map time of the moment and says
// whether something it draws still eases (it wants another frame without a new snapshot). live: the widget moves with
// the play's clock between two snapshots (the key lines), so a running play is drawn every frame.
// The Dan widget's map data comes with its config (dan: src/overlay/dan.js's payload), or inside a made-up snapshot.
// The map panel has no canvas: update() writes only what changed (its state comes rarely, src/overlay/mapInfo.js) and
// it draws nothing per frame (quiet: its made-up numbers need no running either).
// Nothing here may move because a number changed: a number (.num) sits in a box of its own, as wide as the largest value
// it expects in the font it is in (overlay.css), whatever the digits, so what stands beside it and the graph's size come
// from the boxes, never from the text. What does not fit its box is drawn smaller (fitNode()), which moves nothing; a
// line (.fit) that is too long for the widget in some font or language the same. fit(): the window's size changed.
import { t } from "../../src/i18n/i18n.js";
import { formatAccuracy, formatCount, formatKps, formatUr } from "../../src/overlay/format.js";
import { shortJudgement } from "../../src/overlay/interludeData.js";
import { easeToward, graphCeiling, graphPoints, holdRounded, laneColorFor, laneRects, paletteFor } from "../../src/overlay/draw.js";
import { danKey, danView } from "../../src/overlay/dan.js";
import { formatBpm, formatLength, formatRate, formatStars } from "../../src/overlay/mapInfo.js";
import { FONTS, JUDGEMENT_KEYS } from "../../src/overlay/settings.js";

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

// A text wider than its box is drawn smaller, as a whole, from the box's left edge (where a text too wide for its box
// starts, however it is aligned). scale changes no layout: nothing beside it moves, and neither box depends on the text.
// No text in it (hidden, or not laid out yet): nothing to go by. A box squeezed to nothing still has its text.
const MIN_SCALE = 0.001;
export function fitNode(node) {
    const need = node.scrollWidth;
    if (!(need > 0)) return;
    const room = node.clientWidth;
    const k = need > room ? String(Math.max(MIN_SCALE, Math.floor(((room - 0.5) / need) * 1000) / 1000)) : "";
    if ((node.style.scale ?? "") !== k) node.style.scale = k;
}

// Everything in a widget that fits itself, the numbers, then the lines, the insides before what holds them. A line is as
// wide as its boxes, whatever is in them: its width is read with the numbers at full size and their text held in
// (.fitting), so it says the same at every value and no line is looked at again for a number. Read with the numbers as
// they are, it would stay at what the value of that moment did to it: the browser counts a box drawn smaller as narrower
// by its scale and rounds it out by a pixel or two.
// → false: not laid out yet (a preview is mounted before it goes on the page), nothing done
export function fitBox(box) {
    if (!(box.clientWidth > 0)) return false;
    box.querySelectorAll(".num").forEach(fitNode);
    box.classList.toggle("fitting", true);
    [...box.querySelectorAll(".fit")].reverse().forEach(fitNode);
    box.classList.toggle("fitting", false);
    return true;
}

// The width of a number's box for the largest value it expects ("000", "100.00%"), in its own font whatever that is: a
// digit is the widest digit of the fonts on offer (Segoe UI Black's 4, Bahnschrift's, whose digits are not tabular; 1ch
// is their 0), the rest as wide as they are in the font where they are widest (em).
const DIGIT_CH = 1.04;
const SIGN_EM = { ".": 0.55, ":": 0.55, " ": 0.55, "/": 0.58, "%": 1.2 };
export function numberWidth(shape) {
    let digits = 0;
    let em = 0;
    for (const c of shape) {
        if (SIGN_EM[c]) em += SIGN_EM[c];
        else digits += 1;
    }
    return `calc(${(digits * DIGIT_CH).toFixed(2)}ch + ${em.toFixed(2)}em)`;
}

// a number in a box of its own, sized for shape
function numberNode(tag, cls, shape, text) {
    const node = el(tag, `${cls} num`, text);
    node.style.setProperty?.("--num", numberWidth(shape));
    node.room = shape.length;
    return node;
}

// A number's text: written only when it changed. → whether fitNode() must look at it: one that stays within its box's
// shape cannot leave it, so nothing is read for it; a longer one, or one already drawn smaller, can. After all the
// writes of a snapshot, so the layout is read once.
export function setNumber(node, text) {
    if (node.textContent === text) return false;
    node.textContent = text;
    return text.length > node.room || Boolean(node.style.scale);
}

// The rows of the judgements widget: osu!'s six, or Interlude's ruleset (judgeNames of the snapshot): its six under
// its own short names, or its own list when it has another number of judgements.
// rows: the judgements shown (settings: { max, n300, … }); a ruleset of its own count hides by the kind it is drawn as.
function judgementRows(names, rows = null) {
    const shown = (r) => rows?.[r.j.key] !== false;
    if (!names) return JUDGEMENTS.map((j) => ({ j, label: j.label(), cls: j.cls, value: (s) => s.hits[j.key] })).filter(shown);
    if (names.mapped) {
        return JUDGEMENTS.map((j, i) => ({ j, label: names.labels?.[i] ?? j.label(), cls: j.cls, value: (s) => s.hits[j.key] }))
            .filter(shown);
    }
    const last = names.names.length - 1;
    return names.names.map((name, i) => {
        const j = i === last ? JUDGEMENTS[5] : JUDGEMENTS[Math.min(i, 4)];
        return { j, label: shortJudgement(name), cls: j.cls, value: (s) => s.judgeNames?.counts?.[i] ?? 0 };
    }).filter(shown);
}
const rowsKey = (names) => (names ? `${names.mapped ? "6" : "n"}|${names.names.join("|")}` : "osu");

const COMPACT_LONG = ["max", "n300"];

function mountJudgements(box, { style, show, look }) {
    let rows = null;
    let rowList = [];
    let cells = [];
    let shownKey = null;
    function buildRows(names) {
        shownKey = rowsKey(names);
        rowList = judgementRows(names, look?.rows);
        // the window has room for the rows set to show; a ruleset with more of them draws them smaller to fit
        const room = JUDGEMENT_KEYS.filter((key) => look?.rows?.[key] !== false).length;
        rows.style.zoom = style !== "compact" && rowList.length > room ? String(room / rowList.length) : "";
        cells = [];
        rows.replaceChildren(...rowList.map((j) => {
            const row = el("div", `j-row fit ${j.cls}`);
            // in one line the counts that rarely reach a thousand keep the line short
            const cell = numberNode("span", "j-value", style === "compact" && !COMPACT_LONG.includes(j.j.key) ? "000" : "0000", "0");
            cells.push(cell);
            row.append(el("span", "j-label", j.label), cell);
            return row;
        }));
    }
    if (show.counts) {
        rows = el("div", "j-rows fit");
        buildRows(null);
        box.append(rows);
    }
    let ratio = null;
    let ratioLabel = null;
    if (show.ratio) {
        const line = el("div", "j-ratio fit");
        line.append((ratioLabel = el("span", "j-label", "MAX:300")), (ratio = numberNode("b", "j-ratio-value", "00.00:0", "—")));
        box.append(line);
    }
    let acc = null;
    let ur = null;
    if (show.accuracy || show.ur) {
        const foot = el("div", "j-foot fit");
        if (show.accuracy) {
            const a = el("span", "j-acc");
            a.append(el("span", "j-label", t("overlay.label.acc")), (acc = numberNode("b", "j-acc-value", "100.00%", "—")));
            foot.append(a);
        }
        if (show.ur) {
            const u = el("span", "j-ur");
            u.append(el("span", "j-label", "UR"), (ur = numberNode("b", "j-ur-value", "000.00", "—")));
            foot.append(u);
        }
        box.append(foot);
    }
    box.classList.toggle("j-empty", !box.children.length);
    return {
        update(s) {
            const names = s.judgeNames ?? null;
            const rebuilt = rows && rowsKey(names) !== shownKey;
            if (rebuilt) buildRows(names);
            const toFit = [];
            const put = (node, text) => {
                if (setNumber(node, text)) toFit.push(node);
            };
            rowList.forEach((j, i) => put(cells[i], formatCount(j.value(s))));
            if (ratio) put(ratio, s.ratio);
            const named = names?.mapped && names.labels ? `${names.labels[0]}:${names.labels[1]}` : "MAX:300";
            const relabelled = ratioLabel && ratioLabel.textContent !== named;
            if (relabelled) ratioLabel.textContent = named;
            if (acc) put(acc, formatAccuracy(s.accuracy));
            if (ur) put(ur, formatUr(s.ur));
            if (rebuilt || relabelled) fitBox(box);
            else toFit.forEach(fitNode);
        },
        paint: () => false,
        live: false,
        style,
    };
}

const NOW_TAU_MS = 180; // the big number eases towards the rate this fast
const TOP_TAU_MS = 600; // and a graph's scale towards its ceiling
const EASED = 1e-3; // an easing this near its target (in its own units) has arrived: nothing more to draw

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
    const head = el("div", "k-head fit");
    if (show[nowKey]) {
        const n = el("span", "k-now");
        n.append((now = numberNode("b", "k-now-value", "000", "0")), el("span", "k-unit", nowUnit));
        head.append(n);
    }
    if (show[maxKey]) {
        const m = el("span", "k-max");
        m.append(el("span", "k-unit", maxLabel), (max = numberNode("b", "k-max-value", "000", "0")));
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
            // eased up to now towards the old value first: frames may not have come since (nothing was moving)
            if (last !== null) {
                const ms = performance.now();
                eased = easeToward(eased, target, ms - last, NOW_TAU_MS);
                last = ms;
            }
            target = nowValue;
            if (max && setNumber(max, formatKps(maxValue))) fitNode(max);
        },
        // → whether the number still eases
        tick(ms) {
            eased = easeToward(eased, target, last === null ? 0 : ms - last, NOW_TAU_MS);
            last = ms;
            shown = holdRounded(shown, eased);
            if (now && setNumber(now, formatKps(shown))) fitNode(now);
            return Math.abs(target - eased) > EASED;
        },
    };
}

function mountKps(box, { style, show, zoom, look }) {
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
            const next = graphCeiling(s.kps.max);
            // the scale eased up to now towards the old ceiling first (as the number)
            if (last !== null && next !== ceiling) {
                const ms = performance.now();
                top = easeToward(top, ceiling, ms - last, TOP_TAU_MS);
                last = ms;
            }
            ceiling = next;
        },
        paint() {
            const ms = performance.now();
            const moving = head.tick(ms);
            top = easeToward(top, ceiling, last === null ? 0 : ms - last, TOP_TAU_MS);
            last = ms;
            const easing = moving || Math.abs(ceiling - top) > EASED;
            if (!canvas || !canvas.clientWidth) return easing;
            const { ctx, w, h } = sizedContext(canvas, zoom);
            const pal = paletteFor(style);
            const colour = look?.graphColor ?? pal.graph;
            strokeGraph(ctx, graphPoints(history, { width: w, height: h, top }), { w, h, style, colour, glow: pal.glow });
            return easing;
        },
        live: false,
        style,
    };
}

// the map's notes per second: now at the play position, the map's peak, the whole map with a playhead (or the stretch
// around the play position scrolling under a playhead that stands still: nps.profile on a grid then)
function mountNps(box, { style, show, zoom, look }) {
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
            const moving = head.tick(performance.now());
            if (!canvas || !canvas.clientWidth) return moving;
            const { ctx, w, h } = sizedContext(canvas, zoom);
            const pal = paletteFor(style);
            const list = Array.isArray(nps.profile) ? nps.profile : nps.profile?.values;
            if (!list?.length) return moving;
            const colour = look?.graphColor ?? pal.nps;
            // the top is fixed for the play (the profile's highest point, or the map's peak), so is its scale
            const top = graphCeiling(nps.top > 0 ? nps.top : Math.max(...list), 5);
            const pts = graphPoints(nps.profile, { width: w, height: h, top });
            const x = Math.round(nps.progress * w);
            // the part still ahead, dimmed; the part played, tinted in full
            ctx.save();
            ctx.globalAlpha = 0.45;
            strokeGraph(ctx, pts, { w, h, style, colour });
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, x, h);
            ctx.clip();
            strokeGraph(ctx, pts, { w, h, style, colour, glow: pal.glow });
            ctx.fillStyle = colour;
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
            return moving;
        },
        live: false,
        style,
    };
}

function mountKeys(box, { style, show, zoom, look }) {
    let canvas = null;
    if (show.lines) box.append((canvas = el("canvas", "l-lines")));
    const keysRow = el("div", "l-keys");
    box.append(keysRow);
    let keyCells = [];
    let last = null;
    const ensureKeys = (n) => {
        if (keyCells.length === n) return false;
        keyCells = Array.from({ length: n }, (_, col) => {
            const cell = el("div", "l-key");
            cell.style.setProperty("--lane", laneColorFor(style, col, n, look?.laneColors));
            const name = el("span", "l-name fit", `K${col + 1}`);
            const value = numberNode("b", "l-count", "0000", "0");
            value.room = 0; // the key count sets the cell's width, narrower than the box with many keys: every text is looked at
            cell.append(name);
            if (show.counts) cell.append(value);
            return { cell, value };
        });
        keysRow.replaceChildren(...keyCells.map((k) => k.cell));
        return true;
    };
    ensureKeys(4);
    return {
        update(s) {
            last = s;
            const rebuilt = ensureKeys(s.lanes.keys);
            const toFit = [];
            keyCells.forEach((k, i) => {
                if (setNumber(k.value, formatCount(s.lanes.counts[i]))) toFit.push(k.value);
                k.cell.classList.toggle("lit", Boolean(s.lanes.pressed[i]));
            });
            if (rebuilt) fitBox(box);
            else toFit.forEach(fitNode);
        },
        paint(clock) {
            if (!canvas || !canvas.clientWidth || !last) return false;
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
            for (const r of laneRects(bars, { clock, spanMs, keys, width: w, height: h, fill: look?.thickness ?? 1 })) {
                ctx.fillStyle = laneColorFor(style, r.col, keys, look?.laneColors);
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
            return false;
        },
        live: true,
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

// the map's overall dan at the play's rate (the card's); the extras: its pattern and how sure, "for you", on the
// results screen the play's own dan
function mountDan(box, { show, style, dan = null }) {
    let num = null;
    let label = null;
    let conf = null;
    if (show.map) {
        const head = el("div", "d-head");
        const side = el("span", "d-side");
        side.append((label = el("span", "d-label fit", "—")));
        if (show.pattern) side.append((conf = el("span", "d-conf fit", "")));
        head.append((num = numberNode("b", "d-num", "00.0", "—")), side);
        box.append(head);
    }
    const pattern = show.pattern ? el("div", "d-pattern fit", "") : null;
    if (pattern) box.append(pattern);
    const play = show.play ? el("div", "d-play fit", "") : null;
    if (play) box.append(play);
    const fit = show.forYou ? el("div", "d-fit fit", "") : null;
    if (fit) box.append(fit);
    box.classList.toggle("d-empty", !box.children.length);
    const write = (node, text) => {
        if (!node || node.textContent === text) return false;
        node.textContent = text;
        return true;
    };
    // → whether the words changed
    const setText = (node, text) => {
        if (!node) return false;
        node.hidden = !text;
        return write(node, text);
    };
    return {
        update(s) {
            const view = danView(danPayloadFor(s, dan) ?? { state: "counting" }, s);
            box.dataset.state = view.state;
            const changed = [
                write(num, view.number), write(label, view.label), setText(conf, view.confidence), setText(pattern, view.pattern),
                setText(play, view.play), setText(fit, view.forYou),
            ].some(Boolean);
            if (fit) fit.className = `d-fit fit${view.band ? ` band-${view.band}` : ""}`;
            if (changed) fitBox(box);
        },
        paint: () => false,
        live: false,
        style,
    };
}

// The map panel: the map's picture (blurred and dimmed by the widget's settings), its names, its numbers, the dan, the
// play's progress. s.map: src/overlay/mapInfo.js mapState(); s.image: a data URL when it changed, null: none.
function mountMap(box, { show, style, look }) {
    box.style.setProperty?.("--map-bar", look?.graphColor ?? paletteFor(style).graph);
    const art = show.background ? el("div", "m-art") : null;
    const img = el("img", "m-img");
    img.alt = "";
    img.hidden = true;
    if (art) {
        art.hidden = true;
        art.append(img);
        box.append(art);
    }
    // a line of the map, or nothing when it is turned off
    const line = (parent, key, cls) => {
        if (!show[key]) return null;
        const node = el("span", cls);
        parent.append(node);
        return node;
    };
    const title = line(box, "title", "m-title fit");
    const top = el("div", "m-top");
    const names = el("div", "m-names");
    const artist = line(names, "artist", "m-artist fit");
    const diffLine = el("div", "m-diff fit");
    const version = line(diffLine, "difficulty", "m-version");
    const mapper = line(diffLine, "mapper", "m-mapper");
    if (diffLine.children.length) names.append(diffLine);
    const side = el("div", "m-side fit");
    const stars = line(side, "stars", "m-stars");
    const danLine = line(side, "dan", "m-dan fit");
    if (names.children.length) top.append(names);
    if (side.children.length) top.append(side);
    if (top.children.length) box.append(top);
    const stats = el("div", "m-stats fit");
    const bpm = line(stats, "bpm", "m-bpm");
    const length = line(stats, "length", "m-len num");
    const rate = line(stats, "rate", "m-rate");
    const mods = line(stats, "mods", "m-mods");
    if (stats.children.length) box.append(stats);
    let fill = null;
    if (show.progress) {
        const bar = el("div", "m-bar");
        bar.append((fill = el("div", "m-fill")));
        box.append(bar);
    }
    box.classList.toggle("m-empty", !box.children.length);

    // → whether what the line takes up changed
    const put = (node, text) => {
        if (!node) return false;
        const hide = !text;
        const moved = node.hidden !== hide || node.textContent !== text;
        if (node.textContent !== text) node.textContent = text;
        if (node.hidden !== hide) node.hidden = hide;
        return moved;
    };
    let reserved = ""; // what the time's box is sized for
    // The time goes up through the play beside the rate and the mods: its box is as wide as "3:12 / 3:12" of its length.
    function reserveTime(shape) {
        if (shape === reserved) return false;
        reserved = shape;
        if (shape) length?.style.setProperty?.("--num", numberWidth(shape));
        else length?.style.removeProperty?.("--num");
        return true;
    }
    let shownImage = null;
    let shownProgress = null;
    function setImage(url, fake) {
        if (!art) return;
        if (url !== shownImage) {
            shownImage = url;
            if (url) img.src = url;
            else img.removeAttribute?.("src");
            img.hidden = !url;
        }
        art.classList.toggle("m-fake", fake);
        const hide = !url && !fake;
        if (art.hidden !== hide) art.hidden = hide;
    }
    return {
        update(s) {
            const m = s.map ?? null;
            if (s.image !== undefined || !m) setImage(s.image ?? null, m?.preview === true);
            else if (m.preview === true) setImage(null, true);
            const tempo = formatBpm(m?.bpm ?? null);
            const total = formatLength(m?.lengthMs ?? null);
            const running = Boolean(total) && Number.isFinite(s.elapsedMs);
            const changed = [
                put(title, m?.title || "—"),
                put(artist, m?.artist ?? ""),
                put(version, m?.difficulty ? `[${m.difficulty}]` : ""),
                put(mapper, m?.mapper ? t("overlay.map.by", { name: m.mapper }) : ""),
                put(stars, formatStars(m?.stars ?? null)),
                put(danLine, m?.dan ? danView(m.dan, s).line : ""),
                put(bpm, tempo ? `${tempo} BPM` : ""),
                reserveTime(running ? `${total} / ${total}` : ""),
                put(rate, formatRate(m?.rate ?? 1)),
                put(mods, m?.mods?.length ? m.mods.join(" ") : ""),
            ].some(Boolean);
            const ticked = put(length, running ? `${formatLength(s.elapsedMs)} / ${total}` : total);
            if (changed || (ticked && !running)) fitBox(box);
            // the seconds of a play stay within the box: the layout is read only for a time drawn smaller, or longer than it
            else if (ticked && (length.style.scale || length.textContent.length > reserved.length)) fitNode(length);
            const p = Math.min(1, Math.max(0, s.progress ?? 0));
            if (fill && p !== shownProgress) {
                shownProgress = p;
                fill.style.transform = `scaleX(${p})`;
            }
        },
        paint: () => false,
        live: false,
        quiet: true,
        style,
    };
}

const MOUNTS = { judgements: mountJudgements, kps: mountKps, nps: mountNps, keys: mountKeys, dan: mountDan, map: mountMap };

// A widget's own look as the variables overlay.css reads (null: the style's own): its font, the weight of its
// numbers, its corner radius, its panel's and its text's opacity, the judgement colours, the map panel's picture.
const JUDGEMENT_VARS = { max: "--max", n300: "--c300", n200: "--c200", n100: "--c100", n50: "--c50", miss: "--miss" };
export function lookVars(look) {
    const vars = {
        "--font-user": look?.font ? FONTS[look.font] ?? null : null,
        "--num-weight": look?.weight ? String(look.weight) : null,
        "--radius-user": Number.isFinite(look?.radius) ? `${look.radius}px` : null,
        "--bg-alpha": Number.isFinite(look?.bgOpacity) && look.bgOpacity < 1 ? String(look.bgOpacity) : null,
        "--text-alpha": Number.isFinite(look?.textOpacity) && look.textOpacity < 1 ? String(look.textOpacity) : null,
        "--map-filter": Number.isFinite(look?.bgBlur) ? (look.bgBlur > 0 ? `blur(${look.bgBlur}px)` : "none") : null,
        "--map-dim": Number.isFinite(look?.bgDim) ? String(look.bgDim) : null,
    };
    for (const key of JUDGEMENT_KEYS) vars[JUDGEMENT_VARS[key]] = look?.colors?.[key] ?? null;
    return vars;
}

function applyLook(root, look) {
    for (const [name, value] of Object.entries(lookVars(look))) {
        if (value === null) root.style.removeProperty?.(name);
        else root.style.setProperty?.(name, value);
    }
}

// root gets the style's classes and the widget's look; returns { update(snapshot), paint(clock) → still easing, live,
// fit(): the page's size changed }
export function mountWidget(root, widget, { style, show, zoom = 1, dan = null, look = null }) {
    root.replaceChildren();
    root.className = `ov ov-${widget} style-${style}${look?.colors?.max ? " own-max" : ""}`;
    applyLook(root, look);
    const box = el("div", "ov-box");
    root.append(box);
    const view = (MOUNTS[widget] ?? mountKps)(box, { style, show, zoom, dan, look });
    let fitted = false;
    const fit = () => {
        fitted = fitBox(box);
    };
    return {
        ...view,
        fit,
        update(snapshot) {
            view.update(snapshot);
            if (!fitted) fit();
        },
        paint(clock) {
            if (!fitted) fit();
            return view.paint(clock);
        },
    };
}

// the map time to draw at: the snapshot's clock run on with the real time since it came (no further than 300 ms)
export function clockAt(snapshot, receivedAt, now) {
    if (!snapshot) return 0;
    if (!snapshot.running) return snapshot.clock;
    return snapshot.clock + Math.min(Math.max(0, now - receivedAt), 300) * (snapshot.rate || 1);
}
