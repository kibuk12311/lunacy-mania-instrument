// The Replay tab's playback: the map's notes falling on the player's own skin (skinStage.js) with the replay's key presses
// on the same clock: keys and lighting follow the presses, each press leaves a tick where it landed, coloured by its
// judgement (grey: it met no note), and a pink line joins the two notes of a manip pair. A note that was hit leaves at its
// press; a missed one falls on through. The stage is cut out of osu!'s 640 × 480 so it fills the height; what is left of
// the width beside it holds combo, accuracy and the judgements so far. Space plays, ←/→ move 2 s, the wheel 0.25 s.
// Notes fall the way the skin says (its UpsideDown) until the direction button is used; the button's word is then kept.
// An Interlude play speaks its ruleset's words: its judgements' names and colours, its points for the accuracy, a combo
// that breaks where the ruleset says, and the judgement as coloured text (an osu! skin has no pictures for them).
import { t } from "../../src/i18n/i18n.js";
import { createStagePainter, STAGE_H, columnLefts } from "./skinStage.js";
import { KINDS as KIND_LIST, playedColumn, accuracyPercent } from "../../src/replay/judge.js";
import { manipPairs, MANIP, HANDS } from "../../src/replay/manip.js";
import { KEYS } from "../../src/skin/maniaFields.js";
import { shortJudgement } from "../../src/overlay/interludeData.js";

export const KIND_COLOUR = { max: "#8fd3ff", n300: "#7be08f", n200: "#f5c66b", n100: "#ffb36b", n50: "#c9a2ff", miss: "#ff8f8f" };
export const KIND_IMAGE = { max: "Hit300g", n300: "Hit300", n200: "Hit200", n100: "Hit100", n50: "Hit50", miss: "Hit0" };
export const KIND_LABEL = { max: "MAX", n300: "300", n200: "200", n100: "100", n50: "50", miss: "MISS" };
const STRAY_COLOUR = "#6b667a";
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const SCROLL = { min: 10, max: 40, initial: 24 };
const SCROLL_KEY = "replay-scroll";
const UP_KEY = "replay-up";
const VOLUME_KEY = "replay-volume";
const LEAD_MS = 1500;
const TAIL_MS = 1500;
const SEEK_MS = 2000;
const WHEEL_MS = 250;
const TICK_UNITS = 3;
const MANIP_COLOUR = "#ff9ad5";
const POPUP_UNITS = 20; // an Interlude judgement's text, in stage units, before it is fitted to the stage
const POPUP_MS = 450;
const STAGE_MARGIN_PX = 10;
const PANEL_MIN_PX = 96;

function readStored(key, fallback) {
    try {
        return globalThis.localStorage?.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}
function store(key, value) {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // not remembered
    }
}
const el = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
};

// The last index of a sorted list with key(item) ≤ x, or −1.
export function lastAtOrBefore(list, x, key = (v) => v) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (key(list[mid]) <= x) lo = mid + 1;
        else hi = mid;
    }
    return lo - 1;
}

// m:ss of play, from the map's ms at a rate (a lead-in shows as 0:00).
export function playTime(mapMs, rate = 1) {
    const sec = Math.max(0, Math.floor(mapMs / rate / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// Whether the stage is upside down: the button's "1" / "0" once it was used, the skin's UpsideDown before that.
export const stageIsUp = (choice, cfg) => (choice === null ? Boolean(cfg?.upsideDown) : choice === "1");

// Whether an analysis is of an Interlude play, judged by its ruleset (src/replay/analyzeInterlude.js).
export const fromInterlude = (analysis) => analysis?.source === "interlude";

const hasWindow = (j) => j.early !== null && j.early !== undefined && j.late !== null && j.late !== undefined;

// The ruleset judgement an error of `ms` real ms (late above 0) falls in: the first whose window holds it, the widest past
// them all. judgements: analysis.ruleset.judgements, windows in real ms.
export function judgementOfMs(judgements, ms) {
    let widest = judgements.length - 1;
    for (let i = 0; i < judgements.length; i += 1) {
        if (!hasWindow(judgements[i])) continue;
        if (ms >= -Math.abs(judgements[i].early) && ms <= Math.abs(judgements[i].late)) return i;
        widest = i;
    }
    return widest;
}

// The widest side of any of the ruleset's windows, real ms.
export const rulesetReach = (judgements) => Math.max(1, ...judgements.filter(hasWindow).map((j) => Math.max(Math.abs(j.early), Math.abs(j.late))));

// result → its colour: osu!'s six, or the ruleset's colour of the note's judgement (grey for a note that got none).
export function resultColour(analysis) {
    if (!fromInterlude(analysis)) return (r) => KIND_COLOUR[r.kind];
    const { judgements } = analysis.ruleset;
    return (r) => judgements[r.j]?.color ?? STRAY_COLOUR;
}

// What the view needs of an opened replay, in lists it can search:
// notes [{ t, col, end, gone }] played columns; holds' reach; presses per column; the colour of what each press did; the
// running totals and combo (osu!'s from the judged notes in judging order, an Interlude play's from its analysis's
// steps); an Interlude play's ruleset. A failed Interlude play's stage also draws the holds whose head was judged but
// whose end never came (analysis.unfinished), as its HUD counts their heads.
export function playbackData({ map, presses, analysis, modNames = [], hands = HANDS }) {
    const results = analysis?.results ?? null;
    const ruleset = fromInterlude(analysis) ? analysis.ruleset : null;
    const unfinished = (results && analysis.unfinished) || [];
    const onStage = unfinished.length ? [...results, ...unfinished].sort((a, b) => a.t - b.t || a.col - b.col) : results;
    const notes = onStage
        ? onStage.map((r) => ({ t: r.t, col: r.col, end: r.end, gone: r.end === null && r.press !== null ? r.press : Infinity }))
        : map.notes.map((n) => ({ t: n.t, col: playedColumn(n.col, modNames), end: n.end, gone: Infinity }));
    const reach = [];
    let far = -Infinity;
    for (const n of notes) {
        far = Math.max(far, n.end ?? n.t);
        reach.push(far);
    }
    const colourOf = resultColour(analysis);
    // a press's colour: its note's judgement. A failed Interlude play's hold whose end never came (unfinished, or let go
    // before the last frame) has none when the ruleset judges a hold only at its end, though the HUD counted its head:
    // the judgement the head's error falls in (a head missed and grabbed later: the miss, the last judgement)
    const pressColour = (r) => {
        if (!ruleset || r.j !== null || r.end === null) return colourOf(r);
        const j = r.delta === null ? ruleset.judgements.length - 1 : judgementOfMs(ruleset.judgements, r.delta);
        return colourOf({ ...r, j });
    };
    const ofPress = presses.map(() => new Map());
    for (const r of [...(results ?? []), ...unfinished]) if (r.press !== null) ofPress[r.col].set(r.press, pressColour(r));
    const hits = presses.map((_, c) => (onStage ?? []).filter((r) => r.col === c && r.press !== null).map((r) => r.press).sort((a, b) => a - b));
    let totals = [];
    let combos = [];
    if (ruleset) {
        ({ totals, combos } = rulesetTotals(analysis.steps ?? [], ruleset));
    } else {
        const judged = [...(results ?? [])].sort((a, b) => a.at - b.at);
        const counts = Object.fromEntries(KIND_LIST.map((k) => [k, 0]));
        let combo = 0;
        for (const r of judged) {
            counts[r.kind] += 1;
            combo = r.kind === "miss" ? 0 : combo + 1;
            totals.push({ at: r.at, combo, kind: r.kind, counts: { ...counts } });
        }
        combos = totals.map((x) => ({ at: x.at, combo: x.combo }));
    }
    const pairs = results ? manipPairs(results, analysis.rate, MANIP, hands) : [];
    const holds = presses.map((_, c) => (onStage ?? []).filter((r) => r.col === c && r.end !== null && r.press !== null).map((r) => ({ t: r.press, end: r.end })));
    return { notes, reach, presses, ofPress, hits, holds, totals, combos, marks: pairs.filter((p) => p.glued), pairs, ruleset };
}

// The combo at a moment: as the last change at or before it left it.
export function comboAt(data, now) {
    const i = lastAtOrBefore(data.combos, now, (c) => c.at);
    return i >= 0 ? data.combos[i].combo : 0;
}

// An Interlude play's running numbers, as the analysis's steps give them (src/replay/analyzeInterlude.js: one per event of
// Interlude's judging that changed the combo or gave a judgement, in the order the judging made them, so nothing is
// worked out again here): combos [{ at, combo }], and totals at each judgement: the counts per ruleset judgement, the
// points and judgements so far for the accuracy (Σpoints / Σjudgements), the judgement just given for the text on the
// stage.
function rulesetTotals(steps, ruleset) {
    const combos = steps.map((s) => ({ at: s.t, combo: s.combo }));
    const totals = [];
    const counts = ruleset.judgements.map(() => 0);
    let points = 0;
    let weight = 0;
    for (const s of steps) {
        if (s.j === null || s.j === undefined) continue;
        counts[s.j] += 1;
        points += s.points;
        weight += 1;
        totals.push({ at: s.t, combo: s.combo, j: s.j, points, weight, counts: [...counts] });
    }
    return { totals, combos };
}

// The running accuracy at a total, percent: osu!'s from the counts, an Interlude play's from its points.
export function totalAccuracy(data, total) {
    if (!total) return null;
    if (!data.ruleset) return accuracyPercent(total.counts);
    return total.weight ? (total.points / total.weight) * 100 : null;
}

// An Interlude accuracy (percent) the way Interlude writes it by default: two decimals, more above 99.98 %, so a play
// short of 100 % never reads 100.00 % (src/interlude/ruleset.js formatAccuracy); ilAccDigits without the sign.
export function ilAccDigits(x) {
    if (x === null || x === undefined) return "—";
    if (x === 100) return "100.00";
    return x.toFixed(x > 99.998 ? 4 : x > 99.98 ? 3 : 2);
}
export const ilAccText = (x) => (x === null || x === undefined ? "—" : `${ilAccDigits(x)} %`);

// An Interlude play's judgement at a moment, to be drawn as text: { text, colour, since } | null.
export function popupAt(data, now) {
    if (!data.ruleset) return null;
    const j = lastAtOrBefore(data.totals, now, (x) => x.at);
    const judgement = j >= 0 ? data.ruleset.judgements[data.totals[j].j] : null;
    return judgement ? { text: judgement.name, colour: judgement.color, since: now - data.totals[j].at } : null;
}

// What the keys are doing at a moment: { pressed, hold, lastHit, judgement } for the stage (an Interlude play's judgement
// is not a skin's picture: popupAt).
export function keysAt(data, now) {
    const pressed = [];
    const hold = [];
    const lastHit = [];
    for (let c = 0; c < KEYS; c += 1) {
        const list = data.presses[c] ?? [];
        const i = lastAtOrBefore(list, now, (p) => p.t);
        const down = i >= 0 && (list[i].up === null || list[i].up > now);
        pressed.push(down);
        const h = lastAtOrBefore(data.hits[c] ?? [], now);
        lastHit.push(h >= 0 ? now - data.hits[c][h] : null);
        const held = lastAtOrBefore(data.holds[c] ?? [], now, (s) => s.t);
        hold.push(down && held >= 0 && data.holds[c][held].end > now);
    }
    const j = lastAtOrBefore(data.totals, now, (x) => x.at);
    const judgement = j >= 0 && !data.ruleset ? { key: KIND_IMAGE[data.totals[j].kind], since: now - data.totals[j].at } : null;
    return { pressed, hold, lastHit, judgement };
}

// The mods that move notes on the stage: osu!'s Mirror; an Interlude play's notes come as played, its mods already in.
const playedMods = (opened) => (opened.replay.source === "interlude" ? [] : opened.replay.modNames);

// canvas: the stage; controls: where the buttons go; player: replayPlayer.js.
export function createReplayView({ canvas, controls, player }) {
    let data = null;
    let source = null;
    let rate = 1;
    let speedPick = 1;
    let cfg = null;
    let images = {};
    let visible = false;
    let frame = null;
    let upChoice = readStored(UP_KEY, null);
    const isUp = () => stageIsUp(upChoice, cfg);
    const storedScroll = Number(readStored(SCROLL_KEY, SCROLL.initial));
    let scroll = storedScroll >= SCROLL.min && storedScroll <= SCROLL.max ? storedScroll : SCROLL.initial;
    const storedVolume = Number(readStored(VOLUME_KEY, 60));
    let volume = storedVolume >= 0 && storedVolume <= 100 ? Math.round(storedVolume) : 60;
    player.setVolume(volume / 100);
    const painter = createStagePainter();

    const play = el("button", "small rp-play");
    play.addEventListener("click", () => player.toggle());
    const time = el("span", "muted rp-time");
    const dir = el("button", "small");
    dir.title = t("replay.play.directionTitle");
    dir.addEventListener("click", () => {
        upChoice = isUp() ? "0" : "1";
        store(UP_KEY, upChoice);
        showButtons();
        draw();
    });
    const seekBar = el("input", "rp-seek");
    Object.assign(seekBar, { type: "range", min: "0", max: "1", step: "1", value: "0" });
    seekBar.addEventListener("input", () => player.seek(Number(seekBar.value)));
    const speedBox = el("div", "chips rp-speed");
    speedBox.title = t("replay.play.speedTitle");
    const speedSpans = SPEEDS.map((s) => {
        const span = el("span", s === 1 ? "sel" : "", `×${s}`);
        span.addEventListener("click", () => {
            speedPick = s;
            for (const other of speedSpans) other.className = other === span ? "sel" : "";
            player.setSpeed(rate * s);
        });
        return span;
    });
    speedBox.replaceChildren(...speedSpans);
    const slider = (label, { min, max, value, unit = "" }, onInput) => {
        const row = el("label", "slider-row rp-slider");
        const input = el("input");
        Object.assign(input, { type: "range", min: String(min), max: String(max), step: "1", value: String(value) });
        const out = el("span", "muted", `${value}${unit}`);
        input.addEventListener("input", () => { out.textContent = `${input.value}${unit}`; onInput(Number(input.value)); });
        row.append(el("span", "", label), input, out);
        return row;
    };
    const scrollRow = slider(t("replay.play.scroll"), { min: SCROLL.min, max: SCROLL.max, value: scroll }, (v) => {
        scroll = v;
        store(SCROLL_KEY, String(v));
        draw();
    });
    const volumeRow = slider(t("replay.play.volume"), { min: 0, max: 100, value: volume, unit: "%" }, (v) => {
        volume = v;
        store(VOLUME_KEY, String(v));
        player.setVolume(v / 100);
    });
    const top = el("div", "row rp-buttons");
    top.append(play, time, dir);
    const speedRow = el("div", "row rp-speed-row");
    speedRow.append(el("span", "muted", t("replay.play.speed")), speedBox);
    controls.replaceChildren(top, seekBar, speedRow, scrollRow, volumeRow, el("div", "muted", t("replay.play.legend")), el("div", "muted", t("replay.play.keys")));

    function showButtons() {
        play.textContent = player.playing ? t("replay.play.pause") : t("replay.play.play");
        dir.textContent = isUp() ? t("replay.play.upscroll") : t("replay.play.downscroll");
    }

    function drawPanel(ctx, now, x, ratio) {
        const px = (n) => n * ratio;
        const j = lastAtOrBefore(data.totals, now, (v) => v.at);
        const cur = j >= 0 ? data.totals[j] : null;
        const seen = lastAtOrBefore(data.pairs, now, (p) => p.t);
        const glued = lastAtOrBefore(data.marks, now, (m) => m.t) + 1;
        const write = (text, y, { size = 11, colour = "#8a8698", weight = "" } = {}) => {
            ctx.font = `${weight} ${px(size)}px "Segoe UI", sans-serif`;
            ctx.fillStyle = colour;
            ctx.fillText(text, x, px(y));
        };
        ctx.textAlign = "left";
        let y = 22;
        write(t("replay.hud.combo"), y);
        write(String(comboAt(data, now)), y + 22, { size: 20, colour: "#eeeeee", weight: "600" });
        y += 48;
        write(t("replay.hud.accuracy"), y);
        const acc = totalAccuracy(data, cur);
        const accText = data.ruleset ? ilAccText(acc) : acc === null ? "—" : `${acc.toFixed(2)} %`;
        write(accText, y + 19, { size: 15, colour: "#eeeeee", weight: "600" });
        y += 42;
        write(t("replay.hud.manip"), y);
        write(seen >= 0 ? `${((glued / (seen + 1)) * 100).toFixed(1)} %` : "—", y + 19, { size: 15, colour: MANIP_COLOUR, weight: "600" });
        y += 42;
        const lines = data.ruleset
            ? data.ruleset.judgements.map((jd, i) => ({ label: shortJudgement(jd.name), colour: jd.color, n: cur?.counts[i] ?? 0 }))
            : KIND_LIST.map((kind) => ({ label: KIND_LABEL[kind], colour: KIND_COLOUR[kind], n: cur?.counts[kind] ?? 0 }));
        for (const line of lines) {
            write(line.label, y, { colour: line.colour, size: 12, weight: "600" });
            ctx.textAlign = "right";
            ctx.font = `${px(12)}px "Segoe UI", sans-serif`;
            ctx.fillStyle = "#cccccc";
            ctx.fillText(String(line.n), x + px(PANEL_MIN_PX - 26), px(y));
            ctx.textAlign = "left";
            y += 18;
        }
    }

    // an Interlude play's judgement, centred on the stage at the skin's ScorePosition: a quick pop, then a fade, as
    // skinStage.js draws osu!'s pictures; the text shrinks to fit the stage
    function drawPopup(ctx, popup, { stageL, stageR, up }) {
        if (!popup || popup.since >= POPUP_MS) return;
        const k = popup.since < 60 ? 1.25 - popup.since / 240 : 1;
        const room = Math.max(10, stageR - stageL - 8);
        let size = POPUP_UNITS * k;
        ctx.save();
        ctx.font = `700 ${size}px "Segoe UI", sans-serif`;
        const wide = ctx.measureText(popup.text).width;
        if (wide > room) {
            size = (size * room) / wide;
            ctx.font = `700 ${size}px "Segoe UI", sans-serif`;
        }
        ctx.globalAlpha = popup.since > 300 ? 1 - (popup.since - 300) / 150 : 1;
        ctx.fillStyle = popup.colour;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const y = cfg.scorePosition ?? STAGE_H * 0.6;
        ctx.fillText(popup.text, (stageL + stageR) / 2, up ? STAGE_H - y : y);
        ctx.restore();
    }

    function draw() {
        const now = player.now();
        const seekValue = Math.round(now);
        if (document.activeElement !== seekBar || player.playing) seekBar.value = String(seekValue);
        time.textContent = `${playTime(now, rate)} / ${playTime(player.range.to, rate)}`;
        const ctx = canvas.getContext?.("2d");
        if (!ctx || !cfg || !data) return;
        const cssW = canvas.clientWidth || 412;
        const cssH = canvas.clientHeight || 420;
        const ratio = globalThis.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cssW * ratio) || canvas.height !== Math.round(cssH * ratio)) {
            canvas.width = Math.round(cssW * ratio);
            canvas.height = Math.round(cssH * ratio);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#08070c";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const lefts = columnLefts(cfg);
        const stageL = lefts[0];
        const stageR = lefts[KEYS - 1] + cfg.columnWidth[KEYS - 1];
        const stageW = stageR - stageL;
        const room = cssW - STAGE_MARGIN_PX * 2 - PANEL_MIN_PX;
        const scale = Math.min(cssH / STAGE_H, room / stageW);
        const unit = scale * ratio;
        const dx = STAGE_MARGIN_PX * ratio - stageL * unit;
        const dy = (canvas.height - STAGE_H * unit) / 2;
        const notes = data.notes;
        const span = 11485 / scroll;
        const pastSpan = (span * (STAGE_H - cfg.hitPosition)) / cfg.hitPosition;
        const from = now - pastSpan;
        const to = now + span;
        // the notes in view: from the first whose hold can still reach it
        let lo = 0;
        let hi = notes.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (data.reach[mid] < from) lo = mid + 1;
            else hi = mid;
        }
        const last = lastAtOrBefore(notes, to, (n) => n.t);
        const shown = notes.slice(lo, last + 1);
        ctx.save();
        ctx.setTransform(unit, 0, 0, unit, dx, dy);
        ctx.beginPath();
        ctx.rect(stageL - 200, 0, stageW + 400, STAGE_H);
        ctx.clip();
        const up = isUp();
        painter.paint(ctx, {
            cfg, images, up, speed: scroll, now, notes: shown, keys: keysAt(data, now),
            overlay: ({ yOf, box, lefts: xs, widths, hit }) => {
                for (let c = 0; c < KEYS; c += 1) {
                    const list = data.presses[c] ?? [];
                    const first = lastAtOrBefore(list, from, (p) => p.t) + 1;
                    for (let i = first; i < list.length && list[i].t <= to; i += 1) {
                        const y = yOf(list[i].t);
                        if (y > hit + 40) continue;
                        box(xs[c] + 2, y - TICK_UNITS / 2, widths[c] - 4, TICK_UNITS, data.ofPress[c]?.get(list[i].t) ?? STRAY_COLOUR);
                    }
                }
                ctx.strokeStyle = MANIP_COLOUR;
                ctx.lineWidth = 2.5;
                for (let i = Math.max(0, lastAtOrBefore(data.marks, from, (m) => m.tb) + 1); i < data.marks.length && data.marks[i].t <= to; i += 1) {
                    const m = data.marks[i];
                    const y1 = yOf(m.t);
                    const y2 = yOf(m.tb);
                    ctx.beginPath();
                    ctx.moveTo(xs[m.col] + widths[m.col] / 2, up ? STAGE_H - y1 : y1);
                    ctx.lineTo(xs[m.colb] + widths[m.colb] / 2, up ? STAGE_H - y2 : y2);
                    ctx.stroke();
                }
            },
        });
        drawPopup(ctx, popupAt(data, now), { stageL, stageR, up });
        ctx.restore();
        const panelX = (STAGE_MARGIN_PX + stageW * scale + 12) * ratio;
        if ((cssW - STAGE_MARGIN_PX - stageW * scale - 12) >= PANEL_MIN_PX - 26) drawPanel(ctx, now, panelX, ratio);
    }

    function tick() {
        if (frame !== null) return;
        if (!visible || !player.playing) {
            draw();
            return;
        }
        frame = globalThis.requestAnimationFrame?.(() => {
            frame = null;
            draw();
            tick();
        }) ?? null;
    }

    player.subscribe(() => { showButtons(); tick(); });
    canvas.tabIndex = 0;
    canvas.addEventListener("click", () => player.toggle());
    canvas.addEventListener("keydown", (e) => {
        if (e.key === " ") {
            e.preventDefault?.();
            player.toggle();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault?.();
            player.seek(player.now() + (e.key === "ArrowLeft" ? -SEEK_MS : SEEK_MS));
        }
    });
    // once the field has been clicked; before that the wheel scrolls the tab as it does everywhere else
    canvas.addEventListener("wheel", (e) => {
        if (document.activeElement !== canvas) return;
        e.preventDefault?.();
        player.seek(player.now() + (e.deltaY > 0 ? WHEEL_MS : -WHEEL_MS));
    }, { passive: false });
    showButtons();

    return {
        // opened: replay-open's answer; hands: whose notes are one hand; the clock goes to just before the first note
        setReplay(opened, hands) {
            source = opened;
            rate = opened.replay.rate;
            data = playbackData({ map: opened.map, presses: opened.presses, analysis: opened.analysis, modNames: playedMods(opened), hands });
            const first = data.notes[0]?.t ?? 0;
            const end = Math.max(data.reach.at(-1) ?? 0, opened.analysis?.reachedMs ?? 0);
            player.setRange(first - LEAD_MS, end + TAIL_MS);
            player.setSpeed(rate * speedPick);
            seekBar.min = String(Math.round(first - LEAD_MS));
            seekBar.max = String(Math.round(end + TAIL_MS));
            seekBar.value = seekBar.min;
            draw();
        },
        // the fingers changed: the same replay with other manip pairs, the clock where it is
        setHands(hands) {
            if (!source) return;
            data = playbackData({ map: source.map, presses: source.presses, analysis: source.analysis, modNames: playedMods(source), hands });
            draw();
        },
        // cfg: maniaConfig; pictures: value → { img, hd } | null
        setSkin(nextCfg, pictures) {
            cfg = nextCfg;
            images = pictures ?? {};
            showButtons();
            draw();
        },
        setVisible(on) {
            visible = Boolean(on);
            if (!visible) player.pause();
            tick();
        },
        clear() {
            data = null;
            source = null;
            player.unload();
        },
        seek: (ms) => player.seek(ms),
        redraw: () => draw(),
    };
}
