// Run with: npx electron tests/smoke/electron-local-profile.mjs <out-dir> [lang=en]   (SMOKE_LANG=en works too)
// The local profile and the Profile tab through the real window, fully offline, on fixture data made here:
// a synthetic osu! folder (Songs with 4K charts of this repo's own generator, tests/fixtures/makeChart.js, and a
// scores.db of TestPlayer's plays, tests/fixtures/makeScoresDb.js) imported with the «Импорт из osu! stable» button
// (the real service, the real analyzer in-process), then one live play fed as tosu frames; «Мой профиль» (summary,
// patterns, history chart, top and recent plays), the mania-tracker page over the fixtures in tests/fixtures/mt,
// Picks with «Мой профиль» as its source (real handlers, the tracker's search from the fixture) and Picks' progress
// over the local plays. Checks the tab bar fits at 320 px. Every http(s) request is cancelled and fails the run.
// userData lives in <out-dir>/user-data. Exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRecommendHandlers } from "../../app/recommendIpc.js";
import { createProgressHandlers } from "../../app/recProgressIpc.js";
import { createRecommender } from "../../src/recommend/recommend.js";
import { createPlanner } from "../../src/recommend/plan.js";
import { createLocalProfileStore } from "../../app/localProfileStore.js";
import { createLocalProfileService } from "../../app/localProfileService.js";
import { createLocalProfileHandlers } from "../../app/localProfileIpc.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { createMarathonAutoHandlers } from "../../app/marathonAutoIpc.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { MOD_BITS } from "../../src/localProfile/scoresDb.js";
import { makeChart } from "../fixtures/makeChart.js";
import { makeScoresDb } from "../fixtures/makeScoresDb.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-local-profile.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "local-profile-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, "user-data"), { recursive: true, force: true });
rmSync(path.join(outDir, "osu"), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "user-data"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};
const md5 = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
const DAY = 86_400_000;
const NOW = Date.now();

// ---- the fixture osu! folder ----
const osuDir = path.join(outDir, "osu");
const CHARTS = [
    ...[300, 310, 320, 330, 340].map((bpm) => ({ kind: "stream", bpm })),
    ...[250, 260, 270, 280].map((bpm) => ({ kind: "jumpstream", bpm })),
    ...[175, 185, 195, 205].map((bpm) => ({ kind: "jack", bpm })),
];
const scores = [];
const texts = [];
for (const [i, c] of CHARTS.entries()) {
    const text = makeChart({ kind: c.kind, bpm: c.bpm, seconds: 100 + (i % 4) * 40 })
        .replace("Version:", `BeatmapID:${70000 + i}\r\nBeatmapSetID:${7000 + i}\r\nVersion:`)
        .replace(/^Title:.*$/m, `Title:Smoke ${c.kind} ${c.bpm}`).replace(/^Artist:.*$/m, "Artist:Fixture");
    texts.push(text);
    const dir = path.join(osuDir, "Songs", `${7000 + i} Fixture - Smoke ${c.kind} ${c.bpm}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `Fixture - Smoke ${c.kind} ${c.bpm} (Test) [x].osu`), text, "utf8");
    // three plays a chart over the last four months, better and better
    for (let j = 0; j < 3; j += 1) {
        const acc = 0.93 + 0.02 * j + (i % 3) * 0.005;
        const katu = Math.round((1 - acc) * 3 * 1200);
        scores.push({
            md5: md5(text), player: "TestPlayer", replayMd5: md5(`${i}:${j}`), geki: 1200 - katu - (2 - j) * 4, katu, miss: (2 - j) * 4,
            mods: j === 2 && i % 4 === 0 ? MOD_BITS.DT : 0, at: NOW - (120 - i * 6 - j * 25) * DAY, maxCombo: 600,
        });
    }
}
scores.push({ md5: md5(texts[0]), player: "Friend", replayMd5: md5("friend"), geki: 1200, at: NOW - 3 * DAY });
writeFileSync(path.join(osuDir, "scores.db"), makeScoresDb(scores));

const fixture = (name) => JSON.parse(readFileSync(path.join(here, "..", "fixtures", "mt", `${name}.json`), "utf8"));
const noCovers = (item) => ({ ...item, covers: null, diffs: (item.diffs ?? []).map((d) => ({ ...d, covers: null })) });
const SEARCH = fixture("search").items.map(noCovers);
const fakeTracker = {
    async findUser(q) { return { id: 1234567, username: String(q), avatarUrl: null }; },
    async skills() { return fixture("skills"); },
    async playedMaps() { return new Map(); },
    async searchMaps(params) { return { items: params.page === 0 ? SEARCH : [], total: SEARCH.length, page: params.page, pageSize: params.pageSize }; },
    async recent() { return fixture("recent"); },
    async skillHistory() { return fixture("history"); },
};

app.whenReady().then(async () => {
    const blocked = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const offline = /^(file|devtools|data|blob|chrome|about):/i.test(details.url);
        if (!offline) blocked.push(details.url);
        callback({ cancel: !offline });
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.on("tab", () => {});

    // the real local profile over the fixture folder; the analyzer runs in this process
    let liveText = texts[6];
    const analysed = [];
    const send = (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload); };
    const local = createLocalProfileService({
        store: createLocalProfileStore({ dir: path.join(outDir, "user-data", "local-profile") }),
        analyze: async (text, rate) => { analysed.push(rate); return analyzeChart(text, rate); },
        fetchMapText: async () => liveText,
        readFile: (f) => readFile(f),
        exists: async (f) => Boolean((await stat(f).catch(() => null))?.isFile()),
        songsIndex: createSongsMd5Index({ indexFile: path.join(outDir, "user-data", "local-profile", "songs-md5.json") }),
        defaultOsuFolder: osuDir, emit: send, log: (l) => console.log("log", l),
    });
    const opened = [];
    const lh = createLocalProfileHandlers({
        localProfile: local, shell: { openExternal: async (u) => opened.push(u) },
        recommender: null, trackerApi: fakeTracker, log: (l) => console.log("log", l),
    });
    for (const [channel, fn] of Object.entries({
        "local-profile-status": () => lh.status(), "local-profile-history": (_e, r) => lh.history(r),
        "local-profile-import": (_e, r) => lh.importHistory(r), "local-profile-import-cancel": () => lh.cancelImport(),
        "local-profile-record": (_e, r) => lh.setRecord(r), "local-profile-reset": () => lh.reset(),
        "local-profile-pick-osu": () => ({ ok: false, cancelled: true }), "local-profile-export": () => ({ ok: false, cancelled: true }),
        "local-profile-import-file": () => ({ ok: false, cancelled: true }),
    })) ipcMain.handle(channel, fn);

    const recommender = createRecommender({ api: fakeTracker, extraPlayed: () => local.playedBeatmaps() });
    const handlers = createRecommendHandlers({
        recommender, analyze: async () => ({}), fetchText: async () => { throw new Error("offline"); },
        openExternal: async () => {}, fetchProfile: async () => null, log: (l) => console.log("log", l),
        planner: createPlanner({ api: fakeTracker, recommender, pages: 1 }), searchMaps: (p) => fakeTracker.searchMaps(p),
        localSkill: () => local.skill(),
    });
    // tracker-recent / tracker-open-site over the fake tracker's player once loaded
    const lt = () => createLocalProfileHandlers({ localProfile: local, shell: { openExternal: async (u) => opened.push(u) }, recommender, trackerApi: fakeTracker });
    ipcMain.handle("tracker-recent", () => lt().trackerRecent());
    ipcMain.handle("tracker-open-site", () => lt().openTracker());
    const profile = { current: () => { const p = recommender.currentPlayer(); return p ? { ok: true, player: p, skill: p.skill } : { ok: false }; } };
    ipcMain.handle("profile-get", () => profile.current());
    ipcMain.handle("profile-ensure", () => (profile.current().ok ? profile.current() : { ok: false, reason: "none" }));
    ipcMain.handle("rec-player", (_e, q) => handlers.player(q));
    ipcMain.handle("rec-me", () => ({ ok: false, message: t("app.rec.notLoggedIn") }));
    ipcMain.handle("rec-start", (_e, req) => handlers.start(req));
    ipcMain.handle("rec-more", () => handlers.more());
    ipcMain.handle("rec-plan", (_e, req) => handlers.plan(req));
    ipcMain.handle("rec-fav-list", () => ({ ok: true, items: [] }));
    // the journal: two picks, one of them played in the fixture history
    const picks = [
        { beatmapId: 70001, beatmapsetId: 7001, artist: "Fixture", title: "Smoke stream 310", version: "x", dan: 12, danLabel: "", how: "download", at: NOW - 70 * DAY },
        { beatmapId: 2701201, beatmapsetId: 1302447, artist: "Jeff Williams", title: "Time to Say Goodbye", version: "[4K] Farewell", dan: 12.3, danLabel: "", how: "direct", at: NOW - 2 * DAY },
    ];
    const progress = createProgressHandlers({ store: { picks: { list: async () => picks } }, trackerApi: fakeTracker, recommender, localProfile: local });
    ipcMain.handle("rec-progress", (_e, req) => progress.progress(req));
    const marathon = createMarathonAutoHandlers({ auto: { run: async () => ({ entries: [], warnings: [] }) }, profile, localSkill: () => local.skill() });
    ipcMain.handle("marathon-auto", (_e, req) => marathon.start(req));
    ipcMain.handle("analysis-rate", async (_e, { rate }) => ({ ok: true, rate, kind: "ok", label: "", numeric: 13 }));

    const win = new BrowserWindow({ width: 320, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.log("console", level, msg); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 200) {
            if (await js(code)) return true;
            await sleep(200);
        }
        return false;
    };
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const tab = (name) => js(`document.querySelector('[data-tab=${name}]').click(); true`);
    const clickChip = (box, label) => js(`(() => { const c = [...document.querySelectorAll("#${box} span")].find((s) => s.textContent.trim() === ${JSON.stringify(label)}); c?.click(); return Boolean(c); })()`);
    const scrollTo = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" }); true`);
    const sideways = (id) => js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); return Math.max(document.documentElement.scrollWidth - innerWidth, s ? s.scrollWidth - s.clientWidth : 0); })()`);

    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`localStorage.clear(); localStorage.setItem("rec-settings", JSON.stringify({ source: "local" })); localStorage.setItem("profile-view", JSON.stringify({ page: "local" })); true`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));

    // ---- the tab bar at the default 320 px ----
    const barAt = () => js(`(() => { const n = document.querySelector(".tabs"); return { over: n.scrollWidth - n.clientWidth, labels: [...n.children].map((b) => b.textContent), heights: [...n.children].map((b) => b.offsetHeight), cut: [...n.children].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) }; })()`);
    const bar = await barAt();
    console.log("tabs:", JSON.stringify(bar));
    check(bar.labels.includes(t("profile.html.tab")), "the Profile tab is in the bar");
    check(bar.over <= 0, `the tab bar fits at 320 px (overflow ${bar.over})`);
    check(new Set(bar.heights).size === 1, "every tab is one line high");
    check(bar.cut.length === 0, `no tab label is cut (${bar.cut.join(", ") || "none"})`);
    await tab("profile");
    await sleep(500);
    await shot("1-profile-empty.png");
    check((await text("prof-local-card")).includes(t("profile.local.notEnough")), "an empty profile says it needs plays");

    // ---- import the history ----
    await js(`document.getElementById("prof-import-stable").click(); true`);
    check(await waitFor(`document.getElementById("prof-import-status").textContent.includes(${JSON.stringify(t("profile.import.done", { added: "", total: "" }).split(" ")[0])})`, 60000), "the import finished");
    console.log("import:", await text("prof-import-status"));
    const st = await local.status();
    console.log("skill:", JSON.stringify({ overall: st.skill.overall, tiles: st.skill.tiles, plays: st.counts }));
    check(st.counts.stable === CHARTS.length * 3, `all ${CHARTS.length * 3} of TestPlayer's scores imported, not Friend's (${st.counts.stable})`);
    check(Number.isFinite(st.skill.tiles.speed) && Number.isFinite(st.skill.tiles.jack) && Number.isFinite(st.skill.tiles.stamina), "Speed, Jack and Stamina have a dan");
    check(st.skill.tiles.tech === null, "Tech has too few plays (no tech chart in the fixture)");
    const analysedOnce = analysed.length;
    check(analysedOnce === CHARTS.length + CHARTS.filter((_, i) => i % 4 === 0).length, `each map analysed once per rate (${analysedOnce})`);

    // ---- one live play: tosu frames into the recorder ----
    const checksum = md5(liveText);
    const frame = (state, geki, katu = 0) => ({
        client: "stable", state: { number: state }, profile: { name: "TestPlayer" },
        beatmap: { checksum, id: 70006, set: 7006, artist: "Fixture", title: "Smoke jumpstream 260", version: "x", mode: { number: 3 } },
        play: { playerName: "TestPlayer", mode: { number: 3 }, mods: { name: "", array: [] }, hits: { geki, 300: 0, katu, 100: 0, 50: 0, 0: 0 }, combo: { max: geki } },
    });
    local.onTosuJson(frame(2, 20), 1000);
    await sleep(100);
    local.onTosuJson(frame(2, 1100, 40), 2000);
    local.onTosuJson(frame(7, 1100, 40), 2100);
    check(await waitFor(`document.getElementById("prof-local-recent").innerText.includes("Smoke jumpstream 260") && document.getElementById("prof-local-counts").innerText.includes(${JSON.stringify(t("profile.local.fromLive", { n: 1 }))})`), "the live play shows up in recent plays");
    check(analysed.length === analysedOnce, "the live play's map (already imported) was not analysed again");
    await scrollTo("#profile-tab");
    const card = await text("prof-local-card");
    console.log("card:", card.replace(/\n/g, " | "));
    check(card.includes("Speed") && card.includes("±"), "the summary has the axes with a ± range");
    check((await sideways("profile-tab")) <= 0, "the profile page fits the window");
    await shot("2-profile-local.png");
    await scrollTo("#prof-local-patterns");
    const table = await text("prof-local-patterns");
    console.log("patterns:", table.replace(/\n/g, " | "));
    check(table.includes(t("recommend.pattern.jumpstream")) && table.includes(t("profile.local.fewPlays")), "the pattern table: dans and «not enough plays»");
    await shot("3-profile-patterns.png");
    // the history chart over a year, Speed
    await clickChip("prof-local-days", t("recommend.progress.days", { n: 365 }));
    await sleep(500);
    await clickChip("prof-local-axes", "Speed");
    await sleep(300);
    check(await js(`Boolean(document.querySelector("#prof-local-chart svg path"))`), "the history chart is drawn");
    await scrollTo("#prof-local-days");
    await shot("4-profile-history.png");
    await scrollTo("#prof-top-axis");
    check((await text("prof-local-top")).includes("→"), "top plays show map dan → performance");
    await shot("5-profile-top.png");
    await scrollTo("#prof-import-stable");
    await shot("6-profile-import.png");

    // ---- the mania-tracker page ----
    await clickChip("prof-pages", t("profile.page.tracker"));
    await sleep(300);
    await js(`document.getElementById("prof-user").value = "TestPlayer"; document.getElementById("prof-load").click(); true`);
    check(await waitFor(`document.getElementById("prof-tracker-card").innerText.includes("TestPlayer")`), "tracker profile loaded (fake)");
    check(await waitFor(`document.getElementById("prof-tracker-recent").children.length > 1`), "the tracker's recent plays");
    check(await waitFor(`Boolean(document.querySelector("#prof-tracker-chart svg path"))`), "the tracker's history chart");
    const tcard = await text("prof-tracker-card");
    console.log("tracker:", tcard.replace(/\n/g, " | "));
    check(tcard.includes("Stream 34.62"), "the MinaCalc ratings");
    await js(`document.getElementById("prof-tracker-site").click(); true`);
    await sleep(200);
    check(opened[0] === "https://mania-tracker.com/player/1234567", `the site link (${opened[0]})`);
    await scrollTo("#profile-tab");
    await shot("7-profile-tracker.png");
    await scrollTo("#prof-tracker-more");
    await shot("8-profile-tracker-more.png");
    // the compare block on my profile now that a tracker profile is loaded
    await clickChip("prof-pages", t("profile.page.local"));
    check(await waitFor(`!document.getElementById("prof-compare").hidden`), "compare with mania-tracker");

    // ---- Picks with «Мой профиль» ----
    await tab("recommend");
    await sleep(400);
    check(await js(`[...document.querySelectorAll("#rec-source span")].find((s) => s.classList.contains("sel"))?.textContent === ${JSON.stringify(t("profile.source.local"))}`), "Picks' source is «Мой профиль»");
    const summary = await text("rec-skill");
    console.log("picks summary:", summary.replace(/\n/g, " | "));
    check(summary.includes(t("profile.local.tag")), "Picks shows the local profile");
    await clickChip("rec-patterns", t("recommend.pattern.jumpstream"));
    await clickChip("rec-goals", t("recommend.goal.growth"));
    await js(`document.getElementById("rec-go").click(); true`);
    check(await waitFor(`document.querySelectorAll("#rec-list > *").length > 0 || document.getElementById("rec-status").textContent !== ${JSON.stringify(t("recommend.status.searching"))}`), "picks answered");
    const target = await text("rec-target");
    console.log("target:", target, "| status:", await text("rec-status"));
    check(target.includes(t("profile.local.tag")), "the target names the local profile");
    await scrollTo("#recommend-tab");
    await shot("9-picks-local.png");
    // Picks' progress over the local plays
    await js(`[...document.getElementById("rec-mode").children].find((b) => b.textContent.trim() === ${JSON.stringify(t("recommend.mode.progress"))}).click(); true`);
    check(await waitFor(`document.getElementById("rec-progress-summary").textContent !== ""`), "Picks' progress answered");
    await clickChip("rec-progress-days", t("recommend.progress.days", { n: 90 }));
    check(await waitFor(`document.getElementById("rec-progress-list").innerText.includes("Smoke stream 310")`), "Picks' progress over 90 days");
    await sleep(300);
    console.log("progress:", (await text("rec-progress-summary")), "|", (await text("rec-progress-list")).replace(/\n/g, " | "));
    check((await text("rec-progress-list")).includes("✓"), "the picked map played in the history is ticked");
    await shot("10-picks-progress.png");
    await js(`[...document.getElementById("rec-mode").children][0].click(); true`);

    // ---- the auto-marathon by profile ----
    await tab("marathon");
    await sleep(300);
    const mar = await text("mar-profile");
    console.log("marathon:", mar);
    check(mar.includes(t("profile.local.name")), "the marathon names the local profile");

    if (lang === "en") {
        await tab("profile");
        await sleep(500);
        const cyr = await js(`(document.getElementById("profile-tab").innerText.match(/[А-Яа-яЁё][^\\n]{0,40}/g) || []).join(" ‖ ")`);
        check(!cyr, `no Russian on the Profile tab in English (${cyr || "none"})`);
    }
    // a narrow window: the tab labels may wrap, nothing scrolls sideways
    for (const width of [260, 240, 220]) {
        win.setContentSize(width, 900);
        await sleep(300);
        await tab("profile");
        await sleep(300);
        const narrow = await barAt();
        check(narrow.over <= 0 && narrow.cut.length === 0, `the tab bar fits at ${width} px (${narrow.over}, cut: ${narrow.cut.join(", ") || "none"})`);
        if (width === 240) await shot("11-narrow.png");
    }
    // compact mode: the tab bar goes, as for every tab
    win.setContentSize(320, 900);
    win.webContents.send("settings", { alwaysOnTop: false, compact: true, lang });
    await sleep(300);
    check(await js(`getComputedStyle(document.querySelector(".tabs")).display === "none"`), "compact mode hides the tab bar");
    win.webContents.send("settings", { alwaysOnTop: false, compact: false, lang });
    await sleep(200);
    await tab("profile");
    await scrollTo("#prof-local-days");
    await shot("12-tabs-and-chart.png");
    check(blocked.length === 0, `no network from the window (${blocked.join(", ") || "none"})`);
    app.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});
