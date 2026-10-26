// Song timeline of the create tab (mapgen v3): the energy curve under coloured part bands with their names, the
// playhead and the chosen variant's dan badges; a click picks a part and seeks, dragging seeks. Under it the part editor:
// kind, own patterns (chips and share sliders), own dan (a level, or «Как у всей карты»; the step may be «любой»),
// «Без нот», split at the cursor, merge with the next, reset, and the lock toggle once there is a result.
// Edited parts carry a dot; the pure helpers return new lists and leave the ones given alone.
// Wave 3 (stream U): the chosen variant's song structure on the curve — a thin tick at each phrase start and a
// coloured underline under each repeated section, the same colour for sections that repeat each other — and
// «Перегенерировать только эту часть» in the editor, which keeps every other part as it is.
import { t } from "../../src/i18n/i18n.js";
import { LEVELS, STEPS, normalizeShares } from "../../src/gen/request.js";
import { danRange } from "../../src/gen/search.js";
import { isDetailed } from "./patternMode.js";
import { renderPatternChips, choiceOf, patternsOf, toggleFamily, toggleFlavour } from "./patternPicker.js";
import { numericToLabel } from "../../src/core/labels.js";
import { prepareCanvas, clockText } from "./snapColors.js";

export const MAX_PARTS = 24;
export const MAX_OWN_RANGES = 8;
export const PART_KINDS = ["intro", "build", "drop", "break", "outro", "part"];
export const KIND_KEYS = {
    intro: "create.parts.kind.intro", build: "create.parts.kind.build", drop: "create.parts.kind.drop",
    break: "create.parts.kind.break", outro: "create.parts.kind.outro", part: "create.parts.kind.part",
};
const KIND_COLORS = { intro: "#8fd3ff", build: "#ffb36b", drop: "#ff8f8f", break: "#7be08f", outro: "#c9a2ff", part: "#8a8698" };
const REPEAT_COLORS = ["#f5c66b", "#7be08f", "#8fd3ff", "#ff9ad5", "#c9a2ff", "#ffb36b"];
const PHRASE_TICK = "#ffffff99";
const SAME_SPAN = 0.5; // two sections are the same one when they overlap by this share of the shorter
const HEIGHT = 64;
const WIDTH = 432; // until the canvas has a CSS width
const MIN_SPLIT_MS = 1000;
const ANY_STEP = "any";

export const kindText = (kind) => t(KIND_KEYS[kind] ?? KIND_KEYS.part);
export const rangeText = (r) => `${numericToLabel(r.lo + 0.1).text} — ${numericToLabel(r.hi - 0.1).text}`;

// Splits part `index` at atMs; null when atMs is not inside it by minMs, or the list is full.
export function splitPart(parts, index, atMs, minMs = MIN_SPLIT_MS) {
    const p = parts[index];
    if (!p || parts.length >= MAX_PARTS || !(atMs >= p.startMs + minMs && atMs <= p.endMs - minMs)) return null;
    const at = Math.round(atMs);
    return [...parts.slice(0, index), { ...p, endMs: at, edited: true }, { ...p, startMs: at, edited: true }, ...parts.slice(index + 1)];
}

// Part `index` and the next one become one, with the first one's settings; null for the last part.
export function mergeParts(parts, index) {
    if (index < 0 || index + 1 >= parts.length) return null;
    return [...parts.slice(0, index), { ...parts[index], endMs: parts[index + 1].endMs, edited: true }, ...parts.slice(index + 2)];
}

// A part's own dan: one step's band, or with «любой» the whole level.
export const partRange = (level, step) => (step === ANY_STEP ? { lo: level - 0.5, hi: level + 0.5 } : danRange({ level, step }, { level, step }));

// The badge of a part of the chosen variant: { text, ok } (ok: true in range, false out of it, null without an own range),
// or null when the part has no dan of its own (empty, or too short to tell).
export function badgeText(report) {
    if (!report || report.empty || !report.dan) return null;
    const label = report.dan.label;
    if (report.wanted && report.inRange) return { text: `✓ ${label}`, ok: true };
    if (report.wanted) return { text: t("create.parts.badgeOff", { label, wanted: rangeText(report.wanted) }), ok: false };
    return { text: `≈ ${label}`, ok: null };
}

// structure.repeats ([{ aMs, bMs, lenMs, sim }]) → groups of sections that repeat each other, each with its colour:
// [{ color, spans: [[fromMs, toMs]…] }]. A repeat whose first section is already in a group joins that group.
export function repeatGroups(repeats) {
    const groups = [];
    const same = (x, y) => {
        const overlap = Math.min(x[1], y[1]) - Math.max(x[0], y[0]);
        return overlap > SAME_SPAN * Math.min(x[1] - x[0], y[1] - y[0]);
    };
    const add = (group, span) => { if (!group.spans.some((s) => same(s, span))) group.spans.push(span); };
    for (const r of Array.isArray(repeats) ? repeats : []) {
        if (![r?.aMs, r?.bMs, r?.lenMs].every(Number.isFinite) || r.lenMs <= 0) continue;
        const a = [r.aMs, r.aMs + r.lenMs];
        const b = [r.bMs, r.bMs + r.lenMs];
        const group = groups.find((g) => g.spans.some((s) => same(s, a) || same(s, b)));
        if (group) {
            add(group, a);
            add(group, b);
        } else {
            groups.push({ color: REPEAT_COLORS[groups.length % REPEAT_COLORS.length], spans: [a, b] });
        }
    }
    return groups;
}

// The part under ms (the last one past the end).
export function partAt(parts, ms) {
    const i = parts.findIndex((p) => ms >= p.startMs && ms < p.endMs);
    if (i >= 0) return i;
    return ms < (parts[0]?.startMs ?? 0) ? 0 : parts.length - 1;
}

// Loudness curve 0–1 over `points` steps of the song, from the envelope's frame energy (when energyCurve is missing).
export function energyFallback(envelope, durationMs, points) {
    const energy = envelope?.energy ?? envelope?.values ?? [];
    const hop = envelope?.hopSec ?? 0.01;
    const out = new Float32Array(points);
    let max = 0;
    for (let i = 0; i < points; i += 1) {
        const from = Math.floor(((i / points) * durationMs) / 1000 / hop);
        const to = Math.max(from + 1, Math.floor((((i + 1) / points) * durationMs) / 1000 / hop));
        let sum = 0;
        let n = 0;
        for (let f = from; f < to && f < energy.length; f += 1) {
            sum += energy[f];
            n += 1;
        }
        out[i] = n ? sum / n : 0;
        if (out[i] > max) max = out[i];
    }
    if (max > 0) for (let i = 0; i < points; i += 1) out[i] /= max;
    return out;
}

// The timeline's parts → the generator's PartSpec[] (§2.2): only the fields it reads, shares normalised; a part's
// flavours go only when `detailed` (the Detailed mode), else the part keeps them for later and sends families.
export function toPartSpecs(parts, { detailed = false } = {}) {
    return parts.map((p) => {
        const spec = { startMs: p.startMs, endMs: p.endMs, kind: p.kind };
        if (p.range) spec.range = { lo: p.range.lo, hi: p.range.hi };
        if (p.patterns?.length) spec.patterns = normalizeShares(detailed ? p.patterns : p.patterns.map(({ name, share }) => ({ name, share })));
        if (p.empty) spec.empty = true;
        if (Number.isSafeInteger(p.seed)) spec.seed = p.seed;
        return spec;
    });
}

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function option(text, value) {
    const node = document.createElement("option");
    node.textContent = text;
    node.value = value;
    return node;
}

// getCursor() → ms; onSeek(ms); onChange(parts) after an edit; onReset() asks for the parts to be found again;
// onToggleLock(index) locks / unlocks a part of the chosen variant; onOnlyThis(index) regenerates only that part.
export function createTimeline({ canvas, editor, getCursor, onSeek, onChange, onReset, onToggleLock, onOnlyThis }) {
    let parts = [];
    let energy = null;
    let durationMs = 0;
    let selected = null;
    let reports = null;
    let locks = new Set();
    let canLock = false;
    let structure = null; // the chosen variant's { phrases, repeats }
    let width = WIDTH;
    let dragging = false;

    const xOf = (ms) => (durationMs ? (ms / durationMs) * width : 0);
    const msOf = (x) => Math.max(0, Math.min(durationMs, (x / width) * durationMs));

    function draw(now = getCursor()) {
        const { ctx, width: w } = prepareCanvas(canvas, WIDTH, HEIGHT);
        width = w;
        if (!ctx) return;
        ctx.fillStyle = "#1c1928";
        ctx.fillRect(0, 0, w, HEIGHT);
        if (!durationMs) return;
        parts.forEach((p, i) => {
            const x0 = xOf(p.startMs);
            const x1 = xOf(p.endMs);
            ctx.globalAlpha = p.empty ? 0.08 : i === selected ? 0.32 : 0.18;
            ctx.fillStyle = KIND_COLORS[p.kind] ?? KIND_COLORS.part;
            ctx.fillRect(x0, 0, x1 - x0, HEIGHT);
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#14121c";
            ctx.fillRect(Math.round(x0), 0, 1, HEIGHT);
        });
        if (energy?.length) {
            ctx.fillStyle = "#8fd3ff55";
            ctx.beginPath?.();
            ctx.moveTo?.(0, HEIGHT - 4);
            for (let i = 0; i < energy.length; i += 1) ctx.lineTo?.((i / (energy.length - 1 || 1)) * w, HEIGHT - 4 - energy[i] * (HEIGHT - 24));
            ctx.lineTo?.(w, HEIGHT - 4);
            ctx.closePath?.();
            ctx.fill?.();
        }
        // phrase starts: thin ticks at the foot of the curve; repeated sections: underlines, one colour per group
        ctx.fillStyle = PHRASE_TICK;
        for (const p of structure?.phrases ?? []) {
            if (Number.isFinite(p?.startMs) && p.startMs > 0 && p.startMs < durationMs) ctx.fillRect(Math.round(xOf(p.startMs)), HEIGHT - 14, 1, 10);
        }
        for (const group of repeatGroups(structure?.repeats)) {
            ctx.fillStyle = group.color;
            for (const [from, to] of group.spans) ctx.fillRect(xOf(from), HEIGHT - 3, Math.max(1, xOf(Math.min(to, durationMs)) - xOf(from)), 2);
        }
        ctx.font = "10px Segoe UI, sans-serif";
        parts.forEach((p, i) => {
            const x0 = xOf(p.startMs);
            const room = xOf(p.endMs) - x0;
            if (room < 18) return;
            ctx.fillStyle = KIND_COLORS[p.kind] ?? KIND_COLORS.part;
            const name = `${p.edited ? "• " : ""}${kindText(p.kind)}`;
            ctx.fillText(room > 60 ? name : name.slice(0, Math.max(1, Math.floor(room / 7))), x0 + 3, 11);
            if (locks.has(i)) {
                ctx.fillStyle = "#f5c66b";
                ctx.fillRect(xOf(p.endMs) - 8, 4, 5, 5);
            }
            if (i === selected) {
                ctx.strokeStyle = "#eeeeee";
                ctx.strokeRect?.(x0 + 0.5, 0.5, room - 1, HEIGHT - 1);
            }
        });
        for (const r of reports ?? []) {
            const badge = badgeText(r);
            const room = xOf(r.endMs) - xOf(r.startMs);
            if (!badge || room < 30) continue;
            ctx.fillStyle = badge.ok === true ? "#7be08f" : badge.ok === false ? "#f5c66b" : "#cccccc";
            const text = room > 120 ? badge.text : badge.text.split(" (")[0];
            // squeezed into its own part, so a narrow part's badge does not run over the next one's
            ctx.fillText(text, xOf(r.startMs) + 3, HEIGHT - 6, room - 6);
        }
        ctx.fillStyle = "#eeeeee";
        ctx.fillRect(Math.round(xOf(now)), 0, 1, HEIGHT);
    }

    const offsetX = (e) => (Number.isFinite(e.offsetX) ? e.offsetX : 0);
    canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !durationMs) return;
        dragging = true;
        canvas.setPointerCapture?.(e.pointerId);
        const ms = msOf(offsetX(e));
        if (parts.length) {
            const i = partAt(parts, ms);
            if (i !== selected) {
                selected = i;
                renderEditor();
            }
        }
        onSeek?.(ms);
        draw(ms);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!dragging || !(e.buttons & 1)) return;
        const ms = msOf(offsetX(e));
        onSeek?.(ms);
        draw(ms);
    });
    canvas.addEventListener("pointerup", () => { dragging = false; });

    function edit(index, change) {
        parts = parts.map((p, i) => (i === index ? { ...p, ...change, edited: true } : p));
        renderEditor();
        draw();
        onChange?.(parts);
    }

    function replace(next) {
        if (!next) return;
        parts = next;
        selected = selected === null ? null : Math.min(selected, parts.length - 1);
        renderEditor();
        draw();
        onChange?.(parts);
    }

    // the part's own patterns: the same chips as the whole map's (patternPicker.js), in the shared mode; a part keeps
    // its flavours while the mode is General (they are sent only in Detailed)
    function patternEditor(index) {
        const p = parts[index];
        const own = choiceOf(p.patterns ?? []);
        const chosen = own.families;
        const box = el("div", "group");
        const chips = el("div", "chips");
        const save = () => {
            const patterns = patternsOf(own, true);
            edit(index, { patterns: patterns.length ? patterns : undefined });
        };
        renderPatternChips(chips, own, {
            detailed: isDetailed(),
            onFamily: (name) => { toggleFamily(own, name); save(); },
            onFlavour: (name, id) => { toggleFlavour(own, name, id); save(); },
        });
        // no chip: the part takes the whole map's patterns
        chips.title = chosen.size ? "" : t("create.parts.same");
        box.append(chips);
        if (chosen.size > 1) {
            const labels = new Map();
            const showPercents = () => {
                const total = [...chosen.values()].reduce((a, b) => a + b, 0) || 1;
                for (const [n, label] of labels) label.textContent = `${Math.round((chosen.get(n) / total) * 100)}%`;
            };
            for (const [name, value] of chosen) {
                const row = el("label", "slider-row");
                const input = el("input");
                input.type = "range";
                input.min = "0";
                input.max = "100";
                input.value = String(value);
                const pct = el("span");
                labels.set(name, pct);
                // only the numbers change while dragging; the part takes the value when the slider is let go
                input.addEventListener("input", () => { chosen.set(name, Number(input.value)); showPercents(); });
                input.addEventListener("change", () => {
                    chosen.set(name, Number(input.value));
                    parts = parts.map((x, i) => (i === index ? { ...x, patterns: patternsOf(own, true), edited: true } : x));
                    draw();
                    onChange?.(parts);
                });
                row.append(el("span", "", name), input, pct);
                box.append(row);
            }
            showPercents();
        }
        return box;
    }

    function danEditor(index) {
        const p = parts[index];
        const row = el("div", "row");
        row.title = t("create.parts.danHint");
        const level = el("select");
        level.dataset.role = "level";
        level.replaceChildren(option(t("create.parts.same"), ""), ...LEVELS.map((l) => option(l.name, String(l.value))));
        level.value = p.level ? String(p.level) : "";
        const others = parts.filter((x, i) => i !== index && x.range).length;
        level.disabled = !p.range && others >= MAX_OWN_RANGES;
        const step = el("select");
        step.dataset.role = "step";
        step.replaceChildren(option(t("create.parts.anyStep"), ANY_STEP), ...STEPS.map((s) => option(s.id, s.id)));
        step.value = p.step ?? ANY_STEP;
        step.hidden = !p.level;
        level.addEventListener("change", () => {
            const value = Number(level.value);
            if (!level.value || !value) edit(index, { level: undefined, step: undefined, range: undefined });
            else edit(index, { level: value, step: p.step ?? ANY_STEP, range: partRange(value, p.step ?? ANY_STEP) });
        });
        step.addEventListener("change", () => {
            if (!p.level) return;
            edit(index, { step: step.value, range: partRange(p.level, step.value) });
        });
        row.append(level, step);
        return row;
    }

    function renderEditor() {
        const kids = [];
        const drops = parts.filter((p) => p.kind === "drop").length;
        if (parts.length) kids.push(el("div", "muted", t("create.parts.found", { n: parts.length, d: drops })));
        const reset = el("button", "small", t("create.parts.reset"));
        reset.addEventListener("click", () => onReset?.());
        if (selected === null || !parts[selected]) {
            if (parts.length) kids.push(el("div", "muted", t("create.parts.hint")));
            const row = el("div", "row");
            row.append(reset);
            kids.push(row);
        } else {
            const i = selected;
            const p = parts[i];
            const head = el("div", "row");
            const kind = el("select");
            kind.dataset.role = "kind";
            kind.replaceChildren(...PART_KINDS.map((k) => option(kindText(k), k)));
            kind.value = p.kind;
            kind.addEventListener("change", () => edit(i, { kind: PART_KINDS.includes(kind.value) ? kind.value : "part" }));
            head.append(kind, el("span", "muted", `${clockText(p.startMs)}–${clockText(p.endMs)}${p.edited ? " •" : ""}`));
            const emptyRow = el("label", "check");
            const empty = el("input");
            empty.type = "checkbox";
            empty.dataset.role = "empty";
            empty.checked = Boolean(p.empty);
            empty.addEventListener("change", () => edit(i, { empty: Boolean(empty.checked) || undefined }));
            emptyRow.append(empty, el("i", "", t("create.parts.empty")));
            const buttons = el("div", "row");
            const split = el("button", "small", t("create.parts.split"));
            split.disabled = parts.length >= MAX_PARTS;
            split.addEventListener("click", () => replace(splitPart(parts, i, getCursor())));
            const merge = el("button", "small", t("create.parts.merge"));
            merge.disabled = i + 1 >= parts.length;
            merge.addEventListener("click", () => replace(mergeParts(parts, i)));
            buttons.append(split, merge, reset);
            if (canLock) {
                const lock = el("button", locks.has(i) ? "small cr-locked" : "small", locks.has(i) ? t("create.part.locked") : t("create.part.lock"));
                lock.addEventListener("click", () => onToggleLock?.(i));
                buttons.append(lock);
                if (parts.length > 1) {
                    const only = el("button", "small ml-only", t("create.ml.onlyThisPart"));
                    only.addEventListener("click", () => onOnlyThis?.(i));
                    buttons.append(only);
                }
            }
            kids.push(head, patternEditor(i), danEditor(i), emptyRow, buttons);
        }
        editor.replaceChildren(...kids);
    }

    return {
        // { durationMs, energy: 0–1 values across the song }
        setSong(song) {
            durationMs = song.durationMs;
            energy = song.energy;
            parts = [];
            selected = null;
            reports = null;
            locks = new Set();
            canLock = false;
            structure = null;
            renderEditor();
            draw();
        },
        // new parts (found again, or the ones a variant was made with); every edit mark is cleared
        setParts(next) {
            parts = next.map((p) => ({ ...p }));
            selected = null;
            renderEditor();
            draw();
        },
        // the chosen variant: its PartReport[] for the badges, its locked part indexes, whether locking applies, and
        // its song structure ({ phrases, repeats } or null)
        setResult({ reports: nextReports = null, locks: nextLocks = new Set(), canLock: lockable = false, structure: nextStructure = null } = {}) {
            reports = nextReports;
            locks = new Set(nextLocks);
            canLock = lockable;
            structure = nextStructure && typeof nextStructure === "object" ? nextStructure : null;
            renderEditor();
            draw();
        },
        select(index) {
            selected = index === null ? null : Math.max(0, Math.min(parts.length - 1, index));
            renderEditor();
            draw();
        },
        frame: draw,
        redraw: () => draw(),
        // the part editor again (the General / Detailed mode changed)
        refresh: () => renderEditor(),
        get parts() { return parts.map((p) => ({ ...p })); },
        get edited() { return parts.some((p) => p.edited); },
        get selected() { return selected; },
        get width() { return width; },
    };
}
