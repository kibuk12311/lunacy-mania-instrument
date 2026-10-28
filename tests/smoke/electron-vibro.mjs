// Run with: npx electron tests/smoke/electron-vibro.mjs <out-dir> [lang=en]
// The vibro mark through the real window, offline, on fixture data made here (no real maps, no real player): a
// synthetic osu! folder (Songs with charts of tests/fixtures/makeChart.js and one vibro chart of
// tests/fixtures/makeVibroChart.js, a scores.db of TestPlayer's plays) imported with «Импорт из osu! stable» (the real
// service, the real analyzer in-process); «Мой профиль» says how many plays were left out and marks the vibro plays,
// and its dans are the ones without them; then the card (the real selection controller over the same analyzer) shows
// the vibro chip with its tooltip on the vibro chart and none on a normal one. userData lives in <out-dir>/user-data;
// screenshots vibro-*.png go to <out-dir>. Every http(s) request is cancelled. Exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalProfileStore } from "../../app/localProfileStore.js";
import { createLocalProfileService } from "../../app/localProfileService.js";
import { createLocalProfileHandlers } from "../../app/localProfileIpc.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { createSelectionController } from "../../app/selectionController.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { skillFromPlays } from "../../src/localProfile/model.js";
import { makeChart } from "../fixtures/makeChart.js";
import { makeScoresDb } from "../fixtures/makeScoresDb.js";
import { chartOf, stream, jack, after } from "../fixtures/makeVibroChart.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-vibro.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "vibro-out"));
const lang = setLang(args.includes("lang=en") ? "en" : "ru");
mkdirSync(outDir, { recursive: true });
const userData = path.join(outDir, `user-data-${lang}`);
const osuDir = path.join(outDir, `osu-${lang}`);
rmSync(userData, { recursive: true, force: true });
rmSync(osuDir, { recursive: true, force: true });
app.setPath("userData", userData); // never the real app's folder
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
// 1/4 rolls at 160 BPM with 64-row jumpjacks at 80 ms (1/4 at 188 BPM) between them, both hands in turn: vibro
function vibroChart() {
    const rows = [];
    let at = 1000;
    for (let i = 0; i < 8; i += 1) {
        const s = stream(at, 96, 93.75);
        const j = jack(after(s, 93.75), 64, 80, i % 2 ? [2, 3] : [0, 1]);
        rows.push(...s, ...j);
        at = after(j, 93.75);
    }
    return chartOf(rows, { title: "Smoke vibro dump" });
}
const CHARTS = [
    ...[250, 260, 270, 280].map((bpm) => ({ kind: "jumpstream", bpm })),
    ...[300, 310, 320].map((bpm) => ({ kind: "stream", bpm })),
    ...[175, 185, 195].map((bpm) => ({ kind: "jack", bpm })),
];
const texts = [];
const scores = [];
const addChart = (text, i, plays) => {
    const withIds = text.replace("Version:", `BeatmapID:${80000 + i}\r\nBeatmapSetID:${8000 + i}\r\nVersion:`).replace(/^Artist:.*$/m, "Artist:Fixture");
    texts.push(withIds);
    const dir = path.join(osuDir, "Songs", `${8000 + i} Fixture - Smoke ${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `Fixture - Smoke ${i} (TestPlayer) [x].osu`), withIds, "utf8");
    for (let j = 0; j < plays; j += 1) {
        const acc = 0.955 + 0.01 * j;
        const katu = Math.round((1 - acc) * 3 * 1500);
        scores.push({ md5: md5(withIds), player: "TestPlayer", replayMd5: md5(`${i}:${j}`), geki: 1500 - katu, katu, at: NOW - (60 - i * 4 - j) * DAY, maxCombo: 900 });
    }
};
for (const [i, c] of CHARTS.entries()) {
    addChart(makeChart({ kind: c.kind, bpm: c.bpm, seconds: 120 }).replace(/^Title:.*$/m, `Title:Smoke ${c.kind} ${c.bpm}`), i, 2);
}
const VIBRO_INDEX = CHARTS.length;
addChart(vibroChart(), VIBRO_INDEX, 3);
const vibroText = texts[VIBRO_INDEX];
mkdirSync(osuDir, { recursive: true });
writeFileSync(path.join(osuDir, "scores.db"), makeScoresDb(scores));

app.whenReady().then(async () => {
    const blocked = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const offline = /^(file|devtools|data|blob|chrome|about):/i.test(details.url);
        if (!offline) blocked.push(details.url);
        callback({ cancel: !offline });
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.on("tab", () => {});
    const send = (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload); };
    const local = createLocalProfileService({
        store: createLocalProfileStore({ dir: path.join(userData, "local-profile") }),
        analyze: (text, rate) => analyzeChart(text, rate),
        readFile: (f) => readFile(f),
        exists: async (f) => Boolean((await stat(f).catch(() => null))?.isFile()),
        songsIndex: createSongsMd5Index({ indexFile: path.join(userData, "local-profile", "songs-md5.json") }),
        defaultOsuFolder: osuDir, emit: send, log: (l) => console.log("log", l),
    });
    const lh = createLocalProfileHandlers({ localProfile: local, recommender: null, trackerApi: null, log: (l) => console.log("log", l) });
    for (const [channel, fn] of Object.entries({
        "local-profile-status": () => lh.status(), "local-profile-history": (_e, r) => lh.history(r),
        "local-profile-import": (_e, r) => lh.importHistory(r), "local-profile-import-cancel": () => lh.cancelImport(),
        "local-profile-record": (_e, r) => lh.setRecord(r), "local-profile-reset": () => lh.reset(),
        "local-profile-pick-osu": () => ({ ok: false, cancelled: true }), "local-profile-export": () => ({ ok: false, cancelled: true }),
        "local-profile-import-file": () => ({ ok: false, cancelled: true }),
    })) ipcMain.handle(channel, fn);
    // the other tabs' channels the page asks for on load: nothing behind them here
    for (const channel of ["generator-info", "ratings-summary", "rate-presets-get", "overlay-get", "interlude-status", "interlude-live-get", "profile-get"]) {
        ipcMain.handle(channel, () => ({ ok: false }));
    }
    ipcMain.handle("profile-ensure", () => ({ ok: false, reason: "none" }));

    const win = new BrowserWindow({ width: 360, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
        console.log("shot", path.join(outDir, name));
    };
    const waitFor = async (code, ms = 30000) => {
        for (let waited = 0; waited < ms; waited += 200) {
            if (await js(code)) return true;
            await sleep(200);
        }
        return false;
    };
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const tab = (name) => js(`document.querySelector('[data-tab=${name}]').click(); true`);

    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`localStorage.clear(); localStorage.setItem("profile-view", JSON.stringify({ page: "local" })); true`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));

    // ---- «Мой профиль»: the history imported, the vibro plays kept and left out ----
    await tab("profile");
    await sleep(500);
    await js(`document.getElementById("prof-import-stable").click(); true`);
    check(await waitFor(`document.getElementById("prof-import-status").textContent.includes(${JSON.stringify(t("profile.import.done", { added: "", total: "" }).split(" ")[0])})`, 120000), "the import finished");
    const st = await local.status();
    console.log("counts:", JSON.stringify(st.counts));
    console.log("skill:", JSON.stringify({ overall: st.skill.overall, tiles: st.skill.tiles }));
    check(st.counts.plays === scores.length, `every play kept (${st.counts.plays} of ${scores.length})`);
    check(st.counts.vibro === 3, `the vibro map's 3 passes are left out (${st.counts.vibro})`);
    const plays = await createLocalProfileStore({ dir: path.join(userData, "local-profile") }).plays();
    const maps = new Map(Object.entries(JSON.parse(await readFile(path.join(userData, "local-profile", "maps.json"), "utf8"))));
    const vibroKey = `${md5(vibroText)}@1.00`;
    check(maps.get(vibroKey)?.vibro?.vibro === true && Number.isFinite(maps.get(vibroKey)?.numeric), `maps.json: the vibro map keeps its dan ${maps.get(vibroKey)?.numeric} and the mark`);
    const without = skillFromPlays(plays.filter((p) => p.mapKey !== vibroKey), (k) => maps.get(k));
    check(JSON.stringify(without.tiles) === JSON.stringify(st.skill.tiles) && without.overall === st.skill.overall, "the dans are the ones without the vibro plays");
    check(await waitFor(`document.getElementById("prof-local-counts").innerText.includes(${JSON.stringify(t("profile.local.vibro", { n: 3 }))})`), "the counts say how many were left out");
    const counts = await text("prof-local-counts");
    console.log("counts line:", counts);
    check((await js(`document.getElementById("prof-local-counts").title`)) === t("profile.local.vibroTitle"), "the counts' tooltip explains it");
    const recent = await text("prof-local-recent");
    console.log("recent:", recent.replace(/\n/g, " | "));
    check(recent.includes(t("profile.play.vibro")), "a vibro play in recent plays says it doesn't move the dans");
    check(await js(`document.querySelectorAll("#prof-local-recent .prof-play.vibro").length === 3`), "the three vibro plays are marked, the others not");
    const tip = await js(`document.querySelector("#prof-local-recent .prof-play.vibro .prof-play-line")?.title ?? ""`);
    console.log("play tooltip:", tip);
    check(/\d+%/.test(tip), "the play's tooltip says how much of the map is vibro");
    const best = await text("prof-local-top");
    check(!best.includes("Smoke vibro dump"), "the best plays leave it out");
    await js(`document.getElementById("prof-local-counts").scrollIntoView({ block: "center" }); true`);
    await shot(`vibro-profile-counts-${lang}.png`);
    await js(`document.getElementById("prof-local-recent").scrollIntoView({ block: "start" }); true`);
    await shot(`vibro-profile-recent-${lang}.png`);

    // ---- the card: the chip on the vibro chart, none on a normal one ----
    await tab("analysis");
    const cache = new Map();
    let serving = vibroText;
    const controller = createSelectionController({
        fetchOsu: async () => serving, analyze: (text, rate) => analyzeChart(text, rate),
        cache: { get: async (k) => cache.get(k), set: async (k, v) => { cache.set(k, v); } },
        onView: (view) => send("view", view),
    });
    controller.onFrame({ state: "songselect", checksum: md5(vibroText), rate: 1, mods: [] });
    check(await waitFor(`Boolean(document.querySelector("#card .chip.an-vibro"))`, 60000), "the card shows the vibro chip");
    const chip = await js(`(() => { const c = document.querySelector("#card .chip.an-vibro"); return { text: c.textContent, title: c.title }; })()`);
    console.log("chip:", JSON.stringify(chip));
    check(chip.text === t("analysis.vibro.chip"), "the chip's word");
    check(/\d+%/.test(chip.title) && /\d+/.test(chip.title), "the tooltip: how much of the map and how fast");
    const cardText = await text("card");
    console.log("card:", cardText.replace(/\n/g, " | "));
    await shot(`vibro-card-${lang}.png`);
    // the tooltip is the browser's own and never in a capture: drawn here once beside the chip for the picture
    await js(`(() => {
        const c = document.querySelector("#card .chip.an-vibro"); const r = c.getBoundingClientRect();
        const d = document.createElement("div"); d.id = "smoke-tip"; d.textContent = c.title;
        Object.assign(d.style, { position: "fixed", left: "8px", right: "8px", top: (r.bottom + 6) + "px", background: "#fffbe6", color: "#222",
            font: "12px sans-serif", padding: "6px 8px", border: "1px solid #888", borderRadius: "3px", zIndex: 99, boxShadow: "0 2px 6px #0008" });
        document.body.append(d); return true; })()`);
    await shot(`vibro-card-tooltip-${lang}.png`);
    await js(`document.getElementById("smoke-tip")?.remove(); true`);
    serving = texts[0];
    controller.onFrame({ state: "songselect", checksum: md5(texts[0]), rate: 1, mods: [] });
    check(await waitFor(`document.getElementById("card").innerText.includes("BPM") && !document.querySelector("#card .chip.an-vibro")`, 60000), "a normal chart has no vibro chip");
    await shot(`vibro-card-normal-${lang}.png`);

    check(blocked.length === 0, `no request left the machine (${blocked.length})`);
    console.log(failed ? "SMOKE FAILED" : "SMOKE PASSED");
    app.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
