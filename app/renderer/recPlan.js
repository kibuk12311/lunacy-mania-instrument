// "План": 5 or 6 maps from warm-up to challenge, over 1–3 patterns in turn; ↻ swaps a slot's card for the next
// candidate, and the buttons below download them all, add them all to the favourites or fit a rate for each.
import { patternById, recPatternsFor, patternIdsInMode } from "../../src/recommend/catalog.js";
import { isDetailed, onPatternMode, createPatternModeSwitch } from "./patternMode.js";
import { mmss } from "../../src/recommend/format.js";
import { labelBeside } from "../../src/core/labels.js";
import { t, plural as pluralOf } from "../../src/i18n/i18n.js";
import { el, call, failText, fix2, cardElement, isFavourite, addFavourite } from "./recCard.js";
import { toggleSimilar } from "./recSimilar.js";
import { exportButton } from "./interlude.js";

export const PLAN_SIZES = [5, 6];
export const MAX_PLAN_PATTERNS = 3;
const ROLE_KEYS = { warmup: "recommend.plan.role.warmup", growth: "recommend.plan.role.growth", challenge: "recommend.plan.role.challenge" };

const mapsWord = (n) => pluralOf(n, {
    ru: [t("recommend.plan.map.one"), t("recommend.plan.map.few"), t("recommend.plan.map.many")],
    en: [t("recommend.plan.map.one"), t("recommend.plan.map.many")],
});

// A pattern chip pressed: on → added at the end (a fourth pushes out the first), off → removed, but never the last one.
export function togglePattern(list, id, max = MAX_PLAN_PATTERNS) {
    if (!patternById(id)) return list;
    if (list.includes(id)) return list.length > 1 ? list.filter((x) => x !== id) : list;
    return [...list, id].slice(-max);
}

// The view's plan settings and the picks' filters → the rec-plan request; in the General mode (patternMode.js) a
// remembered kind (quadstream …) asks for its parent.
// manualProfile: the hand-set profile (src/recommend/manualProfile.js) the manual source plans for.
export function planRequest(view, settings, manualProfile, { detailed = isDetailed() } = {}) {
    const manual = settings.source === "manual";
    return {
        size: view.planSize,
        patternIds: patternIdsInMode(view.planPatterns, detailed),
        lengthId: settings.lengthId,
        rankedOnly: Boolean(settings.rankedOnly),
        manual,
        manualDan: null,
        ...(manual ? { manualProfile } : {}),
    };
}

// "План: Stamina Gamma mid/high (13.26) · 5 карт · ≈ 17:20"
export function planHeaderText(header, count, totalSec) {
    // the dan's number follows in brackets, so "above Kappa" does not repeat it
    const label = labelBeside(header.playerDan, header.label);
    const own = header.tile ? `${header.tile} ${label}` : label;
    // a hand-set profile says so
    const who = header.handSet ? `${own} (${t("recommend.manual.tag")})` : own;
    return t("recommend.plan.header", { who, dan: fix2(header.playerDan), n: count, maps: mapsWord(count), time: mmss(totalSec) });
}

export const roleText = (role) => t(ROLE_KEYS[role] ?? "recommend.plan.role.growth");

const $ = (id) => document.getElementById(id);
let shared = null; // { settings(), view(), saveView(patch), ensurePlayer(), manualProfile(), similarOptions() }
let plan = null; // the last rec-plan answer, with swapped cards put in
let nodes = []; // the slot elements, in slot order
let token = 0;
let busy = false;

const status = (text) => { $("rec-plan-status").textContent = text; };

function lock(on) {
    busy = on;
    for (const id of ["rec-plan-go", "rec-plan-download", "rec-plan-fav", "rec-plan-rates"]) $(id).disabled = on;
}

function renderSize() {
    const box = $("rec-plan-size");
    box.replaceChildren(...PLAN_SIZES.map((size) => {
        const chip = el("span", size === shared.view().planSize ? "sel" : "", String(size));
        chip.addEventListener("click", () => {
            shared.saveView({ planSize: size });
            renderSize();
        });
        return chip;
    }));
}

// The chips in the General / Detailed mode: in General a remembered kind shows as its parent, and a click there
// saves the list as General sees it.
function renderPatterns() {
    const box = $("rec-plan-patterns");
    const detailed = isDetailed();
    const chosen = patternIdsInMode(shared.view().planPatterns, detailed);
    box.replaceChildren(...recPatternsFor(detailed).map((p) => {
        const at = chosen.indexOf(p.id);
        // the number shows the order the slots take them in
        const chip = el("span", at >= 0 ? "sel" : "", at >= 0 && chosen.length > 1 ? `${at + 1}. ${p.name}` : p.name);
        chip.addEventListener("click", () => {
            shared.saveView({ planPatterns: togglePattern(patternIdsInMode(shared.view().planPatterns, isDetailed()), p.id) });
            renderPatterns();
        });
        return chip;
    }));
}

const cards = () => (plan?.slots ?? []).map((s) => s.card).filter(Boolean);

function renderHead() {
    const list = cards();
    const total = list.reduce((sum, c) => sum + (Number(c.lengthSec) || 0), 0);
    $("rec-plan-head").textContent = planHeaderText(plan.header, list.length, total);
    $("rec-plan-head").hidden = false;
    $("rec-plan-actions").hidden = list.length === 0;
}

function slotElement(slot, i) {
    const role = roleText(slot.role);
    if (!slot.card) {
        const empty = el("div", "rec-card rec-empty");
        const body = el("div", "rec-body");
        const meta = el("div", "rec-meta");
        meta.append(el("span", `rec-role rec-role-${slot.role}`, role));
        body.append(meta, el("div", "muted", t("recommend.plan.emptySlot")));
        empty.append(el("div", "rec-thumb"), body);
        return empty;
    }
    return cardElement(slot.card, {
        target: { center: slot.center },
        patternName: patternById(slot.patternId)?.name ?? "",
        status,
        onSimilar: toggleSimilar,
        similarOptions: shared.similarOptions,
        role,
        roleId: slot.role,
        onSwap: () => swap(i),
    });
}

function renderPlan() {
    nodes = plan.slots.map(slotElement);
    $("rec-plan-list").replaceChildren(...nodes);
    renderHead();
}

async function build() {
    if (busy) return;
    const settings = shared.settings();
    if (settings.source !== "manual" && !(await shared.ensurePlayer())) return;
    const run = ++token;
    lock(true);
    status(t("recommend.plan.building"));
    $("rec-plan-list").replaceChildren();
    $("rec-plan-head").hidden = true;
    $("rec-plan-actions").hidden = true;
    plan = null;
    const r = await call(() => window.danApi.recPlan(planRequest(shared.view(), settings, shared.manualProfile())));
    lock(false);
    if (run !== token) return;
    if (!r?.ok) return status(failText(r));
    plan = r;
    renderPlan();
    const empty = r.slots.filter((s) => !s.card).length;
    if (empty === r.slots.length) status(t("recommend.plan.nothing"));
    else if (empty) status(t("recommend.plan.someEmpty"));
    else status(r.playedPartial ? t("recommend.status.playedPartial") : "");
}

async function swap(i) {
    const run = token;
    const r = await call(() => window.danApi.recPlanSwap(i));
    if (run !== token || !plan) return;
    if (!r?.ok) return status(failText(r));
    if (!r.card) return status(t("recommend.plan.noOther"));
    plan.slots[i] = { ...plan.slots[i], card: r.card };
    nodes[i] = slotElement(plan.slots[i], i);
    $("rec-plan-list").replaceChildren(...nodes);
    renderHead();
    status("");
}

// One after another, each through its own card (the card shows its progress and result).
async function eachCard(progressKey, fn) {
    const run = token;
    const list = nodes.filter((node) => node.actions);
    lock(true);
    let done = 0;
    for (const [k, node] of list.entries()) {
        if (run !== token) break;
        status(t(progressKey, { i: k + 1, n: list.length }));
        if ((await fn(node))?.ok) done += 1;
    }
    lock(false);
    return { done, total: list.length };
}

async function downloadAll() {
    const { done, total } = await eachCard("recommend.plan.downloading", (node) => node.actions.download());
    status(t("recommend.plan.downloaded", { done, total }));
}

async function ratesForPlan() {
    await eachCard("recommend.plan.rating", (node) => node.actions.ours());
    status("");
}

async function allToFavourites() {
    const run = token;
    lock(true);
    let added = 0;
    for (const card of cards()) {
        if (run !== token) break;
        if (isFavourite(card.beatmapId)) continue;
        const r = await addFavourite(card);
        if (!r?.ok) {
            lock(false);
            return status(failText(r));
        }
        added += 1;
    }
    lock(false);
    status(t("recommend.plan.favDone", { n: added }));
}

export function initPlan(s) {
    shared = s;
    renderSize();
    $("rec-plan-pattern-mode").replaceChildren(createPatternModeSwitch());
    renderPatterns();
    onPatternMode(renderPatterns);
    $("rec-plan-go").addEventListener("click", build);
    $("rec-plan-download").addEventListener("click", downloadAll);
    $("rec-plan-fav").addEventListener("click", allToFavourites);
    $("rec-plan-rates").addEventListener("click", ratesForPlan);
    // the plan as a playlist in Interlude, in its order (maps it has in its library)
    $("rec-plan-interlude").replaceChildren(exportButton(() => ({
        name: t("interlude.export.planName"),
        items: cards().map((c) => ({ beatmapId: c.beatmapId, label: `${c.artist} - ${c.title} [${c.version}]` })),
    })));
}
