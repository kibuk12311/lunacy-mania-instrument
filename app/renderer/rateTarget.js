// "Rate for a dan" on the rate tab: pick a dan, main searches the rate that reaches it (src/rate/rateForDan.js) and
// the slider moves there. Until the dan is picked by hand the picker follows the dan the preview shows.
import { t, plural } from "../../src/i18n/i18n.js";
import { fillDanSelects, readDanSelects } from "./danSelect.js";

const $ = (id) => document.getElementById(id);
const TRIED = { ru: ["rate.target.tried.one", "rate.target.tried.few", "rate.target.tried.many"], en: ["rate.target.tried.one", "rate.target.tried.many"] };

let ctx = null;
let picked = false; // the dan was chosen by hand: previews no longer move the picker
let searching = 0; // number of the search on its way, 0 when none
let searches = 0;

const status = (text) => { $("rate-target-status").textContent = text; };
const fixed = (n) => (Number.isFinite(n) ? n.toFixed(1) : "—");

// "Gamma mid": the picker's level name and step as shown.
function pickedLabel() {
    const level = $("rate-target-level");
    const name = [...level.children].find((o) => o.value === level.value)?.textContent ?? "";
    return `${name} ${$("rate-target-step").value}`.trim();
}

function answerText(r, label, noLn) {
    if (!r?.ok) {
        if (r?.reason === "base-failed" && r.result) return ctx.describe(r.result, { rate: 1, noLn });
        return t("rate.target.failed", { message: r?.message ?? "" });
    }
    if (r.reason === "above-range") return t("rate.target.above", { rate: r.rate, label: r.label });
    if (r.reason === "below-range") return t("rate.target.below", { rate: r.rate, label: r.label });
    const n = r.tries?.length ?? 0;
    const params = { label, rate: r.rate, numeric: fixed(r.numeric), tried: t(plural(n, TRIED), { n }) };
    return r.reason === "hit" ? t("rate.target.found", params) : t("rate.target.closest", params);
}

async function find() {
    const target = readDanSelects($("rate-target-level"), $("rate-target-step"));
    if (target === null || searching) return;
    const label = pickedLabel();
    const { mirror, noLn } = ctx.getOptions();
    const key = ctx.currentKey();
    const token = ++searches;
    searching = token;
    status(t("rate.target.start"));
    ctx.setJob("target", true);
    try {
        let r;
        try {
            r = await (window.danApi.rateTarget?.({ target, mirror, noLn }) ?? Promise.resolve({ ok: false, message: "" }));
        } catch (error) {
            r = { ok: false, message: String(error?.message ?? error) };
        }
        // the map or the options changed meanwhile: this answer is for something else
        if (searching !== token || ctx.currentKey() !== key || (r?.key !== undefined && r.key !== key)) return;
        status(answerText(r, label, noLn));
        if (r?.ok) ctx.setRate(r.rate);
    } finally {
        if (searching === token) searching = 0;
        ctx.setJob("target", false);
    }
}

export function initRateTarget(context) {
    ctx = context;
    picked = false;
    searching = 0;
    fillDanSelects($("rate-target-level"), $("rate-target-step"), NaN);
    for (const id of ["rate-target-level", "rate-target-step"]) $(id).addEventListener("change", () => { picked = true; });
    $("rate-target-find").addEventListener("click", find);
    status("");
}

// A dan the preview showed: the picker moves to it while the user has not picked one.
export function targetPreviewed(numeric) {
    if (!picked && Number.isFinite(numeric)) fillDanSelects($("rate-target-level"), $("rate-target-step"), numeric);
}

// One try of the search in main.
export function targetProgress(p) {
    if (!searching) return;
    status(t("rate.target.searching", { rate: p.rate, numeric: fixed(p.numeric) }));
}

// The map or the chart options changed: the old answer goes; a new map also lets the picker follow again.
export function resetTarget({ keepPick = true } = {}) {
    searching = 0;
    if (!keepPick) picked = false;
    status("");
}

export function syncTarget({ hasMap, running }) {
    $("rate-target-find").disabled = !hasMap || running;
}
