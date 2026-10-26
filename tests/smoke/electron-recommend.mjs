// Run with: npx electron tests/smoke/electron-recommend.mjs <out-dir> [user]   (SMOKE_LANG=en runs it in English)
// Live check of the "Подбор" tab: real mania-tracker API, real analysis worker, screenshots of each step; then the
// plan, similar maps, favourites (with the collection.db export) and progress modes.
//   SMOKE_MODES_ONLY=1  no network at all: the picks come from the test fixtures, the other modes from stubs
//   SMOKE_LIVE=1        the other modes run on the real handlers too (tracker searches, osu.ppy.sh .osu files)
//   SMOKE_CLIENT=lazer  tosu "reads" osu! lazer: the export must also write the list for lazer and say why (exit 1 if not)
// Electron's user data (the window's localStorage, the favourites) goes to <out-dir>/user-data, never the app's own.
// Downloads are faked and nothing is opened in osu!; the export writes to <out-dir>/docs/коллекции.
import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRecommendHandlers } from "../../app/recommendIpc.js";
import { createFavHandlers } from "../../app/recFavIpc.js";
import { createProgressHandlers } from "../../app/recProgressIpc.js";
import { createRecStore } from "../../app/recStore.js";
import { createRecommender } from "../../src/recommend/recommend.js";
import { createTrackerApi } from "../../src/recommend/tracker.js";
import { createPlanner } from "../../src/recommend/plan.js";
import { rankSets } from "../../src/recommend/rank.js";
import { targetFor, readSkill } from "../../src/recommend/skill.js";
import { readRecent, readHistory, dailyPoints, skillChange, joinPicks, DAY_MS } from "../../src/recommend/progress.js";
import { decodeCollectionDb } from "../../src/recommend/collectionDb.js";
import { createWorkerClient } from "../../app/workerClient.js";
import { fetchProfile } from "../../app/tosuClient.js";
import { TOSU_PORT } from "../../app/tosuManager.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const fixture = (name) => JSON.parse(readFileSync(path.join(here, "..", "fixtures", "mt", `${name}.json`), "utf8"));
const [outArg, userArg] = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-recommend.mjs")) + 1);
const outDir = path.resolve(outArg ?? path.join(here, "rec-out"));
const user = userArg ?? "TestPlayer";
const modesOnly = process.env.SMOKE_MODES_ONLY === "1";
const live = process.env.SMOKE_LIVE === "1" && !modesOnly;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
// every run starts with no favourites, no journal and no export of an earlier run
for (const old of ["user-data/favourites.json", "user-data/picks.json", "docs"]) rmSync(path.join(outDir, old), { recursive: true, force: true });

// Main-process texts (recommendIpc, the recommender) follow the language like main.js does; the page asks get-lang.
const lang = setLang(process.env.SMOKE_LANG === "en" ? "en" : "ru");
// The page's texts are found by their keys, so the run works in either language.
const said = (key, params) => JSON.stringify(t(key, params));
const HOLE = "\u0001";
const before = (key, slot) => t(key, { [slot]: HOLE }).split(HOLE)[0];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// page code that builds a RegExp from regex sources
const regex = (...sources) => `new RegExp(${JSON.stringify(sources.join("|"))})`;

// ---- offline data: the fixtures as cards, a plan, a progress answer ----

const SKILL = readSkill(fixture("skills"));
function fixtureCards() {
    const target = targetFor({ skill: null, manualDan: 12.3, patternId: "jumpstream", goalId: "comfort" });
    return { target, cards: rankSets(fixture("search").items, { ...target, lo: 11.5, hi: 13.5 }) };
}

function stubPlan() {
    const { cards } = fixtureCards();
    const roles = ["warmup", "warmup", "growth", "growth", "challenge"];
    const slots = roles.map((role, i) => ({ role, patternId: "jumpstream", lo: 12 + i * 0.3, hi: 12.3 + i * 0.3, center: 12.15 + i * 0.3, card: cards[i] ?? null }));
    return {
        ok: true,
        header: { playerDan: 13.26, label: "Gamma mid/high", tile: "Stamina", source: "tile", patternId: "jumpstream" },
        slots, totalSec: cards.slice(0, 5).reduce((s, c) => s + c.lengthSec, 0), playedPartial: false,
    };
}

function stubProgress(days) {
    const now = Date.parse("2026-10-25T18:00:00Z");
    const since = now - days * DAY_MS;
    const at = (iso) => Date.parse(iso);
    const picks = [
        { beatmapId: 770548, beatmapsetId: 1, artist: "Various", title: "Yolomania", version: "[4K] 1", at: at("2026-10-25T12:00:00Z") },
        { beatmapId: 4766898, beatmapsetId: 2, artist: "Camellia", title: "Some song", version: "[4K] x", at: at("2026-10-18T00:00:00Z") },
        { beatmapId: 42, beatmapsetId: 3, artist: "Someone", title: "Not played yet", version: "[4K] y", at: at("2026-10-24T00:00:00Z") },
    ].filter((p) => p.at >= since);
    const joined = joinPicks(picks, readRecent(fixture("recent")), new Map());
    const points = dailyPoints(readHistory(fixture("history")).items, since);
    return { ok: true, since, picks: joined, played: joined.filter((p) => p.play).length, total: joined.length, points, change: skillChange(points), partial: false };
}

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    const worker = modesOnly ? null : createWorkerClient({ spawn: () => utilityProcess.fork(path.join(appDir, "analysisWorker.js")) });
    const opened = [];
    let win = null;
    // the download is faked (no .osz leaves a mirror): progress in four steps, then "opened in osu!"
    const fakeDownloader = {
        async download({ beatmapsetId, onProgress }) {
            for (const part of [1, 2, 3, 4]) {
                await sleep(250);
                onProgress({ received: part * 6e6, total: 24e6, mirror: "osu.direct" });
            }
            return { file: path.join(outDir, `${beatmapsetId}.osz`), mirror: "osu.direct", bytes: 24e6, reused: false };
        },
    };
    const trackerApi = createTrackerApi();
    const recommender = createRecommender({ api: trackerApi });
    const store = createRecStore({ dir: path.join(outDir, "user-data") });
    const log = (line) => console.log("log", line);
    const handlers = createRecommendHandlers({
        recommender,
        analyze: (osuText, rate) => worker.analyze(osuText, rate),
        fetchText: async (url) => {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(t("app.rec.noOsuFile"));
            return res.text();
        },
        openExternal: async (url) => { opened.push(url); },
        fetchProfile: () => fetchProfile(TOSU_PORT),
        log,
        downloader: fakeDownloader,
        openPath: async (file) => { opened.push(file); return ""; },
        showFile: (file) => opened.push(`show ${file}`),
        progress: (event) => win?.webContents.send("rec-download-progress", event),
        store,
        planner: createPlanner({ api: trackerApi, recommender }),
        searchMaps: (params) => trackerApi.searchMaps(params),
    });
    const favourites = createFavHandlers({
        store,
        docsDir: () => path.join(outDir, "docs"),
        fetchBytes: async (url) => {
            if (!live) return Buffer.from(`osu file format v14\n[HitObjects]\n${url}\n`);
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(t("app.rec.noOsuFile"));
            return Buffer.from(await res.arrayBuffer());
        },
        log,
        progress: (event) => win?.webContents.send("rec-fav-export-progress", event),
        cardFor: handlers.cardFor,
        onAdded: (card) => handlers.journal(card, "fav"),
        client: () => process.env.SMOKE_CLIENT ?? null,
        onExported: (file) => handlers.allowShow(file),
    });
    const progress = createProgressHandlers({ store, trackerApi, recommender, log });

    if (modesOnly) {
        // the picks without the network: the fixture's cards
        ipcMain.handle("rec-player", async () => ({ ok: true, player: { id: 1234567, username: user, avatarUrl: null }, skill: SKILL }));
        ipcMain.handle("rec-me", async () => ({ ok: false, message: t("app.rec.notLoggedIn") }));
        ipcMain.handle("rec-start", async () => {
            const { target, cards } = fixtureCards();
            return { ok: true, target, cards, more: false, total: cards.length, playedPartial: false };
        });
        ipcMain.handle("rec-more", async () => ({ ok: true, cards: [], more: false }));
        ipcMain.handle("rec-ours", async () => ({ ok: true, ours: { label: "Gamma mid", numeric: 13, primary: "Jumpstream" }, rate: 1.05, rateLabel: "Gamma high", reason: null }));
    } else {
        ipcMain.handle("rec-player", (_e, q) => handlers.player(q));
        ipcMain.handle("rec-me", () => handlers.me());
        ipcMain.handle("rec-start", (_e, req) => handlers.start(req));
        ipcMain.handle("rec-more", () => handlers.more());
        ipcMain.handle("rec-ours", (_e, req) => handlers.ours(req));
    }
    ipcMain.handle("rec-open", (_e, req) => handlers.open(req));
    ipcMain.handle("rec-download", (_e, req) => handlers.download(req));
    ipcMain.handle("rec-show", (_e, file) => handlers.show(file));
    if (live) {
        ipcMain.handle("rec-plan", (_e, req) => handlers.plan(req));
        ipcMain.handle("rec-plan-swap", (_e, req) => handlers.planSwap(req));
        ipcMain.handle("rec-similar", (_e, req) => handlers.similar(req));
        ipcMain.handle("rec-progress", (_e, req) => progress.progress(req));
    } else {
        ipcMain.handle("rec-plan", async () => stubPlan());
        let swaps = 0;
        ipcMain.handle("rec-plan-swap", async () => ({ ok: true, card: { ...fixtureCards().cards[1], beatmapId: 900 + swaps, title: `Swapped in ${++swaps}` } }));
        const words = () => [t("recommend.similar.very"), t("recommend.similar.close"), t("recommend.similar.loose")];
        ipcMain.handle("rec-similar", async () => ({ ok: true, cards: fixtureCards().cards.slice(1, 4).map((c, i) => ({ ...c, sim: 0.85 - i * 0.15, simLabel: words()[i] })) }));
        ipcMain.handle("rec-progress", async (_e, req) => stubProgress(req?.days ?? 30));
    }
    // the favourites are real either way: a store in user-data, the export into <out-dir>/docs
    ipcMain.handle("rec-fav-list", () => favourites.list());
    ipcMain.handle("rec-fav-add", (_e, req) => favourites.add(req));
    ipcMain.handle("rec-fav-remove", (_e, req) => favourites.remove(req));
    ipcMain.handle("rec-fav-export", (_e, req) => favourites.exportDb(req));

    win = new BrowserWindow({ width: 460, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (_e, level, msg) => console.log("console", level, msg));
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    // a hidden window paints late: wait two frames and a little more, or the shot can be the previous frame
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 30000) => {
        for (let waited = 0; waited < ms; waited += 250) {
            if (await js(code)) return true;
            await sleep(250);
        }
        return false;
    };
    const secondCard = `[...document.querySelectorAll("#rec-list > *")][1]`;
    const buttonWith = (scope, key) => `[...${scope}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${said(key)})`;
    const scrollTo = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`);
    const failed = JSON.stringify(before("recommend.status.error", "message"));

    // start from default settings: clear what a previous run saved, then load the page again
    await js(`localStorage.removeItem("rec-settings"); localStorage.removeItem("rec-view")`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`document.querySelector('[data-tab=recommend]').click();`);
    await sleep(300);
    await shot("1-empty.png");

    await js(`document.getElementById("rec-user").value = ${JSON.stringify(user)};
        document.getElementById("rec-load").click();`);
    const overallDan = JSON.stringify(before("recommend.skill.overall", "label").trim());
    console.log("skill loaded", await waitFor(`document.getElementById("rec-skill").textContent.includes(${overallDan})`));
    console.log("skill:", await js(`document.getElementById("rec-skill").innerText`));

    await js(`document.getElementById("rec-go").click()`);
    const noCards = regex(escapeRe(before("recommend.status.error", "message")), escapeRe(t("recommend.status.empty")));
    console.log("cards", await waitFor(`document.querySelectorAll("#rec-list > *").length > 0 || ${noCards}.test(document.getElementById("rec-status").textContent)`));
    console.log("status:", await js(`document.getElementById("rec-status").innerText`));
    console.log("list:", (await js(`document.getElementById("rec-list").innerText`)).slice(0, 1500));
    await shot("2-results.png");

    if (!modesOnly) {
        await js(`${buttonWith("document.getElementById('rec-list')", "recommend.ours.button")}.click()`);
        const oursMain = JSON.stringify(before("recommend.ours.main", "result"));
        console.log("ours", await waitFor(`document.getElementById("rec-list").innerText.includes(${oursMain})
            || document.querySelector("#rec-list > *").querySelector(".bad") !== null`, 60000));
        console.log("first card:", await js(`document.querySelector("#rec-list > *").innerText`));
        await shot("3-ours.png");

        // the download button on the second card: progress text mid-way, then the opened line and the show-file button
        await js(`${secondCard}.querySelector("button.accent").click()`);
        const downloading = regex(t("recommend.download.progressPct", { pct: HOLE }).split(HOLE).map(escapeRe).join("\\d+"));
        await waitFor(`${downloading}.test(${secondCard}.innerText)`, 5000);
        console.log("downloading:", await js(`${secondCard}.querySelector("button.accent").textContent`));
        await shot("3b-downloading.png");
        const downloaded = regex(escapeRe(t("recommend.download.opened")), escapeRe(t("recommend.download.failed")));
        console.log("downloaded", await waitFor(`${downloaded}.test(${secondCard}.innerText)`, 10000));
        await js(`${buttonWith(secondCard, "recommend.download.show")}.click()`);
        await sleep(200);
        console.log("second card:", await js(`${secondCard}.innerText`));
        await shot("3c-downloaded.png");

        const more = await js(`!document.getElementById("rec-more").hidden`);
        if (more) {
            const count = await js(`document.querySelectorAll("#rec-list > *").length`);
            await js(`document.getElementById("rec-more").click()`);
            await waitFor(`document.querySelectorAll("#rec-list > *").length > ${count}`);
            console.log("after more:", count, "→", await js(`document.querySelectorAll("#rec-list > *").length`));
        }
        await js(`${buttonWith("document.getElementById('rec-list')", "recommend.page")}.click()`);
        await sleep(300);
        console.log("opened:", opened);

        // switch goal and pattern, manual mode
        const chip = (key) => `[...document.querySelectorAll("#recommend-tab span")].find((s) => s.textContent.trim() === ${said(key)}).click();`;
        await js(chip("recommend.source.manual"));
        await js(`${chip("recommend.pattern.chordjack")}
            ${chip("recommend.goal.challenge")}
            document.getElementById("rec-go").click();`);
        await sleep(500);
        console.log("manual", await waitFor(`!document.getElementById("rec-status").textContent.includes(${said("recommend.status.searching")})`));
        console.log("manual status:", await js(`document.getElementById("rec-status").innerText`));
        console.log("manual list:", (await js(`document.getElementById("rec-list").innerText`)).slice(0, 600));
        await shot("4-manual.png");
        // back to the profile for the plan
        await js(chip("recommend.source.tracker"));
    }

    // ---- the new modes ----
    const mode = (i) => js(`document.getElementById("rec-mode").children[${i}].click()`);
    const firstPlanCard = `document.querySelector("#rec-plan-list > .rec-card:not(.rec-empty)")`;

    await mode(1);
    await sleep(200);
    await js(`document.getElementById("rec-plan-go").click()`);
    console.log("plan", await waitFor(`document.querySelectorAll("#rec-plan-list > *").length > 0 || document.getElementById("rec-plan-status").textContent.includes(${failed})`, 60000));
    console.log("plan head:", await js(`document.getElementById("rec-plan-head").innerText`));
    console.log("plan status:", await js(`document.getElementById("rec-plan-status").innerText`));
    console.log("plan dans:", await js(`[...document.querySelectorAll("#rec-plan-list .rec-dan")].map((n) => n.title || n.textContent).join(" | ")`));
    await scrollTo("#rec-mode");
    await shot("5-plan.png");
    if (await js(`Boolean(${firstPlanCard})`)) {
        const firstTitle = await js(`${firstPlanCard}.querySelector(".rec-title").textContent`);
        await js(`${buttonWith(firstPlanCard, "recommend.plan.swap")}.click()`);
        console.log("swapped", await waitFor(`${firstPlanCard}.querySelector(".rec-title").textContent !== ${JSON.stringify(firstTitle)} || document.getElementById("rec-plan-status").textContent !== ""`, 10000),
            await js(`${firstPlanCard}.querySelector(".rec-title").textContent`), "|", await js(`document.getElementById("rec-plan-status").innerText`));
        await js(`${buttonWith(firstPlanCard, "recommend.similar.button")}.click()`);
        console.log("similar", await waitFor(`!${firstPlanCard}.querySelector(".rec-similar").innerText.includes(${said("recommend.similar.loading")})`, 30000));
        console.log("similar list:", await js(`${firstPlanCard}.querySelector(".rec-similar").innerText`));
        await scrollTo("#rec-plan-list .rec-similar:not([hidden])");
        await shot("5b-similar.png");
        // two stars: the favourites count goes up
        await js(`[...document.querySelectorAll("#rec-plan-list > .rec-card button.rec-star")].slice(0, 2).forEach((b) => b.click())`);
        console.log("starred", await waitFor(`document.querySelectorAll("#rec-plan-list button.rec-star.on").length >= 2`, 5000), await js(`document.getElementById("rec-mode").children[2].textContent`));
    }

    await mode(2);
    console.log("favourites", await waitFor(`document.querySelectorAll("#rec-fav-list > *").length > 0 || document.getElementById("rec-fav-status").textContent !== ""`, 5000));
    console.log("fav list:", await js(`document.getElementById("rec-fav-list").innerText`));
    await scrollTo("#rec-mode");
    await shot("6-favourites.png");
    await js(`document.getElementById("rec-fav-export").click()`);
    console.log("exported", await waitFor(`!document.getElementById("rec-fav-result").hidden`, 60000), await js(`document.getElementById("rec-fav-result").innerText`));
    try {
        const db = decodeCollectionDb(readFileSync(path.join(outDir, "docs", "коллекции", "collection.db")));
        console.log("collection.db:", JSON.stringify({ name: db.collections[0]?.name, hashes: db.collections[0]?.hashes }));
    } catch (error) {
        console.log("collection.db: none", error.message);
    }
    if (process.env.SMOKE_CLIENT === "lazer") {
        const note = await js(`document.getElementById("rec-fav-result").innerText`);
        const lists = readdirSync(path.join(outDir, "docs", "коллекции")).filter((f) => f.endsWith(".txt"));
        console.log("lazer export:", JSON.stringify({ lists, note }));
        if (!lists.length || !note.includes("lazer")) process.exitCode = 1;
    }
    await js(`${buttonWith("document.getElementById('rec-fav-result')", "recommend.download.show")}?.click()`);
    await sleep(200);
    await scrollTo("#rec-fav-name");
    await shot("6b-exported.png");

    await mode(3);
    console.log("progress", await waitFor(`document.getElementById("rec-progress-summary").textContent !== "" || document.getElementById("rec-progress-status").textContent.includes(${failed})`, 60000));
    console.log("progress status:", await js(`document.getElementById("rec-progress-status").innerText`));
    console.log("progress:", await js(`document.getElementById("rec-progress-pane").innerText`));
    await scrollTo("#rec-mode");
    await shot("7-progress.png");
    await js(`document.getElementById("rec-progress-days").children[0].click()`);
    await sleep(300);
    await waitFor(`!document.getElementById("rec-progress-status").textContent.includes(${said("recommend.progress.loading")})`, 30000);
    console.log("progress 7 days:", await js(`document.getElementById("rec-progress-summary").innerText`));
    console.log("opened:", opened);
    // nothing Russian left on screen in English
    if (lang === "en") console.log("cyrillic on screen:", await js(`(document.getElementById("recommend-tab").innerText.match(/[А-Яа-яЁё][^\\n]{0,40}/g) || []).join(" ‖ ") || "none"`));

    worker?.dispose();
    app.exit(process.exitCode ?? 0);
}).catch((error) => {
    // a failed step ends the run with an error instead of leaving electron hanging
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});
