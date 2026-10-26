// "Марафон" tab: an ordered list of maps, each with its own rate and dan, joined into one dan-course style map.
// The auto-marathon panel (marathonAuto.js) fills the same list; the curve under it redraws on every change.
import { t } from "../../src/i18n/i18n.js";
import { numericToLabel } from "../../src/core/labels.js";
import { drawCurve } from "./marathonCurveView.js";
import { initMarathonAuto } from "./marathonAuto.js";

const $ = (id) => document.getElementById(id);
const entries = []; // { path, name, rate, dan, numeric, cutMs, targetDan }
const listeners = new Set();
let danToken = 0;
let plan = null; // the active template's dan per map, dashed on the curve

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const clampRate = (r) => Math.round(Math.min(2, Math.max(0.5, Number(r) || 1)) * 100) / 100;

function status(text) {
    $("mar-status").textContent = text;
}

function gapSec() {
    const v = Number($("mar-gap").value);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

async function refreshDan(entry) {
    const token = (entry.token = ++danToken);
    entry.dan = "…";
    entry.numeric = null;
    render();
    let answer = null;
    try {
        answer = await window.danApi.marathonDan(entry.path, entry.rate);
    } catch {
        answer = null;
    }
    if (entry.token !== token) return;
    // an older main answered a bare label
    const { label, numeric, cutMs } = typeof answer === "string" ? { label: answer } : answer ?? {};
    entry.dan = label || "—";
    entry.numeric = finite(numeric);
    if (finite(cutMs) !== null) entry.cutMs = cutMs;
    render();
}

function redrawCurve() {
    $("mar-curve-box").hidden = entries.length === 0;
    drawCurve($("mar-curve"), entries, gapSec(), plan);
}

function changed() {
    redrawCurve();
    for (const cb of [...listeners]) {
        try {
            cb(entries.length);
        } catch {
            // one listener's mistake must not stop the list
        }
    }
}

function render() {
    const list = $("mar-list");
    $("mar-create").disabled = entries.length === 0;
    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = t("marathon.empty");
        list.replaceChildren(empty);
        changed();
        return;
    }
    list.replaceChildren(...entries.map((e, i) => {
        const row = document.createElement("div");
        row.className = "mar-row";
        const n = document.createElement("span");
        n.className = "mar-n";
        n.textContent = String(i + 1);
        const name = document.createElement("span");
        name.className = "mar-name";
        name.textContent = e.name;
        name.title = e.name;
        const rate = document.createElement("input");
        rate.type = "number";
        rate.min = "0.5";
        rate.max = "2";
        rate.step = "0.05";
        rate.value = String(e.rate);
        rate.className = "mar-rate";
        rate.title = t("marathon.row.rate");
        rate.addEventListener("change", () => {
            e.rate = clampRate(rate.value);
            rate.value = String(e.rate);
            refreshDan(e);
        });
        const dan = document.createElement("span");
        dan.className = "mar-dan";
        dan.textContent = e.dan ?? "";
        if (e.targetDan !== null && e.targetDan !== undefined) dan.title = t("marathon.row.target", { dan: numericToLabel(e.targetDan).text });
        const button = (text, title, onClick) => {
            const b = document.createElement("button");
            b.className = "small";
            b.textContent = text;
            b.title = title;
            b.addEventListener("click", onClick);
            return b;
        };
        row.append(n, name, rate, dan,
            button("↑", t("marathon.row.up"), () => { if (i > 0) { entries.splice(i - 1, 0, entries.splice(i, 1)[0]); render(); } }),
            button("↓", t("marathon.row.down"), () => { if (i < entries.length - 1) { entries.splice(i + 1, 0, entries.splice(i, 1)[0]); render(); } }),
            button("×", t("marathon.row.remove"), () => { entries.splice(i, 1); render(); }));
        return row;
    }));
    changed();
}

function add(answer) {
    if (!answer.ok) return status(t("marathon.add.failed", { message: answer.message }));
    if (!answer.ok4k) return status(t("marathon.add.not4k", { name: answer.name }));
    const entry = { path: answer.path, name: answer.name, rate: 1, dan: "", numeric: null, cutMs: null, targetDan: null };
    entries.push(entry);
    status("");
    refreshDan(entry);
}

// Rows that already know their dan (the auto-marathon's): mode "replace" empties the list first, "append" adds at the end.
export function setEntries(list, mode = "append") {
    if (mode === "replace") entries.length = 0;
    for (const e of list ?? []) {
        if (!e || typeof e.path !== "string") continue;
        entries.push({
            path: e.path, name: String(e.name ?? e.path), rate: clampRate(e.rate),
            dan: e.label || "—", numeric: finite(e.numeric), cutMs: finite(e.cutMs), targetDan: finite(e.targetDan),
        });
    }
    render();
}

// cb(count) after every change of the list; → unsubscribe
export function onListChange(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

// The template's dan per map for the curve, or null for none.
export function setPlan(next) {
    plan = Array.isArray(next) && next.length ? [...next] : null;
    redrawCurve();
}

async function create() {
    $("mar-create").disabled = true;
    $("mar-result").hidden = true;
    status(t("marathon.building"));
    try {
        const r = await window.danApi.marathonCreate({
            title: $("mar-title").value.trim() || t("marathon.defaultTitle"),
            entries: entries.map((e) => ({ path: e.path, rate: e.rate })),
            gapSec: Number($("mar-gap").value),
            pitch: $("mar-pitch").checked,
            od: $("mar-od").value,
            hp: $("mar-hp").value,
            plan,
        });
        status("");
        const box = $("mar-result");
        box.hidden = false;
        box.replaceChildren();
        const line = document.createElement("div");
        line.className = r.ok ? "ok" : "bad";
        const min = Math.floor((r.totalMs ?? 0) / 60000);
        const sec = String(Math.round(((r.totalMs ?? 0) % 60000) / 1000)).padStart(2, "0");
        line.textContent = r.ok ? t("marathon.done", { n: entries.length, time: `${min}:${sec}` }) : t("marathon.error", { message: r.message });
        box.append(line);
        if (r.ok) {
            const links = document.createElement("div");
            links.className = "links";
            for (const [text, fn] of [[t("marathon.link.open"), () => window.danApi.openMap(r.file)], [t("marathon.link.show"), () => window.danApi.showMap(r.file)]]) {
                const b = document.createElement("button");
                b.className = "small";
                b.textContent = text;
                b.addEventListener("click", fn);
                links.append(b);
            }
            box.append(links);
        }
    } finally {
        $("mar-create").disabled = entries.length === 0;
    }
}

export function initMarathonTab() {
    $("mar-add-current").addEventListener("click", async () => add(await window.danApi.marathonAddCurrent()));
    $("mar-file").addEventListener("change", async (e) => {
        for (const file of e.target.files) add(await window.danApi.marathonAddFile(window.danApi.pathForFile(file)));
        e.target.value = "";
    });
    $("mar-create").addEventListener("click", create);
    for (const type of ["input", "change"]) $("mar-gap").addEventListener(type, redrawCurve);
    initMarathonAuto({ setEntries, onListChange, setPlan });
    render();
}
