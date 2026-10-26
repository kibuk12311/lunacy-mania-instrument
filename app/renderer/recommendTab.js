// "Рекомендации" tab: the player's skill from mania-tracker (or a dan picked by hand) → maps worth playing for a pattern and goal.
// Four modes under the shared profile block: picks, a training plan, favourites (with a collection.db export) and progress.
import { GOALS, LENGTHS, TILE_NAMES, patternById, goalById, lengthById, recPatternsFor, patternInMode } from "../../src/recommend/catalog.js";
import { isDetailed, onPatternMode, createPatternModeSwitch } from "./patternMode.js";
import { numericToLabel } from "../../src/core/labels.js";
import { LEVELS, STEPS, targetNumeric } from "../../src/gen/request.js";
import { CUSTOM_GOAL } from "../../src/recommend/skill.js";
import { t, plural as pluralOf } from "../../src/i18n/i18n.js";
import { getProfile, onProfile, ensureProfile } from "./profile.js";
import { nearestLevelStep, fillDanSelects, readDanSelects } from "./danSelect.js";
import {
    el, call, failText, fix2, cardElement, onDownloadProgress, favourites, onFavourites, loadFavourites, redrawOurs,
} from "./recCard.js";
import { toggleSimilar } from "./recSimilar.js";
import { initPlan, MAX_PLAN_PATTERNS, PLAN_SIZES } from "./recPlan.js";
import { initFavourites, showFavourites, DEFAULT_COLLECTION_NAME } from "./recFavourites.js";
import { initProgress, showProgress, PROGRESS_DAYS, CHART_AXES } from "./recProgress.js";

// the card helpers moved to recCard.js; they are still read from here
export { plural, metaParts, whyText, oursLines, oursDone, rateText, progressText, downloadLine } from "./recCard.js";

const SETTINGS_KEY = "rec-settings";
// what the window shows (mode, plan, progress, collection name), apart from the picks' settings other tabs read
const VIEW_KEY = "rec-view";
// names are getters so they always read the current language
const SOURCES = [
    { id: "tracker", get name() { return t("recommend.source.tracker"); } },
    { id: "manual", get name() { return t("recommend.source.manual"); } },
];
// the three goals around the player's dan, then a range picked on the dan picker (from … to)
export const GOAL_CHIPS = [
    ...GOALS,
    { id: CUSTOM_GOAL, get name() { return t("recommend.goal.custom"); }, get hint() { return t("recommend.goal.customHint"); } },
];
export const MODES = ["picks", "plan", "fav", "progress"];
// each mode's own parts of the tab; the profile block above them is shared
const MODE_PARTS = {
    picks: ["rec-picks-pane", "rec-filters", "rec-picks-run"],
    plan: ["rec-plan-pane", "rec-filters", "rec-plan-run"],
    fav: ["rec-fav-pane"],
    progress: ["rec-progress-pane"],
};
const ALL_PARTS = [...new Set(Object.values(MODE_PARTS).flat())];
const MODE_STATUS = { picks: "rec-status", plan: "rec-plan-status", fav: "rec-fav-status", progress: "rec-progress-status" };

export const DEFAULT_SETTINGS = {
    query: "", source: "tracker", patternId: "jumpstream", goalId: "growth", lengthId: "any",
    rankedOnly: false, hidePlayed: true, level: 13, step: "mid",
    // the custom range's ends, as dans of the picker (Beta mid … Gamma mid)
    rangeFrom: 12, rangeTo: 13,
};

export const DEFAULT_VIEW = {
    mode: "picks", planSize: 5, planPatterns: ["jumpstream"], progressDays: 30, progressAxis: "Overall", favName: DEFAULT_COLLECTION_NAME,
};

// "play" / "plays" word for n in the current language.
const playsWord = (n) => pluralOf(n, {
    ru: [t("recommend.play.one"), t("recommend.play.few"), t("recommend.play.many")],
    en: [t("recommend.play.one"), t("recommend.play.many")],
});

// [main line, tiles line] of the loaded profile.
export function skillLines(username, skill) {
    const parts = [username];
    if (Number.isFinite(skill.overall)) {
        parts.push(t("recommend.skill.overall", { label: skill.overallLabel ?? numericToLabel(skill.overall).text, dan: fix2(skill.overall) }));
    }
    const plays = Number(skill.analyzedPlays) || 0;
    parts.push(`${plays} ${playsWord(plays)}`);
    const tiles = Object.entries(TILE_NAMES)
        .filter(([tile]) => Number.isFinite(skill.tiles?.[tile]))
        .map(([tile, name]) => `${name} ${numericToLabel(skill.tiles[tile]).text}`);
    return [parts.join(" · "), tiles.join(" · ")];
}

// "Gamma mid – Delta low", or one label when both ends are the same
function rangeLabel(from, to) {
    const a = numericToLabel(from).text;
    const b = numericToLabel(to).text;
    return a === b ? a : `${a} – ${b}`;
}

export function targetText(target, patternName) {
    const dan = target.source === "overall" ? t("recommend.target.overall", { dan: fix2(target.playerDan) }) : fix2(target.playerDan);
    if (target.goalId === CUSTOM_GOAL) {
        const params = { pattern: patternName, range: rangeLabel(target.rangeFrom, target.rangeTo), lo: fix2(target.lo), hi: fix2(target.hi) };
        // a range without the player's dan (manual mode) has nothing else to tell
        if (target.source === "range") return t("recommend.target.range", params);
        return t("recommend.target.yoursRange", { ...params, label: target.playerDanLabel, dan });
    }
    const key = target.source === "manual" ? "recommend.target.manual" : "recommend.target.yours";
    let text = t(key, { pattern: patternName, label: target.playerDanLabel, dan, lo: fix2(target.lo), hi: fix2(target.hi) });
    if (Number.isFinite(target.msdTarget)) text += ` · MSD ${target.msdAxis} ~${target.msdTarget.toFixed(1)}`;
    return text;
}

// A dan the level + step picker shows (0.6 … 20.4 in steps of 0.2), else null.
function pickerDan(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const near = nearestLevelStep(value);
    return Math.abs(targetNumeric(near.level, near.step) - value) < 1e-9 ? value : null;
}

function parseJson(raw) {
    let data;
    try {
        data = JSON.parse(raw ?? "null");
    } catch {
        data = null;
    }
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

// Saved settings → a full, valid settings object (anything unknown falls back to the default).
export function parseSettings(raw) {
    const data = parseJson(raw);
    const s = { ...DEFAULT_SETTINGS };
    if (typeof data.query === "string") s.query = data.query.trim().slice(0, 64);
    if (SOURCES.some((x) => x.id === data.source)) s.source = data.source;
    if (patternById(data.patternId)) s.patternId = data.patternId;
    if (goalById(data.goalId) || data.goalId === CUSTOM_GOAL) s.goalId = data.goalId;
    if (lengthById(data.lengthId)) s.lengthId = data.lengthId;
    if (typeof data.rankedOnly === "boolean") s.rankedOnly = data.rankedOnly;
    if (typeof data.hidePlayed === "boolean") s.hidePlayed = data.hidePlayed;
    if (LEVELS.some((l) => l.value === data.level)) s.level = data.level;
    if (STEPS.some((x) => x.id === data.step)) s.step = data.step;
    s.rangeFrom = pickerDan(data.rangeFrom) ?? s.rangeFrom;
    s.rangeTo = pickerDan(data.rangeTo) ?? s.rangeTo;
    return s;
}

// Saved view → a full, valid view (the mode, the plan's size and patterns, the progress period and axis, the collection name).
export function parseView(raw) {
    const data = parseJson(raw);
    const v = { ...DEFAULT_VIEW, planPatterns: [...DEFAULT_VIEW.planPatterns] };
    if (MODES.includes(data.mode)) v.mode = data.mode;
    if (PLAN_SIZES.includes(data.planSize)) v.planSize = data.planSize;
    if (Array.isArray(data.planPatterns)) {
        const ids = [...new Set(data.planPatterns.filter((id) => typeof id === "string" && patternById(id)))].slice(0, MAX_PLAN_PATTERNS);
        if (ids.length) v.planPatterns = ids;
    }
    if (PROGRESS_DAYS.includes(data.progressDays)) v.progressDays = data.progressDays;
    if (CHART_AXES.includes(data.progressAxis)) v.progressAxis = data.progressAxis;
    if (typeof data.favName === "string") v.favName = data.favName.slice(0, 64);
    return v;
}

// `detailed`: the General / Detailed mode (patternMode.js); in General a remembered kind (quadstream …) asks for its parent.
export function requestFrom(s, { detailed = isDetailed() } = {}) {
    const manual = s.source === "manual";
    const custom = s.goalId === CUSTOM_GOAL;
    return {
        manual,
        // a custom range is the whole window: the manual dan isn't needed for it
        manualDan: manual && !custom ? targetNumeric(s.level, s.step) : null,
        patternId: patternInMode(s.patternId, detailed),
        goalId: s.goalId,
        ...(custom ? { range: { from: Math.min(s.rangeFrom, s.rangeTo), to: Math.max(s.rangeFrom, s.rangeTo) } } : {}),
        lengthId: s.lengthId,
        rankedOnly: Boolean(s.rankedOnly),
        // in manual mode a loaded profile's plays are still known; without one the main process has none to hide
        hidePlayed: Boolean(s.hidePlayed),
    };
}

// The profile another tab loaded is the one this tab would load: the saved nick (any case) or the id.
export function sameAccount(player, query) {
    const q = String(query ?? "").trim().toLowerCase();
    return Boolean(q && player && (q === String(player.username ?? "").toLowerCase() || q === String(player.id)));
}

// the mode chip's name, e.g. "Favourites (3)"
export function modeName(mode, favCount = 0) {
    if (mode === "plan") return t("recommend.mode.plan");
    if (mode === "fav") return t("recommend.mode.fav", { n: favCount });
    if (mode === "progress") return t("recommend.mode.progress");
    return t("recommend.mode.picks");
}

// ---- DOM ----

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let view = parseView(null);
let player = null; // the profile the main process recommends for
let loadedQuery = null;
let shown = null; // { target, patternName } of the list on screen
let searchToken = 0;
let shownOnce = false;
const modeChips = new Map(); // mode → its chip

function readStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // storage unavailable: settings just live until the window closes
    }
}

const saveSettings = () => writeStorage(SETTINGS_KEY, settings);

function saveView(patch) {
    view = parseView(JSON.stringify({ ...view, ...patch }));
    writeStorage(VIEW_KEY, view);
}

// the picks' own status line
function status(text) {
    $("rec-status").textContent = text;
}

// the status line of the mode on screen (profile loading is told wherever the player is looking)
function say(text) {
    $(MODE_STATUS[view.mode]).textContent = text;
}

function lock(on) {
    for (const id of ["rec-load", "rec-me", "rec-go"]) $(id).disabled = on;
}

function renderChips(box, items, selected, onPick) {
    box.replaceChildren(...items.map((item) => {
        const chip = el("span", item.id === selected ? "sel" : "", item.name);
        if (item.hint) chip.title = item.hint;
        chip.addEventListener("click", () => {
            for (const c of box.children) c.classList.toggle("sel", c === chip);
            onPick(item.id);
        });
        return chip;
    }));
}

function applySource() {
    const manual = settings.source === "manual";
    $("rec-tracker").hidden = manual;
    $("rec-manual").hidden = !manual;
    // the picks with a custom range use no dan of their own; the plan still does, so only on the picks
    const rangeOnly = manual && settings.goalId === CUSTOM_GOAL && view.mode === "picks";
    $("rec-manual").classList.toggle("rec-manual-off", rangeOnly);
    $("rec-level").disabled = rangeOnly;
    $("rec-step").disabled = rangeOnly;
    $("rec-manual-note").hidden = !rangeOnly;
    $("rec-skill").hidden = manual || !player;
    // manual mode without a loaded profile has no plays to hide
    const noPlays = manual && !player;
    $("rec-hide-played").disabled = noPlays;
    $("rec-hide-played-row").classList.toggle("off", noPlays);
}

function applyGoal() {
    $("rec-goal-hint").textContent = GOAL_CHIPS.find((g) => g.id === settings.goalId)?.hint ?? "";
    $("rec-range").hidden = settings.goalId !== CUSTOM_GOAL;
    applySource();
}

// the custom range's from / to pickers, each a level + step pair
const RANGE_ENDS = [
    { key: "rangeFrom", level: "rec-range-from-level", step: "rec-range-from-step" },
    { key: "rangeTo", level: "rec-range-to-level", step: "rec-range-to-step" },
];

function initRange() {
    for (const end of RANGE_ENDS) {
        fillDanSelects($(end.level), $(end.step), settings[end.key]);
        const changed = () => {
            settings[end.key] = readDanSelects($(end.level), $(end.step)) ?? settings[end.key];
            saveSettings();
        };
        $(end.level).addEventListener("change", changed);
        $(end.step).addEventListener("change", changed);
    }
}

function renderSkill(skill) {
    const [main, tiles] = skillLines(player.username, skill);
    const box = $("rec-skill");
    box.replaceChildren(el("div", "rec-skill-main", main));
    if (tiles) box.append(el("div", "muted", tiles));
    box.hidden = settings.source === "manual";
}

async function loadPlayer() {
    const query = $("rec-user").value.trim();
    if (!query) {
        say(t("recommend.status.enterUser"));
        return false;
    }
    lock(true);
    say(t("recommend.status.loadingProfile"));
    const r = await call(() => window.danApi.recPlayer(query));
    lock(false);
    if (!r?.ok) {
        // the main process keeps the previous profile, and so does the summary
        say(failText(r));
        return false;
    }
    player = r.player;
    loadedQuery = query;
    settings.query = query; // only a query that worked is worth loading on the next start
    saveSettings();
    renderSkill(r.skill);
    applySource();
    say("");
    return true;
}

// A profile main already holds (loaded for another tab, or here earlier): shown without loading it again.
function adopt(profile) {
    player = profile.player;
    loadedQuery = settings.query || profile.player.username;
    if (!$("rec-user").value.trim()) $("rec-user").value = loadedQuery;
    renderSkill(profile.skill);
    applySource();
}

// A nick typed but not loaded yet is loaded first, so what comes next is for that player.
async function ensurePlayer() {
    if (settings.source === "manual") return true;
    const query = $("rec-user").value.trim();
    if (query && query !== loadedQuery) return loadPlayer();
    return true;
}

async function fromOsu() {
    lock(true);
    const r = await call(() => window.danApi.recMe());
    lock(false);
    if (!r?.ok) return say(failText(r));
    $("rec-user").value = r.query;
    await loadPlayer();
}

const similarOptions = () => ({ rankedOnly: settings.rankedOnly, hidePlayed: settings.hidePlayed });

function pickCard(card) {
    return cardElement(card, { ...shown, status, onSimilar: toggleSimilar, similarOptions });
}

function afterCards(more) {
    $("rec-more").hidden = !more;
    if ($("rec-list").children.length) status(shown?.note ?? "");
    else status(t(more ? "recommend.status.nothingYet" : "recommend.status.empty"));
}

async function go() {
    const request = requestFrom(settings);
    if (!request.manual && !(await ensurePlayer())) return;
    const token = ++searchToken;
    lock(true);
    status(t("recommend.status.searching"));
    $("rec-list").replaceChildren();
    $("rec-more").hidden = true;
    $("rec-target").hidden = true;
    shown = null;
    const r = await call(() => window.danApi.recStart(request));
    lock(false);
    if (token !== searchToken) return;
    if (!r?.ok) return status(failText(r));
    const pattern = patternById(r.target?.patternId) ?? patternById(request.patternId);
    shown = { target: r.target, patternName: pattern.name, note: r.playedPartial ? t("recommend.status.playedPartial") : "" };
    $("rec-target").textContent = targetText(r.target, pattern.name);
    $("rec-target").hidden = false;
    $("rec-list").append(...(r.cards ?? []).map(pickCard));
    afterCards(r.more);
}

async function more() {
    const token = searchToken;
    const b = $("rec-more");
    b.disabled = true;
    b.textContent = "…";
    lock(true);
    status("");
    const r = await call(() => window.danApi.recMore());
    lock(false);
    b.disabled = false;
    b.textContent = t("recommend.more");
    if (token !== searchToken || !shown) return;
    if (!r?.ok) return status(failText(r));
    $("rec-list").append(...(r.cards ?? []).map(pickCard));
    afterCards(r.more);
}

function setMode(mode) {
    saveView({ mode });
    for (const [id, chip] of modeChips) chip.classList.toggle("sel", id === view.mode);
    const own = new Set(MODE_PARTS[view.mode]);
    for (const part of ALL_PARTS) $(part).hidden = !own.has(part);
    applySource();
    if (view.mode === "fav") showFavourites();
    if (view.mode === "progress") showProgress();
}

function renderModes() {
    modeChips.clear();
    $("rec-mode").replaceChildren(...MODES.map((mode) => {
        const chip = el("span", mode === view.mode ? "sel" : "", modeName(mode, favourites().length));
        chip.addEventListener("click", () => setMode(mode));
        modeChips.set(mode, chip);
        return chip;
    }));
}

export function initRecommendTab() {
    settings = parseSettings(readStorage(SETTINGS_KEY));
    view = parseView(readStorage(VIEW_KEY));
    window.danApi.onRecDownloadProgress(onDownloadProgress);

    renderChips($("rec-source"), SOURCES, settings.source, (id) => {
        settings.source = id;
        saveSettings();
        applySource();
    });
    $("rec-user").value = settings.query;
    $("rec-user").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("rec-load").disabled) loadPlayer(); });
    $("rec-load").addEventListener("click", loadPlayer);
    $("rec-me").addEventListener("click", fromOsu);

    $("rec-level").replaceChildren(...LEVELS.map((l) => new Option(l.name, String(l.value), false, l.value === settings.level)));
    $("rec-step").replaceChildren(...STEPS.map((s) => new Option(s.id, s.id, false, s.id === settings.step)));
    $("rec-level").addEventListener("change", () => { settings.level = Number($("rec-level").value); saveSettings(); });
    $("rec-step").addEventListener("change", () => { settings.step = $("rec-step").value; saveSettings(); });

    // General: the seven patterns; Detailed: their kinds too (one switch for every tab, patternMode.js); the cards'
    // «Наш анализ» lines follow it too
    const renderPatterns = () => {
        const detailed = isDetailed();
        renderChips($("rec-patterns"), recPatternsFor(detailed), patternInMode(settings.patternId, detailed), (id) => { settings.patternId = id; saveSettings(); });
    };
    $("rec-pattern-mode").replaceChildren(createPatternModeSwitch());
    renderPatterns();
    onPatternMode(() => {
        renderPatterns();
        redrawOurs();
    });
    renderChips($("rec-goals"), GOAL_CHIPS, settings.goalId, (id) => { settings.goalId = id; saveSettings(); applyGoal(); });
    initRange();

    $("rec-length").replaceChildren(...LENGTHS.map((l) => new Option(l.name, l.id, false, l.id === settings.lengthId)));
    $("rec-length").addEventListener("change", () => { settings.lengthId = $("rec-length").value; saveSettings(); });
    $("rec-ranked").checked = settings.rankedOnly;
    $("rec-ranked").addEventListener("change", () => { settings.rankedOnly = $("rec-ranked").checked; saveSettings(); });
    $("rec-hide-played").checked = settings.hidePlayed;
    $("rec-hide-played").addEventListener("change", () => { settings.hidePlayed = $("rec-hide-played").checked; saveSettings(); });

    $("rec-go").addEventListener("click", go);
    $("rec-more").addEventListener("click", more);
    applySource();
    applyGoal();

    const shared = {
        settings: () => settings,
        view: () => view,
        saveView,
        ensurePlayer,
        hasPlayer: () => Boolean(player),
        manualDan: () => targetNumeric(settings.level, settings.step),
        similarOptions,
    };
    initPlan(shared);
    initFavourites(shared);
    initProgress(shared);
    renderModes();
    onFavourites((items) => { modeChips.get("fav").textContent = modeName("fav", items.length); });
    // a profile main loads later (another tab asked first) shows up here too, unless another nick is typed
    onProfile((p) => {
        if (p.state !== "ready" || !p.player || settings.source === "manual") return;
        if (player && player.id !== p.player.id) return;
        const typed = $("rec-user").value.trim();
        if (typed && !sameAccount(p.player, typed)) return;
        adopt(p);
    });
    const own = new Set(MODE_PARTS[view.mode]);
    for (const part of ALL_PARTS) $(part).hidden = !own.has(part);
}

export async function onRecommendTabShown() {
    if (shownOnce) return;
    shownOnce = true;
    loadFavourites();
    if (view.mode === "fav") showFavourites();
    if (view.mode === "progress") showProgress();
    if (settings.source !== "tracker" || !settings.query || player) return;
    // the profile another tab is loading or has loaded is the same account: take it instead of loading it again
    let profile = getProfile();
    if (profile.state === "loading") profile = await ensureProfile();
    if (profile.state === "ready" && sameAccount(profile.player, settings.query)) {
        adopt(profile);
        return;
    }
    if (!player) loadPlayer();
}
