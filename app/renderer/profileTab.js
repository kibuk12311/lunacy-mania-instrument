// "Профиль" tab: every profile in one place, two pages under a switch.
//   mania-tracker — the tracker player (nick / "from osu!", the same loader as the picks tab: both go through main's
//                   rec-player and profile.js), their dan, the four tiles, MinaCalc ratings, the history chart (the
//                   picks' progress data), recent plays, a link to the profile on mania-tracker.com;
//   Мой профиль   — the local profile (app/localProfileService.js): overall + four axes with ± and confidence, the
//                   seven patterns, top plays per axis/pattern, recent plays, its history chart, the history import
//                   (osu! stable scores.db, Interlude), backup export / import, reset, «Записывать мои игры».
// Above both: which profile Picks, the plan, the auto-marathon and «для тебя» use (the picks tab's source, saved in
// its settings: one source of truth), and the hand-set profile's summary with a link to its editor in Picks.
import { TILE_NAMES } from "../../src/recommend/catalog.js";
import { HISTORY_AXES } from "../../src/recommend/progress.js";
import { manualProfileOf, manualSkill } from "../../src/recommend/manualProfile.js";
import { AXES, PATTERNS } from "../../src/localProfile/model.js";
import { numericToLabel } from "../../src/core/labels.js";
import { t } from "../../src/i18n/i18n.js";
import { el, button, call, failText, rateText } from "./recCard.js";
import { danChangeText, axesText } from "./recProgress.js";
import { getTrackerProfile, ensureTrackerProfile, onProfile, manualChanged, refreshLocal, trackerLoaded } from "./profile.js";
import {
    LOCAL_AXES, localAxisName, localChangeText, localAxesText, lineChart, skillSummary, patternTable, playRow, whenText,
} from "./profileViews.js";

export const PAGES = ["tracker", "local"];
export const SOURCES = ["tracker", "manual", "local"];
export const LOCAL_DAYS = [7, 30, 90, 365];
export const TRACKER_DAYS = [7, 30, 90];
const SETTINGS_KEY = "rec-settings"; // the picks tab's settings (source, query, manualProfile)
const VIEW_KEY = "profile-view";
export const DEFAULT_VIEW = { page: "local", localDays: 90, localAxis: "dan", topAxis: "speed", trackerDays: 30, trackerAxis: "dan" };
const TOP_KEYS = [...AXES, ...PATTERNS.map((p) => `p:${p}`)];
const RESET_CONFIRM_MS = 4000;

const $ = (id) => document.getElementById(id);
let view = { ...DEFAULT_VIEW };
let local = null; // the last local-profile-status answer
let importing = null; // the import's last progress event
let resetArmed = 0;
let shownOnce = false;

function readJson(key) {
    try {
        const data = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

function writeJson(key, value) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
        // not remembered, still used
    }
}

// Saved view → a valid one.
export function parseProfileView(data) {
    const v = { ...DEFAULT_VIEW };
    if (PAGES.includes(data?.page)) v.page = data.page;
    if (LOCAL_DAYS.includes(data?.localDays)) v.localDays = data.localDays;
    if (LOCAL_AXES.includes(data?.localAxis)) v.localAxis = data.localAxis;
    if (TOP_KEYS.includes(data?.topAxis)) v.topAxis = data.topAxis;
    if (TRACKER_DAYS.includes(data?.trackerDays)) v.trackerDays = data.trackerDays;
    if (["dan", ...HISTORY_AXES].includes(data?.trackerAxis)) v.trackerAxis = data.trackerAxis;
    return v;
}

function saveView(patch) {
    view = parseProfileView({ ...view, ...patch });
    writeJson(VIEW_KEY, view);
}

const source = () => (SOURCES.includes(readJson(SETTINGS_KEY).source) ? readJson(SETTINGS_KEY).source : "tracker");
const sourceName = (id) => t(id === "tracker" ? "recommend.source.tracker" : id === "manual" ? "recommend.source.manual" : "profile.source.local");

function chips(box, items, selected, name, onPick) {
    box.replaceChildren(...items.map((id) => {
        const chip = el("span", id === selected ? "sel" : "", name(id));
        chip.addEventListener("click", () => onPick(id));
        return chip;
    }));
}

// ---- which profile the other tabs use ----

function setSource(id) {
    const s = readJson(SETTINGS_KEY);
    writeJson(SETTINGS_KEY, { ...s, source: id });
    manualChanged();
    window.dispatchEvent(new CustomEvent("profile-source", { detail: { source: id, from: "profile" } }));
    renderSource();
}

function renderSource() {
    const now = source();
    chips($("prof-source"), SOURCES, now, sourceName, setSource);
    const line = $("prof-manual-line");
    line.hidden = now !== "manual";
    if (now === "manual") {
        const p = manualProfileOf(readJson(SETTINGS_KEY));
        const skill = manualSkill(p);
        const tiles = AXES.map((a) => `${TILE_NAMES[a]} ${numericToLabel(skill.tiles[a]).text}`).join(" · ");
        line.replaceChildren(el("span", "", `${t("recommend.manual.tag")}: ${tiles} `),
            button(t("profile.html.editManual"), "", () => window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "recommend" } }))));
    }
}

// ---- pages ----

function setPage(page) {
    saveView({ page });
    chips($("prof-pages"), PAGES, view.page, (p) => t(`profile.page.${p}`), setPage);
    $("prof-tracker-page").hidden = view.page !== "tracker";
    $("prof-local-page").hidden = view.page !== "local";
    if (view.page === "tracker") showTracker();
    else showLocal();
}

// ---- mania-tracker ----

const trackerStatus = (text) => { $("prof-tracker-status").textContent = text; };

function renderTracker(p) {
    const card = $("prof-tracker-card");
    const ready = p?.state === "ready" && p.player && p.skill && !p.manual && !p.local;
    card.hidden = !ready;
    $("prof-tracker-more").hidden = !ready;
    if (!ready) return;
    const box = skillSummary(p.skill, { name: p.player.username, tag: `${p.skill.analyzedPlays || 0} ${t("profile.tracker.plays")}` });
    const url = typeof p.player.avatarUrl === "string" && p.player.avatarUrl.startsWith("https://a.ppy.sh/") ? p.player.avatarUrl : null;
    const avatar = el(url ? "img" : "span", "prof-avatar", url ? undefined : (p.player.username || "?").slice(0, 1).toUpperCase());
    if (url) avatar.src = url;
    box.querySelector?.(".prof-head")?.prepend(avatar);
    const msd = Object.entries(p.skill.msd ?? {}).filter(([k, v]) => Number.isFinite(v) && HISTORY_AXES.includes(k));
    const ratings = el("div", "prof-msd", msd.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · "));
    card.replaceChildren(box, ...(msd.length ? [el("div", "flabel", t("profile.tracker.msd")), ratings] : []));
}

async function loadTracker(query) {
    const q = String(query ?? "").trim();
    if (!q) return trackerStatus(t("recommend.status.enterUser"));
    for (const id of ["prof-load", "prof-me"]) $(id).disabled = true;
    trackerStatus(t("recommend.status.loadingProfile"));
    const r = await call(() => window.danApi.recPlayer(q));
    for (const id of ["prof-load", "prof-me"]) $(id).disabled = false;
    if (!r?.ok) return trackerStatus(failText(r));
    // one source of truth: the shared profile, the picks tab's saved nick, and the picks tab itself
    writeJson(SETTINGS_KEY, { ...readJson(SETTINGS_KEY), query: q });
    trackerLoaded(r.player, r.skill);
    window.dispatchEvent(new CustomEvent("tracker-player", { detail: { player: r.player, skill: r.skill, query: q } }));
    trackerStatus("");
    renderTracker({ state: "ready", player: r.player, skill: r.skill });
    loadTrackerExtras();
}

async function trackerFromOsu() {
    const r = await call(() => window.danApi.recMe());
    if (!r?.ok) return trackerStatus(failText(r));
    $("prof-user").value = r.query;
    await loadTracker(r.query);
}

let trackerToken = 0;
async function loadTrackerExtras() {
    const run = ++trackerToken;
    chips($("prof-tracker-days"), TRACKER_DAYS, view.trackerDays, (d) => t("recommend.progress.days", { n: d }), (d) => { saveView({ trackerDays: d }); loadTrackerExtras(); });
    const [h, recent] = await Promise.all([
        call(() => window.danApi.recProgress(view.trackerDays)),
        call(() => window.danApi.trackerRecent?.() ?? Promise.resolve({ ok: false })),
    ]);
    if (run !== trackerToken) return;
    const drawChart = () => {
        chips($("prof-tracker-axes"), ["dan", ...HISTORY_AXES], view.trackerAxis, (a) => (a === "dan" ? t("recommend.progress.axisDan") : a), (a) => { saveView({ trackerAxis: a }); drawChart(); });
        const chart = h?.ok ? lineChart(h.points, view.trackerAxis, { from: h.since, to: Date.now() }) : null;
        $("prof-tracker-chart").replaceChildren(chart ?? el("div", "muted", h?.ok ? t("recommend.progress.noChart") : failText(h)));
    };
    drawChart();
    $("prof-tracker-change").replaceChildren(...(h?.ok && h.change ? [el("div", "rec-progress-dan", danChangeText(h.change)), el("div", "muted", axesText(h.change))] : []));
    const list = $("prof-tracker-recent");
    if (!recent?.ok) list.replaceChildren(el("div", "muted", failText(recent)));
    else if (!recent.plays.length) list.replaceChildren(el("div", "muted", t("profile.tracker.noRecent")));
    else {
        const now = Date.now();
        list.replaceChildren(...recent.plays.map((p) => playRow({
            artist: p.artist, title: p.title, version: p.version, rate: p.rate, accuracy: Number.isFinite(p.accuracy) ? p.accuracy * 100 : null,
            outcome: p.passed ? "pass" : "fail", at: p.at,
        }, now, { showPerf: false })));
    }
}

async function showTracker() {
    let p = getTrackerProfile();
    if (p.state !== "ready") {
        const saved = readJson(SETTINGS_KEY).query;
        if (!$("prof-user").value && typeof saved === "string") $("prof-user").value = saved;
        if (saved) {
            trackerStatus(t("recommend.status.loadingProfile"));
            p = await ensureTrackerProfile();
            trackerStatus(p.state === "failed" ? t("app.shared.profileFailed", { message: p.message ?? "" }) : p.state === "ready" ? "" : t("profile.tracker.none"));
        } else {
            trackerStatus(t("profile.tracker.none"));
        }
    } else {
        trackerStatus("");
        if (!$("prof-user").value) $("prof-user").value = p.player?.username ?? "";
    }
    renderTracker(p);
    if (p.state === "ready" && !p.manual && !p.local) loadTrackerExtras();
}

// ---- my profile ----

const localStatus = (text) => { $("prof-local-status").textContent = text; };

function countsText(c) {
    if (!c?.plays) return t("profile.local.noPlays");
    const parts = [t("profile.local.count", { n: c.plays, rated: c.rated })];
    if (c.live) parts.push(t("profile.local.fromLive", { n: c.live }));
    if (c.stable) parts.push(t("profile.local.fromStable", { n: c.stable }));
    if (c.interlude) parts.push(t("profile.local.fromInterlude", { n: c.interlude }));
    return parts.join(" · ");
}

function renderTop() {
    const keys = TOP_KEYS;
    chips($("prof-top-axis"), keys, view.topAxis, localAxisName, (k) => { saveView({ topAxis: k }); renderTop(); });
    const list = local?.top?.[view.topAxis] ?? [];
    const now = Date.now();
    $("prof-local-top").replaceChildren(...(list.length ? list.map((p) => playRow(p, now)) : [el("div", "muted", t("profile.local.noTop"))]));
}

function renderCompare() {
    const box = $("prof-compare");
    const p = getTrackerProfile();
    const skill = local?.skill;
    if (p.state !== "ready" || !p.skill || !skill) {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    const rows = ["overall", ...AXES].map((k) => {
        const mine = k === "overall" ? skill.overall : skill.tiles?.[k];
        const theirs = k === "overall" ? p.skill.overall : p.skill.tiles?.[k];
        const name = k === "overall" ? t("recommend.progress.axisDan") : TILE_NAMES[k];
        const d = Number.isFinite(mine) && Number.isFinite(theirs) ? ` (${mine - theirs >= 0 ? "+" : ""}${(mine - theirs).toFixed(2)})` : "";
        const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
        return el("div", "prof-cmp-row", `${name}: ${f(mine)} · mania-tracker ${f(theirs)}${d}`);
    });
    box.replaceChildren(el("div", "flabel", t("profile.local.compare", { name: p.player?.username ?? "" })), ...rows);
}

function renderImport() {
    const busy = Boolean(importing && importing.phase !== "end") || Boolean(local?.importing);
    $("prof-import-stable").disabled = busy;
    $("prof-pick-osu").disabled = busy;
    $("prof-import-interlude").disabled = busy || !local?.interludeLinked;
    $("prof-import-interlude").title = local?.interludeLinked ? "" : t("profile.local.noInterlude");
    $("prof-import-cancel").hidden = !busy;
    const ev = importing && importing.phase !== "end" ? importing : local?.importing;
    if (ev?.phase === "scan") $("prof-import-status").textContent = t("profile.import.scan", { done: ev.done ?? 0, total: ev.total ?? 0 });
    else if (ev?.phase === "analyse") $("prof-import-status").textContent = t("profile.import.analyse", { done: ev.done ?? 0, total: ev.total ?? 0, added: ev.added ?? 0 });
    else if (!busy) {
        const last = local?.settings?.imports?.stable;
        $("prof-import-status").textContent = last?.at ? t(last.finished ? "profile.import.lastDone" : "profile.import.lastStopped", { added: last.added, when: whenText(last.at) }) : "";
    }
}

function renderLocal() {
    if (!local?.ok) return;
    const k = local.skill;
    $("prof-record").checked = local.settings?.record !== false;
    $("prof-local-counts").textContent = countsText(local.counts);
    $("prof-local-card").replaceChildren(skillSummary(k, { name: t("profile.local.name"), tag: t("profile.local.tag") }));
    $("prof-local-patterns").replaceChildren(patternTable(k));
    renderTop();
    const now = Date.now();
    $("prof-local-recent").replaceChildren(...(local.recent.length ? local.recent.map((p) => playRow(p, now)) : [el("div", "muted", t("profile.local.noPlays"))]));
    renderImport();
    renderCompare();
}

let historyToken = 0;
async function loadLocalHistory() {
    const run = ++historyToken;
    chips($("prof-local-days"), LOCAL_DAYS, view.localDays, (d) => t("recommend.progress.days", { n: d }), (d) => { saveView({ localDays: d }); loadLocalHistory(); });
    const h = await call(() => window.danApi.localProfileHistory(view.localDays));
    if (run !== historyToken) return;
    const draw = () => {
        const axes = LOCAL_AXES.filter((a) => a === "dan" || (h?.points ?? []).some((p) => Number.isFinite(p.ratings?.[a])));
        const axis = axes.includes(view.localAxis) ? view.localAxis : "dan";
        chips($("prof-local-axes"), axes, axis, localAxisName, (a) => { saveView({ localAxis: a }); draw(); });
        const chart = h?.ok ? lineChart(h.points, axis, { from: h.since, to: h.now }) : null;
        $("prof-local-chart").replaceChildren(chart ?? el("div", "muted", h?.ok ? t("profile.local.noHistory") : failText(h)));
    };
    draw();
    $("prof-local-change").replaceChildren(...(h?.ok && h.change ? [el("div", "rec-progress-dan", localChangeText(h.change)), el("div", "muted", localAxesText(h.change))] : []));
}

async function loadLocal() {
    const r = await call(() => window.danApi.localProfileStatus());
    if (!r?.ok) return localStatus(failText(r));
    local = r;
    localStatus("");
    renderLocal();
}

async function showLocal() {
    await loadLocal();
    await loadLocalHistory();
}

const IMPORT_REFUSALS = { "no-folder": "profile.import.noFolder", "no-scores": "profile.import.noScores", busy: "profile.import.busy", "no-interlude": "profile.local.noInterlude" };

async function runImport(fn) {
    importing = { phase: "scan", done: 0, total: 0 };
    renderImport();
    const r = await call(fn);
    importing = null;
    await loadLocal();
    let text = "";
    if (r?.ok) {
        text = t(r.finished ? "profile.import.done" : "profile.import.stopped", { added: r.added, total: r.total })
            + (r.missing ? ` · ${t("profile.import.missing", { n: r.missing })}` : "");
    } else if (!r?.cancelled) {
        text = IMPORT_REFUSALS[r?.reason] ? t(IMPORT_REFUSALS[r.reason], { folder: r.folder ?? "" }) : failText(r);
    }
    $("prof-import-status").textContent = text;
    await refreshLocal();
    loadLocalHistory();
}

async function backup(fn, okKey) {
    const r = await call(fn);
    if (r?.cancelled) return;
    $("prof-backup-status").textContent = r?.ok ? t(okKey, { n: r.plays ?? r.added ?? 0, skipped: r.skipped ?? 0 }) : failText(r);
    if (r?.ok && okKey !== "profile.backup.exported") {
        await refreshLocal();
        await showLocal();
    }
}

async function reset() {
    const b = $("prof-reset");
    if (Date.now() - resetArmed > RESET_CONFIRM_MS) {
        resetArmed = Date.now();
        b.textContent = t("profile.backup.resetSure");
        setTimeout(() => { if (Date.now() - resetArmed >= RESET_CONFIRM_MS) b.textContent = t("profile.html.reset"); }, RESET_CONFIRM_MS + 50);
        return;
    }
    resetArmed = 0;
    b.textContent = t("profile.html.reset");
    const r = await call(() => window.danApi.localProfileReset());
    $("prof-backup-status").textContent = r?.ok ? t("profile.backup.wasReset") : failText(r);
    await refreshLocal();
    await showLocal();
}

export function initProfileTab() {
    view = parseProfileView(readJson(VIEW_KEY));
    const api = window.danApi;
    renderSource();
    chips($("prof-pages"), PAGES, view.page, (p) => t(`profile.page.${p}`), setPage);
    $("prof-tracker-page").hidden = view.page !== "tracker";
    $("prof-local-page").hidden = view.page !== "local";

    $("prof-user").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("prof-load").disabled) loadTracker($("prof-user").value); });
    $("prof-load").addEventListener("click", () => loadTracker($("prof-user").value));
    $("prof-me").addEventListener("click", trackerFromOsu);
    $("prof-tracker-site").addEventListener("click", async () => {
        const r = await call(() => api.trackerOpenSite());
        if (!r?.ok) trackerStatus(failText(r));
    });

    $("prof-record").addEventListener("change", async () => {
        const r = await call(() => api.localProfileRecord($("prof-record").checked));
        localStatus(r?.ok ? t(r.record ? "profile.local.recordOn" : "profile.local.recordOff") : failText(r));
    });
    $("prof-import-stable").addEventListener("click", () => runImport(() => api.localProfileImport("stable")));
    $("prof-pick-osu").addEventListener("click", () => runImport(() => api.localProfilePickOsu()));
    $("prof-import-interlude").addEventListener("click", () => runImport(() => api.localProfileImport("interlude")));
    $("prof-import-cancel").addEventListener("click", () => call(() => api.localProfileImportCancel()));
    $("prof-export").addEventListener("click", () => backup(() => api.localProfileExport(), "profile.backup.exported"));
    $("prof-import-file").addEventListener("click", () => backup(() => api.localProfileImportFile(), "profile.backup.imported"));
    $("prof-reset").addEventListener("click", reset);

    api.onLocalProfileImport?.((ev) => {
        importing = ev?.phase === "end" ? null : ev;
        renderImport();
    });
    // a play kept while the page is open: the page follows it
    let pendingRefresh = null;
    api.onLocalProfileChanged?.(() => {
        if ($("profile-tab").hidden || view.page !== "local") return;
        clearTimeout(pendingRefresh);
        pendingRefresh = setTimeout(() => { void showLocal(); }, 400);
    });
    // the picks tab switched the source, or loaded a player there
    window.addEventListener("profile-source", (e) => { if (e.detail?.from !== "profile") renderSource(); });
    window.addEventListener("tracker-player", () => { if (!$("profile-tab").hidden && view.page === "tracker") renderTracker(getTrackerProfile()); });
    window.addEventListener("open-tab", (e) => { if (e.detail?.tab === "profile" && PAGES.includes(e.detail.page)) setPage(e.detail.page); });
    onProfile(() => {
        if ($("profile-tab").hidden) return;
        renderSource();
        if (view.page === "local") renderCompare();
    });
}

export function onProfileTabShown() {
    renderSource();
    if (!shownOnce) shownOnce = true;
    if (view.page === "tracker") showTracker();
    else showLocal();
}
