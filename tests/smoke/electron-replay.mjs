// Run with: npx electron tests/smoke/electron-replay.mjs <out-dir> [lang=en]   (SMOKE_LANG=en works too)
// The Replay tab through the real window, fully offline, over a fixture osu! folder made here only (a made-up player,
// TestPlayer; <out-dir>/osu with Songs, Replays, Data\r, Skins and osu!.TestPlayer.cfg, <out-dir>/user-data): the tab bar
// with eight tabs; the recent list; an honest replay and a roll played as jumps opened from it (manip ≈ 0 / ≈ 100 % on
// screen); the judgement table against the replay's own counts; the skin set in osu! drawn (a pixel check on the stage, and
// another skin / the plain field from the select); the song decoded and playing (the clock moves, seek, speed, pause);
// presses and manip lines drawn; a play ending in osu! (the replay appears in Data\r, the tab opens it by itself, without
// a call on the window's focus, and a play with no replay says why); the statistics' folds on a mixed map (fingers picked and
// remembered, hands, holds, jacks, ghost presses, combo breaks, earlier plays; a section with no data is not there); a replay
// whose map is missing; the profile's plays saying what needs a replay; 440 px with no sideways scroll, then narrower; every
// file under the osu! folder unchanged. Screenshots go to <out-dir>. Exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createReplayService } from "../../app/replayIpc.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { buildSkin, skinIniText } from "../../src/skin/build.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeOsr, honestPresses, gluedPresses, chartText, rollNotes, noise } from "../fixtures/makeOsr.js";
import { readOsr, unpackFrames, keyPresses } from "../../src/replay/osr.js";
import { analyzeReplay } from "../../src/replay/analyze.js";
import { MOD_BITS } from "../../src/localProfile/scoresDb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-replay.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "replay-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
mkdirSync(outDir, { recursive: true });
for (const dir of ["user-data", "osu"]) rmSync(path.join(outDir, dir), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "user-data"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};
const md5 = (x) => createHash("md5").update(x).digest("hex");

// ---- a WAV of a soft click track, long enough for the map ----
function wav(seconds, rate = 22050) {
    const n = Math.floor(seconds * rate);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) {
        const beat = i % Math.floor(rate / 2);
        const v = beat < 800 ? Math.sin(i / 3) * (1 - beat / 800) * 9000 : 0;
        data.writeInt16LE(Math.round(v), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
}

// ---- the osu! folder ----
const game = path.join(outDir, "osu");
const notes = rollNotes({ count: 1200, stepMs: 45, startMs: 1500 });
const text = chartText(notes, { title: "Fixture Roll", artist: "Test", version: "Rolls" });
const hash = md5(text);
const put = (rel, data) => {
    const file = path.join(game, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
};
put("Songs/1 Test - Fixture Roll/Test - Fixture Roll (TestPlayer) [Rolls].osu", text);
put("Songs/1 Test - Fixture Roll/audio.wav", wav(60));
const headerFor = (presses) => {
    const bytes = makeOsr({ md5: hash, presses });
    const h = readOsr(bytes);
    const frames = unpackFrames(h.packed);
    return analyzeReplay({ header: { ...h, total: 0 }, notes, keys: 4, od: 8, frames, columns: keyPresses(frames) });
};
const honestPlay = honestPresses(notes, { sdMs: 10, seed: 7 });
const gluedPlay = gluedPresses(notes);
const honestA = headerFor(honestPlay);
const gluedA = headerFor(gluedPlay);
const honestFile = put("Replays/honest.osr", makeOsr({ md5: hash, presses: honestPlay, counts: honestA.counts, maxCombo: honestA.combo.max, at: Date.UTC(2026, 9, 2, 12) }));
const gluedFile = put("Data/r/glued.osr", makeOsr({ md5: hash, presses: gluedPlay, counts: { ...gluedA.counts, max: gluedA.counts.max + 1, n300: gluedA.counts.n300 - 1 }, maxCombo: gluedA.combo.max, at: Date.UTC(2026, 9, 3, 12) }));
const lostFile = put("Replays/lost.osr", makeOsr({ md5: "e".repeat(32), presses: honestPlay.slice(0, 20), counts: { max: 15, n300: 5 }, maxCombo: 20, at: Date.UTC(2026, 9, 1, 12) }));
const randomFile = put("Replays/random.osr", makeOsr({ md5: hash, presses: honestPlay, counts: honestA.counts, maxCombo: honestA.combo.max, mods: MOD_BITS.RD, at: Date.UTC(2026, 9, 1, 13) }));
const built = buildSkin({ shape: "bar", palette: "sunset", name: "Fixture Bars", author: "TestPlayer", judgements: "words", font: "pixel" }, { dir: "art" });
for (const f of built.files) put(`Skins/Fixture Bars/${f.name}`, f.data);
put("Skins/Fixture Bars/skin.ini", `${skinIniText(built)}\r\n// 7K, left alone\r\n[Mania]\r\nKeys: 7\r\nColumnWidth: 30\r\n`);
const circle = buildSkin({ shape: "circle", palette: "ice", name: "Fixture Circles", author: "TestPlayer", judgements: "numbers", font: "round" }, { dir: "art" });
for (const f of circle.files) put(`Skins/Fixture Circles/${f.name}`, f.data);
put("Skins/Fixture Circles/skin.ini", skinIniText(circle).replace(/^Keys: 4/m, "Keys: 4\r\nUpsideDown: 1")); // upscroll, as a player's own skin can be
put("osu!.TestPlayer.cfg", "BeatmapDirectory = Songs\r\nSkin = Fixture Bars\r\n");

function snapshot(dir, sub = "", out = {}) {
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
        const rel = path.join(sub, e.name);
        if (e.isDirectory()) snapshot(dir, rel, out);
        else out[rel] = `${statSync(path.join(dir, rel)).mtimeMs}:${md5(readFileSync(path.join(dir, rel)))}`;
    }
    return out;
}
let before = snapshot(game);

// ---- a mixed map, for what a roll does not have: jacks, holds, chords, a stretch played badly ----
function mixedMap() {
    const out = [];
    let t = 2000;
    for (let i = 0; i < 180; i += 1, t += 110) out.push({ t, col: i % 4, end: null }); // a roll
    for (let i = 0; i < 40; i += 1, t += 120) out.push({ t, col: i % 8 < 4 ? 1 : 2, end: null }); // jacks
    for (let i = 0; i < 24; i += 1, t += 500) out.push({ t, col: i % 4, end: t + 380 }, { t, col: (i + 2) % 4, end: null }); // holds with a note
    for (let i = 0; i < 200; i += 1, t += 70) out.push({ t, col: [0, 2, 1, 3][i % 4], end: null }); // a fast stream
    return out;
}
const mixed = mixedMap();
const mixedText = chartText(mixed, { title: "Fixture Mix", artist: "Test", version: "Mixed" });
const mixedHash = md5(mixedText);
put("Songs/2 Test - Fixture Mix/Test - Fixture Mix (TestPlayer) [Mixed].osu", mixedText);
put("Songs/2 Test - Fixture Mix/audio.wav", wav(70));
// the player slides later as the map goes on, lets the holds go late, loses the fast stream's end, taps between the notes
function mixedPlay({ seed = 11, sd = 9, dropFrom = 400, ghosts = 14 } = {}) {
    const gauss = noise(seed);
    const last = mixed.at(-1).t;
    const out = [];
    mixed.forEach((n, i) => {
        if (i >= dropFrom && i % 3 === 0) return;
        const t = Math.round(n.t + gauss(sd) + (n.t / last) * 8);
        out.push({ t, col: n.col, up: n.end === null ? t + 30 : n.end + (i % 3 === 0 ? 70 : 4) });
    });
    for (let i = 0; i < ghosts; i += 1) out.push({ t: 2055 + i * 3300, col: i % 4, up: 2085 + i * 3300 });
    return out.sort((a, b) => a.t - b.t);
}
const replayOf = (presses, hash, list) => {
    const bytes = makeOsr({ md5: hash, presses });
    const h = readOsr(bytes);
    const frames = unpackFrames(h.packed);
    return analyzeReplay({ header: { ...h, total: 0 }, notes: list, keys: 4, od: 8, frames, columns: keyPresses(frames) });
};
const earlierMix = mixedPlay({ seed: 3, sd: 16, dropFrom: 330 });
const earlierA = replayOf(earlierMix, mixedHash, mixed);
put(`Data/r/${mixedHash}-1000.osr`, makeOsr({ md5: mixedHash, presses: earlierMix, counts: earlierA.counts, maxCombo: earlierA.combo.max, at: Date.UTC(2026, 8, 20, 18) }));
before = snapshot(game);

app.whenReady().then(async () => {
    const blocked = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const offline = /^(file|devtools|data|blob|chrome|about):/i.test(details.url);
        if (!offline) blocked.push(details.url);
        callback({ cancel: !offline });
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.on("tab", () => {});
    let win = null;
    const worker = {
        details: async () => ({ kind: "details", details: { v: 2, durationSec: 55, strain: [], families: new Array(120).fill("stream"), flavourBins: [] } }),
        sections: async () => ({ kind: "sections", sections: { v: 1, parts: [{ dan: 12.4 }, { dan: 13.1 }, { dan: null }, { dan: 11.8 }, { dan: 13.4 }], top: 1 } }),
    };
    const service = createReplayService({
        userData: path.join(outDir, "user-data"), env: {}, log: (l) => console.log("log", l),
        songsIndex: createSongsMd5Index({ indexFile: path.join(outDir, "user-data", "songs.json") }),
        tosu: async () => ({ game, songs: null, skin: null }), send: (channel, payload) => win?.webContents.send(channel, payload),
        analysis: { enqueue: (fn) => fn() }, worker, cache: { get: async () => null, set: async () => {} },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    });
    const channels = {
        "replay-status": "status", "replay-list": "list", "replay-open": "open", "replay-audio": "audio", "replay-skin": "skin", "replay-details": "details",
        "replay-earlier": "earlier", "replay-after-play": "setAfterPlay",
    };
    for (const [channel, method] of Object.entries(channels)) ipcMain.handle(channel, (_e, req) => service[method](req));
    const history = {
        ok: true, plays: [
            { id: "1", md5: hash, artist: "Test", title: "Fixture Roll", version: "Rolls", rate: 1, accuracy: 96.5, at: Date.UTC(2026, 9, 2, 12), outcome: "pass" },
            { id: "2", md5: "d".repeat(32), artist: "Test", title: "No Replay Song", version: "Hard", rate: 1.2, accuracy: 91.2, at: Date.UTC(2026, 8, 30, 12), outcome: "pass" },
        ],
    };
    ipcMain.handle("local-profile-history", () => history);
    // every other channel the preload invokes answers "nothing here", so the other tabs start quietly
    const preload = readFileSync(path.join(appDir, "preload.cjs"), "utf8");
    for (const m of preload.matchAll(/ipcRenderer\.invoke\("([\w-]+)"/g)) {
        if (!channels[m[1]] && m[1] !== "local-profile-history") ipcMain.handle(m[1], () => ({ ok: false, message: "smoke" }));
    }
    for (const m of preload.matchAll(/ipcRenderer\.send\("([\w-]+)"/g)) if (!["tab"].includes(m[1])) ipcMain.on(m[1], () => {});

    win = new BrowserWindow({ width: 440, height: 860, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    // what would take the focus from the game: none of it may be called
    const calledOnWindow = [];
    for (const method of ["show", "focus", "moveTop", "restore", "flashFrame", "setAlwaysOnTop"]) {
        const original = win[method].bind(win);
        win[method] = (...a) => {
            calledOnWindow.push(method);
            return original(...a);
        };
    }
    const errors = [];
    win.webContents.on("console-message", (_e, level, msg) => {
        if (level >= 2) console.log("console", level, msg);
        if (level >= 3) errors.push(msg);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(250);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 150) {
            if (await js(code)) return true;
            await sleep(150);
        }
        return false;
    };
    const text2 = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const sideways = () => js(`Math.max(document.documentElement.scrollWidth - innerWidth, (() => { const s = document.getElementById("replay-tab"); return s.scrollWidth - s.clientWidth; })())`);
    const scrollToEnd = (top) => js(`document.getElementById("replay-tab").scrollTop = ${top}; true`);
    const sec = (id) => `document.querySelector("[data-sec=${id}]")`;
    const secText = (id) => js(`${sec(id)}?.textContent ?? ""`);
    const openFolds = () => js(`document.querySelectorAll("#rp-details details").forEach((d) => { d.open = true; }); true`);
    const scrollToSec = (id) => js(`${sec(id)}.scrollIntoView({ block: "start" }); true`);
    const openRow = (file) => js(`(() => { const r = [...document.querySelectorAll("#rp-list .rp-row")].find((b) => b.dataset.file === ${JSON.stringify(file)}); r?.click(); return Boolean(r); })()`);
    const seekValue = async () => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        return js(`Number(document.querySelector(".rp-seek").value)`);
    };
    // how many stage pixels are of a colour family: a cheap way to tell skins and marks apart on the canvas
    const stagePixels = () => js(`(() => {
        const c = document.getElementById("rp-stage"); const g = c.getContext("2d");
        const { data } = g.getImageData(0, 0, c.width, c.height); let lit = 0; let pink = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 120) lit += 1;
            if (Math.abs(data[i] - 255) < 8 && Math.abs(data[i + 1] - 154) < 12 && Math.abs(data[i + 2] - 213) < 12) pink += 1;
        }
        return { lit, pink, width: c.width, height: c.height, sum: c.toDataURL().length };
    })()`);

    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js("localStorage.clear(); true");
    await win.loadFile(path.join(appDir, "renderer", "index.html"));

    // ---- the tab bar ----
    const bar = await js(`(() => { const n = document.querySelector(".tabs"); return { over: n.scrollWidth - n.clientWidth, labels: [...n.children].map((b) => b.textContent) }; })()`);
    console.log("tabs:", JSON.stringify(bar));
    check(bar.labels.includes(t("replay.html.tab")) && bar.labels.length === 9, `the tab «${t("replay.html.tab")}» in a bar of eight + ⚙`);
    check(bar.over <= 0, `the tab bar fits at 440 px (overflow ${bar.over})`);

    await js(`document.querySelector("[data-tab=replay]").click(); true`);
    check(await waitFor(`document.querySelectorAll("#rp-list .rp-row").length >= 3`), "the recent replays are listed");
    check(await waitFor(`document.getElementById("rp-list").innerText.includes("Fixture Roll")`), "the list names the maps from Songs");
    const list = await text2("rp-list");
    check(!list.includes("standard") && (list.match(/Fixture Roll/g) ?? []).length === 3, "one row per mania replay");
    check((await text2("rp-folder")).includes(game), "the folder is shown");
    await shot(`replay-list-${lang}.png`);

    // ---- the honest replay ----
    check(await openRow(honestFile), "the honest replay is on the list");
    check(await waitFor(`!document.getElementById("rp-session").hidden && document.querySelector(".rp-manip-num")`), "a replay opens");
    await sleep(300);
    const manip = await js(`document.querySelector(".rp-manip-num").textContent`);
    console.log("manip:", manip);
    check(Number.parseFloat(manip) <= 2, `honest play shows about 0 % (${manip})`);
    check((await text2("rp-who")).includes(lang === "en" ? "Oct" : "окт"), "the date is in the app's language");
    check(await waitFor(`document.getElementById("rp-skin").options.length >= 3`), "the skins are offered");
    check((await js(`document.getElementById("rp-skin").value`)) === "Fixture Bars", "the skin set in osu! is chosen");
    await sleep(400);
    const bars = await stagePixels();
    console.log("stage:", JSON.stringify(bars));
    check(bars.lit > 500, "the stage is drawn");
    await shot(`replay-honest-${lang}.png`);

    // judgements agree with the header
    check((await text2("rp-details")).includes(t("replay.judge.same")), "the recount matches the replay's counts");
    check(await waitFor(`${sec("families")}?.textContent.includes(${JSON.stringify(t("replay.family.stream"))})`), "pattern families arrive from the details");
    check(await waitFor(`!${sec("parts")}?.textContent.includes("…")`), "dans arrive on the parts");
    check((await js(`${sec("ghosts")} === null && ${sec("holds")} === null && ${sec("earlier")} === null`)), "no holds, no ghosts, no earlier plays: those sections are not there");

    // the song plays: the clock moves, speed, seek, pause
    await js(`(async () => { const b = document.querySelector(".rp-play"); b.click(); return true; })()`);
    check(await waitFor(`document.querySelector(".rp-play").textContent === ${JSON.stringify(t("replay.play.pause"))}`, 3000), "play starts");
    const time1 = await seekValue();
    await sleep(900);
    const time2 = await seekValue();
    console.log("clock:", time1, time2);
    check(time2 > time1 + 300, `the clock runs while playing (${time1} → ${time2})`);
    await js(`[...document.querySelectorAll(".rp-speed span")].find((s) => s.textContent === "×1.5").click(); true`);
    const time3 = await seekValue();
    await sleep(700);
    const time4 = await seekValue();
    console.log("speed:", time3, time4);
    check(time4 - time3 > 800, `×1.5 runs faster (${time4 - time3} ms in 0.7 s)`);
    await js(`[...document.querySelectorAll(".rp-speed span")].find((s) => s.textContent === "×1").click(); document.querySelector(".rp-play").click(); true`);
    await sleep(200);
    await js(`(() => { const s = document.querySelector(".rp-seek"); s.value = 20000; s.dispatchEvent(new Event("input")); return true; })()`);
    await sleep(250);
    check(Math.abs((await js(`Number(document.querySelector(".rp-seek").value)`)) - 20000) < 20, "seek moves the clock");
    await seekValue();
    check((await text2("rp-controls")).includes("0:20"), "the time shows the seek");

    // another skin, the plain field
    const barsAt = await stagePixels();
    await js(`(() => { const s = document.getElementById("rp-skin"); s.value = "Fixture Circles"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(700);
    const circles = await stagePixels();
    check(circles.sum !== barsAt.sum, "another skin changes the stage");
    // that skin says UpsideDown: the button tells the truth about it and really turns the stage over
    const dirButton = `document.querySelector("#rp-controls .rp-buttons button:not(.rp-play)")`;
    check((await js(`${dirButton}.textContent`)) === t("replay.play.upscroll"), "a skin with UpsideDown starts as upscroll, and the button says so");
    await js(`${dirButton}.click(); true`);
    await sleep(200);
    check((await js(`${dirButton}.textContent`)) === t("replay.play.downscroll") && (await stagePixels()).sum !== circles.sum, "the button turns the stage over even on that skin");
    await js(`${dirButton}.click(); localStorage.removeItem("replay-up"); true`);
    await sleep(200);
    await js(`(() => { const s = document.getElementById("rp-skin"); s.value = ""; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(500);
    const plainStage = await stagePixels();
    check(plainStage.sum !== circles.sum && plainStage.lit > 200, "the plain field draws too");
    check((await text2("rp-skin-note")) === t("replay.play.plainSkin"), "and says so");
    await js(`(() => { const s = document.getElementById("rp-skin"); s.value = "Fixture Bars"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(500);

    // ---- the roll played as jumps ----
    await js(`document.getElementById("rp-close").click(); true`);
    check(await js(`!document.getElementById("rp-start").hidden`), "«other» goes back to the list");
    check(await openRow(gluedFile), "the other replay is on the list");
    await sleep(800);
    const gluedPercent = Number.parseFloat(await js(`document.querySelector(".rp-manip-num").textContent`));
    check(gluedPercent >= 95, `a roll played as jumps shows about 100 % (${gluedPercent} %)`);
    const stripBars = await js(`document.querySelectorAll(".rp-manip-bar").length`);
    check(stripBars >= 30, `the timeline shows where (${stripBars} bars)`);
    await js(`(() => { const s = document.querySelector(".rp-seek"); s.value = 20000; s.dispatchEvent(new Event("input")); return true; })()`);
    await sleep(300);
    const marks = await stagePixels();
    check(marks.pink > 40, `manip pairs are drawn on the stage (${marks.pink} pink px)`);
    check((await text2("rp-details")).includes(t("replay.judge.differs", { wrong: 1, total: gluedA.results.length })), "a mismatch with the header is told");
    check(await js(`${sec("hands")} !== null`) && (await secText("manip")).includes(t("replay.manip.squeezeShort")), "how much the notes were squeezed");
    await shot(`replay-glued-${lang}.png`);
    await js(`document.querySelector(".rp-how").open = true; true`);
    await scrollToEnd(560);
    await shot(`replay-manip-${lang}.png`);
    await js(`document.querySelector(".rp-how").open = false; true`);

    // ---- a play ends in osu! ----
    const startedAt = Date.now();
    const wholeTabs = () => js(`document.querySelector(".tabs button.on")?.dataset.tab`);
    await js(`document.querySelector("[data-tab=analysis]").click(); true`);
    const playOf = (over) => ({ client: "stable", md5: mixedHash, artist: "Test", title: "Fixture Mix", version: "Mixed", rate: 1, accuracy: 0.93, outcome: "pass", startedAt, at: Date.now(), ...over });
    const newPlay = mixedPlay();
    const newA = replayOf(newPlay, mixedHash, mixed);
    const waiting = service.playEnded(playOf({}));
    await sleep(3800);
    check((await wholeTabs()) === "analysis", "while osu! is writing the replay the tab stays where it was");
    check(await js(`document.getElementById("rp-ended").textContent.includes(${JSON.stringify(t("replay.ended.waiting", { map: "" }).slice(-20))})`), "with a note that it is on its way, no word of it missing");
    put(`Data/r/${mixedHash}-2000.osr`, makeOsr({ md5: mixedHash, presses: newPlay, counts: newA.counts, maxCombo: newA.combo.max, at: Date.now() }));
    await waiting;
    check(await waitFor(`document.getElementById("rp-map").textContent.includes("Fixture Mix") && !document.getElementById("replay-tab").hidden`), "when the play ends the Replay tab opens its analysis by itself");
    check((await text2("rp-ended")).includes("Fixture Mix"), "and says it is the play just ended");
    check(calledOnWindow.length === 0 && !win.isVisible(), `nothing asks for the window's focus (${calledOnWindow.join(", ") || "no calls"})`);
    check(await waitFor(`${sec("earlier")}?.textContent.includes(${JSON.stringify(t("replay.earlier.now"))})`), "the earlier play of the map is compared");
    await sleep(300);
    await shot(`replay-ended-${lang}.png`);

    // the statistics, fold by fold
    check((await js(`${sec("fingers")}.open`)), "the fingers' section opens by default");
    const fingers = await secText("fingers");
    for (const word of [t("replay.finger.short.L3"), t("replay.finger.short.R2"), t("replay.stat.speed"), t("replay.stat.jack"), t("replay.stat.fatigue"), t("replay.stat.breaks"), t("replay.stat.ghosts")]) check(fingers.includes(word), `fingers: ${word}`);
    check((await secText("hands")).includes(t("replay.hand.left")), "hands");
    check((await secText("holds")).includes(t("replay.hold.late")), "holds with their late releases");
    check((await secText("ghosts")).includes(t("replay.html.ghosts")), "ghost presses");
    check((await secText("pace")).includes(t("replay.html.pace")), "keys against the map");
    check(await js(`${sec("breaks")}.querySelectorAll(".rp-break").length > 5`), "combo breaks, each with its place");
    check((await secText("breaks")).includes(t("replay.shape.stream")) || (await secText("breaks")).includes(t("replay.shape.roll")), "and the pattern under it");
    check((await secText("drift")).includes(t("replay.drift.start")), "timing from the start to the end");
    check((await secText("hardest")).includes(t("replay.part.byDan")) || (await secText("hardest")).includes(t("replay.part.byNps")), "the hardest sections");
    check((await js(`Object.keys(JSON.parse(localStorage.getItem("replay-sections") ?? "{}")).length`)) === 0, "nothing is remembered before a fold is touched");
    await openFolds();
    await sleep(300);
    await js(`document.querySelectorAll("canvas.rp-scatter").forEach((c) => c.repaint?.()); true`);
    for (const id of ["fingers", "hands", "manip", "errors", "drift", "pace", "holds", "ghosts", "breaks", "hardest", "parts", "families", "earlier"]) {
        if (!(await js(`Boolean(${sec(id)})`))) {
            check(false, `section ${id} is there`);
            continue;
        }
        await scrollToSec(id);
        await shot(`replay-sec-${id}-${lang}.png`);
    }
    check((await sideways()) <= 0, `no sideways scroll at 440 px (${await sideways()})`);

    // fingers: another finger is remembered, and a hand moved moves the manip pairs
    const pairsBefore = await js(`${sec("hands")}.textContent`);
    await js(`(() => { const s = document.querySelector(".rp-fingers select[data-col='2']"); s.value = "L2"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(200);
    check((await js(`JSON.parse(localStorage.getItem("replay-fingers"))[2]`)) === "L2", "the finger picked is remembered");
    check((await js(`document.querySelector(".rp-fingers select[data-col='2']").value`)) === "L2", "and stays picked");
    check((await js(`${sec("hands")}.textContent`)) !== pairsBefore, "the hands follow it");
    await js(`(() => { const s = document.querySelector(".rp-fingers select[data-col='2']"); s.value = "R2"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(200);
    await js(`${sec("pace")}.open = false; true`);
    await sleep(100);
    check((await js(`JSON.parse(localStorage.getItem("replay-sections")).pace`)) === false, "a fold shut stays shut");
    win.setSize(320, 860);
    await sleep(300);
    const widths = await js(`(() => { const n = document.querySelector(".tabs"); const s = document.getElementById("replay-tab"); return { doc: document.documentElement.scrollWidth - innerWidth, tab: s.scrollWidth - s.clientWidth, bar: n.scrollWidth - n.clientWidth }; })()`);
    check((await sideways()) <= 0, `no sideways scroll at 320 px (${JSON.stringify(widths)})`);
    await scrollToEnd(0);
    await shot(`replay-320-${lang}.png`);
    await scrollToSec("fingers");
    await shot(`replay-320-fingers-${lang}.png`);
    win.setSize(440, 860);
    await sleep(200);

    // a play with no replay: the note, and a retry does not move the tab
    await js(`document.querySelector("[data-tab=analysis]").click(); true`);
    await service.playEnded(playOf({ outcome: "quit", md5: "c".repeat(32), startedAt: Date.now(), title: "Another Song" }));
    await sleep(200);
    check((await wholeTabs()) === "analysis", "a quit leaves the tab where it is");
    check((await text2("rp-ended")).includes("Another Song") || (await js(`document.getElementById("rp-ended").textContent.includes("Another Song")`)), "with a note waiting");
    await service.playEnded(playOf({ outcome: "fail", md5: "c".repeat(32), startedAt: Date.now(), title: "Another Song" }));
    check(await waitFor(`!document.getElementById("replay-tab").hidden`), "a failed play opens the tab");
    check((await text2("rp-ended")).includes(t("replay.ended.fail", { map: "x", acc: "1" }).slice(-30)), "and says why there is no analysis");
    await scrollToEnd(0);
    await shot(`replay-noreplay-${lang}.png`);
    check(calledOnWindow.length === 0, "still no call on the window's focus");

    // ---- a replay without its map ----
    await js(`document.getElementById("rp-close").click(); true`);
    check(await openRow(lostFile), "the replay without a map is on the list");
    await sleep(600);
    check((await text2("rp-reason")).includes(t("replay.reason.nomap").slice(0, 20)), "a missing map is said plainly");
    check(await js(`document.getElementById("rp-play").hidden`), "with no playfield");
    check((await text2("rp-stats")).includes("100"), "and what the replay itself holds");
    await shot(`replay-nomap-${lang}.png`);
    await js(`document.getElementById("rp-close").click(); true`);

    // ---- a Random replay: only what the replay itself says, no stage of made-up zeros ----
    check(await openRow(randomFile), "the Random replay is on the list");
    check(await waitFor(`document.getElementById("rp-reason").textContent.includes(${JSON.stringify(t("replay.reason.random").slice(0, 20))})`), "Random is said plainly");
    check(await js(`document.getElementById("rp-play").hidden`), "with no playfield over the unshuffled map");
    await shot(`replay-random-${lang}.png`);
    await js(`document.getElementById("rp-close").click(); true`);

    // ---- the profile's plays ----
    await js(`document.querySelectorAll("#rp-source span")[1].click(); true`);
    check(await waitFor(`document.querySelectorAll(".rp-game-row").length === 2`), "the profile's plays are listed");
    const game2 = await text2("rp-game");
    check(game2.includes(t("replay.game.intro").slice(0, 30)), "they say that key data is not there");
    check(game2.includes(t("replay.game.needsList").slice(0, 20)), "and what needs a replay");
    check(await js(`document.querySelectorAll(".rp-game-row button").length === 1`), "a play with a replay can open it");
    await shot(`replay-gameplay-${lang}.png`);
    await js(`document.querySelector(".rp-game-row button").click(); true`);
    check(await waitFor(`!document.getElementById("rp-session").hidden`), "and it opens");

    // the tab pauses when left
    await sleep(400);
    await js(`document.querySelector(".rp-play").click(); true`);
    await sleep(200);
    await js(`document.querySelector("[data-tab=analysis]").click(); true`);
    await sleep(200);
    await js(`document.querySelector("[data-tab=replay]").click(); true`);
    await sleep(200);
    check((await js(`document.querySelector(".rp-play").textContent`)) === t("replay.play.play"), "another tab pauses the playback");

    check(!errors.length, `no console errors (${errors.slice(0, 2).join(" | ")})`);
    check(!blocked.length, `nothing went online (${blocked.slice(0, 2).join(" ")})`);
    rmSync(path.join(game, "Data", "r", `${mixedHash}-2000.osr`), { force: true }); // this one played osu!'s part
    const after = snapshot(game);
    check(JSON.stringify(after) === JSON.stringify(before), "the osu! folder is unchanged");
    console.log(failed ? "SMOKE FAILED" : "SMOKE PASSED");
    app.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
