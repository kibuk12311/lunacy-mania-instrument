// The picks tab takes the profile another tab already loaded instead of loading the same player again.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom } from "../helpers/fakeDom.js";

const SKILL = { ready: true, status: "ready", analyzedPlays: 585, overall: 13.66, overallLabel: "Delta low", tiles: { stamina: 13.26 }, msd: {} };

globalThis.Option = class Option {
    constructor(text, value, _defaultSelected, selected) {
        Object.assign(this, { text, value, selected: Boolean(selected) });
    }
};

test("a ready profile with the saved nick (any case) is shown without calling recPlayer", async () => {
    const calls = { recPlayer: 0, profileEnsure: 0, favList: 0 };
    const { $ } = fakeDom({
        profileEnsure: async () => {
            calls.profileEnsure += 1;
            return { ok: true, player: { id: 1234567, username: "TestPlayer", avatarUrl: null }, skill: SKILL };
        },
        onProfileChanged: () => {},
        recPlayer: async () => { calls.recPlayer += 1; return { ok: false, message: "should not be asked" }; },
        recFavList: async () => { calls.favList += 1; return { ok: true, items: [] }; },
        onRecDownloadProgress: () => {},
    }, { storage: { "rec-settings": JSON.stringify({ query: "testplayer", source: "tracker" }) } });
    const { ensureProfile, getProfile } = await import("../../app/renderer/profile.js");
    const { initRecommendTab, onRecommendTabShown } = await import("../../app/renderer/recommendTab.js");

    initRecommendTab();
    // another tab (the analysis card) asked for the profile first
    await ensureProfile();
    assert.equal(getProfile().state, "ready");
    await onRecommendTabShown();
    assert.equal(calls.recPlayer, 0);
    assert.equal(calls.profileEnsure, 1);
    assert.equal($("rec-skill").hidden, false);
    assert.equal($("rec-skill").children[0].textContent, "TestPlayer · общий дан Delta low (13.66) · 585 игр");
    assert.equal($("rec-user").value, "testplayer");
    assert.equal(calls.favList, 1, "the favourites are read once for the ☆ marks");
});

test("another nick saved: the tab loads its own player as before", async () => {
    const asked = [];
    fakeDom({
        onProfileChanged: () => {},
        recPlayer: async (query) => { asked.push(query); return { ok: true, player: { id: 2, username: "Other" }, skill: SKILL }; },
        recFavList: async () => ({ ok: true, items: [] }),
        onRecDownloadProgress: () => {},
    }, { storage: { "rec-settings": JSON.stringify({ query: "Other", source: "tracker" }) } });
    // a fresh copy of the tab module; the shared profile (TestPlayer, ready) stays as the first test left it
    const tab = await import("../../app/renderer/recommendTab.js?another-nick");
    tab.initRecommendTab();
    await tab.onRecommendTabShown();
    assert.deepEqual(asked, ["Other"]);
});
