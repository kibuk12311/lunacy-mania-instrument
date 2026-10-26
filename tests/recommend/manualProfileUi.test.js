// The hand-set profile in the window: the shared profile client, the picks tab's editor (Speed / Jack / Stamina /
// Tech, a name, copy from mania-tracker), and the tabs that take it like a tracker profile (picks, plan, progress,
// the auto-marathon, the analysis card's "for you"). Fake DOM, no main process.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, textOf, fire } from "../helpers/fakeDom.js";
import { createProfileClient } from "../../app/renderer/profile.js";
import { skillLines, targetText } from "../../app/renderer/recommendTab.js";
import { planHeaderText } from "../../app/renderer/recPlan.js";
import { forYouLine } from "../../app/renderer/analysisExtras.js";
import { manualSkill } from "../../src/recommend/manualProfile.js";
import { targetFor } from "../../src/recommend/skill.js";
import { fitForSkill } from "../../src/analysis/mapFit.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const MINE = { name: "TestPlayer", speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 };
const TRACKER = { overall: 13.66, overallLabel: "Delta low", analyzedPlays: 585, tiles: { speed: 14.28, stamina: 13.26, tech: 13.74, jack: 13.36 }, msd: {} };
const ticks = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const inEnglish = (fn) => {
    setLang("en");
    try {
        return fn();
    } finally {
        setLang("ru");
    }
};

// ---- the profile client ----

function storageWith(settings) {
    const data = new Map([["rec-settings", JSON.stringify(settings)]]);
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
}

test("client: in manual mode the hand-set profile is the one in use; main is not asked", async () => {
    const calls = [];
    let changed = null;
    const api = {
        profileEnsure: async (q) => { calls.push(q); return { ok: true, player: { id: 7, username: "TestPlayer" }, skill: TRACKER }; },
        onProfileChanged: (cb) => { changed = cb; },
    };
    const storage = storageWith({ source: "manual", manualProfile: MINE, query: "TestPlayer" });
    const c = createProfileClient({ api: () => api, storage: () => storage });
    const p = c.getProfile();
    assert.deepEqual(p, { state: "ready", manual: true, player: { id: null, username: "TestPlayer", avatarUrl: null }, skill: manualSkill(MINE), profile: MINE });
    assert.equal((await c.ensureProfile()).manual, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(c.getTrackerProfile(), { state: "idle" });

    const seen = [];
    c.onProfile((s) => seen.push(s.manual ? `manual ${s.skill.tiles.jack}` : s.state));
    // the editor saves another dan: every subscriber hears the profile now in use
    storage.setItem("rec-settings", JSON.stringify({ source: "manual", manualProfile: { ...MINE, jack: 13 } }));
    c.manualChanged();
    // main loads a tracker profile meanwhile: the hand-set one stays in use, the tracker one is kept apart
    changed({ player: { id: 7, username: "TestPlayer" }, skill: TRACKER });
    assert.equal(c.getTrackerProfile().player.username, "TestPlayer");
    assert.equal(c.getProfile().manual, true);
    // the source goes back to mania-tracker
    storage.setItem("rec-settings", JSON.stringify({ source: "tracker", manualProfile: MINE }));
    c.manualChanged();
    assert.deepEqual(seen, ["manual 13", "manual 13", "ready"]);
    assert.equal(c.getProfile().player.username, "TestPlayer");
});

test("client: no name gives «Мой профиль»; settings of 0.9.1 (one manual dan) give that dan on every axis", () => {
    const storage = storageWith({ source: "manual", level: 14, step: "low/mid" });
    const p = createProfileClient({ api: () => ({}), storage: () => storage }).getProfile();
    assert.equal(p.player.username, "Мой профиль");
    assert.deepEqual(p.skill.tiles, { speed: 13.8, jack: 13.8, stamina: 13.8, tech: 13.8 });
    assert.equal(inEnglish(() => createProfileClient({ api: () => ({}), storage: () => storage }).getProfile().player.username), "My profile");
});

// ---- texts ----

test("summary, target and plan lines of a hand-set profile, ru and en", () => {
    const skill = manualSkill(MINE);
    assert.deepEqual(skillLines("TestPlayer", skill), [
        "TestPlayer · общий дан Delta low (13.65) · вручную",
        "Speed Delta mid/high · Stamina Gamma mid/high · Tech Delta low/mid · Jack Gamma high",
    ]);
    const target = targetFor({ skill, manualDan: null, patternId: "jumpstream", goalId: "growth" });
    assert.equal(targetText(target, "Джампстрим"), "Твой дан для паттерна «Джампстрим»: Gamma mid/high (13.20, вручную) → ищем 13.20–13.70");
    assert.equal(planHeaderText({ playerDan: 13.2, label: "Gamma mid/high", tile: "Stamina", handSet: true }, 5, 1040), "План: Stamina Gamma mid/high (вручную) (13.20) · 5 карт · ≈ 17:20");
    inEnglish(() => {
        assert.equal(skillLines("My profile", skill)[0], "My profile · overall dan Delta low (13.65) · set by hand");
        assert.equal(targetText(target, "Jumpstream"), "Your dan for Jumpstream: Gamma mid/high (13.20, set by hand) → looking for 13.20–13.70");
    });
});

test("analysis «for you» with a hand-set profile: the axis dan, the name says so; the hint mentions the manual way", () => {
    const skill = manualSkill(MINE);
    const fit = fitForSkill({ kind: "ok", numeric: 13.7, primary: "Jumpstream", msd: {} }, skill);
    const html = forYouLine(fit, { state: "ready", manual: true, player: { username: "TestPlayer" }, skill });
    assert.ok(html.includes("TestPlayer · вручную"), html);
    assert.ok(html.includes("Stamina-дан: Gamma mid/high (13.2) · карта +0.5 — рост — реально пройти"), html);
    assert.ok(!html.includes("an-msd"), "no MinaCalc ratings to compare");
    assert.ok(forYouLine(null, { state: "none" }).includes("нет mania-tracker? там же можно задать уровень вручную"));
    assert.ok(inEnglish(() => forYouLine(null, { state: "none" })).includes("no mania-tracker? you can set your level by hand there"));
});

// ---- the tabs in a fake DOM ----

globalThis.Option = class Option {
    constructor(text, value, _defaultSelected, selected) {
        Object.assign(this, { text, value, selected: Boolean(selected) });
    }
};
const calls = { start: [], plan: [], auto: [], progress: 0, ensure: 0 };
const { $, storage } = fakeDom({
    onRecDownloadProgress: () => {},
    onProfileChanged: () => {},
    onRecFavExportProgress: () => () => {},
    recFavList: async () => ({ ok: true, items: [] }),
    recPlayer: async () => ({ ok: true, player: { id: 7, username: "TestPlayer" }, skill: TRACKER }),
    recStart: async (req) => {
        calls.start.push(req);
        return { ok: true, target: { ...targetFor({ skill: manualSkill(req.manualProfile), manualDan: null, patternId: req.patternId, goalId: req.goalId }) }, cards: [], more: false, total: 0 };
    },
    recPlan: async (req) => { calls.plan.push(req); return { ok: true, header: { playerDan: 13.2, label: "Gamma mid/high", tile: "Stamina", handSet: true }, slots: [], totalSec: 0 }; },
    recProgress: async () => { calls.progress += 1; return { ok: false, message: "x" }; },
    profileEnsure: async () => { calls.ensure += 1; return { ok: false, reason: "none" }; },
    marathonAuto: async (req) => { calls.auto.push(req); return { ok: true, entries: [], warnings: [] }; },
    onMarathonAutoProgress: () => () => {},
}, { storage: { "rec-settings": JSON.stringify({ source: "manual", manualProfile: MINE }), "marathon.auto.v1": JSON.stringify({ source: "profile", patternIds: ["stream"] }) } });
const { initRecommendTab, onRecommendTabShown } = await import("../../app/renderer/recommendTab.js");
const { initMarathonTab } = await import("../../app/renderer/marathonTab.js");
const { getProfile } = await import("../../app/renderer/profile.js");
initRecommendTab();
initMarathonTab();
await onRecommendTabShown();
await ticks();
const saved = () => JSON.parse(storage.get("rec-settings")).manualProfile;
const rows = () => $("rec-axes").children;
const chip = (box, text) => $(box).children.find((c) => c.textContent === text);

test("editor: four rows with the saved dans, the summary line, no plays to hide, nothing to copy yet", () => {
    assert.equal($("rec-manual").hidden, false);
    assert.equal($("rec-tracker").hidden, true);
    assert.deepEqual(rows().map((r) => r.children[0].children[0].textContent), ["Speed", "Jack", "Stamina", "Tech"]);
    assert.deepEqual(rows().map((r) => `${r.children[1].value} ${r.children[2].value}`), ["14 mid/high", "13 high", "13 mid/high", "14 low/mid"]);
    assert.deepEqual(rows().map((r) => r.children[0].children[1].textContent), ["стрим", "джеки, чордджеки", "джампстрим, хендстрим, стамина", "тех"]);
    assert.equal($("rec-manual-name").value, "TestPlayer");
    assert.equal($("rec-skill").hidden, false);
    assert.equal($("rec-skill").children[0].textContent, "TestPlayer · общий дан Delta low (13.65) · вручную");
    assert.equal($("rec-skill").children[2].textContent, "общий дан — среднее Speed, Jack, Stamina и Tech, как у mania-tracker");
    assert.equal($("rec-hide-played").disabled, true);
    assert.equal($("rec-hide-played-row").title, "Сыгранные карты знают mania-tracker и Interlude — загрузи ник или привяжи папку Interlude (кнопка IL), чтобы их скрывать");
    assert.equal($("rec-manual-copy").disabled, true);
    assert.ok($("rec-manual-copy").title.startsWith("Сначала загрузи ник"));
    assert.equal(calls.ensure, 0, "manual mode does not load a tracker profile");
});

test("the marathon's «by profile» shows the hand-set axis dan and sends the profile", async () => {
    assert.equal($("mar-profile").textContent, "Профиль: TestPlayer (вручную), Speed: Delta mid/high");
    assert.equal($("mar-skip-played").disabled, true, "a hand-set profile knows no plays");
    await fire($("mar-pick"));
    assert.equal(calls.auto.length, 1);
    assert.equal(calls.auto[0].source, "profile");
    assert.deepEqual(calls.auto[0].manualProfile, MINE);
    assert.equal(calls.auto[0].skipPlayed, false);
});

test("with a linked Interlude a hand-set profile can hide played maps (picks) and skip them (auto-marathon)", async () => {
    const { initInterludeState } = await import("../../app/renderer/interlude.js");
    let push = null;
    initInterludeState({ interludeStatus: async () => ({ linked: false }), onInterludeState: (cb) => { push = cb; } });
    await ticks();
    assert.equal($("rec-hide-played").disabled, true);
    push({ linked: true, folder: "C:\Games\Interlude" });
    assert.equal($("rec-hide-played").disabled, false);
    assert.equal($("rec-hide-played-row").title, "");
    assert.equal($("mar-skip-played").disabled, false, "Interlude's played maps can be skipped");
    $("mar-skip-played").checked = true;
    await fire($("mar-skip-played"), "change");
    await fire($("mar-pick"));
    assert.equal(calls.auto.at(-1).skipPlayed, true);
    assert.deepEqual(calls.auto.at(-1).manualProfile, MINE);
    await fire($("rec-go"));
    assert.equal(calls.start.at(-1).hidePlayed, true);
    // unlinked again: nothing to hide, the checkboxes say so
    push({ linked: false });
    assert.equal($("rec-hide-played").disabled, true);
    assert.ok($("rec-hide-played-row").title.includes("привяжи папку Interlude"));
    assert.equal($("mar-skip-played").disabled, true);
    assert.equal($("mar-skip-played").checked, false);
    await fire($("mar-pick"));
    assert.equal(calls.auto.at(-1).skipPlayed, false);
    $("mar-skip-played").checked = false;
    await fire($("mar-skip-played"), "change");
    inEnglish(() => assert.ok(t("recommend.manual.noPlays").includes("link your Interlude folder")));
});

test("a changed dan is saved, the summary and every tab follow it", async () => {
    const [level, step] = rows()[0].children.slice(1, 3);
    level.value = "15";
    step.value = "low";
    await fire(step, "change");
    assert.equal(saved().speed, 14.6);
    assert.equal(getProfile().skill.tiles.speed, 14.6);
    assert.equal($("rec-skill").children[0].textContent, "TestPlayer · общий дан Delta low/mid (13.75) · вручную");
    assert.equal($("mar-profile").textContent, "Профиль: TestPlayer (вручную), Speed: Epsilon low");
    $("rec-manual-name").value = "  Мира ";
    await fire($("rec-manual-name"), "input");
    assert.equal(saved().name, "Мира");
    assert.equal(getProfile().player.username, "Мира");
});

test("picks and the plan send the hand-set profile; the target line says it is set by hand", async () => {
    await fire(chip("rec-patterns", "Стрим"));
    await fire($("rec-go"));
    assert.deepEqual(calls.start.at(-1).manualProfile, { ...MINE, name: "Мира", speed: 14.6 });
    assert.equal(calls.start.at(-1).manual, true);
    assert.equal($("rec-target").textContent, "Твой дан для паттерна «Стрим»: Epsilon low (14.60, вручную) → ищем 14.60–15.10");
    await fire($("rec-mode").children[1]);
    await fire($("rec-plan-go"));
    assert.deepEqual(calls.plan.at(-1).manualProfile, { ...MINE, name: "Мира", speed: 14.6 });
    assert.equal($("rec-plan-head").textContent, "План: Stamina Gamma mid/high (вручную) (13.20) · 0 карт · ≈ 0:00");
});

test("progress needs mania-tracker: told so, main is not asked", async () => {
    await fire($("rec-mode").children[3]);
    await ticks();
    assert.equal(calls.progress, 0);
    assert.ok($("rec-progress-status").textContent.startsWith("Прогресс считает mania-tracker по твоим играм"));
    await fire($("rec-mode").children[0]);
});

test("copy from mania-tracker once a profile is loaded there; back to manual keeps the editor's profile", async () => {
    await fire(chip("rec-source", "С mania-tracker"));
    assert.equal(getProfile().manual, undefined, "the tracker source: no hand-set profile in use");
    assert.equal($("mar-profile").textContent, "Профиль не загружен — загрузи его во вкладке «Подбор» (или задай там свой уровень вручную) либо выбери дан ниже.");
    $("rec-user").value = "TestPlayer";
    await fire($("rec-load"));
    assert.equal($("rec-skill").children[0].textContent, "TestPlayer · общий дан Delta low (13.66) · 585 игр");
    await fire(chip("rec-source", "Вручную"));
    assert.equal(getProfile().manual, true);
    assert.equal($("rec-manual-copy").disabled, false);
    await fire($("rec-manual-copy"));
    assert.deepEqual(saved(), { name: "Мира", speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 });
    assert.deepEqual(rows().map((r) => `${r.children[1].value} ${r.children[2].value}`), ["14 mid/high", "13 high", "13 mid/high", "14 low/mid"]);
    assert.equal($("rec-manual-status").textContent, "Даны взяты из профиля TestPlayer — поправь, если нужно");
    // with a tracker player loaded, its plays can be hidden in manual mode too
    assert.equal($("rec-hide-played").disabled, false);
});
