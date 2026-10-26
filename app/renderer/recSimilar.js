// "Похожие на эту": a small section under a card with up to 5 compact cards of maps like it (main finds them).
import { t } from "../../src/i18n/i18n.js";
import { el, call, compactCard } from "./recCard.js";

// The request for a card: its id, set, title and seed; whether to keep to ranked and hide played maps comes from ctx.
export function similarRequest(card, { rankedOnly = false, hidePlayed = true } = {}) {
    return {
        beatmapId: card.beatmapId, beatmapsetId: card.beatmapsetId, title: card.title, seed: card.seed,
        rankedOnly: Boolean(rankedOnly), hidePlayed: Boolean(hidePlayed),
    };
}

// A second press hides the section again. ctx.similarOptions() → { rankedOnly, hidePlayed } of the tab's filters.
export async function toggleSimilar(card, holder, ctx) {
    if (!holder.hidden && holder.children.length) {
        holder.hidden = true;
        return;
    }
    const head = el("div", "rec-similar-head", t("recommend.similar.title"));
    holder.replaceChildren(head, el("div", "muted", t("recommend.similar.loading")));
    holder.hidden = false;
    const request = similarRequest(card, ctx.similarOptions?.() ?? {});
    const r = await call(() => window.danApi.recSimilar?.(request) ?? Promise.resolve({ ok: false }));
    if (!r?.ok) {
        holder.replaceChildren(head, el("div", "bad", r?.message || t("recommend.similar.failed")));
        return;
    }
    const cards = Array.isArray(r.cards) ? r.cards : [];
    if (!cards.length) {
        holder.replaceChildren(head, el("div", "muted", t("recommend.similar.none")));
        return;
    }
    // one level deep: a similar card has no «Похожие» of its own
    holder.replaceChildren(head, ...cards.map((c) => compactCard(c, { status: ctx.status, extra: c.simLabel })));
}
