// Run with: npx electron tests/smoke/electron-rate.mjs <out-dir> [lang=en] [width=320]
// The "Рейт" tab end to end at 460×760 (or another width): the real rate handlers (registerRateIpc) over a
// synthetic LN map in <out-dir>/song-*, a fake analysis (dan = 12 + 3·(rate − 1), an LN chart has none), presets
// in <out-dir>/user-data-*.
// Turns on No LN, finds the rate for the picked dan, counts the dans of a batch, saves a preset, creates three
// copies (ffmpeg on a few seconds of silence), checks nothing sticks out sideways, and takes screenshots.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerRateIpc } from "../../app/rateIpc.js";
import { lnShare } from "../../src/rate/chartTransform.js";
import { numericToLabel } from "../../src/core/labels.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeChart } from "../fixtures/makeChart.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-rate.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "rate-out"));
const lang = setLang(args.includes("lang=en") ? "en" : "ru");
const width = Number(args.find((a) => a.startsWith("width="))?.slice(6)) || 460;
const run = width === 460 ? lang : `${lang}-${width}`; // names this run's files
const userData = path.join(outDir, `user-data-${run}`);
const songDir = path.join(outDir, `song-${run}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", userData); // never the real app's folder

// A 4K map with 34% holds and 6 s of silence as its song.
function songFolder() {
    rmSync(songDir, { recursive: true, force: true });
    mkdirSync(songDir, { recursive: true });
    const chart = makeChart({ kind: "ln", bpm: 165, seconds: 5, lnShare: 0.34 })
        .replace("AudioFilename: audio.mp3", "AudioFilename: audio.wav")
        .replace("Version:ln 165", "Version:Insane");
    const osuPath = path.join(songDir, "Test - Synthetic ln (Test) [Insane].osu");
    writeFileSync(osuPath, chart, "utf8");
    const n = 6 * 22050;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + n * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n * 2, 40);
    writeFileSync(path.join(songDir, "audio.wav"), Buffer.concat([h, Buffer.alloc(n * 2)]));
    return osuPath;
}

function fakeResult(text, rate) {
    if (lnShare(text) > 0.15) return { kind: "not-rice", reason: "ln", keys: 4 };
    const numeric = Math.round((12 + 3 * (rate - 1)) * 10) / 10;
    return { kind: "ok", numeric, label: numericToLabel(numeric).text, primary: "Jumpstream", tech: rate > 1.3 };
}
const analysis = {
    analyze: async (text, rate) => fakeResult(text, rate),
    analyzeQueued: async (text, rate, { isCancelled = () => false } = {}) => {
        if (isCancelled()) return { kind: "error", transient: true, cancelled: true, message: "cancelled" };
        await sleep(60);
        return fakeResult(text, rate);
    },
};

app.whenReady().then(async () => {
    mkdirSync(userData, { recursive: true });
    // presets from an earlier run of the app, one of them long
    writeFileSync(path.join(userData, "rate-presets.json"), JSON.stringify([
        { rate: 1.2, pitch: true },
        { rate: 1.3, od: 8, mirror: true },
        { rate: 1.45, pitch: true, od: 8.5, hp: 7.5, mirror: true, noLn: true },
    ]));
    const osuPath = songFolder();
    let win = null;
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    registerRateIpc({
        ipcMain,
        tosu: { beatmapPath: async () => osuPath },
        analysis,
        ffmpegPath: async () => (await import("ffmpeg-static")).default,
        paths: { userData },
        send: (channel, payload) => win?.webContents.send(channel, payload),
        log: (line) => console.log("log", line),
    });

    win = new BrowserWindow({ width, height: 760, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (e) => {
        if (e.level === "warning" || e.level === "error") console.log("console", e.level, e.message, `${path.basename(e.sourceId ?? "")}:${e.lineNumber}`);
    });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 15000) => {
        for (let waited = 0; waited < ms; waited += 100) {
            if (await js(code)) return true;
            await sleep(100);
        }
        throw new Error(`timed out: ${code}`);
    };
    const report = {};

    win.webContents.send("settings", { alwaysOnTop: false, compact: false, lang });
    win.webContents.send("view", { screen: "waiting-osu" });
    await js(`document.querySelector('[data-tab=rate]').click();`);
    await waitFor(`document.getElementById("rate-preview").innerText === ${JSON.stringify(t("rate.preview.lnHint"))}`);
    report.map = await text("rate-map");
    report.badge = await text("rate-ln");
    report.presets = await js(`[...document.querySelectorAll("#rate-presets .rate-chip > span")].map((s) => s.textContent)`);
    report.lnHint = await text("rate-preview");
    await shot(`rate-${run}-1-ln.png`);

    // No LN on: the dan is counted, the picker follows it; pick Gamma mid and find its rate
    await js(`const box = document.getElementById("rate-noln"); box.checked = true; box.dispatchEvent(new Event("change"));`);
    await waitFor(`document.getElementById("rate-preview").innerText.includes("12.3")`);
    report.preview = await text("rate-preview");
    await js(`const level = document.getElementById("rate-target-level"); level.value = "13"; level.dispatchEvent(new Event("change"));
        const step = document.getElementById("rate-target-step"); step.value = "mid"; step.dispatchEvent(new Event("change"));
        document.getElementById("rate-target-find").click();`);
    await waitFor(`/\\(13\\.0\\)/.test(document.getElementById("rate-target-status").innerText)`);
    report.target = await text("rate-target-status");
    report.sliderAfterTarget = await js(`document.getElementById("rate-value").value`);

    // several rates: 1.0–1.5 by 0.05, rows fill one by one
    await js(`document.getElementById("rate-batch").open = true;
        document.getElementById("rate-batch-from").value = "1.0";
        document.getElementById("rate-batch-to").value = "1.5";
        document.getElementById("rate-batch-step").value = "0.05";
        document.getElementById("rate-batch-step").dispatchEvent(new Event("input"));
        document.getElementById("rate-batch-dans").click();`);
    await waitFor(`document.querySelectorAll("#rate-batch-table .rate-row").length === 11`);
    report.rowsWhileCounting = await js(`[...document.querySelectorAll("#rate-batch-table .rate-row-dan")].filter((c) => c.textContent !== "…").length`);
    await waitFor(`[...document.querySelectorAll("#rate-batch-table .rate-row-dan")].every((c) => c.textContent !== "…")`);
    report.count = await text("rate-batch-count");
    report.rows = await js(`[...document.querySelectorAll("#rate-batch-table .rate-row")].map((r) => r.innerText.replace(/\\s+/g, " ").trim())`);
    await js(`document.querySelectorAll("#rate-batch-table .rate-row")[4].click();`);
    report.sliderAfterRowClick = await js(`document.getElementById("rate-value").value`);
    await js(`document.getElementById("rate-save-preset").click();`);
    await waitFor(`document.querySelectorAll("#rate-presets .rate-chip").length === 4`);
    report.saved = await text("rate-status");

    // keep three rows checked and create them
    await js(`[...document.querySelectorAll("#rate-batch-table .rate-row input")].forEach((box, i) => {
        box.checked = [0, 2, 4].includes(i); box.dispatchEvent(new Event("change")); });`);
    report.createButton = await text("rate-batch-create");
    await js(`document.getElementById("rate-batch-create").click();`);
    await waitFor(`document.getElementById("rate-batch-status").innerText.length > 0 && document.getElementById("rate-batch-stop").hidden`, 60000);
    report.created = await text("rate-batch-status");
    report.files = readdirSync(songDir).sort();

    // nothing may stick out sideways
    report.overflow = await js(`(() => {
        const tab = document.getElementById("rate-tab");
        const right = tab.getBoundingClientRect().right;
        const wide = [...tab.querySelectorAll("*")].filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > right + 0.5)
            .map((n) => n.id || n.className || n.tagName);
        return { scroll: tab.scrollWidth > tab.clientWidth, page: document.documentElement.scrollWidth > document.documentElement.clientWidth, wide };
    })()`);
    await js(`document.getElementById("rate-tab").scrollTop = 0;`);
    await shot(`rate-${run}-2-top.png`);
    await js(`document.getElementById("rate-tab").scrollTop = 1e6;`);
    await shot(`rate-${run}-3-batch.png`);

    // the presets are on disk and come back after a reload
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`document.querySelector('[data-tab=rate]').click();`);
    await waitFor(`document.querySelectorAll("#rate-presets .rate-chip").length === 4`);
    report.presetsAfterReload = await js(`[...document.querySelectorAll("#rate-presets .rate-chip > span")].map((s) => s.textContent)`);

    console.log(JSON.stringify(report, null, 2));
    const ok = !report.overflow.scroll && !report.overflow.page && !report.overflow.wide.length;
    app.exit(ok ? 0 : 2);
}).catch((error) => {
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});
