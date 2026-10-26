// Run with: npx electron tests/smoke/electron-manual-skill.mjs <out-dir> [lang=en]   (SMOKE_LANG=en works too)
// The hand-set skill profile (no mania-tracker account) through the real window, fully offline: the picks tab's
// «Вручную» editor (Speed / Jack / Stamina / Tech), a picks search and a plan on the real handlers over a fake
// tracker that answers from tests/fixtures/mt, progress saying it needs mania-tracker, the auto-marathon "by profile"
// on its real handler, and the analysis card's "for you". Then "copy from mania-tracker" with a fake tracker player.
// The window may not reach the network at all: every http(s) request is cancelled and fails the run. Covers are
// stripped from the fixture, so no card asks for one. userData lives in <out-dir>/user-data. Exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRecommendHandlers } from "../../app/recommendIpc.js";
import { createMarathonAutoHandlers } from "../../app/marathonAutoIpc.js";
import { createRecommender } from "../../src/recommend/recommend.js";
import { createPlanner } from "../../src/recommend/plan.js";
import { numericToLabel } from "../../src/core/labels.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-manual-skill.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "manual-skill-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, "user-data"), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "user-data"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};

const fixture = (name) => JSON.parse(readFileSync(path.join(here, "..", "fixtures", "mt", `${name}.json`), "utf8"));
// no covers: nothing on a card asks the network for an image
const noCovers = (item) => ({ ...item, covers: null, diffs: (item.diffs ?? []).map((d) => ({ ...d, covers: null })) });
const SEARCH = fixture("search").items.map(noCovers);
const SKILLS = fixture("skills");
// "Speed Delta mid/high · Stamina Gamma mid/high · Tech Delta low/mid · Jack Gamma high"
const MINE = { name: "TestPlayer", speed: 14.2, jack: 13.4, stamina: 13.2, tech: 13.8 };

// A tracker that never leaves the machine: the fixtures' search for every window, the fixtures' skills for one player.
const asked = { search: 0, played: 0, skills: 0 };
const fakeTracker = {
    async findUser(q) { return { id: 1234567, username: String(q), avatarUrl: null }; },
    async skills() { asked.skills += 1; return SKILLS; },
    async playedMaps() { asked.played += 1; return new Map(); },
    async searchMaps(params) {
        asked.search += 1;
        return { items: params.page === 0 ? SEARCH : [], total: SEARCH.length, page: params.page, pageSize: params.pageSize };
    },
    async recent() { return []; },
    async skillHistory() { return { items: [] }; },
};

app.whenReady().then(async () => {
    const blocked = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const offline = /^(file|devtools|data|blob|chrome|about):/i.test(details.url);
        if (!offline) blocked.push(details.url);
        callback({ cancel: !offline });
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });

    const recommender = createRecommender({ api: fakeTracker });
    const handlers = createRecommendHandlers({
        recommender, analyze: async () => ({}), fetchText: async () => { throw new Error("offline"); },
        openExternal: async () => {}, fetchProfile: async () => null, log: (l) => console.log("log", l),
        planner: createPlanner({ api: fakeTracker, recommender, pages: 1 }), searchMaps: (p) => fakeTracker.searchMaps(p),
    });
    let ensures = 0;
    let progressAsks = 0;
    // main holds no tracker profile until the player loads one in the picks tab
    const profile = { current: () => { const p = recommender.currentPlayer(); return p ? { ok: true, player: p, skill: p.skill } : { ok: false }; } };
    ipcMain.handle("profile-get", () => profile.current());
    ipcMain.handle("profile-ensure", () => { ensures += 1; return profile.current().ok ? profile.current() : { ok: false, reason: "none" }; });
    ipcMain.handle("rec-player", (_e, q) => handlers.player(q));
    ipcMain.handle("rec-me", () => ({ ok: false, message: t("app.rec.notLoggedIn") }));
    ipcMain.handle("rec-start", (_e, req) => handlers.start(req));
    ipcMain.handle("rec-more", () => handlers.more());
    ipcMain.handle("rec-plan", (_e, req) => handlers.plan(req));
    ipcMain.handle("rec-plan-swap", (_e, req) => handlers.planSwap(req));
    ipcMain.handle("rec-progress", () => { progressAsks += 1; return { ok: false, message: t("core.rec.needProfile") }; });
    ipcMain.handle("rec-fav-list", () => ({ ok: true, items: [] }));
    // the auto-marathon's real request check; the pick itself is faked (no search, no download, no rate)
    const autoRuns = [];
    const marathon = createMarathonAutoHandlers({
        auto: { run: async (request) => { autoRuns.push(request); return { entries: [], warnings: [] }; } },
        profile, log: (l) => console.log("log", l),
    });
    ipcMain.handle("marathon-auto", (_e, req) => marathon.start(req));
    ipcMain.handle("marathon-auto-cancel", () => marathon.cancel());
    ipcMain.handle("analysis-rate", async (_e, { rate }) => ({ ok: true, rate, kind: "ok", label: "", numeric: Math.round((13.7 + (rate - 1) * 3.4) * 10) / 10 }));

    const win = new BrowserWindow({ width: 460, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.log("console", level, msg); });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 10000) => {
        for (let waited = 0; waited < ms; waited += 200) {
            if (await js(code)) return true;
            await sleep(200);
        }
        return false;
    };
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const chip = (key) => js(`[...document.querySelectorAll("#recommend-tab span")].find((s) => s.textContent.trim() === ${JSON.stringify(t(key))}).click(); true`);
    const tab = (name) => js(`document.querySelector('[data-tab=${name}]').click(); true`);
    const scrollTo = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" }); true`);
    const sideways = () => js(`document.documentElement.scrollWidth - innerWidth`);

    // ---- the editor: start in manual mode with nothing saved, then set the four axes ----
    await js(`localStorage.clear()`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await tab("recommend");
    await chip("recommend.source.manual");
    await sleep(200);
    const setAxis = (axis, dan) => {
        const near = numericToLabel(dan);
        const step = ["low", "low/mid", "mid", "mid/high", "high"].find((s) => near.text.endsWith(` ${s}`));
        return js(`(() => { const l = document.getElementById("rec-axis-${axis}-level"), s = document.getElementById("rec-axis-${axis}-step");
            l.value = "${near.level}"; s.value = "${step}"; s.dispatchEvent(new Event("change")); return true; })()`);
    };
    for (const axis of ["speed", "jack", "stamina", "tech"]) await setAxis(axis, MINE[axis]);
    await js(`(() => { const n = document.getElementById("rec-manual-name"); n.value = ${JSON.stringify(MINE.name)}; n.dispatchEvent(new Event("input")); return true; })()`);
    const saved = await js(`JSON.parse(localStorage.getItem("rec-settings")).manualProfile`);
    check(JSON.stringify(saved) === JSON.stringify(MINE), `profile saved: ${JSON.stringify(saved)}`);
    const summary = await text("rec-skill");
    console.log("summary:", summary.replace(/\n/g, " | "));
    check(summary.includes(`${MINE.name} · ${t("recommend.skill.overall", { label: "Delta low", dan: "13.65" })} · ${t("recommend.manual.tag")}`), "summary line with the overall dan, set by hand");
    check(summary.includes("Speed Delta mid/high · Stamina Gamma mid/high · Tech Delta low/mid · Jack Gamma high"), "the four axes in the summary");
    check(await js(`document.getElementById("rec-manual").innerText.includes(${JSON.stringify(t("recommend.html.manualIntro").slice(0, 20))})`), "the no-tracker intro is shown");
    check(await js(`document.getElementById("rec-manual-copy").disabled`), "nothing to copy without a tracker profile");
    check(await js(`document.getElementById("rec-hide-played").disabled`), "no plays to hide");
    check((await sideways()) <= 0, "the editor fits the window");
    await shot("1-editor.png");

    // ---- picks with the hand-set profile ----
    await chip("recommend.pattern.jumpstream");
    await chip("recommend.goal.growth");
    await js(`document.getElementById("rec-go").click(); true`);
    check(await waitFor(`document.querySelectorAll("#rec-list > *").length > 0 || document.getElementById("rec-status").textContent !== ${JSON.stringify(t("recommend.status.searching"))}`), "picks answered");
    const target = await text("rec-target");
    console.log("target:", target);
    check(target.includes(`13.20, ${t("recommend.manual.tag")}`) && target.includes("13.20–13.70"), "target: Stamina 13.20 set by hand → 13.20–13.70");
    const cards = await js(`document.querySelectorAll("#rec-list > *").length`);
    console.log("cards:", cards, "|", (await text("rec-list")).slice(0, 400).replace(/\n/g, " | "));
    check(cards > 0, `cards found (${cards})`);
    check(asked.played === 0, "no played maps asked without a tracker player");
    await scrollTo("#rec-goals");
    await shot("2-picks.png");

    // ---- plan ----
    await js(`document.getElementById("rec-mode").children[1].click(); true`);
    await js(`document.getElementById("rec-plan-go").click(); true`);
    check(await waitFor(`!document.getElementById("rec-plan-head").hidden || document.getElementById("rec-plan-status").textContent !== ""`), "plan answered");
    const head = await text("rec-plan-head");
    console.log("plan head:", head, "| status:", await text("rec-plan-status"));
    check(head.includes(`Stamina Gamma mid/high (${t("recommend.manual.tag")}) (13.20)`), "plan header: the tile, set by hand");
    await scrollTo("#rec-mode");
    await shot("3-plan.png");

    // ---- progress: needs mania-tracker ----
    await js(`document.getElementById("rec-mode").children[3].click(); true`);
    check(await waitFor(`document.getElementById("rec-progress-status").textContent === ${JSON.stringify(t("recommend.progress.needTracker"))}`), "progress says it needs mania-tracker");
    check(progressAsks === 0, "progress did not ask main");
    await shot("4-progress.png");
    await js(`document.getElementById("rec-mode").children[0].click(); true`);

    // ---- the auto-marathon by profile ----
    await tab("marathon");
    await sleep(300);
    await js(`(() => { const r = document.getElementById("mar-src-profile"); r.checked = true; r.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(200);
    const marProfile = await text("mar-profile");
    console.log("marathon profile:", marProfile);
    check(marProfile.includes(`${MINE.name} (${t("recommend.manual.tag")})`), "marathon names the hand-set profile");
    check(await js(`document.getElementById("mar-skip-played").disabled`), "skip played is off with a hand-set profile");
    await js(`document.getElementById("mar-pick").click(); true`);
    check(await waitFor(`!document.getElementById("mar-pick").disabled`), "marathon pick answered");
    console.log("marathon status:", await text("mar-auto-status"), "| run:", JSON.stringify(autoRuns[0] ?? null));
    check(autoRuns.length === 1, "the real auto-marathon handler accepted the hand-set profile");
    check(autoRuns[0]?.targets?.length > 0, `marathon targets ${JSON.stringify(autoRuns[0]?.targets)}`);
    await scrollTo("#mar-profile");
    await shot("5-marathon.png");

    // ---- analysis «for you» ----
    await tab("analysis");
    const view = { screen: "result", key: "smoke@1.000", result: {
        kind: "ok", label: "Gamma high", numeric: 13.7, halfWidth: 0.3, confidence: "high", primary: "Jumpstream",
        top3: [{ name: "Jumpstream", share: 0.5 }, { name: "Handstream", share: 0.2 }], tech: false, bpm: 190, durationSec: 150, rate: 1,
        calcs: { mixed: 13.6, daniel: 13.5, azusa: 13.8, roxy: 13.7, companella: 13.4 }, sunny: 5.9,
        msd: { overall: 27, stream: 25, jumpstream: 27.5, handstream: 24, stamina: 25, jackspeed: 18, chordjack: 21, technical: 25 } } };
    win.webContents.send("view", view);
    const forYou = t("analysis.fit.title", { name: "" }).split("(")[0].trim().toUpperCase();
    check(await waitFor(`document.querySelector(".an-foryou")?.innerText.includes(${JSON.stringify(t("recommend.manual.tag"))})`), "analysis «for you» shows the hand-set profile");
    const fit = await js(`document.querySelector(".an-foryou")?.innerText ?? ""`);
    console.log("for you:", fit.replace(/\n/g, " | "));
    check(fit.includes("Stamina") && fit.includes("13.2") && fit.includes("+0.5"), `for you: Stamina 13.2, map +0.5 (${forYou})`);
    await js(`document.getElementById("card").scrollTop = 1e6; true`);
    const [w, h] = win.getSize();
    win.setSize(w + 1, h);
    await sleep(150);
    win.setSize(w, h);
    await shot("6-analysis.png");

    // ---- copy from mania-tracker (a fake tracker player) ----
    await tab("recommend");
    await chip("recommend.source.tracker");
    await js(`document.getElementById("rec-user").value = "TestPlayer"; document.getElementById("rec-load").click(); true`);
    check(await waitFor(`document.getElementById("rec-skill").innerText.includes("TestPlayer")`), "tracker profile loaded (fake)");
    await chip("recommend.source.manual");
    await sleep(200);
    check(!(await js(`document.getElementById("rec-manual-copy").disabled`)), "copy is offered once a tracker profile is loaded");
    await js(`document.getElementById("rec-axis-tech-level").value = "16"; document.getElementById("rec-axis-tech-level").dispatchEvent(new Event("change")); true`);
    await js(`document.getElementById("rec-manual-copy").click(); true`);
    await sleep(200);
    const copied = await js(`JSON.parse(localStorage.getItem("rec-settings")).manualProfile`);
    console.log("copied:", JSON.stringify(copied), "|", await text("rec-manual-status"));
    check(copied.tech === 13.8 && copied.speed === 14.2 && copied.jack === 13.4 && copied.stamina === 13.2, "copied the tracker's tiles onto the picker");
    await scrollTo("#recommend-tab");
    await shot("7-copied.png");

    if (lang === "en") {
        const cyr = await js(`(document.getElementById("recommend-tab").innerText.match(/[А-Яа-яЁё][^\\n]{0,40}/g) || []).join(" ‖ ")`);
        check(!cyr, `no Russian on the picks tab in English (${cyr || "none"})`);
    }
    console.log("tracker asks:", JSON.stringify(asked), "profile-ensure:", ensures);
    check(blocked.length === 0, `no network from the window (${blocked.join(", ") || "none"})`);
    app.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});
