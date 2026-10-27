// The marathon tab's "Auto-marathon" panel: a course template, the final dan (the shared profile or a manual
// one: the overall dan or each pattern's own), any patterns taking turns, and the pick that fills the list (main does the search, downloads and rates).
// The chosen template also sets the pause, OD/HP and the title, and puts its plan on the curve.
import { t } from "../../src/i18n/i18n.js";
import { TEMPLATES, CUSTOM, MAX_MARATHON_PATTERNS, templateById, stepTargets, profileTargets, templateTitle } from "../../src/rate/marathonTemplates.js";
import { TILE_NAMES, patternById, recPatternsFor, patternIdsInMode } from "../../src/recommend/catalog.js";
import { isDetailed, onPatternMode, createPatternModeSwitch } from "./patternMode.js";
import { playerDanFor } from "../../src/recommend/skill.js";
import { numericToLabel } from "../../src/core/labels.js";
import { fillDanSelects, readDanSelects } from "./danSelect.js";
import { getProfile, onProfile, ensureProfile } from "./profile.js";
import { interludeLinked, onInterludeState } from "./interlude.js";
import { mapsText } from "./marathonCurveView.js";
import { togglePattern } from "./recPlan.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "marathon.auto.v1";
const DEFAULTS = {
    templateId: "dan", count: CUSTOM.count, step: CUSTOM.step, source: "profile", level: "pattern", manualDan: 13,
    patternIds: null, skipPlayed: false, rankedOnly: false, mode: "replace",
};

let settings = { ...DEFAULTS };
let list = { setEntries: () => {}, setPlan: () => {} };
let listSize = 0;
let running = false;
let active = false; // a template chosen (or a pick made) this session: its plan is on the curve
let titleSet = null; // the title the template last wrote; a title the player typed is left alone

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function normalize(s) {
    const tpl = templateById(s?.templateId) ?? templateById(DEFAULTS.templateId);
    const ids = Array.isArray(s?.patternIds) ? [...new Set(s.patternIds.filter((id) => patternById(id)))].slice(0, MAX_MARATHON_PATTERNS) : [];
    return {
        templateId: tpl.id,
        count: Math.round(clamp(finite(s?.count) ?? CUSTOM.count, CUSTOM.minCount, CUSTOM.maxCount)),
        step: Math.round(clamp(finite(s?.step) ?? CUSTOM.step, CUSTOM.minStep, CUSTOM.maxStep) * 100) / 100,
        source: s?.source === "manual" ? "manual" : "profile",
        // settings saved before the choice had each pattern's own dan (one pattern) — "pattern" reads them the same
        level: s?.level === "overall" ? "overall" : "pattern",
        manualDan: finite(s?.manualDan) ?? DEFAULTS.manualDan,
        patternIds: ids.length ? ids : [...tpl.defaultPatterns],
        skipPlayed: Boolean(s?.skipPlayed),
        rankedOnly: Boolean(s?.rankedOnly),
        mode: s?.mode === "append" ? "append" : "replace",
    };
}

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
        settings = normalize(saved && typeof saved === "object" ? { ...DEFAULTS, ...saved } : DEFAULTS);
    } catch {
        settings = normalize(DEFAULTS);
    }
}

function save() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {
        // not remembered, still used
    }
}

const template = () => templateById(settings.templateId);

// The course: { finalDan, targets } from the manual dan, or from the profile (its overall dan or each pattern's own,
// as main makes it); null when unknown.
function course() {
    if (settings.source === "manual") return { finalDan: settings.manualDan, targets: stepTargets(template(), settings.manualDan, settings) };
    const p = getProfile();
    if (p.state !== "ready") return null;
    return profileTargets(template(), p.skill, chosenIds(), settings.level, settings);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// The profile's name; a hand-set one (the picks tab's manual source) says so.
const profileName = (p) => (p.manual ? `${p.player?.username ?? ""} (${t("recommend.manual.tag")})` : p.local ? t("profile.local.name") : p.player?.username ?? "");

function renderProfile() {
    const p = getProfile();
    const box = $("mar-profile");
    let text;
    if (p.state === "ready") {
        const name = profileName(p);
        if (settings.level === "overall") {
            const overall = p.skill?.overall;
            text = Number.isFinite(overall) ? t("marathon.auto.profileOverall", { name, dan: numericToLabel(overall).text }) : t("marathon.auto.profileNoOverall", { name });
        } else {
            // one dan per tile the chosen patterns are on: "Stamina: Delta mid, Jack: Gamma high"
            const tiles = [...new Set(chosenIds().map((id) => patternById(id)?.tile).filter(Boolean))];
            const dans = tiles.map((tile) => [tile, playerDanFor(p.skill, chosenIds().find((id) => patternById(id)?.tile === tile))]);
            const missing = dans.find(([, own]) => !own);
            text = missing
                ? t("marathon.auto.profileNoTile", { name, tile: TILE_NAMES[missing[0]] ?? "" })
                : t("marathon.auto.profile", { name, dans: dans.map(([tile, own]) => `${TILE_NAMES[tile] ?? tile}: ${numericToLabel(own.dan).text}`).join(", ") });
        }
    } else if (p.state === "loading") {
        text = t("marathon.auto.profileLoading");
    } else if (p.state === "failed") {
        text = t("app.shared.profileFailed", { message: p.message ?? "" });
    } else if (p.local) {
        text = t("profile.local.notEnough");
    } else {
        text = t("marathon.err.noProfile");
    }
    box.textContent = text;
    // a profile loaded from mania-tracker knows what was played; a hand-set one only with a linked Interlude folder
    // (its scores, main's recommender.playedMaps)
    const skip = $("mar-skip-played");
    skip.disabled = p.state !== "ready" || (Boolean(p.manual) && !interludeLinked());
    skip.checked = !skip.disabled && settings.skipPlayed;
}

// The patterns in the General / Detailed mode (patternMode.js): in General a remembered kind (quadstream …) shows as
// its parent, and a click there saves the list as General sees it.
const chosenIds = () => patternIdsInMode(settings.patternIds, isDetailed());

function renderPatterns() {
    const chosen = chosenIds();
    $("mar-patterns").replaceChildren(...recPatternsFor(isDetailed()).map((pattern) => {
        const at = chosen.indexOf(pattern.id);
        // the number shows the order the maps take them in, as on the dans' chips (recPlan.js)
        const chip = el("span", at >= 0 ? "sel" : "", at >= 0 && chosen.length > 1 ? `${at + 1}. ${pattern.name}` : pattern.name);
        chip.addEventListener("click", () => {
            const before = chosenIds();
            const ids = togglePattern(before, pattern.id, MAX_MARATHON_PATTERNS);
            if (ids === before) return; // the last one stays
            settings.patternIds = ids;
            save();
            renderPatterns();
            renderProfile();
            refreshPlan();
        });
        return chip;
    }));
}

function renderTemplate() {
    const tpl = template();
    $("mar-tpl").value = tpl.id;
    $("mar-tpl-hint").textContent = t(tpl.hintKey);
    $("mar-custom").hidden = tpl.id !== "custom";
    $("mar-count").value = String(settings.count);
    $("mar-step").value = String(settings.step);
}

function renderSource() {
    $("mar-src-profile").checked = settings.source === "profile";
    $("mar-src-manual").checked = settings.source === "manual";
    $("mar-manual").hidden = settings.source !== "manual";
    $("mar-by").hidden = settings.source !== "profile";
    $("mar-by-overall").checked = settings.level === "overall";
    $("mar-by-pattern").checked = settings.level === "pattern";
}

function renderButtons() {
    $("mar-pick").disabled = running;
    $("mar-stop").hidden = !running;
    $("mar-mode").hidden = listSize === 0;
    $("mar-mode-replace").checked = settings.mode === "replace";
    $("mar-mode-append").checked = settings.mode === "append";
}

// The template's plan on the curve, and its title: always when the template was just picked (force),
// else only while the title is still the template's own or the default one.
function refreshPlan(force = false) {
    const plan = course();
    list.setPlan(active && plan ? plan.targets : null);
    if (!active || !plan) return;
    const dan = plan.finalDan;
    const title = $("mar-title");
    const untouched = title.value === titleSet || !title.value.trim() || title.value === t("html.mar.defaultTitle");
    if (force || untouched) {
        titleSet = templateTitle(template(), dan);
        title.value = titleSet;
    }
}

// A template picked by hand: its pause, OD/HP and patterns, then the plan and the title.
function applyTemplate() {
    const tpl = template();
    $("mar-gap").value = String(tpl.gapSec);
    $("mar-od").value = String(tpl.od);
    $("mar-hp").value = String(tpl.hp);
    settings.patternIds = [...tpl.defaultPatterns];
    active = true;
    save();
    renderPatterns();
    renderProfile();
    // the plan redraws the curve, with the new pause too
    refreshPlan(true);
}

function status(text) {
    $("mar-auto-status").textContent = text;
}

const PROGRESS = {
    search: (e) => t("marathon.auto.progress.search", { i: e.i, n: e.n, pattern: patternById(e.patternId)?.name ?? "", dan: numericToLabel(e.target).text }),
    songs: (e) => t("marathon.auto.progress.songs", { i: e.i, n: e.n, name: e.name ?? "" }),
    download: (e) => (e.total > 0
        ? t("marathon.auto.progress.download", { i: e.i, n: e.n, name: e.name ?? "", pct: Math.min(100, Math.round((e.received / e.total) * 100)) })
        : t("marathon.auto.progress.downloadStart", { i: e.i, n: e.n, name: e.name ?? "" })),
    analyze: (e) => t("marathon.auto.progress.analyze", { i: e.i, n: e.n, name: e.name ?? "" }),
    skip: (e) => t("marathon.auto.progress.skip", { i: e.i, n: e.n, name: e.name ?? "" }),
};

// What a progress event from main reads like; "" for none.
export function progressText(event) {
    return PROGRESS[event?.phase]?.(event) ?? "";
}

// One line per warning of a pick.
export function warningText(w) {
    if (w.kind === "short") return t("marathon.auto.warn.short", { i: w.i, rate: w.rate, label: w.label });
    if (w.kind === "over") return t("marathon.auto.warn.over", { i: w.i, rate: w.rate, label: w.label });
    return t("marathon.auto.warn.miss", { i: w.i, reason: w.reason ?? "" });
}

async function pick() {
    if (running) return;
    const api = window.danApi;
    if (typeof api?.marathonAuto !== "function") return;
    running = true;
    active = true;
    renderButtons();
    refreshPlan();
    $("mar-auto-result").replaceChildren();
    status(t("marathon.auto.starting"));
    let r;
    // "by profile" with the hand-set profile: main has no copy of it, so it goes with the request
    const p = getProfile();
    // the local profile is main's own: only which one goes with the request
    const handSet = settings.source !== "profile" ? {} : p.manual ? { manualProfile: p.profile } : p.local ? { localProfile: true } : {};
    try {
        r = await api.marathonAuto({
            templateId: settings.templateId, count: settings.count, step: settings.step,
            source: settings.source, level: settings.level, manualDan: settings.source === "manual" ? settings.manualDan : null, ...handSet,
            patternIds: chosenIds(), skipPlayed: settings.skipPlayed && !$("mar-skip-played").disabled, rankedOnly: settings.rankedOnly,
        });
    } catch (error) {
        r = { ok: false, message: error?.message ?? String(error) };
    }
    running = false;
    if (!r?.ok) {
        status(t("marathon.auto.failed", { message: r?.message ?? "" }));
        renderButtons();
        return;
    }
    const picked = r.entries ?? [];
    if (picked.length) list.setEntries(picked, listSize > 0 && settings.mode === "append" ? "append" : "replace");
    status(r.cancelled ? t("marathon.auto.stopped", { maps: mapsText(picked.length) }) : t("marathon.auto.done", { maps: mapsText(picked.length) }));
    $("mar-auto-result").replaceChildren(...(r.warnings ?? []).map((w) => el("div", "mar-warn", warningText(w))));
    renderButtons();
    refreshPlan();
}

function stop() {
    if (!running) return;
    status(t("marathon.auto.stopping"));
    Promise.resolve(window.danApi?.marathonAutoCancel?.()).catch(() => {});
}

// list: { setEntries, onListChange, setPlan } from marathonTab.js.
export function initMarathonAuto(api) {
    list = api;
    load();
    $("mar-tpl").replaceChildren(...TEMPLATES.map((tpl) => {
        const option = el("option", "", t(tpl.nameKey));
        option.value = tpl.id;
        option.selected = tpl.id === settings.templateId;
        return option;
    }));
    renderTemplate();
    renderSource();
    $("mar-pattern-mode").replaceChildren(createPatternModeSwitch());
    renderPatterns();
    onPatternMode(renderPatterns);
    fillDanSelects($("mar-level"), $("mar-dan-step"), settings.manualDan);
    $("mar-ranked").checked = settings.rankedOnly;
    $("mar-skip-played").checked = settings.skipPlayed;
    renderProfile();
    renderButtons();

    $("mar-tpl").addEventListener("change", () => {
        if (templateById($("mar-tpl").value)) settings.templateId = $("mar-tpl").value;
        renderTemplate();
        applyTemplate();
    });
    $("mar-count").addEventListener("change", () => {
        settings.count = Math.round(clamp(Number($("mar-count").value) || CUSTOM.count, CUSTOM.minCount, CUSTOM.maxCount));
        save();
        renderTemplate();
        refreshPlan();
    });
    $("mar-step").addEventListener("change", () => {
        settings.step = Math.round(clamp(Number($("mar-step").value) || CUSTOM.step, CUSTOM.minStep, CUSTOM.maxStep) * 100) / 100;
        save();
        renderTemplate();
        refreshPlan();
    });
    for (const [id, source] of [["mar-src-profile", "profile"], ["mar-src-manual", "manual"]]) {
        $(id).addEventListener("change", () => {
            settings.source = source;
            save();
            renderSource();
            refreshPlan();
            if (source === "profile") ensureProfile();
        });
    }
    for (const [id, level] of [["mar-by-overall", "overall"], ["mar-by-pattern", "pattern"]]) {
        $(id).addEventListener("change", () => {
            settings.level = level;
            save();
            renderProfile();
            refreshPlan();
        });
    }
    for (const id of ["mar-level", "mar-dan-step"]) {
        $(id).addEventListener("change", () => {
            settings.manualDan = readDanSelects($("mar-level"), $("mar-dan-step")) ?? settings.manualDan;
            save();
            refreshPlan();
        });
    }
    $("mar-skip-played").addEventListener("change", () => { settings.skipPlayed = $("mar-skip-played").checked; save(); });
    $("mar-ranked").addEventListener("change", () => { settings.rankedOnly = $("mar-ranked").checked; save(); });
    for (const [id, mode] of [["mar-mode-replace", "replace"], ["mar-mode-append", "append"]]) {
        $(id).addEventListener("change", () => { settings.mode = mode; save(); });
    }
    $("mar-pick").addEventListener("click", pick);
    $("mar-stop").addEventListener("click", stop);

    api.onListChange((count) => {
        listSize = count;
        renderButtons();
    });
    onProfile(() => {
        renderProfile();
        refreshPlan();
    });
    // a linked Interlude knows played maps for a hand-set profile too
    onInterludeState(() => renderProfile());
    try {
        window.danApi?.onMarathonAutoProgress?.((event) => {
            const text = running ? progressText(event) : "";
            if (text) status(text);
        });
    } catch {
        // no progress lines, the pick still answers
    }
    // the profile is asked for when the tab is first opened, not at start
    window.addEventListener?.("tab-shown", (e) => { if (e.detail === "marathon") ensureProfile(); });
}
