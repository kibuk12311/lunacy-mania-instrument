// Run with: npx electron tests/smoke/electron-marathon.mjs <out-dir> [lang=en]
// The marathon tab with stubbed main-process channels (no osu!, no network, no ffmpeg): the auto-marathon panel,
// a pick with its progress lines, the list and the difficulty curve, a row moved (warnings), and the 1920×1080
// background with its curve. userData lives in <out-dir>/user-data, never the app's own. Exits 1 when the tab
// scrolls sideways or a step does not show what it should.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setLang, t } from "../../src/i18n/i18n.js";
import { createPngRenderer } from "../../app/renderPng.js";
import { backgroundHtml } from "../../src/rate/backgroundHtml.js";
import { curveRows, curveSvg } from "../../src/rate/marathonCurve.js";
import { numericToLabel } from "../../src/core/labels.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-marathon.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "marathon-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};

const player = { id: 1, username: "TestPlayer", avatarUrl: "" };
const skill = { overall: 12.4, overallLabel: "Gamma low", tiles: { speed: 12.9, stamina: 13.0, tech: 11.8, jack: 12.2 }, msd: {} };
// four picked maps, as main answers them: rising to Gamma mid, each with its rate and cut
const PICKED = [
    { name: "Camellia - Exit This Earth's Atomosphere [4K Hyper]", rate: 1.15, numeric: 12.55, cutMs: 151000, targetDan: 12.55, from: "songs" },
    { name: "xi - Blue Zenith [4K Another]", rate: 0.95, numeric: 12.72, cutMs: 188000, targetDan: 12.7, from: "download" },
    { name: "Silentroom - Nhelv [Jumpstream Ex]", rate: 1.25, numeric: 12.86, cutMs: 133000, targetDan: 12.85, from: "download" },
    { name: "t+pazolite - Chrome VOX (jubeat ver.) [Chordjack]", rate: 1.1, numeric: 13.03, cutMs: 162000, targetDan: 13, from: "download" },
].map((e, i) => ({ ...e, path: path.join(outDir, `map${i + 1}.osu`), label: numericToLabel(e.numeric).text, beatmapId: 1000 + i, beatmapsetId: 100 + i }));

app.whenReady().then(async () => {
    let win = null;
    const send = (channel, payload) => win?.webContents.send(channel, payload);
    const renderPng = createPngRenderer(BrowserWindow);
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.handle("profile-get", () => ({ ok: true, player, skill }));
    ipcMain.handle("profile-ensure", () => ({ ok: true, player, skill }));
    ipcMain.handle("marathon-dan", (_e, { rate }) => {
        const numeric = Math.round((12.4 + 3 * (rate - 1)) * 100) / 100;
        return { label: numericToLabel(numeric).text, numeric, cutMs: 140000 };
    });
    let cancelled = false;
    ipcMain.handle("marathon-auto-cancel", () => { cancelled = true; return { ok: true }; });
    ipcMain.handle("marathon-auto", async (_e, req) => {
        cancelled = false;
        const n = 4;
        for (let i = 1; i <= n && !cancelled; i += 1) {
            const e = PICKED[i - 1];
            send("marathon-auto-progress", { i, n, phase: "search", patternId: req.patternIds[(i - 1) % req.patternIds.length], target: e.targetDan });
            await sleep(250);
            if (e.from === "songs") send("marathon-auto-progress", { i, n, phase: "songs", name: e.name });
            else for (const part of [0, 3, 7, 10]) send("marathon-auto-progress", { i, n, phase: "download", name: e.name, received: part * 1e6, total: part ? 10e6 : null });
            await sleep(250);
            send("marathon-auto-progress", { i, n, phase: "analyze", name: e.name });
            await sleep(250);
        }
        send("marathon-auto-progress", { i: n, n, phase: "done" });
        return { ok: true, entries: PICKED, warnings: [{ kind: "short", i: 3, label: "Gamma low", rate: 1.45 }], templateId: req.templateId, finalDan: 13, plan: [12.55, 12.7, 12.85, 13] };
    });
    // the background exactly as marathonCreate builds it, without cutting any audio
    ipcMain.handle("marathon-create", async (_e, req) => {
        const byPath = new Map(PICKED.map((p) => [p.path, p]));
        const maps = req.entries.map((e) => byPath.get(e.path));
        const curve = curveRows(maps.map((m) => ({ ...m, label: m.label })), req.gapSec * 1000);
        const html = backgroundHtml({
            title: req.title, subtitle: `${t("app.marathon.kind")} · ${maps[0].label} → ${maps.at(-1).label}`,
            items: maps.map((m) => ({ label: `${m.name} ${m.rate}x`, dan: m.label })),
            curveSvg: curveSvg(curve.rows, { totalMs: curve.totalMs, width: 1500, height: 180, plan: req.plan, planLabel: t("marathon.curve.plan"), showLabels: true, font: 22 }),
        });
        writeFileSync(path.join(outDir, "6-background.png"), await renderPng(html));
        return { ok: true, file: path.join(outDir, "smoke.osz"), totalMs: curve.totalMs };
    });

    win = new BrowserWindow({ width: 320, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.log("console", level, msg); });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    // a hidden window paints late, and a scroll not at all: wait two frames, nudge the size
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        const [w, h] = win.getSize();
        win.setSize(w + 1, h);
        await sleep(150);
        win.setSize(w, h);
        await sleep(250);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 10000) => {
        for (let waited = 0; waited < ms; waited += 100) {
            if (await js(code)) return true;
            await sleep(100);
        }
        return false;
    };
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const scrollTo = (id) => js(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: "start" })`);
    const sideways = () => js("(() => { const s = document.getElementById('marathon-tab'); return s.scrollWidth - s.clientWidth; })()");

    // from default settings
    await js(`localStorage.removeItem("marathon.auto.v1")`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`document.querySelector('[data-tab=marathon]').click()`);
    check(await waitFor(`document.getElementById("mar-profile").innerText.includes("TestPlayer")`), `profile line: ${await text("mar-profile")}`);
    check(await sideways() <= 0, "no sideways scroll (panel)");
    await shot("1-panel.png");

    // manual Gamma mid, Jumpstream + Chordjack, the dan course
    await js(`(() => {
        const manual = document.getElementById("mar-src-manual"); manual.checked = true; manual.dispatchEvent(new Event("change"));
        const level = document.getElementById("mar-level"); level.value = "13"; level.dispatchEvent(new Event("change"));
        const step = document.getElementById("mar-dan-step"); step.value = "mid"; step.dispatchEvent(new Event("change"));
        const tpl = document.getElementById("mar-tpl"); tpl.value = "dan"; tpl.dispatchEvent(new Event("change"));
    })()`);
    console.log("title:", await js(`document.getElementById("mar-title").value`), "gap:", await js(`document.getElementById("mar-gap").value`));
    await js(`document.getElementById("mar-pick").click()`);
    const second = JSON.stringify(PICKED[1].name);
    check(await waitFor(`document.getElementById("mar-auto-status").innerText.includes(${second})`), `progress: ${await text("mar-auto-status")}`);
    await shot("2-progress.png");
    const done = JSON.stringify(t("marathon.auto.done", { maps: t("marathon.auto.maps.few", { n: 4 }) }).split(" ")[0]);
    check(await waitFor(`document.getElementById("mar-auto-status").innerText.startsWith(${done})`), `done: ${await text("mar-auto-status")}`);
    console.log("warnings:", await text("mar-auto-result"));
    check((await js(`document.querySelectorAll("#mar-list .mar-row").length`)) === 4, "4 rows in the list");
    check(await js(`document.querySelector("#mar-curve svg path[stroke-dasharray]") !== null`), "the curve has the template plan");
    console.log("curve:", await text("mar-curve"));
    await scrollTo("mar-auto-status");
    await shot("3-picked.png");
    await scrollTo("mar-curve-box");
    check(await sideways() <= 0, "no sideways scroll (list and curve)");
    await shot("4-curve.png");

    // the last map moved to the front: a drop and the curve redrawn at once
    await js(`[...document.querySelectorAll("#mar-list .mar-row")][3].querySelectorAll("button")[0].click()`);
    await js(`[...document.querySelectorAll("#mar-list .mar-row")][2].querySelectorAll("button")[0].click()`);
    await js(`[...document.querySelectorAll("#mar-list .mar-row")][1].querySelectorAll("button")[0].click()`);
    const drop = JSON.stringify(t("marathon.curve.drop", { i: 2, delta: "X" }).split("(")[0]);
    check(await waitFor(`document.getElementById("mar-curve").innerText.includes(${drop})`), `warnings after the move: ${await text("mar-curve")}`);
    await scrollTo("mar-curve-box");
    await shot("5-warnings.png");
    // back in order, then the background
    for (let k = 0; k < 3; k += 1) await js(`[...document.querySelectorAll("#mar-list .mar-row")][${k}].querySelectorAll("button")[1].click()`);
    await js(`document.getElementById("mar-create").click()`);
    check(await waitFor(`document.getElementById("mar-result").innerText.length > 0`, 20000), `create: ${await text("mar-result")}`);
    console.log(`SMOKE screenshots in ${outDir}`);
    app.exit(failed ? 1 : 0);
});
