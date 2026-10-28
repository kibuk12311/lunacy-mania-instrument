// "Several rates" on the rate tab: a range of rates, their dans counted in main one by one (rows fill as progress
// comes in), a click on a row puts that rate on the slider, and the checked rows become copies in one go.
import { t, plural } from "../../src/i18n/i18n.js";
import { sendButtons } from "./interlude.js";
// the analyser's main pattern in the General / Detailed mode shared by every tab (the rows follow it)
import { patternLabel, onPatternMode } from "./patternMode.js";
import { rateSteps } from "../../src/rate/rateSteps.js";

const $ = (id) => document.getElementById(id);
const COUNT = { ru: ["rate.batch.count.one", "rate.batch.count.few", "rate.batch.count.many"], en: ["rate.batch.count.one", "rate.batch.count.many"] };
const DONE = { ru: ["rate.batch.done.one", "rate.batch.done.few", "rate.batch.done.many"], en: ["rate.batch.done.one", "rate.batch.done.many"] };
const NO_DAN = { "too-short": "rate.batch.row.tooShort", error: "rate.batch.row.error" };

let ctx = null;
let rows = []; // { rate, checked, data: row from main | null, node, cells }
let token = 0; // a cleared table or a new job makes older answers stale
let state = { hasMap: false, running: false };
let stopMode = null;

const status = (text) => { $("rate-batch-status").textContent = text; };
const range = () => [$("rate-batch-from").value, $("rate-batch-to").value, $("rate-batch-step").value];

function cell(className) {
    const node = document.createElement("span");
    node.className = className;
    return node;
}

// What the dan column says for a row without a dan.
function noDanText(data) {
    if (data.kind === "not-rice") return data.reason === "ln" ? t("rate.batch.row.ln") : t("rate.batch.row.notRice");
    return t(NO_DAN[data.kind] ?? "rate.batch.row.error");
}

function paint(entry) {
    const { data, cells } = entry;
    const bpm = data?.bpm ?? (ctx.mapInfo()?.bpm ? Math.round(ctx.mapInfo().bpm * entry.rate) : null);
    cells.bpm.textContent = bpm ? `${bpm} BPM` : "";
    if (!data) {
        cells.dan.textContent = "…";
        cells.num.textContent = "";
        cells.dan.title = "";
    } else if (data.kind === "ok") {
        cells.dan.textContent = data.label ?? "";
        cells.num.textContent = Number.isFinite(data.numeric) ? data.numeric.toFixed(1) : "";
        cells.dan.title = [data.label, patternLabel(data.primary)].filter(Boolean).join(" · ");
    } else {
        cells.dan.textContent = noDanText(data);
        cells.num.textContent = "";
        cells.dan.title = ctx.describe(data, { rate: entry.rate, noLn: false });
    }
}

function rowNode(entry) {
    const node = document.createElement("div");
    node.className = "rate-row";
    node.title = t("rate.batch.rowTitle");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = entry.checked;
    box.addEventListener("click", (e) => e?.stopPropagation?.());
    box.addEventListener("change", () => {
        entry.checked = box.checked;
        syncBatch(state);
    });
    const rate = cell("rate-row-rate");
    rate.textContent = `×${entry.rate.toFixed(2)}`;
    entry.cells = { bpm: cell("rate-row-bpm"), dan: cell("rate-row-dan"), num: cell("rate-row-num") };
    node.append(box, rate, entry.cells.bpm, entry.cells.dan, entry.cells.num);
    node.addEventListener("click", (e) => {
        if (e?.target?.type === "checkbox") return;
        ctx.setRate(entry.rate);
    });
    entry.node = node;
    paint(entry);
    return node;
}

function render() {
    $("rate-batch-table").replaceChildren(...rows.map(rowNode));
    syncBatch(state);
}

// A row from main (progress or the final answer) into the table, in place.
function fill(data) {
    const entry = rows.find((e) => e.rate === data?.rate);
    if (!entry) return;
    entry.data = data;
    paint(entry);
}

function updateCount() {
    const steps = rateSteps(...range());
    $("rate-batch-count").textContent = steps.error ? t("rate.err.badSteps") : t(plural(steps.rates.length, COUNT), { n: steps.rates.length });
}

async function countDans() {
    const [from, to, step] = range();
    const steps = rateSteps(from, to, step);
    if (steps.error) {
        status(t("rate.err.badSteps"));
        return;
    }
    const mine = ++token;
    const { mirror, noLn } = ctx.getOptions();
    rows = steps.rates.map((rate) => ({ rate, checked: true, data: null }));
    render();
    status(t("rate.batch.counting", { index: 0, total: rows.length }));
    ctx.setJob("dans", true);
    try {
        let r;
        try {
            r = await (window.danApi.rateBatchDans?.({ from: Number(from), to: Number(to), step: Number(step), mirror, noLn })
                ?? Promise.resolve({ ok: false, message: "" }));
        } catch (error) {
            r = { ok: false, message: String(error?.message ?? error) };
        }
        if (mine !== token || (r?.key !== undefined && r.key !== ctx.currentKey())) return;
        if (!r?.ok) {
            status(t("rate.error", { message: r?.message ?? "" }));
            return;
        }
        for (const data of r.rows ?? []) fill(data);
        status(r.cancelled ? t("rate.batch.stopped") : "");
    } finally {
        ctx.setJob("dans", false);
    }
}

async function createChecked() {
    const rates = rows.filter((e) => e.checked).map((e) => e.rate);
    if (!rates.length) return;
    const mine = token;
    const { pitch, od, hp, mirror, noLn } = ctx.getOptions();
    status(t("rate.batch.progress", { index: 1, total: rates.length, rate: rates[0] }));
    ctx.setJob("create", true);
    try {
        let r;
        try {
            r = await (window.danApi.rateBatchCreate?.({ rates, pitch, od, hp, mirror, noLn }) ?? Promise.resolve({ ok: false, message: "" }));
        } catch (error) {
            r = { ok: false, message: String(error?.message ?? error) };
        }
        if (mine !== token) return;
        if (!r?.ok) {
            status(t("rate.error", { message: r?.message ?? "" }));
            return;
        }
        const made = r.made?.length ?? 0;
        const parts = [];
        if (made) {
            parts.push(r.client === "lazer"
                ? t(r.opened ? "rate.batch.lazerOpened" : "rate.batch.lazerNotOpened", { n: made, file: r.osz ?? "" })
                : r.client === "interlude" ? `${t(plural(made, DONE), { n: made })} ${r.sendMessage ?? ""}`.trim()
                    : t(plural(made, DONE), { n: made }));
        }
        // copies made in osu!'s Songs folder can go to Interlude too, all in one .osz
        const files = r.client ? [] : (r.made ?? []).map((m) => m.file).filter(Boolean);
        $("rate-batch-interlude").replaceChildren(...(files.length ? sendButtons(files) : []));
        for (const f of r.failed ?? []) parts.push(t("rate.batch.failed", { rate: f.rate, message: f.message }));
        if (r.cancelled) parts.push(t("rate.batch.stopped"));
        status(parts.join(" "));
    } finally {
        ctx.setJob("create", false);
    }
}

export function initRateBatch(context) {
    ctx = context;
    rows = [];
    token += 1;
    for (const id of ["rate-batch-from", "rate-batch-to", "rate-batch-step"]) {
        $(id).addEventListener("input", updateCount);
        $(id).addEventListener("change", updateCount);
    }
    $("rate-batch-dans").addEventListener("click", countDans);
    $("rate-batch-create").addEventListener("click", createChecked);
    $("rate-batch-stop").addEventListener("click", () => window.danApi.rateCancel?.());
    updateCount();
    render();
    status("");
    // the General / Detailed switch is shared by every tab: the rows' tooltips name the pattern in its mode
    stopMode?.();
    stopMode = onPatternMode(() => rows.forEach((e) => e.cells && paint(e)));
}

// Progress of this tab's batch jobs (the key is checked by rateTab.js).
export function batchProgress(p) {
    if (p.job === "dans") {
        if (p.row) fill(p.row);
        status(t("rate.batch.counting", { index: p.index, total: p.total }));
    } else if (p.job === "create") {
        status(t("rate.batch.progress", { index: p.index, total: p.total, rate: p.rate }));
    }
}

// Another map or other chart options: the table and its result go.
export function clearBatch() {
    token += 1;
    rows = [];
    render();
    status("");
}

// The slider's rate is marked in the table.
export function markBatchRate(rate) {
    for (const e of rows) e.node?.classList.toggle("sel", e.rate === rate);
}

export function syncBatch(next) {
    state = next;
    const checked = rows.filter((e) => e.checked).length;
    const idle = state.hasMap && !state.running;
    $("rate-batch-dans").disabled = !idle;
    // an original rebuilt from a rate map makes no copies (rateTab.js)
    $("rate-batch-create").disabled = !idle || !checked || state.canCreate === false;
    $("rate-batch-create").textContent = t("rate.batch.create", { n: checked });
    $("rate-batch-stop").hidden = !state.running;
}
