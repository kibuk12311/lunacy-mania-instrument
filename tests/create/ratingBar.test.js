// The 👍/👎 bar of a variant card (app/renderer/ratingBar.js, addendum §6 / U2): the vote buttons call rate-variant
// with the card's id, tags of that kind appear after a vote (at most 4), the same vote again takes it back, a refusal
// is shown and the vote goes back to what it was; the tag list is the main process's.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import { createRatingBar, newRating, TAGS_DOWN, TAGS_UP, TAG_KEYS, MAX_TAGS } from "../../app/renderer/ratingBar.js";
import { RATING_TAGS } from "../../app/ratingsIpc.js";

const all = (n) => [n, ...n.children.flatMap(all)];
const voteButton = (bar, v) => all(bar).find((n) => n.tagName === "BUTTON" && n.dataset.vote === String(v));
const tagChip = (bar, tag) => all(bar).find((n) => n.tagName === "BUTTON" && n.dataset.tag === tag);

test("the renderer's tags are the main process's, each with a text", () => {
    assert.deepEqual([...TAGS_DOWN, ...TAGS_UP], [...RATING_TAGS]);
    assert.deepEqual(Object.keys(TAG_KEYS), [...RATING_TAGS]);
    assert.equal(MAX_TAGS, 4);
});

test("a vote calls rateVariant with the card's id; the tags of that kind follow; the same vote again takes it back", async () => {
    setLang("en");
    try {
        fakeDom({});
        const sent = [];
        const rating = newRating();
        const bar = createRatingBar({ id: "card-7", rating, rate: async (r) => { sent.push(r); return { ok: true, n: 1 }; } });
        assert.ok(textOf(bar).includes("👍 Like") && textOf(bar).includes("👎 Dislike"));
        assert.equal(tagChip(bar, "tooJacky"), undefined, "no tags before a vote");

        await fire(voteButton(bar, -1));
        assert.deepEqual(sent.at(-1), { id: "card-7", vote: -1, tags: [] });
        assert.equal(rating.vote, -1);
        assert.ok(textOf(bar).includes("Thanks — noted"));
        assert.ok(textOf(bar).includes("What's wrong? (up to 4)"));
        assert.ok(tagChip(bar, "tooJacky") && !tagChip(bar, "fun"), "dislike tags only");
        assert.equal(tagChip(bar, "tooJacky").textContent, "too jacky");

        await fire(tagChip(bar, "tooJacky"));
        await fire(tagChip(bar, "boring"));
        assert.deepEqual(sent.at(-1), { id: "card-7", vote: -1, tags: ["tooJacky", "boring"] });
        await fire(tagChip(bar, "tooJacky"));
        assert.deepEqual(sent.at(-1).tags, ["boring"], "a picked tag again drops it");
        for (const tag of ["awkward", "offMusic", "tooDense"]) await fire(tagChip(bar, tag));
        assert.equal(rating.tags.length, 4);
        assert.equal(tagChip(bar, "tooSparse").disabled, true, "no fifth tag");

        await fire(voteButton(bar, 1));
        assert.deepEqual(sent.at(-1), { id: "card-7", vote: 1, tags: [] }, "a new vote starts without tags");
        assert.ok(tagChip(bar, "fun") && !tagChip(bar, "tooJacky"));
        await fire(voteButton(bar, 1));
        assert.deepEqual(sent.at(-1), { id: "card-7", vote: 0, tags: [] });
        assert.equal(rating.vote, 0);
        assert.equal(tagChip(bar, "fun"), undefined);
    } finally {
        setLang("ru");
    }
});

test("a refusal is shown and the vote goes back; a re-made bar shows the card's state", async () => {
    setLang("en");
    try {
        fakeDom({});
        const rating = newRating();
        let answer = { ok: true, n: 1 };
        const rate = async () => answer;
        const bar = createRatingBar({ id: "x", rating, rate });
        await fire(voteButton(bar, 1));
        answer = { ok: false, code: "unknownId", message: "This map is no longer in memory — generate it again" };
        await fire(tagChip(bar, "fun"));
        assert.deepEqual(rating.tags, [], "the tag was not kept");
        assert.equal(rating.vote, 1);
        assert.ok(textOf(bar).includes("This map is no longer in memory"));
        const thrown = createRatingBar({ id: "y", rating: newRating(), rate: async () => { throw new Error("gone"); } });
        await fire(voteButton(thrown, -1));
        assert.ok(textOf(thrown).includes("gone"));

        answer = { ok: true, n: 1 };
        await fire(tagChip(bar, "comfy"));
        const again = createRatingBar({ id: "x", rating, rate });
        assert.equal(voteButton(again, 1).className.includes("sel"), true);
        assert.equal(tagChip(again, "comfy").className.includes("sel"), true);
    } finally {
        setLang("ru");
    }
});
