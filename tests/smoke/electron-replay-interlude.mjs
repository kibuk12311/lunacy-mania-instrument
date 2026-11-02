// Run with: npx electron tests/smoke/electron-replay-interlude.mjs <out-dir> [lang=en]   (SMOKE_LANG=en works too)
// Interlude's own plays in the Replay tab, through the real window, fully offline: a made-up portable Interlude folder
// (tests/fixtures/interludeFolder.js: Songs\charts.db with three synthetic 4K charts, one with holds, their audio among
// the assets; Data\scores.db with made-up replays of tests/fixtures/makeIlReplay.js; Data\options.json choosing osu! OD8;
// Rulesets\ with osu! OD8, Wife3 J4 and Quaver made the way Prelude makes them, tests/interlude/rulesets.js), linked in
// the app's settings (userData\interlude.json) the way the IL panel links one, and no osu! folder anywhere. Main's real
// replay service and Interlude client read it; the tab lists the plays, marked, with their accuracy by the ruleset chosen
// in Interlude; a play with holds opened (the head with its ruleset select, the tiles, the judgement table with the
// ruleset's names and colours, all as the engine counts them), judged again by Wife3 J4 from the select, the playback mid
// play with its panel of combo, accuracy and running counts, the earlier plays of the chart; a failed play; a mirrored one
// at ×1.1; one with Shuffle, which says why it is not analysed. Every file of the fixture folder unchanged. Screenshots
// <lang>-<what>.png go to <out-dir>. Exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createReplayService } from "../../app/replayIpc.js";
import { createInterludeClient } from "../../app/interludeClient.js";
import { createJsonStore } from "../../app/jsonStore.js";
import { playIdOf } from "../../app/replayInterlude.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeInterludeFolder } from "../fixtures/interludeFolder.js";
import { makeIlReplay, framesOfPresses } from "../fixtures/makeIlReplay.js";
import { rollNotes, chartText, honestPresses } from "../fixtures/makeOsr.js";
import { osuJson, wife3Json, quaverJson } from "../interlude/rulesets.js";
import { judgeIlReplay } from "../../src/interlude/judge.js";
import { readIlReplay, applyIlMods } from "../../src/interlude/replay.js";
import { parseRuleset, rulesetSlots } from "../../src/interlude/ruleset.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-replay-interlude.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "replay-interlude-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
const userData = path.join(outDir, `user-data-${lang}`);
mkdirSync(outDir, { recursive: true });
rmSync(userData, { recursive: true, force: true });
app.setPath("userData", userData); // never the real app's folder
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};
const md5 = (x) => createHash("md5").update(x).digest("hex");

// ---- a WAV of a soft click track, long enough for the charts ----
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

// ---- the Interlude folder: three charts, six plays, three rulesets ----
// the rulesets as Interlude ships them name their judgements
const named = (json, names) => ({ ...json, Judgements: json.Judgements.map((j, i) => ({ ...j, Name: names[i] })) });
const RULESETS = {
    "osu-od8": named(osuJson(8), ["300g", "300", "200", "100", "50", "MISS"]),
    "wife3-j4": named(wife3Json(4), ["Marvelous", "Perfect", "Great", "Good", "Bad", "Miss"]),
    quaver: named(quaverJson(), ["Marvelous", "Perfect", "Great", "Good", "Okay", "Miss"]),
};
const DAY = Date.UTC(2026, 9, 5, 12);
// a roll over the four columns with a hold every fifth note, a stretch of jumps, and a faster roll
function holdChart() {
    const out = rollNotes({ count: 160, stepMs: 150, startMs: 1500 }).map((n, i) => (i % 5 === 2 ? { ...n, end: n.t + 360 } : n));
    let t = out.at(-1).t + 300;
    for (let i = 0; i < 40; i += 1, t += 220) out.push({ t, col: i % 2 ? 1 : 0, end: null }, { t, col: i % 2 ? 3 : 2, end: null });
    for (let i = 0; i < 160; i += 1, t += 95) out.push({ t, col: [0, 2, 1, 3][i % 4], end: null });
    return out;
}
const chartA = holdChart();
const chartB = rollNotes({ count: 220, stepMs: 120, startMs: 1200 }).map((n, i) => (i % 8 === 5 ? { ...n, end: n.t + 280 } : n));
const chartC = rollNotes({ count: 200, stepMs: 110, startMs: 1000 });
const texts = {
    A: chartText(chartA, { title: "Hold Garden", artist: "Synth", version: "4K Holds" }),
    B: chartText(chartB, { title: "Mirror Lake", artist: "Synth", version: "4K Roll" }),
    C: chartText(chartC, { title: "Shuffle Street", artist: "Synth", version: "4K Easy" }),
};
const notesOf = { A: chartA, B: chartB, C: chartC };
// presses in ms of the .osu → the Replay blob, in ms of the chart from its first note
const blob = (presses, notes) => makeIlReplay(framesOfPresses(presses.map((p) => ({ ...p, t: p.t - notes[0].t, up: p.up - notes[0].t }))));
// a play that slides later over the fast roll, leaves a few notes and lets some holds go early
function playOf(notes, { seed, sd = 12, leave = 31, late = 0 }) {
    const honest = honestPresses(notes, { sdMs: sd, seed });
    const last = notes.at(-1).t;
    return honest.filter((_, i) => i % leave !== 7).map((p, i) => {
        const shift = Math.round((p.t / last) * late);
        const up = notes[i]?.end !== null && i % 3 === 0 ? p.up - 160 : p.up;
        return { ...p, t: p.t + shift, up: Math.max(p.t + shift + 20, up + shift) };
    });
}
const plays = {
    holds: { chart: "A", at: DAY + 6000, presses: playOf(chartA, { seed: 4, late: 14 }) },
    mirror: { chart: "B", at: DAY + 5000, presses: honestPresses(chartB, { sdMs: 11, seed: 5 }).map((p) => ({ ...p, col: 3 - p.col })), mods: { mirror: 0 }, rate: Math.fround(1.1) },
    failed: { chart: "A", at: DAY + 4000, presses: playOf(chartA.slice(0, 130), { seed: 6, sd: 18, leave: 9 }), failed: true },
    shuffle: { chart: "C", at: DAY + 3000, presses: honestPresses(chartC, { sdMs: 10, seed: 8 }), mods: { shuffle: 0 } },
    older: { chart: "A", at: DAY - 86_400_000, presses: playOf(chartA, { seed: 9, sd: 20 }) },
    oldest: { chart: "A", at: DAY - 3 * 86_400_000, presses: playOf(chartA, { seed: 10, sd: 25, leave: 13 }) },
};
const chartIndex = { A: 0, B: 1, C: 2 };
const fx = await makeInterludeFolder({
    charts: [
        { osuText: texts.A, title: "Hold Garden", artist: "Synth", version: "4K Holds", audio: wav(70) },
        { osuText: texts.B, title: "Mirror Lake", artist: "Synth", version: "4K Roll", audio: wav(32) },
        { osuText: texts.C, title: "Shuffle Street", artist: "Synth", version: "4K Easy", audio: wav(25) },
    ],
    plays: Object.values(plays).map((p) => ({
        index: chartIndex[p.chart], at: p.at, replay: blob(p.presses, notesOf[p.chart]), mods: p.mods ?? {}, rate: p.rate ?? 1, failed: p.failed ?? false,
    })),
    options: { SelectedRuleset: "osu-od8" }, rulesets: RULESETS,
});
const playId = (id) => playIdOf(fx.charts[chartIndex[plays[id].chart]].hash, plays[id].at);
// what Interlude's own judging makes of a play by a ruleset: the engine on the same chart and replay
function engine(id, rulesetId = "osu-od8") {
    const p = plays[id];
    const chart = applyIlMods(fx.charts[chartIndex[p.chart]].chart, p.mods ?? {});
    const ruleset = parseRuleset(RULESETS[rulesetId]);
    const judged = judgeIlReplay({ ruleset, chart, frames: readIlReplay(blob(p.presses, notesOf[p.chart])), rate: p.rate ?? 1, untilLastFrame: p.failed ?? false });
    const slots = rulesetSlots(ruleset);
    const misses = judged.counts.reduce((sum, n, j) => sum + (slots[j] === "miss" ? n : 0), 0);
    return { ...judged, ruleset, misses, percent: judged.accuracy * 100 };
}
function snapshot(dir, sub = "", out = {}) {
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
        const rel = path.join(sub, e.name);
        if (e.isDirectory()) snapshot(dir, rel, out);
        else out[rel] = `${statSync(path.join(dir, rel)).mtimeMs}:${md5(readFileSync(path.join(dir, rel)))}`;
    }
    return out;
}
const before = snapshot(fx.root);
// linked as the IL panel links a folder: its path in userData\interlude.json
mkdirSync(userData, { recursive: true });
writeFileSync(path.join(userData, "interlude.json"), JSON.stringify({ folder: fx.root }));

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
    const interlude = createInterludeClient({
        store: createJsonStore({ file: path.join(userData, "interlude.json"), fallback: { folder: null } }),
        docsDir: path.join(userData, "docs"), mapsDir: path.join(userData, "docs", "maps"), cacheDir: path.join(userData, "interlude-cache"),
        log: (l) => console.log("log", l),
        // stubs: no Interlude is looked for, focused or started
        running: async () => false, pipe: async () => true, launch: () => {}, reveal: () => {},
    });
    const worker = {
        details: async () => ({ kind: "details", details: { v: 2, durationSec: 60, strain: [], families: new Array(120).fill("stream"), flavourBins: [] } }),
        sections: async () => ({ kind: "sections", sections: { v: 1, parts: [{ dan: 9.4 }, { dan: 10.1 }, { dan: null }, { dan: 11.2 }], top: 3 } }),
    };
    const service = createReplayService({
        userData, env: {}, log: (l) => console.log("log", l),
        tosu: async () => ({ game: null, songs: null, skin: null }), association: async () => null, send: (channel, payload) => win?.webContents.send(channel, payload),
        analysis: { enqueue: (fn) => fn() }, worker, cache: { get: async () => null, set: async () => {} }, interlude,
    });
    const channels = {
        "replay-status": "status", "replay-list": "list", "replay-open": "open", "replay-audio": "audio", "replay-skin": "skin", "replay-details": "details",
        "replay-earlier": "earlier", "replay-bias": "bias", "replay-after-play": "setAfterPlay", "replay-pick-folder": "pickFolder", "replay-reset-folder": "resetFolder",
    };
    const asked = { bias: 0 };
    for (const [channel, method] of Object.entries(channels)) {
        ipcMain.handle(channel, (_e, req) => {
            if (channel === "replay-bias") asked.bias += 1;
            return service[method](req);
        });
    }
    // every other channel the preload invokes answers "nothing here", so the other tabs start quietly
    const preload = readFileSync(path.join(appDir, "preload.cjs"), "utf8");
    for (const m of preload.matchAll(/ipcRenderer\.invoke\("([\w-]+)"/g)) if (!channels[m[1]]) ipcMain.handle(m[1], () => ({ ok: false, message: "smoke" }));
    for (const m of preload.matchAll(/ipcRenderer\.send\("([\w-]+)"/g)) if (!["tab"].includes(m[1])) ipcMain.on(m[1], () => {});

    win = new BrowserWindow({ width: 440, height: 860, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    const errors = [];
    win.webContents.on("console-message", (e) => {
        if (e.level === "warning" || e.level === "error") console.log("console", e.level, e.message, `${path.basename(e.sourceId ?? "")}:${e.lineNumber}`);
        if (e.level === "error") errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (what) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(250);
        writeFileSync(path.join(outDir, `${lang}-${what}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 150) {
            if (await js(code)) return true;
            await sleep(150);
        }
        return false;
    };
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const sec = (id) => `document.querySelector("[data-sec=${id}]")`;
    const rowOf = (id) => `[...document.querySelectorAll("#rp-list .rp-row")].find((b) => b.dataset.play === ${JSON.stringify(playId(id))})`;
    const sideways = () => js(`Math.max(document.documentElement.scrollWidth - innerWidth, (() => { const s = document.getElementById("replay-tab"); return s.scrollWidth - s.clientWidth; })())`);
    const scrollTo = (code) => js(`(${code}).scrollIntoView({ block: "start" }); true`);
    // a play opened from its row: main's answer drawn (the status line says "Opening…" until then)
    const openPlay = async (id) => {
        check(await js(`Boolean(${rowOf(id)})`), `the play "${id}" is on the list`);
        await js(`${rowOf(id)}.click(); true`);
        return waitFor(`!document.getElementById("rp-session").hidden && document.getElementById("rp-status").textContent !== ${JSON.stringify(t("replay.opening"))} && document.getElementById("rp-map").textContent.length > 0`);
    };
    const closePlay = () => js(`document.getElementById("rp-close").click(); true`);
    const tiles = () => js(`[...document.querySelectorAll("#rp-stats > *")].map((n) => n.children[1]?.textContent ?? "")`);
    // the judgement table as drawn: [[name, colour, count]]
    const table = () => js(`(() => {
        const t = ${sec("judgements")}?.querySelector("table");
        if (!t) return null;
        const hex = (c) => "#" + (c.match(/\\d+/g) ?? []).slice(0, 3).map((x) => Number(x).toString(16).padStart(2, "0")).join("");
        return [...t.rows].slice(1).map((tr) => [tr.cells[0].children[1]?.textContent ?? tr.cells[0].textContent, hex(getComputedStyle(tr.cells[0].children[0]).backgroundColor), Number(tr.cells[1].textContent)]);
    })()`);
    // words that are an osu! play's alone, or a text not filled in
    const unfilled = (words) => /\{\w+\}|replay\.|undefined|NaN/.test(words);
    const osuOnly = [t("replay.judge.same"), "HitPosition", "ScoreV2"];
    const colourOf = (rgba) => `#${rgba.slice(1).map((x) => x.toString(16).padStart(2, "0")).join("")}`;

    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js("localStorage.clear(); true");
    await win.loadFile(path.join(appDir, "renderer", "index.html"));

    // ---- the list: Interlude's plays only, newest first, marked, accuracy by osu! OD8 ----
    await js(`document.querySelector("[data-tab=replay]").click(); true`);
    check(await waitFor(`document.querySelectorAll("#rp-list .rp-row").length === 6`), "the six plays of Interlude are listed");
    const list = await js(`[...document.querySelectorAll("#rp-list .rp-row")].map((r) => ({ play: r.dataset.play, text: r.innerText, title: r.title }))`);
    console.log("list:", JSON.stringify(list.map((r) => r.text.replace(/\n/g, " | "))));
    check(JSON.stringify(list.map((r) => r.play)) === JSON.stringify(["holds", "mirror", "failed", "shuffle", "older", "oldest"].map(playId)), "newest first");
    check(list.every((r) => r.text.includes(t("replay.list.interlude"))), "each marked as Interlude's");
    check(list[2].text.includes(t("replay.list.failed")), "the failed play is marked again");
    check(list[0].text.includes(engine("holds").percent.toFixed(2)), `the accuracy by osu! OD8, chosen in Interlude (${engine("holds").percent.toFixed(2)})`);
    check(list[1].text.includes("MR") && list[1].text.includes("1.1"), "the mirrored play shows MR and its rate");
    check(list[3].text.includes("SHF") && list[3].text.includes("—"), "Shuffle: its short name, no accuracy");
    check(list.every((r) => !unfilled(r.text + r.title)), "every row reads whole");
    check((await text("rp-list")).includes(t("replay.list.onlyInterlude").slice(0, 20)), "the list says there is no osu! folder, only Interlude's");
    check((await sideways()) <= 0, "no sideways scroll on the list");
    await shot("list");

    // ---- the play with holds, by osu! OD8 ----
    check(await openPlay("holds"), "the play with holds opens");
    await sleep(500);
    const a = engine("holds");
    check((await text("rp-map")) === "Synth - Hold Garden [4K Holds]", "the chart's name");
    const head = await text("rp-who");
    console.log("head:", JSON.stringify(head));
    const selectOptions = () => js(`[...document.querySelectorAll("#rp-who select option")].map((o) => [o.value, o.textContent, o.selected])`);
    const opts = await selectOptions();
    console.log("rulesets:", JSON.stringify(opts));
    check(opts.length === 3 && opts.find((o) => o[0] === "osu-od8")?.[2] === true, "the select offers the three rulesets, osu! OD8 chosen");
    const tileText = await tiles();
    console.log("tiles:", JSON.stringify(tileText), "engine:", a.formattedAccuracy, a.misses, a.maxCombo);
    check(tileText[0] === a.formattedAccuracy && tileText[2] === String(a.misses) && tileText[3] === String(a.maxCombo), "the tiles: Interlude's accuracy, the misses, the best combo");
    check(tileText.every((x) => x && !/NaN|—|undefined/.test(x)), "no tile is empty");
    const shownTable = await table();
    console.log("table:", JSON.stringify(shownTable));
    check(JSON.stringify(shownTable) === JSON.stringify(a.ruleset.judgements.map((j, i) => [j.name, j.color, a.counts[i]])), "the table: the ruleset's names, colours and the engine's counts");
    check(shownTable?.[0]?.[1] === colourOf(RULESETS["osu-od8"].Judgements[0].Color), "with the colours of the .ruleset");
    const report = `${head}\n${await text("rp-stats")}\n${await js(`${sec("judgements")}.innerText`)}`;
    check(!unfilled(report), "the head, the tiles and the table read whole");
    check(!osuOnly.some((w) => report.includes(w)), `no osu!-only words on it (${osuOnly.filter((w) => report.includes(w)).join(", ")})`);
    // every fold, opened: nothing left unfilled, nothing of osu!'s alone
    await js(`document.querySelectorAll("#rp-details details").forEach((d) => { d.open = true; }); true`);
    await sleep(300);
    const folds = await text("rp-details");
    writeFileSync(path.join(outDir, `${lang}-folds.txt`), folds);
    check(!unfilled(folds), `every fold reads whole${unfilled(folds) ? `: ${folds.match(/.{0,40}(\{\w+\}|replay\.|undefined|NaN).{0,40}/)?.[0]}` : ""}`);
    check(!osuOnly.some((w) => folds.includes(w)), `no osu!-only words in the folds (${osuOnly.filter((w) => folds.includes(w)).join(", ")})`);
    check(await waitFor(sec("earlier")), "the earlier plays of the chart are compared");
    check(asked.bias === 0, "no lean asked: HitPosition is osu!'s");
    check((await js(`${sec("earlier")}.innerText`)).includes(t("replay.list.failed")), "an earlier play that failed says so");
    await scrollTo(sec("earlier"));
    await shot("earlier");
    // the top of the report down to the judgement table, in one picture: a taller window
    win.setSize(440, 1500);
    await sleep(300);
    await js(`document.getElementById("replay-tab").scrollTop = 0; ${sec("judgements")}.open = true; true`);
    await shot("open");

    // ---- the same play judged again by Wife3 J4 from the select ----
    await js(`(() => { const s = document.querySelector("#rp-who select"); s.value = "wife3-j4"; s.dispatchEvent(new Event("change")); return true; })()`);
    const w = engine("holds", "wife3-j4");
    check(await waitFor(`[...document.querySelectorAll("#rp-who select option")].find((o) => o.value === "wife3-j4")?.selected && document.getElementById("rp-status").textContent !== ${JSON.stringify(t("replay.opening"))}`), "the select re-opens the play by Wife3 J4");
    await sleep(500);
    const wTiles = await tiles();
    console.log("wife tiles:", JSON.stringify(wTiles), "engine:", w.formattedAccuracy, w.misses, w.maxCombo);
    check(wTiles[0] === w.formattedAccuracy && wTiles[2] === String(w.misses) && wTiles[3] === String(w.maxCombo), "the tiles by Wife3 J4");
    check(wTiles[0] !== tileText[0], "the accuracy changed with the ruleset");
    check(JSON.stringify(await table()) === JSON.stringify(w.ruleset.judgements.map((j, i) => [j.name, j.color, w.counts[i]])), "the table by Wife3 J4");
    check((await js(`${sec("judgements")}.innerText`)).includes("Wife3 J4"), "the table names the ruleset");
    await js(`document.getElementById("replay-tab").scrollTop = 0; true`);
    await shot("ruleset");
    win.setSize(440, 860);
    await sleep(300);

    // ---- the playback mid-play with its panel, among the holds ----
    await scrollTo(`document.getElementById("rp-play")`);
    const mid = chartA[81].t;
    await js(`(() => { const s = document.querySelector(".rp-seek"); s.value = ${mid}; s.dispatchEvent(new Event("input")); return true; })()`);
    await sleep(400);
    const hud = await js(`(() => {
        const c = document.getElementById("rp-stage"); const g = c.getContext("2d");
        const { data } = g.getImageData(0, 0, c.width, c.height); let lit = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 120) lit += 1;
        return { lit, width: c.width, height: c.height };
    })()`);
    check(hud.lit > 500, `the stage is drawn mid-play (${hud.lit} lit px)`);
    check((await text("rp-controls")).includes("0:"), "the clock shows the seek");
    await js(`document.querySelector(".rp-play").click(); true`);
    check(await waitFor(`document.querySelector(".rp-play").textContent === ${JSON.stringify(t("replay.play.pause"))}`, 4000), "the song plays");
    await sleep(900);
    await js(`document.querySelector(".rp-play").click(); true`);
    await sleep(200);
    await shot("playback");
    check((await sideways()) <= 0, "no sideways scroll on an open play");

    // ---- the failed play ----
    await closePlay();
    check(await openPlay("failed"), "the failed play opens");
    await sleep(500);
    const c = engine("failed");
    const failedHead = await text("rp-who");
    check(failedHead.includes(t("replay.head.failed")), "its head says failed");
    const cTiles = await tiles();
    console.log("failed tiles:", JSON.stringify(cTiles), "engine:", c.percent.toFixed(2), c.misses, c.maxCombo);
    check(cTiles[2] === String(c.misses) && cTiles[3] === String(c.maxCombo) && cTiles[0].includes(c.percent.toFixed(2).slice(0, 4)), "the recount as far as it went");
    check((await js(`${sec("judgements")}.innerText`)).includes(t("replay.judge.failed").slice(0, 20)), "the table says it is as far as the play went");
    check(!unfilled(`${failedHead}\n${await text("rp-stats")}`), "the failed play reads whole");
    win.setSize(440, 1500);
    await sleep(300);
    await js(`document.getElementById("replay-tab").scrollTop = 0; true`);
    await shot("failed");
    win.setSize(440, 860);
    await sleep(200);

    // ---- the mirrored play at ×1.1 ----
    await closePlay();
    check(await openPlay("mirror"), "the mirrored play opens");
    await sleep(400);
    const b = engine("mirror");
    check((await text("rp-who")).includes("MR"), "its head names the mirror");
    check((await tiles())[0] === b.formattedAccuracy, `mirrored back, judged like Interlude (${b.formattedAccuracy})`);

    // ---- Shuffle: why it is not analysed ----
    await closePlay();
    check(await openPlay("shuffle"), "the Shuffle play opens");
    check(await waitFor(`!document.getElementById("rp-reason").hidden`), "with a reason");
    const reason = await text("rp-reason");
    console.log("reason:", JSON.stringify(reason));
    check(reason === t("replay.reason.mods", { mods: "SHF" }), "the reason names Interlude's mod");
    check(await js(`document.getElementById("rp-play").hidden && document.getElementById("rp-stats").children.length === 0 && !document.querySelector("#rp-who select")`), "no stage, no tiles, no select");
    await shot("mods");

    check(!errors.length, `no console errors (${errors.slice(0, 2).join(" | ")})`);
    check(!blocked.length, `nothing went online (${blocked.slice(0, 2).join(" ")})`);
    check(JSON.stringify(snapshot(fx.root)) === JSON.stringify(before), "the Interlude folder is unchanged");
    rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log(failed ? "SMOKE FAILED" : "SMOKE PASSED");
    app.exit(failed ? 1 : 0);
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
