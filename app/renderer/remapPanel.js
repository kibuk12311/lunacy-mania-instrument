// "Из готовой карты" mode of the create tab (mapgen v3, stream C): an existing 4K rice map (an .osu file, or the map
// selected in osu!) made one dan easier or harder, or into a dan of your choice. Main reads the map, the worker
// remaps it, and the new difficulty is written next to the original (remap-load / remap-create). «Можно миниджеки и
// анкоры» (off at start) lets the remap make minijacks and anchors the map did not have (src/gen/remap.js allowJacks).
// initRemapPanel({ root }) → {}
import { fillDanSelects } from "./danSelect.js";
import { danRange } from "../../src/gen/search.js";
import { t } from "../../src/i18n/i18n.js";
import { labelBeside } from "../../src/core/labels.js";
import { sendButtons } from "./interlude.js";

const CHOICES = [
    { choice: "easier", label: "create.remap.easier" },
    { choice: "harder", label: "create.remap.harder" },
    { choice: "custom", label: "create.remap.custom" },
];
const MIN_LEVEL = 1;
const MAX_LEVEL = 20;

// "easier" / "harder": the whole level below or above the map's (13.6 reads as Delta low, so −1 is Gamma);
// "custom": the band of the chosen level and step. null when there is nothing to go by.
export function remapRange(numeric, choice, custom = null) {
    if (choice === "custom") return custom ? danRange(custom, custom) : null;
    if (!Number.isFinite(numeric)) return null;
    const level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(numeric) + (choice === "harder" ? 1 : -1)));
    return { lo: level - 0.5, hi: level + 0.5 };
}

function make(tag, { id, className, text, type } = {}) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (type) node.type = type;
    return node;
}

export function initRemapPanel({ root }) {
    const state = { map: null, choice: "easier", busy: false, allowJacks: false };
    let seed = Math.floor(Date.now() / 1000) % 100000;

    const head = make("div", { className: "flabel", text: t("create.remap.title") });
    const hint = make("div", { className: "muted", text: t("create.remap.hint") });
    const sources = make("div", { className: "row" });
    const pick = make("label", { className: "link" });
    const file = make("input", { id: "remap-file", type: "file" });
    file.accept = ".osu";
    file.hidden = true;
    file.addEventListener("change", (e) => {
        const chosen = e.target?.files?.[0];
        const path = chosen ? window.danApi.pathForFile?.(chosen) : null;
        if (path) load({ file: path });
    });
    pick.append(make("span", { text: t("create.remap.file") }), file);
    const current = make("button", { id: "remap-current", className: "small", text: t("create.remap.fromOsu") });
    current.addEventListener("click", () => load({ current: true }));
    sources.append(pick, current);

    const mapLine = make("div", { id: "remap-map", className: "remap-map" });
    const chips = make("div", { id: "remap-target", className: "chips" });
    for (const c of CHOICES) {
        const chip = make("span", { text: t(c.label) });
        chip.dataset.choice = c.choice;
        chip.addEventListener("click", () => {
            state.choice = c.choice;
            refresh();
        });
        chips.append(chip);
    }
    const customRow = make("div", { id: "remap-custom", className: "row" });
    const levelSel = make("select", { id: "remap-level" });
    const stepSel = make("select", { id: "remap-step" });
    customRow.append(levelSel, stepSel);
    const jacksRow = make("label", { className: "check" });
    const jacks = make("input", { id: "remap-jacks", type: "checkbox" });
    jacks.checked = state.allowJacks;
    jacks.addEventListener("change", () => {
        state.allowJacks = Boolean(jacks.checked);
    });
    jacksRow.append(jacks, make("i", { text: t("create.remap.allowJacks") }));
    const go = make("button", { id: "remap-go", className: "primary", text: t("create.remap.go") });
    go.addEventListener("click", () => remap());
    const statusLine = make("div", { id: "remap-status", className: "muted" });
    const result = make("div", { id: "remap-result", className: "remap-result" });
    const interludeBox = make("div", { id: "remap-interlude" });
    root?.append(head, hint, sources, mapLine, chips, customRow, jacksRow, go, statusLine, result, interludeBox);

    const usable = () => Boolean(state.map?.ok4k && state.map?.rice);
    function status(text) {
        statusLine.textContent = text;
    }

    function refresh() {
        for (const chip of chips.children) chip.className = chip.dataset.choice === state.choice ? "sel" : "";
        customRow.hidden = state.choice !== "custom";
        go.disabled = state.busy || !usable();
    }

    async function load(req) {
        status(t("create.remap.loading"));
        result.textContent = "";
        state.map = null;
        refresh();
        let answer;
        try {
            answer = await window.danApi.remapLoad(req);
        } catch (error) {
            answer = { ok: false, message: error?.message ?? String(error) };
        }
        if (!answer?.ok) {
            mapLine.textContent = "";
            status(t("create.remap.failed", { message: answer?.message ?? "?" }));
            refresh();
            return;
        }
        state.map = answer;
        status("");
        mapLine.className = usable() ? "remap-map" : "remap-map warn";
        mapLine.textContent = usable()
            ? t("create.remap.now", { name: answer.name, label: labelBeside(answer.numeric, answer.label ?? "—"), numeric: Number.isFinite(answer.numeric) ? answer.numeric.toFixed(1) : "—" })
            : `${answer.name} · ${t("create.remap.onlyRice")}`;
        fillDanSelects(levelSel, stepSel, answer.numeric);
        refresh();
    }

    async function remap() {
        if (!usable() || state.busy) return;
        const custom = state.choice === "custom" ? { level: Number(levelSel.value), step: stepSel.value } : null;
        const range = remapRange(state.map.numeric, state.choice, custom);
        if (!range) return;
        seed += 1;
        state.busy = true;
        refresh();
        status(t("create.remap.working"));
        result.textContent = "";
        interludeBox.replaceChildren();
        try {
            const answer = await window.danApi.remapCreate({ path: state.map.path, range, seed, allowJacks: state.allowJacks });
            if (!answer?.ok) {
                status(t("create.remap.failed", { message: answer?.message ?? "?" }));
                return;
            }
            status("");
            const fields = {
                version: answer.version, numeric: Number.isFinite(answer.numeric) ? answer.numeric.toFixed(1) : "—",
                removed: answer.removed ?? 0, added: answer.added ?? 0,
            };
            result.className = answer.reachable ? "remap-result ok" : "remap-result warn";
            result.textContent = answer.reachable ? t("create.remap.done", fields) : t("create.remap.closest", fields);
            // a miss «Можно миниджеки и анкоры» would have reached or come much closer to
            if (!answer.reachable && answer.jacksWouldHelp === true) result.textContent += ` ${t("create.remap.tryJacks")}`;
            // osu! lazer: the difficulty went in as an .osz, not into a Songs folder
            if (answer.client === "lazer") result.textContent += ` ${t(answer.opened ? "create.remap.lazer" : "create.remap.lazerNotOpened", { file: answer.osz ?? "" })}`;
            // Interlude: the new difficulty as an .osz to drop onto it
            interludeBox.replaceChildren(...sendButtons([answer.osz ?? answer.file]));
        } catch (error) {
            status(t("create.remap.failed", { message: error?.message ?? String(error) }));
        } finally {
            state.busy = false;
            refresh();
        }
    }

    refresh();
    return {};
}
