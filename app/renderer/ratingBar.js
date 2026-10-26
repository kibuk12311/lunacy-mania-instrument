// 👍 / 👎 under a variant card (wave 3, docs/2026-10-25-mapgen-v3-ml-addendum.md §2.7, §6): a vote goes to main as
// rate-variant { id, vote, tags }; after a vote up to 4 tag chips of that kind («слишком джековая», «весело»…) can be
// picked, each change sent again. The same button again takes the vote back (vote 0). The state lives on the card
// object (rating = { vote, tags, note, failed }), so a re-rendered card shows what was picked.
import { t } from "../../src/i18n/i18n.js";

export const TAGS_DOWN = ["tooJacky", "awkward", "boring", "offMusic", "tooDense", "tooSparse"];
export const TAGS_UP = ["fun", "human", "comfy"];
export const MAX_TAGS = 4;
export const TAG_KEYS = {
    tooJacky: "create.ml.tag.tooJacky", awkward: "create.ml.tag.awkward", boring: "create.ml.tag.boring",
    offMusic: "create.ml.tag.offMusic", tooDense: "create.ml.tag.tooDense", tooSparse: "create.ml.tag.tooSparse",
    fun: "create.ml.tag.fun", human: "create.ml.tag.human", comfy: "create.ml.tag.comfy",
};

export const newRating = () => ({ vote: 0, tags: [], note: "", failed: false });

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// rating: the card's state (changed in place); rate({ id, vote, tags }) → Promise<{ ok, n } | { ok: false, message }>.
// → the bar's element.
export function createRatingBar({ id, rating, rate }) {
    const state = rating;
    const box = el("div", "ml-rate");
    let busy = false;

    async function send(vote, tags) {
        const before = { vote: state.vote, tags: [...state.tags] };
        state.vote = vote;
        state.tags = tags;
        state.note = "";
        state.failed = false;
        busy = true;
        render();
        let answer = null;
        try {
            answer = await rate({ id, vote, tags: [...tags] });
        } catch (error) {
            answer = { ok: false, message: String(error?.message ?? error) };
        }
        busy = false;
        if (answer?.ok) {
            state.note = vote ? t("create.ml.rate.thanks") : "";
        } else {
            state.vote = before.vote;
            state.tags = before.tags;
            state.note = answer?.message ?? "";
            state.failed = true;
        }
        render();
    }

    // a new vote starts with no tags (they belong to one kind of vote); the same vote again takes it back
    const vote = (v) => send(state.vote === v ? 0 : v, []);
    const toggleTag = (tag) => {
        const has = state.tags.includes(tag);
        if (!has && state.tags.length >= MAX_TAGS) return undefined;
        return send(state.vote, has ? state.tags.filter((x) => x !== tag) : [...state.tags, tag]);
    };

    function render() {
        const row = el("div", "ml-rate-row");
        for (const [v, icon, key] of [[1, "👍", "create.ml.rate.up"], [-1, "👎", "create.ml.rate.down"]]) {
            const button = el("button", `small ml-vote${state.vote === v ? " sel" : ""}`, `${icon} ${t(key)}`);
            button.dataset.vote = String(v);
            button.title = t(key);
            button.disabled = busy;
            button.addEventListener("click", () => vote(v));
            row.append(button);
        }
        if (state.note) row.append(el("span", state.failed ? "warn ml-rate-note" : "muted ml-rate-note", state.note));
        const kids = [row];
        if (state.vote !== 0) {
            const tags = el("div", "ml-tags");
            tags.append(el("span", "muted", t(state.vote > 0 ? "create.ml.rate.whyUp" : "create.ml.rate.whyDown")));
            for (const tag of state.vote > 0 ? TAGS_UP : TAGS_DOWN) {
                const on = state.tags.includes(tag);
                const chip = el("button", `small ml-tag${on ? " sel" : ""}`, t(TAG_KEYS[tag]));
                chip.dataset.tag = tag;
                chip.disabled = busy || (!on && state.tags.length >= MAX_TAGS);
                chip.addEventListener("click", () => toggleTag(tag));
                tags.append(chip);
            }
            kids.push(tags);
        }
        box.replaceChildren(...kids);
    }

    render();
    return box;
}
