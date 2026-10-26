// Run with: npx electron tests/smoke/electron-session.mjs <out-dir> [lang=en]
// The picks tab's «Сессия» page through the real window, fully offline, over the real session modules
// (app/sessionLibrary.js, app/sessionIpc.js, src/recommend/session.js) and the real analyser (in this process): a fake
// Songs folder (tests/fixtures/songsFolder.js — synthetic 4K charts, plus 7K / osu!standard / a rate copy it must leave
// out) and a fake Interlude folder (tests/fixtures/interludeFolder.js), both in <out-dir>. The library is scanned and
// analysed, a session is built with a hand-set profile, one item and the whole session are drawn again, a session with
// rates, saved and opened, exported as an osu! collection (rate copies by a stub that writes into the fixture), as an
// Interlude playlist (into the fixture's collections.json; the Interlude process check is a stub) and as a marathon (a
// stub writes the .osz), copied as text; then a focus no map has (nothing near). A second scan must read nothing.
// No network from the window. Screenshots go to <out-dir>; exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session as electronSession, clipboard } from "electron";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSessionLibrary } from "../../app/sessionLibrary.js";
import { createSessionHandlers, normalizeSaved } from "../../app/sessionIpc.js";
import { createInterludeClient } from "../../app/interludeClient.js";
import { createInterludeHandlers } from "../../app/interludeIpc.js";
import { createJsonStore } from "../../app/jsonStore.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { decodeCollectionDb } from "../../src/recommend/collectionDb.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeChart } from "../fixtures/makeChart.js";
import { makeSongsFolder, withMeta, standardChart } from "../fixtures/songsFolder.js";
import { makeInterludeFolder } from "../fixtures/interludeFolder.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-session.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "session-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
const userData = path.join(outDir, `user-data-${lang}`);
const docsDir = path.join(outDir, `docs-${lang}`);
mkdirSync(outDir, { recursive: true });
rmSync(userData, { recursive: true, force: true });
rmSync(docsDir, { recursive: true, force: true });
app.setPath("userData", userData); // never the real app's folder
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};
const shotName = (name) => `${lang}-${name}`;
// Stamina (jumpstream's tile) Delta-ish for these synthetic charts: their dans run ~4…18
const MINE = { name: "TestPlayer", speed: 7, jack: 13, stamina: 11.6, tech: 10 };
const TOTAL = 41 + 19 + 6 + 2;

// A library of synthetic charts with a spread of dans: jumpstream 220…300 BPM, jacks 140…230, streams 250…300.
function fixtureSets() {
    const sets = [];
    let id = 500;
    const add = (kind, bpm, seconds, artist) => {
        id += 1;
        const title = `${kind[0].toUpperCase()}${kind.slice(1)} ${bpm}`;
        const text = withMeta(makeChart({ kind, bpm, seconds }), { Title: title, Artist: artist, Version: `4K ${bpm}`, BeatmapID: id * 10, BeatmapSetID: id });
        sets.push({ id, artist, title, charts: [{ file: `${artist} - ${title} (Test) [4K ${bpm}].osu`, text }] });
    };
    for (let bpm = 220; bpm <= 300; bpm += 2) add("jumpstream", bpm, 90 + ((bpm * 7) % 110), `Band ${bpm % 7}`);
    for (let bpm = 140; bpm <= 230; bpm += 5) add("jack", bpm, 80 + ((bpm * 11) % 100), `Crew ${bpm % 5}`);
    for (let bpm = 250; bpm <= 300; bpm += 10) add("stream", bpm, 100 + ((bpm * 3) % 90), "Solo");
    // what the library must leave out
    sets.push({
        id: 999, artist: "Other", title: "Not mania",
        charts: [
            { file: "Other - Not mania [7K].osu", text: makeChart({ kind: "stream", bpm: 200, keys: 7 }) },
            { file: "Other - Not mania [Normal].osu", text: standardChart() },
            { file: "Other - Not mania [rate].osu", text: withMeta(makeChart({ kind: "jumpstream", bpm: 240 }), { Tags: "lunacy-mania-rate" }) },
        ],
    });
    return sets;
}

app.whenReady().then(async () => {
    const blocked = [];
    electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const offline = /^(file|devtools|data|blob|chrome|about):/i.test(details.url);
        if (!offline) blocked.push(details.url);
        callback({ cancel: !offline });
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });

    const songs = await makeSongsFolder(fixtureSets());
    // Interlude: one chart that is a Songs map (the same .osu), two of its own
    const sameText = fixtureSets()[10].charts[0].text;
    const fx = await makeInterludeFolder({
        charts: [
            { osuText: sameText, title: /^Title:(.*)$/m.exec(sameText)[1], artist: /^Artist:(.*)$/m.exec(sameText)[1], version: /^Version:(.*)$/m.exec(sameText)[1], creator: "Test" },
            { osuText: makeChart({ kind: "jumpstream", bpm: 262, seconds: 140 }), title: "Interlude Only", artist: "Eta", version: "4K Insane", creator: "Mapper" },
            { osuText: makeChart({ kind: "jumpstream", bpm: 275, seconds: 120 }), title: "Interlude Too", artist: "Theta", version: "4K Extra", creator: "Mapper" },
        ],
    });
    const interlude = createInterludeClient({
        store: createJsonStore({ file: path.join(userData, "interlude.json"), fallback: { folder: fx.root } }),
        docsDir, mapsDir: path.join(docsDir, "карты"), cacheDir: path.join(userData, "interlude-cache"),
        running: async () => false, pipe: async () => false, reveal: () => {}, log: (l) => console.log("log", l),
    });
    const interludeHandlers = createInterludeHandlers({ interlude, paths: { docsDir }, log: (l) => console.log("log", l) });

    let send = () => {};
    let analysed = 0;
    const analyze = async (text, rate) => { analysed += 1; return analyzeChart(text, rate); };
    const makeLibrary = () => createSessionLibrary({
        songsDir: async () => songs, interlude, analyze, file: path.join(userData, "session-library.json"), analyzer: "smoke",
        log: (l) => console.log("log", l), onChange: (s) => send("session-library", s),
    });
    let library = makeLibrary();
    const libraryApi = {
        status: () => library.status(), scan: () => library.scan(), pause: () => library.pause(), resume: () => library.resume(),
        maps: () => library.maps(), text: (id) => library.text(id),
    };
    const copies = [];
    const marathons = [];
    const handlers = createSessionHandlers({
        library: libraryApi,
        profile: { current: () => ({ ok: false }) },
        played: async () => ({ known: true, beatmaps: new Map(), hashes: await interlude.library.played() }),
        analyze,
        // the rate tab's copy writes next to the map: here the fixture's map, with a made-up chart
        makeRateCopy: async ({ beatmapPath, rate }) => {
            const osuPath = beatmapPath.replace(/\.osu$/, ` ${rate}x.osu`);
            await writeFile(osuPath, `osu file format v14\r\n// smoke rate copy of ${path.basename(beatmapPath)} at ${rate}\r\n`, "utf8");
            copies.push(osuPath);
            return { osuPath };
        },
        copyOut: (hash) => interlude.copyOut(hash),
        makeMarathon: async ({ entries, title }) => {
            const file = path.join(docsDir, "карты", `${title}.osz`);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, "smoke");
            marathons.push({ entries, title });
            return { file, totalMs: entries.length * 120_000 };
        },
        saved: createJsonStore({ file: path.join(userData, "sessions.json"), normalize: normalizeSaved, fallback: [] }),
        docsDir: () => docsDir,
        log: (l) => console.log("log", l),
        progress: (e) => send("session-progress", e),
    });
    ipcMain.handle("session-library-status", () => handlers.libraryStatus());
    ipcMain.handle("session-library-scan", () => handlers.scan());
    ipcMain.handle("session-library-pause", () => handlers.pause());
    ipcMain.handle("session-library-resume", () => handlers.resume());
    ipcMain.handle("session-library-pick", () => ({ ok: false, cancelled: true }));
    ipcMain.handle("session-build", (_e, req) => handlers.build(req));
    ipcMain.handle("session-reroll", (_e, req) => handlers.reroll(req));
    ipcMain.handle("session-save", (_e, req) => handlers.save(req));
    ipcMain.handle("session-list", () => handlers.list());
    ipcMain.handle("session-open", (_e, req) => handlers.open(req));
    ipcMain.handle("session-remove", (_e, req) => handlers.remove(req));
    ipcMain.handle("session-export-collection", (_e, req) => handlers.exportCollection(req));
    ipcMain.handle("session-export-marathon", (_e, req) => handlers.exportMarathon(req));
    ipcMain.handle("session-copy", (_e, req) => { clipboard.writeText(String(req?.text ?? "")); return { ok: true }; });
    ipcMain.handle("interlude-status", () => interludeHandlers.status());
    ipcMain.handle("interlude-export", (_e, req) => interludeHandlers.exportList(req));
    ipcMain.handle("profile-get", () => ({ ok: false }));
    ipcMain.handle("profile-ensure", () => ({ ok: false, reason: "none" }));
    ipcMain.handle("rec-fav-list", () => ({ ok: true, items: [] }));
    ipcMain.handle("open-map", () => "");
    ipcMain.on("show-map", () => {});

    const win = new BrowserWindow({ width: 460, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    send = (channel, payload) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); };
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.log("console", level, msg); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(300);
        writeFileSync(path.join(outDir, shotName(name)), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 200) {
            if (await js(code)) return true;
            await sleep(200);
        }
        return false;
    };
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click(); true`);
    const scrollTo = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" }); true`);
    const sideways = () => js(`document.documentElement.scrollWidth - innerWidth`);
    const chip = (box, label) => js(`(() => { const c = [...document.querySelectorAll("#${box} > span")].find((s) => s.textContent.replace(/^\\d+\\. /, "").trim() === ${JSON.stringify(label)}); c?.click(); return Boolean(c); })()`);

    // a hand-set profile saved by the picks tab, the session page open
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`localStorage.clear(); localStorage.setItem("rec-settings", ${JSON.stringify(JSON.stringify({ source: "manual", manualProfile: MINE }))});
        localStorage.setItem("rec-view", ${JSON.stringify(JSON.stringify({ mode: "session" }))}); true`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`document.querySelector('[data-tab=recommend]').click(); true`);
    check(await waitFor(`!document.getElementById("rec-session-pane").hidden`, 3000), "the session page is shown");
    const modes = await js(`[...document.getElementById("rec-mode").children].map((c) => c.textContent)`);
    check(modes.at(-1) === t("recommend.mode.session"), `a «${t("recommend.mode.session")}» mode beside the others (${modes.join(" / ")})`);

    // ---- the library: scanned and analysed in the background ----
    const started = Date.now();
    await sleep(400);
    await shot("1-scanning.png");
    check(await waitFor(`document.getElementById("ses-lib-phase").textContent === ${JSON.stringify(t("session.lib.done"))}`, 60000), "the library is analysed");
    const scanMs = Date.now() - started;
    const st = await library.status();
    console.log("library:", await text("ses-lib-status"), "|", JSON.stringify(st.counts), `| ${scanMs} ms, ${analysed} analyses`);
    // 41 jumpstream + 19 jack + 6 stream in Songs (one also in Interlude) + 2 Interlude-only
    check(st.counts.total === TOTAL && st.counts.both === 1 && st.counts.interlude === 2, `${TOTAL} maps: ${TOTAL - 2} in Songs (1 also in Interlude), 2 only in Interlude (${JSON.stringify(st.counts)})`);
    check(st.counts.analysed === TOTAL && st.counts.pending === 0, "every map analysed");
    check((await text("ses-lib-notes")).includes(t("session.lib.lazer").slice(0, 30)), "the page says lazer's library can't be read");
    check((await sideways()) <= 0, "the page fits the window");
    await shot("2-library.png");

    // ---- a 30-minute growth session on jumpstream ----
    check(await chip("ses-patterns", t("recommend.pattern.jumpstream")), "jumpstream chip");
    await click("ses-go");
    check(await waitFor(`!document.getElementById("ses-head").hidden || document.getElementById("ses-status").textContent.length > 0 && document.getElementById("ses-status").textContent !== ${JSON.stringify(t("session.building"))}`), "the session answered");
    const head = await text("ses-head");
    const rows = await js(`[...document.querySelectorAll("#ses-list .ses-item")].map((r) => r.innerText.replace(/\\n/g, " "))`);
    console.log("head:", head, "| status:", await text("ses-status"));
    for (const r of rows) console.log("  ", r);
    const parts = await js(`[...document.querySelectorAll("#ses-list .ses-part")].map((p) => p.textContent)`);
    const partNames = ["warmup", "main", "push", "cooldown"].map((p) => t(`session.part.${p}`));
    check(partNames.every((p) => parts.includes(p)), `warm-up, main, push and cool-down (${[...new Set(parts)].join(", ")})`);
    check(parts.join("|") === [...parts].sort((a, b) => partNames.indexOf(a) - partNames.indexOf(b)).join("|"), "in that order");
    check(head.includes("11.60 → 11.60–12.10"), "the target: Stamina 11.60, growth 11.60–12.10");
    const current = handlers.current();
    const total = current.session.items.reduce((s, x) => s + x.durationSec, 0);
    check(total > 30 * 60 * 0.8 && total < 30 * 60 * 1.2, `about 30 minutes (${Math.round(total)} s)`);
    check(new Set(current.session.items.map((x) => x.mapId)).size === current.session.items.length, "no map twice");
    check((await sideways()) <= 0, "the session fits the window");
    await scrollTo("#ses-go");
    await shot("3-session.png");

    // ---- ↻ one item, then the whole session ----
    const before = current.session.items.map((x) => x.mapId);
    const mainAt = current.session.items.findIndex((x) => x.part === "main");
    await js(`document.querySelectorAll("#ses-list .ses-reroll")[${mainAt}].click(); true`);
    check(await waitFor(`!document.getElementById("ses-go").disabled`), "↻ answered");
    const afterOne = handlers.current().session.items.map((x) => x.mapId);
    console.log("reroll at", mainAt, "changed:", afterOne.map((id, i) => (id !== before[i] ? i : null)).filter((i) => i !== null).join(","), "|", await text("ses-status"));
    check(afterOne[mainAt] !== before[mainAt] && afterOne.filter((id, i) => id !== before[i]).length === 1, "↻ changed that one map only");
    // ---- the Interlude playlist of this session (its own charts and the Songs map it has too) ----
    await js(`(() => { const n = document.getElementById("ses-name"); n.value = "Smoke session"; n.dispatchEvent(new Event("input")); return true; })()`);
    await js(`document.querySelector("#ses-interlude button").click(); true`);
    check(await waitFor(`/\\S/.test(document.querySelector("#ses-interlude .il-answer").textContent) && document.querySelector("#ses-interlude .il-answer").textContent !== ${JSON.stringify(t("interlude.working"))}`), "Interlude playlist answered");
    console.log("interlude:", await js(`document.querySelector("#ses-interlude .il-answer").textContent`));
    const cols = JSON.parse(readFileSync(path.join(fx.root, "Data", "collections.json"), "utf8"));
    const playlist = cols.Playlists["Smoke session"];
    const inIl = handlers.current().session.items.filter((x) => x.sources.interlude);
    check(Boolean(playlist) && playlist.Charts.length === inIl.length, `Interlude playlist with the ${inIl.length} maps it has`);
    check(!playlist || playlist.Charts.every(([, opt], i) => Math.abs(opt.Rate - inIl[i].rate) < 1e-9), "the playlist keeps each map's rate");
    await click("ses-reroll-all");
    check(await waitFor(`!document.getElementById("ses-go").disabled && !document.getElementById("ses-head").hidden`), "↻ whole session answered");

    // ---- with rates: a challenge session the library only reaches sped up ----
    await click("ses-rates");
    check(await chip("ses-goals", t("recommend.goal.challenge")), "challenge chip");
    await click("ses-go");
    check(await waitFor(`!document.getElementById("ses-go").disabled && !document.getElementById("ses-head").hidden`, 60000), "a session with rates answered");
    const rated = handlers.current().session.items.filter((x) => x.rate !== 1);
    console.log("rated:", rated.map((x) => `${x.title} ×${x.rate} ${x.baseDan}→${x.dan}${x.estimated ? "≈" : ""}`).join(" | "));
    for (const r of await js(`[...document.querySelectorAll("#ses-list .ses-item")].map((r) => r.innerText.replace(/\\n/g, " "))`)) console.log("  ", r);
    console.log("   patterns:", handlers.current().session.items.map((x) => x.patternId).join(" "));
    check(rated.length > 0, `some maps at a rate (${rated.length})`);
    check(rated.every((x) => !x.estimated), "every rate checked by the analysis");
    check((await text("ses-list")).includes("×1."), "rates on the list");
    await scrollTo("#ses-head");
    await shot("4-rates.png");

    // ---- save, open, copy (the name typed above stays) ----
    await click("ses-save");
    check(await waitFor(`!document.getElementById("ses-saved-box").hidden && document.getElementById("ses-saved").innerText.includes("Smoke session")`), "saved, and in the saved list");
    clipboard.clear();
    win.focus();
    await click("ses-copy");
    await sleep(400);
    const copied = clipboard.readText();
    console.log("copied:", copied.split("\n").slice(0, 3).join(" | "));
    check(copied.startsWith("Smoke session") && copied.includes(`[${t("session.part.warmup")}]`), "copy list puts the session on the clipboard");

    // ---- export: osu! collection, marathon ----
    await click("ses-collection");
    check(await waitFor(`!document.getElementById("ses-result").hidden`), "collection answered");
    const colText = await text("ses-result");
    console.log("collection:", colText.replace(/\n/g, " | "));
    const dbFile = path.join(docsDir, "коллекции", "collection.db");
    const db = existsSync(dbFile) ? decodeCollectionDb(readFileSync(dbFile)) : { collections: [] };
    const col = db.collections.find((c) => c.name === "Smoke session");
    const stableItems = handlers.current().session.items.filter((x) => x.sources.stable);
    check(Boolean(col) && col.hashes.length === new Set(stableItems.map((x) => x.mapId)).size, `collection «Smoke session» with ${col?.hashes.length} maps`);
    check(copies.length === stableItems.filter((x) => x.rate !== 1).length, `a rate copy for each map at a rate (${copies.length})`);
    check(copies.every((c) => c.startsWith(songs)), "rate copies only inside the fixture Songs folder");
    await click("ses-marathon");
    check(await waitFor(`document.getElementById("ses-result").innerText.includes(${JSON.stringify(t("session.marathonDone", { time: "" }).split("(")[0].trim())})`), "marathon answered");
    check(marathons.length === 1 && marathons[0].entries.length === handlers.current().session.items.length, "the marathon takes every map");
    check(marathons[0]?.entries.every((e) => existsSync(e.path)), "every marathon map is a file (Interlude charts copied out)");
    await scrollTo("#ses-actions");
    await shot("5-exports.png");

    // ---- nothing near: tech, which none of these charts is ----
    await js(`localStorage.setItem("rec-session", JSON.stringify({ ...JSON.parse(localStorage.getItem("rec-session")), patternIds: ["tech"], allowRates: false })); true`);
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js(`document.querySelector('[data-tab=recommend]').click(); true`);
    await sleep(500);
    await click("ses-go");
    check(await waitFor(`document.getElementById("ses-status").textContent.includes(${JSON.stringify(t("session.err.tryPicks").slice(0, 12))})`), "nothing near: says so and points to Picks");
    console.log("nothing near:", await text("ses-status"));
    check(await waitFor(`document.getElementById("ses-saved").innerText.includes("Smoke session")`, 3000), "the saved session is still listed after a reload");
    await scrollTo("#ses-go");
    await shot("6-nothing-near.png");

    // ---- the next scan reads nothing that did not change ----
    library = makeLibrary();
    const before2 = analysed;
    const again = Date.now();
    await library.scan();
    const st2 = await library.status();
    console.log(`rescan: ${Date.now() - again} ms, ${st2.lastScan.read} .osu read, ${analysed - before2} analyses`);
    check(st2.lastScan.read === 0, `rescan reads nothing (${st2.lastScan.read}; the page's own rescan after the export read the ${copies.length} rate copies and left them out)`);
    check(analysed === before2, "rescan analyses nothing");
    check(st2.counts.total === TOTAL, "rate copies are not added to the library");

    if (lang === "en") {
        const cyr = await js(`(document.getElementById("rec-session-pane").innerText.match(/[А-Яа-яЁё][^\\n]{0,40}/g) || []).join(" ‖ ")`);
        check(!cyr, `no Russian on the session page in English (${cyr || "none"})`);
    }
    console.log(`scan of the fixture: ${scanMs} ms for ${TOTAL - 1} sets / ${st.counts.total} maps (${analysed} analyses in all)`);
    check(blocked.length === 0, `no network from the window (${blocked.join(", ") || "none"})`);
    rmSync(songs, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error("smoke failed:", error?.stack ?? error);
    app.exit(1);
});
