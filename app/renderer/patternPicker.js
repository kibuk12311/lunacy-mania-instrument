// The pattern chips of the create tab and of its part editor, in the General / Detailed mode (patternMode.js).
// General: the six family chips, as always. Detailed: one compact line per family: the family chip ("this family, any
// kind") and its flavour chips (src/gen/flavours.js), each with a one-line hint; a flavour chip picks its family too.
// A choice is { families: Map(name → share), flavours: Map(name → Set(ids)) }; the flavours stay remembered while
// the mode is General (they are only sent in Detailed, patternsOf).
import { t } from "../../src/i18n/i18n.js";
import { PATTERN_NAMES } from "../../src/gen/patterns.js";
import { flavoursOf, flavourName, flavourHint } from "../../src/gen/flavours.js";

export const NEW_SHARE = 50;

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// The request's patterns of a choice: [{ name, share, flavours? }] in PATTERN_NAMES order of choosing; flavours only
// in Detailed and only for chosen families.
export function patternsOf(choice, detailed) {
    return [...choice.families].map(([name, share]) => {
        const ids = detailed ? flavoursOf(name).filter((id) => choice.flavours.get(name)?.has(id)) : [];
        return ids.length ? { name, share, flavours: ids } : { name, share };
    });
}

// A choice from a list of patterns ({ name, share, flavours? }).
export function choiceOf(patterns = []) {
    return {
        families: new Map(patterns.map((p) => [p.name, p.share])),
        flavours: new Map(patterns.filter((p) => p.flavours?.length).map((p) => [p.name, new Set(p.flavours)])),
    };
}

// Fills `box` with the chips. onFamily(name) / onFlavour(name, id) change the choice (the caller redraws);
// a family chip carries data-pattern, a flavour chip data-flavour.
export function renderPatternChips(box, choice, { detailed, onFamily, onFlavour }) {
    const familyChip = (name) => {
        const chip = el("span", choice.families.has(name) ? "sel" : "", name);
        chip.dataset.pattern = name;
        if (detailed) chip.title = t("gen.flavour.any", { family: name });
        chip.addEventListener("click", () => onFamily(name));
        return chip;
    };
    if (!detailed) {
        box.className = "chips";
        box.replaceChildren(...PATTERN_NAMES.map(familyChip));
        return;
    }
    box.className = "chips pp-detailed";
    box.replaceChildren(...PATTERN_NAMES.map((name) => {
        const line = el("div", "pp-family");
        const chosen = choice.families.has(name);
        const kids = flavoursOf(name).map((id) => {
            const chip = el("span", chosen && choice.flavours.get(name)?.has(id) ? "pp-flavour sel" : "pp-flavour", flavourName(id));
            chip.dataset.flavour = id;
            chip.title = flavourHint(id);
            chip.addEventListener("click", () => onFlavour(name, id));
            return chip;
        });
        line.append(familyChip(name), ...kids);
        return line;
    }));
}

// The usual edits of a choice. Family chip: on / off (`keepOne`: the last family stays). Flavour chip: on / off, and
// switching one on picks its family.
export function toggleFamily(choice, name, { keepOne = false } = {}) {
    if (choice.families.has(name)) {
        if (keepOne && choice.families.size <= 1) return choice;
        choice.families.delete(name);
        choice.flavours.delete(name);
    } else {
        choice.families.set(name, NEW_SHARE);
    }
    return choice;
}

export function toggleFlavour(choice, name, id) {
    const set = choice.flavours.get(name) ?? new Set();
    if (set.has(id) && choice.families.has(name)) set.delete(id);
    else set.add(id);
    if (set.size) choice.flavours.set(name, set);
    else choice.flavours.delete(name);
    if (!choice.families.has(name)) choice.families.set(name, NEW_SHARE);
    return choice;
}
