// Run with: npx electron tests/smoke/electron-rate-map.mjs <out-dir> [lang=en]
// A rate map on the card at 440×820 with the real modules (the selection controller, the finder in main
// app/rateMapOrigin.js, registerAnalysisIpc, registerRateIpc) and the real analyzer, over a temp Songs folder of
// synthetic charts in <out-dir>: one set holds a rate map at 1.2x and its original, another a rate map at 1.15x whose
// original is not there. A fake tosu: its frames go to the controller by hand, the selected file's path is the
// finder's. Checked: the card's dan is the rate map's own at 1.0, its chip says "rate map ×1.2", the ladder marks 1.2x
// (1.8x with DT) and its rows are the original's, the now row (the original at 1.2x) and the 1.0 row too; a click on the 1.3 row opens the Rate tab on the original at 1.3
// with the note; the second set's original is made back (its note, no copies); the Songs folder changes in nothing.
// Screenshots go to <out-dir>/shots; exits 0 when every check holds.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSelectionController } from "../../app/selectionController.js";
import { createRateOrigins } from "../../app/rateMapOrigin.js";
import { registerAnalysisIpc } from "../../app/analysisIpc.js";
import { registerRateIpc } from "../../app/rateIpc.js";
import { createHooks } from "../../app/hooks.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { detailsJob } from "../../src/analysis/timeline.js";
import { sectionsJob } from "../../src/analysis/sections.js";
import { rateOsu } from "../../src/rate/rateMap.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeChart } from "../fixtures/makeChart.js";
import { randomChart } from "../fixtures/randomChart.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-rate-map.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=") && !a.startsWith("--")) ?? path.join(here, "rate-map-out"));
const lang = setLang(args.includes("lang=en") ? "en" : "ru");
const userData = path.join(outDir, `user-data-${lang}`);
const songs = path.join(outDir, `songs-${lang}`);
const shots = path.join(outDir, "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", userData); // never the real app's folder

const meta = (text, fields) => {
    let out = text;
    for (const [key, value] of Object.entries(fields)) out = out.replace(new RegExp(`^${key}:[^\\r\\n]*`, "m"), `${key}:${value}`);
    return out.replace(/^Version:([^\r\n]*)/m, "Version:$1\r\nTags:synthetic test\r\nBeatmapID:1234567");
};
const listing = (dir) => readdirSync(dir, { recursive: true }).map((n) => path.join(dir, n))
    .filter((f) => statSync(f).isFile()).map((f) => `${path.relative(dir, f)} ${statSync(f).size} ${statSync(f).mtimeMs}`).sort();

function memoryCache() {
    const m = new Map();
    return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}

app.whenReady().then(async () => {
    rmSync(userData, { recursive: true, force: true });
    rmSync(songs, { recursive: true, force: true });
    mkdirSync(userData, { recursive: true });
    mkdirSync(shots, { recursive: true });
    // set 1: the original and the Rate tab's copy at 1.2x; set 2: a copy at 1.15x alone
    const setOne = path.join(songs, "1 TestArtist - Synthetic Rush");
    const setTwo = path.join(songs, "2 TestArtist - Synthetic Lone");
    mkdirSync(setOne, { recursive: true });
    mkdirSync(setTwo, { recursive: true });
    const original = meta(makeChart({ kind: "jumpstream", bpm: 170, seconds: 90 }), { Title: "Synthetic Rush", Artist: "TestArtist", Creator: "TestMapper", Version: "Insane" });
    const rateMap = rateOsu(original, { rate: 1.2, audioFilename: "audio 1.2x.mp3" });
    const lonely = rateOsu(meta(randomChart(7, { seconds: 80 }), { Title: "Synthetic Lone", Artist: "TestArtist", Creator: "TestMapper", Version: "Hard" }), { rate: 1.15, audioFilename: "audio 1.15x.mp3" });
    const files = {
        original: path.join(setOne, "TestArtist - Synthetic Rush (TestMapper) [Insane].osu"),
        rateMap: path.join(setOne, "TestArtist - Synthetic Rush (TestMapper) [Insane 1.2x (204bpm)].osu"),
        lonely: path.join(setTwo, "TestArtist - Synthetic Lone (TestMapper) [Hard 1.15x].osu"),
    };
    writeFileSync(files.original, original);
    writeFileSync(files.rateMap, rateMap);
    writeFileSync(files.lonely, lonely);
    const before = listing(songs);

    let win = null;
    const send = (channel, payload) => win?.webContents.send(channel, payload);
    const log = (line) => console.log("log", line);
    // the fake tosu: the selected file (its path and text) and frames sent by hand
    let selected = files.rateMap;
    const hooks = createHooks({ log });
    const analysis = {
        analyze: (text, rate) => analyzeChart(text, rate),
        analyzeQueued: (text, rate) => analyzeChart(text, rate),
        enqueue: async (fn) => fn(),
    };
    const controller = createSelectionController({
        fetchOsu: async () => readFileSync(selected, "utf8"),
        analyze: (text, rate) => analyzeChart(text, rate),
        cache: memoryCache(),
        onView: (view) => send("view", view),
        onResult: (r) => hooks.emit("result", r),
        rateOrigin: createRateOrigins({ beatmap: async () => ({ client: "stable", path: selected }), log }),
    });
    const card = { rateMap: () => controller.rateMap() };
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    registerAnalysisIpc({
        ipcMain, hooks, send, log, analysis, resultCache: memoryCache(),
        worker: { details: (text, rate) => detailsJob(text, rate), sections: (text, rate) => sectionsJob(text, rate) },
    });
    registerRateIpc({
        ipcMain, analysis, card, send, log, shell: { openPath: async () => "" },
        tosu: { beatmapPath: async () => selected, beatmap: async () => ({ client: "stable", path: selected }) },
        ffmpegPath: async () => { throw new Error("no copies in this smoke"); },
        paths: { userData, docsDir: path.join(outDir, `docs-${lang}`), mapsDir: path.join(outDir, `docs-${lang}`, "maps") },
    });
    for (const ch of ["overlay-get", "overlay-set"]) ipcMain.handle(ch, () => null);
    ipcMain.handle("profile-ensure", () => ({ ok: true, player: { id: 1234567, username: "TestPlayer", avatarUrl: "" },
        skill: { overall: 7.4, overallLabel: "", tiles: { speed: 7.6, stamina: 7.2, tech: 7.1, jack: null }, msd: { Overall: 20 } } }));

    win = new BrowserWindow({ width: 440, height: 820, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (e) => {
        if (e.level === "warning" || e.level === "error") console.log("console", e.level, e.message);
    });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    // a hidden window paints a scroll only on a new frame: a 1 px resize makes one
    const shot = async (name) => {
        const [w, h] = win.getSize();
        win.setSize(w + 1, h);
        await sleep(150);
        win.setSize(w, h);
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(250);
        writeFileSync(path.join(shots, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 60000) => {
        for (let waited = 0; waited < ms; waited += 100) {
            if (await js(code)) return true;
            await sleep(100);
        }
        throw new Error(`timed out: ${code}\n${await js("document.body.innerText.slice(0, 1500)")}`);
    };
    const ladderDone = `document.querySelectorAll("#card .an-lrow").length >= 13
        && ![...document.querySelectorAll("#card .an-lrow .an-lname")].some((n) => n.classList.contains("an-muted"))`;
    const frame = (rate) => controller.onFrame({ state: "songselect", checksum: path.basename(selected), rate, mods: rate === 1.5 ? ["DT"] : [] });
    const report = {};
    win.webContents.send("settings", { alwaysOnTop: false, lang });
    await js(`localStorage.setItem("analysis-extras", JSON.stringify({ ladderOpen: true, partsOpen: false })); true`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    controller.onTosuStatus("connected");

    // 1) the rate map at 1.0: its own dan, shown at ×1.2, the ladder of its original
    frame(1);
    await waitFor(`document.querySelector("#card .an-ratemap") !== null`);
    await waitFor(ladderDone);
    const own = await analyzeChart(rateMap, 1);
    const atOne = await analyzeChart(original, 1);
    const atNow = await analyzeChart(original, 1.2);
    report.cardDan = await js(`document.querySelector("#card .dan .numeric").innerText`);
    report.chip = await js(`document.querySelector("#card .an-ratemap").innerText`);
    report.chipTitle = await js(`document.querySelector("#card .an-ratemap").title`);
    report.now = await js(`document.querySelector("#card .an-lnow")?.dataset.rate ?? null`);
    report.nowNumber = await js(`document.querySelector("#card .an-lnow .an-lnum").innerText`);
    report.rowOne = await js(`document.querySelector('#card .an-lrow[data-rate="1"] .an-lnum').innerText`);
    report.expected = { own: own.numeric.toFixed(1), originalAtOne: atOne.numeric.toFixed(1), originalAtNow: atNow.numeric.toFixed(1) };
    await shot(`rate-map-${lang}-1-card.png`);
    await js(`document.querySelector("#card .an-ladder").scrollIntoView({ block: "start" }); true`);
    await shot(`rate-map-${lang}-2-ladder.png`);

    // 2) with DT: the same file at 1.5, now at 1.8x
    frame(1.5);
    await waitFor(`document.querySelector("#card .an-lnow")?.dataset.rate === "1.8"`);
    await waitFor(ladderDone);
    report.dtNow = await js(`document.querySelector("#card .an-lnow").dataset.rate`);
    report.dtChips = await js(`[...document.querySelectorAll("#card .chips .chip")].map((c) => c.innerText)`);
    report.dtCardDan = await js(`document.querySelector("#card .dan .numeric").innerText`);
    report.dtExpected = (await analyzeChart(rateMap, 1.5)).numeric.toFixed(1);
    await js(`document.querySelector("#card .an-ladder").scrollIntoView({ block: "start" }); true`);
    await shot(`rate-map-${lang}-3-dt.png`);

    // 3) back at 1.0, a click on the 1.3 row: the Rate tab on the original at 1.3
    frame(1);
    await waitFor(`document.querySelector("#card .an-lnow")?.dataset.rate === "1.2"`);
    await js(`document.querySelector('#card .an-lrow[data-rate="1.3"]').click(); true`);
    await waitFor(`!document.getElementById("rate-tab").hidden && document.getElementById("rate-preview").innerText.includes("1.3") && !document.getElementById("rate-preview").innerText.includes("…")`);
    report.rateMapName = await js(`document.getElementById("rate-map").innerText`);
    report.rateValue = await js(`document.getElementById("rate-value").value`);
    report.rateNote = await js(`!document.getElementById("rate-origin-note").hidden && document.getElementById("rate-origin-note").innerText`);
    report.ratePreview = await js(`document.getElementById("rate-preview").innerText`);
    report.rateCreateEnabled = await js(`!document.getElementById("rate-create").disabled`);
    await shot(`rate-map-${lang}-4-rate-tab.png`);

    // 4) the lonely rate map: its original made back from it; the Rate tab makes no copies of it
    await js(`document.querySelector('[data-tab=analysis]').click(); true`);
    selected = files.lonely;
    frame(1);
    await waitFor(`document.querySelector("#card .an-ratemap")?.innerText.includes("1.15")`);
    await waitFor(ladderDone);
    report.lonelyNow = await js(`document.querySelector("#card .an-lnow")?.dataset.rate ?? null`);
    report.lonelyChipTitle = await js(`document.querySelector("#card .an-ratemap").title`);
    await js(`document.querySelector("#card .an-ladder").scrollIntoView({ block: "start" }); true`);
    await shot(`rate-map-${lang}-5-rebuilt.png`);
    await js(`document.querySelector('#card .an-lrow[data-rate="1.2"]').click(); true`);
    await waitFor(`!document.getElementById("rate-tab").hidden && document.getElementById("rate-preview").innerText.includes("1.2") && !document.getElementById("rate-preview").innerText.includes("…")`);
    report.lonelyRateMap = await js(`document.getElementById("rate-map").innerText`);
    report.lonelyNote = await js(`!document.getElementById("rate-origin-note").hidden && document.getElementById("rate-origin-note").innerText`);
    report.lonelyCreateDisabled = await js(`document.getElementById("rate-create").disabled`);
    await shot(`rate-map-${lang}-6-rebuilt-rate-tab.png`);

    report.songsChanged = listing(songs).filter((l) => !before.includes(l)).length + before.filter((l) => !listing(songs).includes(l)).length;
    report.overflow = await js(`(() => {
        const wide = [...document.querySelectorAll("#card *, #rate-tab *")]
            .filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
            .map((n) => n.id || n.className || n.tagName);
        return { page: document.documentElement.scrollWidth > document.documentElement.clientWidth, wide };
    })()`);
    console.log(JSON.stringify(report, null, 2));
    const checks = {
        cardDan: report.cardDan === report.expected.own,
        nowOfOriginal: report.nowNumber === report.expected.originalAtNow,
        chip: report.chip === t("analysis.rateMap.chip", { rate: 1.2 }) && report.chipTitle === t("analysis.rateMap.title", { rate: 1.2 }),
        now: report.now === "1.2",
        ladderOfOriginal: report.rowOne === report.expected.originalAtOne,
        dt: report.dtNow === "1.8" && report.dtChips.includes("×1.8") && report.dtCardDan === report.dtExpected,
        rateTab: report.rateMapName.endsWith("[Insane]") && report.rateValue === "1.3" && report.rateNote === t("rate.origin", { rate: 1.2 }) && report.rateCreateEnabled,
        rebuilt: report.lonelyNow === "1.15" && report.lonelyChipTitle === t("analysis.rateMap.titleRebuilt", { rate: 1.15 })
            && report.lonelyRateMap.endsWith("[Hard]") && report.lonelyNote === t("rate.originRebuilt", { rate: 1.15 }) && report.lonelyCreateDisabled,
        songsUntouched: report.songsChanged === 0,
        noOverflow: !report.overflow.page && !report.overflow.wide.length,
    };
    console.log("checks", JSON.stringify(checks));
    app.exit(Object.values(checks).every(Boolean) ? 0 : 2);
}).catch((error) => {
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});
