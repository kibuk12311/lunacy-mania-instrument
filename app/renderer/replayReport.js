// The Replay tab's sections, each a fold that remembers whether it is open: judgements, fingers, hands, manip, hit errors,
// the timing along the map, keys against notes, holds, ghost presses, combo breaks, the hardest parts, dan by part, patterns
// and earlier plays. A section with no data is left out; a value that cannot be known shows as a dash, never as zero.
// Builds from src/replay/report.js's answer; what the window does on a click comes in through `ctx`.
import { t, getLang } from "../../src/i18n/i18n.js";
import { numericToLabel } from "../../src/core/labels.js";
import { KINDS } from "../../src/replay/judge.js";
import { FINGERS } from "../../src/replay/fingers.js";
import { KIND_COLOUR } from "./replayView.js";
import { errorBars, errorScatter, columnBias, paceChart, countStrip } from "./replayCharts.js";

const OPEN_KEY = "replay-sections";
const OPEN_FIRST = new Set(["judgements", "fingers", "hands", "manip", "breaks"]);
const BREAK_ROWS = 40;

export const KIND_TEXT = {
    max: "replay.judge.max", n300: "replay.judge.n300", n200: "replay.judge.n200", n100: "replay.judge.n100", n50: "replay.judge.n50", miss: "replay.judge.miss",
};
const FAMILY_TEXT = {
    stream: "replay.family.stream", jumpstream: "replay.family.jumpstream", handstream: "replay.family.handstream",
    chordjack: "replay.family.chordjack", jack: "replay.family.jack", tech: "replay.family.tech",
};
const SHAPE_TEXT = {
    hold: "replay.shape.hold", chordjack: "replay.shape.chordjack", jack: "replay.shape.jack", quad: "replay.shape.quad", hand: "replay.shape.hand",
    jump: "replay.shape.jump", trill: "replay.shape.trill", roll: "replay.shape.roll", stream: "replay.shape.stream", single: "replay.shape.single",
};
const CAUSE_TEXT = { early: "replay.break.early", released: "replay.break.released", none: "replay.break.none" };
export const FINGER_TEXT = {
    L5: "replay.finger.L5", L4: "replay.finger.L4", L3: "replay.finger.L3", L2: "replay.finger.L2", L1: "replay.finger.L1",
    R1: "replay.finger.R1", R2: "replay.finger.R2", R3: "replay.finger.R3", R4: "replay.finger.R4", R5: "replay.finger.R5",
};
const FINGER_SHORT = {
    L5: "replay.finger.short.L5", L4: "replay.finger.short.L4", L3: "replay.finger.short.L3", L2: "replay.finger.short.L2", L1: "replay.finger.short.L1",
    R1: "replay.finger.short.R1", R2: "replay.finger.short.R2", R3: "replay.finger.short.R3", R4: "replay.finger.short.R4", R5: "replay.finger.short.R5",
};
const HAND_TEXT = { left: "replay.hand.left", right: "replay.hand.right" };

export const el = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
};
export const button = (text, className = "small", onClick = null) => {
    const b = el("button", className, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
};

const known = (x) => x !== null && x !== undefined;
export const num1 = (x) => (known(x) ? x.toFixed(1) : "—");
export const percent = (x) => (known(x) ? `${x.toFixed(1)} %` : "—");
export const acc2 = (x) => (known(x) ? `${x.toFixed(2)} %` : "—");
const signed = (x, digits = 1) => (known(x) ? `${x > 0 ? "+" : ""}${x.toFixed(digits)}` : "—");
const msText = (x) => (known(x) ? t("replay.unit.ms", { ms: signed(x) }) : "—");
const plainMs = (x) => (known(x) ? t("replay.unit.ms", { ms: x.toFixed(1) }) : "—");
const whole = (x) => (known(x) ? String(x) : "—");
const round0 = (x) => (known(x) ? Math.round(x) : null);
const fingerName = (f) => t(FINGER_TEXT[f]);
const fingerShort = (f) => t(FINGER_SHORT[f]);
const danText = (dan) => (known(dan) ? numericToLabel(dan).text : "—");
export const dateText = (ms) => (ms ? new Date(ms).toLocaleString(getLang() === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

// m:ss.d of play, from the map's ms at a rate
export function exactTime(mapMs, rate = 1) {
    const tenths = Math.max(0, Math.round(mapMs / rate / 100));
    const sec = Math.floor(tenths / 10);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}.${tenths % 10}`;
}

function readOpen() {
    try {
        const saved = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? "null");
        return saved && typeof saved === "object" ? saved : {};
    } catch {
        return {};
    }
}
function rememberOpen(id, open) {
    try {
        globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: open }));
    } catch {
        // not remembered
    }
}

// A fold: its title, a line about it that stays visible when it is shut, and what is inside.
function fold(id, title, line, ...kids) {
    const box = el("details", "rp-sec");
    box.dataset.sec = id;
    const saved = readOpen()[id];
    box.open = saved === undefined ? OPEN_FIRST.has(id) : Boolean(saved);
    const head = el("summary");
    head.append(el("span", "rp-sec-title", title));
    if (line) head.append(el("span", "muted rp-sec-line", line));
    const body = el("div", "rp-sec-body");
    body.append(...kids.flat().filter(Boolean));
    box.append(head, body);
    let shown = box.open; // the browser also tells of the state just set here
    box.addEventListener("toggle", () => {
        if (box.open === shown) return;
        shown = box.open;
        rememberOpen(id, shown);
        if (shown) for (const c of box.querySelectorAll("canvas")) c.repaint?.();
    });
    return box;
}

// A table of [label, values…] rows; a row with nothing known is left out.
function table(heads, rows, className = "") {
    const out = el("table", `rp-table ${className}`.trim());
    const head = el("tr");
    for (const text of heads) head.append(el("th", "", text));
    out.append(head);
    for (const row of rows) {
        const [label, ...values] = row.cells;
        if (values.every((v) => v === "—")) continue;
        const tr = el("tr", row.className ?? "");
        tr.append(el("td", "", label));
        for (const v of values) tr.append(el("td", "rp-num", v));
        out.append(tr);
    }
    return out;
}
const rows = (...list) => list.map((cells) => ({ cells }));

// Judgements: the replay's own counts beside the recount.
export function judgementTable(replay, analysis) {
    const out = el("table", "rp-table");
    const head = el("tr");
    for (const key of ["replay.judge.kind", "replay.judge.header", "replay.judge.ours"]) head.append(el("th", "", t(key)));
    out.append(head);
    for (const kind of KINDS) {
        const row = el("tr");
        const name = el("td");
        const dot = el("i", "rp-dot");
        dot.style.background = KIND_COLOUR[kind];
        name.append(dot, document.createTextNode(t(KIND_TEXT[kind])));
        const ours = analysis ? analysis.counts[kind] : null;
        const differs = analysis && analysis.comparison && analysis.comparison.diff[kind] !== 0;
        row.append(name, el("td", "rp-num", String(replay.counts[kind])), el("td", `rp-num${differs ? " rp-differs" : ""}`, ours === null ? "—" : String(ours)));
        out.append(row);
    }
    return out;
}

function judgementsSection({ replay, analysis }) {
    const notes = [];
    if (analysis?.scoreV2) notes.push(el("div", "muted", t("replay.judge.v2")));
    else if (analysis?.comparison) notes.push(el("div", analysis.comparison.same ? "rp-same" : "muted", analysis.comparison.same ? t("replay.judge.same") : t("replay.judge.differs", analysis.comparison)));
    if (analysis?.holds) notes.push(el("div", "muted", t("replay.judge.holds")));
    if (analysis?.holdHeavy && !analysis.comparison?.same) notes.push(el("div", "muted", t("replay.judge.holdHeavy")));
    if (analysis && analysis.played < analysis.notes) notes.push(el("div", "muted", t("replay.judge.part", analysis)));
    return fold("judgements", t("replay.html.judgements"), "", judgementTable(replay, analysis), notes);
}

// One select per column.
function fingerPicker(fingers, onChange) {
    const box = el("div", "rp-fingers");
    fingers.forEach((finger, c) => {
        const cell = el("label", "rp-finger");
        cell.append(el("span", "muted", t("replay.col.name", { n: c + 1 })));
        const select = el("select", "sk-select");
        select.dataset.col = String(c);
        select.title = fingerName(finger);
        select.append(...FINGERS.map((f) => new Option(fingerShort(f), f, false, f === finger)));
        select.addEventListener("change", () => onChange(fingers.map((old, i) => (i === c ? select.value : old))));
        cell.append(select);
        box.append(cell);
    });
    return box;
}

const fatigueText = (g) => (g.drift ? `${round0(g.drift.first.ur)} → ${round0(g.drift.last.ur)}` : "—");
const jackText = (g) => (known(g.jack?.bestMs) ? plainMs(g.jack.bestMs) : "—");
const jackBpm = (g) => (known(g.jack?.bestBpm) ? t("replay.unit.bpm", { bpm: g.jack.bestBpm }) : "—");
const speedText = (g) => (known(g.topSpeed) ? t("replay.unit.perSec", { n: g.topSpeed.toFixed(0) }) : "—");
const earlyLate = (g) => (known(g.early) ? `${g.early.toFixed(0)} / ${g.late.toFixed(0)} %` : "—");

// The rows a finger and a hand share.
const groupRows = (list, withBreaks) => rows(
    [t("replay.stat.presses"), ...list.map((g) => String(g.presses))],
    [t("replay.stat.share"), ...list.map((g) => percent(g.share))],
    [t("replay.stat.notes"), ...list.map((g) => String(g.notes))],
    [t("replay.stat.accuracy"), ...list.map((g) => acc2(g.accuracy))],
    ...KINDS.map((kind) => [t(KIND_TEXT[kind]), ...list.map((g) => String(g.counts[kind]))]),
    [t("replay.stat.ur"), ...list.map((g) => num1(g.ur))],
    [t("replay.stat.mean"), ...list.map((g) => msText(g.mean))],
    [t("replay.stat.earlyLate"), ...list.map(earlyLate)],
    [t("replay.stat.speed"), ...list.map(speedText)],
    [t("replay.stat.jack"), ...list.map(jackText)],
    [t("replay.stat.jackBpm"), ...list.map(jackBpm)],
    [t("replay.stat.fatigue"), ...list.map(fatigueText)],
    ...(list.some((g) => g.ghosts) ? [[t("replay.stat.ghosts"), ...list.map((g) => String(g.ghosts))]] : []),
    ...(withBreaks ? [[t("replay.stat.breaks"), ...list.map((g) => String(g.breaks))]] : []),
);

function fingersSection({ report, fingers, onFingers }) {
    const list = report.fingers;
    const anyBreak = list.some((f) => f.breaks);
    const line = report.breaker ? t("replay.finger.breaker", { finger: fingerName(report.breaker.finger), n: report.breaker.breaks, of: report.breaker.of }) : "";
    return fold(
        "fingers", t("replay.html.fingers"), line, fingerPicker(fingers, onFingers),
        table(["", ...list.map((f) => fingerShort(f.finger))], groupRows(list, anyBreak), "rp-wide"),
        el("div", "muted", t("replay.finger.note")),
    );
}

function handsSection({ report }) {
    const { hands, balance, manip } = report;
    const list = ["left", "right"].filter((id) => hands[id]).map((id) => ({ id, ...hands[id], manip: manip.hands[id] }));
    if (list.length < 2) return null;
    const kids = [];
    let line = "";
    if (balance && known(balance.presses)) {
        line = t("replay.hand.balance", { left: balance.presses.toFixed(0), right: (100 - balance.presses).toFixed(0) });
        const bar = el("div", "rp-balance");
        const left = el("i", "rp-balance-left");
        left.style.width = `${balance.presses}%`;
        bar.append(left);
        kids.push(bar);
    }
    const extra = rows(
        [t("replay.manip.title"), ...list.map((h) => (h.manip.pairs ? percent(h.manip.percent) : "—"))],
        [t("replay.manip.squeezeShort"), ...list.map((h) => plainMs(h.manip.squeezed?.mean ?? null))],
    );
    kids.push(table(["", ...list.map((h) => t(HAND_TEXT[h.id]))], [...groupRows(list, list.some((h) => h.breaks)), ...extra], "rp-wide"));
    if (known(balance?.leftAhead) && Math.abs(balance.leftAhead) >= 0.5) {
        kids.push(el("div", "muted", t(balance.leftAhead > 0 ? "replay.hand.leftAhead" : "replay.hand.rightAhead", { ms: Math.abs(balance.leftAhead).toFixed(1) })));
    }
    return fold("hands", t("replay.html.hands"), line, kids);
}

function manipSection({ report, timeOf }) {
    const { manip, parts, families } = report;
    if (!manip.pairs) return null;
    const kids = [];
    if (manip.squeezed) kids.push(el("div", "", t("replay.manip.squeezed", { mean: manip.squeezed.mean.toFixed(1), max: manip.squeezed.max.toFixed(1) })));
    const handRows = ["left", "right"].filter((id) => manip.hands[id].pairs).map((id) => {
        const h = manip.hands[id];
        return [t(HAND_TEXT[id]), `${h.glued} / ${h.pairs}`, percent(h.percent), plainMs(h.squeezed?.mean ?? null)];
    });
    const heads = ["", t("replay.manip.pairs"), t("replay.manip.title"), t("replay.manip.squeezeShort")];
    kids.push(el("div", "flabel rp-sub", t("replay.html.byHand")), table(heads, rows(...handRows)));
    const counted = families.filter((f) => f.pairs);
    if (counted.length) {
        kids.push(el("div", "flabel rp-sub", t("replay.html.families")), table(heads, rows(...counted.map((f) => [t(FAMILY_TEXT[f.family] ?? f.family), `${f.glued} / ${f.pairs}`, percent(f.percent), plainMs(f.squeezed?.mean ?? null)]))));
    }
    const partRows = parts.filter((p) => p.pairs).map((p) => [t("replay.part.row", { from: timeOf(p.fromMs), to: timeOf(p.toMs) }), `${p.glued} / ${p.pairs}`, percent(p.percent), plainMs(p.squeezed?.mean ?? null)]);
    if (partRows.length > 1) kids.push(el("div", "flabel rp-sub", t("replay.html.byPart")), table(heads, rows(...partRows)));
    return fold("manip", t("replay.html.manipMore"), manip.squeezed ? t("replay.manip.squeezedLine", { mean: manip.squeezed.mean.toFixed(1) }) : "", kids);
}

function errorsSection({ analysis }) {
    if (analysis.meanError === null) return null;
    const w = analysis.windows;
    const { rate } = analysis;
    const kindOfMs = (ms) => {
        const a = Math.abs(ms) * rate;
        return a <= w.max ? "max" : a <= w.n300 ? "n300" : a <= w.n200 ? "n200" : a <= w.n100 ? "n100" : "n50";
    };
    const summary = t("replay.err.summary", { mean: num1(analysis.meanError), sd: num1(analysis.sd) });
    return fold(
        "errors", t("replay.html.errors"), summary, errorBars(analysis.histogram, kindOfMs),
        el("div", "flabel rp-sub", t("replay.html.columns")), columnBias(analysis.byColumn),
    );
}

function driftSection({ report, analysis, timeOf, seek }) {
    if (analysis.meanError === null) return null;
    const { drift } = report;
    const reach = analysis.windows.n50 / analysis.rate;
    const kids = [errorScatter({
        results: analysis.results, fromMs: analysis.fromMs, toMs: analysis.toMs, reach, timeOf, onSeek: seek, line: drift?.slices.filter((s) => s.mean !== null) ?? [],
    })];
    let line = "";
    if (drift) {
        if (known(drift.slopeMsPerMin)) {
            line = t("replay.drift.slope", { ms: signed(drift.slopeMsPerMin) });
            kids.push(el("div", "muted", t(drift.slopeMsPerMin >= 0 ? "replay.drift.later" : "replay.drift.earlier", { ms: Math.abs(drift.slopeMsPerMin).toFixed(1) })));
        }
        if (drift.first && drift.last) {
            kids.push(table(["", t("replay.drift.start"), t("replay.drift.end"), t("replay.drift.change")], rows(
                [t("replay.stat.ur"), num1(drift.first.ur), num1(drift.last.ur), signed(drift.urChange)],
                [t("replay.stat.mean"), msText(drift.first.mean), msText(drift.last.mean), msText(drift.meanChange)],
                [t("replay.stat.accuracy"), acc2(drift.first.accuracy), acc2(drift.last.accuracy), `${signed(drift.accuracyChange, 2)} %`],
            )));
        }
    }
    return fold("drift", t("replay.html.errorsLine"), line, kids);
}

function paceSection({ report, analysis, timeOf, seek }) {
    const { pace } = report;
    if (!pace) return null;
    const { rate, fromMs } = analysis;
    const msOf = (sec) => sec * 1000 * rate + fromMs;
    const kids = [
        paceChart(pace, { timeOf: (s) => timeOf(msOf(s)), onSeek: (s) => seek(msOf(s)) }),
        el("div", "muted rp-legend", t("replay.pace.legend")),
    ];
    if (pace.stretches.length) {
        const list = el("div", "rp-miss-rows");
        for (const s of pace.stretches) {
            const key = s.kind === "behind" ? "replay.pace.behind" : "replay.pace.spam";
            list.append(button(t(key, { from: timeOf(msOf(s.fromSec)), to: timeOf(msOf(s.toSec)), written: s.written.toFixed(1), played: s.played.toFixed(1) }), `small rp-stretch ${s.kind}`, () => seek(msOf(s.fromSec) - 500)));
        }
        kids.push(list);
    } else kids.push(el("div", "muted", t("replay.pace.even")));
    return fold("pace", t("replay.html.pace"), t("replay.pace.summary", { nps: pace.peakWritten, kps: pace.peakPlayed }), kids);
}

function holdsSection({ report }) {
    const list = report.fingers.filter((f) => f.holds);
    if (!list.length) return null;
    const total = list.reduce((sum, f) => sum + f.holds.count, 0);
    const late = list.reduce((sum, f) => sum + f.holds.late, 0);
    return fold(
        "holds", t("replay.html.holds"), t("replay.hold.summary", { n: total, late }),
        table(["", ...list.map((f) => fingerShort(f.finger))], rows(
            [t("replay.hold.count"), ...list.map((f) => String(f.holds.count))],
            [t("replay.hold.clean"), ...list.map((f) => String(f.holds.clean))],
            [t("replay.hold.early"), ...list.map((f) => String(f.holds.early))],
            [t("replay.hold.earlyMean"), ...list.map((f) => msText(f.holds.earlyMean))],
            [t("replay.hold.late"), ...list.map((f) => String(f.holds.late))],
            [t("replay.hold.lateMean"), ...list.map((f) => msText(f.holds.lateMean))],
            [t("replay.hold.mean"), ...list.map((f) => msText(f.holds.meanRelease))],
            [t("replay.hold.dropped"), ...list.map((f) => String(f.holds.dropped))],
        ), "rp-wide"),
        el("div", "muted", t("replay.hold.note")),
    );
}

function ghostsSection({ report, analysis, timeOf, seek }) {
    const { ghosts } = report;
    if (!ghosts) return null;
    const span = analysis.toMs - analysis.fromMs;
    const binStart = (i) => analysis.fromMs + (span * i) / ghosts.bins.length;
    return fold(
        "ghosts", t("replay.html.ghosts"), t("replay.ghost.summary", { n: ghosts.total }),
        el("div", "", t("replay.ghost.split", { flow: ghosts.inFlow, idle: ghosts.idle })),
        countStrip(ghosts.bins, { timeOf: (i) => timeOf(binStart(i)), onSeek: (i) => seek(binStart(i)) }),
        el("div", "muted", t("replay.ghost.columns", { list: ghosts.byColumn.map((n, c) => `${c + 1}: ${n}`).join(" · ") })),
    );
}

function breaksSection({ replay, report, analysis, fingers, seek }) {
    const { breaks } = report;
    const { rate } = analysis;
    const kids = [];
    if (!analysis.misses.length) kids.push(el("div", "muted", t("replay.miss.none")));
    else {
        kids.push(el("div", "muted", t("replay.miss.summary", { misses: analysis.misses.length, breaks: breaks.length, max: replay.maxCombo })));
        const list = el("div", "rp-breaks");
        for (const b of breaks.slice(0, BREAK_ROWS)) {
            const row = el("button", "rp-break");
            row.type = "button";
            row.append(
                el("span", "rp-num", exactTime(b.t, rate)),
                el("span", "", fingerShort(fingers[b.col])),
                el("span", "", b.shape ? t(SHAPE_TEXT[b.shape]) : "—"),
                el("span", "muted", t(CAUSE_TEXT[b.cause])),
                el("span", "rp-num", t("replay.break.combo", { n: b.combo })),
            );
            row.addEventListener("click", () => seek(b.t - 1000));
            list.append(row);
        }
        if (breaks.length > BREAK_ROWS) list.append(el("div", "muted", t("replay.miss.more", { n: breaks.length - BREAK_ROWS })));
        kids.push(list);
    }
    return fold("breaks", t("replay.html.misses"), analysis.misses.length ? t("replay.break.line", { n: breaks.length }) : t("replay.break.clean"), kids);
}

function hardestSection({ report, timeOf, seek }) {
    const { hardest } = report;
    if (!hardest) return null;
    const list = el("div", "rp-parts");
    for (const p of hardest.parts) {
        const row = el("button", "rp-hard");
        row.type = "button";
        row.append(
            el("span", "rp-part-time", t("replay.part.row", { from: timeOf(p.fromMs), to: timeOf(p.toMs) })),
            el("span", "muted", hardest.basis === "dan" ? danText(p.dan) : t("replay.unit.nps", { n: num1(p.nps) })),
            el("span", "rp-num", acc2(p.accuracy)),
            el("span", "rp-num muted", t("replay.part.misses", { n: p.misses })),
        );
        if (known(p.versusRest)) row.append(el("span", `rp-hard-vs ${p.versusRest < 0 ? "worse" : "better"}`, t("replay.part.vsRest", { delta: signed(p.versusRest, 2) })));
        row.addEventListener("click", () => seek(p.fromMs));
        list.append(row);
    }
    return fold("hardest", t("replay.html.hardest"), t(hardest.basis === "dan" ? "replay.part.byDan" : "replay.part.byNps"), list);
}

function partsSection({ report, later, timeOf, seek }) {
    const { parts } = report;
    if (!parts.length) return null;
    const out = el("table", "rp-table rp-wide");
    const head = el("tr");
    for (const text of [t("replay.part.time"), t("replay.part.dan"), t("replay.stat.accuracy"), t("replay.part.miss"), t("replay.stat.ur"), t("replay.manip.title")]) head.append(el("th", "", text));
    out.append(head);
    for (const p of parts) {
        const tr = el("tr", "rp-seekable");
        const dan = later ? danText(p.dan) : "…";
        tr.append(
            el("td", "", t("replay.part.row", { from: timeOf(p.fromMs), to: timeOf(p.toMs) })), el("td", "rp-num", dan), el("td", "rp-num", acc2(p.accuracy)),
            el("td", "rp-num", String(p.misses)), el("td", "rp-num", num1(p.ur)), el("td", "rp-num", p.pairs ? percent(p.percent) : "—"),
        );
        tr.addEventListener("click", () => seek(p.fromMs));
        out.append(tr);
    }
    return fold("parts", t("replay.html.parts"), later ? "" : t("replay.part.waiting"), out);
}

function familiesSection({ report, later }) {
    const { families } = report;
    if (!later) return fold("families", t("replay.html.familiesAll"), t("replay.family.waiting"));
    if (!families.length) return null;
    return fold(
        "families", t("replay.html.familiesAll"), "",
        table(["", t("replay.stat.notes"), t("replay.stat.accuracy"), t("replay.part.miss"), t("replay.stat.ur"), t("replay.manip.title")], rows(
            ...families.map((f) => [t(FAMILY_TEXT[f.family] ?? f.family), String(f.notes), acc2(f.accuracy), String(f.misses), num1(f.ur), f.pairs ? percent(f.percent) : "—"]),
        ), "rp-wide"),
    );
}

function earlierSection({ replay, analysis, report, earlier }) {
    const plays = earlier?.plays ?? [];
    if (!plays.length) return null;
    const heads = [t("replay.earlier.when"), t("replay.stat.accuracy"), t("replay.part.miss"), t("replay.stat.ur"), t("replay.manip.title")];
    const when = (p) => [dateText(p.at), p.rate !== 1 ? t("replay.head.rate", { rate: p.rate }) : ""].filter(Boolean).join(" ");
    const list = [
        { cells: [t("replay.earlier.now"), acc2(analysis.accuracy), String(analysis.counts.miss), num1(analysis.ur), percent(report.manip.percent)], className: "rp-now" },
        ...plays.map((p) => ({ cells: [when(p), acc2(p.accuracy), String(p.misses), num1(p.ur), p.pairs ? percent(p.manip) : "—"] })),
    ];
    const same = plays.filter((p) => p.rate === replay.rate && known(p.accuracy));
    const best = same.length ? Math.max(...same.map((p) => p.accuracy)) : null;
    const delta = known(best) && known(analysis.accuracy) ? Math.round((analysis.accuracy - best) * 100) / 100 : null;
    const line = known(delta) ? t(delta >= 0 ? "replay.earlier.best" : "replay.earlier.below", { delta: Math.abs(delta).toFixed(2) }) : "";
    const more = earlier.total > plays.length ? el("div", "muted", t("replay.earlier.more", { n: earlier.total - plays.length })) : null;
    return fold("earlier", t("replay.html.earlier"), line, table(heads, list, "rp-wide"), more);
}

// ctx: { replay, analysis, report, later, earlier, fingers, timeOf (ms of the map → text), seek, onFingers }.
export function reportSections(ctx) {
    if (!ctx.analysis) return [judgementsSection(ctx)];
    return [
        judgementsSection(ctx), fingersSection(ctx), handsSection(ctx), manipSection(ctx), errorsSection(ctx), driftSection(ctx), paceSection(ctx),
        holdsSection(ctx), ghostsSection(ctx), breaksSection(ctx), hardestSection(ctx), partsSection(ctx), familiesSection(ctx), earlierSection(ctx),
    ].filter(Boolean);
}
