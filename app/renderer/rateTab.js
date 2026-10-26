// "Рейт" tab: the map selected in osu!, its dan at the chosen rate, and a rate-changed copy like osu-trainer makes.
// This module holds the tab's state and its main controls; the rate for a dan (rateTarget.js), several rates at once
// (rateBatch.js) and presets (ratePresets.js) get what they need through one context object.
import { t } from "../../src/i18n/i18n.js";
import { labelBeside } from "../../src/core/labels.js";
// the analyser's main pattern in the General / Detailed mode shared by every tab (redrawn when it changes)
import { patternLabel, onPatternMode } from "./patternMode.js";
import { initRateTarget, targetPreviewed, targetProgress, resetTarget, syncTarget } from "./rateTarget.js";
import { initRateBatch, batchProgress, clearBatch, markBatchRate, syncBatch } from "./rateBatch.js";
import { initRatePresets } from "./ratePresets.js";
import { sendButtons } from "./interlude.js";

const $ = (id) => document.getElementById(id);
const QUICK_RATES = [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
const PREVIEW_DELAY_MS = 250;

let info = null;
let mapKey = null; // the selected map as main names it (path and change time); progress for another key is old news
let previewTimer = null;
let previewToken = 0;
let pendingRate = null; // set by openRateAt; the next refresh shows it instead of the field's rate
let shown = null; // the preview's answer on screen { r, rate, noLn }: redrawn when the pattern mode changes
let stopMode = null;
const running = new Set(); // rate jobs in main started from here: "target", "dans", "create"

const currentRate = () => Math.min(2, Math.max(0.5, Number($("rate-value").value) || 1));

function setRate(rate, from) {
    const r = Math.round(Math.min(2, Math.max(0.5, rate)) * 100) / 100;
    if (from !== "slider") $("rate-slider").value = String(r);
    if (from !== "input") $("rate-value").value = String(r);
    for (const chip of $("rate-quick").children) chip.classList.toggle("sel", Number(chip.dataset.rate) === r);
    $("rate-bpm").textContent = info?.bpm ? `${Math.round(info.bpm)} BPM → ${Math.round(info.bpm * r)} BPM` : "";
    markBatchRate(r);
    schedulePreview();
}

// OD/HP equal to the map's own are sent as null ("keep"), so a preset made on one map does not pin another's values.
function diffField(id, own) {
    const value = $(id).value;
    if (value === "" || (info && value === String(own))) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Everything a copy or a preset is made of: { rate, pitch, od, hp, mirror, noLn }.
export function getOptions() {
    return {
        rate: currentRate(),
        pitch: $("rate-pitch").checked,
        od: diffField("rate-od", info?.od),
        hp: diffField("rate-hp", info?.hp),
        mirror: $("rate-mirror").checked,
        noLn: $("rate-noln").checked,
    };
}

// Puts a preset's options in the controls (null OD/HP: the map's own).
export function applyOptions(p) {
    $("rate-pitch").checked = Boolean(p.pitch);
    $("rate-od").value = String(p.od ?? info?.od ?? "");
    $("rate-hp").value = String(p.hp ?? info?.hp ?? "");
    const changed = $("rate-mirror").checked !== Boolean(p.mirror) || $("rate-noln").checked !== Boolean(p.noLn);
    $("rate-mirror").checked = Boolean(p.mirror);
    $("rate-noln").checked = Boolean(p.noLn);
    if (changed) dropResults();
    setRate(Number(p.rate) || 1);
}

// The preview's text for an analysis result (also used for a search whose ×1.0 had no dan).
function describe(r, { rate, noLn }) {
    if (r?.kind === "ok") {
        return t("rate.preview.ok", { rate, label: labelBeside(r.numeric, r.label), numeric: r.numeric.toFixed(1), primary: patternLabel(r.primary) ?? "", tech: r.tech ? " · Tech" : "" });
    }
    if (r?.kind === "not-rice") {
        if (r.reason === "mode") return t("rate.preview.notMania");
        if (r.reason === "ln") return noLn ? t("rate.preview.ln") : t("rate.preview.lnHint");
        return t("rate.preview.keys", { keys: r.keys });
    }
    return r?.kind === "too-short" ? t("rate.preview.tooShort") : t("rate.error", { message: r?.message ?? "" });
}

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, PREVIEW_DELAY_MS);
}

async function preview() {
    const box = $("rate-preview");
    shown = null;
    if (!info) {
        box.textContent = "—";
        return;
    }
    const token = ++previewToken;
    const rate = currentRate();
    const { mirror, noLn } = getOptions();
    box.textContent = t("rate.preview.counting", { rate });
    const r = await window.danApi.ratePreview(rate, { mirror, noLn });
    if (token !== previewToken) return; // a newer rate is already being counted
    box.textContent = describe(r, { rate, noLn });
    shown = { r, rate, noLn };
    if (r.kind === "ok") targetPreviewed(r.numeric);
}

// Results that no longer match the map or the chart options: the running job is stopped, the table and the
// search result go.
function dropResults() {
    if (running.size) window.danApi.rateCancel?.();
    clearBatch();
    resetTarget({ keepPick: true });
}

function syncAll() {
    const state = { hasMap: Boolean(info), running: running.size > 0 };
    syncTarget(state);
    syncBatch(state);
}

function setJob(name, on) {
    if (on) running.add(name);
    else running.delete(name);
    syncAll();
}

function showLnBadge(share) {
    const badge = $("rate-ln");
    const pct = Math.round((Number(share) || 0) * 100);
    badge.hidden = !(share > 0);
    badge.textContent = share > 0 ? t("rate.lnBadge", { pct: Math.max(1, pct) }) : "";
    badge.title = t("rate.lnBadgeTitle");
}

async function refresh() {
    $("rate-status").textContent = "";
    const wanted = pendingRate;
    pendingRate = null;
    const r = await window.danApi.rateInfo();
    const key = r.ok ? r.key ?? null : null;
    if (key !== mapKey) {
        // another map (or none): what was worked out for the old one goes
        dropResults();
        resetTarget({ keepPick: false });
        mapKey = key;
    }
    // osu! lazer: no Songs folder, the copies go in as an .osz (the note says so); an Interlude chart: likewise
    $("rate-lazer-note").hidden = !(r.ok && r.client === "lazer");
    $("rate-interlude-note").hidden = !(r.ok && r.client === "interlude");
    if (!r.ok) {
        info = null;
        $("rate-map").textContent = t("rate.noMap", { message: r.message });
        showLnBadge(0);
        $("rate-create").disabled = true;
        syncAll();
        if (wanted !== null) setRate(wanted); // kept for when a map is picked
        else schedulePreview();
        return;
    }
    info = r.info;
    $("rate-map").textContent = `${info.artist} - ${info.title} [${info.version}]`;
    showLnBadge(r.lnShare);
    $("rate-od").value = String(info.od);
    $("rate-hp").value = String(info.hp);
    $("rate-create").disabled = !r.mania;
    if (!r.mania) $("rate-status").textContent = t("rate.notManiaMap");
    syncAll();
    setRate(wanted ?? currentRate());
}

async function create() {
    if (!info) return;
    const { rate, pitch, od, hp, mirror, noLn } = getOptions();
    $("rate-create").disabled = true;
    $("rate-status").textContent = t("rate.creating");
    $("rate-interlude").replaceChildren();
    try {
        const r = await window.danApi.rateCreate({ rate, pitch, od, hp, mirror, noLn });
        $("rate-status").textContent = !r.ok ? t("rate.error", { message: r.message })
            : r.client === "lazer" ? t(r.opened ? "rate.doneLazer" : "rate.doneLazerNotOpened", { version: r.version, file: r.file })
                : r.client === "interlude" ? `${t("rate.doneInterlude", { version: r.version })} ${r.sendMessage ?? ""}`.trim()
                    : t("rate.done", { version: r.version });
        // a copy made in osu!'s Songs folder can go to Interlude too, as an .osz
        if (r.ok && !r.client && r.file) $("rate-interlude").replaceChildren(...sendButtons([r.file]));
    } finally {
        $("rate-create").disabled = false;
    }
}

export function initRateTab() {
    info = null;
    mapKey = null;
    pendingRate = null;
    shown = null;
    running.clear();
    $("rate-quick").replaceChildren(...QUICK_RATES.map((r) => {
        const chip = document.createElement("span");
        chip.textContent = `${r}×`;
        chip.dataset.rate = String(r);
        chip.addEventListener("click", () => setRate(r));
        return chip;
    }));
    $("rate-slider").addEventListener("input", () => setRate(Number($("rate-slider").value), "slider"));
    $("rate-value").addEventListener("change", () => setRate(Number($("rate-value").value), "input"));
    $("rate-refresh").addEventListener("click", refresh);
    $("rate-create").addEventListener("click", create);
    for (const id of ["rate-mirror", "rate-noln"]) {
        $(id).addEventListener("change", () => {
            dropResults();
            schedulePreview();
        });
    }
    const ctx = {
        getOptions, applyOptions, setRate: (r) => setRate(r), describe, setJob,
        currentKey: () => mapKey, mapInfo: () => info,
    };
    initRateTarget(ctx);
    initRateBatch(ctx);
    initRatePresets(ctx);
    // the General / Detailed switch is shared by every tab: the preview's pattern name follows it
    stopMode?.();
    stopMode = onPatternMode(() => {
        if (shown) $("rate-preview").textContent = describe(shown.r, shown);
    });
    // progress of this tab's jobs in main; another map's is dropped
    window.danApi.onRateProgress?.((p) => {
        if (!p || p.key !== mapKey) return;
        if (p.job === "target") targetProgress(p);
        else batchProgress(p);
    });
    syncAll();
}

export const onRateTabShown = refresh;

// Another tab (the analysis ladder) opens this one at a rate: the next refresh shows it and previews it.
export function openRateAt(rate) {
    if (typeof rate === "number" && rate >= 0.5 && rate <= 2) pendingRate = Math.round(rate * 100) / 100;
}
