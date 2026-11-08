// Run with: npx electron tests/smoke/electron-etterna.mjs <out-dir> [lang=en]
// Etterna's block in ⚙ Settings in the real window (460×760) with the real modules (app/etternaClient.js,
// app/etternaLibrary.js, app/etternaIpc.js) over an invented Etterna install made in <out-dir> (tests/fixtures/
// etternaFolder.js: three songs in two packs, one with warps, and a cache.db with MSD): the block unlinked, the folder
// picked (a stubbed dialog), the charts listed with MSD at 1.0x and their dans (a stand-in analysis), the rate set to
// 1.3x, a chart clicked onto the card (a stand-in card that records it), Etterna turned off and on again. The invented
// folder must not change. Screenshots etterna-<lang>-*.png go to <out-dir>; exits 0 when every check holds.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEtternaClient } from "../../app/etternaClient.js";
import { registerEtternaIpc } from "../../app/etternaIpc.js";
import { createJsonStore } from "../../app/jsonStore.js";
import { setLang } from "../../src/i18n/i18n.js";
import { makeEtternaFolder, smText, smChart, sscText, msdText } from "../fixtures/etternaFolder.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-etterna.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=") && !a.startsWith("--")) ?? path.join(here, "etterna-out"));
const lang = setLang(args.includes("lang=en") ? "en" : "ru");
const userData = path.join(outDir, `user-data-${lang}`);
const game = path.join(outDir, `Etterna-${lang}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", userData); // never the real app's folder
const listing = (dir) => readdirSync(dir, { recursive: true }).map((n) => path.join(dir, n))
    .filter((f) => statSync(f).isFile()).map((f) => `${path.relative(dir, f)} ${statSync(f).size} ${statSync(f).mtimeMs}`).sort();

let failed = false;
const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};

app.whenReady().then(async () => {
    mkdirSync(outDir, { recursive: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(game, { recursive: true, force: true });
    await makeEtternaFolder(game, {
        songs: [
            { at: "Songs/Stream Pack/Rush", files: { "Rush.sm": smText({ title: "Rush", artist: "Composer A", charts: [smChart({ difficulty: "Challenge", meter: 24, measures: 12 })] }) } },
            { at: "Songs/Stream Pack/Holds", files: { "Holds.ssc": sscText({ title: "Holds", artist: "Composer B", charts: [{ difficulty: "Hard", meter: 18, measures: 8, hold: true }] }) } },
            { at: "Songs/Gimmicks/Warped", files: { "Warped.sm": smText({ title: "Warped", artist: "Composer C", warps: "4.000=2.000" }) } },
        ],
        cache: { steps: [
            { file: "/Songs/Stream Pack/Rush/Rush.sm", key: `X${"1".repeat(40)}`, msd: msdText(24.5) },
            { file: "/Songs/Stream Pack/Holds/Holds.ssc", key: `X${"2".repeat(40)}`, msd: msdText(18.25) },
        ] },
    });
    const before = listing(game);

    const sendTo = (channel, payload) => win?.webContents.send(channel, payload);
    const etterna = createEtternaClient({
        store: createJsonStore({ file: path.join(userData, "etterna.json"), fallback: { folder: null, enabled: true } }),
        cacheDir: path.join(userData, "etterna-cache"), log: (l) => console.log("log", l),
        onChange: () => void etterna.status().then((s) => sendTo("etterna-state", s), () => {}),
    });
    const onCard = [];
    const analyzed = [];
    // a stand-in for the analysis service: a dan from the number of notes and the rate
    const analysis = { analyzeQueued: async (text, rate) => {
        analyzed.push(rate);
        const notes = (text.split("[HitObjects]")[1] ?? "").trim().split(/\r?\n/).length;
        const numeric = Math.round((8 + notes / 20 + 3 * (rate - 1)) * 10) / 10;
        return { kind: "ok", numeric, label: `dan ${numeric}` };
    } };
    registerEtternaIpc({
        ipcMain, etterna, analysis, card: { showExternal: (r) => onCard.push(r) },
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(game, "Songs")] }) },
        window: () => win, hooks: null, send: sendTo, log: (l) => console.log("log", l),
    });
    // every other channel the page uses answers nothing: only the Etterna block is looked at here
    const preload = readFileSync(path.join(appDir, "preload.cjs"), "utf8");
    for (const ch of new Set([...preload.matchAll(/ipcRenderer\.invoke\("([\w-]+)"/g)].map((m) => m[1]))) {
        if (!ch.startsWith("etterna-")) ipcMain.handle(ch, () => null);
    }
    for (const ch of new Set([...preload.matchAll(/ipcRenderer\.send(?:Sync)?\("([\w-]+)"/g)].map((m) => m[1]))) {
        ipcMain.on(ch, (e) => { e.returnValue = ch === "get-lang" ? lang : null; });
    }

    let win = new BrowserWindow({ width: 460, height: 760, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (e) => {
        if (e.level === "error") console.log("console", e.level, e.message, `${path.basename(e.sourceId ?? "")}:${e.lineNumber}`);
    });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 100) {
            if (await js(code)) return true;
            await sleep(100);
        }
        throw new Error(`timed out: ${code}\n${await js("document.getElementById('etterna-panel').innerText.slice(0, 1500)")}`);
    };
    const panelText = () => js(`document.getElementById("etterna-panel").innerText`);
    win.webContents.send("settings", { alwaysOnTop: false, lang });

    try {
        await js(`document.getElementById("settings-open").click(); document.getElementById("st-etterna").scrollIntoView({ block: "start" });`);
        await waitFor(`!document.getElementById("settings-page").hidden`);
        await waitFor(`document.querySelector("#etterna-panel .et-status")?.innerText.length > 0`);
        check(/Укажи папку Etterna|Point to your Etterna folder/.test(await panelText()), "unlinked: the block asks for the folder");
        await js(`document.getElementById("st-etterna").scrollIntoView({ block: "start" })`);
        await shot(`etterna-${lang}-1-unlinked.png`);

        // the folder picked (its Songs: the install is its parent)
        await js(`document.querySelectorAll("#etterna-panel .et-actions button")[0].click()`);
        await waitFor(`document.querySelectorAll("#etterna-panel .et-row").length === 3`, 30000);
        await waitFor(`![...document.querySelectorAll("#etterna-panel .et-dan")].some((n) => /…/.test(n.innerText))`);
        const linked = await panelText();
        check(/(подключена|is linked).*3/.test(linked), "linked: three charts");
        check(/MSD 24\.50/.test(linked) && /MSD 18\.25/.test(linked), "MSD at 1.0x from the game's cache");
        check(/(не считается|not rated)/.test(linked), "the warped chart is listed as not rated");
        check(/dan \d/.test(linked), "the dans are filled in");
        await js(`document.getElementById("st-etterna").scrollIntoView({ block: "start" })`);
        await shot(`etterna-${lang}-2-linked.png`);

        // 1.3x
        await js(`(() => { const s = document.querySelector("#etterna-panel .et-rate select"); s.value = "1.30"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`/MSD 31\\.85/.test(document.getElementById("etterna-panel").innerText)`);
        await waitFor(`![...document.querySelectorAll("#etterna-panel .et-dan")].some((n) => /…/.test(n.innerText))`);
        check(analyzed.includes(1.3), "the dans worked out again at 1.3x");
        await shot(`etterna-${lang}-3-rate.png`);

        // a chart onto the card
        await js(`[...document.querySelectorAll("#etterna-panel .et-row")].find((r) => r.innerText.includes("Rush")).click()`);
        for (let i = 0; i < 50 && !onCard.length; i += 1) await sleep(100);
        check(onCard.length === 1 && onCard[0].rate === 1.3 && /\[HitObjects\]/.test(onCard[0].text) && onCard[0].id.startsWith("etterna:"), "the chart went on the card at 1.3x");
        await waitFor(`document.getElementById("settings-page").hidden`, 5000);
        check(true, "the Settings page gave way to the card");

        // off and on again
        await js(`document.getElementById("settings-open").click()`);
        await waitFor(`!document.getElementById("settings-page").hidden`);
        await js(`(() => { const b = document.querySelector("#etterna-panel .et-enable input"); b.checked = false; b.dispatchEvent(new Event("change")); })()`);
        await waitFor(`!document.querySelector("#etterna-panel .et-off-note").hidden`);
        const off = await panelText();
        check(/(Etterna выключена|Etterna is turned off)/.test(off) && off.includes(game), "off: the note and the folder kept");
        await sleep(1500);
        const stillOff = await js(`(() => { const p = document.getElementById("etterna-panel"); return { checked: p.querySelector(".et-enable input").checked, library: p.querySelector(".et-library").hidden, status: p.querySelector(".et-status").hidden, note: p.querySelector(".et-off-note").hidden }; })()`);
        check(!stillOff.checked && stillOff.library && stillOff.status && !stillOff.note, `off stays off a moment later: ${JSON.stringify(stillOff)}`);
        await js(`document.getElementById("st-etterna").scrollIntoView({ block: "start" })`);
        await shot(`etterna-${lang}-4-off.png`);
        await js(`(() => { const b = document.querySelector("#etterna-panel .et-enable input"); b.checked = true; b.dispatchEvent(new Event("change")); })()`);
        await waitFor(`document.querySelectorAll("#etterna-panel .et-row").length === 3`, 30000);
        check(true, "on again: the three charts are back");
        check(JSON.stringify(listing(game)) === JSON.stringify(before), "the Etterna folder is unchanged");
    } catch (error) {
        check(false, String(error?.message ?? error));
    }
    win.destroy();
    win = null;
    app.exit(failed ? 1 : 0);
});
