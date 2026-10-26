// Difficulty list of the create tab (mapgen v3): one row per difficulty with its from/to dan (level and step) and ✕,
// at most 5 rows; «+ сложность» and «Лесенка: 3 дана подряд» (level − 1, level, level + 1, each from low to high).
// ranges() gives the rows' dan ranges easiest first; with more than one row #generate reads «Создать набор (n …)».
import { t } from "../../src/i18n/i18n.js";
import { LEVELS, STEPS } from "../../src/gen/request.js";
import { danRange } from "../../src/gen/search.js";

export const MAX_DIFFS = 5;
const LEVEL_MIN = LEVELS[0].value;
const LEVEL_MAX = LEVELS.at(-1).value;
// today's single range: Beta low … Delta high
export const DEFAULT_ROW = { from: { level: 12, step: "low" }, to: { level: 14, step: "high" } };

const clampLevel = (level) => Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, level));
const whole = (level) => ({ from: { level, step: "low" }, to: { level, step: "high" } });

// Three neighbouring dans around `level`, each a whole level, moved inside the scale at its ends.
export function ladderRows(level) {
    const middle = Math.max(LEVEL_MIN + 1, Math.min(LEVEL_MAX - 1, level));
    return [middle - 1, middle, middle + 1].map(whole);
}

// Rows → dan ranges, easiest first.
export const rowRanges = (rows) => rows.map((r) => danRange(r.from, r.to)).sort((a, b) => a.lo - b.lo || a.hi - b.hi);

// The row «+ сложность» adds: the last one a level up; null when the list is full.
export function nextRow(rows) {
    if (rows.length >= MAX_DIFFS) return null;
    const last = rows.at(-1) ?? DEFAULT_ROW;
    return { from: { level: clampLevel(last.from.level + 1), step: last.from.step }, to: { level: clampLevel(last.to.level + 1), step: last.to.step } };
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

// root = #diffs; onChange(count) after every change.
export function createDiffList({ root, generateButton, onChange }) {
    let rows = [DEFAULT_ROW];
    let busy = false;

    function label() {
        if (!generateButton || busy) return;
        generateButton.textContent = rows.length > 1 ? t("create.generate.set", { n: rows.length }) : t("html.create.generate");
    }

    function set(next) {
        rows = next.map((r) => ({ from: { ...r.from }, to: { ...r.to } }));
        render();
        onChange?.(rows.length);
    }

    function end(row, index, which) {
        const level = el("select");
        level.dataset.role = `level-${which}`;
        level.replaceChildren(...LEVELS.map((l) => option(l.name, String(l.value))));
        level.value = String(row[which].level);
        const step = el("select");
        step.dataset.role = `step-${which}`;
        step.replaceChildren(...STEPS.map((s) => option(s.id, s.id)));
        step.value = row[which].step;
        const change = () => {
            const value = Number(level.value);
            const next = rows.map((r) => ({ from: { ...r.from }, to: { ...r.to } }));
            next[index][which] = { level: clampLevel(Number.isFinite(value) && value > 0 ? value : row[which].level), step: STEPS.some((s) => s.id === step.value) ? step.value : row[which].step };
            set(next);
        };
        level.addEventListener("change", change);
        step.addEventListener("change", change);
        return [level, step];
    }

    function render() {
        const kids = rows.map((row, i) => {
            const line = el("div", "row cr-diff");
            const remove = el("button", "small", "✕");
            remove.title = t("create.diffs.remove");
            remove.disabled = rows.length < 2;
            remove.addEventListener("click", () => set(rows.filter((_, j) => j !== i)));
            line.append(el("span", "muted", t("create.diffs.from")), ...end(row, i, "from"), el("span", "muted", t("create.diffs.to")), ...end(row, i, "to"), remove);
            return line;
        });
        const buttons = el("div", "row");
        const add = el("button", "small", t("create.diffs.add"));
        add.disabled = rows.length >= MAX_DIFFS;
        add.addEventListener("click", () => {
            const next = nextRow(rows);
            if (next) set([...rows, next]);
        });
        const ladder = el("button", "small", t("create.diffs.ladder"));
        ladder.addEventListener("click", () => set(ladderRows(rows[0].from.level)));
        buttons.append(add, ladder);
        root.replaceChildren(...kids, buttons);
        root.hidden = false;
        label();
    }

    render();
    return {
        ranges: () => rowRanges(rows),
        get count() { return rows.length; },
        get rows() { return rows.map((r) => ({ from: { ...r.from }, to: { ...r.to } })); },
        setRows: set,
        // while generating the button is «Стоп», so the label waits
        setBusy(value) {
            busy = value;
            label();
        },
        relabel: label,
    };
}
