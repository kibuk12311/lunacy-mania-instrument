// The General / Detailed switch for patterns, one for every tab: General shows the six pattern families, Detailed
// their kinds (flavours, src/gen/flavours.js). The value lives in the window's localStorage, beside the renderer's
// other remembered choices (the analysis calculator, the playfield speed): one window holds every tab, so one value
// serves them all, and every tab hears a change through onPatternMode().
// Also the names patterns are shown by in each mode: a finder name (a LeoBlack cluster) as its family, or as the
// catalogue's flavour name when it has one.
import { t } from "../../src/i18n/i18n.js";
import { NAME_FAMILY } from "../../src/gen/search.js";
import { FINDER_NAME, flavourName } from "../../src/gen/flavours.js";

export const PATTERN_MODES = ["general", "detailed"];
const KEY = "pattern-mode";
const FLAVOUR_OF_NAME = Object.fromEntries(Object.entries(FINDER_NAME).map(([id, name]) => [name, id]));
// the families as the analysis card and strip have always named them (English in both languages)
export const FAMILY_LABELS = { Stream: "Stream", Jumpstream: "Jumpstream", Handstream: "Handstream", Chordjack: "Chordjacks", Jack: "Jacks", Tech: "Tech" };

let mode = null;
const listeners = new Set();

function read() {
    try {
        const saved = globalThis.localStorage?.getItem(KEY);
        return PATTERN_MODES.includes(saved) ? saved : "general";
    } catch {
        return "general"; // storage unavailable: start general
    }
}

export function getPatternMode() {
    mode ??= read();
    return mode;
}

export const isDetailed = () => getPatternMode() === "detailed";

// Sets the mode for every tab (remembered); the listeners hear it once per change.
export function setPatternMode(next) {
    if (!PATTERN_MODES.includes(next) || next === getPatternMode()) return;
    mode = next;
    try {
        globalThis.localStorage?.setItem(KEY, next);
    } catch {
        // not remembered, still applied
    }
    for (const fn of [...listeners]) fn(mode);
}

// fn(mode) after every change; → a function that stops it
export function onPatternMode(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// For tests: forget the value read and the listeners.
export function resetPatternMode() {
    mode = null;
    listeners.clear();
}

// The switch as two chips (the create tab's): it follows the mode wherever the mode is changed.
export function createPatternModeSwitch(doc = globalThis.document) {
    const box = doc.createElement("span");
    box.className = "chips pm-switch";
    box.title = t("gen.patternMode.hint");
    const chips = PATTERN_MODES.map((m) => {
        const chip = doc.createElement("span");
        chip.dataset.patternMode = m;
        chip.textContent = t(`gen.patternMode.${m}`);
        chip.addEventListener("click", () => setPatternMode(m));
        return chip;
    });
    box.append(...chips);
    const sync = () => {
        for (const chip of chips) chip.className = chip.dataset.patternMode === getPatternMode() ? "sel" : "";
    };
    onPatternMode(sync);
    sync();
    return box;
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// The same switch as HTML for the pages drawn from strings (the analysis card); clicks on [data-pattern-mode] go to
// setPatternMode in that page's own click handler.
export function patternModeHtml() {
    const chips = PATTERN_MODES.map((m) => `<span data-pattern-mode="${m}"${m === getPatternMode() ? ' class="sel"' : ""}>${escape(t(`gen.patternMode.${m}`))}</span>`).join("");
    return `<span class="chips pm-switch" title="${escape(t("gen.patternMode.hint"))}">${chips}</span>`;
}

// A finder name in the current mode: General → its family ("Rolls" → "Stream"), Detailed → the catalogue's name of
// that flavour ("Rolls" → its own name); a name neither knows stays as it is.
export function patternLabel(name, detailed = isDetailed()) {
    if (!name) return name;
    if (detailed) return FLAVOUR_OF_NAME[name] ? flavourName(FLAVOUR_OF_NAME[name]) : name;
    return FAMILY_LABELS[NAME_FAMILY[name]] ?? name;
}

// top3 [{ name, share }] → General: shares summed by family, largest first; Detailed: the finder names as flavours.
export function patternsInMode(top3, detailed = isDetailed()) {
    const sums = new Map();
    for (const p of top3 ?? []) {
        const label = patternLabel(p.name, detailed);
        sums.set(label, (sums.get(label) ?? 0) + (Number(p.share) || 0));
    }
    return [...sums].map(([name, share]) => ({ name, share })).sort((a, b) => b.share - a.share);
}
