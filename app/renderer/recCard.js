// Cards of the picks tab: the full card (picks, plan) and the compact one (similar maps, favourites), their text helpers,
// and the favourites the ☆ buttons follow. recommendTab.js re-exports the text helpers it always had.
import { mmss, signed, shortNumber } from "../../src/recommend/format.js";
import { t, plural as pluralOf } from "../../src/i18n/i18n.js";
// the analyser's main pattern in the General / Detailed mode shared by every tab (redrawOurs follows it)
import { patternLabel } from "./patternMode.js";

const COVER_HOST = "https://assets.ppy.sh/";

// 1 игра, 2–4 игры, 5–20 игр, 21 игра … (the Russian forms; in English one → forms[0], anything else → forms[2])
export const plural = (n, [one, few, many]) => pluralOf(n, { ru: [one, few, many], en: [one, many] });

// "play" / "plays" word for n in the current language.
export const playsWord = (n) => pluralOf(n, {
    ru: [t("recommend.play.one"), t("recommend.play.few"), t("recommend.play.many")],
    en: [t("recommend.play.one"), t("recommend.play.many")],
});

export const rateText = (rate) => `${Math.round(rate * 100) / 100}x`;

export const fix2 = (x) => Number(x).toFixed(2);

function playsText(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    return `${shortNumber(v)} ${v < 1000 ? playsWord(v) : t("recommend.play.many")}`;
}

// Pieces of the card's meta line; parts with missing data are left out.
export function metaParts(card) {
    const parts = [{ text: card.danLabel, cls: "rec-dan" }];
    if (Number.isFinite(card.delta)) parts.push({ text: signed(card.delta), cls: "rec-delta" });
    if (Number.isFinite(card.stars)) parts.push({ text: `${card.stars.toFixed(1)}★` });
    if (Number.isFinite(card.bpm)) parts.push({ text: `${Math.round(card.bpm)} BPM` });
    if (Number.isFinite(card.lengthSec)) parts.push({ text: mmss(card.lengthSec) });
    if (card.status) parts.push({ text: card.status });
    parts.push({ text: playsText(card.playCount) });
    return parts;
}

// The compact card's meta line: dan, BPM, length and an extra word (how similar it is).
export function compactParts(card, extra = null) {
    const parts = [{ text: card.danLabel, cls: "rec-dan" }];
    if (Number.isFinite(card.bpm)) parts.push({ text: `${Math.round(card.bpm)} BPM` });
    if (Number.isFinite(card.lengthSec)) parts.push({ text: mmss(card.lengthSec) });
    if (extra) parts.push({ text: extra, cls: "rec-sim" });
    return parts;
}

function playedText(played) {
    const acc = Number(played.accuracy);
    if (!Number.isFinite(acc)) return t("recommend.played");
    const pct = (acc <= 1 ? acc * 100 : acc).toFixed(1);
    const rate = Number(played.rate);
    return Number.isFinite(rate) && Math.abs(rate - 1) > 1e-6
        ? t("recommend.played.accRate", { acc: pct, rate: rateText(rate) })
        : t("recommend.played.acc", { acc: pct });
}

export function whyText(card, patternName) {
    const parts = [patternName, card.purityLabel];
    if (Number.isFinite(card.msd)) parts.push(`MSD ${card.msd.toFixed(1)}`);
    if (card.played) parts.push(playedText(card.played));
    else if (card.setPlayed) parts.push(t("recommend.played.set"));
    return parts.filter(Boolean).join(" · ");
}

// The «Наш анализ» boxes on screen with their answers, so the pattern name follows the General / Detailed switch.
const oursShown = new Map(); // node → result

function showOurs(node, result) {
    for (const old of oursShown.keys()) if (old.isConnected === false) oursShown.delete(old);
    node.replaceChildren(...oursLines(result).map((line) => el("div", line.cls, line.text)));
    oursShown.set(node, result);
}

// Draws every «Наш анализ» box again in the current pattern mode (recommendTab.js calls it on onPatternMode).
export function redrawOurs() {
    for (const [node, result] of oursShown) {
        if (node.isConnected === false) oursShown.delete(node);
        else node.replaceChildren(...oursLines(result).map((line) => el("div", line.cls, line.text)));
    }
}

// Lines under a card after "Наш анализ".
export function oursLines(result) {
    if (!result?.ok) return [{ text: result?.message || t("recommend.ours.failed"), cls: "bad" }];
    const ours = result.ours ?? {};
    const lines = [{ text: t("recommend.ours.main", { result: [ours.label, patternLabel(ours.primary)].filter(Boolean).join(" · ") }), cls: "rec-ours-main" }];
    if (result.reason === "in-target") {
        lines.push({ text: t("recommend.ours.inTarget"), cls: "ok" });
    } else if (Number.isFinite(result.rate)) {
        const label = result.rateLabel ? ` (≈ ${result.rateLabel})` : "";
        const edge = result.reason === "out-of-range" ? ` (${t("recommend.ours.edge")})` : "";
        lines.push({ text: t("recommend.ours.rate", { rate: rateText(result.rate), label, edge }), cls: edge ? "warn" : "ok" });
    } else {
        lines.push({ text: t("recommend.ours.noRate"), cls: "warn" });
    }
    return lines;
}

// The button stays usable while there is something left to retry: an error, or our dan without a rate.
export const oursDone = (result) => Boolean(result?.ok && (Number.isFinite(result.rate) || result.reason));

// Button text while an .osz comes in.
export function progressText(p) {
    const received = Number(p?.received) || 0;
    const total = Number(p?.total) || 0;
    if (total > 0) return t("recommend.download.progressPct", { pct: Math.min(100, Math.floor((received / total) * 100)) });
    if (received > 0) return t("recommend.download.progressMb", { mb: (received / 1048576).toFixed(1) });
    return t("recommend.download.progress");
}

// The line under a card after «Скачать».
export function downloadLine(r) {
    if (!r?.ok) return { text: r?.message || t("recommend.download.failed"), cls: "bad" };
    if (!r.opened) return { text: r.message || t("recommend.download.notOpened"), cls: "warn" };
    return r.reused
        ? { text: t("recommend.download.reused"), cls: "ok" }
        : { text: t("recommend.download.opened"), cls: "ok" };
}

// ---- DOM helpers ----

export function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function button(text, title, onClick) {
    const b = el("button", "small", text);
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
}

export async function call(fn) {
    try {
        return await fn();
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

export const failText = (r) => t("recommend.status.error", { message: r?.message || t("recommend.status.noAnswer") });

const downloadWatchers = new Map(); // beatmapsetId → progress callback of its card
export const onDownloadProgress = (event) => downloadWatchers.get(event?.beatmapsetId)?.(event);

// ---- favourites the ☆ buttons follow (the list itself lives in main) ----

let favItems = [];
let favIds = new Set();
const favListeners = new Set();
const stars = new Set(); // { id, node } of every ☆ on screen

function paintStar(node, on) {
    node.textContent = on ? "★" : "☆";
    node.title = t(on ? "recommend.fav.in" : "recommend.fav.add");
    node.classList.toggle("on", on);
}

export function setFavourites(items) {
    favItems = Array.isArray(items) ? items : [];
    favIds = new Set(favItems.map((f) => f.beatmapId));
    for (const star of [...stars]) {
        if (star.node.isConnected === false) stars.delete(star);
        else paintStar(star.node, favIds.has(star.id));
    }
    for (const cb of [...favListeners]) {
        try {
            cb(favItems);
        } catch {
            // one view's mistake must not stop the others
        }
    }
}

export const favourites = () => favItems;
export const isFavourite = (beatmapId) => favIds.has(beatmapId);
export function onFavourites(cb) {
    favListeners.add(cb);
    return () => { favListeners.delete(cb); };
}

export async function loadFavourites() {
    const r = await call(() => window.danApi.recFavList?.() ?? Promise.resolve({ ok: false }));
    if (r?.ok) setFavourites(r.items);
    return r;
}

export async function addFavourite(card) {
    const r = await call(() => window.danApi.recFavAdd(card));
    if (r?.ok) setFavourites(r.items);
    return r;
}

export async function removeFavourite(beatmapId) {
    const r = await call(() => window.danApi.recFavRemove(beatmapId));
    if (r?.ok) setFavourites(r.items);
    return r;
}

function starButton(card, status) {
    const node = button("☆", "", async () => {
        node.disabled = true;
        const r = isFavourite(card.beatmapId) ? await removeFavourite(card.beatmapId) : await addFavourite(card);
        node.disabled = false;
        if (!r?.ok) status?.(failText(r));
    });
    node.classList.add("rec-star");
    paintStar(node, isFavourite(card.beatmapId));
    stars.add({ id: card.beatmapId, node });
    return node;
}

// ---- buttons every card has ----

async function openIn(kind, beatmapId, status) {
    const r = await call(() => window.danApi.recOpen(kind, beatmapId));
    if (!r?.ok) status?.(failText(r));
}

// «Скачать»: the .osz from a mirror, opened in osu!; the result line goes into `line`. Returns the button and its action.
function downloadButton(card, line) {
    const run = async () => {
        if (node.disabled) return null;
        node.disabled = true;
        node.textContent = progressText(null);
        downloadWatchers.set(card.beatmapsetId, (p) => { node.textContent = progressText(p); });
        const r = await call(() => window.danApi.recDownload({ beatmapsetId: card.beatmapsetId, beatmapId: card.beatmapId, artist: card.artist, title: card.title }));
        downloadWatchers.delete(card.beatmapsetId);
        node.disabled = false;
        node.textContent = t(r?.ok ? "recommend.download.done" : "recommend.download.button");
        const result = downloadLine(r);
        line.replaceChildren(el("div", result.cls, result.text));
        if (r?.ok && r.file) line.append(button(t("recommend.download.show"), t("recommend.download.showTitle"), () => window.danApi.recShow(r.file)));
        line.hidden = false;
        return r;
    };
    const node = button(t("recommend.download.button"), t("recommend.download.buttonTitle"), run);
    node.classList.add("accent");
    return { node, run };
}

function similarButton(card, holder, ctx) {
    return button(t("recommend.similar.button"), t("recommend.similar.buttonTitle"), () => ctx.onSimilar(card, holder, ctx));
}

function coverOf(card) {
    const thumb = el("div", "rec-thumb");
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => { img.hidden = true; });
    if (typeof card.cover === "string" && card.cover.startsWith(COVER_HOST)) img.src = card.cover;
    else img.hidden = true;
    thumb.append(img);
    return thumb;
}

function titleLines(card) {
    const title = el("div", "rec-title", `${card.artist} — ${card.title}`);
    title.title = title.textContent;
    // tracker versions already carry their brackets: "[4K] Extra"
    const sub = el("div", "rec-sub", `${card.version} · ${card.creator}`);
    sub.title = sub.textContent;
    return [title, sub];
}

// ctx: { target (its center is what «Наш анализ» aims at), patternName, status(text), onSimilar(card, holder, ctx),
//        role (a badge, in the plan), onSwap() (the plan's «↻ Другая») }.
// The element carries its actions: root.actions.download() and root.actions.ours(), for the plan's buttons below the list.
export function cardElement(card, ctx) {
    const root = el("div", card.played ? "rec-card played" : "rec-card");
    const body = el("div", "rec-body");
    const [title, sub] = titleLines(card);
    const meta = el("div", "rec-meta");
    if (ctx.role) meta.append(el("span", `rec-role rec-role-${ctx.roleId ?? "growth"}`, ctx.role));
    for (const part of metaParts(card)) meta.append(el("span", part.cls ?? "", part.text));
    if (Number.isFinite(card.dan)) meta.children[ctx.role ? 1 : 0].title = t("recommend.card.trackerDan", { dan: fix2(card.dan) });
    const why = el("div", "rec-why", whyText(card, ctx.patternName));

    const ours = el("div", "rec-ours");
    ours.hidden = true;
    const runOurs = async () => {
        if (oursButton.disabled) return null;
        oursButton.disabled = true;
        oursButton.textContent = "…";
        const r = await call(() => window.danApi.recOurs({ beatmapId: card.beatmapId, trackerDan: card.dan, center: ctx.target.center }));
        oursButton.textContent = t("recommend.ours.button");
        oursButton.disabled = oursDone(r);
        showOurs(ours, r);
        ours.hidden = false;
        return r;
    };
    const oursButton = button(t("recommend.ours.button"), t("recommend.ours.buttonTitle"), runOurs);
    const fetched = el("div", "rec-ours");
    fetched.hidden = true;
    const download = downloadButton(card, fetched);
    const similar = el("div", "rec-similar");
    similar.hidden = true;

    const actions = el("div", "rec-actions");
    actions.append(
        download.node,
        button("osu!direct", t("recommend.direct.title"), () => openIn("direct", card.beatmapId, ctx.status)),
        button(t("recommend.page"), t("recommend.page.title"), () => openIn("site", card.beatmapId, ctx.status)),
        oursButton,
        starButton(card, ctx.status),
    );
    if (ctx.onSimilar && card.seed) actions.append(similarButton(card, similar, ctx));
    if (ctx.onSwap) actions.append(button(t("recommend.plan.swap"), t("recommend.plan.swapTitle"), ctx.onSwap));

    body.append(title, sub, meta, why, actions, fetched, ours, similar);
    root.append(coverOf(card), body);
    root.actions = { download: download.run, ours: runOurs };
    return root;
}

// The small card, without a cover: similar maps and favourites.
// ctx: { status(text), extra (a word after the meta, e.g. how similar), onRemove(card) (✕ instead of ☆), onSimilar }.
export function compactCard(card, ctx) {
    const root = el("div", card.played ? "rec-compact played" : "rec-compact");
    const [title, sub] = titleLines(card);
    const meta = el("div", "rec-meta");
    for (const part of compactParts(card, ctx.extra)) meta.append(el("span", part.cls ?? "", part.text));
    const fetched = el("div", "rec-ours");
    fetched.hidden = true;
    const similar = el("div", "rec-similar");
    similar.hidden = true;
    const actions = el("div", "rec-actions");
    actions.append(
        ctx.onRemove ? button("✕", t("recommend.fav.remove"), () => ctx.onRemove(card)) : starButton(card, ctx.status),
        downloadButton(card, fetched).node,
        button("osu!direct", t("recommend.direct.title"), () => openIn("direct", card.beatmapId, ctx.status)),
    );
    if (ctx.onSimilar && card.seed) actions.append(similarButton(card, similar, ctx));
    root.append(title, sub, meta, actions, fetched, similar);
    return root;
}
