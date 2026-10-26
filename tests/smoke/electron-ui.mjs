// Run with: npx electron tests/smoke/electron-ui.mjs <out.png> [calc=<id>] [lang=en] — renders the card with a sample view.
// [details]: the analysis tab's blocks under the card too (difficulty line, strip, the dan by part, "for you", the
// ladder folded; [ladder] opens it); exits 1 when the card scrolls sideways, or when the dan by part is missing, its
// hardest part is not marked, a part under the pointer is not told or the card's dan changed. [parts]: the screenshot
// at the dan by part with its list of parts unfolded and a part tapped. [detailed]: the card and the strip in the Detailed mode
// (the «Общие / Подробно» switch clicked), with finder sub-types in the sample. [overlay]: the Settings page opened by ⚙
// at its overlay block (the in-game overlay on, KPS off, as if set in the tray); exits 1 when it is missing or spills
// out of the window.
// [client=lazer|stable]: main says which osu! tosu reads; the footer must name it (exits 1 otherwise).
// [updated]: the "osu! updated?" screen instead of the card (with client=lazer, lazer's own hint).
// [above]: every dan of the sample 8.5 higher (the card at 21.3, the ladder and the profile past Kappa high), so
// the card, "for you" and the ladder show «выше Kappa». User data goes next to <out.png>.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyPatch, normalizeOverlaySettings } from "../../src/overlay/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const outPng = path.resolve(process.argv.find((a) => a.endsWith(".png")));
app.setPath("userData", path.join(path.dirname(outPng), "user-data-ui"));
const create = process.argv.includes("create");
const calc = process.argv.find((a) => a.startsWith("calc="))?.slice(5);
// >>> analysis v2: details
const details = process.argv.includes("details");
const ladder = process.argv.includes("ladder");
const partsShot = process.argv.includes("parts");
const detailedMode = process.argv.includes("detailed");
const overlayPanel = process.argv.includes("overlay");
const client = process.argv.find((a) => a.startsWith("client="))?.slice(7) ?? null;
const updated = process.argv.includes("updated");
const SMOKE_KEY = "smoke@1.500";
const LIFT = process.argv.includes("above") ? 8.5 : 0;
const lift = (x) => Math.round((x + LIFT) * 100) / 100;
const strain = Array.from({ length: 120 }, (_, i) => Math.round((0.35 + 0.25 * Math.sin(i / 9) + (i > 70 && i < 84 ? 0.4 : 0)) * 1000) / 1000);
const peak = Math.max(...strain);
const familyAt = (i) => (i < 4 ? "-" : i < 50 ? "jumpstream" : i < 58 ? "-" : i < 85 ? "handstream" : i < 100 ? "tech" : "jumpstream");
const flavourAt = (i) => ({ jumpstream: i % 30 < 18 ? "Jumptrill" : "Anchor", handstream: i < 72 ? "ChordTrills" : "DenseHandstream", tech: "Coordination" })[familyAt(i)] ?? "-";
const sampleDetails = {
    v: 2, durationSec: 161, strain: strain.map((v) => Math.round((v / peak) * 1000) / 1000),
    hardest: [{ fromSec: 95.6, toSec: 112.7, peak: 1 }, { fromSec: 20.1, toSec: 26.8, peak: 0.9 }],
    families: Array.from({ length: 120 }, (_, i) => familyAt(i)),
    flavours: [{ id: "Jumptrill", share: 0.31 }, { id: "Anchor", share: 0.18 }, { id: "ChordTrills", share: 0.12 }],
    flavourBins: Array.from({ length: 120 }, (_, i) => flavourAt(i)),
};
// the dan by part as main sends it (src/analysis/sections.js): calm intro, a break, two hard stretches, a short outro
const sampleSections = {
    v: 1, rate: 1.5, durationSec: 161, top: 4,
    parts: [
        { fromSec: 0, toSec: 14.2, notes: 110, raw: 9.6, supportSec: 161, dan: lift(9.4), primary: "Stream", tech: false },
        { fromSec: 14.2, toSec: 38.5, notes: 420, raw: 12.1, supportSec: 120, dan: lift(12.0), primary: "Jumpstream", tech: false },
        { fromSec: 38.5, toSec: 52, notes: 20, raw: null, supportSec: null, dan: null, primary: null, tech: false },
        { fromSec: 57.4, toSec: 89.1, notes: 610, raw: 12.6, supportSec: 96, dan: lift(12.5), primary: "Handstream", tech: false },
        { fromSec: 89.1, toSec: 118.3, notes: 590, raw: 13.1, supportSec: 61, dan: lift(13.1), primary: "Handstream", tech: true },
        { fromSec: 118.3, toSec: 147.9, notes: 540, raw: 12.8, supportSec: 90, dan: lift(12.7), primary: "Jumpstream", tech: false },
        { fromSec: 147.9, toSec: 161, notes: 160, raw: 11.2, supportSec: 140, dan: lift(10.9), primary: "Minitrills", tech: false },
    ],
};
const player = { id: 1, username: "TestPlayer", avatarUrl: "" };
const skill = { overall: lift(12.4), overallLabel: LIFT ? "" : "Gamma low", tiles: { speed: lift(12.9), stamina: lift(12.5), tech: lift(11.8), jack: null },
    msd: { Overall: 25, Stream: 24.6, Jumpstream: 24.3, Handstream: 22.1, Stamina: 23.9, Chordjack: 20.4, JackSpeed: 18.2, Technical: 24.8 } };
// <<< analysis v2
// [detailed]: the finder's sub-types, so the two modes differ (General: their families; Detailed: the kinds' names)
const view = { screen: "result", result: {
    kind: "ok", label: LIFT ? "" : "Gamma low/mid", numeric: lift(12.8), halfWidth: 0.34, confidence: "высокая", primary: detailedMode ? "Jumptrill" : "Jumpstream",
    top3: detailedMode
        ? [{ name: "Jumptrill", share: 0.46 }, { name: "Handstream", share: 0.22 }, { name: "Minijacks", share: 0.15 }]
        : [{ name: "Jumpstream", share: 0.46 }, { name: "Handstream", share: 0.22 }, { name: "Chordjacks", share: 0.15 }],
    tech: true, bpm: 200, durationSec: 161, rate: 1.5,
    calcs: { mixed: lift(13.2), daniel: lift(12.7), azusa: lift(13), roxy: lift(12.9), companella: lift(11.6) }, sunny: 6.34,
    msd: { overall: 26.2, stream: 24.11, jumpstream: 25.94, handstream: 16.98, stamina: 23.98, jackspeed: 17.14, chordjack: 18.02, technical: 25.27 } } };

app.whenReady().then(async () => {
    // what main.js answers the preload; lang=en on the command line renders the English card
    ipcMain.on("get-lang", (event) => { event.returnValue = process.argv.includes("lang=en") ? "en" : "ru"; });
    // >>> analysis v2: details — the profile and the ladder's dans (12.8 at 1.5×, about 1.7 per 0.1×)
    if (details) {
        ipcMain.handle("profile-ensure", () => ({ ok: true, player, skill }));
        ipcMain.handle("analysis-rate", async (_e, { key, rate }) => {
            await new Promise((r) => setTimeout(r, 60));
            const numeric = Math.round((12.8 + LIFT - (1.5 - rate) * 3.4) * 10) / 10;
            return key === SMOKE_KEY ? { ok: true, rate, kind: "ok", label: "", numeric, primary: "Jumpstream" } : { ok: false, stale: true };
        });
    }
    // <<< analysis v2
    // the overlay's channels, as app/overlay/overlayManager.js answers them
    let overlay = { settings: applyPatch(normalizeOverlaySettings(null), { enabled: true, widgets: { kps: { enabled: false } } }), edit: false };
    ipcMain.handle("overlay-get", () => overlay);
    ipcMain.handle("overlay-set", (_e, patch) => (overlay = { ...overlay, settings: applyPatch(overlay.settings, patch) }));
    ipcMain.on("overlay-edit", (_e, on) => { overlay = { ...overlay, edit: on }; });
    ipcMain.on("overlay-open-settings", () => {});
    const win = new BrowserWindow({ width: create ? 460 : 320, height: create ? 760 : detailedMode ? 640 : 380, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (_e, level, msg) => console.log("console", level, msg));
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    win.webContents.send("settings", { alwaysOnTop: true });
    win.webContents.send("view", updated ? { screen: "osu-updated" } : view);
    if (client) win.webContents.send("osu-client", { client });
    // >>> analysis v2: details — the view with its key, its details and a loaded player, as main sends them
    if (details) {
        win.webContents.send("view", { ...view, key: SMOKE_KEY });
        win.webContents.send("analysis-details", { key: SMOKE_KEY, details: sampleDetails });
        // the dan by part comes a moment later than the details: «считаем…» first
        await new Promise((r) => setTimeout(r, 120));
        const waiting = await win.webContents.executeJavaScript(`document.querySelector("#card .an-sec-wait")?.textContent ?? null`);
        win.webContents.send("analysis-sections", { key: SMOKE_KEY, sections: sampleSections });
        win.webContents.send("profile-changed", { player, skill });
        await new Promise((r) => setTimeout(r, 200));
        // the ladder's state is remembered in localStorage: make it what was asked for
        await win.webContents.executeJavaScript(`{ const b = document.querySelector("[data-toggle=ladder]");
            if (b && (b.getAttribute("aria-expanded") === "true") !== ${ladder}) b.click(); }`);
        await new Promise((r) => setTimeout(r, 1000));
        // the mode is remembered too: General first (what it shows), then Detailed when asked for
        const shown = () => win.webContents.executeJavaScript(`(() => ({
            primary: document.querySelector("#card .primary")?.textContent,
            bars: [...document.querySelectorAll("#card .bar-row span:first-child")].map((s) => s.textContent),
            strip: [...document.querySelectorAll("#card .an-fam i")].map((i) => i.title).filter((x, k, a) => x && a.indexOf(x) === k),
            legend: document.querySelector("#card .an-legend")?.textContent,
            mode: document.querySelector("#card .pm-switch .sel")?.dataset.patternMode,
        }))()`);
        await win.webContents.executeJavaScript(`document.querySelector("#card [data-pattern-mode=general]")?.click(); true`);
        await new Promise((r) => setTimeout(r, 300));
        console.log("SMOKE general", JSON.stringify(await shown()));
        if (detailedMode) {
            await win.webContents.executeJavaScript(`document.querySelector("#card [data-pattern-mode=detailed]")?.click(); true`);
            await new Promise((r) => setTimeout(r, 300));
            const now = await shown();
            console.log("SMOKE detailed", JSON.stringify(now));
            if (now.mode !== "detailed" || !now.strip.length) process.exitCode = 1;
        }
        // the dan by part: its bars, the hardest marked, the whole map's line, a part told under the pointer
        const parts = await win.webContents.executeJavaScript(`(() => {
            const block = document.querySelector("#card .an-sec");
            if (!block) return null;
            const bars = [...block.querySelectorAll(".an-sec-bar")];
            const info = () => block.querySelector(".an-sec-info")?.textContent ?? "";
            const before = info();
            bars[1]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            const hovered = info();
            document.getElementById("card").dispatchEvent(new MouseEvent("mouseleave"));
            const r = block.getBoundingClientRect();
            const plot = block.querySelector(".an-sec-plot").getBoundingClientRect();
            return {
                title: block.querySelector(".an-title")?.textContent, chip: block.querySelector(".an-chip")?.textContent,
                bars: bars.length, top: bars.filter((b) => b.classList.contains("an-sec-top")).map((b) => b.dataset.part),
                heights: bars.map((b) => Math.round(b.getBoundingClientRect().height)),
                names: [...block.querySelectorAll(".an-sec-name")].map((n) => n.textContent),
                axis: [...block.querySelectorAll(".an-sec-axis span")].map((n) => n.textContent),
                map: block.querySelector(".an-sec-map") && block.querySelector(".an-sec-key")?.textContent, before, hovered, after: info(),
                inside: r.left >= 0 && r.right <= innerWidth + 1, plotWidth: Math.round(plot.width),
                card: document.querySelector("#card .dan-num, #card .numeric, #card .dan")?.textContent ?? null,
                cardText: document.querySelector("#card").innerText.slice(0, 120),
            };
        })()`);
        console.log("SMOKE parts", JSON.stringify({ waiting, ...parts }));
        const partsOk = waiting && parts && parts.bars === 7 && parts.top.join() === "4" && parts.hovered !== parts.before
            && parts.after === parts.before && parts.map && parts.axis.length >= 2 && parts.inside
            && parts.cardText.includes((12.8 + LIFT).toFixed(1));
        if (!partsOk) process.exitCode = 1;
        if (partsShot) {
            // the list's state is remembered in localStorage: open it unless it is
            await win.webContents.executeJavaScript(`{ const b = document.querySelector("#card [data-toggle=parts]");
                if (b && b.getAttribute("aria-expanded") !== "true") b.click(); } true`);
            await new Promise((r) => setTimeout(r, 150));
            await win.webContents.executeJavaScript(`document.querySelector("#card .an-sec-bar[data-part='5']")?.click(); true`);
            await new Promise((r) => setTimeout(r, 150));
            const rows = await win.webContents.executeJavaScript(`[...document.querySelectorAll("#card .an-srow")].map((r) => r.innerText.replace(/\\s+/g, " "))`);
            const told = await win.webContents.executeJavaScript(`document.querySelector("#card .an-sec-info")?.textContent`);
            console.log("SMOKE parts list", JSON.stringify({ rows, told }));
            if (rows.length !== 7 || !told.startsWith("1:58–2:28")) process.exitCode = 1;
        }
        const sideways = await win.webContents.executeJavaScript("(() => { const c = document.getElementById('card'); return c.scrollWidth - c.clientWidth; })()");
        console.log("SMOKE sideways", sideways);
        if (sideways > 0) process.exitCode = 1;
        // the blocks sit under the card: scroll down to them for the screenshot ([parts]: to the dan by part)
        if (partsShot) await win.webContents.executeJavaScript(`document.querySelector("#card .an-sec").scrollIntoView({ block: "start" }); true`);
        else if (!detailedMode) await win.webContents.executeJavaScript("document.getElementById('card').scrollTop = 1e6");
        // a hidden window does not paint a scroll by itself: a 1 px resize makes it draw a new frame
        const [w, h] = win.getSize();
        win.setSize(w + 1, h);
        await new Promise((r) => setTimeout(r, 150));
        win.setSize(w, h);
    }
    // <<< analysis v2
    if (calc) await win.webContents.executeJavaScript(`const s = document.getElementById("calc"); s.value = ${JSON.stringify(calc)}; s.dispatchEvent(new Event("change"));`);
    if (create) await new Promise((r) => setTimeout(r, 500));
    if (create) await win.webContents.executeJavaScript(`document.querySelector('[data-tab=create]').click();
        document.querySelector('#patterns span:nth-child(4)').click();`);
    if (overlayPanel) {
        await new Promise((r) => setTimeout(r, 200));
        const seen = await win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById("settings-open");
            b.click();
            document.getElementById("st-overlay").scrollIntoView({ block: "start" });
            const p = document.getElementById("overlay-panel");
            const r = p.getBoundingClientRect();
            return { button: Boolean(b.offsetParent), open: !document.getElementById("settings-page").hidden && p.getClientRects().length > 0, text: p.innerText,
                checked: [...p.querySelectorAll("input")].map((i) => i.checked),
                inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
                sideways: document.documentElement.scrollWidth - innerWidth };
        })()`);
        console.log("SMOKE overlay", JSON.stringify(seen));
        const ok = seen.button && seen.open && seen.inside && seen.checked.join() === "true,true,false,true,true,true";
        if (!ok || seen.sideways > 0) process.exitCode = 1;
        // a hidden window does not paint by itself: a 1 px resize makes it draw the open panel
        const [w, h] = win.getSize();
        win.setSize(w + 1, h);
        await new Promise((r) => setTimeout(r, 150));
        win.setSize(w, h);
    }
    if (client) {
        await new Promise((r) => setTimeout(r, 200));
        const badge = await win.webContents.executeJavaScript(`(() => { const b = document.getElementById("osu-client");
            return { shown: !b.hidden && b.getClientRects().length > 0, text: b.textContent, title: b.title, card: document.getElementById("card").innerText }; })()`);
        console.log("SMOKE client", JSON.stringify(badge));
        if (!(badge.shown && badge.text === client && badge.title.includes(`osu! ${client}`))) process.exitCode = 1;
        if (updated && client === "lazer" && !badge.card.includes("lazer")) process.exitCode = 1;
        // a hidden window does not paint by itself: a 1 px resize makes it draw the new texts
        const [w, h] = win.getSize();
        win.setSize(w + 1, h);
        await new Promise((r) => setTimeout(r, 150));
        win.setSize(w, h);
    }
    await new Promise((r) => setTimeout(r, 400));
    if (!details && !client) {
        // a hidden window does not paint by itself: a 1 px resize makes it draw the card
        const [w, h] = win.getSize();
        win.setSize(w + 1, h);
        await new Promise((r) => setTimeout(r, 150));
        win.setSize(w, h);
        await new Promise((r) => setTimeout(r, 150));
    }
    writeFileSync(outPng, (await win.webContents.capturePage()).toPNG());
    app.exit(process.exitCode ?? 0);
});
