// Timing panel of the create tab (mapgen v3): the red lines (sections) of the song, their table and buttons
// (+ point here, one BPM, ×2 ÷2 ×1.5 ×⅔, −5 −1 +1 +5 ms, snap to the waveform), #bpm / #offset for the chosen line,
// the note under them, and the snap divisor chips with the even-scroll checkbox.
// The pure helpers take a Timing and give a new one (or null when the change is not allowed); nothing is changed in place.
import { t } from "../../src/i18n/i18n.js";
import { sectionsOf, sectionIndexAt } from "./snapColors.js";

export const BPM_MIN = 40;
export const BPM_MAX = 400;
export const SNAP_ORDER = [4, 3, 6, 8]; // the request's order
const SNAP_CHIPS = [4, 8, 3, 6]; // the order on screen
const TRIPLETS = new Set([3, 6]);
const OCTAVES = [["×2", 2], ["÷2", 0.5], ["×1.5", 1.5], ["×⅔", 2 / 3]];
const NUDGES = [-5, -1, 1, 5];

const clean = (x) => Math.round(x * 1e6) / 1e6;
const okBpm = (bpm) => Number.isFinite(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX;

// Sections → a Timing whose bpm / offsetMs mirror the first red line.
export function withMirrors(sections) {
    const sorted = sections.map((s) => ({ timeMs: s.timeMs, bpm: s.bpm, meter: s.meter ?? 4 })).sort((a, b) => a.timeMs - b.timeMs);
    return { sections: sorted, bpm: sorted[0].bpm, offsetMs: sorted[0].timeMs };
}

const fitsBetween = (sections, index, timeMs) =>
    timeMs >= 0 && (index === 0 || timeMs > sections[index - 1].timeMs) && (index + 1 >= sections.length || timeMs < sections[index + 1].timeMs);

export function scaleBpm(timing, index, factor) {
    const sections = sectionsOf(timing);
    const bpm = clean(sections[index].bpm * factor);
    if (!okBpm(bpm)) return null;
    sections[index] = { ...sections[index], bpm };
    return withMirrors(sections);
}

// Moves one red line by deltaMs; below 0 it stops at 0, onto a neighbour it is refused.
export function nudgeSection(timing, index, deltaMs) {
    const sections = sectionsOf(timing);
    const timeMs = Math.max(0, clean(sections[index].timeMs + deltaMs));
    if (timeMs === sections[index].timeMs || !fitsBetween(sections, index, timeMs)) return null;
    sections[index] = { ...sections[index], timeMs };
    return withMirrors(sections);
}

// A red line at the beat nearest to atMs, with the BPM and meter in force there → { timing, index }.
// On an existing line, or outside the song, the timing stays and index is the line in force there.
export function addSectionAt(timing, atMs, durationMs) {
    const sections = sectionsOf(timing);
    const at = sectionIndexAt(sections, atMs);
    const s = sections[at];
    const beatMs = 60000 / s.bpm;
    const timeMs = clean(s.timeMs + Math.round((atMs - s.timeMs) / beatMs) * beatMs);
    const same = sections.findIndex((x) => Math.abs(x.timeMs - timeMs) < 1);
    if (same >= 0) return { timing: withMirrors(sections), index: same };
    if (timeMs < 0 || timeMs >= durationMs) return { timing: withMirrors(sections), index: at };
    const next = withMirrors([...sections, { timeMs, bpm: s.bpm, meter: s.meter }]);
    return { timing: next, index: next.sections.findIndex((x) => x.timeMs === timeMs) };
}

export function removeSection(timing, index) {
    const sections = sectionsOf(timing);
    if (sections.length < 2) return null;
    sections.splice(index, 1);
    return withMirrors(sections);
}

// The chosen line's BPM and phase for the whole song, starting at its first beat at or after 0.
export function oneBpm(timing, index) {
    const s = sectionsOf(timing)[index];
    const beatMs = 60000 / s.bpm;
    return withMirrors([{ timeMs: clean(((s.timeMs % beatMs) + beatMs) % beatMs), bpm: s.bpm, meter: s.meter }]);
}

// Typed values for one line: { timeMs?, bpm?, meter? }; null when one is out of range or out of order.
export function setSection(timing, index, change) {
    const sections = sectionsOf(timing);
    const next = { ...sections[index], ...change };
    if (!okBpm(next.bpm) || !Number.isInteger(next.meter) || next.meter < 1 || next.meter > 16) return null;
    if (!Number.isFinite(next.timeMs) || !fitsBetween(sections, index, next.timeMs)) return null;
    sections[index] = next;
    return withMirrors(sections);
}

const shown = (x) => String(Math.round(x * 100) / 100);

function el(tag, { className = "", text = "", title = "" } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (title) node.title = title;
    return node;
}

function button(text, onClick, title = "") {
    const b = el("button", { className: "small", text, title });
    b.addEventListener("click", onClick);
    return b;
}

// root = #timing-sections, snapsRoot = #snaps; onChange(timing, why) after every change ("edit" or "set");
// onFitWave() runs «Подогнать по волне»; getCursor() → ms of the cursor, getDurationMs() → the song's length.
export function createTimingPanel({ root, snapsRoot, bpmInput, offsetInput, note, getCursor, getDurationMs, onChange, onFitWave }) {
    let timing = withMirrors([{ timeMs: 0, bpm: 120, meter: 4 }]);
    let selected = 0;
    let typedOk = true;
    let modelGrid = "q4";
    const snaps = new Set([4]);
    let normalizeSv = true;
    let fitting = false;

    function showInputs() {
        const s = timing.sections[selected];
        bpmInput.value = shown(s.bpm);
        offsetInput.value = shown(s.timeMs);
    }

    function apply(next, why = "edit") {
        if (!next) return false;
        timing = next;
        selected = Math.min(selected, timing.sections.length - 1);
        typedOk = true;
        render();
        onChange?.(timing, why);
        return true;
    }

    function table() {
        const box = el("div", { className: "cr-sections" });
        box.dataset.role = "table";
        box.append(el("span", { className: "muted", text: t("create.timing.start") }), el("span", { className: "muted", text: "BPM" }),
            el("span", { className: "muted", text: t("create.timing.meter") }), el("span"));
        timing.sections.forEach((s, i) => {
            const cell = (value, change, step, width) => {
                const input = el("input", { className: i === selected ? "cr-input sel" : "cr-input" });
                input.type = "number";
                input.step = step;
                input.value = value;
                input.style.width = width;
                input.addEventListener("focus", () => { if (selected !== i) { selected = i; showInputs(); } });
                input.addEventListener("change", () => {
                    selected = i;
                    if (!apply(setSection(timing, i, change(Number(input.value))))) render();
                });
                return input;
            };
            const remove = button("✕", () => apply(removeSection(timing, i)), t("create.timing.remove"));
            remove.disabled = timing.sections.length < 2;
            box.append(
                cell(shown(s.timeMs), (v) => ({ timeMs: v }), "1", "76px"),
                cell(shown(s.bpm), (v) => ({ bpm: v }), "0.01", "70px"),
                cell(String(s.meter), (v) => ({ meter: v }), "1", "44px"),
                remove,
            );
        });
        return box;
    }

    function render() {
        const kids = [];
        if (timing.sections.length > 1) kids.push(table());
        const points = el("div", { className: "row" });
        points.append(
            button(t("create.timing.addPoint"), () => {
                const added = addSectionAt(timing, getCursor(), getDurationMs());
                selected = added.index;
                if (added.timing.sections.length === timing.sections.length) render();
                else apply(added.timing);
            }),
            button(t("create.timing.oneBpm"), () => {
                const next = oneBpm(timing, selected);
                selected = 0;
                apply(next);
            }),
        );
        const octaves = el("div", { className: "row" });
        for (const [text, factor] of OCTAVES) octaves.append(button(text, () => apply(scaleBpm(timing, selected, factor))));
        const nudges = el("div", { className: "row" });
        for (const d of NUDGES) nudges.append(button(d > 0 ? `+${d}` : `−${-d}`, () => apply(nudgeSection(timing, selected, d)), t("create.timing.nudgeHint")));
        nudges.append(el("span", { className: "muted", text: t("html.create.ms") }));
        const fit = button(t("create.timing.fitWave"), async () => {
            if (fitting || !onFitWave) return;
            fitting = true;
            fit.disabled = true;
            try {
                await onFitWave(timing);
            } finally {
                fitting = false;
                fit.disabled = false;
            }
        });
        fit.disabled = fitting;
        nudges.append(fit);
        kids.push(points, octaves, nudges);
        root.replaceChildren(...kids);
        root.hidden = false;
        showInputs();
        renderSnaps();
    }

    function renderSnaps() {
        if (!snapsRoot) return;
        const chips = SNAP_CHIPS.map((d) => {
            const beta = TRIPLETS.has(d) && modelGrid !== "snap-v2";
            const chip = el("span", { className: snaps.has(d) ? "sel" : "", text: `1/${d}${beta ? " β" : ""}`, title: beta ? t("create.snap.betaHint") : "" });
            chip.dataset.snap = String(d);
            chip.addEventListener("click", () => {
                if (d === 4) return;
                if (snaps.has(d)) snaps.delete(d);
                else snaps.add(d);
                renderSnaps();
            });
            return chip;
        });
        const check = el("label", { className: "check cr-check" });
        const box = el("input");
        box.type = "checkbox";
        box.checked = normalizeSv;
        box.addEventListener("change", () => { normalizeSv = Boolean(box.checked); });
        check.append(box, el("i", { text: t("create.snap.normalizeSv") }));
        snapsRoot.replaceChildren(el("div", { className: "flabel", text: t("create.snap.title") }), ...chips, check);
        snapsRoot.hidden = false;
    }

    function typed(field) {
        const value = Number(field === "bpm" ? bpmInput.value : offsetInput.value);
        const change = field === "bpm" ? { bpm: value } : { timeMs: value };
        const next = String(field === "bpm" ? bpmInput.value : offsetInput.value).trim() === "" ? null : setSection(timing, selected, change);
        if (next) apply(next);
        else typedOk = false;
    }
    for (const [input, field] of [[bpmInput, "bpm"], [offsetInput, "offset"]]) {
        input.addEventListener("change", () => typed(field));
        input.addEventListener("input", () => {
            const value = Number(input.value);
            typedOk = field === "bpm" ? okBpm(value) : Number.isFinite(value) && value >= 0;
        });
    }

    return {
        get timing() { return timing; },
        get selected() { return selected; },
        // a new timing (detected, or snapped to the waveform); { detected } or { refined } words the note
        set(next, { detected = false, refined = false } = {}) {
            timing = withMirrors(sectionsOf(next));
            selected = 0;
            typedOk = true;
            if (note) {
                if (refined && Number.isFinite(next.refinedErrMs)) note.textContent = t("create.timing.refined", { err: next.refinedErrMs.toFixed(1) });
                else if (detected && timing.sections.length > 1) note.textContent = t("create.timing.variable", { n: timing.sections.length });
                else if (detected) note.textContent = t("create.timing.auto");
            }
            render();
            onChange?.(timing, "set");
        },
        select(index) {
            selected = Math.max(0, Math.min(timing.sections.length - 1, index));
            render();
        },
        nudge(deltaMs) { return apply(nudgeSection(timing, selected, deltaMs)); },
        valid: () => typedOk,
        snaps: () => SNAP_ORDER.filter((d) => snaps.has(d)),
        // «Автоподбор» (0.9.8) sets the grids; 1/4 always stays
        setSnaps(list) {
            snaps.clear();
            snaps.add(4);
            for (const d of list ?? []) if (SNAP_ORDER.includes(d)) snaps.add(d);
            renderSnaps();
        },
        normalizeSv: () => normalizeSv,
        setModelInfo(info) {
            modelGrid = info?.grid ?? "q4";
            renderSnaps();
        },
        render,
    };
}
