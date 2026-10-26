// The generator options of the create tab (wave 3, docs/2026-10-25-mapgen-v3-ml-addendum.md §6, §11), built into
// #gen-options: the model picker, the number of candidates the critic chooses from (1–20, default 1: no critic), the
// mapper style (from generator-info) and «Повторы — похожими паттернами».
// - Release 0.9.0: «Классическая» (the proven v1, mapper.json) is the default and is what "auto" runs; XGBoost v3 and
//   the nn-v2 sizes S / M / L are experimental choices, each with a line on why (the held-out evaluation said no-ship:
//   closer to the dan, but less like a human mapper's notes or patterns), where it runs and the time per variant
//   measured here, or why it cannot be picked.
// - L needs a graphics card (WebGPU in this window, or generator-info's `gpu` once the worker reports one) and its
//   model file (still training: it comes in a later update); every experimental choice needs its file. A choice that
//   cannot be picked is greyed out with the reason, and a remembered choice that became impossible is sent as "auto".
// - The mapper style (0.9.5): the list is the one of the model picked above, from generator-info's stylesBySize (an
//   older main: the styles of the model that last ran), most maps first, «Name · N карт», with a search box over it
//   (Enter takes the first match, the down arrow goes to the list, Esc clears it). Picking another model keeps the
//   style when that model has it, else sets «Без стиля» with a note. The classic model has none: the list is off and
//   says so. A line under it says what a style does with the picked engine (measured: little on XGBoost v3, gently on
//   the nn-v2).
// - Repeats need the song's stems (the worker builds the structure from them): without them the box is off, with a hint.
// - Everything picked is remembered in localStorage; so are the measured times per choice and per candidate.
// request() → { modelSize, candidates, style, repeats } for generate-map; variants(n) → how many cards a run of one
// range makes: CARDS_WITH_CRITIC when the critic picks each card from several candidates, else n.
import { t, plural } from "../../src/i18n/i18n.js";
import { displayStyles } from "../../src/gen/styleNames.js";

export const MODEL_SIZES = ["auto", "xgb3", "s", "m", "l"];
export const EXPERIMENTAL = Object.freeze(["xgb3", "s", "m", "l"]);
export const CARDS_WITH_CRITIC = 2;
export const DEFAULT_CANDIDATES = 1;
export const MAX_CANDIDATES = 20;
export const STORE_KEY = "create.genOptions";
export const TIMES_KEY = "create.genTimes";
const GPU_PROBE_MS = 1500;
const SIZE_KEYS = {
    auto: "create.ml.size.auto", xgb3: "create.ml.size.xgb3", s: "create.ml.size.s", m: "create.ml.size.m", l: "create.ml.size.l",
};
const HINT_KEYS = {
    auto: "create.ml.sizeHint.auto", xgb3: "create.ml.sizeHint.xgb3", s: "create.ml.sizeHint.s", m: "create.ml.sizeHint.m", l: "create.ml.sizeHint.l",
};
export const DEFAULTS = Object.freeze({ modelSize: "auto", candidates: DEFAULT_CANDIDATES, style: null, repeats: true });

export const sizeName = (size) => t(SIZE_KEYS[size] ?? SIZE_KEYS.auto);

const OPTION_KEYS = { ru: ["create.ml.styleOption.one", "create.ml.styleOption.few", "create.ml.styleOption.many"], en: ["create.ml.styleOption.one", "create.ml.styleOption.many"] };
// A style's name as shown: its name, «маппер #<id>» for an osu! user without one, else the key.
export const styleName = (s) => (s?.name ? s.name : s?.user ? t("create.ml.styleUser", { id: s.user }) : String(s?.key ?? ""));
// «Magikarp1234 · 288 карт»
export const styleOptionText = (s) => {
    const maps = Math.max(0, Math.round(Number(s?.maps) || 0));
    return t(plural(maps, OPTION_KEYS), { name: styleName(s), maps });
};

// The styles shown for a model choice: generator-info's stylesBySize[size] (0.9.5), or, from an older main without it,
// the styles of the model that last ran; named and sorted as src/gen/styleNames.js says.
export function stylesOf(info, size) {
    const by = info?.stylesBySize;
    const list = by && typeof by === "object" ? by[size] : info?.styles;
    return displayStyles(Array.isArray(list) ? list : []);
}

// Whether a style matches the search text (its shown name or its key, any case).
export function styleMatches(s, query) {
    const q = String(query ?? "").trim().toLowerCase();
    return !q || styleName(s).toLowerCase().includes(q) || String(s?.key ?? "").toLowerCase().includes(q);
}

const clampCandidates = (n) => Math.max(1, Math.min(MAX_CANDIDATES, Math.round(Number(n)) || DEFAULT_CANDIDATES));

function read(storage, key) {
    try {
        return JSON.parse(storage()?.getItem(key) ?? "null");
    } catch {
        return null;
    }
}

function write(storage, key, value) {
    try {
        storage()?.setItem(key, JSON.stringify(value));
    } catch {
        // a private window or blocked storage: the choice lasts this session only
    }
}

// The remembered options, each checked; anything odd falls back to DEFAULTS.
export function loadOptions(storage = () => globalThis.localStorage) {
    const saved = read(storage, STORE_KEY) ?? {};
    return {
        modelSize: MODEL_SIZES.includes(saved.modelSize) ? saved.modelSize : DEFAULTS.modelSize,
        candidates: Number.isFinite(saved.candidates) ? clampCandidates(saved.candidates) : DEFAULTS.candidates,
        style: typeof saved.style === "string" && saved.style ? saved.style : null,
        repeats: typeof saved.repeats === "boolean" ? saved.repeats : DEFAULTS.repeats,
    };
}

// What "auto" runs here: "auto" (the classic model), or null when generator-info says mapper.json is not there (the
// rules then). `info` null: not known yet, taken as there.
export function autoPick(info) {
    return info?.sizes?.auto === false ? null : "auto";
}

// Each choice: whether it can be picked and why not ("noFile" | "noGpu"), and whether it runs on the graphics card.
// Unknown files (no generator-info yet, or an older main without the key) count as there. "auto" is always open.
export function sizeChoices(info, { gpu = false } = {}) {
    const has = (size) => info?.sizes?.[size] !== false;
    return MODEL_SIZES.map((size) => {
        if (size === "auto") return { size, ok: true, why: null, onGpu: false };
        if (!has(size)) return { size, ok: false, why: "noFile", onGpu: false };
        if (size === "l" && !gpu) return { size, ok: false, why: "noGpu", onGpu: false };
        return { size, ok: true, why: null, onGpu: (size === "m" || size === "l") && gpu };
    });
}

const secText = (ms) => {
    const sec = ms / 1000;
    return sec < 10 ? String(Math.max(0.1, Math.round(sec * 10) / 10)) : String(Math.round(sec));
};

// The line under a choice: its hint, where it runs and the measured time per variant (or why it cannot be picked).
export function sizeLine(choice, { info = null, times = {} } = {}) {
    const parts = [t(HINT_KEYS[choice.size] ?? HINT_KEYS.auto)];
    if (!choice.ok) {
        // L's file is still training: it comes in a later update
        const why = choice.why === "noGpu" ? "create.ml.noGpu" : choice.size === "l" ? "create.ml.notYet" : "create.ml.noFile";
        parts.push(t(why));
        return parts.join(" · ");
    }
    if (choice.size === "auto" && autoPick(info) === null) parts.push(t("create.ml.autoNow", { name: t("create.model.rules") }));
    else parts.push(t(choice.onGpu ? "create.ml.onGpu" : "create.ml.onCpu"));
    const ms = Number(times[choice.size]);
    if (Number.isFinite(ms) && ms > 0) parts.push(t("create.ml.measured", { sec: secText(ms) }));
    return parts.join(" · ");
}

// Whether a WebGPU adapter is there (a short wait at most); false outside a window that has WebGPU.
export async function probeGpu({ timeoutMs = GPU_PROBE_MS } = {}) {
    try {
        const gpu = globalThis.navigator?.gpu;
        if (!gpu?.requestAdapter) return false;
        const adapter = await Promise.race([gpu.requestAdapter(), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
        return Boolean(adapter);
    } catch {
        return false;
    }
}

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// What generator-info says of the graphics card: stream W answers { gpuAvailable, adapter, reason, decoder } (the hidden
// GPU renderer passed its parity probe or not), a plain boolean is taken as is; null: nothing reported.
export function reportedGpu(info) {
    const g = info?.gpu;
    if (typeof g === "boolean") return g;
    if (typeof g?.gpuAvailable === "boolean") return g.gpuAvailable;
    return null;
}

// root = #gen-options (its label stays first). api = window.danApi (generatorInfo); gpu() → Promise<boolean>, asked
// once: at the start, or with probeAtStart false only when askGpu() is first called (the tab is shown), so a window
// that never opens the create tab never asks for an adapter; storage() → localStorage or null.
export function createGenOptions({ root, api = () => globalThis.window?.danApi, gpu = probeGpu, storage = () => globalThis.localStorage, probeAtStart = true }) {
    const chosen = loadOptions(storage);
    const times = { ...(read(storage, TIMES_KEY) ?? {}) }; // size → ms per variant; "candidate" → ms per candidate
    let info = null;
    let probed = false; // what this window's probe said
    let asked = null;
    // the worker's word (generator-info `gpu`, once a GPU path reports it) wins over this window's probe
    const gpuNow = () => reportedGpu(info) ?? probed;
    let stems = null; // null: no song yet; true / false: the song's stems are there or not

    const save = () => write(storage, STORE_KEY, chosen);
    const box = el("div", "ml-options");

    const sizeBox = el("div", "ml-sizes");
    sizeBox.setAttribute?.("role", "radiogroup");
    const sizeField = el("div", "ml-field");
    sizeField.append(el("div", "ml-label", t("create.ml.strength")), sizeBox);

    const count = el("input");
    count.type = "range";
    count.min = "1";
    count.max = String(MAX_CANDIDATES);
    count.value = String(chosen.candidates);
    count.dataset.role = "candidates";
    const countValue = el("b", "ml-count", String(chosen.candidates));
    const countRow = el("label", "slider-row ml-candidates");
    countRow.append(el("span", "", t("create.ml.candidates")), count, countValue);
    const countHint = el("div", "muted ml-hint");

    const style = el("select");
    style.dataset.role = "style";
    style.setAttribute?.("aria-label", t("create.ml.style"));
    const filter = el("input", "ml-style-filter");
    filter.type = "search";
    filter.dataset.role = "style-filter";
    filter.placeholder = t("create.ml.styleFilter");
    filter.setAttribute?.("aria-label", t("create.ml.styleFilterLabel"));
    filter.autocomplete = "off";
    filter.spellcheck = false;
    const styleRow = el("div", "ml-style");
    const stylePick = el("div", "ml-style-pick");
    stylePick.append(filter, style);
    styleRow.append(el("span", "", t("create.ml.style")), stylePick);
    const styleHint = el("div", "muted ml-hint ml-style-hint");
    styleHint.dataset.role = "style-hint";
    let styleNote = ""; // why the style was just set to none (another model was picked)

    const repeats = el("input");
    repeats.type = "checkbox";
    repeats.dataset.role = "repeats";
    repeats.checked = chosen.repeats;
    const repeatsRow = el("label", "check ml-repeats");
    repeatsRow.append(repeats, el("i", "", t("create.ml.repeats")));
    const repeatsHint = el("div", "muted ml-hint");

    const choices = () => sizeChoices(info, { gpu: gpuNow() });
    const effectiveSize = () => (choices().find((c) => c.size === chosen.modelSize)?.ok ? chosen.modelSize : "auto");
    const styles = () => stylesOf(info, effectiveSize());

    function renderSizes() {
        const effective = effectiveSize();
        sizeBox.replaceChildren(...choices().map((choice) => {
            const on = choice.size === effective;
            const option = el("button", `ml-size${on ? " sel" : ""}${choice.ok ? "" : " off"}${EXPERIMENTAL.includes(choice.size) ? " exp" : ""}`);
            option.type = "button";
            option.dataset.size = choice.size;
            option.disabled = !choice.ok;
            option.setAttribute?.("role", "radio");
            option.setAttribute?.("aria-checked", String(on));
            option.append(el("b", "ml-size-name", sizeName(choice.size)), el("span", "ml-size-line", sizeLine(choice, { info, times })));
            option.addEventListener("click", () => {
                if (!choice.ok) return;
                const before = chosen.style ? styles().find((s) => s.key === chosen.style) ?? null : null;
                chosen.modelSize = choice.size;
                // another model: the style stays when it has it, else «Без стиля» and a note why
                styleNote = "";
                if (before && info && !styles().some((s) => s.key === before.key)) {
                    chosen.style = null;
                    styleNote = t("create.ml.styleReset", { model: sizeName(effectiveSize()), style: styleName(before) });
                }
                save();
                renderSizes();
                renderStyle();
            });
            return option;
        }));
    }

    function renderCount() {
        countValue.textContent = String(chosen.candidates);
        const per = Number(times.candidate);
        if (chosen.candidates <= 1) countHint.textContent = t("create.ml.candidatesOne");
        else if (Number.isFinite(per) && per > 0) countHint.textContent = t("create.ml.candidatesHint", { sec: secText(per * chosen.candidates) });
        else countHint.textContent = t("create.ml.candidatesPlain");
    }

    // the list as the search box leaves it: «Без стиля» and the chosen style always, then the matches
    function renderStyle() {
        const list = styles();
        const keep = list.some((s) => s.key === chosen.style) ? chosen.style : "";
        const query = list.length ? filter.value : "";
        const shown = list.filter((s) => s.key === keep || styleMatches(s, query));
        const none = el("option", "", t("create.ml.styleNone"));
        none.value = "";
        style.replaceChildren(none, ...shown.map((s) => {
            const option = el("option", "", styleOptionText(s));
            option.value = s.key;
            option.title = s.key;
            return option;
        }));
        style.value = keep;
        style.disabled = !list.length;
        filter.disabled = !list.length;
        filter.hidden = !list.length;
        const size = effectiveSize();
        const lines = [];
        if (styleNote) lines.push(styleNote);
        if (!list.length) {
            if (info) lines.push(t(size === "auto" ? "create.ml.styleClassic" : "create.ml.styleEmpty"));
        } else {
            lines.push(t(size === "xgb3" ? "create.ml.styleHint.xgb3" : "create.ml.styleHint.nn"));
            const matches = list.filter((s) => styleMatches(s, query)).length;
            if (query.trim()) lines.push(matches ? t("create.ml.styleFound", { n: matches, all: list.length }) : t("create.ml.styleNoMatch"));
        }
        styleHint.textContent = lines.join(" · ");
        styleHint.hidden = !lines.length;
        styleRow.title = list.length ? "" : lines.at(-1) ?? "";
    }

    function pickStyle(key) {
        chosen.style = key || null;
        styleNote = "";
        save();
        renderStyle();
    }

    function renderRepeats() {
        const off = stems === false;
        repeats.disabled = off;
        repeats.checked = off ? false : chosen.repeats;
        repeatsRow.className = off ? "check ml-repeats off" : "check ml-repeats";
        repeatsHint.textContent = off ? t("create.ml.repeatsOff") : "";
        repeatsHint.hidden = !off;
    }

    function render() {
        renderSizes();
        renderCount();
        renderStyle();
        renderRepeats();
    }

    count.addEventListener("input", () => {
        chosen.candidates = clampCandidates(count.value);
        renderCount();
    });
    count.addEventListener("change", () => {
        chosen.candidates = clampCandidates(count.value);
        save();
        renderCount();
    });
    style.addEventListener("change", () => pickStyle(style.value));
    filter.addEventListener("input", () => renderStyle());
    // Enter: the first match; the down arrow: into the list; Esc: the search cleared
    filter.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault?.();
            const first = styles().find((s) => styleMatches(s, filter.value));
            if (first && filter.value.trim()) pickStyle(first.key);
        } else if (event.key === "ArrowDown") {
            event.preventDefault?.();
            style.focus?.();
        } else if (event.key === "Escape" && filter.value) {
            event.preventDefault?.();
            filter.value = "";
            renderStyle();
        }
    });
    repeats.addEventListener("change", () => {
        if (repeats.disabled) return;
        chosen.repeats = Boolean(repeats.checked);
        save();
    });

    const styleField = el("div", "ml-field ml-style-field");
    styleField.append(styleRow, styleHint);
    box.append(sizeField, countRow, countHint, styleField, repeatsRow, repeatsHint);
    root.append(box);
    root.hidden = false;
    render();

    async function refresh() {
        try {
            // the main side starts its GPU renderer for generator-info only once this window asked for an adapter too
            const answer = await api()?.generatorInfo?.({ gpu: probeAtStart || asked !== null });
            if (answer?.ok && answer.modelInfo) info = answer.modelInfo;
        } catch {
            // an older main: nothing known about the files; every size stays open
        }
        render();
        return info;
    }

    const askGpu = () => (asked ??= (async () => {
        try {
            probed = Boolean(await gpu());
        } catch {
            probed = false;
        }
        if (!probeAtStart) await refresh(); // now the worker's word on the graphics card, too
        else renderSizes();
        return probed;
    })());

    const ready = Promise.all([refresh(), probeAtStart ? askGpu() : null]).then(() => undefined);

    return {
        ready,
        refresh,
        askGpu,
        // what generate-map gets from here
        request() {
            const keys = styles().map((s) => s.key);
            return {
                modelSize: effectiveSize(),
                candidates: chosen.candidates,
                style: keys.includes(chosen.style) ? chosen.style : null,
                repeats: stems === false ? false : chosen.repeats,
            };
        },
        // the cards a run of one range makes
        variants: (n) => (chosen.candidates > 1 ? CARDS_WITH_CRITIC : n),
        // a song was loaded: with stems or without
        setStems(has) {
            stems = Boolean(has);
            renderRepeats();
        },
        // a variant came back: its time per variant for the choice that ran (the one asked for, or the fallback the
        // worker's sizeNote names) and per candidate
        noteAnswer(answer, asked = chosen.modelSize) {
            const ms = Number(answer?.ms);
            if (Number.isFinite(ms) && ms > 0) {
                const note = answer?.modelInfo?.sizeNote;
                const ran = note && typeof note === "object" ? note.got : asked;
                if (MODEL_SIZES.includes(ran)) times[ran] = ms;
            }
            const c = answer?.critic;
            if (Number.isFinite(c?.ms) && c.ms > 0 && Number.isInteger(c?.of) && c.of > 0) times.candidate = c.ms / c.of;
            write(storage, TIMES_KEY, times);
            renderSizes();
            renderCount();
        },
        get chosen() { return { ...chosen }; },
    };
}
