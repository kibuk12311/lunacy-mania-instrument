// "Сессия": a practice session from the player's own maps (osu! stable's Songs and a linked Interlude library), no
// downloads. The library is listed and analysed in the background by main (app/sessionLibrary.js); the session is
// warm-up → main block → push → cool-down for the length, focus patterns and goal picked here (src/recommend/session.js),
// with ↻ on every map and for the whole session, saved sessions, and the session out of the app: an osu! collection,
// an Interlude playlist (with rates), one marathon .osz, or the list as text.
import { GOALS, patternById, recPatternsFor, patternIdsInMode } from "../../src/recommend/catalog.js";
import { SESSION_MINUTES, MIN_MINUTES, MAX_MINUTES, MAX_SESSION_PATTERNS, RECENT_DAYS } from "../../src/recommend/session.js";
import { mmss } from "../../src/recommend/format.js";
import { t, plural as pluralOf } from "../../src/i18n/i18n.js";
import { isDetailed, onPatternMode, createPatternModeSwitch } from "./patternMode.js";
import { el, call, failText, fix2 } from "./recCard.js";
import { exportButton, sendButtons } from "./interlude.js";
import { togglePattern } from "./recPlan.js";

const KEY = "rec-session";
export const DEFAULT_SESSION = { minutes: 30, patternIds: ["jumpstream"], goalId: "growth", allowRates: false, avoidRecent: true };

const mapsWord = (n) => pluralOf(n, {
    ru: [t("recommend.plan.map.one"), t("recommend.plan.map.few"), t("recommend.plan.map.many")],
    en: [t("recommend.plan.map.one"), t("recommend.plan.map.many")],
});

// Saved page settings → full, valid ones.
export function parseSessionSettings(raw) {
    let data;
    try {
        data = JSON.parse(raw ?? "null");
    } catch {
        data = null;
    }
    const s = { ...DEFAULT_SESSION, patternIds: [...DEFAULT_SESSION.patternIds] };
    if (!data || typeof data !== "object" || Array.isArray(data)) return s;
    if (Number.isInteger(data.minutes) && data.minutes >= MIN_MINUTES && data.minutes <= MAX_MINUTES) s.minutes = data.minutes;
    if (Array.isArray(data.patternIds)) {
        const ids = [...new Set(data.patternIds.filter((id) => typeof id === "string" && patternById(id)))].slice(0, MAX_SESSION_PATTERNS);
        if (ids.length) s.patternIds = ids;
    }
    if (GOALS.some((g) => g.id === data.goalId)) s.goalId = data.goalId;
    if (typeof data.allowRates === "boolean") s.allowRates = data.allowRates;
    if (typeof data.avoidRecent === "boolean") s.avoidRecent = data.avoidRecent;
    return s;
}

// The page's settings and the picks' profile → the session-build request; in the General mode a remembered kind
// asks for its parent. manualProfile: the hand-set profile when the picks' source is "manual"; local: the picks'
// source is the local profile (main supplies its skill).
export function sessionRequest(s, { manual = false, manualProfile = null, local = false, detailed = isDetailed(), avoidRecent = s.avoidRecent } = {}) {
    return {
        minutes: s.minutes,
        patternIds: patternIdsInMode(s.patternIds, detailed),
        goalId: s.goalId,
        allowRates: Boolean(s.allowRates),
        avoidRecent: Boolean(avoidRecent),
        ...(manual ? { manualProfile } : {}),
        ...(local ? { local: true } : {}),
    };
}

export const partText = (part) => t(`session.part.${part}`);

// "×1.10" or nothing at 1.0
export const rateMark = (rate) => (Math.abs(Number(rate) - 1) < 1e-9 ? "" : `×${Number(rate).toFixed(2)}`);

// Where a map is: osu! stable, Interlude or both.
export function sourceText(sources) {
    const out = [];
    if (sources?.stable) out.push("osu!");
    if (sources?.interlude) out.push("Interlude");
    return out.join(" + ");
}

// The meta line of an item: dan (≈ while its rate is only estimated), pattern, length, rate, where it is.
export function itemParts(item) {
    return [
        { text: `${item.estimated ? "≈ " : ""}${item.danLabel}`, cls: "rec-dan" },
        { text: fix2(item.dan) },
        { text: patternById(item.patternId)?.name ?? "" },
        { text: mmss(item.durationSec) },
        { text: rateMark(item.rate), cls: "ses-rate" },
        { text: sourceText(item.sources), cls: "muted" },
    ].filter((p) => p.text);
}

// The session as plain text, one line per map.
export function sessionText(session) {
    const lines = session.items.map((item, i) => {
        const rate = rateMark(item.rate);
        return `${i + 1}. [${partText(item.part)}] ${item.artist} - ${item.title} [${item.version}] · ${item.danLabel} (${fix2(item.dan)})${rate ? ` · ${rate}` : ""} · ${mmss(item.durationSec)}`;
    });
    return [`${session.name} — ${mmss(session.totalSec)}`, ...lines].join("\n");
}

// "Сессия · 31:20 из 30:00 · 9 карт · Джампстрим Gamma mid (13.20) → 13.20–13.70"
export function headText(session) {
    const n = session.items.length;
    const tg = (session.targets ?? []).map((x) => `${patternById(x.patternId)?.name ?? ""} ${fix2(x.playerDan)} → ${fix2(x.lo)}–${fix2(x.hi)}`).join(" · ");
    return t("session.head", { time: mmss(session.totalSec), asked: mmss(session.requestedSec), n, maps: mapsWord(n), targets: tg });
}

// The notes of a built session in words.
export function notesText(notes) {
    return (notes ?? []).map((n) => t(`session.note.${n}`)).join(" ");
}

// The library line: what is found where and how much is analysed.
export function libraryText(st) {
    if (!st || st.ok === false) return failText(st);
    const c = st.counts ?? {};
    const parts = [];
    parts.push(st.songsDir ? t("session.lib.stable", { n: (c.stable ?? 0) + (c.both ?? 0) }) : t("session.lib.noSongs"));
    if (st.interlude?.linked) parts.push(t("session.lib.interlude", { n: st.interlude.count ?? 0 }));
    parts.push(t("session.lib.analysed", { done: c.analysed ?? 0, total: c.total ?? 0 }));
    if (c.skipped) parts.push(t("session.lib.skipped", { n: c.skipped }));
    return parts.join(" · ");
}

export function phaseText(st) {
    const c = st?.counts ?? {};
    if (st?.error) return t("session.lib.failed", { message: st.error });
    if (st?.phase === "listing") return t("session.lib.listing");
    if (st?.phase === "analysing") return t("session.lib.analysing", { left: c.pending ?? 0 });
    if (st?.paused || st?.phase === "paused") return t("session.lib.paused", { left: c.pending ?? 0 });
    if (st?.phase === "done") return c.stale ? "" : t("session.lib.done");
    return "";
}

const $ = (id) => document.getElementById(id);
let shared = null; // { settings(), ensurePlayer(), manualProfile() } of the picks tab
let settings = { ...DEFAULT_SESSION };
let session = null; // the session on screen (main's view of it)
let library = null; // the last library status
let busy = false;
let started = false;

function readStorage() {
    try {
        return localStorage.getItem(KEY);
    } catch {
        return null;
    }
}
function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
        // storage unavailable: kept until the window closes
    }
}

const status = (text) => { $("ses-status").textContent = text; };

function lock(on) {
    busy = on;
    for (const id of ["ses-go", "ses-reroll-all", "ses-save", "ses-collection", "ses-marathon", "ses-copy"]) $(id).disabled = on;
    for (const b of document.querySelectorAll("#ses-list .ses-reroll")) b.disabled = on;
}

function renderMinutes() {
    $("ses-minutes").replaceChildren(...SESSION_MINUTES.map((m) => {
        const chip = el("span", m === settings.minutes ? "sel" : "", t("session.minutes", { n: m }));
        chip.addEventListener("click", () => {
            settings.minutes = m;
            $("ses-custom").value = String(m);
            save();
            renderMinutes();
        });
        return chip;
    }));
    $("ses-custom").value = String(settings.minutes);
}

function renderPatterns() {
    const detailed = isDetailed();
    const chosen = patternIdsInMode(settings.patternIds, detailed);
    $("ses-patterns").replaceChildren(...recPatternsFor(detailed).map((p) => {
        const at = chosen.indexOf(p.id);
        const chip = el("span", at >= 0 ? "sel" : "", at >= 0 && chosen.length > 1 ? `${at + 1}. ${p.name}` : p.name);
        chip.addEventListener("click", () => {
            settings.patternIds = togglePattern(patternIdsInMode(settings.patternIds, isDetailed()), p.id, MAX_SESSION_PATTERNS);
            save();
            renderPatterns();
        });
        return chip;
    }));
}

function renderGoals() {
    $("ses-goals").replaceChildren(...GOALS.map((g) => {
        const chip = el("span", g.id === settings.goalId ? "sel" : "", g.name);
        chip.title = g.hint;
        chip.addEventListener("click", () => {
            settings.goalId = g.id;
            save();
            renderGoals();
        });
        return chip;
    }));
    $("ses-goal-hint").textContent = GOALS.find((g) => g.id === settings.goalId)?.hint ?? "";
}

// The library block: counts, a bar while it is analysed, pause / go on, the sources it cannot read.
function renderLibrary(st) {
    library = st;
    $("ses-lib-status").textContent = libraryText(st);
    $("ses-lib-phase").textContent = phaseText(st);
    const c = st?.counts ?? {};
    const total = c.total ?? 0;
    const done = total - (c.pending ?? 0);
    $("ses-lib-bar").style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
    $("ses-lib-progress").hidden = !(st?.phase === "analysing" || st?.phase === "listing" || (st?.paused && c.pending));
    const running = st?.phase === "analysing" || st?.phase === "listing";
    $("ses-lib-pause").textContent = st?.paused ? t("session.lib.resume") : t("session.lib.pause");
    $("ses-lib-pause").disabled = !(running || st?.paused);
    $("ses-lib-scan").disabled = running;
    const notes = [t("session.lib.lazer")];
    if (!st?.songsDir) notes.unshift(t("session.lib.songsHint"));
    if (!st?.interlude?.linked) notes.push(t("session.lib.interludeHint"));
    $("ses-lib-notes").replaceChildren(...notes.map((n) => el("div", "", n)));
    // plays to leave out: a loaded mania-tracker profile or a linked Interlude
    const known = Boolean(st?.playedKnown);
    $("ses-recent").disabled = !known;
    $("ses-recent-row").classList.toggle("off", !known);
    $("ses-recent-row").title = known ? "" : t("session.recentNone");
}

async function refreshLibrary() {
    renderLibrary(await call(() => window.danApi.sessionLibraryStatus()));
}

function itemElement(item, i) {
    const row = el("div", `ses-item ses-item-${item.part}`);
    row.append(el("span", "ses-n", String(i + 1)));
    const body = el("div", "ses-body");
    const head = el("div", "ses-title-row");
    head.append(el("span", `rec-role ses-part ses-part-${item.part}`, partText(item.part)), el("span", "ses-title", `${item.artist} - ${item.title}`));
    const meta = el("div", "rec-meta");
    meta.append(el("span", "ses-version", `[${item.version}]`));
    for (const p of itemParts(item)) meta.append(el("span", p.cls ?? "", p.text));
    body.append(head, meta);
    const reroll = el("button", "small ses-reroll", "↻");
    reroll.type = "button";
    reroll.title = t("session.rerollOne");
    reroll.disabled = busy;
    reroll.addEventListener("click", () => rerollOne(i));
    row.append(body, reroll);
    return row;
}

function renderSession() {
    const has = Boolean(session?.items?.length);
    $("ses-head").hidden = !has;
    $("ses-actions").hidden = !has;
    $("ses-result").hidden = true;
    if (!has) {
        $("ses-list").replaceChildren();
        return;
    }
    $("ses-head").textContent = headText(session);
    $("ses-list").replaceChildren(...session.items.map(itemElement));
    if (!$("ses-name").value.trim() || $("ses-name").dataset.auto === "1") {
        $("ses-name").value = session.name;
        $("ses-name").dataset.auto = "1";
    }
}

function sayAnswer(r, okText) {
    const box = $("ses-result");
    box.hidden = false;
    box.replaceChildren(el("span", r?.ok ? "ok" : "bad", r?.ok ? okText : failText(r)));
    return box;
}

const needProfile = async () => {
    const s = shared.settings();
    if (s.source !== "manual" && s.source !== "local" && !(await shared.ensurePlayer())) return false;
    return true;
};

const request = () => {
    const s = shared.settings();
    return sessionRequest(settings, { manual: s.source === "manual", manualProfile: shared.manualProfile(), local: s.source === "local", avoidRecent: settings.avoidRecent && !$("ses-recent").disabled });
};

async function build() {
    if (busy || !(await needProfile())) return;
    lock(true);
    status(t("session.building"));
    const r = await call(() => window.danApi.sessionBuild(request()));
    lock(false);
    if (!r?.ok) {
        session = null;
        renderSession();
        // nothing near the target, or no maps yet: the picks can find some to download
        status(r?.reason === "nothingNear" || r?.reason === "empty" ? `${r.message} ${t("session.err.tryPicks")}` : failText(r));
        return;
    }
    session = r.session;
    renderSession();
    status(notesText(session.notes));
}

async function rerollOne(i) {
    if (busy) return;
    lock(true);
    status(t("session.rerolling"));
    const r = await call(() => window.danApi.sessionReroll(i));
    lock(false);
    if (!r?.ok) return status(r?.none ? t("session.err.noOther") : failText(r));
    session = r.session;
    renderSession();
    status("");
}

const sessionName = () => $("ses-name").value.trim() || session?.name || "";

async function saveSession() {
    if (busy || !session) return;
    const r = await call(() => window.danApi.sessionSave(sessionName()));
    if (!r?.ok) return status(failText(r));
    status(t("session.saved"));
    renderSaved(r.items);
}

async function copyList() {
    if (!session) return;
    const text = sessionText({ ...session, name: sessionName() });
    // main's clipboard first (the window's own API wants focus), the window's if main did not take it
    let ok = Boolean((await call(() => window.danApi.sessionCopy(text)))?.ok);
    if (!ok) {
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            ok = false;
        }
    }
    status(ok ? t("session.copied") : t("session.copyFailed"));
}

async function exportCollection() {
    if (busy || !session) return;
    lock(true);
    status(t("session.exporting"));
    const r = await call(() => window.danApi.sessionExportCollection(sessionName()));
    lock(false);
    status("");
    const box = sayAnswer(r, t("session.collectionDone", { name: r?.name ?? "", n: r?.count ?? 0, maps: mapsWord(r?.count ?? 0), made: r?.made ?? 0 }));
    if (r?.ok) {
        if (r.skipped?.length) box.append(el("div", "muted", t("session.skipped", { n: r.skipped.length, list: r.skipped.slice(0, 3).join("; ") })));
        box.append(el("div", "muted", t("session.collectionHint")));
    }
}

async function exportMarathon() {
    if (busy || !session) return;
    lock(true);
    status(t("session.marathonBuilding"));
    const r = await call(() => window.danApi.sessionExportMarathon(sessionName()));
    lock(false);
    status("");
    const box = sayAnswer(r, t("session.marathonDone", { time: mmss((r?.totalMs ?? 0) / 1000) }));
    if (r?.ok) {
        const links = el("div", "rec-actions");
        for (const [text, fn] of [[t("marathon.link.open"), () => window.danApi.openMap(r.file)], [t("marathon.link.show"), () => window.danApi.showMap(r.file)]]) {
            const b = el("button", "small", text);
            b.addEventListener("click", fn);
            links.append(b);
        }
        links.append(...sendButtons([r.file]));
        box.append(links);
        if (r.skipped?.length) box.append(el("div", "muted", t("session.skipped", { n: r.skipped.length, list: r.skipped.slice(0, 3).join("; ") })));
    }
}

function renderSaved(items) {
    const list = Array.isArray(items) ? items : [];
    $("ses-saved-box").hidden = !list.length;
    $("ses-saved").replaceChildren(...list.map((s) => {
        const row = el("div", "ses-saved-row");
        const when = new Date(s.at);
        const date = `${String(when.getDate()).padStart(2, "0")}.${String(when.getMonth() + 1).padStart(2, "0")}`;
        row.append(el("span", "ses-saved-name", s.name), el("span", "muted", `${date} · ${s.items.length} ${mapsWord(s.items.length)} · ${mmss(s.totalSec)}`));
        const open = el("button", "small", t("session.open"));
        open.addEventListener("click", async () => {
            const r = await call(() => window.danApi.sessionOpen(s.id));
            if (!r?.ok) return status(failText(r));
            session = r.session;
            $("ses-name").value = session.name;
            $("ses-name").dataset.auto = "0";
            renderSession();
            status("");
        });
        const del = el("button", "small", "✕");
        del.title = t("session.remove");
        del.addEventListener("click", async () => {
            const r = await call(() => window.danApi.sessionRemove(s.id));
            if (r?.ok) renderSaved(r.items);
        });
        row.append(open, del);
        return row;
    }));
}

export function initSession(s) {
    shared = s;
    settings = parseSessionSettings(readStorage());
    renderMinutes();
    $("ses-custom").min = String(MIN_MINUTES);
    $("ses-custom").max = String(MAX_MINUTES);
    $("ses-custom").addEventListener("change", () => {
        const n = Math.round(Number($("ses-custom").value));
        if (Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES) {
            settings.minutes = n;
            save();
        }
        renderMinutes();
    });
    $("ses-pattern-mode").replaceChildren(createPatternModeSwitch());
    renderPatterns();
    onPatternMode(renderPatterns);
    renderGoals();
    $("ses-rates").checked = settings.allowRates;
    $("ses-rates").addEventListener("change", () => { settings.allowRates = $("ses-rates").checked; save(); });
    $("ses-recent").checked = settings.avoidRecent;
    $("ses-recent").addEventListener("change", () => { settings.avoidRecent = $("ses-recent").checked; save(); });
    $("ses-recent-label").textContent = t("session.html.recent", { days: RECENT_DAYS });
    $("ses-go").addEventListener("click", build);
    $("ses-reroll-all").addEventListener("click", build);
    $("ses-save").addEventListener("click", saveSession);
    $("ses-copy").addEventListener("click", copyList);
    $("ses-collection").addEventListener("click", exportCollection);
    $("ses-marathon").addEventListener("click", exportMarathon);
    $("ses-name").addEventListener("input", () => { $("ses-name").dataset.auto = "0"; });
    $("ses-lib-scan").addEventListener("click", async () => renderLibrary(await call(() => window.danApi.sessionLibraryScan())));
    $("ses-lib-pause").addEventListener("click", async () => {
        const r = await call(() => (library?.paused ? window.danApi.sessionLibraryResume() : window.danApi.sessionLibraryPause()));
        renderLibrary(r);
    });
    $("ses-lib-pick").addEventListener("click", async () => {
        const r = await call(() => window.danApi.sessionLibraryPick());
        if (!r?.cancelled) renderLibrary(r);
    });
    window.danApi.onSessionLibrary?.((st) => renderLibrary({ ok: true, ...st, playedKnown: library?.playedKnown ?? false }));
    window.danApi.onSessionProgress?.((p) => {
        if (!busy) return;
        const key = { rates: "session.progress.rates", copy: "session.progress.copy", build: "session.marathonBuilding" }[p?.phase];
        if (key) status(t(key, { i: p.i, n: p.n }));
    });
    // the page as a playlist in Interlude, in its order and with its rates
    $("ses-interlude").replaceChildren(exportButton(() => ({
        name: sessionName(),
        items: (session?.items ?? []).map((item) => ({
            hash: item.sources?.interlude?.hash, md5: item.sources?.stable?.md5, path: item.sources?.stable?.path,
            rate: item.rate, label: `${item.artist} - ${item.title} [${item.version}]`,
        })),
    })));
}

// The page is shown: the library is listed (again: only what changed) and analysed in the background.
export async function showSession() {
    if (!started) {
        started = true;
        renderLibrary(await call(() => window.danApi.sessionLibraryScan()));
        const saved = await call(() => window.danApi.sessionList());
        if (saved?.ok) renderSaved(saved.items);
        return;
    }
    await refreshLibrary();
}
