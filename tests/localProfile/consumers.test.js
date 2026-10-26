// The local profile as the third skill source: the picks' request and the plan's carry { local: true } and main puts
// its own skill in (app/recommendIpc.js), the auto-marathon "by profile" (app/marathonAutoIpc.js), the picks'
// progress over the local plays (app/recProgressIpc.js), the shared profile client (app/renderer/profile.js), the
// targets' and texts' tags, «для тебя» on the analysis card, and the Profile tab driven through a fake DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { createRecommendHandlers } from "../../app/recommendIpc.js";
import { createMarathonAutoHandlers } from "../../app/marathonAutoIpc.js";
import { createProgressHandlers } from "../../app/recProgressIpc.js";
import { createProfileClient } from "../../app/renderer/profile.js";
import { requestFrom, parseSettings, skillLines, targetText } from "../../app/renderer/recommendTab.js";
import { planRequest, planHeaderText } from "../../app/renderer/recPlan.js";
import { forYouLine } from "../../app/renderer/analysisExtras.js";
import { targetFor } from "../../src/recommend/skill.js";
import { skillObject, aggregate, AXES, PATTERNS } from "../../src/localProfile/model.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { fakeDom, textOf, fire } from "../helpers/fakeDom.js";

const NOW = Date.UTC(2026, 9, 26, 12);
// a local skill as the model makes it: Speed 14, Stamina 13.2, Jack 12.6, Tech without enough plays
function localSkill({ empty = false } = {}) {
    const est = (dan) => (dan === null ? aggregate([], NOW) : aggregate([0, 1, 2, 3].map((i) => ({ dan, share: 1, quality: 1, at: NOW - i, mapKey: `m${i}`, playId: `p${dan}${i}` })), NOW));
    const dans = empty ? { speed: null, jack: null, stamina: null, tech: null } : { speed: 14, jack: 12.6, stamina: 13.2, tech: null };
    return skillObject({
        axes: Object.fromEntries(AXES.map((a) => [a, est(dans[a])])),
        patterns: Object.fromEntries(PATTERNS.map((p) => [p, est(p === "jumpstream" && !empty ? 13.2 : null)])),
        rated: empty ? 0 : 12, total: 14,
    });
}

test("the local skill is a skill like the tracker's: targets tag it, texts name it", () => {
    const k = localSkill();
    assert.equal(k.overall, 13.27);
    const target = targetFor({ skill: k, patternId: "jumpstream", goalId: "growth" });
    assert.equal(target.playerDan, 13.2);
    assert.equal(target.localProfile, true);
    assert.equal(target.handSet, undefined);
    assert.ok(targetText(target, "Джампстрим").includes(t("profile.local.tag")));
    // tech has no dan yet: the overall stands in
    assert.equal(targetFor({ skill: k, patternId: "tech", goalId: "growth" }).source, "overall");
    const [main] = skillLines("Мой профиль", k);
    assert.ok(main.includes(t("profile.local.tag")) && main.includes("12"));
    assert.ok(skillLines("Мой профиль", localSkill({ empty: true }))[0].includes(t("profile.local.notEnough")));
    assert.ok(planHeaderText({ playerDan: 13.2, label: "Gamma low/mid", tile: "Stamina", localProfile: true }, 5, 900).includes(t("profile.local.tag")));
});

test("the picks' request and the plan's say only { local: true } for the local source", () => {
    const s = parseSettings(JSON.stringify({ source: "local" }));
    assert.equal(s.source, "local");
    const r = requestFrom(s, { detailed: false });
    assert.equal(r.local, true);
    assert.equal(r.manual, false);
    assert.equal(r.manualProfile, undefined);
    assert.equal(requestFrom(parseSettings(JSON.stringify({ source: "manual" })), { detailed: false }).local, undefined);
    const plan = planRequest({ planSize: 5, planPatterns: ["stream"] }, s, null, { detailed: false });
    assert.equal(plan.local, true);
    assert.equal(plan.manual, false);
});

function recSetup(skill) {
    const starts = [];
    const builds = [];
    const handlers = createRecommendHandlers({
        recommender: { start: async (req) => { starts.push(req); return { target: { patternId: "jumpstream" }, cards: [], more: false, total: 0 }; } },
        planner: { build: async (req) => { builds.push(req); return { header: {}, slots: [], totalSec: 0 }; } },
        analyze: async () => ({}), fetchText: async () => "", openExternal: async () => {}, fetchProfile: async () => null,
        localSkill: async () => skill,
    });
    return { handlers, starts, builds };
}

test("main puts its own local skill into a { local: true } picks request and plan; too few plays is told", async () => {
    const k = localSkill();
    const { handlers, starts, builds } = recSetup(k);
    const r = await handlers.start({ local: true, manual: false, manualProfile: { name: "x", speed: 99 }, patternId: "jumpstream", goalId: "growth", lengthId: "any", hidePlayed: true });
    assert.equal(r.ok, true);
    assert.equal(starts[0].manual, true);
    assert.equal(starts[0].manualSkill, k, "main's skill, not anything the window sent");
    assert.equal(starts[0].hidePlayed, true);
    assert.equal((await handlers.plan({ local: true, size: 5, patternIds: ["stream"], lengthId: "any" })).ok, true);
    assert.equal(builds[0].manualSkill, k);

    const none = recSetup(localSkill({ empty: true }));
    const refused = await none.handlers.start({ local: true, patternId: "jumpstream", goalId: "growth", lengthId: "any" });
    assert.deepEqual(refused, { ok: false, message: t("profile.local.notEnough") });
    assert.equal(none.starts.length, 0);
    assert.equal((await none.handlers.plan({ local: true, size: 5, patternIds: ["stream"], lengthId: "any" })).ok, false);
});

test("the auto-marathon by profile takes the local skill when asked for it", async () => {
    const runs = [];
    const make = (skill) => createMarathonAutoHandlers({
        auto: { run: async (request) => { runs.push(request); return { entries: [], warnings: [] }; } },
        profile: { current: () => ({ ok: false }) },
        localSkill: async () => skill,
    });
    const r = await make(localSkill()).start({ templateId: "dan", source: "profile", localProfile: true, patternIds: ["stream"], skipPlayed: true });
    assert.equal(r.ok, true);
    assert.equal(r.finalDan, 14, "Speed, the stream tile");
    assert.equal(runs[0].skipPlayed, true);
    const refused = await make(localSkill({ empty: true })).start({ templateId: "dan", source: "profile", localProfile: true, patternIds: ["stream"] });
    assert.deepEqual(refused, { ok: false, message: t("profile.local.notEnough") });
});

test("the picks' progress over the local profile: the journal joined with its own plays, its daily skill", async () => {
    const DAY = 86_400_000;
    const store = { picks: { list: async () => [{ beatmapId: 900, at: NOW - 5 * DAY, title: "T" }, { beatmapId: 901, at: NOW - 5 * DAY }, { beatmapId: 902, at: NOW - 60 * DAY }] } };
    const localProfile = {
        history: async (days) => ({
            ok: true, points: [{ at: NOW - DAY, dan: 13, ratings: { speed: 13 } }], change: null, days,
            joinable: [{ beatmapId: 900, at: NOW - 2 * DAY, rate: 1, passed: true, accuracy: 0.97 }],
        }),
    };
    const h = createProgressHandlers({ store, trackerApi: {}, recommender: { currentPlayer: () => null }, localProfile, now: () => NOW });
    const r = await h.progress({ days: 30, local: true });
    assert.equal(r.ok, true);
    assert.equal(r.local, true);
    assert.equal(r.total, 2);
    assert.equal(r.played, 1);
    assert.equal(r.picks[0].play.accuracy, 0.97);
    assert.equal(r.points.length, 1);
    // without local the tracker path still needs a player
    assert.equal((await h.progress({ days: 30 })).ok, false);
});

test("the profile client: source local asks main once, follows its changes, and says when there is no dan yet", async () => {
    const storage = new Map([["rec-settings", JSON.stringify({ source: "local" })]]);
    let changed = null;
    let asks = 0;
    const k = localSkill();
    const api = {
        localProfileStatus: async () => { asks += 1; return { ok: true, skill: localSkill({ empty: true }) }; },
        onLocalProfileChanged: (cb) => { changed = cb; },
        onProfileChanged: () => {},
        profileEnsure: async () => { throw new Error("mania-tracker is not asked"); },
    };
    const c = createProfileClient({ api: () => api, storage: () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, v) => storage.set(key, v) }) });
    const states = [];
    c.onProfile((s) => states.push(s.state));
    assert.deepEqual(c.getProfile(), { state: "loading", local: true });
    const none = await c.ensureProfile();
    assert.equal(none.state, "none");
    assert.equal(none.local, true);
    assert.equal(none.message, t("profile.local.notEnough"));
    changed({ skill: k });
    const ready = c.getProfile();
    assert.equal(ready.state, "ready");
    assert.equal(ready.local, true);
    assert.equal(ready.skill, k);
    assert.equal(ready.player.username, t("profile.local.name"));
    assert.equal(asks, 1);
    assert.deepEqual(states.slice(-1), ["ready"]);
    // another source: the local skill stays known, but is not the one in use
    storage.set("rec-settings", JSON.stringify({ source: "manual" }));
    assert.equal(c.getProfile().manual, true);
    assert.equal(c.getLocalSkill(), k);
});

test("«для тебя» on the analysis card names the local profile, and says when it has no dan yet", () => {
    const k = localSkill();
    const ready = { state: "ready", local: true, player: { username: t("profile.local.name") }, skill: k };
    const html = forYouLine({ source: "tile", tile: "stamina", playerDan: 13.2, delta: 0.3, band: "growth", msd: null }, ready);
    assert.ok(html.includes(t("profile.local.tag")));
    assert.ok(forYouLine(null, { state: "none", local: true }).includes(t("profile.local.notEnough").slice(0, 20)));
});

// ---- the Profile tab through a fake DOM ----

function statusAnswer(skill = localSkill()) {
    const play = { id: "p1", artist: "Test", title: "Synthetic", version: "4K", rate: 1.1, accuracy: 96.8, outcome: "pass", at: Date.now() - 1000, mapDan: 13.4, perf: 13.45, unrated: false };
    return {
        ok: true, skill, settings: { record: true, imports: {} }, counts: { plays: 14, rated: 12, live: 4, stable: 10, interlude: 0, lazer: 1 },
        top: Object.fromEntries([...AXES, ...PATTERNS.map((p) => `p:${p}`)].map((k) => [k, k === "speed" ? [play] : []])),
        recent: [play, { ...play, id: "p2", outcome: "fail", perf: null }], importing: null, interludeLinked: false,
    };
}

async function profileTab(lang = "ru", { source = "local", page = "local" } = {}) {
    setLang(lang);
    const calls = [];
    const api = {
        localProfileStatus: async () => { calls.push("status"); return statusAnswer(); },
        localProfileHistory: async (days) => { calls.push(`history ${days}`); return { ok: true, since: Date.now() - days * 86_400_000, now: Date.now(), points: [], change: null }; },
        localProfileRecord: async (on) => { calls.push(`record ${on}`); return { ok: true, record: on }; },
        localProfileImport: async (src) => { calls.push(`import ${src}`); return { ok: true, added: 10, total: 12, finished: true, missing: 2 }; },
        localProfileReset: async () => { calls.push("reset"); return { ok: true }; },
        onLocalProfileChanged: () => {}, onLocalProfileImport: () => {}, onProfileChanged: () => {},
        recProgress: async () => ({ ok: false, message: "x" }),
    };
    const dom = fakeDom(api, { storage: { "rec-settings": JSON.stringify({ source }), "profile-view": JSON.stringify({ page }) } });
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(globalThis.document.createElement(tag), { setAttribute() {} });
    globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
    const mod = await import(`../../app/renderer/profileTab.js?${lang}${source}${page}${Math.random()}`);
    mod.initProfileTab();
    mod.onProfileTabShown();
    await new Promise((r) => setTimeout(r, 20));
    return { ...dom, calls, mod };
}

test("Profile tab, my profile: the summary, the patterns, plays, the import and the record switch", async () => {
    const { $, calls, events, storage } = await profileTab("ru");
    try {
        assert.ok(calls.includes("status") && calls.includes("history 90"));
        const card = textOf($("prof-local-card"));
        assert.ok(card.includes("Мой профиль") && card.includes("Speed") && card.includes("14.00") && card.includes("мало игр"), card);
        const table = textOf($("prof-local-patterns"));
        assert.ok(table.includes("Джампстрим") && table.includes("13.20"), table);
        assert.ok(textOf($("prof-local-top")).includes("карта 13.4 → 13.45"));
        assert.ok(textOf($("prof-local-recent")).includes("провал"));
        assert.ok($("prof-local-counts").textContent.includes("14"));
        assert.equal($("prof-import-interlude").disabled, true, "no Interlude folder linked");
        await fire($("prof-import-stable"));
        assert.ok(calls.includes("import stable"));
        assert.ok($("prof-import-status").textContent.includes("10") && $("prof-import-status").textContent.includes("2"));
        $("prof-record").checked = false;
        await fire($("prof-record"), "change");
        assert.ok(calls.includes("record false"));
        // reset asks twice
        await fire($("prof-reset"));
        assert.ok(!calls.includes("reset"));
        await fire($("prof-reset"));
        assert.ok(calls.includes("reset"));
        // the source chips: picking mania-tracker saves it in the picks' settings and tells the other tabs
        const chip = $("prof-source").children.find((c) => c.textContent === t("recommend.source.tracker"));
        await fire(chip);
        assert.equal(JSON.parse(storage.get("rec-settings")).source, "tracker");
        assert.ok(events.some((e) => e.type === "profile-source" && e.detail.source === "tracker"));
    } finally {
        setLang("ru");
    }
});

test("Profile tab in English: no Russian on the local page", async () => {
    const { $ } = await profileTab("en");
    try {
        const all = ["prof-local-card", "prof-local-patterns", "prof-local-top", "prof-local-recent", "prof-local-counts", "prof-pages", "prof-source"].map((id) => textOf($(id))).join(" ");
        assert.ok(!/[А-Яа-яЁё]/.test(all), all);
        assert.ok(all.includes("My profile") && all.includes("not enough plays"));
    } finally {
        setLang("ru");
    }
});
