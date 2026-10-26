// Run with: npx electron tests/smoke/electron-interlude.mjs <out-dir> [lang=en] [--live]
// --live: Interlude followed live instead (needs native/interlude-reader built: the reader and its fake Interlude):
// the fake Interlude (an F# program with Interlude's shapes, never the real game) runs, the real interlude-reader.exe
// reads it through the app's reader manager, and the card follows its selection from a fixture library holding the
// fake's chart hashes: a chart at 1.25× with the «Interlude · live» badge, the IL panel's live section, a chart that
// isn't in the library (its names and a note), osu! taking the card back and Interlude taking it again, then the
// error texts (field_not_found, dac_not_found with its hint). Screenshots live-<lang>-*.png.
// Interlude end to end at 460×760 with the real modules (app/interludeClient.js, app/interludeIpc.js, the selection
// controller, registerRateIpc) over a fake portable Interlude folder (tests/fixtures/interludeFolder.js: charts.db,
// scores.db, assets — synthetic charts, in the temp folder): the IL panel unlinked, the folder picked (a stubbed
// dialog), the library searched, a chart put on the card (a fake analysis), a rate copy made of it and "sent"
// (Interlude is never started or focused for real: the process check, pipe, start and Explorer are stubs), a marathon
// list added as a playlist to the fixture's Data\collections.json. The fixture folder must change in nothing but that
// file. Screenshots go to <out-dir>; exits 0 when every check holds.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterludeClient } from "../../app/interludeClient.js";
import { registerInterludeIpc } from "../../app/interludeIpc.js";
import { createSelectionController } from "../../app/selectionController.js";
import { registerRateIpc } from "../../app/rateIpc.js";
import { createJsonStore } from "../../app/jsonStore.js";
import { numericToLabel } from "../../src/core/labels.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeChart } from "../fixtures/makeChart.js";
import { makeInterludeFolder } from "../fixtures/interludeFolder.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-interlude.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=") && !a.startsWith("--")) ?? path.join(here, "interlude-out"));
const liveMode = args.includes("--live");
const lang = setLang(args.includes("lang=en") ? "en" : "ru");
const userData = path.join(outDir, `user-data-${lang}`);
const docsDir = path.join(outDir, `docs-${lang}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", userData); // never the real app's folder

// 6 s of silence as a .wav, the song of every fixture chart
function silence() {
    const n = 6 * 22050;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + n * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n * 2, 40);
    return Buffer.concat([h, Buffer.alloc(n * 2)]);
}
const listing = (dir) => readdirSync(dir, { recursive: true }).map((n) => path.join(dir, n))
    .filter((f) => statSync(f).isFile()).map((f) => `${path.relative(dir, f)} ${statSync(f).size} ${statSync(f).mtimeMs}`).sort();

function fakeResult(text, rate) {
    const notes = (text.split("[HitObjects]")[1] ?? "").trim().split(/\r?\n/).length;
    const numeric = Math.round((11 + notes / 400 + 3 * (rate - 1)) * 10) / 10;
    return { kind: "ok", numeric, label: numericToLabel(numeric).text, halfWidth: 0.3, confidence: "high", primary: "Jumpstream",
        top3: [{ name: "Jumpstream", share: 0.5 }, { name: "Stream", share: 0.3 }], tech: false, bpm: 180, durationSec: 20, rate,
        calcs: {}, msd: { overall: 22.1, stream: 21.4, jumpstream: 22.1, handstream: 15, stamina: 20, jackspeed: 12, chordjack: 13, technical: 18 } };
}

app.whenReady().then(async () => {
    if (liveMode) return runLive();
    rmSync(userData, { recursive: true, force: true });

    rmSync(docsDir, { recursive: true, force: true });
    mkdirSync(userData, { recursive: true });
    const wav = silence();
    const chart = (o) => makeChart({ seconds: 12, ...o }).replace("AudioFilename: audio.mp3", "AudioFilename: audio.wav");
    const fx = await makeInterludeFolder({
        charts: [
            { osuText: chart({ kind: "stream", bpm: 180 }), title: "Freedom Dive", artist: "xi", version: "4K Another", creator: "Mapper", beatmapId: 111, beatmapsetId: 11, audio: wav },
            { osuText: chart({ kind: "jumpstream", bpm: 170 }), title: "Blue Zenith", artist: "xi", version: "Hyper", creator: "Mapper", beatmapId: 222, beatmapsetId: 22, audio: wav, keepOriginal: true },
            { osuText: chart({ kind: "jack", bpm: 150 }), title: "Chronostasis", artist: "Camellia", version: "Insane", creator: "Someone", beatmapId: 333, beatmapsetId: 33, audio: wav },
            { osuText: chart({ kind: "stream", keys: 7 }), title: "Seven", artist: "Other", version: "7K", creator: "X" },
        ],
        plays: [{ index: 0, at: Date.now() - 86_400_000 }],
    });
    console.log("fixture", fx.root);
    const before = listing(fx.root);
    const calls = { reveal: [], launch: [], pipe: [], dialog: 0 };
    let win = null;
    const send = (channel, payload) => win?.webContents.send(channel, payload);
    const interlude = createInterludeClient({
        store: createJsonStore({ file: path.join(userData, "interlude.json"), fallback: { folder: null } }),
        docsDir, mapsDir: path.join(docsDir, "карты"), cacheDir: path.join(userData, "interlude-cache"),
        log: (line) => console.log("log", line),
        // stubs: the real Interlude is never looked for, focused or started
        running: async () => false, pipe: async (m) => { calls.pipe.push(m); return true; },
        launch: (exe) => calls.launch.push(exe), reveal: (file) => calls.reveal.push(file),
        onChange: () => void interlude.status().then((s) => send("interlude-state", s)),
    });
    const controller = createSelectionController({
        fetchOsu: async () => { throw new Error("no osu!"); },
        analyze: async (text, rate) => fakeResult(text, rate),
        cache: { get: async () => undefined, set: async () => {} },
        onView: (view) => send("view", view),
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    registerInterludeIpc({
        ipcMain, interlude, card: controller, window: () => win, paths: { docsDir }, send, log: (l) => console.log("log", l),
        dialog: { showOpenDialog: async () => { calls.dialog += 1; return { canceled: false, filePaths: [path.join(fx.root, "Songs")] }; } },
    });
    const analysis = { analyze: async (text, rate) => fakeResult(text, rate), analyzeQueued: async (text, rate) => fakeResult(text, rate) };
    registerRateIpc({
        ipcMain, analysis, interlude,
        tosu: { beatmapPath: async () => interlude.selection()?.path ?? "", beatmap: async () => interlude.beatmap() ?? { client: "stable", path: "" } },
        shell: { openPath: async () => "" },
        ffmpegPath: async () => (await import("ffmpeg-static")).default,
        paths: { userData, docsDir, mapsDir: path.join(docsDir, "карты") },
        send, log: (line) => console.log("log", line),
    });
    // the marathon tab's own channels, stubbed: "+ selected" answers the Interlude chart's copy
    ipcMain.handle("marathon-add-current", async () => {
        const sel = interlude.selection();
        return sel ? { ok: true, ok4k: true, path: sel.path, name: sel.label } : { ok: false, message: "none" };
    });
    ipcMain.handle("marathon-dan", async () => ({ label: "Gamma mid", numeric: 13, cutMs: null }));
    for (const ch of ["overlay-get", "overlay-set"]) ipcMain.handle(ch, () => null);
    // the card's profile line: a loaded profile, as the ui smoke answers it
    ipcMain.handle("profile-ensure", () => ({ ok: true, player: { id: 1, username: "TestPlayer", avatarUrl: "" },
        skill: { overall: 12.4, overallLabel: "Gamma low", tiles: { speed: 12.9, stamina: 12.5, tech: 11.8, jack: null }, msd: { Overall: 25 } } }));

    win = new BrowserWindow({ width: 460, height: 760, show: false, backgroundColor: "#14121c",
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
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 100) {
            if (await js(code)) return true;
            await sleep(100);
        }
        throw new Error(`timed out: ${code}
${await js("document.body.innerText.slice(0, 1500)")}`);
    };
    const report = {};
    win.webContents.send("settings", { alwaysOnTop: false, lang });
    win.webContents.send("view", { screen: "waiting-osu" });

    // Interlude's block on the Settings page (⚙ under the card) before a folder is linked; no IL button yet
    report.ilHidden = await js(`document.getElementById("interlude-toggle").hidden`);
    await js(`document.getElementById("settings-open").click(); document.getElementById("st-interlude").scrollIntoView({ block: "start" });`);
    await waitFor(`!document.getElementById("settings-page").hidden`);
    report.unlinked = await text("interlude-panel");
    await shot(`interlude-${lang}-1-unlinked.png`);

    // pick the folder (the Songs folder picked: its parent is Interlude's)
    await js(`[...document.querySelectorAll("#interlude-panel .il-actions button")][0].click();`);
    await waitFor(`document.querySelector("#interlude-panel .il-status").classList.contains("ok")`);
    await waitFor(`document.querySelectorAll("#interlude-panel .il-row").length === 3`);
    report.linked = await js(`document.querySelector("#interlude-panel .il-status").innerText`);
    report.rows = await js(`[...document.querySelectorAll("#interlude-panel .il-row .il-name")].map((n) => n.innerText)`);
    report.buttonLive = await js(`document.getElementById("interlude-toggle").classList.contains("live")`);
    await shot(`interlude-${lang}-2-library.png`);
    await js(`const s = document.querySelector("#interlude-panel .il-search"); s.value = "xi zenith"; s.dispatchEvent(new Event("input"));`);
    await waitFor(`document.querySelectorAll("#interlude-panel .il-row").length === 1`);
    report.searched = await js(`document.querySelector("#interlude-panel .il-row .il-name").innerText`);
    await shot(`interlude-${lang}-3-search.png`);

    // a chart on the card
    await js(`document.querySelector("#interlude-panel .il-row").click();`);
    await waitFor(`document.querySelector("#card .dan, #card .label, #card") && document.getElementById("osu-client").innerText === "Interlude"`);
    await sleep(300);
    report.answer = await js(`document.querySelector("#interlude-panel .il-answer").innerText`);
    report.badge = await text("osu-client");
    report.badgeTitle = await js(`document.getElementById("osu-client").title`);
    // the chart went on the card: the page gave way to it
    await waitFor(`document.getElementById("settings-page").hidden`);
    await shot(`interlude-${lang}-4-card.png`);
    report.card = (await text("card")).slice(0, 200);

    // the rate tab works on it: one copy at 1.1×, sent to Interlude as an .osz
    await js(`document.querySelector('[data-tab=rate]').click();`);
    await waitFor(`document.getElementById("rate-map").innerText.includes("Blue Zenith")`);
    report.rateMap = await text("rate-map");
    report.rateNote = await js(`!document.getElementById("rate-interlude-note").hidden && document.getElementById("rate-interlude-note").innerText`);
    await js(`const v = document.getElementById("rate-value"); v.value = "1.1"; v.dispatchEvent(new Event("change")); document.getElementById("rate-create").click();`);
    await waitFor(`document.getElementById("rate-status").innerText.includes("1.1")`, 60000);
    report.rateStatus = await text("rate-status");
    report.oszMade = readdirSync(path.join(docsDir, "карты"));
    report.revealed = calls.reveal.map((f) => path.basename(f));
    report.started = calls.launch.map((f) => path.basename(f));
    await shot(`interlude-${lang}-5-rate.png`);

    // the marathon tab: the chart in the list, then the list as a playlist in Interlude
    await js(`document.querySelector('[data-tab=marathon]').click();`);
    await js(`document.getElementById("mar-add-current").click();`);
    await waitFor(`document.querySelectorAll("#mar-list .mar-row, #mar-list > div").length >= 1 && !document.getElementById("mar-list").innerText.includes("…")`);
    await js(`const r = document.querySelector("#mar-list input.mar-rate"); r.value = "1.15"; r.dispatchEvent(new Event("change"));
        document.getElementById("mar-title").value = "Smoke course";`);
    report.exportButton = await js(`!document.querySelector("#mar-interlude .il-send").hidden && document.querySelector("#mar-interlude button").innerText`);
    await js(`document.querySelector("#mar-interlude button").click();`);
    await waitFor(`document.querySelector("#mar-interlude .il-answer").innerText.length > 1`);
    report.exported = await js(`document.querySelector("#mar-interlude .il-answer").innerText`);
    await js(`document.getElementById("marathon-tab").scrollTop = 1e6;`);
    await shot(`interlude-${lang}-6-marathon.png`);
    const collections = JSON.parse(readFileSync(path.join(fx.root, "Data", "collections.json"), "utf8"));
    report.playlist = collections.Playlists?.["Smoke course"]?.Charts ?? null;

    // the fixture: only Data\collections.json is new
    const after = listing(fx.root);
    report.fixtureChanged = after.filter((l) => !before.includes(l));
    report.overflow = await js(`(() => {
        const wide = [...document.querySelectorAll("#interlude-panel *, #rate-tab *, #marathon-tab *")]
            .filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
            .map((n) => n.id || n.className || n.tagName);
        return { page: document.documentElement.scrollWidth > document.documentElement.clientWidth, wide };
    })()`);
    console.log(JSON.stringify(report, null, 2));
    const ok = report.rows.length === 3 && report.searched.includes("Blue Zenith") && report.badge === t("interlude.badge.chart")
        && report.rateNote && report.oszMade.length === 1 && report.oszMade[0].endsWith(".osz") && report.revealed.length === 1
        && Array.isArray(report.playlist) && report.playlist.length === 1 && report.playlist[0][1].Rate === 1.15
        && report.fixtureChanged.length === 1 && report.fixtureChanged[0].startsWith(path.join("Data", "collections.json"))
        && !report.overflow.page && !report.overflow.wide.length && report.ilHidden === true && report.buttonLive === true;
    app.exit(ok ? 0 : 2);
}).catch((error) => {
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});

// ---- --live: the card following the (fake) running Interlude ----
async function runLive() {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const { createReaderProcess, readerPath } = await import("../../app/interludeReader.js");
    const { createInterludeLive, liveText } = await import("../../app/interludeLive.js");
    const READER = readerPath({ packaged: false, appDir });
    const FAKE = path.join(path.dirname(READER), "..", "fake", "FakeInterlude.exe");
    if (!existsSync(READER) || !existsSync(FAKE)) throw new Error(`build native/interlude-reader first (${READER}, ${FAKE})`);
    rmSync(userData, { recursive: true, force: true });
    rmSync(docsDir, { recursive: true, force: true });
    mkdirSync(userData, { recursive: true });
    const wav = silence();
    const chart = (o) => makeChart({ seconds: 12, ...o }).replace("AudioFilename: audio.mp3", "AudioFilename: audio.wav");
    // the fake's own hashes: hashB is the one it plays (a note every 50 ms), hashA a second chart
    const fx = await makeInterludeFolder({ charts: [
        { hash: "hashB", osuText: chart({ kind: "stream", bpm: 300, seconds: 100 }), title: "Blue Zenith", artist: "xi", version: "4K Insane", creator: "Mapper Two", audio: wav },
        { hash: "hashA", osuText: chart({ kind: "jumpstream", bpm: 170 }), title: "Freedom Dive", artist: "xi", version: "4K Another", creator: "Mapper One", audio: wav },
    ] });
    let win = null;
    const send = (channel, payload) => win?.webContents.send(channel, payload);
    let interlude = null;
    interlude = createInterludeClient({
        store: createJsonStore({ file: path.join(userData, "interlude.json"), fallback: { folder: null } }),
        docsDir, mapsDir: path.join(docsDir, "карты"), cacheDir: path.join(userData, "interlude-cache"),
        log: (line) => console.log("log", line), running: async () => false, pipe: async () => true, launch: () => {}, reveal: () => {},
        onChange: () => void interlude.status().then((s) => send("interlude-state", s)),
    });
    await interlude.link(fx.root);
    let osuText = "osu";
    let lastView = null;
    const titleOf = () => lastView?.result?.title ?? "";
    const controller = createSelectionController({
        fetchOsu: async () => osuText,
        // the fake analysis keeps the map's title, so what is on the card can be told
        analyze: async (text, rate) => ({ ...fakeResult(text, rate), title: /^Title:(.*)$/m.exec(text)?.[1]?.trim() ?? "" }),
        cache: { get: async () => undefined, set: async () => {} },
        onView: (view) => { lastView = view; send("view", view); },
    });
    let live = null;
    live = createInterludeLive({
        interlude, card: controller, log: (l) => console.log("log", l),
        onState: (s) => void interlude.liveSettings().then((settings) => send("interlude-live", { ok: true, settings, state: s, text: liveText(s) })),
    });
    const reader = createReaderProcess({
        exe: () => READER, args: () => ["--name", "FakeInterlude"], // the fake only, never a real Interlude
        onMessage: (m) => live.onMessage(m), onState: (s) => live.onReader(s), log: (l) => console.log("log", l),
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    registerInterludeIpc({
        ipcMain, interlude, card: controller, window: () => win, paths: { docsDir }, send, log: (l) => console.log("log", l),
        interludeLive: () => ({ state: live.state(), text: live.text() }),
    });
    for (const ch of ["overlay-get", "overlay-set"]) ipcMain.handle(ch, () => null);
    ipcMain.handle("profile-ensure", () => ({ ok: true, player: { id: 1, username: "TestPlayer", avatarUrl: "" },
        skill: { overall: 12.4, overallLabel: "Gamma low", tiles: { speed: 12.9, stamina: 12.5, tech: 11.8, jack: null }, msd: { Overall: 25 } } }));

    win = new BrowserWindow({ width: 460, height: 760, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (e) => {
        if (e.level === "warning" || e.level === "error") console.log("console", e.level, e.message, `${path.basename(e.sourceId ?? "")}:${e.lineNumber}`);
    });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
        console.log("shot", name);
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 100) {
            if (await js(code)) return true;
            await sleep(100);
        }
        throw new Error(`timed out: ${code}\n${await js("document.body.innerText.slice(0, 1500)")}`);
    };
    win.webContents.send("settings", { alwaysOnTop: false, lang });
    win.webContents.send("view", { screen: "waiting-osu" });

    const fake = spawn(FAKE, [], { stdio: ["pipe", "pipe", "pipe"] });
    let fakeOut = "";
    fake.stdout.on("data", (d) => { fakeOut += d; });
    const cmd = async (c) => {
        const at = fakeOut.length;
        fake.stdin.write(`${c}\n`);
        for (let w = 0; w < 5000 && !fakeOut.slice(at).includes(`ok ${c}`); w += 20) await sleep(20);
    };
    const report = {};
    const liveBadge = JSON.stringify(t("interlude.badge.live"));
    const panelLive = `document.querySelector("#interlude-panel .il-live")`;
    try {
        for (let w = 0; w < 15000 && !fakeOut.includes("ready"); w += 50) await sleep(50);
        reader.start();
        await waitFor(`document.getElementById("interlude-toggle").classList.contains("attached")`);
        await cmd("screen levelselect");
        await cmd("select hashB|Blue Zenith|xi|4K Insane|Mapper Two|4|100000|200|5.25");
        await cmd("rate 1.25");
        await waitFor(`document.getElementById("osu-client").innerText === ${liveBadge} && document.getElementById("card").innerText.includes("1.25")`);
        report.card = `${titleOf()} | ${(await js(`document.getElementById("card").innerText`)).slice(0, 200)}`;
        report.badge = await js(`document.getElementById("osu-client").innerText`);
        report.badgeTitle = await js(`document.getElementById("osu-client").title`);
        await shot(`live-${lang}-1-card.png`);
        // the IL button under the card opens the Settings page at Interlude's block
        await js(`document.getElementById("interlude-toggle").click();`);
        await waitFor(`!document.getElementById("settings-page").hidden && ${panelLive}.innerText.length > 3`);
        report.liveLine = await js(`${panelLive}.innerText`);
        report.liveChecked = await js(`document.querySelectorAll("#interlude-panel .il-check input")[0].checked`);
        report.downloadChecked = await js(`document.querySelectorAll("#interlude-panel .il-check input")[1].checked`);
        await shot(`live-${lang}-2-panel.png`);
        await js(`document.getElementById("settings-back").click();`);

        // a chart Interlude has that the linked library doesn't: its names and a note
        await cmd("select hashZ|Unknown Song|Someone|4K Hard|Nobody|4|90000|180|4.2");
        await waitFor(`document.querySelector("#card .external-info") !== null`);
        report.info = await js(`document.querySelector("#card .external-info").innerText`);
        await shot(`live-${lang}-3-not-in-library.png`);

        // osu! changes its selection last: osu!'s map; then Interlude again
        send("osu-client", { client: "stable" }); // osu! stable running beside Interlude
        controller.onFrame({ state: "songselect", checksum: "osu-1", rate: 1, client: "stable" });
        osuText = makeChart({ kind: "jack", bpm: 150, seconds: 12 }).replace(/^Title:.*$/m, "Title:From osu");
        controller.onFrame({ state: "songselect", checksum: "osu-2", rate: 1, client: "stable" });
        await waitFor(`!document.querySelector("#card .external-info") && document.getElementById("card").innerText.length > 20`);
        report.osuTook = `${titleOf()} | badge ${await js(`document.getElementById("osu-client").innerText`)}`;
        await shot(`live-${lang}-4-osu-took-the-card.png`);
        await cmd("select hashA|Freedom Dive|xi|4K Another|Mapper One|4|258000|222|6.75");
        await waitFor(`document.getElementById("osu-client").innerText === ${liveBadge} && document.getElementById("card").innerText.includes("1.25")`);
        report.interludeTookBack = titleOf();
        await shot(`live-${lang}-5-back-to-interlude.png`);

        // the error texts: an Interlude update renamed a field; no DAC for this runtime (download off: the hint)
        live.onMessage({ v: 1, status: "error", code: "field_not_found", reason: "field SelectedChart._rate/rate not found (Interlude version 0.7.29.0)" });
        await js(`document.getElementById("settings-open").click(); document.getElementById("st-interlude").scrollIntoView({ block: "start" });`);
        await waitFor(`${panelLive}.classList.contains("bad")`);
        report.fieldText = await js(`${panelLive}.innerText`);
        report.warn = await js(`document.getElementById("interlude-toggle").classList.contains("warn")`);
        await shot(`live-${lang}-6-field-not-found.png`);
        live.onMessage({ v: 1, status: "waiting", reason: "process exited" });
        live.onMessage({ v: 1, status: "error", code: "dac_not_found", reason: "no mscordaccore.dll for 9.0.30" });
        await waitFor(`${panelLive}.innerText.includes(${JSON.stringify(t("app.interlude.live.dacHint").slice(0, 20))})`);
        report.dacText = await js(`${panelLive}.innerText`);
        await shot(`live-${lang}-7-dac-not-found.png`);
        // the setting turned on → saved (main starts the reader again with --allow-download)
        await js(`const c = document.querySelectorAll("#interlude-panel .il-check input")[1]; c.checked = true; c.dispatchEvent(new Event("change"));`);
        await sleep(400);
        report.saved = JSON.parse(readFileSync(path.join(userData, "interlude.json"), "utf8"));
        report.overflow = await js(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    } finally {
        await reader.stop();
        fake.kill();
    }
    console.log(JSON.stringify(report, null, 2));
    const ok = report.badge === t("interlude.badge.live") && report.card.includes("Blue Zenith") && report.liveChecked === true && report.downloadChecked === false
        && report.info.includes("Unknown Song") && report.info.includes(t("app.interlude.live.notInLibrary").slice(0, 20))
        && report.osuTook.includes("From osu") && !report.osuTook.includes(t("interlude.badge.live")) && report.interludeTookBack.includes("Freedom Dive")
        && report.fieldText.includes("SelectedChart._rate") && report.warn && report.dacText.includes(t("app.interlude.live.dacHint"))
        && report.saved.allowDownload === true && report.saved.folder === fx.root && !report.overflow;
    app.exit(ok ? 0 : 2);
}
