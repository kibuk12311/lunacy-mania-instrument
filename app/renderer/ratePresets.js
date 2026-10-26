// Presets on the rate tab: chips under the quick rates ("×1.3 · OD 8 · Mirror"), a click puts all of it in place,
// ✕ removes one, "Save preset" keeps the current settings. Main keeps them in userData\rate-presets.json.
import { t } from "../../src/i18n/i18n.js";
import { presetLabel, samePreset } from "../../src/rate/presets.js";

const $ = (id) => document.getElementById(id);

let ctx = null;
let presets = [];

const status = (text) => { $("rate-status").textContent = text; };

function chip(p) {
    const node = document.createElement("span");
    node.className = "rate-chip";
    node.title = t("rate.preset.apply");
    const text = document.createElement("span");
    text.textContent = presetLabel(p);
    const remove = document.createElement("button");
    remove.className = "rate-chip-x";
    remove.textContent = "✕";
    remove.title = t("rate.preset.remove");
    remove.addEventListener("click", (e) => {
        e?.stopPropagation?.();
        return store(presets.filter((q) => !samePreset(q, p)));
    });
    node.append(text, remove);
    node.addEventListener("click", () => ctx.applyOptions(p));
    return node;
}

function render() {
    const box = $("rate-presets");
    if (presets.length) {
        box.replaceChildren(...presets.map(chip));
        return;
    }
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = t("rate.preset.empty");
    box.replaceChildren(empty);
}

// Main normalises what it keeps (src/rate/presets.js) and answers the list as saved.
async function store(list, savedText = "") {
    let r;
    try {
        r = await (window.danApi.rateSavePresets?.(list) ?? Promise.resolve({ ok: false, message: "" }));
    } catch (error) {
        r = { ok: false, message: String(error?.message ?? error) };
    }
    if (!r?.ok || !Array.isArray(r.presets)) {
        status(t("rate.preset.failed", { message: r?.message ?? "" }));
        return;
    }
    presets = r.presets;
    render();
    if (savedText) status(savedText);
}

async function load() {
    try {
        const r = await (window.danApi.ratePresets?.() ?? Promise.resolve({ ok: false }));
        if (r?.ok && Array.isArray(r.presets)) {
            presets = r.presets;
            render();
        }
    } catch {
        // no presets this time; saving still works
    }
}

export function initRatePresets(context) {
    ctx = context;
    presets = [];
    render();
    // the newest first; the same settings saved again move to the front
    $("rate-save-preset").addEventListener("click", () => {
        const p = ctx.getOptions();
        return store([p, ...presets.filter((q) => !samePreset(q, p))], t("rate.preset.saved", { label: presetLabel(p) }));
    });
    return load();
}
