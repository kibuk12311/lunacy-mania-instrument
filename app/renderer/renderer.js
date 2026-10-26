import "./lang.js";
import { applyI18n, getLang, t } from "../../src/i18n/i18n.js";
import { renderView, CALCS } from "./view.js";
import { initCreateTab } from "./createTab.js";
import { initRateTab, onRateTabShown, openRateAt } from "./rateTab.js";
import { initMarathonTab } from "./marathonTab.js";
import { initRecommendTab, onRecommendTabShown } from "./recommendTab.js";
import { initAnalysisPanel, analysisPanelHtml } from "./analysisPanel.js";
import { initOverlayPanel } from "./overlayPanel.js";

const TABS = ["analysis", "rate", "marathon", "recommend", "create"];

const card = document.getElementById("card");
const pin = document.getElementById("pin");
const compactButton = document.getElementById("compact");
applyI18n(document);
// starting values of text fields (the marathon title) come in the current language too
for (const node of document.querySelectorAll("[data-i18n-value]")) node.value = t(node.dataset.i18nValue);
document.documentElement.lang = getLang();
const langButton = document.getElementById("lang");
langButton.textContent = getLang().toUpperCase();
langButton.addEventListener("click", () => window.danApi.setLang(getLang() === "ru" ? "en" : "ru"));

const calcSelect = document.getElementById("calc");
let settings = { alwaysOnTop: false, compact: false };
let view = { screen: "waiting-osu" };
let osuClient = null; // "stable" | "lazer" | null: which osu! tosu reads
const clientBadge = document.getElementById("osu-client");

// The calculator the card leads with lives in this window only.
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
    const opts = { ...settings, calc, client: osuClient };
    card.innerHTML = renderView(view, opts) + analysisPanelHtml(view, opts);
    clientBadge.hidden = !osuClient;
    clientBadge.className = `osu-client${osuClient === "lazer" ? " lazer" : ""}`;
    clientBadge.textContent = !osuClient ? "" : osuClient === "lazer" ? t("analysis.client.lazer") : t("analysis.client.stable");
    clientBadge.title = osuClient ? t("analysis.client.title", { client: osuClient }) : "";
    document.body.classList.toggle("compact", settings.compact);
    pin.classList.toggle("on", settings.alwaysOnTop);
    compactButton.classList.toggle("on", settings.compact);
}

function showTab(tab) {
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
    document.getElementById("analysis-tab").hidden = tab !== "analysis";
    document.getElementById("create-tab").hidden = tab !== "create";
    document.getElementById("rate-tab").hidden = tab !== "rate";
    document.getElementById("marathon-tab").hidden = tab !== "marathon";
    document.getElementById("recommend-tab").hidden = tab !== "recommend";
    document.body.classList.toggle("creating", tab !== "analysis");
    window.danApi.setTab(tab === "analysis" ? "analysis" : "create");
    if (tab === "rate") onRateTabShown();
    if (tab === "recommend") onRecommendTabShown();
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
pin.addEventListener("click", () => window.danApi.toggleAlwaysOnTop());
compactButton.addEventListener("click", () => window.danApi.toggleCompact());
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
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
initAnalysisPanel({ card, redraw: draw });
initOverlayPanel({ button: document.getElementById("overlay-toggle"), panel: document.getElementById("overlay-panel") });
draw();
