import "./lang.js";
import { applyI18n, getLang, t } from "../../src/i18n/i18n.js";
import { renderView, CALCS } from "./view.js";
import { initCreateTab } from "./createTab.js";
import { initRateTab, onRateTabShown, openRateAt } from "./rateTab.js";
import { initMarathonTab } from "./marathonTab.js";
import { initRecommendTab, onRecommendTabShown } from "./recommendTab.js";
import { initAnalysisPanel, analysisPanelHtml } from "./analysisPanel.js";
import { initOverlayPanel } from "./overlayPanel.js";
import { initInterludeState, onInterludeState } from "./interlude.js";
import { initInterludePanel } from "./interludePanel.js";
import { initProfileTab, onProfileTabShown } from "./profileTab.js";
import { initSkinTab } from "./skinTab.js";
import { initSettingsPage } from "./settingsPage.js";

const TABS = ["analysis", "rate", "marathon", "recommend", "profile", "create", "skin"];

const card = document.getElementById("card");
applyI18n(document);
// starting values of text fields (the marathon title) come in the current language too
for (const node of document.querySelectorAll("[data-i18n-value]")) node.value = t(node.dataset.i18nValue);
document.documentElement.lang = getLang();

const calcSelect = document.getElementById("calc");
let settings = { alwaysOnTop: false };
let view = { screen: "waiting-osu" };
let osuClient = null; // "stable" | "lazer" | null: which osu! tosu reads
let interludeChart = null; // the Interlude chart on the card (its name), while it is there
let interludeLinked = false; // an Interlude folder is linked
let interludeLive = null; // what main says of following Interlude live: { state: { status, onCard, … }, text }
const clientBadge = document.getElementById("osu-client");

// The calculator the card leads with lives in this window only (its select is on the Settings page).
const CALC_KEY = "analysis-calc";
let calc = "ours";
try {
    const saved = localStorage.getItem(CALC_KEY);
    if (CALCS.some((c) => c.id === saved)) calc = saved;
} catch {
    // storage unavailable: start with ours
}
calcSelect.replaceChildren(...CALCS.map((c) => {
    const option = new Option(c.name, c.id, false, c.id === calc);
    if (c.hint) option.title = c.hint;
    return option;
}));
calcSelect.addEventListener("change", () => {
    calc = calcSelect.value;
    try {
        localStorage.setItem(CALC_KEY, calc);
    } catch {
        // not remembered, still applied
    }
    draw();
});

function draw() {
    const opts = { ...settings, calc, client: osuClient, interlude: interludeLinked };
    card.innerHTML = renderView(view, opts) + analysisPanelHtml(view, opts);
    // Interlude followed live and its chart on the card (or no osu! there): «Interlude · live»
    const live = interludeLive?.state?.status === "attached";
    if (live && (interludeLive.state.onCard || interludeChart || !osuClient)) {
        clientBadge.hidden = false;
        clientBadge.className = "osu-client interlude live";
        clientBadge.textContent = t("interlude.badge.live");
        clientBadge.title = t("interlude.badge.liveTitle", { text: interludeLive.text ?? "" });
    } else if (interludeChart) {
        // a chart picked from Interlude's library is on the card: its badge, not osu!'s
        clientBadge.hidden = false;
        clientBadge.className = "osu-client interlude";
        clientBadge.textContent = t("interlude.badge.chart");
        clientBadge.title = t("interlude.badge.chartTitle", { name: interludeChart });
    } else {
        clientBadge.hidden = !osuClient;
        clientBadge.className = `osu-client${osuClient === "lazer" ? " lazer" : ""}`;
        clientBadge.textContent = !osuClient ? "" : osuClient === "lazer" ? t("analysis.client.lazer") : t("analysis.client.stable");
        clientBadge.title = osuClient ? t("analysis.client.title", { client: osuClient }) : "";
    }
}

function showTab(tab) {
    for (const b of document.querySelectorAll(".tabs button[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
    document.getElementById("analysis-tab").hidden = tab !== "analysis";
    document.getElementById("create-tab").hidden = tab !== "create";
    document.getElementById("rate-tab").hidden = tab !== "rate";
    document.getElementById("marathon-tab").hidden = tab !== "marathon";
    document.getElementById("recommend-tab").hidden = tab !== "recommend";
    document.getElementById("profile-tab").hidden = tab !== "profile";
    document.getElementById("skin-tab").hidden = tab !== "skin";
    document.body.classList.toggle("creating", tab !== "analysis");
    window.danApi.setTab(tab === "analysis" ? "analysis" : "create");
    if (tab === "rate") onRateTabShown();
    if (tab === "recommend") onRecommendTabShown();
    if (tab === "profile") onProfileTabShown();
    // any tab can follow which one is showing (the create tab's player pauses on the others)
    window.dispatchEvent(new CustomEvent("tab-shown", { detail: tab }));
}

window.danApi.onView((v) => {
    view = v;
    draw();
    // a new map picked in osu! while the rate tab is open: follow it
    if (v.screen === "result" && !document.getElementById("rate-tab").hidden) onRateTabShown();
});
window.danApi.onSettings((s) => { settings = s; draw(); });
// the other tabs follow it too (the rate tab words its copies for lazer)
window.danApi.onOsuClient?.((p) => {
    osuClient = p?.client === "stable" || p?.client === "lazer" ? p.client : null;
    draw();
    window.dispatchEvent(new CustomEvent("osu-client", { detail: osuClient }));
});
// a tab closes the Settings page if it is open; ⚙ at the end of the bar opens and closes it
for (const b of document.querySelectorAll(".tabs button[data-tab]")) b.addEventListener("click", () => { settingsView?.close(); showTab(b.dataset.tab); });
// One tab opens another: open-tab { tab }, open-rate { rate } (the rate tab at that rate).
window.addEventListener("open-tab", (e) => { if (TABS.includes(e.detail?.tab)) showTab(e.detail.tab); });
window.addEventListener("open-rate", (e) => {
    const rate = e.detail?.rate;
    if (typeof rate !== "number" || !(rate >= 0.5 && rate <= 2)) return;
    openRateAt(rate);
    showTab("rate");
});
// A file dropped outside the drop zone must not make the window navigate to it.
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());

initCreateTab();
initRateTab();
initMarathonTab();
initRecommendTab();
initProfileTab();
initSkinTab();
initAnalysisPanel({ card, redraw: draw });
initOverlayPanel({ panel: document.getElementById("overlay-panel") });
initInterludeState();
window.danApi.onInterludeLive?.((info) => {
    if (!info?.ok) return;
    interludeLive = info;
    draw();
});
window.danApi.interludeLiveGet?.().then((info) => { if (info?.ok) { interludeLive = info; draw(); } }, () => {});

// the Settings page holds the overlay's and Interlude's blocks; the IL button under the card opens it at the library
const settingsPage = document.getElementById("settings-page");
const interludeBlock = initInterludePanel({
    button: document.getElementById("interlude-toggle"), panel: document.getElementById("interlude-panel"),
    onOpen: () => settingsView?.open("interlude"), visible: () => !settingsPage.hidden,
});
const settingsView = initSettingsPage({
    page: settingsPage, openButton: document.getElementById("settings-open"), tabButton: document.getElementById("settings-tab"), interlude: interludeBlock,
});
onInterludeState((s) => {
    const next = s?.selected ?? null;
    const linked = Boolean(s?.linked);
    if (next === interludeChart && linked === interludeLinked) return;
    const chartChanged = next !== interludeChart;
    interludeChart = next;
    interludeLinked = linked;
    draw();
    if (!chartChanged) return;
    // the rate tab follows the chart picked in Interlude's library as it follows osu!'s
    if (!document.getElementById("rate-tab").hidden) onRateTabShown();
});
draw();
