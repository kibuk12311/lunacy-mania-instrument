import { test } from "node:test";
import assert from "node:assert/strict";
import * as site from "../../../extension/content/site.js";
import { siteLang } from "../../../extension/shared/lang.js";
import { makeDocument } from "./helpers/dom.js";
import { pageHtml, beatmapset, SET_ID, FOUR_K_ORDER } from "./helpers/fixture.js";

test("set path: only /beatmapsets/<id>", () => {
    assert.equal(site.setIdFromPath("/beatmapsets/2316993"), 2316993);
    assert.equal(site.setIdFromPath("/beatmapsets/2316993/"), 2316993);
    assert.equal(site.setIdFromPath("/beatmapsets/2316993/discussion"), null);
    assert.equal(site.setIdFromPath("/beatmapsets"), null);
    assert.equal(site.setIdFromPath("/beatmaps/4961226"), null);
    assert.equal(site.setIdFromPath("/beatmapsets/0"), null);
    assert.equal(site.setIdFromPath(undefined), null);
});

test("hash and href ids", () => {
    assert.equal(site.hashBeatmapId("#mania/4961226"), 4961226);
    assert.equal(site.hashBeatmapId("#osu/12"), 12);
    assert.equal(site.hashBeatmapId("#mania"), null);
    assert.equal(site.hashBeatmapId(""), null);
    assert.equal(site.hrefBeatmapId("https://osu.ppy.sh/beatmapsets/1#mania/2"), 2);
    assert.equal(site.hrefBeatmapId("https://osu.ppy.sh/beatmapsets/1"), null);
});

test("reads json-beatmapset from an osu-web body", () => {
    const doc = makeDocument(pageHtml());
    const set = site.readBeatmapset(doc);
    assert.equal(set.id, SET_ID);
    assert.equal(set.beatmaps.length, 7);
    assert.equal(siteLang(doc, { language: "ru-RU" }), "en", "<html lang> wins over the browser");
    assert.equal(siteLang(makeDocument(pageHtml({ lang: "ru" })), { language: "en-US" }), "ru");
    assert.equal(siteLang(makeDocument(pageHtml({ lang: "uk" }))), "ru");
});

test("falls back to the mount's saved state, then to nothing", () => {
    const doc = makeDocument(pageHtml({ json: false }));
    assert.equal(site.readBeatmapset(doc), null);
    doc.querySelector('[data-react="beatmapset-page"]').dataset.state = JSON.stringify({ beatmapId: 1001, beatmapset: beatmapset(), playmode: "mania" });
    assert.equal(site.readBeatmapset(doc).id, SET_ID);
    doc.querySelector('[data-react="beatmapset-page"]').dataset.state = "{broken";
    assert.equal(site.readBeatmapset(doc), null);
});

test("the HTML fallback reads the tag or a saved mount state", () => {
    assert.equal(site.beatmapsetFromHtml(pageHtml()).id, SET_ID);
    assert.equal(site.beatmapsetFromHtml("<html><body>nothing</body></html>"), null);
    const state = JSON.stringify({ beatmapset: beatmapset() }).replace(/"/g, "&quot;");
    assert.equal(site.beatmapsetFromHtml(`<div class="js-react" data-react="beatmapset-page" data-state="${state}"></div>`).id, SET_ID);
});

test("loadBeatmapset: page first, one same-origin fetch as the last resort, wrong set refused", async () => {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push([url, init.credentials]);
        return { ok: true, text: async () => pageHtml() };
    };
    const withTag = makeDocument(pageHtml());
    assert.equal((await site.loadBeatmapset(withTag, { setId: SET_ID, pathname: `/beatmapsets/${SET_ID}`, fetch })).id, SET_ID);
    assert.equal(calls.length, 0);

    const bare = makeDocument(pageHtml({ json: false }));
    assert.equal((await site.loadBeatmapset(bare, { setId: SET_ID, pathname: `/beatmapsets/${SET_ID}`, fetch })).id, SET_ID);
    assert.deepEqual(calls, [[`/beatmapsets/${SET_ID}`, "same-origin"]]);

    assert.equal(await site.loadBeatmapset(withTag, { setId: 5, pathname: "/beatmapsets/5" }), null, "a set of another page is not used");
    assert.equal(await site.loadBeatmapset(bare, { setId: SET_ID, pathname: "/x", fetch: async () => { throw new TypeError("x"); } }), null);
    assert.equal(await site.loadBeatmapset(bare, { setId: SET_ID, pathname: "/x", fetch: async () => ({ ok: false }) }), null);
});

test("4K filter: mania 4K only, no converts, 7K or osu!; picker order", () => {
    const diffs = site.fourKDiffs(beatmapset());
    assert.deepEqual(diffs.map((d) => d.id), FOUR_K_ORDER);
    const first = diffs[0];
    assert.equal(first.version, "[4K] Easy rice");
    assert.equal(first.setId, SET_ID);
    assert.equal(first.od, 8);
    assert.match(first.checksum, /^[0-9a-f]{32}$/);
    assert.deepEqual(site.fourKDiffs({ id: 1, beatmaps: [{ id: 3, mode: "mania", cs: 4.4, convert: false, difficulty_rating: 1 }] }).map((d) => d.id), [3], "cs rounds");
    assert.deepEqual(site.fourKDiffs({ id: 1, beatmaps: [{ id: 3, mode: "mania", cs: 4, convert: false, checksum: "nothex" }] })[0].checksum, null);
    assert.deepEqual(site.fourKDiffs(null), []);
    assert.deepEqual(site.fourKDiffs({ id: 1, beatmaps: [{ id: 3, mode: "taiko", cs: 4 }] }), []);
});

test("selected id: hash, else the active picker anchor, else the first 4K diff", () => {
    const diffs = site.fourKDiffs(beatmapset());
    const doc = makeDocument(pageHtml({ activeId: 1002 }));
    assert.equal(site.activePickerId(doc), 1002);
    assert.equal(site.selectedBeatmapId(doc, "#mania/1004", diffs), 1004);
    assert.equal(site.selectedBeatmapId(doc, "", diffs), 1002);
    assert.equal(site.selectedBeatmapId(doc, "#mania/1005", diffs), 1002, "a 7K id in the hash is passed over");
    const noActive = makeDocument(pageHtml({ activeId: 1005 }));
    assert.equal(site.selectedBeatmapId(noActive, "", diffs), 1003);
    assert.equal(site.selectedBeatmapId(noActive, "", []), null);
});

test("picker anchors by id", () => {
    const doc = makeDocument(pageHtml());
    assert.equal(site.pickerAnchors(doc).length, 5, "the picker shows the mania diffs, 7K included");
    assert.match(site.pickerAnchorFor(doc, 1004).getAttribute("href"), /#mania\/1004$/);
    assert.equal(site.pickerAnchorFor(doc, 1006), null);
});

test("login hint from json-current-user", () => {
    assert.equal(site.loginHint(makeDocument(pageHtml({ user: {} }))), false);
    assert.equal(site.loginHint(makeDocument(pageHtml({ user: { id: 7, username: "x" } }))), true);
    assert.equal(site.loginHint(makeDocument("<div></div>")), null);
    assert.equal(site.loginHint(makeDocument(pageHtml({ user: null }))), null, "an empty tag is unknown");
});

test("download availability", () => {
    assert.deepEqual(site.downloadAvailability(beatmapset()), { disabled: false, info: null });
    assert.deepEqual(site.downloadAvailability(beatmapset({ availability: { download_disabled: true, more_information: "https://example.invalid" } })).disabled, true);
});

test("host placement: after the header, then before info, then first in the page, then floating", () => {
    const doc = makeDocument(pageHtml());
    const host = doc.createElement("section");
    assert.equal(site.placeHost(doc, host), "header");
    assert.equal(doc.querySelector(".beatmapset-header").nextElementSibling, host);
    assert.equal(host.hasAttribute("data-lm-floating"), false);
    // already there: nothing moves
    assert.equal(site.placeHost(doc, host), "header");
    assert.equal(doc.querySelectorAll("section").length, 1);

    const noHeader = makeDocument(pageHtml({ header: false }));
    const h2 = noHeader.createElement("section");
    assert.equal(site.placeHost(noHeader, h2), "info");
    assert.equal(noHeader.querySelector(".beatmapset-info").previousElementSibling, h2);

    const pageOnly = makeDocument('<div class="osu-page osu-page--generic-compact"><div class="x"></div></div>');
    const h3 = pageOnly.createElement("section");
    assert.equal(site.placeHost(pageOnly, h3), "page");
    assert.equal(pageOnly.querySelector(".osu-page--generic-compact").firstElementChild, h3);

    const empty = makeDocument(pageHtml({ rendered: false }));
    const h4 = empty.createElement("section");
    assert.equal(site.placeHost(empty, h4), "floating");
    assert.equal(h4.parentNode, empty.body);
    assert.equal(h4.hasAttribute("data-lm-floating"), true);
});

test("a floating host moves under the header once React renders it", () => {
    const doc = makeDocument(pageHtml({ rendered: false }));
    const host = doc.createElement("section");
    site.placeHost(doc, host);
    const mount = doc.querySelector('[data-react="beatmapset-page"]');
    const rendered = makeDocument(pageHtml());
    mount.append(rendered.querySelector(".osu-page"));
    assert.equal(site.placeHost(doc, host), "header");
    assert.equal(doc.querySelector(".beatmapset-header").nextElementSibling, host);
    assert.equal(host.hasAttribute("data-lm-floating"), false);
});
