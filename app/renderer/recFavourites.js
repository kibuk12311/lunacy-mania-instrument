// "Избранное": the maps marked ☆ (main keeps them in favourites.json), as compact cards with ✕ and «Похожие»,
// and their export as an osu!stable collection.db into the app's documents folder.
import { t, plural as pluralOf } from "../../src/i18n/i18n.js";
import { el, button, call, failText, compactCard, favourites, onFavourites, loadFavourites, removeFavourite } from "./recCard.js";
import { toggleSimilar } from "./recSimilar.js";

export const DEFAULT_COLLECTION_NAME = "Lunacy mania picks";

const mapsWord = (n) => pluralOf(n, {
    ru: [t("recommend.plan.map.one"), t("recommend.plan.map.few"), t("recommend.plan.map.many")],
    en: [t("recommend.plan.map.one"), t("recommend.plan.map.many")],
});

// "Готово: 42 карты, пропущено 1" — or without the skipped part when none was.
export function exportDoneText(r) {
    const count = Number(r?.count) || 0;
    const skipped = Number(r?.skipped) || 0;
    return skipped
        ? t("recommend.fav.doneSkipped", { n: count, maps: mapsWord(count), skipped })
        : t("recommend.fav.done", { n: count, maps: mapsWord(count) });
}

export const exportProgressText = (p) => t("recommend.fav.exportingN", { done: Number(p?.done) || 0, total: Number(p?.total) || 0 });

const $ = (id) => document.getElementById(id);
let shared = null; // { view(), saveView(patch), similarOptions() }
let exporting = false;

const status = (text) => { $("rec-fav-status").textContent = text; };
const visible = () => !$("rec-fav-pane").hidden;

function render(items) {
    if (!visible()) return;
    const list = Array.isArray(items) ? items : [];
    $("rec-fav-list").replaceChildren(...list.map((f) => compactCard(f, {
        status,
        onRemove: async (card) => {
            const r = await removeFavourite(card.beatmapId);
            if (!r?.ok) status(failText(r));
        },
        onSimilar: toggleSimilar,
        similarOptions: shared.similarOptions,
    })));
    if (!list.length) status(t("recommend.fav.empty"));
    else if ($("rec-fav-status").textContent === t("recommend.fav.empty")) status("");
    $("rec-fav-export").disabled = exporting || !list.length;
}

async function exportNow() {
    if (exporting) return;
    exporting = true;
    const go = $("rec-fav-export");
    go.disabled = true;
    go.textContent = t("recommend.fav.exporting");
    const box = $("rec-fav-result");
    box.hidden = true;
    const name = $("rec-fav-name").value;
    shared.saveView({ favName: name });
    const r = await call(() => window.danApi.recFavExport(name));
    exporting = false;
    go.textContent = t("recommend.html.favExport");
    go.disabled = !favourites().length;
    if (!r?.ok) {
        box.replaceChildren(el("div", "bad", failText(r)));
    } else {
        const links = el("div", "links");
        links.append(button(t("recommend.download.show"), t("recommend.fav.showTitle"), () => window.danApi.recShow(r.file)));
        box.replaceChildren(el("div", "ok", exportDoneText(r)), links);
    }
    box.hidden = false;
}

export function initFavourites(s) {
    shared = s;
    $("rec-fav-name").value = s.view().favName;
    $("rec-fav-name").addEventListener("change", () => s.saveView({ favName: $("rec-fav-name").value }));
    $("rec-fav-export").addEventListener("click", exportNow);
    window.danApi.onRecFavExportProgress?.((p) => { if (exporting) $("rec-fav-export").textContent = exportProgressText(p); });
    onFavourites(render);
}

// The pane came into view: what is known now, then a fresh list from main.
export function showFavourites() {
    render(favourites());
    return loadFavourites();
}
