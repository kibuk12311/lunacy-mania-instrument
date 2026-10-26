// Run with: npx electron tests/smoke/electron-create.mjs <outDir> [lang=en]
// The create tab's preview (mapgen v3, B8) in a real window, 480 px wide, with nothing real behind it: a 60 s click track
// at 174 BPM is loaded through the file input, detect-timing and generate-map answer from tests/fixtures/generateResult.json,
// three variants are made, the song is sought to 0:30 on the timeline; then the timing, parts, playfield and cards are
// captured to <outDir>/create-<part>-<lang>.png and whatever sticks out of the tab sideways is listed. Then the Detailed
// mode: three kinds for the map and one for the part, three more variants, the patterns, part editor and cards captured
// (create-detailed-*.png); back in General a run sends families only and the kinds stay remembered. Exits 1 when the
// tab scrolls sideways or a mode check fails. User data stays in outDir.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clickTrack } from "../fixtures/clickTrack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const outDir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("-") && !a.includes("=") && !a.endsWith(".mjs")) ?? "smoke-out");
const lang = process.argv.includes("lang=en") ? "en" : "ru";
const fixture = JSON.parse(readFileSync(path.join(here, "..", "fixtures", "generateResult.json"), "utf8"));
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));

// 16-bit mono WAV of the click track
function wav(samples, sampleRate) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(sampleRate, 24);
    head.writeUInt32LE(sampleRate * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
}
const song = path.join(outDir, "click174.wav");
const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312, seconds: 60, sampleRate: 22050 });
writeFileSync(song, wav(samples, sampleRate));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(win, expr, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 100) {
        if (await win.webContents.executeJavaScript(expr)) return true;
        await sleep(100);
    }
    return false;
}

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.on("tab", () => {});
    ipcMain.handle("detect-timing", async () => ({
        ok: true, timing: { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 }, modelInfo: fixture.modelInfo,
    }));
    let made = 0;
    const requests = [];
    ipcMain.handle("generate-map", async (event, req) => {
        made += 1;
        requests.push(req.request);
        for (const phase of ["prepare", "search", "describe"]) {
            event.sender.send("generate-progress", { jobId: req.jobId, phase, i: 0, n: 1 });
            await sleep(60);
        }
        const numeric = [13.04, 12.86, 13.31][(made - 1) % 3];
        // a request with kinds (the Detailed mode) gets kinds back, as the worker would report them
        const kinds = [...req.request.patterns, ...(req.request.parts ?? []).flatMap((p) => p.patterns ?? [])].flatMap((p) => p.flavours ?? []);
        const flavoured = kinds.length ? {
            familyScore: 0.74, flavourScore: [0.81, 0.68, 0.9][(made - 1) % 3],
            flavours: kinds.slice(0, 3).map((id, k) => ({ id, share: [0.41, 0.23, 0.12][k] })),
            parts: (fixture.parts ?? []).map((p, k) => (p.empty ? p : { ...p, flavours: [kinds[k % kinds.length]], flavourScore: 0.7 + 0.05 * (k % 4), detected: [] })),
        } : {};
        return {
            ...fixture, id: `smoke-${made}`, planSeed: req.request.planSeed, noteSeed: req.request.noteSeed,
            patternScore: [0.79, 0.86, 0.71][(made - 1) % 3], result: { ...fixture.result, numeric }, range: req.request.range, ...flavoured,
        };
    });
    ipcMain.handle("song-tags", async () => ({ ok: true, artist: "Unknown", title: "click174" }));
    ipcMain.handle("export-set", async () => ({ ok: false, message: "smoke test: nothing is saved" }));

    const win = new BrowserWindow({ width: 480, height: 880, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const problems = [];
    win.webContents.setAudioMuted(true); // the song plays below, nothing is heard
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) problems.push(msg); });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab=create]').click(); true`);
    await sleep(300);

    // the file input gets the WAV the way a picked file does
    const dbg = win.webContents.debugger;
    dbg.attach("1.3");
    const { root } = await dbg.sendCommand("DOM.getDocument", {});
    const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
    await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [song] });
    dbg.detach();
    const loaded = await until(win, `!document.getElementById("generate").disabled`);

    await win.webContents.executeJavaScript(`document.getElementById("generate").click(); true`);
    const generated = await until(win, `document.querySelectorAll(".cr-card").length >= 3 && document.getElementById("generate").textContent !== ${JSON.stringify(lang === "en" ? "Stop" : "Стоп")}`, 20000);

    // seek to 0:30 by clicking the middle of the timeline (the song is 60 s)
    await win.webContents.executeJavaScript(`(() => {
        const c = document.getElementById("timeline");
        c.scrollIntoView({ block: "center" });
        const r = c.getBoundingClientRect();
        const at = { clientX: r.left + r.width * 0.5, clientY: r.top + 20, button: 0, buttons: 1, bubbles: true, pointerId: 1 };
        c.dispatchEvent(new PointerEvent("pointerdown", at));
        c.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
        return true;
    })()`);
    await sleep(200);

    // the player: ▶ moves the clock on from 0:30, ❚❚ stops it; «check by ear» plays 8 s and comes back
    const play = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const button = document.querySelector(".cr-play");
        const time = () => document.querySelector(".cr-time").textContent;
        const before = time();
        button.click();
        await sleep(1200);
        const playing = time();
        const label = button.textContent;
        button.click();
        await sleep(100);
        const listen = document.getElementById("listen");
        listen.click();
        await sleep(600);
        const checking = listen.textContent;
        listen.click();
        await sleep(100);
        return { before, playing, label, after: time(), checking, listenAfter: listen.textContent };
    })()`);
    await win.webContents.executeJavaScript(`(() => {
        const c = document.getElementById("timeline");
        const r = c.getBoundingClientRect();
        const at = { clientX: r.left + r.width * 0.5, clientY: r.top + 20, button: 0, buttons: 1, bubbles: true, pointerId: 1 };
        c.dispatchEvent(new PointerEvent("pointerdown", at));
        c.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
        return true;
    })()`);
    await sleep(200);

    const shots = {};
    for (const [name, id] of [["timing", "bpm"], ["parts", "parts-group"], ["preview", "preview"], ["cards", "gen-result"]]) {
        await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: "start" }); true`);
        await sleep(400);
        await win.webContents.capturePage(); // a hidden window may hand out its last frame once
        const file = path.join(outDir, `create-${name}-${lang}.png`);
        writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        shots[name] = file;
    }

    // The Detailed mode (the «Общие / Подробно» switch): three kinds for the map and one for the part under the cursor,
    // a new run, then the patterns, the part editor and the cards are captured; back in General the kinds stay
    // remembered but a run sends families only.
    const runAgain = async () => {
        const from = made;
        await win.webContents.executeJavaScript(`document.getElementById("generate").click(); true`);
        for (let waited = 0; waited < 20000 && made < from + 3; waited += 100) await sleep(100);
        return until(win, `document.getElementById("generate").textContent !== ${JSON.stringify(lang === "en" ? "Stop" : "Стоп")}`, 5000);
    };
    const detailed = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector("#pattern-mode [data-pattern-mode=detailed]").click();
        await sleep(150);
        for (const id of ["Anchor", "Jumptrill", "Rolls"]) document.querySelector("#patterns [data-flavour=" + id + "]").click();
        await sleep(100);
        document.querySelector("#part-editor [data-flavour=Gluts]")?.click();
        await sleep(150);
        return {
            families: document.querySelectorAll("#patterns .pp-family").length,
            chips: document.querySelectorAll("#patterns .pp-flavour").length,
            chosen: [...document.querySelectorAll("#patterns .pp-flavour.sel")].map((c) => c.dataset.flavour),
            partChosen: [...document.querySelectorAll("#part-editor .pp-flavour.sel")].map((c) => c.dataset.flavour),
        };
    })()`);
    detailed.ran = await runAgain();
    detailed.request = requests.at(-1)?.patterns;
    detailed.partRequest = (requests.at(-1)?.parts ?? []).filter((p) => p.patterns).map((p) => p.patterns);
    for (const [name, selector] of [["detailed-patterns", "#pattern-mode"], ["detailed-parts", "#parts-group"], ["detailed-cards", "#gen-result"]]) {
        await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "start" }); true`);
        await sleep(400);
        await win.webContents.capturePage();
        const file = path.join(outDir, `create-${name}-${lang}.png`);
        writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        shots[name] = file;
    }
    detailed.cardLines = await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cr-card")].slice(0, 1).map((c) => c.textContent.slice(0, 400))`);
    const wideDetailed = await win.webContents.executeJavaScript(`(() => {
        const tab = document.getElementById("create-tab");
        const edge = tab.getBoundingClientRect().right;
        return [...tab.querySelectorAll("*")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > edge + 1)
            .map((el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + el.className) + " " + Math.round(el.getBoundingClientRect().right - edge) + "px").slice(0, 20);
    })()`);
    const general = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector("#pattern-mode [data-pattern-mode=general]").click();
        await sleep(150);
        return { chips: document.querySelectorAll("#patterns > span").length, kinds: document.querySelectorAll("#patterns .pp-flavour").length };
    })()`);
    general.ran = await runAgain();
    general.request = requests.at(-1)?.patterns;
    general.remembered = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector("#pattern-mode [data-pattern-mode=detailed]").click();
        await sleep(150);
        const kept = [...document.querySelectorAll("#patterns .pp-flavour.sel")].map((c) => c.dataset.flavour);
        document.querySelector("#pattern-mode [data-pattern-mode=general]").click();
        return kept;
    })()`);
    const modeOk = detailed.families === 6 && detailed.chosen.length === 3 && detailed.ran && detailed.request?.some((p) => p.flavours?.length)
        && general.kinds === 0 && general.chips === 6 && general.ran && general.request?.every((p) => !p.flavours) && general.remembered.length === 3;

    const report = await win.webContents.executeJavaScript(`(() => {
        const tab = document.getElementById("create-tab");
        const edge = tab.getBoundingClientRect().right;
        const wide = [...tab.querySelectorAll("*")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > edge + 1)
            .map((el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + el.className) + " " + Math.round(el.getBoundingClientRect().right - edge) + "px").slice(0, 20);
        return {
            scrollWidth: tab.scrollWidth, clientWidth: tab.clientWidth, wide,
            status: document.getElementById("gen-status").textContent,
            cards: [...document.querySelectorAll(".cr-card .cr-card-head")].map((h) => h.textContent),
            time: document.querySelector(".cr-time")?.textContent,
            bpm: document.getElementById("bpm").value, offset: document.getElementById("offset").value,
            parts: document.getElementById("part-editor").textContent.slice(0, 120),
        };
    })()`);
    console.log(JSON.stringify({ lang, loaded, generated, made, play, ...report, detailed, wideDetailed, general, modeOk, shots, problems: problems.slice(0, 10) }, null, 2));
    app.exit(report.wide.length || wideDetailed.length || report.scrollWidth > report.clientWidth || !loaded || !generated || !modeOk ? 1 : 0);
});
